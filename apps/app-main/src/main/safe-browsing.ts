import { isIP } from 'node:net'
import { randomUUID } from 'node:crypto'
import { securityWarningUrl as buildSecurityWarningUrl } from '@hira-ng/shared-types/src/security-warning.mjs'

export type SafeBrowsingLevel = 'warning' | 'dangerous'

export interface SafeBrowsingProvider {
  id: string
  inspect(url: URL): { level: SafeBrowsingLevel; reason: string } | null
}

export interface SafeBrowsingMatch {
  level: SafeBrowsingLevel
  reason: string
  url: string
}

const ALLOW_TTL_MS = 30_000
const WARNING_TTL_MS = 5 * 60_000
const MAX_PENDING_WARNINGS = 256
const temporaryAllows = new Map<string, number>()
const issuedWarnings = new Map<string, { url: string; expiresAt: number }>()
const providers = new Set<SafeBrowsingProvider>()

const LOGIN_HINTS = /(?:login|signin|verify|account|secure|unlock|wallet|billing|support)/i

function normalizedHost(url: URL): string {
  return url.hostname.toLowerCase().replace(/\.$/, '')
}

function isLocalHost(host: string): boolean {
  return host === 'localhost' || host === '::1' || host === '[::1]' || host.endsWith('.localhost')
}

function isPrivateIpv4(host: string): boolean {
  const parts = host.split('.').map(Number)
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) return false
  return parts[0] === 10
    || parts[0] === 127
    || (parts[0] === 169 && parts[1] === 254)
    || (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31)
    || (parts[0] === 192 && parts[1] === 168)
}

function isPrivateIpv6(host: string): boolean {
  const raw = host.replace(/^\[|\]$/g, '').toLowerCase()
  if (raw === '::' || raw === '::1') return true
  const mappedIpv4 = raw.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/)
  if (mappedIpv4) return isPrivateIpv4(mappedIpv4[1])
  const first = Number.parseInt(raw.split(':')[0] || '0', 16)
  return Number.isFinite(first)
    && ((first & 0xfe00) === 0xfc00 || (first & 0xffc0) === 0xfe80)
}

function isPrivateIp(version: number, host: string): boolean {
  return version === 4 ? isPrivateIpv4(host) : version === 6 && isPrivateIpv6(host)
}

function allowKey(url: URL): string {
  return url.href
}

function rememberTemporaryAllow(url: URL, now: number): void {
  for (const [key, expiresAt] of temporaryAllows) {
    if (expiresAt <= now) temporaryAllows.delete(key)
  }
  while (temporaryAllows.size >= MAX_PENDING_WARNINGS) {
    const oldest = temporaryAllows.keys().next().value
    if (oldest === undefined) break
    temporaryAllows.delete(oldest)
  }
  temporaryAllows.set(allowKey(url), now + ALLOW_TTL_MS)
}

function localMatch(url: URL): SafeBrowsingMatch | null {
  const host = normalizedHost(url)
  if (isLocalHost(host)) return null

  if (url.username || url.password) {
    return {
      level: 'dangerous',
      reason: '网址内嵌了登录凭据，可能用于伪装或窃取账号',
      url: url.href
    }
  }

  const ipHost = host.replace(/^\[|\]$/g, '')
  const ipVersion = isIP(ipHost)
  if (ipVersion && !isPrivateIp(ipVersion, ipHost) && LOGIN_HINTS.test(`${url.pathname}${url.search}`)) {
    return {
      level: 'warning',
      reason: '页面要求登录或验证，但使用的是直接 IP 地址',
      url: url.href
    }
  }

  if (host.includes('xn--') && LOGIN_HINTS.test(`${host}${url.pathname}`)) {
    return {
      level: 'warning',
      reason: '国际化域名包含编码字符，且页面涉及账号操作',
      url: url.href
    }
  }

  return null
}

export function registerSafeBrowsingProvider(provider: SafeBrowsingProvider): () => void {
  if (!provider || typeof provider.id !== 'string' || typeof provider.inspect !== 'function') {
    return () => {}
  }
  providers.add(provider)
  return () => providers.delete(provider)
}

export function inspectSafeBrowsingUrl(rawUrl: unknown): SafeBrowsingMatch | null {
  let url: URL
  try {
    url = new URL(String(rawUrl || ''))
  } catch {
    return null
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return null

  const key = allowKey(url)
  const allowUntil = temporaryAllows.get(key) || 0
  if (allowUntil > Date.now()) return null
  if (allowUntil) temporaryAllows.delete(key)

  const local = localMatch(url)
  if (local) return local

  for (const provider of providers) {
    try {
      const match = provider.inspect(url)
      if (!match) continue
      return {
        level: match.level === 'dangerous' ? 'dangerous' : 'warning',
        reason: String(match.reason || '站点被安全服务标记'),
        url: url.href
      }
    } catch (error) {
      console.warn(`[safe-browsing] provider ${provider.id} failed:`, error instanceof Error ? error.message : error)
    }
  }
  return null
}

export function safeBrowsingWarningUrl(match: SafeBrowsingMatch | null, token = ''): string {
  if (!match) return ''
  return buildSecurityWarningUrl(match.url, match.reason, match.level, token)
}

function pruneIssuedWarnings(now: number): void {
  for (const [token, entry] of issuedWarnings) {
    if (entry.expiresAt > now) continue
    issuedWarnings.delete(token)
  }
  while (issuedWarnings.size >= MAX_PENDING_WARNINGS) {
    const oldest = issuedWarnings.keys().next().value
    if (oldest === undefined) break
    issuedWarnings.delete(oldest)
  }
}

export function issueSafeBrowsingWarning(rawUrl: unknown): string {
  const match = inspectSafeBrowsingUrl(rawUrl)
  if (!match) return ''
  const now = Date.now()
  pruneIssuedWarnings(now)
  const token = randomUUID()
  issuedWarnings.set(token, { url: match.url, expiresAt: now + WARNING_TTL_MS })
  return safeBrowsingWarningUrl(match, token)
}

export function consumeSafeBrowsingWarning(token: unknown, rawUrl: unknown): boolean {
  const key = String(token || '')
  if (!key) return false
  const issued = issuedWarnings.get(key)
  if (!issued) return false
  issuedWarnings.delete(key)
  if (issued.expiresAt <= Date.now()) return false

  let requested: URL
  try {
    requested = new URL(String(rawUrl || ''))
  } catch {
    return false
  }
  if (requested.href !== issued.url) return false
  rememberTemporaryAllow(requested, Date.now())
  return true
}
