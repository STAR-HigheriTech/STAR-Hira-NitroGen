/**
 * 站点图标来源解析（**唯一真源**，纯函数、无 DOM / 无 Node 依赖）
 *
 * ── 为什么要有这份文件 ────────────────────────────────────────────────
 * 「一个页面地址该显示哪张图标」这条规则曾经散落在三处、各不相同：
 *   · 内部页（hira://bookmarks / history）自己拼 `google.com/s2/favicons?domain=…`
 *     —— 那是**第三方面板服务**：国内网络根本连不上，而且它明明可以从数据行里
 *     直接拿到 favicon URL（书签/历史表里就存着），却绕出去问 Google。
 *     更糟的是那个请求在国内是「挂住」而不是「失败」：<img> 既不 load 也不 error，
 *     于是连首字母降级都不会触发 —— 用户看到的就是**永远空着的图标位**。
 *   · 面板 / 书签栏 / rail 各自 `img.src = item.favicon`（直连站点原始图标）。
 *   · favicon 取色（ui-common#faviconColor）走 `hira://favicon/?url=…` 主进程代理。
 *
 * 现在统一成一条规则，三处共用：
 *
 *   1. 数据里带 favicon（http/https）→ 走**主进程字节代理**取回
 *      （同源 + 主进程 LRU + 失败即 404，见 apps/app-main/src/main/hira-protocol.js#serveFavicon）
 *   2. 没带 → 用站点众所周知的 **`<origin>/favicon.ico`**（每个浏览器都这么兜底）
 *   3. 两者都拿不到 → `null`，调用方画首字母徽标（绝不出现破图 / 空白）
 *
 * 为什么首选代理而不是直连原始 URL：直连只是「把问题推给渲染进程」——
 * 第三方资源的失败形态不可控（挂住 / 混合内容 / 被 CSP 拦），而代理把
 * 「取字节」收敛到主进程一处：去重、限流、限大小、失败确定性（404）。
 * 但**代理不是唯一出路**：候选里同时给出 `raw`（原始 URL），调用方在代理
 * 失败时可以直连再试一次 —— 「统一规则」不该以「少一条活路」为代价，
 * 所以返回的是候选对而不是单个字符串（见 faviconSourceCandidates）。
 */

import { isHttpProtocol } from './url-protocols.js'

/**
 * 主进程字节代理 URL（同源化）。
 * 与 ui-common#faviconProxyUrl / main#serveFavicon 是同一协议的三个面。
 * @param {string} url
 * @returns {string}
 */
export function faviconProxyUrl (url: string) : string {
  return 'hira://favicon/?url=' + encodeURIComponent(String(url))
}

/**
 * 解析为 http/https URL；其它协议（data: / file: / chrome-extension: / hira: …）一律 null。
 * @param {unknown} value
 * @returns {URL|null}
 */
function asHttpUrl (value: unknown) : URL|null {
  if (!value) return null
  try {
    const u = new URL(String(value))
    return isHttpProtocol(u.protocol) ? u : null
  } catch (_) {
    return null
  }
}

/**
 * 站点众所周知的图标地址（`<origin>/favicon.ico`）。
 * 只对 http/https 页面地址成立 —— `about:blank` / `hira://…` 这类没有原点。
 * @param {string} [pageUrl]
 * @returns {string|null}
 */
export function wellKnownFaviconUrl (pageUrl: string) : string|null {
  const u = asHttpUrl(pageUrl)
  return u ? u.origin + '/favicon.ico' : null
}

/**
 * 解析「页面地址 + 数据行里存着的 favicon」→ `<img>` 可用的候选来源。
 *
 * @param {string} [pageUrl]          页面地址（用于众所周知的兜底推导）
 * @param {string|null} [storedFavicon] 数据行带回来的 favicon URL（书签 / 历史 / 标签都有）
 * @returns {{primary: string|null, raw: string|null}}
 *   primary —— 首选 src（http 资源已换成主进程代理 URL）
 *   raw     —— 直连兜底 src；与 primary 不同才有意义（null = 无可兜底）
 */
export function faviconSourceCandidates (pageUrl: string|null|undefined, storedFavicon: string|null|undefined) : {primary: string|null, raw: string|null} {
  const stored = storedFavicon == null ? '' : String(storedFavicon).trim()

  if (stored) {
    // 站点声明的原始图标：能走代理就走代理，代理失败时直连再试
    if (asHttpUrl(stored)) return { primary: faviconProxyUrl(stored), raw: stored }
    // 非 http 的图标（data: / chrome-extension: / file: …）原样用，代理只认 http(s)
    return { primary: stored, raw: null }
  }

  const wellKnown = wellKnownFaviconUrl(pageUrl == null ? '' : String(pageUrl))
  if (!wellKnown) return { primary: null, raw: null }
  return { primary: faviconProxyUrl(wellKnown), raw: wellKnown }
}

/**
 * **带降级链**的图标加载：primary → raw → 失败。
 * 三段式（代理 / 直连 / 放弃）在内部页与面板各写一遍必然漂移，故收敛在这里 ——
 * 调用方只需要提供「成功」与「失败」两个回调，不必知道候选有几段。
 *
 * 另外挂一条**看门狗**：请求在国内被墙 / 网络黑洞时 <img> 既不来 load 也不来
 * error（这正是 Google 那条老路径的表现），没有超时就永远是空白图标位。
 * 超时后按失败处理 —— 首字母徽标至少是"看得见的信息"。
 *
 * @param {Document} doc
 * @param {{primary: string|null, raw: string|null}} candidates
 * @param {{
 *   onFail: () => void,
 *   timeoutMs?: number,
 *   size?: number,
 *   className?: string,
 *   borderRadius?: number|string
 * }} opts
 * @returns {HTMLImageElement}  已挂好降级链的 <img>（无需再自行监听 error）
 */
export interface FaviconImageOptions {
  onFail: () => void
  timeoutMs?: number
  size?: number
  className?: string
  borderRadius?: number | string
}

export function createFaviconImg(
  doc: Document,
  candidates: { primary: string | null; raw: string | null },
  opts: FaviconImageOptions
): HTMLImageElement {
  const onFail = opts.onFail
  const timeoutMs = opts.timeoutMs == null ? 6000 : opts.timeoutMs
  const size = opts.size == null ? 16 : opts.size

  const img = doc.createElement('img')
  // 类名默认**不加**：面板/内部页各有自己的骨架类，凭空加一个只会在某些宿主里
  // 意外命中 CSS（这类"改了另一处外观"最难查）。要类名就由调用方显式给。
  if (opts.className) img.className = opts.className
  img.alt = ''
  // 图标解码不应阻塞列表首帧 / 滚动帧；尺寸仍由显式 width/height 固定。
  img.decoding = 'async'
  img.draggable = false
  img.style.width = size + 'px'
  img.style.height = size + 'px'
  img.style.objectFit = 'cover'
  img.style.flexShrink = '0'
  if (opts.borderRadius != null) img.style.borderRadius = String(opts.borderRadius) + (typeof opts.borderRadius === 'number' ? 'px' : '')

  let settled = false
  let timer: ReturnType<typeof setTimeout> | null = null

  const finishFail = () => {
    if (settled) return
    settled = true
    if (timer) clearTimeout(timer)
    onFail()
  }
  const finishOk = () => {
    if (settled) return
    settled = true
    if (timer) clearTimeout(timer)
  }

  if (candidates.raw && candidates.raw !== candidates.primary) {
    // 代理挂了 → 直连原始图标再试一次（第二段）
    img.onerror = () => {
      if (settled) return
      img.onerror = () => finishFail()
      img.src = String(candidates.raw)
    }
  } else {
    img.onerror = finishFail
  }
  img.onload = finishOk

  if (timeoutMs > 0) {
    timer = setTimeout(() => {
      // 已经拿到的图不撤（naturalWidth>0 说明它其实成功了，只是 onload 被吞）
      if (img.naturalWidth > 0) return finishOk()
      finishFail()
    }, timeoutMs)
  }

  if (candidates.primary) img.src = candidates.primary
  return img
}
