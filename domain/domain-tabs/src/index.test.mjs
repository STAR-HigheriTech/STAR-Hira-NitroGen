/**
 * domain-tabs 单测 —— 完全脱离 Electron / WebContents / 真实时钟。
 *
 * 断言分两层：
 *   A. **行为层**：固定标签保护、活动标签保护、边界越界等硬规则；
 *   B. **等价层**：把原先内联在 `infra-window#TabManager` 里的算法原样搬来当 oracle，
 *      对随机输入逐字比对。
 *
 * 第二层是这次下沉的核心保险 —— 抽函数最容易犯的错不是"写不出来"，
 * 而是**在边界上悄悄改了语义**（比如 `insertAfter` 的下标偏移、`lastActivated` 缺失时的默认值），
 * 靠人眼 review 是看不出来的。
 */
import { describe, it, expect } from 'vitest'

const {
  sleepCandidates,
  othersToClose,
  rightToClose,
  undoInsertIndex,
  reorderIds,
  DEFAULT_INACTIVE_THRESHOLD_MS,
  tabRules,
  tabAdjust,
  tabStacks
} = await import('./index.ts')

/** 造一批标签 */
function mkTabs(spec) {
  return spec.map((s) => ({
    tabId: s.id,
    pinned: !!s.pinned,
    sleeping: !!s.sleeping,
    lastActivated: s.at
  }))
}

// ── A. 行为层 ──────────────────────────────────────────────

describe('sleepCandidates：谁可以被休眠', () => {
  const NOW = 1_000_000_000_000

  it('活动标签永不休眠（睡了就是白屏，这是最贵的错）', () => {
    const tabs = mkTabs([{ id: 'a', at: 0 }, { id: 'b', at: 0 }])
    expect(sleepCandidates(tabs, { activeTabId: 'a', now: NOW })).toEqual(['b'])
  })

  it('固定标签默认豁免', () => {
    const tabs = mkTabs([{ id: 'a', pinned: true, at: 0 }, { id: 'b', at: 0 }])
    expect(sleepCandidates(tabs, { activeTabId: null, now: NOW })).toEqual(['b'])
  })

  it('显式 excludePinned:false 时固定标签也可休眠', () => {
    const tabs = mkTabs([{ id: 'a', pinned: true, at: 0 }, { id: 'b', pinned: true, at: 0 }])
    expect(sleepCandidates(tabs, { activeTabId: null, now: NOW, excludePinned: false })).toEqual(['a', 'b'])
  })

  it('已在休眠的标签不重复返回', () => {
    const tabs = mkTabs([{ id: 'a', sleeping: true, at: 0 }, { id: 'b', at: 0 }])
    expect(sleepCandidates(tabs, { activeTabId: null, now: NOW })).toEqual(['b'])
  })

  it('阈值内刚激活过的标签不动', () => {
    const tabs = mkTabs([{ id: 'a', at: NOW - 1000 }, { id: 'b', at: NOW - DEFAULT_INACTIVE_THRESHOLD_MS - 1 }])
    expect(sleepCandidates(tabs, { activeTabId: null, now: NOW })).toEqual(['b'])
  })

  it('lastActivated 缺失 → 视为"从未激活"，可休眠（旧语义，不可改成保守跳过）', () => {
    const tabs = [{ tabId: 'x' }]
    expect(sleepCandidates(tabs, { activeTabId: null, now: NOW })).toEqual(['x'])
  })

  it('now 必须由调用方注入，缺失即报错（拒绝隐式读时钟）', () => {
    expect(() => sleepCandidates([], {})).toThrow(/now/)
    expect(() => sleepCandidates([], { now: NaN })).toThrow(/now/)
  })

  it('脏输入被收敛：非数组 / 无 tabId / 数字 id', () => {
    expect(sleepCandidates(null, { now: NOW })).toEqual([])
    expect(sleepCandidates([null, {}, { tabId: 7 }], { now: NOW })).toEqual(['7'])
  })
})

describe('othersToClose / rightToClose：关闭名单', () => {
  const tabs = mkTabs([
    { id: 'a' },
    { id: 'b', pinned: true },
    { id: 'c' },
    { id: 'd', pinned: true },
    { id: 'e' }
  ])

  it('关闭其它：排除自身，固定标签留下', () => {
    expect(othersToClose(tabs, 'a')).toEqual(['c', 'e'])
  })

  it('关闭右侧：只取目标之后的，同样跳过固定标签', () => {
    expect(rightToClose(tabs, 'a')).toEqual(['c', 'e'])
  })

  it('关闭右侧：目标是最后一个 → 空名单', () => {
    expect(rightToClose(tabs, 'e')).toEqual([])
  })

  it('关闭右侧：目标不存在 → 空名单（不抛错）', () => {
    expect(rightToClose(tabs, 'zzz')).toEqual([])
  })

  it('数字 tabId 与字符串 tabId 等价', () => {
    expect(othersToClose([{ tabId: 1 }, { tabId: 2 }], 1)).toEqual(['2'])
  })
})

describe('undoInsertIndex：撤销关闭插回哪一格', () => {
  it('正常范围内原样返回', () => {
    expect(undoInsertIndex(2, 5)).toBe(2)
  })

  it('超出上界夹到末尾（与旧实现 Math.min 一致）', () => {
    expect(undoInsertIndex(9, 3)).toBe(3)
  })

  it('负数/NaN 夹到 0 —— 旧实现只夹上界，脏索引会让 splice 反插', () => {
    expect(undoInsertIndex(-1, 5)).toBe(0)
    expect(undoInsertIndex(NaN, 5)).toBe(0)
    expect(undoInsertIndex(2, NaN)).toBe(0)
  })
})

describe('reorderIds：拖拽后的新顺序', () => {
  const ids = ['a', 'b', 'c', 'd']

  it('拖到目标之前', () => {
    const r = reorderIds(ids, { draggedId: 'd', targetId: 'b' })
    expect(r).toEqual({ ok: true, ids: ['a', 'd', 'b', 'c'] })
  })

  it('拖到目标之后', () => {
    const r = reorderIds(ids, { draggedId: 'a', targetId: 'c', insertAfter: true })
    expect(r).toEqual({ ok: true, ids: ['b', 'c', 'a', 'd'] })
  })

  it('拖到末尾（insertAfter 作用在最后一项时不能越界）', () => {
    const r = reorderIds(ids, { draggedId: 'a', targetId: 'd', insertAfter: true })
    expect(r).toEqual({ ok: true, ids: ['b', 'c', 'd', 'a'] })
  })

  it('自己拖自己 / 不存在的 id → 拒绝，且不改动入参', () => {
    const input = ['a', 'b']
    expect(reorderIds(input, { draggedId: 'a', targetId: 'a' })).toEqual({ ok: false, reason: 'same' })
    expect(reorderIds(input, { draggedId: 'a', targetId: 'zz' })).toEqual({ ok: false, reason: 'missing' })
    expect(reorderIds(input, { draggedId: 'zz', targetId: 'a' })).toEqual({ ok: false, reason: 'missing' })
    expect(input).toEqual(['a', 'b'])
  })
})

// ── B. 等价层：与旧内联算法逐字对照 ────────────────────────────

/** oracle：原 `TabManager#reorder` 的算法（搬到测试里当参照） */
function legacyReorder(ids, { draggedId, targetId, insertAfter }) {
  const dragged = String(draggedId)
  const target = String(targetId)
  if (dragged === target) return { ok: false }
  if (!ids.includes(dragged) || !ids.includes(target)) return { ok: false }
  const entries = ids.map((id) => [id, id])
  const draggedIdx = entries.findIndex(([id]) => id === dragged)
  const [, draggedVal] = entries.splice(draggedIdx, 1)[0]
  let targetIdx = entries.findIndex(([id]) => id === target)
  if (insertAfter) targetIdx += 1
  entries.splice(targetIdx, 0, [dragged, draggedVal])
  return { ok: true, ids: entries.map(([id]) => id) }
}

/** oracle：原 `TabManager#sleepInactive` 的判定（搬到测试里当参照） */
function legacySleep(tabs, { activeTabId, now, inactiveThresholdMs, excludePinned }) {
  const out = []
  for (const t of tabs) {
    if (t.tabId === activeTabId) continue
    if (excludePinned && t.pinned) continue
    if (t.sleeping) continue
    const lastActive = t.lastActivated || 0
    if (now - lastActive < inactiveThresholdMs) continue
    out.push(t.tabId)
  }
  return out
}

describe('与旧内联实现逐字等价（随机 2000 组）', () => {
  /** 确定性伪随机，失败可复现 */
  function mulberry32(seed) {
    return function () {
      seed |= 0
      seed = (seed + 0x6d2b79f5) | 0
      let t = Math.imul(seed ^ (seed >>> 15), 1 | seed)
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296
    }
  }

  it('reorderIds ≡ legacyReorder', () => {
    const rnd = mulberry32(20260913)
    for (let n = 0; n < 2000; n++) {
      const len = 1 + Math.floor(rnd() * 6)
      const ids = Array.from({ length: len }, (_, i) => String.fromCharCode(97 + i))
      const draggedId = rnd() < 0.1 ? 'zz' : ids[Math.floor(rnd() * len)]
      const targetId = rnd() < 0.1 ? 'zz' : ids[Math.floor(rnd() * len)]
      const insertAfter = rnd() < 0.5
      const mine = reorderIds(ids, { draggedId, targetId, insertAfter })
      const old = legacyReorder(ids, { draggedId, targetId, insertAfter })
      expect(mine.ok, `ok 不一致 @${JSON.stringify({ ids, draggedId, targetId, insertAfter })}`).toBe(old.ok)
      if (mine.ok && old.ok) {
        expect(mine.ids, `顺序不一致 @${JSON.stringify({ ids, draggedId, targetId, insertAfter })}`).toEqual(old.ids)
      }
    }
  })

  it('sleepCandidates ≡ legacySleep', () => {
    const rnd = mulberry32(77001)
    const NOW = 1_700_000_000_000
    for (let n = 0; n < 2000; n++) {
      const len = Math.floor(rnd() * 7)
      const tabs = Array.from({ length: len }, (_, i) => ({
        tabId: `t${i}`,
        pinned: rnd() < 0.35,
        sleeping: rnd() < 0.25,
        // 刻意让一部分标签 lastActivated 缺失
        ...(rnd() < 0.2 ? {} : { lastActivated: NOW - Math.floor(rnd() * 2_000_000) })
      }))
      const activeTabId = len > 0 && rnd() < 0.7 ? `t${Math.floor(rnd() * len)}` : null
      const inactiveThresholdMs = 60_000
      const excludePinned = rnd() < 0.8
      const opts = { activeTabId, now: NOW, inactiveThresholdMs, excludePinned }
      expect(sleepCandidates(tabs, opts), `@${JSON.stringify({ tabs, opts })}`).toEqual(legacySleep(tabs, opts))
    }
  })
})

describe('端口形状', () => {
  it('tabRules 暴露 TabManager 需要的全部方法（注入契约）', () => {
    for (const k of ['sleepCandidates', 'othersToClose', 'rightToClose', 'undoInsertIndex', 'reorderIds']) {
      expect(typeof tabRules[k], `缺少 ${k}`).toBe('function')
    }
  })

  it('tabAdjust 端口被导出（含 tabStats 组合方法）', () => {
    expect(typeof tabAdjust?.tabStats).toBe('function')
    expect(typeof tabStacks?.projectTabStacks).toBe('function')
  })
})
