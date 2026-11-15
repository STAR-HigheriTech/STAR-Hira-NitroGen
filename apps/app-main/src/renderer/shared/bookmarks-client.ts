import { IPC_ROUTES, IPC_EVENTS } from '@hira-ng/shared-types/src/ipc-channels.mjs'
import { getHiraBridge, type JsonRecord } from './bridge.js'
import type { Bookmark } from '@hira-ng/domain-bookmark'

// 书签领域客户端 —— 与 tabs-client 同构：
// invoke 全走 IPC_ROUTES 枚举、推送全走 IPC_EVENTS 枚举，
// 不留任何裸字符串通道（谁在用哪个通道永远可查）。

const listeners = new Set<(payload: JsonRecord) => void>()
/** 桥订阅单例：onChanged 调 N 次也只挂一个 ipcRenderer 监听（防广播放大） */
let bridgeSubscription: (() => void) | null = null

function ensureBridgeSubscription() {
  if (bridgeSubscription) return
  bridgeSubscription = getHiraBridge().on.subscribe<JsonRecord>(IPC_EVENTS.bookmarkChanged, (payload) => {
    broadcast(payload)
  })
}

function broadcast(payload: JsonRecord): void {
  for (const fn of listeners) {
    try {
      fn(payload)
    } catch (e) {
      console.error('[bookmarks-client] listener error', e)
    }
  }
}

function invoke<T = JsonRecord>(route: string, arg?: unknown): Promise<T> {
  return getHiraBridge().provider.invoke<T>(route, arg)
}

export const bookmarksClient = {
  /** 按 URL 查收藏状态：命中返回书签对象，未收藏返回 null */
  getByUrl(url: string): Promise<Bookmark | null> {
    return invoke<Bookmark | null>(IPC_ROUTES.bookmarkGetByUrl, { url })
  },
  /** 列出书签（parentId 省略 = 根级；收藏面板用） */
  list(parentId?: string | null): Promise<Bookmark[]> {
    return invoke<Bookmark[]>(IPC_ROUTES.bookmarkList, parentId != null ? { parentId } : {})
  },
  /** 按 id 删除（收藏面板行内删除按钮用） */
  remove(id: string) {
    return invoke(IPC_ROUTES.bookmarkRemove, { id })
  },
  /** 收藏（url 为键；重复收藏由 domain 决定语义） */
  add({ url, title, nickname, parentId, tags }: JsonRecord = {}) {
    return invoke(IPC_ROUTES.bookmarkAdd, {
      url,
      title,
      ...(nickname != null ? { nickname } : {}),
      ...(parentId != null ? { parentId } : {}),
      ...(Array.isArray(tags) ? { tags } : {})
    })
  },
  /**
   * 新建书签文件夹。
   * domain 里「文件夹 = url 为空的收藏」，与 hira://bookmarks 新建是**同一条入口**
   *（`bookmark.add`），因此不新开 IPC 通道 —— 通道数不因 UI 入口变多而膨胀。
   */
  createFolder({ title, parentId }: JsonRecord = {}) {
    return invoke(IPC_ROUTES.bookmarkAdd, {
      title,
      url: null,
      ...(parentId != null ? { parentId } : {})
    })
  },
  /** 取消收藏（同一 URL 多处收藏时全部移除） */
  removeByUrl(url: string) {
    return invoke(IPC_ROUTES.bookmarkRemoveByUrl, { url })
  },
  /** 全量书签树（编辑器文件夹下拉 / 书签页） */
  tree() {
    return invoke(IPC_ROUTES.bookmarkTree)
  },
  /**
   * 面板聚合快照 —— 一次 IPC 取齐首屏全部视图：
   * `{ parentId, tag, items, pinned, pinnedOrder, folders, tags }`。
   * 比 `list` + `tree` + `pinnedList` 三次往返更快，且三份视图来自同一时刻的读。
   * `tag` 非空时 items 是**跨文件夹**的标签视图（标签栏数据在同一次快照里）。
   */
  snapshot(parentId: string | null = null, tag: string | null = null) {
    /** @type {Record<string, unknown>} */
    const req: Record<string, unknown> = {}
    if (parentId != null) req.parentId = parentId
    if (tag != null && tag !== '') req.tag = tag
    return invoke(IPC_ROUTES.bookmarkSnapshot, req)
  },
  /** 更新书签（标题/URL/tags） */
  update({ id, ...updates }: { id: string } & JsonRecord) {
    return invoke(IPC_ROUTES.bookmarkUpdate, { id, ...updates })
  },
  /** 移动到文件夹 */
  move(id: string, parentId: string | null) {
    return invoke(IPC_ROUTES.bookmarkMove, { id, parentId })
  },
  /**
   * 同父级内重排。
   * @param {string|null} parentId
   * @param {string[]} orderedIds 该父级下**全部**子节点的新顺序（拖拽落点回传）
   */
  reorder(parentId: string | null, orderedIds: string[]) {
    return invoke(IPC_ROUTES.bookmarkReorder, { parentId: parentId ?? null, orderedIds })
  },
  // ── 书签栏（pinned bar）──
  pinnedList(): Promise<Bookmark[]> {
    return invoke<Bookmark[]>(IPC_ROUTES.bookmarkPinnedList)
  },
  pinnedSet(id: string, pinned: boolean) {
    return invoke(IPC_ROUTES.bookmarkPinnedSet, { id, pinned })
  },
  pinnedReorder(orderedIds: string[]) {
    return invoke(IPC_ROUTES.bookmarkPinnedReorder, { orderedIds })
  },
  // ── rail（侧栏图标栏）固定项 ──
  // 与书签栏 pinned 是**两个独立固定位**：固定到 rail 的书签在图标栏上占一个图标，
  // 点击即在独立侧栏打开（见 rail/main.js）。
  railPinnedList() {
    return invoke(IPC_ROUTES.bookmarkRailPinnedList)
  },
  /**
   * 标签分类栏（系统标签 + 用户标签，带计数）—— 书签页与收藏面板共用。
   * 返回 `[{ tag, count, system, label }]`；失败由调用方兜底为空数组。
   */
  tags() {
    return invoke(IPC_ROUTES.bookmarkTags)
  },
  // ── 批量（多选模式）──
  /** 批量打 / 移除标签：系统标签在写路径上被解释为固定开关。 */
  tagBulk(ids: string[], { addTags = [], removeTags = [] }: { addTags?: string[]; removeTags?: string[] } = {}) {
    return invoke(IPC_ROUTES.bookmarkTagBulk, { ids, addTags, removeTags })
  },
  /** 批量固定 / 取消固定到书签栏。 */
  pinnedBulk(ids: string[], pinned: boolean) {
    return invoke(IPC_ROUTES.bookmarkPinnedBulk, { ids, pinned: !!pinned })
  },
  /** 批量固定 / 取消固定到 rail。 */
  railPinnedBulk(ids: string[], pinned: boolean) {
    return invoke(IPC_ROUTES.bookmarkRailPinnedBulk, { ids, pinned: !!pinned })
  },
  /** 删除一个用户标签（全库摘除；系统标签由 domain 拒绝）。 */
  tagDelete(tag: string) {
    return invoke(IPC_ROUTES.bookmarkTagDelete, { tag })
  },
  railPinnedSet(id: string, pinned: boolean) {
    return invoke(IPC_ROUTES.bookmarkRailPinnedSet, { id, pinned })
  },
  /**
   * rail 固定区拖拽重排：回传**整列**的新顺序（只含 fix 到 rail 的那些）。
   * 与书签栏 `pinnedReorder` 是两条独立的链 —— 在 rail 上拖不该动到书签栏。
   */
  railPinnedReorder(orderedIds: string[]) {
    return invoke(IPC_ROUTES.bookmarkRailPinnedReorder, { orderedIds })
  },
  /**
   * 打开偏好：点击该书签时**默认在独立侧栏打开**（无修饰键时生效）。
   * 修饰键优先级更高（Shift 侧栏 / Ctrl 新标签），见 ui-common#resolveBookmarkOpenTarget。
   */
  openInSidebarSet(id: string, value: boolean) {
    return invoke(IPC_ROUTES.bookmarkOpenInSidebarSet, { id, value })
  },
  /** 订阅任何来源的书签变更（payload: { reason, id, url }） */
  onChanged(fn: (payload: JsonRecord) => void) {
    listeners.add(fn)
    ensureBridgeSubscription()
    return () => {
      listeners.delete(fn)
      // 最后一个监听器退订时才拆桥订阅；引用计数归零前桥订阅永不重复
      if (listeners.size === 0 && bridgeSubscription) {
        bridgeSubscription()
        bridgeSubscription = null
      }
    }
  }
}


