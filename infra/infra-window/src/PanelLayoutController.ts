/**
 * 侧栏面板布局与生命周期控制器。
 *
 * 负责面板槽位、预取、显示、隐藏、切换与回收；所有布局状态仍由 LayoutCoordinator 持有。
 * 安装时把方法绑定回宿主，保持既有公开调用面不变。
 */

import { onWebContentsDestroyed } from './webContentsLifecycle'

const PANEL_REVEAL_FALLBACK_MS = 1200
const PANEL_PREPARE_TTL_MS = 3000

type PanelSide = 'left' | 'right'
type HostMethod = (...args: unknown[]) => unknown
interface PanelRect { x: number; y: number; width: number; height: number }
interface PanelView {
  webContents: {
    isDestroyed?(): boolean
    on?(event: string, listener: (...args: unknown[]) => void): unknown
    once?(event: string, listener: (...args: unknown[]) => void): unknown
    removeListener?(event: string, listener: (...args: unknown[]) => void): unknown
    isLoading?(): boolean
    getURL?(): string
  }
  setBounds(bounds: PanelRect): void
  setVisible?(visible: boolean): void
  setBorderRadius?(radius: number): void
}
interface PanelParts { content: PanelView; header: PanelView | null; headerHeight: number }
interface PanelViewPort {
  ensurePanelView(panelId: string): { content?: PanelView; header?: PanelView | null; headerHeight?: unknown } | null
  has(panelId: string): boolean
  getPanel(panelId: string): PanelView | null | undefined
  destroyPanel(panelId: string): boolean
  listPanelIds(): string[]
  destroy?(panelId: string): boolean
}
interface PanelLayer { setVisible(visible: boolean): void }
interface PanelPrepared { id: string; timer: ReturnType<typeof setTimeout> }
interface PanelOptions { force?: boolean; pinned?: boolean; side?: PanelSide | null; [key: string]: unknown }
interface PanelHost {
  _panelSlots: Record<PanelSide, string | null>
  _panelPinned: Record<PanelSide, string | null>
  _panelWidths: Record<PanelSide, number>
  _pinnedWidths: Record<PanelSide, number>
  _panelParts: Map<string, PanelParts>
  _pendingPanelPlace: Map<string, PanelSide>
  _preparedPanel: PanelPrepared | null
  _panelViewPort: PanelViewPort | null
  _chromeLayers: Map<string, PanelLayer>
  _lastBounds: Map<unknown, PanelRect>
  _layers: { pop(layer: PanelLayer): unknown }
  _sidebarPosition: string
  _sideColumnSide: string | null
  _contentInsetTop: number
  _contentInsetBottom: number
  _contentInsetLeft: number
  _contentInsetRight: number
  _wcm: {
    getPanel(panelId: string): PanelView | null | undefined
    destroyPanel(panelId: string): boolean
    listPanelIds(): string[]
  }
  applyInitialLayout(): void
  showPanel(panelId: string, side?: PanelSide | null): unknown
  closePanel(panelId: string): unknown
  switchPanel(panelId: string, side?: PanelSide | null): unknown
  hideFloat(name: string): unknown
  forgetContentFocus(view: unknown): void
  _normalizePanelSide(side: string | PanelSide | null | undefined): PanelSide
  _pinnedSideOf(panelId: string): PanelSide | null
  _reportPanelSide(panelId: string, side: PanelSide | null): void
  _reportPanelSides(panelIds: Iterable<string>): void
  _onPanelSideChanged(panelId: string, side: PanelSide | null, pinned: boolean): void
  _prepareRailRestoreBeforePanelClose(): boolean
  _panelViewReady(view: PanelView): boolean
  _reclaimPanelView(panelId: string): boolean
  _reclaimPanelDeferred(panelId: string): void
  _ensurePanelParts(panelId: string): PanelParts | null
  _dropPreparedPanel(): void
  _takePreparedPanel(panelId: string): PanelParts | null
  _detachPanel(side: PanelSide): void
  _hidePanelView(panelId: string): boolean
  _openPanelAt(panelId: string, side: PanelSide): unknown
  _placePanel(side: PanelSide, panelId: string, options?: PanelOptions): string[]
  _pushLayer(name: string, view: PanelView, zKey: string): PanelLayer
  _getLayer(name: string): PanelLayer | null
  _showPanelLayers(panelId: string): void
  _rememberContentFocus(view: unknown, kind: string, key: string): void
  _revealPanelNow(panelId: string): void
  _revealPanelWhenReady(panelId: string): void
  _setBoundsIfChanged(view: PanelView, rect: PanelRect): void
  _setRadiusIfChanged(view: PanelView): void
  _hasPanelView(panelId: string): boolean
  getPanelSideOf(panelId: string): PanelSide | null
  [key: string]: unknown
}

class PanelLayoutController {
  readonly host: PanelHost

  constructor(host: PanelHost) {
    this.host = host
  }

  _normalizePanelSide(side: string | PanelSide | null | undefined): PanelSide {
    return side === 'left' || side === 'right' ? side : (this.host._sidebarPosition === 'right' ? 'right' : 'left')
  }

  /**
   * 侧栏区**实际**所在侧。
   *
   * 未显式设置（null）时跟随 rail —— 历史行为：两段共用一条「侧边栏位置」设置，
   * 渲染层没有单独上报过侧栏区那一侧。两条设置分开之后，渲染层会上报真实值。
   * @returns {'left'|'right'}
   */
  _resolvedSideColumnSide() : 'left'|'right' {
    if (this.host._sideColumnSide === 'left' || this.host._sideColumnSide === 'right') return this.host._sideColumnSide
    return this.host._sidebarPosition === 'right' ? 'right' : 'left'
  }

  /**
   * 设置侧栏区（垂直标签栏那一列）所在侧。
   *
   * 与 rail / 面板的 `setRailLayout` 是**两条独立设置**：纵向轨道上两段可以各靠
   * 一边。传 null 表示「跟随 rail」（历史行为）。
   * @param {'left'|'right'|null} side
   * @returns {boolean} 是否真的发生了变化（未变则不重排）
   */
  setSideColumnSide(side: string | null): boolean {
    const next = side === 'left' || side === 'right' ? side : null
    if (next === this.host._sideColumnSide) return false
    this.host._sideColumnSide = next
    this.host.applyInitialLayout()
    return true
  }

  /** 该面板当前显示在哪一侧（普通位或钉住位都算；没打开 = null）。 */
  getPanelSideOf(panelId: string): PanelSide | null {
    const id = String(panelId)
    if (this.host._panelSlots.left === id) return 'left'
    if (this.host._panelSlots.right === id) return 'right'
    if (this.host._panelPinned.left === id) return 'left'
    if (this.host._panelPinned.right === id) return 'right'
    return null
  }

  /** 该面板是否被钉住（钉住 = 常驻，切换面板不会替换它）。 */
  isPanelPinned(panelId: string): boolean {
    return !!this.host._pinnedSideOf(panelId)
  }

  /**
   * 与另一侧的**同类型面板位**互换。
   *
   * 普通位只对普通位、钉住位只对钉住位：两块面板的视图与内部状态都不重建，
   * 只交换槽位归属。对侧同位为空时等价于纯移动。这样宽度、钉住语义和侧栏节奏
   * 都各归各位，不会因为换边临时改掉另一格的性质。
   *
   * @param {string} panelId
   * @returns {{ ok: boolean, panelId: string, side: 'left'|'right'|null, swappedPanelId: string|null }}
   */
  swapPanelSides(panelId: string): {
    ok: boolean
    panelId: string
    side: PanelSide | null
    swappedPanelId: string | null
  } {
    const id = String(panelId || '')
    const sourceSide = id ? this.host.getPanelSideOf(id) : null
    if (!sourceSide) return { ok: false, panelId: id, side: null, swappedPanelId: null }

    const targetSide: PanelSide = sourceSide === 'left' ? 'right' : 'left'
    const pinned = this.host._panelPinned[sourceSide] === id
    const slots = pinned ? this.host._panelPinned : this.host._panelSlots
    const otherId = slots[targetSide]
    if (otherId === id) return { ok: true, panelId: id, side: sourceSide, swappedPanelId: null }

    slots[sourceSide] = otherId
    slots[targetSide] = id

    this.host.applyInitialLayout()
    this.host._reportPanelSides(otherId ? [id, otherId] : [id])
    return {
      ok: true,
      panelId: id,
      side: targetSide,
      swappedPanelId: otherId
    }
  }

  /** 该面板若在钉住位，返回那一侧；否则 null。 */
  _pinnedSideOf(panelId: string): PanelSide | null {
    const id = String(panelId)
    if (this.host._panelPinned.left === id) return 'left'
    if (this.host._panelPinned.right === id) return 'right'
    return null
  }

  /** 两个面板位的快照（宿主注入的查询口用不到内部对象，给一份拷贝）。 */
  getPanelSlots() {
    return {
      left: this.host._panelSlots.left,
      right: this.host._panelSlots.right,
      pinnedLeft: this.host._panelPinned.left,
      pinnedRight: this.host._panelPinned.right
    }
  }

  /** 某一侧**所有**在屏面板（普通位在前、钉住位在后），null 已过滤。 */
  _panelIdsOnSide(side: PanelSide): string[] {
    return [this.host._panelSlots[side], this.host._panelPinned[side]].filter((id): id is string => !!id)
  }

  /**
   * 注入**面板视图端口**（装配期调一次；见构造函数里那段说明）。
   *
   * 用 setter 而不是构造 option：`LayoutCoordinator` 与 `WebContentsManager` 由
   * `createMainWindow` 一起造出来，而端口的实现要握着 WCM —— 按构造参数传会形成
   * "先有 LC 还是先有端口"的循环。装配顺序天然是"先造两个，再接线"。
   *
   * @param {{ ensurePanelView?: Function, destroy?: Function }|null} port
   */
  setPanelViewPort(port: PanelViewPort | null): void {
    this.host._panelViewPort = port && typeof port.ensurePanelView === 'function' ? port : null
    // 端口换了 → 已缓存的视图包作废（下次打开面板重新向新端口要）
    this.host._panelParts.clear()
  }

  /**
   * 向端口要这个面板的**视图包**（含顶条视图与它的高度）。
   *
   * 缺端口 / 端口返回 null → 返回 null：调用方据此**不占位**（宁可这一侧不开，
   * 也不要一块"打开了但什么都没有"的空白面板）。结果按 id 缓存 —— 视图是常驻的，
   * 每次重排都去问一遍端口等于每次都重建一次判断。
   */
  _ensurePanelParts(panelId: string): PanelParts | null {
    const id = String(panelId)
    const cached = this.host._panelParts.get(id)
    if (cached) return cached
    if (!this.host._panelViewPort) return null
    let parts = null
    try { parts = this.host._panelViewPort.ensurePanelView(id) } catch (error: unknown) {
      console.warn('[layout] ensurePanelView failed:', error instanceof Error ? error.message : error)
      parts = null
    }
    if (!parts) return null
    const content = parts.content
    if (!content) return null
    const normalized: PanelParts = {
      content,
      header: parts.header || null,
      headerHeight: Math.max(0, Number(parts.headerHeight) || 0)
    }
    this.host._panelParts.set(id, normalized)
    // 面板内容面同样要进入焦点记忆（用户可能最后是在面板的搜索框里打字）。
    // 这里只挂一次：`normalized` 是该面板这一代视图的唯一包装，`_reclaimPanelView`
    // 关掉面板时会连 `_panelParts` 一起清（关闭即销毁），下一代视图重新走这里。
    const panelWc = normalized.content && normalized.content.webContents
    if (panelWc && typeof panelWc.on === 'function') {
      try {
        panelWc.on('focus', () => { this.host._rememberContentFocus(panelWc, 'panel', id) })
        onWebContentsDestroyed(panelWc, () => { this.host.forgetContentFocus(panelWc) })
      } catch (_) {}
    }
    return normalized
  }

  /**
   * **意图预取**：入口被悬停/按下时，后台把这块面板的视图造好并加载。
   *
   * 面板"关闭即销毁"，所以每次点开都是一次冷进程（建 renderer + 加载页面 + 求值模块）。
   * 那笔开销原先全落在**用户的点击**上 —— 点下去之后要等 ~65ms 才开始加载，再等页面
   * 起来才有内容。悬停是一个极强的"马上要用它"信号（与 `warmFloatView` 同一判据），
   * 此刻开拉，点击时视图通常**已经就绪**，`_placePanel` 直接走就绪分支 → 原子出现。
   *
   * 约束（为什么它必须是"单槽 + 会过期"的）：
   *   · 不占位、不挂图层、不改布局 —— 预取对界面**完全不可见**；
   *   · 视图用 0×0 + visible 藏着（`createPanel` 的既有口径），不闪白；
   *   · 只保留一个目标，TTL 到点由 `_reclaimPanelView` 回收（它有三道闸门，
   *     万一这块面板真被打开/预约了，回收会被安全拦下）。
   *
   * @param {string} panelId
   */
  preparePanel(panelId: string): boolean {
    const id = String(panelId == null ? '' : panelId)
    if (!id) return false
    // 已经开着 / 已在等就绪 / 已经有视图 → 预取无事可做（loadPanel 本身也幂等）。
    if (this.host.getPanelSideOf(id)) return false
    if (this.host._pendingPanelPlace.has(id)) return false
    if (this.host._preparedPanel && this.host._preparedPanel.id === id) return false
    if (this.host._hasPanelView(id)) return false
    // 目录里没有这条 → 不白造一个进程（端口没实现 has 时按"有"处理，交给 ensure 判定）。
    if (this.host._panelViewPort && typeof this.host._panelViewPort.has === 'function') {
      let known = false
      try { known = !!this.host._panelViewPort.has(id) } catch (_) { known = false }
      if (!known) return false
    }
    // 换目标：上一份预取立刻还回去（单槽 —— 预取永远不该超过一个进程）。
    this.host._dropPreparedPanel()
    const parts = this.host._ensurePanelParts(id)
    if (!parts) return false
    // 双保险：视图还在 0×0；页面由端口在后台加载，这里不等它。
    try { parts.content && parts.content.setBounds({ x: 0, y: 0, width: 0, height: 0 }) } catch (_) {}
    const timer = setTimeout(() => {
      if (this.host._preparedPanel && this.host._preparedPanel.id === id) this.host._preparedPanel = null
      this.host._reclaimPanelView(id)
    }, PANEL_PREPARE_TTL_MS)
    // 不要因为一个"可能不点"的预取把 Node 事件循环钉住（多窗口关窗时的退出体验）。
    if (timer && typeof timer.unref === 'function') timer.unref()
    this.host._preparedPanel = { id, timer }
    return true
  }

  /**
   * 丢掉当前的预取（**包含**回收它的视图）。
   *
   * `_reclaimPanelView` 的闸门会替我们挡住"其实已经占位/已预约"的情况：
   * 那种时候这块视图已经有用主了，不该拆。
   */
  _dropPreparedPanel() {
    const p = this.host._preparedPanel
    if (!p) return
    this.host._preparedPanel = null
    try { clearTimeout(p.timer) } catch (_) {}
    this.host._reclaimPanelView(p.id)
  }

  /**
   * 预取被"消费"：这块面板马上要占位了 → 只取消过期定时器，**保留视图**。
   *
   * 别的目标被预取着而本块要开 → 顺手丢掉那一份（用户已经做出了选择）。
   * @param {string} id 即将占位的面板
   */
  _takePreparedPanel(id: string): PanelParts | null {
    const p = this.host._preparedPanel
    if (!p) return null
    if (p.id === String(id)) {
      this.host._preparedPanel = null
      try { clearTimeout(p.timer) } catch (_) {}
      return this.host._panelParts.get(String(id)) || null
    }
    this.host._dropPreparedPanel()
    return this.host._panelParts.get(String(id)) || null
  }

  /**
   * 上报「某面板所在侧 / 钉住状态变了」。
   * 宿主据此把拖拽手柄挪到正确那条边、把图钉按钮画成对应状态，并按**位**读写宽度。
   */
  _reportPanelSide(panelId: string, side: PanelSide | null): void {
    if (!this.host._onPanelSideChanged) return
    const id = String(panelId)
    let pinned = false
    if (side) {
      try { pinned = this.host._pinnedSideOf(id) === side } catch (_) {}
    }
    try { this.host._onPanelSideChanged(id, side, pinned) } catch (_) {}
  }

  /**
   * 把面板放进指定的位（不含布局重排）。
   *
   * ⚠ 单实例约束：同一个 panelId 只有一份 WebContentsView，所以它**同时只能占一个位**。
   * 若它正占着另一个位，先把那一位清空 —— 这就是「同一个面板只留一个」。
   *
   * ⚠ 页面**未就绪**时**不写槽位**（= 不占位），只登记到 `_pendingPanelPlace`，
   * 等就绪后由 `_revealPanelWhenReady` 一次性"占位 + 显示 + 应用布局" ——
   * 这样界面在等待期间一动不动，面板原子出现，中途没有空面板区域。
   * 相关：`_pendingPanelPlace` 的说明、`_openPanelAt`、`hidePanel`（会清这一侧的预约）。
   *
   * @param {'left'|'right'} side
   * @param {string} id
   * @param {{ force?: boolean }} [opts] force=true：跳过"未就绪则预约"这条分支，
   *   直接占位 + 显示（供 `_revealPanelWhenReady` 的回调使用 —— 那里必须落地，
   *   否则页面始终不就绪时会变成"每 1.2s 重排一次"的循环）。
   * @returns {string[]} 需要上报「侧已变」的 panelId（去重，含被挤走的）
   */
  _placePanel(side: PanelSide, id: string, opts: PanelOptions = {}): string[] {
    const touched = new Set([id])
    // 目标面板正钉在**同一侧**的钉住位 → 它本来就在屏幕上，且钉住位不被切换替换：
    // 本次什么都不做（否则会被"放到普通位"的逻辑从钉住位挪走 —— 那正是钉住要防的）。
    if (this.host._panelPinned[side] === id) return [id]
    // 意图预取被消费：取消它的过期定时器、保留已就绪的视图（别的目标则顺手还回去）。
    this.host._takePreparedPanel(id)
    const other = side === 'left' ? 'right' : 'left'
    // 同一面板正占着另一侧 → 那一位先空出来（这是"挪过去"，不是"换掉"）
    if (this.host._panelSlots[other] === id) {
      this.host._detachPanel(other)
      this.host._panelSlots[other] = null
    }
    // 同侧若还压着**别的**预约（用户连点了两个面板）→ 作废并回收它，
    // 否则它稍后到点会反过来把刚打开的这一只挤掉。
    for (const [pid, ps] of Array.from(this.host._pendingPanelPlace)) {
      if (ps === side && pid !== id) {
        this.host._pendingPanelPlace.delete(pid)
        this.host._reclaimPanelView(pid)
      }
    }
    const prev = this.host._panelSlots[side]
    // 视图由**端口**造与加载（本类只摆它）—— 见 `_ensurePanelParts`。
    const parts = this.host._ensurePanelParts(id)
    const view = (parts && parts.content) || this.host._wcm.getPanel(id)
    // 目录里没有这条 / 视图没造出来 → 既不占位、也不动 prev（界面保持原样）。
    if (!view) return [...touched]
    // 目标面板钉在**另一侧** → 挪过来：先取消那边的钉住（同一份视图只占一个位）。
    // 放在"确认视图存在"之后：视口失败时不能先把钉住位清掉，那会留下一块没有槽的面板。
    const pinnedElsewhere = this.host._pinnedSideOf(id)
    if (pinnedElsewhere) this.host._panelPinned[pinnedElsewhere] = null
    this.host._pushLayer(`panel:${id}`, view, 'panel')
    // 顶条（网页面板）：与内容**同在 panel 层**（不新造图层），位置由 applyInitialLayout 统一摆。
    if (parts && parts.header) {
      this.host._pushLayer(`panel:${id}:header`, parts.header, 'panel')
    }
    // ⚠ 页面**未就绪** → 只把新视图按 0×0 挂好、登记预约，**既不动 prev 也不动槽位**：
    //   · **切换**面板时：prev 继续原样显示着 —— 用户看到的是"旧面板一直在，然后直接变成新的"，
    //     而不是"旧的先消失 → 空白 ~65ms → 新的才出现"（那就是"切换时闪两下"的真身）；
    //   · **从零打开**时：prev 为空，槽位保持空 → 布局当它不存在（网页不收窄、界面一动不动）。
    //   两种情况都等就绪后由 `_revealPanelWhenReady` 走 force 一次性交接。见 `_pendingPanelPlace`。
    if (!opts.force && !this.host._panelViewReady(view)) {
      try { view.setBounds({ x: 0, y: 0, width: 0, height: 0 }) } catch (_) {}
      this.host._pendingPanelPlace.set(id, side)
      this.host._revealPanelWhenReady(id)
      return []
    }
    // 就绪 → 交接。
    //
    // ★ 顺序**必须是「先占位、再收旧」**（原来是「置空 → 收旧 → 再写新」）：
    //   槽位一旦出现 `null`，**任何落在那个空隙里的布局**（另一侧面板/标签的事件、
    //   设置变更、窗口 resize、`_reclaimPanelView` 里可能的异步端口往返……）都会把
    //   网页按"这一侧没有面板"排一遍，紧接着又被下一趟排回来 ——
    //   肉眼就是**切面板时网页被整个重排、抖一下**。
    //   先写新槽位之后，这一侧的**占位宽度全程不变**，切换对布局完全不可见 ——
    //   与 rail 侧"本来就一直占着位"的表现一致（用户原话：切换时也该有占位）。
    if (prev && prev !== id) {
      touched.add(prev)
      this.host._panelSlots[side] = id
      // 只收旧的那一条（按 id 定向），**不碰槽位**
      // 隐藏 = 立刻消失（视觉上已交接完成）；销毁排到下一拍，见 `_reclaimPanelDeferred`。
      this.host._hidePanelView(prev)
      this.host._reclaimPanelDeferred(prev)
    } else {
      this.host._panelSlots[side] = id
    }
    this.host._showPanelLayers(id)
    return [...touched]
  }

  /** 该面板视图的页面是否已就绪（已加载过 —— 而不是刚造出来、还没 loadURL）。 */
  _panelViewReady(view: PanelView): boolean {
    const wc = view && view.webContents
    if (!wc) return false
    try {
      if (typeof wc.isDestroyed === 'function' && wc.isDestroyed()) return false
      // 刚创建、还没开始加载的视图：`isLoading()` 也是 false，但 `getURL()` 是空串 ——
      // 用「已经有过 URL」来区分"已就绪"与"还没开始加载"，否则新视图会被误判成就绪。
      return typeof wc.isLoading === 'function' && typeof wc.getURL === 'function' && !wc.isLoading() && !!wc.getURL()
    } catch (_) {
      return true
    }
  }

  /**
   * 把某面板的两条图层显示出来（**仅当它此刻仍在某个槽里**）。
   *
   * 为什么必须再确认一次槽位：`_revealPanelWhenReady` 是**异步**的，等待期间用户完全
   * 可能已经把这个面板关掉 / 换成别的 —— 那时把它显示出来就会凭空冒出一块面板。
   * @param {string} id
   */
  _showPanelLayers(id: string): void {
    if (!this.host.getPanelSideOf(id)) return
    const key = `panel:${id}`
    const layer = this.host._getLayer(key)
    if (layer) { try { layer.setVisible(true) } catch (_) {} }
    const headerLayer = this.host._getLayer(`${key}:header`)
    if (headerLayer) { try { headerLayer.setVisible(true) } catch (_) {} }
  }

  /**
   * 等新建面板的页面就绪后再把它显示出来（消掉"从零打开闪一下"）。
   *
   * 三条出口都要接 —— 缺一条都可能让面板**永远不显示**（那比闪一下严重得多）：
   *   · `did-finish-load` —— 正常加载完成；
   *   · `did-fail-load`   —— 加载失败（404 / 被拦）同样要显示，否则面板永远空着；
   *   · 超时兜底          —— 上面两个都没来（异常页面）时强制显示，见 PANEL_REVEAL_FALLBACK_MS。
   *
   * @param {string} id
   */
  _revealPanelWhenReady(id: string): void {
    const key = String(id)
    const parts = this.host._panelParts.get(key) || null
    const content = (parts && parts.content) || this.host._wcm.getPanel(key)
    const wc = content && content.webContents
    let done = false
    let timer: ReturnType<typeof setTimeout> | null = null
    const reveal = () => {
      if (done) return
      done = true
      // 三条出口只留**先到的那一条**：其余监听与兜底定时器必须在这一刻拆掉。
      // 不拆的话，每次"未就绪 → 预约"都会往同一个 webContents 上叠一对 once 监听
      // （快速连点面板 = 叠好几对），而它们要等页面真正加载完才消费掉 —— 期间纯占内存，
      // 超过 10 条还会让 Electron 打 MaxListenersExceededWarning。
      if (timer) { try { clearTimeout(timer) } catch (_) {} timer = null }
      try {
        if (wc) {
          wc.removeListener?.('did-finish-load', reveal)
          wc.removeListener?.('did-fail-load', reveal)
        }
      } catch (_) {}
      // 与主进程所有定时器回调同一条铁律：这里的 `_placePanel` / `_showPanelLayers`
      // 都是真实视图操作，视图恰在析构时会抛 —— 抛出去就是整进程 uncaughtException。
      // 兜底超时这条出口尤其危险：它总在"页面迟迟不就绪"的异常场景才走到。
      try {
        this.host._revealPanelNow(key)
      } catch (_) {}
    }
    if (!wc || (typeof wc.isDestroyed === 'function' && wc.isDestroyed())) {
      // 没有可等的页面（视图不存在 / 已销毁）→ 直接走显示路径（幂等，槽位检查会兜住）。
      reveal()
      return
    }
    try {
      wc.once?.('did-finish-load', reveal)
      wc.once?.('did-fail-load', reveal)
    } catch (_) {}
    timer = setTimeout(reveal, PANEL_REVEAL_FALLBACK_MS)
    if (typeof timer.unref === 'function') timer.unref()
  }

  /**
   * `_revealPanelWhenReady` 的落实体（拆出来只为让它单独可被 try/catch 包住）。
   * @param {string} key 面板 id
   */
  _revealPanelNow(key: string): void {
    const side = this.host._pendingPanelPlace.get(key)
    this.host._pendingPanelPlace.delete(key)
    if (!side) {
      // 不是"待占位"（只是等显示）→ 只有它确实仍占着槽位才显示。
      // 用户可能在页面就绪前就关掉了它，此时超过兜底时间也绝不能把面板“复活”。
      if (this.host.getPanelSideOf(key)) this.host._showPanelLayers(key)
      return
    }
    // 已经在位（幂等兜底）。
    if (this.host._panelSlots[side] === key) {
      this.host._showPanelLayers(key)
      return
    }
    // ⚠ 这里**不能**写"槽里有面板就放弃" —— 切换面板时旧面板本来就一直占着这一侧
    //   （那正是"旧的一直显示、新的就绪后交接"这个效果的前提）。用户中途改主意
    //   （连点第三个 / 把它关掉）由两处覆盖：`_placePanel` 开头的"同侧旧预约作废并回收"
    //   与 `hidePanel` 的清理 —— 那时 `_pendingPanelPlace` 里已经没有这一条，
    //   回调在更上面就返回了。
    // ⚠ `force: true` —— 此刻**必须**摆上去。若这里退回到"未就绪就再预约"，
    // 一旦页面始终不就绪（加载失败、且 did-fail-load 已经来过一次），
    // 就会变成"每 1.2s 重排一次"的无限循环。
    const touched = this.host._placePanel(side, key, { force: true })
    // 面板出现的那一帧开始**让位缓动**：网页占位宽度平滑收窄，面板落位与起手同一时刻。
    // 刻意不加 immediate —— 这段缓动就是"面板打开占位"的观感来源（见 _tabTween 的说明）。
    try { this.host.applyInitialLayout() } catch (_) {}
    try { this.host._reportPanelSides(touched) } catch (_) {}
  }

  /**
   * 摆一个**面板位**：内容 = 整块减去顶条，顶条自己贴在最上面。
   *
   * ⚠ 顶条高度来自端口给的视图包（`headerHeight`），**不是**按面板种类判断 ——
   * 布局层永远不知道"这是不是网页面板"，它只知道"这一块要留 24px"。
   * app 面板的 `headerHeight = 0` → 与本改造前**逐像素一致**。
   *
   * ── 呼吸空与圆角：与网页**同源**（用户原话："面板也做个和网页一样的上下左右边距…
   *    也做个和网页一样的圆角，是可以一起调节的"）────────────────────────────
   *   · 边距：上下 + **外侧**各让出 `_contentInset*`；**朝网页那一侧不让** ——
   *     网页自己那圈 4px（`padLeft/padRight`）就是两块之间的间隔，再让一次就成 8px，
   *     与其它三边不一致（面板贴哪边，网页就在它的反面，所以"外侧"= 面板自己那一侧）；
   *   · 圆角：`setBorderRadius(_tabBorderRadius)`，与标签视图**同一个值** ——
   *     主题的 `style.cornerRadius` 一处调、两处生效（见 setTabTheme）。
   * 于是面板与网页是同一套"浮在内容区里的一块"，四周留白与转角都对得上。
   *
   * @param {string} panelId
   * @param {{x:number,y:number,width:number,height:number}} rect 槽矩形（**不含**呼吸空）
   * @param {'left'|'right'} side 面板所在侧（网页恒在它的反面）
   */
  _placePanelSlot(panelId: string, rect: PanelRect, side: PanelSide): void {
    const parts = this.host._panelParts.get(String(panelId)) || null
    const insetTop = Math.max(0, Math.round(this.host._contentInsetTop || 0))
    const insetBottom = Math.max(0, Math.round(this.host._contentInsetBottom || 0))
    const insetOuter = Math.max(0, Math.round(
      (side === 'right' ? this.host._contentInsetRight : this.host._contentInsetLeft) || 0
    ))
    const slotX = side === 'right' ? rect.x : rect.x + insetOuter
    const slotWidth = Math.max(0, rect.width - insetOuter)
    const slotY = rect.y + insetTop
    const slotHeight = Math.max(0, rect.height - insetTop - insetBottom)
    const top = Math.min(parts ? parts.headerHeight : 0, slotHeight)
    const view = this.host._wcm.getPanel(panelId)
    if (view) {
      this.host._setBoundsIfChanged(view, {
        x: slotX,
        y: slotY + top,
        width: slotWidth,
        height: Math.max(0, slotHeight - top)
      })
      // 与标签视图同一个半径（主题一处调节、两处生效）；面板首帧绘制前也不该是方角。
      // 走去重口：面板每次重排都重做一遍遮罩是白花（表现是"面板闪一下"）。
      this.host._setRadiusIfChanged(view)
    }
    if (parts && parts.header) {
      this.host._setBoundsIfChanged(parts.header, { x: slotX, y: slotY, width: slotWidth, height: top })
      // 顶条与内容拼成同一块，圆角也得一致 —— 当前没有任何面板产顶条
      // （见 panel-views：恒返回 header: null），真做起来这里要注意：`setBorderRadius`
      // 只吃**一个**半径（四角同值），顶条与内容各带四角会在接缝处捏出两个小凹口，
      // 那时需要的是 per-corner 半径（或把顶条并进内容页里画）。
      this.host._setRadiusIfChanged(parts.header)
    }
  }

  /**
   * 收起某一侧的面板 —— **按槽位取 id 的便捷入口**，只读槽位、**不改槽位**。
   *
   * 真正做事的实现在 `_hidePanelView(id)`；清槽由各调用方自己负责（顺序各不相同，
   * 见 `_placePanel` 的交接：那里必须**先写新槽位、再收旧的**，槽位不能中途落空）。
   */
  _detachPanel(side: PanelSide): void {
    const id = this.host._panelSlots[side]
    if (id) this.host._hidePanelView(id)
  }

  /**
   * 收起指定面板的两条图层（**不碰槽位、不摘图层、不销毁**）。
   *
   * 为什么按 id 而不是按侧：交接（`_placePanel`）需要"把旧的收起来，但槽位已经
   * 交给新的了" —— 那一刻按侧取 id 会取到**新的**。按 id 定向才能表达"就是这个"。
   *
   * ⚠ **不冻结**（历史上这里会 `freezeWebContents`）。面板是「关闭即卸载」，本类里
   * 每一次收起后面紧跟的必然是**销毁**（`_reclaimPanelDeferred`）或**立刻重新显示**
   * （挪到另一侧）。前者等于给一个马上要拆的进程做一次 CDP attach，纯浪费；后者更糟 ——
   * 冻结命令是异步的，可能在"重新显示"之后才落到渲染进程，页面会**卡在 frozen 态**
   * 不动。所以收起只做 `setVisible(false)`，省掉一次同步 attach 与两条跨进程命令。
   *
   * @param {string} id 要收起的面板 id（不存在的 id 为无操作）
   */
  _hidePanelView(id: string): boolean {
    const key = String(id || '')
    if (!key) return false
    const parts = this.host._panelParts.get(key) || null
    const content = (parts && parts.content) || this.host._wcm.getPanel(key)
    const header = (parts && parts.header) || null

    const layer = this.host._getLayer(`panel:${key}`)
    if (layer) layer.setVisible(false)
    else if (content && typeof content.setVisible === 'function') { try { content.setVisible(false) } catch (_) {} }
    // 顶条（网页面板）与内容同进同退：留着它会变成一条悬空的白条。
    const headerLayer = this.host._getLayer(`panel:${key}:header`)
    if (headerLayer) headerLayer.setVisible(false)
    else if (header && typeof header.setVisible === 'function') { try { header.setVisible(false) } catch (_) {} }

    // 面板里的 hover 预览（tabpreview-overlay）挂在行上：面板被程序关掉 / 换掉时
    // 光标没动，面板收不到 mouseleave，不主动收就会留下贴在外缘的孤儿浮层。
    this.host.hideFloat('tabpreview-overlay')
    return true
  }

  /**
   * 打开面板到指定侧（缺省 = 设置那一侧）。
   * @param {string} panelId
   * @param {'left'|'right'} [side]
   * @returns {{ open: boolean, panelId: string, side: 'left'|'right' }}
   */
  showPanel(panelId: string, side?: PanelSide | null): unknown {
    const id = String(panelId)
    const target = this.host._normalizePanelSide(side)
    if (this.host.getPanelSideOf(id) === target) return { open: true, panelId: id, side: target }
    return this.host._openPanelAt(id, target)
  }

  /** 是否仍有面板在位，或正在等待页面就绪后占位。 */
  _hasOpenPanels(): boolean {
    return Object.values(this.host._panelSlots).some(Boolean) ||
      Object.values(this.host._panelPinned).some(Boolean) ||
      this.host._pendingPanelPlace.size > 0
  }

  /**
   * 关掉某一侧的面板（缺省 = 两侧都关）。
   * @param {'left'|'right'} [side]
   */
  hidePanel(side: PanelSide): boolean {
    const sides: PanelSide[] = side === 'left' || side === 'right' ? [side] : ['left', 'right']
    // 「已预约但还没占位」的面板要一并算作"这一侧被关掉了" —— 否则用户按下关闭、
    // ~65ms 后面板又自己冒出来（它只是还没摆上去，而用户眼里已经点了关）。
    for (const [pid, ps] of Array.from(this.host._pendingPanelPlace)) {
      if (!sides.includes(ps)) continue
      this.host._pendingPanelPlace.delete(pid)
      // 顺手回收它那份视图 —— 它没占位、也没人要了，不收回就是一份没人管的 renderer。
      this.host._reclaimPanelView(pid)
    }
    const touched: string[] = []
    for (const s of sides) {
      const id = this.host._panelSlots[s]
      if (id) {
        // 顺序要紧：_detachPanel 是照着槽里的 id 去隐藏的，必须先隐藏再清槽。
        this.host._detachPanel(s)
        this.host._panelSlots[s] = null
        touched.push(id)
      }
      // 钉住位与普通位是两块独立的位：`hidePanel(side)` = 把这一侧**全部**收起
      // （面板换宿主 / 对账这类"这一侧不要了"的场景）。只想关一块请用 `closePanel(id)`。
      const pinnedId = this.host._panelPinned[s]
      if (pinnedId) {
        this.host._hidePanelView(pinnedId)
        this.host._panelPinned[s] = null
        touched.push(pinnedId)
      }
    }
    if (touched.length && !this._hasOpenPanels()) {
      this.host._prepareRailRestoreBeforePanelClose()
    }
    if (!touched.length) return false
    // 关闭与打开对称：网页把那一块占位**缓动收回来**（180ms，见 _tabTween 的说明）。
    this.host.applyInitialLayout()
    this.host._reportPanelSides(touched)
    // 关掉的每一个面板**立刻卸载**（销毁它的 renderer 进程）—— 见文件头 PANEL 的说明。
    // 这是"面板不再是只增不减"的唯一入口：无论从哪条路径关（rail 图标、Esc、切换挤掉），
    // 最终都汇到这里。
    // 走延后一拍：上面刚起的是 180ms 的收窄缓动，同步拆进程会把这段动画掐出顿感。
    for (const id of touched) this.host._reclaimPanelDeferred(id)
    return true
  }

  /**
   * 关掉**某一块**面板（不管它住在普通位还是钉住位）。
   *
   * 与 `hidePanel(side)` 的分界：
   *   · 面板自己的关闭按钮 / Esc → 只关用户看着的这一块 → **本方法**；
   *   · "这一侧整个不要了"（换宿主、对账）→ `hidePanel(side)`。
   * 用 `hidePanel(side)` 去实现关闭按钮，会在"同侧同时开着普通 + 钉住"时一次关两块 ——
   * 用户只点了一个 ✕，却连常驻的那块也一起消失。
   *
   * @param {string} panelId
   * @returns {boolean} 它当时是否在屏（不在屏 = 无操作）
   */
  closePanel(panelId: string): boolean {
    const id = String(panelId)
    const side = this.host.getPanelSideOf(id)
    if (!side) return false
    if (this.host._panelPinned[side] === id) this.host._panelPinned[side] = null
    else this.host._panelSlots[side] = null
    if (!this._hasOpenPanels()) this.host._prepareRailRestoreBeforePanelClose()
    this.host._hidePanelView(id)
    this.host.applyInitialLayout()
    this.host._reportPanelSides([id])
    this.host._reclaimPanelDeferred(id)
    return true
  }

  /**
   * 钉住 / 取消钉住一块面板（标题栏的图钉按钮）。
   *
   * 语义（与用户原话对齐："固定的这个面板不能够在切换时被关闭或切换左右"）：
   *   · 钉住 → 从普通位移到**钉住位**：位置更靠网页那一侧，且后续切换只动普通位；
   *     若钉住位原本有人，它降到普通位（那块普通位此刻正好空出来）—— 双方都不关闭。
   *     标题栏的显式换边按钮不属于"切换面板"，仍可把它整体搬到对侧钉住位。
   *   · 取消钉住 → 回到**同侧普通位**（它仍然开着，只是重新变成"可被切换替换"的一格）。
   *     ⚠ 普通位原本若有人，它**被替换掉**（与"切换面板"同一条命运），
   *     **绝不把它推上钉住位** —— 那等于替用户按下了另一块的图钉，用户看到的就是
   *     "取消固定后原本的普通面板自己变固定了"（并伴随两块来回换位）。
   *
   * @param {string} panelId
   * @param {{ pinned?: boolean }} [opts] 省略 = 切换
   * @returns {{ pinned: boolean, side: 'left'|'right'|null }}
   */
  pinPanel(panelId: string, opts: PanelOptions = {}): { pinned: boolean; side: PanelSide | null } {
    const id = String(panelId)
    const side = this.host.getPanelSideOf(id)
    if (!side) return { pinned: false, side: null }
    const currentlyPinned = this.host._panelPinned[side] === id
    const wantPinned = typeof opts.pinned === 'boolean' ? opts.pinned : !currentlyPinned
    if (currentlyPinned === wantPinned) return { pinned: currentlyPinned, side }

    const touched = new Set([id])
    if (wantPinned) {
      // 同侧钉住位原本**空着** → 采用这块面板当前的宽度（钉下去不该"啪"地跳一档）。
      // 原本就有人（下面的互换）则保留用户给钉住位调过的宽度。
      if (!this.host._panelPinned[side]) this.host._pinnedWidths[side] = this.host._panelWidths[side]
      // 同侧钉住位已有别的面板 → **两块位互换**（不是关掉它）：
      // 用户只是把"谁常驻"换了个人，另一块仍然开着，只是降回可被切换替换的普通位。
      const prevPinned = this.host._panelPinned[side]
      if (this.host._panelSlots[side] === id) this.host._panelSlots[side] = null
      this.host._panelPinned[side] = id
      if (prevPinned && prevPinned !== id) {
        this.host._panelSlots[side] = prevPinned
        touched.add(prevPinned)
      }
    } else {
      // 取消钉住 → 回到普通位。普通位原本若压着别的面板，它**被替换**（正常切面命运），
      // 不推上钉住位：否则那块面板的图钉会凭空亮起，两块还会来回换位（"推推搡搡"）。
      const prevNormal = this.host._panelSlots[side]
      this.host._panelPinned[side] = null
      this.host._panelSlots[side] = id
      if (prevNormal && prevNormal !== id) {
        touched.add(prevNormal)
        this.host._hidePanelView(prevNormal)
        this.host._reclaimPanelDeferred(prevNormal)
      }
    }
    // 视图在两块位之间"原地搬家"：不隐藏、不重建、不重新加载 —— 只改占位算术。
    this.host.applyInitialLayout()
    this.host._reportPanelSides(touched)
    return { pinned: wantPinned, side }
  }

  // ── 面板卸载（每个面板 = 一个独立 renderer 进程，关掉即释放）──

  /**
   * 该面板此刻是否有活着的视图。
   *
   * ⚠ 判据**必须两者都认**：面板视图有两个来源 —— 普通面板由 `WebContentsManager#createPanel`
   * 造（在 `_panelViews` 里），而**网页面板**是端口造的、只在 `_panelParts` 里留一个视图包。
   * 只查 `_wcm.getPanel` 会让后者的进程永远收不掉（回收闸门直接早退）。
   * @param {string} id
   */
  _hasPanelView(id: string): boolean {
    if (this.host._panelParts.has(id)) return true
    return !!(this.host._wcm && typeof this.host._wcm.getPanel === 'function' && this.host._wcm.getPanel(id))
  }

  /**
   * **卸载**一个面板的渲染进程（销毁视图与 webContents）。
   *
   * 闸门：**两侧槽里都没有它**才动手 —— 用户正看着的面板绝不能拆。
   * （调用点都在清槽之后，因此这个闸门是"防误用"的安全网，不是常规路径。）
   *
   * 清理顺序与 `reconcilePanels` 逐字一致（那里已经踩过坑）：
   *   ① 先摘图层（内容 + 顶条两份，少摘一份就是一条指向已销毁 webContents 的空壳）；
   *   ② 作废视图包 `_panelParts`（下次这条 id 再出现时重新向端口要）；
   *   ③ 销毁交给**端口**（谁造的谁销毁：app 面板一份视图、网页面板还多一份顶条），
   *      端口不接管时才回落到 `WebContentsManager#destroyPanel`。
   *
   * `destroyPanel` 内部会清 `_panelLoaded` / `_panelLoadPromises` ——
   * 少了那一步，「再次打开」会命中"已加载"记忆直接 return，页面永远不出来。
   *
   * @param {string} panelId
   * @returns {boolean} 是否真的卸载了
   */
  _reclaimPanelView(panelId: string): boolean {
    const id = String(panelId)
    // 被回收的若正是"意图预取"那一块：连同它的过期定时器一起作废，否则
    // `_preparedPanel` 会留下一条指向已销毁视图的幽灵记录（下次预取会误判"已就绪"）。
    if (this.host._preparedPanel && this.host._preparedPanel.id === id) {
      try { clearTimeout(this.host._preparedPanel.timer) } catch (_) {}
      this.host._preparedPanel = null
    }
    // 「已预约占位、正在等页面就绪」的面板不能收 —— 用户刚点了它，收了就白点一次。
    if (this.host._pendingPanelPlace.has(id)) return false
    if (this.host.getPanelSideOf(id)) return false
    if (!this.host._hasPanelView(id)) return false
    // 取内容视图只用于清单表清理；它可能来自端口（网页面板）或 WCM（普通面板），两者都认。
    const parts = this.host._panelParts.get(id) || null
    const view = (parts && parts.content) ||
      (this.host._wcm && typeof this.host._wcm.getPanel === 'function' ? this.host._wcm.getPanel(id) : null)

    const name = `panel:${id}`
    const layer = this.host._getLayer(name)
    if (layer) {
      try { this.host._layers.pop(layer) } catch (_) {}
      this.host._chromeLayers.delete(name)
    }
    const headerName = `${name}:header`
    const headerLayer = this.host._getLayer(headerName)
    if (headerLayer) {
      try { this.host._layers.pop(headerLayer) } catch (_) {}
      this.host._chromeLayers.delete(headerName)
    }
    this.host._panelParts.delete(id)
    this.host._lastBounds.delete(view)
    const viaPort = this.host._panelViewPort && typeof this.host._panelViewPort.destroy === 'function'
      ? !!this.host._panelViewPort.destroy(id)
      : false
    const destroyed = viaPort || (this.host._wcm && typeof this.host._wcm.destroyPanel === 'function'
      ? this.host._wcm.destroyPanel(id)
      : false)
    return !!destroyed
  }

  /**
   * **延后一拍**卸载（切换面板的专用回收路径）。
   *
   * 为什么不能同步拆：`webContents.destroy()` 会同步拆掉一整个 renderer 进程
   * （关 IPC、等子进程退出、回收共享内存），这段开销**全在主线程**上。而切换时它
   * 恰好压在新面板「已显示、正要合成第一帧」的同一条时间线上 —— 用户看到的就是
   * 「点下去不跟手、新的顿一下才出来」。
   *
   * 拆成两拍后：
   *   · 本帧只 `_hidePanelView`（旧面板瞬间消失，交接已经视觉完成）；
   *   · 进程在 `setImmediate` 里拆 —— 切换的 IPC 处理器因此能**立刻返回消息循环**，
   *     让合成/绘制任务先跑，而不是「拆进程」堵在返回之前。
   *
   * 语义没变（还是关闭即卸载），只是这一拍不再同步。闸门仍由 `_reclaimPanelView`
   * 统一把关：延后期间若它又被摆回槽位或重新登记为预约，那次回收会自己早退，
   * 视图与进程原样留着，不会出现「刚显示就被拆」。
   *
   * ⚠ 这里**不能**吞掉 `_preparedPanel` 的作废逻辑 —— 那部分留在 `_reclaimPanelView`
   * 里，统一按同一套闸门判定，延后只是不阻塞主线程，不改变任何判据。
   * @param {string} panelId
   */
  _reclaimPanelDeferred(panelId: string): void {
    const id = String(panelId)
    if (!id) return
    setImmediate(() => {
      try {
        this.host._reclaimPanelView(id)
      } catch (_) {
        // 延后执行的异常没有调用方可以接：宁可漏收一份视图，也不能让主进程崩在定时器里。
      }
    })
  }

  /**
   * **兜底**：卸载任何"有视图、但当前没打开"的面板。
   *
   * 正常路径上它什么都不用做 —— 面板已经"关闭即卸载"（见 `hidePanel` 与 `_placePanel`），
   * 关掉的那一刻视图就销毁了，不会留下"已加载但未打开"的面板。
   * 留着它是为了两件事：
   *   · 内存压力回收链路需要一个统一的"把能收的都收掉"入口（与浮层那条对称）；
   *   · 将来若新增"隐藏但不关闭"的路径，这里能自动把残留清掉（不必再改第二处）。
   * 成本 = 一次 Set 遍历，可忽略。
   *
   * 返回**裸数组**以便 `layoutFanout` 的 `unionMethods` 汇总多窗口结果。
   *
   * @returns {string[]} 被卸载的面板 id（供日志观察）
   */
  reclaimIdlePanelViews() : string[] {
    const reclaimed = []
    // ⚠ 两个来源都要遍历：普通面板的视图在 `WebContentsManager#_panelViews`，
    //   而网页面板的视图是端口造的、只在 `_panelParts` 里留一个包 ——
    //   只看前者会漏掉整整一类面板（它们的进程照样常驻）。
    const ids = new Set<string>()
    if (this.host._wcm && typeof this.host._wcm.listPanelIds === 'function') {
      for (const id of this.host._wcm.listPanelIds()) ids.add(String(id))
    }
    for (const id of this.host._panelParts.keys()) ids.add(String(id))
    for (const id of ids) {
      if (this.host._reclaimPanelView(id)) reclaimed.push(id)
    }
    return reclaimed
  }

  /**
   * **兜底**：侧栏收起时释放它的两份视图（内容 + 顶条，各一个 renderer 进程）。
   *
   * 为什么侧栏**不做时间 TTL**、只挂在内存压力链上：
   * 侧栏的内容是一个**真实网页**（`createWebSidebarView`，与标签同一套 webPreferences /
   * 同一条 session），它比浮层/面板重得多 —— 登录态、滚动位置、**可能正在播放的媒体**。
   * 用户收起侧栏再打开时，理应还是原来那一页；按时间"过期"会变成"开了又关的侧栏
   * 过一会儿自己变成空白"。所以只在**内存真的紧张**时才收，且有两道闸门：
   *   · 侧栏当前**不可见**（用户没在看它）—— `isWebSidebarVisible`；
   *   · 内容页**没有在发声** —— 与标签休眠同一豁免口径（`sleepCandidates` 的 `audio` 豁免）：
   *     收掉正在播放的东西属于"优化反而打断用户"。
   *
   * @returns {boolean} 是否真的回收了
   */
  /** 批量上报（去重后的 panelId → 最终所在侧，null = 已不在任何一侧）。 */
  _reportPanelSides(panelIds: string[]): void {
    for (const id of panelIds) {
      let side: PanelSide | null = null
      try { side = this.host.getPanelSideOf(id) } catch (_) {}
      this.host._reportPanelSide(id, side)
    }
  }

  /**
   * 在**同一侧**换一个面板显示：保留这一位的宽度，只替换内容视图 ——
   * 不经过「隐藏→展开」两步，页面/界面宽度不抖。
   *
   * @param {string} panelId 目标面板
   * @param {'left'|'right'} [side] 目标侧（缺省 = 设置那一侧）
   * @returns {{ open: boolean, panelId: string, side: 'left'|'right' }}
   */
  switchPanel(panelId: string, side?: PanelSide | null): unknown {
    const id = String(panelId)
    const target = this.host._normalizePanelSide(side)
    if (this.host._panelSlots[target] === id) return { open: true, panelId: id, side: target }
    return this.host._openPanelAt(id, target)
  }

  /**
   * 把某面板摆到指定侧的**唯一实现**（`showPanel` / `switchPanel` 共用）。
   *
   * 为什么必须收敛成一处：两者的差别只有"已在该侧时提前返回"的判据（一个看槽、一个看侧），
   * 摆的那一步完全相同 —— 各写一遍必然漂移，而"空面板闪烁"这类问题恰恰长在漂移里。
   */
  _openPanelAt(id: string, target: PanelSide): unknown {
    const touched = this.host._placePanel(target, id)
    // ⚠ 页面还没就绪时 `_placePanel` 只做了"预约"（**不占位**）—— 此时绝不能应用布局，
    //    否则网页会先收窄、留出一块空面板区域停 ~65ms（用户原话：
    //    "不加载出来就不要有空面板"）。真正应用布局的时机在 `_revealPanelWhenReady`
    //    的回调里，与面板出现**同一时刻**发生。
    if (!this.host._pendingPanelPlace.has(String(id))) {
      // 面板已就绪 → 从这里**起手让位缓动**（与就绪交接那条路径同一口径）。
      // 同侧换面板时槽位宽度不变 → 网页 bounds 不变 → 补间空转 ⇒ 切换没有任何动画。
      this.host.applyInitialLayout()
      this.host._reportPanelSides(touched)
    }
    return { open: true, panelId: id, side: target }
  }

  /**
   * 开关面板。
   *
   * ── side 的语义（「打开它的入口」声明自己希望面板在哪一侧）────────────────
   *   · 带 side：rail 图标传自己那一侧；导航栏的面板按钮传它此刻住哪（在顶部导航栏
   *     时靠右，随工具按钮行借住到标签侧栏时就是侧栏那一侧）。
   *     该侧已经有它 → 关掉；该侧是别的面板 / 空着 → 换成它。
   *   · 不带 side：面板自己的关闭按钮 —— 纯开关，把该面板从它所在的位关掉。
   *
   * 「同一个面板只留一份」由 _placePanel 保证：它若正占着另一侧，那一位会被清空
   * （表现就是"挪过去"），而不是在两边各显示一份。
   *
   * @param {string} panelId
   * @param {{ side?: 'left'|'right' }} [opts]
   * @returns {{ open: boolean, panelId: string, side: 'left'|'right' }}
   */
  togglePanel(panelId: string, opts: PanelOptions = {}): unknown {
    const id = String(panelId)
    const requested = opts && (opts.side === 'left' || opts.side === 'right') ? opts.side : null
    // 不带 side = 纯开关：它现在在哪一侧就关哪一侧（面板自己的关闭按钮走这条）
    if (requested === null) {
      const current = this.host.getPanelSideOf(id)
      if (current) {
        // ⚠ 只关**这一块**（不是 hidePanel(那一侧)）：同侧可能还钉着另一块常驻面板。
        this.host.closePanel(id)
        return { open: false, panelId: id, side: current }
      }
      const fallback = this.host._normalizePanelSide(null)
      this.host.showPanel(id, fallback)
      return { open: true, panelId: id, side: fallback }
    }
    const target = requested
    // 目标面板钉在这一侧 → 它已经在屏上且不受切换影响：点击 rail 图标不改任何东西
    //（要关它请用面板自己的 ✕，要放开钉住请用图钉按钮）。
    if (this.host._panelPinned[target] === id) {
      return { open: true, panelId: id, side: target }
    }
    if (this.host._panelSlots[target] === id) {
      this.host.closePanel(id)
      return { open: false, panelId: id, side: target }
    }
    this.host.switchPanel(id, target)
    return { open: true, panelId: id, side: target }
  }


}

function installPanelLayoutController(host: PanelHost): PanelLayoutController {
  const controller = new PanelLayoutController(host)
  const hostRecord = host as unknown as Record<string, unknown>
  const controllerRecord = controller as unknown as Record<string, (...args: unknown[]) => unknown>
  for (const name of Object.getOwnPropertyNames(PanelLayoutController.prototype)) {
    if (name === "constructor") continue
    const method = controllerRecord[name]
    if (method) hostRecord[name] = method.bind(controller)
  }
  return controller
}

export { installPanelLayoutController, PanelLayoutController }
