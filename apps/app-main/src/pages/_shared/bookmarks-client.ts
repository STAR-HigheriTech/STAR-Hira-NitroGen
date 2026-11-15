/**
 * 书签数据入口 —— `hira://bookmarks` 与其它内部页共用的一层薄封装。
 *
 * 只做三件事：拼 route、把可选参数收敛成契约要求的形态（`null` / 省略）、
 * 暴露变更订阅。**不做任何缓存、不做乐观更新、不吞错误** ——
 * 那些是页面自己的决策，放在这里会让"谁在什么时候刷新"变得不可追踪。
 *
 * 命令名与主进程 `ipc/bookmarks.js` 一一对应；新增能力先加主进程 handler 与契约，
 * 再在这里补一行，不要在页面里直接 `rpc('bookmark:xxx')`（拼错只有运行时才炸）。
 */
import { IPC_EVENTS, IPC_ROUTES, rpc, subscribe } from './runtime.js'

interface BookmarkSelectionRequest {
  parentId?: string | null
  tag?: string
  query?: string
}

interface BookmarkSearchRequest {
  query: string
  tag?: string
}

export interface BookmarkImportFormat {
  id: string
  label?: string
}

export interface BookmarkMutation extends Record<string, unknown> {
  title?: string | null
  url?: string | null
  parentId?: string | null
  summary?: string | null
}

export interface BookmarkTagBulkOptions {
  addTags?: string[]
  removeTags?: string[]
}

export const bookmarksClient = {
  // ── 读 ─────────────────────────────────────────────────────────────────
  list(parentId?: string | null) {
    return rpc(IPC_ROUTES.bookmarkList, parentId != null ? { parentId } : {})
  },
  /**
   * 首屏聚合：`{ parentId, tag, query, items, pinned, pinnedOrder, folders, tags }`（一次 IPC 拿全）。
   * `tag` / `query` 正交；关键词搜索保持相关度顺序，标签栏数据来自同一次快照。
   */
  snapshot(parentId?: string | null, tag?: string | null, query?: string | null) {
    const req: BookmarkSelectionRequest = {}
    if (parentId != null) req.parentId = parentId
    if (tag != null && tag !== '') req.tag = tag
    if (query != null && query !== '') req.query = query
    return rpc(IPC_ROUTES.bookmarkSnapshot, req)
  },
  /** 完整文件夹树（带 children）。 */
  tree() {
    return rpc(IPC_ROUTES.bookmarkTree, {})
  },
  search(query = '', tag?: string | null) {
    const req: BookmarkSearchRequest = { query }
    if (tag != null && tag !== '') req.tag = tag
    return rpc(IPC_ROUTES.bookmarkSearch, req)
  },
  getByUrl(url: string) {
    return rpc(IPC_ROUTES.bookmarkGetByUrl, { url })
  },

  // ── 写 ─────────────────────────────────────────────────────────────────
  add(input: BookmarkMutation) {
    return rpc(IPC_ROUTES.bookmarkAdd, input)
  },
  /** 局部更新。`summary` 显式传 `''` / `null` = 清除摘要（domain 侧统一归一到 NULL）。 */
  update(id: string, updates: BookmarkMutation) {
    return rpc(IPC_ROUTES.bookmarkUpdate, { id, ...updates })
  },
  remove(id: string) {
    return rpc(IPC_ROUTES.bookmarkRemove, { id })
  },
  removeByUrl(url: string) {
    return rpc(IPC_ROUTES.bookmarkRemoveByUrl, { url })
  },
  /** 移动到指定文件夹（同时排到该文件夹末尾）。parentId=null 表示根层。 */
  move(id: string, parentId?: string | null) {
    return rpc(IPC_ROUTES.bookmarkMove, { id, parentId: parentId ?? null })
  },
  /** 重排某个父级下的**全部**子节点顺序（拖拽落点回传完整顺序）。 */
  reorder(parentId: string | null | undefined, orderedIds: string[]) {
    return rpc(IPC_ROUTES.bookmarkReorder, { parentId: parentId ?? null, orderedIds })
  },
  setOpenInSidebar(id: string, value: boolean) {
    return rpc(IPC_ROUTES.bookmarkOpenInSidebarSet, { id, value: !!value })
  },

  // ── 两个独立固定位（书签栏 / rail）─────────────────────────────────────
  listPinned() {
    return rpc(IPC_ROUTES.bookmarkPinnedList, {})
  },
  setPinned(id: string, pinned: boolean) {
    return rpc(IPC_ROUTES.bookmarkPinnedSet, { id, pinned: !!pinned })
  },
  reorderPinned(orderedIds: string[]) {
    return rpc(IPC_ROUTES.bookmarkPinnedReorder, { orderedIds })
  },
  listRailPinned() {
    return rpc(IPC_ROUTES.bookmarkRailPinnedList, {})
  },
  setRailPinned(id: string, pinned: boolean) {
    return rpc(IPC_ROUTES.bookmarkRailPinnedSet, { id, pinned: !!pinned })
  },
  reorderRailPinned(orderedIds: string[]) {
    return rpc(IPC_ROUTES.bookmarkRailPinnedReorder, { orderedIds })
  },

  // ── 批量（多选模式）───────────────────────────────────────────────────
  /**
   * 批量打 / 移除标签。系统标签（`system:pinned` / `system:rail`）在写路径上
   * 被解释为固定开关 —— 所以这个弹层也能"批量固定"，不必再调 pinnedBulk。
   */
  tagBulk(ids: string[], { addTags = [], removeTags = [] }: BookmarkTagBulkOptions = {}) {
    return rpc(IPC_ROUTES.bookmarkTagBulk, { ids, addTags, removeTags })
  },
  /** 批量固定 / 取消固定到书签栏（system:pinned 的快捷方式）。 */
  pinnedBulk(ids: string[], pinned: boolean) {
    return rpc(IPC_ROUTES.bookmarkPinnedBulk, { ids, pinned: !!pinned })
  },
  /** 批量固定 / 取消固定到 rail（system:rail 的快捷方式）。 */
  railPinnedBulk(ids: string[], pinned: boolean) {
    return rpc(IPC_ROUTES.bookmarkRailPinnedBulk, { ids, pinned: !!pinned })
  },
  /** 删除一个用户标签（全库摘除；系统标签由 domain 拒绝）。 */
  tagDelete(tag: string) {
    return rpc(IPC_ROUTES.bookmarkTagDelete, { tag })
  },

  // ── 标签 ───────────────────────────────────────────────────────────────
  /** 标签分类栏：`[{ tag, count, system, label }]`，系统标签在前、用户标签按热度降序。 */
  listTags() {
    return rpc(IPC_ROUTES.bookmarkTags, {})
  },
  tagSuggestions(page: Record<string, unknown> = {}) {
    return rpc(IPC_ROUTES.bookmarkTagSuggestions, page)
  },
  tagAutocomplete(tags: string[], limit?: number) {
    return rpc(IPC_ROUTES.bookmarkTagAutocomplete, limit ? { tags, limit } : { tags })
  },

  // ── 导入 / 导出 / 备份 ────────────────────────────────────────────────
  exportHtml() {
    return rpc(IPC_ROUTES.bookmarkExport, {})
  },
  importHtml(html: string) {
    return rpc(IPC_ROUTES.bookmarkImport, { html })
  },
  /** 插件贡献的导入格式：`{ format, content }`（主进程转成 Netscape HTML 后同路径入库）。 */
  importWithFormat(format: string, content: string) {
    return rpc(IPC_ROUTES.bookmarkImport, { format, content })
  },
  /** 可用导入格式清单（插件声明侧）：`[{ id, label }]`。 */
  async listImportFormats() {
    const res = await rpc<{ formats?: unknown[] }>(IPC_ROUTES.bookmarkImportFormats, {})
    return (Array.isArray(res?.formats) ? res.formats : []).flatMap((value): BookmarkImportFormat[] => {
      if (!value || typeof value !== 'object') return []
      const format = value as { id?: unknown; label?: unknown }
      if (typeof format.id !== 'string' || !format.id) return []
      return [{ id: format.id, label: typeof format.label === 'string' ? format.label : undefined }]
    })
  },
  backupList() {
    return rpc(IPC_ROUTES.bookmarkBackupList, {})
  },
  backupNow() {
    return rpc(IPC_ROUTES.bookmarkBackupNow, {})
  },
  restoreBackup(file: string) {
    return rpc(IPC_ROUTES.bookmarkBackupRestore, { file })
  },

  // ── 变更订阅 ───────────────────────────────────────────────────────────
  onChanged(listener: () => void) {
    return subscribe(IPC_EVENTS.bookmarkChanged, listener)
  }
}
