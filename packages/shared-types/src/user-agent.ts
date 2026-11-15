/**
 * user-agent.mjs —— 浏览器标识（User-Agent）设置的**唯一真源**（预设表 + 解析规则）
 *
 * ── 为什么需要"用户可设项" ────────────────────────────────────────
 * NG 此前只有**全局清洗**（`apps/app-main/src/main/user-agent.ts`：把 UA 重建成标准
 * Chrome UA，抹掉 `Electron/…` 与应用名 token）——站点兼容性问题解决了，但用户
 * **没有任何办法**改成别的标识。而实际场景里总有几个站点只认特定浏览器
 * （老银行系统只认 IE/Edge、某些站点对 Firefox 给不同布局）。参考实现见本仓库
 * 遗留项目 `main/UASwitcher.js`（它只有"自定义字符串"一个输入框，没有预设）。
 *
 * ── 预设为什么用模板而不是写死整串 ────────────────────────────────
 * UA 里的浏览器版本号会随内核升级过期，写死的字符串半年后就成了"自称 Chrome 141
 * 的 Chrome 149"。因此 Chrome/Edge 系预设里写 `{{chrome}}` 占位，**运行时**替换成
 * 当前 Chromium 主版本 —— 预设永不过期。
 * Firefox / Safari 的版本号无法从 Chromium 推出，只能保留固定值（这两个浏览器的
 * 版本号本来就与 Chromium 无关）——想改成别的版本用「自定义」。
 *
 * 纯模块：零依赖、零 IO、不 require electron（主进程与渲染层读同一份）。
 */

/** 设置键名（键名的主人是本模块，设置页 options 与 applier 共用）。 */
const USER_AGENT_SETTING_KEYS = Object.freeze({
  preset: 'network.user_agent_preset',
  /** 仅 `preset === 'custom'` 时生效。 */
  custom: 'network.user_agent_custom'
})

/** 自定义预设的 id —— 设置页 `when` 联动与解析共用，不各写一遍字面量。 */
const UA_CUSTOM_PRESET_ID = 'custom'

/** 预设表。`template` 为 `''` = 使用**内置默认**（清洗后的 Chrome UA，见 user-agent.ts）；
 * 为 `null` = 走自定义输入框。
 */
const UA_PRESETS = Object.freeze([
  { id: 'default', label: '默认（推荐）', template: '' },
  {
    id: 'chrome-win',
    label: 'Chrome · Windows',
    template: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/{{chrome}}.0.0.0 Safari/537.36'
  },
  {
    id: 'edge-win',
    label: 'Edge · Windows',
    template: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/{{chrome}}.0.0.0 Safari/537.36 Edg/{{chrome}}.0.0.0'
  },
  {
    id: 'chrome-mac',
    label: 'Chrome · macOS',
    template: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/{{chrome}}.0.0.0 Safari/537.36'
  },
  {
    id: 'safari-mac',
    label: 'Safari · macOS',
    template: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.3 Safari/605.1.15'
  },
  {
    id: 'firefox-win',
    label: 'Firefox · Windows',
    template: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:142.0) Gecko/20100101 Firefox/142.0'
  },
  { id: UA_CUSTOM_PRESET_ID, label: '自定义…', template: null }
])

/** 预设 id 清单（归一化用）。 */
const UA_PRESET_IDS = Object.freeze(UA_PRESETS.map((p) => p.id))

/** 下拉的 [值, 中文名]（与设置存储一致）。 */
const UA_PRESET_OPTIONS = Object.freeze(UA_PRESETS.map((p) => [p.id, p.label]))

/** 默认预设 = 内置默认（不改变既有行为）。 */
const DEFAULT_UA_PRESET = 'default'

/** 两项缺省值（键 = 真实设置键）—— 域层默认值与设置页兜底显示共用这一份。 */
const DEFAULT_USER_AGENT_SETTINGS = Object.freeze({
  [USER_AGENT_SETTING_KEYS.preset]: DEFAULT_UA_PRESET,
  [USER_AGENT_SETTING_KEYS.custom]: ''
})

/** 归一化预设取值（设置文件可手改 / 旧数据缺字段 → 落默认）。 */
function normalizeUaPreset(value: unknown): string {
  const v = String(value == null ? '' : value)
  return UA_PRESET_IDS.includes(v) ? v : DEFAULT_UA_PRESET
}

/** 归一化 UA 文本（去首尾空白）。 */
function normalizeUaText(value: unknown): string {
  return typeof value === 'string' ? value.trim() : ''
}

/** 从 Chromium 完整版本（`149.0.0.0`）取主版本号（`149`）。 */
function chromeMajorOf(chromeVersion: unknown): string {
  const major = String(chromeVersion || '').split('.')[0]
  return /^\d+$/.test(major) ? major : ''
}

/**
 * 由设置算出**最终要用的 UA**。
 *
 * @param {{ preset?: unknown, custom?: unknown, chromeVersion?: unknown }} input
 * @returns {string} UA 字符串；**空串 = 使用内置默认**（调用方据此回落到
 *   `user-agent.ts#buildSpoofedUserAgent` 的结果，而不是自己拼一个）
 */
function resolveUserAgent(input: { preset?: unknown, custom?: unknown, chromeVersion?: unknown }) : string {
  const src = input || {}
  const preset = normalizeUaPreset(src.preset)

  if (preset === UA_CUSTOM_PRESET_ID) return normalizeUaText(src.custom)
  if (preset === DEFAULT_UA_PRESET) return ''

  const entry = UA_PRESETS.find((p) => p.id === preset)
  if (!entry || !entry.template) return ''

  const major = chromeMajorOf(src.chromeVersion)
  // 取不到主版本号 → 整串里带 `{{chrome}}` 的部分没法填，回落到内置默认更安全
  //（宁可用"真 Chrome UA"，也不要发出一串带花括号的假 UA）。
  if (entry.template.includes('{{chrome}}') && !major) return ''
  return entry.template.replace(/\{\{chrome\}\}/g, major)
}

/** 从"设置读取函数"直接算出 UA（applier 与设置页共用同一条路）。 */
function userAgentFromSettings(getSetting: unknown, chromeVersion: unknown): string {
  const read = typeof getSetting === 'function' ? getSetting : () => undefined
  return resolveUserAgent({
    preset: read(USER_AGENT_SETTING_KEYS.preset),
    custom: read(USER_AGENT_SETTING_KEYS.custom),
    chromeVersion
  })
}

export {
  USER_AGENT_SETTING_KEYS,
  UA_PRESETS,
  UA_PRESET_IDS,
  UA_PRESET_OPTIONS,
  DEFAULT_UA_PRESET,
  UA_CUSTOM_PRESET_ID,
  DEFAULT_USER_AGENT_SETTINGS,
  normalizeUaPreset,
  normalizeUaText,
  chromeMajorOf,
  resolveUserAgent,
  userAgentFromSettings
}
