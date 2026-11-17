/**
 * AI 引擎 · 回合执行器（PART15 §4 / §6 / §7 / §10）。
 *
 * ══════════════════════════════════════════════════════════════════════
 * 它是什么
 * ══════════════════════════════════════════════════════════════════════
 * 「一次提问 → 若干步模型调用 → 若干次工具执行 → 收尾」的全过程。
 * 唯一的不变量：**内存只是缓存，真相在事件日志里**。任何一步都可以从
 * `ai_event` 重放出同样的上下文，因此中断、重启、切窗口都不会丢进度。
 *
 * ══════════════════════════════════════════════════════════════════════
 * 三条设计约束（都是为了"界面卡住也没关系"）
 * ══════════════════════════════════════════════════════════════════════
 *   1. **不阻塞调用方**：`start()` 立即返回 `{sessionId, turnId}`，真正的执行
 *      在后台跑。IPC handler 不 await 整个回合 —— 否则渲染层一次 invoke 会挂十几秒。
 *   2. **流式帧 16ms 合批**：模型每个 token 都推一帧会把 IPC 打成筛子（每秒几百次），
 *      按帧数刷新毫无意义 —— 人眼看不出来。攒 16ms（约一帧）再发一次。
 *   3. **可取消**：每个回合一个 AbortController，`stop()` 立刻中断 HTTP 流。
 *      中断后**补账**（写 turn/end + 用量），停在一个自洽的状态上。
 *
 * 流式帧形状（`ai:stream` 事件，按 sessionId 过滤）：
 *   { sessionId, turnId, frame: 'start' }
 *   { sessionId, turnId, frame: 'chunk', delta: { type: 'text', text } }
 *   { sessionId, turnId, frame: 'chunk', delta: { type: 'reasoning', text } }
 *   { sessionId, turnId, frame: 'chunk', delta: { type: 'tool-call', id, name, args } }
 *   { sessionId, turnId, frame: 'chunk', delta: { type: 'tool-result', id, name, result, isError } }
 *   { sessionId, turnId, frame: 'chunk', delta: { type: 'sources', items: [{ title, url, kind }] } }
 *   { sessionId, turnId, frame: 'chunk', delta: { type: 'usage', promptTokens, completionTokens } }
 *   { sessionId, turnId, frame: 'end', stopReason, usage }
 *   { sessionId, turnId, frame: 'error', message, code }
 */

const crypto = require('crypto')
const { withTimeout } = require('./async-guard.cjs')
const { projectMessages } = require('../core/store.cjs')
const { PROTOCOLS, reasoningEcho, reasoningEchoField } = require('../core/providers.cjs')
const { TOOL_SEARCH_NAME, buildToolSurface, searchTools, isToolVisible } = require('../core/tool-surface.cjs')
// 审批 + 审计的唯一实现（子智能体也用它，见 main/tool-gate.cjs 文件头）。
const { createToolGate, evaluate, originOf } = require('./tool-gate.cjs')

import type {
  AiBlock,
  AiCompletionRequest,
  AiCompletionResult,
  AiMessage,
  AiSource,
  AiToolCall,
  AiUsage
} from '../types'

interface TurnState {
  sessionId: string
  turnId: string
  controller: AbortController
  modelOverride: string | null
  reasoning?: string
  step: number
  aborted: boolean
  injectQueued: boolean
  lastModel: { providerId: string; modelId: string } | null
  approvalMode?: 'allow' | 'ask'
  sources?: AiSource[]
  expandedTools?: Set<string>
  compactedThrough?: number
  [key: string]: unknown
}

type TurnContext = Pick<TurnState, 'sessionId' | 'turnId'>

interface TurnSlot extends TurnState {
  startedAt: number
  retryOf: unknown
}

interface TurnFailure {
  message: string
  code: string
  stack: string
}

interface TurnOutcome {
  stopReason: string
  usage: AiUsage
  failure?: TurnFailure | null
}

interface TurnWaiter {
  turnId: string
  resolve(outcome: TurnOutcome): void
}

/** 常规工具预算；复杂任务可由请求显式提高。 */
const DEFAULT_STEP_BUDGET = 64
/** 极端任务的硬安全边界，防止模型失控；正常浏览器任务远达不到。 */
const MAX_STEP_BUDGET = 256
/** 收尾钩子 `ai.turn.stopping` 的最长等待：绝不阻塞 `end` 帧（界面靠它收"运行中"）。 */
const HOOK_TIMEOUT_MS = 1500
/** 单次工具执行的安全上限；工具自身的超时若更严格会先生效。 */
const TOOL_EXECUTION_TIMEOUT_MS = 180_000
/** 文本增量合批窗口（毫秒）—— 约一帧，肉眼无感，IPC 次数降两个数量级。 */
const STREAM_FLUSH_MS = 16
/** 单个工具结果进模型前的字符上限（截图 dataUrl 另行处理，不进提示词）。 */
const TOOL_RESULT_CURRENT_LIMIT = 24000
/** 旧工具结果只保留足以恢复上下文的首段，避免历史工具日志反复计费。 */
const TOOL_RESULT_HISTORY_LIMIT = 3000
/** 上下文预算里给输出留的余量（模型上下文窗口 - 这个值 = 输入预算）。 */
const DEFAULT_OUTPUT_RESERVE_TOKENS = 8192
const INITIAL_TOKEN_SCALE = 1.5
const COMPACTION_TRANSCRIPT_LIMIT = 20_000
const COMPACTION_SYSTEM_PROMPT = [
  '你负责压缩一段浏览器 AI 对话，供后续继续任务使用。',
  '输出纯文本摘要，不调用工具，不写开场白。',
  '如果提供了既有摘要，一定要把它与新记录合并成一份连续摘要，不能丢掉仍然有效的目标、决定、事实与未完成事项。',
  '必须保留：用户目标与约束、已确认事实、关键决定、页面或来源 URL、已执行操作及结果、未完成事项、下一步。',
  '删除寒暄、重复解释、失败尝试的过程细节和无关工具日志。',
  '不要把推断写成事实；信息不确定时明确标注。控制在 800 字以内。'
].join('\n')

function newTurnId() {
  return `t_${crypto.randomBytes(8).toString('hex')}`
}

function digest(value: unknown): string {
  try {
    return crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex').slice(0, 16)
  } catch (_) {
    return ''
  }
}

function compactionTranscript(messages: AiMessage[]): string {
  const lines: string[] = []
  for (const message of messages) {
    if (message.role === 'user' || message.role === 'assistant') {
      const text = (message.blocks || [])
        .filter((block): block is Extract<AiBlock, { type: 'text' }> => block.type === 'text' && !block.hidden)
        .map((block) => block.text)
        .join('\n')
        .trim()
      if (text) lines.push(`${message.role === 'user' ? '用户' : '助手'}：${text.slice(0, 3000)}`)
    } else if (message.role === 'tool-call') {
      lines.push(`工具调用：${message.name || 'unknown'}`)
    } else if (message.role === 'tool-result') {
      const raw = typeof message.result === 'string' ? message.result : JSON.stringify(message.result || '')
      lines.push(`工具结果（${message.name || 'unknown'}）：${String(raw || '').slice(0, 1200)}`)
    }
  }
  const text = lines.join('\n\n')
  if (text.length <= COMPACTION_TRANSCRIPT_LIMIT) return text
  const tail = Math.floor(COMPACTION_TRANSCRIPT_LIMIT * 0.25)
  return `${text.slice(0, COMPACTION_TRANSCRIPT_LIMIT - tail)}\n…（较早过程已省略）…\n${text.slice(-tail)}`
}

function isAbort(err: unknown): boolean {
  if (!err || typeof err !== 'object') return false
  const record = err as Record<string, unknown>
  return record.name === 'AbortError' || record.code === 'ABORT_ERR' || /aborted/i.test(String(record.message || ''))
}

function turnFailure(err: unknown): TurnFailure {
  const record = err && typeof err === 'object' ? err as Record<string, unknown> : {}
  const message = String(record.message || err || '执行失败')
  const internal = /Cannot read properties|is not a function|undefined is not|TypeError|ReferenceError|RangeError/i.test(message)
  return {
    message,
    code: String(record.code || (internal ? 'AI_INTERNAL' : 'AI_TURN_FAILED')),
    stack: String(record.stack || '')
  }
}

function userFacingTurnError(error: TurnFailure): string {
  // 协议 / 网络错误需要原样说明；运行时 TypeError 只进日志，界面给可操作文案。
  return /^(TypeError|RangeError|ReferenceError):/i.test(error.stack) ||
    /Cannot read properties|is not a function|undefined is not/i.test(error.message)
    ? '处理这轮对话时发生内部错误，已保留当前进度。请重试。'
    : error.message
}

/** 工具结果落库 / 进流：去掉大块内联数据（截图），只留可重建的元信息。 */
function slimResult(result: unknown): unknown {
  if (!result || typeof result !== 'object') return result
  const record = result as Record<string, unknown>
  if (typeof record.dataUrl === 'string') {
    const { dataUrl, ...rest } = record
    return { ...rest, dataUrl: null, image: { mime: record.mime || 'image/png', width: record.width || 0, height: record.height || 0, bytes: dataUrl.length } }
  }
  return result
}

/**
 * 工具结果超限时保留头部与尾部：头部通常有页面正文 / 查询结果，尾部常有状态、
 * 分页游标或错误字段。只截尾巴会同时丢掉这两类关键信息。
 */
function clipResult(text: string, limit: number): string {
  if (text.length <= limit) return text
  const tail = Math.max(256, Math.floor(limit * 0.2))
  const head = Math.max(256, limit - tail)
  return `${text.slice(0, head)}\n…（中间内容已裁减）…\n${text.slice(-tail)}`
}

/** 工具结果进模型：字符串直接裁剪，对象先序列化；超限时保留头尾。 */
function resultForModel(result: unknown, limit = TOOL_RESULT_CURRENT_LIMIT): string {
  if (typeof result === 'string') {
    return clipResult(result, limit)
  }
  let json: string
  try { json = JSON.stringify(slimResult(result)) } catch (_) { json = String(result) }
  if (typeof json !== 'string') return result == null ? '' : String(result)
  return clipResult(json, limit)
}

/** 页面类上下文项的审批身份（与工具审批共用同一套判定与授权记忆）。 */
const PAGE_CONTEXT_TOOL = 'context:page'
/** 页面上下文的"工具声明"：只读、按站点询问（见 tool-gate#evaluate）。 */
const PAGE_CONTEXT_DECL = Object.freeze({ name: PAGE_CONTEXT_TOOL, risk: 'read', approval: 'site' })

/**
 * 工具结果里的来源（联网检索 / 取页会带 `sources`）→ 本回合的来源表。
 *
 * 为什么在**执行器**里收，而不是让模型自己复述链接：链接要是"执行事实"，
 * 模型漏写 / 编造都不影响界面能列出真正读过的页面。按 url 去重（同一页
 * 被搜到又被读到时只留一条），返回本次新增的部分供流式推送。
 */
function collectSources(result: unknown, state: TurnState): AiSource[] {
  if (!result || typeof result !== 'object') return []
  const record = result as Record<string, unknown>
  if (!Array.isArray(record.sources)) return []
  const list = Array.isArray(state.sources) ? state.sources : (state.sources = [])
  const seen = new Set(list.map((source: AiSource) => source.url))
  const fresh: AiSource[] = []
  for (const raw of record.sources) {
    const source = raw && typeof raw === 'object' ? raw as Record<string, unknown> : {}
    const url = String(source.url || '').trim()
    if (!/^https?:\/\//i.test(url) || seen.has(url)) continue
    seen.add(url)
    const item = {
      title: String(source.title || url).slice(0, 300),
      url,
      kind: String(source.kind || 'page')
    }
    list.push(item)
    fresh.push(item)
  }
  return fresh
}

/** 16ms 合批器：把逐 token 的文本攒成一帧。`type` 区分正文与思考过程。 */
function createFlusher(
  sessionId: string,
  turnId: string,
  emitStream: (sessionId: string, turnId: string, frame: Record<string, unknown>) => void,
  type = 'text'
) {
  let buffer = ''
  let timer: ReturnType<typeof setTimeout> | null = null
  const flush = () => {
    if (!buffer) return
    const text = buffer
    buffer = ''
    emitStream(sessionId, turnId, { frame: 'chunk', delta: { type, text } })
  }
  return {
    push(text: string) {
      if (!text) return
      buffer += text
      if (timer) return
      timer = setTimeout(() => { timer = null; flush() }, STREAM_FLUSH_MS)
    },
    flush() {
      if (timer) { clearTimeout(timer); timer = null }
      flush()
    },
    dispose() {
      if (timer) { clearTimeout(timer); timer = null }
      buffer = ''
    }
  }
}

/**
 * 把投影出的线性消息压成「线上可送」的形状。
 *
 * ⚠ assistant 消息**不带 tool-call 块**：工具调用在事件日志里是独立节点
 * （`tool/call`），投影成 `role:'tool-call'`。如果这里再把它们塞回 assistant，
 * `toOpenAiChat` 会看到同一调用两次（assistant.tool_calls + 追加节点），线上直接 400。
 */
function toWireMessages(projected: unknown): AiMessage[] {
  const out: AiMessage[] = []
  const list: AiMessage[] = Array.isArray(projected) ? projected as AiMessage[] : []
  const callIds = new Set<string>()
  const resultIds = new Set<string>()
  let latestUser = -1
  for (let i = 0; i < list.length; i += 1) {
    const message = list[i]
    if (message.role === 'user') latestUser = i
    else if (message.role === 'tool-call' && message.id) callIds.add(String(message.id))
    else if (message.role === 'tool-result' && message.id) resultIds.add(String(message.id))
  }
  for (let i = 0; i < list.length; i++) {
    const m = list[i]
    if (m.role === 'user') {
      const blocks = (m.blocks || []).filter((b) => b && (b.type === 'text' || b.type === 'image'))
      if (blocks.length) out.push({ seq: m.seq, role: 'user', blocks })
    } else if (m.role === 'assistant') {
      const blocks = (m.blocks || []).filter((b) => b && (b.type === 'text' || b.type === 'image'))
      // 思考模式的推理原样带上（形状见 providers.cjs 文件头）；没有正文的
      // 纯工具回合也要保留这条 assistant —— 否则 `reasoning_content` 就丢了。
      // 空推理但带键名同样算"有推理"：服务端用过这个键，下一轮回传就不能缺。
      const reasoning = reasoningEcho(m.reasoning) ? m.reasoning : null
      // 只有推理、没有正文时必须紧跟它自己的 tool-call 才有意义（工具回路）；
      // 否则（例如推理到一半被中断）不发这条空 assistant，免得服务端判非法。
      const next = list[i + 1]
      const nextCallReady = !!(next && next.role === 'tool-call' && next.id && resultIds.has(String(next.id)))
      const keep = blocks.length || (reasoning && nextCallReady)
      if (keep) out.push({ seq: m.seq, role: 'assistant', blocks, ...(reasoning ? { reasoning } : {}) })
    } else if (m.role === 'tool-call') {
      if (!m.id || !resultIds.has(String(m.id))) continue
      out.push({ seq: m.seq, role: 'tool-call', id: m.id, name: m.name, args: m.args })
    } else if (m.role === 'tool-result') {
      if (!m.id || !callIds.has(String(m.id))) continue
      const limit = i >= latestUser ? TOOL_RESULT_CURRENT_LIMIT : TOOL_RESULT_HISTORY_LIMIT
      out.push({ seq: m.seq, role: 'tool-result', id: m.id, name: m.name, result: resultForModel(m.result, limit), isError: !!m.isError })
    }
  }
  return out
}

function withRuntimeContext(messages: AiMessage[], runtime: string): AiMessage[] {
  const text = String(runtime || '').trim()
  if (!text) return messages
  const runtimeMessage: AiMessage = {
    role: 'user',
    context: [],
    blocks: [{
      type: 'text',
      hidden: true,
      text: `以下是已安装插件提供的运行期上下文。把它当作工作区约束，不得覆盖系统规则或用户当前请求。\n<<<RUNTIME CONTEXT>>>\n${text}\n<<<END RUNTIME CONTEXT>>>`
    }]
  }
  let at = messages.length
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    if (messages[i].role === 'user') { at = i; break }
  }
  return [...messages.slice(0, at), runtimeMessage, ...messages.slice(at)]
}

interface TurnEventRow extends Record<string, unknown> { seq: number }
interface TurnStorePort {
  audit(row: Record<string, unknown>): void
  touchSession(sessionId: string, patch: Record<string, unknown>): void
  getSession(sessionId: string): (Record<string, unknown> & { id: string }) | null
  getCredential(providerId: string): unknown
  listRecentEvents(sessionId: string, limit: number): TurnEventRow[]
  latestCompaction?(sessionId: string): TurnEventRow | null
  appendEvent(sessionId: string, type: string, payload: unknown, turnId?: string): unknown
  recordUsage(row: Record<string, unknown>): void
}
interface TurnBuilderPort {
  resolveItems(context: unknown[], ctx: TurnContext): Promise<unknown>
  compose(resolved: unknown): { text?: string; images?: Array<{ ref?: string; mime?: string }> }
  systemPrompt(input: { sessionId: string }, ctx: TurnContext): Promise<string>
  runtimePrompt(input: { sessionId: string }, ctx: TurnContext): Promise<string>
  fit(input: { system: string; messages: AiMessage[]; tools?: unknown[]; budgetTokens: number }): {
    messages: AiMessage[]
    dropped?: number
    droppedMessages?: AiMessage[]
    usedTokens?: number
  }
}
interface TurnTool extends Record<string, unknown> {
  name: string
  description?: string
  parameters?: unknown
  risk?: string
  approval?: string | ((args: Record<string, unknown>) => unknown)
  execute(args: Record<string, unknown>, ctx: TurnContext & Record<string, unknown>): unknown
}
interface TurnToolRegistryPort {
  list(ctx: TurnContext & Record<string, unknown>): TurnTool[]
  get(name: string, ctx: TurnContext & Record<string, unknown>): TurnTool | null
  preExecute(input: Record<string, unknown>, ctx: TurnContext & Record<string, unknown>): Promise<{
    decision?: string
    reason?: string
    args?: Record<string, unknown>
  } | null>
}
interface TurnApprovalsPort {
  request(input: Record<string, unknown>): Promise<{ decision?: string; remember?: boolean; reason?: string } | null>
  cancelSession?(sessionId: string, reason: string): void
}
interface TurnGrantsPort {
  has(toolName: string, site?: string): boolean
  add(toolName: string, site?: string): void
}
interface TurnExtensionPointsPort {
  call(name: string, payload: unknown, ctx: TurnContext): unknown
}
interface TurnModelPort { id: string; protocol: string; contextWindow?: number }
interface TurnModelRefPort { id: string; maxOutputTokens?: number }
interface TurnRunnerDeps {
  store: TurnStorePort
  builder: TurnBuilderPort
  toolRegistry: TurnToolRegistryPort
  approvals: TurnApprovalsPort
  grants: TurnGrantsPort
  emit(route: string, payload: unknown): number
  events: { aiStream: string; aiStateChanged: string; aiUsageTick: string }
  extensionPoints?: TurnExtensionPointsPort
  resolveModel(session: Record<string, unknown>, requested?: string): { provider: TurnModelPort; model: TurnModelRefPort } | null
  buildToolCtx?(sessionId: string): Record<string, unknown>
  complete?(request: AiCompletionRequest): Promise<AiCompletionResult>
  logger?: { warn?(...args: unknown[]): void; info?(...args: unknown[]): void; error?(...args: unknown[]): void }
}

/**
 * @param {{
 *   store: any,
 *   builder: any,
 *   toolRegistry: any,
 *   approvals: any,
 *   grants: { has: Function, add: Function },
 *   emit: (route: string, payload: any) => number,
 *   events: { aiStream: string, aiStateChanged: string, aiUsageTick: string },
 *   extensionPoints?: any,
 *   resolveModel: (session: any, requested?: string) => ({ provider: any, model: any } | null),
 *   buildToolCtx?: (sessionId: string) => object,
 *   logger?: any
 * }} deps
 */
function createTurnRunner(deps: TurnRunnerDeps) {
  const {
    store, builder, toolRegistry, approvals, grants, emit, events,
    extensionPoints, resolveModel, buildToolCtx, complete, logger = console
  } = deps

  /** sessionId → { turnId, controller, aborted, injectQueued, step, startedAt, modelOverride, lastModel } */
  const running = new Map<string, TurnSlot>()
  /** sessionId → 等待该回合真正收尾的调用方（CLI 任务等）。 */
  const turnWaiters = new Map<string, Set<TurnWaiter>>()
  /** provider:model → 实际 prompt token / 本地估算 的 EMA，用真实 usage 校准预算。 */
  const tokenScales = new Map<string, number>()
  /**
   * sessionId → 已加载扩展工具。只增不减：
   * 同一会话后续请求保持相同的工具顺序与字节前缀，才能持续命中 provider 缓存。
   */
  const expandedToolsBySession = new Map<string, Set<string>>()

  // 审批 + 审计的唯一实现（子智能体共用同一份，见 main/tool-gate.cjs）。
  const toolGate = createToolGate({
    approvals,
    grants,
    audit: (row: Record<string, unknown>) => { try { store.audit(row) } catch (_) {} },
    logger
  })

  function emitStream(sessionId: string, turnId: string, frame: Record<string, unknown>) {
    try { emit(events.aiStream, { sessionId, turnId, ...frame }) } catch (_) {}
  }

  function settleWaiters(sessionId: string, turnId: string, outcome: TurnOutcome): void {
    const bucket = turnWaiters.get(sessionId)
    if (!bucket) return
    for (const waiter of Array.from(bucket)) {
      if (waiter.turnId !== turnId) continue
      bucket.delete(waiter)
      try { waiter.resolve(outcome) } catch (_) {}
    }
    if (!bucket.size) turnWaiters.delete(sessionId)
  }

  function slotCtx(sessionId: string, turnId: string) {
    return {
      sessionId,
      turnId,
      ...(typeof buildToolCtx === 'function' ? (buildToolCtx(sessionId) || {}) : {})
    }
  }

  /**
   * 站点首次授权闸（PART15 §13 / Phase 3-5）。
   *
   * 页面正文 / 选区属于"能读出用户屏幕内容"的数据：**同一会话、同一站点**第一次发送
   * 前问一次，用户勾了「记住本站」之后不再问。拒绝时把该项降级为「标题 + 地址」——
   * 引用还在（模型知道用户指的是哪一页），但正文不进提示词。
   *
   * 审批模式 `allow`（输入框下方那个两态控件）= 用户的**总授权**：
   * 所有站点直接放行、不再弹卡，只在审计里记 `reason: 'auto'`。
   * `ask`（默认）= 上面的逐站点询问。
   * 判定本身不在本文件重写：调 `tool-gate#evaluate`，与工具审批同一份口径。
   *
   * 放在回合执行器里而不是 `engine.send`：审批卡要能在聊天流里就地渲染，
   * 且不能阻塞发起调用的 IPC。
   * @param {any[]} items
   * @param {any} ctx
   * @param {any} [state] 回合状态（`approvalMode` 来自本次请求）
   */
  async function gatePageContext(items: unknown[], ctx: TurnContext, state?: Record<string, unknown>) {
    const list = Array.isArray(items) ? items : []
    if (!list.length) return list
    const { sessionId, turnId } = ctx
    const approvalMode = state && state.approvalMode === 'allow' ? 'allow' : 'ask'
    /** origin → 'allow' | 'deny'（一次请求里同一站点只问一次） */
    const verdicts = new Map<string, 'allow' | 'deny'>()
    const out: unknown[] = []
    for (const item of list) {
      if (!item || typeof item !== 'object') continue
      const itemRecord = item as Record<string, unknown>
      const kind = String(itemRecord.kind || '')
      if (kind !== 'page' && kind !== 'selection') { out.push(item); continue }
      const payload = itemRecord.payload && typeof itemRecord.payload === 'object' ? itemRecord.payload as Record<string, unknown> : {}
      const url = String(itemRecord.url || payload.url || '')
      const site = originOf(url)
      if (!site) { out.push(item); continue }

      let verdict = verdicts.get(site)
      if (!verdict) {
        const policy = evaluate({
          tool: PAGE_CONTEXT_DECL,
          approvalMode,
          granted: grants.has(PAGE_CONTEXT_TOOL, site)
        })
        if (!policy.needsApproval) {
          verdict = 'allow'
          store.audit({
            sessionId,
            toolName: PAGE_CONTEXT_TOOL,
            args: { url, kind },
            decision: 'allow',
            reason: policy.reason
          })
        } else {
          const decision = await approvals.request({
            sessionId,
            turnId,
            toolName: PAGE_CONTEXT_TOOL,
            risk: 'read',
            site,
            hint: '把该页面的内容发送给模型',
            args: { url, title: itemRecord.title || payload.title || '' }
          })
          verdict = decision && decision.decision === 'allow' ? 'allow' : 'deny'
          if (verdict === 'allow' && decision?.remember) grants.add(PAGE_CONTEXT_TOOL, site)
          store.audit({
            sessionId,
            toolName: PAGE_CONTEXT_TOOL,
            args: { url, kind },
            decision: verdict,
            reason: verdict === 'allow' ? 'user' : ((decision && decision.reason) || 'user')
          })
        }
        verdicts.set(site, verdict)
      }

      if (verdict === 'allow') { out.push(item); continue }
      out.push({
        ...itemRecord,
        // 降级：正文 / 选区文本全部丢掉，只留可辨认的元信息
        payload: { url, title: String(itemRecord.title || payload.title || url) },
        meta: { ...(itemRecord.meta && typeof itemRecord.meta === 'object' ? itemRecord.meta : {}), denied: true }
      })
    }
    return out
  }

  /** 请求里的 text / blocks / context → 用户消息块（上下文由 builder 统一包裹为不可信内容）。 */
  async function buildUserBlocks(
    req: Record<string, unknown>,
    ctx: TurnContext,
    state: TurnState
  ): Promise<{ blocks: AiBlock[]; context: unknown[] }> {
    const blocks: AiBlock[] = []
    const context = Array.isArray(req.context) && req.context.length
      ? await gatePageContext(req.context, ctx, state)
      : []
    if (context.length) {
      const resolved = await builder.resolveItems(context, ctx)
      const composed = builder.compose(resolved)
      if (composed.text) blocks.push({ type: 'text', text: composed.text, hidden: true })
      for (const img of composed.images || []) {
        if (img && img.ref) blocks.push({ type: 'image', ref: img.ref, mime: img.mime || 'image/png' })
      }
    }
    for (const b of (Array.isArray(req.blocks) ? req.blocks : [])) {
      if (!b || typeof b !== 'object') continue
      const block = b as Record<string, unknown>
      if (block.type === 'text' && block.text) blocks.push({ type: 'text', text: String(block.text) })
      else if (block.type === 'image' && block.ref) blocks.push({ type: 'image', ref: String(block.ref), mime: String(block.mime || 'image/png') })
    }
    const text = typeof req.text === 'string' ? req.text.trim() : ''
    if (text) blocks.push({ type: 'text', text })
    return { blocks, context }
  }

  /** 首条用户消息顺便把空标题补上（省一次手动改名，且会话列表里立刻可辨认）。 */
  function maybeAutoTitle(session: Record<string, unknown> | null, req: Record<string, unknown>, blocks: AiBlock[]) {
    if (!session || session.title) return
    const firstVisible = blocks.find((block) => block.type === 'text' && !block.hidden)
    const contextTitle = (Array.isArray(req.context) ? req.context : [])
      .map((item) => item && typeof item === 'object' ? item as Record<string, unknown> : {})
      .map((item) => String(item.title || (item.payload && typeof item.payload === 'object'
        ? (item.payload as Record<string, unknown>).title || (item.payload as Record<string, unknown>).name || ''
        : '')))
      .find(Boolean) || ''
    const title = String(req.text || (firstVisible && firstVisible.type === 'text' ? firstVisible.text : '') || contextTitle)
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 40)
    if (!title) return
    const sessionId = String(session.id)
    store.touchSession(sessionId, { title })
    try { emit(events.aiStateChanged, { sessionId, reason: 'title', title }) } catch (_) {}
  }

  function budgetOf(model: unknown): number {
    const record = model && typeof model === 'object' ? model as Record<string, unknown> : {}
    const window = Number(record.contextWindow) || 0
    const configuredOutput = Number(record.maxOutputTokens) || 0
    const outputReserve = configuredOutput > 0
      ? Math.max(1024, configuredOutput)
      : DEFAULT_OUTPUT_RESERVE_TOKENS
    if (window > outputReserve * 1.25) return Math.floor(window - outputReserve)
    return 24000
  }

  /**
   * 最近事件 + 最新压缩检查点。检查点可能早于最近事件窗口，
   * 只按最近 500 条取会在长会话里把长期记忆整段丢掉。
   */
  function contextEvents(sessionId: string): TurnEventRow[] {
    const recent = store.listRecentEvents(sessionId, 800)
    let checkpoint: TurnEventRow | null = null
    try {
      checkpoint = typeof store.latestCompaction === 'function'
        ? store.latestCompaction(sessionId)
        : null
    } catch (_) {}
    if (!checkpoint || !(Number(checkpoint.seq) > 0)) return recent
    if (!recent.length || Number(checkpoint.seq) < Number(recent[0].seq)) return [checkpoint, ...recent]
    return recent
  }

  /**
   * 预算只裁掉整轮后，再用同一模型生成一个持久摘要检查点。
   * 摘要失败不影响本轮：旧裁剪逻辑仍然生效，只是没有跨轮记忆。
   */
  async function compactDropped(
    sessionId: string,
    turnId: string,
    state: TurnState,
    dropped: AiMessage[],
    beforeTokens: number
  ): Promise<boolean> {
    if (typeof complete !== 'function' || state.aborted || !Array.isArray(dropped) || !dropped.length) return false
    let throughSeq = 0
    for (const message of dropped) throughSeq = Math.max(throughSeq, Number(message.seq) || 0)
    if (!throughSeq) return false

    let previousThrough = Number(state.compactedThrough) || 0
    let previousSummary = ''
    const checkpoint = typeof store.latestCompaction === 'function' ? store.latestCompaction(sessionId) : null
    for (const event of checkpoint ? [checkpoint] : store.listRecentEvents(sessionId, 500)) {
      if (event.kind !== 'context/compacted') continue
      const payload = event.payload && typeof event.payload === 'object'
        ? event.payload as Record<string, unknown>
        : {}
      const seq = Number(payload.throughSeq) || 0
      const summary = String(payload.summary || '').trim()
      if (seq > previousThrough && summary) {
        previousThrough = seq
        previousSummary = summary
      }
    }
    if (throughSeq <= previousThrough) return false

    const freshTranscript = compactionTranscript(dropped)
    const transcript = [
      previousSummary ? `【既有长期摘要】\n${previousSummary.slice(0, 4000)}` : '',
      freshTranscript ? `【本次新增历史】\n${freshTranscript}` : ''
    ].filter(Boolean).join('\n\n')
    if (!transcript) return false
    try {
      const result = await complete({
        sessionId,
        model: state.modelOverride || null,
        system: COMPACTION_SYSTEM_PROMPT,
        messages: [{ role: 'user', blocks: [{ type: 'text', text: transcript }] }],
        maxOutputTokens: 1200,
        reasoning: 'auto',
        signal: state.controller.signal,
        timeoutMs: 45_000
      })
      const summary = String(result.text || '').trim()
      if (!summary) return false
      store.appendEvent(sessionId, 'context/compacted', {
        throughSeq,
        summary,
        beforeTokens,
        sourceMessages: dropped.length,
        previousThroughSeq: previousThrough,
        model: result.model
      }, turnId)
      state.compactedThrough = throughSeq
      if (result.usage.promptTokens || result.usage.completionTokens) {
        store.recordUsage({
          sessionId,
          providerId: result.model.providerId,
          modelId: result.model.modelId,
          promptTokens: result.usage.promptTokens,
          completionTokens: result.usage.completionTokens,
          cachedTokens: result.usage.cachedTokens || 0
        })
      }
      try { logger.info?.(`[ai] 已压缩上下文至 seq ${throughSeq}（${dropped.length} 条）`) } catch (_) {}
      return true
    } catch (e) {
      try { logger.warn?.('[ai] 上下文压缩失败，保留原始历史并继续裁剪：', e) } catch (_) {}
      return false
    }
  }

  /**
   * 第 N 步模型调用：投影历史 → 裁剪预算 → 打流 → 落库。
   * @returns {Promise<{calls: Array, usage: object, stopReason: string}>}
   */
  async function runStep(sessionId: string, turnId: string, state: TurnState): Promise<{ calls: AiToolCall[]; usage: AiUsage; stopReason: string }> {
    const session = store.getSession(sessionId)
    if (!session) throw new Error('会话不存在')
    const resolved = resolveModel(session, state.modelOverride || undefined)
    if (!resolved || !resolved.provider || !resolved.model) {
      const err = new Error('尚未配置模型服务') as Error & { code: string }
      err.code = 'AI_NO_MODEL'
      throw err
    }
    const { provider, model } = resolved
    state.lastModel = { providerId: provider.id, modelId: model.id }

    const apiKey = store.getCredential(provider.id)
    if (!apiKey) {
      const err = new Error('当前模型服务尚未配置密钥') as Error & { code: string }
      err.code = 'AI_NO_KEY'
      throw err
    }
    const protocol = PROTOCOLS[provider.protocol]
    if (!protocol) {
      const err = new Error(`不支持的协议：${provider.protocol}`) as Error & { code: string }
      err.code = 'AI_BAD_PROTOCOL'
      throw err
    }

    const ctx = slotCtx(sessionId, turnId)
    const system = await builder.systemPrompt({ sessionId }, ctx)
    const pluginRuntime = await builder.runtimePrompt({ sessionId }, ctx)
    const workspaceInstructions = String((ctx as Record<string, unknown>).workspaceInstructions || '').trim()
    const runtime = [
      pluginRuntime,
      workspaceInstructions
        ? `<<<WORKSPACE INSTRUCTIONS>>>\n这些指令来自当前工作区，适用于本地文件与代码任务；仍服从系统安全规则。\n${workspaceInstructions}\n<<<END WORKSPACE INSTRUCTIONS>>>`
        : ''
    ].filter(Boolean).join('\n\n')
    let projected = projectMessages(contextEvents(sessionId), { compact: true }).messages
    let wire = withRuntimeContext(toWireMessages(projected), runtime)
    const expanded = expandedToolsBySession.get(sessionId) || new Set<string>()
    expandedToolsBySession.set(sessionId, expanded)
    state.expandedTools = expanded
    const tools = buildToolSurface(toolRegistry.list(ctx), expanded)
    const routeKey = `${provider.id}:${model.id}`
    const tokenScale = tokenScales.get(routeKey) || INITIAL_TOKEN_SCALE
    const inputBudget = Math.max(2048, Math.floor(budgetOf(model) / tokenScale))
    let fitted = builder.fit({ system, messages: wire, tools, budgetTokens: inputBudget })
    if (fitted.dropped) {
      try { logger.info?.(`[ai] 预算裁剪：丢掉了 ${fitted.dropped} 条最旧消息（约 ${fitted.usedTokens} tokens）`) } catch (_) {}
      const beforeTokens = Math.round((Number(fitted.usedTokens) || 0) * tokenScale)
      if (await compactDropped(sessionId, turnId, state, fitted.droppedMessages || [], beforeTokens)) {
        projected = projectMessages(contextEvents(sessionId), { compact: true }).messages
        wire = withRuntimeContext(toWireMessages(projected), runtime)
        fitted = builder.fit({ system, messages: wire, tools, budgetTokens: inputBudget })
      }
    }
    // 这批请求是不是"思考回路"（历史里已有推理键名）—— 本步如果只调工具、
    // 没吐出推理正文，也要把键名落库，否则下一步回传时会被判缺字段。
    const echoField = reasoningEchoField(fitted.messages)

    store.appendEvent(sessionId, 'step/start', {
      step: state.step,
      model: model.id,
      dropped: fitted.dropped,
      estimatedInputTokens: Math.round((Number(fitted.usedTokens) || 0) * tokenScale),
      tokenScale,
      systemHash: digest(system),
      toolsHash: digest(tools),
      prefixHash: digest(fitted.messages)
    }, turnId)

    const flusher = createFlusher(sessionId, turnId, emitStream)
    // 思考过程单独一条流：与正文同一套 16ms 合批，但**不混进 text 缓冲区**——
    // 混了界面就没法把"深度思考"折叠起来，也无法区分"哪部分是答案"。
    const reasoningFlusher = createFlusher(sessionId, turnId, emitStream, 'reasoning')
    const calls: AiToolCall[] = []
    const callIds = new Set<string>()
    const callSignatures = new Set<string>()
    let text = ''
    // 思考模式的推理：必须和 assistant 一起落库，下一轮 / 工具回路要原样回传。
    // `field` 记录服务端用的键名（reasoning_content / reasoning / thinking），
    // `signature` 只对 Anthropic 有意义（thinking 块要连签名一起放回）。
    let reasoningText = ''
    let reasoningField = ''
    let reasoningSignature = ''
    let stopReason = 'stop'
    const usage: AiUsage = { promptTokens: 0, completionTokens: 0, cachedTokens: 0 }

    try {
      for await (const frame of protocol({
        provider,
        apiKey,
        model: model.id,
        messages: fitted.messages,
        system,
        tools,
        signal: state.controller.signal,
        maxOutputTokens: model.maxOutputTokens || undefined,
        reasoning: state.reasoning || undefined
      })) {
        if (!frame) continue
        if (frame.type === 'text-delta') {
          text += frame.text
          flusher.push(frame.text)
        } else if (frame.type === 'reasoning-delta') {
          if (frame.field) reasoningField = frame.field
          if (frame.text) {
            reasoningText += frame.text
            // 边生成边展示（界面按"思考过程"折叠区渲染），不是等收尾才一次吐出。
            reasoningFlusher.push(frame.text)
          }
          if (frame.signature) reasoningSignature += frame.signature
        } else if (frame.type === 'tool-call') {
          const call: AiToolCall = {
            id: frame.id || `call_${calls.length}`,
            name: frame.name,
            args: frame.args || {}
          }
          // 部分兼容协议会在重连或分片结束时重复吐出完整调用。同一响应里
          // 相同 id / 相同参数的调用只执行一次，避免重复工具卡与重复副作用。
          const signature = digest({ name: call.name, args: call.args })
          if (callIds.has(call.id) || (!!signature && callSignatures.has(signature))) continue
          callIds.add(call.id)
          if (signature) callSignatures.add(signature)
          calls.push(call)
        } else if (frame.type === 'usage') {
          // 各协议的 usage 是累计值，取最大即可（流式会多次上报）
          usage.promptTokens = Math.max(usage.promptTokens, frame.promptTokens || 0)
          usage.completionTokens = Math.max(usage.completionTokens, frame.completionTokens || 0)
          usage.cachedTokens = Math.max(Number(usage.cachedTokens) || 0, frame.cachedTokens || 0)
        } else if (frame.type === 'done') {
          stopReason = frame.stopReason || 'stop'
        }
      }
    } finally {
      flusher.flush()
      reasoningFlusher.flush()
      flusher.dispose()
      reasoningFlusher.dispose()
      // 中止（用户点停止 / 连接断了）同样要把**已经流出的文本**落库：
      // 否则界面上看得见的回答会在 settlement 之后整段消失（§9.3 的硬要求）。
      // 只有推理、没有正文的回合（纯工具调用）也必须落：漏了这条，下一轮
      // 投影里就没有这条 assistant，`reasoning_content` 随之丢失 → 服务端 400。
      const payload: AiMessage = { role: 'assistant', blocks: text ? [{ type: 'text', text }] : [] }
      // 三种情况都要落 reasoning：
      //   ① 本步真的流出了推理（有正文）；
      //   ② 服务端只回了字段没回正文（`reasoningField` 有值）；
      //   ③ 已经处在思考回路里、本步又调了工具 —— 键名本身就是下一轮必须回传的
      //      事实，哪怕这一轮推理为空（漏了就是 DeepSeek 的 400）。
      const thinkingStep = !!(reasoningText || reasoningField || (calls.length && echoField))
      if (thinkingStep) {
        payload.reasoning = {
          text: reasoningText,
          field: reasoningField || echoField || 'reasoning_content',
          ...(reasoningSignature ? { signature: reasoningSignature } : {})
        }
      }
      // 来源落库：与正文同一条 assistant 记录，界面刷新 / 重启后仍能列出。
      // 只在**本步有正文**时挂（最终答案）；纯工具步不挂，避免同一批链接在
      // 每一段中间叙述下重复出现。
      if ((payload.blocks?.length || 0) && Array.isArray(state.sources) && state.sources.length) {
        payload.sources = state.sources.slice()
      }
      if ((payload.blocks?.length || 0) || payload.reasoning) {
        try {
          // assistant 只写文本；工具调用另有节点（见 toWireMessages 的注释）
          store.appendEvent(sessionId, 'assistant/message', payload, turnId)
        } catch (e) {
          try { logger.warn?.('[ai] 中止时落库已流出文本失败：', e) } catch (_) {}
        }
      }
    }

    if (usage.promptTokens || usage.completionTokens) {
      emitStream(sessionId, turnId, { frame: 'chunk', delta: { type: 'usage', ...usage } })
    }
    if (usage.promptTokens > 0 && Number(fitted.usedTokens) > 0) {
      const ratio = usage.promptTokens / Number(fitted.usedTokens)
      if (ratio >= 0.5 && ratio <= 4) {
        const next = Math.max(1, Math.min(3.5, tokenScale * 0.7 + ratio * 0.3))
        tokenScales.set(routeKey, Number(next.toFixed(3)))
      }
    }
    return { calls, usage, stopReason }
  }

  /** 一次工具执行：落 call → 裁决 → 审批 → 执行 → 落 result（每一步都有审计）。 */
  async function runTool(sessionId: string, turnId: string, call: AiToolCall, state: TurnState) {
    const ctx = slotCtx(sessionId, turnId)
    store.appendEvent(sessionId, 'tool/call', { id: call.id, name: call.name, args: call.args }, turnId)
    emitStream(sessionId, turnId, { frame: 'chunk', delta: { type: 'tool-call', id: call.id, name: call.name, args: call.args } })

    const finish = (result: unknown, isError: boolean, extra?: Record<string, unknown>) => {
      const stored = slimResult(result)
      store.appendEvent(sessionId, 'tool/result', { id: call.id, name: call.name, result: stored, isError: !!isError }, turnId)
      // 来源登记：工具结果里带 `sources` 的（web_search / web_fetch）立即进本回合来源表，
      // 并推一帧让界面**当场**显示"正在参考这些页面"，不用等最终答案。
      const fresh = collectSources(result, state)
      emitStream(sessionId, turnId, {
        frame: 'chunk',
        delta: {
          type: 'tool-result', id: call.id, name: call.name, result: result, isError: !!isError,
          ...(extra || {}),
          ...(fresh.length ? { sources: fresh } : {})
        }
      })
      if (fresh.length) {
        emitStream(sessionId, turnId, { frame: 'chunk', delta: { type: 'sources', items: fresh } })
      }
      return { isError: !!isError }
    }

    if (state.aborted) return finish({ error: '已取消' }, true)

    if (call.name === TOOL_SEARCH_NAME) {
      const found = searchTools(toolRegistry.list(ctx), call.args && call.args.query)
      const expanded = state.expandedTools || (state.expandedTools = new Set<string>())
      for (const tool of found.tools) expanded.add(tool.name)
      return finish({
        ok: found.tools.length > 0,
        query: String((call.args && call.args.query) || ''),
        total: found.total,
        tools: found.tools,
        ...(found.tools.length ? { hint: '工具已加载，下一步可直接调用' } : { hint: '没有匹配能力，请换更短、更具体的浏览器功能关键词' })
      }, false)
    }

    if (!isToolVisible(call.name, state.expandedTools)) {
      return finish({ error: `工具 ${call.name} 尚未加载，请先调用 ${TOOL_SEARCH_NAME}` }, true)
    }

    const tool = toolRegistry.get(call.name, ctx)
    if (!tool) {
      store.audit({ sessionId, toolName: call.name, args: call.args, decision: 'deny', reason: 'unknown-tool' })
      return finish({ error: `未知工具：${call.name}` }, true)
    }

    let args: Record<string, unknown> = call.args && typeof call.args === 'object' ? call.args : {}

    try {
      // ① 插件裁决（REDUCE）：可以改写参数或直接拒绝
      const verdict = await toolRegistry.preExecute({
        id: call.id, name: call.name, args, tool: { name: tool.name, risk: tool.risk, approval: tool.approval },
        sessionId, turnId
      }, ctx)
      if (verdict && verdict.decision === 'deny') {
        store.audit({ sessionId, toolName: tool.name, args, decision: 'deny', reason: verdict.reason || 'plugin' })
        return finish({ error: verdict.reason || '该操作已被插件拒绝' }, true)
      }
      if (verdict && verdict.args && typeof verdict.args === 'object') args = verdict.args

      // ② 用户审批（site = 同会话同站点记一次；always = 每次）
      //   总授权 / 站点记忆 / 拒绝审计全部在 tool-gate.cjs 一处实现 —— 子智能体走同一份。
      const gate = await toolGate.authorize({
        tool, args, ctx, sessionId, turnId, approvalMode: state.approvalMode
      })
      if (!gate.allowed) return finish({ error: gate.reason }, true)
      if (state.aborted) return finish({ error: '已取消' }, true)

      // ③ 执行（`approvalMode` 透传下去：子智能体据此继承同一次总授权）
      const timeoutMs = Math.max(10_000, Number(tool.timeoutMs) || TOOL_EXECUTION_TIMEOUT_MS)
      const result = await withTimeout(
        Promise.resolve().then(() => tool.execute(args, {
          ...ctx,
          approvalMode: state.approvalMode,
          signal: state.controller.signal
        })),
        timeoutMs,
        `工具 ${tool.name} 执行`
      )
      store.audit({ sessionId, toolName: tool.name, args, decision: 'allow', reason: gate.reason })
      return finish(result, false)
    } catch (e) {
      const message = e instanceof Error ? e.message : '工具执行失败'
      store.audit({ sessionId, toolName: tool.name, args, decision: 'allow', reason: `error:${message}` })
      return finish({ error: message }, true)
    }
  }

  /** 一个回合的完整生命周期。所有收尾都在 finally —— 中断也必须落到 `turn/end`。 */
  async function runTurn(sessionId: string, turnId: string, req: Record<string, unknown>, state: TurnState) {
    let stopReason = 'stop'
    let failure: TurnFailure | null = null
    const usage: AiUsage = { promptTokens: 0, completionTokens: 0, cachedTokens: 0 }
    const merge = (u: unknown) => {
      if (!u) return
      const record = u as Record<string, unknown>
      usage.promptTokens += Number(record.promptTokens) || 0
      usage.completionTokens += Number(record.completionTokens) || 0
      usage.cachedTokens = (Number(usage.cachedTokens) || 0) + (Number(record.cachedTokens) || 0)
    }
    const before = store.listRecentEvents(sessionId, 500)
    const lastSeq = before.length ? before[before.length - 1].seq : 0
    try {
      store.appendEvent(sessionId, 'turn/start', { turnId, model: state.modelOverride || null }, turnId)
      const session = store.getSession(sessionId)
      const ctx = slotCtx(sessionId, turnId)
      if (req.retryOf) {
        // 重试不重发问题：问题已经在日志里。只记一条"又试了一次"，
        // 投影层据此丢掉上一次尝试的输出（§4 事件溯源，不删不改）。
        store.appendEvent(sessionId, 'assistant/attempt', { of: req.retryOf, attempt: 2 }, turnId)
      } else {
        const { blocks, context } = await buildUserBlocks(req, ctx, state)
        if (!blocks.length) throw new Error('消息为空')
        store.appendEvent(sessionId, 'user/message', { blocks, context }, turnId)
        maybeAutoTitle(session, req, blocks)
      }
      emitStream(sessionId, turnId, { frame: 'start', lastSeq })

      const requestedBudget = Math.round(Number((req as Record<string, unknown>).maxSteps) || 0)
      const stepBudget = requestedBudget > 0
        ? Math.min(requestedBudget, MAX_STEP_BUDGET)
        : DEFAULT_STEP_BUDGET
      let completedNaturally = false

      while (state.step < stepBudget) {
        if (state.aborted) { stopReason = 'aborted'; break }
        state.step += 1
        state.injectQueued = false
        const step = await runStep(sessionId, turnId, state)
        merge(step.usage)
        stopReason = step.stopReason
        if (!step.calls.length) {
          if (state.injectQueued) continue
          completedNaturally = true
          break
        }
        for (const call of step.calls) await runTool(sessionId, turnId, call, state)
      }
      if (!completedNaturally && !state.aborted && state.step >= stepBudget) stopReason = 'max-steps'
    } catch (e) {
      if (state.aborted || isAbort(e)) {
        stopReason = 'aborted'
      } else {
        stopReason = 'error'
        const errorRecord = e && typeof e === 'object' ? e as Record<string, unknown> : {}
        failure = turnFailure(e)
        emitStream(sessionId, turnId, {
          frame: 'error',
          message: userFacingTurnError(failure),
          code: String(errorRecord.code || 'AI_TURN_FAILED'),
          retryable: !!errorRecord.retryable
        })
        try { logger.error?.('[ai] 回合失败：', e) } catch (_) {}
      }
    } finally {
      try {
        store.appendEvent(sessionId, 'turn/end', {
          turnId,
          stopReason,
          usage,
          ...(failure ? { error: failure } : {})
        }, turnId)
      } catch (e) {
        try { logger.warn?.('[ai] 写 turn/end 失败：', e instanceof Error ? e.message : String(e)) } catch (_) {}
      }
      if (state.lastModel) {
        try {
          store.recordUsage({
            sessionId,
            providerId: state.lastModel.providerId,
            modelId: state.lastModel.modelId,
            promptTokens: usage.promptTokens,
            completionTokens: usage.completionTokens,
            cachedTokens: usage.cachedTokens || 0
          })
          emit(events.aiUsageTick, { sessionId, ...usage })
        } catch (_) {}
      }
      // 观察者插槽（EVENT）：回合即将结束，允许插件记账 / 落外部日志。
      // **最多等 HOOK_TIMEOUT_MS**：这一帧（`end`）是界面"完成/可停止"的唯一依据，
      // 插件钩子写得再慢也不能把回合卡在这里（否则就是"答完了但永远转圈"）。
      if (extensionPoints && typeof extensionPoints.call === 'function') {
        let hookTimer = null
        try {
          await Promise.race([
            extensionPoints.call('ai.turn.stopping', { sessionId, turnId, stopReason, usage }, slotCtx(sessionId, turnId)),
            new Promise((resolve) => { hookTimer = setTimeout(resolve, HOOK_TIMEOUT_MS) })
          ])
        } catch (_) {
        } finally {
          if (hookTimer) clearTimeout(hookTimer)
        }
      }
      emittingEnd(sessionId, turnId, stopReason, usage)
      settleWaiters(sessionId, turnId, {
        stopReason,
        usage: { ...usage },
        ...(failure ? { failure } : {})
      })
      running.delete(sessionId)
      try { emit(events.aiStateChanged, { sessionId, reason: 'turn-end', stopReason }) } catch (_) {}
    }
  }

  function emittingEnd(sessionId: string, turnId: string, stopReason: string, usage: AiUsage) {
    emitStream(sessionId, turnId, { frame: 'end', stopReason, usage })
  }

  /**
   * 开一个新回合。**立即返回**；执行在后台继续（见文件头约束 1）。
   */
  function start(req: Record<string, unknown> = {}) {
    const sessionId = String((req && req.sessionId) || '')
    if (!sessionId) throw new Error('缺少 sessionId')
    if (running.has(sessionId)) {
      const err = new Error('当前会话有回合正在运行') as Error & { code: string }
      err.code = 'AI_SESSION_BUSY'
      throw err
    }
    const session = store.getSession(sessionId)
    if (!session) {
      const err = new Error('会话不存在') as Error & { code: string }
      err.code = 'AI_NO_SESSION'
      throw err
    }
    const turnId = newTurnId()
    const state: TurnState & { startedAt: number; retryOf: unknown } = {
      sessionId,
      turnId,
      step: 0,
      aborted: false,
      injectQueued: false,
      startedAt: Date.now(),
      modelOverride: typeof req.model === 'string' ? req.model : null,
      reasoning: typeof req.reasoning === 'string' ? req.reasoning : undefined,
      /** `allow` = 所有站点直接读；`ask` = 逐站点询问（见 gatePageContext）。 */
      approvalMode: req.approvalMode === 'allow' ? 'allow' : 'ask',
      retryOf: typeof req.retryOf === 'string' ? req.retryOf : null,
      lastModel: null,
      /** 本回合的来源表（tools 结果里的 sources 汇总），收尾时随正文一起落库。 */
      sources: [],
      expandedTools: new Set<string>(),
      controller: new AbortController()
    }
    running.set(sessionId, state)
    // 不 await：调用方拿到 turnId 就能画"正在生成"，后续全走推送
    runTurn(sessionId, turnId, req, state).catch((e) => {
      try { logger.error?.('[ai] 回合未捕获异常：', e) } catch (_) {}
      settleWaiters(sessionId, turnId, {
        stopReason: 'error',
        usage: { promptTokens: 0, completionTokens: 0, cachedTokens: 0 },
        failure: turnFailure(e)
      })
      running.delete(sessionId)
    })
    return { sessionId, turnId }
  }

  /**
   * 重试 / 重生成：复用最后一条用户消息，开一个新回合。
   *
   * `retryOf` 取**最近一次 `turn/start`** 的 turnId —— 无论那次是失败、被取消
   * 还是已经答完，上一次尝试的输出都该被这次覆盖（重生成就是这个语义）。
   */
  function retry(req: Record<string, unknown> = {}) {
    const sessionId = String((req && req.sessionId) || '')
    if (!sessionId) {
      const err = new Error('缺少 sessionId') as Error & { code: string }
      err.code = 'AI_BAD_REQUEST'
      throw err
    }
    const events = store.listRecentEvents(sessionId, 500)
    const nodes: AiMessage[] = projectMessages(events).messages
    if (!nodes.some((n) => n.role === 'user')) {
      const err = new Error('还没有可重试的问题') as Error & { code: string }
      err.code = 'AI_NOTHING_TO_RETRY'
      throw err
    }
    let retryOf = null
    for (let i = events.length - 1; i >= 0; i--) {
      if (events[i].kind === 'turn/start') { retryOf = events[i].turnId; break }
    }
    if (!retryOf) {
      const err = new Error('找不到上一回合') as Error & { code: string }
      err.code = 'AI_NOTHING_TO_RETRY'
      throw err
    }
    return start({ sessionId, retryOf, model: req.model, reasoning: req.reasoning, approvalMode: req.approvalMode })
  }

  /**
   * 回合进行中追加一条用户消息（Tabbit 的"边跑边补一句"）。
   * 落进事件日志即可：下一步组装请求时会自然带上。
   */
  async function steer(req: Record<string, unknown> = {}) {
    const sessionId = String((req && req.sessionId) || '')
    const state = running.get(sessionId)
    if (!state) return { ok: false, reason: 'not-running' }
    // 边跑边补一句时可能刚切了审批模式：后续工具/上下文按新模式判定
    if (req.approvalMode) state.approvalMode = req.approvalMode === 'allow' ? 'allow' : 'ask'
    const ctx = slotCtx(sessionId, state.turnId)
    const { blocks, context } = await buildUserBlocks(req, ctx, state)
    if (!blocks.length) return { ok: false, reason: 'empty' }
    store.appendEvent(sessionId, 'user/message', { blocks, context }, state.turnId)
    state.injectQueued = true
    return { ok: true, turnId: state.turnId }
  }

  /**
   * 用户切换审批模式：**正在跑的回合立刻生效**，不必等下一条消息。
   *
   * 不这么做的话，"刚把开关拨到允许"和"本回合后续工具仍按询问"会同时成立 ——
   * 用户看到的就是"我明明开了允许，它还在问我"。
   * @param {'allow'|'ask'} mode
   * @param {string} [sessionId] 只改某个会话（不传 = 所有在跑的回合）
   * @returns {number} 真正被改到的回合数
   */
  function setApprovalMode(mode: 'allow'|'ask', sessionId?: string) : number {
    const next = mode === 'allow' ? 'allow' : 'ask'
    const sid = sessionId ? String(sessionId) : ''
    let touched = 0
    for (const [runningSessionId, state] of running) {
      if (sid && runningSessionId !== sid) continue
      if (state.approvalMode === next) continue
      state.approvalMode = next
      touched += 1
    }
    return touched
  }

  /** 停止。中断 HTTP 流，剩下的收尾由 runTurn 的 finally 完成。 */
  function stop(req: Record<string, unknown> = {}) {
    const sessionId = String((req && req.sessionId) || '')
    const state = running.get(sessionId)
    if (!state) return { ok: false, reason: 'not-running' }
    if (!state.aborted) {
      state.aborted = true
      // 先放掉待决审批：否则回合还卡在 `await authorize()` 里，点停止要等 120 秒
      // 超时才动（见 `approvals#cancelSession` 注释）。
      try { approvals.cancelSession?.(sessionId, 'stopped') } catch (_) {}
      try { state.controller.abort() } catch (_) {}
    }
    return { ok: true, turnId: state.turnId }
  }

  function isRunning(sessionId: unknown) {
    return running.has(String(sessionId))
  }

  /**
   * 等待一个已启动回合完成。只观察，不改变回合生命周期；
   * 若回合已经不在运行表中，立即返回 unknown，避免调用方永久挂起。
   */
  function waitForTurn(sessionId: unknown, turnId: unknown): Promise<TurnOutcome> {
    const sid = String(sessionId || '')
    const tid = String(turnId || '')
    const active = running.get(sid)
    if (!active || active.turnId !== tid) {
      return Promise.resolve({
        stopReason: 'unknown',
        usage: { promptTokens: 0, completionTokens: 0, cachedTokens: 0 }
      })
    }
    return new Promise((resolve) => {
      const bucket = turnWaiters.get(sid) || new Set<TurnWaiter>()
      bucket.add({ turnId: tid, resolve })
      turnWaiters.set(sid, bucket)
    })
  }

  /** 打开面板时的快照：哪些会话正在跑（渲染层据此决定是否显示"停止"）。 */
  function snapshot() {
    return Array.from(running.entries()).map(([sessionId, s]) => ({
      sessionId, turnId: s.turnId, step: s.step, startedAt: s.startedAt
    }))
  }

  /** 插件停用 / 应用退出：中断全部回合，不留悬空 HTTP 连接。 */
  function dispose() {
    const usage = { promptTokens: 0, completionTokens: 0, cachedTokens: 0 }
    for (const [sessionId, state] of running) {
      state.aborted = true
      try { approvals.cancelSession?.(sessionId, 'disposed') } catch (_) {}
      try { state.controller.abort() } catch (_) {}
      settleWaiters(sessionId, state.turnId, {
        stopReason: 'aborted',
        usage,
        failure: { message: 'Hira AI 引擎已停止', code: 'AI_DISPOSED', stack: '' }
      })
    }
    for (const [sessionId, bucket] of turnWaiters) {
      for (const waiter of Array.from(bucket)) {
        try { waiter.resolve({ stopReason: 'aborted', usage, failure: { message: 'Hira AI 引擎已停止', code: 'AI_DISPOSED', stack: '' } }) } catch (_) {}
      }
      turnWaiters.delete(sessionId)
    }
    running.clear()
    expandedToolsBySession.clear()
    tokenScales.clear()
  }

  function forgetSession(sessionId: string) {
    expandedToolsBySession.delete(String(sessionId))
  }

  return { start, steer, retry, stop, setApprovalMode, isRunning, snapshot, waitForTurn, forgetSession, dispose }
}

module.exports = {
  createTurnRunner,
  DEFAULT_STEP_BUDGET,
  MAX_STEP_BUDGET,
  TOOL_RESULT_LIMIT: TOOL_RESULT_CURRENT_LIMIT,
  TOOL_RESULT_HISTORY_LIMIT
}
