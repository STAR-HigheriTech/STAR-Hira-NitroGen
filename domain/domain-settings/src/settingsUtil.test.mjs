import { describe, it, expect } from 'vitest'
import {
  sectionOf,
  walkKey,
  coerceType,
  defaultsWith,
  missingDefaults,
  normalizeBounds,
  filterBySection,
  toCSSVarSuffix,
  isDefaultValue,
  presentSections,
  pickSection
} from './settingsUtil.ts'

describe('sectionOf', () => {
  it('返回点分键的首段', () => {
    expect(sectionOf('search.engine-x')).toBe('search')
    expect(sectionOf('app.theme')).toBe('app')
  })
  it('无点键返回空串', () => {
    expect(sectionOf('foo')).toBe('')
  })
  it('边界：空串/非字符串', () => {
    expect(sectionOf('')).toBe('')
    expect(sectionOf(null)).toBe('')
    expect(sectionOf(undefined)).toBe('')
  })
})

describe('walkKey', () => {
  it('拆段数组', () => {
    expect(walkKey('app.theme')).toEqual(['app', 'theme'])
    expect(walkKey('a.b.c')).toEqual(['a', 'b', 'c'])
  })
  it('无点键返回单元素数组', () => {
    expect(walkKey('foo')).toEqual(['foo'])
  })
  it('边界：空串/非字符串返回空数组', () => {
    expect(walkKey('')).toEqual([])
    expect(walkKey(undefined)).toEqual([])
  })
})

describe('coerceType', () => {
  it('number 转换：数字串、数字、小数', () => {
    expect(coerceType('8', 'number')).toBe(8)
    expect(coerceType('12.5', 'number')).toBe(12.5)
    expect(coerceType(7, 'number')).toBe(7)
  })
  it('number 强制失败回落原值', () => {
    expect(coerceType('abc', 'number')).toBe('abc')
  })
  it('boolean 转换：布尔与字符串', () => {
    expect(coerceType(true, 'boolean')).toBe(true)
    expect(coerceType('true', 'boolean')).toBe(true)
    expect(coerceType('FALSE', 'boolean')).toBe(false)
  })
  it('boolean 强制失败回落原值', () => {
    expect(coerceType('maybe', 'boolean')).toBe('maybe')
    expect(coerceType(2, 'boolean')).toBe(2)
  })
  it('string 转换：任意值转字符串', () => {
    expect(coerceType(123, 'string')).toBe('123')
    expect(coerceType('x', 'string')).toBe('x')
  })
  it('未知期望类型原样返回', () => {
    expect(coerceType(1, 'unknown')).toBe(1)
  })
})

describe('defaultsWith', () => {
  it('浅合并 user 覆盖 defaults，返回新对象', () => {
    const d = { a: 1, b: 2 }
    const u = { b: 3, c: 4 }
    const r = defaultsWith(u, d)
    expect(r).toEqual({ a: 1, b: 3, c: 4 })
    expect(r).not.toBe(d)
    expect(r).not.toBe(u)
  })
  it('不修改入参', () => {
    const d = { a: 1 }
    const u = { a: 2 }
    defaultsWith(u, d)
    expect(d).toEqual({ a: 1 })
    expect(u).toEqual({ a: 2 })
  })
  it('null/undefined 入参安全', () => {
    expect(defaultsWith(null, { a: 1 })).toEqual({ a: 1 })
    expect(defaultsWith({ a: 2 }, null)).toEqual({ a: 2 })
  })
})

describe('missingDefaults', () => {
  it('返回 user 缺省的 default 键', () => {
    const d = { a: 1, b: 2, c: 3 }
    const u = { b: 9 }
    expect(missingDefaults(u, d)).toEqual(['a', 'c'])
  })
  it('user 完全缺省时全量返回', () => {
    expect(missingDefaults({}, { a: 1, b: 2 })).toEqual(['a', 'b'])
  })
  it('无缺省返回空数组', () => {
    expect(missingDefaults({ a: 1, b: 2 }, { a: 1, b: 2 })).toEqual([])
  })
})

describe('normalizeBounds', () => {
  it('夹取到 [min,max]', () => {
    expect(normalizeBounds(5, 1, 10)).toBe(5)
    expect(normalizeBounds(0, 1, 10)).toBe(1)
    expect(normalizeBounds(99, 1, 10)).toBe(10)
  })
  it('边界值保留', () => {
    expect(normalizeBounds(1, 1, 10)).toBe(1)
    expect(normalizeBounds(10, 1, 10)).toBe(10)
  })
  it('越界取夹取，非法取 fallback', () => {
    expect(normalizeBounds(NaN, 1, 10)).toBe(1)
    expect(normalizeBounds('abc', 1, 10)).toBe(1)
    expect(normalizeBounds('abc', 1, 10, 7)).toBe(7)
  })
  it('不禁用反向区间（自动归一化）', () => {
    expect(normalizeBounds(5, 10, 1)).toBe(5)
    expect(normalizeBounds(0, 10, 1)).toBe(1)
  })
  it('随机字符串数字串可转换', () => {
    expect(normalizeBounds('3.5', 0, 10)).toBe(3.5)
    expect(normalizeBounds(0, 0, 100)).toBe(0)
  })
})

describe('filterBySection', () => {
  it('返回 section 前缀子集', () => {
    const m = { 'app.theme': 'light', 'app.n': 1, 'search.x': 2 }
    expect(filterBySection(m, 'app')).toEqual({ 'app.theme': 'light', 'app.n': 1 })
    expect(filterBySection(m, 'search')).toEqual({ 'search.x': 2 })
  })
  it('少前缀不误配', () => {
    const m = { 'searchx.a': 1, 'search.x': 2 }
    expect(filterBySection(m, 'search')).toEqual({ 'search.x': 2 })
  })
  it('空 section 返回空对象', () => {
    expect(filterBySection({ 'a.b': 1 }, '')).toEqual({})
  })
  it('返回新对象不改入参', () => {
    const m = { 'app.theme': 'light' }
    const r = filterBySection(m, 'app')
    expect(r).toEqual({ 'app.theme': 'light' })
    expect(r).not.toBe(m)
    expect(m).toEqual({ 'app.theme': 'light' })
  })
})

describe('toCSSVarSuffix', () => {
  it('末段并点转连字符', () => {
    expect(toCSSVarSuffix('app.theme')).toBe('theme')
    expect(toCSSVarSuffix('a.b.c')).toBe('c')
    expect(toCSSVarSuffix('performance.memory_saver')).toBe('memory_saver')
  })
  it('单段键 / 非字符串边界', () => {
    expect(toCSSVarSuffix('foo')).toBe('foo')
    expect(toCSSVarSuffix('')).toBe('')
    expect(toCSSVarSuffix(undefined)).toBe('')
  })
})

describe('isDefaultValue', () => {
  it('值等于默认值返回 true', () => {
    expect(isDefaultValue('app.theme', 'light', { 'app.theme': 'light' })).toBe(true)
  })
  it('值不等于默认值返回 false', () => {
    expect(isDefaultValue('app.theme', 'dark', { 'app.theme': 'light' })).toBe(false)
  })
  it('缺默认键时 undefined 视为不相等', () => {
    expect(isDefaultValue('nope', undefined, { nope: 'v' })).toBe(false)
  })
})

describe('presentSections', () => {
  it('去重且保持出现顺序', () => {
    const m = { 'app.theme': 1, 'search.x': 2, 'app.n': 3, 'tab.y': 4 }
    expect(presentSections(m)).toEqual(['app', 'search', 'tab'])
  })
  it('忽略无 section 的键', () => {
    expect(presentSections({ foo: 1, 'app.theme': 2 })).toEqual(['app'])
  })
  it('空 map 返回空数组', () => {
    expect(presentSections({})).toEqual([])
  })
})

describe('pickSection', () => {
  it('仅保留指定 section 副本', () => {
    const m = { 'app.theme': 'light', 'search.x': 'y' }
    expect(pickSection(m, 'app')).toEqual({ 'app.theme': 'light' })
  })
  it('缺省 section 返回原 map 浅拷贝', () => {
    const m = { 'app.theme': 'light' }
    const r = pickSection(m)
    expect(r).toEqual({ 'app.theme': 'light' })
    expect(r).not.toBe(m)
  })
  it('空 section 返回拷贝', () => {
    const m = { 'app.theme': 'light' }
    expect(pickSection(m, '')).toEqual(m)
    expect(pickSection(m, '')).not.toBe(m)
  })
})
