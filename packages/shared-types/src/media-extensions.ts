/**
 * media-extensions.mjs —— 静态媒体扩展名的**唯一真源**。
 *
 * 为什么要有这个文件：主进程里原先有 **6 份**手抄的扩展名表 ——
 *   · plugin-protocol.js       ALLOWED_EXT / ASSET_EXT / VIDEO_EXT / EXT_MIME
 *   · theme-asset-protocol.js  IMAGE_EXT / VIDEO_EXT / EXT_MIME
 *   · theme-package.js         ASSET_EXT / VIDEO_ASSET_EXT
 * 视频那三条 `.mp4 .webm .ogv` 出现了 4 次，注释还互相写着"与某某同值/同源"。
 * 这类表一漂移，症状极其隐蔽：同一个动态壁纸主题，用户自建的能显示、插件贡献的
 * 加载不出来，而报错只有一句 413（或者干脆是空白背景）。
 *
 * 用法：本文件只给**词表**，不发权限。每个协议按自己的安全边界**组合**自己允许的
 * 类别（例如 `hira-theme://` 刻意不含 `.svg`，`hira-plugin://` 要含）。差异是显式的
 * 一行组合，不再是一份抄来的清单。
 *
 * 纯数据模块：无副作用、无依赖，主进程 CJS `require` 与渲染层 ESM `import` 都能用。
 */

/** 视频容器（Chromium 自带解码，不依赖用户装编码器）。 */
export const VIDEO_EXTENSIONS = Object.freeze(['.mp4', '.webm', '.ogv'])

/**
 * 位图（栅格图）。
 *
 * ⚠ 这里**刻意没有 `.svg`** —— SVG 是**可执行的文档**（能带 `<script>`）。
 * 作为 `<img>` / CSS 背景用时脚本不执行，但把标签页直接导航到该 URL，
 * 它就以"安全源上的文档"身份跑起来了。需要 SVG 的通道自己去加
 * `VECTOR_IMAGE_EXTENSIONS`，并确认那条通道本来就允许文档执行。
 */
export const RASTER_IMAGE_EXTENSIONS = Object.freeze([
  '.png', '.jpg', '.jpeg', '.gif', '.webp', '.avif', '.ico', '.bmp'
])

/** 矢量图（可执行文档，见 `RASTER_IMAGE_EXTENSIONS` 的警告）。 */
export const VECTOR_IMAGE_EXTENSIONS = Object.freeze(['.svg'])

/** 字体。 */
export const FONT_EXTENSIONS = Object.freeze(['.woff', '.woff2', '.ttf', '.otf'])

/**
 * "这个文件是图片"的判定口径（位图 + 矢量）。
 * 拖拽分类、笔记资产、扩展图标等处共用，避免各写一份正则/白名单。
 */
export const IMAGE_FILE_EXTENSIONS = Object.freeze([
  ...RASTER_IMAGE_EXTENSIONS,
  ...VECTOR_IMAGE_EXTENSIONS
])

/** 插件 UI 需要的代码/文本资源（只有 `hira-plugin://` 会发这几类）。 */
export const WEB_TEXT_EXTENSIONS = Object.freeze(['.js', '.mjs', '.cjs', '.css', '.json'])

/**
 * 标记语言（可直接当作面板界面的文档）。
 *
 * ⚠ 与 `.svg` 同级别甚至更强：`.html` 是**完整可执行文档**。放进白名单只代表
 * "这条协议允许把它读出去"，**不代表**允许把它当顶层文档导航 —— 消费方必须
 * 走 `plugin-ui.mjs` 的沙箱模型（`iframe` + `srcdoc` + 无 `allow-same-origin`），
 * 绝不能 `loadURL` 到插件 HTML，否则它会以安全源身份拿到 app 的 preload。
 *
 * `.xaml` 不是浏览器的文档类型，只作为**声明式界面描述**被读取，由宿主用纯模块
 * （`xaml.mjs`）编译成 HTML —— 因此它在这条通道里的安全属性等同于一段 JSON。
 */
export const MARKUP_EXTENSIONS = Object.freeze(['.html', '.htm', '.xaml'])

/**
 * 扩展名 → Content-Type。
 *
 * 是所有已知媒体/文本扩展名的**并集**：每个协议只查自己白名单里的那几条，
 * 多出来的条目不会被用到（白名单是闸门，MIME 只是回包头）。
 */
export const EXT_MIME_TYPES = Object.freeze({
  '.js': 'text/javascript',
  '.mjs': 'text/javascript',
  '.cjs': 'text/javascript',
  '.css': 'text/css',
  '.json': 'application/json',
  // 标记语言：`hira-plugin://` 直发时用；面板 UI 通常先取文本再由宿主编译/注入 CSP。
  '.html': 'text/html',
  '.htm': 'text/html',
  '.xaml': 'application/xml',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.avif': 'image/avif',
  '.ico': 'image/x-icon',
  '.bmp': 'image/bmp',
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
  '.ogv': 'video/ogg',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.otf': 'font/otf'
})
