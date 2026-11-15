#!/usr/bin/env node
/**
 * 插件打包与发布 —— `pnpm plugin:publish <插件目录> [options]`
 *
 * ══════════════════════════════════════════════════════════════════════
 * 它补的是作者工具链的最后一段
 * ══════════════════════════════════════════════════════════════════════
 *   ① `pnpm plugin:new`      → 生成一个能跑的插件骨架
 *   ② `pnpm plugin:validate` → 提交前体检（单插件、错误/警告分级）
 *   ③ **本脚本**             → 打包 zip + 算 sha256 + （可选）签名 + 生成索引条目
 *   ④ 把 dist/ 上传到任意静态托管 → 用户在插件中心填索引地址即可安装
 *
 * 没有第 ③ 步的话，作者要手工压缩、手工算 sha256、手工拼索引条目 ——
 * 三件事里任何一件写错，症状都是"用户那边装不上/装上了但校验失败"，
 * 而作者在自己机器上完全复现不出来。
 *
 * ══════════════════════════════════════════════════════════════════════
 * 两个"必须复用"的真源（这是本脚本最重要的设计约束）
 * ══════════════════════════════════════════════════════════════════════
 * 1. **忽略表与遍历**直接复用安装器的 `_internals.collectTree`，不另写一套。
 *    自己写一套的后果是：打包进去了 `node_modules`，而安装器解包时又跳过它 ——
 *    包白白变大，作者还搞不清为什么"本地能跑、装上去少文件"。
 * 2. **体检**直接复用安装器的 `inspectDir`，与"用户安装时"完全同一套判据。
 *    否则会出现"发布时通过、安装时被拒"（或更糟：反过来）。
 *
 * ══════════════════════════════════════════════════════════════════════
 * 签名为什么改**源文件**
 * ══════════════════════════════════════════════════════════════════════
 * `signature` 是 manifest 的一部分，作者通常希望它进版本控制（下次发布不必重签、
 * 别人能核对）。所以默认把签名**写回** `hira-plugin.json` 并明确打印这一行；
 * 不想让脚本改自己文件的人用 `--no-write-manifest`（那样签名只进 zip）。
 *
 * 用法：
 *   node scripts/plugin-publish.cjs ./my-plugin
 *   node scripts/plugin-publish.cjs ./my-plugin --out ./dist --index ./dist/index.json
 *   node scripts/plugin-publish.cjs ./my-plugin --base-url https://cdn.example.com/pkgs
 *   node scripts/plugin-publish.cjs ./my-plugin --key ~/keys/acme.pem --key-id acme
 *   node scripts/plugin-publish.cjs ./my-plugin --dry-run
 */

import * as fs from 'node:fs'
import * as path from 'node:path'
import * as os from 'node:os'
import * as crypto from 'node:crypto'
import { asRecord, errorMessage, isRecord, stringOf } from './lib/type-guards'
interface ZipEntry {
  name: string
  data?: Buffer | string
  dir?: boolean
  deflate?: boolean
}

interface PublishOptions {
  dir: string
  out: string
  baseUrl: string
  index: string
  key: string
  keyId: string
  writeManifest: boolean
  dryRun: boolean
  help: boolean
}

interface PluginFile { rel: string }
interface PluginInspector {
  _internals: {
    canonicalBytes: (manifest: unknown) => Buffer
    collectTree: (pluginDir: string) => { files: PluginFile[] }
  }
  inspectDir: (pluginDir: string) => {
    ok: boolean
    name: string
    description?: string
    errors: string[]
    warnings: string[]
  }
}

interface Signature { algo: string; keyId: string; value: string }
interface MarketplaceIndex { schema: number; name: string; plugins: Record<string, unknown>[] }

const ROOT = path.resolve(__dirname, '..')
const { createPluginInstaller } = require(path.join(ROOT, 'apps', 'app-main', 'src', 'main', 'plugin-installer.js')) as {
  createPluginInstaller: (options: { userPluginDir: string }) => PluginInspector
}
const { makeZip } = require('./lib/mini-zip.ts')

/**
 * 已经是压缩格式的扩展名：再 deflate 一次基本不缩小、还可能变大，直接原样存。
 * （这是所有正经打包工具都会做的判断；不做的话一个含图标的包会白胖一圈。）
 */
const STORE_EXTS = new Set([
  '.png', '.jpg', '.jpeg', '.gif', '.webp', '.avif', '.ico',
  '.woff', '.woff2', '.zip', '.gz', '.br', '.mp3', '.mp4', '.webm'
])

function parseArgs(argv: readonly string[]): PublishOptions {
  const opts: PublishOptions = {
    dir: '',
    out: '',
    baseUrl: '',
    index: '',
    key: '',
    keyId: '',
    writeManifest: true,
    dryRun: false,
    help: false
  }
  const rest: string[] = []
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i]
    const next = (): string => {
      const v = argv[i + 1]
      i += 1
      return v == null ? '' : v
    }
    if (a === '--out') opts.out = next()
    else if (a === '--base-url') opts.baseUrl = next()
    else if (a === '--index') opts.index = next()
    else if (a === '--key') opts.key = next()
    else if (a === '--key-id') opts.keyId = next()
    else if (a === '--no-write-manifest') opts.writeManifest = false
    else if (a === '--dry-run') opts.dryRun = true
    else if (a === '-h' || a === '--help') opts.help = true
    else rest.push(a)
  }
  opts.dir = rest[0] || ''
  return opts
}

function usage(): void {
  console.log(`用法：pnpm plugin:publish <插件目录> [选项]

选项：
  --out <目录>          产物目录（默认 <插件目录>/../dist）
  --base-url <地址>     产物对外基址；索引里的 url 会写成绝对地址（默认写相对路径 ./xxx.zip）
  --index <文件>        已有的索引 JSON 路径：就地合并更新该插件那一条
  --key <私钥文件>      ed25519 / rsa-sha256 私钥（PEM）；给了就签名
  --key-id <标识>       签名 keyId（默认取私钥文件名）；用户需把对应公钥放进 plugin-trust
  --no-write-manifest   不把签名写回 hira-plugin.json（签名只进 zip）
  --dry-run             只打印计划，不写任何文件

产物：
  <out>/<id>-<version>.zip   插件包（sha256 与索引里的对应）
  <out>/index.json           索引（仅在给了 --index 时写出）
`)
}

/**
 * 与安装器同一套遍历（忽略表 / 符号链接 / 体积上限），只是把结果打包成 zip。
 *
 * `overrides` 是 `rel → Buffer` 的内存覆盖表，用来把**最终的 manifest 对象**
 * 写进包里，而不是回读磁盘上那一份。这条不是优化，是正确性：
 *   · `--no-write-manifest` 下磁盘上的 manifest **没有**签名，回读磁盘就会
 *     把刚算好的签名丢掉（打成"不带签名"的包，而用户以为它签过了）；
 *   · 即使写回磁盘，回读也依赖"磁盘格式化 == 签名时序列化的那张对象" ——
 *     多一个空行、少一个字段，包里的 manifest 就和签名覆盖的字节不一致了。
 * 直接从**同一个对象**渲染，上面两种不一致都不可能出现。
 */
function buildZip(pluginDir: string, files: readonly PluginFile[], overrides: ReadonlyMap<string, Buffer>): Buffer {
  const entries: ZipEntry[] = []
  for (const f of files) {
    const data = overrides && overrides.has(f.rel)
      ? overrides.get(f.rel)
      : fs.readFileSync(path.join(pluginDir, f.rel))
    const ext = path.extname(f.rel).toLowerCase()
    entries.push({ name: f.rel, data, deflate: !STORE_EXTS.has(ext) })
  }
  return makeZip(entries)
}

/**
 * 给 manifest 签名。
 *
 * ⚠ **规范化口径必须与安装器逐字一致**（`canonicalBytes` 就是直接借用安装器的
 * `_internals`）。签名在这里算、在那边验 —— 两处各写一份的必要结果就是
 * "所有签名都验不过"，而且这种错在发布时完全看不出来。
 */
function signManifest(canonicalBytes: (manifest: unknown) => Buffer, manifest: unknown, keyPem: string, keyIdHint: string): Signature {
  const key = crypto.createPrivateKey(keyPem)
  const type = key.asymmetricKeyType || ''
  const algo = type === 'ed25519' ? 'ed25519' : (type === 'rsa' ? 'rsa-sha256' : '')
  if (!algo) throw new Error(`不支持的私钥类型：${type || '未知'}（只支持 ed25519 / rsa）`)
  const keyId = keyIdHint || ''
  if (!/^[A-Za-z0-9._-]{1,64}$/.test(keyId)) {
    throw new Error(`--key-id 不合法（只能用字母数字与 . _ -）：${keyId}`)
  }
  const value = algo === 'ed25519'
    ? crypto.sign(null, canonicalBytes(manifest), key).toString('base64')
    : crypto.sign('sha256', canonicalBytes(manifest), key).toString('base64')
  return { algo, keyId, value }
}

function main(): void {
  const opts = parseArgs(process.argv.slice(2))
  if (opts.help || !opts.dir) { usage(); process.exit(opts.help ? 0 : 1) }

  const pluginDir = path.resolve(opts.dir)
  if (!fs.existsSync(pluginDir)) {
    console.error(`目录不存在：${pluginDir}`)
    process.exit(1)
  }
  const manifestPath = path.join(pluginDir, 'hira-plugin.json')
  if (!fs.existsSync(manifestPath)) {
    console.error(`不是插件目录（缺少 hira-plugin.json）：${pluginDir}`)
    process.exit(1)
  }

  // 安装器只用来做体检（它的安装能力这里用不到）—— 判据与用户安装时**完全同一套**。
  // scratch 目录放在 os.tmpdir() 而不是插件目录里：后者会在打包前多出一个空目录，
  // 而且一旦将来有人误调到安装路径，产物里就会混进一个没意义的空文件夹。
  const inspector = createPluginInstaller({ userPluginDir: path.join(os.tmpdir(), 'hira-publish-scratch') })
  const { canonicalBytes } = inspector._internals

  let manifest = asRecord(JSON.parse(fs.readFileSync(manifestPath, 'utf8')))
  const id = String(manifest.id || '')
  const version = String(manifest.version || '')

  // ── 1. 签名（先签再体检：签完的 manifest 才是要发布的那一份）──
  let signedManifest = manifest
  if (opts.key) {
    let keyPem
    try {
      keyPem = fs.readFileSync(opts.key, 'utf8')
    } catch (error) {
      console.error(`无法读取私钥：${errorMessage(error)}`)
      process.exit(1)
    }
    const keyId = opts.keyId || path.basename(opts.key).replace(/\.pem$/i, '')
    try {
      const signature = signManifest(canonicalBytes, manifest, keyPem, keyId)
      signedManifest = { ...manifest, signature }
      console.log(`已签名：algo=${signature.algo} keyId=${signature.keyId}`)
      console.log(`  ⚠ 用户需要把对应的**公钥**放到 userData/plugin-trust/${signature.keyId}.pem，否则只会显示"本机没有对应公钥"`)
    } catch (error) {
      console.error(`签名失败：${errorMessage(error)}`)
      process.exit(1)
    }
    if (!opts.dryRun) {
      if (opts.writeManifest) {
        // 缩进 2 空格 + 末尾换行：manifest 是要进版本控制的，保持人类可读的 diff
        fs.writeFileSync(manifestPath, `${JSON.stringify(signedManifest, null, 2)}\n`, 'utf8')
        console.log(`签名已写回 ${path.relative(process.cwd(), manifestPath)}`)
      } else {
        console.log('（--no-write-manifest：签名只进 zip，不写回源文件）')
      }
    }
    manifest = signedManifest
  }

  // ── 2. 体检（用安装器的同一套判据，它在磁盘上读，所以签名必须先落盘）──
  const info = inspector.inspectDir(pluginDir)
  if (!info.ok) {
    console.error('\n体检未通过，已中止：')
    for (const e of info.errors) console.error(`  ✗ ${e}`)
    process.exit(1)
  }
  for (const w of info.warnings) console.warn(`  ! ${w}`)

  // ── 3. 打包 ──
  const tree = inspector._internals.collectTree(pluginDir)
  if (!tree.files.length) {
    console.error('目录里没有可打包的文件')
    process.exit(1)
  }
  const zip = buildZip(pluginDir, tree.files, new Map([
    // 包里那份 manifest **永远**由最终对象渲染（见 buildZip 的说明）
    ['hira-plugin.json', Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`, 'utf8')]
  ]))
  const sha256 = crypto.createHash('sha256').update(zip).digest('hex')

  const outDir = path.resolve(opts.out || path.join(pluginDir, '..', 'dist'))
  const fileName = `${id}-${version || '0.0.0'}.zip`
  const zipPath = path.join(outDir, fileName)
  const relUrl = opts.baseUrl
    ? `${String(opts.baseUrl).replace(/\/+$/, '')}/${fileName}`
    : `./${fileName}`

  const entry: Record<string, string> = {
    id,
    name: info.name,
    version,
    description: info.description || '',
    author: stringOf(isRecord(manifest.author) ? manifest.author.name : manifest.author),
    homepage: stringOf(manifest.homepage),
    url: relUrl,
    sha256
  }
  // 去掉空字段：索引是给别人读的，满屏 `"": ""` 只会让人以为哪里坏了
  for (const k of Object.keys(entry)) if (entry[k] === undefined || entry[k] === '') delete entry[k]

  console.log(`\n打包完成：${id}${version ? ' ' + version : ''}`)
  console.log(`  文件      ${tree.files.length} 个，${(zip.length / 1024).toFixed(1)} KB`)
  console.log(`  产物      ${path.relative(process.cwd(), zipPath)}`)
  console.log(`  sha256    ${sha256}`)
  console.log(`  索引 url  ${relUrl}`)

  if (opts.dryRun) {
    console.log('\n（--dry-run：没有写任何文件）')
    console.log('\n索引条目：')
    console.log(JSON.stringify(entry, null, 2))
    return
  }

  fs.mkdirSync(outDir, { recursive: true })
  fs.writeFileSync(zipPath, zip)

  // ── 4. 索引（给了 --index 才写；否则只打印条目，作者自己贴）──
  if (opts.index) {
    const indexPath = path.resolve(opts.index)
    let index: MarketplaceIndex = { schema: 1, name: '', plugins: [] }
    if (fs.existsSync(indexPath)) {
      try {
        const prev = asRecord(JSON.parse(fs.readFileSync(indexPath, 'utf8')))
        index = {
          schema: Number(prev.schema) || 1,
          name: stringOf(prev.name),
          plugins: Array.isArray(prev.plugins) ? prev.plugins.filter(isRecord) : []
        }
      } catch (error) {
        // 已有索引坏掉时**不静默重建**：那会丢掉其它插件的条目
        console.error(`已有索引无法解析（未改动）：${errorMessage(error)}`)
        process.exit(1)
      }
    }
    const at = index.plugins.findIndex((plugin) => stringOf(plugin.id) === id)
    if (at >= 0) index.plugins[at] = entry
    else index.plugins.push(entry)
    fs.mkdirSync(path.dirname(indexPath), { recursive: true })
    fs.writeFileSync(indexPath, `${JSON.stringify(index, null, 2)}\n`, 'utf8')
    console.log(`  索引      ${path.relative(process.cwd(), indexPath)}（已更新 ${id}）`)
    console.log('\n把整个产物目录上传到任意静态托管，然后在插件中心填入索引地址即可。')
  } else {
    console.log('\n索引条目（把它加进你的 index.json 的 plugins 数组）：')
    console.log(JSON.stringify(entry, null, 2))
  }
}

main()
