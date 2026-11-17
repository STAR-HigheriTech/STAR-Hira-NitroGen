/**
 * AI 引擎 · 子智能体（PART15 §10.3「多智能体」）。
 *
 * ══════════════════════════════════════════════════════════════════════
 * 它是什么，以及**不是什么**
 * ══════════════════════════════════════════════════════════════════════
 * 一个**受限的、可被主智能体调用的嵌套循环**：给一个角色（研究 / 操作 / 写作）
 * 与一句话任务，它自己多步调用工具，最后只回一段结论。
 *
 * 它**不是**一个新的会话：
 *   · 不落 `ai_event` —— 中间步骤不进用户聊天记录（否则一轮提问会炸出几十条工具卡）；
 *   · 不推流 —— 主智能体只在它结束时拿到一段结论；
 *   · 不占会话运行槽 —— 主回合还在跑，子智能体是它内部的一步。
 * 最终用量在结束时**合并记到父会话**（成本仍然看得见，只是不打扰对话）。
 *
 * ══════════════════════════════════════════════════════════════════════
 * 三条安全边界
 * ══════════════════════════════════════════════════════════════════════
 *   1. **角色白名单**：每个角色只看得见固定的一组工具；`agent_delegate` 自身
 *      不在任何白名单里 —— 子智能体不能再生子智能体（递归 = 成本失控）。
 *   2. **同一道审批闸**：调用走 `main/tool-gate.cjs`，与主智能体完全同源。
 *      没有界面 = 拒绝；用户没勾记住就得问。
 *   3. **预算安全线**：默认 24 步、上限 64 步。既能完成多页面查证，也避免
 *      模型失去停止意图后无限消耗。
 */

const { createToolGate } = require('./tool-gate.cjs')
const { withTimeout } = require('./async-guard.cjs')

const DEFAULT_STEPS = 24
const MAX_STEPS_CAP = 64
/** 最终结论进主模型上下文的字符上限（与工具结果预算同一量级）。 */
const OUTPUT_LIMIT = 4000
/** 一次子步骤的输出上限：子智能体不该写长文，长文由主智能体统一产出。 */
const STEP_MAX_TOKENS = 1600
/** 子步骤超时（毫秒）—— 比一次性补全更宽松，因为它可能连跑几次工具。 */
const STEP_TIMEOUT_MS = 150000
/** 单个工具在子智能体里的安全上限。 */
const TOOL_TIMEOUT_MS = 180000
const MAX_CONCURRENT_TASKS = 4
const TASK_RETENTION_MS = 10 * 60_000

type SubAgentStatus = 'running' | 'completed' | 'failed' | 'aborted'

interface ManagedSubAgentTask {
  taskId: string
  sessionId: string
  role: string
  task: string
  status: SubAgentStatus
  startedAt: number
  finishedAt: number | null
  controller: AbortController
  promise: Promise<unknown>
  result?: unknown
  error?: string
}

/**
 * 角色档案。
 *
 * `tools` 是**能力清单**而不是"推荐清单"：不在里面的工具，子智能体连 schema
 * 都看不到（模型不会去调一个它不知道存在的工具），这是最省事也最有效的收敛方式。
 */
interface SubAgentProfile {
  key: string
  label: string
  system: string
  tools: readonly string[]
}

interface ToolDefinition {
  name: string
  description?: string
  parameters?: unknown
  execute(args: Record<string, unknown>, ctx: Record<string, unknown>): unknown
}

interface CompletionCall {
  id: string
  name: string
  args?: unknown
}

interface CompletionStep {
  text?: string
  reasoning?: unknown
  calls: CompletionCall[]
  model?: { providerId: string; modelId: string }
  usage: { promptTokens?: number; completionTokens?: number; cachedTokens?: number }
}

interface SubAgentRequest {
  role?: string
  task?: string
  context?: string
  maxSteps?: number
  sessionId?: string
  model?: string | null
  approvalMode?: string
  signal?: AbortSignal
}

interface SubAgentDeps {
  store: {
    audit(row: unknown): void
    recordUsage(row: Record<string, unknown>): void
  }
  toolRegistry: {
    list(ctx: Record<string, unknown>): ToolDefinition[]
  }
  complete(request: Record<string, unknown>): Promise<CompletionStep>
  buildToolCtx(sessionId: string): Record<string, unknown>
  approvals: { request(payload: Record<string, unknown>): Promise<{ decision?: 'allow' | 'deny'; reason?: string; remember?: boolean }> }
  grants: { has(toolName: string, site?: string): boolean; add(toolName: string, site?: string): unknown }
  logger?: { warn?(...args: unknown[]): void }
}

const ROLES: Record<string, SubAgentProfile> = {
  research: {
    key: 'research',
    label: '研究',
    system: [
      '你是「研究」子智能体，为一个更大的任务做资料查证。',
      '· 只用只读工具（读页面 / 搜书签 / 搜历史 / 看集锦 / 看标签）。绝不修改用户数据。',
      '· 先一圈摸清事实，再下结论；找不到就明说"没有查到"，不要猜。',
      '· 最终只输出一段结构化结论：要点分条 + 每条附来源（标题或地址）。不要寒暄。'
    ].join('\n'),
    tools: [
      'tab_list', 'page_read', 'page_find', 'page_scroll', 'page_screenshot',
      'bookmark_search', 'bookmark_list', 'history_search', 'history_list',
      'collection_list', 'internal_page_list', 'panel_list', 'panel_read',
      'settings_list', 'settings_get',
      // 联网：研究角色最需要"查得到、引得出"，来源会随结果登记。
      'web_search', 'web_fetch',
      // 应用动作表（只读半边）：知道有哪些内部页面 / 命令可触达，才好判断"该去哪儿找"。
      'app_action_list', 'app_state_read',
      // 域数据面的只读视图：把"用户现在有什么"当成资料的一部分。
      'downloads_list', 'extensions_list', 'permissions_list', 'spaces_list',
      'apps_list', 'named_sessions_list',
      // 内部页的只读面：主题 / 快捷键 / 自动化 / 游戏 / profile /
      // 崩溃与证书 / 进程指标 / 插件清单 —— 研究角色可查证，不可改。
      // Cookie、密码和表单填充元数据只留给明确的操作任务，不进入泛研究上下文。
      'themes_list', 'shortcuts_list',
      'automation_get', 'games_list', 'profiles_list', 'crash_reports_list',
      'certificates_list', 'tasks_list', 'plugins_list'
    ]
  },
  operate: {
    key: 'operate',
    label: '操作',
    system: [
      '你是「操作」子智能体，负责把一句话任务落成浏览器里的具体动作。',
      '· 每步只做一件事，做完看结果再决定下一步；失败就换一条路，别重复同一个动作。',
      '· 涉及写操作会弹审批，用户拒绝后不要重试同一动作，改用只读方式汇报现状。',
      '· 最终输出：做了什么（分条）、结果如何、还差什么。不要复述任务。'
    ].join('\n'),
    tools: [
      'tab_list', 'tab_open', 'tab_switch', 'tab_close',
      'page_read', 'page_find', 'page_scroll', 'page_click', 'page_type', 'page_screenshot',
      'bookmark_add', 'bookmark_digest', 'history_search', 'bookmark_search', 'collection_list',
      'settings_list', 'settings_set', 'settings_reset', 'internal_page_open', 'panel_list', 'panel_control', 'panel_read',
      // 运行日志：操作失败时先看"刚才报了什么错"，再决定换哪条路。
      'app_logs',
      // 应用动作表：菜单 / 插件命令 / JumpList 的**全量**入口，操作角色要能"按名字执行"。
      'app_action_list', 'app_action_run', 'app_state_read',
      // 域数据面的写能力：删除历史、控制下载与扩展、改权限、管空间 / PWA / 命名会话 / 集锦 / 书签。
      'history_remove', 'downloads_list', 'download_control',
      'extensions_list', 'extension_control',
      'permissions_list', 'permission_set', 'permission_clear', 'permission_default_set',
      'spaces_list', 'space_manage', 'apps_list', 'app_control',
      'named_sessions_list', 'named_session_manage',
      'collection_add', 'collection_remove', 'bookmark_remove',
      // 内部页的全部能力（与页面按钮走同一条域服务路径）——
      // cookie / 浏览数据 / 填充 / 主题 / 快捷键 / 自动化 / 游戏 / profile /
      // 崩溃与证书 / 进程 / 插件启停。
      'cookies_list', 'cookie_remove', 'cookies_clear', 'browsing_data_clear',
      'data_import',
      'formfill_list', 'formfill_add', 'formfill_remove',
      'themes_list', 'theme_apply',
      'shortcuts_list', 'shortcut_set', 'shortcut_reset',
      'automation_get', 'automation_save', 'automation_run',
      'games_list', 'game_open',
      'profiles_list', 'profile_switch',
      'crash_reports_list', 'certificates_list', 'tasks_list',
      'plugins_list', 'plugin_toggle'
    ]
  },
  writing: {
    key: 'writing',
    label: '写作',
    system: [
      '你是「写作」子智能体，把已知材料整理成用户能直接用的成稿。',
      '· 材料不够时可以补查（只读工具），但不要为了凑字数反复搜索。',
      '· 直接给成稿：中文、结构清晰、能用 Markdown 就用；不要写"以下是"。',
      '· 不确定的事实标注"（未核实）"，绝不编造数据与引用。'
    ].join('\n'),
    tools: [
      'page_read', 'page_find', 'tab_list', 'bookmark_search', 'bookmark_list',
      'history_search', 'collection_list', 'panel_read',
      // 成稿需要核对事实时可以联网，但只读；来源同样会被登记。
      'web_search', 'web_fetch'
    ]
  },
  review: {
    key: 'review',
    label: '审查',
    system: [
      '你是「审查」子智能体，负责检查已有结果、代码、页面或操作方案是否完整、准确、可执行。',
      '· 只读；优先寻找事实错误、遗漏、接口不一致、空值风险、权限风险与未验证声明。',
      '· 每个问题给出严重级别、证据位置和可操作修复建议；没有问题就明确说明。',
      '· 最终按「结论 → 阻断问题 → 一般问题 → 建议验证」输出，不要复述全部材料。'
    ].join('\n'),
    tools: [
      'tab_list', 'page_read', 'page_find', 'page_scroll', 'page_screenshot',
      'workspace_current', 'file_list', 'file_search', 'file_read',
      'bookmark_search', 'bookmark_list', 'history_search', 'collection_list',
      'panel_list', 'panel_read', 'app_logs', 'web_search', 'web_fetch'
    ]
  }
}

const ROLE_ALIASES: Readonly<Record<string, string>> = Object.freeze({
  explore: 'research',
  researcher: 'research',
  worker: 'operate',
  executor: 'operate',
  writer: 'writing',
  reviewer: 'review',
  audit: 'review'
})

function clip(text: unknown, max: number): string {
  const s = String(text == null ? '' : text).replace(/\r/g, '').trim()
  return s.length > max ? `${s.slice(0, max)}…` : s
}

/** 工具结果进下一次模型调用：对象序列化后截断（与主链路同一口径的轻量版）。 */
function wireResult(result: unknown): string {
  if (typeof result === 'string') return clip(result, OUTPUT_LIMIT)
  try {
    const json = JSON.stringify(result)
    return json && json.length > OUTPUT_LIMIT ? `${json.slice(0, OUTPUT_LIMIT)}…（已截断）` : (json || '{}')
  } catch (_) {
    return String(result)
  }
}

/** 子代理也做渐进裁剪：完整保留最近 6 个结果，更早的大结果压缩到 1200 字。 */
function compactSubagentHistory(messages: Array<Record<string, unknown>>): void {
  const indexes: number[] = []
  for (let i = 0; i < messages.length; i += 1) {
    if (messages[i]?.role === 'tool-result') indexes.push(i)
  }
  const older = indexes.slice(0, Math.max(0, indexes.length - 6))
  for (const index of older) {
    const message = messages[index]
    const result = message?.result
    if (typeof result !== 'string' || result.length <= 1200) continue
    messages[index] = {
      ...message,
      result: `${result.slice(0, 950)}\n…（较早工具结果已压缩）…\n${result.slice(-220)}`
    }
  }
}

/**
 * @param {{
 *   store: any,
 *   toolRegistry: any,
 *   complete: Function,
 *   buildToolCtx: (sessionId: string) => object,
 *   approvals: any,
 *   grants: any,
 *   logger?: any
 * }} deps
 */
function createSubAgents({ store, toolRegistry, complete, buildToolCtx, approvals, grants, logger = console }: SubAgentDeps) {
  const toolGate = createToolGate({
    approvals,
    // 授权记忆与主链路共用同一份（`ai_approval_grant`）：用户在主管回合点过
    // 「始终允许」，子智能体不该再问一遍。
    grants,
    audit: (row: unknown) => { try { store.audit(row) } catch (_) {} }
  })

  function normalizeRole(raw: unknown): SubAgentProfile {
    const key = String(raw || '').trim().toLowerCase()
    return ROLES[ROLE_ALIASES[key] || key] || ROLES.research
  }

  /**
   * 跑一个子智能体。
   * @param {{ role?: string, task: string, context?: string, maxSteps?: number, sessionId?: string, model?: string|null, approvalMode?: string, signal?: AbortSignal }} req
   */
  async function executeTask(taskId: string, req: SubAgentRequest = {}) {
    const task = String(req.task || '').trim()
    if (!task) throw new Error('缺少子任务描述')
    const profile = normalizeRole(req.role)
    const sessionId = String(req.sessionId || '')
    const stepsCap = Math.min(Math.max(Math.round(Number(req.maxSteps) || DEFAULT_STEPS), 1), MAX_STEPS_CAP)
    const ctx = typeof buildToolCtx === 'function' ? (buildToolCtx(sessionId) || {}) : { sessionId }
    const startedAt = Date.now()
    const turnId = taskId

    const allowed = toolRegistry.list(ctx).filter((t) => t && profile.tools.includes(t.name))
    const wireTools = allowed.map((t) => ({ name: t.name, description: t.description, parameters: t.parameters }))

    const userText = req.context
      ? `${task}\n\n【已知材料】\n${clip(req.context, 12000)}`
      : task
    /** @type {any[]} 线上消息（与 core/store 投影后的形状一致，见 providers.cjs 文件头） */
    const messages: Array<Record<string, unknown>> = [{ role: 'user', blocks: [{ type: 'text', text: userText }] }]

    const usage = { promptTokens: 0, completionTokens: 0, cachedTokens: 0 }
    const toolLog: Array<{ name: string; isError: boolean }> = []
    /** 子智能体查过的网页：随结论一起回给父级，父级再汇总进"来源"列表。 */
    const sources: Array<{ title: string; url: string; kind: string }> = []
    const seenSources = new Set<string>()
    let steps = 0
    let text = ''
    let stopReason = 'stop'
    let completedNaturally = false
    let lastModel: { providerId: string; modelId: string } | null = null

    while (steps < stepsCap) {
      if (req.signal && req.signal.aborted) { stopReason = 'aborted'; break }
      steps += 1
      compactSubagentHistory(messages)
      const step = await complete({
        sessionId,
        model: req.model || null,
        system: profile.system,
        messages,
        tools: wireTools,
        maxOutputTokens: STEP_MAX_TOKENS,
        signal: req.signal,
        timeoutMs: STEP_TIMEOUT_MS
      })
      usage.promptTokens += step.usage.promptTokens || 0
      usage.completionTokens += step.usage.completionTokens || 0
      usage.cachedTokens += step.usage.cachedTokens || 0
      lastModel = step.model || lastModel
      if (step.text) text = step.text
      if (!step.calls.length) {
        completedNaturally = true
        break
      }

      // 思考模式 + 工具回路：这一轮 assistant **必须整条留在历史里**（正文 + 推理）。
      // 只塞 tool-call / tool-result 会把 reasoning_content 丢掉 —— 下一次请求
      // 直接被判「reasoning_content 缺失」400（main/turn-runner.cjs 同一口径）。
      messages.push({
        role: 'assistant',
        blocks: step.text ? [{ type: 'text', text: step.text }] : [],
        ...(step.reasoning ? { reasoning: step.reasoning } : {})
      })
      const callIds = new Set<string>()
      const callSignatures = new Set<string>()
      for (const call of step.calls) {
        const args: Record<string, unknown> = call.args && typeof call.args === 'object'
          ? call.args as Record<string, unknown>
          : {}
        const signature = JSON.stringify({ name: call.name, args })
        if (callIds.has(call.id) || callSignatures.has(signature)) continue
        callIds.add(call.id)
        callSignatures.add(signature)
        messages.push({ role: 'tool-call', id: call.id, name: call.name, args })
        const tool = allowed.find((t) => t.name === call.name)
        let result: unknown
        let isError = false
        if (!tool) {
          result = { error: `「${profile.label}」子智能体无权使用工具 ${call.name}` }
          isError = true
        } else {
          const verdict = await toolGate.authorize({
            tool, args, ctx, sessionId, turnId,
            approvalMode: req.approvalMode || 'ask'
          })
          if (!verdict.allowed) {
            result = { error: verdict.reason }
            isError = true
          } else {
            try {
              const timeoutMs = Math.max(10_000, Number((tool as ToolDefinition & { timeoutMs?: number }).timeoutMs) || TOOL_TIMEOUT_MS)
              result = await withTimeout(
                Promise.resolve().then(() => tool.execute(args, ctx)),
                timeoutMs,
                `工具 ${tool.name} 执行`
              )
            } catch (e) {
              result = { error: e instanceof Error ? e.message : '工具执行失败' }
              isError = true
            }
          }
        }
        messages.push({ role: 'tool-result', id: call.id, name: call.name, result: wireResult(result), isError })
        toolLog.push({ name: call.name, isError })
        // 来源透传：子智能体不直接落事件，但"读过哪些页"必须能回到父级的来源列表。
        const resultRecord = result && typeof result === 'object' ? result as Record<string, unknown> : null
        if (resultRecord && Array.isArray(resultRecord.sources)) {
          for (const raw of resultRecord.sources) {
            const source = raw && typeof raw === 'object' ? raw as Record<string, unknown> : null
            const url = String(source?.url || '').trim()
            if (!/^https?:\/\//i.test(url) || seenSources.has(url)) continue
            seenSources.add(url)
            sources.push({
              title: String(source?.title || url).slice(0, 300),
              url,
              kind: String(source?.kind || 'page')
            })
          }
        }
      }
    }
    if (stopReason === 'stop' && !completedNaturally && steps >= stepsCap && !(req.signal && req.signal.aborted)) {
      stopReason = 'max-steps'
    }

    // 用量记到父会话：成本在用量页看得见，但子步骤不落事件、不进对话。
    if (lastModel && (usage.promptTokens || usage.completionTokens)) {
      try {
        store.recordUsage({
          sessionId: sessionId || null,
          providerId: lastModel.providerId,
          modelId: lastModel.modelId,
          promptTokens: usage.promptTokens,
          completionTokens: usage.completionTokens,
          cachedTokens: usage.cachedTokens
        })
      } catch (e) {
        try { logger.warn?.('[ai] 子智能体用量记账失败：', e instanceof Error ? e.message : String(e)) } catch (_) {}
      }
    }

    return {
      ok: stopReason !== 'aborted',
      taskId,
      role: profile.key,
      label: profile.label,
      stopReason,
      steps,
      elapsedMs: Date.now() - startedAt,
      output: clip(text || '（子智能体没有产出结论）', OUTPUT_LIMIT),
      tools: toolLog,
      sources,
      usage
    }
  }

  const managedTasks = new Map<string, ManagedSubAgentTask>()

  function pruneTasks(): void {
    const cutoff = Date.now() - TASK_RETENTION_MS
    for (const [id, task] of managedTasks) {
      if (task.finishedAt && task.finishedAt < cutoff) managedTasks.delete(id)
    }
  }

  function snapshot(task: ManagedSubAgentTask, includeResult = true) {
    const resultRecord = task.result && typeof task.result === 'object' ? task.result as Record<string, unknown> : null
    return {
      taskId: task.taskId,
      sessionId: task.sessionId,
      role: task.role,
      task: task.task,
      status: task.status,
      startedAt: task.startedAt,
      finishedAt: task.finishedAt,
      ...(includeResult && task.result !== undefined ? { result: task.result } : {}),
      ...(!includeResult && typeof resultRecord?.output === 'string'
        ? { outputPreview: String(resultRecord.output).slice(0, 300) }
        : {}),
      ...(task.error ? { error: task.error } : {})
    }
  }

  function startTask(req: SubAgentRequest = {}): ManagedSubAgentTask {
    pruneTasks()
    const taskText = String(req.task || '').trim()
    if (!taskText) throw new Error('缺少子任务描述')
    const running = [...managedTasks.values()].filter((task) => task.status === 'running').length
    if (running >= MAX_CONCURRENT_TASKS) {
      const error = new Error(`同时运行的子代理已达上限（${MAX_CONCURRENT_TASKS}）`) as Error & { code: string }
      error.code = 'AGENT_BUSY'
      throw error
    }
    const sessionId = String(req.sessionId || '')
    const profile = normalizeRole(req.role)
    const startedAt = Date.now()
    const taskId = `sub_${startedAt.toString(36)}_${Math.random().toString(36).slice(2, 8)}`
    const controller = new AbortController()
    const forwardAbort = () => {
      try { controller.abort(req.signal && req.signal.reason) } catch (_) { try { controller.abort() } catch (_) {} }
    }
    if (req.signal) {
      if (req.signal.aborted) forwardAbort()
      else req.signal.addEventListener('abort', forwardAbort, { once: true })
    }
    const task: ManagedSubAgentTask = {
      taskId,
      sessionId,
      role: profile.key,
      task: taskText,
      status: 'running',
      startedAt,
      finishedAt: null,
      controller,
      promise: Promise.resolve()
    }
    task.promise = executeTask(taskId, { ...req, signal: controller.signal })
      .then((result) => {
        task.result = result
        task.status = result && typeof result === 'object' && result.stopReason === 'aborted' ? 'aborted' : 'completed'
        task.finishedAt = Date.now()
        return result
      })
      .catch((error) => {
        task.status = controller.signal.aborted ? 'aborted' : 'failed'
        task.error = error instanceof Error ? error.message : String(error)
        task.finishedAt = Date.now()
        throw error
      })
      .finally(() => {
        if (req.signal) { try { req.signal.removeEventListener('abort', forwardAbort) } catch (_) {} }
      })
    task.promise.catch(() => {})
    managedTasks.set(taskId, task)
    return task
  }

  async function run(req: SubAgentRequest = {}) {
    return startTask(req).promise
  }

  function start(req: SubAgentRequest = {}) {
    return snapshot(startTask(req))
  }

  function status(taskId: unknown) {
    pruneTasks()
    const task = managedTasks.get(String(taskId || ''))
    return task ? snapshot(task) : { ok: false, code: 'AGENT_TASK_NOT_FOUND', taskId: String(taskId || '') }
  }

  function list(req: { sessionId?: string; limit?: number } = {}) {
    pruneTasks()
    const sessionId = String(req.sessionId || '')
    const limit = Math.max(1, Math.min(50, Math.round(Number(req.limit) || 20)))
    return {
      ok: true,
      tasks: [...managedTasks.values()]
        .filter((task) => !sessionId || task.sessionId === sessionId)
        .sort((a, b) => b.startedAt - a.startedAt)
        .slice(0, limit)
        .map((task) => snapshot(task, false))
    }
  }

  async function wait(req: { taskId?: string; timeoutMs?: number } = {}) {
    const task = managedTasks.get(String(req.taskId || ''))
    if (!task) return { ok: false, code: 'AGENT_TASK_NOT_FOUND', taskId: String(req.taskId || '') }
    const timeoutMs = Math.max(0, Math.min(120_000, Number(req.timeoutMs) || 30_000))
    let timer: ReturnType<typeof setTimeout> | null = null
    try {
      await Promise.race([
        task.promise.catch(() => undefined),
        new Promise<void>((resolve) => {
          timer = setTimeout(resolve, timeoutMs)
        })
      ])
    } finally {
      if (timer) clearTimeout(timer)
    }
    return snapshot(task)
  }

  function cancel(taskId: unknown) {
    const task = managedTasks.get(String(taskId || ''))
    if (!task) return { ok: false, code: 'AGENT_TASK_NOT_FOUND', taskId: String(taskId || '') }
    if (task.status === 'running') {
      task.status = 'aborted'
      try { task.controller.abort('canceled by user') } catch (_) {}
    }
    return snapshot(task)
  }

  function dispose() {
    for (const task of managedTasks.values()) {
      if (task.status === 'running') {
        try { task.controller.abort('engine disposed') } catch (_) {}
      }
    }
    managedTasks.clear()
  }

  async function dispatch(req: SubAgentRequest & { action?: string; command?: string } = {}) {
    const action = String(req.action || req.command || 'run').toLowerCase()
    if (action === 'start') return start(req)
    if (action === 'status') return status((req as ManagedSubAgentTask).taskId)
    if (action === 'list') return list({ sessionId: req.sessionId, limit: Number((req as Record<string, unknown>).limit) || undefined })
    if (action === 'wait') return wait({ taskId: (req as ManagedSubAgentTask).taskId, timeoutMs: Number((req as Record<string, unknown>).timeoutMs) || undefined })
    if (action === 'cancel') return cancel((req as ManagedSubAgentTask).taskId)
    if (action === 'run') return run(req)
    throw new Error(`不支持的子代理动作：${action}`)
  }

  return {
    dispatch,
    run,
    start,
    status,
    list,
    wait,
    cancel,
    dispose,
    roles: () => Object.values(ROLES).map((r) => ({ key: r.key, label: r.label }))
  }
}

module.exports = { createSubAgents, SUBAGENT_ROLES: Object.keys(ROLES) }
