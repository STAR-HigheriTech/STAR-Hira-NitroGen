/**
 * LayoutRepository —— domain-layout 的 SQLite 端口实现。
 *
 * 只做事务与行映射，不决定布局规则。`dbProvider.sqlite` 是按当前 profile
 * 路由的代理，因此这里不复制 profile 文件路径知识。
 */
import { LAYOUT_SCHEMA_DDL, type SqliteHandle } from '@hira-ng/infra-db'
import { normalizeLayoutDocument, type LayoutDocument } from '@hira-ng/layout-model'

export interface LayoutRecord {
  id: string
  profileId: string
  spaceId: string | null
  name: string
  kind: 'custom' | 'template' | 'imported'
  schemaVersion: number
  revision: number
  document: LayoutDocument
  createdAt: number
  updatedAt: number
}

interface LayoutScope {
  profileId: string
  spaceId?: string | null
  context?: string | null
}

interface LayoutRevision {
  revision: number
  action: string
  document: LayoutDocument
  createdAt: number
}

interface LayoutBinding {
  profileId: string
  spaceId: string | null
  context: string
  layoutId: string
}

export interface LayoutRepositoryOptions {
  sqlite: SqliteHandle
  now?(): number
}

export interface LayoutRepository {
  ensureSchema(): void
  list(profileId: string, spaceId?: string | null): LayoutRecord[]
  get(id: string): LayoutRecord | null
  save(record: LayoutRecord, action?: unknown): LayoutRecord
  remove(id: string): boolean
  getBinding(scope: LayoutScope): LayoutBinding | null
  setBinding(scope: LayoutScope, layoutId: string): void
  listRevisions(layoutId: string, limit?: number): LayoutRevision[]
  restoreRevision(layoutId: string, revision: number): LayoutRecord | null
}

const MAX_REVISIONS = 100

function scopeSpace(spaceId: unknown): string {
  return spaceId == null ? '' : String(spaceId)
}

function parseDocument(text: unknown): LayoutDocument {
  try {
    return normalizeLayoutDocument(JSON.parse(typeof text === 'string' ? text : ''))
  } catch {
    return normalizeLayoutDocument(null)
  }
}

function mapRecord(row: unknown): LayoutRecord | null {
  if (!row) return null
  const record = row as Record<string, unknown>
  return {
    id: String(record.id || ''),
    profileId: String(record.profile_id || ''),
    spaceId: record.space_id ? String(record.space_id) : null,
    name: String(record.name || ''),
    kind: record.kind === 'template' || record.kind === 'imported' ? record.kind : 'custom',
    schemaVersion: Number(record.schema_version) || 1,
    revision: Number(record.revision) || 1,
    document: parseDocument(record.document_json),
    createdAt: Number(record.created_at) || 0,
    updatedAt: Number(record.updated_at) || 0
  }
}

/**
 * @param {{ sqlite: any, now?: () => number }} options
 */
export function createLayoutRepository({ sqlite, now = () => Date.now() }: LayoutRepositoryOptions): LayoutRepository {
  if (!sqlite || typeof sqlite.prepare !== 'function') {
    throw new Error('[layout-repository] sqlite handle is required')
  }

  function ensureSchema(): void {
    sqlite.exec(LAYOUT_SCHEMA_DDL)
  }

  function list(profileId: string, spaceId?: string | null): LayoutRecord[] {
    return (sqlite.prepare(`
      SELECT * FROM layout_documents
      WHERE profile_id = ? AND space_id = ?
      ORDER BY updated_at DESC
    `).all(String(profileId), scopeSpace(spaceId)) as unknown[]).map(mapRecord).filter((item): item is LayoutRecord => item !== null)
  }

  function get(id: string): LayoutRecord | null {
    return mapRecord(
      sqlite.prepare('SELECT * FROM layout_documents WHERE id = ?').get(String(id))
    )
  }

  const saveTransaction = sqlite.transaction((record: LayoutRecord, action?: unknown): LayoutRecord => {
    const documentJson = JSON.stringify(record.document)
    sqlite.prepare(`
      INSERT INTO layout_documents
        (id, profile_id, space_id, name, kind, schema_version, revision, document_json, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        name = excluded.name,
        kind = excluded.kind,
        schema_version = excluded.schema_version,
        revision = excluded.revision,
        document_json = excluded.document_json,
        updated_at = excluded.updated_at
    `).run(
      record.id,
      record.profileId,
      scopeSpace(record.spaceId),
      record.name,
      record.kind,
      record.schemaVersion,
      record.revision,
      documentJson,
      record.createdAt,
      record.updatedAt
    )
    sqlite.prepare(`
      INSERT OR IGNORE INTO layout_revisions
        (layout_id, revision, action, document_json, created_at)
      VALUES (?, ?, ?, ?, ?)
    `).run(record.id, record.revision, String(action || 'save'), documentJson, now())
    sqlite.prepare(`
      DELETE FROM layout_revisions
      WHERE layout_id = ?
        AND revision NOT IN (
          SELECT revision FROM layout_revisions
          WHERE layout_id = ?
          ORDER BY revision DESC
          LIMIT ${MAX_REVISIONS}
        )
    `).run(record.id, record.id)
    return record
  })

  function save(record: LayoutRecord, action?: unknown): LayoutRecord {
    return saveTransaction(record, action)
  }

  function remove(id: string): boolean {
    const run = sqlite.transaction(() => {
      sqlite.prepare('DELETE FROM layout_bindings WHERE layout_id = ?').run(String(id))
      sqlite.prepare('DELETE FROM layout_revisions WHERE layout_id = ?').run(String(id))
      return sqlite.prepare('DELETE FROM layout_documents WHERE id = ?').run(String(id)).changes > 0
    })
    return run()
  }

  function getBinding(scope: LayoutScope): LayoutBinding | null {
    const row = sqlite.prepare(`
      SELECT profile_id, space_id, context, layout_id
      FROM layout_bindings
      WHERE profile_id = ? AND space_id = ? AND context = ?
    `).get(String(scope.profileId), scopeSpace(scope.spaceId), String(scope.context || 'default')) as Record<string, unknown> | undefined
    return row
      ? {
          profileId: String(row.profile_id || ''),
          spaceId: row.space_id ? String(row.space_id) : null,
          context: String(row.context || 'default'),
          layoutId: String(row.layout_id || '')
        }
      : null
  }

  function setBinding(scope: LayoutScope, layoutId: string): void {
    sqlite.prepare(`
      INSERT INTO layout_bindings (profile_id, space_id, context, layout_id)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(profile_id, space_id, context) DO UPDATE SET layout_id = excluded.layout_id
    `).run(
      String(scope.profileId),
      scopeSpace(scope.spaceId),
      String(scope.context || 'default'),
      String(layoutId)
    )
  }

  function listRevisions(layoutId: string, limit = MAX_REVISIONS): LayoutRevision[] {
    return (sqlite.prepare(`
      SELECT revision, action, document_json, created_at
      FROM layout_revisions
      WHERE layout_id = ?
      ORDER BY revision DESC
      LIMIT ?
    `).all(String(layoutId), Math.max(1, Math.min(MAX_REVISIONS, Number(limit) || MAX_REVISIONS))) as Array<Record<string, unknown>>)
      .map((row) => ({
        revision: Number(row.revision),
        action: String(row.action),
        document: parseDocument(row.document_json),
        createdAt: Number(row.created_at)
      }))
  }

  function restoreRevision(layoutId: string, revision: number): LayoutRecord | null {
    const current = get(layoutId)
    if (!current) return null
    const row = sqlite.prepare(`
      SELECT document_json FROM layout_revisions
      WHERE layout_id = ? AND revision = ?
    `).get(String(layoutId), Number(revision)) as Record<string, unknown> | undefined
    if (!row) return null
    const document = parseDocument(row.document_json)
    return save({
      ...current,
      revision: current.revision + 1,
      name: document.name,
      document,
      updatedAt: now()
    }, `restore-${revision}`)
  }

  return {
    ensureSchema,
    list,
    get,
    save,
    remove,
    getBinding,
    setBinding,
    listRevisions,
    restoreRevision
  }
}


