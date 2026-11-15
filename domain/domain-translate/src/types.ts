export const TRANSLATION_MODES = Object.freeze(['auto', 'bing', 'google', 'microsoft'] as const)

export type TranslationMode = (typeof TRANSLATION_MODES)[number]
export type TranslationProviderKind = 'plugin' | 'offline' | 'online'

export interface TranslationProviderRequest {
  texts: readonly string[]
  from: string
  to: string
  signal?: AbortSignal
}

export interface TranslationProvider {
  id: string
  label: string
  kind: TranslationProviderKind
  order?: number
  timeoutMs?: number
  supports?(request: TranslationProviderRequest): boolean | Promise<boolean>
  warmup?(): Promise<void>
  translate(request: TranslationProviderRequest): Promise<readonly string[]>
}

export interface TranslationFailure {
  provider: string
  label: string
  message: string
}

export interface TranslationError {
  code: 'all-providers-failed' | 'deadline-exceeded' | 'invalid-input'
  message: string
  failures: TranslationFailure[]
}

export interface TranslationBatchResult {
  texts: string[]
  provider: string | null
  providerLabel: string | null
  translatedCount: number
  cachedCount: number
  elapsedMs: number
  error?: TranslationError
}

export interface TranslationServiceOptions {
  mode?: () => TranslationMode | string
  maxCacheEntries?: number
  defaultDeadlineMs?: number
  failureThreshold?: number
  cooldownMs?: number
  now?: () => number
}

export interface TranslationRequest {
  texts: readonly unknown[]
  from?: string
  to: string
  /** 用户主动发起的翻译：允许越过熔断，立即重新探测来源。 */
  force?: boolean
}

export interface TranslationProviderHttp {
  requestJson(url: string, init?: TranslationHttpRequestInit): Promise<unknown>
  requestText(url: string, init?: TranslationHttpRequestInit): Promise<string>
}

export interface TranslationHttpRequestInit {
  method?: string
  headers?: Record<string, string>
  body?: string
  signal?: AbortSignal
  timeoutMs?: number
}

export class TranslationProviderUnavailableError extends Error {
  readonly code = 'provider-unavailable'
}
