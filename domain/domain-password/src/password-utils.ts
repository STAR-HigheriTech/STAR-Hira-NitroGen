import type { PasswordStrength } from './types'

export type PasswordClass = 'upper' | 'lower' | 'digit' | 'symbol'
export type PasswordIssueKind = 'empty' | 'common' | 'weak'

export function domainOf(hostname: unknown): string {
  if (typeof hostname !== 'string') return ''
  let value = hostname.replace(/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//, '')
  value = value.split(/[/:?#]/, 1)[0]
  if (!/^[a-zA-Z0-9.-]+$/.test(value)) return ''
  value = value.toLowerCase().replace(/^www\./, '').replace(/^\.+|\.+$/g, '')
  if (!value || !value.includes('.') || value.includes('..')) return ''
  return value
}

export function canonicalDomain(value: unknown): string {
  const raw = String(value ?? '').trim()
  if (!raw) return ''
  return domainOf(raw) || raw.toLowerCase()
}

export function passwordStrength(password: unknown): PasswordStrength {
  if (typeof password !== 'string' || password.length === 0) {
    return { score: 0, label: '极弱' }
  }
  let score = password.length >= 8 ? 1 : 0
  if (/[a-z]/.test(password) && /[A-Z]/.test(password)) score += 1
  if (/\d/.test(password)) score += 1
  if (/[^a-zA-Z0-9]/.test(password)) score += 1
  const labels = ['极弱', '弱', '中', '强', '极强'] as const
  return { score, label: labels[score] }
}

export function hasClass(password: unknown, characterClass: PasswordClass | string): boolean {
  if (typeof password !== 'string') return false
  switch (characterClass) {
    case 'upper': return /[A-Z]/.test(password)
    case 'lower': return /[a-z]/.test(password)
    case 'digit': return /\d/.test(password)
    case 'symbol': return /[^a-zA-Z0-9]/.test(password)
    default: return false
  }
}

export function isWeakPassword(password: unknown): boolean {
  return passwordStrength(password).score <= 1
}

export function normalizeUsername(username: unknown): string {
  if (typeof username !== 'string') return ''
  return username.trim().replace(/^@+/, '').toLowerCase()
}

export function sortCredentialsByRecency<T extends { lastUsedAt?: number | null }>(list: readonly T[]): T[] {
  return Array.from(list).sort((left, right) => {
    const leftTime = typeof left.lastUsedAt === 'number' ? left.lastUsedAt : 0
    const rightTime = typeof right.lastUsedAt === 'number' ? right.lastUsedAt : 0
    return rightTime - leftTime
  })
}

export function filterMatchingCredentials<T extends { domain?: string }>(
  list: readonly T[],
  hostname: unknown
): T[] {
  const target = domainOf(hostname)
  if (!target) return []
  return list.filter((credential) => {
    const stored = canonicalDomain(credential.domain)
    return Boolean(stored) && (stored === target || target.endsWith(`.${stored}`))
  })
}

export function mergeSuggestions<T extends { username?: string; manager?: string }>(
  builtin: readonly T[] | null | undefined,
  managers: readonly (T | readonly T[])[] | null | undefined
): T[] {
  const seen = new Set<string>()
  const result: T[] = []
  const managerRows = (managers || []).flatMap((entry) => Array.isArray(entry) ? entry : [entry]) as T[]
  for (const row of [...(builtin || []), ...managerRows]) {
    if (!row) continue
    const key = normalizeUsername(row.username)
    if (!key) continue
    if (seen.has(key)) continue
    seen.add(key)
    result.push(row)
  }
  return result
}

export function maskPassword(password: unknown, keepLength = 0): string {
  if (typeof password !== 'string') return ''
  const safeKeep = typeof keepLength === 'number' && keepLength >= 0 ? keepLength : 0
  return password.slice(0, safeKeep) + '*'.repeat(Math.max(0, password.length - safeKeep))
}

export function matchesNeverSave(domains: readonly unknown[], hostname: unknown): boolean {
  const target = domainOf(hostname)
  if (!target) return false
  return domains.some((value) => {
    if (typeof value !== 'string') return false
    const domain = value.toLowerCase().replace(/\.+$/, '')
    return Boolean(domain) && (domain === target || target.endsWith(`.${domain}`))
  })
}

export function domainLevelDomains(domain: unknown): string[] {
  if (typeof domain !== 'string') return []
  const normalized = domain.trim().replace(/\.$/, '').toLowerCase()
  const parts = normalized.split('.')
  if (parts.length < 2 || parts.some((part) => !part)) return []
  return parts.map((_, index) => parts.slice(index).join('.'))
}

export function buildUpsertKey(domain: unknown, username: unknown): string {
  return `${String(domain || '')}|${normalizeUsername(username)}`
}

export const COMMON_PASSWORDS = Object.freeze([
  '123456', '123456789', '12345678', 'password', 'qwerty', '12345', '123123', '1234567890',
  '111111', 'abc123', '1234', 'password1', 'iloveyou', 'admin', 'welcome', 'monkey',
  'login', 'princess', 'solo', 'starwars', 'dragon', 'passw0rd', 'master', 'hello',
  'freedom', 'whatever', 'qazwsx', 'trustno1', 'letmein', 'football', 'baseball', 'shadow',
  'superman', 'michael', 'sunshine', 'qwerty123', '1q2w3e4r', 'zaq12wsx', '666666', '888888',
  'a123456', '123456a', 'woaini1314', '5201314', 'asdfgh', 'zxcvbnm', '1qaz2wsx', 'aa123456'
] as const)

export function passwordIssues(password: unknown): PasswordIssueKind[] {
  if (typeof password !== 'string' || password.length === 0) return ['empty']
  const issues: PasswordIssueKind[] = []
  if (COMMON_PASSWORDS.includes(password.toLowerCase() as (typeof COMMON_PASSWORDS)[number])) {
    issues.push('common')
  }
  if (isWeakPassword(password)) issues.push('weak')
  return issues
}
