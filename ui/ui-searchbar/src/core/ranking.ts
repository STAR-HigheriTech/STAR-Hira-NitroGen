import type { Suggestion } from '../types'
import { suggestionField } from './suggestion-field'

export const MAX_SUGGESTIONS = 8
export const MAX_BANG_SUGGESTIONS = 80

const DEFAULT_TIER = 0
const RECORD_TIER = 2
const RECORD_SOURCES = new Set(['history', 'bookmark'])
const SUGGESTION_TIERS: Readonly<Record<string, number>> = Object.freeze({
  'ai-ask': 1,
  'search-history': 3,
  'dev-mode': 4
})

export function selectionKey(suggestion: Suggestion | null | undefined): string {
  if (!suggestion) return ''
  return suggestionField(suggestion, 'id') ||
    `${suggestion.type}:${suggestionField(suggestion, 'url') || suggestionField(suggestion, 'query') || suggestionField(suggestion, 'title')}`
}

export function sameSuggestion(a: Suggestion | undefined, b: Suggestion | undefined): boolean {
  if (!a || !b) return a === b
  return a.type === b.type &&
    selectionKey(a) === selectionKey(b) &&
    suggestionField(a, 'title') === suggestionField(b, 'title') &&
    suggestionField(a, 'favicon') === suggestionField(b, 'favicon') &&
    suggestionField(a, 'matchField') === suggestionField(b, 'matchField') &&
    suggestionField(a, 'urlMatch') === suggestionField(b, 'urlMatch')
}

export function sameSuggestionList(a: readonly Suggestion[], b: readonly Suggestion[]): boolean {
  if (a.length !== b.length) return false
  for (let index = 0; index < a.length; index += 1) {
    if (!sameSuggestion(a[index], b[index])) return false
  }
  return true
}

export function suggestionTier(suggestion: Suggestion): number {
  const declared = SUGGESTION_TIERS[suggestion.type]
  if (declared !== undefined) return declared
  return RECORD_SOURCES.has(suggestion.source || '') ? RECORD_TIER : DEFAULT_TIER
}

/** Stable ranking: semantic tier first, source-owned relevance second. */
export function mergeSuggestions(groups: readonly Suggestion[][], query: string): Suggestion[] {
  const bangMode = query.trim().startsWith('!')
  const limit = bangMode ? MAX_BANG_SUGGESTIONS : MAX_SUGGESTIONS
  const ranked = groups.flat()
    .sort((a, b) => suggestionTier(a) - suggestionTier(b) || (b.relevance || 0) - (a.relevance || 0))
  const bounded = ranked.slice(0, limit)

  if (!bangMode && bounded.length === limit) {
    const ai = ranked.find((suggestion) => suggestionTier(suggestion) === 1)
    if (ai && !bounded.includes(ai)) bounded[limit - 1] = ai
  }
  return bounded
}
