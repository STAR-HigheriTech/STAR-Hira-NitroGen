import { generateId } from '@hira-ng/shared-utils'
import { searchHistoryRelevance } from './ranking'
import type {
  SearchHistoryRepository,
  SearchHistoryStorageRecord,
  SearchHistoryStore,
  SearchHistoryStoreOptions,
  SearchHistorySuggestion
} from './types'

export function createSearchHistoryStore(
  repository: SearchHistoryRepository,
  options: SearchHistoryStoreOptions = {}
): SearchHistoryStore {
  const profileId = options.profileId || 'default'
  const createId = options.createId || generateId
  const now = options.now || Date.now

  function toSuggestion(row: SearchHistoryStorageRecord, timestamp: number): SearchHistorySuggestion {
    return {
      id: row.id,
      type: 'search-history',
      query: row.queryText,
      hitCount: row.hitCount,
      lastUsedAt: row.lastUsedAt,
      relevance: searchHistoryRelevance(row, timestamp),
      source: 'search-history'
    }
  }

  return {
    suggest(query, limit = 10) {
      if (!query) return []
      const timestamp = now()
      return repository.listMatches(profileId, String(query), limit)
        .map((row) => toSuggestion(row, timestamp))
    },
    record(query) {
      if (!query || !String(query).trim()) return
      const value = String(query)
      const timestamp = now()
      const existing = repository.findByQuery(profileId, value)
      if (existing) {
        repository.incrementHitCount(existing.id, timestamp)
        return
      }
      repository.insert({
        id: createId('sh'),
        profileId,
        queryText: value,
        hitCount: 1,
        lastUsedAt: timestamp
      })
    },
    clear() {
      return repository.clear(profileId)
    },
    remove(id) {
      if (!id) return false
      return repository.remove(profileId, String(id))
    }
  }
}
