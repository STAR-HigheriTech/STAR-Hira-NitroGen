/**
 * Secure DNS / DNS-over-HTTPS 的唯一规则源。
 *
 * 设置页、默认值和主进程 applier 都从这里读取模式、服务商与 URL 校验规则。
 * DoH 只加密域名解析，不等同于 VPN，也不会隐藏最终建立连接的网站。
 */

export const SECURE_DNS_SETTING_KEYS = Object.freeze({
  mode: 'network.secure_dns_mode',
  provider: 'network.secure_dns_provider',
  custom: 'network.secure_dns_custom'
})

export const SECURE_DNS_MODES = Object.freeze({
  off: 'off',
  automatic: 'automatic',
  secure: 'secure'
})

export const SECURE_DNS_MODE_OPTIONS = Object.freeze([
  ['off', '关闭 DoH（使用系统 DNS）'],
  ['automatic', '自动（优先 DoH，失败时回退）'],
  ['secure', '仅安全 DNS（禁止明文回退）']
])

export const SECURE_DNS_PROVIDERS = Object.freeze({
  system: [],
  cloudflare: ['https://cloudflare-dns.com/dns-query'],
  google: ['https://dns.google/dns-query'],
  quad9: ['https://dns.quad9.net/dns-query'],
  adguard: ['https://dns.adguard-dns.com/dns-query']
})

export const SECURE_DNS_PROVIDER_OPTIONS = Object.freeze([
  ['system', '跟随系统 / 运营商'],
  ['cloudflare', 'Cloudflare 1.1.1.1'],
  ['google', 'Google Public DNS'],
  ['quad9', 'Quad9（安全过滤）'],
  ['adguard', 'AdGuard DNS'],
  ['custom', '自定义 DoH 地址']
])

export const DEFAULT_SECURE_DNS_SETTINGS = Object.freeze({
  [SECURE_DNS_SETTING_KEYS.mode]: SECURE_DNS_MODES.automatic,
  [SECURE_DNS_SETTING_KEYS.provider]: 'system',
  [SECURE_DNS_SETTING_KEYS.custom]: ''
})

export interface SecureDnsConfig {
  secureDnsMode: 'off' | 'automatic' | 'secure'
  secureDnsServers: string[]
  enableBuiltInResolver: boolean
  enableAdditionalDnsQueryTypes: boolean
}

function normalizeMode(value: unknown): 'off' | 'automatic' | 'secure' {
  const mode = String(value || '').trim()
  return mode === 'off' || mode === 'secure' ? mode : 'automatic'
}

function customServers(raw: unknown): string[] {
  const seen = new Set<string>()
  const out: string[] = []
  for (const item of String(raw || '').split(/[\s,;]+/)) {
    const value = item.trim()
    if (!value || seen.has(value)) continue
    try {
      const url = new URL(value)
      if (url.protocol !== 'https:' || url.username || url.password) continue
      const normalized = url.toString()
      if (seen.has(normalized)) continue
      seen.add(normalized)
      out.push(normalized)
    } catch {
      continue
    }
    if (out.length >= 4) break
  }
  return out
}

export function secureDnsConfigFromSettings(get: (key: string) => unknown): SecureDnsConfig {
  const mode = normalizeMode(get(SECURE_DNS_SETTING_KEYS.mode))
  const provider = String(get(SECURE_DNS_SETTING_KEYS.provider) || 'system').trim().toLowerCase()
  const custom = customServers(get(SECURE_DNS_SETTING_KEYS.custom))
  const preset = SECURE_DNS_PROVIDERS[provider as keyof typeof SECURE_DNS_PROVIDERS]
  const servers = provider === 'custom'
    ? custom
    : Array.isArray(preset) ? [...preset] : []
  return {
    secureDnsMode: mode,
    secureDnsServers: servers,
    // 未选择明确服务商时保持 Chromium 的默认解析路径；只有我们真正下发了 DoH
    // 服务列表，才启用内建解析器接管解析。
    enableBuiltInResolver: mode !== 'off' && servers.length > 0,
    enableAdditionalDnsQueryTypes: true
  }
}
