// @ts-check
/**
 * TabGroups.ts —— Glance 速览组的**纯规则**（零状态、零 IO、零 electron，可单测）
 *
 * 与 `TabStacks.ts` / `TabSplits.ts` 同模：本文件只回答「给定当前标签与速览组，
 * 操作之后应该是什么样」，不持有任何运行时数据，也不产生副作用 ——
 * 一切从宿主读、以「结果增量」交回宿主。
 *
 * ── 与「标签栈」「分屏」的关系：三条正交的分组维度 ──────────────────
 *   标签栈 stack = 收纳（一次只见一个成员）
 *   分屏   split = 并列（全部成员同时可见，平分内容区）
 *   速览   glance = 叠放（**恰好两个**：一个压一个，前面的略小）
 * 三者各自一个字段（`tab.stackId` / `tab.splitId` / `tab.glanceId`），互不读取。
 * 把任何两个塞进一个字段，将来每加一个分组维度都要改该字段语义 —— 那正是
 * "松松垮垮最后无法维护"的起点。
 *
 * ── 数据形状 ────────────────────────────────────────────────────
 *   tab.glanceId : string | null          归属指针（与 stackId / splitId 并列）
 *   glance       : {
 *     glanceId,                 // 组标识
 *     members: string[],        // **恰好 2 个**：[backId, frontId]
 *     frontTabId                // 前面那张（浮在上面的速览页）
 *   }
 *
 * ── 几何口径 ────────────────────────────────────────────────────
 * 卡片矩形（front 85%×100% / back 95%×97.5%、居中取整）的真源是
 * `@hira-ng/shared-types/src/glance-layout.mjs`（主进程、渲染层共读一份）——
 * 本文件只在 `glanceBoundsOf` 里转发，绝不在此重写一份算术。
 */

const { GLANCE_METRICS, glanceBounds } = require('@hira-ng/shared-types/src/glance-layout.mjs')
const { canGlance } = require('@hira-ng/shared-types/src/tab-policy.mjs')
import {
  asRecord,
  tabRecords,
  type Bounds,
  type GlanceMutationResult,
  type GlanceRecord,
  type TabRecord
} from './types'

/** 归一化单个速览组；非法（无 id）返回 null。成员恒取前 2 个。 */
function normalizeGlance(value: unknown): GlanceRecord | null {
  const glance = asRecord(value)
  if (!glance || glance.glanceId == null) return null
  const members: string[] = []
  const seen = new Set<string>()
  for (const raw of Array.isArray(glance.members) ? glance.members : []) {
    const id = raw == null ? '' : String(raw)
    if (!id || seen.has(id)) continue
    seen.add(id)
    members.push(id)
    if (members.length >= GLANCE_METRICS.members) break
  }
  const front = glance.frontTabId == null ? '' : String(glance.frontTabId)
  return {
    glanceId: String(glance.glanceId),
    members,
    frontTabId: members.includes(front) ? front : (members[0] || '')
  }
}

/** 归一化整份组列表（剔非法项）。 */
function normalizeGlances(glanceList: unknown): GlanceRecord[] {
  return (Array.isArray(glanceList) ? glanceList : [])
    .map(normalizeGlance)
    .filter((glance): glance is GlanceRecord => glance !== null)
}

/** 组在列表中的下标；不存在返回 -1。 */
function glanceIndexOf(glanceList: unknown, glanceId: unknown): number {
  return normalizeGlances(glanceList).findIndex((glance) => glance.glanceId === String(glanceId))
}

/** 从「标签 + 组列表」算出某个标签所属的速览组（没有则 null）。 */
function glanceOfTab(tabList: unknown, glanceList: unknown, tabId: unknown): GlanceRecord | null {
  const id = String(tabId)
  const tab = tabRecords(tabList).find((t) => String(t.tabId) === id)
  if (!tab || tab.glanceId == null) return null
  return normalizeGlances(glanceList).find((glance) => glance.glanceId === String(tab.glanceId)) || null
}

/**
 * **退化裁剪**：速览的定义就是"恰好两张"——任何不是恰好两个可见成员的组一律丢掉，
 * 其成员标签的 `glanceId` 一并清空（不留悬空指针，否则 UI 会以为自己在速览里而视图层按单页摆）。
 *
 * @param {Array<object>} tabList
 * @param {Array<object>} glanceList
 * @returns {{ tabs: Array<object>, glances: Array<object> }}
 */
function pruneDegenerateGlances(tabList: unknown, glanceList: unknown): GlanceMutationResult {
  const tabs = Array.isArray(tabList) ? tabList as TabRecord[] : []
  const byId = new Map(tabs.filter((tab) => tab?.tabId != null).map((tab) => [String(tab.tabId), tab]))
  const kept: GlanceRecord[] = []
  const keptIds = new Set<string>()
  for (const raw of normalizeGlances(glanceList)) {
    const members = raw.members.filter((id) => {
      const tab = byId.get(id)
      if (!tab || tab.glanceId == null || String(tab.glanceId) !== raw.glanceId) return false
      // 种类能力裁决：固定标签不参与速览（能力表，见 shared-types#tab-policy）。
      return canGlance(tab)
    })
    if (members.length !== GLANCE_METRICS.members) continue
    kept.push({
      ...raw,
      members,
      frontTabId: members.includes(raw.frontTabId) ? raw.frontTabId : members[0]
    })
    keptIds.add(raw.glanceId)
  }
  const nextTabs = tabs.map((tab) =>
    tab && tab.glanceId != null && !keptIds.has(String(tab.glanceId)) ? { ...tab, glanceId: null } : tab
  )
  return { tabs: nextTabs, glances: kept }
}

/**
 * 建组：把 `tabIds` 指定的**两个**标签组成速览。
 *
 * 规则（每条都对应一个真实边界）：
 *   · 必须恰好是 2 个**不同**的、存在的标签，否则返回 null（由调用方给出原因）；
 *   · 成员若原本在别的速览组里 → 先从旧组移出（旧组随之退化裁剪）；
 *   · `members` 顺序 = `[back, front]`；`frontTabId` 缺省取第二个（"速览页"通常是被点的那张）。
 *
 * @param {Array<object>} tabList
 * @param {Array<object>} glanceList
 * @param {{ tabIds?: string[], nextGlanceId?: string, frontTabId?: string|null }} [options]
 * @returns {{ glance: object, tabs: Array<object>, glances: Array<object>, count: number, children: string[] }|null}
 */
function createGlance(
  tabList: unknown,
  glanceList: unknown,
  options: Record<string, unknown> = {}
): (GlanceMutationResult & { glance: GlanceRecord; count: number; children: string[] }) | null {
  const tabs = Array.isArray(tabList) ? tabList as TabRecord[] : []
  const byId = new Map(tabs.filter((tab) => tab?.tabId != null).map((tab) => [String(tab.tabId), tab]))
  const ordered: string[] = []
  const seen = new Set<string>()
  for (const raw of Array.isArray(options.tabIds) ? options.tabIds : []) {
    const id = String(raw)
    if (seen.has(id) || !byId.has(id)) continue
    // 固定标签不参与速览（能力表裁决）—— 不足两张时下面按原口径返回 null。
    if (!canGlance(byId.get(id))) continue
    seen.add(id)
    ordered.push(id)
    if (ordered.length >= GLANCE_METRICS.members) break
  }
  if (ordered.length !== GLANCE_METRICS.members) return null
  const glanceId = options.nextGlanceId == null ? '' : String(options.nextGlanceId)
  if (!glanceId) return null
  if (glanceIndexOf(glanceList, glanceId) >= 0) return null

  const nextTabs = tabs.map((tab) =>
    tab && seen.has(String(tab.tabId)) ? { ...tab, glanceId } : tab
  )
  const declaredFront = options.frontTabId == null ? '' : String(options.frontTabId)
  const glance = {
    glanceId,
    members: ordered,
    frontTabId: ordered.includes(declaredFront) ? declaredFront : ordered[ordered.length - 1]
  }
  const pruned = pruneDegenerateGlances(nextTabs, [...normalizeGlances(glanceList), glance])
  return { glance, tabs: pruned.tabs, glances: pruned.glances, count: ordered.length, children: ordered }
}

/**
 * 交换前后：把 `tabId` 提为 front（另一张自动成为 back）。必须是本组成员，否则 null。
 * @returns {{ glanceId:string, tabId:string, tabs:Array<object>, glances:Array<object> }|null}
 */
function setGlanceFront(
  tabList: unknown,
  glanceList: unknown,
  { glanceId, tabId }: { glanceId?: unknown; tabId?: unknown } = {}
): { glanceId: string; tabId: string; tabs: TabRecord[]; glances: GlanceRecord[] } | null {
  const targetId = String(glanceId)
  const id = String(tabId)
  const glances = normalizeGlances(glanceList)
  const index = glanceIndexOf(glances, targetId)
  if (index < 0) return null
  if (!glances[index].members.includes(id)) return null
  const glance = { ...glances[index], frontTabId: id }
  const next = glances.slice()
  next[index] = glance
  return { glanceId: targetId, tabId: id, tabs: Array.isArray(tabList) ? tabList : [], glances: next }
}

/**
 * 解散一个速览组：**两张标签都保留**，只清归属（回到普通标签）。
 * @returns {{ glanceId:string, tabs:Array<object>, glances:Array<object>, children:string[] }|null}
 */
function dissolveGlance(
  tabList: unknown,
  glanceList: unknown,
  { glanceId }: { glanceId?: unknown } = {}
): (GlanceMutationResult & { glanceId: string; children: string[] }) | null {
  const targetId = String(glanceId)
  const glances = normalizeGlances(glanceList)
  const found = glances.find((glance) => glance.glanceId === targetId)
  if (!found) return null
  const tabs = (Array.isArray(tabList) ? tabList as TabRecord[] : []).map((tab) =>
    tab && String(tab.glanceId) === targetId ? { ...tab, glanceId: null } : tab
  )
  return {
    glanceId: targetId,
    tabs,
    glances: glances.filter((glance) => glance.glanceId !== targetId),
    children: found.members.slice()
  }
}

/**
 * 关闭标签时的速览收尾：速览的定义是"恰好两张"，少一张即**整组解散**
 * （另一张回到普通标签，不复活已关闭的那张）。
 * @returns {{ glanceId:string, tabs:Array<object>, glances:Array<object>, children:string[] }|null}
 */
function removeTabFromGlance(
  tabList: unknown,
  glanceList: unknown,
  { glanceId, tabId }: { glanceId?: unknown; tabId?: unknown } = {}
): (GlanceMutationResult & { glanceId: string; children: string[] }) | null {
  const targetId = String(glanceId)
  const id = String(tabId)
  const found = normalizeGlances(glanceList).find((glance) => glance.glanceId === targetId)
  if (!found) return null
  const tabs = (Array.isArray(tabList) ? tabList as TabRecord[] : []).map((tab) =>
    tab && String(tab.glanceId) === targetId ? { ...tab, glanceId: null } : tab
  )
  return {
    glanceId: targetId,
    tabs,
    glances: normalizeGlances(glanceList).filter((glance) => glance.glanceId !== targetId),
    children: found.members.filter((member) => member !== id)
  }
}

/**
 * 投影给渲染层：每个标签 + 它所在的速览组（画"速览"角标 / 前后高亮用）。
 * 纯数据，不含任何 DOM 或视图对象。
 */
function projectGlances(
  tabList: unknown,
  glanceList: unknown
): Array<{ tabId: string; glanceId: string | null; front?: boolean; peerTabId?: string | null }> {
  const tabs = tabRecords(tabList)
  const glances = normalizeGlances(glanceList)
  const byId = new Map(glances.map((glance) => [glance.glanceId, glance]))
  return tabs.map((tab) => {
    const glanceId = tab.glanceId == null ? null : String(tab.glanceId)
    const glance = glanceId ? byId.get(glanceId) : null
    if (!glance) return { tabId: String(tab.tabId), glanceId: null }
    return {
      tabId: String(tab.tabId),
      glanceId: glance.glanceId,
      front: glance.frontTabId === String(tab.tabId),
      peerTabId: glance.members.find((member) => member !== String(tab.tabId)) || null
    }
  })
}

/** 卡片几何的转发（真源在 shared-types/glance-layout.mjs）。 */
function glanceBoundsOf(pageBounds: unknown, isFront: boolean): Bounds {
  return glanceBounds(pageBounds, isFront)
}

export {
  GLANCE_METRICS,
  normalizeGlance,
  normalizeGlances,
  glanceIndexOf,
  glanceOfTab,
  pruneDegenerateGlances,
  createGlance,
  setGlanceFront,
  dissolveGlance,
  removeTabFromGlance,
  projectGlances,
  glanceBoundsOf
}
