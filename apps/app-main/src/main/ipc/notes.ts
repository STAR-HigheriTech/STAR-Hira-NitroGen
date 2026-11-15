import { BrowserWindow, type WebContents } from 'electron'
import { createProviderInvoker } from './provider-bridge'
import type { ProviderRegistryPort } from './provider-bridge'
import type { IpcRoutes, IpcSchemas, IpcTypedMain } from './types'

type MethodPort = Record<string, (...args: unknown[]) => unknown>
interface PageInfo { tabId: string; url: string; title: string; wc: WebContents | null }
interface PageSource { url: string; title: string; wc: WebContents | null; from: 'tab' | 'explicit' | 'active' }
interface NotesIpcContext {
  routes: IpcRoutes
  schemas: IpcSchemas['notes']
  notesService: MethodPort
  providerRegistry?: ProviderRegistryPort | null
  notesAssets?: {
    capturePageThumb(webContents: WebContents): Promise<unknown> | unknown
    fetchToAsset(request: unknown): unknown
    saveBufferFromDataUrl(request: unknown): unknown
    readThumb(path: unknown): unknown
    openAsset(path: unknown): unknown
  } | null
  tabManager?: MethodPort | null
  takeOpenView?: ((windowId: number) => unknown) | null
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' ? value as Record<string, unknown> : {}
}
// 保存框 / 文件名清洗 / 写盘 = 唯一落盘点（与 `note:export` 动作共用）。
const { saveNotesFile } = require('../notes-export-file.js') as {
  saveNotesFile(...args: unknown[]): Promise<{ ok?: boolean; path?: string; error?: unknown }> | { ok?: boolean; path?: string; error?: unknown }
}
// 「发送方属于哪个窗口」—— 面板是 WebContentsView，fromWebContents 同样成立（见 ipc/find.js）。
// 「算不算普通网页」的唯一判据（收录入口的可用性）。
const { isHttpUrl } = require('@hira-ng/shared-types/src/url-protocols.mjs') as { isHttpUrl(url: string): boolean }


/**
 * 笔记域 IPC 注册器 —— 与 ipc/bookmarks.js 同构：
 * 每个 handler 走 `invoke(capability, fallback)`，缺插件时回落到域服务直连。
 *
 * `list` 的 folderId 三态（省略 / null / 字符串）用 `'folderId' in req` 判定 ——
 * 用 `req.folderId != null` 会把「根级」与「全部」压成同一个分支，
 * 症状是「点『全部笔记』只看得到未归档的」，且完全看不出是哪一步丢的语义。
 */
export function registerNotesIpc(
  typedMain: IpcTypedMain,
  { routes, schemas, notesService, providerRegistry, notesAssets, tabManager, takeOpenView }: NotesIpcContext
): void {
  if (!notesService) return

  const invoke = createProviderInvoker(providerRegistry)

  /** 取一个安全字符串（webContents 可能已销毁 —— 任何取值访问都不该把收录整条打挂）。 */
  const safeStr = (fn: () => unknown): string => { try { return String(fn() || '') } catch (_) { return '' } }
  /** 本 IPC 发送方所属窗口的标签列表（`tabManager` 是 scoped 代理，按发送方解析）。 */
  const safeTabs = (): Array<Record<string, unknown>> => {
    try {
      const list = tabManager && typeof tabManager.list === 'function' ? tabManager.list() : []
      return Array.isArray(list) ? list.map(asRecord) : []
    } catch (_) { return [] }
  }
  /** 某个标签的 webContents（只读口；休眠 / 已销毁返回 null，绝不创建视图）。 */
  const safeWc = (tabId: unknown): WebContents | null => {
    if (!tabId) return null
    try {
      if (!tabManager || typeof tabManager.getWebContents !== 'function') return null
      const wc = tabManager.getWebContents(String(tabId)) as WebContents | null
      return wc && !wc.isDestroyed() ? wc : null
    } catch (_) { return null }
  }

  /**
   * 一个标签此刻的 `{ url, title, wc }`。
   *
   * 优先读**活着的 webContents**（`getURL()` / `getTitle()`）—— 那是这一页「此刻真的在显示
   * 什么」的最终事实；只有拿不到活体（标签休眠 / 视图未建）时才退回标签记录
   *（`tabManager.list()` 里的 url/title，由导航事件书写，是同一份展示口径）。
   */
  function pageInfoOf(tabId: unknown): PageInfo | null {
    if (!tabId) return null
    const wc = safeWc(tabId)
    if (wc) {
      const url = safeStr(() => wc.getURL())
      const title = safeStr(() => wc.getTitle())
      if (url || title) return { tabId: String(tabId), url, title, wc }
    }
    const rec = safeTabs().find((t) => t && String(t.tabId) === String(tabId)) || null
    if (!rec) return wc ? { tabId: String(tabId), url: '', title: '', wc } : null
    return { tabId: String(tabId), url: String(rec.url || ''), title: String(rec.title || ''), wc }
  }

  /**
   * 「这一次收的是哪一页」——**画面来源的唯一判据，全部在主进程**。
   *
   * ── 为什么必须收在主进程（这是本模块最要紧的一条口径）────────────────────
   * 「哪个标签是活动标签」**只有主进程是权威**（`TabManager#_layout.getActiveTabId()`；
   * 横向标签条 / 纵向标签列 / 分屏 / 速览 / 任务管理器看到的都只是它的一份投影，
   * 见 TabManager 里那句"活动标签只有这里是权威"）。若让渲染层自己去找活动标签、
   * 再把结果当参数送回来，就成了**两处各自猜**：两次读取之间用户切了标签，
   * 或者渲染层拿到的是另一套排序/过滤（例如 `list()` 是按窗口当前**空间**过滤的投影），
   * 收录的就会是"渲染层以为的那一页"而不是"用户真的在看的那一页"——这种漂移不报错，只是收错。
   * 因此：**渲染层只发"我要收当前页"这个意图**（`kind:'page'` 且不带 url/tabId），
   * 由这里按 IPC 发送方（`runWithSender`）解析到所属窗口，再问它的 TabManager。
   *
   * 三种入参（按优先级），对应三条收录入口：
   *   1. `tabId` —— 某个**具体标签**（标签右键「收进集锦…」）：从那个标签取 url/title/webContents；
   *   2. 显式 `url` —— 调用方已经知道是哪一页（粘贴 / 拖放 / 链接，以及标签右键的兜底）：
   *      url/title 用它；webContents 只按 url 在**本窗口**标签里找一次（只为缩略图，找不到就留空）；
   *   3. 都没有 —— **发送方窗口的活动标签**（面板「+ 添加当前页面」、应用菜单「把当前页收进」）。
   *
   * @returns {{url:string, title:string, wc:Electron.WebContents|null, from:'tab'|'url'|'active'}|null}
   */
  function resolvePageSource(input: Record<string, unknown> = {}): PageSource | null {
    const tabId = input.tabId ? String(input.tabId) : ''
    if (tabId) {
      const info = pageInfoOf(tabId)
      if (info) return { url: info.url, title: info.title, wc: info.wc, from: 'tab' }
    }
    const explicitUrl = input.url ? String(input.url) : ''
    if (explicitUrl) {
      const rec = safeTabs().find((t) => t && String(t.url || '') === explicitUrl) || null
      return {
        url: explicitUrl,
        title: input.title ? String(input.title) : (rec ? String(rec.title || '') : ''),
        wc: rec ? safeWc(rec.tabId) : null,
        from: 'explicit'
      }
    }
    let activeId = ''
    try { activeId = tabManager && typeof tabManager.getActiveTabId === 'function' ? String(tabManager.getActiveTabId() || '') : '' } catch (_) { activeId = '' }
    if (!activeId) return null
    const info = pageInfoOf(activeId)
    return info ? { url: info.url, title: info.title, wc: info.wc, from: 'active' } : null
  }

  /**
   * 网页卡落库后**异步**补一张页面缩略图 —— 走 IPC 的收录入口共用这一步。
   *
   * 三条纪律（照 shared-types 与 notes-assets 的口径）：
   *   1. **绝不阻塞落库**：先 addCaptured 落库、立刻把卡片返回给面板，抓图在后台跑；
   *      抓成功后 `notes.update({thumbPath})` 会发 `note:changed`，面板自然刷新出预览图。
   *   2. **抓不到就留空**：卡片退化成"无预览区"（界面不留空框），不报错、不弹窗。
   *   3. **画面来源由调用方给**：这里只认一个已经解析好的 webContents
   *      （见 `resolvePageSource`）——**不再按 URL 去标签里反查**：那是"再猜一次"，
   *      与 resolvePageSource 的判据一旦分叉就会抓到别的标签。
   *
   * ⚠ 页面右键那条（主进程直落库，见 browser-window-assembly#capturePageIntoCollection）
   *   不走这里 —— 它手里直接就有被右键那一页的 webContents，同一条"画面来源由调用方给"。
   *
   * @param {{id:string, url:string}} note 已落库的网页卡
   * @param {Electron.WebContents|null} wc 该页的画面来源
   */
  function fillPageThumb(note: Record<string, unknown>, wc: WebContents | null): void {
    if (!notesAssets || typeof notesAssets.capturePageThumb !== 'function') return
    if (!wc || (typeof wc.isDestroyed === 'function' && wc.isDestroyed())) return
    // 后台抓图：抓不到（页面已销毁 / 内部页 / 受限）就安静收场，绝不弹错。
    Promise.resolve()
      .then(() => notesAssets.capturePageThumb(wc))
      .then((value) => {
        const res = asRecord(value)
        if (!res || !res.ok || !res.thumbPath) return
        return invoke('notes.update', () => notesService.update(note.id, { thumbPath: res.thumbPath }), { id: note.id })
      })
      .catch(() => {})
  }

  typedMain.handle(routes.noteList, {
    requestSchema: schemas.list.request,
    responseSchema: schemas.list.response,
    handler: async (_e, req) => {
      const options = req && Object.prototype.hasOwnProperty.call(req, 'folderId')
        ? { folderId: req.folderId }
        : {}
      return invoke('notes.list', () => notesService.list(options), options)
    }
  })
  typedMain.handle(routes.noteGet, { requestSchema: schemas.get.request, responseSchema: schemas.get.response, handler: async (_e, req) => invoke('notes.get', () => notesService.get(req.id), req) })
  typedMain.handle(routes.noteAdd, { requestSchema: schemas.add.request, responseSchema: schemas.add.response, handler: async (_e, req) => invoke('notes.add', () => notesService.add(req || {}), req || {}) })
  typedMain.handle(routes.noteUpdate, {
    requestSchema: schemas.update.request,
    responseSchema: schemas.update.response,
    handler: async (_e, req) => {
      const { id, ...patch } = req
      return invoke('notes.update', () => notesService.update(id, patch), req)
    }
  })
  typedMain.handle(routes.noteRemove, {
    requestSchema: schemas.remove.request,
    responseSchema: schemas.remove.response,
    handler: async (_e, req) => ({ ok: await invoke('notes.remove', () => notesService.remove(req.id), req) })
  })
  typedMain.handle(routes.noteSearch, { requestSchema: schemas.search.request, responseSchema: schemas.search.response, handler: async (_e, req) => invoke('notes.search', () => notesService.search(req.query), req) })
  typedMain.handle(routes.noteMove, { requestSchema: schemas.move.request, responseSchema: schemas.move.response, handler: async (_e, req) => invoke('notes.move', () => notesService.move(req.id, req.folderId), req) })
  typedMain.handle(routes.notePinSet, { requestSchema: schemas.pinSet.request, responseSchema: schemas.pinSet.response, handler: async (_e, req) => invoke('notes.setPinned', () => notesService.setPinned(req.id, req.pinned), req) })
  typedMain.handle(routes.noteReorder, {
    requestSchema: schemas.reorder.request,
    responseSchema: schemas.reorder.response,
    handler: async (_e, req) => ({ ok: await invoke('notes.reorder', () => notesService.reorder(req.folderId, req.orderedIds), req) })
  })
  typedMain.handle(routes.noteFolderList, { requestSchema: schemas.folderList.request, responseSchema: schemas.folderList.response, handler: async () => invoke('notes.listFolders', () => notesService.listFolders(), null) })
  typedMain.handle(routes.noteFolderAdd, {
    requestSchema: schemas.folderAdd.request,
    responseSchema: schemas.folderAdd.response,
    handler: async (_e, req) => ({ id: await invoke('notes.addFolder', () => notesService.addFolder(req || {}), req || {}) })
  })
  typedMain.handle(routes.noteFolderRename, {
    requestSchema: schemas.folderRename.request,
    responseSchema: schemas.folderRename.response,
    handler: async (_e, req) => ({ ok: await invoke('notes.renameFolder', () => notesService.renameFolder(req.id, req.name), req) })
  })
  typedMain.handle(routes.noteFolderRemove, {
    requestSchema: schemas.folderRemove.request,
    responseSchema: schemas.folderRemove.response,
    handler: async (_e, req) => ({ ok: await invoke('notes.removeFolder', () => notesService.removeFolder(req.id), req) })
  })
  typedMain.handle(routes.noteFolderMove, {
    requestSchema: schemas.folderMove.request,
    responseSchema: schemas.folderMove.response,
    handler: async (_e, req) => ({ ok: await invoke('notes.moveFolder', () => notesService.moveFolder(req.id, req.parentId), req) })
  })
  typedMain.handle(routes.noteFolderReorder, {
    requestSchema: schemas.folderReorder.request,
    responseSchema: schemas.folderReorder.response,
    handler: async (_e, req) => ({ ok: await invoke('notes.reorderFolders', () => notesService.reorderFolders(req.parentId, req.orderedIds), req) })
  })
  typedMain.handle(routes.noteFolderCounts, {
    requestSchema: schemas.folderCounts.request,
    responseSchema: schemas.folderCounts.response,
    handler: async () => invoke('notes.folderCounts', () => notesService.folderCounts(), null)
  })
  // ── 集锦（经典 Edge Collections 完全体）──────────────────────────────
  //
  // 网页卡的 url / title / 缩略图来源**全部在这里解析**（见 resolvePageSource 的说明）：
  // 渲染层只发"收什么"的意图与目标集锦，不接受它上报的"当前活动标签"——
  // 于是「面板按钮 / 标签右键 / 粘贴 / 拖放 / 链接」五条入口共用同一个权威判据。
  typedMain.handle(routes.noteCapture, {
    requestSchema: schemas.capture.request,
    responseSchema: schemas.capture.response,
    handler: async (_e, req) => {
      const input = req && typeof req === 'object' ? { ...req } : {}
      // folderId 的**三态**必须原样带到域层：省略 / null（未归档）/ 字符串。
      // 这里刻意不做 `folderId ?? null` 之类的归一 —— 那会把"调用方没给"压成"未归档"。
      const hasFolder = Object.prototype.hasOwnProperty.call(input, 'folderId')
      const folderPatch = hasFolder ? { folderId: input.folderId } : {}
      const kind = input.kind

      if (kind === 'page') {
        const source = resolvePageSource(input)
        const url = source ? String(source.url || '') : ''
        // 什么时候算"没收到可用网页"：
        //   · 一个 url 都没解析出来（没有活动标签 / 调用方也没给）；
        //   · 或这次是**收当前页**（`from:'active'`，面板按钮）而那页是内部页
        //     （about: / hira: …）—— 收进去当"网页卡"毫无意义，退化成一条 note。
        // ⚠ 调用方**显式给 url** 的（粘贴 / 拖放 / 链接 / 标签右键）一律原样收下：
        //   那是它明确要收的东西，主进程不替它二次判定（与改造前的行为一致）。
        const usable = !!source && !!url && (source.from !== 'active' || isHttpUrl(url))
        if (!usable || !source) {
          // 标题尽量用页面标题（至少让用户看到"收进来了什么"），没有就是空标题（显示为未命名笔记）。
          const title = (source && source.title) || input.title || ''
          return invoke('notes.addCaptured', () => notesService.addCaptured({ kind: 'note', title, content: '', ...folderPatch }), { kind: 'note', title, ...folderPatch })
        }
        const payload = {
          kind: 'page',
          url,
          // 标题优先用调用方给的（标签右键带的是链接文字 / 标签标题），否则用页面权威标题。
          title: input.title ? String(input.title) : (source.title || url),
          ...(input.sourceTitle ? { sourceTitle: String(input.sourceTitle) } : (source.title ? { sourceTitle: source.title } : {})),
          ...folderPatch
        }
        const note = asRecord(await invoke('notes.addCaptured', () => notesService.addCaptured(payload), payload))
        // 网页卡且还没有缩略图（新卡 / 去重返回的旧卡可能已带图）→ 异步补一张。
        // 放在**返回之前同步判定、后台执行**：落库已经完成，抓图不会拖慢面板。
        if (note.kind === 'page' && note.url && !note.thumbPath) fillPageThumb(note, source.wc)
        return note
      }

      const payload = { ...input }
      const note = await invoke('notes.addCaptured', () => notesService.addCaptured(payload), payload)
      return note
    }
  })
  // ── 集锦「打开视图」的补发口 ──────────────────────────────────────────
  //
  // 面板挂载后**主动来取一次**：动作层在面板未开时把 open-view 载荷留在 pending 槽
  //（见 main/note-actions.js#revealInPanel）。为什么必须是拉取：面板是独立 renderer，
  // 关掉即销毁；「先 showPanel 再 emit」时订阅还没挂上，事件会直接丢。
  //
  // 按**发送方窗口**取 —— pending 槽按窗口隔离（A 窗口收录不该让 B 窗口跳卡）。
  // `BrowserWindow.fromWebContents` 对面板这种 WebContentsView 同样成立。
  if (typeof takeOpenView === 'function') {
    typedMain.handle(routes.noteTakeOpenView, {
      requestSchema: schemas.takeOpenView.request,
      responseSchema: schemas.takeOpenView.response,
      handler: async (e) => {
        const event = asRecord(e)
        const sender = event.sender as WebContents | undefined
        const win = sender ? BrowserWindow.fromWebContents(sender) : null
        return win ? takeOpenView(win.id) : null
      }
    })
  }
  typedMain.handle(routes.noteRestore, {
    requestSchema: schemas.restore.request,
    responseSchema: schemas.restore.response,
    handler: async (_e, req) => ({ ok: await invoke('notes.restore', () => notesService.restore(req.id), req) })
  })
  typedMain.handle(routes.notePurge, {
    requestSchema: schemas.purge.request,
    responseSchema: schemas.purge.response,
    handler: async (_e, req) => ({ ok: await invoke('notes.purge', () => notesService.purge(req.id), req) })
  })
  typedMain.handle(routes.noteTrashList, {
    requestSchema: schemas.trashList.request,
    responseSchema: schemas.trashList.response,
    handler: async () => invoke('notes.listTrash', () => notesService.listTrash(), null)
  })
  typedMain.handle(routes.noteTrashEmpty, {
    requestSchema: schemas.trashEmpty.request,
    responseSchema: schemas.trashEmpty.response,
    // 清空是幂等的成功动作：回收站本来就空也算成功（域返回清掉的张数，这里只报 ok）。
    handler: async () => {
      await invoke('notes.emptyTrash', () => notesService.emptyTrash(), null)
      return { ok: true }
    }
  })
  typedMain.handle(routes.noteBacklinks, {
    requestSchema: schemas.backlinks.request,
    responseSchema: schemas.backlinks.response,
    handler: async (_e, req) => invoke('notes.backlinks', () => notesService.backlinks(req.id), req)
  })
  typedMain.handle(routes.noteRefCounts, {
    requestSchema: schemas.refCounts.request,
    responseSchema: schemas.refCounts.response,
    handler: async () => invoke('notes.refCounts', () => notesService.refCounts(), null)
  })

  // ── 集锦图片资产（P2）────────────────────────────────────────────────
  // 这四条**不走 provider invoke**：它们不是笔记域的 capability ——
  // 没有一个插件会"提供抓图能力"，硬塞进 provider 体系只会让"插件被禁用"的判定
  // 误伤到它们（见 provider-bridge.js 的三态说明）。实现全在 main/notes-assets.js。
  if (notesAssets) {
    typedMain.handle(routes.noteAssetFetch, {
      requestSchema: schemas.assetFetch.request,
      responseSchema: schemas.assetFetch.response,
      handler: async (_e, req) => notesAssets.fetchToAsset(req || {})
    })
    typedMain.handle(routes.noteAssetSaveBuffer, {
      requestSchema: schemas.assetSaveBuffer.request,
      responseSchema: schemas.assetSaveBuffer.response,
      handler: async (_e, req) => notesAssets.saveBufferFromDataUrl(req || {})
    })
    typedMain.handle(routes.noteAssetThumb, {
      requestSchema: schemas.assetThumb.request,
      responseSchema: schemas.assetThumb.response,
      handler: async (_e, req) => notesAssets.readThumb(req && req.path)
    })
    typedMain.handle(routes.noteAssetOpen, {
      requestSchema: schemas.assetOpen.request,
      responseSchema: schemas.assetOpen.response,
      handler: async (_e, req) => notesAssets.openAsset(req && req.path)
    })
  }

  // ── 集锦导出到文件（md / html / json）────────────────────────────────
  // 与 profile-archive.js 同构：本层只做「弹原生保存框 + 写文本」，内容序列化在面板侧
  // 纯函数里（panel-notes.model.js）—— 主进程不认识"一张卡片该序列化成什么语法"。
  // 取消安静收场；出错降级成 `{ ok:false, error }` 交回面板，绝不上抛。
  typedMain.handle(routes.noteExportFile, {
    requestSchema: schemas.exportFile.request,
    responseSchema: schemas.exportFile.response,
    handler: async (_e, req) => saveNotesFile({
      format: req && req.format,
      filename: req && req.filename,
      content: req && req.content,
      encoding: req && req.encoding
    })
  })
}

