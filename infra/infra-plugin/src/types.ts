export type UnknownRecord = Record<string, unknown>
export type JsonPrimitive = string | number | boolean | null
export type JsonValue = JsonPrimitive | JsonObject | JsonValue[]
export interface JsonObject { [key: string]: JsonValue }

export interface ModuleServices extends UnknownRecord {}
export interface ModuleConfig extends UnknownRecord {}

export interface IHiraModule {
  id: string
  dependsOn?: readonly string[]
  install?(ctx: ModuleContext): void | Promise<void>
  start?(ctx: ModuleContext): void | Promise<void>
  stop?(ctx: ModuleContext): void | Promise<void>
  uninstall?(ctx: ModuleContext): void | Promise<void>
}

export interface ModuleContext {
  services: ModuleServices
  config: ModuleConfig
  getModule(id: string): IHiraModule | undefined
}

/** Data accepted by contribution registries. Functions are intentionally excluded. */
export type ContributionItem = UnknownRecord & { id?: unknown }
export interface ContributionMeta { pluginId?: string; order?: number }
export interface ContributionDefinition { mode?: 'multi' | 'single'; namespaced?: boolean }
export interface ContributionEntry<T extends ContributionItem = ContributionItem> {
  item: T
  pluginId: string | null
  order: number
  seq: number
}
export type ContributionResult<T extends ContributionItem = ContributionItem> = T & { pluginId: string | null; order: number }

export interface ContributionRegistry {
  define(kind: string, options?: ContributionDefinition): string
  contribute<T extends ContributionItem>(kind: string, item: T, meta?: ContributionMeta): ContributionResult<T>
  list<T extends ContributionItem = ContributionItem>(kind: string): ContributionResult<T>[]
  get<T extends ContributionItem = ContributionItem>(kind: string, id: string): ContributionResult<T> | null
  remove(kind: string, id: string, pluginId?: string): boolean
  clearPlugin(pluginId: string): number
  contributeFromManifest(pluginId: string, contributes: UnknownRecord): number
  kinds(): string[]
  reset(): void
}
