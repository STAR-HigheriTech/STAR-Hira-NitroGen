// @ts-check
/**
 * 截图标注编辑器 · 画布与交互。
 *
 * ── 三条主线 ──────────────────────────────────────────────────────
 *   1. **底图**：`base` 是一块离屏 canvas（原图按安全尺寸等比缩放后画进去），
 *      每次重绘先贴它，再按 `ops` 顺序叠标注 —— 于是"撤销"只是 `ops.pop()` + 重绘。
 *   2. **落笔**：指针按下建 `draft`，移动只更新 draft 并重绘（矩形/椭圆/箭头/画笔），
 *      马赛克/模糊在拖动时只画虚线选区框（这两者要读整块像素，逐帧实时算会掉帧）。
 *   3. **交付**：`canvas.toBlob` → PNG 字节 → 宿主注入的 `ctx.copy / ctx.save`。
 *
 * ── 首帧原子显示（不闪的关键之一）─────────────────────────────────
 * 挂载时根节点先 `visibility: hidden`：浮层虽然已经被摆到网页视图上，
 * 但在底图 decode + 首帧画完之前**一个像素都不画**（此时下层的框选层仍原样压着）。
 * 首帧画完后 `reveal()` 才恢复可见，并在**下一帧**回执 `ctx.ready()` ——
 * 主进程拿到回执才收起下层，于是「页面亮回来 / 先黑一下再出图」都不再出现。
 *
 * ── 缩放 / 平移（整页长图的必需品）─────────────────────────────────
 * `canvas` 的**位图始终是整张图**，显示尺寸只由 CSS 决定 —— 因此缩放 / 平移
 * 只改 `wrap` 的尺寸与合成层 transform，**不重绘位图**（滚轮缩放零重绘，跟手）。
 *   滚轮（含 Ctrl+滚轮）→ 以光标为锚点缩放；Ctrl+= / Ctrl+- / Ctrl+0 → 缩放 / 复位；
 *   中键拖拽、空格+左键拖拽、方向键 → 平移；点工具栏的百分比 → 回到适应。
 * 所有截图初始都按**完整容纳**显示：整页长图也先缩到可用区域，工具栏在下方单独
 * 保留空间；需要看细节时再滚轮放大并平移。
 *
 * ── 端口契约（由宿主 `renderer/capture-editor/main.js` 注入）───────────────
 *   ctx.place                     → {x,y,width,height}|null  选区在**目标视图**里的矩形
 *                                  （浮层就盖在那块视图上，故 = 浮层内坐标；null = 铺满浮层）
 *   ctx.load()                    → Promise<{ bytes: Uint8Array, width?, height? } | null>
 *   ctx.copy(bytes)               → Promise<boolean>   写系统剪贴板
 *   ctx.save(bytes, suggestedName)→ Promise<{ ok: boolean }>  弹「另存为」
 *   ctx.close()                   → void               收起本浮层（主进程执行）
 *   ctx.ready()                   → void               首帧已画出来（主进程据此收起下层）
 *   ctx.preferences.read/write    → 工具、颜色、线宽持久化端口
 * 本包不认识 IPC / 不认识 Electron（ui → apps 被 CONTRACT-11 禁止）。
 */

import {
  CAPTURE_TOOLS,
  CAPTURE_COLORS,
  CAPTURE_WIDTHS,
  CAPTURE_DEFAULT_TOOL,
  CAPTURE_DEFAULT_COLOR,
  CAPTURE_DEFAULT_WIDTH,
  CAPTURE_MOSAIC_BLOCK,
  CAPTURE_BLUR_RADIUS,
  captureTextSize,
  normalizeDragRect,
  isDragSignificant,
  fitCaptureCanvas
} from '@hira-ng/shared-types/src/capture-annotate.mjs'
import { injectCaptureEditorStyles as injectStyles, WINDOW_CSS } from '../shared/styles.js'
import { paintOp, type CaptureOp, type CapturePoint } from './painters.js'
import {
  clampNumber,
  computeCaptureLayout,
  computeToolbarPosition,
  type CaptureRect
} from './layout.js'
import {
  createCaptureToolbar,
  type CaptureToolbarController,
  type CaptureToolbarSnapshot
} from './toolbar.js'

export interface CapturePlace {
  x: number
  y: number
  width: number
  height: number
}

export interface CaptureLoadResult {
  bytes: unknown
  width?: number
  height?: number
}

export interface CaptureEditorPreferences {
  tool: string
  color: string
  width: number
}

export interface CapturePreferencesPort {
  read?: () => Promise<Partial<CaptureEditorPreferences> | null> | Partial<CaptureEditorPreferences> | null
  write?: (preferences: CaptureEditorPreferences) => Promise<void> | void
}

export interface CaptureEditorContext {
  place?: CapturePlace | null
  load?: () => Promise<CaptureLoadResult | null | undefined>
  copy?: (bytes: Uint8Array) => Promise<boolean | void>
  save?: (bytes: Uint8Array, name: string) => Promise<{ ok: boolean } | null | void>
  close?: () => void
  ready?: () => void
  preferences?: CapturePreferencesPort
}

export interface CaptureEditorController {
  readonly element: HTMLElement
  start(): Promise<void>
  dispose(): void
}

export function injectCaptureEditorStyles(doc: Document): void {
  injectStyles(doc, WINDOW_CSS)
}

/** 拖拽预览框的颜色（与标注色无关：它是"选区"而不是"内容"）。 */
const PREVIEW_COLOR = '#0ea5e9'
/** 画笔取点最小间距（画布像素）：太密只会白占内存。 */
const PEN_MIN_STEP = 1.5

/** 缩放上下限（相对「适应」的倍数）。上限给到 16 倍：整页长图要能看清细节。 */
const ZOOM_MIN = 0.1
const ZOOM_MAX = 16
/** 方向键平移步长（CSS px）。 */
const PAN_STEP = 60
/**
 * 局部重绘向视口外多画的安全边（CSS px）。
 *
 * 为什么要留：可见区是按窗口矩形算的，而浮层边缘 / 阴影 / 文字抗锯齿会略微越界；
 * 正好卡在边上会让来回平移时出现一条"半像素缝"。多画一点的成本可以忽略。
 */
const REDRAW_PAD = 96
/** 工具栏与图像的间距（px）。 */
const TOOLBAR_GAP = 10
/** 工具栏离窗口边缘的最小留白（px）。 */
const EDGE_GAP = 12
/** Toolbar 首次测量前使用的保守尺寸，仅用于首帧定位。 */
const TOOLBAR_FALLBACK = { width: 720, height: 88 }

/**
 * 把宿主给过来的字节归一成 Uint8Array。
 * 正常走 Electron 结构化克隆就是 Uint8Array；这里顺手兼容 ArrayBuffer /
 * 其它 TypedArray / `{type:'Buffer',data:[…]}` 三种边缘形态。
 * @param {unknown} value
 * @returns {Uint8Array|null}
 */
function toUint8(value: unknown): Uint8Array | null {
  if (!value) return null
  if (value instanceof Uint8Array) return value
  if (value instanceof ArrayBuffer) return new Uint8Array(value)
  if (ArrayBuffer.isView(value)) return new Uint8Array(value.buffer, value.byteOffset, value.byteLength)
  const bufferLike = value as { type?: unknown; data?: unknown }
  if (bufferLike.type === 'Buffer' && Array.isArray(bufferLike.data)) return new Uint8Array(bufferLike.data as number[])
  return null
}

/** 创建截图标注编辑器；宿主通过 ctx 提供取图、复制、保存与生命周期端口。 */
export function createCaptureEditor(doc: Document, ctx: CaptureEditorContext = {}): CaptureEditorController {
  if (!doc.defaultView) throw new Error('Capture editor requires an attached window')
  const view: Window = doc.defaultView

  // ── 编辑状态 ─────────────────────────────────────────────────────
  let tool = CAPTURE_DEFAULT_TOOL
  let color = CAPTURE_DEFAULT_COLOR
  let lineWidth = CAPTURE_DEFAULT_WIDTH
  /** 已提交的标注（顺序即叠放顺序）。只做增删，不换数组本身。 */
  const ops: CaptureOp[] = []
  /** 撤销出去、还能重做的标注。 */
  let redoStack: CaptureOp[] = []
  /** 正在拖的标注（null = 没有进行中的手势）。 */
  let draft: CaptureOp | null = null
  /** draft 的起点（画布坐标）。 */
  let draftStart: CapturePoint | null = null
  /** 画布像素 ÷ 显示像素（落笔时把线宽 / 字号 / 格子上限换算到画布像素）。 */
  let scale = 1
  /** 原图（离屏 canvas）。 */
  let base: HTMLCanvasElement | null = null
  let ready = false
  let pointerId: number | null = null
  /** 正在编辑的文字框（null = 没有）。 */
  interface TextEditorState {
    el: HTMLTextAreaElement
    point: CapturePoint
    done: boolean
  }
  let textEditor: TextEditorState | null = null
  let busy = false
  let preferenceTimer = 0
  let lastSavedPreferences = ''

  // ── 视图状态：缩放 / 平移 / 首帧 ─────────────────────────────────
  /** 缩放倍数（1 = 适应）。只影响显示尺寸，不动位图 —— 见文件头。 */
  let zoom = 1
  /** 相对"适应位"的平移量（CSS px）。 */
  let panX = 0
  let panY = 0
  /** 初始统一为 contain；width 档位保留给后续视图模式扩展。 */
  let fitMode: 'contain' | 'width' = 'contain'
  /** 空格键按住（临时切到"抓手"）。 */
  let spaceHeld = false
  /** 正在拖拽平移：{ pointerId, x, y, panX, panY } | null。 */
  interface PanningState {
    pointerId: number
    x: number
    y: number
    panX: number
    panY: number
  }
  let panning: PanningState | null = null
  /** 根节点是否已经亮出来（首帧原子显示，见文件头）。 */
  let revealed = false
  let redrawFrame = 0
  let wheelFrame = 0
  let wheelFactor = 1
  let wheelAnchor = { x: 0, y: 0 }
  let toolbarSize = { ...TOOLBAR_FALLBACK }
  let toolbarObserver: ResizeObserver | null = null

  // ── DOM 骨架 ─────────────────────────────────────────────────────
  const root = doc.createElement('div')
  root.className = 'hira-capture-editor'
  // 首帧之前一个像素都不画：浮层已经盖在网页视图上了，此时露出来的必须是
  // 下层（框选层 / 原页面）原样 —— 先画一块淡暗再补图就是"先黑一下"的闪。
  root.style.visibility = 'hidden'

  const stage = doc.createElement('div')
  stage.className = 'hira-capture-stage'
  // 框选交接：那一刻页面已被框选层压暗到 0.45，本层先完全透明，
  // 等 ready 那一帧再淡入（见 `reveal`）。其余截图方式没有下层压暗，不需要这一手。
  if (ctx.place) stage.classList.add('is-veiled')

  const wrap = doc.createElement('div')
  wrap.className = 'hira-capture-wrap'

  const canvas = doc.createElement('canvas')
  canvas.className = 'hira-capture-canvas'

  /**
   * 空态提示（读图失败 / 数据失效）。
   *
   * 单独一个元素、只切 `display`：早先用 `stage.textContent = ''` 会把 `wrap`
   * 连同 `canvas` 一起拆掉 —— 之后再想恢复就读不到 `getBoundingClientRect`。
   */
  const empty = doc.createElement('div')
  empty.className = 'hira-capture-empty'
  empty.style.display = 'none'

  const ui = doc.createElement('div')
  ui.className = 'hira-capture-ui'

  const toolbar: CaptureToolbarController = createCaptureToolbar(doc, {
    tool: (value) => setTool(value),
    color: (value) => setColor(value),
    width: (value) => setWidth(value),
    resetZoom: () => resetView(),
    undo: () => undo(),
    redo: () => redo(),
    copy: () => { void doCopy() },
    save: () => { void doSave() },
    close: () => close()
  })

  wrap.appendChild(canvas)
  stage.appendChild(wrap)
  stage.appendChild(empty)
  ui.appendChild(toolbar.element)
  root.append(stage, ui)

  const maybeC2d = canvas.getContext('2d')
  if (!maybeC2d) throw new Error('Capture editor requires a 2D canvas context')
  const c2d: CanvasRenderingContext2D = maybeC2d

  // ── 浮层布局 ─────────────────────────────────────────────────────
  /** 图像实际显示矩形（= 适应尺寸 × 缩放 + 平移）—— 工具栏要贴着它摆。 */
  let imageBox: CaptureRect | null = null

  /**
   * 重算显示几何：适应尺寸 → 缩放 → 平移（按选区 / 视口夹取）→ 落 DOM。
   *
   * **不重绘位图**：canvas 的位图永远是整张图，这里只改 `wrap` 的 CSS 矩形。
   * 因此滚轮缩放、拖拽平移都是纯样式写入，一帧内跟手（见文件头）。
   */
  function layout() {
    const iw = base ? base.width : 0
    const ih = base ? base.height : 0
    if (!(iw > 0) || !(ih > 0)) {
      imageBox = null
      wrap.style.display = 'none'
      layoutToolbar()
      return
    }
    wrap.style.display = 'block'
    const result = computeCaptureLayout({
      viewport: { width: view.innerWidth || 1, height: view.innerHeight || 1 },
      place: ctx.place,
      insets: captureContentInsets(),
      image: { width: iw, height: ih },
      zoom,
      panX,
      panY,
      fitMode
    })
    imageBox = result.image
    panX = result.panX
    panY = result.panY
    wrap.style.width = `${imageBox.width}px`
    wrap.style.height = `${imageBox.height}px`
    wrap.style.transform = `translate3d(${imageBox.x}px, ${imageBox.y}px, 0)`
    // 画布像素 ÷ 显示像素：缩放后重算，落笔粗细的**视觉**大小因此保持不变。
    scale = result.scale
    syncToolbar()
    layoutToolbar()
  }

  /**
   * Non-region captures reserve the dock band below the image. The initial
   * contain fit therefore shows the complete screenshot instead of cropping
   * a long page to the viewport.
   */
  function captureContentInsets() {
    if (ctx.place) return undefined
    return {
      top: EDGE_GAP,
      right: EDGE_GAP,
      bottom: toolbarSize.height + EDGE_GAP * 2 + TOOLBAR_GAP,
      left: EDGE_GAP
    }
  }

  /**
   * The dock is a peer of the stage, never a child of the captured document.
   * Its placement algorithm always returns an in-viewport point; edge-to-edge
   * captures therefore get a bottom overlay instead of losing the controls.
   */
  function layoutToolbar() {
    const position = computeToolbarPosition({
      viewport: { width: view.innerWidth || 1, height: view.innerHeight || 1 },
      image: imageBox,
      toolbar: toolbarSize,
      edgeGap: EDGE_GAP,
      gap: TOOLBAR_GAP
    })
    toolbar.element.style.left = `${position.left}px`
    toolbar.element.style.top = `${position.top}px`
    toolbar.element.dataset.placement = position.placement
  }

  function measureToolbar() {
    const next = toolbar.measure()
    if (next.width === toolbarSize.width && next.height === toolbarSize.height) return
    toolbarSize = next
    if (base) layout()
    else layoutToolbar()
  }

  /* ── 缩放 / 平移 ─────────────────────────────────────────────────── */

  function syncToolbar() {
    const snapshot: CaptureToolbarSnapshot = {
      tool,
      color,
      width: lineWidth,
      zoom,
      ready,
      canUndo: ops.length > 0,
      canRedo: redoStack.length > 0,
      busy
    }
    toolbar.update(snapshot)
  }

  /**
   * 缩放到指定倍数，**以锚点为不动点**（滚轮缩放必须有这一条）。
   *
   * 锚点用浮层内坐标（= 事件 clientX/Y）：缩放前后锚点下的那一个图像像素不许动，
   * 否则滚轮缩放会"跑偏"，用户得一边缩一边追着图挪。
   * 全仓只有这一处改 `zoom`，读数的刷新与夹取都在 `layout()` 里。
   */
  function zoomTo(next: number, anchorX?: number, anchorY?: number) {
    if (!ready) return
    const z = clampNumber(next, ZOOM_MIN, ZOOM_MAX)
    if (Math.abs(z - zoom) < 1e-4) return
    const fit = computeCaptureLayout({
      viewport: { width: view.innerWidth || 1, height: view.innerHeight || 1 },
      place: ctx.place,
      insets: captureContentInsets(),
      image: { width: base?.width || 1, height: base?.height || 1 },
      zoom: 1,
      panX: 0,
      panY: 0,
      fitMode
    }).fit
    const ax = anchorX != null && Number.isFinite(anchorX) ? anchorX : fit.x + fit.width / 2
    const ay = anchorY != null && Number.isFinite(anchorY) ? anchorY : fit.y + fit.height / 2
    // 锚点落在图里的位置（以"适应尺寸"为单位，与当前缩放无关）。
    const fx = imageBox ? (ax - imageBox.x) / zoom : 0
    const fy = imageBox ? (ay - imageBox.y) / zoom : 0
    zoom = z
    panX = ax - fx * z - fit.x
    panY = ay - fy * z - fit.y
    layout()
  }

  /** 回到适应（缩放 100%、平移归零）。 */
  function resetView() {
    if (!ready) return
    zoom = 1
    panX = 0
    panY = 0
    layout()
  }

  /** 按步长平移（方向键 / 抓手拖拽都走这里，夹取在 `layout()`）。 */
  function panBy(dx: number, dy: number) {
    if (!ready) return
    panX += dx
    panY += dy
    layout()
  }

  /** 滚轮 → 缩放倍率（deltaMode 1=行 / 2=页 都要归一成像素）。 */
  function wheelZoomFactor(event: WheelEvent) {
    let dy = Number(event.deltaY) || 0
    if (event.deltaMode === 1) dy *= 16
    else if (event.deltaMode === 2) dy *= 100
    // 指数曲线：一档滚轮（dy≈100）约 0.84×，触控板的小 delta 也能连续微调。
    return Math.exp(-dy * 0.0018)
  }

  /** 指针 / 空格决定光标形态（抓手态优先于工具）。 */
  function updateCursor() {
    if (panning) canvas.style.cursor = 'grabbing'
    else if (spaceHeld) canvas.style.cursor = 'grab'
    else canvas.style.cursor = tool === 'text' ? 'text' : 'crosshair'
  }

  /**
   * 首帧已经落到屏幕上了 → 亮出浮层，并在**下一帧**回执 `ctx.ready()`。
   *
   * 为什么回执要晚一帧：`visibility` 生效与合成器提交之间还差一次绘制。
   * 这一帧的差就是"主进程收到回执 → 收起下层框选层"与"标注图真的出现在屏幕上"
   * 的先后 —— 早一帧回执，用户会看到一帧"框选层没了、图还没上来"的白闪。
   *
   * 幂等：空态与正常路径都调，只有第一次生效。
   */
  function reveal() {
    if (revealed) return
    revealed = true
    root.style.visibility = ''
    const notify = () => {
      // 与回执**同帧**解除隐身：主进程收到 ready 才让框选层淡出自己的压暗，
      // 两边的 180ms 淡入 / 淡出因此同步起步（见 main/capture-region.js#capture）。
      stage.classList.remove('is-veiled')
      try { if (typeof ctx.ready === 'function') ctx.ready() } catch (_) {}
    }
    if (typeof view.requestAnimationFrame === 'function') view.requestAnimationFrame(notify)
    else view.setTimeout(notify, 0)
  }

  /** 点淡暗背景 = 退出标注（QQ / Snipaste 同款手势；抓手态下不退出）。 */
  function onStagePointerDown(event: PointerEvent) {
    // 抓手态（空格）或正在平移：这一下是"拖动画面"，不是"退出"。
    if (spaceHeld || panning) return
    if (event.target !== stage) return
    event.preventDefault()
    close()
  }

  /**
   * 滚轮缩放（以光标为锚点）。挂在 stage 上而不只是画布：指针落在淡暗区里
   * 也应该能缩放（放大后图像边缘常常正好在光标附近）。
   * 必须 `passive: false` —— 要拦掉宿主的默认页面滚动。
   */
  function onStageWheel(event: WheelEvent) {
    if (!ready) return
    event.preventDefault()
    wheelFactor *= wheelZoomFactor(event)
    wheelAnchor = { x: event.clientX, y: event.clientY }
    if (wheelFrame) return
    wheelFrame = view.requestAnimationFrame(() => {
      wheelFrame = 0
      const factor = wheelFactor
      wheelFactor = 1
      zoomTo(zoom * factor, wheelAnchor.x, wheelAnchor.y)
    })
  }

  // 窗口尺寸变了（多屏 / 系统改缩放）就重新摆一遍，别让画布停在旧矩形里。
  function onViewportResize() {
    layout()
    measureToolbar()
  }
  view.addEventListener('resize', onViewportResize)
  // 画布 / 工具栏的事件不会冒泡成一次退出（这里只认直接点在背景上）。
  stage.addEventListener('pointerdown', onStagePointerDown)
  stage.addEventListener('wheel', onStageWheel, { passive: false })

  toolbarSize = toolbar.measure()
  if (typeof ResizeObserver === 'function') {
    toolbarObserver = new ResizeObserver(() => measureToolbar())
    toolbarObserver.observe(toolbar.element)
  }

  // ── 状态同步 ─────────────────────────────────────────────────────
  function writePreferencesNow() {
    if (!ctx.preferences || typeof ctx.preferences.write !== 'function') return
    const value = { tool, color, width: lineWidth }
    const serialized = JSON.stringify(value)
    if (serialized === lastSavedPreferences) return
    lastSavedPreferences = serialized
    try {
      const pending = ctx.preferences.write(value)
      if (pending && typeof pending.catch === 'function') pending.catch(() => {})
    } catch (_) {}
  }

  function schedulePreferenceSave() {
    if (!ctx.preferences || typeof ctx.preferences.write !== 'function') return
    if (preferenceTimer) view.clearTimeout(preferenceTimer)
    preferenceTimer = view.setTimeout(() => {
      preferenceTimer = 0
      writePreferencesNow()
    }, 120)
  }

  function setTool(next: string) {
    if (!CAPTURE_TOOLS.some((item) => item.id === next)) return
    if (textEditor) finishText(true)
    tool = next
    updateCursor()
    syncToolbar()
    schedulePreferenceSave()
  }

  function setColor(next: string) {
    if (!CAPTURE_COLORS.includes(next)) return
    color = next
    if (textEditor) textEditor.el.style.color = color
    syncToolbar()
    schedulePreferenceSave()
  }

  function setWidth(next: number) {
    if (!CAPTURE_WIDTHS.includes(Number(next))) return
    lineWidth = Number(next)
    if (textEditor) textEditor.el.style.fontSize = `${captureTextSize(lineWidth)}px`
    syncToolbar()
    schedulePreferenceSave()
  }

  function syncButtons() {
    syncToolbar()
  }

  function flash(message: string, tone: 'neutral' | 'success' | 'error' = 'neutral') {
    toolbar.flash(message, tone)
  }

  // ── 绘制 ─────────────────────────────────────────────────────────
  /**
   * 当前**可见**的画布像素矩形（局部重绘的绘制范围）。
   *
   * 为什么要局部重绘：整页长图的位图可能有 2880×16384 像素，每落一笔都全量
   * `clearRect` + `drawImage` 会直接掉帧。标注是叠加式的 —— 只重画视口覆盖到的那一块，
   * 其余部分内容本来就还是对的（马赛克/模糊读到的可能是旧像素，导出前整张重画一次即可，
   * 见 `exportBytes`）。
   * @param {number} padCss 向视口外多画的安全边（CSS px）
   * @returns {{x:number,y:number,w:number,h:number}|null}
   */
  function visibleCanvasRect(padCss: number) : {x:number,y:number,w:number,h:number}|null {
    if (!imageBox) return null
    if (!(imageBox.width > 0) || !(imageBox.height > 0)) return null
    const W = Math.max(1, view.innerWidth || 1)
    const H = Math.max(1, view.innerHeight || 1)
    const left = Math.max(imageBox.x, 0)
    const top = Math.max(imageBox.y, 0)
    const right = Math.min(imageBox.x + imageBox.width, W)
    const bottom = Math.min(imageBox.y + imageBox.height, H)
    if (!(right > left) || !(bottom > top)) return null
    const sx = canvas.width / imageBox.width
    const sy = canvas.height / imageBox.height
    const padX = Math.ceil(Math.max(0, padCss) * sx)
    const padY = Math.ceil(Math.max(0, padCss) * sy)
    const x = Math.max(0, Math.floor((left - imageBox.x) * sx) - padX)
    const y = Math.max(0, Math.floor((top - imageBox.y) * sy) - padY)
    const w = Math.min(canvas.width - x, Math.ceil((right - left) * sx) + padX * 2)
    const h = Math.min(canvas.height - y, Math.ceil((bottom - top) * sy) + padY * 2)
    if (!(w > 0) || !(h > 0)) return null
    return { x, y, w, h }
  }

  /**
   * 重绘。默认只画可见区（见 `visibleCanvasRect`），`{ full: true }` 整张重画。
   * @param {{ full?: boolean }} [options]
   */
  function redraw(options: { full?: boolean } = {}) {
    if (!ready || !base) return
    const full = !!(options && options.full)
    const area = full
      ? { x: 0, y: 0, w: canvas.width, h: canvas.height }
      : visibleCanvasRect(REDRAW_PAD)
    if (!area) return
    c2d.setTransform(1, 0, 0, 1, 0, 0)
    c2d.globalAlpha = 1
    c2d.filter = 'none'
    c2d.save()
    c2d.beginPath()
    c2d.rect(area.x, area.y, area.w, area.h)
    c2d.clip()
    c2d.clearRect(area.x, area.y, area.w, area.h)
    c2d.drawImage(base, area.x, area.y, area.w, area.h, area.x, area.y, area.w, area.h)
    for (const op of ops) paintOp(c2d, op)
    if (draft) previewDraft()
    c2d.restore()
  }

  function scheduleRedraw() {
    if (redrawFrame) return
    redrawFrame = view.requestAnimationFrame(() => {
      redrawFrame = 0
      redraw()
    })
  }

  function flushRedraw() {
    if (redrawFrame) {
      view.cancelAnimationFrame(redrawFrame)
      redrawFrame = 0
    }
    redraw()
  }

  /**
   * 画进行中的手势。
   * 马赛克 / 模糊只画虚线框 —— 它们要读"当前整块像素"，拖动期间逐帧算既慢
   * 又会让用户看不清自己在选哪里；抬起时再真正落 op。
   */
  function previewDraft() {
    if (!draft) return
    if (draft.tool === 'mosaic' || draft.tool === 'blur') {
      const x = Number(draft.x) || 0
      const y = Number(draft.y) || 0
      const w = Number(draft.w) || 0
      const h = Number(draft.h) || 0
      if (w <= 0 || h <= 0) return
      c2d.save()
      c2d.setLineDash([6 * scale, 4 * scale])
      c2d.lineWidth = Math.max(1, scale)
      c2d.strokeStyle = PREVIEW_COLOR
      c2d.strokeRect(x, y, w, h)
      c2d.restore()
      return
    }
    paintOp(c2d, draft)
  }

  // ── 坐标换算 ─────────────────────────────────────────────────────
  function displayScale() {
    if (!imageBox?.width) return 1
    return canvas.width / imageBox.width
  }

  function toCanvasPoint(clientX: number, clientY: number): CapturePoint {
    if (!imageBox) return { x: 0, y: 0 }
    const sx = canvas.width / imageBox.width
    const sy = canvas.height / imageBox.height
    return { x: (clientX - imageBox.x) * sx, y: (clientY - imageBox.y) * sy }
  }

  // ── 落笔 ─────────────────────────────────────────────────────────
  /** 线宽 / 字号 / 马赛克格子在**画布像素**下的值。 */
  function canvasLineWidth() {
    return Math.max(1, Math.round(lineWidth * scale))
  }

  function startDraft(point: CapturePoint) {
    const common = { color, lineWidth: canvasLineWidth() }
    if (tool === 'arrow') {
      draft = { tool, x1: point.x, y1: point.y, x2: point.x, y2: point.y, ...common }
      return
    }
    if (tool === 'pen' || tool === 'highlight') {
      draft = { tool, points: [point], ...common }
      return
    }
    if (tool === 'rect' || tool === 'ellipse') {
      draft = { tool, x: point.x, y: point.y, w: 0, h: 0, ...common }
      return
    }
    if (tool === 'mosaic') {
      draft = { tool, x: point.x, y: point.y, w: 0, h: 0, block: Math.max(2, Math.round(CAPTURE_MOSAIC_BLOCK * scale)) }
      return
    }
    if (tool === 'blur') {
      draft = { tool, x: point.x, y: point.y, w: 0, h: 0, radius: Math.max(1, CAPTURE_BLUR_RADIUS * scale) }
    }
  }

  function updateDraft(point: CapturePoint) {
    if (!draft) return
    if (draft.tool === 'arrow') {
      draft.x2 = point.x
      draft.y2 = point.y
      return
    }
    if (draft.tool === 'pen' || draft.tool === 'highlight') {
      const points = draft.points || (draft.points = [])
      const last = points[points.length - 1]
      if (!last) return
      if (Math.abs(point.x - last.x) < PEN_MIN_STEP && Math.abs(point.y - last.y) < PEN_MIN_STEP) return
      points.push(point)
      return
    }
    const rect = normalizeDragRect(draftStart || point, point)
    draft.x = rect.x
    draft.y = rect.y
    draft.w = rect.w
    draft.h = rect.h
  }

  /**
   * 抬手：把手势定稿成一条 op（太小的一笔丢掉，免得画布上到处是隐形小点）。
   * @returns {boolean} 是否真的提交了
   */
  function commitDraft() : boolean {
    if (!draft) return false
    const op = draft
    draft = null
    draftStart = null
    let ok = false
    if (op.tool === 'arrow') {
      ok = Math.abs((Number(op.x2) || 0) - (Number(op.x1) || 0)) >= 4 * scale
        || Math.abs((Number(op.y2) || 0) - (Number(op.y1) || 0)) >= 4 * scale
    } else if (op.tool === 'pen' || op.tool === 'highlight') {
      ok = (op.points?.length || 0) >= 3
    } else {
      ok = isDragSignificant({ w: Number(op.w) || 0, h: Number(op.h) || 0 }, scale)
    }
    if (!ok) return false
    ops.push(op)
    redoStack = []
    redraw()
    syncButtons()
    return true
  }

  canvas.addEventListener('pointerdown', (event) => {
    if (!ready) return
    // 中键 / 空格+左键 = 拖动画布（不落笔）。放大看整页长图时的高频动作。
    if (event.button === 1 || (event.button === 0 && spaceHeld)) {
      event.preventDefault()
      panning = { pointerId: event.pointerId, x: event.clientX, y: event.clientY, panX, panY }
      wrap.classList.add('is-panning')
      try { canvas.setPointerCapture(event.pointerId) } catch (_) {}
      updateCursor()
      return
    }
    if (event.button !== 0) return
    scale = displayScale()
    const point = toCanvasPoint(event.clientX, event.clientY)
    if (tool === 'text') {
      event.preventDefault()
      openTextEditor(event, point)
      return
    }
    draftStart = point
    startDraft(point)
    pointerId = event.pointerId
    try { canvas.setPointerCapture(event.pointerId) } catch (_) {}
    event.preventDefault()
    scheduleRedraw()
  })

  canvas.addEventListener('pointermove', (event) => {
    if (panning) {
      if (event.pointerId !== panning.pointerId) return
      // 位移直接写进 panX/panY，夹取与落 DOM 都在 layout()（不重绘位图）。
      panX = panning.panX + (event.clientX - panning.x)
      panY = panning.panY + (event.clientY - panning.y)
      layout()
      return
    }
    if (!draft || (pointerId != null && event.pointerId !== pointerId)) return
    updateDraft(toCanvasPoint(event.clientX, event.clientY))
    scheduleRedraw()
  })

  canvas.addEventListener('pointerup', (event) => {
    if (panning) {
      if (event.pointerId !== panning.pointerId) return
      try { canvas.releasePointerCapture(event.pointerId) } catch (_) {}
      panning = null
      wrap.classList.remove('is-panning')
      updateCursor()
      return
    }
    if (!draft || (pointerId != null && event.pointerId !== pointerId)) return
    if (pointerId != null) {
      try { canvas.releasePointerCapture(pointerId) } catch (_) {}
    }
    pointerId = null
    commitDraft()
  })

  canvas.addEventListener('pointercancel', () => {
    if (panning) {
      panning = null
      wrap.classList.remove('is-panning')
      updateCursor()
    }
    if (!draft) return
    draft = null
    draftStart = null
    pointerId = null
    flushRedraw()
  })

  // ── 文字 ─────────────────────────────────────────────────────────
  /**
   * 在落点叠一个 textarea（所见即所得：字号 / 颜色与最终绘制一致）。
   * Enter 提交、Shift+Enter 换行、Esc 取消、失焦提交。
   */
  function openTextEditor(event: PointerEvent, point: CapturePoint) {
    if (textEditor) finishText(true)
    const el = doc.createElement('textarea')
    el.className = 'hira-capture-text'
    el.style.left = `${event.clientX - (imageBox?.x || 0)}px`
    el.style.top = `${event.clientY - (imageBox?.y || 0)}px`
    el.style.color = color
    el.style.fontSize = `${captureTextSize(lineWidth)}px`
    el.rows = 1
    el.spellcheck = false
    const state = { el, point, done: false }
    textEditor = state

    const autosize = () => {
      el.style.height = 'auto'
      el.style.height = `${el.scrollHeight}px`
      el.style.width = 'auto'
      el.style.width = `${Math.max(60, el.scrollWidth + 4)}px`
    }
    el.addEventListener('input', autosize)
    el.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); finishText(false); return }
      if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); e.stopPropagation(); finishText(true) }
    })
    el.addEventListener('blur', () => finishText(true))
    wrap.appendChild(el)
    autosize()
    view.requestAnimationFrame(() => el.focus())
  }

  /** @param {boolean} commit */
  function finishText(commit: boolean) {
    const state = textEditor
    if (!state || state.done) return
    state.done = true
    textEditor = null
    const text = state.el.value
    try { state.el.remove() } catch (_) {}
    if (!commit || !text.trim()) return
    ops.push({
      tool: 'text',
      x: state.point.x,
      y: state.point.y,
      text,
      color,
      fontSize: Math.max(8, captureTextSize(lineWidth) * scale)
    })
    redoStack = []
    redraw()
    syncButtons()
  }

  // ── 撤销 / 重做 ───────────────────────────────────────────────────
  function undo() {
    if (!ops.length) return
    const op = ops.pop()
    if (op) redoStack.push(op)
    redraw()
    syncButtons()
  }
  function redo() {
    if (!redoStack.length) return
    const op = redoStack.pop()
    if (op) ops.push(op)
    redraw()
    syncButtons()
  }

  // ── 交付 ─────────────────────────────────────────────────────────
  function suggestedName() {
    const d = new Date()
    const pad = (n: number) => String(n).padStart(2, '0')
    return `截图-${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}.png`
  }

  function exportBytes(): Promise<Uint8Array | null> {
    // 马赛克 / 模糊 painter 读的是 `ctx.canvas` 的像素，而平时只局部重绘 ——
    // 视口外的旧像素会让导出结果与眼前看到的不一致。导出前整张重画一次。
    redraw({ full: true })
    return new Promise((resolve) => {
      try {
        canvas.toBlob((blob) => {
          if (!blob) { resolve(null); return }
          blob.arrayBuffer().then((buf) => resolve(new Uint8Array(buf))).catch(() => resolve(null))
        }, 'image/png')
      } catch (_) { resolve(null) }
    })
  }

  async function doCopy() {
    if (!ready || busy) return
    busy = true
    syncToolbar()
    try {
      const bytes = await exportBytes()
      if (!bytes) { flash('导出失败', 'error'); return }
      let ok = false
      try { ok = ctx.copy ? (await ctx.copy(bytes)) !== false : false } catch (_) { ok = false }
      flash(ok ? '已复制到剪贴板' : '复制失败', ok ? 'success' : 'error')
    } finally {
      busy = false
      syncToolbar()
    }
  }

  async function doSave() {
    if (!ready || busy) return
    busy = true
    syncToolbar()
    try {
      const bytes = await exportBytes()
      if (!bytes) { flash('导出失败', 'error'); return }
      let res: { ok?: boolean } | null = null
      try {
        const saved = ctx.save ? await ctx.save(bytes, suggestedName()) : null
        res = saved || null
      } catch (_) {
        res = { ok: false }
      }
      // 取消「另存为」不提示成功（什么都没发生）。
      if (res && res.ok === false) return
      flash('已保存', 'success')
    } finally {
      busy = false
      syncToolbar()
    }
  }

  function close() {
    if (textEditor) finishText(false)
    if (typeof ctx.close === 'function') ctx.close()
    else if (view) view.close()
  }

  // ── 键盘 ─────────────────────────────────────────────────────────
  /** 缩放快捷键的单档倍率（Ctrl+= / Ctrl+-）。与滚轮一样锚在视口中心。 */
  const ZOOM_KEY_STEP = 1.25

  function onKeyDown(event: KeyboardEvent) {
    if (textEditor) return // 文字框自己处理 Enter / Esc / 退格
    const mod = event.ctrlKey || event.metaKey
    const key = String(event.key || '').toLowerCase()
    if (mod && key === 'z') {
      event.preventDefault()
      if (event.shiftKey) redo(); else undo()
      return
    }
    if (mod && key === 'y') { event.preventDefault(); redo(); return }
    if (mod && key === 'c') { event.preventDefault(); doCopy(); return }
    if (mod && key === 's') { event.preventDefault(); doSave(); return }
    // 缩放：与浏览器同款（Ctrl+= / Ctrl+- / Ctrl+0）。浮层视图没挂宿主快捷键，
    // 这里不拦就什么都不会发生（见文件头的"缩放 / 平移"）。
    if (mod && (event.key === '=' || event.key === '+')) {
      event.preventDefault()
      zoomTo(zoom * ZOOM_KEY_STEP)
      return
    }
    if (mod && (event.key === '-' || event.key === '_')) {
      event.preventDefault()
      zoomTo(zoom / ZOOM_KEY_STEP)
      return
    }
    if (mod && event.key === '0') { event.preventDefault(); resetView(); return }
    // 空格 = 临时抓手（按住拖动画布，抬起恢复原工具）。按住期间不能滚动页面。
    if (event.key === ' ' || event.code === 'Space') {
      event.preventDefault()
      if (!spaceHeld) { spaceHeld = true; updateCursor() }
      return
    }
    // 方向键平移（放大后不用先按住空格也能挪）。
    if (event.key === 'ArrowLeft') { event.preventDefault(); panBy(PAN_STEP, 0); return }
    if (event.key === 'ArrowRight') { event.preventDefault(); panBy(-PAN_STEP, 0); return }
    if (event.key === 'ArrowUp') { event.preventDefault(); panBy(0, PAN_STEP); return }
    if (event.key === 'ArrowDown') { event.preventDefault(); panBy(0, -PAN_STEP); return }
    if (event.key === 'Escape') { event.preventDefault(); close() }
  }

  function onKeyUp(event: KeyboardEvent) {
    if (event.key !== ' ' && event.code !== 'Space') return
    spaceHeld = false
    updateCursor()
  }

  /** 窗口失焦时复位抓手态：否则"按着空格切走了"会留下一个永远抓手的光标。 */
  function onWindowBlur() {
    if (!spaceHeld) return
    spaceHeld = false
    updateCursor()
  }

  doc.addEventListener('keydown', onKeyDown)
  doc.addEventListener('keyup', onKeyUp)
  view.addEventListener('blur', onWindowBlur)

  // ── 载入 ─────────────────────────────────────────────────────────
  function showEmpty(message: string) {
    wrap.style.display = 'none'
    empty.textContent = message
    empty.style.display = 'block'
    syncButtons()
    // 空态同样要亮出来并回执：否则主进程会一直等 ready 超时，框选层多压 2.5 秒。
    reveal()
  }

  async function decode(bytes: Uint8Array): Promise<ImageBitmap | HTMLImageElement | null> {
    const pngBytes = bytes.slice().buffer
    try {
      return await view.createImageBitmap(new Blob([pngBytes], { type: 'image/png' }))
    } catch (_) {
      // 兜底：`createImageBitmap` 不可用时走 <img>。
      return new Promise((resolve) => {
        const url = URL.createObjectURL(new Blob([pngBytes], { type: 'image/png' }))
        const img = new Image()
        img.onload = () => { URL.revokeObjectURL(url); resolve(img) }
        img.onerror = () => { URL.revokeObjectURL(url); resolve(null) }
        img.src = url
      })
    }
  }

  async function start(): Promise<void> {
    try {
      const saved = await ctx.preferences?.read?.()
      if (saved) {
        if (typeof saved.tool === 'string' && CAPTURE_TOOLS.some((item) => item.id === saved.tool)) tool = saved.tool
        if (typeof saved.color === 'string' && CAPTURE_COLORS.includes(saved.color)) color = saved.color
        if (CAPTURE_WIDTHS.includes(Number(saved.width))) lineWidth = Number(saved.width)
        lastSavedPreferences = JSON.stringify({ tool, color, width: lineWidth })
      }
    } catch (_) {}
    setTool(tool)
    setColor(color)
    setWidth(lineWidth)
    syncButtons()
    measureToolbar()
    // 所有截图初始都完整容纳；长图会缩小到整个可用区域，主动放大后再平移。
    fitMode = 'contain'
    // 先摆一次（此时可能还是空态）：工具栏不会停在窗口左上角，读图后 layout 会再摆一次。
    layout()

    let payload: CaptureLoadResult | null = null
    try { payload = ctx.load ? (await ctx.load()) ?? null : null } catch (_) { payload = null }
    const bytes = toUint8(payload && payload.bytes)
    if (!bytes || !bytes.byteLength) {
      showEmpty('截图数据已失效，请重新截图。')
      return
    }
    const bitmap = await decode(bytes)
    if (!bitmap) {
      showEmpty('无法解析这张截图。')
      return
    }

    const naturalWidth = bitmap instanceof HTMLImageElement ? bitmap.naturalWidth : bitmap.width
    const naturalHeight = bitmap instanceof HTMLImageElement ? bitmap.naturalHeight : bitmap.height
    const fit = fitCaptureCanvas(naturalWidth, naturalHeight)
    canvas.width = fit.width
    canvas.height = fit.height
    base = doc.createElement('canvas')
    base.width = fit.width
    base.height = fit.height
    const bctx = base.getContext('2d')
    if (!bctx) {
      showEmpty('无法创建画布。')
      return
    }
    bctx.drawImage(bitmap, 0, 0, fit.width, fit.height)
    if ('close' in bitmap && typeof bitmap.close === 'function') bitmap.close()

    ready = true
    // 每次挂载都从"适应"开始（浮层复用同一个视图，残留的缩放/平移会串到下一张图）。
    zoom = 1
    panX = 0
    panY = 0
    // 先把画布摆回选区原位（窗口本身就贴着那块视图），再按最终显示尺寸算比例。
    layout()
    scale = displayScale()
    // 首帧必须整张画：平时走的是可见区局部重绘，视口外的位图还是空白的。
    redraw({ full: true })
    syncButtons()
    reveal()
  }

  return {
    element: root,
    start,
    dispose() {
      doc.removeEventListener('keydown', onKeyDown)
      doc.removeEventListener('keyup', onKeyUp)
      view.removeEventListener('blur', onWindowBlur)
      view.removeEventListener('resize', onViewportResize)
      stage.removeEventListener('pointerdown', onStagePointerDown)
      stage.removeEventListener('wheel', onStageWheel)
      if (redrawFrame) view.cancelAnimationFrame(redrawFrame)
      if (wheelFrame) view.cancelAnimationFrame(wheelFrame)
      if (preferenceTimer) view.clearTimeout(preferenceTimer)
      redrawFrame = 0
      wheelFrame = 0
      preferenceTimer = 0
      writePreferencesNow()
      toolbarObserver?.disconnect()
      toolbarObserver = null
      toolbar.destroy()
      canvas.width = 0
      canvas.height = 0
      base = null
      ready = false
    }
  }
}

/** 浮层形态定义（宿主 `renderer/capture-editor/main.js` 按同形契约挂载）。 */
export const captureEditorDefinition = {
  id: 'capture-editor',
  injectStyles: injectCaptureEditorStyles,
  mount(doc: Document, ctx: CaptureEditorContext = {}) {
    return createCaptureEditor(doc, ctx)
  }
}
