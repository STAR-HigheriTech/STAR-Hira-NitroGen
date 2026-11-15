/**
 * 权限迁移适配器。
 * 源格式：[{ id, profileId, domain, permissionType, setting, updatedAt }]
 * 目标表：permissions
 */
const { generateId } = require('@hira-ng/shared-utils')
// setting 三值（allow / block / ask）与"非法值回落 ask"的规则由共享真源给出，
// 与 domain-permission#sanitizeSetting、权限页 / 浮层的下拉引用同一份。
const { normalizePermissionSetting } = require('@hira-ng/shared-types/src/permission-labels.mjs')
import type { SqliteDatabase } from './types'

interface PermissionMigrationRow {
  id?: unknown
  profileId?: unknown
  profile_id?: unknown
  domain?: unknown
  permissionType?: unknown
  permission_type?: unknown
  setting?: unknown
  updatedAt?: unknown
  updated_at?: unknown
}

const permissionsAdapter = {
  name: 'permissions',
  sourceFile: 'permissions.json',

  insert(sqlite: SqliteDatabase, rows: readonly PermissionMigrationRow[]) {
    const stmt = sqlite.prepare(`
      INSERT OR REPLACE INTO permissions
        (id, profile_id, domain, permission_type, setting, updated_at)
      VALUES (@id, @profileId, @domain, @permissionType, @setting, @updatedAt)
    `)
    const insertMany = sqlite.transaction<PermissionMigrationRow>((items) => {
      for (const r of items) {
        const setting = normalizePermissionSetting(r.setting)
        stmt.run({
          id: r.id || generateId('perm'),
          profileId: r.profileId || r.profile_id || 'default',
          domain: r.domain,
          permissionType: r.permissionType || r.permission_type,
          setting,
          updatedAt: r.updatedAt ?? r.updated_at ?? Date.now()
        })
      }
    })
    insertMany(rows)
    return rows.length
  }
}

module.exports = { permissionsAdapter }
