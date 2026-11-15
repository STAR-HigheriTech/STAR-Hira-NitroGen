// @ts-check
/**
 * @hira-ng/ui-chrome-layout —— 浏览器外壳（chrome）的**布局槽容器**
 *
 * 职责：把「哪些块、按什么顺序、摆在哪一侧」这件事，翻译成 DOM 结构。
 * 它**不认识** tabbar / navbar / titlebar / bookmarkbar 的任何语义 —— 只认两件事：
 *   1. 一个块 id ↔ 一个元素（setBlock）；
 *   2. 一份摆放计划（setPlan）：两侧各自若干「行」，每行可横排若干块。
 *
 * 为什么要单独一个包：书签栏必须与导航栏**零代码关系**。以前书签栏被 append 进
 * `#navbar`（成为它的第 N 个子节点），于是「书签栏的高度算不算进顶栏」这种问题
 * 只能靠两处互相猜。现在四块都是不相识的哑块，由本容器按计划摆放 —— 换一种布局
 * 只是换一次摆放，不触碰任何一块的内部。
 *
 * 关键边界：
 *   · 本容器不含任何 IPC、状态或业务判断；
 *   · 摆放计划由编排层从 shared-types 的 planChromeLayout 产出后灌进来；
 *   · 块元素由编排层注入（setBlock），本容器只负责把它们搬来搬去 —— 搬移而非复制，
 *     块内部状态（地址栏内容、搜索下拉锚点、标签条）因此不会因换布局而丢失。
 */

/**
 * 注入外壳布局样式（幂等）。
 * @param {Document} doc
 */
// 「某一行的块能不能横跨侧栏」是**块自己的声明**（shared-types 那张表），本容器只照它分派 ——
// 于是"侧栏在 navbar 下方、但不在书签栏下方"是两条独立规则的结果，不是容器里的特判。
import { rowCrossesSide } from '@hira-ng/shared-types/src/layout.mjs'

export type ChromeAxis = 'row' | 'column'
export type ChromeRegionSide = 'left' | 'right'
export type ChromeLayoutMode = 'default' | 'compact'
export type ChromeSideVisibility = 'attached' | 'floating' | 'hidden'

export interface ChromeSidePlanInput {
  rows?: string[][]
  position?: ChromeRegionSide
  visibility?: ChromeSideVisibility
  autoHide?: boolean
  width?: number
  collapsed?: boolean
  restWidth?: number
  revealOverlay?: boolean
  revealWidth?: number
}

export interface ChromeSidePlan {
  rows: string[][]
  position: ChromeRegionSide
  visibility: ChromeSideVisibility
  autoHide: boolean
  width: number
  collapsed: boolean
  restWidth: number
  revealOverlay: boolean
  revealWidth: number
}

export interface ChromeLayoutPlanInput {
  mode?: ChromeLayoutMode
  merged?: boolean
  top?: string[][]
  bottom?: string[][]
  side?: ChromeSidePlanInput | null
}

export interface ChromeLayoutPlan {
  mode: ChromeLayoutMode
  merged: boolean
  top: string[][]
  bottom: string[][]
  side: ChromeSidePlan | null
}

export interface ChromeLayoutSlots {
  readonly top: HTMLElement
  readonly topMain: HTMLElement
  readonly bottom: HTMLElement
  readonly bottomMain: HTMLElement
  readonly content: HTMLElement
  readonly side: HTMLElement
}

export interface ChromeRect {
  x: number
  y: number
  width: number
  height: number
}

export interface ChromeBlockZoneItem extends ChromeRect {
  id: string
}

export interface ChromeBlockZone {
  key: string
  label: string
  axis: ChromeAxis
  grow: 'right' | 'down'
  rect: ChromeRect
  items: ChromeBlockZoneItem[]
}

export interface ChromeLayoutController {
  readonly element: HTMLElement
  readonly slots: ChromeLayoutSlots
  setBlock(id: string, element: HTMLElement | null): void
  setPlan(plan?: ChromeLayoutPlanInput): void
  getPlan(): ChromeLayoutPlan
  getBlockZones(): ChromeBlockZone[]
  setSideReveal(revealed: boolean): void
  setContent(element: HTMLElement | null): void
  dispose(): void
}

export function injectChromeLayoutStyles(doc: Document): void {
  if (doc.getElementById('hira-chrome-layout-styles')) return
  const style = doc.createElement('style')
  style.id = 'hira-chrome-layout-styles'
  style.textContent = `
    /* 外壳根：铺满窗口，**竖排三段** —— [跨栏顶带 | 身体区 | 跨栏底带]；
       身体区横分 [侧栏区 | 主列]，主列再竖分「让位顶部段 / 内容洞 / 让位底部段」。

       ── 口径（用户 2026-10 逐字）────────────────────────────────────────────
       "侧栏应该在 navbar 下方，但是不应该在书签栏下方" ⇒ 这两件事必须**解耦**：
       · **可横跨侧栏的块**（navbar / titlebar / tabbar，见 shared-types#CHROME_ROW_CROSSES_SIDE）
         住根级那两条带 → 铺满整窗、压在侧栏上下方，侧栏从它下面起算；
       · **给侧栏让位的块**（bookmarkbar）住主列里的那两段 → 只在侧栏右边那一段，
         与网页同宽（"让位"）。
       分派只按那张声明表（rowCrossesSide），容器不认识任何具体块 —— 加一块 /
       改一类跨栏行为都只动表，不动容器。

       ⚠ 本段是 CSS 模板字符串的一部分：注释里**不能出现反引号**（会提前闭合字符串）。
         这条已经踩过三次（见 ui-tabbar/src/styles.js 的同款警告）。

       没有块住侧栏时 #chrome-side 整个不渲染（:empty → display:none），
       主列独占身体区整宽、跨栏两带仍横跨整窗 —— 与「只有上下三段」的历史结构一致。
       主进程的摆放口径不受影响：它吃的是 topbar/bottombar 两条**高度**与侧栏的**宽度**
       （两带 + 让位段的高度在渲染侧相加后上报，见 window-layout-controller）。 */
    #chrome-root {
      display: flex;
      flex-direction: column;
      height: 100%;
      width: 100%;
      overflow: hidden;
      /* 定位参照：分屏的分隔条层（#split-layer）是它的绝对定位子元素。
         分隔条只占"两格之间那条缝"—— 缝里没有网页 view，所以 chrome 背景天然显形、
         指针事件天然归 chrome，不需要另建浮层视图。 */
      position: relative;
      background: var(--main-bg-color);
      color: var(--text-color);
    }

    /* 身体区（横排）：侧栏区 + 主列并排。占「窗口高减跨栏两带」那一段。 */
    #chrome-body {
      display: flex;
      flex-direction: row;
      flex: 1 1 auto;
      min-width: 0;
      min-height: 0;
      position: relative;
      background: var(--main-bg-color);
      color: var(--text-color);
      overflow: hidden;
    }

    /* 主列：竖排三段 —— 让位顶部段 / 内容洞 / 让位底部段。宽度 = 身体区减去侧栏区。
       网页是叠在本层之上的原生 WebContentsView，所以「内容洞」只需留出正确的
       高度，真正的裁切由主进程按上报的 topbar/bottombar 高度做。 */
    #chrome-main {
      display: flex;
      flex-direction: column;
      flex: 1 1 auto;
      min-width: 0;
      min-height: 0;
      order: 1;
    }

    /* 让位段：**给侧栏让位**的那些行（书签栏）住这里 —— 只在侧栏右边那一段，
       与网页同宽。与根级那两条跨栏带是同一种容器的两个落点，判据只有 rowCrossesSide。 */
    #chrome-main-top,
    #chrome-main-bottom {
      display: flex;
      flex-direction: column;
      flex-shrink: 0;
      width: 100%;
    }

    /* 侧栏区（纵排）：宽度由编排层按计划写进 --ng-side-width。
       它是**区域容器**，不是任何具体块 —— 里面装什么由计划决定。
       折叠/隐藏都由编排层改宽度或 data-hidden 实现，本容器不做策略判断。

       贴左还是贴右用 flex order 表达（侧栏 0 / 主列 1 / 右侧栏 2）：
       元素**始终留在 DOM 里**（隐藏只切 data-hidden）—— 上报侧栏占宽的那条
       ResizeObserver 挂在它身上，元素一旦被摘掉就收不到 0 宽度的通知，
       网页会一直留着上一份内缩。

       高度 = **身体区整高**（跨栏两带之下）：它与主列并排在 #chrome-body 里 ——
       "侧栏从 navbar 下面起算、一直撑到底"就是这么来的（见 #chrome-root 的口径）。
       Edge 型那条覆盖浮层（主进程 sidebar-float）用同一份几何：y 取顶栏高、
       高取"身体区高减底栏高"，所以浮层整块盖住 rail、不会露出半截。 */
    #chrome-side {
      display: flex;
      flex-direction: column;
      flex: 0 0 auto;
      /* 宽度优先级：**拖动中的临时值** > 计划给的占位宽度 > 兜底。
         拖动的临时值由块自己写（跟手、不落库、不走计划），松手后清掉 → 回到计划值，
         再由块把新宽度写进设置。

         ⚠ 「悬停展开」不走临时值：它是**同一块区域**的两种宽度（静止 restWidth /
           唤出 revealWidth），由 applyPlan 按 setSideReveal 直接改 --ng-side-width。
           侧栏本来就在文档流里，唤出时网页真的让位 —— 没有浮层、没有第二份 DOM。
           （注：本段是 CSS 模板字符串的一部分，注释里**不能出现反引号** —— 会提前
           闭合字符串；这条已经踩过两次，见 ui-tabbar/src/styles.js 的同款警告。） */
      width: var(--ng-side-drag-width, var(--ng-side-width, 200px));
      min-width: 0;
      height: 100%;
      position: relative;
      background: var(--main-bg-color);
      overflow: hidden;
      order: 0;
      /* ⚠ 这里**刻意不声明容器**（曾经的 container: side-column / inline-size 已移走）：
         本元素是**玻璃带**（background: --hira-chrome-bg + backdrop-filter）。
         观测（2026-10 用户报障）：全仓只有这一条带**同时**是"玻璃带 + 带 containment"，
         而它也正是唯一一条"毛玻璃像没生效、颜色与 navbar / 内容洞 / 底部条对不上"的带
         （用户原话："垂直标签侧栏的模糊效果颜色和其他界面分裂根本不一样"）。
         口径：**玻璃带一律不写 contain / container** —— containment 会截断本元素的
         backdrop 采样（与 rail / 面板那批"跨视图采不到"属同一类现象）。
         容器查询本身仍然需要（"侧栏窄了就只留图标"），所以改挂到 **.vtabs** 上：
         那里宽度 = 侧栏区宽度，且**不带玻璃**（见 ui-vertical-tabs 的样式）。 */
    }

    #chrome-side[data-side="right"] {
      order: 2;
    }

    #chrome-side:empty,
    #chrome-side[data-hidden="true"] {
      display: none;
    }

    /* 只有朝内的那一条边有分隔线（贴窗缘的一侧不该有边） */
    #chrome-side[data-side="left"] {
      border-right: 1px solid var(--border-color);
    }
    #chrome-side[data-side="right"] {
      border-left: 1px solid var(--border-color);
    }

    /* 侧栏区**零宽**（= 这一侧真的不在台上）时连分隔线一起收掉 —— 否则窗缘会留
       一条 1px 的线，看起来像"侧栏还在，只是窄了"。
       判据用的是"落定的宽度"（data-empty），不是"是否唤出"：
       Edge 型的静止态宽度是 56px 的常驻 rail（永远不唤出这条区域），
       按唤出态判会把那条 rail 的分隔线一起误收掉。 */
    #chrome-side[data-empty="true"] {
      border-right-width: 0;
      border-left-width: 0;
    }

    /* 侧栏里的一「带」：横排放若干块。
       单块带**不套壳**（直接在 renderRows 里把块挂进侧栏）—— 这样块自己的
       flex:1（例如标签列表要吃满剩余高度）仍然作用在侧栏这个 flex 列上；
       若套一层壳，块只能在自己那层里撑，撑不开整列。 */
    .chrome-band {
      display: flex;
      flex-direction: row;
      align-items: stretch;
      width: 100%;
      flex-shrink: 0;
    }
    .chrome-band > * {
      flex-shrink: 0;
    }

    #chrome-top,
    #chrome-bottom {
      display: flex;
      flex-direction: column;
      flex-shrink: 0;
      width: 100%;
      position: relative;
    }

    /* 两侧都空着时彻底不占位：flex 列里的空 div 虽然高度为 0，但只要有边距/描边
       就会撑出一条透明缝 —— 而「一块都没摆」之后上方/下方不该留下任何空间。

       ⚠ 容器空 ≠ 没有 bar：会自我隐身的块（如空书签栏是 display:none）仍会作为
       子节点留在容器里。它们必须在登记时就被注销（chrome-layout-controller#setBlockVisible），
       否则 :empty 匹配不到，下面的底边距就会在「底部一块 bar 都没有」时凭空多出来。 */
    #chrome-top:empty,
    #chrome-bottom:empty {
      display: none;
    }

    /* 底部区与窗口底缘之间的呼吸空隙（最低那一行不贴着窗口边）。
       用内边距而不是外边距：底栏高度是按本容器的 getBoundingClientRect 上报给主进程的
       （网页 bounds 的下边界就取它），内边距计入高度 → 空隙由 chrome 背景补上，
       网页不会盖过来；外边距不计入 → 空隙会被网页吃掉。
       容器空着时走上面的 :empty 分支（display:none），这条自然不生效。 */
    #chrome-bottom {
      padding-bottom: var(--ng-chrome-bottom-gap, 0px);
    }

    /* 一行：横排若干块。default 下每行只装一块；compact 下合并行装两块。 */
    .chrome-row {
      display: flex;
      flex-direction: row;
      align-items: stretch;
      width: 100%;
      flex-shrink: 0;
    }
    .chrome-row > * {
      flex-shrink: 0;
    }

    #chrome-root .chrome-row[data-merged="true"] > * {
      width: auto;
      height: auto;
      min-width: 0;
    }
    #chrome-root .chrome-row[data-merged="true"] > #navbar-tabbar {
      flex: 1 1 0;
    }
    #chrome-root .chrome-row[data-merged="true"] > #navbar-toolbar {
      flex: 0 1 auto;
      margin-top: 0;
    }
    #chrome-root .chrome-row[data-merged="true"] #navbar-toolbar .omnibox {
      max-width: 380px;
    }

    /* 内容洞（webviews shell 的宿主）：占满剩余高度 */
    #chrome-content {
      flex: 1;
      min-height: 0;
      display: flex;
      position: relative;
    }
    #chrome-content > * {
      flex: 1;
      min-width: 0;
    }

  `
  doc.head.appendChild(style)
}

/** 创建外壳布局槽容器。 */
export function createChromeLayout(doc: Document): ChromeLayoutController {
  const root = doc.createElement('div')
  root.id = 'chrome-root'

  /** 跨栏顶带（根级）：铺满整窗、压在侧栏上方 —— 侧栏从它下面起算。
   *  只有声明"可跨侧栏"的块才进这里（navbar / titlebar / tabbar），见 shared-types#rowCrossesSide。 */
  const top = doc.createElement('div')
  top.id = 'chrome-top'

  /** 跨栏底带（根级）：同上，只是压在侧栏下方。 */
  const bottom = doc.createElement('div')
  bottom.id = 'chrome-bottom'

  /** 身体区（横排）：侧栏区 | 主列。跨栏两带在它外面。 */
  const body = doc.createElement('div')
  body.id = 'chrome-body'

  /** 侧栏区（纵排）。**没有块住进来时整个不渲染** —— 见 applyPlan。 */
  const side = doc.createElement('div')
  side.id = 'chrome-side'

  /** 主列：让位顶部段 / 内容洞 / 让位底部段（三段竖排）。宽度 = 身体区减去侧栏区。 */
  const main = doc.createElement('div')
  main.id = 'chrome-main'

  /** 让位顶部段：给侧栏让位的那些行（书签栏）住这里 —— 只在侧栏右边那一段。 */
  const topMain = doc.createElement('div')
  topMain.id = 'chrome-main-top'

  const content = doc.createElement('div')
  content.id = 'chrome-content'

  /** 让位底部段：同上（书签栏设在底部时）。 */
  const bottomMain = doc.createElement('div')
  bottomMain.id = 'chrome-main-bottom'

  // 分派由 applyPlan 按 shared-types#rowCrossesSide（块自己的声明表）决定：
  //   可跨侧栏的行 → 根级两条带（压在侧栏上下方）；
  //   给侧栏让位的行 → 主列里的那两段（只在侧栏右边）。
  // 于是"侧栏在 navbar 下方、但不在书签栏下方"这件事是**两条独立规则**的结果，
  // 不是同一段代码里的特判（用户口径，见样式里 #chrome-root 的注释）。
  main.appendChild(topMain)
  main.appendChild(content)
  main.appendChild(bottomMain)
  // 侧栏区始终留在 DOM 里（贴左/贴右由 CSS order 决定，隐藏只切 data-hidden）——
  // 理由见样式里 #chrome-side 的注释（上报占宽的 ResizeObserver 挂在它身上）。
  // 初始没有子节点 → `:empty` 让它不显示，默认布局因此零影响。
  body.appendChild(side)
  body.appendChild(main)
  root.appendChild(top)
  root.appendChild(body)
  root.appendChild(bottom)

  /** 块 id → 元素。null / 未注册 = 该块不存在（不参与摆放）。 */
  const blocks = new Map<string, HTMLElement>()
  /** 当前摆放计划（见 shared-types#planChromeLayout）。 */
  let plan: ChromeLayoutPlan = { mode: 'default', merged: false, top: [], bottom: [], side: null }

  /**
   * 侧栏是否处于**悬停唤出态**（只对 `side.autoHide` 有意义）。
   *
   * 这是运行期状态，不属于计划（计划是纯函数，不该掺指针位置）——
   * 由主进程的贴边巡看推下来（见 LayoutCoordinator 的 `_sideReveal*`）。
   * 非自动隐藏侧栏忽略它：它的宽度恒为 restWidth。
   */
  let sideRevealed = false

  /**
   * 给块打上「宿主轴」与所在区域侧别的标记。
   *
   * 容器能做的只有这件事：告诉块**它此刻住在什么轴的区域里**（行区=横排 / 侧栏=纵排）、
   * 以及（住侧栏时）侧栏贴的是窗口哪一边。块怎么据此变形（导航栏变多行堆叠、
   * 标签栏换成纵向列表、拖拽把手开在朝内那一侧…）是块自己的事 ——
   * 容器不认识任何块的内部，这是「加一块/加一个区域都不用改别的块」的前提。
   */
  function markAxis(el: HTMLElement, axis: ChromeAxis, regionSide?: ChromeRegionSide) {
    if (el.dataset.hostAxis !== axis) el.dataset.hostAxis = axis
    if (regionSide) {
      if (el.dataset.regionSide !== regionSide) el.dataset.regionSide = regionSide
    } else if (el.dataset.regionSide) {
      delete el.dataset.regionSide
    }
  }

  /**
   * 各区**上一次实际渲染出来的结构签名**（null = 尚未渲染过）。
   *
   * 为什么需要它：`setPlan` 在窗口 resize / 拖侧栏宽度 / 每次布局参数上报时都会被调用，
   * 而一次 `textContent = ''` + 重挂会 detach 掉块里所有子节点 —— DOM 焦点、滚动位置、
   * 正在跑的 CSS 过渡全部被打断（用户可见的形态是「拖宽度时地址栏输入框失焦」）。
   * 签名把「结构真变了」和「只是又推了一份一样的计划」分开，后者一个 DOM 操作都不做。
   */
  const appliedSig: Record<'top' | 'topMain' | 'bottom' | 'bottomMain' | 'side', string | null> = {
    top: null,
    topMain: null,
    bottom: null,
    bottomMain: null,
    side: null
  }

  /**
   * 一个区域**渲染后**的结构签名：只计入真正会被摆出来的块
   * （计划里未注册的 id 与因此变空的行都会被 renderRows 丢掉，签名必须与之一致，
   * 否则「注册了一个新块」不会让签名变化 → 重建被跳过 → 块永远挂不上去）。
   *
   */
  function regionSig(rows: string[][], axis: ChromeAxis): string {
    const rendered: string[] = []
    for (const ids of rows || []) {
      const kept = (ids || []).filter((id) => blocks.has(id))
      if (kept.length) rendered.push(kept.join(','))
    }
    return `${axis}|${rendered.join('/')}`
  }

  function applyPlan() {
    const sidePlan = plan.side
    // 只有「有块住侧栏」且「侧栏没被隐藏」时才渲染侧栏区。
    // visibility 的 hidden 是**真的不渲染**（块随之离开文档）——它怎么回来由调用方决定
    // （设置项 / 菜单项 / 悬浮唤出），容器不做策略判断。
    const showSide = !!sidePlan && sidePlan.visibility !== 'hidden'

    // ── 顶/底两区各自**再分两段**（唯一分派点，判据只有声明表 rowCrossesSide）────────
    //   可跨侧栏的行（navbar / titlebar / tabbar）→ 根级带：铺满整窗、压在侧栏上下方；
    //   给侧栏让位的行（bookmarkbar）        → 主列里的让位段：只在侧栏右边那一段。
    const split = (rows: string[][]): { cross: string[][]; yielding: string[][] } => {
      const cross: string[][] = []
      const yielding: string[][] = []
      for (const ids of rows || []) (rowCrossesSide(ids) ? cross : yielding).push(ids)
      return { cross, yielding }
    }
    const topParts = split(plan.top)
    const bottomParts = split(plan.bottom)

    const topSig = regionSig(topParts.cross, 'row')
    const topYieldSig = regionSig(topParts.yielding, 'row')
    const bottomSig = regionSig(bottomParts.cross, 'row')
    const bottomYieldSig = regionSig(bottomParts.yielding, 'row')
    // 侧别进签名：左右换边时行结构没变，但每个块的 regionSide 标记必须跟着翻。
    const sideSig = showSide ? `${sidePlan.position}${regionSig(sidePlan.rows, 'column')}` : 'hidden'

    // 结构没变的区域**一个 DOM 操作都不做**（见 appliedSig 的说明）。
    if (appliedSig.top !== topSig) {
      appliedSig.top = topSig
      top.textContent = ''
      renderRows(top, topParts.cross, 'row')
    }
    if (appliedSig.topMain !== topYieldSig) {
      appliedSig.topMain = topYieldSig
      topMain.textContent = ''
      renderRows(topMain, topParts.yielding, 'row')
    }
    if (appliedSig.bottom !== bottomSig) {
      appliedSig.bottom = bottomSig
      bottom.textContent = ''
      renderRows(bottom, bottomParts.cross, 'row')
    }
    if (appliedSig.bottomMain !== bottomYieldSig) {
      appliedSig.bottomMain = bottomYieldSig
      bottomMain.textContent = ''
      renderRows(bottomMain, bottomParts.yielding, 'row')
    }
    if (appliedSig.side !== sideSig) {
      appliedSig.side = sideSig
      side.textContent = ''
      if (showSide) {
        renderRows(side, sidePlan.rows, 'column', sidePlan.position)
        side.dataset.side = sidePlan.position
      }
    }

    // 状态标记每次都写：它们是幂等的 dataset / 自定义属性赋值，代价可忽略；
    // 而「结构签名不变但可见性变了」（hidden ↔ attached）这类切换只能靠这里跟上。
    // 不渲染 = 整个元素 `display:none`（宽度归零 → 网页不让位）。
    // **不摘除元素**：侧栏占宽的上报方（ResizeObserver）挂在它身上，
    // 摘掉就收不到这次归零，网页会一直留着上一份内缩。
    side.dataset.hidden = showSide ? 'false' : 'true'
    if (showSide) {
      // 宽度只有两档：**静止占位**（restWidth）/ **悬停唤出**（revealWidth）。
      // 但「唤出」有两种形态，由计划里的 revealOverlay 分型（唯一判据）：
      //   · revealOverlay === true （Edge 型自动隐藏）→ 唤出的是**独立浮层**，
      //     这一点 DOM 里的侧栏区**始终是 restWidth（图标 rail）**，网页不缩进不重排；
      //   · revealOverlay === false（全功能型）→ 唤出就是同一个 --ng-side-width 变宽，
      //     侧栏本来就在文档流里，网页真的让位。
      const revealed = !!sideRevealed
      const expanded = revealed && !sidePlan.revealOverlay
      const target = expanded ? sidePlan.revealWidth : sidePlan.restWidth
      root.style.setProperty('--ng-side-width', `${target}px`)
      // 这一侧此刻是否零宽（分隔线的唯一判据，与上面写下去的那个数同源）。
      side.dataset.empty = target > 0 ? 'false' : 'true'
    }
    // 供样式与调试用的两根状态标记（也是「默认/垂直」判据的可见证据）。
    root.dataset.layoutMode = plan.mode === 'compact' ? 'compact' : 'default'
    root.dataset.layoutAxis = showSide ? 'vertical' : 'horizontal'
    if (plan.merged) root.dataset.merged = 'true'
    else delete root.dataset.merged
  }

  /**
   * 按计划渲染一个区域的行结构。
   *
   */
  function renderRows(host: HTMLElement, rows: string[][], axis: ChromeAxis, regionSide?: ChromeRegionSide) {
    for (const ids of rows || []) {
      // 纵排区域里的**单块带不套壳**：直接挂进侧栏，块自身的 flex:1 才能作用在整列上。
      if (axis === 'column' && ids.length === 1) {
        const el = blocks.get(ids[0])
        if (!el) continue
        markAxis(el, 'column', regionSide)
        host.appendChild(el)
        continue
      }
      const row = doc.createElement('div')
      row.className = axis === 'column' ? 'chrome-band' : 'chrome-row'
      const inner = axis === 'column' ? 'row' : axis
      if (ids.length > 1) {
        row.dataset.merged = 'true'
      }
      for (const id of ids) {
        const el = blocks.get(id)
        if (!el) continue
        // 带内多块是横排的（哪怕整条带住在纵排区域里）→ 轴给 row、侧别照旧透传。
        markAxis(el, inner, axis === 'column' ? regionSide : undefined)
        row.appendChild(el)
      }
      // 行里一块都没有（都未注册）→ 不产生空行，避免多出一条透明缝。
      if (row.childElementCount === 0) continue
      host.appendChild(row)
    }
  }

  return {
    element: root,
    slots: { top, topMain, bottom, bottomMain, content, side },

    /**
     * 注册（或移除）一个块。
     * @param {string} id
     * @param {HTMLElement | null} el
     */
    setBlock(id: string, el: HTMLElement | null) {
      if (!id) return
      if (el) {
        // 同一元素重复登记 = 无变化：直接返回，别去动 DOM（块里可能正有输入框在打字）。
        if (blocks.get(id) === el) return
        blocks.set(id, el)
        // 元素被**换掉**而 id 不变：结构签名只记 id，看不出这种替换 —— 必须显式作废，
        // 否则旧元素会一直留在原地、新元素永远挂不上去。
        // 四个区全部作废：块住哪一区由计划决定，且 topMain / bottomMain（给侧栏让位的
        // 行，书签栏通常住这里）与 top / bottom 各有独立签名 —— 漏一个就会留下
        // 「换了元素但那一区不重挂」的角落。
        appliedSig.top = null
        appliedSig.topMain = null
        appliedSig.bottom = null
        appliedSig.bottomMain = null
        appliedSig.side = null
      } else {
        if (!blocks.has(id)) return
        // 注销：签名按「已注册 id」算，去掉之后签名自然变化，无需额外作废。
        blocks.delete(id)
      }
      applyPlan()
    },

    /**
     * 施加摆放计划。
     */
    setPlan(next: ChromeLayoutPlanInput = {}) {
      const p = next || {}
      const s = p.side
      plan = {
        mode: p.mode === 'compact' ? 'compact' : 'default',
        merged: p.merged === true,
        top: Array.isArray(p.top) ? p.top : [],
        bottom: Array.isArray(p.bottom) ? p.bottom : [],
        side: s && Array.isArray(s.rows) && s.rows.length
          ? {
              rows: s.rows,
              position: s.position === 'right' ? 'right' : 'left',
              visibility: s.visibility === 'floating' || s.visibility === 'hidden' ? s.visibility : 'attached',
              autoHide: s.autoHide === true || s.visibility === 'floating',
              width: Number(s.width) || 0,
              collapsed: s.collapsed === true,
              restWidth: Number(s.restWidth) || 0,
              // 唤出形态：true = 展开覆盖网页的独立浮层（Edge 型），本区宽度恒为 restWidth。
              revealOverlay: s.revealOverlay === true,
              // 唤出宽度：折叠时是图标条，否则是用户拖的宽度（只有一个真源）。
              revealWidth: Number(s.revealWidth) || Number(s.width) || 0
            }
          : null
      }
      // 计划里的自动隐藏态变了 → 唤出态作废（收回静止态），避免"换了布局还挂着上一次的展开"。
      if (!plan.side || !plan.side.autoHide) sideRevealed = false
      applyPlan()
    },

    /**
     * 当前 chrome 层级的真实几何。
     *
     * 工坊用它把 top / bottom / side 四个真实区域和其中的用户块画成可投放层。
     * 返回的是窗口内坐标；不包含 tabbar/navbar 内部按钮（那两排各有 SurfaceAdapter）。
     */
    getBlockZones(): ChromeBlockZone[] {
      const defs: Array<[string, HTMLElement, ChromeAxis, string]> = [
        ['top', top, 'row', '顶部跨栏'],
        ['top-main', topMain, 'row', '顶部内容行'],
        ['bottom', bottom, 'row', '底部跨栏'],
        ['bottom-main', bottomMain, 'row', '底部内容行'],
        ['side', side, 'column', '侧栏区']
      ]
      const out: ChromeBlockZone[] = []
      for (const [key, host, axis, label] of defs) {
        if (!host) continue
        const hostRect = host.getBoundingClientRect()
        if (hostRect.width <= 0 && hostRect.height <= 0) continue
        const items: ChromeBlockZoneItem[] = []
        for (const [id, el] of blocks) {
          if (!host.contains(el)) continue
          const r = el.getBoundingClientRect()
          if (r.width <= 0 && r.height <= 0) continue
          items.push({
            id,
            x: Math.round(r.left),
            y: Math.round(r.top),
            width: Math.round(r.width),
            height: Math.round(r.height)
          })
        }
        out.push({
          key,
          label,
          axis,
          grow: axis === 'row' ? 'right' : 'down',
          rect: {
            x: Math.round(hostRect.left),
            y: Math.round(hostRect.top),
            width: Math.round(hostRect.width),
            height: Math.round(hostRect.height)
          },
          items
        })
      }
      return out
    },

    /**
     * 侧栏悬停唤出态（主进程贴边巡看推下来的运行期状态）。
     *
     * 只改宽度这一个像素事实；侧栏 DOM 不重建、不搬动 —— 所以唤出时网页真的让位。
     * @param {boolean} revealed
     */
    setSideReveal(revealed: boolean) {
      const next = revealed === true
      if (next === sideRevealed) return
      sideRevealed = next
      applyPlan()
    },

    getPlan: () => plan,

    /** 注入内容区（webviews shell 的透明洞）。传 null 清空。 */
    setContent(el: HTMLElement | null) {
      content.textContent = ''
      if (el) content.appendChild(el)
    },

    dispose() {
      root.remove()
    }
  }
}
