/**
 * Domain: History — public contracts.
 *
 * Storage, page-text indexing and observers are injected ports. Consumers only
 * depend on this module, so a different persistence engine can be added without
 * changing the service or any UI caller.
 */

export type HistoryTransition = 'link' | 'typed' | 'reload' | 'auto'
export type HistoryDayKey = 'today' | 'yesterday' | 'older'
export type HistoryDayLabel = '今天' | '昨天' | '更早'
export type QueryCondition = unknown
export type QueryValue = Record<string, unknown>

export interface QueryRunResult {
  changes?: number | bigint
}

export interface HistorySelect {
  from(table: unknown): HistorySelect
  where(condition: QueryCondition): HistorySelect
  orderBy(...values: unknown[]): HistorySelect
  limit(limit: number): HistorySelect
  get(): QueryValue | undefined
  all(): QueryValue[]
}

export interface HistoryInsertValues {
  run(): QueryRunResult
  onConflictDoUpdate(config: {
    target: readonly unknown[]
    set: Record<string, unknown>
  }): { run(): QueryRunResult }
}

export interface HistoryDatabase {
  select(selection?: Record<string, unknown>): { from(table: unknown): HistorySelect }
  insert(table: unknown): { values(value: Record<string, unknown>): HistoryInsertValues }
  update(table: unknown): {
    set(value: Record<string, unknown>): {
      where(condition: QueryCondition): { run(): QueryRunResult }
    }
  }
  delete(table: unknown): {
    where(condition: QueryCondition): { run(): QueryRunResult }
  }
  transaction<T>(callback: (tx: HistoryDatabase) => T): T
  all(query: unknown): QueryValue[]
  run(query: unknown): QueryRunResult
}

export interface HistoryEntry {
  id: string
  profileId: string
  url: string
  title: string | null
  favicon: string | null
  visitCount: number
  typedCount: number
  firstVisitAt: number
  lastVisitAt: number
}

export interface HistorySearchEntry extends HistoryEntry {
  snippet?: string | null
}

export interface HistoryVisitEntry {
  id: string
  profileId: string
  historyId: string | null
  url: string
  title: string | null
  transition: HistoryTransition
  visitedAt: number
}

export interface HistoryTemporal {
  lastVisitAt?: number | null
  visitCount?: number | null
  title?: string | null
  url?: string | null
}

export interface HistoryDayBuckets<T> {
  今天: T[]
  昨天: T[]
  更早: T[]
}

export interface HistoryDayGroup<T> {
  key: HistoryDayKey
  label: HistoryDayLabel
  items: T[]
}

export interface HistoryDayModel<T> {
  groups: HistoryDayGroup<T>[]
  total: number
}

export interface AddHistoryVisitInput {
  url: string
  title?: string | null
  favicon?: string | null
  transition?: HistoryTransition | string | null
}

export interface ImportHistoryVisitInput {
  url?: unknown
  title?: unknown
  favicon?: unknown
  transition?: unknown
  visitedAt?: unknown
}

export interface UpdateHistoryTitleInput {
  url?: unknown
  title?: unknown
}

export interface BackfillHistoryFaviconInput {
  url?: unknown
  favicon?: unknown
}

export interface SaveHistoryPageTextInput {
  url?: unknown
  title?: unknown
  text?: unknown
}

export interface NormalizedHistoryVisit {
  url: string
  title: string | null
  favicon: string | null
  transition: HistoryTransition
  visitedAt: number
}

export type NormalizedImportVisit = NormalizedHistoryVisit

export interface NormalizedPageText {
  id: string
  profileId: string
  url: string
  title: string | null
  text: string
  updatedAt: number
}

export interface PageTextSearchHit {
  url: string
  snippet: string | null
}

export interface ImportHistoryResult {
  imported: number
  skipped: number
  error?: string
}

export interface RemoveHistoryResult {
  deleted: number
  url: string | null
}

export interface RemoveManyHistoryResult {
  deleted: number
  urls: string[]
}

export interface CompactHistoryResult {
  removed: number
  merged: number
  dedupedVisits: number
}

export interface HistoryListVisitsOptions {
  historyId?: string
  url?: string
  limit?: number
  before?: number
}

export interface HistoryVisitPage {
  items: HistoryVisitEntry[]
  nextCursor: number | null
}

export interface HistoryCountVisitsOptions {
  historyId?: string
  url?: string
}

export type HistoryChangeAction =
  | 'add'
  | 'import'
  | 'update-title'
  | 'remove'
  | 'remove-many'
  | 'remove-before'
  | 'remove-after'
  | 'clear'
  | 'compact'

export interface HistoryChange {
  action: HistoryChangeAction
  count: number
  id?: string
  url?: string | null
  urls?: string[]
  before?: number
  after?: number
}

export type HistoryChangeListener = (change: HistoryChange) => void
export type HistoryIdFactory = (prefix: string) => string

/**
 * Storage port for aggregate rows and visit logs. Implementations must scope
 * every operation by profileId and keep aggregate + visit writes transactional.
 */
export interface HistoryRepository {
  addVisit(profileId: string, visit: NormalizedHistoryVisit): string
  importVisits(profileId: string, visits: readonly NormalizedImportVisit[]): ImportHistoryResult
  backfillFavicons(
    profileId: string,
    entries: readonly { url: string; favicon: string }[]
  ): number
  updateTitle(profileId: string, url: string, title: string): number
  searchText(profileId: string, query: string, limit: number): HistoryEntry[]
  findByUrls(profileId: string, urls: readonly string[], limit: number): HistoryEntry[]
  listRecent(profileId: string, limit: number): HistoryEntry[]
  queryRange(profileId: string, fromTs: number, toTs: number, limit: number): HistoryEntry[]
  listVisits(profileId: string, options: HistoryListVisitsOptions): HistoryVisitPage
  countVisits(profileId: string, options: HistoryCountVisitsOptions): number
  remove(profileId: string, id: string): RemoveHistoryResult
  removeMany(profileId: string, ids: readonly string[]): RemoveManyHistoryResult
  removeBefore(profileId: string, beforeTs: number): number
  removeAfter(profileId: string, afterTs: number): number
  clearAll(profileId: string): number
  compactHistory(profileId: string): CompactHistoryResult
}

/** Separate port: page text is an optional enhancement, not visit truth. */
export interface PageTextRepository {
  savePageTexts(records: readonly NormalizedPageText[]): number
  search(profileId: string, query: string, limit: number): PageTextSearchHit[]
  prune(profileId: string): void
}

export interface HistoryServiceOptions {
  getProfileId?: () => string
  hasFts?: boolean
  now?: () => number
  createId?: HistoryIdFactory
  historyRepository?: HistoryRepository
  pageTextRepository?: PageTextRepository
}

export interface HistoryService {
  addVisit(input: AddHistoryVisitInput | null | undefined): string | null
  importVisits(items: readonly ImportHistoryVisitInput[] | null | undefined): ImportHistoryResult
  backfillFavicons(entries: readonly BackfillHistoryFaviconInput[] | null | undefined): number
  updateTitle(input: UpdateHistoryTitleInput | null | undefined): boolean
  search(query: string, limit?: number): HistorySearchEntry[]
  savePageText(input?: SaveHistoryPageTextInput): boolean
  savePageTexts(list: readonly SaveHistoryPageTextInput[] | null | undefined): number
  listRecent(limit?: number): HistoryEntry[]
  queryRange(fromTs: number, toTs: number, limit?: number): HistoryEntry[]
  listVisits(options?: HistoryListVisitsOptions): HistoryVisitPage
  countVisits(options?: HistoryCountVisitsOptions): number
  remove(id: string): boolean
  removeMany(ids: readonly string[] | null | undefined): number
  removeBefore(beforeTs: number): number
  removeAfter(afterTs: number): number
  clearAll(): number
  compactHistory(): CompactHistoryResult
  subscribe(listener: HistoryChangeListener): () => boolean
  groupByDay<T extends HistoryTemporal>(
    entries: readonly T[] | null | undefined,
    getTs?: ((entry: T) => number | null | undefined) | null,
    nowTs?: number
  ): HistoryDayBuckets<T>
}
