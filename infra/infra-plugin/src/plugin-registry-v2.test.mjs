import { describe, it, expect, vi } from 'vitest'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const { PluginRegistryV2 } = require('@hira-ng/infra-plugin')

describe('infra-plugin PluginRegistryV2', () => {
  it('validates deps and supports enable/disable', async () => {
    const reg = new PluginRegistryV2({
      loader: (m) => {
        if (m.id === 'a') {
          return {
            install() {},
            registerExtensionPoints() {
              return [{ name: 'ep.x', value: 1 }]
            },
            enable() {},
            disable() {}
          }
        }
        return { install() {}, enable() {}, disable() {} }
      }
    })

    reg.setManifests([
      { id: 'a', version: '1', dependsOn: [], conflictsWith: [] },
      { id: 'b', version: '1', dependsOn: ['a'], conflictsWith: [] }
    ])

    await reg.enableAll({})
    expect(reg.getState('a').enabled).toBe(true)
    expect(Object.keys(reg.getExtensionPoints()).length).toBe(1)

    await reg.disable('a', {})
    expect(reg.getState('a').enabled).toBe(false)
  })

  it('registers providers on enable and removes them on disable', async () => {
    const providerRegistry = {
      providers: [],
      register(provider) {
        this.providers.push(provider)
      },
      list() {
        return this.providers.slice()
      },
      unregister(id) {
        this.providers = this.providers.filter((provider) => provider.id !== id)
      }
    }
    const registerProviders = vi.fn(() => [{
      id: 'tabs.service.list',
      capability: 'tabs.list',
      around(value) {
        return value
      }
    }])
    const reg = new PluginRegistryV2({
      providerRegistry,
      loader: () => ({ install() {}, registerProviders, enable() {}, disable() {} })
    })
    reg.setManifests([{ id: 'tabs-service', version: '1', dependsOn: [], conflictsWith: [] }])

    await reg.enableAll({ tabsService: { list() { return [] } } })
    expect(registerProviders).toHaveBeenCalledOnce()
    expect(providerRegistry.providers).toHaveLength(1)
    expect(providerRegistry.providers[0].pluginId).toBe('tabs-service')

    await reg.disable('tabs-service')
    expect(providerRegistry.providers).toHaveLength(0)
  })

  it('detects conflicts', () => {
    const reg = new PluginRegistryV2({ loader: () => ({ install() {} }) })
    reg.setManifests([
      { id: 'a', dependsOn: [], conflictsWith: ['b'] },
      { id: 'b', dependsOn: [], conflictsWith: [] }
    ])
    expect(() => reg.validateDeps()).toThrow()
  })
})

