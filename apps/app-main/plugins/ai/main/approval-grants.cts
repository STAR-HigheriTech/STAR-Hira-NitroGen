/**
 * AI 引擎 · 授权记忆（「始终允许」的唯一真源）。
 *
 * ══════════════════════════════════════════════════════════════════════
 * 为什么从 approvals.cjs 里搬出来
 * ══════════════════════════════════════════════════════════════════════
 * `approvals.cjs` 的职责是**一次带超时的等待**（发卡 → 等裁决 → 收尾），
 * 而"这个工具以后还要不要问"是**跨回合、跨会话、跨重启**的事实。
 * 两者混在一个内存 Set 里，带来过三个真实问题：
 *   1. 键里带 `sessionId` —— 换个会话，用户点过的「始终允许」就全忘了；
 *   2. 只在内存 —— 重启应用又忘一次；
 *   3. 谁都能往里塞 —— 子智能体 / 页面上下文各写一份判定，口径迟早分叉。
 *
 * 现在只有这一处知道"哪些工具免问"，落 `ai_approval_grant`（见 core/db.cjs）。
 * 工具裁决闸（`tool-gate.cjs`）与页面上下文（`turn-runner.cjs`）都查同一份。
 *
 * 键**只有工具名**：站点维度对大量工具（下载控制 / 插件启停 / 清历史）没有意义，
 * 按活动标签页取 origin 只会让同一条授权随窗口切换而失效 —— 用户点「始终允许」
 * 的语义就是"这个工具别再问我了"。`site` 列只留作审计展示，不参与匹配。
 */

/**
 * @param {{
 *   sqlite: any,
 *   logger?: { warn?: Function }
 * }} deps
 */
interface GrantRow { tool_name: string; site: string | null; created_at: number }
interface GrantRecord { tool: string; site: string | null; createdAt: number }
interface GrantDatabase { prepare(sql: string): { all<T = GrantRow>(): T[]; run(...params: unknown[]): unknown } }

function createApprovalGrants({ sqlite, logger = console }: {
  sqlite: GrantDatabase
  logger?: Pick<Console, 'warn'>
}) {
  /** tool_name → { tool, site, createdAt }（内存缓存；真源在库里）。 */
  let cache: Map<string, GrantRecord> | null = null

  // 与 core/store.cjs 同一条理由：`kernel.sqlite` 是按 profile 路由的 Proxy，
  // 换空间会换底层连接，语句不能缓存。
  const db = () => sqlite

  function load() {
    if (cache) return cache
    cache = new Map()
    try {
      const rows = db().prepare('SELECT tool_name, site, created_at FROM ai_approval_grant').all<GrantRow>()
      for (const row of rows || []) {
        const name = String((row && row.tool_name) || '').trim()
        if (!name) continue
        cache.set(name, {
          tool: name,
          site: row.site ? String(row.site) : null,
          createdAt: Number(row.created_at) || 0
        })
      }
    } catch (_) {
      // 表还不存在（enable 早于迁移）→ 按"没有任何授权"走，不抛
    }
    return cache
  }

  /** 这个工具是否被用户点过「始终允许」。 */
  function has(toolName: unknown): boolean {
    const name = String(toolName || '').trim()
    if (!name) return false
    return load().has(name)
  }

  /**
   * 记住一条授权（幂等）。
   * @param {string} toolName
   * @param {string} [site] 仅供审计展示，不参与匹配
   */
  function add(toolName: string, site?: string) {
    const name = String(toolName || '').trim()
    if (!name) return false
    const now = Date.now()
    const record = { tool: name, site: site ? String(site) : null, createdAt: now }
    load().set(name, record)
    try {
      db().prepare(
        `INSERT INTO ai_approval_grant (tool_name, site, created_at) VALUES (?, ?, ?)
         ON CONFLICT(tool_name) DO UPDATE SET site = excluded.site, created_at = excluded.created_at`
      ).run(record.tool, record.site, now)
    } catch (e) {
      logger.warn && logger.warn('[ai] 授权记忆落库失败：', e instanceof Error ? e.message : String(e))
    }
    return true
  }

  /** 撤销一条授权（用户反悔时用；下次调用会重新询问）。 */
  function remove(toolName: unknown): boolean {
    const name = String(toolName || '').trim()
    if (!name) return false
    const existed = load().delete(name)
    try { db().prepare('DELETE FROM ai_approval_grant WHERE tool_name = ?').run(name) } catch (_) {}
    return existed
  }

  /** 全部撤销。 */
  function clear() {
    load().clear()
    try { db().prepare('DELETE FROM ai_approval_grant').run() } catch (_) {}
  }

  /** 当前授权清单（审计 / 设置页展示）。 */
  function list() {
    return Array.from(load().values()).sort((a: GrantRecord, b: GrantRecord) => b.createdAt - a.createdAt)
  }

  /**
   * 丢掉内存缓存，下次 `has()` 重新从库里读。
   * 用于 `ai:purge`（表被 DROP 重建）与「授权被外部改动」后的对齐 ——
   * 置 `null` 而不是空 Map：表里可能还有别的进程 / 别的会话写入的行。
   */
  function reset() {
    cache = null
  }

  return { has, add, remove, clear, list, reset }
}

module.exports = { createApprovalGrants }
