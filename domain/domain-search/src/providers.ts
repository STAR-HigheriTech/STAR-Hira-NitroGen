import {
  historyRelevance,
  matchMeta,
  openTabRelevance,
  zeroHistoryRelevance
} from './ranking'
import { shortUrl } from './searchUtil'
import type {
  BookmarkServicePort,
  HistoryServicePort,
  OpenTabRecord,
  SearchSuggestionProvider,
  Suggestion,
  TabManagerPort
} from './types'

function validUrl(url: unknown): url is string {
  return typeof url === 'string' && Boolean(url) && url !== 'about:blank'
}

export function createHistoryProvider(service: HistoryServicePort | null): SearchSuggestionProvider {
  return {
    id: 'history',
    search({ query, limit, now }) {
      const rows = service?.search(query, Math.ceil(limit * 1.5)) || []
      return rows.filter((row) => validUrl(row.url)).map((row): Suggestion => ({
        type: 'website',
        title: row.title || row.url,
        url: row.url,
        displayUrl: shortUrl(row.url),
        favicon: row.favicon || '',
        ...matchMeta(query, row.title || row.url, row.url),
        historyId: row.id,
        relevance: historyRelevance(query, row, now),
        source: 'history'
      }))
    },
    zeroSuggest({ now }) {
      if (typeof service?.listRecent !== 'function') return []
      return service.listRecent(12)
        .filter((row) => validUrl(row.url))
        .slice(0, 5)
        .map((row): Suggestion => ({
          type: 'website',
          title: row.title || row.url,
          url: row.url,
          displayUrl: shortUrl(row.url),
          favicon: row.favicon || '',
          historyId: row.id,
          relevance: zeroHistoryRelevance(row, now),
          source: 'history'
        }))
    }
  }
}

export function createBookmarkProvider(service: BookmarkServicePort | null): SearchSuggestionProvider {
  return {
    id: 'bookmark',
    search({ query, now }) {
      const rows = service?.search(query) || []
      return rows.filter((row) => validUrl(row.url)).map((row): Suggestion => ({
        type: 'website',
        title: row.title || row.url,
        url: row.url,
        displayUrl: shortUrl(row.url),
        favicon: row.favicon || '',
        ...matchMeta(query, row.title || row.url, row.url),
        relevance: Math.min(700, historyRelevance(query, row, now) + 60),
        source: 'bookmark'
      }))
    }
  }
}

function orderTabs(tabs: readonly OpenTabRecord[], activeId: string): readonly OpenTabRecord[] {
  if (!activeId) return tabs
  return [
    ...tabs.filter((tab) => String(tab.tabId) === activeId),
    ...tabs.filter((tab) => String(tab.tabId) !== activeId)
  ]
}

export function createOpenTabProvider(manager: TabManagerPort | null): SearchSuggestionProvider {
  return {
    id: 'open-tab',
    search({ query }) {
      const rows = manager?.list() || []
      return rows.flatMap((tab): Suggestion[] => {
        if (!validUrl(tab.url)) return []
        const title = tab.title || tab.url
        const relevance = openTabRelevance(query, title, tab.url)
        if (!relevance) return []
        return [{
          type: 'open-tab',
          tabId: tab.tabId,
          title,
          url: tab.url,
          displayUrl: shortUrl(tab.url),
          favicon: tab.favicon || '',
          ...matchMeta(query, title, tab.url),
          relevance,
          source: 'open-tab'
        }]
      })
    },
    zeroSuggest() {
      let activeId = ''
      try {
        activeId = String(manager?.getActiveTabId?.() ?? '')
      } catch {
        // Active-tab lookup is only an ordering hint.
      }
      const tabs = orderTabs(manager?.list() || [], activeId)
      return tabs
        .filter((tab) => validUrl(tab.url))
        .slice(0, 3)
        .map((tab, index): Suggestion => ({
          type: 'open-tab',
          tabId: tab.tabId,
          title: tab.title || tab.url,
          url: tab.url,
          displayUrl: shortUrl(tab.url),
          favicon: tab.favicon || '',
          relevance: Math.max(780, 840 - index * 20),
          source: 'open-tab'
        }))
    }
  }
}
