import { describe, it, expect, vi } from 'vitest'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const { createServicePlugin } = require('@hira-ng/infra-plugin')

describe('createServicePlugin', () => {
  const capabilities = {
    'demo.list': (svc) => svc.list(),
    'demo.add': (svc, input) => svc.add(input?.payload)
  }

  it('generates providers with stable ids, capabilities and lazy service resolution', () => {
    const plugin = createServicePlugin({ domain: 'demo', serviceName: 'demoService', capabilities })
    const first = { list: vi.fn(() => ['a']), add: vi.fn(() => 'id-1') }
    let current = first
    const ctx = { getDomainServices: () => ({ demoService: current }) }

    expect(() => plugin.install({ getDomainServices: () => ({}) })).toThrow('demoService is required by plugin demo-service')
    plugin.install(ctx)

    const providers = plugin.registerProviders(ctx)
    expect(providers).toHaveLength(2)
    expect(providers.map((p) => p.id)).toEqual(['demo.service.list', 'demo.service.add'])
    expect(providers.map((p) => p.capability)).toEqual(['demo.list', 'demo.add'])
    expect(providers.every((p) => p.metadata.domain === 'demo' && p.metadata.plugin === 'demo-service')).toBe(true)

    expect(providers.find((p) => p.capability === 'demo.list').around(null)).toEqual(['a'])
    expect(providers.find((p) => p.capability === 'demo.add').around({ payload: 'x' })).toBe('id-1')
    expect(first.add).toHaveBeenCalledWith('x')

    // 懒解析：切换服务实例后，同一 provider 立刻看到新实例
    const second = { list: vi.fn(() => ['b']), add: vi.fn(() => 'id-2') }
    current = second
    expect(providers.find((p) => p.capability === 'demo.list').around(null)).toEqual(['b'])
    expect(second.list).toHaveBeenCalledOnce()
    expect(first.list).toHaveBeenCalledOnce()
  })

  it('exposes the extension point and passes ctx through to capabilities', () => {
    const ctxCapability = vi.fn((_svc, _input, ctx) => ctx.extra)
    const plugin = createServicePlugin({
      domain: 'demo',
      serviceName: 'demoService',
      capabilities: { 'demo.ctx': ctxCapability }
    })
    const service = { list: vi.fn(), add: vi.fn() }
    const ctx = { getDomainServices: () => ({ demoService: service }), extra: 'ctx-value' }

    expect(plugin.registerExtensionPoints(ctx)).toEqual([{ name: 'demo.service', service }])
    expect(plugin.registerProviders(ctx)[0].around(null)).toBe('ctx-value')
  })

  it('validates its inputs', () => {
    expect(() => createServicePlugin({ serviceName: 's', capabilities })).toThrow(TypeError)
    expect(() => createServicePlugin({ domain: 'd', capabilities })).toThrow(TypeError)
    expect(() => createServicePlugin({ domain: 'd', serviceName: 's', capabilities: {} })).toThrow(TypeError)
  })
})
