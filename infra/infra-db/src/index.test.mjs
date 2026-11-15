import { describe, it, expect } from 'vitest'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const { createDb } = require('../dist/index.cjs')

describe('infra-db', () => {
  it('opens sqlite and runs query', () => {
    const { sqlite, close } = createDb(':memory:')
    const row = sqlite.prepare('select 1 as x').get()
    close()
    expect(row.x).toBe(1)
  })
})

