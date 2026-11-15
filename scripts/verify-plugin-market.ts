#!/usr/bin/env node
/**
 * 插件源（社区市场）体检 —— `pnpm verify:plugin-market`
 *
 * 只测 `main/plugin-market.js` + `main/plugin-installer.js`：不启 Electron、不碰注册中心。
 * 起一个**本地 http 服务**当"市场"，于是整条链（拉索引 → 下载 → 校验和 → 安装器体检
 * → 落盘）可以在离线环境里端到端跑一遍。
 *
 * 为什么这一层必须能被这样测：它的失败模式几乎全是
 * 「超时 / 重定向 / 巨大响应 / 形状不对 / 校验和不符」——
 * 这些拿桩去测是测不出来的，而它们恰恰是**上线后才会遇到**的那一类。
 *
 * 退出码：0 = 全通；1 = 有失败。
 */

import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import * as http from 'node:http'
import * as crypto from 'node:crypto'
import { errorMessage } from './lib/type-guards'

interface TestFailure { name: string; error: string }
interface Resource { body: Buffer; type?: string; redirect?: string }
interface OperationResult { ok: boolean; reason?: string }
interface SetSourcesResult extends OperationResult { sources?: unknown[] }
interface MarketSource { name?: string; url?: string; ok?: boolean; reason?: string; skipped?: number; cached?: boolean }
interface MarketEntry {
  id: string
  name?: string
  version?: string
  author?: string
  homepage?: string
  url?: string
  sha256?: string
  installed?: boolean
  installedVersion?: string
  updateAvailable?: boolean
  sourceName?: string
  sourceUrl?: string
}
interface MarketQueryResult {
  ok: boolean
  reason?: string
  sources: MarketSource[]
  entries: MarketEntry[]
  duplicates?: number
}
type InstallResult = OperationResult & { verified?: boolean }
interface MarketApi {
  query(options?: { force?: boolean }): Promise<MarketQueryResult>
  install(id: string, options?: { force?: boolean }): Promise<InstallResult>
  setSources(urls: string[]): SetSourcesResult
  setSource(url: string): OperationResult
  _internals: { isAllowedUrl(url: string): boolean }
}

const ROOT = path.resolve(__dirname, '..')
const { createPluginInstaller } = require(path.join(ROOT, 'apps', 'app-main', 'src', 'main', 'plugin-installer.js')) as {
  createPluginInstaller: (options: Record<string, unknown>) => unknown
}
const { createPluginMarket } = require(path.join(ROOT, 'apps', 'app-main', 'src', 'main', 'plugin-market.js')) as {
  createPluginMarket: (options: Record<string, unknown>) => Omit<MarketApi, 'setSource'>
}
const { makePluginZip } = require('./lib/mini-zip.ts')

let passed = 0
let skipped = 0
const failures: TestFailure[] = []

async function t(name: string, fn: () => unknown | Promise<unknown>): Promise<void> {
  try {
    const r = await fn()
    if (r === 'skip') {
      skipped += 1
      console.log(`  ~ ${name}（环境不支持，已跳过）`)
      return
    }
    passed += 1
    console.log(`  ✓ ${name}`)
  } catch (error) {
    const message = errorMessage(error)
    failures.push({ name, error: error instanceof Error && error.stack ? error.stack : message })
    console.log(`  ✗ ${name}\n      ${message}`)
  }
}
function assert(cond: unknown, msg?: string): asserts cond {
  if (!cond) throw new Error(msg || '断言失败')
}
function assertEq(actual: unknown, expected: unknown, msg?: string): void {
  if (actual !== expected) {
    throw new Error(`${msg || '值不相等'}：期望 ${JSON.stringify(expected)}，实际 ${JSON.stringify(actual)}`)
  }
}
const sha256 = (buf: Buffer | string): string => crypto.createHash('sha256').update(buf).digest('hex')

// ─────────────────────────────────────────────────────────────
// 现场：一个本地静态"市场"
// ─────────────────────────────────────────────────────────────
const SANDBOX = fs.mkdtempSync(path.join(os.tmpdir(), 'hira-plugin-market-'))
const userDir = path.join(SANDBOX, 'plugins')
fs.mkdirSync(userDir, { recursive: true })

/** 服务端持有的资源：路径 → { body, type } */
const resources = new Map<string, Resource>()
/** 记录每个路径被请求了几次（用于验证缓存真的生效 / 真的被绕过）。 */
const hits = new Map<string, number>()

let server: http.Server | null = null
let baseUrl = ''
/** 活着的连接 —— 收尾时要逐个 destroy（见 shutdown 的说明）。 */
const liveSockets = new Set<import('node:net').Socket>()

function startServer(): Promise<void> {
  return new Promise((resolve) => {
    const httpServer = http.createServer((req, res) => {
      const url = (req.url || '').split('?')[0]
      hits.set(url, (hits.get(url) || 0) + 1)
      const hit = resources.get(url)
      if (!hit) { res.writeHead(404); res.end('not found'); return }
      if (hit.redirect) { res.writeHead(302, { Location: hit.redirect }); res.end(); return }
      res.writeHead(200, { 'Content-Type': hit.type || 'application/octet-stream', 'Content-Length': hit.body.length })
      res.end(hit.body)
    })
    server = httpServer
    httpServer.on('connection', (socket) => {
      liveSockets.add(socket)
      socket.on('close', () => liveSockets.delete(socket))
    })
    httpServer.listen(0, '127.0.0.1', () => {
      const address = httpServer.address()
      if (!address || typeof address === 'string') throw new Error('测试服务器未获得端口')
      baseUrl = `http://127.0.0.1:${address.port}`
      resolve()
    })
  })
}

/**
 * 收尾。
 *
 * ⚠ **刻意不调 `process.exit()`**：`fetch`（undici）的连接池里还挂着 keep-alive 套接字，
 * 那种状态下强杀进程会撞上 libuv 的 `Assertion failed: !(handle->flags & UV_HANDLE_CLOSING)`
 * —— 断言崩在 C 层，退出码变成 0xC0000409，而我们的 19/19 结果就在它上面几行，
 * 看起来像"测试挂了"。正确做法是：关服务、把连接逐个 destroy、设 `exitCode`，
 * 让事件循环自己排空后正常退出。
 */
function shutdown(code: number): void {
  try { server && server.close() } catch (_) {}
  for (const socket of liveSockets) {
    try { socket.destroy() } catch {}
  }
  liveSockets.clear()
  process.exitCode = code
}

/** 服务端持有的一份包（同时给出它的 sha256）。 */
function publishPackage(entryId: string, version: string, extra: Record<string, unknown> = {}): { file: string; zip: Buffer; sha256: string } {
  const zip = makePluginZip({ id: entryId, name: `${entryId} 显示名`, version, ...(extra || {}) })
  const file = `/pkgs/${entryId}-${version}.zip`
  resources.set(file, { body: zip, type: 'application/zip' })
  return { file, zip, sha256: sha256(zip) }
}

/**
 * 发布一份索引。
 *
 * `at` 可指定路径 —— **多源用例必须要它**：默认路径是同一个文件，两个"源"会变成同一个
 * URL，于是被去重成一个源，"多源"什么都没测到。
 */
function publishIndex(plugins: Array<Record<string, unknown>>, name?: string, at = '/index.json'): string {
  const body = Buffer.from(JSON.stringify({ schema: 1, name: name || '本地测试源', plugins }, null, 2), 'utf8')
  resources.set(at, { body, type: 'application/json' })
  return `${baseUrl}${at}`
}

let sourceUrl = ''
/** 真实配置（数组）。`sourceUrl` 只是它的**单源视图**，给既有的单源断言用。 */
let sourceList: string[] = []
const installer = createPluginInstaller({ userPluginDir: userDir, builtinPluginIds: () => [] })
/** 本地已装版本（模拟注册中心；真机里由 main.js 从 describe() 现取）。 */
let localVersions: Record<string, string> = {}

/**
 * 产品 API 是**多源**（`getSources/setSources`），但这个脚本里绝大多数用例是单源的 ——
 * 每次写 `setSources([url])` 只会把噪音堆在真正要验的那句话前面。
 * 所以这里做一个**脚本内的单源适配**（不是产品里的兼容层）：
 *   · 端口把"单值视图"与"真实数组"一起维护，于是既有断言（比 `sourceUrl`）一个字都不用改；
 *   · 给 market 挂一个 `setSource(url)` 便利方法，等价于"只留这一个源"。
 * 多源那几条用例直接调 `setSources`，走的是真实 API。
 *
 * ⚠ `setSources` 端口**必须回传归一化后的数组**：产品侧拿它回填缓存与返回值，
 * 回传 undefined 会被判成"存储层未就绪"而整次保存失败（我第一次就漏了 return）。
 */
function wrapMarket(api: Omit<MarketApi, 'setSource'>): MarketApi {
  return {
    ...api,
    setSource: (url: string) => api.setSources(url ? [String(url)] : [])
  }
}

const market = wrapMarket(
  createPluginMarket({
    installer,
    getSources: () => sourceList.slice(),
    setSources: (list: string[]) => {
      sourceList = Array.isArray(list) ? list.slice() : []
      sourceUrl = sourceList[0] || ''
      return sourceList.slice()
    },
    getLocalVersions: () => localVersions
  })
)

async function main(): Promise<void> {
  await startServer()
  console.log(`[verify:plugin-market] 沙箱：${SANDBOX}\n市场地址：${baseUrl}`)

  // ── 未配置 / 非法地址 ─────────────────────────────────────
  console.log('\n配置')

  await t('未配置插件源 → ok:false 且一个源都没有（**不是错误**，只用本地安装即可）', async () => {
    const res = await market.query()
    assertEq(res.ok, false, 'ok')
    assertEq(res.sources.length, 0, 'sources')
    assertEq(res.entries.length, 0, 'entries')
    assert(/还没有设置插件源/.test(res.reason || ''), `应提示未配置，实际：${res.reason}`)
  })

  await t('设置公网 http:// 地址 → 拒绝（只允许 https，回环除外）', () => {
    const res = market.setSource('http://example.com/index.json')
    assert(!res.ok, '应被拒')
    assert(/https/.test(res.reason || ''), `原因应说明 https 要求，实际：${res.reason}`)
    assertEq(sourceUrl, '', '被拒的地址不应写进配置')
  })

  await t('设置 ftp:// → 拒绝', () => {
    const res = market.setSource('ftp://example.com/index.json')
    assert(!res.ok, '应被拒')
  })

  await t('设置回环 http:// → 允许（本地自建源 / 自测的唯一正当场景）', () => {
    const res = market.setSource(`${baseUrl}/index.json`)
    assert(res.ok, `应允许：${res.reason}`)
    assertEq(sourceUrl, `${baseUrl}/index.json`, 'source')
  })

  // ── 索引形状与剪裁 ───────────────────────────────────────
  console.log('\n索引')

  const pkgA = publishPackage('acme-a', '1.0.0')
  const pkgB = publishPackage('acme-b', '2.1.0')

  await t('正常索引：条目被归一化（含 author/homepage/相对 url 解析）', async () => {
    const url = publishIndex([
      { id: 'acme-a', name: 'Acme A', version: '1.0.0', description: '第一个', author: '张三', homepage: 'https://example.com/a', url: `./pkgs/acme-a-1.0.0.zip`, sha256: pkgA.sha256 },
      { id: 'acme-b', name: 'Acme B', version: '2.1.0', url: `${baseUrl}/pkgs/acme-b-2.1.0.zip` }
    ])
    assertEq(url, sourceUrl, '索引地址')
    const res = await market.query({ force: true })
    assert(res.ok, `应成功：${res.reason}`)
    assertEq(res.entries.length, 2, '条目数')
    const a = res.entries.find((e) => e.id === 'acme-a')
    assert(a, '应找到 acme-a')
    assertEq(a.name, 'Acme A', 'name')
    assertEq(a.author, '张三', 'author')
    assertEq(a.homepage, 'https://example.com/a', 'homepage')
    // 相对 url 必须被解析成绝对地址（否则下载时根本取不到）
    assertEq(a.url, `${baseUrl}/pkgs/acme-a-1.0.0.zip`, 'url')
    assertEq(a.sha256, pkgA.sha256, 'sha256')
    assertEq(a.installed, false, 'installed')
    assertEq(res.sources[0]?.name, '本地测试源', '源名称（源级信息，不再是顶层字段）')
    // 该条没声明 sha256 → 空串（UI 会提示"未提供校验和"，不阻止安装）
    assertEq(res.entries.find((e) => e.id === 'acme-b')?.sha256, '', 'sha256')
  })

  await t('坏条目**逐条隔离**：id 非法 / url 非 https / 重复 id 都被跳过，好条目照常', async () => {
    publishIndex([
      { id: 'ok-one', name: '好条目', version: '1.0.0', url: `${baseUrl}/pkgs/whatever.zip` },
      { id: '../evil', name: '坏 id', version: '1.0.0', url: `${baseUrl}/pkgs/x.zip` },
      { id: 'ok-two', name: '明文下载', version: '1.0.0', url: 'http://example.com/x.zip' },
      { id: 'ok-one', name: '重复 id', version: '9.9.9', url: `${baseUrl}/pkgs/dup.zip` },
      { name: '没有 id', version: '1.0.0', url: `${baseUrl}/pkgs/y.zip` }
    ])
    const res = await market.query({ force: true })
    assert(res.ok, `整体仍应可用：${res.reason}`)
    assertEq(res.entries.length, 1, '只有一条好条目')
    assertEq(res.entries[0]?.id, 'ok-one', '留下的应当是第一条')
    assertEq(res.sources[0]?.skipped, 4, '被跳过的条数（源级信息）')
  })

  await t('索引不是 JSON / 缺 plugins → 明确报原因（不是抛异常）', async () => {
    resources.set('/index.json', { body: Buffer.from('not json'), type: 'application/json' })
    const bad = await market.query({ force: true })
    assert(!bad.ok)
    assert(/索引格式|JSON/i.test(bad.reason || ''), `原因应说明格式问题，实际：${bad.reason}`)
    resources.set('/index.json', { body: Buffer.from(JSON.stringify({ schema: 1 })), type: 'application/json' })
    const missing = await market.query({ force: true })
    assert(!missing.ok)
    assert(/plugins/.test(missing.reason || ''), `原因应说明缺 plugins，实际：${missing.reason}`)
  })

  await t('索引 404 → 明确报 HTTP 状态', async () => {
    const saved = market.setSource(`${baseUrl}/nope.json`)
    assert(saved.ok)
    const res = await market.query({ force: true })
    assert(!res.ok)
    assert(/404/.test(res.reason || ''), `原因应含状态码，实际：${res.reason}`)
    market.setSource(sourceUrl) // 恢复
  })

  await t('短期缓存生效；force 能绕过（否则每次刷新都出网）', async () => {
    const url = publishIndex([{ id: 'cache-x', name: '缓存', version: '1.0.0', url: `${baseUrl}/pkgs/cache.zip` }])
    market.setSource(url)
    const before = hits.get('/index.json') || 0
    const first = await market.query({ force: true })
    assert(first.ok, '首次应成功')
    const second = await market.query()
    assertEq(second.sources[0]?.cached, true, '第二次应命中缓存（缓存是**按源**分桶的）')
    assertEq(hits.get('/index.json') || 0, before + 1, '缓存命中时不应再出网')
    const third = await market.query({ force: true })
    assertEq(third.sources[0]?.cached, false, 'force 应绕过缓存')
    assertEq(hits.get('/index.json') || 0, before + 2, 'force 应再出网一次')
  })

  // ── 安装 ─────────────────────────────────────────────────
  console.log('\n安装 / 更新（走与"从压缩包安装"完全相同的落盘路径）')

  const pkgV1 = publishPackage('market-demo', '1.0.0')
  const pkgV2 = publishPackage('market-demo', '2.0.0')

  await t('从源安装：下载 → sha256 校验 → 体检 → 落盘', async () => {
    const url = publishIndex([{ id: 'market-demo', name: '市场演示', version: '1.0.0', url: pkgV1.file, sha256: pkgV1.sha256 }])
    market.setSource(url)
    const res = await market.install('market-demo', { force: true })
    assert(res.ok, `应成功：${res.reason}`)
    assertEq(res.verified, true, 'verified（索引声明了 sha256 且通过）')
    assert(fs.existsSync(path.join(userDir, 'market-demo', 'hira-plugin.json')), '应落盘')
    const onDisk = JSON.parse(fs.readFileSync(path.join(userDir, 'market-demo', 'hira-plugin.json'), 'utf8'))
    assertEq(onDisk.version, '1.0.0', '磁盘版本')
  })

  await t('已装同版本 → installed:true 且不提示更新', async () => {
    localVersions = { 'market-demo': '1.0.0' }
    const res = await market.query({ force: true })
    const e = res.entries.find((x) => x.id === 'market-demo')
    assert(e, '应找到 market-demo')
    assertEq(e.installed, true, 'installed')
    assertEq(e.installedVersion, '1.0.0', 'installedVersion')
    assertEq(e.updateAvailable, false, 'updateAvailable')
  })

  await t('源里出现新版本 → updateAvailable:true，覆盖安装后版本换新', async () => {
    const url = publishIndex([{ id: 'market-demo', name: '市场演示', version: '2.0.0', url: pkgV2.file, sha256: pkgV2.sha256 }])
    market.setSource(url)
    const res = await market.query({ force: true })
    const e = res.entries.find((x) => x.id === 'market-demo')
    assert(e, '应找到 market-demo')
    assertEq(e.updateAvailable, true, 'updateAvailable')
    const upd = await market.install('market-demo', { force: true })
    assert(upd.ok, `更新应成功：${upd.reason}`)
    const onDisk = JSON.parse(fs.readFileSync(path.join(userDir, 'market-demo', 'hira-plugin.json'), 'utf8'))
    assertEq(onDisk.version, '2.0.0', '磁盘版本应已更新')
  })

  await t('**校验和不符 → 拒绝安装，且插件目录里什么都没留下**', async () => {
    const url = publishIndex([{
      id: 'tampered', name: '被篡改', version: '1.0.0',
      url: pkgV1.file,
      sha256: '0'.repeat(64) // 故意给一个错的
    }])
    market.setSource(url)
    const res = await market.install('tampered', { force: true })
    assert(!res.ok, '应被拒')
    assert(/校验和不符/.test(res.reason || ''), `原因应说明校验和，实际：${res.reason}`)
    // 只看返回值不够 —— 要确认它真的没落盘
    assert(!fs.existsSync(path.join(userDir, 'tampered')), '不应留下插件目录')
  })

  await t('下载 404 → 明确报状态码，不留残留', async () => {
    const url = publishIndex([{ id: 'gone', name: '不存在的包', version: '1.0.0', url: `${baseUrl}/pkgs/missing.zip` }])
    market.setSource(url)
    const res = await market.install('gone', { force: true })
    assert(!res.ok)
    assert(/404/.test(res.reason || ''), `原因应含状态码，实际：${res.reason}`)
    assert(!fs.existsSync(path.join(userDir, 'gone')), '不应留下插件目录')
  })

  await t('下载下来的不是 zip → 拒绝（不会把裸字节塞给安装器）', async () => {
    resources.set('/pkgs/notzip.zip', { body: Buffer.from('definitely not a zip'), type: 'application/zip' })
    const url = publishIndex([{ id: 'notzip', name: '不是包', version: '1.0.0', url: `${baseUrl}/pkgs/notzip.zip` }])
    market.setSource(url)
    const res = await market.install('notzip', { force: true })
    assert(!res.ok, '应被拒')
    assert(!fs.existsSync(path.join(userDir, 'notzip')), '不应留下插件目录')
  })

  await t('索引里没有这个 id → 明确失败', async () => {
    const url = publishIndex([{ id: 'market-demo', name: 'x', version: '1.0.0', url: pkgV1.file }])
    market.setSource(url)
    const res = await market.install('not-in-index', { force: true })
    assert(!res.ok)
    assert(/没有/.test(res.reason || ''), `原因应说明索引里没有，实际：${res.reason}`)
  })

  await t('市场**不会绕过安装器**：包与内置插件撞名照样被拒', async () => {
    const zip = makePluginZip({ id: 'tabs-service', name: '冒名顶替', version: '1.0.0' })
    resources.set('/pkgs/evil.zip', { body: zip, type: 'application/zip' })
    const url = publishIndex([{ id: 'tabs-service', name: '冒名顶替', version: '1.0.0', url: `${baseUrl}/pkgs/evil.zip`, sha256: sha256(zip) }])
    market.setSource(url)
    // 这一份 installer 的"内置名单"是空的，所以撞名检查不会命中 ——
    // 用一个带内置名单的安装器重跑，证明市场侧**没有任何绕过的余地**。
    const strictInstaller = createPluginInstaller({ userPluginDir: userDir, builtinPluginIds: () => ['tabs-service'] })
    const strictMarket = wrapMarket(createPluginMarket({
      installer: strictInstaller,
      getSources: () => sourceList.slice(),
      setSources: (list: string[]) => {
        sourceList = Array.isArray(list) ? list.slice() : []
        sourceUrl = sourceList[0] || ''
        return sourceList.slice()
      },
      getLocalVersions: () => ({})
    }))
    strictMarket.setSource(url)
    const res = await strictMarket.install('tabs-service', { force: true })
    assert(!res.ok, '必须被安装器拦下')
    assert(/内置插件重名/.test(res.reason || ''), `原因应来自安装器，实际：${res.reason}`)
    assert(!fs.existsSync(path.join(userDir, 'tabs-service')), '不应落盘')
  })

  await t('清空源列表 → 回到"未配置"，且不再出网', async () => {
    const res = market.setSource('')
    assert(res.ok, '应允许清空')
    const q = await market.query()
    assertEq(q.ok, false, 'ok')
    assertEq(q.sources.length, 0, 'sources')
    assertEq(q.entries.length, 0, 'entries')
  })

  // ── 多源聚合 ─────────────────────────────────────────────
  //
  // 这一段是"多源"真正的价值所在。两条硬要求：
  //   ① 一条源失败**只影响它自己**（一个源自挂掉不该让整个插件中心空掉）；
  //   ② 同 id 撞车时**靠前的源胜出**（顺序即优先级），并且要能看出来撞了。
  console.log('\n多源聚合')

  await t('两个源同时出结果，条目被合并（entries 带上来源）', async () => {
    const pkgA = publishPackage('multi-a', '1.0.0')
    const pkgB = publishPackage('multi-b', '2.0.0')
    const urlA = publishIndex([{ id: 'multi-a', name: 'A 源插件', version: '1.0.0', url: pkgA.file, sha256: pkgA.sha256 }], 'A 源', '/a/index.json')
    const urlB = publishIndex([{ id: 'multi-b', name: 'B 源插件', version: '2.0.0', url: pkgB.file, sha256: pkgB.sha256 }], 'B 源', '/b/index.json')
    const saved = market.setSources([urlA, urlB])
    assert(saved.ok, `应保存成功：${saved.reason}`)
    assertEq(saved.sources?.length, 2, '两个源都应在配置里')
    const res = await market.query({ force: true })
    assertEq(res.sources.length, 2, '逐个源都要回报状态')
    assertEq(res.entries.length, 2, '两个源的条目应合并')
    assert(res.entries.every((e) => !!e.sourceUrl), '每条都要带来源地址')
    assertEq(res.sources.find((source) => source.url === urlA)?.name, 'A 源', '源名要报出来（界面上标来源用它）')
  })

  await t('**一条源失败只影响它自己**（另一个源照常出结果）', async () => {
    const pkg = publishPackage('survivor', '1.0.0')
    const okUrl = publishIndex([{ id: 'survivor', name: '幸存者', version: '1.0.0', url: pkg.file, sha256: pkg.sha256 }], '好的源', '/ok/index.json')
    const badUrl = `${baseUrl}/does-not-exist.json`
    market.setSources([badUrl, okUrl])
    const res = await market.query({ force: true })
    assert(res.ok, '整体应当仍是"可用"（至少有一条源成功）')
    assertEq(res.entries.length, 1, '好源的条目应当在')
    assertEq(res.entries[0]?.id, 'survivor', '就是它')
    const bad = res.sources.find((source) => source.url === badUrl)
    const good = res.sources.find((source) => source.url === okUrl)
    assert(bad, '应回报坏源')
    assert(good, '应回报好源')
    assertEq(bad.ok, false, '坏源 ok 应为 false')
    assert(/404/.test(bad.reason || ''), `坏源要给出**它自己的**原因，实际：${bad.reason}`)
    assertEq(good.ok, true, '好源 ok 应为 true')
  })

  await t('同 id 撞车 → **靠前的源胜出**，并回报 duplicates', async () => {
    const first = publishPackage('dup-plugin', '1.0.0')
    const second = publishPackage('dup-plugin', '9.9.9')
    const urlFirst = publishIndex([{ id: 'dup-plugin', name: '一号源', version: '1.0.0', url: first.file, sha256: first.sha256 }], '一号源', '/dup1/index.json')
    const urlSecond = publishIndex([{ id: 'dup-plugin', name: '二号源', version: '9.9.9', url: second.file, sha256: second.sha256 }], '二号源', '/dup2/index.json')
    market.setSources([urlFirst, urlSecond])
    const res = await market.query({ force: true })
    const hit = res.entries.find((e) => e.id === 'dup-plugin')
    assert(hit, '应有这一条')
    assertEq(hit.version, '1.0.0', '应取**靠前**源里的版本')
    assertEq(hit.sourceName, '一号源', '来源应是一号源')
    assertEq(res.duplicates, 1, '要回报重复数（否则用户会以为二号源没生效）')
    // 反过来：把顺序调换，胜出的就该换人 —— 这条直接证明"顺序即优先级"是生效的
    market.setSources([urlSecond, urlFirst])
    const res2 = await market.query({ force: true })
    assertEq(res2.entries.find((entry) => entry.id === 'dup-plugin')?.version, '9.9.9', '调换顺序后应取二号源')
  })

  await t('整表提交的校验：坏地址 / 超过上限都被拒，且不写进配置', () => {
    market.setSource(`${baseUrl}/index.json`)
    const before = sourceUrl
    const bad = market.setSources([`${baseUrl}/index.json`, 'http://example.com/x.json'])
    assert(!bad.ok, '含非法地址应整表被拒')
    assertEq(sourceUrl, before, '被拒时配置不应被改动')
    const tooMany = market.setSources(new Array(21).fill(`${baseUrl}/index.json`))
    assert(!tooMany.ok, '超过上限应被拒')
    assert(/最多/.test(tooMany.reason || ''), `原因应说明上限，实际：${tooMany.reason}`)
  })

  await t('移除源后只作废它自己的缓存（保留的源仍走缓存，不重复出网）', async () => {
    const pkg = publishPackage('cache-keep', '1.0.0')
    const keepPath = '/keep/index.json'
    const keepUrl = publishIndex([{ id: 'cache-keep', name: '保留', version: '1.0.0', url: pkg.file, sha256: pkg.sha256 }], '保留源', keepPath)
    const dropUrl = `${baseUrl}/drop.json`
    resources.set('/drop.json', { body: Buffer.from(JSON.stringify({ schema: 1, plugins: [] })), type: 'application/json' })
    market.setSources([keepUrl, dropUrl])
    await market.query({ force: true }) // 两个源都填上缓存
    const keepHits = hits.get(keepPath) || 0
    market.setSources([keepUrl]) // 只留一个
    const res = await market.query() // 不带 force
    assertEq(res.sources.length, 1, '只剩一个源')
    assertEq(res.sources[0]?.cached, true, '保留下来的源应仍命中缓存')
    assertEq(hits.get(keepPath) || 0, keepHits, '不应因为它源被移除而重复出网')
  })

  await t('install 跨源查找（配了多个源时也能装到）', async () => {
    const pkg = publishPackage('cross-source', '1.0.0')
    const urlA = `${baseUrl}/empty-a.json`
    resources.set('/empty-a.json', { body: Buffer.from(JSON.stringify({ schema: 1, plugins: [] })), type: 'application/json' })
    const urlB = publishIndex([{ id: 'cross-source', name: '跨源', version: '1.0.0', url: pkg.file, sha256: pkg.sha256 }], 'B', '/b2/index.json')
    market.setSources([urlA, urlB])
    const res = await market.install('cross-source', { force: true })
    assert(res.ok, `应能从第二个源装到：${res.reason}`)
    assert(fs.existsSync(path.join(userDir, 'cross-source', 'hira-plugin.json')), '应落盘')
  })

  await t('isAllowedUrl 的判据（含回环 http 与重定向后的复核口径）', () => {
    const { isAllowedUrl } = market._internals
    assert(isAllowedUrl('https://example.com/x.json'), 'https 应放行')
    assert(isAllowedUrl('http://127.0.0.1:8080/x.json'), '回环 http 应放行')
    assert(isAllowedUrl('http://localhost/x.json'), 'localhost 应放行')
    assert(!isAllowedUrl('http://example.com/x.json'), '公网 http 应拒')
    assert(!isAllowedUrl('file:///etc/passwd'), 'file 应拒')
    assert(!isAllowedUrl('data:text/plain,hi'), 'data 应拒')
    assert(!isAllowedUrl('not a url'), '非 URL 应拒')
    assert(!isAllowedUrl(''), '空串应拒')
  })

  // ── 汇总 ──
  console.log('')
  const total = passed + failures.length + skipped
  console.log(`共 ${total} 项：通过 ${passed}${skipped ? `（跳过 ${skipped}）` : ''}，失败 ${failures.length}`)
  if (failures.length) {
    console.log('')
    for (const failure of failures) console.log(`  ✗ ${failure.name}\n${failure.error.split('\n').map((line) => '      ' + line).join('\n')}`)
  }
  try { fs.rmSync(SANDBOX, { recursive: true, force: true }) } catch (_) {}
  shutdown(failures.length ? 1 : 0)
}

main().catch((error) => {
  console.error('[verify:plugin-market] 运行失败：', errorMessage(error))
  try { fs.rmSync(SANDBOX, { recursive: true, force: true }) } catch (_) {}
  shutdown(2)
})
