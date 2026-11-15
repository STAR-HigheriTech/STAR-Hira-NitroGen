import { describe, it, expect, vi } from 'vitest'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

const require = createRequire(import.meta.url)
const plugin = require('../../../build/plugins/history-service.cjs')

describe('history-service plugin providers', () => {
  it('exposes one provider per history capability and dispatches to the current service', () => {
    const first = {
      addVisit: vi.fn(() => 'h1'),
      listRecent: vi.fn(() => []),
      remove: vi.fn(() => true),
      removeMany: vi.fn(() => 2),
      removeBefore: vi.fn(() => 3),
      search: vi.fn(() => []),
      clearAll: vi.fn(() => 5),
      queryRange: vi.fn(() => [])
    }
    let current = first
    const ctx = { getDomainServices: () => ({ historyService: current }) }
    const byId = Object.fromEntries(plugin.registerProviders(ctx).map((provider) => [provider.capability, provider]))

    expect(Object.keys(byId).sort()).toEqual([
      'history.addVisit', 'history.clearAll', 'history.compact', 'history.countVisits',
      'history.listRecent', 'history.listVisits', 'history.queryRange', 'history.remove',
      'history.removeBefore', 'history.removeMany', 'history.search'
    ])

    expect(byId['history.addVisit'].around({ url: 'u' })).toBe('h1')
    expect(first.addVisit).toHaveBeenCalledWith({ url: 'u' })
    expect(byId['history.remove'].around({ id: 'x' })).toBe(true)
    expect(first.remove).toHaveBeenCalledWith('x')
    expect(byId['history.removeMany'].around({ ids: ['x', 'y'] })).toBe(2)
    expect(first.removeMany).toHaveBeenCalledWith(['x', 'y'])
    expect(byId['history.removeBefore'].around({ before: 10 })).toBe(3)
    expect(first.removeBefore).toHaveBeenCalledWith(10)
    expect(byId['history.clearAll'].around(null)).toBe(5)
    expect(byId['history.queryRange'].around({ from: 1, to: 2, limit: 10 })).toEqual([])
    expect(first.queryRange).toHaveBeenCalledWith(1, 2, 10)

    current = { ...first, search: vi.fn(() => ['fresh']) }
    expect(byId['history.search'].around({ query: 'q', limit: 10 })).toEqual(['fresh'])
    expect(current.search).toHaveBeenCalledWith('q', 10)
  })

  it('discovers manifest capabilities and registers them on enable', async () => {
    const { PluginRegistryV2, ProviderRegistry } = require('@hira-ng/infra-plugin')
    const providerRegistry = new ProviderRegistry()
    const pluginRegistry = new PluginRegistryV2({
      pluginDir: fileURLToPath(new URL('../../../build/plugins/', import.meta.url)),
      manifestFileFilter: (name) => name === 'history-service.hira-plugin.json',
      providerRegistry
    })
    const manifests = pluginRegistry.discover()
    expect(manifests[0].capabilities).toEqual([
      'history.addVisit', 'history.remove', 'history.removeMany', 'history.removeBefore',
      'history.search', 'history.listRecent', 'history.clearAll', 'history.queryRange',
      'history.listVisits', 'history.countVisits', 'history.compact'
    ])
    await pluginRegistry.enableAll({ getDomainServices: () => ({ historyService: {} }) })
    expect(providerRegistry.getByCapability('history.listRecent')).toHaveLength(1)
    expect(providerRegistry.getByCapability('history.removeMany')).toHaveLength(1)
    expect(providerRegistry.getByCapability('history.removeBefore')).toHaveLength(1)
  })
})
