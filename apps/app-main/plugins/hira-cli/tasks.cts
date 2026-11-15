/**
 * Hira Agent CLI · 可恢复的自然语言任务。
 *
 * 一个任务 = 一条独立 AI 会话 + 一个同生命周期的后台浏览器上下文。
 * HTTP 调用只负责提交，模型回合继续在 Hira 内运行；任务状态落 SQLite，
 * 调用方断开、终端关闭或 Agent 进程重启都不会打断执行。
 */

const crypto = require('crypto')

interface SqliteRunResult {
  changes?: number | bigint
}

interface SqliteStatement {
  run(...params: unknown[]): SqliteRunResult
  get<T = Record<string, unknown>>(...params: unknown[]): T | undefined
  all<T = Record<string, unknown>>(...params: unknown[]): T[]
}

interface SqlitePort {
  prepare(sql: string): SqliteStatement
}

interface SessionRecord {
  id: string
  title?: string
  providerId?: string | null
  modelId?: string | null
  createdAt?: number
  updatedAt?: number
}

interface TurnOutcome {
  stopReason: string
  usage?: Record<string, unknown>
  failure?: { message?: string; code?: string; stack?: string } | null
}

interface EngineRuntimePort {
  createSession(input?: Record<string, unknown>): SessionRecord | null
  deleteSession(sessionId: string): void
  startTurn(input: Record<string, unknown>): { sessionId: string; turnId: string }
  stopTurn(sessionId: string): unknown
  waitTurn(sessionId: string, turnId: string): Promise<TurnOutcome>
  turnResult(sessionId: string, turnId: string): { text: string; sources: unknown[] }
}

interface CliTaskDeps {
  sqlite: SqlitePort
  runtime: EngineRuntimePort
  browser: {
    ensureAi(sessionId: string): unknown
    close?(context: string): unknown
  }
  notify?: (payload: Record<string, unknown>) => void
  logger?: Pick<Console, 'warn' | 'info'>
}

interface TaskRow {
  id: string
  session_id: string
  turn_id: string | null
  prompt: string
  status: string
  result: string | null
  error: string | null
  usage: string | null
  created_at: number
  updated_at: number
  finished_at: number | null
}

const TASK_ID = /^hira_[a-f0-9]{16}$/
const MAX_PROMPT_CHARS = 50_000

function taskPreamble(): string {
  const stamped = new Intl.DateTimeFormat('zh-CN', {
    dateStyle: 'full',
    timeStyle: 'short'
  }).format(new Date())
  return [
    '[Hira CLI 后台任务]',
    `当前本机时间：${stamped}。用户说“今天 / 最新”时，以这个日期为基准核对页面发布时间，不能把旧内容冒充今日更新。`,
    '需要浏览网页时优先使用 agent_browser；它运行在隐藏窗口里，不会切换用户当前标签或抢焦点。',
    '页面操作按“打开 -> 读取/搜索 -> 跟随链接 -> 目标页读取”推进；需要点击、填写或提交时，用户已通过 CLI 授权本次任务。',
    '先取证再下结论，事实与推断分开。最终直接交付用户要的结果；多个条目、更新、来源或功能必须分组清单罗列，比较信息用表格。不描述内部工具步骤，不伪造未读到的信息。'
  ].join('\n')
}

function now(): number {
  return Date.now()
}

function newTaskId(): string {
  return `hira_${crypto.randomBytes(8).toString('hex')}`
}

function cleanText(value: unknown, max = 200_000): string {
  const text = String(value == null ? '' : value).trim()
  return text.length > max ? `${text.slice(0, max)}\n…（已截断）` : text
}

function taskError(code: string, message: string): Error & { code: string } {
  return Object.assign(new Error(message), { code })
}

function mapTask(row: TaskRow, includeResult = true) {
  const base = {
    taskId: row.id,
    sessionId: row.session_id,
    turnId: row.turn_id,
    status: row.status,
    prompt: row.prompt,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    finishedAt: row.finished_at
  }
  if (!includeResult) return base
  let usage: unknown = null
  try { usage = row.usage ? JSON.parse(row.usage) : null } catch (_) {}
  return {
    ...base,
    result: row.result || '',
    error: row.error || '',
    usage
  }
}

function createCliTasks({ sqlite, runtime, browser, notify, logger = console }: CliTaskDeps) {
  const db = () => sqlite
  const activeSessions = new Set<string>()

  function getRow(taskId: string): TaskRow | null {
    const row = db().prepare('SELECT * FROM ai_cli_task WHERE id = ?').get<TaskRow>(String(taskId || ''))
    return row || null
  }

  function update(taskId: string, patch: Partial<Pick<TaskRow, 'turn_id' | 'status' | 'result' | 'error' | 'usage' | 'finished_at'>>): void {
    const current = getRow(taskId)
    if (!current) return
    const next = {
      turn_id: patch.turn_id !== undefined ? patch.turn_id : current.turn_id,
      status: patch.status !== undefined ? patch.status : current.status,
      result: patch.result !== undefined ? patch.result : current.result,
      error: patch.error !== undefined ? patch.error : current.error,
      usage: patch.usage !== undefined ? patch.usage : current.usage,
      finished_at: patch.finished_at !== undefined ? patch.finished_at : current.finished_at
    }
    db().prepare(
      `UPDATE ai_cli_task
          SET turn_id = ?, status = ?, result = ?, error = ?, usage = ?, updated_at = ?, finished_at = ?
        WHERE id = ?`
    ).run(
      next.turn_id,
      next.status,
      next.result,
      next.error,
      next.usage,
      now(),
      next.finished_at,
      taskId
    )
  }

  function settle(taskId: string, sessionId: string, turnId: string, outcome: TurnOutcome): void {
    try {
      const final = runtime.turnResult(sessionId, turnId)
      const usage = outcome && outcome.usage && typeof outcome.usage === 'object'
        ? JSON.stringify(outcome.usage)
        : null
      if (outcome && outcome.stopReason === 'error') {
        update(taskId, {
          status: 'failed',
          result: cleanText(final.text),
          error: cleanText(outcome.failure?.message || 'AI 回合执行失败', 8_000),
          usage,
          finished_at: now()
        })
      } else if (outcome && outcome.stopReason === 'aborted') {
        update(taskId, {
          status: 'cancelled',
          result: cleanText(final.text),
          error: '任务已取消',
          usage,
          finished_at: now()
        })
      } else if (!final.text) {
        update(taskId, {
          status: 'failed',
          result: '',
          error: '任务结束但没有生成可交付结果',
          usage,
          finished_at: now()
        })
      } else {
        update(taskId, {
          status: 'completed',
          result: cleanText(final.text),
          error: '',
          usage,
          finished_at: now()
        })
      }
    } catch (error) {
      logger.warn?.('[hira-cli] settle task failed:', error instanceof Error ? error.message : String(error))
      update(taskId, {
        status: 'failed',
        error: cleanText(error instanceof Error ? error.message : String(error), 8_000),
        finished_at: now()
      })
    }
    activeSessions.delete(sessionId)
    try { browser.close?.(`ai:${sessionId}`) } catch (_) {}
    notify?.({ taskId, sessionId, reason: 'cli-task-end' })
  }

  function start(input: Record<string, unknown>) {
    const prompt = cleanText(input.prompt || input.text, MAX_PROMPT_CHARS)
    if (!prompt) throw taskError('CLI_EMPTY_PROMPT', '任务指令不能为空')

    const session = runtime.createSession({ title: '' })
    if (!session) throw taskError('CLI_SESSION_FAILED', '无法创建任务会话')
    activeSessions.add(session.id)

    const taskId = newTaskId()
    const createdAt = now()
    try {
      browser.ensureAi(session.id)
      const turn = runtime.startTurn({
        sessionId: session.id,
        text: prompt,
        blocks: [{ type: 'text', text: taskPreamble() }],
        model: typeof input.model === 'string' ? input.model : null,
        reasoning: typeof input.reasoning === 'string' ? input.reasoning : 'auto',
        approvalMode: 'allow'
      })
      db().prepare(
        `INSERT INTO ai_cli_task
          (id, session_id, turn_id, prompt, status, result, error, usage, created_at, updated_at, finished_at)
         VALUES (?, ?, ?, ?, 'running', NULL, NULL, NULL, ?, ?, NULL)`
      ).run(taskId, session.id, turn.turnId, prompt, createdAt, createdAt)
      runtime.waitTurn(session.id, turn.turnId)
        .then((outcome) => settle(taskId, session.id, turn.turnId, outcome))
        .catch((error: unknown) => settle(taskId, session.id, turn.turnId, {
          stopReason: 'error',
          failure: { message: error instanceof Error ? error.message : String(error) }
        }))
      notify?.({ taskId, sessionId: session.id, reason: 'cli-task-start' })
      return mapTask(getRow(taskId) as TaskRow, false)
    } catch (error) {
      activeSessions.delete(session.id)
      try { browser.close?.(`ai:${session.id}`) } catch (_) {}
      try { runtime.stopTurn(session.id) } catch (_) {}
      try { runtime.deleteSession(session.id) } catch (_) {}
      if (getRow(taskId)) {
        update(taskId, {
          status: 'failed',
          error: cleanText(error instanceof Error ? error.message : String(error), 8_000),
          finished_at: now()
        })
      }
      throw error
    }
  }

  function status(input: string | Record<string, unknown>) {
    const taskId = typeof input === 'string' ? input : String(input.taskId || '')
    const row = getRow(taskId)
    if (!row) throw taskError('CLI_TASK_NOT_FOUND', '任务不存在')
    return mapTask(row, false)
  }

  function result(input: string | Record<string, unknown>) {
    const taskId = typeof input === 'string' ? input : String(input.taskId || '')
    const row = getRow(taskId)
    if (!row) throw taskError('CLI_TASK_NOT_FOUND', '任务不存在')
    const final = row.status === 'completed' || row.status === 'failed' || row.status === 'cancelled'
    const sources = final ? runtime.turnResult(row.session_id, String(row.turn_id || '')).sources : []
    return { ...mapTask(row), sources }
  }

  function cancel(input: string | Record<string, unknown>) {
    const taskId = typeof input === 'string' ? input : String(input.taskId || '')
    const row = getRow(taskId)
    if (!row) throw taskError('CLI_TASK_NOT_FOUND', '任务不存在')
    if (row.status !== 'running' && row.status !== 'cancelling') return mapTask(row, false)
    update(taskId, { status: 'cancelling' })
    runtime.stopTurn(row.session_id)
    return mapTask(getRow(taskId) as TaskRow, false)
  }

  function list(input: Record<string, unknown> = {}) {
    const limit = Math.min(Math.max(Math.round(Number(input.limit) || 20), 1), 100)
    const rows = db().prepare(
      'SELECT * FROM ai_cli_task ORDER BY updated_at DESC LIMIT ?'
    ).all<TaskRow>(limit)
    return { tasks: rows.map((row) => mapTask(row, false)), total: rows.length }
  }

  function recoverInterrupted(): void {
    const t = now()
    db().prepare(
      `UPDATE ai_cli_task
          SET status = 'interrupted',
              error = 'Hira 已重启，旧任务已中断',
              updated_at = ?,
              finished_at = ?
        WHERE status IN ('running', 'cancelling')`
    ).run(t, t)
  }

  function dispose(): void {
    for (const sessionId of Array.from(activeSessions)) {
      try { runtime.stopTurn(sessionId) } catch (_) {}
    }
    activeSessions.clear()
  }

  function validateId(value: unknown): string {
    const id = String(value || '')
    if (!TASK_ID.test(id)) throw taskError('CLI_BAD_TASK_ID', '任务 id 格式不正确')
    return id
  }

  recoverInterrupted()

  return {
    start,
    status: (input: string | Record<string, unknown>) => {
      if (typeof input !== 'string') input = { ...input, taskId: validateId(input.taskId) }
      else input = validateId(input)
      return status(input)
    },
    result: (input: string | Record<string, unknown>) => {
      if (typeof input !== 'string') input = { ...input, taskId: validateId(input.taskId) }
      else input = validateId(input)
      return result(input)
    },
    cancel: (input: string | Record<string, unknown>) => {
      if (typeof input !== 'string') input = { ...input, taskId: validateId(input.taskId) }
      else input = validateId(input)
      return cancel(input)
    },
    list,
    dispose
  }
}

module.exports = { createCliTasks }
