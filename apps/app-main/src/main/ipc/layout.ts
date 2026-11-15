import type { IpcMain, WebContents } from 'electron'
import { IPC_EVENTS } from '@hira-ng/shared-types/src/ipc-channels'
import { errorMessage } from './types'
import type { IpcRoutes, IpcSchemas, IpcTypedMain } from './types'
import { ipcSenderSurface } from '../ipc-sender-trust'

type MethodPort = Record<string, (...args: unknown[]) => unknown>
interface PanelCatalogPort {
  ids(): unknown
  list(): unknown
  has(id: string): boolean
}
interface WebSidebarPort {
  open(url: unknown, options: { side: unknown }): unknown
  close(): unknown
  setWidth(width: unknown): unknown
  ownsWebContents(webContents: unknown): boolean
  command(command: string): unknown
  movePreview(x: unknown): unknown
  cancelMove(): unknown
  commitMove(): unknown
}
interface LayoutIpcContext {
  routes: IpcRoutes
  schemas: IpcSchemas['layout']
  getPanelCatalog?: () => PanelCatalogPort | null
  layoutCoordinator: MethodPort
  ipcMain?: IpcMain
  getTabManager?: () => MethodPort | null
  getWebSidebar?: () => WebSidebarPort | null
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' ? value as Record<string, unknown> : {}
}

function asWebContents(value: unknown): WebContents | null {
  return value && typeof value === 'object' && 'send' in value ? value as WebContents : null
}

/** 裸 send 通道只接受内部 UI 视图；网页 preload 永远不能改布局。 */
function isTrustedUiEvent(event: unknown): boolean {
  try {
    return ipcSenderSurface(event as never) === 'trusted-ui'
  } catch (_) {
    return false
  }
}

/**
 * IPC · Layout / Overlay 域
 *
 * 面板与布局、overlay 独立浮层（searchbar/tab-preview/permission-popover）、
 * 以及密码浮层的 interactive/bounds/ready 控制 —— 全部是 layoutCoordinator 的职责面。
 *
 * 性能优化：浮层 show/hide/display 使用单向 IPC（ipcMain.on + ipcRenderer.send），
 * 不创建 Promise、不等待返回 —— 从 3 次往返降至 0 次往返。
 * display 路由合并 bounds + interactive 为单次 IPC。
 * hide 路由在主进程直接收起浮层，不等 renderer 回传。
 */

export function registerLayoutIpc(
  typedMain: IpcTypedMain,
  { routes, schemas, getPanelCatalog, layoutCoordinator, ipcMain, getTabManager, getWebSidebar }: LayoutIpcContext
): void {
  const rawIpcMain = ipcMain && typeof ipcMain.on === 'function' ? ipcMain : null
  // ── 单向 IPC 通道名构造（与 preload makeChannel 一致）──
  const sendCh = (route: string): string => `ngipc:send:${route}`
  const evtCh = (route: string): string => `ngipc:event:${route}`

  /**
   * 面板目录按**调用时刻**现取，不缓存快照。
   * 面板集合会随插件启停变化（禁用一个面板插件 → 它的按钮与面板一起消失），
   * 启动期把目录拷成常量会让 rail/navbar 永远停在旧集合上。
   */
  const catalog = () => {
    if (typeof getPanelCatalog !== 'function') return null
    try {
      return getPanelCatalog()
    } catch (_) {
      return null
    }
  }

  /**
   * 本窗口**当前页**的 URL（rail 的 `+` 用它把当前页加为面板，对齐 Vivaldi 的加号语义）。
   *
   * 为什么由主进程回答：活动标签只有主进程是权威（渲染层各自维护一份"谁是当前标签"就会漂移
   * —— 与分屏的"另一个格子由主进程解析"同一条理由）。
   * @returns {string} 取不到 / 不是 http(s) 时返回 ''（调用方据此拒绝）
   */
  const currentPageUrl = () => {
    const tm = typeof getTabManager === 'function' ? getTabManager() : null
    if (!tm) return ''
    try {
      const activeId = typeof tm.getActiveTabId === 'function' ? String(tm.getActiveTabId() || '') : ''
      if (!activeId || typeof tm.list !== 'function') return ''
      const tabs = Array.isArray(tm.list()) ? tm.list() as Array<Record<string, unknown>> : []
      const active = tabs.find((tab) => String(tab.tabId) === activeId)
      return active?.url ? String(active.url) : ''
    } catch (_) {
      return ''
    }
  }

  // ── Panel / 布局（invoke，需要返回值）──
  typedMain.handle(routes.panelList, {
    requestSchema: schemas.panelList.request,
    responseSchema: schemas.panelList.response,
    handler: async () => {
      const c = catalog()
      return c ? c.ids() : []
    }
  })

  // 面板目录：id + 中文名 + 图标名 + 顺序 + 段。
  // rail / navbar / 按钮编辑浮层全部消费它 —— 这是「面板即插件」在渲染层的唯一入口。
  typedMain.handle(routes.panelCatalog, {
    requestSchema: schemas.panelCatalog.request,
    responseSchema: schemas.panelCatalog.response,
    handler: async () => {
      const c = catalog()
      return { panels: c ? c.list() : [] }
    }
  })

  typedMain.handle(routes.panelToggle, {
    requestSchema: schemas.panelToggle.request,
    responseSchema: schemas.panelToggle.response,
    handler: async (_e, req) => {
      const id = String(req.panelId)
      // 目录校验：插件已被禁用 / id 拼错时拒绝，而不是让布局层去打开一个不存在的面板
      // （那会创建出一个永远渲染 "Unknown panel" 的空视图并常驻内存）。
      const c = catalog()
      if (c && !c.has(id)) {
        console.warn(`[layout] panel:toggle ignored, panel not in catalog: ${id}`)
        return { open: false, panelId: id }
      }
      // side：由**打开它的入口**决定面板显示在哪一侧 —— navbar 的按钮在右侧，传 'right'；
      // rail 图标传自己所在那一侧。不传 = 纯开关语义（面板自己的关闭按钮走这条）。
      // 见契约 layout.js 里 panelToggle.request.side 的说明。
      const res = asRecord(layoutCoordinator.togglePanel(id, { side: req.side || null }))
      // 响应只回契约里声明过的字段（面板实际在哪一侧由 panel:side / 推送单独给）
      return { open: !!res.open, panelId: String(res.panelId || id) }
    }
  })

  typedMain.handle(routes.panelShow, {
    requestSchema: schemas.panelShow.request,
    responseSchema: schemas.panelShow.response,
    handler: async (_e, req) => {
      const id = String(req.panelId)
      const c = catalog()
      if (c && !c.has(id)) {
        console.warn(`[layout] panel:show ignored, panel not in catalog: ${id}`)
        return { open: false, panelId: id }
      }
      const res = asRecord(layoutCoordinator.showPanel(id, req.side || null))
      return { open: !!res.open, panelId: String(res.panelId || id) }
    }
  })

  // 面板**实际所在侧**：面板宿主启动时问一次 —— 它是谁、该把拖拽手柄放哪条边。
  // 不能只靠事件推送：面板视图的创建早于它订阅事件，那一次推送必然丢掉。
  typedMain.handle(routes.panelSide, {
    requestSchema: schemas.panelSide.request,
    responseSchema: schemas.panelSide.response,
    handler: async (_e, req) => {
      const id = req && req.panelId ? String(req.panelId) : ''
      const side = id ? layoutCoordinator.getPanelSideOf(id) : null
      // pinned 与 side 一起回答：宿主靠它决定宽度写哪个槽、图钉画成什么状态。
      const pinned = !!(id && side && typeof layoutCoordinator.isPanelPinned === 'function'
        ? layoutCoordinator.isPanelPinned(id)
        : false)
      return { side, pinned }
    }
  })

  // 钉住 / 取消钉住（标题栏图钉）。钉住 = 移到钉住位常驻，切换面板不再动它。
  typedMain.handle(routes.panelPin, {
    requestSchema: schemas.panelPin.request,
    responseSchema: schemas.panelPin.response,
    handler: async (_e, req) => {
      const id = String((req && req.panelId) || '')
      if (!id || typeof layoutCoordinator.pinPanel !== 'function') return { pinned: false, side: null }
      const res = asRecord(layoutCoordinator.pinPanel(id, {
        pinned: req && typeof req.pinned === 'boolean' ? req.pinned : undefined
      }))
      return {
        pinned: !!res.pinned,
        side: res.side === 'left' || res.side === 'right' ? res.side : null
      }
    }
  })

  // 标题栏「换到另一侧」：布局层按同类型槽位原子互换，视图与面板内部状态原地保留。
  typedMain.handle(routes.panelSwapSides, {
    requestSchema: schemas.panelSwapSides.request,
    responseSchema: schemas.panelSwapSides.response,
    handler: async (_e, req) => {
      const id = String((req && req.panelId) || '')
      if (!id || typeof layoutCoordinator.swapPanelSides !== 'function') {
        return { ok: false, panelId: id, side: null, swappedPanelId: null }
      }
      const res = asRecord(layoutCoordinator.swapPanelSides(id))
      const side = res.side === 'left' || res.side === 'right' ? res.side : null
      return {
        ok: res.ok === true && side !== null,
        panelId: String(res.panelId || id),
        side,
        swappedPanelId: typeof res.swappedPanelId === 'string' ? res.swappedPanelId : null
      }
    }
  })

  // ═══════════════════════════════════════════════════════════════════
  //  独立侧栏（Web Sidebar）
  //
  //  它与上面的面板家族**完全平行**：不进目录、不占面板槽、不参与对账。
  //  所有实现都在 `apps/main/web-sidebar.js`（按窗口一份）—— 这里只是它的 IPC 门面。
  // ═══════════════════════════════════════════════════════════════════

  const sidebar = () => {
    if (typeof getWebSidebar !== 'function') return null
    try { return getWebSidebar() } catch (_) { return null }
  }

  /**
   * **「把这个 URL 放进侧栏」**（书签右键 / 收藏面板右键 / 页面右键 / rail 的 `+`）。
   *
   * url 省略 = 「把**当前页**放上侧栏」（rail 的 `+` 就是这个语义；活动标签只有主进程权威）。
   * url 判据在纯层（`normalizeSidebarUrl`，只放 http/https）：非法一律 `open:false`。
   */
  typedMain.handle(routes.webSidebarOpen, {
    requestSchema: schemas.webSidebarOpen.request,
    responseSchema: schemas.webSidebarOpen.response,
    handler: async (_e, req) => {
      const input = req || {}
      const url = input.url || currentPageUrl()
      const inst = sidebar()
      if (!inst) return { open: false, url: '' }
      return inst.open(url, { side: input.side })
    }
  })

  typedMain.handle(routes.webSidebarClose, {
    requestSchema: schemas.webSidebarClose.request,
    responseSchema: schemas.webSidebarClose.response,
    handler: async () => {
      const inst = sidebar()
      return inst ? inst.close() : { open: false }
    }
  })

  // 侧栏宽度（用户拖内缘逐帧上报；区间校验在主进程的 `setWebSidebarWidth`）。
  typedMain.handle(routes.webSidebarSetWidth, {
    requestSchema: schemas.webSidebarSetWidth.request,
    responseSchema: schemas.webSidebarSetWidth.response,
    handler: async (_e, req) => {
      const inst = sidebar()
      return { ok: !!(inst && inst.setWidth(req.width)) }
    }
  })

  /**
   * 侧栏**顶条**的命令（单向，裸通道）。
   *
   * ⚠ **来源校验**（安全边界）：只接受**顶条视图**发来的命令 —— 侧栏里那个远程页
   * 不可能是顶条，所以它天然拿不到这条通道（否则网站就能自己收起侧栏、开新标签）。
   */
  if (ipcMain && typeof ipcMain.on === 'function') {
    /**
     * 调宽把手的**逐帧**通道。
     *
     * 拖动时渲染层每个 rAF 只上报一次目标宽度；这条路径不产生 invoke 回包，也不分配
     * Promise。松手后仍走上面的 invoke 路由做最终确认，因此错误处理与落库语义不变。
     * 载荷复用同一份 schema，非法值直接丢弃，不把脏数据送进原生 bounds。
     */
    rawIpcMain?.on(sendCh(routes.webSidebarSetWidth), (_event, req) => {
      try {
        if (!isTrustedUiEvent(_event)) return
        const parsed = schemas.webSidebarSetWidth.request.safeParse(req)
        if (!parsed.success) return
        const inst = sidebar()
        if (inst) inst.setWidth(parsed.data.width)
      } catch (err) {
        console.warn('[layout] web-sidebar:set-width live failed:', errorMessage(err))
      }
    })

    rawIpcMain?.on(sendCh(routes.webSidebarCommand), (event, req) => {
      try {
        const inst = sidebar()
        const command = String((req && req.command) || '')
        if (!inst || !command || !inst.ownsWebContents(event.sender)) {
          console.warn(`[layout] web-sidebar:command rejected (${command || '?'})`)
          return
        }
        inst.command(command)
      } catch (err) {
        console.warn('[layout] web-sidebar:command failed:', errorMessage(err))
      }
    })

    /**
     * **拖动顶条换边**（拖动中逐帧上报 + 松手落定）。
     *
     * 与上面的命令通道共用同一条**来源校验**：只接受本窗口侧栏自己的视图
     * （顶条是侧栏视图包的一部分）—— 侧栏里那个远程页拿不到这条通道。
     */
    rawIpcMain?.on(sendCh(routes.webSidebarMovePreview), (event, req) => {
      try {
        const inst = sidebar()
        if (!inst || !inst.ownsWebContents(event.sender)) return
        inst.movePreview(req && req.x)
      } catch (err) {
        console.warn('[layout] web-sidebar:move-preview failed:', errorMessage(err))
      }
    })
    rawIpcMain?.on(sendCh(routes.webSidebarMove), (event, req) => {
      try {
        const inst = sidebar()
        if (!inst || !inst.ownsWebContents(event.sender)) return
        // 拖动被中断（Esc / 指针丢失）→ 只撤预览，位置不动
        if (req && req.cancel) inst.cancelMove()
        else inst.commitMove()
      } catch (err) {
        console.warn('[layout] web-sidebar:move failed:', errorMessage(err))
      }
    })
  }

  typedMain.handle(routes.layoutSetHeaderHeight, {
    requestSchema: schemas.setHeaderHeight.request,
    responseSchema: schemas.setHeaderHeight.response,
    handler: async (_e, req) => ({ ok: layoutCoordinator.setHeaderHeight(req.height) })
  })

  typedMain.handle(routes.layoutSetPageLayoutParams, {
    requestSchema: schemas.setPageLayoutParams.request,
    responseSchema: schemas.setPageLayoutParams.response,
    handler: async (_e, req) => ({ ok: layoutCoordinator.setPageLayoutParams(req) })
  })

  // 结构布局参数的高频上报（resize / 拖宽 / 侧栏换形态）：单向、零回包。
  rawIpcMain?.on(sendCh(routes.layoutSetPageLayoutParams), (_event, req) => {
    try {
      if (!isTrustedUiEvent(_event)) return
      const parsed = schemas.setPageLayoutParams.request.safeParse(req)
      if (!parsed.success) return
      layoutCoordinator.setPageLayoutParams(parsed.data)
    } catch (err) {
      console.warn('[layout] page-layout live failed:', errorMessage(err))
    }
  })

  typedMain.handle(routes.layoutSetPanelWidth, {
    requestSchema: schemas.setPanelWidth.request,
    responseSchema: schemas.setPanelWidth.response,
    // side：两侧面板位各有独立宽度，写入按发送方声明的那一侧落到对应的位上。
    // slot：同一侧有普通位 / 钉住位两格，宽度也各记各的（缺省 = 普通位）。
    handler: async (_e, req) => ({
      ok: layoutCoordinator.setPanelWidth(req.width, req.side || null, req.slot === 'pinned' ? 'pinned' : 'normal')
    })
  })

  // 面板拖宽帧：单向通道；松手仍由上面的 invoke 路由确认最终宽度。
  rawIpcMain?.on(sendCh(routes.layoutSetPanelWidth), (_event, req) => {
    try {
      if (!isTrustedUiEvent(_event)) return
      const parsed = schemas.setPanelWidth.request.safeParse(req)
      if (!parsed.success) return
      const data = parsed.data
      layoutCoordinator.setPanelWidth(
        data.width,
        data.side || null,
        data.slot === 'pinned' ? 'pinned' : 'normal'
      )
    } catch (err) {
      console.warn('[layout] panel-width live failed:', errorMessage(err))
    }
  })

  typedMain.handle(routes.layoutSetRailWidth, {
    requestSchema: schemas.setRailWidth.request,
    responseSchema: schemas.setRailWidth.response,
    handler: async (_e, req) => ({
      ok: layoutCoordinator.setRailWidth(req.width)
    })
  })

  typedMain.handle(routes.layoutSetRailRestore, {
    requestSchema: schemas.setRailRestore.request,
    responseSchema: schemas.setRailRestore.response,
    handler: async (_e, req) => ({
      ok: layoutCoordinator.setRailCloseRestore(req.expanded, req.width)
    })
  })

  // rail 拖宽帧：同上，拖动无回包，松手再走 invoke。
  rawIpcMain?.on(sendCh(routes.layoutSetRailWidth), (_event, req) => {
    try {
      if (!isTrustedUiEvent(_event)) return
      const parsed = schemas.setRailWidth.request.safeParse(req)
      if (!parsed.success) return
      layoutCoordinator.setRailWidth(parsed.data.width)
    } catch (err) {
      console.warn('[layout] rail-width live failed:', errorMessage(err))
    }
  })

  // 把**原生键盘焦点**交给某个已打开面板的视图（「打开面板即聚焦它的搜索框」的
  // 原生那一半；DOM 那只由面板渲染层自己 focus()）。拿不到面板视图时返回 ok:false。
  typedMain.handle(routes.layoutFocusPanel, {
    requestSchema: schemas.focusPanel.request,
    responseSchema: schemas.focusPanel.response,
    handler: async (_e, req) => ({ ok: layoutCoordinator.focusPanel(String(req.panelId)) })
  })

  typedMain.handle(routes.layoutToggleRail, {
    requestSchema: schemas.toggleRail.request,
    responseSchema: schemas.toggleRail.response,
    handler: async () => layoutCoordinator.toggleRail()
  })

  // rail 贴边唤出：未固定时由 LayoutCoordinator 的主进程指针巡看占位展开。
  typedMain.handle(routes.layoutSetRailReveal, {
    requestSchema: schemas.setRailReveal.request,
    responseSchema: schemas.setRailReveal.response,
    handler: async (_e, req) => layoutCoordinator.setRailReveal(req.revealed)
  })

  // ═══════════════════════════════════════════════════════════════════
  //  分屏（Split View）—— 分隔条拖拽 + 几何快照
  //
  //  分隔条是**外壳 renderer 画的 DOM**（不是独立视图）：两格之间的那道缝**没有网页覆盖**
  //  （网页 view 只占各自格矩形），所以 chrome 本体天然显形于缝中，且能收到指针事件。
  //  拖拽用 setPointerCapture，指针移出细条也不会丢事件。
  // ═══════════════════════════════════════════════════════════════════
  typedMain.handle(routes.layoutSplitDrag, {
    requestSchema: schemas.splitDrag.request,
    responseSchema: schemas.splitDrag.response,
    handler: async (_e, req) => layoutCoordinator.applySplitDrag(req)
  })

  /**
   * 分屏拖动帧：与侧栏调宽同一条纪律 —— 热路径单向发送，松手仍走上面的 invoke 确认。
   * 共享 schema 在这里再校验一次，避免裸通道成为绕过 typed IPC 的入口。
   */
  rawIpcMain?.on(sendCh(routes.layoutSplitDrag), (_event, req) => {
    try {
      if (!isTrustedUiEvent(_event)) return
      const parsed = schemas.splitDrag.request.safeParse(req)
      if (!parsed.success) return
      layoutCoordinator.applySplitDrag(parsed.data)
    } catch (err) {
      console.warn('[layout] split-drag live failed:', errorMessage(err))
    }
  })

  typedMain.handle(routes.layoutSplitGeometry, {
    requestSchema: schemas.splitGeometry.request,
    responseSchema: schemas.splitGeometry.response,
    handler: async () => layoutCoordinator.getSplitGeometry()
  })

  // 独立侧栏**聚焦框**几何快照（同 splitGeometry 的思路：渲染层挂载时主动拉一次，
  // 补"订阅晚于首次推送"；之后的更新走 `web-sidebar:changed` 推送）。
  typedMain.handle(routes.layoutWebSidebarGeometry, {
    requestSchema: schemas.webSidebarGeometry.request,
    responseSchema: schemas.webSidebarGeometry.response,
    handler: async () => layoutCoordinator.getWebSidebarFrameGeometry()
  })

  // 速览（A1）**装饰面**（外环阴影 + 聚焦框）的几何快照（同上：渲染层挂载时主动拉一次，
  // 补"订阅晚于首次推送" —— 会话恢复会在外壳订阅之前就把速览还原好；
  // 之后的更新走 `glance:changed` 推送，由外壳 DOM 画）。
  typedMain.handle(routes.layoutGlanceGeometry, {
    requestSchema: schemas.glanceGeometry.request,
    responseSchema: schemas.glanceGeometry.response,
    handler: async () => layoutCoordinator.getGlanceSurfaceGeometry()
  })

  // ═══════════════════════════════════════════════════════════════════
  //  独立浮层图层 —— 单向 IPC（ipcMain.on / ipcRenderer.send）
  //
  //  通道：ngipc:send:<route>
  //  优势：零往返、零 Promise、零序列化开销 —— 主进程同步处理。
  //
  //  三类路由：
  //    show   → 转发给对应浮层 renderer（renderer 测量 DOM 后回传 display）
  //    hide   → 主进程直接收起 bounds+interactive + 通知 renderer 清 DOM
  //    display→ 主进程一次性设置 bounds + interactive（合并 2 次 IPC 为 1 次）
  // ═══════════════════════════════════════════════════════════════════

  const FLOAT_NAMES = [
    'searchbar-overlay',
    'tabpreview-overlay',
    'siteinfo-overlay',
    // 权限申请浮层（独立视图，旧架构回滚）：网页请求摄像头 / 通知等权限时，
    // 由外壳推 show → 浮层实测后经 display 落位到**内容区左上角**
    // （position:'in-content' + align:'left' + valign:'top'）。
    // 名字必须与 electron.vite.config.js 的 renderer input 键逐字一致。
    'permission-overlay',
    // 「总览」浮层（Edge 左上角「标签操作菜单」形态）：空间胶囊当触发器，
    // 卡片里聚合 空间 → 搜索 → 打开的标签 → 最近关闭 → 会话。
    // 名字必须与 electron.vite.config.js 的 renderer input 键逐字一致。
    'overview-overlay',
    'buttons-edit-overlay',
    // ── chrome 级瞬态浮层三兄弟（查找栏 / 悬停 URL / 缩放条）──
    // 加进这张表即自动获得 show / hide / hidden / display 四条单向通道 +
    // set-bounds / set-interactive / ready 三条 invoke 路由（见本文件下方循环）。
    // 三个名字必须与 electron.vite.config.js 的 renderer input 键**逐字一致**，
    // 否则视图建得起来、内容却加载不到（out/renderer/<name>/index.html 不存在）。
    'findbar-overlay',
    'hoverurl-overlay',
    'zoom-overlay',
    // 拖动落点预览（拖标签到网页区域时"这一格会落在哪"的那块半透明）。
    // 与上面三兄弟的差别：它由**主进程**驱动（拖动期间 30fps 采样 → set-bounds + 推 payload），
    // 渲染层从不发 show/display；加进这张表是为了拿到同一族通道（ready 在这条链上会被用到）。
    'dropzone-overlay',
    // 分屏工具条（hover 在分屏上浮出的那排小按钮）。同样是主进程驱动：
    // hover 判定要读**原生视图的格矩形**（渲染层量不到自己盖住的那块页面），
    // 而"指针在哪一格"的这个事实只能由主进程按屏幕光标算出来。
    'split-toolbar',
    // 通用「选择目标」浮层（renderer/target-picker-overlay）：书签栏文件夹下拉 /
    // 「收进集锦…」共用一份实现。由**打开它的视图**发起（外壳 / 面板 / 侧栏）：
    // show 带锚点矩形；浮层与 overview-overlay **同构** —— 铺满整窗，卡片按锚点摆进视图里，
    // display 只上报整窗 bounds（不测卡片尺寸）。
    // 加进这张表即自动获得 show / hide / hidden / display 四条单向通道 +
    // set-bounds / set-interactive / ready 三条 invoke 路由。名字与 electron.vite.config.js
    // 的 renderer input 键**逐字一致**。
    'target-picker-overlay',
    // 侧栏浮出层（Edge 型自动隐藏的悬停展开）：renderer/sidebar-float。
    // 静止时 chrome 里是一条 56px 图标 rail（侧栏区照常占位），指针贴上那一侧窗口边缘时
    // 主进程把这条**独立浮层**铺开盖在网页上 —— 网页不缩进、不重排（用户口径：
    // "edge 模式的固定就是占位，取消固定就是标签 rail + 展开浮层"）。
    // 几何完全由主进程算（见 LayoutCoordinator#_syncSideOverlayFloat），
    // 渲染层只接收 show（带 side）并渲染列表，因此这里不走 show/display 的测量往返。
    // 名字与 electron.vite.config.js 的 renderer input 键**逐字一致**。
    'sidebar-float',
    // 插件浮层宿主（PART18）：插件声明 / 命令式打开的任意浮层都画在这一层。
    // 由外壳推整份快照（`plugin-overlay:show { items }`），宿主实测后经 display 落位。
    'plugin-overlay'
  ]

  for (const name of FLOAT_NAMES) {
    // ── show：ui-shell → 主进程 → 浮层 renderer（单向转发）──
    // 浮层惰性：sendToFloat 会在浮层尚未创建时先惰性创建 view 并等 renderer
    // 就绪（did-finish-load）后再转发 —— 避免「首帧 show 打在空白 renderer 上丢失」。
    rawIpcMain?.on(sendCh(`${name}:show`), (e, req) => {
      // 先登记"请求显示"（逻辑可见态 + 代际号），再转发。
      // 冷启动时 sendToFloat 会 await renderer 就绪 —— 期间若已 hide，守卫会作废本次
      // show，避免它反向插队到 hide 之后把浮层凭空弹出来。
      const seq = layoutCoordinator.noteFloatShow(name, e && e.sender)
      // 坐标归一化：payload 里的 x/y 是**发送方视图内**的坐标。外壳（窗口本体）本身
      // 就是窗口坐标，偏移为 0；侧边面板是独立 WebContentsView，必须补上它自己的偏移，
      // 预览才会落在正确高度上（见 anchorFloatBesidePanel 的注释）。
      const payload = normalizeFloatShow(layoutCoordinator, e && e.sender, req, name)
      Promise.resolve(layoutCoordinator.sendToFloat(
        name,
        evtCh(`${name}:show`),
        payload,
        () => layoutCoordinator.isFloatShowCurrent(name, seq)
      )).catch((error: unknown) => console.error(`[float] ${name}:show failed`, error))
      // 「自己持焦」的浮层（查找栏 / 标签页搜索 / 站点信息）：视图一创建就把键盘焦点交给它。
      // 这类浮层一打开就等着接键盘输入，而 sendToFloat 是**同步建视图**的（见其注释），
      // 所以这里不 await 也能稳稳拿到视图。白名单只有一份（SELF_FOCUS_FLOATS）——
      // 谁发起 show（外壳 / 侧栏 / 主进程）都自动获得同一行为，不靠各调用方各写一遍。
      //
      // 例外：调用方显式 `focus: false`（例如后台触发的展示）——
      // 用户可能正在地址栏输入，浮层不该把键盘焦点抢走。这个字段同时随 payload
      // 透传给浮层 renderer，浮层侧同一判据不调 card.focus()（见 siteinfo view.show）。
      if (!(req && req.focus === false) &&
          typeof layoutCoordinator.isSelfFocusFloat === 'function' &&
          layoutCoordinator.isSelfFocusFloat(name)) {
        layoutCoordinator.focusFloat(name)
      }
    })

    // ── hide：ui-shell → 主进程收起 + 通知 renderer 清 DOM ──
    rawIpcMain?.on(sendCh(`${name}:hide`), (_e, req) => {
      // 主进程直接收起，视觉上瞬间消失。
      // hideFloat 统一处理：逻辑可见态置隐藏 + 代际递增（作废在途 show/display）+ 收起 bounds。
      // keepFocus：调用方声明"本次收起不让位焦点"（如清空输入 → 建议下拉消失，
      // 地址栏必须继续持有焦点）。见 LayoutCoordinator#hideFloat。
      //
      // animateOut：**标签预览**要播退场动效，不能立刻收 bounds（view 缩成 0 就没动画可看）。
      // 这时 hideFloat 只登记"退场中"，bounds 等 renderer 播完回 hidden（见下方通道）再收。
      // 需要动效的浮层写在这里而不是 LayoutCoordinator：图层只管几何，
      // "哪种浮层有动效"是展示语义，属于最外层适配器。
      const animateOut = name === 'tabpreview-overlay'
      const wasOnStage = layoutCoordinator.hideFloat(name, {
        keepFocus: !!(req && req.keepFocus),
        animateOut
      })
      // 返回值契约：`false` = 它本来就没开着（逻辑不可见 + bounds 已归 0 + 没有在途退场），
      // 这时 renderer 那边也没有可收的东西 —— 再发一条 `:hide` 只会让它白跑一遍
      // hide → hidden 的跨进程往返（tabpreview 的回执还会绕回 finishFloatHide）。
      if (!wasOnStage) return
      // 通知 renderer 收起（非阻塞）
      const wc = asWebContents(layoutCoordinator.getFloatWebContents(name))
      if (wc && !wc.isDestroyed()) {
        wc.send(evtCh(`${name}:hide`), req)
      }
    })

    // ── hidden：renderer → 主进程（退场动效播完的回执）──
    // 只有带 animateOut 的浮层会发这条；主进程据此才真正把 bounds 收成 0。
    rawIpcMain?.on(sendCh(`${name}:hidden`), () => {
      if (typeof layoutCoordinator.finishFloatHide === 'function') {
        layoutCoordinator.finishFloatHide(name)
      }
    })

    // ── display：renderer → 主进程一次性设置 bounds + interactive（合并 2 次 IPC 为 1）──
    rawIpcMain?.on(sendCh(`${name}:display`), (e, req) => {
      if (!req) return
      // 逻辑可见态优先：浮层已被收起时，迟到的 display 不得把它复活，
      // 否则浮层会"闪一下又弹出来"。同时确保交互态回落为穿透。
      if (!layoutCoordinator.isFloatVisible(name)) {
        layoutCoordinator.setFloatInteractive(name, false)
        return
      }
      // center=true：浮层位置由主进程按窗口 content 尺寸计算居中（不依赖 renderer 上报坐标）
      if (typeof layoutCoordinator.centerFloat === 'function' && req.center) {
        layoutCoordinator.centerFloat(name, { width: req.width, height: req.height })
      } else if (req.position === 'anchor-below' && typeof layoutCoordinator.anchorFloatBelow === 'function') {
        // anchor-below：贴**锚点矩形正下方**（地址栏 suggestion 下拉）。
        // 渲染层只交**事实**：锚点矩形（地址栏在窗口里的位置/大小，由外壳上报）+
        // 卡片实测 outer 尺寸（含阴影留白 pad）。窗口 content 尺寸与夹取只有主进程知道，
        // 几何一律收在 LayoutCoordinator#anchorFloatBelow 一处（对齐 RT omnibox 的
        // normalizeBounds + addShadowPadding）。
        layoutCoordinator.anchorFloatBelow(name, {
          anchor: req.anchor,
          width: req.width,
          height: req.height,
          pad: req.pad,
          gap: req.gap,
          // 与窗口内容区四边的最小留白（renderer 上报；缺省由 LayoutCoordinator 兜底）。
          margin: req.margin
        })
      } else if (req.position === 'beside-panel' && typeof layoutCoordinator.anchorFloatBesidePanel === 'function') {
        // beside-panel：面板外侧浮层 —— 贴**发起它的那个面板**的外缘（打开标签、
        // 固定标签面板的 hover 预览）。两侧面板可能同时开着，所以贴哪条边必须按发送方
        // 视图判定（哪个面板发的），不能按"活动面板"猜。
        // 渲染层只交出**事实**（卡片实测尺寸 + 锚点行矩形），矩形由主进程用
        // shared-types#resolvePreviewPlacement 解析 —— 面板 bounds 只有主进程知道。
        layoutCoordinator.anchorFloatBesidePanel(name, {
          card: req.card,
          anchor: req.anchor,
          margin: req.margin,
          panelSide: e && e.sender && typeof layoutCoordinator.getPanelSideOfWebContents === 'function'
            ? layoutCoordinator.getPanelSideOfWebContents(e.sender)
            : null
        })
      } else if (req.position === 'below-topbar' && typeof layoutCoordinator.anchorFloatBelowTopbar === 'function') {
        // below-topbar：贴顶浮层 —— 主进程按页面布局参数锚定到内容区右上角
        layoutCoordinator.anchorFloatBelowTopbar(name, { width: req.width, height: req.height, margin: req.margin })
      } else if (req.position === 'in-content' && typeof layoutCoordinator.anchorFloatInContent === 'function') {
        // in-content：贴**网页矩形**内部 —— 查找栏（右上）/ 缩放条（上中）/ 悬停 URL（左下）
        // 都住在这里。为什么必须由主进程落位：网页矩形的 x/y/宽高只在主进程手里
        // （renderer 量不到原生视图的位置），而这三个条恰好都要"贴着网页"而不是"贴着窗口"。
        layoutCoordinator.anchorFloatInContent(name, {
          width: req.width,
          height: req.height,
          align: req.align,
          valign: req.valign,
          margin: req.margin
        })
      } else {
        layoutCoordinator.setFloatBounds(name, req)
      }
      if (typeof req.interactive === 'boolean') {
        layoutCoordinator.setFloatInteractive(name, req.interactive)
      }
    })

    const routePrefix = camelize(name)
    const setBoundsRoute = routes[`${routePrefix}SetBounds` as keyof IpcRoutes]
    const setInteractiveRoute = routes[`${routePrefix}SetInteractive` as keyof IpcRoutes]
    const readyRoute = routes[`${routePrefix}Ready` as keyof IpcRoutes]

    if (setBoundsRoute) {
      typedMain.handle(setBoundsRoute, {
        requestSchema: schemas.floatBounds.request,
        responseSchema: schemas.floatBounds.response,
        handler: async (_e, req) => {
          layoutCoordinator.setFloatBounds(name, req || {})
          return { ok: true }
        }
      })
    }

    if (setInteractiveRoute) {
      typedMain.handle(setInteractiveRoute, {
        requestSchema: schemas.floatInteractive.request,
        responseSchema: schemas.floatInteractive.response,
        handler: async (_e, req) => {
          layoutCoordinator.setFloatInteractive(name, req.interactive)
          return { ok: true }
        }
      })
    }

    if (readyRoute) {
      typedMain.handle(readyRoute, {
        requestSchema: schemas.floatReady.request,
        responseSchema: schemas.floatReady.response,
        handler: async () => ({ ok: true })
      })
    }
  }

  // ── 浮层预热：renderer 侧声明「马上要用它了」──
  //
  // 冷启动代价必须落在**意图信号**上，而不是落在用户的第一下动作上：地址栏一获得焦点
  // 就后台把下拉浮层的 renderer 载起来（不显示、bounds 仍 0×0），于是第一次按键不用
  // 等一次 renderer 冷启动。实现与理由见 LayoutCoordinator#warmFloatView。
  //
  // 只认 FLOAT_NAMES 里的名字（与上面一族通道同一份白名单）——
  // 免得任意视图拿着字符串就能凭空建出渲染进程。
  rawIpcMain?.on(sendCh(routes.floatWarm), (_e, req) => {
    const name = String((req && req.name) || '')
    if (!FLOAT_NAMES.includes(name)) return
    if (typeof layoutCoordinator.warmFloatView === 'function') layoutCoordinator.warmFloatView(name)
  })

  // ── 面板意图预取（renderer → main，单向）──
  //
  // 入口被悬停/按下时发一次 `{ panelId }`：主进程后台把这块面板的视图造好并加载，
  // **不占位、不显示、不改布局**。面板"关闭即销毁"，冷启动原先是全压在用户点击上的；
  // 现在那笔开销提前到"鼠标已经在入口上"这一拍，点击时通常已经就绪 → 原子出现。
  //
  // 不在这里校验 id 合法性 —— 目录是唯一事实源，而它在 LayoutCoordinator 的端口后面
  // （`preparePanel` 会问端口的 has()，认不出来就什么都不做）。IPC 层不再重复一份白名单。
  rawIpcMain?.on(sendCh(routes.panelPrepare), (_e, req) => {
    const panelId = String((req && req.panelId) || '')
    if (!panelId) return
    if (layoutCoordinator && typeof layoutCoordinator.preparePanel === 'function') {
      try { layoutCoordinator.preparePanel(panelId) } catch (e) {
        console.warn('[layout] preparePanel failed:', errorMessage(e))
      }
    }
  })

  // ── 键盘焦点交还外壳（ui-shell = 窗口本体 webContents）──
  // 渲染层要聚焦地址栏之前必须先走这里。
  //
  // 为什么仅靠 DOM `input.focus()` 不行：键盘焦点与 DOM 焦点是两个层面。切标签时
  // TabManager 会把键盘焦点交给标签 webContents（`view.webContents.focus()`），
  // 此时渲染层再 `input.focus()` 只是把 activeElement 改成了 input —— 键盘事件
  // 仍然路由到网页，光标也不会出现，表现就是「地址栏根本没聚焦」。
  // 这里把键盘焦点交还外壳 webContents，DOM 聚焦才会真正落地为可见光标 + 可输入。
  // 用 e.sender（发起方正是该窗口的外壳 webContents）而非 layoutCoordinator：
  // 多窗口下天然把焦点交还给「正确的那个窗口」，不依赖单例布局对象。
  rawIpcMain?.on(sendCh(routes.shellFocus), (e) => {
    // 外壳（地址栏）要拿回键盘焦点 —— 交给 LayoutCoordinator：它会在随后一段时间内
    // **反复重申**这次聚焦。只 focus 一次拿不住：标签与浮层都是独立 WebContentsView，
    // 它们稍后会「原生」把键盘焦点抢走，光标闪一下就被顶掉。
    if (layoutCoordinator && typeof layoutCoordinator.focusShell === 'function') {
      layoutCoordinator.focusShell()
      return
    }
    // 兜底（布局对象不可用时）：至少把键盘焦点交还发起方，DOM 聚焦才能落地为光标。
    const wc = e && e.sender
    if (wc && !wc.isDestroyed()) {
      try { wc.focus() } catch (_) {}
    }
  })

  // ── 键盘焦点还给内容面（外壳 → 主）──
  //
  // 触发方：外壳渲染层的 focus-sentinel —— 用户点了外壳上**不需要键盘**的地方
  // （标签栏空白 / 顶条留白 / 侧边留白…）。点外壳必然让窗口本体拿到原生焦点，
  // 而标签是独立 WebContentsView：网页里的输入框看起来还在，键盘却已经进不去了
  // （用户报的"点一下无关界面，网页输入框就失焦"）。
  //
  // 这里只做两件事：先把"外壳在输入框里"这个判据清掉（用户刚点了非输入区），
  // 再把回焦请求交给 LayoutCoordinator —— 闸口（后台窗口 / 自持焦浮层 / 正在跑的
  // 聚焦链…）全在那边，单一真源，不在 IPC 层重复一遍。
  rawIpcMain?.on(sendCh(routes.contentFocus), (_e, req) => {
    if (!layoutCoordinator) return
    if (typeof layoutCoordinator.setShellEditableFocused === 'function') {
      layoutCoordinator.setShellEditableFocused(false)
    }
    if (typeof layoutCoordinator.restoreContentFocus === 'function') {
      // 内容面已明确要键盘：所有尚未跑完的“聚焦外壳”拍次都是过期意图，
      // 必须作废（preempt）。否则用户点进页内输入框后，旧定时器还会把焦点抢回地址栏。
      layoutCoordinator.restoreContentFocus({
        reason: String((req && req.reason) || 'shell-pointer'),
        immediate: true,
        preempt: true
      })
    }
    // 只换原生键盘焦点还不够：外壳里的地址栏 input 可能仍是 DOM activeElement。
    // 通知外壳主动 blur；否则之后任何一次原生 focus 重放都会把光标吸回地址栏。
    if (typeof layoutCoordinator.getUiShellWebContents === 'function') {
      const shell = asWebContents(layoutCoordinator.getUiShellWebContents())
      if (shell && !shell.isDestroyed()) {
        try {
          shell.send(evtCh(IPC_EVENTS.shellFocusReleased), {
            reason: String((req && req.reason) || 'content-focus')
          })
        } catch (_) {}
      }
    }
  })

  // ── 外壳可编辑态上报（外壳 → 主，`{ editable }`）──
  // 它只回答一件事：**外壳此刻是不是在一个输入框里**（地址栏 / 搜索框）。
  // 窗口回到前台时，主进程据此决定要不要把焦点还给网页 —— 正在地址栏打字时
  // 切出去再切回来必须留在原地，否则就成了"每次切回都被拽回网页"。
  rawIpcMain?.on(sendCh(routes.shellFocusState), (_e, req) => {
    if (!layoutCoordinator || typeof layoutCoordinator.setShellEditableFocused !== 'function') return
    layoutCoordinator.setShellEditableFocused(!!(req && req.editable))
  })

  // ── searchbar 专用：update-selection（单向转发到 renderer）──
  rawIpcMain?.on(sendCh(routes.searchbarOverlayUpdateSelection), (_e, req) => {
    const wc = asWebContents(layoutCoordinator.getFloatWebContents('searchbar-overlay'))
    if (wc && !wc.isDestroyed()) {
      wc.send(evtCh(routes.searchbarOverlayUpdateSelection), req)
    }
  })

  // ── 浮层 → ui-shell 回传（commit/action）—— 单向转发 ──
  const forwardToUiShell = (route: string): void => {
    rawIpcMain?.on(sendCh(route), (_e, req) => {
      const uiShellWC = asWebContents(layoutCoordinator.getUiShellWebContents())
      if (uiShellWC && !uiShellWC.isDestroyed()) {
        uiShellWC.send(evtCh(route), req)
      }
    })
  }
  forwardToUiShell(routes.overlayAction)

  /**
   * commit 的接收方 = **打开这只浮层的那个视图**（见 LayoutCoordinator#_floatOpener）。
   *
   * 为什么不能一律送给外壳：浮层动作可能由**独立浮层视图**打开 ——
   * 回传送给外壳时，外壳不认为那只浮层的宿主还开着（它的开合状态是 false），于是既不
   * 理这次提交也不收起浮层，那只浮层就永远挂在屏幕上了。`kind` → 浮层名是主进程唯一
   * 知道的对应关系（它同时认识两者的通道），故这张表放在这里；拿不到发起方（外壳发的、
   * 视图已销毁）才回退外壳 —— 即历史行为。
   */
  const COMMIT_OWNER = Object.freeze({
    searchbar: 'searchbar-overlay',
    // 站点信息聚合浮层：权限选择 / 清除数据 / 重置 / 打开的深链，全部由它自己收拾。
    'siteinfo-state': 'siteinfo-overlay',
    'siteinfo-dismiss': 'siteinfo-overlay',
    'siteinfo-action': 'siteinfo-overlay',
    // 通用「选择目标」浮层：选中 / 收起都由**打开它的那个视图**收拾 ——
    // 它才是 picks 状态的真源（见 renderer/shared/target-picker.js 的文件头）。
    'target-picker-select': 'target-picker-overlay',
    'target-picker-dismiss': 'target-picker-overlay'
  })
  rawIpcMain?.on(sendCh(routes.overlayCommit), (_e, req) => {
    const reqRecord = asRecord(req)
    const owner = typeof reqRecord.kind === 'string'
      ? (COMMIT_OWNER as Record<string, string>)[reqRecord.kind]
      : null
    const opener = owner && typeof layoutCoordinator.getFloatOpener === 'function'
      ? layoutCoordinator.getFloatOpener(owner)
      : null
    const target = asWebContents(opener) || asWebContents(layoutCoordinator.getUiShellWebContents())
    if (target && !target.isDestroyed()) target.send(evtCh(routes.overlayCommit), req)
  })

  // ── 密码浮层独立图层：专用 interactive / bounds / ready ──
  typedMain.handle(routes.passwordOverlaySetInteractive, {
    requestSchema: schemas.floatInteractive.request,
    responseSchema: schemas.floatInteractive.response,
    handler: async (_e, req) => {
      layoutCoordinator.setPasswordOverlayInteractive(req.interactive)
      return { ok: true }
    }
  })

  typedMain.handle(routes.passwordOverlaySetBounds, {
    requestSchema: schemas.floatBounds.request,
    responseSchema: schemas.floatBounds.response,
    handler: async (_e, req) => {
      if (req && req.position === 'in-content' && typeof layoutCoordinator.anchorPasswordOverlayInContent === 'function') {
        layoutCoordinator.anchorPasswordOverlayInContent(req)
      } else {
        layoutCoordinator.setPasswordOverlayBounds(req || {})
      }
      return { ok: true }
    }
  })

  typedMain.handle(routes.passwordOverlayReady, {
    requestSchema: schemas.floatReady.request,
    responseSchema: schemas.floatReady.response,
    handler: async () => ({ ok: true })
  })

}

/**
 * 需要主进程补「窗口内容区尺寸」的浮层（铺满整窗的模态下拉族）。
 *
 * 为什么统一成一张表：它们的落位规则不同（贴锚点 / 居中 / 右侧放不下左移），
 * 但**需要的同一条事实**完全一样 —— 窗口内容区多大只有主进程知道。
 * 以前按名字各写一段一模一样的 if，新增一个就得再抄一遍；收进这里后只加名字。
 */
const VIEWPORT_FLOATS = new Set([
  'overview-overlay',
  'target-picker-overlay'
])

/**
 * 把浮层 show 请求里的坐标从「发送方视图内坐标」归一化成「窗口内容区坐标」，
 * 并按浮层各自的落位需要补上只有主进程知道的事实。
 *
 * 【为什么需要】外壳（窗口本体）发的坐标本来就是窗口坐标（它没有 bounds，偏移 0），
 * 而任何**独立视图**（侧边面板 / 侧栏浮出层）报的是视图内坐标 —— 视图内坐标直接
 * 拿去当窗口坐标用，锚点就会偏出它自己在窗口里的那一段偏移。所有独立视图都同一条
 * 规则，所以这里按「能不能查到偏移」统一处理，而不是逐个浮层写一条 if。
 *
 * 【按浮层补的额外事实】
 *   · tabpreview-overlay —— `besidePanel`（贴面板外侧与否）；
 *   · VIEWPORT_FLOATS（overview / target-picker）—— `viewport`
 *     （窗口内容区尺寸）：它们铺满整窗、要按**窗口**尺寸夹自己的最大宽高，
 *     而发送方的 innerWidth 可能只是自己那条视图的宽。
 *
 * @param {*} layoutCoordinator
 * @param {Electron.WebContents} senderWC
 * @param {*} req
 * @param {string} name 浮层逻辑名
 * @returns {*} 归一化后的 payload（无需处理时原样返回）
 */
function normalizeFloatShow(
  layoutCoordinator: MethodPort,
  senderWC: WebContents | null | undefined,
  req: unknown,
  name: string
): Record<string, unknown> | null {
  if (!req || typeof req !== 'object') return null
  const request = req as Record<string, unknown>
  if (!senderWC || senderWC.isDestroyed()) return request
  const offset = asRecord(typeof layoutCoordinator.getViewContentOffset === 'function'
    ? layoutCoordinator.getViewContentOffset(senderWC)
    : null)
  let out = request
  const offsetX = Number(offset.x) || 0
  const offsetY = Number(offset.y) || 0
  if (offsetX || offsetY) {
    out = { ...out }
    /** 只搬"本来就是数"的字段：缺字段被搬成 0 会污染下游判空（例如 anchor.left）。 */
    const shift = (value: unknown, delta: number): unknown => (Number.isFinite(Number(value)) ? Number(value) + delta : value)
    if (Number.isFinite(Number(out.x))) out.x = shift(out.x, offsetX)
    if (Number.isFinite(Number(out.y))) out.y = shift(out.y, offsetY)
    // ⚠ 预览这类浮层的位置**不在顶层 x/y**，而在嵌套的 `anchor` 矩形里
    //   （见 ui-common#tabPreviewFacts）。面板 / 侧栏浮出层都是独立 WebContentsView，
    //   不补偏移就等于把"行在视图里的 top"当成"窗口里的 top" ——
    //   而 beside-panel 的 y 正是锚在 anchor.top 上，表现是预览整体**偏高一个头部高度**。
    if (out.anchor && typeof out.anchor === 'object') {
      const anchor = asRecord(out.anchor)
      out.anchor = { ...anchor, left: shift(anchor.left, offsetX), top: shift(anchor.top, offsetY) }
    }
    // `stripRight` / `stripBottom` 与 anchor 同属"视图内坐标"（列表滚动容器的外缘，
    // 见 tabPreviewFacts）—— 只搬 anchor 不搬它们，两者会一半窗口坐标、一半视图坐标，
    // 预览恰好偏一个视图偏移（x 偏 offset.x，below 的顶边偏 offset.y）。
    if (Number.isFinite(Number(out.stripRight))) out.stripRight = shift(out.stripRight, offsetX)
    if (Number.isFinite(Number(out.stripBottom))) out.stripBottom = shift(out.stripBottom, offsetY)
  }

  if (name === 'tabpreview-overlay') {
    const besidePanel = typeof layoutCoordinator.isPanelWebContents === 'function'
      ? layoutCoordinator.isPanelWebContents(senderWC)
      : false
    out = { ...out, besidePanel }
    // 窗口内容区尺寸：**任何**发送方都要补。外壳（导航栏后退/前进的 Alt 预览）要按窗口高
    // 决定卡片往上还是往下翻 —— 而外壳的 innerHeight 只是窗口本体内容区，虽然相等，
    // 但统一由主进程给，下游 (preview-placement) 只认这一条事实，不必判断是谁发的。
    const winSize = asRecord(typeof layoutCoordinator.getWindowContentSize === 'function'
      ? layoutCoordinator.getWindowContentSize()
      : null)
    if (winSize.width || winSize.height) {
      if (!Number.isFinite(Number(out.windowWidth))) out = { ...out, windowWidth: winSize.width }
      if (!Number.isFinite(Number(out.windowHeight))) out = { ...out, windowHeight: winSize.height }
    }
  }

  // ── 「铺满整窗」的浮层需要窗口内容区尺寸（viewport）──
  // 它们的 renderer 自己量不到窗口完整内容区（视图是 0×0，或发起方只是其中一条视图），
  // 而"菜单/卡片能长多大、往哪边夹"只有主进程知道。名字收成一张表，
  // 新增同类浮层只加一行，不再按名字各写一段一模一样的 if。
  if (VIEWPORT_FLOATS.has(name)) {
    const viewport = typeof layoutCoordinator.getWindowContentSize === 'function'
      ? layoutCoordinator.getWindowContentSize()
      : null
    if (viewport) out = { ...out, viewport }
  }

  return out
}

/** 把 'searchbar-overlay' → 'searchbarOverlay' 用于 routes 键名 */
function camelize(name: string): string {
  return name.replace(/-([a-z])/g, (_match: string, char: string) => char.toUpperCase())
}
