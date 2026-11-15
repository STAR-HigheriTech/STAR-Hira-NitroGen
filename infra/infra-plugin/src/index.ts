export { PluginRegistryV2 } from './plugin-registry-v2'
export type {
  PluginManifest,
  PluginRegistryOptions,
  PluginRuntimeContext,
  PluginExecutionContext,
  PluginModule,
  PluginCleanup,
  PluginCleanupHandle,
  PluginDescriptor,
  PluginLoadResult,
  PluginToggleResult,
  PluginDependencyCheck
} from './plugin-registry-v2'
export {
  PLUGIN_CONTRACT_VERSION,
  PLUGIN_PERMISSION_LEVELS,
  PLUGIN_PUBLISHER_TRUST_LEVELS,
  defineExtensionPointContract,
  definePluginManifest,
  definePluginModule
} from '@hira-ng/shared-types/src/plugin-core'
export type {
  ExtensionPointContract,
  ExtensionPointId,
  HiraExtensionPointContracts,
  PluginManifestDocument,
  PluginPublisherTrustLevel,
  PluginRuntimeState,
  TypedExtensionPointRegistry
} from '@hira-ng/shared-types/src/plugin-core'
export { ModuleManager } from './ModuleManager'
export { HOOKS, LIFECYCLE_PHASES, ProviderRegistry, normalizeProvider } from './provider-registry'
export type {
  ProviderContext,
  ProviderDescription,
  ProviderExecution,
  ProviderHook,
  ProviderInput,
  ProviderLifecyclePhase,
  ProviderRecord,
  ProviderRegistryOptions,
  ServiceRegistrationOptions
} from './provider-registry'
export { createServicePlugin } from './service-plugin'
export type { ServicePlugin, ServicePluginContext, ServicePluginOptions, ServiceInvoker } from './service-plugin'
export { createContributionRegistry } from './contributions'
export type { ContributionRegistry, ContributionItem, ContributionResult } from './types'
export * as sandbox from './plugin-sandbox'
export { createExtensionPointRegistry, EP_MODES, formatIssues, validateWith } from './extension-points'
export type {
  ExtensionContext,
  ExtensionImplementation,
  ExtensionImplementationMeta,
  ExtensionMode,
  ExtensionPointEntry,
  ExtensionPointInput,
  ExtensionPointRegistry,
  ExtensionPointRegistryOptions,
  ExtensionPointSpec
} from './extension-points'
export { OFFICIAL_EXTENSION_POINTS, registerOfficialExtensionPoints } from './official-extension-points'
export type { OfficialExtensionPoint, OfficialExtensionSchema, RegisterOfficialOptions } from './official-extension-points'
export type {
  ContributionDefinition,
  ContributionEntry,
  ContributionMeta,
  IHiraModule,
  JsonObject,
  JsonPrimitive,
  JsonValue,
  ModuleConfig,
  ModuleContext,
  ModuleServices,
  UnknownRecord
} from './types'
