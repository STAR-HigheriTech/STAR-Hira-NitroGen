import { describe, it, expect, vi } from 'vitest'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

const require = createRequire(import.meta.url)
const plugin = require('../../../build/plugins/extensions-service.cjs')

describe('extensions-service plugin providers', () => {
  it('exposes one provider per extensions capability and dispatches to the current service', async () => {
    const first = {
      installFromCrx: vi.fn(async () => 'e1'),
      uninstall: vi.fn(async () => true),
      listExtensions: vi.fn(() => [{ id: 'e1', iconPath: '/icon.png' }]),
      toggle: vi.fn(async () => true),
      installFromPath: vi.fn(async () => 'e2'),
      getRuntimeStatus: vi.fn(() => 'loaded'),
      reload: vi.fn(async () => true),
      getDiagnostics: vi.fn(() => []),
      getWarnings: vi.fn(() => []),
      isAdblockerEnabled: vi.fn(() => false),
      setAdblockerEnabled: vi.fn(() => true),
      getBlockedCount: vi.fn(() => 0)
    }
    let current = first
    const ctx = { getDomainServices: () => ({ extensionService: current }) }
    const byId = Object.fromEntries(plugin.registerProviders(ctx).map((p) => [p.capability, p]))

    expect(Object.keys(byId).sort()).toEqual([
      'extensions.adblockerBlockedCount', 'extensions.adblockerLevel', 'extensions.adblockerSetLevel',
      'extensions.adblockerStatus', 'extensions.adblockerToggle', 'extensions.diagnostics', 'extensions.iconPath',
      'extensions.inspectView', 'extensions.inspectViewSources', 'extensions.installFromCrx',
      'extensions.installFromPath', 'extensions.listExtensions', 'extensions.newTabOverrideUrl',
      'extensions.openPopup', 'extensions.optionsUrl', 'extensions.reload', 'extensions.runtimeStatus',
      'extensions.setPinned', 'extensions.toggle', 'extensions.uninstall', 'extensions.updateAll',
      'extensions.warnings'
    ])

    await expect(byId['extensions.installFromCrx'].around({ path: '/a.crx' })).resolves.toBe('e1')
    expect(first.installFromCrx).toHaveBeenCalledWith('/a.crx')
    await expect(byId['extensions.uninstall'].around({ id: 'e1' })).resolves.toBe(true)
    expect(first.uninstall).toHaveBeenCalledWith('e1')
    await expect(byId['extensions.toggle'].around({ id: 'e1', enabled: false })).resolves.toBe(true)
    expect(first.toggle).toHaveBeenCalledWith('e1', false)
    expect(byId['extensions.iconPath'].around({ id: 'e1' })).toBe('/icon.png')
    expect(byId['extensions.iconPath'].around({ id: 'missing' })).toBe(null)
    await expect(byId['extensions.installFromPath'].around({ path: '/dir' })).resolves.toBe('e2')
    expect(byId['extensions.runtimeStatus'].around({ id: 'e1' })).toBe('loaded')
    await expect(byId['extensions.reload'].around({ id: 'e1' })).resolves.toBe(true)
    expect(byId['extensions.diagnostics'].around({ id: 'e1' })).toEqual([])
    expect(byId['extensions.warnings'].around({ id: 'e1' })).toEqual([])

    current = { ...first, listExtensions: vi.fn(() => ['fresh']) }
    expect(byId['extensions.listExtensions'].around(null)).toEqual(['fresh'])
  })

  it('discovers manifest capabilities and registers them on enable', async () => {
    const { PluginRegistryV2, ProviderRegistry } = require('@hira-ng/infra-plugin')
    const providerRegistry = new ProviderRegistry()
    const pluginRegistry = new PluginRegistryV2({
      pluginDir: fileURLToPath(new URL('../../../build/plugins/', import.meta.url)),
      manifestFileFilter: (name) => name === 'extensions-service.hira-plugin.json',
      providerRegistry
    })
    const manifests = pluginRegistry.discover()
    expect(manifests[0].capabilities).toContain('extensions.adblockerStatus')
    await pluginRegistry.enableAll({ getDomainServices: () => ({ extensionService: {} }) })
    expect(providerRegistry.getByCapability('extensions.adblockerStatus')).toHaveLength(1)
  })
})
