/**
 * domain-search 单测 —— 真实 SQLite（:memory:）+ Drizzle，零 Electron。
 *
 * 聚合搜索最容易走样的地方不在"能不能搜到"，而在：
 *   1. 任一数据源（历史/书签/标签）抛错时**不能拖垮整份建议**
 *   2. 相同 url 只保留相关性最高的那条，否则地址栏会出现重复项
 *   3. 默认引擎是**可变**的（设置页改完要立刻生效），且未知引擎名不得被静默改回 google
 */
import { describe, it, expect } from 'vitest'
import { createRequire } from 'node:module'
import { createSearchService } from './index.ts'

const require = createRequire(import.meta.url)
const { createDb } = require('@hira-ng/infra-db')

function makeService(options = {}) {
  const { db, close } = createDb(':memory:')
  return { service: createSearchService(db, options), db, close }
}

describe('domain-search · 聚合建议', () => {
  it('空查询 = 零输入建议：给"已打开的标签 + 最近历史"，不走子串搜索', () => {
    const { service, close } = makeService({
      historyService: {
        // 空查询**不该**走子串搜索（那是打扰），只该走 listRecent（最近历史）。
        search: () => { throw new Error('空查询不该走子串搜索') },
        listRecent: () => [{ url: 'https://r.test/', title: 'recent', visitCount: 2, typedCount: 1, lastVisitAt: Date.now() }]
      },
      tabManager: { list: () => [{ tabId: 't1', url: 'https://t.test/', title: 'hira tab' }] }
    })
    try {
      const out = service.search('')
      expect(out.map((s) => s.source).sort()).toEqual(['history', 'open-tab'])
      expect(out.find((s) => s.type === 'open-tab').tabId).toBe('t1')
      // null / 纯空白同样按"空输入"处理
      expect(service.search(null).length).toBeGreaterThan(0)
      expect(service.search('   ').length).toBeGreaterThan(0)
    } finally {
      close()
    }
  })

  it('无任何数据源时仍至少给出默认引擎兜底建议', () => {
    const { service, close } = makeService()
    try {
      const out = service.search('hira')
      expect(out).toHaveLength(1)
      expect(out[0]).toMatchObject({ type: 'search', query: 'hira', source: 'google' })
      expect(out[0].url).toBe('https://www.google.com/search?q=hira')
    } finally {
      close()
    }
  })

  it('聚合历史/书签/打开的标签，且书签权重高于历史', () => {
    const { service, close } = makeService({
      historyService: { search: () => [{ url: 'https://h.test/', title: 'hira history' }] },
      bookmarkService: { search: () => [{ url: 'https://b.test/', title: 'hira bookmark' }] },
      tabManager: { list: () => [{ tabId: 't1', url: 'https://t.test/', title: 'hira tab' }] }
    })
    try {
      const out = service.search('hira')
      const bySource = Object.fromEntries(out.map((s) => [s.source, s]))
      expect(Object.keys(bySource).sort()).toEqual(['bookmark', 'google', 'history', 'open-tab'])
      expect(bySource.bookmark.relevance).toBeGreaterThan(bySource.history.relevance)
      expect(bySource.history.relevance).toBeGreaterThan(bySource['open-tab'].relevance)
      expect(bySource['open-tab'].tabId).toBe('t1')
    } finally {
      close()
    }
  })

  it('单个数据源抛错只丢它自己，其余建议照常产出', () => {
    const { service, close } = makeService({
      historyService: { search: () => { throw new Error('db locked') } },
      bookmarkService: { search: () => [{ url: 'https://b.test/', title: 'hira bookmark' }] },
      tabManager: { list: () => { throw new Error('tab manager down') } }
    })
    try {
      const out = service.search('hira')
      expect(out.map((s) => s.source).sort()).toEqual(['bookmark', 'google'])
    } finally {
      close()
    }
  })

  it('同 url 去重，只保留相关性最高的那条', () => {
    const { service, close } = makeService({
      historyService: { search: () => [{ url: 'https://same.test/', title: 'hira' }] },
      bookmarkService: { search: () => [{ url: 'https://same.test/', title: 'hira' }] }
    })
    try {
      const out = service.search('hira')
      const same = out.filter((s) => s.url === 'https://same.test/')
      expect(same).toHaveLength(1)
      expect(same[0].source).toBe('bookmark')
    } finally {
      close()
    }
  })

  it('include* 开关能逐项关掉数据源', () => {
    const deps = {
      historyService: { search: () => [{ url: 'https://h.test/', title: 'hira' }] },
      bookmarkService: { search: () => [{ url: 'https://b.test/', title: 'hira' }] },
      tabManager: { list: () => [{ tabId: 't1', url: 'https://t.test/', title: 'hira' }] }
    }
    const { service, close } = makeService(deps)
    try {
      const out = service.search('hira', { includeHistory: false, includeBookmarks: false, includeOpenTabs: false })
      expect(out.map((s) => s.source)).toEqual(['google'])
    } finally {
      close()
    }
  })

  it('about:blank 与不匹配的标签不进建议', () => {
    const { service, close } = makeService({
      tabManager: {
        list: () => [
          { tabId: 'blank', url: 'about:blank', title: 'hira' },
          { tabId: 'nomatch', url: 'https://other.test/', title: 'other' },
          { tabId: 'ok', url: 'https://hira.test/', title: '' }
        ]
      }
    })
    try {
      const ids = service.search('hira').filter((s) => s.type === 'open-tab').map((s) => s.tabId)
      expect(ids).toEqual(['ok'])
    } finally {
      close()
    }
  })

  it('! 前缀不再由本服务出 bangs（bangs 唯一提供方是 UI 侧 suggestor）', () => {
    const { service, close } = makeService()
    try {
      const out = service.search('!gh')
      // 本服务只做历史/书签/标签的聚合；bangs（含 `!` 快捷动作）由
      // ui-searchbar/suggestors/bangs.ts 统一产出，避免重复行与错误 URL。
      expect(out.some((s) => String(s.source).startsWith('bang:'))).toBe(false)
    } finally {
      close()
    }
  })

  it('getBangs 仍从共用表列出（search.getBangs provider 出口）', () => {
    const { service, close } = makeService()
    try {
      const list = service.getBangs()
      expect(list.some((b) => b.t === 'gh')).toBe(true)
      expect(list.some((b) => b.t === 'bl')).toBe(true)
    } finally {
      close()
    }
  })

  it('limit 截断最终结果', () => {
    const { service, close } = makeService({
      historyService: {
        search: () => Array.from({ length: 20 }, (_, i) => ({ url: `https://h${i}.test/`, title: `hira ${i}` }))
      }
    })
    try {
      expect(service.search('hira', { limit: 3 })).toHaveLength(3)
    } finally {
      close()
    }
  })
})

describe('domain-search · 搜索框历史', () => {
  it('recordSearchQuery 是 upsert：重复词递增 hitCount 而不新增行', () => {
    const { service, close } = makeService()
    try {
      service.recordSearchQuery('hira')
      service.recordSearchQuery('hira')
      service.recordSearchQuery('other')
      const hits = service.searchHistorySuggestions('hira')
      expect(hits).toHaveLength(1)
      expect(hits[0]).toMatchObject({ type: 'search-history', query: 'hira', hitCount: 2, source: 'search-history' })
      expect(hits[0].id).toBeTruthy()
      expect(hits[0].lastUsedAt).toBeGreaterThan(0)
    } finally {
      close()
    }
  })

  it('空白查询不入库', () => {
    const { service, close } = makeService()
    try {
      service.recordSearchQuery('')
      service.recordSearchQuery('   ')
      service.recordSearchQuery(null)
      expect(service.clearSearchHistory()).toBe(0)
    } finally {
      close()
    }
  })

  it('按 hitCount 倒序排，热词排前面', () => {
    const { service, close } = makeService()
    try {
      service.recordSearchQuery('hira one')
      service.recordSearchQuery('hira two')
      service.recordSearchQuery('hira two')
      expect(service.searchHistorySuggestions('hira').map((s) => s.query)).toEqual(['hira two', 'hira one'])
      expect(service.searchHistorySuggestions('hira', 1).map((s) => s.query)).toEqual(['hira two'])
    } finally {
      close()
    }
  })

  it('空查询词不返回历史建议', () => {
    const { service, close } = makeService()
    try {
      service.recordSearchQuery('hira')
      expect(service.searchHistorySuggestions('')).toEqual([])
    } finally {
      close()
    }
  })

  it('搜索历史按 profile 隔离', () => {
    const { db, close } = createDb(':memory:')
    try {
      const a = createSearchService(db, { profileId: 'default' })
      const b = createSearchService(db, { profileId: 'work' })
      a.recordSearchQuery('hira')
      expect(b.searchHistorySuggestions('hira')).toEqual([])
      expect(b.clearSearchHistory()).toBe(0)
      expect(a.searchHistorySuggestions('hira')).toHaveLength(1)
    } finally {
      close()
    }
  })

  it('removeSearchHistoryEntry 命中才返回 true', () => {
    const { service, db, close } = makeService()
    try {
      service.recordSearchQuery('hira')
      const { searchHistory } = require('@hira-ng/infra-db/schema')
      const [row] = db.select().from(searchHistory).all()
      expect(service.removeSearchHistoryEntry(row.id)).toBe(true)
      expect(service.removeSearchHistoryEntry(row.id)).toBe(false)
      expect(service.removeSearchHistoryEntry('')).toBe(false)
      expect(service.searchHistorySuggestions('hira')).toEqual([])
    } finally {
      close()
    }
  })

  it('clearSearchHistory 返回被删条数', () => {
    const { service, close } = makeService()
    try {
      service.recordSearchQuery('a')
      service.recordSearchQuery('b')
      expect(service.clearSearchHistory()).toBe(2)
      expect(service.clearSearchHistory()).toBe(0)
    } finally {
      close()
    }
  })
})

describe('domain-search · 引擎与 bangs 配置', () => {
  it('getBangs 返回副本，外部改动污染不到内部', () => {
    const { service, close } = makeService()
    try {
      const bangs = service.getBangs()
      expect(bangs.length).toBeGreaterThan(0)
      expect(bangs[0]).toMatchObject({ t: 'g', title: 'Google' })
      bangs.length = 0
      expect(service.getBangs().length).toBeGreaterThan(0)
    } finally {
      close()
    }
  })

  it('getSearchEngines 列出全部内置引擎', () => {
    const { service, close } = makeService()
    try {
      const names = service.getSearchEngines().map((e) => e.name)
      expect(names).toEqual(['google', 'bing', 'baidu', 'duckduckgo', 'yahoo'])
      expect(service.getSearchEngines()[0].url).toContain('google.com')
    } finally {
      close()
    }
  })

  it('getSearchConfig 暴露当前默认引擎且返回的是拷贝', () => {
    const { service, close } = makeService({ defaultSearchEngine: 'bing' })
    try {
      const cfg = service.getSearchConfig()
      expect(cfg.default).toBe('bing')
      cfg.engines.google = 'hacked'
      expect(service.getSearchConfig().engines.google).toBe('https://www.google.com/search?q=')
    } finally {
      close()
    }
  })

  it('setDefaultSearchEngine 立刻影响兜底建议；未知引擎被忽略而非回退 google', () => {
    const { service, close } = makeService()
    try {
      expect(service.setDefaultSearchEngine('bing')).toBe(true)
      expect(service.getSearchConfig().default).toBe('bing')
      expect(service.search('hira').find((s) => s.source === 'bing').url).toContain('bing.com')

      expect(service.setDefaultSearchEngine('bing')).toBe(false)
      expect(service.setDefaultSearchEngine('nope')).toBe(false)
      expect(service.setDefaultSearchEngine('')).toBe(false)
      expect(service.setDefaultSearchEngine(null)).toBe(false)
      expect(service.getSearchConfig().default).toBe('bing')
    } finally {
      close()
    }
  })

  it('setSearchEngineUrl 可覆盖内置引擎，也可新增自定义引擎', () => {
    const { service, close } = makeService()
    try {
      expect(service.setSearchEngineUrl('mine', 'https://mine.test/?q=')).toBe(true)
      expect(service.setDefaultSearchEngine('mine')).toBe(true)
      expect(service.buildSearchUrl('hira')).toBe('https://mine.test/?q=hira')

      expect(service.setSearchEngineUrl('', 'https://x.test/')).toBe(false)
      expect(service.setSearchEngineUrl('x', '')).toBe(false)
      expect(service.setSearchEngineUrl('x', null)).toBe(false)
    } finally {
      close()
    }
  })

  it('buildSearchUrl 对空值与特殊字符做编码', () => {
    const { service, close } = makeService()
    try {
      expect(service.buildSearchUrl('a b&c')).toBe('https://www.google.com/search?q=a%20b%26c')
      expect(service.buildSearchUrl(null)).toBe('https://www.google.com/search?q=')
      expect(service.buildSearchUrl(undefined)).toBe('https://www.google.com/search?q=')
    } finally {
      close()
    }
  })
})
