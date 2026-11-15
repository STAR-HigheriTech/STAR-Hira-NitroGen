/**
 * AI 引擎 · 受限运行时端口（`ai.engine.runtime`）。
 *
 * 能力插件只拿到完成本职工作的最小动作，不拿 store / sqlite / runner 本体：
 *   · 本地 Agent 插件 → workspaces + processRunner
 *   · CLI 插件       → 会话 / 回合 / 结果 / 取消
 * 这样插件被停用时，能力随插件消失；内部存储契约也不会泄漏成公共 API。
 */

const { projectMessages } = require('../core/store.cjs')

interface SessionRecord extends Record<string, unknown> {
  id: string
}

interface ProviderRecord extends Record<string, unknown> {
  id: string
  enabled?: boolean
  models?: unknown[]
}

interface StorePort {
  listProviders(): ProviderRecord[]
  createSession(input?: Record<string, unknown>): SessionRecord | null
  getSession(id: string): SessionRecord | null
  deleteSession(id: string): unknown
  listRecentEvents(sessionId: string, limit?: number): Array<Record<string, unknown>>
}

interface RunnerPort {
  start(input: Record<string, unknown>): { sessionId: string; turnId: string }
  stop(input: { sessionId: string }): unknown
  waitForTurn(sessionId: string, turnId: string): Promise<Record<string, unknown>>
}

interface WorkspacePort extends Record<string, unknown> {
  current(sessionId: string): unknown
  list(): unknown
  open(input?: Record<string, unknown>): unknown
  bind(sessionId: string, workspaceId: string): unknown
  instructions(sessionId: string): string
  resolve(sessionId: string, target?: unknown, opts?: Record<string, unknown>): Promise<unknown>
}

interface ProcessRunnerPort {
  run(command: string, args?: readonly string[], options?: Record<string, unknown>): Promise<{
    stdout: string
    stderr: string
  }>
}

interface RuntimeDeps {
  store: StorePort
  runner: RunnerPort
  workspaces: WorkspacePort
  processRunner: ProcessRunnerPort | null
}

interface TurnResult {
  text: string
  sources: unknown[]
  turnId: string
}

function cleanText(value: unknown, max = 50_000): string {
  const text = String(value == null ? '' : value).trim()
  return text.length > max ? text.slice(0, max) : text
}

function createEngineRuntime({ store, runner, workspaces, processRunner }: RuntimeDeps) {
  function providerStatus() {
    const providers = store.listProviders().map((provider) => ({
      id: provider.id,
      enabled: provider.enabled !== false,
      models: Array.isArray(provider.models) ? provider.models.length : 0
    }))
    return {
      providers,
      ready: providers.some((provider) => provider.enabled && provider.models > 0)
    }
  }

  function createSession(input: Record<string, unknown> = {}) {
    return store.createSession({
      title: cleanText(input.title, 120)
    })
  }

  function deleteSession(sessionId: unknown): void {
    const id = String(sessionId || '')
    if (id) store.deleteSession(id)
  }

  function startTurn(input: Record<string, unknown> = {}) {
    const sessionId = String(input.sessionId || '')
    if (!sessionId || !store.getSession(sessionId)) {
      throw Object.assign(new Error('会话不存在'), { code: 'AI_NO_SESSION' })
    }
    const text = cleanText(input.text)
    const blocks = (Array.isArray(input.blocks) ? input.blocks : [])
      .filter((block): block is Record<string, unknown> => !!block && typeof block === 'object' && block.type === 'text')
      .slice(0, 20)
      .map((block) => ({ type: 'text', text: cleanText(block.text, 20_000) }))
      .filter((block) => block.text)
    if (!text && !blocks.length) {
      throw Object.assign(new Error('任务内容为空'), { code: 'AI_EMPTY' })
    }
    return runner.start({
      sessionId,
      text,
      blocks,
      model: typeof input.model === 'string' ? input.model : null,
      reasoning: typeof input.reasoning === 'string' ? input.reasoning : 'auto',
      approvalMode: input.approvalMode === 'allow' ? 'allow' : 'ask'
    })
  }

  async function waitTurn(sessionId: unknown, turnId: unknown) {
    const sid = String(sessionId || '')
    const tid = String(turnId || '')
    if (!sid || !tid) throw Object.assign(new Error('缺少会话或回合 id'), { code: 'AI_BAD_ARGS' })
    return runner.waitForTurn(sid, tid)
  }

  function stopTurn(sessionId: unknown) {
    const sid = String(sessionId || '')
    if (!sid) return { ok: false, reason: 'not-running' }
    return runner.stop({ sessionId: sid })
  }

  function turnResult(sessionId: unknown, turnId: unknown): TurnResult {
    const sid = String(sessionId || '')
    const tid = String(turnId || '')
    const messages = projectMessages(store.listRecentEvents(sid, 1_000)).messages
    for (let i = messages.length - 1; i >= 0; i -= 1) {
      const message = messages[i]
      if (message.role !== 'assistant') continue
      if (message.turnId && String(message.turnId) !== tid) continue
      const text = (Array.isArray(message.blocks) ? message.blocks : [])
        .filter((block: Record<string, unknown>) => block.type === 'text' && block.hidden !== true)
        .map((block: Record<string, unknown>) => String(block.text || ''))
        .join('\n')
        .trim()
      if (!text) continue
      return {
        text,
        sources: Array.isArray(message.sources) ? message.sources : [],
        turnId: tid
      }
    }
    return { text: '', sources: [], turnId: tid }
  }

  return {
    providerStatus,
    createSession,
    deleteSession,
    startTurn,
    waitTurn,
    stopTurn,
    turnResult,
    workspaces,
    processRunner
  }
}

module.exports = { createEngineRuntime }
