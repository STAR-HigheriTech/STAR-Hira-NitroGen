export type AiHost = 'panel' | 'window' | 'page'
export type ReasoningLevel = 'auto' | 'low' | 'medium' | 'high'
export type ApprovalMode = 'allow' | 'ask'
export type ApprovalDecision = 'allow' | 'deny'

export interface AiProviderModel {
  id: string
  label?: string
  reasoning?: string
}

export interface AiProvider {
  id: string
  label?: string
  enabled?: boolean
  models?: AiProviderModel[]
}

export interface AiSession {
  id: string
  title?: string
  providerId?: string
  modelId?: string
  workspaceId?: string | null
  createdAt?: number
  updatedAt?: number
  modifiedAt?: number
}

export interface AiSkill {
  id: string
  label?: string
  description?: string
  prompt?: string
  kind?: string
  icon?: string
  enabled?: boolean
  group?: string
  pluginId?: string
  pluginName?: string
}

export interface AiSkillKind {
  kind: string
  label?: string
  icon?: string
  tone?: string
  external?: boolean
}

export interface AiContextItem {
  key?: string
  kind: string
  payload?: unknown
  title?: string
  url?: string
  favicon?: string | null
  tokens?: number
  untrusted?: boolean
  [key: string]: unknown
}

export interface AiStreamSource {
  title: string
  url: string
  kind: string
}

export interface AiStreamPart {
  type: 'text' | 'reasoning' | 'tool'
  key: string
  text?: string
  id?: string
  name?: string
  args?: unknown
  result?: unknown
  isError?: boolean
  status?: 'running' | 'ok' | 'error'
}

export interface AiStreaming {
  turnId: string | null
  parts: AiStreamPart[]
  sources?: AiStreamSource[]
  orphan: boolean
  done: boolean
}

export interface AiMessage {
  seq: number
  role: string
  id?: string
  turnId?: string
  type?: string
  kind?: string
  text?: string
  title?: string
  url?: string
  name?: string
  key?: string
  status?: string
  payload?: unknown
  blocks?: unknown[]
  args?: unknown
  result?: unknown
  context?: AiContextItem[]
  reasoning?: unknown
  sources?: unknown[]
  [key: string]: unknown
}

export interface AiApprovalPayload extends Record<string, unknown> {
  title?: string
  summary?: string
  toolName?: string
  args?: unknown
}

export interface AiApproval extends Record<string, unknown> {
  approvalId: string
  sessionId?: string
  turnId?: string
  toolName: string
  risk?: string
  site?: string
  hint?: string
  argsPreview?: unknown
  payload?: AiApprovalPayload
}

export interface AiUiError {
  message: string
  code: string
  retryable?: boolean
}

export interface AiPendingUser {
  text: string
  chips: AiContextItem[]
  steering?: boolean
  sinceSeq: number
}

export interface AiUsage {
  promptTokens: number
  completionTokens: number
  cachedTokens?: number
}

export interface AiUiState {
  ready: boolean
  unavailable: { message: string; code: string } | null
  sessionId: string | null
  session: AiSession | null
  sessions: AiSession[]
  providers: AiProvider[]
  skills: AiSkill[]
  skillKinds: AiSkillKind[]
  messages: AiMessage[]
  lastSeq: number
  running: Map<string, string>
  streaming: AiStreaming | null
  approvals: AiApproval[]
  pendingUser: AiPendingUser | null
  error: AiUiError | null
  modelChoice: string | null
  reasoning: string
  approvalMode: ApprovalMode
  chips: AiContextItem[]
  usage: AiUsage
}

export interface AiSharedState {
  sessionId?: string | null
  sessionIdByHost?: Record<AiHost, string | null>
  modelChoice?: string | null
  reasoning?: ReasoningLevel | string
  approvalMode?: ApprovalMode
}

export interface AiSnapshot {
  sessionId?: string | null
  session?: AiSession | null
  sessions?: AiSession[]
  providers?: AiProvider[]
  skills?: AiSkill[]
  skillKinds?: AiSkillKind[]
  messages?: AiMessage[]
  lastSeq?: number
  running?: Array<{ sessionId: string; turnId: string }>
  approvals?: AiApproval[]
  uiState?: AiSharedState
  pendingIntents?: AiIntent[]
}

export interface AiIntent extends Record<string, unknown> {
  id?: string
  kind?: string
  intent?: string
  prompt?: string
  text?: string
  payload?: unknown
  sessionId?: string | null
  targetHost?: AiHost
  newSession?: boolean
  autoSend?: boolean
  items?: unknown[]
  silent?: boolean
}

export interface AiStreamDelta {
  type: string
  text?: string
  id?: string
  name?: string
  args?: unknown
  result?: unknown
  isError?: boolean
  items?: unknown[]
  promptTokens?: number
  completionTokens?: number
  cachedTokens?: number
}

export interface AiStreamEvent {
  sessionId: string
  turnId?: string | null
  frame: string
  delta?: AiStreamDelta
  usage?: Partial<AiUsage>
  stopReason?: string
  [key: string]: unknown
}

export interface AiActionResult {
  ok?: boolean
  reason?: string
  code?: string
  message?: string
  [key: string]: unknown
}

export interface AiSessionListResult {
  sessions?: AiSession[]
}

export interface AiSessionResult {
  session?: AiSession
}

export interface AiMessagesResult {
  messages?: AiMessage[]
  lastSeq?: number
  running?: boolean
}

export interface AiProviderListResult {
  providers?: AiProvider[]
}

export interface AiSkillListResult {
  skills?: AiSkill[]
  kinds?: AiSkillKind[]
  skillKinds?: AiSkillKind[]
}

export interface AiCaptureResult extends AiActionResult {
  item?: AiContextItem
}

export interface AiCandidatesResult extends AiActionResult {
  items?: unknown[]
}

export interface AiClientPort {
  state(opts?: { host?: AiHost; sessionId?: string; consumePending?: boolean; select?: boolean }): Promise<AiSnapshot>
  uiState: {
    set(patch: AiSharedState & Record<string, unknown>): Promise<unknown>
  }
  sessions: {
    list(opts?: Record<string, unknown>): Promise<AiSessionListResult>
    create(title?: string, host?: AiHost): Promise<AiSessionResult>
    rename(sessionId: string, title: string): Promise<AiSessionResult>
    remove(sessionId: string): Promise<unknown>
    search(query: string, limit?: number): Promise<AiSessionListResult>
    export(sessionId: string, format?: 'md' | 'json'): Promise<AiActionResult>
  }
  messages(sessionId: string, opts?: Record<string, unknown>): Promise<AiMessagesResult>
  send(payload: Record<string, unknown>): Promise<AiActionResult>
  steer(payload: Record<string, unknown>): Promise<AiActionResult>
  retry(payload: Record<string, unknown>): Promise<AiActionResult>
  stop(sessionId: string): Promise<unknown>
  approval(payload: Record<string, unknown>): Promise<unknown>
  invokeIntent(intent: string, payload?: unknown, sessionId?: string): Promise<AiActionResult>
  capture(kind: string, payload?: unknown): Promise<AiCaptureResult>
  candidates(kind: string, query?: string, limit?: number): Promise<AiCandidatesResult>
  reveal(url: string): Promise<AiActionResult>
  providers: {
    list(): Promise<AiProviderListResult>
  }
  skills: {
    list(): Promise<AiSkillListResult>
    run(payload?: Record<string, unknown>): Promise<AiActionResult>
  }
  onStateChanged?(listener: (payload: Record<string, unknown>) => void): () => void
  onUiStateChanged?(listener: (payload: Record<string, unknown>) => void): () => void
  onStream?(listener: (payload: Record<string, unknown>) => void): () => void
  onIntent?(listener: (payload: AiIntent) => void): () => void
  onApprovalRequest?(listener: (payload: AiApproval) => void): () => void
  onUsageTick?(listener: (payload: Record<string, unknown>) => void): () => void
}

export interface AiStoreOptions {
  doc: Document
  ai: AiClientPort
  host?: AiHost
  onIntentComplete?: (intent: AiIntent) => void
}
