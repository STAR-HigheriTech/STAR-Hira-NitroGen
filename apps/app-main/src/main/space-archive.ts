/**
 * space-archive.js — 单个工作空间的导出 / 导入（F-0961 / F-0984 / F-0985 / F-0987~F-0989）。
 *
 * ── 它是什么、不是什么 ────────────────────────────────────────────
 * 「导出」= 把一个空间的**元数据 + 该空间目录下的 settings/session JSON**
 * 打包成一个自描述 JSON；「导入」= 从 JSON 在**指定 profile 下新建**一个空间，
 * 并把文件还原到新空间目录。它是一台数据搬运机，不认识 Electron、不认识设置页 ——
 * 文件对话框与 IPC 路由在 `ipc/space-archive.js`，格式/校验在
 * `@hira-ng/shared-types/src/space-archive.mjs`。
 *
 * ── 导入的三条铁律（与 profile-archive 同一纪律）──────────────────
 *   ① **先校验再动手**：`readArchiveFile` 解析后立刻跑 `validateSpaceArchive`；
 *   ② **只新建、绝不覆盖**：空间 id 由 `allocateSpaceId` 让步（`-2`/`-3`…），
 *      名称由 `uniqueSpaceName` 让步（` (导入)`）—— 最坏结果只是"多了一个空间"；
 *   ③ **失败可回滚**：空间行建好之后若还原文件抛错，删掉刚建的空间行与目录。
 *
 * ── 为什么只带空间目录下的 JSON ───────────────────────────────────
 * `profiles/<pid>/spaces/<sid>/` 是本应用自己的目录（Chromium 的 Cookie/缓存/
 * Local Storage 都在 profile 根目录，不在空间目录里），因此按白名单
 * `settings.json` / `session.json` / `session-w<n>.json` 取文件即可 ——
 * 既不会把机器相关状态卷进来，也不需要长长的排除名单。
 */

import fs from 'node:fs'
import path from 'node:path'
import type { Dirent } from 'node:fs'
import {
  SPACE_ARCHIVE_FORMAT,
  SPACE_ARCHIVE_VERSION,
  SPACE_ARCHIVE_MAX_BYTES,
  SPACE_ARCHIVE_FILE_PATTERN,
  fitSpaceName,
  allocateSpaceId,
  normalizeSpaceId,
  validateSpaceArchive
} from '@hira-ng/shared-types/src/space-archive.mjs'
import { createSpaceService, type SpaceRecord } from '@hira-ng/domain-space'
import { APP_NAME } from '@hira-ng/shared-types/src/associations.mjs'

export interface SpaceArchivePayload {
  format: string
  version: number
  createdAt: number
  app: { name: string; version: string }
  space: {
    id: string
    name: string
    icon: string
    bgStartColor: string
    bgEndColor: string
  }
  files: Record<string, string>
}

export interface SpaceArchiveDependencies {
  spaceService: ReturnType<typeof createSpaceService>
  resolveProfileDir(profileId: string): string
  flushSessions?(): void
  appName?: string
  appVersion?: string
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

export function createSpaceArchive(deps: SpaceArchiveDependencies) {
  const { spaceService, resolveProfileDir } = deps
  if (!spaceService || typeof resolveProfileDir !== 'function') {
    throw new Error('[space-archive] 缺少必需依赖（spaceService / resolveProfileDir）')
  }

  /**
   * 导出前把**内存里的会话**同步落盘。
   * 会话持久化是「脏标记 + 2s 批量 flush」（D8），刚改完标签就点导出时，
   * 磁盘上可能还是上一版 —— 不 flush 就会导出一个"看起来少几个标签"的空间。
   * 端口可选：没有会话系统的宿主（如单测）直接跳过。
   */
  const flushSessions = typeof deps.flushSessions === 'function' ? deps.flushSessions : () => {}

  /** 空间目录 = `profiles/<pid>/spaces/<sid>`（与 settings overlay / session 同口径）。 */
  const spaceDirOf = (profileId: string, spaceId: unknown): string => path.join(
    resolveProfileDir(profileId), 'spaces', String(spaceId)
  )

  const isDir = (p: string): boolean => {
    try { return fs.statSync(p).isDirectory() } catch (_) { return false }
  }

  const readText = (p: string): string | null => {
    try { return fs.readFileSync(p, 'utf8') } catch (_) { return null }
  }

  /* ── 磁盘：读 / 写 ─────────────────────────────────────────────── */

  /**
   * 收集空间目录下的白名单 JSON（文件名 → 内容）。
   * 目录不存在 = 空（空间刚建、还没写过设置/会话），不是错误。
   * @param {string} profileId
   * @param {string} spaceId
   * @returns {Record<string,string>}
   */
  function collectSpaceFiles(profileId: string, spaceId: unknown): Record<string, string> {
    const dir = spaceDirOf(profileId, spaceId)
    const out: Record<string, string> = {}
    if (!isDir(dir)) return out
    let entries: Dirent[] = []
    try { entries = fs.readdirSync(dir, { withFileTypes: true }) } catch (_) { return out }
    for (const entry of entries) {
      if (!entry.isFile() || !SPACE_ARCHIVE_FILE_PATTERN.test(entry.name)) continue
      const text = readText(path.join(dir, entry.name))
      if (text != null) out[entry.name] = text
    }
    return out
  }

  /**
   * 把归档里的文件还原到空间目录。
   * 文件名必须**同时**过白名单与 `basename` 判定（归档可能被手改，
   * 绝不允许它把内容写到目标目录之外）。
   *
   * **原子性**：任何一个文件写失败都抛错 —— 调用方据此回滚整个导入。
   * 「写进去一半」的空间比"没导入"更糟：用户会拿到一个看似成功、
   * 实际设置/会话缺一块的空间，且无从判断缺了什么。
   * @returns {number} 写入文件数
   */
  function writeSpaceFiles(dir: string, files: Record<string, string> | null | undefined): number {
    let written = 0
    const safeFiles = files || {}
    for (const name of Object.keys(safeFiles)) {
      const text = safeFiles[name]
      if (typeof text !== 'string') continue
      if (!SPACE_ARCHIVE_FILE_PATTERN.test(name) || name !== path.basename(name)) continue
      fs.mkdirSync(dir, { recursive: true })
      fs.writeFileSync(path.join(dir, name), text, 'utf8')
      written++
    }
    return written
  }

  /* ── 名称去重 ──────────────────────────────────────────────────── */

  /** 目标空间名：先用归档里的原名，与目标 profile 现有空间重名时退让为「 (导入)」。 */
  function uniqueSpaceName(profileId: string, baseName: unknown): string {
    const clean = fitSpaceName(String(baseName || '导入的空间')) || '导入的空间'
    const taken = new Set(
      (spaceService.list(profileId) || []).map((s: SpaceRecord) => String((s && s.name) || '').toLowerCase())
    )
    if (!taken.has(clean.toLowerCase())) return clean
    let candidate = fitSpaceName(clean, ' (导入)')
    let i = 1
    while (taken.has(candidate.toLowerCase())) {
      i++
      candidate = fitSpaceName(clean, ` (导入 ${i})`)
    }
    return candidate
  }

  /* ── 对外能力 ─────────────────────────────────────────────────── */

  /**
   * 组一份归档对象（不落盘）。导出链路与"直接拿对象"的调用方共用这一处。
   * @param {string} profileId
   * @param {string} spaceId
   * @returns {object}
   */
  function buildArchive(profileId: string, spaceId: unknown): SpaceArchivePayload {
    const pid = normalizeSpaceId(profileId)
    const sid = normalizeSpaceId(spaceId)
    if (!pid || !sid) throw new Error('要导出的空间参数无效')
    const space = spaceService.get(pid, sid)
    if (!space) throw new Error(`要导出的空间不存在：${sid}`)
    return {
      format: SPACE_ARCHIVE_FORMAT,
      version: SPACE_ARCHIVE_VERSION,
      createdAt: Date.now(),
      app: { name: deps.appName || APP_NAME, version: deps.appVersion || '' },
      space: {
        id: space.id,
        name: space.name || '',
        icon: space.icon || '',
        bgStartColor: space.bgStartColor || '',
        bgEndColor: space.bgEndColor || ''
      },
      files: collectSpaceFiles(pid, sid)
    }
  }

  /**
   * 导出到文件。**超限直接抛错**（不静默截断）。
   * @param {string} profileId
   * @param {string} spaceId
   * @param {string} filePath
   * @returns {{ ok: boolean, path: string, bytes: number, files: number }}
   */
  function exportToFile(profileId: string, spaceId: unknown, filePath: string) : { ok: boolean, path: string, bytes: number, files: number } {
    if (!filePath || typeof filePath !== 'string') throw new Error('未指定导出文件路径')
    try { flushSessions() } catch (_) {}
    const archive = buildArchive(profileId, spaceId)
    const json = JSON.stringify(archive)
    const bytes = Buffer.byteLength(json, 'utf8')
    if (bytes > SPACE_ARCHIVE_MAX_BYTES) {
      throw new Error(`空间包过大（${Math.round(bytes / 1024 / 1024)} MB），超出单包上限`)
    }
    fs.mkdirSync(path.dirname(filePath), { recursive: true })
    fs.writeFileSync(filePath, json, 'utf8')
    return { ok: true, path: filePath, bytes, files: Object.keys(archive.files).length }
  }

  /**
   * 读一个空间包并校验（解析失败 / 结构不对 → 抛错）。**动数据前必须先过这里。**
   * @param {string} filePath
   * @returns {object} 已校验的归档载荷
   */
  function readArchiveFile(filePath: string): SpaceArchivePayload {
    if (!filePath || typeof filePath !== 'string') throw new Error('未指定要导入的文件')
    let stat
    try { stat = fs.statSync(filePath) } catch (_) { throw new Error('找不到要导入的文件') }
    if (stat.size > SPACE_ARCHIVE_MAX_BYTES) throw new Error('空间包过大，已拒绝导入')
    const text = readText(filePath)
    if (text == null) throw new Error('无法读取空间包')
    let payload: unknown
    try {
      payload = JSON.parse(text)
    } catch (_) {
      throw new Error('空间包已损坏（不是有效的 JSON）')
    }
    const check = validateSpaceArchive(payload)
    if (!check.ok) throw new Error(check.error || '空间包校验失败')
    return payload as SpaceArchivePayload
  }

  /**
   * 从一个**已校验**的空间包，在指定 profile 下新建空间并还原文件。
   * @param {string} profileId 目标 profile
   * @param {object} payload
   * @returns {{ ok: boolean, spaceId: string, name: string, files: number }}
   */
  function importArchive(profileId: string, payload: SpaceArchivePayload) : { ok: boolean, spaceId: string, name: string, files: number } {
    const pid = normalizeSpaceId(profileId)
    if (!pid) throw new Error('目标配置文件无效')
    const check = validateSpaceArchive(payload)
    if (!check.ok) throw new Error(check.error || '空间包校验失败')

    const meta = payload.space || { id: '', name: '', icon: '', bgStartColor: '', bgEndColor: '' }
    const existing = (spaceService.list(pid) || []).map((s: SpaceRecord) => s.id)
    const spaceId = allocateSpaceId(meta.id, existing)
    const name = uniqueSpaceName(pid, meta.name)

    const created = spaceService.create(pid, {
      id: spaceId,
      name,
      icon: meta.icon,
      bgStartColor: meta.bgStartColor,
      bgEndColor: meta.bgEndColor
    })
    if (!created || !created.ok) {
      throw new Error(`创建空间失败：${(created && created.reason) || '未知原因'}`)
    }

    const dir = spaceDirOf(pid, spaceId)
    let files = 0
    try {
      files = writeSpaceFiles(dir, payload.files)
    } catch (e) {
      // ③ 回滚：删掉刚建的空间行与目录，不留半成品
      try { spaceService.remove(pid, spaceId) } catch (_) {}
      try { fs.rmSync(dir, { recursive: true, force: true }) } catch (_) {}
      throw new Error(`还原空间文件失败，已回滚：${errorMessage(e)}`)
    }

    return { ok: true, spaceId, name, files }
  }

  return { buildArchive, exportToFile, readArchiveFile, importArchive }
}
