/** Public contracts shared by the horizontal tab bar and reusable tab-bar primitives. */

import type { PopMenu } from '@hira-ng/ui-common'
import type { DragItem } from '@hira-ng/shared-types/src/drag-item.mjs'

export type UnknownRecord = Record<string, unknown>
export type IntentHandler = (...args: never[]) => unknown
export type IntentHandlers = Record<string, IntentHandler>

export interface TabViewState extends UnknownRecord {
  type?: 'tab'
  tabId: string
  url?: string
  title?: string
  favicon?: string
  active?: boolean
  muted?: boolean
  isPlaying?: boolean
  isLoading?: boolean
  pinned?: boolean
  incognito?: boolean
  containerProfileId?: string | null
  permissionIcons?: readonly string[] | null
  stackId?: string | null
  splitLinkAfter?: boolean
}

export interface TabStackState extends UnknownRecord {
  type: 'stack'
  stackId: string
  tabId?: string
  splitLinkAfter?: boolean
  label?: string
  count?: number
  accent?: string
  collapsed?: boolean
  pinned?: boolean
  children?: readonly TabViewState[]
}

export type TabbarProjectionItem = TabViewState | TabStackState
export type TabbarProjection = readonly (TabbarProjectionItem | null | undefined)[]
export type TabPatch = Partial<TabViewState>
export type StackPatch = Partial<TabStackState>
export type ProjectionPatch = TabPatch & StackPatch

export type TabDecorator = (payload: UnknownRecord) => HTMLElement | null | void

export interface TabPreviewOverlayPort {
  showTabPreview: (payload: unknown) => void
  hideTabPreview?: () => void
  warmTabPreview?: () => void
  [key: string]: unknown
}

export interface TabbarRendererSlots {
  itemDecorator?: TabDecorator
  stackDecorator?: TabDecorator
  dropTargetAccepter?: (payload: UnknownRecord) => unknown
}

export interface TabbarOptions extends UnknownRecord {
  onSwitchTab?: (tabId: string) => unknown
  onToggleStack?: (stackId: string) => unknown
  onRenameStack?: (stackId: string, label: string) => unknown
  onStackWith?: IntentHandler
  onCloseTab?: (tabId: string) => unknown
  onNewTab?: () => unknown
  onDragEnd?: (payload: UnknownRecord) => unknown
  onCloseOthers?: (tabId: string) => unknown
  onCloseRight?: (tabId: string) => unknown
  onTogglePin?: (tabId: string) => unknown
  onToggleMute?: (tabId: string) => unknown
  onDuplicate?: (tabId: string) => unknown
  onReload?: (tabId: string) => unknown
  onGoBack?: (tabId: string) => unknown
  onGoForward?: (tabId: string) => unknown
  onUndoClose?: () => unknown
  onPermissionClick?: (tabId: string) => unknown
  onAutoRefresh?: (tabId: string, intervalMs: number) => unknown
  onSharePage?: (tab: TabViewState) => unknown
  onLeaveStack?: (tabId: string) => unknown
  onGroupByDomain?: (tabIds: string[], domain: string) => unknown
  onArchive?: (tabId: string) => unknown
  onSplitWithActive?: (tabId: string) => unknown
  onDropOnContent?: (tabId: string, baseTabId: string) => unknown
  onDropOnContentBegin?: (tabId: string, baseTabId: string) => unknown
  onDragHintChange?: (active: boolean) => unknown
  onExternalDrop?: (item: DragItem, target: UnknownRecord) => unknown
  tabMenuHandlers?: IntentHandlers
  stackMenu?: IntentHandlers
  showMenu?: PopMenu
  overlay?: TabPreviewOverlayPort
  slots?: TabbarRendererSlots
}

export interface TabbarController {
  element: HTMLElement
  renderTabs: (items: TabbarProjection) => void
  setDropHint: (active: boolean) => void
  dispose: () => void
}

export interface TabComponentController {
  element: HTMLElement
  update: (patch: TabPatch) => void
}

export interface TabStackComponentController {
  element: HTMLElement
  update: (patch: StackPatch) => void
}

export interface TabPreviewController {
  show: (anchor: HTMLElement, tab: TabViewState) => void
  hide: () => void
  hideIfTab: (tabId: string) => void
  destroy: () => void
}

export interface RenderRecord<TItem extends TabbarProjectionItem = TabbarProjectionItem> {
  key: string
  node: HTMLElement
  state: TabViewState | TabStackState
  item: TItem
  update: (patch: ProjectionPatch) => void
}

export interface TabRendererController {
  render: (items: TabbarProjection) => void
  getItems: () => TabbarProjectionItem[]
  getNode: (key: string) => HTMLElement | null
}

export interface DropTargetDescription extends UnknownRecord {
  kind: 'tab' | 'stack' | 'strip'
  tabId?: string
  stackId?: string | null
  insertAfter?: boolean
}

export interface DropPayload extends UnknownRecord {
  draggedId: string
  targetId?: string
  targetStackId?: string
  targetStackPinned?: boolean
  stackWithItem?: TabbarProjectionItem
  draggedStackId?: string | null
  insertAfter?: boolean
  leaveStack?: boolean
}
