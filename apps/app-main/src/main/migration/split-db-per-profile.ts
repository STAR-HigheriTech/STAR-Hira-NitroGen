/**
 * split-db-per-profile —— 一次性迁移：单库列分区 → 每 profile 物理独立库（PART16 L2 · 步骤 4）。
 *
 * ── 它做的事（一次启动完成，幂等可重入）─────────────────────────────
 *   1. 旧单库 `userData/hira-ng.db` 的 `profiles` / `kv` → `userData/global.db`；
 *   2. 旧库每张业务表按 `profile_id` 拆到 `userData/profiles/<id>/hira-ng.db`；
 *   3. 设置拆文件：安装基线 `settings.json` 折进各 profile 快照（非全局键）与
 *      `settings.global.json`（全局键），然后把基线改名备份；
 *   4. 旧单库 **原样保留**（复制语义，不改名、不删）——
 *      "回退单库模式"只需删掉 `global.db`，数据仍在原处（§7 风险对策）。
 *
 * ── 三条安全设计（做错会损坏用户数据，故逐条写死）────────────────────
 *   ① **完成标记 = `global.db` 存在**，且它**最后**创建。中途崩溃 → 下次启动重跑，
 *      未完成的部分天然重做（行用 `INSERT OR REPLACE`、文件用覆盖写）——**可重入**。
 *   ② **复制而非移动**：旧库一个字节都不改。最坏结果只是"迁移没生效"，
 *      绝无"原来的数据没了"。
 *   ③ **全新安装**（没有旧库）：只建一个空的 `global.db` 让后续启动进入 split 模式，
 *      并把已有的基线设置折成全局文件 —— 不产生任何空壳 profile。
 *
 * ── 为什么放在最早（settings 服务与 db provider 之前）──────────────
 * 它会把基线 `settings.json` 改名，而 `createSettingsService` 会读那个文件；
 * 也会创建 `global.db`，而 db provider 的**模式判定**就是看它。因此必须最先跑。
 */

import fs from 'node:fs'
import path from 'node:path'
import {
  ensureGlobalSchema,
  ensureProfileSchema,
  ensureSchema,
  openDb,
  type DbHandle,
  type SqliteHandle
} from '@hira-ng/infra-db'
import { PROFILE_ARCHIVE_TABLES } from '@hira-ng/shared-types/src/profile-archive.mjs'
import {
  GLOBAL_SETTINGS_FILE,
  LEGACY_BASELINE_FILE,
  LEGACY_BASELINE_BACKUP,
  isGlobalSettingKey
} from '@hira-ng/shared-types/src/settings-scope.mjs'
import { DEFAULT_SETTINGS, isDefaultValue } from '@hira-ng/domain-settings'

interface MigrationLogger {
  log?(message: string): void
  warn(...args: unknown[]): void
  error(...args: unknown[]): void
}

interface MigrationDependencies {
  userDataDir: string
  profileDirOf(profileId: string): string
  dbFileName: string
  globalDbFileName: string
  logger?: MigrationLogger
}

interface BackfillResult { ran: boolean; reason?: string; rows?: number }

export interface PhysicalIsolationResult {
  migrated: boolean
  reason?: string
  fresh?: boolean
  profiles?: number
  backfilled?: number
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null
}

/** 列名/表名包引号（名字全部来自本文件或 PRAGMA，不来自外部输入）。 */
const q = (name: unknown): string => `"${String(name).replace(/"/g, '""')}"`

/** 读一个 JSON 对象；缺失 / 坏掉 / 不是对象 → null（宽进）。 */
function readJsonObject(filePath: string): Record<string, unknown> | null {
  try {
    const raw = JSON.parse(fs.readFileSync(filePath, 'utf8'))
    return asRecord(raw)
  } catch (_) {
    return null
  }
}

function writeJsonObject(filePath: string, value: Record<string, unknown>): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true })
  fs.writeFileSync(filePath, JSON.stringify(value, null, 2), 'utf8')
}

/** 目标表当前真实列（决定 INSERT 的列集合；多出的列忽略、缺的列取默认）。 */
function columnsOf(sqlite: SqliteHandle, table: string): string[] {
  try {
    return (sqlite.prepare(`PRAGMA table_info(${q(table)})`).all() as Array<{ name: string }>)
      .map((column) => column.name)
  } catch (_) {
    return []
  }
}

/**
 * 把源库某张表的行灌进目标库（可按 profileIds 过滤）。
 *
 * `src` / `dst` 必须是 **裸 better-sqlite3 句柄**（`.sqlite`），不是 `openDb()` 的
 * 包装对象 —— 传错时 `.prepare` 不存在。宁可在这里**抛错中断迁移**，也不能静默
 * 复制 0 行：迁移的一次性完成标记（`global.db`）一旦落下，就再也不会重跑，
 * 静默 0 行等于永久丢数据（本项目真实踩过：v1 迁移把 48 条历史 / 4 条密码全丢了，
 * 因为旧代码传的是包装对象）。
 *
 * @param {import('better-sqlite3').Database} src
 * @param {import('better-sqlite3').Database} dst
 * @param {string} table
 * @param {string[]|null} profileIds  null = 不按 profile 过滤（全局表）
 * @param {object} logger
 * @param {{ replace?: boolean }} [options] replace=false 时用 INSERT OR IGNORE（回填不覆盖新数据）
 */
function copyTable(
  src: SqliteHandle,
  dst: SqliteHandle,
  table: string,
  profileIds: readonly string[] | null,
  logger: MigrationLogger,
  options: { replace?: boolean } = {}
): number {
  if (!src || typeof src.prepare !== 'function') {
    throw new TypeError(`[l2-migration] copyTable(${table}) 需要裸 sqlite 句柄（收到的是包装对象？）`)
  }
  const cols = columnsOf(dst, table)
  if (!cols.length) return 0
  let rows: Array<Record<string, unknown>> = []
  try {
    rows = src.prepare(`SELECT * FROM ${q(table)}`).all() as Array<Record<string, unknown>>
  } catch (e) {
    logger.warn(`[l2-migration] 读取旧表失败（跳过）: ${table}`, errorMessage(e))
    return 0
  }
  const allow = profileIds ? new Set(profileIds.map(String)) : null
  const verb = options.replace === false ? 'INSERT OR IGNORE' : 'INSERT OR REPLACE'
  let n = 0
  for (const row of rows) {
    if (allow && !allow.has(String(row.profile_id))) continue
    const keys = cols.filter((c) => Object.prototype.hasOwnProperty.call(row, c))
    if (!keys.length) continue
    const sql = `${verb} INTO ${q(table)} (${keys.map(q).join(', ')}) VALUES (${keys.map(() => '?').join(', ')})`
    try {
      dst.prepare(sql).run(...keys.map((k) => (row[k] === undefined ? null : row[k])))
      n++
    } catch (e) {
      logger.warn(`[l2-migration] 复制行失败（跳过）: ${table}`, errorMessage(e))
    }
  }
  return n
}

/** 旧库里出现过的全部 profile id（业务表的 profile_id ∪ profiles 表 ∪ 'default'）。 */
function collectProfileIds(sqlite: SqliteHandle): string[] {
  const ids = new Set<string>(['default'])
  if (!sqlite || typeof sqlite.prepare !== 'function') return Array.from(ids)
  try {
    for (const row of sqlite.prepare('SELECT id FROM "profiles"').all() as Array<Record<string, unknown>>) {
      if (row && row.id) ids.add(String(row.id))
    }
  } catch (_) { /* 老库没有 profiles 表 → 只有 default */ }
  for (const table of PROFILE_ARCHIVE_TABLES) {
    try {
      for (const row of sqlite.prepare(`SELECT DISTINCT profile_id FROM ${q(table)}`).all() as Array<Record<string, unknown>>) {
        if (row && row.profile_id) ids.add(String(row.profile_id))
      }
    } catch (_) { /* 表不存在 → 跳过 */ }
  }
  return Array.from(ids)
}

/**
 * 回填标记（写在 `global.db` 的 `kv` 里）。
 *
 * 为什么需要一次性标记，而不是每次启动都"补缺行"：用户**删除**的密码/书签，
 * 在旧库里仍然存在 —— 无标记的回填会在下次启动把它们复活。标记一旦落下，
 * 回填就再也不跑；之后的新增/删除都由 split 库自己负责。
 */
const BACKFILL_KV_KEY = '__l2_legacy_backfill_v1'

/**
 * 修复 v1 迁移的"静默 0 行"事故：把旧单库里**从未搬过去**的行补进 split 库。
 *
 * 语义：
 *   · 只插入目标库中**不存在**的行（`INSERT OR IGNORE`）—— 绝不动 split 库里的新数据；
 *   · 覆盖全部 profile（按 `profile_id` 路由），以及全局的 `profiles` / `kv`；
 *   · 完成后在 `global.db` 的 `kv` 写标记，此后永不重跑。
 *
 * 幂等且安全：中途崩溃 → 标记未写 → 下次重跑，已插入的行被 IGNORE 跳过。
 *
 * @returns {{ ran: boolean, reason?: string, rows?: number }}
 */
function backfillFromLegacy({
  userDataDir,
  profileDirOf,
  dbFileName,
  globalDbFileName,
  logger = console
}: MigrationDependencies): BackfillResult {
  const globalPath = path.join(userDataDir, globalDbFileName)
  const legacyPath = path.join(userDataDir, dbFileName)
  // 没有旧库（全新安装）或还没拆库 → 没有回填的对象
  if (!fs.existsSync(globalPath) || !fs.existsSync(legacyPath)) {
    return { ran: false, reason: 'no-legacy' }
  }

  let globalHandle: DbHandle | null = null
  let legacy: DbHandle | null = null
  try {
    const openedGlobal = openDb(globalPath, ensureGlobalSchema)
    globalHandle = openedGlobal
    const done = openedGlobal.sqlite
      .prepare('SELECT value FROM kv WHERE key = ?')
      .get(BACKFILL_KV_KEY)
    if (done) return { ran: false, reason: 'already-backfilled' }

    const openedLegacy = openDb(legacyPath, ensureSchema)
    legacy = openedLegacy
    const profileIds = collectProfileIds(openedLegacy.sqlite)
    let rows = 0

    for (const pid of profileIds) {
      const dir = profileDirOf(pid)
      fs.mkdirSync(dir, { recursive: true })
      const target = openDb(path.join(dir, dbFileName), ensureProfileSchema)
      try {
        const run = target.sqlite.transaction(() => {
          for (const table of PROFILE_ARCHIVE_TABLES) {
            rows += copyTable(openedLegacy.sqlite, target.sqlite, table, [pid], logger, { replace: false })
          }
        })
        run()
      } finally {
        target.close()
      }
    }

    const runGlobal = openedGlobal.sqlite.transaction(() => {
      rows += copyTable(openedLegacy.sqlite, openedGlobal.sqlite, 'profiles', null, logger, { replace: false })
      rows += copyTable(openedLegacy.sqlite, openedGlobal.sqlite, 'kv', null, logger, { replace: false })
    })
    runGlobal()

    openedGlobal.sqlite
      .prepare('INSERT OR REPLACE INTO kv (key, value) VALUES (?, ?)')
      .run(BACKFILL_KV_KEY, String(Date.now()))

    logger.log && logger.log(`[l2-migration] 旧库回填完成：${profileIds.length} 个 profile，${rows} 行`)
    return { ran: true, rows }
  } catch (e) {
    logger.warn('[l2-migration] 旧库回填失败（下次启动重试）:', errorMessage(e))
    return { ran: false, reason: 'failed' }
  } finally {
    try { if (legacy) legacy.close() } catch (_) {}
    try { if (globalHandle) globalHandle.close() } catch (_) {}
  }
}

/**
 * 设置拆文件（§5 步骤 4 的第 3 条）。
 *
 * 语义：安装基线里**非全局**的键折进每个 profile 的快照；**全局**的键折进
 * `settings.global.json`；然后把基线改名为 `settings.json.pre-l2`（备份保留）。
 * 改名之后 `createSettingsService` 读不到基线 → 出厂默认成为兜底（§4.4 的完整快照）。
 *
 * 只写"与出厂默认不同"的键：省磁盘，也让设置页的「已改动」高亮不虚增。
 */
function migrateSettingsFiles({
  userDataDir,
  profileDirOf,
  profileIds,
  logger = console
}: Omit<MigrationDependencies, 'dbFileName' | 'globalDbFileName'> & { profileIds: readonly string[] }): void {
  const baselinePath = path.join(userDataDir, LEGACY_BASELINE_FILE)
  const baseline = readJsonObject(baselinePath)
  const globalFile = path.join(userDataDir, GLOBAL_SETTINGS_FILE)
  const isFresh = !baseline

  // ── 全局文件：只补"还没有"的情况（不覆盖已有全局文件，保证可重入）──
  if (!fs.existsSync(globalFile)) {
    const globalOut: Record<string, unknown> = {}
    if (baseline) {
      for (const k of Object.keys(baseline)) {
        if (isGlobalSettingKey(k)) globalOut[k] = baseline[k]
      }
    }
    if (Object.keys(globalOut).length) {
      try { writeJsonObject(globalFile, globalOut) } catch (e) {
        logger.warn('[l2-migration] 写全局设置失败:', errorMessage(e))
      }
    }
  }

  // ── 每个 profile 的快照 = 基线（非全局部分）+ 既有的 profile 覆盖 ──
  for (const pid of profileIds) {
    const snapPath = path.join(profileDirOf(pid), 'settings.json')
    const existing = readJsonObject(snapPath) || {}
    const out: Record<string, unknown> = {}
    if (baseline) {
      for (const k of Object.keys(baseline)) {
        if (isGlobalSettingKey(k)) continue
        if (isDefaultValue(k, baseline[k], DEFAULT_SETTINGS)) continue
        out[k] = baseline[k]
      }
    }
    for (const k of Object.keys(existing)) {
      if (isGlobalSettingKey(k)) continue
      out[k] = existing[k]
    }
    // 没有任何偏离 → 不落盘（空快照与"文件不存在"等价）
    if (!Object.keys(out).length && !fs.existsSync(snapPath)) continue
    try { writeJsonObject(snapPath, out) } catch (e) {
      logger.warn(`[l2-migration] 写 profile 设置快照失败 (${pid}):`, errorMessage(e))
    }
  }

  // ── 基线改名备份（最后做：改名后 base 只剩出厂默认）──
  if (!isFresh && fs.existsSync(baselinePath)) {
    try {
      fs.renameSync(baselinePath, path.join(userDataDir, LEGACY_BASELINE_BACKUP))
    } catch (e) {
      logger.warn('[l2-migration] 基线改名失败（设置仍可读，非致命）:', errorMessage(e))
    }
  }
}

/**
 * 执行迁移。
 *
 * @param {object} deps
 * @param {string} deps.userDataDir
 * @param {(profileId: string) => string} deps.profileDirOf
 * @param {string} deps.dbFileName        业务库文件名（与 db provider 同源）
 * @param {string} deps.globalDbFileName  全局库文件名
 * @param {object} [deps.logger]
 * @returns {{ migrated: boolean, reason?: string, fresh?: boolean, profiles?: number }}
 */
export function migrateToPhysicalIsolation({
  userDataDir,
  profileDirOf,
  dbFileName,
  globalDbFileName,
  logger = console
}: MigrationDependencies): PhysicalIsolationResult {
  if (!userDataDir || typeof profileDirOf !== 'function' || !dbFileName || !globalDbFileName) {
    throw new Error('[l2-migration] 缺少必需参数（userDataDir / profileDirOf / dbFileName / globalDbFileName）')
  }
  const globalPath = path.join(userDataDir, globalDbFileName)
  // ① 完成标记：全局库已在 → 迁移早已完成（幂等）
  //    但仍要跑一次**旧库回填**：v1 迁移有"静默复制 0 行"的事故（传参类型错误），
  //    完成标记已落下的用户不会重跑迁移，只能靠回填补回被丢掉的数据。
  if (fs.existsSync(globalPath)) {
    const backfill = backfillFromLegacy({
      userDataDir,
      profileDirOf,
      dbFileName,
      globalDbFileName,
      logger
    })
    return {
      migrated: false,
      reason: 'already-migrated',
      backfilled: backfill.ran ? backfill.rows : 0
    }
  }

  const legacyPath = path.join(userDataDir, dbFileName)
  const hasLegacy = fs.existsSync(legacyPath)

  if (!hasLegacy) {
    // ③ 全新安装：只需一个空的全局库把后续启动推进 split 模式
    try {
      const g = openDb(globalPath, ensureGlobalSchema)
      g.close()
    } catch (e) {
      logger.error('[l2-migration] 创建全局库失败:', errorMessage(e))
      return { migrated: false, reason: 'global-db-create-failed' }
    }
    migrateSettingsFiles({ userDataDir, profileDirOf, profileIds: ['default'], logger })
    return { migrated: true, fresh: true, profiles: 0 }
  }

  let legacy: DbHandle | undefined
  try {
    // 只读意图：`ensureSchema` 的 DDL/补列都幂等，不会改坏旧库（复制语义）
    legacy = openDb(legacyPath, ensureSchema)
  } catch (e) {
    logger.error('[l2-migration] 打开旧库失败，保持单库模式:', errorMessage(e))
    return { migrated: false, reason: 'legacy-open-failed' }
  }

  const stats = { profiles: 0, rows: 0 }
  try {
    const profileIds = collectProfileIds(legacy.sqlite)

    // ② 先把每个 profile 的库建好并灌数据（失败则整体不算完成 → 下次重来）
    for (const pid of profileIds) {
      const dir = profileDirOf(pid)
      fs.mkdirSync(dir, { recursive: true })
      const target = openDb(path.join(dir, dbFileName), ensureProfileSchema)
      try {
        // 整个 profile 的复制包在一个事务里：几十行也好、几万行（历史）也好，
        // 单事务能把逐行 INSERT 的 fsync 开销摊掉（实测差两个数量级）。
        const run = target.sqlite.transaction(() => {
          for (const table of PROFILE_ARCHIVE_TABLES) {
            // spaces 也按 profile_id 过滤（与其它表同一口径）
            stats.rows += copyTable(legacy.sqlite, target.sqlite, table, [pid], logger)
          }
        })
        run()
      } finally {
        target.close()
      }
      stats.profiles++
    }

    // 设置拆文件（在创建全局库之前 —— 全局库是完成标记）
    migrateSettingsFiles({ userDataDir, profileDirOf, profileIds, logger })

    // 最后：全局库（profiles + kv）。它的出现 = 整个迁移完成。
    const globalHandle = openDb(globalPath, ensureGlobalSchema)
    try {
      const run = globalHandle.sqlite.transaction(() => {
        copyTable(legacy.sqlite, globalHandle.sqlite, 'profiles', null, logger)
        copyTable(legacy.sqlite, globalHandle.sqlite, 'kv', null, logger)
      })
      run()
      // 迁移本身已经把旧库全部行搬完 —— 打上回填标记，避免下次启动重复补行
      // （重复补行会把用户之后删除的行"复活"）。
      globalHandle.sqlite
        .prepare('INSERT OR REPLACE INTO kv (key, value) VALUES (?, ?)')
        .run(BACKFILL_KV_KEY, String(Date.now()))
    } finally {
      globalHandle.close()
    }
  } catch (e) {
    logger.error('[l2-migration] 迁移失败（保持单库模式，下次启动重试）:', errorMessage(e))
    try { fs.rmSync(globalPath, { force: true }) } catch (_) {}
    return { migrated: false, reason: 'failed' }
  } finally {
    try { legacy.close() } catch (_) {}
  }

  logger.log?.(`[l2-migration] 已按 profile 拆库：${stats.profiles} 个 profile，${stats.rows} 行`)
  return { migrated: true, fresh: false, profiles: stats.profiles }
}

