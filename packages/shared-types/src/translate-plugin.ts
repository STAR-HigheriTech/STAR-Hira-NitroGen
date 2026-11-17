/** 网页翻译插件的跨进程契约。这里只包含可序列化数据，不传函数或 DOM 对象。 */

export const TRANSLATE_PLUGIN_POINTS = Object.freeze({
  provider: 'translate.provider',
  languageDetector: 'translate.language-detector',
  domPolicy: 'translate.dom-policy',
  postprocessor: 'translate.postprocessor'
})

export const TRANSLATE_ATTRIBUTE_NAMES = Object.freeze([
  'title',
  'placeholder',
  'aria-label',
  'alt'
] as const)

export type TranslateAttributeName = (typeof TRANSLATE_ATTRIBUTE_NAMES)[number]

export interface TranslatePageDescriptor {
  url: string
  title: string
  documentLanguage?: string
  textSample?: string
}

export interface TranslateLanguageDetectorResult {
  language: string
  confidence?: number
  id?: string
  label?: string
}

export interface TranslateDomPolicy {
  includeSelectors?: string[]
  excludeSelectors?: string[]
  attributes?: TranslateAttributeName[]
  id?: string
  label?: string
}

export interface TranslatePageContext {
  sourceLanguage: string | null
  detector: (TranslateLanguageDetectorResult & { language: string }) | null
  policy: TranslateDomPolicy
}

export interface TranslatePostprocessRequest {
  texts: readonly string[]
  sourceTexts: readonly string[]
  from: string
  to: string
  url?: string
}

function cleanString(value: unknown, maxLength: number): string {
  return String(value || '').trim().slice(0, maxLength)
}

function cleanSelectors(value: unknown, maxItems = 32): string[] {
  if (!Array.isArray(value)) return []
  const selectors: string[] = []
  const seen = new Set<string>()
  for (const item of value) {
    const selector = cleanString(item, 512)
    if (!selector || seen.has(selector)) continue
    seen.add(selector)
    selectors.push(selector)
    if (selectors.length >= maxItems) break
  }
  return selectors
}

function cleanConfidence(value: unknown): number | undefined {
  const confidence = Number(value)
  if (!Number.isFinite(confidence)) return undefined
  return Math.min(1, Math.max(0, confidence))
}

export function normalizeTranslatePageContext(
  detectorValue: unknown,
  policyValue: unknown
): TranslatePageContext {
  const detectorRecord = detectorValue && typeof detectorValue === 'object'
    ? detectorValue as Record<string, unknown>
    : null
  const language = cleanString(detectorRecord?.language, 32)
  const detector = language
    ? {
        language,
        confidence: cleanConfidence(detectorRecord?.confidence),
        id: cleanString(detectorRecord?.id, 128) || undefined,
        label: cleanString(detectorRecord?.label, 128) || undefined
      }
    : null

  const policyRecord = policyValue && typeof policyValue === 'object'
    ? policyValue as Record<string, unknown>
    : null
  const attributes = Array.isArray(policyRecord?.attributes)
    ? policyRecord.attributes.filter(
        (value): value is TranslateAttributeName =>
          TRANSLATE_ATTRIBUTE_NAMES.includes(value as TranslateAttributeName)
      )
    : []

  return {
    sourceLanguage: language || null,
    detector,
    policy: {
      includeSelectors: cleanSelectors(policyRecord?.includeSelectors),
      excludeSelectors: cleanSelectors(policyRecord?.excludeSelectors),
      attributes: [...new Set(attributes)],
      id: cleanString(policyRecord?.id, 128) || undefined,
      label: cleanString(policyRecord?.label, 128) || undefined
    }
  }
}
