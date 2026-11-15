import type { Suggestion } from '../types'

/** Read extension-owned fields without narrowing the full suggestion union at every call site. */
export function suggestionField(suggestion: Suggestion | null | undefined, key: string): string {
  if (!suggestion) return ''
  const value = (suggestion as unknown as Record<string, unknown>)[key]
  return typeof value === 'string' ? value : ''
}
