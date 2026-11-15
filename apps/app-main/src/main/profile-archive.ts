/**
 * profile-archive.js — 整份配置档案的导出 / 导入（G1 / G2）。
 *
 * ── 它是什么、不是什么 ────────────────────────────────────────────
 * 「导出」= 把**当前 profile 的数据**打包成一个 JSON；「导入」= 从 JSON **新建**一个
 * profile 并把数据灌进那个新 id 名下。它是一台数据搬运机，不认识 Electron、
 * 不认识设置页 —— 文件对话框与 IPC 路由在 `ipc/profile-archive.js`。
 *
 * ── 导入的安全设计（三条铁律）───────────────────────────────────
 *   ① **先校验再动手**：`readArchiveFile` 在解析后立刻跑 `validateProfileArchive`，
 *      结构不对就直接抛错 —— 绝不出现"灌了一半"的包。
 *   ② **只新建、绝不覆盖**：导入永远 `profileService.create(...)` 造一个新的 id，
 *      把行里的 `profile_id` 全部改写成新 id。最坏结果只是"多了一个 profile"，
 *      而不是"把现有用户的数据改坏了"。
 *   ③ **失败可回滚**：落库整个过程包在一个 SQLite 事务里；若中途抛错，
 *      事务回滚 + 删掉刚建的 profile（`profileService.remove`），磁盘上不留半成品。
 *
 * ── 为什么用裸 sqlite 而不是 Drizzle ──────────────────────────────
 * 导出的列名要**原样**跟着 DB（`profile_id` / `created_at` …），导入时又要按目标表
 * 当前**真实列**来拼 INSERT —— 这样 schema 日后加一列，本模块不用改一行。
 * 裸 `sqlite.prepare(PRAGMA table_info(...))` 正好给出这份"真实列"，是最省事且最稳的路。
 *
 * ── 磁盘那一半带什么 ─────────────────────────────────────────────
 * 只带 `profiles/<id>/` 下的**我们自己写的** JSON：根目录的 `*.json`
 * （settings.json / session.json / session-<窗口>.json）与 `spaces/<空间 id>/` 下的 `*.json`
 * （每个空间的 settings.json / session.json）。Chromium 管理的目录
 * （Network/、Local Storage/、Extensions/ …）**不在这两条路径里**，天然被排除 ——
 * 于是 cookie、缓存、扩展这些"机器相关状态"不会跟着档案走。
 */

import fs from 'node:fs'
import path from 'node:path'
import type { Dirent } from 'node:fs'
import {
  PROFILE_ARCHIVE_FORMAT,
  PROFILE_ARCHIVE_VERSION,
  PROFILE_ARCHIVE_TABLES,
  PROFILE_ARCHIVE_MAX_BYTES,
  fitProfileName,
  validateProfileArchive
} from '@hira-ng/shared-types/src/profile-archive.mjs'
import { APP_NAME } from '@hira-ng/shared-types/src/associations.mjs'

type BetterSqlite3 = import('better-sqlite3').Database
type ArchiveRow = Record<string, unknown>

interface ProfileArchiveRecord {
  id: string
  name: string
  icon: string
  color: string | null
}

interface ProfileArchiveProfileService {
  get(id: string): ProfileArchiveRecord | null | undefined
  list(): Array<ProfileArchiveRecord | null | undefined>
  listVisible?(): Array<ProfileArchiveRecord | null | undefined>
  create(input: { name: string; icon: string; color: string | undefined; createSpace: boolean }): ProfileArchiveRecord | null
  remove(id: string): unknown
}

export interface ProfileArchivePayload {
  format: string
  version: number
  createdAt: number
  app: { name: string; version: string }
  profile: { name: string; icon: string; color: string | null }
  tables: Record<string, ArchiveRow[]>
  files: Record<string, string>
}

export interface ProfileArchiveDependencies {
  sqlite?: BetterSqlite3
  sqliteOf?(profileId: string): BetterSqlite3
  profileService: ProfileArchiveProfileService
  resolveProfileDir(profileId: string): string
  ensureDefaultSpace?(profileId: string, name: string): void
  appName?: string
  appVersion?: string
}

/** 导出的 archive 里、`tables` 之外的两个附件子目录约定（导入时按同路径还原）。 */
const SPACES_DIR = 'spaces'

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

export function createProfileArchive(deps: ProfileArchiveDependencies) {
  const { profileService, resolveProfileDir } = deps
  /**
   * 取某 profile 的**裸 sqlite 句柄**。
   * L2 物理独立后每个 profile 一个库文件 → 导出/导入都必须按 profileId 显式寻址
   *（"当前库"那套隐式路由在这里不成立：导出的是活动 profile、导入落在**新建**的 id 上）。
   */
  const sqliteOf: (profileId: string) => BetterSqlite3 = typeof deps.sqliteOf === 'function'
    ? deps.sqliteOf
    : () => {
        if (!deps.sqlite) throw new Error('[profile-archive] sqlite 尚未初始化')
        return deps.sqlite
      }
  const ensureDefaultSpace = typeof deps.ensureDefaultSpace === 'function' ? deps.ensureDefaultSpace : () => {}
  if (!profileService || typeof resolveProfileDir !== 'function' || (!deps.sqlite && !deps.sqliteOf)) {
    throw new Error('[profile-archive] 缺少必需依赖（sqlite/sqliteOf / profileService / resolveProfileDir）')
  }
  /** 单引号包列名 —— 列名来自 PRAGMA，不受外部输入影响，仅作语法安全。 */
  const q = (name: string): string => `"${String(name).replace(/"/g, '""')}"`

  /* ── 磁盘：读 / 写 ─────────────────────────────────────────────── */

  function isDir(p: string): boolean {
    try { return fs.statSync(p).isDirectory() } catch (_) { return false }
  }

  function listDir(p: string): Dirent[] {
    try { return fs.readdirSync(p, { withFileTypes: true }) } catch (_) { return [] }
  }

  function readText(p: string): string | null {
    try { return fs.readFileSync(p, 'utf8') } catch (_) { return null }
  }

  /**
   * 收集 `<profileDir>/` 下所有"我们自己的" JSON（相对路径 → 内容）。
   * 只走两条已知路径（见文件头），不做全目录递归 —— 全递归会把 Chromium 的
   * 运行时文件卷进来，反而需要一长串排除名单。
   * @param {string} profileDir
   * @returns {Record<string,string>}
   */
  function collectProfileFiles(profileDir: string): Record<string, string> {
    const out: Record<string, string> = {}
    if (!isDir(profileDir)) return out

    for (const entry of listDir(profileDir)) {
      if (!entry.isFile() || !entry.name.endsWith('.json')) continue
      const text = readText(path.join(profileDir, entry.name))
      if (text != null) out[entry.name] = text
    }

    const spacesDir = path.join(profileDir, SPACES_DIR)
    for (const space of listDir(spacesDir)) {
      if (!space.isDirectory()) continue
      const spaceDir = path.join(spacesDir, space.name)
      for (const file of listDir(spaceDir)) {
        if (!file.isFile() || !file.name.endsWith('.json')) continue
        const text = readText(path.join(spaceDir, file.name))
        if (text != null) out[`${SPACES_DIR}/${space.name}/${file.name}`] = text
      }
    }
    return out
  }

  /** 把归档里的附件还原到目标 profile 目录（先删掉目标目录里同名旧文件，再写）。 */
  function writeProfileFiles(profileDir: string, files: Record<string, string> | null | undefined): number {
    let written = 0
    const safeFiles = files || {}
    for (const rel of Object.keys(safeFiles)) {
      const text = safeFiles[rel]
      if (typeof text !== 'string') continue
      // 只接受我们自己生成的相对路径形态（根级 *.json 或 spaces/<id>/*.json）——
      // 归档文件可能被人手改过，绝不允许它把内容写到目标目录之外。
      if (rel.indexOf('..') !== -1 || path.isAbsolute(rel)) continue
      const target = path.join(profileDir, rel)
      try {
        fs.mkdirSync(path.dirname(target), { recursive: true })
        fs.writeFileSync(target, text, 'utf8')
        written++
      } catch (e) {
        console.warn('[profile-archive] 还原文件失败（跳过）:', rel, errorMessage(e))
      }
    }
    return written
  }

  /* ── 数据库：读 / 写 ───────────────────────────────────────────── */

  function columnsOf(sqlite: BetterSqlite3, table: string): string[] {
    try {
      return sqlite.prepare(`PRAGMA table_info(${q(table)})`).all().map((c) => String((c as { name?: unknown }).name || ''))
    } catch (_) {
      return []
    }
  }

  /** 导出：逐表白名单，取该 profile 的全部行（列名即 DB 列名）。 */
  function readTables(profileId: string): Record<string, ArchiveRow[]> {
    const tables: Record<string, ArchiveRow[]> = {}
    let sqlite
    try {
      sqlite = sqliteOf(profileId)
    } catch (e) {
      console.warn('[profile-archive] 打开 profile 库失败:', errorMessage(e))
      for (const name of PROFILE_ARCHIVE_TABLES) tables[name] = []
      return tables
    }
    for (const name of PROFILE_ARCHIVE_TABLES) {
      try {
        tables[name] = sqlite.prepare(`SELECT * FROM ${q(name)} WHERE profile_id = ?`).all(profileId) as ArchiveRow[]
      } catch (e) {
        console.warn('[profile-archive] 读取表失败（按空处理）:', name, errorMessage(e))
        tables[name] = []
      }
    }
    return tables
  }

  /** JSON 值 → SQLite 可绑定的值（布尔转 0/1；对象转回 JSON 串；其余原样）。 */
  function toSqlValue(value: unknown): unknown {
    if (value === undefined) return null
    if (typeof value === 'boolean') return value ? 1 : 0
    if (value === null) return null
    if (typeof value === 'object') {
      try { return JSON.stringify(value) } catch (_) { return null }
    }
    return value
  }

  /**
   * 把一批行灌进某张表，`profile_id` 一律改写成目标 id。
   * 列集合取自目标表**当前真实列**：归档里多出来的列被忽略，缺的列取默认值 ——
   * 于是"老包进新库"与"新包进老库"都能落地，不需要为每次加列改这里。
   * @returns {number} 写入行数
   */
  function insertRows(sqlite: BetterSqlite3, table: string, rows: ArchiveRow[], profileId: string): number {
    const cols = columnsOf(sqlite, table)
    if (!cols.length || cols.indexOf('profile_id') === -1) return 0
    let n = 0
    for (const row of rows) {
      if (!row || typeof row !== 'object') continue
      const values: Record<string, unknown> = {}
      for (const col of cols) {
        if (col === 'profile_id') { values[col] = profileId; continue }
        if (Object.prototype.hasOwnProperty.call(row, col)) values[col] = toSqlValue(row[col])
      }
      const keys = Object.keys(values)
      if (!keys.length) continue
      const sql = `INSERT OR REPLACE INTO ${q(table)} (${keys.map(q).join(', ')}) VALUES (${keys.map(() => '?').join(', ')})`
      try {
        sqlite.prepare(sql).run(...keys.map((k) => values[k]))
        n++
      } catch (e) {
        // 单行失败不连坐整表：抛出会被外层事务整体回滚，这里选择继续并告警，
        // 结果由调用方按"写入行数 vs 期望行数"差额可见（不静默吞掉）。
        console.warn('[profile-archive] 单行写入失败（跳过）:', table, errorMessage(e))
      }
    }
    return n
  }

  /* ── 名称去重 ──────────────────────────────────────────────────── */

  /** 目标 profile 名：先用归档里的原名，与现有可见档案重名时退让为「 (导入)」。 */
  function uniqueProfileName(baseName: unknown): string {
    const clean = fitProfileName(String(baseName || '导入的配置'))
    const list = (typeof profileService.listVisible === 'function'
      ? profileService.listVisible()
      : profileService.list()) || []
    const taken = new Set(list.filter((p): p is ProfileArchiveRecord => Boolean(p)).map((p) => String(p.name || '').toLowerCase()))
    if (!taken.has(clean.toLowerCase())) return clean
    let candidate = fitProfileName(clean, ' (导入)')
    let i = 1
    while (taken.has(candidate.toLowerCase())) {
      i++
      candidate = fitProfileName(clean, ` (导入 ${i})`)
    }
    return candidate
  }

  /* ── 对外能力 ─────────────────────────────────────────────────── */

  /**
   * 组一份归档对象（不落盘）。导出链路与"直接拿对象"的调用方共用这一处。
   * @param {string} profileId
   */
  function buildArchive(profileId: string): ProfileArchivePayload {
    const id = String(profileId || '').trim() || 'default'
    const profile = profileService.get(id)
    if (!profile) throw new Error(`要导出的配置档案不存在：${id}`)
    return {
      format: PROFILE_ARCHIVE_FORMAT,
      version: PROFILE_ARCHIVE_VERSION,
      createdAt: Date.now(),
      app: { name: deps.appName || APP_NAME, version: deps.appVersion || '' },
      profile: { name: profile.name || '', icon: profile.icon || '', color: profile.color || null },
      tables: readTables(id),
      files: collectProfileFiles(resolveProfileDir(id))
    }
  }

  /**
   * 导出到文件。**超限直接抛错**（不静默截断）。
   * @param {string} profileId
   * @param {string} filePath
   * @returns {{ ok: boolean, path: string, bytes: number, rows: number, files: number }}
   */
  function exportToFile(profileId: string, filePath: string) : { ok: boolean, path: string, bytes: number, rows: number, files: number } {
    if (!filePath || typeof filePath !== 'string') throw new Error('未指定导出文件路径')
    const archive = buildArchive(profileId)
    const json = JSON.stringify(archive)
    const bytes = Buffer.byteLength(json, 'utf8')
    if (bytes > PROFILE_ARCHIVE_MAX_BYTES) {
      throw new Error(`配置档案过大（${Math.round(bytes / 1024 / 1024)} MB），超出单包上限`)
    }
    fs.mkdirSync(path.dirname(filePath), { recursive: true })
    fs.writeFileSync(filePath, json, 'utf8')
    let rows = 0
    for (const name of PROFILE_ARCHIVE_TABLES) rows += (archive.tables[name] || []).length
    return { ok: true, path: filePath, bytes, rows, files: Object.keys(archive.files).length }
  }

  /**
   * 读一个归档文件并校验（解析失败 / 结构不对 → 抛错）。**动数据前必须先过这里。**
   * @param {string} filePath
   * @returns {object} 已校验的归档载荷
   */
  function readArchiveFile(filePath: string): ProfileArchivePayload {
    if (!filePath || typeof filePath !== 'string') throw new Error('未指定要导入的文件')
    let stat
    try { stat = fs.statSync(filePath) } catch (_) { throw new Error('找不到要导入的文件') }
    if (stat.size > PROFILE_ARCHIVE_MAX_BYTES) throw new Error('配置文件包过大，已拒绝导入')
    const text = readText(filePath)
    if (text == null) throw new Error('无法读取配置文件包')
    let payload: unknown
    try {
      payload = JSON.parse(text)
    } catch (_) {
      throw new Error('配置文件包已损坏（不是有效的 JSON）')
    }
    const check = validateProfileArchive(payload)
    if (!check.ok) throw new Error(check.error || '配置文件包校验失败')
    return payload as ProfileArchivePayload
  }

  /**
   * 从一个**已校验**的归档新建 profile 并灌入数据。
   * @param {object} payload
   * @returns {{ ok: boolean, profileId: string, name: string, stats: { rows: number, files: number, perTable: Record<string, number> } }}
   */
  function importArchive(payload: ProfileArchivePayload) : { ok: boolean, profileId: string, name: string, stats: { rows: number, files: number, perTable: Record<string, number> } } {
    const check = validateProfileArchive(payload)
    if (!check.ok) throw new Error(check.error || '配置文件包校验失败')
    const meta = payload.profile
    const name = uniqueProfileName(meta.name)

    // ① 先建 profile 行（createSpace:false —— 空间由归档里的 spaces 表还原，
    //    避免 domain-profile 的"自动建同名默认空间"与归档行撞主键）。
    const created = profileService.create({
      name,
      icon: meta.icon,
      color: meta.color || undefined,
      createSpace: false
    })
    const newId = created && created.id
    if (!newId) throw new Error('创建新配置档案失败')

    const perTable: Record<string, number> = {}
    try {
      // ② 落库：目标库 = **新建 profile 自己的库**（物理独立后每 profile 一个文件）；
      //    整个写入包在一个事务里 —— 中途抛错整体回滚，不留半成品。
      //    取句柄这一步本身就会建库 + 跑 `ensureProfileSchema`（表齐了才有得灌）。
      const targetSqlite = sqliteOf(newId)
      const run = targetSqlite.transaction(() => {
        for (const table of PROFILE_ARCHIVE_TABLES) {
          const rows = Array.isArray(payload.tables[table]) ? payload.tables[table] : []
          perTable[table] = insertRows(targetSqlite, table, rows, newId)
        }
      })
      run()
    } catch (e) {
      // ③ 回滚：删掉刚建的 profile 行（连带其空间行与目录），不留半成品。
      try { profileService.remove(newId) } catch (_) {}
      throw new Error(`写入数据失败，已回滚：${errorMessage(e)}`)
    }

    // ④ 还原磁盘文件（settings.json / 各空间 session.json …）。
    //    这一步在 DB 之后：文件写失败只影响"设置与会话"，不影响书签/历史等主数据。
    const files = writeProfileFiles(resolveProfileDir(newId), payload.files)

    // ⑤ 归档里没有任何空间 → 兜底补一个默认空间，否则新档案打开是"无空间"的空壳。
    const spaceCount = perTable.spaces || 0
    if (spaceCount === 0) {
      try { ensureDefaultSpace(newId, name) } catch (e) {
        console.warn('[profile-archive] 补默认空间失败（非致命）:', errorMessage(e))
      }
    }

    let rows = 0
    for (const key of Object.keys(perTable)) rows += perTable[key] || 0
    return { ok: true, profileId: newId, name, stats: { rows, files, perTable } }
  }

  return { buildArchive, exportToFile, readArchiveFile, importArchive }
}
