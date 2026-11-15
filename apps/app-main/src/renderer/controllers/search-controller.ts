/**
 * search-controller.js —— 默认搜索引擎 / 搜索开关配置控制器
 *
 * 从 app-shell/main.js 抽出的**内聚配置控制器**：
 *   启动时拉一次全量搜索配置（引擎表 + 建议/Bangs 开关），
 *   之后靠 settings:changed 刷新本地缓存 —— 构造 URL 全程同步，无 IPC 往返。
 *
 * 彻底解耦：只依赖注入的 provider 与 onSubscribe，不读全局、不 import 组件。
 * searchbar（ui-navbar 内部）通过 getSearchUrl / getFlags / getEngines 读取本控制器暴露的活引用。
 */

import {
  DEFAULT_SEARCH_ENGINE,
  DEFAULT_SEARCH_TEMPLATE
} from '@hira-ng/shared-types/src/search-engines.mjs'
import { buildSearchUrl } from '@hira-ng/shared-types/src/search-url.mjs'
import { SEARCH_SETTING_KEYS } from '@hira-ng/shared-types/src/search-settings.mjs'
import type { RendererProvider } from '../shared/bridge.js'
import { errorMessage } from '../shared/error-message.js'

export interface SearchControllerDeps {
  provider: RendererProvider
  onSubscribe(event: string, callback: (payload: Record<string, unknown>) => void): () => void
}

interface SearchConfigResponse {
  default?: unknown
  engines?: Record<string, unknown>
  defaultTemplate?: unknown
  pluginBangs?: unknown[]
  customBangs?: unknown[]
}

interface CustomSearchEntry {
  id: string
  trigger: string
  title: string
  url: string
  showSuggestions: boolean
  hitCount: number
}

function normalizeCustomEntries(values: unknown[]): CustomSearchEntry[] {
  const out: CustomSearchEntry[] = []
  for (const value of values) {
    if (!value || typeof value !== 'object') continue
    const entry = value as Record<string, unknown>
    const id = typeof entry.id === 'string' ? entry.id : ''
    const trigger = typeof entry.trigger === 'string' ? entry.trigger : ''
    const url = typeof entry.url === 'string' ? entry.url : ''
    if (!id || !trigger || !url) continue
    out.push({
      id,
      trigger,
      title: typeof entry.title === 'string' ? entry.title : trigger,
      url,
      showSuggestions: entry.showSuggestions === true,
      hitCount: Number(entry.hitCount) || 0
    })
  }
  return out
}

/**
 * @param {SearchControllerDeps} deps
 */
export function createSearchController(deps: SearchControllerDeps) {
  const { provider, onSubscribe } = deps

  let disposed = false

  /** 拿不到配置时的兜底模板（真源在 shared-types/src/search-engines.mjs）。 */
  const FALLBACK_TEMPLATE = DEFAULT_SEARCH_TEMPLATE

  // 引擎表（内置名 → 模板）/ 默认引擎键名 / 默认引擎**已解析好的模板**。
  // 模板由域层解析后随配置下发 —— 渲染层不再判断「默认是内置名还是自定义 id」。
  const engineState = {
    default: DEFAULT_SEARCH_ENGINE,
    engines: /** @type {Record<string,string>} */ (({}) as Record<string,string>),
    template: FALLBACK_TEMPLATE
  }

  // 搜索相关开关（建议 / Bangs）
  const flags = { suggestionsEnabled: true, bangsEnabled: true }

  // 用户自定义 Bang + 插件贡献入口的**活引用**。
  // 两者在解析上是同一个命名空间（`!触发词`）：合并成一份交给 bangs suggestor，
  // 顺序 = 插件 → 用户 Bang。插件条目的 id 带 `plugin:` 前缀，据此跳过使用计数。
  // 自定义搜索引擎**不在这里**：引擎不是 bang，只服务「默认搜索引擎」下拉。
  let customEntries: CustomSearchEntry[] = []

  async function load() {
    try {
      const cfg = await provider.invoke<SearchConfigResponse>('search:config', {})
      if (disposed) return
      if (cfg && typeof cfg === 'object') {
        if (typeof cfg.default === 'string' && cfg.default) engineState.default = cfg.default
        if (cfg.engines && typeof cfg.engines === 'object') {
          engineState.engines = Object.fromEntries(
            Object.entries(cfg.engines).filter((entry): entry is [string, string] => typeof entry[1] === 'string')
          )
        }
        engineState.template =
          (typeof cfg.defaultTemplate === 'string' && cfg.defaultTemplate) ||
          engineState.engines[engineState.default] ||
          FALLBACK_TEMPLATE
        // 整体替换数组（而非就地 mutate）：searchbar 可能在异步间隙持有旧引用
        const pluginBangs = Array.isArray(cfg.pluginBangs) ? cfg.pluginBangs : []
        const bangs = Array.isArray(cfg.customBangs) ? cfg.customBangs : []
        customEntries = normalizeCustomEntries(pluginBangs.concat(bangs))
      }
    } catch (e) {
      console.error('[search-controller] search:config failed:', errorMessage(e))
    }
    try {
      const s = await provider.invoke<Record<string, unknown>>('settings:list', { section: 'search' })
      if (disposed) return
      if (s && typeof s === 'object') {
        const suggestionsEnabled = s[SEARCH_SETTING_KEYS.suggestionsEnabled]
        const bangsEnabled = s[SEARCH_SETTING_KEYS.bangsEnabled]
        if (typeof suggestionsEnabled === 'boolean') flags.suggestionsEnabled = suggestionsEnabled
        if (typeof bangsEnabled === 'boolean') flags.bangsEnabled = bangsEnabled
      }
    } catch (e) {
      console.error('[search-controller] settings:list(search) failed:', errorMessage(e))
    }
  }

  /**
   * 按**当前默认引擎**构造搜索 URL。
   * 模板→URL 的换算收在 `shared-types/search-url` 一处（地址栏 `!bang` 用的是同一份），
   * 而"当前默认引擎的模板是什么"由域层解析后下发（`defaultTemplate`）。
   * @param {string} q @returns {string}
   */
  function buildUrl(q: string) {
    return buildSearchUrl(engineState.template, q)
  }

  // 搜索配置热更新触发条件。
  //
  // 为什么把建议/Bangs 开关也列进来：这两个开关是**渲染层本地缓存**（load() 里
  // 从 settings:list 拉一次），改设置后若不重新 load，缓存就一直是旧值 ——
  // 用户会看到「设置里关了建议，地址栏照样弹建议」。引擎表变更同理。
  const RELOAD_KEYS = new Set([
    SEARCH_SETTING_KEYS.defaultEngine,
    SEARCH_SETTING_KEYS.suggestionsEnabled,
    SEARCH_SETTING_KEYS.bangsEnabled,
    SEARCH_SETTING_KEYS.historyEnabled,
    // 自定义 Bang / 自定义引擎的增删改由主进程以 same-key 广播（见 ipc/search.js）；
    // 插件启停引起的 bang 变化走 `search.plugin_bangs`（plugin-surfaces 广播同一条通道）。
    SEARCH_SETTING_KEYS.customBangs,
    SEARCH_SETTING_KEYS.customEngines,
    SEARCH_SETTING_KEYS.pluginBangs
  ])
  const unsubscribe = onSubscribe('settings:changed', (change) => {
    if (!change) return
    const k = typeof change.key === 'string' ? change.key : ''
    if (change.scope === 'all' || RELOAD_KEYS.has(k)) {
      load()
    }
  })

  return {
    load,
    buildUrl,
    // 活引用：直接交给 searchbar 读取，避免每帧拷贝
    getFlags: () => flags,
    /**
     * 引擎表（名字 → 模板）的**活引用** —— 地址栏据此把内置搜索引擎
     * 也当作 `!名字` 的 bang。用户自定义引擎走 `getCustomBangs()`（同一命名空间）。
     */
    getEngines: () => engineState.engines,
    /**
     * 当前默认引擎的**键名**（内置名，或自定义引擎的 id）。
     * 即时答案只对支持它的内置引擎生效（见 ui-searchbar/suggestors/instant-answer.ts）。
     */
    getDefaultEngine: () => engineState.default,
    /**
     * 自定义入口（插件 bang + 自定义 Bang）的**活引用**。
     * 与内置 Bang（`shared-types/commands.mjs`）彻底分开：这里只有插件/用户数据，
     * 解析优先级由 `resolveBangEngine` 保证（内置 bang > 内置引擎 > 自定义 bang）。
     */
    getCustomBangs: () => customEntries,
    /**
     * 记一次自定义 Bang 使用（`!trigger query` 直搜后调用）。
     * 主进程只 +1 `hit_count`，不广播、不改列表结构 —— 这是纯计数，不需要等地。
     * 插件贡献的 bang（id 带 `plugin:` 前缀）不计数：它的 hit_count 恒为 0，
     * 也没有对应的 SQLite 行 —— 发过去只会被主进程当成未知 id 忽略。
     */
    recordBangUse(id: unknown) {
      const bangId = String(id == null ? '' : id).trim()
      if (!bangId) return
      if (bangId.startsWith('plugin:')) return
      try {
        const p = provider.invoke('search:custom-bang-used', { id: bangId })
        if (p && typeof p.catch === 'function') p.catch(() => {})
      } catch {
        /* 计数失败不影响搜索 */
      }
    },
    /**
     * 记一条搜索词（地址栏真正执行了一次关键词搜索时调用）。
     * 与 Bang 计数同一条口径：fire-and-forget，失败不影响导航。
     * @param {string} q
     */
    recordQuery(q: string) {
      const query = String(q == null ? '' : q).trim()
      if (!query) return
      try {
        const p = provider.invoke('search:record', { query })
        if (p && typeof p.catch === 'function') p.catch(() => {})
      } catch {
        /* 记录失败不影响搜索 */
      }
    },
    dispose() {
      if (disposed) return
      disposed = true
      unsubscribe()
    }
  }
}

