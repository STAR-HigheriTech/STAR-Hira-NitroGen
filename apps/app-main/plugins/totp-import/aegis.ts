/**
 * Aegis Authenticator 导出。
 *
 * 明文形态：`{ version: 1, entries: [{ type, issuer, name, info: { secret, algo, digits, period } }] }`
 * 加密形态：`{ header: { slots: [...] }, db: "<base64>" }`
 *
 * ⚠ 加密形态**本版本不解**：它要 scrypt 派生 + AES-256-GCM 解密，而这两件事
 * 在渲染层做等于把用户的备份口令与解密逻辑放进 UI 进程；正确做法是放到主进程
 * 单独一期（见设计文档 §8）。所以这里**明确认出它并说清楚该怎么办**，
 * 而不是含糊地报"认不出这个格式"—— 后者会让用户反复重试同一个文件。
 */

import { makeJsonAdapter, asArray, str } from './json-adapter.js'

export const aegisAdapter = makeJsonAdapter({
  id: 'aegis',
  label: 'Aegis 导出',

  match(json) {
    if (Array.isArray(json.entries) && (json.entries.length === 0 || json.entries.some((raw: unknown) => {
      const entry = raw && typeof raw === 'object' ? raw as Record<string, unknown> : null
      const info = entry?.info && typeof entry.info === 'object' ? entry.info as Record<string, unknown> : null
      return typeof info?.secret === 'string'
    }))) {
      return true
    }
    // 加密备份：有 header.slots 与 db 字段，这个组合是 Aegis 特有的
    const header = json.header && typeof json.header === 'object' ? json.header as Record<string, unknown> : null
    return !!(header && Array.isArray(header.slots) && typeof json.db === 'string')
  },

  pick(json) {
    if (json.header && typeof json.db === 'string') {
      return {
        ok: false,
        reason: '这是 Aegis 的加密备份，本版本还不支持解密。请在 Aegis 里用「导出 → 明文 JSON」再导入'
      }
    }
    const warnings: string[] = []
    const entries = asArray(json.entries).map((raw: unknown) => {
      const e = raw && typeof raw === 'object' ? raw as Record<string, unknown> : {}
      const info = e.info && typeof e.info === 'object' ? e.info as Record<string, unknown> : {}
      return {
        type: str(e.type).toUpperCase() === 'HOTP' ? 'HOTP' : 'TOTP',
        issuer: str(e.issuer, e.name),
        account: str(e.name),
        secret: str(info.secret),
        algorithm: str(info.algo, 'SHA1').toUpperCase(),
        digits: Number(info.digits) || 6,
        period: Number(info.period) || 30,
        counter: Number(info.counter) || 0
      }
    })
    if (!entries.length) warnings.push('文件里没有条目')
    return { entries, warnings }
  }
})
