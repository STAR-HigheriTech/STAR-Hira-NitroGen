/**
 * search-engines —— 内置搜索引擎的**唯一真源**（纯数据 + 纯函数，零依赖、无 IO）。
 *
 * 为什么必须只有一份：
 *   改造前同一批引擎散在**四处** ——
 *     · `domain-search` 的 `BUILTIN_ENGINES` / `BUILTIN_ENGINE_LABELS`（服务端事实）；
 *     · `domain-settings` 的 `search.engine-google/bing/...`（没人读的死默认值）；
 *     · 新标签页搜索框的 `FALLBACK_TEMPLATE`（第三份 bing 模板，且与域层回落的 google 不一致）；
 *     · `commands.mjs#BANGS` 里 `g` / `bing` / `bd` / `ddg` 的 url（第四份）；
 *     · 渲染层 / infra 右键 / 侧栏各自的 `FALLBACK_TEMPLATE` 与「使用 Bing 搜索…」文案（第五、六份）。
 *   加一个引擎要改六七处、漏一处就是「下拉里有、地址栏没有」。
 *
 * 谁在读它：
 *   · 主进程 `domain-search`  —— 默认引擎解析、`search:engines` 下拉、`search:config`；
 *   · 主进程 `domain-settings` / `settings/registry.js` / `ipc/search.js` —— 默认值与回落；
 *   · 渲染层 `search-controller` / `ui-searchbar` —— 配置未到时构造 URL 的兜底；
 *   · `infra-window` 右键菜单 / 独立侧栏 —— 宿主未注入时的兜底 URL 与文案；
 *   · 新标签页搜索框（内部页，走 `hira://shared/search-engines.mjs`）—— 取不到配置时的兜底模板；
 *   · `commands.mjs#BANGS` —— 搜索引擎类 bang 的 url 直接引用本表，不另抄一份。
 *
 * ⚠ 本表是**代码事实**：不落库、不可编辑。用户能改的只有 SQLite `custom_engines`
 *   （`domain-search/custom-engines.ts`），两者永不交叉。
 */

import { buildSearchUrl } from './search-url.js'

export interface SearchEngine {
  label: string
  template: string
}

/**
 * 内置引擎表：id → 展示名 + URL 模板。
 * `template` 的占位规则见 `search-url.mjs#buildSearchUrl`（`{query}` / `%s` / 已有 `?q=`）。
 * @type {Readonly<Record<string, SearchEngine>>}
 */
export const SEARCH_ENGINES: Readonly<Record<string, SearchEngine>> = Object.freeze({
  google: Object.freeze({ label: 'Google', template: 'https://www.google.com/search?q=' }),
  bing: Object.freeze({ label: 'Bing', template: 'https://www.bing.com/search?q=' }),
  baidu: Object.freeze({ label: '百度', template: 'https://www.baidu.com/s?wd=' }),
  duckduckgo: Object.freeze({ label: 'DuckDuckGo', template: 'https://duckduckgo.com/?q=' }),
  yahoo: Object.freeze({ label: 'Yahoo', template: 'https://search.yahoo.com/search?p=' })
})

/** 内置引擎 id 的顺序（= 默认引擎下拉里的排列顺序）。 */
export const BUILTIN_ENGINE_IDS = Object.freeze(Object.keys(SEARCH_ENGINES))

/** 缺省默认引擎（新装 / 迁移 / 删掉当前自定义引擎后的回落值）。 */
export const DEFAULT_SEARCH_ENGINE = 'google'

/** 缺省默认引擎的模板 —— 「拿不到任何配置」时的唯一下限。 */
export const DEFAULT_SEARCH_TEMPLATE = SEARCH_ENGINES[DEFAULT_SEARCH_ENGINE].template

/**
 * id → 模板（`search:config` 的 `engines` 字段形状）。
 * @type {Readonly<Record<string, string>>}
 */
export const SEARCH_ENGINE_TEMPLATES: Readonly<Record<string, string>> = Object.freeze(
  Object.fromEntries(BUILTIN_ENGINE_IDS.map((id) => [id, SEARCH_ENGINES[id].template]))
)

/**
 * id → 展示名。
 * @type {Readonly<Record<string, string>>}
 */
export const SEARCH_ENGINE_LABELS: Readonly<Record<string, string>> = Object.freeze(
  Object.fromEntries(BUILTIN_ENGINE_IDS.map((id) => [id, SEARCH_ENGINES[id].label]))
)

/**
 * 内置引擎列表（`search:engines` 的 `{ name, url, label }` 形状）。
 * 每次返回新数组/新对象，调用方随便改都不会污染真源。
 * @returns {Array<{ name: string, url: string, label: string }>}
 */
export function listSearchEngines() : Array<{ name: string, url: string, label: string }> {
  return BUILTIN_ENGINE_IDS.map((id) => ({
    name: id,
    url: SEARCH_ENGINES[id].template,
    label: SEARCH_ENGINES[id].label
  }))
}

/**
 * 内置引擎 id → 模板；未知 id 返回空串（调用方自行决定回落策略）。
 * @param {string} id
 * @returns {string}
 */
export function builtinEngineTemplate(id: string) : string {
  const key = String(id == null ? '' : id).trim()
  return SEARCH_ENGINES[key] ? SEARCH_ENGINES[key].template : ''
}

/**
 * 用**缺省引擎**构造搜索 URL —— 各处"拿不到配置时的兜底"统一走这一条。
 *
 * 改造前这类兜底散在渲染层 / infra / 侧栏 / 新标签页，且一半写 bing、一半写 google；
 * 域层回落却是 google —— 同一台机器上"地址栏搜 google、右键搜 bing"。
 * @param {string} query
 * @returns {string}
 */
export function defaultSearchUrl(query: string) : string {
  return buildSearchUrl(DEFAULT_SEARCH_TEMPLATE, query)
}

/**
 * 「使用 <引擎> 搜索「<关键词>」」—— 右键菜单 / 悬停条在**宿主没注入**时用的兜底文案。
 * 引擎名同样来自真源，不写死 "Bing"。
 * @param {string} text
 * @param {number} [max=20] 关键词截断长度
 * @returns {string}
 */
export function defaultSearchLabel(text: string, max: number = 20) : string {
  const value = String(text == null ? '' : text)
  const limit = Math.max(1, Number(max) || 20)
  const display = value.length > limit ? `${value.slice(0, limit)}…` : value
  return `使用${SEARCH_ENGINE_LABELS[DEFAULT_SEARCH_ENGINE]}搜索「${display}」`
}
