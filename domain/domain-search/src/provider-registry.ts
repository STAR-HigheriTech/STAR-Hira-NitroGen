import type {
  SearchSuggestionProvider,
  Suggestion,
  SuggestionProviderContext
} from './types'

export interface SuggestionProviderRegistry {
  register(provider: SearchSuggestionProvider): () => void
  unregister(id: string): boolean
  collect(context: SuggestionProviderContext, excludedIds?: ReadonlySet<string>): Suggestion[]
  collectZero(context: SuggestionProviderContext, excludedIds?: ReadonlySet<string>): Suggestion[]
}

type ProviderMethod = 'search' | 'zeroSuggest'

export function createSuggestionProviderRegistry(
  providers: readonly SearchSuggestionProvider[] = []
): SuggestionProviderRegistry {
  const entries = new Map<string, SearchSuggestionProvider>()

  function register(provider: SearchSuggestionProvider): () => void {
    const id = String(provider?.id || '').trim()
    if (!id) throw new Error('[domain-search] suggestion provider id is required')
    entries.set(id, { ...provider, id })
    return () => entries.delete(id)
  }

  function run(method: ProviderMethod, context: SuggestionProviderContext, excludedIds?: ReadonlySet<string>): Suggestion[] {
    const output: Suggestion[] = []
    for (const provider of entries.values()) {
      if (excludedIds?.has(provider.id)) continue
      const handler = provider[method]
      if (typeof handler !== 'function') continue
      try {
        const rows = handler(context)
        if (Array.isArray(rows)) output.push(...rows)
      } catch {
        // A failing source must never make the omnibox empty.
      }
    }
    return output
  }

  for (const provider of providers) register(provider)

  return {
    register,
    unregister: (id) => entries.delete(id),
    collect: (context, excludedIds) => run('search', context, excludedIds),
    collectZero: (context, excludedIds) => run('zeroSuggest', context, excludedIds)
  }
}
