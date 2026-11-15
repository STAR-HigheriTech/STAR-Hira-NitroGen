import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const { createLogger, createFileSink } = require('../dist/index.cjs')

function mkTmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'hira-ng-logger-'))
}

describe('infra-logger', () => {
  it('writes and rotates by size', async () => {
    const dir = mkTmpDir()
    const filePath = path.join(dir, 'app.log')
    // fileSink 是**批量异步**落盘：给一个小的 flushBytes 让每两行就成一批，
    // 并在每行后让出一拍，使「在途写」落地后再判下一批（轮转依赖上一批已存在）。
    const sink = createFileSink({ filePath, maxBytes: 120, maxFiles: 3, flushBytes: 48 })
    const log = createLogger({ level: 'debug', sinks: [sink] })

    for (let i = 0; i < 20; i += 1) {
      log.info('hello', String(i).padStart(2, '0'))
      await new Promise((r) => setImmediate(r))
    }
    log.flush()

    expect(fs.existsSync(filePath)).toBe(true)
    const rotated = fs.existsSync(`${filePath}.1`) || fs.existsSync(`${filePath}.2`) || fs.existsSync(`${filePath}.3`)
    expect(rotated).toBe(true)
  })

  it('buffers without touching disk until flush', () => {
    const dir = mkTmpDir()
    const filePath = path.join(dir, 'app.log')
    const sink = createFileSink({ filePath, maxBytes: 1024 * 1024 })
    const log = createLogger({ level: 'debug', sinks: [sink] })

    log.info('one')
    log.info('two')
    // 未达 flushBytes、定时器也未到点：此刻不应有同步落盘
    expect(fs.existsSync(filePath)).toBe(false)

    log.flush()
    expect(fs.readFileSync(filePath, 'utf8')).toContain('one')
    expect(fs.readFileSync(filePath, 'utf8')).toContain('two')
  })
})

