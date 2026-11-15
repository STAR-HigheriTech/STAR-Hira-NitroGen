/**
 * named-sessions —— 「命名会话 / 会话模板」（N14）的**唯一纯规则**。
 *
 * 「把当前空间的标签集存成一个有名字的会话，之后一键恢复」。
 *
 * ── 存储形态 ──────────────────────────────────────────────────────
 * 走设置项 `sessions.named`（JSON 字符串），**不建新表**：
 *   · 天然随 profile 隔离（设置本就按 profile 走）；
 *   · 量级是"几十个会话 × 每个几十条标签"，一个设置值完全够用；
 *   · 与归档区（`archive.entries`）、注入规则（`webview.inject_rules`）同一手法 ——
 *     本项目对"结构化的小集合"一贯不新建表。
 *
 * ── 为什么要有条数上限 ────────────────────────────────────────────
 * 会话是"快照"，用户存多了自己也会忘；不设上限就是一个只增不减的 JSON，
 * 最终把设置文件撑到几 MB（每次读写都要整份序列化）。满了挤掉**最旧的**一条，
 * 行为可预期（与归档区同一口径）。
 */

/** 「命名会话」的设置键（设置项，JSON 串）—— 引擎与各视图共用，避免多处手抄。 */
export const NAMED_SESSIONS_SETTING_KEY = 'sessions.named'

/** 最多保留多少个命名会话。 */
export const NAMED_SESSIONS_LIMIT = 30
/** 单个会话最多记多少条标签（防止一次"全部标签"把设置撑爆）。 */
export const NAMED_SESSION_TABS_LIMIT = 200

/**
 * 归一化一条标签快照（只留恢复时真正要用的字段）。
 * @param {any} tab
 * @returns {{ url: string, title: string, pinned: boolean }|null}
 */
export interface NamedSessionTab {
  url: string
  title: string
  pinned: boolean
}

export interface NamedSession {
  id: string
  name: string
  createdAt: number
  spaceId: string
  tabs: NamedSessionTab[]
}

function normalizeTab(tab: unknown): NamedSessionTab | null {
  if (!tab || typeof tab !== 'object') return null
  const source = tab as Record<string, unknown>
  const url = String(source.url == null ? '' : source.url).trim()
  if (!url) return null
  return { url, title: String(source.title == null ? '' : source.title), pinned: source.pinned === true }
}

/**
 * 归一化一个命名会话；缺 id / 名字 / 标签全空时返回 null。
 * @param {any} input
 * @returns {{ id:string, name:string, createdAt:number, spaceId:string, tabs:Array }|null}
 */
export function normalizeNamedSession(input: unknown): NamedSession | null {
  if (!input || typeof input !== 'object') return null
  const source = input as Record<string, unknown>
  const name = String(source.name == null ? '' : source.name).trim()
  if (!name) return null
  const id = String(source.id == null ? '' : source.id).trim() || name
  const tabs = (Array.isArray(source.tabs) ? source.tabs : [])
    .map(normalizeTab)
    .filter((tab): tab is NamedSessionTab => tab !== null)
    .slice(0, NAMED_SESSION_TABS_LIMIT)
  if (tabs.length === 0) return null
  const createdAt = Number(source.createdAt)
  return {
    id,
    name,
    createdAt: Number.isFinite(createdAt) && createdAt > 0 ? createdAt : Date.now(),
    spaceId: String(source.spaceId == null ? '' : source.spaceId),
    tabs
  }
}

/**
 * 解析设置里的 JSON 串 → 会话数组（**新的在前**；任何异常都退化为空数组，绝不抛）。
 * @param {unknown} raw
 * @returns {Array}
 */
export function parseNamedSessions(raw: unknown) : unknown[] {
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
  return list
    .map(normalizeNamedSession)
    .filter((item): item is NamedSession => item !== null)
    .sort((a, b) => b.createdAt - a.createdAt)
}

/**
 * 会话数组 → 设置用的 JSON 串。空数组序列化为空串（与"默认值"一致）。
 * @param {any[]} list
 * @returns {string}
 */
export function serializeNamedSessions(list: readonly unknown[] | null | undefined) : string {
  const items = (Array.isArray(list) ? list : []).map(normalizeNamedSession).filter((item): item is NamedSession => item !== null)
  if (items.length === 0) return ''
  return JSON.stringify(items.slice(0, NAMED_SESSIONS_LIMIT))
}

/**
 * 追加一个会话（新的在前，超上限挤掉最旧的）。
 * @param {any[]} list 现有会话
 * @param {object} session 待加入的会话
 * @returns {any[]} 新数组
 */
export function pushNamedSession(list: readonly unknown[] | null | undefined, session: Record<string, unknown>): NamedSession[] {
  const item = normalizeNamedSession(session)
  const base = (Array.isArray(list) ? list : []).map(normalizeNamedSession).filter((item): item is NamedSession => item !== null)
  if (!item) return base
  return [item, ...base].slice(0, NAMED_SESSIONS_LIMIT)
}

/**
 * 按 id 移除一个会话。
 * @param {any[]} list
 * @param {string} id
 * @returns {any[]}
 */
export function removeNamedSession(list: readonly unknown[] | null | undefined, id: string): NamedSession[] {
  const key = String(id == null ? '' : id)
  const base = (Array.isArray(list) ? list : []).map(normalizeNamedSession).filter((item): item is NamedSession => item !== null)
  return base.filter((s) => s.id !== key)
}
