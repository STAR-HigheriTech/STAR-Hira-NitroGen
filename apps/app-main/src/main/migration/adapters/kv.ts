/**
 * 设置（KV）迁移适配器。
 * 源格式：{ [key]: value }  或  [{ key, value }]
 * 目标表：kv
 */
import type { SqliteDatabase } from './types'

const kvAdapter = {
  name: 'kv',
  sourceFile: 'settings.json',

  insert(sqlite: SqliteDatabase, rows: unknown) {
    // 支持两种源格式：对象 {key:val} 或 数组 [{key,val}]
    interface KvEntry { key: unknown; value: unknown }
    let entries: KvEntry[]
    if (Array.isArray(rows)) {
      entries = rows.map((r) => {
        const row = r as Record<string, unknown>
        return { key: row.key, value: row.value }
      })
    } else if (rows && typeof rows === 'object') {
      entries = Object.entries(rows).map(([key, value]) => ({ key, value: JSON.stringify(value) }))
    } else {
      entries = []
    }

    const stmt = sqlite.prepare(`
      INSERT OR REPLACE INTO kv (key, value) VALUES (@key, @value)
    `)
    const insertMany = sqlite.transaction<KvEntry>((items) => {
      for (const r of items) {
        stmt.run({ key: r.key, value: r.value })
      }
    })
    insertMany(entries)
    return entries.length
  }
}

module.exports = { kvAdapter }
