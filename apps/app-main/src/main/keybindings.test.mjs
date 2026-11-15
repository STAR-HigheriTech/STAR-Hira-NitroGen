import { describe, expect, it, vi } from 'vitest'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const {
  createKeybindingsManager,
  DEFAULT_KEYBINDINGS,
  eventToCombo,
  normalizeCombo
} = require('./keybindings.js')

function keyInput({ key, control = false, shift = false, alt = false, meta = false, type = 'keyDown' }) {
  const event = { preventDefault: vi.fn() }
  return { event, input: { type, key, control, shift, alt, meta } }
}

describe('main/keybindings', () => {
  it('保留书签默认动作', () => {
    expect(DEFAULT_KEYBINDINGS['bookmark:toggle']).toBe('Ctrl+D')
    expect(DEFAULT_KEYBINDINGS['bookmarkbar:toggle']).toBe('Ctrl+Shift+B')
    expect(DEFAULT_KEYBINDINGS['bookmarks:open']).toBe('Ctrl+Shift+O')
  })

  it('在页面聚焦时拦截 Ctrl+D 并执行书签动作', () => {
    const toggle = vi.fn()
    const kb = createKeybindingsManager({ actions: { 'bookmark:toggle': toggle } })
    const { event, input } = keyInput({ key: 'd', control: true })
    expect(kb.handleInputEvent(event, input)).toBe(true)
    expect(event.preventDefault).toHaveBeenCalledOnce()
    expect(toggle).toHaveBeenCalledOnce()
  })

  it('规范化组合键且拒绝未知动作、无效按键和冲突', () => {
    const kb = createKeybindingsManager()
    expect(kb.setKeybinding('tab:new', ' shift + ctrl + j ')).toBe('Ctrl+Shift+J')
    expect(() => kb.setKeybinding('unknown', 'Ctrl+Q')).toThrow('Unknown shortcut action')
    expect(() => kb.setKeybinding('tab:new', 'Q')).toThrow('requires a modifier')
    expect(() => kb.setKeybinding('tab:close', 'Ctrl+Shift+J')).toThrow('already belongs')
  })

  it('单项恢复默认不影响其他自定义项，并持久化', () => {
    const set = vi.fn()
    const kb = createKeybindingsManager({ settingsService: { get: () => null, set } })
    kb.setKeybinding('tab:new', 'Ctrl+Y')
    kb.setKeybinding('tab:close', 'Alt+W')
    expect(kb.resetKeybinding('tab:new')).toBe('Ctrl+T')
    expect(kb.getKeybindings()['tab:close']).toBe('Alt+W')
    expect(set).toHaveBeenLastCalledWith('keybindings', expect.objectContaining({
      'tab:new': 'Ctrl+T',
      'tab:close': 'Alt+W'
    }))
  })

  it('在外部设置变更后重建组合键索引', () => {
    let listener
    const action = vi.fn()
    const kb = createKeybindingsManager({
      actions: { 'tab:new': action },
      settingsService: { get: () => null, subscribe: (fn) => { listener = fn } }
    })
    listener({ key: 'keybindings', value: { 'tab:new': 'Alt+T' } })
    const oldShortcut = keyInput({ key: 't', control: true })
    const newShortcut = keyInput({ key: 't', alt: true })
    expect(kb.handleInputEvent(oldShortcut.event, oldShortcut.input)).toBe(false)
    expect(kb.handleInputEvent(newShortcut.event, newShortcut.input)).toBe(true)
  })

  it('只处理 keyDown，且标准化 Electron 输入组合键', () => {
    const toggle = vi.fn()
    const kb = createKeybindingsManager({ actions: { 'bookmark:toggle': toggle } })
    const keyUp = keyInput({ key: 'd', control: true, type: 'keyUp' })
    expect(kb.handleInputEvent(keyUp.event, keyUp.input)).toBe(false)
    expect(eventToCombo({ key: 'ArrowLeft', alt: true })).toBe('Alt+Left')
    expect(normalizeCombo('command + shift + i')).toBe('Shift+Meta+I')
  })
})
