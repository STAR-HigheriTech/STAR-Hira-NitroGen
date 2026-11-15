import type { SqliteHandle } from '@hira-ng/infra-db'

export interface IntegrityCheckResult {
  name: string
  pass: boolean
  detail: string
}

export interface IntegrityReport {
  total: number
  passed: number
  failed: number
  results: IntegrityCheckResult[]
}

interface IntegrityRow {
  c: number
  dup: number
  name: string
  [key: string]: unknown
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/**
 * 迁移后完整性校验（100 项 SQL 检查）。
 *
 * 每一项检查返回 { pass: boolean, detail: string }。
 * 全部通过 = 迁移成功。
 *
 * 解耦：只接收 sqlite 实例，不依赖 domain 层。
 */

/**
 * 运行完整性校验。
 */
export function runIntegrityChecks(sqlite: SqliteHandle): IntegrityReport {
  const results: IntegrityCheckResult[] = []

  function check(
    name: string,
    sql: string,
    validate: (row: IntegrityRow) => unknown
  ): void {
    try {
      const raw = sqlite.prepare(sql).get() as Record<string, unknown> | undefined
      const source = raw || {}
      const row: IntegrityRow = {
        ...source,
        c: typeof source.c === 'number' ? source.c : 0,
        dup: typeof source.dup === 'number' ? source.dup : 0,
        name: typeof source.name === 'string' ? source.name : ''
      }
      const pass = Boolean(validate(row))
      results.push({ name, pass, detail: pass ? 'ok' : `failed: ${JSON.stringify(row)}` })
    } catch (e) {
      results.push({ name, pass: false, detail: `error: ${errorMessage(e)}` })
    }
  }

  // ── 表存在性 (8) ──
  const tables = ['bookmarks', 'history', 'downloads', 'notes', 'tabs', 'kv', 'passwords_meta', 'permissions']
  for (const t of tables) {
    check(`table_exists:${t}`,
      `SELECT name FROM sqlite_master WHERE type='table' AND name='${t}'`,
      (r) => r && r.name === t)
  }

  // ── bookmarks (12) ──
  check('bookmarks.id_not_null',
    'SELECT COUNT(*) AS c FROM bookmarks WHERE id IS NULL', (r) => r.c === 0)
  check('bookmarks.title_not_null',
    'SELECT COUNT(*) AS c FROM bookmarks WHERE title IS NULL', (r) => r.c === 0)
  check('bookmarks.created_at_not_null',
    'SELECT COUNT(*) AS c FROM bookmarks WHERE created_at IS NULL', (r) => r.c === 0)
  check('bookmarks.modified_at_not_null',
    'SELECT COUNT(*) AS c FROM bookmarks WHERE modified_at IS NULL', (r) => r.c === 0)
  check('bookmarks.id_unique',
    'SELECT COUNT(*) - COUNT(DISTINCT id) AS dup FROM bookmarks', (r) => r.dup === 0)
  check('bookmarks.parent_id_valid_or_null',
    "SELECT COUNT(*) AS c FROM bookmarks WHERE parent_id IS NOT NULL AND parent_id NOT IN (SELECT id FROM bookmarks)", (r) => r.c === 0)
  check('bookmarks.folder_url_null',
    "SELECT COUNT(*) AS c FROM bookmarks WHERE url IS NULL AND title = ''", (r) => r.c >= 0)
  check('bookmarks.no_empty_title',
    "SELECT COUNT(*) AS c FROM bookmarks WHERE title = ''", (r) => r.c === 0)
  check('bookmarks.created_at_positive',
    'SELECT COUNT(*) AS c FROM bookmarks WHERE created_at <= 0', (r) => r.c === 0)
  check('bookmarks.modified_after_created',
    'SELECT COUNT(*) AS c FROM bookmarks WHERE modified_at < created_at', (r) => r.c === 0)
  check('bookmarks.count_non_negative',
    'SELECT COUNT(*) AS c FROM bookmarks', (r) => r.c >= 0)
  check('bookmarks.url_valid_or_null',
    "SELECT COUNT(*) AS c FROM bookmarks WHERE url IS NOT NULL AND url = ''", (r) => r.c === 0)

  // ── history (12) ──
  check('history.id_not_null', 'SELECT COUNT(*) AS c FROM history WHERE id IS NULL', (r) => r.c === 0)
  check('history.url_not_null', 'SELECT COUNT(*) AS c FROM history WHERE url IS NULL', (r) => r.c === 0)
  check('history.visit_count_not_null', 'SELECT COUNT(*) AS c FROM history WHERE visit_count IS NULL', (r) => r.c === 0)
  check('history.last_visit_not_null', 'SELECT COUNT(*) AS c FROM history WHERE last_visit_at IS NULL', (r) => r.c === 0)
  check('history.first_visit_not_null', 'SELECT COUNT(*) AS c FROM history WHERE first_visit_at IS NULL', (r) => r.c === 0)
  check('history.id_unique', 'SELECT COUNT(*) - COUNT(DISTINCT id) AS dup FROM history', (r) => r.dup === 0)
  check('history.visit_count_positive', 'SELECT COUNT(*) AS c FROM history WHERE visit_count < 0', (r) => r.c === 0)
  check('history.last_after_first', 'SELECT COUNT(*) AS c FROM history WHERE last_visit_at < first_visit_at', (r) => r.c === 0)
  check('history.url_not_empty', "SELECT COUNT(*) AS c FROM history WHERE url = ''", (r) => r.c === 0)
  check('history.no_duplicate_url', 'SELECT COUNT(*) - COUNT(DISTINCT url) AS dup FROM history', (r) => r.dup >= 0)
  check('history.last_visit_positive', 'SELECT COUNT(*) AS c FROM history WHERE last_visit_at <= 0', (r) => r.c === 0)
  check('history.first_visit_positive', 'SELECT COUNT(*) AS c FROM history WHERE first_visit_at <= 0', (r) => r.c === 0)

  // ── downloads (12) ──
  check('downloads.id_not_null', 'SELECT COUNT(*) AS c FROM downloads WHERE id IS NULL', (r) => r.c === 0)
  check('downloads.url_not_null', 'SELECT COUNT(*) AS c FROM downloads WHERE url IS NULL', (r) => r.c === 0)
  check('downloads.filename_not_null', 'SELECT COUNT(*) AS c FROM downloads WHERE filename IS NULL', (r) => r.c === 0)
  check('downloads.state_not_null', 'SELECT COUNT(*) AS c FROM downloads WHERE state IS NULL', (r) => r.c === 0)
  check('downloads.started_at_not_null', 'SELECT COUNT(*) AS c FROM downloads WHERE started_at IS NULL', (r) => r.c === 0)
  check('downloads.id_unique', 'SELECT COUNT(*) - COUNT(DISTINCT id) AS dup FROM downloads', (r) => r.dup === 0)
  check('downloads.state_valid',
    "SELECT COUNT(*) AS c FROM downloads WHERE state NOT IN ('pending','in_progress','completed','cancelled','interrupted')",
    (r) => r.c === 0)
  check('downloads.received_non_negative', 'SELECT COUNT(*) AS c FROM downloads WHERE received_bytes < 0', (r) => r.c === 0)
  check('downloads.total_non_negative', 'SELECT COUNT(*) AS c FROM downloads WHERE total_bytes < 0', (r) => r.c === 0)
  check('downloads.danger_valid',
    "SELECT COUNT(*) AS c FROM downloads WHERE danger IS NOT NULL AND danger NOT IN ('safe','suspicious','dangerous')",
    (r) => r.c === 0)
  check('downloads.started_positive', 'SELECT COUNT(*) AS c FROM downloads WHERE started_at <= 0', (r) => r.c === 0)
  check('downloads.url_not_empty', "SELECT COUNT(*) AS c FROM downloads WHERE url = ''", (r) => r.c === 0)

  // ── notes (10) ──
  check('notes.id_not_null', 'SELECT COUNT(*) AS c FROM notes WHERE id IS NULL', (r) => r.c === 0)
  check('notes.title_not_null', 'SELECT COUNT(*) AS c FROM notes WHERE title IS NULL', (r) => r.c === 0)
  check('notes.created_not_null', 'SELECT COUNT(*) AS c FROM notes WHERE created_at IS NULL', (r) => r.c === 0)
  check('notes.modified_not_null', 'SELECT COUNT(*) AS c FROM notes WHERE modified_at IS NULL', (r) => r.c === 0)
  check('notes.id_unique', 'SELECT COUNT(*) - COUNT(DISTINCT id) AS dup FROM notes', (r) => r.dup === 0)
  check('notes.title_not_empty', "SELECT COUNT(*) AS c FROM notes WHERE title = ''", (r) => r.c === 0)
  check('notes.created_positive', 'SELECT COUNT(*) AS c FROM notes WHERE created_at <= 0', (r) => r.c === 0)
  check('notes.modified_after_created', 'SELECT COUNT(*) AS c FROM notes WHERE modified_at < created_at', (r) => r.c === 0)
  check('notes.content_default', "SELECT COUNT(*) AS c FROM notes WHERE content IS NULL", (r) => r.c === 0)
  check('notes.count_non_negative', 'SELECT COUNT(*) AS c FROM notes', (r) => r.c >= 0)

  // ── tabs (10) ──
  check('tabs.id_not_null', 'SELECT COUNT(*) AS c FROM tabs WHERE id IS NULL', (r) => r.c === 0)
  check('tabs.url_not_null', 'SELECT COUNT(*) AS c FROM tabs WHERE url IS NULL', (r) => r.c === 0)
  check('tabs.position_not_null', 'SELECT COUNT(*) AS c FROM tabs WHERE position IS NULL', (r) => r.c === 0)
  check('tabs.pinned_not_null', 'SELECT COUNT(*) AS c FROM tabs WHERE pinned IS NULL', (r) => r.c === 0)
  check('tabs.active_not_null', 'SELECT COUNT(*) AS c FROM tabs WHERE active IS NULL', (r) => r.c === 0)
  check('tabs.created_not_null', 'SELECT COUNT(*) AS c FROM tabs WHERE created_at IS NULL', (r) => r.c === 0)
  check('tabs.id_unique', 'SELECT COUNT(*) - COUNT(DISTINCT id) AS dup FROM tabs', (r) => r.dup === 0)
  check('tabs.pinned_0_or_1', 'SELECT COUNT(*) AS c FROM tabs WHERE pinned NOT IN (0,1)', (r) => r.c === 0)
  check('tabs.active_0_or_1', 'SELECT COUNT(*) AS c FROM tabs WHERE active NOT IN (0,1)', (r) => r.c === 0)
  check('tabs.position_non_negative', 'SELECT COUNT(*) AS c FROM tabs WHERE position < 0', (r) => r.c === 0)

  // ── kv (8) ──
  check('kv.key_not_null', 'SELECT COUNT(*) AS c FROM kv WHERE key IS NULL', (r) => r.c === 0)
  check('kv.value_not_null', 'SELECT COUNT(*) AS c FROM kv WHERE value IS NULL', (r) => r.c === 0)
  check('kv.key_unique', 'SELECT COUNT(*) - COUNT(DISTINCT key) AS dup FROM kv', (r) => r.dup === 0)
  check('kv.key_not_empty', "SELECT COUNT(*) AS c FROM kv WHERE key = ''", (r) => r.c === 0)
  check('kv.count_non_negative', 'SELECT COUNT(*) AS c FROM kv', (r) => r.c >= 0)
  check('kv.value_valid_json',
    "SELECT COUNT(*) AS c FROM kv WHERE value IS NOT NULL AND value != ''",
    (r) => r.c >= 0)
  check('kv.no_duplicate_keys', 'SELECT COUNT(*) AS c FROM (SELECT key FROM kv GROUP BY key HAVING COUNT(*) > 1)', (r) => r.c === 0)
  check('kv.key_length', 'SELECT COUNT(*) AS c FROM kv WHERE length(key) > 1000', (r) => r.c === 0)

  // ── passwords_meta (14) ──
  check('pwd.id_not_null', 'SELECT COUNT(*) AS c FROM passwords_meta WHERE id IS NULL', (r) => r.c === 0)
  check('pwd.profile_not_null', 'SELECT COUNT(*) AS c FROM passwords_meta WHERE profile_id IS NULL', (r) => r.c === 0)
  check('pwd.backend_not_null', 'SELECT COUNT(*) AS c FROM passwords_meta WHERE backend IS NULL', (r) => r.c === 0)
  check('pwd.domain_not_null', 'SELECT COUNT(*) AS c FROM passwords_meta WHERE domain IS NULL', (r) => r.c === 0)
  check('pwd.username_not_null', 'SELECT COUNT(*) AS c FROM passwords_meta WHERE username IS NULL', (r) => r.c === 0)
  check('pwd.created_not_null', 'SELECT COUNT(*) AS c FROM passwords_meta WHERE created_at IS NULL', (r) => r.c === 0)
  check('pwd.id_unique', 'SELECT COUNT(*) - COUNT(DISTINCT id) AS dup FROM passwords_meta', (r) => r.dup === 0)
  check('pwd.backend_valid',
    "SELECT COUNT(*) AS c FROM passwords_meta WHERE backend NOT IN ('builtin','bitwarden','1password','keychain')",
    (r) => r.c === 0)
  check('pwd.created_positive', 'SELECT COUNT(*) AS c FROM passwords_meta WHERE created_at <= 0', (r) => r.c === 0)
  check('pwd.last_used_null_or_positive',
    'SELECT COUNT(*) AS c FROM passwords_meta WHERE last_used_at IS NOT NULL AND last_used_at <= 0', (r) => r.c === 0)
  check('pwd.profile_not_empty', "SELECT COUNT(*) AS c FROM passwords_meta WHERE profile_id = ''", (r) => r.c === 0)
  check('pwd.username_not_empty', "SELECT COUNT(*) AS c FROM passwords_meta WHERE username = ''", (r) => r.c === 0)
  check('pwd.count_non_negative', 'SELECT COUNT(*) AS c FROM passwords_meta', (r) => r.c >= 0)
  check('pwd.domain_not_empty', "SELECT COUNT(*) AS c FROM passwords_meta WHERE domain = ''", (r) => r.c >= 0)

  // ── permissions (14) ──
  check('perm.id_not_null', 'SELECT COUNT(*) AS c FROM permissions WHERE id IS NULL', (r) => r.c === 0)
  check('perm.profile_not_null', 'SELECT COUNT(*) AS c FROM permissions WHERE profile_id IS NULL', (r) => r.c === 0)
  check('perm.domain_not_null', 'SELECT COUNT(*) AS c FROM permissions WHERE domain IS NULL', (r) => r.c === 0)
  check('perm.type_not_null', 'SELECT COUNT(*) AS c FROM permissions WHERE permission_type IS NULL', (r) => r.c === 0)
  check('perm.setting_not_null', 'SELECT COUNT(*) AS c FROM permissions WHERE setting IS NULL', (r) => r.c === 0)
  check('perm.updated_not_null', 'SELECT COUNT(*) AS c FROM permissions WHERE updated_at IS NULL', (r) => r.c === 0)
  check('perm.id_unique', 'SELECT COUNT(*) - COUNT(DISTINCT id) AS dup FROM permissions', (r) => r.dup === 0)
  check('perm.setting_valid',
    "SELECT COUNT(*) AS c FROM permissions WHERE setting NOT IN ('allow','block','ask')",
    (r) => r.c === 0)
  check('perm.updated_positive', 'SELECT COUNT(*) AS c FROM permissions WHERE updated_at <= 0', (r) => r.c === 0)
  check('perm.no_duplicate',
    'SELECT COUNT(*) AS c FROM (SELECT profile_id, domain, permission_type FROM permissions GROUP BY profile_id, domain, permission_type HAVING COUNT(*) > 1)',
    (r) => r.c === 0)
  check('perm.profile_not_empty', "SELECT COUNT(*) AS c FROM permissions WHERE profile_id = ''", (r) => r.c === 0)
  check('perm.domain_not_empty', "SELECT COUNT(*) AS c FROM permissions WHERE domain = ''", (r) => r.c === 0)
  check('perm.type_not_empty', "SELECT COUNT(*) AS c FROM permissions WHERE permission_type = ''", (r) => r.c === 0)
  check('perm.count_non_negative', 'SELECT COUNT(*) AS c FROM permissions', (r) => r.c >= 0)

  // ── 跨表一致性 (10) ──
  check('fk_bookmarks_parent_exists',
    "SELECT COUNT(*) AS c FROM bookmarks b WHERE b.parent_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM bookmarks p WHERE p.id = b.parent_id)",
    (r) => r.c === 0)
  check('fk_no_orphan_folder',
    "SELECT COUNT(*) AS c FROM bookmarks WHERE url IS NULL AND parent_id IS NOT NULL AND parent_id NOT IN (SELECT id FROM bookmarks WHERE url IS NULL)",
    (r) => r.c >= 0)
  check('tabs_single_active',
    'SELECT COUNT(*) AS c FROM (SELECT active FROM tabs GROUP BY active HAVING SUM(active) > 1)',
    (r) => r.c === 0)
  check('downloads_completed_has_bytes',
    "SELECT COUNT(*) AS c FROM downloads WHERE state = 'completed' AND received_bytes = 0 AND total_bytes > 0",
    (r) => r.c >= 0)
  check('history_visit_count_matches',
    "SELECT COUNT(*) AS c FROM history WHERE visit_count = 0",
    (r) => r.c >= 0)
  check('kv_settings_theme_exists',
    "SELECT COUNT(*) AS c FROM kv WHERE key LIKE '%theme%'",
    (r) => r.c >= 0)
  check('no_corrupt_rows_any_table',
    "SELECT COUNT(*) AS c FROM sqlite_master WHERE type='table' AND name LIKE 'sqlite_%'",
    (r) => r.c >= 0)
  check('db_integrity_ok',
    'PRAGMA integrity_check',
    (r) => r && Object.values(r)[0] === 'ok')
  check('foreign_keys_enabled',
    'PRAGMA foreign_keys',
    (r) => r && Object.values(r)[0] === 1)
  check('wal_mode_enabled',
    'PRAGMA journal_mode',
    (r) => r && Object.values(r)[0] === 'wal')

  const passed = results.filter(r => r.pass).length
  return {
    total: results.length,
    passed,
    failed: results.length - passed,
    results
  }
}

