import type { TabManager } from '@hira-ng/infra-window'
import type { DomainServicesPort } from '../service-contracts'

export type JsonPrimitive = string | number | boolean | null
export type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue }
export type JsonObject = { [key: string]: JsonValue }
export type UnknownRecord = Record<string, unknown>
export type ToolArgs = Record<string, unknown>
export type ToolRisk = 'read' | 'write' | 'destructive'
export type ApprovalPolicy = 'never' | 'site' | 'always'
export type ReasoningLevel = 'auto' | 'low' | 'medium' | 'high'

export interface JsonSchema {
  type?: string
  description?: string
  properties?: Record<string, JsonSchema>
  required?: string[]
  additionalProperties?: boolean
  items?: JsonSchema
  enum?: JsonValue[]
  default?: JsonValue
  minimum?: number
  maximum?: number
  minLength?: number
  maxLength?: number
}

export interface AiReasoning {
  text: string
  field: string
  signature?: string
}

export interface AiTextBlock { type: 'text'; text: string; hidden?: boolean }
export interface AiImageBlock { type: 'image'; ref: string; mime?: string; width?: number; height?: number; bytes?: number }
export interface AiToolCallBlock { type: 'tool-call'; id: string; toolCallId?: string; name: string; args: JsonObject }
export type AiBlock = AiTextBlock | AiImageBlock | AiToolCallBlock

export interface AiSource { title?: string; url?: string; kind?: string }
export interface AiMessage {
  role: 'user' | 'assistant' | 'tool-call' | 'tool-result'
  blocks?: AiBlock[]
  reasoning?: AiReasoning | null
  sources?: AiSource[]
  id?: string
  name?: string
  args?: JsonObject
  result?: unknown
  isError?: boolean
  seq?: number
  turnId?: string | null
  context?: unknown[]
}

export interface AiToolContext {
  sessionId: string
  turnId?: string
  signal?: AbortSignal
  site?: string | null
  approvalMode?: 'allow' | 'ask'
  workspaceId?: string | null
  workspaceRoot?: string | null
  workspaceName?: string | null
  [key: string]: unknown
}

export interface AiToolDefinition {
  name: string
  description: string
  parameters: JsonSchema
  risk: ToolRisk
  approval: ApprovalPolicy | ((args: ToolArgs) => ApprovalPolicy)
  execute(args: ToolArgs, context: AiToolContext): unknown | Promise<unknown>
  [key: string]: unknown
}

export interface AiProviderModel {
  id: string
  providerId?: string
  label?: string
  contextWindow?: number | null
  maxOutputTokens?: number | null
  reasoning?: string | null
  sortOrder?: number
}

export interface AiProvider {
  id: string
  label: string
  protocol: 'openai-completions' | 'openai-responses' | 'anthropic-messages' | string
  baseUrl: string
  enabled: boolean
  hasKey?: boolean
  models: AiProviderModel[]
  [key: string]: unknown
}

export type AiStreamFrame =
  | { type: 'text-delta'; text: string }
  | { type: 'reasoning-delta'; text?: string; field?: string; signature?: string }
  | { type: 'tool-call'; id?: string; name: string; args?: JsonObject }
  | { type: 'usage'; promptTokens?: number; completionTokens?: number; cachedTokens?: number }
  | { type: 'done'; stopReason?: string }

export interface AiUsage {
  promptTokens: number
  completionTokens: number
  cachedTokens?: number
}
export interface AiToolCall { id: string; name: string; args: JsonObject }
export interface AiCompletionResult {
  text: string
  calls: AiToolCall[]
  reasoning?: AiReasoning | null
  usage: AiUsage
  stopReason: string
  model: { providerId: string; modelId: string }
}
export interface AiCompletionRequest {
  sessionId?: string
  model?: string | null
  system?: string
  messages: AiMessage[]
  tools?: Array<Pick<AiToolDefinition, 'name' | 'description' | 'parameters'>>
  maxOutputTokens?: number
  reasoning?: string
  signal?: AbortSignal
  timeoutMs?: number
}

export interface AiProtocolRequest {
  provider: AiProvider
  apiKey: string
  model: string
  messages: AiMessage[]
  system: string
  tools: Array<Pick<AiToolDefinition, 'name' | 'description' | 'parameters'>>
  signal: AbortSignal
  maxOutputTokens?: number
  reasoning?: string
}

export interface AiSubagentRequest {
  role?: string
  task?: string
  prompt?: string
  context?: string
  maxSteps?: number
  sessionId?: string
  approvalMode?: string
  [key: string]: unknown
}

export interface AiServicesPort extends DomainServicesPort {
  pluginHost?: { list(): unknown[]; setEnabled(id: string, enabled: boolean, cascade?: boolean): unknown }
  studio?: UnknownRecord
  extensionPoints?: ExtensionPointPort
  [key: string]: unknown
}

export interface ExtensionPointPort {
  call(name: string, payload?: unknown, context?: unknown): unknown | Promise<unknown>
  callSync?(name: string, payload?: unknown, context?: unknown): unknown
  isDefined?(name: string): boolean
  [key: string]: unknown
}

export interface PanelCatalogEntry {
  id: string
  title?: string
  side?: 'left' | 'right'
  detached?: boolean
  pinned?: boolean
  opensPage?: boolean
  hasData?: boolean
  dataKind?: string
  dataSource?: string
  panelId?: string
  [key: string]: unknown
}

export interface AppActionsPort {
  list(group?: unknown, options?: { availableOnly?: boolean; query?: unknown }): unknown
  run(id: string, payload?: UnknownRecord): unknown | Promise<unknown>
  runSettingAction?(route: string, payload?: UnknownRecord): unknown | Promise<unknown>
  settingsActionRoutes?(): string[]
  targets?(): unknown
  [key: string]: unknown
}

export interface StudioServicePort {
  capabilities(): unknown
  guide(payload?: { section?: string }): unknown
  prepare(req: unknown): unknown
  create(req: UnknownRecord): unknown | Promise<unknown>
  list(options?: UnknownRecord): unknown
  remove(options: UnknownRecord): unknown | Promise<unknown>
  skillList(options?: UnknownRecord): unknown
  skillSave(payload: UnknownRecord): unknown
  skillRemove(payload: UnknownRecord): unknown
  skillToggle(payload: UnknownRecord): unknown
  toggle(payload: UnknownRecord): unknown
  install?(req: unknown): unknown | Promise<unknown>
  [key: string]: unknown
}

export interface LogRecord {
  at: number
  level: string
  source: string
  message: string
  scope?: string
  url?: string
  line?: number
  extra?: unknown
  [key: string]: unknown
}

export interface LogQueryResult {
  capacity: number
  size: number
  total: number
  items: LogRecord[]
}

export interface LogHubPort {
  query(options: UnknownRecord): LogQueryResult
  stats(): { byLevel: Record<string, number>; bySource: Record<string, number> }
}

export interface PanelDataPort {
  list(): unknown
  read(panelId: string, options?: UnknownRecord): unknown | Promise<unknown>
  summary(...args: unknown[]): Record<string, { kind?: string; source?: string; [key: string]: unknown }>
  ids(...args: unknown[]): unknown
}

export interface PageDescriptor { host: string; label: string; section?: string; [key: string]: unknown }
export interface SettingsOption { value: unknown; label: string }
export interface SettingsField {
  key: string
  label?: string
  type?: string
  desc?: string
  effect?: string
  default?: unknown
  options?: unknown
  [key: string]: unknown
}
export interface SettingsSection { id: string; label: string; fields: SettingsField[]; [key: string]: unknown }
export interface BrowserLayoutPort {
  getPanelSideOf(panelId: string): string | null | undefined
  closePanel?(panelId: string): unknown
  showPanel(panelId: string, side?: string): unknown
  isPanelPinned?(panelId: string): boolean
  hidePanel?(panelId?: string): unknown
  togglePanel?(panelId: string, options?: UnknownRecord): unknown
  [key: string]: unknown
}
export interface PanelPresentationPort {
  isDetached(panelId: string): boolean
  dock?(panelId: string): unknown
  [key: string]: unknown
}

export interface PluginContributionRecord {
  id: string
  pluginId: string
  label?: string
  title?: string
  description?: string
  keywords?: string[]
  action?: unknown
  source?: string
  page?: string
  anchor?: string
  width?: number
  height?: number
  modal?: boolean
  [key: string]: unknown
}

export interface PluginCommand extends PluginContributionRecord { source: 'declared' | 'extension'; run?: (context: UnknownRecord) => unknown | Promise<unknown> }
export interface PluginOverlayDescriptor extends Omit<PluginContributionRecord, 'pluginId'> {
  pluginId?: string
  url?: string
}
export interface OpenPluginOverlay { key: string; pluginId: string; id: string; title?: string; url?: string }

export interface PluginSurfacesPort {
  listCommands(): PluginCommand[]
  listPages(): PluginContributionRecord[]
  listOverlays(): PluginOverlayDescriptor[]
  pageUrl(ref: string, selfId?: string): string
  runAction(action: unknown, context: UnknownRecord): boolean
}

export interface PluginOverlayResult { ok: boolean; reason?: string; key?: string; url?: string }
export interface PluginOverlayHostPort {
  listAll(): OpenPluginOverlay[]
  show(descriptor: PluginOverlayDescriptor, pluginId: string): PluginOverlayResult
  hide(key: string, pluginId?: string): boolean
}

export interface PluginDescriptorPort extends UnknownRecord {
  id: string
  name?: string
  version?: string
  enabled?: boolean
  isFirstParty?: boolean
  contributes?: UnknownRecord
  render?: string | null
  uiEntry?: string | null
}

export interface PluginRegistryPort { describe(): PluginDescriptorPort[] }

export interface AiToolHost {
  getTabManager(): TabManager
  getServices(): AiServicesPort
  extensionPoints?: ExtensionPointPort | null
  pluginSurfaces?: PluginSurfacesPort | null
  pluginOverlayHost?: PluginOverlayHostPort | null
  getPluginRegistry?(): PluginRegistryPort | null
  studio?: StudioServicePort | null
  getLayout?(): BrowserLayoutPort | null
  getPanelPresentation?(): PanelPresentationPort | null
  listPanels?(): PanelCatalogEntry[]
  getLogHub?(): LogHubPort | null
  panelData?: PanelDataPort | null
  appActions?: AppActionsPort | null
  processRunner?: {
    run(command: string, args?: readonly string[], options?: Record<string, unknown>): Promise<{ stdout: string; stderr: string }>
  } | null
  workspaces?: {
    open(input?: { sessionId?: string; title?: string }): Promise<unknown>
    current(sessionId: string): unknown
    list(): unknown
    bind(sessionId: string, workspaceId: string): unknown
    instructions(sessionId: string): string
    resolve(sessionId: string, target?: unknown, opts?: { allowRoot?: boolean }): Promise<{
      workspace: unknown
      abs: string
      root: string
    }>
  } | null
  complete?(request: AiCompletionRequest): Promise<AiCompletionResult>
  runAgent?(request: AiSubagentRequest): Promise<unknown>
  [key: string]: unknown
}

export interface AiPreExecuteDecision {
  decision?: 'allow' | 'deny'
  reason?: string
  args?: JsonObject
}

export interface AiToolRegistry {
  list(context?: AiToolContext): AiToolDefinition[]
  get(name: string, context?: AiToolContext): AiToolDefinition | null
  preExecute(call: UnknownRecord, context?: AiToolContext): Promise<AiPreExecuteDecision | null>
}

export interface AiKernelPort extends UnknownRecord {
  sqlite: UnknownRecord
  secretCrypto?: UnknownRecord | null
  userDataPath: string
  emit(route: string, payload?: unknown): unknown
  getTabManager(): TabManager
  panelPresentation?: PanelPresentationPort | null
  pluginSurfaces?: PluginSurfacesPort | null
  pluginOverlayHost?: PluginOverlayHostPort | null
  panelData?: PanelDataPort | null
  logHub?: LogHubPort | null
  appActions?: AppActionsPort | null
  processRunner?: {
    run(command: string, args?: readonly string[], options?: Record<string, unknown>): Promise<{ stdout: string; stderr: string }>
  } | null
  getPluginRegistry?(): PluginRegistryPort | null
  getLayout?(): BrowserLayoutPort | null
  isTrustedSender?(event: unknown): boolean
  getCurrentSession?(): unknown
}

export interface AiCompleterPort {
  complete(request: AiCompletionRequest): Promise<AiCompletionResult>
}

export interface AiSubAgentPort {
  run(request: AiSubagentRequest): Promise<unknown>
  dispatch?(request: AiSubagentRequest): Promise<unknown>
  dispose?(): void
}

export interface AiEngineDeps {
  kernel: AiKernelPort
  extensionPoints: ExtensionPointPort
  contributions?: UnknownRecord | null
  getDomainServices?(): AiServicesPort | null | undefined
  getPanels?(): PanelCatalogEntry[]
  logger?: AiLogger
}

export interface AiEnginePort {
  state(req?: UnknownRecord): unknown
  getUiState(): unknown
  setUiState(req?: UnknownRecord): unknown
  listSessions(req?: UnknownRecord): unknown
  createSession(req?: UnknownRecord): unknown
  renameSession(req?: UnknownRecord): unknown
  deleteSession(req?: UnknownRecord): unknown
  messages(req?: UnknownRecord): unknown
  searchSessions(req?: UnknownRecord): unknown
  exportSession(req?: UnknownRecord): unknown
  auditExport(req?: UnknownRecord): unknown
  send(req?: UnknownRecord): unknown | Promise<unknown>
  steer(req?: UnknownRecord): unknown | Promise<unknown>
  retry(req?: UnknownRecord): unknown | Promise<unknown>
  stop(req?: UnknownRecord): unknown
  approval(req?: UnknownRecord): unknown
  intentInvoke(req?: UnknownRecord): unknown | Promise<unknown>
  capture(req?: UnknownRecord): unknown | Promise<unknown>
  candidates(req?: UnknownRecord): unknown
  reveal(req?: UnknownRecord): unknown | Promise<unknown>
  usage(req?: UnknownRecord): unknown
  purge(req?: UnknownRecord): unknown
  providers: {
    list(): unknown
    save(req?: UnknownRecord): unknown
    remove(req?: UnknownRecord): unknown
    test(req?: UnknownRecord): unknown | Promise<unknown>
    upsertModel(req?: UnknownRecord): unknown
    removeModel(req?: UnknownRecord): unknown
  }
  skills: {
    list(req?: UnknownRecord): unknown
    save(req?: UnknownRecord): unknown
    remove(req?: UnknownRecord): unknown
    setEnabled(req?: UnknownRecord): unknown
    exportFile(req?: UnknownRecord): unknown
    importFile(req?: UnknownRecord): unknown
    run(req?: UnknownRecord): unknown | Promise<unknown>
  }
}

export interface AiProjectedMessages {
  messages: AiMessage[]
  lastSeq: number
}

export type AiLogger = Pick<Console, 'warn' | 'info' | 'error'>
