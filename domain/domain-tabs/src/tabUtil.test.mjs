import { describe, it, expect } from 'vitest'
const U = await import('./tabUtil.ts')

const tabs = [
  { tabId: '1', pinned: true, audio: true },
  { tabId: '2', pinned: false, isAudioPlaying: true },
  { tabId: '3', pinned: false, audio: false },
]

describe('isPinned', () => {
  it('true / false / 缺省 / 空输入', () => {
    expect(U.isPinned({ pinned: true })).toBe(true)
    expect(U.isPinned({ pinned: false })).toBe(false)
    expect(U.isPinned({})).toBe(false)
    expect(U.isPinned(null)).toBe(false)
    expect(U.isPinned(undefined)).toBe(false)
  })
})

describe('isActive', () => {
  it('字符串/数字 id 均可比较', () => {
    expect(U.isActive({ tabId: 2 }, '2')).toBe(true)
    expect(U.isActive({ tabId: '2' }, '2')).toBe(true)
    expect(U.isActive({ tabId: '2' }, 'x')).toBe(false)
    expect(U.isActive({ tabId: '2' }, null)).toBe(false)
  })
})

describe('countBy', () => {
  it('按 key 计数，空列表返回空 Map', () => {
    expect(U.countBy(tabs, 'pinned').get('pinned')).toBe(1)
    expect(U.countBy(tabs, 'audio').get('audio')).toBe(1)
    expect(U.countBy([], 'pinned').get('pinned')).toBe(0)
    expect(U.countBy(null, 'pinned').get('pinned')).toBe(0)
  })
})

describe('tabById', () => {
  it('命中 / 未命中 / 空列表', () => {
    expect(U.tabById(tabs, '2').tabId).toBe('2')
    expect(U.tabById(tabs, 2).tabId).toBe('2')
    expect(U.tabById(tabs, 'nope')).toBeNull()
    expect(U.tabById([], '1')).toBeNull()
  })
})

describe('indexOfId', () => {
  it('返回下标，未知返回 -1', () => {
    expect(U.indexOfId(tabs, '3')).toBe(2)
    expect(U.indexOfId(tabs, 3)).toBe(2)
    expect(U.indexOfId(tabs, 'nope')).toBe(-1)
    expect(U.indexOfId([], '1')).toBe(-1)
  })
})

describe('pinnedCount', () => {
  it('固定标签数', () => {
    expect(U.pinnedCount(tabs)).toBe(1)
    expect(U.pinnedCount([])).toBe(0)
    expect(U.pinnedCount(null)).toBe(0)
  })
})

describe('audioCount', () => {
  it('兼容 audio 与 isAudioPlaying 两种字段', () => {
    expect(U.audioCount(tabs)).toBe(2)
    expect(U.audioCount([{ audio: true }, { isAudioPlaying: true }, {}])).toBe(2)
    expect(U.audioCount([])).toBe(0)
  })
})

describe('moveIdTo', () => {
  it('前移 / 后移 / 移到两端', () => {
    expect(U.moveIdTo(['a', 'b', 'c'], 'c', 0)).toEqual({ ok: true, ids: ['c', 'a', 'b'] })
    expect(U.moveIdTo(['a', 'b', 'c'], 'a', 3)).toEqual({ ok: true, ids: ['b', 'c', 'a'] })
    expect(U.moveIdTo(['a', 'b', 'c'], 'b', 2)).toEqual({ ok: true, ids: ['a', 'c', 'b'] })
  })
  it('边界：未知 id / 越界下标 / 非法下标', () => {
    expect(U.moveIdTo(['a', 'b'], 'zz', 0)).toEqual({ ok: false })
    expect(U.moveIdTo(['a', 'b'], 'a', -1)).toEqual({ ok: false })
    expect(U.moveIdTo(['a', 'b'], 'a', 3)).toEqual({ ok: false })
    expect(U.moveIdTo(['a', 'b'], 'a', 1.5)).toEqual({ ok: false })
    expect(U.moveIdTo(null, 'a', 0)).toEqual({ ok: false })
  })
})

describe('focusOrder', () => {
  it('按 lastActivated 降序，缺失按 0，稳定', () => {
    const list = [
      { tabId: 'a', lastActivated: 3 },
      { tabId: 'b', lastActivated: 9 },
      { tabId: 'c' },
      { tabId: 'd', lastActivated: 3 },
    ]
    // 同 la=3 的 a、d 保持输入先后（稳定）
    expect(U.focusOrder(list)).toEqual(['b', 'a', 'd', 'c'])
    expect(U.focusOrder([])).toEqual([])
    expect(U.focusOrder(null)).toEqual([])
  })
})

describe('groupByListOf', () => {
  it('分组并丢弃脏数据（无 tabId）', () => {
    const list = [
      { tabId: '1', pinned: true },
      { tabId: '2' },
      { tabId: '3', pinned: false },
      { name: 'dirty' },
      null,
    ]
    const { pinned, normal } = U.groupByListOf(list)
    expect(pinned.map((t) => t.tabId)).toEqual(['1'])
    expect(normal.map((t) => t.tabId)).toEqual(['2', '3'])
    expect(U.groupByListOf([])).toEqual({ pinned: [], normal: [] })
  })
})

describe('isSameTab', () => {
  it('id 相同（含数字/字符串）即同一', () => {
    expect(U.isSameTab({ tabId: '1' }, { tabId: 1 })).toBe(true)
    expect(U.isSameTab({ tabId: '1' }, { tabId: '2' })).toBe(false)
    expect(U.isSameTab(null, { tabId: '1' })).toBe(false)
  })
})

describe('afterActive', () => {
  it('活动之后（不含固定）的 id', () => {
    const list = [
      { tabId: 'p1', pinned: true },
      { tabId: 'a' },
      { tabId: 'x' },
      { tabId: 'p2', pinned: true },
      { tabId: 'y' },
    ]
    expect(U.afterActive(list, 'a')).toEqual(['x', 'y'])
    expect(U.afterActive(list, 'nope')).toEqual([])
    expect(U.afterActive([], 'a')).toEqual([])
  })
})