/**
 * Stable plugin contracts shared by the host, plugin modules and future SDKs.
 * This file stays dependency-free so it can be consumed by every process.
 */

export const PLUGIN_CONTRACT_VERSION = 2 as const

export const PLUGIN_PERMISSION_LEVELS = Object.freeze([
  'none',
  'ui',
  'network',
  'full'
] as const)
export type PluginPermissionLevel = (typeof PLUGIN_PERMISSION_LEVELS)[number]

export const PLUGIN_PUBLISHER_TRUST_LEVELS = Object.freeze([
  'core',
  'internal',
  'community'
] as const)
export type PluginPublisherTrustLevel = (typeof PLUGIN_PUBLISHER_TRUST_LEVELS)[number] | (string & {})

export const EXTENSION_POINT_MODES = Object.freeze({
  SINGLE: 'SINGLE',
  MULTI: 'MULTI',
  REDUCE: 'REDUCE',
  EVENT: 'EVENT'
} as const)
export type ExtensionPointMode = (typeof EXTENSION_POINT_MODES)[keyof typeof EXTENSION_POINT_MODES]

export type MaybePromise<T> = T | PromiseLike<T>
export type PluginCleanup = () => void | PromiseLike<void>
export type PluginCleanupHandle = () => void | PromiseLike<void>
export type PluginCleanupRegistrar = (cleanup: PluginCleanup) => PluginCleanupHandle

export type PluginLocalizedText = string | Readonly<Record<string, string>>
export type PluginJsonPrimitive = string | number | boolean | null
export type PluginJsonValue = PluginJsonPrimitive | PluginJsonObject | PluginJsonValue[]
export interface PluginJsonObject { readonly [key: string]: PluginJsonValue | undefined }

export interface PluginHealthCheck {
  enabled: boolean
  intervalMs: number
  timeoutMs: number
  failures: number
}

export interface PluginHealthResult {
  ok: boolean
  reason?: string
  skipped?: string
}

export interface PluginPanelUiEntry extends PluginJsonObject {
  entry: string
  kind: 'html' | 'xaml'
}

export interface PluginPanelContribution extends PluginJsonObject {
  id: string
  title?: string
  icon?: string
  order?: number
  segment?: string
  ui?: string | PluginPanelUiEntry
  bangs?: string[]
}

export type PluginContributions = Readonly<Record<string, unknown>>

/** Author-facing manifest input. Unknown keys remain available to forward-compatible plugins. */
export interface PluginManifestDocument extends Readonly<Record<string, unknown>> {
  id: string
  schemaVersion?: string | number
  version?: string
  name?: PluginLocalizedText
  description?: PluginLocalizedText
  type?: string
  trustLevel?: PluginPublisherTrustLevel
  permissionLevel?: PluginPermissionLevel
  requestedPermissions?: readonly string[]
  main?: string
  render?: string
  entry?: Readonly<{ main?: string; render?: string }>
  ui?: unknown
  uiEntry?: unknown
  capabilities?: readonly string[]
  contributes?: PluginContributions
  dependsOn?: readonly string[]
  optionalDependsOn?: readonly string[]
  conflictsWith?: readonly string[]
  lifecycle?: Readonly<Record<string, unknown>>
  healthCheck?: Readonly<Record<string, unknown>>
  nonDisableable?: boolean
  defaultDisabled?: boolean
}

/** Fully normalized manifest used by every runtime consumer. */
export interface PluginManifest {
  id: string
  version: string
  name: string
  description: string
  type: string
  trustLevel: PluginPublisherTrustLevel
  isFirstParty: boolean
  permissionLevel: PluginPermissionLevel
  requestedPermissions: string[]
  main: string | null
  render: string | null
  renderVersion: number | null
  uiEntry: PluginPanelUiEntry | null
  capabilities: string[]
  contributes: PluginContributions
  dependsOn: string[]
  optionalDependsOn: string[]
  conflictsWith: string[]
  healthCheck: PluginHealthCheck | null
  nonDisableable: boolean
  defaultDisabled: boolean
  originPath: string | null
}

export interface PluginRuntimeState {
  installed: boolean
  enabled: boolean
  failed?: boolean
  blocked?: boolean
  blockedBy?: string[]
  awaitingConsent?: boolean
  error?: unknown
}

export interface PluginRuntimeContext extends Record<string, unknown> {
  pluginId?: string
  manifest?: PluginManifest
  browser?: Record<string, unknown> | null
  onCleanup?: PluginCleanupRegistrar
  onDispose?: PluginCleanupRegistrar
  isActive?: () => MaybePromise<boolean>
}

export type PluginExecutionContext = PluginRuntimeContext & {
  pluginId: string
  manifest: PluginManifest
  onCleanup: PluginCleanupRegistrar
  onDispose: PluginCleanupRegistrar
  isActive: () => MaybePromise<boolean>
}

export interface PluginServiceRegistration<TService = unknown> {
  name: string
  service: TService
}

export interface PluginProviderRegistration {
  id: string
  capability: string
  metadata?: Readonly<Record<string, unknown>>
  before?: (...args: unknown[]) => unknown
  validate?: (...args: unknown[]) => unknown
  around?: (...args: unknown[]) => unknown
  after?: (...args: unknown[]) => unknown
}

export interface PluginExtensionPointSpec {
  id: string
  mode: ExtensionPointMode
  description?: string
  owner?: string
  paramsSchema?: unknown
  resultSchema?: unknown
  initialValue?: unknown
}

export interface PluginExtensionPointExport {
  name: string
  service: unknown
}

export interface PluginExtensionPointImplementation {
  to: string
  impl: (...args: unknown[]) => unknown
  key?: string
  order?: number
}

export interface PluginExtensionPointPlan {
  provides?: PluginExtensionPointSpec[]
  extends?: PluginExtensionPointImplementation[]
}

/** Main-process module contract. Hooks are optional and independently releasable. */
export interface PluginModule<Context extends object = PluginExecutionContext> extends Record<string, unknown> {
  preInstall?(context: Context): MaybePromise<unknown>
  install?(context: Context): MaybePromise<unknown>
  postInstall?(context: Context): MaybePromise<unknown>
  preEnable?(context: Context): MaybePromise<unknown>
  enable?(context: Context): MaybePromise<unknown>
  postEnable?(context: Context): MaybePromise<unknown>
  preDisable?(context: Context): MaybePromise<unknown>
  disable?(context: Context): MaybePromise<unknown>
  uninstall?(context: Context): MaybePromise<unknown>
  unregisterEPs?(context: Context): MaybePromise<unknown>
  registerServices?(context: Context): MaybePromise<readonly PluginServiceRegistration[] | PluginServiceRegistration | null | undefined>
  registerProviders?(context: Context): MaybePromise<readonly PluginProviderRegistration[] | null | undefined>
  registerExtensionPoints?(context: Context): MaybePromise<readonly PluginExtensionPointExport[] | null | undefined>
  extensionPoints?(context: Context): MaybePromise<PluginExtensionPointPlan | null | undefined>
  injectStyles?(context: Context): MaybePromise<unknown>
  healthCheck?(context: Context): MaybePromise<boolean | PluginHealthResult | void>
}

export interface PluginLoaderPort {
  context: PluginExecutionContext
  loadDefault(): Promise<unknown>
}
export type PluginLoader = (manifest: PluginManifest, port: PluginLoaderPort) => unknown | Promise<unknown>

/** Declaration-merging seam for official and third-party extension points. */
export interface HiraExtensionPointContracts {}

export interface ExtensionPointContract<TInput = unknown, TResult = unknown> {
  input: TInput
  result: TResult
}

export type ExtensionPointId = Extract<keyof HiraExtensionPointContracts, string>
export type ExtensionPointInputOf<K extends ExtensionPointId> =
  HiraExtensionPointContracts[K] extends ExtensionPointContract<infer Input, unknown> ? Input : never
export type ExtensionPointResultOf<K extends ExtensionPointId> =
  HiraExtensionPointContracts[K] extends ExtensionPointContract<unknown, infer Result> ? Result : never

type ExtensionPointInputFor<Contracts, K extends keyof Contracts> =
  Contracts[K] extends ExtensionPointContract<infer Input, unknown> ? Input : never
type ExtensionPointResultFor<Contracts, K extends keyof Contracts> =
  Contracts[K] extends ExtensionPointContract<unknown, infer Result> ? Result : never

export interface TypedExtensionPointRegistry<Contracts extends object = HiraExtensionPointContracts> {
  define<K extends Extract<keyof Contracts, string>>(id: K, mode: ExtensionPointMode, options?: Omit<PluginExtensionPointSpec, 'id' | 'mode'>): void
  implement<K extends Extract<keyof Contracts, string>>(
    id: K,
    implementation: (input: ExtensionPointInputFor<Contracts, K>) => MaybePromise<ExtensionPointResultFor<Contracts, K>>,
    meta?: Readonly<Record<string, unknown>>
  ): string
  call<K extends Extract<keyof Contracts, string>>(id: K, input: ExtensionPointInputFor<Contracts, K>): Promise<ExtensionPointResultFor<Contracts, K>>
  callSync<K extends Extract<keyof Contracts, string>>(id: K, input: ExtensionPointInputFor<Contracts, K>): ExtensionPointResultFor<Contracts, K>
}

export function definePluginManifest<const T extends PluginManifestDocument>(manifest: T): T {
  if (!manifest || typeof manifest.id !== 'string' || !manifest.id.trim()) {
    throw new TypeError('Plugin manifest id is required')
  }
  return manifest
}

export function definePluginModule<Context extends object = PluginExecutionContext>(
  module: PluginModule<Context>
): PluginModule<Context> {
  if (!module || (typeof module !== 'object' && typeof module !== 'function')) {
    throw new TypeError('Plugin module must be an object')
  }
  return module
}

export function defineExtensionPointContract<TInput, TResult>(): ExtensionPointContract<TInput, TResult> {
  return {} as ExtensionPointContract<TInput, TResult>
}
