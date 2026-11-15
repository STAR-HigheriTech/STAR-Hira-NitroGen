import { describe, expect, it, vi } from 'vitest'
import { createRequire } from 'node:module'

vi.mock('electron', () => ({
  shell: {
    openPath: vi.fn(() => Promise.resolve('')),
    showItemInFolder: vi.fn()
  }
}))

const require = createRequire(import.meta.url)
const { ipcSchemas } = require('@hira-ng/infra-ipc')
const { registerBookmarkIpc } = require('./bookmarks.ts')
const { registerTabsIpc } = require('./tabs.ts')
const { registerLayoutIpc } = require('./layout.ts')
const { registerExtensionIpc } = require('./extensions.ts')
const { registerPasswordIpc } = require('./passwords.ts')
const { registerWindowIpc } = require('./window.ts')
const { registerSettingsIpc } = require('../settings/ipc.js')
const { registerExternalGamesIpc } = require('../external-games/ipc.js')
const { registerBookmarkBackupIpc } = require('../bookmark-backup/ipc.js')
const { createProviderInvoker } = require('./provider-bridge.ts')
const { registerDownloadIpc } = require('./downloads.ts')
const { shell } = require('electron')

const routes = {
  bookmarkList: 'bookmark:list', bookmarkAdd: 'bookmark:add', bookmarkRemove: 'bookmark:remove', bookmarkUpdate: 'bookmark:update', bookmarkSearch: 'bookmark:search', bookmarkMove: 'bookmark:move', bookmarkExport: 'bookmark:export', bookmarkImport: 'bookmark:import', bookmarkGetByUrl: 'bookmark:get-by-url', bookmarkRemoveByUrl: 'bookmark:remove-by-url', bookmarkTree: 'bookmark:tree', bookmarkPinnedList: 'bookmark:pinned-list', bookmarkPinnedSet: 'bookmark:pinned-set', bookmarkPinnedReorder: 'bookmark:pinned-reorder',
  tabList: 'tab:list', tabNew: 'tab:new', tabSwitch: 'tab:switch', tabClose: 'tab:close', tabCloseOthers: 'tab:close-others', tabCloseRight: 'tab:close-right', tabReorder: 'tab:reorder', tabTogglePin: 'tab:toggle-pin', tabToggleMute: 'tab:toggle-mute', tabDuplicate: 'tab:duplicate', tabUndoClose: 'tab:undo-close', omniboxAction: 'omnibox:action', navGo: 'nav:go', navBack: 'nav:back', navForward: 'nav:forward', navReload: 'nav:reload',
  panelList: 'panel:list', panelToggle: 'panel:toggle', layoutSetHeaderHeight: 'layout:setHeaderHeight', layoutSetPanelWidth: 'layout:set-panel-width', layoutToggleRail: 'layout:toggle-rail', searchbarOverlaySetBounds: 'searchbar-overlay:set-bounds', searchbarOverlaySetInteractive: 'searchbar-overlay:set-interactive', searchbarOverlayReady: 'searchbar-overlay:ready', tabpreviewOverlaySetBounds: 'tabpreview-overlay:set-bounds', tabpreviewOverlaySetInteractive: 'tabpreview-overlay:set-interactive', tabpreviewOverlayReady: 'tabpreview-overlay:ready', siteinfoOverlaySetBounds: 'siteinfo-overlay:set-bounds', siteinfoOverlaySetInteractive: 'siteinfo-overlay:set-interactive', siteinfoOverlayReady: 'siteinfo-overlay:ready', passwordOverlaySetInteractive: 'password-overlay:set-interactive', passwordOverlaySetBounds: 'password-overlay:set-bounds', passwordOverlayReady: 'password-overlay:ready',
  extensionList: 'extension:list', extensionInstall: 'extension:install', extensionUninstall: 'extension:uninstall', extensionToggle: 'extension:toggle', extensionImportFolder: 'extension:import-folder', adblockerStatus: 'adblocker:status', adblockerToggle: 'adblocker:toggle', adblockerBlockedCount: 'adblocker:blocked-count',
  passwordBackends: 'password:backends', passwordSetActive: 'password:set-active', passwordGetSuggestions: 'password:get-suggestions', passwordSave: 'password:save', passwordDelete: 'password:delete', passwordList: 'password:list', passwordNeverSaveAdd: 'password:never-save:add', passwordNeverSaveRemove: 'password:never-save:remove', passwordNeverSaveList: 'password:never-save:list', passwordAutofillMenu: 'password:autofill-menu', passwordCaptured: 'password:captured', passwordOverlayCommit: 'password:overlay-commit', passwordGenerate: 'password:generate', passwordOverlayHidden: 'password:overlay-hidden',
  uiPopupMenu: 'ui:popup-menu', windowMinimize: 'window:minimize', windowMaximize: 'window:maximize', windowClose: 'window:close', windowGetState: 'window:get-state', windowOpen: 'window:open',
  settingsGet: 'settings:get', settingsSet: 'settings:set', settingsList: 'settings:list', settingsReset: 'settings:reset', settingsSchema: 'settings:schema', settingsChangedKeys: 'settings:changed-keys', settingsCssVars: 'settings:css-vars',
  gameList: 'game:list',
  bookmarkBackupList: 'bookmark:backup-list', bookmarkBackupNow: 'bookmark:backup-now', bookmarkBackupRestore: 'bookmark:backup-restore'
}

describe('R1 IPC registrars', () => {
  it('consumes infra contracts and retains one-way layout listeners', () => {
    const handled = new Map()
    const listeners = new Map()
    const typedMain = { handle: (route, contract) => handled.set(route, contract) }
    const ipcMain = { on: (channel, listener) => listeners.set(channel, listener) }
    const layoutCoordinator = { getFloatWebContents: () => null, getUiShellWebContents: () => null }

    registerBookmarkIpc(typedMain, { routes, schemas: ipcSchemas.bookmarks, bookmarkService: {}, providerRegistry: null })
    // `ipcMain` 必须注入：拖标签的两条裸通道（begin / drop-content）要注册到它上面，
    // 而裸通道**不走** typedMain（不入「按发送方解析窗口」的上下文，见 ipc/tabs.js 的说明）。
    // 与 registerLayoutIpc 同一套注入约定。
    registerTabsIpc(typedMain, { routes, schemas: ipcSchemas.tabs, tabManager: {}, providerRegistry: null, ipcMain })
    registerLayoutIpc(typedMain, { routes, schemas: ipcSchemas.layout, panelIds: [], layoutCoordinator, ipcMain })

    expect(handled.get(routes.bookmarkAdd).requestSchema).toBe(ipcSchemas.bookmarks.add.request)
    expect(handled.get(routes.tabReorder).responseSchema).toBe(ipcSchemas.tabs.reorder.response)
    expect(handled.get(routes.layoutSetHeaderHeight).requestSchema).toBe(ipcSchemas.layout.setHeaderHeight.request)
    expect(listeners.has('ngipc:send:searchbar-overlay:show')).toBe(true)
    expect(listeners.has('ngipc:send:tabpreview-overlay:display')).toBe(true)
    expect(listeners.has('ngipc:send:siteinfo-overlay:hide')).toBe(true)
    expect(listeners.has('ngipc:send:overlay:commit')).toBe(true)
    expect(listeners.has('ngipc:send:overlay:action')).toBe(true)
  })

  it('falls back to the domain service when a provider is absent or fails recoverably', async () => {
    const fallback = vi.fn(() => 'fallback')
    const onProviderError = vi.fn()
    const registry = {
      getByCapability: () => [{ id: 'test.provider' }],
      executeCapability: () => Promise.reject(new Error('provider crashed'))
    }
    const invoke = createProviderInvoker(registry, { onProviderError })
    await expect(invoke('test.capability', fallback, { value: 1 }, { source: 'test' })).resolves.toBe('fallback')
    expect(fallback).toHaveBeenCalledOnce()
    expect(onProviderError).toHaveBeenCalledOnce()

    const absent = createProviderInvoker({ getByCapability: () => [], executeCapability: vi.fn() })
    expect(absent('missing.capability', fallback, null)).toBe('fallback')
  })

  it('awaits provider-backed values before shaping IPC response objects', async () => {
    const { registerHistoryIpc } = require('./history.ts')
    const handlers = new Map()
    const typedMain = { handle: (route, config) => handlers.set(route, config.handler) }
    const routes = {
      historyRemove: 'history:remove', historyList: 'history:list', historySearch: 'history:search',
      historyQueryRange: 'history:query-range', historyRemoveMany: 'history:remove-many',
      historyRemoveBefore: 'history:remove-before', historyClear: 'history:clear',
      historyVisits: 'history:visits', pageTextCaptured: 'history:page-text-captured'
    }
    const schemas = {
      remove: { request: {}, response: {} },
      list: { request: {}, response: {} },
      search: { request: {}, response: {} },
      queryRange: { request: {}, response: {} },
      removeMany: { request: {}, response: {} },
      removeBefore: { request: {}, response: {} },
      clear: { request: {}, response: {} },
      visits: { request: {}, response: {} },
      pageTextCaptured: { request: {}, response: {} }
    }
    const historyService = {
      remove: vi.fn(() => false), listRecent: vi.fn(), search: vi.fn(), queryRange: vi.fn(),
      removeMany: vi.fn(), removeBefore: vi.fn(), clearAll: vi.fn(),
      listVisits: vi.fn(), savePageText: vi.fn()
    }
    const providerRegistry = {
      getByCapability: () => [{ id: 'history.provider' }],
      executeCapability: vi.fn((capability) => Promise.resolve(
        capability === 'history.queryRange' ? [{ id: 'range-1' }]
          : capability === 'history.removeMany' ? 2
            : capability === 'history.removeBefore' ? 3 : true
      ))
    }
    registerHistoryIpc(typedMain, { routes, schemas, historyService, providerRegistry })

    await expect(handlers.get(routes.historyRemove)(null, { id: 'item-1' })).resolves.toEqual({ ok: true })
    await expect(handlers.get(routes.historyQueryRange)(null, { from: 1, to: 2, limit: 10 })).resolves.toEqual([{ id: 'range-1' }])
    await expect(handlers.get(routes.historyRemoveMany)(null, { ids: ['item-1', 'item-2'] })).resolves.toEqual({ removed: 2 })
    await expect(handlers.get(routes.historyRemoveBefore)(null, { before: 10 })).resolves.toEqual({ removed: 3 })
    expect(providerRegistry.executeCapability).toHaveBeenCalledWith('history.queryRange', { from: 1, to: 2, limit: 10 }, undefined)
    expect(providerRegistry.executeCapability).toHaveBeenCalledWith('history.removeMany', { ids: ['item-1', 'item-2'] }, undefined)
    expect(providerRegistry.executeCapability).toHaveBeenCalledWith('history.removeBefore', { before: 10 }, undefined)
  })

  it('routes download record lookup through download.get for open and show-in-folder', async () => {
    const handlers = new Map()
    const typedMain = { handle: (route, config) => handlers.set(route, config.handler) }
    const downloadService = { get: vi.fn(() => ({ filePath: 'fallback.bin' })) }
    const providerRegistry = {
      getByCapability: (capability) => capability === 'download.get' ? [{ id: 'download.provider' }] : [],
      executeCapability: vi.fn(() => Promise.resolve({ filePath: 'provider.bin' }))
    }
    const schemas = {
      list: { request: {}, response: {} },
      remove: { request: {}, response: {} },
      clearCompleted: { request: {}, response: {} },
      open: { request: {}, response: {} },
      showInFolder: { request: {}, response: {} }
    }

    const shell = { openPath: vi.fn(() => Promise.resolve('')), showItemInFolder: vi.fn() }
    registerDownloadIpc(typedMain, {
      routes: { downloadList: 'download:list', downloadRemove: 'download:remove', downloadClearCompleted: 'download:clear', downloadOpen: 'download:open', downloadShowInFolder: 'download:show-in-folder' },
      schemas,
      downloadService,
      providerRegistry,
      shell
    })

    await expect(handlers.get('download:open')(null, { id: 'item-1' })).resolves.toEqual({ ok: true })
    await expect(handlers.get('download:show-in-folder')(null, { id: 'item-1' })).resolves.toEqual({ ok: true })
    expect(providerRegistry.executeCapability).toHaveBeenCalledTimes(2)
    expect(providerRegistry.executeCapability).toHaveBeenNthCalledWith(1, 'download.get', { id: 'item-1' }, undefined)
    expect(downloadService.get).not.toHaveBeenCalled()
    expect(shell.openPath).toHaveBeenCalledOnce()
    expect(shell.openPath).toHaveBeenCalledWith('provider.bin')
    expect(shell.showItemInFolder).toHaveBeenCalledOnce()
    expect(shell.showItemInFolder).toHaveBeenCalledWith('provider.bin')
  })

  it('registers download remove-many when its route and contract are available', async () => {
    const handlers = new Map()
    const typedMain = { handle: (route, config) => handlers.set(route, config.handler) }
    const downloadService = { list: vi.fn(), remove: vi.fn(), removeMany: vi.fn(() => 2), clearCompleted: vi.fn(), get: vi.fn() }
    const providerRegistry = { getByCapability: () => [], executeCapability: vi.fn() }
    const schemas = {
      list: { request: {}, response: {} }, remove: { request: {}, response: {} }, removeMany: { request: {}, response: {} },
      clearCompleted: { request: {}, response: {} }, open: { request: {}, response: {} }, showInFolder: { request: {}, response: {} }
    }
    registerDownloadIpc(typedMain, {
      routes: { downloadList: 'download:list', downloadRemove: 'download:remove', downloadRemoveMany: 'download:remove-many', downloadClearCompleted: 'download:clear', downloadOpen: 'download:open', downloadShowInFolder: 'download:show-in-folder' },
      schemas,
      downloadService,
      providerRegistry
    })

    await expect(handlers.get('download:remove-many')(null, { ids: ['item-1', 'item-2'] })).resolves.toEqual({ removed: 2 })
    expect(downloadService.removeMany).toHaveBeenCalledWith(['item-1', 'item-2'])
  })
  it('routes clear-completed through the download provider', async () => {
    const handlers = new Map()
    const typedMain = { handle: (route, config) => handlers.set(route, config.handler) }
    const downloadService = { clearCompleted: vi.fn(() => 4) }
    const providerRegistry = {
      getByCapability: (capability) => capability === 'download.clearCompleted' ? [{ id: 'download.provider' }] : [],
      executeCapability: vi.fn(() => Promise.resolve(4))
    }
    registerDownloadIpc(typedMain, {
      routes: { downloadList: 'download:list', downloadRemove: 'download:remove', downloadClearCompleted: 'download:clear-completed', downloadOpen: 'download:open', downloadShowInFolder: 'download:show-in-folder' },
      schemas: { list: { request: {}, response: {} }, remove: { request: {}, response: {} }, clearCompleted: { request: {}, response: {} }, open: { request: {}, response: {} }, showInFolder: { request: {}, response: {} } },
      downloadService,
      providerRegistry
    })

    await expect(handlers.get('download:clear-completed')(null, {})).resolves.toEqual({ cleared: 4 })
    expect(providerRegistry.executeCapability).toHaveBeenCalledWith('download.clearCompleted', null, undefined)
    expect(downloadService.clearCompleted).not.toHaveBeenCalled()
  })
  it('falls back to the download service when download.get provider fails', async () => {
    const handlers = new Map()
    const typedMain = { handle: (route, config) => handlers.set(route, config.handler) }
    const downloadService = { get: vi.fn(() => ({ filePath: 'fallback.bin' })) }
    const shell = { openPath: vi.fn(() => Promise.resolve('')), showItemInFolder: vi.fn() }
    registerDownloadIpc(typedMain, {
      routes: { downloadList: 'download:list', downloadRemove: 'download:remove', downloadClearCompleted: 'download:clear', downloadOpen: 'download:open', downloadShowInFolder: 'download:show-in-folder' },
      schemas: { list: { request: {}, response: {} }, remove: { request: {}, response: {} }, clearCompleted: { request: {}, response: {} }, open: { request: {}, response: {} }, showInFolder: { request: {}, response: {} } },
      downloadService,
      providerRegistry: { getByCapability: () => [{ id: 'download.provider' }], executeCapability: () => Promise.reject(new Error('provider crashed')) },
      shell
    })

    await expect(handlers.get('download:open')(null, { id: 'item-1' })).resolves.toEqual({ ok: true })
    expect(downloadService.get).toHaveBeenCalledWith('item-1')
    expect(shell.openPath).toHaveBeenCalledWith('fallback.bin')
  })

  it('does not hide provider permission and validation failures', async () => {
    const fallback = vi.fn(() => 'fallback')
    const registry = {
      getByCapability: () => [{ id: 'test.provider' }],
      executeCapability: () => Promise.reject(new Error('Provider permission denied: tabs:read'))
    }
    await expect(createProviderInvoker(registry)('test.capability', fallback, null)).rejects.toThrow('permission denied')
    expect(fallback).not.toHaveBeenCalled()
  })

  it('routes external games listing through the provider and preserves scheme and response shape', async () => {
    const handlers = new Map()
    const typedMain = { handle: (route, config) => handlers.set(route, config.handler) }
    const catalog = { list: vi.fn(() => [{ id: 'dino' }]) }
    const providerRegistry = {
      getByCapability: (capability) => capability === 'external-games.list' ? [{ id: 'external-games.provider' }] : [],
      executeCapability: vi.fn(() => Promise.resolve([{ id: 'provider-game' }]))
    }

    registerExternalGamesIpc(typedMain, {
      routes: { gameList: 'game:list' },
      schemas: { list: { request: {}, response: {} } },
      catalog,
      providerRegistry
    })

    await expect(handlers.get('game:list')(null, { refresh: true })).resolves.toEqual({
      scheme: 'hira-game',
      games: [{ id: 'provider-game' }]
    })
    expect(providerRegistry.executeCapability).toHaveBeenCalledWith('external-games.list', { refresh: true }, undefined)
    expect(catalog.list).not.toHaveBeenCalled()
  })

  it('falls back to the external games catalog when its provider fails', async () => {
    const handlers = new Map()
    const typedMain = { handle: (route, config) => handlers.set(route, config.handler) }
    const catalog = { list: vi.fn(() => [{ id: 'fallback-game' }]) }

    registerExternalGamesIpc(typedMain, {
      routes: { gameList: 'game:list' },
      schemas: { list: { request: {}, response: {} } },
      catalog,
      providerRegistry: {
        getByCapability: () => [{ id: 'external-games.provider' }],
        executeCapability: () => Promise.reject(new Error('provider crashed'))
      }
    })

    await expect(handlers.get('game:list')(null, {})).resolves.toEqual({
      scheme: 'hira-game',
      games: [{ id: 'fallback-game' }]
    })
    expect(catalog.list).toHaveBeenCalledWith({ refresh: false })
  })

  it('uses sunk contracts for the remaining R1 registrars', () => {
    const handled = new Map()
    const typedMain = { handle: (route, contract) => handled.set(route, contract) }
    const layoutCoordinator = {
      getPasswordOverlayWebContents: () => null,
      getActiveTabViewOffset: () => null,
      getWindow: () => null
    }
    const passwordService = {
      listBackends: () => [],
      getNeverSaveDomains: () => [],
      getSuggestions: () => []
    }

    registerExtensionIpc(typedMain, { routes, schemas: ipcSchemas.extensions, extensionService: {}, providerRegistry: null })
    registerPasswordIpc(typedMain, { routes, schemas: ipcSchemas.passwords, passwordService, layoutCoordinator, tabManager: {}, providerRegistry: null })
    registerWindowIpc(typedMain, { routes, schemas: ipcSchemas.window })
    registerSettingsIpc(typedMain, { routes, schemas: ipcSchemas.settings, settingsService: { get: () => null, set: () => true, list: () => ({}), reset: () => true } })
    registerExternalGamesIpc(typedMain, { routes, schemas: ipcSchemas.externalGames, catalog: { list: () => [] } })
    registerBookmarkBackupIpc(typedMain, { routes, schemas: ipcSchemas.bookmarkBackup, bookmarkBackup: { listBackups: () => [], backupNow: () => ({}), restore: () => ({}) } })

    expect(handled.get(routes.extensionInstall).requestSchema).toBe(ipcSchemas.extensions.install.request)
    expect(handled.get(routes.passwordOverlayCommit).responseSchema).toBe(ipcSchemas.passwords.overlayCommit.response)
    expect(handled.get(routes.windowOpen).requestSchema).toBe(ipcSchemas.window.open.request)
    expect(handled.get(routes.settingsList).responseSchema).toBe(ipcSchemas.settings.list.response)
    expect(handled.get(routes.gameList).responseSchema).toBe(ipcSchemas.externalGames.list.response)
    expect(handled.get(routes.bookmarkBackupRestore).requestSchema).toBe(ipcSchemas.bookmarkBackup.restore.request)
  })

  it('passes through password masked suggestions and save strength', async () => {
    const handlers = new Map()
    const typedMain = { handle: (route, config) => handlers.set(route, config.handler) }
    const passwordService = {
      getSuggestions: vi.fn(() => [{ username: 'u', password: 'p', masked: '••••' }]),
      saveCredential: vi.fn(() => ({ ok: true, strength: 3 }))
    }
    registerPasswordIpc(typedMain, {
      routes,
      schemas: ipcSchemas.passwords,
      passwordService,
      layoutCoordinator: { getPasswordOverlayWebContents: () => null, getActiveTabViewOffset: () => null, getWindow: () => null },
      tabManager: {},
      providerRegistry: null
    })

    await expect(handlers.get(routes.passwordGetSuggestions)(null, { hostname: 'hira.example' }))
      .resolves.toEqual([{ username: 'u', password: 'p', masked: '••••' }])
    expect(passwordService.getSuggestions).toHaveBeenCalledWith('hira.example')

    await expect(handlers.get(routes.passwordSave)(null, { hostname: 'hira.example', username: 'u', password: 'p' }))
      .resolves.toEqual({ ok: true, strength: 3 })
    expect(passwordService.saveCredential).toHaveBeenCalledWith({ hostname: 'hira.example', username: 'u', password: 'p' })
  })

  it('routes settings changedKeys/search/cssVars through the service with passthrough args', async () => {
    const handlers = new Map()
    const typedMain = { handle: (route, config) => handlers.set(route, config.handler) }
    const settingsService = {
      changedKeys: vi.fn(() => ['app.theme']),
      cssVars: vi.fn(() => ({ theme: 'light' }))
    }
    registerSettingsIpc(typedMain, { routes, schemas: ipcSchemas.settings, settingsService, providerRegistry: null })

    await expect(handlers.get(routes.settingsChangedKeys)(null, {})).resolves.toEqual(['app.theme'])
    await expect(handlers.get(routes.settingsCssVars)(null, {})).resolves.toEqual({ theme: 'light' })
    expect(settingsService.changedKeys).toHaveBeenCalledOnce()
    expect(settingsService.cssVars).toHaveBeenCalledOnce()
  })

  it('enriches extension list items with buildExtensionMeta display fields', async () => {
    const handlers = new Map()
    const typedMain = { handle: (route, config) => handlers.set(route, config.handler) }
    const extensionService = {
      listExtensions: vi.fn(() => [{ id: 'ext-1', name: 'Demo', version: '1.0.0', enabled: true }]),
      session: {
        extensions: {
          getAllExtensions: vi.fn(() => [{
            id: 'ext-1',
            manifest: { name: 'Demo', version: '1.0.0', manifest_version: 3, permissions: ['storage', 'tabs'] }
          }])
        }
      }
    }
    registerExtensionIpc(typedMain, { routes, schemas: ipcSchemas.extensions, extensionService, providerRegistry: null })

    const items = await handlers.get(routes.extensionList)(null, {})
    expect(Array.isArray(items)).toBe(true)
    expect(items[0].isV3).toBe(true)
    expect(items[0].manifestVersion).toBe(3)
    expect(items[0].permissionNames).toEqual(['storage', 'tabs'])
    expect(items[0].permissions[0]).toBe('存储')
    expect(extensionService.listExtensions).toHaveBeenCalledOnce()
    expect(extensionService.session.extensions.getAllExtensions).toHaveBeenCalledOnce()
  })
})
