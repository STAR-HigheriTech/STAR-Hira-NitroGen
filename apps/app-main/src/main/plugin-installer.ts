// @ts-check
/**
 * 插件安装器 —— 社区市场的**落盘那一半**。
 *
 * ══════════════════════════════════════════════════════════════════════
 * 它管什么、不管什么
 * ══════════════════════════════════════════════════════════════════════
 *   管：把一个插件的资产（目录 / zip）**安全地**放进 `userData/plugins/<id>/`，
 *       以及把它完整地拿掉；安装前做体检（manifest / 入口 / 撞名 / 签名）。
 *   不管：加载、启用、停用。那些全在 `PluginRegistryV2` 手里（安装完调一次
 *       `discover()` + `enable()` 即可，见 ipc/plugins.js）。
 *
 * 这个边界不是洁癖：安装器要能被**单独测试**（纯 fs + crypto，不碰 Electron、不碰
 * 注册中心），否则"装完起不来"这类问题只能在整机跑起来之后才暴露。
 *
 * ══════════════════════════════════════════════════════════════════════
 * 四条安全边界（每一条都对应一种真实事故）
 * ══════════════════════════════════════════════════════════════════════
 * 1. **解压/复制时的目录穿越（zip-slip）**：条目名里写 `../../` 就能写到
 *    `userData` 之外（甚至覆盖应用自己的文件）。判据是 **`path.resolve` 之后比前缀**，
 *    不是"过滤掉 `..`"—— 后者在编码变体、`a/../../b`、Windows 的 `\` 与盘符下会漏。
 * 2. **符号链接**：源目录里一条指向 `C:\Windows` 的软链，会让"复制一个目录"变成
 *    "复制整台机器"（或者更糟：写穿到链接目标）。复制时**直接跳过并计入警告**。
 * 3. **与内置插件撞名**：让用户那份胜出 = 允许用一次安装替换掉 `tabs-service`，
 *    那是提权。安装前直接拒绝（注册中心的 `discover()` 也会忽略它，但那时用户
 *    已经装完了却看不出为什么没用 —— 不如在装的时候就说不）。
 * 4. **体积上限**：条目数与总字节数都设上限。一个"插件包"如果有 20 万个文件，
 *    它不是插件包。
 *
 * ══════════════════════════════════════════════════════════════════════
 * 签名：能验，但"信任谁"由用户决定（并且**分三级**）
 * ══════════════════════════════════════════════════════════════════════
 * manifest 可选 `signature: { algo, keyId, value }`：
 *   · `algo`   `ed25519` | `rsa-sha256`
 *   · `keyId`  公钥标识，按级别决定它在哪个目录
 *   · `value`  base64 签名，签的是**去掉 `signature` 字段后递归按键名排序的 JSON**
 *              （顺序必须规范化，否则"字段顺序不同"会让同一个 manifest 验不过）
 *
 * 公钥分三级（见 createPluginInstaller 里信任那一节的说明）：
 *   `official`（随应用分发，用户不可写不可移除）→ `community`（界面导入的作者公钥）
 *   → `local`（用户自己生成的）。同名时按这个顺序取先找到的那把。
 *
 * 四种结果分开呈现，**不合并成"没签名"**：
 *   `none` 没有签名 / `unknown-key` 有签名但本地没这把公钥 / `valid` / `invalid`。
 * 为什么要有 `unknown-key` 这一档：它和"签名是错的"是完全不同的两件事 ——
 * 前者是"我还没决定信不信这个人"，后者是"这个人签的东西被改过"。
 * **安装不会因为签名而失败**（社区生态不该被一把没配好的钥匙卡住），
 * 签名只影响 UI 上给用户的提示强度。
 */

import * as fs from 'node:fs'
import * as fsp from 'node:fs/promises'
import * as path from 'node:path'
import * as crypto from 'node:crypto'

import { MAX_ARCHIVE_BYTES, readZipEntries, extractEntry, type ZipEntry } from './plugin-archive'
import { isPluginId } from '@hira-ng/shared-types/src/plugin-id'
// 三级信任目录的名称与优先级只保留一份（也被 IPC 契约的 zod enum、插件面板的下拉引用）。
import { PLUGIN_TRUST_LEVELS } from '@hira-ng/shared-types/src/plugin-trust.mjs'

type UnknownRecord = Record<string, unknown>

interface PluginInstallerOptions {
  userPluginDir: string
  builtinPluginIds?: string[] | (() => string[])
  trustDir?: string
  officialTrustDir?: string
  log?: (message: string, error?: unknown) => void
}

interface TreeFile {
  rel: string
  size: number
}

interface TreeSnapshot {
  files: TreeFile[]
  warnings: string[]
}

interface SignatureResult {
  status: 'none' | 'invalid' | 'unknown-key' | 'valid'
  keyId?: string
  level?: string
  reason?: string
}

interface InspectResult {
  ok: boolean
  id: string
  name: string
  version: string
  description: string
  trustLevel: string
  runtime: boolean
  errors: string[]
  warnings: string[]
  signature: SignatureResult
  fileCount: number
  totalBytes: number
}

interface InstallResult {
  ok: boolean
  id?: string
  name?: string
  version?: string
  signature?: SignatureResult
  reason?: string
  warnings?: string[]
  errors?: string[]
  path?: string
}

interface InstallOptions {
  overwrite?: boolean
}

interface TrustedKeyResult {
  ok: boolean
  keyId?: string
  level?: string
  fingerprint?: string
  algo?: string
  reason?: string
}

interface TrustOptions {
  level?: string
  overwrite?: boolean
}

interface TrustedKeyEntry {
  keyId: string
  fileName: string
  level: string
  removable: boolean
  fingerprint: string
  algo: string
  readable: boolean
}

const MANIFEST_NAME = 'hira-plugin.json'
/** 复制时**永不**带走的东西：依赖目录、仓库元数据、以及系统自带的噪音文件。 */
const ALWAYS_IGNORE = new Set(['node_modules', '.git', '.svn', '.hg', '.DS_Store', 'Thumbs.db', '__MACOSX'])
const MAX_FILES = 2000
const MAX_TOTAL_BYTES = 64 * 1024 * 1024
const MAX_MANIFEST_BYTES = 1024 * 1024
const SUPPORTED_ALGOS = new Set(['ed25519', 'rsa-sha256'])
function isRecord (value: unknown): value is UnknownRecord {
  return value !== null && (typeof value === 'object' || typeof value === 'function')
}

function errorMessage (error: unknown): string {
  return isRecord(error) && error.message ? String(error.message) : String(error)
}

/**
 * 把一个相对路径安全地拼到根目录下。
 *
 * 判据是 resolve 之后的**前缀比较**（见文件头边界 1）。`path.sep` 结尾的那一截
 * 是必须的：不加的话 `/data/plugins-evil` 会被判成在 `/data/plugins` 之内。
 *
 * @param {string} root
 * @param {string} rel
 * @returns {string|null} 越界返回 null
 */
function resolveInside (root: string, rel: string): string | null {
  // **两侧都 resolve**：只 resolve 待检路径而拿原始 `root` 去比，在 `root` 是相对路径
  // 或带尾分隔符时会整体失配 —— 那种失配是 fail-closed（全部拒绝），不会漏放，
  // 但会让"装什么都装不进去"变成一个极难定位的现象。守卫本身应当是自洽的。
  const base = path.resolve(root)
  const abs = path.resolve(base, rel)
  if (abs === base) return abs
  return abs.startsWith(base + path.sep) ? abs : null
}

function normalizeArchiveEntryName (raw: unknown): string | null {
  const input = String(raw == null ? '' : raw).replace(/\\/g, '/')
  const directory = input.endsWith('/')
  const segments = input.replace(/^\/+/, '').split('/').filter(Boolean)
  if (!segments.length) return null
  for (const segment of segments) {
    if (segment === '.' || segment === '..') return null
    if (/[\u0000-\u001f\u007f<>:"|?*]/.test(segment)) return null
    if (/[ .]$/.test(segment)) return null
    if (/^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\..*)?$/i.test(segment)) return null
  }
  return `${segments.join('/')}${directory ? '/' : ''}`
}

/** 递归按键名排序（规范化 JSON），签名必须对"字段顺序无关"成立。 */
function sortKeysDeep (value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeysDeep)
  if (value && typeof value === 'object') {
    const record = value as UnknownRecord
    const out: UnknownRecord = Object.create(null)
    for (const key of Object.keys(record).sort()) out[key] = sortKeysDeep(record[key])
    return out
  }
  return value
}

/** 签名覆盖的字节 = 除 `signature` 外的 manifest 规范化 JSON。 */
function canonicalBytes (manifest: unknown): Buffer {
  const { signature, ...rest } = isRecord(manifest) ? manifest : {}
  void signature
  return Buffer.from(JSON.stringify(sortKeysDeep(rest)), 'utf8')
}

/**
 * 收集一个目录下要复制的文件（相对路径 + 大小），跳过忽略项与符号链接。
 * @returns {{ files: Array<{ rel: string, size: number }>, warnings: string[] }}
 */
function collectTree (root: string): TreeSnapshot {
  const files: TreeFile[] = []
  const warnings: string[] = []
  let total = 0
  const walk = (dir: string, prefix: string): void => {
    let names: string[] = []
    try {
      names = fs.readdirSync(dir)
    } catch (e) {
      warnings.push(`无法读取目录 ${prefix || '.'}：${errorMessage(e)}`)
      return
    }
    for (const name of names) {
      if (ALWAYS_IGNORE.has(name)) continue
      const abs = path.join(dir, name)
      const rel = prefix ? `${prefix}/${name}` : name
      let st
      try {
        // lstat 而不是 stat：要能看出"这是链接本身"。用 stat 会跟到目标上，
        // 于是一条软链看起来就像一个普通目录（边界 2）。
        st = fs.lstatSync(abs)
      } catch (e) {
        warnings.push(`无法读取 ${rel}：${errorMessage(e)}`)
        continue
      }
      if (st.isSymbolicLink()) {
        warnings.push(`跳过符号链接：${rel}（不跟随，避免把链接目标一起搬进来）`)
        continue
      }
      if (st.isDirectory()) {
        walk(abs, rel)
        continue
      }
      if (!st.isFile()) {
        warnings.push(`跳过非普通文件：${rel}`)
        continue
      }
      total += st.size
      if (total > MAX_TOTAL_BYTES) throw new Error(`插件体积过大（超过 ${Math.round(MAX_TOTAL_BYTES / 1024 / 1024)}MB）`)
      if (files.length >= MAX_FILES) throw new Error(`插件文件数过多（超过 ${MAX_FILES} 个）`)
      files.push({ rel, size: st.size })
    }
  }
  walk(root, '')
  return { files, warnings }
}

/**
 * 从**内置插件目录**读出全部 id。
 *
 * 为什么读磁盘而不是在安装器里维护一份"内置名单"：名单会随插件增删过期，
 * 而过期的后果正是**边界 3**（允许用一次安装替换掉内置插件 = 提权）。
 * 磁盘是唯一不会过期的事实源。
 *
 * 两种形态都收（扁平 `<id>.hira-plugin.json` 与目录 `<id>/hira-plugin.json`），
 * 因为内置插件将来可能改形态，而这个函数不该成为改形态时的绊脚石。
 *
 * @param {string} dir
 * @returns {string[]}
 */
export function readBuiltinPluginIds (dir: string): string[] {
  const ids: string[] = []
  const push = (manifestPath: string): void => {
    try {
      const raw: unknown = JSON.parse(fs.readFileSync(manifestPath, 'utf8'))
      if (isRecord(raw) && raw.id) ids.push(String(raw.id))
    } catch (_) {
      // 坏 manifest 的报错归注册中心（它有一整套降级策略），这里只负责收 id
    }
  }
  try {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.isFile() && /\.hira-plugin\.json$/i.test(entry.name)) {
        push(path.join(dir, entry.name))
      } else if (entry.isDirectory() && !entry.name.startsWith('.')) {
        for (const name of [MANIFEST_NAME, 'plugin.json']) {
          const candidate = path.join(dir, entry.name, name)
          if (fs.existsSync(candidate)) { push(candidate); break }
        }
      }
    }
  } catch (_) {}
  return ids
}

/**
 * 创建安装器。
 *
 * @param {{
 *   userPluginDir: string,
 *   builtinPluginIds?: string[] | (() => string[]),
 *   trustDir?: string,
 *   officialTrustDir?: string,
 *   log?: (msg: string, err?: unknown) => void
 * }} options
 */
function createPluginInstaller (options: PluginInstallerOptions) {
  const userPluginDir = options.userPluginDir
  const trustDir = options.trustDir || ''
  /**
   * **官方级**公钥目录（随应用分发，打包后只读）。
   * 它不存在是**正常状态**（当前还没有官方签名密钥）—— 目录为空就等于"没有官方签名"，
   * 一切照旧走 community / local。
   */
  const officialTrustDir = options.officialTrustDir || ''
  // 允许传**函数**：内置名单的最佳来源是磁盘，而"有哪些内置插件"在安装器构造之后
  // 仍可能变（用户装了新的内置插件包 / 开发期热更）。传数组就等于把它冻结在启动那一刻。
  const builtinSource = options.builtinPluginIds
  const builtin = () => new Set(
    (typeof builtinSource === 'function' ? builtinSource() : (builtinSource || [])).map(String)
  )
  const log = typeof options.log === 'function' ? options.log : () => {}

  /** 每次安装一个独立临时目录：并发安装两次不会互相踩。 */
  function makeTempDir (tag: string): string {
    const dir = path.join(userPluginDir, `.install-${tag}-${process.pid}-${Date.now().toString(36)}`)
    fs.mkdirSync(dir, { recursive: true })
    return dir
  }

  function rmQuiet (target: string): void {
    try {
      fs.rmSync(target, { recursive: true, force: true })
    } catch (e) {
      log(`[installer] 清理失败：${target}`, e)
    }
  }

  /**
   * 按 keyId **跨信任级别**找公钥。级别顺序即优先级：official → community → local。
   *
   * keyId 会变成文件名 → 必须挡住路径字符（否则一个恶意 keyId 就能读到任意 `.pem`）。
   * 这条校验放在这里而不是每个调用点：找与读是同一条路径，判据只该有一处。
   * @param {string} keyId
   * @returns {{ level: string, pemPath: string }|null}
   */
  function findTrustedKey (keyId: unknown): { level: string; pemPath: string } | null {
    if (!/^[A-Za-z0-9._-]{1,64}$/.test(String(keyId || ''))) return null
    for (const level of TRUST_LEVELS) {
      const dir = trustDirOf(level)
      if (!dir) continue
      const pemPath = path.join(dir, `${keyId}.pem`)
      if (fs.existsSync(pemPath)) return { level, pemPath }
    }
    return null
  }

  /**
   * 校验签名。返回四态之一（见文件头），成功时额外带上**信任级别**（见 trustDirOf 的说明）。
   * @param {unknown} manifest
   */
  function verifySignature (manifest: unknown): SignatureResult {
    const sig = isRecord(manifest) && isRecord(manifest.signature) ? manifest.signature : null
    if (!sig) return { status: 'none' }
    const algo = String(sig.algo || '')
    const keyId = String(sig.keyId || '')
    const value = String(sig.value || '')
    if (!algo || !keyId || !value) {
      return { status: 'invalid', keyId, reason: '签名字段不完整（需要 algo / keyId / value）' }
    }
    if (!SUPPORTED_ALGOS.has(algo)) {
      return { status: 'invalid', keyId, reason: `不支持的签名算法：${algo}` }
    }
    if (!/^[A-Za-z0-9._-]{1,64}$/.test(keyId)) {
      return { status: 'invalid', keyId, reason: '签名 keyId 含非法字符' }
    }
    const found = findTrustedKey(keyId)
    if (!found) {
      return { status: 'unknown-key', keyId, reason: `本机没有 ${keyId} 的公钥` }
    }
    try {
      const key = crypto.createPublicKey(fs.readFileSync(found.pemPath))
      const ok = algo === 'ed25519'
        ? crypto.verify(null, canonicalBytes(manifest), key, Buffer.from(value, 'base64'))
        : crypto.verify('sha256', canonicalBytes(manifest), key, Buffer.from(value, 'base64'))
      return ok
        ? { status: 'valid', keyId, level: found.level }
        : { status: 'invalid', keyId, level: found.level, reason: '签名与 manifest 内容不符' }
    } catch (e) {
      return { status: 'invalid', keyId, level: found.level, reason: `无法用该公钥校验：${errorMessage(e)}` }
    }
  }

  /**
   * 体检一个**已经落到磁盘上的插件目录**（不写任何东西）。
   *
   * 为什么体检与安装分开：安装 zip 时也要先"解到临时目录再体检"，
   * 两边共用同一份判据才不会出现"zip 装进去的东西比目录装进去的松"。
   *
   * @param {string} dir
   * @returns {{ ok: boolean, id: string, name: string, version: string, errors: string[], warnings: string[],
   *             signature: { status: string, keyId?: string, reason?: string }, fileCount: number, totalBytes: number }}
   */
  function inspectDir (dir: string): InspectResult {
    const errors: string[] = []
    const warnings: string[] = []
    const manifestPath = path.join(dir, MANIFEST_NAME)
    let manifest: UnknownRecord | null = null

    if (!fs.existsSync(manifestPath)) {
      errors.push(`缺少清单文件 ${MANIFEST_NAME}`)
    } else {
      try {
        if (fs.statSync(manifestPath).size > MAX_MANIFEST_BYTES) throw new Error('清单文件超过 1MB')
        const parsed: unknown = JSON.parse(fs.readFileSync(manifestPath, 'utf8'))
        manifest = isRecord(parsed) ? parsed : null
        if (!manifest) errors.push(`${MANIFEST_NAME} 顶层必须是对象`)
      } catch (e) {
        errors.push(`${MANIFEST_NAME} 不是合法 JSON：${errorMessage(e)}`)
      }
    }

    const id = manifest && manifest.id ? String(manifest.id) : ''
    if (!id) {
      errors.push('清单里缺少 id')
    } else if (!isPluginId(id)) {
      // 这一条同时是"目录名合法性"检查 —— id 就是最终目录名（见边界 1/3）。
      errors.push(`id「${id}」不合法（只能用字母数字与 . _ -，且不能以符号开头）`)
    } else if (builtin().has(id)) {
      errors.push(`id「${id}」与内置插件重名，不能安装（重名的插件即使装进去也不会被加载）`)
    }

    let fileCount = 0
    let totalBytes = 0
    try {
      const tree = collectTree(dir)
      fileCount = tree.files.length
      totalBytes = tree.files.reduce((n, f) => n + f.size, 0)
      warnings.push(...tree.warnings)
      if (!fileCount) errors.push('目录里没有任何文件')
      // 入口文件必须存在，否则"装成功"之后才发现加载不了（那时错误信息完全指不到这一步）。
      for (const key of ['main', 'render']) {
        const rel = manifest && manifest[key] ? String(manifest[key]) : ''
        if (!rel) continue
        if (!tree.files.some((f) => f.rel === rel.replace(/^\.?\//, ''))) {
          errors.push(`清单声明的 ${key} 入口不存在：${rel}`)
        }
      }
      /**
       * 用户脚本（`contributes.userscripts[].file`）同样是**入口**：它是这个插件的
       * 全部内容。缺了它的表现是"插件装好了、开关也开着，但脚本永远不执行"——
       * 而根因在安装那一刻就已确定。这里一次把每一条都验掉。
       *
       * `userscripts` 允许写单条或数组（与其它 contributes 一致）。
       */
      const contributes = manifest && isRecord(manifest.contributes) ? manifest.contributes : null
      const userscriptsRaw = contributes ? contributes.userscripts : null
      const userscripts = Array.isArray(userscriptsRaw)
        ? userscriptsRaw
        : (userscriptsRaw && typeof userscriptsRaw === 'object' ? [userscriptsRaw] : [])
      for (const item of userscripts) {
        const rel = isRecord(item) && item.file ? String(item.file) : ''
        if (!rel) {
          errors.push('contributes.userscripts 有一条缺少 file')
          continue
        }
        const normalized = rel.replace(/^\.?\//, '')
        if (!tree.files.some((f) => f.rel === normalized)) {
          errors.push(`清单声明的用户脚本不存在：${rel}`)
        }
      }
    } catch (e) {
      errors.push(errorMessage(e))
    }

    const signature: SignatureResult = manifest ? verifySignature(manifest) : { status: 'none' }

    return {
      ok: errors.length === 0,
      id,
      name: String((manifest && (manifest.name || manifest.id)) || id),
      version: String((manifest && manifest.version) || ''),
      description: String((manifest && manifest.description) || ''),
      trustLevel: String((manifest && manifest.trustLevel) || ''),
      runtime: true,
      errors,
      warnings,
      signature,
      fileCount,
      totalBytes
    }
  }

  /** 把一个**已体检通过**的目录搬到最终位置（同盘 rename，先备再换）。 */
  function commit (fromDir: string, id: string, overwrite: boolean): string {
    const target = resolveInside(userPluginDir, id)
    if (!target) throw new Error(`目标路径非法：${id}`)
    const exists = fs.existsSync(target)
    if (exists && !overwrite) {
      throw new Error(`插件「${id}」已安装。如需替换，请先卸载或选择覆盖安装`)
    }
    const backup = path.join(userPluginDir, `.old-${id}-${Date.now().toString(36)}`)
    if (exists) fs.renameSync(target, backup)
    try {
      fs.renameSync(fromDir, target)
    } catch (e) {
      // 换名失败 → 把备份放回去，绝不留下"两个都没有"的状态
      if (exists && fs.existsSync(backup) && !fs.existsSync(target)) {
        try { fs.renameSync(backup, target) } catch (_) {}
      }
      throw e
    }
    rmQuiet(backup)
    return target
  }

  /**
   * 从**目录**安装。
   * @param {string} srcDir
   * @param {{ overwrite?: boolean }} [opts]
   * @returns {Promise<InstallResult>}
   */
  async function installDirectory (srcDir: string, opts: InstallOptions = {}): Promise<InstallResult> {
    const overwrite = !!opts.overwrite
    /**
     * 源目录**在插件目录内部**时必须拒绝：安装器自己就在这里创建 `.install-*` 暂存目录，
     * 从用户插件目录"安装到用户插件目录"会把正在写入的暂存目录当内容一起复制
     * （边写边读 → 体积无限膨胀）。这个用法没有任何正当场景，直接挡掉。
     *
     * ⚠ 例外：**我们自己刚解出来的那个暂存目录**（`installArchive` 的入口）。
     * 判据要写死成"父目录就是 userPluginDir 且名字以 `.install-` 开头" ——
     * 放宽成"名字以 .install- 开头"的话，用户只要把自己那个文件夹改名成
     * `.install-x` 就能绕过这条守卫。
     */
    const srcAbs = path.resolve(srcDir)
    const isOwnStaging = path.dirname(srcAbs) === path.resolve(userPluginDir)
      && path.basename(srcAbs).startsWith('.install-')
    if (!isOwnStaging && (resolveInside(userPluginDir, srcAbs) || srcAbs === path.resolve(userPluginDir))) {
      return { ok: false, reason: '不能从插件目录内部安装（请选择插件自己的那个文件夹或压缩包）' }
    }
    const info = inspectDir(srcDir)
    if (!info.ok) return { ok: false, reason: info.errors.join('；'), errors: info.errors, id: info.id, warnings: info.warnings }

    // 先整棵复制到临时目录再 rename：中途失败（磁盘满、某个文件被占用）不会在
    // `plugins/<id>/` 留下一个"半份"的插件 —— 那种状态最糟，它**看起来是装好的**。
    const staging = makeTempDir(info.id)
    try {
      const copied = await copyTree(srcDir, staging)
      if (!copied.ok) return { ok: false, id: info.id, reason: copied.reason }
      const target = commit(staging, info.id, overwrite)
      log(`[installer] 已安装 ${info.id} → ${target}`)
      return {
        ok: true,
        id: info.id,
        name: info.name,
        version: info.version,
        signature: info.signature,
        warnings: info.warnings,
        path: target
      }
    } catch (e) {
      rmQuiet(staging)
      return { ok: false, id: info.id, reason: errorMessage(e) }
    }
  }

  /** 逐文件复制（带边界 1/2 的守卫）。 */
  async function copyTree (srcDir: string, destDir: string): Promise<InstallResult> {
    const { files, warnings } = collectTree(srcDir)
    for (const f of files) {
      const from = resolveInside(srcDir, f.rel)
      const to = resolveInside(destDir, f.rel)
      if (!from || !to) return { ok: false, reason: `条目路径非法，已中止：${f.rel}` }
      await fsp.mkdir(path.dirname(to), { recursive: true })
      await fsp.copyFile(from, to)
    }
    if (warnings.length) log(`[installer] 复制时跳过 ${warnings.length} 项：${warnings.join('；')}`)
    return { ok: true }
  }

  /**
   * 从 **zip** 安装：解到临时目录 → 走与目录安装**完全相同**的体检与提交。
   * 共用那一步是关键 —— 否则两条路的校验强度会不知不觉分叉。
   * @param {string} archivePath
   * @param {{ overwrite?: boolean }} [opts]
   */
  async function installArchive (archivePath: string, opts: InstallOptions = {}): Promise<InstallResult> {
    let buf: Buffer
    try {
      const stat = await fsp.stat(archivePath)
      if (!stat.isFile()) return { ok: false, reason: '安装包路径不是文件' }
      if (stat.size > MAX_ARCHIVE_BYTES) {
        return { ok: false, reason: `安装包过大（${Math.ceil(stat.size / 1024 / 1024)}MB > ${MAX_ARCHIVE_BYTES / 1024 / 1024}MB）` }
      }
      buf = await fsp.readFile(archivePath)
    } catch (e) {
      return { ok: false, reason: `无法读取压缩包：${errorMessage(e)}` }
    }
    let entries: ZipEntry[]
    try {
      entries = readZipEntries(buf)
    } catch (e) {
      return { ok: false, reason: errorMessage(e) }
    }

    const staging = makeTempDir('zip')
    try {
      const seen = new Set<string>()
      let totalBytes = 0
      for (const entry of entries) {
        const rel = normalizeArchiveEntryName(entry.name)
        if (!rel) return { ok: false, reason: `压缩包内含非法路径，已中止：${entry.name}` }
        const key = process.platform === 'win32' ? rel.toLowerCase() : rel
        if (seen.has(key)) return { ok: false, reason: `压缩包内含重复路径，已中止：${entry.name}` }
        seen.add(key)
        // 目录条目跳过（落文件时按需 mkdir，不必依赖包里有目录项）
        if (entry.isDir || rel.endsWith('/')) continue
        totalBytes += entry.rawSize
        if (totalBytes > MAX_TOTAL_BYTES) {
          return { ok: false, reason: `插件解压后体积过大（超过 ${MAX_TOTAL_BYTES / 1024 / 1024}MB）` }
        }
        const to = resolveInside(staging, rel)
        if (!to) return { ok: false, reason: `压缩包内含越界路径，已中止：${entry.name}` }
        const data = extractEntry(entry)
        totalBytes += Math.max(0, data.length - entry.rawSize)
        if (totalBytes > MAX_TOTAL_BYTES) {
          return { ok: false, reason: `插件解压后体积过大（超过 ${MAX_TOTAL_BYTES / 1024 / 1024}MB）` }
        }
        await fsp.mkdir(path.dirname(to), { recursive: true })
        await fsp.writeFile(to, data)
      }
      const res = await installDirectory(staging, opts)
      // installDirectory 成功时已经把 staging **rename** 走了，这里只清失败的那份
      return res
    } catch (e) {
      return { ok: false, reason: errorMessage(e) }
    } finally {
      rmQuiet(staging)
    }
  }

  /**
   * 卸载（只删文件，**不动**注册中心状态）。
   *
   * 顺序由调用方决定，且必须是"先停用再删文件"（`ipc/plugins.js` 负责）：
   * 反过来会出现一段"代码没了但插件还启用着"的窗口，那时它的定时器 / 事件回调
   * 还在跑，任何 `require` 相对路径都会炸。
   *
   * 拒绝内置插件：它们的目录在应用安装目录里（打包后只读，开发态是我们的源码），
   * 删掉等于自毁。判据用"路径必须在 userPluginDir 内"，而不是"id 在不在内置名单里"——
   * 后者在插件被重命名/新增时会漏。
   *
   * @param {string} pluginId
   */
  async function uninstall (pluginId: unknown): Promise<InstallResult> {
    const id = String(pluginId || '')
    if (!isPluginId(id)) return { ok: false, reason: `插件 id 不合法：${id}` }
    const target = resolveInside(userPluginDir, id)
    if (!target || target === userPluginDir) return { ok: false, reason: '目标路径非法' }
    if (!fs.existsSync(target)) return { ok: false, reason: `未找到已安装的插件目录：${id}` }
    try {
      await fsp.rm(target, { recursive: true, force: true })
      log(`[installer] 已卸载 ${id}`)
      return { ok: true, id }
    } catch (e) {
      return { ok: false, id, reason: `删除失败（可能有文件被占用）：${errorMessage(e)}` }
    }
  }

  /** 列出用户目录里**当前装着什么**（不含逐个体检，只报 id）。 */
  function listInstalled (): string[] {
    try {
      if (!fs.existsSync(userPluginDir)) return []
      return fs.readdirSync(userPluginDir, { withFileTypes: true })
        .filter((d) => d.isDirectory() && !d.name.startsWith('.'))
        .map((d) => d.name)
    } catch (_) {
      return []
    }
  }

  // ─────────────────────────────────────────────────────────────
  // 受信任公钥（签名验签的另一半）+ **信任分级**
  // ─────────────────────────────────────────────────────────────
  //
  // 为什么必须有这几个方法：验签能力本身已经就位（见 verifySignature），但"受信任公钥"
  // 只能由用户手工把 `.pem` 丢进 trust 目录 —— 那等于这个功能对普通用户不存在。
  // 有了"导入 / 列出 / 移除"，§15.6 的签名才是**可用**的而不是摆设。
  //
  // **三级不是装饰，各有各的实际后果**：
  //   · `official`  随应用分发（`resources/plugin-trust/`），用户**既不能写也不能移除** ——
  //                 这正是"官方签名"的含义：它不该被一次误操作搞没；
  //   · `community` 用户在界面导入的（作者公布的公钥），可移除；
  //   · `local`     用户自己生成 / 开发用的，可移除，且单独一个子目录便于整体清掉。
  //
  // 为什么用**目录**分级而不是一份清单文件（`trust.json`）：目录即事实，
  // 不会出现"清单说它是 official、文件却在 community 目录里"这种不同步。
  // 一个 keyId 只能落在一个级别（正好是"分级"的语义）；同名时按上面的顺序取先找到的那把。

  /** 级别顺序 = 查找优先级（名称与语义见 shared-types#plugin-trust.mjs）。 */
  const TRUST_LEVELS = PLUGIN_TRUST_LEVELS

  /** 级别 → 磁盘目录。空串表示"该级别在本机没有配置"。 */
  function trustDirOf (level: string): string {
    if (level === 'official') return officialTrustDir
    if (level === 'local') return trustDir ? path.join(trustDir, 'local') : ''
    return trustDir
  }

  /** 公钥指纹（SPKI DER 的 sha256 前 16 位十六进制）—— 人用来核对的那串东西。 */
  function fingerprintOf (keyObject: crypto.KeyObject): string {
    try {
      const der = keyObject.export({ type: 'spki', format: 'der' })
      return crypto.createHash('sha256').update(der).digest('hex').slice(0, 16)
    } catch (_) {
      return ''
    }
  }

  /** keyId 的文件名安全化（它同时是文件名的一部分）。 */
  function normalizeKeyId (raw: unknown): string {
    const id = String(raw || '').replace(/\.pem$/i, '').replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 64)
    return id && id !== '.' && id !== '..' ? id : ''
  }

  /**
   * 列出三级目录里的全部公钥。解析失败的也会列出来并标 `readable: false`
   * —— 用户需要看到"这个文件坏了"，否则他会一直奇怪签名为什么不生效。
   */
  function listTrustedKeys (): TrustedKeyEntry[] {
    const out: TrustedKeyEntry[] = []
    for (const level of TRUST_LEVELS) {
      const dir = trustDirOf(level)
      if (!dir) continue
      let names: string[] = []
      try {
        names = fs.readdirSync(dir)
      } catch (_) {
        continue // 目录不存在 = 该级别为空，不是错误
      }
      for (const name of names) {
        if (!/\.pem$/i.test(name)) continue // `trust/local/` 这种子目录会被这一行过滤掉
        const full = path.join(dir, name)
        const entry = {
          keyId: name.replace(/\.pem$/i, ''),
          fileName: name,
          level,
          // 官方级不可移除：它在应用资源目录里（打包后只读），而且"官方签名"不该被误删
          removable: level !== 'official',
          fingerprint: '',
          algo: '',
          readable: true
        }
        try {
          const key = crypto.createPublicKey(fs.readFileSync(full))
          entry.fingerprint = fingerprintOf(key)
          entry.algo = key.asymmetricKeyType || ''
        } catch (_) {
          entry.readable = false
        }
        out.push(entry)
      }
    }
    // 先按级别（official 在前），再按 keyId —— 界面上同级的钥匙聚在一起
    return out.sort((a, b) => TRUST_LEVELS.indexOf(a.level) - TRUST_LEVELS.indexOf(b.level)
      || a.keyId.localeCompare(b.keyId))
  }

  /**
   * 导入一把公钥。
   *
   * **先解析再落盘**：`crypto.createPublicKey` 认不出来的文件直接拒掉 ——
   * 否则用户会把一个"看起来是 pem 的随便什么东西"放进来，然后对着一个永远
   * `unknown-key` / `invalid` 的插件百思不得其解。
   *
   * keyId 取**文件名**（去掉 `.pem`），因为 manifest 里的 `signature.keyId` 就是按它找文件的。
   * 不取内容哈希：那样用户改不了名，而"作者告诉你用哪个 keyId"是这套约定的一半。
   *
   * @param {string} sourcePath 用户选中的 .pem 文件
   * @param {{ level?: string, overwrite?: boolean }} [opts]
   */
  async function addTrustedKey (sourcePath: string, opts: TrustOptions = {}): Promise<TrustedKeyResult> {
    const requestedLevel = String(opts.level || 'community')
    const level = TRUST_LEVELS.includes(requestedLevel) ? requestedLevel : 'community'
    if (level === 'official') {
      // 官方级是"随应用分发"的同义词。允许界面往里写就等于允许用户把任意公钥
      // 提升成官方签名 —— 那是这套分级里唯一不能松的一口气。
      return { ok: false, level, reason: '官方级公钥随应用分发，不能在这里导入' }
    }
    const dir = trustDirOf(level)
    if (!dir) return { ok: false, level, reason: '本机没有配置信任目录' }
    const keyId = normalizeKeyId(path.basename(String(sourcePath || '')))
    if (!keyId) return { ok: false, level, reason: '无法从文件名推导出合法的 keyId（只能用字母数字与 . _ -）' }
    let pem
    try {
      pem = await fsp.readFile(sourcePath, 'utf8')
    } catch (e) {
      return { ok: false, level, reason: `无法读取文件：${errorMessage(e)}` }
    }
    let key
    try {
      key = crypto.createPublicKey(pem)
    } catch (e) {
      return { ok: false, level, reason: `不是有效的公钥：${errorMessage(e)}` }
    }
    const target = path.join(dir, `${keyId}.pem`)
    if (fs.existsSync(target) && !opts.overwrite) {
      return { ok: false, keyId, level, reason: `该级别下已存在同名的公钥（${keyId}）。如需替换，请先移除它` }
    }
    // 同名公钥已在**别的级别**里 → 说清楚，否则用户会以为导入失败了（其实是同名的旧那把在生效）
    const existing = findTrustedKey(keyId)
    if (existing && existing.level !== level && !opts.overwrite) {
      return {
        ok: false, keyId, level,
        reason: `已存在同名公钥，级别为「${existing.level}」且优先级更高（${TRUST_LEVELS.join(' → ')}）。请先移除它，或改用同一个级别导入`
      }
    }
    try {
      await fsp.mkdir(dir, { recursive: true })
      await fsp.writeFile(target, pem, 'utf8')
    } catch (e) {
      return { ok: false, keyId, level, reason: `写入失败：${errorMessage(e)}` }
    }
    log(`[installer] 已导入受信任公钥 ${keyId}（${level}，指纹 ${fingerprintOf(key)}）`)
    return { ok: true, keyId, level, fingerprint: fingerprintOf(key), algo: key.asymmetricKeyType || '' }
  }

  /**
   * 移除一把受信任公钥（此后用它签的插件回落到 `unknown-key`）。
   * 必须点名**级别**：不同级别可以有同名公钥，只给 keyId 无法确定删哪一个。
   * @param {string} keyId
   * @param {string} [level]
   */
  async function removeTrustedKey (keyId: unknown, level: string = 'community'): Promise<TrustedKeyResult> {
    const lv = TRUST_LEVELS.includes(level) ? level : 'community'
    if (lv === 'official') {
      return { ok: false, keyId: String(keyId || ''), level: lv, reason: '官方级公钥随应用分发，不能移除' }
    }
    const id = normalizeKeyId(keyId)
    if (!id) return { ok: false, level: lv, reason: 'keyId 不合法' }
    const dir = trustDirOf(lv)
    if (!dir) return { ok: false, keyId: id, level: lv, reason: '本机没有配置信任目录' }
    const target = path.join(dir, `${id}.pem`)
    if (!fs.existsSync(target)) return { ok: false, keyId: id, level: lv, reason: `该级别下未找到公钥：${id}` }
    try {
      await fsp.rm(target, { force: true })
      return { ok: true, keyId: id, level: lv }
    } catch (e) {
      return { ok: false, keyId: id, level: lv, reason: `删除失败：${errorMessage(e)}` }
    }
  }

  return {
    inspectDir,
    installDirectory,
    installArchive,
    uninstall,
    listInstalled,
    listTrustedKeys,
    addTrustedKey,
    removeTrustedKey,
    verifySignature,
    // 供单测 / 验证脚本直接检查内部判据（越界守卫、签名规范化、信任分级是最容易写错的三处）
    _internals: { resolveInside, sortKeysDeep, canonicalBytes, collectTree, TRUST_LEVELS, trustDirOf, findTrustedKey }
  }
}

export { createPluginInstaller, MANIFEST_NAME }
