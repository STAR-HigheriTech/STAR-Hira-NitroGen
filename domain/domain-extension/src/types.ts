/** Shared public contracts for extension rules and runtime composition. */

export interface ExtensionManifest {
  [key: string]: unknown
  id?: unknown
  name?: unknown
  description?: unknown
  version?: unknown
  manifest_version?: unknown
  default_locale?: unknown
  update_url?: unknown
  homepage_url?: unknown
  permissions?: unknown
  optional_permissions?: unknown
  host_permissions?: unknown
  content_scripts?: unknown
}

export interface ExtensionRuntime {
  id?: string
  name?: string
  version?: string
  disabled?: boolean
  path?: string
  iconPath?: string
  manifest?: ExtensionManifest | null
}

export type ExtensionSource = 'store' | 'local'
export type ExtensionRuntimeStatus = 'loaded' | 'disabled' | 'missing'
export type DiagnosticSeverity = 'error' | 'warning'

export interface LocaleMessageEntry {
  message?: string
}

export type LocaleMessages = Record<string, Record<string, LocaleMessageEntry> | undefined>

export interface ExtensionMetaOptions {
  fallbackName?: string
  permissionOrder?: readonly string[]
  locales?: LocaleMessages | null
  localeCandidates?: readonly string[]
}

export interface ExtensionMeta {
  id: string
  name: string
  description: string
  version: string
  isUnpacked: boolean
  isValid: boolean
  manifestVersion: number
  isV3: boolean
  source: ExtensionSource
  storeUrl: string
  permissionNames: string[]
  permissions: string[]
  contentScripts: string[]
}

export interface ExtensionDiagnostic {
  code: string
  severity: DiagnosticSeverity
  message: string
}

export interface ExtensionWarning {
  code: string
  severity: 'warning'
  message: string
}

export interface ExtensionRuntimeInfo {
  status: ExtensionRuntimeStatus
  diagnostics: ExtensionDiagnostic[]
  warnings: ExtensionWarning[]
}

export interface BackgroundPageSource {
  url?: string
}

export interface ServiceWorkerSource {
  scope?: string
  scriptUrl?: string
}

export interface InspectSources {
  backgrounds?: readonly BackgroundPageSource[]
  serviceWorkers?: readonly ServiceWorkerSource[]
}

export type InspectViewTarget = 'background-page' | 'service-worker'

export interface ExtensionInspectView {
  target: InspectViewTarget
  label: string
  url: string
  inspectable: boolean
  note: string
}

export interface ManifestLoadValidationOk {
  ok: true
  manifestVersion: number
}

export interface ManifestLoadValidationError {
  ok: false
  reason: 'invalid-manifest' | 'invalid-manifest-version' | 'invalid-version'
}

export type ManifestLoadValidation = ManifestLoadValidationOk | ManifestLoadValidationError
