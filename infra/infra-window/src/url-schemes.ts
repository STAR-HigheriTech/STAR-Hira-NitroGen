// @ts-check
/**
 * url-schemes.js — 「可浏览协议」注册中心
 *
 * ── 为什么需要它（真实 bug）────────────────────────────────────────────────
 * TabManager#normalizeUrl 的职责是把「用户输入的裸域名」补成 https://。
 * 旧实现用一串硬编码的 startsWith 白名单来判断「这已经是完整 URL，别动」：
 *
 *     if (raw.startsWith('http://') || raw.startsWith('https://') ||
 *         raw.startsWith('about:') || raw.startsWith('hira://') || ...) return raw
 *     return `https://${raw}`          // ← 兜底补前缀
 *
 * 于是当上层新增了 hira-game:// 协议后，点游戏卡片
 * （href = hira-game://dino/index.html）走到这里不被认识 → 补成
 *     https://hira-game://dino/index.html
 * Chromium 把 hira-game 当域名去解析 → ERR_NAME_NOT_RESOLVED (-105) → 错误页。
 *
 * ── 为什么不是「在白名单里再加一行」────────────────────────────────────────
 * infra 层不该知道上层有哪些协议。每加一个协议就改 infra，依赖方向是反的，
 * 而且这类「漏了一行」的 bug 会一直重演（这次是 hira-game，下次是别的）。
 *
 * 所以改成注册中心：**谁定义协议，谁注册**。
 *   apps/app-main/src/main/scheme-privileges.js#registerAppSchemes()
 *     → registerUrlScheme('hira') / registerUrlScheme('hira-game')
 *   （可浏览协议的登记与「特权协议登记」同处一地 —— 那个 Electron API 是覆盖语义，
 *    只能有一处调用，两张表放在一起才不会再次漂移）
 * infra 只提供机制（scheme 语法校验、查询），不含任何业务协议名。
 */

/**
 * 浏览器 / Electron 内建、无需注册即视为「已知协议」的 scheme。
 * 保持不变：与重构前 normalizeUrl 里那串硬编码白名单逐一对应，
 * 确保既有行为（http/https/about/file/chrome/chrome-extension）零变化。
 */
const BUILTIN_SCHEMES = Object.freeze([
  'http',
  'https',
  'about',
  'file',
  'chrome',
  'chrome-extension'
])

/** 应用自有协议（由各协议模块自行注册） */
const registeredSchemes = new Set<string>()

/** RFC 3986 scheme 语法：ALPHA *( ALPHA / DIGIT / "+" / "-" / "." ) */
const SCHEME_RE = /^[a-z][a-z0-9+.-]*$/

/** @param {unknown} scheme @returns {string} 规范化后的 scheme（小写、去掉尾部冒号） */
function normalizeScheme (scheme: unknown): string {
  return String(scheme == null ? '' : scheme).trim().toLowerCase().replace(/:+$/, '')
}

/**
 * 注册一个应用自有协议，使其 URL 被 normalizeUrl 原样保留（不再补 https://）。
 * @param {string} scheme 协议名，如 'hira' / 'hira-game'
 * @returns {boolean} 是否注册成功（语法非法则 false）
 */
export function registerUrlScheme (scheme: unknown): boolean {
  const s = normalizeScheme(scheme)
  if (!SCHEME_RE.test(s)) return false
  registeredSchemes.add(s)
  return true
}

/** @param {string} scheme */
export function unregisterUrlScheme (scheme: unknown): boolean {
  return registeredSchemes.delete(normalizeScheme(scheme))
}

/** @returns {string[]} 已注册的应用自有协议 */
export function listRegisteredSchemes (): string[] {
  return Array.from(registeredSchemes).sort()
}

/**
 * 该 scheme 是否已知（内建或已注册）。
 * @param {string} scheme
 */
export function isKnownScheme (scheme: unknown): boolean {
  const s = normalizeScheme(scheme)
  return !!s && (registeredSchemes.has(s) || BUILTIN_SCHEMES.includes(s))
}

/**
 * 从字符串里取出 scheme（取不到返回 ''）。
 * 刻意用正则而非 new URL() —— 这里要处理的是「可能还不是合法 URL 的用户输入」，
 * 任何异常都不该冒泡出去。
 * @param {unknown} raw
 * @returns {string}
 */
export function schemeOf (raw: unknown): string {
  const m = /^([a-zA-Z][a-zA-Z0-9+.-]*):/.exec(String(raw == null ? '' : raw).trim())
  return m ? m[1].toLowerCase() : ''
}

/**
 * 该字符串是否已经是「带已知协议」的完整 URL（应原样使用，不再补 https://）。
 * 覆盖三类：
 *   - 内建：http: / https: / about: / file: / chrome: / chrome-extension:
 *   - 应用自有：注册过的 hira: / hira-game: / …
 *   - 裸域名、裸 IP、`host:port`（无 `:` 或 scheme 不合法）→ false，交给调用方补前缀
 * @param {unknown} raw
 */
export function hasKnownScheme (raw: unknown): boolean {
  return isKnownScheme(schemeOf(raw))
}

/**
 * 是否为「非 http(s) 的已知协议」URL —— 内部页 / 本地文件 / 应用自有协议。
 * 供「不要对内部资源做额外处理」的守卫使用（如 isPdfUrl / will-navigate）。
 * http / https / 无协议 → false。
 * @param {unknown} raw
 */
export function isNonWebUrl (raw: unknown): boolean {
  const s = schemeOf(raw)
  if (!s || s === 'http' || s === 'https') return false
  return isKnownScheme(s)
}

