/**
 * Domain: Search — zero-I/O search utilities.
 */

export function normalizeQuery(query: unknown): string {
  return String(query || '').trim().replace(/\s+/g, ' ')
}

export function looksLikeUrl(query: unknown): boolean {
  const value = String(query || '').trim()
  if (!value) return false
  if (/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(value)) return true
  return /(^|[^!])\.[a-z]{2,}([/:]|$)/i.test(value)
}

export function isPlainQuery(query: unknown): boolean {
  return !looksLikeUrl(query)
}

export function hasBang(query: unknown): boolean {
  return /^![a-zA-Z0-9-]+/.test(String(query || '').trim())
}

export function parseBang(query: unknown): { bang: string | null; rest: string } {
  const value = String(query || '').trim()
  const match = /^!([a-zA-Z0-9-]+)(?:\s+(.*))?$/.exec(value)
  if (!match) return { bang: null, rest: value }
  return { bang: match[1], rest: match[2] || '' }
}

export function encodeQuery(query: unknown): string {
  return encodeURIComponent(String(query || ''))
}

export function fillEngineTemplate(template: unknown, query: unknown): string {
  const value = String(template || '')
  const encoded = encodeQuery(query)
  if (!value) return encoded
  if (value.includes('{query}')) return value.replace('{query}', encoded)
  if (value.includes('{}')) return value.replace('{}', encoded)
  const separator = value.includes('?') ? '&' : '?'
  return `${value}${separator}q=${encoded}`
}

export function dedupeByUrl<T>(
  items: readonly T[] | null | undefined,
  getUrl: (item: T) => unknown = (item) => (item as { url?: unknown } | null)?.url
): T[] {
  const seen = new Set<unknown>()
  const output: T[] = []
  for (const item of items || []) {
    const key = getUrl(item)
    if (key == null || seen.has(key)) continue
    seen.add(key)
    output.push(item)
  }
  return output
}

export function rankByQuery<T>(
  query: unknown,
  candidates: readonly T[] | null | undefined,
  getText: (item: T) => unknown = (item) => {
    const candidate = item as { title?: unknown; text?: unknown } | null
    return candidate?.title || candidate?.text || ''
  }
): T[] {
  const needle = normalizeQuery(query).toLowerCase()
  const ranked: Array<{ score: number; item: T }> = []
  const rest: T[] = []

  for (const item of candidates || []) {
    const text = String(getText(item) || '').toLowerCase()
    const score = needle && text.startsWith(needle) ? 3 : needle && text.includes(needle) ? 2 : 0
    if (score > 0) ranked.push({ score, item })
    else rest.push(item)
  }

  ranked.sort((left, right) => right.score - left.score)
  return [...ranked.map((entry) => entry.item), ...rest]
}

export function trimHistory<T>(history: readonly T[] | null | undefined, limit: number): T[] {
  const count = Number.isFinite(limit) && limit > 0 ? Math.floor(limit) : 0
  return Array.isArray(history) ? history.slice(0, count) : []
}

export function shortUrl(url: unknown): string {
  if (!url) return ''
  return String(url)
    .replace(/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//, '')
    .split('/')[0]
}

export function matchSnippet(query: unknown, url: unknown, max = 60): string {
  const needle = normalizeQuery(query).toLowerCase()
  const value = String(url || '').replace(/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//, '')
  if (!needle || !value) return ''

  const at = value.toLowerCase().indexOf(needle)
  if (at < 0) return ''

  const width = Math.max(1, Math.floor(Number(max) || 60))
  const half = Math.max(8, Math.floor((width - needle.length) / 2))
  const start = Math.max(0, at - half)
  const end = Math.min(value.length, at + needle.length + half)
  return `${start > 0 ? '…' : ''}${value.slice(start, end)}${end < value.length ? '…' : ''}`
}
