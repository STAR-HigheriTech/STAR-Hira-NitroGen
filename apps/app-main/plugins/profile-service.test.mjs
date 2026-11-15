import { describe, it, expect, vi } from 'vitest'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

const require = createRequire(import.meta.url)
const plugin = require('../../../build/plugins/profile-service.cjs')

describe('profile-service plugin providers', () => {
  it('exposes profile capabilities and dispatches to the current service', () => {
    const profileService = {
      list: vi.fn(() => ['one']),
      getActive: vi.fn(() => ({ id: 'one' })),
      create: vi.fn(() => ({ id: 'two' })),
      update: vi.fn(() => ({ id: 'one' })),
      setActive: vi.fn(() => ({ id: 'two' })),
      remove: vi.fn(() => true)
    }
    const ctx = { getDomainServices: () => ({ profileService }) }
    const byId = Object.fromEntries(plugin.registerProviders(ctx).map((p) => [p.capability, p]))

    expect(Object.keys(byId).sort()).toEqual([
      'profile.create', 'profile.getActive', 'profile.list', 'profile.remove', 'profile.setActive', 'profile.update'
    ])
    expect(byId['profile.list'].around(null)).toEqual(['one'])
    expect(byId['profile.getActive'].around(null)).toEqual({ id: 'one' })
    expect(byId['profile.create'].around({ name: 'Two', icon: 'i', color: 'c' })).toEqual({ id: 'two' })
    expect(profileService.create).toHaveBeenCalledWith({ name: 'Two', icon: 'i', color: 'c' })
    expect(byId['profile.update'].around({ id: 'one', name: 'One' })).toEqual({ id: 'one' })
    expect(profileService.update).toHaveBeenCalledWith('one', { name: 'One', icon: undefined, color: undefined })
    expect(byId['profile.setActive'].around({ id: 'two' })).toEqual({ id: 'two' })
    expect(profileService.setActive).toHaveBeenCalledWith('two')
    expect(byId['profile.remove'].around({ id: 'two' })).toBe(true)
    expect(profileService.remove).toHaveBeenCalledWith('two')
  })

  it('uses switchProfile from the execution context when available', async () => {
    const profileService = { setActive: vi.fn(() => ({ id: 'two' })) }
    const switchProfile = vi.fn(async (id) => ({ switched: id }))
    const ctx = { getDomainServices: () => ({ profileService }) }
    const provider = plugin.registerProviders(ctx).find((item) => item.capability === 'profile.setActive')

    await expect(provider.around({ id: 'two' }, { context: { switchProfile } })).resolves.toEqual({ switched: 'two' })
    expect(switchProfile).toHaveBeenCalledWith('two')
    expect(profileService.setActive).not.toHaveBeenCalled()
  })

  it('discovers manifest capabilities and registers them on enable', async () => {
    const { PluginRegistryV2, ProviderRegistry } = require('@hira-ng/infra-plugin')
    const providerRegistry = new ProviderRegistry()
    const pluginRegistry = new PluginRegistryV2({
      pluginDir: fileURLToPath(new URL('../../../build/plugins/', import.meta.url)),
      manifestFileFilter: (name) => name === 'profile-service.hira-plugin.json',
      providerRegistry
    })
    const manifests = pluginRegistry.discover()
    expect(manifests[0].capabilities).toEqual([
      'profile.list', 'profile.getActive', 'profile.create', 'profile.update', 'profile.setActive', 'profile.remove'
    ])
    await pluginRegistry.enableAll({ getDomainServices: () => ({ profileService: {} }) })
    expect(providerRegistry.getByCapability('profile.setActive')).toHaveLength(1)
  })
})
