import type { TabPreviewFacts } from './tabPreviewFacts'

/**
 * 纵向标签行的公开协议。
 * 数据、意图、菜单、预览和拖放都用端口表达；扩展方只依赖本文件即可接入，
 * 不需要耦合 DOM 实现、IPC 或任何具体面板。
 */

export type TabRowId = string | number

export interface TabRowItemBase {
  [key: string]: unknown
  type?: 'tab' | 'stack'
  tabId?: TabRowId
  stackId?: TabRowId | null
  pinned?: boolean
  splitLinkAfter?: boolean
  accent?: string | null
}

export interface TabRowTab extends TabRowItemBase {
  type?: 'tab'
  tabId: TabRowId
  title?: string
  url?: string
  favicon?: string
  active?: boolean
  muted?: boolean
  isPlaying?: boolean
  incognito?: boolean
  permissionIcons?: readonly string[] | null
}

export interface TabRowStack extends TabRowItemBase {
  type: 'stack'
  stackId: string
  label?: string
  count?: number
  collapsed?: boolean
  children?: string[]
}

export type TabRowItem = TabRowTab | TabRowStack

export type TabRowIntentType =
  | 'switch'
  | 'close'
  | 'toggle-mute'
  | 'permission'
  | 'split-with'
  | 'toggle-stack'
  | 'new-tab'
  | (string & {})

export interface TabRowIntent {
  [key: string]: unknown
  type: TabRowIntentType
  tabId?: string
  stackId?: string
}

export interface TabRowDropTarget {
  [key: string]: unknown
  kind: 'tab' | 'stack' | 'strip'
  tabId?: string
  stackId?: string | null
  insertAfter?: boolean
}

export interface TabRowDragEndPayload {
  [key: string]: unknown
  draggedId: string
  targetId?: string
  insertAfter?: boolean
  targetStackId?: string
  targetStackPinned?: boolean
  draggedStackId?: string | null
  stackWithItem?: TabRowItem
  leaveStack?: boolean
}

export interface TabRowExternalDragItem {
  [key: string]: unknown
  domain?: string
  id?: TabRowId
  tabId?: TabRowId
  kind?: string
  url?: string
  title?: string
}

export interface TabRowPreviewOverlay {
  [key: string]: unknown
  showTabPreview?: (payload: TabPreviewFacts) => void
  hideTabPreview?: () => void
  warmTabPreview?: () => void
}

export interface TabRowMenuPopupOptions {
  items?: unknown[]
  x?: number
  y?: number
  context?: unknown
}

export interface TabRowMenuClient {
  [key: string]: unknown
  popupMenu?: (options: TabRowMenuPopupOptions) => string | null | Promise<string | null>
}

export interface TabRowStackMenuHandlers {
  [key: string]: unknown
  dissolveStack?: (stackId: string) => unknown
  tileStack?: (stackId: string, tabIds: string[]) => unknown
  merge?: (stackId: string, targetStackId: string) => unknown
  setColor?: (stackId: string, accent: string) => unknown
}

export interface TabRowListOptions {
  [key: string]: unknown
  onIntent?: (intent: TabRowIntent) => void
  showMenu?: (
    x: number,
    y: number,
    tab: Partial<TabRowTab>,
    nextItem: TabRowItem | null
  ) => Promise<string | null> | string | null | void
  onDragEnd?: (payload: TabRowDragEndPayload) => void
  overlay?: TabRowPreviewOverlay | null
  menu?: TabRowMenuClient | null
  filter?: (item: TabRowItem) => boolean
  emptyText?: string | (() => string)
  dragKind?: string
  showAddButton?: boolean
  searchable?: boolean
  /** false = 完全关闭行入场 / 退场 / FLIP / 音频按钮动效。 */
  motion?: boolean
  onSearch?: (query: string) => void
  onRenameStack?: (stackId: string, label: string) => void
  onExternalDrop?: (item: TabRowExternalDragItem, target: TabRowDropTarget) => void
  stackMenu?: TabRowStackMenuHandlers
  onDropOnContent?: (tabId: string, baseTabId: string) => void
  onDropOnContentBegin?: (tabId: string, baseTabId: string) => void
  onDropOnContentCancel?: () => void
}

export interface TabRowListController {
  element: HTMLDivElement
  setItems: (tabs: readonly TabRowItem[]) => void
  focusSearch: () => boolean
  beginRenameStack: (stackId: string) => boolean
  dispose: () => void
}
