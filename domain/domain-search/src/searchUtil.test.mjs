import { describe, it, expect } from 'vitest'
import {
  normalizeQuery, looksLikeUrl, isPlainQuery, hasBang, parseBang,
  encodeQuery, fillEngineTemplate, dedupeByUrl, rankByQuery, trimHistory, shortUrl
} from './searchUtil.ts'

describe('查询归一化与判定', () => {
  it('normalizeQuery', () => {
    expect(normalizeQuery('  a  b   ')).toBe('a b')
    expect(normalizeQuery('')).toBe('')
    expect(normalizeQuery(null)).toBe('')
  })
  it('looksLikeUrl / isPlainQuery', () => {
    expect(looksLikeUrl('https://x.com/y')).toBe(true)
    expect(looksLikeUrl('www.example.com/z')).toBe(true)
    expect(looksLikeUrl('hello world')).toBe(false)
    expect(isPlainQuery('hello')).toBe(true)
    expect(isPlainQuery('https://x')).toBe(false)
  })
})

describe('bang 解析', () => {
  it('hasBang / parseBang', () => {
    expect(hasBang('!yt cats')).toBe(true)
    expect(hasBang('hello')).toBe(false)
    expect(parseBang('!yt cats video')).toEqual({ bang: 'yt', rest: 'cats video' })
    expect(parseBang('!g')).toEqual({ bang: 'g', rest: '' })
    expect(parseBang('no bang')).toEqual({ bang: null, rest: 'no bang' })
  })
})

describe('引擎模板填充', () => {
  it('fillEngineTemplate：占位符与无占位符', () => {
    expect(fillEngineTemplate('https://g.com/search?q={query}', 'a b')).toBe('https://g.com/search?q=a%20b')
    expect(fillEngineTemplate('https://g.com/{}', 'x')).toBe('https://g.com/x')
    expect(fillEngineTemplate('https://g.com/search', 'x')).toBe('https://g.com/search?q=x')
    expect(fillEngineTemplate('https://g.com/search?lang=en', 'x')).toBe('https://g.com/search?lang=en&q=x')
  })
  it('encodeQuery', () => {
    expect(encodeQuery('a b')).toBe('a%20b')
  })
})

describe('建议排序与去重', () => {
  it('rankByQuery：前缀同分保持原序，非匹配垫底', () => {
    const items = [{ t: 'apple' }, { t: 'application' }, { t: 'banana' }]
    const r = rankByQuery('app', items, (i) => i.t)
    expect(r.map((i) => i.t)).toEqual(['apple', 'application', 'banana'])
  })
  it('dedupeByUrl', () => {
    const items = [{ url: 'a' }, { url: 'b' }, { url: 'a' }]
    expect(dedupeByUrl(items).length).toBe(2)
  })
  it('trimHistory', () => {
    expect(trimHistory([1, 2, 3], 2)).toEqual([1, 2])
    expect(trimHistory(null, 2)).toEqual([])
  })
})

describe('短 URL', () => {
  it('shortUrl：去协议取域名', () => {
    expect(shortUrl('https://www.cn.example/path')).toBe('www.cn.example')
    expect(shortUrl('')).toBe('')
  })
})
