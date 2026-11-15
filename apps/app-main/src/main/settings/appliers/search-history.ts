import { errorMessage } from './types'
import type { ApplierDependencies, SettingsApplier } from './types'

// @ts-check
/**
 * settings/appliers/search-history.js — 「搜索建议包含历史」生效器
 *
 * search.history_enabled 的真实落点是 domain-search 的两条查询：
 *   - searchService.search()                  → 建议里的「浏览历史」条目（includeHistory）
 *   - searchService.searchHistorySuggestions() → 建议里的「历史搜索词」条目
 * 二者的调用点（main/ipc/search.js、renderer 的 search-controller）都不在本特性的
 * 可改动范围内，因此这里用**端口包装**把开关接到服务上：
 *   在 searchService 上包一层同名方法，调用时按**当次**设置值补齐 includeHistory /
 *   决定是否短路历史搜索词。开关因此是「即时生效」的 —— 每次都读实时值，
 *   不依赖 applier 被触发的时机。
 *
 * 为什么不是「改 searchService」（不可取）：domain 层保持纯净、不认识设置；
 * 识别设置并把它翻译成领域参数，正是 applier 的职责。
 *
 * 幂等：以私有标记位保证只包一次，重复 apply（含整体重置）不会层层套娃。
 * 安全降级：服务缺失 / 方法缺失时直接返回，不改动任何对象。
 *
 * @param {{ searchService?: any }} deps
 */
const { SEARCH_SETTING_KEYS } = require('@hira-ng/shared-types/src/search-settings.mjs')

function createSearchHistoryApplier(deps: ApplierDependencies = {}): SettingsApplier {
  const PATCH_FLAG = '__hiraSearchHistoryApplied'

  return {
    id: 'search-history',
    keys: [SEARCH_SETTING_KEYS.historyEnabled],
    apply({ settings }) {
      const svc = deps.searchService
      if (!svc || typeof svc.search !== 'function') return false
      if (svc[PATCH_FLAG]) return true

      /** 每次都读实时值：设置页改一下，下一次输入建议就按新值过滤 */
      const isEnabled = () => settings.get(SEARCH_SETTING_KEYS.historyEnabled) !== false

      const originalSearch = svc.search.bind(svc)
      svc.search = (query, opts) => {
        // 调用方显式给了 includeHistory 时以调用方为准，避免覆盖其它语义
        const merged = Object.assign({ includeHistory: isEnabled() }, opts || {})
        return originalSearch(query, merged)
      }

      if (typeof svc.searchHistorySuggestions === 'function') {
        const originalHistory = svc.searchHistorySuggestions.bind(svc)
        svc.searchHistorySuggestions = (query, limit) => (isEnabled() ? originalHistory(query, limit) : [])
      }

      svc[PATCH_FLAG] = true
      return true
    }
  }
}

export { createSearchHistoryApplier }
