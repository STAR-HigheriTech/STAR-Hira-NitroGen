#!/usr/bin/env node
/**
 * 分屏（Split View）离线验证 —— **不需要整机**，只测两个纯函数层。
 *
 * 分层与验证口径（这是本脚本存在的理由）：
 *   ① 几何真源  `@hira-ng/shared-types/src/split-layout.mjs` —— 切分算术（不变式 I1/I2/I3）
 *   ② 组规则真源 `@hira-ng/domain-tabs` 的 TabSplits —— 建/加/删/解散/反转/裁剪
 *   ③ 会话契约  `domain-session/src/schema.ts` —— v4 读写与"宽进严出"
 *
 * 刻意**不测** Electron 侧（落 bounds / 分隔条拖拽 / 焦点）：那需要真窗口，属于
 * `verify-tab-nav` 那一类；而这里要保证的是"算术与规则在任何环境下都对"。
 *
 * 用法：node scripts/verify-split.cjs   （退出码 0 = 全过）
 */
const path = require('path')

const splitLayout: typeof import('@hira-ng/shared-types/src/split-layout.mjs') = require('@hira-ng/shared-types/src/split-layout.mjs')
const {
  solveSplitPanes,
  ratiosFromDrag,
  normalizeSplitRatios,
  normalizeSplitCount,
  ratiosForPreset,
  neighborPaneIndex,
  // 拖动落点（拖标签到网页区域 → 在哪边、怎么排）：预览块与最终分屏的**同一份**算术
  resolveDropZone,
  splitMembersForDrop,
  SPLIT_METRICS
} = splitLayout
const tabsDomain: typeof import('@hira-ng/domain-tabs') = require('@hira-ng/domain-tabs')
const tabSplits = tabsDomain.tabSplits
// 标签栈端口也要注入宿主桩：顺序不变式必须在 **domain 那条路**上也成立
const tabStacks = tabsDomain.tabStacks
// 宿主侧（infra）也要验：它是"用户口径"（设置项）与"硬上限"（domain 真源）的交汇处。
const tabLayout: typeof import('../infra/infra-window/src/tabLayout.ts') = require('../infra/infra-window/src/tabLayout.ts')
// 拖动落点预览的**会话机**（主进程）：刻意不 require electron、全部依赖注入，
// 所以能在 headless 下把「起表 → 采样 → 推预览 → 松手交意图」整条逻辑跑一遍
//（"预览压根没出来"这类问题，纯函数层验不到 —— 它们断在这条会话链上）。
const dropZoneModule: typeof import('../apps/app-main/src/main/tab-drop-zone.ts') = require('../apps/app-main/src/main/tab-drop-zone.ts')
const { createTabDropZone } = dropZoneModule
const sessionDomain: typeof import('@hira-ng/domain-session') = require('@hira-ng/domain-session')
const { parseSessionFile, SESSION_VERSION } = sessionDomain

let passed = 0
let failed = 0
const failures: string[] = []

function check(name: string, condition: unknown, detail?: unknown): void {
  if (condition) {
    passed++
    console.log(`  ✓ ${name}`)
  } else {
    failed++
    failures.push(name)
    console.log(`  ✗ ${name}${detail ? `  —— ${detail}` : ''}`)
  }
}

function group(title: string): void {
  console.log(`\n── ${title} ─────────────────────────────`)
}

const RECT = { x: 10, y: 20, width: 1000, height: 600 }

function required<T>(value: T | null | undefined, label: string): T {
  if (value == null) throw new Error(`${label} returned null`)
  return value
}

/** 各格 + 分隔条是否精确铺满 rect（I1），且无重叠。 */
function tilesExactly(solved: ReturnType<typeof solveSplitPanes>, rect: typeof RECT, axis: 'x' | 'y' | 'grid'): boolean {
  if (axis === 'grid') return true // 网格按列/行各自校验（见下方分项）
  const total = axis === 'x' ? rect.width : rect.height
  let sum = 0
  for (let i = 0; i < solved.panes.length; i++) {
    sum += axis === 'x' ? solved.panes[i].width : solved.panes[i].height
    const div = solved.dividers[i]
    if (div) sum += axis === 'x' ? div.width : div.height
  }
  return sum === total
}

// ── ① 几何 ────────────────────────────────────────────────────────────────
group('几何：切分算术（split-layout.mjs）')

{
  const s = solveSplitPanes({ rect: RECT, layout: 'row', ratios: [0.5, 0.5], count: 2 })
  check('row/2 格：格数正确', s.panes.length === 2)
  check('row/2 格：精确铺满（I1）', tilesExactly(s, RECT, 'x'), `sum=${s.panes[0].width + s.panes[1].width + s.dividers[0].width}/${RECT.width}`)
  check('row/2 格：分隔条落在两格之间（I3）', s.dividers[0].x === s.panes[0].x + s.panes[0].width)
  check('row/2 格：分隔条厚度 = SPLIT_METRICS.divider', s.dividers[0].width === SPLIT_METRICS.divider)
  check('row/2 格：等分', Math.abs(s.panes[0].width - s.panes[1].width) <= 1)
  check('row/2 格：高度吃满', s.panes[0].height === RECT.height && s.panes[1].height === RECT.height)
}

{
  const s = solveSplitPanes({ rect: RECT, layout: 'column', ratios: [0.7, 0.3], count: 2 })
  check('column/2 格：精确铺满（I1）', tilesExactly(s, RECT, 'y'))
  check('column/2 格：比例 70/30 生效', Math.abs(s.panes[0].height / (RECT.height - SPLIT_METRICS.divider) - 0.7) < 0.01)
  check('column/2 格：宽度吃满', s.panes[0].width === RECT.width)
}

{
  // 缩到很窄：必须仍 >=0、无负值、且总和守恒（I2）
  const narrow = { x: 0, y: 0, width: 200, height: 120 }
  const s = solveSplitPanes({ rect: narrow, layout: 'row', ratios: [0.5, 0.5], count: 2 })
  const ok = s.panes.every((p) => p.width >= 0 && p.height >= 0)
  check('极窄内容区：无 0/负尺寸（I2）', ok, JSON.stringify(s.panes.map((p) => p.width)))
  check('极窄内容区：总和守恒', s.panes[0].width + s.panes[1].width + s.dividers[0].width === narrow.width)
  check('极窄内容区：标记 clamped', s.clamped === true)
}

{
  const s = solveSplitPanes({ rect: RECT, layout: 'grid', count: 3 })
  check('grid/3 格：格数正确', s.panes.length === 3)
  check('grid/3 格：行列 = 2×2', s.dividers.filter((d) => d.axis === 'x').length === 1 && s.dividers.filter((d) => d.axis === 'y').length === 1)
  check('grid/3 格：各格不重叠', new Set(s.panes.map((p) => `${p.x},${p.y}`)).size === 3)
}

{
  const s = solveSplitPanes({ rect: RECT, layout: 'grid', count: 4 })
  check('grid/4 格：格数正确', s.panes.length === 4)
  // 2×2 网格：列间 1 条竖分隔、行间 1 条横分隔
  check('grid/4 格：1 条竖分隔 + 1 条横分隔', s.dividers.filter((d) => d.axis === 'x').length === 1 && s.dividers.filter((d) => d.axis === 'y').length === 1)
  check('grid/4 格：行列各自精确铺满', (() => {
    const cols = s.panes.filter((p) => p.y === s.panes[0].y)
    const rows = s.panes.filter((p) => p.x === s.panes[0].x)
    const w = cols.reduce((a, p) => a + p.width, 0) + SPLIT_METRICS.divider * 1
    const h = rows.reduce((a, p) => a + p.height, 0) + SPLIT_METRICS.divider * 1
    return w === RECT.width && h === RECT.height
  })())
}

{
  const s = solveSplitPanes({ rect: RECT, layout: 'row', count: 1 })
  check('单格：无分隔条、铺满整块', s.panes.length === 1 && s.dividers.length === 0 && s.panes[0].width === RECT.width)
}

{
  const s = solveSplitPanes({ rect: RECT, layout: 'row', ratios: ['bad', -3, 0], count: 2 })
  const sum = s.ratios.reduce((a, b) => a + b, 0)
  check('非法比例：归一化后和为 1', Math.abs(sum - 1) < 1e-9)
  check('非法比例：每项 > 0', s.ratios.every((r) => r > 0))
}

{
  check('格数上限夹取', normalizeSplitCount(99, SPLIT_METRICS.maxPanes) === SPLIT_METRICS.maxPanes)
  check('格数下限夹取', normalizeSplitCount(0, SPLIT_METRICS.maxPanes) === 1)
  check('比例归一化补全', normalizeSplitRatios([1], 3).length === 3)
}

{
  // 拖第 1 条分隔条：只改被拖两侧的两格，其余不动
  const base = solveSplitPanes({ rect: RECT, layout: 'row', ratios: [0.5, 0.25, 0.25], count: 3 })
  const avail = RECT.width - SPLIT_METRICS.divider * 2
  const target = RECT.x + Math.round(avail * 0.3) + SPLIT_METRICS.divider
  const next = required(ratiosFromDrag({
    rect: RECT, layout: 'row', ratios: [0.5, 0.25, 0.25], count: 3,
    dividerIndex: 0, axis: 'x', position: target
  }), 'ratiosFromDrag')
  check('拖拽：返回新比例', Array.isArray(next) && next.length === 3)
  check('拖拽：未拖的第三格比例不变', Math.abs(next[2] - 0.25) < 1e-9)
  check('拖拽：和为 1', Math.abs(next.reduce((a, b) => a + b, 0) - 1) < 1e-9)
  const s2 = solveSplitPanes({ rect: RECT, layout: 'row', ratios: next, count: 3 })
  check('拖拽：结果仍精确铺满', s2.panes[0].width + s2.panes[1].width + s2.panes[2].width + s2.dividers[0].width + s2.dividers[1].width === RECT.width)
  check('拖拽：不会把某格压到 0', s2.panes.every((p) => p.width > 0))
  check('拖拽：越界索引返回 null', ratiosFromDrag({ rect: RECT, layout: 'row', ratios: [0.5, 0.5], count: 2, dividerIndex: 5, axis: 'x', position: 100 }) === null)
  void base
}

// ── ② 组规则 ──────────────────────────────────────────────────────────────
group('组规则：TabSplits（domain-tabs）')

const tabsOf = (count: number) => Array.from({ length: count }, (_, index) => ({ tabId: `t${index + 1}`, position: index, splitId: null }))

{
  check('建组：只有 1 个标签 → null', tabSplits.createSplit(tabsOf(2), [], { tabIds: ['t1'], nextSplitId: 's1' }) === null)
  check('建组：超过上限 → null', tabSplits.createSplit(tabsOf(6), [], { tabIds: ['t1', 't2', 't3', 't4', 't5'], nextSplitId: 's1' }) === null)
  check('建组：引用不存在的标签会被剔除（剩 1 个 → null）', tabSplits.createSplit(tabsOf(2), [], { tabIds: ['t1', 'ghost'], nextSplitId: 's1' }) === null)
}

{
  const r = required(tabSplits.createSplit(tabsOf(3), [], { tabIds: ['t2', 't1'], nextSplitId: 's1', layout: 'column' }), 'createSplit')
  check('建组：成功返回组', r && r.split.splitId === 's1')
  check('建组：格序 = tabIds 顺序（不是标签条顺序）', r.split.members.join(',') === 't2,t1')
  check('建组：比例归一化到成员数', r.split.ratios.length === 2)
  check('建组：layout 透传', r.split.layout === 'column')
  check('建组：成员标签拿到 splitId', r.tabs.filter((t) => t.splitId === 's1').length === 2)
  check('建组：非成员不受影响', r.tabs.find((tab) => tab.tabId === 't3')?.splitId === null)
  check('建组：activity 默认取第一个成员', r.split.activeTabId === 't2')
}

{
  // 从旧组搬到新组：旧组只剩 1 人 → 自动解散
  const tabs = tabsOf(4)
  const first = required(tabSplits.createSplit(tabs, [], { tabIds: ['t1', 't2'], nextSplitId: 's1' }), 'first split')
  const second = required(tabSplits.createSplit(first.tabs, first.splits, { tabIds: ['t2', 't3'], nextSplitId: 's2' }), 'second split')
  check('跨组搬运：新组含 t2', second.split.members.includes('t2'))
  check('跨组搬运：旧组退化被解散', second.splits.length === 1 && second.splits[0].splitId === 's2')
  check('跨组搬运：被搬走的标签只属于新组', second.tabs.find((tab) => tab.tabId === 't2')?.splitId === 's2')
  check('跨组搬运：旧组剩下的 t1 指针被清空', second.tabs.find((tab) => tab.tabId === 't1')?.splitId === null)
}

{
  const base = required(tabSplits.createSplit(tabsOf(3), [], { tabIds: ['t1', 't2'], nextSplitId: 's1' }), 'base split')
  const removed = required(tabSplits.removeMember(base.tabs, base.splits, { splitId: 's1', tabId: 't1' }), 'removeMember')
  check('关掉一个成员 → 不足 2 格，整组解散', removed.splits.length === 0)
  check('关掉一个成员 → 剩下那个的指针被清空', removed.tabs.find((tab) => tab.tabId === 't2')?.splitId === null)
}

{
  const base = required(tabSplits.createSplit(tabsOf(3), [], { tabIds: ['t1', 't2', 't3'], nextSplitId: 's1' }), 'base split')
  const removed = required(tabSplits.removeMember(base.tabs, base.splits, { splitId: 's1', tabId: 't1' }), 'removeMember')
  check('3 格关掉 1 个 → 组仍在', removed.splits.length === 1)
  check('3 格关掉 1 个 → 成员变 2', removed.splits[0].members.length === 2)
  check('3 格关掉 1 个 → 比例重新归一化', removed.splits[0].ratios.length === 2)
}

{
  const base = required(tabSplits.createSplit(tabsOf(3), [], { tabIds: ['t1', 't2'], nextSplitId: 's1' }), 'base split')
  const d = required(tabSplits.dissolveSplit(base.tabs, base.splits, { splitId: 's1' }), 'dissolveSplit')
  check('解散：组消失', d.splits.length === 0)
  check('解散：成员标签全部保留（只清指针）', d.tabs.every((t) => t.splitId === null) && d.tabs.length === 3)
  check('解散：回传成员名单', Array.isArray(d.children) && d.children.length === 2)
}

{
  const base = required(tabSplits.createSplit(tabsOf(3), [], { tabIds: ['t1', 't2', 't3'], nextSplitId: 's1' }), 'base split')
  const rv = required(tabSplits.reverseSplit(base.tabs, base.splits, { splitId: 's1' }), 'reverseSplit')
  check('反转：格序反过来', rv.members.join(',') === 't3,t2,t1')
  check('反转：标签条顺序未动（positions 不变）', rv.tabs.map((t) => t.tabId).join(',') === 't1,t2,t3')
}

{
  const base = required(tabSplits.createSplit(tabsOf(6), [], { tabIds: ['t1', 't2'], nextSplitId: 's1' }), 'base split')
  const three = required(tabSplits.moveTabToSplit(base.tabs, base.splits, { tabId: 't3', splitId: 's1' }), 'move t3')
  const four = required(tabSplits.moveTabToSplit(three.tabs, three.splits, { tabId: 't4', splitId: 's1' }), 'move t4')
  const overflow = tabSplits.moveTabToSplit(four.tabs, four.splits, { tabId: 't5', splitId: 's1' })
  check('入组：未满时可以加', three.splitId === 's1')
  check('入组：加到上限（4 格）仍允许', four.splitId === 's1' && four.splits[0].members.length === SPLIT_METRICS.maxPanes)
  check('入组：超过上限后拒绝（返回 null）', overflow === null)
  const out = required(tabSplits.moveTabToSplit(four.tabs, four.splits, { tabId: 't1', splitId: null }), 'move t1 out')
  check('出组：splitId 清空', out.tabs.find((tab) => tab.tabId === 't1')?.splitId === null)
}

{
  const base = required(tabSplits.createSplit(tabsOf(3), [], { tabIds: ['t1', 't2'], nextSplitId: 's1' }), 'base split')
  check('换活动格：非成员被拒', tabSplits.setSplitActive(base.tabs, base.splits, { splitId: 's1', tabId: 't3' }) === null)
  const ok = required(tabSplits.setSplitActive(base.tabs, base.splits, { splitId: 's1', tabId: 't2' }), 'setSplitActive')
  check('换活动格：成员生效', ok.splits[0].activeTabId === 't2')
}

{
  // 悬空引用：标签还在但指向不存在的组 → prune 清指针
  const tabs = [{ tabId: 't1', splitId: 'ghost' }, { tabId: 't2', splitId: null }]
  const pruned = tabSplits.pruneDegenerateSplits(tabs, [{ splitId: 'ghost', layout: 'row', ratios: [0.5, 0.5], members: ['t1'], activeTabId: 't1' }])
  check('裁剪：成员 <2 的组被丢弃', pruned.splits.length === 0)
  check('裁剪：悬空指针被清空', pruned.tabs.find((tab) => tab.tabId === 't1')?.splitId === null)
}

{
  const base = required(tabSplits.createSplit(tabsOf(2), [], { tabIds: ['t1', 't2'], nextSplitId: 's1' }), 'base split')
  const proj = tabSplits.projectSplits(base.tabs, base.splits)
  const one = required(proj.find((pane) => pane.tabId === 't1'), 't1 projection')
  check('投影：带 splitId / index / count', one.splitId === 's1' && one.index === 0 && one.count === 2)
  const none = proj.find((p) => p.tabId === 't9')
  void none
  check('投影：非成员 splitId 为 null', tabSplits.projectSplits([{ tabId: 'z', splitId: null }], []).every((p) => p.splitId === null))
}

// ── ③ 会话契约 ────────────────────────────────────────────────────────────
group('会话契约：schema v4（宽进严出）')

{
  check('版本号已升到 4', SESSION_VERSION === 4)
  const v2 = { version: 2, savedAt: 1, activeTabId: 'a', tabs: [{ tabId: 'a', url: 'https://a.test' }], stacks: [] }
  const parsedV2 = required(parseSessionFile(v2), 'parseSessionFile(v2)')
  check('旧 v2 文件（无 splits 字段）仍能解析', parsedV2 && parsedV2.tabs.length === 1)
  check('旧 v2 文件：splits 回落为空数组', Array.isArray(parsedV2.splits) && parsedV2.splits.length === 0)
}

{
  const v3 = {
    version: 3,
    savedAt: 1,
    activeTabId: 'a',
    tabs: [
      { tabId: 'a', url: 'https://a.test', splitId: 'sp1' },
      { tabId: 'b', url: 'https://b.test', splitId: 'sp1' },
      { tabId: 'c', url: 'https://c.test', splitId: 'ghost' }
    ],
    stacks: [],
    splits: [
      { splitId: 'sp1', layout: 'column', ratios: [0.6, 0.4], members: ['a', 'b'], activeTabId: 'a' },
      { splitId: 'ghost', layout: 'row', ratios: [0.5, 0.5], members: ['c'], activeTabId: 'c' }
    ]
  }
  const parsed = required(parseSessionFile(v3), 'parseSessionFile(v3)')
  check('v3：合法组被保留', parsed.splits.length === 1 && parsed.splits[0].splitId === 'sp1')
  check('v3：layout 与 ratios 透传', parsed.splits[0].layout === 'column' && parsed.splits[0].ratios.length === 2)
  check('v3：成员按**标签指针**重算（trust 指针）', parsed.splits[0].members.join(',') === 'a,b')
  check('v3：退化组（成员 <2）被丢弃', !parsed.splits.some((s) => s.splitId === 'ghost'))
  check('v3：被丢弃组留下的悬空指针被清空', parsed.tabs.find((tab) => tab.tabId === 'c')?.splitId === null)
}

{
  const bad = {
    version: 3,
    savedAt: 1,
    activeTabId: null,
    tabs: [{ tabId: 'a', url: 'https://a.test', splitId: 'sp1' }, { tabId: 'b', url: 'https://b.test', splitId: 'sp1' }],
    stacks: [],
    splits: ['not-an-object', { nope: true }, { splitId: 'sp1', layout: 'row', ratios: [0.5, 0.5], members: ['a', 'b'], activeTabId: 'a' }]
  }
  const parsed = required(parseSessionFile(bad), 'parseSessionFile(bad)')
  check('坏组条目被跳过，好组仍然保留（不为一条脏数据丢整个会话）', parsed.splits.length === 1)
}

// ── ③ 创新增量（比例预设 I2 / 格邻接 I6）────────────────────────────────
group('创新增量：比例预设（I2）与格邻接（I6）')

{
  const even3 = ratiosForPreset('even', 3)
  check('预设 even：3 格均分且和为 1', even3.length === 3 && Math.abs(even3.reduce((a, b) => a + b, 0) - 1) < 1e-9)
  const main70 = ratiosForPreset('main-70', 3)
  check('预设 main-70：3 格 = 70 / 15 / 15', Math.abs(main70[0] - 0.7) < 1e-9 && Math.abs(main70[1] - 0.15) < 1e-9)
  check('预设 main-70：和为 1', Math.abs(main70.reduce((a, b) => a + b, 0) - 1) < 1e-9)
  const main30 = ratiosForPreset('main-30', 2)
  check('预设 main-30：2 格 = 30 / 70', Math.abs(main30[0] - 0.3) < 1e-9 && Math.abs(main30[1] - 0.7) < 1e-9)
  const bogus = ratiosForPreset('什么鬼', 2)
  check('预设非法 → 回落均分', Math.abs(bogus[0] - 0.5) < 1e-9)
  check('单格：预设返回 [1]', JSON.stringify(ratiosForPreset('main-70', 1)) === '[1]')
  // 预设必须真的能喂给求解器（否则"菜单点了但布局没变"）
  const solved = solveSplitPanes({ rect: RECT, layout: 'row', ratios: main70, count: 3 })
  check('预设结果可直接求解且铺满', solved.panes.length === 3)
}

{
  const row3 = solveSplitPanes({ rect: RECT, layout: 'row', ratios: [1, 1, 1], count: 3 })
  check('row/3：中间格向左 → 第 0 格', neighborPaneIndex(row3, 1, 'left') === 0)
  check('row/3：中间格向右 → 第 2 格', neighborPaneIndex(row3, 1, 'right') === 2)
  check('row/3：最左格向左 → 无（null）', neighborPaneIndex(row3, 0, 'left') === null)
  check('row/3：同一行没有上下邻居', neighborPaneIndex(row3, 1, 'up') === null && neighborPaneIndex(row3, 1, 'down') === null)

  const col2 = solveSplitPanes({ rect: RECT, layout: 'column', ratios: [1, 1], count: 2 })
  check('column/2：上格向下 → 下格', neighborPaneIndex(col2, 0, 'down') === 1)
  check('column/2：上格向上 → 无', neighborPaneIndex(col2, 0, 'up') === null)
  check('column/2：同一列没有左右邻居', neighborPaneIndex(col2, 0, 'right') === null)

  const grid4 = solveSplitPanes({ rect: RECT, layout: 'grid', count: 4 })
  check('grid/4：左上格向右 → 右上格', neighborPaneIndex(grid4, 0, 'right') === 1)
  check('grid/4：左上格向下 → 左下格', neighborPaneIndex(grid4, 0, 'down') === 2)
  check('grid/4：左上格向左/向上 → 无', neighborPaneIndex(grid4, 0, 'left') === null && neighborPaneIndex(grid4, 0, 'up') === null)
  check('grid/4：同列优先于错行（右下格向上 → 右上格）', neighborPaneIndex(grid4, 3, 'up') === 1)

  const single = solveSplitPanes({ rect: RECT, layout: 'row', count: 1 })
  check('单格：任何方向都没有邻居', neighborPaneIndex(single, 0, 'right') === null)
  check('不存在的格 → null', neighborPaneIndex(row3, 99, 'left') === null)
  check('非法方向 → null', neighborPaneIndex(row3, 1, 'northwest' as Parameters<typeof neighborPaneIndex>[2]) === null)
}

// ── ④ 宿主侧（infra tabLayout：用户口径上限 / 默认方向）────────────────────
group('宿主侧：用户口径（设置项）与硬上限的交汇')

/**
 * 最小宿主桩 —— 形状与 TabManager 交给 tabLayout 的完全一致（见 tabLayout.js 的文件头契约）。
 * 用它而不是 TabManager：这里要验的是 tabLayout 的规则，不该把 Electron 拖进来。
 */
interface SplitHostTab {
  tabId: string
  position: number
  splitId: string | null
  stackId: string | null
}

type SplitHost = import('../infra/infra-window/src/tabLayout.ts').TabLayoutHost

function fakeHost({ maxPanes, defaultLayout, linkRouting }: {
  maxPanes?: unknown
  defaultLayout?: unknown
  linkRouting?: unknown
} = {}): SplitHost {
  const tabs = new Map<string, SplitHostTab>()
  for (const id of ['t1', 't2', 't3', 't4', 't5']) {
    tabs.set(id, { tabId: id, position: tabs.size, splitId: null, stackId: null })
  }
  return {
    _tabs: tabs,
    _splits: new Map(),
    _stacks: new Map(),
    _tabSplits: tabSplits,
    // 栈规则端口也注入（domain 那条路）—— 顺序类的不变式必须在那条路上也成立
    _tabStacks: tabStacks,
    // 与主进程端口同形：三项都透传（`linkRouting` 未给时由 splitOptionsOf 归一化为 off）
    _getSplitOptions: () => ({ maxPanes, defaultLayout, linkRouting }),
    _ruleInput: () => Array.from(tabs.values()).map((tab) => ({ ...tab })),
    _scheduleEmitChanged() {}
  } as unknown as SplitHost
}

/** 宿主里当前的标签顺序（按 position）—— 不变式的断言都以它为准。 */
function orderOf(host: SplitHost): string[] {
  return Array.from(host._tabs.values()).sort((a, b) => (a.position ?? 0) - (b.position ?? 0)).map((tab) => tab.tabId)
}

function hostTab(host: SplitHost, tabId: string): SplitHostTab {
  return required(host._tabs.get(tabId), `host tab ${tabId}`) as SplitHostTab
}

{
  const host = fakeHost({ maxPanes: 4, defaultLayout: 'column' })
  const created = required(tabLayout.createSplitGroup(host, { tabIds: ['t1', 't2'] }), 'createSplitGroup')
  check('默认方向：未显式指定时取设置里的 column', created && created.layout === 'column')
}

{
  const host = fakeHost({ maxPanes: 2, defaultLayout: 'row' })
  const created = required(tabLayout.createSplitGroup(host, { tabIds: ['t1', 't2', 't3'] }), 'createSplitGroup')
  check('用户上限 2：建组时只取前 2 个标签', created && created.count === 2 && created.children?.length === 2)
  // 组里已满（2 格）→ 再加入被拒（否则"最多 2 格"这个设置形同虚设）
  const rejected = tabLayout.setTabSplit(host, { tabId: 't4', splitId: created.splitId })
  check('用户上限 2：已满时加入被拒（返回 null）', rejected === null)
  const left = tabLayout.setTabSplit(host, { tabId: 't1', splitId: null })
  check('用户上限 2：出组不受限', left && left.splitId === null)
}

{
  // 非法 / 越界的口径一律夹到硬上限与下限之间（设置文件可手改）
  const host = fakeHost({ maxPanes: 99, defaultLayout: 'row' })
  const created = required(tabLayout.createSplitGroup(host, { tabIds: ['t1', 't2', 't3', 't4', 't5'] }), 'createSplitGroup')
  check('maxPanes 越界（99）→ 夹到硬上限', created && created.count === SPLIT_METRICS.maxPanes)
  const host2 = fakeHost({ maxPanes: 'bad', defaultLayout: 'row' })
  const created2 = tabLayout.createSplitGroup(host2, { tabIds: ['t1', 't2'] })
  check('maxPanes 非法 → 回落硬上限（组仍能建起来）', !!created2)
}

{
  // 格间链接路由（I5）的归一化：只有显式选「开在分屏的下一格」才生效
  const host = fakeHost({ maxPanes: 4, defaultLayout: 'row' })
  check('linkRouting 缺省 → off（不改变网页里点击的去向）', tabLayout.splitOptionsOf(host).linkRouting === 'off')
  const hostOn = fakeHost({ maxPanes: 4, defaultLayout: 'row', linkRouting: 'adjacent-pane' })
  check('linkRouting 显式开启 → adjacent-pane', tabLayout.splitOptionsOf(hostOn).linkRouting === 'adjacent-pane')
  const hostBad = fakeHost({ maxPanes: 4, defaultLayout: 'row', linkRouting: '什么鬼' })
  check('linkRouting 非法 → 回落 off', tabLayout.splitOptionsOf(hostBad).linkRouting === 'off')
}

// ── ⑤ 相邻不变式（顺序：分屏成员必须相邻；可见性：成员不入栈）──────────────
group('相邻不变式：成员相邻（回形针）/ 成员不入栈')

{
  // 纯函数层：合拢的锚点 = 成员在现行顺序里**最靠前**的位置（不让标签条大跳）
  check(
    'coalesceSplitRuns：远隔两人合拢到靠前者原位',
    tabSplits.coalesceSplitRuns(['a', 'b', 'c', 'd'], [{ splitId: 's1', members: ['d', 'b'] }]).join(',') === 'a,b,d,c'
  )
  check(
    'coalesceSplitRuns：顺序已合法 → 原样返回',
    tabSplits.coalesceSplitRuns(['a', 'b', 'c'], [{ splitId: 's1', members: ['a', 'b'] }]).join(',') === 'a,b,c'
  )
  check(
    'coalesceSplitRuns：不足 2 个可见成员 → 不参与合拢',
    tabSplits.coalesceSplitRuns(['a', 'b'], [{ splitId: 's1', members: ['b'] }]).join(',') === 'a,b'
  )
  check(
    'coalesceSplitRuns：长度必与输入相同（调用方据此逐位写回 position）',
    tabSplits.coalesceSplitRuns(['a', 'b', 'c', 'd', 'e'], [{ splitId: 's1', members: ['e', 'c'] }]).length === 5
  )
}

{
  // 宿主侧：建组把两个远隔的标签就地合拢，且**一个标签都不丢**
  const host = fakeHost({ maxPanes: 4, defaultLayout: 'row' })
  const created = required(tabLayout.createSplitGroup(host, { tabIds: ['t1', 't4'] }), 'createSplitGroup')
  check('远隔两标签建组 → 顺序里立刻相邻', orderOf(host).join(',') === 't1,t4,t2,t3,t5', orderOf(host).join(','))
  check('建组不丢标签（长度不变）', orderOf(host).length === 5)
  check('合拢锚点在靠前的那个位置', !!created && orderOf(host)[0] === 't1')
}

{
  // 把散标签插到两个成员之间 → 被挤出成员的区间（下次 enforce 就跑掉）
  const host = fakeHost({ maxPanes: 4, defaultLayout: 'row' })
  tabLayout.createSplitGroup(host, { tabIds: ['t1', 't2'] })
  tabLayout.reorder(host, { draggedId: 't4', targetId: 't1', insertAfter: true })
  check('散标签插到两成员之间 → 被挤出区间', orderOf(host).join(',') === 't1,t2,t4,t3,t5', orderOf(host).join(','))
}

{
  // 正交共存（2026-10-17 起）：分屏成员**可以**同时在标签组里 —— enforceSplitRuns
  // 只保证「分屏成员相邻」这一条不变式，绝不碰栈归属（旧裁决"分屏胜栈"已废除）。
  const host = fakeHost({ maxPanes: 4, defaultLayout: 'row' })
  host._stacks.set('s1', { stackId: 's1', label: '', accent: '', collapsed: true })
  tabLayout.createSplitGroup(host, { tabIds: ['t1', 't2'] })
  hostTab(host, 't2').stackId = 's1'
  tabLayout.enforceSplitRuns(host)
  check('分屏成员留在标签组里（stackId 不被摘）', hostTab(host, 't2').stackId === 's1')
  check('栈仍有成员、不被回收', host._stacks.size === 1)
  check('enforce 之后分屏成员仍然相邻', orderOf(host).join(',') === 't1,t2,t3,t4,t5', orderOf(host).join(','))
}

// ── ⑥ 拖动落点（拖标签到网页区域 → 在哪边、怎么排）─────────────────────────
group('拖动落点：resolveDropZone（Zen / Vivaldi 同款预览块的判据）')

interface Rect { x: number; y: number; width: number; height: number }

const PAGE: Rect = { x: 40, y: 80, width: 1000, height: 600 }
const GAP = SPLIT_METRICS.paneGap

/** 取页面里的相对位置（占比），与窗口形状无关 —— 测试也按占比写，才验得出"归一化"这一条。 */
const at = (fractionX: number, fractionY: number) => ({ x: PAGE.x + PAGE.width * fractionX, y: PAGE.y + PAGE.height * fractionY })

{
  check('靠左 → left / row / 新格在前', (() => {
    const z = resolveDropZone({ ...at(0.05, 0.5), rect: PAGE })
    return z && z.zone === 'left' && z.layout === 'row' && z.place === 'start'
  })())
  check('靠右 → right / row / 新格在后', (() => {
    const z = resolveDropZone({ ...at(0.95, 0.5), rect: PAGE })
    return z && z.zone === 'right' && z.layout === 'row' && z.place === 'end'
  })())
  check('靠上 → top / column / 新格在前', (() => {
    const z = resolveDropZone({ ...at(0.5, 0.05), rect: PAGE })
    return z && z.zone === 'top' && z.layout === 'column' && z.place === 'start'
  })())
  check('靠下 → bottom / column / 新格在后', (() => {
    const z = resolveDropZone({ ...at(0.5, 0.95), rect: PAGE })
    return z && z.zone === 'bottom' && z.layout === 'column' && z.place === 'end'
  })())
}

{
  // 归一化判据：**同一个相对位置**在宽窗口与窄窗口里必须判出同一个方向。
  // 若按绝对像素比距离，"离左边 200px"在 2000px 宽里是偏左、在 400px 宽里已是过半，
  // 同一个手势在两种窗口下的结果就会不一样 —— 这是最容易写错的一条。
  const wide = { x: 0, y: 0, width: 2000, height: 400 }
  const narrow = { x: 0, y: 0, width: 400, height: 400 }
  const rel = (rect: Rect, fractionX: number, fractionY: number) => required(
    resolveDropZone({ x: rect.width * fractionX, y: rect.height * fractionY, rect }),
    'resolveDropZone'
  )
  check('宽窗口：相对位置 0.2/0.5 → left', rel(wide, 0.2, 0.5).zone === 'left')
  check('窄窗口：同样的相对位置 → 仍是 left（按占比判，不按像素）', rel(narrow, 0.2, 0.5).zone === 'left')
  check('高窗口：相对位置 0.5/0.8 → bottom', rel({ x: 0, y: 0, width: 600, height: 1600 }, 0.5, 0.8).zone === 'bottom')
  check('扁窗口：同样的相对位置 → 仍是 bottom', rel({ x: 0, y: 0, width: 600, height: 400 }, 0.5, 0.8).zone === 'bottom')
}

{
  // D3「所见即所得」的**纯函数级**保证：预览块矩形 = 求解器给出的那一格再收进 paneGap。
  // 这两条路各自算一遍，任何一边改了算术（divider / 取整 / gap）这条就会红。
  const gap = (pane: Rect): Rect => ({
    x: pane.x + GAP, y: pane.y + GAP,
    width: pane.width - GAP * 2, height: pane.height - GAP * 2
  })
  let same = true
  let checked = 0
  // 混入**奇数**宽/高：`distribute` 的第二格是"总数减第一格"，取整差 1px 的坑就在这里。
  const cases: Array<[Rect, number, number]> = [
    [PAGE, 0.05, 0.5], [PAGE, 0.95, 0.5], [PAGE, 0.5, 0.05], [PAGE, 0.5, 0.95],
    [{ x: 17, y: 33, width: 1001, height: 601 }, 0.03, 0.5],
    [{ x: 17, y: 33, width: 1001, height: 601 }, 0.97, 0.5],
    [{ x: 17, y: 33, width: 1001, height: 601 }, 0.5, 0.03],
    [{ x: 17, y: 33, width: 1001, height: 601 }, 0.5, 0.97]
  ]
  for (const [rect, fx, fy] of cases) {
    const intent = required(resolveDropZone({ x: rect.x + rect.width * fx, y: rect.y + rect.height * fy, rect }), 'drop intent')
    const solved = solveSplitPanes({ rect, layout: intent.layout, ratios: [0.5, 0.5], count: 2 })
    const pane = solved.panes[intent.place === 'start' ? 0 : 1]
    const expect = gap(pane)
    const got = intent.rect
    checked++
    if (got.x !== expect.x || got.y !== expect.y || got.width !== expect.width || got.height !== expect.height) {
      same = false
      console.log(`      · ${intent.zone}@${rect.width}x${rect.height}: 预览 ${JSON.stringify(got)} ≠ 落位 ${JSON.stringify(expect)}`)
    }
  }
  check(`预览块与最终那一格**逐像素一致**（${checked} 个方向，含奇数尺寸）`, same)
}

{
  // 轴级判定：一条轴切不动时**不能**给那两个落点 —— 否则预览块会是个不足 minPane 的窄条，
  // 而真正落位时求解器会把它夹回 minPane（预览 ≠ 结果，踩中 D3）。
  // 200 宽 < 2×120 + 6 = 246 → 左右不可切；600 高足够 → 上下仍可切。
  const narrow = { x: 0, y: 0, width: 200, height: 600 }
  const nearLeft = resolveDropZone({ x: 5, y: 300, rect: narrow })
  check('窄条：给不出左右落点（那条轴切不动）', nearLeft && nearLeft.zone !== 'left' && nearLeft.zone !== 'right')
  const nearTop = resolveDropZone({ x: 100, y: 5, rect: narrow })
  check('窄条：纵向仍可落（top）', nearTop && nearTop.zone === 'top' && nearTop.layout === 'column')
  check('两轴都切不动 → null', resolveDropZone({
    x: 5, y: 5, rect: { x: 0, y: 0, width: 200, height: 200 }, minSpan: 120
  }) === null)
  check('零尺寸矩形 → null', resolveDropZone({ x: 0, y: 0, rect: { x: 0, y: 0, width: 0, height: 0 } }) === null)
  check('非数字坐标 → null', resolveDropZone({ x: NaN, y: 10, rect: PAGE }) === null)
}

{
  // 成员顺序：左/上 = 被拖的在前（第 0 格）；右/下 = 在后。
  check('place=start → 成员顺序 [被拖, 配对]', splitMembersForDrop({ place: 'start' }, 'drag', 'pair').join(',') === 'drag,pair')
  check('place=end → 成员顺序 [配对, 被拖]', splitMembersForDrop({ place: 'end' }, 'drag', 'pair').join(',') === 'pair,drag')
}

// ── ⑦ 落点预览的**会话机**（起表 → 采样 → 推预览 → 松手交意图）──────────────
group('落点预览会话：begin → tick → end（主进程那条 30fps 回路）')

/**
 * 最小宿主桩：与 tab-drop-zone 的 deps 契约同形。
 * `pollMs` 给一个极大的值 —— 本组用 `tick()` 手动驱动，不依赖真实定时器（不引入时序抖动）。
 */
interface DropPair {
  pairId: string | null
  mode: 'split' | 'join' | 'blocked'
  count: number
  maxPanes: number
}

const dropPair = (pairId: string | null, mode: DropPair['mode'], count: number, maxPanes: number): DropPair => ({
  pairId, mode, count, maxPanes
})

interface PreviewPayload {
  mode?: string
  zone?: string | null
  maxPanes?: number
  [key: string]: unknown
}

interface ShownPreview { rect: Rect; payload: PreviewPayload }
type DropZoneDependencies = NonNullable<Parameters<typeof createTabDropZone>[0]>
interface PreviewEdgeInfo { tabId: string; baseTabId: string; pairId: string }

function fakeDropZone({
  page,
  pair,
  cursor,
  previewDelayMs = 0,
  isOverOverlay = () => false,
  now = null,
  extra = {}
}: {
  page: Rect
  pair: DropPair
  cursor: { x: number; y: number }
  previewDelayMs?: number
  isOverOverlay?: () => boolean
  now?: (() => number) | null
  extra?: Partial<DropZoneDependencies>
}): {
  dz: ReturnType<typeof createTabDropZone>
  state: { cursor: { x: number; y: number }; pair: DropPair; hidden: number; shown: ShownPreview[] }
} {
  const state: { cursor: { x: number; y: number }; pair: DropPair; hidden: number; shown: ShownPreview[] } = {
    cursor: { ...cursor }, pair, hidden: 0, shown: []
  }
  const dependencies: DropZoneDependencies = {
    getCursorPoint: () => state.cursor,
    getContentOrigin: () => ({ x: 0, y: 0 }),
    getPageRect: () => page,
    describePair: () => state.pair,
    /**
     * 预览的**停留门禁**在本组一律传 0：这一组验的是"几何算得对不对"，
     * 不是"等没等够 250ms"（那是手感参数，已由 `previewDelayMs` 单点注入）。
     * 门禁与浮层排除这两条新行为由下面两条用例单独守。
     * `now` 只在测门禁那条用例里注入（其余用例用真实时钟即可）。
     */
    previewDelayMs,
    isOverOverlay,
    ...(typeof now === 'function' ? { now } : {}),
    showOverlay: (rect, payload) => state.shown.push({ rect: { ...rect } as Rect, payload: { ...payload } }),
    hideOverlay: () => { state.hidden++ },
    pollMs: 600000,
    // 额外端口（本组之外的用例注入，例如 onPreviewShown / onPreviewHidden）
    ...extra
  }
  const dz = createTabDropZone(dependencies)
  return { dz, state }
}

const DZ_PAGE = { x: 0, y: 60, width: 1200, height: 700 }
const DZ_PAIR = dropPair('b', 'split', 2, 4)

{
  // ① 预览的**停留门禁**：光标刚进网页的那一拍不显示预览（拖动扫过不闪块）。
  //    时钟注入 → **同步**验（不真的睡 250ms，避免脚本里出现异步块）。
  let clock = 1000
  const { dz, state } = fakeDropZone({
    page: DZ_PAGE, pair: DZ_PAIR, cursor: { x: 60, y: 400 }, previewDelayMs: 250, now: () => clock
  })
  dz.begin({ tabId: 'a', baseTabId: 'b' })
  dz.tick(state.cursor)
  check('停留门禁：刚进网页不推预览', state.shown.length === 0)
  /**
   * ⚠ 门禁挡的**不只是显示**：`intent` 也只在框真的画着时才记 ——
   * 用户口径："等落位框显示才能开始判定，他们是一起的。"
   * 这一条原本断言的是**反过来的老行为**（"没画框也算意图，松手仍可分屏"），
   * 而那正是"拖过去、没等框、一松手就凭空分屏"的来源（用户实测反复报过）。
   */
  check('停留门禁：没画框 = 没有意图（这一下不算数）', dz.intent === null)
  clock += 240
  dz.tick(state.cursor)
  check('停留门禁：240ms 仍未浮出', state.shown.length === 0)
  clock += 20
  dz.tick(state.cursor)
  check('停留门禁：停够 250ms 后浮出预览', state.shown.length === 1 && state.shown[0].payload.zone === 'left')
  check('停够之后才有意图（与框同一拍出生，松手才分屏）', !!dz.intent && dz.intent.zone === 'left')
  dz.cancel()
}

{
  // ② **浮层排除**：光标落在"盖住网页的浮层"里时，不算"拖到网页上"（预览与判定都不成立）
  const { dz, state } = fakeDropZone({
    page: DZ_PAGE,
    pair: DZ_PAIR,
    cursor: { x: 60, y: 400 },
    isOverOverlay: () => true
  })
  dz.begin({ tabId: 'a', baseTabId: 'b' })
  dz.tick(state.cursor)
  check('浮层里拖动 → 一个块都不画', state.shown.length === 0)
  check('浮层里拖动 → 不产生落点意图（不会误分屏）', dz.intent === null)
  dz.cancel()
}

{
  const { dz, state } = fakeDropZone({ page: DZ_PAGE, pair: DZ_PAIR, cursor: { x: 60, y: 400 } })
  dz.begin({ tabId: 'a', baseTabId: 'b' })
  check('begin：会话已开始', dz.active === true)
  dz.tick(state.cursor)
  check('靠左落下 → 推出预览（left）', state.shown.length === 1 && state.shown[0].payload.zone === 'left')
  check('预览矩形 = 左格（已收进 paneGap）', state.shown[0].rect.width === Math.round((DZ_PAGE.width - SPLIT_METRICS.divider) / 2) - GAP * 2)
  dz.tick(state.cursor)
  check('同一状态重复采样 → 不重复推（拖动期最低开销）', state.shown.length === 1)
  state.cursor = { x: 1140, y: 400 }
  dz.tick(state.cursor)
  check('跨过中线 → 推一次新方向（right）', state.shown.length === 2 && state.shown[1].payload.zone === 'right')
  const intent = dz.end()
  check('end()：交出最后一次意图（zone=right）', intent && intent.zone === 'right' && intent.pairId === 'b')
  check('end()：会话已收尾', dz.active === false)
  check('end()：浮层已收起', state.hidden >= 1)
}

{
  const { dz, state } = fakeDropZone({ page: DZ_PAGE, pair: DZ_PAIR, cursor: { x: 60, y: 400 } })
  dz.begin({ tabId: 'a', baseTabId: 'b' })
  dz.tick(state.cursor)
  state.cursor = { x: 600, y: 10 } // 网页之上（顶栏）
  dz.tick(state.cursor)
  check('指针离开网页 → 预览立刻收起且不再有落点', state.hidden >= 1 && dz.intent === null)
  check('leave 之后松手 → 意图为 null（不会误建分屏）', dz.end() === null)
}

{
  const { dz, state } = fakeDropZone({ page: DZ_PAGE, pair: dropPair(null, 'split', 0, 0), cursor: { x: 60, y: 400 } })
  dz.begin({ tabId: 'a', baseTabId: '' })
  dz.tick(state.cursor)
  check('没有可配对的对象（只有一个标签）→ 一个块都不画', state.shown.length === 0)
  dz.cancel()
}

{
  const { dz, state } = fakeDropZone({ page: DZ_PAGE, pair: dropPair('b', 'join', 2, 4), cursor: { x: 60, y: 400 } })
  dz.begin({ tabId: 'a', baseTabId: 'b' })
  dz.tick(state.cursor)
  check('落点已在分屏里 → mode=join，且预览覆盖整片内容区（无方向可言）', (() => {
    const p = state.shown[0]
    return p && p.payload.mode === 'join' && p.rect.width === DZ_PAGE.width && p.rect.height === DZ_PAGE.height
  })())
  check('join 的意图不带 zone（提交走"加入那一组"那条路）', dz.end()?.zone === null)
}

{
  const { dz, state } = fakeDropZone({ page: DZ_PAGE, pair: dropPair('b', 'blocked', 4, 4), cursor: { x: 60, y: 400 } })
  dz.begin({ tabId: 'a', baseTabId: 'b' })
  dz.tick(state.cursor)
  check('那一组已满 → mode=blocked 并带上上限（预览明说"放不进去"）', (() => {
    const p = state.shown[0]
    return p && p.payload.mode === 'blocked' && p.payload.maxPanes === 4
  })())
  dz.cancel()
}

// ── ⑧ 内容区跟着框走（D7）：框画着 = 显示配对那一格；框收起 = 回到被拖的那一格 ──
group('落点预览的显隐通报：内容区跟着框走（D7）')

{
  const shown: PreviewEdgeInfo[] = []
  const hidden: PreviewEdgeInfo[] = []
  const { dz, state } = fakeDropZone({
    page: DZ_PAGE,
    pair: DZ_PAIR,
    cursor: { x: 60, y: 400 },
    extra: {
      onPreviewShown: (info: PreviewEdgeInfo | null) => { if (info) shown.push(info) },
      onPreviewHidden: (info: PreviewEdgeInfo | null) => { if (info) hidden.push(info) }
    }
  })
  dz.begin({ tabId: 'a', baseTabId: 'b' })
  dz.tick(state.cursor)
  check('框画出来 → 通报一次，且带上**配对那一格**（切谁不靠猜）',
    shown.length === 1 && shown[0] && shown[0].pairId === 'b' && shown[0].tabId === 'a')
  state.cursor = { x: 1140, y: 400 } // 框还在画着，只是换了方向
  dz.tick(state.cursor)
  check('框还画着（仅换方向）→ 不重复通报（边沿触发）', shown.length === 1 && hidden.length === 0)
  state.cursor = { x: 600, y: 10 } // 离开网页 → 框收起
  dz.tick(state.cursor)
  check('框收起 → 通报一次收起（宿主据此切回被拖的那一格）',
    hidden.length === 1 && hidden[0] && hidden[0].tabId === 'a')
  dz.tick(state.cursor)
  check('收起态重复采样 → 不重复通报', hidden.length === 1)
  // 松手那一拍**不通报收起**：松手之后归谁由提交侧决定（`dropTabOnContent` 建的组
  // 以配对那格为活动格），多通报一次会在同一拍里白切两趟 —— 见 tab-drop-zone 的 deps 说明。
  const intent = dz.end()
  check('end() 不通报收起（交给提交侧）', hidden.length === 1 && intent === null)
  check('整场归档后可以从零再来一轮（下一轮仍会通报）', (() => {
    dz.begin({ tabId: 'a', baseTabId: 'b' })
    state.cursor = { x: 60, y: 400 }
    dz.tick(state.cursor)
    dz.cancel()
    return shown.length === 2 && hidden.length === 2
  })())
}

// ── 汇总 ──────────────────────────────────────────────────────────────────
console.log('\n════════════════════════════════════════')
console.log(`通过 ${passed} / ${passed + failed}`)
if (failed > 0) {
  console.log(`失败 ${failed}：`)
  for (const f of failures) console.log(`  · ${f}`)
  process.exitCode = 1
} else {
  console.log('全部通过 ✓')
}
