/**
 * Chromium `Bookmarks` JSON → 可写入的书签树
 *
 * 源结构（只取需要的字段，其余一概不认）：
 *   roots.bookmark_bar / other / synced → children[]
 *   节点：{ type: 'url', name, url, date_added, guid }
 *         { type: 'folder', name, children[] }
 *
 * 出口与 `domain-bookmark#importTrees` 的入参逐字对齐：
 *   [{ title, children: [{ title, url?, dateAdded? }] }]
 *
 * 只做「翻译」，不做去重 / 排序 / 落库 —— 那些是 domain 的职责；
 * 这里提前丢掉空文件夹与非法 URL，避免把噪声带进写入事务。
 */
import fs from 'node:fs'
import { webkitToUnixMs } from './time'

/**
 * 三个根挂载点的展示名（顺序即导入后的顶层顺序）。
 * 第三项 `pinToBar`：该根的直接子项在目标浏览器里**固定到书签栏** ——
 *   Chromium 系的书签栏展示的就是 bookmark_bar 的直接子项（书签与文件夹），
 *   所以导入时把这一层原样映射成 pinned，其余两个根只进收藏面板。
 */
export interface BookmarkTreeNode {
  title: string
  url?: string
  dateAdded?: number
  guid?: string
  children?: BookmarkTreeNode[]
}

export interface BookmarkTree {
  title: string
  children: BookmarkTreeNode[]
  pinned?: true
}

export type ParseBookmarksResult = { ok: true; trees: BookmarkTree[]; count: number } | { ok: false; error: string }

export const ROOT_DATASETS = [
  ['bookmark_bar', '书签栏', true],
  ['other', '其他书签', false],
  ['synced', '移动设备书签', false]
 ] as const

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' ? value as Record<string, unknown> : null
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function toNode(raw: unknown): BookmarkTreeNode | null {
  const node = asRecord(raw)
  if (!node) return null
  const type = String(node.type || '')
  const title = typeof node.name === 'string' ? node.name : ''

  if (type === 'url') {
    const url = typeof node.url === 'string' ? node.url.trim() : ''
    if (!url) return null
    if (!/^https?:\/\//i.test(url)) return null
    const dateAdded = webkitToUnixMs(node.date_added)
    return {
      title: title.trim() || url,
      url,
      ...(dateAdded ? { dateAdded } : {}),
      ...(typeof node.guid === 'string' && node.guid ? { guid: node.guid } : {})
    }
  }

  // folder（Chromium 也只有 url / folder 两种类型）
  const children = Array.isArray(node.children)
    ? node.children.map(toNode).filter((child): child is BookmarkTreeNode => child !== null)
    : []
  if (children.length === 0) return null
  return { title: title.trim() || '未命名文件夹', children }
}

function countUrls(nodes: readonly BookmarkTreeNode[]): number {
  let total = 0
  for (const node of nodes || []) {
    if (node && node.url) total++
    else if (node && Array.isArray(node.children)) total += countUrls(node.children)
  }
  return total
}

export function parseBookmarksFile(filePath: string): ParseBookmarksResult {
  let raw: string
  try {
    raw = fs.readFileSync(filePath, 'utf8')
  } catch (e) {
    return { ok: false, error: `读取书签文件失败：${errorMessage(e)}` }
  }

  let json: unknown
  try {
    json = JSON.parse(raw)
  } catch (_) {
    return { ok: false, error: '书签文件不是有效的 JSON（可能已损坏）' }
  }

  const roots = asRecord(asRecord(json)?.roots)
  if (!roots) {
    return { ok: false, error: '书签文件缺少 roots 结构' }
  }

  const trees: BookmarkTree[] = []
  for (const [key, label, pinToBar] of ROOT_DATASETS) {
    const root = asRecord(roots[key])
    if (!root || !Array.isArray(root.children)) continue
    const children = root.children.map(toNode).filter((child): child is BookmarkTreeNode => child !== null)
    if (children.length === 0) continue
    // `pinned` 由 domain 解释：只固定这一层的直接子项，嵌套层级不固定。
    trees.push(pinToBar ? { title: label, children, pinned: true } : { title: label, children })
  }

  return { ok: true, trees, count: countUrls(trees) }
}

