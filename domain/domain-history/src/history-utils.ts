/**
 * Domain: History — dependency-free view and matching primitives.
 */

import type {
  HistoryDayBuckets,
  HistoryDayGroup,
  HistoryDayModel,
  HistoryTemporal,
  HistoryTransition
} from './types'

const DAY_MS = 24 * 60 * 60 * 1000

export function hostOfUrl(url: unknown): string {
  const value = String(url || '')
  const match = /^[a-zA-Z][a-zA-Z0-9+.-]*:\/\/([^/?#]+)/.exec(value)
  return match ? match[1].split(':')[0] : ''
}

export function stripUrl(url: unknown): string {
  return String(url || '').split('?')[0].split('#')[0]
}

export function normalizeHistoryTransition(value: unknown): HistoryTransition {
  const normalized = String(value || '').toLowerCase()
  return normalized === 'typed' || normalized === 'reload' || normalized === 'auto'
    ? normalized
    : 'link'
}

export function coalesceByUrl<T extends HistoryTemporal>(
  entries: readonly T[] | null | undefined,
  getUrl?: ((entry: T) => unknown) | null
): T[] {
  const grouped = new Map<string, T>()
  for (const entry of entries || []) {
    const key = stripUrl(getUrl ? getUrl(entry) : entry.url)
    if (!key) continue
    const current = grouped.get(key)
    if (!current) {
      grouped.set(key, entry)
      continue
    }
    grouped.set(key, {
      ...current,
      visitCount: Number(current.visitCount || 0) + Number(entry.visitCount || 0)
    })
  }
  return [...grouped.values()]
}

export function dayBucketLabel(ts?: number | null, nowTs?: number | null): '今天' | '昨天' | '更早' {
  const timestamp = ts == null ? 0 : Number(ts)
  const now = nowTs == null ? Date.now() : Number(nowTs)
  const date = new Date(now)
  date.setHours(0, 0, 0, 0)
  const today = date.getTime()
  if (timestamp >= today) return '今天'
  if (timestamp >= today - DAY_MS) return '昨天'
  return '更早'
}

export function relativeTimeLabel(ts?: number | null, nowTs?: number | null): string {
  const timestamp = ts == null ? 0 : Number(ts)
  const now = nowTs == null ? Date.now() : Number(nowTs)
  const diff = now - timestamp
  if (diff < 0) return '刚刚'
  const minutes = Math.floor(diff / 60_000)
  if (minutes < 1) return '刚刚'
  if (minutes < 60) return `${minutes} 分钟前`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours} 小时前`
  const days = Math.floor(hours / 24)
  if (days < 7) return `${days} 天前`
  const bucket = dayBucketLabel(timestamp, now)
  return bucket === '更早' ? new Date(timestamp).toLocaleDateString() : bucket
}

export function scoreMatch(query: unknown, title: unknown, url: unknown): number {
  const wanted = String(query || '').toLowerCase()
  if (!wanted) return 0
  const normalizedTitle = String(title || '').toLowerCase()
  const normalizedUrl = String(url || '').toLowerCase()
  if (normalizedTitle.startsWith(wanted) || normalizedUrl.startsWith(wanted)) return 3
  if (normalizedTitle.includes(wanted) || normalizedUrl.includes(wanted)) return 2
  return hostOfUrl(normalizedUrl).includes(wanted) ? 1 : 0
}

export function sortByRelevance<T extends HistoryTemporal>(
  query: unknown,
  entries: readonly T[] | null | undefined,
  getText?: ((entry: T) => string) | null
): T[] {
  return (entries || [])
    .map((entry) => {
      const text = getText ? getText(entry) : `${entry.title || ''} ${entry.url || ''}`
      const separator = text.indexOf(' ')
      const title = separator >= 0 ? text.slice(0, separator) : text
      const url = separator >= 0 ? text.slice(separator + 1) : ''
      return {
        entry,
        score: scoreMatch(query, title, url),
        lastVisitAt: Number(entry.lastVisitAt || 0)
      }
    })
    .sort((left, right) => right.score - left.score || right.lastVisitAt - left.lastVisitAt)
    .map(({ entry }) => entry)
}

export function groupByDay<T extends HistoryTemporal>(
  entries: readonly T[] | null | undefined,
  getTs?: ((entry: T) => number | null | undefined) | null,
  nowTs?: number
): HistoryDayBuckets<T> {
  const buckets: HistoryDayBuckets<T> = { 今天: [], 昨天: [], 更早: [] }
  for (const entry of entries || []) {
    const timestamp = getTs ? getTs(entry) : entry.lastVisitAt
    buckets[dayBucketLabel(timestamp, nowTs)].push(entry)
  }
  return buckets
}

export function groupByDayModel<T extends HistoryTemporal>(
  entries: readonly T[] | null | undefined,
  getTs?: ((entry: T) => number | null | undefined) | null,
  nowTs?: number
): HistoryDayModel<T> {
  const buckets = groupByDay(entries, getTs, nowTs)
  const groups: HistoryDayGroup<T>[] = [
    { key: 'today', label: '今天', items: buckets['今天'] },
    { key: 'yesterday', label: '昨天', items: buckets['昨天'] },
    { key: 'older', label: '更早', items: buckets['更早'] }
  ]
  return {
    groups: groups.filter((group) => group.items.length > 0),
    total: (entries || []).length
  }
}

export function faviconHintFor(url: unknown): string {
  const value = String(url || '')
  const match = /^(https?):\/\/([^/]+)/.exec(value)
  return match ? `${match[1]}://${match[2].split(':')[0]}/favicon.ico` : ''
}

export function keepLatestUnique<T extends HistoryTemporal>(
  entries: readonly T[] | null | undefined,
  getUrl?: ((entry: T) => unknown) | null
): T[] {
  const latest = new Map<string, T>()
  for (const entry of entries || []) {
    const key = stripUrl(getUrl ? getUrl(entry) : entry.url)
    if (!key) continue
    const previous = latest.get(key)
    if (!previous || Number(entry.lastVisitAt || 0) >= Number(previous.lastVisitAt || 0)) {
      latest.set(key, entry)
    }
  }
  return [...latest.values()]
}
