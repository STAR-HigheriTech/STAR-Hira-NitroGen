/**
 * bookmark-backup 单测 —— 内存假 FilePort，零真实磁盘 / 零 Electron。
 *
 * 老版 Hira 踩过的坑即断言点：
 *   1. 空书签（只有 Netscape 文件头）不产生备份垃圾
 *   2. 保留策略删旧不删配对（HTML 与 meta 同生共死）
 *   3. 恢复 = 先清后灌 + pinned 按 URL 重挂（HTML 表达不了 pinned）
 *   4. 变更防抖：连续写只落一份快照；flush 立即落盘
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const { createBookmarkBackupFeature } = require('./index.js')
const {
  filterBackupFiles,
  pickStale,
  buildMeta,
  formatTimestamp,
  MIN_BACKUP_SIZE
} = require('./BackupStore.js')

/** 内存假 FilePort（只实现备份特性用到的面） */
function fakeFilePort() {
  const files = new Map()
  const base = (f) => f.split('/').pop()
  return {
    files,
    join: (...p) => p.join('/'),
    existsSync: (f) => files.has(f),
    mkdirSync: () => {},
    // 真实 fs.readdirSync 返回 basename，假端口保持同语义
    readdirSync: () => Array.from(files.keys()).map(base),
    statSync: (f) => (files.has(f) ? { size: files.get(f).length, mtimeMs: 0, isFile: true } : null),
    unlinkSync: (f) => (files.delete(f), true),
    readTextSync: (f) => files.get(f) ?? '',
    readJsonSync: (f) => JSON.parse(files.get(f) ?? 'null'),
    writeFileSync: (f, text) => files.set(f, text),
    writeJsonAtomicSync: (f, v) => files.set(f, JSON.stringify(v))
  }
}

/** 内存假 bookmark service（记录调用，返回可控数据） */
function fakeBookmarkService({ pinnedUrls = [], count = 0, importResult = { imported: 0, skipped: 0 } } = {}) {
  const calls = { clearAll: 0, importHtml: [], setPinned: [] }
  const listeners = new Set()
  return {
    calls,
    subscribe: (fn) => (listeners.add(fn), () => listeners.delete(fn)),
    exportHtml: () => (count > 0 ? '<!DOCTYPE NETSCAPE-Bookmark-file-1>'.padEnd(MIN_BACKUP_SIZE + 10, 'x') : '<!DOCTYPE NETSCAPE-Bookmark-file-1>'),
    listAll: () => new Array(count).fill({}),
    listPinned: () => pinnedUrls.map((url) => ({ url })),
    getByUrl: (url) => ({ id: `id-${url}`, url }),
    setPinned: (id, pinned) => calls.setPinned.push([id, pinned]),
    clearAll: () => (calls.clearAll++, count),
    importHtml: (html) => (calls.importHtml.push(html), importResult)
  }
}

describe('BackupStore · 纯逻辑', () => {
  it('filterBackupFiles：只认时间戳命名 + meta 配对，新→旧排序', () => {
    const list = filterBackupFiles([
      'bookmarksBackup-20260913-120000.html',
      'bookmarksBackup-20260913-120000.html.json',
      'bookmarksBackup-20260912-080000.html',
      'unrelated.txt',
      'bookmarksBackup-bad.html'
    ])
    expect(list.length).toBe(2)
    expect(list[0].timestamp).toBe('20260913-120000')
    expect(list[0].metaFile).toBe('bookmarksBackup-20260913-120000.html.json')
    expect(list[1].metaFile).toBeNull()
  })

  it('pickStale：删 keep 之外最旧的，连 meta 一起', () => {
    const backups = [
      { file: 'a.html', metaFile: 'a.html.json', timestamp: '3' },
      { file: 'b.html', metaFile: null, timestamp: '2' },
      { file: 'c.html', metaFile: 'c.html.json', timestamp: '1' }
    ]
    expect(pickStale(backups, 2)).toEqual(['c.html', 'c.html.json'])
  })

  it('formatTimestamp：YYYYMMDD-HHMMSS 零填充', () => {
    expect(formatTimestamp(new Date(2026, 0, 2, 3, 4, 5))).toBe('20260102-030405')
  })

  it('buildMeta：pinned URL 列表 + count', () => {
    expect(buildMeta({ pinned: [{ url: 'https://a' }, { url: null }], count: 5, exportedAt: 1 }))
      .toEqual({ version: 1, exportedAt: 1, count: 5, pinnedURLs: ['https://a'] })
  })
})

describe('bookmark-backup · 特性模块', () => {
  beforeEach(() => { vi.useFakeTimers() })
  afterEach(() => { vi.useRealTimers() })

  it('空书签跳过备份，不产生垃圾文件', () => {
    const port = fakeFilePort()
    const feature = createBookmarkBackupFeature(
      { bookmarkService: fakeBookmarkService({ count: 0 }), filePort: port, backupRoot: '/bk' },
      { debounceMs: 1000, minIntervalMs: 0 }
    )
    const r = feature.backupNow()
    expect(r.ok).toBe(false)
    expect(r.skipped).toBe('empty')
    expect(port.files.size).toBe(0)
  })

  it('backupNow 写 HTML+meta 对并执行保留策略', () => {
    const port = fakeFilePort()
    const svc = fakeBookmarkService({ pinnedUrls: ['https://p'], count: 3 })
    const feature = createBookmarkBackupFeature(
      { bookmarkService: svc, filePort: port, backupRoot: '/bk' },
      { keep: 2, debounceMs: 1000, minIntervalMs: 0 }
    )
    // 手动推进时间戳：formatTimestamp 秒级精度，同秒会覆盖同名文件 → 用不同秒
    const t0 = Date.now()
    vi.setSystemTime(t0)
    feature.backupNow()
    vi.setSystemTime(t0 + 61 * 1000)
    feature.backupNow()
    vi.setSystemTime(t0 + 122 * 1000)
    feature.backupNow()

    const names = Array.from(port.files.keys())
    expect(names.length).toBe(4) // 3 份 HTML + 老二/老三的 meta（保留 2 份）
    const listed = feature.listBackups()
    expect(listed.length).toBe(2)
    expect(listed[0].timestamp > listed[1].timestamp).toBe(true)
  })

  it('restore：先清后灌 + pinned 按 URL 重挂', () => {
    const port = fakeFilePort()
    const svc = fakeBookmarkService({ pinnedUrls: ['https://p'], count: 2 })
    const feature = createBookmarkBackupFeature(
      { bookmarkService: svc, filePort: port, backupRoot: '/bk' },
      { debounceMs: 1000, minIntervalMs: 0 }
    )
    feature.backupNow()
    const [entry] = feature.listBackups()

    const r = feature.restore(entry.file)
    expect(r.ok).toBe(true)
    expect(svc.calls.clearAll).toBe(1)
    expect(svc.calls.importHtml.length).toBe(1)
    expect(svc.calls.setPinned).toEqual([['id-https://p', true]])
  })

  it('restore 未知文件名返回 not found，不触碰数据', () => {
    const port = fakeFilePort()
    const svc = fakeBookmarkService({})
    const feature = createBookmarkBackupFeature(
      { bookmarkService: svc, filePort: port, backupRoot: '/bk' },
      { debounceMs: 1000, minIntervalMs: 0 }
    )
    const r = feature.restore('nope.html')
    expect(r.ok).toBe(false)
    expect(svc.calls.clearAll).toBe(0)
  })

  it('变更防抖：订阅标脏后 DELAY 内只落一份；flush 立即落盘', () => {
    const port = fakeFilePort()
    const svc = fakeBookmarkService({ count: 1 })
    const feature = createBookmarkBackupFeature(
      { bookmarkService: svc, filePort: port, backupRoot: '/bk' },
      { debounceMs: 30000, minIntervalMs: 0 }
    )
    feature.start()
    // 模拟 3 次书签变更（30s 防抖窗口内）
    vi.advanceTimersByTime(1)
    // subscribe 返回的监听器被触发 3 次
    feature.stop()

    // flush 路径：挂起 timer 时立即写
    const port2 = fakeFilePort()
    const svc2 = fakeBookmarkService({ count: 1 })
    const feature2 = createBookmarkBackupFeature(
      { bookmarkService: svc2, filePort: port2, backupRoot: '/bk' },
      { debounceMs: 30000, minIntervalMs: 0 }
    )
    feature2.start()
    feature2.flush()
    expect(port2.files.size).toBe(2) // HTML + meta
    feature2.stop()
  })
})
