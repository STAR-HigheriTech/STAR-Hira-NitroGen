/**
 * 导入适配器的两个**纯工具**：字节 → base32、条目 → `otpauth://` URI。
 *
 * 为什么这两件事要单独成一个文件：**每个适配器都要用**。放在这里，
 * "URI 怎么拼"（尤其 label 的 `issuer:account` 编码规则）就只有一份实现 ——
 * 那是各家导出里最容易写错、错了又最难查的一处（拼错的 URI 主进程照样能解析，
 * 只是 issuer 与 account 对调了，用户看到的是一堆名字不对的条目）。
 */

const B32_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567'

/**
 * 原始字节 → Base32。
 *
 * **不带 `=` padding**：RFC 4648 要求 padding，但 Google Authenticator 与大多数
 * App 期望的是无 padding 的串（本仓库 domain 侧解析时也会先把 padding 去掉，
 * 这里是源头就不加）。
 *
 * @param {Uint8Array} bytes
 */
export function bytesToBase32(bytes: Uint8Array) {
  const data = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes || [])
  let bits = 0
  let value = 0
  let out = ''
  for (let i = 0; i < data.length; i++) {
    value = (value << 8) | data[i]
    bits += 8
    while (bits >= 5) {
      out += B32_ALPHABET[(value >>> (bits - 5)) & 31]
      bits -= 5
    }
  }
  if (bits > 0) out += B32_ALPHABET[(value << (5 - bits)) & 31]
  return out
}

/**
 * 一条归一化的条目 → `otpauth://` URI。
 *
 * label 必须是 `issuer:account`（两段各自编码），**不能**把整个 label 丢给
 * encodeURIComponent —— 那样 `:` 会变成 `%3A`，解析方就分不出哪段是 issuer，
 * 结果是把 issuer 当成账号名。
 *
 * 只写**非默认值**：SHA1 / 6 位 / 30 秒是各家的共同默认，写全反而给
 * "某些 App 忽略这些参数"留下踩坑面。
 *
 * @param {{ type?: string, issuer?: string, account?: string, secret: string,
 *           algorithm?: string, digits?: number, period?: number, counter?: number }} e
 */
export function buildOtpauthUri(e: { type?: string, issuer?: string, account?: string, secret: string,
          algorithm?: string, digits?: number, period?: number, counter?: number }) {
  const type = String(e.type || 'TOTP').toUpperCase() === 'HOTP' ? 'hotp' : 'totp'
  const issuer = String(e.issuer || '').trim()
  const account = String(e.account || '').trim()
  const label = issuer && account
    ? `${encodeURIComponent(issuer)}:${encodeURIComponent(account)}`
    : encodeURIComponent(account || issuer)

  const params = new URLSearchParams()
  params.set('secret', String(e.secret || '').trim().toUpperCase())
  if (issuer) params.set('issuer', issuer)
  const algorithm = String(e.algorithm || '').toUpperCase()
  if (algorithm && algorithm !== 'SHA1') params.set('algorithm', algorithm)
  const digits = Number(e.digits)
  if (Number.isFinite(digits) && digits > 0 && digits !== 6) params.set('digits', String(digits))
  if (type === 'hotp') {
    params.set('counter', String(Number(e.counter) || 0))
  } else {
    const period = Number(e.period)
    if (Number.isFinite(period) && period > 0 && period !== 30) params.set('period', String(period))
  }
  return `otpauth://${type}/${label}?${params.toString()}`
}

/**
 * 一批条目 → URI 列表，并把**缺密钥的**记成警告。
 *
 * 缺密钥的条目必须报出来而不是静默丢掉：各家导出里"有些条目本来就没有 2FA"是
 * 常态（比如 Bitwarden 的登录项多数没有 totp 字段），不报的话用户会以为导入漏了。
 *
 * @param {{ entries?: any[], warnings?: string[] }} picked
 * @returns {{ uris: string[], warnings: string[] }}
 */
export function entriesToUris(picked: { entries?: unknown[], warnings?: string[] }) : { uris: string[], warnings: string[] } {
  const entries = (picked && picked.entries) || []
  const warnings = ((picked && picked.warnings) || []).slice()
  const uris: string[] = []
  let skipped = 0
  for (const raw of entries) {
    const e = raw && typeof raw === 'object' ? raw as Record<string, unknown> : {}
    const secret = String(e.secret || '').replace(/[\s-]/g, '').toUpperCase()
    if (!secret) { skipped++; continue }
    uris.push(buildOtpauthUri({ ...e, secret }))
  }
  if (skipped) warnings.push(`${skipped} 条没有密钥（这些条目可能本来就没开两步验证），已跳过`)
  return { uris, warnings }
}
