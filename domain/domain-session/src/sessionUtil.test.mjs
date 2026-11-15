import { describe, it, expect } from 'vitest'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const {
  hostOfUrl, stripUrl, sanitizeSessionRecord, sessionTabCount, pinnedSessionTabs,
  activeSessionTabUrl, isRestorable, sessionStats, filterSessionByQuery, mergeSessions,
  dedupeSessionTabs, hasTabsForHost, suggestSessionName, sessionAgeLabel, capSessionTabs
} = require('../dist/index.cjs')

const DAY = 24 * 60 * 60 * 1000
// 锚定本地"中午"避免跨日歧义
const NOW = new Date(2024, 10, 15, 12, 0, 0).getTime()

const rec = {
  version: '1',
  savedAt: NOW,
  activeTabId: 'a',
  tabs: [
    { tabId: 'a', url: 'https://cn.example.com/x', pinned: true },
    { tabId: 'b', url: 'https://blog.example.com/y?q=1', pinned: false },
    { tabId: 3, url: 'https://a.com/', pinned: false },
    { tabId: '', url: '', pinned: false }
  ]
}

describe('归一化与 host', () => {
  it('sanitizeSessionRecord 丢弃无 url 标签、字符串化 id', () => {
    const r = sanitizeSessionRecord(rec)
    expect(r.tabs.length).toBe(3)
    expect(r.tabs[2].tabId).toBe('3')
    expect(r.activeTabId).toBe('a')
  })
  it('非法输入返回空记录', () => {
    expect(sanitizeSessionRecord(null).tabs).toEqual([])
    expect(sanitizeSessionRecord({}).activeTabId).toBeNull()
  })
  it('hostOfUrl / stripUrl', () => {
    expect(hostOfUrl('https://cn.example.com:8080/x?a')).toBe('cn.example.com')
    expect(hostOfUrl('')).toBe('')
    expect(stripUrl('https://a.com/y?b=1#c')).toBe('https://a.com/y')
  })
})

describe('统计', () => {
  it('sessionTabCount / pinnedSessionTabs', () => {
    expect(sessionTabCount(rec)).toBe(3)
    expect(pinnedSessionTabs(rec).map((t) => t.tabId)).toEqual(['a'])
  })
  it('activeSessionTabUrl / isRestorable / sessionStats', () => {
    expect(activeSessionTabUrl(rec)).toBe('https://cn.example.com/x')
    expect(isRestorable(rec)).toBe(true)
    expect(isRestorable(null)).toBe(false)
    expect(sessionStats(rec)).toEqual({ tabs: 3, pinned: 1, activeIndex: 0 })
  })
})

describe('过滤 / 合并 / 去重', () => {
  it('filterSessionByQuery', () => {
    expect(filterSessionByQuery(rec, 'example').length).toBe(2)
    expect(filterSessionByQuery(rec, 'a.com').length).toBe(1)
  })
  it('mergeSessions 前者优先', () => {
    const merged = mergeSessions(rec, { tabs: [{ tabId: 'z', url: 'https://x.com/', pinned: false }] })
    expect(merged.tabs.length).toBe(4)
    expect(merged.activeTabId).toBe('a')
  })
  it('dedupeSessionTabs 按 stripUrl', () => {
    const out = dedupeSessionTabs({ tabs: [
      { tabId: 'a', url: 'https://a.com/x?a=1', pinned: false },
      { tabId: 'b', url: 'https://a.com/x?a=2', pinned: false }
    ] })
    expect(out.length).toBe(1)
  })
  it('hasTabsForHost 精确匹配 host', () => {
    expect(hasTabsForHost(rec, 'cn.example.com')).toBe(true)
    expect(hasTabsForHost(rec, 'nope.com')).toBe(false)
  })
})

describe('命名与时间', () => {
  it('suggestSessionName', () => {
    expect(suggestSessionName(['https://cn.example.com/', 'https://cn.example.com/a'])).toBe('cn.example.com 等 2 个标签页')
    expect(suggestSessionName([])).toBe('空会话')
    expect(suggestSessionName(['https://www.qiwi.com/'])).toBe('qiwi.com')
  })
  it('sessionAgeLabel', () => {
    expect(sessionAgeLabel(NOW, NOW)).toBe('今天')
    expect(sessionAgeLabel(NOW - DAY, NOW)).toBe('昨天')
    expect(sessionAgeLabel(NOW - 3 * DAY, NOW)).toBe('更早')
  })
  it('capSessionTabs 优先固定', () => {
    const capped = capSessionTabs(rec, 2)
    expect(capped.tabs.length).toBe(2)
    expect(capped.tabs[0].pinned).toBe(true)
  })
})
