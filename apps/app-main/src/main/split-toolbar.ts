/**
 * SplitToolbar —— 「hover 在分屏上浮出的一排小按钮」（对齐 Zen / Edge 的分屏控件）。
 *
 * 按钮（从左到右）：**拖拽手柄**（拖动重排格子）/ 切换方向 / 反转格序 / 关闭这一格。
 *
 * 前三项与标签右键菜单里的分屏项是**同一批语义**（菜单是"可发现性兜底"，这排按钮是快路径）
 * —— 宿主把动作名映到 TabManager 上（见 browser-window-runtime 的 `runAction`）。
 *
 * ⚠ **「关闭这一格」不是「解散分屏」**：前者只关掉指针所在那一格的标签（Edge / Zen 同款：
 * 组里还剩 ≥2 格就继续分屏，只剩 1 格才退出），后者是标签右键菜单里的一项、把整片收掉。
 * 两者混成一个按钮就会出现"只想关掉一格、结果整片没了"。所以 ✕ 发的是 `close-pane` +
 * **指针所在格的 tabId**（由 hover 采样得到的 `lastPaneIndex` 换算，浮层只报格下标）。
 *
 * ── 为什么必须是一个独立浮层（而不是画在外壳 DOM 里）───────────────────────
 * 网页是原生 `WebContentsView`，外壳（chrome）天然位于所有子视图**之下** ——
 * DOM 里画不出任何压得住网页的东西。所以"浮在网页上的按钮"只能是一层独立浮层视图
 *（与查找栏 / 悬停 URL / 缩放条 / 拖动落点预览同族，见 ipc/layout.js#FLOAT_NAMES）。
 *
 * ── 为什么 hover 判定在主进程（这是本模块存在的唯一理由）─────────────────
 * 指针一旦进入网页原生视图，外壳渲染层就**收不到任何指针事件**；浮层自己也不可能靠 CSS
 * `:hover` 知道"指针进了分屏" —— 它要么整块吃掉鼠标（挡住网页）、要么整块穿透（收不到
 * 事件），Electron 的视图命中是**矩形级**的，没有"按元素命中"。所以"指针在哪一格"这个
 * 事实只能由主进程按屏幕光标 + 布局层给的格矩形算出来（复用 `splitPaneAtPoint` 纯几何）。
 *
 * 采样只在**当前有分屏**时跑（没分屏 = 一张表都不起，0 开销）；窗口失焦即停表
 *（见 browser-window-assembly 的失焦清理）。
 *
 * ── 与拖动落点预览（tab-drop-zone.js）的分工 ─────────────────────────────
 * 两者都"主进程采样 + 浮层"，但生命周期正交：那是**拖一个标签**（结束于松手），
 * 这是**停在分屏上**（持续）。各自一条 30fps 表，互不读写对方状态 —— 于是
 * "拖着标签掠过某个分屏"时不会出现两套判据互相打架。
 *
 * ── 彻底解耦 ────────────────────────────────────────────────────────────
 * 本文件**不 require electron**、不认识 TabManager / LayoutCoordinator：
 * 光标、几何、动作执行、浮层读写全部由宿主注入（可 headless 单测、可换实现）。
 *
 * 宿主注入（deps）：
 *   getCursorPoint()      → {x,y}|null              屏幕坐标（DIP）
 *   getContentOrigin()    → {x,y}|null              窗口内容区左上角的屏幕坐标（换算用）
 *   getGeometry()         → getSplitGeometry() 的形状（`{active, splitId, layout, count, members, activeTabId, panes}`）
 *   showOverlay(rect, payload) / hideOverlay()      浮层读写（rect = 内容区坐标）
 *   runAction(action, info)                         执行一个工具条动作（宿主握着 TabManager）
 *   pollMs                                          采样周期（默认 30fps）
 *
 * ## 生命周期
 *   sync()                        分屏状态变化后调一次：有分屏 → 起表；没有 → 停表 + 收浮层
 *   command(cmd)                  浮层来的命令（action / drag-*）
 *   cancel()                      兜底清理（窗口失焦 / 关闭 / 分屏消失）
 */

import { createCursorEdgeMonitor } from '@hira-ng/infra-window'
import { splitPaneAtPoint, moveMemberToIndex } from '@hira-ng/shared-types/src/split-layout.mjs'

interface Point { x: number; y: number }
interface Rect extends Point { width: number; height: number }
interface SplitGeometry {
  active: boolean
  splitId: string
  layout: unknown
  count: number
  members: unknown[]
  activeTabId: string | null
  panes: Rect[]
}
interface DragSession { splitId: string; tabId: string; fromIndex: number }
interface ToolbarPushExtra { dragging?: boolean; memberIndex?: number; dropIndex?: number }
interface ToolbarCommand {
  type?: string
  action?: string
  splitId?: string
  x?: number
  y?: number
  toIndex?: number
  memberIndex?: number
}
interface CursorMonitorPort { readonly running: boolean; start(): void; stop(): void }

export interface SplitToolbarDependencies {
  getCursorPoint?(): Point | null
  getContentOrigin?(): Point | null
  getGeometry?(): SplitGeometry | null
  showOverlay?(rect: Rect, payload: Record<string, unknown>): void
  hideOverlay?(): void
  runAction?(action: string, info: Record<string, unknown>): { moved?: boolean } | null | undefined
  pollMs?: number
}

/** 工具条相对所在格的内缩（px，右 / 上）。 */
const TOOLBAR_INSET = 8
/**
 * 工具条自身尺寸（px，与 ui 包 `ui-split-toolbar` 里的 CSS 逐项对齐）。
 *
 * 算式 = 按钮 30 × 个数 + 间距 8 × (个数−1) + 左右内边距 12 —— **只有主进程知道视图该多大**，
 * 所以写在这里；按钮表在 ui 包里（`BUTTONS`），两端靠"改按钮就改这一行"的约定同步。
 */
const TOOLBAR_BUTTON_COUNT = 4
export const TOOLBAR_SIZE: Readonly<Rect> = Object.freeze({ x: 0, y: 0, width: 30 * TOOLBAR_BUTTON_COUNT + 8 * (TOOLBAR_BUTTON_COUNT - 1) + 12, height: 30 })
/**
 * 工具条的合法动作集合（**白名单**：浮层来的字符串一律先过这里）。
 *
 * ⚠ 这里**没有** `dissolve` / `collapse`：工具条的 ✕ 语义是"关闭指针所在那一格"
 *（Edge / Zen 同款），不是解散整片分屏 —— 那两项在标签右键菜单里，不属于这排快路径按钮。
 */
export const TOOLBAR_ACTIONS = new Set<string>(['toggle-layout', 'reverse', 'close-pane'])

/** 把格矩形转成"贴在该格右上角的工具条矩形"（格太窄时退回贴左侧，保证不越出那一格）。 */
function toolbarRectForPane(pane: Rect | null | undefined): Rect | null {
  if (!pane) return null
  const rightAligned = pane.x + pane.width - TOOLBAR_SIZE.width - TOOLBAR_INSET
  return {
    x: Math.round(Math.max(pane.x + TOOLBAR_INSET, rightAligned)),
    y: Math.round(pane.y + TOOLBAR_INSET),
    width: TOOLBAR_SIZE.width,
    height: TOOLBAR_SIZE.height
  }
}

/** 整片分屏区域（拖动重排时浮层要铺满它，于是可以在自己视图里画高亮）。 */
function unionOfPanes(panes: readonly Rect[] | null | undefined): Rect | null {
  const list = Array.isArray(panes) ? panes.filter((pane): pane is Rect => Boolean(pane)) : []
  if (list.length === 0) return null
  let x0 = Infinity
  let y0 = Infinity
  let x1 = -Infinity
  let y1 = -Infinity
  for (const p of list) {
    x0 = Math.min(x0, p.x)
    y0 = Math.min(y0, p.y)
    x1 = Math.max(x1, p.x + p.width)
    y1 = Math.max(y1, p.y + p.height)
  }
  return { x: Math.round(x0), y: Math.round(y0), width: Math.round(x1 - x0), height: Math.round(y1 - y0) }
}

function pointInRect(rect: Rect | null | undefined, x: number, y: number): boolean {
  return !!rect && x >= rect.x && x <= rect.x + rect.width && y >= rect.y && y <= rect.y + rect.height
}

export function createSplitToolbar(deps: SplitToolbarDependencies = {}) {
  const getCursorPoint = typeof deps.getCursorPoint === 'function' ? deps.getCursorPoint : () => null
  const getContentOrigin = typeof deps.getContentOrigin === 'function' ? deps.getContentOrigin : () => null
  const getGeometry = typeof deps.getGeometry === 'function' ? deps.getGeometry : () => null
  const showOverlay = typeof deps.showOverlay === 'function' ? deps.showOverlay : () => {}
  const hideOverlay = typeof deps.hideOverlay === 'function' ? deps.hideOverlay : () => {}
  const runAction = typeof deps.runAction === 'function' ? deps.runAction : () => null

  /** 当前是否有分屏（`sync()` 维护）。没有就不起表 —— 这是"空闲 0 开销"的开关。 */
  let enabled = false
  let overlayShown = false
  /** 上次推给浮层的签名（矩形 + 形态），只在真的变了才推。 */
  let lastSignature = ''
  /** 指针此刻停在**工具条自己身上**时，保持显示（否则手指刚移上去就消失，按钮点不到）。 */
  let lastShownRect: Rect | null = null
  let lastPaneIndex = -1
  /**
   * 拖动重排会话：`{ splitId, tabId, fromIndex } | null`。
   * 拖动期间浮层铺满整片分屏区域并保持 interactive，因此**暂停 hover 判据** ——
   * 否则每次 tick 都会把 bounds 改回小工具条，手柄刚按下就被搬走。
   */
  let dragSession: DragSession | null = null
  let dragTargetIndex = -1
  /**
   * 上一拍采样到的光标屏幕坐标（`NaN` = 缓存失效，下一拍必须重算）。
   *
   * 为什么要有它：本模块的结论是 **光标 × 几何** 的纯函数 —— 光标一寸没动时，
   * 重算出的格下标与工具条矩形必然与上一拍相同。而 30fps 采样意味着"停在分屏上不动"
   * 这个最常见的情形会以 30Hz 无限重算 `getSplitGeometry()`（含 panes 数组）+
   * `getContentBounds()`：纯浪费。有此缓存，静止时每拍只做一次数值比较。
   *
   * 失效点（几何 / 尺寸 / 会话变化后必须重算）：`sync()` / `command()` / `cancel()` /
   * 外部 `invalidate()`（窗口 resize）。
   */
  let lastCursorX = NaN
  let lastCursorY = NaN

  const monitor = createCursorEdgeMonitor({
    getCursorPoint,
    getFocusedWindow: () => null,
    onEdge: () => {},
    onTick: handleTick,
    pollMs: deps.pollMs
  }) as CursorMonitorPort

  function hideNow(): void {
    if (!overlayShown) {
      lastShownRect = null
      lastPaneIndex = -1
      lastSignature = ''
      return
    }
    overlayShown = false
    lastShownRect = null
    lastPaneIndex = -1
    lastSignature = ''
    try { hideOverlay() } catch (_) {}
  }

  function geometry(): SplitGeometry | null {
    let geo: SplitGeometry | null = null
    try { geo = getGeometry() } catch (_) { geo = null }
    if (!geo || !geo.active || !Array.isArray(geo.panes) || geo.panes.length < 2) return null
    return geo
  }

  /** 让下一拍强制重算（几何 / 尺寸 / 会话变化后调用；幂等、零分配）。 */
  function invalidateTick(): void {
    lastCursorX = NaN
    lastCursorY = NaN
  }

  /** 一个采样周期的全部判定。 */
  function handleTick(cursor: Point | null | undefined): void {
    if (!enabled) return
    if (!cursor) { hideNow(); return }
    // 光标静止 → 上一拍的结论仍然成立（本模块是「光标 × 几何」的纯函数）。
    // 注意这里**不能**省掉时间维度：本模块没有任何"停留计时"，所有判定都是即时的，
    // 所以静止期间不重算完全等价（与 tab-drop-zone 的停留门禁不同 —— 那边依赖持续的 tick）。
    if (cursor.x === lastCursorX && cursor.y === lastCursorY) return
    const geo = geometry()
    if (!geo) { hideNow(); return }
    const origin = getContentOrigin()
    if (!origin) { hideNow(); return }
    // 采样成功才记账：几何 / 原点在这一拍取不到（布局重排、窗口瞬态）时不写缓存，
    // 下一拍自然重试 —— 否则一次瞬时失败会让工具条"卡死"到用户下次动鼠标为止。
    lastCursorX = cursor.x
    lastCursorY = cursor.y
    const local = { x: Number(cursor.x) - Number(origin.x || 0), y: Number(cursor.y) - Number(origin.y || 0) }

    // ── 拖动重排中：浮层已铺满整片区域，只更新"要插到第几格" ──────────────
    if (dragSession) {
      const index = splitPaneAtPoint(geo.panes, local)
      if (index !== dragTargetIndex) {
        dragTargetIndex = index
        push(unionOfPanes(geo.panes), geo, { dragging: true, dropIndex: index })
      }
      return
    }

    // ── hover：指针在哪一格 ────────────────────────────────────────────
    let paneIndex = splitPaneAtPoint(geo.panes, local)
    // 指针停在工具条**自己**身上时不算"离开那一格"：工具条贴在格的角落，
    // 而它自己是一块独立视图，指针进入后 local 仍落在同一格里（不会命中别的格），
    // 但边界情况（格被压到很小、工具条溢出格）会命中 -1 —— 所以用"还在工具条矩形里"兜住。
    if (paneIndex < 0 && pointInRect(lastShownRect, local.x, local.y)) paneIndex = lastPaneIndex
    if (paneIndex < 0) { hideNow(); return }

    const rect = toolbarRectForPane(geo.panes[paneIndex])
    if (!rect) { hideNow(); return }
    lastShownRect = rect
    lastPaneIndex = paneIndex
    push(rect, geo, { memberIndex: paneIndex })
  }

  /**
   * 把"这一块 + 形态"推给浮层。
   *
   * 两级去重各自独立：**几何没变就不动原生 bounds**（setBounds 会走一趟原生 + 重画），
   * **形态没变就不发 IPC**。hover 期间每秒 30 次采样里绝大多数都是同一状态，
   * 去重之后真正的写入只剩"跨到另一格"那几次。
   */
  function push(rect: Rect | null | undefined, geo: SplitGeometry, extra: ToolbarPushExtra): void {
    if (!rect) { hideNow(); return }
    const dragging = !!extra.dragging
    const memberIndex = typeof extra.memberIndex === 'number' ? extra.memberIndex : lastPaneIndex
    const dropIndex = typeof extra.dropIndex === 'number' ? extra.dropIndex : -1
    const { layout, count } = geo
    // **先用廉价原语拼签名**：稳态（指针在格内滑动）下这一步只产生一个短字符串。
    // payload 里的 `panes.map(...)` 会新建一个数组 + N 个对象，30fps 下白做就是持续垃圾，
    // 所以必须等签名确认「真的要推」之后再构造。字段用 `|` 分隔，不会产生歧义碰撞。
    const signature = `${rect.x}|${rect.y}|${rect.width}|${rect.height}|${dragging ? 1 : 0}|${dropIndex}|${memberIndex}|${layout}|${count}`
    if (overlayShown && signature === lastSignature) return
    lastSignature = signature
    const payload = {
      splitId: geo.splitId,
      layout,
      count,
      members: geo.members,
      activeTabId: geo.activeTabId,
      memberIndex,
      // panes 换算成**相对浮层原点**的矩形：浮层要拿它画高亮，而它在自己的坐标系里工作
      panes: geo.panes.map((p) => ({ x: p.x - rect.x, y: p.y - rect.y, width: p.width, height: p.height })),
      dragging,
      dropIndex
    }
    overlayShown = true
    try { showOverlay(rect, payload) } catch (_) {}
  }

  return {
    /** 分屏状态变化后调一次：决定"要不要采样"。幂等，可被高频调用（每次 tab:changed / split:changed）。 */
    sync() {
      // 分屏形态可能已变（换方向 / 重排 / 关掉一格），而光标未必动了 —— 必须让下一拍重算，
      // 否则浮层会停在旧矩形上。invalidate 只是写两个 NaN，幂等且不影响"没有分屏零开销"。
      invalidateTick()
      if (!geometry()) {
        // 分屏消失（解散 / 关掉一格 / 切走）→ 停表 + 收浮层。cancel 本身幂等，
        // 所以"本来就没事"时重复调它也不产生任何原生写入。
        if (enabled || overlayShown) this.cancel()
        else enabled = false
        return { enabled: false }
      }
      if (!enabled) {
        enabled = true
        if (!monitor.running) monitor.start()
      }
      return { enabled: true }
    },

    /**
     * 浮层来的命令（唯一入口，白名单过滤）。
     * @param {{type?: string, action?: string, splitId?: string, x?: number, y?: number, toIndex?: number}} cmd
     */
    command(cmd: ToolbarCommand | null | undefined) {
      const c = cmd || {}
      // 会话切换（拖起 / 松手）/ 动作执行都会改变浮层该显示的形态，而光标可能没动 ——
      // 不失效缓存的话，松手后会一直停在"铺满整片"的拖动态上。
      invalidateTick()
      const geo = geometry()
      if (!geo) { hideNow(); return { ok: false, reason: 'no-split' } }
      if (c.type === 'drag-begin') {
        // 索引优先由浮层报来（"我正显示在哪一格" —— 确定、且不必做坐标换算）：
        // 浮层在自己视图里看到的坐标与主进程的**内容区坐标**不是同一套系，
        // 拿它去 splitPaneAtPoint 会误命中第 0 格。缺省才回退几何命中 / 上次 hover 的格。
        const reported = Number(c.memberIndex)
        let index = Number.isFinite(reported) ? reported : splitPaneAtPoint(geo.panes, { x: Number(c.x), y: Number(c.y) })
        if (!(index >= 0) || index >= geo.members.length) index = lastPaneIndex
        const tabId = index >= 0 ? String(geo.members[index] || '') : ''
        if (!tabId) return { ok: false, reason: 'no-member' }
        dragSession = { splitId: String(geo.splitId), tabId, fromIndex: index }
        dragTargetIndex = index
        // 铺满整片分屏区域：拖动期间用户不会去点网页，所以这一段"挡住网页"是安全的，
        // 换来的是能在自己视图里画目标格高亮（渲染层量不到原生视图的位置）。
        push(unionOfPanes(geo.panes), geo, { dragging: true, dropIndex: index })
        return { ok: true, tabId }
      }
      if (c.type === 'drag-end') {
        const session = dragSession
        dragSession = null
        const toIndex = Number(c.toIndex)
        const target = Number.isFinite(toIndex) ? toIndex : dragTargetIndex
        dragTargetIndex = -1
        lastSignature = ''
        if (!session) { hideNow(); return { ok: false, reason: 'no-session' } }
        const members = Array.isArray(geo.members) ? geo.members.map(String) : []
        const next = moveMemberToIndex(members, session.tabId, target)
        // 位置没变（例如原地松手）→ **不提交**：白排一次会让网页整片重排（用户看到"抖"）
        if (!next) return { ok: true, moved: false }
        const res = runAction('move-member', { splitId: session.splitId, tabId: session.tabId, toIndex: target })
        return { ok: !!(res && res.moved), moved: !!(res && res.moved) }
      }
      if (c.type === 'action') {
        const action = String(c.action || '')
        // 白名单：浮层是独立渲染进程，字符串一律先过集合再执行 —— 不做"猜动作名"的映射。
        if (!TOOLBAR_ACTIONS.has(action)) return { ok: false, reason: 'unknown-action' }
        // 参数按动作给：切方向 / 反转只要组 id；**关闭这一格**要的是那一格的标签 ——
        // 由"指针此刻在哪一格"换算（浮层只报格下标，见 drag-begin 的说明）。
        const members = Array.isArray(geo.members) ? geo.members.map(String) : []
        const idx = lastPaneIndex >= 0 && lastPaneIndex < members.length ? lastPaneIndex : 0
        runAction(action, { splitId: String(geo.splitId), tabId: members[idx] || '', memberIndex: idx })
        return { ok: true, action }
      }
      return { ok: false, reason: 'unknown-command' }
    },

    /** 兜底清理（窗口失焦 / 关闭）：停表 + 收浮层 + 丢弃拖动会话。 */
    cancel(): void {
      dragSession = null
      dragTargetIndex = -1
      enabled = false
      invalidateTick()
      hideNow()
      if (monitor.running) monitor.stop()
    },

    get active() {
      return enabled
    },

    get dragging() {
      return !!dragSession
    },

    /** 供测试直接喂一个采样周期（不必真的起定时器）。 */
    tick(cursor: Point | null | undefined): void {
      handleTick(cursor)
    },

    /**
     * 外部几何源变了但 `sync()` 未必会被调到（典型：**窗口 resize** —— 内容区原点与格矩形
     * 都变了，而分屏形态没变）。宿主在窗口尺寸/位置变化时调一次即可，成本是写两个 NaN。
     */
    invalidate(): void {
      invalidateTick()
    }
  }
}

