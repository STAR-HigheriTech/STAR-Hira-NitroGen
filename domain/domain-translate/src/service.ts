import { createLruCache } from '@hira-ng/shared-utils'
import {
  TranslationProviderUnavailableError,
  type TranslationBatchResult,
  type TranslationFailure,
  type TranslationMode,
  type TranslationPostprocessContext,
  type TranslationProvider,
  type TranslationProviderRequest,
  type TranslationRequest,
  type TranslationServiceOptions
} from './types'

const DEFAULT_CACHE_MAX = 4_000
const DEFAULT_DEADLINE_MS = 8_000
const DEFAULT_FAILURE_THRESHOLD = 2
const DEFAULT_COOLDOWN_MS = 30_000
const MAX_ERROR_MESSAGE = 180
const PROVIDER_CHUNK_CHARS = 800

interface CircuitState {
  failures: number
  openUntil: number
  lastError: string
}

interface RuntimeProvider {
  provider: TranslationProvider
  order: number
}

type TimerHandle = ReturnType<typeof setTimeout>

function errorMessage(error: unknown, fallback = '未知错误'): string {
  const message = error instanceof Error ? error.message : String(error || fallback)
  return message.length > MAX_ERROR_MESSAGE ? `${message.slice(0, MAX_ERROR_MESSAGE)}…` : message
}

function withDeadline<T>(task: Promise<T>, timeoutMs: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`请求超时（${timeoutMs}ms）`)), timeoutMs)
    ;(timer as unknown as { unref?: () => void }).unref?.()
    task.then(
      (value) => { clearTimeout(timer); resolve(value) },
      (error) => { clearTimeout(timer); reject(error) }
    )
  })
}

function normalizeMode(value: unknown): TranslationMode {
  return value === 'custom' || value === 'bing' || value === 'google' || value === 'microsoft' ? value : 'auto'
}

function normalizeLanguage(value: unknown): string {
  const normalized = String(value || 'auto').trim().replace(/_/g, '-')
  return normalized || 'auto'
}

interface TextPart {
  text: string
  joinAfter: string
}

function splitProviderText(text: string): TextPart[] {
  if (text.length <= PROVIDER_CHUNK_CHARS) return [{ text, joinAfter: '' }]
  const parts: TextPart[] = []
  let rest = text
  while (rest.length > PROVIDER_CHUNK_CHARS) {
    const window = rest.slice(0, PROVIDER_CHUNK_CHARS)
    let cut = -1
    for (const mark of ['\n', '。', '！', '？', '；', '. ', '! ', '? ', '; ', ' ']) {
      const at = window.lastIndexOf(mark)
      if (at >= 320) cut = Math.max(cut, at + mark.length)
    }
    if (cut < 0) cut = PROVIDER_CHUNK_CHARS
    const code = rest.charCodeAt(cut - 1)
    if (code >= 0xd800 && code <= 0xdbff) cut -= 1
    let tail = rest.slice(cut)
    const whitespace = tail.match(/^\s+/)?.[0] || ''
    if (whitespace) tail = tail.slice(whitespace.length)
    parts.push({
      text: rest.slice(0, cut).trimEnd(),
      joinAfter: whitespace || (cut < rest.length ? ' ' : '')
    })
    rest = tail
  }
  parts.push({ text: rest, joinAfter: '' })
  return parts
}

/**
 * 翻译调度器只认统一提供者接口：注册、排序、缓存、超时、熔断与故障切换都在这里。
 * 协议适配器（插件 / Microsoft / Google / 本地模型）互不引用，新增来源不需要改调度器。
 */
export function createTranslationService(options: TranslationServiceOptions = {}) {
  const now = typeof options.now === 'function' ? options.now : Date.now
  const maxCacheEntries = Math.max(0, Number(options.maxCacheEntries) || DEFAULT_CACHE_MAX)
  const defaultDeadlineMs = Math.max(1_000, Number(options.defaultDeadlineMs) || DEFAULT_DEADLINE_MS)
  const failureThreshold = Math.max(1, Number(options.failureThreshold) || DEFAULT_FAILURE_THRESHOLD)
  const cooldownMs = Math.max(1_000, Number(options.cooldownMs) || DEFAULT_COOLDOWN_MS)
  const cache = createLruCache<string>({ maxEntries: maxCacheEntries, maxWeight: 8 * 1024 * 1024, weigh: (value) => value.length * 2 })
  const providerMap = new Map<string, RuntimeProvider>()
  const circuits = new Map<string, CircuitState>()
  let preferredProviderId = ''

  function registerProvider(provider: TranslationProvider): () => void {
    if (!provider || !provider.id || typeof provider.translate !== 'function') {
      throw new Error('翻译提供者必须包含 id 与 translate()')
    }
    providerMap.set(provider.id, { provider, order: Number(provider.order) || 0 })
    return () => providerMap.delete(provider.id)
  }

  function providerAllowed(provider: TranslationProvider, mode: TranslationMode): boolean {
    if (provider.kind === 'plugin') return true
    if (mode === 'custom') return provider.id === 'custom-openai'
    if (mode === 'bing') return provider.id === 'bing'
    if (mode === 'microsoft') return provider.id === 'microsoft'
    if (mode === 'google') return provider.id === 'google'
    if (provider.kind === 'offline') return true
    return provider.kind === 'online'
  }

  function orderedProviders(mode: TranslationMode): TranslationProvider[] {
    const providers = [...providerMap.values()]
      .filter(({ provider }) => providerAllowed(provider, mode))
      .sort((left, right) => left.order - right.order)
      .map(({ provider }) => provider)
    if (!preferredProviderId) return providers
    const preferredIndex = providers.findIndex((provider) => (
      provider.id === preferredProviderId && provider.kind !== 'plugin'
    ))
    if (preferredIndex <= 0) return providers
    const [preferred] = providers.splice(preferredIndex, 1)
    const firstRemote = providers.findIndex((provider) => provider.kind !== 'plugin')
    providers.splice(firstRemote < 0 ? providers.length : firstRemote, 0, preferred)
    return providers
  }

  async function warmup(): Promise<void> {
    const providers = orderedProviders(normalizeMode(options.mode?.()))
    await Promise.allSettled(providers.map((provider) => (
      typeof provider.warmup === 'function' ? provider.warmup() : Promise.resolve()
    )))
  }

  function circuitState(providerId: string): CircuitState | null {
    const state = circuits.get(providerId)
    return state && state.openUntil > now() ? state : null
  }

  function recordProviderSuccess(providerId: string): void {
    circuits.delete(providerId)
    preferredProviderId = providerId
  }

  function recordProviderFailure(providerId: string, message: string): void {
    if (preferredProviderId === providerId) preferredProviderId = ''
    const state = circuits.get(providerId) || { failures: 0, openUntil: 0, lastError: '' }
    state.failures += 1
    state.lastError = message
    if (state.failures >= failureThreshold) {
      state.openUntil = now() + cooldownMs
      state.failures = 0
    }
    circuits.set(providerId, state)
  }

  async function callProvider(
    provider: TranslationProvider,
    request: TranslationProviderRequest,
    deadlineAt: number
  ): Promise<readonly string[]> {
    const remaining = deadlineAt - now()
    if (remaining <= 0) throw new Error('翻译总时限已到')
    const timeoutMs = Math.max(250, Math.min(remaining, Number(provider.timeoutMs) || remaining))
    const controller = new AbortController()
    const onAbort = (): void => controller.abort()
    request.signal?.addEventListener('abort', onAbort, { once: true })
    try {
      return await withDeadline(
        provider.translate({ ...request, signal: controller.signal }),
        timeoutMs
      )
    } finally {
      request.signal?.removeEventListener('abort', onAbort)
      if (!controller.signal.aborted) controller.abort()
    }
  }

  function validateOutput(output: readonly string[], count: number): string[] {
    if (!Array.isArray(output) || output.length !== count) {
      throw new Error('提供者返回的译文数量不一致')
    }
    return output.map((value) => typeof value === 'string' ? value : String(value ?? ''))
  }

  async function postprocess(context: TranslationPostprocessContext): Promise<string[]> {
    if (typeof options.postprocess !== 'function') return [...context.texts]
    try {
      const output = await options.postprocess(context)
      if (!Array.isArray(output) || output.length !== context.texts.length) return [...context.texts]
      return output.map((value) => typeof value === 'string' ? value : String(value ?? ''))
    } catch (_) {
      return [...context.texts]
    }
  }

  async function translate(request: TranslationRequest): Promise<TranslationBatchResult> {
    const startedAt = now()
    const input = Array.isArray(request.texts) ? request.texts.map((text) => String(text ?? '')) : []
    const to = normalizeLanguage(request.to)
    const from = normalizeLanguage(request.from)
    const mode = normalizeMode(options.mode?.())
    const force = request.force === true
    const failures: TranslationFailure[] = []
    const output = input.slice()

    if (!input.length) {
      return {
        texts: output,
        provider: null,
        providerLabel: null,
        translatedCount: 0,
        cachedCount: 0,
        elapsedMs: 0
      }
    }
    if (!to) {
      return {
        texts: output,
        provider: null,
        providerLabel: null,
        translatedCount: 0,
        cachedCount: 0,
        elapsedMs: Math.max(0, now() - startedAt),
        error: { code: 'invalid-input', message: '缺少目标语言', failures }
      }
    }

    let cachedCount = 0
    const pendingByText = new Map<string, number[]>()
    input.forEach((text, index) => {
      if (!text.trim()) return
      const hit = cache.get(`${from}\u0000${to}\u0000${text}`)
      if (hit !== undefined) {
        output[index] = hit
        cachedCount += 1
      } else {
        const positions = pendingByText.get(text)
        if (positions) positions.push(index)
        else pendingByText.set(text, [index])
      }
    })

    if (!pendingByText.size) {
      const translatedCount = output.reduce((count, text, index) => count + (text !== input[index] ? 1 : 0), 0)
      return {
        texts: output,
        provider: 'cache',
        providerLabel: '译文缓存',
        translatedCount,
        cachedCount,
        elapsedMs: Math.max(0, now() - startedAt)
      }
    }

    const deadlineAt = startedAt + defaultDeadlineMs
    for (const provider of orderedProviders(mode)) {
      const circuit = force ? null : circuitState(provider.id)
      if (circuit) {
        const retryAfterSeconds = Math.max(1, Math.ceil((circuit.openUntil - now()) / 1_000))
        failures.push({
          provider: provider.id,
          label: provider.label,
          message: `${retryAfterSeconds} 秒后可重试；上次失败：${circuit.lastError || '未知错误'}`
        })
        continue
      }
      const sourceTexts = [...pendingByText.keys()]
      const sourceParts = new Map<string, TextPart[]>()
      const flattenedParts: string[] = []
      for (const sourceText of sourceTexts) {
        const parts = splitProviderText(sourceText)
        sourceParts.set(sourceText, parts)
        for (const part of parts) flattenedParts.push(part.text)
      }
      const providerRequest: TranslationProviderRequest = {
        texts: flattenedParts,
        from,
        to,
        url: request.url
      }
      try {
        if (typeof provider.supports === 'function' && !(await provider.supports(providerRequest))) {
          continue
        }
        const translated = validateOutput(await callProvider(provider, providerRequest, deadlineAt), flattenedParts.length)
        let translatedOffset = 0
        const translatedSources: string[] = []
        for (const sourceText of sourceTexts) {
          const parts = sourceParts.get(sourceText) || [{ text: sourceText, joinAfter: '' }]
          const text = parts.map((part) => {
            const next = translated[translatedOffset++] || part.text
            return `${next}${part.joinAfter}`
          }).join('').trimEnd()
          translatedSources.push(text || sourceText)
        }
        const processed = await postprocess({
          texts: translatedSources,
          sourceTexts,
          from,
          to,
          url: request.url
        })
        for (let index = 0; index < sourceTexts.length; index += 1) {
          const sourceText = sourceTexts[index]
          const text = processed[index] || translatedSources[index]
          if (!text) continue
          for (const inputIndex of pendingByText.get(sourceText) || []) output[inputIndex] = text
          cache.set(`${from}\u0000${to}\u0000${sourceText}`, text)
        }
        recordProviderSuccess(provider.id)
        const translatedCount = output.reduce((count, text, index) => count + (text !== input[index] ? 1 : 0), 0)
        return {
          texts: output,
          provider: provider.id,
          providerLabel: provider.label,
          translatedCount,
          cachedCount,
          elapsedMs: Math.max(0, now() - startedAt)
        }
      } catch (error) {
        if (error instanceof TranslationProviderUnavailableError) continue
        const message = errorMessage(error)
        recordProviderFailure(provider.id, message)
        failures.push({
          provider: provider.id,
          label: provider.label,
          message
        })
      }
    }

    const timedOut = now() >= deadlineAt
    return {
      texts: output,
      provider: null,
      providerLabel: null,
      translatedCount: 0,
      cachedCount,
      elapsedMs: Math.max(0, now() - startedAt),
      error: {
        code: timedOut ? 'deadline-exceeded' : 'all-providers-failed',
        message: timedOut ? '翻译超过总时限，已停止等待' : '所有翻译通道均不可用',
        failures
      }
    }
  }

  function translateTexts(texts: unknown, to: unknown, from?: unknown): Promise<string[]> {
    return translate({
      texts: Array.isArray(texts) ? texts : [],
      from: String(from || 'auto'),
      to: String(to || 'zh')
    }).then((result) => result.texts)
  }

  return {
    registerProvider,
    warmup,
    translate,
    translateTexts,
    clearCache: (): void => cache.clear(),
    listProviders: (): Array<{ id: string; label: string; kind: string; order: number }> => (
      [...providerMap.values()]
        .sort((left, right) => left.order - right.order)
        .map(({ provider, order }) => ({
          id: provider.id,
          label: provider.label,
          kind: provider.kind,
          order
        }))
    )
  }
}
