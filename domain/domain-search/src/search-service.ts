import { listBangs } from '@hira-ng/shared-types/src/commands.mjs'
import { buildSearchUrl as composeSearchUrl } from '@hira-ng/shared-types/src/search-url.mjs'
import {
  DEFAULT_SEARCH_ENGINE,
  DEFAULT_SEARCH_TEMPLATE,
  SEARCH_ENGINE_LABELS,
  SEARCH_ENGINE_TEMPLATES,
  listSearchEngines
} from '@hira-ng/shared-types/src/search-engines.mjs'
import {
  createBookmarkProvider,
  createHistoryProvider,
  createOpenTabProvider
} from './providers'
import { createSuggestionProviderRegistry } from './provider-registry'
import { createCustomBangStore } from './custom-bangs'
import { createCustomEngineStore } from './custom-engines'
import { createDrizzleSearchHistoryRepository } from './drizzle-search-history-repository'
import { createSearchHistoryStore } from './search-history-store'
import type {
  BangRecord,
  CustomEntry,
  CustomEntrySaveInput,
  CustomEntrySaveResult,
  SearchConfig,
  SearchDatabase,
  SearchEngineDescriptor,
  SearchHistorySuggestion,
  SearchOptions,
  SearchService,
  SearchServiceOptions,
  SearchSuggestionProvider,
  Suggestion
} from './types'

const DEFAULT_BANGS = listBangs() as BangRecord[]

function finalizeSuggestions(suggestions: readonly Suggestion[], limit: number): Suggestion[] {
  const seen = new Set<string>()
  return suggestions
    .map((suggestion) => ({
      ...suggestion,
      relevance: Number.isFinite(Number(suggestion.relevance)) ? Number(suggestion.relevance) : 0
    }))
    .sort((left, right) => right.relevance - left.relevance)
    .filter((suggestion) => {
      const key = String(suggestion.url || suggestion.query || suggestion.title || '')
      if (seen.has(key)) return false
      seen.add(key)
      return true
    })
    .slice(0, limit)
}

/**
 * Search domain facade. Storage and source aggregation are injected ports so
 * every future source can register without editing this function.
 */
export function createSearchService(
  db: SearchDatabase,
  options: SearchServiceOptions = {}
): SearchService {
  const profileId = options.profileId || 'default'
  const now = options.now || Date.now
  const historyService = options.historyService || null
  const bookmarkService = options.bookmarkService || null
  const tabManager = options.tabManager || null
  let defaultSearchEngine = options.defaultSearchEngine || DEFAULT_SEARCH_ENGINE

  const customBangStore = options.customBangStore || createCustomBangStore(db, { profileId })
  const customEngineStore = options.customEngineStore || createCustomEngineStore(db, { profileId })
  const searchHistoryStore = options.searchHistoryStore || createSearchHistoryStore(
    createDrizzleSearchHistoryRepository(db),
    { profileId, createId: options.createId, now }
  )
  const providerRegistry = createSuggestionProviderRegistry([
    createHistoryProvider(historyService),
    createBookmarkProvider(bookmarkService),
    createOpenTabProvider(tabManager),
    ...(options.suggestionProviders || [])
  ])
  const engineTemplateOverrides = new Map<string, string>()

  let templateCache = ''

  function resolveTemplate(name: string): string {
    const key = String(name == null ? '' : name).trim()
    if (key && engineTemplateOverrides.has(key)) return engineTemplateOverrides.get(key) || DEFAULT_SEARCH_TEMPLATE
    if (key && SEARCH_ENGINE_TEMPLATES[key]) return SEARCH_ENGINE_TEMPLATES[key]
    const custom = key ? customEngineStore.getById(key) : null
    return custom?.url || DEFAULT_SEARCH_TEMPLATE
  }

  function currentTemplate(): string {
    if (!templateCache) templateCache = resolveTemplate(defaultSearchEngine)
    return templateCache
  }

  function invalidateTemplate(): void {
    templateCache = ''
  }

  function zeroSuggest(limit = 8): Suggestion[] {
    const rows = providerRegistry.collectZero({ query: '', limit, now: now() })
    return finalizeSuggestions(rows, limit)
  }

  function search(query: unknown, searchOptions: SearchOptions = {}): Suggestion[] {
    const {
      limit = 10,
      includeHistory = true,
      includeBookmarks = true,
      includeOpenTabs = true
    } = searchOptions
    const value = String(query ?? '')
    if (!value.trim()) return zeroSuggest(limit)

    const excluded = new Set<string>()
    if (!includeHistory) excluded.add('history')
    if (!includeBookmarks) excluded.add('bookmark')
    if (!includeOpenTabs) excluded.add('open-tab')

    const rows = providerRegistry.collect({ query: value, limit, now: now() }, excluded)
    rows.push({
      type: 'search',
      query: value,
      url: composeSearchUrl(currentTemplate(), value),
      relevance: 501,
      source: defaultSearchEngine
    })
    return finalizeSuggestions(rows, limit)
  }

  function getBangs(): BangRecord[] {
    const builtins = DEFAULT_BANGS.map((bang) => ({ ...bang }))
    const custom = customBangStore.list().map((entry): BangRecord => ({
      t: entry.trigger,
      title: entry.title,
      url: entry.url,
      custom: true,
      id: entry.id,
      hitCount: entry.hitCount,
      showSuggestions: entry.showSuggestions
    }))
    return [...builtins, ...custom]
  }

  function getSearchEngines(): SearchEngineDescriptor[] {
    return listSearchEngines() as SearchEngineDescriptor[]
  }

  function getSearchConfig(): SearchConfig {
    return {
      default: defaultSearchEngine,
      engines: { ...SEARCH_ENGINE_TEMPLATES, ...Object.fromEntries(engineTemplateOverrides) },
      defaultTemplate: currentTemplate(),
      customBangs: customBangStore.list()
    }
  }

  function setSearchEngineUrl(name: unknown, url: unknown): boolean {
    const key = typeof name === 'string' ? name.trim() : ''
    const template = typeof url === 'string' ? url.trim() : ''
    if (!key || !template || !/^https?:\/\//i.test(template)) return false
    if (engineTemplateOverrides.get(key) === template) return false
    engineTemplateOverrides.set(key, template)
    invalidateTemplate()
    return true
  }

  function setDefaultSearchEngine(name: unknown): boolean {
    if (typeof name !== 'string') return false
    const key = name.trim()
    if (!key) return false
    if (!engineTemplateOverrides.has(key) && !SEARCH_ENGINE_TEMPLATES[key] && !customEngineStore.getById(key)) return false
    if (defaultSearchEngine === key) return false
    defaultSearchEngine = key
    invalidateTemplate()
    return true
  }

  function saveCustomEngine(input: CustomEntrySaveInput): CustomEntrySaveResult {
    const result = customEngineStore.save(input)
    invalidateTemplate()
    return result
  }

  function removeCustomEngine(id: unknown): { removed: boolean; defaultReset: boolean } {
    const key = String(id || '')
    const result = customEngineStore.remove(key)
    let defaultReset = false
    if (result.removed && defaultSearchEngine === key) {
      defaultSearchEngine = DEFAULT_SEARCH_ENGINE
      defaultReset = true
    }
    invalidateTemplate()
    return { removed: result.removed, defaultReset }
  }

  function buildSearchUrl(query: unknown): string {
    return composeSearchUrl(currentTemplate(), String(query ?? ''))
  }

  function currentEngineLabel(): string {
    const key = String(defaultSearchEngine || '')
    if (SEARCH_ENGINE_LABELS[key]) return SEARCH_ENGINE_LABELS[key]
    const custom = key ? customEngineStore.getById(key) : null
    if (custom) return custom.title || key
    return SEARCH_ENGINE_LABELS[DEFAULT_SEARCH_ENGINE] || DEFAULT_SEARCH_ENGINE
  }

  function buildSearchLabel(text: unknown, max = 20): string {
    const value = String(text == null ? '' : text)
    const limit = Math.max(1, Number(max) || 20)
    const display = value.length > limit ? `${value.slice(0, limit)}…` : value
    return `使用${currentEngineLabel()}搜索「${display}」`
  }

  function registerSuggestionProvider(provider: SearchSuggestionProvider): () => void {
    return providerRegistry.register(provider)
  }

  return {
    search,
    zeroSuggest,
    searchHistorySuggestions: (query, limit = 10): SearchHistorySuggestion[] => searchHistoryStore.suggest(query, limit),
    recordSearchQuery: (query) => searchHistoryStore.record(query),
    clearSearchHistory: () => searchHistoryStore.clear(),
    removeSearchHistoryEntry: (id) => searchHistoryStore.remove(id),
    getBangs,
    getSearchEngines,
    listCustomBangs: () => customBangStore.list(),
    saveCustomBang: (input) => customBangStore.save(input),
    removeCustomBang: (id) => customBangStore.remove(String(id || '')),
    recordCustomBangUse: (id) => customBangStore.recordUse(String(id || '')),
    listCustomEngines: () => customEngineStore.list(),
    saveCustomEngine,
    removeCustomEngine,
    getSearchConfig,
    setSearchEngineUrl,
    setDefaultSearchEngine,
    buildSearchUrl,
    buildSearchLabel,
    registerSuggestionProvider,
    unregisterSuggestionProvider: (id) => providerRegistry.unregister(id)
  }
}
