#!/usr/bin/env node
/**
 * 插件安装器体检 —— `pnpm verify:plugin-install`
 *
 * 只测 `plugin-installer.js` + `plugin-archive.js` 这两个**纯文件系统**模块：
 * 不启 Electron、不启注册中心、不碰 IPC。这不是"少测了点"，而是刻意让它们可被这样测 ——
 * "装完起不来"这类问题必须在**没有整机**的情况下也能复现，否则排查成本高到没人会去查。
 *
 * ══════════════════════════════════════════════════════════════════════
 * 为什么自带一个"zip writer"而不是用系统压缩工具
 * ══════════════════════════════════════════════════════════════════════
 * 最需要测的那条边界是 **zip-slip**（条目名里写 `../`）。系统自带的压缩工具
 * **不会**让你造出这种包 —— 而"造不出攻击样本"恰恰意味着这条防线永远没被验过。
 * 所以这里手写一个最小 writer，条目名完全由我们控制。
 *
 * 退出码：0 = 全通；1 = 有失败（可直接当门禁用）。
 */

import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import * as crypto from 'node:crypto'
import { errorMessage } from './lib/type-guards'

interface TestFailure { name: string; error: string }
interface SignatureInfo { status: string; reason?: string; level?: string }
interface InspectInfo {
  ok: boolean
  id?: string
  name?: string
  version?: string
  errors: string[]
  warnings: string[]
  signature: SignatureInfo
}
interface OperationResult {
  ok: boolean
  reason?: string
  id?: string
  keyId?: string
  level?: string
  signature?: SignatureInfo
}
interface TrustedKey {
  keyId: string
  readable?: boolean
  fingerprint: string
  algo: string
  level: string
  removable: boolean
}
interface TreeFile { rel: string }
interface Installer {
  _internals: {
    resolveInside(base: string, relative: string): string | null
    canonicalBytes(value: unknown): Buffer
    collectTree(dir: string): { files: TreeFile[]; warnings?: string[] }
    findTrustedKey(keyId: string): TrustedKey | null
  }
  inspectDir(dir: string): InspectInfo
  listInstalled(): string[]
  installDirectory(dir: string, options?: { overwrite?: boolean }): Promise<OperationResult>
  installArchive(path: string, options?: { overwrite?: boolean }): Promise<OperationResult>
  uninstall(id: string): Promise<OperationResult>
  listTrustedKeys(): TrustedKey[]
  addTrustedKey(path: string, options?: { level?: string }): Promise<OperationResult>
  removeTrustedKey(keyId: string, level?: string): Promise<OperationResult>
  verifySignature(manifest: Record<string, unknown>): SignatureInfo
}

const ROOT = path.resolve(__dirname, '..')
const { createPluginInstaller, readBuiltinPluginIds } = require(
  path.join(ROOT, 'apps', 'app-main', 'src', 'main', 'plugin-installer.js')
) as {
  createPluginInstaller: (options: Record<string, unknown>) => Installer
  readBuiltinPluginIds: (dir: string) => string[]
}

let passed = 0
let skipped = 0
const failures: TestFailure[] = []

/**
 * 跑一条检查。**全部按 async 走** —— 安装器的方法几乎都是 Promise，
 * 用同步版包住会让断言失败变成 unhandled rejection（表现为"这条过了"，最坏的一种假绿）。
 */
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

// ─────────────────────────────────────────────────────────────
// 最小 ZIP writer（只为造样本，含合法的与恶意的）
// 抽到 scripts/lib/mini-zip.cjs：市场验证脚本也要用同一份 —— 两份实现迟早分叉，
// 而"压缩包样本的造法不一致"会让两条验证互相掩盖对方的 bug。
// ─────────────────────────────────────────────────────────────
const { makeZip } = require('./lib/mini-zip.ts')

// ─────────────────────────────────────────────────────────────
// 现场
// ─────────────────────────────────────────────────────────────
const SANDBOX = fs.mkdtempSync(path.join(os.tmpdir(), 'hira-plugin-install-'))
const userDir = path.join(SANDBOX, 'plugins')
const srcRoot = path.join(SANDBOX, 'sources')
const trustDir = path.join(SANDBOX, 'trust')
/** 官方级公钥目录（真机上在应用资源目录里、随应用分发，这里用沙箱目录代替）。 */
const officialTrustDir = path.join(SANDBOX, 'official-trust')
const builtinDir = path.join(SANDBOX, 'builtin-plugins')
for (const d of [userDir, srcRoot, trustDir, officialTrustDir, builtinDir]) fs.mkdirSync(d, { recursive: true })

const ENTRY_SRC = 'module.exports = { install() {}, enable() {}, disable() {} }\n'

/** 造一个"合法插件"目录（文件名演示 <id>，id 由 manifest 决定）。 */
function makePluginDir(folderName: string, manifest: Record<string, unknown>, entrySource = ENTRY_SRC): string {
  const dir = path.join(srcRoot, folderName)
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(path.join(dir, 'hira-plugin.json'), JSON.stringify(manifest, null, 2), 'utf8')
  if (typeof manifest.main === 'string' && manifest.main) fs.writeFileSync(path.join(dir, manifest.main), entrySource, 'utf8')
  return dir
}

// 内置插件目录：装两个假的内置插件（扁平 + 目录两种形态）
fs.writeFileSync(path.join(builtinDir, 'tabs-service.hira-plugin.json'), JSON.stringify({ id: 'tabs-service' }))
fs.writeFileSync(path.join(builtinDir, 'broken.hira-plugin.json'), '{ not json')
fs.mkdirSync(path.join(builtinDir, 'panel-notes'), { recursive: true })
fs.writeFileSync(path.join(builtinDir, 'panel-notes', 'hira-plugin.json'), JSON.stringify({ id: 'panel-notes' }))

const installer = createPluginInstaller({
  userPluginDir: userDir,
  // 内置名单传**函数**（与 main.js 一致）：重点是"名单从磁盘来、不会过期"
  builtinPluginIds: () => readBuiltinPluginIds(builtinDir),
  trustDir,
  // 官方级目录也接上（真机上它是应用资源目录，这里用沙箱目录）——
  // 分级里最要紧的一条"官方优先且不可移除"没有它测不了
  officialTrustDir
})
const { resolveInside, canonicalBytes, collectTree, findTrustedKey } = installer._internals

async function main(): Promise<void> {
  console.log(`[verify:plugin-install] 沙箱：${SANDBOX}`)

  // ── 体检（dry-run，不写任何东西）────────────────────────────
  console.log('\n体检（不落盘）')

  const goodDir = makePluginDir('demo-plugin', {
    id: 'demo-plugin', name: '演示插件', version: '1.0.0', main: 'index.cjs'
  })

  await t('合法插件体检通过', () => {
    const info = installer.inspectDir(goodDir)
    assert(info.ok, `应通过，实际错误：${info.errors.join('；')}`)
    assertEq(info.id, 'demo-plugin', 'id')
    assertEq(info.name, '演示插件', 'name')
    assertEq(info.version, '1.0.0', 'version')
  })

  await t('缺 manifest → 不通过', () => {
    const empty = path.join(srcRoot, 'empty-plugin')
    fs.mkdirSync(empty, { recursive: true })
    fs.writeFileSync(path.join(empty, 'readme.txt'), 'x')
    const info = installer.inspectDir(empty)
    assert(!info.ok)
    assert(info.errors.some((e) => e.includes('hira-plugin.json')), '应提示缺清单')
  })

  await t('id 含路径分隔符 → 不通过（它同时是目录名）', () => {
    const dir = makePluginDir('bad-id-a', { id: 'a/b', main: 'index.cjs' })
    const info = installer.inspectDir(dir)
    assert(!info.ok)
    assert(info.errors.some((e) => e.includes('不合法')), '应提示 id 不合法')
  })

  await t('id 为 .. → 不通过', () => {
    const dir = makePluginDir('bad-id-b', { id: '..', main: 'index.cjs' })
    assert(!installer.inspectDir(dir).ok, '必须拒绝（否则等于允许写到父目录）')
  })

  await t('与内置插件重名 → 不通过（提权路径）', () => {
    const dir = makePluginDir('evil-tabs', { id: 'tabs-service', main: 'index.cjs' })
    const info = installer.inspectDir(dir)
    assert(!info.ok)
    assert(info.errors.some((e) => e.includes('内置插件重名')), '应提示撞名')
  })

  await t('与内置的**目录形态**插件重名也挡得住', () => {
    const dir = makePluginDir('evil-notes', { id: 'panel-notes', main: 'index.cjs' })
    assert(!installer.inspectDir(dir).ok, '面板插件同样不能被顶掉')
  })

  await t('声明的 main 入口不存在 → 不通过', () => {
    const dir = path.join(srcRoot, 'missing-entry')
    fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(path.join(dir, 'hira-plugin.json'), JSON.stringify({ id: 'missing-entry', main: 'nope.cjs' }))
    const info = installer.inspectDir(dir)
    assert(!info.ok)
    assert(info.errors.some((e) => e.includes('入口不存在')), '应提示入口不存在')
  })

  await t('目录穿越守卫：resolve 后比前缀（不是过滤 ..）', () => {
    assertEq(resolveInside('/a/plugins', '../evil'), null, '../evil 应被拒')
    assertEq(resolveInside('/a/plugins', 'x/../../evil'), null, '曲折路径应被拒')
    assertEq(resolveInside('/a/plugins', 'ok/file.js'), path.resolve('/a/plugins/ok/file.js'), '正常路径应放行')
    // 关键：同前缀的兄弟目录不能被判成"在里面"
    assertEq(resolveInside('/a/plugins', '../plugins-evil/x'), null, '同前缀兄弟目录应被拒')
  })

  // ── 安装 / 覆盖 ─────────────────────────────────────────────
  console.log('\n安装 / 覆盖')

  await t('从目录安装成功（含入口与清单）', async () => {
    const res = await installer.installDirectory(goodDir)
    assert(res.ok, `应成功，实际：${res.reason}`)
    assertEq(res.id, 'demo-plugin', 'id')
    const target = path.join(userDir, 'demo-plugin')
    assert(fs.existsSync(path.join(target, 'hira-plugin.json')), '目标目录应有 manifest')
    assert(fs.existsSync(path.join(target, 'index.cjs')), '目标目录应有入口')
    assert(installer.listInstalled().includes('demo-plugin'), 'listInstalled 应包含它')
  })

  await t('同 id 再次安装（无 overwrite）→ 拒绝并提示可执行的动作', async () => {
    const res = await installer.installDirectory(goodDir)
    assert(!res.ok, '应被拒')
    assert(/已安装/.test(res.reason || ''), `原因应说明已安装，实际：${res.reason}`)
  })

  await t('覆盖安装：内容真的换新，且不留备份目录', async () => {
    const dir = makePluginDir('over-plugin', { id: 'over-plugin', name: 'v1', main: 'index.cjs' })
    const first = await installer.installDirectory(dir)
    assert(first.ok, `首次应成功：${first.reason}`)
    fs.writeFileSync(path.join(dir, 'hira-plugin.json'), JSON.stringify({ id: 'over-plugin', name: 'v2', main: 'index.cjs' }))
    const over = await installer.installDirectory(dir, { overwrite: true })
    assert(over.ok, `覆盖应成功：${over.reason}`)
    const onDisk = JSON.parse(fs.readFileSync(path.join(userDir, 'over-plugin', 'hira-plugin.json'), 'utf8'))
    assertEq(onDisk.name, 'v2', '磁盘上应是新内容')
    assert(!fs.readdirSync(userDir).some((n) => n.startsWith('.old-')), '不应留下备份目录')
    assert(!fs.readdirSync(userDir).some((n) => n.startsWith('.install-')), '不应留下暂存目录')
  })

  await t('从用户插件目录内部安装 → 拒绝（边写边读会无限膨胀）', async () => {
    const res = await installer.installDirectory(path.join(userDir, 'demo-plugin'))
    assert(!res.ok)
    assert(/插件目录内部/.test(res.reason || ''), `原因应说明来源非法，实际：${res.reason}`)
  })

  // ── 压缩包 ─────────────────────────────────────────────────
  console.log('\n压缩包（含恶意样本）')

  await t('installArchive：正常 zip 能装（store + deflate + 目录项）', async () => {
    const manifest = JSON.stringify({ id: 'zip-plugin', name: '压缩包装的插件', version: '0.2.0', main: 'index.cjs' }, null, 2)
    const zipPath = path.join(SANDBOX, 'zip-plugin.zip')
    fs.writeFileSync(zipPath, makeZip([
      { name: 'nested/' },
      { name: 'hira-plugin.json', data: Buffer.from(manifest, 'utf8') },
      { name: 'index.cjs', data: Buffer.from(ENTRY_SRC, 'utf8'), deflate: true },
      { name: 'assets/logo.txt', data: Buffer.from('hello', 'utf8'), deflate: true }
    ]))
    const res = await installer.installArchive(zipPath)
    assert(res.ok, `应成功，实际：${res.reason}`)
    assert(fs.existsSync(path.join(userDir, 'zip-plugin', 'assets', 'logo.txt')), 'assets 应被解出来')
  })

  await t('ZIP64 哨兵 → 明确报错而不是猜着解', async () => {
    const buf = makeZip([{ name: 'a.txt', data: Buffer.from('x') }])
    buf.writeUInt16LE(0xffff, buf.length - 22 + 10)
    const bad = path.join(SANDBOX, 'zip64.zip')
    fs.writeFileSync(bad, buf)
    const res = await installer.installArchive(bad)
    assert(!res.ok, '应被拒')
    assert(/ZIP64/.test(res.reason || ''), `原因应说明 ZIP64，实际：${res.reason}`)
  })

  await t('zip-slip：条目名带 ../ → 拒绝，且**沙箱外真的没落文件**', async () => {
    const evil = path.join(SANDBOX, 'slip.zip')
    const outside = path.join(SANDBOX, 'pwned.txt')
    try { fs.unlinkSync(outside) } catch (_) {}
    fs.writeFileSync(evil, makeZip([
      { name: 'hira-plugin.json', data: Buffer.from(JSON.stringify({ id: 'slip-plugin', main: 'index.cjs' }), 'utf8') },
      { name: '../pwned.txt', data: Buffer.from('owned', 'utf8') }
    ]))
    const res = await installer.installArchive(evil)
    assert(!res.ok, '应被拒')
    assert(/越界/.test(res.reason || ''), `原因应说明越界，实际：${res.reason}`)
    // 关键：不能只看返回值 —— 要确认它**真的没写出去**
    assert(!fs.existsSync(outside), '沙箱外不应出现被写入的文件')
    assert(!fs.existsSync(path.join(userDir, 'slip-plugin')), '不应留下半个插件目录')
  })

  await t('损坏的压缩包 → 明确报错（不是崩）', async () => {
    const bad = path.join(SANDBOX, 'garbage.zip')
    fs.writeFileSync(bad, Buffer.from('this is definitely not a zip file, not even close'))
    const res = await installer.installArchive(bad)
    assert(!res.ok)
    assert(/压缩包/.test(res.reason || ''), `原因应说明压缩包问题，实际：${res.reason}`)
  })

  // ── 签名 ───────────────────────────────────────────────────
  console.log('\n签名（四态必须分开，不能合并成"没签名"）')

  await t('无签名 → none', () => {
    assertEq(installer.inspectDir(goodDir).signature.status, 'none', 'status')
  })

  let signingKey: crypto.KeyPairKeyObjectResult | null = null
  await t('签名正确 → valid', () => {
    signingKey = crypto.generateKeyPairSync('ed25519')
    const dir = path.join(srcRoot, 'signed-plugin')
    fs.mkdirSync(dir, { recursive: true })
    const base = { id: 'signed-plugin', name: '已签名', main: 'index.cjs' }
    assert(signingKey, '签名密钥应已生成')
    const value = crypto.sign(null, canonicalBytes(base), signingKey.privateKey).toString('base64')
    fs.writeFileSync(path.join(dir, 'hira-plugin.json'), JSON.stringify({
      // 刻意把字段写成**不同顺序**：签名必须对"字段顺序无关"成立
      signature: { algo: 'ed25519', keyId: 'test-key', value },
      main: base.main,
      name: base.name,
      id: base.id
    }, null, 2))
    fs.writeFileSync(path.join(dir, 'index.cjs'), ENTRY_SRC)
    fs.writeFileSync(path.join(trustDir, 'test-key.pem'), signingKey.publicKey.export({ type: 'spki', format: 'pem' }))
    const info = installer.inspectDir(dir)
    assertEq(info.signature.status, 'valid', `status（理由：${info.signature.reason || '-'}）`)
    assert(info.ok, '签名有效不应影响体检通过')
  })

  await t('签名与内容不符 → invalid', () => {
    const dir = path.join(srcRoot, 'tampered-plugin')
    fs.mkdirSync(dir, { recursive: true })
    const other = crypto.generateKeyPairSync('ed25519')
    const value = crypto.sign(null, canonicalBytes({ id: 'tampered-plugin', name: '被改过', main: 'index.cjs' }), other.privateKey).toString('base64')
    fs.writeFileSync(path.join(dir, 'hira-plugin.json'), JSON.stringify({
      id: 'tampered-plugin', main: 'index.cjs', name: '内容被换了',
      signature: { algo: 'ed25519', keyId: 'test-key', value }
    }, null, 2))
    fs.writeFileSync(path.join(dir, 'index.cjs'), ENTRY_SRC)
    assertEq(installer.inspectDir(dir).signature.status, 'invalid', 'status')
  })

  await t('有签名但本机没有公钥 → unknown-key（**不等于** invalid）', () => {
    const dir = path.join(srcRoot, 'unknown-key-plugin')
    fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(path.join(dir, 'hira-plugin.json'), JSON.stringify({
      id: 'unknown-key-plugin', main: 'index.cjs',
      signature: { algo: 'ed25519', keyId: 'never-heard-of-it', value: 'AAAA' }
    }, null, 2))
    fs.writeFileSync(path.join(dir, 'index.cjs'), ENTRY_SRC)
    const info = installer.inspectDir(dir)
    assertEq(info.signature.status, 'unknown-key', 'status')
    assert(info.ok, 'unknown-key 不应让体检失败（社区生态不该被一把没配好的钥匙卡住）')
  })

  await t('签名算法不支持 → invalid 且说明原因', () => {
    const dir = path.join(srcRoot, 'bad-algo-plugin')
    fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(path.join(dir, 'hira-plugin.json'), JSON.stringify({
      id: 'bad-algo-plugin', main: 'index.cjs',
      signature: { algo: 'md5', keyId: 'test-key', value: 'AA' }
    }, null, 2))
    fs.writeFileSync(path.join(dir, 'index.cjs'), ENTRY_SRC)
    const info = installer.inspectDir(dir)
    assertEq(info.signature.status, 'invalid', 'status')
    assert(/算法/.test(info.signature.reason || ''), '应说明算法问题')
  })

  await t('keyId 里的路径字符被挡住（否则能读任意 .pem）', () => {
    const dir = path.join(srcRoot, 'path-key-plugin')
    fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(path.join(dir, 'hira-plugin.json'), JSON.stringify({
      id: 'path-key-plugin', main: 'index.cjs',
      signature: { algo: 'ed25519', keyId: '../../etc/passwd', value: 'AA' }
    }, null, 2))
    fs.writeFileSync(path.join(dir, 'index.cjs'), ENTRY_SRC)
    assertEq(installer.inspectDir(dir).signature.status, 'invalid', 'status')
  })

  // ── 符号链接与忽略项 ───────────────────────────────────────
  console.log('\n符号链接与忽略项')

  await t('符号链接被跳过（不跟随，否则一次安装会搬走整台机器）', () => {
    const dir = path.join(srcRoot, 'symlink-plugin')
    fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(path.join(dir, 'hira-plugin.json'), JSON.stringify({ id: 'symlink-plugin', main: 'index.cjs' }))
    fs.writeFileSync(path.join(dir, 'index.cjs'), ENTRY_SRC)
    const outsideDir = path.join(SANDBOX, 'outside-secret')
    fs.mkdirSync(outsideDir, { recursive: true })
    fs.writeFileSync(path.join(outsideDir, 'secret.txt'), 'top secret')
    try {
      fs.symlinkSync(outsideDir, path.join(dir, 'link'), 'junction')
    } catch (_) {
      return 'skip'
    }
    const tree = collectTree(dir)
    assert(tree.warnings?.some((warning) => warning.includes('符号链接')), '应记录一条跳过的告警')
    assert(!tree.files.some((f) => f.rel.startsWith('link/')), '链接目录下的文件不应被收进来')
  })

  await t('node_modules / .git 永不被带走', () => {
    const dir = path.join(srcRoot, 'noise-plugin')
    fs.mkdirSync(path.join(dir, 'node_modules', 'x'), { recursive: true })
    fs.mkdirSync(path.join(dir, '.git'), { recursive: true })
    fs.writeFileSync(path.join(dir, 'hira-plugin.json'), JSON.stringify({ id: 'noise-plugin', main: 'index.cjs' }))
    fs.writeFileSync(path.join(dir, 'index.cjs'), ENTRY_SRC)
    fs.writeFileSync(path.join(dir, 'node_modules', 'x', 'index.js'), 'x')
    fs.writeFileSync(path.join(dir, '.git', 'config'), 'x')
    const tree = collectTree(dir)
    assert(!tree.files.some((f) => f.rel.includes('node_modules')), 'node_modules 应被忽略')
    assert(!tree.files.some((f) => f.rel.includes('.git')), '.git 应被忽略')
  })

  await t('readBuiltinPluginIds 读磁盘（名单不会过期）；坏 manifest 不连坐', () => {
    const ids = readBuiltinPluginIds(builtinDir)
    assert(ids.includes('tabs-service'), '应收扁平形态')
    assert(ids.includes('panel-notes'), '应收目录形态')
    assertEq(ids.length, 2, '坏 manifest 不应让整轮失败')
  })

  // ── 卸载 ───────────────────────────────────────────────────
  console.log('\n卸载')

  await t('卸载删掉整个目录', async () => {
    const res = await installer.uninstall('zip-plugin')
    assert(res.ok, `应成功，实际：${res.reason}`)
    assert(!fs.existsSync(path.join(userDir, 'zip-plugin')), '目录应已消失')
  })

  await t('卸载不存在的插件 → 明确失败（不静默成功）', async () => {
    const res = await installer.uninstall('never-installed')
    assert(!res.ok)
    assert(/未找到/.test(res.reason || ''), '原因应说明未找到')
  })

  await t('卸载时 id 非法（../）→ 拒绝（不能让一次调用变成删别人目录）', async () => {
    const res = await installer.uninstall('../outside-secret')
    assert(!res.ok, '必须拒绝')
    assert(fs.existsSync(path.join(SANDBOX, 'outside-secret')), '沙箱里的其它目录必须还在')
  })

  await t('安装过的插件仍在清单里（卸载不影响别人）', () => {
    const list = installer.listInstalled()
    assert(list.includes('demo-plugin'), 'demo-plugin 应还在')
    assert(!list.some((n) => n.startsWith('.')), '临时/备份目录不应出现在列表里')
  })

  // ── 受信任公钥（验签的另一半）──────────────────────────────
  console.log('\n受信任公钥（导入 / 列出 / 移除）')

  await t('listTrustedKeys 列出已导入的公钥（含指纹 / 算法 / **级别**）', () => {
    const keys = installer.listTrustedKeys()
    const hit = keys.find((k) => k.keyId === 'test-key')
    assert(hit, '前面签名用例导入的 test-key 应出现在列表里')
    assert(hit.readable !== false, '应可解析')
    assert(/^[0-9a-f]{16}$/.test(hit.fingerprint), `指纹应是 16 位十六进制，实际：${hit.fingerprint}`)
    assertEq(hit.algo, 'ed25519', 'algo')
    // 级别必须回报：界面上"我这把钥匙算不算数"全靠它
    assertEq(hit.level, 'community', 'level')
    assertEq(hit.removable, true, 'removable')
  })

  await t('addTrustedKey：不是公钥的文件被拒（不留下一把永远验不过的钥匙）', async () => {
    const junk = path.join(SANDBOX, 'not-a-key.pem')
    fs.writeFileSync(junk, 'this is not a pem at all')
    const res = await installer.addTrustedKey(junk)
    assert(!res.ok, '应被拒')
    assert(/有效的公钥/.test(res.reason || ''), `原因应说明不是公钥，实际：${res.reason}`)
    assert(!fs.existsSync(path.join(trustDir, 'not-a-key.pem')), '不应落盘')
  })

  await t('addTrustedKey：keyId 取**文件名**（manifest 就是按它找文件的）', async () => {
    const { publicKey } = crypto.generateKeyPairSync('ed25519')
    const src = path.join(SANDBOX, 'acme-publisher.pem')
    fs.writeFileSync(src, publicKey.export({ type: 'spki', format: 'pem' }))
    const res = await installer.addTrustedKey(src)
    assert(res.ok, `应成功：${res.reason}`)
    assertEq(res.keyId, 'acme-publisher', 'keyId')
    assert(fs.existsSync(path.join(trustDir, 'acme-publisher.pem')), '应落到 trust 目录')
  })

  await t('addTrustedKey：同名再导入 → 拒绝（不静默覆盖）', async () => {
    const src = path.join(SANDBOX, 'acme-publisher.pem')
    const res = await installer.addTrustedKey(src)
    assert(!res.ok, '应被拒')
    assert(/已存在/.test(res.reason || ''), `原因应说明已存在，实际：${res.reason}`)
  })

  await t('removeTrustedKey：移除后验签回落到 unknown-key（仍是"不阻止安装"，不是 invalid）', async () => {
    const res = await installer.removeTrustedKey('test-key')
    assert(res.ok, `应成功：${res.reason}`)
    const dir = path.join(srcRoot, 'signed-plugin')
    assertEq(installer.inspectDir(dir).signature.status, 'unknown-key', 'status')
  })

  await t('removeTrustedKey：不存在 / keyId 含路径字符 → 明确失败', async () => {
    const missing = await installer.removeTrustedKey('never-imported')
    assert(!missing.ok)
    assert(/未找到/.test(missing.reason || ''), '应说明未找到')
    const evil = await installer.removeTrustedKey('../../evil')
    assert(!evil.ok, '必须拒绝（不能让一次调用变成删别人文件）')
  })

  await t('无法解析的 .pem 也会被列出来（否则用户无从知道它坏了）', async () => {
    fs.writeFileSync(path.join(trustDir, 'broken.pem'), 'not a key')
    const hit = installer.listTrustedKeys().find((k) => k.keyId === 'broken')
    assert(hit, '应列出来')
    assertEq(hit.readable, false, 'readable')
  })

  // ── 信任分级（官方 / 社区 / 本地）────────────────────────────
  console.log('\n信任分级（官方 / 社区 / 本地）')

  await t('默认级别是 community，且标 removable', () => {
    const hit = installer.listTrustedKeys().find((k) => k.keyId === 'acme-publisher')
    assert(hit, '应列出前面导入的那把')
    assertEq(hit.level, 'community', 'level')
    assertEq(hit.removable, true, 'removable')
  })

  await t('addTrustedKey：level=local 落到 trust/local/ 子目录', async () => {
    const { publicKey } = crypto.generateKeyPairSync('ed25519')
    const src = path.join(SANDBOX, 'my-dev-key.pem')
    fs.writeFileSync(src, publicKey.export({ type: 'spki', format: 'pem' }))
    const res = await installer.addTrustedKey(src, { level: 'local' })
    assert(res.ok, `应成功：${res.reason}`)
    assertEq(res.level, 'local', 'level')
    // 单独一个子目录是刻意的：开发用的钥匙能整体清掉，不会和作者的混在一起
    assert(fs.existsSync(path.join(trustDir, 'local', 'my-dev-key.pem')), '应落到 local 子目录')
    const localKey = installer.listTrustedKeys().find((key) => key.keyId === 'my-dev-key')
    assert(localKey, '应列出 local 级公钥')
    assertEq(localKey.level, 'local', '列表里的 level')
  })

  await t('addTrustedKey：level=official → 拒绝（官方级 = 随应用分发）', async () => {
    const src = path.join(SANDBOX, 'my-dev-key.pem')
    const res = await installer.addTrustedKey(src, { level: 'official' })
    assert(!res.ok, '必须拒绝')
    assert(/随应用分发/.test(res.reason || ''), `原因应说明官方级的来源，实际：${res.reason}`)
  })

  // 官方级密钥：直接放进 official 目录（真机上那里是应用资源目录、随应用分发）
  const officialKeys = crypto.generateKeyPairSync('ed25519')
  const officialBase = { id: 'official-signed', main: 'index.cjs' }
  const officialSig = crypto.sign(null, canonicalBytes(officialBase), officialKeys.privateKey).toString('base64')
  fs.writeFileSync(path.join(officialTrustDir, 'official-key.pem'), officialKeys.publicKey.export({ type: 'spki', format: 'pem' }))

  await t('官方级公钥生效，且验签结果带上 level=official', () => {
    const out = installer.verifySignature({
      ...officialBase,
      signature: { algo: 'ed25519', keyId: 'official-key', value: officialSig }
    })
    assertEq(out.status, 'valid', `status（理由：${out.reason || '-'}）`)
    assertEq(out.level, 'official', 'level')
  })

  await t('官方级不可移除（它是"官方签名"，不该被一次误操作搞没）', async () => {
    const res = await installer.removeTrustedKey('official-key', 'official')
    assert(!res.ok, '必须拒绝')
    assert(/随应用分发/.test(res.reason || ''), `原因应说明官方级的来源，实际：${res.reason}`)
    assert(fs.existsSync(path.join(officialTrustDir, 'official-key.pem')), '文件必须还在')
  })

  await t('**官方优先于社区**：同名时取官方那把（优先级就是这条分级的意义）', async () => {
    // 往 community 放一把**同名但不同**的公钥，并用它自己的私钥签名
    const communityKeys = crypto.generateKeyPairSync('ed25519')
    fs.writeFileSync(path.join(trustDir, 'official-key.pem'), communityKeys.publicKey.export({ type: 'spki', format: 'pem' }))
    const value = crypto.sign(null, canonicalBytes(officialBase), communityKeys.privateKey).toString('base64')
    const out = installer.verifySignature({
      ...officialBase,
      signature: { algo: 'ed25519', keyId: 'official-key', value }
    })
    // 查到的是 official 目录里那把 → 用社区那把私钥签的东西**验不过**
    assertEq(out.status, 'invalid', 'status')
    assertEq(out.level, 'official', 'level（说明取的是官方那把）')
    fs.rmSync(path.join(trustDir, 'official-key.pem'), { force: true })
  })

  await t('同名公钥已在更高级别 → 导入被拒并说明优先级（别让人以为是导入失败）', async () => {
    const src = path.join(SANDBOX, 'official-key.pem')
    fs.writeFileSync(src, officialKeys.publicKey.export({ type: 'spki', format: 'pem' }))
    const res = await installer.addTrustedKey(src, { level: 'community' })
    assert(!res.ok, '应被拒（同名的那把在 official 级别且优先级更高）')
    assert(/优先级/.test(res.reason || ''), `原因应说明优先级，实际：${res.reason}`)
  })

  await t('findTrustedKey 的判据：**先官方后社区再本地**，且挡住路径字符', () => {
    const official = findTrustedKey('official-key')
    const local = findTrustedKey('my-dev-key')
    assert(official, '应命中官方公钥')
    assert(local, '应命中本地公钥')
    assertEq(official.level, 'official', '同名时应命中官方')
    assertEq(local.level, 'local', '本地那把')
    assertEq(findTrustedKey('../../etc/passwd'), null, '路径字符必须拒绝')
    assertEq(findTrustedKey('never-imported'), null, '不存在返回 null')
  })

  await t('本地级公钥同样能验签（三级都要能用，不然分级只是摆设）', () => {
    const keys = crypto.generateKeyPairSync('ed25519')
    const dir = path.join(srcRoot, 'local-signed-plugin')
    fs.mkdirSync(dir, { recursive: true })
    const base = { id: 'local-signed-plugin', main: 'index.cjs' }
    const value = crypto.sign(null, canonicalBytes(base), keys.privateKey).toString('base64')
    fs.writeFileSync(path.join(dir, 'hira-plugin.json'), JSON.stringify({
      ...base, signature: { algo: 'ed25519', keyId: 'my-dev-key', value }
    }, null, 2))
    fs.writeFileSync(path.join(dir, 'index.cjs'), ENTRY_SRC)
    // 把 my-dev-key 换成这把私钥对应的公钥（覆盖 local 级那一份）
    fs.writeFileSync(path.join(trustDir, 'local', 'my-dev-key.pem'), keys.publicKey.export({ type: 'spki', format: 'pem' }))
    const info = installer.inspectDir(dir)
    assertEq(info.signature.status, 'valid', `status（理由：${info.signature.reason || '-'}）`)
    assertEq(info.signature.level, 'local', 'level')
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
  process.exit(failures.length ? 1 : 0)
}

main().catch((error) => {
  console.error('[verify:plugin-install] 运行失败：', errorMessage(error))
  try { fs.rmSync(SANDBOX, { recursive: true, force: true }) } catch (_) {}
  process.exit(2)
})
