/**
 * spatial-nav —— 空间导航（N9）的**纯几何规则层**。
 *
 * ── 它解决什么 ────────────────────────────────────────────────────
 * 网页上的链接 / 按钮散在二维平面上，而 Tab 键只按 **DOM 顺序**走 —— 想从"右上角的
 * 搜索框"跳到"它正下方的按钮"，往往要按十几次 Tab 并跨过整页无关元素。
 * 空间导航让**方向键按几何位置**跳：按 ↓ 就落到当前元素**正下方最近**的那个可点元素。
 *（Opera / Vivaldi 的老功能，Firefox 现在是 `spatialNavigation.enabled`。）
 *
 * ── 为什么单开一个纯层模块 ────────────────────────────────────────
 * 判据是纯几何运算，与 DOM 无关：preload（页面侧引擎）把它量好的矩形喂进来即可。
 * 于是同一份算法能被 preload、单测、（将来的）主进程侧复用 —— 不抄第二份。
 * 模块**不认识任何 DOM 类型**，只认 `{x, y, w, h}`。
 */

/**
 * 矩形在某一轴上的区间"间隙"：重叠（含相接）返回 0，否则返回两段之间的距离。
 * @param {number} a1 @param {number} a2 区间 A 的 [起, 止]
 * @param {number} b1 @param {number} b2 区间 B 的 [起, 止]
 */
function intervalGap(a1: number, a2: number, b1: number, b2: number) {
  if (a2 < b1) return b1 - a2
  if (b2 < a1) return a1 - b2
  return 0
}

/** 矩形中心（`{x,y,w,h}` 一律是视口坐标，宽高非负）。 */
function center(r: { x: number; y: number; w: number; h: number }): { x: number; y: number } {
  return { x: r.x + r.w / 2, y: r.y + r.h / 2 }
}

/**
 * 从候选矩形里挑出"朝 `dir` 方向该去的那个"。
 *
 * 判据（业界通用的两条，缺一条手感就崩）：
 *   1. **必须在那个方向上** —— 候选中心相对当前中心在该轴上的位移为正，否则不考虑。
 *      只用中心比较，于是"同一行并排的两个元素"不会在按 ↓ 时互相跳。
 *   2. **优先投影重叠的** —— 先只在"正交轴上与当前元素有重叠"的候选里挑（真正在正上/正下
 *      /正左/正右的那些）；一个都没有时（如 SPA 里的散点布局）才退回全部同向候选。
 *      不这么做的话，按 ↓ 会斜着跳到很远但"分数略低"的元素上，用户会觉得"乱跳"。
 *   打分 = 主轴距离 + 2 × 正交间隙 —— 正交偏差要**重罚**，所以宁可多走一段正前方。
 *
 * @param {Array<{x:number,y:number,w:number,h:number}>} rects 候选矩形（视口坐标）
 * @param {{x:number,y:number,w:number,h:number}|null} current 当前元素矩形；
 *   `null` = 当前没有焦点 —— 此时以视口中心为起点（按 ↓ 就落到屏幕中线以下的第一个）
 * @param {'left'|'right'|'up'|'down'} dir
 * @param {{w:number,h:number}} [viewport] 视口尺寸（`current` 为 null 时用来定起点）
 * @returns {number} 命中项在 `rects` 里的下标；没有可去的目标返回 -1
 */
export function pickSpatialTarget(rects: Array<{ x:number,y:number,w:number,h:number }>, current: { x:number,y:number,w:number,h:number }|null, dir: 'left'|'right'|'up'|'down', viewport: { w:number,h:number }) : number {
  if (!Array.isArray(rects) || rects.length === 0) return -1
  const horizontal = dir === 'left' || dir === 'right'

  // 起点：有焦点用它的矩形；没有焦点就在视口正中放一个零尺寸矩形。
  const originRect = current || {
    x: ((viewport && viewport.w) || 0) / 2,
    y: ((viewport && viewport.h) || 0) / 2,
    w: 0,
    h: 0
  }
  const origin = center(originRect)

  let best = -1
  let bestAligned = -1
  let bestScore = Infinity
  let bestAlignedScore = Infinity

  for (let i = 0; i < rects.length; i++) {
    const r = rects[i]
    if (!r || r.w <= 0 || r.h <= 0) continue
    const c = center(r)

    // ① 必须在目标方向上（按中心比较）。
    const main = horizontal
      ? (dir === 'right' ? c.x - origin.x : origin.x - c.x)
      : (dir === 'down' ? c.y - origin.y : origin.y - c.y)
    if (main <= 0) continue

    // ② 正交轴上的间隙（0 = 投影重叠 = "正对着"）。
    const off = horizontal
      ? intervalGap(originRect.y, originRect.y + originRect.h, r.y, r.y + r.h)
      : intervalGap(originRect.x, originRect.x + originRect.w, r.x, r.x + r.w)

    const score = main + off * 2
    if (score < bestScore) { bestScore = score; best = i }
    if (off === 0 && score < bestAlignedScore) { bestAlignedScore = score; bestAligned = i }
  }

  // 有"正对着"的就优先它（见上文判据 ②）。
  return bestAligned !== -1 ? bestAligned : best
}

/** 方向键 → 方向名。不是方向键返回 `null`（调用方据此放行给页面/滚动）。 */
export function directionOfKey(key: unknown): 'left' | 'right' | 'up' | 'down' | null {
  switch (key) {
    case 'ArrowLeft': return 'left'
    case 'ArrowRight': return 'right'
    case 'ArrowUp': return 'up'
    case 'ArrowDown': return 'down'
    default: return null
  }
}
