import { describe, it, expect, vi } from 'vitest'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

const require = createRequire(import.meta.url)
const plugin = require('../../../build/plugins/settings-service.cjs')
const { PluginRegistryV2 } = require('@hira-ng/infra-plugin')

describe('settings-service plugin providers', () => {
  it('discovers and enables the settings plugin from its manifest', async () => {
    const service = {
      get: vi.fn(() => true),
      set: vi.fn(() => true),
      list: vi.fn(() => ({ app: true })),
      reset: vi.fn(() => true)
    }
    const registry = { getSchema: vi.fn(() => [{ key: 'app.test' }]) }
    const providerRegistry = new (require('@hira-ng/infra-plugin').ProviderRegistry)()
    const pluginRegistry = new PluginRegistryV2({
      pluginDir: fileURLToPath(new URL('../../../build/plugins/', import.meta.url)),
      manifestFileFilter: (name) => name === 'settings-service.hira-plugin.json',
      providerRegistry
    })

    const manifests = pluginRegistry.discover()
    expect(manifests.some((manifest) => manifest.id === 'settings-service')).toBe(true)
    await pluginRegistry.enableAll({
      getDomainServices: () => ({ settingsService: service, settingsRegistry: registry })
    })

    expect(providerRegistry.getByCapability('settings.get')).toHaveLength(1)
    expect(providerRegistry.getByCapability('settings.set')).toHaveLength(1)
    expect(providerRegistry.getByCapability('settings.list')).toHaveLength(1)
    expect(providerRegistry.getByCapability('settings.reset')).toHaveLength(1)
    expect(providerRegistry.getByCapability('settings.schema')).toHaveLength(1)
    await expect(providerRegistry.executeCapability('settings.set', { key: 'app.test', value: false }, { senderId: 12 }))
      .resolves.toBe(true)
    expect(service.set).toHaveBeenCalledWith('app.test', false, 12)
  })

  it('exposes settings capabilities and forwards sender context', () => {
    const service = {
      get: vi.fn(() => true),
      set: vi.fn(() => true),
      list: vi.fn(() => ({ app: true })),
      reset: vi.fn(() => true)
    }
    const registry = { getSchema: vi.fn(() => [{ key: 'app.test' }]) }
    const ctx = { senderId: 9, getDomainServices: () => ({ settingsService: service, settingsRegistry: registry }) }
    const byCapability = Object.fromEntries(plugin.registerProviders(ctx).map((provider) => [provider.capability, provider]))

    expect(Object.keys(byCapability).sort()).toEqual([
      'settings.get', 'settings.list', 'settings.reset', 'settings.schema', 'settings.set'
    ])
    expect(byCapability['settings.get'].around({ key: 'app.test' })).toBe(true)
    expect(byCapability['settings.set'].around({ key: 'app.test', value: false })).toBe(true)
    expect(service.set).toHaveBeenCalledWith('app.test', false, 9)
    expect(byCapability['settings.list'].around({ section: 'app' })).toEqual({ app: true })
    expect(byCapability['settings.reset'].around({ key: 'app.test' })).toBe(true)
    expect(service.reset).toHaveBeenCalledWith('app.test', 9)
    expect(byCapability['settings.schema'].around(null)).toEqual([{ key: 'app.test' }])
  })
})
