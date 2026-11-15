/**
 * https-only.mjs —— 「仅 HTTPS」的**唯一真源**（判据 + 升级换算）
 *
 * ── 为什么不用 `session.webRequest.onBeforeRequest` ─────────────────
 * 那是第一直觉，但**在这套代码里会同时踩两个坑**：
 *   1. Electron 对同一 Session 的同一事件**只保留一个监听器** —— 广告拦截器
 *      （`@ghostery/adblocker-electron`）已经占用了 `onBeforeRequest`，
 *      我们再挂一个会把它顶掉（用户看到的是"开了 HTTPS-only，广告拦截失效了"）；
 *   2. `@iamevan/electron-chrome-extensions` 明确声明：**只要用了 Electron 的
 *      webRequest API，扩展的 `chrome.webRequest` 监听器就全部不再被调用**。
 * 故本功能走**导航层**（`will-navigate` / `will-redirect`）：只升级主框架的导航，
 * 完全不碰 webRequest。代价是**不升级子资源**（页面里写死的 `http://` 图片/脚本照旧），
 * 这一点在设置项的说明里如实写明 —— 不假装做到了 Chrome 那种全量升级。
 *
 * ── 为什么要放行本地/私网 ─────────────────────────────────────────
 * `http://localhost:3000`、`http://192.168.1.1`（路由器后台）这类地址**本来就没有
 * https 服务**。强行升级的结果是页面直接打不开 —— 用户会认为"开了这个开关就上不了网"。
 * Chrome 的 HTTPS-First 同样豁免这些地址。
 *
 * 纯模块：零依赖、零 IO（`URL` 是运行时全局）。
 */

/** 设置键名。 */
const HTTPS_ONLY_SETTING_KEY = 'privacy.https_only'

/** 私有网段（RFC1918）+ 回环 + 链路本地（IPv4）。 */
const PRIVATE_V4 = [
  /^10\./,
  /^127\./,
  /^169\.254\./,
  /^192\.168\./,
  /^172\.(1[6-9]|2\d|3[01])\./
]

/** 非 http(s) 的协议一律不管（内部页、文件、扩展页、数据页…）。 */
const PASSTHROUGH_PROTOCOLS = ['about:', 'file:', 'data:', 'blob:', 'chrome:', 'chrome-extension:', 'hira:', 'devtools:']

/**
 * 该地址是否**豁免**升级（本地 / 私网 / 非 http 协议）。
 *
 * 地址解析失败（畸形 URL）时返回 true（豁免）—— 畸形地址升级没有任何意义，
 * 而且"放行"比"拦下"更保守：拦下会让用户面对一个打不开的页面却不知道原因。
 *
 * @param {unknown} rawUrl
 * @returns {boolean}
 */
function isHttpsUpgradeBypassed(rawUrl: unknown) : boolean {
  const raw = String(rawUrl == null ? '' : rawUrl)
  if (!raw) return true
  let parsed
  try {
    parsed = new URL(raw)
  } catch (_) {
    return true
  }
  const protocol = parsed.protocol
  if (PASSTHROUGH_PROTOCOLS.includes(protocol)) return true
  if (protocol !== 'http:') return true

  const host = parsed.hostname.toLowerCase()
  if (!host) return true
  // 主机名类豁免：localhost 及其子域、`.local`（mDNS）、`.localhost`、裸主机名（无点）
  if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local')) return true
  if (!host.includes('.') && !/^\[/.test(host)) return true
  // IPv6 回环与唯一本地地址（fc00::/7）
  if (host === '[::1]' || /^\[f[cd]/i.test(host)) return true
  if (PRIVATE_V4.some((re) => re.test(host))) return true
  return false
}

/**
 * `http://` → `https://`。不必升级 / 无法升级时返回 `null`（调用方据此放行）。
 *
 * 用 `URL` 改写协议而不是字符串替换：后者会误伤 `http://` 出现在路径或查询里的地址
 *（`https://example.com/?u=http://x`）。
 *
 * @param {unknown} rawUrl
 * @returns {string|null}
 */
function httpsUpgradeOf(rawUrl: unknown) : string|null {
  const raw = String(rawUrl == null ? '' : rawUrl)
  if (!raw || isHttpsUpgradeBypassed(raw)) return null
  try {
    const parsed = new URL(raw)
    if (parsed.protocol !== 'http:') return null
    parsed.protocol = 'https:'
    return parsed.toString()
  } catch (_) {
    return null
  }
}

export { HTTPS_ONLY_SETTING_KEY, isHttpsUpgradeBypassed, httpsUpgradeOf }
