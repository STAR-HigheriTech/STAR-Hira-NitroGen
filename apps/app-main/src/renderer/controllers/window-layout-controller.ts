/**
 * WindowLayoutController —— 窗口结构性布局参数的**唯一上报方**（对齐 RT page:set-layout-params）。
 *
 * 为什么渲染层只发「结构参数」而不是像素坐标：主进程用窗口 contentSize 做算术即可
 * 得出页面/侧栏/面板的精确 bounds，renderer 端零 `getBoundingClientRect` 往返、
 * 动画期间零 IPC —— 这是「不卡顿」的地基（对齐 RT 声明式 page bounds）。
 *
 * 本控制器只报结构性布局事实。rail 固定态与贴边唤出均由主进程 LayoutCoordinator
 * 唯一持有，避免 renderer 回写覆盖持久化状态。侧栏区「常驻 / 悬停唤出 / 隐藏」
 * 仍只报计划口径与 DOM 实测占宽，实际唤出由主进程按指针位置裁定。
 */
import {
  LAYOUT_SETTING_KEYS,
  toFlag,
  normalizeRailPosition,
  normalizeRailHorizontalAlign,
  normalizeRailVerticalAlign,
  resolveRailPanelSide
} from '@hira-ng/shared-types/src/layout.mjs'
import { IPC_EVENTS } from '@hira-ng/shared-types/src/ipc-channels.mjs'

interface SideColumnPlan {
  rows?: unknown[]
  autoHide?: boolean
  revealWidth?: number
  revealOverlay?: boolean
}

interface WindowLayoutControllerOptions {
  window: Window
  shell: { setMaximized?(value: boolean): void }
  layoutClient: {
    setPageLayoutParams(params: Record<string, unknown>): Promise<unknown>
    setPageLayoutParamsLive?(params: Record<string, unknown>): void
  }
  provider: { invoke<T = Record<string, unknown>>(route: string, payload?: unknown): Promise<T> }
  onSubscribe<T = unknown>(route: string, listener: (payload: T) => void): () => void
  topbarEl?: HTMLElement | null
  topbarMainEl?: HTMLElement | null
  bottombarEl?: HTMLElement | null
  bottombarMainEl?: HTMLElement | null
  sideEl?: HTMLElement | null
  getSideColumn?: () => SideColumnPlan | null
}

export function createWindowLayoutController({ window, shell, layoutClient, provider, onSubscribe, topbarEl, topbarMainEl, bottombarEl, bottombarMainEl, sideEl, getSideColumn }: WindowLayoutControllerOptions) {
  let disposed = false
  let lastParamsSignature: string | null = null
  /**
   * 工具图标栏（rail）位置：left / right（纵向列）或 top / bottom（横向条）。
   * `sidebarPosition`（面板所在侧）是由它 + 横向起始边解算出来的派生值 ——
   * 面板要开在哪一侧永远只读这一份算术，不在任何模块里二次判断。
   */
  let railPosition = 'left'
  let railHorizontalAlign = 'left'
  let railVerticalAlign = 'top'
  /**
   * 三条 rail 设置是否已经从设置域读回。
   *
   * 读回来之前**不上报**这组字段：那时的 'left' 只是占位值，报上去会盖掉主进程
   * 由生效器（appliers/layout.js）灌进去的正确值 —— 表现是启动瞬间 rail 先按左列
   * 画一帧、再跳到用户选的顶部。
   */
  let railLayoutReady = false
  /** 面板（工具区）所在侧：纵向 rail = 自身侧；横向 rail = 起始边解算（见 resolveRailPanelSide）。 */
  let sidebarPosition = resolveRailPanelSide(railPosition, railHorizontalAlign)
  /**
   * 侧栏区（垂直标签侧栏那一列）自己所在的一侧。
   *
   * 与 `sidebarPosition`（rail / 面板那一段）**相互独立** —— 纵向轨道上两段可以各靠
   * 一边。由外壳布局计划（plan.side.position）灌入：只有计划知道有没有块住侧栏、
   * 以及那一列该靠哪边。主进程据此算内缩与各视图 x（见 LayoutCoordinator）。
   */
  let sideColumnSide = 'left'
  /**
   * 导航栏（地址栏那块）当前所在侧。由 chrome-layout-controller 在换布局后同步过来 ——
   * 主进程靠它决定地址栏下拉向上还是向下弹（见 LayoutCoordinator#anchorFloatBelowTopbar）。
   */
  let navSide = 'top'
  /**
   * 沉浸模式（设置 app.immersive_mode）：chrome 整体收起、网页铺满窗口。
   *
   * 这里只上报**设置值**，"此刻有没有被唤出"由主进程按屏幕指针位置算 —— 收起后
   * 指针全在网页那条原生视图上，本渲染层收不到任何指针事件，"悬停唤出"在这里无从判定。
   */
  let immersiveMode = false
  /** 宽度把手按住期间：主进程冻结侧栏 hover 巡看，避免拖宽时被判断为离开。 */
  let sideColumnResizing = false

  /**
   * 顶部区 / 底部区元素（由 ui-chrome-layout 提供）—— **每一边两个**。
   *
   * 为什么是两个：那一区里可能同时住着两类行（见 shared-types#rowCrossesSide）：
   *   · **可跨侧栏**的行（navbar / titlebar）→ 根级的跨栏带 `topbarEl` / `bottombarEl`；
   *   · **给侧栏让位**的行（书签栏）→ 主列里的让位段 `topbarMainEl` / `bottombarMainEl`。
   * 两者都压在网页上方（或下方），所以**网页的内缩必须是两者之和** —— 只量跨栏带，
   * 书签栏就会被网页盖住（用户口径："侧栏在 navbar 下方、但不在书签栏下方"，
   * 书签栏仍然要占网页的位置）。
   */
  const topEl = topbarEl || null
  const topMainEl = topbarMainEl || null
  const bottomEl = bottombarEl || null
  const bottomMainEl = bottombarMainEl || null
  /**
   * 侧栏区元素（垂直标签栏住的那一列）。
   *
   * 它量的是**宽度**：网页要横向让出这一段，rail 也要往里让。
   * 与高度一样从 DOM 实测而不是读设置值 —— 容器写进 `--ng-side-width` 的才是
   * 真正生效的宽度（折叠态、隐藏态都已在容器里体现），主进程照单收下即可。
   * 注意：没有块住侧栏时该元素 `display:none` → 宽度 0 → 网页不让位（默认布局零影响）。
   */
  const sideColumnEl = sideEl || null
  /** 计划里的侧栏区（由外壳布局控制器注入的只读取值器）—— 悬停浮出形态与展开宽度都从它来。 */
  const readSideColumn = typeof getSideColumn === 'function' ? getSideColumn : () => null

  function measure(el: HTMLElement | null | undefined): number {
    if (!el) return 0
    return Math.ceil(el.getBoundingClientRect().height || 0)
  }

  function measureWidth(el: HTMLElement | null | undefined): number {
    if (!el) return 0
    return Math.ceil(el.getBoundingClientRect().width || 0)
  }

  /**
   * 侧栏区的**矩形**（chrome 客户端坐标 = 窗口内容区坐标：chrome 视图铺满内容区）。
   *
   * 只服务 Edge 型的覆盖浮层：浮层必须和 rail **像素级对齐**。
   * 不能用「窗口高 − 顶/底内缩」那套算术反推 —— 那里面的内缩还含**主列内部的让位段**
   * （书签栏等 `#chrome-main-top/bottom`），它们只缩短主列、不缩短侧栏区，
   * 拿去算浮层就会让浮层比 rail 矮一整行（用户看到的就是这个）。
   * 元素为 `display:none`（无侧栏）时宽高为 0 → 报 null，主进程自然退回旧算术。
   */
  function measureRect(el: HTMLElement | null | undefined): { x: number; y: number; width: number; height: number } | null {
    if (!el) return null
    const r = el.getBoundingClientRect()
    if (!r || r.width <= 0 || r.height <= 0) return null
    return {
      x: Math.round(r.left),
      y: Math.round(r.top),
      width: Math.round(r.width),
      height: Math.round(r.height)
    }
  }

  async function reportLayout() {
    if (disposed) return
    // 顶/底的内缩 = **跨栏带 + 让位段**之和（见 topMainEl 的说明）。空的一段量到 null → 记 0。
    const topbarHeight = (measure(topEl) || 0) + (measure(topMainEl) || 0)
    // 底栏高度含它自己那条「与窗口底缘的呼吸空隙」（由 ui-chrome-layout 以内边距消费）——
    // 内边距计入矩形高度，所以这里量到的就是网页下边界该停的地方。
    const bottombarHeight = (measure(bottomEl) || 0) + (measure(bottomMainEl) || 0)
    // 侧栏区实测占宽（没有块住侧栏时为 0；自动隐藏的侧栏**静止时同样是 0**）
    const sideColumnWidth = measureWidth(sideColumnEl)

    const sidePlan = readSideColumn() || null
    /** 有没有块住侧栏 —— 只能看计划（静止 0 宽时 DOM 量与「没挂上」无法区分）。 */
    const sideColumnVisible = !!(sidePlan && Array.isArray(sidePlan.rows) && sidePlan.rows.length > 0)

    // 三者都为空 = 外壳还没挂上（而不是「都摆到底部/侧栏」），此时上报 0 会让页面铺满窗口。
    // ⚠ 侧栏区也要算进这个判据：把四块全摆进侧栏时上/下都是空的，
    //   只按高度判会在这里提前返回，网页就永远不让位了。
    //   自动隐藏的侧栏静止时 DOM 宽就是 0，故这里按**计划**判，不能只看实测宽。
    if (!topbarHeight && !bottombarHeight && !sideColumnVisible && !sideColumnWidth) return

    const params = {
      topbarHeight,
      topbarVisible: true,
      // 沉浸模式的**设置值**（不是"此刻被唤出"——那由主进程按指针位置算）。
      immersiveMode,
      bottombarHeight,
      navSide,
      sidebarSide: sidebarPosition,
      // rail 轴向 + 起始边：主进程据此把 rail 摆成横向条 / 纵向列，并解算面板所在侧。
      // 读回来之前不带（见 railLayoutReady）：那时的占位值会把生效器灌的正确值盖掉。
      ...(railLayoutReady ? { railPosition, railHorizontalAlign, railVerticalAlign } : null),
      sidebarAnimating: false,
      // 侧栏区：占宽由 DOM 实测；>0 即占位（0 = 无侧栏区 / 已隐藏 / 悬停态静止）。
      sideColumnWidth,
      sideColumnVisible,
      // 侧栏区**自己那一侧**（与 sidebarSide 相互独立；主进程按各自的侧算内缩与 x）。
      sideColumnSide,
      // ── 悬停唤出的两条事实（形态由计划分成两型，见 layout.mjs#planChromeLayout）──
      // autoHide：本侧栏是「自动隐藏」形态（静止不完整展开，指针贴边才唤出）；
      // revealWidth：唤出时该占用多宽（折叠成图标条时就是图标条宽）。
      // 它由布局计划算好（用户宽度 / 图标条宽），主进程据此**提前**让网页让位。
      sideColumnAutoHide: !!(sidePlan && sidePlan.autoHide),
      sideColumnRevealWidth: sidePlan ? Math.round(Number(sidePlan.revealWidth) || 0) : 0,
      // revealOverlay：唤出是**覆盖网页的独立浮层**（Edge 型），还是把同一块侧栏变宽推挤网页
      // （全功能型）。true 时主进程不缩网页，只把浮层摆到侧栏位置。
      sideColumnRevealOverlay: !!(sidePlan && sidePlan.revealOverlay),
      sideColumnResizing,
      // 侧栏区实测矩形：Edge 型浮层照它落位（与 rail 同一块 DOM，见 measureRect）。
      sideColumnRect: measureRect(sideColumnEl),
      contentTopOffset: 0
    }

    const signature = JSON.stringify(params)
    if (lastParamsSignature === signature) return
    lastParamsSignature = signature
    try {
      // 结构参数是"推上去就算数"的事实，不需要返回值；高频拖动 / resize 走单向通道，
      // 避免每帧多一次回包、Promise 分配与主进程排队。
      if (typeof layoutClient.setPageLayoutParamsLive === 'function') {
        layoutClient.setPageLayoutParamsLive(params)
      } else {
        await layoutClient.setPageLayoutParams(params)
      }
    } catch {}
  }

  /** 合帧上报句柄（见观察者那段注释）。 */
  let reportFrame = 0

  /** 合帧版 reportLayout：一帧内被叫多次也只量一次、只发一条 IPC。 */
  function scheduleReport() {
    if (disposed || reportFrame) return
    reportFrame = requestAnimationFrame(() => {
      reportFrame = 0
      reportLayout()
    })
  }

  // rail 位置 + 起始边：一次读完再统一解算「面板所在侧」并上报，
  // 避免三条设置各自回来时各报一次、方向闪一下。
  Promise.all([
    provider.invoke('settings:get', { key: LAYOUT_SETTING_KEYS.toolSidebarPosition }),
    provider.invoke('settings:get', { key: LAYOUT_SETTING_KEYS.toolRailHorizontalAlign }),
    provider.invoke('settings:get', { key: LAYOUT_SETTING_KEYS.toolRailVerticalAlign })
  ]).then((results) => {
    const valueOf = (r: unknown): unknown => r && typeof r === 'object' && 'value' in r ? (r as { value?: unknown }).value : r
    railPosition = normalizeRailPosition(valueOf(results[0]))
    railHorizontalAlign = normalizeRailHorizontalAlign(valueOf(results[1]))
    railVerticalAlign = normalizeRailVerticalAlign(valueOf(results[2]))
    sidebarPosition = resolveRailPanelSide(railPosition, railHorizontalAlign)
    railLayoutReady = true
    reportLayout()
  }).catch(() => {})

  // 侧栏区自己那一侧（垂直标签侧栏）：与上面那条是**两条独立设置**，
  // 故这里独立读一次 —— 之后由外壳布局计划（applyInitialLayout 的 onPlan）随每次
  // 换布局一起纠正，避免「块进出侧栏」时侧值落后于宽度。
  provider.invoke<{ value?: unknown }>('settings:get', { key: LAYOUT_SETTING_KEYS.sideColumnPosition }).then((result) => {
    const value = result && result.value !== undefined ? result.value : result
    if (value === 'right') {
      sideColumnSide = 'right'
      reportLayout()
    }
  }).catch(() => {})

  // 沉浸模式：读一次 + 跟随设置变化。关掉时主进程会立刻把 chrome 放回来（同一套布局分支）。
  provider.invoke<{ value?: unknown }>('settings:get', { key: LAYOUT_SETTING_KEYS.immersiveMode }).then((result) => {
    const value = result && result.value !== undefined ? result.value : result
    const next = toFlag(value)
    if (next === immersiveMode) return
    immersiveMode = next
    reportLayout()
  }).catch(() => {})

  const unsubscribeSettings = onSubscribe<{ key?: string }>(IPC_EVENTS.settingsChanged, (payload) => {
    // 只关心这一个键（payload 里带 key；不带或按域广播时也重读一次，代价只是一次 IPC）。
    if (payload && payload.key && payload.key !== LAYOUT_SETTING_KEYS.immersiveMode) return
    provider.invoke<{ value?: unknown }>('settings:get', { key: LAYOUT_SETTING_KEYS.immersiveMode }).then((result) => {
      const value = result && result.value !== undefined ? result.value : result
      const next = toFlag(value)
      if (next === immersiveMode) return
      immersiveMode = next
      reportLayout()
    }).catch(() => {})
  })

  const unsubscribe = onSubscribe<{ isMaximized?: boolean; isFullscreen?: boolean }>(IPC_EVENTS.windowStateChanged, (payload) => {
    if (payload && typeof shell.setMaximized === 'function') {
      shell.setMaximized(payload.isMaximized === true || payload.isFullscreen === true)
    }
  })

  provider.invoke<{ isMaximized?: boolean; isFullscreen?: boolean }>('window:get-state').then((state) => {
    if (!disposed && state && typeof shell.setMaximized === 'function') {
      shell.setMaximized(state.isMaximized === true || state.isFullscreen === true)
    }
  }).catch(() => {})

  const observer = new ResizeObserver(scheduleReport)
  if (topEl) observer.observe(topEl)
  if (topMainEl) observer.observe(topMainEl)
  if (bottomEl) observer.observe(bottomEl)
  if (bottomMainEl) observer.observe(bottomMainEl)
  // 侧栏区也观察：宽度变化（切布局 / 折叠 / 拖拽调宽 / 隐藏）→ 立即重报，
  // 主进程据此重算网页内缩与 rail 的位置。元素隐藏时本观察者仍会给出 0 宽，
  // 所以「隐藏侧栏但网页还留着内缩」不会发生。
  //
  // 走 scheduleReport（合帧）而不是直接 reportLayout：拖拽调宽期每一帧都会命中这个
  // 观察者，而一次布局切换又会让 top / bottom / side 同时变动 —— 直接调用就是
  // 「一次渲染帧内量三遍、发三条 IPC」。合帧后每帧最多一条，与面板把手
  // （见 panels/main.js#flushResizeWidth）同一套口径。rAF 与 ResizeObserver 回调
  // 都在同一帧、绘制之前执行，所以合帧**不增加**网页内缩的延迟。
  if (sideColumnEl) observer.observe(sideColumnEl)
  window.addEventListener('resize', scheduleReport)
  reportLayout()

  return {
    reportHeaderHeight: reportLayout,
    reportLayout,

    /** 当前面板所在侧（左 / 右）—— 边缘唤出的判定方向由它决定。 */
    getSidebarPosition: () => sidebarPosition,

    /** 当前 rail 位置与起始边（供 rail 渲染层 / 外壳读）。 */
    getRailLayout: () => ({ position: railPosition, horizontalAlign: railHorizontalAlign, verticalAlign: railVerticalAlign }),

    /**
     * 更新 rail 位置 / 起始边 —— **唯一入口**。
     *
     * 面板侧在这里由 `resolveRailPanelSide` 派生，调用方不自己判断方向；
     * 任何一项变了只重报一次，主进程据此重算 rail 轴向与网页内缩。
     * @param {{position?:string, horizontalAlign?:string, verticalAlign?:string}} next
     */
    setRailLayout(next: { position?: string; horizontalAlign?: string; verticalAlign?: string } = {}) {
      const position = normalizeRailPosition(next.position != null ? next.position : railPosition)
      const horizontalAlign = normalizeRailHorizontalAlign(
        next.horizontalAlign != null ? next.horizontalAlign : railHorizontalAlign
      )
      const verticalAlign = normalizeRailVerticalAlign(
        next.verticalAlign != null ? next.verticalAlign : railVerticalAlign
      )
      if (
        position === railPosition &&
        horizontalAlign === railHorizontalAlign &&
        verticalAlign === railVerticalAlign
      ) {
        return
      }
      railPosition = position
      railHorizontalAlign = horizontalAlign
      railVerticalAlign = verticalAlign
      sidebarPosition = resolveRailPanelSide(position, horizontalAlign)
      railLayoutReady = true
      reportLayout()
    },

    /**
     * 侧栏区（垂直标签侧栏那一列）所在侧。
     *
     * 与 `setRailLayout`（rail / 面板）**分开**：纵向轨道上两段各有自己的侧，
     * 可以各靠一边。由外壳布局计划灌入（`plan.side.position`）——
     * 计划是「有没有块住侧栏、那一列靠哪边」的唯一下游，这里只是把它转告主进程。
     * @param {'left'|'right'} side
     */
    setSideColumnSide(side: 'left'|'right') {
      const next = side === 'right' ? 'right' : 'left'
      if (next === sideColumnSide) return
      sideColumnSide = next
      reportLayout()
    },

    /** 宽度把手拖拽会话：起止各上报一次，期间主进程冻结侧栏收起判定。 */
    setSideColumnResizing(next: unknown) {
      const value = next === true
      if (value === sideColumnResizing) return
      sideColumnResizing = value
      reportLayout()
    },

    /** 当前导航栏所在侧（'top' | 'bottom'）。 */
    getNavSide: () => navSide,

    /**
     * 换布局后同步导航栏所在侧并重新上报（幂等：值没变直接返回，避免多余 IPC）。
     * @param {'top'|'bottom'} side
     */
    setNavSide(side: 'top'|'bottom') {
      const next = side === 'bottom' ? 'bottom' : 'top'
      if (next === navSide) return
      navSide = next
      reportLayout()
    },

    dispose: () => {
      if (disposed) return
      disposed = true
      unsubscribeSettings()
      unsubscribe()
      observer.disconnect()
      if (reportFrame) { cancelAnimationFrame(reportFrame); reportFrame = 0 }
      window.removeEventListener('resize', scheduleReport)
    }
  }
}
