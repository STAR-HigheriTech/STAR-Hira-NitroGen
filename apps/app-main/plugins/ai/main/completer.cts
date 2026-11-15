/**
 * AI 引擎 · 一次性补全（PART15 §10「记忆与增强」）。
 *
 * ══════════════════════════════════════════════════════════════════════
 * 为什么单独一份，而不是复用回合执行器
 * ══════════════════════════════════════════════════════════════════════
 * 「把这一页压成 80 字摘要」「子智能体再走一步」这类内部调用**不该**：
 *   · 往用户会话里落事件（会污染聊天记录、改变标题、触发未读）；
 *   · 推流到面板（用户会看到两段互不相干的文字交错）；
 *   · 占用会话的"运行中"槽位（会把面板的停止按钮抢走）。
 * 所以它只做一件事：**给一段 messages，拿回文本与工具调用**。
 *
 * 仍然复用 `core/providers.cjs` 的协议层（SSE → 帧）—— 那是唯一真源，
 * 再写一套 HTTP 解析必然与主链路漂移（重试、usage 累计、工具增量拼接）。
 *
 * 超时默认 90 秒：内部调用没有"用户看着等"的期待，宁可失败也不能挂死回合。
 */

const { PROTOCOLS } = require('../core/providers.cjs')

const DEFAULT_TIMEOUT_MS = 90000

interface CompletionRequest {
  sessionId?: string
  model?: string | null
  system?: string
  messages: Array<{ role: string; blocks?: unknown[]; id?: string; name?: string; args?: unknown; result?: unknown; isError?: boolean }>
  tools?: Array<{ name: string; description: string; parameters: unknown }>
  maxOutputTokens?: number
  reasoning?: string
  signal?: AbortSignal
  timeoutMs?: number
}
interface CompletionProvider { id: string; protocol: string }
interface CompletionModel { id: string }
interface CompletionStore {
  getSession(id: string): unknown
  getCredential(providerId: string): string | null | undefined
}
interface CompleterDeps {
  store: CompletionStore
  resolveModel(session: unknown, requested?: string | null): { provider: CompletionProvider; model: CompletionModel } | null
  logger?: { warn?(...args: unknown[]): void }
}

function fail(code: string, message?: string): Error & { code: string } {
  const err = new Error(message || code) as Error & { code: string }
  err.code = code
  return err
}

/**
 * @param {{
 *   store: any,
 *   resolveModel: (session: any, requested?: string) => ({ provider: any, model: any } | null),
 *   logger?: any
 * }} deps
 */
function createCompleter({ store, resolveModel, logger = console }: CompleterDeps) {
  /**
   * 一次性补全。
   * @param {{
   *   sessionId?: string,
   *   model?: string | null,
   *   system?: string,
   *   messages: Array<{ role: string, blocks?: any[], id?: string, name?: string, args?: any, result?: any, isError?: boolean }>,
   *   tools?: Array<{ name: string, description: string, parameters: any }>,
   *   maxOutputTokens?: number,
   *   reasoning?: string,
   *   signal?: AbortSignal,
   *   timeoutMs?: number
   * }} req
   * @returns {Promise<{ text: string, calls: Array<{ id: string, name: string, args: any }>, reasoning: { text: string, field: string, signature?: string } | null, usage: { promptTokens: number, completionTokens: number, cachedTokens: number }, stopReason: string, model: { providerId: string, modelId: string } }>}
   */
  async function complete(req: CompletionRequest): Promise<{
    text: string
    calls: Array<{ id: string; name: string; args: unknown }>
    reasoning: { text: string; field: string; signature?: string } | null
    usage: { promptTokens: number; completionTokens: number; cachedTokens: number }
    stopReason: string
    model: { providerId: string; modelId: string }
  }> {
    const session = req.sessionId ? store.getSession(String(req.sessionId)) : null
    const resolved = resolveModel(session, req.model || null)
    if (!resolved || !resolved.provider || !resolved.model) throw fail('AI_NO_MODEL', '尚未配置模型服务')

    const { provider, model } = resolved
    const apiKey = store.getCredential(provider.id)
    if (!apiKey) throw fail('AI_NO_KEY', '当前模型服务尚未配置密钥')

    const protocol = PROTOCOLS[provider.protocol]
    if (!protocol) throw fail('AI_BAD_PROTOCOL', `不支持的协议：${provider.protocol}`)

    const controller = new AbortController()
    const outer = req.signal
    let timedOut = false
    const onAbort = () => { try { controller.abort() } catch (_) {} }
    if (outer) {
      if (outer.aborted) onAbort()
      else outer.addEventListener('abort', onAbort, { once: true })
    }
    const timeoutMs = Number(req.timeoutMs) > 0 ? Number(req.timeoutMs) : DEFAULT_TIMEOUT_MS
    // 同一段时限覆盖「等响应头 + 收完整条流」：内部调用宁可失败也不能挂死回合
    const timer = setTimeout(() => { timedOut = true; onAbort() }, timeoutMs)

    const calls: Array<{ id: string; name: string; args: unknown }> = []
    const usage = { promptTokens: 0, completionTokens: 0, cachedTokens: 0 }
    let text = ''
    let stopReason = 'stop'
    // 思考模式：推理必须随结果一起交回调用方（工具回路要原样回传，见 providers.cjs）。
    let reasoningText = ''
    let reasoningField = ''
    let reasoningSignature = ''

    try {
      for await (const frame of protocol({
        provider,
        apiKey,
        model: model.id,
        messages: Array.isArray(req.messages) ? req.messages : [],
        system: req.system || '',
        tools: Array.isArray(req.tools) ? req.tools : [],
        signal: controller.signal,
        maxOutputTokens: req.maxOutputTokens || undefined,
        reasoning: req.reasoning || undefined
      })) {
        if (!frame) continue
        if (frame.type === 'text-delta') {
          text += frame.text
        } else if (frame.type === 'reasoning-delta') {
          if (frame.field) reasoningField = frame.field
          if (frame.text) reasoningText += frame.text
          if (frame.signature) reasoningSignature += frame.signature
        } else if (frame.type === 'tool-call') {
          calls.push({ id: frame.id || `call_${calls.length}`, name: frame.name, args: frame.args || {} })
        } else if (frame.type === 'usage') {
          usage.promptTokens = Math.max(usage.promptTokens, frame.promptTokens || 0)
          usage.completionTokens = Math.max(usage.completionTokens, frame.completionTokens || 0)
          usage.cachedTokens = Math.max(usage.cachedTokens, frame.cachedTokens || 0)
        } else if (frame.type === 'done') {
          stopReason = frame.stopReason || 'stop'
        }
      }
    } catch (e: unknown) {
      if (outer && outer.aborted) throw e
      // 超时中断不该把 "The operation was aborted" 原样抛给上层（用户看不懂）
      if (timedOut) throw fail('timeout', `补全超时（${Math.round(timeoutMs / 1000)} 秒）`)
      try { logger.warn?.('[ai] 一次性补全失败：', e instanceof Error ? e.message : String(e)) } catch (_) {}
      throw e
    } finally {
      clearTimeout(timer)
      if (outer) { try { outer.removeEventListener('abort', onAbort) } catch (_) {} }
    }

    return {
      text: String(text || '').trim(),
      calls,
      reasoning: (reasoningText || reasoningField)
        ? {
            text: reasoningText,
            field: reasoningField || 'reasoning_content',
            ...(reasoningSignature ? { signature: reasoningSignature } : {})
          }
        : null,
      usage,
      stopReason,
      model: { providerId: provider.id, modelId: model.id }
    }
  }

  return { complete }
}

module.exports = { createCompleter }
