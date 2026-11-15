/**
 * spellcheck.mjs —— 拼写检查的**唯一真源**（键名 + 取值 + 语言码规范化 + 展示名）
 *
 * 谁用它：
 *   - `apps/app-main/src/main/settings/appliers/spellcheck.js`
 *     把两个设置键落到当前 profile 的会话（`setSpellCheckerEnabled` /
 *     `setSpellCheckerLanguages`）；
 *   - `apps/app-main/src/main/settings/ipc.js`
 *     给设置页的「拼写检查语言」字段提供**运行时**选项（Electron 自带的词典清单
 *     随构建/平台变化，写死在 schema 里必然与真实可用清单脱节）。
 *
 * 为什么语言码要在这里规范化：
 *   `session.setSpellCheckerLanguages()` 收到不认识的码会**直接抛异常**；
 *   而设置是跨机器/跨版本持久化的（换了构建可能少几个词典）。所以入口处一律
 *   按 `availableSpellCheckerLanguages` 过滤 —— 宁可少选一种，也不让整项设置失效。
 *
 * 纯模块：零依赖、零 IO（`Intl` 是运行时全局）。
 */

/** 设置键名。 */
const SPELLCHECK_SETTING_KEYS = Object.freeze({
  /** 总开关（会话级）。 */
  enabled: 'spellcheck.enabled',
  /** 语言码数组；空数组 = 跟随 Electron/系统默认（不下发）。 */
  languages: 'spellcheck.languages',
  /** 用户自定义词典（新增单词列表，由设置页维护）。 */
  dictionary: 'spellcheck.dictionary'
})

/** 设置缺省值（域层与设置页共用）。 */
const DEFAULT_SPELLCHECK_SETTINGS = Object.freeze({
  [SPELLCHECK_SETTING_KEYS.enabled]: true,
  [SPELLCHECK_SETTING_KEYS.languages]: Object.freeze([]),
  [SPELLCHECK_SETTING_KEYS.dictionary]: Object.freeze([])
})

/**
 * 从设置读取器解析出可下发的配置。
 *
 * `enabled` 缺省为 `true`：拼写检查是浏览器默认行为，键不存在不代表"用户关掉了"。
 *
 * @param {(key: string) => any} get
 * @returns {{ enabled: boolean, languages: string[] }}
 */
function spellcheckFromSettings(get: (key: string) => unknown) : { enabled: boolean, languages: string[] } {
  const defaultEnabled = DEFAULT_SPELLCHECK_SETTINGS[SPELLCHECK_SETTING_KEYS.enabled] as boolean
  const fallbackEnabled = defaultEnabled !== false
  const fallbackLanguages = DEFAULT_SPELLCHECK_SETTINGS[SPELLCHECK_SETTING_KEYS.languages] as unknown
  let enabled = fallbackEnabled
  let raw: unknown = fallbackLanguages
  if (typeof get === 'function') {
    try { enabled = get(SPELLCHECK_SETTING_KEYS.enabled) !== false } catch (_) { enabled = fallbackEnabled }
    try { raw = get(SPELLCHECK_SETTING_KEYS.languages) as unknown } catch (_) { raw = fallbackLanguages }
  }
  return { enabled, languages: normalizeSpellcheckLanguages(raw) }
}

/**
 * 规范化语言码列表：去空、去重、只保留字符串。
 *
 * @param {unknown} value
 * @param {string[]|null} [available] 允许的码表；省略/空表示"不校验"
 * @returns {string[]}
 */
function normalizeSpellcheckLanguages(value: unknown, available: string[] | null = null): string[] {
  const allowed = Array.isArray(available) && available.length
    ? new Set(available.map((item) => String(item)))
    : null
  const out: string[] = []
  const seen = new Set<string>()
  for (const item of Array.isArray(value) ? value : []) {
    const code = String(item == null ? '' : item).trim()
    if (!code || seen.has(code)) continue
    if (allowed && !allowed.has(code)) continue
    seen.add(code)
    out.push(code)
  }
  return out
}

/**
 * Electron `availableSpellCheckerLanguages` → 设置页下拉/多选可用的 `[[code, label]]`。
 *
 * 展示名走 `Intl.DisplayNames`（不引入语言名映射表）：词典码本身就是 BCP-47，
 * 系统自带的名字表比我们手写的全，也不会随版本漂移。
 * 运行时不支持 `DisplayNames`（老 Node）时回落到原码 —— 选项仍然可用。
 *
 * @param {unknown} available
 * @param {string} [locale]
 * @returns {Array<[string, string]>}
 */
function spellcheckLanguageOptions(available: unknown, locale: string = 'zh-CN') : Array<[string, string]> {
  const codes = normalizeSpellcheckLanguages(available)
  let names = null
  try {
    if (typeof Intl !== 'undefined' && typeof Intl.DisplayNames === 'function') {
      names = new Intl.DisplayNames([locale, 'en'], { type: 'language' })
    }
  } catch (_) {
    names = null
  }
  const labelOf = (code: string): string => {
    if (!names) return code
    try {
      const name = names.of(code)
      return name && name !== code ? name : code
    } catch (_) {
      return code
    }
  }
  const options: Array<[string, string]> = codes.map((code) => [code, labelOf(code)])
  options.sort((a, b) => a[1].localeCompare(b[1], locale))
  return options
}

export {
  SPELLCHECK_SETTING_KEYS,
  DEFAULT_SPELLCHECK_SETTINGS,
  spellcheckFromSettings,
  normalizeSpellcheckLanguages,
  spellcheckLanguageOptions
}
