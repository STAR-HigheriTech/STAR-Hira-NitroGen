/**
 * url-protocols.mjs —— 「什么样的地址算普通网页」的**唯一判据**（零依赖）。
 *
 * `['http:', 'https:']` 这一对协议此前被六处各写了一遍：
 *   · `site.mjs`（站点信息）、`clean-url.mjs`（复制干净链接）、`web-sidebar.mjs`（独立侧栏）；
 *   · `apps/app-main/src/main/app/urls.js`（命令行直开 URL）；
 *   · `apps/app-main/src/main/pwa/detect.js`（PWA 识别）；
 *   · `domain/domain-pwa/src/rules.ts`（PWA 安装规则）。
 * 每加一个入口就要再抄一遍，任何一处漏改都会出现「这个入口能开、那个入口说不是网页」
 * 的不一致。判据收在这里，其余模块只引它；将来增删协议也只改这一处。
 *
 * 同一份判据还派生出一个共用概念 —— `siteKeyOf`：从 URL 取「站点键」
 * （http(s) 才有站点身份、hostname 小写去 `www.`）。注入规则的 host 归一、
 * 按域名分组标签、换站清 favicon 都是它，此前三处各写一份、口径已经漂了。
 */

/** 允许当作网页浏览 / 打开 / 安装的协议（带冒号，与 `URL#protocol` 同口径）。 */
export const HTTP_PROTOCOLS = Object.freeze(['http:', 'https:'])

/**
 * 协议是否属于「普通网页」。
 * @param {unknown} protocol `URL#protocol`（带冒号，如 `'https:'`）
 * @returns {boolean}
 */
export function isHttpProtocol(protocol: unknown): boolean {
  return protocol === 'http:' || protocol === 'https:'
}

/**
 * 这个值是不是一个 http(s) 地址（非法值 / 非网页协议一律 false）。
 * @param {unknown} value 任意 URL 字符串或 `URL` 实例
 * @param {string} [base] 相对地址的解析基准（PWA manifest 的相对 `start_url` 会用到）
 * @returns {boolean}
 */
export function isHttpUrl(value: unknown, base?: string): boolean {
  try {
    const url = value instanceof URL ? value : new URL(String(value == null ? '' : value), base)
    return isHttpProtocol(url.protocol)
  } catch {
    return false
  }
}

/**
 * 站点键：http(s) 页面才有站点身份，取 hostname、转小写、去掉开头的 `www.`。
 *
 * 不做 eTLD+1（本仓没有公共后缀表，凭空实现会在 `foo.co.uk` 上比整个 hostname 更错）——
 * 同一 hostname 才算同一站，`www.` 视为同一站（最常见的一种）。
 * 非 http(s)（`about:` / `hira://` / `file:` …）与无法解析的一律返回 `''`，
 * 调用方据此判定「没有站点身份」。
 *
 * 容错：传入裸主机（`example.com/path`）时补 `https://` 再解析 —— 用户手填的注入规则
 * 与历史遗留数据里都有这种形状。
 *
 * @param {unknown} url
 * @returns {string} 站点键；无站点身份时为空串
 */
export function siteKeyOf(url: unknown): string {
  let text = String(url == null ? '' : url).trim()
  if (!text) return ''
  if (!/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(text)) text = `https://${text}`
  try {
    const parsed = new URL(text)
    if (!isHttpProtocol(parsed.protocol)) return ''
    const host = String(parsed.hostname || '').toLowerCase()
    if (!host) return ''
    return host.startsWith('www.') ? host.slice(4) : host
  } catch {
    return ''
  }
}
