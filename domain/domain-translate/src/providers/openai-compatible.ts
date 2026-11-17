import type {
  TranslationProvider,
  TranslationProviderHttp,
  TranslationProviderRequest
} from '../types'

export interface CustomTranslationApiConfig {
  endpoint: string
  apiKey: string
  model: string
}

interface CustomTranslationProviderOptions {
  http: TranslationProviderHttp
  getConfig: () => CustomTranslationApiConfig
  id?: string
  label?: string
}

function endpointUrl(value: string): string {
  const url = new URL(value.trim())
  if (url.protocol !== 'https:' && url.protocol !== 'http:') throw new Error('自定义 API 地址必须使用 HTTP(S)')
  if (/\/v1\/?$/i.test(url.pathname)) url.pathname = `${url.pathname.replace(/\/?$/, '')}/chat/completions`
  return url.href
}

function contentText(payload: unknown): string {
  if (!payload || typeof payload !== 'object') throw new Error('自定义 API 返回格式异常')
  const choices = (payload as { choices?: unknown }).choices
  if (!Array.isArray(choices) || !choices[0] || typeof choices[0] !== 'object') {
    throw new Error('自定义 API 未返回 choices')
  }
  const message = (choices[0] as { message?: unknown }).message
  if (!message || typeof message !== 'object') throw new Error('自定义 API 未返回 message')
  const content = (message as { content?: unknown }).content
  if (typeof content === 'string') return content
  if (Array.isArray(content)) {
    return content.map((part) => {
      if (!part || typeof part !== 'object') return ''
      const text = (part as { text?: unknown }).text
      return typeof text === 'string' ? text : ''
    }).join('')
  }
  throw new Error('自定义 API 返回内容为空')
}

function parseTranslations(content: string, count: number): string[] {
  const cleaned = content.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '')
  try {
    const parsed = JSON.parse(cleaned)
    if (Array.isArray(parsed) && parsed.length === count) return parsed.map((item) => String(item ?? ''))
  } catch (_) {}
  const lines = cleaned.split(/\r?\n/).map((line) => line.trim()).filter(Boolean)
  if (lines.length === count) return lines
  throw new Error('自定义 API 译文数量不一致')
}

/** OpenAI 兼容 Chat Completions 翻译来源。 */
export function createCustomTranslationProvider(
  options: CustomTranslationProviderOptions
): TranslationProvider {
  return {
    id: options.id || 'custom-openai',
    label: options.label || '自定义 API',
    kind: 'online',
    order: 1,
    timeoutMs: 28_000,
    supports(): boolean {
      const config = options.getConfig()
      return Boolean(config.endpoint.trim() && config.model.trim())
    },
    async translate(request: TranslationProviderRequest): Promise<readonly string[]> {
      const config = options.getConfig()
      const endpoint = endpointUrl(config.endpoint)
      const headers: Record<string, string> = {
        'Content-Type': 'application/json',
        Accept: 'application/json'
      }
      if (config.apiKey.trim()) headers.Authorization = `Bearer ${config.apiKey.trim()}`
      const payload = await options.http.requestJson(endpoint, {
        method: 'POST',
        timeoutMs: 25_000,
        signal: request.signal,
        headers,
        body: JSON.stringify({
          model: config.model.trim(),
          temperature: 0,
          stream: false,
          messages: [
            {
              role: 'system',
              content: [
                `Translate every item from ${request.from || 'auto'} to ${request.to}.`,
                'Return only a JSON array of translated strings in the exact same order and length.',
                'Do not merge, split, explain, or add Markdown.'
              ].join(' ')
            },
            {
              role: 'user',
              content: JSON.stringify(request.texts)
            }
          ]
        })
      })
      return parseTranslations(contentText(payload), request.texts.length)
    }
  }
}
