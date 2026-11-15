/**
 * TabSplits.ts —— 分屏组的**纯规则**（零状态、零 IO、零 electron，可单测）
 *
 * 与 `TabStacks.ts` 同模：本文件只回答「给定当前标签与分屏组，操作之后应该是什么样」，
 * 不持有任何运行时数据，也不产生副作用 —— 一切从宿主读、以「结果增量」交回宿主。
 *
 * ── 与「标签栈」的关系：**正交，不打一个字段** ──────────────────────
 *   标签栈 stack = 收纳（一次只见一个成员）
 *   分屏   split = 并列（全部成员同时可见）
 * 一个标签可以同时在某个栈里、又参与某个分屏。把两者塞进一个分组字段，
 * 将来每加一个分组维度都要改该字段的语义 —— 那是"松松垮垮最后无法维护"的起点。
 * 因此本模块只认 `tab.splitId`，完全不看 `tab.stackId`。
 *
 * ── 数据形状 ────────────────────────────────────────────────────
 *   tab.splitId  : string | null          归属指针（与 stackId 并列）
 *   split        : {
 *     splitId,                 // 组标识
 *     layout,                  // 'row' | 'column' | 'grid'（形态是**数据**，不是分支）
 *     ratios: number[],        // 各格占比，长度 = members.length，和恒为 1
 *     members: string[],       // **格的顺序**（独立于标签条顺序 → 反转格不动标签）
 *     activeTabId              // 活动格（焦点与地址栏的归属）
 *   }
 *
 * `members` 为什么必须显式存：格的顺序与标签条顺序是两件事（Firefox 的
 * "Reverse Tabs" 只换格、不重排标签条）。靠"从 tabList 顺序推导"就做不到这件事。
 *
 * 尺寸口径（maxPanes / 最小格 / 分隔条厚）**不在这里** —— 真源是
 * `@hira-ng/shared-types/src/split-layout.mjs#SPLIT_METRICS`（主进程、渲染层共读一份）。
 */

const {
  SPLIT_METRICS,
  normalizeSplitLayout,
  normalizeSplitRatios,
  normalizeSplitCount
} = require('@hira-ng/shared-types/src/split-layout.mjs')
const { canSplit } = require('@hira-ng/shared-types/src/tab-policy.mjs')
import {
  asRecord,
  tabRecords,
  type SplitMutationResult,
  type SplitRecord,
  type TabRecord
} from './types'

/** 归一化单个分屏组；非法（无 id）返回 null。 */
function normalizeSplit(value: unknown): SplitRecord | null {
  const split = asRecord(value)
  if (!split || split.splitId == null) return null
  const members = Array.isArray(split.members)
    ? split.members.map((id) => String(id)).filter(Boolean)
    : []
  return {
    splitId: String(split.splitId),
    layout: normalizeSplitLayout(split.layout),
    members,
    ratios: normalizeSplitRatios(split.ratios, Math.max(1, members.length)),
    activeTabId: split.activeTabId == null ? null : String(split.activeTabId)
  }
}

/** 归一化整份组列表（剔非法项）。 */
function normalizeSplits(splitList: unknown): SplitRecord[] {
  return (Array.isArray(splitList) ? splitList : [])
    .map(normalizeSplit)
    .filter((split): split is SplitRecord => split !== null)
}

/** 组在列表中的下标；不存在返回 -1。 */
function splitIndexOf(splitList: unknown, splitId: unknown): number {
  return normalizeSplits(splitList).findIndex((split) => split.splitId === String(splitId))
}

/** 组内的标签记录（按 `members` 顺序，而不是标签条顺序）。 */
function splitMembers(tabList: unknown, split: unknown): TabRecord[] {
  const list = tabRecords(tabList)
  const byId = new Map(list.map((tab) => [String(tab.tabId), tab]))
  const normalized = normalizeSplit(split)
  if (!normalized) return []
  return normalized.members
    .map((id) => byId.get(id))
    .filter((tab): tab is TabRecord => tab !== undefined)
}

/**
 * 从「标签 + 组列表」算出某个标签所属的组（没有则 null）。
 * @param {Array<object>} tabList
 * @param {Array<object>} splitList
 * @param {string} tabId
 */
function splitOfTab(tabList: unknown, splitList: unknown, tabId: unknown): SplitRecord | null {
  const id = String(tabId)
  const tab = tabRecords(tabList).find((t) => String(t.tabId) === id)
  if (!tab || tab.splitId == null) return null
  return normalizeSplits(splitList).find((split) => split.splitId === String(tab.splitId)) || null
}

/**
 * **退化裁剪**（对齐 `pruneEmptyStacks` + 会话侧的二次校验）：
 *   · 成员 <2（关掉一个 / 悬空引用 / 组里只剩自己）→ 丢整组；
 *   · 成员超过上限 → 截断到上限；
 *   · 被丢掉的组，其成员标签的 `splitId` 一并清空（不留悬空指针）。
 *
 * 为什么必须"清悬空指针"：`splitId` 指着不存在的组时，UI 会以为自己在分屏里
 * （tab 条画 badge、激活时找组找不到），而视图层又按单视图摆 —— 表现就是
 * "标签有条纹但只有一个网页"。清掉即回到普通标签。
 *
 * @param {Array<object>} tabList
 * @param {Array<object>} splitList
 * @returns {{ tabs: Array<object>, splits: Array<object> }}
 */
function pruneDegenerateSplits(tabList: unknown, splitList: unknown): SplitMutationResult {
  const tabs = Array.isArray(tabList) ? tabList as TabRecord[] : []
  const byId = new Map(tabs.filter((tab) => tab?.tabId != null).map((tab) => [String(tab.tabId), tab]))
  const maxPanes = SPLIT_METRICS.maxPanes
  const kept: SplitRecord[] = []
  const keptIds = new Set<string>()
  for (const raw of normalizeSplits(splitList)) {
    const members = raw.members
      .filter((id) => {
        const tab = byId.get(id)
        return tab && tab.splitId != null && String(tab.splitId) === raw.splitId
      })
      .slice(0, maxPanes)
    if (members.length < 2) continue
    kept.push({
      ...raw,
      members,
      ratios: normalizeSplitRatios(raw.ratios, members.length),
      activeTabId: raw.activeTabId != null && members.includes(raw.activeTabId) ? raw.activeTabId : members[0]
    })
    keptIds.add(raw.splitId)
  }
  const nextTabs = tabs.map((tab) =>
    tab && tab.splitId != null && !keptIds.has(String(tab.splitId)) ? { ...tab, splitId: null } : tab
  )
  return { tabs: nextTabs, splits: kept }
}

/**
 * 建组：把 `tabIds` 指定的标签组成一个分屏。
 *
 * 规则（每条都对应一个真实边界）：
 *   · 至少 2 个、最多 `SPLIT_METRICS.maxPanes` 个，否则返回 null（由调用方给出原因）；
 *   · 标签必须存在；成员若原本在别的组里 → **先从旧组移出**（旧组随之退化裁剪）；
 *   · `members` 顺序 = tabIds 给出的顺序（格的顺序，不是标签条顺序）；
 *   · `activeTabId` 取成员里当前活动的那个，找不到就取第一个。
 *
 * @param {Array<object>} tabList
 * @param {Array<object>} splitList
 * @param {{ tabIds?: string[], layout?: unknown, nextSplitId?: string, ratios?: unknown, activeTabId?: string|null }} [options]
 * @returns {{ split: object, tabs: Array<object>, splits: Array<object>, count: number, children: string[] }|null}
 */
function createSplit(
  tabList: unknown,
  splitList: unknown,
  options: Record<string, unknown> = {}
): (SplitMutationResult & { split: SplitRecord; count: number; children: string[] }) | null {
  const tabs = Array.isArray(tabList) ? tabList as TabRecord[] : []
  const byId = new Map(tabs.filter((tab) => tab?.tabId != null).map((tab) => [String(tab.tabId), tab]))
  const ordered: string[] = []
  const seen = new Set<string>()
  for (const raw of Array.isArray(options.tabIds) ? options.tabIds : []) {
    const id = String(raw)
    if (seen.has(id) || !byId.has(id)) continue
    // 固定标签不参与分屏（能力表裁决，见 shared-types#tab-policy）；其余合法成员照常建组，
    // 而不是整组拒绝 —— 与 infra 侧「用户上限裁掉多余成员」的口径一致。
    if (!canSplit(byId.get(id))) continue
    seen.add(id)
    ordered.push(id)
  }
  if (ordered.length < 2 || ordered.length > SPLIT_METRICS.maxPanes) return null
  const splitId = options.nextSplitId == null ? '' : String(options.nextSplitId)
  if (!splitId) return null
  if (splitIndexOf(splitList, splitId) >= 0) return null

  // ⚠ 判据只能看"是否本次成员"，**不能**再要求 `tab.splitId != null`：
  //   全新标签的 splitId 本来就是 null，加那个条件会让"从零建组"整组拿不到指针，
  //   紧跟其后的 prune 立刻把组当退化组丢掉 —— 表现是「建组成功但什么都没发生」。
  const nextTabs = tabs.map((tab) =>
    tab && seen.has(String(tab.tabId)) ? { ...tab, splitId } : tab
  )
  const activeId = options.activeTabId != null ? String(options.activeTabId) : null
  const split = {
    splitId,
    layout: normalizeSplitLayout(options.layout),
    members: ordered,
    ratios: normalizeSplitRatios(options.ratios, ordered.length),
    activeTabId: activeId && ordered.includes(activeId) ? activeId : ordered[0]
  }
  const pruned = pruneDegenerateSplits(nextTabs, [...normalizeSplits(splitList), split])
  return { split, tabs: pruned.tabs, splits: pruned.splits, count: ordered.length, children: ordered }
}

/**
 * 把单个标签移入/移出某个组（`splitId` 传 null 即出组）。
 * 目标组已满 → 返回 null（调用方给出"最多 N 格"的说明）。
 */
function moveTabToSplit(
  tabList: unknown,
  splitList: unknown,
  { tabId, splitId }: { tabId?: unknown; splitId?: unknown } = {}
): (SplitMutationResult & { tabId: string; splitId: string | null }) | null {
  const id = String(tabId)
  const tabs = Array.isArray(tabList) ? tabList as TabRecord[] : []
  const tab = tabs.find((t) => String(t.tabId) === id)
  if (!tab) return null
  const targetId = splitId == null ? null : String(splitId)
  const splits = normalizeSplits(splitList)
  let nextSplits = splits
  if (targetId) {
    // 固定标签不能被拉进分屏（能力表裁决）；出组永远允许。
    if (!canSplit(tab)) return null
    const index = splitIndexOf(splits, targetId)
    if (index < 0) return null
    const target = splits[index]
    if (!target.members.includes(id) && target.members.length >= SPLIT_METRICS.maxPanes) return null
    nextSplits = splits.map((split) =>
      split.splitId === targetId
        ? { ...split, members: split.members.includes(id) ? split.members : [...split.members, id] }
        : { ...split, members: split.members.filter((member: string) => member !== id) }
    )
  } else {
    nextSplits = splits.map((split) => ({ ...split, members: split.members.filter((member: string) => member !== id) }))
  }
  const nextTabs = tabs.map((t) => (t && String(t.tabId) === id ? { ...t, splitId: targetId } : t))
  const pruned = pruneDegenerateSplits(nextTabs, nextSplits)
  return { tabId: id, splitId: targetId, tabs: pruned.tabs, splits: pruned.splits }
}

/**
 * 从组里移出一个成员（关闭该标签时调用）。
 * 移出后不足 2 格 → 整组解散（对齐 Firefox "关掉任意一侧即解散"）。
 */
function removeMember(
  tabList: unknown,
  splitList: unknown,
  { splitId, tabId }: { splitId?: unknown; tabId?: unknown } = {}
): (SplitMutationResult & { tabId: string; splitId: string }) | null {
  const id = String(tabId)
  const targetId = String(splitId)
  const tabs = Array.isArray(tabList) ? tabList as TabRecord[] : []
  const splits = normalizeSplits(splitList)
  const index = splitIndexOf(splits, targetId)
  if (index < 0) return null
  const nextSplits = splits.map((split) =>
    split.splitId === targetId ? { ...split, members: split.members.filter((member: string) => member !== id) } : split
  )
  const nextTabs = tabs.map((t) => (t && String(t.tabId) === id ? { ...t, splitId: null } : t))
  const pruned = pruneDegenerateSplits(nextTabs, nextSplits)
  return { tabId: id, splitId: targetId, tabs: pruned.tabs, splits: pruned.splits }
}

/** 解散一个组：**全部成员保留**，只清归属（对齐 Edge 的 "Separate two tabs"）。 */
function dissolveSplit(
  tabList: unknown,
  splitList: unknown,
  { splitId }: { splitId?: unknown } = {}
): (SplitMutationResult & { splitId: string; children: string[] }) | null {
  const targetId = String(splitId)
  const splits = normalizeSplits(splitList)
  if (splitIndexOf(splits, targetId) < 0) return null
  const target = splits.find((split) => split.splitId === targetId)
  if (!target) return null
  const memberIds = target.members
  const tabs = (Array.isArray(tabList) ? tabList as TabRecord[] : []).map((tab) =>
    tab && String(tab.splitId) === targetId ? { ...tab, splitId: null } : tab
  )
  return {
    splitId: targetId,
    tabs,
    splits: splits.filter((split) => split.splitId !== targetId),
    children: memberIds
  }
}

/** 改形态（row / column / grid）。形态是数据 —— 不产生任何摆位分支。 */
function setSplitLayout(
  tabList: unknown,
  splitList: unknown,
  { splitId, layout }: { splitId?: unknown; layout?: unknown } = {}
): { splitId: string; layout: SplitRecord['layout']; tabs: TabRecord[]; splits: SplitRecord[] } | null {
  const targetId = String(splitId)
  const splits = normalizeSplits(splitList)
  const index = splitIndexOf(splits, targetId)
  if (index < 0) return null
  const split = { ...splits[index], layout: normalizeSplitLayout(layout) }
  const next = splits.slice()
  next[index] = split
  return { splitId: targetId, layout: split.layout, tabs: Array.isArray(tabList) ? tabList : [], splits: next }
}

/** 改比例（分隔条拖拽落库）。长度不匹配时按成员数归一化。 */
function setSplitRatios(
  tabList: unknown,
  splitList: unknown,
  { splitId, ratios }: { splitId?: unknown; ratios?: unknown } = {}
): { splitId: string; ratios: number[]; tabs: TabRecord[]; splits: SplitRecord[] } | null {
  const targetId = String(splitId)
  const splits = normalizeSplits(splitList)
  const index = splitIndexOf(splits, targetId)
  if (index < 0) return null
  const count = Math.max(2, splits[index].members.length)
  const split = { ...splits[index], ratios: normalizeSplitRatios(ratios, count) }
  const next = splits.slice()
  next[index] = split
  return { splitId: targetId, ratios: split.ratios, tabs: Array.isArray(tabList) ? tabList : [], splits: next }
}

/** 设活动格。tabId 必须是该组成员，否则返回 null（不静默忽略）。 */
function setSplitActive(
  tabList: unknown,
  splitList: unknown,
  { splitId, tabId }: { splitId?: unknown; tabId?: unknown } = {}
): { splitId: string; tabId: string; tabs: TabRecord[]; splits: SplitRecord[] } | null {
  const targetId = String(splitId)
  const id = String(tabId)
  const splits = normalizeSplits(splitList)
  const index = splitIndexOf(splits, targetId)
  if (index < 0) return null
  if (!splits[index].members.includes(id)) return null
  const split = { ...splits[index], activeTabId: id }
  const next = splits.slice()
  next[index] = split
  return { splitId: targetId, tabId: id, tabs: Array.isArray(tabList) ? tabList : [], splits: next }
}

/** 反转格的顺序（对齐 Firefox "Reverse Tabs"）：**只换格，不动标签条顺序**。 */
function reverseSplit(
  tabList: unknown,
  splitList: unknown,
  { splitId }: { splitId?: unknown } = {}
): { splitId: string; members: string[]; tabs: TabRecord[]; splits: SplitRecord[] } | null {
  const targetId = String(splitId)
  const splits = normalizeSplits(splitList)
  const index = splitIndexOf(splits, targetId)
  if (index < 0) return null
  const split = { ...splits[index], members: splits[index].members.slice().reverse() }
  const next = splits.slice()
  next[index] = split
  return { splitId: targetId, members: split.members, tabs: Array.isArray(tabList) ? tabList : [], splits: next }
}

/**
 * 投影给渲染层：每个标签 + 它所在的组（画标签条 badge / 活动格高亮用）。
 * 纯数据，不含任何 DOM 或视图对象。
 */
function projectSplits(
  tabList: unknown,
  splitList: unknown
): Array<{ tabId: string; splitId: string | null; layout?: SplitRecord['layout']; index?: number; count?: number; active?: boolean }> {
  const tabs = tabRecords(tabList)
  const splits = normalizeSplits(splitList)
  const byId = new Map(splits.map((split) => [split.splitId, split]))
  return tabs.map((tab) => {
    const splitId = tab.splitId == null ? null : String(tab.splitId)
    const split = splitId ? byId.get(splitId) : null
    if (!split) return { tabId: String(tab.tabId), splitId: null }
    return {
      tabId: String(tab.tabId),
      splitId: split.splitId,
      layout: split.layout,
      index: split.members.indexOf(String(tab.tabId)),
      count: split.members.length,
      active: split.activeTabId === String(tab.tabId)
    }
  })
}

/**
 * 分屏成员在标签顺序里**必须相邻**（Edge / Firefox 同款）——中间不许夹别的标签。
 *
 * 这是**标签顺序的一条不变式**，因此做成纯函数（顺序进、顺序出，不改任何记录），
 * 由宿主在**每一个写顺序的地方**调用一次统一强制：
 *   · 谁先谁后不变：组内次序保持"现行顺序"（用户拖拽时看到的就是它）；
 *   · 锚点 = 组内成员在现行顺序里**最靠前**的位置 —— 整组在那里一次性吐出。
 *     于是"远隔的两个人建组"不会把整组搬到列表末尾（那会让标签条大跳一次），
 *     而是在靠前那个人的位置就地合拢。
 *   · 不足 2 个可见成员的组**不参与**（退化组由 pruneDegenerateSplits 负责清）。
 *
 * @param {string[]} order 现行顺序（全部标签 id）
 * @param {Array<{members?: string[]}>} splits 组列表
 * @returns {string[]} 合拢后的顺序（长度必与输入相同，故调用方可以放心逐位写回 position）
 */
function coalesceSplitRuns(order: unknown, splits: unknown): string[] {
  const list = (Array.isArray(order) ? order : []).map(String)
  if (list.length === 0) return list
  const index = new Map(list.map((id, i) => [id, i]))
  const runs: Array<{ members: string[]; at: number }> = []
  for (const split of Array.isArray(splits) ? splits : []) {
    const raw = asRecord(split)
    const members = (raw && Array.isArray(raw.members) ? raw.members : [])
      .map(String)
      .filter((id) => index.has(id))
    if (members.length < 2) continue
    members.sort((a, b) => (index.get(a) ?? 0) - (index.get(b) ?? 0))
    runs.push({ members, at: index.get(members[0]) ?? 0 })
  }
  // 一组都没成形 / 已经在原位 → 原样返回（调用方据此跳过写回，不发无意义的一次变更）
  if (runs.length === 0) return list
  runs.sort((a, b) => a.at - b.at)
  const owner = new Map<string, { members: string[]; at: number }>()
  for (const run of runs) for (const id of run.members) owner.set(id, run)
  const emitted = new Set<{ members: string[]; at: number }>()
  const out: string[] = []
  for (const id of list) {
    const run = owner.get(id)
    if (!run) {
      out.push(id)
      continue
    }
    if (emitted.has(run)) continue
    emitted.add(run)
    for (const member of run.members) out.push(member)
  }
  return out
}

export {
  normalizeSplit,
  normalizeSplits,
  splitIndexOf,
  splitMembers,
  splitOfTab,
  pruneDegenerateSplits,
  createSplit,
  moveTabToSplit,
  removeMember,
  dissolveSplit,
  setSplitLayout,
  setSplitRatios,
  setSplitActive,
  reverseSplit,
  projectSplits,
  coalesceSplitRuns
}
