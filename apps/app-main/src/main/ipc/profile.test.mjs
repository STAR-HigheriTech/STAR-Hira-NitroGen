import { describe, it, expect, vi } from 'vitest'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const { registerProfileIpc } = require('./profile.ts')

const routes = {
  profileList: 'profile:list',
  profileGetActive: 'profile:get-active',
  profileCreate: 'profile:create',
  profileUpdate: 'profile:update',
  profileSetActive: 'profile:set-active',
  profileRemove: 'profile:remove'
}

const schemas = Object.fromEntries(Object.keys(routes).map((key) => [key.replace('profile', '').replace(/^./, (value) => value.toLowerCase()), { request: {}, response: {} }]))

function createHandlers(providerRegistry, profileService, switchProfile) {
  const handlers = new Map()
  registerProfileIpc({ handle: (route, config) => handlers.set(route, config.handler) }, { routes, schemas, profileService, switchProfile, providerRegistry })
  return handlers
}

describe('profile IPC registrar', () => {
  it('routes profile operations through providers', async () => {
    const profileService = {
      list: vi.fn(() => ['fallback']),
      getActive: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
      setActive: vi.fn(),
      remove: vi.fn()
    }
    const executeCapability = vi.fn((capability, input) => `${capability}:${input?.id || 'none'}`)
    const handlers = createHandlers({ getByCapability: () => [{ id: 'provider' }], executeCapability }, profileService)

    await expect(handlers.get(routes.profileList)(null, null)).resolves.toBe('profile.list:none')
    await expect(handlers.get(routes.profileCreate)(null, { name: 'New' })).resolves.toBe('profile.create:none')
    await expect(handlers.get(routes.profileRemove)(null, { id: 'old' })).resolves.toEqual({ ok: 'profile.remove:old' })
    expect(executeCapability).toHaveBeenCalledWith('profile.create', { name: 'New' }, undefined)
    expect(profileService.list).not.toHaveBeenCalled()
  })

  it('routes set-active through the provider with switchProfile in its execution context', async () => {
    const profileService = { setActive: vi.fn() }
    const switchProfile = vi.fn(async (id) => ({ switched: id }))
    const executeCapability = vi.fn((capability, input, context) => context.switchProfile(input.id))
    const handlers = createHandlers({ getByCapability: () => [{ id: 'provider' }], executeCapability }, profileService, switchProfile)

    await expect(handlers.get(routes.profileSetActive)(null, { id: 'next' })).resolves.toEqual({ switched: 'next' })
    expect(executeCapability).toHaveBeenCalledWith('profile.setActive', { id: 'next' }, { switchProfile })
    expect(switchProfile).toHaveBeenCalledWith('next')
    expect(profileService.setActive).not.toHaveBeenCalled()
  })
})
