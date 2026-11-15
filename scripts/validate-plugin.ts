#!/usr/bin/env node
/**
 * 单插件校验器（PART7 §7.8 的「SDK」那一半：开发期即时反馈）。
 *
 *   pnpm plugin:validate my-plugin                 按 id 在 apps/app-main/plugins/ 里找
 *   pnpm plugin:validate apps/app-main/plugins     扫一整个目录
 *   pnpm plugin:validate path/to/x.hira-plugin.json
 *
 * 与 `pnpm plugin:coverage` 的关系：那个是**仓库级门禁**（跑在 CI / 提交前，只看
 * 能力清单一致性与入口存在性）；这个是**作者手上的一遍**，检查面更宽、会给出
 * 具体到"怎么改"的提示，并且对"能跑但可疑"的东西只警告不报错。
 *
 * 错误 vs 警告的分界（刻意如此）：
 *   · **错误** = 一定会出问题：manifest 解析不了、入口不存在、未知权限 scope、
 *     硬依赖缺失、模块加载失败、能力声明漂移（会让禁用开关失效 —— 最隐蔽的一类）。
 *   · **警告** = 现在能跑，但下一步多半会踩：声明了面板却既没 `render` 也没 `ui`、
 *     配了 `healthCheck` 却没实现 hook、文件名与 id 不一致、软依赖缺失。
 * 只有错误影响退出码 —— 警告不该把作者堵在门外。
 */

import * as fs from 'node:fs'
import * as path from 'node:path'
import { asRecord, errorMessage, isRecord, stringOf } from './lib/type-guards.ts'
import type { LooseRecord } from './lib/type-guards.ts'

interface PanelUi { entry: string; kind: 'html' | 'xaml' }
interface PanelContribution extends LooseRecord { id?: unknown; ui?: unknown; uiEntry?: unknown }
interface UserScriptContribution extends LooseRecord { id?: unknown; file?: unknown }
interface PluginManifestView {
  id: string
  main?: string | null
  render?: string | null
  capabilities?: string[]
  dependsOn?: string[]
  optionalDependsOn?: string[]
  contributes?: LooseRecord
  healthCheck?: LooseRecord | null
  isFirstParty?: boolean
  trustLevel?: string
  [key: string]: unknown
}
type PluginModule = Record<string, unknown> & {
  registerProviders?: (context: unknown) => unknown
}

interface RawManifest { raw: LooseRecord; file: string }

const ROOT = path.resolve(__dirname, '..')
const DEFAULT_DIR = path.join(ROOT, 'build/plugins')

const errors: string[] = []
const warnings: string[] = []
const notes: string[] = []

/**
 * 面板 UI 入口的归一化（`contributes.panels[].ui`）。
 *
 * 由 `main()` 从 `packages/shared-types/src/plugin-ui.ts` 构建产物动态载入 —— **不在这里
 * 重抄一份扩展名白名单 / 穿越判定**：校验器若自带第二份规则，它就会与运行时漂移，
 * 而漂移的表现是"校验通过但面板白屏"或反之。
 * @type {((panel: PanelContribution) => PanelUi | null) | null}
 */
let panelUiFromContribution: ((panel: PanelContribution) => PanelUi | null) | null = null

/** 与 check-plugin-coverage.cjs 同一套桩（目的只是让 registerProviders 能跑完）。 */
const noop = () => undefined
const stubService = new Proxy({}, { get: (_t, prop) => (prop === 'then' ? undefined : noop) })
const stubContext = () => ({
  getDomainServices: () => new Proxy({}, { get: () => stubService }),
  domainServices: new Proxy({}, { get: () => stubService }),
  panelCatalog: { list: () => [], markReady: () => {}, isReady: () => true, has: () => false },
  contributions: { list: () => [], contribute: () => {}, define: () => {} },
  extensionPoints: { callSync: () => undefined, call: async () => undefined },
  tabManager: new Proxy({}, { get: () => noop }),
  webContentsManager: new Proxy({}, { get: () => noop }),
  layoutCoordinator: new Proxy({}, { get: () => noop }),
  themeManager: new Proxy({}, { get: () => noop }),
  providerRegistry: new Proxy({}, { get: () => noop }),
  appRoot: ROOT
})

/** 收集目标目录下所有插件 id（依赖引用校验要用）。 */
function listPluginIds(dir: string): Set<string> {
  const ids = new Set<string>()
  for (const m of readRawManifests(dir)) if (m.raw && m.raw.id) ids.add(String(m.raw.id))
  return ids
}

/** 读取目录下全部 manifest（原始 JSON + 文件路径）。 */
function readRawManifests(dir: string): RawManifest[] {
  const out: RawManifest[] = []
  if (!fs.existsSync(dir)) return out
  for (const name of fs.readdirSync(dir)) {
    if (!/\.(hira-)?plugin\.json$/.test(name)) continue
    const file = path.join(dir, name)
    try {
      out.push({ raw: asRecord(JSON.parse(fs.readFileSync(file, 'utf8'))), file })
    } catch { /* 解析失败的那个文件在逐插件校验里会自己报错 */ }
  }
  return out
}

/** 归一化失败时的降级视图：够跑余下的结构检查，且**不**重复报已经报过的错。 */
function looseFromRaw(raw: unknown): PluginManifestView {
  const source = asRecord(raw)
  const entrySpec = asRecord(source.entry)
  const trustLevel = stringOf(source.trustLevel, 'internal')
  const asArray = (value: unknown): string[] => Array.isArray(value) ? value.map(String) : []
  return {
    id: stringOf(source.id),
    main: source.main || entrySpec.main ? stringOf(source.main || entrySpec.main) : null,
    render: source.render || entrySpec.render ? stringOf(source.render || entrySpec.render) : null,
    capabilities: asArray(source.capabilities),
    dependsOn: asArray(source.dependsOn),
    optionalDependsOn: asArray(source.optionalDependsOn),
    contributes: asRecord(source.contributes),
    healthCheck: null,
    isFirstParty: trustLevel === 'internal' || trustLevel === 'core'
  }
}

function validateOne(manifestPath: string, knownIds: ReadonlySet<string>): void {
  const label = path.relative(ROOT, manifestPath)
  let raw: LooseRecord
  try {
    raw = asRecord(JSON.parse(fs.readFileSync(manifestPath, 'utf8')))
  } catch (error) {
    errors.push(`${label}: manifest 不是合法 JSON —— ${errorMessage(error)}`)
    return
  }
  const dir = path.dirname(manifestPath)
  const id = stringOf(raw.id).trim()
  if (!id) { errors.push(`${label}: 缺少 id`); return }

  const stem = path.basename(manifestPath).replace(/\.(hira-)?plugin\.json$/, '')
  if (stem !== id) {
    warnings.push(`${id}: 文件名（${stem}.hira-plugin.json）与 manifest.id 不一致 —— 排查时最容易多绕一圈的坑，建议统一`)
  }

  // ── 归一化（会在这里炸出未知权限 scope 等 manifest 形状问题）──
  let manifest: PluginManifestView
  try {
    const { PluginRegistryV2 } = require('@hira-ng/infra-plugin')
    const reg = new PluginRegistryV2({ pluginDir: dir })
    // ⚠ 只用它做**单条**归一化。**不要**在这里调 reg.validateDeps() ——
    // 注册中心此刻只装了这一个 manifest，所有依赖都会"看起来缺失"（假阳性）。
    // 依赖与环检测由 main() 里的**全量**校验统一负责。
    manifest = reg.setManifests([{ ...raw, originPath: manifestPath }])[0] as PluginManifestView
  } catch (error) {
    errors.push(`${id}: manifest 归一化失败 —— ${errorMessage(error)}`)
    // **不 return**：一条字段写错就只报它、藏起后面九个问题，作者要来回改十遍。
    // 降级成"宽松版 manifest"把余下的结构检查一次报全（宽松版不做 scope 校验，
    // 所以不会重复报上面那条）。
    manifest = looseFromRaw(raw)
  }

  // ── 声明式 UI 面（contributes.panels[].ui → .html / .xaml）──
  //
  // 这一段必须在"入口"之前算：**只有 ui 的插件不需要 main**（它一行业务代码都没有，
  // 行为全在标记语言文档里）。判定逻辑（相对路径 / 穿越 / 扩展名 / kind 一致性）
  // 一律来自运行时那份 `panelUiFromContribution`，这里只负责报错。
  const contributes = asRecord(manifest.contributes)
  const panels: PanelContribution[] = Array.isArray(contributes.panels) ? contributes.panels.filter(isRecord) : []
  /** @type {Array<{ panelId: string, entry: string, kind: 'html'|'xaml' }>} */
  const uiFaces: Array<{ panelId: string, entry: string, kind: 'html'|'xaml' }> = []
  for (const panel of panels) {
    if (!panel || typeof panel !== 'object') continue
    const declaredUi = panel.ui != null ? panel.ui : panel.uiEntry
    if (declaredUi == null) continue
    const where = `${id} / ${panel.id || '(面板缺少 id)'}`
    const parsed = panelUiFromContribution ? panelUiFromContribution(panel) : null
    if (!parsed) {
      errors.push(
        `${where}: ui 入口不合法 —— 只接受插件目录内的相对路径，扩展名必须是 .html / .htm / .xaml；` +
        '写对象时 kind 必须与扩展名一致（形如 "ui": { "entry": "./panel.html", "kind": "html" }）'
      )
      continue
    }
    if (!fs.existsSync(path.resolve(dir, parsed.entry))) {
      errors.push(`${where}: ui 指向的文件不存在 —— ${parsed.entry}`)
    }
    uiFaces.push({ panelId: String(panel.id || ''), entry: parsed.entry, kind: parsed.kind })
  }

  // ── 入口 ──
  /**
   * **纯数据插件**：整套行为都由 manifest 的 `contributes` 声明，没有也不需要主进程入口。
   *
   * 主路径有两种：主题包（`contributes.themes` 里写几套配色）、数据贡献
   * （如 `contributes.skills` 交一份技能清单）。硬要求它们交一个 main，等于把
   * "声明即可用"这条主路径堵死（或者逼作者塞一个空入口文件充数）。
   *
   * **纯 UI 插件**同理：`contributes.panels[].ui` 交一份 HTML/XAML 就够了。
   *
   * 判定不看 `type` 白名单（type 是自由字符串，白名单会让新品类每次都要改校验器）：
   * 只有「声明了能力」或「完全没有贡献」的插件才必须有 main —— 前者要写代码注册能力，
   * 后者不写代码就什么也不做，两者都说明它还缺一份入口。
   */
  const main = manifest.main
  const declaresData = !(manifest.capabilities || []).length
    && Object.keys(manifest.contributes || {}).length > 0
  if (!main) {
    if (!declaresData && !uiFaces.length) errors.push(`${id}: 缺少 main（主进程入口）`)
  } else if (!fs.existsSync(path.resolve(dir, main))) {
    errors.push(`${id}: main 指向的文件不存在 —— ${main}`)
  }

  if (manifest.render) {
    const abs = path.resolve(dir, manifest.render)
    if (!fs.existsSync(abs)) errors.push(`${id}: render 指向的文件不存在 —— ${manifest.render}`)
    else if (!/\.(?:js|mjs|cjs)$/i.test(manifest.render)) {
      errors.push(`${id}: render 必须是可执行模块（.js / .mjs / .cjs）—— ${manifest.render}`)
    }
  }

  // ── 模块加载 + 能力清单一致性（最隐蔽的一类错误）──
  let mod: PluginModule | null = null
  if (main && fs.existsSync(path.resolve(dir, main))) {
    const entry = path.resolve(dir, main)
    const source = fs.readFileSync(entry, 'utf8')
    if (id === 'ai-engine' || /\brequire\(\s*['"]electron['"]\s*\)/.test(source)) {
      notes.push(`${id}: 需要 Electron 运行时，纯 Node 校验跳过入口加载`)
    } else {
      try {
        mod = require(entry)
      } catch (error) {
        errors.push(`${id}: 主进程模块加载失败 —— ${errorMessage(error)}`)
      }
    }
    if (mod && typeof mod === 'object') {
      for (const life of ['install', 'enable', 'disable']) {
        if (typeof mod[life] !== 'function') {
          errors.push(`${id}: 缺少生命周期 ${life}()（install / enable / disable 是必须的）`)
        }
      }
      const declared = new Set(manifest.capabilities || [])
      if (typeof mod.registerProviders === 'function') {
        try {
          const out = mod.registerProviders(stubContext())
          if (Array.isArray(out)) {
            const registered = Array.from(new Set(out.map((p) => (p && (p.capability || p.name))).filter(Boolean).map(String)))
            const missing = registered.filter((c) => !declared.has(c))
            if (missing.length) {
              errors.push(
                `${id}: manifest.capabilities 漏声明了模块实际注册的能力 → ${missing.join(', ')}\n` +
                '      （漏声明会让这些能力**不被"禁用"拦下**：引擎关了功能照旧可用，见 §9）'
              )
            }
            const unused = (manifest.capabilities || []).filter((c) => !registered.includes(c))
            if (unused.length) notes.push(`${id}: 声明了但本模块没注册的能力（允许，多是预留或由别处提供）→ ${unused.join(', ')}`)
          }
        } catch (error) {
          notes.push(`${id}: registerProviders 需要真实手柄，本次跳过能力比对（${errorMessage(error)}）`)
        }
      } else if (declared.size) {
        warnings.push(`${id}: 声明了 ${declared.size} 个能力，但模块没有 registerProviders() —— 这些能力永远不会被注册`)
      }
    }
  }

  // ── 依赖引用存在性（同目录内）──
  for (const dep of manifest.dependsOn || []) {
    if (!knownIds.has(dep)) errors.push(`${id}: 硬依赖的插件不存在 —— ${dep}（硬依赖缺失会让启动期校验直接抛错）`)
  }
  for (const dep of manifest.optionalDependsOn || []) {
    if (!knownIds.has(dep)) warnings.push(`${id}: 软依赖的插件不存在 —— ${dep}（软依赖缺失是合法的，只是拿不到那个增强）`)
  }

  // ── 可疑但不阻塞 ──
  const caps = manifest.capabilities || []
  if (new Set(caps).size !== caps.length) warnings.push(`${id}: capabilities 里有重复项`)
  if (manifest.healthCheck && (!mod || typeof mod.healthCheck !== 'function')) {
    warnings.push(`${id}: manifest 声明了 healthCheck，但模块没有导出 healthCheck() —— 该检查会被静默跳过（合法降级，但你多半是忘了写）`)
  }
  if (manifest.healthCheck && manifest.healthCheck.enabled && !manifest.trustLevel) {
    notes.push(`${id}: 建议显式写 trustLevel`)
  }
  if (panels.length && !manifest.render && !uiFaces.length) {
    if (manifest.isFirstParty) {
      // 第一方面板的实现**本来就在** ui/ui-panel-* 包里（历史形态），没有 render 是正常的。
      notes.push(`${id}: 面板实现由仓库内 ui/ui-panel-* 包提供（第一方形态）；第三方插件要自带面板必须写 ui（.html/.xaml）或 render 入口，见 §3.8`)
    } else {
      warnings.push(`${id}: 声明了 contributes.panels 但既没有 ui 也没有 render 入口 —— 这个面板永远不会被画出来（第三方插件插不进仓库里的 ui 包；请给面板写 ui: "./panel.html" 或带 render 入口）`)
    }
  }
  if (uiFaces.length) {
    notes.push(`${id}: ${uiFaces.length} 个声明式 UI 面板（${Array.from(new Set(uiFaces.map((f) => f.kind))).join(' / ')}）—— 以无同源沙箱 iframe 渲染，不能导航、不能读宿主对象`)
    if (manifest.render) {
      // 混合形态是合法的：render 先认领它定义过的 panelId，剩下的才回落到 ui。
      notes.push(`${id}: 同时有 render 与 ui —— 解析顺序是 render 优先，render 未定义的 panelId 才回落到 ui`)
    }
  }
  if (manifest.render && !manifest.render.startsWith('./')) {
    warnings.push(`${id}: render 建议写成相对路径（形如 "./${stem}.renderer.js"）`)
  }
  /**
   * 用户脚本：`type: "userscript-plugin"` 是**纯数据插件**，行为全在 `contributes.userscripts`。
   * `file` 必须真实存在 —— 这条与安装器的 `inspectDir` 同一个判据，
   * 让作者在 `pnpm plugin:validate` 就撞到，而不是装到用户机器上才静默不执行。
   */
  const userscriptsRaw = contributes.userscripts
  const userscripts: UserScriptContribution[] = Array.isArray(userscriptsRaw)
    ? userscriptsRaw.filter(isRecord)
    : (isRecord(userscriptsRaw) ? [userscriptsRaw] : [])
  for (const item of userscripts) {
    const rel = item && item.file ? String(item.file) : ''
    if (!rel) {
      errors.push(`${id}: contributes.userscripts 有一条缺少 file`)
      continue
    }
    // 贡献注册表按 id 建桶（缺 id 会在**启用时**抛错），所以这里是硬错误不是警告。
    if (!item.id) errors.push(`${id}: contributes.userscripts 的 ${rel} 缺少 id（多脚本时用来区分彼此）`)
    if (!fs.existsSync(path.resolve(dir, rel))) {
      errors.push(`${id}: 用户脚本文件不存在 —— ${rel}`)
    }
  }

  notes.push(`${id}: ${caps.length} 个能力 / ${(manifest.dependsOn || []).length} 个硬依赖 / ${manifest.render ? '有' : '无'}渲染入口 / ${uiFaces.length} 个 UI 面`)
}

async function main(): Promise<void> {
  /**
   * 载入面板 UI 契约（ESM）。用动态 `import()` 而不是 `require`：
   * 那份模块是 `.mjs`，且校验器是 CJS —— 与 `check-ipc-chain.cjs` 同一套路。
   * 载不到就直接退出：此时"ui 入口"一类检查全部失效，继续跑只会给出**假通过**。
   */
  try {
    const mod = await import('@hira-ng/shared-types/src/plugin-ui.mjs')
    panelUiFromContribution = (mod.panelUiFromContribution as typeof panelUiFromContribution) || null
  } catch (error) {
    console.error('无法载入面板 UI 契约（@hira-ng/shared-types/src/plugin-ui.mjs）：', errorMessage(error))
    process.exit(2)
  }
  if (typeof panelUiFromContribution !== 'function') {
    console.error('面板 UI 契约缺少 panelUiFromContribution()，校验器无法判定 ui 入口')
    process.exit(2)
  }

  const arg = process.argv.slice(2).find((a) => !a.startsWith('--'))
  let targets: string[] = []
  const dir = DEFAULT_DIR

  if (!arg) {
    targets = fs.existsSync(dir)
      ? fs.readdirSync(dir).filter((n) => /\.(hira-)?plugin\.json$/.test(n)).map((n) => path.join(dir, n))
      : []
  } else {
    const asPath = path.resolve(ROOT, arg)
    if (fs.existsSync(asPath) && fs.statSync(asPath).isDirectory()) {
      targets = fs.readdirSync(asPath).filter((n) => /\.(hira-)?plugin\.json$/.test(n)).map((n) => path.join(asPath, n))
    } else if (fs.existsSync(asPath)) {
      targets = [asPath]
    } else {
      const byId = path.join(dir, `${arg}.hira-plugin.json`)
      if (fs.existsSync(byId)) targets = [byId]
      else {
        console.error(`找不到插件：${arg}（既不是路径，也不是 ${path.relative(ROOT, dir)} 下的 id）`)
        process.exit(2)
      }
    }
  }

  if (!targets.length) {
    console.error(`没有找到任何 *.hira-plugin.json（目录：${path.relative(ROOT, dir)}）`)
    process.exit(2)
  }

  const knownIds = listPluginIds(path.dirname(targets[0]))
  for (const t of targets) validateOne(t, knownIds)

  /**
   * 全量依赖图校验（**补逐条检查覆盖不到的部分：环**）。
   *
   * 为什么逐条检查不够：环是"若干条边一起"才成立的错误，任何一个单条 manifest 看都正常。
   * 注册中心的 `validateDeps` 会连硬依赖缺失与环一起判，但它**一次只报一个问题** ——
   * 所以只作为补充，逐条的"缺哪个硬依赖 / 缺哪个软依赖"已由上面报过。
   */
  try {
    const { PluginRegistryV2 } = require('@hira-ng/infra-plugin')
    const reg = new PluginRegistryV2({ pluginDir: path.dirname(targets[0]) })
    reg.setManifests(readRawManifests(path.dirname(targets[0])).map((m) => ({ ...m.raw, originPath: m.file })))
    // 环检测（只看硬依赖）。依赖缺失在这里也会抛 —— 那种情况上面已经报过，
    // 为避免同一件事报两遍，只把"环"这一类摘出来。
    try { reg.validateDeps() } catch (error) {
      const msg = errorMessage(error)
      if (/cycle/i.test(msg)) errors.push(`依赖图存在环 —— ${msg}`)
    }
  } catch (_) { /* 归一化问题已在逐插件里报过 */ }

  console.log(`校验 ${targets.length} 个插件：`)
  for (const n of notes) console.log(`  · ${n}`)
  if (warnings.length) {
    console.log('')
    for (const w of warnings) console.log(`  ! ${w}`)
  }
  if (errors.length) {
    console.log('')
    for (const e of errors) console.log(`  ✗ ${e}`)
  }
  console.log('')
  console.log(`结果：${errors.length} 个错误 / ${warnings.length} 个警告 / ${targets.length} 个插件`)
  if (errors.length) process.exitCode = 1
}

try {
  main().catch((error) => {
    console.error('校验器自身出错：', errorMessage(error))
    process.exit(1)
  })
} catch (error) {
  console.error('校验器自身出错：', errorMessage(error))
  process.exit(1)
}
