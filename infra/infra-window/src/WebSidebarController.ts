/**
 * 独立网页面板的布局控制器。
 *
 * 只管网页侧栏的视图、尺寸、换边与顶条投影；安装时绑定到 LayoutCoordinator，
 * 保留既有调用面并隔离这一组连续状态迁移。
 */

const {
  resolveWebSidebarSide,
  DEFAULT_WEB_SIDEBAR_POSITION
} = require("@hira-ng/shared-types/src/web-sidebar")
const { IPC_EVENTS } = require("@hira-ng/shared-types/src/ipc-channels")
const { SPLIT_METRICS } = require("@hira-ng/shared-types/src/split-layout")

import type { BrowserWindow, WebContents } from 'electron'

interface SidebarRect { x: number; y: number; width: number; height: number }
interface SidebarInsets { left: number; top: number; right: number; bottom: number }
interface SidebarView {
  webContents: WebContents
  setVisible(visible: boolean): void
  setBounds(bounds: SidebarRect): void
  setBorderRadius?(radius: number): void
}
interface SidebarParts { content: SidebarView; header: SidebarView | null; headerHeight: number }
interface SidebarViewPort { ensureView(): { content?: SidebarView; header?: SidebarView | null; headerHeight?: unknown } }
interface SidebarState { visible: boolean; width: number; position: string }
interface SidebarFrameGeometry {
  active: boolean
  rect?: SidebarRect
  line?: number
  radius?: number
  side?: string
  focused?: boolean
  width?: number
  handle?: SidebarRect | null
}
interface SidebarHost {
  _webSidebar: SidebarState
  _sidebarPosition: string
  _webSidebarActive: boolean
  _webSidebarParts: SidebarParts | null
  _webSidebarViewPort: SidebarViewPort | null
  _webSidebarDropPreview: string | null
  _webSidebarDropPreviewPort: ((rect: SidebarRect | null) => void) | null
  _webSidebarSideListener: (() => void) | null
  _webSidebarSlotBySide: Record<string, SidebarRect>
  _webSidebarInsets: SidebarInsets
  _webSidebarHandleRect: SidebarRect | null
  _lastWebSidebarRect: SidebarRect | null
  _lastWebSidebarFrameKey: string
  _win: BrowserWindow
  _wcm: { destroyWebSidebarViews?(): void }
  isWebSidebarVisible(): boolean
  isWebSidebarFocused(): boolean
  getWebSidebarSide(): string
  getWebSidebarFrameGeometry(): SidebarFrameGeometry
  getUiShellWebContents(): WebContents | null
  _dropLayerByView(view: SidebarView | null): void
  _pushLayer(name: string, view: SidebarView, zKey: string): void
  _getLayer(name: string): { setVisible(visible: boolean): void } | null
  _ensureWebSidebarParts(): SidebarParts | null
  _setBoundsIfChanged(view: SidebarView, rect: SidebarRect): void
  _setRadiusIfChanged(view: SidebarView, radius: number): void
  _pageRadius(): number
  _pushWebSidebarFrame(): void
  _rememberContentFocus(webContents: WebContents, kind: string, key: string): void
  forgetContentFocus(webContents: WebContents): void
  _setWebSidebarActive(active: boolean): void
  _setWebSidebarDropPreview(side: string | null): boolean
  _mirrorWebSidebarSlot(side: string): SidebarRect | null
  _focusedWebBounds(): SidebarRect | null
  _activePaneBounds(): SidebarRect | null
  _notifyWebSidebarSide(): void
  applyInitialLayout(): void
  setWebSidebarPosition(side: string): boolean
}

class WebSidebarController {
  readonly host: SidebarHost

  constructor(host: SidebarHost) {
    this.host = host
  }

  reclaimWebSidebarViews() {
    if (typeof this.host.isWebSidebarVisible === 'function' && this.host.isWebSidebarVisible()) return false
    const parts = this.host._webSidebarParts
    if (!parts || !parts.content) return false
    const wc = parts.content.webContents
    if (!wc || (typeof wc.isDestroyed === 'function' && wc.isDestroyed())) return false
    try {
      if (typeof wc.isCurrentlyAudible === 'function' && wc.isCurrentlyAudible()) return false
    } catch (_) {}
    // 先摘两条图层（内容 + 顶条），再销毁 —— 留着图层就是两条指向已销毁页面的空壳。
    this.host._dropLayerByView(parts.content)
    this.host._dropLayerByView(parts.header)
    this.host._webSidebarParts = null
    this.host._webSidebarActive = false
    try {
      if (this.host._wcm && typeof this.host._wcm.destroyWebSidebarViews === 'function') {
        this.host._wcm.destroyWebSidebarViews()
      }
    } catch (error: unknown) {
      console.error('[layout] destroyWebSidebarViews failed:', error instanceof Error ? error.message : error)
    }
    return true
  }

  // ═══════════════════════════════════════════════════════════════════
  //  独立侧栏（Web Sidebar）—— 与面板槽完全平行的第二套"视图区域"
  //
  //  它与面板**唯一的关系**是：在轨道上排在面板内侧（紧邻网页），于是网页宽度是
  //  两者之和。除此之外它们互不知道对方存在。
  // ═══════════════════════════════════════════════════════════════════

  /** 注入侧栏视图端口（装配期调一次；同 setPanelViewPort 的理由与口径）。 */
  setWebSidebarViewPort(port: SidebarViewPort | null): void {
    this.host._webSidebarViewPort = port && typeof port.ensureView === 'function' ? port : null
    this.host._webSidebarParts = null
  }

  /**
   * 侧栏**实际**在哪一侧 —— 由「位置偏好」解析而来（见 shared-types#resolveWebSidebarSide）：
   * 显式 left/right 就是它；`'auto'` 则是**工具区所在的那一侧**（跟随 —— 从哪边点开就从哪边出来）。
   */
  getWebSidebarSide() {
    return resolveWebSidebarSide(this.host._webSidebar.position, this.host._sidebarPosition)
  }

  /** 侧栏此刻是否占位（面板/浮层锚定判定会问它）。 */
  isWebSidebarVisible() {
    return !!this.host._webSidebar.visible
  }

  /** 侧栏当前占宽（未显示 = 0）。 */
  getWebSidebarWidth() {
    return this.host._webSidebar.visible ? Math.max(0, Math.round(this.host._webSidebar.width)) : 0
  }

  /**
   * 侧栏内容页是否是**活动面**（窗口级能力的靶子判定，见不变式 S7 / S10）。
   *
   * 唯一真源是 `_webSidebarActive` 这个**显式状态**，**不再问 `isFocused()`** ——
   * 查找栏这类自持焦浮层一打开就把侧栏 blur 掉，问焦点就会把靶子错判成隔壁标签。
   */
  isWebSidebarFocused() {
    return !!(this.host._webSidebar.visible && this.host._webSidebarActive)
  }

  /**
   * 侧栏**聚焦框**的几何快照（外壳据此画框；挂载时先拉一次，之后由推送更新）。
   *
   * 返回的 `rect` 已经是**框自己的矩形**（槽再四边内缩 `line`，不贴窗口/面板边缘 ——
   * 贴着边缘的框线看起来像被切掉了一半），`radius` 是与网页**同心**的外弧。
   * 渲染侧只负责摆和上色，所有算术都在这里（主进程是几何与圆角的唯一真源）。
   *
   * @returns {{active: boolean, rect?: object, line?: number, radius?: number, side?: string, focused?: boolean, width?: number, handle?: object}}
   */
  getWebSidebarFrameGeometry() : SidebarFrameGeometry {
    const rect = this.host._lastWebSidebarRect
    if (!this.host._webSidebar.visible || !rect) return { active: false }
    const pad = this.host._webSidebarInsets
    const line = SPLIT_METRICS.paneGap
    // 框四边再内缩一条线宽：不贴槽沿（槽沿紧邻窗口边 / 面板边，压在上面像被裁了一半）
    const frameRect = {
      x: rect.x + line,
      y: rect.y + line,
      width: Math.max(0, rect.width - line * 2),
      height: Math.max(0, rect.height - line * 2)
    }
    // 圆角 = 网页圆角 + 那圈呼吸空 - 内缩量（同心：框才像是给这块内容加的一圈）
    const frameInset = Math.max(pad.left, pad.top, pad.right, pad.bottom) - line
    return {
      active: true,
      rect: frameRect,
      /**
       * 框线宽 —— **与分屏活动格同一条真源**（`SPLIT_METRICS.paneGap`）。
       *
       * 两者的框表达的是同一件事（"这一块是活动面"），粗细自然该是同一个数：
       * 各写一个迟早不一致，而用户对"两个框看着不一样粗"极其敏感。
       * 注意它**不等于**网页让出的边距 —— 框是"贴着槽沿内侧的一条线"，不是那条边距本身。
       */
      line,
      // 与网页同一个派生圆角：框必须与内容同心 —— 全屏贴边时两者一起归零。
      radius: this.host._pageRadius() + Math.max(0, frameInset),
      side: this.host.getWebSidebarSide(),
      focused: this.host.isWebSidebarFocused(),
      /**
       * 侧栏**当前宽度设置值** —— 调宽把手的拖拽基准。
       *
       * 必须由主进程给：渲染侧拿到的只有矩形（槽宽 = 宽度值，但把手的 x 与槽沿差一个
       * 呼吸空），自己去反推会多出一份算术。而且宽度是**有区间校验的真源**（200~600），
       * 渲染侧不该有第二份判据。
       */
      width: this.host._webSidebar.width,
      /**
       * 调宽把手的矩形 —— **读的是布局末尾算好的那一份**（`_webSidebarHandleRect`），
       * 不在这里现算：见它的注释（两个矩形必须同一趟，现算必然一新一旧）。
       */
      handle: this.host._webSidebarHandleRect
    }
  }

  /**
   * 侧栏**调宽把手**的矩形 —— 落在"侧栏内容块 ↔ 网页"之间那道**缝**里。
   *
   * ── 为什么非要有它 ──────────────────────────────────────────────────
   * 原先只有顶条那 32px 高里的一小条 6px 把手：用户既找不到，也不好抓
   *（"侧栏的网页不能调宽"这个观感就是这么来的）。而侧栏的网页是**别人的网页**
   *（原生视图），我们没法在它身上挂 DOM —— 于是只能在它旁边那道缝里做文章。
   *
   * ── 为什么缝里画得上、也点得着 ──────────────────────────────────────
   * 与**分屏分隔条**是同一条道理（见 renderer/shared/split-surface.js 文件头）：
   * 网页只占自己那一块矩形，缝里**没有任何网页 view** —— 那里露出的是 chrome，
   * 于是 chrome 的 DOM 既可见、也天然收得到指针事件。
   *
   * ── 算术为什么用两个**真实矩形**相减 ────────────────────────────────
   * 缝的两条边 = 侧栏内容块的内侧沿（槽收进呼吸空，来自 `_placeWebSidebar`）
   *           → 网页的外侧沿（`pageBounds`，来自布局结果）。
   * 两者都是已经算好的结果，这里只做减法 —— 若改成在本地重推一遍轨道算术
   *（内容侧 = 轨道各段宽度相加、网页 = 内容区收进呼吸空…），迟早与那边漂移，
   * 而漂移的表现是"把手压在网页上，看不见也点不着"。
   *
   * ⚠ 调用时机是一次性的：**只能在布局末尾**（两个矩形都写完之后）调一次，
   *   结果存进 `_webSidebarHandleRect`。在别处现算会拿到"槽是本趟、网页是上趟"的组合，
   *   于是把手跑到侧栏中间被自己的网页盖住（这就是它第一版的 bug）。
   *
   * @param {{x:number,y:number,width:number,height:number}|null} pageBounds 网页（内容区）矩形
   * @returns {{x:number,y:number,width:number,height:number}|null} 侧栏不可见时返回 null
   */
  _webSidebarResizeHandleRect(pageBounds: SidebarRect | null): SidebarRect | null {
    const rect = this.host._lastWebSidebarRect
    if (!rect || !pageBounds) return null
    const pad = this.host._webSidebarInsets
    const side = this.host.getWebSidebarSide()
    // 内容块的内侧沿：左位侧栏的内侧是它的右边，右位则是左边
    const contentEdge = side === 'right' ? rect.x + pad.left : rect.x + rect.width - pad.right
    const pageEdge = side === 'right' ? pageBounds.x + pageBounds.width : pageBounds.x
    const from = Math.min(contentEdge, pageEdge)
    const to = Math.max(contentEdge, pageEdge)
    // 正好铺满这道缝：压到视图底下的部分**点不着**（原生 view 盖在 chrome DOM 之上），
    // 而缝里的每一像素都能碰到。这条线平时不上色、悬停才亮，命中区越大越好抓 ——
    // 只取 6px 会在缝两侧各留 1px「死边」，指针恰好落在那里就什么也不会发生。
    // 缝窄于 2px（把呼吸空调成 0 的极端配置）时只能取 2，宁可窄，不可伸到 view 底下。
    const width = Math.max(2, Math.round(to - from))
    const center = (from + to) / 2
    return {
      x: Math.round(center - width / 2),
      // 竖跨整个槽高（含顶条那一段）——"整条边都能拖"才是用户对"调宽"的预期。
      // 顶条视图只占内容块的 x 范围，不会盖住缝里的这一条。
      y: Math.round(rect.y),
      width: Math.round(width),
      height: Math.round(rect.height)
    }
  }

  /**
   * 拖动顶条换边（`pointerViewX` = 指针在**顶条视图内**的 x）。
   *
   * 判据是"指针越过窗口内容区中线" —— 与"把窗口拖到屏幕另一半"同一个直觉：
   * 越过中线就落对面，中途反悔拖回来即撤掉预览。用中线而不是"拖出侧栏矩形"，
   * 是因为后者在侧栏较窄时几乎一动手就触发（用户还没表达完意图就换了边）。
   *
   * 拖动途中**只改预览**，松手才真的换边：换边会让顶条视图当场挪到另一侧、
   * 指针坐标失去参照，判据会来回翻转（表现为侧栏在两跳之间抖）。
   * 预览由**原生浮层**画（chrome DOM 会被网页盖住），矩形取 `_webSidebarSlotBySide` ——
   * 与松手后的落点**同源**，不是两边各算一遍。
   *
   * @param {number} pointerViewX
   * @returns {boolean} 预览是否变了
   */
  setWebSidebarMovePreview(pointerViewX: number): boolean {
    const rect = this.host._lastWebSidebarRect
    if (!this.host._webSidebar.visible || !rect) return false
    const x = Number(pointerViewX)
    if (!Number.isFinite(x)) return false
    if (!this.host._win || this.host._win.isDestroyed()) return false
    let contentWidth = 0
    try { [contentWidth] = this.host._win.getContentSize() } catch (_) { contentWidth = 0 }
    if (!(contentWidth > 0)) return false
    // 顶条视图内坐标 → 窗口内容区坐标。
    // ⚠ 顶条原点是**内容块**左上角（= 槽 + 呼吸空），少加这一次换算会让中线判据整体偏移。
    const windowX = rect.x + this.host._webSidebarInsets.left + x
    const next = windowX < contentWidth / 2 ? 'left' : 'right'
    // 目标侧就是它现在待的那一侧 → 没什么可预览的
    return this.host._setWebSidebarDropPreview(this.host.getWebSidebarSide() === next ? null : next)
  }

  /**
   * 设定落位预览侧（`null` = 撤掉），并把矩形交给装配层去显示/收起那个原生浮层。
   *
   * 本类只算"哪一侧 + 矩形是多少" —— 浮层是谁、怎么显示，全是装配层的事。
   */
  _setWebSidebarDropPreview(side: string | null): boolean {
    const next = side === 'left' || side === 'right' ? side : null
    if (next === this.host._webSidebarDropPreview) return false
    this.host._webSidebarDropPreview = next
    const slots = this.host._webSidebarSlotBySide
    const rect = next ? (slots && slots[next]) || this.host._mirrorWebSidebarSlot(next) : null
    if (next && !rect) {
      // 拿不到矩形 = 没有可显示的东西；此时**不要**把预览标成已生效（否则后续同侧上报会被
      // 这句幂等挡掉，重新算出来也轮不到显示）。置回 null 让下一帧有机会。
      this.host._webSidebarDropPreview = null
      return false
    }
    if (this.host._webSidebarDropPreviewPort) {
      try { this.host._webSidebarDropPreviewPort(rect ? { ...rect } : null) } catch (error: unknown) {
        console.warn('[layout] webSidebarDropPreviewPort failed:', error instanceof Error ? error.message : error)
      }
    }
    return true
  }

  /**
   * 把**当前**槽矩形镜像到指定侧 —— 落位预览的兜底。
   *
   * 为什么需要兜底：`_webSidebarSlotBySide` 由 `applyInitialLayout` 刷新，若它这一拍还没算到
   *（或侧栏刚打开还没重排），预览就会静默消失。镜像出来的矩形不如同源那份精确
   *（它不知道对面有没有 rail / 面板占位），但"看得见"远好过"什么都没有"。
   * @param {'left'|'right'} side
   */
  _mirrorWebSidebarSlot(side: 'left' | 'right'): SidebarRect | null {
    const cur = this.host._lastWebSidebarRect
    if (!cur || !this.host._win || this.host._win.isDestroyed()) return null
    let winWidth = 0
    try { [winWidth] = this.host._win.getContentSize() } catch (_) { winWidth = 0 }
    if (!(winWidth > 0)) return null
    return { ...cur, x: side === 'left' ? 0 : Math.max(0, winWidth - cur.width) }
  }

  /**
   * 装配层注入「落位预览」端口：给矩形就显示，给 `null` 就收起。
   * 与视图端口同构 —— 布局层不认识 `dropzone-overlay` 是谁。
   */
  setWebSidebarDropPreviewPort(fn: ((rect: SidebarRect | null) => void) | null): void {
    this.host._webSidebarDropPreviewPort = typeof fn === 'function' ? fn : null
  }

  /**
   * **松手落定**：把侧栏摆到预览指的那一侧。返回"这趟到底换过边没有"。
   *
   * 写的是**显式位置偏好**（left/right）而不是保留 `'auto'` —— 用户亲手把它拖到这边
   * 就该钉住；否则工具区一换边它又自己跑回对面，看起来像"拖了没用"。
   *
   * @returns {boolean} 是否真的换了边
   */
  commitWebSidebarMove() : boolean {
    const side = this.host._webSidebarDropPreview
    this.host._setWebSidebarDropPreview(null)
    if (side !== 'left' && side !== 'right') return false
    return this.host.setWebSidebarPosition(side)
  }

  /** **拖动中断**（Esc / 指针丢失）：撤掉落位预览，位置不动。 */
  cancelWebSidebarMove() {
    return this.host._setWebSidebarDropPreview(null)
  }

  /**
   * 把侧栏聚焦框几何推给**本窗口外壳**。
   *
   * 与 `_pushSplitGeometry` 同一条思路（主进程独有的事实、只有外壳一个读者），
   * 但走**独立通道** `web-sidebar:changed` —— 侧栏与分屏是两套系统，只是"画框"这件事
   * 长得一样。复用 split 通道会让"侧栏有个框"变成"分屏有个框"，两边状态互相踩。
   */
  _pushWebSidebarFrame() {
    const wc = this.host.getUiShellWebContents()
    if (!wc || wc.isDestroyed()) return
    const payload = this.host.getWebSidebarFrameGeometry()
    // **同一份几何只发一次**（与 `_pushSplitGeometry` 完全同一条规矩）。
    // 这条推送被挂在 `applyInitialLayout` 末尾：窗口 resize 的每一帧、面板开关、
    // 切侧栏都会经过它，而框的几何在绝大多数趟里一个字都没变 —— 不判就是每趟白送
    // 一条跨进程消息（外壳还得收下、走一遍处理器、再重绘一次框）。
    const r = payload.rect
    const h = payload.handle
    const key = payload.active && r
      ? `${wc.id}|${payload.side}|${payload.focused}|${payload.width}|${payload.line},${payload.radius}` +
        `|${r.x},${r.y},${r.width},${r.height}` +
        `|${h ? `${h.x},${h.y},${h.width},${h.height}` : '-'}`
      : `${wc.id}|inactive`
    if (key === this.host._lastWebSidebarFrameKey) return
    this.host._lastWebSidebarFrameKey = key
    try { wc.send(`ngipc:event:${IPC_EVENTS.webSidebarChanged}`, payload) } catch (_) {}
  }

  /**
   * 「用户正在操作的那块**网页面**」矩形 —— **侧栏里的网页聚焦时是侧栏，否则是活动格**。
   *
   * 为什么需要把两者统一成一个概念：查找栏 / 缩放条 / 悬停 URL 这三条浮层都是"网页的
   * 附着物"（贴网页右上 / 顶部居中 / 左下）。它们原先一律贴**活动标签**那块矩形 ——
   * 侧栏接管焦点后，那三条就会跑到隔壁的标签页上去（用户感受：在侧栏里按 Ctrl+F，
   * 查找栏出现在旁边那块网页上）。
   *
   * 判据是**活动面**（`_webSidebarActive`，唯一真源）—— 不是"侧栏开着没有"，
   * 也不是此刻谁持焦：侧栏开着但用户正在标签里打字时，这三条仍该贴着标签页；
   * 而查找栏这类**自持焦浮层**打开时会把侧栏 blur 掉，用 `isFocused()` 判就会把
   * 「在侧栏按 Ctrl+F」算回隔壁标签（这正是 S10 要钉死的那个 bug）。
   *
   * @returns {{x:number,y:number,width:number,height:number}|null}
   */
  getFocusedWebBounds() : {x:number,y:number,width:number,height:number}|null {
    const b = this.host._focusedWebBounds()
    return b ? { x: b.x, y: b.y, width: b.width, height: b.height } : null
  }

  /** 上面那个概念的内部实现（返回内部对象，调用方不许改）。 */
  _focusedWebBounds() {
    const parts = this.host._webSidebarParts
    const rect = this.host._lastWebSidebarRect
    if (parts && rect && this.host._webSidebar.visible && this.host._webSidebarActive) {
      // 网页**可见**矩形 = 槽收进呼吸空、再去掉顶条那一条。
      // ⚠ 这是"露出来的那一块"，不是网页视图的 bounds —— 视图往上多留了 `_tabBorderRadius`
      //   那一截藏在顶条底下（为了接缝不带圆角，见 `_placeWebSidebar`）。三条附着物
      //（查找栏 / 缩放条 / 悬停 URL）要贴的正是"露出来的那一块"，所以这里不跟着视图变。
      const pad = this.host._webSidebarInsets
      const innerH = Math.max(0, rect.height - pad.top - pad.bottom)
      const top = Math.min(parts.headerHeight, innerH)
      return {
        x: rect.x + pad.left,
        y: rect.y + pad.top + top,
        width: Math.max(0, rect.width - pad.left - pad.right),
        height: Math.max(0, innerH - top)
      }
    }
    return this.host._activePaneBounds()
  }

  /**
   * 显示 / 收起侧栏。
   * @param {boolean} visible
   * @param {'left'|'right'} [side] 显式指定位置偏好（省略 = 保持当前偏好，多为 `'auto'`）
   * @returns {{ visible: boolean, side: 'left'|'right' }}
   */
  setWebSidebarVisible(visible: boolean, side?: string | null): { visible: boolean; side: string } {
    const next = !!visible
    const pos = side === 'left' || side === 'right' ? side : undefined
    const changed = this.host._webSidebar.visible !== next
      || (pos !== undefined && pos !== this.host._webSidebar.position)
    this.host._webSidebar.visible = next
    if (pos !== undefined) this.host._webSidebar.position = pos
    // 收起 = 拖动途中那个落位预览一并作废（半透明块不该留在已隐藏的侧栏上）
    if (!next) this.host._setWebSidebarDropPreview(null)
    if (changed) this.host.applyInitialLayout()
    return { visible: next, side: this.host.getWebSidebarSide() }
  }

  /**
   * 设定**位置偏好**：`'auto'`（= 与工具区**同侧**，跟随）/ `'left'` / `'right'`。
   *
   * 三个来源都汇到这里，因此"谁说了算"只有一条规则（后写覆盖前写）：
   *   · 设置生效器（`app.web_sidebar_position`）—— 启动与改设置；
   *   · **拖顶条换边**（用户直接拖到另一侧 → 变成显式 left/right）；
   *   · `open({ side })`（调用方临时指定）。
   *
   * @param {'auto'|'left'|'right'|null} position
   * @returns {boolean} 是否真的变了
   */
  setWebSidebarPosition(position: string | null): boolean {
    const next = position === 'left' || position === 'right' ? position : 'auto'
    if (next === this.host._webSidebar.position) return false
    const before = this.host.getWebSidebarSide()
    this.host._webSidebar.position = next
    // ⚠ 只有**实际侧别**变了才重排：`'auto'` 与显式值在"工具区靠左"这类情况下会解析成同一侧，
    // 那时换偏好没有任何布局代价，不该白跑一次 applyInitialLayout。
    if (this.host.getWebSidebarSide() !== before && this.host._webSidebar.visible) this.host.applyInitialLayout()
    this.host._notifyWebSidebarSide()
    return true
  }

  /**
   * 侧别（或影响侧别的偏好）变了 → 让装配层把新事实投影出去。
   *
   * 两件事一起做，因为它们是同一个事实的两个消费者：
   *   · 聚焦框几何（外壳画的框要换边）；
   *   · 顶条状态（`is-left/is-right` 类、宽度把手贴哪条内缘）。
   */
  _notifyWebSidebarSide() {
    this.host._pushWebSidebarFrame()
    if (this.host._webSidebarSideListener) {
      try { this.host._webSidebarSideListener() } catch (error: unknown) {
        console.warn('[layout] webSidebarSideListener failed:', error instanceof Error ? error.message : error)
      }
    }
  }

  /**
   * 注入侧栏**侧别变化**的观察者（装配期一次）。
   * @param {(() => void)|null} fn
   */
  setWebSidebarSideListener(fn: (() => void) | null): void {
    this.host._webSidebarSideListener = typeof fn === 'function' ? fn : null
  }

  /**
   * 侧栏宽度（区间校验与面板同一口径：200~600 —— 比面板窄的下限更小，
   * 因为它是"网页侧栏"，太宽会喧宾夺主，太窄则移动版站点没法看）。
   * @param {number} width
   * @returns {boolean} 是否真的变了
   */
  setWebSidebarWidth(width: number): boolean {
    const n = Math.floor(Number(width))
    if (!Number.isFinite(n)) return false
    const next = Math.min(600, Math.max(200, n))
    if (next === this.host._webSidebar.width) return false
    this.host._webSidebar.width = next
    if (this.host._webSidebar.visible) this.host.applyInitialLayout()
    return true
  }

  /** 向端口要侧栏的**视图包**（首次要时挂图层；之后复用）。拿不到 → null（不占位）。 */
  _ensureWebSidebarParts() {
    if (this.host._webSidebarParts) return this.host._webSidebarParts
    const port = this.host._webSidebarViewPort
    if (!port || typeof port.ensureView !== 'function') return null
    let parts = null
    try { parts = port.ensureView() } catch (error: unknown) {
      console.warn('[layout] ensureWebSidebarView failed:', error instanceof Error ? error.message : error)
      parts = null
    }
    if (!parts || !parts.content) return null
    this.host._webSidebarParts = {
      content: parts.content,
      header: parts.header || null,
      headerHeight: Math.max(0, Number(parts.headerHeight) || 0)
    }
    /**
     * **活动面**监听：只挂 `focus`（用户点了侧栏网页 → 活动面归它），**刻意不挂 `blur`**。
     *
     * 为什么不挂 blur：查找栏 / 缩放条这类浮层是**自持焦**的（打开时把其他所有面 blur 掉），
     * 挂 blur 就等于"一开查找栏，靶子立刻翻回标签" —— 那正是"在侧栏按 Ctrl+F 却搜到
     * 隔壁标签"的确切成因。收回活动面只由**显式动作**触发（点标签网页 / showTab / 收起）。
     */
    const sbWc = this.host._webSidebarParts.content && this.host._webSidebarParts.content.webContents
    if (sbWc && typeof sbWc.on === 'function') {
      this.host._webSidebarActive = false
      try {
        sbWc.on('focus', () => {
          this.host._setWebSidebarActive(true)
          this.host._rememberContentFocus(sbWc, 'sidebar', 'sidebar')
        })
      } catch (_) {}
      try { sbWc.once('destroyed', () => { this.host.forgetContentFocus(sbWc) }) } catch (_) {}
      try {
        sbWc.once('destroyed', () => {
          this.host._webSidebarActive = false
          // ⚠ 视图被销毁（profile 切换 / 卸载）后，**缓存与两个图层必须一起清** ——
          // 只清 active 不够：`_ensureWebSidebarParts` 开头是
          // `if (this.host._webSidebarParts) return`，缓存里留着已销毁的 webContents 时，
          // 它会命中并且**永远命中** —— 侧栏从此白屏，且再也建不起来。
          // 图层同理：留着就是两条指向已销毁页面的空壳（白斑）。
          const parts = this.host._webSidebarParts
          if (parts) {
            this.host._dropLayerByView(parts.content)
            this.host._dropLayerByView(parts.header)
          }
          this.host._webSidebarParts = null
        })
      } catch (_) {}
    }
    // 图层只挂一次（addChildView once），之后显隐只切 setVisible —— 与标签/面板同一口径。
    this.host._pushLayer('web-sidebar', this.host._webSidebarParts.content, 'web-sidebar')
    if (this.host._webSidebarParts.header) {
      this.host._pushLayer('web-sidebar:header', this.host._webSidebarParts.header, 'web-sidebar')
    }
    return this.host._webSidebarParts
  }

  /**
   * 摆侧栏（顶条在上、网页在下，两者都收在"呼吸空"之内）。`rect` 为空 = 收起。
   *
   * `rect` 是**槽矩形**（轨道上分给侧栏的那一段），`insets` 是内容四周的呼吸空
   *（与主视图网页**同一份**）。三个矩形各司其职，别混：
   *   · **槽矩形** —— 记进 `_lastWebSidebarRect`；轨道分段 + 聚焦框的外框；
   *   · **内容块** —— 槽收进 insets；顶条与网页都住这里，两者都带原生圆角；
   *   · **网页**   —— 内容块去掉顶条那一条。
   *
   * ⚠ 框**不能**画在"内容块向外扩一圈"上：那会越过槽边界，被隔壁的原生视图
   *（panel / 底栏盖在 chrome DOM 之上）吃掉靠内那一侧与底部的线 —— 表现为框线被裁。
   * 代价是框与网页之间隔着那圈呼吸空（框包住整段侧栏，而不是贴着网页），这是原生视图
   * 叠放次序决定的下限，绕不过去。
   *
   * 顶条高度由端口给（`headerHeight`），布局层不认识"这是网页侧栏"——
   * 它只知道"这一块要留一条 chrome"。
   */
  _placeWebSidebar(rect: SidebarRect, insets: SidebarInsets): void {
    const parts = this.host._ensureWebSidebarParts()
    if (!parts) return
    const pad = {
      left: Math.max(0, Number(insets && insets.left) || 0),
      top: Math.max(0, Number(insets && insets.top) || 0),
      right: Math.max(0, Number(insets && insets.right) || 0),
      bottom: Math.max(0, Number(insets && insets.bottom) || 0)
    }
    // 留一点最小可用面积：呼吸空把槽吃光时（极窄的侧栏）宁可不显示，也别摆出一个负宽度
    const show = !!(rect
      && rect.width >= pad.left + pad.right + 40
      && rect.height >= pad.top + pad.bottom + 40)
    const contentLayer = this.host._getLayer('web-sidebar')
    if (contentLayer) contentLayer.setVisible(show)
    else { try { parts.content.setVisible(show) } catch (_) {} }
    if (parts.header) {
      const headerLayer = this.host._getLayer('web-sidebar:header')
      if (headerLayer) headerLayer.setVisible(show)
      else { try { parts.header.setVisible(show) } catch (_) {} }
    }
    // 收起 = 活动面自然作废（下次打开时由内容页的 focus 事件重新建立）
    if (!show) {
      this.host._lastWebSidebarRect = null
      this.host._webSidebarActive = false
      this.host._setWebSidebarDropPreview(null)
      this.host._pushWebSidebarFrame()
      return
    }
    // 记**槽矩形**（聚焦框的外框）与呼吸空（内容内缩、框圆角、顶条原点换算都要它）
    this.host._lastWebSidebarRect = { ...rect }
    this.host._webSidebarInsets = pad
    const inner = {
      x: rect.x + pad.left,
      y: rect.y + pad.top,
      width: Math.max(0, rect.width - pad.left - pad.right),
      height: Math.max(0, rect.height - pad.top - pad.bottom)
    }
    const headerHeight = Math.min(parts.headerHeight, inner.height)
    if (parts.header) {
      this.host._setBoundsIfChanged(parts.header, {
        x: inner.x,
        y: inner.y,
        width: inner.width,
        height: headerHeight
      })
      /**
       * 顶条**不做原生圆角**（半径 0）。
       *
       * 原生 `setBorderRadius` 只能给四个角同一个值，而顶条要的是"上面圆、下面平" ——
       * 下边紧贴着侧栏里的网页上边，两者是**连起来的一整块**，下边再带圆角就会在接缝处
       * 咬出一道豁口（四个角都圆时，两个内凹的弧正对着，像被掐了一下）。
       * 所以圆角改由顶条自己的 DOM 画（`border-radius: R R 0 0`，半径由宿主下发），
       * 原生这层必须归零 —— 否则它会先把顶条的方角连底一起画出来，DOM 的圆角白画。
       */
      if (typeof parts.header.setBorderRadius === 'function') {
        try { parts.header.setBorderRadius(0) } catch (_) {}
      }
    }
    /**
     * 网页视图**往上多留一个圆角的高度**，那一条藏进顶条底下。
     *
     * 为什么必须这样：网页视图的圆角也是四角同值的，它的**上面两个圆角**落在自己的
     * 顶边 —— 那条边正好是接缝。不处理的话，接缝上会露出两个内凹的弧（弧里是外壳底色），
     * 也就是"接缝处有圆角"。
     * 往上多留 `R`，它的上圆角就挪到了接缝**之上**、被顶条那张不透明面盖住；
     * 顶条的下边是平的、网页的可见上边也就跟着是平的 —— 接缝处一个圆角都没有。
     *
     * 代价只有"网页顶部 `R` 像素藏在顶条底下"，而这正是原来被圆角啃掉的那一圈；
     * 网页**可见区域**的位置一点没动（`getFocusedWebBounds` 那份算术不变，
     * 查找栏 / 悬停 URL 仍贴着网页真正露出来的那一块）。
     *
     * ⚠ **这里依赖"顶条图层在内容图层之上"**。两层的 zKey 都是 `'web-sidebar'`（同 z），
     * 次序由「先 push 内容、后 push 顶条」+ LayerManager 的稳定排序（`addChildView`
     * 对已存在子视图等价"移到顶层"）保证 —— 与面板的 `panel` / `panel:header` 同一口径。
     * 若哪天变成"顶条在下"，这 `R` 像素的网页就会盖住顶条下沿、圆角又在接缝处露出来。
     */
    // 网页圆角 —— 与主视图同一个派生值（主进程是圆角真源，渲染侧不自算）；
    // 全屏贴边时跟主视图一起归零，此时也无需把上圆角藏进顶条（overlap 随之归零）。
    const pageRadius = this.host._pageRadius()
    const cornerOverlap = Math.min(Math.max(0, pageRadius), headerHeight)
    this.host._setBoundsIfChanged(parts.content, {
      x: inner.x,
      y: inner.y + headerHeight - cornerOverlap,
      width: inner.width,
      height: Math.max(0, inner.height - headerHeight + cornerOverlap)
    })
    this.host._setRadiusIfChanged(parts.content, pageRadius)
    /**
     * 这里**不推**几何 —— 推的时机统一收在 `applyInitialLayout` 末尾。
     *
     * 本方法跑在"侧栏槽"已定、但 `pageBounds` 还没算出来的位置：在这里推，
     * 调到手的把手矩形就是"本趟的槽 + 上趟的网页"（见 `_webSidebarHandleRect` 的注释）。
     */
  }


}

function installWebSidebarController(host: SidebarHost): WebSidebarController {
  const controller = new WebSidebarController(host)
  const hostRecord = host as unknown as Record<string, unknown>
  const controllerRecord = controller as unknown as Record<string, (...args: unknown[]) => unknown>
  for (const name of Object.getOwnPropertyNames(WebSidebarController.prototype)) {
    if (name === "constructor") continue
    const method = controllerRecord[name]
    if (method) hostRecord[name] = method.bind(controller)
  }
  return controller
}

export { installWebSidebarController, WebSidebarController }
