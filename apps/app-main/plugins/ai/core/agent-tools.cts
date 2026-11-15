/**
 * AI 引擎 · 子智能体工具（PART15 §10.3）。
 *
 * 只有**一个**工具：`agent_delegate`。三个角色（研究 / 操作 / 写作）不是三个工具 ——
 * 工具表越长，模型选错的概率越高；角色作为参数，schema 里用 enum 钉死，
 * 既省 token，也让"角色能力"只有 `main/subagent.cjs` 一个真源。
 *
 * 审批语义：`write` + `site`。子智能体会动浏览器（可能开标签、写设置），
 * 但每次内部写操作仍各自过同一道闸（见 `main/tool-gate.cjs`）；
 * 这里只在"要不要启动一次子智能体"上问一次，勾记住后同会话不再打断。
 */

/** 参数 schema 的简写构造（与 tools.cjs / browser-tools.cjs 同一口径）。 */
import type { AiToolContext, AiToolDefinition, AiToolHost, JsonSchema, ToolArgs } from '../types'

function obj(properties: JsonSchema['properties'] = {}, required: string[] = []): JsonSchema {
  return { type: 'object', properties: properties || {}, required: required || [], additionalProperties: false }
}

/**
 * @param {{ runAgent?: (req: {
 *   role: string, task: string, context?: string, maxSteps?: number,
 *   sessionId?: string, approvalMode?: string
 * }) => Promise<any> }} host
 */
function createAgentTools(host: AiToolHost): AiToolDefinition[] {
  const runAgent = host.runAgent

  const tools: AiToolDefinition[] = [
    {
      name: 'agent_delegate',
      description: [
        '把一个子任务交给专门的子智能体，它会自己多步调用工具，最后只回一段结论。',
        'role：research = 只读查证（搜页面/书签/历史/集锦）；operate = 执行浏览器动作（开标签、点、填、改设置）；writing = 把材料写成成稿。',
        '什么时候用：任务需要"先查好几处再回答"或"连着做几步操作"，一次工具调用做不完时。',
        '什么时候别用：一句话就能答的问题、或你已经在上下文里拿到了全部材料。'
      ].join(' '),
      parameters: obj({
        role: { type: 'string', enum: ['research', 'operate', 'writing', 'review'], description: '子智能体角色；explore/worker 作为兼容别名' },
        task: { type: 'string', description: '一句话说清要它做什么、产出什么' },
        context: { type: 'string', description: '可选：已查到的材料 / 用户原话，避免它重复劳动' },
        maxSteps: { type: 'number', description: '工具步数预算（默认 24，上限 64）' },
        model: { type: 'string', description: '可选模型覆盖，格式 provider:model' }
      }, ['role', 'task']),
      risk: 'write',
      approval: (args: ToolArgs) => String(args.role || 'research') === 'operate' ? 'site' : 'never',
      async execute(args: ToolArgs, ctx: AiToolContext) {
        if (typeof runAgent !== 'function') throw new Error('子智能体不可用')
        const role = String((args && args.role) || 'research')
        const res = await runAgent({
          role,
          task: String((args && args.task) || ''),
          context: args && args.context ? String(args.context) : '',
          maxSteps: Number(args.maxSteps) || undefined,
          model: args.model ? String(args.model) : undefined,
          sessionId: (ctx && ctx.sessionId) || '',
          approvalMode: (ctx && ctx.approvalMode) || 'ask',
          signal: ctx && ctx.signal
        })
        return res
      }
    },
    {
      name: 'agent_delegate_batch',
      description: [
        '并行委派多个相互独立的子任务，适合同时做多站点研究、多份材料审查或多个独立操作方案。',
        '每个子代理拥有隔离上下文，只回传结论、来源、工具轨迹与用量；单个失败不会拖垮其他任务。',
        '有依赖关系的任务不要并行：先批量研究，再由主 Agent汇总或继续委派。'
      ].join(' '),
      parameters: obj({
        tasks: {
          type: 'array',
          description: '2-8 个独立任务；每项见 task schema',
          items: {
            type: 'object',
            properties: {
              role: { type: 'string', enum: ['research', 'operate', 'writing', 'review'], description: '子智能体角色' },
              task: { type: 'string', description: '明确子任务与期望产出' },
              context: { type: 'string', description: '可选已知材料' },
              maxSteps: { type: 'number', description: '最多工具步数' }
            },
            required: ['role', 'task'],
            additionalProperties: false
          }
        },
        concurrency: { type: 'number', description: '并行数，默认 3，上限 4' },
        model: { type: 'string', description: '可选统一模型覆盖，格式 provider:model' }
      }, ['tasks']),
      risk: 'write',
      approval: (args: ToolArgs) => Array.isArray(args.tasks) &&
        args.tasks.some((task) => task && typeof task === 'object' && String((task as Record<string, unknown>).role || 'research') === 'operate')
        ? 'site'
        : 'never',
      async execute(args: ToolArgs, ctx: AiToolContext) {
        if (typeof runAgent !== 'function') throw new Error('子智能体不可用')
        const rawTasks = Array.isArray(args.tasks) ? args.tasks : []
        const tasks = rawTasks
          .filter((item): item is Record<string, unknown> => !!item && typeof item === 'object')
          .slice(0, 8)
        if (!tasks.length) throw new Error('tasks 至少需要一个子任务')
        const concurrency = Math.max(1, Math.min(4, Math.round(Number(args.concurrency) || 3)))
        const results: Array<Record<string, unknown>> = new Array(tasks.length)
        let cursor = 0
        const worker = async () => {
          while (cursor < tasks.length) {
            const index = cursor++
            const task = tasks[index]
            try {
              const result = await runAgent({
                role: String(task.role || 'research'),
                task: String(task.task || ''),
                context: task.context ? String(task.context) : '',
                maxSteps: Number(task.maxSteps) || undefined,
                model: args.model ? String(args.model) : undefined,
                sessionId: (ctx && ctx.sessionId) || '',
                approvalMode: (ctx && ctx.approvalMode) || 'ask',
                signal: ctx && ctx.signal
              })
              results[index] = {
                index,
                role: String(task.role || 'research'),
                task: String(task.task || ''),
                ok: true,
                result
              }
            } catch (error) {
              results[index] = {
                index,
                role: String(task.role || 'research'),
                task: String(task.task || ''),
                ok: false,
                error: error instanceof Error ? error.message : String(error)
              }
            }
          }
        }
        await Promise.all(Array.from({ length: Math.min(concurrency, tasks.length) }, () => worker()))
        return {
          ok: results.every((item) => item && item.ok === true),
          total: results.length,
          succeeded: results.filter((item) => item && item.ok === true).length,
          failed: results.filter((item) => item && item.ok === false).length,
          results
        }
      }
    },
    {
      name: 'agent_task',
      description: [
        '管理后台子代理任务：start 立即启动并返回 taskId；status 查看进度；wait 等待结果；cancel 取消；list 列出当前会话任务。',
        '后台任务有独立上下文，适合耗时研究或审查；需要即时结论时用 agent_delegate，需要并行独立任务时用 agent_delegate_batch。'
      ].join(' '),
      parameters: obj({
        command: { type: 'string', enum: ['start', 'status', 'wait', 'cancel', 'list'], description: '任务操作' },
        taskId: { type: 'string', description: 'status/wait/cancel 的任务 id' },
        role: { type: 'string', enum: ['research', 'operate', 'writing', 'review'], description: 'start 的角色' },
        task: { type: 'string', description: 'start 的子任务说明' },
        context: { type: 'string', description: 'start 的已知材料' },
        maxSteps: { type: 'number', description: 'start 的步数预算' },
        model: { type: 'string', description: '可选模型覆盖' },
        timeoutMs: { type: 'number', description: 'wait 的最长等待，默认 30 秒，上限 120 秒' },
        limit: { type: 'number', description: 'list 返回数量，默认 20' }
      }, ['command']),
      risk: 'write',
      approval: (args: ToolArgs) => {
        const command = String(args.command || '')
        if (command === 'cancel') return 'site'
        if (command === 'start' && String(args.role || 'research') === 'operate') return 'site'
        return 'never'
      },
      async execute(args: ToolArgs, ctx: AiToolContext) {
        if (typeof runAgent !== 'function') throw new Error('子智能体不可用')
        const command = String(args.command || 'status')
        return runAgent({
          action: command,
          taskId: args.taskId ? String(args.taskId) : '',
          role: String(args.role || 'research'),
          task: String(args.task || ''),
          context: args.context ? String(args.context) : '',
          maxSteps: Number(args.maxSteps) || undefined,
          model: args.model ? String(args.model) : undefined,
          timeoutMs: Number(args.timeoutMs) || undefined,
          limit: Number(args.limit) || undefined,
          sessionId: (ctx && ctx.sessionId) || '',
          approvalMode: (ctx && ctx.approvalMode) || 'ask',
          signal: ctx && ctx.signal
        })
      }
    }
  ]
  return tools
}

module.exports = { createAgentTools }
