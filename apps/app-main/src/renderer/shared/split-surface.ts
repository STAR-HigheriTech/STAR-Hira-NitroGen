/**
 * 分屏分隔条（Split View dividers）—— 外壳侧的唯一渲染点。
 *
 * ── 为什么分隔条是**外壳的 DOM**，而不是独立原生视图 ──────────────────
 * 两格之间的那道缝（`divider` 像素）里**没有任何网页 view** —— 网页只占各自的格矩形，
 * 而容器 `View` 本身不绘制。于是：
 *   · 缝里露出的是 chrome（窗口本体）的背景 → 分隔条画在 chrome 里**天然可见**；
 *   · 缝里收到的是 chrome 的指针事件 → 分隔条**天然可交互**。
 * 无需再建一个 `/split-divider` 浮层视图，也就没有额外的渲染进程、图层与 IPC 家族。
 * （这也是本项目"网页是原生 WebContentsView、chrome 在它之下"这一模型的一个正面用法：
 *   凡是**不被网页覆盖**的区域，chrome 都拿得回来。）
 *
 * ── 几何从哪来 ────────────────────────────────────────────────────────
 * 主进程推 `split:changed`（窗口级），载荷是**窗口内容区坐标**下的格矩形与分隔条矩形
 * —— 与 `shared-types#split-layout` 那份求解器同源。挂载时先主动拉一次
 * `layout:split-geometry`（推送首帧可能早于订阅）。
 *
 * ── 拖拽为什么跟手 ────────────────────────────────────────────────────
 * 指针事件用 `setPointerCapture` 捕获：指针移出 6px 的细条也不会丢事件。
 * 拖动期间**本地即时移动**被拖那一条（不等 IPC 往返），同时按 rAF 把最新位置交给主进程
 * 重算比例并重排格；主进程回推的新几何不再覆盖正在拖的那一条（避免一帧抖动）。
 *
 * 本模块不认识标签、不认识分屏业务 —— 只吃"矩形 + 轴"，吐 DOM 与一个 IPC 调用。
 */

const SPLIT_SURFACE_STYLE_ID = 'hira-split-surface-styles'

type SplitAxis = 'x' | 'y'
interface SplitRect { x: number; y: number; width: number; height: number }
interface SplitDivider extends SplitRect { index: number; axis: SplitAxis }
interface SplitGeometry {
  active: boolean
  dividers?: SplitDivider[]
  panes?: SplitRect[]
  members?: Array<string | null | undefined>
  gap?: number
  radius?: number
  activeTabId?: string | null
  splitId?: string
}
interface SplitSurfacePorts {
  dragDivider(payload: { index: number; axis: SplitAxis; position: number }): Promise<unknown> | unknown
  /** 拖动帧的单向通道；缺失时退回 `dragDivider`（保持兼容）。 */
  dragDividerLive?(payload: { index: number; axis: SplitAxis; position: number }): void
  setRatioPreset(splitId: string, preset: string): Promise<unknown> | unknown
  getGeometry(): Promise<unknown> | unknown
  onChanged(listener: (geometry: unknown) => void): () => void
}
export interface SplitSurfaceController {
  element: HTMLElement
  setGeometry(geometry: unknown): void
  dispose(): void
}

interface DividerDrag {
  key: string
  index: number
  axis: SplitAxis
  el: HTMLElement
  rafId: number | null
  lastPos: number | null
  lastSentPos: number | null
  origin: { x: number; y: number }
}

/**
 * @param {Document} doc
 * @param {HTMLElement} root 外壳根（`#chrome-root`）—— 分隔条按它的矩形做坐标换算
 * @param {{ dragDivider: (payload: {index:number, axis:'x'|'y', position:number}) => Promise<unknown>,
 *           setRatioPreset: (splitId: string, preset: string) => Promise<unknown>,
 *           getGeometry: () => Promise<unknown>, onChanged: (fn: (g:unknown)=>void) => () => void }} ports
 * @returns {{ setGeometry: (g:unknown) => void, dispose: () => void, element: HTMLElement }}
 */
export function createSplitSurface(doc: Document, root: HTMLElement, ports: SplitSurfacePorts): SplitSurfaceController {
  if (!doc || !root) throw new Error('createSplitSurface: doc 与 root 必填')

  // 样式只注入一次（幂等）：分隔条本体透明、悬停显色；用 CSS 变量跟随主题。
  if (!doc.getElementById(SPLIT_SURFACE_STYLE_ID)) {
    const style = doc.createElement('style')
    style.id = SPLIT_SURFACE_STYLE_ID
    style.textContent = `
      /* 分屏层：铺满外壳根，**默认不吃指针**（只有分隔条自己 pointer-events:auto）。
         根级图层若默认吃指针，一次写坏就是"整个浏览器点不动"。 */
      #split-layer {
        position: absolute;
        inset: 0;
        pointer-events: none;
        overflow: hidden;
      }
      .split-divider {
        position: absolute;
        pointer-events: auto;
        background: transparent;
        transition: background-color 120ms ease;
        /* 可拖拽的分隔条：语义层 elevated（浮在格的淡蓝框之上，指针才抓得到） */
        z-index: var(--hira-z-elevated);
      }
      .split-divider[data-axis="x"] { cursor: col-resize; }
      .split-divider[data-axis="y"] { cursor: row-resize; }
      .split-divider:hover,
      .split-divider[data-dragging="true"] {
        background: color-mix(in srgb, var(--hira-accent, #3b82f6) 75%, transparent);
      }
      /* ── 活动格淡蓝框（Edge 同款）─────────────────────────────────────────
         框落在**每格让出的那圈空隙**里：网页 view 只占"格矩形收进 gap 后"的部分，
         所以那一圈没有任何网页覆盖，外壳 DOM 画得上（与分隔条同一原理）。
         几何恒定（gap 不变、切活动格不动任何 bounds）→ 换框只是一次类名切换。 */
      .split-pane-frame {
        position: absolute;
        box-sizing: border-box;
        pointer-events: none;
        border-style: solid;
        border-color: var(--hira-split-focus-ring, rgba(74, 158, 255, 0.9));
        opacity: 0;
        transition: opacity 120ms ease;
        z-index: 0;
      }
      .split-pane-frame.is-active { opacity: 1; }
    `
    doc.head.appendChild(style)
  }

  const layer = doc.createElement('div')
  layer.id = 'split-layer'
  root.appendChild(layer)

  /** 当前几何（窗口内容区坐标）。 */
  let geometry: SplitGeometry = { active: false }
  /** 每条分隔条的 DOM（按 index 复用，避免每次重排重建节点）。 */
  const dividerEls = new Map<string, HTMLElement>()
  /**
   * 每格「淡蓝框」的 DOM。按**成员 tabId** 复用（不是按 pane 下标）：
   * 成员进出组时，框不会在两个节点之间跳，少一次闪烁。
   */
  const frameEls = new Map<string, HTMLElement>()
  /** 拖拽状态：{ index, axis, el, rafId, lastPos } */
  let dragging: DividerDrag | null = null

  function rootOffset(): { x: number; y: number } {
    try {
      const rect = root.getBoundingClientRect()
      return { x: rect.x || 0, y: rect.y || 0 }
    } catch (_) {
      return { x: 0, y: 0 }
    }
  }

  // 外壳根是固定铺满视口的图层；拖动期间每帧重复 getBoundingClientRect 只会制造
  // 强制布局读取。缓存原点，只在窗口尺寸变化时刷新一次。
  let rootOrigin = rootOffset()
  const view = doc.defaultView
  const onRootResize = (): void => {
    const next = rootOffset()
    if (next.x === rootOrigin.x && next.y === rootOrigin.y) return
    rootOrigin = next
    render()
  }
  try { view?.addEventListener('resize', onRootResize) } catch (_) {}

  /** 把一条分隔条摆到给定的轴位置（拖拽中的即时跟手也走这里）。 */
  function placeDivider(
    el: HTMLElement,
    axis: SplitAxis,
    divider: SplitDivider,
    offset: { x: number; y: number },
    immediatePos?: number | null
  ): void {
    const x = axis === 'x' ? (immediatePos != null ? immediatePos : divider.x) : divider.x
    const y = axis === 'y' ? (immediatePos != null ? immediatePos : divider.y) : divider.y
    el.style.left = `${Math.round(x - offset.x)}px`
    el.style.top = `${Math.round(y - offset.y)}px`
    el.style.width = `${Math.round(divider.width)}px`
    el.style.height = `${Math.round(divider.height)}px`
  }

  function render(): void {
    const active = !!(geometry && geometry.active)
    if (!active) {
      if (layer.childElementCount) layer.textContent = ''
      dividerEls.clear()
      frameEls.clear()
      return
    }
    const offset = rootOrigin
    const dividers = Array.isArray(geometry.dividers) ? geometry.dividers : []
    const seen = new Set<string>()
    for (const divider of dividers) {
      const axis = divider.axis === 'y' ? 'y' : 'x'
      // 索引键要**同时**含轴：网格布局下 x 与 y 两族分隔条可能存在同号 index。
      const key = `${axis}:${divider.index}`
      seen.add(key)
      let el = dividerEls.get(key)
      if (!el) {
        el = doc.createElement('div')
        el.className = 'split-divider'
        el.dataset.axis = axis
        el.dataset.index = String(divider.index)
        el.style.width = `${Math.max(1, Math.round(divider.width))}px`
        el.style.height = `${Math.max(1, Math.round(divider.height))}px`
        bindDivider(el, axis, divider.index)
        layer.appendChild(el)
        dividerEls.set(key, el)
      }
      // 正在拖的那一条由本地即时位置驱动，不被回推的几何覆盖（否则会一帧抖动）。
      if (dragging && dragging.key === key) continue
      placeDivider(el, axis, divider, offset)
    }
    for (const [key, el] of Array.from(dividerEls)) {
      if (seen.has(key)) continue
      el.remove()
      dividerEls.delete(key)
    }
    renderPaneFrames(offset)
  }

  /**
   * 活动格淡蓝框（Edge 同款）。
   *
   * 框铺在**每格让出的那圈空隙**里（`gap`，见 SPLIT_METRICS.paneGap）：网页 view 只占
   * "格矩形收进 gap 之后"的部分，那一圈因此没有任何网页覆盖，外壳 DOM 画得上
   * —— 与分隔条是同一个原理，不需要额外开一个原生浮层视图。
   *
   * `gap` 与 `radius` 由主进程在载荷里给（主进程是几何与网页圆角的真源），
   * 渲染侧不自算 —— 否则"框比网页圆角方一点"这种偏差会两边各有一套值。
   */
  function renderPaneFrames(offset: { x: number; y: number }): void {
    const panes = Array.isArray(geometry.panes) ? geometry.panes : []
    const members = Array.isArray(geometry.members) ? geometry.members : []
    const gap = Math.max(1, Number(geometry.gap) || 2)
    const radius = Math.max(0, Number(geometry.radius) || 0)
    const activeId = geometry.activeTabId == null ? '' : String(geometry.activeTabId)
    const seen = new Set<string>()
    for (let i = 0; i < panes.length; i++) {
      const pane = panes[i]
      const memberId = members[i] == null ? '' : String(members[i])
      if (!pane || !memberId) continue
      seen.add(memberId)
      let el = frameEls.get(memberId)
      if (!el) {
        el = doc.createElement('div')
        el.className = 'split-pane-frame'
        layer.appendChild(el)
        frameEls.set(memberId, el)
      }
      el.style.borderWidth = `${gap}px`
      // 外圈半径 = 网页圆角 + 空隙，两者同心才不会看着错位
      el.style.borderRadius = `${radius + gap}px`
      el.style.left = `${Math.round(pane.x - gap - offset.x)}px`
      el.style.top = `${Math.round(pane.y - gap - offset.y)}px`
      el.style.width = `${Math.round(pane.width + gap * 2)}px`
      el.style.height = `${Math.round(pane.height + gap * 2)}px`
      el.classList.toggle('is-active', memberId === activeId)
    }
    for (const [key, el] of Array.from(frameEls)) {
      if (seen.has(key)) continue
      el.remove()
      frameEls.delete(key)
    }
  }

  function flushDrag(): void {
    if (!dragging) return
    dragging.rafId = null
    const pos = dragging.lastPos
    if (pos == null || pos === dragging.lastSentPos) return
    const current = (geometry.dividers || []).find(
      (d) => (d.axis === 'y' ? 'y' : 'x') === dragging!.axis && d.index === dragging!.index
    )
    if (!current) return
    // 一帧内只读一次已缓存的根原点、只写一次分隔条样式；pointermove 本身不再触发布局。
    placeDivider(dragging.el, dragging.axis, current, dragging.origin, pos)
    dragging.lastSentPos = pos
    const payload = { index: dragging.index, axis: dragging.axis, position: pos }
    if (typeof ports.dragDividerLive === 'function') {
      try { ports.dragDividerLive(payload) } catch (_) {}
      return
    }
    Promise.resolve(ports.dragDivider(payload)).catch(() => {})
  }

  function bindDivider(el: HTMLElement, axis: SplitAxis, index: number): void {
    el.addEventListener('pointerdown', (e) => {
      if (e.button !== 0) return
      e.preventDefault()
      e.stopPropagation()
      try { el.setPointerCapture(e.pointerId) } catch (_) {}
      el.dataset.dragging = 'true'
      const pos = axis === 'x' ? e.clientX : e.clientY
      dragging = {
        key: `${axis}:${index}`,
        index,
        axis,
        el,
        rafId: null,
        lastPos: pos,
        lastSentPos: null,
        origin: rootOrigin
      }
    })
    el.addEventListener('pointermove', (e) => {
      if (!dragging || dragging.el !== el) return
      const activeDrag = dragging
      // 指针在**窗口内容区坐标**里的位置：外壳 document 的视口原点就是内容区原点，
      // 因此 clientX/clientY 可直接用（主进程也按这套坐标算比例）。
      const pos = activeDrag.axis === 'x' ? e.clientX : e.clientY
      activeDrag.lastPos = pos
      if (activeDrag.rafId == null) activeDrag.rafId = requestAnimationFrame(flushDrag)
    })
    const end = (): void => {
      if (!dragging || dragging.el !== el) return
      if (dragging.rafId != null) {
        cancelAnimationFrame(dragging.rafId)
        dragging.rafId = null
      }
      const pos = dragging.lastPos
      const current = pos == null ? null : (geometry.dividers || []).find(
        (d) => (d.axis === 'y' ? 'y' : 'x') === dragging!.axis && d.index === dragging!.index
      )
      if (current && pos != null) placeDivider(el, dragging.axis, current, dragging.origin, pos)
      delete el.dataset.dragging
      const axis = dragging.axis
      const idx = dragging.index
      dragging = null
      if (pos != null) {
        Promise.resolve(ports.dragDivider({ index: idx, axis, position: pos })).catch(() => {})
      }
    }
    el.addEventListener('pointerup', end)
    el.addEventListener('pointercancel', end)
    el.addEventListener('lostpointercapture', end)
    // 双击分隔条 = **归位到均分**（I2）。与"拖到某个比例"互补：拖歪了不必手调回去。
    // 只报预设名 'even'，比例换算在主进程（格数是变量，渲染层不该各算一遍）。
    el.addEventListener('dblclick', (e) => {
      e.preventDefault()
      e.stopPropagation()
      const splitId = geometry && geometry.splitId ? String(geometry.splitId) : ''
      if (!splitId || typeof ports.setRatioPreset !== 'function') return
      Promise.resolve(ports.setRatioPreset(splitId, 'even')).catch(() => {})
    })
  }

  let unsubscribe: (() => void) | null = null
  if (typeof ports.onChanged === 'function') {
    unsubscribe = ports.onChanged((payload) => setGeometry(payload))
  }
  // 挂载时主动拉一次：推送首帧可能早于订阅（外壳 renderer 启动晚于第一次布局）。
  if (typeof ports.getGeometry === 'function') {
    Promise.resolve(ports.getGeometry()).then((g) => setGeometry(g)).catch(() => {})
  }

  function setGeometry(next: unknown): void {
    const record = next !== null && typeof next === 'object' ? next as SplitGeometry : null
    geometry = record?.active ? record : { active: false }
    render()
  }

  return {
    element: layer,
    setGeometry,
    dispose() {
      if (typeof unsubscribe === 'function') unsubscribe()
      unsubscribe = null
      try { view?.removeEventListener('resize', onRootResize) } catch (_) {}
      dragging = null
      layer.remove()
    }
  }
}


