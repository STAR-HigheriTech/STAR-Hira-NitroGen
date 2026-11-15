import { describe, it, expect, vi } from 'vitest'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

const require = createRequire(import.meta.url)
const plugin = require('../../../build/plugins/download-service.cjs')

describe('download-service plugin providers', () => {
  it('exposes one provider per download capability and dispatches to the current service', async () => {
    const first = {
      create: vi.fn(() => 'd1'),
      updateProgress: vi.fn(() => true),
      complete: vi.fn(() => true),
      cancel: vi.fn(() => true),
      list: vi.fn(() => []),
      get: vi.fn((id) => ({ id, filePath: 'C:\\download.bin' })),
      remove: vi.fn(() => true),
      removeMany: vi.fn(() => 2),
      clearCompleted: vi.fn(() => 3),
      pause: vi.fn(() => true),
      resume: vi.fn(() => true),
      cancel: vi.fn(() => true)
    }
    let current = first
    const ctx = { getDomainServices: () => ({ downloadService: current }) }
    const byId = Object.fromEntries(plugin.registerProviders(ctx).map((p) => [p.capability, p]))

    expect(Object.keys(byId).sort()).toEqual([
      'download.cancel', 'download.clearCompleted', 'download.complete',
      'download.create', 'download.get', 'download.list', 'download.open', 'download.pause',
      'download.remove', 'download.removeMany', 'download.resume', 'download.showInFolder', 'download.updateProgress'
    ])

    expect(byId['download.create'].around({ url: 'u' })).toBe('d1')
    expect(first.create).toHaveBeenCalledWith({ url: 'u' })
    expect(byId['download.updateProgress'].around({ id: 'x', receivedBytes: 1 })).toBe(true)
    expect(first.updateProgress).toHaveBeenCalledWith('x', 1, undefined)
    expect(byId['download.complete'].around({ id: 'x' })).toBe(true)
    expect(first.complete).toHaveBeenCalledWith('x', undefined)
    expect(byId['download.cancel'].around({ id: 'x' })).toBe(true)
    expect(first.cancel).toHaveBeenCalledWith('x')
    expect(byId['download.get'].around({ id: 'x' })).toEqual({ id: 'x', filePath: 'C:\\download.bin' })
    expect(first.get).toHaveBeenCalledWith('x')
    expect(byId['download.remove'].around({ id: 'x' })).toBe(true)
    expect(first.remove).toHaveBeenCalledWith('x')
    expect(byId['download.removeMany'].around({ ids: ['x', 'y'] })).toBe(2)
    expect(first.removeMany).toHaveBeenCalledWith(['x', 'y'])
    expect(byId['download.clearCompleted'].around(null)).toBe(3)
    expect(byId['download.pause'].around({ id: 'x' }, { context: { downloadController: { pause: vi.fn(() => true) } } })).toBe(true)
    expect(byId['download.resume'].around({ id: 'x' }, { context: { downloadController: { resume: vi.fn(() => true) } } })).toBe(true)
    const shell = { openPath: vi.fn(async () => ''), showItemInFolder: vi.fn() }
    expect(await byId['download.open'].around({ id: 'x' }, { context: { shell } })).toBe(true)
    expect(await byId['download.showInFolder'].around({ id: 'x' }, { context: { shell } })).toBe(true)
    expect(shell.openPath).toHaveBeenCalledWith('C:\\download.bin')
    expect(shell.showItemInFolder).toHaveBeenCalledWith('C:\\download.bin')

    current = { ...first, list: vi.fn(() => ['fresh']) }
    expect(byId['download.list'].around(null)).toEqual(['fresh'])
  })

  it('discovers manifest capabilities and registers them on enable', async () => {
    const { PluginRegistryV2, ProviderRegistry } = require('@hira-ng/infra-plugin')
    const providerRegistry = new ProviderRegistry()
    const pluginRegistry = new PluginRegistryV2({
      pluginDir: fileURLToPath(new URL('../../../build/plugins/', import.meta.url)),
      manifestFileFilter: (name) => name === 'download-service.hira-plugin.json',
      providerRegistry
    })
    const manifests = pluginRegistry.discover()
    expect(manifests[0].capabilities).toContain('download.get')
    expect(manifests[0].capabilities).toContain('download.removeMany')
    expect(manifests[0].capabilities).toContain('download.pause')
    expect(manifests[0].capabilities).toContain('download.open')
    await pluginRegistry.enableAll({ getDomainServices: () => ({ downloadService: {} }) })
    expect(providerRegistry.getByCapability('download.remove')).toHaveLength(1)
    expect(providerRegistry.getByCapability('download.removeMany')).toHaveLength(1)
  })
})
