import { describe, it, expect, vi } from 'vitest'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

const require = createRequire(import.meta.url)
const plugin = require('../../../build/plugins/password-service.cjs')

describe('password-service plugin providers', () => {
  it('exposes one provider per password capability and dispatches to the current service', () => {
    const first = {
      listBackends: vi.fn(() => ['sqlite']),
      saveCredential: vi.fn(() => true),
      getSuggestions: vi.fn(() => []),
      deleteCredential: vi.fn(() => true),
      listCredentials: vi.fn(() => []),
      setActiveBackend: vi.fn(() => true),
      addNeverSave: vi.fn(),
      removeNeverSave: vi.fn(),
      getNeverSaveDomains: vi.fn(() => [])
    }
    let current = first
    const ctx = { getDomainServices: () => ({ passwordService: current }) }
    const byId = Object.fromEntries(plugin.registerProviders(ctx).map((p) => [p.capability, p]))

    expect(Object.keys(byId).sort()).toEqual([
      'password.addNeverSave', 'password.backendAction', 'password.deleteCredential',
      'password.getBackendStatus', 'password.getSuggestions', 'password.importCredentials',
      'password.listBackends', 'password.listCredentials', 'password.listNeverSave',
      'password.removeNeverSave', 'password.saveCredential', 'password.setActiveBackend'
    ])

    expect(byId['password.saveCredential'].around({ hostname: 'h' })).toBe(true)
    expect(first.saveCredential).toHaveBeenCalledWith({ hostname: 'h' })
    expect(byId['password.getSuggestions'].around({ hostname: 'h' })).toEqual([])
    expect(first.getSuggestions).toHaveBeenCalledWith('h')
    expect(byId['password.deleteCredential'].around({ id: 'x' })).toBe(true)
    expect(first.deleteCredential).toHaveBeenCalledWith('x')
    expect(byId['password.setActiveBackend'].around({ name: 'sqlite' })).toBe(true)
    expect(first.setActiveBackend).toHaveBeenCalledWith('sqlite')
    byId['password.addNeverSave'].around({ hostname: 'h' })
    expect(first.addNeverSave).toHaveBeenCalledWith('h')

    current = { ...first, listCredentials: vi.fn(() => ['fresh']) }
    expect(byId['password.listCredentials'].around(null)).toEqual(['fresh'])
  })

  it('discovers manifest capabilities and registers them on enable', async () => {
    const { PluginRegistryV2, ProviderRegistry } = require('@hira-ng/infra-plugin')
    const providerRegistry = new ProviderRegistry()
    const pluginRegistry = new PluginRegistryV2({
      pluginDir: fileURLToPath(new URL('../../../build/plugins/', import.meta.url)),
      manifestFileFilter: (name) => name === 'password-service.hira-plugin.json',
      providerRegistry
    })
    const manifests = pluginRegistry.discover()
    expect(manifests[0].capabilities).toContain('password.listNeverSave')
    await pluginRegistry.enableAll({ getDomainServices: () => ({ passwordService: {} }) })
    expect(providerRegistry.getByCapability('password.listNeverSave')).toHaveLength(1)
  })
})
