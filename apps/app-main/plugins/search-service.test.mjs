import { describe, it, expect, vi } from 'vitest'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

const require = createRequire(import.meta.url)
const plugin = require('../../../build/plugins/search-service.cjs')

describe('search-service plugin providers', () => {
  it('exposes one provider per search capability and dispatches to the current service', () => {
    const first = {
      search: vi.fn(() => []),
      searchHistorySuggestions: vi.fn(() => []),
      recordSearchQuery: vi.fn(),
      removeSearchHistoryEntry: vi.fn(() => true),
      clearSearchHistory: vi.fn(() => 2),
      getBangs: vi.fn(() => [])
    }
    let current = first
    const ctx = { getDomainServices: () => ({ searchService: current }) }
    const byId = Object.fromEntries(plugin.registerProviders(ctx).map((p) => [p.capability, p]))

    expect(Object.keys(byId).sort()).toEqual([
      'search.clearSearchHistory', 'search.getBangs', 'search.getSearchConfig',
      'search.getSearchEngines', 'search.recordSearchQuery', 'search.removeSearchHistoryEntry', 'search.search',
      'search.searchHistorySuggestions'
    ])

    expect(byId['search.search'].around({ query: 'q', limit: 8 })).toEqual([])
    expect(first.search).toHaveBeenCalledWith('q', { limit: 8 })
    expect(byId['search.searchHistorySuggestions'].around({ query: 'q', limit: 5 })).toEqual([])
    expect(first.searchHistorySuggestions).toHaveBeenCalledWith('q', 5)
    byId['search.recordSearchQuery'].around({ query: 'q' })
    expect(first.recordSearchQuery).toHaveBeenCalledWith('q')
    expect(byId['search.removeSearchHistoryEntry'].around({ id: 'sh-1' })).toBe(true)
    expect(first.removeSearchHistoryEntry).toHaveBeenCalledWith('sh-1')
    expect(byId['search.clearSearchHistory'].around(null)).toBe(2)

    current = { ...first, getBangs: vi.fn(() => ['fresh']) }
    expect(byId['search.getBangs'].around(null)).toEqual(['fresh'])
  })

  it('discovers manifest capabilities and registers them on enable', async () => {
    const { PluginRegistryV2, ProviderRegistry } = require('@hira-ng/infra-plugin')
    const providerRegistry = new ProviderRegistry()
    const pluginRegistry = new PluginRegistryV2({
      pluginDir: fileURLToPath(new URL('../../../build/plugins/', import.meta.url)),
      manifestFileFilter: (name) => name === 'search-service.hira-plugin.json',
      providerRegistry
    })
    const manifests = pluginRegistry.discover()
    expect(manifests[0].capabilities).toContain('search.getSearchConfig')
    expect(manifests[0].capabilities).toContain('search.removeSearchHistoryEntry')
    await pluginRegistry.enableAll({ getDomainServices: () => ({ searchService: {} }) })
    expect(providerRegistry.getByCapability('search.getSearchConfig')).toHaveLength(1)
  })
})
