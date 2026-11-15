import { describe, it, expect } from 'vitest'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const { createErrorReport, withRetry, withFallback } = require('../dist/index.cjs')

describe('infra-error', () => {
  it('creates report', () => {
    const report = createErrorReport(new Error('x'))
    expect(report.message).toBe('x')
    expect(report.name).toBe('Error')
  })

  it('retries', async () => {
    let n = 0
    const fn = withRetry(async () => {
      n += 1
      if (n < 2) throw new Error('fail')
      return 'ok'
    })
    expect(await fn()).toBe('ok')
  })

  it('fallback', async () => {
    const fn = withFallback(async () => {
      throw new Error('x')
    }, 123)
    expect(await fn()).toBe(123)
  })
})

