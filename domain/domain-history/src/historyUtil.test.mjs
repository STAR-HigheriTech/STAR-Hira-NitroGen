import { describe, it, expect } from 'vitest'
import {
  hostOfUrl, stripUrl, coalesceByUrl, dayBucketLabel, relativeTimeLabel,
  scoreMatch, sortByRelevance, groupByDay, groupByDayModel, faviconHintFor, keepLatestUnique
} from './history-utils.ts'

const DAY = 24 * 60 * 60 * 1000
// 锚定在本地"中午"时刻，避开跨日边界模糊（2024-11-15 12:00 本地）
const NOW = new Date(2024, 10, 15, 12, 0, 0).getTime()

describe('URL 提取与归并', () => {
  it('hostOfUrl / stripUrl', () => {
    expect(hostOfUrl('https://cn.example.com/a?b=1')).toBe('cn.example.com')
    expect(hostOfUrl('https://a.com:8080/x')).toBe('a.com')
    expect(hostOfUrl('')).toBe('')
    expect(stripUrl('https://a.com/x?q=1#frag')).toBe('https://a.com/x')
  })
  it('coalesceByUrl：同 URL 累计 visitCount', () => {
    const r = coalesceByUrl([
      { url: 'https://a.com/x?a=1', visitCount: 1 },
      { url: 'https://a.com/x?a=2', visitCount: 3 }
    ])
    expect(r.length).toBe(1)
    expect(r[0].visitCount).toBe(4)
  })
})

describe('时间分桶', () => {
  it('dayBucketLabel', () => {
    expect(dayBucketLabel(NOW, NOW)).toBe('今天')
    expect(dayBucketLabel(NOW - DAY, NOW)).toBe('昨天')
    expect(dayBucketLabel(NOW - 3 * DAY, NOW)).toBe('更早')
  })
  it('relativeTimeLabel', () => {
    expect(relativeTimeLabel(NOW - 30 * 1000, NOW)).toBe('刚刚')
    expect(relativeTimeLabel(NOW - 5 * 60000, NOW)).toBe('5 分钟前')
    expect(relativeTimeLabel(NOW - 3 * 3600000, NOW)).toBe('3 小时前')
    expect(relativeTimeLabel(NOW - 2 * DAY, NOW)).toBe('2 天前')
  })
  it('groupByDayModel 返回稳定分组结构', () => {
    const model = groupByDayModel([
      { lastVisitAt: NOW },
      { lastVisitAt: NOW - 3 * DAY }
    ], null, NOW)
    expect(model.total).toBe(2)
    expect(model.groups.map((group) => group.key)).toEqual(['today', 'older'])
  })
  it('groupByDay：桶序固定', () => {
    const g = groupByDay([
      { lastVisitAt: NOW },
      { lastVisitAt: NOW - DAY },
      { lastVisitAt: NOW - 10 * DAY }
    ], null, NOW)
    expect(Object.keys(g)).toEqual(['今天', '昨天', '更早'])
    expect(g['今天'].length).toBe(1)
    expect(g['更早'].length).toBe(1)
  })
})

describe('匹配与排序', () => {
  it('scoreMatch：前缀>包含>host>无', () => {
    expect(scoreMatch('app', 'apple maps', 'https://x')).toBe(3)
    expect(scoreMatch('map', 'apple maps', 'https://x')).toBe(2)
    expect(scoreMatch('example', 'foo', 'https://example.com')).toBe(2)
    expect(scoreMatch('zzz', 'foo', 'https://x')).toBe(0)
  })
  it('sortByRelevance：高分在前，同分近访在前', () => {
    const entries = [
      { title: 'banana', url: 'https://b', lastVisitAt: 1 },
      { title: 'apple pie', url: 'https://a', lastVisitAt: 2 }
    ]
    const sorted = sortByRelevance('app', entries, (e) => `${e.title} ${e.url}`)
    expect(sorted[0].title).toBe('apple pie')
  })
  it('keepLatestUnique：同 URL 取最近', () => {
    const r = keepLatestUnique([
      { url: 'https://a.com/x', lastVisitAt: 1 },
      { url: 'https://a.com/x?z', lastVisitAt: 9 }
    ])
    expect(r.length).toBe(1)
    expect(r[0].lastVisitAt).toBe(9)
  })
})

describe('favicon 溯源', () => {
  it('faviconHintFor', () => {
    expect(faviconHintFor('https://a.com:80/p')).toBe('https://a.com/favicon.ico')
    expect(faviconHintFor('')).toBe('')
  })
})
