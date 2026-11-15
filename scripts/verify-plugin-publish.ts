#!/usr/bin/env node
/**
 * 发布 → 托管 → 安装 → 验签 的**闭环**验证 —— `pnpm verify:plugin-publish`
 *
 * 前三段（`verify:plugin-install` / `verify:plugin-market`）各自测一层，这一条测的是
 * **它们连起来对不对**：作者用 `plugin:publish` 打包出来的东西，用户那一侧能不能装上、
 * 校验和对不对、签名验不验得过。
 *
 * 为什么必须有这一条：三段各自绿、合起来坏，是发布链路上最典型的失败形态 ——
 * 而且它只有**在作者机器上**才暴露得出来（用户那边只会看到"装不上"）。
 * 造样本用同一份 `mini-zip`、体检用同一份安装器、索引用同一份 market 解析，
 * 于是这条验证本身不会因为"样本跟真货不一样"而失真。
 *
 * 全离线：托管用本地 http 服务，密钥现场生成。
 * 退出码：0 = 全通；1 = 有失败。
 */

import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import * as http from 'node:http'
import * as crypto from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { errorMessage } from './lib/type-guards'

interface TestFailure { name: string; error: string }
interface PublishResult { status: number | null; stdout: string; stderr: string }
interface ArchiveEntry { name: string; method?: number; [key: string]: unknown }
interface ArchiveModule {
  readZipEntries(buffer: Buffer): ArchiveEntry[]
  extractEntry(entry: ArchiveEntry): Buffer
}
interface SignatureResult { status: string; reason?: string }
interface InstallResult {
  ok: boolean
  reason?: string
  verified?: boolean
  version?: string
  signature?: SignatureResult
}
interface PluginInstaller { installArchive(path: string): Promise<InstallResult> }
interface PluginMarket { install(id: string, options: { force: boolean }): Promise<InstallResult> }
interface IndexEntry { id?: unknown; version?: unknown; url?: unknown; author?: unknown; sha256?: unknown }
interface MarketplaceIndex { schema?: unknown; plugins: IndexEntry[] }

const ROOT = path.resolve(__dirname, '..')
const { createPluginInstaller } = require(path.join(ROOT, 'apps', 'app-main', 'src', 'main', 'plugin-installer.js')) as {
  createPluginInstaller: (options: { userPluginDir: string; trustDir?: string }) => PluginInstaller
}
const { createPluginMarket } = require(path.join(ROOT, 'apps', 'app-main', 'src', 'main', 'plugin-market.js')) as {
  createPluginMarket: (options: Record<string, unknown>) => PluginMarket
}
const { readZipEntries, extractEntry } = require(path.join(ROOT, 'apps', 'app-main', 'src', 'main', 'plugin-archive.js')) as ArchiveModule

const PUBLISH_SCRIPT = path.join(ROOT, 'scripts', 'plugin-publish.ts')

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

/** 跑一次 `plugin:publish`，返回 { status, stdout, stderr }。 */
function publish(args: readonly string[]): PublishResult {
  const r = spawnSync(process.execPath, [PUBLISH_SCRIPT, ...args], { encoding: 'utf8' })
  return { status: r.status, stdout: r.stdout || '', stderr: r.stderr || '' }
}

/**
 * 从 zip 里读出一个文本条目。
 *
 * ⚠ **必须过 `extractEntry`**：`readZipEntries` 给的 `data` 是**压缩后的字节**，
 * 直接 `toString('utf8')` 得到的是一堆乱码二进制（本次写这条验证时踩了两遍）。
 * 封装成函数就是为了让后来者不必记得这件事。
 */
function readZipText(zipBuffer: Buffer, entryName: string): string {
  const entry = readZipEntries(zipBuffer).find((candidate) => candidate.name === entryName)
  if (!entry) throw new Error(`zip 里没有 ${entryName}`)
  return extractEntry(entry).toString('utf8')
}

const SANDBOX = fs.mkdtempSync(path.join(os.tmpdir(), 'hira-plugin-publish-'))
const authorDir = path.join(SANDBOX, 'author')      // 作者的插件源码
const distDir = path.join(SANDBOX, 'dist')          // 作者的产物目录
const userDir = path.join(SANDBOX, 'plugins')       // "用户机器"的插件目录
const trustDir = path.join(SANDBOX, 'trust')        // "用户机器"的受信任公钥目录

const liveSockets = new Set<import('node:net').Socket>()
let server: http.Server | null = null
let baseUrl = ''

function startServer(root: string): Promise<void> {
  return new Promise((resolve) => {
    const httpServer = http.createServer((req, res) => {
      const rel = decodeURIComponent((req.url || '').split('?')[0]).replace(/^\/+/, '')
      const abs = path.resolve(root, rel)
      // 测试服务器也守一下前缀（它不是被测对象，但不该给出错误的通过样本）
      if (!abs.startsWith(path.resolve(root) + path.sep)) { res.writeHead(403); res.end(); return }
      fs.readFile(abs, (error, buffer) => {
        if (error) { res.writeHead(404); res.end('not found'); return }
        res.writeHead(200, { 'Content-Type': 'application/octet-stream', 'Content-Length': buffer.length })
        res.end(buffer)
      })
    })
    server = httpServer
    httpServer.on('connection', (socket) => { liveSockets.add(socket); socket.on('close', () => liveSockets.delete(socket)) })
    httpServer.listen(0, '127.0.0.1', () => {
      const address = httpServer.address()
      if (!address || typeof address === 'string') throw new Error('测试服务器未获得端口')
      baseUrl = `http://127.0.0.1:${address.port}`
      resolve()
    })
  })
}

// 收尾：不 process.exit()（会导致 libuv 断言崩在 C 层，见 verify-plugin-market 的说明）
function shutdown(code: number): void {
  try { server && server.close() } catch (_) {}
  for (const socket of liveSockets) { try { socket.destroy() } catch {} }
  liveSockets.clear()
  process.exitCode = code
}

/** 造一个"真实感"的插件源码目录：含噪音（node_modules / .git）与一个已压缩扩展名文件。 */
function makeAuthorPlugin(): void {
  fs.mkdirSync(path.join(authorDir, 'lib'), { recursive: true })
  fs.mkdirSync(path.join(authorDir, 'assets'), { recursive: true })
  fs.writeFileSync(path.join(authorDir, 'hira-plugin.json'), `${JSON.stringify({
    id: 'acme-demo',
    name: 'Acme 演示插件',
    version: '1.0.0',
    description: '一条命令就能发布的示例',
    author: 'Acme',
    homepage: 'https://example.com/acme',
    main: 'index.cjs',
    render: 'renderer.js'
  }, null, 2)}\n`, 'utf8')
  fs.writeFileSync(path.join(authorDir, 'index.cjs'), 'module.exports = { enable() {}, disable() {} }\n', 'utf8')
  fs.writeFileSync(path.join(authorDir, 'renderer.js'), 'export function activate() {}\n', 'utf8')
  fs.writeFileSync(path.join(authorDir, 'lib', 'util.js'), 'module.exports = 1\n', 'utf8')
  // .png 应走 store（不 deflate）—— 用一个假字节序列即可，扩展名是判据
  fs.writeFileSync(path.join(authorDir, 'assets', 'icon.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47, 1, 2, 3, 4]))
  // 噪音：必须**不**进包（与安装器同一套忽略表）
  fs.mkdirSync(path.join(authorDir, 'node_modules', 'junk'), { recursive: true })
  fs.writeFileSync(path.join(authorDir, 'node_modules', 'junk', 'a.js'), 'x'.repeat(5000), 'utf8')
  fs.mkdirSync(path.join(authorDir, '.git'), { recursive: true })
  fs.writeFileSync(path.join(authorDir, '.git', 'config'), 'noise', 'utf8')
}

async function main(): Promise<void> {
  fs.mkdirSync(userDir, { recursive: true })
  fs.mkdirSync(trustDir, { recursive: true })
  makeAuthorPlugin()
  await startServer(distDir)
  console.log(`[verify:plugin-publish] 沙箱：${SANDBOX}\n托管地址：${baseUrl}`)

  // ── 打包 ─────────────────────────────────────────────────
  console.log('\n打包（plugin:publish）')

  let zipPath = ''
  let indexJson: MarketplaceIndex | null = null

  await t('发布成功：产出 zip + 就地合并索引，且打印 sha256', () => {
    const r = publish([authorDir, '--out', distDir, '--index', path.join(distDir, 'index.json')])
    assertEq(r.status, 0, `应成功，实际退出码 ${r.status}\n${r.stderr}`)
    zipPath = path.join(distDir, 'acme-demo-1.0.0.zip')
    assert(fs.existsSync(zipPath), '应产出 zip')
    assert(fs.existsSync(path.join(distDir, 'index.json')), '应产出索引')
    assert(/sha256\s+[0-9a-f]{64}/.test(r.stdout), '应打印 sha256')
    indexJson = JSON.parse(fs.readFileSync(path.join(distDir, 'index.json'), 'utf8')) as MarketplaceIndex
    assertEq(indexJson.schema, 1, 'schema')
    assertEq(indexJson.plugins.length, 1, '条目数')
    const e = indexJson.plugins[0]
    assertEq(e.id, 'acme-demo', 'id')
    assertEq(e.version, '1.0.0', 'version')
    assertEq(e.url, './acme-demo-1.0.0.zip', '未给 --base-url 时应写相对路径')
    assertEq(e.author, 'Acme', 'author')
  })

  await t('索引里的 sha256 与**实际字节**一致（否则用户那边必然校验失败）', () => {
    assert(indexJson, '前置：索引应已生成')
    const e = indexJson.plugins[0]
    assertEq(e.sha256, sha256(fs.readFileSync(zipPath)), 'sha256')
  })

  await t('包内条目正确：噪音被排除、已压缩扩展名走 store', () => {
    const entries = readZipEntries(fs.readFileSync(zipPath))
    const names = entries.map((entry) => entry.name).sort()
    assertEq(names.join(','), 'assets/icon.png,hira-plugin.json,index.cjs,lib/util.js,renderer.js', '条目')
    assert(!names.some((name) => name.includes('node_modules')), 'node_modules 不应进包')
    assert(!names.some((name) => name.includes('.git')), '.git 不应进包')
    const png = entries.find((entry) => entry.name === 'assets/icon.png')
    assert(png, '应包含 assets/icon.png')
    assertEq(png.method, 0, '.png 应以 store(0) 方式存')
    const js = entries.find((entry) => entry.name === 'lib/util.js')
    assert(js, '应包含 lib/util.js')
    assertEq(js.method, 8, '.js 应 deflate(8)')
  })

  await t('重复发布：同 id 覆盖条目而不是追加（版本号变了就换新条目）', () => {
    const mf = JSON.parse(fs.readFileSync(path.join(authorDir, 'hira-plugin.json'), 'utf8'))
    fs.writeFileSync(path.join(authorDir, 'hira-plugin.json'), `${JSON.stringify({ ...mf, version: '1.1.0' }, null, 2)}\n`)
    const r = publish([authorDir, '--out', distDir, '--index', path.join(distDir, 'index.json')])
    assertEq(r.status, 0, `应成功：${r.stderr}`)
    const idx = JSON.parse(fs.readFileSync(path.join(distDir, 'index.json'), 'utf8'))
    assertEq(idx.plugins.length, 1, '仍应只有一条（按 id 覆盖）')
    assertEq(idx.plugins[0].version, '1.1.0', 'version')
    assert(fs.existsSync(path.join(distDir, 'acme-demo-1.1.0.zip')), '应产出新版本的 zip')
    // 回到 1.0.0 继续后面的用例（保持可预期）
    fs.writeFileSync(path.join(authorDir, 'hira-plugin.json'), `${JSON.stringify(mf, null, 2)}\n`)
    publish([authorDir, '--out', distDir, '--index', path.join(distDir, 'index.json')])
  })

  await t('体检不通过 → 非零退出（发布侧与安装侧同一套判据）', () => {
    const badDir = path.join(SANDBOX, 'bad-plugin')
    fs.mkdirSync(badDir, { recursive: true })
    fs.writeFileSync(path.join(badDir, 'hira-plugin.json'), JSON.stringify({ id: 'bad', main: 'missing.cjs' }))
    const r = publish([badDir, '--out', path.join(SANDBOX, 'bad-dist')])
    assert(r.status !== 0, '应失败')
    assert(/入口不存在|体检未通过/.test(r.stdout + r.stderr), `应说明原因：${r.stdout}${r.stderr}`)
    assert(!fs.existsSync(path.join(SANDBOX, 'bad-dist', 'bad-0.0.0.zip')), '不应产出 zip')
  })

  await t('--dry-run 不写任何文件', () => {
    const dryDir = path.join(SANDBOX, 'dry-dist')
    const r = publish([authorDir, '--out', dryDir, '--index', path.join(dryDir, 'index.json'), '--dry-run'])
    assertEq(r.status, 0, `应成功：${r.stderr}`)
    assert(/sha256/.test(r.stdout), '仍应打印 sha256（用户想先看一眼）')
    assert(!fs.existsSync(dryDir), '不应创建产物目录')
  })

  // ── 打包 → 托管 → 安装（闭环第一段）─────────────────────
  console.log('\n闭环：作者打包 → 静态托管 → 用户从源安装')

  let installed = false
  await t('从托管的索引安装发布出来的包（含 sha256 校验）', async () => {
    // 索引里的 url 是相对路径 → market 会按索引地址解析；这里把索引指向托管的那个
    const installer = createPluginInstaller({ userPluginDir: userDir })
    const sourceUrl = `${baseUrl}/index.json`
    const market = createPluginMarket({
      installer,
      getSources: () => [sourceUrl],
      setSources: () => [sourceUrl],
      getLocalVersions: () => ({})
    })
    const res = await market.install('acme-demo', { force: true })
    assert(res.ok, `应成功：${res.reason}`)
    assertEq(res.verified, true, 'verified（索引声明了 sha256 且通过）')
    assertEq(res.version, '1.0.0', 'version')
    installed = true
  })

  await t('装出来的内容与作者源码一致（含子目录文件，且不含噪音）', () => {
    assert(installed, '前置：应先安装成功')
    const target = path.join(userDir, 'acme-demo')
    assert(fs.existsSync(path.join(target, 'hira-plugin.json')), 'manifest')
    assert(fs.existsSync(path.join(target, 'lib', 'util.js')), '子目录文件')
    assert(fs.existsSync(path.join(target, 'assets', 'icon.png')), '资源文件')
    assert(!fs.existsSync(path.join(target, 'node_modules')), '不应带噪音')
    const mf = JSON.parse(fs.readFileSync(path.join(target, 'hira-plugin.json'), 'utf8'))
    assertEq(mf.version, '1.0.0', 'version')
    assertEq(mf.id, 'acme-demo', 'id')
  })

  // ── 签名 → 验签（闭环第二段）────────────────────────────
  console.log('\n闭环：作者签名 → 用户验签')

  const keyDir = path.join(SANDBOX, 'keys')
  const privPath = path.join(keyDir, 'acme-publisher.pem')
  const pubPath = path.join(keyDir, 'acme-publisher.pub.pem')

  await t('用私钥发布：签名写回源 manifest，并提示用户要放哪把公钥', () => {
    fs.mkdirSync(keyDir, { recursive: true })
    const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519')
    fs.writeFileSync(privPath, privateKey.export({ type: 'pkcs8', format: 'pem' }), 'utf8')
    fs.writeFileSync(pubPath, publicKey.export({ type: 'spki', format: 'pem' }), 'utf8')

    const r = publish([authorDir, '--out', distDir, '--index', path.join(distDir, 'index.json'), '--key', privPath, '--key-id', 'acme-publisher'])
    assertEq(r.status, 0, `应成功：${r.stdout}${r.stderr}`)
    assert(/已签名/.test(r.stdout), '应打印已签名')
    assert(/plugin-trust\/acme-publisher\.pem/.test(r.stdout), '应提示公钥要放哪')
    const mf = JSON.parse(fs.readFileSync(path.join(authorDir, 'hira-plugin.json'), 'utf8'))
    assert(mf.signature, '签名应写回源 manifest')
    assertEq(mf.signature.algo, 'ed25519', 'algo')
    assertEq(mf.signature.keyId, 'acme-publisher', 'keyId')
    assert(mf.signature.value, 'value 不应为空')
  })

  await t('--no-write-manifest：签名只进 zip，源文件不被改动', () => {
    const before = fs.readFileSync(path.join(authorDir, 'hira-plugin.json'), 'utf8')
    fs.writeFileSync(path.join(authorDir, 'hira-plugin.json'), `${JSON.stringify({ ...JSON.parse(before), signature: undefined }, null, 2)}\n`)
    const clean = fs.readFileSync(path.join(authorDir, 'hira-plugin.json'), 'utf8')
    const r = publish([authorDir, '--out', distDir, '--index', path.join(distDir, 'index.json'), '--key', privPath, '--key-id', 'acme-publisher', '--no-write-manifest'])
    assertEq(r.status, 0, `应成功：${r.stdout}${r.stderr}`)
    assertEq(fs.readFileSync(path.join(authorDir, 'hira-plugin.json'), 'utf8'), clean, '源文件不应被改动')
    // zip 里那份应当**带签名**（不然这次签名就白做了）
    const inZip = JSON.parse(readZipText(fs.readFileSync(path.join(distDir, 'acme-demo-1.0.0.zip')), 'hira-plugin.json'))
    assert(inZip.signature && inZip.signature.keyId === 'acme-publisher', 'zip 里的 manifest 应带签名')
  })

  await t('把公钥放进 plugin-trust 后安装 → signature.status = valid', async () => {
    // 重新用写回模式发布一次，保证 zip 与源 manifest 一致（上一条用了 --no-write-manifest）
    const r = publish([authorDir, '--out', distDir, '--index', path.join(distDir, 'index.json'), '--key', privPath, '--key-id', 'acme-publisher'])
    assertEq(r.status, 0, `应成功：${r.stdout}${r.stderr}`)
    fs.copyFileSync(pubPath, path.join(trustDir, 'acme-publisher.pem'))

    // 先清掉上一次装的，确保这次是真的从包里解出来的
    fs.rmSync(path.join(userDir, 'acme-demo'), { recursive: true, force: true })
    const installer = createPluginInstaller({ userPluginDir: userDir, trustDir })
    const sourceUrl = `${baseUrl}/index.json`
    const market = createPluginMarket({
      installer,
      getSources: () => [sourceUrl],
      setSources: () => [sourceUrl],
      getLocalVersions: () => ({})
    })
    const res = await market.install('acme-demo', { force: true })
    assert(res.ok, `应成功：${res.reason}`)
    assertEq(res.signature && res.signature.status, 'valid', `signature.status（理由：${(res.signature || {}).reason || '-'}）`)
    assertEq(res.verified, true, 'verified')
  })

  await t('没有对应公钥时 → unknown-key（**仍可安装**，与 invalid 是两回事）', async () => {
    fs.rmSync(path.join(trustDir, 'acme-publisher.pem'), { force: true })
    fs.rmSync(path.join(userDir, 'acme-demo'), { recursive: true, force: true })
    const installer = createPluginInstaller({ userPluginDir: userDir, trustDir })
    const res = await installer.installArchive(path.join(distDir, 'acme-demo-1.0.0.zip'))
    assert(res.ok, `应能装上（不该被签名拦住）：${res.reason}`)
    assert(res.signature, '应返回签名结果')
    assertEq(res.signature.status, 'unknown-key', 'status')
  })

  await t('内容被改过 → invalid（发布后有人动过包，用户侧能看出来）', async () => {
    /**
     * 造"被改过的包"：解出原包的条目 → 改 manifest 里的 `name`（**保留 signature**）→ 重新打包。
     * 注意数据必须过 `extractEntry` 再重打（`readZipEntries` 给的是压缩后的字节）。
     */
    const { makeZip } = require('./lib/mini-zip.ts')
    const original = fs.readFileSync(path.join(distDir, 'acme-demo-1.0.0.zip'))
    const rebuilt = makeZip(readZipEntries(original).map((entry) => {
      const raw = extractEntry(entry)
      if (entry.name !== 'hira-plugin.json') return { name: entry.name, data: raw, deflate: entry.method === 8 }
      const mf = JSON.parse(raw.toString('utf8'))
      mf.name = '被改过的名字'
      return { name: entry.name, data: Buffer.from(JSON.stringify(mf, null, 2), 'utf8'), deflate: true }
    }))
    const tampered = path.join(SANDBOX, 'tampered.zip')
    fs.writeFileSync(tampered, rebuilt)

    // 上一条用例把公钥移走了；这一条要看的是"签名与内容不符"，所以先把公钥放回去
    fs.copyFileSync(pubPath, path.join(trustDir, 'acme-publisher.pem'))

    const installer = createPluginInstaller({ userPluginDir: path.join(SANDBOX, 'tamper-plugins'), trustDir })
    const res = await installer.installArchive(tampered)
    assert(res.ok, `仍应装上（签名不阻止安装）：${res.reason}`)
    assert(res.signature, '应返回签名结果')
    assertEq(res.signature.status, 'invalid', 'status')
    assert(/不符/.test(res.signature.reason || ''), `原因应说明内容与签名不符，实际：${res.signature.reason}`)
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
  console.error('[verify:plugin-publish] 运行失败：', errorMessage(error))
  try { fs.rmSync(SANDBOX, { recursive: true, force: true }) } catch (_) {}
  shutdown(2)
})
