/**
 * web-sidebar-surface.js —— 独立侧栏**聚焦框**的外壳渲染点。
 *
 * ── 它是什么 ────────────────────────────────────────────────────────
 * 侧栏成为"活动面"（用户点了侧栏里的网页、键盘操作此刻落在它身上）时，在它四周画一圈
 * 淡蓝框 —— 与分屏的活动格淡蓝框（`.split-pane-frame`）**同一视觉语言、同一原理**：
 * 网页 view 只占"槽矩形收进 gap 之后"的部分，那一圈没有任何网页覆盖，外壳 DOM 画得上。
 * （框的实现在这里独立一份，而不是塞进 split-surface —— 侧栏与分屏是两套平行系统，
 *   只是**长得一样**，不该为了省十行代码把两者的生命周期焊在一起。）
 *
 * ── 框为什么能一眼说明"Ctrl+F 会搜谁" ───────────────────────────────
 * 主进程的「活动面」是显式状态（`LayoutCoordinator#_webSidebarActive`，见那里的注释）：
 * 框亮着 = 查找 / 缩放 / 悬停 URL 的靶子就是侧栏；框熄着 = 靶子是标签页。
 * 于是"谁持焦"不再是一个看不见的内部判断，而是屏幕上看得见的事实。
 *
 * ── 几何从哪来 ──────────────────────────────────────────────────────
 * 主进程推 `web-sidebar:changed`（窗口级），载荷是**窗口内容区坐标**下的矩形与 gap；
 * 挂载时先主动拉一次 `layout:web-sidebar-geometry`（推送首帧可能早于订阅）。
 *
 * ── 顺带还画**调宽把手** ────────────────────────────────────────────
 * 侧栏的宽度原先只能在顶条那 32px 里那一小条 6px 上拖（用户找不到、也抓不稳）。
 * 网页是**别人的网页**，我们没法在它身上挂 DOM —— 但"侧栏内容 ↔ 网页"之间那道缝里
 * 没有任何网页 view，chrome 的 DOM 在那里既可见、也天然收得到指针事件
 *（与分屏分隔条完全同一条道理）。于是把手就画在那里，竖跨整个槽高：
 * **整条边都能拖**，这才是用户对"调宽"的预期。矩形由主进程给（只有它知道那两个矩形）。
 *
 * 本模块不认识标签、不认识侧栏业务 —— 只吃"矩形 + 一个布尔"，吐 DOM。
 */

const STYLE_ID = 'hira-web-sidebar-surface-styles'

interface SidebarRect { x: number; y: number; width: number; height: number }
interface SidebarGeometry {
  active: boolean
  rect?: SidebarRect
  radius?: number
  line?: number
  focused?: boolean
  handle?: SidebarRect
  side?: 'left' | 'right'
  width?: number
}
interface WebSidebarSurfacePorts {
  getGeometry(): Promise<unknown> | unknown
  onChanged(listener: (geometry: unknown) => void): () => void
  /** 拖动中的宽度（单向热路径）。 */
  onResizeLive?(width: number): void
  /** 松手后的最终宽度（需要落库 / 返回值时使用）。 */
  onResize?(width: number): void
}
export interface WebSidebarSurfaceController {
  element: HTMLElement
  setGeometry(geometry: unknown): void
  dispose(): void
}

interface SidebarResizeDrag { pointerId: number; x: number; width: number; side: 'left' | 'right' }

/**
 * @param {Document} doc
 * @param {HTMLElement} root 外壳根（`#chrome-root`）—— 框按它的矩形做坐标换算
 * @param {{
 *   getGeometry: () => Promise<unknown>,
 *   onChanged: (fn: (g:unknown)=>void) => () => void,
 *   onResizeLive?: (width: number) => void,
 *   onResize?: (width: number) => void
 * }} ports
 *   `onResizeLive` 每个 rAF 最多一次（单向）；`onResize` 只在松手时一次（最终确认）。
 *   两者收到的都是**新宽度绝对值**（不是增量）：区间校验（200~600）留在主进程，
 *   渲染层不持有第二份判据。
 * @returns {{ setGeometry: (g:unknown) => void, dispose: () => void, element: HTMLElement }}
 */
export function createWebSidebarSurface(
  doc: Document,
  root: HTMLElement,
  ports: WebSidebarSurfacePorts
): WebSidebarSurfaceController {
  if (!doc || !root) throw new Error('createWebSidebarSurface: doc 与 root 必填')

  const onResizeLive = typeof ports.onResizeLive === 'function'
    ? ports.onResizeLive
    : (typeof ports.onResize === 'function' ? ports.onResize : () => {})
  const onResizeCommit = typeof ports.onResize === 'function' ? ports.onResize : () => {}

  if (!doc.getElementById(STYLE_ID)) {
    const style = doc.createElement('style')
    style.id = STYLE_ID
    style.textContent = `
      /* 侧栏聚焦框层：铺满外壳根、**默认不吃指针**（框只是指示，不该拦任何点击）。
         框与落位预览都画在窗口内容区之内（框贴着侧栏槽的内沿），所以可以放心裁边。 */
      #web-sidebar-layer {
        position: absolute;
        inset: 0;
        pointer-events: none;
        overflow: hidden;
      }
      /* 活动面淡蓝框 —— 与 .split-pane-frame 同款（同一变量、同一过渡时长）。
         ⚠ 颜色**只能**用 --hira-split-focus-ring：它是颜色令牌。
         --hira-focus-ring 是 **box-shadow 列表**（0 0 0 2px rgba(...)），拿它当
         border-color / background 的颜色是「计算值非法」—— 该属性直接落回 initial
         （边框变 currentColor、背景变 transparent），且**不报错**。见下面把手的注释。 */
      .web-sidebar-frame {
        position: absolute;
        box-sizing: border-box;
        pointer-events: none;
        border-style: solid;
        border-color: var(--hira-split-focus-ring, rgba(74, 158, 255, 0.9));
        opacity: 0;
        transition: opacity 120ms ease;
        z-index: 0;
      }
      .web-sidebar-frame.is-active { opacity: 1; }
      /* 调宽把手：落在"侧栏内容 ↔ 网页"之间那道缝里（矩形由主进程给）。
         图层默认不吃指针，只有它自己 auto —— 根级图层若默认吃指针，一次写坏就是
         "整个浏览器点不动"（与 #split-layer 同一条纪律）。 */
      .web-sidebar-resize {
        position: absolute;
        pointer-events: auto;
        cursor: col-resize;
        background: transparent;
        /* 要压在别的装饰之上，指针才抓得到（语义层 elevated） */
        z-index: var(--hira-z-elevated);
        -webkit-app-region: no-drag;
      }
      /* 高亮线画在**贴内容块那一侧**：拉起来才像在拉网页的边，而不是另一侧那条框。
         平时完全不上色（静默），悬停 / 拖动才亮 —— 侧栏边上不该常挂一条装饰线。

         ⚠ 颜色令牌只能用 --hira-split-focus-ring（真·颜色，与分屏聚焦框同一个）：
         --hira-focus-ring 是 **box-shadow 列表**（0 0 0 2px rgba(...)），拿它当
         background 的颜色会用「计算值非法」→ 落回 initial（transparent），
         **不报错、也不显示**。这条线"死活不显示、怎么调透明度都没用"的真因就在这。 */
      .web-sidebar-resize::after {
        content: '';
        position: absolute;
        top: 0;
        bottom: 0;
        width: 2px;
        border-radius: 1px;
        background: transparent;
        transition: background-color 120ms ease;
      }
      /* 侧栏在左 → 内容块在缝的左边 → 线贴把手的左边；侧栏在右则相反。 */
      .web-sidebar-resize.is-left::after { left: 0; }
      .web-sidebar-resize.is-right::after { right: 0; }
      /* 与聚焦框**同一个颜色**：两者说的是同一件事（"这是侧栏的边"） */
      .web-sidebar-resize:hover::after,
      .web-sidebar-resize.is-dragging::after {
        background: var(--hira-split-focus-ring, rgba(74, 158, 255, 0.9));
      }
      @media (prefers-reduced-motion: reduce) {
        .web-sidebar-frame { transition: none; }
        .web-sidebar-resize::after { transition: none; }
      }
    `
    doc.head.appendChild(style)
  }

  const layer = doc.createElement('div')
  layer.id = 'web-sidebar-layer'
  root.appendChild(layer)

  const frame = doc.createElement('div')
  frame.className = 'web-sidebar-frame'
  frame.hidden = true
  layer.appendChild(frame)

  // ── 调宽把手 ─────────────────────────────────────────────────────────
  const resize = doc.createElement('div')
  resize.className = 'web-sidebar-resize is-left'
  resize.hidden = true
  resize.title = '拖动调整侧栏宽度'
  // `touch-action: none` 让指针事件逐帧到达（不用手写节流）——与顶条那条把手同一口径
  resize.style.touchAction = 'none'
  layer.appendChild(resize)

  /** 拖拽起点；null = 没在拖。基准宽度取**主进程给的当前值**（不是自己记的）。 */
  let resizeDrag: SidebarResizeDrag | null = null
  /** 合帧：pointermove 只记值，一帧写一次（理由同顶条那条把手：逐事件发 IPC 会一顿一顿）。 */
  let pendingWidth: number | null = null
  let lastLiveWidth: number | null = null
  let resizeRaf = 0
  function flushResize(): void {
    resizeRaf = 0
    if (pendingWidth === null) return
    const next = pendingWidth
    pendingWidth = null
    if (next === lastLiveWidth) return
    lastLiveWidth = next
    onResizeLive(next)
  }

  resize.addEventListener('pointerdown', (event: PointerEvent) => {
    const e = event
    if (e.button !== 0) return
    const g: SidebarGeometry = geometry
    if (!g.active || !g.handle) return
    // 别让这一下冒到外壳（外壳在侧栏边缘一带还有别的指针语义）
    e.preventDefault()
    e.stopPropagation()
    resizeDrag = {
      pointerId: e.pointerId,
      x: e.screenX,
      width: Number(g.width) || 0,
      side: g.side === 'right' ? 'right' : 'left'
    }
    resize.classList.add('is-dragging')
    try { doc.body.style.cursor = 'col-resize' } catch (_) {}
    // 拖拽期间禁掉文本选择：外壳 DOM 上拖过文字会留下高亮，看起来像选中了半个界面
    try { doc.body.style.userSelect = 'none' } catch (_) {}
    try { resize.setPointerCapture(e.pointerId) } catch (_) {}
  })

  resize.addEventListener('pointermove', (e) => {
    if (!resizeDrag || e.pointerId !== resizeDrag.pointerId) return
    // 侧栏在左 → 往右拖变宽；在右 → 往左拖变宽。用 `screenX`：它不受页面滚动/缩放影响，
    // 而 `clientX` 在本视图坐标系里（拖到别的视图上就不再增长）。
    const dx = e.screenX - resizeDrag.x
    pendingWidth = resizeDrag.side === 'right' ? resizeDrag.width - dx : resizeDrag.width + dx
    if (!resizeRaf) resizeRaf = requestAnimationFrame(flushResize)
  })

  const endResize = (event?: PointerEvent): void => {
    if (!resizeDrag || (event && event.pointerId !== resizeDrag.pointerId)) return
    resizeDrag = null
    // 松手补最后一拍：rAF 里那次可能还没跑，丢掉它宽度会停在上一次的位置。
    if (resizeRaf) { cancelAnimationFrame(resizeRaf); resizeRaf = 0 }
    const finalWidth = pendingWidth ?? lastLiveWidth
    pendingWidth = null
    lastLiveWidth = null
    if (finalWidth !== null) onResizeCommit(finalWidth)
    resize.classList.remove('is-dragging')
    try { doc.body.style.cursor = '' } catch (_) {}
    try { doc.body.style.userSelect = '' } catch (_) {}
    try { if (event) resize.releasePointerCapture(event.pointerId) } catch (_) {}
  }
  resize.addEventListener('pointerup', endResize)
  resize.addEventListener('pointercancel', endResize)
  // 窗口失焦（Alt+Tab 切走）不会给 pointercancel —— 少了这一条，回来时光标与高亮还挂在
  // "正在拖"的状态上，下一次点击会被当成继续拖。
  const onWindowBlur = () => endResize()
  try { window.addEventListener('blur', onWindowBlur) } catch (_) {}

  function rootOffset() {
    try {
      const rect = root.getBoundingClientRect()
      return { x: rect.x || 0, y: rect.y || 0 }
    } catch (_) {
      return { x: 0, y: 0 }
    }
  }

  // 拖动调宽时主进程每帧回推几何；根原点不会因此变化，缓存后避免每帧强制布局读取。
  let rootOrigin = rootOffset()
  const view = doc.defaultView
  const onRootResize = (): void => {
    const next = rootOffset()
    if (next.x === rootOrigin.x && next.y === rootOrigin.y) return
    rootOrigin = next
    render()
  }
  try { view?.addEventListener('resize', onRootResize) } catch (_) {}

  /**
   * 把框摆到给定的**内容块矩形**上：框画在它外围让出的那一圈 `gap` 里，
   * 于是外圈半径 = 网页圆角 + gap（两者同心才不错位，与 split-surface 同一算法）。
   */
  function render(): void {
    if (!geometry || !geometry.active || !geometry.rect) {
      frame.hidden = true
      frame.classList.remove('is-active')
      resize.hidden = true
      return
    }
    const offset = rootOrigin
    const rect = geometry.rect
    const radius = Math.max(0, Number(geometry.radius) || 0)
    // 线宽由主进程下发（与**分屏活动格**同一条真源，见 SPLIT_METRICS.paneGap）
    const line = Math.max(1, Number(geometry.line) || 2)
    /**
     * 框 = **槽矩形本身**，线朝**内**画。
     *
     * 为什么不能向外扩：槽的外面紧挨着面板 / 底栏等**原生视图**（它们盖在 chrome DOM 之上），
     * 框只要越出槽一步，靠内那一侧与底部的线就被吃掉一角。
     * 线宽仍与分屏那道框一致（同一个 `line`），`radius` 由主进程给（= 网页圆角 + 呼吸空，同心）。
     */
    frame.style.borderWidth = `${line}px`
    frame.style.borderRadius = `${radius}px`
    frame.style.left = `${Math.round(rect.x - offset.x)}px`
    frame.style.top = `${Math.round(rect.y - offset.y)}px`
    frame.style.width = `${Math.round(rect.width)}px`
    frame.style.height = `${Math.round(rect.height)}px`
    frame.hidden = false
    frame.classList.toggle('is-active', geometry.focused === true)

    // 调宽把手：矩形完全由主进程给（只有它知道"内容块"与"网页"那两个矩形），
    // 这里只做 root 原点换算。宽高为 0 时藏起来（缝被呼吸空吃光 = 没地方可拖）。
    const handle = geometry.handle
    if (handle && handle.width > 0 && handle.height > 0) {
      const isRight = geometry.side === 'right'
      resize.hidden = false
      resize.classList.toggle('is-right', isRight)
      resize.classList.toggle('is-left', !isRight)
      resize.style.left = `${Math.round(handle.x - offset.x)}px`
      resize.style.top = `${Math.round(handle.y - offset.y)}px`
      resize.style.width = `${Math.round(handle.width)}px`
      resize.style.height = `${Math.round(handle.height)}px`
    } else {
      resize.hidden = true
    }
  }

  let geometry: SidebarGeometry = { active: false }

  let unsubscribe: (() => void) | null = null
  if (typeof ports.onChanged === 'function') {
    unsubscribe = ports.onChanged((payload) => setGeometry(payload))
  }
  // 挂载时主动拉一次：推送首帧可能早于订阅（外壳 renderer 启动晚于第一次布局）。
  if (typeof ports.getGeometry === 'function') {
    Promise.resolve(ports.getGeometry()).then((g) => setGeometry(g)).catch(() => {})
  }

  function setGeometry(next: unknown): void {
    const record = next !== null && typeof next === 'object' ? next as SidebarGeometry : null
    geometry = record?.active ? record : { active: false }
    render()
  }

  return {
    element: layer,
    setGeometry,
    dispose() {
      if (typeof unsubscribe === 'function') unsubscribe()
      unsubscribe = null
      if (resizeRaf) {
        cancelAnimationFrame(resizeRaf)
        resizeRaf = 0
      }
      try { window.removeEventListener('blur', onWindowBlur) } catch (_) {}
      try { view?.removeEventListener('resize', onRootResize) } catch (_) {}
      layer.remove()
    }
  }
}

