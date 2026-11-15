/**
 * Bitwarden 导出（`.json`）：`{ encrypted: false, folders: [...], items: [{ name, login: { username, totp } }] }`
 *
 * Bitwarden 存的是**已经拼好的 `otpauth://` 链接**（不是裸密钥），所以这里
 * **原样透传**，不拆开再用我们的规则重拼 —— 重拼会在编码细节上引入偏差，
 * 而透传是零风险的（那个链接本身就是别的 App 认的格式）。
 */

import { makeJsonAdapter, asArray, str } from './json-adapter.js'

export const bitwardenAdapter = makeJsonAdapter({
  id: 'bitwarden',
  label: 'Bitwarden 导出',

  match(json) {
    // `encrypted: boolean` + `items` 是 Bitwarden 导出的稳定特征
    return typeof json.encrypted === 'boolean' && Array.isArray(json.items)
  },

  pick(json) {
    if (json.encrypted === true) {
      return {
        ok: false,
        reason: '这是 Bitwarden 的加密导出，本版本还不支持解密。请用「导出 → .json（未加密）」再导入'
      }
    }
    const warnings: string[] = []
    const uris: string[] = []
    let total = 0
    for (const raw of asArray(json.items)) {
      total++
      const item = raw && typeof raw === 'object' ? raw as Record<string, unknown> : null
      const login = item?.login && typeof item.login === 'object' ? item.login as Record<string, unknown> : null
      const totp = login ? str(login.totp) : ''
      // 只挑真正是 otpauth 链接的：Bitwarden 也允许在 totp 字段里放别的
      // （比如一个纯 secret 字符串），那种我们不吃 —— 猜错会造出一条永远算不对的条目
      if (totp && /^otpauth:\/\//i.test(totp)) uris.push(totp)
    }
    if (!uris.length) {
      return { ok: false, reason: `文件里 ${total} 个条目都没有两步验证链接（Bitwarden 只导出带 TOTP 的那些）` }
    }
    return { uris, warnings }
  }
})
