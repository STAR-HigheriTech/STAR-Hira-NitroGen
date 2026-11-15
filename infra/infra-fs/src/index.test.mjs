import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const { writeJsonAtomic, readJson, pathExists } = require('../dist/index.cjs')

function mkTmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'hira-ng-fs-'))
}

describe('infra-fs', () => {
  it('writes and reads json atomically', async () => {
    const dir = mkTmpDir()
    const filePath = path.join(dir, 'a', 'b', 'c.json')
    await writeJsonAtomic(filePath, { ok: true })
    expect(await pathExists(filePath)).toBe(true)
    expect(await readJson(filePath)).toEqual({ ok: true })
  })
})

