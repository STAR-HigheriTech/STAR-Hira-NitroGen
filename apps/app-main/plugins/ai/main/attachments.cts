/**
 * AI 引擎 · 截图 / 图片附件（PART15 §9.1 screenshot、§14「大负载不进 IPC」）。
 *
 * ══════════════════════════════════════════════════════════════════════
 * 为什么截图必须落盘（而不是一路 dataURL）
 * ══════════════════════════════════════════════════════════════════════
 * 一张 1440×900 的 PNG 转 base64 约 1~3MB。它会经过三段：
 *   capturePage → IPC 回渲染层 → 用户点发送 → IPC 回主进程 → 提示词。
 * 同一张图来回两趟，每次都要结构化克隆一份字符串 —— 面板会明显卡顿。
 *
 * 所以口径是：
 *   · **原图落盘**（相对 userData 的路径），库里/意图里只带 `path + 元信息`；
 *   · **缩略图 dataURL** 给 chip 预览（几十 KB，一屏几十个也无感）；
 *   · 真正发送前才在主进程读盘 → dataURL 交给视觉模型（见 `readAsDataUrl`）。
 *
 * 与集锦（notes-assets）同一套纪律，但**不共用目录也不共用模块**：
 * AI 附件会随 `ai:purge` 一起删、随会话删除一起清 —— 它属于 AI 的生命周期。
 */

const fs = require('fs')
const path = require('path')
const { nativeImage } = require('electron')

/** userData 下的附件根目录。 */
const ATTACH_DIR = 'ai-attachments'
/** 缩略图目标宽度（chip 预览够用；越大越吃 IPC）。 */
const THUMB_WIDTH = 480
/** 单张图硬上限：超过直接拒绝（解码超大图会把主进程内存打满）。 */
const HARD_MAX_BYTES = 16 * 1024 * 1024
/** dataURL 字符上限必须在解码前检查，避免恶意 base64 先分配一大块 Buffer。 */
const MAX_BASE64_CHARS = Math.ceil(HARD_MAX_BYTES / 3) * 4 + 1024
const MAX_PERCENT_CHARS = HARD_MAX_BYTES * 3 + 1024
const MAX_DATA_URL_CHARS = Math.max(MAX_BASE64_CHARS, MAX_PERCENT_CHARS)
/** 读盘 dataURL 的 LRU（读盘 + base64 都贵，重复发送同一张图时直接命中）。 */
const CACHE_LIMIT = 40

function dataUrlToBuffer(dataUrl: string): { buffer: Buffer; mime: string } | null {
  const raw = typeof dataUrl === 'string' ? dataUrl : ''
  if (!raw || raw.length > MAX_DATA_URL_CHARS) return null
  const m = /^data:([^;,]+)?(;base64)?,([\s\S]*)$/.exec(raw)
  if (!m) return null
  const encoded = m[3]
  if (m[2] ? encoded.length > MAX_BASE64_CHARS : encoded.length > MAX_PERCENT_CHARS) return null
  const mime = String(m[1] || 'image/png').trim().toLowerCase()
  try {
    const buffer = m[2]
      ? Buffer.from(encoded, 'base64')
      : Buffer.from(decodeURIComponent(encoded), 'binary')
    if (!/^image\//.test(mime)) return null
    return { buffer, mime }
  } catch (_) {
    return null
  }
}

function extOf(mime: string): string {
  const m = String(mime || '').toLowerCase()
  if (m.includes('jpeg') || m.includes('jpg')) return 'jpg'
  if (m.includes('webp')) return 'webp'
  if (m.includes('gif')) return 'gif'
  return 'png'
}

/**
 * @param {{ userDataPath: string }} deps
 */
function createAttachments({ userDataPath }: { userDataPath: string }) {
  const userData = String(userDataPath || '')
  const root = () => path.join(userData, ATTACH_DIR)
  const sessionDir = (sessionId: string) => path.join(root(), String(sessionId || 'misc').replace(/[^\w.-]/g, '_'))

  /** 绝对路径 → 相对 userData（正斜杠）。库里只存这个形式。 */
  function toRel(abs: string): string {
    return path.relative(userData, abs).split(path.sep).join('/')
  }

  /** 相对路径 → 绝对路径，并做越界守卫（库里的路径被改脏也不会读到 userData 之外）。 */
  function toAbs(rel: string): string | null {
    const r = String(rel || '').trim()
    if (!r) return null
    const abs = path.resolve(userData, r)
    const back = path.relative(userData, abs)
    if (!back || back.startsWith('..') || path.isAbsolute(back)) return null
    return abs
  }

  // ── dataURL 缓存（键 = 绝对路径 + mtime，文件被覆盖也不会读到旧内容） ──
  const cache = new Map<string, string | null>()
  function cacheGet(key: string): string | null | undefined {
    if (!cache.has(key)) return undefined
    const v = cache.get(key)
    if (v === undefined) return undefined
    cache.delete(key)
    cache.set(key, v)
    return v
  }
  function cacheSet(key: string, value: string | null): void {
    if (cache.has(key)) cache.delete(key)
    cache.set(key, value)
    if (cache.size > CACHE_LIMIT) {
      const oldest = cache.keys().next().value
      if (oldest !== undefined) cache.delete(oldest)
    }
  }

  /**
   * 落一张图（原图 + 缩略图 dataURL）。
   *
   * @param {string} sessionId
   * @param {string} dataUrl
   * @returns {{ ok: boolean, reason?: string, path?: string, mime?: string,
   *   width?: number, height?: number, bytes?: number, thumb?: string|null }}
   */
  function saveDataUrl(sessionId: string, dataUrl: string) : { ok: boolean, reason?: string, path?: string, mime?: string,
  width?: number, height?: number, bytes?: number, thumb?: string|null } {
    if (typeof dataUrl !== 'string' || dataUrl.length > MAX_DATA_URL_CHARS) return { ok: false, reason: 'too-large' }
    const parsed = dataUrlToBuffer(dataUrl)
    if (!parsed) return { ok: false, reason: 'bad-data-url' }
    const { buffer, mime } = parsed
    if (!buffer.length) return { ok: false, reason: 'empty' }
    if (buffer.length > HARD_MAX_BYTES) return { ok: false, reason: 'too-large' }

    const image = nativeImage.createFromBuffer(buffer)
    if (!image || (typeof image.isEmpty === 'function' && image.isEmpty())) {
      return { ok: false, reason: 'unsupported-format' }
    }
    const size = image.getSize()
    const id = `shot_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`

    try {
      const dir = sessionDir(sessionId)
      fs.mkdirSync(dir, { recursive: true })
      const abs = path.join(dir, `${id}.${extOf(mime)}`)
      fs.writeFileSync(abs, buffer)

      let thumb = null
      try {
        const thumbImage = size.width > THUMB_WIDTH ? image.resize({ width: THUMB_WIDTH }) : image
        thumb = `data:image/png;base64,${thumbImage.toPNG().toString('base64')}`
      } catch (_) { thumb = null }

      return {
        ok: true,
        path: toRel(abs),
        mime,
        width: size.width || 0,
        height: size.height || 0,
        bytes: buffer.length,
        thumb
      }
    } catch (e) {
      return { ok: false, reason: `write-failed: ${e instanceof Error ? e.message : String(e)}` }
    }
  }

  /** 读成 dataURL（发送给视觉模型）。读不到 / 越界一律 null，不抛。 */
  function readAsDataUrl(rel: string) {
    const abs = toAbs(rel)
    if (!abs) return null
    let key = abs
    try { key = `${abs}:${fs.statSync(abs).mtimeMs}` } catch (_) { return null }
    const hit = cacheGet(key)
    if (hit !== undefined) return hit

    let dataUrl = null
    try {
      const buf = fs.readFileSync(abs)
      const ext = path.extname(abs).replace(/^\./, '').toLowerCase()
      const mime = ext === 'jpg' || ext === 'jpeg' ? 'image/jpeg' : ext === 'webp' ? 'image/webp' : ext === 'gif' ? 'image/gif' : 'image/png'
      dataUrl = `data:${mime};base64,${buf.toString('base64')}`
    } catch (_) { dataUrl = null }
    cacheSet(key, dataUrl)
    return dataUrl
  }

  /** 读一张小缩略图（重开会话后 chip 预览用）。 */
  function readThumb(rel: string) {
    const abs = toAbs(rel)
    if (!abs) return null
    try {
      const image = nativeImage.createFromBuffer(fs.readFileSync(abs))
      if (!image || (typeof image.isEmpty === 'function' && image.isEmpty())) return null
      const size = image.getSize()
      const small = size.width > THUMB_WIDTH ? image.resize({ width: THUMB_WIDTH }) : image
      return `data:image/png;base64,${small.toPNG().toString('base64')}`
    } catch (_) { return null }
  }

  /** 读一个本地文件的文本（`file` 上下文项；只收文本类扩展名）。 */
  function readTextFile(absPath: unknown, maxChars = 40000) {
    const raw = String(absPath || '')
    if (!raw) return null
    const TEXT_EXT = new Set(['.txt', '.md', '.markdown', '.json', '.csv', '.log', '.html', '.htm', '.xml', '.yaml', '.yml', '.ini', '.toml', '.js', '.mjs', '.cjs', '.ts', '.tsx', '.jsx', '.css', '.py', '.go', '.rs', '.java', '.c', '.h', '.cpp', '.sh', '.sql'])
    const ext = path.extname(raw).toLowerCase()
    if (!TEXT_EXT.has(ext)) return null
    try {
      const stat = fs.statSync(raw)
      if (!stat.isFile() || stat.size > HARD_MAX_BYTES) return null
      const text = fs.readFileSync(raw, 'utf8')
      return text.length > maxChars ? `${text.slice(0, maxChars)}\n…（文件过长，已截断）` : text
    } catch (_) {
      return null
    }
  }

  function removeSession(sessionId: string) {
    try { fs.rmSync(sessionDir(sessionId), { recursive: true, force: true }) } catch (_) {}
  }

  function removeAll() {
    cache.clear()
    try { fs.rmSync(root(), { recursive: true, force: true }) } catch (_) {}
  }

  return { saveDataUrl, readAsDataUrl, readThumb, readTextFile, removeSession, removeAll }
}

module.exports = { createAttachments, ATTACH_DIR, HARD_MAX_BYTES }
