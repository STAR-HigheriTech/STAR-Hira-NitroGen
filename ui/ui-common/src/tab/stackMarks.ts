/**
 * 标签组「成员标记」判据 —— 投影里哪些标签属于真正可见的组。
 *
 * 横向标签条与纵向行列表共享这一份事实：可见组必须有组项、成员必须紧跟组项，
 * 组行只有后面接着同组成员时才让出连线条槽位。
 */

export interface StackMarkItem {
  type?: string
  stackId?: string | number | null
  tabId?: string | number | null
  accent?: string | null
}

export interface StackMarks {
  /** 本轮真有组项的标签组 id。 */
  visibleStackIds: Set<string>
  /** 成员行 key → 所属组 id；非成员不在表内。 */
  memberStackByKey: Map<string, string>
  /** 后面紧跟同组成员（已展开）的组行 key。 */
  stackKeysWithMembers: Set<string>
}

export type StackKeyOf<T extends StackMarkItem> = (item: T) => string

function defaultKeyOf(item: StackMarkItem): string {
  if (!item) return ''
  return item.type === 'stack' ? `stack:${item.stackId}` : `tab:${item.tabId}`
}

/** 投影 → 标签组标记。纯函数，不读取 DOM 或全局状态。 */
export function stackMarks<T extends StackMarkItem>(
  items: readonly T[] | null | undefined,
  keyOf?: StackKeyOf<T> | null
): StackMarks {
  const list = Array.isArray(items) ? items : []
  const keyOfItem = typeof keyOf === 'function' ? keyOf : defaultKeyOf
  const visibleStackIds = new Set<string>()

  for (const item of list) {
    if (item?.type === 'stack' && item.stackId != null) {
      visibleStackIds.add(String(item.stackId))
    }
  }

  const visibleStackOf = (item: T | undefined): string => {
    if (!item || item.type === 'stack' || item.stackId == null) return ''
    const stackId = String(item.stackId)
    return visibleStackIds.has(stackId) ? stackId : ''
  }

  const memberStackByKey = new Map<string, string>()
  const stackKeysWithMembers = new Set<string>()

  for (let i = 0; i < list.length; i += 1) {
    const item = list[i]
    if (!item) continue

    const stackId = visibleStackOf(item)
    if (stackId) {
      memberStackByKey.set(String(keyOfItem(item)), stackId)
      continue
    }

    if (item.type === 'stack' && item.stackId != null) {
      if (visibleStackOf(list[i + 1]) === String(item.stackId)) {
        stackKeysWithMembers.add(String(keyOfItem(item)))
      }
    }
  }

  return { visibleStackIds, memberStackByKey, stackKeysWithMembers }
}
