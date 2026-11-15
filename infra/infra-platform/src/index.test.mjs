import { describe, it, expect } from 'vitest'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const { platform, isWin, isMac, isLinux, getAppDataDir } = require('../dist/index.cjs')

describe('infra-platform', () => {
  it('detects platform flags consistently', () => {
    const flags = [isWin(), isMac(), isLinux()].filter(Boolean).length
    expect(flags).toBe(1)
    expect(typeof platform).toBe('string')
  })

  it('computes app data directory', () => {
    const dir = getAppDataDir('hira-ng-test')
    expect(typeof dir).toBe('string')
    expect(dir.length).toBeGreaterThan(3)
  })
})

