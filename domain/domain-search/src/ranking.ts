import type { HistoryRecord, MatchMeta } from './types'
import { matchSnippet, normalizeQuery } from './searchUtil'

export const HOUR = 3_600_000
export const DAY = 24 * HOUR
export const WEEK = 7 * DAY

/** RT quick-history scoring, kept on the same 0..690 scale as every source. */
export function historyRelevance(query: string, row: HistoryRecord, now: number): number {
  const needle = String(query || '').toLowerCase()
  const url = String(row.url || '').toLowerCase()
  const title = String(row.title || '').toLowerCase()
  const tier = url.startsWith(needle)
    ? 320
    : title.startsWith(needle)
      ? 260
      : url.includes(needle)
        ? 180
        : 120
  const typed = Math.min(Number(row.typedCount || 0) * 12, 180)
  const visits = Math.min(Number(row.visitCount || 0) * 3, 120)
  const age = Math.max(0, now - Number(row.lastVisitAt || 0))
  const recency = age < HOUR ? 140 : age < DAY ? 100 : age < WEEK ? 60 : 20

  let hostBonus = 0
  try {
    const hostname = new URL(row.url).hostname.replace(/^www\./, '')
    if (hostname.startsWith(needle)) hostBonus = 40
  } catch {
    // Malformed history rows still participate through title/URL scoring.
  }

  const titleBonus = title.startsWith(needle) ? 30 : 0
  return Math.min(690, 300 + tier + typed + visits + recency + hostBonus + titleBonus)
}

export function matchMeta(query: unknown, title: unknown, url: unknown): MatchMeta {
  const needle = normalizeQuery(query).toLowerCase()
  if (!needle) return {}
  if (String(url || '').toLowerCase().includes(needle)) {
    return { matchField: 'url', urlMatch: matchSnippet(query, url) }
  }
  if (String(title || '').toLowerCase().includes(needle)) return { matchField: 'title' }
  return {}
}

export function openTabRelevance(query: string, title: string, url: string): number {
  const needle = query.toLowerCase()
  const normalizedTitle = title.toLowerCase()
  const normalizedUrl = url.toLowerCase()
  if (normalizedTitle.startsWith(needle)) return 500
  if (normalizedTitle.includes(needle)) return 420
  if (normalizedUrl.includes(needle)) return 340
  return 0
}

export function zeroHistoryRelevance(row: HistoryRecord, now: number): number {
  const typed = Math.min(Number(row.typedCount || 0) * 18, 250)
  const visits = Math.min(Number(row.visitCount || 0) * 4, 180)
  const age = Math.max(0, now - Number(row.lastVisitAt || 0))
  const recency = age < HOUR ? 210 : age < DAY ? 170 : age < WEEK ? 115 : 35
  return Math.min(760, 240 + typed + visits + recency)
}

export function searchHistoryRelevance(row: { hitCount?: number; lastUsedAt?: number }, now: number): number {
  const hits = Math.min(Number(row.hitCount || 0) * 15, 180)
  const fresh = now - Number(row.lastUsedAt || 0) < DAY ? 120 : 0
  return Math.min(680, 320 + hits + fresh)
}
