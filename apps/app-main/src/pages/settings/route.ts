/**
 * 设置页 URL 状态。
 *
 * `section` 是稳定的深链契约，`key` 用于直达单个字段；`group` 提供不依赖
 * 分区 id 的入口。profileId / spaceId 等业务上下文不在这里解释，也不被删除，
 * 后续分区渲染器可按自己的需要消费。
 */

export interface SettingsRoute {
  group: string
  section: string
  key: string
  query: string
}

export interface SettingsRouteState {
  group?: string | null
  section?: string | null
  key?: string | null
  query?: string | null
}

const KNOWN_PARAMS = ['group', 'section', 'key', 'q', 'query'] as const

function clean(value: string | null, max = 256): string {
  return String(value == null ? '' : value).trim().slice(0, max)
}

export function readSettingsRoute(search = ''): SettingsRoute {
  const params = new URLSearchParams(search)
  return {
    group: clean(params.get('group'), 80),
    section: clean(params.get('section'), 160),
    key: clean(params.get('key')),
    query: clean(params.get('q') || params.get('query'), 300)
  }
}

/**
 * 只替换设置导航相关参数，保留 profileId / spaceId / 插件参数与 hash。
 * 返回 pathname + query + hash，避免自定义 scheme 在 history API 中的宿主差异。
 */
export function settingsRouteHref(currentHref: string, state: SettingsRouteState): string {
  const url = new URL(currentHref, 'hira://settings/')
  for (const key of KNOWN_PARAMS) url.searchParams.delete(key)

  const group = clean(state.group == null ? '' : String(state.group), 80)
  const section = clean(state.section == null ? '' : String(state.section), 160)
  const key = clean(state.key == null ? '' : String(state.key))
  const query = clean(state.query == null ? '' : String(state.query), 300)
  if (group) url.searchParams.set('group', group)
  if (section) url.searchParams.set('section', section)
  if (key) url.searchParams.set('key', key)
  if (query) url.searchParams.set('q', query)

  return url.pathname + url.search + url.hash
}

