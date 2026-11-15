/**
 * 新标签页 · 网格几何与落位（纯函数，零 DOM、零状态）
 *
 * 全部是纯函数：给定矩形集合与列数，算出「应该在哪」。
 * board 只负责把结果写进 DOM —— 于是布局算法可以独立演进、独立验证，
 * 也让「拖拽跟手」这件事只取决于 board 的渲染手法，不受算法拖累。
 *
 * 坐标一律是**网格单位**：{ x, y, w, h }。像素换算只在渲染那一刻发生。
 *
 * ── 核心纪律：**操作只影响被操作的那一格**（用户反馈，见下）──────────────
 * 曾经这里有一套「重力上浮 + 重叠让位」：拖动一格，别的格子会实时被推来推去、
 * 上面的洞也会被自动补上。用户的原话是"随意惯性改原本好好的位置"——
 * 摆放是用户亲手摆的资产，系统**无权**在他拖 A 的时候去挪 B。
 * 于是现在只剩一条铁律：
 *   `placeFree` 只给**一个**格子找落点，其余格子一个字都不动；
 *   落点被占 → 给这一格找**最近的**空位，绝不推别人。
 * 洞就是洞，用户想补自然会去拖；系统不再自作主张。
 *
 * ── 横向与纵向是两套规则（刻意不对称）────────────────────────────────
 *   横向：**只有三处锚点** —— 贴左 / 正中 / 贴右，且三处必然左右对称（见 hAnchors）。
 *         卡片宽度不同 ⇒ 锚点坐标不同；同一行的「左 + 中 + 右」宽度互补时永远拼成对称整行。
 *   纵向：仍是普通整数行（从上到下生长，不设上限）。
 *   于是"横向对齐到完美对称、纵向自由堆叠"这件事只在**这一个模块**里有定义，
 *   board 拿到的永远已经是合法落点，不需要自己判断"这一格算不算对称"。
 */

import type { LayoutBucket, Rect, Size } from './types.js'

/**
 * 格子间距与行高（px）。
 * 这两项决定"一次拖/一次缩放跳多远"，也就是手感粗细。
 * 当前取值（12 / 52 → 步长 64px）比初版（14 / 84 → 步长 98px）细了近三成，
 * 因为用户反馈"缩放太大、没法自己调到合适"—— 步长大，就等于每次都是大跳。
 */
export const GAP = 12
export const ROW_H = 52

/**
 * 一组像素换算函数。宽度变化时重建一份即可。
 * @param opts 画布宽度、列数与网格步长
 */
export function metrics(opts: { width: number; cols: number; gap?: number; rowH?: number }) {
  const gap = opts.gap ?? GAP
  const rowH = opts.rowH ?? ROW_H
  const cols = Math.max(1, opts.cols | 0)
  const cellW = Math.max(1, (opts.width - gap * (cols - 1)) / cols)
  const stepX = cellW + gap
  const stepY = rowH + gap
  return {
    cols,
    gap,
    rowH,
    cellW,
    stepX,
    stepY,
    /** 可用宽（px）：画布的整宽。纵向无关，横向求"精确居中"时要用（见 board 的像素落点）。 */
    width: opts.width,
    /** 网格 x → 像素 left */
    xAt: (gx: number) => gx * stepX,
    /** 网格 y → 像素 top */
    yAt: (gy: number) => gy * stepY,
    /** 网格宽 → 像素宽（n 格含 n-1 个间隙） */
    wAt: (gw: number) => gw * cellW + (gw - 1) * gap,
    hAt: (gh: number) => gh * rowH + (gh - 1) * gap
  }
}

/** 两个矩形是否重叠（边贴边不算）。 */
function overlaps(a: Rect, b: Rect): boolean {
  return a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h
}

// ── 横向：三处对称锚点（全板唯一的横向落点规则）────────────────────────────

/**
 * 横向锚点 —— **只有三处**，且必然「绝对完美对称」：贴左 / 正中 / 贴右。
 *
 * 为什么正中要用 `(cols − w) / 2` 这种可能带 .5 的表达（而不是凑成整数格）：
 *   画布内容宽 ≡ width（`cols·cellW + (cols−1)·gap` 展开后正好把 cellW 的除法约掉，见 metrics），
 *   卡片宽 = `w·cellW + (w−1)·gap`，两者之差恰为 `(cols−w)·stepX`，
 *   所以 `xAt((cols−w)/2)` 就是**精确的** `(width − cardW)/2` ——
 *   居中与列数、卡片宽的奇偶完全无关；反倒是"凑整数格"会让宽度为奇数的卡片永远偏半格。
 *
 * 卡片宽度不同 ⇒ 三处锚点坐标不同（这就是"对不同尺寸不一样"）：
 * 宽度互补的「左 + 中 + 右」三张卡永远拼成一整行，且左右留白逐像素相等。
 *
 * @param {number} cols
 * @param {number} w 卡片宽（网格单位，会被夹进 [1, cols] 并取整）
 * @returns {number[]} 升序的锚点（网格单位；正中可能是 .5）
 */
export function hAnchors(cols: number, w: number): number[] {
  const cw = Math.max(1, Math.min(Math.round(w), cols))
  const mid = (cols - cw) / 2
  const right = cols - cw
  const out = [0]
  if (mid > 0) out.push(mid)
  if (right > 0 && right !== mid) out.push(right)
  return out
}

/**
 * 把横坐标吸附到**最近的对称锚点**。
 * 这是全板唯一的横向落点规则：凡写进布局的 x 都会经过它（placeFree / firstFreeSlot / 拖拽），
 * 于是永远不会出现"偏一格"的中间态 —— 要么贴左、要么正中、要么贴右。
 * @param {number} cols
 * @param {number} w
 * @param {number} x 期望位置（网格单位，任意浮点）
 * @returns {number} 三处锚点之一
 */
export function hAnchor(cols: number, w: number, x: number): number {
  const list = hAnchors(cols, w)
  const want = Number(x)
  if (!Number.isFinite(want)) return list[0]
  let best = list[0]
  let bestD = Infinity
  for (const a of list) {
    const d = Math.abs(a - want)
    if (d < bestD) {
      bestD = d
      best = a
    }
  }
  return best
}

/** 看板行数（最底边）。 */
function rowsOf(rects: LayoutBucket): number {
  let rows = 0
  for (const id in rects) rows = Math.max(rows, rects[id].y + rects[id].h)
  return rows
}

/**
 * 这一格放在 `rect` 会不会压到**别人**（不含 `excludeId`）。
 * 让"尺寸能不能再长一点""这个落点合法吗"这类判断都走同一个判据。
 * @param {Record<string, {x:number,y:number,w:number,h:number}>} rects
 * @param {string|null} excludeId
 * @param {{x:number,y:number,w:number,h:number}} rect
 */
export function collides(rects: LayoutBucket, excludeId: string | null, rect: Rect): boolean {
  for (const id in rects) {
    if (id === excludeId) continue
    if (overlaps(rect, rects[id])) return true
  }
  return false
}

/**
 * 给**一个**格子找落点 —— 全板唯一"落位"入口，其余格子一个字都不动。
 *
 * 语义（按用户要求"操作只影响被操作的那一格"）：
 *   1. `want` 那一刻不压到别人 → **原地就用**（拖动 1:1 停在哪就是哪）；
 *   2. 压到别人 → 从 `want` 出发**由近及远**找第一处不压别人的位置，只挪这一格；
 *   3. 看板向下生长不设上限 ⇒ 一定能找到，绝不返回 null、也绝不会去推别人。
 *
 * 由近及远的顺序：先在同一行（want.y）按横向锚点离 want 的远近试，
 * 再一行一行往外扩（先上后下）—— 于是"稍微往下压到别人"会就近落在旁边，
 * 而不是被甩回顶部。
 *
 * @param {Record<string, {x:number,y:number,w:number,h:number}>} rects
 * @param {{w:number,h:number}} size
 * @param {number} cols
 * @param {{x:number,y:number}} want 期望落点（横向会吸附到最近锚点）
 * @param {string|null} [excludeId] 自己（在 rects 里的话）
 */
export function placeFree(
  rects: LayoutBucket,
  size: Size,
  cols: number,
  want: Pick<Rect, 'x' | 'y'>,
  excludeId: string | null = null
): Rect {
  const w = Math.max(1, Math.min(Math.round(size.w), cols))
  const h = Math.max(1, Math.round(size.h))
  const wantX = hAnchor(cols, w, want.x)
  const wantY = Math.max(0, Math.round(want.y || 0))
  // 横向三处锚点，按离期望位置的远近排序（要移也只移到最近的那个对称位）
  const ordered = hAnchors(cols, w).sort(
    (a, b) => Math.abs(a - wantX) - Math.abs(b - wantX) || a - b
  )
  const limitY = Math.max(rowsOf(rects), wantY + h) + h + 1
  for (let d = 0; d <= limitY; d++) {
    const rows = d === 0 ? [wantY] : [wantY - d, wantY + d]
    for (const y of rows) {
      if (y < 0) continue
      for (const x of ordered) {
        const probe = { x, y, w, h }
        if (!collides(rects, excludeId, probe)) return probe
      }
    }
  }
  return { x: ordered[0], y: limitY, w, h }
}

/**
 * **从另一档推导布局**时用的落位：横向仍只认三处对称锚点，纵向**只向下**。
 *
 * 与 `placeFree` 的差别只在纵向扫描方向，而这条差别正是"窗口变窄后组件排序混乱"的解药：
 *   · `placeFree` 由近及远、**会向上找** —— 适合"用户亲手拖一格，就近给这一格找个不压人的位置"；
 *     但用它推导**一整档**布局时，后推导的卡片会钻进先推导卡片的空隙里，
 *     源布局里的上下顺序（谁在谁下面）就被打乱了。
 *   · `placeDown` 从 `want.y` 起只往下压：先推导的卡片占住上方，后推导的只能落在它下面，
 *     于是**视觉顺序原样保留**；横向仍是贴左 / 正中 / 贴右三处锚点，左右对称一个字没动。
 *
 * @param {Record<string, {x:number,y:number,w:number,h:number}>} rects
 * @param {{w:number,h:number}} size
 * @param {number} cols
 * @param {{x:number,y:number}} want 推导出的期望落点（横向会吸附到最近对称锚点）
 * @param {string|null} [excludeId]
 */
export function placeDown(
  rects: LayoutBucket,
  size: Size,
  cols: number,
  want: Pick<Rect, 'x' | 'y'>,
  excludeId: string | null = null
): Rect {
  const w = Math.max(1, Math.min(Math.round(size.w), cols))
  const h = Math.max(1, Math.round(size.h))
  const wantX = hAnchor(cols, w, want.x)
  const startY = Math.max(0, Math.round(want.y || 0))
  // 横向：三处锚点按离期望位置的远近排序（要移也只移到最近的对称位）
  const ordered = hAnchors(cols, w).sort(
    (a, b) => Math.abs(a - wantX) - Math.abs(b - wantX) || a - b
  )
  const limitY = Math.max(rowsOf(rects), startY + h) + h + 1
  for (let y = startY; y <= limitY; y++) {
    for (const x of ordered) {
      const probe = { x, y, w, h }
      if (!collides(rects, excludeId, probe)) return probe
    }
  }
  return { x: ordered[0], y: limitY, w, h }
}

/**
 * 为新格子找第一个空位（新组件落位用：上面有洞就填洞）。
 * 就是 `placeFree` 从左上角出发的特例 —— 顺序仍是「整行扫完三处锚点再下一行」。
 * ⚠ 只用于**真正新增**的组件；"从另一档推导已有组件"请用 `placeDown`（见上）。
 * @param {Record<string, {x:number,y:number,w:number,h:number}>} rects
 * @param {{w:number,h:number}} size
 * @param {number} cols
 */
export function firstFreeSlot(rects: LayoutBucket, size: Size, cols: number): Rect {
  return placeFree(rects, size, cols, { x: 0, y: 0 })
}
