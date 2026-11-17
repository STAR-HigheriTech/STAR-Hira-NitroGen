import type { TranslationHttpRequestInit, TranslationProviderHttp } from '@hira-ng/domain-translate'
import { createNetworkGuard } from '@hira-ng/infra-net-guard'

const MAX_REDIRECTS = 4
const MAX_RESPONSE_BYTES = 1024 * 1024
const DEFAULT_TIMEOUT_MS = 4_000
/**
 * 只信任协议适配器写死的三个翻译域名。
 *
 * TUN / Fake-IP 代理常把公网域名解析到 `198.18.0.0/15`，默认 SSRF 守卫会正确拦截该网段，
 * 但 Electron `net.fetch` 本来会把请求交给系统代理。固定域名无需再按解析 IP 判私网；
 * 重定向到其它域名时仍走完整守卫。
 */
const TRUSTED_TRANSLATION_HOSTS = Object.freeze([
  'edge.microsoft.com',
  'api-edge.cognitive.microsofttranslator.com',
  'translate.googleapis.com',
  'www.bing.com',
  'cn.bing.com'
])

interface ResponseLike {
  ok?: boolean
  status: number
  url?: string
  headers?: { get(name: string): string | null }
  body?: {
    getReader(): {
      read(): Promise<{ done: boolean; value?: Uint8Array }>
      cancel(): Promise<unknown>
    }
  } | null
  text(): Promise<string>
}

export interface TranslationHttpOptions {
  fetchImpl?: ((url: string, init?: RequestInit) => Promise<ResponseLike>) | null
}

function mergeSignal(parent?: AbortSignal): { signal: AbortSignal; dispose(): void } {
  const controller = new AbortController()
  const onAbort = (): void => controller.abort()
  parent?.addEventListener('abort', onAbort, { once: true })
  return {
    signal: controller.signal,
    dispose: () => parent?.removeEventListener('abort', onAbort)
  }
}

async function readBytes(response: ResponseLike): Promise<Uint8Array> {
  const declared = Number(response.headers?.get('content-length') || 0)
  if (declared > MAX_RESPONSE_BYTES) throw new Error('翻译响应过大')
  const reader = response.body?.getReader()
  if (!reader) {
    return new TextEncoder().encode(await response.text())
  }

  const chunks: Uint8Array[] = []
  let total = 0
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      if (!value) continue
      total += value.byteLength
      if (total > MAX_RESPONSE_BYTES) {
        await reader.cancel().catch(() => undefined)
        throw new Error('翻译响应过大')
      }
      chunks.push(value)
    }
  } catch (error) {
    await reader.cancel().catch(() => undefined)
    throw error
  }

  const merged = new Uint8Array(total)
  let offset = 0
  for (const chunk of chunks) {
    merged.set(chunk, offset)
    offset += chunk.byteLength
  }
  return merged
}

/**
 * 翻译协议适配器共用的受控 HTTP 边界。
 * 跳转逐跳校验、响应限读、系统代理与连接取消都收口在这里，来源适配器只关心 JSON 协议。
 */
export function createTranslationHttp(options: TranslationHttpOptions = {}): TranslationProviderHttp {
  const fetchImpl = options.fetchImpl || null
  const guard = createNetworkGuard({ trustedHosts: TRUSTED_TRANSLATION_HOSTS })

  async function request(url: string, init: TranslationHttpRequestInit = {}): Promise<Uint8Array> {
    if (!fetchImpl) throw new Error('运行环境不支持网络请求')
    const timeoutMs = Math.max(250, Number(init.timeoutMs) || DEFAULT_TIMEOUT_MS)
    const controller = new AbortController()
    const parent = mergeSignal(init.signal)
    const timer = setTimeout(() => controller.abort(), timeoutMs)
    ;(timer as unknown as { unref?: () => void }).unref?.()
    const onAbort = (): void => controller.abort()
    parent.signal.addEventListener('abort', onAbort, { once: true })

    try {
      let current = url
      let method = init.method || 'GET'
      let body = init.body
      for (let hop = 0; hop <= MAX_REDIRECTS; hop += 1) {
        const verdict = await guard.assertSafeUrl(current)
        if (!verdict.ok) throw new Error(`翻译端点不可访问：${verdict.reason}`)
        const response = await fetchImpl(verdict.url, {
          method,
          headers: init.headers,
          body: method === 'GET' || method === 'HEAD' ? undefined : body,
          signal: controller.signal,
          redirect: init.followRedirects ? 'follow' : 'manual'
        })
        if (init.followRedirects && response.url) {
          const finalHost = new URL(response.url).hostname.toLowerCase()
          if (!TRUSTED_TRANSLATION_HOSTS.some((host) => host === finalHost)) {
            await response.body?.getReader().cancel().catch(() => undefined)
            throw new Error('翻译重定向到了未受信任的主机')
          }
        }
        if ([301, 302, 303, 307, 308].includes(response.status)) {
          const location = response.headers?.get('location')
          await response.body?.getReader().cancel().catch(() => undefined)
          if (!location) throw new Error(`HTTP ${response.status}`)
          current = new URL(location, verdict.url).href
          if (response.status === 303) {
            method = 'GET'
            body = undefined
          }
          continue
        }
        if (response.ok === false || response.status >= 400) {
          await response.body?.getReader().cancel().catch(() => undefined)
          throw new Error(`HTTP ${response.status}`)
        }
        return await readBytes(response)
      }
      throw new Error('翻译端点重定向过多')
    } finally {
      clearTimeout(timer)
      parent.dispose()
    }
  }

  return {
    async requestJson(url: string, init?: TranslationHttpRequestInit): Promise<unknown> {
      const bytes = await request(url, init)
      return JSON.parse(new TextDecoder().decode(bytes))
    },
    async requestText(url: string, init?: TranslationHttpRequestInit): Promise<string> {
      const bytes = await request(url, init)
      return new TextDecoder().decode(bytes)
    }
  }
}
