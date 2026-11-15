export interface SessionNavEntry {
  url: string
  title?: string
  pageState?: string
}

export interface SessionTabRecord {
  tabId: string
  profileId?: string
  spaceId?: string
  url: string
  pinned: boolean
  stackId?: string | null
  splitId?: string | null
  glanceId?: string | null
  navHistory?: SessionNavEntry[]
  navHistoryIndex?: number
  muted?: boolean
  lastActivated?: number
  position?: number
  title?: string
  favicon?: string
}

export interface SessionStackRecord {
  stackId: string
  label: string
  accent: string
  collapsed: boolean
  pinned: boolean
}

export interface SessionSplitRecord {
  splitId: string
  layout: string
  ratios: number[]
  members: string[]
  activeTabId?: string | null
}

export interface SessionGlanceRecord {
  glanceId: string
  members: string[]
  frontTabId?: string | null
}

export interface SessionRecord {
  version?: number | string
  savedAt?: number
  activeTabId: string | null
  tabs: SessionTabRecord[]
  stacks: SessionStackRecord[]
  splits: SessionSplitRecord[]
  glances: SessionGlanceRecord[]
}

export interface ParsedSessionRecord extends SessionRecord {
  version: number
  savedAt: number
}

export interface PersistedSessionRecord extends SessionRecord {
  version: number
  savedAt: number
}

export interface PersistableTab {
  tabId: string | number
  profileId?: string
  spaceId?: string
  url?: string
  pinned?: boolean
  stackId?: string | null
  splitId?: string | null
  glanceId?: string | null
  navHistory?: readonly SessionNavEntry[]
  navHistoryIndex?: number
  muted?: boolean
  lastActivated?: number
  position?: number
  title?: string
  favicon?: string
}

export interface SessionStackInput {
  stackId: string | number
  label?: string
  accent?: string
  collapsed?: boolean
  pinned?: boolean
}

export interface SessionSplitInput {
  splitId: string | number
  layout?: string
  ratios?: readonly number[]
  members?: readonly (string | number)[]
  activeTabId?: string | number | null
}

export interface SessionGlanceInput {
  glanceId: string | number
  members?: readonly (string | number)[]
  frontTabId?: string | number | null
}

export interface SessionRestoreTab {
  url: string
  pinned: boolean
  stackId?: string | null
  splitId?: string | null
  glanceId?: string | null
  navHistory?: SessionNavEntry[]
  navHistoryIndex?: number
  muted?: boolean
  lastActivated?: number
  position?: number
  title?: string
  favicon?: string
}

export interface SessionRestorePlan {
  tabs: SessionRestoreTab[]
  activeIndex: number
}

export interface NewSessionTabInput extends SessionRestoreTab {
  openInBackground: boolean
  sleeping: boolean
}

export interface CreatedTab {
  tabId?: string | number | null
}

export interface StackCreateInput {
  tabIds: string[]
  label: string
  accent: string
  collapsed: boolean
  pinned?: boolean
}

export interface GlanceCreateInput {
  tabIds: string[]
  frontTabId?: string
}

export interface SplitCreateInput {
  tabIds: string[]
  layout: string
  ratios: number[]
  activeTabId?: string
}

export interface SessionTabPort {
  list(): readonly PersistableTab[]
  listForPersist?(): readonly PersistableTab[]
  getActiveTabId(): string | number | null
  listStacks?(): readonly SessionStackInput[]
  listSplits?(): readonly SessionSplitInput[]
  listGlances?(): readonly SessionGlanceInput[]
  newTab(input: NewSessionTabInput): CreatedTab | null | void | Promise<CreatedTab | null | void>
  switchTo(tabId: string): unknown
  createStack?(input: StackCreateInput): unknown
  adoptPinnedTabs?(): unknown
  createGlance?(input: GlanceCreateInput): unknown
  createSplit?(input: SplitCreateInput): unknown
}

export interface FileWriteOptions {
  space?: number
  mode?: number
}

export interface SessionFilePort {
  join(...parts: string[]): string
  existsSync(path: string): boolean
  readJsonSync(path: string): unknown
  writeJsonAtomicSync(path: string, value: unknown, options?: FileWriteOptions): void
  writeJsonAtomic(path: string, value: unknown, options?: FileWriteOptions): Promise<void>
}

export interface LoggerPort {
  warn(message: string): void
}

export interface SessionSummaryItem {
  title: string
  url: string
  favicon: string
}

export interface SessionSummary {
  exists: boolean
  savedAt: number
  tabs: number
  pinned: number
  items: SessionSummaryItem[]
}

export interface SessionStats {
  tabs: number
  pinned: number
  activeIndex: number
}

export interface RestoreResult {
  restored: boolean
  activeTabId?: string | null
  trimmed?: boolean
}

export interface CreateSessionServiceOptions {
  filePort?: SessionFilePort
  fileName?: string
  logger?: LoggerPort
  isExpiredTab?: (tab: SessionTabRecord, now: number) => boolean
}

export interface SessionService {
  sessionPath(dir: string): string
  exists(dir: string): boolean
  read(dir: string): ParsedSessionRecord | null
  save(dir: string, tabPort: SessionTabPort): boolean
  saveAsync(dir: string, tabPort: SessionTabPort): Promise<boolean>
  restore(dir: string, tabPort: SessionTabPort): Promise<RestoreResult>
  stats(dir: string): SessionStats
  summary(dir: string, options?: { limit?: number }): SessionSummary
  clear(dir: string): boolean
}

export interface SessionPersistenceService {
  save(dir: string, tabPort: SessionTabPort): boolean
  saveAsync(dir: string, tabPort: SessionTabPort): Promise<boolean>
}

export interface CreateSessionPersistenceOptions {
  sessionService?: SessionPersistenceService
  flushIntervalMs?: number
  logger?: LoggerPort
}

export interface SessionPersistence {
  markDirty(dir: string, tabPort: SessionTabPort): void
  flush(): Promise<boolean>
  flushSync(): boolean
  start(): void
  stop(): Promise<void>
  isDirty(): boolean
  readonly FLUSH_INTERVAL_MS: number
}

export interface SuggestSessionNameOptions {
  emptyLabel?: string
}

export type MutableTabUserState = Partial<
  Pick<SessionTabRecord, 'muted' | 'lastActivated' | 'position' | 'title' | 'favicon'>
>
