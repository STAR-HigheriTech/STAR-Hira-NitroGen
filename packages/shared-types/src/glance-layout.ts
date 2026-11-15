/**
 * glance-layout.mjs —— Glance 速览几何的**唯一真源**（跨进程纯函数 + 常量）
 *
 * ── 为什么必须是一份（而不是主进程、渲染层各写一遍）──────────────
 * 与 `split-layout.mjs` 同源：主进程要按结果给两张卡片的 `WebContentsView` 落 bounds，
 * 渲染层要按**同一份结果**画卡片边框 / 算"点卡片外收起"的热区。两处各写一份算术，
 * 迟早漂移 —— 漂移的表现是"边框与网页差几个像素"，而且两边都觉得自己对。
 *
 * ── 模型（两态叠放）─────────────────────────────────────────────
 *   Glance = **恰好两张卡片**：`front`（前面 / 略小，85% 宽 × 93% 高）
 *   压在 `back`（后面 / 略大，95% 宽 × 97.5% 高）之上，都相对内容区居中。
 *   于是看起来就是"一叠卡片"：后面的原页在四周露出边缘，前面的速览页浮在上面。
 *
 *   ⚠ **front 必须完全内嵌于 back**（宽、高都比 back 小）—— 这不是审美取舍，
 *     而是「聚焦框画得完整」的**几何前提**：蓝框是注入 **back 那一页**、贴着 front
 *     的轮廓画的一圈光带（见 `infra/infra-window/src/glance-deck-chrome.js`）。
 *     front 只要有一条边伸出 back 视口，那一侧的框就会被 back 的视口裁掉 ——
 *     正是"蓝框四角/上下边缺一块"的老病根。于是 `frontHeightPct` 由 RT 的 1 收到 0.93。
 *
 *   其余口径仍对齐 HiraRT `tab-layout.ts#calculateGlanceBounds`
 *   （front 0.85 / 0.93，back 0.95 / 0.975；`floor` 取整 + 居中偏移）。
 *
 * 纯函数：零依赖、零 IO、不碰 DOM、不 require electron。主进程（CJS require）与
 * 渲染层（ESM import）读**同一份文件**（本文件是 `.mjs`，Electron 43 运行时为 Node 24，
 * `require()` 可直接加载 ESM —— 与 `layout.mjs` / `split-layout.mjs` 同款约定）。
 */

/**
 * 尺寸口径（主进程与渲染层必须读同一份）。
 * 两态叠放：front 略小、back 略大，都居中。
 */
const GLANCE_METRICS = Object.freeze({
  /** front（前面的速览页）宽度占内容区比例。 */
  frontWidthPct: 0.85,
  /** front 高度占内容区比例（**必须 < backHeightPct**，见文件头）。 */
  frontHeightPct: 0.93,
  /** back（后面的原页）宽度占内容区比例。 */
  backWidthPct: 0.95,
  /** back 高度占内容区比例。 */
  backHeightPct: 0.975,
  /** 成员恒为 2 —— 这是 Glance 的**定义**，不是上限。 */
  members: 2
})

/** 卡片角色（两张：front 在上、back 在下）。 */
const GLANCE_ROLES = Object.freeze(['back', 'front'])

export interface GlanceRect {
  x: number
  y: number
  width: number
  height: number
}

/**
 * 单张卡片的矩形（内容区坐标）。
 *
 * `floor` 取整 + 居中偏移：与 RT 逐字一致 —— 取整后再算偏移，保证两张卡片**都精确居中**
 * 且不产生半像素（半像素会让原生视图合成时糊边）。
 *
 * @param {{x?:number,y?:number,width?:number,height?:number}} pageBounds 内容区
 * @param {boolean} isFront 是不是前面的那张（否则为 back）
 * @returns {GlanceRect}
 */
function glanceBounds(pageBounds: { x?:number,y?:number,width?:number,height?:number }, isFront: boolean) : GlanceRect {
  const rect = pageBounds || {}
  const rx = Number(rect.x) || 0
  const ry = Number(rect.y) || 0
  const rw = Number(rect.width) || 0
  const rh = Number(rect.height) || 0
  const widthPct = isFront ? GLANCE_METRICS.frontWidthPct : GLANCE_METRICS.backWidthPct
  const heightPct = isFront ? GLANCE_METRICS.frontHeightPct : GLANCE_METRICS.backHeightPct
  const width = Math.floor(rw * widthPct)
  const height = Math.floor(rh * heightPct)
  const xOffset = Math.floor((rw - width) / 2)
  const yOffset = Math.floor((rh - height) / 2)
  return { x: rx + xOffset, y: ry + yOffset, width, height }
}

/**
 * 一次性算出两张卡片的矩形，按 `GLANCE_ROLES` 顺序（back 先、front 后 —— 与 z 序一致）。
 *
 * @param {{x?:number,y?:number,width?:number,height?:number}} pageBounds
 * @returns {{back: GlanceRect, front: GlanceRect}} 缺内容区时返回全 0 矩形（由调用方决定是否使用）
 */
function solveGlanceCards(pageBounds: { x?:number,y?:number,width?:number,height?:number }) : {back: GlanceRect, front: GlanceRect} {
  return {
    back: glanceBounds(pageBounds, false),
    front: glanceBounds(pageBounds, true)
  }
}

/**
 * **front 卡矩形在 back 卡视口里的相对内缩**（0~0.5 的纯比例，横向 / 纵向各一份）。
 *
 * 为什么放在这里：装饰层（注入 back 页面画阴影 + 蓝框，见 glance-deck-chrome.js）
 * 必须知道"front 的轮廓落在 back 视口的百分之几"，而这个位置**完全是两张卡比例的
 * 纯函数**。放在这里 = 叠放口径一改，装饰自动跟着改，不会留下"对不上"的硬编码。
 *
 * 推导（`W`/`H` = 内容区宽高，两张卡都以内容区居中）：
 *   · 横向：back 左边界在 `(1 - backW)/2`，front 左边界在 `(1 - frontW)/2`
 *     ⇒ 相对 back 视口 = `(backW - frontW) / 2 / backW`；
 *   · 纵向同理 = `(backH - frontH) / 2 / backH`（本文件保证 front < back ⇒ 恒为正）。
 *
 * @returns {{ sideRatio: number, edgeRatio: number }}
 */
function glanceFrontInset() : { sideRatio: number, edgeRatio: number } {
  return {
    sideRatio: ((GLANCE_METRICS.backWidthPct - GLANCE_METRICS.frontWidthPct) / 2) / GLANCE_METRICS.backWidthPct,
    edgeRatio: ((GLANCE_METRICS.backHeightPct - GLANCE_METRICS.frontHeightPct) / 2) / GLANCE_METRICS.backHeightPct
  }
}

export {
  GLANCE_METRICS,
  GLANCE_ROLES,
  glanceBounds,
  solveGlanceCards,
  glanceFrontInset
}
