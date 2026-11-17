/**
 * find-bar —— 页内查找的**每窗口控制器**（查找栏浮层 + Chromium 查找会话）
 *
 * ── 形态 ─────────────────────────────────────────────────────────────
 * 浮在网页右上角的一枚胶囊（独立原生视图）。网页是原生 `WebContentsView`，天然盖在
 * chrome DOM 之上 —— 所以查找栏必须是独立图层（同建议下拉 / 标签预览），
 * **不占位、不挤网页**；位置由主进程按网页矩形算（见 ipc/layout.js 的 `position:'in-content'`）。
 *
 * ── 职责 ─────────────────────────────────────────────────────────────
 * 它是「Chromium 查找会话」的拥有者：`findInPage / stopFindInPage` 只有主进程能调，
 * 而发起方是浮层 renderer —— 本模块是两者之间的唯一通路。
 *
 * ── 与参考实现逐条对齐（Hira: main/ipc/findBar.js）────────────────────
 *   输入新文本        → `findInPage(text)`（**不传 options**）
 *   回车 / 上 / 下一个 → `findInPage(text, { forward, findNext: false })`
 *   ⚠ Electron 的 `findNext` 不是"找下一个"，而是**"本次请求是否开启一个新的查找会话"**
 *     （默认 `true`）。写反了就是"输入不出计数、非按回车不可"——所以这两条映射逐字照抄。
 *   结果              → `found-in-page` **原样**转发给浮层（含 `finalUpdate`，由浮层决定
 *     数字怎么显示）；**不做 requestId 过滤** —— Hira 只按"是不是当前查找的页面"过滤，
 *     多一层自己的过滤反而会在 requestId 口径不一致时把结果全丢掉。
 *   生命周期          → 主 frame 导航 → **关闭查找栏**；切标签 / 关标签 → 关闭；
 *     清空输入 → 结束会话并清高亮；窗口失焦 → 关闭。
 *     **刻意没有"页面载入完成后自动重跑查找"**：Hira 不做这件事，而它会在每次导航时
 *     凭空发起一次全页扫描（实测 ~400ms）—— 这正是"网页载入与查找互相打架"的来源。
 *
 * ── 两条本地差异（都是明确要求）──────────────────────────────────────
 *   ① 关闭 = 会话彻底结束，页面上**不许再留高亮**：Hira 默认 `keepSelection`，我们走
 *      `clearSelection`，并为"关栏那一刻还压着的那次扫描"排一串跨越其结果窗口的补刀
 *      （见 `scheduleCleanup`）—— 否则它稍后回来会把高亮重新画上。
 *   ② 关栏即忘掉查询串：下次 Ctrl+F 是干净输入框（会话内仍按标签记忆，供 F3 步进）。
 *
 * 解耦：不认识 IPC 通道名（由 ipc/find.js 接线），依赖全部注入 —— 每个窗口一份、互不串扰。
 */

import type { WebContents } from 'electron'
import { onWebContentsDestroyed } from '@hira-ng/infra-window'

interface FindLayoutCoordinatorPort {
  getFloatWebContents(name: string): WebContents | null | undefined
  sendToFloat(name: string, channel: string, payload: unknown): Promise<boolean>
  noteFloatShow(name: string): unknown
  focusFloat(name: string): unknown
  isFloatVisible(name: string): boolean
  hideFloat(name: string): unknown
}

export interface FindBarControllerOptions {
  layoutCoordinator: FindLayoutCoordinatorPort
  getActiveWebContents(): WebContents | null | undefined
  getActiveTabId(): string | null | undefined
  hideFloat?(name: string): void
}

interface CleanupEntry { timers: NodeJS.Timeout[]; restarts: number }
interface FindRequest { text?: unknown; forward?: boolean; findNext?: boolean }

const OVERLAY = 'findbar-overlay'
/**
 * 主进程 → 渲染层的三条事件名。
 *
 * ⚠ 必须与契约（packages/shared-types/src/ipc-channels.mjs 的 `IPC_EVENTS`）**逐字一致**：
 * 渲染层是拿 `IPC_EVENTS.findShow / findFocus / findResult` 去订阅的（通道为
 * `ngipc:event:<route>`），这里写错一个名字，浮层就收不到 show —— 表现是
 * **按 Ctrl+F 什么都没发生**（视图建了、bounds 停在 0×0，因为它永远不上报 display）。
 */
const EVENT_SHOW = 'ngipc:event:find:show'
const EVENT_FOCUS = 'ngipc:event:find:focus'
const EVENT_RESULT = 'ngipc:event:find:result'
/**
 * 收尾清理的**补刀时刻**（ms，相对登记时刻）。
 *
 * 依据：Chromium 首次全页扫描实测 ~425ms —— 关栏那一刻压着的那次查找，最晚大约在
 * 这么久之后才回来，回来时才可能把高亮画上去。所以补刀必须**跨过**这个窗口：
 * 150ms 卡住"立刻回来"的那一批，600ms 卡住"整页扫完才回来"的那一批。
 */
const CLEAN_FOLLOW_UPS = [150, 600]
/**
 * 同一页最多顺延几次 —— `stopFindInPage()` 自己也可能回一条 `found-in-page`，
 * 无上限顺延会变成"清理→事件→清理"的自激。上限把它压成有限次。
 */
const CLEAN_MAX_RESTARTS = 4

/**
 * @param {object} deps
 * @param {object} deps.layoutCoordinator 本窗口的布局协调器（浮层显示 / 落位 / 交还焦点）
 * @param {() => Electron.WebContents|null} deps.getActiveWebContents 当前**聚焦那块网页面**的 wc
 *   （缺省是活动标签；独立侧栏的内容页持焦时是它 —— 见 browser-window-runtime 的 focusedWebContents）
 * @param {() => string|null} deps.getActiveTabId 当前聚焦网页面的**标识**（标签 id 或 `'sidebar'`）。
 *   只用它当"这一页本次会话的查询串"的键 —— 侧栏因此有自己独立的一份，不与标签互相覆盖。
 * @param {(name: string) => void} [deps.hideFloat] 收起浮层（缺省走 layoutCoordinator）
 */
export function createFindBarController(deps: FindBarControllerOptions) {
  const { layoutCoordinator, getActiveWebContents, getActiveTabId, hideFloat } = deps

  /** 查找栏当前是否打开（**主进程是唯一裁定者**：快捷键在它这儿拦，开合由它推给浮层） */
  let barOpen = false
  /** 每个标签本次会话的查询串（关栏清空；用于 F3 这类"焦点在网页上"的步进） */
  const queries = new Map<string, string>()
  /** 已挂过 found-in-page 监听的 webContents（WeakSet 防重复） */
  const bound = new WeakSet<WebContents>()
  /** 最近一次真正发起过查找的那个 wc —— 结束会话时要停的正是它（它可能已不是活动标签） */
  let lastSearched: WebContents | null = null
  /** 「还欠几刀收尾清理」的 webContents（`wcId → { timers, restarts }`），见文件头 ① */
  const pendingCleanup = new Map<number, CleanupEntry>()

  /** 查找栏浮层的 webContents（它住在一条独立原生视图里）。 */
  function overlayWebContents(): WebContents | null {
    try {
      return layoutCoordinator.getFloatWebContents(OVERLAY) || null
    } catch (_) {
      return null
    }
  }

  /**
   * 把一条事件推给查找栏浮层。
   *
   * 首帧（浮层视图还没建出来）走 `sendToFloat`：它会建视图、等 renderer 就绪
   * （did-finish-load）再下发 —— 直接丢消息会让"第一次打开什么都不显示"。
   */
  function send(channel: string, payload: unknown, allowLazyCreate = false): boolean {
    const wc = overlayWebContents()
    if (wc && !wc.isDestroyed()) {
      try { wc.send(channel, payload); return true } catch (_) { return false }
    }
    if (!allowLazyCreate) return false
    try {
      layoutCoordinator.sendToFloat(OVERLAY, channel, payload).catch(() => {})
      return true
    } catch (_) {
      return false
    }
  }

  /** 浮层此刻是否逻辑可见（供窗口装配判定"查找栏正开着"）。 */
  function isVisible(): boolean {
    try { return !!layoutCoordinator.isFloatVisible(OVERLAY) } catch (_) { return false }
  }

  /**
   * 登记 / 顺延一串「收尾清理」。
   * @param {Electron.WebContents} wc
   * @param {boolean} [isRestart] 本次是"又画了高亮"触发的顺延（走次数上限）
   */
  function scheduleCleanup(wc: WebContents | null | undefined, isRestart: boolean = false): void {
    if (!wc || wc.isDestroyed()) return
    const wcId = wc.id
    const prev = pendingCleanup.get(wcId)
    let restarts = 0
    if (prev) {
      // 已在排队：关栏路径会重复登记（find:stop 一次 + find:close 一次），
      // 只有"又画了高亮"这种**新证据**才值得把整串往后推。
      if (!isRestart) return
      // 到顶了就让原来那串按原样跑完 —— 别把它清掉（那才是真的放手不管）。
      if (prev.restarts >= CLEAN_MAX_RESTARTS) return
      for (const t of prev.timers) {
        try { clearTimeout(t) } catch (_) {}
      }
      restarts = prev.restarts + 1
    }
    const timers = CLEAN_FOLLOW_UPS.map((delay, i) => setTimeout(() => {
      // 最后一刀之前不能摘登记：中途冒出来的事件还要能触发顺延。
      if (i === CLEAN_FOLLOW_UPS.length - 1) pendingCleanup.delete(wcId)
      if (wc.isDestroyed()) return
      try { wc.stopFindInPage('clearSelection') } catch (_) {}
    }, delay))
    pendingCleanup.set(wcId, { timers, restarts })
  }

  /** 取消某页排着的收尾清理（该页重新有了在案查找 / 标签被销毁）。 */
  function cancelCleanup(wcId: number): void {
    const entry = pendingCleanup.get(wcId)
    if (!entry) return
    for (const t of entry.timers) {
      try { clearTimeout(t) } catch (_) {}
    }
    pendingCleanup.delete(wcId)
  }

  /**
   * 只挂一次 `found-in-page`，把结果原样转发给浮层。
   *
   * 与 Hira 的差别只有一处：那边判"是不是当前查找的标签"，这边判"栏还开着没有"——
   * 两者等价（切标签会关栏），而后者连"关栏瞬间压着的那次扫描"也一并排除掉。
   */
  function bindFoundInPage(wc: WebContents | null | undefined): void {
    if (!wc || bound.has(wc)) return
    bound.add(wc)
    // 先取 id：webContents 销毁后再读 `wc.id` 是不可靠的（对象已进入销毁流程）
    const wcId = wc.id
    wc.on('found-in-page', (_event, result) => {
      if (!barOpen) {
        // 关栏之后不该再有任何"查找状态"：这条迟到的结果可能刚把高亮画上去 →
        // 顺延一轮补刀（有限次），并且不再刷新计数（界面上已经没有它了）。
        if (pendingCleanup.has(wcId)) scheduleCleanup(wc, true)
        return
      }
      // 同 Hira：只认"带 matches 的结果"，`matches == null` 的一律忽略。
      if (!result || result.matches == null) return
      send(EVENT_RESULT, {
        matches: Number(result.matches) || 0,
        activeMatchOrdinal: Number(result.activeMatchOrdinal) || 0,
        finalUpdate: !!result.finalUpdate
      })
    })
    onWebContentsDestroyed(wc, () => {
      cancelCleanup(wcId)
      if (lastSearched === wc) lastSearched = null
    })
  }

  function isOpen(): boolean {
    return barOpen === true
  }

  /**
   * 发起 / 步进一次查找 —— **全模块唯一碰 `findInPage` 的地方**。
   *
   * 两条路径逐字对齐 Hira（语义见文件头，写反了就是"输入不出计数、非回车不可"）：
   *   - 输入新文本：`findInPage(text)`（不传 options = 开新会话）
   *   - 步进：`findInPage(text, { forward, findNext: false })`（在既有会话里继续）
   * 刻意**不做任何排队/去抖/合并**：Hira 每次输入都直接发，Chromium 内部本就会让
   * 最新的请求胜出。自己加一层"扫描期间攒着"只会让结果慢一拍。
   *
   * @param {{ text?: string, forward?: boolean, findNext?: boolean }} req `findNext:true` = 步进
   * @returns {boolean} 是否真的受理了（栏没开 / 没文本 / 没页面 = 不受理）
   */
  function query(req: FindRequest = {}): boolean {
    const text = String(req.text == null ? '' : req.text)
    if (!text) return false
    // 栏关着就没有"这次查找"可言：IPC 是异步的，用户清空输入 / 按 Esc 之后仍可能有
    // 一条 `find:query` 在路上 —— 放它进来就会在页面上凭空重开一次搜索（亮起高光，
    // 而界面上已经没有查找栏能把它关掉）。
    if (!barOpen) return false
    const wc = getActiveWebContents()
    if (!wc || wc.isDestroyed()) return false
    const tabId = getActiveTabId() ? String(getActiveTabId()) : ''
    bindFoundInPage(wc)
    // ⚠ 先撤销这一页还排着的「收尾补刀」再发起检索。顺序反了会有个致命的时序：
    // 上一次会话（关栏 / 清空输入）留下的补刀还没打完，用户已经敲下新字符 —— 那一刀
    // 落在 150/600ms 后会把这个**刚发起**的检索连同高亮一起抹掉，表现正是
    // "输入了却不出结果"。放在 findInPage 之前，抛错时也已撤销。
    cancelCleanup(wc.id)
    try {
      if (req.findNext) wc.findInPage(text, { forward: req.forward !== false, findNext: false })
      else wc.findInPage(text)
      lastSearched = wc
      if (tabId) queries.set(tabId, text)
      return true
    } catch (_) {
      return false
    }
  }

  /**
   * 步进到上/下一个匹配（F3 / Shift+F3，即"焦点在网页上"时的步进）。
   *
   * 用**本标签记住的查询串**：走到这里说明键盘焦点在网页上（在查找栏里时由浮层
   * 自己处理，键根本到不了主进程），而主进程手里唯一知道"上次在找什么"的地方
   * 就是这张按标签的记忆表。
   * @param {boolean} forward
   * @returns {boolean} 是否真的发出去了（没有查询串 = 没发）
   */
  function step(forward: unknown): boolean {
    // 栏关着就没有"下一个匹配"这回事：**关闭 = 查找状态彻底结束**。
    // 不挡这一下，用户关掉查找栏后按 F3 会在页面上凭空点亮一片高亮，
    // 而屏幕上没有任何 UI 在解释它（"关了却还在查找状态"就是这么来的）。
    if (!barOpen) return false
    const tabId = getActiveTabId() ? String(getActiveTabId()) : ''
    const text = tabId ? (queries.get(tabId) || '') : ''
    if (!text) return false
    return query({ text, forward: !!forward, findNext: true })
  }

  /**
   * 结束查找（清高亮 / 保留高亮）。
   *
   * ⚠ **前置闸**：本窗口压根没查找过（栏没开过、也没搜过）时**直接返回**。
   * 为什么必须加：`close()` 是**每次主框架导航**都会调的（`browser-window-runtime`
   * 在 did-start-navigation 与 did-navigate 各收一次），而它无条件走到下面那三件事 ——
   * `wc.stopFindInPage()` + `scheduleCleanup()` 排的两个补刀定时器，
   * 于是**从没按过 Ctrl+F 的用户，每导航一次也要付两轮原生调用 + 两个定时器**。
   * 这是纯粹的浪费（导航是最高频的路径之一）。
   *
   * @param {'clearSelection'|'keepSelection'|'activateSelection'} [action]
   */
  function stop(action: 'clearSelection' | 'keepSelection' | 'activateSelection' = 'clearSelection'): void {
    // 没有任何查找痕迹 → 无所可停（栏没开、且从没搜过）。
    if (!barOpen && !lastSearched) return
    const wc = lastSearched && !lastSearched.isDestroyed() ? lastSearched : getActiveWebContents()
    if (wc && !wc.isDestroyed()) {
      try { wc.stopFindInPage(action) } catch (_) {}
      // clearSelection = "这一页不该再有任何高亮" → 再排一串收尾。只清一次不够：
      // 停的这一刻可能还压着一次没扫完的请求，它的结果稍后才到、到了会把高亮重新画上。
      if (action === 'clearSelection') scheduleCleanup(wc)
    }
    lastSearched = null
  }

  /**
   * 打开查找栏（Ctrl+F）。
   * 幂等：已经开着就只把焦点要回来（Chrome 同款：连按 Ctrl+F 只是重新聚焦输入框）。
   */
  function open() {
    try {
      if (!getActiveWebContents()) return { open: false }
      const tabId = getActiveTabId() ? String(getActiveTabId()) : ''
      const query0 = tabId ? (queries.get(tabId) || '') : ''
      barOpen = true
      // 先登记「请求显示」（逻辑可见态 + 代际）：`display` 那条通道有一道可见性闸门，
      // 不先声明，浮层 renderer 报上来的尺寸会被直接丢掉 —— 表现就是"永远不显示"。
      layoutCoordinator.noteFloatShow(OVERLAY)
      // show 事件经 sendToFloat 下发：它会**惰性建视图**（同步完成：视图对象立刻就在
      // 浮层表里），并等 renderer 就绪后再把事件发出去 —— 首帧不会打在空白页上。
      //
      // ⚠ 这里**刻意不 await**：await 会把「聚焦」拖到页面加载完成之后才起步，而
      // 焦点要过来本来就得分几拍（浮层是独立进程，`wc.focus()` 会被它的加载/抢焦覆盖）。
      // 不等它 → 聚焦重试与页面加载**并行**跑，首次打开少等一截。
      try {
        layoutCoordinator.sendToFloat(OVERLAY, EVENT_SHOW, { query: query0 }).catch(() => {})
      } catch (_) {}
      // 键盘焦点交给浮层（它自己持焦，见 LayoutCoordinator#SELF_FOCUS_FLOATS）
      layoutCoordinator.focusFloat(OVERLAY)
      return { open: true }
    } catch (e) {
      console.warn('[find] open failed:', e instanceof Error ? e.message : String(e))
      return { open: false }
    }
  }

  /** 收起查找栏（并结束查找会话）。 */
  function close() {
    stop('clearSelection')
    if (!barOpen) return { open: false }
    barOpen = false
    // 关栏 = **这次查找彻底结束**，连着把"上次查了什么"也忘掉：下次 Ctrl+F 打开就是
    // 一个干净的输入框（会话内记忆的用途只剩 F3 步进，而步进同样要求栏开着）。
    queries.clear()
    // 逻辑收起 + 交还键盘焦点（hideFloat 内部会 setFloatInteractive(false)，
    // 并因浮层进入 HIDE_FOCUS_REALLOC_FLOATS 而把焦点交还给可见图层里的最优先者 = 网页）。
    if (typeof hideFloat === 'function') hideFloat(OVERLAY)
    else layoutCoordinator.hideFloat(OVERLAY)
    return { open: false }
  }

  function toggle() {
    // 已开着 = **重新聚焦输入框**（Chrome 同款：连按 Ctrl+F 不会把栏关掉），
    // 关栏只有 Esc / ✕ 两条路（它们从浮层走 find:close）。
    if (isOpen()) {
      // 浮层可能已被"别的路径"逻辑收起（barOpen 还停在 true）—— 这时光发一条 show
      // 会被 `display` 的可见性闸门丢掉（页面上什么都不会出现，用户看到的是"按了没反应"）。
      // 只有确认它此刻**在逻辑可见态**，才走"轻量重新聚焦"这条快路。
      if (isVisible()) {
        send(EVENT_FOCUS, {})
        layoutCoordinator.focusFloat(OVERLAY)
        return { open: true }
      }
    }
    return open()
  }

  return {
    open,
    close,
    toggle,
    isOpen,
    isVisible,
    query,
    step,
    stop,
    /** 标签关闭：它的查询记忆一起走（否则 tabId 复用时会"继承"上一个标签的搜索词） */
    forgetTab(tabId: string) {
      queries.delete(String(tabId))
    }
  }
}

