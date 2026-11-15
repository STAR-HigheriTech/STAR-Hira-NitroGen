/**
 * main/home-url.js — 主页 / 新标签页地址的**唯一解析层**
 *
 * 合并设置（B）：`app.home_mode`(select: newtab/blank/custom) + `app.home_url`(text, 仅 custom 用)
 * 取代旧的 `app.new_tab_page` / `app.home_page` 两个独立文本项。
 *
 * 这里有两个口径，**不要混用**：
 *   · `resolveHomeUrl(settings)` —— 「主页」语义（纯净的设置解析）。
 *     消费方：壳层地址栏「这一页算不算新标签页」的比对基准、书签栏可见性、
 *     启动模式 `home`。它**不含扩展覆盖**：覆盖地址是运行时事实，不是设置值。
 *   · `resolveNewTabUrl(settings, { incognito })` —— 「一张新标签实际该落到哪个地址」。
 *     在 newtab 档 / custom 留空时，非无痕窗口优先采用扩展声明的
 *     `chrome_url_overrides.newtab`；无痕窗口永远回到内置页（无痕会话不加载扩展）。
 *
 * ── 为什么扩展覆盖在「地址解析」这一层，而不是 `hira://newtab` 协议层重定向 ──
 * 曾经的实现让协议 handler 返回 `Response.redirect('chrome-extension://<id>/newtab.html', 302)`，
 * Chromium 把重定向目标当成**网络地址**去 DNS 解析（把扩展 id 当域名），
 * 结果 `ERR_NAME_NOT_RESOLVED (-20)` → 落到「无法访问此网站」错误页。
 * 同一个地址**直接导航**却是完全正常的（Chromium 会交给扩展加载器）。
 * 结论：扩展页只能由浏览器**主动 loadURL**，不能靠 HTTP 重定向跳过去。
 * 于是覆盖解析下沉到这里，由 TabManager 在建标签 / 导航前统一询问。
 *
 * 禁止各写一份解析 —— 保证「新标签按钮 / 主页按钮 / 启动页 / 关闭最后标签 /
 * 扩展 API」拿到的地址全局一致。
 */

const { pageUrl } = require('@hira-ng/shared-types/src/pages.mjs')
const { STARTUP_SETTING_KEYS, DEFAULT_HOME_MODE } = require('@hira-ng/shared-types/src/startup.mjs')

// 地址拼法回到 `pages.mjs#pageUrl`（内部页身份的唯一真源），不手写 hira:// 字符串。
const NEWTAB_URL = pageUrl('newtab')

interface SettingsPort {
  get: (key: string) => unknown
}

// ─────────────────────────────────────────────────────────────────────────────
// 扩展新标签页覆盖（`chrome_url_overrides.newtab`）的查询口
// ─────────────────────────────────────────────────────────────────────────────

/**
 * 注入覆盖地址的提供方（由 main.js 在扩展系统就绪后注册）。
 *
 * 用 **live getter** 而不是把地址拷进来：profile 切换会重建 extensionService
 * （见 main.js 的 `getOrCreateExtensionService`），闭包读的是当前引用，
 * 于是切换 profile 后新标签页立刻跟随新 profile 的扩展，无需重复注册。
 * 传非函数即视为「没有覆盖」—— 拿不到扩展系统时新标签页照常工作。
 * @type {null | ((profileId?: string) => string)}
 */
let newTabOverrideProvider: ((profileId?: string) => string) | null = null

/** @param {null | ((profileId?: string) => string)} fn */
function setNewTabOverrideProvider(fn: ((profileId?: string) => string) | null): void {
  newTabOverrideProvider = typeof fn === 'function' ? fn : null
}

/**
 * 当前生效的扩展新标签页地址；没有 / 取不到 / 不是扩展页时返回空串。
 *
 * 只放行 `chrome-extension://` —— 提供方理论上有能力给任意地址，但「覆盖新标签页」
 * 在 Chrome 里本来就只可能是扩展页面；多一层白名单，避免坏数据把新标签页导去外部站点。
 * @param {string} [profileId] 明确指定时按该 profile 读取（窗口事件链没有 IPC sender）
 * @returns {string}
 */
function newTabOverrideUrl(profileId?: string): string {
  if (!newTabOverrideProvider) return ''
  try {
    const url = newTabOverrideProvider(profileId)
    return typeof url === 'string' && url.startsWith('chrome-extension://') ? url : ''
  } catch (_) {
    return ''
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// 设置解析（两个口径共用的取值部分）
// ─────────────────────────────────────────────────────────────────────────────

/**
 */
function readHomeMode(settings: SettingsPort): 'newtab' | 'blank' | 'custom' {
  let mode: unknown = DEFAULT_HOME_MODE
  try { mode = settings.get(STARTUP_SETTING_KEYS.homeMode) } catch (_) {}
  return mode === 'blank' || mode === 'custom' ? mode : 'newtab'
}

/**
 * `app.home_url` 里的非空自定义地址；未设置 / 空白时返回空串。
 * @param {{ get:(key:string)=>any }} settings
 * @returns {string}
 */
function readCustomHomeUrl(settings: SettingsPort): string {
  try {
    const u = settings.get(STARTUP_SETTING_KEYS.homeUrl)
    if (typeof u === 'string' && u.trim()) return u.trim()
  } catch (_) {}
  return ''
}

/**
 * 依据设置解析主页 / 新标签页应打开的地址（**纯净设置口径，不含扩展覆盖**）。
 *   newtab → 内置快速拨号页 hira://newtab
 *   blank  → about:blank
 *   custom → app.home_url（为空则回退到内置新标签页）
 * @param {{ get:(key:string)=>any }} settings  settingsService.get
 * @returns {string}
 */
function resolveHomeUrl(settings: SettingsPort): string {
  const mode = readHomeMode(settings)
  if (mode === 'blank') return 'about:blank'
  if (mode === 'custom') return readCustomHomeUrl(settings) || NEWTAB_URL
  return NEWTAB_URL
}

/**
 * 一张新标签**实际**该打开的地址（设置 + 运行时扩展覆盖）。
 *
 * 与 `resolveHomeUrl` 的差别只有一处：newtab 档（以及 custom 留空回退到新标签页时），
 * 非无痕窗口优先采用扩展声明的覆盖页。blank / 有值的 custom 不受扩展影响 ——
 * 用户显式指定了地址，就不该被扩展改写。
 *
 * @param {{ get:(key:string)=>any }} settings
 * @param {{ incognito?: boolean, containerProfileId?: string|null, profileId?: string }} [options]
 *   incognito = 这张标签最终跑在无痕会话里（无痕窗口的**每个**标签都算）。
 *   containerProfileId = 容器标签：它跑在**另一个 profile** 的 Session 上，
 *   那个会话里的扩展集合和当前窗口不是一回事，覆盖地址不能套用 → 一律回内置页。
 * @returns {string}
 */
function resolveNewTabUrl(
  settings: SettingsPort,
  options: { incognito?: boolean; containerProfileId?: string | null; profileId?: string } = {}
): string {
  const mode = readHomeMode(settings)
  if (mode === 'blank') return 'about:blank'
  if (mode === 'custom') {
    const custom = readCustomHomeUrl(settings)
    if (custom) return custom
  }
  // newtab 档（含 custom 留空回退）：只有当前 profile 的普通标签才让扩展覆盖。
  const canOverride = options.incognito !== true && !options.containerProfileId
  if (canOverride) {
    const override = newTabOverrideUrl(options.profileId)
    if (override) return override
  }
  return NEWTAB_URL
}

module.exports = {
  resolveHomeUrl,
  resolveNewTabUrl,
  setNewTabOverrideProvider,
  newTabOverrideUrl,
  NEWTAB_URL
}
