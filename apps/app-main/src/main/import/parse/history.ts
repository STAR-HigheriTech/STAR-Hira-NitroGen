/**
 * Chromium `History` SQLite → 访问记录数组
 *
 * Chromium 的库结构（本模块只依赖这两张表的公共部分）：
 *   urls(id, url, title, visit_count, typed_count, last_visit_time, hidden)
 *   visits(id, url, visit_time, transition)
 *
 * 读取纪律：
 *   · 只打开**临时副本**（见 ../copy）且 `readonly: true`（infra-db#openReadonly）；
 *   · `hidden = 0` —— 用户主动隐藏的条目不该被搬进新浏览器；
 *   · 只保留 http(s)，`chrome://` / `file://` 等不是可回访的网页历史；
 *   · transition → Hira 的四档（link / typed / reload / auto）映射，未知值落 link。
 *
 * 去重口径与 `domain-history#importVisits` 一致：`url + visitedAt`。
 */
import { openReadonly, type SqliteHandle } from '@hira-ng/infra-db'
import { webkitToUnixMs } from './time'

/** Chromium `visits.transition` → Hira transition（0..10，其余一律 link）。 */
export type HistoryTransition = 'link' | 'typed' | 'auto' | 'reload'

export interface HistoryVisit {
  url: string
  title: string
  visitedAt: number
  transition: HistoryTransition
}

interface ChromiumHistoryRow {
  url: unknown
  title: unknown
  visit_time: unknown
  transition: unknown
}

interface ReadonlyStatement {
  all(limit?: number): ChromiumHistoryRow[]
}

interface ReadonlyDatabase {
  prepare(sql: string): ReadonlyStatement
  close(): void
}

export type ParseHistoryResult = { ok: true; visits: HistoryVisit[]; count: number; skipped: number } | { ok: false; error: string }

export const TRANSITION_MAP: Readonly<Record<number, HistoryTransition>> = Object.freeze({
  0: 'link',
  1: 'typed',
  2: 'auto',
  3: 'auto',
  4: 'auto',
  5: 'auto',
  6: 'auto',
  7: 'link',
  8: 'reload',
  9: 'link',
  10: 'link'
})

const HISTORY_SQL = `
SELECT u.url AS url, u.title AS title, v.visit_time AS visit_time, v.transition AS transition
FROM visits v
JOIN urls u ON u.id = v.url
WHERE u.hidden = 0 AND u.url LIKE 'http%'
ORDER BY v.visit_time ASC
`

/**
 * @param {string} filePath 已复制到临时目录的 History 文件
 * @param {{ limit?: number }} [options] limit = 最多取多少条访问（0/缺省 = 不限）
 * @returns {{ ok: true, visits: Array, count: number, skipped: number } | { ok: false, error: string }}
 */
function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

export function parseHistoryFile(filePath: string, options: { limit?: number } = {}): ParseHistoryResult {
  let db: SqliteHandle | null = null
  try {
    db = openReadonly(filePath)
    const limit = Number(options.limit)
    const statement = Number.isFinite(limit) && limit > 0
      ? db.prepare(`${HISTORY_SQL} LIMIT ?`)
      : db.prepare(HISTORY_SQL)
    const rows = (Number.isFinite(limit) && limit > 0 ? statement.all(limit) : statement.all()) as unknown as ChromiumHistoryRow[]

    const visits: HistoryVisit[] = []
    const seen = new Set<string>()
    let skipped = 0

    for (const row of rows) {
      const url = typeof row.url === 'string' ? row.url.trim() : ''
      if (!/^https?:\/\//i.test(url)) {
        skipped++
        continue
      }
      const visitedAt = webkitToUnixMs(row.visit_time)
      if (!visitedAt) {
        skipped++
        continue
      }
      const key = `${url}\u0000${visitedAt}`
      if (seen.has(key)) {
        skipped++
        continue
      }
      seen.add(key)
      visits.push({
        url,
        title: typeof row.title === 'string' ? row.title : '',
        visitedAt,
        transition: TRANSITION_MAP[Number(row.transition)] || 'link'
      })
    }

    return { ok: true, visits, count: visits.length, skipped }
  } catch (e) {
    return { ok: false, error: `读取历史记录失败：${errorMessage(e)}` }
  } finally {
    if (db) {
      try {
        db.close()
      } catch (_) {}
    }
  }
}

