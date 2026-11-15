import { describe, it, expect } from 'vitest'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const { WindowRegistry } = require('./WindowRegistry')

describe('infra-window WindowRegistry', () => {
  it('registers and lists windows', () => {
    const reg = new WindowRegistry()
    reg.register({ id: 1 })
    reg.register({ id: 2 })
    expect(reg.listIds().sort()).toEqual([1, 2])
    expect(reg.getById(2)).toEqual({ id: 2 })
    reg.unregisterById(1)
    expect(reg.getById(1)).toBe(null)
  })
})

