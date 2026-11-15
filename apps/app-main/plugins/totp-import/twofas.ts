/**
 * 2FAS 导出：`{ schemaVersion, services: [{ name, secret, otp: { label, account, issuer, digits, period, algorithm, tokenType, counter } }] }`
 *
 * 判别式认 `services` 数组里**同时**有 `secret` 或 `otp` 的项 ——
 * 只认字段名 `services` 太松（别的 App 也可能用它）。
 */

import { makeJsonAdapter, asArray, str } from './json-adapter.js'

export const twofasAdapter = makeJsonAdapter({
  id: '2fas',
  label: '2FAS 导出',

  match(json) {
    const services = asArray(json.services)
    if (!services.length) return false
    return services.some((raw: unknown) => {
      const service = raw && typeof raw === 'object' ? raw as Record<string, unknown> : null
      return typeof service?.secret === 'string' || !!(service?.otp && typeof service.otp === 'object')
    })
  },

  pick(json) {
    const warnings: string[] = []
    const entries = asArray(json.services).map((raw: unknown) => {
      const s = raw && typeof raw === 'object' ? raw as Record<string, unknown> : {}
      const otp = s.otp && typeof s.otp === 'object' ? s.otp as Record<string, unknown> : {}
      const tokenType = str(otp.tokenType, 'TOTP').toUpperCase()
      return {
        type: tokenType === 'HOTP' ? 'HOTP' : 'TOTP',
        // 2FAS 把服务名放 name，账号可以放 otp.account / otp.label
        issuer: str(s.name, otp.issuer),
        account: str(otp.account, otp.label, otp.issuer, s.name),
        secret: str(s.secret),
        algorithm: str(otp.algorithm, 'SHA1').toUpperCase(),
        digits: Number(otp.digits) || 6,
        period: Number(otp.period) || 30,
        counter: Number(otp.counter) || 0
      }
    })
    if (!entries.length) warnings.push('文件里没有条目')
    return { entries, warnings }
  }
})
