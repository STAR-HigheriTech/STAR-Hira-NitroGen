import type {
  TranslationMode,
  TranslationPostprocessContext,
  TranslationProviderHttp
} from '@hira-ng/domain-translate'
import type {
  TranslatePageContext,
  TranslatePageDescriptor
} from '@hira-ng/shared-types/src/translate-plugin'

const {
  createCustomTranslationProvider,
  createBingTranslationProvider,
  createGoogleTranslationProvider,
  createMicrosoftTranslationProvider,
  createPluginTranslationProvider,
  createTranslationService
} = require('@hira-ng/domain-translate')
const { createTranslationHttp } = require('./translation-http')
const {
  TRANSLATE_PLUGIN_POINTS,
  normalizeTranslatePageContext
} = require('@hira-ng/shared-types/src/translate-plugin.mjs')

interface TranslationSettingsPort {
  get(key: string): unknown
}

interface TranslationServiceDeps {
  slots?: {
    call(name: string, payload: unknown): Promise<unknown>
    has?(name: string): boolean
  } | null
  settings?: TranslationSettingsPort | null
}

async function postprocessWithPlugins(
  slots: TranslationServiceDeps['slots'],
  context: TranslationPostprocessContext
): Promise<readonly string[] | null> {
  if (!slots || typeof slots.call !== 'function') return null
  if (typeof slots.has === 'function' && !slots.has(TRANSLATE_PLUGIN_POINTS.postprocessor)) return null
  const raw = await slots.call(TRANSLATE_PLUGIN_POINTS.postprocessor, {
    texts: [...context.texts],
    sourceTexts: [...context.sourceTexts],
    from: context.from,
    to: context.to,
    url: context.url
  })
  const candidate = Array.isArray(raw)
    ? raw
    : raw && typeof raw === 'object'
      ? (raw as { texts?: unknown }).texts
      : null
  if (!Array.isArray(candidate) || candidate.length !== context.texts.length) return null
  return candidate.map((value) => String(value ?? ''))
}

function electronFetch(): ((url: string, init?: RequestInit) => Promise<Response>) | null {
  try {
    const { net } = require('electron')
    if (net && typeof net.fetch === 'function') {
      return (url: string, init?: RequestInit) => net.fetch(url, {
        ...init,
        credentials: 'include',
        useSessionCookies: true
      } as RequestInit & { useSessionCookies: boolean })
    }
  } catch (_) {}
  return typeof fetch === 'function' ? (url: string, init?: RequestInit) => fetch(url, init) : null
}

/**
 * 网页翻译的组合根。
 *
 * 调度与协议各自独立：
 *   · `@hira-ng/domain-translate` 管注册、缓存、总时限、熔断与故障切换；
 *   · 本文件把 Electron 系统代理网络、设置与四类翻译插槽接进去；
 *   · 插件引擎优先，在线来源按设置自动排序，页面只消费标准上下文与译文。
 */
export function createTranslateService(deps: TranslationServiceDeps = {}) {
  const fetchImpl = electronFetch()
  const http: TranslationProviderHttp = createTranslationHttp({ fetchImpl })
  const service = createTranslationService({
    mode: () => {
      try {
        return String(deps.settings?.get('languages.translation_engine') || 'auto') as TranslationMode
      } catch (_) {
        return 'auto'
      }
    },
    defaultDeadlineMs: 30_000,
    failureThreshold: 2,
    cooldownMs: 30_000,
    postprocess: (context: TranslationPostprocessContext) => postprocessWithPlugins(deps.slots, context)
  })

  service.registerProvider(createPluginTranslationProvider({ slots: deps.slots }))
  service.registerProvider(createCustomTranslationProvider({
    http,
    getConfig: () => ({
      endpoint: String(deps.settings?.get('languages.translation_custom_endpoint') || ''),
      apiKey: String(deps.settings?.get('languages.translation_custom_api_key') || ''),
      model: String(deps.settings?.get('languages.translation_custom_model') || '')
    })
  }))
  service.registerProvider(createBingTranslationProvider({ http }))
  service.registerProvider(createMicrosoftTranslationProvider({ http }))
  service.registerProvider(createGoogleTranslationProvider({ http }))
  // 令牌预热不阻塞启动；首次点击翻译时通常已拿到 Bing 短期凭证。
  void service.warmup()

  return {
    ...service,
    async inspectPage(input: TranslatePageDescriptor): Promise<TranslatePageContext> {
      const payload = {
        url: String(input.url || '').slice(0, 4096),
        title: String(input.title || '').slice(0, 1024),
        documentLanguage: input.documentLanguage
          ? String(input.documentLanguage).slice(0, 32)
          : undefined,
        textSample: input.textSample ? String(input.textSample).slice(0, 4000) : undefined
      }
      const slots = deps.slots
      if (!slots || typeof slots.call !== 'function') {
        return normalizeTranslatePageContext(null, null)
      }
      const has = slots.has
      const detect = !has || has(TRANSLATE_PLUGIN_POINTS.languageDetector)
      const applyPolicy = !has || has(TRANSLATE_PLUGIN_POINTS.domPolicy)
      const [detector, policy] = await Promise.all([
        detect ? slots.call(TRANSLATE_PLUGIN_POINTS.languageDetector, payload) : null,
        applyPolicy ? slots.call(TRANSLATE_PLUGIN_POINTS.domPolicy, payload) : null
      ])
      return normalizeTranslatePageContext(detector, policy)
    }
  }
}

module.exports = { createTranslateService }
