/**
 * page-hints —— 从 HTML 文档里补采「安装线索」（head-only，不依赖页面注入）。
 *
 * ── 为什么需要它 ──────────────────────────────────────────────────
 * 页面侧的 `pwa-hints` preload 只在「head 变更后的 300ms 防抖窗口」内上报；
 * 用户打开设置页再回来、或标签恢复但 preload 错过时机时，主进程手里就没有
 * manifest / favicon / theme-color —— 只能退化成占位图标的站点应用。
 * 这里用 `session.fetch`（带 cookie / 走 Chromium 网络栈）重拉一次文档，
 * **只读前 256KB**，把 head 里的线索补齐。
 *
 * ── 边界 ──────────────────────────────────────────────────────────
 *  · 只解析标签，不执行脚本；注释 / script / style / template / noscript 先剥离，
 *    避免正文里出现的 `<link rel="manifest">` 字样造成误判；
 *  · 属性值支持单引号 / 双引号 / 无引号 + HTML 实体解码；
 *  · 相对地址按 `<base href>` → 最终重定向地址依次解析，仅接受 http(s)。
 */

import type { Session } from 'electron'
import { isHttpUrl, isHttpProtocol } from '@hira-ng/shared-types/src/url-protocols'
import { assertSafeOutboundUrl } from '@hira-ng/infra-net-guard'

export const MAX_HTML_BYTES = 256 * 1024
const DEFAULT_TIMEOUT_MS = 5000
const MAX_URL = 2048
const MAX_TITLE = 300
const MAX_THEME_COLOR = 64
const MAX_REDIRECTS = 5

/** favicon 显式标签的 rel 取值（`shortcut` 常与 `icon` 同时出现）。 */
const ICON_RELS = new Set(['icon', 'apple-touch-icon', 'apple-touch-icon-precomposed', 'shortcut'])

const NAMED_ENTITIES: Readonly<Record<string, string>> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' '
}

/** HTML 实体解码：命名实体 + 十进制 / 十六进制数字实体。 */
function decodeEntities(value: unknown): string {
  const text = String(value == null ? '' : value)
  if (text.indexOf('&') === -1) return text
  return text.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (match, body) => {
    const lower = String(body).toLowerCase()
    if (lower.charAt(0) === '#') {
      const code = lower.charAt(1) === 'x' ? parseInt(lower.slice(2), 16) : parseInt(lower.slice(1), 10)
      if (!Number.isFinite(code) || code <= 0 || code > 0x10ffff) return match
      try { return String.fromCodePoint(code) } catch (_) { return match }
    }
    const named = NAMED_ENTITIES[lower]
    return named == null ? match : named
  })
}

/** 相对地址 → 绝对 http(s) 地址；其它协议与超长地址一律丢弃。 */
function resolveHttpUrl(raw: unknown, baseUrl: string | null): string | null {
  const value = String(raw == null ? '' : raw).trim()
  if (!value) return null
  try {
    const u = new URL(value, baseUrl || undefined)
    if (!isHttpProtocol(u.protocol)) return null
    return u.href.length > MAX_URL ? null : u.href
  } catch (_) {
    return null
  }
}

/** 解析一个标签的属性串（标签名之后、`>` 之前的部分）。 */
function parseAttributes(raw: string): Record<string, string> {
  const attrs: Record<string, string> = Object.create(null)
  const re = /([a-zA-Z_:][-a-zA-Z0-9_:.]*)\s*=\s*("([^"]*)"|'([^']*)'|([^\s"'=<>`]+))/g
  let m
  while ((m = re.exec(String(raw || '')))) {
    const name = m[1].toLowerCase()
    const value = m[3] != null ? m[3] : (m[4] != null ? m[4] : m[5])
    if (!(name in attrs)) attrs[name] = decodeEntities(value)
  }
  return attrs
}

/** `rel` 可能是 "shortcut icon" 这种多 token 形式。 */
function relTokens(value: unknown): string[] {
  return String(value || '').toLowerCase().split(/\s+/).filter(Boolean)
}

/** 从 "32x32 192x192" 里取面积最大的边长；`any`（SVG）按 1024 算。 */
function declaredSize(value: unknown): number {
  const raw = String(value || '').toLowerCase()
  let best = 0
  for (const token of raw.split(/\s+/)) {
    const m = /^(\d+)x(\d+)$/.exec(token)
    if (!m) continue
    best = Math.max(best, Math.min(Number(m[1]), Number(m[2])))
  }
  if (best) return best
  return raw.includes('any') ? 1024 : 0
}

/** 剥掉不参与 head 解析的块，避免正文伪标签「抢走」manifest / favicon。 */
function stripNoise(html: unknown): string {
  return String(html || '')
    .replace(/<!--[\s\S]*?(?:-->|$)/g, '')
    .replace(/<(script|style|template|noscript)\b[^>]*>[\s\S]*?(?:<\/\1\s*>|$)/gi, '')
}

/**
 * 纯解析：给定 HTML 文本与文档地址，抽出安装线索。
 * 不抛异常、不访问网络，便于单测与复用（例如离线快照分析）。
 *
 * @param {string} html
 * @param {string} baseUrl 文档最终地址（用于解析相对 href）
 * @param {{ faviconFallback?: boolean }} [options] faviconFallback=false 时不回落 /favicon.ico
 * @returns {{ ok: true, title: string, manifestUrl: string|null, themeColor: string|null, faviconUrl: string|null }
 *          | { ok: false, reason: string }}
 */
export interface ParsedPageHints {
  ok: true
  title: string
  manifestUrl: string | null
  themeColor: string | null
  faviconUrl: string | null
}

export interface PageHintFailure {
  ok: false
  reason: string
}

export interface PageHintOptions {
  faviconFallback?: boolean
}

export function parsePageHints(html: string, baseUrl: string, options: PageHintOptions = {}): ParsedPageHints | PageHintFailure {
  const source = String(html || '')
  if (!source.trim()) return { ok: false, reason: '空文档' }
  const documentUrl = isHttpUrl(baseUrl) ? String(baseUrl) : null

  const clean = stripNoise(source)

  // ── 第一遍：找 <base href>，它会影响之后所有相对地址的解析基准 ──
  let resolutionBase = documentUrl
  const baseRe = /<base\b([^>]*)>/gi
  let baseMatch
  while ((baseMatch = baseRe.exec(clean))) {
    const href = parseAttributes(baseMatch[1]).href
    if (!href) continue
    const resolved = resolveHttpUrl(href, documentUrl)
    if (resolved) { resolutionBase = resolved; break }
  }

  // ── 第二遍：标题 / manifest / favicon / theme-color ──
  let title = ''
  let manifestUrl: string | null = null
  let faviconUrl: string | null = null
  let faviconSize = -1
  let themeColor: string | null = null

  const tagRe = /<([a-zA-Z][a-zA-Z0-9:-]*)\b([^>]*)>/g
  let tagMatch
  while ((tagMatch = tagRe.exec(clean))) {
    const tag = tagMatch[1].toLowerCase()
    const attrs = parseAttributes(tagMatch[2])

    if (tag === 'title' && !title) {
      const end = clean.indexOf('</title', tagRe.lastIndex)
      const slice = clean.slice(tagRe.lastIndex, end === -1 ? tagRe.lastIndex + 400 : end)
      title = decodeEntities(slice).replace(/\s+/g, ' ').trim().slice(0, MAX_TITLE)
      continue
    }

    if (tag === 'meta') {
      const name = String(attrs.name || '').trim().toLowerCase()
      if (name === 'theme-color' && themeColor == null) {
        const value = String(attrs.content == null ? '' : attrs.content).trim()
        if (value) themeColor = value.slice(0, MAX_THEME_COLOR)
      }
      continue
    }

    if (tag !== 'link') continue
    const tokens = relTokens(attrs.rel)

    if (!manifestUrl && tokens.includes('manifest')) {
      const href = resolveHttpUrl(attrs.href, resolutionBase)
      if (href) manifestUrl = href
      continue
    }

    if (!tokens.some((token) => ICON_RELS.has(token))) continue
    const href = resolveHttpUrl(attrs.href, resolutionBase)
    if (!href) continue
    const size = declaredSize(attrs.sizes)
    if (size > faviconSize) { faviconUrl = href; faviconSize = size }
  }

  if (!faviconUrl && options.faviconFallback !== false && documentUrl) {
    faviconUrl = resolveHttpUrl('/favicon.ico', resolutionBase || documentUrl)
  }

  return { ok: true, title, manifestUrl, themeColor, faviconUrl }
}

/**
 * 读取响应体的前 N 字节：只关心 head，没必要把整页下载完。
 * 无流式 body 时回落 arrayBuffer() 再截断。
 */
async function readPrefix(response: Response, maxBytes: number): Promise<Buffer> {
  const body = response && response.body
  if (!body || typeof body.getReader !== 'function') {
    const buffer = Buffer.from(await response.arrayBuffer())
    return buffer.length > maxBytes ? buffer.subarray(0, maxBytes) : buffer
  }
  const reader = body.getReader()
  const chunks: Buffer[] = []
  let total = 0
  try {
    while (total < maxBytes) {
      const { done, value } = await reader.read()
      if (done) break
      if (!value || !value.length) continue
      const chunk = Buffer.from(value)
      const remain = maxBytes - total
      if (chunk.length >= remain) {
        chunks.push(chunk.subarray(0, remain))
        total = maxBytes
        break
      }
      chunks.push(chunk)
      total += chunk.length
    }
  } finally {
    try { await reader.cancel() } catch (_) {}
  }
  return Buffer.concat(chunks)
}

async function guardedSessionFetch(session: Session, rawUrl: string, init: RequestInit): Promise<Response> {
  let current = rawUrl
  for (let hop = 0; hop <= MAX_REDIRECTS; hop += 1) {
    const verdict = await assertSafeOutboundUrl(current)
    if (!verdict.ok) throw new Error(`页面线索地址不允许访问：${verdict.reason}`)
    const response = await session.fetch(verdict.url, { ...init, redirect: 'manual' })
    if (![301, 302, 303, 307, 308].includes(response.status)) return response
    const location = response.headers.get('location')
    try { await response.body?.cancel() } catch (_) {}
    if (!location) throw new Error(`HTTP ${response.status}`)
    current = new URL(location, verdict.url).href
  }
  throw new Error('页面线索重定向次数过多')
}

/** 文档用的 charset 只在明确声明时生效，其余按 UTF-8（现代站点事实标准）。 */
function charsetOf(contentType: string): string {
  const m = /charset\s*=\s*"?([\w-]+)/i.exec(String(contentType || ''))
  return m ? m[1].toLowerCase() : 'utf-8'
}

/**
 * 拉取页面并解析 head 线索。
 *
 * @param {Electron.Session} session
 * @param {string} documentUrl
 * @param {{ timeoutMs?: number, faviconFallback?: boolean }} [options]
 * @returns {Promise<{ ok: true, documentUrl: string, title: string, manifestUrl: string|null,
 *                     themeColor: string|null, faviconUrl: string|null }
 *                  | { ok: false, reason: string }>}
 */
export async function discoverPageHints(
  session: Session | null | undefined,
  documentUrl: string,
  options: PageHintOptions & { timeoutMs?: number } = {}
): Promise<ParsedPageHints & { documentUrl: string } | PageHintFailure> {
  if (!session || typeof session.fetch !== 'function') return { ok: false, reason: '缺少会话' }
  if (!isHttpUrl(documentUrl)) return { ok: false, reason: '地址非法' }

  const timeoutMs = Number(options.timeoutMs) > 0 ? Number(options.timeoutMs) : DEFAULT_TIMEOUT_MS
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const response = await guardedSessionFetch(session, String(documentUrl), {
      credentials: 'include',
      signal: controller.signal
    })
    if (!response || !response.ok) {
      try { await response?.body?.cancel() } catch (_) {}
      return { ok: false, reason: `HTTP ${response ? response.status : '无响应'}` }
    }

    const contentType = (() => {
      try { return String(response.headers.get('content-type') || '').toLowerCase() } catch (_) { return '' }
    })()
    // 下载链接 / 图片 / JSON 等没有 head 可解析，直接放弃（不报错，交给调用方兜底）。
    if (contentType && !contentType.includes('html') && !contentType.includes('xml')) {
      try { await response.body?.cancel() } catch (_) {}
      return { ok: false, reason: '非 HTML 文档' }
    }
    const declared = Number(response.headers.get('content-length') || 0)
    if (declared > MAX_HTML_BYTES) {
      try { await response.body?.cancel() } catch (_) {}
      return { ok: false, reason: 'HTML 文档过大' }
    }

    const buffer = await readPrefix(response, MAX_HTML_BYTES)
    if (!buffer.length) return { ok: false, reason: '空响应' }

    let text
    try {
      text = new TextDecoder(charsetOf(contentType)).decode(buffer)
    } catch (_) {
      text = buffer.toString('utf8')
    }

    const finalUrl = isHttpUrl(response.url) ? response.url : String(documentUrl)
    const parsed = parsePageHints(text, finalUrl, options)
    if (!parsed.ok) return parsed
    return { ...parsed, documentUrl: finalUrl }
  } catch (err) {
    const reason = err instanceof Error
      ? err.name === 'AbortError' ? '页面线索请求超时' : err.message
      : String(err)
    return { ok: false, reason }
  } finally {
    clearTimeout(timer)
  }
}

