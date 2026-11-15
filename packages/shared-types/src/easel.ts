/**
 * easel —— Easy 画板（D4）的**纯规则层**：画板 / 卡片 / **矢量笔迹**的形状、归一与几何。
 *
 * ── 一块画板上有什么 ──────────────────────────────────────────────
 *   · `cards[]`   —— 内容卡片（便签 / 链接 / 图片），是**有尺寸的矩形**，可拖拽改尺寸；
 *   · `strokes[]` —— 矢量笔迹（手绘 / 直线 / 箭头 / 矩形 / 椭圆 / **连线**），是**画在画布上的形状**。
 * 两者分开存：卡片的"内容"是富文本/URL/图片，笔迹的"内容"是几何 —— 混成一张表会让
 * 归一、渲染、命中测试三处都长出分叉。
 *
 * ── 连线（connector）为什么只存两端 id ────────────────────────────
 * 连线是"两张卡片之间的关系"，不是一条固定折线：卡片一移动，线必须跟着走。
 * 所以只存 `{ from, to }`（卡片 id），端点几何**每次渲染时由 `connectorAnchor()` 现算**
 * —— 存坐标的话，卡片一拖线就断在原地（这是白板类工具最经典的一类 bug）。
 *
 * ── 它不认识 DOM ──────────────────────────────────────────────────
 * 本层只产出数据与几何（`connectorAnchor` / `strokePathData` 都是纯函数），
 * 面板形态与窗口形态共用，因此两边画出来的东西一定长得一样。
 */

/** 设置项键（面板形态与窗口形态共用）。 */
export const EASEL_SETTING_KEY = 'easel.boards'

/** 面板 → 画板窗口的交接键：面板点某块板时写入，窗口启动时读它决定先打开哪块。 */
export const EASEL_ACTIVE_BOARD_SETTING_KEY = 'easel.active_board'

/** 容量与坐标边界：防止手改 JSON 塞进天文数字让画布/渲染崩掉。 */
export const EASEL_LIMITS = Object.freeze({
  maxBoards: 30,
  maxCardsPerBoard: 200,
  maxStrokesPerBoard: 2000,
  /** 一条手绘笔迹的点数上限（再多对观感没有增量，只会拖慢重绘）。 */
  maxPointsPerStroke: 2000,
  minCardSize: { w: 120, h: 80 },
  maxCardSize: { w: 3000, h: 3000 },
  maxCoord: 200000,
  maxTextLength: 20000
})

/** 卡片类型：便签 / 链接 / 图片（图片存 dataURL，随画板一起进设置）。 */
export type CardKind = 'note' | 'link' | 'image'
export type StrokeKind = 'pen' | 'line' | 'arrow' | 'rect' | 'ellipse' | 'connector'
export type EaselBackgroundId = 'chalk' | 'white' | 'cream'

export const CARD_KINDS: readonly CardKind[] = Object.freeze(['note', 'link', 'image'])
export const CARD_KIND_LABELS = Object.freeze({ note: '便签', link: '链接', image: '图片' })

/** 笔迹类型：手绘 + 四种基本形状 + 连线。 */
export const STROKE_KINDS: readonly StrokeKind[] = Object.freeze(['pen', 'line', 'arrow', 'rect', 'ellipse', 'connector'])
export const STROKE_KIND_LABELS = Object.freeze({
  pen: '手绘',
  line: '直线',
  arrow: '箭头',
  rect: '矩形',
  ellipse: '椭圆',
  connector: '连线'
})

/** 工具栏的顺序（窗口形态按这个顺序画按钮；它是**展示顺序**，不是能力清单）。 */
export const TOOL_ORDER = Object.freeze(['select', 'pen', 'line', 'arrow', 'rect', 'ellipse', 'connector', 'eraser'])

/** 默认调色板（7 色：末位白色供深色画布使用）与线宽档位。 */
export const STROKE_COLORS = Object.freeze(['#1a1a1a', '#2563eb', '#dc2626', '#059669', '#d97706', '#7c3aed', '#ffffff'])
export const STROKE_WIDTHS = Object.freeze([2, 4, 8])

/**
 * 画布背景：**固定色，不跟随主题**。
 *
 * 画板是"纸"，纸的颜色是用户选的内容属性，不是界面皮肤的一部分 ——
 * 跟着主题变会让同一块板在明暗主题下呈现出不同的观感（甚至黑底黑字看不见）。
 * 所以颜色随画板一起持久化（`board.background`），主题变化只影响工具栏。
 *
 * `grid` 是网格点色（半透明，叠在底色上），`ink` 是**推荐默认墨色**：
 * 深绿黑板上用黑笔等于没写，切到黑板时自动换白笔。
 */
export const EASEL_BACKGROUNDS: readonly Readonly<{ id: EaselBackgroundId; label: string; color: string; grid: string; ink: string }>[] = Object.freeze([
  { id: 'chalk', label: '黑板绿', color: '#1f3f33', grid: 'rgba(255,255,255,0.18)', ink: '#ffffff' },
  { id: 'white', label: '白色', color: '#ffffff', grid: 'rgba(0,0,0,0.12)', ink: '#1a1a1a' },
  { id: 'cream', label: '米白', color: '#f6f1e3', grid: 'rgba(0,0,0,0.10)', ink: '#1a1a1a' }
])
export const EASEL_BACKGROUND_IDS: readonly EaselBackgroundId[] = Object.freeze(EASEL_BACKGROUNDS.map((b) => b.id))
/** 默认背景：米白（长时间看白板不刺眼，也不像黑板那样把默认墨色废掉）。 */
export const EASEL_DEFAULT_BACKGROUND = 'cream'

/** 解析背景 id（非法值回落默认，永远返回一个可用对象）。 */
export interface StrokePoint {
  x: number
  y: number
}

export interface EaselCard {
  id: string
  kind: CardKind
  x: number
  y: number
  w: number
  h: number
  z: number
  text: string
  url: string
  title: string
  data: string
}

export interface EaselStroke {
  id: string
  kind: StrokeKind
  color: string
  width: number
  z: number
  points: StrokePoint[]
  x: number
  y: number
  w: number
  h: number
  from: string
  to: string
}

export interface EaselBoard {
  id: string
  name: string
  background: EaselBackgroundId
  cards: EaselCard[]
  strokes: EaselStroke[]
  createdAt: number
  updatedAt: number
}

interface StrokeSpec {
  points?: Array<{ x: number; y: number }>
  x?: number
  y?: number
  w?: number
  h?: number
  color?: string
  width?: number
  from?: string
  to?: string
}

export function easelBackground(id: unknown) {
  return EASEL_BACKGROUNDS.find((b) => b.id === id) || EASEL_BACKGROUNDS[EASEL_BACKGROUNDS.length - 1]
}

function clamp(value: unknown, min: number, max: number): number {
  const n = Number(value)
  if (!Number.isFinite(n)) return min
  return Math.min(max, Math.max(min, n))
}

function randId(prefix: string): string {
  const rnd = Math.random().toString(36).slice(2, 10)
  return `${prefix}-${Date.now().toString(36)}-${rnd}`
}

/** 新建一块空画板。 */
export function createBoard(name: unknown): EaselBoard {
  const now = Date.now()
  return {
    id: randId('eb'),
    name: String(name || '未命名画板').slice(0, 60),
    background: EASEL_DEFAULT_BACKGROUND,
    cards: [],
    strokes: [],
    createdAt: now,
    updatedAt: now
  }
}

/**
 * 新建一张卡片（默认尺寸按类型给：便签小、链接扁、图片方）。
 * @param {'note'|'link'|'image'} kind
 * @param {{ text?: string, url?: string, title?: string, data?: string }} payload
 * @param {{ x?: number, y?: number }} [at]
 */
export function createCard(kind: 'note'|'link'|'image', payload: { text?: string, url?: string, title?: string, data?: string } = {}, at: { x?: number, y?: number } = {}) {
  const size = kind === 'note' ? { w: 240, h: 180 } : kind === 'link' ? { w: 280, h: 120 } : { w: 260, h: 200 }
  return {
    id: randId('ec'),
    kind: CARD_KINDS.includes(kind) ? kind : 'note',
    x: clamp(at.x ?? 40, -EASEL_LIMITS.maxCoord, EASEL_LIMITS.maxCoord),
    y: clamp(at.y ?? 40, -EASEL_LIMITS.maxCoord, EASEL_LIMITS.maxCoord),
    w: size.w,
    h: size.h,
    z: Date.now(),
    text: String(payload.text || '').slice(0, EASEL_LIMITS.maxTextLength),
    url: payload.url ? String(payload.url).slice(0, 4096) : '',
    title: payload.title ? String(payload.title).slice(0, 512) : '',
    data: payload.data ? String(payload.data) : ''
  }
}

/** 把卡片尺寸 / 坐标夹回合法区间（拖动与缩放的唯一收口）。 */
export function clampCard<T extends EaselCard>(card: T): T {
  card.x = clamp(card.x, -EASEL_LIMITS.maxCoord, EASEL_LIMITS.maxCoord)
  card.y = clamp(card.y, -EASEL_LIMITS.maxCoord, EASEL_LIMITS.maxCoord)
  card.w = clamp(card.w, EASEL_LIMITS.minCardSize.w, EASEL_LIMITS.maxCardSize.w)
  card.h = clamp(card.h, EASEL_LIMITS.minCardSize.h, EASEL_LIMITS.maxCardSize.h)
  return card
}

/**
 * 新建一条笔迹。
 * @param {'pen'|'line'|'arrow'|'rect'|'ellipse'|'connector'} kind
 * @param {{ points?: Array<{x:number,y:number}>, x?: number, y?: number, w?: number, h?: number,
 *           color?: string, width?: number, from?: string, to?: string }} spec
 */
export function createStroke(
  kind: StrokeKind,
  spec: StrokeSpec = {}
): EaselStroke {
  const base = {
    id: randId('es'),
    kind: STROKE_KINDS.includes(kind) ? kind : 'pen',
    color: String(spec.color || STROKE_COLORS[0]),
    width: clamp(spec.width ?? 4, 1, 24),
    z: Date.now(),
    points: [] as StrokePoint[],
    x: 0, y: 0, w: 0, h: 0,
    from: '', to: ''
  }
  if (base.kind === 'pen') {
    base.points = Array.isArray(spec.points) ? spec.points.map((p) => ({ x: Number(p.x) || 0, y: Number(p.y) || 0 })) : []
  } else if (base.kind === 'connector') {
    base.from = String(spec.from || '')
    base.to = String(spec.to || '')
  } else if (base.kind === 'line' || base.kind === 'arrow') {
    base.points = Array.isArray(spec.points) ? spec.points.map((p) => ({ x: Number(p.x) || 0, y: Number(p.y) || 0 })) : []
  } else {
    base.x = clamp(spec.x ?? 0, -EASEL_LIMITS.maxCoord, EASEL_LIMITS.maxCoord)
    base.y = clamp(spec.y ?? 0, -EASEL_LIMITS.maxCoord, EASEL_LIMITS.maxCoord)
    base.w = Number(spec.w) || 0
    base.h = Number(spec.h) || 0
  }
  return base
}

/** 归一一条笔迹（几何不完整 / 端点缺失的直接丢弃）。 */
export function isCardKind(value: unknown): value is CardKind {
  return typeof value === 'string' && CARD_KINDS.some((kind) => kind === value)
}

export function isStrokeKind(value: unknown): value is StrokeKind {
  return typeof value === 'string' && STROKE_KINDS.some((kind) => kind === value)
}

export function normalizeStroke(raw: unknown): EaselStroke | null {
  if (!raw || typeof raw !== 'object') return null
  const source = raw as Record<string, unknown>
  if (!isStrokeKind(source.kind)) return null
  const stroke = createStroke(source.kind, source as StrokeSpec)
  stroke.id = String(source.id || stroke.id)
  stroke.z = Number.isFinite(Number(source.z)) ? Number(source.z) : 0
  if (stroke.kind === 'connector') {
    if (!stroke.from || !stroke.to || stroke.from === stroke.to) return null
  } else if (stroke.kind === 'pen' || stroke.kind === 'line' || stroke.kind === 'arrow') {
    stroke.points = (Array.isArray(source.points) ? source.points : [])
      .filter((point): point is StrokePoint => !!point && typeof point === 'object' && Number.isFinite(Number((point as Record<string, unknown>).x)) && Number.isFinite(Number((point as Record<string, unknown>).y)))
      .map((point) => ({ x: clamp(point.x, -EASEL_LIMITS.maxCoord, EASEL_LIMITS.maxCoord), y: clamp(point.y, -EASEL_LIMITS.maxCoord, EASEL_LIMITS.maxCoord) }))
      .slice(0, EASEL_LIMITS.maxPointsPerStroke)
    if (stroke.points.length < 2) return null
  } else {
    if (!(Math.abs(stroke.w) > 0.5) && !(Math.abs(stroke.h) > 0.5)) return null
  }
  return stroke
}

/** 归一单张卡片（丢弃非法项，补全缺省）。 */
export function normalizeCard(raw: unknown): EaselCard | null {
  if (!raw || typeof raw !== 'object') return null
  const source = raw as Record<string, unknown>
  if (!isCardKind(source.kind)) return null
  const card = {
    id: String(source.id || randId('ec')),
    kind: source.kind,
    x: clamp(source.x, -EASEL_LIMITS.maxCoord, EASEL_LIMITS.maxCoord),
    y: clamp(source.y, -EASEL_LIMITS.maxCoord, EASEL_LIMITS.maxCoord),
    w: clamp(source.w, EASEL_LIMITS.minCardSize.w, EASEL_LIMITS.maxCardSize.w),
    h: clamp(source.h, EASEL_LIMITS.minCardSize.h, EASEL_LIMITS.maxCardSize.h),
    z: Number.isFinite(Number(source.z)) ? Number(source.z) : 0,
    text: String(source.text || '').slice(0, EASEL_LIMITS.maxTextLength),
    url: source.url ? String(source.url).slice(0, 4096) : '',
    title: source.title ? String(source.title).slice(0, 512) : '',
    data: source.data ? String(source.data) : ''
  }
  // 内容空判定：
  //   · **便签允许为空** —— 双击 / 「+ 子节点」刚建出来的就是一张空便签，
  //     它是"待写"状态，不是废数据（早先把它当废数据丢掉 → 新建的便签重启后消失）。
  //   · 链接没有 URL、图片没有数据则是**真的没有内容**（渲染出来是个空壳），照样丢。
  if (card.kind === 'link' && !card.url) return null
  if (card.kind === 'image' && !card.data) return null
  return card
}

/** 归一单块画板。 */
export function normalizeBoard(raw: unknown): EaselBoard | null {
  if (!raw || typeof raw !== 'object') return null
  const source = raw as Record<string, unknown>
  const id = String(source.id || randId('eb'))
  const name = String(source.name || '未命名画板').slice(0, 60) || '未命名画板'
  const cards: EaselCard[] = Array.isArray(source.cards)
    ? source.cards.map(normalizeCard).filter((card): card is EaselCard => card !== null).slice(0, EASEL_LIMITS.maxCardsPerBoard)
    : []
  const cardIds = new Set(cards.map((c) => c.id))
  const strokes: EaselStroke[] = Array.isArray(source.strokes)
    ? source.strokes.map(normalizeStroke).filter((stroke): stroke is EaselStroke => stroke !== null)
      // 连线两端必须都还在（卡片被删掉后，连线的端点就不存在了）。
      .filter((s) => s.kind !== 'connector' || (cardIds.has(s.from) && cardIds.has(s.to)))
      .slice(0, EASEL_LIMITS.maxStrokesPerBoard)
    : []
  return {
    id,
    name,
    background: EASEL_BACKGROUND_IDS.some((id) => id === source.background) ? source.background as EaselBackgroundId : EASEL_DEFAULT_BACKGROUND,
    cards,
    strokes,
    createdAt: Number(source.createdAt) || Date.now(),
    updatedAt: Number(source.updatedAt) || Date.now()
  }
}

/** 归一整张画板表（按 id 去重、封顶）。 */
export function normalizeBoards(list: unknown): EaselBoard[] {
  if (!Array.isArray(list)) return []
  const seen = new Set<string>()
  const out: EaselBoard[] = []
  for (const raw of list) {
    const board = normalizeBoard(raw)
    if (!board || seen.has(board.id)) continue
    seen.add(board.id)
    out.push(board)
    if (out.length >= EASEL_LIMITS.maxBoards) break
  }
  return out
}

/** 设置里存的是 JSON 字符串 → 解析；坏数据当空表（绝不抛）。 */
export function parseBoards(value: unknown): EaselBoard[] {
  if (!value) return []
  try {
    return normalizeBoards(typeof value === 'string' ? JSON.parse(value) : value)
  } catch (_) {
    return []
  }
}

export function serializeBoards(list: unknown): string {
  return JSON.stringify(normalizeBoards(list))
}

/** 把某张卡片提到最前（用时间戳当 z，简单且不会撞号）。 */
export function bringCardToFront(board: EaselBoard | null | undefined, cardId: string): void {
  if (!board || !Array.isArray(board.cards)) return
  const card = board.cards.find((c) => c.id === cardId)
  if (!card) return
  const maxZ = board.cards.reduce((m, c) => Math.max(m, Number(c.z) || 0), 0)
  card.z = maxZ + 1
}

/** 把某条笔迹提到最前（同上）。 */
export function bringStrokeToFront(board: EaselBoard | null | undefined, strokeId: string): void {
  if (!board || !Array.isArray(board.strokes)) return
  const stroke = board.strokes.find((s) => s.id === strokeId)
  if (!stroke) return
  const maxZ = board.strokes.reduce((m, s) => Math.max(m, Number(s.z) || 0), 0)
  stroke.z = maxZ + 1
}

/** 兼容旧名（此前只有卡片，"bringToFront" 指的就是卡片）。 */
export const bringToFront = bringCardToFront

// ── 几何（纯函数：渲染与命中测试共用同一套，不各算一遍）────────────────

/**
 * 连线两端锚点：从 A 的**中心**指向 B 的**中心**，各自裁到矩形的边上。
 *
 * 为什么裁边而不是连中心：线穿进卡片内部会盖住文字，看起来像"脏线"；
 * 裁到边界后两端正好贴着卡片，视觉上才是"连起来了"。
 *
 * @param {{x:number,y:number,w:number,h:number}} a
 * @param {{x:number,y:number,w:number,h:number}} b
 * @returns {{ x1:number, y1:number, x2:number, y2:number }}
 */
export function connectorAnchor(a: { x:number,y:number,w:number,h:number }, b: { x:number,y:number,w:number,h:number }) : { x1:number, y1:number, x2:number, y2:number } {
  const ac = { x: a.x + a.w / 2, y: a.y + a.h / 2 }
  const bc = { x: b.x + b.w / 2, y: b.y + b.h / 2 }
  const dx = bc.x - ac.x
  const dy = bc.y - ac.y
  const trim = (c: StrokePoint, w: number, h: number, vx: number, vy: number, sign: number): StrokePoint => {
    // 参数 t：从中心沿方向走到矩形边界所需的比例（取两个轴里较小的那个）。
    const tx = vx === 0 ? Infinity : (w / 2) / Math.abs(vx)
    const ty = vy === 0 ? Infinity : (h / 2) / Math.abs(vy)
    const t = Math.min(tx, ty)
    if (!Number.isFinite(t)) return c
    return { x: c.x + vx * t * sign, y: c.y + vy * t * sign }
  }
  const p1 = trim(ac, a.w, a.h, dx, dy, 1)
  const p2 = trim(bc, b.w, b.h, dx, dy, -1)
  return { x1: p1.x, y1: p1.y, x2: p2.x, y2: p2.y }
}

/**
 * 笔迹 → SVG 描述（渲染侧唯一入口）。
 * @param {object} stroke
 * @param {(id: string) => object|null} cardById 解析连线两端
 * @returns {{ tag: 'path'|'rect'|'ellipse', attrs: Record<string,any> }|null}
 */
export interface StrokeGeometryInput {
  kind: string
  points: StrokePoint[]
  from: string
  to: string
  x: number
  y: number
  w: number
  h: number
}

interface ConnectorCard {
  x: number
  y: number
  w: number
  h: number
}

export function strokeGeometry(
  stroke: StrokeGeometryInput,
  cardById: (id: string) => ConnectorCard | null
) {
  if (!stroke) return null
  if (stroke.kind === 'pen') {
    let d = ''
    for (let i = 0; i < stroke.points.length; i++) {
      const p = stroke.points[i]
      d += (i === 0 ? 'M' : 'L') + p.x.toFixed(1) + ' ' + p.y.toFixed(1)
    }
    return { tag: 'path', attrs: { d } }
  }
  if (stroke.kind === 'line' || stroke.kind === 'arrow') {
    const a = stroke.points[0]
    const b = stroke.points[stroke.points.length - 1]
    return { tag: 'path', attrs: { d: `M${a.x.toFixed(1)} ${a.y.toFixed(1)}L${b.x.toFixed(1)} ${b.y.toFixed(1)}` } }
  }
  if (stroke.kind === 'connector') {
    const a = cardById(stroke.from)
    const b = cardById(stroke.to)
    if (!a || !b) return null
    const { x1, y1, x2, y2 } = connectorAnchor(a, b)
    return { tag: 'path', attrs: { d: `M${x1.toFixed(1)} ${y1.toFixed(1)}L${x2.toFixed(1)} ${y2.toFixed(1)}` } }
  }
  // rect / ellipse：允许负宽高（往左上拖），统一归一成正向。
  const x = Math.min(stroke.x, stroke.x + stroke.w)
  const y = Math.min(stroke.y, stroke.y + stroke.h)
  const w = Math.abs(stroke.w)
  const h = Math.abs(stroke.h)
  if (stroke.kind === 'rect') return { tag: 'rect', attrs: { x, y, width: w, height: h, rx: 6 } }
  return { tag: 'ellipse', attrs: { cx: x + w / 2, cy: y + h / 2, rx: w / 2, ry: h / 2 } }
}
