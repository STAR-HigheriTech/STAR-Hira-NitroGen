import type { TranslationProvider, TranslationProviderHttp, TranslationProviderRequest } from '../types'
import { createRequestLanes } from './request-lanes'
import { makeTranslationGroups } from './text-batches'

const ENDPOINT = 'https://translate.googleapis.com/translate_a/single'
const BATCH_ENDPOINT = 'https://translate.googleapis.com/translate_a/t'
const MAX_TEXTS_PER_REQUEST = 48
const MAX_CHARS_PER_REQUEST = 1600

const TARGET_TAGS: Record<string, string> = Object.freeze({
  zh: 'zh-CN',
  'zh-TW': 'zh-TW'
})

interface GoogleTranslationProviderOptions {
  http: TranslationProviderHttp
  id?: string
  label?: string
}

function parseBatchText(payload: unknown): string {
  if (Array.isArray(payload)) {
    if (payload.length === 1 && typeof payload[0] === 'string') return payload[0]
    if (payload.every((item) => typeof item === 'string')) return payload.join('\n')
  }
  throw new Error('Google 批量返回格式异常')
}

function parseSingleText(payload: unknown): string {
  if (!Array.isArray(payload) || !Array.isArray(payload[0])) {
    throw new Error('Google 返回格式异常')
  }
  return payload[0]
    .map((segment: unknown) => Array.isArray(segment) ? String(segment[0] ?? '') : '')
    .join('')
}

/**
 * Google 未公开 Web 端点的兼容适配器。
 * 普通页面优先用换行批量端点；遇到换行或结果边界不一致时自动降级为逐条请求。
 */
export function createGoogleTranslationProvider(
  options: GoogleTranslationProviderOptions
): TranslationProvider {
  const http = options.http
  const requestLanes = createRequestLanes({ count: 4, maxPending: 24 })

  return {
    id: options.id || 'google',
    label: options.label || 'Google 翻译',
    kind: 'online',
    order: 10,
    timeoutMs: 8_000,
    async translate(request: TranslationProviderRequest): Promise<readonly string[]> {
      const target = TARGET_TAGS[request.to] || request.to
      const source = request.from && request.from !== 'auto' ? request.from : 'auto'
      const output = new Array<string>(request.texts.length)

      async function translateIndividually(indices: number[], texts: string[]): Promise<void> {
        let cursor = 0
        const workers = Array.from({ length: Math.min(8, texts.length) }, async () => {
          while (cursor < texts.length) {
            if (request.signal?.aborted) throw new DOMException('翻译已取消', 'AbortError')
            const offset = cursor++
            const url = `${ENDPOINT}?client=gtx&sl=${encodeURIComponent(source)}&tl=${encodeURIComponent(target)}&dt=t&q=${encodeURIComponent(texts[offset])}`
            const payload = await requestLanes.run(() => http.requestJson(url, {
              signal: request.signal,
              timeoutMs: 5_000
            }))
            output[indices[offset]] = parseSingleText(payload)
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
        const url = `${BATCH_ENDPOINT}?client=gtx&sl=${encodeURIComponent(source)}&tl=${encodeURIComponent(target)}&q=${encodeURIComponent(joined)}`
        const payload = await requestLanes.run(() => http.requestJson(url, {
          signal: request.signal,
          timeoutMs: 6_000
        }))
        const translated = parseBatchText(payload)
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
