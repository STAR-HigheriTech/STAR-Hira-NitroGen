/**
 * theme-assets.js —— **用户主题的媒体资产库**（编辑器里"选择图片 / 选择视频"的落点）。
 *
 * ══════════════════════════════════════════════════════════════════════
 * 为什么需要一个"库"，而不是把用户选的路径直接存进主题
 * ══════════════════════════════════════════════════════════════════════
 * 两个都行不通的做法：
 *   · 存**原始绝对路径** —— 用户把照片挪个位置/插个 U 盘，主题就裂了；而且渲染层
 *     读不到任意本地路径（`file://` 在 `hira://` 页面里会被 CORS 拒）；
 *   · 存 **base64 data URL** —— 主题定义是写在 `settings.json` 里的，
 *     一张几 MB 的照片会把整个设置文件变成垃圾场（每次改配色都要重写它）。
 *     视频更是完全不可能走这条路。
 *
 * 所以：**拷一份进来**，主题里只留一个**文件名**（= `background.path`），
 * 由 `hira-theme://` 协议把它变成可加载的地址（见 theme-asset-protocol.js）。
 * 图片与**视频**（动态壁纸）走的是同一条链，只有体积额度不同（见 `maxBytesFor`）。
 *
 * ── 文件名为什么是"内容哈希 + 原名" ──────────────────────────────────
 *   · **哈希在前** —— 保证唯一：两个都叫 `wallpaper.jpg` 的不同图片不会互相覆盖
 *     （覆盖的后果是"改好的一条主题，图变成了另一条主题的"）；同内容重复选择会自动复用。
 *   · **原名校在后** —— 保证可读：编辑器里那一行要显示"已选择 beach.jpg"，
 *     而不是一串谁也认不出的哈希。名字会被**消毒**（见 sanitizeBase）：
 *     它会成为磁盘上的文件名，也会进 URL。
 *
 * ── 不做垃圾回收（有意为之） ────────────────────────────────────────
 * 删掉一条主题后，它的图可能还躺在库里。不做自动清理是因为**判据不安全**：
 * 一个刚选好、还没保存的草稿也在引用那张图，按"还有没有主题引用它"去扫会把用户
 * 刚选的图删掉。代价只是磁盘上多几个文件，而"删错"的代价是用户的工作没了 ——
 * 这笔账只有在用户明确要求时才值得翻。
 */

const fsp = require('fs/promises')
const path = require('path')
const crypto = require('crypto')
const {
  buildThemeAssetUrl,
  themeAssetsDir,
  VIDEO_EXT,
  maxBytesFor,
  isAllowedExt
} = require('./theme-asset-protocol')

/** 原名消毒后保留的最大长度（磁盘与 UI 都够用，又不至于撑爆一行）。 */


interface ThemeAssetImportResult { ok: boolean; key?: string; url?: string; bytes?: number; mediaKind?: 'image' | 'video'; reason?: string }
interface ThemeAssetStoreOptions { userDataDir: string; logger?: { warn?: (...args: unknown[]) => void; info?: (...args: unknown[]) => void } }
const MAX_BASE_LEN = 40

/**
 * 把原始文件名消毒成一个能安全落盘、也能进 URL 的片段。
 *
 * 只保留 ASCII 字母数字、`_`、`-` 与中日韩汉字；其余（含 `.`、空格、引号、路径分隔符）
 * 一律换成 `_`。**连 `.` 也换掉**是有意的：`..` / `...` 这类名字一旦原样落盘，
 * 就得靠"再来一次路径判断"去兜，而这里直接让它不可能出现。
 * 消毒后为空（纯符号名）→ 回落 `image`。
 *
 * @param {string} raw 原始文件名（可含扩展名）
 * @returns {string}
 */
function sanitizeBase(raw: unknown): string {
  const base = path.basename(String(raw || ''), path.extname(String(raw || '')))
  const safe = base
    .replace(/[^A-Za-z0-9_\-\u4e00-\u9fff]/g, '_')
    .replace(/_+/g, '_')
    .replace(/^[_-]+|[_-]+$/g, '')
    .slice(0, MAX_BASE_LEN)
  return safe || 'image'
}

/**
 * @param {{ userDataDir: string, logger?: { warn?: Function } }} options
 * @returns {{
 *   root: string,
 *   importFile: (srcPath: string) => Promise<{ ok: boolean, key?: string, url?: string, bytes?: number, mediaKind?: 'image'|'video', reason?: string }>,
 *   urlFor: (key: string) => string,
 *   read: (key: string) => Promise<Buffer|null>
 * }}
 */
function createThemeAssetStore(options: ThemeAssetStoreOptions) : {
  root: string,
  importFile: (srcPath: string) => Promise<{ ok: boolean, key?: string, url?: string, bytes?: number, mediaKind?: 'image'|'video', reason?: string }>,
  urlFor: (key: string) => string,
  read: (key: string) => Promise<Buffer|null>
} {
  const logger = options.logger || console
  const root = themeAssetsDir(options.userDataDir)

  /** 目录只 `mkdir` 一次（幂等，但没必要每次选图都问一次文件系统）。 */
  let rootReady: Promise<unknown> | null = null
  function ensureRoot(): Promise<unknown> {
    if (rootReady) return rootReady
    const pending = fsp.mkdir(root, { recursive: true }).catch(() => {})
    rootReady = pending
    return pending
  }

  /**
   * 把选中的文件拷进资产库。
   *
   * **两道闸门在读取之前**：扩展名白名单与体积上限 —— 拒绝要在把文件读进内存**之前**
   * 发生，否则"拒绝一张 2GB 的图"本身就把进程撑爆了。
   *
   * @param {string} srcPath 原生对话框给回来的绝对路径
   * @returns {Promise<{ ok: boolean, key?: string, url?: string, bytes?: number, reason?: string }>}
   */
  async function importFile(srcPath: string): Promise<ThemeAssetImportResult> {
    const src = String(srcPath || '')
    if (!src) return { ok: false, reason: '没有选择文件' }
    const ext = path.extname(src).toLowerCase()
    // 白名单**只有一份**（协议层决定"哪些发得出去"）—— 两处各写一份的话，
    // 漏一个扩展名的表现就是"选得中、却永远加载不出来"。
    if (!isAllowedExt(ext)) {
      return { ok: false, reason: `不支持的文件格式：${ext || '（无扩展名）'}（只支持图片与视频）` }
    }
    const isVideo = VIDEO_EXT.has(ext)
    const limit = maxBytesFor(ext)

    let st
    try {
      st = await fsp.stat(src)
    } catch (error) {
      return { ok: false, reason: `读不到这个文件：${error instanceof Error ? error.message : error}` }
    }
    if (!st.isFile()) return { ok: false, reason: '选中的不是一个文件' }
    if (st.size > limit) {
      const what = isVideo ? '视频' : '图片'
      return { ok: false, reason: `${what}太大（${Math.round(st.size / 1024 / 1024)}MB，上限 ${limit / 1024 / 1024}MB）` }
    }

    let buf
    try {
      buf = await fsp.readFile(src)
    } catch (error) {
      return { ok: false, reason: `读取失败：${error instanceof Error ? error.message : error}` }
    }
    if (!buf || !buf.length) return { ok: false, reason: '这个文件是空的' }

    const hash = crypto.createHash('sha1').update(buf).digest('hex').slice(0, 8)
    const key = `${hash}-${sanitizeBase(src)}${ext}`

    await ensureRoot()
    try {
      // `wx` = 存在就失败：同内容重复选择时**复用**已有文件，不覆盖（也不重复写盘）。
      await fsp.writeFile(path.join(root, key), buf, { flag: 'wx' })
    } catch (error) {
      const code = error && typeof error === 'object' && 'code' in error ? String((error as { code?: unknown }).code || '') : ''
      if (code !== 'EEXIST') {
        return { ok: false, reason: `写入资产库失败：${error instanceof Error ? error.message : error}` }
      }
    }
    logger.info?.(`[theme-asset] 已入库 ${key}（${Math.round(buf.length / 1024)}KB）`)
    /**
     * `mediaKind` —— **由真实的扩展名判定**（而不是听调用方说"我要选视频"）。
     *
     * 对话框的过滤器只是提示，用户可以切成"所有文件"选到任何东西；所以
     * `background.kind` 必须按**实际选中的那个文件**来写。让调用方自己填的话，
     * 会出现 `kind:'video'` 却指向一张 jpg 的主题（表现为背景一片空白，极难查）。
     */
    return { ok: true, key, url: buildThemeAssetUrl(key), bytes: buf.length, mediaKind: isVideo ? 'video' : 'image' }
  }

  /** 资产 key → 可加载 URL（唯一出口，形状由协议层决定）。 */
  function urlFor(key: string): string {
    return buildThemeAssetUrl(key)
  }

  /**
   * 读出一个资产的字节（导出主题包时把图一起带走）。
   * 与协议层**同一条目录守卫**：`background.path` 是可以被手改的输入，不能直接当路径用。
   * @returns {Promise<Buffer|null>}
   */
  async function read(key: string): Promise<Buffer | null> {
    const rel = String(key || '').replace(/^\/+/, '')
    if (!rel) return null
    const abs = path.resolve(root, rel)
    if (abs !== root && !abs.startsWith(root + path.sep)) return null
    try {
      const st = await fsp.stat(abs)
      // ⚠ 上限**必须与 importFile 用同一个来源**（`maxBytesFor`）。
      //   这里原先写的是一个并不存在的 `MAX_BYTES` —— 每次调用都抛 ReferenceError，
      //   又被下面的 catch 吞成 `return null`，于是"导出主题包时图片永远读不出来"
      //   且毫无报错（本仓第三次栽在同一个模式上：未定义引用 + 静默 catch）。
      if (!st.isFile() || st.size > maxBytesFor(path.extname(rel).toLowerCase())) return null
      return await fsp.readFile(abs)
    } catch (_) {
      return null
    }
  }

  return { root, importFile, urlFor, read }
}

module.exports = { createThemeAssetStore, sanitizeBase }
