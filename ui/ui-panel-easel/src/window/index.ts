// @ts-check
/**
 * 画板（D4）· **独立窗口形态**（无限画布 + 绘图工具）。
 *
 * ── 它是什么 ──────────────────────────────────────────────────────
 * 一块可以平移 / 缩放的无限画布，上面有两类东西：
 *   · **内容卡片**：便签（文字）· 链接 · 粘贴进来的图片 —— 可拖、可改尺寸、可叠放；
 *   · **笔迹**：画笔（手绘）· 直线 · 箭头 · 矩形 · 椭圆 · **连线**（卡片之间）—— 可选中、可删除。
 * 所有改动自动落盘（防抖），并可 Ctrl+Z 撤销。
 *
 * ── 结构：世界坐标里两层 ──────────────────────────────────────────
 *   `.hira-easel-world`（受 transform 影响的坐标系）
 *     ├─ `<svg>`  笔迹层（1×1 + overflow:visible，路径按世界坐标画）
 *     └─ `<div>`  卡片层（DOM，因为便签里要有可编辑的 textarea）
 * 笔迹在卡片**之下**：连线只是背景关系，不该压住卡片里的字。
 *
 * ── 连线为什么是"活的" ────────────────────────────────────────────
 * 连线只存两端卡片 id，端点几何每次渲染现算（见 shared-types/easel#connectorAnchor）；
 * 拖卡片时**只就地更新相关连线的 `d`**（不全量重绘），所以线是跟着卡片走的、且不掉帧。
 *
 * ── 端口注入 ──────────────────────────────────────────────────────
 *   ctx.clients.settings → { get, set }
 *   ctx.openUrl(url)     → 用浏览器标签打开一个链接
 *   ctx.confirm(opts)    → 确认框
 * 本包不认识 IPC / 不认识主进程（ui → apps 的方向被 CONTRACT-11 禁止）。
 */

import type { WindowDefinition, PanelContext } from '@hira-ng/ui-common'
import {
  createBoard,
  createCard,
  createStroke,
  clampCard,
  bringCardToFront,
  bringStrokeToFront,
  strokeGeometry,
  STROKE_COLORS,
  STROKE_WIDTHS,
  STROKE_KINDS,
  TOOL_ORDER,
  CARD_KIND_LABELS,
  EASEL_BACKGROUNDS,
  EASEL_BACKGROUND_IDS,
  EASEL_DEFAULT_BACKGROUND,
  EASEL_ACTIVE_BOARD_SETTING_KEY,
  easelBackground
} from '@hira-ng/shared-types/src/easel.mjs'
import type {
  CardKind,
  EaselBackgroundId,
  EaselBoard,
  EaselCard,
  EaselStroke,
  StrokeKind,
  StrokePoint
} from '@hira-ng/shared-types/src/easel.mjs'
// 「算不算普通网页」的唯一判据（钉链接卡片只收 http(s)）。
import { isHttpUrl } from '@hira-ng/shared-types/src/url-protocols.mjs'
// 图标与 rail / 面板**同一套**（ui-common 的图标注册表）：一排按钮里风格一致，
// 也不会因系统字体不同而高矮不齐（字符图标的老毛病）。
import { iconByName, setDragItem, getDragItem, hasDragItem, pickDropEffect } from '@hira-ng/ui-common'
import { createEaselStore } from "../shared/store"
import { injectEaselStyles, WINDOW_CSS } from "../shared/styles"

export function injectEaselWindowStyles(doc: Document): void {
  injectEaselStyles(doc, WINDOW_CSS)
}

const SVG_NS = 'http://www.w3.org/2000/svg'
const ZOOM_MIN = 0.25
const ZOOM_MAX = 2.5
/** 每次点 +/− 的缩放倍率（与滚轮同一档，手感一致）。 */
const ZOOM_STEP = 1.25
const HISTORY_MAX = 30
/**
 * 背景网格的**世界步长**（世界坐标 px）与它在**屏幕上**允许的点距区间。
 *
 * 网格点必须跟着缩放走，否则缩放只是"卡片变大变小"，画布本身毫无参照。但纯按 zoom 缩
 * 会两头坏掉：缩到 25% 时点距只剩 6px（糊成一片噪点）、放到 250% 又稀到 60px（看不出
 * 是网格）。所以把**屏幕点距**夹在 [MIN, MAX]：越界就把世界步长翻倍 / 减半 ——
 * 于是任何缩放下点距都落在一个舒服的区间里，而相位恒等于平移量，世界原点永远是格点。
 */
const GRID_SPACING = 24
const GRID_MIN_PX = 12
const GRID_MAX_PX = 48

type ToolId = 'select' | 'pen' | 'line' | 'arrow' | 'rect' | 'ellipse' | 'connector' | 'eraser'

interface EaselSettingsPort {
  get(key: string): Promise<unknown>
  set(key: string, value: unknown): Promise<unknown>
}

type EaselWindowContext = Omit<PanelContext, 'clients' | 'openUrl' | 'confirm'> & {
  clients?: (PanelContext['clients'] & { settings?: EaselSettingsPort }) | null
  openUrl?: (url: string) => unknown
  confirm?: (options: { title?: string; message?: string }) => Promise<boolean> | boolean
}

interface StrokeElementEntry {
  el: SVGElement
  stroke: EaselStroke
  sig: string
}

interface CardElementEntry {
  el: HTMLDivElement
  card: EaselCard
  geo: string
}

interface BoardRowEntry {
  row: HTMLDivElement
  nm: HTMLDivElement
  sub: HTMLDivElement
  sig: string
}

interface HistoryEntry {
  boardId: string
  cards: EaselCard[]
  strokes: EaselStroke[]
}

type DragState =
  | { mode: 'move'; card: EaselCard; startX: number; startY: number; originX: number; originY: number; el: HTMLDivElement }
  | { mode: 'resize'; card: EaselCard; startX: number; startY: number; originW: number; originH: number; el: HTMLDivElement }
  | { mode: 'draw'; stroke: EaselStroke; el: SVGElement; start: StrokePoint }
  | { mode: 'connect'; from: string; to: string }
  | { mode: 'pan'; startX: number; startY: number; originX: number; originY: number }

interface ExternalDragItem {
  kind?: string
  url?: string
  title?: string
  text?: string
}

/**
 * 工具栏的**展示元数据**（文案 + 图标名）。
 * 顺序不在这里 —— 唯一真源是 shared-types/easel#TOOL_ORDER，下面按它派生。
 * 图标名对应 `@hira-ng/ui-common` 的 ICON_REGISTRY。
 */
const TOOL_META: Record<ToolId, { label: string; icon: string }> = {
  select: { label: '选择 / 移动', icon: 'MousePointer2' },
  pen: { label: '画笔（手绘）', icon: 'Pencil' },
  line: { label: '直线', icon: 'Minus' },
  arrow: { label: '箭头', icon: 'ArrowUpRight' },
  rect: { label: '矩形', icon: 'Square' },
  ellipse: { label: '椭圆', icon: 'Circle' },
  connector: { label: '连线（从一张卡片拖到另一张）', icon: 'Spline' },
  eraser: { label: '橡皮（点笔迹即删）', icon: 'Eraser' }
}
const TOOLS = TOOL_ORDER.flatMap((key) => key in TOOL_META ? [{ id: key as ToolId, ...TOOL_META[key as ToolId] }] : [])
/** 可在画布上「拖出一笔」的工具 = 除连线外的全部笔迹类型（连线靠拖卡片建立）。 */
const DRAW_TOOLS = new Set<StrokeKind>(STROKE_KINDS.filter((kind) => kind !== 'connector'))

/** 卡片头部的类型色点（一眼分清便签 / 链接 / 图片）。类型文案真源在 easel.mjs。 */
const KIND_COLORS = { note: '#d97706', link: '#2563eb', image: '#059669' }
/** 自动整理的列宽 / 行高（够放下一张默认卡片 + 间距）。 */
const LAYOUT_COL = 360
const LAYOUT_ROW = 240

/**
 * @param {Document} doc
 * @param {EaselWindowContext} [ctx]
 */
export function createEaselWindow(doc: Document, ctx: PanelContext = {}) {
  const windowCtx = ctx as EaselWindowContext
  const settings = windowCtx.clients?.settings || null
  const store = createEaselStore(settings || { get: async () => null, set: async () => ({}) })

  // ── 视图与编辑状态 ──────────────────────────────────────────────────
  let activeId = ''
  let panX = 0
  let panY = 0
  let zoom = 1
  let tool: ToolId = 'select'
  let color = STROKE_COLORS[0]
  let strokeWidth = STROKE_WIDTHS[1]
  let selectedCardId = ''
  let selectedStrokeId = ''
  /** 拖动 / 缩放 / 画图 / 平移中的临时状态。 */
  let drag: DragState | null = null
  /**
   * 「已上膛」的卡片元素（原生 HTML5 拖拽源）。
   *
   * 卡片本身要能被鼠标拖动，若常驻 `draggable=true`，原生拖拽会抢走移动手势。
   * 所以只有当用户按住卡片头部的**色点手柄**时才临时上膛，松开 / 拖完立刻卸下。
   */
  let cardDragArmed: HTMLElement | null = null
  /** 撤销栈（每条记录带 boardId，避免切板后错用另一块板的快照）。 */
  const history: HistoryEntry[] = []
  /**
   * 增量渲染的两张"现状表"（`id → { el, 记录对象, 签名 }`）。
   *
   * 渲染**不重建**节点：卡片层里攥着 textarea / img，笔迹层里攥着 SVG 路径。
   * 重建的代价不只是造 DOM —— 正在输入的便签会掉光标、图片会重新解码、几十上百个
   * 节点每加一笔就重造一遍（O(n²)）。表里的记录对象用来判断"这条还是不是原来那条"
   * （撤销 / 换画板会整体换成新对象，那时必须重建，否则闭包指向已废弃的旧对象）。
   */
  const strokeEls = new Map<string, StrokeElementEntry>()
  const cardEls = new Map<string, CardElementEntry>()

  // ── DOM 骨架 ────────────────────────────────────────────────────────
  const root = doc.createElement('div')
  root.className = 'hira-easel-window'
  const toolbar = doc.createElement('div')
  toolbar.className = 'hira-easel-toolbar'
  const canvas = doc.createElement('div')
  canvas.className = 'hira-easel-canvas'
  const world = doc.createElement('div')
  world.className = 'hira-easel-world'
  const svg = doc.createElementNS(SVG_NS, 'svg')
  svg.setAttribute('class', 'hira-easel-svg')
  const cardsLayer = doc.createElement('div')

  // 箭头 marker：`context-stroke` 让箭头颜色跟着线走（不用为每种颜色各建一个 marker）。
  const defs = doc.createElementNS(SVG_NS, 'defs')
  const marker = doc.createElementNS(SVG_NS, 'marker')
  marker.setAttribute('id', 'hira-easel-arrow')
  marker.setAttribute('viewBox', '0 0 10 10')
  marker.setAttribute('refX', '9')
  marker.setAttribute('refY', '5')
  marker.setAttribute('markerWidth', '6')
  marker.setAttribute('markerHeight', '6')
  marker.setAttribute('orient', 'auto-start-reverse')
  const markerPath = doc.createElementNS(SVG_NS, 'path')
  markerPath.setAttribute('d', 'M0 0L10 5L0 10z')
  markerPath.setAttribute('fill', 'context-stroke')
  marker.appendChild(markerPath)
  defs.appendChild(marker)
  svg.appendChild(defs)

  world.appendChild(svg)
  world.appendChild(cardsLayer)
  canvas.appendChild(world)
  root.appendChild(toolbar)
  root.appendChild(canvas)

  /** 按名字取图标（拿不到就返回 null，按钮退化成纯文字，不会崩）。 */
  function iconFor(name: string, size = 16) {
    try {
      const el = iconByName(name, doc, { size })
      return el || null
    } catch (_) { return null }
  }
  function button(label: string, onClick: (event: MouseEvent) => void, cls = '') {
    const btn = doc.createElement('button')
    btn.className = `hira-easel-btn${cls ? ' ' + cls : ''}`
    btn.type = 'button'
    btn.textContent = label
    btn.onclick = onClick
    return btn
  }
  /** 图标按钮：图标 + （可选）文字。图标缺失时留文字，绝不留空按钮。 */
  function iconButton(iconName: string, label: string, onClick: (event: MouseEvent) => void, cls = '') {
    const btn = button(label || '', onClick, cls)
    const icon = iconFor(iconName)
    if (icon) {
      btn.textContent = ''
      btn.appendChild(icon)
      if (label) {
        const text = doc.createElement('span')
        text.textContent = label
        text.style.marginLeft = '6px'
        btn.appendChild(text)
        btn.style.display = 'inline-flex'
        btn.style.alignItems = 'center'
      }
    }
    if (label) btn.title = label
    return btn
  }
  function sep() {
    const el = doc.createElement('span')
    el.className = 'hira-easel-sep'
    return el
  }

  // ── 工具栏 ──────────────────────────────────────────────────────────
  const toolButtons = new Map()
  const swatches = new Map()
  const widthButtons = new Map()
  const zoomLabel = doc.createElement('span')
  zoomLabel.className = 'hira-easel-zoom'
  // 缩放三件套：− / 百分比 / +。图标走 ui-common 的同一套 SVG（与工具栏其余按钮同源，
  // 不用 "+" "−" 字符字形 —— 字符会随系统字体高矮不齐，正是这套 SVG 要解决的问题）。
  const zoomOutBtn = iconButton('Minus', '', () => zoomBy(1 / ZOOM_STEP), 'icon')
  zoomOutBtn.title = '缩小（Ctrl+滚轮）'
  const zoomInBtn = iconButton('Plus', '', () => zoomBy(ZOOM_STEP), 'icon')
  zoomInBtn.title = '放大（Ctrl+滚轮）'
  const undoBtn = iconButton('Undo2', '', () => undo())
  undoBtn.title = '撤销（Ctrl+Z）'
  const delBtn = iconButton('Trash2', '', () => deleteSelection(), 'danger')
  delBtn.title = '删除选中的卡片或笔迹（Delete）'

  /**
   * 画板下拉是**自绘**的（不是 `<select>`）：原生下拉的弹层是系统窗口，
   * 在无边框子窗口里既不跟主题、也容易被窗口焦点变化打断（"点了打不开"）。
   * 自绘后开合完全在我们手里，样式也跟工具栏一致。
   */
  const dd = doc.createElement('div')
  dd.className = 'hira-easel-dd'
  const ddBtn = doc.createElement('button')
  ddBtn.className = 'hira-easel-btn hira-easel-dd-btn'
  ddBtn.type = 'button'
  ddBtn.title = '切换画板'
  const ddName = doc.createElement('span')
  ddName.className = 'nm'
  ddBtn.appendChild(ddName)
  const ddCaret = iconFor('ChevronDown', 14)
  if (ddCaret) ddBtn.appendChild(ddCaret)
  const ddMenu = doc.createElement('div')
  ddMenu.className = 'hira-easel-menu'
  ddMenu.hidden = true
  ddBtn.onclick = (event: MouseEvent) => { event.stopPropagation(); ddMenu.hidden = !ddMenu.hidden }
  dd.appendChild(ddBtn)
  dd.appendChild(ddMenu)
  // 点空白 / 点别处收起（捕获阶段只做"收起"，不拦截事件，页面其余交互照常）。
  doc.addEventListener('mousedown', (event: MouseEvent) => {
    const target = event.target instanceof Node ? event.target : null
    if (!ddMenu.hidden && !dd.contains(target)) ddMenu.hidden = true
  }, true)

  toolbar.appendChild(dd)
  toolbar.appendChild(button('新建', () => newBoard(), ''))
  toolbar.appendChild(iconButton('Pencil', '重命名', () => renameBoard(), ''))
  toolbar.appendChild(iconButton('Trash2', '删除画板', () => removeBoard(), 'danger'))
  toolbar.appendChild(sep())

  for (const t of TOOLS) {
    const btn = doc.createElement('button')
    btn.className = 'hira-easel-tool'
    btn.type = 'button'
    btn.title = t.label
    const icon = iconFor(t.icon)
    if (icon) btn.appendChild(icon)
    else btn.textContent = '·'
    btn.onclick = () => setTool(t.id)
    toolButtons.set(t.id, btn)
    toolbar.appendChild(btn)
  }
  toolbar.appendChild(sep())

  const swatchBox = doc.createElement('div')
  swatchBox.className = 'hira-easel-swatches'
  for (const c of STROKE_COLORS) {
    const sw = doc.createElement('button')
    sw.className = 'hira-easel-swatch'
    sw.type = 'button'
    sw.style.background = c
    sw.title = c
    sw.onclick = () => setColor(c)
    swatches.set(c, sw)
    swatchBox.appendChild(sw)
  }
  toolbar.appendChild(swatchBox)

  // 线宽：三个圆点（比下拉直观，也少一个原生控件）。
  const widthBox = doc.createElement('div')
  widthBox.className = 'hira-easel-width'
  for (const w of STROKE_WIDTHS) {
    const b = doc.createElement('button')
    b.type = 'button'
    b.title = `线宽 ${w}`
    const dot = doc.createElement('span')
    dot.className = 'dot'
    const size = Math.min(12, 3 + w)
    dot.style.width = `${size}px`
    dot.style.height = `${size}px`
    b.appendChild(dot)
    b.onclick = () => setStrokeWidth(w)
    widthButtons.set(w, b)
    widthBox.appendChild(b)
  }
  toolbar.appendChild(widthBox)

  /**
   * 画布背景下拉（自绘，与画板下拉同构）。
   *
   * 背景是**画板内容**（随画板持久化），不跟随主题：切主题只换工具栏皮肤，
   * 画布这张"纸"保持用户选的颜色。
   */
  const bgdd = doc.createElement('div')
  bgdd.className = 'hira-easel-dd'
  const bgBtn = doc.createElement('button')
  bgBtn.className = 'hira-easel-btn hira-easel-bg-btn'
  bgBtn.type = 'button'
  bgBtn.title = '画布背景'
  const bgDot = doc.createElement('span')
  bgDot.className = 'hira-easel-bg-dot'
  bgBtn.appendChild(bgDot)
  const bgCaret = iconFor('ChevronDown', 14)
  if (bgCaret) bgBtn.appendChild(bgCaret)
  const bgMenu = doc.createElement('div')
  bgMenu.className = 'hira-easel-menu'
  bgMenu.hidden = true
  bgBtn.onclick = (event: MouseEvent) => { event.stopPropagation(); bgMenu.hidden = !bgMenu.hidden }
  bgdd.appendChild(bgBtn)
  bgdd.appendChild(bgMenu)
  doc.addEventListener('mousedown', (event: MouseEvent) => {
    const target = event.target instanceof Node ? event.target : null
    if (!bgMenu.hidden && !bgdd.contains(target)) bgMenu.hidden = true
  }, true)
  toolbar.appendChild(bgdd)

  toolbar.appendChild(sep())
  toolbar.appendChild(iconButton('StickyNote', '便签', () => addCard('note'), ''))
  toolbar.appendChild(iconButton('Plus', '子节点', () => {
    const board = currentBoard()
    const id = selectedCardId || (board?.cards.length ? board.cards[0].id : '')
    if (id) addChildCard(id)
  }, ''))
  toolbar.appendChild(iconButton('Network', '自动整理', () => autoLayout(), ''))
  toolbar.appendChild(sep())
  toolbar.appendChild(undoBtn)
  toolbar.appendChild(delBtn)
  const grow = doc.createElement('span')
  grow.className = 'hira-easel-grow'
  toolbar.appendChild(grow)
  const zoombar = doc.createElement('div')
  zoombar.className = 'hira-easel-zoombar'
  zoombar.appendChild(zoomOutBtn)
  zoombar.appendChild(zoomLabel)
  zoombar.appendChild(zoomInBtn)
  toolbar.appendChild(zoombar)
  toolbar.appendChild(iconButton('RefreshCw', '复位视图', () => { panX = 0; panY = 0; zoom = 1; applyTransform() }, ''))

  // ── 基础 ────────────────────────────────────────────────────────────
  function currentBoard() { return store.getBoard(activeId) }
  function cardById(id: string): EaselCard | null {
    const board = currentBoard()
    return board ? (board.cards.find((card) => card.id === id) || null) : null
  }

  function applyTransform() {
    world.style.transform = `translate(${panX}px, ${panY}px) scale(${zoom})`
    zoomLabel.textContent = `${Math.round(zoom * 100)}%`
    // 到顶 / 到底时把对应那颗按钮置灰：留着一个点了没反应的按钮是误导。
    if (zoomOutBtn) zoomOutBtn.disabled = zoom <= ZOOM_MIN + 1e-6
    if (zoomInBtn) zoomInBtn.disabled = zoom >= ZOOM_MAX - 1e-6
    updateGrid()
  }

  /**
   * 网格点跟着**缩放**（和**平移**）一起走 —— 画布是无限的，网格得像贴在世界上一样。
   *
   * 为什么用 `background-size` + `background-position` 而不是把网格画进 `world` 里：
   * 网格是**无限**的，画进 world 就得画一张足够大的图；而 CSS 背景天然平铺、
   * 零 DOM 成本，一帧只改两个属性。
   *
   * 换算：世界里 (wx, wy) 的屏幕位置是 `panX + wx*zoom`，所以世界步长 `step` 对应屏幕
   * 点距 `step*zoom`，而相位（相对视口左上角的第一个格点偏移）= 平移量对点距取模。
   */
  function updateGrid() {
    let step = GRID_SPACING
    while (step * zoom < GRID_MIN_PX) step *= 2
    while (step * zoom > GRID_MAX_PX) step /= 2
    const spacing = step * zoom
    const ox = spacing > 0 ? ((panX % spacing) + spacing) % spacing : 0
    const oy = spacing > 0 ? ((panY % spacing) + spacing) % spacing : 0
    canvas.style.backgroundSize = `${spacing}px ${spacing}px`
    canvas.style.backgroundPosition = `${ox}px ${oy}px`
  }

  /** 把当前画板的背景色 / 网格点色写到画布上（**不读主题变量**）。 */
  function applyBackground() {
    const board = currentBoard()
    const bg = easelBackground(board ? board.background : EASEL_DEFAULT_BACKGROUND)
    canvas.style.backgroundColor = bg.color
    canvas.style.backgroundImage = `radial-gradient(${bg.grid} 1px, transparent 1px)`
  }

  /**
   * 切换画布背景（写入画板并落盘）。
   *
   * 顺手做墨色对比度兜底：切到黑板时若还是默认黑笔就换白笔，离开黑板时白笔换回黑笔。
   * 只动**默认笔**，用户自己选的彩色不动 —— 那是明确意图。
   */
  function setBackground(id: EaselBackgroundId) {
    const board = currentBoard()
    if (!board) return
    const next = EASEL_BACKGROUND_IDS.includes(id) ? id : EASEL_DEFAULT_BACKGROUND
    if (board.background !== next) {
      board.background = next
      store.scheduleSave()
      const ink = easelBackground(next).ink
      if (ink === '#ffffff' && color === STROKE_COLORS[0]) setColor('#ffffff')
      else if (ink !== '#ffffff' && color === '#ffffff') setColor(STROKE_COLORS[0])
      applyBackground()
    }
    renderBackgroundMenu()
  }

  /** 背景选项行（常量集合，建一次就够；render 在新建卡片 / 画完一笔时都会走到）。 */
  const bgRows = new Map<EaselBackgroundId, HTMLDivElement>()
  function renderBackgroundMenu() {
    const board = currentBoard()
    const current = easelBackground(board ? board.background : EASEL_DEFAULT_BACKGROUND)
    bgDot.style.background = current.color
    if (bgRows.size === 0) {
      for (const item of EASEL_BACKGROUNDS) {
        const row = doc.createElement('div')
        row.className = 'item bg'
        const dot = doc.createElement('span')
        dot.className = 'hira-easel-bg-dot'
        dot.style.background = item.color
        const nm = doc.createElement('div')
        nm.className = 'nm'
        nm.textContent = item.label
        row.appendChild(dot)
        row.appendChild(nm)
        row.onclick = () => { bgMenu.hidden = true; setBackground(item.id) }
        bgRows.set(item.id, row)
        bgMenu.appendChild(row)
      }
    }
    for (const [id, row] of bgRows) row.classList.toggle('is-active', id === current.id)
  }

  /**
   * 改缩放，并使 `(anchorX, anchorY)`（**视口坐标**）下的那个世界点在缩放前后停在原处。
   * 滚轮用光标、+/− 按钮用画布正中 —— 两处共用这一份换算，不会出现"按钮缩放会跑偏"。
   */
  function setZoom(next: number, anchorX: number, anchorY: number) {
    const clamped = Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, next))
    if (clamped === zoom) return
    panX = anchorX - (anchorX - panX) * (clamped / zoom)
    panY = anchorY - (anchorY - panY) * (clamped / zoom)
    zoom = clamped
    applyTransform()
  }

  /** 按倍率缩放，锚点取**画布正中**（按钮的直觉位置：放大时中心那点不动）。 */
  function zoomBy(factor: number) {
    const rect = canvas.getBoundingClientRect()
    setZoom(zoom * factor, rect.width / 2, rect.height / 2)
  }

  function toWorld(clientX: number, clientY: number) {
    const rect = canvas.getBoundingClientRect()
    return { x: (clientX - rect.left - panX) / zoom, y: (clientY - rect.top - panY) / zoom }
  }

  function setTool(next: ToolId) {
    tool = next
    for (const [id, btn] of toolButtons) btn.classList.toggle('is-active', id === tool)
    canvas.classList.toggle('is-drawing', tool !== 'select' && tool !== 'eraser')
    if (tool !== 'select') clearSelection()
  }
  function setColor(next: string) {
    color = next
    for (const [c, sw] of swatches) sw.classList.toggle('is-active', c === color)
  }
  function setStrokeWidth(next: number) {
    strokeWidth = Number(next) || STROKE_WIDTHS[1]
    for (const [w, btn] of widthButtons) btn.classList.toggle('is-active', w === strokeWidth)
  }

  function clearSelection() {
    selectedCardId = ''
    selectedStrokeId = ''
    for (const el of cardsLayer.children) el.classList.remove('is-selected')
    for (const entry of strokeEls.values()) entry.el.classList.remove('is-selected')
    delBtn.disabled = true
  }

  // ── 撤销 ────────────────────────────────────────────────────────────
  /**
   * 存一步撤销点。
   *
   * 为什么是**逐条浅拷贝**，而不是 `JSON.parse(JSON.stringify(...))`：
   * 卡片 / 笔迹记录本身是扁平的（几何 + 文本 + dataURL），撤销只需要"回到这份值"，
   * 不需要连内层也各存一份。深拷贝会为历史里**每个图片卡**的 base64 再复制一整串
   * （30 步 × 每张几 MB 的 dataURL），浅拷贝只多出 N 个小对象，字符串按引用共享。
   * 唯一被共享的引用是笔迹的 `points` 数组 —— 它只在新笔迹落定前被就地追加
   * （见 updateDraw / commitDraw），已入板的笔迹不再改动，因此共享是安全的。
   */
  function snapshot() {
    const board = currentBoard()
    if (!board) return
    history.push({
      boardId: board.id,
      cards: board.cards.map((card) => ({ ...card })),
      strokes: board.strokes.map((stroke) => ({ ...stroke }))
    })
    if (history.length > HISTORY_MAX) history.shift()
    undoBtn.disabled = history.length === 0
  }
  function undo() {
    const prev = history.pop()
    undoBtn.disabled = history.length === 0
    if (!prev) return
    const board = store.getBoard(prev.boardId)
    if (!board) return
    board.cards = prev.cards
    board.strokes = prev.strokes
    if (activeId !== board.id) { activeId = board.id }
    clearSelection()
    store.scheduleSave()
    render()
  }

  // ── 渲染 ────────────────────────────────────────────────────────────
  function buildStrokeEl(stroke: EaselStroke): SVGElement | null {
    const geom = strokeGeometry(stroke, cardById)
    if (!geom) return null
    const el = doc.createElementNS(SVG_NS, geom.tag)
    for (const [key, value] of Object.entries(geom.attrs)) el.setAttribute(key, String(value))
    el.setAttribute('class', 'hira-stroke' + (stroke.id === selectedStrokeId ? ' is-selected' : ''))
    el.setAttribute('stroke', stroke.color)
    el.setAttribute('stroke-width', String(stroke.width))
    if (stroke.kind === 'arrow' || stroke.kind === 'connector') el.setAttribute('marker-end', 'url(#hira-easel-arrow)')
    el.dataset.strokeId = stroke.id
    return el
  }

  /**
   * 连线的"外观签名"：两端卡片当前几何。
   * 端点没动 → 一个属性都不用改；端点在拖（见 updateConnectorsFor）→ 那条路已经就地
   * 改过 `d` 并同步了签名，这里同样什么都不做。非连线笔迹的几何是死的，签名恒为空。
   */
  function strokeSig(stroke: EaselStroke): string {
    if (stroke.kind !== 'connector') return ''
    const key = (card: EaselCard | null) => (card ? `${card.x},${card.y},${card.w},${card.h}` : '-')
    return `${key(cardById(stroke.from))}|${key(cardById(stroke.to))}`
  }

  /**
   * 笔迹层**增量**渲染（与卡片层同一套路：复用节点，只处理真正变了的）。
   *
   * "清空重建"每画一笔都要把整块画板的 SVG 路径重造一遍 —— 笔迹越多越慢，是典型的
   * O(n²)，大画板上手绘会明显跟不上手。这里按 id 复用：新增才建节点，撤销（记录对象
   * 被整体换掉）才重建，连线在端点卡片动过之后只改一条 `d`。
   * 叠放仍按 z 升序：用一个"游标"把已有节点对齐到目标顺序，顺序没变时零 DOM 操作。
   */
  function renderStrokes() {
    const board = currentBoard()
    const alive = new Set()
    let cursor = defs.nextSibling
    if (board) {
      const sorted = [...board.strokes].sort((a, b) => (Number(a.z) || 0) - (Number(b.z) || 0))
      for (const stroke of sorted) {
        let entry = strokeEls.get(stroke.id)
        // 记录对象换了（撤销 / 换画板）：旧节点里的引用已作废，必须重建
        if (entry && entry.stroke !== stroke) {
          // 游标可能正指着这个节点 —— 先挪开，否则下面的 insertBefore 会插到已摘除的节点前（抛错）
          if (entry.el === cursor) cursor = cursor!.nextSibling
          entry.el.remove()
          strokeEls.delete(stroke.id)
          entry = undefined
        }
        if (!entry) {
          const el = buildStrokeEl(stroke)
          if (!el) continue // 端点卡片不存在的连线：跳过（与原实现一致）
          entry = { el, stroke, sig: strokeSig(stroke) }
          strokeEls.set(stroke.id, entry)
        } else {
          const sig = strokeSig(stroke)
          if (entry.sig !== sig) {
            entry.sig = sig
            const geom = strokeGeometry(stroke, cardById)
            if (geom && geom.attrs && geom.attrs.d != null) entry.el.setAttribute('d', String(geom.attrs.d))
          }
        }
        alive.add(stroke.id)
        if (entry.el === cursor) cursor = cursor!.nextSibling
        else svg.insertBefore(entry.el, cursor)
      }
    }
    // 已删除的笔迹：摘掉节点（defs 是箭头 marker，永不参与）
    for (const [id, entry] of strokeEls) {
      if (alive.has(id)) continue
      entry.el.remove()
      strokeEls.delete(id)
    }
  }

  /** 拖卡片时只更新相关连线（全量重绘会掉帧）。 */
  function updateConnectorsFor(cardId: string) {
    const board = currentBoard()
    if (!board) return
    for (const stroke of board.strokes) {
      if (stroke.kind !== 'connector') continue
      if (stroke.from !== cardId && stroke.to !== cardId) continue
      const entry = strokeEls.get(stroke.id)
      if (!entry) continue
      const geom = strokeGeometry(stroke, cardById)
      if (geom && geom.attrs.d) entry.el.setAttribute('d', String(geom.attrs.d))
      entry.sig = strokeSig(stroke) // 让下一次 renderStrokes 知道这条已经是最新的
    }
  }

  /**
   * 画板卡片 → 统一拖拽载荷（`@hira-ng/shared-types/src/drag-item.mjs`）。
   * 便签 / 链接 / 图片分别映射成 note / page / image —— 集锦与标签栏只看这个，不认画板内部结构。
   */
  function easelDragPayload(card: EaselCard) {
    const text = String(card.text || '')
    const title = card.kind === 'link'
      ? (card.title || card.url || '')
      : card.kind === 'image'
        ? (card.title || '图片')
        : text.split('\n')[0].slice(0, 80)
    return {
      domain: 'easel',
      id: card.id,
      kind: card.kind === 'link' ? 'page' : card.kind === 'image' ? 'image' : 'note',
      url: card.url || '',
      title,
      // 图片卡的数据是 dataURL（没有 url）：作为图片资产交给落点，别降级成一段文本。
      text: card.kind === 'image' ? String(card.data || '') : text
    }
  }

  function armCardDrag(el: HTMLElement) {
    cardDragArmed = el
    el.draggable = true
  }
  function disarmCardDrag() {
    if (!cardDragArmed) return
    cardDragArmed.draggable = false
    cardDragArmed = null
  }

  function cardElement(card: EaselCard): HTMLDivElement {
    const el = doc.createElement('div')
    el.className = `hira-easel-card${card.id === selectedCardId ? ' is-selected' : ''}`
    el.dataset.cardId = card.id
    el.style.cssText = `left:${card.x}px; top:${card.y}px; width:${card.w}px; height:${card.h}px; z-index:${Number(card.z) || 0};`

    // 统一协议拖拽源：把这张卡拖到集锦 / 标签栏 / 书签栏。
    // `draggable` 只在按住上面的色点手柄时临时打开（见 armCardDrag），否则会抢走移动手势。
    el.addEventListener('dragstart', (event: DragEvent) => {
      const dataTransfer = event.dataTransfer
      if (!dataTransfer) return
      setDragItem(dataTransfer, easelDragPayload(card), {
        effectAllowed: 'copy',
        // 链接卡写 URL —— 拖到网页 / 地址栏也能直接用；其它卡写协议前缀兜底。
        plain: card.kind === 'link' ? 'url' : 'prefix'
      })
      el.classList.add('is-dragging')
      event.stopPropagation()
    })
    el.addEventListener('dragend', () => {
      disarmCardDrag()
      el.classList.remove('is-dragging')
    })

    const head = doc.createElement('div')
    head.className = 'hira-easel-card-head'
    // 类型色点：一眼分清便签 / 链接 / 图片（比文字标签更快扫读）。
    const kindDot = doc.createElement('span')
    kindDot.className = 'dot is-grip'
    kindDot.style.background = KIND_COLORS[card.kind] || '#888'
    // 色点就是跨面板拖拽手柄：按下去先给卡片"上膛"，再拖出窗口。
    // 必须 stopPropagation —— 头部还有"拖动卡片"的 mousedown，两者不能同时开工。
    kindDot.title = '拖到集锦 / 标签栏 / 书签栏'
    kindDot.addEventListener('mousedown', (event: MouseEvent) => {
      if (event.button !== 0) return
      event.stopPropagation()
      armCardDrag(el)
    })
    head.appendChild(kindDot)
    const kind = doc.createElement('span')
    kind.className = 'kind'
    kind.textContent = CARD_KIND_LABELS[card.kind] || card.kind
    head.appendChild(kind)
    const headGrow = doc.createElement('span')
    headGrow.className = 'grow'
    head.appendChild(headGrow)
    // 「+ 子节点」：思维导图的核心动作 —— 建一张新卡片并**自动连线**过来。
    const addChild = doc.createElement('button')
    addChild.className = 'act'
    addChild.type = 'button'
    addChild.title = '新建子节点（自动连线）'
    const plusIcon = iconFor('Plus', 13)
    if (plusIcon) addChild.appendChild(plusIcon)
    else addChild.textContent = '+'
    addChild.onclick = (event: MouseEvent) => { event.stopPropagation(); addChildCard(card.id) }
    head.appendChild(addChild)
    const del = doc.createElement('button')
    del.className = 'act del'
    del.type = 'button'
    del.title = '删除这张卡片（连带它的连线）'
    const trashIcon = iconFor('Trash2', 13)
    if (trashIcon) del.appendChild(trashIcon)
    else del.textContent = '×'
    del.onclick = (event: MouseEvent) => { event.stopPropagation(); snapshot(); removeCard(card.id) }
    head.appendChild(del)
    el.appendChild(head)

    const body = doc.createElement('div')
    body.className = 'hira-easel-card-body'
    if (card.kind === 'note') {
      const area = doc.createElement('textarea')
      area.value = card.text
      area.placeholder = '写点什么…'
      area.oninput = () => { card.text = area.value.slice(0, 20000); store.scheduleSave() }
      body.appendChild(area)
    } else if (card.kind === 'link') {
      const title = doc.createElement('div')
      title.textContent = card.title || card.url
      title.style.fontWeight = '600'
      body.appendChild(title)
      const link = doc.createElement('a')
      link.textContent = card.url
      link.href = '#'
      link.onclick = (event: MouseEvent) => {
        event.preventDefault()
        event.stopPropagation()
        if (typeof windowCtx.openUrl === 'function') windowCtx.openUrl(card.url)
        else { try { doc.defaultView!.navigator.clipboard.writeText(card.url) } catch (_) {} }
      }
      body.appendChild(link)
    } else {
      const img = doc.createElement('img')
      img.src = card.data
      img.alt = card.title || '画板图片'
      body.appendChild(img)
    }
    el.appendChild(body)

    const resizer = doc.createElement('div')
    resizer.className = 'hira-easel-resize'
    el.appendChild(resizer)

    // 标题栏起拖（**仅选择工具**；其它工具下让事件冒到画布去做绘图）。
    head.addEventListener('mousedown', (event: MouseEvent) => {
      if (event.button !== 0 || tool !== 'select') return
      event.preventDefault()
      event.stopPropagation()
      snapshot() // 拖动前存一份：Ctrl+Z 要能回到拖动前的位置
      selectCard(card.id)
      drag = { mode: 'move', card, startX: event.clientX, startY: event.clientY, originX: card.x, originY: card.y, el }
    })
    resizer.addEventListener('mousedown', (event: MouseEvent) => {
      if (event.button !== 0 || tool !== 'select') return
      event.preventDefault()
      event.stopPropagation()
      snapshot()
      selectCard(card.id)
      drag = { mode: 'resize', card, startX: event.clientX, startY: event.clientY, originW: card.w, originH: card.h, el }
    })
    el.addEventListener('mousedown', (event: MouseEvent) => {
      if (tool !== 'select') return // 绘图工具下不抢事件，画布要能画到卡片上方
      selectCard(card.id)
      event.stopPropagation()
    })
    return el
  }

  /**
   * 卡片层**增量**渲染。
   *
   * 为什么不是"清空重建"：新建卡片、连线、自动整理都会走一遍 render()，而重建意味着
   * 整块画板的 textarea / img 全部重造 —— 正在输入的便签掉光标、图片重新解码，卡片
   * 一多（上限 200 张）每点一次就卡一下。这里按 id 复用节点，只同步几何 / 叠放 / 选中态。
   */
  function renderCards() {
    const board = currentBoard()
    if (!board) {
      cardEls.clear()
      cardsLayer.textContent = ''
      return
    }
    const alive = new Set()
    for (const card of board.cards) {
      alive.add(card.id)
      const geo = `${card.x}|${card.y}|${card.w}|${card.h}|${Number(card.z) || 0}`
      let entry = cardEls.get(card.id)
      // 记录对象换了（撤销 / 换画板 / 重新导入）：节点里的闭包攥着旧对象，必须重建
      if (entry && entry.card !== card) {
        entry.el.remove()
        cardEls.delete(card.id)
        entry = undefined
      }
      if (!entry) {
        const el = cardElement(card)
        cardsLayer.appendChild(el)
        entry = { el, card, geo }
        cardEls.set(card.id, entry)
      } else if (entry.geo !== geo) {
        entry.geo = geo
        entry.el.style.cssText =
          `left:${card.x}px; top:${card.y}px; width:${card.w}px; height:${card.h}px; z-index:${Number(card.z) || 0};`
      }
      entry.el.classList.toggle('is-selected', card.id === selectedCardId)
    }
    // 已删除的卡片：摘掉节点
    for (const [id, entry] of cardEls) {
      if (alive.has(id)) continue
      entry.el.remove()
      cardEls.delete(id)
    }
  }

  function render() {
    const board = currentBoard() || (store.boards.length ? store.boards[0] : null)
    if (!board) activeId = ''
    else if (board.id !== activeId) activeId = board.id
    renderBoardMenu()
    renderBackgroundMenu()
    applyBackground()
    renderStrokes()
    renderCards()
    applyTransform()
    delBtn.disabled = !selectedCardId && !selectedStrokeId
  }

  /** 画板下拉的行现状表（`id → { row, nm, sub, sig }`）；每行只在其文案真的变了时才写。 */
  const boardRows = new Map()

  /** 自绘下拉的内容（当前画板名 + 全部画板）。 */
  function renderBoardMenu() {
    const current = currentBoard()
    ddName.textContent = current ? current.name : '（没有画板）'
    const alive = new Set()
    for (const board of store.boards) {
      alive.add(board.id)
      // 行的可见内容只有这三样：名字、两个计数、是否当前板
      const sig = `${board.name}|${board.cards.length}|${board.strokes.length}`
      let entry = boardRows.get(board.id)
      if (!entry) {
        const item = doc.createElement('div')
        item.className = 'item'
        const meta = doc.createElement('div')
        meta.className = 'meta'
        const nm = doc.createElement('div')
        nm.className = 'nm'
        const sub = doc.createElement('div')
        sub.className = 'sub'
        meta.appendChild(nm)
        meta.appendChild(sub)
        item.appendChild(meta)
        // 只读 board.id：行被复用时闭包指向的旧对象也不会带偏切换目标
        item.onclick = () => {
          activeId = board.id
          ddMenu.hidden = true
          clearSelection()
          render()
        }
        ddMenu.appendChild(item)
        entry = { row: item, nm, sub, sig: '' }
        boardRows.set(board.id, entry)
      }
      if (entry.sig !== sig) {
        entry.sig = sig
        entry.nm.textContent = board.name
        entry.sub.textContent = `${board.cards.length} 卡片 · ${board.strokes.length} 笔迹`
      }
      entry.row.classList.toggle('is-active', board.id === activeId)
    }
    for (const [id, entry] of boardRows) {
      if (alive.has(id)) continue
      entry.row.remove()
      boardRows.delete(id)
    }
  }

  // ── 选择与删除 ──────────────────────────────────────────────────────
  function selectCard(cardId: string) {
    if (selectedCardId !== cardId || selectedStrokeId) {
      selectedStrokeId = ''
      for (const entry of strokeEls.values()) entry.el.classList.remove('is-selected')
    }
    selectedCardId = cardId
    for (const el of cardsLayer.children) el.classList.toggle('is-selected', el instanceof HTMLElement && el.dataset.cardId === cardId)
    const board = currentBoard()
    if (board) {
      bringCardToFront(board, cardId)
      const card = board.cards.find((candidate) => candidate.id === cardId)
      const node = cardsLayer.querySelector<HTMLElement>(`[data-card-id="${cardId}"]`)
      if (card && node) node.style.zIndex = String(Number(card.z) || 0)
      store.scheduleSave()
    }
    delBtn.disabled = false
  }

  function selectStroke(strokeId: string) {
    selectedCardId = ''
    for (const el of cardsLayer.children) el.classList.remove('is-selected')
    selectedStrokeId = strokeId
    for (const [id, entry] of strokeEls) entry.el.classList.toggle('is-selected', id === strokeId)
    delBtn.disabled = false
  }

  function removeCard(cardId: string) {
    const board = currentBoard()
    if (!board) return
    board.cards = board.cards.filter((card) => card.id !== cardId)
    // 连带删掉以它为端点的连线 —— 否则会留下指向不存在卡片的悬空线。
    board.strokes = board.strokes.filter((stroke) => stroke.kind !== 'connector' || (stroke.from !== cardId && stroke.to !== cardId))
    clearSelection()
    store.scheduleSave()
    render()
  }

  function deleteSelection() {
    const board = currentBoard()
    if (!board) return
    if (selectedCardId) { snapshot(); removeCard(selectedCardId); return }
    if (selectedStrokeId) {
      snapshot()
      board.strokes = board.strokes.filter((stroke) => stroke.id !== selectedStrokeId)
      clearSelection()
      store.scheduleSave()
      render()
    }
  }

  // ── 画板管理 ────────────────────────────────────────────────────────
  function newBoard() {
    const board = createBoard(`画板 ${store.boards.length + 1}`)
    store.replace([...store.boards, board])
    activeId = board.id
    panX = 0; panY = 0; zoom = 1
    clearSelection()
    render()
  }
  async function renameBoard() {
    const board = currentBoard()
    if (!board) return
    const view = doc.defaultView
    const next = view && view.prompt ? view.prompt('画板名称', board.name) : null
    if (next == null) return
    const name = String(next).trim().slice(0, 60)
    if (!name) return
    board.name = name
    store.scheduleSave()
    render()
  }
  async function removeBoard() {
    const board = currentBoard()
    if (!board) return
    const ok = typeof windowCtx.confirm === 'function'
      ? await Promise.resolve(windowCtx.confirm({ title: '删除画板', message: `删除「${board.name}」及其全部卡片与笔迹？` }))
      : true
    if (!ok) return
    const rest = store.boards.filter((candidate) => candidate.id !== board.id)
    store.replace(rest)
    activeId = rest.length ? rest[0].id : ''
    clearSelection()
    render()
  }

  // ── 添加内容 ────────────────────────────────────────────────────────
  function addCard(kind: CardKind, payload: Parameters<typeof createCard>[1] = {}, at?: { x?: number; y?: number }) {
    const board = currentBoard()
    if (!board) return null
    const pos = at || { x: (60 - panX) / zoom, y: (60 - panY) / zoom }
    const card = createCard(kind, payload, pos)
    card.z = board.cards.reduce((max, item) => Math.max(max, Number(item.z) || 0), 0) + 1
    board.cards.push(card)
    selectedCardId = card.id
    store.scheduleSave()
    render()
    if (kind === 'note') {
      const area = cardsLayer.querySelector<HTMLTextAreaElement>(`[data-card-id="${card.id}"] textarea`)
      if (area) area.focus()
    }
    return card
  }
  function addLinkCard() {
    const view = doc.defaultView
    const input = view && view.prompt ? view.prompt('要钉住的链接地址', 'https://') : null
    if (!input) return
    const url = String(input).trim()
    if (!isHttpUrl(url)) return
    let title = url
    try { title = new URL(url).hostname } catch (_) {}
    addCard('link', { url, title })
  }

  /**
   * 建一个**子节点**并自动连线（思维导图的核心动作，比"先建卡片再画连线"少两步）。
   * 落点：父节点右侧、同一水平线；若右侧已被占则逐格下移，避免叠在一起。
   */
  function addChildCard(parentId: string) {
    const board = currentBoard()
    if (!board) return
    const parent = board.cards.find((card) => card.id === parentId)
    if (!parent) return
    snapshot()
    const siblings = board.strokes.filter((stroke) => stroke.kind === 'connector' && stroke.from === parentId).length
    const at = {
      x: parent.x + parent.w + 90,
      y: parent.y + siblings * 80
    }
    const child = createCard('note', { text: '' }, at)
    child.z = board.cards.reduce((max, card) => Math.max(max, Number(card.z) || 0), 0) + 1
    board.cards.push(child)
    const link = createStroke('connector', { from: parentId, to: child.id, color, width: strokeWidth })
    link.z = board.strokes.reduce((max, stroke) => Math.max(max, Number(stroke.z) || 0), 0) + 1
    board.strokes.push(link)
    selectedCardId = child.id
    store.scheduleSave()
    render()
    const area = cardsLayer.querySelector<HTMLTextAreaElement>(`[data-card-id="${child.id}"] textarea`)
    if (area) area.focus()
  }

  /**
   * 自动整理：按**连线的方向**把卡片排成从左到右的树（父在左、子在右），
   * 同一层内按顺序纵向排开；没有连线的卡片统一放最后一列。
   * 这是"思维导图"从一团乱麻变成可读结构的那一步。
   */
  function autoLayout() {
    const board = currentBoard()
    if (!board || board.cards.length === 0) return
    snapshot()
    const outgoing = new Map<string, string[]>()
    const hasIncoming = new Set<string>()
    for (const s of board.strokes) {
      if (s.kind !== 'connector') continue
      const targets = outgoing.get(s.from) || []
      targets.push(s.to)
      outgoing.set(s.from, targets)
      hasIncoming.add(s.to)
    }
    // 根 = 没有被指向的卡片；一张都没有（全是环）就拿第一张当根。
    const roots = board.cards.filter((card) => !hasIncoming.has(card.id)).map((card) => card.id)
    const depth = new Map<string, number>()
    const queue: string[] = []
    for (const id of (roots.length ? roots : [board.cards[0].id])) { depth.set(id, 0); queue.push(id) }
    while (queue.length) {
      const id = queue.shift()
      if (!id) break
      const d = depth.get(id) || 0
      for (const next of (outgoing.get(id) || [])) {
        if (depth.has(next)) continue
        depth.set(next, d + 1)
        queue.push(next)
      }
    }
    let maxDepth = 0
    for (const d of depth.values()) maxDepth = Math.max(maxDepth, d)
    // 游离卡片（没连线 / 环外）放最后一列，不参与树。
    for (const c of board.cards) if (!depth.has(c.id)) depth.set(c.id, maxDepth + 1)
    const rows = new Map()
    for (const c of board.cards) {
      const d = depth.get(c.id) || 0
      const row = rows.get(d) || 0
      rows.set(d, row + 1)
      c.x = 60 + d * LAYOUT_COL
      c.y = 60 + row * LAYOUT_ROW
      clampCard(c)
    }
    store.scheduleSave()
    render()
  }

  // ── 画图 ────────────────────────────────────────────────────────────
  function startDraw(event: MouseEvent) {
    const board = currentBoard()
    if (!board) return
    const p = toWorld(event.clientX, event.clientY)
    const kind: StrokeKind = tool === 'select' || tool === 'eraser' || tool === 'connector' ? 'pen' : tool
    const stroke = createStroke(kind, { color, width: strokeWidth })
    if (tool === 'pen') stroke.points = [p]
    else if (tool === 'line' || tool === 'arrow') stroke.points = [p, p]
    else { stroke.x = p.x; stroke.y = p.y; stroke.w = 0; stroke.h = 0 }
    const el = buildStrokeEl(stroke)
    if (!el) return
    el.classList.add('is-selected') // 画的过程中就是"当前笔"
    svg.appendChild(el)
    drag = { mode: 'draw', stroke, el, start: p }
  }

  function updateDraw(event: MouseEvent) {
    if (!drag || drag.mode !== 'draw') return
    const stroke = drag.stroke
    const p = toWorld(event.clientX, event.clientY)
    if (stroke.kind === 'pen') {
      const last = stroke.points[stroke.points.length - 1]
      if (Math.abs(p.x - last.x) < 2 && Math.abs(p.y - last.y) < 2) return
      stroke.points.push(p)
    } else if (stroke.kind === 'line' || stroke.kind === 'arrow') {
      stroke.points = [drag.start, p]
    } else {
      stroke.w = p.x - drag.start.x
      stroke.h = p.y - drag.start.y
    }
    const geom = strokeGeometry(stroke, cardById)
    if (!geom) return
    for (const [key, value] of Object.entries(geom.attrs)) drag.el.setAttribute(key, String(value))
  }

  function commitDraw() {
    if (!drag || drag.mode !== 'draw') return
    const board = currentBoard()
    const stroke = drag.stroke
    if (!board) return
    // 太小的一笔（点一下）不留下 —— 免得画布上到处是隐形小点。
    const tiny = (stroke.kind === 'pen' && stroke.points.length < 3) ||
      ((stroke.kind === 'rect' || stroke.kind === 'ellipse') && Math.abs(stroke.w) < 6 && Math.abs(stroke.h) < 6) ||
      ((stroke.kind === 'line' || stroke.kind === 'arrow') &&
        Math.abs(stroke.points[1].x - stroke.points[0].x) < 6 && Math.abs(stroke.points[1].y - stroke.points[0].y) < 6)
    if (tiny) { try { svg.removeChild(drag.el) } catch (_) {} ; return }
    snapshot()
    stroke.z = board.strokes.reduce((max, item) => Math.max(max, Number(item.z) || 0), 0) + 1
    board.strokes.push(stroke)
    store.scheduleSave()
    // 画的过程中那个节点已经是最新的（updateDraw 每帧就地改属性）：直接登记进现状表，
    // 交给增量渲染按 z 归位 —— 否则这一笔会被当成"未知笔迹"重建成第二个节点。
    drag.el.classList.remove('is-selected')
    strokeEls.set(stroke.id, { el: drag.el, stroke, sig: strokeSig(stroke) })
    renderStrokes()
  }

  function startConnector(event: MouseEvent) {
    const target = event.target instanceof Element ? event.target : null
    const cardEl = target?.closest<HTMLElement>('[data-card-id]')
    if (!cardEl) return
    const from = cardEl.dataset.cardId
    if (!from) return
    drag = { mode: 'connect', from, to: '' }
    canvas.classList.add('is-drawing')
  }
  function updateConnector(event: MouseEvent) {
    if (!drag || drag.mode !== 'connect') return
    const target = event.target instanceof Element ? event.target : null
    const cardEl = target?.closest<HTMLElement>('[data-card-id]')
    drag.to = cardEl && cardEl.dataset.cardId !== drag.from ? (cardEl.dataset.cardId || '') : ''
    for (const el of cardsLayer.children) {
      if (!(el instanceof HTMLElement)) continue
      el.style.outline = (drag.to && el.dataset.cardId === drag.to) ? '2px solid var(--hira-accent, #3b82f6)' : ''
    }
  }
  function commitConnector() {
    if (!drag || drag.mode !== 'connect') return
    const board = currentBoard()
    const { from, to } = drag
    for (const el of cardsLayer.children) if (el instanceof HTMLElement) el.style.outline = ''
    if (!board || !from || !to || from === to) return
    snapshot()
    const stroke = createStroke('connector', { from, to, color, width: strokeWidth })
    stroke.z = board.strokes.reduce((max, item) => Math.max(max, Number(item.z) || 0), 0) + 1
    board.strokes.push(stroke)
    store.scheduleSave()
    renderStrokes()
  }

  function startPan(event: MouseEvent) {
    canvas.classList.add('is-panning')
    drag = { mode: 'pan', startX: event.clientX, startY: event.clientY, originX: panX, originY: panY }
    clearSelection()
  }

  function eraseAt(event: MouseEvent) {
    const target = event.target instanceof Element ? event.target : null
    const el = target?.closest<SVGElement>('[data-stroke-id]')
    if (!el) return
    const board = currentBoard()
    if (!board) return
    snapshot()
    board.strokes = board.strokes.filter((stroke) => stroke.id !== el.dataset.strokeId)
    store.scheduleSave()
    renderStrokes()
  }

  // ── 画布交互 ────────────────────────────────────────────────────────
  canvas.addEventListener('mousedown', (event: MouseEvent) => {
    if (event.button !== 0 || drag) return
    if (tool === 'connector') { startConnector(event); return }
    if (DRAW_TOOLS.has(tool as StrokeKind)) { startDraw(event); return }
    if (tool === 'eraser') { eraseAt(event); return }
    // 选择工具
    const target = event.target instanceof Element ? event.target : null
    const strokeEl = target?.closest<SVGElement>('[data-stroke-id]')
    if (strokeEl) {
      const strokeId = strokeEl.dataset.strokeId
      if (strokeId) {
        selectStroke(strokeId)
        bringStrokeToFront(currentBoard(), strokeId)
        return
      }
    }
    if (event.target === canvas || event.target === world) startPan(event)
  })

  canvas.addEventListener('wheel', (event: WheelEvent) => {
    if (event.ctrlKey || event.metaKey) {
      event.preventDefault()
      const rect = canvas.getBoundingClientRect()
      // 以**光标**为锚（按钮那份锚在画布正中）—— 同一份换算，见 setZoom。
      // 滚轮档位比按钮细（10% vs 25%）：连续缩放要跟手，点击则要一步到位。
      setZoom(
        zoom * (event.deltaY < 0 ? 1.1 : 0.9),
        event.clientX - rect.left,
        event.clientY - rect.top
      )
    } else {
      panX -= event.deltaX
      panY -= event.deltaY
      applyTransform()
    }
  }, { passive: false })

  canvas.addEventListener('dblclick', (event: MouseEvent) => {
    if (tool !== 'select') return
    if (event.target !== canvas && event.target !== world) return
    snapshot()
    addCard('note', {}, toWorld(event.clientX, event.clientY))
  })

  // ── 跨面板拖入（统一协议：标签 / 集锦卡 / 书签 / 历史 / 下载）────────────
  // 落在指针处；按载荷推断卡片类型：图片 → 图片卡，有 url → 链接卡，其余 → 便签。
  canvas.addEventListener('dragover', (event: DragEvent) => {
    const dataTransfer = event.dataTransfer
    if (drag || !dataTransfer || !hasDragItem(dataTransfer)) return
    event.preventDefault()
    dataTransfer.dropEffect = pickDropEffect(dataTransfer, 'copy')
    canvas.classList.add('is-drop-target')
  })
  canvas.addEventListener('dragleave', (event: DragEvent) => {
    const related = event.relatedTarget instanceof Node ? event.relatedTarget : null
    if (!canvas.contains(related)) canvas.classList.remove('is-drop-target')
  })
  canvas.addEventListener('drop', (event: DragEvent) => {
    canvas.classList.remove('is-drop-target')
    const dataTransfer = event.dataTransfer
    if (!dataTransfer || !hasDragItem(dataTransfer)) return
    event.preventDefault()
    if (!currentBoard()) return
    const item = getDragItem(dataTransfer) as ExternalDragItem | null
    if (!item || item.kind === 'folder') return // 集锦是容器，不是可成卡的内容
    const at = toWorld(event.clientX, event.clientY)
    snapshot()
    if (item.kind === 'image') {
      const src = item.url || (/^data:image\//i.test(item.text || '') ? item.text : '')
      if (src) addCard('image', { data: src, title: item.title || '图片' }, at)
      else if (item.title) addCard('note', { text: item.title }, at)
      return
    }
    if (item.url) {
      addCard('link', { url: item.url, title: item.title || item.url }, at)
      return
    }
    const text = item.text || item.title
    if (text) addCard('note', { text }, at)
  })

  // 全局移动 / 抬起：拖卡片、缩放、画图、连线、平移共用一条收口。
  const onMove = (event: MouseEvent) => {
    if (!drag) return
    if (drag.mode === 'pan') {
      panX = drag.originX + (event.clientX - drag.startX)
      panY = drag.originY + (event.clientY - drag.startY)
      applyTransform()
      return
    }
    if (drag.mode === 'move') {
      drag.card.x = drag.originX + (event.clientX - drag.startX) / zoom
      drag.card.y = drag.originY + (event.clientY - drag.startY) / zoom
      clampCard(drag.card)
      drag.el.style.left = `${drag.card.x}px`
      drag.el.style.top = `${drag.card.y}px`
      updateConnectorsFor(drag.card.id) // 连线跟着卡片走
      return
    }
    if (drag.mode === 'resize') {
      drag.card.w = drag.originW + (event.clientX - drag.startX) / zoom
      drag.card.h = drag.originH + (event.clientY - drag.startY) / zoom
      clampCard(drag.card)
      drag.el.style.width = `${drag.card.w}px`
      drag.el.style.height = `${drag.card.h}px`
      updateConnectorsFor(drag.card.id)
      return
    }
    if (drag.mode === 'draw') { updateDraw(event); return }
    if (drag.mode === 'connect') { updateConnector(event); return }
  }

  const onUp = () => {
    disarmCardDrag() // 按下色点但没真的拖出去时也要把手柄卸下
    if (!drag) return
    const mode = drag.mode
    canvas.classList.remove('is-panning')
    if (mode !== 'pan') canvas.classList.remove('is-drawing')
    if (mode === 'move' || mode === 'resize') store.scheduleSave()
    if (mode === 'draw') commitDraw()
    if (mode === 'connect') commitConnector()
    drag = null
  }
  doc.addEventListener('mousemove', onMove)
  doc.addEventListener('mouseup', onUp)

  // 粘贴图片：剪贴板里有图就直接钉上去（截图 → 画板 的最短路径）。
  const onPaste = (event: ClipboardEvent) => {
    const items = (event.clipboardData && event.clipboardData.items) || []
    for (const item of items) {
      if (item.type && item.type.startsWith('image/')) {
        const file = item.getAsFile()
        if (!file) continue
        const reader = new FileReader()
        reader.onload = () => addCard('image', { data: String(reader.result || ''), title: '粘贴的图片' })
        reader.readAsDataURL(file)
        event.preventDefault()
        return
      }
    }
  }
  doc.addEventListener('paste', onPaste)

  const onKey = (event: KeyboardEvent) => {
    const target = event.target instanceof HTMLElement ? event.target : null
    const typing = target && (target.tagName === 'TEXTAREA' || target.tagName === 'INPUT')
    if ((event.ctrlKey || event.metaKey) && String(event.key).toLowerCase() === 'z') {
      event.preventDefault()
      undo()
      return
    }
    if (typing) return
    if (event.key === 'Delete' || event.key === 'Backspace') {
      event.preventDefault()
      deleteSelection()
    } else if (event.key === 'Escape') {
      setTool('select')
    }
  }
  doc.addEventListener('keydown', onKey)

  // ── 装配 ────────────────────────────────────────────────────────────
  async function start() {
    await store.load()
    // 面板点某块板打开窗口时会把 id 写进 `easel.active_board`（见 panel/index.js）。
    let preferred = ''
    try { preferred = settings ? String(await settings.get(EASEL_ACTIVE_BOARD_SETTING_KEY) || '') : '' } catch (_) { preferred = '' }
    activeId = store.getBoard(String(preferred || '')) ? String(preferred) : (store.boards[0] ? store.boards[0].id : '')
    setTool('select')
    setColor(color)
    setStrokeWidth(strokeWidth)
    undoBtn.disabled = true
    render()
  }

  setTool('select')
  setColor(color)
  setStrokeWidth(strokeWidth)

  return {
    element: root,
    start,
    /** 窗口关闭前把防抖中的改动落盘。 */
    dispose() { store.flush() }
  }
}

/** 窗口形态定义（宿主 `subwindow/windows/easel-window.js` 按同形契约挂载）。 */
export const windowDefinition: WindowDefinition = {
  id: 'easel-window',
  injectStyles: injectEaselWindowStyles,
  mount(doc, ctx) {
    return createEaselWindow(doc, ctx)
  }
}
