import { canonicalHistoryUrl, generateId } from '@hira-ng/shared-utils'
import { isHttpUrl } from '@hira-ng/shared-types/src/url-protocols.mjs'
import { createDrizzleHistoryRepository } from './drizzle-history-repository'
import { createDrizzlePageTextRepository } from './drizzle-page-text-repository'
import { groupByDay, normalizeHistoryTransition } from './history-utils'
import type {
  AddHistoryVisitInput,
  BackfillHistoryFaviconInput,
  HistoryChange,
  HistoryChangeListener,
  HistoryCountVisitsOptions,
  HistoryDatabase,
  HistoryEntry,
  HistoryListVisitsOptions,
  HistorySearchEntry,
  HistoryService,
  HistoryServiceOptions,
  HistoryVisitPage,
  ImportHistoryResult,
  ImportHistoryVisitInput,
  NormalizedHistoryVisit,
  NormalizedImportVisit,
  NormalizedPageText,
  SaveHistoryPageTextInput,
  UpdateHistoryTitleInput
} from './types'

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object'
}

/**
 * History domain facade.
 *
 * The database is the default adapter, not a dependency of the use-cases. A
 * plugin may inject independent history and page-text repositories through the
 * public options without changing this orchestration layer.
 */
export function createHistoryService(
  database: HistoryDatabase,
  options: HistoryServiceOptions = {}
): HistoryService {
  const now = options.now || Date.now
  const createId = options.createId || generateId
  const listeners = new Set<HistoryChangeListener>()
  const profileIdPort = typeof options.getProfileId === 'function'
    ? options.getProfileId
    : null
  const historyRepository = options.historyRepository || createDrizzleHistoryRepository(
    database,
    { createId }
  )
  const pageTextRepository = options.pageTextRepository || createDrizzlePageTextRepository(
    database,
    { ftsEnabled: Boolean(options.hasFts) }
  )

  function currentProfile(): string {
    if (!profileIdPort) return 'default'
    try {
      const value = profileIdPort()
      return value ? String(value) : 'default'
    } catch {
      return 'default'
    }
  }

  function emit(change: HistoryChange): void {
    for (const listener of listeners) {
      try {
        listener(change)
      } catch {
        // A panel observer must never break a successful persistence operation.
      }
    }
  }

  function subscribe(listener: HistoryChangeListener): () => boolean {
    if (typeof listener !== 'function') return () => false
    listeners.add(listener)
    return () => listeners.delete(listener)
  }

  function addVisit(input: AddHistoryVisitInput | null | undefined): string | null {
    if (!input || !input.url) return null
    const url = canonicalHistoryUrl(input.url)
    if (!url) return null
    const visit: NormalizedHistoryVisit = {
      url,
      title: input.title == null ? null : String(input.title),
      favicon: input.favicon == null ? null : String(input.favicon),
      transition: normalizeHistoryTransition(input.transition),
      visitedAt: now()
    }
    const historyId = historyRepository.addVisit(currentProfile(), visit)
    emit({ action: 'add', count: 1, id: historyId, url })
    return historyId
  }

  function importVisits(
    items: readonly ImportHistoryVisitInput[] | null | undefined
  ): ImportHistoryResult {
    if (!Array.isArray(items) || items.length === 0) return { imported: 0, skipped: 0 }

    const accepted: NormalizedImportVisit[] = []
    const seen = new Set<string>()
    let skipped = 0
    for (const item of items) {
      if (!isObject(item)) {
        skipped += 1
        continue
      }
      const url = canonicalHistoryUrl(String(item.url ?? ''))
      const visitedAt = Math.round(Number(item.visitedAt))
      if (!isHttpUrl(url) || !Number.isFinite(visitedAt) || visitedAt <= 0) {
        skipped += 1
        continue
      }
      const key = `${url}\u0000${visitedAt}`
      if (seen.has(key)) {
        skipped += 1
        continue
      }
      seen.add(key)
      accepted.push({
        url,
        visitedAt,
        title: String(item.title || '').trim() || null,
        transition: normalizeHistoryTransition(item.transition),
        favicon: typeof item.favicon === 'string' && item.favicon ? item.favicon : null
      })
    }
    if (accepted.length === 0) return { imported: 0, skipped }

    try {
      const result = historyRepository.importVisits(currentProfile(), accepted)
      const total = { imported: result.imported, skipped: skipped + result.skipped }
      if (total.imported > 0) emit({ action: 'import', count: total.imported })
      return total
    } catch (error) {
      console.error('[history-service] importVisits failed:', error)
      return { imported: 0, skipped, error: errorMessage(error) }
    }
  }

  function backfillFavicons(
    entries: readonly BackfillHistoryFaviconInput[] | null | undefined
  ): number {
    const normalized = (entries || [])
      .filter((entry): entry is { url: unknown; favicon: unknown } => Boolean(entry?.url && entry?.favicon))
      .map((entry) => ({ url: String(entry.url), favicon: String(entry.favicon) }))
    if (normalized.length === 0) return 0

    try {
      const updated = historyRepository.backfillFavicons(currentProfile(), normalized)
      if (updated > 0) emit({ action: 'import', count: updated })
      return updated
    } catch (error) {
      console.error('[history-service] backfillFavicons failed:', error)
      return 0
    }
  }

  function updateTitle(input: UpdateHistoryTitleInput | null | undefined): boolean {
    if (!input?.url || !input.title) return false
    const url = canonicalHistoryUrl(String(input.url))
    if (!url) return false
    try {
      const updated = historyRepository.updateTitle(currentProfile(), url, String(input.title))
      if (updated > 0) emit({ action: 'update-title', count: updated, url })
      return updated > 0
    } catch (error) {
      console.error('[history-service] updateTitle failed:', error)
      return false
    }
  }

  function search(query: string, limit = 50): HistorySearchEntry[] {
    const normalizedLimit = Math.max(1, Number(limit) || 50)
    const profileId = currentProfile()
    const titleRows = historyRepository.searchText(profileId, String(query ?? ''), normalizedLimit)
    const body = pageTextRepository.search(profileId, String(query ?? ''), normalizedLimit)
    if (body.length === 0) return titleRows

    const snippetByUrl = new Map(body.map((hit) => [hit.url, hit.snippet]))
    const seen = new Set(titleRows.map((row) => row.url))
    const extraUrls = body
      .map((hit) => hit.url)
      .filter((url) => url && !seen.has(url))
    const extraRows = historyRepository.findByUrls(profileId, extraUrls, normalizedLimit)
    const merged = new Map<string, HistoryEntry>()
    for (const row of titleRows) merged.set(row.id, row)
    for (const row of extraRows) if (!merged.has(row.id)) merged.set(row.id, row)

    return [...merged.values()]
      .map((row): HistorySearchEntry => (
        snippetByUrl.has(row.url) ? { ...row, snippet: snippetByUrl.get(row.url) } : row
      ))
      .sort((left, right) => right.lastVisitAt - left.lastVisitAt)
      .slice(0, normalizedLimit)
  }

  function savePageTexts(
    list: readonly SaveHistoryPageTextInput[] | null | undefined
  ): number {
    if (!Array.isArray(list) || list.length === 0) return 0
    const profileId = currentProfile()
    const timestamp = now()
    const records: NormalizedPageText[] = []
    for (const input of list) {
      if (!isObject(input) || !input.url) continue
      const url = canonicalHistoryUrl(String(input.url))
      const text = input.text ? String(input.text) : ''
      if (!url || text.length < 1) continue
      records.push({
        id: createId('pt'),
        profileId,
        url,
        title: input.title ? String(input.title) : null,
        text,
        updatedAt: timestamp
      })
    }
    return pageTextRepository.savePageTexts(records)
  }

  function savePageText(input: SaveHistoryPageTextInput = {}): boolean {
    return savePageTexts([input]) > 0
  }

  function listRecent(limit = 100): HistoryEntry[] {
    return historyRepository.listRecent(currentProfile(), Number(limit) || 100)
  }

  function queryRange(fromTs: number, toTs: number, limit = 100): HistoryEntry[] {
    return historyRepository.queryRange(
      currentProfile(),
      Number(fromTs),
      Number(toTs),
      Number(limit) || 100
    )
  }

  function listVisits(options: HistoryListVisitsOptions = {}): HistoryVisitPage {
    const url = options.url ? canonicalHistoryUrl(options.url) : undefined
    return historyRepository.listVisits(currentProfile(), { ...options, url })
  }

  function countVisits(options: HistoryCountVisitsOptions = {}): number {
    const url = options.url ? canonicalHistoryUrl(options.url) : undefined
    return historyRepository.countVisits(currentProfile(), { ...options, url })
  }

  function remove(id: string): boolean {
    if (!id) return false
    const result = historyRepository.remove(currentProfile(), id)
    pageTextRepository.prune(currentProfile())
    if (result.deleted > 0) {
      emit({ action: 'remove', count: result.deleted, id, url: result.url })
    }
    return result.deleted > 0
  }

  function removeMany(ids: readonly string[] | null | undefined): number {
    const uniqueIds = [...new Set(ids || [])].filter(Boolean)
    if (uniqueIds.length === 0) return 0
    const result = historyRepository.removeMany(currentProfile(), uniqueIds)
    pageTextRepository.prune(currentProfile())
    if (result.deleted > 0) {
      emit({ action: 'remove-many', count: result.deleted, urls: result.urls })
    }
    return result.deleted
  }

  function removeBefore(beforeTs: number): number {
    const deleted = historyRepository.removeBefore(currentProfile(), Number(beforeTs))
    pageTextRepository.prune(currentProfile())
    if (deleted > 0) {
      emit({ action: 'remove-before', count: deleted, before: Number(beforeTs) })
    }
    return deleted
  }

  function removeAfter(afterTs: number): number {
    const deleted = historyRepository.removeAfter(currentProfile(), Number(afterTs))
    pageTextRepository.prune(currentProfile())
    if (deleted > 0) {
      emit({ action: 'remove-after', count: deleted, after: Number(afterTs) })
    }
    return deleted
  }

  function clearAll(): number {
    const deleted = historyRepository.clearAll(currentProfile())
    pageTextRepository.prune(currentProfile())
    if (deleted > 0) emit({ action: 'clear', count: deleted })
    return deleted
  }

  function compactHistory() {
    const result = historyRepository.compactHistory(currentProfile())
    if (result.removed > 0) pageTextRepository.prune(currentProfile())
    if (result.removed > 0 || result.dedupedVisits > 0) {
      emit({ action: 'compact', count: result.removed })
    }
    return result
  }

  return {
    addVisit,
    importVisits,
    backfillFavicons,
    updateTitle,
    search,
    savePageText,
    savePageTexts,
    listRecent,
    queryRange,
    listVisits,
    countVisits,
    remove,
    removeMany,
    removeBefore,
    removeAfter,
    clearAll,
    compactHistory,
    subscribe,
    groupByDay
  }
}
