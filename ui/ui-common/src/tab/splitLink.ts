/**
 * 分屏「连接判据」的**唯一真源** —— 投影 → 相邻项之间是否连着同组伙伴。
 *
 * 判据只负责事实，不负责外观或摆放。横向合体、纵向合体和回形针都消费这一份结果，
 * 新增标记时不需要在各宿主重新推导一遍。
 */

export interface SplitLinkItem {
  tabId?: string | number | null
  splitLinkAfter?: boolean
}

export interface SplitLinkRun {
  /** 这一组连续成员的复用键（至少 2 个）。 */
  keys: string[]
  /** 与 keys 一一对应的 tabId。 */
  tabIds: string[]
}

export interface SplitLinkPair {
  beforeKey: string
  afterKey: string
  /** 前一项的 tabId（回形针挂它上面）。 */
  tabId: string
}

export interface SplitMarks {
  /** 连续成员组（横向 / 纵向合体口径）。 */
  runs: SplitLinkRun[]
  /** 每一对相邻成员（回形针口径）。 */
  pairs: SplitLinkPair[]
}

export type SplitKeyOf<T extends SplitLinkItem> = (item: T) => string

/**
 * 投影 → 分屏连接的全部标记视图。一次扫描同时生成 runs 与 pairs。
 */
export function splitMarks<T extends SplitLinkItem>(
  items: readonly T[] | null | undefined,
  keyOf?: SplitKeyOf<T> | null
): SplitMarks {
  const list = Array.isArray(items) ? items : []
  const runs: SplitLinkRun[] = []
  const pairs: SplitLinkPair[] = []
  if (typeof keyOf !== 'function') return { runs, pairs }

  let i = 0
  while (i < list.length) {
    const head = list[i]
    if (!head || !head.splitLinkAfter) {
      i += 1
      continue
    }

    // 从 i 一直吃到最后一个仍与下一项相连的成员。
    let last = i
    while (last + 1 < list.length && list[last]?.splitLinkAfter) last += 1

    const keys: string[] = []
    const tabIds: string[] = []
    for (let k = i; k <= last; k += 1) {
      const item = list[k]
      if (!item) continue
      keys.push(String(keyOf(item)))
      tabIds.push(item.tabId == null ? '' : String(item.tabId))
    }

    if (keys.length >= 2) {
      runs.push({ keys, tabIds })
      for (let k = 0; k < keys.length - 1; k += 1) {
        pairs.push({ beforeKey: keys[k], afterKey: keys[k + 1], tabId: tabIds[k] })
      }
    }
    i = last + 1
  }

  return { runs, pairs }
}

/** 投影 → 「哪两个相邻项之间要画回形针」。 */
export function splitLinkPairs<T extends SplitLinkItem>(
  items: readonly T[] | null | undefined,
  keyOf?: SplitKeyOf<T> | null
): SplitLinkPair[] {
  return splitMarks(items, keyOf).pairs
}
