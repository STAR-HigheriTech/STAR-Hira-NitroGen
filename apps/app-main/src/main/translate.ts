import type { TranslationMode, TranslationProviderHttp } from '@hira-ng/domain-translate'

const {
  createBingTranslationProvider,
  createGoogleTranslationProvider,
  createMicrosoftTranslationProvider,
  createPluginTranslationProvider,
  createTranslationService
} = require('@hira-ng/domain-translate')
const { createTranslationHttp } = require('./translation-http')

interface TranslationSettingsPort {
  get(key: string): unknown
}

interface TranslationServiceDeps {
  slots?: { call(name: string, payload: unknown): Promise<unknown> } | null
  settings?: TranslationSettingsPort | null
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
 *   · 本文件只把 Electron 系统代理网络能力、设置与 `translate.provider` 插槽接进去；
 *   · 插件永远优先，在线来源按设置自动排序，新增来源只需注册，不改页面与 IPC。
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
    defaultDeadlineMs: 12_000,
    failureThreshold: 2,
    cooldownMs: 30_000
  })

  service.registerProvider(createPluginTranslationProvider({ slots: deps.slots }))
  service.registerProvider(createBingTranslationProvider({ http }))
  service.registerProvider(createMicrosoftTranslationProvider({ http }))
  service.registerProvider(createGoogleTranslationProvider({ http }))
  // 令牌预热不阻塞启动；首次点击翻译时通常已拿到 Bing 短期凭证。
  void service.warmup()
  return service
}

module.exports = { createTranslateService }
