/**
 * TabDropZone —— 「拖标签到网页区域」的**落位预览**（主进程侧）。
 *
 * ── 它解决什么（对照 Zen / Vivaldi，见 docs/tab-drop-zone-design.md）─────────
 * 拖动标签到内容区时，用户需要**在松手之前**就看到"这个标签会落在哪一边、是左右排还是上下排"。
 * 本模块做那一件事：拖动期间按 30fps 采样光标 → 问纯规则（`shared-types#resolveDropZone`）
 * → 把"新格将要占用的那一块矩形 + 形态"推给预览浮层；松手时把**最后一次算出来的意图**
 * 原样交出去（于是"看到什么"与"得到什么"是同一份数据 —— 所见即所得）。
 *
 * ── 为什么预览必须走独立浮层（而不是画在外壳 DOM 里）─────────────────────────
 * 网页是原生 `WebContentsView`，外壳（chrome）天然位于所有子视图**之下** —— DOM 里画不出
 * 任何压得住网页的东西。所以"浮在网页上的一块"只能是一层独立浮层视图，由主进程按精确
 * 矩形摆放（与查找栏 / 悬停 URL / 缩放条同族，见 ipc/layout.js#FLOAT_NAMES）。
 *
 * ── 为什么采样本模块自己起、而不是复用跨窗口那条链 ────────────────────────
 * `tab-drag-controller` 也用了 `CursorEdgeMonitor`，但它服务于**跨窗口迁移**，
 * 而它至今未在渲染层接线（全仓无调用方）。这里不把两件事塞进一个控制器：
 * 谁先接线谁起表，同时接线时也只是两条 30fps 定时器（拖动期才有），代价可忽略。
 *
 * ── 彻底解耦 ────────────────────────────────────────────────────────────
 * 本文件**不 require electron**、不认识 TabManager / LayoutCoordinator / 任何窗口：
 * 光标、矩形、配对目标、浮层读写全部由宿主注入。因此可 headless 单测、可换实现。
 *
 * 宿主注入（deps）：
 *   getCursorPoint()   → {x,y}|null                屏幕坐标（DIP）
 *   getContentOrigin() → {x,y}|null                窗口内容区左上角的**屏幕坐标**（换算用）
 *   getPageRect()      → {x,y,w,h}|null            网页矩形（**内容区坐标**）
 *   describePair(info) → { pairId, mode, count, maxPanes }
 *        info = { dragId, baseId }；mode ∈ 'split'（两格新建）| 'join'（并入已有组）
 *        | 'blocked'（那一组已满）；pairId 为 null 表示**没有可配对的对象**（只有一个标签）。
 *        这条是"标签世界"的知识，只有宿主知道，所以由它回答。
 *   showOverlay(rect, payload) / hideOverlay()      预览浮层的读写（矩形 = 预览块本身）
 *   onPreviewShown(info) / onPreviewHidden(info)    **预览显 / 隐**（边沿触发，见下）
 *        info = { tabId, baseTabId, pairId }。它回答的是另一件事：**内容区此刻该显示哪一格**。
 *        框画着 = 显示 `pairId`（用户要看着"即将与谁分屏"的那一页来判断落点），
 *        框收起了 = 回到 `tabId`（拖动一开始就切过去了，Edge / Chrome 同口径）。
 *        切哪一格是标签世界的知识 —— 本模块只通报边沿，由宿主去切。
 *        ⚠ 整场结束（`end()` / `cancel()`）**不通报收起**：松手之后归谁由提交侧决定
 *        （`dropTabOnContent` 建的组以配对那格为活动格），多通报一次会在同一拍里白切两趟。
 *   onSessionChange(active)                         **整场拖动的起 / 止**（边沿触发）
 *        真 = 有一场拖动在进行；假 = 整场已归档（松手 / 兜底取消 / 出窗自愈）。
 *        ⚠ 它与"预览显隐"是两件事：那是"框画着没画着"（拖动中途会来回翻），这是"手还按着没按着"。
 *        宿主拿它**冻结侧栏唤出**（拖拽源视图不许在拖动中被收起），见 LayoutCoordinator#setSideRevealHold。
 *   getWindowRect()    → {x,y,width,height}|null    窗口内容区（**屏幕坐标**）——出窗自愈用
 *   abandonMs                                       出窗多久算"拖动已死"（默认 {@link DRAG_ABANDON_MS}）
 *
 * ## 生命周期
 *   begin({ tabId, baseTabId })  渲染层 dragstart → 起表
 *   end()                        渲染层 dragend  → 停表 + 收浮层 + 返回最后一次意图（或 null）
 *   cancel()                     兜底（窗口失焦 / 拖动被取消 / 出窗自愈）
 */

import { createCursorEdgeMonitor } from '@hira-ng/infra-window'
import { resolveDropZone } from '@hira-ng/shared-types/src/split-layout.mjs'

interface Point { x: number; y: number }
interface Rect extends Point { width: number; height: number }
interface DropSession { tabId: string; baseTabId: string; pairId: string; sourceWcId: number | null }
interface DropPairInfo { dragId: string; baseId: string }
interface DropPair {
  pairId: string | null
  mode?: 'split' | 'join' | 'blocked'
  count?: number
  maxPanes?: number
}
interface DropPreviewInfo { tabId: string; baseTabId: string; pairId: string }
interface DropIntent extends DropPreviewInfo {
  mode?: string
  zone?: string | null
  layout?: unknown
  place?: unknown
  members?: unknown
}
interface DropBeginInput { tabId?: unknown; baseTabId?: unknown; sourceWcId?: unknown }
interface DropCancelOptions { silent?: boolean }
interface DropHideOptions { silent?: boolean; info?: DropPreviewInfo | null }
interface CursorMonitorPort { readonly running: boolean; start(): void; stop(): void }

export interface TabDropZoneDependencies {
  getCursorPoint?(): Point | null
  getContentOrigin?(): Point | null
  getPageRect?(): Rect | null
  isOverOverlay?(point: Point): boolean
  previewDelayMs?: number
  now?(): number
  describePair?(info: DropPairInfo): DropPair | null
  showOverlay?(rect: Rect, payload: Record<string, unknown>): void
  hideOverlay?(): void
  onPreviewShown?(info: DropPreviewInfo | null): void
  onPreviewHidden?(info: DropPreviewInfo | null): void
  onSessionChange?(active: boolean, detail: { sourceWcId: number | null }): void
  getWindowRect?(): Rect | null
  abandonMs?: number
  pollMs?: number
}

/**
 * 预览的**停留门禁**（ms）：光标进网页后要先停这么久，预览块才浮出。
 *
 * 为什么需要：拖动标签时常常扫过网页（或从标签浮层里出来时掠过网页），立刻浮出预览既闪眼、
 * 又让人以为"已经决定要分屏"。250ms 与"标签预览窗口 700ms / rail 悬停 1000ms"同一族口径
 *（越贵的动作要求停得越久），同时短到不会让人觉得卡。
 */
const PREVIEW_DELAY_MS = 250

/**
 * **出窗自愈**的宽限（ms）：指针在窗口外持续这么久，就判定这场拖动已经被系统放弃。
 *
 * 为什么需要：`dragend` 不是必然到达的。窗口失焦那条兜底（browser-window-assembly 的
 * `blur` → `cancel()`）盖不住全部情形 —— 同一应用内切到另一窗口、或拖拽源视图被系统回收，
 * 都可能让 `dragend` 静默丢掉。丢掉的下场是**整场黏住**：采样表不停、落位框浮着、
 * 活动标签停在配对那一格。这里用一条纯时间判据兜住：出窗 600ms 还没回来 = 手早就松了。
 * 拖出去又回来（< 600ms）不受影响 —— 那时拖动还活着，不该打断。
 */
const DRAG_ABANDON_MS = 600

export function createTabDropZone(deps: TabDropZoneDependencies = {}) {
  const getCursorPoint = typeof deps.getCursorPoint === 'function' ? deps.getCursorPoint : () => null
  const getContentOrigin = typeof deps.getContentOrigin === 'function' ? deps.getContentOrigin : () => null
  const getPageRect = typeof deps.getPageRect === 'function' ? deps.getPageRect : () => null
  /**
   * 光标（内容区坐标）是否落在**别的浮层**里。浮层盖在网页之上，那块**不属于网页**：
   * rail 收起态悬停展开的标签列浮层里正常拖动标签时，光标几何上落在网页矩形内，
   * 不排除就会误判成"拖到网页上"（闪出分屏预览、松手真的分屏）。
   */
  const isOverOverlay = typeof deps.isOverOverlay === 'function' ? deps.isOverOverlay : () => false
  /**
   * 预览停留门禁（可注入）：默认 {@link PREVIEW_DELAY_MS}。
   * 允许注入是为了**可测**：验证脚本要断言"第一拍就推出预览"这类几何行为，
   * 传 0 即可跳过计时（不然每个用例都得假装睡 250ms）。
   */
  const previewDelayMs = Number.isFinite(deps.previewDelayMs) ? Math.max(0, Number(deps.previewDelayMs)) : PREVIEW_DELAY_MS
  /** 时钟（可注入）：停留门禁要读时间戳，注入时钟才能**同步**验"停够没停够"。 */
  const now = typeof deps.now === 'function' ? deps.now : () => Date.now()
  const describePair = typeof deps.describePair === 'function' ? deps.describePair : () => null
  const showOverlay = typeof deps.showOverlay === 'function' ? deps.showOverlay : () => {}
  const hideOverlay = typeof deps.hideOverlay === 'function' ? deps.hideOverlay : () => {}
  /**
   * 预览显 / 隐的两条通报（可选注入）—— 见文件头 deps 里那一段。
   * 缺省空实现：不接线时本模块的行为与加这两条之前**一字不差**。
   */
  const onPreviewShown = typeof deps.onPreviewShown === 'function' ? deps.onPreviewShown : () => {}
  const onPreviewHidden = typeof deps.onPreviewHidden === 'function' ? deps.onPreviewHidden : () => {}
  /**
   * 整场拖动的起 / 止（可选注入，缺省空实现）—— 见文件头 deps 说明。
   * 宿主用它冻结侧栏唤出：拖动中**不许**收起拖拽源所在的视图。
   */
  const onSessionChange = typeof deps.onSessionChange === 'function' ? deps.onSessionChange : () => {}
  /** 窗口内容区（屏幕坐标）—— 出窗自愈的唯一输入。缺省 null = 该判据不启用。 */
  const getWindowRect = typeof deps.getWindowRect === 'function' ? deps.getWindowRect : () => null
  const abandonMs = Number.isFinite(deps.abandonMs)
    ? Math.max(0, Number(deps.abandonMs))
    : DRAG_ABANDON_MS

  /** 当前拖动：{ tabId, baseTabId } | null */
  let session: DropSession | null = null
  /**
   * 最后一次算出的**意图** —— 它就是"用户此刻看到的那一块"。
   * `end()` 把它交出去，因此提交结果与预览必然是同一份数据（D3 所见即所得）。
   */
  let intent: DropIntent | null = null
  /** 浮层当前是否可见（省掉无意义的原生 bounds 写入 / IPC）。 */
  let overlayShown = false
  /** 上次推给浮层的载荷签名（矩形 + 形态）—— 只在真的变了才推。 */
  let lastSignature = ''
  /**
   * **本轮"光标在网页上且能落"的起始时刻**（0 = 尚未开始计时）。
   *
   * 它是预览的**停留门禁**：拖动时扫过网页（或从浮层里出来经过网页）不该闪出预览块，
   * 只有真的停住 250ms 才浮出 —— 见 PREVIEW_DELAY_MS 与 `present()` 的说明。
   * 离开有效状态（离开网页 / 进了浮层 / 没有配对对象）即清零，于是"再进来"要重新计时。
   */
  let dwellSince = 0
  /**
   * 预览显 / 隐的**当前通报态**（真 = 已经报过"画出来了"）。
   *
   * 边沿触发：拖动期间每秒 30 拍里绝大多数都是同一个状态，`present()` 也会被反复调用 ——
   * 只在**真的翻转**那一拍通报一次，宿主那侧就天然是"切一次、切回来一次"。
   * `cancel()` 里会把它归零：那是"整场归档"，下一轮必须从"没通报过"重新开始。
   */
  let previewNotified = false
  /** 整场拖动的当前通报态（边沿触发，见 onSessionChange）。 */
  let sessionNotified = false
  /**
   * 指针**在窗口外**的起始时刻（0 = 在窗内 / 没在计时）—— 出窗自愈的记账。
   * 用时间戳而不是 setTimeout：采样每 33ms 一拍，时间戳判据天然幂等、停表时也不用清理。
   */
  let outsideSince = 0

  const monitor = createCursorEdgeMonitor({
    getCursorPoint,
    // 边缘唤出与本模块无关：始终返回 null，让边缘分支空转。
    getFocusedWindow: () => null,
    onEdge: () => {},
    onTick: handleTick,
    pollMs: deps.pollMs
  }) as CursorMonitorPort

  /** 本轮会话的快照（通报用）。本模块不认识标签世界，只搬运它收到的三个 id。 */
  function sessionInfo(): DropPreviewInfo | null {
    return session ? { tabId: session.tabId, baseTabId: session.baseTabId, pairId: session.pairId || '' } : null
  }

  /**
   * 通报"落位框画出来了 / 收起来了"（边沿触发，见 previewNotified）。
   *
   * @param {boolean} shown
   * @param {object|null|undefined} info 显式指定会话（`cancel()` 里 session 已先清空，见那里）；
   *   `undefined` = 取当前会话。
   */
  function notifyPreview(shown: boolean, info?: DropPreviewInfo | null): void {
    if (previewNotified === shown) return
    previewNotified = shown
    const payload = info === undefined ? sessionInfo() : info
    try {
      if (shown) onPreviewShown(payload)
      else onPreviewHidden(payload)
    } catch (_) {}
  }

  /**
   * 通报"整场拖动起 / 止"（边沿触发，见 onSessionChange）。
   *
   * 它比预览显隐更粗一层：一场拖动里框会来回画 / 收，而"手还按着"只翻一次真、一次假。
   * 宿主据此冻结侧栏唤出（拖动中不许收起拖拽源视图）—— 收早了 `dragend` 就丢了。
   *
   * 载荷带 `sourceWcId`（拖动**发起视图**的 webContents id）：只在开始那一拍有意义 ——
   * 宿主按它判断"唤出浮层是不是赶在拖拽前一瞬间才冒出来的"，把那次误展开撤回
   * （否则松手落在浮层这个另一个视图上，会被当成外部拖入 → 复制出一个新标签页）。
   * @param {boolean} active
   */
  function notifySession(active: boolean): void {
    if (sessionNotified === active) return
    sessionNotified = active
    try { onSessionChange(active, { sourceWcId: session ? session.sourceWcId : null }) } catch (_) {}
  }

  /**
   * 整场归档 —— **唯一收尾**（`end()` / `cancel()` / 出窗自愈都走这里）。
   *
   * @param {{silent?: boolean}} [opts]
   *   `silent` = 只收浮层、不通报名下这一场（松手那条路，见文件头 deps 说明）。
   */
  function cancelSession(opts: DropCancelOptions = {}): void {
    const silent = !!(opts && opts.silent)
    // 先取快照再清 session：通报要用它，而 session 已经归零了（见 sessionInfo）。
    const info = sessionInfo()
    session = null
    intent = null
    // 停留计时也归零：下一次拖动要从"刚进网页"重新算，不能白捡上一轮的时间
    dwellSince = 0
    outsideSince = 0
    hideNow({ silent, info })
    // 整场归档：通报态归零，下一轮必须从"没通报过"重新开始（silent 那条路不会自己复位）。
    previewNotified = false
    if (monitor.running) monitor.stop()
    // 最后才松开"侧栏唤出保持"：先收起预览、切回被拖那一格，再让侧栏恢复自主
    //（反过来的话，侧栏会在预览还没收的那一拍里先塌掉）。
    notifySession(false)
  }

  /**
   * 出窗自愈：指针在窗口外持续超过 `abandonMs` → 判定这场拖动已被系统放弃，按兜底取消。
   *
   * 返回 true = 本拍已归档，不必再判任何落点。
   * @param {{x:number,y:number}} cursor 屏幕坐标
   */
  function trackWindowExit(cursor: Point | null | undefined): boolean {
    const win = getWindowRect()
    if (!win || !cursor) { outsideSince = 0; return false }
    const outside = cursor.x < win.x || cursor.y < win.y ||
      cursor.x > win.x + win.width || cursor.y > win.y + win.height
    if (!outside) { outsideSince = 0; return false }
    if (!outsideSince) { outsideSince = now(); return false }
    if (now() - outsideSince < abandonMs) return false
    cancelSession()
    return true
  }

  /**
   * @param {{silent?: boolean, info?: object|null}} [opts]
   *   `silent` = 只收浮层、不通报名下这一场（整场结束那两条路，见文件头 deps 说明）。
   */
  function hideNow(opts: DropHideOptions = {}): void {
    if (!overlayShown) return
    overlayShown = false
    lastSignature = ''
    try { hideOverlay() } catch (_) {}
    if (!opts.silent) notifyPreview(false, opts.info)
  }

  /**
   * 「这一拍没有合法落点」的统一收尾：清停留计时 + 收预览 + 丢掉意图。
   *
   * 三件事必须一起做 —— 只收预览不清计时，会让"扫过网页"攒下的时间算进下一次停留；
   * 只清计时不丢意图，会在没有预览的情况下仍然分屏（与"所见即所得"相反）。
   */
  function invalid(): void {
    dwellSince = 0
    intent = null
    hideNow()
  }

  /**
   * 一个采样周期的全部判定。
   *
   * 顺序刻意如此：**先取事实，再判"能不能落"，最后才算几何** ——
   * 没有配对对象（只有一个标签）时不该画任何块（D5：画了就是骗人）。
   */
  function handleTick(cursor: Point | null | undefined): void {
    if (!session) return
    // 出窗太久 = 这场拖动已经被系统放弃（`dragend` 丢了）→ 自愈归档，本拍不再判落点
    if (trackWindowExit(cursor)) return
    const page = getPageRect()
    const origin = getContentOrigin()
    if (!page || !origin || !cursor) { invalid(); return }

    const local = { x: Number(cursor.x) - Number(origin.x || 0), y: Number(cursor.y) - Number(origin.y || 0) }
    const inside = local.x >= page.x && local.x <= page.x + page.width &&
      local.y >= page.y && local.y <= page.y + page.height
    if (!inside) { invalid(); return }
    // 浮层盖住的那一块**不属于网页**：在浮层里正常范围拖动标签 ≠ 拖到网页上（见 isOverOverlay）
    if (isOverOverlay(local)) { invalid(); return }

    // 走到这里 = 光标真的停在网页上：开始（或继续）计时 —— 预览要停够 PREVIEW_DELAY_MS 才浮出
    if (!dwellSince) dwellSince = now()

    // ── 配对对象（宿主回答：谁是另一格、那一格在不在分屏里、满没满）──
    const pair = describePair({ dragId: session.tabId, baseId: session.baseTabId }) || null
    const pairId = pair && pair.pairId != null ? String(pair.pairId) : ''
    if (!pair || !pairId) { invalid(); return }
    // 记进会话：预览显隐通报要把"和谁配对"一起带出去（见文件头 deps 的 onPreviewShown）。
    // 每拍重写同一个值 —— pairId 在一场拖动里不随光标变（只取决于被拖的与拖前的两个 id）。
    session.pairId = pairId
    const mode = pair.mode === 'join' || pair.mode === 'blocked' ? pair.mode : 'split'

    // ── 几何：只有 'split' 才需要方向；join / blocked 的意义不在"哪一半"
    //    （那一格已经在分屏里 / 已经满了），所以整片内容区给反馈就够。 ──
    if (mode !== 'split') {
      const payload = mode === 'blocked'
        ? { mode, maxPanes: pair.maxPanes }
        : { mode, count: pair.count }
      const signature = `${mode}|${pair.count || 0}|${pair.maxPanes || 0}|${page.x},${page.y},${page.width},${page.height}`
      present(page, payload, signature)
      // ⚠ **意图只在"框真的画着"时才记**（见 present 的停留门禁）：没画框 = 用户没看到这一下
      //   ⇒ 松手什么也不做。用户口径："等落位框显示才能开始判定，他们是一起的。"
      intent = overlayShown
        ? { tabId: session.tabId, baseTabId: session.baseTabId, pairId, mode, zone: null, layout: null, place: null, members: null }
        : null
      return
    }

    const zone = resolveDropZone({ x: local.x, y: local.y, rect: page })
    if (!zone) { invalid(); return }
    const payload = { mode: 'split', zone: zone.zone, layout: zone.layout }
    const signature = `split|${zone.zone}|${zone.layout}|${zone.rect.x},${zone.rect.y},${zone.rect.width},${zone.rect.height}`
    present(zone.rect, payload, signature)
    // 只交**落点区**（不预先换算成员顺序）：顺序的换算留在提交那一处
    //（见 shared-types#splitMembersForDrop 的说明）—— 一件事只有一个换算点，就不会两处漂移。
    // ⚠ 同上面那条：框没画出来就不记意图 —— 否则"拖过去、没等框、松手"照样会分屏，
    //   那正是"不是等落位框显示就分屏"的来源（用户实测过）。
    intent = overlayShown
      ? {
          tabId: session.tabId,
          baseTabId: session.baseTabId,
          pairId,
          mode: 'split',
          zone: zone.zone
        }
      : null
  }

  /**
   * 把"这一块"推给浮层。
   *
   * 两条去重各自独立：**几何没变就不动原生 bounds**（setBounds 会走一趟原生 + 重画），
   * **形态没变就不发 IPC**。拖动期间每秒 30 次采样里绝大多数都是同一个状态，
   * 去重之后真正的写入只剩"跨过中线"那几次。
   */
  function present(rect: Rect, payload: Record<string, unknown>, signature: string): void {
    /**
     * **停留门禁**：光标进网页后的头 PREVIEW_DELAY_MS 里**不显示**预览。
     *
     * 为什么要有：拖动标签时常常会扫过网页（或从标签浮层里出来时掠过网页），
     * 立刻浮出预览块既闪眼、又让人以为"已经决定要分屏了"。停住一会儿才浮出，
     * 与 Zen / Vivaldi 的手感一致。
     *
     * ⚠ 它挡的不只是"显示"，**`intent` 也只在框真的画着时才记**（见调用处的
     * `intent = overlayShown ? … : null`）—— 用户口径："**等落位框显示才能开始判定，
     * 他们是一起的**"。曾经这里写着"只挡显示、不挡 intent（快速拖过去松手仍要能分屏）"，
     * 结果就是"没等框出现、拖过去一松手就分屏"（用户实测反复报过）。现在两者绑成一件事：
     * 框没画出来 = 这一下不算数，松手什么都不发生。
     */
    if (!dwellSince || now() - dwellSince < previewDelayMs) { hideNow(); return }
    if (!overlayShown) {
      overlayShown = true
      try { showOverlay(rect, payload) } catch (_) {}
      lastSignature = signature
      // 框画出来了 —— 通报宿主把内容区切到**配对那一格**（见文件头 deps 的说明）。
      // 位置在 showOverlay 之后：先让框真的出现，再动内容区，两者是同一拍、无中间帧。
      notifyPreview(true)
      return
    }
    if (signature === lastSignature) return
    lastSignature = signature
    try { showOverlay(rect, payload) } catch (_) {}
  }

  return {
    /**
     * 开始一次拖动（渲染层 dragstart）。
     * 幂等：上一次没收尾的先清掉 —— `dragend` 在某些平台会丢（例如拖出窗口后原地松手），
     * 不清就会留下一条永远在跑的表 + 一块永远挂着的预览。
     */
    begin(info: DropBeginInput = {}) {
      const tabId = info.tabId == null ? '' : String(info.tabId)
      if (!tabId) return { ok: false, error: 'tabId is required' }
      // 上一轮的残局**静默**清掉：渲染层在调 begin 之前刚把活动标签切到新被拖的那个，
      // 这里再通报一次"上一场的框收起了"只会凭空多切一趟标签（且切的是上一场那个）。
      cancelSession({ silent: true })
      session = {
        tabId,
        baseTabId: info.baseTabId == null ? '' : String(info.baseTabId),
        pairId: '',
        // 拖动发起视图（见 notifySession）：只作为"谁在拖"这一条事实搬运给宿主。
        sourceWcId: Number.isFinite(info.sourceWcId) ? Number(info.sourceWcId) : null
      }
      outsideSince = 0
      if (!monitor.running) monitor.start()
      // **起表之后再通报**：宿主收到"拖动开始"就去冻结侧栏唤出，
      // 而本模块从这一拍起才真的会读光标 —— 顺序反了会在冻结前先空跑一拍判据。
      notifySession(true)
      return { ok: true }
    },

    /**
     * 结束拖动并交出**最后一次意图**（渲染层 dragend）。
     * 返回 null = 这次拖动没有任何合法落点（松手点不在网页上 / 没有配对对象）。
     *
     * **静默收尾**：松手之后的归属由提交侧决定（`dropTabOnContent` 建的组以配对那格为活动格），
     * 这里再通报一次"框收起了 → 切回被拖的那个"会在同一拍里白切两趟（见文件头 deps 说明）。
     */
    end(): DropIntent | null {
      const out = intent
      cancelSession({ silent: true })
      return out
    },

    /**
     * 兜底清理（窗口失焦 / 窗口关闭 / 拖动被取消 / 出窗自愈）：停表 + 收浮层 + 丢弃意图。
     *
     * 这一条**不是**整场结束（松手没发生，没有提交侧接手），所以框收起了要照常通报 ——
     * 把内容区切回被拖的那一格，否则会停在配对那一格上、与"标签条高亮的还是被拖的"不一致。
     *
     * @param {{silent?: boolean}} [opts]
     */
    cancel(opts: DropCancelOptions = {}): void {
      cancelSession(opts)
    },

    get active() {
      return !!session
    },

    /** 此刻的意图（测试与调试用；正常提交走 `end()`）。 */
    get intent() {
      return intent
    },

    /** 供测试直接喂一个采样周期（不必真的起定时器）。 */
    tick(cursor: Point | null | undefined): void {
      handleTick(cursor)
    }
  }
}

