/**
 * JS Dialog 模块入口
 *
 * 解耦成模块化结构（所有 preload 已归一到 infra/infra-window/preload/）：
 *   - js-dialog-bridge.js#exposeJsDialogBridge：页面侧 bridge（标签页与面板共用同一份）
 *   - dialog-renderer.js：浮层 preload（UI 交互逻辑，构建入口之一）
 *   - dialog-inject.js：main world 注入脚本（executeJavaScript 重写 window.alert 等）
 *   - dialog-overlay.js：浮层窗口管理
 *   - dialog-queue.js：队列管理
 *   - index.js：主进程 IPC 处理 + 入口
 *
 * 谁会被接管：标签页（`tab:webcontents-ready`）、独立侧栏、**全部面板**
 * （`WebContentsManager` 的 `onPanelViewCreated` 端口 → `attachToWebContents`）。
 * 前者承接网页的 alert/confirm，后两者让面板里的 `ctx.confirm`（如删除集锦）
 * 也走应用内浮层，而不是 Electron 的系统原生对话框。
 *
 * 通道名唯一真源：`@hira-ng/shared-types/src/js-dialog-channels.mjs#JS_DIALOG_CHANNELS`。
 * 这是**裸 send/sendSync** 协议（同步语义必须如此），不进 IPC_ROUTES/IPC_EVENTS。
 *
 * 核心同步语义实现（对齐 HiraRT prompts 的 promise-hold）：
 *   - alert/beforeunload：sendSync(show) 立即返回默认值，异步开窗
 *   - confirm/prompt：send(showAsync) 异步开窗 + 单次 sendSync(pollResult)
 *     结果未就绪时**挂起该同步事件**（不写 returnValue），等用户响应后再写入 ——
 *     渲染进程一次同步等待即可，零轮询、零自旋，主进程事件循环不被阻塞
 *   - _asyncResult 中转用户结果；被挂起的 poll 事件由 settlePendingPoll() 结算
 *   - 队列管理：alert 立即处理下一个，confirm/prompt 延迟到 poll-result 结算后
 *
 * ── 多窗口分派（本次修复的核心）───────────────────────────────────
 * `createJsDialogManager` 在 `browser-window-assembly.mount()` 里**每开一个窗口就调用
 * 一次**，因此它持有的是**按窗口**的状态（_activeOverlay / _confirmSender / _appResolve /
 * _suppressedTabIds / _currentTabId …）。真正的问题在**通道注册**：若每个窗口都各自
 * `ipcMain.on(show | …)` 一遍，`ipcMain.on` 重复注册**不报错**，却会让
 * **同一次弹窗事件被 N 套 handler 各处理一遍** —— A 发起的 alert 会同时在 A 与 B 上
 * 各建一个浮层、confirm/prompt 的应答互相竞争、「阻止更多弹窗」状态跨窗口串台。
 *
 * 因此通道改由**进程级协调器 `installJsDialogCoordinator` 只注册一次**，再按发送方
 * 路由到所属窗口的那个 manager 实例。路由复用上一轮的按窗口解析机制：
 *   · 页面（标签）发来的事件 → scopeRawIpcMain 放进 AsyncLocalStorage 的 sender →
 *     `currentOrNull()` 解析到所属窗口运行单元（解析不到返回 null，**不回落主窗口**）；
 *   · 浮层自身发来的事件（response / getThemeInfo）→ 浮层不属于任何浏览器窗口
 *     运行单元，用「创建时登记的 浮层 webContents → manager」映射路由；
 *   · 两种情况都解析不到 → **告警并丢弃**，绝不静默落到主窗口（与上一轮同口径）。
 *
 * 使用方式：
 *   const manager = createJsDialogManager({ runtimeRegistry, getParentWindow, getAccentThemeInfo })
 *   tabManager.on('tab:webcontents-ready', ({ webContents, tabId }) => {
 *     manager.attachToWebContents(webContents, tabId)
 *   })
 */

import type { BrowserWindow, IpcMain, IpcMainEvent, WebContents } from 'electron'
import { createOverlay, type DialogOverlayController } from './dialog-overlay'
import { createDialogQueue } from './dialog-queue'
import { registerInjection, type JsDialogType } from './dialog-inject'

const { ipcMain, nativeTheme } = require('electron') as typeof import('electron')
const { JS_DIALOG_CHANNELS } = require('@hira-ng/shared-types/src/js-dialog-channels.mjs') as {
  JS_DIALOG_CHANNELS: Record<string, string>
}

type DialogWebContents = WebContents & { __ngTabId?: string }

interface DialogShowOptions {
  type?: JsDialogType
  message?: unknown
  defaultValue?: unknown
  url?: string
}

interface DialogRequest {
  type?: JsDialogType
  message?: unknown
  defaultValue?: unknown
  sourceDomain?: string
  sourceTabId?: string | null
  parentWindow?: BrowserWindow | null
  senderWebContents?: WebContents
  title?: unknown
  okText?: unknown
  cancelText?: unknown
  hideSuppress?: boolean
  defaultFocus?: string
  focusOnReveal?: boolean
  appResolve?: (value: boolean) => void
}

interface DialogResult {
  action?: string
  value: unknown
}

interface DialogResponse {
  action?: string
  value?: unknown
  suppress?: boolean
}

interface AppConfirmOptions {
  title?: string
  message?: string
  okText?: string
  cancelText?: string
}

interface DialogHandlers {
  show(event: IpcMainEvent, options: DialogShowOptions | undefined): void
  showAsync(event: IpcMainEvent, options: DialogShowOptions | undefined): void
  pollResult(event: IpcMainEvent): void
  response(event: IpcMainEvent, payload: DialogResponse | undefined): void
  getThemeInfo(event: IpcMainEvent): void
  resize(event: IpcMainEvent, payload: { height?: unknown } | undefined): void
}

interface JsDialogManagerApi {
  attachToWebContents(webContents: WebContents, tabId: string): void
  confirm(options?: AppConfirmOptions): Promise<boolean>
  destroy(): void
  handlers: DialogHandlers
}

interface RuntimeWithDialog {
  jsDialogManager?: JsDialogManagerApi | null
}

interface DialogRuntimeRegistry {
  scopeRawIpcMain(ipcMain: IpcMain): IpcMain
  currentOrNull(): RuntimeWithDialog | null
  matchBySender(sender: unknown): RuntimeWithDialog | null
}

interface JsDialogManagerOptions {
  getParentWindow?: () => BrowserWindow | null
  getAccentThemeInfo?: () => unknown
  getOverrideTypes?: () => JsDialogType[]
  runtimeRegistry?: DialogRuntimeRegistry | null
}

// ── 进程级协调器状态（**只做路由**，不持有任何弹窗业务状态）──────────────
/** 已创建的按窗口管理器（无注册表 / 单窗口时的归属兜底） */
const _managers = new Set<JsDialogManagerApi>()
/**
 * 浮层自身 webContents → 其所属管理器。
 * 为什么需要：浮层是独立子窗口，`BrowserWindow.fromWebContents(浮层wc)` 拿到的是浮层
 * 自己、而非宿主浏览器窗口，因此 `jsDialog:response` / `fw-get-theme-info` 无法走
 * 「按窗口运行单元解析」。改为在创建浮层时登记这条映射，按发送方精确路由。
 */
const _overlayOwner = new WeakMap<WebContents, JsDialogManagerApi>()
/** 按发送方解析窗口的注册表（多窗口）；单窗口 / 无注册表时为 null */
let _runtimeRegistry: DialogRuntimeRegistry | null = null
let _coordinatorInstalled = false

/**
 * 解析「这次弹窗事件属于哪个窗口的 manager」。
 * 解析不到返回 null（由调用方告警并丢弃），**绝不回退主窗口**。
 */
function resolveManager (sender: WebContents | null | undefined): JsDialogManagerApi | null {
  if (!sender) return null
  if (_runtimeRegistry) {
    // ① 页面（标签）的 webContents：优先用 currentOrNull()（scopeRawIpcMain 已把本次
    //    IPC 的 sender 放进 AsyncLocalStorage）—— 解析不到返回 null，不回落主窗口。
    try {
      const rt = _runtimeRegistry.currentOrNull()
      if (rt && rt.jsDialogManager) return rt.jsDialogManager
    } catch (_) {}
    // 兜底：注册表可用但当前不在（或未进入）ALS 上下文时，直接按 sender 精确解析。
    try {
      const rt = _runtimeRegistry.matchBySender(sender)
      if (rt && rt.jsDialogManager) return rt.jsDialogManager
    } catch (_) {}
  }
  // ② 浮层自身的 webContents：用创建时登记的映射（见 _overlayOwner 说明）。
  const byOverlay = _overlayOwner.get(sender)
  if (byOverlay) return byOverlay
  // ③ 单窗口 / 无注册表：唯一的管理器即归属方（与改造前逐字节等价）。
  if (_managers.size === 1) return _managers.values().next().value ?? null
  return null
}

/**
 * 安装进程级协调器：把 jsDialog:* 通道**只注册一次**，按发送方路由到所属窗口的 manager。
 *
 * 幂等：每开一个窗口都会调用（见 mount），但只有第一次真正注册。后到的 runtimeRegistry
 * 会补进 `_runtimeRegistry`（因此即便首次安装时拿不到注册表，后续也能解析到）。
 *
 * @param {object} [runtimeRegistry] window-runtime-registry（提供 scopeRawIpcMain / currentOrNull）
 */
export function installJsDialogCoordinator (runtimeRegistry?: DialogRuntimeRegistry | null): void {
  if (runtimeRegistry) _runtimeRegistry = runtimeRegistry
  if (_coordinatorInstalled) return
  _coordinatorInstalled = true

  // 复用上一轮的机制：裸 ipcMain.on 自动进入「按发送方解析」的 AsyncLocalStorage 上下文。
  const scopedIpcMain = _runtimeRegistry && typeof _runtimeRegistry.scopeRawIpcMain === 'function'
    ? _runtimeRegistry.scopeRawIpcMain(ipcMain)
    : ipcMain

  /** 路由一件事到所属窗口的 manager；解析不到则告警并丢弃。 */
  function route (event: IpcMainEvent, invoke: (handlers: DialogHandlers) => void): void {
    const manager = resolveManager(event && event.sender)
    if (!manager) {
      console.warn('[jsDialog] 无法确定弹窗所属窗口，已丢弃该事件（不做主窗口兜底）')
      return
    }
    invoke(manager.handlers)
  }

  scopedIpcMain.on(JS_DIALOG_CHANNELS.show, (event, options) => route(event, (h) => h.show(event, options)))
  scopedIpcMain.on(JS_DIALOG_CHANNELS.showAsync, (event, options) => route(event, (h) => h.showAsync(event, options)))
  scopedIpcMain.on(JS_DIALOG_CHANNELS.pollResult, (event) => route(event, (h) => h.pollResult(event)))
  scopedIpcMain.on(JS_DIALOG_CHANNELS.response, (event, payload) => route(event, (h) => h.response(event, payload)))
  scopedIpcMain.on(JS_DIALOG_CHANNELS.getThemeInfo, (event) => route(event, (h) => h.getThemeInfo(event)))
  scopedIpcMain.on(JS_DIALOG_CHANNELS.resize, (event, payload) => route(event, (h) => h.resize(event, payload)))
}

/**
 * 创建**按窗口**的 JS Dialog 管理器。
 *
 * 注意：本函数**不再自己订阅 ipcMain**（旧实现每窗口各订阅一遍 → 同一次弹窗被 N 套
 * handler 处理 → N 个浮层）。通道由进程级协调器只注册一次，再按发送方路由到这里的
 * `handlers`（见文件顶部「多窗口分派」说明）。
 *
 * @param {Object} opts
 * @param {() => import('electron').BrowserWindow} opts.getParentWindow - 获取当前主窗口
 * @param {() => {accentColor, borderColor, inputFocusBorder}} [opts.getAccentThemeInfo] - 获取主题色信息
 * @param {() => string[]} [opts.getOverrideTypes] - 获取要重写的类型
 * @param {object} [opts.runtimeRegistry] - 窗口运行单元注册表（多窗口按发送方路由）
 */
export function createJsDialogManager (opts: JsDialogManagerOptions = {}): JsDialogManagerApi {
  const getParentWindow = opts.getParentWindow || function () { return null }
  const getAccentThemeInfo = opts.getAccentThemeInfo || function () { return null }

  // 默认重写类型：全部启用
  function getOverrideTypes (): JsDialogType[] {
    if (typeof opts.getOverrideTypes === 'function') {
      return opts.getOverrideTypes()
    }
    return ['alert', 'confirm', 'prompt', 'beforeunload']
  }

  // 各类型同步返回的默认值（页面继续执行的值）
  function getJsDialogDefaultValue (type: JsDialogType): boolean | string | null | undefined {
    if (type === 'confirm') return false
    if (type === 'prompt') return null
    if (type === 'beforeunload') return 'leave'
    return undefined // alert
  }

  // ── 按窗口状态（每个窗口一份 manager 实例各自持有，语义完全对齐 Hira 的全局变量）──
  // ⚠ 这些状态**必须**随窗口隔离：manager 每窗口一个实例，进程级协调器按发送方路由
  // 到对应实例，两个窗口各自的浮层 / 应答 / 阻止状态才不会互相踩。
  let _activeOverlay: DialogOverlayController | null = null
  let _boundParentWindow: BrowserWindow | null = null
  let _currentTabId: string | null = null
  let _timeoutTimer: ReturnType<typeof setTimeout> | null = null
  // 应用级确认框（主进程主动发起）的 Promise 结算函数。
  // 与网页侧 confirm 的区别：网页侧要通过 _confirmSender + sendSync 挂起渲染进程，
  // 这里只是主进程等一个 Promise，因此单独一条结算通道，互不干扰。
  let _appResolve: ((value: boolean) => void) | null = null
  // "阻止此页面创建更多弹窗"：按 tabId 记录被阻止的页面
  const _suppressedTabIds = new Set<string>()
  // 弹窗队列
  const _queue = createDialogQueue<DialogRequest, BrowserWindow | null>()
  // confirm/prompt 真同步：发起 dialog 的 webContents（用于把用户结果 send 回去）
  let _confirmSender: WebContents | null = null
  // 用户响应结果（confirm/prompt 真同步）：用户点击按钮后写入，渲染进程 sendSync 取走
  // null = 用户尚未响应；非 null = 已响应
  let _asyncResult: DialogResult | null = null
  // 被挂起的 jsDialog:poll-result 同步事件：结果未就绪时先不写 returnValue，
  // 等 _asyncResult 就绪后再写入 —— 渲染进程单次同步等待，主进程事件循环不被阻塞，
  // 渲染进程也不再忙等自旋烧 CPU。
  let _pendingPollEvent: IpcMainEvent | null = null
  let _pendingPollTimer: ReturnType<typeof setTimeout> | null = null

  /**
   * 结果就绪时结算被挂起的 poll 事件（若有）。
   * 只负责把结果送回渲染进程并推进队列，不做其它副作用。
   */
  function settlePendingPoll () {
    if (!_pendingPollEvent || _asyncResult === null) return
    const evt = _pendingPollEvent
    _pendingPollEvent = null
    if (_pendingPollTimer) {
      clearTimeout(_pendingPollTimer)
      _pendingPollTimer = null
    }
    const result = _asyncResult
    _asyncResult = null
    _confirmSender = null
    try { evt.returnValue = result } catch (_) {}
    processQueueAfterResultTaken()
  }

  /**
   * 销毁当前浮层
   * 完全对齐 Hira destroyJsDialogWindow
   */
  function destroyOverlay () {
    if (_timeoutTimer) {
      clearTimeout(_timeoutTimer)
      _timeoutTimer = null
    }
    if (_boundParentWindow && !_boundParentWindow.isDestroyed()) {
      try { _boundParentWindow.removeListener('resize', _onParentResize) } catch (_) {}
    }
    _boundParentWindow = null
    _currentTabId = null

    if (_activeOverlay) {
      _activeOverlay.destroy()
      _activeOverlay = null
    }

    // 应用级确认框：浮层被销毁时用户仍未点按钮（超时 / 父窗口 resize / 页面导航 /
    // 窗口关闭）→ 一律按「取消」结算。绝不让调用方的 Promise 悬着：那会让
    // 「关闭多个标签」这类动作永远停在半路，连气泡都不再出现。
    if (_appResolve) {
      const resolve = _appResolve
      _appResolve = null
      try { resolve(false) } catch (_) {}
    }

    // confirm/prompt 真同步：浮层销毁时如果用户未点击按钮（超时/导航/view销毁），
    // 必须设置默认 cancel 结果，否则渲染进程 pollForResult 会一直轮询到超时
    let hasPendingAsyncResult = false
    if (_confirmSender) {
      if (_confirmSender.isDestroyed()) {
        // 渲染进程已销毁，不会有人取走结果，直接清空废弃的结果
        _asyncResult = null
      } else {
        if (_asyncResult === null) {
          _asyncResult = { action: 'cancel', value: null }
        }
        hasPendingAsyncResult = true
      }
    }
    _confirmSender = null

    // 处理队列中的下一个弹窗
    // - alert/beforeunload（hasPendingAsyncResult=false）：立即处理
    // - confirm/prompt（hasPendingAsyncResult=true）：延迟到 poll-result handler 取走结果后处理
    if (!hasPendingAsyncResult && _queue.hasPending()) {
      const next = _queue.shift()
      if (!next) return
      setTimeout(function () {
        try { createOverlayWindow(next.parentWindow, next.requestData) } catch (_) {}
      }, 0)
    }

    // confirm/prompt：浮层关闭即代表结果已定（用户响应 / 超时 / 导航），
    // 立即结算被挂起的同步 poll 事件，渲染进程无需再等待。
    settlePendingPoll()
  }

  /**
   * confirm/prompt 队列处理：在 poll-result handler 取走结果后触发
   */
  function processQueueAfterResultTaken () {
    if (_queue.hasPending()) {
      const next = _queue.shift()
      if (!next) return
      setTimeout(function () {
        try { createOverlayWindow(next.parentWindow, next.requestData) } catch (_) {}
      }, 0)
    }
  }

  /**
   * 父窗口 resize 回调
   * 对齐 Hira：父窗口 resize 时销毁浮层（位置会错位，需要关闭重开）
   */
  function _onParentResize () {
    destroyOverlay()
  }

  /**
   * 创建浮层
   * 完全对齐 Hira createJsDialogWindow
   */
  function createOverlayWindow (parentWindow: BrowserWindow | null, requestData: DialogRequest): void {
    // 已有浮层正在显示 → 入队等待
    if (_activeOverlay) {
      _queue.push(parentWindow, requestData)
      return
    }
    // 应用级确认框：记录 Promise 结算函数（随 requestData 一起排队，轮到它时才接管）
    _appResolve = typeof requestData.appResolve === 'function' ? requestData.appResolve : null

    const type = requestData.type || 'alert'

    // confirm/prompt 真同步：在实际创建浮层时才设置 sender（而不是 show-async 收到时）
    // 避免 alert 浮层显示时，confirm 的 sender 已设置导致 alert 的 ok 错误地填充 confirm 结果
    if ((type === 'confirm' || type === 'prompt') && requestData.senderWebContents) {
      _confirmSender = requestData.senderWebContents
      _asyncResult = null // 重置上次结果
    }
    // alert/beforeunload 不设置 _confirmSender

    let overlayWc: WebContents | null = null
    try {
      _activeOverlay = createOverlay({
        parentWindow: parentWindow,
        // 应用级确认框（appResolve 存在）：出现即接管焦点，键盘（Enter / Esc）立刻可用。
        // 网页弹窗保持 showInactive —— 不把焦点从网页输入框上夺走。
        focusOnReveal: typeof requestData.appResolve === 'function'
      })
      overlayWc = _activeOverlay.show()
    } catch (e) {
      // 浮层创建失败：如果是 confirm/prompt，必须设置 cancel 结果避免永久阻塞
      if (_confirmSender && !_confirmSender.isDestroyed()) {
        _asyncResult = { action: 'cancel', value: null }
      }
      _confirmSender = null
      // 应用级确认框同样不能悬着：按「取消」结算
      if (_appResolve) {
        const resolve = _appResolve
        _appResolve = null
        try { resolve(false) } catch (_) {}
      }
      return
    }

    // 登记「浮层 webContents → 本窗口 manager」：浮层是独立子窗口，不属于任何浏览器
    // 窗口运行单元，`jsDialog:response` / `fw-get-theme-info` 只能靠这条映射回到本窗口。
    if (overlayWc) _overlayOwner.set(overlayWc, api)

    _currentTabId = requestData.sourceTabId ?? null

    // 父窗口 resize 时销毁浮层（位置会错位）
    if (parentWindow) {
      _boundParentWindow = parentWindow
      parentWindow.on('resize', _onParentResize)
    }

    // 直接发送 init 数据（不依赖 did-finish-load 事件）
    // hira://jsdialog 从内存返回 HTML，加载非常快，did-finish-load 可能
    // 在 show() 返回前就触发了，导致 once('did-finish-load') 监听器注册不上
    // sendInit 内部会检查 isLoading()，自动处理时序问题
    _activeOverlay.sendInit({
      type: type,
      message: requestData.message || '',
      defaultValue: requestData.defaultValue || '',
      sourceDomain: requestData.sourceDomain || '',
      // 应用级确认框可自定义文案 / 隐藏「阻止此页面创建更多弹窗」；
      // 网页侧弹窗不带这些字段，渲染层回落到类型默认值（行为与改造前一致）。
      title: requestData.title || '',
      okText: requestData.okText || '',
      cancelText: requestData.cancelText,
      hideSuppress: requestData.hideSuppress === true,
      // 'cancel' = 默认焦点给「取消」（破坏性批量动作的安全默认）；缺省仍焦点「确定」。
      defaultFocus: requestData.defaultFocus || ''
    })

    // 30 秒超时自动关闭
    _timeoutTimer = setTimeout(function () {
      if (_activeOverlay) {
        destroyOverlay()
      }
      _timeoutTimer = null
    }, 30000)
  }

  // ── 主进程 IPC 处理（均为**按窗口实例**的处理函数，由进程级协调器按发送方路由调用）──
  // 这里**不再**出现 `ipcMain.on`：每个窗口各订阅一遍会让同一次弹窗被 N 套 handler
  // 处理（→ N 个浮层）。通道注册收敛在 installJsDialogCoordinator（进程级只注册一次）。

  // 渲染层 IPC：用户响应（来自浮层的渲染进程）
  function handleResponse (_e: IpcMainEvent, payload: DialogResponse | undefined): void {
    if (!payload) return
    // 用户勾选"阻止此页面创建更多弹窗" → 记录此 tabId
    if (payload.suppress && _currentTabId) {
      _suppressedTabIds.add(String(_currentTabId))
    }
    // 应用级确认框：只有「确定」才是肯定语义（取消 / Esc / 关闭浮层一律 false）。
    // 先结算再 destroyOverlay —— 后者看到 _appResolve 已清空就不会再补一次 cancel。
    if (_appResolve) {
      const resolve = _appResolve
      _appResolve = null
      try { resolve(payload.action === 'ok') } catch (_) {}
    }
    // confirm/prompt 真同步：把结果存到 _asyncResult，等渲染进程 sendSync 轮询取走
    if (_confirmSender && !_confirmSender.isDestroyed()) {
      _asyncResult = {
        action: payload.action,
        value: (payload.value === undefined) ? null : payload.value
      }
    }
    // 销毁浮层（destroyOverlay 不会覆盖已设置的 _asyncResult）
    destroyOverlay()
  }

  // preload 通过 sendSync 触发对话框显示
  // 立即设置 event.returnValue 为默认值（页面继续执行），异步创建浮层
  function handleShow (event: IpcMainEvent, options: DialogShowOptions | undefined): void {
    try {
      const type = options?.type || 'alert'

      // 解析父窗口
      const parentWin = getParentWindow()

      // 解析来源域名
      let sourceDomain = ''
      try {
        if (options && options.url) {
          sourceDomain = new URL(options.url).hostname || ''
        }
      } catch (_) {}

      // 解析来源 tabId
      let sourceTabId = null
      try {
        const sender = event.sender as DialogWebContents
        if (typeof sender.__ngTabId === 'string') {
          sourceTabId = sender.__ngTabId
        }
      } catch (_) {}

      // 立即返回默认值（页面继续执行）
      event.returnValue = getJsDialogDefaultValue(type)

      // 此页面已被用户勾选"阻止更多弹窗" → 静默丢弃，不显示浮层
      if (sourceTabId && _suppressedTabIds.has(String(sourceTabId))) {
        return
      }

      // 异步创建浮层
      setTimeout(function () {
        try {
          createOverlayWindow(parentWin, {
            type: type,
            message: options?.message || '',
            defaultValue: options?.defaultValue || '',
            sourceDomain: sourceDomain,
            sourceTabId: sourceTabId,
            parentWindow: parentWin
          })
        } catch (_) {}
      }, 0)
    } catch (_) {
      event.returnValue = getJsDialogDefaultValue(options?.type || 'alert')
    }
  }

  // confirm/prompt 真同步：异步 IPC（不阻塞渲染进程），主进程创建浮层，
  // 用户响应后把结果存到 _asyncResult，渲染进程通过 jsDialog:poll-result sendSync 轮询取走
  function handleShowAsync (event: IpcMainEvent, options: DialogShowOptions | undefined): void {
    try {
      // 注意：不在这里立即设置 _confirmSender
      // 因为浮层可能入队等待（前面有 alert），如果立即设置，
      // alert 的 ok 响应会错误地填充 confirm/prompt 的结果
      // sender 通过 requestData 传递，在实际创建浮层时才设置

      const parentWin = getParentWindow()

      let sourceDomain = ''
      try {
        if (options && options.url) {
          sourceDomain = new URL(options.url).hostname || ''
        }
      } catch (_) {}

      let sourceTabId = null
      try {
        const sender = event.sender as DialogWebContents
        if (typeof sender.__ngTabId === 'string') {
          sourceTabId = sender.__ngTabId
        }
      } catch (_) {}

      // 此页面已被"阻止更多弹窗" → 直接给 cancel 结果
      if (sourceTabId && _suppressedTabIds.has(String(sourceTabId))) {
        _asyncResult = { action: 'cancel', value: null }
        settlePendingPoll()
        return
      }

      const type = options?.type || 'confirm'

      // 异步创建浮层
      setTimeout(function () {
        try {
          createOverlayWindow(parentWin, {
            type: type,
            message: options?.message || '',
            defaultValue: options?.defaultValue || '',
            sourceDomain: sourceDomain,
            sourceTabId: sourceTabId,
            parentWindow: parentWin,
            senderWebContents: event.sender // 传递给 createOverlayWindow
          })
        } catch (_) {
          if (_confirmSender && !_confirmSender.isDestroyed()) {
            _asyncResult = { action: 'cancel', value: null }
          }
          _confirmSender = null
        }
      }, 0)
    } catch (_) {
      _asyncResult = { action: 'cancel', value: null }
    }
  }

  // confirm/prompt 真同步：渲染进程 sendSync 等待结果（单次调用，无忙等）
  // 有结果 → 立即返回 { action, value }；无结果 → 挂起该事件，等用户响应后再写入 returnValue
  function handlePollResult (event: IpcMainEvent): void {
    if (_asyncResult !== null) {
      const result = _asyncResult
      _asyncResult = null
      _confirmSender = null
      event.returnValue = result
      // 前一个 confirm/prompt 结果已被渲染进程取走，现在可以安全创建队列中的下一个弹窗
      processQueueAfterResultTaken()
      return
    }
    // 结果未就绪：挂起事件。主进程事件循环继续运行（能处理浮层的 response IPC），
    // 渲染进程同步等待 —— 不占用 CPU，也不轮询。
    _pendingPollEvent = event
    if (_pendingPollTimer) clearTimeout(_pendingPollTimer)
    // 兜底超时：异常情况下（如浮层未能创建）避免渲染进程永久挂起
    _pendingPollTimer = setTimeout(function () {
      _pendingPollTimer = null
      if (!_pendingPollEvent) return
      const evt = _pendingPollEvent
      _pendingPollEvent = null
      _asyncResult = null
      _confirmSender = null
      try { evt.returnValue = { action: 'cancel', value: null } } catch (_) {}
      processQueueAfterResultTaken()
    }, 36000)
  }

  // 主题色信息查询（浮层 preload 通过 sendSync 询问）
  function handleGetThemeInfo (event: IpcMainEvent): void {
    try { event.returnValue = getAccentThemeInfo() } catch (_) {
      event.returnValue = null
    }
  }

  // 内容高度上报（浮层渲染层量出自然高度后发送）→ 窗口高度自适应。
  // 高度是「渲染层的事」：主进程只做几何夹取，见 dialog-overlay#resizeToContent。
  function handleResize (_e: IpcMainEvent, payload: { height?: unknown } | undefined): void {
    if (!_activeOverlay || !payload) return
    const height = Number(payload.height)
    if (!Number.isFinite(height) || height <= 0) return
    try { _activeOverlay.resizeToContent(height) } catch (_) {}
  }

  // 主题切换通知
  function notifyTheme () {
    if (_activeOverlay) {
      try { _activeOverlay.sendTheme(getAccentThemeInfo()) } catch (_) {}
    }
  }
  nativeTheme.on('updated', notifyTheme)

  /**
   * **应用级**确认框（主进程主动发起，Promise 语义）。
   *
   * 与网页侧 confirm 的区别：网页侧必须让渲染进程同步等待（sendSync + 挂起 poll），
   * 这里没有任何渲染进程在等，只是主进程要一个「用户到底点了什么」的答案。
   * 因此复用同一个浮层页面与视觉（hira://jsdialog，就是网页 window.confirm 的那个样子），
   * 但走一条独立的 `_appResolve` 结算通道，不碰 _confirmSender / _asyncResult。
   *
   * 结算保证：无论用户点确定 / 取消、按 Esc、浮层超时、父窗口 resize、窗口关闭，
   * Promise 都一定会落地（只有「确定」是 true），调用方不需要自己设超时。
   *
   * @param {{title?:string, message?:string, okText?:string, cancelText?:string}} [options]
   * @returns {Promise<boolean>} true = 用户点了确定
   */
  function confirmApp (options?: AppConfirmOptions): Promise<boolean> {
    const opts = options || {}
    return new Promise(function (resolve) {
      // 没有宿主窗口 → 浮层无处安放：按「取消」处理，绝不静默放行破坏性操作。
      const parentWin = getParentWindow()
      if (!parentWin || (typeof parentWin.isDestroyed === 'function' && parentWin.isDestroyed())) {
        resolve(false)
        return
      }
      try {
        createOverlayWindow(parentWin, {
          type: 'confirm',
          message: opts.message || '',
          title: opts.title || '',
          okText: opts.okText || '',
          cancelText: opts.cancelText,
          // 应用确认框没有「页面」可言，勾「阻止此页面创建更多弹窗」无处落地 → 整块隐藏。
          hideSuppress: true,
          // 出现即接管焦点（见 createOverlayWindow 的 focusOnReveal 说明）：
          // 模态子窗拿不到焦点时，父窗口被禁用、键盘无处可去，用户会以为"卡住了"。
          focusOnReveal: true,
          // 破坏性动作的安全默认：焦点在「取消」上，顺手一个回车不会把标签关掉。
          defaultFocus: 'cancel',
          appResolve: resolve
        })
      } catch (_) {
        _appResolve = null
        resolve(false)
      }
    })
  }

  /**
   * 为 webContents 注册 dialog 事件监听 + main world 注入
   * 完全对齐 Hira global.registerJsDialogViewListener + global.injectJsDialogOverride
   * @param {import('electron').WebContents} webContents
   * @param {string} tabId - 标签 ID
   */
  function attachToWebContents (webContents: WebContents, tabId: string): void {
    if (!webContents || typeof webContents.on !== 'function') return

    // 标记 webContents 的 tabId（用于 jsDialog:show / show-async 中解析 sourceTabId）
    try { (webContents as DialogWebContents).__ngTabId = String(tabId) } catch (_) {}

    // 注册 main world 注入（每次 dom-ready 注入重写脚本）
    registerInjection(webContents, getOverrideTypes)

    // 主框架导航完成（非 in-place）时关闭浮层 + 清除"阻止更多弹窗"记录
    webContents.on('did-start-navigation', function (_e, _url, isInPlace, isMainFrame) {
      if (isMainFrame && !isInPlace) {
        if (_activeOverlay && String(_currentTabId) === String(tabId)) {
          destroyOverlay()
        }
        // 离开页面即重置阻止状态（与原生 safeDialogs 语义一致）
        _suppressedTabIds.delete(String(tabId))
      }
    })

    // webContents 销毁时关闭浮层 + 清除"阻止更多弹窗"记录
    webContents.once('destroyed', function () {
      if (_activeOverlay && String(_currentTabId) === String(tabId)) {
        destroyOverlay()
      }
      _suppressedTabIds.delete(String(tabId))
    })
  }

  /**
   * 销毁管理器
   */
  function destroy () {
    if (_timeoutTimer) {
      clearTimeout(_timeoutTimer)
      _timeoutTimer = null
    }
    if (_pendingPollTimer) {
      clearTimeout(_pendingPollTimer)
      _pendingPollTimer = null
    }
    if (_pendingPollEvent) {
      try { _pendingPollEvent.returnValue = { action: 'cancel', value: null } } catch (_) {}
      _pendingPollEvent = null
    }
    if (_activeOverlay) {
      _activeOverlay.destroy()
      _activeOverlay = null
    }
    // 应用级确认框：窗口关闭时按「取消」结算（否则调用方的 Promise 永远悬着）
    if (_appResolve) {
      const resolve = _appResolve
      _appResolve = null
      try { resolve(false) } catch (_) {}
    }
    // 丢弃队列时也要把其中**应用级确认框**的 Promise 结算掉（按「取消」）——
    // 直接清空会让调用方永远等不到答案（窗口关闭场景下最容易被忽略）。
    while (_queue.hasPending()) {
      const next = _queue.shift()
      const resolve = next && next.requestData && next.requestData.appResolve
      if (typeof resolve === 'function') {
        try { resolve(false) } catch (_) {}
      }
    }
    _suppressedTabIds.clear()
    // 退出租户：协调器不再把这个实例当归属方（单窗口兜底也随之失效）
    _managers.delete(api)
    try { nativeTheme.removeListener('updated', notifyTheme) } catch (_) {}
  }

  const api: JsDialogManagerApi = {
    attachToWebContents,
    /**
     * 应用级确认框（主进程主动发起）：复用同一个浮层视觉，Promise<boolean>。
     * 供 IPC 闸门 / 应用菜单这类「不是网页发起的」确认使用（如关闭多个标签）。
     */
    confirm: confirmApp,
    destroy,
    /**
     * 供**进程级协调器按发送方路由**调用的处理函数。
     * ⚠ 外部不要直接用它们订阅 ipcMain —— 每窗口各订阅一遍正是本次修复的串台缺陷。
     */
    handlers: {
      show: handleShow,
      showAsync: handleShowAsync,
      pollResult: handlePollResult,
      response: handleResponse,
      getThemeInfo: handleGetThemeInfo,
      resize: handleResize
    }
  }

  // 登记到进程级协调器：幂等安装通道（**只注册一次**），本实例仅负责「按窗口」的那份状态。
  _managers.add(api)
  installJsDialogCoordinator(opts.runtimeRegistry)

  return api
}

