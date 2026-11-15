/**
 * BookmarkBackupStore —— 备份纯逻辑（零 fs / 零 electron，FilePort 注入）。
 *
 * 从老版 Hira bookmarkConverter.js 继承的三条铁律：
 *   1. 文件名带时间戳 `bookmarksBackup-YYYYMMDD-HHMMSS.html`，HTML + meta JSON 配对
 *   2. 备份目录统一 `${backupRoot}/`，保留最近 N 份，删旧不删配对
 *   3. 空/异常小的 HTML 不值得备份（< 60 字节 ≈ 只有 Netscape 文件头）
 *
 * 本模块只做"判断与命名"，所有磁盘操作经 filePort —— 可被内存假端口全量测试。
 */

import type { FilePort } from '@hira-ng/infra-fs'

export interface BackupFileEntry {
  file: string
  metaFile: string | null
  timestamp: string
}

export interface BackupListEntry extends BackupFileEntry {
  size: number
  mtimeMs: number
}

export interface BackupMeta {
  version: 1
  exportedAt: number
  count: number
  pinnedURLs: string[]
}

export interface BackupSnapshot {
  pinned: Array<{ url: string }>
  count: number
  exportedAt: number
}

export interface WrittenBackup {
  htmlPath: string
  metaPath: string
}

export interface ReadBackupResult {
  html: string
  meta: BackupMeta | null
}

export interface BackupStore {
  filterBackupFiles: typeof filterBackupFiles
  pickStale: typeof pickStale
  buildMeta: typeof buildMeta
  formatTimestamp: typeof formatTimestamp
  MIN_BACKUP_SIZE: number
  writeBackup(dir: string, now: Date, html: string, meta: BackupMeta): WrittenBackup
  listBackups(dir: string): BackupListEntry[]
  applyRetention(dir: string, keep: number): string[]
  readBackup(dir: string, entry: Pick<BackupFileEntry, 'file' | 'metaFile'>): ReadBackupResult
}

/** 备份 HTML 文件名正则：bookmarksBackup-YYYYMMDD-HHMMSS.html */
const BACKUP_FILE_RE = /^bookmarksBackup-(\d{8}-\d{6})\.html$/

/** meta 配对扩展名 */
const META_EXT = '.json'

/** 最小有效备份体积（低于此视为空书签，跳过备份） */
export const MIN_BACKUP_SIZE = 60

/**
 * @param {Date} date
 * @returns {string} YYYYMMDD-HHMMSS（本地时间）
 */
export function formatTimestamp(date: Date): string {
  const p = (n: number, w = 2): string => String(n).padStart(w, '0')
  return (
    `${date.getFullYear()}${p(date.getMonth() + 1)}${p(date.getDate())}` +
    `-` +
    `${p(date.getHours())}${p(date.getMinutes())}${p(date.getSeconds())}`
  )
}

/**
 * 从目录文件名列表筛出有效备份（HTML + meta 配对）。
 * @param {string[]} names  readdirSync 结果
 * @returns {Array<{file: string, metaFile: string|null, timestamp: string}>}
 */
export function filterBackupFiles(names: string[]): BackupFileEntry[] {
  const metas = new Set(names.filter((n) => n.endsWith('.json')))
  const backups: BackupFileEntry[] = []
  for (const name of names) {
    const m = BACKUP_FILE_RE.exec(name)
    if (!m) continue
    const metaFile = name + META_EXT
    backups.push({
      file: name,
      metaFile: metas.has(metaFile) ? metaFile : null,
      timestamp: m[1]
    })
  }
  // 时间戳字符串天然可排序
  backups.sort((a, b) => (a.timestamp < b.timestamp ? 1 : -1))
  return backups
}

/**
 * 保留策略：超出 keep 份的最旧备份（连 meta 一起删）。
 * @param {Array<{file: string, metaFile: string|null, timestamp: string}>} backups  已按新→旧排序
 * @param {number} keep
 * @returns {string[]} 待删除文件名（含 meta）
 */
export function pickStale(backups: BackupFileEntry[], keep: number): string[] {
  const stale = []
  for (const b of backups.slice(keep)) {
    stale.push(b.file)
    if (b.metaFile) stale.push(b.metaFile)
  }
  return stale
}

/**
 * 构造 meta 快照（与 HTML 配对保存的"HTML 表达不了的状态"）。
 * @param {{ pinned: Array<{url: string}>, count: number, exportedAt: number }} snapshot
 * @returns {object}
 */
export function buildMeta(snapshot: BackupSnapshot): BackupMeta {
  return {
    version: 1,
    exportedAt: snapshot.exportedAt,
    count: snapshot.count,
    pinnedURLs: snapshot.pinned.map((p) => p.url).filter(Boolean)
  }
}

/**
 * @param {ReturnType<import('@hira-ng/infra-fs').createFilePort>} filePort
 */
export function createBackupStore(filePort: FilePort): BackupStore {
  return {
    filterBackupFiles,
    pickStale,
    buildMeta,
    formatTimestamp,
    MIN_BACKUP_SIZE,
    /**
     * 写一对备份文件（HTML 直写 + meta 原子写）。
     * @param {string} dir
     * @param {Date} now
     * @param {string} html
     * @param {object} meta
     * @returns {{htmlPath: string, metaPath: string}}
     */
    writeBackup(dir: string, now: Date, html: string, meta: BackupMeta): WrittenBackup {
      const ts = formatTimestamp(now)
      const htmlPath = filePort.join(dir, `bookmarksBackup-${ts}.html`)
      const metaPath = htmlPath + META_EXT
      filePort.writeFileSync(htmlPath, html)
      filePort.writeJsonAtomicSync(metaPath, meta)
      return { htmlPath, metaPath }
    },
    /**
     * 枚举备份清单（新→旧），附 size/mtime。
     * @param {string} dir
     */
    listBackups(dir: string): BackupListEntry[] {
      const names = filePort.readdirSync(dir)
      return filterBackupFiles(names).map((b) => {
        const st = filePort.statSync(filePort.join(dir, b.file))
        return { ...b, size: st ? st.size : 0, mtimeMs: st ? st.mtimeMs : 0 }
      })
    },
    /**
     * 执行保留策略：删 keep 之外的旧备份。
     * @param {string} dir
     * @param {number} keep
     * @returns {string[]} 已删除文件名
     */
    applyRetention(dir: string, keep: number): string[] {
      const backups = filterBackupFiles(filePort.readdirSync(dir))
      const deleted: string[] = []
      for (const name of pickStale(backups, keep)) {
        if (filePort.unlinkSync(filePort.join(dir, name))) deleted.push(name)
      }
      return deleted
    },
    /**
     * 读取一对备份文件内容。
     * @param {string} dir
     * @param {{file: string, metaFile: string|null}} entry
     */
    readBackup(dir: string, entry: Pick<BackupFileEntry, 'file' | 'metaFile'>): ReadBackupResult {
      const htmlPath = filePort.join(dir, entry.file)
      const html = filePort.readTextSync(htmlPath)
      let meta: BackupMeta | null = null
      if (entry.metaFile) {
        try { meta = filePort.readJsonSync<BackupMeta>(filePort.join(dir, entry.metaFile)) } catch (_) {}
      }
      return { html, meta }
    }
  }
}

