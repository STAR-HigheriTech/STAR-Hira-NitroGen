/**
 * infra-secret 单测 —— 零 Electron、零数据库（纯适配器，靠假 safeStorage 驱动）。
 *
 * 这个文件原来住在 `domain-password/src/index.test.mjs` 的 "crypto provider" 那一节，
 * 随实现一起搬过来 —— 测的是 infra 的能力，就该在 infra 里跑。
 *
 * 三条契约必须钉死（历史事故：靠它们才不会静默把密文存成 NULL）：
 *   1. `encrypt` 失败返回 **null 而不是空串** —— 空串会被下游误读成"明文就是空的"
 *   2. `safeStorage` 传 undefined 时恒不可用且不抛（踩过的 `app.safeStorage` 坑）
 *   3. `decrypt` 遇到密钥不匹配 / 空密文返回 null，不把异常抛穿
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const { createSafeStorageCrypto, createUnavailableCrypto } = require('../dist/index.cjs')

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

let errSpy
beforeEach(() => {
  errSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
})
afterEach(() => {
  errSpy.mockRestore()
})

describe('infra-secret · safe-storage provider', () => {
  it('可用时 encrypt/decrypt 往返无损', () => {
    const c = createSafeStorageCrypto(fakeSafeStorage())
    expect(c.name).toBe('safe-storage')
    expect(c.isAvailable()).toBe(true)
    const b64 = c.encrypt('hunter2')
    expect(typeof b64).toBe('string')
    expect(b64).not.toBe('')
    expect(c.decrypt(b64)).toBe('hunter2')
  })

  it('safeStorage 为 undefined（踩过的 app.safeStorage 坑）→ 恒不可用且不抛', () => {
    const c = createSafeStorageCrypto(undefined)
    expect(c.isAvailable()).toBe(false)
    expect(c.encrypt('x')).toBeNull()
    expect(c.decrypt('x')).toBeNull()
  })

  it('加密失败一律返回 null，绝不返回空串', () => {
    expect(createSafeStorageCrypto(fakeSafeStorage({ throwOnEncrypt: true })).encrypt('x')).toBeNull()
    expect(createSafeStorageCrypto(fakeSafeStorage()).encrypt(123)).toBeNull()
  })

  it('密钥不匹配 / 密文为空 → decrypt 返回 null 而不是抛穿', () => {
    expect(createSafeStorageCrypto(fakeSafeStorage({ throwOnDecrypt: true })).decrypt('zzz')).toBeNull()
    expect(createSafeStorageCrypto(fakeSafeStorage()).decrypt('')).toBeNull()
  })

  it('isOsKeychain 在 Linux basic_text 回退时判否（不谎称走了钥匙串）', () => {
    expect(createSafeStorageCrypto(fakeSafeStorage({ available: false })).isOsKeychain()).toBe(false)
    expect(createSafeStorageCrypto(fakeSafeStorage()).isOsKeychain()).toBe(true)
    const basicText = fakeSafeStorage()
    basicText.getSelectedStorageBackend = () => 'basic_text'
    expect(createSafeStorageCrypto(basicText).isOsKeychain()).toBe(false)
    // 未 ready 时该 API 会抛 —— 必须被吞掉并保守判否
    const throwing = fakeSafeStorage()
    throwing.getSelectedStorageBackend = () => { throw new Error('not ready') }
    expect(createSafeStorageCrypto(throwing).isOsKeychain()).toBe(false)
  })

  it('createUnavailableCrypto 显式不可用并带上原因', () => {
    const c = createUnavailableCrypto('DI 没接上')
    expect(c.name).toBe('unavailable')
    expect(c.isAvailable()).toBe(false)
    expect(c.encrypt('x')).toBeNull()
    expect(c.decrypt('x')).toBeNull()
    expect(c.reason).toBe('DI 没接上')
    expect(createUnavailableCrypto().reason).toBe('未提供加密 provider')
  })
})
