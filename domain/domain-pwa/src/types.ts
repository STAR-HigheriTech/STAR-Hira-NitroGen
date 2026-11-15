/** Public contracts for PWA manifests, persistence rows, and the domain service. */

export type PwaInstallKind = 'full' | 'shortcut'
export type PwaUpdateState = 'idle' | 'available' | 'error'
export type PwaDisplayMode = 'browser' | 'minimal-ui' | 'standalone' | 'fullscreen' | 'window-controls-overlay'

export interface RawWebAppManifest {
  [key: string]: unknown
  name?: unknown
  short_name?: unknown
  display?: unknown
  start_url?: unknown
  scope?: unknown
  theme_color?: unknown
  background_color?: unknown
  icons?: unknown
}

export interface PwaIcon {
  src: string
  type: string
  purpose: string
  width: number
  height: number
  any: boolean
}

export type PwaIconSize = { width: number; height: number } | { any: true }

export interface NormalizeManifestContext {
  documentUrl: string
  manifestUrl?: string | null
  pageTitle?: string | null
}

export interface NormalizedWebAppManifest {
  name: string
  shortName: string | null
  display: string
  startUrl: string
  scope: string
  themeColor: string | null
  backgroundColor: string | null
  icons: PwaIcon[]
  manifestUrl: string | null
  raw: RawWebAppManifest
}

export interface PwaManifestSnapshot {
  name: string
  shortName: string | null
  display: string
  startUrl: string
  scope: string
  themeColor: string | null
  backgroundColor: string | null
  icons: Array<Omit<PwaIcon, 'purpose'>>
}

export interface PwaWindowState {
  x?: number
  y?: number
  width?: number
  height?: number
  maximized?: boolean
  [key: string]: unknown
}

export interface PwaRow {
  id: string
  profileId: string
  name: string
  shortName: string | null
  startUrl: string
  scope: string | null
  manifestUrl: string | null
  manifestJson: string | null
  display: string
  themeColor: string | null
  backgroundColor: string | null
  iconPath: string | null
  iconSmallPath: string | null
  iconIcoPath: string | null
  installKind: PwaInstallKind
  source: string
  sessionPartition: string | null
  startMenuShortcut: string | null
  desktopShortcut: string | null
  runOnStartup: number
  windowState: string | null
  updateState: PwaUpdateState
  lastCheckedAt: number | null
  lastLaunchedAt: number | null
  launchCount: number
  createdAt: number
  updatedAt: number
}

export interface PwaApp {
  id: string
  name: string
  shortName: string | null
  startUrl: string
  scope: string | null
  display: string
  themeColor: string | null
  backgroundColor: string | null
  installKind: PwaInstallKind
  source: string
  hasIcon: boolean
  hasSmallIcon: boolean
  hasIco: boolean
  hasStartMenuShortcut: boolean
  hasDesktopShortcut: boolean
  runOnStartup: boolean
  windowState: PwaWindowState | null
  updateState: PwaUpdateState
  lastCheckedAt: number | null
  lastLaunchedAt: number | null
  launchCount: number
  createdAt: number
  updatedAt: number
}

export interface PwaRecord extends Omit<PwaRow, 'windowState'> {
  windowState: PwaWindowState | null
}

export interface PwaUpsertInput {
  id?: unknown
  name?: unknown
  shortName?: unknown
  startUrl?: unknown
  scope?: unknown
  manifestUrl?: unknown
  manifestJson?: unknown
  display?: unknown
  themeColor?: unknown
  backgroundColor?: unknown
  iconPath?: unknown
  iconSmallPath?: unknown
  iconIcoPath?: unknown
  installKind?: unknown
  source?: unknown
  sessionPartition?: unknown
  startMenuShortcut?: string | null
  desktopShortcut?: string | null
  runOnStartup?: boolean | number
  windowState?: unknown
  updateState?: unknown
  lastCheckedAt?: unknown
  lastLaunchedAt?: unknown
  launchCount?: unknown
}

export interface PwaFlagsPatch {
  runOnStartup?: boolean | number
  startMenuShortcut?: string | null
  desktopShortcut?: string | null
}

export interface PwaCheckedPatch {
  updateState?: unknown
  lastCheckedAt?: unknown
}

export type PwaChangeReason = 'install' | 'update' | 'uninstall' | 'flags'

export interface PwaChange {
  reason: PwaChangeReason
  id: string | null
}

export type PwaChangeListener = (change: PwaChange) => void
export type PwaUnsubscribe = () => void

export type PwaUpsertResult =
  | { ok: true; app: PwaApp; created: boolean }
  | { ok: false; reason: string }

export type PwaRemoveResult =
  | { ok: true; record: PwaRecord }
  | { ok: false; reason: string }

export interface PwaServiceOptions {
  getProfileId?: () => string | null | undefined
}

export interface PwaService {
  list(): PwaApp[]
  get(id: unknown): PwaApp | null
  getRecord(id: unknown): PwaRecord | null
  findByStartUrl(url: unknown): PwaApp | null
  upsert(record: PwaUpsertInput | null | undefined): PwaUpsertResult
  remove(id: unknown): PwaRemoveResult
  touchLaunched(id: unknown): PwaApp | null
  markChecked(id: unknown, patch?: PwaCheckedPatch): PwaApp | null
  setFlags(id: unknown, flags?: PwaFlagsPatch): PwaApp | null
  setWindowState(id: unknown, state: unknown): boolean | null
  setSessionPartition(id: unknown, partition: unknown): PwaApp | null
  subscribe(listener: PwaChangeListener): PwaUnsubscribe
}

export interface PwaDatabaseQuery {
  where(condition: unknown): PwaDatabaseQuery
  orderBy(...values: unknown[]): PwaDatabaseQuery
  get(): PwaRow | undefined
  all(): PwaRow[]
}

export interface PwaDatabase {
  select(): { from(table: unknown): PwaDatabaseQuery }
  insert(table: unknown): { values(value: PwaRow): { run(): unknown } }
  update(table: unknown): { set(value: Partial<PwaRow>): { where(condition: unknown): { run(): unknown } } }
  delete(table: unknown): { where(condition: unknown): { run(): unknown } }
}
