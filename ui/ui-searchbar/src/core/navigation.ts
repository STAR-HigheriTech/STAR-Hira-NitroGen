import type { Suggestion } from '../types'
import { suggestionField } from './suggestion-field'

export type SearchUrlBuilder = (query: string) => string
export type VerbatimTarget =
  | { kind: 'url'; url: string }
  | { kind: 'search'; url: string; query: string }

export function suggestionToUrl(suggestion: Suggestion, searchUrl: SearchUrlBuilder): string {
  if (suggestion.type === 'open-tab') return suggestionField(suggestion, 'url')
  if (suggestion.type === 'calc') return searchUrl(suggestionField(suggestion, 'result'))
  if (suggestion.type === 'instant-answer') {
    return suggestionField(suggestion, 'url') || searchUrl(suggestionField(suggestion, 'query'))
  }
  if (suggestion.type === 'search' || suggestion.type === 'search-history') {
    return suggestionField(suggestion, 'url') || searchUrl(suggestionField(suggestion, 'query'))
  }
  return suggestionField(suggestion, 'url')
}

const SCHEME = /^[a-z][a-z0-9+.-]*:\/\//i
const SPECIAL_SCHEME = /^(about|blob|data|javascript|mailto|tel|ftp):/i
const WINDOWS_PATH = /^[a-zA-Z]:[\\/]/
const DOMAIN = /^[a-z0-9-]+(\.[a-z0-9-]+)+(:\d+)?(\/.*)?$/i
const LOCALHOST = /^(localhost|127\.0\.0\.1|\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})(:\d+)?(\/.*)?$/

export function resolveVerbatimTarget(
  raw: string,
  searchUrl: SearchUrlBuilder
): VerbatimTarget | null {
  const query = String(raw ?? '').trim()
  if (!query) return null

  const hasScheme = SCHEME.test(query) || SPECIAL_SCHEME.test(query)
  const isWindowsPath = WINDOWS_PATH.test(query)
  const isPosixPath = query.startsWith('/') || query.startsWith('~')
  const isDomain = DOMAIN.test(query)
  const isLocalhost = LOCALHOST.test(query)

  if (hasScheme || isWindowsPath || isPosixPath) return { kind: 'url', url: query }
  if (isDomain || isLocalhost) return { kind: 'url', url: `https://${query}` }
  return { kind: 'search', query, url: searchUrl(query) }
}
