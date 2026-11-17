/**
 * AI 引擎 · 工具审批（PART15 §10 / §17.5）。
 *
 * 审批是**一次带超时的等待**，不是界面状态：请求发出后由渲染层画审批卡，
 * 用户裁决经 `ai:approval` 回来。
 *
 * 「这个工具以后还要不要问」不在这里 —— 那是跨回合 / 跨会话 / 跨重启的事实，
 * 由 `main/approval-grants.cjs` 唯一持有。本文件只负责把"一次等待"收干净。
 *
 * 两条硬规矩：
 *   1. **没有界面 = 拒绝**：`emit` 返回送达数，0 表示没有任何窗口收到这张卡
 *      （面板被卸掉 / 用户全关了窗口）。此时绝不能默认放行 —— 那等于"没人看着的时候工具最自由"。
 *   2. **超时 = 拒绝**：120 秒没裁决按 deny 处理，避免回合永久挂起。
 */

const crypto = require('crypto')

interface ApprovalResult { decision: 'allow' | 'deny'; reason?: string; remember?: boolean }
interface ApprovalPayload extends Record<string, unknown> {
  sessionId?: unknown
  turnId?: unknown
  toolName?: unknown
  args?: unknown
  risk?: unknown
  site?: unknown
  hint?: unknown
}
interface PendingApproval {
  resolve(result: ApprovalResult): void
  timer: ReturnType<typeof setTimeout>
  sessionId: unknown
  risk: unknown
  payload: Record<string, unknown>
}

function createApprovals({ emit, events, timeoutMs = 120000 }: {
  emit: (route: string, payload: unknown) => number
  events: { aiApprovalRequest: string }
  timeoutMs?: number
}) {
  /** approvalId → { resolve, timer, sessionId, risk } */
  const pending = new Map<string, PendingApproval>()

  function preview(args: unknown): string {
    try {
      const json = JSON.stringify(args || {})
      return json.length > 2000 ? `${json.slice(0, 2000)}…` : json
    } catch (_) { return '{}' }
  }

  /**
   * 请求一次裁决。返回 Promise<{ decision: 'allow'|'deny', reason? }>。
   */
  function request(payload: ApprovalPayload = {}): Promise<ApprovalResult> {
    const approvalId = `ap_${crypto.randomBytes(6).toString('hex')}`
    const { sessionId, turnId, toolName, args, risk, site, hint } = payload
    const requestPayload = {
      approvalId, sessionId, turnId, toolName, risk, site: site || '', hint: hint || '',
      argsPreview: preview(args)
    }
    let delivered = 0
    try {
      delivered = emit(events.aiApprovalRequest, requestPayload)
    } catch (_) { delivered = 0 }
    if (!delivered) return Promise.resolve({ decision: 'deny', reason: 'no-ui' })

    return new Promise<ApprovalResult>((resolve) => {
      const timer = setTimeout(() => {
        pending.delete(approvalId)
        resolve({ decision: 'deny', reason: 'timeout' })
      }, timeoutMs)
      // risk 留着给 `allowPending` 用：切到允许模式时，**只有非破坏性**的待决卡能自动放行。
      pending.set(approvalId, { resolve, timer, sessionId, risk: risk || '', payload: requestPayload })
    })
  }

  /**
   * `ai:approval` 的落点。找不到（已被超时清理 / 已被裁决）时安静返回。
   *
   * 归属校验：审批卡属于某个会话，裁决必须带上同一个 `sessionId`。
   * 否则任何宿主（哪怕是另一个会话的面板）拿到 approvalId 就能替人点头。
   *
   * @param {string} approvalId
   * @param {string} decision 'allow' | 'deny'
   * @param {boolean} [remember]
   * @param {{ sessionId?: string }} [options]
   */
  function resolve(approvalId: string, decision: string, remember?: boolean, options?: { sessionId?: string }) {
    const entry = pending.get(String(approvalId))
    if (!entry) return { ok: false, reason: 'unknown-approval' }
    const sid = String((options && options.sessionId) || '')
    if (sid && entry.sessionId && sid !== String(entry.sessionId)) {
      return { ok: false, reason: 'session-mismatch' }
    }
    pending.delete(String(approvalId))
    clearTimeout(entry.timer)
    const normalized = decision === 'allow' ? 'allow' : 'deny'
    entry.resolve({ decision: normalized, remember: normalized === 'allow' && !!remember })
    return { ok: true }
  }

  /**
   * 切到「允许」模式时放行所有待决审批（非破坏性）。
   *
   * 不这么做的话，用户刚把开关拨到允许，屏幕上那张卡还是"必须点一下"——
   * 语义上允许模式就是总授权，卡片的裁决已经被这次切换覆盖了。
   * 破坏性操作（`risk: 'destructive'`）仍然要用户亲手点。
   * @param {string} [sessionId] 只放行某个会话（不传 = 全部）
   */
  function allowPending(sessionId?: string) {
    const sid = sessionId ? String(sessionId) : ''
    let released = 0
    for (const [id, entry] of pending) {
      if (entry.risk === 'destructive') continue
      if (sid && String(entry.sessionId || '') !== sid) continue
      clearTimeout(entry.timer)
      try { entry.resolve({ decision: 'allow', remember: false }) } catch (_) {}
      pending.delete(id)
      released += 1
    }
    return released
  }

  /**
   * 回合被取消（用户点「停止」）：该会话的待决审批立刻按拒绝收尾。
   *
   * 不这么做的话，停止按钮在"审批卡还没裁决"这一刻是**假按钮**：控制器已 abort，
   * 但回合还卡在 `await approvals.request(...)` 里，要等满 120 秒超时才结束 ——
   * 界面上就是"点了停止，半天没反应"。
   */
  function cancelSession(sessionId: unknown, reason = 'stopped') {
    const sid = String(sessionId || '')
    for (const [id, entry] of pending) {
      if (String(entry.sessionId || '') !== sid) continue
      clearTimeout(entry.timer)
      try { entry.resolve({ decision: 'deny', reason }) } catch (_) {}
      pending.delete(id)
    }
  }

  /** 当前待决审批快照：宿主重挂载或切换会话时用来恢复卡片。 */
  function list(sessionId?: unknown) {
    const sid = String(sessionId || '')
    return [...pending.values()]
      .filter((entry) => !sid || String(entry.sessionId || '') === sid)
      .map((entry) => ({ ...entry.payload }))
  }

  /** 插件停用 / 应用退出：所有待决审批一律按拒绝收尾（绝不留下悬空 Promise）。 */
  function dispose() {
    for (const [id, entry] of pending) {
      clearTimeout(entry.timer)
      try { entry.resolve({ decision: 'deny', reason: 'disposed' }) } catch (_) {}
      pending.delete(id)
    }
    // 授权记忆不在这里：它是**持久化事实**（见 main/approval-grants.cjs），
    // 插件停用 / 重启都不该让用户重新点一遍「始终允许」。
  }

  return { request, resolve, allowPending, cancelSession, list, dispose }
}

module.exports = { createApprovals }
