/**
 * AI 引擎 · 工具裁决闸（PART15 §10 / §17.5）。
 *
 * ══════════════════════════════════════════════════════════════════════
 * 它是什么
 * ══════════════════════════════════════════════════════════════════════
 * 「这次工具调用要不要问用户」的**唯一实现**。回合执行器（主智能体）与
 * 子智能体（`subagent.cjs`）都走这一份 —— 否则两处的审批口径迟早分叉：
 * 一边记得「用户勾了记住」，另一边逢写必弹；或者更糟，某一边忘了 `no-ui=deny`。
 *
 * 三条判定（顺序即优先级，见 `evaluate`）：
 *   1. **总授权**：审批模式 `allow` 时，除破坏性操作（`risk=destructive`）外一律放行，
 *      审计里记 `reason: 'auto'`；
 *   2. **授权记忆**：用户点过「始终允许」的工具（跨会话 / 跨重启）不再问，
 *      审计里记 `reason: 'remembered'`；
 *   3. 其余按声明：`always` 每次问，`site` 首次问，`never` 不问。
 *
 * 为什么 `allow` 从"只放行只读"放宽到"非破坏性全放行"：允许模式对用户是
 * **总授权开关**（输入栏两态控件），只放行读取会让 `plugin_toggle` 这类写工具
 * 继续弹卡 —— 用户看到的就是"我明明开了允许，怎么还问我"。
 * 破坏性操作保留逐次确认（当前没有工具声明这一档，但闸门留着）。
 *
 * ══════════════════════════════════════════════════════════════════════
 * 授权记忆从哪来
 * ══════════════════════════════════════════════════════════════════════
 * 不是本文件的内存 Set，而是 `main/approval-grants.cjs`（落库，跨会话 / 跨重启）。
 * 页面上下文（`turn-runner#gatePageContext`）也调同一个 `evaluate`，不另写一份。
 *
 * 被拒时**已写审计**（拒绝也是事实，必须留证），并把拒绝原因翻译成人话 ——
 * 模型看到的 `用户未授权该操作` 与 `没有可用界面` 是两回事，前者可换方案，
 * 后者只能放弃。
 */

import type { ApprovalPolicy, ToolArgs, UnknownRecord } from '../types'

interface GateTabManager {
  getActiveTabId?(): string | null
  list?(): Array<{ tabId: string; url?: string }>
}
interface GateContext extends UnknownRecord {
  tabId?: string
  getTabManager?: () => GateTabManager | null
}
interface GateTool {
  name: string
  risk?: string
  approval?: ApprovalPolicy | ((args: ToolArgs) => ApprovalPolicy)
  description?: string
}
interface GateDecision { decision?: 'allow' | 'deny'; reason?: string; remember?: boolean }

/** 取 origin（取不到返回空串）。站点记忆键与审批卡副标题共用。 */
function originOf(url: unknown): string {
  try { return new URL(String(url || '')).origin } catch (_) { return '' }
}

/** 从标签管理器解出某个标签的地址（不给 id 就是活动标签；取不到返回空串）。 */
function tabUrl(getTabManager: GateContext['getTabManager'], tabId: unknown): string {
  try {
    const tm = typeof getTabManager === 'function' ? getTabManager() : null
    if (!tm) return ''
    const id = String(tabId || (typeof tm.getActiveTabId === 'function' ? tm.getActiveTabId() : '') || '')
    if (!id) return ''
    const rows = typeof tm.list === 'function' ? tm.list() : []
    const hit = (rows || []).find((tab: { tabId: string; url?: string }) => tab && String(tab.tabId) === id)
    return (hit && hit.url) || ''
  } catch (_) { return '' }
}

/**
 * 审批记忆 / 审计用的站点键。
 *
 * 判定顺序：参数里的地址 → 参数指定的标签（没有就是当前活动标签）→ `local`。
 * 工具未必带 url（`page_read` 作用的是"当前页"），只认 `args.url` 会让记忆键
 * 退化成 `local`（等于"整个会话只问一次"），与 §10.1 的"按站点"不符。
 */
function siteOf(args: ToolArgs | undefined, ctx: GateContext | undefined): string {
  const explicit = args && typeof args.url === 'string' ? args.url : ''
  const fromArgs = originOf(explicit)
  if (fromArgs) return fromArgs
  const tabId = (args && args.tabId) || (ctx && ctx.tabId) || ''
  return originOf(tabUrl(ctx && ctx.getTabManager, tabId)) || 'local'
}

/** 拒绝原因 → 模型可读的一句话（`no-ui` / `timeout` 不该被说成"用户拒绝"）。 */
function denyMessage(reason: unknown): string {
  if (reason === 'no-ui') return '当前没有可显示审批的界面，已按拒绝处理'
  if (reason === 'timeout') return '审批超时，已按拒绝处理'
  if (reason === 'stopped') return '用户停止了本次回合，操作被取消'
  if (reason === 'disposed') return '引擎已停止，操作被取消'
  return '用户未授权该操作'
}

/**
 * 解析工具声明的审批档位。
 *
 * `approval` 可以是字符串，也可以是 `(args) => 'never'|'site'|'always'` ——
 * 后者用于「同一工具按参数分档」（例如技能保存：prompt 档只记站点，script 档每次问）。
 * 非法返回值一律按 `always` 兜底（宁多问一次，也不静默放行）。
 */
function approvalOf(tool: GateTool, args: ToolArgs | undefined): ApprovalPolicy {
  const declared = tool && tool.approval
  const value = typeof declared === 'function' ? declared(args || {}) : declared
  const text = String(value || 'never')
  return text === 'never' || text === 'site' || text === 'always' ? text : 'always'
}

/**
 * 一次工具调用要不要问用户 —— **判定策略的唯一实现**。
 *
 * 返回 `{ needsApproval, reason }`；`reason` 同时用于审计与回给模型的说明：
 *   · `'auto'`       —— 允许模式总授权
 *   · `'remembered'` —— 用户点过「始终允许」
 *   · `'never'` / `'site'` / `'always'` —— 工具声明
 *
 * @param {{ tool: { name: string, risk?: string, approval?: string|Function }, args?: any, approvalMode?: string, granted?: boolean }} input
 * @returns {{ needsApproval: boolean, reason: string }}
 */
function evaluate({ tool, args, approvalMode, granted }: {
  tool: GateTool
  args?: ToolArgs
  approvalMode?: string
  granted?: boolean
}): { needsApproval: boolean; reason: string } {
  if (approvalMode === 'allow' && tool.risk !== 'destructive') {
    return { needsApproval: false, reason: 'auto' }
  }
  if (granted) return { needsApproval: false, reason: 'remembered' }
  const approval = approvalOf(tool, args)
  if (approval === 'never') return { needsApproval: false, reason: 'never' }
  return { needsApproval: true, reason: approval }
}

/**
 * @param {{
 *   approvals: { request: Function },
 *   grants: { has: Function, add: Function },
 *   audit: (row: { sessionId: string, toolName: string, args: any, decision: string, reason: string }) => void,
 *   logger?: any
 * }} deps
 */
function createToolGate({ approvals, grants, audit, logger = console }: {
  approvals: { request(payload: UnknownRecord): Promise<GateDecision> }
  grants: { has(toolName: string): boolean; add(toolName: string, site?: string): unknown }
  audit(row: { sessionId: string; toolName: string; args?: ToolArgs; decision: string; reason: string }): void
  logger?: Pick<Console, 'warn'>
}) {
  /**
   * 裁决一次工具调用。
   * @returns {Promise<{ allowed: boolean, reason: string, site: string, denyReason?: string }>}
   */
  async function authorize({ tool, args, ctx, sessionId, turnId, approvalMode }: {
    tool: GateTool
    args?: ToolArgs
    ctx?: GateContext
    sessionId: string
    turnId?: string
    approvalMode?: string
  }): Promise<{ allowed: boolean; reason: string; site: string; denyReason?: string }> {
    const site = siteOf(args, ctx)
    // 动态审批档不能用「始终允许」记忆短路：记忆的键只有工具名，
    // 而同一个工具的低风险档（如 skill_save 的 prompt）与高风险档（script）
    // 共用名字 —— 记住低风险档就会把高风险档一并放行。
    const dynamic = typeof tool.approval === 'function'
    const policy = evaluate({ tool, args, approvalMode, granted: !dynamic && grants.has(tool.name) })

    if (!policy.needsApproval) {
      return { allowed: true, reason: policy.reason, site }
    }

    let decision: GateDecision | null = null
    try {
      decision = await approvals.request({
        sessionId, turnId, toolName: tool.name, args, risk: tool.risk, site, hint: tool.description
      })
    } catch (e) {
      try { logger.warn?.('[ai] 审批请求失败：', e instanceof Error ? e.message : String(e)) } catch (_) {}
      decision = { decision: 'deny', reason: 'error' }
    }

    if (!decision || decision.decision !== 'allow') {
      const reason = (decision && decision.reason) || 'user'
      try {
        audit({ sessionId, toolName: tool.name, args, decision: 'deny', reason })
      } catch (_) {}
      return { allowed: false, reason: denyMessage(reason), denyReason: reason, site }
    }

    // 「始终允许」= 该工具以后不再问（含声明为 always 的工具）。持久化在 grants 里。
    if (decision.remember && !dynamic) grants.add(tool.name, site)
    return { allowed: true, reason: 'approved', site }
  }

  return { authorize }
}

module.exports = { createToolGate, evaluate, approvalOf, siteOf, originOf, denyMessage }
