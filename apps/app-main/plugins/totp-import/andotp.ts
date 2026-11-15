/**
 * andOTP 导出：`{ tokens: [{ type, secret, issuer, label, digits, period, algorithm, counter }], tokenOrder: [...] }`
 *
 * `tokenOrder` 是它最独特的字段（顺序与条目分开存），所以判别式带上它 ——
 * 比"有 tokens 数组"可靠得多。
 */

import { makeJsonAdapter, asArray, str } from './json-adapter.js'

export const andotpAdapter = makeJsonAdapter({
  id: 'andotp',
  label: 'andOTP 导出',

  match(json) {
    const tokens = asArray(json.tokens)
    if (!tokens.length) return false
    // tokens 里必须真的有密钥 —— andOTP 的每条都以 secret 为核心字段
    return tokens.some((raw: unknown) => {
      const token = raw && typeof raw === 'object' ? raw as Record<string, unknown> : null
      return typeof token?.secret === 'string'
    })
  },

  pick(json) {
    const warnings: string[] = []
    const tokens = asArray(json.tokens)
    const entries = tokens.map((raw: unknown) => {
      const t = raw && typeof raw === 'object' ? raw as Record<string, unknown> : {}
      return {
      type: str(t.type, 'TOTP').toUpperCase() === 'HOTP' ? 'HOTP' : 'TOTP',
      issuer: str(t.issuer),
      // andOTP 的 label 就是账号；issuer 为空时 label 是唯一的可读名字
      account: str(t.label, t.issuer),
      secret: str(t.secret),
      algorithm: str(t.algorithm, 'SHA1').toUpperCase(),
      digits: Number(t.digits) || 6,
      period: Number(t.period) || 30,
      counter: Number(t.counter) || 0
      }
    })
    if (Array.isArray(json.tokenOrder) && json.tokenOrder.length !== tokens.length) {
      warnings.push('条目顺序信息与条目数不一致（不影响密钥本身）')
    }
    if (!entries.length) warnings.push('文件里没有条目')
    return { entries, warnings }
  }
})
