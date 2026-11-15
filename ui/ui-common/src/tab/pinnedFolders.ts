/** 固定文件夹领域原语：空文件夹、添加标签、换文件夹和列表查询。 */

import { stackDisplayLabel } from '../tabStackActions'

export interface PinnedFolderCreateInput {
  tabIds: string[]
  pinned: true
  label?: string
}

export interface PinnedFolderClient {
  createStack?: (input: PinnedFolderCreateInput) => Promise<unknown>
  addToPinnedGroup?: (tabId: string, stackId: string) => Promise<unknown>
  setTabStack?: (tabId: string, stackId: string) => Promise<unknown>
  listStacks?: () => Promise<readonly PinnedStackSource[]>
}

export interface PinnedStackSource {
  stackId?: string | number | null
  label?: unknown
  count?: unknown
  accent?: unknown
  pinned?: boolean
}

export interface PinnedFolderSummary {
  stackId: string
  label: string
  count: number
  accent: string
}

function folderLabel(label?: string): string {
  return stackDisplayLabel({ label, pinned: true })
}

/** 建一个空固定文件夹，稍后通过右键或拖拽添加标签。 */
export function createPinnedFolder(
  tabsClient: PinnedFolderClient | null | undefined,
  label?: string
): Promise<unknown> | null {
  if (!tabsClient || typeof tabsClient.createStack !== 'function') return null
  return tabsClient.createStack({ tabIds: [], pinned: true, label: folderLabel(label) })
}

/** 新建固定文件夹并直接放入一条标签。 */
export function pinTabToNewFolder(
  tabsClient: PinnedFolderClient | null | undefined,
  tabId: string,
  label?: string
): Promise<unknown> | null {
  if (!tabsClient || typeof tabsClient.createStack !== 'function') return null
  return tabsClient.createStack({
    tabIds: [String(tabId)],
    pinned: true,
    ...(typeof label === 'string' && label.trim() ? { label: label.trim() } : {})
  })
}

/** 移入已有固定文件夹；优先走 pin 通道，旧客户端才回退 setTabStack。 */
export function moveTabToPinnedFolder(
  tabsClient: PinnedFolderClient | null | undefined,
  tabId: string,
  stackId: string
): Promise<unknown> | null {
  if (!tabsClient || tabId == null || stackId == null) return null
  if (typeof tabsClient.addToPinnedGroup === 'function') {
    return tabsClient.addToPinnedGroup(String(tabId), String(stackId))
  }
  if (typeof tabsClient.setTabStack === 'function') {
    return tabsClient.setTabStack(String(tabId), String(stackId))
  }
  return null
}

/** 列表包含空文件夹；显示名与成员口径统一由共用件裁定。 */
export async function listPinnedFolders(
  tabsClient: PinnedFolderClient | null | undefined
): Promise<PinnedFolderSummary[]> {
  if (!tabsClient || typeof tabsClient.listStacks !== 'function') return []
  try {
    const stacks = await tabsClient.listStacks()
    return (Array.isArray(stacks) ? stacks : [])
      .filter((stack) => stack && stack.pinned && stack.stackId != null)
      .map((stack) => ({
        stackId: String(stack.stackId),
        label: stackDisplayLabel(stack),
        count: Number(stack.count) || 0,
        accent: typeof stack.accent === 'string' ? stack.accent : ''
      }))
  } catch {
    return []
  }
}
