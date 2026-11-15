import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const { JsonStore, CrossWinSyncer, z } = require('../dist/index.cjs')

function mkTmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'hira-ng-storage-'))
}

describe('infra-storage', () => {
  it('JsonStore writes and flushes', async () => {
    const dir = mkTmpDir()
    const filePath = path.join(dir, 'store.json')

    const store = new JsonStore(filePath, { saveDelayMs: 5, schema: z.object({ n: z.number() }) })
    store.write({ n: 1 })
    await store.flush()

    const raw = JSON.parse(fs.readFileSync(filePath, 'utf8'))
    expect(raw).toEqual({ n: 1 })
  })

  it('CrossWinSyncer emits on change', async () => {
    const dir = mkTmpDir()
    const filePath = path.join(dir, 'a.json')
    fs.writeFileSync(filePath, JSON.stringify({ a: 1 }))

    const syncer = new CrossWinSyncer(filePath, { stabilityThresholdMs: 10, usePolling: true, pollIntervalMs: 20 })
    await syncer.ready
    let hits = 0
    const unsub = syncer.subscribe(() => {
      hits += 1
    })

    fs.writeFileSync(filePath, JSON.stringify({ a: 2 }))
    await new Promise((r) => setTimeout(r, 200))

    unsub()
    await syncer.close()

    expect(hits).toBeGreaterThan(0)
  })
})
