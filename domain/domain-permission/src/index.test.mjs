/**
 * domain-permission 单测 —— 真实 SQLite（:memory:）+ Drizzle，零 Electron。
 *
 * 权限域有两条互不相同的事实源，必须分开断言：
 *   1. 持久化настройки（permissions 表）：origin 归一化为 domain 后 upsert，默认 'ask'
 *   2. 在飞行请求（_pending Map）：createRequest → respondToRequest / rejectAllPending，
 *      回调必须恰好触发一次，且回调抛错不得拖垮域（否则一个坏页面能冻结权限系统）
 */
import { describe, it, expect, vi } from 'vitest'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const { createPermissionService } = require('../dist/index.cjs')
const { createDb } = require('@hira-ng/infra-db')

function makeService(options) {
  const { db, close } = createDb(':memory:')
  const service = createPermissionService(db, options)
  return { service, close }
}

describe('domain-permission · 持久化设置', () => {
  it('未设置过的权限一律回落到 ask', () => {
    const { service, close } = makeService()
    try {
      expect(service.getPermission('https://a.example.com/', 'camera')).toBe('ask')
      expect(service.isGranted('https://a.example.com/', 'camera')).toBe(false)
      expect(service.isBlocked('https://a.example.com/', 'camera')).toBe(false)
    } finally {
      close()
    }
  })

  it('setPermission 对同一 domain+type 是 upsert 而非追加', () => {
    const { service, close } = makeService()
    try {
      service.setPermission('https://a.example.com/page', 'camera', 'allow')
      service.setPermission('https://a.example.com/other', 'camera', 'block')

      expect(service.listAll().length).toBe(1)
      expect(service.getPermission('https://a.example.com/', 'camera')).toBe('block')
    } finally {
      close()
    }
  })

  it('同一 origin 的不同路径归一化到同一 domain', () => {
    const { service, close } = makeService()
    try {
      service.setPermission('https://a.example.com/deep/path?q=1', 'geolocation', 'allow')
      expect(service.isGranted('https://a.example.com/', 'geolocation')).toBe(true)
    } finally {
      close()
    }
  })

  it('非法 setting 回落为 ask，空 origin/type 返回 false', () => {
    const { service, close } = makeService()
    try {
      service.setPermission('https://a.example.com/', 'camera', 'whatever')
      expect(service.getPermission('https://a.example.com/', 'camera')).toBe('ask')

      expect(service.setPermission('', 'camera', 'allow')).toBe(false)
      expect(service.setPermission('https://a.example.com/', '', 'allow')).toBe(false)
    } finally {
      close()
    }
  })

  it('resolveRequest 返回四态并拒绝未知权限类型', () => {
    const { service, close } = makeService()
    try {
      expect(service.resolveRequest('https://a.example.com/', 'camera')).toBe('ask')
      service.setPermission('https://a.example.com/', 'camera', 'allow')
      expect(service.resolveRequest('https://a.example.com/', 'camera')).toBe('allow')
      service.setPermission('https://a.example.com/', 'camera', 'block')
      expect(service.resolveRequest('https://a.example.com/', 'camera')).toBe('block')
      expect(service.resolveRequest('https://a.example.com/', 'unknown')).toBe('unsupported')
      expect(service.resolveRequest('', 'camera')).toBe('unsupported')
    } finally {
      close()
    }
  })

  it('setSitePermissions 批量写入合法规则并忽略未知类型，resetSite 批量清理', () => {
    const { service, close } = makeService()
    try {
      expect(service.setSitePermissions('https://a.example.com/', {
        camera: 'allow', microphone: 'block', unknown: 'allow'
      })).toBe(true)
      expect(service.getSitePermissions('https://a.example.com/')).toEqual({ camera: 'allow', microphone: 'block' })
      expect(service.resetSite('https://a.example.com/')).toBe(2)
      expect(service.getSitePermissions('https://a.example.com/')).toEqual({})
    } finally {
      close()
    }
  })

  it('removePermission 恢复默认，未知记录返回 false', () => {
    const { service, close } = makeService()
    try {
      service.setPermission('https://a.example.com/', 'camera', 'allow')

      expect(service.removePermission('https://a.example.com/', 'camera')).toBe(true)
      expect(service.getPermission('https://a.example.com/', 'camera')).toBe('ask')
      expect(service.removePermission('https://a.example.com/', 'camera')).toBe(false)
    } finally {
      close()
    }
  })
})

describe('domain-permission · 站点视图与批量清理', () => {
  it('getSitePermissions 聚合为 type → setting 映射', () => {
    const { service, close } = makeService()
    try {
      service.setPermission('https://a.example.com/', 'camera', 'allow')
      service.setPermission('https://a.example.com/', 'microphone', 'block')
      service.setPermission('https://b.example.com/', 'camera', 'allow')

      expect(service.getSitePermissions('https://a.example.com/')).toEqual({
        camera: 'allow',
        microphone: 'block'
      })
      expect(service.getSitePermissions('')).toEqual({})
    } finally {
      close()
    }
  })

  it('listByType 只返回指定类型', () => {
    const { service, close } = makeService()
    try {
      service.setPermission('https://a.example.com/', 'camera', 'allow')
      service.setPermission('https://b.example.com/', 'camera', 'block')
      service.setPermission('https://c.example.com/', 'notification', 'allow')

      expect(service.listByType('camera').length).toBe(2)
      expect(service.listByType('notification').length).toBe(1)
    } finally {
      close()
    }
  })

  it('clearSite 只清目标站点，clearAll 清空当前 profile', () => {
    const { service, close } = makeService()
    try {
      service.setPermission('https://a.example.com/', 'camera', 'allow')
      service.setPermission('https://a.example.com/', 'microphone', 'allow')
      service.setPermission('https://b.example.com/', 'camera', 'allow')

      expect(service.clearSite('https://a.example.com/')).toBe(2)
      expect(service.listAll().length).toBe(1)
      expect(service.clearAll()).toBe(1)
      expect(service.listAll().length).toBe(0)
    } finally {
      close()
    }
  })

  it('profile 之间权限互相隔离', () => {
    const { service, close } = makeService()
    try {
      service.setPermission('https://a.example.com/', 'camera', 'allow', 'p1')

      expect(service.getPermission('https://a.example.com/', 'camera', 'p1')).toBe('allow')
      expect(service.getPermission('https://a.example.com/', 'camera', 'p2')).toBe('ask')
      expect(service.listAll('p2').length).toBe(0)
    } finally {
      close()
    }
  })

  it('PERMISSION_TYPES 暴露全部受支持类型', () => {
    const { service, close } = makeService()
    try {
      expect(service.PERMISSION_TYPES).toContain('camera')
      expect(service.PERMISSION_TYPES).toContain('clipboard-read')
      // 必须使用 Electron 实际传入的权限名（对齐旧 Hira permissionManager 的处理清单）
      expect(service.PERMISSION_TYPES).toContain('notifications')
      expect(service.PERMISSION_TYPES).toContain('media')
      expect(service.PERMISSION_TYPES).toContain('geolocation')
      expect(service.PERMISSION_TYPES).toContain('display-capture')
      expect(service.PERMISSION_TYPES).toContain('clipboard-sanitized-write')
      expect(service.PERMISSION_TYPES.length).toBeGreaterThanOrEqual(10)
    } finally {
      close()
    }
  })
})

describe('domain-permission · 在飞行请求', () => {
  it('createRequest 登记待响应并向 renderer 推送事件', () => {
    const emit = vi.fn()
    const { service, close } = makeService({ emit })
    try {
      const id = service.createRequest('https://a.example.com/', 'camera', () => {})

      expect(service.listPendingRequests()).toEqual([
        { id, origin: 'https://a.example.com/', type: 'camera' }
      ])
      expect(emit).toHaveBeenCalledWith('permission:request', {
        id,
        origin: 'https://a.example.com/',
        type: 'camera'
      })
    } finally {
      close()
    }
  })

  it('respondToRequest 触发回调、出队并默认持久化', () => {
    const emit = vi.fn()
    const { service, close } = makeService({ emit })
    try {
      const callback = vi.fn()
      const id = service.createRequest('https://a.example.com/', 'camera', callback)

      expect(service.respondToRequest(id, true)).toBe(true)
      expect(callback).toHaveBeenCalledTimes(1)
      expect(callback).toHaveBeenCalledWith(true)
      expect(service.listPendingRequests().length).toBe(0)
      expect(service.getPermission('https://a.example.com/', 'camera')).toBe('allow')
      expect(emit).toHaveBeenCalledWith('permission:cleared', { id })
    } finally {
      close()
    }
  })

  it('persist=false 时只回调不落库', () => {
    const { service, close } = makeService()
    try {
      const id = service.createRequest('https://a.example.com/', 'camera', () => {})
      service.respondToRequest(id, true, false)

      expect(service.getPermission('https://a.example.com/', 'camera')).toBe('ask')
    } finally {
      close()
    }
  })

  it('同一站点同一权限重复请求被去重：只有一条 pending，且全部等待回调拿到同一结果', () => {
    const emit = vi.fn()
    const { service, close } = makeService({ emit })
    try {
      const first = vi.fn()
      const second = vi.fn()
      const idA = service.createRequest('https://a.example.com/', 'camera', first)
      const idB = service.createRequest('https://a.example.com/', 'camera', second)

      // 命中已有 pending：复用同一 id，不新建条目，也不再推送 permission:request（网页不会连弹）
      expect(idB).toBe(idA)
      expect(service.listPendingRequests()).toEqual([
        { id: idA, origin: 'https://a.example.com/', type: 'camera' }
      ])
      expect(emit).toHaveBeenCalledTimes(1)

      // 响应一次 → 所有等待方（含后来的重复请求）都被放行，绝不留悬挂 callback
      expect(service.respondToRequest(idA, true)).toBe(true)
      expect(first).toHaveBeenCalledWith(true)
      expect(second).toHaveBeenCalledWith(true)
      expect(service.listPendingRequests().length).toBe(0)
    } finally {
      close()
    }
  })

  it('同一站点不同权限互不影响，各自独立 pending', () => {
    const { service, close } = makeService()
    try {
      const camera = vi.fn()
      const mic = vi.fn()
      const idCamera = service.createRequest('https://a.example.com/', 'camera', camera)
      const idMic = service.createRequest('https://a.example.com/', 'microphone', mic)

      expect(idCamera).not.toBe(idMic)
      expect(service.listPendingRequests().length).toBe(2)

      service.respondToRequest(idCamera, true)
      expect(camera).toHaveBeenCalledWith(true)
      // 另一条权限的 waiting callback 不受牵连
      expect(mic).not.toHaveBeenCalled()
      expect(service.listPendingRequests()).toEqual([
        { id: idMic, origin: 'https://a.example.com/', type: 'microphone' }
      ])
    } finally {
      close()
    }
  })

  it('去重维度与 normalizeDomain 一致：协议 / 路径不同仍算同一站点同一权限', () => {
    const { service, close } = makeService()
    try {
      const a = vi.fn()
      const b = vi.fn()
      const idA = service.createRequest('https://a.example.com/page', 'camera', a)
      const idB = service.createRequest('http://a.example.com/', 'camera', b)

      expect(idB).toBe(idA)
      expect(service.listPendingRequests().length).toBe(1)
    } finally {
      close()
    }
  })

  it('去重后允许：为每个等待方的 scope 记会话内授予', () => {
    const { service, close } = makeService()
    try {
      const id = service.createRequest('https://a.example.com/', 'camera', () => {}, 'tab1')
      service.createRequest('https://a.example.com/', 'camera', () => {}, 'tab2')

      service.respondToRequest(id, true, false)
      expect(service.hasGrant('https://a.example.com/', 'camera', 'tab1')).toBe(true)
      expect(service.hasGrant('https://a.example.com/', 'camera', 'tab2')).toBe(true)
    } finally {
      close()
    }
  })

  it('rejectAllPending 把去重后同一 pending 的所有等待方一起拒绝', () => {
    const { service, close } = makeService()
    try {
      const first = vi.fn()
      const second = vi.fn()
      service.createRequest('https://a.example.com/', 'camera', first)
      service.createRequest('https://a.example.com/', 'camera', second)

      service.rejectAllPending()
      expect(first).toHaveBeenCalledWith(false)
      expect(second).toHaveBeenCalledWith(false)
      expect(service.listPendingRequests().length).toBe(0)
    } finally {
      close()
    }
  })

  it('重复响应同一请求返回 false，回调不会被调用两次', () => {
    const { service, close } = makeService()
    try {
      const callback = vi.fn()
      const id = service.createRequest('https://a.example.com/', 'camera', callback)

      expect(service.respondToRequest(id, false)).toBe(true)
      expect(service.respondToRequest(id, true)).toBe(false)
      expect(callback).toHaveBeenCalledTimes(1)
    } finally {
      close()
    }
  })

  it('回调抛异常不拖垮域，请求仍然出队', () => {
    const { service, close } = makeService()
    try {
      const id = service.createRequest('https://a.example.com/', 'camera', () => {
        throw new Error('renderer gone')
      })

      expect(() => service.respondToRequest(id, true)).not.toThrow()
      expect(service.listPendingRequests().length).toBe(0)
    } finally {
      close()
    }
  })

  it('rejectAllPending 对全部在飞行请求回 false 并清空', () => {
    const { service, close } = makeService()
    try {
      const a = vi.fn()
      const b = vi.fn()
      service.createRequest('https://a.example.com/', 'camera', a)
      service.createRequest('https://b.example.com/', 'microphone', b)

      service.rejectAllPending()

      expect(a).toHaveBeenCalledWith(false)
      expect(b).toHaveBeenCalledWith(false)
      expect(service.listPendingRequests().length).toBe(0)
    } finally {
      close()
    }
  })

  it('rejectAllPending 中单个回调抛错不影响其余回调', () => {
    const { service, close } = makeService()
    try {
      const good = vi.fn()
      service.createRequest('https://a.example.com/', 'camera', () => {
        throw new Error('boom')
      })
      service.createRequest('https://b.example.com/', 'microphone', good)

      expect(() => service.rejectAllPending()).not.toThrow()
      expect(good).toHaveBeenCalledWith(false)
    } finally {
      close()
    }
  })

  it('normalizeDomain 作为工具方法对外暴露', () => {
    const { service, close } = makeService()
    try {
      expect(service.normalizeDomain('https://a.example.com/x')).toBe(
        service.normalizeDomain('https://a.example.com/y')
      )
    } finally {
      close()
    }
  })
})
