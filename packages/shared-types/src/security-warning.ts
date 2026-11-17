/** 安全警告页地址的唯一构造 / 解析口径。 */

const SECURITY_WARNING_ORIGIN = 'hira://security-warning/'

export type SecurityWarningLevel = 'warning' | 'dangerous'

export function securityWarningUrl(
  targetUrl: unknown,
  reason: unknown,
  level: SecurityWarningLevel = 'warning',
  token: unknown = ''
): string {
  const params = new URLSearchParams({
    url: String(targetUrl || ''),
    reason: String(reason || ''),
    level: level === 'dangerous' ? 'dangerous' : 'warning'
  })
  const warningToken = String(token || '')
  if (warningToken) params.set('token', warningToken)
  return `${SECURITY_WARNING_ORIGIN}?${params.toString()}`
}

export function isSecurityWarningUrl(value: unknown): boolean {
  try {
    const url = new URL(String(value || ''))
    return url.protocol === 'hira:' && url.hostname === 'security-warning'
  } catch {
    return false
  }
}

export function targetUrlOfSecurityWarning(value: unknown): string {
  try {
    const url = new URL(String(value || ''))
    if (url.protocol !== 'hira:' || url.hostname !== 'security-warning') return ''
    return String(url.searchParams.get('url') || '')
  } catch {
    return ''
  }
}

export function tokenOfSecurityWarning(value: unknown): string {
  try {
    const url = new URL(String(value || ''))
    if (url.protocol !== 'hira:' || url.hostname !== 'security-warning') return ''
    return String(url.searchParams.get('token') || '')
  } catch {
    return ''
  }
}
