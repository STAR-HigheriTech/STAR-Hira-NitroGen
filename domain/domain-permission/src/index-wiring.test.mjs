/**
 * domain-permission 接线测试 —— 纯规则集（permissionUtil）接入 service 层的验证。
 *
 * 覆盖 createPermissionService 中对 P 纯函数的新增接线：
 *   - classifySite / summarizeSite：DB 行 → 纯规则分类/汇总
 *   - pendingWithFlags：在飞行请求 → 附带 sensitive 标记
 *   - setPermission 使用 sanitizeSetting + isValidPermissionType 守卫
 */
import { describe, it, expect } from 'vitest'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const { createPermissionService } = require('../dist/index.cjs')
const { createDb } = require('@hira-ng/infra-db')

function makeService(options) {
  const { db, close } = createDb(':memory:')
  const service = createPermissionService(db, options)
  return { service, close }
}

describe('domain-permission · classifySite / summarizeSite 接线', () => {
  it('按站点聚合 classify 三大类，非法类型被丢弃，非法 setting 归一', () => {
    const { service, close } = makeService()
    try {
      service.setPermission('https://evil.example.com/', 'camera', 'allow')
      service.setPermission('https://evil.example.com/', 'microphone', 'allow')
      service.setPermission('https://evil.example.com/', 'notification', 'block')
      service.setPermission('https://evil.example.com/', 'geolocation', 'ask')
      service.setPermission('https://evil.example.com/', 'media', 'nonsense') // → ask

      expect(service.classifySite('https://evil.example.com/')).toEqual({
        allow: ['camera', 'microphone'],
        block: ['notification'],
        ask: ['geolocation', 'media']
      })
    } finally {
      close()
    }
  })

  it('summarizeSite 计数正确，空站点全 0', () => {
    const { service, close } = makeService()
    try {
      service.setPermission('https://a.example.com/', 'camera', 'allow')
      service.setPermission('https://a.example.com/', 'microphone', 'block')
      service.setPermission('https://a.example.com/', 'geolocation', 'block')
      service.setPermission('https://a.example.com/', 'media', 'ask')

      expect(service.summarizeSite('https://a.example.com/')).toEqual({
        allow: 1,
        block: 2,
        ask: 1
      })
      expect(service.summarizeSite('https://b.example.com/')).toEqual({
        allow: 0,
        block: 0,
        ask: 0
      })
    } finally {
      close()
    }
  })

  it('summarizeSite 支持指定 profile', () => {
    const { service, close } = makeService()
    try {
      service.setPermission('https://a.example.com/', 'camera', 'allow', 'p1')
      service.setPermission('https://a.example.com/', 'camera', 'block', 'p2')

      expect(service.summarizeSite('https://a.example.com/', 'p1')).toEqual({
        allow: 1, block: 0, ask: 0
      })
      expect(service.summarizeSite('https://a.example.com/', 'p2')).toEqual({
        allow: 0, block: 1, ask: 0
      })
    } finally {
      close()
    }
  })
})

describe('domain-permission · pendingWithFlags 接线', () => {
  it('对敏感类型标记 true，非敏感标记 false', () => {
    const { service, close } = makeService()
    try {
      const idCamera = service.createRequest('https://a.example.com/', 'camera', () => {})
      const idGeo = service.createRequest('https://a.example.com/', 'geolocation', () => {})
      const idNotif = service.createRequest('https://b.example.com/', 'notification', () => {})

      const flagged = service.pendingWithFlags()
      expect(flagged).toEqual([
        { id: idCamera, origin: 'https://a.example.com/', type: 'camera', sensitive: true },
        { id: idGeo, origin: 'https://a.example.com/', type: 'geolocation', sensitive: true },
        { id: idNotif, origin: 'https://b.example.com/', type: 'notification', sensitive: false }
      ])
    } finally {
      close()
    }
  })

  it('无在飞行请求时返回空数组', () => {
    const { service, close } = makeService()
    try {
      expect(service.pendingWithFlags()).toEqual([])
    } finally {
      close()
    }
  })
})

describe('domain-permission · setPermission 纯规则守卫', () => {
  it('非法 setting 回落为 ask', () => {
    const { service, close } = makeService()
    try {
      expect(service.setPermission('https://evil.example.com/', 'camera', 'nonsense')).toBe(true)
      expect(service.getPermission('https://evil.example.com/', 'camera')).toBe('ask')
    } finally {
      close()
    }
  })

  it('非法 permission type 直接返回 false 且不落库', () => {
    const { service, close } = makeService()
    try {
      expect(service.setPermission('https://evil.example.com/', 'camera', 'allow')).toBe(true)
      expect(service.setPermission('https://evil.example.com/', 'definitely-not-a-type', 'allow')).toBe(false)
      expect(service.listAll().length).toBe(1)
    } finally {
      close()
    }
  })
})
