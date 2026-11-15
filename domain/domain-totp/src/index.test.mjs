/**
 * domain-totp 单测 —— 真实 SQLite（:memory:）+ Drizzle，零 Electron。
 *
 * 这个域最容易出**静默致命故障**的地方，逐条钉死：
 *   1. 明文密钥落盘（一旦发生就是"用户以为加密了"）—— 必须直接读原始行确认只有密文
 *   2. 出口漏出密钥（`list()` 里带上禁书）—— 上层一处误传就等于全线泄露
 *   3. 算码算错（参数没逐条传下去）—— 表现是"码不对"，用户只会怀疑自己扫错了
 *   4. profile 串数据（拿不到 profile 就不过滤）
 *   5. 加密不可用时静默存空
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { createRequire } from 'node:module'
import { createTotpService, normalizeSecret } from './index.ts'

const require = createRequire(import.meta.url)
const { createDb } = require('@hira-ng/infra-db')
const { totpEntries } = require('@hira-ng/infra-db/schema')
const OTPAuth = require('otpauth')

/** RFC 6238 附录 B 的种子：ASCII "12345678901234567890" */
const RFC_SECRET = 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ'

/** 假加密 provider：可逆但**刻意不是恒等**，好让"忘了加密"这种错立刻暴露。 */
function fakeCrypto({ available = true, throwOnEncrypt = false } = {}) {
  return {
    name: 'fake',
    isAvailable: () => available,
    encrypt: (plain) => {
      if (throwOnEncrypt) return null
      if (typeof plain !== 'string') return null
      return 'v1:' + Buffer.from(plain, 'utf8').toString('base64')
    },
    decrypt: (cipher) => {
      if (typeof cipher !== 'string' || !cipher.startsWith('v1:')) return null
      return Buffer.from(cipher.slice(3), 'base64').toString('utf8')
    }
  }
}

function makeService(options = {}) {
  const { db, close } = createDb(':memory:')
  const service = createTotpService(db, { crypto: fakeCrypto(), ...options })
  return { service, db, close }
}

let errSpy
beforeEach(() => { errSpy = vi.spyOn(console, 'error').mockImplementation(() => {}) })
afterEach(() => { errSpy.mockRestore() })

describe('domain-totp · 算码正确性', () => {
  /**
   * 直接对 RFC 6238 附录 B 的官方向量。
   * 这条挂了说明**是库或参数的问题**，不是接线 —— 两者要能分开定位。
   */
  it('依赖的库对得上 RFC 6238 附录 B 的官方向量', () => {
    const totp = new OTPAuth.TOTP({
      secret: OTPAuth.Secret.fromBase32(RFC_SECRET), digits: 8, period: 30, algorithm: 'SHA1'
    })
    const VECTORS = [
      [59, '94287082'], [1111111109, '07081804'], [1111111111, '14050471'],
      [1234567890, '89005924'], [2000000000, '69279037'], [20000000000, '65353130']
    ]
    for (const [ts, want] of VECTORS) {
      expect(totp.generate({ timestamp: ts * 1000 })).toBe(want)
    }
  })

  it('service 算出的码能被同一个密钥验证（接线正确：密钥解开、参数逐条传到）', () => {
    const { service, close } = makeService()
    try {
      const res = service.add({ issuer: 'ACME', account: 'alice', secret: RFC_SECRET, digits: 8 })
      expect(res.ok).toBe(true)
      const { codes, unavailable } = service.code()
      expect(unavailable).toEqual([])
      expect(codes).toHaveLength(1)

      // 用同参数独立算一遍，比对 service 的输出（留 ±1 窗口吸收跨窗瞬间）
      const ref = new OTPAuth.TOTP({
        issuer: 'ACME', label: 'alice',
        secret: OTPAuth.Secret.fromBase32(RFC_SECRET), digits: 8, period: 30, algorithm: 'SHA1'
      })
      expect(ref.validate({ token: codes[0].code, window: 1 })).not.toBeNull()
      expect(codes[0].code).toMatch(/^\d{8}$/)
      expect(codes[0].remaining).toBeGreaterThan(0)
      expect(codes[0].remaining).toBeLessThanOrEqual(30)
    } finally {
      close()
    }
  })

  it('算法参数逐条生效（8 位 / 60 秒的条目不会被当成默认的 6 位 / 30 秒）', () => {
    const { service, close } = makeService()
    try {
      service.add({ issuer: 'A', account: 'a', secret: RFC_SECRET, digits: 8, period: 60 })
      service.add({ issuer: 'B', account: 'b', secret: RFC_SECRET })
      const { codes } = service.code()
      const byCode = new Map(codes.map((c) => [c.id, c]))
      const list = service.list()
      const a = list.find((e) => e.issuer === 'A')
      const b = list.find((e) => e.issuer === 'B')
      expect(byCode.get(a.id).code).toMatch(/^\d{8}$/)
      expect(byCode.get(a.id).period).toBe(60)
      expect(byCode.get(b.id).code).toMatch(/^\d{6}$/)
      expect(byCode.get(b.id).period).toBe(30)
    } finally {
      close()
    }
  })

  it('HOTP 条目走计数器而不是时间（且没有倒计时）', () => {
    const { service, close } = makeService()
    try {
      service.add({ issuer: 'Legacy', account: 'u', secret: RFC_SECRET, type: 'HOTP', counter: 0 })
      const { codes, unavailable } = service.code()
      expect(unavailable).toEqual([])
      expect(codes[0].code).toBe('755224')   // RFC 4226 附录 D 的第一条向量
      expect(codes[0].type).toBe('HOTP')
      // 计数器式没有时间窗：必须是 null 而不是 0（0 会被读成"马上就换"）
      expect(codes[0].remaining).toBeNull()
      expect(codes[0].period).toBeNull()
    } finally {
      close()
    }
  })
})

describe('domain-totp · 密钥边界', () => {
  it('⚠ 明文密钥绝不落盘：原始行里只有密文', () => {
    const { service, db, close } = makeService()
    try {
      service.add({ issuer: 'ACME', account: 'alice', secret: RFC_SECRET })
      const rows = db.select().from(totpEntries).all()
      expect(rows).toHaveLength(1)
      expect(rows[0].secretCipher).not.toContain(RFC_SECRET)
      expect(rows[0].secretCipher.startsWith('v1:')).toBe(true)   // 确实过了 provider
    } finally {
      close()
    }
  })

  it('⚠ 出口不携带密钥：list() 的形状里根本没有 secret 类字段', () => {
    const { service, close } = makeService()
    try {
      service.add({ issuer: 'ACME', account: 'alice', secret: RFC_SECRET })
      const entries = service.list()
      const keys = Object.keys(entries[0])
      for (const k of keys) {
        expect(k.toLowerCase()).not.toContain('secret')
        expect(k.toLowerCase()).not.toContain('cipher')
      }
      expect(JSON.stringify(entries)).not.toContain(RFC_SECRET)
    } finally {
      close()
    }
  })

  it('code() 只回验证码与倒计时，不回密钥', () => {
    const { service, close } = makeService()
    try {
      service.add({ issuer: 'ACME', account: 'alice', secret: RFC_SECRET })
      const res = service.code()
      expect(res.codes).toHaveLength(1)
      expect(Object.keys(res.codes[0]).sort()).toEqual(['code', 'id', 'period', 'remaining', 'type'])
      expect(JSON.stringify(res)).not.toContain(RFC_SECRET)
    } finally {
      close()
    }
  })

  it('加密不可用 → 拒绝保存并给出可读原因（绝不静默存空）', () => {
    const { db, close } = createDb(':memory:')
    try {
      const service = createTotpService(db, { crypto: fakeCrypto({ available: false }) })
      const res = service.add({ issuer: 'ACME', account: 'alice', secret: RFC_SECRET })
      expect(res.ok).toBe(false)
      expect(res.reason).toContain('系统加密不可用')
      expect(db.select().from(totpEntries).all()).toHaveLength(0)
    } finally {
      close()
    }
  })

  it('解密失败（换机器 / 数据损坏）→ code() 报到 unavailable 而不是静默少一条', () => {
    const { service, db, close } = makeService()
    try {
      service.add({ issuer: 'ACME', account: 'alice', secret: RFC_SECRET })
      // 模拟"这台机器解不开它"
      db.update(totpEntries).set({ secretCipher: 'dpapi:不匹配的密文' }).run()
      const res = service.code()
      expect(res.codes).toHaveLength(0)
      expect(res.unavailable).toHaveLength(1)
      // 条目本身还在（不是数据丢了，只是解不开）
      expect(service.list()).toHaveLength(1)
      expect(service.exportUri(service.list()[0].id).ok).toBe(false)
    } finally {
      close()
    }
  })
})

describe('domain-totp · 输入归一化与校验', () => {
  it('normalizeSecret 去空白/连字符/padding 并转大写（手输与网页复制都不该报错）', () => {
    expect(normalizeSecret(' jbsw y3dp-ehpk3pxp ')).toBe('JBSWY3DPEHPK3PXP')
    expect(normalizeSecret('JBSWY3DPEHPK3PXP===')).toBe('JBSWY3DPEHPK3PXP')
    expect(normalizeSecret('jbswy3dpehpk3pxp')).toBe('JBSWY3DPEHPK3PXP')
  })

  it('非 Base32 密钥被拒绝，且不落库', () => {
    const { service, db, close } = makeService()
    try {
      const res = service.add({ issuer: 'X', account: 'y', secret: 'NOT-BASE32!!!' })
      expect(res.ok).toBe(false)
      expect(res.reason).toContain('Base32')
      expect(db.select().from(totpEntries).all()).toHaveLength(0)
    } finally {
      close()
    }
  })

  it('非法的算法/位数/类型回落默认（参数不是"用户错误"，不该弹错）', () => {
    const { service, close } = makeService()
    try {
      const res = service.add({
        issuer: 'X', account: 'y', secret: RFC_SECRET,
        algorithm: 'MD5', digits: 7, type: 'SMS', period: -1
      })
      expect(res.ok).toBe(true)
      expect(res.entry.algorithm).toBe('SHA1')
      expect(res.entry.digits).toBe(6)
      expect(res.entry.type).toBe('TOTP')
      expect(res.entry.period).toBe(30)
    } finally {
      close()
    }
  })
})

describe('domain-totp · 导入', () => {
  it('标准 otpauth URI 导入成功，参数被保留', () => {
    const { service, close } = makeService()
    try {
      const res = service.importUris({
        uris: ['otpauth://totp/GitHub:alice@example.com?secret=' + RFC_SECRET + '&issuer=GitHub&digits=8&period=60&algorithm=SHA256']
      })
      expect(res.ok).toBe(true)
      expect(res.skipped).toEqual([])
      expect(res.added).toHaveLength(1)
      expect(res.added[0]).toMatchObject({
        issuer: 'GitHub', account: 'alice@example.com', digits: 8, period: 60, algorithm: 'SHA256'
      })
    } finally {
      close()
    }
  })

  it('尽力而为：坏的跳过并报出第几条、为什么，好的照常导入', () => {
    const { service, close } = makeService()
    try {
      const res = service.importUris({
        uris: [
          'otpauth://totp/A:a?secret=' + RFC_SECRET,
          'not-a-uri',
          '',
          'otpauth://totp/B:b?secret=!!!invalid!!!'
        ]
      })
      expect(res.added).toHaveLength(1)
      expect(res.skipped.map((s) => s.index)).toEqual([1, 2, 3])
      expect(res.skipped.every((s) => typeof s.reason === 'string' && s.reason)).toBe(true)
    } finally {
      close()
    }
  })

  it('同一份导出导两次 → 第二次全部判重跳过（这正是判重存在的理由）', () => {
    const { service, close } = makeService()
    try {
      const uris = [
        'otpauth://totp/A:a?secret=' + RFC_SECRET,
        'otpauth://totp/B:b?secret=' + RFC_SECRET
      ]
      expect(service.importUris({ uris }).added).toHaveLength(2)
      const second = service.importUris({ uris })
      expect(second.added).toHaveLength(0)
      expect(second.skipped).toHaveLength(2)
      expect(service.list()).toHaveLength(2)
    } finally {
      close()
    }
  })

  it('HOTP 的 URI 也能导入，并带上 counter', () => {
    const { service, close } = makeService()
    try {
      const res = service.importUris({
        uris: ['otpauth://hotp/Legacy:u?secret=' + RFC_SECRET + '&counter=3']
      })
      expect(res.added[0]).toMatchObject({ type: 'HOTP', counter: 3 })
    } finally {
      close()
    }
  })
})

describe('domain-totp · 导出与更新', () => {
  it('exportUri 往返：导出的 URI 再导入得到同一条（密钥/参数都无损）', () => {
    const { service, close } = makeService()
    try {
      const added = service.add({ issuer: 'ACME', account: 'alice', secret: RFC_SECRET, digits: 8, period: 60 })
      const out = service.exportUri(added.entry.id)
      expect(out.ok).toBe(true)
      const reparsed = OTPAuth.URI.parse(out.uri)
      expect(reparsed.secret.base32).toBe(RFC_SECRET)
      expect(reparsed.digits).toBe(8)
      expect(reparsed.period).toBe(60)
      expect(reparsed.issuer).toBe('ACME')
      expect(reparsed.label).toBe('alice')
    } finally {
      close()
    }
  })

  it('只改名字时不清空算法参数（未传的字段沿用原值）', () => {
    const { service, close } = makeService()
    try {
      const added = service.add({ issuer: 'A', account: 'a', secret: RFC_SECRET, digits: 8, period: 60 })
      const res = service.update(added.entry.id, { account: 'renamed' })
      expect(res.entry).toMatchObject({ account: 'renamed', digits: 8, period: 60 })
      // 改完还能算得出码（密钥没被动坏）
      expect(service.code({ id: added.entry.id }).codes).toHaveLength(1)
    } finally {
      close()
    }
  })

  it('改密钥后码跟着变（"扫错了重扫"这条路径）', () => {
    const { service, close } = makeService()
    try {
      const added = service.add({ issuer: 'A', account: 'a', secret: RFC_SECRET })
      const OTHER = 'JBSWY3DPEHPK3PXP'
      expect(service.update(added.entry.id, { secret: OTHER }).ok).toBe(true)
      const after = service.code({ id: added.entry.id }).codes[0].code
      // 新码能被**新**密钥验证，且不能被**旧**密钥验证 —— 两个方向都要证
      const newRef = new OTPAuth.TOTP({
        secret: OTPAuth.Secret.fromBase32(OTHER), digits: 6, period: 30, algorithm: 'SHA1'
      })
      const oldRef = new OTPAuth.TOTP({
        secret: OTPAuth.Secret.fromBase32(RFC_SECRET), digits: 6, period: 30, algorithm: 'SHA1'
      })
      expect(newRef.validate({ token: after, window: 1 })).not.toBeNull()
      expect(oldRef.validate({ token: after, window: 1 })).toBeNull()
    } finally {
      close()
    }
  })

  it('update / remove 不存在的 id → ok:false', () => {
    const { service, close } = makeService()
    try {
      expect(service.update('nope', { account: 'x' }).ok).toBe(false)
      expect(service.remove('nope').ok).toBe(false)
    } finally {
      close()
    }
  })
})

describe('domain-totp · profile 隔离与订阅', () => {
  it('条目按 profile 隔离；拿不到 profile 就回落 default（绝不"不过滤"）', () => {
    const { db, close } = createDb(':memory:')
    try {
      let pid = 'alice'
      const a = createTotpService(db, { crypto: fakeCrypto(), getProfileId: () => pid })
      a.add({ issuer: 'A', account: 'a', secret: RFC_SECRET })

      pid = 'bob'
      const b = createTotpService(db, { crypto: fakeCrypto(), getProfileId: () => pid })
      expect(b.list()).toHaveLength(0)          // 看不到 alice 的
      b.add({ issuer: 'B', account: 'b', secret: RFC_SECRET })

      pid = 'alice'
      expect(a.list().map((e) => e.issuer)).toEqual(['A'])

      // 抛错的端口 → default，而不是"返回全部"
      const broken = createTotpService(db, { crypto: fakeCrypto(), getProfileId: () => { throw new Error('x') } })
      expect(broken.list()).toHaveLength(0)
    } finally {
      close()
    }
  })

  it('写操作会广播变更（供 APPS 层转 IPC）', () => {
    const { service, close } = makeService()
    try {
      const seen = []
      const off = service.subscribe((c) => seen.push(c.reason))
      const added = service.add({ issuer: 'A', account: 'a', secret: RFC_SECRET })
      service.update(added.entry.id, { account: 'z' })
      service.remove(added.entry.id)
      // add 不广播（调用方自己拿到了结果）；update/remove/import 才需要通知"别处也要刷"
      expect(seen).toEqual(['update', 'remove'])
      off()
      service.update('x', {})
      expect(seen).toEqual(['update', 'remove'])
    } finally {
      close()
    }
  })
})
