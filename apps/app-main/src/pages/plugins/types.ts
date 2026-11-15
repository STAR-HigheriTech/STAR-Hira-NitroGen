export interface PluginPage {
  id: string
  pluginId: string
  title: string
  entry: string
  dir: string
  host: string
  url: string
  order: number
}

export interface PluginContribution {
  pages?: PluginPage[]
  panels?: unknown[]
  [key: string]: unknown
}

export interface PluginRecord extends Record<string, unknown> {
  id: string
  name?: string
  type?: string
  version?: string
  description?: string
  enabled?: boolean
  installed?: boolean
  runtime?: boolean
  nonDisableable?: boolean
  failed?: boolean
  autoDisabled?: boolean
  blocked?: boolean
  awaitingConsent?: boolean
  error?: string
  trustLevel?: string
  permissionLevel?: string
  main?: string
  render?: string
  panelUi?: Array<{ title?: string; panelId?: string; [key: string]: unknown }>
  json?: unknown
  contributes?: PluginContribution
  pages?: PluginPage[]
  capabilities?: unknown[]
  requestedPermissions?: string[]
  grantedPermissions?: string[]
  requestedPermissionLabels?: Record<string, string>
  dependsOn?: string[]
  optionalDependsOn?: string[]
  requiredBy?: string[]
  optionalRequiredBy?: string[]
  conflictsWith?: string[]
  blockedBy?: string[]
  healthCheckFailures?: number
  healthCheck?: { failures?: number; [key: string]: unknown }
}

export interface MarketSourceRecord {
  url: string
  name?: string
  ok?: boolean
  reason?: string
  count?: number
  skipped?: number
  cached?: boolean
  [key: string]: unknown
}

export interface MarketEntryRecord extends Record<string, unknown> {
  id: string
  name?: string
  version?: string
  author?: string
  installed?: boolean
  installedVersion?: string
  updateAvailable?: boolean
  sha256?: string
  sourceUrl?: string
  sourceName?: string
  description?: string
}

export interface MarketState {
  ok: boolean
  reason?: string
  sources: MarketSourceRecord[]
  entries: MarketEntryRecord[]
  duplicates?: number
}

export interface TrustedKeyRecord extends Record<string, unknown> {
  keyId: string
  level?: string
  readable?: boolean
  algo?: string
  fingerprint?: string
  removable?: boolean
}

export interface PluginActionResult extends Record<string, unknown> {
  ok?: boolean
  reason?: string
  message?: string
  code?: string
  error?: string
  canceled?: boolean
  requiresCascade?: boolean
  restored?: string[]
  dependents?: Array<{ name?: string; id?: string }>
  imported?: number
  exported?: number
  path?: string
  enabled?: boolean
}

export interface PluginSkillListResult extends PluginActionResult {
  skills?: unknown[]
  kinds?: unknown[]
}

export interface PluginMarketListResult extends PluginActionResult, Partial<MarketState> {}

export interface PluginClientPort {
  list(): Promise<PluginRecord[]>
  listTrustedKeys(): Promise<TrustedKeyRecord[]>
  listUserScripts(): Promise<unknown[]>
  setUserScriptEnabled(key: string, enabled: boolean): Promise<PluginActionResult>
  openPage(url: string): Promise<PluginActionResult>
  setEnabled(id: string, enabled: boolean, options?: { cascade?: boolean }): Promise<PluginActionResult>
  grantPermissions(id: string, scopes: unknown): Promise<PluginActionResult>
  reload(id: string): Promise<PluginActionResult>
  openPluginDir(): Promise<PluginActionResult>
  installPlugin(options?: { source?: string; overwrite?: boolean }): Promise<PluginActionResult>
  installUserscript(options?: { text?: string; overwrite?: boolean }): Promise<PluginActionResult>
  uninstallPlugin(id: string): Promise<PluginActionResult>
  addTrustedKey(options?: { overwrite?: boolean; level?: string | number }): Promise<PluginActionResult>
  removeTrustedKey(keyId: string, level?: string): Promise<PluginActionResult>
  marketList(options?: { force?: boolean }): Promise<PluginMarketListResult>
  marketSetSources(sources: string[]): Promise<PluginActionResult>
  marketInstall(id: string, options?: { overwrite?: boolean; force?: boolean }): Promise<PluginActionResult>
  aiSkillList(): Promise<PluginSkillListResult>
  aiSkillSave(payload: Record<string, unknown>): Promise<PluginActionResult>
  aiSkillRemove(id: string): Promise<PluginActionResult>
  aiSkillSetEnabled(id: string, enabled: boolean): Promise<PluginActionResult>
  aiSkillExport(ids: unknown): Promise<PluginActionResult>
  aiSkillImport(): Promise<PluginActionResult>
  aiSkillRun(payload: Record<string, unknown>): Promise<PluginActionResult>
}

export interface PluginViewPort {
  element: HTMLElement
  setItems(items: PluginRecord[]): void
  setItemsError?(): void
  setNotice(text: string, kind?: 'info' | 'error'): void
  setTrustedKeys?(keys: TrustedKeyRecord[]): void
  setMarket?(state: MarketState): void
  setSkills?(skills: unknown[], kinds: unknown[]): void
  setSkillsError?(message: string): void
  setUserScripts?(scripts: unknown[]): void
  setUserScriptsError?(message: string): void
}

export interface PluginControllerPorts {
  clients: PluginClientPort
  on?: (event: string, handler: (payload: unknown) => void) => unknown
  confirm?: (options: { title?: string; message?: string; danger?: boolean; confirmLabel?: string }) => Promise<boolean>
  view: PluginViewPort
}

export type PluginIntent = Record<string, unknown>
export type PluginDispatch = (intent: PluginIntent) => unknown
