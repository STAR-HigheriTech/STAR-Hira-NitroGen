/**
 * 插件开关状态的持久化（PART7 §7.4「插件启用状态」。本文件是**唯一**的落盘点）。
 *
 * ══════════════════════════════════════════════════════════════════════
 * 只持久化一件事：**用户主动禁用**
 * ══════════════════════════════════════════════════════════════════════
 * 启用失败（`failed`）**绝不落盘**：
 *   · 落盘 → 一次偶发失败被记成"已禁用" → 之后每次启动都坏，而用户从没关过它；
 *   · 不落盘 → 下次启动自动重试，即"失败自愈"。
 * 这是本文件唯一重要的设计约束。
 *
 * ══════════════════════════════════════════════════════════════════════
 * 为什么复用 settings 的 KV 而不是新建存储
 * ══════════════════════════════════════════════════════════════════════
 * 项目里已有先例（外部协议授权记录同样复用 settingsService 的 KV、独立前缀，
 * 见 main.js 的 openExternal 授权注释）。复用带来的：防抖写盘、原子写、
 * 多进程去回声、以及**未来**要按 profile 隔离时不需要换介质（只换作用域）。
 *
 * 该键**不在** settingsRegistry 的 schema 里 —— 设置页只渲染 schema 声明的项，
 * 所以它不会作为一个"设置项"冒到用户面前；插件中心才是它的界面。
 *
 * ══════════════════════════════════════════════════════════════════════
 * 为什么把读写都钉在 `default` 作用域
 * ══════════════════════════════════════════════════════════════════════
 * ⚠ L2（PART16 §3.2 / §5 步骤 6）已把这件事**上升为机制**：`plugins.` 前缀的键被
 * `@hira-ng/shared-types/src/settings-scope.mjs` 归为**全局键**，由 settings 路由层
 * 直接落到 `userData/settings.global.json` —— 与「当前是哪个 profile」彻底无关。
 * 因此本文件的"钉 default"只是**历史兜底**（在全局路由未接入时也保证读写同一份）；
 * 真正的归属由那份白名单说了算，不必在此重复判断。
 *
 * 历史原因（保留，说明为什么当初必须钉）：main 侧的 settingsService 是**按 profile
 * 覆盖**的（`createProfileSettingsOverlay`）。如果不钉作用域，会出现一种极隐蔽的
 * 半隔离：启动时 enableAll 在无 IPC 上下文里跑 → 读的是 default 的覆盖；
 * 而"从某个非 default 窗口的插件中心点禁用" → 写进那个 profile 的覆盖。
 * 结果是"读的和写的不是同一份"，且只在多 profile 下暴露。
 *
 * 这是**最终形态，不是权宜之计** —— 已决定不做 profile 隔离，原因是隔离的单位选错了：
 * 隔离的最小单位是「能力面」而不是「插件」，而插件是能力的打包单位。
 * 一个插件里常常既有该隔离的部分（面板、主题），又有结构上无法隔离的部分：
 *   · 进程级单例资源（全局快捷键、托盘、外置资源目录）—— 关掉即对所有人关掉，没有"对某个
 *     profile 关掉"这个状态；
 *   · 设施 / 前置（settings-service、side-panel-skeleton）—— 关掉会连锁废掉一片；
 *   · 自指（profile-service）—— 它就是定义 profile 的东西，不能由 profile 决定它开不开。
 * 按插件一刀切做隔离必然误伤。判定标准与完整说明见 docs-ng/插件化落地现状与扩展指南.md §8.3。
 */

/** 存储键：section `plugins`（与 settingsRegistry 的 `app`/`ui` 等展示型 section 无冲突）。 */
export const PLUGIN_DISABLED_KEY = 'plugins.disabled'
/**
 * **「出厂默认关闭」已播种过哪些插件** —— 字符串数组，只由 `plugin-bootstrap` 的
 * 播种那一步读写。
 *
 * 为什么必须有这个标记（它与 `plugins.disabled` 是两件事）：
 *   播种做的是"把声明了 `defaultDisabled` 的插件塞进 disabled 列表"。但如果只塞、
 *   不记账，**用户手动把它打开之后，下次启动又会被关回去** —— 因为播种判据
 *   "它不在 disabled 列表里"与用户的操作结果长得一模一样，无法区分：
 *     · 从没播种过（该关）
 *     · 用户主动打开过（不该关）
 *   标记把这两件事分开：**只要 id 记在标记里，就永远不再播种**，
 *   之后完全听用户的。这是本机制唯一的关键点。
 */
const PLUGIN_DEFAULTS_SEEDED_KEY = 'plugins.defaultsSeeded'
/**
 * 第 4 态（自动停用）的键 —— **与用户禁用分开存**。
 *
 * 为什么不合并成一个 `{ id: 'user' | 'auto' }` 映射：
 *   · 两套语义的生命周期不同 —— 用户禁用只能由用户解除；自动停用允许"用户点一下恢复"。
 *   · 分开存 = 老用户已有的 `plugins.disabled` 数组**不需要迁移**，读写路径也不必解析两种形态。
 * 两个集合在 `enableAll` 里的作用相同（都跳过），所以分开存不会造成行为分叉。
 */
const PLUGIN_AUTO_DISABLED_KEY = 'plugins.autoDisabled'
/**
 * 第三方插件的**权限授权**结果（PART7 §7.5）—— `{ [pluginId]: string[] }`。
 *
 * 与上面两条键的形态不同（映射而非数组），因为授权天然是"每个插件一份清单"。
 * 放在同一个存储里、同一套读写/防抖/原子写；不落盘的话每次重启都会把用户
 * 已经同意的第三方插件全打回"等待授权"，用户会以为授权根本没生效。
 */
const PLUGIN_GRANTED_PERMISSIONS_KEY = 'plugins.grantedPermissions'
/**
 * **插件源地址列表**（社区市场的索引 URL）—— 字符串数组，空数组 = 不启用。
 *
 * 为什么是数组而不是单个：真实的插件生态不会只有一个源（官方源 + 作者自建源 +
 * 内网源），而"每次只能填一个"会让用户每换一次源就得把上一个抄下来。
 * **顺序即优先级**：同一个 id 在多个源里出现时，靠前的那个胜出（见 plugin-market.js）。
 *
 * 为什么它和上面三条存在同一个 store 里：它们的读写口径完全一样
 * （同一个 settings KV、同一个防抖/原子写、同样钉在 default 作用域）——
 * 换介质或换作用域时只改这一处。**但它是"用户配置"而不是"插件状态"**，
 * 所以单独一个键、不参与任何状态同步逻辑。
 */
const PLUGIN_MARKET_SOURCES_KEY = 'plugins.marketSources'
/**
 * 旧版**单源**键（一个字符串）。只读不写 —— 见 `loadMarketSources` 的兼容逻辑。
 * 保留它是因为"升级之后用户的源凭空消失"是最容易招骂的一类回归。
 */
const PLUGIN_MARKET_SOURCE_KEY_LEGACY = 'plugins.marketSource'
/**
 * **被单独关掉的用户脚本**（`<pluginId>/<scriptId>` 字符串数组）。
 *
 * 为什么按「脚本」而不是按「插件」：
 *   一个用户脚本就是一个插件（`type: "userscript-plugin"`），但 AI 工作室生成的
 *   插件里也可能一次贡献多条 `contributes.userscripts`。粒度必须是**脚本**，
 *   否则"关掉一条"会把同一插件里的另一条一起关掉。
 *
 * 与 `plugins.disabled` 的关系：插件被禁用时脚本压根不会被读到（`getPluginRoot`
 * 返回 null），本键只表达"插件是开着的，但我不要这条脚本跑"。
 */
const PLUGIN_USERSCRIPTS_DISABLED_KEY = 'plugins.userscripts.disabled'

/**
 * 归一化源列表：去非字符串 / 去空白 / 去重（保持顺序）。
 * 纯函数，放在模块级 —— 它与存储介质无关，单独可测。
 * @param {unknown} raw
 * @returns {string[]}
 */
export function normalizeSources (raw: unknown): string[] {
  if (!Array.isArray(raw)) return []
  const seen = new Set<string>()
  const out: string[] = []
  for (const item of raw) {
    if (typeof item !== 'string') continue
    const url = item.trim()
    if (!url || seen.has(url)) continue
    seen.add(url)
    out.push(url)
  }
  return out
}

/**
 * @param {{
 *   getSettingsService: () => unknown,
 *   runAsProfile?: (profileId: string, fn: () => unknown) => unknown,
 *   logger?: { warn?: Function, error?: Function }
 * }} options
 */
export interface PluginSettingsPort {
  get(key: string): unknown
  set?(key: string, value: unknown): unknown
}

export interface PluginStateStoreOptions {
  getSettingsService(): PluginSettingsPort | null | undefined
  runAsProfile?<T>(profileId: string, task: () => T): T
  logger?: { warn?(...args: unknown[]): void; error?(...args: unknown[]): void }
}

export interface PluginStateStore {
  readIds(key: string): string[]
  writeIds(key: string, ids: readonly unknown[]): boolean
  loadDisabled(): string[]
  saveDisabled(ids: readonly string[]): boolean
  setDisabled(pluginId: unknown, disabled: boolean): string[] | null
  loadAutoDisabled(): string[]
  setAutoDisabled(pluginId: unknown, disabled: boolean): string[] | null
  loadDisabledUserScripts(): string[]
  setUserScriptDisabled(key: unknown, disabled: boolean): string[] | null
  loadDefaultsSeeded(): string[]
  saveDefaultsSeeded(ids: readonly string[]): boolean
  loadGrantedPermissions(): Record<string, string[]>
  setGrantedPermissions(pluginId: unknown, scopes: readonly unknown[]): Record<string, string[]> | null
  loadMarketSources(): string[]
  saveMarketSources(sources: unknown): string[] | null
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

export function createPluginStateStore (options: PluginStateStoreOptions): PluginStateStore {
  const logger = options.logger || console
  const getSettingsService = options.getSettingsService
  const runAsProfile = options.runAsProfile

  /** 把一次读写钉在全局（default）作用域 —— 见文件头说明。 */
  function inGlobalScope <T>(fn: () => T): T {
    if (typeof runAsProfile === 'function') return runAsProfile('default', fn)
    return fn()
  }

  function service (): PluginSettingsPort | null {
    const svc = typeof getSettingsService === 'function' ? getSettingsService() : null
    // settingsService 在启动早期可能还没建好 —— 此时按"没有任何禁用"处理，
    // 绝不让"读不到状态"变成"全部插件都别启用"。
    return svc && typeof svc.get === 'function' ? svc : null
  }

  return {
    /**
     * 读回某个键的字符串数组（内部复用；任何异常与非法值一律回落空数组）。
     * @param {string} key
     * @returns {string[]}
     */
    readIds (key: string): string[] {
      try {
        return inGlobalScope(() => {
          const svc = service()
          if (!svc) return []
          const raw = svc.get(key)
          if (!Array.isArray(raw)) return []
          return raw.filter((id) => typeof id === 'string' && id).map(String)
        })
      } catch (e) {
        logger.warn?.(`[plugin-state] 读取 ${key} 失败（按空处理）：`, errorMessage(e))
        return []
      }
    },

    /**
     * 写入某个键的字符串数组（去重）。
     * @param {string} key
     * @param {string[]} ids
     * @returns {boolean}
     */
    writeIds (key: string, ids: readonly unknown[]): boolean {
      const list = Array.isArray(ids) ? Array.from(new Set(ids.filter((id) => typeof id === 'string' && id))) : []
      try {
        return inGlobalScope(() => {
          const svc = service()
          if (!svc || typeof svc.set !== 'function') return false
          svc.set(key, list)
          return true
        })
      } catch (e) {
        logger.warn?.(`[plugin-state] 写入 ${key} 失败：`, errorMessage(e))
        return false
      }
    },

    /**
     * 读回用户禁用的插件 id 列表。
     * 任何异常（服务未就绪 / 值被改坏）一律回落空数组 —— 插件系统必须能启动。
     * @returns {string[]}
     */
    loadDisabled () : string[] {
      return this.readIds(PLUGIN_DISABLED_KEY)
    },

    /**
     * 写入完整的禁用列表。
     * @param {string[]} ids
     * @returns {boolean} 是否写入成功
     */
    saveDisabled (ids: readonly string[]): boolean {
      return this.writeIds(PLUGIN_DISABLED_KEY, ids)
    },

    /**
     * 变更单个插件的禁用状态（读-改-写）。
     * @param {string} pluginId
     * @param {boolean} disabled
     * @returns {string[]|null} 写入后的完整列表；失败返回 null
     */
    setDisabled (pluginId: unknown, disabled: boolean): string[] | null {
      const id = String(pluginId || '')
      if (!id) return null
      const current = this.loadDisabled()
      const next = disabled
        ? Array.from(new Set([...current, id]))
        : current.filter((x) => x !== id)
      return this.saveDisabled(next) ? next : null
    },

    /** 读回「自动停用」的插件 id 列表（第 4 态）。 */
    loadAutoDisabled () {
      return this.readIds(PLUGIN_AUTO_DISABLED_KEY)
    },
    /**
     * 变更单个插件的「自动停用」状态。
     * 用户点开关重新启用时传 false —— 这就是"一键恢复"。
     * @param {string} pluginId
     * @param {boolean} disabled
     * @returns {string[]|null}
     */
    setAutoDisabled (pluginId: unknown, disabled: boolean): string[] | null {
      const id = String(pluginId || '')
      if (!id) return null
      const current = this.loadAutoDisabled()
      const next = disabled
        ? Array.from(new Set([...current, id]))
        : current.filter((x) => x !== id)
      return this.writeIds(PLUGIN_AUTO_DISABLED_KEY, next) ? next : null
    },

    /**
     * 读回「被单独关掉的用户脚本」键列表（`<pluginId>/<scriptId>`）。
     * @returns {string[]}
     */
    loadDisabledUserScripts () : string[] {
      return this.readIds(PLUGIN_USERSCRIPTS_DISABLED_KEY)
    },

    /**
     * 变更单条用户脚本的启停（读-改-写）。
     *
     * 键的形状由插件表面层（`plugin-surfaces.js#userScriptKey`）决定 ——
     * 这里只当**不透明字符串**处理：存储层不该知道"插件 id 和脚本 id 怎么拼"。
     *
     * @param {string} key
     * @param {boolean} disabled
     * @returns {string[]|null} 写入后的完整列表；失败返回 null
     */
    setUserScriptDisabled (key: unknown, disabled: boolean): string[] | null {
      const id = String(key || '').trim()
      if (!id) return null
      const current = this.loadDisabledUserScripts()
      const next = disabled
        ? Array.from(new Set([...current, id]))
        : current.filter((x) => x !== id)
      return this.writeIds(PLUGIN_USERSCRIPTS_DISABLED_KEY, next) ? next : null
    },

    /**
     * 读回「出厂默认关闭」**已播种过**的插件 id（见 PLUGIN_DEFAULTS_SEEDED_KEY）。
     * 空数组 = 一次都还没播种过（新装，或从老版本升级上来的第一次启动）。
     * @returns {string[]}
     */
    loadDefaultsSeeded () : string[] {
      return this.readIds(PLUGIN_DEFAULTS_SEEDED_KEY)
    },

    /**
     * 写入已播种集合（整体覆盖）。播种是**一次性**的，所以这里按整表写而不是逐个追加。
     * @param {string[]} ids
     * @returns {boolean}
     */
    saveDefaultsSeeded (ids: readonly string[]): boolean {
      return this.writeIds(PLUGIN_DEFAULTS_SEEDED_KEY, ids)
    },

    /**
     * 读回「第三方插件权限授权」映射（`{ [pluginId]: string[] }`）。
     * 任何异常 / 值被改坏一律回落 `{}` —— 回落空映射的语义是"谁都还没被授权"，
     * 那是**安全的一侧**（插件回到等待授权，而不是凭空拿到权限）。
     * @returns {Record<string, string[]>}
     */
    loadGrantedPermissions () : Record<string, string[]> {
      try {
        return inGlobalScope(() => {
          const svc = service()
          if (!svc) return {}
          const raw = svc.get(PLUGIN_GRANTED_PERMISSIONS_KEY)
          if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {}
          const out: Record<string, string[]> = {}
          for (const [id, scopes] of Object.entries(raw)) {
            if (typeof id !== 'string' || !id) continue
            if (!Array.isArray(scopes)) continue
            out[id] = scopes.filter((s) => typeof s === 'string' && s).map(String)
          }
          return out
        })
      } catch (e) {
        logger.warn?.(`[plugin-state] 读取 ${PLUGIN_GRANTED_PERMISSIONS_KEY} 失败（按无授权处理）：`, errorMessage(e))
        return {}
      }
    },

    /**
     * 写入单个插件的授权清单（读-改-写）。空数组 = 撤销授权（移除该键）。
     * @param {string} pluginId
     * @param {string[]} scopes
     * @returns {Record<string, string[]>|null}
     */
    setGrantedPermissions (pluginId: unknown, scopes: readonly unknown[]): Record<string, string[]> | null {
      const id = String(pluginId || '')
      if (!id) return null
      const current = this.loadGrantedPermissions()
      const list = Array.isArray(scopes) ? Array.from(new Set(scopes.filter((s) => typeof s === 'string' && s))) : []
      const next = { ...current }
      if (list.length) next[id] = list
      else delete next[id]
      try {
        return inGlobalScope(() => {
          const svc = service()
          if (!svc || typeof svc.set !== 'function') return null
          svc.set(PLUGIN_GRANTED_PERMISSIONS_KEY, next)
          return next
        })
      } catch (e) {
        logger.warn?.(`[plugin-state] 写入 ${PLUGIN_GRANTED_PERMISSIONS_KEY} 失败：`, errorMessage(e))
        return null
      }
    },

    /**
     * 读回**插件源地址列表**（社区市场的索引 URL）。
     *
     * 兼容旧版：新键不存在时会去看旧的单源键（`plugins.marketSource`，一个字符串），
     * 有值就当成"只有一个源"。**升级不该让用户配好的源凭空消失** ——
     * 这种回归用户查不出来，只会觉得"这软件又把我的设置弄丢了"。
     * 兼容只做在**读**这一侧；一旦用户增删过源，写下去的就是新键（并把旧键清空）。
     * @returns {string[]}
     */
    loadMarketSources () : string[] {
      try {
        return inGlobalScope(() => {
          const svc = service()
          if (!svc) return []
          const raw = svc.get(PLUGIN_MARKET_SOURCES_KEY)
          if (Array.isArray(raw)) return normalizeSources(raw)
          const legacy = svc.get(PLUGIN_MARKET_SOURCE_KEY_LEGACY)
          return typeof legacy === 'string' && legacy.trim() ? [legacy.trim()] : []
        })
      } catch (e) {
        logger.warn?.(`[plugin-state] 读取 ${PLUGIN_MARKET_SOURCES_KEY} 失败（按未配置处理）：`, errorMessage(e))
        return []
      }
    },

    /**
     * 写入插件源地址列表（空数组 = 清除全部）。返回归一化后的结果。
     * 顺手把旧键清空 —— 两个键同时有值会让"到底哪个算数"变成一个没人知道答案的问题。
     * @param {string[]} sources
     * @returns {string[]|null} 写入后的值；失败返回 null
     */
    saveMarketSources (sources: unknown): string[] | null {
      const next = normalizeSources(sources)
      try {
        return inGlobalScope(() => {
          const svc = service()
          if (!svc || typeof svc.set !== 'function') return null
          svc.set(PLUGIN_MARKET_SOURCES_KEY, next)
          svc.set(PLUGIN_MARKET_SOURCE_KEY_LEGACY, '')
          return next
        })
      } catch (e) {
        logger.warn?.(`[plugin-state] 写入 ${PLUGIN_MARKET_SOURCES_KEY} 失败：`, errorMessage(e))
        return null
      }
    }
  }
}

export {
  PLUGIN_AUTO_DISABLED_KEY,
  PLUGIN_DEFAULTS_SEEDED_KEY,
  PLUGIN_GRANTED_PERMISSIONS_KEY,
  PLUGIN_MARKET_SOURCES_KEY,
  PLUGIN_MARKET_SOURCE_KEY_LEGACY,
  PLUGIN_USERSCRIPTS_DISABLED_KEY
}
