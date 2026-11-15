import { errorMessage } from './types'
import type { ApplierDependencies, SettingsApplier } from './types'

// @ts-check
/**
 * settings/appliers/search.js — 搜索域生效器
 *
 * 搜索域只有一个真正的「持久设置」：默认引擎。
 *   · 内置引擎模板是**代码事实**（`shared-types/src/search-engines.mjs`），不再由设置覆盖 ——
 *     此前 `search.engine-google/bing/...` 让「代码一份、设置里又一份」，两套真相必然漂移。
 *   · 用户自定义的引擎是**用户数据**（SQLite `custom_engines`），走 `search:custom-engine-save`
 *     这条 CRUD 通道，不经过 settings。
 *
 * 唯一的兼容动作：把旧版本留在 settings 里的 `search.engine-custom1..3`
 * 一次性迁移成自定义引擎（幂等 —— 迁移成功即清空那个键）。
 *
 * @param {{ searchService?: any }} deps
 */
const { SEARCH_SETTING_KEYS } = require('@hira-ng/shared-types/src/search-settings.mjs')

function createSearchApplier(deps: ApplierDependencies = {}): SettingsApplier {
  return {
    id: 'search-engine',
    keys: [SEARCH_SETTING_KEYS.defaultEngine],
    apply({ key, settings }) {
      const svc = deps.searchService
      if (!svc) return

      const applyDefault = () => {
        const name = settings.get(SEARCH_SETTING_KEYS.defaultEngine)
        if (typeof svc.setDefaultSearchEngine !== 'function') return
        const changed = svc.setDefaultSearchEngine(name)
        if (changed) console.log('[settings] default search engine ->', name)
      }

      /**
       * 旧版「自定义引擎 1/2/3」三个槽位 → 真正的自定义引擎条目。
       * 只在全量重算时跑；迁移成功后清空旧键，下次启动不再重复。
       */
      const migrateLegacySlots = () => {
        if (typeof svc.saveCustomEngine !== 'function' || typeof settings.set !== 'function') return
        for (let i = 1; i <= 3; i += 1) {
          const legacyKey = `search.engine-custom${i}`
          const url = settings.get(legacyKey)
          if (typeof url !== 'string' || !url.trim()) continue
          const res = svc.saveCustomEngine({
            trigger: `custom${i}`,
            title: `自定义搜索引擎 ${i}`,
            url: url.trim()
          })
          // 触发词被占（比如用户已有同名 bang）时保留旧值，不静默丢数据。
          if (res && res.ok) settings.set(legacyKey, '')
        }
      }

      // key 为空 = 全量重算（启动 / 重置）
      if (!key) {
        migrateLegacySlots()
        applyDefault()
        return
      }
      if (key === SEARCH_SETTING_KEYS.defaultEngine) applyDefault()
    }
  }
}

export { createSearchApplier }
