/**
 * 「贴顶浮层」的落位真源 —— `position: 'below-topbar'` 系列浮层（权限 / 地址栏下拉 / 下载等）
 * 的几何只有这一份。
 *
 * 为什么必须独立成纯函数：
 *   · 浮层是**独立 WebContentsView**（bounds 由主进程 `setBounds` 落地），而卡片尺寸由
 *     渲染层测量后回传 —— 谁都不拥有完整事实；把算术留在 LayoutCoordinator 里，任何一侧
 *     想复用（例如渲染层预判位置、测试夹具）都得再抄一遍，抄完就开始漂移。
 *   · 以前的实现只把 x / y 夹到 ≥ 0：卡片比窗口宽、或顶栏 + 卡片高超过窗口时，浮层会
 *     被 `setBounds` 从右侧/底部裁掉（表现为"卡片右边缺一块""按钮点不到"）。
 *     这里统一按**内容区**夹取：宽度不超过窗口，高度不超过「顶栏（或底栏）之外」的可用区，
 *     再把 x / y 收回边界内 —— 落下的矩形永远完整可见。
 *
 * 事实从哪来（调用方负责凑齐，本文件不认识 Electron / DOM）：
 *   · window       窗口 content 尺寸
 *   · card         浮层 renderer 实测尺寸（CSS 改了就自动跟着变，不写死常量）
 *   · topbarHeight 页面布局参数里的顶栏占高（导航栏在顶部时它就是"内容区上边界"）
 *   · bottombarHeight 底部工具栏占高（导航栏在底部时它是"内容区下边界"）
 *   · navSide      导航栏所在侧（决定浮层挂在下方还是上方）
 *   · chromeHidden 外壳是否收起（收起态顶/底栏都不占高，否则会凭空偏一整条）
 *   · insetRight   内容区右侧内缩（如侧栏占宽）
 *   · margin       浮层与顶栏 / 右缘 / 底栏的间距
 */

/** 顶栏最小占高：外壳可见时即使布局参数还没上报，也不让浮层压进导航栏。 */
const TOPBAR_MIN_HEIGHT = 40

interface Size {
  width?: number
  height?: number
}

interface FloatAnchorInput {
  window?: Size
  card?: Size
  topbarHeight?: number
  bottombarHeight?: number
  navSide?: 'top' | 'bottom'
  chromeHidden?: boolean
  insetRight?: number
  margin?: number
}

export interface FloatRect {
  x: number
  y: number
  width: number
  height: number
}

/** @param {any} v */
function num(v: unknown): number {
  const n = Number(v)
  return Number.isFinite(n) ? n : 0
}

/**
 * 解析「贴顶浮层」的矩形（窗口 content 坐标）。
 *
 * @param {{
 *   window?: { width?: number, height?: number },
 *   card?: { width?: number, height?: number },
 *   topbarHeight?: number,
 *   bottombarHeight?: number,
 *   navSide?: 'top'|'bottom',
 *   chromeHidden?: boolean,
 *   insetRight?: number,
 *   margin?: number
 * }} input
 * @returns {{ x: number, y: number, width: number, height: number } | null}
 *   窗口尺寸尚未就绪（0）时返回 null —— 调用方跳过落位，别把浮层塞到 (0,0)。
 */
function anchorFloatBelowTopbar(input: FloatAnchorInput | null | undefined): FloatRect | null {
  const src = input || {}
  const win = src.window || {}
  const cw = Math.max(0, Math.floor(num(win.width)))
  const ch = Math.max(0, Math.floor(num(win.height)))
  if (!cw || !ch) return null

  // 外壳收起（沉浸 / 全屏唤起前）时顶底栏都不占高 —— 否则下拉会凭空偏一整条顶栏。
  const chromeGone = src.chromeHidden === true
  const topbarHeight = chromeGone
    ? 0
    : Math.min(Math.max(TOPBAR_MIN_HEIGHT, Math.round(num(src.topbarHeight))), ch)
  const bottombarHeight = chromeGone
    ? 0
    : Math.min(Math.max(0, Math.round(num(src.bottombarHeight))), Math.max(0, ch - topbarHeight))
  const insetRight = Math.max(0, Math.round(num(src.insetRight)))
  const margin = Math.max(0, Math.floor(num(src.margin)))

  // 尺寸：不超过内容区；卡片自己报 0 时保持 0（由调用方决定要不要显示）。
  const width = Math.min(Math.max(0, Math.floor(num(src.card && src.card.width))), cw)
  const anchorAtBottom = !chromeGone && src.navSide === 'bottom'
  // 竖直方向可用区 = 导航栏「另一侧」到窗口边缘的那一段。
  const availHeight = Math.max(0, ch - (anchorAtBottom ? bottombarHeight : topbarHeight))
  const height = Math.min(Math.max(0, Math.floor(num(src.card && src.card.height))), availHeight)

  // x 贴右缘（再让开内缩与 margin），并夹回 [0, cw - width]。
  const desiredX = Math.round(cw - width - insetRight - margin)
  const x = Math.min(Math.max(0, desiredX), Math.max(0, cw - width))

  // 导航栏在底部 → 浮层挂在**上方**；判据是 navSide 而不是「底栏占高 > 0」
  // （底栏可能只摆了书签栏，此时导航栏仍在顶部，下拉就该向下弹）。
  const desiredY = anchorAtBottom
    ? Math.round(ch - bottombarHeight - height - margin)
    : Math.round(topbarHeight + margin)
  const y = Math.min(Math.max(0, desiredY), Math.max(0, ch - height))

  return { x, y, width, height }
}

export { TOPBAR_MIN_HEIGHT, anchorFloatBelowTopbar }
