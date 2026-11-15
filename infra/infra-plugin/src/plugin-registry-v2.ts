import fs from 'node:fs'
import path from 'node:path'
import { createRequire } from 'node:module'
import { SCOPE_PERMISSIONS, SCOPE_LABELS } from './plugin-sandbox'
import type { ContributionRegistry, ContributionItem, UnknownRecord } from './types'
import {
  ProviderRegistry,
  type ProviderInput,
  type ProviderRegistryOptions,
  type ServiceRegistrationOptions
} from './provider-registry'
import {
  createExtensionPointRegistry,
  type ExtensionImplementation,
  type ExtensionPointInput,
  type ExtensionPointRegistry,
  type ExtensionPointRegistryOptions
} from './extension-points'
import { createContributionRegistry } from './contributions'
import {
  defaultManifestFileFilter,
  normalizeManifest,
  readJsonFile,
  scanPluginDir,
  topoSort,
  validateDeps,
  type PluginHealthCheck,
  type PluginManifest
} from './plugin-manifest'
import type {
  PluginCleanup,
  PluginCleanupHandle,
  PluginExecutionContext,
  PluginHealthResult,
  PluginLoader,
  PluginLoaderPort,
  PluginModule,
  PluginRuntimeContext,
  PluginRuntimeState
} from '@hira-ng/shared-types/src/plugin-core'

export type { PluginManifest, PluginHealthCheck } from './plugin-manifest'
export type {
  PluginCleanup,
  PluginCleanupHandle,
  PluginExecutionContext,
  PluginHealthResult,
  PluginLoader,
  PluginLoaderPort,
  PluginModule,
  PluginRuntimeContext,
  PluginRuntimeState
} from '@hira-ng/shared-types/src/plugin-core'

const nodeRequire = createRequire(__filename)

function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message
  if (error && typeof error === 'object' && 'message' in error) return String(error.message)
  return String(error || '未知错误')
}

function isWithinDirectory(root: string, candidate: string): boolean {
  const rel = path.relative(path.resolve(root), path.resolve(candidate))
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel))
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    let settled = false
    const timer = setTimeout(() => {
      if (settled) return
      settled = true
      reject(new Error(`健康检查超时（${timeoutMs}ms）`))
    }, timeoutMs)
    timer.unref?.()
    promise.then(
      (value) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        resolve(value)
      },
      (error: unknown) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        reject(error)
      }
    )
  })
}

export interface PluginServiceExport extends UnknownRecord {
  name?: string
  service?: unknown
}
export interface PluginServiceExportDefinition extends UnknownRecord {
  name?: string
  service?: unknown
}

export interface PluginExtensionPointPlan extends UnknownRecord {
  provides?: ExtensionPointInput[]
  extends?: Array<{ to: string; impl: ExtensionImplementation; key?: string; order?: number }>
}

export interface PluginHealthRuntime {
  failures: number
  timer: ReturnType<typeof setInterval> | null
  running: boolean
}

export interface PluginDescriptor extends UnknownRecord {
  id: string
  version: string
  name: string
  description: string
  type: string
  trustLevel: string
  main: string | null
  render: string | null
  renderVersion: number | null
  uiEntry: unknown
  runtime: boolean
  capabilities: string[]
  dependsOn: string[]
  optionalDependsOn: string[]
  requiredBy: string[]
  optionalRequiredBy: string[]
  conflictsWith: string[]
  requestedPermissions: string[]
  grantedPermissions: string[]
  requestedPermissionLabels: Record<string, string>
  permissionLevel: string
  isFirstParty: boolean
  healthCheck: PluginHealthCheck | null
  healthCheckFailures: number
  nonDisableable: boolean
  userDisabled: boolean
  autoDisabled: boolean
  failed: boolean
  error: string | null
}

export interface PluginToggleResult {
  enabled: boolean
  blocked: boolean
  blockedBy: string[]
  restored: string[]
  awaitingConsent?: boolean
}

export interface PluginLoadResult {
  ok: boolean
  id: string
  enabled: boolean
}
export type PluginDependencyCheck = true

export interface PluginRegistryOptions {
  pluginDir?: string
  pluginUserDir?: string
  manifestFileFilter?: (name: string) => boolean
  loader?: PluginLoader
  providerRegistry?: ProviderRegistry
  providerOptions?: ProviderRegistryOptions
  contributions?: ContributionRegistry
  extensionPoints?: ExtensionPointRegistry
  extensionPointOptions?: ExtensionPointRegistryOptions
  errorWindowMs?: number
  errorThreshold?: number
  onAutoDisable?: (pluginId: string, reason: string) => unknown
  createCapabilities?: (manifest: PluginManifest, scopes: string[]) => UnknownRecord | null
}

export interface ExtensionPointServiceRegistration extends UnknownRecord {
  pluginId: string
  name?: string
  service?: unknown
}

interface PluginStyleHandle {
  key: string
  pluginId: string
  webContents: {
    insertCSS(css: string): Promise<string>
    removeInsertedCSS(key: string): Promise<void>
  }
}

interface RegisteredPluginCleanup {
  cleanup: PluginCleanup
  active: boolean
}

type PluginCleanupBucket = 'activation' | 'uninstall'

export class PluginRegistryV2 {
  private readonly _providerRegistry: ProviderRegistry
  private readonly _contributions: ContributionRegistry
  private readonly _slots: ExtensionPointRegistry
  private readonly _pluginDir: string | null
  private readonly _pluginUserDir: string | null
  private readonly _manifestFileFilter: (name: string) => boolean
  private readonly _loader: PluginLoader | null
  private _manifests: PluginManifest[]
  private readonly _modules: Map<string, PluginModule>
  private readonly _pendingLoads: Map<string, Promise<PluginModule>>
  private readonly _loadErrors: Map<string, Error>
  private readonly _states: Map<string, PluginRuntimeState>
  private readonly _userDisabled: Set<string>
  private readonly _autoDisabled: Set<string>
  private readonly _grantedPermissions: Map<string, string[]>
  private readonly _errorStamps: Map<string, number[]>
  private readonly _errorWindowMs: number
  private readonly _errorThreshold: number
  private readonly _health: Map<string, PluginHealthRuntime>
  private _blockedCapabilities: Set<string> | null
  private readonly _onAutoDisable: ((pluginId: string, reason: string) => unknown) | null
  private readonly _extensionPoints: Map<string, Array<PluginServiceExport & { pluginId: string }>>
  private readonly _styles: Map<string, PluginStyleHandle>
  private readonly _providerDefinitions: Map<string, string>
  private readonly _serviceNames: Map<string, string[]>
  private _context: PluginRuntimeContext
  private readonly _createCapabilities: ((manifest: PluginManifest, scopes: string[]) => UnknownRecord | null) | null
  private readonly _capabilityCache: Map<string, { sig: string; caps: UnknownRecord | null }>
  private readonly _activationCleanups: Map<string, RegisteredPluginCleanup[]>
  private readonly _uninstallCleanups: Map<string, RegisteredPluginCleanup[]>

  constructor(options: PluginRegistryOptions = {}) {
    this._providerRegistry = options.providerRegistry || new ProviderRegistry(options.providerOptions)
    /**
     * 把「被禁用插件带走的能力」解析器接到能力注册表上。
     *
     * 为什么要这一步：`provider-bridge` 拿到的是 **ProviderRegistry**（20 个 registrar 都这么用），
     * 而"哪些能力该失效"的账本在本类（manifest + 两个禁用集合）。解析器把两者接起来，
     * 同时不把"插件"这个概念漏进 ProviderRegistry —— 见 `ProviderRegistry#isCapabilityBlocked`。
     *
     * 用闭包（而非传值）是必须的：状态随时在变，解析时现算。
     */
    if (typeof this._providerRegistry.setBlockedCapabilityResolver === 'function') {
      this._providerRegistry.setBlockedCapabilityResolver((capability: string) => this.isCapabilityBlocked(capability))
    }
    /**
     * 声明式贡献注册表（面板 / 按钮 / 菜单项 …）。
     *
     * 允许外部注入：APPS 需要在**插件启用之前**就持有它（面板目录要在 registerCoreIpc
     * 时就能被 IPC 读到），所以这里不能自作主张 new 一个只属于注册中心的私有实例。
     */
    this._contributions = options.contributions || createContributionRegistry()
    /**
     * 扩展点调度器（PART7 §7.3）—— 四种执行模式的插槽系统。
     *
     * 与上面 `_extensionPoints` 的**区别（容易混）**：
     *   · `_extensionPoints`（由 `registerExtensionPoints` 填）实为**服务出口表**：
     *     `{ name, service }`，供 provider 解析「这个插件导出了哪些服务」。没有执行模式。
     *   · 本 `_slots` 才是文档所说的「插槽」：id + 模式 + 契约，调用方主动点名执行。
     * 名称沿用历史（改 public 方法会波及既有插件），语义以本注释为准。
     */
    this._slots = options.extensionPoints || createExtensionPointRegistry(options.extensionPointOptions)
    this._pluginDir = options.pluginDir ? path.resolve(options.pluginDir) : null
    /**
     * **运行时安装**的第三方插件目录（用户数据目录下的 `plugins/`）。
     *
     * 与 `_pluginDir`（随应用分发的内置插件）分开是必须的：
     *   · 应用目录在打包后是只读的（asar / Program Files），装不进去东西；
     *   · 卸载/更新应用时**绝不能**把用户装的插件一起抹掉。
     * 两处都不会写盘 —— 安装/卸载是"用户往这个目录里放/删一个子目录"，
     * 注册中心只负责发现（这也是"市场"那一半与内核的解耦点）。
     */
    this._pluginUserDir = options.pluginUserDir ? path.resolve(options.pluginUserDir) : null
    this._manifestFileFilter = options.manifestFileFilter || defaultManifestFileFilter
    this._loader = options.loader || null
    this._manifests = []
    this._modules = new Map<string, PluginModule>()
    /**
     * pluginId → 正在进行的加载 Promise。
     *
     * 加载从"同步读文件"变成了**可能异步**（`loader` 端口可以是进程隔离：
     * fork + 握手要花时间）。异步化之后，同一插件的两次并发加载会各自 fork 一次 ——
     * 于是同一个插件被加载两遍、留下两个宿主进程。用这张表把并发合并成一次。
     */
    this._pendingLoads = new Map<string, Promise<PluginModule>>()
    /**
     * pluginId → 加载失败的原因。**本次会话内**不再重试同一个插件的加载。
     *
     * 为什么需要它：`enableAll` 的顺序是 `installAll()` → 逐个 `enable()`，
     * 两边都会走 `_loadModule`。若一个插件的入口语法错误、或顶层 `while(true)`
     * （进程隔离下表现为加载超时），不缓存失败就会**每个插件试两次** ——
     * 坏插件越多、启动越慢，而它每次都会失败。`reload()` 会清掉这条记录，
     * "改完代码立刻生效"不受影响；跨会话的自愈仍由 `failed` 不落盘保证。
     */
    this._loadErrors = new Map<string, Error>()
    this._states = new Map<string, PluginRuntimeState>()
    /**
     * 「用户主动禁用」的插件 id —— **唯一会被持久化**的状态。
     *
     * 为什么必须与 `_states.failed` 分开：一次偶发启用失败如果被当成"已禁用"落盘，
     * 就变成永久故障，而用户从没关过它。两者的写入方也不同：
     * 这里只由用户操作（插件中心的开关）写入，`failed` 只由 `enableAll` 的异常写入。
     */
    this._userDisabled = new Set<string>()
    /**
     * 「因**连环出错**被自动停用」的插件 id —— 第 4 态（PART7 §7.5 `lifecycle.onCrash`）。
     *
     * 与另外两态的边界：
     *   userDisabled  用户主动关 → 落盘，重启仍关
     *   failed        启用时抛错 → 不落盘，下次启动重试
     *   autoDisabled  运行期**连续**出错触顶 → **落盘**（否则每次启动都要再崩一轮），
     *                 但必须**允许用户一键恢复**（点开关重新启用即清除）
     */
    this._autoDisabled = new Set<string>()
    /**
     * pluginId → 用户**已授权**的权限 scope 列表（PART7 §7.5）。
     *
     * 与"声明"分开：`manifest.requestedPermissions` 是它想要的，这里是用户给过的。
     * 未授权 → 插件停在 `awaitingConsent`（第 6 态），拿不到任何它声明要的能力。
     * 落盘由 APPS 负责（键 `plugins.grantedPermissions`）。
     */
    this._grantedPermissions = new Map<string, string[]>()
    /**
     * pluginId → 最近一次错误窗口内的错误时间戳数组。
     *
     * 为什么是「窗口内计数」而不是「累计计数」：`onCrash: restart:3 then disable` 的意图是
     * **防止连环坏**（一个 Mod 在循环里疯狂抛错），而不是"一天里偶发三次就停用"。
     * 累计计数会让长期运行的会话被偶发错误误杀；窗口（默认 60s）只抓真正的连环。
     */
    this._errorStamps = new Map<string, number[]>()
    this._errorWindowMs = typeof options.errorWindowMs === 'number' && Number.isFinite(options.errorWindowMs) ? options.errorWindowMs : 60_000
    this._errorThreshold = typeof options.errorThreshold === 'number' && Number.isFinite(options.errorThreshold) ? options.errorThreshold : 3
    /**
     * pluginId → `{ failures, timer, running }` —— **主动健康检查**的运行态。
     *
     * 只在插件**声明了 `healthCheck` 且模块实现了 hook** 时才建表；
     * 计时器一律 `unref()`（健康检查不该拦住进程退出）。
     * 停用 / 禁用 / 热重载都会清掉它（见 `stopHealthCheck`）。
     */
    this._health = new Map<string, PluginHealthRuntime>()
    /**
     * 「被禁用的插件所贡献的能力」的**惰性缓存**（`null` = 待重算）。
     * 由 `_blockedCapabilitiesSet()` 填充、`_invalidateBlocked()` 失效 ——
     * 详见 `isCapabilityBlocked` 的说明（为什么是计算式而非增删式）。
     */
    this._blockedCapabilities = null
    /**
     * 触顶时的 **APPS 侧出口**（落盘 + 广播）—— 详见 `autoDisable()`。
     * 卸载本身由 infra 自己排队调 `disable()` 完成，不走这个回调。
     */
    this._onAutoDisable = typeof options.onAutoDisable === 'function' ? options.onAutoDisable : null
    this._extensionPoints = new Map<string, Array<PluginServiceExport & { pluginId: string }>>()
    this._styles = new Map<string, PluginStyleHandle>()
    this._providerDefinitions = new Map<string, string>()
    this._serviceNames = new Map<string, string[]>()
    /**
     * 最近一次 enableAll 的运行上下文（win / webContentsManager / providerRegistry …）。
     *
     * 为什么必须记住：启用一个插件要的手柄只在启动期拿得到（窗口、WebContentsManager、
     * 域服务出口）。插件中心是运行期才点「启用」的，那时没有这些手柄 —— 若不带上下文
     * 就调 `enable(id)`，插件会拿到空 ctx 直接崩。此处把它存下来，enable/disable/uninstall
     * 的第二参数缺省时自动复用，从而让「运行期热启用」与启动期的启用**走同一条路径**。
     */
    this._context = {}
    /**
     * **能力门面工厂**（组合根注入）：`(manifest, grantedScopes) => ({ browser: {...} })`。
     *
     * 为什么由 APPS 注入而不是 infra 实现：门面里每一个方法都要落到真实的
     * tabManager / layoutCoordinator / catalog / storage …… 那些只在组合根手里。
     * infra 只负责「按插件决定给不给」并把结果挂到 ctx.browser ——
     * 于是"插件能改浏览器哪些东西"这件事只有一份实现（apps/main/plugin-capabilities.js）。
     */
    this._createCapabilities = typeof options.createCapabilities === 'function' ? options.createCapabilities : null
    /** pluginId → 能力门面（权限变化时失效重算）。 */
    this._capabilityCache = new Map<string, { sig: string; caps: UnknownRecord | null }>()
    this._activationCleanups = new Map()
    this._uninstallCleanups = new Map()
  }

  discover() {
    if (!this._pluginDir) throw new Error('pluginDir is required to discover manifests')
    // 打包后 plugins/ 可能不在 asar 内（构建仅收录 out/**）——降级为"没有内置插件"，
    // 而**不是**启动即崩。注意这里不能直接 return：用户目录里装的第三方插件照样要能被发现。
    if (!fs.existsSync(this._pluginDir)) {
      console.warn(`[plugin] 内置插件目录不存在，跳过：${this._pluginDir}`)
    }

    /**
     * **两个来源，内置优先**。
     *
     * `pluginDir`     仓库自带的插件（随应用分发，扁平形态：`<id>.hira-plugin.json`）
     * `pluginUserDir` **运行时安装**的第三方插件（用户数据目录，**目录形态**：
     *                 `<id>/hira-plugin.json` + 同目录的代码与资源）
     *
     * 为什么用户态的必须是"一个目录一份"：第三方插件的代码、图标、渲染模块、
     * 许可证文件是一整套资产，散在一堆同名文件里既没法整体安装/卸载，
     * 也没法在目录级做隔离（协议层要把 URL 锁在该目录内）。
     *
     * 冲突时**内置优先**：用户装的插件与内置 id 撞名，若让用户那份胜出，
     * 等于允许用一次安装替换掉 tabs-service —— 那是提权，不是扩展。
     * 撞名的那份会被忽略并告警（不是报错：用户装了个重名插件不该让浏览器起不来）。
     */
    const found: PluginManifest[] = []
    const seen = new Set<string>()
    const sources: Array<[string | null, 'flat' | 'dir', boolean]> = [
      [this._pluginDir, 'flat', true],
      [this._pluginUserDir, 'dir', false]
    ]
    for (const [dir, shape, allowFirstParty] of sources) {
      if (!dir || !fs.existsSync(dir)) continue
      for (const m of scanPluginDir(dir, shape, this._manifestFileFilter, {
        defaultTrustLevel: allowFirstParty ? 'internal' : 'community',
        allowFirstParty
      })) {
        if (seen.has(m.id)) {
          console.warn(`[plugin] 忽略重名插件（内置优先）：${m.id} @ ${m.originPath}`)
          continue
        }
        seen.add(m.id)
        found.push(m)
      }
    }
    this._manifests = found
    this._invalidateBlocked()
    return found.slice()
  }

  setManifests(manifests: readonly unknown[]): PluginManifest[] {
    this._manifests = (manifests || []).map((manifest) => {
      const originPath = manifest && typeof manifest === 'object' && 'originPath' in manifest && typeof manifest.originPath === 'string'
        ? manifest.originPath
        : null
      const allowFirstParty = !!originPath && !!this._pluginDir && isWithinDirectory(this._pluginDir, originPath)
      return normalizeManifest(manifest, originPath, {
        defaultTrustLevel: allowFirstParty ? 'internal' : 'community',
        allowFirstParty
      })
    })
    this._invalidateBlocked()
    return this._manifests.slice()
  }

  getManifests() {
    return this._manifests.slice()
  }

  validateDeps() {
    return validateDeps(this._manifests)
  }

  /**
   * 加载并缓存一个插件的模块对象。
   *
   * **加载是异步的**：`loader` 端口可以是"把插件送进独立进程跑"（进程级隔离），
   * 那需要 fork + 握手。三个配套机制保障异步化不引入新问题：
   *   · `_pendingLoads` —— 并发合并，避免同一插件被加载两遍（各留一个宿主进程）；
   *   · `_loadErrors`  —— 失败缓存，避免坏插件在 `installAll` + `enable` 里各试一次；
   *   · `loadDefault`  —— 把**默认策略**交给端口，端口可以只接管一部分插件，
   *                        其余原样委托（例如"仅社区插件走独立进程"）。
   *
   * @param {object} m manifest
   * @param {object} [context] 本次加载所处的运行上下文（进程隔离下要下发给宿主）
   */
  async _loadModule (m: PluginManifest, context: PluginRuntimeContext): Promise<PluginModule> {
    const cached = this._modules.get(m.id)
    if (cached) return cached
    const failed = this._loadErrors.get(m.id)
    if (failed) throw failed
    const pending = this._pendingLoads.get(m.id)
    if (pending) return pending
    const task = this._loadModuleUncached(m, context)
    this._pendingLoads.set(m.id, task)
    try {
      return await task
    } finally {
      this._pendingLoads.delete(m.id)
    }
  }

  async _loadModuleUncached (m: PluginManifest, context: PluginRuntimeContext): Promise<PluginModule> {
    /**
     * 默认加载策略 —— **原样保留**改造前的行为，并作为端口的一部分交出去。
     *
     * 为什么要把默认策略**注入**给端口而不是让端口自己实现一遍：第一方插件
     * `require` 的路径规则（相对 manifest 所在目录解析 `main`）是 infra 的知识，
     * 抄袭一份到 APPS 必然漂移。端口只决定"哪些插件需要特殊待遇"，
     * 其余调用 `loadDefault()`，两者的职责边界就清楚了。
     */
    const loadDefault = async () => {
      /**
       * **没有 `main` = 纯数据插件**（如 `type: theme-plugin`：只贡献 `contributes.themes`）。
       *
       * 返回空模块而不是抛错 —— 这是「声明式贡献不需要写代码」的最后一块拼图：
       * 主题作者只写一份 manifest + 一段主题数据，不被迫附带一个空 `.cjs`。
       * 空模块让后续所有 `typeof mod.x === 'function'` 判定自然为假，
       * 而 `contributeFromManifest` / `defineContributedExtensionPoints` 照常跑
       * （它们只读 manifest，不碰模块）。于是"装一个主题"与"装一个插件"是同一条链路。
       */
      if (!m.main) return {}
      if (!m.originPath) throw new Error(`Manifest missing originPath: ${m.id}`)
      // 第一方直接 require；社区插件必须在上面的 fail-closed 分支之后由 loader 接管。
      return nodeRequire(path.resolve(path.dirname(m.originPath), m.main))
    }
    let mod: unknown
    try {
      if (!this._loader && !m.isFirstParty && m.main) {
        throw new Error(`Community plugin ${m.id} requires an isolation loader`)
      }
      mod = this._loader
        ? await this._loader(m, { context: this._pluginContext(context || this._context, m), loadDefault })
        : await loadDefault()
    } catch (e) {
      const err = e instanceof Error ? e : new Error(String(e))
      this._loadErrors.set(m.id, err)
      throw err
    }
    if (!mod) throw new Error(`Plugin ${m.id} failed to load`)
    const pluginModule = mod as PluginModule
    this._modules.set(m.id, pluginModule)
    if (!this._states.has(m.id)) this._states.set(m.id, { installed: false, enabled: false })
    return pluginModule
  }

  /**
   * 每个插件生命周期钩子收到的 ctx —— **统一构造点**。
   *
   * 为什么必须收口成一个方法而不是每处 `{ ...context, pluginId, manifest }`：
   * 19 个钩子各自展开一份 ctx，任何"某类插件多一个 / 少一个端口"的规则散在 19 处，
   * 下一代端口一加就又得逐处补 —— 那正是本项目最忌讳的松松垮垮。
   *
   * 当前只有一条差异化规则：**内核端口 `kernel` 仅第一方插件可见**。
   * `kernel`（ipcMain / db / 广播 / 开窗 / 布局）是"可信代码"才能碰的东西，
   * 第三方插件走 capability 与 IPC 契约，不该拿到主进程原语。
   * 非第一方 **删掉该键**（而不是置 undefined）—— 插件里 `'kernel' in ctx` 才不会误判。
   *
   * @param {object} context enableAll / enable 记下的运行上下文
   * @param {object} m 插件 manifest
   */
  _pluginContext (context: PluginRuntimeContext | null | undefined, m: PluginManifest): PluginExecutionContext {
    const base: PluginExecutionContext = {
      // First-party modules are the browser itself and keep the full live context.
      // Installable plugins are external code: raw domain services, window handles
      // and registries must never cross the process boundary. Their only system
      // surface is the scope-checked `ctx.browser` facade added below.
      ...(m.isFirstParty ? (context || {}) : {}),
      pluginId: m.id,
      manifest: m,
      onCleanup: (cleanup) => this._registerPluginCleanup(m.id, 'activation', cleanup),
      onDispose: (cleanup) => this._registerPluginCleanup(m.id, 'uninstall', cleanup),
      isActive: () => !!(this._states.get(m.id) || {}).enabled
    }
    if (!m.isFirstParty) delete base.kernel
    /**
     * 开放世界能力门面（`ctx.browser`）：全部可自定义面的唯一入口。
     *
     * 第一方拿全量；第三方按已授权 scope 裁剪。门面内部逐方法鉴权，
     * 因此这里只负责"给不给这个对象"，不重复判 scope（规则只写一处）。
     */
    const caps = this._capabilitiesFor(m)
    if (caps) base.browser = caps
    return base
  }

  private _cleanupBucket(pluginId: string, bucket: PluginCleanupBucket): Map<string, RegisteredPluginCleanup[]> {
    return bucket === 'activation' ? this._activationCleanups : this._uninstallCleanups
  }

  private _registerPluginCleanup(pluginId: string, bucket: PluginCleanupBucket, cleanup: PluginCleanup): PluginCleanupHandle {
    if (typeof cleanup !== 'function') throw new TypeError(`[plugin] ${pluginId}: cleanup must be a function`)
    const table = this._cleanupBucket(pluginId, bucket)
    const entries = table.get(pluginId) || []
    const entry: RegisteredPluginCleanup = { cleanup, active: true }
    entries.push(entry)
    table.set(pluginId, entries)
    return () => {
      if (!entry.active) return
      entry.active = false
      const index = entries.indexOf(entry)
      if (index >= 0) entries.splice(index, 1)
      if (!entries.length && table.get(pluginId) === entries) table.delete(pluginId)
    }
  }

  private async _flushPluginCleanups(pluginId: string, bucket: PluginCleanupBucket): Promise<void> {
    const table = this._cleanupBucket(pluginId, bucket)
    const entries = table.get(pluginId) || []
    table.delete(pluginId)
    for (let index = entries.length - 1; index >= 0; index -= 1) {
      const entry = entries[index]
      if (!entry.active) continue
      entry.active = false
      try {
        await entry.cleanup()
      } catch (error) {
        console.warn(`[plugin] ${pluginId}: ${bucket} cleanup failed:`, errorMessage(error))
      }
    }
  }

  /**
   * 取（或建）某插件的能力门面。
   *
   * 缓存键包含授权 scope 的签名 —— 用户在插件中心改授权后必须立刻生效，
   * 而插件模块已经缓存、不会重新加载，所以只能靠这里失效。
   */
  _capabilitiesFor (m: PluginManifest | null | undefined): UnknownRecord | null {
    if (!this._createCapabilities || !m?.id) return null
    const scopes = m.isFirstParty
      ? ['*']
      : (this._grantedPermissions.get(m.id) || [])
    const sig = scopes.slice().sort().join(',')
    const hit = this._capabilityCache.get(m.id)
    if (hit && hit.sig === sig) return hit.caps
    let caps: UnknownRecord | null = null
    try {
      caps = this._createCapabilities(m, m.isFirstParty ? [] : scopes)
    } catch (e) {
      console.warn(`[plugin] 能力门面创建失败（${m.id}）：`, errorMessage(e))
      return null
    }
    this._capabilityCache.set(m.id, { sig, caps })
    return caps
  }

  preInstall (_context: PluginRuntimeContext): void {}

  /**
   * 逐个插件 install（**异步 + 单插件失败隔离**）。
   *
   * 与 `enableAll` 的 try/catch 对齐：加载 / install 一个插件失败，只把**它**标成
   * `failed`，其余插件照常。改前这里是裸循环且同步 —— 在"加载可能异步且会失败"
   * （进程隔离）之后，裸循环会让一个坏插件把整个插件系统带崩（`enableAppPlugins`
   * 直接 reject），这与 §7.13「一个 Mod 崩 100 次不影响其余」的硬指标正相反。
   */
  async installAll (context: PluginRuntimeContext = {}): Promise<void> {
    this.validateDeps()
    this.preInstall(context)
    const ordered = topoSort(this._manifests)

    for (const m of ordered) {
      try {
        await this._installOne(m, context)
      } catch (e) {
        // 与 enableAll 同款语义：不落盘、下次启动重试（失败自愈）。
        this.markFailed(m.id, e)
      }
    }
  }

  /**
   * 单个插件的 install 生命周期（`installAll` 与运行期 `enable` 共用）。
   *
   * 为什么必须抽出来：`installAll` 只在**启动时**跑一次，而插件可以在运行期出现
   * （从文件安装 / 市场安装 / AI 工作室现场生成 / 主题导入）。这些路径只做
   * `discover()` + `enable()`，新插件的状态就停在 `installed:false` —— 于是
   * `enable()` 直接抛 `Plugin not installed`，界面上却显示"已安装"，自相矛盾。
   *
   * 幂等：已 installed 的插件直接返回，重复调用不会重跑 `install` 钩子。
   *
   * @param {PluginManifest} m 归一化后的 manifest
   * @param {object} [context]
   * @returns {Promise<boolean>} 是否处于已安装状态
   */
  async _installOne (m: PluginManifest, context: PluginRuntimeContext = {}): Promise<boolean> {
    const mod = await this._loadModule(m, context)
    const st = this._states.get(m.id) || { installed: false, enabled: false }
    if (st.installed) return true
    if (typeof mod.preInstall === 'function') await mod.preInstall(this._pluginContext(context, m))
    if (typeof mod.install === 'function') await mod.install(this._pluginContext(context, m))
    if (typeof mod.postInstall === 'function') await mod.postInstall(this._pluginContext(context, m))
    this._states.set(m.id, { ...st, installed: true })
    return true
  }

  registerExtensionPoints(pluginId: string, eps: PluginServiceExportDefinition[] = []): void {
    for (const ep of eps) {
      const name = String(ep.name || '').trim()
      if (!name) continue
      const bucket = this._extensionPoints.get(name) ?? []
      bucket.push({ ...ep, pluginId })
      this._extensionPoints.set(name, bucket)
    }
  }

  unregisterExtensionPoints(pluginId: string): void {
    for (const [name, list] of this._extensionPoints.entries()) {
      const next = list.filter((x) => x.pluginId !== pluginId)
      if (next.length) this._extensionPoints.set(name, next)
      else this._extensionPoints.delete(name)
    }
  }

  async injectStyles(pluginId: string, styles: unknown, options: { webContents?: PluginStyleHandle['webContents'] } = {}): Promise<boolean> {
    const { webContents } = options
    if (!webContents || typeof webContents.insertCSS !== 'function') return false
    if (!styles) return false
    const css = String(styles)
    const key = `${pluginId}:css`
    if (this._styles.has(key)) return true
    const k = await webContents.insertCSS(css)
    this._styles.set(key, { key: k, pluginId, webContents })
    return true
  }

  async removeStyles(pluginId: string): Promise<void> {
    const prefix = `${pluginId}:`
    for (const [k, v] of this._styles.entries()) {
      if (!k.startsWith(prefix)) continue
      if (v.webContents && typeof v.webContents.removeInsertedCSS === 'function') {
        await v.webContents.removeInsertedCSS(v.key)
      }
      this._styles.delete(k)
    }
  }

  async enableAll(context: PluginRuntimeContext = {}): Promise<{ healed: string[]; healedAuto: string[] }> {
    // 记住运行上下文（见构造函数里 _context 的说明）—— 插件中心的运行期启用复用它。
    this._context = context
    // 禁用的插件**仍然 install**：install 是把插件的文件/迁移准备好（只跑一次），
    // 与"要不要启用"是两件事。装在但不启用 = 插件中心里能看到它、能再打开。
    await this.installAll(context)
    /**
     * **自愈（升级路径）**：不可禁用的插件不允许留在 `_userDisabled` 里。
     *
     * 两个来源：老版本的 `plugins.disabled`（那时它还允许被关）、用户手改配置文件。
     * `setUserDisabled` 已经拦住了**写入**，这里兜的是**已经写进去的历史状态** ——
     * 不剔的后果是"修了，但他还是打不开插件中心"（永久锁死），
     * 而那恰恰是本次要修的那个问题。
     *
     * 返回 `healed` 让 APPS 把磁盘上的残留一并清掉（否则每次启动都要再自愈一遍）。
     */
    const healed = []
    for (const id of Array.from(this._userDisabled)) {
      if (this.isNonDisableable(id)) { this._userDisabled.delete(id); healed.push(id) }
    }
    /**
     * 同一件事对 `_autoDisabled` 再做一遍 —— 自动停用也会把核心插件带进
     * 「能力被禁用 → 直接抛错」的死局，而且**用户点开关也救不回来**
     * （那条 IPC 本身就在它提供的能力里）。`setAutoDisabled` 已经拦了写入，
     * 这里兜的是历史状态与"绕过它直接改集合"的路径。
     */
    const healedAuto = []
    for (const id of Array.from(this._autoDisabled)) {
      if (this.isNonDisableable(id)) { this._autoDisabled.delete(id); healedAuto.push(id) }
    }
    if (healed.length || healedAuto.length) {
      this._invalidateBlocked()
      console.warn(`[plugin] 已自动恢复不可禁用的插件（它们关掉就没有回头路）：${healed.concat(healedAuto).join(', ')}`)
    }
    const ordered = topoSort(this._manifests)
    for (const m of ordered) {
      if (this._userDisabled.has(m.id) || this._autoDisabled.has(m.id)) {
        // 不启用，但要显式落一个 enabled=false 的状态（describe() 靠它渲染开关）。
        // 两种"不启用"的原因不同，插件中心要能分辨：用户关的 vs 系统停的。
        const st = this._states.get(m.id) || { installed: false, enabled: false }
        const auto = this._autoDisabled.has(m.id)
        this._states.set(m.id, {
          ...st,
          enabled: false,
          failed: false,
          blocked: false,
          blockedBy: [],
          awaitingConsent: false,
          /**
           * 保留已有的停用原因；**重启后**内存里没有原文时给一句通用说明。
           *
           * 为什么不能像原来那样直接写 `null`：自动停用的原文只在内存里（`failed` 那条链
           * 也一样不落盘），重启后必然为空。写 `null` 会让插件中心显示
           * 「已自动停用：连续出错」还是「已自动停用：（空）」全看运气 ——
           * 而用户恰恰是在重启后最需要知道"它为什么被关了"。
           */
          error: st.error || (auto ? '上次运行连续出错，已自动停用' : null)
        })
        continue
      }
      try {
        await this.enable(m.id, context)
      } catch (e) {
        /**
         * 一个插件启用失败**不能**中断其余插件的启动。
         *
         * 旧写法是裸 `await this.enable(...)`：任何一个插件抛错，循环当场结束，
         * 排在它后面的插件**一个都不会被启用** —— 而排序是按依赖拓扑的，
         * 于是"坏一个，后面全空"，且错误信息只指向那一个插件，极难定位。
         *
         * 这里记录为 failed（**不写进 userDisabled**）：下次启动会再试一次，
         * 也就是"失败自愈"。绝不能把失败记成"用户禁用" ——
         * 那会让一次偶发失败变成永久故障，而用户从没关过它。
         */
        this.markFailed(m.id, e)
      }
    }
    // 交回本次自愈的插件 id（调用方据此清掉磁盘上的残留）—— 见上面 healed 的说明。
    return { healed, healedAuto }
  }

  /**
   * 标记某插件启用失败（不持久化 —— 下次启动自动重试）。
   * @param {string} pluginId
   * @param {unknown} error
   */
  markFailed(pluginId: string, error: unknown): void {
    const st = this._states.get(pluginId) || { installed: true, enabled: false }
    const message = errorMessage(error)
    this._states.set(pluginId, { ...st, enabled: false, failed: true, blocked: false, blockedBy: [], error: message })
    console.error(`[plugin] 启用失败：${pluginId} —`, message)
  }

  /**
   * 标记「因前置未启用而无法启用」—— 第 5 态 `blocked`（§10.3 point 2）。
   *
   * 为什么不复用 `failed`：两者的**根因位置**完全不同。
   *   · `failed` —— 这个插件自己有问题（它抛错了），根因在这里；
   *   · `blocked` —— 这个插件**一行代码都没跑**，根因在上游（前置没起来）。
   * 若把 blocked 记成 failed，用户会看到一串"启用失败"，而真正的根因只有一个 ——
   * 那正是 §8.1 要避免的那类误导。
   *
   * 与 `failed` 一样**不落盘**：下次启动时前置若已就绪就该正常启用（失败自愈的同源道理）。
   *
   * @param {string} pluginId
   * @param {string[]} missingIds 未启用的硬前置 id
   */
  markBlocked(pluginId: string, missingIds: string[]): void {
    const st = this._states.get(pluginId) || { installed: true, enabled: false }
    const ids = (missingIds || []).slice()
    const names = ids.map((id) => {
      const m = this._manifests.find((x) => x.id === id)
      return m ? (m.name || id) : id
    })
    const message = `前置未启用：${names.join('、') || '未知'}`
    this._states.set(pluginId, { ...st, enabled: false, failed: false, blocked: true, blockedBy: ids, error: message })
    console.warn(`[plugin] 前置未就绪，暂不启用：${pluginId} —`, message)
  }

  /** 某 manifest 的硬依赖里**当前未启用**的那些（含未安装/不存在 —— 它们同样算没就绪）。 */
  _unsatisfiedDeps(manifest: PluginManifest): string[] {
    const missing: string[] = []
    for (const depId of manifest.dependsOn) {
      const dep = this._states.get(depId)
      if (!dep || dep.enabled !== true) missing.push(depId)
    }
    return missing
  }

  /**
   * 某个插件的**全部硬前置**（递归，拓扑序：最上游在前）。
   *
   * 用途：启用时按拓扑序恢复（§10.3 point 1）—— 顺序反了的话前置还没起来依赖方就失败，
   * 会被误记成 `failed`，然后触发失败自愈重试，变成每次启动都报一次假失败。
   *
   * @param {string} pluginId
   * @returns {string[]} 不含自身
   */
  prerequisiteIds(pluginId: string): string[] {
    const byId = new Map<string, PluginManifest>(this._manifests.map((m) => [m.id, m]))
    const out: string[] = []
    const seen = new Set<string>()
    const visit = (id: string): void => {
      const m = byId.get(id)
      if (!m) return
      for (const depId of m.dependsOn) {
        if (seen.has(depId)) continue
        seen.add(depId)
        visit(depId)
        out.push(depId) // 前置排在依赖方之前
      }
    }
    visit(String(pluginId || ''))
    return out
  }

  /**
   * 某个插件的**全部硬下游**（递归，**逆**拓扑序：最下游在前）。
   *
   * 为什么必须是逆拓扑序：禁用要"先关下游再关上游"。反过来的话，前置先被摘掉，
   * 而下游还开着却在调它的能力 —— 中间会有一段真实的"调谁谁不在"窗口。
   *
   * @param {string} pluginId
   * @returns {string[]} 不含自身
   */
  dependentIds(pluginId: string): string[] {
    const children = new Map()
    for (const m of this._manifests) {
      for (const depId of m.dependsOn) {
        if (!children.has(depId)) children.set(depId, [])
        children.get(depId).push(m.id)
      }
    }
    const out: string[] = []
    const seen = new Set<string>()
    const visit = (id: string): void => {
      for (const childId of children.get(id) || []) {
        if (seen.has(childId)) continue
        seen.add(childId)
        visit(childId)
        out.push(childId) // 下游排在依赖方之前
      }
    }
    visit(String(pluginId || ''))
    return out
  }

  /**
   * 按拓扑序启用一个插件及其全部硬前置（§10.3 point 1 / point 4 的**唯一**恢复路径）。
   *
   * 两类前置的区别对待是本方法的核心（两者都"关着"，但含义完全相反）：
   *
   * | 前置状态 | 处理 | 为什么 |
   * |---|---|---|
   * | `userDisabled`（用户关的） | **一起恢复**，并记入 `restored` 让调用方告知用户 | 用户要开下游，而下游**必须**有它 —— 恢复是这次意图的必然含义，不是自作主张 |
   * | `autoDisabled`（连环坏停用） | **绝不复活** | 那是系统为压住崩溃循环做的保护；顺手复活 = 把刚扑灭的火重新点着 |
   *
   * 关键差别在"**谁的决定**"：前者是用户的决定，被用户的另一个决定（开下游）取代，合理；
   * 后者是系统的安全判定，只能由用户专门针对那个插件去解除。
   *
   * @param {string} pluginId
   * @param {object} [context]
   * @returns {Promise<{ enabled: boolean, blocked: boolean, blockedBy: string[], restored: string[] }>}
   *   `restored` = 为达成这次启用而**顺带恢复**的前置 id（调用方应把它持久化并提示用户）
   */
  async enableWithPrerequisites(pluginId: string, context?: PluginRuntimeContext): Promise<PluginToggleResult> {
    const ctx = context || this._context
    // 待授权的插件：**不要**先把它的前置拉起来（理由同 enable() 里的授权闸门）。
    const self = this._manifests.find((x) => x.id === pluginId)
    if (self && this._needsConsent(self)) {
      this.markAwaitingConsent(pluginId, self.requestedPermissions)
      return { enabled: false, blocked: false, blockedBy: [], restored: [], awaitingConsent: true }
    }
    const restored: string[] = []
    for (const id of this.prerequisiteIds(pluginId)) {
      if (this._autoDisabled.has(id)) continue
      const st = this._states.get(id)
      if (st && st.enabled) continue
      if (this._userDisabled.has(id)) {
        this._userDisabled.delete(id)
        this._invalidateBlocked()
        restored.push(id)
      }
      try { await this.enable(id, ctx) } catch (e) { this.markFailed(id, e) }
    }
    await this.enable(pluginId, ctx)
    const st: PluginRuntimeState = this._states.get(pluginId) || { installed: true, enabled: false }
    return {
      enabled: !!st.enabled,
      blocked: !!st.blocked,
      blockedBy: (st.blockedBy || []).slice(),
      restored
    }
  }

  /**
   * 记录"用户主动禁用"（持久化意图）。
   * 与 `failed` 严格区分：这里只由**用户操作**写入，是唯一会被落盘的状态。
   *
   * **不可禁用的插件（core / nonDisableable）在这里被拒绝**，返回 `false`。
   * 闸门放在这一层而不是只放在 IPC：写入方不止一个（启动恢复、连带禁用、
   * `enableWithPrerequisites`、IPC），任何一条能绕过去就等于没保护。
   *
   * @param {string} pluginId
   * @param {boolean} disabled
   * @returns {boolean} 是否被接受（`false` = 被"不可禁用"闸门拒绝）
   */
  setUserDisabled(pluginId: string, disabled: boolean): boolean {
    const id = String(pluginId || '')
    if (!id) return false
    if (disabled && this.isNonDisableable(id)) {
      /**
       * 拒绝写入并**顺手把可能存在的残留清掉**。
       *
       * "顺手清掉"不是防御性冗余：它的真实场景是**升级** —— 老版本的
       * `plugins.disabled` 里可能已经躺着 `panel-plugins`（那时它还允许被关），
       * 磁盘读回来就会经过这里。不清的话，用户升级后插件中心依然是关着的，
       * 也就是"修了，但他还是打不开"。
       */
      if (this._userDisabled.has(id)) {
        this._userDisabled.delete(id)
        this._invalidateBlocked()
      }
      console.warn(`[plugin] 拒绝禁用不可禁用的插件：${id}（它是某个功能的唯一出口，关掉就没有回头路）`)
      return false
    }
    if (disabled) this._userDisabled.add(id)
    else this._userDisabled.delete(id)
    /**
     * 用户主动关掉 = **不再"等授权"**。
     *
     * 第 6 态的含义是"球在用户那边"（等他点头）。用户把它关掉，就是已经把球打回来了 ——
     * 决策做完了。若不清掉，插件中心会一直挂着那块"请授权"的弹窗，
     * 而用户明明已经用"暂不"表达过态度了。
     *
     * 之后他若改主意点开关，`enable()` 会重新走授权闸门 → 弹窗自然再出现（"再问一次"）。
     */
    if (disabled) {
      const st = this._states.get(id)
      if (st && st.awaitingConsent) this._states.set(id, { ...st, awaitingConsent: false })
    }
    this._invalidateBlocked()
    return true
  }

  /**
   * 该插件是否**不可被禁用**。
   *
   * 两个来源取或（后果完全一致，所以只留一个判定入口，避免各处各写一遍）：
   *   · `trustLevel === 'core'`   —— 浏览器最小可运行集合（tabs / settings…）
   *   · `nonDisableable === true` —— 某个功能的**唯一出口**（插件中心面板、侧栏骨架）
   *
   * 为什么后果是"不可禁用 + 不可被连带禁用"两条：只挡第一条是没用的 ——
   * 从它的**依赖方向**一样能把它关掉（禁用它的硬前置 → 它落 `blocked`）。
   *
   * @param {string} pluginId
   */
  isNonDisableable(pluginId: string): boolean {
    const m = this._manifests.find((x) => x.id === String(pluginId || ''))
    if (!m) return false
    return m.trustLevel === 'core' || m.nonDisableable === true
  }

  isUserDisabled(pluginId: string): boolean {
    return this._userDisabled.has(String(pluginId || ''))
  }

  /** 当前被用户主动禁用的插件 id（供持久化层读取）。 */
  listUserDisabled(): string[] {
    return Array.from(this._userDisabled)
  }

  /**
   * 记录用户**已授权**的权限 scope 集合（PART7 §7.5 的授权弹窗结果）。
   *
   * 为什么要单独一张表而不是"从 `requestedPermissions` 推导"：
   * 声明 ≠ 授权。第三方插件声明的 scope 是**它想要什么**，只有用户点过同意之后
   * 才变成**它能拿到什么**。把两者混在一起，等于"写了就算数"，那套权限体系形同虚设。
   *
   * 授权与"禁用"不同：授权是**一次性的准入**（撤销后插件回到待授权态），
   * 它不落 `userDisabled`。
   *
   * @param {string} pluginId
   * @param {string[]} scopes
   */
  setGrantedPermissions(pluginId: string, scopes: string[]): void {
    const id = String(pluginId || '')
    if (!id) return
    const list = Array.isArray(scopes) ? scopes.map(String) : []
    if (list.length) this._grantedPermissions.set(id, Array.from(new Set(list)))
    else this._grantedPermissions.delete(id)
    // 授权变了 → 能力门面必须重建，否则插件手里还是旧的（少授权 / 越权）那份。
    this._capabilityCache.delete(id)
  }

  /** 已授权的 scope 列表（供持久化层读取）。 */
  listGrantedPermissions(): Record<string, string[]> {
    const out: Record<string, string[]> = {}
    for (const [id, scopes] of this._grantedPermissions.entries()) out[id] = scopes.slice()
    return out
  }

  isGranted(pluginId: string): boolean {
    return this._grantedPermissions.has(String(pluginId || ''))
  }

  /**
   * 该插件是否**在等用户授权**（`enable()` 的前置闸门之一）。
   *
   * 三条同时成立才算等授权：非第一方、**声明了**权限、且还没被授权。
   * 第一方不需要授权（见 normalizeManifest 的说明）；没声明权限的插件也无从授权 ——
   * 这类插件（如纯面板）本就拿不到任何额外能力，没必要拦。
   */
  _needsConsent(m: PluginManifest): boolean {
    return !m.isFirstParty && m.requestedPermissions.length > 0 && !this._grantedPermissions.has(m.id)
  }

  /** 标记「等待用户授权」—— 与 `blocked`（根因在上游）是两回事，故单独一态。 */
  markAwaitingConsent(pluginId: string, scopes: string[]): void {
    const st = this._states.get(pluginId) || { installed: true, enabled: false }
    const list = (scopes || []).slice()
    const message = `需要授权：${list.join('、') || '未知权限'}`
    this._states.set(pluginId, {
      ...st, enabled: false, failed: false, blocked: false, blockedBy: [], awaitingConsent: true, error: message
    })
    console.warn(`[plugin] 等待用户授权：${pluginId} —`, message)
  }

  /**
   * 记录/清除「自动停用」（第 4 态）。落盘与清除由 APPS 驱动。
   *
   * ⚠ 与 `setUserDisabled` 同构：对**不可禁用的插件**写入 `true` 一律拒绝并返回 `false`。
   * 这条守卫是**启动期恢复路径**的关键 —— `plugin-bootstrap` 拿着磁盘上的
   * `plugins.autoDisabled` 逐条灌进来，老版本可能已经把 `tabs-service` 写进去了
   * （那时还没有这道守卫）。返回 false 让调用方知道"这条不该存在"，从而把磁盘残留清掉；
   * 否则每次启动都要再拒一遍，用户永远卡在"导航不可用"。
   *
   * @param {string} pluginId
   * @param {boolean} disabled
   * @returns {boolean} 写入是否被接受（false = 因不可禁用而拒绝）
   */
  setAutoDisabled(pluginId: string, disabled: boolean): boolean {
    const id = String(pluginId || '')
    if (!id) return true
    if (disabled) {
      if (this.isNonDisableable(id)) {
        // 顺手把可能存在的残留清掉（见方法说明：升级路径的真实场景）
        if (this._autoDisabled.has(id)) {
          this._autoDisabled.delete(id)
          this._invalidateBlocked()
        }
        console.warn(`[plugin] 拒绝自动停用不可禁用的插件：${id}（它是某个功能的唯一出口，关掉就没有回头路）`)
        return false
      }
      this._autoDisabled.add(id)
    } else {
      this._autoDisabled.delete(id)
      this._errorStamps.delete(id)
    }
    this._invalidateBlocked()
    return true
  }

  isAutoDisabled(pluginId: string): boolean {
    return this._autoDisabled.has(String(pluginId || ''))
  }

  listAutoDisabled(): string[] {
    return Array.from(this._autoDisabled)
  }

  /**
   * 「被禁用的插件所贡献的能力」集合 —— §9 语义缺口的解药（**计算式，不是增删式**）。
   *
   * ── 解决什么 ──────────────────────────────────────────────────────
   * `provider-bridge.js` 在「无 provider」时直连域服务兜底，语义是"插件不在了也能跑"。
   * 这条兜底本身是必需的，但它同时让"禁用"失去意义 —— **因为兜底永远在**：
   * 关掉 bookmark 引擎 → 它的 provider 被摘 → `hasProvider=false` → 走 fallback → 功能照旧。
   *
   * 所以要区分两种"没有 provider"：
   *   · 插件不存在 / 加载失败 / 崩了     → 走 fallback（降级，功能保留）
   *   · 插件被**显式关掉**（用户或连环坏） → **不走 fallback**（功能真的消失）
   * 本表就是后者的判据。调用方是 `provider-bridge`（`!hasProvider` 分支里问一句）。
   *
   * ── 为什么是"计算式"而不是"禁用时登记、启用时撤销" ────────────────
   * 增删式要维护一份与真实状态同步的镜像表，每次禁用/启用/自动停用/失败都要记得改，
   * 漏一处就留下幽灵条目（表现是"启用了但功能还是不可用"，且极难定位）。
   * 计算式没有这个问题：答案永远由 `_manifests` + 两个禁用集合现算，不可能漂移。
   *
   * ── 为什么能力清单取自 **manifest** 而不是模块的 `registerProviders()` ──
   * 启动时被禁用的插件**根本没被 enable**，也就没有任何 provider 可枚举；
   * 而"它贡献了哪些能力"必须此刻就知道（否则首次启动就漏掉拦截）。
   * manifest 的 `capabilities` 字段是静态声明，不需要加载模块、不需要域服务就绪 —— 唯一可用且正确的来源。
   *
   * 缓存：结果按需重建（`_invalidateBlocked` 在每次禁用集合变动时失效）。
   * @returns {Set<string>}
   */
  _blockedCapabilitiesSet(): Set<string> {
    if (this._blockedCapabilities) return this._blockedCapabilities
    const set = new Set<string>()
    for (const m of this._manifests) {
      // autoDisabled 与 userDisabled 都算"显式关掉"：系统停用的插件同样不该继续提供服务
      if (!this._userDisabled.has(m.id) && !this._autoDisabled.has(m.id)) continue
      for (const capability of m.capabilities || []) set.add(String(capability))
    }
    this._blockedCapabilities = set
    return set
  }

  /** 禁用集合变了 → 丢弃缓存，下次查询重算。 */
  _invalidateBlocked() {
    this._blockedCapabilities = null
  }

  /**
   * 某个能力是否"因为提供它的插件被显式禁用"而应当不可用。
   *
   * `provider-bridge` 只在 **`!hasProvider`** 分支问这一句 —— 这是刻意的：
   * 若另一个仍然启用的插件也提供同一能力，`hasProvider` 为真，功能照常可服务，
   * 不该因为"某个被禁用的插件也声明过它"而误判为不可用。
   *
   * @param {string} capability
   * @returns {boolean}
   */
  isCapabilityBlocked(capability: string): boolean {
    const key = String(capability || '')
    if (!key) return false
    return this._blockedCapabilitiesSet().has(key)
  }

  /** 供插件中心 / 诊断用：当前被禁用插件带走的能力清单（排序后）。 */
  listBlockedCapabilities(): string[] {
    return Array.from(this._blockedCapabilitiesSet()).sort()
  }

  /**
   * 上报一次**插件运行期错误** —— 连环坏判定的唯一输入。
   *
   * 谁该上报（重要）：只报**插件自己代码**抛的错。
   * 「插件调用的域服务抛错」（DB 锁、网络）不该算在插件头上 —— 否则一次瞬时故障
   * 累计三次就会把用户的书签引擎永久停掉。区分办法见 `service-plugin.js`：
   * 域服务错误会被打上 `hiraDomainServiceError` 标记，调用方据此**不要**上报。
   *
   * @param {string} pluginId
   * @param {unknown} error
   * @returns {{ count: number, autoDisabled: boolean }} 窗口内错误数与是否已触发自动停用
   */
  reportPluginError(pluginId: string, error: unknown): { count: number; autoDisabled: boolean } {
    const id = String(pluginId || '')
    if (!id) return { count: 0, autoDisabled: false }
    // 已被用户关掉或已自动停用的插件不必再计数（它本就不该在跑）
    if (this._userDisabled.has(id) || this._autoDisabled.has(id)) return { count: 0, autoDisabled: false }

    const now = Date.now()
    const stamps = (this._errorStamps.get(id) || []).filter((t) => now - t < this._errorWindowMs)
    stamps.push(now)
    this._errorStamps.set(id, stamps)

    const message = errorMessage(error)
    const st = this._states.get(id) || { installed: true, enabled: false }
    // 记下最后一条错误原文：插件中心要显示它，用户才知道"为什么被停用"
    this._states.set(id, { ...st, error: message })

    /**
     * ⚠ **不可禁用的插件永不参与连环坏停用**（与 `setUserDisabled` / `autoDisable` 同一条守卫）。
     *
     * 它不是"再坏也要留着"的偏袒，而是**后果不对等**：`tabs-service` 一停，导航、切标签、
     * 关闭这些能力同时消失，`provider-bridge` 还会因为"能力被禁用"直接抛错 ——
     * 整个浏览器不可用，且**没有任何兜底路径能把它救回来**（连插件中心点开关都要走
     * 那三条已经不通的 IPC）。普通插件坏掉只损失一个功能，核心插件坏掉损失整台车。
     *
     * 所以这里只记错误原文供插件中心显示，**不计数、不停用** —— 让它继续跑，
     * 单次调用失败由 `provider-bridge` 的 recover 分支逐次处理。
     */
    if (this.isNonDisableable(id)) return { count: 0, autoDisabled: false }

    if (stamps.length < this._errorThreshold) return { count: stamps.length, autoDisabled: false }

    this.autoDisable(id, `连续 ${this._errorThreshold} 次出错（${Math.round(this._errorWindowMs / 1000)} 秒内），最后一次：${message}`)
    return { count: stamps.length, autoDisabled: true }
  }

  /**
   * 自动停用（第 4 态）。**判定与副作用分离**：
   *
   * 1. 判定（本方法）：把 id 记进 `_autoDisabled`（此后 `reportPluginError` 不再计数、
   *    `enableAll` 也会跳过它）、记下原因原文、打日志。
   * 2. 卸载（也是 infra）：排队跑一次 `disable()` —— 摘 provider / 摘插槽实现 / 摘贡献
   *    所需的四张表都在 infra 手里，`_context` 也在构造函数里存着，这是 infra 自己的事。
   * 3. 落盘 + 广播（APPS）：需要 storage 与 IPC 出口，由注入的 `onAutoDisable` 完成。
   *
   * ⚠ **这里刻意不把 `_states.enabled` 置 false** —— 那是 `disable()` 的收尾动作。
   * 若在这里先置 false，紧接着调用的 `disable()` 会在 `if (!st.enabled) return` 处短路，
   * 于是插件**带着 provider 与插槽实现继续跑**，而界面显示"已停用"：
   * 正是本项目最忌讳的那种"假生效"。状态必须由真正执行卸载的那一步来落。
   *
   * 同理，卸载**排队到微任务**而不是同步调用：`reportPluginError` 是在插件自己的调用栈里
   * 被调用的，同步 `disable()` 会把插件代码从它自己的栈下方抽走。
   *
   * @param {string} pluginId
   * @param {string} reason
   */
  autoDisable(pluginId: string, reason: string): void {
    const id = String(pluginId || '')
    if (!id) return
    /**
     * ⚠ **与 `setUserDisabled` 同一条守卫**：不可禁用的插件（core / nonDisableable）
     * 不许被停用 —— 无论停用请求来自用户还是系统。
     *
     * 这里是**第二道**（第一道在 `reportPluginError`）：`autoDisable` 是公开方法，
     * 除了连环坏判定，将来任何新入口都可能直接调它。守卫放在"真正改状态的那一步"，
     * 才不会因为多了一个调用点就漏防 —— 与 `setUserDisabled` 的写法刻意保持对称。
     */
    if (this.isNonDisableable(id)) {
      console.warn(`[plugin] 拒绝自动停用不可禁用的插件：${id}（它是某个功能的唯一出口，关掉就没有回头路）`)
      return
    }
    // 幂等：重复调用不应产生第二次卸载与第二次广播
    if (this._autoDisabled.has(id)) return
    this._autoDisabled.add(id)
    this._errorStamps.delete(id)
    this._invalidateBlocked()
    const st = this._states.get(id) || { installed: true, enabled: false }
    // 只记原因与"不是 failed"；`enabled` 留给 disable() 落 —— 见上方说明
    this._states.set(id, { ...st, failed: false, error: String(reason || '连续出错') })
    console.warn(`[plugin] 连续出错已自动停用：${id} — ${reason}`)
    // ② 卸载（infra）：排队一拍，让当前调用栈先返回
    Promise.resolve()
      .then(() => this.disable(id))
      .catch((e: unknown) => console.error(`[plugin] 自动停用卸载失败 ${id}:`, errorMessage(e)))
    // ③ 落盘 + 广播（APPS 注入）
    if (this._onAutoDisable) {
      try { this._onAutoDisable(id, String(reason || '连续出错')) } catch (e) {
        console.error('[plugin] onAutoDisable 回调失败：', errorMessage(e))
      }
    }
  }

  /**
   * ── 主动健康检查（PART7 §7.5 `lifecycle.healthCheck`）──────────────────
   *
   * 与 `onCrash` 是**互补的两条腿**，不是替代关系：
   *   · `onCrash`     被动：出错才计数。抓"调用了坏代码"。
   *   · `healthCheck` 主动：定时问"你还活着吗"。抓"没抛错但已经不能干活了"
   *     （它依赖的外部服务退了、它的连接断了、它进入了半死不活的状态）——
   *     那种情况**永远不会触发 onCrash**，因为没有异常可抛。
   *
   * 判定与后果复用同一条路：连续失败触顶 → `autoDisable()`（第 4 态）。
   * 于是"一键恢复""落盘""广播""面板对账"这些都已经有了，不需要第二套。
   *
   * 为什么由 **infra** 拥有计时器而不是 APPS：这件事的输入（manifest 的
   * `healthCheck` 配置、模块的 hook、失败计数）全在 infra 手里，APPS 要做得先
   * 把三样都问一遍再自己计数 —— 那才是真的耦合。APPS 只拿到既有的
   * `onAutoDisable` 回调，一行都不用改。
   */

  /** 给一个**已启用**的插件起健康检查（未声明配置、或模块没实现 hook → 不起表）。 */
  startHealthCheck(pluginId: string): void {
    this.stopHealthCheck(pluginId) // 热重载 / 重复启用时先清旧的，避免双计时器
    const id = String(pluginId || '')
    if (!id) return
    const m = this._manifests.find((x) => x.id === id)
    const cfg = m && m.healthCheck
    if (!cfg || !cfg.enabled) return
    const mod = this._modules.get(id)
    // 声明了检查却没写 hook → 视为永远健康：不起表，也不告警（"只声明不实现"是合法降级）。
    if (!mod || typeof mod.healthCheck !== 'function') return
    const state: PluginHealthRuntime = { failures: 0, timer: null, running: false }
    this._health.set(id, state)
    state.timer = setInterval(() => { this._runHealthTick(id) }, cfg.intervalMs)
    state.timer?.unref?.()
  }

  /** 停表并丢弃计数（停用 / 禁用 / 卸载 / 热重载都走它）。 */
  stopHealthCheck(pluginId: string): void {
    const id = String(pluginId || '')
    const state = this._health.get(id)
    if (!state) return
    if (state.timer) clearInterval(state.timer)
    this._health.delete(id)
  }

  /** 进程退出前的兜底：把所有健康检查的表停掉。 */
  stopAllHealthChecks(): void {
    for (const id of Array.from(this._health.keys())) this.stopHealthCheck(id)
  }

  /** 运行态快照（诊断 / 测试用）。 */
  getHealthCheckState(pluginId: string): { running: boolean; failures: number } | null {
    const s = this._health.get(String(pluginId || ''))
    return s ? { running: s.running, failures: s.failures } : null
  }

  /**
   * 跑一次健康检查（**单发、可外部调用** —— 诊断页 / 测试都用它，不必等定时器）。
   *
   * hook 契约：`healthCheck(ctx) => void | boolean | { ok, reason }`
   *   · 返回 `undefined` / `true`        → 健康
   *   · 返回 `false`                     → 不健康（原因用通用文案）
   *   · 返回 `{ ok: false, reason }`     → 不健康，带上可读原因（用户会看到它）
   *   · 抛错 / 超时                      → 不健康
   *
   * @returns {Promise<{ ok: boolean, reason?: string, skipped?: string }>}
   */
  async runHealthCheck(pluginId: string): Promise<PluginHealthResult> {
    const id = String(pluginId || '')
    const m = this._manifests.find((x) => x.id === id)
    if (!m || !m.healthCheck) return { ok: true, skipped: 'no-config' }
    const mod = this._modules.get(id)
    const st = this._states.get(id)
    if (!mod || typeof mod.healthCheck !== 'function') return { ok: true, skipped: 'no-impl' }
    if (!st || !st.enabled) return { ok: true, skipped: 'not-enabled' }
    try {
      const result = await withTimeout(
        Promise.resolve(mod.healthCheck(this._pluginContext(this._context, m))),
        m.healthCheck.timeoutMs
      )
      if (result === false) return { ok: false, reason: '健康检查返回 false' }
      if (result && typeof result === 'object' && 'ok' in result && result.ok === false) {
        return { ok: false, reason: String('reason' in result ? result.reason || '健康检查报告不健康' : '健康检查报告不健康') }
      }
      return { ok: true }
    } catch (e) {
      return { ok: false, reason: errorMessage(e) }
    }
  }

  async _runHealthTick(pluginId: string): Promise<void> {
    const state = this._health.get(pluginId)
    // 上一拍还没跑完 → 跳过这一拍，不排队。健康检查慢说明它本身有问题，
    // 堆一队只会让更多调用压上去。
    if (!state || state.running) return
    const m = this._manifests.find((x) => x.id === pluginId)
    const threshold = (m && m.healthCheck && m.healthCheck.failures) || 3
    state.running = true
    let res: PluginHealthResult
    try {
      res = await this.runHealthCheck(pluginId)
    } finally {
      state.running = false
    }
    // 期间被停用 / 禁用 / 热重载 → 表已换掉，这一拍的结果作废。
    const cur = this._health.get(pluginId)
    if (cur !== state) return
    if (res.ok !== false) {
      if (state.failures) console.log(`[plugin] 健康检查已恢复正常：${pluginId}`)
      state.failures = 0
      return
    }
    state.failures += 1
    console.warn(`[plugin] 健康检查未通过 ${pluginId}（${state.failures}/${threshold}）：${res.reason}`)
    if (state.failures >= threshold) {
      // 与 onCrash 触顶走**同一个出口** —— 第 4 态、可一键恢复。
      this.autoDisable(pluginId, `健康检查连续 ${threshold} 次未通过：${res.reason}`)
    }
  }

  private async _activateLoadedModule(
    pluginId: string,
    manifest: PluginManifest,
    mod: PluginModule,
    context: PluginRuntimeContext
  ): Promise<void> {
    const pluginContext = (): PluginExecutionContext => this._pluginContext(context, manifest)

    if (typeof mod.preEnable === 'function') await mod.preEnable(pluginContext())
    if (typeof mod.registerServices === 'function') {
      const services = await mod.registerServices(pluginContext())
      const serviceList = Array.isArray(services) ? Array.from(services) : services ? [services] : []
      for (const entry of serviceList as PluginServiceExportDefinition[]) {
        const service = entry && entry.service !== undefined ? entry.service : entry
        const name = entry && entry.name ? entry.name : `${pluginId}.service`
        this._providerRegistry.registerService(name, service, { ...entry, pluginId })
        this._serviceNames.set(pluginId, [...(this._serviceNames.get(pluginId) || []), name])
      }
    }
    if (typeof mod.registerProviders === 'function') {
      const providers = await mod.registerProviders(pluginContext())
      const providerList = Array.isArray(providers) ? providers as unknown as ProviderInput[] : []
      for (const provider of providerList) {
        const registered = this._providerRegistry.register({ ...provider, pluginId })
        const providerId = registered?.id || String(provider.id || '')
        if (providerId) this._providerDefinitions.set(providerId, pluginId)
      }
    }
    if (typeof this._providerRegistry.runLifecycleForPlugin === 'function') {
      await this._providerRegistry.runLifecycleForPlugin('install', pluginId, pluginContext())
    }
    if (typeof mod.registerExtensionPoints === 'function') {
      const eps = await mod.registerExtensionPoints(pluginContext())
      this.registerExtensionPoints(pluginId, Array.isArray(eps) ? Array.from(eps) as PluginServiceExportDefinition[] : [])
    }
    this._contributions.contributeFromManifest(pluginId, manifest.contributes)
    this.defineContributedExtensionPoints(pluginId, manifest.contributes)
    if (typeof mod.extensionPoints === 'function') {
      const epPlan = await mod.extensionPoints(pluginContext())
      if (epPlan) {
        for (const spec of Array.isArray(epPlan.provides) ? epPlan.provides : []) {
          this._slots.define(spec, { pluginId })
        }
        this._slots.implementAll(
          (epPlan.extends ?? []) as Array<{ to: string; impl: ExtensionImplementation; key?: string; order?: number }>,
          { pluginId }
        )
      }
    }
    if (typeof mod.injectStyles === 'function') {
      const styles = await mod.injectStyles(pluginContext())
      await this.injectStyles(pluginId, styles, context as { webContents?: PluginStyleHandle['webContents'] })
    }
    if (typeof mod.enable === 'function') await mod.enable(pluginContext())
    if (typeof this._providerRegistry.runLifecycleForPlugin === 'function') {
      await this._providerRegistry.runLifecycleForPlugin('enable', pluginId, pluginContext())
    }
    if (typeof mod.postEnable === 'function') await mod.postEnable(pluginContext())
  }

  private async _rollbackFailedActivation(
    pluginId: string,
    manifest: PluginManifest,
    context: PluginRuntimeContext,
    error: unknown
  ): Promise<void> {
    const st = this._states.get(pluginId) || { installed: false, enabled: false }
    this._states.set(pluginId, { ...st, enabled: true })
    try {
      await this.disable(pluginId, context)
    } catch (cleanupError) {
      console.warn(`[plugin] ${pluginId}: rollback after enable failure did not finish cleanly:`, errorMessage(cleanupError))
    }
    this._states.set(pluginId, { ...st, enabled: false, failed: true, error: errorMessage(error) })
  }

  async enable(pluginId: string, context?: PluginRuntimeContext): Promise<void> {
    context = context || this._context
    const m = this._manifests.find((x) => x.id === pluginId)
    if (!m) throw new Error(`Missing plugin: ${pluginId}`)
    const mod = await this._loadModule(m, context)
    let st = this._states.get(pluginId) || { installed: false, enabled: false }
    /**
     * 运行期才出现的插件（从文件 / 市场安装、AI 工作室现场生成、主题导入）没有走过
     * 启动期的 `installAll`，状态停在 `installed:false`。此时不能直接拒绝 ——
     * 否则「装完却永远开不起来」，且报错（Plugin not installed）与界面上「已安装」矛盾。
     * 补跑一次 install 生命周期（幂等），再照常走授权 / 前置 / enable 流程。
     */
    if (!st.installed) {
      await this._installOne(m, context)
      st = this._states.get(pluginId) || { installed: false, enabled: false }
    }
    if (!st.installed) throw new Error(`Plugin not installed: ${pluginId}`)
    if (st.enabled) return

    /**
     * 授权闸门（PART7 §7.5）：非第一方且声明了权限、又还没被授权 → 停在待授权态。
     *
     * 放在**最前面**（先于前置闸门）：一个还在等用户点头的插件，连它的前置都不该被
     * 拉起来 —— 否则用户"拒绝授权"之后，会留下一串被他拒绝的插件的依赖被启用过。
     */
    if (this._needsConsent(m)) {
      this.markAwaitingConsent(pluginId, m.requestedPermissions)
      return
    }

    /**
     * 前置闸门（§10.3 point 2）：硬依赖里有任何一个没启用 → 记 `blocked` 并**安静返回**。
     *
     * 为什么不是 `throw`：抛错会被 `enableAll` / IPC 归到 `failed`（"这个插件自己坏了"），
     * 而事实是它**一行代码都没跑**、根因在上游。第 5 态存在的全部意义就是这个区分。
     *
     * 放在 `preEnable` **之前**：都不打算启用它，就不该去执行它任何一段代码。
     */
    const unsatisfied = this._unsatisfiedDeps(m)
    if (unsatisfied.length) {
      this.markBlocked(pluginId, unsatisfied)
      return
    }

    try {
      await this._activateLoadedModule(pluginId, m, mod, context)
    } catch (error) {
      await this._rollbackFailedActivation(pluginId, m, context, error)
      throw error
    }
    // 成功即清掉失败与"自动停用"的痕迹（失败自愈 / 用户一键恢复的收尾）。
    // 注意**不清** userDisabled —— 那是用户意图，只能由用户操作清除。
    this._autoDisabled.delete(pluginId)
    this._errorStamps.delete(pluginId)
    this._invalidateBlocked()
    // `blocked` / `awaitingConsent` 一并清掉：启用成功即证明前置已就绪、授权也已到手，
    // 这两种"没在跑"的痕迹都不该留到下一次。
    this._states.set(pluginId, {
      ...st, enabled: true, failed: false, blocked: false, blockedBy: [], awaitingConsent: false, error: null
    })
    // 启用成功 → 若声明了主动健康检查就起表（未声明则是空操作，默认行为不变）。
    this.startHealthCheck(pluginId)
  }

  /**
   * 卸载一个已启用的插件（摘 provider / 插槽实现 / 声明式贡献 / 样式）。
   *
   * 两个调用方：用户手动禁用（IPC）与 **自动停用**（`autoDisable` 排队调用）。
   * 后者刻意**不**预先改 `_states.enabled`，就是为了让这里不被 `if (!st.enabled) return`
   * 短路 —— 详见 `autoDisable` 的说明。`enabled: false` 由本方法在收尾时落。
   *
   * @param {string} pluginId
   * @param {object} [context] 缺省复用 enableAll 记下的运行上下文（运行期热禁用靠它）
   */
  async disable(pluginId: string, context?: PluginRuntimeContext): Promise<void> {
    context = context || this._context
    const m = this._manifests.find((x) => x.id === pluginId)
    if (!m) throw new Error(`Missing plugin: ${pluginId}`)
    const st = this._states.get(pluginId) || { installed: false, enabled: false }
    if (!st.enabled) {
      await this._flushPluginCleanups(pluginId, 'activation')
      return
    }

    let mod: PluginModule | null = null
    try { mod = await this._loadModule(m, context) } catch (_) {}
    const errors: unknown[] = []
    const attempt = async (action: () => unknown): Promise<void> => {
      try {
        await action()
      } catch (error) {
        errors.push(error)
      }
    }

    if (mod && typeof mod.preDisable === 'function') {
      await attempt(() => mod?.preDisable?.(this._pluginContext(context, m)))
    }
    if (mod && typeof mod.disable === 'function') {
      await attempt(() => mod?.disable?.(this._pluginContext(context, m)))
    }
    if (typeof this._providerRegistry.runLifecycleForPlugin === 'function') {
      await attempt(() => this._providerRegistry.runLifecycleForPlugin('disable', pluginId, this._pluginContext(context, m)))
    }
    if (mod && typeof mod.unregisterEPs === 'function') {
      await attempt(() => mod?.unregisterEPs?.(this._pluginContext(context, m)))
    }
    await attempt(() => this.unregisterExtensionPoints(pluginId))
    this._contributions.clearPlugin(pluginId)
    this._slots.removeImplementations(pluginId)
    for (const provider of this._providerRegistry.list()) {
      if (provider.pluginId === pluginId) await attempt(() => this._providerRegistry.unregister(provider.id))
    }
    await attempt(() => this.removeStyles(pluginId))
    this.stopHealthCheck(pluginId)
    await this._flushPluginCleanups(pluginId, 'activation')
    this._states.set(pluginId, { ...st, enabled: false })
    if (errors.length) throw errors[0]
  }

  async uninstall(pluginId: string, context?: PluginRuntimeContext): Promise<void> {
    context = context || this._context
    const errors: unknown[] = []
    try {
      await this.disable(pluginId, context)
    } catch (error) {
      errors.push(error)
    }
    const m = this._manifests.find((x) => x.id === pluginId)
    if (!m) throw new Error(`Missing plugin: ${pluginId}`)
    let mod: PluginModule | null = null
    try { mod = await this._loadModule(m, context) } catch (_) {}
    const st = this._states.get(pluginId) || { installed: false, enabled: false }
    if (mod && typeof mod.uninstall === 'function') {
      try {
        await mod.uninstall(this._pluginContext(context, m))
      } catch (error) {
        errors.push(error)
      }
    }
    if (typeof this._providerRegistry.runLifecycleForPlugin === 'function') {
      try {
        await this._providerRegistry.runLifecycleForPlugin('uninstall', pluginId, this._pluginContext(context, m))
      } catch (error) {
        errors.push(error)
      }
    }
    await this._flushPluginCleanups(pluginId, 'activation')
    await this._flushPluginCleanups(pluginId, 'uninstall')
    this._contributions.clearPlugin(pluginId)
    this._slots.removeImplementations(pluginId)
    this.unregisterExtensionPoints(pluginId)
    this.stopHealthCheck(pluginId)
    this._capabilityCache.delete(pluginId)
    this._modules.delete(pluginId)
    this._loadErrors.delete(pluginId)
    this._forgetRequireCache(m)
    this._states.set(pluginId, { ...st, installed: false, enabled: false })
    if (errors.length) throw errors[0]
  }

  /**
   * **热重载**：重读 manifest + 重新编译模块代码，原本在跑的重新跑起来。
   *
   * 为什么需要它：开发插件时改一行代码就要重启整个浏览器，是这个系统最大的开发体验缺口。
   * `onCrash`（被动兜底）与 `healthCheck`（主动探测）都只解决"坏了怎么办"，
   * 没有一个能解决"我改了代码想立刻看到效果"。
   *
   * 顺序上**先停干净再换代码**，不是反过来：
   *   · 旧实现的 provider / 插槽实现 / 贡献 / 样式必须先摘掉（`disable()` 的全部职责），
   *     否则新旧两份会同时在册 —— 表现为"改了代码但行为没变"（其实是旧的还在前面挡着）；
   *   · 健康检查必须停表（同上，且它可能正持有旧闭包）。
   *
   * 失败语义：**新代码加载不了就抛给调用方**（UI 显示原因），插件保持停用状态 ——
   * 悄悄退回旧版本更糟：作者会以为"我的改动生效了"，然后调半天为什么没效果。
   * 唯一的例外是 manifest 解析失败（多半是正在编辑中）：此时退回内存里的旧 manifest 继续，
   * 并在日志里说清楚。
   *
   * ⚠ 已知边界：只清**入口文件**的 `require.cache`。第一方插件入口自己 require 的
   * 兄弟文件仍是旧代码 —— 那种形态在本仓库不存在（插件都是单文件 .cjs）。
   * 第三方插件走沙箱路径（每次重读源码），不受此限。
   *
   * @param {string} pluginId
   * @param {object} [context]
   * @returns {Promise<{ ok: boolean, id: string, enabled: boolean }>}
   */
  async reload(pluginId: string, context?: PluginRuntimeContext): Promise<PluginLoadResult> {
    context = context || this._context
    const id = String(pluginId || '')
    const oldM = this._manifests.find((x) => x.id === id)
    if (!oldM) throw new Error(`Missing plugin: ${id}`)
    const wasEnabled = !!(this._states.get(id) || {}).enabled

    // ① 停干净（摘 provider / 插槽实现 / 贡献 / 样式 / 健康检查表）
    if (wasEnabled) await this.disable(id, context)
    else this.stopHealthCheck(id)

    // ② 丢弃模块缓存与失败缓存，否则 require 会命中旧实现 / 重载被"上次失败"直接拒绝
    this._modules.delete(id)
    this._loadErrors.delete(id)
    this._forgetRequireCache(oldM)

    // ③ 重读 manifest（作者可能同期一起改了它）
    if (oldM.originPath && fs.existsSync(oldM.originPath)) {
      let fresh = null
      try {
        fresh = normalizeManifest(readJsonFile(oldM.originPath), oldM.originPath, {
          defaultTrustLevel: oldM.isFirstParty ? 'internal' : 'community',
          allowFirstParty: oldM.isFirstParty
        })
      } catch (_) { fresh = null }
      if (fresh) {
        const idx = this._manifests.findIndex((x) => x.id === id)
        if (idx >= 0) this._manifests[idx] = fresh
        this._invalidateBlocked()
      } else {
        console.warn(`[plugin] 重载时 manifest 解析失败（可能正在编辑），继续使用内存里的旧版本：${id}`)
      }
    }

    // ④ 重新编译模块。失败即抛出，插件停在停用态（见上方"失败语义"）
    const m = this._manifests.find((x) => x.id === id)
    if (!m) throw new Error(`Missing plugin after reload: ${id}`)
    try {
      await this._loadModule(m, context)
    } catch (e) {
      throw new Error(`重载失败（模块无法加载）：${errorMessage(e)}`)
    }

    // ⑤ 原本在跑就重启它
    if (wasEnabled) await this.enable(id, context)
    return { ok: true, id, enabled: wasEnabled }
  }

  /** 第一方插件入口的 require 缓存（第三方本来就每次重读源码，无需处理）。 */
  _forgetRequireCache(m: PluginManifest): void {
    if (!m || !m.isFirstParty || !m.main || !m.originPath) return
    try {
      delete nodeRequire.cache[nodeRequire.resolve(path.resolve(path.dirname(m.originPath), m.main))]
    } catch (_) {}
  }

  getExtensionPoints(): Record<string, Array<PluginServiceExport & { pluginId: string }>> {
    const out: Record<string, Array<PluginServiceExport & { pluginId: string }>> = {}
    for (const [k, v] of this._extensionPoints.entries()) out[k] = v.slice()
    return out
  }

  getExtensionPoint(name: string): Array<PluginServiceExport & { pluginId: string }> {
    return (this._extensionPoints.get(String(name)) || []).slice()
  }

  getState(pluginId: string): PluginRuntimeState | null {
    return this._states.get(pluginId) || null
  }

  /**
   * 插件中心用：manifest + 运行态的只读快照。
   *
   * 只输出纯数据（字符串/数组/布尔）：任何函数或 Electron 手柄都不能过 IPC 结构化克隆，
   * 因此这里是唯一出口 —— 插件中心不直接读 _manifests / _states 两个私有表。
   */
  describe(): PluginDescriptor[] {
    /**
     * **反向依赖索引**（谁依赖我）—— §10.2「体现」的数据面。
     *
     * 为什么在注册中心算而不是让插件中心自己扫：`dependsOn` 是 manifest 的事实，
     * 反向关系只是它的转置。让 UI 拿 25 份 manifest 自己建图，等于把"关系语义"
     * 复制到展示层 —— 一旦将来加软依赖/冲突关系，展示层必然漏改一处。
     * 这里一次算清，UI 只做渲染。
     *
     * 注意：**列出全部依赖方（含已禁用的）**，不只是"当前启用"的 ——
     * §10.2 要的是"禁用前先让人看见连带范围"，而且已禁用的依赖方同样会被波及
     * （用户重新启用它时前置必须还在）。"启用与否"由 UI 用 `enabled` 字段自行呈现。
     */
    const requiredBy = new Map<string, string[]>()
    const optionalRequiredBy = new Map<string, string[]>()
    const push = (map: Map<string, string[]>, key: string, value: string): void => {
      if (!map.has(key)) map.set(key, [])
      const entries = map.get(key)
      if (entries) entries.push(value)
    }
    for (const m of this._manifests) {
      for (const depId of m.dependsOn) push(requiredBy, depId, m.id)
      for (const depId of m.optionalDependsOn || []) push(optionalRequiredBy, depId, m.id)
    }

    return this._manifests.map((m) => {
      const st = this._states.get(m.id) || { installed: false, enabled: false }
      return {
        id: m.id,
        version: m.version,
        name: m.name || m.id,
        description: m.description || '',
        type: m.type || 'feature-plugin',
        trustLevel: m.trustLevel || 'internal',
        main: m.main || null,
        // 渲染进程入口（相对 plugins 目录的路径）。渲染层靠它加载插件自带的 UI 代码，
        // 是实现「插件声明面板 → 插件提供面板实现」闭环的关键字段。
        render: m.render || null,
        /**
         * 渲染入口的版本号（= 文件 mtime）。渲染层把它拼进 `hira-plugin://…?v=` 的 URL，
         * 于是"作者改了渲染代码"必定重新加载（见 normalizeManifest 里的说明）。
         * 第一方插件的渲染模块走构建期打包，这里是 null 也无妨。
         */
        renderVersion: m.renderVersion ?? null,
        // 顶层 UI 文档声明（没有 render 时，面板靠它渲染；面板项可继承）。
        uiEntry: m.uiEntry || null,
        /**
         * manifest 的纯数据贡献（`contributes`）。
         *
         * 渲染进程靠它**提前判定**要不要 import 这个插件的渲染模块 ——
         * `panels` 决定"是不是面板插件"、`rendererSlots` 决定"贡献了哪些渲染侧插槽"。
         * 没有这份声明就只能"先全量 import 再丢弃"（浮层窗口会白拉整块面板代码，
         * 还会误报"插槽无人宿主"，见 renderer/shared/plugin-slots.js）。
         */
        contributes: (m.contributes && typeof m.contributes === 'object') ? m.contributes : {},
        /** 是否来自**用户目录**（运行时安装的第三方插件），UI 据此分组与提示。 */
        runtime: !!(this._pluginUserDir && m.originPath && isWithinDirectory(this._pluginUserDir, m.originPath)),
        capabilities: m.capabilities.slice(),
        // 正向关系：我依赖谁（hard = 缺了就是配置错误；soft = 存在就用，见 §10.2）
        dependsOn: m.dependsOn.slice(),
        optionalDependsOn: (m.optionalDependsOn || []).slice(),
        // 反向关系：谁依赖我 —— 禁用前必须先看见的就是这一栏
        requiredBy: (requiredBy.get(m.id) || []).slice(),
        optionalRequiredBy: (optionalRequiredBy.get(m.id) || []).slice(),
        conflictsWith: m.conflictsWith.slice(),
        installed: !!st.installed,
        enabled: !!st.enabled,
        // 三态的两条附加信息（见 _userDisabled / markFailed 的说明）：
        //   userDisabled: 用户主动关的（会持久化）
        //   failed:       启用时抛错了（不持久化，下次启动自动重试）
        /**
         * 第 5 态 `blocked`（§10.3 point 2）：硬前置没启用 → 它连代码都没跑过。
         * 与 `failed`（它自己抛错了）是**两个不同的根因位置**，UI 文案也不同。
         * `blockedBy` 带上具体是哪几个前置，UI 才能说清"先把它打开"。
         */
        blocked: !!st.blocked,
        blockedBy: (st.blockedBy || []).slice(),
        /**
         * 第 6 态 `awaitingConsent`（PART7 §7.5 授权）：非第一方、声明了权限、尚未被授权。
         * 与 `blocked` 的区别：blocked 是"上游没起来"（不可控），这里是"等用户点头"（一步之遥）。
         */
        awaitingConsent: !!st.awaitingConsent,
        // 权限声明与授权结果 —— 插件中心要显示"它想要什么 / 你给过什么"
        requestedPermissions: (m.requestedPermissions || []).slice(),
        grantedPermissions: (this._grantedPermissions.get(m.id) || []).slice(),
        // 给用户看的中文名（翻译表跟着 scope 的权威定义走，见 plugin-sandbox.js）。
        // 只下发这个插件**申请到的那些**，不把整张表塞给每个插件。
        requestedPermissionLabels: Object.fromEntries(
          (m.requestedPermissions || []).map((scope) => [scope, SCOPE_LABELS[scope as keyof typeof SCOPE_LABELS] || scope])
        ) as Record<string, string>,
        permissionLevel: m.permissionLevel || (m.isFirstParty ? 'full' : 'ui'),
        isFirstParty: !!m.isFirstParty,
        // 主动健康检查（PART7 §7.5）：配置 + 当前连续失败次数。
        // `failures > 0` 是插件中心要显示"它现在不太对"的唯一依据 ——
        // 触顶之前用户就该看得见，而不是等被停用了才发现。
        healthCheck: m.healthCheck ? { ...m.healthCheck } : null,
        healthCheckFailures: (this._health.get(m.id) || {}).failures || 0,
        /**
         * 是否不可禁用（core 或显式 nonDisableable）—— 见 `isNonDisableable`。
         * UI 靠它锁住开关：没有这个字段的话，UI 只能自己拼"core || nonDisableable"
         * 那条判定，而它是**会演进**的（将来可能再加第三类）→ 必然漏改一处。
         */
        nonDisableable: this.isNonDisableable(m.id),
        userDisabled: this._userDisabled.has(m.id),
        autoDisabled: this._autoDisabled.has(m.id),
        failed: !!st.failed,
        error: st.error ? String(st.error) : null
      }
    })
  }

  getProviderRegistry(): ProviderRegistry {
    return this._providerRegistry
  }

  /**
   * 取某个插件的**文件根目录**（manifest 所在目录）—— 特权协议 `hira-plugin://`
   * 靠它把 `<id>/<相对路径>` 映射到真实文件。
   *
   * ⚠ 只对**当前已启用**的插件返回路径。这是安全边界，不是优化：
   * 禁用插件后，它之前发出去的 URL 必须立刻失效 —— 否则"已经禁用的插件仍在往
   * 页面里注入代码"，而那正是"禁用看起来生效了、实际没生效"的另一种形态。
   *
   * @param {string} pluginId
   * @returns {string|null}
   */
  getPluginRoot(pluginId: string): string | null {
    // 大小写不敏感：`hira-plugin://` 是 standard scheme，Chromium 会把 host 小写化 ——
    // 若某个插件 id 里带了大写，精确匹配会在协议层神秘地"找不到插件"。
    const id = String(pluginId || '').toLowerCase()
    const m = this._manifests.find((x) => String(x.id).toLowerCase() === id)
    if (!m || !m.originPath) return null
    const st = this._states.get(m.id)
    if (!st || st.enabled !== true) return null
    return path.dirname(m.originPath)
  }

  /**
   * 声明式贡献注册表出口。
   * 消费方（APPS 的面板目录等）通过它按 kind 取贡献；外部注入的实例与这里返回的是同一个，
   * 因此在插件启用前就能被 IPC 读到。
   */
  getContributions(): ContributionRegistry {
    return this._contributions
  }

  /**
   * 插槽调度器出口（PART7 §7.3「扩展点 = 插槽」）。
   * 宿主（infra-theme / 搜索聚合 / 侧栏…）拿到它来「点名执行」自己的插槽；
   * 外部注入的实例与此返回的是同一个，所以在插件启用前就能被宿主持有。
   *
   * ⚠ 为什么不叫 `getExtensionPoints()`：那个名字**已经被占用**（见上方同名方法），
   * 它返回的是**服务出口表**（`{ name, service }`，供 provider 解析），
   * 没有执行模式、不是文档所说的插槽。两个概念同名会直接引发误用 ——
   * 曾经差点让「按插件名取服务」的代码拿到一个模式调度器。
   */
  getSlotRegistry(): ExtensionPointRegistry {
    return this._slots
  }

  /** 语义化别名：明确「getExtensionPoints 返回的是服务出口表」。 */
  getServiceExports(): Record<string, Array<PluginServiceExport & { pluginId: string }>> {
    return this.getExtensionPoints()
  }

  /**
   * manifest `contributes.extensionPoints` → 插槽声明（纯数据，不需要入口代码）。
   * 与 `contributes.panels` 同一套路：能声明的事就别逼插件写代码。
   * @returns {number} 声明条数
   */
  defineContributedExtensionPoints(pluginId: string, contributes: UnknownRecord): number {
    const list = contributes && contributes.extensionPoints
    if (!Array.isArray(list)) return 0
    let count = 0
    for (const spec of list) {
      if (!spec || !spec.id) continue
      this._slots.define(spec, { pluginId })
      count += 1
    }
    return count
  }
}

