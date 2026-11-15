import * as dns from 'node:dns'
import { isIP } from 'node:net'

export const DEFAULT_ALLOWED_PROTOCOLS = Object.freeze(['http:', 'https:'] as const)

const BLOCKED_SUFFIXES = Object.freeze([
  '.localhost', '.local', '.localdomain', '.internal', '.intranet', '.lan',
  '.home.arpa', '.corp', '.home', '.private', '.svc', '.test', '.invalid', '.example', '.alt'
])

const DEFAULT_MAX_URL_LENGTH = 16 * 1024
const DEFAULT_DNS_TIMEOUT_MS = 4_000
const DEFAULT_DNS_CACHE_TTL_MS = 30_000
const DEFAULT_DNS_CACHE_MAX_ENTRIES = 256

export type OutboundRejection =
  | 'unsupported-url'
  | 'url-too-long'
  | 'unsupported-scheme'
  | 'url-credentials'
  | 'invalid-port'
  | 'blocked-host'
  | 'dns-failed'

export type OutboundVerdict =
  | { ok: true; url: string; hostname: string; addresses: readonly string[] }
  | { ok: false; reason: OutboundRejection }

export type HostResolver = (hostname: string) => Promise<readonly string[]>

export interface NetworkGuardPolicy {
  /** 出站协议白名单，值必须带冒号，例如 `https:`。 */
  allowedProtocols?: readonly string[]
  maxUrlLength?: number
  allowCredentials?: boolean
  /** 仅用于明确受信任的本地服务；模型与网页可控地址不得开启。 */
  allowPrivateNetworks?: boolean
  /** 精确主机名白名单；命中后允许该主机使用私网地址。 */
  trustedHosts?: readonly string[]
  blockedSuffixes?: readonly string[]
  resolveHost?: HostResolver
  dnsTimeoutMs?: number
  dnsCacheTtlMs?: number
  dnsCacheMaxEntries?: number
}

export interface NetworkGuard {
  readonly allowedProtocols: ReadonlySet<string>
  assertSafeUrl(input: unknown): Promise<OutboundVerdict>
  isBlockedHost(hostname: unknown): boolean
}

interface ResolveHostEndpointLike { address?: unknown }
interface ResolveHostResultLike { endpoints?: readonly ResolveHostEndpointLike[] }
export interface ChromiumHostResolverApi {
  resolveHost(host: string, options?: {
    queryType?: 'A' | 'AAAA'
    source?: 'any' | 'system' | 'dns' | 'mdns' | 'localOnly'
    cacheUsage?: 'allowed' | 'staleAllowed' | 'disallowed'
    secureDnsPolicy?: 'allow' | 'disable'
  }): Promise<ResolveHostResultLike>
}

export function normalizeHostname(input: unknown): string {
  return String(input ?? '')
    .trim()
    .toLowerCase()
    .replace(/^\[|\]$/g, '')
    .replace(/\.$/, '')
}

function parseIpv4(host: string): [number, number, number, number] | null {
  const match = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host)
  if (!match) return null
  const parts = match.slice(1).map(Number)
  if (parts.some((part) => part > 255)) return null
  return parts as [number, number, number, number]
}

/** IPv4 公网可达性判定；非公网、保留、文档与组播段全部拦截。 */
export function blockedIpv4(host: string): boolean {
  const match = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(String(host))
  if (!match) return false
  const parts = match.slice(1).map(Number)
  if (parts.some((part) => part > 255)) return true
  const [a, b, c] = parts
  if (a === 0 || a === 10 || a === 127) return true
  if (a === 100 && b >= 64 && b <= 127) return true
  if (a === 169 && b === 254) return true
  if (a === 172 && b >= 16 && b <= 31) return true
  if (a === 192 && b === 168) return true
  if (a === 192 && b === 0 && c === 0) return true
  if (a === 192 && b === 0 && c === 2) return true
  if (a === 192 && b === 88 && c === 99) return true
  if (a === 198 && (b === 18 || b === 19)) return true
  if (a === 198 && b === 51 && c === 100) return true
  if (a === 203 && b === 0 && c === 113) return true
  return a >= 224
}

function parseIpv6(host: string): number[] | null {
  let value = String(host).split('%')[0].toLowerCase()
  const lastColon = value.lastIndexOf(':')
  if (lastColon >= 0 && value.slice(lastColon + 1).includes('.')) {
    const ipv4 = parseIpv4(value.slice(lastColon + 1))
    if (!ipv4) return null
    value = value.slice(0, lastColon + 1) +
      `${((ipv4[0] << 8) | ipv4[1]).toString(16)}:${((ipv4[2] << 8) | ipv4[3]).toString(16)}`
  }
  const halves = value.split('::')
  if (halves.length > 2) return null
  const left = halves[0] ? halves[0].split(':') : []
  const right = halves.length === 2 && halves[1] ? halves[1].split(':') : []
  if ([...left, ...right].some((part) => !/^[0-9a-f]{1,4}$/i.test(part))) return null
  const missing = 8 - left.length - right.length
  if (halves.length === 2) {
    if (missing < 1) return null
  } else if (left.length !== 8) {
    return null
  }
  const groups = halves.length === 2
    ? [...left, ...Array<string>(missing).fill('0'), ...right]
    : left
  return groups.map((part) => Number.parseInt(part, 16))
}

/** IPv6 中会落向本机、私网、过渡隧道或不可路由空间的地址段。 */
export function blockedIpv6(host: string): boolean {
  const normalized = normalizeHostname(host).split('%')[0]
  if (isIP(normalized) !== 6) return false
  const groups = parseIpv6(normalized)
  if (!groups) return true
  const [a, b, c] = groups
  const zeros = (from: number, to: number): boolean => groups.slice(from, to).every((part) => part === 0)
  const embeddedIpv4 = [groups[6] >> 8, groups[6] & 0xff, groups[7] >> 8, groups[7] & 0xff].join('.')

  if (groups.every((part) => part === 0)) return true
  if (zeros(0, 7) && groups[7] === 1) return true
  // IPv4-compatible / mapped，包括 `::ffff:127.0.0.1` 与十六进制写法。
  if (zeros(0, 6)) return true
  if (zeros(0, 5) && groups[5] === 0xffff) return blockedIpv4(embeddedIpv4)
  // NAT64、本地 NAT64、discard-only。
  if (a === 0x64 && b === 0xff9b && zeros(2, 6)) return blockedIpv4(embeddedIpv4)
  if (a === 0x64 && b === 0xff9b && c === 1) return true
  if (a === 0x100 && zeros(1, 4)) return true

  if (a === 0x2001) {
    if (b === 0 || b === 2 || b === 3) return true
    if (b === 4 && c === 0x112) return true
    if ((b >= 0x10 && b <= 0x1f) || (b >= 0x20 && b <= 0x2f)) return true
    if (b === 0xdb8) return true
  }
  if (a === 0x2002) return true
  if (a === 0x3fff && (b & 0xf000) === 0) return true
  if (a === 0x5f00) return true
  if (a === 0x2620 && b === 0x4f && c === 0x8000) return true
  if ((a & 0xfe00) === 0xfc00) return true
  if ((a & 0xffc0) === 0xfe80 || (a & 0xffc0) === 0xfec0) return true
  return (a & 0xff00) === 0xff00
}

export function isBlockedAddress(address: unknown): boolean {
  const value = normalizeHostname(address)
  const family = isIP(value)
  if (family === 4) return blockedIpv4(value)
  if (family === 6) return blockedIpv6(value)
  return true
}

function isBlockedLiteralHost(host: string): boolean {
  const family = isIP(host)
  if (family === 4) return blockedIpv4(host)
  if (family === 6) return blockedIpv6(host)
  return false
}

function hasBlockedSuffix(host: string, suffixes: readonly string[]): boolean {
  return suffixes.some((suffix) => host === suffix.slice(1) || host.endsWith(suffix))
}

/** 不触发 DNS 的主机名判定；最终出站仍需用 `assertSafeUrl` 校验解析结果。 */
export function isBlockedHost(hostname: unknown): boolean {
  const host = normalizeHostname(hostname)
  if (!host) return true
  if (host === 'localhost' || host.endsWith('.localhost')) return true
  if (hasBlockedSuffix(host, BLOCKED_SUFFIXES)) return true
  if (isIP(host) !== 0) return isBlockedLiteralHost(host)
  return !host.includes('.')
}

function withTimeout<T>(task: Promise<T>, timeoutMs: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('dns-timeout')), Math.max(1, timeoutMs))
    timer.unref?.()
    task.then(
      (value) => { clearTimeout(timer); resolve(value) },
      (error) => { clearTimeout(timer); reject(error) }
    )
  })
}

/** 纯 Node 默认解析器；Electron 调用方应优先注入 `createChromiumHostResolver`。 */
export async function resolveHostWithNodeDns(hostname: string): Promise<readonly string[]> {
  const settled = await Promise.allSettled([
    dns.promises.resolve4(hostname),
    dns.promises.resolve6(hostname)
  ])
  const addresses = settled.flatMap((result) => result.status === 'fulfilled' ? result.value : [])
  if (addresses.length) return [...new Set(addresses)]
  const failure = settled.find((result) => result.status === 'rejected')
  throw failure && failure.status === 'rejected' ? failure.reason : new Error('dns-empty')
}

/**
 * 使用 Chromium 自己的解析器核对地址。结果会进入它的 DNS 缓存，随后 `net.fetch`
 * 立即请求时尽量复用同一批记录，比另起一套 Node DNS 更接近真实连接路径。
 * 平台未暴露“连接时钉住 IP”，因此这能收窄 DNS rebinding 窗口，但不能宣称彻底免疫。
 */
export function createChromiumHostResolver(api: ChromiumHostResolverApi): HostResolver {
  return async (hostname: string): Promise<readonly string[]> => {
    const settled = await Promise.allSettled((['A', 'AAAA'] as const).map((queryType) => (
      api.resolveHost(hostname, {
        queryType,
        source: 'any',
        cacheUsage: 'allowed',
        secureDnsPolicy: 'allow'
      })
    )))
    const addresses: string[] = []
    for (const result of settled) {
      if (result.status !== 'fulfilled') continue
      for (const endpoint of result.value.endpoints || []) {
        const address = String(endpoint.address || '').trim()
        if (address) addresses.push(address)
      }
    }
    if (addresses.length) return [...new Set(addresses)]
    const failure = settled.find((result) => result.status === 'rejected')
    throw failure && failure.status === 'rejected' ? failure.reason : new Error('dns-empty')
  }
}

function normalizeProtocols(protocols: readonly string[]): ReadonlySet<string> {
  const result = new Set<string>()
  for (const protocol of protocols) {
    const value = String(protocol || '').trim().toLowerCase()
    if (/^[a-z][a-z0-9+.-]*:$/.test(value)) result.add(value)
  }
  return result
}

/**
 * 创建一个有界 DNS 缓存 + 并发去重的出站地址守卫。
 * 主机字面量不联网解析；失败关闭，绝不把“解析失败”当作公网放行。
 */
export function createNetworkGuard(policy: NetworkGuardPolicy = {}): NetworkGuard {
  const allowedProtocols = normalizeProtocols(policy.allowedProtocols || DEFAULT_ALLOWED_PROTOCOLS)
  const trustedHosts = new Set((policy.trustedHosts || []).map(normalizeHostname))
  const blockedSuffixes = [...BLOCKED_SUFFIXES, ...(policy.blockedSuffixes || []).map((suffix) => {
    const value = String(suffix || '').trim().toLowerCase()
    return value && !value.startsWith('.') ? `.${value}` : value
  })].filter(Boolean)
  const maxUrlLength = Math.max(1, Math.floor(policy.maxUrlLength ?? DEFAULT_MAX_URL_LENGTH))
  const dnsTimeoutMs = Math.max(1, Math.floor(policy.dnsTimeoutMs ?? DEFAULT_DNS_TIMEOUT_MS))
  const cacheTtlMs = Math.max(0, Math.floor(policy.dnsCacheTtlMs ?? DEFAULT_DNS_CACHE_TTL_MS))
  const cacheMaxEntries = Math.max(0, Math.floor(policy.dnsCacheMaxEntries ?? DEFAULT_DNS_CACHE_MAX_ENTRIES))
  const resolveHost = policy.resolveHost || resolveHostWithNodeDns
  const allowPrivateNetworks = policy.allowPrivateNetworks === true
  const allowCredentials = policy.allowCredentials === true
  const dnsCache = new Map<string, { expiresAt: number; addresses: readonly string[] }>()
  const dnsInflight = new Map<string, Promise<readonly string[]>>()

  function isTrusted(host: string): boolean {
    return trustedHosts.has(host)
  }

  function blockedHostname(host: string): boolean {
    if (!host) return true
    if (isTrusted(host) || allowPrivateNetworks) return false
    if (host === 'localhost' || host.endsWith('.localhost')) return true
    if (hasBlockedSuffix(host, blockedSuffixes)) return true
    if (isIP(host) !== 0) return isBlockedLiteralHost(host)
    return !host.includes('.')
  }

  function remember(host: string, addresses: readonly string[]): void {
    if (!cacheTtlMs || !cacheMaxEntries) return
    dnsCache.delete(host)
    dnsCache.set(host, { expiresAt: Date.now() + cacheTtlMs, addresses })
    while (dnsCache.size > cacheMaxEntries) {
      const oldest = dnsCache.keys().next()
      if (oldest.done) break
      dnsCache.delete(oldest.value)
    }
  }

  async function resolve(host: string): Promise<readonly string[]> {
    const cached = dnsCache.get(host)
    if (cached && cached.expiresAt > Date.now()) {
      dnsCache.delete(host)
      dnsCache.set(host, cached)
      return cached.addresses
    }
    if (cached) dnsCache.delete(host)

    let pending = dnsInflight.get(host)
    if (!pending) {
      pending = withTimeout(Promise.resolve().then(() => resolveHost(host)), dnsTimeoutMs)
      dnsInflight.set(host, pending)
      pending.then(
        (addresses) => remember(host, addresses),
        () => undefined
      ).finally(() => dnsInflight.delete(host))
    }
    return pending
  }

  async function assertSafeUrl(input: unknown): Promise<OutboundVerdict> {
    const raw = String(input ?? '').trim()
    if (!raw) return { ok: false, reason: 'unsupported-url' }
    if (raw.length > maxUrlLength) return { ok: false, reason: 'url-too-long' }

    let parsed: URL
    try {
      parsed = new URL(raw)
    } catch {
      return { ok: false, reason: 'unsupported-url' }
    }
    if (!allowedProtocols.has(parsed.protocol)) return { ok: false, reason: 'unsupported-scheme' }
    if (!allowCredentials && (parsed.username || parsed.password)) {
      return { ok: false, reason: 'url-credentials' }
    }
    if (parsed.port === '0') return { ok: false, reason: 'invalid-port' }

    const hostname = normalizeHostname(parsed.hostname)
    if (blockedHostname(hostname)) return { ok: false, reason: 'blocked-host' }
    if (isIP(hostname) !== 0 || isTrusted(hostname) || allowPrivateNetworks) {
      return { ok: true, url: parsed.href, hostname, addresses: isIP(hostname) === 0 ? [] : [hostname] }
    }

    let addresses: readonly string[]
    try {
      addresses = await resolve(hostname)
    } catch {
      return { ok: false, reason: 'dns-failed' }
    }
    const unique = [...new Set(addresses.map(normalizeHostname).filter(Boolean))]
    if (!unique.length || unique.some((address) => isBlockedAddress(address))) {
      return { ok: false, reason: 'blocked-host' }
    }
    return { ok: true, url: parsed.href, hostname, addresses: unique }
  }

  return {
    allowedProtocols,
    assertSafeUrl,
    isBlockedHost: blockedHostname
  }
}

const defaultGuard = createNetworkGuard()

export const assertSafeOutboundUrl = defaultGuard.assertSafeUrl
export const assertSafeUrl = defaultGuard.assertSafeUrl
export { defaultGuard as defaultNetworkGuard }
