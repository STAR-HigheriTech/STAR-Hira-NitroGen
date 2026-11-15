// @ts-check
/**
 * Domain: Tabs — 标签领域「额外」纯工具函数（补充，不与 TabRules 重复）
 *
 * TabRules.ts 已提供 normalize / sleepCandidates / othersToClose / rightToClose /
 * undoInsertIndex / reorderIds。这里只补充**另一组**判定/算法，全部 CommonJS、
 * 零 require、零 IO、纯计算，中文注释。
 *
 * 约定：
 *   - 所有 tabId 一律字符串化比较（上游可能是 IPC 数字或内部 uuid）；
 *   - 「TabLike」形状参照 TabRules：`{ tabId, pinned?, audio?, isAudioPlaying?, lastActivated? }`；
 *   - 固定标签 = `pinned` 为真；活动 = tabId 与 activeTabId 相等。
 */

import { isTabRecord, records, tabRecords, type TabRecord } from './types'

/**
 * 判断标签是否固定。
 * @param {{ pinned?: unknown }} tab
 * @returns {boolean}
 */
function isPinned(tab: unknown): boolean {
  return !!tab && typeof tab === 'object' && !!(tab as Record<string, unknown>).pinned
}

/**
 * 判断 tab 是否当前活动（id 统一字符串化后再比较，兼容数字/字符串）。
 * @param {{ tabId?: unknown }} tab
 * @param {unknown} activeTabId
 * @returns {boolean}
 */
function isActive(tab: unknown, activeTabId: unknown): boolean {
  if (!isTabRecord(tab) || activeTabId == null) return false
  return String(tab.tabId) === String(activeTabId)
}

/**
 * 按 key 计数，返回 `Map<name, count>`（如 'pinned' / 'audio'）。
 * 只统计 key 为真的项；空列表返回空 Map。
 * @param {unknown} tabList
 * @param {string} key
 * @returns {Map<string, number>}
 */
function countBy(tabList: unknown, key: string): Map<string, number> {
  let n = 0
  if (Array.isArray(tabList)) {
    for (const tab of records(tabList)) if (tab[key]) n++
  }
  const map = new Map([[key, n]])
  return map
}

/**
 * 按 id 查找标签，返回匹配项或 null。
 * @param {unknown} tabList
 * @param {unknown} id
 * @returns {object|null}
 */
function tabById(tabList: unknown, id: unknown): TabRecord | null {
  const want = String(id)
  return tabRecords(tabList).find((tab) => String(tab.tabId) === want) || null
}

/**
 * 返回 id 在列表中的下标，找不到返回 -1。
 * @param {unknown} tabList
 * @param {unknown} id
 * @returns {number}
 */
function indexOfId(tabList: unknown, id: unknown): number {
  return tabRecords(tabList).findIndex((tab) => String(tab.tabId) === String(id))
}

/**
 * 固定标签数量。
 * @param {unknown} tabList
 * @returns {number}
 */
function pinnedCount(tabList: unknown): number {
  return records(tabList).filter((tab) => tab.pinned).length
}

/**
 * 播放声音的标签数量（兼容 `tab.audio` 或 `tab.isAudioPlaying` 两种字段）。
 * @param {unknown} tabList
 * @returns {number}
 */
function audioCount(tabList: unknown): number {
  return records(tabList).filter((tab) => tab.audio || tab.isAudioPlaying).length
}

/**
 * 把 id 移动到 0<=toIndex<=len 的合法下标（含两端）。
 * 无效（非数组 / id 不存在 / toIndex 越界）返回 `{ ok: false }`。
 * @param {unknown} ids 现存 id 顺序
 * @param {unknown} id 要移动的 id
 * @param {number} toIndex 目标下标
 * @returns {{ ok: true, ids: string[] } | { ok: false }}
 */
function moveIdTo(ids: unknown, id: unknown, toIndex: number): { ok: true; ids: string[] } | { ok: false } {
  if (!Array.isArray(ids)) return { ok: false }
  const list = ids.map(String)
  const idx = list.indexOf(String(id))
  if (idx < 0) return { ok: false }
  if (!Number.isInteger(toIndex)) return { ok: false }
  if (toIndex < 0 || toIndex > list.length) return { ok: false }

  const next = list.slice()
  next.splice(idx, 1)
  next.splice(toIndex, 0, String(id))
  return { ok: true, ids: next }
}

/**
 * 按 `lastActivated` 降序返回 tabId 数组（先按活动时间，缺失按 0；稳定性靠同值保序）。
 * @param {unknown} tabList
 * @returns {string[]}
 */
function focusOrder(tabList: unknown): string[] {
  return tabRecords(tabList)
    .map((tab) => ({ id: String(tab.tabId), la: typeof tab.lastActivated === 'number' ? tab.lastActivated : 0 }))
    .sort((a, b) => b.la - a.la)
    .map((x) => x.id)
}

/**
 * 按是否固定归一化分组。
 * 先按 TabRules 的 normalize 语义收敛（丢弃无 tabId 脏数据、id 字符串化），再分两组。
 * @param {unknown} tabList
 * @returns {{ pinned: object[], normal: object[] }}
 */
function groupByListOf(tabList: unknown): { pinned: TabRecord[]; normal: TabRecord[] } {
  // 零 require：这里内联一个最小化「规范化」步骤，仅保留 tabId/pinned。
  const pinned: TabRecord[] = []
  const normal: TabRecord[] = []
  for (const tab of tabRecords(tabList)) {
    const clean = { tabId: String(tab.tabId), pinned: !!tab.pinned }
    ;(clean.pinned ? pinned : normal).push(clean)
  }
  return { pinned, normal }
}

/**
 * 两个标签是否同一（tabId 相同）。
 * @param {unknown} a
 * @param {unknown} b
 * @returns {boolean}
 */
function isSameTab(a: unknown, b: unknown): boolean {
  if (!isTabRecord(a) || !isTabRecord(b)) return false
  return String(a.tabId) === String(b.tabId)
}

/**
 * 活动标签**之后**（不含固定）的 tabId 数组（保持原顺序）。
 * 活动不存在 / 固定标签不参与。
 * @param {unknown} tabList
 * @param {unknown} activeTabId
 * @returns {string[]}
 */
function afterActive(tabList: unknown, activeTabId: unknown): string[] {
  const tabs = tabRecords(tabList)
  const active = String(activeTabId)
  const out: string[] = []
  let started = false
  for (const tab of tabs) {
    if (String(tab.tabId) === active) {
      started = true
      continue
    }
    if (started && !tab.pinned) out.push(String(tab.tabId))
  }
  return out
}

export {
  isPinned,
  isActive,
  countBy,
  tabById,
  indexOfId,
  pinnedCount,
  audioCount,
  moveIdTo,
  focusOrder,
  groupByListOf,
  isSameTab,
  afterActive
}
