import type { ConfigureHostResolverOptions, Session, WebContents } from 'electron'

export interface SettingsPort {
  get(key: string): unknown
  set?(key: string, value: unknown): unknown
}

export interface SettingsApplyContext {
  settings: SettingsPort
  value?: unknown
  previous?: unknown
  key?: string
  force?: boolean
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

export interface SettingsApplier {
  id: string
  keys: readonly string[]
  apply(context: SettingsApplyContext): unknown | Promise<unknown>
}

export interface ApplierSyncPort {
  registerApplier(applier: SettingsApplier): unknown
}

export interface LayoutCoordinatorPort {
  setRailLayout(payload: { position: string; horizontalAlign: string; verticalAlign: string }): unknown
  setRailWidth(width: number): unknown
  setRailPinned(pinned: boolean): unknown
  setSidebarPosition(payload: { position: string; railAlign?: string; railVertical?: string }): unknown
  setSideColumnSide(side: string): unknown
  setPanelWidth(width: number, side: string, slot: 'normal' | 'pinned'): unknown
  setWebSidebarPosition(position: 'left' | 'right' | 'auto'): unknown
  setWebSidebarWidth(width: number): unknown
  reclaimIdleFloatViews?(): string[]
  reclaimIdlePanelViews?(): string[]
  reclaimWebSidebarViews?(): unknown
  reclaimPasswordOverlay?(): unknown
}

export interface DownloadControllerPort {
  setRateLimit(bytesPerSecond: number): unknown
}

export interface ExtensionServicePort {
  setAdblockerLevel(level: string): unknown
}

export interface TabSyncPort {
  notifyDisabled(): unknown
}

export interface ThemeRuntimePort {
  publish(): unknown
}

export interface SearchServicePort {
  [key: string]: unknown
  setDefaultSearchEngine?(name: unknown): unknown
  saveCustomEngine?(engine: { trigger: string; title: string; url: string }): { ok?: boolean } | null | undefined
  search?(query: unknown, options?: Record<string, unknown>): unknown
  searchHistorySuggestions?(query: unknown, options?: Record<string, unknown>): unknown
}

export interface TabManagerPort {
  list(): Array<{ tabId: string; sleeping?: boolean }>
  getWebContents(tabId: string): WebContents | null | undefined
  on(event: string, listener: (payload: { tabId: string; webContents: WebContents }) => void): unknown
  getActiveTabId?(): string | null
  isIncognitoTab?(tabId: string): boolean
  archiveInactive?(options: { inactiveThresholdMs: number; excludePinned?: boolean }): { archived: string[] }
  sleepInactive?(options: { inactiveThresholdMs: number; excludePinned: boolean }): { slept: string[] }
}

export interface ApplierDependencies {
  send?: (channel: string, payload?: unknown, options?: { skipWebContentsId?: number }) => number
  getLayoutCoordinator?: () => LayoutCoordinatorPort | null | undefined
  getDownloadController?: () => DownloadControllerPort | null | undefined
  getExtensionService?: () => ExtensionServicePort | null | undefined
  getTabSync?: () => TabSyncPort | null | undefined
  getThemeRuntime?: () => ThemeRuntimePort | null | undefined
  getSession?: () => Session | null | undefined
  getSessions?: () => readonly Session[]
  getWebContents?: () => readonly WebContents[]
  onSessionCreated?: (listener: (session: Session) => void) => unknown
  onWebContentsCreated?: (listener: (webContents: WebContents) => void) => unknown
  getDefaultUserAgent?: () => string
  getAcceptLanguages?: () => string
  getChromeVersion?: () => string
  settingsService?: SettingsPort | null
  searchService?: SearchServicePort | null
  tabManager?: TabManagerPort | null
  themeManager?: unknown
  nativeTheme?: unknown
  configureHostResolver?: (options: ConfigureHostResolverOptions) => void
}
