import type { Suggestor, SuggestorContext, Suggestion } from '../types'

export interface SuggestorPartition {
  fast: Suggestor[]
  slow: Suggestor[]
}

export function partitionSuggestors(
  suggestors: readonly Suggestor[],
  isEnabled: (suggestor: Suggestor) => boolean = () => true
): SuggestorPartition {
  const fast: Suggestor[] = []
  const slow: Suggestor[] = []
  for (const suggestor of suggestors) {
    if (!isEnabled(suggestor)) continue
    ;(suggestor.phase === 'slow' ? slow : fast).push(suggestor)
  }
  return { fast, slow }
}

function isSuggestion(value: unknown): value is Suggestion {
  return !!value && typeof value === 'object' && typeof (value as { type?: unknown }).type === 'string'
}

/** Run a phase concurrently. A broken plugin is isolated to its own result. */
export async function collectSuggestions(
  suggestors: readonly Suggestor[],
  context: SuggestorContext
): Promise<Suggestion[]> {
  if (suggestors.length === 0) return []
  const groups = await Promise.all(suggestors.map(async (suggestor) => {
    try {
      const result = await suggestor(context)
      return Array.isArray(result) ? result.filter(isSuggestion) : []
    } catch {
      return []
    }
  }))
  return groups.flat()
}
