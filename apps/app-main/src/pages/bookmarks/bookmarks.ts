/**
 * 书签页（`hira://bookmarks`）—— 收藏子系统的管理界面。
 *
 * 边界（与收藏面板同一条口子）：
 *   · 数据只经 `bookmarksClient`（→ 主进程 IPC → domain-bookmark），页面不做缓存也不拼 SQL；
 *   · 所有写操作完成后由 `bookmark:changed` 广播驱动刷新，页面自己不发明"写后重拉"逻辑；
 *   · 视图状态（当前文件夹 / 搜索词 / 标签筛选 / 选中集）只存在页面内存，
 *     不进设置、不进库 —— 它们描述的是"这一次浏览"，不是用户配置。
 *
 * 与收藏面板（`ui/ui-panel-favorites`）共享的能力面：文件夹树、多选批量、拖拽三分带、
 * 上下文菜单、固定位（书签栏 / rail 两个独立开关）、打开偏好。面板是"随手收"，
 * 本页是"整理"，两者读写同一份 domain —— 不存在第二套书签逻辑。
 */
import {
  IPC_ROUTES, rpc, el, faviconBadge, fmtTime, fmtSize, renderEmpty,
  initTheme, uiIconSvg, popupMenu, openLink
} from 'hira://shared/runtime.js'
import { bookmarksClient, type BookmarkImportFormat } from 'hira://shared/bookmarks-client.js'
// 标签规则**唯一真源**（与主进程 domain、收藏面板共用同一份）：
// 系统标签 = 由 pinned / railPinned 派生的虚拟标签，因此筛选、胶囊、批量打标签
// 全部走这里的函数，页面里不再出现"自己判断 tags 数组"的第二套逻辑。
import {
  normalizeTagList, tagLabel, allTagsOfRow, isSystemTagLike,
  buildFolderLookup, groupRowsByFolder, SYSTEM_TAG_PINNED, SYSTEM_TAG_RAIL
} from 'hira://shared/bookmark-tags.mjs'
// 功能面可用性：与公共侧栏 / ⋮ 菜单 / 应用菜单同一份判据（`main/feature-map.js`）。
// 页面不自己翻插件状态，只问「这个功能面现在可用吗」。
import { onFeatureAvailability } from 'hira://shared/features-client.js'
import type { PageMenuItem, PageRpcRecord } from 'hira://shared/runtime.js'
import { bookmarksRouteHref, readBookmarksRoute } from './route.js'
import type { BookmarksRoute } from './route.js'
import type {
  BookmarkBackup, BookmarkFeedback, BookmarkNode, BookmarkPathItem, BookmarkRestoreResult,
  BookmarkSnapshot, BookmarksDom, BookmarksState
} from './types.js'

function requiredElement<T extends HTMLElement>(id: string): T {
  const node = document.getElementById(id)
  if (!node) throw new Error(`[bookmarks] missing #${id}`)
  return node as T
}

initTheme()

const dom: BookmarksDom = {
  list: requiredElement('list'),
  tree: requiredElement('folder-tree'),
  breadcrumb: requiredElement('breadcrumb'),
  newBookmark: requiredElement<HTMLButtonElement>('new-bookmark'),
  search: requiredElement<HTMLInputElement>('search'),
  tagBar: requiredElement('tag-bar'),
  note: requiredElement('toolbar-note'),
  feedback: requiredElement('feedback'),
  batchBar: requiredElement('batch-bar'),
  batchCount: requiredElement('batch-count'),
  selectAll: requiredElement<HTMLInputElement>('batch-select-all'),
  batchTag: requiredElement<HTMLButtonElement>('batch-tag'),
  batchPin: requiredElement<HTMLButtonElement>('batch-pin'),
  batchRail: requiredElement<HTMLButtonElement>('batch-rail'),
  batchMove: requiredElement<HTMLButtonElement>('batch-move'),
  aiDigest: requiredElement<HTMLButtonElement>('ai-digest'),
  batchAiDigest: requiredElement<HTMLButtonElement>('batch-ai-digest'),
  batchDelete: requiredElement<HTMLButtonElement>('batch-delete'),
  batchCancel: requiredElement<HTMLButtonElement>('batch-cancel'),
  importFile: requiredElement<HTMLInputElement>('import-file')
}

const initialRoute = readBookmarksRoute(location.search)

const state: BookmarksState = {
  /** 'list' | 'backups' —— 备份记录是同一页里的第二种视图，不另开页面。 */
  mode: initialRoute.mode,
  folderId: initialRoute.folderId,
  /** 当前文件夹的祖先链 [{ id, title }]（面包屑用；每次刷新从树里重算）。 */
  path: [],
  query: initialRoute.query,
  /** 选中的标签（'' = 全部）。系统标签（书签栏 / 侧栏）与用户标签走同一条路径。 */
  tag: initialRoute.tag,
  /** 文件夹树收起状态：只影响左侧导航的展开，不改变当前实际目录。 */
  treeCollapsed: new Set<string>(),
  /** 标签视图里被收起的**分组** id（'' = 根目录组）；会话内记忆，不进库。 */
  tagCollapsed: new Set<string>(),
  items: [],
  tree: [],
  /** 标签分类栏数据（随 snapshot 一起返回，单一来源，不再单独发 IPC）。 */
  tags: [],
  selected: new Set<string>(),
  /** 备份视图里的份数（只用于工具条汇总文案）。 */
  backupsCount: 0,
  /** 正在编辑摘要的书签 id（同时只允许一个行内编辑器）。 */
  editingId: null,
  summaryBox: null,
  /** 正在树内联重命名的文件夹 id。 */
  renamingId: null,
  pendingRefresh: false,
  importFormat: '',
  /** 首屏加载状态：失败时提供"重试"，可见性变化时据此补刷。 */
  loadFailed: false,
  lastLoadedAt: 0
}

dom.search.value = state.query
let revealFolderOnNextRefresh = true

/* ============================================================
 * 小工具
 * ============================================================ */

const isFolder = (node: unknown): node is BookmarkNode => {
  if (!node || typeof node !== 'object') return false
  const value = node as { url?: string | null }
  return value.url === null || value.url === undefined
}

function icon (name: string, size = 15): SVGElement | null {
  return uiIconSvg(document, name, { size })
}

function iconButton (name: string, title: string): HTMLButtonElement {
  const btn = el('button', 'icon-btn')
  btn.type = 'button'
  btn.title = title
  btn.setAttribute('aria-label', title)
  const svg = icon(name)
  if (svg) btn.appendChild(svg)
  else btn.textContent = '•'
  return btn
}

let feedbackTimer = 0
function showFeedback (text: string, type: 'info' | 'success' | 'error' = 'info'): void {
  dom.feedback.textContent = text
  dom.feedback.dataset.type = type
  dom.feedback.hidden = false
  window.clearTimeout(feedbackTimer)
  feedbackTimer = window.setTimeout(() => { dom.feedback.hidden = true }, 3200)
}

/** IPC 错误 → 可读中文（端口缺席时桥返回的英文对用户没有意义）。 */
function actionError (error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error || '')
  if (/no handler|not registered|not found/i.test(raw)) return '该能力尚未就绪，请稍后重试'
  return raw || '操作失败'
}

function walk (nodes: BookmarkNode[] | undefined, fn: (node: BookmarkNode) => void) {
  for (const node of nodes || []) {
    fn(node)
    if (node.children && node.children.length) walk(node.children, fn)
  }
}

function findNode (nodes: BookmarkNode[] | undefined, id: string | null | undefined): BookmarkNode | null {
  if (!id) return null
  let found: BookmarkNode | null = null
  walk(nodes, (node) => { if (!found && node.id === id) found = node })
  return found
}

/** 从根到目标文件夹的路径（不含目标？含目标 —— 面包屑直接按顺序铺）。 */
function pathTo (
  nodes: BookmarkNode[] | undefined,
  id: string,
  trail: BookmarkPathItem[] = []
): BookmarkPathItem[] | null {
  for (const node of nodes || []) {
    if (isFolder(node)) {
      const next = trail.concat([{ id: node.id, title: node.title || '未命名文件夹' }])
      if (node.id === id) return next
      const deeper = pathTo(node.children || [], id, next)
      if (deeper) return deeper
    }
  }
  return null
}

/** 一次遍历建好所有文件夹的递归书签数；列表与树共用，避免每个节点重复扫子树。 */
let folderBookmarkCounts = new Map<string, number>()
let totalBookmarkCount = 0

function rebuildFolderCounts (nodes: readonly BookmarkNode[]): number {
  const counts = new Map<string, number>()
  const visit = (list: readonly BookmarkNode[]): number => {
    let total = 0
    for (const node of list) {
      if (isFolder(node)) {
        const nested = visit(node.children || [])
        counts.set(node.id, nested)
        total += nested
      } else {
        total++
      }
    }
    return total
  }
  const total = visit(nodes)
  folderBookmarkCounts = counts
  totalBookmarkCount = total
  return total
}

/** target 是否位于 root 的子树（含 root 自身）—— 防止把文件夹拖进自己。 */
function isWithin (rootId: string | null | undefined, targetId: string | null | undefined) {
  if (!rootId || !targetId) return false
  const root = findNode(state.tree, rootId)
  if (!root) return false
  let hit = false
  walk([root], (node) => { if (node.id === targetId) hit = true })
  return hit
}

function rowFor (id: string): HTMLElement | null {
  try {
    return dom.list.querySelector<HTMLElement>(`.row[data-id="${CSS.escape(id)}"]`)
  } catch (_) {
    return null
  }
}

/* ============================================================
 * 取数 + 渲染
 * ============================================================ */

/** 当前视图 → URL。显式导航 push，连续输入 replace，避免筛选把历史记录刷爆。 */
function replaceBookmarksRoute (push = false) {
  const href = bookmarksRouteHref(location.href, {
    mode: state.mode,
    folderId: state.folderId,
    tag: state.tag,
    query: state.query
  })
  if (href !== location.pathname + location.search + location.hash) {
    if (push) history.pushState(history.state, '', href)
    else history.replaceState(history.state, '', href)
  }
}

/** 浏览器前进/后退与外部深链共用同一条状态装配路径。 */
async function applyBookmarksRoute (route: BookmarksRoute) {
  closeSummaryEditor()
  state.mode = route.mode
  state.folderId = route.folderId
  state.tag = route.tag
  state.query = route.query
  revealFolderOnNextRefresh = true
  state.selected.clear()
  dom.search.value = route.query
  if (route.mode === 'backups') await loadBackups()
  else await refresh()
}

let refreshSeq = 0

/**
 * 快照失败重试。
 *
 * 为什么需要：书签刚导入完（主进程写事务 + 索引维护）或备份恢复的瞬间，
 * 首次读可能拿到异常/空快照 —— 早期版本在这种情况下直接把列表画成空，
 * 用户看到的就是"导入的书签没出来"。退避重试让这个瞬时状态自愈；
 * 仍然失败才展示错误 + 重试按钮（而不是假装库里没有数据）。
 */
const RETRY_DELAYS = [0, 120, 350, 800]
const sleep = (ms: number) => new Promise<void>((resolve) => window.setTimeout(resolve, ms))

async function fetchSnapshot (token: number): Promise<BookmarkFeedback> {
  let lastError: unknown = null
  for (const delay of RETRY_DELAYS) {
    if (delay) await sleep(delay)
    if (token !== refreshSeq) return { cancelled: true }
    try {
      const response = await bookmarksClient.snapshot(state.folderId, state.tag, state.query)
      const snap = response as unknown as BookmarkSnapshot
      if (snap && Array.isArray(snap.folders)) {
        return {
          snap: {
            ...snap,
            items: Array.isArray(snap.items) ? snap.items : [],
            folders: snap.folders,
            tags: Array.isArray(snap.tags) ? snap.tags : []
          }
        }
      }
      lastError = new Error('快照格式异常')
    } catch (e) {
      lastError = e
    }
  }
  return { error: lastError }
}

async function refresh () {
  if (state.mode === 'backups') {
    await loadBackups()
    return
  }
  const token = ++refreshSeq
  const snapResult = await fetchSnapshot(token)
  if (snapResult.cancelled || token !== refreshSeq) return
  if (snapResult.error) {
    state.loadFailed = true
    renderLoadError(snapResult.error)
    return
  }

  const snap = snapResult.snap
  if (!snap) {
    state.loadFailed = true
    renderLoadError(new Error('快照格式异常'))
    return
  }
  state.loadFailed = false
  state.lastLoadedAt = Date.now()
  state.tree = snap.folders
  rebuildFolderCounts(state.tree)
  state.tags = snap.tags

  // 文件夹被别处删掉 / 移走时，别让页面停在一个不存在的目录上
  let routeRepaired = false
  if (state.folderId && !findNode(state.tree, state.folderId)) {
    state.folderId = null
    state.path = []
    routeRepaired = true
  }
  if (state.tag && !state.tags.some((entry) => entry.tag === state.tag)) {
    state.tag = ''
    routeRepaired = true
  }
  if (routeRepaired) {
    replaceBookmarksRoute()
    await refresh()
    return
  }
  state.path = state.folderId ? (pathTo(state.tree, state.folderId) || []) : []
  if (revealFolderOnNextRefresh) {
    for (const crumb of state.path) state.treeCollapsed.delete(crumb.id)
    revealFolderOnNextRefresh = false
  }

  // 标签与关键词都在 domain 的同一次 snapshot 中求交：标签保持跨文件夹语义，
  // 关键词保持 FTS / LIKE 的相关度顺序，页面不再并发发第二条 search IPC。
  // 新 Provider 会回显 query；旧 Provider 若忽略该参数，页面只在当前已取回的
  // items 内做一次本地兜底，避免页面把未过滤结果当成搜索结果。
  const items = state.query && snap.query !== state.query
    ? localSearch(snap.items, state.query)
    : snap.items
  state.items = items

  // 选中集只保留仍然可见的项（跨文件夹导航 / 筛选切换不残留幽灵选中）
  const visible = new Set(state.items.map((item) => item.id))
  for (const id of state.selected) if (!visible.has(id)) state.selected.delete(id)

  renderTree()
  renderTagBar()
  renderBreadcrumb()
  renderList()
  renderBatch()
  renderNote()
}

/** 搜索兜底：与 domain 的 LIKE 分支同一口径（标题 / 网址 / 标签 任一命中）。 */
function localSearch (items: BookmarkNode[], query: string) {
  const q = String(query || '').toLowerCase()
  if (!q) return items
  return items.filter((row) => {
    return String(row.nickname || '').toLowerCase().includes(q) ||
      String(row.title || '').toLowerCase().includes(q) ||
      String(row.url || '').toLowerCase().includes(q) ||
      normalizeTagList(row.tags).some((tag) => tag.toLowerCase().includes(q))
  })
}

function renderLoadError (error: unknown) {
  renderEmpty(dom.list, '书签加载失败：' + actionError(error))
  const empty = dom.list.querySelector('.empty')
  if (!empty) return
  const retry = el('button', 'btn btn-sm', '重试')
  retry.onclick = () => refresh()
  empty.appendChild(retry)
}

/* ── 文件夹树 ───────────────────────────────────────────────────────────── */

function renderTree () {
  dom.tree.textContent = ''
  const frag = document.createDocumentFragment()

  const root = el('div', 'tree-row')
  root.dataset.folderId = ''
  root.style.paddingLeft = '8px'
  if (state.folderId === null) root.classList.add('active')
  root.appendChild(el('span', 'tree-caret-spacer'))
  const rootIcon = icon('bookmark')
  if (rootIcon) {
    const wrap = el('span', 'tree-icon')
    wrap.appendChild(rootIcon)
    root.appendChild(wrap)
  }
  root.appendChild(el('span', 'tree-label', '全部书签'))
  root.appendChild(el('span', 'tree-count', String(totalBookmarkCount)))
  root.onclick = () => navigateTo(null)
  root.oncontextmenu = (event: MouseEvent) => { event.preventDefault(); folderMenu(null, event) }
  root.addEventListener('dragover', onTreeDragOver)
  root.addEventListener('dragleave', () => root.classList.remove('drop-into'))
  root.addEventListener('drop', (event: DragEvent) => { void onTreeDrop(event, null, root) })
  frag.appendChild(root)

  const renderLevel = (nodes: readonly BookmarkNode[], depth: number): void => {
    for (const node of nodes) {
      if (!isFolder(node)) continue
      frag.appendChild(buildTreeRow(node, depth))
      if (!state.treeCollapsed.has(node.id)) renderLevel(node.children || [], depth + 1)
    }
  }
  renderLevel(state.tree, 0)
  dom.tree.appendChild(frag)
}

function buildTreeRow (node: BookmarkNode, depth: number): HTMLElement {
  const row = el('div', 'tree-row')
  row.dataset.folderId = node.id
  row.style.paddingLeft = (8 + (depth + 1) * 14) + 'px'
  if (node.id === state.folderId) row.classList.add('active')

  const hasChildFolders = (node.children || []).some((child) => isFolder(child))
  if (hasChildFolders) {
    const collapsed = state.treeCollapsed.has(node.id)
    const toggle = el('button', 'tree-caret' + (collapsed ? ' is-collapsed' : ''))
    toggle.type = 'button'
    toggle.title = collapsed ? '展开子文件夹' : '收起子文件夹'
    toggle.setAttribute('aria-label', toggle.title)
    toggle.setAttribute('aria-expanded', collapsed ? 'false' : 'true')
    toggle.addEventListener('click', (event: MouseEvent) => {
      event.stopPropagation()
      if (collapsed) state.treeCollapsed.delete(node.id)
      else state.treeCollapsed.add(node.id)
      renderTree()
    })
    row.appendChild(toggle)
  } else {
    row.appendChild(el('span', 'tree-caret-spacer'))
  }

  const folderIcon = icon('folder')
  if (folderIcon) {
    const wrap = el('span', 'tree-icon')
    wrap.appendChild(folderIcon)
    row.appendChild(wrap)
  }

  if (state.renamingId === node.id) {
    const input = el('input', 'tree-rename')
    input.type = 'text'
    input.value = node.title || ''
    input.maxLength = 120
    row.appendChild(input)
    let done = false
    const finish = async (commit = false): Promise<void> => {
      if (done) return
      done = true
      const title = input.value.trim()
      state.renamingId = null
      if (commit && title && title !== node.title) {
        try {
          await bookmarksClient.update(node.id, { title })
          showFeedback('已重命名', 'success')
        } catch (e) {
          showFeedback(actionError(e), 'error')
        }
      }
      renderTree()
      flushPendingRefresh()
    }
    input.onclick = (event: MouseEvent) => event.stopPropagation()
    input.onkeydown = (event: KeyboardEvent) => {
      event.stopPropagation()
      if (event.key === 'Enter') { event.preventDefault(); finish(true) }
      else if (event.key === 'Escape') { event.preventDefault(); finish(false) }
    }
    input.onblur = () => finish(false)
    window.setTimeout(() => { try { input.focus(); input.select() } catch (_) {} }, 0)
  } else {
    row.appendChild(el('span', 'tree-label', node.title || '未命名文件夹'))
    row.appendChild(el('span', 'tree-count', String(folderBookmarkCounts.get(node.id) || 0)))
  }

  row.onclick = (event: MouseEvent) => {
    if ((event.target as Element).closest('input')) return
    navigateTo(node.id)
  }
  row.oncontextmenu = (event: MouseEvent) => { event.preventDefault(); folderMenu(node, event) }
  row.addEventListener('dragover', onTreeDragOver)
  row.addEventListener('dragleave', () => row.classList.remove('drop-into'))
  row.addEventListener('drop', (event: DragEvent) => { void onTreeDrop(event, node.id, row) })
  return row
}

function onTreeDragOver (this: HTMLElement, event: DragEvent): void {
  if (!dragId || dragId === this.dataset.folderId) return
  event.preventDefault()
  if (event.dataTransfer) event.dataTransfer.dropEffect = 'move'
  this.classList.add('drop-into')
}

async function onTreeDrop (event: DragEvent, targetFolderId: string | null, row: HTMLElement): Promise<void> {
  event.preventDefault()
  row.classList.remove('drop-into')
  const moved = dragId || event.dataTransfer?.getData('text/plain') || ''
  dragId = null
  clearDropIndicator()
  if (!moved) return
  if (moved === targetFolderId) return
  if (isWithin(moved, targetFolderId)) {
    showFeedback('不能把文件夹移动到自己的子文件夹里', 'error')
    return
  }
  if (targetFolderId) state.treeCollapsed.delete(targetFolderId)
  await moveMany([moved], targetFolderId)
}

/* ── 面包屑 ─────────────────────────────────────────────────────────────── */

function renderBreadcrumb () {
  dom.breadcrumb.textContent = ''

  if (state.mode === 'backups') {
    const back = el('span', 'crumb', '← 返回书签')
    back.onclick = () => { state.mode = 'list'; replaceBookmarksRoute(true); refresh() }
    dom.breadcrumb.appendChild(back)
    dom.breadcrumb.appendChild(el('span', 'crumb-note', '备份记录（恢复会替换当前书签，恢复前会自动再备份一份）'))
    return
  }

  const root = el('span', 'crumb', '全部书签')
  if (state.folderId === null) root.classList.add('current')
  else root.onclick = () => navigateTo(null)
  dom.breadcrumb.appendChild(root)

  state.path.forEach((crumb, index) => {
    dom.breadcrumb.appendChild(el('span', 'sep', '/'))
    const node = el('span', 'crumb', crumb.title)
    if (index === state.path.length - 1) node.classList.add('current')
    else node.onclick = () => navigateTo(crumb.id)
    dom.breadcrumb.appendChild(node)
  })

  if (state.tag) {
    const label = tagLabel(state.tag)
    dom.breadcrumb.appendChild(el('span', 'crumb-note', `标签「${label}」· ${state.items.length} 条（跨文件夹）`))
    const clear = el('span', 'crumb', '清除标签')
    clear.onclick = () => setTag('')
    dom.breadcrumb.appendChild(clear)
  }
  if (state.query) {
    dom.breadcrumb.appendChild(el('span', 'crumb-note', `搜索「${state.query}」· ${state.items.length} 个结果`))
    const clear = el('span', 'crumb', '清除搜索')
    clear.onclick = () => {
      state.query = ''
      dom.search.value = ''
      replaceBookmarksRoute()
      refresh()
    }
    dom.breadcrumb.appendChild(clear)
  }
}

/* ── 列表 ───────────────────────────────────────────────────────────────── */

function renderList () {
  dom.list.textContent = ''
  state.summaryBox = null
  if (state.mode !== 'list') return

  // 标签视图是**跨文件夹的结果集**，按父文件夹分段成时间轴（见 renderTagList）
  if (state.tag) {
    renderTagList()
    return
  }

  if (!state.items.length) {
    renderEmpty(dom.list, state.query
      ? `没有匹配「${state.query}」的书签。`
      : '这个文件夹还是空的。')
    if (!state.query && !state.tag) {
      const empty = dom.list.querySelector('.empty')
      if (empty) {
        const create = el('button', 'btn btn-sm', '新建书签')
        create.type = 'button'
        create.addEventListener('click', () => { void beginNewBookmark() })
        empty.appendChild(create)
      }
    }
    return
  }

  const frag = document.createDocumentFragment()
  for (const node of state.items) {
    frag.appendChild(isFolder(node) ? buildFolderRow(node) : buildBookmarkRow(node))
  }
  dom.list.appendChild(frag)
}

/**
 * 标签视图（时间轴分段）。
 *
 * 标签视图拿到的本来就是跨文件夹的扁平行（domain 已按标签过滤），
 * 若照树渲染，每一行的祖先文件夹都会被"为了保留路径"画成容器 ——
 * 于是列表里既有文件夹又有它的子项，与「整个文件夹被固定」的展示撞车。
 *
 * 于是这里只保留两种东西：
 *   · 组头 = "这些条目原来在哪个文件夹"（可收起，左侧竖线串起下面的行）；
 *   · 行   = **自己带这个标签**的书签 / 文件夹。
 *
 * 例外：**根目录组**没有"来自哪个文件夹"可讲，直接平铺 —— 不画组头、不画竖线、
 * 不可收起，免得给顶层条目也套一层时间轴。
 */
function renderTagList () {
  const groups = groupRowsByFolder(state.items, buildFolderLookup(state.tree))
  if (!groups.length) {
    renderEmpty(dom.list, state.query
      ? `没有同时匹配「${state.query}」和标签「${tagLabel(state.tag)}」的书签。`
      : `没有带「${tagLabel(state.tag)}」标签的书签。`)
    return
  }

  const frag = document.createDocumentFragment()
  for (const group of groups) {
    // 根目录组没有"来自哪个文件夹"可讲：直接平铺，不画组头、不画竖线、不可收起。
    if (group.id == null) {
      for (const node of group.rows as BookmarkNode[]) {
        frag.appendChild(isFolder(node) ? buildFolderRow(node) : buildBookmarkRow(node))
      }
      continue
    }
    const key = String(group.id)
    const collapsed = state.tagCollapsed.has(key)
    const box = el('div', 'tag-group' + (collapsed ? ' is-collapsed' : ''))

    const head = el('button', 'tag-group-head')
    head.type = 'button'
    head.dataset.groupKey = key
    head.title = collapsed ? '展开这一组' : '收起这一组'
    head.appendChild(el('span', 'tag-group-arrow'))
    head.appendChild(el('span', 'tag-group-title', group.path || group.title))
    head.appendChild(el('span', 'tag-group-count', String(group.rows.length)))
    head.onclick = () => {
      if (state.tagCollapsed.has(key)) state.tagCollapsed.delete(key)
      else state.tagCollapsed.add(key)
      renderList()
    }
    box.appendChild(head)

    if (!collapsed) {
      const body = el('div', 'tag-group-body')
      for (const node of group.rows as BookmarkNode[]) {
        body.appendChild(isFolder(node) ? buildFolderRow(node) : buildBookmarkRow(node))
      }
      box.appendChild(body)
    }
    frag.appendChild(box)
  }
  dom.list.appendChild(frag)
}

function buildCheckbox (id: string): HTMLInputElement {
  const box = el('input', 'row-check')
  box.type = 'checkbox'
  box.checked = state.selected.has(id)
  box.onclick = (event: MouseEvent) => event.stopPropagation()
  box.onchange = () => {
    if (box.checked) state.selected.add(id)
    else state.selected.delete(id)
    renderBatch()
  }
  return box
}

function buildFolderRow (node: BookmarkNode): HTMLElement {
  const row = el('div', 'row')
  row.dataset.id = node.id
  row.dataset.folder = '1'
  row.draggable = !state.query && !state.tag

  row.appendChild(buildCheckbox(node.id))

  const wrap = el('span', 'favicon-wrap')
  const folderIcon = icon('folder')
  if (folderIcon) wrap.appendChild(folderIcon)
  row.appendChild(wrap)

  const main = el('div', 'main')
  main.appendChild(el('div', 'title', node.title || '未命名文件夹'))
  // 标签视图说明这个文件夹为何出现；普通视图使用全树一次性算好的递归计数。
  main.appendChild(el('div', 'url', state.tag
    ? `带「${tagLabel(state.tag)}」标签`
    : `${folderBookmarkCounts.get(node.id) || 0} 条书签`))
  row.appendChild(main)

  row.appendChild(buildTagChips(node))
  row.appendChild(buildPinFlags(node))
  row.appendChild(buildRowActions(node, row, true))

  row.onclick = (event: MouseEvent) => {
    if ((event.target as Element).closest('button, input, textarea')) return
    navigateTo(node.id)
  }
  row.oncontextmenu = (event: MouseEvent) => { event.preventDefault(); folderMenu(node, event) }
  return row
}

function buildBookmarkRow (bookmark: BookmarkNode): HTMLElement {
  const row = el('div', 'row')
  row.dataset.id = bookmark.id
  row.draggable = !state.query && !state.tag

  row.appendChild(buildCheckbox(bookmark.id))
  row.appendChild(faviconBadge(bookmark.url || undefined, bookmark.title, bookmark.favicon || undefined))

  const main = el('div', 'main')
  main.appendChild(el('div', 'title', bookmark.nickname || bookmark.title || bookmark.url || '（无标题）'))
  if (bookmark.summary) {
    const summary = el('div', 'summary-line', bookmark.summary)
    summary.title = bookmark.summary
    summary.onclick = (event: MouseEvent) => { event.stopPropagation(); openSummaryEditor(bookmark, row) }
    main.appendChild(summary)
  }
  main.appendChild(el('div', 'url', bookmark.url || ''))
  row.appendChild(main)

  row.appendChild(buildTagChips(bookmark))
  row.appendChild(buildPinFlags(bookmark))
  row.appendChild(buildRowActions(bookmark, row, false))

  row.title = bookmark.url || ''
  // 手势交给 openLink：普通点击 = 本页打开；Ctrl/Cmd/中键 = 后台新标签。
  // 修饰键规则只存在于 link-intent.mjs，页面这里不判断 ctrlKey。
  row.onclick = (event: MouseEvent) => {
    if ((event.target as Element).closest('button, input, textarea')) return
    if (bookmark.url) openLink(bookmark.url, event)
  }
  row.onauxclick = (event: MouseEvent) => {
    if (event.button !== 1) return
    if ((event.target as Element).closest('button, input, textarea')) return
    if (bookmark.url) openLink(bookmark.url, event)
  }
  row.oncontextmenu = (event: MouseEvent) => { event.preventDefault(); bookmarkMenu(bookmark, event) }
  return row
}

/**
 * 行内标签胶囊：用户标签 + 系统标签（书签栏 / 侧栏）。
 * 系统标签走 `allTagsOfRow` 派生（不是 tags 列），点击同样进入该标签的筛选视图 ——
 * 用户因此可以用"标签"这一种交互完成所有分类，不必记两套概念。
 */
function buildTagChips (node: BookmarkNode): HTMLElement {
  const tags = allTagsOfRow(node)
  const wrap = el('span', 'tags')
  const limit = 4
  for (const tag of tags.slice(0, limit)) {
    const system = isSystemTagLike(tag)
    const chip = el('button', 'tag-chip' + (system ? ' is-system' : ''), system ? tagLabel(tag) : tag)
    chip.type = 'button'
    chip.title = `按标签「${tagLabel(tag)}」筛选`
    chip.onclick = (event: MouseEvent) => { event.stopPropagation(); setTag(tag) }
    wrap.appendChild(chip)
  }
  if (tags.length > limit) wrap.appendChild(el('span', 'tag-chip is-more', `+${tags.length - limit}`))
  return wrap
}

/** 固定位 / 打开偏好：三个独立开关，用小字形表达，不各开一列。 */
function buildPinFlags (node: BookmarkNode): HTMLElement {
  const wrap = el('span', 'pin-flags')
  const add = (name: string, title: string) => {
    const svg = icon(name, 13)
    if (!svg) return
    svg.setAttribute('aria-label', title)
    const holder = el('span')
    holder.title = title
    holder.appendChild(svg)
    wrap.appendChild(holder)
  }
  if (node.pinned) add('star', '已固定到书签栏')
  if (node.railPinned) add('layout', '已固定到侧栏图标栏')
  if (node.openInSidebar) add('arrowRight', '默认在侧栏打开')
  return wrap
}

function buildRowActions (node: BookmarkNode, row: HTMLElement, folderNode: boolean): HTMLElement {
  const actions = el('div', 'actions')

  if (!folderNode) {
    const open = iconButton('arrowRight', '打开')
    open.onclick = (event: MouseEvent) => {
      event.stopPropagation()
      if (node.url) openLink(node.url, event)
    }
    actions.appendChild(open)

    const summary = iconButton('sparkles', node.summary ? '编辑摘要' : '添加摘要')
    summary.onclick = (event: MouseEvent) => { event.stopPropagation(); openSummaryEditor(node, row) }
    actions.appendChild(summary)
  }

  const more = el('button', 'icon-btn', '⋯')
  more.type = 'button'
  more.title = '更多操作'
  more.onclick = (event: MouseEvent) => {
    event.stopPropagation()
    if (folderNode) folderMenu(node, event)
    else bookmarkMenu(node, event)
  }
  actions.appendChild(more)

  const remove = iconButton('trash', folderNode ? '删除文件夹' : '删除书签')
  remove.onclick = async (event: MouseEvent) => {
    event.stopPropagation()
    await deleteNodes([node.id], folderNode)
  }
  actions.appendChild(remove)
  return actions
}

/* ── 批量条 / 汇总文案 ─────────────────────────────────────────────────── */

function renderBatch () {
  const count = state.selected.size
  dom.batchBar.hidden = count === 0
  dom.batchCount.textContent = `已选 ${count} 项`
  dom.selectAll.disabled = state.items.length === 0
  dom.selectAll.textContent = state.selected.size >= state.items.length && state.items.length > 0
    ? '取消全选'
    : '全选'
}

function renderNote () {
  if (state.mode === 'backups') {
    dom.note.textContent = state.backupsCount ? `共 ${state.backupsCount} 份备份` : ''
    return
  }
  const folders = state.items.filter(isFolder).length
  const links = state.items.length - folders
  dom.note.textContent = folders ? `${links} 条书签 · ${folders} 个文件夹` : `${links} 条书签`
}

/* ── 标签分类栏 ─────────────────────────────────────────────────────────── *
 *
 * 系统标签（书签栏 / 侧栏图标栏）排在用户标签前面，因为它们**永远存在**
 * （哪怕计数为 0），也是用户最常按的两类筛选。数据来自 snapshot（同一次 SELECT），
 * 不再是"列表刷新一次、标签再单独刷新一次"的两份真相。
 */

function renderTagBar () {
  if (!dom.tagBar) return
  dom.tagBar.textContent = ''

  const addChip = (tag: string, label: string, count: number | null | undefined, system: boolean): void => {
    const active = state.tag === tag
    const chip = el('button', 'tag-bar-chip' + (active ? ' is-active' : '') + (system ? ' is-system' : ''))
    chip.type = 'button'
    chip.dataset.tag = tag
    chip.title = tag

    const svg = system ? icon(tag === 'system:pinned' ? 'star' : 'layout', 13) : null
    if (svg) chip.appendChild(svg)
    chip.appendChild(el('span', 'tag-bar-label', label))
    if (count != null) chip.appendChild(el('span', 'tag-bar-count', String(count)))
    chip.onclick = () => setTag(tag)
    // 用户标签右键 = 删除这个标签（全库摘除）；系统标签由固定列派生，不可删。
    if (tag && !system) {
      chip.title = `${label} · 右键删除该标签`
      chip.oncontextmenu = (event: MouseEvent) => {
        event.preventDefault()
        event.stopPropagation()
        deleteTag(tag)
      }
    }
    dom.tagBar.appendChild(chip)
  }

  addChip('', '全部', null, false)

  // 复制一份再补 chip：绝不往 `state.tags` 里塞临时项（下次刷新会从快照重建）
  const rows = state.tags.slice()
  // 当前筛选的标签若已没有条目（计数掉到 0），仍留一个 chip，用户才看得见"为什么是空的"
  const known = new Set(rows.map((row) => row.tag))
  if (state.tag && !known.has(state.tag)) {
    rows.push({ tag: state.tag, count: 0 })
  }
  for (const row of rows) {
    const tag = String(row.tag || '')
    if (!tag) continue
    const system = row.system === true || isSystemTagLike(tag)
    addChip(tag, system ? tagLabel(tag) : tag, row.count, system)
  }
}

/* ============================================================
 * 视图切换 / 导航
 * ============================================================ */

function navigateTo (folderId: string | null = null): void {
  closeSummaryEditor()
  state.mode = 'list'
  state.folderId = folderId ?? null
  state.query = ''
  // 进入文件夹 = 切回"按位置浏览"；标签是另一种浏览轴，不能悄悄叠加在面包屑上
  state.tag = ''
  state.selected.clear()
  state.path = folderId ? (pathTo(state.tree, folderId) || []) : []
  dom.search.value = ''
  revealFolderOnNextRefresh = true
  replaceBookmarksRoute(true)
  refresh()
}

/**
 * 切换标签筛选。标签是**跨文件夹视图**（由 domain 的 snapshot 派生），
 * 因此切换时不重置 folderId —— 用户清掉标签后还能回到原来的文件夹。
 */
function setTag (tag?: string | null): void {
  const wanted = String(tag || '')
  // 再点一次当前标签 = 取消筛选（「全部」也走这里，语义自洽）
  const next = wanted && state.tag === wanted ? '' : wanted
  state.mode = 'list'
  state.tag = next
  state.tagCollapsed.clear()
  state.selected.clear()
  closeSummaryEditor()
  replaceBookmarksRoute(true)
  refresh()
}

/* ============================================================
 * 摘要（行内编辑器）
 * ============================================================ */

function openSummaryEditor (bookmark: BookmarkNode, row: HTMLElement): void {
  if (!row || !row.parentNode) return
  if (state.editingId === bookmark.id) return
  closeSummaryEditor()
  state.editingId = bookmark.id

  const box = el('div', 'summary-editor')
  const input = el('textarea', 'summary-input')
  input.value = bookmark.summary || ''
  input.placeholder = '写下这条收藏的要点或摘录…（Ctrl+Enter 保存）'
  input.maxLength = 4000

  const foot = el('div', 'summary-editor-foot')
  const meta = el('span', 'summary-meta', `${input.value.length} / 4000`)
  const save = el('button', 'btn btn-sm btn-primary', '保存')
  const clear = el('button', 'btn btn-sm', '清除')
  const cancel = el('button', 'btn btn-sm', '取消')
  foot.append(meta, clear, cancel, save)
  box.append(input, foot)

  input.addEventListener('input', () => { meta.textContent = `${input.value.length} / 4000` })
  input.addEventListener('mousedown', (event: MouseEvent) => event.stopPropagation())
  input.addEventListener('keydown', (event: KeyboardEvent) => {
    event.stopPropagation()
    if (event.key === 'Escape') { event.preventDefault(); closeSummaryEditor() }
    else if ((event.ctrlKey || event.metaKey) && event.key === 'Enter') { event.preventDefault(); commit(input.value) }
  })
  save.onclick = () => commit(input.value)
  clear.onclick = () => commit(null)
  cancel.onclick = () => closeSummaryEditor()

  row.insertAdjacentElement('afterend', box)
  state.summaryBox = box
  window.setTimeout(() => {
    try {
      input.focus()
      input.setSelectionRange(input.value.length, input.value.length)
    } catch (_) {}
  }, 0)

  async function commit (value: string | null): Promise<void> {
    const id = state.editingId
    if (!id) return
    try {
      await bookmarksClient.update(id, { summary: value })
      showFeedback(value ? '摘要已保存' : '摘要已清除', 'success')
    } catch (e) {
      showFeedback(actionError(e), 'error')
    }
    state.editingId = null
    closeSummaryEditor()
    await refresh()
  }
}

function closeSummaryEditor () {
  if (state.summaryBox) {
    state.summaryBox.remove()
    state.summaryBox = null
  }
  state.editingId = null
  flushPendingRefresh()
}

function flushPendingRefresh () {
  if (!state.pendingRefresh) return
  state.pendingRefresh = false
  refresh()
}

/* ============================================================
 * 上下文菜单
 * ============================================================ */

async function bookmarkMenu (bookmark: BookmarkNode, event: MouseEvent): Promise<void> {
  const viewTag = state.tag
  const action = await popupMenu({
    x: event.clientX,
    y: event.clientY,
    context: { kind: 'bookmark', snapshot: { id: bookmark.id, url: bookmark.url || null } },
    items: [
      { label: '打开', action: 'open' },
      { label: '编辑…', action: 'edit' },
      { label: bookmark.summary ? '编辑摘要…' : '添加摘要…', action: 'summary' },
      { label: '打标签…', action: 'tag' },
      ...(viewTag ? [{ label: `移除标签「${tagLabel(viewTag)}」`, action: 'remove-view-tag' }] : []),
      { type: 'separator' },
      ...(viewTag === SYSTEM_TAG_PINNED
        ? []
        : [{ label: bookmark.pinned ? '取消固定（书签栏）' : '固定到书签栏', action: 'pin' }]),
      ...(viewTag === SYSTEM_TAG_RAIL
        ? []
        : [{ label: bookmark.railPinned ? '取消固定（侧栏图标栏）' : '固定到侧栏图标栏', action: 'rail' }]),
      { label: bookmark.openInSidebar ? '取消「默认在侧栏打开」' : '默认在侧栏打开', action: 'sidebar' },
      { type: 'separator' },
      { label: '移动到…', submenu: moveSubmenu([bookmark.id]) },
      { type: 'separator' },
      { label: '删除', action: 'remove' }
    ]
  })
  if (!action) return

  try {
    if (action === 'open') { if (bookmark.url) openLink(bookmark.url); return }
    if (action === 'edit') {
      await openBookmarkEditor('edit-bookmark', { url: bookmark.url, title: bookmark.title })
      return
    }
    if (action === 'summary') {
      const row = rowFor(bookmark.id)
      if (row) openSummaryEditor(bookmark, row)
      return
    }
    if (action === 'tag') {
      // 单条书签 → 编辑窗口（标签在表单里和标题一起保存）
      await openBookmarkEditor('edit-bookmark', { url: bookmark.url, title: bookmark.title })
      return
    }
    if (action === 'remove-view-tag') {
      await removeViewTag([bookmark.id])
      return
    }
    if (action === 'pin') {
      await bookmarksClient.setPinned(bookmark.id, !bookmark.pinned)
      showFeedback(bookmark.pinned ? '已取消书签栏固定' : '已固定到书签栏', 'success')
      await refresh()
      return
    }
    if (action === 'rail') {
      await bookmarksClient.setRailPinned(bookmark.id, !bookmark.railPinned)
      showFeedback(bookmark.railPinned ? '已取消侧栏图标固定' : '已固定到侧栏图标栏', 'success')
      await refresh()
      return
    }
    if (action === 'sidebar') {
      await bookmarksClient.setOpenInSidebar(bookmark.id, !bookmark.openInSidebar)
      showFeedback(bookmark.openInSidebar ? '已取消「默认在侧栏打开」' : '已设为「默认在侧栏打开」', 'success')
      await refresh()
      return
    }
    if (action === 'remove') { await deleteNodes([bookmark.id], false); return }
    if (action.startsWith('move:')) {
      await moveMany([bookmark.id], folderFromAction(action))
      return
    }
  } catch (e) {
    showFeedback(actionError(e), 'error')
  }
}

async function folderMenu (node: BookmarkNode | null, event: MouseEvent): Promise<void> {
  const folder = node?.id ? node : null
  const viewTag = state.tag
  const items: PageMenuItem[] = [
    { label: '新建书签', action: 'new-bookmark' },
    { label: '新建子文件夹', action: 'new' }
  ]
  if (folder) items.push(
    { label: '重命名', action: 'rename' },
    { label: '打标签…', action: 'tag' },
    ...(viewTag ? [{ label: `移除标签「${tagLabel(viewTag)}」`, action: 'remove-view-tag' }] : []),
    { type: 'separator' },
    // 文件夹也能固定 —— 与书签完全同一条通道（固定位只是"快捷入口"的选择，与类型无关）
    ...(viewTag === SYSTEM_TAG_PINNED
      ? []
      : [{ label: folder.pinned ? '取消固定（书签栏）' : '固定到书签栏', action: 'pin' }]),
    ...(viewTag === SYSTEM_TAG_RAIL
      ? []
      : [{ label: folder.railPinned ? '取消固定（侧栏图标栏）' : '固定到侧栏图标栏', action: 'rail' }]),
    { type: 'separator' },
    { label: '删除文件夹', action: 'delete' }
  )
  const action = await popupMenu({
    x: event.clientX,
    y: event.clientY,
    context: { kind: 'bookmark-folder', ...(folder ? { snapshot: { id: folder.id, title: folder.title } } : {}) },
    items
  })
  if (!action) return
  try {
    if (action === 'new-bookmark') {
      await openBookmarkEditor('add-bookmark', { parentId: folder ? folder.id : null })
      return
    }
    if (action === 'new') { void beginNewFolder(folder?.id ?? null); return }
    if (!folder) return
    if (action === 'rename') { state.renamingId = folder.id; renderTree(); return }
    if (action === 'tag') { await openTagBookmarksWindow([folder.id]); return }
    if (action === 'remove-view-tag') { await removeViewTag([folder.id]); return }
    if (action === 'pin') {
      await bookmarksClient.setPinned(folder.id, !folder.pinned)
      showFeedback(folder.pinned ? '已取消书签栏固定' : '已固定到书签栏', 'success')
      await refresh()
      return
    }
    if (action === 'rail') {
      await bookmarksClient.setRailPinned(folder.id, !folder.railPinned)
      showFeedback(folder.railPinned ? '已取消侧栏图标固定' : '已固定到侧栏图标栏', 'success')
      await refresh()
      return
    }
    if (action === 'delete') { await deleteNodes([folder.id], true); return }
  } catch (e) {
    showFeedback(actionError(e), 'error')
  }
}

function folderFromAction (action: string): string | null {
  return action === 'move:root' ? null : action.slice('move:'.length)
}

/**
 * 单一标签视图中的“移除此标签”动作。
 *
 * 系统标签与用户标签共用 `tagBulk(removeTags)`：前者由 domain 落到
 * pinned / railPinned 固定列，后者从 tags 列摘除；页面不复制写入规则。
 */
async function removeViewTag (ids: readonly string[]): Promise<void> {
  const tag = state.tag
  const list = ids.filter(Boolean)
  if (!tag || !list.length) return
  await bookmarksClient.tagBulk(list, { removeTags: [tag] })
  state.selected.clear()
  renderBatch()
  showFeedback(
    list.length > 1
      ? `已从 ${list.length} 项移除标签「${tagLabel(tag)}」`
      : `已移除标签「${tagLabel(tag)}」`,
    'success'
  )
  await refresh()
}

/**
 * 打标签的唯一入口（文件夹 / 多选）：开**批量打标签子窗口**。
 * 单条书签走 bookmarkMenu 里的 edit-bookmark —— 两个子窗口共用同一份标签规则
 *（shared-types#bookmark-tags.mjs），页面里不再有浮层，也不会长出第二套写路径。
 */
async function openTagBookmarksWindow (ids: readonly string[]): Promise<void> {
  const list = ids.filter(Boolean)
  if (!list.length) return
  try {
    await rpc(IPC_ROUTES.windowOpen, { type: 'tag-bookmarks', payload: { ids: list } })
  } catch (e) {
    showFeedback(actionError(e), 'error')
  }
}

/** 新增 / 编辑都只发窗口意图；表单、预取与落库仍由书签子窗口负责。 */
async function openBookmarkEditor(type: 'add-bookmark' | 'edit-bookmark', payload?: PageRpcRecord): Promise<void> {
  try {
    await rpc(IPC_ROUTES.windowOpen, { type, payload: payload || {} })
  } catch (e) {
    showFeedback('暂时无法打开书签编辑器：' + actionError(e), 'error')
  }
}

/**
 * 删除一个用户标签（全库摘除）—— 分类栏 chip 的右键触发。
 * 系统标签（书签栏 / 侧栏图标栏）由固定列派生、没有"删除"这回事，
 * 因此 chip 只在用户标签上挂右键（入口即规则，不必在这里再判一次）。
 */
async function deleteTag (tag: string): Promise<void> {
  const key = String(tag || '')
  if (!key) return
  try {
    const res = await bookmarksClient.tagDelete(key)
    if (state.tag && state.tag.toLowerCase() === key.toLowerCase()) state.tag = ''
    showFeedback(res && res.changed ? `已删除标签「${tagLabel(key)}」` : '该标签已不存在', 'success')
    await refresh()
  } catch (e) {
    showFeedback(actionError(e), 'error')
  }
}

/**
 * 批量固定 / 取消固定：全选中都已在目标固定位 → 取消，否则全部固定。
 * 固定位与标签写的是同一条 domain 通道（bulkUpdateTags：system:* → 固定列）。
 */
async function bulkTogglePinned (
  field: 'pinned' | 'railPinned',
  setter: (ids: string[], value: boolean) => Promise<unknown>,
  label: string
): Promise<void> {
  const ids = [...state.selected]
  if (!ids.length) return
  const rows = state.items.filter((row) => state.selected.has(row.id))
  const allOn = rows.length > 0 && rows.every((row) => !!row[field])
  const next = !allOn
  try {
    await setter(ids, next)
    showFeedback(`${next ? '已固定' : '已取消固定'} ${ids.length} 项${label}`, 'success')
    await refresh()
  } catch (e) {
    showFeedback(actionError(e), 'error')
  }
}

/** 移动菜单：根目录 + 全部文件夹（排除被移动项自身及其子树，防环）。 */
function moveSubmenu (ids: readonly string[]): PageMenuItem[] {
  const excluded = new Set(ids)
  for (const id of ids) {
    const node = findNode(state.tree, id)
    if (node) walk([node], (child) => excluded.add(child.id))
  }
  const items: PageMenuItem[] = [{ label: '全部书签（根目录）', action: 'move:root' }]
  const collect = (nodes: readonly BookmarkNode[], depth: number): void => {
    for (const node of nodes) {
      if (!isFolder(node) || excluded.has(node.id)) continue
      items.push({
        label: `${'　'.repeat(depth)}${node.title || '未命名文件夹'}`,
        action: `move:${node.id}`
      })
      collect(node.children || [], depth + 1)
    }
  }
  collect(state.tree, 0)
  return items
}

/* ============================================================
 * 写操作（全部收敛在这里，页面别处不再直接调 client 的写方法）
 * ============================================================ */

async function moveMany (ids: readonly string[], parentId: string | null): Promise<void> {
  try {
    for (const id of ids) await bookmarksClient.move(id, parentId)
    showFeedback(ids.length > 1 ? `已移动 ${ids.length} 项` : '已移动', 'success')
    state.selected.clear()
    renderBatch()
    await refresh()
  } catch (e) {
    showFeedback(actionError(e), 'error')
    await refresh()
  }
}

async function deleteNodes (ids: readonly string[], isFolderNode: boolean): Promise<void> {
  if (!ids.length) return
  const message = ids.length === 1
    ? (isFolderNode ? '删除这个文件夹？其中的书签会一起删除。' : '删除这个书签？')
    : `删除所选的 ${ids.length} 项？其中的文件夹会连同内容一起删除。`
  if (!confirm(message)) return
  try {
    for (const id of ids) await bookmarksClient.remove(id)
    for (const id of ids) state.selected.delete(id)
    showFeedback(ids.length > 1 ? `已删除 ${ids.length} 项` : '已删除', 'success')
    renderBatch()
    await refresh()
  } catch (e) {
    showFeedback(actionError(e), 'error')
  }
}

/* ============================================================
 * 新建文件夹（行内命名）
 * ============================================================ */

async function beginNewBookmark (): Promise<void> {
  if (state.mode === 'backups' || state.query || state.tag) {
    state.mode = 'list'
    state.query = ''
    state.tag = ''
    state.selected.clear()
    dom.search.value = ''
    replaceBookmarksRoute(true)
    void refresh()
  }
  await openBookmarkEditor('add-bookmark', { parentId: state.folderId })
}

async function beginNewFolder (parentId: string | null = state.folderId): Promise<void> {
  if (state.mode === 'backups') { state.mode = 'list'; replaceBookmarksRoute(true); await refresh() }
  // 搜索 / 标签视图下先退回文件夹视图：新建项未必命中当前筛选，建完"消失"会让人以为没建成
  if (state.query || state.tag) {
    state.query = ''
    state.tag = ''
    dom.search.value = ''
    replaceBookmarksRoute()
    await refresh()
  }

  const existing = dom.list.querySelector('.row.new-folder')
  if (existing) {
    try { existing.querySelector<HTMLInputElement>('input')?.focus() } catch (_) {}
    return
  }

  const row = el('div', 'row new-folder')
  row.appendChild(el('span', 'favicon-wrap')).appendChild(icon('folder') || el('span'))
  const input = el('input', 'new-folder-input')
  input.type = 'text'
  input.placeholder = '文件夹名称，回车创建'
  input.maxLength = 120
  row.appendChild(input)

  const actions = el('div', 'actions')
  const ok = iconButton('check', '创建')
  const cancel = iconButton('x', '取消')
  actions.append(ok, cancel)
  row.appendChild(actions)

  let busy = false
  const finish = async (commit = false): Promise<void> => {
    if (busy) return
    const title = input.value.trim()
    if (!commit || !title) { row.remove(); return }
    busy = true
    try {
      await bookmarksClient.add({ title, url: null, parentId: parentId ?? null })
      row.remove()
      showFeedback('文件夹已创建', 'success')
      await refresh()
    } catch (e) {
      busy = false
      showFeedback('创建失败：' + actionError(e), 'error')
    }
  }
  input.addEventListener('mousedown', (event: MouseEvent) => event.stopPropagation())
  input.addEventListener('keydown', (event: KeyboardEvent) => {
    event.stopPropagation()
    if (event.key === 'Enter') { event.preventDefault(); finish(true) }
    else if (event.key === 'Escape') { event.preventDefault(); finish(false) }
  })
  ok.onclick = (event: MouseEvent) => { event.stopPropagation(); void finish(true) }
  cancel.onclick = (event: MouseEvent) => { event.stopPropagation(); void finish(false) }

  dom.list.insertBefore(row, dom.list.firstChild)
  input.focus()
}

/* ============================================================
 * 备份视图
 * ============================================================ */

async function loadBackups (push = false) {
  state.mode = 'backups'
  replaceBookmarksRoute(push)
  state.backupsCount = 0
  state.selected.clear()
  renderBatch()
  dom.breadcrumb.textContent = ''
  dom.list.textContent = ''
  let backups: BookmarkBackup[] = []
  try {
    const rows = await bookmarksClient.backupList()
    backups = (Array.isArray(rows) ? rows : []).flatMap((row) => {
      const value = row as PageRpcRecord
      const file = typeof value.file === 'string' ? value.file : ''
      if (!file) return []
      return [{
        file,
        timestamp: typeof value.timestamp === 'string' ? value.timestamp : undefined,
        mtimeMs: typeof value.mtimeMs === 'number' ? value.mtimeMs : undefined,
        size: typeof value.size === 'number' ? value.size : undefined
      }]
    })
  } catch (e) {
    renderEmpty(dom.list, '备份加载失败：' + actionError(e))
    return
  }
  state.backupsCount = Array.isArray(backups) ? backups.length : 0
  renderBreadcrumb()
  renderNote()
  if (!state.backupsCount) {
    renderEmpty(dom.list, '还没有备份。点上方「备份」立即生成一份。')
    return
  }
  const frag = document.createDocumentFragment()
  for (const backup of backups) frag.appendChild(buildBackupRow(backup))
  dom.list.appendChild(frag)
}

function buildBackupRow (backup: BookmarkBackup): HTMLElement {
  const row = el('div', 'row')
  const wrap = el('span', 'favicon-wrap')
  const fileIcon = icon('folder')
  if (fileIcon) wrap.appendChild(fileIcon)
  row.appendChild(wrap)

  const main = el('div', 'main')
  main.appendChild(el('div', 'title', backup.timestamp || backup.file || '备份'))
  main.appendChild(el('div', 'url', fmtTime(backup.mtimeMs) + ' · ' + fmtSize(backup.size)))
  row.appendChild(main)

  const actions = el('div', 'actions')
  const restore = el('button', 'btn btn-sm', '恢复')
  restore.onclick = async (event: MouseEvent) => {
    event.stopPropagation()
    if (!confirm('用这份备份替换当前书签？（恢复前会自动再备份一份当前书签）')) return
    try {
      const result = await bookmarksClient.restoreBackup(backup.file) as unknown as BookmarkRestoreResult
      if (result && result.ok) {
        showFeedback(`已恢复 ${result.imported} 条书签` +
          (result.pinnedRestored ? `（${result.pinnedRestored} 个固定项）` : ''), 'success')
        state.mode = 'list'
        replaceBookmarksRoute()
        await refresh()
      } else {
        showFeedback('恢复失败：' + ((result && result.error) || '未知原因'), 'error')
      }
    } catch (e) {
      showFeedback('恢复失败：' + actionError(e), 'error')
    }
  }
  actions.appendChild(restore)
  row.appendChild(actions)
  return row
}

/* ============================================================
 * 拖拽排序（与收藏面板同口径：三分带 + 跨父级先 move 再 reorder）
 * ============================================================ */

type BookmarkDropZone = 'before' | 'after' | 'into' | ''

let dragId: string | null = null
let dropRow: HTMLElement | null = null
let dropZone: BookmarkDropZone = ''

function clearDropIndicator () {
  if (dropRow) dropRow.classList.remove('drop-into', 'drop-before', 'drop-after')
  dropRow = null
  dropZone = ''
}

function setDropIndicator (row: HTMLElement | null, zone: BookmarkDropZone): void {
  if (dropRow === row && dropZone === zone) return
  clearDropIndicator()
  dropRow = row
  dropZone = zone
  if (row && zone) {
    row.classList.add(zone === 'into' ? 'drop-into' : zone === 'before' ? 'drop-before' : 'drop-after')
  }
}

function zoneFor (row: HTMLElement, event: DragEvent): BookmarkDropZone {
  const rect = row.getBoundingClientRect()
  const ratio = rect.height ? (event.clientY - rect.top) / rect.height : 0.5
  if (row.dataset.folder === '1') return ratio < 0.28 ? 'before' : ratio > 0.72 ? 'after' : 'into'
  return ratio < 0.5 ? 'before' : 'after'
}

function dragAllowed () {
  return state.mode === 'list' && !state.query && !state.tag
}

dom.list.addEventListener('dragstart', (event: DragEvent) => {
  if (!dragAllowed()) return
  const row = event.target instanceof Element ? event.target.closest<HTMLElement>('.row') : null
  if (!row || !row.dataset.id) return
  dragId = row.dataset.id
  if (event.dataTransfer) {
    event.dataTransfer.effectAllowed = 'move'
    event.dataTransfer.setData('text/plain', dragId)
  }
  row.classList.add('dragging')
})

dom.list.addEventListener('dragend', () => {
  clearDropIndicator()
  for (const row of dom.list.querySelectorAll('.dragging')) row.classList.remove('dragging')
  dragId = null
})

dom.list.addEventListener('dragover', (event: DragEvent) => {
  if (!dragAllowed() || !dragId) return
  const row = event.target instanceof Element ? event.target.closest<HTMLElement>('.row') : null
  if (!row || !row.dataset.id || row.dataset.id === dragId) { clearDropIndicator(); return }
  event.preventDefault()
  if (event.dataTransfer) event.dataTransfer.dropEffect = 'move'
  setDropIndicator(row, zoneFor(row, event))
})

dom.list.addEventListener('dragleave', (event: DragEvent) => {
  if (!dom.list.contains(event.relatedTarget as Node | null)) clearDropIndicator()
})

dom.list.addEventListener('drop', async (event: DragEvent) => {
  if (!dragAllowed() || !dragId) return
  const row = event.target instanceof Element ? event.target.closest<HTMLElement>('.row') : null
  const targetId = row && row.dataset.id
  const zone = dropZone
  clearDropIndicator()
  if (!targetId || targetId === dragId || !zone) return
  event.preventDefault()
  const moved = dragId
  dragId = null

  try {
    if (zone === 'into') {
      if (isWithin(moved, targetId)) {
        showFeedback('不能把文件夹移动到自己的子文件夹里', 'error')
        return
      }
      await bookmarksClient.move(moved, targetId)
      showFeedback('已移动到文件夹', 'success')
    } else {
      const siblings = state.items.map((item) => item.id).filter((id) => id !== moved)
      const at = siblings.indexOf(targetId)
      if (at < 0) return
      siblings.splice(zone === 'after' ? at + 1 : at, 0, moved)
      await bookmarksClient.reorder(state.folderId, siblings)
      showFeedback('顺序已更新', 'success')
    }
    await refresh()
  } catch (e) {
    showFeedback('排序失败：' + actionError(e), 'error')
    await refresh()
  }
})

/* ============================================================
 * 工具栏接线
 * ============================================================ */

requiredElement<HTMLButtonElement>('refresh').onclick = () => { void refresh() }
dom.newBookmark.onclick = () => { void beginNewBookmark() }
requiredElement<HTMLButtonElement>('new-folder').onclick = () => { void beginNewFolder() }
requiredElement<HTMLButtonElement>('backups').onclick = () => { void loadBackups(true) }

requiredElement<HTMLButtonElement>('export').onclick = async () => {
  try {
    const html = await bookmarksClient.exportHtml()
    const blob = new Blob([String(html)], { type: 'text/html' })
    const url = URL.createObjectURL(blob)
    const link = document.createElement('a')
    link.href = url
    link.download = 'bookmarks_' + new Date().toISOString().slice(0, 10) + '.html'
    link.click()
    URL.revokeObjectURL(url)
  } catch (e) {
    showFeedback('导出失败：' + actionError(e), 'error')
  }
}

requiredElement<HTMLButtonElement>('backup-now').onclick = async () => {
  try {
    await bookmarksClient.backupNow()
    showFeedback('已生成一份备份', 'success')
  } catch (e) {
    showFeedback('备份失败：' + actionError(e), 'error')
  }
}

/**
 * 导入：先选格式（内建 HTML + 插件贡献的格式，声明侧来自 `bookmark:import-formats`），
 * 再选文件。插件格式由主进程转成 Netscape HTML 后走同一条入库路径（不绕过既有语义）。
 */
requiredElement<HTMLButtonElement>('import').onclick = async (event: MouseEvent) => {
  let formats: BookmarkImportFormat[] = []
  try { formats = await bookmarksClient.listImportFormats() } catch (_) { formats = [] }
  const items: PageMenuItem[] = [{ label: '书签 HTML（Netscape 格式）', action: 'html' }]
  for (const format of formats) {
    if (!format || !format.id) continue
    items.push({ label: format.label || format.id, action: 'format:' + format.id })
  }
  const rect = (event.currentTarget as HTMLElement).getBoundingClientRect()
  const action = await popupMenu({ items, x: rect.left, y: rect.bottom + 4 })
  if (!action) return
  state.importFormat = action === 'html' ? '' : action.slice('format:'.length)
  dom.importFile.accept = state.importFormat ? '' : '.html,.htm'
  dom.importFile.click()
}

dom.importFile.onchange = async () => {
  const input = dom.importFile
  const file = input.files?.[0]
  if (!file) return
  try {
    const content = await file.text()
    const result = state.importFormat
      ? await bookmarksClient.importWithFormat(state.importFormat, content)
      : await bookmarksClient.importHtml(content)
    if (result && result.error) showFeedback('导入失败：' + result.error, 'error')
    else {
      showFeedback(`已导入 ${result.imported} 条书签` +
        (result.skipped ? `（跳过 ${result.skipped} 条）` : ''), 'success')
      await refresh()
    }
  } catch (e) {
    showFeedback('导入失败：' + actionError(e), 'error')
  } finally {
    input.value = ''
    state.importFormat = ''
  }
}

/* ── 搜索 / 标签筛选 ───────────────────────────────────────────────────── */

let searchTimer = 0
dom.search.addEventListener('input', () => {
  window.clearTimeout(searchTimer)
  searchTimer = window.setTimeout(() => {
    const next = dom.search.value.trim()
    if (next === state.query) return
    state.query = next
    replaceBookmarksRoute()
    refresh()
  }, 150)
})

/* ── 批量操作 ─────────────────────────────────────────────────────────── */

dom.selectAll.onclick = () => {
  if (state.selected.size >= state.items.length) state.selected.clear()
  else for (const item of state.items) state.selected.add(item.id)
  renderList()
  renderBatch()
}

dom.batchCancel.onclick = () => {
  state.selected.clear()
  renderList()
  renderBatch()
}

dom.batchDelete.onclick = () => {
  const ids = [...state.selected]
  if (!ids.length) return
  deleteNodes(ids, false)
}

dom.batchMove.onclick = async () => {
  const ids = [...state.selected]
  if (!ids.length) return
  const rect = dom.batchMove.getBoundingClientRect()
  const action = await popupMenu({ items: moveSubmenu(ids), x: rect.left, y: rect.bottom + 4 })
  if (!action) return
  await moveMany(ids, folderFromAction(action))
}

// 批量打标签：统一开**批量打标签子窗口**（系统标签可顺带固定 —— 同一套 domain 写通道）
dom.batchTag.onclick = async () => {
  const ids = [...state.selected]
  if (!ids.length) return
  await openTagBookmarksWindow(ids)
}

// 批量固定到书签栏 / rail：全选中都固定了就是"取消"，否则"固定"（与行内开关同直觉）
dom.batchPin.onclick = () => bulkTogglePinned('pinned', (ids: string[], value: boolean) => bookmarksClient.pinnedBulk(ids, value), '到书签栏')
dom.batchRail.onclick = () => bulkTogglePinned('railPinned', (ids: string[], value: boolean) => bookmarksClient.railPinnedBulk(ids, value), '到侧栏图标栏')

/* ── AI 补摘要 ────────────────────────────────────────────────────────── */

/**
 * 走官方意图入口（`ai:intent:invoke` → 意图服务 → AI 面板）。
 *
 * 页面只管"叫一声"：取页、调模型、写回摘要全在 AI 面板的回合里完成，
 * 结果由 `bookmark:changed` 广播驱动本页刷新 —— 这里不重复实现一遍摘要逻辑。
 * `ids` 为空表示"整个库里还没有摘要的"。
 */
async function askAiDigest (ids: readonly string[]): Promise<void> {
  const payload = ids && ids.length ? { ids } : { scope: 'missing' }
  try {
    const res = await rpc(IPC_ROUTES.aiIntentInvoke, { intent: 'digest-bookmarks', payload })
    if (res && res.ok === false) {
      showFeedback('没能唤起 AI：' + (res.message || res.code || '未知原因'), 'error')
      return
    }
    showFeedback(ids && ids.length ? `已在 AI 面板处理选中的 ${ids.length} 条` : '已在 AI 面板开始补摘要', 'success')
  } catch (e) {
    showFeedback('没能唤起 AI：' + actionError(e), 'error')
  }
}

requiredElement<HTMLButtonElement>('ai-digest').onclick = () => { void askAiDigest([]) }
dom.batchAiDigest.onclick = () => { void askAiDigest([...state.selected]) }

/* ── 键盘 ─────────────────────────────────────────────────────────────── */

document.addEventListener('keydown', (event: KeyboardEvent) => {
  const target = event.target as HTMLElement | null
  const editing = !!target && !!target.closest('input, textarea, select, [contenteditable="true"]')
  if (!editing && !event.ctrlKey && !event.metaKey && !event.altKey) {
    if (event.key === '/') {
      event.preventDefault()
      dom.search.focus()
      dom.search.select()
      return
    }
    if (event.key.toLowerCase() === 'n') {
      event.preventDefault()
      void beginNewBookmark()
      return
    }
  }
  if (event.key !== 'Escape') return
  if (target === dom.search && state.query) {
    event.preventDefault()
    window.clearTimeout(searchTimer)
    state.query = ''
    dom.search.value = ''
    replaceBookmarksRoute()
    void refresh()
    return
  }
  if (state.editingId || state.renamingId) return // 编辑器自己处理 Esc
  if (state.selected.size) {
    state.selected.clear()
    renderList()
    renderBatch()
  }
})

/* ── 跨窗口变更：书签在被别处改动（面板 / 书签栏 / 导入）时对账 ────────── */

let changeTimer = 0
bookmarksClient.onChanged(() => {
  // 用户正在打字（摘要 / 重命名）时不做整列表重建，等编辑器收起后再刷
  if (state.editingId || state.renamingId) { state.pendingRefresh = true; return }
  window.clearTimeout(changeTimer)
  changeTimer = window.setTimeout(() => { refresh() }, 80)
})

/* ── 能力联动（§10.4）：入口随引擎可用性显隐 ──────────────────────────────
 * 判据只有一份（`main/feature-map.js`，与侧栏 / ⋮ 菜单 / 应用菜单同源），页面不自己
 * 翻插件状态。**订阅**而不是取一次快照：内部页在标签页里常驻，用户可能切走后再去关
 * 插件 —— 只读一次会让按钮留到下次刷新，那正是"关掉了还看得见"的漏网。
 */
const FEATURE_BUTTONS: Readonly<Record<string, readonly string[]>> = Object.freeze({
  bookmarkBackup: ['backup-now', 'backups'],
  // 书签摘要的「AI 补摘要」两处入口：AI 引擎 / 面板任一被关掉就一起消失
  ai: ['ai-digest', 'batch-ai-digest']
})

function applyFeatureButtons (available?: Record<string, boolean> | null) {
  const states: Record<string, boolean> = available || {}
  for (const featureId of Object.keys(FEATURE_BUTTONS)) {
    const on = states[featureId] !== false
    for (const id of FEATURE_BUTTONS[featureId]) {
      const button = document.getElementById(id)
      if (button) button.style.display = on ? '' : 'none'
    }
  }
}

onFeatureAvailability(applyFeatureButtons)

/* ── 可见性回补 ──────────────────────────────────────────────────────────
 * 内部页是在标签页里常驻的：切到后台的这段时间里可能错过了 `bookmark:changed`
 * （导入、面板固定、别处删除），也可能首屏恰好在主进程写事务中读到空快照。
 * 回到前台时若"上次失败"或"快照已过期"，补一次读；否则不动，避免每次切标签都白刷。
 */
const STALE_AFTER = 5000
function refreshIfStale () {
  if (document.hidden || state.mode !== 'list') return
  if (state.loadFailed || !state.lastLoadedAt || Date.now() - state.lastLoadedAt > STALE_AFTER) {
    refresh()
  }
}
document.addEventListener('visibilitychange', refreshIfStale)
window.addEventListener('focus', refreshIfStale)

window.addEventListener('popstate', () => {
  const next = readBookmarksRoute(location.search)
  if (next.mode === state.mode && next.folderId === state.folderId &&
      next.tag === state.tag && next.query === state.query) return
  void applyBookmarksRoute(next)
})

/* ── 首屏 ─────────────────────────────────────────────────────────────── */

replaceBookmarksRoute()
refresh().then(() => {
  // 深链 #new-folder：消费一次即抹掉，之后刷新页面不该被再次拉进新建流程
  if (String(location.hash).toLowerCase() !== '#new-folder') return
  history.replaceState(null, '', location.pathname + location.search)
  beginNewFolder()
})
