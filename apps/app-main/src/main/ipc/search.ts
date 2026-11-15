/**
 * IPC · Search 域（S4-3）—— 自 ipc-routes.js 原样搬入（Step 5，语义零改动）。
 */

import { createProviderInvoker } from './provider-bridge'
import type { ProviderRegistryPort } from './provider-bridge'
import { createSlotCaller, type SlotCaller } from '../slot-call'
import { errorMessage } from './types'
import type { IpcRoutes, IpcSchemas, IpcTypedMain } from './types'

type MethodPort = Record<string, (...args: unknown[]) => unknown>
function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' ? value as Record<string, unknown> : {}
}
interface SearchIpcContext {
  routes: IpcRoutes
  schemas: IpcSchemas['search']
  searchService: MethodPort
  providerRegistry?: ProviderRegistryPort | null
  slots?: SlotCaller
  automation?: { suggestChains(query: string, limit?: number): unknown[] } | null
  notifyChange?: (change: { scope: 'one'; key: string; value: unknown }) => unknown
  instantAnswer?: { query(query: string, options: { limit: unknown }): unknown } | null
  settingsService?: { get(key: string): unknown; set?(key: string, value: unknown): unknown } | null
  getPluginBangs?: (() => unknown) | null
  unifiedSearch?: { unified(query: string, limit?: number): unknown[] } | null
}
// 缺省默认引擎的真源（与域层 / 设置项 / 新标签页兜底同一份）。
const {
  DEFAULT_SEARCH_ENGINE,
  DEFAULT_SEARCH_TEMPLATE,
  SEARCH_ENGINE_TEMPLATES
} = require('@hira-ng/shared-types/src/search-engines.mjs')
// 搜索域设置键名真源（广播键在这里定义，避免各处手抄字符串）。
const { SEARCH_SETTING_KEYS } = require('@hira-ng/shared-types/src/search-settings.mjs')

export function registerSearchIpc(
  typedMain: IpcTypedMain,
  { routes, schemas, searchService, providerRegistry, slots, automation, notifyChange, instantAnswer, settingsService, getPluginBangs, unifiedSearch }: SearchIpcContext
): void {
  if (!searchService) return

  const invoke = createProviderInvoker(providerRegistry)
  // 缺省给一个"没有调度器"的调用器：本注册器要能被单独使用（既有单测就是这么调的），
  // 此时插槽一律当作"没有插件参与"。
  const slotCall = slots || createSlotCaller(null, { label: 'search-ipc' })

  /**
   * 自定义 Bang 变更 → 走 `settings:changed` 同一条广播通道（不新增事件类型）。
   * 渲染层据此重拉 `search:config`（其中带 `customBangs`），地址栏建议随即热更新。
   * 使用计数（used）**不广播**：它不改列表形状，广播只会制造无谓重渲染。
   */
  function notifyCustomBangsChanged() {
    if (typeof notifyChange !== 'function') return
    try {
      notifyChange({ scope: 'one', key: SEARCH_SETTING_KEYS.customBangs, value: undefined })
    } catch (e) {
      console.error('[search-ipc] notify custom bangs failed:', errorMessage(e))
    }
  }

  /** 自定义引擎变更 → 同一条广播通道；地址栏按 key 重拉配置，设置页重绘列表。 */
  function notifyCustomEnginesChanged() {
    if (typeof notifyChange !== 'function') return
    try {
      notifyChange({ scope: 'one', key: SEARCH_SETTING_KEYS.customEngines, value: undefined })
    } catch (e) {
      console.error('[search-ipc] notify custom engines failed:', errorMessage(e))
    }
  }

  typedMain.handle(routes.searchSuggestions, {
    requestSchema: schemas.suggestions.request,
    responseSchema: schemas.suggestions.response,
    handler: async (_e, req) => {
      const base = await invoke('search.search', () => searchService.search(req.query, { limit: req.limit }), req)
      /**
       * D2 命令链：链本身也是**地址栏命令入口**（"打字就能跑"）。
       * 由自动化控制器给出 `{ type:'pedal', action:'chain:<id>' }` 形状，
       * 经 `search.suggestion-provider` 之外的一条**前置合并**进入建议列表 ——
       * 放前面是因为"我输入了链名"比"某个网页标题含这几个字"更接近用户意图。
       */
      const chains = automation && typeof automation.suggestChains === 'function'
        ? automation.suggestChains(req.query, 3)
        : []
      const local = unifiedSearch && typeof unifiedSearch.unified === 'function'
        ? unifiedSearch.unified(req.query, Math.min(8, Number(req.limit) || 8))
        : []
      const pluginLocal = slotCall.multi('search.local-provider', {
        query: req.query,
        limit: req.limit
      })
        .flat(1)
        .map(asRecord)
        .filter((item) => typeof item.title === 'string' && typeof item.url === 'string')
        .map((item) => ({
          ...item,
          type: typeof item.type === 'string' ? item.type : 'website',
          source: typeof item.source === 'string' ? item.source : '插件',
          relevance: Number(item.relevance) || 640
        }))
      const merged = [
        ...chains,
        ...pluginLocal,
        ...(Array.isArray(local) ? local : []),
        ...(Array.isArray(base) ? base : [])
      ]
      /**
       * `search.suggestion-provider`（REDUCE）—— 插件往地址栏建议里加料。
       *
       * 调用签名是 `impl(acc, payload, ctx)`（见 extension-points.js）：
       *   · `acc` / `payload` = **已有的建议数组** —— 本插槽没声明 `initialValue`，
       *     所以流水线初值就是 payload，实现写 `(acc) => acc.filter(...)` 或
       *     `(acc) => [...acc, item]` 都能直接用；
       *   · `ctx` = `{ query, limit }` —— "用户输入了什么"走**第三参**，
       *     因为前两个参数已经被那份列表占了。
       *     ⚠ 别把 query 塞进 payload：那会把 payload 从"数组"变成"对象"，
       *     所有 `(acc) => acc.filter(...)` 的惯用实现会当场失效。
       * 没有插件参与时返回原数组（`emptyResult` 也是这个语义）→ 零成本接线。
       */
      return slotCall.reduce('search.suggestion-provider', merged, { query: req.query, limit: req.limit })
    }
  })

  typedMain.handle(routes.searchHistory, {
    requestSchema: schemas.history.request,
    responseSchema: schemas.history.response,
    handler: async (_e, req) => invoke('search.searchHistorySuggestions', () => searchService.searchHistorySuggestions(req.query, req.limit), req)
  })

  typedMain.handle(routes.searchRecord, {
    requestSchema: schemas.record.request,
    responseSchema: schemas.record.response,
    handler: async (_e, req) => { await invoke('search.recordSearchQuery', () => searchService.recordSearchQuery(req.query), req); return { ok: true } }
  })

  typedMain.handle(routes.searchRemoveHistoryEntry, {
    requestSchema: schemas.removeHistoryEntry.request,
    responseSchema: schemas.removeHistoryEntry.response,
    handler: async (_e, req) => ({ removed: await invoke('search.removeSearchHistoryEntry', () => searchService.removeSearchHistoryEntry(req.id), req) })
  })

  typedMain.handle(routes.searchClearHistory, {
    requestSchema: schemas.clearHistory.request,
    responseSchema: schemas.clearHistory.response,
    handler: async () => {
      try {
        const cleared = await invoke('search.clearSearchHistory', () => searchService.clearSearchHistory(), null)
        const n = Number(cleared) || 0
        return { ok: true, message: n > 0 ? `已清除 ${n} 条搜索历史` : '没有可清除的搜索历史' }
      } catch (e) {
        return { ok: false, error: errorMessage(e) || '清除失败' }
      }
    }
  })

  // 全量搜索引擎配置：地址栏启动时拉取一次，之后靠 settings:changed 热更新。
  // 这样"默认搜索引擎"设置才真正作用到地址栏（以前地址栏硬编码 google）。
  //
  // `pluginBangs` = 插件贡献的 bang（contributes.bangs + `search.bang-provider` 插槽）。
  // 它和 customBangs 走同一条下发通道，地址栏因此**不需要知道"插件"这个概念** ——
  // 插件停用后这里自然变空，下一帧建议列表就跟着消失。
  typedMain.handle(routes.searchConfig, {
    requestSchema: schemas.config.request,
    responseSchema: schemas.config.response,
    handler: async () => {
      const base = typeof searchService.getSearchConfig === 'function'
        ? await invoke('search.getSearchConfig', () => searchService.getSearchConfig(), null)
        : {
            default: DEFAULT_SEARCH_ENGINE,
            engines: { ...SEARCH_ENGINE_TEMPLATES },
            defaultTemplate: DEFAULT_SEARCH_TEMPLATE,
            customBangs: []
          }
      let pluginBangs: unknown[] = []
      if (typeof getPluginBangs === 'function') {
        try {
          const value = await getPluginBangs()
          if (Array.isArray(value)) pluginBangs = value
        } catch (e) {
          // 插件侧异常不能拖垮地址栏配置：退化成"没有插件 bang"。
          console.error('[search-ipc] get plugin bangs failed:', errorMessage(e))
        }
      }
      /**
       * 新标签页搜索框旁的**动作按钮**（`newtab.search-action`，MULTI）。
       *
       * 与 `pluginBangs` 同一套思路：宿主只下发"有哪些动作"，新标签页只负责画按钮
       * 与做 `{query}` 替换 —— 页面不认识 AI，也不认识任何具体动作。
       * 没有插件实现时是空数组（`multi` 的语义），按钮自然不出现。
       */
      const searchActions = slotCall.multi('newtab.search-action', {})
        // MULTI 的原始结果是「每个实现一个值」；允许一个实现一次返回多枚动作，
        // 与其它 MULTI 宿主的 flat(1) 口径保持一致（AI 插件即是这种形态）。
        .flat(1)
        .map(asRecord)
        .filter((action) => typeof action.id === 'string' && typeof action.template === 'string' && action.template)
      return { ...asRecord(base), pluginBangs, searchActions }
    }
  })

  // ── 自定义 Bang（用户数据，按 profile 分区）──────────────────────────────
  // 全部转调 domain-search 的存储端口；本层只做形状转换与广播，不做校验/归一化。

  typedMain.handle(routes.searchCustomBangs, {
    requestSchema: schemas.customBangs.request,
    responseSchema: schemas.customBangs.response,
    handler: async () => {
      if (typeof searchService.listCustomBangs !== 'function') return []
      return invoke('search.listCustomBangs', () => searchService.listCustomBangs(), null)
    }
  })

  typedMain.handle(routes.searchCustomBangSave, {
    requestSchema: schemas.customBangSave.request,
    responseSchema: schemas.customBangSave.response,
    handler: async (_e, req) => {
      if (typeof searchService.saveCustomBang !== 'function') {
        return { ok: false, error: '当前服务不支持自定义 Bang' }
      }
      const res = asRecord(await invoke('search.saveCustomBang', () => searchService.saveCustomBang(req), req))
      if (res.ok) notifyCustomBangsChanged()
      return Object.keys(res).length ? res : { ok: false, error: '保存失败' }
    }
  })

  typedMain.handle(routes.searchCustomBangRemove, {
    requestSchema: schemas.customBangRemove.request,
    responseSchema: schemas.customBangRemove.response,
    handler: async (_e, req) => {
      if (typeof searchService.removeCustomBang !== 'function') return { removed: false }
      const removed = await invoke('search.removeCustomBang', () => searchService.removeCustomBang(req.id), req)
      const removedRecord = asRecord(removed)
      const result = { removed: Boolean(removedRecord.removed !== undefined ? removedRecord.removed : removed) }
      if (result.removed) notifyCustomBangsChanged()
      return result
    }
  })

  // 使用计数：只动 `hit_count`，不改列表顺序语义与 `updated_at`；不广播。
  typedMain.handle(routes.searchCustomBangUsed, {
    requestSchema: schemas.customBangUsed.request,
    responseSchema: schemas.customBangUsed.response,
    handler: async (_e, req) => {
      if (typeof searchService.recordCustomBangUse !== 'function') return { ok: false }
      const res = asRecord(await invoke('search.recordCustomBangUse', () => searchService.recordCustomBangUse(req.id), req))
      return { ok: Boolean(res.ok === undefined ? res : res.ok) }
    }
  })

  // ── 自定义搜索引擎（用户数据，按 profile 分区）────────────────────────────
  // 与内置引擎分离：内置是代码事实（`BUILTIN_ENGINES`），自定义落 `custom_engines`。
  // 本层只做形状转换与广播，不做校验/归一化（全在 domain 的 custom-store 里）。

  /**
   * 默认引擎下拉的选项源：`[[id, label], …]`。
   * 与设置页 `optionsRoute` 约定的形状一致 —— 新增/删除引擎后下拉自动跟着变，
   * 不再有「自定义 1/2/3」这种写死槽位。
   */
  typedMain.handle(routes.searchEngines, {
    requestSchema: schemas.engines.request,
    responseSchema: schemas.engines.response,
    handler: async () => {
      const builtins = typeof searchService.getSearchEngines === 'function'
        ? searchService.getSearchEngines()
        : []
      const customs = typeof searchService.listCustomEngines === 'function'
        ? await invoke('search.listCustomEngines', () => searchService.listCustomEngines(), null)
        : []
      return [
        ...(Array.isArray(builtins) ? builtins.map((e) => [String(e.name), String(e.label || e.name)]) : []),
        ...(Array.isArray(customs) ? customs.map((e) => [String(e.id), String(e.title || e.trigger)]) : [])
      ]
    }
  })

  typedMain.handle(routes.searchCustomEngines, {
    requestSchema: schemas.customEngines.request,
    responseSchema: schemas.customEngines.response,
    handler: async () => {
      if (typeof searchService.listCustomEngines !== 'function') return []
      return invoke('search.listCustomEngines', () => searchService.listCustomEngines(), null)
    }
  })

  typedMain.handle(routes.searchCustomEngineSave, {
    requestSchema: schemas.customEngineSave.request,
    responseSchema: schemas.customEngineSave.response,
    handler: async (_e, req) => {
      if (typeof searchService.saveCustomEngine !== 'function') {
        return { ok: false, error: '当前服务不支持自定义搜索引擎' }
      }
      const res = asRecord(await invoke('search.saveCustomEngine', () => searchService.saveCustomEngine(req), req))
      if (res.ok) notifyCustomEnginesChanged()
      return Object.keys(res).length ? res : { ok: false, error: '保存失败' }
    }
  })

  typedMain.handle(routes.searchCustomEngineRemove, {
    requestSchema: schemas.customEngineRemove.request,
    responseSchema: schemas.customEngineRemove.response,
    handler: async (_e, req) => {
      if (typeof searchService.removeCustomEngine !== 'function') return { removed: false, defaultReset: false }
      const res = asRecord(await invoke('search.removeCustomEngine', () => searchService.removeCustomEngine(req.id), req))
      const result = {
        removed: Boolean(res.removed),
        defaultReset: Boolean(res.defaultReset)
      }
      if (result.removed) notifyCustomEnginesChanged()
      if (result.defaultReset) {
        // 删掉的正好是默认引擎 → 域层已回落缺省引擎；这里把设置也写回去，
        // 否则重启后 applyDefault 还会拿着一个已不存在的 id 试一次。
        // `settingsService.set` 会触发 settings-sync 的广播，设置页的下拉因此同步。
        let persisted = false
        if (settingsService && typeof settingsService.set === 'function') {
          try { settingsService.set(SEARCH_SETTING_KEYS.defaultEngine, DEFAULT_SEARCH_ENGINE); persisted = true } catch (_) {}
        }
        if (!persisted && typeof notifyChange === 'function') {
          try { notifyChange({ scope: 'one', key: SEARCH_SETTING_KEYS.defaultEngine, value: DEFAULT_SEARCH_ENGINE }) } catch (_) {}
        }
      }
      return result
    }
  })

  /**
   * 即时答案（F-0771~F-0773）。
   *
   * 与 `searchSuggestions` 刻意分开一条通道：
   *   · 建议是**本地聚合**（历史/书签/标签，毫秒级）；即时答案要出网（最慢 2.5s）；
   *   · 两者在地址栏是**两阶段**呈现（本地先出、远端后到），合成一条会让本地结果被网络拖住；
   *   · 失败语义不同：建议失败应当报错可见，即时答案失败应静默（服务侧已保证返回 `[]`）。
   *
   * 插件可用 `search.instantAnswer` 覆盖实现（provider 优先），返回形状必须与契约一致。
   */
  typedMain.handle(routes.searchInstantAnswer, {
    requestSchema: schemas.instantAnswer.request,
    responseSchema: schemas.instantAnswer.response,
    handler: async (_e, req) => {
      if (!instantAnswer || typeof instantAnswer.query !== 'function') return []
      return invoke('search.instantAnswer', () => instantAnswer.query(req.query, { limit: req.limit }), req)
    }
  })
}

