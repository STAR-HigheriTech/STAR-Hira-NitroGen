/**
 * 书签迁移适配器。
 * 源格式（Hira v7.5.0）：[{ id, parentId, title, url, favicon, createdAt, modifiedAt }]
 * 目标表：bookmarks
 *
 * 注意：文件夹的 url 为 null。
 */
const { generateId } = require('@hira-ng/shared-utils')
import type { SqliteDatabase } from './types'

interface BookmarkMigrationRow {
  id?: unknown
  parentId?: unknown
  parent_id?: unknown
  title?: unknown
  url?: unknown
  favicon?: unknown
  createdAt?: unknown
  created_at?: unknown
  modifiedAt?: unknown
  modified_at?: unknown
}

const bookmarksAdapter = {
  name: 'bookmarks',
  sourceFile: 'bookmarks.json',

  /**
   * @param {import('better-sqlite3').Database} sqlite
   * @param {Array} rows
   * @returns {number} 插入行数
   */
  insert(sqlite: SqliteDatabase, rows: readonly BookmarkMigrationRow[]) : number {
    const stmt = sqlite.prepare(`
      INSERT OR REPLACE INTO bookmarks (id, parent_id, title, url, favicon, created_at, modified_at)
      VALUES (@id, @parentId, @title, @url, @favicon, @createdAt, @modifiedAt)
    `)
    const insertMany = sqlite.transaction<BookmarkMigrationRow>((items) => {
      for (const r of items) {
        stmt.run({
          id: r.id || generateId('bm'),
          parentId: r.parentId || r.parent_id || null,
          title: r.title || '(无标题)',
          url: r.url || null,
          favicon: r.favicon || null,
          createdAt: r.createdAt || r.created_at || Date.now(),
          modifiedAt: r.modifiedAt || r.modified_at || Date.now()
        })
      }
    })
    insertMany(rows)
    return rows.length
  }
}

module.exports = { bookmarksAdapter }
