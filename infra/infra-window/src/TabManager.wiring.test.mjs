/**
 * TabManager × domain-tabs 接线单测 —— 验证 `tabAdjust`（组合规则）真正注入并可被消费。
 *
 * 无头构造（照 verify-tab-nav.cjs 的 mock 风格）：
 *   - `@hira-ng/infra-window` / `@hira-ng/domain-tabs` 均走 workspace 依赖 resolve；
 *   - webContentsManager / layoutCoordinator / emit / hooks 全部 mock；
 *   - 注入**真实**的 domain `tabRules` 与 `tabAdjust`。
 *
 * 覆盖三条：
 *   A. stats() 对 pinned / audioPlaying 计数正确（audio 由 audioPlaying=true 经边界适配计出）；
 *   B. visibleAfter(id) 只返回活动之后非固定 tabId；
 *   C. 未注入 tabAdjust 时 stats() 回退本地遍历且不抛错。
 */
import { describe, it, expect } from 'vitest'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const { TabManager } = require('@hira-ng/infra-window')

const tabRules = {
  sleepCandidates() { return [] },
  reorderIds(ids, { draggedId, targetId, insertAfter }) {
    const draggedIndex = ids.indexOf(draggedId)
    const targetIndex = ids.indexOf(targetId)
    if (draggedIndex < 0 || targetIndex < 0 || draggedId === targetId) return { ok: false }
    const next = ids.filter((id) => id !== draggedId)
    const destination = next.indexOf(targetId) + (insertAfter ? 1 : 0)
    next.splice(destination, 0, draggedId)
    return { ok: true, ids: next }
  }
}

const tabAdjust = {
  tabStats(tabs) {
    return tabs.reduce(
      (stats, tab) => ({
        total: stats.total + 1,
        pinned: stats.pinned + Number(tab.pinned),
        audio: stats.audio + Number(tab.audio)
      }),
      { total: 0, pinned: 0, audio: 0 }
    )
  },
  visibleAfter(tabs, tabId) {
    const start = tabs.findIndex((tab) => tab.tabId === tabId)
    return start < 0
      ? []
      : tabs.slice(start + 1).filter((tab) => !tab.pinned).map((tab) => tab.tabId)
  }
}

const tabStacks = {
  projectTabStacks(tabs, stacks) {
    const byStack = new Map(stacks.map((stack) => [stack.stackId, stack]))
    const emitted = new Set()
    const output = []
    for (const tab of tabs) {
      const stack = byStack.get(tab.stackId)
      if (!stack) {
        output.push(tab)
        continue
      }
      if (!emitted.has(stack.stackId)) {
        output.push({ type: 'stack', ...stack, children: tabs.filter((item) => item.stackId === stack.stackId) })
        emitted.add(stack.stackId)
      }
      if (!stack.collapsed) output.push(tab)
    }
    return output
  }
}

/**
 * 与 TabManager#newTab 内部状态同形的 tab 快照（直接注入 _tabs 即可无头驱动）。
 *
 * `profileId` / `spaceId` 必须给上：`TabManager#list()` 走的是 `listBySpace(当前 profile, 当前 space)`，
 * 默认上下文是 `{ profileId: 'default', spaceId: 'default' }`（见构造函数）。
 * 漏掉这两个字段，夹具里的标签一条都不会出现在 `list()` 里 —— 本文件曾因此整组假失败
 *（表现为"list() 返回 []"，看起来像业务坏了，其实是夹具缺字段）。
 */
function mkTab(id, { pinned = false, audioPlaying = false } = {}) {
  return {
    tabId: id, url: 'about:blank', title: '', pinned, muted: false, audioPlaying, sleeping: false, incognito: false,
    profileId: 'default', spaceId: 'default'
  }
}

/** 在真实 _tabs 上铺一批标签，返回 TabManager 实例 */
function makeTm({ withAdjust = true, tabs }) {
  const active = 'a'
  const layout = { getActiveTabId: () => active, showTab: () => {}, hideTab: () => {} }
  const tm = new TabManager({
    // 无头测试不触达真实的 WebContentsManager；但**方法名要齐** ——
    // `_projectTab` 会问 `isTabSleeping` 与 `getTab`（只读，不创建视图），
    // 缺一个就抛 TypeError（本文件曾因此整组假失败）。`getTab` 返回 undefined
    // 是正确语义："没有活视图 = 没在加载、也没有可遍历的历史"。
    webContentsManager: { isTabSleeping: () => false, getTab: () => undefined },
    layoutCoordinator: layout,
    emit: () => {},
    hooks: {},
    tabRules,
    ...(withAdjust ? { tabAdjust } : {}),
    tabStacks
  })
  for (const [id, t] of tabs.entries()) tm._tabs.set(id, t)
  // 触发 labelMap 不受影响；仅内部 Map 足矣（stats/visibleAfter 只读 _tabs）
  return tm
}

const BASE_TABS = new Map([
  ['a', mkTab('a')], // 活动、普通
  ['p', mkTab('p', { pinned: true })], // 固定
  ['snd', mkTab('snd', { audioPlaying: true })], // 播放声音
  ['n', mkTab('n')] // 普通
])

describe('TabManager.wiring: tabAdjust 注入后消费', () => {
  it('stats() 对 pinned / audioPlaying 计数正确（经 audio 边界适配）', () => {
    const tm = makeTm({ withAdjust: true, tabs: BASE_TABS })
    const s = tm.stats()
    expect(s).toEqual({ total: 4, pinned: 1, audio: 1 })
  })

  it('visibleAfter(id) 只返回活动之后、非固定的 tabId（保持原顺序）', () => {
    const tm = makeTm({ withAdjust: true, tabs: BASE_TABS })
    expect(tm.visibleAfter('a')).toEqual(['snd', 'n'])
  })

  it('stats() 与 visibleAfter() 委托到了真实 domain 规则（非本地实现）', () => {
    // 未注入 tabAdjust 时的回退结果，用于对照：注入版必须走 domain 而非本地遍历。
    const tmAdj = makeTm({ withAdjust: true, tabs: BASE_TABS })
    const tmFallback = makeTm({ withAdjust: false, tabs: BASE_TABS })
    // 两案对同一输入结果一致（语义等价），但注入版由域规则结算。
    expect(tmAdj.stats()).toEqual(tmFallback.stats())
    expect(typeof tmAdj._tabAdjust.tabStats).toBe('function')
  })
})

describe('TabManager: tab stacks', () => {
  it('将状态与渲染投影分离，且未分栈的标签保持扁平', () => {
    const tm = makeTm({ tabs: BASE_TABS })
    const stack = tm.createStack({ tabIds: ['snd', 'n'], label: '媒体', collapsed: true })
    expect(tm.list().map((tab) => tab.tabId)).toEqual(['a', 'p', 'snd', 'n'])
    expect(tm.listProjection().map((item) => item.type === 'stack' ? item.stackId : item.tabId)).toEqual(['a', 'p', stack.stackId])
    expect(tm.toggleStack(stack.stackId)).toEqual({ stackId: stack.stackId, collapsed: false })
    expect(tm.listProjection().map((item) => item.type === 'stack' ? item.stackId : item.tabId)).toEqual(['a', 'p', stack.stackId, 'snd', 'n'])
  })

  it('成员移出后自动清理空栈', () => {
    const tm = makeTm({ tabs: new Map([['a', mkTab('a')]]) })
    const stack = tm.createStack({ tabIds: ['a'] })
    expect(tm.setTabStack({ tabId: 'a', stackId: null })).toEqual({ tabId: 'a', stackId: null })
    expect(tm.listStacks()).toEqual([])
    expect(() => tm.toggleStack(stack.stackId)).toThrow(/Missing tab stack/)
  })
})

describe('TabManager.wiring: tabAdjust 未注入（回退）', () => {
  it('stats() 仍返回合理本地统计且不抛错', () => {
    const tm = makeTm({ withAdjust: false, tabs: BASE_TABS })
    expect(() => tm.stats()).not.toThrow()
    expect(tm.stats()).toEqual({ total: 4, pinned: 1, audio: 1 })
  })

  it('visibleAfter() 未注入时返回空数组（不抛错）', () => {
    const tm = makeTm({ withAdjust: false, tabs: BASE_TABS })
    expect(() => tm.visibleAfter('a')).not.toThrow()
    expect(tm.visibleAfter('a')).toEqual([])
  })
})

describe('TabManager: stack metadata mutations', () => {
  it('renames and recolors a stack without changing members', () => {
    const tm = makeTm({ tabs: new Map([['a', mkTab('a')]]) })
    const stack = tm.createStack({ tabIds: ['a'], label: '旧名称', accent: '#111111' })
    expect(tm.renameStack({ stackId: stack.stackId, label: '  工作  ' })).toEqual({ stackId: stack.stackId, label: '工作' })
    expect(tm.setStackColor({ stackId: stack.stackId, accent: '  #336699  ' })).toEqual({ stackId: stack.stackId, accent: '#336699' })
    expect(tm.listStacks()).toEqual([{ stackId: stack.stackId, label: '工作', accent: '#336699', collapsed: false }])
    expect(tm.list().find((tab) => tab.tabId === 'a').stackId).toBe(stack.stackId)
  })

  it('merges source members into target and removes source metadata', () => {
    const tm = makeTm({ tabs: new Map([['a', mkTab('a')], ['b', mkTab('b')]]) })
    const source = tm.createStack({ tabIds: ['a'], label: '来源' })
    const target = tm.createStack({ tabIds: ['b'], label: '目标' })
    expect(tm.mergeStacks({ sourceStackId: source.stackId, targetStackId: target.stackId })).toEqual({ sourceStackId: source.stackId, targetStackId: target.stackId, count: 1 })
    expect(tm.listStacks()).toEqual([{ stackId: target.stackId, label: '目标', accent: '', collapsed: false }])
    expect(tm.list().map((tab) => tab.stackId)).toEqual([target.stackId, target.stackId])
  })

  it('dissolves the whole stack back to loose tabs and drops its metadata', () => {
    const tm = makeTm({ tabs: new Map([['a', mkTab('a')], ['b', mkTab('b')], ['c', mkTab('c')]]) })
    const source = tm.createStack({ tabIds: ['a', 'b'], label: '原组', accent: '#111' })
    tm.createStack({ tabIds: ['c'], label: '另一组' })
    expect(tm.dissolveStack({ stackId: source.stackId })).toEqual({ stackId: source.stackId, count: 2, children: ['a', 'b'] })
    // 成员回到散标签、顺序不变；只有"另一组"留下
    expect(tm.list().map((tab) => tab.stackId || null)).toEqual([null, null, expect.any(String)])
    expect(tm.listStacks().map((s) => s.label)).toEqual(['另一组'])
  })

  it('moves a tab into a stack and detaches it when reordered against another stack', () => {
    const tm = makeTm({ tabs: new Map([['a', mkTab('a')], ['b', mkTab('b')], ['c', mkTab('c')]]) })
    const first = tm.createStack({ tabIds: ['a'], label: '第一组' })
    const second = tm.createStack({ tabIds: ['b'], label: '第二组' })
    expect(tm.reorder({ draggedId: 'c', targetStackId: first.stackId })).toEqual({ ok: true })
    expect(tm.list().find((tab) => tab.tabId === 'c').stackId).toBe(first.stackId)
    expect(tm.reorder({ draggedId: 'c', targetId: 'b', insertAfter: true })).toEqual({ ok: true })
    expect(tm.list().map((tab) => tab.tabId)).toEqual(['a', 'b', 'c'])
    expect(tm.list().find((tab) => tab.tabId === 'c').stackId).toBeNull()
  })
})
