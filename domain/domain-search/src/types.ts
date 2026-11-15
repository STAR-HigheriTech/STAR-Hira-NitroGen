/**
 * Domain: Search — public contracts.
 *
 * Runtime consumers stay decoupled from implementations through these ports.
 * New suggestion sources can plug into SearchService without changing the
 * aggregation pipeline or any existing source.
 */

export type TabId = string | number
export type MatchField = 'url' | 'title'
export type CustomEntryMode = 'bang' | 'engine'
export type QueryCondition = unknown
export interface QueryRunResult { changes: number }
export interface SearchSelectFrom {
  where(condition: QueryCondition): SearchSelectWhere
  orderBy(...values: unknown[]): SearchSelectOrdered
}
export interface SearchSelectWhere {
  get(): Record<string, unknown> | undefined
  all(): Record<string, unknown>[]
  orderBy(...values: unknown[]): SearchSelectOrdered
}
export interface SearchSelectOrdered {
  all(): Record<string, unknown>[]
  limit(limit: number): { all(): Record<string, unknown>[] }
}
export interface SearchDatabase {
  select(): { from(table: unknown): SearchSelectFrom }
  insert(table: unknown): { values(value: object): { run(): QueryRunResult } }
  update(table: unknown): { set(value: object): { where(condition: QueryCondition): { run(): QueryRunResult } } }
  delete(table: unknown): { where(condition: QueryCondition): { run(): QueryRunResult } }
}

export interface MatchMeta {
  matchField?: MatchField
  urlMatch?: string
}

export interface HistoryRecord {
  id?: string
  url: string
  title?: string | null
  favicon?: string | null
  visitCount?: number | null
  typedCount?: number | null
  lastVisitAt?: number | null
}

export interface BookmarkRecord {
  id?: string
  url: string
  title?: string | null
  favicon?: string | null
  visitCount?: number | null
  typedCount?: number | null
  lastVisitAt?: number | null
}

export interface OpenTabRecord {
  tabId: TabId
  url: string
  title?: string | null
  favicon?: string | null
}

export interface HistoryServicePort {
  search(query: string, limit?: number): readonly HistoryRecord[]
  listRecent?(limit?: number): readonly HistoryRecord[]
}

export interface BookmarkServicePort {
  search(query: string): readonly BookmarkRecord[]
}

export interface TabManagerPort {
  list(): readonly OpenTabRecord[]
  getActiveTabId?(): TabId | null | undefined
}

/**
 * A suggestion is intentionally open-shaped: plugins may add their own fields
 * and `type` without a domain release. Host-only fields are optional here.
 */
export interface Suggestion extends MatchMeta {
  type: string
  relevance: number
  source: string
  id?: string
  title?: string
  url?: string
  query?: string
  tabId?: TabId
  displayUrl?: string
  favicon?: string
  historyId?: string
  action?: string
  hitCount?: number
  lastUsedAt?: number
  custom?: boolean
  bangId?: string
  [key: string]: unknown
}

export type WebsiteSuggestion = Suggestion & {
  type: 'website'
  title: string
  url: string
}

export type OpenTabSuggestion = Suggestion & {
  type: 'open-tab'
  tabId: TabId
  title: string
  url: string
}

export type SearchSuggestion = Suggestion & {
  type: 'search'
  query: string
  url: string
}

export type SearchHistorySuggestion = Suggestion & {
  type: 'search-history'
  id: string
  query: string
  hitCount: number
  lastUsedAt: number
}

export interface SearchOptions {
  limit?: number
  includeHistory?: boolean
  includeBookmarks?: boolean
  includeOpenTabs?: boolean
}

export interface SuggestionProviderContext {
  query: string
  limit: number
  now: number
}

/**
 * Synchronous extension point used by built-ins and plugins alike.
 * Providers own their error handling; the registry isolates failures anyway.
 */
export interface SearchSuggestionProvider {
  id: string
  search?(context: SuggestionProviderContext): readonly Suggestion[]
  zeroSuggest?(context: SuggestionProviderContext): readonly Suggestion[]
}

export interface CustomEntryStorageRecord {
  id: string
  profileId: string
  trigger: string
  title: string
  url: string
  showSuggestions: number
  hitCount: number
  createdAt: number
  updatedAt: number
}

export interface CustomEntryUpdate {
  trigger: string
  title: string
  url: string
  showSuggestions: number
  updatedAt: number
}

export interface CustomEntryRepository {
  list(profileId: string): CustomEntryStorageRecord[]
  findByTrigger(profileId: string, trigger: string): CustomEntryStorageRecord | null
  findById(profileId: string, id: string): CustomEntryStorageRecord | null
  insert(record: CustomEntryStorageRecord): void
  update(profileId: string, id: string, patch: CustomEntryUpdate): void
  remove(profileId: string, id: string): number
  incrementHitCount(profileId: string, id: string): void
}

export interface CustomEntry {
  id: string
  trigger: string
  title: string
  url: string
  showSuggestions: boolean
  hitCount: number
  createdAt: number
  updatedAt: number
}

export interface CustomEntrySaveInput {
  id?: string
  trigger?: string
  title?: string
  url?: string
  showSuggestions?: boolean
}

export type CustomEntrySaveResult =
  | { ok: true; entry: CustomEntry }
  | { ok: false; error: string }

export interface CustomEntryStoreOptions {
  mode: CustomEntryMode
  idPrefix: string
  profileId?: string
  createId?: (prefix: string) => string
  now?: () => number
}

export interface CustomEntryStore {
  list(): CustomEntry[]
  findByTrigger(trigger: string): CustomEntry | null
  getById(id: string): CustomEntry | null
  save(input: CustomEntrySaveInput): CustomEntrySaveResult
  remove(id: string): { removed: boolean }
  recordUse(id: string): { ok: boolean }
}

export interface SearchHistoryStorageRecord {
  id: string
  profileId: string
  queryText: string
  hitCount: number
  lastUsedAt: number
}

export interface SearchHistoryRepository {
  findByQuery(profileId: string, query: string): SearchHistoryStorageRecord | null
  listMatches(profileId: string, query: string, limit: number): SearchHistoryStorageRecord[]
  insert(record: SearchHistoryStorageRecord): void
  incrementHitCount(id: string, lastUsedAt: number): void
  clear(profileId: string): number
  remove(profileId: string, id: string): boolean
}

export interface SearchHistoryStoreOptions {
  profileId?: string
  createId?: (prefix: string) => string
  now?: () => number
}

export interface SearchHistoryStore {
  suggest(query: unknown, limit?: number): SearchHistorySuggestion[]
  record(query: unknown): void
  clear(): number
  remove(id: unknown): boolean
}

export interface BangRecord {
  t: string
  title: string
  url: string
  keys?: string[]
  custom?: boolean
  id?: string
  hitCount?: number
  showSuggestions?: boolean
}

export interface SearchEngineDescriptor {
  name: string
  url: string
  label: string
}

export interface SearchConfig {
  default: string
  engines: Record<string, string>
  defaultTemplate: string
  customBangs: CustomEntry[]
}

export interface SearchServiceOptions {
  historyService?: HistoryServicePort | null
  bookmarkService?: BookmarkServicePort | null
  tabManager?: TabManagerPort | null
  profileId?: string
  defaultSearchEngine?: string
  customBangStore?: CustomEntryStore
  customEngineStore?: CustomEntryStore
  searchHistoryStore?: SearchHistoryStore
  suggestionProviders?: readonly SearchSuggestionProvider[]
  now?: () => number
  createId?: (prefix: string) => string
}

export interface SearchService {
  search(query: unknown, options?: SearchOptions): Suggestion[]
  zeroSuggest(limit?: number): Suggestion[]
  searchHistorySuggestions(query: unknown, limit?: number): SearchHistorySuggestion[]
  recordSearchQuery(query: unknown): void
  clearSearchHistory(): number
  removeSearchHistoryEntry(id: unknown): boolean
  getBangs(): BangRecord[]
  getSearchEngines(): SearchEngineDescriptor[]
  listCustomBangs(): CustomEntry[]
  saveCustomBang(input: CustomEntrySaveInput): CustomEntrySaveResult
  removeCustomBang(id: unknown): { removed: boolean }
  recordCustomBangUse(id: unknown): { ok: boolean }
  listCustomEngines(): CustomEntry[]
  saveCustomEngine(input: CustomEntrySaveInput): CustomEntrySaveResult
  removeCustomEngine(id: unknown): { removed: boolean; defaultReset: boolean }
  getSearchConfig(): SearchConfig
  setSearchEngineUrl(name: unknown, url: unknown): boolean
  setDefaultSearchEngine(name: unknown): boolean
  buildSearchUrl(query: unknown): string
  buildSearchLabel(text: unknown, max?: number): string
  registerSuggestionProvider(provider: SearchSuggestionProvider): () => void
  unregisterSuggestionProvider(id: string): boolean
}
