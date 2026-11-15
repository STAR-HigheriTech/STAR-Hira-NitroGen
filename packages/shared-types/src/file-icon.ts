/**
 * 下载项图标（**唯一真源**）
 *
 * ── 学的是老 Hira ────────────────────────────────────────────────────
 * 老 Hira 的下载项图标只有一个来源：**问操作系统要真实文件图标**
 * （`main/remoteActions.js#getFileIconDataURL` → `app.getFileIcon`），
 * 再按下载项缓存起来（见 `js/downloadManager.js#ensureDownloadBarFileIcon`）。
 * NG 的下载**栏**照做了（`download:get-file-icon`），但下载**页**与下载**面板**
 * 各自退化成"按扩展名猜一个 emoji"，而且猜的那张表还是**两份复制**
 * （runtime.js#fileIcon 与 ui-common#fileIconFor）—— 两份必然漂移。
 *
 * 于是这里收敛成一条规则、一份表、一套降级链：
 *
 *   ① 有落盘路径 → 向宿主要真实文件图标（dataUrl）→ `<img>`
 *   ② 拿不到（文件已删 / 还没落盘 / 宿主没给这条路）→ 按扩展名归类到类型 emoji
 *   ③ 扩展名也不认识 → 通用下载箭头
 *
 * ②③ 保证行首**永远不会是空的**：下载中（尚无文件）也有个类型图标，
 * 不会出现"一行只有一个文件名、左边什么都没有"。
 *
 * 本文件不 require 任何宿主 API：DOM 由调用方以 `doc` 注入、取图由调用方以
 * `loadIcon` 端口注入（内部页喂 `rpc`、面板喂 `bridge.invoke`）——
 * ui 层因此对 IPC 保持零知识（CONTRACT-11），这也是它能同时被
 * 「打包的渲染层」与「不打包的 hira:// 内部页」引用的前提。
 */

/**
 * 扩展名 → 图标字符的分类表（**唯一真源**：页面 / 面板 / 下载栏共用）。
 *
 * 顺序即优先级；归类只按扩展名，不看 MIME（下载项的 MIME 常年是
 * application/octet-stream，信不过）。分不清的一律归「文档/代码」，
 * 再分不清才落到通用箭头。
 * @type {ReadonlyArray<[string, string[]]>}
 */
const FILE_TYPE_GROUPS: ReadonlyArray<[string, string[]]> = Object.freeze([
  // 🖼 图片
  ['\u{1F5BC}', ['png', 'jpg', 'jpeg', 'jpe', 'jfif', 'gif', 'webp', 'svg', 'ico', 'bmp', 'avif', 'tif', 'tiff', 'heic', 'heif', 'psd', 'xcf', 'raw', 'cr2', 'nef']],
  // 🎬 视频
  ['\u{1F3AC}', ['mp4', 'm4v', 'mkv', 'webm', 'mov', 'avi', 'flv', 'wmv', 'mpg', 'mpeg', 'm2ts', '3gp', 'ogv']],
  // 🎵 音频
  ['\u{1F3B5}', ['mp3', 'wav', 'flac', 'ogg', 'oga', 'm4a', 'aac', 'opus', 'wma', 'mid', 'midi', 'aiff', 'ape']],
  // 📦 压缩包
  ['\u{1F4E6}', ['zip', 'rar', '7z', 'tar', 'gz', 'tgz', 'bz2', 'xz', 'zst', 'lz', 'lzma', 'cab', 'arj']],
  // ⚙ 可执行 / 安装包 / 镜像（老 Hira 的下载里这类最多，以前全落到通用箭头）
  ['\u{2699}', ['exe', 'msi', 'msix', 'appx', 'dmg', 'pkg', 'deb', 'rpm', 'apk', 'appimage', 'run', 'bin', 'iso', 'img', 'vhd', 'jar', 'swf']],
  // 🔤 字体
  ['\u{1F524}', ['ttf', 'otf', 'ttc', 'woff', 'woff2', 'eot']],
  // 🧲 种子 / 清单
  ['\u{1F9F2}', ['torrent', 'magnet', 'nfo']],
  // 🗃 文档 / 代码 / 数据
  ['\u{1F5C3}', [
    'pdf', 'doc', 'docx', 'dot', 'odt', 'rtf', 'xls', 'xlsx', 'xlsm', 'ods', 'csv', 'tsv', 'ppt', 'pptx', 'odp',
    'txt', 'md', 'markdown', 'rst', 'log', 'json', 'json5', 'ndjson', 'xml', 'yaml', 'yml', 'toml', 'ini', 'cfg', 'conf', 'env',
    'js', 'mjs', 'cjs', 'jsx', 'ts', 'tsx', 'css', 'scss', 'sass', 'less', 'html', 'htm', 'vue', 'svelte', 'astro',
    'py', 'rb', 'php', 'java', 'kt', 'kts', 'go', 'rs', 'c', 'h', 'cc', 'cpp', 'hpp', 'cs', 'swift', 'm', 'mm',
    'sh', 'bash', 'zsh', 'fish', 'bat', 'cmd', 'ps1', 'psm1', 'vbs', 'sql', 'db', 'sqlite', 'sqlite3', 'ttl', 'ipynb'
  ]]
])

/** 通用下载图标（扩展名缺失或不在表内） */
const GENERIC_ICON = '\u{2B07}'

/**
 * 取文件名 / URL 的扩展名（小写，不含点）。
 * @param {string} [name]
 * @returns {string}
 */
export function fileExtension (name: string) : string {
  const src = String(name || '')
  // 取路径最后一段再取扩展名：URL 的 query/hash 里也常有"点"，先切掉
  const last = src.split(/[?#]/)[0].split(/[\\/]/).pop() || ''
  const dot = last.lastIndexOf('.')
  return dot > 0 ? last.slice(dot + 1).toLowerCase() : ''
}

/**
 * 按扩展名归类到文件类型图标字符。
 * @param {string} [filename]
 * @returns {string}
 */
export function fileTypeIcon (filename: string): string {
  const ext = fileExtension(filename)
  if (!ext) return GENERIC_ICON
  for (const group of FILE_TYPE_GROUPS) {
    if ((group[1] as readonly string[]).includes(ext)) return String(group[0])
  }
  return GENERIC_ICON
}

/**
 * 真实文件图标的缓存键。空字符串 = 不可缓存（调用方自行短路）。
 * @param {{filePath?: string|null, filename?: string|null, url?: string|null}} [item]
 * @returns {string}
 */
export function fileIconCacheKey (item: { filePath?: string|null, filename?: string|null, url?: string|null }) : string {
  if (!item) return ''
  const p = item.filePath == null ? '' : String(item.filePath)
  // 有落盘路径：路径本身即键（同一个路径的图标不会变）
  if (p) return 'p:' + p
  // 没落盘：按扩展名共用一个键 —— 下载中/失败的行也不该每行各问一次宿主
  return 'e:' + fileExtension(item.filename || item.url || '')
}

/**
 * 真实文件图标的**取数器**（带缓存与并发合并）。
 *
 * 为什么要合并并发：内部页每 2s 重画一次列表，没有合并就会 2s 一次、每行一发
 * IPC，几十行 = 几十发/轮 —— 纯浪费。缓存 + inflight 让"同一张图标只问一次"。
 * 失败结果同样缓存（空串），否则已删文件的下载项会每轮重试。
 *
 * @param {(filePath: string, size: number) => Promise<string|null>} load
 *   宿主提供的取图函数：内部页 = `rpc('download:get-file-icon')`，面板 = `bridge.invoke`
 * @param {{ max?: number, failTtlMs?: number }} [opts]
 *   `failTtlMs`：取不到（文件还没落盘 / 已被删除）的缓存有效期。
 *   下载中的行目标文件常常**尚未存在**，如果失败结果永久缓存，
 *   下载完成那一刻再画图标就会命中那条空缓存 —— 正是「下完了却没图标」。
 * @returns {(filePath: string, size?: number) => Promise<string|null>}
 */
export function createFileIconLoader (load: (filePath: string, size: number) => Promise<string|null>, opts: { max?: number, failTtlMs?: number } = {}) : (filePath: string, size?: number) => Promise<string|null> {
  const max = opts.max == null ? 200 : opts.max
  const failTtlMs = opts.failTtlMs == null ? 5000 : opts.failTtlMs
  /** @type {Map<string, {url: string, at: number}>} 键 → 结果（'' = 取不到，按 failTtlMs 过期） */
  const cache: Map<string, {url: string, at: number}> = new Map<string, { url: string; at: number }>()
  /** @type {Map<string, Promise<string|null>>} */
  const inflight: Map<string, Promise<string|null>> = new Map<string, Promise<string | null>>()

  return function loadFileIcon (filePath: string | null | undefined, size = 16): Promise<string | null> {
    const path = filePath == null ? '' : String(filePath)
    if (!path || typeof load !== 'function') return Promise.resolve(null)

    const key = size + '|' + path
    const hit = cache.get(key)
    if (hit) {
      if (hit.url) return Promise.resolve(hit.url)
      // 失败结果只在短窗口内复用：文件稍后落盘/重新出现时要能再问一次
      if (Date.now() - hit.at < failTtlMs) return Promise.resolve(null)
      cache.delete(key)
    }

    let task = inflight.get(key)
    if (!task) {
      task = Promise.resolve()
        .then(() => load(path, size))
        .then((dataUrl) => {
          const url = typeof dataUrl === 'string' ? dataUrl : ''
          if (cache.size >= max) cache.clear()
          cache.set(key, { url, at: Date.now() })
          return url || null
        })
        .catch(() => {
          if (cache.size >= max) cache.clear()
          cache.set(key, { url: '', at: Date.now() })
          return null
        })
      inflight.set(key, task)
      task.then(() => inflight.delete(key), () => inflight.delete(key))
    }
    return task
  }
}

/**
 * 下载项行首图标：先给类型 emoji（立刻可见，绝不留空），
 * 宿主能给出真实图标时再**原位换成** `<img>`。
 *
 * 已经不在了 / 已经被换掉的元素不会再被写（`isConnected` + 标记），
 * 这样节点被回收重建时的迟到结果不会往旧节点上画。
 *
 * @param {Document} doc
 * @param {{filename?: string|null, url?: string|null, filePath?: string|null}} item
 * @param {{
 *   size?: number,
 *   className?: string,
 *   imgClassName?: string,
 *   fontSize?: number,
 *   loadIcon?: (filePath: string, size: number) => Promise<string|null>
 * }} [opts]
 * @returns {HTMLSpanElement}  行首图标容器（默认 .file-icon）
 */
export interface FileIconOptions {
  size?: number
  className?: string
  imgClassName?: string
  fontSize?: number
  loadIcon?: (filePath: string, size: number) => Promise<string | null>
}

export function createFileIcon(
  doc: Document,
  item: { filename?: string | null; url?: string | null; filePath?: string | null },
  opts: FileIconOptions = {}
): HTMLSpanElement {
  const size = opts.size == null ? 16 : opts.size
  const span = doc.createElement('span')
  // 类名由调用方给：内部页用骨架层的 .file-icon，面板沿用它自己的既有 DOM
  // （不乱加类名，免得面板 CSS 里多出一条只影响图标格的规则 —— C02 像素口径）
  if (opts.className !== '') span.className = opts.className || 'file-icon'
  span.style.width = size + 'px'
  span.style.height = size + 'px'
  span.style.flexShrink = '0'
  span.style.display = 'inline-flex'
  span.style.alignItems = 'center'
  span.style.justifyContent = 'center'
  if (opts.fontSize) span.style.fontSize = Math.round(opts.fontSize) + 'px'
  span.style.userSelect = 'none'
  span.textContent = fileTypeIcon((item && (item.filename || item.url)) || '')

  const filePath = item && item.filePath
  const loadIcon = opts.loadIcon
  if (!filePath || typeof loadIcon !== 'function') return span

  loadIcon(String(filePath), size).then((dataUrl) => {
    if (!dataUrl || !span.isConnected || span.dataset.iconSwapped === '1') return
    span.dataset.iconSwapped = '1'
    const img = doc.createElement('img')
    img.className = opts.imgClassName || 'file-icon__img'
    img.alt = ''
    img.decoding = 'async'
    img.style.width = size + 'px'
    img.style.height = size + 'px'
    img.style.objectFit = 'contain'
    img.src = dataUrl
    span.replaceChildren(img)
  }).catch(() => {})

  return span
}
