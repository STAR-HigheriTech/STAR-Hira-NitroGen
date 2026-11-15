/**
 * infra-secret —— **本机密钥加密**的 provider 抽象（静态密钥在磁盘上的那一层）。
 *
 * ══════════════════════════════════════════════════════════════════════
 * 为什么它在 infra 而不是某个 domain 里
 * ══════════════════════════════════════════════════════════════════════
 * 它原来住在 `domain-password/src/crypto/safe-storage.js`。但"把一段敏感字符串
 * 加密后落盘"不是**密码域**的业务，而是**基础设施能力** —— 密码域只是第一个用户。
 *
 * 第二个用户（TOTP 验证器的密钥）出现时，这条路就走不通了：让 `domain-totp` 去
 * require `domain-password` 是**域间反向依赖**，会把两个本该无关的业务绑在一起
 * （改密码模块会连带影响 TOTP —— 编译器不会提醒你，只有运行时才发现）。
 * 而本文件是**纯适配器**：`safeStorage` 由参数注入，全文件零 electron import，
 * 天然属于 infra（与 infra-db / infra-storage / infra-ipc 同一层）。
 *
 * ══════════════════════════════════════════════════════════════════════
 * 契约（调用方按这个契约注入，不关心底层是什么）
 * ══════════════════════════════════════════════════════════════════════
 *   { name, isAvailable(), encrypt(plain), decrypt(b64) }
 *
 *   encrypt 成功返回**非空字符串**；**失败必须返回 null**（绝不返回空串 ——
 *     否则"加密失败"会被下游误当成"明文是空的"，两者后果完全不同）。
 *   decrypt 成功返回明文；密文缺失或解不开返回 null。
 *
 * 可选能力（不实现即视为不支持，调用方必须容忍缺失）：
 *   isOsKeychain() —— 加密是否**真的**由操作系统钥匙串承担。
 *
 * 换实现（系统钥匙串 / 硬件密钥 / 第三方 CLI / 测试用明文桩）只需实现同一契约
 * 注入进来，各域零改动。
 */

/**
 * Electron safeStorage provider。
 *
 * ⚠️ 关键坑（本项目踩过）：`safeStorage` 是 electron 的**顶层导出**，
 * 不是 `app` 的属性 —— `app.safeStorage` 恒为 `undefined`。
 * 必须 `const { safeStorage } = require('electron')` 再传进来。
 * 传 undefined 会导致 isAvailable() 恒 false，进而所有密文被存成 NULL。
 *
 * @param {Object} safeStorage electron 的 safeStorage 模块
 */
export interface SafeStorageLike {
  isEncryptionAvailable?(): boolean
  getSelectedStorageBackend?(): string
  encryptString(value: string): Buffer
  decryptString(value: Buffer): string
}
export interface CryptoProvider {
  name: string
  isAvailable(): boolean
  isOsKeychain?(): boolean
  encrypt(plain: unknown): string | null
  decrypt(ciphertext: unknown): string | null
  reason?: string
}

function errorMessage(error: unknown): string {
  return error && typeof error === 'object' && 'message' in error
    ? String((error as { message: unknown }).message)
    : String(error)
}

export function createSafeStorageCrypto(safeStorage: SafeStorageLike | null | undefined): CryptoProvider {
  const isAvailable = () =>
    !!safeStorage &&
    typeof safeStorage.isEncryptionAvailable === 'function' &&
    safeStorage.isEncryptionAvailable() === true

  /**
   * 加密是否**真的**由操作系统钥匙串承担（可选能力，供 keychain 后端判定可用性）：
   *   Windows → DPAPI，macOS → Keychain：`isEncryptionAvailable()` 为真即成立；
   *   Linux   → 可能是 `basic_text`（未配置 keyring 时的**明文混淆**回退），
   *             必须显式排除 —— 否则「系统钥匙串」后端等于在骗用户。
   * `getSelectedStorageBackend()` 是 Linux 专有 API，未就绪时调用会抛错，故 try 包裹。
   */
  const isOsKeychain = () => {
    if (!safeStorage || !isAvailable()) return false
    try {
      if (typeof safeStorage.getSelectedStorageBackend === 'function') {
        return safeStorage.getSelectedStorageBackend() !== 'basic_text'
      }
    } catch (_) {
      // 尚未 ready 等情形：保守返回 false，等下次判定
      return false
    }
    return true
  }

  return {
    name: 'safe-storage',

    isAvailable,
    isOsKeychain,

    encrypt(plain) {
      if (!safeStorage || !isAvailable()) return null
      if (typeof plain !== 'string') return null
      try {
        const buf = safeStorage.encryptString(plain)
        return buf && buf.toString ? buf.toString('base64') : null
      } catch (e) {
        console.error('[infra-secret] safeStorage.encryptString 失败:', errorMessage(e))
        return null
      }
    },

    decrypt(b64) {
      if (!safeStorage || !isAvailable()) return null
      if (typeof b64 !== 'string' || !b64) return null
      try {
        return safeStorage.decryptString(Buffer.from(b64, 'base64'))
      } catch (e) {
        // 典型原因：换 Windows 用户/重装系统后 DPAPI 密钥不匹配、数据被外部改写
        console.error(
          '[infra-secret] safeStorage.decryptString 失败（密钥不匹配或数据损坏）:',
          errorMessage(e)
        )
        return null
      }
    }
  }
}

/**
 * 显式不可用的 provider。
 * 用于 DI 缺失时让问题**立刻暴露**（保存会被拒绝并报错），
 * 而不是像以前那样静默把密文存成 NULL。
 */
export function createUnavailableCrypto(reason?: string): CryptoProvider {
  return {
    name: 'unavailable',
    isAvailable: () => false,
    encrypt: () => null,
    decrypt: () => null,
    reason: reason || '未提供加密 provider'
  }
}

export default { createSafeStorageCrypto, createUnavailableCrypto }
