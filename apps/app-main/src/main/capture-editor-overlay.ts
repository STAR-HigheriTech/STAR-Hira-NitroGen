/**
 * capture-editor-overlay —— 截图标注的**浏览器窗口内浮层**（不是应用子窗口）。
 *
 * ── 为什么必须是窗口内浮层 ─────────────────────────────────────────
 * 网页跑在 WebContentsView 里，天然盖住外壳 DOM：标注画布想"就地画在截下来的那块
 * 图片上"，只能在**另一个同样大小的原生视图**上画 —— 与查找栏 / 框选层同一条理由。
 * 开一个独立 BrowserWindow 也能画，但那会跳出浏览器（用户还要去找那个窗口），
 * 与 QQ / Snipaste 的"截完就地标注"完全不是一回事。
 *
 * ── 几何：视图 bounds 直接取「用户正在操作的那块网页面」────────────────
 * `getViewBounds` 给的是**窗口内容区坐标**，与 float view 的坐标系一致 ——
 * 因此浮层与网页视图逐像素重合，框选矩形可以直接当画布位置用（中间没有任何换算）。
 * 窗口 resize 时重新取一次，浮层跟着网页一起动。
 *
 * ── 数据流 ───────────────────────────────────────────────────────
 *   主进程 → `capture-editor:show { captureId, place }` → 浮层（按 captureId 取底图）
 *   浮层 → `capture-editor:copy / save`（invoke，复用 ipc/capture.ts）
 *   浮层 → `capture-editor:close`（单向）→ 本模块收起（bounds 归零 + 通知复位）
 *   主进程 → `capture-editor:hide` → 浮层释放画布
 *
 * 本模块每个窗口一份（用该窗口的 layoutCoordinator）；close 上报按**发送方 wc** 路由，
 * 多窗口下不可能串台（与 capture-region / js-dialog 同一范式，进程级监听只装一次）。
 */

import { ipcMain, type BrowserWindow, type WebContents } from 'electron'

const { stageCapture, discardCapture } = require('./capture-editor') as {
  stageCapture(buffer: Uint8Array | null | undefined, meta?: Record<string, unknown>): string | null
  discardCapture(id: string): boolean
}

interface CaptureBounds { x: number; y: number; width: number; height: number }

interface CaptureEditorLayoutPort {
  getFloatWebContents(name: string): WebContents | null | undefined
  isFloatVisible(name: string): boolean
  attachFloatView(name: string): unknown
  noteFloatShow(name: string): unknown
  setFloatBounds(name: string, bounds: CaptureBounds): unknown
  setFloatInteractive(name: string, interactive: boolean): unknown
  sendToFloat(name: string, channel: string, payload: unknown): Promise<boolean>
  hideFloat(name: string): unknown
}

export interface CaptureEditorOverlayDependencies {
  layoutCoordinator: CaptureEditorLayoutPort
  win?: BrowserWindow | null
  getViewBounds?(webContents?: WebContents | null): CaptureBounds | null
}

interface ReadyWaiter { resolve(value: boolean): void; timer: NodeJS.Timeout | null }
interface CaptureFloatTarget { hide(): void; settleReady(ok: boolean): void }

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

export const CAPTURE_EDITOR_FLOAT_NAME = 'capture-editor'
const NAME = CAPTURE_EDITOR_FLOAT_NAME
const SEND = (route: string): string => `ngipc:send:${route}`
const EVENT = (route: string): string => `ngipc:event:${route}`
const ROUTE_CLOSE = 'capture-editor:close'
const ROUTE_READY = 'capture-editor:ready'

/**
 * 等浮层报「首帧已画出来」的上限。
 *
 * 为什么必须有上限：`show` 之后渲染页要 invoke 取底图、decode、按安全尺寸缩放、
 * 首帧 draw —— 整页长图（上千像素高）最慢几百毫秒。但取图失败 / 解码失败时
 * **永远不会有 ready**，没有超时就会把下面的框选层一直挂着（用户卡在"框选态"）。
 * 超时后照常收尾：浮层已经可见，只是少了一次无缝交接。
 */
const READY_TIMEOUT_MS = 2500

// ── 进程级协调器（监听只注册一次）───────────────────────────────────────
/** 浮层 webContents → 该窗口的控制器实例。 */
const _byFloatWc = new WeakMap<WebContents, CaptureFloatTarget>()
let _installed = false

function installCoordinator() {
  if (_installed) return
  _installed = true
  ipcMain.on(SEND(ROUTE_CLOSE), (event) => {
    const target = event && event.sender ? _byFloatWc.get(event.sender) : null
    if (target) target.hide()
  })
  // 首帧回执：只解除「本次 open 的等待」，不改任何几何 —— 收起仍然只由 hide / close 触发。
  ipcMain.on(SEND(ROUTE_READY), (event) => {
    const target = event && event.sender ? _byFloatWc.get(event.sender) : null
    if (target) target.settleReady(true)
  })
}

/**
 * 把一个矩形归一成"可用"的整数矩形（宽高必须为正，否则返回 null）。
 * @param {{x?:number,y?:number,width?:number,height?:number}|null} rect
 * @returns {{x:number,y:number,width:number,height:number}|null}
 */
function normalizeBounds(rect: CaptureBounds | null | undefined): CaptureBounds | null {
  if (!rect) return null
  const width = Math.round(Number(rect.width) || 0)
  const height = Math.round(Number(rect.height) || 0)
  if (!(width > 0) || !(height > 0)) return null
  return {
    x: Math.round(Number(rect.x) || 0),
    y: Math.round(Number(rect.y) || 0),
    width,
    height
  }
}

/**
 * @param {object} deps
 * @param {object} deps.layoutCoordinator 本窗口的布局协调器
 * @param {any} deps.win 本窗口（用于 resize 跟随）
 * @param {(wc?: any) => ({x:number,y:number,width:number,height:number}|null)} deps.getViewBounds
 *   目标网页面在**窗口内容区**里的矩形
 */
export function createCaptureEditorOverlay(deps: CaptureEditorOverlayDependencies) {
  const layoutCoordinator = deps.layoutCoordinator
  const win = deps.win
  const getViewBounds = typeof deps.getViewBounds === 'function' ? deps.getViewBounds : () => null
  if (!layoutCoordinator) throw new Error('[capture-editor-overlay] 需要 layoutCoordinator')

  /** 正在被标注的那一页（收起后为 null）。 */
  let target: WebContents | null = null
  /** 被监听 'destroyed' 的 webContents（切一次目标就换一次，旧监听必须摘掉）。 */
  let watched: WebContents | null = null
  /** 本次 open 的「首帧回执」等待器：{ resolve, timer } | null（见 settleReady）。 */
  let pendingReady: ReadyWaiter | null = null
  /** 尚未被渲染页取走的底图；窗口关闭 / 打开失败 / 下一次截图时主动释放。 */
  let stagedCaptureId: string | null = null

  function discardStagedCapture(): void {
    if (!stagedCaptureId) return
    try { discardCapture(stagedCaptureId) } catch (_) {}
    stagedCaptureId = null
  }

  /**
   * 解除首帧等待。**幂等**：没有等待器时是空操作。
   * @param {boolean} ok false = 放弃等待（超时 / 收起 / 打开失败）
   */
  function settleReady(ok: boolean): void {
    const pending = pendingReady
    pendingReady = null
    if (!pending) return
    if (pending.timer) clearTimeout(pending.timer)
    pending.resolve(!!ok)
  }

  /**
   * 开一个「等首帧」的承诺（带超时兜底）。
   * 必须在 `sendToFloat` **之前**建好：ready 是从 renderer 异步回来的，
   * 建晚了就有概率漏掉（表现为每次都白等满 2.5 秒）。
   * @returns {Promise<boolean>}
   */
  function waitReady(): Promise<boolean> {
    settleReady(false)
    return new Promise<boolean>((resolve) => {
      const timer = setTimeout(() => {
        if (pendingReady && pendingReady.timer === timer) settleReady(false)
      }, READY_TIMEOUT_MS)
      if (typeof timer.unref === 'function') timer.unref()
      pendingReady = { resolve, timer }
    })
  }

  function floatWc(): WebContents | null {
    try { return layoutCoordinator.getFloatWebContents(NAME) || null } catch (_) { return null }
  }

  /** 目标页被销毁（标签关掉 / 崩溃）：浮层没有意义了，收起。 */
  function onTargetDestroyed(): void {
    if (target && typeof target.isDestroyed === 'function' && target.isDestroyed()) target = null
    hide()
  }

  function watchTarget(wc: WebContents | null | undefined): void {
    if (watched && typeof watched.removeListener === 'function') {
      try { watched.removeListener('destroyed', onTargetDestroyed) } catch (_) {}
    }
    watched = wc && typeof wc.once === 'function' ? wc : null
    if (watched) watched.once('destroyed', onTargetDestroyed)
  }

  /**
   * 收起浮层：几何归零（浮层显隐只靠 bounds）+ 通知渲染页复位并释放画布。
   * 幂等：重复调用没有副作用。
   *
   * 早退：本来就没开着（没有目标页 + 浮层不在台上）时**什么都不做** ——
   * 切标签 / 窗口失焦每次都会调到本函数，而标注浮层绝大多数时候根本没被打开过；
   * 无条件 `hideFloat` + `:hide` 会把它的渲染进程白唤醒一次。
   */
  function hide(): void {
    discardStagedCapture()
    const wasOpen = target !== null || (() => {
      try { return layoutCoordinator.isFloatVisible(NAME) } catch (_) { return false }
    })()
    target = null
    watchTarget(null)
    settleReady(false)
    if (!wasOpen) return
    try { layoutCoordinator.hideFloat(NAME) } catch (_) {}
    const wc = floatWc()
    if (wc && !wc.isDestroyed()) {
      try { wc.send(EVENT('capture-editor:hide'), {}) } catch (_) {}
    }
  }

  /** 窗口 resize 后重新贴合目标网页面（浮层不该停在旧矩形里）。 */
  function reposition(): void {
    if (!target || (typeof target.isDestroyed === 'function' && target.isDestroyed())) return
    const bounds = getViewBounds(target)
    if (!bounds || !(bounds.width > 0) || !(bounds.height > 0)) return
    try { layoutCoordinator.setFloatBounds(NAME, bounds) } catch (_) {}
  }

  installCoordinator()

  /**
   * 打开标注浮层（三种截图方式的**唯一交付口**）。
   *
   * @param {any} webContents 被截的那一页（浮层要盖在它的视图上）
   * @param {Buffer} buffer PNG 字节
   * @param {{x:number,y:number,width:number,height:number}} [place] 选区在目标视图里的矩形
   * @param {{x:number,y:number,width:number,height:number}} [viewBounds]
   *   目标视图矩形（**调用方已知就传**）。框选路径必须传：那时焦点在框选浮层上，
   *   再问一次"当前聚焦的网页"有可能问到 null / 问到别处。省略才回退到 getViewBounds。
   * @returns {Promise<{ ok: boolean, ready?: boolean, reason?: string }>}
   */
  async function open(
    webContents: WebContents | null | undefined,
    buffer: Buffer,
    place?: CaptureBounds,
    viewBounds?: CaptureBounds
  ): Promise<{ ok: boolean; ready?: boolean; reason?: string }> {
    // 同一窗口只有一块标注面：新截图到来时先把上一场可靠收尾，
    // 包括未取走的底图、首帧等待器和目标页 destroyed 监听。
    hide()
    const captureId = stageCapture(buffer, { origin: 'browser-window' })
    if (!captureId) return { ok: false, reason: 'empty-image' }
    stagedCaptureId = captureId
    const bounds = normalizeBounds(viewBounds) || normalizeBounds(getViewBounds(webContents))
    if (!bounds) {
      discardStagedCapture()
      // 拿不到矩形 = 无从摆放浮层。说出来，别让"点了没反应"变成无日志的黑洞。
      console.warn('[capture-editor-overlay] 拿不到目标页矩形（无法摆放标注浮层）')
      return { ok: false, reason: 'no-view-bounds' }
    }

    target = webContents || null
    watchTarget(target)

    // 顺序硬要求（同 capture-region）：attachFloatView 必须在 setFloatBounds 之前，
    // setFloatBounds 对不在表里的浮层**直接 return**，不做惰性创建。
    try { layoutCoordinator.attachFloatView(NAME) } catch (_) {}
    try { layoutCoordinator.noteFloatShow(NAME) } catch (_) {}

    // 首帧等待器要在 send 之前就位（ready 是异步回来的，见 waitReady 的说明）。
    const readySignal = waitReady()
    // 路由映射同样提前登记：此刻视图已建好（attachFloatView 做的），wc 已经存在。
    const readyWc = floatWc()
    if (readyWc) _byFloatWc.set(readyWc, { hide, settleReady })
    try { layoutCoordinator.setFloatBounds(NAME, bounds) } catch (_) {}
    // 必须可交互：否则鼠标会穿透到下面的网页，画布根本收不到笔。
    try { layoutCoordinator.setFloatInteractive(NAME, true) } catch (_) {}

    const payload: { captureId: string; place?: CaptureBounds } = { captureId }
    if (place && Number(place.width) > 0 && Number(place.height) > 0) {
      payload.place = {
        x: Math.round(place.x),
        y: Math.round(place.y),
        width: Math.round(place.width),
        height: Math.round(place.height)
      }
    }

    try {
      await layoutCoordinator.sendToFloat(NAME, EVENT('capture-editor:show'), payload)
    } catch (e) {
      discardStagedCapture()
      console.warn('[capture-editor-overlay] 打开失败:', errorMessage(e))
      hide()
      return { ok: false, reason: 'open-failed' }
    }

    // 等首帧：渲染页画完第一帧才 resolve（超时兜底 false）。
    // 调用方据此决定"什么时候把下层那层（框选层 / 淡暗）收掉" —— 先收再画就是闪跳。
    const ready = await readySignal
    if (!ready) console.warn('[capture-editor-overlay] 首帧回执超时，按已就绪继续')
    return { ok: true, ready }
  }

  if (win && typeof win.on === 'function') {
    win.on('resize', reposition)
    win.on('maximize', reposition)
    win.on('unmaximize', reposition)
    win.on('enter-full-screen', reposition)
    win.on('leave-full-screen', reposition)
  }

  function dispose(): void {
    hide()
    if (!win || typeof win.removeListener !== 'function') return
    try { win.removeListener('resize', reposition) } catch (_) {}
    try { win.removeListener('maximize', reposition) } catch (_) {}
    try { win.removeListener('unmaximize', reposition) } catch (_) {}
    try { win.removeListener('enter-full-screen', reposition) } catch (_) {}
    try { win.removeListener('leave-full-screen', reposition) } catch (_) {}
  }

  return { open, hide, reposition, dispose }
}

