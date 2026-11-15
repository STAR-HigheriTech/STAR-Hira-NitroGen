export interface PasswordGenerationOptions {
  length?: number
  lowercase?: boolean
  uppercase?: boolean
  digits?: boolean
  symbols?: boolean
}

const MIN_LENGTH = 8
const MAX_LENGTH = 128
const CHARSETS = Object.freeze({
  lowercase: 'abcdefghijkmnopqrstuvwxyz',
  uppercase: 'ABCDEFGHJKLMNPQRSTUVWXYZ',
  digits: '23456789',
  symbols: '!@#$%^&*()-_=+[]{};:,.?'
})

function randomIndex(max: number, source: Crypto): number {
  if (!Number.isInteger(max) || max <= 0 || max > 0x1_0000_0000) {
    throw new RangeError('invalid random range')
  }
  const limit = Math.floor(0x1_0000_0000 / max) * max
  const view = new Uint32Array(1)
  do source.getRandomValues(view)
  while (view[0] >= limit)
  return view[0] % max
}

/** 生成满足所选字符类别的无偏随机密码；默认 20 位且四类字符均包含。 */
export function generatePassword(
  options: PasswordGenerationOptions = {},
  source: Crypto = globalThis.crypto
): string {
  if (!source || typeof source.getRandomValues !== 'function') {
    throw new Error('安全随机源不可用')
  }
  const requested = Number(options.length ?? 20)
  const length = Math.max(MIN_LENGTH, Math.min(MAX_LENGTH, Number.isFinite(requested) ? Math.trunc(requested) : 20))
  const selected = (['lowercase', 'uppercase', 'digits', 'symbols'] as const)
    .filter((key) => options[key] !== false)
  const pools = selected.map((key) => CHARSETS[key])
  if (pools.length === 0) throw new Error('至少需要启用一种字符类型')
  if (length < pools.length) throw new Error('密码长度不足以包含所选字符类型')

  const password = pools.map((pool) => pool[randomIndex(pool.length, source)])
  const all = pools.join('')
  while (password.length < length) password.push(all[randomIndex(all.length, source)])
  for (let index = password.length - 1; index > 0; index -= 1) {
    const target = randomIndex(index + 1, source)
    const value = password[index]
    password[index] = password[target]
    password[target] = value
  }
  return password.join('')
}
