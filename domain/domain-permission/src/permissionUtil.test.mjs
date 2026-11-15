import { describe, it, expect } from 'vitest'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const {
  isValidPermissionType,
  isValidSetting,
  sanitizeSetting,
  normalizeOrigin,
  matchesOrigin,
  classifySiteRules,
  summarizeSiteRules,
  isSensitivePermission,
  requestKey,
  resolveSetting,
  batchNormalize,
  priorityOf
} = require('../dist/index.cjs')

describe('normalizeOrigin', () => {
  it('提取裸域', () => {
    expect(normalizeOrigin('example.com')).toBe('example.com')
  })
  it('带协议与端口与路径', () => {
    expect(normalizeOrigin('https://www.Example.COM:443/a/b')).toBe('example.com')
  })
  it('去 www. 前缀', () => {
    expect(normalizeOrigin('www.google.com')).toBe('google.com')
  })
  it('统一转小写', () => {
    expect(normalizeOrigin('API.GitHub.COM')).toBe('api.github.com')
  })
  it('空串 / 无效 / 非字符串返回空', () => {
    expect(normalizeOrigin('')).toBe('')
    expect(normalizeOrigin('   ')).toBe('')
    expect(normalizeOrigin('not a domain!')).toBe('')
    expect(normalizeOrigin(null)).toBe('')
    expect(normalizeOrigin(undefined)).toBe('')
  })
  it('无点域名视为无效', () => {
    expect(normalizeOrigin('localhost')).toBe('')
  })
  it('连续点视为无效', () => {
    expect(normalizeOrigin('a..b.com')).toBe('')
  })
})

describe('isValidPermissionType', () => {
  it('缺省已知集内的类型合法', () => {
    expect(isValidPermissionType('notification')).toBe(true)
    expect(isValidPermissionType('camera')).toBe(true)
    expect(isValidPermissionType('pointerLock')).toBe(true)
  })
  it('未知类型非法', () => {
    expect(isValidPermissionType('cookies')).toBe(false)
  })
  it('自定义 knownTypes 覆盖缺省集', () => {
    expect(isValidPermissionType('cookies', ['cookies', 'nfc'])).toBe(true)
    expect(isValidPermissionType('notification', ['nfc'])).toBe(false)
  })
  it('空串 / 非字符串非法', () => {
    expect(isValidPermissionType('')).toBe(false)
    expect(isValidPermissionType(null)).toBe(false)
  })
})

describe('isValidSetting', () => {
  it('仅 allow/block/ask 合法', () => {
    expect(isValidSetting('allow')).toBe(true)
    expect(isValidSetting('block')).toBe(true)
    expect(isValidSetting('ask')).toBe(true)
  })
  it('其他值非法', () => {
    expect(isValidSetting('grant')).toBe(false)
    expect(isValidSetting('')).toBe(false)
    expect(isValidSetting(null)).toBe(false)
    expect(isValidSetting(undefined)).toBe(false)
    expect(isValidSetting(1)).toBe(false)
  })
})

describe('sanitizeSetting', () => {
  it('合法值原样返回', () => {
    expect(sanitizeSetting('allow')).toBe('allow')
    expect(sanitizeSetting('block')).toBe('block')
    expect(sanitizeSetting('ask')).toBe('ask')
  })
  it('非法值回落 ask', () => {
    expect(sanitizeSetting('grant')).toBe('ask')
    expect(sanitizeSetting('')).toBe('ask')
    expect(sanitizeSetting(null)).toBe('ask')
    expect(sanitizeSetting(undefined)).toBe('ask')
  })
})

describe('matchesOrigin', () => {
  it('精确匹配命中', () => {
    expect(matchesOrigin('example.com', 'example.com')).toBe(true)
    expect(matchesOrigin('https://EXAMPLE.com:443/x', 'example.com')).toBe(true)
  })
  it('子域命中', () => {
    expect(matchesOrigin('login.example.com', 'example.com')).toBe(true)
    expect(matchesOrigin('a.b.example.com', 'example.com')).toBe(true)
  })
  it('无关域名不命中', () => {
    expect(matchesOrigin('otherexample.com', 'example.com')).toBe(false)
    expect(matchesOrigin('example.org', 'example.com')).toBe(false)
  })
  it('反向（父域打子域规则）不命中', () => {
    expect(matchesOrigin('example.com', 'sub.example.com')).toBe(false)
  })
  it('空 / 非法输入', () => {
    expect(matchesOrigin('', 'example.com')).toBe(false)
    expect(matchesOrigin('example.com', '')).toBe(false)
    expect(matchesOrigin('example.com', null)).toBe(false)
  })
})

describe('classifySiteRules', () => {
  it('按 setting 分类', () => {
    const r = classifySiteRules({
      notification: 'allow',
      camera: 'block',
      midi: 'ask',
      media: 'allow'
    })
    expect(r.allow.sort()).toEqual(['media', 'notification'])
    expect(r.block).toEqual(['camera'])
    expect(r.ask).toEqual(['midi'])
  })
  it('非法 setting 归一为 ask', () => {
    const r = classifySiteRules({ geolocation: 'grant', popup: 'yes' })
    expect(r.ask.sort()).toEqual(['geolocation', 'popup'])
  })
  it('未知类型被跳过', () => {
    const r = classifySiteRules({ cookies: 'allow', midi: 'block' })
    expect(r.allow).toEqual([])
    expect(r.block).toEqual(['midi'])
  })
  it('空 / 非对象返回空结构', () => {
    expect(classifySiteRules(null)).toEqual({ allow: [], block: [], ask: [] })
    expect(classifySiteRules({})).toEqual({ allow: [], block: [], ask: [] })
  })
  it('自定义 knownTypes 参与分类', () => {
    const r = classifySiteRules({ cookies: 'allow', midi: 'block' }, ['cookies'])
    expect(r.allow).toEqual(['cookies'])
    expect(r.block).toEqual([])
  })
})

describe('summarizeSiteRules', () => {
  it('汇总各类别数量', () => {
    expect(summarizeSiteRules({
      notification: 'allow',
      camera: 'block',
      midi: 'ask',
      media: 'allow'
    })).toEqual({ allow: 2, block: 1, ask: 1 })
  })
  it('空输入归零', () => {
    expect(summarizeSiteRules({})).toEqual({ allow: 0, block: 0, ask: 0 })
    expect(summarizeSiteRules(null)).toEqual({ allow: 0, block: 0, ask: 0 })
  })
  it('未知类型不计入', () => {
    expect(summarizeSiteRules({ cookies: 'allow' })).toEqual({ allow: 0, block: 0, ask: 0 })
  })
})

describe('isSensitivePermission', () => {
  it('敏感类型为真', () => {
    expect(isSensitivePermission('camera')).toBe(true)
    expect(isSensitivePermission('microphone')).toBe(true)
    expect(isSensitivePermission('geolocation')).toBe(true)
    expect(isSensitivePermission('pointerLock')).toBe(true)
  })
  it('普通类型为假', () => {
    expect(isSensitivePermission('notification')).toBe(false)
    expect(isSensitivePermission('midi')).toBe(false)
  })
  it('非字符串为假', () => {
    expect(isSensitivePermission(null)).toBe(false)
    expect(isSensitivePermission('')).toBe(false)
  })
})

describe('requestKey', () => {
  it('组合归一后的 origin 与 type', () => {
    expect(requestKey('https://Example.COM/a', 'camera')).toBe('example.com::camera')
  })
  it('origin 非法时前缀为空', () => {
    expect(requestKey('', 'camera')).toBe('::camera')
    expect(requestKey(null, 'camera')).toBe('::camera')
  })
})

describe('resolveSetting', () => {
  it('precedent 合法取值', () => {
    expect(resolveSetting('block', 'ask')).toBe('block')
    expect(resolveSetting('allow', 'block')).toBe('allow')
  })
  it('precedent 非法取 fallback', () => {
    expect(resolveSetting('grant', 'block')).toBe('block')
    expect(resolveSetting(null, 'ask')).toBe('ask')
  })
  it('两者皆非法回落 ask', () => {
    expect(resolveSetting('grant', 'whatever')).toBe('ask')
    expect(resolveSetting(undefined, null)).toBe('ask')
  })
})

describe('batchNormalize', () => {
  it('合法条目归一后进入 valid', () => {
    const { valid, dropped } = batchNormalize([
      { origin: 'https://Example.COM', type: 'camera', setting: 'allow' },
      { origin: 'www.a.com', type: 'midi', setting: 'block' }
    ])
    expect(valid).toEqual([
      { origin: 'example.com', type: 'camera', setting: 'allow' },
      { origin: 'a.com', type: 'midi', setting: 'block' }
    ])
    expect(dropped).toEqual([])
  })
  it('非法 setting 归一为 ask（仍入 valid）', () => {
    const { valid, dropped } = batchNormalize([
      { origin: 'a.com', type: 'midi', setting: 'grant' }
    ])
    expect(valid).toEqual([{ origin: 'a.com', type: 'midi', setting: 'ask' }])
    expect(dropped).toEqual([])
  })
  it('非法 origin 丢弃', () => {
    const { valid, dropped } = batchNormalize([
      { origin: '', type: 'midi', setting: 'allow' },
      { origin: 'localhost', type: 'midi', setting: 'allow' },
      { origin: 'a.com', type: 'midi', setting: 'allow' }
    ])
    expect(valid).toEqual([{ origin: 'a.com', type: 'midi', setting: 'allow' }])
    expect(dropped.map((d) => d.reason)).toEqual(['invalid-origin', 'invalid-origin'])
  })
  it('非法 type 丢弃', () => {
    const { valid, dropped } = batchNormalize([
      { origin: 'a.com', type: 'cookies', setting: 'allow' },
      { origin: 'a.com', type: 'midi', setting: 'allow' }
    ])
    expect(valid).toEqual([{ origin: 'a.com', type: 'midi', setting: 'allow' }])
    expect(dropped.map((d) => d.reason)).toEqual(['invalid-type'])
  })
  it('非对象条目丢弃', () => {
    const { valid, dropped } = batchNormalize([null, 'x', 1])
    expect(valid).toEqual([])
    expect(dropped.map((d) => d.reason)).toEqual(['invalid-entry', 'invalid-entry', 'invalid-entry'])
  })
  it('非数组输入返回空结构', () => {
    expect(batchNormalize(null)).toEqual({ valid: [], dropped: [] })
    expect(batchNormalize(undefined)).toEqual({ valid: [], dropped: [] })
  })
  it('自定义 knownTypes 生效', () => {
    const { valid, dropped } = batchNormalize(
      [{ origin: 'a.com', type: 'cookies', setting: 'allow' }],
      ['cookies']
    )
    expect(valid).toEqual([{ origin: 'a.com', type: 'cookies', setting: 'allow' }])
    expect(dropped).toEqual([])
  })
})

describe('priorityOf', () => {
  it('预置类型返回对应优先级', () => {
    expect(priorityOf('camera')).toBe(100)
    expect(priorityOf('midi')).toBe(10)
    expect(priorityOf('notification')).toBe(60)
  })
  it('未知类型返回 0', () => {
    expect(priorityOf('cookies')).toBe(0)
    expect(priorityOf('')).toBe(0)
    expect(priorityOf(null)).toBe(0)
  })
})
