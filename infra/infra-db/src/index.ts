import Database from 'better-sqlite3'
import fs from 'node:fs'
import path from 'node:path'
import { drizzle, type BetterSQLite3Database } from 'drizzle-orm/better-sqlite3'
import * as schema from './schema'

export { schema }

export type SqliteHandle = Database.Database
export type AppDatabase = BetterSQLite3Database<typeof schema>

export interface SqliteOptions {
  busyTimeoutMs?: number
}

export interface SchemaMigration {
  id: string
  up: (sqlite: SqliteHandle) => void
  description?: string
}

export interface MigrationLogger {
  info?: (message: string) => void
  warn?: (message: string, ...args: unknown[]) => void
  error?: (message: string, ...args: unknown[]) => void
}

export interface MigrationResult {
  applied: string[]
  skipped: string[]
  failed: Array<{ id: string; error: string }>
}

export interface DbHandle {
  sqlite: SqliteHandle
  db: AppDatabase
  hasFts: boolean
  hasPageTextFts: boolean
  migrate(migrations: SchemaMigration[]): MigrationResult
  close(): void
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

export function createSqlite(dbPath: string, options: SqliteOptions = {}): SqliteHandle {
  const sqlite = new Database(dbPath, {
    timeout: options.busyTimeoutMs ?? 3000
  })

  sqlite.pragma('foreign_keys = ON')
  sqlite.pragma('journal_mode = WAL')
  sqlite.pragma('synchronous = NORMAL')
  sqlite.pragma(`busy_timeout = ${options.busyTimeoutMs ?? 3000}`)

  return sqlite
}

/**
 * 建表 SQL — 与 schema.js 的 Drizzle 表定义一一对应
 * 使用 CREATE TABLE IF NOT EXISTS，已存在的表不会被重建
 *
 * ── L2（PART16）：拆成「全局」与「按 profile」两份 DDL ──────────────────
 * 物理独立后每个 profile 有自己的库文件，两类数据必须分开建表：
 *   · `GLOBAL_SCHEMA_DDL`  → `userData/global.db`：`profiles`（枚举所有 profile）
 *     与 `kv`（无 profile_id 的全局键值）。这两张表**不属于任何用户**。
 *   · `PROFILE_SCHEMA_DDL` → `userData/profiles/<id>/hira.db`：该用户自己的业务数据。
 * `SCHEMA_DDL` 仍是两者的拼接，供**单库模式**（升级前 / 回退路径）逐字沿用 ——
 * 单库模式下 `createDb()` 行为与改造前完全一致。
 */
export const GLOBAL_SCHEMA_DDL = `
CREATE TABLE IF NOT EXISTS kv (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS profiles (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  icon TEXT NOT NULL DEFAULT 'carbon:home',
  color TEXT,
  created_at INTEGER NOT NULL,
  last_active_at INTEGER,
  is_active INTEGER NOT NULL DEFAULT 0,
  internal INTEGER NOT NULL DEFAULT 0,
  ephemeral INTEGER NOT NULL DEFAULT 0
);
`

/**
 * 插件键值存储（插件开放 API 的**唯一**持久化落点）。
 *
 * 为什么不复用 `kv`：kv 是全局库、不按 profile 分区，插件数据会跨档案串味；
 * 为什么不走 `settings`：settings 有 schema 校验，插件拿不到任意键。
 * 主键 `(profile_id, plugin_id, key)` 让"按插件隔离 / 按插件整体清除"都是一次索引扫描；
 * 卸载插件时 `DELETE WHERE plugin_id = ?` 即可（见 `main/plugin-storage.js`）。
 * 配额（每插件键数 / 单值大小 / 总量）在 `plugin-storage.js` 里强制，不靠表约束。
 *
 * 单独导出而不是只内联进 PROFILE_SCHEMA_DDL：`plugin-storage.js` 用它做一次
 * 幂等自愈（老库在代码升级前就打开过时，表可能还不存在）—— DDL 只该有一份。
 */
export const PLUGIN_STORAGE_DDL = `
CREATE TABLE IF NOT EXISTS plugin_storage (
  profile_id TEXT NOT NULL DEFAULT 'default',
  plugin_id TEXT NOT NULL,
  key TEXT NOT NULL,
  value TEXT NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (profile_id, plugin_id, key)
);
CREATE INDEX IF NOT EXISTS idx_plugin_storage_profile ON plugin_storage(profile_id, plugin_id);
`

/**
 * Layout Studio 文档表。
 *
 * 独立导出供 legacy 升级后的运行期幂等自愈使用：老 profile 库可能在本版本
 * 之前就已经打开过，PROFILE_SCHEMA_DDL 不会自动补新表。
 */
export const LAYOUT_SCHEMA_DDL = `
CREATE TABLE IF NOT EXISTS layout_documents (
  id TEXT PRIMARY KEY,
  profile_id TEXT NOT NULL,
  space_id TEXT NOT NULL DEFAULT '',
  name TEXT NOT NULL,
  kind TEXT NOT NULL DEFAULT 'custom',
  schema_version INTEGER NOT NULL,
  revision INTEGER NOT NULL DEFAULT 1,
  document_json TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_layout_documents_scope
  ON layout_documents(profile_id, space_id, updated_at);

CREATE TABLE IF NOT EXISTS layout_revisions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  layout_id TEXT NOT NULL,
  revision INTEGER NOT NULL,
  action TEXT NOT NULL,
  document_json TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  UNIQUE(layout_id, revision)
);
CREATE INDEX IF NOT EXISTS idx_layout_revisions_doc
  ON layout_revisions(layout_id, revision DESC);

CREATE TABLE IF NOT EXISTS layout_bindings (
  profile_id TEXT NOT NULL,
  space_id TEXT NOT NULL DEFAULT '',
  context TEXT NOT NULL DEFAULT 'default',
  layout_id TEXT NOT NULL,
  PRIMARY KEY(profile_id, space_id, context)
);
`

/** 按 profile 的业务表（每 profile 一个库时只建这一份）。 */
export const PROFILE_SCHEMA_DDL = `
CREATE TABLE IF NOT EXISTS bookmarks (
  id TEXT PRIMARY KEY,
  profile_id TEXT NOT NULL DEFAULT 'default',
  parent_id TEXT,
  title TEXT NOT NULL,
  url TEXT,
  favicon TEXT,
  tags TEXT,
  pinned INTEGER NOT NULL DEFAULT 0,
  pinned_order INTEGER NOT NULL DEFAULT 0,
  rail_pinned INTEGER NOT NULL DEFAULT 0,
  rail_pinned_order INTEGER NOT NULL DEFAULT 0,
  open_in_sidebar INTEGER NOT NULL DEFAULT 0,
  summary TEXT,
  summary_at INTEGER,
  sort_order INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  modified_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS history (
  id TEXT PRIMARY KEY,
  profile_id TEXT NOT NULL DEFAULT 'default',
  url TEXT NOT NULL,
  title TEXT,
  favicon TEXT,
  visit_count INTEGER NOT NULL DEFAULT 0,
  typed_count INTEGER NOT NULL DEFAULT 0,
  last_visit_at INTEGER NOT NULL,
  first_visit_at INTEGER NOT NULL
);

-- ── 逐次访问日志（E1 历史双表）：history = url 聚合，本表 = 每次访问 ──
CREATE TABLE IF NOT EXISTS history_visits (
  id TEXT PRIMARY KEY,
  profile_id TEXT NOT NULL DEFAULT 'default',
  history_id TEXT,
  url TEXT NOT NULL,
  title TEXT,
  transition TEXT DEFAULT 'link',
  visited_at INTEGER NOT NULL
);

-- E3 页面正文索引：每个 URL 一份抽取出来的正文纯文本（由 tab preload 上报）。
-- 与 history 分表（不同生命周期）；唯一键让「重访同一 URL」走 upsert 覆盖。
CREATE TABLE IF NOT EXISTS page_texts (
  id TEXT PRIMARY KEY,
  profile_id TEXT NOT NULL DEFAULT 'default',
  url TEXT NOT NULL,
  title TEXT,
  page_text TEXT NOT NULL DEFAULT '',
  updated_at INTEGER NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_page_texts_profile_url ON page_texts(profile_id, url);

CREATE TABLE IF NOT EXISTS downloads (
  id TEXT PRIMARY KEY,
  profile_id TEXT NOT NULL DEFAULT 'default',
  url TEXT NOT NULL,
  filename TEXT NOT NULL,
  file_path TEXT,
  total_bytes INTEGER,
  received_bytes INTEGER DEFAULT 0,
  state TEXT NOT NULL,
  mime_type TEXT,
  started_at INTEGER NOT NULL,
  completed_at INTEGER,
  danger TEXT,
  referrer_url TEXT,
  multi_threaded INTEGER DEFAULT 0,
  connections INTEGER DEFAULT 1
);

CREATE TABLE IF NOT EXISTS notes (
  id TEXT PRIMARY KEY,
  profile_id TEXT NOT NULL DEFAULT 'default',
  folder_id TEXT,
  title TEXT NOT NULL,
  content TEXT DEFAULT '',
  url TEXT,
  tags TEXT,
  color TEXT,
  pinned INTEGER NOT NULL DEFAULT 0,
  sort_order INTEGER NOT NULL DEFAULT 0,
  -- ── 集锦（经典 Edge Collections 完全体）字段 ──
  -- kind 是卡片的**身份**（note|page|image|snippet|ref），默认 'note' 让老笔记一字不变；
  -- asset_* 承载图片卡片的落盘资产与原始尺寸；ref_id/ref_mode 承载引用卡片；
  -- deleted_at 是回收站软删时间戳（NULL = 在册）。全部带默认值 → 老库 ALTER 后行为不变。
  kind TEXT NOT NULL DEFAULT 'note',
  source_title TEXT,
  asset_path TEXT,
  asset_mime TEXT,
  asset_width INTEGER DEFAULT 0,
  asset_height INTEGER DEFAULT 0,
  thumb_path TEXT,
  ref_id TEXT,
  ref_mode TEXT DEFAULT 'chip',
  deleted_at INTEGER,
  created_at INTEGER NOT NULL,
  modified_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS note_folders (
  id TEXT PRIMARY KEY,
  profile_id TEXT NOT NULL DEFAULT 'default',
  parent_id TEXT,
  name TEXT NOT NULL,
  sort_order INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
);

-- 集锦引用边（Edge Collections 的一环）：卡片 → 被引用卡片的**边**。
-- 单列成表而不在 notes 上挂字段，是因为「谁引用了它」的反链与「被引用几次」的计数
-- 都以 note_refs.to_note_id 为唯一入口；复合主键天然去重同一对 (from,to)。
-- 带 profile_id 的理由：档案导出/导入与拆库迁移都按 WHERE profile_id = ? 逐表取数据，
-- 缺这一列会让引用边**静默搬不过去**（导入后反链全丢）；卡片 id 全局唯一，故主键**不**并入 profile。
-- origin 区分边的**来源**（两条独立生命周期）：
--   'card'   —— 来自 kind='ref' 的引用卡（edge 由卡片的 ref_id 决定，卡片改了/删了才动）
--   'inline' —— 来自正文里的 hira-note://<id>（edge 由正文内容决定，正文一变就整体重建）
-- 必须区分：同一张卡既可能是引用卡、正文里又内联引用了同一目标；不区分来源就**无法安全地**
-- "正文改了只重建正文那份边"（会连引用卡的边一起误删）。复合主键仍是 (from,to)。
CREATE TABLE IF NOT EXISTS note_refs (
  profile_id TEXT NOT NULL DEFAULT 'default',
  from_note_id TEXT NOT NULL,
  to_note_id TEXT NOT NULL,
  origin TEXT NOT NULL DEFAULT 'card',
  created_at INTEGER NOT NULL,
  PRIMARY KEY (from_note_id, to_note_id)
);
CREATE INDEX IF NOT EXISTS idx_note_refs_to ON note_refs(to_note_id);

CREATE TABLE IF NOT EXISTS tabs (
  id TEXT PRIMARY KEY,
  url TEXT NOT NULL,
  title TEXT,
  favicon TEXT,
  position INTEGER NOT NULL,
  pinned INTEGER NOT NULL DEFAULT 0,
  active INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS totp_entries (
  id TEXT PRIMARY KEY,
  profile_id TEXT NOT NULL DEFAULT 'default',
  issuer TEXT NOT NULL DEFAULT '',
  account TEXT NOT NULL DEFAULT '',
  secret_cipher TEXT NOT NULL,
  algorithm TEXT NOT NULL DEFAULT 'SHA1',
  digits INTEGER NOT NULL DEFAULT 6,
  period INTEGER NOT NULL DEFAULT 30,
  type TEXT NOT NULL DEFAULT 'TOTP',
  counter INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS favicons (
  page_url TEXT NOT NULL,
  profile_id TEXT NOT NULL DEFAULT 'default',
  favicon_url TEXT,
  data TEXT,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (profile_id, page_url)
);

CREATE TABLE IF NOT EXISTS passwords_meta (
  id TEXT PRIMARY KEY,
  profile_id TEXT NOT NULL,
  backend TEXT NOT NULL,
  domain TEXT NOT NULL,
  username TEXT NOT NULL,
  backend_ref TEXT,
  encrypted_password TEXT,
  last_used_at INTEGER,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_passwords_meta_profile_domain ON passwords_meta(profile_id, domain);

CREATE TABLE IF NOT EXISTS passwords_never_save (
  id TEXT PRIMARY KEY,
  profile_id TEXT NOT NULL,
  domain TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_passwords_never_save_profile_domain ON passwords_never_save(profile_id, domain);

CREATE TABLE IF NOT EXISTS permissions (
  id TEXT PRIMARY KEY,
  profile_id TEXT NOT NULL,
  domain TEXT NOT NULL,
  permission_type TEXT NOT NULL,
  setting TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_permissions_unique ON permissions(profile_id, domain, permission_type);
CREATE INDEX IF NOT EXISTS idx_permissions_profile_type ON permissions(profile_id, permission_type);

CREATE TABLE IF NOT EXISTS search_history (
  id TEXT PRIMARY KEY,
  profile_id TEXT NOT NULL,
  query_text TEXT NOT NULL,
  hit_count INTEGER NOT NULL DEFAULT 1,
  last_used_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_search_history_profile ON search_history(profile_id, last_used_at);

-- 自定义 Bang：同一 profile 内 trigger 唯一（归一化后写入，比较即命中）。
CREATE TABLE IF NOT EXISTS custom_bangs (
  id TEXT PRIMARY KEY,
  profile_id TEXT NOT NULL DEFAULT 'default',
  trigger TEXT NOT NULL,
  title TEXT NOT NULL,
  url TEXT NOT NULL,
  show_suggestions INTEGER NOT NULL DEFAULT 1,
  hit_count INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_custom_bangs_profile_trigger ON custom_bangs(profile_id, trigger);
CREATE INDEX IF NOT EXISTS idx_custom_bangs_profile ON custom_bangs(profile_id);

-- 自定义搜索引擎：与 custom_bangs 同构（同一套存储实现），单独一张表便于各自演进。
CREATE TABLE IF NOT EXISTS custom_engines (
  id TEXT PRIMARY KEY,
  profile_id TEXT NOT NULL DEFAULT 'default',
  trigger TEXT NOT NULL,
  title TEXT NOT NULL,
  url TEXT NOT NULL,
  show_suggestions INTEGER NOT NULL DEFAULT 1,
  hit_count INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_custom_engines_profile_trigger ON custom_engines(profile_id, trigger);
CREATE INDEX IF NOT EXISTS idx_custom_engines_profile ON custom_engines(profile_id);

CREATE TABLE IF NOT EXISTS spaces (
  id TEXT NOT NULL,
  profile_id TEXT NOT NULL,
  name TEXT NOT NULL,
  icon TEXT NOT NULL DEFAULT '',
  bg_start_color TEXT NOT NULL DEFAULT '',
  bg_end_color TEXT NOT NULL DEFAULT '',
  "order" INTEGER NOT NULL DEFAULT 999,
  last_used INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (profile_id, id)
);
CREATE INDEX IF NOT EXISTS idx_spaces_profile_order ON spaces(profile_id, "order");

-- PWA 应用：一个 profile 下同一 start_url 唯一；appId 由 (profileId,startUrl) 确定性生成。
-- 资产目录 userData/profiles/<pid>/pwa/<appId>/，本表只存相对文件名。
CREATE TABLE IF NOT EXISTS pwa_apps (
  id TEXT PRIMARY KEY,
  profile_id TEXT NOT NULL DEFAULT 'default',
  name TEXT NOT NULL,
  short_name TEXT,
  start_url TEXT NOT NULL,
  scope TEXT,
  manifest_url TEXT,
  manifest_json TEXT,
  display TEXT NOT NULL DEFAULT 'standalone',
  theme_color TEXT,
  background_color TEXT,
  icon_path TEXT,
  icon_small_path TEXT,
  icon_ico_path TEXT,
  install_kind TEXT NOT NULL DEFAULT 'full',
  source TEXT NOT NULL DEFAULT 'manifest',
  session_partition TEXT,
  start_menu_shortcut TEXT,
  desktop_shortcut TEXT,
  run_on_startup INTEGER NOT NULL DEFAULT 0,
  window_state TEXT,
  update_state TEXT NOT NULL DEFAULT 'idle',
  last_checked_at INTEGER,
  last_launched_at INTEGER,
  launch_count INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_pwa_apps_profile_start_url ON pwa_apps(profile_id, start_url);
CREATE INDEX IF NOT EXISTS idx_pwa_apps_profile ON pwa_apps(profile_id);

-- Layout Studio 文档、revision 与 scope binding
${LAYOUT_SCHEMA_DDL}

-- 插件键值存储（说明见 PLUGIN_STORAGE_DDL）
${PLUGIN_STORAGE_DDL}`

/** 单库模式的全量 DDL = 全局 DDL + 按 profile DDL（升级前 / 回退路径逐字沿用）。 */
export const SCHEMA_DDL = `${GLOBAL_SCHEMA_DDL}\n${PROFILE_SCHEMA_DDL}`

/**
 * 幂等添加列：若列已存在则静默跳过（SQLite 不支持 IF NOT EXISTS for ADD COLUMN）
 * @param {import('better-sqlite3').Database} sqlite
 * @param {string} table
 * @param {string} column
 * @param {string} definition  e.g. 'TEXT' / 'INTEGER DEFAULT 0'
 */
function addColumnIfMissing(sqlite: SqliteHandle, table: string, column: string, definition: string): void {
  try {
    // 检查列是否已存在：查 pragma table_info
    const cols = sqlite.pragma(`table_info(${table})`)
    if (Array.isArray(cols) && cols.some(c => c.name === column)) return
    sqlite.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`)
  } catch (e) {
    // 列已存在或其他错误 → 静默
  }
}

/**
 * favicons 的 key 里带页面 URL（= 访问记录），必须按 profile 分区，
 * 因此主键要从 `page_url` 单列升级为 `(profile_id, page_url)` 复合。
 * SQLite 不支持改主键 → 只能「建新表 → 拷数据（老数据归 default）→ 换名」重建一次。
 * 已是复合主键则原样返回（幂等）。
 * @param {import('better-sqlite3').Database} sqlite
 */
function ensureFaviconsProfilePk(sqlite: SqliteHandle): void {
  try {
    const cols = sqlite.pragma('table_info(favicons)') as Array<{ name: string; pk: number }>
    if (!Array.isArray(cols) || cols.length === 0) return
    const pkCols = cols.filter((c) => c.pk > 0).map((c) => c.name)
    if (pkCols.length === 2 && pkCols.indexOf('profile_id') !== -1) return

    const hasProfileCol = cols.some((c) => c.name === 'profile_id')
    sqlite.exec('BEGIN')
    sqlite.exec(`
      CREATE TABLE favicons_migrated (
        page_url TEXT NOT NULL,
        profile_id TEXT NOT NULL DEFAULT 'default',
        favicon_url TEXT,
        data TEXT,
        updated_at INTEGER NOT NULL,
        PRIMARY KEY (profile_id, page_url)
      );
    `)
    sqlite.exec(`
      INSERT OR IGNORE INTO favicons_migrated (page_url, profile_id, favicon_url, data, updated_at)
      SELECT page_url, ${hasProfileCol ? "COALESCE(NULLIF(profile_id, ''), 'default')" : "'default'"}, favicon_url, data, updated_at
      FROM favicons;
      DROP TABLE favicons;
      ALTER TABLE favicons_migrated RENAME TO favicons;
    `)
    sqlite.exec('COMMIT')
  } catch (e) {
    try { sqlite.exec('ROLLBACK') } catch (_) {}
    console.warn('[infra-db] favicons profile 主键迁移跳过:', errorMessage(e))
  }
}

/**
 * profile 分区索引：按 profile 取书签/历史/下载是本仓库最热的查询形态，
 * 单列索引即可把「切 profile 后列表」从全表扫描降到索引区间扫描。
 * 必须在列补齐之后执行（老库 ALTER 出来的列没有索引）。
 * @param {import('better-sqlite3').Database} sqlite
 */
function ensureProfileIndexes(sqlite: SqliteHandle): void {
  const DDL = `
    CREATE INDEX IF NOT EXISTS idx_bookmarks_profile ON bookmarks(profile_id, parent_id, sort_order);
    CREATE INDEX IF NOT EXISTS idx_history_profile_time ON history(profile_id, last_visit_at);
    -- 逐次访问日志（E1）：按 profile+时间取最近访问（游标分页），按 history 聚合取单站点记录
    CREATE INDEX IF NOT EXISTS idx_history_visits_profile_time ON history_visits(profile_id, visited_at);
    CREATE INDEX IF NOT EXISTS idx_history_visits_history ON history_visits(history_id, visited_at);
    CREATE INDEX IF NOT EXISTS idx_downloads_profile_time ON downloads(profile_id, started_at);
    CREATE INDEX IF NOT EXISTS idx_notes_profile_folder ON notes(profile_id, folder_id, sort_order);
    CREATE INDEX IF NOT EXISTS idx_note_folders_profile ON note_folders(profile_id, parent_id, sort_order);
    -- 验证器条目按 profile 取列表（列表按 created_at 倒序，见 domain-totp）
    CREATE INDEX IF NOT EXISTS idx_totp_entries_profile ON totp_entries(profile_id, created_at);
  `
  try {
    sqlite.exec(DDL)
  } catch (e) {
    console.warn('[infra-db] profile 索引创建跳过:', errorMessage(e))
  }
}

/**
 * 历史「一条 URL 一行」的强约束（对齐 Chromium 的 `urls` 表）。
 *
 * 为什么必须有：历史身份的现代口径就是「规范化 URL = 一行聚合」，
 * 刷新 / 重复导航只涨访问次数。唯一索引把这个不变式交给数据库兜底，
 * 上层（domain / 导入）就算某天写漏了也不会在列表里裂成好几条。
 *
 * 老库里可能残留同一 `(profile_id, url)` 的多行（口径变更前或旧版迁移写入）。
 * `CREATE UNIQUE INDEX` 遇到重复会直接失败、约束就永远缺席 —— 所以先做一次性合并：
 *   · keeper = 最近访问（并列取访问次数更大、再取 id 字典序最小）；
 *   · visit_count / typed_count 求和，first / last 取极值，标题 / 图标 keeper 优先；
 *   · `history_visits` 改挂 keeper，再删掉重复行。
 * 只在「确有重复」时执行，正常库是 0 组 → 启动零成本。
 * @param {import('better-sqlite3').Database} sqlite
 */
function ensureHistoryUrlUnique(sqlite: SqliteHandle): void {
  try {
    const dupGroups = sqlite.prepare(`
      SELECT profile_id AS profileId, url AS url, COUNT(*) AS n
      FROM history
      GROUP BY profile_id, url
      HAVING n > 1
    `).all() as Array<{ profileId: string; url: string; n: number }>

    if (dupGroups.length > 0) {
      const selectRows = sqlite.prepare(`
        SELECT id, visit_count, typed_count, first_visit_at, last_visit_at, title, favicon
        FROM history WHERE profile_id = ? AND url = ?
        ORDER BY last_visit_at DESC, visit_count DESC, id ASC
      `)
      const updateKeeper = sqlite.prepare(`
        UPDATE history
        SET visit_count = ?, typed_count = ?, first_visit_at = ?, last_visit_at = ?, title = ?, favicon = ?
        WHERE id = ?
      `)
      const repointVisits = sqlite.prepare('UPDATE history_visits SET history_id = ? WHERE history_id = ?')
      const deleteRow = sqlite.prepare('DELETE FROM history WHERE id = ?')

      sqlite.transaction((groups: Array<{ profileId: string; url: string; n: number }>) => {
        for (const group of groups) {
          const rows = selectRows.all(group.profileId, group.url) as Array<{
            id: string
            visit_count: number
            typed_count: number
            first_visit_at: number | null
            last_visit_at: number
            title: string | null
            favicon: string | null
          }>
          if (rows.length < 2) continue
          const keeper = rows[0]
          let visitCount = 0
          let typedCount = 0
          let firstVisitAt = Infinity
          let lastVisitAt = 0
          let title: string | null = keeper.title
          let favicon: string | null = keeper.favicon
          for (const row of rows) {
            visitCount += row.visit_count || 0
            typedCount += row.typed_count || 0
            const first = row.first_visit_at || row.last_visit_at || 0
            if (first && first < firstVisitAt) firstVisitAt = first
            if ((row.last_visit_at || 0) > lastVisitAt) lastVisitAt = row.last_visit_at || 0
            if (!title && row.title) title = row.title
            if (!favicon && row.favicon) favicon = row.favicon
          }
          updateKeeper.run(
            visitCount,
            typedCount,
            Number.isFinite(firstVisitAt) ? firstVisitAt : keeper.first_visit_at,
            lastVisitAt || keeper.last_visit_at,
            title,
            favicon,
            keeper.id
          )
          for (const row of rows) {
            if (row.id === keeper.id) continue
            repointVisits.run(keeper.id, row.id)
            deleteRow.run(row.id)
          }
        }
      })(dupGroups)
    }

    sqlite.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_history_profile_url ON history(profile_id, url)')
  } catch (e) {
    // 建不上索引不能拖垮启动：上面的合并失败时下一轮启动会重试。
    console.warn('[infra-db] history 唯一索引跳过:', errorMessage(e))
  }
}

/**
 * 全局库（`global.db`）的建表 + 幂等补列：只涉及 `profiles` / `kv`。
 * @param {import('better-sqlite3').Database} sqlite
 */
export function ensureGlobalSchema(sqlite: SqliteHandle): void {
  sqlite.exec(GLOBAL_SCHEMA_DDL)
  // ── Profile 内部/临时标记（老库补列）：internal / ephemeral ──
  addColumnIfMissing(sqlite, 'profiles', 'internal', 'INTEGER NOT NULL DEFAULT 0')
  addColumnIfMissing(sqlite, 'profiles', 'ephemeral', 'INTEGER NOT NULL DEFAULT 0')
}

/**
 * 按 profile 的库（`profiles/<id>/hira.db`）的建表 + 补列 + 索引 + FTS。
 * 这是一整套业务表 —— **不含 `profiles` / `kv`**（它们属于全局库）。
 * @param {import('better-sqlite3').Database} sqlite
 */
export function ensureProfileSchema(sqlite: SqliteHandle): void {
  sqlite.exec(PROFILE_SCHEMA_DDL)
  // ── 幂等列迁移：旧数据库已存在 downloads 表但缺少新增列 ──
  addColumnIfMissing(sqlite, 'downloads', 'referrer_url', 'TEXT')
  addColumnIfMissing(sqlite, 'downloads', 'multi_threaded', 'INTEGER DEFAULT 0')
  addColumnIfMissing(sqlite, 'downloads', 'connections', 'INTEGER DEFAULT 1')
  // ── 书签现代化（老库补列）：tags / pinned / pinned_order / sort_order ──
  addColumnIfMissing(sqlite, 'bookmarks', 'tags', 'TEXT')
  addColumnIfMissing(sqlite, 'bookmarks', 'pinned', 'INTEGER NOT NULL DEFAULT 0')
  addColumnIfMissing(sqlite, 'bookmarks', 'pinned_order', 'INTEGER NOT NULL DEFAULT 0')
  // 固定到 rail（侧栏图标栏）：与"固定到书签栏"（pinned）是**两个独立的固定位** ——
  // 书签栏是横向一条、rail 是纵向一列，用户可能只想固定到其中一个。
  addColumnIfMissing(sqlite, 'bookmarks', 'rail_pinned', 'INTEGER NOT NULL DEFAULT 0')
  // rail 固定区**自己的**排序（与 pinned_order 无关：两个固定位各有各的顺序）。
  // 老库补列后全为 0 → 排序回落到 created_at（= 加入顺序，即改动前的表现），
  // 用户第一次拖动才写入显式顺序，不需要额外的数据迁移。
  addColumnIfMissing(sqlite, 'bookmarks', 'rail_pinned_order', 'INTEGER NOT NULL DEFAULT 0')
  // 「默认在独立侧栏打开」：书签自己的打开偏好（点击去向规则读它，见 ui-common#bookmark-open）
  addColumnIfMissing(sqlite, 'bookmarks', 'open_in_sidebar', 'INTEGER NOT NULL DEFAULT 0')
  // 收藏摘要：NULL = 从未生成。两列成对写入（有摘要必有时间），
  // 「是否过期」判定读 summary_at，不另设 0 / '' 的空态。
  addColumnIfMissing(sqlite, 'bookmarks', 'summary', 'TEXT')
  addColumnIfMissing(sqlite, 'bookmarks', 'summary_at', 'INTEGER')
  // 展示用短名（N11）：老库补列，默认 NULL = 回落到 title（与加列前行为逐字一致）。
  addColumnIfMissing(sqlite, 'bookmarks', 'nickname', 'TEXT')
  // 手动输入地址栏的次数（E1）：老库补列后全为 0 = "从未手动输入"，权重口径与改动前一致。
  addColumnIfMissing(sqlite, 'history', 'typed_count', 'INTEGER NOT NULL DEFAULT 0')
  // 同父级内排序（拖拽重排）。老库补列后全为 0 → 排序回落到 created_at，即"原样不动"，
  // 用户第一次拖动才写入显式顺序，不需要额外的数据迁移。
  addColumnIfMissing(sqlite, 'bookmarks', 'sort_order', 'INTEGER NOT NULL DEFAULT 0')
  // ── 笔记现代化（老库补列）：文件夹 / 来源 / 标签 / 颜色 / 置顶 / 排序 ──
  // 默认值让既有笔记自动落到「根级 + 未置顶 + 顺序 0」，排序回落到 created_at，
  // 即"原样不动"；用户首次拖动才写入显式顺序（与书签同一套口径）。
  addColumnIfMissing(sqlite, 'notes', 'folder_id', 'TEXT')
  addColumnIfMissing(sqlite, 'notes', 'url', 'TEXT')
  addColumnIfMissing(sqlite, 'notes', 'tags', 'TEXT')
  addColumnIfMissing(sqlite, 'notes', 'color', 'TEXT')
  addColumnIfMissing(sqlite, 'notes', 'pinned', 'INTEGER NOT NULL DEFAULT 0')
  addColumnIfMissing(sqlite, 'notes', 'sort_order', 'INTEGER NOT NULL DEFAULT 0')
  // ── 集锦（经典 Edge Collections 完全体）老库补列 ──
  // 默认值让既有笔记自动落成 kind='note' 且 deleted_at 为 NULL（未删除），
  // 行为与加列前**一字不变**；asset_* / ref_* / thumb_path 默认为空 = 老笔记没有这些属性。
  addColumnIfMissing(sqlite, 'notes', 'kind', "TEXT NOT NULL DEFAULT 'note'")
  addColumnIfMissing(sqlite, 'notes', 'source_title', 'TEXT')
  addColumnIfMissing(sqlite, 'notes', 'asset_path', 'TEXT')
  addColumnIfMissing(sqlite, 'notes', 'asset_mime', 'TEXT')
  addColumnIfMissing(sqlite, 'notes', 'asset_width', 'INTEGER DEFAULT 0')
  addColumnIfMissing(sqlite, 'notes', 'asset_height', 'INTEGER DEFAULT 0')
  addColumnIfMissing(sqlite, 'notes', 'thumb_path', 'TEXT')
  addColumnIfMissing(sqlite, 'notes', 'ref_id', 'TEXT')
  addColumnIfMissing(sqlite, 'notes', 'ref_mode', "TEXT DEFAULT 'chip'")
  addColumnIfMissing(sqlite, 'notes', 'deleted_at', 'INTEGER')
  // note_refs 的 profile 列（老库补列）：本会话早前版本建出的 note_refs 没有 profile_id，
  // 补上后档案导出/导入与拆库迁移才能按 `WHERE profile_id = ?` 取到引用边；
  // NOT NULL DEFAULT 让已有边自动归 'default'（单库模式下正是它们该在的位置）。
  addColumnIfMissing(sqlite, 'note_refs', 'profile_id', "TEXT NOT NULL DEFAULT 'default'")
  // note_refs 的 origin 列（老库补列）：老库既有的边没有来源信息，一律按 'card' 算最安全 ——
  // 它们不会被任何一次正文编辑的「重建 inline 边」带走（宁可少删，不可误删）。
  addColumnIfMissing(sqlite, 'note_refs', 'origin', "TEXT NOT NULL DEFAULT 'card'")
  // ── Profile 分区（老库补列）：既有数据统一归 default profile ──
  // 物理独立后每库只有一个 profile，这一列**冗余但保留**（无害，且便于"单库模式"回退）。
  // NOT NULL DEFAULT 会让已存在的行自动取 'default'，因此无需 UPDATE 回填。
  addColumnIfMissing(sqlite, 'notes', 'profile_id', "TEXT NOT NULL DEFAULT 'default'")
  addColumnIfMissing(sqlite, 'bookmarks', 'profile_id', "TEXT NOT NULL DEFAULT 'default'")
  addColumnIfMissing(sqlite, 'history', 'profile_id', "TEXT NOT NULL DEFAULT 'default'")
  addColumnIfMissing(sqlite, 'downloads', 'profile_id', "TEXT NOT NULL DEFAULT 'default'")
  addColumnIfMissing(sqlite, 'favicons', 'profile_id', "TEXT NOT NULL DEFAULT 'default'")
  // favicons 的主键升级要重建表（上面的 ADD COLUMN 只是让重建的 SELECT 列齐）
  ensureFaviconsProfilePk(sqlite)
  ensureProfileIndexes(sqlite)
  // ── 历史「一条 URL 一行」：先合并老库残留的重复行，再建唯一索引 ──
  ensureHistoryUrlUnique(sqlite)
  // ── FTS5 全文索引（书签搜索）：可选能力，不支持时优雅降级为 LIKE ──
  ensureBookmarkFts(sqlite)
  // ── FTS5 全文索引（E3 页面正文）：同上，独立探测、独立降级 ──
  ensurePageTextFts(sqlite)
}

/**
 * 确保所有 schema 表存在（**单库模式**）：全局 + 按 profile 两份都跑。
 * 在 createDb 时自动调用，使用 CREATE TABLE IF NOT EXISTS，安全幂等；
 * 对旧数据库还会幂等地补齐新增列（ALTER TABLE ADD COLUMN）。
 * @param {import('better-sqlite3').Database} sqlite
 */
export function ensureSchema(sqlite: SqliteHandle): void {
  ensureGlobalSchema(sqlite)
  ensureProfileSchema(sqlite)
}

/**
 * FTS5 可用性标志（ensureSchema 后读取；domain 层据此选查询路径）
 */
let hasBookmarkFts = false

/**
 * 书签 FTS5 虚拟表 + 同步触发器。
 * content-linked（content='bookmarks'）：正文存主表，FTS 只存倒排索引，
 * 不翻倍磁盘占用；INSERT/UPDATE/DELETE 三个触发器保证与主表强一致。
 *
 * FTS5 不是所有 better-sqlite3 构建都带 —— 失败时静默跳过，
 * 由 hasFts 标志位告诉上层走 LIKE 兜底，绝不让启动失败。
 * @param {import('better-sqlite3').Database} sqlite
 */
function ensureBookmarkFts(sqlite: SqliteHandle): void {
  try {
    sqlite.exec(`
      CREATE VIRTUAL TABLE IF NOT EXISTS bookmarks_fts USING fts5(
        title, url, tags,
        content='bookmarks', content_rowid='rowid',
        tokenize='unicode61'
      );

      CREATE TRIGGER IF NOT EXISTS bookmarks_fts_insert AFTER INSERT ON bookmarks BEGIN
        INSERT INTO bookmarks_fts(rowid, title, url, tags)
        VALUES (new.rowid, new.title, new.url, new.tags);
      END;

      CREATE TRIGGER IF NOT EXISTS bookmarks_fts_delete AFTER DELETE ON bookmarks BEGIN
        INSERT INTO bookmarks_fts(bookmarks_fts, rowid, title, url, tags)
        VALUES ('delete', old.rowid, old.title, old.url, old.tags);
      END;

      CREATE TRIGGER IF NOT EXISTS bookmarks_fts_update AFTER UPDATE ON bookmarks BEGIN
        INSERT INTO bookmarks_fts(bookmarks_fts, rowid, title, url, tags)
        VALUES ('delete', old.rowid, old.title, old.url, old.tags);
        INSERT INTO bookmarks_fts(rowid, title, url, tags)
        VALUES (new.rowid, new.title, new.url, new.tags);
      END;
    `)
    hasBookmarkFts = true
  } catch (e) {
    console.warn('[infra-db] FTS5 unavailable, bookmark search falls back to LIKE:', errorMessage(e))
    hasBookmarkFts = false
  }
}

/**
 * 页面正文 FTS5 虚拟表 + 同步触发器（E3）。
 *
 * 与 `bookmarks_fts` 完全同一套范式：content-linked（正文存主表，FTS 只存倒排索引），
 * 三个触发器保证与 page_texts 强一致；FTS5 不可用则静默跳过，由标志位让上层退回 LIKE。
 * 索引三列：`page_text`（正文，命中主体）/ `title` / `url`（标题与网址也顺带可搜）。
 * @param {import('better-sqlite3').Database} sqlite
 */
let hasPageTextFts = false
function ensurePageTextFts(sqlite: SqliteHandle): void {
  try {
    sqlite.exec(`
      CREATE VIRTUAL TABLE IF NOT EXISTS page_texts_fts USING fts5(
        page_text, title, url,
        content='page_texts', content_rowid='rowid',
        tokenize='unicode61'
      );

      CREATE TRIGGER IF NOT EXISTS page_texts_fts_insert AFTER INSERT ON page_texts BEGIN
        INSERT INTO page_texts_fts(rowid, page_text, title, url)
        VALUES (new.rowid, new.page_text, new.title, new.url);
      END;

      CREATE TRIGGER IF NOT EXISTS page_texts_fts_delete AFTER DELETE ON page_texts BEGIN
        INSERT INTO page_texts_fts(page_texts_fts, rowid, page_text, title, url)
        VALUES ('delete', old.rowid, old.page_text, old.title, old.url);
      END;

      CREATE TRIGGER IF NOT EXISTS page_texts_fts_update AFTER UPDATE ON page_texts BEGIN
        INSERT INTO page_texts_fts(page_texts_fts, rowid, page_text, title, url)
        VALUES ('delete', old.rowid, old.page_text, old.title, old.url);
        INSERT INTO page_texts_fts(rowid, page_text, title, url)
        VALUES (new.rowid, new.page_text, new.title, new.url);
      END;
    `)
    hasPageTextFts = true
  } catch (e) {
    console.warn('[infra-db] FTS5 unavailable, page-text search falls back to LIKE:', errorMessage(e))
    hasPageTextFts = false
  }
}


// ── 插件贡献的 schema 迁移（扩展点 `db.schema.migration`）──────────────────
//
// 内建的 `ensureSchema()` 只会「补列 / 建表 / 建索引」，它解决不了**数据改写**类
// 迁移（例如把某列的值整体重编码、拆表、回填新列）。这类迁移由插件贡献，
// 由本模块统一记账执行 —— **执行过就不再执行**（靠一张记账表，而不是靠"迁移自己写幂等"）。
//
// 记账表独立于业务表：`_schema_migrations(id TEXT PRIMARY KEY, applied_at INTEGER)`。
// 为什么必须记账而不能像内建那样靠 IF NOT EXISTS：内建的每一步都是天然幂等的 DDL；
// 插件迁移是**任意 SQL**，重放一次就可能把数据改两遍（如 UPDATE x = x + 1）。
//
// 迁移描述符：`{ id: string, up: (sqlite) => void, description?: string }`
//   · `id`  全局唯一且**顺序敏感**（按 id 字典序执行，作者用 `001-xxx` 这种前缀自排）
//   · `up`  收到裸 sqlite 句柄；抛错 → 该迁移回滚，其余迁移继续（互不影响）
const MIGRATIONS_TABLE = '_schema_migrations'

function ensureMigrationsTable(sqlite: SqliteHandle): boolean {
  try {
    sqlite.exec(`
      CREATE TABLE IF NOT EXISTS ${MIGRATIONS_TABLE} (
        id TEXT PRIMARY KEY,
        applied_at INTEGER NOT NULL
      );
    `)
    return true
  } catch (e) {
    console.warn('[infra-db] 迁移记账表创建失败:', errorMessage(e))
    return false
  }
}

/**
 * 执行插件贡献的 schema 迁移（幂等：已记账的跳过）。
 *
 * 每个迁移**各自一个事务** —— 而不是全部包在一个事务里。理由：迁移之间通常没有
 * 强依赖，一个坏迁移不应该让其余好迁移一起回滚（那会让"升级一次修好一个"变成
 * "永远升不上去"）。坏迁移被记录下来、下次启动还会再试一次（`id` 未记账）。
 *
 * @param {import('better-sqlite3').Database} sqlite
 * @param {Array<{ id?: string, up?: Function, description?: string }>} migrations
 * @param {{ info?: Function, warn?: Function, error?: Function }} [logger]
 * @returns {{ applied: string[], skipped: string[], failed: Array<{id:string,error:string}> }}
 */
export function applyMigrations(sqlite: SqliteHandle, migrations: SchemaMigration[], logger: MigrationLogger = console): MigrationResult {
  const applied: string[] = []
  const skipped: string[] = []
  const failed: Array<{ id: string; error: string }> = []
  const list = Array.isArray(migrations) ? migrations.filter(Boolean) : []
  if (list.length === 0) return { applied, skipped, failed }
  if (!ensureMigrationsTable(sqlite)) return { applied, skipped, failed }

  /** 已记账集合（一次读全，避免逐条 SELECT）。 */
  let done: Set<string>
  try {
    done = new Set((sqlite.prepare(`SELECT id FROM ${MIGRATIONS_TABLE}`).all() as Array<{ id: string }>).map((r) => r.id))
  } catch (_) {
    done = new Set()
  }

  // 顺序敏感：按 id 字典序，作者用 `001-`/`002-` 前缀自排。
  const ordered = list
    .filter((m) => m && typeof m.id === 'string' && m.id && typeof m.up === 'function')
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))

  const record = sqlite.prepare(`INSERT OR REPLACE INTO ${MIGRATIONS_TABLE} (id, applied_at) VALUES (?, ?)`)
  for (const m of ordered) {
    if (done.has(m.id)) {
      skipped.push(m.id)
      continue
    }
    try {
      sqlite.exec('BEGIN')
      m.up(sqlite)
      record.run(m.id, Date.now())
      sqlite.exec('COMMIT')
      applied.push(m.id)
      if (logger.info) logger.info(`[infra-db] 迁移已应用: ${m.id}`)
    } catch (e) {
      try { sqlite.exec('ROLLBACK') } catch (_) {}
      const message = errorMessage(e)
      failed.push({ id: m.id, error: message })
      if (logger.error) logger.error(`[infra-db] 迁移失败（已回滚，下次启动重试）: ${m.id} — ${message}`)
    }
  }
  return { applied, skipped, failed }
}

/**
 * 打开一个库文件并把句柄包成统一形状。
 * `ensureFn` 决定建哪一组表（全局 / 按 profile / 全量）—— 单库模式传 `ensureSchema`，
 * 物理独立后全局库传 `ensureGlobalSchema`、每 profile 库传 `ensureProfileSchema`。
 * @param {string} dbPath
 * @param {(sqlite: import('better-sqlite3').Database) => void} ensureFn
 * @param {object} [options]
 */
export function openDb(dbPath: string, ensureFn: (sqlite: SqliteHandle) => void, options: SqliteOptions = {}): DbHandle {
  const sqlite = createSqlite(dbPath, options)
  ensureFn(sqlite)
  const db = drizzle(sqlite, { schema })
  // 每个库各自探测一次 FTS5 可用性：同一构建下结果一致，但**按库记录**更诚实
  //（不把一个库的能力当成所有库的能力）。
  const ftsAvailable = hasBookmarkFts
  const pageTextFtsAvailable = hasPageTextFts

  return {
    sqlite,
    db,
    /** FTS5 全文索引是否可用（false → 书签搜索走 LIKE 兜底） */
    hasFts: ftsAvailable,
    /** E3：页面正文 FTS5 是否可用（false → 正文搜索走 LIKE 兜底） */
    hasPageTextFts: pageTextFtsAvailable,
    /** 内建 schema 之后，再执行一批迁移（`db.schema.migration` 插槽的产物）。 */
    migrate(migrations: SchemaMigration[]) {
      return applyMigrations(sqlite, migrations)
    },
    close() {
      try { sqlite.close() } catch (_) {}
    }
  }
}

export function createDb(dbPath: string, options: SqliteOptions = {}): DbHandle {
  return openDb(dbPath, ensureSchema, options)
}

/**
 * **只读**打开一个外部 SQLite 库（当前唯一用途：浏览器源库的副本）。
 *
 * 为什么单独开一个口而不是让调用方 `require('better-sqlite3')`：
 *   · 本仓只有 infra-db 声明了这个原生依赖，别处直接 require 会把「原生模块怎么装」
 *     的知识扩散到业务代码，打包时也容易漏 external；
 *   · `readonly + fileMustExist` 是**安全边界**：源库永远是副本，只读打开保证我们
 *     绝不可能写回别人的数据目录（`wal`/`shm` 也不会被创建）。
 *
 * 调用方仍然负责：先复制源库（含 `-wal`/`-shm`）到临时目录、用完 `close()` 并删临时目录。
 * @param {string} dbPath
 * @returns {import('better-sqlite3').Database}
 */
export function openReadonly(dbPath: string): SqliteHandle {
  return new Database(dbPath, { readonly: true, fileMustExist: true })
}

/**
 * 按 profile 开库的 **数据库提供者**（PART16 L2 步骤 1）。
 *
 * ── 它解决的问题 ──────────────────────────────────────────────────
 * 现状是「单库 + `profile_id` 列分区」。物理独立要求每个 profile 一个库文件，
 * 而 ~12 个域服务都是 `createXService(db, …)` —— 若让它们各自感知"当前是哪个库"，
 * 改动会散落到每个 domain 的每一处 `db.xxx`。
 *
 * ── 做法：一个随「当前 profile」路由的 db/sqlite 代理 ──────────────
 * 域服务照旧持有**同一个** `db` 对象；但它是代理，每次属性访问（`db.select` /
 * `db.insert` / `db.transaction` …）都现取"当前 profile 的库"。于是：
 *   · 域代码**零改动**（它们本来就在每次调用时才访问 db.xxx，不缓存语句）；
 *   · 切换 profile 时无需重建任何服务 —— 换的是代理背后的库。
 * 兜底：`profile_id` 列保留，查询照旧带它，因此单库模式与物理独立**同一条代码路径**。
 *
 * ── 两种模式（同一份实现的两种装配）───────────────────────────────
 *   · `mode: 'single'` —— 升级前 / 回退路径：`forProfile()` 与 `global()` 都返回
 *     `<rootDir>/hira.db` 这一个句柄，行为与改造前**逐字节一致**。
 *   · `mode: 'split'`  —— `global()` → `<rootDir>/global.db`（profiles / kv）；
 *     `forProfile(id)` → `<rootDir>/profiles/<id>/hira.db`（业务表）。
 * 两种模式都保留，是为了"迁移失败可回落"（§7 风险对策）。
 *
 * ── 连接生命周期 ──────────────────────────────────────────────────
 * 打开过的 profile 库**默认不自动关闭**（桌面端 profile 数量很少，关掉反而引入
 * "连接已关闭"这类竞态）。需要时用 `maxOpenProfiles` 开 LRU，或显式 `closeProfile`。
 * `evict` 永不关闭「当前 profile」的库。
 *
 * @param {{
 *   rootDir: string,
 *   profileDirOf: (profileId: string) => string,
 *   getProfileId?: () => string,
 *   mode?: 'single' | 'split',
 *   dbFileName?: string,
 *   globalDbFileName?: string,
 *   maxOpenProfiles?: number,
 *   logger?: object
 * }} options
 */
export interface CreateDbProviderOptions extends SqliteOptions {
  rootDir: string
  profileDirOf: (profileId: string) => string
  getProfileId?: () => string | null | undefined
  mode?: 'single' | 'split'
  dbFileName?: string
  globalDbFileName?: string
  maxOpenProfiles?: number
  logger?: MigrationLogger
}

export interface DbProvider {
  mode: 'single' | 'split'
  db: AppDatabase
  sqlite: SqliteHandle
  forProfile(profileId: string): DbHandle
  global(): DbHandle
  currentProfileId(): string
  setCurrent(profileId: string): void
  openProfileIds(): string[]
  readonly hasFts: boolean
  readonly hasPageTextFts: boolean
  migrate(migrations: SchemaMigration[]): MigrationResult
  closeProfile(profileId: string): void
  closeAll(): void
  legacy(): DbHandle | null
}

export function createDbProvider(options: CreateDbProviderOptions): DbProvider {
  const {
    rootDir,
    profileDirOf,
    getProfileId,
    mode = 'single',
    dbFileName = 'hira.db',
    globalDbFileName = 'global.db',
    maxOpenProfiles = 0,
    logger = console
  } = options
  if (!rootDir) throw new Error('[infra-db] createDbProvider 需要 rootDir')
  if (typeof profileDirOf !== 'function') throw new Error('[infra-db] createDbProvider 需要 profileDirOf 端口')

  /** 无 `getProfileId` 端口时的内部当前 profile（`setCurrent` 维护）。 */
  let fallbackCurrent = 'default'
  const profileHandles = new Map<string, DbHandle>()
  let legacyHandle: DbHandle | null = null
  let globalHandle: DbHandle | null = null
  /** 插件贡献的迁移（`db.schema.migration`）—— 记下来，新开的库也要补跑。 */
  const pendingMigrations: SchemaMigration[] = []
  const appliedMigrationIds = new Set<string>()

  function currentProfile(): string {
    if (typeof getProfileId === 'function') {
      try {
        const v = getProfileId()
        return v ? String(v) : 'default'
      } catch (_) {
        return 'default'
      }
    }
    return fallbackCurrent
  }

  function openLegacy(): DbHandle {
    if (!legacyHandle) {
      fs.mkdirSync(rootDir, { recursive: true })
      legacyHandle = createDb(path.join(rootDir, dbFileName), options)
      runPendingMigrations(legacyHandle)
    }
    return legacyHandle
  }

  function openGlobal(): DbHandle {
    if (!globalHandle) {
      fs.mkdirSync(rootDir, { recursive: true })
      globalHandle = openDb(path.join(rootDir, globalDbFileName), ensureGlobalSchema, options)
      runPendingMigrations(globalHandle)
    }
    return globalHandle
  }

  function openProfile(profileId: string): DbHandle {
    const id = String(profileId || 'default')
    const cached = profileHandles.get(id)
    if (cached) return cached
    const dir = profileDirOf(id)
    fs.mkdirSync(dir, { recursive: true })
    const handle = openDb(path.join(dir, dbFileName), ensureProfileSchema, options)
    profileHandles.set(id, handle)
    runPendingMigrations(handle)
    evictIfNeeded(id)
    return handle
  }

  /** 只把**没记过账**的迁移交给某个库（避免每次开库都重放整张表）。 */
  function runPendingMigrations(handle: DbHandle): void {
    const todo = pendingMigrations.filter((m) => m && m.id && !appliedMigrationIds.has(`${handleKey(handle)}:${m.id}`))
    if (!todo.length) return
    let result: MigrationResult
    try {
      result = handle.migrate(todo)
    } catch (e) {
      logger.warn?.('[infra-db] 迁移执行失败（非致命）:', errorMessage(e))
      return
    }
    for (const id of result.applied || []) appliedMigrationIds.add(`${handleKey(handle)}:${id}`)
    for (const item of result.failed || []) {
      logger.error && logger.error(`[infra-db] 迁移失败: ${item.id} — ${item.error}`)
    }
  }

  /** 句柄身份键（用于迁移记账；库对象本身没有 id）。 */
  const handleIds = new WeakMap<DbHandle, string>()
  let handleSeq = 0
  function handleKey(handle: DbHandle): string {
    if (!handleIds.has(handle)) handleIds.set(handle, `h${++handleSeq}`)
    return handleIds.get(handle) ?? `h${++handleSeq}`
  }

  /** LRU 上限（默认关闭）：只淘汰**非当前** profile 的库。 */
  function evictIfNeeded(keepId: string): void {
    if (!(maxOpenProfiles > 0)) return
    while (profileHandles.size > maxOpenProfiles) {
      let victim: string | null = null
      for (const id of profileHandles.keys()) {
        if (id === keepId || id === currentProfile()) continue
        victim = id
        break
      }
      if (!victim) return
      const handle = profileHandles.get(victim)
      profileHandles.delete(victim)
      if (handle) try { handle.close() } catch (_) {}
    }
  }

  function forProfile(profileId: string): DbHandle {
    return mode === 'single' ? openLegacy() : openProfile(profileId)
  }

  function global(): DbHandle {
    return mode === 'single' ? openLegacy() : openGlobal()
  }

  function currentHandle(): DbHandle {
    return forProfile(currentProfile())
  }

  /** 把一个句柄成员做成"每次访问都按当前 profile 解析"的代理。 */
  function makeRouter<T extends object>(member: 'db' | 'sqlite'): T {
    return new Proxy(
      {} as T,
      {
        get(_target, prop) {
          const owner = currentHandle()[member] as object
          const value = Reflect.get(owner, prop) as unknown
          return typeof value === 'function' ? value.bind(owner) : value
        },
        has(_target, prop) {
          return Reflect.has(currentHandle()[member] as object, prop)
        },
        set(_target, prop, value) {
          return Reflect.set(currentHandle()[member] as object, prop, value)
        }
      }
    )
  }

  const db = makeRouter<AppDatabase>('db')
  const sqlite = makeRouter<SqliteHandle>('sqlite')

  return {
    mode,
    db,
    sqlite,
    forProfile,
    global,
    /** 当前 profile（诊断 / 迁移用）。 */
    currentProfileId: currentProfile,
    setCurrent(profileId: string) {
      fallbackCurrent = String(profileId || 'default')
    },
    /** 已打开的 profile 库 id 列表（诊断 / 收尾用）。 */
    openProfileIds() {
      return Array.from(profileHandles.keys())
    },
    get hasFts() {
      return currentHandle().hasFts
    },
    /** E3：页面正文 FTS5 是否可用（同上，按当前库探测）。 */
    get hasPageTextFts() {
      return currentHandle().hasPageTextFts
    },
    /**
     * 插件贡献的 schema 迁移：记账后作用到**全部已开库**（全局 + 每个 profile），
     * 并记下来 —— 之后新开的库（新建 profile / 首次切换）会自动补跑。
     */
    migrate(migrations: SchemaMigration[]): MigrationResult {
      const list = Array.isArray(migrations) ? migrations.filter((m) => m && m.id && typeof m.up === 'function') : []
      const merged: MigrationResult = { applied: [], skipped: [], failed: [] }
      if (!list.length) return merged
      for (const m of list) {
        if (!pendingMigrations.some((x) => x.id === m.id)) pendingMigrations.push(m)
      }
      const handles = mode === 'single'
        ? [openLegacy()]
        : [openGlobal(), ...profileHandles.values()]
      for (const handle of handles) {
        const before = new Set<string>()
        for (const m of list) {
          if (appliedMigrationIds.has(`${handleKey(handle)}:${m.id}`)) before.add(m.id)
        }
        const todo = list.filter((m) => !before.has(m.id))
        if (!todo.length) continue
        const result = handle.migrate(todo)
        for (const id of result.applied || []) appliedMigrationIds.add(`${handleKey(handle)}:${id}`)
        merged.applied.push(...(result.applied || []))
        merged.skipped.push(...(result.skipped || []))
        merged.failed.push(...(result.failed || []))
      }
      return merged
    },
    closeProfile(profileId: string) {
      const id = String(profileId || 'default')
      const handle = profileHandles.get(id)
      if (!handle) return
      profileHandles.delete(id)
      try { handle.close() } catch (_) {}
    },
    closeAll() {
      for (const handle of profileHandles.values()) {
        try { handle.close() } catch (_) {}
      }
      profileHandles.clear()
      if (legacyHandle) { try { legacyHandle.close() } catch (_) {} legacyHandle = null }
      if (globalHandle) { try { globalHandle.close() } catch (_) {} globalHandle = null }
    },
    /** `createDb()` 的形状兼容口（单库模式的 legacy 句柄）。 */
    legacy() {
      return legacyHandle
    }
  }
}

