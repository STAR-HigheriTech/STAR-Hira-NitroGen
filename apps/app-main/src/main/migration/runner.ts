/**
 * 迁移工具：从 Hira v7.5.0 数据迁移到 NG SQLite。
 *
 * 架构：
 *   runner.js   — 迁移编排（事务 + 断电回滚 + 进度）
 *   adapters/   — 8 个适配器：bookmarks/history/downloads/notes/tabs/kv/passwords/permissions
 *   datasets/   — 4 套测试数据集生成器
 *   integrity.js — 迁移后 100 项 SQL 完整性校验
 *
 * 解耦原则：
 *   - 仅依赖 infra-db（createDb + schema）和 better-sqlite3
 *   - 不导入 domain 层服务，直接写 SQLite（迁移是底层操作）
 *   - 适配器是纯函数：sourceRows → targetRows
 */

import fs from 'node:fs'
import path from 'node:path'
import { createDb, type SqliteHandle } from '@hira-ng/infra-db'

interface MigrationLogger {
  info(message: string): void
  warn(message: string): void
  error(message: string): void
}

export interface MigrationAdapter {
  name: string
  sourceFile: string
  insert(sqlite: SqliteHandle, rows: unknown, logger: MigrationLogger): number
}

interface MigrationOptions {
  sourceDir: string
  dbPath: string
  logger?: MigrationLogger
}

export interface MigrationResult {
  ok: boolean
  migrated: Record<string, number>
  errors: string[]
}

function adapter(name: string): MigrationAdapter {
  const modules: Record<string, unknown> = {
    bookmarks: require('./adapters/bookmarks'),
    history: require('./adapters/history'),
    downloads: require('./adapters/downloads'),
    notes: require('./adapters/notes'),
    tabs: require('./adapters/tabs'),
    kv: require('./adapters/kv'),
    passwords: require('./adapters/passwords'),
    permissions: require('./adapters/permissions')
  }
  const module = modules[name] as Record<string, MigrationAdapter>
  return module[`${name}Adapter`]
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function isEmptySource(value: unknown): boolean {
  if (Array.isArray(value)) return value.length === 0
  if (value && typeof value === 'object') return Object.keys(value).length === 0
  return true
}

/** 8 个适配器 — 顺序即迁移顺序（有外键依赖的先迁） */
export const ADAPTERS: readonly MigrationAdapter[] = [
  adapter('bookmarks'),
  adapter('history'),
  adapter('downloads'),
  adapter('notes'),
  adapter('tabs'),
  adapter('kv'),
  adapter('passwords'),
  adapter('permissions')
]

/**
 * 运行迁移。
 */
export async function runMigration({ sourceDir, dbPath, logger = console }: MigrationOptions): Promise<MigrationResult> {
  const errors: string[] = []
  const migrated: Record<string, number> = {}

  // 1. 加载源数据
  const source: Record<string, unknown> = {}
  for (const adapter of ADAPTERS) {
    const file = path.join(sourceDir, adapter.sourceFile)
    if (!fs.existsSync(file)) {
      logger.info(`[migration] ${adapter.name}: source file not found, skipping (${file})`)
      source[adapter.name] = []
      continue
    }
    try {
      const raw = fs.readFileSync(file, 'utf-8')
      source[adapter.name] = JSON.parse(raw)
    } catch (e) {
      errors.push(`${adapter.name}: failed to parse source file - ${errorMessage(e)}`)
      source[adapter.name] = []
    }
  }

  if (errors.length > 0 && Object.values(source).every(isEmptySource)) {
    // 全部源文件解析失败，中止
    return { ok: false, migrated, errors }
  }

  // 2. 打开目标 DB（自动建表）
  const { sqlite, close } = createDb(dbPath)

  try {
    // 3. 整体事务 — 断电回滚的核心
    //    单个事务包裹全部适配器，任何适配器失败 → ROLLBACK → DB 无损坏
    sqlite.exec('BEGIN TRANSACTION')

    for (const adapter of ADAPTERS) {
      const rows = source[adapter.name] ?? []
      if (isEmptySource(rows)) {
        migrated[adapter.name] = 0
        continue
      }
      try {
        const count = adapter.insert(sqlite, rows, logger)
        migrated[adapter.name] = count
        logger.info(`[migration] ${adapter.name}: migrated ${count} rows`)
      } catch (e) {
        const message = errorMessage(e)
        errors.push(`${adapter.name}: ${message}`)
        logger.error(`[migration] ${adapter.name} FAILED: ${message}`)
        // 失败 → 回滚整个事务
        sqlite.exec('ROLLBACK')
        logger.warn('[migration] transaction rolled back due to error')
        return { ok: false, migrated, errors }
      }
    }

    // 4. 全部成功 → 提交
    sqlite.exec('COMMIT')
    logger.info('[migration] all adapters committed successfully')
    return { ok: true, migrated, errors }
  } finally {
    close()
  }
}

/**
 * 检查上次迁移是否完整（断电恢复检测）。
 * 通过写入一个迁移状态标记文件，启动时检查是否有未完成的迁移。
 */
export function checkMigrationState(stateFile: string): Record<string, unknown> {
  if (!fs.existsSync(stateFile)) return { state: 'none' }
  try {
    const state: unknown = JSON.parse(fs.readFileSync(stateFile, 'utf-8'))
    return state !== null && typeof state === 'object' ? state as Record<string, unknown> : { state: 'corrupt' }
  } catch {
    return { state: 'corrupt' }
  }
}

export function writeMigrationState(stateFile: string, state: Record<string, unknown>): void {
  fs.writeFileSync(stateFile, JSON.stringify(state, null, 2))
}

