/**
 * 集锦**图片资产**基础设施（主进程）—— "字节进得来、出得去"的那一半。
 *
 * ══════════════════════════════════════════════════════════════════
 * 为什么单独一个模块（而不是塞进 ipc/notes.js）
 * ══════════════════════════════════════════════════════════════════
 * 这一层碰的是 Electron 独有的东西（net / nativeImage / shell / session）与磁盘，
 * 而 ipc/notes.js 只是"路由 → 服务"的薄壳（与 download-manager / capture-page 同一种分工）。
 * 落盘、缩略图、大图纪律、LRU 全在这一处 —— ipc 层不认识"什么叫大图"。
 *
 * ══════════════════════════════════════════════════════════════════
 * 三条设计决策（都是"为什么这么做"）
 * ══════════════════════════════════════════════════════════════════
 * 1) **落盘路径 = 相对 userData**。域层字段 `assetPath` / `thumbPath` 的语义就是
 *    "相对 userData 的路径"（见 domain-notes 的 Note typedef）。绝对路径会随
 *    userData 目录迁移而失效，也会把"这台机器上的用户名"泄进数据里。
 *
 * 2) **缩略图走 dataURL，不自造协议、不用 file://**。渲染层是**独立 WebContentsView**，
 *    要让它 `<img src=...>` 直接读磁盘，得 `protocol.registerFileProtocol` 造一个特权协议，
 *    再处理沙箱 / `webSecurity` / 路径守卫那一整套（theme-asset-protocol.js 就是那条路的重型版）。
 *    而缩略图只有几 KB —— 转成 dataURL 是最省事、且**不引入任何新面**的一条。
 *    为了避免"同一张图每次进入视野都重新读盘 + base64"，加一层内存 LRU（见 THUMB_CACHE_LIMIT）。
 *
 * 3) **大图纪律**（见 shared-types#NOTES_ASSET_MAX_BYTES）：超过 4MB **不落原图**，
 *    只留缩略图；超过 16MB 连缩略图都不生成（判失败）。集锦是"收集"，不是图床。
 */

import fs from 'node:fs'
import path from 'node:path'
import { app, net, nativeImage, shell, type Session, type WebContents } from 'electron'
import { generateId } from '@hira-ng/shared-utils'
// 「算不算普通网页」的唯一判据（资产抓图只收 http(s) 源）。
import { isHttpUrl } from '@hira-ng/shared-types/src/url-protocols.mjs'
import { assertSafeOutboundUrl } from '@hira-ng/infra-net-guard'
// 页面截图能力**复用**既有那一份（见 capture-page.js）—— 不另写一套"抓可视区"的代码。
// `grabPageImage(wc, 'viewport')` 内部走 Electron 的 `webContents.capturePage()`（抓已合成的那一帧），
// 最稳、永远可用；整页截图（CDP）成本高得多，缩略图用不着。
const { grabPageImage } = require('./capture-page') as {
  grabPageImage(webContents: WebContents | null | undefined, mode?: 'viewport' | 'fullpage'): Promise<Buffer | null>
}
import {
  NOTES_ASSETS_DIR,
  NOTES_ASSET_THUMBS_DIR,
  NOTES_ASSET_MAX_BYTES,
  NOTES_ASSET_HARD_MAX_BYTES,
  NOTES_ASSET_THUMB_WIDTH,
  // 网页缩略图宽度与图片卡不同（见 shared-types 的说明）——两种图各用各的口径。
  NOTES_PAGE_THUMB_WIDTH
} from '@hira-ng/shared-types/src/notes.mjs'

// 图片扩展名 / MIME 的唯一真源（见 shared-types/media-extensions.mjs）。
import {
  IMAGE_FILE_EXTENSIONS,
  EXT_MIME_TYPES
} from '@hira-ng/shared-types/src/media-extensions.mjs'

/** 扩展名（**不带点**，notes 资产以此落盘）→ MIME。 */
const MIME_BY_EXT: Record<string, string> = Object.fromEntries(
  IMAGE_FILE_EXTENSIONS.map((ext) => [ext.slice(1), EXT_MIME_TYPES[ext as keyof typeof EXT_MIME_TYPES]])
)
/**
 * content-type / 扩展名 → 落盘扩展名（认不出的统一落 .png，浏览器对它的容错最好）。
 * 先按真源反查，再补站点实际会发出来的两个别名（`image/jpg` / vendor 图标类型）。
 */
const EXT_BY_MIME: Record<string, string> = {
  ...Object.fromEntries(Object.entries(MIME_BY_EXT).map(([ext, mime]) => [mime, ext])),
  // 反查时 jpeg 会盖掉 jpg —— 落盘统一用更短的 jpg。
  'image/jpeg': 'jpg',
  'image/jpg': 'jpg',
  'image/vnd.microsoft.icon': 'ico'
}

/** 缩略图 LRU 上限。200 条 × 几 KB ≈ 1MB 级，够覆盖整屏卡片且不会无限涨。 */
const THUMB_CACHE_LIMIT = 200
const MAX_THUMB_FILE_BYTES = 4 * 1024 * 1024
const NOTES_IMAGE_FETCH_TIMEOUT_MS = 15_000
const NOTES_IMAGE_MAX_REDIRECTS = 3

export interface NotesAssetsDependencies {
  profileDirOf(profileId: string): string
  getProfileId?(): string | null | undefined
  getSession?(): Session | null | undefined
}

export interface NotesAssetSaveResult {
  ok: boolean
  reason?: string
  oversize?: boolean
  assetPath?: string | null
  thumbPath?: string
  assetMime?: string
  assetWidth?: number
  assetHeight?: number
}

interface NotesDownloadResult extends NotesAssetSaveResult {
  buffer?: Buffer
  mime?: string
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

export function createNotesAssets({ profileDirOf, getProfileId, getSession }: NotesAssetsDependencies) {
  if (typeof profileDirOf !== 'function') {
    throw new Error('createNotesAssets: profileDirOf 端口必填')
  }

  const currentProfile = (): string => {
    try { return String((getProfileId && getProfileId()) || 'default') } catch (_) { return 'default' }
  }
  /** 资产根目录（绝对）：`<profileDir>/notes-assets/`。 */
  const assetsDir = (): string => path.join(profileDirOf(currentProfile()), NOTES_ASSETS_DIR)
  /** 缩略图目录（绝对）。 */
  const thumbsDir = (): string => path.join(assetsDir(), NOTES_ASSET_THUMBS_DIR)

  /**
   * 绝对路径 → 相对 userData 的路径（正斜杠）。
   * 存进库里的 `assetPath` / `thumbPath` 用这个形式（见文件头决策 1）。
   */
  function toUserDataRel(abs: string): string {
    const userData = app.getPath('userData')
    return path.relative(userData, abs).split(path.sep).join('/')
  }

  /**
   * 相对 userData 的路径 → 绝对路径，并做**越界守卫**：
   * 只允许落到 userData 之下（库里的路径万一被改脏，也不至于让 `shell.openPath`
   * 去打开一个任意系统文件）。越界返回 null。
   */
  function fromUserDataRel(rel: unknown): string | null {
    const r = String(rel == null ? '' : rel).trim()
    if (!r) return null
    const userData = app.getPath('userData')
    const abs = path.resolve(userData, r)
    const back = path.relative(userData, abs)
    if (!back || back.startsWith('..') || path.isAbsolute(back)) return null
    return abs
  }

  function fromAssetsRel(rel: unknown): string | null {
    const abs = fromUserDataRel(rel)
    if (!abs) return null
    const root = path.resolve(assetsDir())
    const back = path.relative(root, abs)
    if (!back || back.startsWith('..') || path.isAbsolute(back)) return null
    return abs
  }

  function extFromMime(mime: unknown): string {
    const m = String(mime || '').split(';')[0].trim().toLowerCase()
    return EXT_BY_MIME[m] || 'png'
  }
  function mimeFromExt(ext: unknown): string {
    return MIME_BY_EXT[String(ext || '').replace(/^\./, '').toLowerCase()] || 'image/png'
  }

  // ── 缩略图 LRU（读盘 + base64 都贵，缓存这次结果）─────────────────────
  /** @type {Map<string, string|null>} abs → dataUrl | null（Map 插入序即"最近使用"序） */
  const thumbCache: Map<string, string|null> = new Map<string, string | null>()
  function lruGet(key: string): string | null | undefined {
    if (!thumbCache.has(key)) return undefined
    const v = thumbCache.get(key)
    if (v === undefined) return undefined
    thumbCache.delete(key)
    thumbCache.set(key, v)
    return v
  }
  function lruSet(key: string, value: string | null): void {
    if (thumbCache.has(key)) thumbCache.delete(key)
    thumbCache.set(key, value)
    if (thumbCache.size > THUMB_CACHE_LIMIT) {
      const oldest = thumbCache.keys().next().value
      if (oldest) thumbCache.delete(oldest)
    }
  }

  /**
   * 把一段**已解好码**的图字节落盘：缩略图必落，原图按大图纪律决定落不落。
   *
   * @param {Buffer} buffer 图字节（png / jpg / …）
   * @param {string} mime content-type（可缺省，按扩展名兜底）
   * @returns {{ ok:boolean, reason?:string, oversize?:boolean,
   *             assetPath?:string|null, thumbPath?:string, assetMime?:string,
   *             assetWidth?:number, assetHeight?:number }}
   */
  async function saveBuffer(buffer: Buffer, mime: unknown): Promise<NotesAssetSaveResult> {
    if (!buffer || !buffer.length) return { ok: false, reason: 'empty' }
    // hard cap：连缩略图都不做（解码一张超大图会把主进程内存打满，见 shared-types 常量注释）
    if (buffer.length > NOTES_ASSET_HARD_MAX_BYTES) return { ok: false, reason: 'too-large' }

    const image = nativeImage.createFromBuffer(buffer)
    if (!image || (typeof image.isEmpty === 'function' && image.isEmpty())) {
      return { ok: false, reason: 'unsupported-format' }
    }
    const size = image.getSize()
    const oversize = buffer.length > NOTES_ASSET_MAX_BYTES
    const id = generateId('asset')
    const ext = extFromMime(mime)

    try {
      const thumbAbs = path.join(thumbsDir(), `${id}.png`)
      // 等比缩到目标宽度；原图本来就窄就保持原尺寸（放大没有意义，只会糊）。
      const thumbImage = size.width > NOTES_ASSET_THUMB_WIDTH
        ? image.resize({ width: NOTES_ASSET_THUMB_WIDTH })
        : image
      const thumbBytes = thumbImage.toPNG()

      // 大图纪律：oversize 时**不落原图**，只留缩略图（assetPath 回 null）。
      let assetAbs: string | null = null
      if (!oversize) {
        assetAbs = path.join(assetsDir(), `${id}.${ext}`)
      }
      await fs.promises.mkdir(thumbsDir(), { recursive: true })
      await Promise.all([
        fs.promises.writeFile(thumbAbs, thumbBytes),
        ...(assetAbs ? [fs.promises.writeFile(assetAbs, buffer)] : [])
      ])

      return {
        ok: true,
        oversize,
        assetPath: assetAbs ? toUserDataRel(assetAbs) : null,
        thumbPath: toUserDataRel(thumbAbs),
        assetMime: String(mime || '').split(';')[0].trim() || mimeFromExt(ext),
        assetWidth: size.width || 0,
        assetHeight: size.height || 0
      }
    } catch (e) {
      return { ok: false, reason: `write-failed: ${errorMessage(e)}` }
    }
  }

  /**
   * 用当前 Session 下载一张图（带 cookie 与 referer）。
   *
   * 为什么用 `session` 选项 + `useSessionCookies`：目标图常是**登录态**才能取到的
   * （图床 / 私有 CDN）。不带上当前标签的 cookie 就会抓到一张 403 占位图。
   *
   * @returns {Promise<{ ok:boolean, reason?:string, buffer?:Buffer, mime?:string }>}
   */
  async function downloadImage(
    url: string,
    referer: unknown,
    redirectCount = 0
  ): Promise<NotesDownloadResult> {
    if (redirectCount > NOTES_IMAGE_MAX_REDIRECTS) return { ok: false, reason: 'too-many-redirects' }
    const verdict = await assertSafeOutboundUrl(url)
    if (!verdict.ok) return { ok: false, reason: `blocked-url: ${verdict.reason}` }
    const safeUrl = verdict.url
    return new Promise((resolve) => {
      let session = null
      try { session = getSession ? getSession() : null } catch (_) { session = null }

      let req
      try {
        req = net.request({
          method: 'GET',
          url: safeUrl,
          redirect: 'manual',
          ...(session ? { session, useSessionCookies: true } : {}),
          headers: {
            // 不少图床按 referer 做防盗链：带上来源页才取得到。
            ...(referer ? { Referer: String(referer) } : {}),
            // 明确要图（有些站点按 Accept 返回 webp / svg）。
            Accept: 'image/*,*/*;q=0.8'
          }
        })
      } catch (e) {
        resolve({ ok: false, reason: `request-failed: ${errorMessage(e)}` })
        return
      }

      const chunks: Buffer[] = []
      let total = 0
      let mime = ''
      let settled = false
      const timer = setTimeout(() => {
        try { req.abort() } catch (_) {}
        finish({ ok: false, reason: 'timeout' })
      }, NOTES_IMAGE_FETCH_TIMEOUT_MS)
      if (typeof timer.unref === 'function') timer.unref()
      const finish = (r: NotesDownloadResult): void => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        resolve(r)
      }

      req.on('response', (res) => {
        const status = Number(res.statusCode) || 0
        if (status >= 300 && status < 400) {
          const rawLocation = res.headers.location
          const location = String(Array.isArray(rawLocation) ? rawLocation[0] : (rawLocation || '')).trim()
          try { (res as unknown as { resume(): void }).resume() } catch (_) {}
          if (!location) {
            finish({ ok: false, reason: 'redirect-without-location' })
            return
          }
          let nextUrl = ''
          try { nextUrl = new URL(location, safeUrl).toString() } catch (_) {}
          if (!nextUrl) {
            finish({ ok: false, reason: 'invalid-redirect' })
            return
          }
          void downloadImage(nextUrl, referer, redirectCount + 1).then(finish, (error) => {
            finish({ ok: false, reason: `redirect-failed: ${errorMessage(error)}` })
          })
          return
        }
        if (status < 200 || status >= 300) {
          try { (res as unknown as { resume(): void }).resume() } catch (_) {}
          finish({ ok: false, reason: `http-${status}` })
          return
        }
        const rawType = res.headers && res.headers['content-type']
        mime = String(Array.isArray(rawType) ? rawType[0] : (rawType || '')).split(';')[0].trim().toLowerCase()
        // content-type 不以 image/ 开头 → 直接失败（不落一个 HTML 错误页当资产）。
        if (!/^image\//.test(mime)) {
          try { (res as unknown as { resume(): void }).resume() } catch (_) {}
          finish({ ok: false, reason: 'not-image' })
          return
        }
        res.on('data', (chunk: Buffer) => {
          total += chunk.length
          // 超硬上限：停读并判失败（见 NOTES_ASSET_HARD_MAX_BYTES）。
          if (total > NOTES_ASSET_HARD_MAX_BYTES) {
            try { req.abort() } catch (_) {}
            finish({ ok: false, reason: 'too-large' })
            return
          }
          chunks.push(chunk)
        })
        res.on('end', () => finish({ ok: true, buffer: Buffer.concat(chunks), mime }))
        res.on('error', (e: Error) => finish({ ok: false, reason: `stream-failed: ${errorMessage(e)}` }))
      })
      req.on('error', (e: Error) => finish({ ok: false, reason: `request-failed: ${errorMessage(e)}` }))
      req.end()
    })
  }

  /**
   * 按 URL 抓图并落盘（右键「添加此图到集锦」/ 拖放图片型 URL 走这条）。
   * @param {{ url?: string, referer?: string }} input
   */
  async function fetchToAsset({ url, referer }: { url?: unknown; referer?: unknown } = {}): Promise<NotesAssetSaveResult> {
    const u = String(url || '').trim()
    if (!isHttpUrl(u)) return { ok: false, reason: 'unsupported-url' }
    const res = await downloadImage(u, referer)
    if (!res.ok) return res
    if (!res.buffer) return { ok: false, reason: 'empty-response' }
    return saveBuffer(res.buffer, res.mime)
  }

  /**
   * 存一段 dataURL 图字节（粘贴 / 拖放拿到的内嵌图走这条）。
   * 为什么走 dataURL 而不是另开"传字节"通道：渲染层与主进程之间能过的就是结构化克隆
   * 支持的类型，dataURL 是"一张图"最稳的表达（Buffer 过不了 IPC）。
   * @param {{ dataUrl?: string }} input
   */
  async function saveBufferFromDataUrl({ dataUrl }: { dataUrl?: unknown } = {}): Promise<NotesAssetSaveResult> {
    const raw = String(dataUrl || '')
    if (raw.length > Math.ceil(NOTES_ASSET_HARD_MAX_BYTES * 4 / 3) + 4096) {
      return { ok: false, reason: 'too-large' }
    }
    const m = /^data:([^;,]+)?(;base64)?,(.*)$/s.exec(raw)
    if (!m) return { ok: false, reason: 'bad-data-url' }
    const mime = String(m[1] || 'image/png')
    let buffer
    try {
      buffer = m[2]
        ? Buffer.from(m[3], 'base64')
        // 非 base64 的 dataURL 里是百分号编码文本（本场景极少见），兜底也解一下。
        : Buffer.from(decodeURIComponent(m[3]), 'binary')
    } catch (_) {
      return { ok: false, reason: 'bad-data-url' }
    }
    if (!/^image\//i.test(mime)) return { ok: false, reason: 'not-image' }
    return saveBuffer(buffer, mime)
  }

  /**
   * 读缩略图文件 → dataURL（面板 `<img>` 直接用）。
   * 读不到 / 越界 / 非图片扩展一律回 `{ dataUrl: null }`（不抛）—— 面板据此回落类型图标占位。
   * @param {string} relPath 库里的 `thumbPath`（相对 userData）或 `assetPath`（缩略图缺失时的兜底）
   */
  async function readThumb(relPath: unknown): Promise<{ dataUrl: string | null }> {
    const abs = fromAssetsRel(relPath)
    if (!abs) return { dataUrl: null }
    const cached = lruGet(abs)
    if (cached !== undefined) return { dataUrl: cached }
    let dataUrl = null
    try {
      const stat = await fs.promises.stat(abs)
      if (!stat.isFile() || stat.size <= 0 || stat.size > MAX_THUMB_FILE_BYTES) return { dataUrl: null }
      const buf = await fs.promises.readFile(abs)
      dataUrl = `data:${mimeFromExt(path.extname(abs))};base64,${buf.toString('base64')}`
    } catch (_) {
      dataUrl = null
    }
    lruSet(abs, dataUrl)
    return { dataUrl }
  }

  /**
   * 用系统默认程序打开原图（编辑器「打开原图」）。
   * @param {string} relPath 库里的 `assetPath`（相对 userData）
   */
  async function openAsset(relPath: unknown): Promise<{ ok: boolean; error?: string }> {
    const abs = fromAssetsRel(relPath)
    if (!abs) return { ok: false, error: 'invalid-path' }
    try {
      const err = await shell.openPath(abs)
      return err ? { ok: false, error: String(err) } : { ok: true }
    } catch (e) {
      return { ok: false, error: errorMessage(e) || 'open-failed' }
    }
  }

  /**
   * 把一张**页面截图**字节落成缩略图（只落缩略图，**不落原图**）。
   *
   * 为什么与 `saveBuffer` 分开：网页卡只要一张"列表里认得出是哪一页"的小图，
   * 落原图（整页 PNG 动辄几百 KB~几 MB）对集锦毫无价值，还白白吃磁盘。
   * 所以这里刻意不复用 saveBuffer 的"原图 + 缩略图"两条腿，只走缩略图那条。
   * @param {Buffer} buffer 页面截图 PNG 字节
   * @returns {{ ok:boolean, reason?:string, thumbPath?:string, assetWidth?:number, assetHeight?:number }}
   */
  async function savePageThumb(buffer: Buffer): Promise<NotesAssetSaveResult> {
    if (!buffer || !buffer.length) return { ok: false, reason: 'empty' }
    if (buffer.length > NOTES_ASSET_HARD_MAX_BYTES) return { ok: false, reason: 'too-large' }
    const image = nativeImage.createFromBuffer(buffer)
    if (!image || (typeof image.isEmpty === 'function' && image.isEmpty())) {
      return { ok: false, reason: 'unsupported-format' }
    }
    const size = image.getSize()
    const id = generateId('asset')
    try {
      const thumbAbs = path.join(thumbsDir(), `${id}.png`)
      // 等比缩到目标宽度；本来就窄（小窗）就保持原尺寸 —— 放大只会糊。
      const thumbImage = size.width > NOTES_PAGE_THUMB_WIDTH
        ? image.resize({ width: NOTES_PAGE_THUMB_WIDTH })
        : image
      const thumbBytes = thumbImage.toPNG()
      await fs.promises.mkdir(thumbsDir(), { recursive: true })
      await fs.promises.writeFile(thumbAbs, thumbBytes)
      return {
        ok: true,
        thumbPath: toUserDataRel(thumbAbs),
        assetWidth: size.width || 0,
        assetHeight: size.height || 0
      }
    } catch (e) {
      return { ok: false, reason: `write-failed: ${errorMessage(e)}` }
    }
  }

  /**
   * 抓某个页面 webContents 的**可视区**并落成缩略图 —— 网页卡收录时异步补图的那一步。
   *
   * 复用 `capture-page#grabPageImage(wc, 'viewport')`（见本文件顶部的 require 说明），
   * 因此整页 CDP 截图那套重活不会在这里再写一遍；抓不到（页面已销毁 / 内部页 / 受限）
   * 一律回 `{ ok:false }`，由调用方决定"卡片退化成无预览区"，**绝不抛错、绝不弹窗**。
   * @param {any} webContents
   * @returns {Promise<{ ok:boolean, reason?:string, thumbPath?:string, assetWidth?:number, assetHeight?:number }>}
   */
  async function capturePageThumb(webContents: WebContents | null | undefined): Promise<NotesAssetSaveResult> {
    let buffer = null
    try {
      buffer = await grabPageImage(webContents, 'viewport')
    } catch (_) {
      buffer = null
    }
    if (!buffer) return { ok: false, reason: 'no-image' }
    return savePageThumb(buffer)
  }

  return { fetchToAsset, saveBufferFromDataUrl, readThumb, openAsset, savePageThumb, capturePageThumb }
}
