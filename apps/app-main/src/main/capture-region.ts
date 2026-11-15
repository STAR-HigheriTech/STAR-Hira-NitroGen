/**
 * capture-region —— 「框选截图」（J7 收口）的主进程编排。
 *
 * ── 它做什么 ──────────────────────────────────────────────────────
 * 把一个**独立原生视图**（`capture-overlay`）摆到目标页视图的矩形上，让用户框一块，
 * 然后 `capturePage(rect)` 截那一块并**交给标注编辑器**（与可见区域 / 整页同一落点）。
 *
 * ── 为什么框选矩形能直接当截图参数用 ─────────────────────────────────
 * 覆盖层的 bounds **就是目标页视图的 bounds**（见 `start`），因此覆盖层里的坐标与
 * 页面视口坐标 **1:1**。于是"用户框的"与"截到的"必然是同一块 ——
 * 这是结构上的保证，而不是靠两处各算一遍坐标去凑（凑不齐就是"截偏了"这类 bug）。
 *
 * ── 分工 ──────────────────────────────────────────────────────────
 *   · 本模块：摆位、收框选结果、截图、交给 `openCaptureEditor` 开标注窗口；
 *   · 覆盖层渲染页：只画框并上报矩形（不认识截图、不认识标注）；
 *   · infra（LayoutCoordinator）：浮层几何与交互态（不认识"截图"这件事）。
 * 本模块**每个窗口一份**（用该窗口的 layoutCoordinator），因此上报必须校验发送方
 * 就是本窗口那一块覆盖层 —— 否则多窗口下 A 窗口的框选会去截 B 窗口的图。
 *
 * @param {object} deps
 * @param {object} deps.layoutCoordinator 本窗口的布局协调器
 * @param {(wc: any) => ({x:number,y:number,width:number,height:number}|null)} deps.getViewBounds
 *   取某个 webContents 对应视图的矩形（窗口内容区坐标）—— 覆盖层要盖在它上面。
 * @param {(wc: any, buffer: Buffer, place?: {x:number,y:number,width:number,height:number}, viewBounds?: {x:number,y:number,width:number,height:number}) => Promise<{ ok: boolean, ready?: boolean, reason?: string }>} deps.openCaptureEditor
 *   把截到的 PNG 交给标注浮层（三种截图方式同一落点）。`wc` = 被截的目标页（浮层要盖在
 *   它的视图上）；`place` = 选区在**目标视图**里的矩形（编辑器把画布摆回原位）；
 *   `viewBounds` = 目标页视图矩形（框选期间焦点不在网页上，必须由这里给出）。
 *   返回的承诺在**标注浮层首帧画完**后才 resolve —— 本模块据此决定何时收起框选层。
 */

import { ipcMain, type WebContents } from 'electron'

interface CaptureBounds { x: number; y: number; width: number; height: number }

interface CaptureRegionLayoutPort {
  getFloatWebContents(name: string): WebContents | null | undefined
  attachFloatView?(name: string): unknown
  noteFloatShow(name: string): unknown
  setFloatBounds(name: string, bounds: CaptureBounds): unknown
  setFloatInteractive(name: string, interactive: boolean): unknown
  sendToFloat(name: string, channel: string, payload: unknown): Promise<boolean>
  hideFloat(name: string): unknown
}

interface CaptureEditorResult { ok: boolean; ready?: boolean; reason?: string }

export interface CaptureRegionDependencies {
  layoutCoordinator: CaptureRegionLayoutPort
  getViewBounds?(webContents: WebContents): CaptureBounds | null
  openCaptureEditor?(
    webContents: WebContents,
    buffer: Buffer,
    place?: CaptureBounds,
    viewBounds?: CaptureBounds
  ): Promise<CaptureEditorResult>
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function captureBoundsOf(value: unknown): CaptureBounds | null {
  if (!value || typeof value !== 'object') return null
  const record = value as Record<string, unknown>
  const x = Number(record.x)
  const y = Number(record.y)
  const width = Number(record.width)
  const height = Number(record.height)
  return [x, y, width, height].every(Number.isFinite) ? { x, y, width, height } : null
}

interface PendingCapture { webContents: WebContents; viewBounds: CaptureBounds }

interface CaptureRouteTargets {
  select(rect: unknown): void
  cancel(): void
}

const NAME = 'capture-overlay'
const SEND = (route: string): string => `ngipc:send:${route}`
const EVENT = (route: string): string => `ngipc:event:${route}`
const ROUTE_SELECT = 'capture-overlay:select'
const ROUTE_CANCEL = 'capture-overlay:cancel'
/** 交接：标注浮层首帧已出图 → 框选层把自己的压暗淡出（见 `settle`）。 */
const ROUTE_SETTLE = 'capture-overlay:settle'
/**
 * 交接淡出时长。必须与两侧 CSS 同值：
 *   `renderer/capture-overlay` 的 `.cap-box { transition: box-shadow .18s }`
 *   `ui-capture-editor` 的 `.hira-capture-stage { transition: background-color .18s }`
 * 180ms 动画 + 10ms 余量 —— 提前收层会在动画没走完时把画面掐断。
 */
const SETTLE_MS = 190

const wait = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

// ── 进程级协调器（**监听只注册一次**）─────────────────────────────────────
/**
 * 覆盖层 webContents → 该窗口的实例。
 *
 * ── 为什么不能"每窗口各 `ipcMain.on` 一遍" ─────────────────────────────
 * 本模块是**每窗口一份**的工厂（`browser-window-runtime` 里按窗口创建），早先直接
 * 在工厂内部 `ipcMain.on`：于是**每开一个窗口就多留 2 个永不摘除的进程级监听**，
 * 而且那些闭包会长期持有已关闭窗口的 `win` / `layoutCoordinator` / `pending` ——
 * 开够窗口就撞上 `MaxListenersExceededWarning`（约第 6 个窗口起）。
 * 这与 js-dialog 早已解决的**同一个问题**同源，故沿用它的同一范式：
 * **进程级协调器只注册一次 + 按发送方路由到所属窗口的实例**
 * （见 `js-dialog/index.js` 文件头「多窗口分派」）。
 *
 * ── 为什么键是"覆盖层 webContents"────────────────────────────────────
 * 上报方**就是**那块覆盖层自己，而覆盖层只属于一个窗口 —— 用 wc 做键，
 * 路由即校验：来源对不上自然查不到实例（原先那句 `e.sender !== overlayWc()` 的守卫
 * 随之内化为映射本身，多窗口下不可能串台）。
 */
const _byOverlayWc = new WeakMap<WebContents, CaptureRouteTargets>()
let _coordinatorInstalled = false

/** 安装进程级监听（幂等；首次创建任一窗口的实例时自动调用）。 */
function installCaptureRegionCoordinator() {
  if (_coordinatorInstalled) return
  _coordinatorInstalled = true
  ipcMain.on(SEND(ROUTE_SELECT), (event, rect) => {
    const target = event && event.sender ? _byOverlayWc.get(event.sender) : null
    if (target) target.select(rect)
  })
  ipcMain.on(SEND(ROUTE_CANCEL), (event) => {
    const target = event && event.sender ? _byOverlayWc.get(event.sender) : null
    if (target) target.cancel()
  })
}

export function createCaptureRegion(deps: CaptureRegionDependencies) {
  const layoutCoordinator = deps.layoutCoordinator
  const getViewBounds = typeof deps.getViewBounds === 'function' ? deps.getViewBounds : () => null
  const openCaptureEditor = deps.openCaptureEditor
  if (!layoutCoordinator) throw new Error('[capture-region] 需要 layoutCoordinator')

  /** 本次待截的目标（一次只会有一个：截图是模态交互）。 */
  let pending: PendingCapture | null = null

  /** 本窗口的覆盖层 webContents（用来校验上报来源 —— 多窗口下这是必须的）。 */
  function overlayWc(): WebContents | null {
    try { return layoutCoordinator.getFloatWebContents(NAME) || null } catch (_) { return null }
  }

  /** 收起覆盖层（几何 + 通知渲染页复位）。 */
  function close(): void {
    try { layoutCoordinator.hideFloat(NAME) } catch (_) {}
    const wc = overlayWc()
    if (wc && !wc.isDestroyed()) {
      try { wc.send(EVENT('capture-overlay:hide'), {}) } catch (_) {}
    }
  }

  /** 通知框选层：标注浮层已经把它接过去了，把"选区外 0.45"淡出。 */
  function settle(): void {
    const wc = overlayWc()
    if (wc && !wc.isDestroyed()) {
      try { wc.send(EVENT(ROUTE_SETTLE), {}) } catch (_) {}
    }
  }

  /**
   * 截取并交给标注编辑器（失败只告警 —— 截图失败不该影响任何其它状态）。
   *
   * ── 收框选层的时机（这条是"不闪"的关键）──────────────────────────
   * 早先是「先 close() 再截图」：框选层一收，页面立刻**亮回来**，
   * 等截图 + 浮层首帧画完才重新压暗 —— 中间那一下就是用户看到的闪跳。
   * 现在分三步走：
   *   1. 截图 → 标注浮层挂载（此时它根节点 `visibility:hidden`，一个像素都不画）；
   *   2. 等 `openCaptureEditor` 回报「首帧已出图」（`res.ready`）—— 此刻两层画面
   *      完全重合，但两层压暗会叠加成 0.6975；
   *   3. 让框选层把它的 0.45 淡出（`settle`），标注浮层的 0.45 同时淡入，
   *      淡完（`SETTLE_MS`）才收层 —— 合成亮度全程 ≈0.45，看不见任何变化。
   * 失败路径同样要收（finally），否则用户会卡在框选态。
   */
  async function capture(task: PendingCapture, rect: CaptureBounds): Promise<void> {
    try {
      const wc = task.webContents
      if (!wc || wc.isDestroyed()) return
      const x = Math.max(0, Math.round(rect.x))
      const y = Math.max(0, Math.round(rect.y))
      const width = Math.max(1, Math.round(rect.width))
      const height = Math.max(1, Math.round(rect.height))
      const image = await wc.capturePage({ x, y, width, height })
      if (!image || (typeof image.isEmpty === 'function' && image.isEmpty())) return
      // 选区矩形一并交出去：标注浮层贴在整块视图上，编辑器要按它把画布摆回原位
      //（否则截到的图会被"搬"到浮层中间，观感就不是就地标注了）。
      // 视图矩形也一并给：此刻焦点在框选层上，让浮层自己再问一次"聚焦的网页"不安全。
      if (typeof openCaptureEditor === 'function') {
        const res = await openCaptureEditor(task.webContents, image.toPNG(), { x, y, width, height }, task.viewBounds)
        if (res && res.ready) {
          settle()
          await wait(SETTLE_MS)
        }
      }
    } catch (e) {
      console.warn('[capture-region] 截图失败:', e instanceof Error ? e.message : String(e))
    } finally {
      close()
    }
  }

  /** 覆盖层上报了框选矩形（由进程级协调器按发送方路由过来；已确认是本窗口那块）。 */
  function onSelect(rect: unknown): void {
    const task = pending
    pending = null
    const bounds = captureBoundsOf(rect)
    if (!task || !bounds) {
      close()
      return
    }
    capture(task, bounds)
  }

  /** 覆盖层上报了取消。 */
  function onCancel(): void {
    pending = null
    close()
  }

  // 进程级监听只装一次（幂等）—— 具体事件由上面的实例方法承接，见文件头的协调器说明。
  installCaptureRegionCoordinator()

  /**
   * 开始一次框选截图。
   * @param {{ webContents: any }} input 要截的那一页
   * @returns {Promise<{ ok: boolean }>}
   */
  async function start(input: { webContents: WebContents }): Promise<{ ok: boolean; reason?: string }> {
    const webContents = input.webContents
    if (!webContents || webContents.isDestroyed()) {
      console.warn('[capture-region] 目标页面已销毁，放弃框选')
      return { ok: false, reason: '目标页面不可用' }
    }
    const bounds = getViewBounds(webContents)
    if (!bounds || !bounds.width || !bounds.height) {
      // 拿不到矩形 = 无从摆放覆盖层。**必须说出来** —— 早先这里是静默 return，
      // 于是"点了没反应"完全无从下手（连控制台都没有线索）。
      console.warn('[capture-region] 拿不到目标页矩形（无法摆放框选层）')
      return { ok: false, reason: '拿不到目标页矩形' }
    }

    // 视图矩形在这里就记下来：此刻焦点还在网页上，取到的是**准确**的那块；
    // 框选层一显示焦点就转到它身上，那时再问一次未必还拿得到。
    pending = { webContents, viewBounds: { x: bounds.x, y: bounds.y, width: bounds.width, height: bounds.height } }
    // ⚠⚠ 顺序是**硬要求**，照既有 dropzone-overlay / split-toolbar 的写法：
    //   `attachFloatView` 必须在 `setFloatBounds` **之前** ——
    //   `setFloatBounds` 里是「`_floatViews` 表里没有该视图就直接 return」，
    //   它**不做惰性创建**（惰性创建在 `sendToFloat` 里）。
    //   少了这一步的后果是：bounds 从未被设定 → 视图停在默认 0×0 →
    //   浮层**永远不出现**，而且全程不报任何错（最难查的一类失灵）。
    try {
      if (typeof layoutCoordinator.attachFloatView === 'function') layoutCoordinator.attachFloatView(NAME)
    } catch (e) {
      console.warn('[capture-region] attachFloatView 失败:', errorMessage(e))
    }
    try { layoutCoordinator.noteFloatShow(NAME) } catch (e) {
      console.warn('[capture-region] noteFloatShow 失败:', errorMessage(e))
    }
    try { layoutCoordinator.setFloatBounds(NAME, bounds) } catch (e) {
      console.warn('[capture-region] setFloatBounds 失败:', errorMessage(e))
    }
    // 必须可交互：否则鼠标事件会穿透到下面的网页，框选根本无从开始。
    try { layoutCoordinator.setFloatInteractive(NAME, true) } catch (e) {
      console.warn('[capture-region] setFloatInteractive 失败:', errorMessage(e))
    }
    try {
      await layoutCoordinator.sendToFloat(NAME, EVENT('capture-overlay:show'), {
        width: bounds.width,
        height: bounds.height
      })
    } catch (e) {
      console.warn('[capture-region] 打开框选层失败:', errorMessage(e))
      pending = null
      close()
      return { ok: false }
    }
    // ★ 到这一刻覆盖层的 webContents 才真正存在（惰性创建在 `sendToFloat` 里），
    //   所以路由映射在这里登记。**每次都登记**（而不是只登记一次）是有意的：
    //   浮层有闲置回收腿，覆盖层被回收后重建会是一个**新的 wc**；WeakMap 的旧键
    //   随旧 wc 回收自动消失，这里直接覆盖即可，既不需要清理也不会残留。
    const overlay = overlayWc()
    if (overlay) _byOverlayWc.set(overlay, { select: onSelect, cancel: onCancel })
    return { ok: true }
  }

  return { start, close }
}

