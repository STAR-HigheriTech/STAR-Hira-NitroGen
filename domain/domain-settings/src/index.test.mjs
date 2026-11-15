/**
 * domain-settings 服务接线单测 —— 零 Electron / 零磁盘。
 *
 * 用假 FilePort 注入（{join, existsSync:()=>false, readJsonSync, writeJsonAtomicSync,
 * writeJsonAtomic:async}），让 createSettingsService 在纯 Node 下可测。
 * 覆盖 set 型别强制/数值夹界、list(section)、changedKeys、cssVars、reset。
 */
import { describe, it, expect, vi } from 'vitest'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const { createSettingsService } = require('../dist/index.cjs')
const { DEFAULT_THEME_ID } = require('@hira-ng/shared-types/src/theme.mjs')

/** 构造一个假 FilePort；existsSync 默认 false 故 load() 直接取 DEFAULT_SETTINGS。 */
function makeService() {
  const writeSync = vi.fn()
  const writeAsync = vi.fn(async () => {})
  const filePort = {
    join: (...p) => p.join('/'),
    existsSync: () => false,
    readJsonSync: () => ({}),
    writeJsonAtomicSync: writeSync,
    writeJsonAtomic: writeAsync
  }
  const svc = createSettingsService({ dataDir: '/data', filePort })
  return { svc, filePort, writeSync, writeAsync }
}

describe('settings · set 型别强制 + 数值夹界', () => {
  it('string 型：数值被强制转成字符串', () => {
    const { svc } = makeService()
    svc.set('app.theme', 123)
    expect(svc.get('app.theme')).toBe('123')
  })

  it('boolean 型：字符串/0/1 被语义化强制', () => {
    const { svc } = makeService()
    svc.set('search.suggestions_enabled', 'true')
    expect(svc.get('search.suggestions_enabled')).toBe(true)
    svc.set('privacy.block_ads', 1)
    expect(svc.get('privacy.block_ads')).toBe(true)
    svc.set('app.continue_where_you_left_off', 'false')
    expect(svc.get('app.continue_where_you_left_off')).toBe(false)
  })

  it('number 型：数字串被强制转成 number', () => {
    const { svc } = makeService()
    svc.set('downloads.max_connections', '4')
    expect(svc.get('downloads.max_connections')).toBe(4)
  })

  it('number 型越界被夹取到边界内', () => {
    const { svc } = makeService()
    svc.set('downloads.max_connections', 99)   // 上限 16
    expect(svc.get('downloads.max_connections')).toBe(16)
    svc.set('downloads.max_connections', -5)   // 下限 1
    expect(svc.get('downloads.max_connections')).toBe(1)
  })

  it('rate_limit 0 与正向值合法，越界夹到上限', () => {
    const { svc } = makeService()
    svc.set('downloads.rate_limit_bytes_per_sec', '1048576')
    expect(svc.get('downloads.rate_limit_bytes_per_sec')).toBe(1048576)
    svc.set('downloads.rate_limit_bytes_per_sec', 0)
    expect(svc.get('downloads.rate_limit_bytes_per_sec')).toBe(0)
    svc.set('downloads.rate_limit_bytes_per_sec', 5e9) // > 1GB, 夹到上限
    expect(svc.get('downloads.rate_limit_bytes_per_sec')).toBe(1024 * 1024 * 1024)
  })
})

describe('settings · list(section)', () => {
  it('返回该 section 前缀下的键值子集', () => {
    const { svc } = makeService()
    const d = svc.list('downloads')
    const keys = Object.keys(d)
    expect(keys.length).toBeGreaterThan(0)
    expect(keys.every((k) => k.startsWith('downloads.'))).toBe(true)
  })

  it('缺省 section 返回整份设置的浅拷贝', () => {
    const { svc } = makeService()
    expect(svc.list()).toHaveProperty('app.theme')
    expect(svc.list()).not.toBe(svc.list())
  })
})

describe('settings · changedKeys', () => {
  it('默认态时无差异键', () => {
    const { svc } = makeService()
    expect(svc.changedKeys()).toEqual([])
  })

  it('修改某默认键后出现在差异列表', () => {
    const { svc } = makeService()
    svc.set('app.theme', 'dark')
    expect(svc.changedKeys()).toContain('app.theme')
  })

  it('新增未知键不在差异列表（无默认值，reset 也不还原）', () => {
    const { svc } = makeService()
    svc.set('custom.new_option', 'x')
    expect(svc.changedKeys()).not.toContain('custom.new_option')
  })
})

describe('settings · cssVars', () => {
  it('只投影 app/ui 展示型 section，键转成 CSS 变量后缀', () => {
    const { svc } = makeService()
    svc.set('app.theme', 'dark')
    // 行为型 section（downloads）不出现
    svc.set('downloads.max_connections', 4)
    const vars = svc.cssVars()
    expect(vars.theme).toBe('dark')
    expect(vars).not.toHaveProperty('max_connections')
    expect(Object.keys(vars).length).toBeGreaterThan(0)
  })
})

describe('settings · reset', () => {
  it('reset 单个默认键会还原默认值', () => {
    const { svc } = makeService()
    svc.set('app.theme', 'dark')
    svc.reset('app.theme')
    expect(svc.get('app.theme')).toBe(DEFAULT_THEME_ID)
  })

  it('reset 未知键返回 false', () => {
    const { svc } = makeService()
    expect(svc.reset('no.such.key')).toBe(false)
  })
})
