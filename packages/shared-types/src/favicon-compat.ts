/**
 * favicon-compat.mjs —— `chrome://favicon` / `chrome://favicon2` 兼容层的**唯一真源**
 *
 * ── 旧 Hira 的做法与 NG 为什么不能照抄 ──────────────────────────────
 * 旧 Hira 在 `extensionInit.js#registerChromeFaviconCompat` 里用
 * `session.webRequest.onBeforeRequest({ urls: ['chrome://favicon/*', ...] })`
 * 把请求 302 到自己的 favicon 代理端点。NG **不能用**这条路：
 *   1. 同一 Session 的同一 webRequest 事件只保留一个监听器，广告拦截器已经占用
 *      `onBeforeRequest`（见 shared-types/https-only.mjs 文件头的完整论证）；
 *   2. `@iamevan/electron-chrome-extensions` 声明「只要用了 Electron webRequest，
 *      扩展的 chrome.webRequest 监听器就全部失效」。
 *
 * ── 替代落点 ──────────────────────────────────────────────────────
 *   · 改写发生在**扩展页面的 DOM 层**（`preload/extension-preload.js`，与 identity
 *     桥合并为同一份会话级 preload，只在确有已启用扩展时注册）：
 *     把 `img[src]` 里的 chrome://favicon 地址换成 `hira://favicon/?chrome=<原地址>`；
 *   · 解析（取出真正要取图标的页面 URL）发生在**主进程协议端点**
 *     （`main/hira-protocol.js#serveFavicon`），复用既有 favicon 字节代理
 *     （缓存 / 超时 / SSRF 白名单 / ACAO 全部不动）。
 *
 * 为什么解析规则必须单独成模块：`chrome://favicon` 的几种历史写法（favicon /
 * favicon2、path 形式 / `pageUrl` / `page_url` / `url` 查询形式、是否二次编码）
 * 一旦散落到 preload 与协议层两处，必然各自漂移。这里只做**纯字符串 → 页面 URL**，
 * 零依赖零 IO，preload 侧只认前缀、不复制解析规则。
 *
 * 能力边界（如实记录，不假装做到）：
 *   · 只覆盖 `<img>` 的 `src`；CSS `background-image: url(chrome://favicon/…)`
 *     无法在 DOM 层安全改写（样式表可能来自扩展自身的 CSS 文件）；
 *   · 需要经过一次 DOM 观察 → 属性改写，首帧可能先失败一次再成功（视觉上等价，
 *     不会留下错误占位）。
 */

// 「算不算普通网页」的唯一判据（解析出的目标必须可作 favicon 源）。
import { isHttpUrl } from './url-protocols.js'

/** Chrome 提供 favicon 的两个 host（favicon2 是带 size / scale 参数的新版）。 */
const CHROME_FAVICON_HOSTS = Object.freeze(['favicon', 'favicon2'])

/** preload 改写后的代理端点查询键（与 hira-protocol 的 serveFavicon 约定）。 */
const CHROME_FAVICON_QUERY_KEY = 'chrome'

/**
 * 是否为 `chrome://favicon…` 地址（大小写不敏感，Chrome 自身是小写）。
 * @param {unknown} rawUrl
 * @returns {boolean}
 */
function isChromeFaviconUrl(rawUrl: unknown) : boolean {
  return /^chrome:\/\/(?:favicon|favicon2)(?:[/?#]|$)/i.test(String(rawUrl == null ? '' : rawUrl))
}

/**
 * 从 `chrome://favicon…` 地址里取出**要取图标的页面 URL**。
 *
 * 支持的写法（与 Chrome / 旧 Hira 的兼容面一致）：
 *   · `chrome://favicon/https://example.com/a`            —— path 形式
 *   · `chrome://favicon2/http://example.com`              —— path 形式（favicon2）
 *   · `chrome://favicon/?pageUrl=https%3A%2F%2F…`         —— 查询形式
 *   · `chrome://favicon2/?size=16&scale_factor=2&page_url=…` —— favicon2 查询形式
 *   · `chrome://favicon/?url=…`                           —— 旧 Hira 兼容键
 * 查询值可能被二次编码（扩展先 encode 一次，Chrome 再 encode 一次），因此最多解码两层。
 *
 * 只接受 http/https：代理端点本身也只允许这两个协议，在这里提前收敛，
 * 免得把 `file://` / `data:` 之类的地址送进网络层。
 *
 * @param {unknown} rawUrl
 * @returns {string} 页面 URL；无法解析 / 不是 http(s) 时返回空串
 */
function chromeFaviconPageUrl(rawUrl: unknown) : string {
  const raw = String(rawUrl == null ? '' : rawUrl)
  if (!isChromeFaviconUrl(raw)) return ''
  let parsed
  try {
    parsed = new URL(raw)
  } catch (_) {
    return ''
  }
  const host = parsed.hostname.toLowerCase()
  if (!CHROME_FAVICON_HOSTS.includes(host)) return ''

  // 查询形式优先：Chrome 的 favicon2 用 `page_url`，favicon 用 `pageUrl`。
  let target = parsed.searchParams.get('pageUrl') ||
    parsed.searchParams.get('page_url') ||
    parsed.searchParams.get('url') ||
    ''

  // path 形式：`chrome://favicon/https://example.com`。
  if (!target) {
    const rawPath = String(parsed.pathname || '').replace(/^\/+/, '')
    const match = rawPath.match(/(https?:\/\/.+)$/i)
    if (match) target = match[1]
  }
  if (!target) return ''

  // 最多解码两层：一次是 URLSearchParams 已解过的，一次是扩展自己多 encode 的一层。
  for (let i = 0; i < 2; i++) {
    try {
      const next = decodeURIComponent(target)
      if (next === target) break
      target = next
    } catch (_) {
      break
    }
  }
  if (!isHttpUrl(target)) return ''
  try {
    // 规范化（去空白 / 统一编码），同时借 URL 再校验一次可解析性。
    return new URL(target).toString()
  } catch (_) {
    return ''
  }
}

export {
  CHROME_FAVICON_HOSTS,
  CHROME_FAVICON_QUERY_KEY,
  isChromeFaviconUrl,
  chromeFaviconPageUrl
}
