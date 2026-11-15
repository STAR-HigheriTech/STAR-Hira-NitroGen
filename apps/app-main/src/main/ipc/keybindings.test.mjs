import { describe, expect, it, vi } from 'vitest'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const { registerKeybindingsIpc } = require('./keybindings.ts')

const routes = {
  keybindingsGet: 'keybindings:get',
  keybindingsDefaults: 'keybindings:defaults',
  keybindingsSet: 'keybindings:set',
  keybindingsResetOne: 'keybindings:reset-one',
  keybindingsReset: 'keybindings:reset'
}
const schemas = {
  get: { request: {}, response: {} },
  defaults: { request: {}, response: {} },
  set: { request: {}, response: {} },
  resetOne: { request: {}, response: {} },
  reset: { request: {}, response: {} }
}

function createHandlers(providerRegistry, keybindings) {
  const handlers = new Map()
  registerKeybindingsIpc({ handle: (route, config) => handlers.set(route, config.handler) }, { routes, schemas, keybindings, providerRegistry })
  return handlers
}

describe('keybindings IPC registrar', () => {
  it('通过 provider 分发全部快捷键能力', async () => {
    const keybindings = {
      getKeybindings: vi.fn(() => ({ fallback: true })),
      getDefaults: vi.fn(() => ({ defaults: true })),
      setKeybinding: vi.fn(),
      resetKeybinding: vi.fn(),
      reset: vi.fn()
    }
    const executeCapability = vi.fn((capability, input) => {
      if (capability === 'keybindings.get') return { from: 'provider' }
      if (capability === 'keybindings.defaults') return { defaults: 'provider' }
      if (capability === 'keybindings.set') return 'Alt+T'
      if (capability === 'keybindings.reset-one') return 'Ctrl+T'
      return input
    })
    const handlers = createHandlers({ getByCapability: () => [{ id: 'provider' }], executeCapability }, keybindings)

    await expect(handlers.get(routes.keybindingsGet)()).resolves.toEqual({ from: 'provider' })
    await expect(handlers.get(routes.keybindingsDefaults)()).resolves.toEqual({ defaults: 'provider' })
    await expect(handlers.get(routes.keybindingsSet)(null, { action: 'tab:new', combo: 'Alt+T' })).resolves.toEqual({ ok: true, combo: 'Alt+T' })
    await expect(handlers.get(routes.keybindingsResetOne)(null, { action: 'tab:new' })).resolves.toEqual({ ok: true, combo: 'Ctrl+T' })
    await expect(handlers.get(routes.keybindingsReset)()).resolves.toEqual({ ok: true })
    expect(keybindings.getKeybindings).not.toHaveBeenCalled()
  })

  it('provider 缺失时使用执行器回退', async () => {
    const keybindings = {
      getKeybindings: vi.fn(() => ({ fallback: true })),
      getDefaults: vi.fn(() => ({ 'tab:new': 'Ctrl+T' })),
      setKeybinding: vi.fn(() => 'Alt+T'),
      resetKeybinding: vi.fn(() => 'Ctrl+T'),
      reset: vi.fn()
    }
    const handlers = createHandlers({ getByCapability: () => [], executeCapability: vi.fn() }, keybindings)

    await expect(handlers.get(routes.keybindingsGet)()).resolves.toEqual({ fallback: true })
    await expect(handlers.get(routes.keybindingsDefaults)()).resolves.toEqual({ 'tab:new': 'Ctrl+T' })
    await expect(handlers.get(routes.keybindingsSet)(null, { action: 'tab:new', combo: 'Alt+T' })).resolves.toEqual({ ok: true, combo: 'Alt+T' })
    await expect(handlers.get(routes.keybindingsResetOne)(null, { action: 'tab:new' })).resolves.toEqual({ ok: true, combo: 'Ctrl+T' })
    expect(keybindings.setKeybinding).toHaveBeenCalledWith('tab:new', 'Alt+T')
  })
})
