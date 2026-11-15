import { describe, expect, it, vi } from 'vitest'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

const require = createRequire(import.meta.url)
const plugin = require('../../../build/plugins/external-games-service.cjs')
const { PluginRegistryV2, ProviderRegistry } = require('@hira-ng/infra-plugin')

describe('external-games-service plugin providers', () => {
  it('discovers and enables the external games manifest', async () => {
    const catalog = { list: vi.fn(() => [{ id: 'dino' }]) }
    const providerRegistry = new ProviderRegistry()
    const pluginRegistry = new PluginRegistryV2({
      pluginDir: fileURLToPath(new URL('../../../build/plugins/', import.meta.url)),
      manifestFileFilter: (name) => name === 'external-games-service.hira-plugin.json',
      providerRegistry
    })

    expect(pluginRegistry.discover().map((manifest) => manifest.id)).toContain('external-games-service')
    await pluginRegistry.enableAll({
      getDomainServices: () => ({ externalGamesCatalog: catalog })
    })

    await expect(providerRegistry.executeCapability('external-games.list', { refresh: true })).resolves.toEqual([{ id: 'dino' }])
    expect(catalog.list).toHaveBeenCalledWith({ refresh: true })
  })

  it('declares only the external games listing capability', () => {
    const provider = plugin.registerProviders({
      getDomainServices: () => ({ externalGamesCatalog: { list: () => [] } })
    })[0]

    expect(provider.id).toBe('external-games.service.list')
    expect(provider.capability).toBe('external-games.list')
  })
})
