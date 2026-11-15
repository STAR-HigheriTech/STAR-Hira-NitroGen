import { describe, it, expect, vi } from 'vitest'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

const require = createRequire(import.meta.url)
const plugin = require('../../../build/plugins/permission-service.cjs')

describe('permission-service plugin providers', () => {
  it('exposes one provider per permission capability and dispatches to the current service', () => {
    const first = {
      getPermission: vi.fn(() => 'ask'),
      resolveRequest: vi.fn(() => 'ask'),
      setPermission: vi.fn(() => true),
      setSitePermissions: vi.fn(() => true),
      resetSite: vi.fn(() => true),
      removePermission: vi.fn(() => true),
      listAll: vi.fn(() => []),
      listByType: vi.fn(() => []),
      pendingWithFlags: vi.fn(() => [{ id: 'preq', sensitive: true }]),
      listPendingRequests: vi.fn(() => [{ id: 'legacy' }])
    }
    let current = first
    const ctx = { getDomainServices: () => ({ permissionService: current }) }
    const byId = Object.fromEntries(plugin.registerProviders(ctx).map((p) => [p.capability, p]))

    expect(Object.keys(byId).sort()).toEqual([
      'permission.clearSite', 'permission.getPermission', 'permission.getSite',
      'permission.listAll', 'permission.listByType', 'permission.pendingList', 'permission.pendingWithFlags',
      'permission.removePermission', 'permission.resetSite', 'permission.resolveRequest',
      'permission.respond', 'permission.setPermission', 'permission.setSitePermissions'
    ])

    expect(byId['permission.resolveRequest'].around({ origin: 'o', permissionType: 'camera' })).toBe('ask')
    expect(first.resolveRequest).toHaveBeenCalledWith('o', 'camera')
    expect(byId['permission.setSitePermissions'].around({ origin: 'o', rules: { camera: 'allow' } })).toBe(true)
    expect(first.setSitePermissions).toHaveBeenCalledWith('o', { camera: 'allow' })
    expect(byId['permission.resetSite'].around({ origin: 'o' })).toBe(true)
    expect(first.resetSite).toHaveBeenCalledWith('o')
    expect(byId['permission.setPermission'].around({ origin: 'o', permissionType: 'camera', setting: 'allow' })).toBe(true)
    expect(first.setPermission).toHaveBeenCalledWith('o', 'camera', 'allow')
    expect(byId['permission.removePermission'].around({ origin: 'o', permissionType: 'camera' })).toBe(true)
    expect(first.removePermission).toHaveBeenCalledWith('o', 'camera')
    expect(byId['permission.listByType'].around({ permissionType: 'camera' })).toEqual([])
    expect(first.listByType).toHaveBeenCalledWith('camera')
    expect(byId['permission.pendingList'].around(null)).toEqual([{ id: 'preq', sensitive: true }])
    expect(first.pendingWithFlags).toHaveBeenCalled()
    expect(byId['permission.pendingWithFlags'].around(null)).toEqual([{ id: 'preq', sensitive: true }])

    current = { ...first, listAll: vi.fn(() => ['fresh']) }
    expect(byId['permission.listAll'].around(null)).toEqual(['fresh'])
  })

  it('discovers manifest capabilities and registers them on enable', async () => {
    const { PluginRegistryV2, ProviderRegistry } = require('@hira-ng/infra-plugin')
    const providerRegistry = new ProviderRegistry()
    const pluginRegistry = new PluginRegistryV2({
      pluginDir: fileURLToPath(new URL('../../../build/plugins/', import.meta.url)),
      manifestFileFilter: (name) => name === 'permission-service.hira-plugin.json',
      providerRegistry
    })
    const manifests = pluginRegistry.discover()
    expect(manifests[0].capabilities).toContain('permission.pendingList')
    await pluginRegistry.enableAll({ getDomainServices: () => ({ permissionService: {
        pendingWithFlags: vi.fn(() => [])
      }
    }) })
    expect(providerRegistry.getByCapability('permission.pendingList')).toHaveLength(1)
  })
})
