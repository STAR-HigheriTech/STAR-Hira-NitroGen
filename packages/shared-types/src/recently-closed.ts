/**
 * recently-closed —— 「最近关闭」的**唯一纯规则**（形状 / 上限 / 按启动保留）。
 *
 * ── 为什么它不再是"纯内存的撤销栈" ──────────────────────────────────
 * 撤销栈（`TabManager#_closedTabStack`）只活到进程退出，"重启后最近关掉的那个
 * 页面就再也找不回来" —— 而这恰恰是最常见的场景（关完浏览器才想起还有一个页面）。
 * 用户口径：**像历史记录一样长期保存，但只留最近三次启动里的记录**。
 *
 * ── 存储形态 ──────────────────────────────────────────────────────
 * 走设置项 `session.recently_closed`（JSON 字符串），**不建新表** —— 与命名会话
 * (`sessions.named`)、归档区 (`archive.entries`) 同一手法：结构化小集合走设置项，
 * 天然随 profile 隔离（设置本就按 profile 一份文件）。
 *
 * ── 「最近三次启动」怎么记 ────────────────────────────────────────
 * 每条记录带 `launchAt`（那次**进程启动**的时间戳，同一次运行内所有条目相同），
 * 读取时按 `launchAt` 去重成"几次启动"，只保留最新 `RECENTLY_CLOSED_LAUNCH_LIMIT`
 * 组，其余整组丢弃。这样：
 *   · 同一次运行里关多少条都算"那次启动"的记录；
 *   · 重启后旧记录仍在，第三次重启之后再老的那组才被挤掉。
 *
 * ── 谁在用 ────────────────────────────────────────────────────────
 *   · 主进程 `recently-closed-store`（读写设置项、给 TabManager 播种 / 镜像）；
 *   · 本模块不认识 Electron / 磁盘 / IPC，任何异常都退化为空数组，绝不抛。
 */

/** 「最近关闭」的设置键（JSON 串）—— 引擎与视图共用，避免多处手抄。 */
export const RECENTLY_CLOSED_SETTING_KEY = 'session.recently_closed'

/** 保留最近**几次启动**的记录（用户口径：三次）。 */
export const RECENTLY_CLOSED_LAUNCH_LIMIT = 3

/** 总条数上限（与撤销栈 `CLOSED_TAB_STACK_LIMIT` 对齐，避免设置文件被撑大）。 */
export const RECENTLY_CLOSED_ENTRIES_LIMIT = 50

/**
 * 归一化一条「已关闭标签」记录。
 *
 * 字段与 `TabManager#listRecentlyClosed()` 的响应契约**逐字一致**（url / title /
 * favicon / pinned / stackId / index / closedAt），只多一个内部字段 `launchAt`
 * （跨启动保留用，UI 不认识它）。
 *
 * @param {any} input
 * @returns {{ url:string, title:string, favicon:string|null, pinned:boolean, stackId:string|null, index:number, closedAt:number, launchAt:number }|null}
 */
export interface RecentlyClosedEntry {
  url: string
  title: string
  favicon: string | null
  pinned: boolean
  stackId: string | null
  index: number
  closedAt: number
  launchAt: number
}

export function normalizeClosedEntry(input: unknown): RecentlyClosedEntry | null {
  if (!input || typeof input !== 'object') return null
  const source = input as Record<string, unknown>
  const url = String(source.url == null ? '' : source.url).trim()
  if (!url) return null
  const favicon = typeof source.favicon === 'string' && source.favicon ? source.favicon : null
  const stackId = typeof source.stackId === 'string' && source.stackId ? source.stackId : null
  const index = Number(source.index)
  const closedAt = Number(source.closedAt)
  const launchAt = Number(source.launchAt)
  return {
    url,
    title: String(source.title == null ? '' : source.title),
    favicon,
    pinned: source.pinned === true,
    stackId,
    index: Number.isFinite(index) && index >= 0 ? Math.floor(index) : 0,
    closedAt: Number.isFinite(closedAt) && closedAt > 0 ? closedAt : 0,
    launchAt: Number.isFinite(launchAt) && launchAt > 0 ? launchAt : 0
  }
}

/**
 * 只保留最新 `limit` 次启动的记录，并按「最近关闭在前」排序。
 * @param {any[]} list 已归一化的记录
 * @param {number} [limit]
 * @returns {Array}
 */
export function trimClosedEntriesToLaunches(list: RecentlyClosedEntry[], limit: number = RECENTLY_CLOSED_LAUNCH_LIMIT): RecentlyClosedEntry[] {
  const rows = (Array.isArray(list) ? list : [])
  // 先按启动时间新→旧；同一启动内按关闭时间新→旧。
  const byLaunch = rows.slice().sort((a, b) => (b.launchAt - a.launchAt) || (b.closedAt - a.closedAt))
  const kept: RecentlyClosedEntry[] = []
  const seen = new Set<number>()
  for (const row of byLaunch) {
    if (!seen.has(row.launchAt)) {
      if (seen.size >= Math.max(1, limit)) continue
      seen.add(row.launchAt)
    }
    kept.push(row)
  }
  // 展示口径：最近关闭在前（同一毫秒时按启动时间兜底）。
  return kept
    .sort((a, b) => (b.closedAt - a.closedAt) || (b.launchAt - a.launchAt))
    .slice(0, RECENTLY_CLOSED_ENTRIES_LIMIT)
}

/**
 * 解析设置里的 JSON 串 → 记录数组（**最近关闭在前**；任何异常都退化为空数组）。
 * @param {unknown} raw
 * @returns {Array}
 */
export function parseRecentlyClosed(raw: unknown) : unknown[] {
  if (!raw) return []
  let list = raw
  if (typeof raw === 'string') {
    try {
      list = JSON.parse(raw)
    } catch (_) {
      return []
    }
  }
  if (!Array.isArray(list)) return []
  return trimClosedEntriesToLaunches(list.map(normalizeClosedEntry).filter((entry): entry is RecentlyClosedEntry => entry !== null))
}

/**
 * 记录数组 → 设置用的 JSON 串。空数组序列化为空串（与"默认值"一致）。
 * @param {any[]} list
 * @returns {string}
 */
export function serializeRecentlyClosed(list: readonly unknown[] | null | undefined) : string {
  const rows = trimClosedEntriesToLaunches((Array.isArray(list) ? list : []).map(normalizeClosedEntry).filter((entry): entry is RecentlyClosedEntry => entry !== null))
  if (rows.length === 0) return ''
  return JSON.stringify(rows)
}
