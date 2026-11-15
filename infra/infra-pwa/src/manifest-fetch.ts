/**
 * manifest 拉取 —— 只负责"拿字节并解析"，不做任何业务判定。
 *
 * 为什么必须用 `session.fetch` 而不是 Node 的全局 fetch：
 *  · manifest 经常挂在需要登录的站点上，必须带 cookie；
 *  · 代理 / 证书策略属于 Chromium 会话，绕过它等于换了一条网络路径。
 */

import type { Session } from 'electron'
import { isHttpUrl } from '@hira-ng/shared-types/src/url-protocols'
import { assertSafeOutboundUrl } from '@hira-ng/infra-net-guard'

export const MAX_MANIFEST_BYTES = 512 * 1024
export const MAX_ICON_BYTES = 4 * 1024 * 1024
const DEFAULT_TIMEOUT_MS = 8000
const MAX_REDIRECTS = 5

type Failure = { ok: false; reason: string }
type BufferRead = { ok: true; buffer: Buffer } | Failure

export interface ManifestFetchResult {
  ok: true
  manifest: Record<string, unknown>
  manifestUrl: string
  contentType: string
}

export interface BinaryFetchResult {
  ok: true
  buffer: Buffer
  contentType: string
}

function errorText(error: unknown, timeoutMessage: string): string {
  if (error instanceof Error) return error.name === 'AbortError' ? timeoutMessage : error.message
  return String(error)
}

function contentTypeOf(response: Response): string {
  try {
    return String(response.headers.get('content-type') || '').toLowerCase()
  } catch (_) {
    return ''
  }
}

/**
 * 读取响应体并施加字节上限。
 * Content-Length 只能作为快速拒绝；真正的上限必须在流式读取时执行，
 * 否则服务端省略长度就能让主进程先把整段响应吞进内存。
 */
async function readWithLimit(response: Response, maxBytes: number): Promise<BufferRead> {
  const declared = Number(response.headers.get('content-length'))
  if (Number.isFinite(declared) && declared > maxBytes) {
    return { ok: false, reason: `响应过大（${declared} 字节）` }
  }
  if (!response.body) return { ok: true, buffer: Buffer.alloc(0) }
  const reader = response.body.getReader()
  const chunks: Buffer[] = []
  let total = 0
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      total += value.byteLength
      if (total > maxBytes) {
        try { await reader.cancel() } catch (_) {}
        return { ok: false, reason: `响应过大（超过 ${maxBytes} 字节）` }
      }
      chunks.push(Buffer.from(value))
    }
  } catch (error) {
    try { await reader.cancel() } catch (_) {}
    throw error
  }
  return { ok: true, buffer: Buffer.concat(chunks, total) }
}

/** Fetch through Chromium for cookies/proxy, but validate every redirect hop first. */
async function guardedSessionFetch(session: Session, rawUrl: string, init: RequestInit): Promise<Response> {
  let current = rawUrl
  for (let hop = 0; hop <= MAX_REDIRECTS; hop += 1) {
    const verdict = await assertSafeOutboundUrl(current)
    if (!verdict.ok) throw new Error(`目标地址不允许访问：${verdict.reason}`)
    const response = await session.fetch(verdict.url, { ...init, redirect: 'manual' })
    if (![301, 302, 303, 307, 308].includes(response.status)) return response
    const location = response.headers.get('location')
    try { await response.body?.cancel() } catch (_) {}
    if (!location) throw new Error(`重定向缺少 Location（HTTP ${response.status}）`)
    current = new URL(location, verdict.url).href
  }
  throw new Error('重定向次数过多')
}

/**
 * @param {Electron.Session} session
 * @param {string} manifestUrl
 * @returns {Promise<{ ok: true, manifest: object, manifestUrl: string, contentType: string }
 *                 | { ok: false, reason: string }>}
 */
export async function fetchManifest(
  session: Session | null | undefined,
  manifestUrl: string,
  options: { timeoutMs?: number } = {}
): Promise<ManifestFetchResult | Failure> {
  if (!session || typeof session.fetch !== 'function') return { ok: false, reason: '缺少会话' }
  if (!isHttpUrl(manifestUrl)) return { ok: false, reason: 'manifest 地址非法' }

  const timeoutMs = Number(options.timeoutMs) > 0 ? Number(options.timeoutMs) : DEFAULT_TIMEOUT_MS
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const response = await guardedSessionFetch(session, manifestUrl, {
      credentials: 'include',
      signal: controller.signal
    })
    if (!response || !response.ok) {
      return { ok: false, reason: `HTTP ${response ? response.status : '无响应'}` }
    }
    const read = await readWithLimit(response, MAX_MANIFEST_BYTES)
    if (!read.ok) return read

    const text = read.buffer.toString('utf8').replace(/^\uFEFF/, '')
    let parsed: unknown
    try {
      parsed = JSON.parse(text)
    } catch (_) {
      return { ok: false, reason: 'manifest 不是合法 JSON' }
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return { ok: false, reason: 'manifest 根节点必须是对象' }
    }
    return {
      ok: true,
      manifest: parsed as Record<string, unknown>,
      manifestUrl: response.url || manifestUrl,
      contentType: contentTypeOf(response)
    }
  } catch (err) {
    return { ok: false, reason: errorText(err, 'manifest 请求超时') }
  } finally {
    clearTimeout(timer)
  }
}

/**
 * 下载图片字节（图标 / favicon）。不做格式校验 —— 那是 icon-store 的事。
 * @returns {Promise<{ ok: true, buffer: Buffer, contentType: string } | { ok: false, reason: string }>}
 */
export async function fetchBinary(
  session: Session | null | undefined,
  url: string,
  options: { maxBytes?: number; timeoutMs?: number } = {}
): Promise<BinaryFetchResult | Failure> {
  if (!session || typeof session.fetch !== 'function') return { ok: false, reason: '缺少会话' }
  if (!isHttpUrl(url)) return { ok: false, reason: '地址非法' }

  const maxBytes = Number(options.maxBytes) > 0 ? Number(options.maxBytes) : MAX_ICON_BYTES
  const timeoutMs = Number(options.timeoutMs) > 0 ? Number(options.timeoutMs) : DEFAULT_TIMEOUT_MS
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const response = await guardedSessionFetch(session, url, {
      credentials: 'include',
      signal: controller.signal
    })
    if (!response || !response.ok) {
      return { ok: false, reason: `HTTP ${response ? response.status : '无响应'}` }
    }
    const read = await readWithLimit(response, maxBytes)
    if (!read.ok) return read
    return { ok: true, buffer: read.buffer, contentType: contentTypeOf(response) }
  } catch (err) {
    return { ok: false, reason: errorText(err, '图标请求超时') }
  } finally {
    clearTimeout(timer)
  }
}

/** 读取 data:image/... 的字节（manifest 里允许 data URL 图标）。 */
export function decodeDataUrl(dataUrl: string): { buffer: Buffer; contentType: string } | null {
  const m = /^data:([^;,]+);base64,(.+)$/i.exec(String(dataUrl || ''))
  if (!m) return null
  try {
    const buffer = Buffer.from(m[2], 'base64')
    if (!buffer.byteLength || buffer.byteLength > MAX_ICON_BYTES) return null
    return { buffer, contentType: m[1].toLowerCase() }
  } catch (_) {
    return null
  }
}

