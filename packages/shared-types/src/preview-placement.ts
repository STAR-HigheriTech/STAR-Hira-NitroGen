/**
 * 悬浮预览卡的**落位真源** —— 三种摆放、一套算术、两个进程共用。
 *
 * 为什么必须两个进程共用同一份：预览是**独立 WebContentsView**（矩形由主进程 `setBounds`
 * 落地），而卡片是渲染层按自己的测量画出来的。两边各算一次坐标，只要有一处不一致，就会出现
 * 「卡片与 view 错位」「view 压住锚点把 hover 打回去 → 无限闪烁」这类只能靠肉眼发现的病 ——
 * 上一轮那一串闪烁就是这么来的（一半在 renderer 的 `layout()`，一半在主进程的锚定函数里）。
 * 于是这里只留一份纯函数：吃事实（锚点 / 窗口 / 面板 bounds / 卡片实测尺寸），吐矩形与内缩。
 * 不碰 DOM、不碰 IPC、不认识标签 —— 谁有事实谁喂进来（主进程有面板 bounds，渲染层有卡片尺寸）。
 *
 * ── 三条**不变式**（每一处坐标都必须满足；违反即上面那类病）──────────────────
 *   1. **view 绝不压到锚点**：锚点 = 触发预览的那一行标签 / 那一条标签。view 会吃掉鼠标事件
 *      （WebContentsView 没有 mouse-ignore 能力），压上去 = hover 反复进出 = 无限闪烁。
 *   2. **view 整个落在窗口内**：主进程的 `setBounds` 还会把 x 夹到 ≥0，所以这里必须先夹住 ——
 *      否则"放不下"会被夹回左侧，正好盖住锚点（不变式 1 立刻被破坏）。
 *   3. **放不下就收窄 view**：卡片贴锚点那条边**不动**，被裁的是外侧（阴影 / 卡片远端）；
 *      绝不靠压到锚点或越出窗口来"塞下"。
 *
 * 与 `layout.mjs` 同一口径：这是跨进程的**形状真源**，不是某一侧的样式表 —— 各家的留白数值
 * （多少像素）也一并住在这里，免得渲染层与主进程各抄一份。
 */

/** 摆放方式（与浮层 payload 的 `placement` / `position` 取值一一对应）。 */
const PREVIEW_PLACEMENT = Object.freeze({
  /** 横向标签条：卡片挂在**标签下方**。 */
  BELOW: 'below',
  /** 面板（打开标签 / 固定标签）：卡片挂在**面板外侧**。 */
  BESIDE_PANEL: 'beside-panel',
  /** 纵向标签列：卡片挂在**行的外侧**（行又宽又扁，挂下方会压住别的行）。 */
  BESIDE_ROW: 'beside-row'
})

/**
 * 各摆放的留白口径。
 *
 * ⚠ 这些数值**只在这一处**：渲染层不再写"卡片在 view 里往左偏 12px"这种字面量，
 * 主进程也不再写另一套 —— 两边读同一个常量，错位这类病从根上不可能发生。
 */
const PREVIEW_PADDING = Object.freeze({
  /**
   * 标签下方（横向标签条）。
   *
   * `top` 与 `gap` 是**两件事**，刻意分开：
   *   · `top`  —— view 顶边相对**基准边**上探多少（基准边 = "标签底边"与
   *     "标签条容器底边"里更靠下的那条，见 below()）。
   *   · `gap`  —— 卡片顶边相对**基准边**下移多少（真正的视觉间隔）。
   * 于是 卡片顶边 = (基准边 − top) + top + gap = 基准边 + gap，只由 gap 决定。
   * view 高度必须把 gap 一并算进去（见 below()），否则卡片底部会被裁掉。
   *
   * ⚠ **`top` 必须是 0**：view 是原生 WebContentsView，**会吃掉自己矩形内的鼠标事件**
   * （没有"忽略鼠标"能力）。上探一像素就等于把浮层压在标签条上，指针一进那条带，
   * 外壳立刻收到标签的 mouseout（预览收起）→ 指针又落回标签 → 再 mouseover →
   * 表现为「预览和标签栏重叠、一直在反复重跳」，且**停顿在标签下缘时永远不停**。
   * 所以这里只允许 **view 顶边 == 基准边**（`below()` 里还有一次 `Math.ceil` 兜底，
   * 保证小数点后也不越界）。
   *
   * 阴影的上探空间改由 `gap` 提供（卡片上方留 16px 空白，比原来上探 6px 还宽裕）——
   * 视觉间隔与"别盖住标签栏"这两件事因此不再互相牵制。
   *
   * `gap` 由 8 提到 16：这是**唯一**的"离标签栏多远"旋钮，调它一个数即可，
   * 不用去动卡片内缩或 view 高度（两者都从它推出来）。
   */
  below: Object.freeze({ x: 28, top: 0, gap: 16, bottom: 22 }),
  /** 面板外侧：view 绝不能压到面板上（否则面板行的 hover 反复进出），故卡片与面板的距离 = x。 */
  besidePanel: Object.freeze({ x: 12, y: 20 }),
  /** 行外侧：朝内那条边零留白（卡片贴行），朝外留阴影；上下留白对称。 */
  besideRow: Object.freeze({ gap: 8, shadow: 18, y: 16 })
})

/** @param {any} v */
function num(v: unknown) {
  const n = Number(v)
  return Number.isFinite(n) ? n : 0
}

/** 读一个数，非法则回落到缺省（避免到处写第二套判空写法）。 */
function numOr(v: unknown, fallback: number): number {
  const n = Number(v)
  return Number.isFinite(n) ? n : fallback
}

/**
 * 卡片在 view 内的内缩（`left`/`right` 之一恒为 null = 让 CSS 走 `auto`）。
 * 规则统一为：**贴锚点的那一条边归零**，于是"放不下被收窄"时裁掉的永远是外侧。
 * @param {'below'|'beside-panel'|'beside-row'} placement
 * @param {boolean} toRight 卡片在锚点的右侧
 * @returns {{ left: number|null, right: number|null, top: number }}
 */
function cardInsetOf(placement: 'below'|'beside-panel'|'beside-row', toRight: boolean) : { left: number|null, right: number|null, top: number } {
  if (placement === PREVIEW_PLACEMENT.BESIDE_ROW) {
    return { left: toRight ? 0 : null, right: toRight ? null : 0, top: PREVIEW_PADDING.besideRow.y }
  }
  if (placement === PREVIEW_PLACEMENT.BESIDE_PANEL) {
    return { left: toRight ? PREVIEW_PADDING.besidePanel.x : null, right: toRight ? null : PREVIEW_PADDING.besidePanel.x, top: PREVIEW_PADDING.besidePanel.y }
  }
  // 卡片内缩：把 view 上探的那部分补回来，再叠加真正的视觉间隔（gap）。
  return { left: PREVIEW_PADDING.below.x, right: null, top: PREVIEW_PADDING.below.top + PREVIEW_PADDING.below.gap }
}

/**
 * 解析预览浮层的落位。
 *
 * @param {{
 *   placement?: 'below'|'beside-panel'|'beside-row',
 *   card: { width: number, height: number },
 *   maxCard?: { width?: number, height?: number },
 *   anchor?: { left: number, top: number, width: number, height: number } | null,
 *   previewSide?: 'left'|'right',
 *   panelSide?: 'left'|'right',
 *   stripRight?: number,
 *   stripBottom?: number,
 *   panel?: { x: number, y: number, width: number, height: number } | null,
 *   railWidth?: number,
 *   margin?: number,
 *   window?: { width?: number, height?: number, topbarHeight?: number }
 * }} input
 * @returns {{
 *   placement: string,
 *   x: number, y: number, width: number, height: number,
 *   card: { left: number|null, right: number|null, top: number }
 * }}
 */
interface PreviewInput {
  placement?: 'below' | 'beside-panel' | 'beside-row'
  card: { width: number; height: number }
  maxCard?: { width?: number; height?: number }
  anchor?: { left: number; top: number; width: number; height: number } | null
  previewSide?: 'left' | 'right'
  panelSide?: 'left' | 'right'
  stripRight?: number
  stripBottom?: number
  panel?: { x: number; y: number; width: number; height: number } | null
  railWidth?: number
  margin?: number
  window?: { width?: number; height?: number; topbarHeight?: number }
}

interface PreviewCardSize {
  width: number
  height: number
}

interface PreviewAnchorRect {
  left: number
  top: number
  width: number
  height: number
}

function resolvePreviewPlacement(input: PreviewInput) {
  const src = input
  const placement = src.placement === PREVIEW_PLACEMENT.BESIDE_ROW
    ? PREVIEW_PLACEMENT.BESIDE_ROW
    : (src.placement === PREVIEW_PLACEMENT.BESIDE_PANEL ? PREVIEW_PLACEMENT.BESIDE_PANEL : PREVIEW_PLACEMENT.BELOW)
  const card = { width: Math.max(0, Math.ceil(num(src.card && src.card.width))), height: Math.max(0, Math.ceil(num(src.card && src.card.height))) }
  const anchor = src.anchor || null
  // 卡片贴锚点哪一边：'left' = 卡片在锚点左侧。
  const toRight = src.previewSide !== 'left'

  if (placement === PREVIEW_PLACEMENT.BESIDE_ROW) return besideRow(src, card, anchor, toRight)
  if (placement === PREVIEW_PLACEMENT.BESIDE_PANEL) return besidePanel(src, card, anchor, src.panelSide !== 'left')
  return below(src, card, anchor)
}

/** 横向标签条：卡片挂标签下方（view 顶边不高于列表容器底边；卡片再往下让出 gap）。 */
function below(src: PreviewInput, card: PreviewCardSize, anchor: PreviewAnchorRect | null) {
  const pad = PREVIEW_PADDING.below
  const a = anchor || { left: 0, top: 0, width: 0, height: 0 }
  /**
   * 顶边的基准是**触发它的列表容器的底边**，而不只是标签自身的底边。
   *
   * 为什么：标签条（`#tabs`）刻意做得比标签高（`align-self: stretch`，给标签组下划线
   * 留出一条凹槽），而**那条槽仍然属于标签条**，也仍然是 hover 的判定容器。浮层若盖住
   * 它，指针一进槽就落到浮层上、外壳收不到事件，标签的 `mouseout` 拿不到 `relatedTarget`
   * → 被"离开标签条"的判据接住 → 收起 → 指针又回到标签条 → 再显示 → 再收起 ——
   * 表现正是「靠标签条下缘 hover 一直跳」。让到容器下缘，这一整类问题就不再可能发生。
   *
   * 容器底边拿不到（旧调用方 / 纵向列表）时省略该字段，退回标签自身底边。
   */
  const stripBottom = num(src.stripBottom)
  const topEdge = Math.max(num(a.top) + num(a.height), stripBottom)
  return {
    placement: PREVIEW_PLACEMENT.BELOW,
    x: Math.round(num(a.left) - pad.x),
    // 向上取整是**功能性**的：view 顶边绝不能压到上面那条边（哪怕 0.5px）—— 见不变式 1。
    y: Math.ceil(topEdge - pad.top),
    width: Math.ceil(card.width + pad.x * 2),
    // gap 必须算进高度：卡片是在 view 内部再往下让 gap 的，
    // 少算这一截，卡片底部就会被 view 裁掉（缩略图会缺一条）。
    height: Math.ceil(card.height + pad.top + pad.gap + pad.bottom),
    card: cardInsetOf(PREVIEW_PLACEMENT.BELOW, true)
  }
}

/** 面板外侧：x 由**面板 bounds** 定（只有主进程拿得到），y 锚在 hover 行的窗口 top。 */
function besidePanel(src: PreviewInput, card: PreviewCardSize, anchor: PreviewAnchorRect | null, onRight: boolean) {
  const pad = PREVIEW_PADDING.besidePanel
  const win = src.window || {}
  const cw = Math.max(0, num(win.width))
  const ch = Math.max(0, num(win.height))
  const topbarHeight = Math.max(0, num(win.topbarHeight))
  const margin = Number.isFinite(src.margin) ? Math.max(0, num(src.margin)) : 0
  const width = Math.ceil(card.width + pad.x * 2)
  const height = Math.ceil(card.height + pad.y * 2)
  // 面板未完成布局（bounds 还是 0）→ 退化为「贴 rail 那侧」，位置略糙好过落到窗口左上角。
  const pb = src.panel && num(src.panel.width) > 0 ? src.panel : null
  const railWidth = numOr(src.railWidth, 0)
  const x = pb
    ? (onRight ? num(pb.x) - width - margin : num(pb.x) + num(pb.width) + margin)
    : (onRight ? cw - railWidth - width - margin : railWidth + margin)
  // 纵向锚在 hover 行的窗口 top（不跟随鼠标，行内微调不会让预览上下漂移）。
  const desiredY = Math.round(num(anchor && anchor.top) - pad.y)
  const edgeGap = 8
  const maxY = Math.max(topbarHeight, ch - height - edgeGap)
  return {
    placement: PREVIEW_PLACEMENT.BESIDE_PANEL,
    x: Math.max(0, Math.round(x)),
    y: Math.min(Math.max(desiredY, topbarHeight), maxY),
    width,
    height,
    card: cardInsetOf(PREVIEW_PLACEMENT.BESIDE_PANEL, !onRight)
  }
}

/**
 * 行外侧（纵向标签列）：卡片挂在整行之外。
 *
 * 三条不变式在这一摆放上都得当场满足：
 *   · 朝内那条边 = 行的外侧**再让开列表的滚动条**（行矩形量不到滚动条那几像素，
 *     故由发起方随 payload 给 `stripRight`）—— 否则 view 会盖住滚动条右半截，
 *     而它每次换标签都要移动，被盖住的滚动条就跟着重绘一下（"预览一换、滚动条闪一下"）；
 *   · 尺寸**会话内恒定**（取卡片上限 + 留白）：卡片内容每换一个标签都会变（有无缩略图、
 *     标题长短），跟着实测尺寸改 view 就是每换一次标签 native resize 一次 ——
 *     view 压在其他图层之上，这一下会把下层（网页 / rail）一起重绘成可见的闪动；
 *   · 放不下（窗口不够宽）就**收窄**，绝不越过行 —— 主进程还会把 x 夹到 ≥0，
 *     这里不先夹住的话，"行左边放不下"会被夹回 x=0，正好把 view 拖到标签列上。
 */
function besideRow(src: PreviewInput, card: PreviewCardSize, anchor: PreviewAnchorRect | null, toRight: boolean) {
  const pad = PREVIEW_PADDING.besideRow
  const a = anchor || { left: 0, top: 0, width: 0, height: 0 }
  const maxCard = src.maxCard || {}
  const maxW = Number.isFinite(maxCard.width) ? Math.ceil(num(maxCard.width)) : card.width
  const maxH = Number.isFinite(maxCard.height) ? Math.ceil(num(maxCard.height)) : card.height
  const natW = Math.ceil(maxW + pad.shadow)
  const viewH = Math.ceil(maxH + pad.y * 2)
  const winW = num(src.window && src.window.width)
  // 朝内那条边：整条列表的外缘（含滚动条）优先，拿不到才退回行自身的外缘。
  const innerEdge = toRight
    ? (num(src.stripRight) > 0 ? num(src.stripRight) : num(a.left) + num(a.width))
    : num(a.left)
  const room = winW > 0
    ? (toRight ? winW - innerEdge - pad.gap : innerEdge - pad.gap)
    : natW
  const width = Math.max(1, Math.min(natW, Math.round(room)))
  const x = toRight ? innerEdge + pad.gap : Math.max(0, innerEdge - pad.gap - width)
  return {
    placement: PREVIEW_PLACEMENT.BESIDE_ROW,
    x: Math.max(0, Math.round(x)),
    y: Math.max(0, Math.round(num(a.top) - pad.y)),
    width,
    height: viewH,
    card: cardInsetOf(PREVIEW_PLACEMENT.BESIDE_ROW, toRight)
  }
}

export { PREVIEW_PLACEMENT, PREVIEW_PADDING, resolvePreviewPlacement }
