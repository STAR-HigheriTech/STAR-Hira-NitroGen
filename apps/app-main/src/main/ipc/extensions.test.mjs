import { describe, expect, it, vi } from 'vitest'
import { EventEmitter } from 'node:events'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const { createExtensionEventRelay, registerExtensionIpc } = require('./extensions.ts')

const routes = {
  extensionList: 'extension:list',
  extensionInstall: 'extension:install',
  extensionUninstall: 'extension:uninstall',
  extensionToggle: 'extension:toggle',
  extensionImportFolder: 'extension:import-folder',
  extensionRuntimeStatus: 'extension:runtime-status',
  extensionReload: 'extension:reload',
  extensionDiagnostics: 'extension:diagnostics',
  extensionWarnings: 'extension:warnings',
  extensionOpenOptions: 'extension:open-options',
  extensionOpenPopup: 'extension:open-popup',
  extensionOpenStore: 'extension:open-store',
  extensionInspectView: 'extension:inspect-view',
  extensionUpdateAll: 'extension:update-all',
  adblockerStatus: 'adblocker:status',
  adblockerToggle: 'adblocker:toggle',
  adblockerBlockedCount: 'adblocker:blocked-count'
}

const schemas = {
  list: { request: {}, response: {} },
  install: { request: {}, response: {} },
  uninstall: { request: {}, response: {} },
  toggle: { request: {}, response: {} },
  importFolder: { request: {}, response: {} },
  runtimeStatus: { request: {}, response: {} },
  reload: { request: {}, response: {} },
  diagnostics: { request: {}, response: {} },
  warnings: { request: {}, response: {} },
  openOptions: { request: {}, response: {} },
  openPopup: { request: {}, response: {} },
  openStore: { request: {}, response: {} },
  inspectView: { request: {}, response: {} },
  updateAll: { request: {}, response: {} },
  adblockerStatus: { request: {}, response: {} },
  adblockerToggle: { request: {}, response: {} },
  adblockerBlockedCount: { request: {}, response: {} }
}

function createService() {
  return {
    events: new EventEmitter(),
    listExtensions: vi.fn(() => []),
    installFromCrx: vi.fn(() => ({ id: 'crx-extension' })),
    installFromPath: vi.fn(() => ({ id: 'path-extension' })),
    uninstall: vi.fn(() => true),
    toggle: vi.fn(() => true),
    getRuntimeStatus: vi.fn(() => ({ active: true })),
    reload: vi.fn(() => true),
    getDiagnostics: vi.fn(() => ({ errors: [] })),
    getWarnings: vi.fn(() => ['tabs']),
    isAdblockerEnabled: vi.fn(() => true),
    setAdblockerEnabled: vi.fn(() => true),
    getBlockedCount: vi.fn(() => 7)
  }
}

function register(service) {
  const handlers = new Map()
  registerExtensionIpc({ handle: (route, config) => handlers.set(route, config.handler) }, {
    routes,
    schemas,
    extensionService: service,
    providerRegistry: null
  })
  return handlers
}

describe('extension event relay', () => {
  it('forwards supported extension events and stops forwarding after cleanup', () => {
    const service = { events: new EventEmitter() }
    const emit = vi.fn()
    const stop = createExtensionEventRelay(service, {
      emit,
      eventChannel: 'extension:changed',
      schema: { safeParse: vi.fn((payload) => ({ success: true, data: { ...payload, relayed: true } })) }
    })

    service.events.emit('installed', { id: 'ext-1' })
    service.events.emit('reloaded', { id: 'ext-1' })
    stop()
    service.events.emit('uninstalled', { id: 'ext-1' })

    expect(emit).toHaveBeenNthCalledWith(1, 'extension:changed', { id: 'ext-1', relayed: true })
    expect(emit).toHaveBeenNthCalledWith(2, 'extension:changed', { id: 'ext-1', relayed: true })
    expect(emit).toHaveBeenCalledTimes(2)
  })

  it('blocks invalid event payloads before emitting', () => {
    const service = { events: new EventEmitter() }
    const emit = vi.fn()
    createExtensionEventRelay(service, {
      emit,
      eventChannel: 'extension:changed',
      schema: { safeParse: vi.fn(() => ({ success: false })) }
    })

    service.events.emit('toggled', { id: 'ext-1' })

    expect(emit).not.toHaveBeenCalled()
  })
})

describe('extension IPC handlers', () => {
  it('routes CRX and directory installs to their matching service methods', async () => {
    const service = createService()
    const handlers = register(service)

    await expect(handlers.get(routes.extensionInstall)(null, { path: 'C:/extensions/demo.CRX' })).resolves.toEqual({ id: 'crx-extension' })
    await expect(handlers.get(routes.extensionInstall)(null, { path: 'C:/extensions/demo' })).resolves.toEqual({ id: 'path-extension' })

    expect(service.installFromCrx).toHaveBeenCalledWith('C:/extensions/demo.CRX')
    expect(service.installFromPath).toHaveBeenCalledWith('C:/extensions/demo')
  })

  it('routes extension state and diagnostics handlers with the request id', async () => {
    const service = createService()
    const handlers = register(service)

    await expect(handlers.get(routes.extensionUninstall)(null, { id: 'ext-1' })).resolves.toEqual({ ok: true })
    await expect(handlers.get(routes.extensionToggle)(null, { id: 'ext-1', enabled: false })).resolves.toEqual({ ok: true })
    await expect(handlers.get(routes.extensionRuntimeStatus)(null, { id: 'ext-1' })).resolves.toEqual({ active: true })
    await expect(handlers.get(routes.extensionReload)(null, { id: 'ext-1' })).resolves.toEqual({ ok: true })
    await expect(handlers.get(routes.extensionDiagnostics)(null, { id: 'ext-1' })).resolves.toEqual({ errors: [] })
    await expect(handlers.get(routes.extensionWarnings)(null, { id: 'ext-1' })).resolves.toEqual(['tabs'])

    expect(service.uninstall).toHaveBeenCalledWith('ext-1')
    expect(service.toggle).toHaveBeenCalledWith('ext-1', false)
    expect(service.getRuntimeStatus).toHaveBeenCalledWith('ext-1')
    expect(service.reload).toHaveBeenCalledWith('ext-1')
    expect(service.getDiagnostics).toHaveBeenCalledWith('ext-1')
    expect(service.getWarnings).toHaveBeenCalledWith('ext-1')
  })

  it('shapes adblocker status and mutation results', async () => {
    const service = createService()
    const handlers = register(service)

    await expect(handlers.get(routes.adblockerStatus)(null, {})).resolves.toEqual({ enabled: true })
    await expect(handlers.get(routes.adblockerToggle)(null, { enabled: false })).resolves.toEqual({ ok: true })
    await expect(handlers.get(routes.adblockerBlockedCount)(null, {})).resolves.toBe(7)

    expect(service.isAdblockerEnabled).toHaveBeenCalledOnce()
    expect(service.setAdblockerEnabled).toHaveBeenCalledWith(false)
    expect(service.getBlockedCount).toHaveBeenCalledOnce()
  })
})
