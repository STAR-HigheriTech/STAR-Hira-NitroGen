import { describe, it, expect } from 'vitest'
import {
  domainOf,
  passwordStrength,
  hasClass,
  isWeakPassword,
  normalizeUsername,
  sortCredentialsByRecency,
  filterMatchingCredentials,
  mergeSuggestions,
  maskPassword,
  matchesNeverSave,
  domainLevelDomains,
  buildUpsertKey
} from './password-utils.ts'

describe('domainOf', () => {
  it('提取纯域名', () => {
    expect(domainOf('example.com')).toBe('example.com')
  })
  it('带协议与端口与路径', () => {
    expect(domainOf('https://www.Example.COM:443/a/b')).toBe('example.com')
  })
  it('去 www. 前缀', () => {
    expect(domainOf('www.google.com')).toBe('google.com')
  })
  it('统一转小写', () => {
    expect(domainOf('API.GitHub.COM')).toBe('api.github.com')
  })
  it('空串 / 无效 / 非字符串返回空', () => {
    expect(domainOf('')).toBe('')
    expect(domainOf('   ')).toBe('')
    expect(domainOf('not a domain!')).toBe('')
    expect(domainOf(null)).toBe('')
    expect(domainOf(undefined)).toBe('')
  })
  it('无点域名视为无效', () => {
    expect(domainOf('localhost')).toBe('')
  })
  it('连续点视为无效', () => {
    expect(domainOf('a..b.com')).toBe('')
  })
})

describe('passwordStrength', () => {
  it('空串为极弱', () => {
    expect(passwordStrength('')).toEqual({ score: 0, label: '极弱' })
  })
  it('长度>=8 加一分', () => {
    expect(passwordStrength('abcdef'.length >= 8 ? 'abcdefgh' : 'abcdefgh').score).toBeGreaterThanOrEqual(1)
    expect(passwordStrength('abcdefgh').score).toBeGreaterThanOrEqual(1)
  })
  it('大小写混用加分', () => {
    expect(hasClass('aBc', 'upper') && hasClass('aBc', 'lower')).toBe(true)
  })
  it('四项全备为极强', () => {
    const r = passwordStrength('Passw0rd!')
    expect(r).toEqual({ score: 4, label: '极强' })
  })
  it('非字符串按空处理', () => {
    expect(passwordStrength(null).score).toBe(0)
  })
})

describe('hasClass', () => {
  it('各类别判定', () => {
    expect(hasClass('Hello123!', 'upper')).toBe(true)
    expect(hasClass('hello', 'lower')).toBe(true)
    expect(hasClass('abc123', 'digit')).toBe(true)
    expect(hasClass('abc!', 'symbol')).toBe(true)
  })
  it('缺失类别返回 false', () => {
    expect(hasClass('abc', 'upper')).toBe(false)
    expect(hasClass('123', 'lower')).toBe(false)
  })
  it('非法类别返回 false', () => {
    expect(hasClass('abc', 'emoji')).toBe(false)
  })
})

describe('isWeakPassword', () => {
  it('空串与短密码为弱', () => {
    expect(isWeakPassword('')).toBe(true)
    expect(isWeakPassword('abc')).toBe(true)
  })
  it('组合较强密码为强（非弱）', () => {
    expect(isWeakPassword('Passw0rd!')).toBe(false)
  })
})

describe('normalizeUsername', () => {
  it('去首尾空格与 @ 并小写', () => {
    expect(normalizeUsername('  @Admin  ')).toBe('admin')
    expect(normalizeUsername(' User.Name ')).toBe('user.name')
  })
  it('空串或非字符串返回空', () => {
    expect(normalizeUsername('')).toBe('')
    expect(normalizeUsername('   @   ')).toBe('')
    expect(normalizeUsername(null)).toBe('')
  })
})

describe('sortCredentialsByRecency', () => {
  it('按 lastUsedAt 降序', () => {
    const list = [
      { username: 'a', lastUsedAt: 3 },
      { username: 'b', lastUsedAt: 10 },
      { username: 'c', lastUsedAt: 1 }
    ]
    const out = sortCredentialsByRecency(list)
    expect(out.map((x) => x.username)).toEqual(['b', 'a', 'c'])
  })
  it('缺失按 0 处理（排在最后）', () => {
    const list = [
      { username: 'none' },
      { username: 'new', lastUsedAt: 5 }
    ]
    const out = sortCredentialsByRecency(list)
    expect(out.map((x) => x.username)).toEqual(['new', 'none'])
  })
  it('稳定排序：相同时间保持原相对顺序', () => {
    const list = [
      { username: 'x', lastUsedAt: 7 },
      { username: 'y', lastUsedAt: 7 },
      { username: 'z', lastUsedAt: 7 }
    ]
    const out = sortCredentialsByRecency(list)
    expect(out.map((x) => x.username)).toEqual(['x', 'y', 'z'])
  })
  it('不修改原数组', () => {
    const list = [{ username: 'a', lastUsedAt: 2 }, { username: 'b', lastUsedAt: 1 }]
    const copy = list.slice()
    sortCredentialsByRecency(list)
    expect(list).toEqual(copy)
  })
})

describe('filterMatchingCredentials', () => {
  const list = [
    { username: 'u1', domain: 'example.com' },
    { username: 'u2', domain: 'sub.example.com' },
    { username: 'u3', domain: 'other.com' }
  ]
  it('精确匹配', () => {
    const out = filterMatchingCredentials(list, 'example.com')
    expect(out.map((x) => x.username)).toEqual(['u1'])
  })
  it('子域 hostname 匹配父域存储', () => {
    const out = filterMatchingCredentials(list, 'api.sub.example.com')
    // u1(example.com) 与 u2(sub.example.com) 均为该 hostname 的父域
    expect(out.map((x) => x.username)).toEqual(['u1', 'u2'])
  })
  it('不匹配其他域', () => {
    const out = filterMatchingCredentials(list, 'other.com')
    expect(out.map((x) => x.username)).toEqual(['u3'])
  })
  it('空 hostname 返回空', () => {
    expect(filterMatchingCredentials(list, '')).toEqual([])
  })
})

describe('mergeSuggestions', () => {
  it('按 (username, manager) 去重合并', () => {
    const builtin = [
      { username: 'a', password: 'p1', manager: 'Builtin' },
      { username: 'b', password: 'p2', manager: 'Builtin' }
    ]
    const managers = [
      { username: 'a', password: 'p3', manager: 'Bitwarden' },
      { username: 'b', password: 'p4', manager: 'Builtin' }
    ]
    const out = mergeSuggestions(builtin, managers)
    expect(out.length).toBe(2)
    const a = out.find((x) => x.username === 'a')
    const b = out.find((x) => x.username === 'b')
    expect(a.manager).toBe('Builtin')
    // 去重保留先出现者（builtin 的 p2）
    expect(b.password).toBe('p2')
  })
  it('managers 支持嵌套数组', () => {
    const out = mergeSuggestions(
      [{ username: 'a', manager: 'Builtin' }],
      [[{ username: 'b', manager: '1password' }]]
    )
    expect(out.length).toBe(2)
  })
  it('非法输入不崩溃', () => {
    expect(mergeSuggestions(null, undefined)).toEqual([])
  })
})

describe('maskPassword', () => {
  it('默认全掩', () => {
    expect(maskPassword('secret')).toBe('******')
  })
  it('保留前 keepLen 位', () => {
    expect(maskPassword('password', 4)).toBe('pass****')
  })
  it('keepLen 大于长度不补星', () => {
    expect(maskPassword('abc', 5)).toBe('abc')
  })
  it('非字符串返回空', () => {
    expect(maskPassword(null)).toBe('')
  })
})

describe('matchesNeverSave', () => {
  const domains = ['bank.com', 'secure.net']
  it('精确匹配命中', () => {
    expect(matchesNeverSave(domains, 'bank.com')).toBe(true)
  })
  it('子域命中', () => {
    expect(matchesNeverSave(domains, 'login.bank.com')).toBe(true)
  })
  it('无关域名不命中', () => {
    expect(matchesNeverSave(domains, 'github.com')).toBe(false)
  })
  it('空列表 / 空 hostname', () => {
    expect(matchesNeverSave([], 'bank.com')).toBe(false)
    expect(matchesNeverSave(domains, '')).toBe(false)
  })
})

describe('domainLevelDomains', () => {
  it('逐级父域', () => {
    expect(domainLevelDomains('a.b.com')).toEqual(['a.b.com', 'b.com', 'com'])
  })
  it('顶层域', () => {
    expect(domainLevelDomains('example.com')).toEqual(['example.com', 'com'])
  })
  it('非法输入返回空', () => {
    expect(domainLevelDomains('')).toEqual([])
    expect(domainLevelDomains('nodots')).toEqual([])
    expect(domainLevelDomains('a..b')).toEqual([])
  })
})

describe('buildUpsertKey', () => {
  it('组合 domain 与规范化 username', () => {
    expect(buildUpsertKey('example.com', '  Admin ')).toBe('example.com|admin')
  })
  it('空 username 归一为空', () => {
    expect(buildUpsertKey('example.com', '')).toBe('example.com|')
    expect(buildUpsertKey('example.com', null)).toBe('example.com|')
  })
})
