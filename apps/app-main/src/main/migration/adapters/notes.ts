/**
 * 笔记迁移适配器。
 * 源格式：[{ id, title, content, createdAt, modifiedAt, folderId?, url?, tags?, color?, pinned? }]
 * 目标表：notes（folder_id / url / tags / color / pinned / sort_order 有默认值，
 * 老数据缺失这些字段时自动落到「根级 + 未置顶 + 顺序 0」，无需额外回填）
 */
const { generateId } = require('@hira-ng/shared-utils')
import type { SqliteDatabase } from './types'

interface NoteMigrationRow {
  id?: unknown
  title?: unknown
  content?: unknown
  folderId?: unknown
  folder_id?: unknown
  url?: unknown
  tags?: unknown
  color?: unknown
  pinned?: unknown
  createdAt?: unknown
  created_at?: unknown
  modifiedAt?: unknown
  modified_at?: unknown
}

const notesAdapter = {
  name: 'notes',
  sourceFile: 'notes.json',

  insert(sqlite: SqliteDatabase, rows: readonly NoteMigrationRow[]) {
    const stmt = sqlite.prepare(`
      INSERT OR REPLACE INTO notes (id, title, content, folder_id, url, tags, color, pinned, created_at, modified_at)
      VALUES (@id, @title, @content, @folderId, @url, @tags, @color, @pinned, @createdAt, @modifiedAt)
    `)
    const insertMany = sqlite.transaction<NoteMigrationRow>((items) => {
      for (const r of items) {
        stmt.run({
          id: r.id || generateId('note'),
          title: r.title || '(无标题笔记)',
          content: r.content || '',
          folderId: r.folderId ?? r.folder_id ?? null,
          url: r.url ?? null,
          tags: Array.isArray(r.tags) ? JSON.stringify(r.tags) : (r.tags ?? null),
          color: r.color ?? null,
          pinned: r.pinned ? 1 : 0,
          createdAt: r.createdAt ?? r.created_at ?? Date.now(),
          modifiedAt: r.modifiedAt ?? r.modified_at ?? Date.now()
        })
      }
    })
    insertMany(rows)
    return rows.length
  }
}

module.exports = { notesAdapter }
