/** Service-side composition bridge for loaded extension runtimes. */

import {
  collectPermissions,
  contentScriptTargets,
  extensionLabel,
  idOf,
  isManifestV3,
  isValidManifest,
  localeChainOf,
  localizedManifestText,
  manifestVersion,
  matchHostPattern,
  normalizedVersion,
  sortPermissions,
  translatePermissionNames,
  validateVersionString
} from './extensionUtil'
import type {
  ExtensionDiagnostic,
  ExtensionMeta,
  ExtensionMetaOptions,
  ExtensionRuntime,
  ExtensionRuntimeInfo,
  ExtensionRuntimeStatus,
  ExtensionSource,
  ExtensionWarning,
  ManifestLoadValidation
} from './types'

export const PERMISSION_ORDER = Object.freeze([
  'storage',
  'tabs',
  'notifications',
  'activeTab',
  'scripting',
  'bookmarks',
  'geolocation',
  'downloads'
])

export function validateManifestForLoad(manifest: unknown): ManifestLoadValidation {
  if (!isValidManifest(manifest)) return { ok: false, reason: 'invalid-manifest' }
  const version = manifestVersion(manifest)
  if (version === 0) return { ok: false, reason: 'invalid-manifest-version' }
  const rawVersion = manifest.version
  if (
    typeof rawVersion === 'string'
    && rawVersion.trim()
    && !validateVersionString(rawVersion)
    && normalizedVersion(rawVersion) === ''
  ) {
    return { ok: false, reason: 'invalid-version' }
  }
  return { ok: true, manifestVersion: version }
}

export function sourceOf(manifest: ExtensionRuntime['manifest']): ExtensionSource {
  return manifest && typeof manifest.update_url === 'string' && manifest.update_url ? 'store' : 'local'
}

export function storeUrlOf(manifest: ExtensionRuntime['manifest'], id: string): string {
  const homepage = manifest?.homepage_url
  if (typeof homepage === 'string' && homepage.trim()) return homepage.trim()
  const hasUpdateUrl = manifest && typeof manifest.update_url === 'string' && manifest.update_url
  return hasUpdateUrl && id ? `https://chrome.google.com/webstore/detail/${id}` : ''
}

export function buildExtensionMeta(ext: ExtensionRuntime | null | undefined, options: ExtensionMetaOptions = {}): ExtensionMeta {
  const manifest = ext?.manifest ?? null
  const order = Array.isArray(options.permissionOrder) ? options.permissionOrder : PERMISSION_ORDER
  const permissionNames = sortPermissions(collectPermissions(manifest), order)
  const id = ext?.id || idOf(manifest)
  const localeChain = localeChainOf(manifest?.default_locale, options.localeCandidates)
  const localizedName = localizedManifestText(manifest?.name, options.locales, localeChain)
  const localizedDescription = localizedManifestText(manifest?.description, options.locales, localeChain)

  return {
    id,
    name: extensionLabel({ name: localizedName }, options.fallbackName ?? ext?.name) || ext?.name || 'Unknown',
    description: localizedDescription,
    version: normalizedVersion(manifest?.version) || ext?.version || '',
    isUnpacked: !!manifest?._unpacked || !!ext?.path,
    isValid: isValidManifest(manifest),
    manifestVersion: manifestVersion(manifest),
    isV3: isManifestV3(manifest),
    source: sourceOf(manifest),
    storeUrl: storeUrlOf(manifest, id),
    permissionNames,
    permissions: translatePermissionNames(permissionNames),
    contentScripts: contentScriptTargets(manifest)
  }
}

export function matchesScriptTarget(manifest: unknown, url: string): boolean {
  return contentScriptTargets(manifest).some((pattern) => matchHostPattern(pattern, url))
}

export function deriveRuntimeStatus(ext: ExtensionRuntime | null | undefined): ExtensionRuntimeStatus {
  if (!ext) return 'missing'
  return ext.disabled ? 'disabled' : 'loaded'
}

export function buildExtensionDiagnostics(
  ext: ExtensionRuntime | null | undefined,
  meta: ExtensionMeta = buildExtensionMeta(ext)
): ExtensionDiagnostic[] {
  const diagnostics: ExtensionDiagnostic[] = []
  if (!ext) diagnostics.push({ code: 'missing', severity: 'error', message: '扩展未在当前运行时加载' })
  if (ext && !meta.isValid) {
    diagnostics.push({ code: 'invalid-manifest', severity: 'error', message: '扩展清单无效或不受支持' })
  }
  if (ext && !ext.path) {
    diagnostics.push({
      code: 'runtime-path-unavailable',
      severity: 'warning',
      message: '运行时未提供扩展路径，无法执行路径级重载'
    })
  }
  return diagnostics
}

export function buildExtensionWarnings(
  ext: ExtensionRuntime | null | undefined,
  meta: ExtensionMeta = buildExtensionMeta(ext)
): ExtensionWarning[] {
  if (!ext) return []
  return meta.permissions.map((message, index) => ({
    code: meta.permissionNames[index],
    severity: 'warning',
    message
  }))
}

export function buildExtensionRuntime(ext: ExtensionRuntime | null | undefined): ExtensionRuntimeInfo {
  const meta = buildExtensionMeta(ext)
  return {
    status: deriveRuntimeStatus(ext),
    diagnostics: buildExtensionDiagnostics(ext, meta),
    warnings: buildExtensionWarnings(ext, meta)
  }
}
