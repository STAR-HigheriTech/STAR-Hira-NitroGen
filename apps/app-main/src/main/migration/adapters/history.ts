/**
 * 历史记录迁移适配器。
 * 源格式：[{ id, url, title, favicon, visitCount, lastVisitAt, firstVisitAt }]
 * 目标表：history
 *
 * URL 在这里就按历史身份口径（`canonicalHistoryUrl`）规范化：迁移写的是聚合行，
 * 与 domain-history 的 addVisit / importVisits 必须同一个口径，否则一次旧数据迁移
 * 就能让同一页在列表里裂成两行（唯一索引 `(profile_id, url)` 会直接冲突）。
 */
const { generateId, canonicalHistoryUrl } = require('@hira-ng/shared-utils')
import type { SqliteDatabase } from './types'

interface HistoryMigrationRow {
  id?: unknown
  url?: unknown
  title?: unknown
  favicon?: unknown
  visitCount?: unknown
  visit_count?: unknown
  lastVisitAt?: unknown
  last_visit_at?: unknown
  firstVisitAt?: unknown
  first_visit_at?: unknown
}

const historyAdapter = {
  name: 'history',
  sourceFile: 'history.json',

  insert(sqlite: SqliteDatabase, rows: readonly HistoryMigrationRow[]) {
    const stmt = sqlite.prepare(`
      INSERT OR REPLACE INTO history (id, url, title, favicon, visit_count, last_visit_at, first_visit_at)
      VALUES (@id, @url, @title, @favicon, @visitCount, @lastVisitAt, @firstVisitAt)
    `)
    const insertMany = sqlite.transaction<HistoryMigrationRow>((items) => {
      for (const r of items) {
        stmt.run({
          id: r.id || generateId('his'),
          url: canonicalHistoryUrl(String(r.url || '')),
          title: r.title || null,
          favicon: r.favicon || null,
          visitCount: r.visitCount ?? r.visit_count ?? 1,
          lastVisitAt: r.lastVisitAt ?? r.last_visit_at ?? Date.now(),
          firstVisitAt: r.firstVisitAt ?? r.first_visit_at ?? Date.now()
        })
      }
    })
    insertMany(rows)
    return rows.length
  }
}

module.exports = { historyAdapter }
