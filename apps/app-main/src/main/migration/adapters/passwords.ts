/**
 * 密码迁移适配器。
 * 源格式：[{ id, profileId, backend, domain, username, backendRef, encryptedPassword, lastUsedAt, createdAt }]
 * 目标表：passwords_meta
 */
const { generateId } = require('@hira-ng/shared-utils')
import type { SqliteDatabase } from './types'

interface PasswordMigrationRow {
  id?: unknown
  profileId?: unknown
  profile_id?: unknown
  backend?: unknown
  domain?: unknown
  username?: unknown
  backendRef?: unknown
  backend_ref?: unknown
  encryptedPassword?: unknown
  encrypted_password?: unknown
  lastUsedAt?: unknown
  last_used_at?: unknown
  createdAt?: unknown
  created_at?: unknown
}

const passwordsAdapter = {
  name: 'passwords',
  sourceFile: 'passwords.json',

  insert(sqlite: SqliteDatabase, rows: readonly PasswordMigrationRow[]) {
    const stmt = sqlite.prepare(`
      INSERT OR REPLACE INTO passwords_meta
        (id, profile_id, backend, domain, username, backend_ref, encrypted_password, last_used_at, created_at)
      VALUES (@id, @profileId, @backend, @domain, @username, @backendRef, @encryptedPassword, @lastUsedAt, @createdAt)
    `)
    const insertMany = sqlite.transaction<PasswordMigrationRow>((items) => {
      for (const r of items) {
        stmt.run({
          id: r.id || generateId('pwd'),
          profileId: r.profileId || r.profile_id || 'default',
          backend: r.backend || 'builtin',
          domain: r.domain,
          username: r.username || '',
          backendRef: r.backendRef || r.backend_ref || null,
          encryptedPassword: r.encryptedPassword || r.encrypted_password || null,
          lastUsedAt: r.lastUsedAt ?? r.last_used_at ?? null,
          createdAt: r.createdAt ?? r.created_at ?? Date.now()
        })
      }
    })
    insertMany(rows)
    return rows.length
  }
}

module.exports = { passwordsAdapter }
