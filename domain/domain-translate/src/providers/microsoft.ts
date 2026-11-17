import type { TranslationProvider, TranslationProviderHttp, TranslationProviderRequest } from '../types'

const AUTH_ENDPOINT = 'https://edge.microsoft.com/translate/auth'
const ENDPOINT = 'https://api-edge.cognitive.microsofttranslator.com/translate'
const MAX_TEXTS_PER_REQUEST = 80
const MAX_CHARS_PER_REQUEST = 40_000

const TARGET_TAGS: Record<string, string> = Object.freeze({
  zh: 'zh-Hans',
  'zh-TW': 'zh-Hant'
})

interface TokenCache {
  value: string
  expiresAt: number
}

interface MicrosoftTranslationProviderOptions {
  http: TranslationProviderHttp
  id?: string
  label?: string
  now?: () => number
}

function jwtExpiry(token: string, now: number): number {
  try {
    const encoded = token.split('.')[1]
    if (!encoded) return now + 8 * 60_000
    const payload = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8')) as { exp?: number }
    return typeof payload.exp === 'number' ? payload.exp * 1000 : now + 8 * 60_000
  } catch {
    return now + 8 * 60_000
  }
}

function chunkTexts(texts: readonly string[]): number[][] {
  const chunks: number[][] = []
  let current: number[] = []
  let chars = 0
  texts.forEach((text, index) => {
    if (current.length > 0 && (current.length >= MAX_TEXTS_PER_REQUEST || chars + text.length > MAX_CHARS_PER_REQUEST)) {
      chunks.push(current)
      current = []
      chars = 0
    }
    current.push(index)
    chars += text.length
  })
  if (current.length) chunks.push(current)
  return chunks
}

function parseTranslations(payload: unknown, count: number): string[] {
  if (!Array.isArray(payload) || payload.length !== count) throw new Error('Microsoft 返回的译文数量不一致')
  return payload.map((item) => {
    if (!item || typeof item !== 'object') throw new Error('Microsoft 返回格式异常')
    const translations = (item as { translations?: unknown }).translations
    if (!Array.isArray(translations) || !translations[0] || typeof translations[0] !== 'object') {
      throw new Error('Microsoft 返回格式异常')
    }
    return String((translations[0] as { text?: unknown }).text ?? '')
  })
}

/**
 * Edge 浏览器的匿名翻译通道：短期 bearer token 由微软公开的 Web 端签发。
 * 不需要开发者 API Key；令牌只在内存里缓存，并在过期前刷新。
 */
export function createMicrosoftTranslationProvider(
  options: MicrosoftTranslationProviderOptions
): TranslationProvider {
  const http = options.http
  const now = typeof options.now === 'function' ? options.now : Date.now
  let tokenCache: TokenCache | null = null
  let tokenInflight: Promise<string> | null = null

  async function getToken(force = false, signal?: AbortSignal): Promise<string> {
    if (!force && tokenCache && tokenCache.expiresAt - now() > 2 * 60_000) return tokenCache.value
    if (!force && tokenInflight) return tokenInflight

    const task = http.requestText(AUTH_ENDPOINT, {
      signal,
      timeoutMs: 3_000,
      headers: {
        Accept: 'text/plain',
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/140.0.0.0 Safari/537.36 Edg/140.0.0.0'
      }
    }).then((token) => {
      const value = token.trim()
      if (!value || value.length > 16_384) throw new Error('Microsoft 授权令牌无效')
      tokenCache = { value, expiresAt: jwtExpiry(value, now()) }
      return value
    }).finally(() => {
      if (tokenInflight === task) tokenInflight = null
    })
    tokenInflight = task
    return task
  }

  async function requestChunk(
    texts: readonly string[],
    from: string,
    target: string,
    signal?: AbortSignal,
    retry = true
  ): Promise<string[]> {
    const token = await getToken(false, signal)
    const query = new URLSearchParams({ 'api-version': '3.0', to: target, textType: 'plain' })
    if (from && from !== 'auto') query.set('from', from)
    try {
      const payload = await http.requestJson(`${ENDPOINT}?${query}`, {
        method: 'POST',
        signal,
        timeoutMs: 3_500,
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
          Accept: 'application/json',
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/140.0.0.0 Safari/537.36 Edg/140.0.0.0'
        },
        body: JSON.stringify(texts.map((text) => ({ Text: text })))
      })
      return parseTranslations(payload, texts.length)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      if (retry && /\b401\b/.test(message)) {
        tokenCache = null
        const fresh = await getToken(true, signal)
        const payload = await http.requestJson(`${ENDPOINT}?${query}`, {
          method: 'POST',
          signal,
          timeoutMs: 3_500,
          headers: {
            Authorization: `Bearer ${fresh}`,
            'Content-Type': 'application/json',
            Accept: 'application/json'
          },
          body: JSON.stringify(texts.map((text) => ({ Text: text })))
        })
        return parseTranslations(payload, texts.length)
      }
      throw error
    }
  }

  return {
    id: options.id || 'microsoft',
    label: options.label || 'Microsoft 翻译',
    kind: 'online',
    order: 20,
    timeoutMs: 5_000,
    async translate(request: TranslationProviderRequest): Promise<readonly string[]> {
      const target = TARGET_TAGS[request.to] || request.to
      const source = request.from && request.from !== 'auto'
        ? (TARGET_TAGS[request.from] || request.from.split('-')[0])
        : 'auto'
      const output = new Array<string>(request.texts.length)

      const chunks = chunkTexts(request.texts)
      let cursor = 0
      const workers = Array.from({ length: Math.min(3, chunks.length) }, async () => {
        while (cursor < chunks.length) {
          if (request.signal?.aborted) throw new DOMException('翻译已取消', 'AbortError')
          const indices = chunks[cursor++]
          const translated = await requestChunk(
            indices.map((index) => request.texts[index]),
            source,
            target,
            request.signal
          )
          indices.forEach((index, offset) => {
            output[index] = translated[offset] ?? request.texts[index]
          })
        }
      })
      await Promise.all(workers)
      return output
    }
  }
}
