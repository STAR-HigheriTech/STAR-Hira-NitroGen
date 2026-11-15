// @ts-check
/**
 * 垂直标签栏的**宿主骨架与形态机** —— 四段骨架 + 固定钮 + 调宽把手 + 「图标条 / 展开」两态。
 *
 * 它**完全不认识「标签」**：不 import 任何标签件、不知道标签投影是什么形状、
 * 也不知道右键菜单与拖拽落库。它只回答三件事：
 *   1. 造出侧栏的四段容器（顶部槽 / 列表体 / 面板行 / 底部槽）并把槽位交出去，
 *      连同那颗「固定 / 悬停展开」按钮一起（`slots.pin`）；
 *   2. 维护「此刻是图标条还是展开态」这一个形态（含调宽把手）；
 *   3. 那颗「固定 / 悬停展开」按钮的**外观**（点下去要做什么由外面接线）。
 *
 * ── 固定钮为什么不自己占一行 ─────────────────────────────────────────────
 * 它必须和空间切换器**同一行**（用户口径：固定按钮是那一行的第二件东西，不是独立一条）。
 * 而"住哪一行"取决于布局（Edge 型 → 侧栏顶部槽；全功能侧栏 → 侧栏标题行）——
 * 那是 ui-navbar#row/sideColumnPlan 的落点职责，不是本模块的。所以这里只造**按钮本身**
 * 并从 `slots.pin` 交出去，绝不 `appendChild` 到自己身上：一份节点、一次落点决策。
 *
 * ── 「悬停展开」的边界 ──────────────────────────────────────────────────
 * 本模块只负责**占位态与形态**：宽度由侧栏容器按计划给（见 shared-types#planChromeLayout
 * 的 `restWidth / revealWidth / revealOverlay`）。
 *
 * 自动隐藏有两型，判据只有计划里的 `revealOverlay` 一个：
 *   · **Edge 型（true）** → 静止就是本条侧栏画成图标 rail（照常占位 56px），
 *     展开是一条**覆盖网页的独立浮层**（主进程 WebContentsView `sidebar-float`）；
 *   · **全功能型（false）** → 静止宽 0（网页铺满），唤出时这条侧栏自己变宽、推挤网页。
 * 谁是"贴着边缘"由主进程巡看（它拿得到屏幕坐标），本模块不知道、也不需要知道；
 * 它只按 `collapsed` 把按钮与形态画出来。
 *
 * 为什么有四段内容槽而不是三段：全功能侧栏（tabbar 与 navbar 同在侧栏）里，导航栏块住在
 * 标签列表**上方**，而面板按钮（下载 / 历史 / 书签 / 插件）语义上属于「列表之下、
 * 底行之上」那一条工具行 —— 它必须落在本块内部才在正确的位置上。本模块因此开一个
 * **空槽** `dock`：谁搬进来、搬不搬，全是外面的事（见 ui-navbar#row/sideDock）。
 * 空着时这一行彻底不占位（Edge 型垂直标签下导航栏在顶部，这一槽永远空）。
 *
 * 为什么与标签列表分开：这两半能独立换掉 ——
 *   · 换骨架（例：浮出卡片型侧栏、双列标签板）不动标签列表一行；
 *   · 换列表（例：网格型固定标签、标签树）不动骨架与把手一行。
 * 装配由 `index.js` 负责（把标签列表的 element 放进 `slots.body`）。
 *
 * 尺寸口径（与 docs/vertical-tabs-design.md §3.1 同源）：
 *   · 宽度由侧栏容器给（--ng-side-width），本模块只负责铺满；
 *   · 行高、圆角、字号、图标尺寸全部沿用 tabbar / 面板的既有 token ——
 *     同一个标签在横向与纵向下「看起来一样」，跨模式切换不跳。
 */

import { createStripScroller } from '@hira-ng/ui-common'

export interface VtabsWidthRange {
  min?: number
  max?: number
  default?: number
}

export interface VtabsHostOptions {
  widthRange?: VtabsWidthRange
  onResize?: (width: number) => void
  onResizeStart?: () => void
  onResizeEnd?: () => void
  onTogglePin?: () => void
}

export interface VtabsHostSlots {
  readonly pin: HTMLButtonElement
  readonly top: HTMLElement
  readonly body: HTMLElement
  readonly dock: HTMLElement
  readonly bottom: HTMLElement
}

export interface VtabsHostController {
  readonly element: HTMLElement
  readonly slots: VtabsHostSlots
  setCollapsed(collapsed: boolean): void
  setPinned(pinned: boolean): void
  isCollapsed(): boolean
  isPinned(): boolean
  dispose(): void
}

/**
 * @param {Document} doc
 * @param {{
 *   widthRange?: { min?: number, max?: number, default?: number },
 *   onResize?: (width: number) => void,
 *   onResizeStart?: () => void,
 *   onResizeEnd?: () => void,
 *   onTogglePin?: () => void
 * }} [ctx] 只吃**端口**（拖宽区间 / 落库回调 / 固定切换）；不认识任何标签客户端。
 * @returns {{
 *   element: HTMLElement,
 *   slots: { pin: HTMLElement, top: HTMLElement, body: HTMLElement, dock: HTMLElement, bottom: HTMLElement },
 *   setCollapsed: (collapsed: boolean) => void,
 *   setPinned: (pinned: boolean) => void,
 *   isCollapsed: () => boolean,
 *   isPinned: () => boolean,
 *   dispose: () => void
 * }}
 */
export function createVtabsHost(doc: Document, ctx: VtabsHostOptions = {}): VtabsHostController {
  const host = doc.createElement('div')
  host.className = 'vtabs'
  host.id = 'vertical-tabs'
  host.dataset.collapsed = 'false'

  /**
   * 固定钮：**固定 ↔ 悬停展开**。它不在本骨架里占行（见文件头）—— 由 `slots.pin` 交出，
   * 落点跟着空间切换器走（ui-navbar#row/sideColumnPlan）。
   *
   * `#vertical-tabs-pin` 这个 id 挂**按钮自己**：无论它此刻住在侧栏顶部槽还是侧栏标题行，
   * 都是同一颗、同一个选择器。
   */
  const pinBtn = doc.createElement('button')
  pinBtn.type = 'button'
  pinBtn.className = 'vtabs__pin-btn'
  pinBtn.id = 'vertical-tabs-pin'
  pinBtn.dataset.collapsed = 'false'
  // 图标只有一份（推钉），状态靠 data-pinned 换色 / 换提示语 —— 不做两套 DOM 切换。
  pinBtn.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 17v5"/><path d="M9 10.76a2 2 0 0 1-1.11 1.79l-1.78.9A2 2 0 0 0 5 15.24V16a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1v-.76a2 2 0 0 0-1.11-1.79l-1.78-.9A2 2 0 0 1 15 10.76V7a1 1 0 0 1 1-1 2 2 0 0 0 0-4H8a2 2 0 0 0 0 4 1 1 0 0 1 1 1z"/></svg>'

  const top = doc.createElement('div')
  top.className = 'vtabs__top'
  top.id = 'vertical-tabs-top'

  const body = doc.createElement('div')
  body.className = 'vtabs__body'
  body.id = 'vertical-tabs-body'
  // 滚动区：**与横向标签条共用**的那一份实现（竖轴可滚 / 横轴彻底禁滚 / 滚动条外观 /
  // 滚轮换算），本组件只交出「我是纵向条」这一个参数 —— 见 @hira-ng/ui-common#stripScroller。
  createStripScroller(body, 'y')

  // 面板行（借位槽，见文件头注释）：一个**空容器**，本模块不知道谁住进来。
  const dock = doc.createElement('div')
  dock.className = 'vtabs__dock'
  dock.id = 'vertical-tabs-dock'

  const bottom = doc.createElement('div')
  bottom.className = 'vtabs__bottom'
  bottom.id = 'vertical-tabs-bottom'

  // 调宽把手（见 styles.js 注释）。拖动期间只改一个 CSS 变量（跟手、不落库、不走计划）；
  // 松手才把最终宽度交给宿主落库（本模块不认识设置通道 / IPC）。
  // 它只在**占位态**有意义：图标条（折叠态）下没有任何可调宽度，故 CSS 里隐藏。
  const handle = doc.createElement('div')
  handle.className = 'vtabs__handle'
  handle.id = 'vertical-tabs-handle'

  const range = ctx.widthRange || {}
  const minWidth = Number(range.min) > 0 ? Number(range.min) : 150
  const maxWidth = Number(range.max) > 0 ? Number(range.max) : 500
  const defaultWidth = Number(range.default) > 0 ? Number(range.default) : 200

  /** 用户显式折叠（设置项 app.sidebar_collapsed）。 */
  let collapsed = false
  /** 侧栏是否**固定**（`app.sidebar_visibility = attached`；false = 悬停展开）。 */
  let pinned = true
  /** 拖动状态；null = 没在拖。 */
  interface DragState {
    startX: number
    startWidth: number
    width: number
  }
  let dragState: DragState | null = null

  host.appendChild(top)
  host.appendChild(body)
  host.appendChild(dock)
  host.appendChild(bottom)
  host.appendChild(handle)

  /** 此刻是不是图标条（用户手动折叠）。 */
  function isIconOnly() {
    return collapsed
  }

  /** 侧栏贴左时「往右拖 = 变宽」；贴右时反过来。 */
  function dragSign() {
    return host.dataset.regionSide === 'right' ? -1 : 1
  }

  function clampWidth(px: number) {
    return Math.min(maxWidth, Math.max(minWidth, Math.round(px)))
  }

  /**
   * 宽度临时变量写到**本组件住的那只盒子**（侧栏容器）上，而不是 documentElement。
   *
   * 为什么：`--ng-side-drag-width` 是**继承属性** —— 写在根元素上时每改一次都要求
   * 整棵文档重算样式（拖拽期每帧一次，这就是"卡顿不跟手"的大头）；写在容器自己身上，
   * 失效范围收缩到「本来就要重排的侧栏子树」。语义一字不差：容器的宽度表达式
   * `width: var(--ng-side-drag-width, …)` 就声明在容器自己身上，自定义属性在**声明它的
   * 元素自身**上当然可见（见 ui-chrome-layout 的 #chrome-side）。
   * 未挂载（parentElement 为空）时退化到 documentElement —— 只在极早期发生。
   */
  function widthVarTarget() {
    return host.parentElement || doc.documentElement
  }

  /**
   * 计划里的**占位宽度**（容器读的那只 `--ng-side-width`，由布局控制器写入）。
   * 自定义属性可继承，所以从本组件住的盒子就能读到，不必认识谁写的它。
   * @returns {number|null}
   */
  function readPlannedWidth() : number|null {
    const el = host.parentElement
    if (!el || typeof getComputedStyle !== 'function') return null
    const raw = getComputedStyle(el).getPropertyValue('--ng-side-width')
    const n = parseFloat(raw)
    return Number.isFinite(n) ? Math.round(n) : null
  }

  /** 拖拽期的待写宽度与合帧句柄（见 pointermove）。 */
  let pendingWidth = 0
  let dragFrame = 0
  /** 交棒期的帧句柄（见 handoffDragWidth）。 */
  let handoffFrame = 0
  /** 调宽期间冻结 hover 巡看；直到新宽度进入计划后才释放。 */
  let resizeHeld = false

  function beginResizeHold() {
    if (resizeHeld) return
    resizeHeld = true
    try { if (typeof ctx.onResizeStart === 'function') ctx.onResizeStart() } catch (_) {}
  }

  function endResizeHold() {
    if (!resizeHeld) return
    resizeHeld = false
    try { if (typeof ctx.onResizeEnd === 'function') ctx.onResizeEnd() } catch (_) {}
  }

  function applyDragWidth() {
    dragFrame = 0
    if (!pendingWidth) return
    // 宽度只有这一份投影：写到侧栏容器自己的 --ng-side-drag-width 上就地生效
    // （拖拽期每帧一次，失效范围只在本列子树内）。
    widthVarTarget().style.setProperty('--ng-side-drag-width', `${pendingWidth}px`)
  }

  function clearDragWidth() {
    widthVarTarget().style.removeProperty('--ng-side-drag-width')
  }

  /**
   * 松手后的**交棒**：临时宽度继续生效，直到计划把正式宽度写成同一个值再清掉。
   *
   * 为什么不能立刻清：清掉那一刻容器回到**计划里的旧宽度**，而新宽度要先落库、
   * 再由布局控制器灌回计划 —— 中间隔着一两个 IPC 往返。于是松手会看到「弹回旧宽度、
   * 下一帧又跳回新宽度」两下闪动（"不跟手"的最后一下）。等计划追上再清，视觉是一条直线。
   * 上限 30 帧兜底：万一这次宽度没被计划采纳（被夹取 / 被拒），也不能让临时值长期压着计划。
   */
  function handoffDragWidth(width: number) {
    if (handoffFrame) return
    let tries = 0
    const step = () => {
      handoffFrame = 0
      if (dragState) return // 又开拖了 → 保持 hold，交给新一轮收尾
      if (readPlannedWidth() === width || ++tries > 30) {
        clearDragWidth()
        endResizeHold()
        return
      }
      handoffFrame = requestAnimationFrame(step)
    }
    handoffFrame = requestAnimationFrame(step)
  }

  /**
   * 收尾。`opts === true` = **立刻**清临时宽度（折叠 / 形态切换 / 卸载用）——
   * 这些场景必须马上按新计划的宽度走，绝不能留临时值压着（见 handoffDragWidth）。
   */
  function endDrag(opts?: boolean) {
    if (!dragState) return
    const width = dragState.width
    dragState = null
    handle.dataset.dragging = 'false'
    if (dragFrame) { cancelAnimationFrame(dragFrame); dragFrame = 0 }
    if (handoffFrame) { cancelAnimationFrame(handoffFrame); handoffFrame = 0 }
    pendingWidth = 0
    if (width && typeof ctx.onResize === 'function') {
      try { ctx.onResize(width) } catch (_) {}
    }
    if (width && opts !== true) handoffDragWidth(width)
    else {
      clearDragWidth()
      endResizeHold()
    }
  }

  handle.addEventListener('pointerdown', (e: PointerEvent) => {
    // 只有固定 / 常驻侧栏允许调宽；hover 展开态由主进程巡看控制，
    // 此时拖宽会与保持圈互相抢占。
    if (!pinned || isIconOnly()) return
    e.preventDefault()
    beginResizeHold()
    if (handoffFrame) { cancelAnimationFrame(handoffFrame); handoffFrame = 0 }
    dragState = {
      // ⚠ 屏幕坐标，不是 clientX：侧栏贴右时 `.vtabs` 自己会随宽度往左长，而把手贴的是
      // 它的**内缘**（left:0）—— 把手跟着指针一起跑，指针在视图内的位移恒接近 0，
      // 算出来的 delta 只在原点附近来回微调（抖动 + 每帧重设宽度的残影）。
      // 屏幕坐标与视图无关，两侧都稳。同一条教训见 panels/main.js 的面板把手。
      startX: e.screenX,
      startWidth: Math.round(host.getBoundingClientRect().width) || defaultWidth,
      width: 0
    }
    handle.dataset.dragging = 'true'
    try { handle.setPointerCapture(e.pointerId) } catch (_) {}
  })

  handle.addEventListener('pointermove', (e: PointerEvent) => {
    if (!dragState) return
    const delta = (e.screenX - dragState.startX) * dragSign()
    const next = clampWidth(dragState.startWidth + delta)
    dragState.width = next
    // 每帧最多写一次：pointermove 的频率远高于一帧（高回报率鼠标可达数百 Hz），
    // 逐条写变量＝逐条标脏样式。合帧后与屏幕刷新同频 —— 与面板把手同一套做法。
    pendingWidth = next
    if (!dragFrame) dragFrame = requestAnimationFrame(applyDragWidth)
  })

  handle.addEventListener('pointerup', () => endDrag())
  handle.addEventListener('pointercancel', () => endDrag())
  handle.addEventListener('lostpointercapture', () => endDrag())
  // 双击把手 = 恢复默认宽度（与「双击分隔条复位」的通行做法一致）
  handle.addEventListener('dblclick', () => {
    if (!pinned || isIconOnly()) return
    if (typeof ctx.onResize === 'function') ctx.onResize(defaultWidth)
  })

  /**
   * 同步形态：窄条有两个来源 —— 用户显式折叠，或 Edge 型自动隐藏的静止态（计划
   * `revealOverlay === true`，此刻本条侧栏就是那条常驻 rail）。
   *
   * 两者都由编排层折成这一个输入（`collapsed || revealOverlay`，见 app-shell）：
   * 本模块只认 `collapsed`，不读设置、不判形态。
   *
   * 形态标记除了打在骨架上，也打在**固定钮自己**身上（`data-collapsed`）：
   * 它随时可能被搬到侧栏标题行（祖先不是 `.vtabs`），尺寸收窄只该看它自己的状态，
   * 不能依赖"祖先是不是 .vtabs[data-collapsed]"（那条路一走，全功能侧栏折叠下就失效）。
   */
  function syncVisual() {
    const want = isIconOnly() ? 'true' : 'false'
    if (host.dataset.collapsed !== want) host.dataset.collapsed = want
    if (pinBtn.dataset.collapsed !== want) pinBtn.dataset.collapsed = want
  }

  /** 把固定态画到按钮上（唯一一份：图标不变，只换颜色 / 提示语 / 无障碍状态）。 */
  function renderPin() {
    host.dataset.pinned = pinned ? 'true' : 'false'
    pinBtn.dataset.pinned = pinned ? 'true' : 'false'
    const label = pinned ? '侧栏已固定，点击改为悬停展开' : '悬停展开中，点击固定侧栏'
    pinBtn.title = label
    pinBtn.setAttribute('aria-label', label)
    pinBtn.setAttribute('aria-pressed', pinned ? 'true' : 'false')
  }

  // 按钮只负责"被点了"；固定 ↔ 悬停 的落库由外面接线（ctx.onTogglePin）——
  // 本模块不认识设置通道，也不决定哪种布局该怎么响应。
  pinBtn.addEventListener('click', () => {
    if (typeof ctx.onTogglePin === 'function') ctx.onTogglePin()
  })

  renderPin()

  return {
    element: host,
    // pin 是**独立节点**（不挂在 host 里）：落点由 ui-navbar#row/sideColumnPlan 与
    // 空间切换器同一行安置。因此 dispose 必须显式把它摘掉（见下）。
    slots: { pin: pinBtn, top, body, dock, bottom },

    /** 折叠为图标条 / 展开。宽度由侧栏容器按计划给，这里只切形态。 */
    setCollapsed(next: boolean) {
      const on = next === true
      if (on === collapsed) return
      collapsed = on
      // 折叠时若正在拖动 → 收尾，避免把折叠宽度写进设置；
      // 且要**立刻**丢掉临时宽度，否则折叠后的窄条会被它压住（见 endDrag）。
      if (on) endDrag(true)
      syncVisual()
    },

    /**
     * 固定 / 悬停展开（`plan.side.visibility === 'attached'` 即固定）。
     *
     * 这个形态只影响**侧栏的宽度口径**（静止 0 ↔ 用户宽度），由侧栏容器按计划落；
     * 本模块只把按钮状态画对，不做任何宽度/显隐的动作。
     * @param {boolean} next
     */
    setPinned(next: boolean) {
      const on = next === true
      if (on === pinned) return
      pinned = on
      // 从悬停态改为固定 → 正在拖的宽度按新形态立即收尾（见 endDrag）。
      if (on) endDrag(true)
      renderPin()
    },

    isCollapsed: () => collapsed,
    isPinned: () => pinned,

    dispose() {
      endDrag(true)
      // pin 可能住在侧栏标题行 / 顶部槽（不在 host 子树里），单独摘掉。
      pinBtn.remove()
      host.remove()
    }
  }
}
