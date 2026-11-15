/**
 * 导入数据 · 图标贴合（parse 之后、write 之前的纯装配步骤）
 *
 * 职责只有一件：把源浏览器 `Favicons` 库解析出的「页面 → 图标」索引，
 * 落成我们自己的本地图标地址（`hira://favicon/?icon=<hash>`，见 domain-favicon#putIcon），
 * 并贴到即将写入的书签树 / 历史记录上。
 *
 * 为什么不在 parse 里做：parse 是纯翻译（无 IO / 无服务依赖）；
 * 为什么不在 write 里做：write 只认识领域批量入口，不认识源浏览器的库结构。
 * 这条装配正好落在编排层，输入输出都是普通对象，可单独演进。
 */
import { originOf, type ParsedFavicons } from './parse/favicons'

export interface ImportedBookmarkNode {
  url?: unknown
  favicon?: string | null
  children?: unknown
  [key: string]: unknown
}

interface ImportedHistoryVisit {
  url?: unknown
  favicon?: string | null
}

export interface ImportedParsedData {
  bookmarks?: {
    ok?: boolean
    trees?: Array<{ children?: unknown } | null>
  }
  history?: {
    ok?: boolean
    visits?: ImportedHistoryVisit[]
  }
}

export interface ImportedFaviconService {
  putIcon(buffer: Buffer, contentType: string): string | null
}

export interface ImportedFaviconStats {
  attached: number
  icons: number
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' ? value as Record<string, unknown> : null
}

/**
 * 收集解析结果里所有页面地址（书签树 + 历史访问）。
 * 用途：解析源浏览器图标库前先知道「要哪些页面」，只解这些页面的图标（见 parse/favicons）。
 */
export function collectPageUrls(parsed: ImportedParsedData | null | undefined): Set<string> {
  const urls = new Set<string>()
  const walk = (nodes: unknown): void => {
    if (!Array.isArray(nodes)) return
    for (const node of nodes || []) {
      if (!node) continue
      const record = asRecord(node)
      if (!record) continue
      if (typeof record.url === 'string' && record.url) urls.add(record.url)
      else if (Array.isArray(record.children)) walk(record.children)
    }
  }
  const bookmarks = parsed && parsed.bookmarks
  if (bookmarks && bookmarks.ok && Array.isArray(bookmarks.trees)) {
    for (const tree of bookmarks.trees) walk(tree?.children)
  }
  const history = parsed && parsed.history
  if (history && history.ok && Array.isArray(history.visits)) {
    for (const item of history.visits) {
      if (item && typeof item.url === 'string' && item.url) urls.add(item.url)
    }
  }
  return urls
}

/**
 */
export function applyImportedFavicons(
  parsed: ImportedParsedData | null | undefined,
  index: ParsedFavicons | { ok: false; error: string } | null | undefined,
  faviconService: ImportedFaviconService | null | undefined
): ImportedFaviconStats {
  const stats: ImportedFaviconStats = { attached: 0, icons: 0 }
  if (!parsed || !index || !index.ok) return stats
  if (!faviconService || typeof faviconService.putIcon !== 'function') return stats

  /** iconId → 本地图标地址（同一张图只入库一次、只算一次哈希） */
  const urlByIconId = new Map<string, string | null>()
  const iconUrlFor = (iconId: string | undefined): string | null => {
    if (!iconId) return null
    if (urlByIconId.has(iconId)) return urlByIconId.get(iconId) ?? null
    const icon = index.icons.get(iconId)
    const url = icon ? faviconService.putIcon(icon.buffer, icon.contentType) : null
    urlByIconId.set(iconId, url || null)
    if (url) stats.icons++
    return url || null
  }
  const resolve = (pageUrl: string): string | null => {
    const origin = originOf(pageUrl)
    const iconId = index.pages.get(pageUrl) || (origin ? index.origins.get(origin) : undefined)
    return iconUrlFor(iconId)
  }

  const walk = (nodes: unknown): void => {
    if (!Array.isArray(nodes)) return
    for (const node of nodes || []) {
      if (!node) continue
      const record = asRecord(node)
      if (!record) continue
      if (typeof record.url === 'string' && record.url) {
        const url = resolve(record.url)
        if (url) {
          record.favicon = url
          stats.attached++
        }
      } else if (Array.isArray(record.children)) {
        walk(record.children)
      }
    }
  }

  const bookmarks = parsed.bookmarks
  if (bookmarks && bookmarks.ok && Array.isArray(bookmarks.trees)) {
    for (const tree of bookmarks.trees) walk(tree?.children)
  }

  const history = parsed.history
  if (history && history.ok && Array.isArray(history.visits)) {
    for (const item of history.visits) {
      if (!item || typeof item.url !== 'string' || !item.url) continue
      const url = resolve(item.url)
      if (url) {
        item.favicon = url
        stats.attached++
      }
    }
  }

  return stats
}

/**
 * 收集「页面地址 → 本地图标地址」的赋值表（只含有图标的项）。
 * 用途：写库之后补齐先前导入、favicon 为空的行（书签 / 历史的 backfillFavicons）。
 */
export function collectIconAssignments(parsed: ImportedParsedData | null | undefined): Map<string, string> {
  const map = new Map<string, string>()
  const walk = (nodes: unknown): void => {
    if (!Array.isArray(nodes)) return
    for (const node of nodes || []) {
      if (!node) continue
      const record = asRecord(node)
      if (!record) continue
      if (typeof record.url === 'string' && record.url) {
        if (typeof record.favicon === 'string' && record.favicon) map.set(record.url, record.favicon)
      } else if (Array.isArray(record.children)) {
        walk(record.children)
      }
    }
  }
  const bookmarks = parsed && parsed.bookmarks
  if (bookmarks && bookmarks.ok && Array.isArray(bookmarks.trees)) {
    for (const tree of bookmarks.trees) walk(tree?.children)
  }
  const history = parsed && parsed.history
  if (history && history.ok && Array.isArray(history.visits)) {
    for (const item of history.visits) {
      if (typeof item.url === 'string' && item.url && typeof item.favicon === 'string' && item.favicon) {
        map.set(item.url, item.favicon)
      }
    }
  }
  return map
}

