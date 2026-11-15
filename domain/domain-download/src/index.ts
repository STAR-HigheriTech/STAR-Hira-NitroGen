// @ts-check
/**
 * Domain: Download — 下载记录管理
 *
 * C13: 存储走 infra-db SQLite + Drizzle
 * L1 功能映射: F-0201 创建下载记录 F-0202 更新进度 F-0203 完成下载
 *   F-0204 取消下载 F-0205 列出下载 F-0206 清除已完成 F-0207 打开文件
 */

import { downloads } from '@hira-ng/infra-db/schema'
import {
  and as drizzleAnd,
  desc as drizzleDesc,
  eq as drizzleEq,
  gte as drizzleGte,
  inArray as drizzleInArray
} from 'drizzle-orm'
import { generateId } from '@hira-ng/shared-utils'
import type { DownloadState } from './util'

export type DownloadDanger = 'safe' | 'suspicious' | 'dangerous'

export interface DownloadRecord {
  id: string
  profileId: string
  url: string
  filename: string
  filePath: string | null
  totalBytes: number | null
  receivedBytes: number | null
  state: DownloadState
  mimeType: string | null
  startedAt: number
  completedAt: number | null
  danger: DownloadDanger | null
  referrerUrl: string | null
  multiThreaded: number | null
  connections: number | null
}

interface DownloadInsert {
  id: string
  profileId: string
  url: string
  filename: string
  totalBytes: number | null
  receivedBytes: number
  state: DownloadState
  mimeType: string | null
  startedAt: number
  completedAt: number | null
  danger: DownloadDanger
}

type DownloadPatch = Partial<DownloadRecord>
type QueryCondition = unknown
type BinaryCondition = (column: unknown, value: unknown) => QueryCondition
const eq = drizzleEq as unknown as BinaryCondition
const gte = drizzleGte as unknown as BinaryCondition
const inArray = drizzleInArray as unknown as BinaryCondition
const desc = drizzleDesc as unknown as (column: unknown) => unknown
const and = drizzleAnd as unknown as (...conditions: QueryCondition[]) => QueryCondition

interface RunResult { changes: number }
interface InsertBuilder { values(value: DownloadInsert): { run(): RunResult } }
interface UpdateBuilder { set(value: DownloadPatch): { where(condition: QueryCondition): { run(): RunResult } } }
interface DeleteBuilder { where(condition: QueryCondition): { run(): RunResult } }
interface SelectWhere {
  get(): DownloadRecord | undefined
  all(): DownloadRecord[]
  orderBy(value: unknown): { limit(value: number): { all(): DownloadRecord[] } }
}
interface SelectBuilder { from(table: unknown): { where(condition: QueryCondition): SelectWhere } }

export interface DownloadDatabase {
  insert(table: unknown): InsertBuilder
  update(table: unknown): UpdateBuilder
  delete(table: unknown): DeleteBuilder
  select(): SelectBuilder
}

export interface DownloadServiceOptions { getProfileId?: () => string }

/**
 * @param {import('drizzle-orm/better-sqlite3').BetterSQLite3Database} db
 * @param {{ getProfileId?: () => string }} [options]
 *   getProfileId —— 可选端口：当前 profile（Steam 式多用户的数据分区键）。
 *                   domain 只向 APPS 要一个字符串，不认识窗口/运行单元；缺省 'default'。
 */
function createDownloadService(db: DownloadDatabase, options: DownloadServiceOptions = {}) {
  const now = () => Date.now()
  const profileIdPort = typeof options.getProfileId === 'function' ? options.getProfileId : null

  /**
   * 当前 profile。端口缺失或抛错一律回落 'default' ——
   * **绝不能**「拿不到就不过滤」：那等于跨 profile 串数据。
   * @returns {string}
   */
  function currentProfile() : string {
    if (!profileIdPort) return 'default'
    try {
      const v = profileIdPort()
      return v ? String(v) : 'default'
    } catch (_) {
      return 'default'
    }
  }

  /** profile 分区条件（所有读写都必须带上）。 */
  function profileCond() {
    return eq(downloads.profileId, currentProfile())
  }

  /** 按 id 定位**当前 profile 内**的记录条件。 */
  function byId(id: string): QueryCondition {
    return and(eq(downloads.id, id), profileCond())
  }

  /**
   * Create a new download record.
   * @param {{ url: string, filename: string, totalBytes?: number, mimeType?: string }} input
   * @returns {string}  download ID
   */
  function create(input: { url: string; filename: string; totalBytes?: number; mimeType?: string }): string {
    const id = generateId('dl')
    db.insert(downloads).values({
      id,
      profileId: currentProfile(),
      url: input.url,
      filename: input.filename,
      totalBytes: input.totalBytes ?? null,
      receivedBytes: 0,
      state: 'pending',
      mimeType: input.mimeType ?? null,
      startedAt: now(),
      completedAt: null,
      danger: 'safe'
    }).run()
    return id
  }

  /**
   * Update download progress.
   * @param {string} id
   * @param {number} receivedBytes
   * @param {number} [totalBytes]
   */
  function updateProgress(id: string, receivedBytes: number, totalBytes?: number | null): void {
    const updates: DownloadPatch = { receivedBytes, state: 'in_progress' }
    if (totalBytes != null) updates.totalBytes = totalBytes
    db.update(downloads).set(updates).where(byId(id)).run()
  }

  /**
   * Mark download as completed.
   * @param {string} id
   * @param {string} filePath
   */
  function complete(id: string, filePath: string): void {
    db.update(downloads).set({
      state: 'completed',
      filePath,
      completedAt: now()
    }).where(byId(id)).run()
  }

  /**
   * Mark download as cancelled/interrupted.
   * @param {string} id
   * @param {string} [state='cancelled']
   */
  function cancel(id: string, state: 'cancelled' | 'interrupted' | 'failed' = 'cancelled'): void {
    db.update(downloads).set({
      state,
      completedAt: now()
    }).where(byId(id)).run()
  }

  /**
   * Pause an in-progress download.
   * @param {string} id
   */
  function pause(id: string): void {
    db.update(downloads).set({ state: 'paused' }).where(byId(id)).run()
  }

  /**
   * Resume a paused download.
   * @param {string} id
   */
  function resume(id: string): void {
    db.update(downloads).set({ state: 'in_progress' }).where(byId(id)).run()
  }

  /**
   * Set danger type.
   * @param {string} id
   * @param {string} danger  safe|suspicious|dangerous
   */
  function setDanger(id: string, danger: DownloadDanger): void {
    db.update(downloads).set({ danger }).where(byId(id)).run()
  }

  /**
   * Get a single download.
   */
  function get(id: string): DownloadRecord | null {
    return db.select().from(downloads).where(byId(id)).get() || null
  }

  /**
   * List all downloads of the current profile (most recent first).
   * @param {number} [limit=100]
   */
  function list(limit: number = 100): DownloadRecord[] {
    return db.select().from(downloads)
      .where(profileCond())
      .orderBy(desc(downloads.startedAt))
      .limit(limit)
      .all()
  }

  /**
   * List active/pending downloads.
   */
  function listActive(): DownloadRecord[] {
    return db.select().from(downloads)
      .where(and(profileCond(), inArray(downloads.state, ['pending', 'in_progress'])))
      .all()
  }

  /**
   * Clear completed downloads from records (does NOT delete files).
   * @returns {number}
   */
  function clearCompleted(): number {
    const result = db.delete(downloads)
      .where(and(profileCond(), eq(downloads.state, 'completed')))
      .run()
    return result.changes
  }

  /**
   * Remove a download record.
   * @param {string} id
   * @returns {boolean}
   */
  function remove(id: string): boolean {
    const result = db.delete(downloads).where(byId(id)).run()
    return result.changes > 0
  }

  function removeMany(ids: string[]): number {
    if (!Array.isArray(ids) || ids.length === 0) return 0
    return db.delete(downloads)
      .where(and(profileCond(), inArray(downloads.id, ids))).run().changes
  }

  /**
   * 清空当前 profile 的全部下载记录（不删除已下载文件）。
   * 供「退出时清除下载记录」等隐私清理使用。
   * @returns {number}
   */
  function clearAll(): number {
    const result = db.delete(downloads).where(profileCond()).run()
    return result.changes
  }

  /**
   * 只清掉「最近 N」内的下载记录（startedAt ≥ afterTs），不删除已下载文件。
   * 与 history 的 removeAfter 同语义，供隐私面板的时间范围使用。
   * @param {number} afterTs
   * @returns {number}
   */
  function removeAfter(afterTs: number): number {
    const result = db.delete(downloads)
      .where(and(profileCond(), gte(downloads.startedAt, afterTs))).run()
    return result.changes
  }

  return {
    create,
    updateProgress,
    complete,
    cancel,
    pause,
    resume,
    setDanger,
    get,
    list,
    listActive,
    clearCompleted,
    remove,
    removeMany,
    clearAll,
    removeAfter
  }
}

// ── 下载领域纯逻辑（2026-09-13 自 APPS 层下沉，见 refactor-main-sink-plan.md Step 4）──
// 这些模块零 Electron 依赖：IO 走注入端口，APPS 侧的 download-manager.js 负责
// Electron 事件订阅（will-download / DownloadItem）与对话框/通知等副作用。
import { DANGEROUS_EXTENSIONS, isDangerousFile } from './DangerousFiles'
import { createMcdFactory, DEFAULT_CONNECTIONS, MIN_MULTITHREAD_SIZE, shouldUseMultiThread } from './MultiConnection'
import { createGlobalRateLimiter, getGlobalRateLimiter } from './RateLimiter'
import { createDownloadSecurity } from './Security'
import { createSpeedTracker } from './SpeedTracker'
import * as DownloadUtil from './util'

export * from './DangerousFiles'
export * from './MultiConnection'
export * from './RateLimiter'
export * from './Security'
export * from './SpeedTracker'
export * from './util'
export { createDownloadService }
export const downloadApi = {
  ...DownloadUtil,
  createDownloadService,
  createDownloadSecurity,
  createSpeedTracker,
  createGlobalRateLimiter,
  getGlobalRateLimiter,
  createMcdFactory,
  shouldUseMultiThread,
  DEFAULT_CONNECTIONS,
  MIN_MULTITHREAD_SIZE,
  DANGEROUS_EXTENSIONS,
  isDangerousFile
}
export default downloadApi
