import { describe, expect, it, vi } from 'vitest'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const plugin = require('../../../build/plugins/session-service.cjs')

describe('session service plugin', () => {
  it('通过注入服务暴露全部会话能力', async () => {
    const tabManager = { id: 'tabs' }
    const service = {
      read: vi.fn(() => ({ tabs: [] })),
      stats: vi.fn(() => ({ tabs: 1, pinned: 0, activeIndex: 0 })),
      save: vi.fn(() => true),
      restore: vi.fn(() => ({ restored: true })),
      clear: vi.fn(() => true),
      exists: vi.fn(() => true)
    }
    const providers = plugin.registerProviders({ getDomainServices: () => ({ sessionService: service, tabManager }) })
    const byCapability = new Map(providers.map((provider) => [provider.capability, provider]))
    const input = { dir: '/profiles/default' }

    expect(byCapability.get('session.read').around(input)).toEqual({ tabs: [] })
    expect(byCapability.get('session.stats').around(input)).toEqual({ tabs: 1, pinned: 0, activeIndex: 0 })
    expect(byCapability.get('session.save').around(input)).toBe(true)
    expect(byCapability.get('session.restore').around(input)).toEqual({ restored: true })
    expect(byCapability.get('session.clear').around(input)).toBe(true)
    expect(byCapability.get('session.exists').around(input)).toBe(true)
    expect(service.save).toHaveBeenCalledWith('/profiles/default', tabManager)
    expect(service.restore).toHaveBeenCalledWith('/profiles/default', tabManager)
  })
})
