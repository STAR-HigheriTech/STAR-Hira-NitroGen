/** Hira CLI 插件自己的持久任务表；停用插件时数据保留，重新启用可继续读取。 */

interface CliSqlite {
  exec(sql: string): unknown
  prepare(sql: string): { run(...params: unknown[]): unknown }
}

const DDL = `
CREATE TABLE IF NOT EXISTS ai_cli_task (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  turn_id TEXT,
  prompt TEXT NOT NULL,
  status TEXT NOT NULL,
  result TEXT,
  error TEXT,
  usage TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  finished_at INTEGER
);
CREATE INDEX IF NOT EXISTS idx_ai_cli_task_updated ON ai_cli_task(updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_ai_cli_task_status ON ai_cli_task(status, updated_at DESC);
`

const CLI_MIGRATIONS = Object.freeze([
  Object.freeze({
    id: 'ai/007-cli-task',
    up(sqlite: CliSqlite) {
      sqlite.exec(DDL)
      const now = Date.now()
      sqlite.prepare(
        `UPDATE ai_cli_task
            SET status = 'interrupted',
                error = 'Hira 已退出，任务在应用关闭时中断',
                updated_at = ?,
                finished_at = ?
          WHERE status = 'running'`
      ).run(now, now)
    }
  })
])

function runCliMigrations(sqlite: CliSqlite): void {
  for (const migration of CLI_MIGRATIONS) migration.up(sqlite)
}

module.exports = { CLI_MIGRATIONS, runCliMigrations }
