/**
 * User-Agent 伪装（对齐 RT `src/main/modules/user-agent.ts`）。
 *
 * ── 为什么必须做 ──────────────────────────────────────────────────
 * 不做任何处理时，Chromium 发出的 UA 形如：
 *   Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko)
 *   hira-ng/0.0.1 Chrome/149.0.0.0 Electron/43.2.0 Safari/537.36
 * 其中 `hira-ng/0.0.1` 与 `Electron/43.2.0` 两个 token 会让站点直接判定「这不是
 * 真浏览器」：Spotify / WhatsApp Web / Google 登录 / Chrome 应用商店等都会因此
 * 降级功能或直接拒绝服务（RT 的同一处注释也点名了这几个站点）。
 *
 * ── 做法：重建而不是过滤 ──────────────────────────────────────────
 * 与其「按 token 白名单删掉可疑项」（漏一个就前功尽弃），不如**保留平台段、
 * 重新拼一个标准 Chrome UA**：平台段来自原 UA 的括号内容（含 Windows/macOS/Linux
 * 的真实版本信息），尾部固定为 AppleWebKit + Chrome + Safari 三段。这样：
 *   · 不可能残留任何 Electron / 应用名 token（结构上就不存在）；
 *   · 版本号用 Chromium 主版本 + `.0.0.0`，与真实 Chrome 的 UA 写法一致
 *     （Electron 的 process.versions.chrome 是 `149.0.0.0`，主版本就是 149）。
 *
 * ── 落点：`app.userAgentFallback` ────────────────────────────────
 * 它必须在**任何 session / webContents 创建之前**设置，且一处设置对所有 session
 * 生效 —— 因此放在 main 启动最早期。相比每个 profile 各自 `session.setUserAgent`，
 * 少一处「新 profile 忘了设」的漂移点。
 *
 * 本模块不 import electron：`app` 由调用方注入，因此可单测、可在任意宿主复用。
 */

interface AppLike {
  userAgentFallback: string
}

interface ApplyOptions {
  /** 覆盖 Chromium 版本（默认取 process.versions.chrome） */
  chromeVersion?: string
}

/** 标准 Chrome UA 的固定尾部（三段：AppleWebKit / Chrome / Safari）。 */
const FIXED_TAIL = 'AppleWebKit/537.36 (KHTML, like Gecko)'

/**
 * 由 Chromium 完整版本（如 `149.0.0.0`）得到真实 Chrome UA 里的写法。
 * 真实 Chrome 的 UA 只保留主版本 + `.0.0.0`，不会出现完整四段版本。
 * @param {string} chromeVersion
 */
function toUaChromeVersion(chromeVersion: string): string {
  const major = String(chromeVersion || '').split('.')[0]
  return /^\d+$/.test(major) ? `${major}.0.0.0` : String(chromeVersion || '')
}

/**
 * 把任意 UA 重建成「标准 Chrome UA」。
 *
 * @param {string} raw 原始 UA（通常是 `app.userAgentFallback`）
 * @param {string} [chromeVersion] 覆盖 Chromium 版本
 * @returns {string} 伪装后的 UA；**无法解析平台段时原样返回**（宁可不改，也不要造一个更假的）
 */
function buildSpoofedUserAgent(raw: string, chromeVersion?: string): string {
  const source = String(raw || '')
  const platformMatch = /\(([^)]*)\)/.exec(source)
  if (!platformMatch) return source
  const platform = platformMatch[1].trim()
  if (!platform) return source

  const version = toUaChromeVersion(
    chromeVersion || (typeof process !== 'undefined' && process.versions ? process.versions.chrome : '') || ''
  )
  if (!version) return source

  return `Mozilla/5.0 (${platform}) ${FIXED_TAIL} Chrome/${version} Safari/537.36`
}

/**
 * 把伪装后的 UA 设成全局兜底（必须在 app ready / 任何 session 创建之前调用）。
 *
 * @param {AppLike} app Electron 的 app（只用到 userAgentFallback 一个字段）
 * @param {ApplyOptions} [options]
 * @returns {string} 最终生效的 UA（便于调用方打日志核对）
 */
function applySpoofedUserAgent(app: AppLike, options: ApplyOptions = {}): string {
  const raw = app && typeof app.userAgentFallback === 'string' ? app.userAgentFallback : ''
  const next = buildSpoofedUserAgent(raw, options.chromeVersion)
  if (next && app) app.userAgentFallback = next
  return next
}

/**
 * 组装 Accept-Language 的语言列表（**不带 q 值**）。
 *
 * Chromium 的 `session.setUserAgent(ua, acceptLanguages)` 接收的是按优先级排列的语言
 * 列表，q 值由 Chromium 自己补（`zh-CN,zh,en` → `zh-CN,zh;q=0.9,en;q=0.8`）。
 * 直接传带 q 值的字符串会被当成语言名，产出 `zh-CN;q=0.9;q=0.9` 这种畸形头。
 *
 * 真实 Chrome 的 Accept-Language 来自系统语言首选项（不只是 navigator.language），
 * 这里做同样的事：首选语言 + 其基础语言在前，其余首选项按序跟上，最后兜底 en。
 *
 * @param {string[]} preferred 系统首选语言（`app.getPreferredSystemLanguages()`）
 */
function buildAcceptLanguages(preferred: string[]): string {
  const out: string[] = []
  const push = (value: string) => {
    const lang = String(value || '').trim().replace(/_/g, '-')
    if (!lang) return
    if (!out.some((item) => item.toLowerCase() === lang.toLowerCase())) out.push(lang)
  }
  const list = (Array.isArray(preferred) ? preferred : []).filter(Boolean)
  if (list.length) {
    push(list[0])
    // 基础语言只补首选语言的（zh-CN → zh），与 Chrome 在中文系统上的真实头一致。
    push(String(list[0]).split('-')[0])
  }
  for (const lang of list.slice(1)) push(lang)
  // 系统首选项里没有任何英文时兜底 en，避免头里完全没英文。
  const hasEnglish = out.some((lang) => lang.toLowerCase() === 'en' || lang.toLowerCase().startsWith('en-'))
  if (!hasEnglish) push('en')
  return out.join(',')
}

module.exports = { buildSpoofedUserAgent, applySpoofedUserAgent, toUaChromeVersion, buildAcceptLanguages }
