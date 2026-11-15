/**
 * 1Password 导出。
 *
 * 两种现实路径，这里覆盖**两者**，但用不同的手段：
 *
 * ① **1PUX 解压后的 `export.data`**（一个 JSON）——
 *    1PUX 是个 zip 包，解压后里面 `export.data` 才是 JSON。渲染层不引解压库
 *    （那是"为了一件事背一整个 zip 实现"，而且用户完全能自己解压一个 zip）。
 *    结构：`{ accounts: [{ vaults: [{ items: [...] }] }] }`。
 *
 * ② **单条复制的「拷贝一次性密码链接」** —— 1Password 支持把某一条的 OTP
 *    复制成 `otpauth://` 链接，那条走通用兜底适配器，不需要这里。
 *
 * ⚠ 为什么不硬编字段路径：1PUX 里 OTP 落在 `details.sections[].fields[]`，
 * 而字段结构随版本变过（有的版本 `type: 'OTP'`，有的放在 `value` 里）。
 * 用**深度遍历找链接**对版本变化免疫 —— 而硬编路径的结果是"下个版本就认不出来"。
 *
 * ⚠ 顺带说明一个常见误区：1Password 的 **CSV** 导出**不含** TOTP 密钥，
 * 所以这里不认 CSV。CSV 用户只能逐条复制 OTP 链接（走通用兜底）。
 */

import { makeJsonAdapter, asArray } from './json-adapter.js'
import { collectOtpauthUris } from './otpauth-uri.js'

export const onePasswordAdapter = makeJsonAdapter({
  id: 'onepassword',
  label: '1Password 1PUX 导出（解压后的 export.data）',

  match(json) {
    // `accounts[].vaults[]` 是 1PUX 特有的两层嵌套
    const accounts = asArray(json.accounts)
    if (!accounts.length) return false
    return accounts.some((raw: unknown) => {
      const account = raw && typeof raw === 'object' ? raw as Record<string, unknown> : null
      return !!account && Array.isArray(account.vaults)
    })
  },

  pick(json) {
    const uris = collectOtpauthUris(json)
    if (!uris.length) {
      return {
        ok: false,
        reason: '这个 1PUX 里没有找到 TOTP 条目（1Password 的 CSV 导出不含一次性密码，请改用 1PUX 解压后的 export.data，或逐条复制「拷贝一次性密码链接」）'
      }
    }
    // 条目名由链接自己带着（label 里就是 issuer:account），不需要另外配对 ——
    // 靠遍历顺序去猜"这个字段名属于上一条链接"是不可靠的
    return { uris, warnings: [] }
  }
})
