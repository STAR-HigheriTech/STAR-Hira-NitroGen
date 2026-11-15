import { describe, it, expect, vi } from 'vitest'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const { ProviderRegistry } = require('@hira-ng/infra-plugin')

describe('ProviderRegistry', () => {
  it('runs the four hooks in order and returns the transformed value', async () => {
    const calls = []
    const registry = new ProviderRegistry()
    registry.register({
      id: 'test.transform',
      capability: 'test.transform',
      hooks: {
        before(value) { calls.push('before'); return value + 1 },
        validate(value) { calls.push('validate'); return value > 0 },
        around(value, _execution, next) { calls.push('around'); return next(value * 2) },
        after(value) { calls.push('after'); return value + 3 }
      }
    })

    await expect(registry.executeCapability('test.transform', 1)).resolves.toBe(7)
    expect(calls).toEqual(['before', 'validate', 'around', 'after'])
  })

  it('rejects duplicate providers and supports plugin cleanup', () => {
    const registry = new ProviderRegistry()
    registry.register({ id: 'test.a', capability: 'test', pluginId: 'plugin.a', around(value) { return value } })
    expect(() => registry.register({ id: 'test.a', capability: 'test', around(value) { return value } })).toThrow()
    expect(registry.unregister('test.a')).toBe(true)
  })

  it('composes providers by priority and preserves the around chain', async () => {
    const calls = []
    const registry = new ProviderRegistry()
    registry.register({
      id: 'test.low',
      capability: 'test.chain',
      priority: 1,
      around(value, _execution, next) { calls.push('low-in'); return next(`${value}-low`) .then((result) => { calls.push('low-out'); return result }) }
    })
    registry.register({
      id: 'test.high',
      capability: 'test.chain',
      priority: 2,
      around(value, _execution, next) { calls.push('high-in'); return next(`${value}-high`).then((result) => { calls.push('high-out'); return result }) }
    })

    await expect(registry.executeCapability('test.chain', 'start')).resolves.toBe('start-high-low')
    expect(calls).toEqual(['high-in', 'low-in', 'low-out', 'high-out'])
  })

  it('reports hook failures and enforces execution timeout', async () => {
    const onError = vi.fn()
    const registry = new ProviderRegistry({ defaultTimeoutMs: 5, onError })
    registry.register({
      id: 'test.timeout',
      capability: 'test.timeout',
      around() { return new Promise(() => {}) }
    })

    await expect(registry.executeCapability('test.timeout', null)).rejects.toThrow('timed out')
    expect(onError).toHaveBeenCalledOnce()
  })

  it('supports service lookup, permissions, lifecycle, and disabled providers', async () => {
    const calls = []
    const registry = new ProviderRegistry()
    registry.registerService('search', { query: () => 'ok' }, { pluginId: 'search-service' })
    expect(registry.getService('search').query()).toBe('ok')
    expect(registry.describeService('search').pluginId).toBe('search-service')
    registry.register({
      id: 'test.secure',
      capability: 'test.secure',
      pluginId: 'test-plugin',
      permissions: ['tabs:read'],
      lifecycle: {
        install() { calls.push('install') },
        enable() { calls.push('enable') }
      },
      around(value) { return value + 1 }
    })
    await registry.runLifecycleForPlugin('install', 'test-plugin')
    await registry.runLifecycle('enable', 'test.secure')
    expect(calls).toEqual(['install', 'enable'])
    await expect(registry.execute('test.secure', 1)).rejects.toThrow('permission denied')
    await expect(registry.execute('test.secure', 1, { permissions: ['tabs:read'] })).resolves.toBe(2)
    expect(registry.disable('test.secure')).toBe(true)
    await expect(registry.execute('test.secure', 1, { permissions: ['tabs:read'] })).rejects.toThrow('Disabled provider')
  })

  it('supports default providers and explicit override selection', async () => {
    const registry = new ProviderRegistry()
    registry.registerDefault({
      id: 'test.default',
      capability: 'test.override',
      allowOverride: true,
      around() { return 'default' }
    })
    registry.registerOverride({
      id: 'test.override',
      capability: 'test.override',
      permissions: ['test.override:provider:override'],
      around() { return 'override' }
    })
    await expect(registry.executeCapability('test.override', null, { permissions: ['test.override:provider:override'] })).resolves.toBe('override')
  })
})
