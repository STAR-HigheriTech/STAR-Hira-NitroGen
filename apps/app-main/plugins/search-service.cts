/**
 * Search 域插件 —— 声明式能力表（kernel 机制见 infra-plugin/service-plugin.js）。
 */
import { createServicePlugin } from '@hira-ng/infra-plugin'
import type { SearchInputs, SearchService } from './service-contracts'

module.exports = createServicePlugin<SearchService, SearchInputs>({
  domain: 'search',
  serviceName: 'searchService',
  capabilities: {
    'search.search': (svc, input) => svc.search(input.query, { limit: input?.limit }),
    'search.searchHistorySuggestions': (svc, input) => svc.searchHistorySuggestions(input.query, input?.limit),
    'search.recordSearchQuery': (svc, input) => svc.recordSearchQuery(input.query),
    'search.removeSearchHistoryEntry': (svc, input) => svc.removeSearchHistoryEntry(input.id),
    'search.clearSearchHistory': (svc) => svc.clearSearchHistory(),
    'search.getBangs': (svc) => svc.getBangs(),
    'search.getSearchEngines': (svc) => svc.getSearchEngines(),
    'search.getSearchConfig': (svc) => svc.getSearchConfig()
  }
})
