/**
 * 下载记录迁移适配器。
 * 源格式：[{ id, url, filename, filePath, totalBytes, receivedBytes, state, mimeType, startedAt, completedAt, danger }]
 * 目标表：downloads
 */
const { generateId } = require('@hira-ng/shared-utils')
import type { SqliteDatabase } from './types'

const VALID_STATES = new Set(['pending', 'in_progress', 'completed', 'cancelled', 'interrupted'])
const VALID_DANGER = new Set(['safe', 'suspicious', 'dangerous'])

interface DownloadMigrationRow {
  id?: unknown
  url?: unknown
  filename?: unknown
  filePath?: unknown
  file_path?: unknown
  totalBytes?: unknown
  total_bytes?: unknown
  receivedBytes?: unknown
  received_bytes?: unknown
  state?: unknown
  mimeType?: unknown
  mime_type?: unknown
  startedAt?: unknown
  started_at?: unknown
  completedAt?: unknown
  completed_at?: unknown
  danger?: unknown
}

const downloadsAdapter = {
  name: 'downloads',
  sourceFile: 'downloads.json',

  insert(sqlite: SqliteDatabase, rows: readonly DownloadMigrationRow[]) {
    const stmt = sqlite.prepare(`
      INSERT OR REPLACE INTO downloads
        (id, url, filename, file_path, total_bytes, received_bytes, state, mime_type, started_at, completed_at, danger)
      VALUES (@id, @url, @filename, @filePath, @totalBytes, @receivedBytes, @state, @mimeType, @startedAt, @completedAt, @danger)
    `)
    const insertMany = sqlite.transaction<DownloadMigrationRow>((items) => {
      for (const r of items) {
        const rawState = String(r.state || 'completed')
        const state = VALID_STATES.has(rawState) ? rawState : 'completed'
        const rawDanger = String(r.danger || 'safe')
        const danger = VALID_DANGER.has(rawDanger) ? rawDanger : 'safe'
        stmt.run({
          id: r.id || generateId('dl'),
          url: r.url,
          filename: r.filename || (r.url ? String(r.url).split('/').pop() : 'download'),
          filePath: r.filePath || r.file_path || null,
          totalBytes: r.totalBytes ?? r.total_bytes ?? null,
          receivedBytes: r.receivedBytes ?? r.received_bytes ?? 0,
          state,
          mimeType: r.mimeType || r.mime_type || null,
          startedAt: r.startedAt ?? r.started_at ?? Date.now(),
          completedAt: r.completedAt ?? r.completed_at ?? null,
          danger
        })
      }
    })
    insertMany(rows)
    return rows.length
  }
}

module.exports = { downloadsAdapter }
