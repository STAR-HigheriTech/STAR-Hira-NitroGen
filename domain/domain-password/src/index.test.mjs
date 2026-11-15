/**
 * domain-password 单测 —— 真实 SQLite（:memory:）+ Drizzle，零 Electron。
 *
 * 密码域最容易出致命静默故障的三处，必须各自钉死：
 *   1. 加密不可用时**必须拒绝保存**（历史事故：静默存 NULL，用户以为存了，填充永远是空）
 *   2. encrypt 失败返回 null 而非空串 —— 空串会被误读成"密码就是空的"
 *   3. 同 domain+username 是 upsert，不是每次登录都堆一条
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { createRequire } from 'node:module'
import { createPasswordService } from './index.ts'

const require = createRequire(import.meta.url)
// 加密 provider 已提升到 infra：域这边只**用**它，测它自己的那几节也搬去那边了
const { createSafeStorageCrypto, createUnavailableCrypto } = require('@hira-ng/infra-secret')
const { createDb } = require('@hira-ng/infra-db')

/** 可用的假 safeStorage：base64 往返，行为等价于真实 DPAPI 但无副作用 */
function fakeSafeStorage({ available = true, throwOnEncrypt = false, throwOnDecrypt = false } = {}) {
  return {
    isEncryptionAvailable: () => available,
    encryptString: (plain) => {
      if (throwOnEncrypt) throw new Error('DPAPI unavailable')
      return Buffer.from(`enc:${plain}`, 'utf8')
    },
    decryptString: (buf) => {
      if (throwOnDecrypt) throw new Error('key mismatch')
      const s = buf.toString('utf8')
      if (!s.startsWith('enc:')) throw new Error('bad payload')
      return s.slice(4)
    }
  }
}

function makeService(options = {}) {
  const { db, close } = createDb(':memory:')
  const service = createPasswordService(db, {
    crypto: createSafeStorageCrypto(fakeSafeStorage()),
    ...options
  })
  return { service, db, close }
}

let errSpy
let warnSpy
beforeEach(() => {
  errSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
  warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
})
afterEach(() => {
  errSpy.mockRestore()
  warnSpy.mockRestore()
})

describe('domain-password · 后端管理', () => {
  it('listBackends 列出四个后端，builtin 可用且默认活跃', () => {
    const { service, close } = makeService()
    try {
      const list = service.listBackends()
      expect(list.map((b) => b.name)).toEqual(['builtin', 'bitwarden', '1password', 'keychain'])
      expect(list.find((b) => b.name === 'builtin')).toEqual({ name: 'builtin', available: true, active: true, writable: true })
      expect(list.filter((b) => b.available).length).toBeGreaterThanOrEqual(1)
      expect(service.getActiveBackend()).toBe('builtin')
      expect(service.isAvailable()).toBe(true)
    } finally {
      close()
    }
  })

  it('setActiveBackend 只接受已知后端；未知名字不改变现状', () => {
    const { service, close } = makeService()
    try {
      expect(service.setActiveBackend('keychain')).toBe(true)
      expect(service.getActiveBackend()).toBe('keychain')
      expect(service.setActiveBackend('lastpass')).toBe(false)
      expect(service.getActiveBackend()).toBe('keychain')
    } finally {
      close()
    }
  })

  it('切到只读外部后端后保存安全回落内置库，删除也清理内置库', async () => {
    const { service, close } = makeService()
    try {
      const readOnlyNames = service.listBackends()
        .filter((backend) => backend.name !== 'builtin' && backend.writable === false)
        .map((backend) => backend.name)
      expect(readOnlyNames.length).toBeGreaterThan(0)
      for (const name of readOnlyNames) {
        service.setActiveBackend(name)
        const saved = await service.saveCredential({ hostname: 'a.test', username: 'u', password: 'p' })
        expect(saved).toMatchObject({ ok: true, backend: 'builtin' })
        expect(await service.getSuggestions('a.test')).toHaveLength(1)
        const rows = await service.listCredentials()
        expect(rows).toHaveLength(1)
        expect(await service.deleteCredential(rows[0].id)).toBe(true)
      }
      service.setActiveBackend('builtin')
      expect(await service.listCredentials()).toEqual([])
    } finally {
      close()
    }
  })

  it('defaultBackend 选项可指定启动后端', () => {
    const { service, close } = makeService({ defaultBackend: '1password' })
    try {
      expect(service.getActiveBackend()).toBe('1password')
    } finally {
      close()
    }
  })
})

describe('domain-password · builtin 凭据 CRUD', () => {
  it('saveCredential 落库后可解密取回', async () => {
    const { service, close } = makeService()
    try {
      const res = await service.saveCredential({ hostname: 'https://mail.example.com/login', username: 'alice', password: 'hunter2' })
      expect(res.ok).toBe(true)
      // hunter2 含数字 → score 1
      expect(res.strength).toEqual({ score: 1, label: '弱' })
      const sug = await service.getSuggestions('https://mail.example.com/')
      expect(sug).toEqual([
        { id: expect.any(String), domain: 'mail.example.com', username: 'alice', password: 'hunter2', manager: 'Builtin', masked: '*******' }
      ])
    } finally {
      close()
    }
  })

  it('同 domain+username 重复保存是 upsert，不堆行', async () => {
    const { service, close } = makeService()
    try {
      await service.saveCredential({ hostname: 'example.com', username: 'alice', password: 'old' })
      await service.saveCredential({ hostname: 'https://example.com/other', username: 'alice', password: 'new' })
      const rows = await service.listCredentials()
      expect(rows.length).toBe(1)
      expect((await service.getSuggestions('example.com'))[0].password).toBe('new')
    } finally {
      close()
    }
  })

  it('同域不同用户名各存一条', async () => {
    const { service, close } = makeService()
    try {
      await service.saveCredential({ hostname: 'example.com', username: 'alice', password: 'a' })
      await service.saveCredential({ hostname: 'example.com', username: 'bob', password: 'b' })
      expect((await service.listCredentials()).length).toBe(2)
    } finally {
      close()
    }
  })

  it('缺 hostname 或 username 直接拒绝', async () => {
    const { service, close } = makeService()
    try {
      expect(await service.saveCredential({ hostname: '', username: 'a', password: 'p' })).toBe(false)
      expect(await service.saveCredential({ hostname: 'a.test', username: '', password: 'p' })).toBe(false)
      expect((await service.listCredentials()).length).toBe(0)
    } finally {
      close()
    }
  })

  it('加密 provider 不可用 → 拒绝保存并报错（绝不静默存 NULL）', async () => {
    const { service, close } = makeService({ crypto: createUnavailableCrypto('测试') })
    try {
      expect(service.isAvailable()).toBe(false)
      expect(await service.saveCredential({ hostname: 'a.test', username: 'u', password: 'p' })).toBe(false)
      expect((await service.listCredentials()).length).toBe(0)
      expect(errSpy).toHaveBeenCalled()
    } finally {
      close()
    }
  })

  it('密文解不开时给出空密码并告警，而不是当作没存过', async () => {
    const { db, close } = createDb(':memory:')
    try {
      const good = createPasswordService(db, { crypto: createSafeStorageCrypto(fakeSafeStorage()) })
      await good.saveCredential({ hostname: 'example.com', username: 'alice', password: 'hunter2' })

      const broken = createPasswordService(db, {
        crypto: createSafeStorageCrypto(fakeSafeStorage({ throwOnDecrypt: true }))
      })
      const sug = await broken.getSuggestions('example.com')
      expect(sug).toEqual([
        { id: expect.any(String), domain: 'example.com', username: 'alice', password: '', manager: 'Builtin', masked: '' }
      ])
      expect(warnSpy).toHaveBeenCalled()
    } finally {
      close()
    }
  })

  it('getSuggestions 对空/非法 hostname 返回空数组', async () => {
    const { service, close } = makeService()
    try {
      expect(await service.getSuggestions('')).toEqual([])
      expect(await service.getSuggestions(null)).toEqual([])
    } finally {
      close()
    }
  })

  it('listCredentials 不泄露密文，且按 profile 隔离', async () => {
    const { db, close } = createDb(':memory:')
    try {
      const crypto = createSafeStorageCrypto(fakeSafeStorage())
      const svc = createPasswordService(db, { crypto })
      await svc.saveCredential({ hostname: 'a.test', username: 'u1', password: 'p1', profileId: 'default' })
      await svc.saveCredential({ hostname: 'b.test', username: 'u2', password: 'p2', profileId: 'work' })

      const def = await svc.listCredentials()
      expect(def.map((r) => r.username)).toEqual(['u1'])
      expect(def[0].encryptedPassword).toBeUndefined()
      expect(def[0].manager).toBe('Builtin')
      expect(def[0].domain).toBe('a.test')

      expect((await svc.listCredentials('work')).map((r) => r.username)).toEqual(['u2'])
    } finally {
      close()
    }
  })

  it('profileId 选项决定 listCredentials 的默认 profile', async () => {
    const { db, close } = createDb(':memory:')
    try {
      const crypto = createSafeStorageCrypto(fakeSafeStorage())
      const svc = createPasswordService(db, { crypto, profileId: 'work' })
      await svc.saveCredential({ hostname: 'b.test', username: 'u2', password: 'p2', profileId: 'work' })
      expect((await svc.listCredentials()).map((r) => r.username)).toEqual(['u2'])
    } finally {
      close()
    }
  })

  it('deleteCredential 命中才返回 true', async () => {
    const { service, close } = makeService()
    try {
      await service.saveCredential({ hostname: 'a.test', username: 'u', password: 'p' })
      const [row] = await service.listCredentials()
      expect(await service.deleteCredential(row.id)).toBe(true)
      expect(await service.deleteCredential(row.id)).toBe(false)
      expect(await service.listCredentials()).toEqual([])
    } finally {
      close()
    }
  })
})

describe('domain-password · 永不保存域名', () => {
  it('addNeverSave 归一化后去重，getNeverSaveDomains 返回副本', () => {
    const { service, close } = makeService()
    try {
      service.addNeverSave('https://bank.test/login')
      service.addNeverSave('bank.test')
      service.addNeverSave('')
      expect(service.getNeverSaveDomains()).toEqual(['bank.test'])

      const copy = service.getNeverSaveDomains()
      copy.push('injected')
      expect(service.getNeverSaveDomains()).toEqual(['bank.test'])
    } finally {
      close()
    }
  })

  it('isNeverSave 覆盖子域，但不误伤同后缀的其他域', () => {
    const { service, close } = makeService()
    try {
      service.addNeverSave('bank.test')
      expect(service.isNeverSave('bank.test')).toBe(true)
      expect(service.isNeverSave('https://login.bank.test/x')).toBe(true)
      expect(service.isNeverSave('notbank.test')).toBe(false)
      expect(service.isNeverSave('other.test')).toBe(false)
    } finally {
      close()
    }
  })

  it('removeNeverSave 按归一化域名移除', () => {
    const { service, close } = makeService()
    try {
      service.addNeverSave('bank.test')
      service.addNeverSave('shop.test')
      service.removeNeverSave('https://bank.test/')
      expect(service.getNeverSaveDomains()).toEqual(['shop.test'])
    } finally {
      close()
    }
  })

  it('never-save 持久化到 SQLite 且按 profile 隔离，重建 service 后仍生效', async () => {
    const { db, close } = createDb(':memory:')
    try {
      const crypto = createSafeStorageCrypto(fakeSafeStorage())
      const first = createPasswordService(db, { crypto, profileId: 'default' })
      expect(first.addNeverSave('https://bank.test/login')).toBe(true)
      expect(first.getNeverSaveDomains()).toEqual(['bank.test'])
      expect(first.addNeverSave('bank.test')).toBe(false)
      expect(first.isNeverSave('login.bank.test')).toBe(true)
      expect(first.getNeverSaveDomains('work')).toEqual([])
      expect(first.addNeverSave('work.test', 'work')).toBe(true)
      expect(first.getNeverSaveDomains('work')).toEqual(['work.test'])
      expect(first.isNeverSave('work.test')).toBe(false)

      const restored = createPasswordService(db, { crypto, profileId: 'default' })
      expect(restored.getNeverSaveDomains()).toEqual(['bank.test'])
      expect(restored.isNeverSave('login.bank.test')).toBe(true)
      expect(await restored.saveCredential({ hostname: 'bank.test', username: 'u', password: 'p' })).toBe(false)
      expect(await restored.saveCredential({ hostname: 'work.test', username: 'u', password: 'p', profileId: 'work' })).toBe(false)
      expect(await restored.saveCredential({ hostname: 'other.test', username: 'u', password: 'p' })).toEqual(expect.objectContaining({ ok: true }))
    } finally {
      close()
    }
  })

  it('切换 service profile 后永不保存规则跟随当前 profile', () => {
    const { service, close } = makeService({ profileId: 'default' })
    try {
      service.addNeverSave('default.test')
      service.setProfile('work')
      expect(service.getNeverSaveDomains()).toEqual([])
      expect(service.isNeverSave('default.test')).toBe(false)
      service.addNeverSave('work.test')
      expect(service.getNeverSaveDomains()).toEqual(['work.test'])
      service.setProfile('default')
      expect(service.getNeverSaveDomains()).toEqual(['default.test'])
    } finally {
      close()
    }
  })
})

describe('domain-password · 工具', () => {
  it('normalizeDomain 剥协议/路径/端口并小写', () => {
    const { service, close } = makeService()
    try {
      expect(service.normalizeDomain('https://Example.COM/a/b?c=1')).toBe('example.com')
      expect(service.normalizeDomain('example.com')).toBe('example.com')
    } finally {
      close()
    }
  })
})

describe('domain-password · 纯规则接线', () => {
  it('getSuggestions 每项附带 masked（仅掩码、不泄露明文）', async () => {
    const { service, close } = makeService()
    try {
      await service.saveCredential({ hostname: 'a.test', username: 'u', password: 'secret123' })
      const sug = await service.getSuggestions('a.test')
      expect(sug[0].masked).toBe('*********')
      expect(sug[0].password).toBe('secret123')
    } finally {
      close()
    }
  })

  it('saveCredential 成功后附带 strength（additive）', async () => {
    const { service, close } = makeService()
    try {
      const res = await service.saveCredential({ hostname: 'a.test', username: 'u', password: 'Abc123!x' })
      expect(res.ok).toBe(true)
      expect(res.strength.label).toBe('极强')
      expect(res.strength.score).toBe(4)
    } finally {
      close()
    }
  })

  it('存储不变量：密码大小写逐字保留，解密取回与建议均不改变 password', async () => {
    const { service, close } = makeService()
    try {
      await service.saveCredential({ hostname: 'case.test', username: 'Alice', password: 'MyP@ssw0rd!' })
      const [sug] = await service.getSuggestions('case.test')
      expect(sug.username).toBe('Alice')
      expect(sug.password).toBe('MyP@ssw0rd!')
    } finally {
      close()
    }
  })

  it('只读后端保存会回落内置库并返回写入目标', async () => {
    const { service, close } = makeService()
    try {
      const readOnly = service.listBackends().find((backend) => backend.name !== 'builtin' && backend.writable === false)
      expect(readOnly).toBeTruthy()
      service.setActiveBackend(readOnly.name)
      expect(await service.saveCredential({ hostname: 'a.test', username: 'u', password: 'p' }))
        .toMatchObject({ ok: true, backend: 'builtin' })
    } finally {
      close()
    }
  })

  it('用户名归一 upsert：大小写/@ 前缀视为同一项，但存储保留原始大小写', async () => {
    const { service, close } = makeService()
    try {
      await service.saveCredential({ hostname: 'a.test', username: '@Alice ', password: 'one' })
      await service.saveCredential({ hostname: 'a.test', username: 'alice', password: 'two' })
      const rows = await service.listCredentials()
      expect(rows.length).toBe(1)
      expect(rows[0].username).toBe('@Alice')
    } finally {
      close()
    }
  })

  it('matchesNeverSave 语义：子域命中、同后缀不误伤', () => {
    const { service, close } = makeService()
    try {
      service.addNeverSave('bank.test')
      expect(service.isNeverSave('login.bank.test')).toBe(true)
      expect(service.isNeverSave('notbank.test')).toBe(false)
    } finally {
      close()
    }
  })

  it('lowStrengthFlag = isWeakPassword', async () => {
    const { service, close } = makeService()
    try {
      expect(service.lowStrengthFlag('short')).toBe(true)
      expect(service.lowStrengthFlag('GoodPass1!')).toBe(false)
    } finally {
      close()
    }
  })
})
