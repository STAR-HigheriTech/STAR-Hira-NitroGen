/**
 * 标签页迁移适配器。
 * 源格式：[{ id, url, title, favicon, position, pinned, active, createdAt }]
 * 目标表：tabs
 */
const { generateId } = require('@hira-ng/shared-utils')
import type { SqliteDatabase } from './types'

interface TabMigrationRow {
  id?: unknown
  url?: unknown
  title?: unknown
  favicon?: unknown
  position?: unknown
  pinned?: unknown
  active?: unknown
  createdAt?: unknown
  created_at?: unknown
}

const tabsAdapter = {
  name: 'tabs',
  sourceFile: 'tabs.json',

  insert(sqlite: SqliteDatabase, rows: readonly TabMigrationRow[]) {
    const stmt = sqlite.prepare(`
      INSERT OR REPLACE INTO tabs (id, url, title, favicon, position, pinned, active, created_at)
      VALUES (@id, @url, @title, @favicon, @position, @pinned, @active, @createdAt)
    `)
    const insertMany = sqlite.transaction<TabMigrationRow>((items) => {
      for (const r of items) {
        stmt.run({
          id: r.id || generateId('tab'),
          url: r.url || 'about:blank',
          title: r.title || null,
          favicon: r.favicon || null,
          position: r.position ?? 0,
          pinned: r.pinned ? 1 : 0,
          active: r.active ? 1 : 0,
          createdAt: r.createdAt ?? r.created_at ?? Date.now()
        })
      }
    })
    insertMany(rows)
    return rows.length
  }
}

module.exports = { tabsAdapter }
