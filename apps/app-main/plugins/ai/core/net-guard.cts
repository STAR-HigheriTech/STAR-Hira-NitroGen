/**
 * AI 引擎的出站地址守卫适配层。
 *
 * 策略与 IP 分类真源在 `@hira-ng/infra-net-guard`，这里只接入 Electron 的
 * Chromium DNS 解析器：先校验地址，再让紧跟其后的 `net.request` 尽量复用同一批
 * 已缓存记录。DNS 解析失败会直接拒绝；重定向仍由抓取器逐跳重新调用本守卫。
 */

const { net } = require('electron') as {
  net?: import('@hira-ng/infra-net-guard').ChromiumHostResolverApi
}
const guardModule = require('@hira-ng/infra-net-guard') as typeof import('@hira-ng/infra-net-guard')
const resolveHost = net && typeof net.resolveHost === 'function'
  ? guardModule.createChromiumHostResolver(net)
  : guardModule.resolveHostWithNodeDns

const guard = guardModule.createNetworkGuard({
  resolveHost,
  dnsTimeoutMs: 3_000,
  dnsCacheTtlMs: 30_000,
  dnsCacheMaxEntries: 256
})

module.exports = {
  assertSafeUrl: guard.assertSafeUrl,
  assertSafeOutboundUrl: guard.assertSafeUrl,
  isBlockedHost: guard.isBlockedHost,
  blockedIpv4: guardModule.blockedIpv4,
  blockedIpv6: guardModule.blockedIpv6,
  isBlockedAddress: guardModule.isBlockedAddress,
  createNetworkGuard: guardModule.createNetworkGuard,
  createChromiumHostResolver: guardModule.createChromiumHostResolver,
  ALLOWED_PROTOCOLS: guard.allowedProtocols
}
