/**
 * 用户脚本安装器 —— 把一份 `.user.js` 变成**一个插件**。
 *
 * ══════════════════════════════════════════════════════════════════════
 * 为什么"安装用户脚本"要落到插件目录
 * ══════════════════════════════════════════════════════════════════════
 * 用户脚本在别处是一等公民（Tampermonkey 有自己的存储与开关），在本项目里它
 * **就是一种插件**：`type: "userscript-plugin"`、住在 `userData/plugins/<id>/`、
 * 启停 / 卸载 / 广播全部复用插件中心那条链路。
 *
 * 这样做的三个直接好处：
 *   1. 禁用插件 → `contributes.userscripts` 被 `clearPlugin` 摘掉 → 脚本不再执行，
 *      不需要在注入点再写一套"这个脚本开没开"的判断；
 *   2. 卸载 → 与普通插件同一个 `uninstall`（先停再删），不会留下孤儿文件；
 *   3. 安装 → 与普通插件同一个 `installDirectory`（体检 / 撞名 / zip-slip / 签名
 *      三级全都在），用户脚本不会成为一条"绕过安全边界"的旁路。
 *
 * ══════════════════════════════════════════════════════════════════════
 * 它只做三件事
 * ══════════════════════════════════════════════════════════════════════
 *   1. **认**：`.user.js` 文本 → `parseUserScriptMeta`（语义在纯层，只定义一次）
 *   2. **造**：拼一份最小 manifest + 落一个**暂存目录**（`.install-userscript-*`，
 *      与 `installArchive` 解压出来的暂存同一个命名口径 —— 安装器认它是"自己的"）
 *   3. **交**：`installDirectory()` 装进去。之后的启用 / 广播 / 面板对账由
 *      `ipc/plugins.js#afterInstallHook` 统一收尾。
 *
 * 它**不**碰注册中心、不碰 Electron、不判断"装完开不开"——那些都有唯一入口。
 *
 * ── 为什么 id 是 `userscript-<slug>` ────────────────────────────────
 * id 同时是目录名（`ID_PATTERN` 只允许字母数字与 `. _ -`），而脚本的
 * `@name` 可能是中文 / 带空格。统一前缀有两个作用：一眼看出它是什么，
 * 以及保证首字符是字母（`@name` 以数字开头时直接当 id 会被安装器拒掉）。
 * 同名不同内容的两个脚本会因此撞 id —— 那正是"覆盖安装"要用户明确点一下的场景。
 */

const fs = require('fs')
const fsp = require('fs/promises')
const path = require('path')

const { MANIFEST_NAME } = require('./plugin-installer')
const {
  parseUserScriptMeta,
  buildUserScriptPluginManifest,
  slugifyUserScriptName
} = require('@hira-ng/shared-types/src/userscript.mjs')
import type { UserScriptMeta } from '@hira-ng/shared-types/src/userscript'

/** 脚本文件的固定名字（manifest 的 `contributes.userscripts[].file` 指它）。 */
const SCRIPT_FILE_NAME = 'script.user.js'
/** 单个脚本的体积上限 —— 正常的用户脚本是几十 KB，1MB 已经很宽松。 */
const MAX_SCRIPT_BYTES = 1024 * 1024

interface PluginInstallResult {
  ok: boolean
  id?: string
  name?: string
  version?: string
  warnings?: string[]
  reason?: string
}

interface UserScriptInstallResult extends PluginInstallResult {
  canceled?: boolean
}

/** @param {string} text */
function stripBom(text: unknown): string {
  return String(text || '').replace(/^\uFEFF/, '')
}

/**
 * 体检一份用户脚本文本（不落盘、不安装）。
 * 安装前的所有"这不是用户脚本"的判断都在这里，错误文案直接给用户看。
 *
 * @param {string} source
 * @returns {{ ok: true, meta: UserScriptMeta, id: string } | { ok: false, reason: string }}
 */
function inspectUserScript(source: string): { ok: true; meta: UserScriptMeta; id: string } | { ok: false; reason: string } {
  const text = stripBom(source)
  if (!text.trim()) return { ok: false, reason: '脚本内容为空' }
  if (Buffer.byteLength(text, 'utf8') > MAX_SCRIPT_BYTES) {
    return { ok: false, reason: `脚本超过 ${Math.round(MAX_SCRIPT_BYTES / 1024)} KB，拒绝安装` }
  }

  const meta: UserScriptMeta & { error?: string } = parseUserScriptMeta(text)
  if (meta.error) return { ok: false, reason: meta.error }
  if (!meta.name) return { ok: false, reason: '脚本缺少 @name（无法在插件中心里显示）' }
  /**
   * 没有作用域就拒绝，与 Tampermonkey 一致：一个"到处都跑"的脚本既没用又危险，
   * 而作者大概率是忘了写 `@match` —— 这种时候报错比静默生效有用得多。
   */
  if (!meta.match.length && !meta.include.length) {
    return { ok: false, reason: '脚本没有声明 @match 或 @include，无法确定在哪些页面运行' }
  }
  const privilegedMatch = meta.match.find((pattern) => /^(?:file|hira|hira-plugin|hira-game|chrome-extension|about|data|blob|javascript):/i.test(String(pattern)))
  if (privilegedMatch) {
    return { ok: false, reason: `用户脚本只能运行在 http(s) 页面，不能匹配：${privilegedMatch}` }
  }

  const manifest = buildUserScriptPluginManifest(meta, { file: SCRIPT_FILE_NAME })
  return { ok: true, meta, id: manifest.id }
}

/**
 * @param {{
 *   getUserPluginDir: () => string,
 *   pluginInstaller: { installDirectory: (dir: string, opts?: { overwrite?: boolean }) => Promise<PluginInstallResult> },
 *   log?: (...args: unknown[]) => void
 * }} deps
 */
function createUserScriptInstaller(deps: { getUserPluginDir: () => string; pluginInstaller: { installDirectory: (dir: string, opts?: { overwrite?: boolean }) => Promise<PluginInstallResult> }; log?: (...args: unknown[]) => void }): { install: (input?: { text?: string; path?: string; overwrite?: boolean }) => Promise<UserScriptInstallResult>; inspectUserScript: typeof inspectUserScript } {
  const { getUserPluginDir, pluginInstaller, log } = deps || {}
  const logger = typeof log === 'function' ? log : () => {}

  /** 暂存目录必须落在用户插件目录里，且名字以 `.install-` 开头（见 installDirectory 的守卫）。 */
  function makeStaging(tag: string): string {
    const root = String((typeof getUserPluginDir === 'function' && getUserPluginDir()) || '')
    if (!root) throw new Error('用户插件目录不可用')
    fs.mkdirSync(root, { recursive: true })
    const dir = path.join(root, `.install-userscript-${tag}-${process.pid}-${Date.now().toString(36)}`)
    fs.mkdirSync(dir, { recursive: true })
    return dir
  }

  function rmQuiet(dir: string): void {
    try {
      fs.rmSync(dir, { recursive: true, force: true })
    } catch (_) {}
  }

  /**
   * 安装一份用户脚本。
   *
   * @param {{ text?: string, path?: string, overwrite?: boolean }} input
   *   `text` 优先；否则读 `path`。显示名一律取脚本的 `@name`（那才是用户认得的名字）。
   * @returns {Promise<{ ok: boolean, canceled?: boolean, id?: string, name?: string, version?: string, warnings?: string[], reason?: string }>}
   */
  async function install(input: { text?: string; path?: string; overwrite?: boolean } = {}): Promise<UserScriptInstallResult> {
    if (!pluginInstaller || typeof pluginInstaller.installDirectory !== 'function') {
      return { ok: false, reason: '插件安装器不可用' }
    }

    let source = typeof input.text === 'string' ? input.text : ''
    if (!source && input.path) {
      const file = String(input.path)
      try {
        const stat = await fsp.stat(file)
        if (!stat.isFile()) return { ok: false, reason: '选择的不是文件' }
        if (stat.size > MAX_SCRIPT_BYTES) {
          return { ok: false, reason: `脚本超过 ${Math.round(MAX_SCRIPT_BYTES / 1024)} KB，拒绝安装` }
        }
        source = await fsp.readFile(file, 'utf8')
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        return { ok: false, reason: `无法读取脚本：${message}` }
      }
    }
    if (!source) return { ok: false, reason: '没有拿到脚本内容' }

    const checked = inspectUserScript(source)
    if (!checked.ok) return { ok: false, reason: checked.reason }

    const manifest = buildUserScriptPluginManifest(checked.meta as unknown as Record<string, unknown>, { file: SCRIPT_FILE_NAME })

    const staging = makeStaging(slugifyUserScriptName(checked.meta.name) || 'script')
    try {
      fs.writeFileSync(path.join(staging, MANIFEST_NAME), `${JSON.stringify(manifest, null, 2)}\n`, 'utf8')
      fs.writeFileSync(path.join(staging, SCRIPT_FILE_NAME), `${stripBom(source).trimEnd()}\n`, 'utf8')

      const result = await pluginInstaller.installDirectory(staging, { overwrite: !!input.overwrite })
      if (!result || !result.ok) {
        return {
          ok: false,
          id: (result && result.id) || manifest.id,
          reason: (result && result.reason) || '安装失败'
        }
      }
      logger(`[userscript] 已安装 ${manifest.id}（${manifest.name}）`)
      return {
        ok: true,
        id: result.id,
        name: result.name || manifest.name,
        version: result.version || manifest.version,
        warnings: result.warnings
      }
    } catch (error) {
      return { ok: false, id: manifest.id, reason: error instanceof Error ? error.message : String(error) }
    } finally {
      // 装成功时 `installDirectory` 已经把**复制品** rename 走了；暂存目录本身始终要清。
      rmQuiet(staging)
    }
  }

  return { install, inspectUserScript }
}

module.exports = { createUserScriptInstaller, inspectUserScript, SCRIPT_FILE_NAME }
