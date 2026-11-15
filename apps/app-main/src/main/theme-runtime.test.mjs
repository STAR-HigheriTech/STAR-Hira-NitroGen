import { describe, it, expect } from 'vitest'
import { EventEmitter } from 'node:events'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const { createThemeRuntime } = require('./theme-runtime.js')

describe('theme runtime', () => {
  it('broadcasts a system theme resolution change once', async () => {
    const nativeTheme = new EventEmitter()
    nativeTheme.shouldUseDarkColors = true
    const setTheme = async () => true
    const broadcast = (...args) => calls.push(args)
    const calls = []
    const runtime = createThemeRuntime({
      nativeTheme,
      settings: { get: () => 'system' },
      themeManager: { setTheme, getResolvedTheme: () => 'dark' },
      broadcast
    })

    runtime.start()
    nativeTheme.emit('updated')
    await new Promise((resolve) => setTimeout(resolve, 0))
    runtime.stop()

    expect(calls).toEqual([['theme:changed', { preference: 'system', resolved: 'dark' }]])
  })

  it('ignores native updates outside system preference and detaches cleanly', async () => {
    const nativeTheme = new EventEmitter()
    const setTheme = async () => true
    const broadcast = (...args) => calls.push(args)
    const calls = []
    const runtime = createThemeRuntime({
      nativeTheme,
      settings: { get: () => 'dark' },
      themeManager: { setTheme, getResolvedTheme: () => 'dark' },
      broadcast
    })

    runtime.start()
    nativeTheme.emit('updated')
    await new Promise((resolve) => setTimeout(resolve, 0))
    runtime.stop()
    nativeTheme.emit('updated')
    await new Promise((resolve) => setTimeout(resolve, 0))

    expect(calls).toEqual([])
  })
})
