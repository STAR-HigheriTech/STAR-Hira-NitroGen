import { IPC_ROUTES, IPC_EVENTS } from '@hira-ng/shared-types/src/ipc-channels.mjs'
import { getHiraBridge, type JsonRecord } from './bridge.js'
import type { Note } from '@hira-ng/domain-notes'

// 笔记领域客户端 —— 与 bookmarks-client 同构：
// invoke 全走 IPC_ROUTES 枚举、推送全走 IPC_EVENTS 枚举，不留裸字符串通道。
// 引用计数单例桥订阅：N 个订阅者只挂 1 条 ipcRenderer 监听（防广播放大）。

const listeners = new Set<(payload: JsonRecord) => void>()
let bridgeSubscription: (() => void) | null = null

function ensureBridgeSubscription() {
  if (bridgeSubscription) return
  bridgeSubscription = getHiraBridge().on.subscribe<JsonRecord>(IPC_EVENTS.noteChanged, (payload) => {
    for (const fn of listeners) {
      try {
        fn(payload)
      } catch (e) {
        console.error('[notes-client] listener error', e)
      }
    }
  })
}

function invoke<T = JsonRecord>(route: string, arg?: unknown): Promise<T> {
  return getHiraBridge().provider.invoke<T>(route, arg)
}

export const notesClient = {
  /**
   * 列出笔记。
   * 三态语义与 IPC 契约一致：省略 folderId = 全部；null = 根级；字符串 = 该文件夹。
   * @param {{ folderId?: string|null }} [options]
   */
  list(options: JsonRecord = {}) {
    const has = Object.prototype.hasOwnProperty.call(options, 'folderId')
    return invoke(IPC_ROUTES.noteList, has ? { folderId: options.folderId } : {})
  },
  get(id: string) {
    return invoke(IPC_ROUTES.noteGet, { id })
  },
  add({ title, content, folderId, url, tags, color, kind, sourceTitle, assetPath, assetMime, assetWidth, assetHeight, thumbPath, refId, refMode }: JsonRecord = {}) {
    return invoke(IPC_ROUTES.noteAdd, {
      title,
      content,
      ...(folderId != null ? { folderId } : {}),
      ...(url != null ? { url } : {}),
      ...(Array.isArray(tags) ? { tags } : {}),
      ...(color != null ? { color } : {}),
      // 集锦字段：只在真正传了时才带上（避免把 undefined 送进 zod 契约）。
      ...(kind != null ? { kind } : {}),
      ...(sourceTitle != null ? { sourceTitle } : {}),
      ...(assetPath != null ? { assetPath } : {}),
      ...(assetMime != null ? { assetMime } : {}),
      ...(assetWidth != null ? { assetWidth } : {}),
      ...(assetHeight != null ? { assetHeight } : {}),
      ...(thumbPath != null ? { thumbPath } : {}),
      ...(refId != null ? { refId } : {}),
      ...(refMode != null ? { refMode } : {})
    })
  },
  /** 更新：patch 里除 id 外的字段原样透传（含集锦字段；kind 会被 domain 忽略，见契约）。 */
  update({ id, ...patch }: { id: string } & JsonRecord) {
    return invoke(IPC_ROUTES.noteUpdate, { id, ...patch })
  },
  remove(id: string) {
    return invoke(IPC_ROUTES.noteRemove, { id })
  },
  search(query: string) {
    return invoke(IPC_ROUTES.noteSearch, { query })
  },
  move(id: string, folderId: string | null) {
    return invoke(IPC_ROUTES.noteMove, { id, folderId: folderId ?? null })
  },
  pinSet(id: string, pinned: boolean) {
    return invoke(IPC_ROUTES.notePinSet, { id, pinned })
  },
  /** @param {string|null} folderId @param {string[]} orderedIds 该文件夹下全部笔记的新顺序 */
  reorder(folderId: string | null, orderedIds: string[]) {
    return invoke(IPC_ROUTES.noteReorder, { folderId: folderId ?? null, orderedIds })
  },
  // ── 集锦（经典 Edge Collections 完全体）──
  /**
   * 抓取入集：把当前页 / 片段 / 图片收进某文件夹。
   * 同一文件夹内 kind==='page' 且 url 相同的**未删**卡会被去重（返回已有那张）。
   *
   * `kind:'page'` 的**来源解析在主进程**（见 ipc/notes.js#resolvePageSource）：
   *   · 带 `tabId`  → 从**那个标签**取权威 url/title 与缩略图来源（标签右键「收进集锦…」）；
   *   · 带 `url`    → 用它（粘贴 / 拖放 / 链接），缩略图尽力按 url 在本窗口找一次；
   *   · 都不带      → **收发送方窗口的活动标签**（面板「+ 添加当前页面」）——
   *     渲染层因此只发"我要收当前页"这个意图，绝不自己去找活动标签。
   * @param {{ kind?: 'note'|'page'|'image'|'snippet'|'ref', url?: string, tabId?: string,
   *           title?: string, sourceTitle?: string, content?: string, folderId?: string|null,
   *           assetPath?: string, assetMime?: string, assetWidth?: number, assetHeight?: number,
   *           thumbPath?: string, tags?: string[] }} input
   */
  capture(input: JsonRecord = {}) {
    return invoke(IPC_ROUTES.noteCapture, { ...input })
  },
  /** 从回收站**恢复**一张卡 @returns {Promise<{ok:boolean}>} */
  restore(id: string) : Promise<{ok:boolean}> {
    return invoke(IPC_ROUTES.noteRestore, { id })
  },
  /** 从回收站**真删**一张卡（不可恢复，连同它的引用边）@returns {Promise<{ok:boolean}>} */
  purge(id: string) : Promise<{ok:boolean}> {
    return invoke(IPC_ROUTES.notePurge, { id })
  },
  /** 回收站列表（按删除时间倒序）@returns {Promise<Note[]>} */
  trash() : Promise<Note[]> {
    return invoke<Note[]>(IPC_ROUTES.noteTrashList)
  },
  /** 清空回收站 @returns {Promise<{ok:boolean}>} */
  emptyTrash() : Promise<{ok:boolean}> {
    return invoke(IPC_ROUTES.noteTrashEmpty)
  },
  /** 反链：引用了该卡的卡片数组（被删来源卡带 missing:true）@returns {Promise<Note[]>} */
  backlinks(id: string) : Promise<Note[]> {
    return invoke<Note[]>(IPC_ROUTES.noteBacklinks, { id })
  },
  /** 引用计数 `{ [noteId]: number }`（供列表画 ↩N 徽标）@returns {Promise<Record<string, number>>} */
  refCounts() : Promise<Record<string, number>> {
    return invoke(IPC_ROUTES.noteRefCounts)
  },
  // ── 集锦图片资产（P2）──
  /**
   * 按 URL 抓图并落盘（带当前标签 session 的 cookie 与 referer）。
   * @param {{ url: string, referer?: string }} input
   * @returns {Promise<{ ok:boolean, assetPath?:string|null, thumbPath?:string, assetMime?:string,
   *   assetWidth?:number, assetHeight?:number, oversize?:boolean, reason?:string }>}
   */
  assetFetch({ url, referer }: JsonRecord = {}) : Promise<{ ok:boolean, assetPath?:string|null, thumbPath?:string, assetMime?:string,
  assetWidth?:number, assetHeight?:number, oversize?:boolean, reason?:string }> {
    return invoke(IPC_ROUTES.noteAssetFetch, { url, ...(referer ? { referer } : {}) })
  },
  /**
   * 存一段图字节（dataURL）并落盘 —— 粘贴 / 拖放路径用（渲染层拿到的就是 dataURL）。
   * @param {{ dataUrl: string }} input
   * @returns {Promise<{ ok:boolean, assetPath?:string|null, thumbPath?:string, assetMime?:string,
   *   assetWidth?:number, assetHeight?:number, oversize?:boolean, reason?:string }>}
   */
  assetSaveBuffer({ dataUrl }: JsonRecord = {}) : Promise<{ ok:boolean, assetPath?:string|null, thumbPath?:string, assetMime?:string,
  assetWidth?:number, assetHeight?:number, oversize?:boolean, reason?:string }> {
    return invoke(IPC_ROUTES.noteAssetSaveBuffer, { dataUrl })
  },
  /**
   * 读缩略图（或原图兜底）→ dataURL，供 `<img src>` 直接用。
   * 读不到回 `{ dataUrl: null }`（面板据此回落类型图标占位）。
   * @param {string} path 库里的 `thumbPath` / `assetPath`（相对 userData）
   */
  assetThumb(path: string) {
    return invoke(IPC_ROUTES.noteAssetThumb, { path })
  },
  /** 用系统默认程序打开原图 @param {string} path 库里的 `assetPath`（相对 userData） */
  assetOpen(path: string) {
    return invoke(IPC_ROUTES.noteAssetOpen, { path })
  },
  /**
   * 导出集锦内容到文件（主进程弹保存框 + 写文件）。
   *
   * `encoding` 默认 `'utf8'`；插件格式可传 `'base64'` 走二进制写入。
   * @param {{ format: string, filename?: string, content: string, encoding?: 'utf8'|'base64' }} input
   * @returns {Promise<{ ok:boolean, canceled?:boolean, path?:string, error?:string }>}
   */
  exportFile({ format, filename, content, encoding }: JsonRecord = {}) : Promise<{ ok:boolean, canceled?:boolean, path?:string, error?:string }> {
    return invoke(IPC_ROUTES.noteExportFile, {
      format,
      ...(filename ? { filename } : {}),
      content,
      ...(encoding === 'base64' ? { encoding } : {})
    })
  },
  /**
   * 拉取「上一次 open-view 意图」（面板挂载时调用一次，取完即清）。
   *
   * 与 `note:open-view` 事件是**同一份载荷**的两条投递路径：面板本次才打开时，
   * 它的 renderer 还在加载、事件会丢 —— 主进程会把载荷留在本窗口的 pending 槽，
   * 由面板在这儿主动取一次（见 main/note-actions.js#revealInPanel）。
   * @returns {Promise<{ folderId?: string, noteId?: string, section?: string, open?: boolean } | null>}
   */
  takeOpenView() : Promise<{ folderId?: string, noteId?: string, section?: string, open?: boolean } | null> {
    return invoke(IPC_ROUTES.noteTakeOpenView)
  },
  // ── 文件夹 ──
  folders() {
    return invoke(IPC_ROUTES.noteFolderList)
  },
  addFolder({ name, parentId }: JsonRecord = {}) {
    return invoke(IPC_ROUTES.noteFolderAdd, {
      ...(name != null ? { name } : {}),
      ...(parentId != null ? { parentId } : {})
    })
  },
  renameFolder(id: string, name: string) {
    return invoke(IPC_ROUTES.noteFolderRename, { id, name })
  },
  removeFolder(id: string) {
    return invoke(IPC_ROUTES.noteFolderRemove, { id })
  },
  /** 拖拽：把文件夹移到另一父级（null = 根级） */
  moveFolder(id: string, parentId: string | null) {
    return invoke(IPC_ROUTES.noteFolderMove, { id, parentId: parentId ?? null })
  },
  /** 拖拽：同一父级下重排 */
  reorderFolders(parentId: string | null, orderedIds: string[]) {
    return invoke(IPC_ROUTES.noteFolderReorder, { parentId: parentId ?? null, orderedIds })
  },
  folderCounts() {
    return invoke(IPC_ROUTES.noteFolderCounts)
  },
  /** 订阅任何来源的笔记变更（payload: { reason, id }） */
  onChanged(fn: (payload: JsonRecord) => void) {
    listeners.add(fn)
    ensureBridgeSubscription()
    return () => {
      listeners.delete(fn)
      if (listeners.size === 0 && bridgeSubscription) {
        bridgeSubscription()
        bridgeSubscription = null
      }
    }
  }
}



