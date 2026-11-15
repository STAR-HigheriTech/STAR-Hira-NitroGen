// @ts-check
/**
 * Domain: Tabs — 标签「调整视图」组合方法
 *
 * 这一层把底层「单点判定/单点算法」**组合**成上层（APPS / infra）直接可消费的
 * 整块能力，避免每个消费方各自拼装配管。也只做 POJO → POJO。
 *
 * 与 TabRules（哪些该处理）互补：这里回答「整张标签栏长什么样 / 焦点顺序 /
 * 活动清理 / 视口内可见顺序」这类**汇总性**问题。
 *
 * 设计约束同 domain-session / TabRules：
 *   - 零 IO、零 Electron、零时间依赖，`now` 由调用方注入；
 *   - 只 require `./tabUtil`（必要时可再 require `./TabRules#normalize`），**不 require 自己**；
 *   - tabId 一律字符串化比较。
 */

import {
  tabById,
  pinnedCount,
  audioCount,
  focusOrder,
  afterActive
} from './tabUtil'
import { tabRecords, type TabRecord } from './types'

/**
 * 整张标签栏的统计：总数 / 固定数 / 播放声音数。
 * audio 兼容 `t.audio` 或 `t.isAudioPlaying` 两种字段（由 audioCount 收口）。
 * 非数组输入按空列表计。
 * @param {unknown} tabList
 * @returns {{ total: number, pinned: number, audio: number }}
 */
function tabStats(tabList: unknown): { total: number; pinned: number; audio: number } {
  const arr = Array.isArray(tabList) ? tabList : []
  return {
    total: arr.length,
    pinned: pinnedCount(arr),
    audio: audioCount(arr)
  }
}

/**
 * 按固定与否分组（顺序保持输入）。
 * 丢弃无 tabId 的脏数据（跟随 tabUtil 约定），id 字符串化。
 * @param {unknown} tabList
 * @returns {{ pinned: object[], normal: object[] }}
 */
function partitionTabs(tabList: unknown): { pinned: TabRecord[]; normal: TabRecord[] } {
  const out: { pinned: TabRecord[]; normal: TabRecord[] } = { pinned: [], normal: [] }
  for (const tab of tabRecords(tabList)) {
    const clean = { tabId: String(tab.tabId), pinned: !!tab.pinned }
    ;(clean.pinned ? out.pinned : out.normal).push(clean)
  }
  return out
}

/**
 * 焦点顺序：按 `lastActivated` 降序的 tabId 数组（缺失按 0；同值稳定保序）。
 * @param {unknown} tabList
 * @returns {string[]}
 */
function focusOrderIds(tabList: unknown): string[] {
  return focusOrder(tabList)
}

/**
 * 规范化活动 id：若 `activeTabId` 确实存在于列表返回字符串化后的 id，否则返回 null。
 * @param {unknown} tabList
 * @param {unknown} activeTabId
 * @returns {string|null}
 */
function cleanActive(tabList: unknown, activeTabId: unknown): string | null {
  if (activeTabId == null) return null
  return tabById(tabList, activeTabId) ? String(activeTabId) : null
}

/**
 * 活动标签**之后**、且非固定 的 tabId 数组（保持原顺序）。
 * @param {unknown} tabList
 * @param {unknown} activeTabId
 * @returns {string[]}
 */
function visibleAfter(tabList: unknown, activeTabId: unknown): string[] {
  return afterActive(tabList, activeTabId)
}

export {
  tabStats,
  partitionTabs,
  focusOrderIds,
  cleanActive,
  visibleAfter
}
