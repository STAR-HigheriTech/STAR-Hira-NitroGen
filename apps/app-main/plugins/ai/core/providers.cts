/**
 * AI 引擎 · 三种线上协议适配器（PART15 §7）。
 *
 * 三条硬规矩：
 *   1. **一个 provider 只一种协议** —— 不做"猜协议"式回落。猜错的表现是
 *      "有时能用有时 400"，比直接报错难查一个数量级。
 *   2. **模型缺失就报错**，绝不静默换一个便宜的模型顶上（用户会以为自己在用 A）。
 *   3. 适配器只负责「内部消息 → 线上 JSON」与「线上 SSE → 统一帧」，
 *      不认识数据库、不认识界面、不碰密钥（钥匙由调用方解好传进来）。
 *
 * 统一帧（`stream` 的产出）：
 *   { type: 'text-delta', text }
 *   { type: 'reasoning-delta', text, field, signature? }
 *   { type: 'tool-call', id, name, args }
 *   { type: 'usage', promptTokens, completionTokens, cachedTokens? }
 *   { type: 'done', stopReason }
 *
 * 内部消息形如：
 *   { role: 'user'|'assistant', blocks: [{type:'text',text}|{type:'image',ref,mime}] }
 *   { role: 'tool-call', id, name, args }
 *   { role: 'tool-result', id, name, result, isError }
 *
 * ══════════════════════════════════════════════════════════════════════
 * 推理（思考模式）必须**原样回传**
 * ══════════════════════════════════════════════════════════════════════
 * 思考模式的服务端（DeepSeek-Reasoner / OpenRouter / Anthropic 扩展思考）在
 * 工具回路里要求把上一轮的推理一起带回去：
 *   - DeepSeek：assistant 消息带 `reasoning_content`，缺了直接 400；
 *   - OpenRouter 系：字段名是 `reasoning`；
 *   - Anthropic：`thinking` 块 + `signature` 必须原样放回 assistant content 最前面。
 * 因此 assistant 消息可携带 `reasoning: { text, field, signature? }`：
 * `field` 记录**当初服务端用的那个键名**。回传策略（`reasoningEchoField`）：
 * 只要历史里出现过推理，**每一条** assistant 都带同一个键（这条没有推理时补
 * 空串）—— DeepSeek 校验的是"所有 assistant 都要有"，只补有推理的那几条照样 400。
 * 一条推理都没有 = 不是思考回路，一个字都不加（非思考服务商不受影响）。
 * 万一是旧版本落库的历史（推理已丢），服务端报错后按它的原话补空串重发一次
 * （`isReasoningEchoError` + `toOpenAiChat` 的 override），自愈而不猜测协议。
 */

const { net } = require('electron')

import type {
  AiBlock,
  AiMessage,
  AiProtocolRequest,
  AiReasoning,
  AiStreamFrame,
  JsonObject,
  ToolArgs,
  UnknownRecord
} from '../types'

interface SseEvent { event: string; data: unknown }
interface SseResponse extends Response { __release?: () => void }
interface IterSseOptions {
  idleMs?: number
  finishGraceMs?: number
  shouldFinish?: (() => boolean) | null
}
interface FetchErrorContext { timedOut: boolean; limit: number; outer?: AbortSignal }
interface RequestOptions {
  method?: string
  headers?: Record<string, string>
  body?: unknown
  signal?: AbortSignal
  timeoutMs?: number
}
interface AiServiceError extends Error {
  code: string
  retryable: boolean
  status?: number
}
interface IdleError extends Error { __idle?: boolean }

const ANTHROPIC_VERSION = '2023-06-01'

/**
 * 模型没配「最大输出」时的默认上限。
 *
 * 各家默认值偏小（DeepSeek chat 默认 4096），长回答会被拦腰截断 —— 用户看到
 * 的现象就是"说到一半停了"。8192 是主流服务商普遍接受的一档；真被拒
 * （400 说 max_tokens 不支持 / 过大）时，自动去掉该字段重发一次（见
 * `isMaxTokensRejected`）。
 */
const DEFAULT_MAX_OUTPUT_TOKENS = 8192

function joinUrl(base: string, path: string): string {
  const b = String(base || '').replace(/\/+$/, '')
  try {
    if (new URL(b).pathname.replace(/\/+$/, '').endsWith(path)) return b
  } catch (_) {
    if (b.endsWith(path)) return b
  }
  return `${b}${path}`
}

/** 从 OpenAI 风格 content（字符串 / 分块数组）提取文本。 */
function textOfContent(content: unknown): string {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content.map((part) => {
    if (typeof part === 'string') return part
    if (!part || typeof part !== 'object') return ''
    const record = part as UnknownRecord
    return typeof record.text === 'string' ? record.text : ''
  }).join('')
}

function asText(blocks: unknown): string {
  if (!Array.isArray(blocks)) return ''
  return (blocks as AiBlock[])
    .filter((block): block is Extract<AiBlock, { type: 'text' }> => !!block && block.type === 'text')
    .map((block) => block.text || '')
    .join('')
}

/** 把内部消息压成"可送给模型"的线性序列（工具调用/结果保持配对）。 */
function normalize(messages: unknown): AiMessage[] {
  return (Array.isArray(messages) ? messages : []).filter((message): message is AiMessage =>
    !!message && typeof message === 'object' && 'role' in message)
}

// ─────────────────────────────────────────────────────────────────────
// SSE
// ─────────────────────────────────────────────────────────────────────
/** 单次等数据的上限：思考模型可能长时间不出字，但"完全没数据"只可能是挂了。 */
const STREAM_IDLE_MS = 90_000
/**
 * Responses 的思考内容是**服务端加密**的，推理期间可能一个增量都不发
 * （completions / anthropic 都会流式吐推理，这里不会）。窗口放宽到 5 分钟，
 * 否则长推理会被误判成断流。
 */
const STREAM_IDLE_RESPONSES_MS = 300_000
/** 已经收到 finish_reason 之后，等 `[DONE]` / usage 的宽限（网关常常不发 [DONE]）。 */
const STREAM_FINISH_GRACE_MS = 2_000

/**
 * 给单次 `reader.read()` 加超时。
 *
 * **流空转**是最难查的一类故障：出字到一半服务端不再发数据（网关保活、
 * 连接半死、代理吞了结尾），没有看门狗就会永远挂在这里 —— 界面上表现为
 * "停在半句话、永远不显示结束、停止按钮也没反应"。
 */
function readWithTimeout(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  ms: number
): Promise<ReadableStreamReadResult<Uint8Array>> {
  if (!ms || ms <= 0) return reader.read()
  return new Promise((resolve, reject) => {
    let settled = false
    const timer = setTimeout(() => {
      if (settled) return
      settled = true
      const err: IdleError = new Error(`响应中断：${Math.round(ms / 1000)} 秒没有收到新数据`)
      err.__idle = true
      reject(err)
    }, ms)
    reader.read().then(
      (chunk) => { if (settled) return; settled = true; clearTimeout(timer); resolve(chunk) },
      (err) => { if (settled) return; settled = true; clearTimeout(timer); reject(err) }
    )
  })
}

/**
 * 读 SSE。**按行缓冲**而不是按 chunk：`\n\n` 可能横跨两个网络分片，
 * 按 chunk 切会把一条事件劈成两半（表现为"偶尔丢一段文字"）。
 *
 * @param {any} res `request()` 的响应
 * @param {{
 *   idleMs?: number,
 *   finishGraceMs?: number,
 *   shouldFinish?: (() => boolean)|null
 * }} [opts]
 *   idleMs         多久没数据算"断了"（0 = 不设限）
 *   finishGraceMs  已经收完（shouldFinish 为真）后等 `[DONE]` 的宽限，超时当作正常结束
 *   shouldFinish   调用方判断"答案已经收完"（例如 finish_reason 到了）
 */
async function* iterSse(
  res: SseResponse,
  { idleMs = 0, finishGraceMs = 0, shouldFinish = null }: IterSseOptions = {}
): AsyncGenerator<SseEvent, void, void> {
  const body = res.body
  if (!body) return
  const reader = body.getReader()
  const decoder = new TextDecoder()
  const contentType = String(res.headers?.get?.('content-type') || '').toLowerCase()
  const jsonBody = contentType.includes('json') && !contentType.includes('text/event-stream')
  let jsonLike = jsonBody
  let buffer = ''
  let grace = false
  try {
    while (true) {
      let chunk
      try {
        chunk = await readWithTimeout(reader, grace ? finishGraceMs : idleMs)
      } catch (err) {
        // 收完之后的等待只是"等 [DONE]/usage"：迟到就正常收工，不判失败
        const idleError = err as IdleError
        if (idleError && idleError.__idle && grace) return
        if (idleError && idleError.__idle) throw aiError('timeout', idleError.message)
        throw err
      }
      if (chunk.done) break
      buffer += decoder.decode(chunk.value, { stream: true })
      // 有些网关发 CRLF：不归一化就永远找不到 `\n\n` 分隔符
      if (buffer.indexOf('\r') !== -1) buffer = buffer.replace(/\r\n/g, '\n')
      if (jsonLike && /(^|\n)data:/.test(buffer)) jsonLike = false
      if (!jsonLike && !buffer.includes('data:') && /^[\s]*[\[{]/.test(buffer)) jsonLike = true
      // 普通 JSON 里的空行只是格式空白，不能按 SSE 事件边界切开。
      if (jsonLike) continue
      let idx
      while ((idx = buffer.indexOf('\n\n')) !== -1) {
        const raw = buffer.slice(0, idx)
        buffer = buffer.slice(idx + 2)
        const ev = parseSseBlock(raw)
        if (ev) yield ev
      }
      if (shouldFinish && shouldFinish()) grace = true
    }
    // 末尾残留：既支持漏掉最后一个空行的 SSE，也兼容忽略 stream=true、
    // 直接返回普通 JSON / NDJSON 的 OpenAI-compatible 网关。
    for (const event of parseTailEvents(buffer)) yield event
  } finally {
    // 主动 cancel：中途 break / 超时 / 取消都要把连接断掉，不留给对端慢慢超时
    try { await reader.cancel() } catch (_) {}
    try { reader.releaseLock() } catch (_) {}
    if (res && typeof res.__release === 'function') { try { res.__release() } catch (_) {} }
  }
}

function parseSseBlock(raw: string): SseEvent | null {
  let event = 'message'
  const dataLines = []
  for (const line of raw.split('\n')) {
    if (!line || line.startsWith(':')) continue
    const colon = line.indexOf(':')
    const field = colon === -1 ? line : line.slice(0, colon)
    const value = colon === -1 ? '' : line.slice(colon + 1).replace(/^ /, '')
    if (field === 'event') event = value
    else if (field === 'data') dataLines.push(value)
  }
  if (!dataLines.length) return null
  const data = dataLines.join('\n')
  if (data === '[DONE]') return { event: 'done', data: null }
  try { return { event, data: JSON.parse(data) } } catch (_) { return { event, data } }
}

function parseTailEvents(raw: string): SseEvent[] {
  const text = String(raw || '').trim()
  if (!text) return []
  const direct = parseSseBlock(text)
  if (direct) {
    const lines = text.split('\n').map((line) => line.replace(/^data:\s?/, '').trim()).filter(Boolean)
    if (lines.length > 1 && lines.every((line) => line === '[DONE]' || /^[\[{]/.test(line))) {
      const events: SseEvent[] = []
      for (const line of lines) {
        if (line === '[DONE]') { events.push({ event: 'done', data: null }); continue }
        try { events.push({ event: 'message', data: JSON.parse(line) }) } catch (_) {}
      }
      if (events.length) return events
    }
    return [direct]
  }
  try { return [{ event: 'message', data: JSON.parse(text) }] } catch (_) {}
  const events: SseEvent[] = []
  for (const line of text.split('\n')) {
    const item = line.trim()
    if (!item || item.startsWith(':')) continue
    if (item === '[DONE]') { events.push({ event: 'done', data: null }); continue }
    const payload = item.startsWith('data:') ? item.slice(5).trim() : item
    if (!payload || payload === '[DONE]') continue
    try { events.push({ event: 'message', data: JSON.parse(payload) }) } catch (_) {}
  }
  return events
}

// ─────────────────────────────────────────────────────────────────────
// 错误归一（PART15 §7）
// ─────────────────────────────────────────────────────────────────────
/**
 * 网络错误只允许出现这几种 `code`。界面按 code 出中文文案、按 `retryable`
 * 决定要不要给"重试"按钮 —— 渲染层不再靠正则猜 `err.message`。
 *
 *   auth            401 / 403  密钥错、没权限      （不可重试）
 *   rate_limit      429        限流                （可重试）
 *   overloaded      529        服务端过载          （可重试）
 *   context_overflow 400/413   上下文超限          （不可重试，要裁剪）
 *   timeout         —          超时                （可重试）
 *   network         —          连不上 / 断流       （可重试）
 *   server          5xx        服务端故障          （可重试）
 *   bad_request     其它 4xx   请求本身不合法      （不可重试）
 *   aborted         —          用户取消            （不可重试）
 */
const DEFAULT_TIMEOUT_MS = 120_000
const RETRYABLE = new Set(['timeout', 'network', 'rate_limit', 'overloaded', 'server'])
const CONTEXT_HINTS = [
  'context_length_exceeded', 'context length', 'maximum context', 'too many tokens',
  'prompt is too long', 'input is too long', 'token limit', 'context window',
  'reduce the length', 'exceeds the maximum'
]

function aiError(code: string, message: string, extra: UnknownRecord = {}): AiServiceError {
  const err = new Error(message) as AiServiceError
  err.code = code
  err.retryable = RETRYABLE.has(code)
  if (extra) Object.assign(err, extra)
  return err
}

function excerpt(text: unknown, limit = 400): string {
  const s = String(text || '').replace(/\s+/g, ' ').trim()
  return s.length > limit ? `${s.slice(0, limit)}…` : s
}

/** 服务端错误体通常有两种形状：`{error:{message}}` 与 `{message}`。 */
function providerMessage(detail: string, fallback: string): string {
  if (!detail) return fallback
  try {
    const data = JSON.parse(detail)
    const msg = (data && ((data.error && data.error.message) || data.message)) || ''
    if (msg) return String(msg).slice(0, 400)
  } catch (_) { /* 不是 JSON，按原文截断 */ }
  return excerpt(detail) || fallback
}

function classifyHttpError(status: number, detail: string): string {
  const low = String(detail || '').toLowerCase()
  if (status === 401 || status === 403) return 'auth'
  if (status === 429) return 'rate_limit'
  if (status === 408) return 'timeout'
  if (status === 529) return 'overloaded'
  if (status === 413) return 'context_overflow'
  if (status === 400 || status === 422) {
    return CONTEXT_HINTS.some((k) => low.includes(k)) ? 'context_overflow' : 'bad_request'
  }
  if (status >= 500) return 'server'
  return 'bad_request'
}

/** 流内报错（SSE 里的 `error` 帧）同样要带分类，否则界面无法区分限流与坏请求。 */
function streamError(message: string): AiServiceError {
  const low = String(message || '').toLowerCase()
  if (low.includes('overloaded')) return aiError('overloaded', message)
  if (low.includes('rate limit') || low.includes('too many requests')) return aiError('rate_limit', message)
  if (CONTEXT_HINTS.some((k) => low.includes(k))) return aiError('context_overflow', message)
  return aiError('server', message)
}

function normalizeFetchError(err: unknown, { timedOut, limit, outer }: FetchErrorContext): AiServiceError {
  if (timedOut) return aiError('timeout', `请求超时（${Math.round(limit / 1000)} 秒无响应）`)
  const record = err && typeof err === 'object' ? err as UnknownRecord : {}
  const code = String(record.code || '')
  const name = String(record.name || '')
  if (/timeout/i.test(code) || name === 'TimeoutError') return aiError('timeout', '请求超时')
  if (outer && outer.aborted) return aiError('aborted', '已取消')
  if (name === 'AbortError' || code === 'ABORT_ERR') return aiError('aborted', '已取消')
  return aiError('network', `网络请求失败：${String(record.message || '未知原因')}`)
}

/**
 * 所有线上请求的唯一出口：统一超时 + 分类。
 *
 * 时序上分两段，别混：
 *   - **拿到响应头之前**：受 `timeoutMs` 管（连不上 / 服务端不响应）；
 *   - **开始收流之后**：总时长不设上限（长回答可以写十几分钟），
 *     但"多久没收到数据"由 `iterSse` 的空闲看门狗兜底。
 * 取消（用户的停止按钮）必须**贯穿到流结束**：响应对象上挂了 `__release`，
 * 由 `iterSse` 读完时解绑 —— 否则点了停止，底下的连接还在源源不断收数据。
 */
async function request(
  url: string,
  { method = 'POST', headers, body, signal, timeoutMs }: RequestOptions = {}
): Promise<SseResponse> {
  const limit = timeoutMs === 0 ? 0 : (Number(timeoutMs) || DEFAULT_TIMEOUT_MS)
  const serializedBody = body ? JSON.stringify(body) : undefined
  const maxAttempts = 3

  async function attemptOnce(): Promise<SseResponse> {
    const controller = new AbortController()
    let timedOut = false
    const forwardAbort = () => {
      try { controller.abort(signal && signal.reason) } catch (_) { try { controller.abort() } catch (_) {} }
    }
    if (signal) {
      if (signal.aborted) forwardAbort()
      else signal.addEventListener('abort', forwardAbort, { once: true })
    }
    let timer = limit > 0
      ? setTimeout(() => { timedOut = true; try { controller.abort() } catch (_) {} }, limit)
      : null
    const cleanup = () => {
      if (timer) { clearTimeout(timer); timer = null }
      if (signal) { try { signal.removeEventListener('abort', forwardAbort) } catch (_) {} }
    }
    let res: SseResponse
    try {
      res = await net.fetch(url, {
        method,
        headers: {
          'content-type': 'application/json',
          accept: 'text/event-stream, application/json',
          ...(headers || {})
        },
        body: serializedBody,
        signal: controller.signal
      }) as SseResponse
    } catch (err) {
      cleanup()
      throw normalizeFetchError(err, { timedOut, limit, outer: signal })
    }
    if (!res.ok) {
      let detail = ''
      try { detail = await res.text() } catch (_) {}
      cleanup()
      const code = classifyHttpError(res.status, detail)
      const retryAfter = Number(res.headers.get('retry-after')) || 0
      throw aiError(code, providerMessage(detail, `HTTP ${res.status} ${res.statusText}`), {
        status: res.status,
        retryAfter
      })
    }
    // 头已到：超时使命结束；取消继续生效到流读完（见 iterSse 的 finally）
    if (timer) { clearTimeout(timer); timer = null }
    try {
      Object.defineProperty(res, '__release', { value: cleanup, configurable: true })
    } catch (_) { cleanup() }
    return res
  }

  let lastError: unknown = null
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      return await attemptOnce()
    } catch (error) {
      lastError = error
      const record = error && typeof error === 'object' ? error as UnknownRecord : {}
      const retryable = record.retryable === true &&
        ['timeout', 'network', 'rate_limit', 'overloaded', 'server'].includes(String(record.code || ''))
      if (signal?.aborted || !retryable || attempt >= maxAttempts) throw error
      const retryAfterSeconds = Math.max(0, Number(record.retryAfter) || 0)
      const delay = retryAfterSeconds > 0
        ? Math.min(10_000, retryAfterSeconds * 1000)
        : Math.min(4_000, 350 * (2 ** (attempt - 1)) + Math.round(Math.random() * 180))
      try {
        console.warn(`[ai] 模型请求暂时失败（${String(record.code || 'network')}），${delay}ms 后重试 ${attempt + 1}/${maxAttempts}`)
      } catch (_) {}
      await new Promise<void>((resolve) => setTimeout(resolve, delay))
    }
  }
  throw lastError instanceof Error ? lastError : aiError('network', '模型请求失败')
}

// ─────────────────────────────────────────────────────────────────────
// 推理等级（`off` / `auto` / `low` / `medium` / `high`）
// ─────────────────────────────────────────────────────────────────────
const EFFORTS = new Set(['low', 'medium', 'high'])
const ANTHROPIC_THINKING_BUDGET = Object.freeze({ low: 2048, medium: 4096, high: 8192 })

/** 只有明确的三档才下发；`auto` / 空 = 交给服务端默认值。 */
function effortOf(reasoning: unknown): 'low' | 'medium' | 'high' | '' {
  const v = String(reasoning || '').toLowerCase()
  return EFFORTS.has(v) ? v as 'low' | 'medium' | 'high' : ''
}

/**
 * 统一「推理回传」的形状。`field` 白名单：认不出的键名一律按 DeepSeek 的
 * `reasoning_content` 处理（它是唯一会因为缺字段直接 400 的一家）。
 *
 * 只有「既没正文、也没键名」才返回 null：服务端明确用过某个键（哪怕这一轮
 * 推理为空，或只回了签名）时，字段本身也是一条必须回传的事实 —— 丢了就 400。
 */
function reasoningEcho(reasoning: unknown): { text: string; field: 'reasoning_content' | 'reasoning' | 'thinking'; signature: string } | null {
  if (!reasoning || typeof reasoning !== 'object') return null
  const record = reasoning as UnknownRecord
  const text = typeof record.text === 'string' ? record.text : ''
  const field = String(record.field || '')
  if (!text && !field) return null
  return {
    text,
    field: field === 'reasoning' || field === 'thinking' ? field : 'reasoning_content',
    signature: typeof record.signature === 'string' ? record.signature : ''
  }
}

/**
 * 这一批消息该用哪个键回传推理。
 *
 * 以**最近一条**真带推理的 assistant 为准：同一个会话里键名可能因为换服务商
 * 变过，但服务端只认它自己发的那个。一个都没有 = 不是思考回路，一个字都不加
 * （非思考服务商不会因为未知字段被带坏）。
 *
 * @returns {'reasoning_content'|'reasoning'|''}
 */
function reasoningEchoField(messages: unknown): 'reasoning_content'|'reasoning'|'' {
  let field = ''
  for (const m of normalize(messages)) {
    if (m.role !== 'assistant') continue
    const echo = reasoningEcho(m.reasoning)
    if (echo && echo.field !== 'thinking') field = echo.field
  }
  return field as 'reasoning_content' | 'reasoning' | ''
}

/**
 * 服务端 400 的原文是不是在说「reasoning_content 必须回传」。
 *
 * 这是唯一需要「按报错自愈」的场景：历史里一条推理都没有时（旧版本落库 /
 * 从别的客户端迁来的会话 / 换过模型），键名探测无从下手，只能等服务端开口。
 * 重发时按它要的键补上推理（没存下来就用 `REASONING_PLACEHOLDER` 占位 ——
 * 空串不算回传）；别的服务商不会报这个错，所以不会把正常请求改坏
 * （见 `toOpenAiChat` 的 override 参数）。
 */
function isReasoningEchoError(err: unknown): boolean {
  const record = err && typeof err === 'object' ? err as UnknownRecord : {}
  return /reasoning_content/i.test(String(record.message || ''))
}

/**
 * 服务端**明确要求**回传、但历史里确实没存下推理时的占位文本。
 *
 * 空串不算"回传"（DeepSeek 会把 `reasoning_content: ""` 判成缺字段，照样 400），
 * 而旧版本落库 / 从别的客户端迁来的会话里就是没有。此时宁可用一句话占位，
 * 也不要整条请求失败 —— 只在自愈重发（`echoFieldOverride`）时使用。
 */
const REASONING_PLACEHOLDER = '（该步骤的推理内容未保存）'

/**
 * 服务端 400 的原文是不是在说「max_tokens 这个字段不行」。
 *
 * 我们默认下发 `DEFAULT_MAX_OUTPUT_TOKENS`（避免被服务商的小默认值截断），
 * 但个别端点的上限更小、或者干脆不认 `max_tokens`（新版 OpenAI 推理模型要
 * `max_completion_tokens`）。这时**退回"不指定"**让服务端用自己的默认值 ——
 * 输出短一点总比整条请求 400 好。
 */
function isMaxTokensRejected(err: unknown): boolean {
  if (!err || typeof err !== 'object') return false
  const record = err as UnknownRecord
  if (Number(record.status) !== 400) return false
  return /max_?tokens|max_completion_tokens/i.test(String(record.message || ''))
}

// ─────────────────────────────────────────────────────────────────────
// openai-completions（`{base}/chat/completions`）
// ─────────────────────────────────────────────────────────────────────
/**
 * @param {any[]} messages 内部消息
 * @param {string} [echoFieldOverride] 强制用这个键回传推理（服务端报错后的自愈重发用）
 */
function toOpenAiChat(messages: unknown[], echoFieldOverride: string = ''): Array<Record<string, unknown>> {
  const list = normalize(messages)
  // 思考回路的键名：一旦历史里出现过推理，**每一条** assistant 都要带这个键。
  // DeepSeek 的校验是"所有 assistant 消息都得有 reasoning_content"，只回传
  // 有推理的那几条同样 400（换模型 / 旧版本落库的历史尤其容易缺）。
  const echoField = echoFieldOverride || reasoningEchoField(list)
  const out: Array<Record<string, unknown>> = []
  /**
   * 当前「可继续挂 tool_calls」的 assistant。
   *
   * ⚠ 工具调用在事件日志里是**独立节点**，同一**步**的多个调用与结果会交错排列
   * （call1 → result1 → call2 → result2）。而线上协议要求：同一步的全部
   * tool_calls 必须在**同一条** assistant 里，且排在这批 tool 消息之前。
   * 所以这里记住"最近那条 assistant"，可以跨过 `role:'tool'` 继续往里挂；
   * 只有遇到新的 user / assistant 才换目标。
   *
   * 曾用做法是"上一条不是 assistant 就伪造一条"：伪造出来的 assistant 没有
   * 推理正文，DeepSeek 思考模式看到空 `reasoning_content` 直接 400
   * （The reasoning_content in the thinking mode must be passed back to the API）。
   */
  let callTarget: Record<string, unknown> | null = null
  /** 找不到归属 assistant 的 tool-call（历史被裁剪过）→ 连它的结果一起丢，否则必 400 */
  const orphanCalls = new Set<string>()
  for (const m of list) {
    if (m.role === 'user') {
      const parts = (m.blocks || []).map((b) => b.type === 'image'
        ? { type: 'image_url', image_url: { url: b.ref } }
        : { type: 'text', text: b.type === 'text' ? b.text || '' : '' })
      out.push({ role: 'user', content: parts.length === 1 && parts[0].type === 'text' ? parts[0].text : parts })
      callTarget = null
    } else if (m.role === 'assistant') {
      const calls = (m.blocks || []).filter((b): b is Extract<AiBlock, { type: 'tool-call' }> => b.type === 'tool-call')
      const content = asText(m.blocks)
      const msg: Record<string, unknown> = { role: 'assistant', content: content || null }
      // 思考模式回传：有键名就每一条都带（这条没有推理时补空串，见文件头；
      // 服务端已经为此报过错时改补占位，空串 = 没回传）
      if (echoField) {
        const echo = reasoningEcho(m.reasoning)
        msg[echoField] = (echo && echo.text) || (echoFieldOverride ? REASONING_PLACEHOLDER : '')
      }
      if (calls.length) {
        msg.tool_calls = calls.map((c) => ({
          id: c.toolCallId || c.id,
          type: 'function',
          function: { name: c.name, arguments: JSON.stringify(c.args || {}) }
        }))
      }
      out.push(msg)
      callTarget = msg
    } else if (m.role === 'tool-call') {
      const call = { id: m.id, type: 'function', function: { name: m.name, arguments: JSON.stringify(m.args || {}) } }
      if (!callTarget) { orphanCalls.add(String(m.id == null ? '' : m.id)); continue }
      const existingCalls = Array.isArray(callTarget.tool_calls) ? callTarget.tool_calls : []
      callTarget.tool_calls = [...existingCalls, call]
      if (echoField && !callTarget[echoField]) callTarget[echoField] = echoFieldOverride ? REASONING_PLACEHOLDER : ''
    } else if (m.role === 'tool-result') {
      if (orphanCalls.has(String(m.id == null ? '' : m.id))) continue
      out.push({ role: 'tool', tool_call_id: m.id, content: stringifyResult(m.result) })
    }
  }
  return out
}

function stringifyResult(result: unknown): string {
  if (typeof result === 'string') return result
  try { return JSON.stringify(result) } catch (_) { return String(result) }
}

function toOpenAiTools(tools: AiProtocolRequest['tools']): Array<Record<string, unknown>> | undefined {
  if (!Array.isArray(tools) || !tools.length) return undefined
  return tools.map((t) => ({
    type: 'function',
    function: { name: t.name, description: t.description, parameters: t.parameters || { type: 'object', properties: {} } }
  }))
}

async function* openaiCompletions({
  provider,
  apiKey,
  model,
  messages,
  system,
  tools,
  signal,
  reasoning,
  maxOutputTokens
}: AiProtocolRequest): AsyncGenerator<AiStreamFrame, void, void> {
  // 模型目录里配了就用它；没配用默认上限（见 `DEFAULT_MAX_OUTPUT_TOKENS` 注释：
  // 直接不下发会落进服务商的小默认值，长回答被拦腰截断 = "说到一半停了"）。
  const maxTokens = Number(maxOutputTokens) > 0 ? Number(maxOutputTokens) : DEFAULT_MAX_OUTPUT_TOKENS
  const buildBody = (
    list: AiMessage[],
    echoField = '',
    opts: { omitMaxTokens?: boolean } = {}
  ): Record<string, unknown> => {
    const body: Record<string, unknown> = {
      model,
      messages: [
        ...(system ? [{ role: 'system', content: system }] : []),
        ...toOpenAiChat(list, echoField)
      ],
      stream: true,
      stream_options: { include_usage: true }
    }
    if (!opts.omitMaxTokens) body.max_tokens = maxTokens
    const effort = effortOf(reasoning)
    if (effort) body.reasoning_effort = effort
    const toolDefs = toOpenAiTools(tools)
    if (toolDefs) body.tools = toolDefs
    return body
  }
  const url = joinUrl(provider.baseUrl, '/chat/completions')
  // Azure/部分企业网关使用 api-key；标准 OpenAI 使用 Bearer。同时携带可由服务端忽略
  // 不认识的额外头，避免用户因协议相同但鉴权头不同而无法接入。
  const headers = { authorization: `Bearer ${apiKey}`, 'api-key': apiKey }
  // ── 自愈重发：只修"服务端亲口点名的"两种 400，且每种只修一次 ──────────
  // ① 缺 reasoning_content（见 `isReasoningEchoError` 注释）；
  // ② max_tokens 不被接受（见 `isMaxTokensRejected` 注释）。
  // 两者可能先后出现（旧历史 + 上限更小的模型），所以用循环而不是写死一次。
  let echoField = ''
  let omitMaxTokens = false
  let res: SseResponse | null = null
  for (let attempt = 0; ; attempt++) {
    try {
      res = await request(url, { headers, body: buildBody(messages, echoField, { omitMaxTokens }), signal })
      break
    } catch (err) {
      const echo = !echoField && isReasoningEchoError(err)
      const dropMax = !omitMaxTokens && !echo && isMaxTokensRejected(err)
      if (attempt >= 2 || (!echo && !dropMax)) throw err
      if (echo) echoField = 'reasoning_content'
      if (dropMax) omitMaxTokens = true
    }
  }
  // index → 累积中的工具调用
  interface PendingCall { id: string; name: string; args: string }
  const pending = new Map<number, PendingCall>()
  let stopReason = 'stop'
  // 思考模式是否出现过（可能一个字都没有，只有字段）—— 收尾时补一帧纯 field，
  // 让上层把"这一轮是思考模式"落库，下一轮回传才不会缺键。
  let reasoningFieldSeen = ''
  let reasoningTextSeen = false
  // finish_reason 到了 = 答案已经收完。此后不再无限等 `[DONE]`：
  // 有些网关根本不发它、或者发完还挂着连接，干等就是"永远不结束"。
  let finished = false
  // 收到过 `[DONE]`（有的网关只发它、不发 finish_reason）
  let sawTerminator = false
  for await (const ev of iterSse(res, {
    idleMs: STREAM_IDLE_MS,
    finishGraceMs: STREAM_FINISH_GRACE_MS,
    shouldFinish: () => finished
  })) {
    if (ev.event === 'done') { sawTerminator = true; break }
    const d = ev.data as UnknownRecord
    if (!d) continue
    // 200 里夹错误帧（网关常见）：必须抛出去，否则界面就是"没反应"
    if (ev.event === 'error' || (d.error && !Array.isArray(d.choices))) {
      const errorRecord = d.error && typeof d.error === 'object' ? d.error as UnknownRecord : null
      const msg = (errorRecord && (errorRecord.message || d.error)) || d.message || '服务端返回错误'
      throw streamError(typeof msg === 'string' ? msg : JSON.stringify(msg))
    }
    const choice = Array.isArray(d.choices) ? d.choices[0] as UnknownRecord | null : null
    if (choice) {
      // 流式用 `delta`；个别网关不支持流，一次性返回时用 `message`（形状同 delta）
      const delta = (choice.delta || choice.message || {}) as UnknownRecord
      // 普通 JSON 的完整 message 本身就是终态，即使网关漏了 finish_reason。
      if (!choice.delta && choice.message) finished = true
      const content = textOfContent(delta.content) || (typeof choice.text === 'string' ? choice.text : '')
      if (content) yield { type: 'text-delta', text: content }
      // 思考模式的推理增量：DeepSeek 用 `reasoning_content`，OpenRouter 系用 `reasoning`
      const rc = typeof delta.reasoning_content === 'string'
        ? { text: delta.reasoning_content, field: 'reasoning_content' }
        : (typeof delta.reasoning === 'string' ? { text: delta.reasoning, field: 'reasoning' } : null)
      if (rc) {
        reasoningFieldSeen = rc.field
        if (rc.text) {
          reasoningTextSeen = true
          yield { type: 'reasoning-delta', text: rc.text, field: rc.field }
        }
      }
      const toolCalls = Array.isArray(delta.tool_calls)
        ? delta.tool_calls
        : (delta.tool_calls && typeof delta.tool_calls === 'object' ? Object.values(delta.tool_calls) : [])
      if (Array.isArray(toolCalls)) {
        for (let i = 0; i < toolCalls.length; i++) {
          const tc = (toolCalls[i] || {}) as UnknownRecord
          const index = typeof tc.index === 'number' ? tc.index : i
          if (!pending.has(index)) pending.set(index, { id: String(tc.id || `call_${index}`), name: '', args: '' })
          const acc = pending.get(index)
          if (!acc) continue
          if (typeof tc.id === 'string') acc.id = tc.id
          const fn = tc.function && typeof tc.function === 'object' ? tc.function as UnknownRecord : null
          if (fn && typeof fn.name === 'string') acc.name += fn.name
          if (fn && typeof fn.arguments === 'string') acc.args += fn.arguments
          else if (fn && fn.arguments && typeof fn.arguments === 'object') acc.args = JSON.stringify(fn.arguments)
        }
      }
      // 旧式 OpenAI-compatible 网关可能只发单个 function_call，不发 tool_calls。
      const legacyCall = delta.function_call && typeof delta.function_call === 'object'
        ? delta.function_call as UnknownRecord
        : null
      if (legacyCall) {
        if (!pending.has(0)) pending.set(0, { id: 'call_0', name: '', args: '' })
        const acc = pending.get(0)
        if (acc) {
          if (typeof legacyCall.name === 'string') acc.name += legacyCall.name
          if (typeof legacyCall.arguments === 'string') acc.args += legacyCall.arguments
          else if (legacyCall.arguments && typeof legacyCall.arguments === 'object') acc.args = JSON.stringify(legacyCall.arguments)
        }
      }
      if (choice.finish_reason) {
        stopReason = String(choice.finish_reason)
        finished = true
      }
    }
    if (d.usage && typeof d.usage === 'object') {
      const usage = d.usage as UnknownRecord
      const details = usage.prompt_tokens_details && typeof usage.prompt_tokens_details === 'object'
        ? usage.prompt_tokens_details as UnknownRecord
        : {}
      yield {
        type: 'usage',
        promptTokens: Number(usage.prompt_tokens) || 0,
        completionTokens: Number(usage.completion_tokens) || 0,
        cachedTokens: Number(usage.prompt_cache_hit_tokens) || Number(details.cached_tokens) || 0
      }
    }
  }
  // 既没 finish_reason 也没 `[DONE]`：连接在回答完成前就被掐断了（网关半死 /
  // 代理吞结尾）。不抛错的话上层会把半句话当成"已完成" —— 这正是
  // "说着说着停住、界面也不显示完成"的观感来源。抛 network 可重试。
  if (!finished && !sawTerminator) {
    throw aiError('network', '连接在回答完成前中断（未收到结束标记），可重试')
  }
  // 只有字段、没有正文：补一帧（`field` 本身就是必须回传的事实）
  if (reasoningFieldSeen && !reasoningTextSeen) {
    yield { type: 'reasoning-delta', text: '', field: reasoningFieldSeen }
  }
  for (const acc of pending.values()) {
    yield { type: 'tool-call', id: acc.id, name: acc.name, args: safeParse(acc.args) }
  }
  yield { type: 'done', stopReason }
}

function safeParse(text: string): JsonObject {
  if (!text) return {}
  try {
    const value: unknown = JSON.parse(text)
    return value && typeof value === 'object' && !Array.isArray(value) ? value as JsonObject : { _raw: text }
  } catch (_) { return { _raw: text } }
}

// ─────────────────────────────────────────────────────────────────────
// openai-responses（`{base}/responses`）
// ─────────────────────────────────────────────────────────────────────
/**
 * Responses 的推理是**服务端加密的 reasoning item**，不是可回传的纯文本 ——
 * 明文推理只能看不能回写，所以这里**不**把 `reasoning` 塞进 input，
 * 只把推理增量接到统一帧里（存下来给界面 / 排查用）。
 */
function toResponsesInput(messages: unknown[]): Array<Record<string, unknown>> {
  const out: Array<Record<string, unknown>> = []
  for (const m of normalize(messages)) {
    if (m.role === 'user') {
      out.push({ role: 'user', content: [{ type: 'input_text', text: asText(m.blocks) }] })
    } else if (m.role === 'assistant') {
      const text = asText(m.blocks)
      if (text) out.push({ role: 'assistant', content: [{ type: 'output_text', text }] })
      for (const b of (m.blocks || [])) {
        if (b.type === 'tool-call') {
          out.push({ type: 'function_call', call_id: b.toolCallId || b.id, name: b.name, arguments: JSON.stringify(b.args || {}) })
        }
      }
    } else if (m.role === 'tool-call') {
      out.push({ type: 'function_call', call_id: m.id, name: m.name, arguments: JSON.stringify(m.args || {}) })
    } else if (m.role === 'tool-result') {
      out.push({ type: 'function_call_output', call_id: m.id, output: stringifyResult(m.result) })
    }
  }
  return out
}

async function* openaiResponses({
  provider,
  apiKey,
  model,
  messages,
  system,
  tools,
  signal,
  reasoning,
  maxOutputTokens
}: AiProtocolRequest): AsyncGenerator<AiStreamFrame, void, void> {
  const body: Record<string, unknown> = {
    model,
    input: toResponsesInput(messages),
    stream: true
  }
  // 与 completions 同一条规矩：模型目录里配了输出上限才下发
  if (Number(maxOutputTokens) > 0) body.max_output_tokens = Number(maxOutputTokens)
  const effort = effortOf(reasoning)
  if (effort) body.reasoning = { effort }
  if (system) body.instructions = system
  if (Array.isArray(tools) && tools.length) {
    body.tools = tools.map((t) => ({
      type: 'function', name: t.name, description: t.description, parameters: t.parameters || { type: 'object', properties: {} }
    }))
  }
  const res = await request(joinUrl(provider.baseUrl, '/responses'), {
    headers: { authorization: `Bearer ${apiKey}`, 'api-key': apiKey },
    body,
    signal
  })
  interface PendingResponseCall { id: string; name: string; args: string }
  const calls = new Map<string, PendingResponseCall>() // item_id → { id, name, args }
  let stopReason = 'stop'
  let textSeen = false
  // 终态帧到了就收工，不再干等 [DONE]（与 completions 同因，见 iterSse 注释）
  let finished = false
  const absorbOutput = (output: unknown): string => {
    if (!Array.isArray(output)) return ''
    let text = ''
    for (const raw of output) {
      if (!raw || typeof raw !== 'object') continue
      const item = raw as UnknownRecord
      if (item.type === 'function_call') {
        const id = String(item.id || item.call_id || '')
        if (id) calls.set(id, {
          id: String(item.call_id || item.id || ''),
          name: String(item.name || ''),
          args: typeof item.arguments === 'string' ? item.arguments : JSON.stringify(item.arguments || {})
        })
      } else if (item.type === 'message') {
        text += textOfContent(item.content)
      } else if (item.type === 'output_text' && typeof item.text === 'string') {
        text += item.text
      }
    }
    return text
  }
  for await (const ev of iterSse(res, {
    idleMs: STREAM_IDLE_RESPONSES_MS,
    finishGraceMs: STREAM_FINISH_GRACE_MS,
    shouldFinish: () => finished
  })) {
    const d = ev.data as UnknownRecord
    if (!d) continue
    const type = d.type || ev.event
    if (type === 'response.output_text.delta') {
      if (typeof d.delta === 'string' && d.delta) {
        textSeen = true
        yield { type: 'text-delta', text: d.delta }
      }
    } else if (type === 'response.output_text.done') {
      if (!textSeen && typeof d.text === 'string' && d.text) {
        textSeen = true
        yield { type: 'text-delta', text: d.text }
      }
    } else if (type === 'response.reasoning_summary_text.delta' || type === 'response.reasoning_text.delta') {
      if (typeof d.delta === 'string' && d.delta) yield { type: 'reasoning-delta', text: d.delta, field: 'reasoning' }
    } else if (type === 'response.output_item.added') {
      const item = d.item && typeof d.item === 'object' ? d.item as UnknownRecord : null
      if (item && item.type === 'function_call') {
        const id = String(item.id || '')
        if (id) calls.set(id, {
          id: String(item.call_id || item.id || ''),
          name: String(item.name || ''),
          args: String(item.arguments || '')
        })
      }
    } else if (type === 'response.function_call_arguments.delta') {
      const acc = calls.get(String(d.item_id || ''))
      if (acc && typeof d.delta === 'string') acc.args += d.delta
    } else if (type === 'response.completed' || type === 'response.incomplete') {
      const resp = d.response && typeof d.response === 'object' ? d.response as UnknownRecord : {}
      const finalText = absorbOutput(resp.output)
      if (finalText && !textSeen) {
        textSeen = true
        yield { type: 'text-delta', text: finalText }
      }
      if (resp.usage && typeof resp.usage === 'object') {
        const usage = resp.usage as UnknownRecord
        const details = usage.input_tokens_details && typeof usage.input_tokens_details === 'object'
          ? usage.input_tokens_details as UnknownRecord
          : {}
        yield {
          type: 'usage',
          promptTokens: Number(usage.input_tokens) || 0,
          completionTokens: Number(usage.output_tokens) || 0,
          cachedTokens: Number(details.cached_tokens) || 0
        }
      }
      // `incomplete` = 撞上 max_output_tokens（被截断）；显式告知上层，界面才能提示
      const truncated = type === 'response.incomplete' || resp.status === 'incomplete'
      stopReason = truncated ? 'length' : 'stop'
      finished = true
    } else if (type === 'response.failed' || type === 'error') {
      const response = d.response && typeof d.response === 'object' ? d.response as UnknownRecord : null
      const error = response?.error && typeof response.error === 'object' ? response.error as UnknownRecord : null
      const msg = error?.message || d.message || 'responses API failed'
      throw streamError(String(msg))
    } else if (typeof d.output_text === 'string' && d.output_text) {
      if (!textSeen) {
        textSeen = true
        yield { type: 'text-delta', text: d.output_text }
      }
      stopReason = d.status === 'incomplete' ? 'length' : 'stop'
      finished = true
    } else if (Array.isArray(d.output)) {
      const finalText = absorbOutput(d.output)
      if (finalText && !textSeen) {
        textSeen = true
        yield { type: 'text-delta', text: finalText }
      }
      stopReason = d.status === 'incomplete' ? 'length' : 'stop'
      finished = true
    }
  }
  // 没等到终态帧 = 流被掐断（同 completions，见那边的注释）
  if (!finished) throw aiError('network', '连接在回答完成前中断（未收到 response.completed），可重试')
  for (const acc of calls.values()) {
    yield { type: 'tool-call', id: acc.id, name: acc.name, args: safeParse(acc.args) }
  }
  yield { type: 'done', stopReason }
}

// ─────────────────────────────────────────────────────────────────────
// anthropic-messages（`{base}/messages`）
// ─────────────────────────────────────────────────────────────────────
interface AnthropicWireMessage { role: 'user' | 'assistant'; content: Array<Record<string, unknown>> }

function toAnthropic(messages: unknown): AnthropicWireMessage[] {
  const out: AnthropicWireMessage[] = []
  /**
   * 与 `toOpenAiChat` 同一问题的 Anthropic 版：投影里同一步的多个工具调用是
   * call → result → call → result 交错，而协议要求
   *   ① 这一步的 tool_use 块全在**同一条** assistant 里；
   *   ② 对应的 tool_result 块全在**紧随其后的同一条** user 里。
   * 另：不追加到"用户真实发的那条 user 消息"上 —— 那会把工具结果混进用户正文。
   */
  let callTarget: AnthropicWireMessage | null = null   // 可追加 tool_use 的 assistant（本函数造的那条）
  let resultTarget: AnthropicWireMessage | null = null // 可追加 tool_result 的 user（本函数造的那条）
  const orphanCalls = new Set<string>()
  for (const m of normalize(messages)) {
    if (m.role === 'user') {
      const content: Array<Record<string, unknown>> = (m.blocks || []).map((b) => b.type === 'image'
        ? { type: 'image', source: { type: 'url', url: b.ref } }
        : { type: 'text', text: b.type === 'text' ? b.text || '' : '' })
      out.push({ role: 'user', content })
      callTarget = null
      resultTarget = null
    } else if (m.role === 'assistant') {
      const content: Array<Record<string, unknown>> = []
      // 扩展思考：thinking 块必须**原样**放回 content 最前面（含 signature），
      // 否则工具回路直接 400。没有 signature 就不发 —— Anthropic 拒收空签名。
      const echo = reasoningEcho(m.reasoning)
      if (echo && echo.field === 'thinking' && echo.signature) {
        content.push({ type: 'thinking', thinking: echo.text, signature: echo.signature })
      }
      const text = asText(m.blocks)
      if (text) content.push({ type: 'text', text })
      for (const b of (m.blocks || [])) {
        if (b.type === 'tool-call') content.push({ type: 'tool_use', id: b.toolCallId || b.id, name: b.name, input: b.args || {} })
      }
      if (content.length) {
        const msg: AnthropicWireMessage = { role: 'assistant', content }
        out.push(msg)
        callTarget = msg
      } else {
        // 空 assistant（被中断 / 纯占位）不能当挂载目标，否则工具块会挂到上一步
        callTarget = null
      }
      resultTarget = null
    } else if (m.role === 'tool-call') {
      if (!callTarget) { orphanCalls.add(String(m.id == null ? '' : m.id)); continue }
      callTarget.content.push({ type: 'tool_use', id: m.id, name: m.name, input: m.args || {} })
    } else if (m.role === 'tool-result') {
      if (orphanCalls.has(String(m.id == null ? '' : m.id))) continue
      const block = { type: 'tool_result', tool_use_id: m.id, content: stringifyResult(m.result), is_error: !!m.isError }
      if (resultTarget) resultTarget.content.push(block)
      else {
        const msg: AnthropicWireMessage = { role: 'user', content: [block] }
        out.push(msg)
        resultTarget = msg
      }
    }
  }
  return out
}

async function* anthropicMessages({
  provider,
  apiKey,
  model,
  messages,
  system,
  tools,
  signal,
  maxOutputTokens,
  reasoning
}: AiProtocolRequest): AsyncGenerator<AiStreamFrame, void, void> {
  const buildBody = (useCache: boolean): Record<string, unknown> => {
    const body: Record<string, unknown> = {
      model,
      max_tokens: maxOutputTokens || 4096,
      messages: toAnthropic(messages),
      stream: true
    }
    // 扩展思考：`thinking.budget_tokens` 必须小于 max_tokens，否则直接 400
    const effort = effortOf(reasoning)
    if (effort) {
      const budget = ANTHROPIC_THINKING_BUDGET[effort]
      body.thinking = { type: 'enabled', budget_tokens: budget }
      body.max_tokens = Math.max(Number(body.max_tokens) || 4096, budget + 1024)
    }
    if (system) {
      body.system = useCache
        ? [{ type: 'text', text: system, cache_control: { type: 'ephemeral' } }]
        : system
    }
    if (Array.isArray(tools) && tools.length) {
      const list = tools.map((t) => ({
        name: t.name, description: t.description, input_schema: t.parameters || { type: 'object', properties: {} }
      })) as Array<Record<string, unknown>>
      // 最后一个工具定义作为整个工具头的缓存断点；稳定顺序由 tool-surface 保证。
      if (useCache) list[list.length - 1].cache_control = { type: 'ephemeral' }
      body.tools = list
    }
    return body
  }
  let res: SseResponse
  try {
    res = await request(joinUrl(provider.baseUrl, '/messages'), {
      headers: { 'x-api-key': apiKey, authorization: `Bearer ${apiKey}`, 'anthropic-version': ANTHROPIC_VERSION },
      body: buildBody(true),
      signal
    })
  } catch (err) {
    const record = err && typeof err === 'object' ? err as UnknownRecord : {}
    // Anthropic 官方支持 cache_control；少数兼容网关会拒绝该字段，降级重试一次。
    if (Number(record.status) !== 400 || !/cache_control/i.test(String(record.message || ''))) throw err
    res = await request(joinUrl(provider.baseUrl, '/messages'), {
      headers: { 'x-api-key': apiKey, authorization: `Bearer ${apiKey}`, 'anthropic-version': ANTHROPIC_VERSION },
      body: buildBody(false),
      signal
    })
  }
  // index → { id, name, json }
  interface AnthropicToolBlock { id: string; name: string; json: string }
  const blocks = new Map<number, AnthropicToolBlock>()
  let stopReason = 'stop'
  let textSeen = false
  // `message_stop` / 非空 stop_reason = 答案收完；此后只等宽限，不再无限挂着
  let finished = false
  const absorbContent = (content: unknown): string => {
    if (!Array.isArray(content)) return ''
    let text = ''
    for (const raw of content) {
      if (!raw || typeof raw !== 'object') continue
      const block = raw as UnknownRecord
      if (block.type === 'text' && typeof block.text === 'string') {
        text += block.text
      } else if (block.type === 'tool_use') {
        blocks.set(blocks.size, {
          id: String(block.id || ''),
          name: String(block.name || ''),
          json: typeof block.input === 'string' ? block.input : JSON.stringify(block.input || {})
        })
      }
    }
    return text
  }
  for await (const ev of iterSse(res, {
    idleMs: STREAM_IDLE_MS,
    finishGraceMs: STREAM_FINISH_GRACE_MS,
    shouldFinish: () => finished
  })) {
    const d = ev.data as UnknownRecord
    if (!d) continue
    const type = d.type || ev.event
    if (type === 'content_block_start') {
      const cb = d.content_block && typeof d.content_block === 'object' ? d.content_block as UnknownRecord : {}
      if (cb.type === 'tool_use') blocks.set(Number(d.index), {
        id: String(cb.id || ''),
        name: String(cb.name || ''),
        json: typeof cb.input === 'string' ? cb.input : (cb.input && typeof cb.input === 'object' ? JSON.stringify(cb.input) : '')
      })
      else if (cb.type === 'text' && typeof cb.text === 'string' && cb.text) {
        textSeen = true
        yield { type: 'text-delta', text: cb.text }
      } else if (cb.type === 'thinking' && typeof cb.thinking === 'string' && cb.thinking) {
        yield { type: 'reasoning-delta', text: cb.thinking, field: 'thinking' }
      }
    } else if (type === 'content_block_delta') {
      const delta = d.delta && typeof d.delta === 'object' ? d.delta as UnknownRecord : {}
      if (delta.type === 'text_delta' && typeof delta.text === 'string' && delta.text) {
        textSeen = true
        yield { type: 'text-delta', text: delta.text }
      }
      // 扩展思考：正文增量 + 签名增量都要收，签名字段会跨帧到达
      else if (delta.type === 'thinking_delta' && typeof delta.thinking === 'string' && delta.thinking) yield { type: 'reasoning-delta', text: delta.thinking, field: 'thinking' }
      else if (delta.type === 'signature_delta' && typeof delta.signature === 'string' && delta.signature) yield { type: 'reasoning-delta', signature: delta.signature, field: 'thinking' }
      if (delta.type === 'input_json_delta' && blocks.has(Number(d.index))) {
        const block = blocks.get(Number(d.index))
        if (block && typeof delta.partial_json === 'string') block.json += delta.partial_json
      }
    } else if (type === 'message_start') {
      const message = d.message && typeof d.message === 'object' ? d.message as UnknownRecord : null
      const initialText = absorbContent(message?.content)
      if (initialText && !textSeen) {
        textSeen = true
        yield { type: 'text-delta', text: initialText }
      }
      const usage = message?.usage && typeof message.usage === 'object' ? message.usage as UnknownRecord : null
      if (usage) yield {
        type: 'usage',
        promptTokens: Number(usage.input_tokens) || 0,
        completionTokens: Number(usage.output_tokens) || 0,
        cachedTokens: Number(usage.cache_read_input_tokens) || 0
      }
    } else if (type === 'message_delta') {
      const usage = d.usage && typeof d.usage === 'object' ? d.usage as UnknownRecord : null
      if (usage && typeof usage.output_tokens === 'number') {
        yield { type: 'usage', promptTokens: 0, completionTokens: usage.output_tokens }
      }
      // `max_tokens` = 撞上输出上限被截断，原样上报（界面据此提示）
      const delta = d.delta && typeof d.delta === 'object' ? d.delta as UnknownRecord : null
      if (delta && delta.stop_reason) {
        stopReason = delta.stop_reason === 'max_tokens' ? 'length' : String(delta.stop_reason)
        finished = true
      }
    } else if (type === 'message_stop') {
      finished = true
    } else if (type === 'error') {
      const error = d.error && typeof d.error === 'object' ? d.error as UnknownRecord : null
      throw streamError(String(error?.message || 'anthropic stream error'))
    } else if (Array.isArray(d.content)) {
      const fullText = absorbContent(d.content)
      if (fullText && !textSeen) {
        textSeen = true
        yield { type: 'text-delta', text: fullText }
      }
      if (d.stop_reason) stopReason = d.stop_reason === 'max_tokens' ? 'length' : String(d.stop_reason)
      finished = true
    }
  }
  // 没等到 message_stop / stop_reason = 流被掐断（同 completions）
  if (!finished) throw aiError('network', '连接在回答完成前中断（未收到 message_stop），可重试')
  for (const acc of blocks.values()) {
    yield { type: 'tool-call', id: acc.id, name: acc.name, args: safeParse(acc.json) }
  }
  yield { type: 'done', stopReason }
}

// ─────────────────────────────────────────────────────────────────────
const PROTOCOLS = Object.freeze({
  'openai-completions': openaiCompletions,
  openai: openaiCompletions,
  'openai-chat': openaiCompletions,
  compat: openaiCompletions,
  'openai-responses': openaiResponses,
  responses: openaiResponses,
  'anthropic-messages': anthropicMessages,
  anthropic: anthropicMessages,
  claude: anthropicMessages
})

/**
 * 读一段 JSON 正文，带时限。
 * 解析失败返回 null —— 探测只看**连通性**，网关返回 HTML 也不该判成"连不上"。
 */
function readJsonWithTimeout(res: SseResponse, ms: number): Promise<unknown> {
  return new Promise<unknown>((resolve) => {
    const timer = setTimeout(() => {
      try { res.body && typeof res.body.cancel === 'function' && res.body.cancel() } catch (_) {}
      resolve(null)
    }, ms)
    res.json().then(
      (data) => { clearTimeout(timer); resolve(data) },
      () => { clearTimeout(timer); resolve(null) }
    )
  })
}

/**
 * 连接测试：拉一次 `/models`，能 200 且解析出列表就算通。
 * 不在这里跑一次真实对话 —— 那会花用户的钱，而"能不能连上"不需要付钱验证。
 */
async function testConnection({ provider, apiKey }: Pick<AiProtocolRequest, 'provider' | 'apiKey'>): Promise<{ ok: true; models: Array<{ id: string; label: string }> }> {
  const res = await request(joinUrl(provider.baseUrl, '/models'), {
    method: 'GET',
    // 探测不该让用户干等两分钟：20 秒连不上就是连不上
    timeoutMs: 20_000,
    headers: /anthropic|claude/i.test(provider.protocol)
      ? { 'x-api-key': apiKey, authorization: `Bearer ${apiKey}`, 'anthropic-version': ANTHROPIC_VERSION }
      : { authorization: `Bearer ${apiKey}`, 'api-key': apiKey }
  })
  let models: Array<{ id: string; label: string }> = []
  try {
    // 响应头到了不代表正文会来（半死的连接会一直不结束）：读正文同样有时限
    const data = await readJsonWithTimeout(res, 20_000)
    const record = data && typeof data === 'object' ? data as UnknownRecord : {}
    const nested = record.result && typeof record.result === 'object' ? record.result as UnknownRecord : {}
    const list = Array.isArray(data)
      ? data
      : Array.isArray(record.data)
        ? record.data
        : Array.isArray(record.models)
          ? record.models
          : Array.isArray(nested.data)
            ? nested.data
            : Array.isArray(nested.models) ? nested.models : []
    models = list.map((item) => {
      const model = item && typeof item === 'object' ? item as UnknownRecord : {}
      const id = String(model.id || model.name || item)
      return { id, label: String(model.display_name || model.displayName || model.id || model.name || item) }
    })
  } finally {
    if (typeof res.__release === 'function') res.__release()
  }
  return { ok: true, models }
}

module.exports = { PROTOCOLS, testConnection, iterSse, reasoningEchoField, reasoningEcho }
