import { errorMessage } from './types'
import type { ApplierDependencies, SettingsApplier } from './types'

const {
  SECURE_DNS_SETTING_KEYS,
  secureDnsConfigFromSettings
} = require('@hira-ng/shared-types/src/secure-dns.mjs') as {
  SECURE_DNS_SETTING_KEYS: { mode: string; provider: string; custom: string }
  secureDnsConfigFromSettings(get: (key: string) => unknown): {
    secureDnsMode: 'off' | 'automatic' | 'secure'
    secureDnsServers: string[]
    enableBuiltInResolver: boolean
    enableAdditionalDnsQueryTypes: boolean
  }
}

/**
 * Chromium 主机解析器的唯一生效点。
 *
 * `configureHostResolver` 是应用级 API，切换后会影响之后的所有解析；因此这些键
 * 在 settings-scope 中登记为全局。相同配置直接跳过，避免设置页回放默认值时
 * 无意义地扰动网络栈。
 */
function createSecureDnsApplier(deps: ApplierDependencies = {}): SettingsApplier {
  const configure = typeof deps.configureHostResolver === 'function'
    ? deps.configureHostResolver
    : null
  let lastFingerprint = ''

  return {
    id: 'network-secure-dns',
    keys: [
      SECURE_DNS_SETTING_KEYS.mode,
      SECURE_DNS_SETTING_KEYS.provider,
      SECURE_DNS_SETTING_KEYS.custom
    ],
    apply({ settings, force }) {
      if (!configure || !settings || typeof settings.get !== 'function') return false
      const config = secureDnsConfigFromSettings((key) => settings.get(key))
      const fingerprint = JSON.stringify(config)
      if (!force && fingerprint === lastFingerprint) return true
      lastFingerprint = fingerprint
      try {
        configure(config)
        return true
      } catch (error) {
        console.warn('[secure-dns] configureHostResolver failed:', errorMessage(error))
        lastFingerprint = ''
        return false
      }
    }
  }
}

export { createSecureDnsApplier }
