/**
 * 截图标注的**纯规则真源**（三种截图方式共用的唯一口径）。
 *
 * ── 为什么单独成文件 ──────────────────────────────────────────────
 * 「可见区域 / 整页 / 框选」最终都进同一个标注编辑器（`ui/ui-capture-editor`），
 * 工具栏有哪些工具、颜色/线宽档位、文字多大、马赛克格子多大 —— 这些是**产品参数**，
 * 不是某个渲染页的私有实现。放在 shared-types 里，将来加工具（比如序号、裁剪）
 * 只需在这里加一条定义 + 在编辑器里注册一个 painter，其余入口零改动。
 *
 * ── 数据模型（操作数组，重绘即撤销）───────────────────────────────
 * 每条 op 都是可 JSON 序列化的普通对象：
 *   · rect / ellipse / mosaic / blur → { tool, x, y, w, h, ...参数 }
 *   · arrow                          → { tool, x1, y1, x2, y2, color, lineWidth }
 *   · pen / highlight                → { tool, points:[{x,y}], color, lineWidth }
 *   · text                           → { tool, x, y, text, color, fontSize }
 * 坐标一律是**画布像素坐标**（= 截图原始像素，超大图会先等比缩小到安全尺寸）。
 * 线宽 / 字号在落笔时按「画布像素 ÷ 显示像素」换算后写入 op ——
 * 于是同一张图放大缩小显示，标注的视觉粗细不变。
 */

/** 工具表（工具栏顺序即此顺序；icon 对应 `ui-common` 的图标名）。 */
export const CAPTURE_TOOLS = Object.freeze([
  { id: 'rect', label: '矩形', icon: 'Square' },
  { id: 'ellipse', label: '椭圆', icon: 'Circle' },
  { id: 'arrow', label: '箭头', icon: 'ArrowUpRight' },
  { id: 'pen', label: '画笔', icon: 'Pencil' },
  { id: 'highlight', label: '高亮', icon: 'Highlighter' },
  { id: 'text', label: '文字', icon: 'Type' },
  { id: 'mosaic', label: '马赛克', icon: 'LayoutGrid' },
  { id: 'blur', label: '模糊', icon: 'Droplet' }
])

export const CAPTURE_TOOL_IDS = Object.freeze(CAPTURE_TOOLS.map((t) => t.id))

/** 标注色板：前四色用于深色页面、后两色用于浅色页面，首尾都能拉开对比。 */
export const CAPTURE_COLORS = Object.freeze([
  '#e5484d',
  '#f59e0b',
  '#eab308',
  '#2e9e5b',
  '#3b82f6',
  '#8b5cf6',
  '#111827',
  '#ffffff'
])

/** 线宽档位（**显示像素**；落笔时换算成画布像素）。 */
export const CAPTURE_WIDTHS = Object.freeze([2, 4, 8])

export const CAPTURE_DEFAULT_TOOL = 'rect'
export const CAPTURE_DEFAULT_COLOR = '#e5484d'
export const CAPTURE_DEFAULT_WIDTH = 4

/** 马赛克格子边长（显示像素）。 */
export const CAPTURE_MOSAIC_BLOCK = 14
/** 模糊半径（显示像素）。 */
export const CAPTURE_BLUR_RADIUS = 12

/** 高亮笔的半透明覆盖率与相对线宽。 */
export const CAPTURE_HIGHLIGHT_ALPHA = 0.35
export const CAPTURE_HIGHLIGHT_SCALE = 3

/** 拖拽小于这么多**显示像素**视为误触，不落 op。 */
export const CAPTURE_MIN_DRAG = 4

/**
 * 画布尺寸上限：超过就等比缩小。
 *
 * 单边取 **16384**：这是 Chromium 各平台（D3D11 / Metal / GL）都能建出来的一张
 * 2D canvas 的硬上限，再大就会静默建失败（表现为"整张图空白"）。
 * 总像素取 4800 万：整页截图动辄 1440×20000，旧值（8192 / 2400 万）会把长图压到
 * 约 590px 宽 —— 用户放大了也糊成一片，这是"整页截图看不清"的结构性原因。
 * 4800 万 ≈ 192MB/canvas，编辑器只持两张（底图 + 画布），仍在安全区内。
 */
export const CAPTURE_MAX_DIM = 16384
export const CAPTURE_MAX_AREA = 48_000_000

/**
 * 文字工具的按档字号（显示像素）：线宽越粗、字越大，观感才成套。
 * @param {number} width 线宽档位
 * @returns {number}
 */
export function captureTextSize(width: number) : number {
  const w = Number(width) || CAPTURE_DEFAULT_WIDTH
  return Math.round(10 + w * 3)
}

/**
 * 两个拖拽点 → 规范化矩形（左上角 + 正宽高）。
 * @param {{x:number,y:number}} a
 * @param {{x:number,y:number}} b
 * @returns {{x:number,y:number,w:number,h:number}}
 */
export function normalizeDragRect(a: { x:number,y:number }, b: { x:number,y:number }) : {x:number,y:number,w:number,h:number} {
  const x = Math.min(a.x, b.x)
  const y = Math.min(a.y, b.y)
  return {
    x,
    y,
    w: Math.abs(b.x - a.x),
    h: Math.abs(b.y - a.y)
  }
}

/**
 * 拖拽是否达到落笔门槛（按显示像素判定）。
 * @param {{w:number,h:number}} rect 画布坐标矩形
 * @param {number} scale 画布像素 ÷ 显示像素
 * @returns {boolean}
 */
export function isDragSignificant(rect: { w:number,h:number }, scale: number = 1) : boolean {
  const min = CAPTURE_MIN_DRAG * (Number(scale) || 1)
  return Boolean(rect) && (rect.w >= min || rect.h >= min)
}

/**
 * 按安全上限计算画布尺寸（等比缩小，不放大）。
 * @param {number} width 原图宽
 * @param {number} height 原图高
 * @returns {{width:number,height:number,scale:number}} scale = 画布 ÷ 原图
 */
export function fitCaptureCanvas(width: number, height: number) : {width:number,height:number,scale:number} {
  const w = Math.max(1, Number(width) || 1)
  const h = Math.max(1, Number(height) || 1)
  const byDim = Math.min(1, CAPTURE_MAX_DIM / Math.max(w, h))
  const byArea = Math.min(1, Math.sqrt(CAPTURE_MAX_AREA / (w * h)))
  const scale = Math.min(byDim, byArea)
  return {
    width: Math.max(1, Math.round(w * scale)),
    height: Math.max(1, Math.round(h * scale)),
    scale
  }
}
