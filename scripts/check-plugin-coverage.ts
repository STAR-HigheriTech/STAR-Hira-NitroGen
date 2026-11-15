import * as fs from 'node:fs'
import * as path from 'node:path'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { asRecord, errorMessage, isRecord, stringOf } from './lib/type-guards.ts'

type PluginModule = Record<string, unknown> & {
  registerProviders?: (context: unknown) => unknown
}

interface PluginRecord {
  id: string
  manifest: string
  entry: unknown
}

/**
 * 插件清单体检（`pnpm plugin:coverage`）。
 *
 * ── 两件事 ────────────────────────────────────────────────────────
 * ① **结构完整性**：manifest 可解析、有 id、`main`（**若有**）指向的入口存在、模块能加载、
 *    且导出 install/enable/disable 三个生命周期。
 *    「没有 main」是**合法形态**（纯数据插件，见下方 entry 处），不是缺件 ——
 *    这类 manifest 改问"你到底贡献了什么"。
 * ② **能力清单一致性**（`manifest.capabilities` vs 模块实际注册的 capability）——
 *    见下方说明。
 *
 * ── 为什么 ② 是必须的门禁，而不是"锦上添花" ──────────────────────
 * `blockedCapabilities`（§9.3）的判据完全建立在 **manifest 的 `capabilities` 字段**上：
 * 禁用一个引擎时，注册中心是照那份**静态声明**去关闭它的能力面的
 * （原因见 PluginRegistryV2#isCapabilityBlocked：启动时就被禁用的插件根本没被 enable，
 * 没有 provider 可枚举）。
 *
 * 于是产生一条硬约束：**模块实际注册的 capability 必须被 manifest 声明覆盖**。
 * 漏一个的后果是隐蔽且严重的 —— 那个能力**不会**被禁用拦下，引擎关了它却照旧可用，
 * 用户看到的是"开关又失效了"（正是 §9 那个最难查的病）。
 * 这类漂移靠人眼 review 是盯不住的（改插件时很容易只动 `.cjs` 忘了 `.json`），
 * 所以必须由门禁来盯。
 *
 * 两个方向的处理不同：
 *   · **实际注册 ⊆ manifest 声明** → 硬性要求（漏声明 = 错误，因为它破坏上面那条约束）；
 *   · manifest 声明的多余项 → 允许（多声明只会让一个没人提供的能力也被标成 blocked，
 *     无害；而且有时是刻意预留）。
 *
 * 无法用桩 ctx 调起 `registerProviders` 的插件（需要真实手柄）会记为 `skipped` 而不是
 * 错误 —— 门禁宁可少查几个，也不能因为查不动就把所有人堵在门外。
 */

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const require = createRequire(import.meta.url)
const pluginDir = path.join(root, 'build', 'plugins')
const manifestFiles = fs.readdirSync(pluginDir).filter((name) => name.endsWith('.hira-plugin.json') || name.endsWith('.plugin.json'))
const errors: string[] = []
const skipped: string[] = []
const plugins: PluginRecord[] = []

/**
 * 「什么都答应」的桩 ctx：任意服务名 → 任意方法都是 noop。
 * 目的只是让 `registerProviders(ctx)` 能跑完并把 capability 列表交出来，
 * 不是在测域服务本身（那些有各自的测试）。
 */
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
  appRoot: root
})

/** 取出模块在某次 `registerProviders` 里实际会注册的 capability 集合（拿不到就返回 null）。 */
function collectRegisteredCapabilities(plugin: PluginModule, id: string, fileName: string): string[] | null {
  if (typeof plugin.registerProviders !== 'function') return null
  try {
    const out = plugin.registerProviders(stubContext())
    if (!Array.isArray(out)) return null
    return Array.from(new Set(out.map((provider) => {
      const record = asRecord(provider)
      return record.capability || record.name
    }).filter((capability) => capability != null).map(String)))
  } catch (error) {
    skipped.push(`${id || fileName}: registerProviders 需要真实手柄，本次跳过能力比对（${errorMessage(error)}）`)
    return null
  }
}

for (const fileName of manifestFiles) {
  const manifestPath = path.join(pluginDir, fileName)
  let manifest: Record<string, unknown>
  try {
    manifest = asRecord(JSON.parse(fs.readFileSync(manifestPath, 'utf8')))
  } catch (error) {
    errors.push(`${fileName}: invalid JSON (${errorMessage(error)})`)
    continue
  }
  const id = String(manifest.id || '').trim()
  if (!id) errors.push(`${fileName}: id is required`)
  // v2 形态允许把入口分组写进 `entry: { main, render }` —— 两处都收，与加载器同一口径。
  const entrySpec = asRecord(manifest.entry)

  /**
   * 入口 `main` —— **可选**，不是人人必须有。
   *
   * 判据直接照抄加载器（`plugin-registry-v2` 的 `if (!m.main) return {}`）：
   * **没有 `main` = 纯数据插件**。`type: theme-plugin` 只贡献 `contributes.themes`，
   * 主题作者不写一行代码 —— 这是「主题即插件」的**主路径**，要求"人人都有 main"
   * 会把这条主路径整个堵死（`theme-pack-nord` 就是这么被误拦的）。
   *
   * 缺 `main` 时改问一句"你到底贡献了什么"：`contributes` 一个有效键都没有的**空壳**
   * 才算错 —— 免得一份写坏的 manifest 静默变成"装了但什么也不做"的插件，
   * 那正是本门禁最想拦的那类"半个功能"。
   */
  const mainRaw = manifest.main || entrySpec.main
  const entry = mainRaw ? path.resolve(pluginDir, String(mainRaw)) : null
  if (entry) {
    if (!fs.existsSync(entry)) errors.push(`${id || fileName}: main entry is missing (${mainRaw})`)
  } else {
    const contributes = isRecord(manifest.contributes) ? manifest.contributes : null
    const hasContribution = !!contributes && Object.keys(contributes).some((key) => {
      const value = contributes[key]
      return Array.isArray(value) ? value.length > 0 : (value != null && value !== false)
    })
    if (!hasContribution) errors.push(`${id || fileName}: 既没有 main、也没有任何 contributes —— 空壳插件`)
  }

  /**
   * 渲染侧入口（`render` / `entry.render`）：
   *   ① 路径必须真实存在；
   *   ② 必须以 `.renderer.js` 结尾。
   *
   * ② 不是洁癖 —— `scripts/build-plugins.ts` 只把 `.renderer.ts` 打成独立渲染模块；
   * 名字写错时产物不会生成，面板却仍在 rail 上，点开只会是空的。
   * 这道门禁把“半个功能”挡在发布前。
   */
  const renderRaw = manifest.render || entrySpec.render
  if (renderRaw) {
    const renderPath = String(renderRaw)
    const abs = path.resolve(pluginDir, renderPath)
    if (!fs.existsSync(abs)) errors.push(`${id || fileName}: render entry is missing (${renderPath})`)
    else if (!renderPath.endsWith('.renderer.js')) {
      errors.push(`${id || fileName}: render entry must end with .renderer.js（内置插件构建只产出该后缀）→ ${renderPath}`)
    }
  }
  if (entry && fs.existsSync(entry)) {
    let plugin: PluginModule | null = null
    let loadSkipped = false
    const source = fs.readFileSync(entry, 'utf8')
    if (id === 'ai-engine' || /\brequire\(\s*['"]electron['"]\s*\)/.test(source)) {
      loadSkipped = true
      skipped.push(`${id || fileName}: 需要 Electron 运行时，纯 Node 门禁跳过入口加载`)
    } else {
      try {
        plugin = require(entry) as PluginModule
      } catch (error) {
        const message = errorMessage(error)
        if (/Electron failed to install correctly|Electron binary|Downloading Electron/i.test(message)) {
          loadSkipped = true
          skipped.push(`${id || fileName}: 需要 Electron 运行时，纯 Node 门禁跳过入口加载`)
        } else {
          errors.push(`${id || fileName}: main entry failed to load (${message})`)
        }
      }
    }
    if (!loadSkipped && (!plugin || typeof plugin !== 'object')) errors.push(`${id || fileName}: main must export an object`)
    else if (!loadSkipped) {
      const loadedPlugin = plugin as PluginModule
      for (const lifecycle of ['install', 'enable', 'disable'] as const) {
        if (typeof loadedPlugin[lifecycle] !== 'function') errors.push(`${id || fileName}: ${lifecycle}() is required`)
      }

      // ── ② 能力清单一致性（见文件头说明）──
      const declared = Array.isArray(manifest.capabilities) ? manifest.capabilities.map(String) : []
      const registered = collectRegisteredCapabilities(loadedPlugin, id, fileName)
      if (registered) {
        const declaredSet = new Set(declared)
        const missing = registered.filter((cap) => !declaredSet.has(cap))
        if (missing.length) {
          errors.push(
            `${id || fileName}: manifest.capabilities 漏声明了模块实际注册的能力 → ${missing.join(', ')} ` +
            '（漏声明会让这些能力**不被"禁用"拦下**：引擎关了功能照旧可用，见 §9）'
          )
        }
      }
    }
  }
  plugins.push({ id, manifest: fileName, entry: manifest.main || null })
}

const result = {
  total: plugins.length,
  covered: errors.length ? 0 : plugins.length,
  percentage: errors.length ? 0 : 100,
  plugins,
  errors,
  // 无法比对能力清单的插件（不是错误，但要让维护者知道门禁没覆盖到）
  skippedCapabilityCheck: skipped
}
console.log(JSON.stringify(result, null, 2))
if (errors.length) process.exitCode = 1
