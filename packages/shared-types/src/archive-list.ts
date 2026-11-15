/**
 * archive-list —— 「归档区」的**唯一纯规则**（零依赖、无 IO）。
 *
 * 背景：NG 原来的"归档"是**不可逆删除**（`tabLifecycle.archiveTab` → `close(skipUndoStack)`），
 * 归档之后**无处可看、无法恢复**。要变成 Arc 那种"归档区"，缺的不是引擎而是**记录**：
 * 归档那一刻把这条记下来，之后能在面板里看到并一键恢复。
 *
 * 存储形态：设置项 `archive.entries`（JSON 串）。
 * 为什么不建新表：归档条目是"几十条、带淘汰上限"的轻量列表，且**天然随 profile 走**
 * （设置本就按 profile 隔离，见 PART16）。表带来的迁移/契约成本在这里换不到收益。
 *
 * 淘汰策略：**同 URL 去重**（新的一次顶掉旧的）+ **按时间倒序** + **容量上限**。
 * 上限硬编码在调用方传入（`pushArchiveEntry` 的 `max`），不做成设置项 —— 用户不需要调它。
 */

/** 归档容量上限（超出丢最旧的）。 */
export const ARCHIVE_MAX_ENTRIES = 100

/** 「归档区」的设置键（设置项，JSON 串）—— 主进程写入与面板读取共用，避免两处手抄。 */
export const ARCHIVE_SETTING_KEY = 'archive.entries'

export interface ArchiveEntry {
  id: string
  url: string
  title: string
  favicon: string
  archivedAt: number
  spaceId: string
}

type ArchiveInput = readonly unknown[] | string | null | undefined

/**
 * 归一化一条归档记录；没有 url 的一律丢弃（没有 url 的"归档"没有可恢复的内容）。
 * @param {any} input
 * @returns {{ id: string, url: string, title: string, favicon: string, archivedAt: number, spaceId: string }|null}
 */
export function normalizeArchiveEntry(input: unknown): ArchiveEntry | null {
  if (!input || typeof input !== 'object') return null
  const record = input as Record<string, unknown>
  const url = String(record.url || '').trim()
  if (!url) return null
  const archivedAt = Number(record.archivedAt)
  return {
    id: String(record.id || url),
    url,
    title: typeof record.title === 'string' ? record.title : '',
    favicon: typeof record.favicon === 'string' ? record.favicon : '',
    archivedAt: Number.isFinite(archivedAt) && archivedAt > 0 ? archivedAt : Date.now(),
    spaceId: typeof record.spaceId === 'string' ? record.spaceId : ''
  }
}

/**
 * 解析设置里的 JSON。任何异常退化为空数组（绝不抛）。
 * @param {unknown} raw
 * @returns {Array<ReturnType<typeof normalizeArchiveEntry>>}
 */
export function parseArchive(raw: unknown): ArchiveEntry[] {
  if (!raw) return []
  let list: unknown = raw
  if (typeof raw === 'string') {
    try {
      list = JSON.parse(raw)
    } catch (_) {
      return []
    }
  }
  if (!Array.isArray(list)) return []
  return (list as unknown[]).map(normalizeArchiveEntry).filter((item): item is ArchiveEntry => item !== null)
}

/**
 * 序列化；空列表 → 空串（与设置默认值一致）。
 * @param {any[]} list
 * @returns {string}
 */
export function serializeArchive(list: ArchiveInput): string {
  const normalized = (Array.isArray(list) ? list : []).map(normalizeArchiveEntry).filter((item): item is ArchiveEntry => item !== null)
  if (normalized.length === 0) return ''
  return JSON.stringify(normalized)
}

/**
 * 压入一条归档记录：**同 URL 去重 → 置顶 → 截断**。
 *
 * 为什么按 URL 去重而不是 id：归档的是"这个页面"，用户可能今天存一次、下周又存一次，
 * 列表里出现两条一模一样的网址是噪音；新的一次顶掉旧的即可。
 *
 * @param {any[]} list 现有列表
 * @param {any} entry 新记录
 * @param {{ max?: number }} [options]
 * @returns {Array<object>} 新列表（不修改入参）
 */
export function pushArchiveEntry(
  list: ArchiveInput,
  entry: unknown,
  options: { max?: number } = {}
): ArchiveEntry[] {
  const normalized = normalizeArchiveEntry(entry)
  if (!normalized) return parseArchive(list)
  const max = Number(options.max) > 0 ? Number(options.max) : ARCHIVE_MAX_ENTRIES
  const rest = parseArchive(list).filter((item) => item.url !== normalized.url)
  return [normalized, ...rest].slice(0, max)
}

/**
 * 移除一条（按 id 或 url）。
 * @param {any[]} list
 * @param {string} idOrUrl
 * @returns {Array<object>}
 */
export function removeArchiveEntry(list: ArchiveInput, idOrUrl: unknown): ArchiveEntry[] {
  const key = String(idOrUrl || '')
  if (!key) return parseArchive(list)
  return parseArchive(list).filter((item) => item.id !== key && item.url !== key)
}
