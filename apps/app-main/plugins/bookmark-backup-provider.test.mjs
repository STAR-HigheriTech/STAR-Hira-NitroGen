import { describe, expect, it, vi } from 'vitest'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const plugin = require('../../../build/plugins/bookmark-backup-provider.cjs')
const { PluginRegistryV2, ProviderRegistry } = require('@hira-ng/infra-plugin')
const { registerBookmarkBackupIpc } = require('../../../out/main/bookmark-backup/ipc.js')

function createBookmarkBackup() {
  return {
    start: vi.fn(),
    stop: vi.fn(),
    flush: vi.fn(),
    listBackups: vi.fn(() => [{ file: 'backup.html' }]),
    backupNow: vi.fn(() => ({ ok: true })),
    restore: vi.fn(() => ({ ok: true, imported: 1 }))
  }
}

describe('bookmark-backup Provider plugin', () => {
  it('exposes list/now/restore and preserves lifecycle-safe start/flush/stop order', async () => {
    const bookmarkBackup = createBookmarkBackup()
    const providerRegistry = new ProviderRegistry()
    const registry = new PluginRegistryV2({
      loader: () => plugin,
      providerRegistry
    })
    registry.setManifests([{
      id: 'bookmark-backup-provider',
      main: './bookmark-backup-provider.cjs',
      capabilities: ['bookmark-backup.list', 'bookmark-backup.now', 'bookmark-backup.restore'],
      dependsOn: []
    }])

    await registry.enableAll({ getDomainServices: () => ({ bookmarkBackup }) })

    expect(bookmarkBackup.start).toHaveBeenCalledOnce()
    await expect(providerRegistry.executeCapability('bookmark-backup.list', null)).resolves.toEqual([{ file: 'backup.html' }])
    await expect(providerRegistry.executeCapability('bookmark-backup.now', null)).resolves.toEqual({ ok: true })
    await expect(providerRegistry.executeCapability('bookmark-backup.restore', { file: 'backup.html' })).resolves.toEqual({ ok: true, imported: 1 })
    expect(bookmarkBackup.backupNow).toHaveBeenCalledWith('manual')
    expect(bookmarkBackup.restore).toHaveBeenCalledWith('backup.html')

    await registry.disable('bookmark-backup-provider', { getDomainServices: () => ({ bookmarkBackup }) })

    expect(bookmarkBackup.flush).toHaveBeenCalledOnce()
    expect(bookmarkBackup.stop).toHaveBeenCalledOnce()
    expect(bookmarkBackup.flush.mock.invocationCallOrder[0]).toBeLessThan(bookmarkBackup.stop.mock.invocationCallOrder[0])
  })

  it('routes IPC through providers and falls back to the feature on recoverable failure', async () => {
    const handlers = new Map()
    const typedMain = { handle: (route, config) => handlers.set(route, config.handler) }
    const bookmarkBackup = createBookmarkBackup()
    const routes = { bookmarkBackupList: 'backup:list', bookmarkBackupNow: 'backup:now', bookmarkBackupRestore: 'backup:restore' }
    const schemas = { list: { request: {}, response: {} }, now: { request: {}, response: {} }, restore: { request: {}, response: {} } }
    const providerRegistry = {
      getByCapability: () => [{ id: 'bookmark-backup.provider' }],
      executeCapability: vi.fn((capability) => {
        if (capability === 'bookmark-backup.list') return Promise.resolve([{ file: 'provider.html' }])
        return Promise.reject(new Error('provider crashed'))
      })
    }

    registerBookmarkBackupIpc(typedMain, { routes, schemas, bookmarkBackup, providerRegistry })

    await expect(handlers.get(routes.bookmarkBackupList)(null, null)).resolves.toEqual([{ file: 'provider.html' }])
    await expect(handlers.get(routes.bookmarkBackupNow)(null, null)).resolves.toEqual({ ok: true })
    await expect(handlers.get(routes.bookmarkBackupRestore)(null, { file: 'backup.html' })).resolves.toEqual({ ok: true, imported: 1 })
    expect(bookmarkBackup.listBackups).not.toHaveBeenCalled()
    expect(bookmarkBackup.backupNow).toHaveBeenCalledWith('manual')
    expect(bookmarkBackup.restore).toHaveBeenCalledWith('backup.html')
  })
})
