import type { Suggestor } from '../types'

export interface SuggestorRegistry {
  add(suggestor: Suggestor): () => void
  remove(suggestor: Suggestor): boolean
  snapshot(): Suggestor[]
}

/** Ordered plugin registry. Identity is stable and removal invalidates only the matching entry. */
export function createSuggestorRegistry(initial: readonly Suggestor[] = []): SuggestorRegistry {
  const suggestors = [...initial]

  return {
    add(suggestor) {
      if (typeof suggestor !== 'function' || suggestors.includes(suggestor)) return () => {}
      suggestors.push(suggestor)
      let active = true
      return () => {
        if (!active) return
        active = false
        const index = suggestors.indexOf(suggestor)
        if (index >= 0) suggestors.splice(index, 1)
      }
    },
    remove(suggestor) {
      const index = suggestors.indexOf(suggestor)
      if (index < 0) return false
      suggestors.splice(index, 1)
      return true
    },
    snapshot() {
      return [...suggestors]
    }
  }
}
