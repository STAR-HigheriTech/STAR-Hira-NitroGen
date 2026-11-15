/**
 * CursorEdgeMonitor —— 光标边缘监控（对齐 RT cursor-edge-monitor）。
 *
 * 为什么需要它：标签 WebContentsView 覆盖在 chrome 渲染层之上并吃掉全部鼠标事件，
 * 渲染进程的 document.mousemove 无法感知「光标贴近窗口边缘」，因此边缘唤出（侧栏自动
 * 弹出）必须在主进程侧轮询屏幕光标坐标后推给渲染层。
 *
 * **彻底解耦**：本模块不 import electron，不引用任何全局单例。
 * 通过注入 `getFocusedWindow` / `getCursorPoint` / `onEdge` 完成全部外部交互，
 * 因此可被任意宿主复用、可单测、可替换实现。
 *
 * 策略（对齐 RT）：
 *  - ~30fps 轮询；光标在窗口内时**每 tick** 上报 `{ edge, x, y }`，渲染层据此做
 *    「进入边缘」与「基于距离的脱离」两种判定；
 *  - 光标离开窗口时补发一次 `{ edge: null }`，避免状态悬挂；
 *  - 窗口最小化 / 已销毁 → 跳过（省电）；
 *  - `stop()` 清空状态并清定时器，空闲 0 CPU、0 定时器。
 */

const DEFAULT_POLL_MS = 1000 / 30
const DEFAULT_EDGE_THRESHOLD = 12
/** 允许光标略微移出窗口仍视为「在窗口内」，避免边缘抖动导致事件中断。 */
const EDGE_EXIT_FACTOR = 22

/**
 * 进程级共享采样组：`pollMs → { timer, subs:Set }`。
 *
 * 为什么必须共享：本模块有四个消费者（边缘唤出 / 跨窗口拖标签 / 拖放落点 / 分屏工具条），
 * 各建一个 monitor 就是各起一条 30fps 主进程定时器 —— 「拖分屏 + 拖标签 + 边缘唤出」同时
 * 发生时，同一帧里会有多条定时器**重复调用 `screen.getCursorScreenPoint()`**。
 * 采样（屏幕坐标）与消费者无关，所以定时器只留一份，消费者只订阅。
 *
 * 组按 `pollMs` 分：周期不同的消费者各成一组（每组仍只有一条定时器）。
 */
interface CursorPoint { x: number; y: number }
type CursorEdge = 'left' | 'right' | null
interface CursorWindow {
  readonly id: number
  getBounds(): { x: number; y: number; width: number; height: number }
  isDestroyed?(): boolean
  isMinimized?(): boolean
}
interface CursorSubscriber {
  readonly pollMs: number
  getCursorPoint(): CursorPoint | null
  tick(cursor: CursorPoint): void
}
interface CursorGroup {
  timer: ReturnType<typeof setInterval> | null
  readonly subs: Set<CursorSubscriber>
}
interface CursorEdgeOptions {
  getFocusedWindow(): CursorWindow | null
  getCursorPoint(): CursorPoint | null
  onEdge(window: CursorWindow, event: { edge: CursorEdge; x: number; y: number }): void
  onTick?(cursor: CursorPoint): void
  pollMs?: number
  edgeThreshold?: number
}

const sharedGroups = new Map<number, CursorGroup>()

function sharedTick(group: CursorGroup): void {
  // 取一帧坐标：按订阅顺序问各消费者的采样源，**第一个给出坐标的**就是本帧样例。
  // 四个真实消费者都接的是 `screen.getCursorScreenPoint()`（同源），所以正常一拍只调一次；
  // 万一某份采样源暂时取不到（返回 null），也不会把整组拖死 —— 换下一个问。
  let cursor = null
  for (const sub of group.subs) {
    try {
      cursor = sub.getCursorPoint()
    } catch (_) {
      cursor = null
    }
    if (cursor) break
  }
  if (!cursor) return
  // 复制一份再遍历：消费者在自己的 tick 里可能 stop()（例如拖拽结束、指针丢失）
  for (const sub of Array.from(group.subs)) {
    try {
      sub.tick(cursor)
    } catch (_) {}
  }
}

function acquireGroup(sub: CursorSubscriber): void {
  const ms = sub.pollMs
  let group = sharedGroups.get(ms)
  if (!group) {
    group = { timer: null, subs: new Set() }
    sharedGroups.set(ms, group)
  }
  group.subs.add(sub)
  if (group.timer === null) {
    group.timer = setInterval(() => sharedTick(group), ms)
    if (group.timer && typeof group.timer.unref === 'function') group.timer.unref()
  }
}

function releaseGroup(sub: CursorSubscriber): void {
  const ms = sub.pollMs
  const group = sharedGroups.get(ms)
  if (!group) return
  group.subs.delete(sub)
  if (group.subs.size === 0) {
    if (group.timer !== null) clearInterval(group.timer)
    group.timer = null
    sharedGroups.delete(ms)
  }
}

/**
 * @param {object} options
 * @param {() => (object|null)} options.getFocusedWindow 返回焦点窗口（需实现 id / getBounds / isDestroyed / isMinimized）
 * @param {() => ({x:number,y:number}|null)} options.getCursorPoint 返回屏幕坐标光标点
 * @param {(win:object, event:{edge:('left'|'right'|null),x:number,y:number}) => void} options.onEdge 边缘事件回调
 * @param {(cursor:{x:number,y:number}) => void} [options.onTick] 每个采样周期回调一次原始屏幕坐标（与边缘判定无关）
 * @param {number} [options.pollMs=1000/30]
 * @param {number} [options.edgeThreshold=12]
 */
export function createCursorEdgeMonitor(options: CursorEdgeOptions): {
  start(): boolean
  stop(): void
  poll(): void
  forget(windowId: number): void
  readonly running: boolean
} {
  const pollOption = Number(options.pollMs)
  const thresholdOption = Number(options.edgeThreshold)
  const pollMs = Number.isFinite(pollOption) && pollOption > 0 ? pollOption : DEFAULT_POLL_MS
  const edgeThreshold =
    Number.isFinite(thresholdOption) && thresholdOption > 0
      ? thresholdOption
      : DEFAULT_EDGE_THRESHOLD
  const getFocusedWindow = typeof options.getFocusedWindow === 'function' ? options.getFocusedWindow : () => null
  const getCursorPoint = typeof options.getCursorPoint === 'function' ? options.getCursorPoint : () => null
  const onEdge = typeof options.onEdge === 'function' ? options.onEdge : () => {}
  // 通用采样钩子：跨窗口拖动等消费者只关心「光标此刻在哪」，不关心边缘状态。
  const onTick = typeof options.onTick === 'function' ? options.onTick : null

  /** windowId → 上次 tick 光标是否在窗口内 */
  const cursorInside = new Map<number, boolean>()
  let active = false

  function getEdge(localX: number, windowWidth: number): CursorEdge {
    if (localX < edgeThreshold) return 'left'
    if (localX > windowWidth - edgeThreshold) return 'right'
    return null
  }

  /**
   * 一帧处理：坐标由共享定时器**代采**（本函数不再自己调 screen）。
   * @param {{x:number,y:number}} cursor 屏幕坐标
   */
  function tick(cursor: CursorPoint | null): void {
    // 先广播原始采样 —— 通用消费者（跨窗口拖动落点判定）必须无条件拿到，
    // 即使此刻没有任何窗口持有焦点、或焦点窗口最小化。
    if (!cursor) return
    if (onTick) {
      try { onTick(cursor) } catch (_) {}
    }

    const win = getFocusedWindow()
    if (!win) return
    try {
      if (typeof win.isDestroyed === 'function' && win.isDestroyed()) return
      if (typeof win.isMinimized === 'function' && win.isMinimized()) return
    } catch (_) {
      return
    }
    let bounds: { x: number; y: number; width: number; height: number }
    try {
      bounds = win.getBounds()
    } catch (_) {
      return
    }
    if (!bounds) return

    const localX = cursor.x - bounds.x
    const localY = cursor.y - bounds.y
    const leftExit = edgeThreshold * -EDGE_EXIT_FACTOR
    const rightExit = edgeThreshold * EDGE_EXIT_FACTOR
    const isInside =
      localX >= leftExit &&
      localX <= bounds.width + rightExit &&
      localY >= 0 &&
      localY <= bounds.height
    const wasInside = cursorInside.get(win.id) === true

    if (isInside) {
      cursorInside.set(win.id, true)
      onEdge(win, { edge: getEdge(localX, bounds.width), x: localX, y: localY })
    } else if (wasInside) {
      cursorInside.set(win.id, false)
      onEdge(win, { edge: null, x: localX, y: localY })
    }
  }

  // 订阅实体：交给共享采样组的就是它（对外不暴露，公共 API 仍是下面那五个）。
  const subscriber: CursorSubscriber = { pollMs, getCursorPoint, tick }

  /** 立即自采一帧（不依赖共享定时器）：供调用方按需驱使与单测使用。 */
  function poll(): void {
    tick(getCursorPoint())
  }

  function start(): boolean {
    if (active) return false
    active = true
    acquireGroup(subscriber)
    return true
  }

  function stop(): void {
    cursorInside.clear()
    if (!active) return
    active = false
    releaseGroup(subscriber)
  }

  /** 某个窗口关闭时清理其状态，避免 Map 无限增长。 */
  function forget(windowId: number): void {
    cursorInside.delete(windowId)
  }

  return {
    start,
    stop,
    poll,
    forget,
    get running() {
      return active
    }
  }
}

export { DEFAULT_POLL_MS as CURSOR_EDGE_POLL_MS, DEFAULT_EDGE_THRESHOLD as CURSOR_EDGE_THRESHOLD }
