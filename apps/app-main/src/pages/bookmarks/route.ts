/**
 * 书签页 URL 状态。
 *
 * 视图状态只在这里与 URL 互转：页面内部仍持有同一份 state，命令面板、
 * 菜单、插件和普通链接只需构造 query，不必知道页面如何筛选数据。
 * 未知参数（如 profileId）原样保留，避免深链在页面内跳转时丢失上层上下文。
 */

export type BookmarksViewMode = 'list' | 'backups'

export interface BookmarksRoute {
  mode: BookmarksViewMode
  folderId: string | null
  tag: string
  query: string
}

const KNOWN_PARAMS = ['view', 'mode', 'folder', 'folderId', 'tag', 'q', 'query'] as const

function clean(value: string | null, max = 500): string {
  return String(value == null ? '' : value).trim().slice(0, max)
}

/** 从 `location.search` 读取可序列化的视图状态。 */
export function readBookmarksRoute(search = ''): BookmarksRoute {
  const params = new URLSearchParams(search)
  const mode = clean(params.get('view') || params.get('mode'), 24).toLowerCase()
  return {
    mode: mode === 'backups' || mode === 'backup' ? 'backups' : 'list',
    folderId: clean(params.get('folder') || params.get('folderId'), 256) || null,
    tag: clean(params.get('tag')),
    query: clean(params.get('q') || params.get('query'), 300)
  }
}

/** 生成下一次 history 地址；空值会从 URL 中删除，未知参数继续保留。 */
export function bookmarksRouteHref(currentHref: string, route: BookmarksRoute): string {
  const url = new URL(currentHref, 'hira://bookmarks/')
  for (const key of KNOWN_PARAMS) url.searchParams.delete(key)

  if (route.mode === 'backups') url.searchParams.set('view', 'backups')
  if (route.folderId) url.searchParams.set('folder', route.folderId)
  if (route.tag) url.searchParams.set('tag', route.tag)
  if (route.query) url.searchParams.set('q', route.query)

  return url.pathname + url.search + url.hash
}

