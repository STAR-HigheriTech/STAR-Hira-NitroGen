import { describe, it, expect } from 'vitest'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const { loadTokensCss, normalizeTheme, resolveTheme, createThemeManager } = require('../dist/index.cjs')

describe('infra-theme', () => {
  it('loads tokens css', async () => {
    const css = await loadTokensCss('light')
    expect(typeof css).toBe('string')
    expect(css.length).toBeGreaterThan(10)
  })

  it('emits change event', async () => {
    const mgr = createThemeManager({ initialTheme: 'light' })
    let hits = 0
    const unsub = mgr.onChange(() => {
      hits += 1
    })
    await mgr.setTheme('dark')
    unsub()
    expect(hits).toBe(1)
  })

  it('refreshes the resolved theme when system preference remains unchanged', async () => {
    const mgr = createThemeManager({ initialTheme: 'system', prefersDark: false })
    const changes = []
    const unsub = mgr.onChange((preference, resolved) => changes.push({ preference, resolved }))

    expect(await mgr.setTheme('system', { prefersDark: true })).toBe(true)
    expect(await mgr.setTheme('system', { prefersDark: true })).toBe(false)
    unsub()

    expect(mgr.getTheme()).toBe('system')
    expect(mgr.getResolvedTheme()).toBe('dark')
    expect(changes).toEqual([{ preference: 'system', resolved: 'dark' }])
  })

  it('normalizes and resolves system themes deterministically', () => {
    expect(normalizeTheme('invalid')).toBe('light')
    expect(resolveTheme('system', true)).toBe('dark')
    expect(resolveTheme('system', false)).toBe('light')
    const mgr = createThemeManager({ initialTheme: 'system' })
    expect(mgr.getTheme()).toBe('system')
    expect(mgr.getResolvedTheme(true)).toBe('dark')
  })
})
