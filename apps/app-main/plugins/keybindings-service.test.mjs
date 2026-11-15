import { describe, expect, it, vi } from 'vitest'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const plugin = require('../../../build/plugins/keybindings-service.cjs')

function createContext(keybindings) {
  return { getDomainServices: () => ({ keybindings }) }
}

describe('keybindings service plugin', () => {
  it('通过注入服务暴露所有快捷键能力', () => {
    const service = {
      getKeybindings: vi.fn(() => ({ 'tab:new': 'Ctrl+T' })),
      getDefaults: vi.fn(() => ({ 'tab:new': 'Ctrl+T' })),
      setKeybinding: vi.fn(() => 'Alt+T'),
      resetKeybinding: vi.fn(() => 'Ctrl+T'),
      reset: vi.fn()
    }
    const providers = plugin.registerProviders(createContext(service))
    const byCapability = new Map(providers.map((provider) => [provider.capability, provider]))

    expect(byCapability.get('keybindings.get').around()).toEqual({ 'tab:new': 'Ctrl+T' })
    expect(byCapability.get('keybindings.defaults').around()).toEqual({ 'tab:new': 'Ctrl+T' })
    expect(byCapability.get('keybindings.set').around({ action: 'tab:new', combo: 'Alt+T' })).toBe('Alt+T')
    expect(byCapability.get('keybindings.reset-one').around({ action: 'tab:new' })).toBe('Ctrl+T')
    byCapability.get('keybindings.reset').around()
    expect(service.setKeybinding).toHaveBeenCalledWith('tab:new', 'Alt+T')
    expect(service.resetKeybinding).toHaveBeenCalledWith('tab:new')
    expect(service.reset).toHaveBeenCalledOnce()
  })
})
