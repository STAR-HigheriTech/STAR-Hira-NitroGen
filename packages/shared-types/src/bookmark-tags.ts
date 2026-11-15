/**
 * bookmark-tags.mjs —— 书签标签的**唯一真源**（纯函数，零 IO / 零依赖）。
 *
 * 三处消费者跑同一份规则：
 *   · 主进程 domain-bookmark（`require()`，Node 24 可直接加载 ESM）
 *   · 渲染层收藏面板（打包 ESM `import`）
 *   · `hira://` 内部书签页（静态页，经 `hira://shared/bookmark-tags.mjs` 引用）
 *
 * 两个**系统标签**（固定到书签栏 / 固定到 rail）不是存储在 `tags` 列里的字符串，
 * 而是由 `pinned` / `railPinned` 两列**派生**出来的虚拟标签：
 *
 *   · 单一事实源：固定状态只有一列，不会出现「tags 里有 system:pinned 但 pinned=0」
 *     这种两份真相互相打架的脏数据；
 *   · 统一视图：筛选栏、批量打标签、右键菜单读的是同一套 `rowHasTag()`
 *     「书签 / 文件夹 / 系统标签」一视同仁 —— UI 不必为系统标签写第二套分支；
 *   · 写入方向：只有 `system:` 前缀的标签在写路径上被解释为固定开关，
 *     用户标签里同前缀的字符串一律剥掉（该前缀保留给系统）。
 *
 * 约定：`row.tags` 是**已归一化**的字符串数组（domain 出口已把 JSON 解析成数组）。
 */

/** 系统标签：固定到书签栏 */
export const SYSTEM_TAG_PINNED = 'system:pinned'
/** 系统标签：固定到 rail（侧栏图标栏） */
export const SYSTEM_TAG_RAIL = 'system:rail'
/** 系统标签保留前缀 —— 用户标签不得占用 */
export const SYSTEM_TAG_PREFIX = 'system:'

/**
 * 系统标签清单。`field` 指明它映射到哪一列（写路径据此落库），
 * `label` 是界面展示名（与书签栏 / rail 两个固定位的叫法保持一致）。
 */
export const SYSTEM_TAGS = Object.freeze([
  Object.freeze({
    id: SYSTEM_TAG_PINNED,
    label: '书签栏',
    shortLabel: '书签栏',
    field: 'pinned',
    description: '固定到书签栏'
  }),
  Object.freeze({
    id: SYSTEM_TAG_RAIL,
    label: '侧栏图标栏',
    shortLabel: '侧栏',
    field: 'railPinned',
    description: '固定到侧栏图标栏'
  })
])

export interface BookmarkTagRow {
  id?: string | number
  title?: unknown
  url?: unknown
  parentId?: string | number | null
  tags?: unknown
  pinned?: unknown
  railPinned?: unknown
  children?: BookmarkTagRow[]
}

/** @type {Map<string, (typeof SYSTEM_TAGS)[number]>} */
const SYSTEM_TAG_BY_ID: Map<string, (typeof SYSTEM_TAGS)[number]> = new Map<string, (typeof SYSTEM_TAGS)[number]>(
  SYSTEM_TAGS.map((meta) => [meta.id, meta])
)

/** @param {unknown} tag @returns {string} */
export function normalizeTag(tag: unknown) {
  return String(tag == null ? '' : tag).trim()
}

/**
 * 标签数组归一化：去空白、去重（**大小写不敏感**去重，保留首次出现的写法）。
 * @param {unknown} tags
 * @returns {string[]}
 */
export function normalizeTagList(tags: unknown) : string[] {
  if (!Array.isArray(tags)) return []
  const seen = new Set()
  /** @type {string[]} */
  const out: string[] = []
  for (const raw of tags) {
    const tag = normalizeTag(raw)
    if (!tag) continue
    const key = tag.toLowerCase()
    if (seen.has(key)) continue
    seen.add(key)
    out.push(tag)
  }
  return out
}

/**
 * 是否落在系统标签保留命名空间里（含未知的 `system:xxx`）。
 * @param {unknown} tag
 */
export function isSystemTagLike(tag: unknown) {
  return normalizeTag(tag).toLowerCase().startsWith(SYSTEM_TAG_PREFIX)
}

/** 是否是**已定义**的系统标签。 */
/** @param {unknown} tag @returns {boolean} */
export function isSystemTag(tag: unknown) {
  return SYSTEM_TAG_BY_ID.has(normalizeTag(tag))
}

/** 系统标签元信息（非系统标签返回 null）。 */
/** @param {unknown} tag @returns {(typeof SYSTEM_TAGS)[number]|null} */
export function systemTagMeta(tag: unknown) {
  return SYSTEM_TAG_BY_ID.get(normalizeTag(tag)) || null
}

/**
 * 剥掉系统标签（含未知的 `system:*`），只留下用户可以自由编辑的标签。
 * 写路径（新增 / 编辑 / 批量打标签）都必须过这一层。
 * @param {unknown} tags
 * @returns {string[]}
 */
export function stripSystemTags(tags: unknown) : string[] {
  return normalizeTagList(tags).filter((tag) => !isSystemTagLike(tag))
}

/**
 * 标签展示名：系统标签用中文名，用户标签原样。
 * @param {unknown} tag
 */
export function tagLabel(tag: unknown) {
  const meta = systemTagMeta(tag)
  return meta ? meta.label : normalizeTag(tag)
}

/** 一行（书签或文件夹）是否带有某个标签（系统标签走固定列）。 */
/** @param {BookmarkTagRow|null|undefined} row @param {unknown} tag @returns {boolean} */
export function rowHasTag(row: BookmarkTagRow|null|undefined, tag: unknown) {
  if (!row) return false
  const wanted = normalizeTag(tag)
  if (!wanted) return false
  const meta = systemTagMeta(wanted)
  if (meta) return !!row[meta.field]
  const key = wanted.toLowerCase()
  const tags = Array.isArray(row.tags) ? row.tags : []
  return tags.some((t) => normalizeTag(t).toLowerCase() === key)
}

/** 这一行携带的系统标签 id。 */
/** @param {BookmarkTagRow|null|undefined} row @returns {string[]} */
export function rowSystemTags(row: BookmarkTagRow|null|undefined) {
  if (!row) return []
  return SYSTEM_TAGS.filter((meta) => !!row[meta.field]).map((meta) => meta.id)
}

/**
 * 这一行的**全部**标签（用户标签在前、系统标签在后）——
 * 行内胶囊、右键「移除标签」都用它，避免各处再拼一次。
 * @returns {string[]}
 */
/** @param {BookmarkTagRow|null|undefined} row @returns {string[]} */
export function allTagsOfRow(row: BookmarkTagRow|null|undefined) : string[] {
  if (!row) return []
  return [...normalizeTagList(row.tags), ...rowSystemTags(row)]
}

/** 按标签过滤一组扁平行。 */
/** @template {BookmarkTagRow} T @param {readonly T[]|null|undefined} rows @param {unknown} tag @returns {readonly T[]} */
export function filterRowsByTag<T extends BookmarkTagRow>(rows: readonly T[] | null | undefined, tag: unknown): readonly T[] {
  if (!normalizeTag(tag)) return Array.isArray(rows) ? rows : []
  return (rows || []).filter((row) => rowHasTag(row, tag))
}

/**
 * 按标签过滤**树**：
 *   · 自身命中 → 整棵子树保留（"这个文件夹就是这个标签的"）；
 *   · 否则只保留含命中后代的文件夹（路径要留着，否则命中项无处挂）。
 * 返回浅拷贝，绝不改动源树（源树还给拖拽 / 移动用）。
 */
/** @param {readonly BookmarkTagRow[]|null|undefined} nodes @param {unknown} tag @returns {BookmarkTagRow[]} */
export function filterTreeByTag(nodes: readonly BookmarkTagRow[]|null|undefined, tag: unknown): BookmarkTagRow[] {
  const wanted = normalizeTag(tag)
  const list = Array.isArray(nodes) ? nodes : []
  if (!wanted) return list
  /** @type {BookmarkTagRow[]} */
  const out: BookmarkTagRow[] = []
  for (const node of list) {
    if (!node) continue
    if (rowHasTag(node, wanted)) {
      out.push(node)
      continue
    }
    if (node.url) continue
    const kids: BookmarkTagRow[] = filterTreeByTag(node.children || [], wanted)
    if (kids.length) out.push({ ...node, children: kids })
  }
  return out
}

/**
 * 树扁平化：把带 children 的树按先序展开成扁平行（含文件夹自身）。
 *
 * 标签视图需要的是"真正命中这个标签的行"，而不是"为了保留路径而留下的祖先文件夹" ——
 * 所以在标签视图里先扁平化再用 `filterRowsByTag`，文件夹只在**它自己带标签**时出现。
 * @param {Array<{ children?: any[] }>} nodes
 * @returns {any[]}
 */
/** @param {readonly BookmarkTagRow[]|null|undefined} nodes @returns {BookmarkTagRow[]} */
export function flattenTree(nodes: readonly BookmarkTagRow[]|null|undefined): BookmarkTagRow[] {
  /** @type {BookmarkTagRow[]} */
  const out: BookmarkTagRow[] = []
  /** @param {readonly BookmarkTagRow[]|null|undefined} list */
  const walk = (list: readonly BookmarkTagRow[]|null|undefined): void => {
    for (const node of list || []) {
      if (!node) continue
      out.push(node)
      if (Array.isArray(node.children) && node.children.length) walk(node.children)
    }
  }
  walk(nodes)
  return out
}

/**
 * 文件夹查找表：`id → { id, title, parentId, path }`。
 *
 * 标签视图的"时间轴分段"要用父文件夹的标题与完整路径做组头，
 * 而扁平行只带 parentId —— 路径必须从树里算，不能每行各自向上查一遍（O(n·d)）。
 * @param {any[]} tree
 * @returns {Map<string, { id: string, title: string, parentId: string|null, path: string }>}
 */
/** @param {readonly BookmarkTagRow[]|null|undefined} tree @returns {Map<string, { id: string, title: string, parentId: string|null, path: string }>} */
export function buildFolderLookup(tree: readonly BookmarkTagRow[]|null|undefined) : Map<string, { id: string, title: string, parentId: string|null, path: string }> {
  /** @type {Map<string, { id: string, title: string, parentId: string|null, path: string }>} */
  const lookup: Map<string, { id: string, title: string, parentId: string|null, path: string }> = new Map()
  /** @param {readonly BookmarkTagRow[]|null|undefined} list @param {string[]} trail */
  const walk = (list: readonly BookmarkTagRow[]|null|undefined, trail: string[]) => {
    for (const node of list || []) {
      if (!node || node.url) continue
      const title = String(node.title || '未命名文件夹')
      const path = [...trail, title]
      const id = String(node.id == null ? '' : node.id)
      lookup.set(id, {
        id,
        title,
        parentId: node.parentId == null ? null : String(node.parentId),
        path: path.join(' / ')
      })
      walk(node.children, path)
    }
  }
  walk(tree, [])
  return lookup
}

/**
 * 把扁平行按**父文件夹**分组成时间轴分段（标签视图专用）。
 *
 * 为什么不用嵌套树：标签视图里"文件夹本身带标签"与"文件夹里的条目带标签"如果都画成
 * 可展开的文件夹，就会和「整个文件夹被固定」的展示重复，用户分不清哪些是筛选结果、
 * 哪些是容器。分组后每个父文件夹只出现**一行组头**，命中的行缩进挂在它下面，
 * 语义只有一种：组头是"这些条目原来在哪儿"，行才是筛选结果。
 *
 * 组顺序：根目录组永远在最前，其余按路径字典序（稳定、可预期）。
 * 父文件夹已不存在（被删/被移走）的行归入根组，绝不丢行。
 *
 * @param {readonly BookmarkTagRow[]|null|undefined} rows 扁平行
 * @param {Map<string, { id: string, title: string, parentId: string|null, path: string }>} lookup buildFolderLookup 的结果
 * @param {string} [rootLabel] 根目录组的标题
 * @returns {Array<{ id: string|null, title: string, path: string, rows: any[] }>}
 */
export function groupRowsByFolder(rows: readonly BookmarkTagRow[]|null|undefined, lookup: Map<string, { id: string, title: string, parentId: string|null, path: string }>, rootLabel: string = '根目录') : Array<{ id: string|null, title: string, path: string, rows: BookmarkTagRow[] }> {
  /** @type {Map<string, { id: string|null, title: string, path: string, rows: BookmarkTagRow[] }>} */
  const groups: Map<string, { id: string|null, title: string, path: string, rows: BookmarkTagRow[] }> = new Map()
  for (const row of rows || []) {
    if (!row) continue
    const parentId = row.parentId == null ? '' : String(row.parentId)
    const folder = parentId && lookup ? lookup.get(parentId) : null
    const key = folder ? folder.id : ''
    if (!groups.has(key)) {
      groups.set(key, {
        id: folder ? folder.id : null,
        title: folder ? folder.title : rootLabel,
        path: folder ? folder.path : '',
        rows: []
      })
    }
    const group = groups.get(key)
    if (group) group.rows.push(row)
  }
  return [...groups.values()].sort((a, b) => {
    if (a.id === null) return -1
    if (b.id === null) return 1
    return a.path.localeCompare(b.path)
  })
}

/**
 * 标签分类栏的数据源：系统标签（始终出现，哪怕计数为 0）+ 用户标签（按热度降序）。
 *
 * 一次遍历即可：系统标签计数由 `pinned` / `railPinned` 直接累加，
 * 用户标签按大小写归并（展示保留首次出现的写法）。
 *
 * @param {Array<{ tags?: string[]|null, pinned?: boolean, railPinned?: boolean }>} rows
 * @param {{ limit?: number }} [opts] limit 只约束用户标签数量（系统标签不受限）
 * @returns {Array<{ tag: string, count: number, system: boolean, label: string }>}
 */
/** @param {readonly BookmarkTagRow[]|null|undefined} rows @param {{ limit?: number }} [opts] */
export function buildTagCounts(rows: readonly BookmarkTagRow[]|null|undefined, { limit = 100 } = {}) : Array<{ tag: string, count: number, system: boolean, label: string }> {
  const systemCounts = new Map(SYSTEM_TAGS.map((meta) => [meta.id, 0]))
  /** @type {Map<string, { tag: string, count: number }>} */
  const userCounts: Map<string, { tag: string, count: number }> = new Map()

  for (const row of rows || []) {
    if (!row) continue
    for (const meta of SYSTEM_TAGS) if (row[meta.field]) systemCounts.set(meta.id, (systemCounts.get(meta.id) || 0) + 1)
    for (const tag of normalizeTagList(row.tags)) {
      if (isSystemTagLike(tag)) continue
      const key = tag.toLowerCase()
      const hit = userCounts.get(key)
      if (hit) hit.count++
      else userCounts.set(key, { tag, count: 1 })
    }
  }

  const userRows = [...userCounts.values()]
    .sort((a, b) => b.count - a.count || a.tag.localeCompare(b.tag))
    .slice(0, Math.max(0, limit))

  return [
    ...SYSTEM_TAGS.map((meta) => ({
      tag: meta.id,
      count: systemCounts.get(meta.id) || 0,
      system: true,
      label: meta.label
    })),
    ...userRows.map((row) => ({ tag: row.tag, count: row.count, system: false, label: row.tag }))
  ]
}
