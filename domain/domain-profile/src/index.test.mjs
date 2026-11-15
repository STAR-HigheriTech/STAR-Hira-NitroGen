/**
 * domain-profile 单测 —— 真实 SQLite（:memory:）+ Drizzle，零 Electron。
 *
 * 覆盖本迭代新增的纯规则接线：
 *   - create 采用 safeName 兜底名（validateProfileName 回落默认）
 *   - sorted() 复用 list 后按 lastActiveAt 纯规则排序
 *   - pickActiveFrom / merge 非原地 / normalize / isDefaultId
 */
import { describe, it, expect } from 'vitest'
import { createRequire } from 'node:module'
import { createProfileService } from './index.ts'

const require = createRequire(import.meta.url)
const { createDb } = require('@hira-ng/infra-db')

/**
 * 直接给已存在 profile 行回填 lastActiveAt，便于确定性排序测试。
 * （createProfileService.create 只置 lastActiveAt=null，故手动控制）
 */
function touch(db, id, ts) {
  const { profiles } = require('@hira-ng/infra-db/schema')
  const { eq } = require('drizzle-orm')
  db.update(profiles).set({ lastActiveAt: ts }).where(eq(profiles.id, id)).run()
}

function makeService(options) {
  const { db, close } = createDb(':memory:')
  const service = createProfileService(db, options)
  return { service, db, close }
}

describe('domain-profile · create 纯规则兜底', () => {
  it('空名兜底为 New Profile', () => {
    const { service, close } = makeService()
    try {
      const created = service.create({ name: '  ' })
      expect(created.name).toBe('New Profile')
      expect(service.get(created.id).name).toBe('New Profile')
    } finally {
      close()
    }
  })

  it('正常名 trim 后保留', () => {
    const { service, close } = makeService()
    try {
      const created = service.create({ name: '  Work  ' })
      expect(created.name).toBe('Work')
      expect(service.get(created.id).name).toBe('Work')
    } finally {
      close()
    }
  })
})

describe('domain-profile · sorted 纯规则排序', () => {
  it('sorted() 复用 list 并按 lastActiveAt 降序', () => {
    const { service, db, close } = makeService()
    try {
      const a = service.create({ name: 'A' })
      const b = service.create({ name: 'B' })
      const c = service.create({ name: 'C' })
      // C 最早，A 最晚
      touch(db, c.id, 100)
      touch(db, b.id, 200)
      touch(db, a.id, 300)
      const sorted = service.sorted()
      expect(sorted.map((p) => p.id)).toEqual([a.id, b.id, c.id])
    } finally {
      close()
    }
  })

  it('sorted 对空列表返回空数组', () => {
    const { service, close } = makeService()
    try {
      expect(service.sorted()).toEqual([])
    } finally {
      close()
    }
  })
})

describe('domain-profile · pickActiveFrom / isDefaultId', () => {
  it('pickActiveFrom 返回 isActive 的第一项，不产生副作用', () => {
    const { service, close } = makeService()
    try {
      const inactive = { id: 'x', isActive: 0 }
      const active = { id: 'y', isActive: 1 }
      expect(service.pickActiveFrom([inactive, active])).toBe(active)
      expect(inactive).toEqual({ id: 'x', isActive: 0 })
      expect(service.pickActiveFrom([])).toBeNull()
      expect(service.pickActiveFrom(null)).toBeNull()
    } finally {
      close()
    }
  })

  it('isDefaultId 识别 default', () => {
    const { service, close } = makeService()
    try {
      expect(service.isDefaultId('default')).toBe(true)
      expect(service.isDefaultId('work')).toBe(false)
    } finally {
      close()
    }
  })
})

describe('domain-profile · merge / normalize', () => {
  it('merge(id, patch) 返回新对象且非原地改原行', () => {
    const { service, close } = makeService()
    try {
      const created = service.create({ name: 'Base', color: '#fff' })
      const merged = service.merge(created.id, { name: 'Renamed', icon: 'carbon:star', color: '#000' })
      expect(merged.name).toBe('Renamed')
      expect(merged.icon).toBe('carbon:star')
      expect(merged.color).toBe('#000')
      // 非原地：service.get 读到的原始行未被 patch 污染
      expect(service.get(created.id).name).toBe('Base')
      expect(service.merge('ghost', { name: 'Nope' }).name).toBe('Nope')
    } finally {
      close()
    }
  })

  it('merge 只并入合法字段，忽略未定义值', () => {
    const { service, close } = makeService()
    try {
      const created = service.create({ name: 'Base' })
      const merged = service.merge(created.id, { name: undefined, id: 'hijack', illegal: 1 })
      expect(merged.name).toBe('Base')
      expect(merged.id).toBe(created.id)
      expect(merged.illegal).toBeUndefined()
    } finally {
      close()
    }
  })

  it('normalize(id) 归一合法 id，非法 id 返回空', () => {
    const { service, close } = makeService()
    try {
      expect(service.normalize('  Alice_01 ')).toBe('alice_01')
      expect(service.normalize('not valid!')).toBe('')
    } finally {
      close()
    }
  })
})
