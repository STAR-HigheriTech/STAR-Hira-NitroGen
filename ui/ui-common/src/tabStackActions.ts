/** 标签组共用的种类策略与落库动作映射。 */

import { canJoinStack, canLeaveStack, canStackTogether, sameKind } from '@hira-ng/shared-types/src/tab-policy.mjs'

export type TabId = string | number

export interface StackKindRecord {
  pinned: boolean
}

export interface TabStackItem {
  tabId?: TabId | null
  stackId?: TabId | null
  pinned?: boolean
  type?: string
}

export interface CreateStackInput {
  tabIds: string[]
  pinned?: boolean
  label?: string
}

/** UI 只需要这一层能力，不直接耦合具体 IPC 客户端。 */
export interface TabStackClient {
  setTabStack: (tabId: string, stackId: string | null) => Promise<unknown>
  createStack: (input: CreateStackInput) => Promise<unknown>
  togglePin?: (tabId: string) => Promise<unknown>
  reorder?: (input: { draggedId: string; targetId: string; insertAfter: boolean }) => Promise<unknown>
}

export interface StackPlace {
  targetId?: string
  insertAfter?: boolean
}

export type StackRequest = Promise<unknown> | null

function idOf(dragged: TabId | TabStackItem | null | undefined): string {
  if (dragged == null) return ''
  return typeof dragged === 'object'
    ? String(dragged.tabId == null ? '' : dragged.tabId)
    : String(dragged)
}

function asKindRecord(item: unknown): StackKindRecord | null {
  if (!item || typeof item !== 'object') return null
  return { pinned: (item as TabStackItem).pinned === true }
}

/** 将拖拽项与落点解析为同一组的落库动作；跨种类或无效输入返回 null。 */
export function stackTogether(
  tabsClient: TabStackClient | null | undefined,
  dragged: TabId | TabStackItem | null | undefined,
  target: TabStackItem | null | undefined
): StackRequest {
  if (!tabsClient || !dragged || !target) return null

  const draggedId = idOf(dragged)
  if (!draggedId) return null
  const draggedKind = asKindRecord(dragged)
  const draggedStackId = typeof dragged === 'object' && dragged.stackId != null
    ? String(dragged.stackId)
    : null

  if (target.type === 'stack' && target.stackId != null) {
    if (draggedKind && !canJoinStack(draggedKind, asKindRecord(target))) return null
    return tabsClient.setTabStack(draggedId, String(target.stackId))
  }

  const targetTabId = target.tabId ? String(target.tabId) : ''
  if (!targetTabId || targetTabId === draggedId) return null
  if (draggedKind && !canStackTogether(draggedKind, asKindRecord(target))) return null
  if (target.stackId != null) return tabsClient.setTabStack(draggedId, String(target.stackId))
  if (draggedStackId == null) return tabsClient.createStack({ tabIds: [draggedId, targetTabId] })

  // 目标仍是散标签时让目标并入被拖组，保留原组 label/accent 与其余成员。
  return tabsClient.setTabStack(targetTabId, draggedStackId)
}

/** 离开标签组；固定标签走取消固定，普通标签先清归属再按需落位。 */
export function leaveStack(
  tabsClient: TabStackClient | null | undefined,
  dragged: TabId | Pick<TabStackItem, 'tabId' | 'pinned'> | null | undefined,
  place?: StackPlace | null
): StackRequest {
  if (!tabsClient || dragged == null) return null

  const draggedId = idOf(dragged)
  if (!draggedId) return null
  const kind = asKindRecord(dragged)
  if (kind && !canLeaveStack(kind)) {
    return typeof tabsClient.togglePin === 'function' ? tabsClient.togglePin(draggedId) : null
  }

  const exit = tabsClient.setTabStack(draggedId, null)
  const targetId = place?.targetId ? String(place.targetId) : ''
  if (!targetId) return exit
  return Promise.resolve(exit).then(() =>
    tabsClient.reorder?.({ draggedId, targetId, insertAfter: place?.insertAfter === true })
  )
}

/** 从扁平标签或投影中查找 tabId / stackId 对应的种类记录。 */
export function kindOfItem(
  items: readonly TabStackItem[] | null | undefined,
  id: TabId | null | undefined
): StackKindRecord | null {
  const key = String(id == null ? '' : id)
  if (!key || !Array.isArray(items)) return null

  const hit = items.find((item) => item && (
    (item.tabId != null && String(item.tabId) === key) ||
    (item.stackId != null && String(item.stackId) === key)
  ))
  return hit ? { pinned: hit.pinned === true } : null
}

/** 拖拽高亮与落库共用同一个种类判据；缺信息时放行给主进程兜底。 */
export function canDropOnItem(
  items: readonly TabStackItem[] | null | undefined,
  draggedId: TabId,
  targetId: TabId
): boolean {
  const dragged = kindOfItem(items, draggedId)
  const target = kindOfItem(items, targetId)
  return !dragged || !target || sameKind(dragged, target)
}

export function isPinnedItem(
  items: readonly TabStackItem[] | null | undefined,
  id: TabId | null | undefined
): boolean {
  const record = kindOfItem(items, id)
  return record?.pinned === true
}

/** 落库失败由下一次 tab:changed 纠正；此处只防止未处理拒绝。 */
export function fireStackRequest(request: StackRequest): StackRequest {
  request?.catch(() => {})
  return request
}

export const PINNED_STACK_LABEL = '固定标签'
export const STACK_LABEL = '标签组'
export const PINNED_STACK_KIND = '固定标签组'
export const STACK_KIND = '标签组'
export const NEW_PINNED_STACK_LABEL = '新建固定标签组'

export function stackKindLabel(pinned: boolean): string {
  return pinned ? PINNED_STACK_KIND : STACK_KIND
}

export interface StackLabelSource {
  label?: unknown
  pinned?: boolean
}

export function stackDisplayLabel(stack?: StackLabelSource | null): string {
  if (!stack) return ''
  const name = typeof stack.label === 'string' ? stack.label.trim() : ''
  if (name) return name
  return stack.pinned ? PINNED_STACK_LABEL : STACK_LABEL
}

export interface PinnedFolderLabelSource {
  label?: unknown
  count?: unknown
}

export function pinnedFolderMenuLabel(folder?: PinnedFolderLabelSource | null): string {
  const count = Number(folder?.count) || 0
  const label = stackDisplayLabel({ label: folder?.label, pinned: true })
  return `${label}${count ? `（${count}）` : ''}`
}
