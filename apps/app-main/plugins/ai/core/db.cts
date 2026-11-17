/**
 * AI 引擎 · 存储层建表（PART15 §8）。
 *
 * 走的是**插件迁移插槽** `db.schema.migration`（`{ id, up(sqlite) }`）：主进程内核
 * 从不认识这些表 —— 插件被禁用 / 目录被删，表与数据仍然在（**数据默认保留**，
 * 见 §5.2「零残留」）。彻底移除是**另一条显式动作**（ai:purge，用户确认后 DROP）。
 *
 * 为什么不用 Drizzle / 变更文件：AI 的表全是"只追加的事件 + 少量配置"，
 * 一个 `CREATE TABLE IF NOT EXISTS` 的幂等迁移就够了；引入一套 ORM 变更链
 * 会把这个插件与核心的 schema 演进绑死，正好违背"删目录即消失"。
 *
 * ══════════════════════════════════════════════════════════════════════
 * 技能的单一真源 = 插件清单（manifest.contributes.skills）
 * ══════════════════════════════════════════════════════════════════════
 * 内置技能不再写进 `ai_skill`：它们由 `ai-skills-builtin` 插件贡献，
 * 升级改文案自动生效、插件被禁用自动消失，不需要任何对账代码。
 * 表里只留**用户自建**的技能；`ai_skill_state` 只存**单条启停**这种本地状态。
 */

const AI_TABLES = [
  'ai_usage',
  'ai_audit',
  'ai_skill',
  'ai_skill_state',
  'ai_ui_state',
  'ai_workspace',
  'ai_approval_grant',
  'ai_cli_task',
  'ai_attachment',
  'ai_event_fts',
  'ai_event',
  'ai_session',
  'ai_model',
  'ai_provider'
]

const DDL = `
-- 模型服务：一条记录 = 一个 provider（id 小写、不可改；一个 provider 只一种协议）。
CREATE TABLE IF NOT EXISTS ai_provider (
  id TEXT PRIMARY KEY,
  label TEXT NOT NULL DEFAULT '',
  protocol TEXT NOT NULL,
  base_url TEXT NOT NULL,
  -- 明文钥匙**永远不落库**：这里只存 safeStorage 加密后的 base64（见 infra-secret）。
  credential_ref TEXT,
  enabled INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

-- 模型目录：属于某个 provider 的可用模型（id 由 provider 侧决定，如 gpt-4o）。
CREATE TABLE IF NOT EXISTS ai_model (
  provider_id TEXT NOT NULL,
  id TEXT NOT NULL,
  label TEXT NOT NULL DEFAULT '',
  context_window INTEGER,
  max_output_tokens INTEGER,
  reasoning TEXT,
  sort_order INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (provider_id, id)
);

-- 会话：标题 / 当前模型 / 归档位。消息**不在**这里（见 ai_event）。
CREATE TABLE IF NOT EXISTS ai_session (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL DEFAULT '',
  provider_id TEXT,
  model_id TEXT,
  workspace_id TEXT,
  archived INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

-- 本机工作区：用户显式选择的目录。会话只绑定 workspace_id，模型工具永远通过
-- realpath 守卫解析相对路径，不能借 ../ 或符号链接逃逸到其他目录。
CREATE TABLE IF NOT EXISTS ai_workspace (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL DEFAULT '',
  root_path TEXT NOT NULL UNIQUE,
  created_at INTEGER NOT NULL,
  last_used_at INTEGER NOT NULL
);

-- 事件日志：**只追加**，seq 单调。消息流、工具卡、审批、用量都是这里的投影。
-- 为什么不建"可写消息表"：流式增量（chunk）与重试（attempt）都是"又发生了一次"，
-- 用 UPDATE 覆盖会把过程抹掉；事件溯源天然保真，也天然可回放（§4）。
CREATE TABLE IF NOT EXISTS ai_event (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id TEXT NOT NULL,
  turn_id TEXT,
  kind TEXT NOT NULL,
  payload TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_ai_event_session ON ai_event(session_id, seq DESC);

-- 全文检索：会话搜索（§10 记忆与增强）。独立表（非 external-content），
-- 写入点在 store#appendEvent 对 message 类事件做一次同步 —— 触发器做不到
-- "只索引文本块、跳过工具噪声"。
CREATE VIRTUAL TABLE IF NOT EXISTS ai_event_fts USING fts5(
  session_id UNINDEXED,
  seq UNINDEXED,
  content,
  tokenize='unicode61'
);

-- 附件：截图 / 拖入的文件。文件本体落 userData/ai-attachments/<sessionId>/，
-- 表里只存路径与元数据（图片不进 IPC —— 传 base64 会把主进程撑爆）。
CREATE TABLE IF NOT EXISTS ai_attachment (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  path TEXT,
  mime TEXT,
  width INTEGER,
  height INTEGER,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_ai_attachment_session ON ai_attachment(session_id, created_at);

-- 技能：**只存用户自建**。内置 / 插件贡献的技能来自 manifest，不落库
-- （「builtin」列保留是为了兼容老库里的行，新写入恒为 0）。
CREATE TABLE IF NOT EXISTS ai_skill (
  id TEXT PRIMARY KEY,
  label TEXT NOT NULL,
  icon TEXT,
  kind TEXT NOT NULL DEFAULT 'prompt',
  prompt TEXT,
  description TEXT,
  builtin INTEGER NOT NULL DEFAULT 0,
  sort_order INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

-- 用量：**每次完成**追加一行（增量），统计页自己聚合。
CREATE TABLE IF NOT EXISTS ai_usage (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id TEXT,
  provider_id TEXT,
  model_id TEXT,
  prompt_tokens INTEGER NOT NULL DEFAULT 0,
  completion_tokens INTEGER NOT NULL DEFAULT 0,
  cost_usd REAL,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_ai_usage_time ON ai_usage(created_at);

-- 工具审计：每一次工具裁决（allow / deny / 自动放行）都留证（§10）。
CREATE TABLE IF NOT EXISTS ai_audit (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id TEXT,
  tool_name TEXT NOT NULL,
  args TEXT,
  decision TEXT NOT NULL,
  reason TEXT,
  created_at INTEGER NOT NULL
);
`

/** 单条技能的启停是**本地状态**（插件贡献的技能不能改内容，但可以关掉）。 */
const DDL_SKILL_STATE = `
CREATE TABLE IF NOT EXISTS ai_skill_state (
  id TEXT PRIMARY KEY,
  enabled INTEGER NOT NULL DEFAULT 1,
  updated_at INTEGER NOT NULL
);
`

/**
 * 跨宿主共享的界面状态（当前会话 / 模型 / 推理档位 / 审批模式）。
 *
 * 为什么落库而不是留在渲染层：同一份面板会以**三种宿主**同时存在
 * （侧栏 WebContentsView / 独立窗口 / 内部页），它们是三个渲染进程，
 * 各持一份内存状态必然分叉。真源放在主进程 + 这里持久化，切换宿主、重启都连续。
 *
 * 为什么是 key-value 而不是一张宽表：这四项彼此独立、项数会随功能增加，
 * 宽表每加一个字段都要加列 + 迁移；key-value 只加一行。
 */
const DDL_UI_STATE = `
CREATE TABLE IF NOT EXISTS ai_ui_state (
  key TEXT PRIMARY KEY,
  value TEXT,
  updated_at INTEGER NOT NULL
);
`

/**
 * 授权记忆：用户点过「始终允许」的工具（见 `main/approval-grants.cjs`）。
 *
 * 为什么单独一张表而不是塞进 `ai_ui_state`：授权是**安全事实**，不是界面偏好 ——
 * 它有独立的生命周期（可逐条撤销、能审计），也不该跟着"切换宿主"一起广播。
 * 键是「工具 + 站点」：写页面 / Cookie / 权限的授权只能作用于用户当时看见的站点，
 * 不能被另一个已打开页面继承。没有页面上下文的工具统一使用 `local` 作用域。
 */
const DDL_APPROVAL_GRANT = `
CREATE TABLE IF NOT EXISTS ai_approval_grant (
  tool_name TEXT NOT NULL,
  site TEXT NOT NULL DEFAULT 'local',
  created_at INTEGER NOT NULL,
  PRIMARY KEY (tool_name, site)
);
`

const DDL_WORKSPACE = `
CREATE TABLE IF NOT EXISTS ai_workspace (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL DEFAULT '',
  root_path TEXT NOT NULL UNIQUE,
  created_at INTEGER NOT NULL,
  last_used_at INTEGER NOT NULL
);
`

interface AiMigrationDatabase {
  exec(sql: string): unknown
  prepare(sql: string): {
    run(...params: unknown[]): unknown
    all?<T = unknown>(): T[]
  }
}

/**
 * 迁移插槽实现（`db.schema.migration`）：幂等，按 id 记账由 infra-db 负责。
 *
 * 002 做两件事：建启停表；把老库里由旧种子写入的 `builtin=1` 行清掉 ——
 * 那些技能现在由 `ai-skills-builtin` 插件贡献，留着会变成两套互相漂移的文案。
 * 用户自建行（builtin=0）原样保留。
 */
const AI_MIGRATIONS = Object.freeze([
  Object.freeze({
    id: 'ai/001-init',
    up(sqlite: AiMigrationDatabase) {
      sqlite.exec(DDL)
    }
  }),
  Object.freeze({
    id: 'ai/002-skill-state',
    up(sqlite: AiMigrationDatabase) {
      sqlite.exec(DDL_SKILL_STATE)
      sqlite.prepare('DELETE FROM ai_skill WHERE builtin = 1').run()
    }
  }),
  Object.freeze({
    id: 'ai/003-ui-state',
    up(sqlite: AiMigrationDatabase) {
      sqlite.exec(DDL_UI_STATE)
    }
  }),
  Object.freeze({
    id: 'ai/004-approval-grant',
    up(sqlite: AiMigrationDatabase) {
      sqlite.exec(DDL_APPROVAL_GRANT)
    }
  }),
  Object.freeze({
    id: 'ai/005-usage-cache',
    up(sqlite: AiMigrationDatabase) {
      // 迁移会在插件热禁用 / 重启用时再次执行；ADD COLUMN 必须自行保持幂等。
      try { sqlite.exec('ALTER TABLE ai_usage ADD COLUMN cached_tokens INTEGER NOT NULL DEFAULT 0') } catch (_) {}
    }
  }),
  Object.freeze({
    id: 'ai/006-local-workspace',
    up(sqlite: AiMigrationDatabase) {
      sqlite.exec(DDL_WORKSPACE)
      try { sqlite.exec('ALTER TABLE ai_session ADD COLUMN workspace_id TEXT') } catch (_) {}
    }
  }),
  Object.freeze({
    id: 'ai/007-grant-scope',
    up(sqlite: AiMigrationDatabase) {
      const columns = sqlite.prepare('PRAGMA table_info(ai_approval_grant)')
        .all?.<{ name?: string; pk?: number }>() || []
      const primary = new Set(columns.filter((column) => Number(column.pk) > 0).map((column) => String(column.name || '')))
      if (primary.has('tool_name') && primary.has('site')) return

      sqlite.exec(`
        DROP TABLE IF EXISTS ai_approval_grant_scoped;
        CREATE TABLE ai_approval_grant_scoped (
          tool_name TEXT NOT NULL,
          site TEXT NOT NULL DEFAULT 'local',
          created_at INTEGER NOT NULL,
          PRIMARY KEY (tool_name, site)
        );
        INSERT OR REPLACE INTO ai_approval_grant_scoped (tool_name, site, created_at)
        SELECT tool_name, COALESCE(NULLIF(TRIM(site), ''), 'local'), created_at
        FROM ai_approval_grant;
        DROP TABLE ai_approval_grant;
        ALTER TABLE ai_approval_grant_scoped RENAME TO ai_approval_grant;
      `)
    }
  })
])

/**
 * 一次性补齐全部迁移（幂等）。
 *
 * 为什么不用迁移器：`enable()` 执行时表可能还不存在（见 ai-engine.cjs 文件头），
 * 这里必须能"任何时候都安全地跑一遍"。迁移 id 的记账仍由 infra-db 负责。
 * @param {any} sqlite
 */
function runAiMigrations(sqlite: AiMigrationDatabase): string[] {
  for (const migration of AI_MIGRATIONS) migration.up(sqlite)
  return AI_MIGRATIONS.map((m) => m.id)
}

module.exports = { AI_MIGRATIONS, AI_TABLES, runAiMigrations }
