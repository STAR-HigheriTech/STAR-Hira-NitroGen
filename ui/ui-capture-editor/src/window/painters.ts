// @ts-check
/**
 * 截图标注的**画笔注册表**（工具 id → 绘制函数）。
 *
 * ── 为什么必须是注册表 ────────────────────────────────────────────
 * 工具是这张编辑器里最会长的东西（今天 8 个，明天可能要序号 / 裁剪 / 聚光灯…）。
 * 如果把"某个工具怎么画"写成主流程里的 `if (tool === 'rect') … else if …`，
 * 每加一个工具都要改三处（绘制、预览、提交），迟早漏一处。
 * 这里把**一个工具的完整画法**收敛成一个函数：主流程只管 `paintOp(ctx, op)`，
 * 新工具 = 在 `packages/shared-types/src/capture-annotate.mjs` 加一条工具定义
 * + 在这里 `registerPainter(id, fn)`，其余代码零改动。
 *
 * 每个 painter 的签名：`(ctx2d, op) => void`
 * op 字段约定见 `capture-annotate.mjs` 文件头（坐标全是画布像素）。
 */

import {
  CAPTURE_HIGHLIGHT_ALPHA,
  CAPTURE_HIGHLIGHT_SCALE
} from '@hira-ng/shared-types/src/capture-annotate.mjs'

export interface CapturePoint {
  x: number
  y: number
}

export interface CaptureOp {
  tool: string
  color?: string
  lineWidth?: number
  x?: number
  y?: number
  w?: number
  h?: number
  x1?: number
  y1?: number
  x2?: number
  y2?: number
  points?: CapturePoint[]
  text?: string
  fontSize?: number
  block?: number
  radius?: number
}

export type CapturePainter = (ctx: CanvasRenderingContext2D, op: CaptureOp) => void

export const PAINTERS = new Map<string, CapturePainter>()

/** 登记一个画笔。 */
export function registerPainter(tool: string, painter: CapturePainter): void {
  if (typeof painter === 'function') PAINTERS.set(String(tool), painter)
}

/** 画一条 op；未知工具静默跳过，允许旧数据继续打开。 */
export function paintOp(ctx: CanvasRenderingContext2D, op: CaptureOp | null | undefined): void {
  if (!ctx || !op) return
  const painter = PAINTERS.get(String(op.tool))
  if (painter) painter(ctx, op)
}

const TAU = Math.PI * 2

/** 统一的描边参数（圆头圆角，放大缩小后观感一致）。 */
function strokeSetup(ctx: CanvasRenderingContext2D, color?: string, lineWidth?: number) {
  ctx.strokeStyle = color || '#e5484d'
  ctx.lineWidth = Math.max(1, Number(lineWidth) || 4)
  ctx.lineCap = 'round'
  ctx.lineJoin = 'round'
}

/** 复用一块离屏画布（马赛克 / 模糊都要中转，避免每次落笔新建 canvas）。 */
let _scratch: HTMLCanvasElement | null = null
function scratch(w: number, h: number): HTMLCanvasElement {
  if (!_scratch) _scratch = document.createElement('canvas')
  const width = Math.max(1, Math.round(w))
  const height = Math.max(1, Math.round(h))
  if (_scratch.width !== width || _scratch.height !== height) {
    _scratch.width = width
    _scratch.height = height
  }
  const ctx = _scratch.getContext('2d')
  if (!ctx) throw new Error('2D canvas context is unavailable')
  ctx.setTransform(1, 0, 0, 1, 0, 0)
  ctx.globalAlpha = 1
  ctx.filter = 'none'
  ctx.clearRect(0, 0, width, height)
  return _scratch
}

/* ── 矩形 ─────────────────────────────────────────────────────────── */
registerPainter('rect', (ctx, op) => {
  ctx.save()
  strokeSetup(ctx, op.color, op.lineWidth)
  ctx.strokeRect(Number(op.x) || 0, Number(op.y) || 0, Number(op.w) || 0, Number(op.h) || 0)
  ctx.restore()
})

/* ── 椭圆 ─────────────────────────────────────────────────────────── */
registerPainter('ellipse', (ctx, op) => {
  ctx.save()
  strokeSetup(ctx, op.color, op.lineWidth)
  ctx.beginPath()
  const x = Number(op.x) || 0
  const y = Number(op.y) || 0
  const w = Number(op.w) || 0
  const h = Number(op.h) || 0
  ctx.ellipse(x + w / 2, y + h / 2, Math.abs(w) / 2, Math.abs(h) / 2, 0, 0, TAU)
  ctx.stroke()
  ctx.restore()
})

/* ── 箭头 ─────────────────────────────────────────────────────────── */
registerPainter('arrow', (ctx, op) => {
  const x1 = Number(op.x1) || 0
  const y1 = Number(op.y1) || 0
  const x2 = Number(op.x2) || 0
  const y2 = Number(op.y2) || 0
  const width = Math.max(1, Number(op.lineWidth) || 4)
  const angle = Math.atan2(y2 - y1, x2 - x1)
  // 箭头头部与线宽成套：线越粗头越大，但给一个下限免得细线时看不见。
  const head = Math.max(width * 3.2, 10)
  ctx.save()
  strokeSetup(ctx, op.color, width)
  ctx.beginPath()
  ctx.moveTo(x1, y1)
  ctx.lineTo(x2, y2)
  ctx.stroke()
  // 头部用**填充三角**（比两条斜线更实、缩小时也不会糊成一团）。
  ctx.fillStyle = op.color || '#e5484d'
  ctx.beginPath()
  ctx.moveTo(x2, y2)
  ctx.lineTo(x2 - head * Math.cos(angle - Math.PI / 7), y2 - head * Math.sin(angle - Math.PI / 7))
  ctx.lineTo(x2 - head * Math.cos(angle + Math.PI / 7), y2 - head * Math.sin(angle + Math.PI / 7))
  ctx.closePath()
  ctx.fill()
  ctx.restore()
})

/* ── 画笔（手绘）──────────────────────────────────────────────────── */
registerPainter('pen', (ctx, op) => {
  const points = Array.isArray(op.points) ? op.points : []
  if (points.length < 2) return
  ctx.save()
  strokeSetup(ctx, op.color, op.lineWidth)
  ctx.beginPath()
  ctx.moveTo(points[0].x, points[0].y)
  for (let i = 1; i < points.length; i += 1) ctx.lineTo(points[i].x, points[i].y)
  ctx.stroke()
  ctx.restore()
})

/* ── 高亮（半透明宽笔）────────────────────────────────────────────── */
registerPainter('highlight', (ctx, op) => {
  const points = Array.isArray(op.points) ? op.points : []
  if (points.length < 2) return
  ctx.save()
  ctx.globalAlpha = CAPTURE_HIGHLIGHT_ALPHA
  strokeSetup(ctx, op.color, Math.max(2, (Number(op.lineWidth) || 4) * CAPTURE_HIGHLIGHT_SCALE))
  ctx.beginPath()
  ctx.moveTo(points[0].x, points[0].y)
  for (let i = 1; i < points.length; i += 1) ctx.lineTo(points[i].x, points[i].y)
  ctx.stroke()
  ctx.restore()
})

/* ── 文字 ─────────────────────────────────────────────────────────── */
registerPainter('text', (ctx, op) => {
  const text = String(op.text || '')
  if (!text) return
  const size = Math.max(8, Number(op.fontSize) || 20)
  ctx.save()
  ctx.fillStyle = op.color || '#e5484d'
  ctx.font = `600 ${size}px system-ui, -apple-system, "Segoe UI", "Microsoft YaHei", sans-serif`
  ctx.textBaseline = 'top'
  const lines = text.split('\n')
  const lineHeight = size * 1.3
  const x = Number(op.x) || 0
  const y = Number(op.y) || 0
  lines.forEach((line, i) => ctx.fillText(line, x, y + i * lineHeight))
  ctx.restore()
})

/* ── 马赛克 ───────────────────────────────────────────────────────── */
registerPainter('mosaic', (ctx, op) => {
  const w = Math.max(1, Math.round(Number(op.w) || 0))
  const h = Math.max(1, Math.round(Number(op.h) || 0))
  const block = Math.max(2, Math.round(Number(op.block) || 14))
  const sw = Math.max(1, Math.round(w / block))
  const sh = Math.max(1, Math.round(h / block))
  // 降采样 → 关掉平滑再放大：每个格子取区域内的平均色，是"马赛克"而不是"缩小再糊"。
  const small = scratch(sw, sh)
  const sctx = small.getContext('2d')
  if (!sctx) return
  sctx.imageSmoothingEnabled = true
  const x = Number(op.x) || 0
  const y = Number(op.y) || 0
  sctx.drawImage(ctx.canvas, x, y, w, h, 0, 0, sw, sh)
  ctx.save()
  ctx.imageSmoothingEnabled = false
  ctx.drawImage(small, 0, 0, sw, sh, x, y, w, h)
  ctx.restore()
})

/* ── 模糊 ─────────────────────────────────────────────────────────── */
registerPainter('blur', (ctx, op) => {
  const x = Number(op.x) || 0
  const y = Number(op.y) || 0
  const w = Math.max(1, Math.round(Number(op.w) || 0))
  const h = Math.max(1, Math.round(Number(op.h) || 0))
  const radius = Math.max(1, Number(op.radius) || 12)
  // 带外扩边距：不留边的话，模糊会把区域边缘的像素当"外面是透明"，四周出现一圈灰晕。
  const pad = Math.ceil(radius * 2)
  const tw = w + pad * 2
  const th = h + pad * 2
  const tmp = scratch(tw, th)
  const tctx = tmp.getContext('2d')
  if (!tctx) return
  tctx.filter = `blur(${radius}px)`
  tctx.drawImage(ctx.canvas, x - pad, y - pad, tw, th, 0, 0, tw, th)
  ctx.save()
  ctx.beginPath()
  ctx.rect(x, y, w, h)
  ctx.clip()
  ctx.drawImage(tmp, 0, 0, tw, th, x - pad, y - pad, tw, th)
  ctx.restore()
})
