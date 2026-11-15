/**
 * split-layout.mjs —— 分屏几何的**唯一真源**（跨进程纯函数 + 常量）
 *
 * ── 为什么必须是一份（而不是主进程、渲染层各写一遍）──────────────
 * 主进程要按结果给每个 `WebContentsView` 落 bounds；渲染层要按**同一份结果**画分隔条、
 * 算拖拽热区。两处各写一份算术，迟早漂移 —— 漂移的表现是"分隔条与网页差几个像素"
 * 或"拖到某个位置比例就跳"，而且两边都觉得自己对。
 * 这与 `preview-placement.mjs` 的存在理由同源：几何只能有一份。
 *
 * ── 模型（三层）────────────────────────────────────────────────
 *   rect     —— 内容区（已扣掉顶/底栏、侧栏区、rail、左右面板的那块）
 *   layout   —— 'row'（左右并排）| 'column'（上下并排）| 'grid'（网格）
 *   ratios   —— 各格占比，长度 = 格数，和恒为 1（**唯一可变的状态**）
 *
 * 摆放是 `rect + layout + ratios` 的**纯推导**：换一种形态只换 `layout` 这个数据，
 * 不需要第二条代码路径（这是"布局是数据，不是分支"的落地）。
 *
 * ── 三条不变式（不满足即视为 bug）───────────────────────────────
 *   I1 各格 + 分隔条**精确铺满** rect（无 1px 缝、无 1px 重叠）；
 *   I2 每格尺寸 ≥ `minPane`（若无解则等分并置 `clamped: true`，绝不产出负数或 0 尺寸）；
 *   I3 分隔条永远**落在相邻两格之间**（位置由格算出来，不是独立状态）。
 *
 * 纯函数：零依赖、零 IO、不碰 DOM、不 require electron。主进程（CJS require）与
 * 渲染层（ESM import）读**同一份文件**（本文件是 `.mjs`，Electron 43 运行时为 Node 24，
 * `require()` 可直接加载 ESM —— 与 `layout.mjs` 同款约定）。
 */

/** 三种形态。`row` / `column` 是日常形态，`grid` 是 2×2 及以上。 */
const SPLIT_LAYOUTS = Object.freeze(['row', 'column', 'grid'])

/** 缺省形态。 */
const DEFAULT_SPLIT_LAYOUT = 'row' as const

/**
 * 尺寸口径（主进程与渲染层必须读同一份 —— 写死两遍就会出现"分隔条比热区宽/窄"）。
 */
const SPLIT_METRICS = Object.freeze({
  /** 单格最小尺寸（宽或高）。低于它网页布局会崩，且无法阅读。 */
  minPane: 120,
  /** 分隔条厚度（相邻两格之间的那一条）。 */
  divider: 6,
  /**
   * 每格四周留出的**空隙**（px）。它同时是活动格"淡蓝框"的落点。
   *
   * 为什么要有这个空隙：网页是原生 WebContentsView，**盖在外壳 DOM 之上** ——
   * 外壳画不出任何压在网页上的东西。于是活动格的框只能画在**没有被网页覆盖的那一条**里，
   * 就必须先把每格从自己的矩形里收进 `paneGap`，把那一圈让出来。
   *
   * ⚠ 它是**恒定值**（只要在分屏里就不变），所以**切活动格不改变任何一格的 bounds** ——
   *   换框只是一次 DOM 变化（与分隔条同款），不会让网页重排。这一点是刻意的：
   *   若改成"只给活动格收边"，每切一次活动格都会让两格各 resize 一次。
   */
  paneGap: 2,
  /** 上限：WebContentsView 有内存成本，且每格都要保持可读宽度。 */
  maxPanes: 4,
  /** 默认形态。 */
  defaultLayout: DEFAULT_SPLIT_LAYOUT
})

/**
 * 归一化形态取值（设置文件可手改 / 旧数据可能缺字段）。
 * @param {unknown} value
 * @returns {'row'|'column'|'grid'}
 */
function normalizeSplitLayout(value: unknown) : 'row'|'column'|'grid' {
  const layout = String(value)
  return layout === 'row' || layout === 'column' || layout === 'grid' ? layout : DEFAULT_SPLIT_LAYOUT
}

// ── 设置项（真源；设置页 options 与主进程读取共用同一份，不各抄一遍中文名）─────────

/** 设置键名。与 shared-types#LAYOUT_SETTING_KEYS 同一手法：键名的主人是本模块。 */
const SPLIT_SETTING_KEYS = Object.freeze({
  /** 「分屏最多格数」：2 / 3 / 4。它只约束**新建 / 加入**，不改已存在的组。 */
  maxPanes: 'app.split_max_panes',
  /** 「分屏默认方向」：新建分屏时用 row 还是 column。 */
  defaultLayout: 'app.split_default_layout',
  /** 「格间链接路由」：从某一格点开的 `target=_blank` / `window.open` 落到哪。 */
  linkRouting: 'app.split_link_routing'
})

/** 最多格数下拉的 [值, 中文名]（值是字符串，与设置存储一致）。 */
const SPLIT_MAX_PANES_OPTIONS = Object.freeze([
  ['2', '2 格'],
  ['3', '3 格'],
  ['4', '4 格']
])

/** 默认最多格数（硬上限仍是 `SPLIT_METRICS.maxPanes`，用户口径不能超过它）。 */
const DEFAULT_SPLIT_MAX_PANES = 4

/**
 * 默认方向下拉的 [值, 中文名]。
 * 刻意**不含 grid**：网格要有 3 格以上才有意义，作为"默认方向"只会让 2 格分屏
 * 落进一个与"上下"逐像素相同的形态。网格仍可在标签菜单里手动切（3 格以上）。
 */
const SPLIT_LAYOUT_OPTIONS = Object.freeze([
  ['row', '左右并排'],
  ['column', '上下并排']
])

/** 格间链接路由的两个取值。 */
const SPLIT_LINK_ROUTING_OFF = 'off'
const SPLIT_LINK_ROUTING_ADJACENT = 'adjacent-pane'

/** 格间链接路由下拉的 [值, 中文名]。 */
const SPLIT_LINK_ROUTING_OPTIONS = Object.freeze([
  [SPLIT_LINK_ROUTING_OFF, '开新标签页（默认）'],
  [SPLIT_LINK_ROUTING_ADJACENT, '开在分屏的下一格']
])

/**
 * 默认值 = **开新标签页**。
 *
 * 不默认开启的理由：这是唯一一个"会改变网页里点击结果去向"的分屏开关。默认改掉它，
 * 用户会遇到"点了链接，当前这格被顶掉/另一格换了页面"而我方没有任何提示 ——
 * 与 Edge 把它做成 opt-in 同口径（Edge 的 "Open links in the other pane" 默认不开）。
 */
const DEFAULT_SPLIT_LINK_ROUTING = SPLIT_LINK_ROUTING_OFF

/** 归一化格间链接路由取值（设置文件可手改）。 */
function normalizeSplitLinkRouting(value: unknown): string {
  return String(value) === SPLIT_LINK_ROUTING_ADJACENT ? SPLIT_LINK_ROUTING_ADJACENT : SPLIT_LINK_ROUTING_OFF
}

/**
 * 归一化格数（1..maxPanes）。1 格 = 不构成分屏（调用方据此走单视图路径）。
 * @param {unknown} value
 * @param {number} [max]
 * @returns {number}
 */
function normalizeSplitCount(value: unknown, max: number) : number {
  const n = Math.floor(Number(value))
  const cap = Number.isFinite(Number(max)) ? Number(max) : SPLIT_METRICS.maxPanes
  if (!Number.isFinite(n) || n < 1) return 1
  return Math.min(cap, n)
}

/**
 * 归一化比例数组：长度补齐/截断到 `count`，每项 > 0，和恒为 1。
 *
 * 为什么要"和恒为 1"：拖拽分隔条会反复改比例，若允许和不为 1，求解器每次都要
 * 自己猜归一化口径，累积误差会让比例慢慢漂走（用户感受是"越拖越偏"）。
 * 存储层保持归一化，显示层按需换算成像素。
 *
 * @param {unknown} value
 * @param {number} count
 * @returns {number[]}
 */
function normalizeSplitRatios(value: unknown, count: number) : number[] {
  const n = Math.max(1, Math.floor(Number(count)) || 1)
  const src = Array.isArray(value) ? value : []
  const out = new Array(n)
  let sum = 0
  for (let i = 0; i < n; i++) {
    const v = Number(src[i])
    const safe = Number.isFinite(v) && v > 0 ? v : 1
    out[i] = safe
    sum += safe
  }
  if (!(sum > 0)) return new Array(n).fill(1 / n)
  for (let i = 0; i < n; i++) out[i] = out[i] / sum
  return out
}

/**
 * 把一段可用长度按比例切成 `ratios.length` 个**整数**，和精确等于 `total`。
 *
 * 为什么最后一段是"减法得出"：逐段四舍五入会累积误差，最后一段吃掉误差 →
 * 各段之和恒等于 total（I1 的前半条），不会出现 1px 缝。
 *
 * @param {number} total
 * @param {number[]} ratios
 * @returns {number[]}
 */
function distribute(total: number, ratios: number[]) : number[] {
  const n = ratios.length
  const out = new Array(n)
  let used = 0
  for (let i = 0; i < n - 1; i++) {
    const v = Math.round(total * ratios[i])
    out[i] = Math.max(0, v)
    used += out[i]
  }
  out[n - 1] = Math.max(0, Math.round(total) - used)
  return out
}

/**
 * 对一组尺寸施加最小尺寸下限，并保证和不变（把亏空从最大的那一格扣）。
 *
 * ⚠ 不做这一步的后果：把窗口拖窄到某个宽度时，某一格会算出 0 或负数 →
 * `setBounds({width: 0})` 让网页彻底消失，用户以为"标签关了"。
 *
 * @param {number[]} sizes
 * @param {number} total
 * @param {number} minSize
 * @returns {{ sizes: number[], clamped: boolean }}
 */
function applyMinSize(sizes: number[], total: number, minSize: number) : { sizes: number[], clamped: boolean } {
  const n = sizes.length
  const min = Math.max(0, Math.floor(Number(minSize) || 0))
  if (min <= 0) return { sizes, clamped: false }
  if (total < min * n) {
    // 无解：等分（仍保证总和 = total，各格可能低于下限 —— 但绝不为负）。
    const even = Math.floor(total / n)
    const out = new Array(n).fill(even)
    out[n - 1] = Math.max(0, Math.round(total) - even * (n - 1))
    return { sizes: out, clamped: true }
  }
  let clamped = false
  const out = sizes.slice()
  for (let i = 0; i < n; i++) {
    if (out[i] < min) {
      out[i] = min
      clamped = true
    }
  }
  if (!clamped) return { sizes: out, clamped: false }
  // 亏空从"最大的那一格"扣（它最承受得起），扣到不能再扣为止。
  let excess = out.reduce((a, b) => a + b, 0) - Math.round(total)
  while (excess > 0) {
    let big = 0
    for (let i = 1; i < n; i++) if (out[i] > out[big]) big = i
    if (out[big] <= min) break
    const take = Math.min(excess, out[big] - min)
    out[big] -= take
    excess -= take
  }
  // 还有剩余亏空（说明 min 本身撑破了 total）→ 从最大的那格继续扣到 floor 0。
  while (excess > 0) {
    let big = 0
    for (let i = 1; i < n; i++) if (out[i] > out[big]) big = i
    if (out[big] <= 0) break
    const take = Math.min(excess, out[big])
    out[big] -= take
    excess -= take
  }
  return { sizes: out, clamped: true }
}

/**
 * 网格的行列数：`cols = ceil(sqrt(n))`，`rows = ceil(n/cols)`。
 * 末行不足时保留空格（不拉伸最后一行 —— 拉伸会让同一列的两格宽度不一致，
 * 看起来像画错了；留空更像"网格"）。
 * @param {number} count
 * @returns {{ cols: number, rows: number }}
 */
function gridShape(count: number) : { cols: number, rows: number } {
  const cols = Math.max(1, Math.ceil(Math.sqrt(count)))
  const rows = Math.max(1, Math.ceil(count / cols))
  return { cols, rows }
}

/**
 * **核心求解器**：内容区 + 形态 + 比例 → 每格矩形 + 分隔条矩形。
 *
 * @param {{
 *   rect: { x?: number, y?: number, width: number, height: number },
 *   layout?: unknown,
 *   ratios?: unknown,
 *   count?: number,
 *   divider?: number,
 *   minPane?: number,
 *   gridRatios?: { cols?: unknown, rows?: unknown } | null
 * }} input
 * @returns {{
 *   layout: 'row'|'column'|'grid',
 *   count: number,
 *   panes: Array<{ index:number, x:number, y:number, width:number, height:number }>,
 *   dividers: Array<{ index:number, axis:'x'|'y', x:number, y:number, width:number, height:number }>,
 *   ratios: number[],
 *   clamped: boolean
 * }}
 */
function solveSplitPanes(input: {
  rect: { x?: number; y?: number; width: number; height: number }
  layout?: unknown
  ratios?: unknown
  count?: number
  divider?: number
  minPane?: number
  gridRatios?: { cols?: unknown; rows?: unknown } | null
}) : {
  layout: 'row'|'column'|'grid',
  count: number,
  panes: Array<{ index:number, x:number, y:number, width:number, height:number }>,
  dividers: Array<{ index:number, axis:'x'|'y', x:number, y:number, width:number, height:number }>,
  ratios: number[],
  clamped: boolean
} {
  const src = input
  const rect = src.rect || { width: 0, height: 0 }
  const x0 = Math.round(Number(rect.x) || 0)
  const y0 = Math.round(Number(rect.y) || 0)
  const width = Math.max(0, Math.round(Number(rect.width) || 0))
  const height = Math.max(0, Math.round(Number(rect.height) || 0))
  const layout = normalizeSplitLayout(src.layout)
  const count = normalizeSplitCount(src.count, SPLIT_METRICS.maxPanes)
  const divider = Math.max(0, Math.min(24, Math.round(Number(src.divider) || SPLIT_METRICS.divider)))
  const minPane = Number.isFinite(Number(src.minPane)) ? Number(src.minPane) : SPLIT_METRICS.minPane

  const panes: Array<{ index:number,x:number,y:number,width:number,height:number }> = []
  const dividers: Array<{ index:number,axis:'x'|'y',x:number,y:number,width:number,height:number }> = []
  let ratios
  let clamped = false

  if (count <= 1) {
    panes.push({ index: 0, x: x0, y: y0, width, height })
    return { layout, count, panes, dividers, ratios: [1], clamped }
  }

  if (layout === 'grid') {
    const { cols, rows } = gridShape(count)
    const colRatios = normalizeSplitRatios(
      src.gridRatios && Array.isArray(src.gridRatios.cols) ? src.gridRatios.cols : null,
      cols
    )
    const rowRatios = normalizeSplitRatios(
      src.gridRatios && Array.isArray(src.gridRatios.rows) ? src.gridRatios.rows : null,
      rows
    )
    const colAvail = width - divider * (cols - 1)
    const rowAvail = height - divider * (rows - 1)
    const colRaw = applyMinSize(distribute(colAvail, colRatios), colAvail, minPane)
    const rowRaw = applyMinSize(distribute(rowAvail, rowRatios), rowAvail, minPane)
    clamped = colRaw.clamped || rowRaw.clamped
    const colSizes = colRaw.sizes
    const rowSizes = rowRaw.sizes

    const colOffsets = []
    let cx = x0
    for (let c = 0; c < cols; c++) {
      colOffsets.push(cx)
      cx += colSizes[c] + divider
    }
    const rowOffsets = []
    let cy = y0
    for (let r = 0; r < rows; r++) {
      rowOffsets.push(cy)
      cy += rowSizes[r] + divider
    }

    for (let i = 0; i < count; i++) {
      const r = Math.floor(i / cols)
      const c = i % cols
      panes.push({
        index: i,
        x: colOffsets[c],
        y: rowOffsets[r],
        width: colSizes[c],
        height: rowSizes[r]
      })
    }
    // 竖分隔条（列之间）—— 每一条跨整块内容区高度。
    for (let c = 0; c < cols - 1; c++) {
      dividers.push({
        index: c,
        axis: 'x',
        x: colOffsets[c] + colSizes[c],
        y: y0,
        width: divider,
        height
      })
    }
    // 横分隔条（行之间）。
    for (let r = 0; r < rows - 1; r++) {
      dividers.push({
        index: cols - 1 + r,
        axis: 'y',
        x: x0,
        y: rowOffsets[r] + rowSizes[r],
        width,
        height: divider
      })
    }
    ratios = colRatios
    return { layout, count, panes, dividers, ratios, clamped }
  }

  const axis = layout === 'column' ? 'y' : 'x'
  const total = axis === 'x' ? width : height
  const avail = total - divider * (count - 1)
  ratios = normalizeSplitRatios(src.ratios, count)
  const solved = applyMinSize(distribute(avail, ratios), avail, minPane)
  clamped = solved.clamped
  const sizes = solved.sizes

  let cursor = axis === 'x' ? x0 : y0
  for (let i = 0; i < count; i++) {
    const size = sizes[i]
    panes.push(
      axis === 'x'
        ? { index: i, x: cursor, y: y0, width: size, height }
        : { index: i, x: x0, y: cursor, width, height: size }
    )
    cursor += size
    if (i < count - 1) {
      dividers.push(
        axis === 'x'
          ? { index: i, axis: 'x', x: cursor, y: y0, width: divider, height }
          : { index: i, axis: 'y', x: x0, y: cursor, width, height: divider }
      )
      cursor += divider
    }
  }
  return { layout, count, panes, dividers, ratios, clamped }
}

/**
 * 拖拽分隔条 → 新比例。**渲染侧拖拽的唯一算术**（分隔条浮层把指针位置交给它）。
 *
 * 只改被拖那一条两侧的两格，其余保持原样 —— 这样"拖第 1 条"不会让第 3 格跟着动。
 *
 * @param {{
 *   rect: { x?: number, y?: number, width: number, height: number },
 *   layout?: unknown,
 *   ratios?: unknown,
 *   count?: number,
 *   dividerIndex: number,
 *   axis: 'x'|'y',
 *   position: number,
 *   divider?: number,
 *   minPane?: number
 * }} input
 * @returns {number[]|null} 新的比例数组；无解（格数 <2 / 索引越界）返回 null
 */
function ratiosFromDrag(input: {
  rect: { x?: number; y?: number; width: number; height: number }
  layout?: unknown
  ratios?: unknown
  count?: number
  dividerIndex: number
  axis: 'x' | 'y'
  position: number
  divider?: number
  minPane?: number
}) : number[]|null {
  const src = input
  const rect = src.rect || { width: 0, height: 0 }
  const count = normalizeSplitCount(src.count, SPLIT_METRICS.maxPanes)
  if (count < 2) return null
  const axis = src.axis === 'y' ? 'y' : 'x'
  const divider = Math.max(0, Math.min(24, Math.round(Number(src.divider) || SPLIT_METRICS.divider)))
  const minPane = Number.isFinite(Number(src.minPane)) ? Number(src.minPane) : SPLIT_METRICS.minPane
  const origin = Math.round(Number(axis === 'x' ? rect.x : rect.y) || 0)
  const total = Math.max(0, Math.round(Number(axis === 'x' ? rect.width : rect.height) || 0))
  const avail = total - divider * (count - 1)
  if (avail <= 0) return null

  const ratios = normalizeSplitRatios(src.ratios, count)
  const sizes = distribute(avail, ratios)

  // 被拖的分隔条落在哪两格之间（row/column 下就是 index 与 index+1）。
  const i = Math.floor(Number(src.dividerIndex))
  if (!Number.isFinite(i) || i < 0 || i >= count - 1) return null

  let before = 0
  for (let k = 0; k < i; k++) before += sizes[k]
  const pairTotal = sizes[i] + sizes[i + 1]
  // 分隔条起点 = 内容区原点 + 前面各格 + 前面各分隔条
  const dividerStart = origin + before + divider * i
  const pointer = Number(src.position)
  if (!Number.isFinite(pointer)) return null

  let nextI = Math.round(pointer - dividerStart)
  if (pairTotal >= minPane * 2) {
    nextI = Math.max(minPane, Math.min(pairTotal - minPane, nextI))
  } else {
    nextI = Math.max(0, Math.min(pairTotal, nextI))
  }
  const out = ratios.slice()
  out[i] = nextI / avail
  out[i + 1] = (pairTotal - nextI) / avail
  return normalizeSplitRatios(out, count)
}

/**
 * 点落在哪一格（渲染层画"活动格高亮"、主进程做命中判定时共用）。
 * @param {{ panes: Array<{index:number,x:number,y:number,width:number,height:number}> }} solved
 * @param {number} x
 * @param {number} y
 * @returns {number|null} pane index，未命中返回 null
 */
function paneIndexAtPoint(solved: { panes: Array<{ index:number,x:number,y:number,width:number,height:number }> }, x: number, y: number) : number|null {
  const panes = solved && Array.isArray(solved.panes) ? solved.panes : []
  const px = Number(x)
  const py = Number(y)
  for (const pane of panes) {
    if (px >= pane.x && px < pane.x + pane.width && py >= pane.y && py < pane.y + pane.height) {
      return pane.index
    }
  }
  return null
}

// ── 比例预设（I2：主从比例一键切换 / 双击分隔条归位）─────────────────────────
//
// 预设用**权重**表达而不是写死的比例数组：格数是变量（2..4），"主格 70%" 在 3 格时
// 应当是 70/15/15 而不是"前两格各 35%"。写死数组必然在格数变化时失真。

/** 比例预设下拉/菜单的 [值, 中文名]。 */
const SPLIT_RATIO_PRESET_OPTIONS = Object.freeze([
  ['even', '均分'],
  ['main-70', '主格 70%'],
  ['main-30', '主格 30%']
])

/**
 * 预设 → 比例数组（长度 = 格数，和恒为 1）。
 *
 * @param {unknown} presetId 'even' | 'main-70' | 'main-30'
 * @param {number} count 格数
 * @returns {number[]}
 */
function ratiosForPreset(presetId: unknown, count: number) : number[] {
  const n = Math.max(1, Math.floor(Number(count)) || 1)
  if (n <= 1) return [1]
  const id = String(presetId)
  if (id === 'main-70' || id === 'main-30') {
    const main = id === 'main-70' ? 0.7 : 0.3
    const rest = (1 - main) / (n - 1)
    return [main, ...new Array(n - 1).fill(rest)]
  }
  return new Array(n).fill(1 / n)
}

/** 两个区间在一根轴上的重叠占比（0..1，以较短的一段为分母）。 */
function overlapRatio(a0: number, aLen: number, b0: number, bLen: number): number {
  const lo = Math.max(a0, b0)
  const hi = Math.min(a0 + aLen, b0 + bLen)
  const inter = Math.max(0, hi - lo)
  const denom = Math.min(aLen, bLen)
  return denom > 0 ? inter / denom : 0
}

/**
 * **从某格出发、按方向找相邻格**（I6：键盘驱动的格导航）。
 *
 * 判定次序：先看"在目标方向那一侧"→ 再比**投影重叠**（同一行/列优先）→ 最后比距离。
 * 只比距离会让"左侧更远的同列格"输给"左侧更近的错行格"，与编辑器里 Ctrl+W h/j/k/l
 * 的直觉相反。重叠为零的候选（完全错行）仍可入选，只是排在重叠者之后 —— 否则
 * 网格里向上/向下就会"没有邻居"。
 *
 * @param {{ panes: Array<{index:number,x:number,y:number,width:number,height:number}> }} solved
 * @param {number} fromIndex 当前格
 * @param {'left'|'right'|'up'|'down'} direction
 * @returns {number|null} 相邻格的 index；该方向没有格时返回 null
 */
function neighborPaneIndex(solved: { panes: Array<{ index:number,x:number,y:number,width:number,height:number }> }, fromIndex: number, direction: 'left'|'right'|'up'|'down') : number|null {
  const panes = solved && Array.isArray(solved.panes) ? solved.panes : []
  const from = panes.find((p) => p.index === Number(fromIndex))
  if (!from) return null
  const dir = String(direction)
  const fx = from.x + from.width / 2
  const fy = from.y + from.height / 2
  let best = null
  for (const pane of panes) {
    if (pane.index === from.index) continue
    const cx = pane.x + pane.width / 2
    const cy = pane.y + pane.height / 2
    let ahead = false
    let distance = 0
    let overlap = 0
    if (dir === 'left') {
      ahead = cx < fx
      distance = fx - cx
      overlap = overlapRatio(from.y, from.height, pane.y, pane.height)
    } else if (dir === 'right') {
      ahead = cx > fx
      distance = cx - fx
      overlap = overlapRatio(from.y, from.height, pane.y, pane.height)
    } else if (dir === 'up') {
      ahead = cy < fy
      distance = fy - cy
      overlap = overlapRatio(from.x, from.width, pane.x, pane.width)
    } else if (dir === 'down') {
      ahead = cy > fy
      distance = cy - fy
      overlap = overlapRatio(from.x, from.width, pane.x, pane.width)
    } else {
      return null
    }
    if (!ahead) continue
    if (!best) {
      best = { index: pane.index, overlap, distance }
      continue
    }
    const betterOverlap = overlap > best.overlap + 1e-6
    const sameOverlap = Math.abs(overlap - best.overlap) <= 1e-6
    if (betterOverlap || (sameOverlap && distance < best.distance)) {
      best = { index: pane.index, overlap, distance }
    }
  }
  return best ? best.index : null
}

/**
 * 该形态下"把新格加在哪一轴"—— 拖拽落点定方向时用（拖到左右边缘 → row，上下 → column）。
 * 纯查表，不认识任何宿主状态。
 * @param {'row'|'column'|'grid'} layout
 * @returns {'x'|'y'|'both'}
 */
function splitAxisOf(layout: 'row'|'column'|'grid') : 'x'|'y'|'both' {
  const l = normalizeSplitLayout(layout)
  if (l === 'row') return 'x'
  if (l === 'column') return 'y'
  return 'both'
}

// ── 拖动落点（拖标签到网页区域 → 决定"在哪边、怎么排"）───────────────────────
//
// 对照 Zen / Vivaldi 的做法（见 docs/tab-drop-zone-design.md）：
//   · 方向由指针在内容区里的**相对位置**决定：左右半边 → 横向并列，上下半边 → 纵向堆叠；
//   · 预览块 = **新格将要占用的那一块**（不是整片内容区、也不是一个方向箭头）——
//     这样"在哪边"由几何本身回答，不需要再读文字；
//   · 预览与最终结果**逐像素一致**（本模块保证：预览矩形 = 求解器算出的那一格再收进 paneGap）。

/** 四个落点区。顺序即"先横后纵"，便于文档引用与测试枚举。 */
const DROP_ZONES = Object.freeze(['left', 'right', 'top', 'bottom'])

/**
 * 落点区 → 预览块矩形（**与求解器给出的那一格同形**：同一套 divider / paneGap）。
 *
 * 表达式与 `solveSplitPanes` 的两格推导一一对应，只是提前算出来：
 *   横向：half = (W − divider)/2；左格 x = x0；右格 x = x0 + half + divider
 *   纵向：half = (H − divider)/2；上格 y = y0；下格 y = y0 + half + divider
 * 再按 `paneGap` 向内收 —— 正是 `LayoutCoordinator#_placeSplitPanes` 对网页 view 做的同一件事。
 *
 * @param {{ rect: {x?: number, y?: number, width: number, height: number}, zone: string, divider?: number, gap?: number }} input
 * @returns {{ x: number, y: number, width: number, height: number }}
 */
function dropZonePaneRect(input: { rect: { x?: number, y?: number, width: number, height: number }, zone: string, divider?: number, gap?: number }) : { x: number, y: number, width: number, height: number } {
  const src = input
  const rect = src.rect || { width: 0, height: 0 }
  const x0 = Math.round(Number(rect.x) || 0)
  const y0 = Math.round(Number(rect.y) || 0)
  const width = Math.max(0, Math.round(Number(rect.width) || 0))
  const height = Math.max(0, Math.round(Number(rect.height) || 0))
  // 显式 0 也是合法入参（0 = 不要缝），所以只对"非有限值"回落到默认。
  const dividerRaw = Number(src.divider)
  const divider = Math.max(0, Math.min(24, Math.round(Number.isFinite(dividerRaw) ? dividerRaw : SPLIT_METRICS.divider)))
  const gapRaw = Number(src.gap)
  const gap = Math.max(0, Math.round(Number.isFinite(gapRaw) ? gapRaw : SPLIT_METRICS.paneGap))
  const zone = DROP_ZONES.includes(String(src.zone)) ? String(src.zone) : 'right'

  if (zone === 'left' || zone === 'right') {
    // 与 `distribute(avail, [.5, .5])` **逐字同式**：第二格的尺寸是"总数减第一格"，
    // 而不是"再一次四舍五入"—— avail 为奇数时两者会差 1px（那 1px 就是"预览块与
    // 真实那一格对不齐"的来源，也是这类实现最常见的最后一处偏差）。
    const avail = width - divider
    const first = Math.round(avail * 0.5)
    const span = zone === 'left' ? first : avail - first
    const x = zone === 'left' ? x0 : x0 + first + divider
    return {
      x: x + gap,
      y: y0 + gap,
      width: Math.max(1, span - gap * 2),
      height: Math.max(1, height - gap * 2)
    }
  }
  const avail = height - divider
  const first = Math.round(avail * 0.5)
  const span = zone === 'top' ? first : avail - first
  const y = zone === 'top' ? y0 : y0 + first + divider
  return {
    x: x0 + gap,
    y: y + gap,
    width: Math.max(1, width - gap * 2),
    height: Math.max(1, span - gap * 2)
  }
}

/**
 * **拖动落点 → 分屏意图**（纯函数，零 IO）。
 *
 * @param {{
 *   x: number, y: number,
 *   rect: { x?: number, y?: number, width: number, height: number },
 *   divider?: number, gap?: number, minSpan?: number
 * }} input
 *   `x`/`y` 与 `rect` 必须同一坐标系（内容区坐标）；`rect` = 网页矩形。
 * @returns {{
 *   zone: 'left'|'right'|'top'|'bottom',
 *   layout: 'row'|'column',
 *   place: 'start'|'end',
 *   rect: { x: number, y: number, width: number, height: number }
 * }|null}
 *   `place='start'` = 被拖的那个标签落在**第 0 格**（左 / 上）；`'end'` = 落在第 1 格（右 / 下）。
 *   无解（矩形放不下两格）返回 null —— 此时**不该**给任何预览（给了就是骗人）。
 */
type SplitDropZone = 'left' | 'right' | 'top' | 'bottom'

function resolveDropZone(input: {
  x: number
  y: number
  rect: { x?: number; y?: number; width: number; height: number }
  divider?: number
  gap?: number
  minSpan?: number
}): {
  zone: SplitDropZone
  layout: 'row' | 'column'
  place: 'start' | 'end'
  rect: { x: number; y: number; width: number; height: number }
} | null {
  const src = input
  const rect = src.rect
  if (!rect) return null
  const width = Math.round(Number(rect.width) || 0)
  const height = Math.round(Number(rect.height) || 0)
  if (width <= 0 || height <= 0) return null
  const minSpan = Number.isFinite(Number(src.minSpan)) ? Number(src.minSpan) : SPLIT_METRICS.minPane
  /**
   * 每根轴**各自**判定"这条轴能不能再切一刀"。
   *
   * 为什么必须分轴判（而不是"两个方向都放不下才不给落点"）：
   *   · 若某一轴切不动却仍然给出落点，预览块会是一个**宽度不足 minPane 的窄条**，
   *     而真正落位时 `applyMinSize` 会把它夹回 minPane —— 预览与实际**逐像素不一致**，
   *     正好踩中 D3（所见即所得）这条底线。
   *   · 分轴判之后，能给出的落点必然满足 `half >= minSpan`，求解器不会夹取，
   *     预览块与最终那一格就是同一个矩形（本文件的其余部分与 verify-split 都在守这条）。
   */
  const dividerSpan = Math.round(Number.isFinite(Number(src.divider)) ? Number(src.divider) : SPLIT_METRICS.divider)
  const canHorizontal = width >= minSpan * 2 + dividerSpan
  const canVertical = height >= minSpan * 2 + dividerSpan
  if (!canHorizontal && !canVertical) return null

  const x = Number(src.x)
  const y = Number(src.y)
  if (!Number.isFinite(x) || !Number.isFinite(y)) return null
  const x0 = Math.round(Number(rect.x) || 0)
  const y0 = Math.round(Number(rect.y) || 0)

  // **归一化距离**（除以宽/高）而不是绝对像素：宽窗口下"离左边 300px"与"离上边 300px"
  // 的视觉权重完全不同，只有占比才与窗口形状无关 —— 同一个相对位置在宽窄窗口下必须
  // 判出同一个方向，否则"拖到中间偏左"在两种窗口里会给出不同结果。
  const candidates: Array<[SplitDropZone, number]> = []
  if (canHorizontal) {
    candidates.push(['left', (x - x0) / width], ['right', (x0 + width - x) / width])
  }
  if (canVertical) {
    candidates.push(['top', (y - y0) / height], ['bottom', (y0 + height - y) / height])
  }
  let zone = candidates[0][0]
  let best = candidates[0][1]
  for (const [name, score] of candidates) {
    if (score < best) { best = score; zone = name }
  }

  const horizontal = zone === 'left' || zone === 'right'
  return {
    zone,
    // 左右 → 横向并列；上下 → 纵向堆叠（D4）
    layout: horizontal ? 'row' : 'column',
    // 左/上 → 新格在前
    place: zone === 'left' || zone === 'top' ? 'start' : 'end',
    rect: dropZonePaneRect({ rect, zone, divider: src.divider, gap: src.gap })
  }
}

/**
 * 落点意图 → 分屏成员顺序（**唯一换算点**，主进程提交时用）。
 *
 * 格的顺序 = 成员顺序（`solveSplitPanes` 的 `panes[i]` 对应 `members[i]`），
 * 所以"新格落在左/上"就是把被拖的标签放在前面。渲染侧的预览块矩形也取自同一个 place，
 * 于是"预览的那一块"与"提交后的那一格"必然是同一块（D3）。
 *
 * @param {{ place: 'start'|'end' }} intent
 * @param {string} dragId 被拖的标签
 * @param {string} pairId 配对的那一格
 * @returns {[string, string]}
 */
function splitMembersForDrop(intent: { place: 'start'|'end' }, dragId: string, pairId: string) : [string, string] {
  const drag = String(dragId)
  const pair = String(pairId)
  return intent && intent.place === 'start' ? [drag, pair] : [pair, drag]
}

/**
 * 轮换分屏形态：左右 → 上下 → （三格以上才有）网格 → 左右。
 *
 * 两格时**不把 grid 放进轮换里**：`gridShape(2)` = 1 列 2 行，与"上下"逐像素相同 ——
 * 让用户切到一个看不出区别的状态，是最容易让人以为"按钮坏了"的做法。
 *
 * 住在 shared-types（而不是某个宿主里）：主进程的工具条与 apps 的右键菜单都用它，
 * 两处各写一份"下一个形态是什么"必然漂移。
 *
 * @param {'row'|'column'|'grid'} layout
 * @param {number} memberCount 当前格数
 * @returns {'row'|'column'|'grid'}
 */
function nextSplitLayout(layout: 'row'|'column'|'grid', memberCount: number) : 'row'|'column'|'grid' {
  const order: Array<'row'|'column'|'grid'> = Number(memberCount) >= 3 ? ['row', 'column', 'grid'] : ['row', 'column']
  const current = normalizeSplitLayout(layout)
  const index = order.indexOf(current)
  return order[(index + 1 + order.length) % order.length] || 'row'
}

/**
 * 指针落在**第几格**（纯几何，零 IO）。没命中任何格返回 -1。
 *
 * 工具条"跟着指针所在的那一格走"靠它：格矩形只有布局层知道（原生视图位置），
 * 而"点在哪个矩形里"是与布局无关的纯计算 —— 分开之后这一段可 headless 验。
 *
 * @param {Array<{x:number,y:number,width:number,height:number}>} panes
 * @param {{x:number,y:number}} point 与 `panes` 同一坐标系（内容区坐标）
 * @returns {number}
 */
function splitPaneAtPoint(panes: Array<{ x:number,y:number,width:number,height:number }>, point: { x:number,y:number }) : number {
  const list = Array.isArray(panes) ? panes : []
  const x = Number(point && point.x)
  const y = Number(point && point.y)
  if (!Number.isFinite(x) || !Number.isFinite(y)) return -1
  for (let i = 0; i < list.length; i++) {
    const pane = list[i]
    if (!pane) continue
    if (x >= pane.x && x <= pane.x + pane.width && y >= pane.y && y <= pane.y + pane.height) return i
  }
  return -1
}

/**
 * 把某个成员移到指定下标（**格的顺序 = 成员顺序**，所以这就是"拖拽重排格子"）。
 *
 * 下标会夹到合法范围；位置没变（或成员不存在）返回 **null** —— 调用方据此不做无意义的重排，
 * 否则每次"拖回原地"都会产生一次 tab:changed 与整屏重排。
 *
 * @param {string[]} members
 * @param {string} tabId
 * @param {number} toIndex
 * @returns {string[]|null}
 */
function moveMemberToIndex(members: string[], tabId: string, toIndex: number) : string[]|null {
  const list = (Array.isArray(members) ? members : []).map(String)
  const id = String(tabId)
  const from = list.indexOf(id)
  if (from < 0) return null
  const rawTo = Number(toIndex)
  if (!Number.isFinite(rawTo)) return null
  const to = Math.max(0, Math.min(list.length - 1, Math.round(rawTo)))
  if (to === from) return null
  const next = list.slice()
  next.splice(from, 1)
  next.splice(to, 0, id)
  return next
}

export {
  SPLIT_LAYOUTS,
  DEFAULT_SPLIT_LAYOUT,
  SPLIT_METRICS,
  SPLIT_SETTING_KEYS,
  SPLIT_MAX_PANES_OPTIONS,
  DEFAULT_SPLIT_MAX_PANES,
  SPLIT_LAYOUT_OPTIONS,
  SPLIT_LINK_ROUTING_OFF,
  SPLIT_LINK_ROUTING_ADJACENT,
  SPLIT_LINK_ROUTING_OPTIONS,
  DEFAULT_SPLIT_LINK_ROUTING,
  normalizeSplitLinkRouting,
  normalizeSplitLayout,
  normalizeSplitCount,
  normalizeSplitRatios,
  distribute,
  applyMinSize,
  gridShape,
  solveSplitPanes,
  ratiosFromDrag,
  paneIndexAtPoint,
  SPLIT_RATIO_PRESET_OPTIONS,
  ratiosForPreset,
  neighborPaneIndex,
  splitAxisOf,
  DROP_ZONES,
  dropZonePaneRect,
  resolveDropZone,
  splitMembersForDrop,
  // 分屏工具条（hover 浮出的那排按钮）用的三条纯规则
  nextSplitLayout,
  splitPaneAtPoint,
  moveMemberToIndex
}
