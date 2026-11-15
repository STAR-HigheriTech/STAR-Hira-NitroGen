/**
 * search-settings —— 搜索域**设置键名 + 缺省值**的唯一真源（纯数据，零依赖、无 IO）。
 *
 * 改造前同一批键名被手抄在六处：
 *   · `domain-settings` 的默认值表（值）；
 *   · `settings/registry.js` 的 subtabs / fields（键名 + 又一份 default）；
 *   · `renderer/controllers/search-controller.js`（读值 + 热更新白名单）；
 *   · `settings/appliers/search.js` / `search-history.js`（keys 与 get）；
 *   · `main/ipc/search.js`（广播 / 回写默认引擎）。
 * 加一个开关要改六处、漏一处就是「设置页有、地址栏不认」。
 *
 * 谁在读它：
 *   · 域层 `domain-settings` —— 默认值表；
 *   · `settings/registry.js` —— 设置页字段；
 *   · `settings/appliers/*` —— keys 与运行时读取；
 *   · `main/ipc/search.js` —— 变更广播与默认引擎回写；
 *   · 渲染层 `search-controller` —— 本地缓存与热更新白名单（vite 裸名导入）。
 *
 * 注意：内置引擎**表**不在这里 —— 那是代码事实，见 `search-engines.mjs`。
 * 这里只描述「用户可改的那几个开关」。
 */

import { DEFAULT_SEARCH_ENGINE } from './search-engines.js'

/**
 * 设置键名。
 *
 * `customEngines` / `customBangs` / `clearHistory` 是**通道键**而非持久开关：
 * 前两者是用户数据（SQLite）的变更广播键，后者是设置页的一个动作按钮。
 * 归在一起是因为它们在 registry / 渲染层 / IPC 里始终成组出现。
 *
 * `pluginBangs` 是插件启停引起的 bang 变化广播键 —— 不落库，仅用于通知地址栏重拉配置。
 * @type {Readonly<Record<string, string>>}
 */
export const SEARCH_SETTING_KEYS: Readonly<Record<string, string>> = Object.freeze({
  defaultEngine: 'search.default_engine',
  suggestionsEnabled: 'search.suggestions_enabled',
  bangsEnabled: 'search.bangs_enabled',
  historyEnabled: 'search.history_enabled',
  customEngines: 'search.custom_engines',
  customBangs: 'search.custom_bangs',
  clearHistory: 'search.clear_history',
  pluginBangs: 'search.plugin_bangs'
})

/**
 * 落库的缺省值（域层 `DEFAULT_SETTINGS` 与设置页字段共用同一份）。
 * 通道键（custom_* / clear_history / plugin_bangs）没有缺省值，不在此登记。
 * @type {Readonly<Record<string, unknown>>}
 */
export const DEFAULT_SEARCH_SETTINGS: Readonly<Record<string, unknown>> = Object.freeze({
  [SEARCH_SETTING_KEYS.defaultEngine]: DEFAULT_SEARCH_ENGINE,
  [SEARCH_SETTING_KEYS.suggestionsEnabled]: true,
  [SEARCH_SETTING_KEYS.bangsEnabled]: true,
  [SEARCH_SETTING_KEYS.historyEnabled]: true
})
