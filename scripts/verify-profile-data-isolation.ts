/**
 * 探针：profile 数据隔离（Steam 式多用户）
 *
 * 守的是「用户 A 与用户 B 的数据真的不互相可见」这条底线 —— 用户视角的验收点，
 * 而不是内部实现。覆盖：
 *   ① 书签 / 历史 / 下载 / favicon 缓存 按 profile 分区读写
 *   ② 站点权限按 profile 取实例（perProfileServices 分发）
 *   ③ 老库（无 profile_id 列、favicons 单列主键）升级后数据不丢，且归入 default
 *   ④ 切回原 profile 数据仍在（分区不是「清空」）
 *
 * 用法：node scripts/verify-profile-data-isolation.cjs
 */
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import type { SettingsFilePort } from '@hira-ng/domain-settings'

const { createDb } = require('@hira-ng/infra-db') as typeof import('@hira-ng/infra-db')
const { createBookmarkService } = require('@hira-ng/domain-bookmark') as typeof import('@hira-ng/domain-bookmark')
const { createHistoryService } = require('@hira-ng/domain-history') as typeof import('@hira-ng/domain-history')
const { createDownloadService } = require('@hira-ng/domain-download') as typeof import('@hira-ng/domain-download')
const { createFaviconService } = require('@hira-ng/domain-favicon') as typeof import('@hira-ng/domain-favicon')
const { createPermissionService } = require('@hira-ng/domain-permission') as typeof import('@hira-ng/domain-permission')
const { createSettingsService, createProfileSettingsOverlay } = require('@hira-ng/domain-settings') as typeof import('@hira-ng/domain-settings')

interface SwitchableScope {
  getProfileId: () => string
  use: (id: string) => void
}

let pass = 0
let fail = 0

function check(label: string, actual: unknown, expected: unknown): void {
  const ok = JSON.stringify(actual) === JSON.stringify(expected)
  if (ok) {
    pass++
    console.log(`PASS  ${label}  实为 ${JSON.stringify(actual)}`)
  } else {
    fail++
    console.log(`FAIL  ${label}  期望 ${JSON.stringify(expected)}，实为 ${JSON.stringify(actual)}`)
  }
}

function tmpDbPath(tag: string): string {
  const p = path.join(os.tmpdir(), `hira-probe-${tag}-${process.pid}-${Date.now()}.db`)
  try { fs.unlinkSync(p) } catch (_) {}
  return p
}

/** 可切换的「当前 profile」—— 模拟 runtimeRegistry.currentProfileId 的行为。 */
function makeSwitchableScope(): SwitchableScope {
  let current = 'default'
  return {
    getProfileId: () => current,
    use: (id: string) => { current = id }
  }
}

/* ────────────────────────────────────────────────────────────────
 * ② 分区读写
 * ──────────────────────────────────────────────────────────────── */
function runPartitionChecks() {
  const dbPath = tmpDbPath('partition')
  const { db, close } = createDb(dbPath)
  const scope = makeSwitchableScope()

  const bookmarkService = createBookmarkService(db as unknown as Parameters<typeof createBookmarkService>[0], { getProfileId: scope.getProfileId })
  const historyService = createHistoryService(db as unknown as Parameters<typeof createHistoryService>[0], { getProfileId: scope.getProfileId })
  const downloadService = createDownloadService(db as unknown as Parameters<typeof createDownloadService>[0], { getProfileId: scope.getProfileId })
  const faviconService = createFaviconService(db as Parameters<typeof createFaviconService>[0], { getProfileId: scope.getProfileId })

  // ── 用户 A ──
  scope.use('alice')
  const aliceBm = bookmarkService.add({ title: 'A 的书签', url: 'https://a.example' })
  historyService.addVisit({ url: 'https://a.example', title: 'A' })
  downloadService.create({ url: 'https://a.example/f.zip', filename: 'f.zip' })
  faviconService.cache('https://a.example', 'https://a.example/fav.ico')

  // ── 用户 B（同一时刻另一个用户的数据）──
  scope.use('bob')
  const bobBm = bookmarkService.add({ title: 'B 的书签', url: 'https://b.example' })
  historyService.addVisit({ url: 'https://b.example', title: 'B' })
  downloadService.create({ url: 'https://b.example/g.zip', filename: 'g.zip' })
  faviconService.cache('https://b.example', 'https://b.example/fav.ico')

  check('B 只看见自己的书签', bookmarkService.listAll().map((b) => b.title), ['B 的书签'])
  check('B 查不到 A 的 URL 书签', bookmarkService.getByUrl('https://a.example'), null)
  check('B 只看见自己的历史', historyService.listRecent().map((h) => h.title), ['B'])
  check('B 只看见自己的下载', downloadService.list().map((d) => d.filename), ['g.zip'])
  check('B 的 favicon 缓存不含 A 的页面', faviconService.get('https://a.example'), { faviconUrl: null, data: null })

  // ── 切回 A：数据还在（分区 ≠ 清空）──
  scope.use('alice')
  check('切回 A：书签仍在', bookmarkService.listAll().map((b) => b.title), ['A 的书签'])
  check('切回 A：历史仍在', historyService.listRecent().map((h) => h.title), ['A'])
  check('切回 A：下载仍在', downloadService.list().map((d) => d.filename), ['f.zip'])
  check('切回 A：favicon 仍在', faviconService.get('https://a.example').faviconUrl, 'https://a.example/fav.ico')
  check('A 看不见 B 的下载（按 id 取也隔离）', downloadService.get(bobBm.id), null)

  // ── 清空只作用于当前 profile ──
  scope.use('alice')
  historyService.clearAll()
  bookmarkService.clearAll()
  downloadService.clearAll()
  check('A 清空后自己为空', historyService.listRecent().length, 0)
  scope.use('bob')
  check('A 的清空没动 B 的历史', historyService.listRecent().map((h) => h.title), ['B'])
  check('A 的清空没动 B 的书签', bookmarkService.listAll().map((b) => b.title), ['B 的书签'])
  check('A 的清空没动 B 的下载', downloadService.list().map((d) => d.filename), ['g.zip'])

  // ── 书签固定栏（pinned）也要分区 ──
  scope.use('bob')
  bookmarkService.setPinned(bobBm.id, true)
  check('B 的书签栏有 1 项', bookmarkService.listPinned().length, 1)
  scope.use('alice')
  check('A 的书签栏为空（不受 B 固定影响）', bookmarkService.listPinned().length, 0)

  // ── 书签搜索（FTS / LIKE 两条路径都要带 profile）──
  scope.use('bob')
  check('B 搜索不到 A 的书签', bookmarkService.search('A 的书签').length, 0)
  check('B 搜索得到自己的书签', bookmarkService.search('B').map((b) => b.title), ['B 的书签'])

  void aliceBm
  close()
  try { fs.unlinkSync(dbPath) } catch (_) {}
}

/* ────────────────────────────────────────────────────────────────
 * ③ 站点权限：按 profile 取实例
 * ──────────────────────────────────────────────────────────────── */
function runPermissionChecks() {
  const dbPath = tmpDbPath('perm')
  const { db, close } = createDb(dbPath)

  // 与 main.js 的 perProfileServices 同构：一个 profile 一个实例
  const cache = new Map<string, ReturnType<typeof createPermissionService>>()
  const permissionOf = (pid: string) => {
    let svc = cache.get(pid)
    if (!svc) {
      svc = createPermissionService(db as unknown as Parameters<typeof createPermissionService>[0], { profileId: pid })
      cache.set(pid, svc)
    }
    return svc
  }

  permissionOf('alice').setPermission('https://a.example', 'notifications', 'allow')
  permissionOf('bob').setPermission('https://b.example', 'notifications', 'block')

  // 无记录时 domain 返回中性值 'ask'（= 每次重新询问），不是 null。
  // 关键断言是「B 不能继承 A 的 allow」。
  check('A 的授权不被 B 继承', permissionOf('bob').getPermission('https://a.example', 'notifications'), 'ask')
  // domain 列存的是规范化后的域（去掉 scheme），因此断言用 'b.example'。
  check('B 没有任何指向 A 站点的权限行', permissionOf('bob').listAll().map((r) => r.domain), ['b.example'])
  check('B 自己的拦截记录在', permissionOf('bob').getPermission('https://b.example', 'notifications'), 'block')
  check('A 的允许记录在', permissionOf('alice').getPermission('https://a.example', 'notifications'), 'allow')
  check('A 的权限列表只有 1 条', permissionOf('alice').listAll().length, 1)

  close()
  try { fs.unlinkSync(dbPath) } catch (_) {}
}

/* ────────────────────────────────────────────────────────────────
 * ④ 老库升级：既有数据不丢，且归入 default
 * ──────────────────────────────────────────────────────────────── */
function runLegacyMigrationChecks() {
  const dbPath = tmpDbPath('legacy')
  const Database = require('better-sqlite3')

  // 造一个「旧版本」的库：没有 profile_id 列，favicons 是 page_url 单列主键
  {
    const legacy = new Database(dbPath)
    legacy.exec(`
      CREATE TABLE bookmarks (
        id TEXT PRIMARY KEY, parent_id TEXT, title TEXT NOT NULL, url TEXT, favicon TEXT,
        tags TEXT, pinned INTEGER NOT NULL DEFAULT 0, pinned_order INTEGER NOT NULL DEFAULT 0,
        sort_order INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL, modified_at INTEGER NOT NULL
      );
      CREATE TABLE history (
        id TEXT PRIMARY KEY, url TEXT NOT NULL, title TEXT, favicon TEXT,
        visit_count INTEGER NOT NULL DEFAULT 0, last_visit_at INTEGER NOT NULL, first_visit_at INTEGER NOT NULL
      );
      CREATE TABLE downloads (
        id TEXT PRIMARY KEY, url TEXT NOT NULL, filename TEXT NOT NULL, file_path TEXT,
        total_bytes INTEGER, received_bytes INTEGER DEFAULT 0, state TEXT NOT NULL, mime_type TEXT,
        started_at INTEGER NOT NULL, completed_at INTEGER, danger TEXT
      );
      CREATE TABLE favicons (
        page_url TEXT PRIMARY KEY, favicon_url TEXT, data TEXT, updated_at INTEGER NOT NULL
      );
    `)
    const ts = Date.now()
    legacy.prepare('INSERT INTO bookmarks (id,title,url,pinned,pinned_order,sort_order,created_at,modified_at) VALUES (?,?,?,0,0,0,?,?)')
      .run('old-bm', '老书签', 'https://old.example', ts, ts)
    legacy.prepare('INSERT INTO history (id,url,title,visit_count,last_visit_at,first_visit_at) VALUES (?,?,?,?,?,?)')
      .run('old-his', 'https://old.example', '老历史', 3, ts, ts)
    legacy.prepare('INSERT INTO downloads (id,url,filename,state,started_at) VALUES (?,?,?,?,?)')
      .run('old-dl', 'https://old.example/o.zip', 'o.zip', 'completed', ts)
    legacy.prepare('INSERT INTO favicons (page_url,favicon_url,data,updated_at) VALUES (?,?,?,?)')
      .run('https://old.example', 'https://old.example/fav.ico', null, ts)
    legacy.close()
  }

  // 用当前版本打开 → 自动迁移
  const { db, close } = createDb(dbPath)
  const scope = makeSwitchableScope()
  const bookmarkService = createBookmarkService(db as unknown as Parameters<typeof createBookmarkService>[0], { getProfileId: scope.getProfileId })
  const historyService = createHistoryService(db as unknown as Parameters<typeof createHistoryService>[0], { getProfileId: scope.getProfileId })
  const downloadService = createDownloadService(db as unknown as Parameters<typeof createDownloadService>[0], { getProfileId: scope.getProfileId })
  const faviconService = createFaviconService(db as Parameters<typeof createFaviconService>[0], { getProfileId: scope.getProfileId })

  check('升级后老书签在 default 里可见', bookmarkService.listAll().map((b) => b.title), ['老书签'])
  check('升级后老历史在 default 里可见', historyService.listRecent().map((h) => h.title), ['老历史'])
  check('升级后老下载在 default 里可见', downloadService.list().map((d) => d.filename), ['o.zip'])
  check('升级后老 favicon 缓存可用', faviconService.get('https://old.example').faviconUrl, 'https://old.example/fav.ico')

  // 新 profile 看不到老数据（确认老数据确实被分区而不是「全局可见」）
  scope.use('bob')
  check('新用户看不到老书签', bookmarkService.listAll().length, 0)
  check('新用户看不到老历史', historyService.listRecent().length, 0)
  check('新用户看不到老 favicon 缓存', faviconService.get('https://old.example').faviconUrl, null)

  // favicons 主键已升级为 (profile_id, page_url)：同一 URL 在不同 profile 各存一份
  scope.use('bob')
  faviconService.cache('https://old.example', 'https://bob.example/fav.ico')
  check('同一 URL 在两个 profile 各有一份图标', faviconService.get('https://old.example').faviconUrl, 'https://bob.example/fav.ico')
  scope.use('default')
  check('default 的那份未被覆盖', faviconService.get('https://old.example').faviconUrl, 'https://old.example/fav.ico')

  close()

  // 迁移是幂等的：再打开一次不应报错、数据仍在
  const reopened = createDb(dbPath)
  const bm2 = createBookmarkService(reopened.db as unknown as Parameters<typeof createBookmarkService>[0], { getProfileId: () => 'default' })
  check('二次打开幂等（数据仍在）', bm2.listAll().map((b) => b.title), ['老书签'])
  reopened.close()
  try { fs.unlinkSync(dbPath) } catch (_) {}
}

/* ────────────────────────────────────────────────────────────────
 * ⑤ 设置：基线 + 按 profile 覆盖层
 * ──────────────────────────────────────────────────────────────── */
/** 内存 FilePort：探针不碰真实磁盘，语义与 infra-fs#createFilePort 对齐。 */
function memoryFilePort(seed: Record<string, string> = {}): SettingsFilePort & { files: Map<string, string> } {
  const files = new Map<string, string>(Object.entries(seed))
  return {
    files,
    join: (...parts: string[]) => parts.filter(Boolean).join('/'),
    existsSync: (p: string) => files.has(p),
    readJsonSync: <T = unknown>(p: string): T => JSON.parse(files.get(p) ?? 'null') as T,
    writeJsonAtomicSync: (p: string, value: unknown) => { files.set(p, JSON.stringify(value)) },
    writeJsonAtomic: async (p: string, value: unknown) => { files.set(p, JSON.stringify(value)) }
  }
}

function runSettingsOverlayChecks() {
  const BASE_DIR = '/userData'
  const BASE_FILE = `${BASE_DIR}/settings.json`
  // 模拟「升级前用户已把主题调成深色」的基线
  const filePort = memoryFilePort({ [BASE_FILE]: JSON.stringify({ 'app.theme': 'dark' }) })

  const base = createSettingsService({ dataDir: BASE_DIR, filePort })
  const scope = makeSwitchableScope()
  const settings = createProfileSettingsOverlay({
    base,
    filePort,
    profileDirOf: (pid: string) => `${BASE_DIR}/profiles/${pid}`,
    getProfileId: scope.getProfileId
  })

  check('基线被所有 profile 继承（bob 看到 dark）', (scope.use('bob'), settings.get('app.theme')), 'dark')

  // 变更通知：必须仍然能从覆盖层上报（settings:changed 广播依赖它）
  const seen: string[] = []
  const unsubscribe = settings.subscribe((c) => seen.push(`${c.key}=${c.value}`))

  scope.use('alice')
  settings.set('app.theme', 'light')
  check('A 改成 light 只对自己生效', settings.get('app.theme'), 'light')
  scope.use('bob')
  check('B 的主题不受 A 影响（仍是 dark）', settings.get('app.theme'), 'dark')

  check('变更上报了 1 条', seen, ['app.theme=light'])

  scope.use('alice')
  settings.set('privacy.block_ads', false)     // 布尔开关同样按 profile
  settings.set('downloads.max_connections', 999) // number 夹界护栏在覆盖层也生效
  check('布尔开关走覆盖层', settings.get('privacy.block_ads'), false)
  check('number 被夹到上限 16', settings.get('downloads.max_connections'), 16)
  check('CSS 变量映射含 A 的主题', settings.cssVars().theme, 'light')

  scope.use('bob')
  check('B 的布尔开关仍是基线 true', settings.get('privacy.block_ads'), true)
  check('B 的 CSS 变量仍是 dark', settings.cssVars().theme, 'dark')

  // 落盘：只写自己的文件，基线文件一个字节都不动
  const beforeBase = filePort.files.get(BASE_FILE) ?? '{}'
  settings.flush()
  check('基线文件未被 profile 写入改动', filePort.files.get(BASE_FILE), beforeBase)
  const aliceFile = `${BASE_DIR}/profiles/alice/settings.json`
  const bobFile = `${BASE_DIR}/profiles/bob/settings.json`
  check('A 的覆盖写进了自己的文件', JSON.parse(filePort.files.get(aliceFile) || '{}'), {
    'app.theme': 'light',
    'privacy.block_ads': false,
    'downloads.max_connections': 16
  })
  check('B 没写过 → 不存在 B 的覆盖文件', filePort.files.has(bobFile), false)
  check('基线的 dark 仍是 dark（未被覆盖层改写）', (JSON.parse(beforeBase) as Record<string, unknown>)['app.theme'], 'dark')

  // 恢复默认 = 删掉本用户的覆盖 → 落回基线（且不影响别的用户）
  scope.use('alice')
  settings.reset('app.theme')
  check('A 恢复默认后回到基线 dark', settings.get('app.theme'), 'dark')
  check('A 的其它改动仍在', settings.get('privacy.block_ads'), false)
  settings.reset()
  check('A 全部恢复默认后回到基线', settings.get('privacy.block_ads'), true)
  scope.use('bob')
  check('B 全程未受影响', settings.get('app.theme'), 'dark')
  check('B 的覆盖文件仍不存在', filePort.files.has(bobFile), false)

  unsubscribe()
}

console.log('══ profile 数据隔离探针 ══════════════════════════════════')
console.log('\n── ① 书签 / 历史 / 下载 / favicon 按 profile 分区 ──')
runPartitionChecks()
console.log('\n── ② 站点权限按 profile 取实例 ──')
runPermissionChecks()
console.log('\n── ③ 老库升级（数据不丢 + 归入 default + 幂等）──')
runLegacyMigrationChecks()
console.log('\n── ④ 设置：基线 + 按 profile 覆盖层 ──')
runSettingsOverlayChecks()

console.log(`\n════ 结果：${pass}/${pass + fail} 通过，${fail} 条 FAIL ════`)
if (fail > 0) {
  console.log('存在未通过项 —— profile 数据隔离仍不完整。')
  process.exit(1)
}
console.log('全部通过 —— 各 profile 的数据确实互相不可见。')
