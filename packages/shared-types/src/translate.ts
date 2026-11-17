/**
 * translate —— 网页翻译（C3）的**纯规则层**。
 *
 * ── 它管什么 ──────────────────────────────────────────────────────
 * 只做"哪些文字值得翻译 / 怎么切成批"这类**没有副作用**的判定：
 *   · `shouldSkipText`  —— 太短、纯数字标点、以及**已经是目标语言**的文本直接跳过
 *     （一条中文页面翻成中文，不该把整页文字都送去引擎绕一圈）。
 *   · `batchByChars`    —— 按累计字符数切批（一次请求塞太多会被引擎截断或超时）。
 *   · `LANGUAGES`       —— 目标语言表（设置项与页面引擎共用同一份，避免两处漂移）。
 *
 * 真正的取文本 / 替换 DOM 在页面 preload（`infra-window/preload/translate/`），
 * 引擎调用由 `domain-translate` 调度，组合根在 `apps/app-main/src/main/translate.ts` —— 三者共用本文件的判定，
 * 所以"页面上翻的"与"引擎收到的"永远一致。
 */

/** 上限：一次翻译任务的规模（页面引擎据此截断，绝不会把整站文本一次性推给引擎）。 */
export const TRANSLATE_LIMITS = Object.freeze({
  maxTexts: 1200,
  maxTextsPerBatch: 48,
  maxCharsPerBatch: 1800,
  minTextLength: 2,
  maxTextLength: 12000
})

/** 目标语言表（设置项 `languages.target_language` 与页面引擎共用）。 */
export const LANGUAGES = Object.freeze([
  { id: 'zh', label: '中文（简体）' },
  { id: 'zh-TW', label: '中文（繁体）' },
  { id: 'en', label: '英语' },
  { id: 'ja', label: '日语' },
  { id: 'ko', label: '韩语' },
  { id: 'fr', label: '法语' },
  { id: 'de', label: '德语' },
  { id: 'es', label: '西班牙语' },
  { id: 'it', label: '意大利语' },
  { id: 'pt', label: '葡萄牙语' },
  { id: 'nl', label: '荷兰语' },
  { id: 'pl', label: '波兰语' },
  { id: 'ru', label: '俄语' },
  { id: 'uk', label: '乌克兰语' },
  { id: 'ar', label: '阿拉伯语' },
  { id: 'fa', label: '波斯语' },
  { id: 'he', label: '希伯来语' },
  { id: 'tr', label: '土耳其语' },
  { id: 'id', label: '印度尼西亚语' },
  { id: 'ms', label: '马来语' },
  { id: 'vi', label: '越南语' },
  { id: 'th', label: '泰语' },
  { id: 'hi', label: '印地语' }
])

/** 在线来源选择；`auto` 会先走当前网络更稳定的微软通道，再切换 Google。 */
export const TRANSLATION_ENGINE_OPTIONS = Object.freeze([
  ['auto', '自动切换'],
  ['custom', '自定义 API'],
  ['bing', 'Bing 中国直连'],
  ['microsoft', 'Microsoft'],
  ['google', 'Google']
])

/** 设置键名（设置页 / 域层默认值 / 主进程共用唯一真源）。 */
export const TRANSLATE_SETTING_KEYS = Object.freeze({
  /** 是否对网页自动翻译。 */
  translatePages: 'languages.translate_pages',
  /** 目标语言 id（取值必须来自 `LANGUAGES`）。 */
  targetLanguage: 'languages.target_language',
  /** 在线翻译来源；插件 `translate.provider` 始终优先。 */
  engine: 'languages.translation_engine',
  customEndpoint: 'languages.translation_custom_endpoint',
  customApiKey: 'languages.translation_custom_api_key',
  customModel: 'languages.translation_custom_model'
})

/** 设置缺省值；目标语言取语言表首项，避免两处各写一个字符串。 */
export const DEFAULT_TRANSLATE_SETTINGS = Object.freeze({
  [TRANSLATE_SETTING_KEYS.translatePages]: true,
  [TRANSLATE_SETTING_KEYS.targetLanguage]: LANGUAGES[0].id,
  [TRANSLATE_SETTING_KEYS.engine]: 'auto',
  [TRANSLATE_SETTING_KEYS.customEndpoint]: '',
  [TRANSLATE_SETTING_KEYS.customApiKey]: '',
  [TRANSLATE_SETTING_KEYS.customModel]: ''
})

/** 语言 → 主要文字系统（用于"是不是已经是目标语言"的粗判）。 */
const SCRIPT_OF = Object.freeze({
  zh: 'han', 'zh-TW': 'han', ja: 'kana', ko: 'hangul',
  en: 'latin', fr: 'latin', de: 'latin', es: 'latin', it: 'latin', pt: 'latin',
  nl: 'latin', pl: 'latin', id: 'latin', ms: 'latin', tr: 'latin', vi: 'latin',
  ru: 'cyrillic', uk: 'cyrillic', ar: 'arabic', fa: 'arabic', he: 'hebrew', th: 'thai', hi: 'devanagari'
})

const CJK = /[\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\uac00-\ud7af]/
const HAN = /[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]/
const KANA = /[\u3040-\u30ff]/
const HANGUL = /[\uac00-\ud7af]/
const LATIN = /[A-Za-z\u00c0-\u024f]/
const CYRILLIC = /[\u0400-\u052f]/
const ARABIC = /[\u0600-\u06ff\u0750-\u077f\u08a0-\u08ff]/
const HEBREW = /[\u0590-\u05ff]/
const THAI = /[\u0e00-\u0e7f]/
const DEVANAGARI = /[\u0900-\u097f]/

/** 把 BCP 47 标签压到页面规则认识的粒度。 */
export function normalizeLanguageTag(value: unknown): string {
  const raw = String(value || '').trim().replace(/_/g, '-')
  if (!raw) return ''
  const lower = raw.toLowerCase()
  if (lower === 'zh-tw' || lower === 'zh-hk' || lower === 'zh-hant' || lower.startsWith('zh-hant-')) return 'zh-TW'
  if (lower === 'zh' || lower.startsWith('zh-')) return 'zh'
  return lower.split('-')[0]
}

/**
 * 这段文本是否**已经**是目标语言（是 → 不必翻）。
 *
 * 只按"主要文字系统"粗判，刻意不做语言识别模型：
 * 判错的代价只是多翻/少翻一句，而引入模型的代价是每个页面都要跑一遍推理。
 */
export function isSameScriptAsTarget(text: unknown, targetLang: unknown): boolean {
  const script = SCRIPT_OF[String(targetLang || '') as keyof typeof SCRIPT_OF] || ''
  if (!script) return false
  const s = String(text || '')
  if (script === 'han') return HAN.test(s) && !KANA.test(s) && !HANGUL.test(s)
  if (script === 'kana') return KANA.test(s) || (HAN.test(s) && !HANGUL.test(s))
  if (script === 'hangul') return HANGUL.test(s)
  if (script === 'latin') return LATIN.test(s) && !CJK.test(s)
  if (script === 'cyrillic') return CYRILLIC.test(s)
  if (script === 'arabic') return ARABIC.test(s)
  if (script === 'hebrew') return HEBREW.test(s)
  if (script === 'thai') return THAI.test(s)
  if (script === 'devanagari') return DEVANAGARI.test(s)
  return false
}

/**
 * 这段文本该不该送去翻译。
 * @param {string} text
 * @param {string} targetLang
 * @param {string} [sourceLang] 页面已知源语言时优先按语言判断；文字系统相同不等于语言相同。
 * @returns {boolean} true = **跳过**
 */
export function shouldSkipText(text: string, targetLang: string, sourceLang?: string): boolean {
  const s = String(text == null ? '' : text)
  if (s.trim().length < TRANSLATE_LIMITS.minTextLength) return true
  if (s.length > TRANSLATE_LIMITS.maxTextLength) return true
  // 纯数字 / 标点 / 空白：翻不出任何东西。
  if (!/[A-Za-z\u00c0-\u024f\u0400-\u052f\u0590-\u05ff\u0600-\u06ff\u0900-\u097f\u0e00-\u0e7f\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\uac00-\ud7af]/.test(s)) return true
  const source = normalizeLanguageTag(sourceLang)
  const target = normalizeLanguageTag(targetLang)
  if (source && source !== 'auto') return source === target
  // 拉丁、西里尔、阿拉伯等文字系统都跨多种语言；源语言未知时不能用“同文字”判定同语言。
  // 只有汉字 / 假名 / 谚文这类目标文字系统才值得做低成本短路。
  const targetScript = SCRIPT_OF[String(targetLang || '') as keyof typeof SCRIPT_OF]
  return targetScript === 'han' || targetScript === 'kana' || targetScript === 'hangul'
    ? isSameScriptAsTarget(s, targetLang)
    : false
}

/**
 * 按累计字符数与条目数双重切批。短链接很多时，只看字符数会把一整页塞进同一批。
 * @param {string[]} texts
 * @param {number} [maxChars]
 * @returns {number[][]}
 */
export function batchByChars(texts: string[], maxChars: number = TRANSLATE_LIMITS.maxCharsPerBatch): number[][] {
  const limit = Math.max(200, Number(maxChars) || TRANSLATE_LIMITS.maxCharsPerBatch)
  const out: number[][] = []
  let current: number[] = []
  let used = 0
  const list = Array.isArray(texts) ? texts : []
  for (let i = 0; i < list.length; i++) {
    const len = String(list[i] || '').length
    if (current.length > 0 && (
      used + len > limit ||
      current.length >= TRANSLATE_LIMITS.maxTextsPerBatch
    )) {
      out.push(current)
      current = []
      used = 0
    }
    current.push(i)
    used += len
  }
  if (current.length > 0) out.push(current)
  return out
}
