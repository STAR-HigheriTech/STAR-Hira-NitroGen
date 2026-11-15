import type { PageRpcRecord } from 'hira://shared/runtime.js'
import type { BookmarksViewMode } from './route.js'

export interface BookmarkNode extends PageRpcRecord {
  id: string
  title: string
  url?: string | null
  nickname?: string
  favicon?: string
  summary?: string
  tags?: string[]
  children?: BookmarkNode[]
  pinned?: boolean
  railPinned?: boolean
  openInSidebar?: boolean
}

export interface BookmarkSnapshot extends PageRpcRecord {
  items: BookmarkNode[]
  folders: BookmarkNode[]
  tags: BookmarkTagSummary[]
  query?: string | null
}

export interface BookmarkTagSummary {
  tag: string
  count?: number
  system?: boolean
}

export interface BookmarkPathItem {
  id: string
  title: string
}

export type BookmarkFeedback =
  | { cancelled: true; error?: never; snap?: never }
  | { cancelled?: false; error: unknown; snap?: never }
  | { cancelled?: false; error?: never; snap: BookmarkSnapshot }

export interface BookmarkBackup {
  file: string
  timestamp?: string
  mtimeMs?: number
  size?: number
}

export interface BookmarkRestoreResult extends PageRpcRecord {
  imported?: number
  pinnedRestored?: number
}

export interface BookmarksDom {
  list: HTMLElement
  tree: HTMLElement
  breadcrumb: HTMLElement
  newBookmark: HTMLButtonElement
  search: HTMLInputElement
  tagBar: HTMLElement
  note: HTMLElement
  feedback: HTMLElement
  batchBar: HTMLElement
  batchCount: HTMLElement
  selectAll: HTMLInputElement
  batchTag: HTMLButtonElement
  batchPin: HTMLButtonElement
  batchRail: HTMLButtonElement
  batchMove: HTMLButtonElement
  aiDigest: HTMLButtonElement
  batchAiDigest: HTMLButtonElement
  batchDelete: HTMLButtonElement
  batchCancel: HTMLButtonElement
  importFile: HTMLInputElement
}

export interface BookmarksState {
  mode: BookmarksViewMode
  folderId: string | null
  path: BookmarkPathItem[]
  query: string
  tag: string
  treeCollapsed: Set<string>
  tagCollapsed: Set<string>
  items: BookmarkNode[]
  tree: BookmarkNode[]
  tags: BookmarkTagSummary[]
  selected: Set<string>
  backupsCount: number
  editingId: string | null
  summaryBox: HTMLElement | null
  renamingId: string | null
  pendingRefresh: boolean
  importFormat: string
  loadFailed: boolean
  lastLoadedAt: number
}

