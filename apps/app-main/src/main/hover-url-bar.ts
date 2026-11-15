/**
 * hover-url-bar —— 链接悬停 URL 提示条的**窗口侧端口**（每窗口一份）
 *
 * ── 形态：与 RT 一模一样 —— 独立透明浮层视图，不是窗口 ──────────────────
 * 对齐 RT `windows-controller/.../portal-component-windows.ts` 的 PortalComponent：
 * 提示条住在**自己一条透明 WebContentsView** 里（RT 是 `tabTargetUrlIndicator` 图层，
 * zIndex 11、focusPriority 0），落在网页左下角，DOM 侧 `pointer-events: none`。
 * 三条铁律（都是 RT 的口径）：
 *   ① **不占位、不挤网页**：它是浮层，不是布局块（位置由主进程按网页矩形算，
 *      见 ipc/layout.js 的 `position:'in-content'`）；
 *   ② **不抢键盘焦点**：`focusPriority = 0`（LayerStack.FOCUS_PRIORITY），
 *      它只是鼠标划出来的信息条，绝不能把正在输入的网页/地址栏顶掉；
 *   ③ **不吃鼠标（主动让开）**：浮层可见就会参与命中（`WebContentsView` 没有
 *      `setIgnoreMouseEvents`），压在网页上的信息层因此会被指针"踩住"。所以本模块给
 *      浮层登记了一条**指针靠近就避让**规则（`LayoutCoordinator#setFloatPointerAvoid`，
 *      机制对齐 RT `cursor-edge-monitor`：主进程 30fps 轮询系统指针位置）：指针一进
 *      提示条矩形（含 16px 余量）就把它收起来，且**在指针离开该区域之前拒绝恢复** ——
 *      这一步同时根治了抖动：不挡它，就会出现"指针压住 → 网页 hover 断 → 收起 →
 *      指针落回 → hover 恢复 → 又显示"的抖动环。指针离开后由 onRestore 把 URL 补推回去。
 *
 * ── 它做四件事，且都是"事实搬运" ────────────────────────────────────
 *   1. 接收 `update-target-url` 的原始事实（tabId + url，来自 tabEvents 的钩子）；
 *   2. **只认当前活动标签**：鼠标划的是活动页面，非活动标签的悬停事件是无效输入
 *      （标签切走时它的 update-target-url 仍可能到达）；
 *   3. 把事实转成浮层的一条消息，并附上"胶囊最宽能多宽"——**网页宽度的 60%**
 *      （对齐 RT TargetUrlIndicator 的 `maxWidth = anchor.width * 0.6`）。
 *      这个数字只有主进程知道（网页矩形是它算的），所以必须由这里补上；
 *      浮层再按它 clamp 自己，超出就省略号；
 *   4. `clear()` 时**连本地的去重基准一起清** —— 否则"切走再回来悬停同一个链接"
 *      会被 `next === lastUrl` 挡住，表现就是"同一链接第二次不显示了"。
 *
 * 为什么独立成文件而不是塞进 browser-window-runtime：那条运行单元已经很长，
 * 而这三件事与标签生命周期无关（只与"悬停事实"有关）—— 换个宿主（比如将来把
 * 悬停 URL 画到别处）时，本文件可以整体搬走。
 */

const OVERLAY = 'hoverurl-overlay'
/** 主进程 → 浮层（= IPC_EVENTS.hoverUrlUpdate，见 shared-types/src/ipc-channels.mjs） */
const EVENT_UPDATE = 'ngipc:event:hover-url:update'
/** 主进程 → 浮层：让它复位"我在显示"的内部状态（渲染页订阅的就是 `${OVERLAY}:hide`） */
const EVENT_HIDE = `ngipc:event:${OVERLAY}:hide`
/** 胶囊最宽 = 网页宽度 × 本比例（RT 口径）。 */
const MAX_WIDTH_RATIO = 0.6
/** 指针距提示条边界多少像素内算"靠近"（进入即让开）。 */
const CURSOR_AVOID_PAD = 16

interface HoverUrlLayoutPort {
  isFloatVisible(name: string): boolean
  noteFloatShow(name: string): unknown
  getFloatWebContents(name: string): Electron.WebContents | null
  sendToFloat(name: string, channel: string, payload: unknown): Promise<unknown>
  getFocusedWebBounds?(): Electron.Rectangle | null
  getContentBounds?(): Electron.Rectangle | null
  setFloatPointerAvoid(name: string, options: {
    pad: number
    onAvoid: () => void
    onRestore: () => void
  }): void
  clearFloatPointerAvoid(name: string): void
  isFloatPointerAvoided(name: string): boolean
}

/**
 * @param {object} deps
 * @param {object} deps.layoutCoordinator 本窗口的布局协调器（取浮层 wc + 网页矩形）
 * @param {() => string|null} deps.getFocusedSurface
 *   当前**聚焦的那块网页面**的标识：`'sidebar'` 或活动标签 id。
 *   为什么要一个"标识"而不是直接传 tabId：悬停事实来自两块网页面（标签 / 独立侧栏），
 *   而"哪一块算数"由键盘焦点决定 —— 过滤判据必须与来源同一套词汇。
 */
function createHoverUrlBar(deps: { layoutCoordinator: HoverUrlLayoutPort; getFocusedSurface: () => string | null }): { update: (source: string, url: string) => void; clear: () => void } {
  const { layoutCoordinator, getFocusedSurface } = deps
  /** 最近一次推给浮层的 URL（去重用：Chromium 偶发同值重复事件） */
  let lastUrl = ''

  function send(payload: { url: string; maxWidth: number; immediate?: boolean }): void {
    // ⚠ 必须先声明「请求显示」：layout.js 的 display 处理器有一道可见性闸门
    // （`isFloatVisible` 为假就把 display 丢掉），而这条闸门只认 `noteFloatShow` 置的
    // 逻辑可见态 —— 不声明的话浮层永远显示不出来（bounds 停在 0×0）。
    // 只在「从收起到显示」这一刻声明：连续悬停不同链接时不必反复递增代际。
    try {
      if (!layoutCoordinator.isFloatVisible(OVERLAY)) layoutCoordinator.noteFloatShow(OVERLAY)
    } catch (_) {}
    let wc = null
    try { wc = layoutCoordinator.getFloatWebContents(OVERLAY) } catch (_) { return }
    if (wc && !wc.isDestroyed()) {
      try { wc.send(EVENT_UPDATE, payload) } catch (_) {}
      return
    }
    // 浮层视图还不存在（本窗口从没悬停过链接）→ 走惰性创建那条路：
    // sendToFloat 会建视图、等 renderer 就绪（did-finish-load）再下发 ——
    // 直接丢消息会让**第一次**悬停什么都不显示（而"第一次不灵"是最容易被记住的 bug）。
    // 只有第一帧会走到这里，之后 getFloatWebContents 就命中缓存了。
    try { layoutCoordinator.sendToFloat(OVERLAY, EVENT_UPDATE, payload).catch(() => {}) } catch (_) {}
  }

  /** 网页宽度的 60%，取整；拿不到网页矩形时给 0（浮层就不改 max-width，退回 CSS 默认）。 */
  function maxWidth() {
    try {
      // 「当前聚焦的那块网页面」：侧栏聚焦时是侧栏，否则是活动格 —— 与落位用同一条判据
      //（见 LayoutCoordinator#getFocusedWebBounds），否则提示条会落在侧栏、宽度却按标签页算。
      const bounds = typeof layoutCoordinator.getFocusedWebBounds === 'function'
        ? layoutCoordinator.getFocusedWebBounds()
        : (typeof layoutCoordinator.getContentBounds === 'function' ? layoutCoordinator.getContentBounds() : null)
      if (!bounds || !(bounds.width > 0)) return 0
      return Math.floor(bounds.width * MAX_WIDTH_RATIO)
    } catch (_) {
      return 0
    }
  }

  /**
   * 让渲染页复位"我在显示"的内部状态。
   *
   * 为什么避让时必须补这一下：`LayoutCoordinator.hideFloat` 只收几何，渲染页那边的
   * 组件仍然认为自己在显示、且把当前文本记成了"已画过" —— 指针离开后我们把**同一条**
   * URL 再推过去时，组件会按"内容没变"直接跳过，表现为**让开之后再也不回来**。
   */
  function notifyRendererHide() {
    let wc = null
    try { wc = layoutCoordinator.getFloatWebContents(OVERLAY) } catch (_) { return }
    if (!wc || wc.isDestroyed()) return
    try { wc.send(EVENT_HIDE, {}) } catch (_) {}
  }

  /**
   * 登记「指针靠近就避让」（幂等：每次要显示前调一次即可）。
   *
   * 侦测跑在 LayoutCoordinator 里（它才握有浮层矩形与窗口原点），这里只声明意图：
   * 靠近就收（含 16px 余量）+ 让渲染页复位；**指针离开后**再把当前 URL 补推一遍恢复显示 ——
   * 提示条自己不会知道指针走了（那段时间它已经被收起、收不到任何事件）。
   */
  function armPointerAvoid() {
    try {
      layoutCoordinator.setFloatPointerAvoid(OVERLAY, {
        pad: CURSOR_AVOID_PAD,
        onAvoid: notifyRendererHide,
        onRestore: () => {
          if (lastUrl) send({ url: lastUrl, maxWidth: maxWidth() })
        }
      })
    } catch (_) {}
  }

  /**
   * 悬停事实到达。
   * @param {string} source 事件来源那块网页面（`'sidebar'` 或标签 id）
   * @param {string} url 目标 URL；空串 = 指针离开链接
   */
  function update(source: string, url: string): void {
    const focused = getFocusedSurface()
    // 非聚焦那块的悬停事件一律丢弃：它描述的是用户此刻没在操作的那一页
    //（标签切走 / 侧栏失焦后，它们的 update-target-url 仍可能到达）
    if (!focused || String(focused) !== String(source)) return
    const next = String(url || '')
    if (next === lastUrl) return
    lastUrl = next
    if (!next) {
      // 指针离开链接：撤销避让登记（表空即停表，多一个 tick 都不跑），
      // 并把空串推下去让浮层当场消失（这里不能走 clear()：去重基准此刻已经是空串了）。
      try { layoutCoordinator.clearFloatPointerAvoid(OVERLAY) } catch (_) {}
      send({ url: '', maxWidth: maxWidth(), immediate: true })
      return
    }
    // 正被指针"让开"期间：**只记住这一串，不要显示**。
    // 少了这道闸，就会出现"显示 → 指针压住 → 让开 → 立刻又显示"的快频抖动。
    try {
      if (layoutCoordinator.isFloatPointerAvoided(OVERLAY)) return
    } catch (_) {}
    armPointerAvoid()
    send({ url: next, maxWidth: maxWidth() })
  }

  /**
   * 无条件立即收起（切标签 / 开始导航 / 窗口失焦 / 主窗口移动缩放）。
   *
   * 两件事必须一起做：给浮层推一条"空 URL + immediate"（让它当场消失而不是走 400ms 延迟），
   * 并**清掉本地去重基准** —— 否则窗口失焦再回来后悬停同一个链接时，
   * `next === lastUrl` 会把这次更新挡掉，用户看到的是"这条提示条再也不出来了"。
   */
  function clear() {
    try { layoutCoordinator.clearFloatPointerAvoid(OVERLAY) } catch (_) {}
    if (!lastUrl) return
    lastUrl = ''
    send({ url: '', maxWidth: maxWidth(), immediate: true })
  }

  return { update, clear }
}

module.exports = { createHoverUrlBar }
