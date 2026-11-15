// @ts-check
/**
 * Open-tabs suggestor: matches input against currently open tabs.
 */

/**
 * Simple similarity score (0..1) for matching query against a haystack.
 * @param {string} query
 * @param {string} haystack
 */
function similarity(query: string, haystack: string): number {
  if (!query || !haystack) return 0
  const q = query.toLowerCase()
  const h = haystack.toLowerCase()
  if (h.includes(q)) {
    // prefix match is stronger
    if (h.startsWith(q)) return 1
    // word boundary match
    const idx = h.indexOf(q)
    if (idx > 0 && /[\s\-_/.:]/.test(h[idx - 1])) return 0.9
    return 0.7
  }
  // substring overlap
  let matches = 0
  for (const ch of q) {
    if (h.includes(ch)) matches++
  }
  return matches / q.length * 0.4
}

/**
 * @param {import('../types').SuggestorContext} ctx
 * @returns {import('../types').Suggestion[]}
 */
import type { OpenTabSuggestion, SuggestorContext, Suggestion } from '../types'
export function openTabsSuggestor(ctx: SuggestorContext): Suggestion[] {
  const q = ctx.query.trim()
  if (!q) return []
  if (q.length < 2) return []

  const tabs = ctx.getOpenTabs()
  /** @type {Array<import('../types').OpenTabSuggestion>} */
  const results: OpenTabSuggestion[] = []

  for (const tab of tabs) {
    const titleScore = similarity(q, tab.title)
    const urlScore = similarity(q, tab.url)
    const best = Math.max(titleScore, urlScore)
    if (best < 0.3) continue

    // Map similarity 0.3..1.0 to relevance band 300..500
    const relevance = Math.round(300 + (best - 0.3) / 0.7 * 200)
    results.push({
      type: 'open-tab',
      tabId: tab.tabId,
      title: tab.title,
      url: tab.url,
      // 站点图标与本地 website 行同一字段名 —— 浮层一套规则通吃（缺失时按 well-known 兜底）。
      favicon: tab.favicon || '',
      relevance,
      source: 'open-tab'
    })
  }

  // Sort by relevance desc, take top 5
  return results.sort((a, b) => b.relevance - a.relevance).slice(0, 5)
}
