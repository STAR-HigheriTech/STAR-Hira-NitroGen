/**
 * domain-tabs · TabAdjust 组合方法单测 —— 完全脱离 Electron / WebContents。
 *
 * 测 5 个新增组合方法（含空列表、未知 id、越界、audio 两种字段、stable 排序）。
 */
import { describe, it, expect } from 'vitest'

const { tabStats, partitionTabs, focusOrderIds, cleanActive, visibleAfter } = await import('./index.ts')

/** TabLike 列表 */
function mkTabs(spec) {
  return spec.map((s) => ({
    tabId: s.id,
    pinned: !!s.pinned,
    lastActivated: s.at,
    ...(s.audio !== undefined ? { audio: s.audio } : {}),
    ...(s.isAudioPlaying !== undefined ? { isAudioPlaying: s.isAudioPlaying } : {})
  }))
}

describe('tabStats：总数 / 固定数 / 播放声音数', () => {
  it('混合场景计数正确', () => {
    const tabs = mkTabs([
      { id: 'a', pinned: true, at: 1 },
      { id: 'b', audio: true, at: 2 },
      { id: 'c', isAudioPlaying: true, at: 3 },
      { id: 'd', at: 4 }
    ])
    expect(tabStats(tabs)).toEqual({ total: 4, pinned: 1, audio: 2 })
  })

  it('audio 与 isAudioPlaying 两种字段均计入', () => {
    const tabs = mkTabs([{ id: 'a', audio: true }, { id: 'b', isAudioPlaying: true }, { id: 'c' }])
    expect(tabStats(tabs).audio).toBe(2)
  })

  it('空列表 / 非数组 → 全 0', () => {
    expect(tabStats([])).toEqual({ total: 0, pinned: 0, audio: 0 })
    expect(tabStats(null)).toEqual({ total: 0, pinned: 0, audio: 0 })
  })
})

describe('partitionTabs：按固定与否分组', () => {
  it('顺序保持输入，固定归 pinned，其余归 normal', () => {
    const tabs = mkTabs([
      { id: 'a', at: 1 },
      { id: 'b', pinned: true, at: 2 },
      { id: 'c', at: 3 },
      { id: 'd', pinned: true, at: 4 }
    ])
    const r = partitionTabs(tabs)
    expect(r.pinned.map((t) => t.tabId)).toEqual(['b', 'd'])
    expect(r.normal.map((t) => t.tabId)).toEqual(['a', 'c'])
  })

  it('数字 id 被字符串化', () => {
    const r = partitionTabs([{ tabId: 1 }, { tabId: 2, pinned: true }])
    expect(r.pinned).toEqual([{ tabId: '2', pinned: true }])
    expect(r.normal).toEqual([{ tabId: '1', pinned: false }])
  })

  it('无 tabId 的脏数据被丢弃；空列表返回两组空数组', () => {
    const r = partitionTabs([null, {}, { tabId: 'x' }])
    expect(r).toEqual({ pinned: [], normal: [{ tabId: 'x', pinned: false }] })
    expect(partitionTabs([])).toEqual({ pinned: [], normal: [] })
    expect(partitionTabs(null)).toEqual({ pinned: [], normal: [] })
  })
})

describe('focusOrderIds：按 lastActivated 降序', () => {
  it('降序返回 tabId，缺失按 0', () => {
    const tabs = mkTabs([
      { id: 'a', at: 10 },
      { id: 'b', at: 30 },
      { id: 'c', at: 20 },
      { id: 'd' } // 缺失
    ])
    expect(focusOrderIds(tabs)).toEqual(['b', 'c', 'a', 'd'])
  })

  it('同值 stable：不因排序抖乱顺序', () => {
    const tabs = mkTabs([
      { id: 'a', at: 5 },
      { id: 'b', at: 5 },
      { id: 'c', at: 5 }
    ])
    expect(focusOrderIds(tabs)).toEqual(['a', 'b', 'c'])
  })

  it('空列表 → []', () => {
    expect(focusOrderIds([])).toEqual([])
    expect(focusOrderIds(null)).toEqual([])
  })
})

describe('cleanActive：规范化活动 id', () => {
  const tabs = mkTabs([{ id: 'a', at: 1 }, { id: 'b', at: 2 }])

  it('存在的 id 返回字符串化结果', () => {
    expect(cleanActive(tabs, 'a')).toBe('a')
    expect(cleanActive(tabs, 'b')).toBe('b')
  })

  it('数字 id 被字符串化', () => {
    expect(cleanActive([{ tabId: 7 }], 7)).toBe('7')
  })

  it('未知 / null / 空列表 → null', () => {
    expect(cleanActive(tabs, 'zzz')).toBe(null)
    expect(cleanActive(tabs, null)).toBe(null)
    expect(cleanActive([], 'a')).toBe(null)
  })
})

describe('visibleAfter：活动之后、非固定的 tabId', () => {
  const tabs = mkTabs([
    { id: 'a', at: 1 },
    { id: 'b', pinned: true, at: 2 },
    { id: 'c', at: 3 },
    { id: 'd', pinned: true, at: 4 },
    { id: 'e', at: 5 }
  ])

  it('只取活动之后的普通标签，跳过固定、保持顺序', () => {
    expect(visibleAfter(tabs, 'a')).toEqual(['c', 'e'])
  })

  it('未知活动 id → 空（不抛错）', () => {
    expect(visibleAfter(tabs, 'zzz')).toEqual([])
  })

  it('空列表 / 活动在末尾 → []', () => {
    expect(visibleAfter([], 'a')).toEqual([])
    expect(visibleAfter(tabs, 'e')).toEqual([])
  })
})