/**
 * `hira-theme://` 特权协议 —— **用户主题自己的图片资产**（编辑器里"选择图片"拷进来的那些）。
 *
 * ══════════════════════════════════════════════════════════════════════
 * 它补的是哪一块
 * ══════════════════════════════════════════════════════════════════════
 * 插件主题的背景图住在插件目录里、走 `hira-plugin://`。而**用户在编辑器里自建的主题**
 * 从来不是插件，它的背景图原来是"填一个相对路径"——那个路径没有任何协议解析它，
 * 于是图片背景对用户主题实际上是**死的**。
 *
 * 这个协议就是那条缺失的链：把用户主题的图放在一个固定的资产目录里，
 * 给渲染层一个能直接塞进 `style.backgroundImage` 的地址。
 *
 * ══════════════════════════════════════════════════════════════════════
 * 为什么不复用 `hira-plugin://`（加一个保留 host 就行）
 * ══════════════════════════════════════════════════════════════════════
 * 因为**安全边界不同**，而且这个差别正好是最要紧的那一条：
 *   · `hira-plugin://` 要发的是**可执行代码**（`.js` / `.mjs`），白名单里必须留着它们；
 *   · 这里**只发图片**，白名单里一个可执行类型都没有 —— 即使这个目录被写进了一个
 *     `.js`，它也永远读不出去（协议层直接 403）。
 * 把两者混在一个协议里，"主题图片"这条通道就凭空获得了"能下发代码"的能力。
 * 分开之后，将来任何一侧要收紧，改动面都只在自己这个文件里 ——
 * 这与 plugin-protocol.js 文件头里"刻意分成两个协议"的理由是同一条。
 *
 * ══════════════════════════════════════════════════════════════════════
 * 安全边界（逐条都是必须的）
 * ══════════════════════════════════════════════════════════════════════
 *   · **目录穿越**：`../../../../etc/passwd` 必须 403。用 `path.resolve` 之后做前缀
 *     比较，而不是把 `..` 过滤掉（过滤法在 `%2e%2e` / 多重编码 / Windows `..\` 下会漏）。
 *   · **扩展名白名单**：见下，只发**图片与视频**（视频是不可执行的容器，见 VIDEO_EXT）。
 *   · **单文件上限**：按扩展名分档 —— 图片 8MB、视频 64MB（见 `maxBytesFor`）。
 *   · **不缓存**（`no-store`）：文件名里已经带了内容哈希（见 theme-assets.js），
 *     换图就是换名，让浏览器缓存自己猜只会得到"换了图还是旧的"。
 *   · **支持 Range**：动态壁纸是 `<video>` 在按段取流 —— 见 asset-response.js 的说明。
 */

import path from 'node:path'
import fs from 'node:fs/promises'
import { protocol, type Session } from 'electron'
import { RASTER_IMAGE_EXTENSIONS, VIDEO_EXTENSIONS, EXT_MIME_TYPES } from '@hira-ng/shared-types/src/media-extensions.mjs'

interface AssetResponseOptions { mime?: string; maxBytes?: number }

const { fileResponse } = require('./asset-response') as {
  fileResponse(request: Request, filePath: string, options: AssetResponseOptions): Promise<Response>
}
// 扩展名词表真源（与 hira-plugin:// 共用同一份视频清单）。

/** 协议名。改这里即改全局（scheme 注册 + 渲染侧 URL 生成同源）。 */
export const THEME_SCHEME = 'hira-theme'

/**
 * URL 上的 host 段（standard scheme 必须有 host）。
 * 用固定的 `asset` 而不是把资产 key 塞进 host：host 由 Chromium 规范化（小写、
 * 还可能是 punycode），带扩展名与哈希的 key 放进去会被改得认不出来。
 */
export const THEME_HOST = 'asset'

/**
 * 只发**位图** —— 见文件头"为什么不复用 hira-plugin://"。
 *
 * ⚠ 白名单里**刻意没有 `.svg`**：SVG 是**可执行的文档**（能带 `<script>`）。它作为
 * CSS 背景图用时脚本不执行，但用户完全可以把标签页直接导航到
 * `hira-theme://asset/xxx.svg` —— 那就是让"用户挑的一个文件"以**安全源上的文档**身份
 * 跑起来。壁纸用位图就够了，这条能力不值得开。插件协议留 `.svg` 是因为插件 UI 真的要用它，
 * 而这里的用途单一（背景图）。
 */
export const IMAGE_EXT: ReadonlySet<string> = Object.freeze(new Set<string>(RASTER_IMAGE_EXTENSIONS))

/**
 * **视频**白名单（动态壁纸，`background.kind === 'video'`）。
 *
 * 敢放视频进"只发静态资源"的这条通道，是因为它们是**不可执行**的容器：
 * 作为 `<video>` 的媒体源加载时，Chromium 只会喂给解码器，不会执行其中任何字节。
 * 三个格式都是 Chromium 自带解码支持的（不依赖用户装编码器）。
 *
 * ⚠ 仍然**没有 `.svg`、没有 `.html`** —— 那两样是"能被当文档执行"的东西，
 * 与视频不是一回事（理由见上面 IMAGE_EXT 的说明）。
 */
export const VIDEO_EXT: ReadonlySet<string> = Object.freeze(new Set<string>(VIDEO_EXTENSIONS))

const EXT_MIME: Readonly<Record<string, string>> = EXT_MIME_TYPES

/** 图片单文件上限（8MB，与插件资产的图片档一致）。 */
export const MAX_BYTES = 8 * 1024 * 1024

/**
 * 视频单文件上限（64MB）。
 *
 * 为什么视频是图片的 8 倍：一段十几秒的循环视频几十 MB 是常态，卡在 8MB 会让
 * "选一段动态壁纸"基本无法完成；而视频**不可执行**，放宽的只是体积。
 * 见 docs-ng/主题系统设计.md §6.4.4。
 */
export const MAX_VIDEO_BYTES = 64 * 1024 * 1024

/**
 * 某个扩展名的单文件上限（**唯一一处**分档）。
 *
 * 导出给 `theme-assets.js` 的入库闸门与 `ipc/theme.js` 的对话框过滤器用 ——
 * 三处各写一遍"视频能多大"，迟早会出现"选得中、但入库被拒"的不一致。
 */
export function maxBytesFor(ext: unknown): number {
  return VIDEO_EXT.has(String(ext || '').toLowerCase()) ? MAX_VIDEO_BYTES : MAX_BYTES
}

/** 这个扩展名是不是本协议允许发出的（图片与视频）。 */
export function isAllowedExt(ext: unknown): boolean {
  const e = String(ext || '').toLowerCase()
  return IMAGE_EXT.has(e) || VIDEO_EXT.has(e)
}

/**
 * 用户主题图片资产的根目录（`<userData>/theme-assets`）。
 *
 * 与插件目录**刻意分开**：资产要让 `assetUrlFor` 一眼看出"这条主题的图在哪"，
 * 混进插件目录还会让它在插件列表里露头。
 * @param {string} userDataDir
 */
export function themeAssetsDir(userDataDir: unknown): string {
  return path.join(String(userDataDir || ''), 'theme-assets')
}

// 特权注册不在这里 —— 见 `scheme-privileges.js`（全库唯一一次
// `registerSchemesAsPrivileged`；分散调用会互相覆盖）。

/**
 * 构造协议处理器。
 * @param {{ root: string, logger?: { warn?: Function } }} options
 * @returns {(request: Request) => Promise<Response>}
 */
export function createThemeAssetProtocolHandler(options: { root?: string; logger?: { warn?(message: string): void } } = {}): (request: Request) => Promise<Response> {
  const logger = options.logger || console
  const configuredRoot = String(options.root || '').trim()
  if (!configuredRoot) throw new TypeError('createThemeAssetProtocolHandler requires an asset root')
  const root = path.resolve(configuredRoot)

  return async function handleThemeAssetRequest(request: Request): Promise<Response> {
    let url: URL
    try {
      url = new URL(request.url)
    } catch (_) {
      return new Response('Bad request', { status: 400 })
    }

    const host = String(url.hostname || '').toLowerCase()
    let rel = ''
    try {
      rel = decodeURIComponent(String(url.pathname || '').replace(/^\/+/, ''))
    } catch (_) {
      return new Response('Bad request', { status: 400 })
    }
    if (host !== THEME_HOST || !rel) return new Response('Bad request', { status: 400 })

    // ── 目录穿越守卫（realpath 后再比前缀，连符号链接一并锁在资产目录内）──
    let abs = ''
    try {
      const [realRoot, realFile] = await Promise.all([
        fs.realpath(root),
        fs.realpath(path.resolve(root, rel))
      ])
      const rootKey = process.platform === 'win32' ? realRoot.toLowerCase() : realRoot
      const fileKey = process.platform === 'win32' ? realFile.toLowerCase() : realFile
      if (fileKey !== rootKey && !fileKey.startsWith(rootKey + path.sep)) {
        if (logger.warn) logger.warn(`[theme-asset] 拒绝越界访问：${rel}`)
        return new Response('Forbidden', { status: 403 })
      }
      abs = realFile
    } catch (_) {
      if (logger.warn) logger.warn(`[theme-asset] 拒绝越界访问：${rel}`)
      return new Response('Not Found', { status: 404 })
    }

    const ext = path.extname(abs).toLowerCase()
    if (!isAllowedExt(ext)) return new Response('Forbidden', { status: 403 })

    /* 读取、分档限额、Range/206、流式返回 —— 全在 asset-response（两个协议共用一份）。
       本文件只管**能不能发**（目录守卫 + 扩展名白名单），不管"怎么发"。

       缓存策略用默认的 `no-cache` + ETag（asset-response.js）：壁纸动辄几十 MB，
       每次新标签页都整段重读磁盘是不能接受的；而直接 `max-age` 又会让"用户换了壁纸
       但路径没变"继续显示旧图 —— 这里没有版本参数可用，条件请求是唯一正确的解。 */
    return fileResponse(request, abs, {
      mime: EXT_MIME[ext] || 'application/octet-stream',
      maxBytes: maxBytesFor(ext)
    })
  }
}

/**
 * 把处理器挂到某个 session 上。
 * @param {import('electron').Session} [session] 缺省 = 默认 session
 * @param {{ root: string, logger?: object }} options
 */
export function registerThemeAssetProtocol(
  session: Session | undefined,
  options: { root?: string; logger?: { warn?(message: string): void } }
): (request: Request) => Promise<Response> {
  const handler = createThemeAssetProtocolHandler(options)
  const target = session ? session.protocol : protocol
  target.handle(THEME_SCHEME, handler)
  return handler
}

/**
 * 生成渲染侧可加载的 URL。
 *
 * 放在这里（与协议层同一文件）而不是各处自拼：URL 形状是**协议与消费方之间的契约**，
 * 两处各写一份必然漂移（改了 host 规则就表现为"图全裂了"，最难查）。
 *
 * @param {string} key 资产文件名（内容寻址，见 theme-assets.js）
 * @returns {string}
 */
export function buildThemeAssetUrl(key: unknown): string {
  const rel = String(key || '').replace(/^\/+/, '')
  if (!rel) return ''
  return `${THEME_SCHEME}://${THEME_HOST}/${encodeURI(rel)}`
}

