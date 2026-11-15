/**
 * Bookmark 自动备份特性模块 —— main/ 特性同构（对齐 settings/external-games）。
 *
 * 职责（老版 Hira bookmarkConverter.js 的现代化重写）：
 *   - 变更标脏 + 防抖：书签变更后 DELAY_MS 才写盘，连续操作只落一份快照
 *   - 时间戳备份对：HTML（Netscape 格式，domain.exportHtml 产出）+ meta JSON
 *     （pinned 列表 —— HTML 格式表达不了的 NG 状态）
 *   - 保留策略：默认保留最近 10 份
 *   - 恢复：先清后灌（clearAll → importHtml → pinned 按 URL 重挂）
 *
 * 分层：磁盘操作全部走 FilePort（IO 端口），逻辑拆在 BackupStore（纯函数可测）；
 * IPC 由 main/ipc/bookmarks-backup.js 注册 —— 本模块不 touch electron。
 */

import type { FilePort } from '@hira-ng/infra-fs'
import type { createBookmarkService } from '@hira-ng/domain-bookmark'
import {
  MIN_BACKUP_SIZE,
  createBackupStore,
  type BackupListEntry,
  type WrittenBackup
} from './BackupStore'

type BookmarkServicePort = ReturnType<typeof createBookmarkService>

export interface BookmarkBackupDependencies {
  bookmarkService: BookmarkServicePort
  filePort: FilePort
  backupRoot: string
}

export interface BookmarkBackupOptions {
  keep?: number
  debounceMs?: number
  minIntervalMs?: number
}

export interface BookmarkBackupResult extends Partial<WrittenBackup> {
  ok: boolean
  reason?: string
  skipped?: 'empty' | 'error'
}

export interface BookmarkRestoreResult {
  ok: boolean
  error?: string
  cleared?: number
  imported?: number
  pinnedRestored?: number
}

export interface BookmarkBackupFeature {
  start(): void
  stop(): void
  flush(): void
  backupNow(reason?: string): BookmarkBackupResult
  listBackups(): BackupListEntry[]
  restore(fileName: string): BookmarkRestoreResult
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** 变更标脏后的防抖延时（ms）—— 连续批量导入只落一份 */
const DIRTY_DEBOUNCE_MS = 30 * 1000

/** 两次自动备份的最小间隔（ms）—— 即使持续标脏也不高频写盘 */
const MIN_BACKUP_INTERVAL_MS = 6 * 60 * 60 * 1000

/**
 */
export function createBookmarkBackupFeature(
  deps: BookmarkBackupDependencies,
  options: BookmarkBackupOptions = {}
): BookmarkBackupFeature {
  const { bookmarkService, filePort, backupRoot } = deps
  const keep = options.keep ?? 10
  const debounceMs = options.debounceMs ?? DIRTY_DEBOUNCE_MS
  const minIntervalMs = options.minIntervalMs ?? MIN_BACKUP_INTERVAL_MS

  const store = createBackupStore(filePort)

  let dirtyTimer: NodeJS.Timeout | null = null
  let lastBackupAt = 0
  let unsubscribe: (() => void) | null = null

  /**
   * 立即备份一次。
   */
  function backupNow(reason = 'auto'): BookmarkBackupResult {
    try {
      const html = bookmarkService.exportHtml()
      if (!html || html.length < MIN_BACKUP_SIZE) {
        return { ok: false, skipped: 'empty' }
      }
      filePort.mkdirSync(backupRoot)
      const pinned = bookmarkService.listPinned()
        .map((bookmark) => ({ url: bookmark.url || '' }))
        .filter((bookmark) => bookmark.url.length > 0)
      const all = bookmarkService.listAll()
      const meta = store.buildMeta({ pinned, count: all.length, exportedAt: Date.now() })
      const written = store.writeBackup(backupRoot, new Date(), html, meta)
      lastBackupAt = Date.now()
      store.applyRetention(backupRoot, keep)
      return { ok: true, reason, ...written }
    } catch (e) {
      console.error('[bookmark-backup] backupNow failed:', errorMessage(e))
      return { ok: false, skipped: 'error' }
    }
  }

  function scheduleBackup(): void {
    if (dirtyTimer) return
    dirtyTimer = setTimeout(() => {
      dirtyTimer = null
      // 最小间隔保护：刚备份过就不因一次小改动再写盘
      if (Date.now() - lastBackupAt < minIntervalMs) return
      backupNow('auto')
    }, debounceMs)
    // 不持有事件循环：进程退出时若 timer 还挂着，before-quit 另有 flush 兜底
    if (dirtyTimer.unref) dirtyTimer.unref()
  }

  return {
    /** 启动：订阅书签变更 + 启动时若超过最小间隔补一次备份 */
    start() {
      if (unsubscribe) return
      unsubscribe = bookmarkService.subscribe(() => scheduleBackup())
      if (Date.now() - lastBackupAt >= minIntervalMs) backupNow('startup')
    },
    stop() {
      if (unsubscribe) { unsubscribe(); unsubscribe = null }
      if (dirtyTimer) { clearTimeout(dirtyTimer); dirtyTimer = null }
    },
    /** 退出前兜底：丢弃防抖延时立即落盘 */
    flush() {
      if (dirtyTimer) {
        clearTimeout(dirtyTimer)
        dirtyTimer = null
        backupNow('flush')
      }
    },
    backupNow,
    /** @returns {Array<{file:string, metaFile:string|null, timestamp:string, size:number, mtimeMs:number}>} */
    listBackups(): BackupListEntry[] {
      return store.listBackups(backupRoot)
    },
    /**
     * 从指定备份恢复（先清后灌 + pinned 重挂）。
     */
    restore(fileName: string): BookmarkRestoreResult {
      const backups = store.listBackups(backupRoot)
      const entry = backups.find((b) => b.file === fileName)
      if (!entry) return { ok: false, error: 'backup not found' }
      // 恢复前先把现状留一份，防呆
      backupNow('before-restore')
      const { html, meta } = store.readBackup(backupRoot, entry)
      const cleared = bookmarkService.clearAll()
      const { imported } = bookmarkService.importHtml(html || '')
      let pinnedRestored = 0
      if (meta && Array.isArray(meta.pinnedURLs)) {
        for (const url of meta.pinnedURLs) {
          const hit = bookmarkService.getByUrl(url)
          if (hit) {
            bookmarkService.setPinned(hit.id, true)
            pinnedRestored++
          }
        }
      }
      return { ok: true, cleared, imported, pinnedRestored }
    }
  }
}

