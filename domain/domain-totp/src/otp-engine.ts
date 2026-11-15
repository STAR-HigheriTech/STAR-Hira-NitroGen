import { createUnavailableCrypto } from '@hira-ng/infra-secret'
import { errorMessage, normalizeMetadata, normalizeSecret } from './totp-normalizers'
import type {
  OtpEngine,
  ParsedOtpUri,
  TotpCryptoProvider,
  TotpMetadata
} from './types'

interface OtpInstance {
  generate(options?: { timestamp: number }): string
  remaining(options?: { timestamp: number }): number
  toString(): string
}

interface OtpLibrary {
  HOTP: new (options: Record<string, unknown>) => OtpInstance
  TOTP: new (options: Record<string, unknown>) => OtpInstance
  Secret: { fromBase32(value: string): unknown }
  URI: {
    parse(value: string): {
      issuer: string
      label: string
      algorithm: string
      digits: number
      period: number
      counter?: number
      secret?: { base32?: string }
    }
  }
}

let loadedLibrary: OtpLibrary | null = null

function getLibrary(): OtpLibrary {
  loadedLibrary ??= require('otpauth') as OtpLibrary
  return loadedLibrary
}

export function createOtpEngine(provider?: TotpCryptoProvider): OtpEngine {
  const crypto = provider || createUnavailableCrypto('createTotpService 未收到 crypto provider')

  function isEncryptionAvailable(): boolean {
    try {
      return Boolean(crypto.isAvailable?.())
    } catch {
      return false
    }
  }

  function encryptionFailureReason(): string {
    if (!isEncryptionAvailable()) {
      return '系统加密不可用，无法安全保存密钥（' + (crypto.reason || '未提供加密 provider') + '）'
    }
    return '密钥加密失败，已放弃保存（不会写入明文）'
  }

  function build(metadata: TotpMetadata, secretBase32: string): OtpInstance {
    const { HOTP, TOTP, Secret } = getLibrary()
    const secret = Secret.fromBase32(secretBase32)
    const common = {
      issuer: metadata.issuer,
      label: metadata.account,
      algorithm: metadata.algorithm,
      digits: metadata.digits,
      secret
    }
    return metadata.type === 'HOTP'
      ? new HOTP({ ...common, counter: metadata.counter })
      : new TOTP({ ...common, period: metadata.period })
  }

  return {
    isEncryptionAvailable,
    encryptionFailureReason,

    encrypt(secret) {
      try {
        const cipher = crypto.encrypt(secret)
        return cipher || null
      } catch (error) {
        console.error('[totp-service] 加密密钥失败：', errorMessage(error))
        return null
      }
    },

    decrypt(cipher) {
      if (!cipher) return null
      try {
        const plain = crypto.decrypt(cipher)
        return plain ? normalizeSecret(plain) : null
      } catch {
        return null
      }
    },

    validate(metadata, secret) {
      try {
        build(metadata, secret)
        return true
      } catch {
        return false
      }
    },

    generate(row, secret, timestamp) {
      const otp = build(row, secret)
      if (row.type === 'HOTP') {
        return { code: otp.generate(), type: row.type, remaining: null, period: null }
      }
      return {
        code: otp.generate({ timestamp }),
        type: row.type,
        remaining: Math.max(0, Math.ceil(otp.remaining({ timestamp }) / 1000)),
        period: row.period
      }
    },

    exportUri(metadata, secret) {
      return build(metadata, secret).toString()
    },

    parseUri(uri): ParsedOtpUri {
      const lib = getLibrary()
      const parsed = lib.URI.parse(uri)
      const type = (parsed as { constructor: unknown }).constructor === lib.HOTP ? 'HOTP' : 'TOTP'
      return {
        metadata: normalizeMetadata({
          issuer: parsed.issuer,
          account: parsed.label,
          algorithm: parsed.algorithm,
          digits: parsed.digits,
          period: parsed.period,
          type,
          counter: parsed.counter
        }),
        secret: normalizeSecret(parsed.secret?.base32)
      }
    }
  }
}
