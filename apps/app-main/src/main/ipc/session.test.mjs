import { describe, expect, it, vi } from 'vitest'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const { registerSessionIpc } = require('./session.ts')

const routes = {
  sessionRead: 'session:read',
  sessionStats: 'session:stats',
  sessionSave: 'session:save',
  sessionRestore: 'session:restore',
  sessionClear: 'session:clear',
  sessionExists: 'session:exists'
}
const schemas = Object.fromEntries(
  Object.keys(routes).map((key) => [key.replace('session', '').replace(/^./, (value) => value.toLowerCase()), { request: {}, response: {} }])
)

function createHandlers(providerRegistry, sessionService, sessionTabPort, getSessionDir = () => '/profiles/default') {
  const handlers = new Map()
  registerSessionIpc({ handle: (route, config) => handlers.set(route, config.handler) }, {
    routes,
    schemas,
    sessionService,
    sessionTabPort,
    providerRegistry,
    getSessionDir
  })
  return handlers
}

describe('session IPC registrar', () => {
  it('通过 provider 使用当前 Profile 的私有会话目录', async () => {
    const service = {
      read: vi.fn(), stats: vi.fn(), save: vi.fn(), restore: vi.fn(), clear: vi.fn(), exists: vi.fn()
    }
    const tabPort = { id: 'tabs' }
    const executeCapability = vi.fn((capability, input) => {
      if (capability === 'session.read') return { tabs: [] }
      if (capability === 'session.stats') return { tabs: 2, pinned: 1, activeIndex: 0 }
      if (capability === 'session.save') return true
      if (capability === 'session.restore') return { restored: true, activeTabId: 'tab-1' }
      if (capability === 'session.clear') return true
      return true
    })
    const handlers = createHandlers({ getByCapability: () => [{ id: 'provider' }], executeCapability }, service, tabPort)

    await expect(handlers.get(routes.sessionRead)()).resolves.toEqual({ tabs: [] })
    await expect(handlers.get(routes.sessionStats)()).resolves.toEqual({ tabs: 2, pinned: 1, activeIndex: 0 })
    await expect(handlers.get(routes.sessionSave)()).resolves.toEqual({ ok: true })
    await expect(handlers.get(routes.sessionRestore)()).resolves.toEqual({ restored: true, activeTabId: 'tab-1' })
    await expect(handlers.get(routes.sessionClear)()).resolves.toEqual({ ok: true })
    await expect(handlers.get(routes.sessionExists)()).resolves.toEqual({ exists: true })
    expect(executeCapability).toHaveBeenCalledWith('session.save', { dir: '/profiles/default' }, undefined)
    expect(service.save).not.toHaveBeenCalled()
  })

  it('provider 缺失时回退到注入的领域服务', async () => {
    const tabPort = { id: 'tabs' }
    const service = {
      read: vi.fn(() => null),
      stats: vi.fn(() => ({ tabs: 0, pinned: 0, activeIndex: -1 })),
      save: vi.fn(() => true),
      restore: vi.fn(() => ({ restored: false })),
      clear: vi.fn(() => true),
      exists: vi.fn(() => false)
    }
    const handlers = createHandlers({ getByCapability: () => [], executeCapability: vi.fn() }, service, tabPort)

    await expect(handlers.get(routes.sessionStats)()).resolves.toEqual({ tabs: 0, pinned: 0, activeIndex: -1 })
    await expect(handlers.get(routes.sessionSave)()).resolves.toEqual({ ok: true })
    await expect(handlers.get(routes.sessionRestore)()).resolves.toEqual({ restored: false })
    await expect(handlers.get(routes.sessionExists)()).resolves.toEqual({ exists: false })
    expect(service.save).toHaveBeenCalledWith('/profiles/default', tabPort)
    expect(service.restore).toHaveBeenCalledWith('/profiles/default', tabPort)
  })
})
