import { describe, it, expect } from 'vitest'
import ProfileUtil from './profileUtil.ts'

const {
  normalizeProfileId,
  validateProfileName,
  safeName,
  slugFromName,
  defaultProfileId,
  isDefault,
  sortByRecent,
  pickActive,
  mergeProfileMeta,
  partitionKey,
  dedupeById
} = ProfileUtil

describe('normalizeProfileId', () => {
  it('归一：去首尾空格并转小写', () => {
    expect(normalizeProfileId('  Work-Profile  ')).toBe('work-profile')
    expect(normalizeProfileId('Data_One')).toBe('data_one')
  })
  it('支持字母数字、-、_', () => {
    expect(normalizeProfileId('Abc_123-Xy')).toBe('abc_123-xy')
  })
  it('空/非字符串/非法字符返回空串', () => {
    expect(normalizeProfileId('')).toBe('')
    expect(normalizeProfileId('   ')).toBe('')
    expect(normalizeProfileId(null)).toBe('')
    expect(normalizeProfileId(123)).toBe('')
    expect(normalizeProfileId('a b')).toBe('')
    expect(normalizeProfileId('入侵')).toBe('')
  })
  it('越界长度（>64）返回空串', () => {
    expect(normalizeProfileId('a'.repeat(65))).toBe('')
    expect(normalizeProfileId('a'.repeat(64))).toBe('a'.repeat(64))
  })
})

describe('validateProfileName', () => {
  it('合法名称通过', () => {
    expect(validateProfileName('Work')).toEqual({ ok: true })
  })
  it('空/只有空格/非字符串失败', () => {
    expect(validateProfileName('')).toEqual({ ok: false, reason: expect.any(String) })
    expect(validateProfileName('   ')).toEqual({ ok: false, reason: expect.any(String) })
    expect(validateProfileName(null)).toEqual({ ok: false, reason: expect.any(String) })
  })
  it('长度越界失败', () => {
    expect(validateProfileName('a'.repeat(41))).toEqual({ ok: false, reason: expect.any(String) })
    expect(validateProfileName('a'.repeat(40))).toEqual({ ok: true })
  })
})

describe('safeName', () => {
  it('正常名称返回 trim 结果', () => {
    expect(safeName('  Work  ')).toBe('Work')
  })
  it('空/空白/非字符串用 fallback', () => {
    expect(safeName('  ')).toBe('New Profile')
    expect(safeName('')).toBe('New Profile')
    expect(safeName(null)).toBe('New Profile')
    expect(safeName(undefined, '备用')).toBe('备用')
    expect(safeName('  ', 'fallback')).toBe('fallback')
  })
})

describe('slugFromName', () => {
  it('小写、非字母数字转 -、去重连续 -', () => {
    expect(slugFromName('Work Profile')).toBe('work-profile')
    expect(slugFromName('Hello--World!! Test')).toBe('hello-world-test')
  })
  it('中文等转 - 并去首尾 -', () => {
    expect(slugFromName('  入侵 测试 ')).toBe('')
    expect(slugFromName('--a--b--')).toBe('a-b')
  })
  it('空输入返回空串', () => {
    expect(slugFromName('')).toBe('')
    expect(slugFromName(null)).toBe('')
  })
})

describe('defaultProfileId / isDefault', () => {
  it('默认 id 为 default', () => {
    expect(defaultProfileId()).toBe('default')
  })
  it('isDefault 判断', () => {
    expect(isDefault('default')).toBe(true)
    expect(isDefault('other')).toBe(false)
    expect(isDefault('DEFAULT')).toBe(false)
  })
})

describe('sortByRecent', () => {
  it('按 lastActiveAt 降序，缺失按 0', () => {
    const list = [
      { id: 'a', lastActiveAt: 100 },
      { id: 'b' },
      { id: 'c', lastActiveAt: 300 },
      { id: 'd', lastActiveAt: 200 }
    ]
    expect(sortByRecent(list).map((x) => x.id)).toEqual(['c', 'd', 'a', 'b'])
  })
  it('稳定排序：相同时保持原顺序', () => {
    const list = [
      { id: 'a', lastActiveAt: 1 },
      { id: 'b', lastActiveAt: 1 },
      { id: 'c', lastActiveAt: 1 }
    ]
    expect(sortByRecent(list).map((x) => x.id)).toEqual(['a', 'b', 'c'])
  })
  it('非数组返回 []', () => {
    expect(sortByRecent(null)).toEqual([])
  })
})

describe('pickActive', () => {
  it('返回第一个 isActive 为真的项', () => {
    const list = [{ id: 'a', isActive: 0 }, { id: 'b', isActive: 1 }, { id: 'c', isActive: 1 }]
    expect(pickActive(list).id).toBe('b')
  })
  it('无激活返回 null', () => {
    expect(pickActive([])).toBeNull()
    expect(pickActive([{ id: 'a', isActive: 0 }])).toBeNull()
    expect(pickActive(null)).toBeNull()
  })
})

describe('mergeProfileMeta', () => {
  it('仅并入合法字段 name/icon/color', () => {
    const base = { id: 'x', lastActiveAt: 1 }
    const patch = { name: 'N', icon: 'i', color: '#fff', evil: 'no' }
    const result = mergeProfileMeta(base, patch)
    expect(result).toEqual({ id: 'x', lastActiveAt: 1, name: 'N', icon: 'i', color: '#fff' })
    expect(result.evil).toBeUndefined()
  })
  it('不原地改 base', () => {
    const base = { name: 'old' }
    const result = mergeProfileMeta(base, { name: 'new' })
    expect(base).toEqual({ name: 'old' })
    expect(result).toEqual({ name: 'new' })
  })
  it('非法 patch 返回 base 副本', () => {
    const base = { name: 'x' }
    expect(mergeProfileMeta(base, null)).toEqual({ name: 'x' })
    expect(mergeProfileMeta(base, 'str')).toEqual({ name: 'x' })
  })
  it('undefined 字段被忽略', () => {
    expect(mergeProfileMeta({ a: 1 }, { a: undefined, name: 'n' })).toEqual({ a: 1, name: 'n' })
  })
})

describe('partitionKey', () => {
  it('合法 id 生成 scope 分区', () => {
    expect(partitionKey('Work', 'cache')).toBe('cache:work')
  })
  it('非法 id 返回空串', () => {
    expect(partitionKey('', 'cache')).toBe('')
    expect(partitionKey('x y', 'cache')).toBe('')
  })
})

describe('dedupeById', () => {
  it('按 id 去重并保留先出现', () => {
    const list = [
      { id: 'a', v: 1 },
      { id: 'b', v: 2 },
      { id: 'a', v: 3 },
      { id: 'c', v: 4 }
    ]
    expect(dedupeById(list).map((x) => x.id)).toEqual(['a', 'b', 'c'])
    expect(dedupeById(list)[0]).toEqual({ id: 'a', v: 1 })
  })
  it('非数组返回 []，null 元素被保留', () => {
    expect(dedupeById(null)).toEqual([])
    expect(dedupeById([null, null])).toEqual([null, null])
  })
})
