/**
 * 新闻源注册中心（共享层）
 *
 * 一个新闻源 = `{ id, name, kind, fetch({ signal, limit }) }`。
 * 注册中心只负责登记；取数、缓存、降级全部由 service.mjs 统一处理。
 *
 * 「再加一个源」= 新增一个 providers/<name>.mjs 并在 index.mjs 的清单里加一行。
 * 组件、service、UI 三处都不用改 —— 这是这套东西唯一的扩展点。
 *
 * 为什么住在 `packages/shared-types`：NTP 新闻组件（apps 层页面）与新标签页
 * 「实时文件夹」侧栏面板（ui 层）都依赖同一批源。放在 PACKAGES 层、用显式
 * `.mjs` 子路径导入，两侧都可依赖，且不引入任何 electron/Node 依赖（纯浏览器 API）。
 */

export interface NewsProviderItem {
  id?: string
  title: string
  url: string
  hot?: string | number
  time?: number
  source?: string
}

export interface NewsProviderFetchOptions {
  signal?: AbortSignal
  limit?: number
}

export interface NewsProvider {
  id: string
  name: string
  kind?: 'board' | 'news'
  home?: string
  fetch: (options: NewsProviderFetchOptions) => Promise<NewsProviderItem[]>
}

const providers = new Map<string, NewsProvider>()

/**
 * @param {{ id:string, name:string, kind?:'board'|'news', home?:string, fetch:(o:{signal?:AbortSignal, limit:number})=>Promise<Array<{id?:string,title:string,url:string,hot?:string|number,time?:number,source?:string}>> }} provider
 */
export function defineProvider(provider: NewsProvider): NewsProvider {
  if (!provider || typeof provider.id !== 'string' || !provider.id) throw new Error('defineProvider: 缺少 id')
  if (typeof provider.fetch !== 'function') throw new Error(`defineProvider(${provider.id}): 缺少 fetch()`)
  providers.set(provider.id, { kind: 'news', home: '', ...provider })
  return provider
}

/** @param {string} id */
export function getProvider(id: string): NewsProvider | null {
  return providers.get(id) || null
}

/** 注册顺序 = 降级链顺序（可靠的排前面）。 */
export function listProviders(): NewsProvider[] {
  return Array.from(providers.values())
}

export function defaultProviderId() {
  const first = listProviders()[0]
  return first ? first.id : ''
}
