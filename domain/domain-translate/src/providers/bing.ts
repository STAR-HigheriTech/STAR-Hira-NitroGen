import type { TranslationProvider, TranslationProviderHttp, TranslationProviderRequest } from '../types'
import { createRequestLanes } from './request-lanes'
import { makeTranslationGroups } from './text-batches'

const PAGE_URL = 'https://www.bing.com/translator'
const TRANSLATE_URL = 'https://www.bing.com/ttranslatev3'
const MAX_TEXTS_PER_REQUEST = 48
const MAX_CHARS_PER_REQUEST = 900

const TARGET_TAGS: Record<string, string> = Object.freeze({
  zh: 'zh-Hans',
  'zh-TW': 'zh-Hant'
})

interface BingToken {
  ig: string
  iid: string
  key: string
  token: string
  expiresAt: number
}

interface BingTranslationProviderOptions {
  http: TranslationProviderHttp
  id?: string
  label?: string
  now?: () => number
}

function extractBingToken(html: string, now: number): BingToken {
  const abuse = html.match(/params_AbusePreventionHelper\s*=\s*\[([^\]]+)\]/)?.[1] || ''
  const values = abuse
    .split(',')
    .map((value) => value.trim().replace(/^["']|["']$/g, ''))
  const ig = html.match(/\bIG\s*[:=]\s*["']([^"']+)/)?.[1] || ''
  const iid = html.match(/data-iid=["']([^"']+)/)?.[1] || 'translator.5023'
  const key = values[0] || ''
  const token = values[1] || ''
  const lifetime = Number(values[2]) || 55 * 60_000
  if (!ig || !key || !token) throw new Error('Bing 临时令牌解析失败')
  return {
    ig,
    iid: `${iid}.1`,
    key,
    token,
    expiresAt: Math.min(Number(key) + lifetime, now + 55 * 60_000)
  }
}

function parseBingText(payload: unknown): string {
  if (!Array.isArray(payload) || !payload[0] || typeof payload[0] !== 'object') {
    const record = payload && typeof payload === 'object' ? payload as Record<string, unknown> : null
    const detail = record
      ? String(record.message || record.error || record.statusCode || '未知响应')
      : '未知响应'
    throw new Error(`Bing 返回异常：${detail.slice(0, 100)}`)
  }
  const translations = (payload[0] as { translations?: unknown }).translations
  if (!Array.isArray(translations) || !translations[0] || typeof translations[0] !== 'object') {
    throw new Error('Bing 返回格式异常')
  }
  return String((translations[0] as { text?: unknown }).text ?? '')
}

function shouldRefreshBingToken(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error)
  return !/返回异常：400/.test(message)
}

/**
 * Bing Web Translator：中国大陆可直连，使用页面自带的短期 Web 令牌。
 * 不依赖开发者 API Key；令牌与 cookies 留在 Electron 默认会话内，过期自动刷新。
 */
export function createBingTranslationProvider(
  options: BingTranslationProviderOptions
): TranslationProvider {
  const http = options.http
  const now = typeof options.now === 'function' ? options.now : Date.now
  let cachedToken: BingToken | null = null
  let tokenInflight: Promise<BingToken> | null = null
  const requestLanes = createRequestLanes({ count: 3, maxPending: 24 })

  /**
   * Bing Web 接口对同 IP 的突发请求很敏感。所有批次共享三条请求通道，
   * 页面层仍可并行等待，但任何时刻最多三个在飞、二十四个在排队。
   */
  function serializeRequest<T>(task: () => Promise<T>): Promise<T> {
    return requestLanes.run(task)
  }

  async function getToken(force = false, signal?: AbortSignal): Promise<BingToken> {
    if (!force && cachedToken && cachedToken.expiresAt - now() > 2 * 60_000) return cachedToken
    if (!force && tokenInflight) return tokenInflight
    const task = http.requestText(PAGE_URL, {
      signal,
      timeoutMs: 4_000,
      headers: {
        Accept: 'text/html,application/xhtml+xml',
        'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/140.0.0.0 Safari/537.36 Edg/140.0.0.0'
      }
    }).then((html) => {
      cachedToken = extractBingToken(html, now())
      return cachedToken
    }).finally(() => {
      if (tokenInflight === task) tokenInflight = null
    })
    tokenInflight = task
    return task
  }

  async function translateOne(
    text: string,
    source: string,
    target: string,
    signal?: AbortSignal,
    retry = true
  ): Promise<string> {
    const token = await getToken(false, signal)
    const query = new URLSearchParams({ isVertical: '1', IG: token.ig, IID: token.iid })
    const body = new URLSearchParams({
      fromLang: source,
      to: target,
      text,
      token: token.token,
      key: token.key
    })
    try {
      const payload = await serializeRequest(() => http.requestJson(`${TRANSLATE_URL}?${query}`, {
        method: 'POST',
        signal,
        timeoutMs: 6_000,
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          Accept: '*/*',
          Origin: 'https://www.bing.com',
          Referer: PAGE_URL,
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/140.0.0.0 Safari/537.36 Edg/140.0.0.0'
        },
        body: body.toString()
      }))
      return parseBingText(payload)
    } catch (error) {
      if (retry && shouldRefreshBingToken(error)) {
        cachedToken = null
        return translateOne(text, source, target, signal, false)
      }
      throw error
    }
  }

  return {
    id: options.id || 'bing',
    label: options.label || 'Bing 中国',
    kind: 'online',
    order: 5,
    timeoutMs: 9_000,
    async warmup(): Promise<void> {
      await getToken(false)
    },
    async translate(request: TranslationProviderRequest): Promise<readonly string[]> {
      const target = TARGET_TAGS[request.to] || request.to
      const source = request.from && request.from !== 'auto'
        ? (TARGET_TAGS[request.from] || request.from.split('-')[0])
        : 'auto-detect'
      const output = new Array<string>(request.texts.length)

      async function translateIndividually(indices: number[], texts: string[]): Promise<void> {
        let cursor = 0
        const workers = Array.from({ length: Math.min(6, texts.length) }, async () => {
          while (cursor < texts.length) {
            if (request.signal?.aborted) throw new DOMException('翻译已取消', 'AbortError')
            const offset = cursor++
            output[indices[offset]] = await translateOne(
              texts[offset],
              source,
              target,
              request.signal
            )
          }
        })
        await Promise.all(workers)
      }

      async function translateGroup(group: { indices: number[]; texts: string[] }): Promise<void> {
        if (group.texts.length === 1) {
          await translateIndividually(group.indices, group.texts)
          return
        }
        const joined = group.texts.join('\n')
        const translated = await translateOne(joined, source, target, request.signal)
        const segments = translated.split(/\n/)
        if (segments.length !== group.texts.length) {
          await translateIndividually(group.indices, group.texts)
          return
        }
        group.indices.forEach((index, offset) => {
          output[index] = segments[offset]
        })
      }

      let cursor = 0
      const groups = makeTranslationGroups(
        request.texts,
        MAX_TEXTS_PER_REQUEST,
        MAX_CHARS_PER_REQUEST
      )
      const workers = Array.from({ length: Math.min(4, groups.length) }, async () => {
        while (cursor < groups.length) {
          if (request.signal?.aborted) throw new DOMException('翻译已取消', 'AbortError')
          await translateGroup(groups[cursor++])
        }
      })
      await Promise.all(workers)
      return output
    }
  }
}
