import type { UnknownRecord, ServicePluginContext } from '@hira-ng/infra-plugin'
import type { createBookmarkService } from '@hira-ng/domain-bookmark'
import type { createDownloadService } from '@hira-ng/domain-download'
import type { createHistoryService } from '@hira-ng/domain-history'
import type { CaptureNoteInput, NoteService, UpdateNoteInput } from '@hira-ng/domain-notes'
import type { PasswordService } from '@hira-ng/domain-password'
import type { PermissionService } from '@hira-ng/domain-permission'
import type { createProfileService } from '@hira-ng/domain-profile'
import type { PwaService } from '@hira-ng/domain-pwa'
import type { createSearchService } from '@hira-ng/domain-search'
import type { SessionService } from '@hira-ng/domain-session'
import type { SettingsService } from '@hira-ng/domain-settings'
import type { createSpaceService } from '@hira-ng/domain-space'
import type { TotpService } from '@hira-ng/domain-totp'
import type { TabManager } from '@hira-ng/infra-window'
import type { SessionTabPort } from '@hira-ng/infra-window'

export type BookmarkService = ReturnType<typeof createBookmarkService>
export type DownloadService = ReturnType<typeof createDownloadService>
export type HistoryService = ReturnType<typeof createHistoryService>
export type ProfileService = ReturnType<typeof createProfileService>
export type SearchService = ReturnType<typeof createSearchService>
export type SpaceService = ReturnType<typeof createSpaceService>

type FirstArgument<T extends (...args: never[]) => unknown> = Parameters<T>[0]
type SecondArgument<T extends (...args: never[]) => unknown> = Parameters<T>[1]
type RequiredFirstArgument<T extends (...args: never[]) => unknown> = NonNullable<Parameters<T>[0]>

export interface PwaInstallerPort { install(input: unknown): unknown | Promise<unknown> }
export interface PwaUninstallerPort { uninstall(id: string): unknown | Promise<unknown> }
export interface PwaRuntimePort { launch(id: string): unknown | Promise<unknown> }
export interface PwaUpdaterPort {
  update(id: string): unknown | Promise<unknown>
  checkAll(input: unknown): unknown | Promise<unknown>
}
export interface StartupShortcutResult { ok: boolean; reason?: string }
export interface PwaShortcutsPort {
  setStartup(id: string, enabled: boolean): StartupShortcutResult | Promise<StartupShortcutResult>
  create(id: string, location: string): unknown | Promise<unknown>
  remove(id: string, location: string): unknown | Promise<unknown>
}
export interface DownloadControllerPort {
  cancel(id: string): unknown | Promise<unknown>
  pause(id: string): unknown | Promise<unknown>
  resume(id: string): unknown | Promise<unknown>
}
export interface ShellPort {
  openPath(path: string): Promise<string>
  showItemInFolder(path: string): void
}
export interface SettingsRegistryPort { getSchema(): unknown }
export interface BookmarkBackupServicePort {
  listBackups(): unknown
  backupNow(reason: string): unknown
  restore(file: string): unknown
  flush(): unknown
  stop(): unknown
  start(): unknown
}
export interface ExtensionSummary {
  id: string
  iconPath?: string
}
export interface ExtensionServicePort {
  installFromCrx(path: string): Promise<ExtensionSummary>
  uninstall(id: string): Promise<boolean>
  listExtensions(): ExtensionSummary[]
  toggle(id: string, enabled: boolean): Promise<boolean>
  setPinned(id: string, pinned: boolean): boolean
  installFromPath(path: string): Promise<ExtensionSummary>
  getOptionsUrl(id: string): string
  openPopup(id: string, options?: { anchorRect?: unknown; alignment?: string; parentWindow?: unknown }): boolean
  isAdblockerEnabled(): boolean
  getAdblockerLevel(): string
  setAdblockerLevel(level: string): boolean
  setAdblockerEnabled(enabled: boolean): unknown
  getBlockedCount(): number
  getRuntimeStatus(id: string): unknown
  reload(id: string): Promise<boolean>
  getDiagnostics(id: string): unknown
  getWarnings(id: string): unknown
  getInspectViewSources(id: string): unknown
  getBrowserActionStates(tabId?: number): unknown[]
  getBrowserActionIconDataUrl(id: string, tabId?: number): Promise<string> | string
  inspectView(id: string, target: string): boolean
  updateAllExtensions(): Promise<boolean>
  getNewTabOverrideUrl(): string
}

export interface DomainServicesPort extends UnknownRecord {
  bookmarkService: BookmarkService
  notesService: NoteService
  totpService: TotpService
  profileService: ProfileService
  spaceService: SpaceService
  historyService: HistoryService
  downloadService: DownloadService
  extensionService: ExtensionServicePort
  passwordService: PasswordService
  permissionService: PermissionService
  searchService: SearchService
  sessionService: SessionService
  settingsService: SettingsService
  settingsRegistry: SettingsRegistryPort
  pwaService: PwaService
  bookmarkBackup: BookmarkBackupServicePort
  pwaInstaller: PwaInstallerPort
  pwaUninstaller: PwaUninstallerPort
  pwaRuntime: PwaRuntimePort
  pwaUpdater: PwaUpdaterPort
  pwaShortcuts: PwaShortcutsPort
  tabManager: TabManager & SessionTabPort
}

export interface ServiceRuntimeContext extends ServicePluginContext<DomainServicesPort> {
  getDomainServices(): DomainServicesPort
  tabManager: TabManager
  senderId?: number
  switchProfile?(id: string): unknown | Promise<unknown>
  downloadController?: DownloadControllerPort | null
  shell?: ShellPort | null
  getUsingSpace?(): unknown
}

export type BookmarkInputs = {
  'bookmark.list': { parentId?: string | null }
  'bookmark.add': FirstArgument<BookmarkService['add']>
  'bookmark.remove': { id: string }
  'bookmark.update': { id: string } & SecondArgument<BookmarkService['update']>
  'bookmark.search': { query: string; tag?: string | null }
  'bookmark.move': { id: string; parentId: string | null }
  'bookmark.exportHtml': Record<string, never>
  'bookmark.importHtml': { html: string }
  'bookmark.getByUrl': { url: string }
  'bookmark.removeByUrl': { url: string }
  'bookmark.tree': Record<string, never>
  'bookmark.listPinned': Record<string, never>
  'bookmark.setPinned': { id: string; pinned: boolean }
  'bookmark.reorderPinned': { orderedIds: string[] }
  'bookmark.listRailPinned': Record<string, never>
  'bookmark.setRailPinned': { id: string; pinned: boolean }
  'bookmark.reorderRailPinned': { orderedIds: string[] }
  'bookmark.setOpenInSidebar': { id: string; value: boolean }
  'bookmark.reorderChildren': { parentId: string | null; orderedIds: string[] }
  'bookmark.listTags': Record<string, never>
  'bookmark.suggestTags': FirstArgument<BookmarkService['suggestTags']>
  'bookmark.autocompleteTags': { tags?: string[] | null; limit?: number }
  'bookmark.bulkUpdateTags': { ids: string[]; addTags?: string[]; removeTags?: string[] }
  'bookmark.bulkSetPinned': { ids: string[]; pinned: boolean }
  'bookmark.bulkSetRailPinned': { ids: string[]; pinned: boolean }
  'bookmark.deleteTag': { tag: string }
  'bookmark.snapshot': { parentId?: string | null; tag?: string | null; query?: string | null }
}

export type NotesInputs = {
  'notes.list': FirstArgument<NoteService['list']>
  'notes.get': { id: string }
  'notes.add': FirstArgument<NoteService['add']>
  'notes.update': { id: string } & UpdateNoteInput
  'notes.remove': { id: string }
  'notes.search': { query: string }
  'notes.move': { id: string; folderId: string | null }
  'notes.setPinned': { id: string; pinned: boolean }
  'notes.reorder': { folderId: string | null; orderedIds: string[] }
  'notes.listFolders': Record<string, never>
  'notes.addFolder': FirstArgument<NoteService['addFolder']>
  'notes.renameFolder': { id: string; name: string }
  'notes.removeFolder': { id: string }
  'notes.moveFolder': { id: string; parentId: string | null }
  'notes.reorderFolders': { parentId: string | null; orderedIds: string[] }
  'notes.folderCounts': Record<string, never>
  'notes.addCaptured': CaptureNoteInput
  'notes.restore': { id: string }
  'notes.purge': { id: string }
  'notes.listTrash': Record<string, never>
  'notes.emptyTrash': Record<string, never>
  'notes.backlinks': { id: string }
  'notes.refCounts': Record<string, never>
}

export type TotpInputs = {
  'totp.list': Record<string, never>
  'totp.code': FirstArgument<TotpService['code']>
  'totp.add': FirstArgument<TotpService['add']>
  'totp.update': { id: string } & SecondArgument<TotpService['update']>
  'totp.remove': { id: string }
  'totp.import': FirstArgument<TotpService['importUris']>
  'totp.exportUri': { id: string }
  'totp.calibrate': FirstArgument<TotpService['calibrate']>
}

export type ProfileInputs = {
  'profile.list': Record<string, never>
  'profile.getActive': Record<string, never>
  'profile.create': { name?: string; icon?: string; color?: string }
  'profile.update': { id: string; name?: string; icon?: string; color?: string }
  'profile.setActive': { id: string }
  'profile.remove': { id: string }
}

export type SettingsInputs = {
  'settings.get': { key: string }
  'settings.set': { key: string; value: unknown }
  'settings.list': { section?: string }
  'settings.reset': { key?: string }
  'settings.schema': Record<string, never>
}

export type HistoryInputs = {
  'history.addVisit': FirstArgument<HistoryService['addVisit']>
  'history.remove': { id: string }
  'history.removeMany': { ids: string[] }
  'history.removeBefore': { before: number }
  'history.search': { query: string; limit?: number }
  'history.listRecent': { limit?: number }
  'history.clearAll': Record<string, never>
  'history.queryRange': { from: number; to: number; limit?: number }
  'history.listVisits': FirstArgument<HistoryService['listVisits']>
  'history.countVisits': FirstArgument<HistoryService['countVisits']>
  'history.compact': Record<string, never>
}

export type DownloadInputs = {
  'download.create': FirstArgument<DownloadService['create']>
  'download.updateProgress': { id: string; receivedBytes: number; totalBytes: number | null }
  'download.complete': { id: string; filePath: string }
  'download.cancel': { id: string }
  'download.list': Record<string, never>
  'download.get': { id: string }
  'download.remove': { id: string }
  'download.removeMany': { ids: string[] }
  'download.clearCompleted': Record<string, never>
  'download.pause': { id: string }
  'download.resume': { id: string }
  'download.open': { id: string; filePath?: string | null }
  'download.showInFolder': { id: string; filePath?: string | null }
}

export type SearchInputs = {
  'search.search': { query: string; limit?: number }
  'search.searchHistorySuggestions': { query: string; limit?: number }
  'search.recordSearchQuery': { query: string }
  'search.removeSearchHistoryEntry': { id: string }
  'search.clearSearchHistory': Record<string, never>
  'search.getBangs': Record<string, never>
  'search.getSearchEngines': Record<string, never>
  'search.getSearchConfig': Record<string, never>
}

export type SessionInputs = {
  'session.read': { dir: string }
  'session.stats': { dir: string }
  'session.save': { dir: string }
  'session.restore': { dir: string }
  'session.clear': { dir: string }
  'session.exists': { dir: string }
}

export type SpaceInputs = {
  'space.list': { profileId: string }
  'space.listAll': Record<string, never>
  'space.get': { profileId: string; spaceId: string }
  'space.create': { profileId: string; id?: string; name?: string; icon?: string; bgStartColor?: string; bgEndColor?: string }
  'space.update': { profileId: string; spaceId: string; patch: Record<string, unknown> }
  'space.move': { profileId: string; spaceId: string; targetProfileId: string }
  'space.remove': { profileId: string; spaceId: string }
  'space.reorder': { entries: FirstArgument<SpaceService['reorder']> }
  'space.getUsing': Record<string, never>
  'space.getLastUsed': { profileId: string }
  'space.setUsing': { profileId: string; spaceId: string }
}

export interface PwaServiceInput { id: string }
export type PwaInputs = {
  'pwa.list': Record<string, never>
  'pwa.get': PwaServiceInput
  'pwa.install': { candidateId: string; options?: Record<string, unknown> }
  'pwa.uninstall': PwaServiceInput
  'pwa.launch': PwaServiceInput
  'pwa.update': PwaServiceInput
  'pwa.checkUpdates': Record<string, never>
  'pwa.setRunOnStartup': PwaServiceInput & { enabled: boolean }
  'pwa.createShortcut': PwaServiceInput & { location: string }
  'pwa.removeShortcut': PwaServiceInput & { location: string }
}

export type ExtensionInputs = {
  'extensions.installFromCrx': { path: string }
  'extensions.uninstall': { id: string }
  'extensions.listExtensions': Record<string, never>
  'extensions.toggle': { id: string; enabled: boolean }
  'extensions.setPinned': { id: string; pinned: boolean }
  'extensions.iconPath': { id?: string }
  'extensions.installFromPath': { path: string }
  'extensions.optionsUrl': { id: string }
  'extensions.openPopup': { id: string; anchorRect?: unknown; alignment?: string; parentWindow?: unknown }
  'extensions.adblockerStatus': Record<string, never>
  'extensions.adblockerLevel': Record<string, never>
  'extensions.adblockerSetLevel': { level: string }
  'extensions.adblockerToggle': { enabled: boolean }
  'extensions.adblockerBlockedCount': Record<string, never>
  'extensions.runtimeStatus': { id: string }
  'extensions.reload': { id: string }
  'extensions.diagnostics': { id: string }
  'extensions.warnings': { id: string }
  'extensions.inspectViewSources': { id: string }
  'extensions.browserActionStates': { tabId?: number }
  'extensions.browserActionIcon': { id: string; tabId?: number }
  'extensions.inspectView': { id: string; target: string }
  'extensions.updateAll': Record<string, never>
  'extensions.newTabOverrideUrl': Record<string, never>
}

export type PasswordInputs = {
  'password.listBackends': Record<string, never>
  'password.saveCredential': FirstArgument<PasswordService['saveCredential']>
  'password.getSuggestions': { hostname: string; profileId?: string }
  'password.deleteCredential': { id: string }
  'password.listCredentials': Record<string, never>
  'password.importCredentials': { content?: string; profileId?: string }
  'password.setActiveBackend': { name: string }
  'password.backendAction': { name: string; action: string } & NonNullable<Parameters<PasswordService['backendAction']>[2]>
  'password.getBackendStatus': { name: string }
  'password.addNeverSave': { hostname: string }
  'password.removeNeverSave': { hostname: string }
  'password.listNeverSave': { profileId?: string }
}

export type PermissionInputs = {
  'permission.getPermission': { origin: string; permissionType: string }
  'permission.resolveRequest': { origin: string; permissionType: string }
  'permission.setPermission': { origin: string; permissionType: string; setting: string }
  'permission.setSitePermissions': { origin: string; rules: Record<string, string> }
  'permission.resetSite': { origin: string }
  'permission.removePermission': { origin: string; permissionType: string }
  'permission.listAll': Record<string, never>
  'permission.listByType': { permissionType: string }
  'permission.getSite': { origin: string }
  'permission.clearSite': { origin: string }
  'permission.respond': { id: string; allow: boolean; persist?: boolean }
  'permission.pendingList': Record<string, never>
  'permission.pendingWithFlags': Record<string, never>
}

export type KeybindingsInputs = {
  'keybindings.get': Record<string, never>
  'keybindings.defaults': Record<string, never>
  'keybindings.set': { action: string; combo: string }
  'keybindings.reset-one': { action: string }
  'keybindings.reset': Record<string, never>
}

export type TabInputs = {
  'tabs.list': Record<string, never>
  'tabs.projection': Record<string, never>
  'tabs.stack-create': RequiredFirstArgument<TabManager['createStack']>
  'tabs.stack-set': RequiredFirstArgument<TabManager['setTabStack']>
  'tabs.stack-toggle': { stackId: string }
  'tabs.stack-rename': RequiredFirstArgument<TabManager['renameStack']>
  'tabs.stack-set-color': RequiredFirstArgument<TabManager['setStackColor']>
  'tabs.stack-merge': RequiredFirstArgument<TabManager['mergeStacks']>
  'tabs.stack-dissolve': { stackId: string }
  'tabs.stack-get': { stackId: string }
  'tabs.stack-of-tab': { tabId: string }
  'tabs.stack-list': Record<string, never>
  'tabs.stack-is-tab-in-any': { tabId: string }
  'tabs.stack-update': RequiredFirstArgument<TabManager['updateStack']>
  'tabs.create': RequiredFirstArgument<TabManager['newTab']>
  'tabs.create-incognito': RequiredFirstArgument<TabManager['newIncognitoTab']>
  'tabs.activate': { tabId: string }
  'tabs.close': { tabId: string }
  'tabs.close-others': { tabId: string }
  'tabs.close-right': { tabId: string }
  'tabs.reorder': RequiredFirstArgument<TabManager['reorder']>
  'tabs.toggle-pin': { tabId: string }
  'tabs.toggle-mute': { tabId: string }
  'tabs.duplicate': { tabId: string }
  'tabs.can-go-back': { tabId?: string }
  'tabs.can-go-forward': { tabId?: string }
  'tabs.undo-close': Record<string, never>
  'tabs.recently-closed': Record<string, never>
  'tabs.recently-closed:clear': Record<string, never>
  'tabs.recently-closed:restore': { index?: number }
  'tabs.navigate': RequiredFirstArgument<TabManager['navigate']>
  'tabs.back': { tabId?: string }
  'tabs.forward': { tabId?: string }
  'tabs.reload': { tabId?: string }
  'tabs.stop': { tabId?: string }
  'tabs.sleep': { tabId?: string }
  'tabs.wake': { tabId: string }
  'tabs.sleep-inactive': RequiredFirstArgument<TabManager['sleepInactive']>
  'tabs.get-active': Record<string, never>
  'tabs.next': Record<string, never>
  'tabs.prev': Record<string, never>
  'tabs.omnibox-action': { action?: string }
}

export type ExternalGamesInputs = { 'external-games.list': { refresh?: boolean } }

export interface KeybindingsServicePort {
  getKeybindings(): unknown
  getDefaults(): unknown
  setKeybinding(action: string, combo: string): unknown
  resetKeybinding(action: string): unknown
  reset(): unknown
}

export interface ExternalGamesCatalogPort {
  list(options?: { refresh?: boolean }): Promise<unknown>
}
