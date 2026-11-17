/**
 * 标签 / 行的 **hover 预览状态机** —— 横向标签条与纵向列表**共用的一份**。
 *
 * 两边的规则本来就该一模一样，此前却各写一份（`ui-tabbar/components/TabPreview.js` 与
 * `tabRowList` 内部），连 700 / 320 / 120 三个常量都各抄一遍 —— 于是"改一处、另一处不动"
 * 是迟早的事。规则本身只有七条：
 *   ① 预览是**列表级**的：计时起点是「进入列表」，跨项只换内容、不重新计时
 *      （项与项之间有缝，鼠标巡视必然跨项；每次清零就永远弹不出来）；
 *   ② 预览已可见时换项**立即**生效（不重播入场、不重新计时）—— 否则横扫会变成一串"弹一下、弹一下"；
 *   ③ 刚收起后的 REARM 窗口内再进入 → 视为**同一轮巡视**，立即补显，不重新计满延迟；
 *   ④ 指针仍在列表内、但不在任何项上（项间缝隙 / 空白）→ 延迟 ABSENT 收起，期间回到项上即取消；
 *      指针离开列表视图 → **立即**收起。
 *   ⑤ **指针按下**（捕获相）落点在当前项以外 → **立即**收起（需调用方注入 `document`）。
 *      为什么单列一条：上面四条全靠 mouseout / mouseover，而"光标停在某项上、再点别处"
 *      **不产生任何 mouseout** —— 预览会一直挂在那儿（实测最常被报的"卡着关不掉"）。
 *      按下是最早、最不可能丢的指针信号（捕获相先于任何业务监听拿到），因此用它兜底。
 *      只有真的注入了 `document` 才挂这条监听 —— 本模块不认 DOM，宿主由调用方给。
 *   ⑥ **锚点项消失** → 立即收起，并且**锁到指针真的动过为止**（`invalidate()`）。
 *      项被移除（关标签 / 取消固定 / 列表清空）时，相邻项会在**指针没动**的情况下
 *      滑到指针底下：Chromium 会为此补发一次 mouseover，而那时规则 ②③ 会让预览
 *      **立刻重新弹出**（用户看到的就是"关掉这个标签，预览还卡着"）。所以这一条
 *      既收起、又拒绝"没动就补显"的 enter。
 *      另外它带一条**存活巡检**：预览在台上时每 200ms 看一眼锚点还在不在文档里 ——
 *      宿主忘了报、或行被别的路径整批换掉时，预览也不会永久挂着。
 *   ⑦ **右键菜单 / 拖拽暂停**：这两种交互里操作焦点已经不在 hover 项上，补发的
 *      mouseover 不能重新起表。`suspend()` 立即收起并拒绝 enter，`resume()` 后还要求
 *      指针真实移动过才恢复，避免菜单关闭 / 拖拽收尾时被合成事件拉回来。
 *
 * 本模块只管「状态 + 计时」，不认识标签、不认识 DOM：「显示什么、锚点在哪」由调用方给
 * （`onShow(target, payload)` / `onHide()`）—— 于是"两种模式行为一致"由**一个文件**负责，
 * 而不是靠两处各写一遍再靠人去对齐。规则 ⑤ / ⑥ 的宿主 `document` 同样由调用方注入
 * （横向标签条 / 纵向列表 / 固定网格 / 面板 / 侧栏浮出层**共用同一条**）——
 * 此前只有横向标签条自己在 TabPreview.js 里手写了一遍，纵向与网格三处全缺，
 * 于是"同一个 bug 只修了五分之一"。
 */

/** 停留多久出预览（列表级计时，见 ①）。 */
export const HOVER_PREVIEW_DELAY_MS = 700
/** 刚收起后的「同一轮巡视」重挂窗口（见 ③）。 */
export const HOVER_PREVIEW_REARM_MS = 320
/** 指针落在项以外（但仍在列表内）多久后收起（见 ④）。 */
export const HOVER_PREVIEW_ABSENT_MS = 120
/**
 * 锚点存活巡检间隔（见 ⑥）。
 *
 * 只在预览**在台上**时才走表（收起即停），一次巡检只是一次 `isConnected` 读取 ——
 * 换来的是"任何宿主忘了报移除"都不会留下永久浮层。取 200ms：比一次行/标签的
 * 退场动效（~200ms）略短，用户几乎看不到"淡出中的旧卡片又停了一拍"。
 */
export const HOVER_PREVIEW_LIVENESS_MS = 200
/**
 * 规则 ⑥ 那把锁的安全阀（见 `lockUntilMove`）。
 *
 * 正常路径是 `pointermove` 解锁 —— 这个数只在指针事件根本没来时才生效，
 * 因此取得足够长（补发的 mouseover 在一两帧内就结束），不会误放行"没动过"的那一次。
 */
export const HOVER_PREVIEW_LOCK_MAX_MS = 1500

export interface HoverPreviewController<T> {
  enter: (anchor: HTMLElement, payload: T) => void
  absent: () => void
  leave: () => void
  hide: (options?: { forgetRound?: boolean }) => void
  invalidate: () => void
  suspend: () => void
  resume: () => void
  isVisible: () => boolean
  current: () => HTMLElement | null
  currentPayload: () => T | null
  dispose: () => void
}

export interface HoverPreviewContext<T> {
  document?: Document
  onIntent?: () => void
  onShow: (anchor: HTMLElement, payload: T) => void
  onHide?: () => void
}

function now() {
  return typeof performance !== 'undefined' && performance.now ? performance.now() : Date.now()
}

/**
 * @template T
 * @param {{
 *   onShow: (target: HTMLElement, payload: T) => void,
 *   onHide: () => void,
 *   onIntent?: () => void,
 *   document?: Document
 * }} ctx 两个回调 + 一个可选宿主：其余一切（事件、锚点、内容）都由调用方管。
 *   `document` 只用于规则 ⑤（按下收起）—— 不传就没有这一条兜底（例如权限浮层这类
 *   不需要"点别处即收"的场合，或非 DOM 宿主）。
 *   `onIntent` = 「这一轮真的要等 700ms 了」的信号，规则 ① 起表前**只报一次**。
 *   宿主拿它做**预热**（浮层是独立 renderer，闲置会被回收；冷启动数百毫秒正好被
 *   这段延迟盖住）。它不进状态机 —— 不改变任何一条规则的判定。
 * @returns {{
 *   enter: (target: HTMLElement, payload: T) => void,
 *   absent: () => void,
 *   leave: () => void,
 *   hide: (opts?: { forgetRound?: boolean }) => void,
 *   invalidate: () => void,
 *   isVisible: () => boolean,
 *   current: () => HTMLElement|null,
 *   currentPayload: () => T|null,
 *   dispose: () => void
 * }}
 */
export function createHoverPreview<T>(ctx: HoverPreviewContext<T>): HoverPreviewController<T> {
  /** 当前 hover 的**项**（标签节点 / 行节点）—— 判据是节点身份，不是内容。 */
  let current: HTMLElement | null = null
  /** 当前项随附的载荷（tab 数据等），原样交给 onShow。 */
  let payload: T | null = null
  /** 预览此刻是否在台上（只有它决定 ② 与 ④ 的分支）。 */
  let visible = false
  let delayTimer: ReturnType<typeof setTimeout> | null = null
  let absentTimer: ReturnType<typeof setTimeout> | null = null
  /** 上次收起时刻（供 ③ 判「同一轮巡视」）。 */
  let lastHiddenAt = 0
  /** 锚点存活巡检的表（只在预览在台上时存在，见 ⑥）。 */
  let livenessTimer: ReturnType<typeof setInterval> | null = null
  /**
   * ⑥ 的锁：锚点项刚被移除 → 拒绝「指针没动」的 enter。
   *
   * 为什么不能只靠 `forgetRound`：那只关掉规则 ③ 的即时补显，规则 ② 判的是
   * `visible`（此刻仍为 true），换一项照样立刻出图。而规则 ① 起的 700ms 计时也会
   * 在光标**完全不动**的情况下到点弹出来 —— 用户看到的就是"关掉的标签预览还在"。
   * 所以锁到指针真的动过（`pointermove`）为止；真实移动必然先于那次 mouseover，
   * 于是正常的 hover 语义一个都不丢。
   */
  let lockedUntilMove = false
  /** ⑥ 锁的安全阀（见 lockUntilMove）。 */
  let lockTimer: ReturnType<typeof setTimeout> | null = null
  /** 右键菜单 / 拖拽等非 hover 交互期间暂停预览，避免补发事件重新计时。 */
  let suspended = false

  function cancelDelay() {
    if (delayTimer) { clearTimeout(delayTimer); delayTimer = null }
  }
  function cancelAbsent() {
    if (absentTimer) { clearTimeout(absentTimer); absentTimer = null }
  }
  function stopLiveness() {
    if (livenessTimer) { clearInterval(livenessTimer); livenessTimer = null }
  }

  /**
   * 在台上时开巡检（见 ⑥）：锚点一旦不在文档里就当作"项被移除"，走同一条收起。
   *
   * 为什么是轮询而不是 MutationObserver：观察整棵子树在标签条这种高频重排的地方
   * 代价远大于"一次布尔读取"；而本表只在预览显示期间存在，收起即停。
   * 锚点不是 DOM 节点（扩展方自造的对象）时没有 `isConnected`，自动跳过。
   */
  function startLiveness() {
    if (livenessTimer || !current || typeof current.isConnected !== 'boolean') return
    livenessTimer = setInterval(() => {
      if (!current) { stopLiveness(); return }
      if (current.isConnected === false) invalidate()
    }, HOVER_PREVIEW_LIVENESS_MS)
  }

  /** 真正把预览放上台（三处入口共用：换锚 ② / 补显 ③ / 延迟到点 ①）。 */
  function showNow(): void {
    if (suspended || !current) return
    visible = true
    startLiveness()
    ctx.onShow(current, payload as T)
  }

  /**
   * 收起（幂等）。
   * `forgetRound` = 同时清掉重挂窗口：拖拽收尾这类"刚松手时 Chromium 会补发一次 mouseover"
   * 的场景必须清，否则松手瞬间会把预览重新弹出来（用户看到"离开了还挂着"）。
   */
  function hide(opts: { forgetRound?: boolean } = {}): void {
    cancelDelay()
    cancelAbsent()
    stopLiveness()
    const wasVisible = visible
    current = null
    payload = null
    visible = false
    if (opts.forgetRound === true) lastHiddenAt = 0
    else lastHiddenAt = now()
    if (wasVisible) ctx.onHide?.()
  }

  /**
   * 规则 ⑥：**锚点项已从列表里消失**（关标签 / 取消固定 / 列表清空 / 整批换行）。
   *
   * 与 `hide()` 的两点差别（也是这一条存在的全部理由）：
   *   · 走 `forgetRound` —— 这不是"用户离开"，不该给相邻项留即时补显的窗口；
   *   · 锁到指针真的动过 —— 项被移除会让相邻项在**指针没动**时滑到指针底下，
   *     Chromium 为此补发的 mouseover 绝不能被当成一次新的 hover。
   *
   * 宿主只要在"这一项不在本轮投影里"的那一拍调一次即可（横向 / 纵向 / 网格 / 面板
   * 共用；忘了调也有存活巡检兜底）。
   */
  function invalidate() {
    const engaged = visible || delayTimer !== null
    hide({ forgetRound: true })
    if (engaged && doc) lockUntilMove()
  }

  /**
   * ⑥ 的锁：拒绝 enter，直到指针真的移动过（`pointermove` 先于那次补发的 mouseover）。
   *
   * 安全阀（`HOVER_PREVIEW_LOCK_MAX_MS`）：布局变化引起的补发 mouseover 在**一两帧内**
   * 就发生完了，所以 1.5s 足够长到不会误放行；而指针事件万一压根不来（合成输入 /
   * 远程桌面），锁不至于把这一整个渲染进程的 hover 预览永久废掉。
   */
  function lockUntilMove() {
    if (lockedUntilMove) return
    if (!doc || typeof doc.addEventListener !== 'function') return
    lockedUntilMove = true
    doc.addEventListener('pointermove', onDocPointerMove, true)
    lockTimer = setTimeout(unlock, HOVER_PREVIEW_LOCK_MAX_MS)
  }

  function onDocPointerMove() {
    if (lockedUntilMove) unlock()
  }

  function unlock() {
    if (lockTimer) { clearTimeout(lockTimer); lockTimer = null }
    if (!lockedUntilMove) return
    lockedUntilMove = false
    doc?.removeEventListener('pointermove', onDocPointerMove, true)
  }

  /**
   * 规则 ⑤：按下（捕获相）落在当前项以外 → 立即收起。
   *
   * 用 mousedown 而不是 click：click 要等 mouseup，而"按下-拖走-松开"这种手势里
   * 鼠标早已离开原项 —— 那时 mouseout 已经把状态清干净了，但若手指按住不放、
   * 预览会一直挂着；mousedown 一发生就收，最贴近用户"我要点别处了"的意图。
   * 捕获相（第 3 参 true）保证先于任何业务监听拿到事件：宿主自己的 mousedown
   * 处理里再调 hide 也不会重复触发（hide 幂等）。
   *
   * `current.contains(target)` 而不是 `===`：项内子元素（favicon / 标题 / 关闭按钮）
   * 的按下**不该**收起 —— 用户只是在项内部点，锚点没变。
   */
  const doc = ctx && ctx.document ? ctx.document : null
  function onDocMouseDown(e: MouseEvent): void {
    if (!current) return
    if (typeof current.contains === 'function' && current.contains(e.target as Node | null)) return
    hide()
  }
  if (doc && typeof doc.addEventListener === 'function') {
    doc.addEventListener('mousedown', onDocMouseDown, true)
  }

  return {
    /** 指针进入某一项（见 ①②③）。同一项重复进入直接忽略（项内子元素间移动不该重置计时）。 */
    enter(target: HTMLElement, nextPayload: T): void {
      // 右键菜单 / 拖拽期间，鼠标仍可能落在同一条标签上；此时焦点不在 hover 项，
      // 不能把补发的 mouseover 当成新的停留意图。
      if (suspended) return
      // ⑥ 锁：指针没动过的那次 enter（项被移除后相邻项滑到指针底下时 Chromium 补发的）
      // 一律不接 —— 否则规则 ②③ 会让预览在"用户什么都没做"的情况下重新弹出。
      if (lockedUntilMove) return
      if (!target || target === current) return
      const inSameRound = lastHiddenAt !== 0 && now() - lastHiddenAt < HOVER_PREVIEW_REARM_MS
      current = target
      payload = nextPayload
      lastHiddenAt = 0
      cancelAbsent()
      // ② 已可见 → 立即换锚
      if (visible) { showNow(); return }
      // ③ 同一轮巡视里回来 → 立即补显，不重新计满延迟
      if (inSameRound) { showNow(); return }
      // ① 计时起点是"进入列表"那一刻：已有在途计时就不重置
      //   （计时期间换项不重排表 —— 到点时用的是**最新**的 current / payload，规则 ②）
      if (delayTimer) return
      // 到这里才真的是「新一轮、要等满 700ms」—— 冷启动预热只在这一拍有意义：
      // 上面几条分支要么立刻显示（浮层本就在台上），要么在途计时（已报过）。
      if (typeof ctx.onIntent === 'function') {
        try { ctx.onIntent() } catch {}
      }
      delayTimer = setTimeout(() => {
        delayTimer = null
        if (!current) return
        // 计时到点时锚点已经离开文档（项在延迟期间被关闭）→ 绝不放上台：
        // 那会让预览锚在一个已经不存在的行上（tabPreviewFacts 会拒绝量它，但
        // 别的宿主未必有那道判据 —— 这里统一兜住）。
        if (typeof current.isConnected === 'boolean' && current.isConnected === false) {
          invalidate()
          return
        }
        showNow()
      }, HOVER_PREVIEW_DELAY_MS)
    },

    /** 指针仍在列表内、但不在任何项上（见 ④ 前半）。 */
    absent() {
      cancelAbsent()
      if (!visible) return
      absentTimer = setTimeout(() => {
        absentTimer = null
        hide()
      }, HOVER_PREVIEW_ABSENT_MS)
    },

    /** 指针离开列表视图（见 ④ 后半）：立即收起。 */
    leave() {
      hide()
    },

    hide,
    /** 锚点项已消失（见 ⑥）：立即收起，并锁到指针真的动过为止。 */
    invalidate,
    /** 进入菜单 / 拖拽等交互：立即收起并拒绝新的 hover，直到 resume()。 */
    suspend() {
      suspended = true
      hide({ forgetRound: true })
    },
    /** 交互结束：恢复 hover；第一次补发事件仍按“指针真实移动过”才放行。 */
    resume() {
      if (!suspended) return
      suspended = false
      lockUntilMove()
    },
    isVisible: () => visible,
    /** 当前 hover 的项（调用方拿它做"这一项还在不在 DOM 里"之类的判断）。 */
    current: () => current,
    currentPayload: () => payload,
    dispose() {
      cancelDelay()
      cancelAbsent()
      stopLiveness()
      // 规则 ⑤ / ⑥ 的监听随实例一起摘（宿主被销毁 / 视图卸载时）—— 否则 doc 上会累积监听。
      if (doc) doc.removeEventListener('mousedown', onDocMouseDown, true)
      if (lockTimer) { clearTimeout(lockTimer); lockTimer = null }
      if (lockedUntilMove && doc) doc.removeEventListener('pointermove', onDocPointerMove, true)
      lockedUntilMove = false
      suspended = false
      current = null
      payload = null
      visible = false
    }
  }
}
