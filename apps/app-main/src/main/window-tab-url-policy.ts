/**
 * 窗口运行单元使用的标签 URL 判据。
 *
 * 只处理地址等价、内置新标签页识别和扩展页图标兜底；不持有窗口或标签状态。
 */
const { extensionIdOfUrl } = require('@hira-ng/domain-extension')
const { HIRA_SCHEME } = require('./hira-protocol')
const { extensionIconUrl } = require('@hira-ng/shared-types/src/extension-icon.mjs')

interface ExtensionServicePort {
  profileId?: string
  getManifest?: (extensionId: string) => { version?: string } | null
}

export function isSameAddress(a: unknown, b: unknown): boolean {
  const normalize = (url: unknown) => String(url || '').trim().toLowerCase().replace(/\/+$/, '')
  const left = normalize(a)
  const right = normalize(b)
  return left !== '' && left === right
}

export function extensionPageIconUrl(
  getExtensionService: (profileId?: string) => ExtensionServicePort | null | undefined,
  pageUrl: string,
  profileId?: string
): string {
  const id = extensionIdOfUrl(pageUrl)
  if (!id) return ''
  let version = ''
  let resolvedProfileId = profileId || ''
  try {
    const service = typeof getExtensionService === 'function' ? getExtensionService(profileId) : null
    const manifest = service && typeof service.getManifest === 'function'
      ? service.getManifest(id)
      : null
    version = (manifest && manifest.version) || ''
    resolvedProfileId = resolvedProfileId || service?.profileId || ''
  } catch (_) {
    version = ''
  }
  return extensionIconUrl(id, version, resolvedProfileId)
}

export function isHiraNewTabUrl(url: unknown): boolean {
  const raw = String(url || '')
  if (!raw) return false
  try {
    const parsed = new URL(raw)
    return parsed.protocol === `${HIRA_SCHEME}:` && parsed.hostname.toLowerCase() === 'newtab'
  } catch (_) {
    return false
  }
}
