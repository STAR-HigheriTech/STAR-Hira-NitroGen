export type NoteKind = 'note' | 'page' | 'image' | 'snippet' | 'ref'
export type NoteRefMode = 'chip' | 'link' | 'inline'
export type NoteRefOrigin = 'card' | 'inline'

export type NoteChangeReason =
  | 'add'
  | 'update'
  | 'remove'
  | 'move'
  | 'reorder'
  | 'restore'
  | 'purge'
  | 'folder-add'
  | 'folder-update'
  | 'folder-remove'

export interface NoteChange {
  reason: NoteChangeReason
  id: string | null
}

export interface NoteRow {
  id: string
  profileId: string
  folderId: string | null
  title: string
  content: string
  url: string | null
  tags: string | null
  color: string | null
  pinned: number
  sortOrder: number
  kind: NoteKind
  sourceTitle: string | null
  assetPath: string | null
  assetMime: string | null
  assetWidth: number | null
  assetHeight: number | null
  thumbPath: string | null
  refId: string | null
  refMode: NoteRefMode | null
  deletedAt: number | null
  createdAt: number
  modifiedAt: number
}

export interface Note extends Omit<NoteRow, 'tags' | 'pinned'> {
  tags: string[]
  pinned: boolean
}

export interface BacklinkNote extends Note {
  missing?: boolean
}

export interface NoteFolder {
  id: string
  profileId: string
  parentId: string | null
  name: string
  sortOrder: number
  createdAt: number
}

export interface AddNoteInput {
  title?: string
  content?: string
  folderId?: string | null
  url?: string | null
  tags?: string[]
  color?: string | null
  kind?: NoteKind
  sourceTitle?: string | null
  assetPath?: string | null
  assetMime?: string | null
  assetWidth?: number
  assetHeight?: number
  thumbPath?: string | null
  refId?: string | null
  refMode?: NoteRefMode | null
}

export interface UpdateNoteInput extends Omit<AddNoteInput, 'kind'> {
  pinned?: boolean
}

export interface CaptureNoteInput extends AddNoteInput {
  kind?: NoteKind
}

export interface ListNotesOptions {
  folderId?: string | null
}

export interface AddFolderInput {
  name?: string
  parentId?: string | null
}

export interface NoteServiceOptions {
  getProfileId?: () => string
}

export type NoteChangeListener = (change: NoteChange) => void

export interface NoteService {
  add(input?: AddNoteInput): Note | null
  get(id: string): Note | null
  list(options?: ListNotesOptions): Note[]
  update(id: string, patch?: UpdateNoteInput): Note | null
  remove(id: string): boolean
  move(id: string, folderId: string | null): Note | null
  setPinned(id: string, pinned: boolean): Note | null
  search(query: string): Note[]
  reorder(folderId: string | null, orderedIds: readonly string[]): boolean
  addCaptured(input?: CaptureNoteInput): Note | null
  restore(id: string): boolean
  purge(id: string): boolean
  listTrash(): Note[]
  emptyTrash(): number
  backlinks(id: string): BacklinkNote[]
  refCounts(): Record<string, number>
  listFolders(): NoteFolder[]
  addFolder(input?: AddFolderInput): string
  renameFolder(id: string, name: string): boolean
  removeFolder(id: string): boolean
  moveFolder(id: string, parentId: string | null): boolean
  reorderFolders(parentId: string | null, orderedIds: readonly string[]): boolean
  descendantFolders(id: string): Set<string>
  folderCounts(): Record<string, number>
  subscribe(listener: NoteChangeListener): () => void
}
