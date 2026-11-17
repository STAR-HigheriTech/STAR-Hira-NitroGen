import path from 'node:path'
import {
  WebContentsView,
  session,
  type BrowserWindow,
  type Session,
  type View,
  type WebContents,
  type WebPreferences
} from 'electron'
const { getAppRoot } = require('@hira-ng/shared-utils')
import { ChromeView } from './ChromeView'
import { buildWebPreferences, buildTabWebPreferences, defaultPreloadPath, type WebPreferenceOptions } from './webPreferences'

/**
 * 独立侧栏顶条的渲染页路由名（= `apps/app-main/src/renderer/web-sidebar-header/`，
 * 也是 electron.vite 的 renderer input 键）。名字三处必须逐字一致：这里、vite 配置、该目录 ——
 * 与浮层家族同一条规矩，否则视图建得起来、内容加载不到。
 */
const WEB_SIDEBAR_HEADER_PAGE = 'web-sidebar-header'

/**
 * 标签视图（承载网页）的原生画布色 —— **固定白色，不跟主题**。
 *
 * 为什么必须是常量：WebContentsView 的 backgroundColor 就是网页的"画布底色"。
 * 大量站点（尤其是简单的工具页 / 老站点 / 纯文本页）**不写** `html`/`body` 背景，
 * Chromium 就把视图底色当作页面背景显示出来。一旦把它跟主题走，深色或带色相的
 * 主题会让这些"本来是白纸"的网页整页染上一层主题色 —— 那不是浏览器该做的决定。
 *
 * 网页自己的深浅由站点（或注入规则 / 强制深色）负责；Hira 只保证"默认是一张白纸"。
 * 主题只接管**网页之外**的表面（rail / 面板 / 窗口缝），见 setSurfaceBackgroundColor。
 *
 * **唯一例外**：内置新标签页是一块透明画布（`#00000000`）—— 壁纸只由窗口外壳
 * 那一份绘制，页面必须透过去才看得见。判据与逐次下发见 setTabCanvas。
 */
const TAB_CANVAS_COLOR = '#ffffff'

/**
 * 「关闭时不打断在途加载」的兜底等待上限（ms）。
 *
 * 面板被关闭（或同侧预约被顶掉）时，它的 `loadURL` 可能仍在途。此时直接
 * `webContents.destroy()` 会让 loadURL 以 `ERR_FAILED (-2)` 拒绝，且 `did-fail-load`
 * 不会来（监听器随 webContents 一起消失）—— 终端里就是一对毫无上下文的
 * "面板加载失败"日志（已实际踩到）。所以销毁推迟到加载落定：正常几十毫秒就结束，
 * 这个上限只保证"卡死的加载不会拖住视图回收"。
 */
const PANEL_LOAD_ABORT_GRACE_MS = 5000

interface TabIdentity { profileId?: string; incognito?: boolean; incognitoPartitionId?: string }
interface TabCreateOptions extends TabIdentity { webContents?: WebContents; session?: Session; [key: string]: unknown }
interface ViewHit { kind: 'shell'|'rail'|'panel'|'float'|'password-overlay'|'tab'|'web-sidebar'; id: string; view: ManagedView }
interface WebContentsManagerOptions {
  getExtraTabWebPreferences?(): WebPreferences
  sessionResolver?: { resolve(options: TabIdentity): Session }
  tabProfileResolver?(tabId: string): TabIdentity | null
  onPanelViewCreated?(panelId: string, webContents: WebContents): void
  surfaceBackgroundColor?: string
  frameBackgroundColor?: string
}
type ManagedView = WebContentsView | ChromeView

/**
 * 面板视图管理（创建 / 惰性加载 / 重载）——**不持有面板清单**。
 *
 * 面板集合由谁提供：APPS 的 `main/panel-catalog.js`（源自插件 manifest 的
 * `contributes.panels`）。infra 只认「给我一个 panelId，我给你一个视图」——
 * 具体有哪些面板是**产品决定**，不是基础设施知识（CONTRACT-11 分层）。
 *
 * 历史教训（曾因此错过一次）：这里硬编码过 `PANEL_IDS`，且与 rail / panels renderer
 * 各写一份，出现 infra 用 `profiles-panel`、渲染层用 `spaces-panel` 的三方不一致 ——
 * `panel:toggle` 拿到 `profiles-panel` 后落进 "Unknown panel" 分支，面板永远打不开。
 * 单一事实源已经上移到 APPS 的面板目录，此类漂移从结构上不可能再发生。
 */

function destroyWebContents(webContents: WebContents): void {
  const destroy = (webContents as WebContents & { destroy?: () => void }).destroy
  if (destroy) destroy.call(webContents)
}

class WebContentsManager {
  private readonly _win: BrowserWindow
  private _uiShellView: ChromeView | null
  private _railView: WebContentsView | null
  private readonly _floatViews: Map<string, WebContentsView>
  private readonly _floatLoadPromises: Map<string, Promise<unknown>>
  private _passwordOverlayView: WebContentsView | null
  private _passwordOverlayLoadPromise: Promise<unknown> | null
  private readonly _panelViews: Map<string, WebContentsView>
  private _webSidebar: { content: WebContentsView | null; header: WebContentsView | null }
  private readonly _tabViews: Map<string, WebContentsView>
  private readonly _tabCanvas: WeakMap<WebContentsView, string>
  private readonly _panelLoadPromises: Map<string, Promise<unknown>>
  private readonly _extraTabWebPreferences: (() => WebPreferences) | null
  private _sessionResolver: { resolve(options: TabIdentity): Session } | null
  private _tabProfileResolver: ((tabId: string) => TabIdentity | null) | null
  private readonly _onPanelViewCreated: ((panelId: string, webContents: WebContents) => void) | null
  private readonly _tabOptions: Map<string, TabCreateOptions>
  private readonly _panelLoaded: Set<string>
  private _surfaceBackgroundColor: string
  private _tabHost: View | null

  constructor(win: BrowserWindow, options: WebContentsManagerOptions = {}) {
    this._win = win
    this._uiShellView = null
    this._railView = null
    // 每个浮层各自独立一个 WebContentsView，互不共用图层（彻底解耦）。
    // key = 浮层逻辑名，渲染页面 = out/renderer/<key>/index.html
    this._floatViews = new Map()
    this._floatLoadPromises = new Map()
    this._passwordOverlayView = null
    /** 密码浮层加载 Promise 去重（惰性创建时后台加载 + sendToPasswordOverlay await 同一 Promise） */
    this._passwordOverlayLoadPromise = null
    this._panelViews = new Map()
    /**
     * **独立侧栏**（Web Sidebar）的两份视图：内容是别人的网页，顶条是我们自己的本地页。
     *
     * 为什么不塞进 `_panelViews`：它们不是面板 —— 不进面板目录、不参与面板对账
     * （`LayoutCoordinator#reconcilePanels` 按目录 id 决定谁该被销毁，混进去会被当成
     * "目录外的野面板"当场销毁）。独立侧栏是**每窗口一个**的常驻视图，自成一家。
     * @type {{ content: Electron.WebContentsView|null, header: Electron.WebContentsView|null }}
     */
    this._webSidebar = { content: null, header: null }
    this._tabViews = new Map()
    /**
     * 每个标签视图**当前**的画布色（WeakMap：键是视图，视图回收后条目自动消失）。
     *
     * 只用于去重 —— `did-navigate` 每次导航都会要求同步一次画布色，
     * 而 `setBackgroundColor` 会触发一次合成层刷新，同值重设就是可感知的白闪。
     * @type {WeakMap<Electron.WebContentsView, string>}
     */
    this._tabCanvas = new WeakMap()
    /** 面板加载 Promise 去重，防止快速切换导致并发 loadURL */
    this._panelLoadPromises = new Map()
    /**
     * 标签 WebPreferences 的**附加项端口**（如 `accessibility.font_size` → defaultFontSize）。
     * 为什么走端口而不是直接读设置：infra 不认识 settings 领域（分层约束）；
     * 且字号**只能在创建 webContents 时下发**（Chromium 无运行时改默认字号的 API），
     * 所以由 APPS 层提供「当前该带什么附加项」，这里在建标签那一刻现取。
     * @type {(() => object) | null}
     */
    this._extraTabWebPreferences = typeof options.getExtraTabWebPreferences === 'function'
      ? options.getExtraTabWebPreferences
      : null
    /**
     * 会话解析端口（对齐 RT：按 tab 的 profile 取会话）。
     * 形如 `{ resolve({ profileId, incognito, incognitoPartitionId }) => Electron.Session }`。
     * 由 APPS 层注入 SessionsController —— infra 不认识 profile 领域，只认这个端口。
     * @type {{ resolve: Function } | null}
     */
    this._sessionResolver = options.sessionResolver || null
    /**
     * tab 身份解析端口：`(tabId) => { profileId, incognito, incognitoPartitionId } | null`。
     * 由 TabManager 注入（它是 tab 记录的 owner）。用于 `createTab(id)` 无参调用时
     * 自动补全 profile 身份 —— 避免"重新创建 view"的每条路径都要手动传 profileId。
     * @type {((tabId: string) => object | null) | null}
     */
    this._tabProfileResolver = options.tabProfileResolver || null
    /**
     * 面板视图**创建完成**端口：`(panelId, webContents) => void`。
     *
     * 为什么需要一个端口而不是让布局层去 hook：面板 renderer 里的 `window.confirm`
     * （如「删除集锦」）需要主进程侧把它接进 JS Dialog 浮层体系（`attachToWebContents`），
     * 而这件事**必须发生在面板首次加载之前** —— 面板一旦 dom-ready，注入才补得上，
     * 用户第一次点删除仍会落到系统原生对话框。视图刚建好、还没 loadURL，正是唯一的时机。
     *
     * infra 不认识 jsDialog 领域（分层约束），所以只提供"视图已就绪"这一个事件口。
     * @type {((panelId: string, wc: Electron.WebContents) => void) | null}
     */
    this._onPanelViewCreated = typeof options.onPanelViewCreated === 'function'
      ? options.onPanelViewCreated
      : null
    /** 存储每个 tab 的选项（incognito 等），wakeTab 时需要复用 */
    this._tabOptions = new Map()
    /** 已加载面板内容的 panelId（避免每次 show 都重载） */
    this._panelLoaded = new Set()
    /**
     * 外壳「表面型」子视图的底色（＝主题主表面）：侧边面板 + rail。
     *
     * `new WebContentsView()` 的默认底色是**不透明白**：页面首帧绘制之前（首次打开、
     * 切换面板的空档、重载期间），那一整块占位区域就是白的 —— 深色主题下非常刺眼。
     * 这里铺上主题主表面，由 setSurfaceBackgroundColor 跟主题更新。
     *
     * 标签视图**不在此列**：它承载网页，画布色固定为 TAB_CANVAS_COLOR（见上），
     * 主题不得改动网页自身的底色。
     */
    this._surfaceBackgroundColor = options.surfaceBackgroundColor || options.frameBackgroundColor || '#f9fafb'
    /**
     * 标签视图的宿主容器（LayoutCoordinator 的 tab 图层 View）。
     * 标签视图不直接挂在 window.contentView 下，而是挂在 tab 图层里 ——
     * 销毁/休眠时必须从这个容器摘除，否则 view 会残留在图层中。
     * @type {Electron.View|null}
     */
    this._tabHost = null
    try {
      // 窗口底（网页外圈那 4px 缝在网页绘制前的占位色）：主题会在 setTabTheme 里
      // 用 frameBackgroundColor 覆盖；构造期还没有主题，先用白纸色。
      this._win.setBackgroundColor(options.frameBackgroundColor || TAB_CANVAS_COLOR)
    } catch (_) {}
  }

  /**
   * 注入标签视图的宿主容器（由 LayoutCoordinator 在创建 tab 图层时调用）。
   * @param {Electron.View|null} host
   */
  setTabHost(host: View | null): void {
    this._tabHost = host || null
  }

  /** 从标签宿主容器摘除视图（无宿主时回退到 contentView） */
  _removeViewFromHost(view: ManagedView | null | undefined): void {
    if (!view) return
    const host = this._tabHost
    if (host) {
      try { host.removeChildView(view as unknown as View); return } catch (_) {}
    }
    if (this._win && !this._win.isDestroyed()) {
      try { this._win.contentView.removeChildView(view as unknown as View) } catch (_) {}
    }
  }

  /**
   * 从**内容视图**摘除（面板专用）。
   *
   * 为什么不复用 `_removeViewFromHost`：它有「摘到就 return」的短路。而 Electron 的
   * `removeChildView` 对**不是自己孩子**的视图既不抛错也不生效 —— 面板挂在 contentView
   * 上、不在 tabHost 里，那个短路会让 contentView 上的面板永远摘不掉（随后销毁
   * webContents 就留下一个指向已销毁页面的空壳视图，表现为整块白斑）。
   * 这里对两个容器各摘一次，谁是真宿主都能摘干净。
   */
  _removeViewFromContent(view: ManagedView | null | undefined): void {
    if (!view) return
    if (this._tabHost) {
      try { this._tabHost.removeChildView(view as unknown as View) } catch (_) {}
    }
    if (this._win && !this._win.isDestroyed()) {
      try { this._win.contentView.removeChildView(view as unknown as View) } catch (_) {}
    }
  }

  /**
   * 更新外壳表面型子视图（侧边面板 + rail）的底色。
   * 主题切换时由 LayoutCoordinator#setTabTheme 统一调用。
   *
   * 为什么不靠渲染页自己画底：这些视图在**页面绘制之前**就已经被摆到占位上，
   * 那段时间显示的是 WebContentsView 的原生默认白底 —— 深色主题下就是一块白。
   */
  setSurfaceBackgroundColor(color: string): void {
    const next = String(color || '').trim()
    if (!next) return
    this._surfaceBackgroundColor = next
    const views = [...this._panelViews.values()]
    if (this._railView) views.push(this._railView)
    for (const view of views) {
      try {
        if ('setBackgroundColor' in view && typeof view.setBackgroundColor === 'function') view.setBackgroundColor(next)
      } catch (_) {}
    }
  }

  /**
   * 设置某个标签视图的**画布色**（网页还没画出自己的底色时露出的那一层）。
   *
   * 缺省是白纸（TAB_CANVAS_COLOR）；内置新标签页传 `#00000000` —— 它必须是一块
   * **透明画布**，才能露出窗口外壳那一份唯一的壁纸（见 APPS 侧 tabCanvasColor 钩子）。
   *
   * 为什么画布色要由宿主按 URL 逐次下发，而不是在建视图时定死：
   *   · 同一张标签会在新标签页 ↔ 普通网页之间来回导航（地址栏 / 主页按钮 / 链接），
   *     画布必须跟着翻面，否则要么网页被掏空成透明、要么新标签页糊上一块白；
   *   · 休眠唤醒 / 跨窗口迁入都会重建或换主，创建路径不止一条 —— 统一在
   *     `TabManager#syncTabCanvas` 里按「当前 URL」算，所有路径只有这一份判据。
   *
   * @param {Electron.WebContentsView|null} view
   * @param {string} [color] 空串 / 缺省 = 回到默认白纸
   */
  setTabCanvas(view: ManagedView, color: string): void {
    if (!(view instanceof WebContentsView) || !view.webContents) return
    const next = String(color || '').trim() || TAB_CANVAS_COLOR
    // 同值直接跳过：did-navigate 每次导航都来一次，无谓重设 = 一次白闪
    if (this._tabCanvas.get(view) === next) return
    this._tabCanvas.set(view, next)
    try { view.setBackgroundColor(next) } catch (_) {}
  }

  /**
   * 注入会话解析端口（对齐 RT：按 tab 所属 profile 取会话）。
   * 优先级：createTab 的显式 session > sessionResolver.resolve(...) > setTabSession 的全局兜底。
   * @param {{ resolve: Function } | null} resolver
   */
  setSessionResolver(resolver: { resolve(options: TabIdentity): Session } | null): void {
    this._sessionResolver = resolver || null
  }

  /**
   * 注入 tab 身份解析端口（由 TabManager 注入，它是 tab 记录的 owner）。
   * createTab(id) 无参调用时用它补全 profile 身份，避免每条重建路径都手传 profileId。
   * @param {((tabId: string) => object | null) | null} resolver
   */
  setTabProfileResolver(resolver: ((tabId: string) => TabIdentity | null) | null): void {
    this._tabProfileResolver = typeof resolver === 'function' ? resolver : null
  }

  /**
   * 解析 tab 的 profile 身份（profileId / incognito / incognitoPartitionId）。
   * @param {string} tabId
   * @returns {{ profileId?: string, incognito?: boolean, incognitoPartitionId?: string }}
   */
  _resolveTabProfile(tabId: string): TabIdentity {
    if (!this._tabProfileResolver) return {}
    try {
      return this._tabProfileResolver(String(tabId)) || {}
    } catch (error: unknown) {
      console.error('[wcm] tabProfileResolver failed:', error instanceof Error ? error.message : error)
      return {}
    }
  }

  /**
   * 经端口解析会话（不含全局兜底；兜底由 createTab 按优先级处理）。
   * @param {{ profileId?: string, incognito?: boolean, incognitoPartitionId?: string }} opts
   * @returns {Electron.Session | null}
   */
  _resolveSession(opts: TabIdentity = {}): Session | null {
    if (this._sessionResolver && typeof this._sessionResolver.resolve === 'function') {
      try {
        const resolved = this._sessionResolver.resolve(opts)
        if (resolved) return resolved
      } catch (error: unknown) {
        console.error('[wcm] sessionResolver failed:', error instanceof Error ? error.message : error)
      }
    }
    return null
  }

  /**
   * 获取「浏览器外壳（chrome）」基座。
   *
   * 归一模型（对齐 RT `FakeWebContentsViewLayer`）：chrome 就是**窗口自身的 webContents**，
   * 不再创建独立 WebContentsView —— 因此 chrome 天然铺满窗口、天然位于所有子视图之下，
   * 无需 setBounds / addChildView / 显隐切换。返回的 ChromeView 只是让
   * `createUiShell().webContents` 这类既有取用路径继续成立。
   * @returns {ChromeView}
   */
  createUiShell() : ChromeView {
    if (this._uiShellView) return this._uiShellView
    this._uiShellView = new ChromeView(this._win)
    return this._uiShellView
  }

  async loadUiShell() {
    const shell = this._uiShellView || this.createUiShell()
    const wc = shell.webContents
    if (!wc || wc.isDestroyed()) return

    const devServerUrl = process.env.VITE_DEV_SERVER_URL || process.env.ELECTRON_RENDERER_URL
    const rendererHtmlPath = path.join(getAppRoot(), 'out', 'renderer', 'app-shell', 'index.html')
    const rendererTarget = devServerUrl ? `${devServerUrl}/app-shell/` : rendererHtmlPath
    if (devServerUrl) {
      await wc.loadURL(rendererTarget)
      return
    }

    await wc.loadFile(rendererHtmlPath)
  }

  async captureUiShell() {
    const shell = this._uiShellView || this.createUiShell()
    const wc = shell.webContents
    return wc ? wc.capturePage() : null
  }

  /**
   * 创建某个浮层的独立 WebContentsView（searchbar 下拉 / tab preview / permission 等）。
   *
   * **彻底解耦原则**：每个浮层一个专属 view，绝不共用图层 ——
   * 避免多个浮层争抢同一 view 的 bounds 导致闪烁/串扰/互斥失效。
   * 透明背景、复用 shell-preload 提供 IPC bridge。
   * 默认 bounds 0x0（由 LayoutCoordinator 初始化），不占空间也不拦截鼠标。
   *
   * @param {string} name 浮层逻辑名（同时是 renderer 目录名）
   * @returns {Electron.WebContentsView}
   */
  createFloatView(name: string): WebContentsView {
    const key = String(name)
    const existing = this._floatViews.get(key)
    if (existing) return existing

    const view = new WebContentsView({
      // `backgroundThrottling: false`：浮层统一用 0×0 + 保持 visible 来"收起"
      // （见 LayoutCoordinator#_ensureFloatView），而 Chromium 会把这种零面积视图判成
      // **occluded** —— 定时器降到 1Hz、rAF 直接停摆。菜单类浮层（空间切换 / 站点信息 /
      // 选择目标）在收起态仍要做布局测量与提交前准备，被节流就等于"打开时要补课"，
      // 肉眼是一下卡顿。浮层数量少、闲置还会被回收，这点常驻开销换的是**随开随显**。
      webPreferences: buildWebPreferences({ backgroundThrottling: false })
    })

    // 透明背景，让非浮层区域透出下层网页
    view.setBackgroundColor('#00000000')
    // WebContentsView 不支持 setIgnoreMouseEvents，用 setBounds 0x0 实现隐藏

    // 加载期诊断监听挂在这里（而不是 loadFloatView）—— 本函数有 `_floatViews` 缓存，
    // 每个 webContents 只会走到一次；而 loadFloatView 的去重 Promise 在**失败时会删掉**，
    // 重试会在同一个 webContents 上再挂一遍，监听器越积越多（Node 还会报 MaxListeners）。
    const wc = view.webContents
    wc.on('did-fail-load', (_e, code, desc, url) => console.error(`[float:${key}] did-fail-load`, code, desc, url))
    wc.on('preload-error', (_e, p, err) => console.error(`[float:${key}] preload-error`, p, err && err.message))
    // 浮层是独立 renderer：它的 JS 异常默认只出现在**那个**视图的 devtools 里，
    // 主进程终端完全看不到 —— 「点了没反应」这类问题会因此变成无日志的黑洞。
    // 这两个监听只做转发，不改变任何行为。
    wc.on('console-message', (event) => {
      if (event.level !== 'error' && event.level !== 'warning') return
      console.error(`[float:${key}] console:`, event.message, `${event.sourceId || ''}:${event.lineNumber}`)
    })
    let crashAttempts = 0
    let lastCrashAt = 0
    wc.on('render-process-gone', (_e, details) => {
      console.error(`[float:${key}] render-process-gone`, details && details.reason, details && details.exitCode)
      if (!details || details.reason === 'clean-exit') return
      const now = Date.now()
      if (now - lastCrashAt > 60_000) crashAttempts = 0
      lastCrashAt = now
      if (crashAttempts >= 3) {
        console.error(`[float:${key}] renderer crashed repeatedly; automatic recovery stopped`)
        return
      }
      crashAttempts += 1
      // 同一 WebContentsView 的 renderer 崩溃后页面是空的。重载页面本身；
      // 权限浮层会在 ready 时让外壳重推 pending，避免恢复成一块空白浮层。
      this._floatLoadPromises.delete(key)
      const timer = setTimeout(() => {
        if (wc.isDestroyed()) return
        this.loadFloatView(key).catch((error: unknown) => {
          console.error(`[float:${key}] crash recovery failed:`, error instanceof Error ? error.message : String(error))
        })
      }, 250 * crashAttempts)
      if (typeof timer.unref === 'function') timer.unref()
    })

    this._floatViews.set(key, view)
    return view
  }

  /**
   * 销毁某个浮层的 WebContentsView（**释放它的渲染进程**），保留"逻辑名"这个槽位。
   *
   * 与标签的 `sleepTab` 同一思路：视图与页面一起销毁，下次 `createFloatView(name)`
   * 重建视图并重新加载页面 —— 布局层那边不需要任何特殊处理，
   * 因为 `LayoutCoordinator#_ensureFloatView` 本来就是「表里没有就建」。
   *
   * 为什么值得做：**每个浮层都是一个独立的 renderer 进程**。chrome 这些浮层
   * （查找栏 / 缩放条 / 拖放落点 / 悬停 URL…）绝大多数时间不显示，而一个 renderer
   * 即使 bounds 为 0×0、鼠标穿透，它的进程仍然常驻（实测：独占 ~22 MB、工作集 ~108 MB）。
   * 窗口开上一段时间后所有浮层都被创建过一遍却再没显示过 —— 那是纯粹的浪费。
   *
   * ⚠ 调用方（LayoutCoordinator#_reclaimFloatView）必须先确认它**当前不可见且无交互**。
   *
   * @param {string} name 浮层逻辑名
   * @returns {boolean} 是否真的销毁了一个视图
   */
  destroyFloatView(name: string): boolean {
    const key = String(name)
    // ⚠ 加载去重 Promise 必须**无条件**清（不能放在 `if (!view)` 之后）——
    // 与 destroyTab 的 `_tabOptions` 是同一个教训：视图可能已经不在表里
    // （比如上一次加载失败后被清过），那条 Promise 却还留着。
    this._floatLoadPromises.delete(key)
    const view = this._floatViews.get(key)
    if (!view) return false
    this._floatViews.delete(key)
    // ⚠ 用**内容视图**版而不是 `_removeViewFromHost`：后者「摘到就 return」，
    // 而浮层挂在 contentView 上、不是 tabHost 的孩子 ——
    // Electron 对「不是我孩子」的 removeChildView 既不抛错也不生效，
    // 于是那个短路会让浮层永远摘不掉（视图留着、webContents 已销毁 = 一块空壳）。
    this._removeViewFromContent(view)
    try {
      const wc = view.webContents
      if (wc && !wc.isDestroyed()) destroyWebContents(wc)
    } catch (_) {}
    return true
  }

  /**
   * 加载某个浮层页面（out/renderer/<name>/index.html）。
   * @param {string} name 浮层逻辑名
   */
  async loadFloatView(name: string): Promise<unknown> {
    const key = String(name)
    const existing = this._floatLoadPromises.get(key)
    if (existing) return existing

    const loadPromise = (async () => {
      const view = this.createFloatView(key)
      const wc = view.webContents

      const devServerUrl = process.env.VITE_DEV_SERVER_URL || process.env.ELECTRON_RENDERER_URL
      if (devServerUrl) {
        await wc.loadURL(`${devServerUrl}/${key}/index.html`)
        return
      }
      await wc.loadFile(path.join(getAppRoot(), 'out', 'renderer', key, 'index.html'))
    })()

    this._floatLoadPromises.set(key, loadPromise)
    try {
      await loadPromise
    } catch (error) {
      this._floatLoadPromises.delete(key)
      throw error
    }
  }

  /**
   * 创建密码浮层独立视图（多凭据选择菜单 / 保存密码提示卡）。
   * 与通用 overlay（searchbar 下拉 / permission）完全解耦：
   * 独立 WebContentsView、独立页面、独立 bounds 与交互开关，图层在通用 overlay 之上。
   */
  createPasswordOverlay() {
    if (this._passwordOverlayView) return this._passwordOverlayView

    // focusable:false —— 多凭据菜单 / 保存提示卡都是「按钮列表」，鼠标点击即可。
    // 若允许聚焦，它弹出时会把键盘焦点从网页密码框抢走（用户正在输密码 → 打不进去）。
    const view = new WebContentsView({ webPreferences: buildWebPreferences() })

    // 透明背景：非浮层区域透出下层网页
    view.setBackgroundColor('#00000000')

    // 监听只跟 webContents 绑定一次。加载失败后的重试复用的是同一个 wc，
    // 若把监听放在 loadPasswordOverlay 的异步体里，每次重试都会再挂一套并持续累积。
    const wc = view.webContents
    wc.on('did-fail-load', (_e, code, desc, url) => console.error('[pw-overlay] did-fail-load', code, desc, url))
    wc.on('preload-error', (_e, preloadPath, err) => console.error('[pw-overlay] preload-error', preloadPath, err && err.message))
    let crashAttempts = 0
    let lastCrashAt = 0
    wc.on('render-process-gone', (_e, details) => {
      console.error('[pw-overlay] render-process-gone', details && details.reason, details && details.exitCode)
      if (!details || details.reason === 'clean-exit') return
      const now = Date.now()
      if (now - lastCrashAt > 60_000) crashAttempts = 0
      lastCrashAt = now
      if (crashAttempts >= 3) {
        console.error('[pw-overlay] renderer crashed repeatedly; automatic recovery stopped')
        return
      }
      crashAttempts += 1
      this._passwordOverlayLoadPromise = null
      const timer = setTimeout(() => {
        if (wc.isDestroyed()) return
        this.loadPasswordOverlay().catch((error: unknown) => {
          console.error('[pw-overlay] crash recovery failed:', error instanceof Error ? error.message : String(error))
        })
      }, 250 * crashAttempts)
      if (typeof timer.unref === 'function') timer.unref()
    })

    this._passwordOverlayView = view
    return view
  }

  /**
   * 销毁密码浮层视图（**释放它的渲染进程**），保留"逻辑名"这个槽位。
   *
   * 与 `destroyFloatView` / `destroyPanel` 同一思路：视图与页面一起销毁，
   * 下次要用时 `createPasswordOverlay` + `loadPasswordOverlay` 重建。
   *
   * 为什么需要它：密码浮层（多凭据选择菜单 / 保存密码提示卡）**只有创建、此前没有任何销毁路径**
   * —— 用户第一次遇到"保存密码"之后，那份 renderer 就永久常驻了。而它是**极低频**的东西
   * （一个 renderer ≈ 104MB 工作集 / 25MB 独占），长期挂着纯属浪费。
   *
   * ⚠ 调用方（`LayoutCoordinator#_reclaimPasswordOverlay`）必须先确认它**当前不可见**。
   *
   * @returns {boolean} 是否真的销毁了一个视图
   */
  destroyPasswordOverlay() : boolean {
    // 加载去重 Promise 必须**无条件**清（与 destroyTab / destroyFloatView 同一教训）——
    // 不清的话重建时会命中缓存直接 return，页面永远不出来。
    this._passwordOverlayLoadPromise = null
    const view = this._passwordOverlayView
    if (!view) return false
    this._passwordOverlayView = null
    this._removeViewFromContent(view)
    try {
      const wc = view.webContents
      if (wc && !wc.isDestroyed()) destroyWebContents(wc)
    } catch (_) {}
    return true
  }

  async loadPasswordOverlay() {
    if (this._passwordOverlayLoadPromise) return this._passwordOverlayLoadPromise
    const overlay = this._passwordOverlayView || this.createPasswordOverlay()

    const loadPromise = (async () => {
      const wc = overlay.webContents
      const devServerUrl = process.env.VITE_DEV_SERVER_URL || process.env.ELECTRON_RENDERER_URL
      if (devServerUrl) {
        await wc.loadURL(`${devServerUrl}/password-overlay/index.html`)
        return
      }

      const rendererHtmlPath = path.join(getAppRoot(), 'out', 'renderer', 'password-overlay', 'index.html')
      await wc.loadFile(rendererHtmlPath)
    })()

    this._passwordOverlayLoadPromise = loadPromise
    try {
      await loadPromise
    } catch (error) {
      this._passwordOverlayLoadPromise = null
      throw error
    }
  }

  /**
   * 创建 Rail 视图（左侧任务栏独立图层）。
   * 复用 shell-preload，提供相同的 IPC bridge。
   */
  createRail() {
    if (this._railView) return this._railView

    const view = new WebContentsView({ webPreferences: buildWebPreferences() })

    // 同面板：铺主题底色，避免页面绘制前露出原生白底（深色下是白条）
    try { view.setBackgroundColor(this._surfaceBackgroundColor) } catch (_) {}

    this._railView = view
    return view
  }

  async loadRail() {
    const rail = this._railView || this.createRail()

    const devServerUrl = process.env.VITE_DEV_SERVER_URL || process.env.ELECTRON_RENDERER_URL
    if (devServerUrl) {
      await rail.webContents.loadURL(`${devServerUrl}/rail/index.html`)
      return
    }

    const rendererHtmlPath = path.join(getAppRoot(), 'out', 'renderer', 'rail', 'index.html')
    await rail.webContents.loadFile(rendererHtmlPath)
  }

  /**
   * 造一个面板视图。
   *
   * 面板视图**只有一种**：加载我们自己的本地渲染页（`out/renderer/panels/`）。
   * 曾经的 `spec` 参数（"配方"：webPreferences / UA / 远程 url）随「网页不该是面板」
   * 那套实现一起移除了 —— 面板回到"给我一个 id，我给你一个视图"这么简单。
   *
   * @param {string} panelId
   */
  createPanel(panelId: string): WebContentsView {
    const existing = this._panelViews.get(panelId)
    if (existing) return existing
    const view = new WebContentsView({
      // `backgroundThrottling: false`：面板"藏着"时用 0×0 + visible（见下面的说明），
      // 而 Chromium 会把这种视图判成 **occluded** —— 定时器降到 1Hz、rAF 直接停摆，
      // 于是装载期间的骨架/过渡/资源解码全被踩刹车，真正显示那一刻才"补课"。
      // 面板生命周期短、同一时刻最多两个槽位各一块 —— 这点常驻开销换来的是"显示即完整"。
      webPreferences: buildWebPreferences({ preload: defaultPreloadPath('panel'), backgroundThrottling: false })
    })
    // 铺主题底色：面板视图默认是不透明白，页面首帧绘制前 / 切换空档会整块闪白
    try { view.setBackgroundColor(this._surfaceBackgroundColor) } catch (_) {}
    /**
     * 新视图用 **0×0 + 保持 visible** 来"藏着"，**不用 `setVisible(false)`** ——
     * 这条与浮层（见 `LayoutCoordinator#_ensureFloatView` 的说明）同一口径，原因在合成器：
     * `setVisible(false)` 会让 Chromium 把页面当成 hidden，**它的合成层是等到首次
     * `setVisible(true)` 才建的** —— 于是"新面板刚显示的那一帧"是空白/底色，内容晚一两帧
     * 才出来，肉眼就是**面板内容区闪一下**（用户反馈的现象）。
     * 0×0 则是"可见但零面积"：合成层一直建着、页面一直在画，显示时只需把 bounds 一改，
     * 内容**立刻**就在那儿了。
     */
    try { view.setBounds({ x: 0, y: 0, width: 0, height: 0 }) } catch (_) {}

    // 加载期诊断：面板与浮层一样是**独立 renderer**，异常只活在那个视图的 devtools 里，
    // 主进程终端完全看不到 —— 于是「面板白屏」就是零日志的黑洞（已踩过：injectStyles 抛错）。
    // 只转发，不改变任何行为；与 `createFloatView` 同一口径（同一份 EventEmitter 语义）。
    const wc = view.webContents
    wc.on('did-fail-load', (_e, code, desc, url) => console.error(`[panel:${panelId}] did-fail-load`, code, desc, url))
    wc.on('preload-error', (_e, p, err) => console.error(`[panel:${panelId}] preload-error`, p, err && err.message))
    wc.on('console-message', (event) => {
      if (event.level !== 'error' && event.level !== 'warning') return
      console.error(`[panel:${panelId}] console:`, event.message, `${event.sourceId || ''}:${event.lineNumber}`)
    })
    wc.on('render-process-gone', (_e, details) => {
      console.error(`[panel:${panelId}] render-process-gone`, details && details.reason, details && details.exitCode)
    })

    this._panelViews.set(panelId, view)
    // 视图已建好、尚未 loadURL —— 把 webContents 交给 APPS 层接管（见构造函数里的端口说明）。
    if (this._onPanelViewCreated) {
      try {
        this._onPanelViewCreated(panelId, wc)
      } catch (error: unknown) {
        console.error(`[panel:${panelId}] onPanelViewCreated failed:`, error instanceof Error ? error.message : error)
      }
    }
    return view
  }

  /** 只获取已存在的面板视图，不创建（布局层专用，避免副作用） */
  getPanel(panelId: string): WebContentsView | null {
    return this._panelViews.get(String(panelId)) || null
  }

  /**
   * 加载面板内容：`out/renderer/panels/index.html?panelId=xxx`（dev 下走 dev server）。
   *
   * 首次显示时加载；**关闭面板即销毁视图**（见 LayoutCoordinator 的"关闭即卸载"），
   * 所以"再次 show 只 attach、不重载"只覆盖"面板一直开着 / 在两个槽位之间移动"这段，
   * 并非永久常驻 —— 关掉再打开会重新加载（这正是"面板不再是只增不减"的代价）。
   * 使用 Promise 去重，防止快速切换导致并发 loadURL 竞争。
   * @param {string} panelId
   * @param {Record<string, string>} [extraQuery] 附带的**加载提示**（标题 / 归属插件 id）。
   *   infra 只负责透传到 URL，不认识这些字段的含义 —— 面板页在模块求值阶段就能读到，
   *   于是「画壳」不必再等一次 `panel:catalog` 往返（见 panels/main.js 的 boot）。
   */
  async loadPanel(panelId: string, extraQuery?: Record<string, string>): Promise<unknown> {
    const id = String(panelId)
    const existing = this._panelLoadPromises.get(id)
    if (existing) return existing

    if (this._panelLoaded.has(id)) return

    const startedAt = Date.now()
    const view = this.createPanel(id)
    const hints = extraQuery && typeof extraQuery === 'object' ? extraQuery : null
    const query = hints ? Object.assign({ panelId: id }, hints) : { panelId: id }
    const loadPromise = (async () => {
      await this._loadViewTarget(view, { page: 'panels', query })
      // 加载期间该面板可能已被 destroyPanel（插件被禁用）——此时视图已不在册，
      // 再往 _panelLoaded 里记一次会让「重新启用后首次打开」直接跳过加载、白屏。
      if (this._panelViews.has(id)) this._panelLoaded.add(id)
    })()

    this._panelLoadPromises.set(id, loadPromise)
    try {
      await loadPromise
    } catch (error: unknown) {
      this._panelLoadPromises.delete(id)
      let destroyed = false
      try { destroyed = !!(view && view.webContents && view.webContents.isDestroyed()) } catch (_) {}
      const registered = this._panelViews.get(id) === view
      console.error(
        `[wcm] loadPanel(${id}) failed:`, error instanceof Error ? error.message : error,
        `| destroyed=${destroyed} registered=${registered} elapsed=${Date.now() - startedAt}ms`
      )
      throw error
    }
  }

  /**
   * 把一份加载目标（`{ url }` 或 `{ page, query }`）加载进任意视图。
   *
   * 面板内容与面板顶条共用这一处分支：两份调用各写一遍，迟早只有一边跟上 dev server
   * 与 `out/renderer/<page>/` 的变化（本项目的老毛病：同一件事两处实现必然漂移）。
   */
  async _loadViewTarget(view: WebContentsView, load: { url?: string; page?: string; query?: Record<string, string> }): Promise<void> {
    const target = load && typeof load === 'object' ? load : {}
    if (target.url) {
      await view.webContents.loadURL(String(target.url))
      return
    }
    const page = String(target.page || 'panels')
    const query = target.query && typeof target.query === 'object' ? target.query : {}
    const devServerUrl = process.env.VITE_DEV_SERVER_URL || process.env.ELECTRON_RENDERER_URL
    if (devServerUrl) {
      const qs = new URLSearchParams(query).toString()
      await view.webContents.loadURL(`${devServerUrl}/${page}/${qs ? `?${qs}` : ''}`)
      return
    }
    await view.webContents.loadFile(path.join(getAppRoot(), 'out', 'renderer', page, 'index.html'), { query })
  }

  // ═══════════════════════════════════════════════════════════════════
  //  独立侧栏（Web Sidebar）
  //
  //  与标签视图**同一套底层**（同 `buildTabWebPreferences` + 同一条 session 解析链）——
  //  这是"功能完整"的全部秘密：它不是被砍过的第二类容器，而是与标签一模一样的网页视图。
  //  两者的差别只在**位置**（住侧栏而不是铺满内容区）与**谁摆它**（布局层的新区域）。
  // ═══════════════════════════════════════════════════════════════════

  /**
   * 造侧栏**内容**视图（每窗口一份，幂等）。
   *
   * 为什么用 `buildTabWebPreferences` 而不是任何"精简版"：任何一处差别都会让
   * 侧栏里的网页与标签里的网页**行为分叉**（滚动惯性、对话框策略、拖放导航、
   * `window.hira` 桥、扩展注入…），最终表现为"侧栏里这页是坏的"。
   * 身份（profile / 无痕）与标签走同一条 `_resolveSession` 链 → 同 session、同登录态。
   *
   * @param {{ profileId?: string, incognito?: boolean }} [identity]
   */
  createWebSidebarView(identity: TabIdentity = {}): WebContentsView {
    if (this._webSidebar.content) return this._webSidebar.content
    let extraTabPrefs = {}
    if (this._extraTabWebPreferences) {
      try { extraTabPrefs = this._extraTabWebPreferences() || {} } catch (_) { extraTabPrefs = {} }
    }
    const webPrefs = buildTabWebPreferences({ preload: defaultPreloadPath('tab'), ...extraTabPrefs })
    const resolved = this._resolveSession({
      profileId: identity.profileId,
      incognito: identity.incognito,
      incognitoPartitionId: identity.incognitoPartitionId
    })
    if (resolved) webPrefs.session = resolved
    const view = new WebContentsView({ webPreferences: webPrefs })
    // 与标签同一口径：新建默认不可见，由布局层在真正显示时 setVisible(true)。
    try { view.setVisible(false) } catch (_) {}
    // 侧栏里装的是别人的网页 —— 同样是白纸画布，不跟主题
    try { view.setBackgroundColor(TAB_CANVAS_COLOR) } catch (_) {}
    this._webSidebar.content = view
    return view
  }

  getWebSidebarView() {
    return this._webSidebar.content
  }

  /**
   * 造侧栏**顶条**视图（每窗口一份，幂等）：本地页 `out/renderer/web-sidebar-header/`。
   *
   * 顶条是我们自己的页面，用 `panel` preload 才拿得到 `window.hira`（把命令发回主进程）。
   * 内容页与顶条**不共用 webPreferences** —— 那条差异就是"谁能拿到 window.hira"的边界，
   * 但两者现在都是我们的页面（远程网页只住在内容视图里）。
   */
  createWebSidebarHeaderView() {
    if (this._webSidebar.header) return this._webSidebar.header
    const view = new WebContentsView({
      webPreferences: buildWebPreferences({ preload: defaultPreloadPath('panel') })
    })
    try { view.setVisible(false) } catch (_) {}
    /**
     * **透明底** —— 顶条的底与那两个圆角由它自己的 DOM 画。
     *
     * 为什么不用原生底色：原生 `setBorderRadius` 只能四角同值，而顶条要"上圆下平"
     *（下边与侧栏里的网页连成一整块，带圆角会在接缝处咬出豁口，见 LayoutCoordinator
     * 的 `_placeWebSidebar`）。所以原生这层保持透明、圆角归 DOM，
     * 也让布局层能用 `setBorderRadius(0)` 而不至于露出一块方角底。
     */
    try { view.setBackgroundColor('#00000000') } catch (_) {}
    this._webSidebar.header = view
    Promise.resolve(this._loadViewTarget(view, { page: WEB_SIDEBAR_HEADER_PAGE })).catch((e) => {
      console.error('[wcm] loadWebSidebarHeader failed:', e && e.message)
    })
    return view
  }

  getWebSidebarHeaderView() {
    return this._webSidebar.header
  }

  /** 销毁侧栏的两份视图与它们的渲染进程（窗口关闭 / 显式重建时用）。 */
  destroyWebSidebarViews(): boolean {
    const out = { ...this._webSidebar }
    this._webSidebar = { content: null, header: null }
    for (const view of [out.content, out.header]) {
      if (!view) continue
      this._removeViewFromContent(view)
      try {
        if (view.webContents && !view.webContents.isDestroyed()) destroyWebContents(view.webContents)
      } catch (_) {}
    }
    return !!(out.content || out.header)
  }

  // 注意：**不存在启动期预热**。对齐 RT —— 启动期绝不创建任何面板 renderer。
  // 面板视图与内容一律延迟到**用户意图**出现时才创建/加载：
  //   · 悬停/按下入口 → LayoutCoordinator#preparePanel（单槽预取，见下方）
  //   · 真正打开      → loadPanel()（若预取已在途，这里只等同一个 Promise）

  reloadPanel(panelId: string): Promise<unknown> | boolean {
    const view = this._panelViews.get(panelId)
    if (!view) return false
    view.webContents.reload()
    return true
  }

  /**
   * 已创建的面板 id 列表（对账用：谁已被创建、谁该被销毁）。
   * 与 `getPanelViews()` 的区别：只给 id，不把 Electron 视图对象交出去。
   */
  listPanelIds(): string[] {
    return Array.from(this._panelViews.keys())
  }

  /**
   * 销毁面板视图并**释放它的渲染进程**。
   *
   * 什么时候用：**面板关闭时**（`LayoutCoordinator` 的"关闭即卸载"，每个面板
   * 就是一个独立 renderer 进程，实测 ~104MB 工作集 / ~30MB 独占）以及面板插件被禁用 / 卸载。
   * 此前全链路只有 `setVisible(false)`，面板视图**只增不减** —— 每个开过的面板都常驻一个
   * 渲染进程 + 一份合成器内存，与「合理释放、极致流畅」的目标相反。
   *
   * 三件事必须一起做，少一件都会留下脏状态：
   *   1. 从 contentView 摘除（否则留下指向已销毁页面的空壳视图 = 白斑）；
   *   2. destroy 掉 webContents（真正释放渲染进程）；
   *   3. 清掉 _panelLoaded / _panelLoadPromises 两个记忆集合 —— 不清的话
   *      「关闭后再打开」会命中记忆直接 return，页面永远不出来。
   *
   * **关闭绝不打断在途加载**：视图的"存在性"（`_panelViews` / 布局图层）与
   * webContents 的生命周期在这里刻意分开 —— 先在同步段里摘册子 + 摘图层
   * （对上层而言面板已经不存在，重开必然造新视图），但 `destroy()` 推迟到
   * 该次加载落定（`did-stop-loading` / `render-process-gone` / 兜底超时）。
   * 理由是 Electron 的硬行为：加载途中 destroy 会让在途 `loadURL` 以
   * `ERR_FAILED (-2)` 拒绝，而 `did-fail-load` 不会触发（监听器已随
   * webContents 消失），只剩一条无上下文的报错（详见 PANEL_LOAD_ABORT_GRACE_MS）。
   *
   * @param {string} panelId
   * @returns {boolean} 是否真的销毁了一个存在的面板
   */
  destroyPanel(panelId: string): boolean {
    const id = String(panelId)
    const view = this._panelViews.get(id)
    if (!view) return false

    const wc = view.webContents || null
    const inFlight = this._panelLoadPromises.get(id) || null
    // 同步段摘册子：此后 loadPanel 必须造新视图，不能再复用/等待旧 Promise。
    this._panelViews.delete(id)
    this._panelLoaded.delete(id)
    this._panelLoadPromises.delete(id)
    this._removeViewFromContent(view)

    const teardown = () => {
      try {
        if (wc && !wc.isDestroyed()) destroyWebContents(wc)
      } catch (_) {}
    }
    let loading = false
    try {
      loading = !!(wc && !wc.isDestroyed() && wc.isLoading())
    } catch (_) {}
    if (!loading) {
      teardown()
      return true
    }

    let done = false
    let timer: ReturnType<typeof setTimeout> | null = null
    const finish = () => {
      if (done) return
      done = true
      try { wc.removeListener('did-stop-loading', finish) } catch (_) {}
      try { wc.removeListener('render-process-gone', finish) } catch (_) {}
      if (timer) {
        clearTimeout(timer)
        timer = null
      }
      teardown()
    }
    try {
      wc.once('did-stop-loading', finish)
      wc.once('render-process-gone', finish)
    } catch (_) {}
    timer = setTimeout(finish, PANEL_LOAD_ABORT_GRACE_MS)
    if (typeof timer.unref === 'function') timer.unref()
    // 在途 Promise 必然以「加载被中断」收场，这里先兜住，避免 unhandled rejection。
    if (inFlight) {
      try { inFlight.catch(() => {}) } catch (_) {}
    }
    return true
  }

  /**
   * 列出所有「Chrome 层」webContents（chrome 窗口本体 / rail / panels / floats / password-overlay），
   * 排除标签页 webContents。
   *
   * 性能关键：tab:changed / settings:changed / theme:changed 等事件只需通知浏览器外壳
   * （navbar、rail、侧边面板、浮层），不需要广播给每一个标签页 webContents。
   * 旧实现用 webContents.getAllWebContents() 会把事件发送给所有标签页，
   * N 个标签 = N 倍 IPC 流量，页面加载期间事件密集触发时直接拖垮主进程。
   *
   * @returns {Electron.WebContents[]}
   */
  listChromeWebContents(): WebContents[] {
    const out: WebContents[] = []
    const push = (view: ManagedView | null | undefined): void => {
      if (view && view.webContents && !view.webContents.isDestroyed()) out.push(view.webContents)
    }
    push(this._uiShellView)
    push(this._railView)
    for (const v of this._panelViews.values()) push(v)
    for (const v of this._floatViews.values()) push(v)
    push(this._passwordOverlayView)
    return out
  }

  /**
   * 列出当前窗口中所有标签页 webContents（不含 chrome 层）。
   *
   * 与 `listChromeWebContents` 互补：那个方法刻意排除标签页（广播场景 N 倍流量），
   * 但「用户点了网页 → 收起浮层」这类侦测恰恰只需要**标签页**这一侧。
   * 只回答事实，不参与任何生命周期管理。
   * @returns {Electron.WebContents[]}
   */
  listTabWebContents(): WebContents[] {
    const out: WebContents[] = []
    for (const view of this._tabViews.values()) {
      if (view && view.webContents && !view.webContents.isDestroyed()) out.push(view.webContents)
    }
    return out
  }

  /**
   * 按 webContents 反查它所属的 contentView 子视图（wc → view 的**唯一反查入口**）。
   *
   * 为什么需要它：面板 / 浮层都是**独立的 WebContentsView**，它们渲染层里的
   * `getBoundingClientRect()` 给出的是「视图内坐标」；而主进程锚定弹窗用的是
   * 「窗口内容区坐标」，两者差一个视图落点偏移。要知道这个偏移，先得回答
   * 「这个 wc 属于哪个视图」—— 视图表（面板 / 浮层 / 标签…）只在这里，
   * 其它模块无法反查，这就是缺口。
   *
   * 本方法**只做反查，不算坐标**：偏移量是布局的事，见
   * `LayoutCoordinator#getViewContentOffset`（复用同一条链路）。
   *
   * 覆盖范围：窗口本体（chrome）/ rail / 面板 / 浮层 / 密码浮层 / 标签。
   * 窗口本体也会被命中（kind 'shell'），让调用方统一走一条路径而无需特判。
   *
   * 歧义即放弃：同一 wc 命中多个视图（视图表被写坏 / 未来出现共享 wc）时返回 null ——
   * 宁可让调用方退化到默认锚点，也绝不猜哪一个才对。
   * @param {Electron.WebContents} wc
   * @returns {{ kind: 'shell'|'rail'|'panel'|'float'|'password-overlay'|'tab'|'web-sidebar', id: string, view: Electron.View }|null}
   */
  findViewByWebContents(wc: WebContents): ViewHit | null {
    if (!wc || (typeof wc.isDestroyed === 'function' && wc.isDestroyed())) return null
    /** @type {Array<{ kind: string, id: string, view: Electron.View }>} */
    const hits: ViewHit[] = []
    const probe = (view: ManagedView | null | undefined, kind: ViewHit['kind'], id: string): void => {
      if (view && view.webContents === wc) hits.push({ kind, id: String(id), view })
    }
    probe(this._uiShellView, 'shell', 'ui-shell')
    probe(this._railView, 'rail', 'rail')
    probe(this._webSidebar.content, 'web-sidebar', 'content')
    probe(this._webSidebar.header, 'web-sidebar', 'header')
    for (const [id, v] of this._panelViews) probe(v, 'panel', id)
    for (const [id, v] of this._floatViews) probe(v, 'float', id)
    probe(this._passwordOverlayView, 'password-overlay', 'password-overlay')
    for (const [id, v] of this._tabViews) probe(v, 'tab', id)
    return hits.length === 1 ? hits[0] : null
  }

  /**
   * 创建或获取标签 WebContentsView（同一 tabId 幂等复用）。
   */
  createTab(tabId: string, options: TabCreateOptions = {}): WebContentsView | undefined {
    const id = String(tabId)
    if (this._tabViews.has(id)) return this._tabViews.get(id)

    // 对齐 RT tab.ts#createWebContentsView：window.open 时 Electron 可能已在
    // constructorOptions 里**预建好** webContents（foreground-tab / new-window）。
    // 直接复用它 —— 避免在点击回调里同步 `new WebContentsView`（会同步拉起渲染进程，
    // 阻塞主进程 →「点新标签链接卡一会儿」）。该对象是**一次性**的，绝不能进
    // _tabOptions：休眠唤醒会复用到已销毁的 webContents（崩溃/泄漏）。
    const injectedWebContents = options && options.webContents ? options.webContents : null
    if (options && options.webContents) {
      options = { ...options }
      delete options.webContents
    }

    // 首次创建时记录 options，wakeTab 时复用（profile / incognito session 不能丢失）。
    // 后续调用携带的新字段做「只补不覆盖」合并：旧路径首次建 tab 时可能没带 profileId，
    // 后续带上了就补进去；但 incognito 等首建值绝不覆盖（会话不可中途切换）。
    if (!this._tabOptions.has(id)) {
      this._tabOptions.set(id, { ...options })
    } else if (options && Object.keys(options).length > 0) {
      const stored = this._tabOptions.get(id)
      if (!stored) return this._tabViews.get(id)
      for (const k of Object.keys(options)) {
        if (stored[k] === undefined && options[k] !== undefined) stored[k] = options[k]
      }
    }
    const opts = this._tabOptions.get(id) || {}

    // profile 身份补全：createTab(id) 无参调用时，向 TabManager（tab 记录 owner）索取
    // 该 tab 的 profileId / incognito。已显式提供者优先，绝不被端口值覆盖。
    const ident: TabIdentity = {}
    if (opts.profileId === undefined || opts.incognito === undefined) {
      const resolved = this._resolveTabProfile(id)
      if (opts.profileId === undefined && resolved.profileId !== undefined) ident.profileId = resolved.profileId
      if (opts.incognito === undefined && resolved.incognito !== undefined) ident.incognito = resolved.incognito
      if (opts.incognitoPartitionId === undefined && resolved.incognitoPartitionId !== undefined) {
        ident.incognitoPartitionId = resolved.incognitoPartitionId
      }
    }
    const profileId = opts.profileId !== undefined ? opts.profileId : ident.profileId
    const incognito = opts.incognito !== undefined ? opts.incognito : ident.incognito
    const incognitoPartitionId = opts.incognitoPartitionId !== undefined ? opts.incognitoPartitionId : ident.incognitoPartitionId

    // 附加项（字号等）在创建时现取；端口异常一律退回基线 ——
    // 绝不让一次设置读取失败演变成「标签建不起来」。
    let extraTabPrefs = {}
    if (this._extraTabWebPreferences) {
      try {
        extraTabPrefs = this._extraTabWebPreferences() || {}
      } catch (error: unknown) {
        console.error('[wcm] extra tab webPreferences port failed:', error instanceof Error ? error.message : error)
        extraTabPrefs = {}
      }
    }
    const webPrefs = buildTabWebPreferences({ preload: defaultPreloadPath('tab'), ...extraTabPrefs })
    // 会话解析优先级：显式 session > sessionResolver(按 profileId/incognito) > incognito memory: 兜底。
    // （曾经的「全局 setTabSession 兜底」已删除：它是 profile 隔离失效的根因，
    //   且全仓零调用、`options.tabSession` 也无人传 —— 那条兜底恒为死分支。）
    let resolved = opts.session || this._resolveSession({
      profileId,
      incognito,
      incognitoPartitionId
    })
    if (!resolved && incognito) {
      // 无注入端口时的兜底：memory: ephemeral partition（窗口关闭即销毁）。
      // 同一窗口所有无痕标签共享同一 partition（对齐 Chrome incognito window 行为）。
      resolved = session.fromPartition(`memory:incognito-${incognitoPartitionId || 'default'}`, { cache: false })
    }
    if (resolved) webPrefs.session = resolved

    const view = new WebContentsView({
      webPreferences: webPrefs,
      // 复用 Electron 预建的 webContents（其 webPreferences 继承自 opener，
      // 已带上本页的 preload/session）；无预建时才自建。
      ...(injectedWebContents ? { webContents: injectedWebContents } : {})
    })
    // 对齐 RT tab.ts#createWebContentsView：新建标签视图默认**不可见**，
    // 由布局层（LayoutCoordinator.showTab）在真正显示时 setVisible(true)。
    // 否则后台打开的标签（openInBackground）会以默认 visible=true 直接渲染，
    // 与当前标签叠在一起 —— 既穿帮又白白多渲染一整个页面（卡顿来源之一）。
    try { view.setVisible(false) } catch (_) {}
    // 网页的画布色是固定的白纸，主题不参与（见 TAB_CANVAS_COLOR）；
    // 内置新标签页随后会被宿主改成透明（见 setTabCanvas 的说明）。
    this.setTabCanvas(view, TAB_CANVAS_COLOR)

    this._tabViews.set(id, view)
    return view
  }

  /** 只获取已存在的标签视图，不创建（布局层/查询专用，避免副作用唤醒休眠标签） */
  getTab(tabId: string): WebContentsView | null {
    return this._tabViews.get(String(tabId)) || null
  }

  destroyTab(tabId: string): boolean {
    const id = String(tabId)
    const view = this._tabViews.get(id)

    // ⚠ `_tabOptions` 必须**无条件**清，不能放在下面的 `if (!view)` 之后。
    // 休眠标签被关闭时 `_tabViews` 里已经没有它（sleepTab 把视图摘了、只留 options），
    // 于是这里会提前 return —— 那条 options 记录就永远留在表里。标签自动休眠是常态，
    // 这等于「每关掉一个睡着的标签就漏一条」，长时间使用持续累积。
    this._tabOptions.delete(id)
    if (!view) return false

    // 从 tab 图层（或 contentView）摘除，再销毁 webContents
    this._removeViewFromHost(view)

    if (!view.webContents.isDestroyed()) destroyWebContents(view.webContents)
    this._tabViews.delete(id)
    return true
  }

  /**
   * 把标签视图从本窗口**摘下来交给别的窗口**（跨窗口迁移用）。
   *
   * 与 destroyTab 的关键差异：**不销毁 webContents**。活着的页面、导航历史、
   * 表单状态都随视图一起搬走 —— 用户看到的是「标签从 A 窗口到了 B 窗口」，
   * 而不是「在 A 关掉、在 B 重开」。
   *
   * 摘除后本窗口的 `getTab(id)` 立即返回 null，因此源窗口那些仍挂在旧 webContents
   * 上的事件监听会因 `TabManager#_isCurrentWc` 判定为「不是我的标签」而自动失效，
   * 不需要（也无法）逐个解绑。
   *
   * @param {string} tabId
   * @returns {{ view: Electron.WebContentsView, options: object|null }|null}
   */
  detachTab(tabId: string): { view: WebContentsView; options: TabCreateOptions | null } | null {
    const id = String(tabId)
    const view = this._tabViews.get(id)
    if (!view) return null
    // 先取消可见性：视图离开宿主后仍是 visible 会让新窗口的首帧闪一下旧内容
    try { view.setVisible(false) } catch (_) {}
    this._removeViewFromHost(view)
    this._tabViews.delete(id)
    const options = this._tabOptions.get(id) ? { ...this._tabOptions.get(id) } : null
    this._tabOptions.delete(id)
    return { view, options }
  }

  /**
   * 接收别的窗口迁来的标签视图（**不新建 webContents**，只登记）。
   *
   * 注意：这里不 addChildView —— 挂载由布局层在真正显示该标签时完成
   * （与 createTab 的「初次显示才挂载」口径一致，避免多挂一次引发 z 序重排）。
   *
   * @param {string} tabId
   * @param {Electron.WebContentsView} view
   * @param {object|null} [options] 原窗口记录的构建选项（休眠唤醒时要复用）
   */
  adoptTab(tabId: string, view: WebContentsView, options: TabCreateOptions | null = null): WebContentsView {
    const id = String(tabId)
    if (!view || !view.webContents) throw new Error('adoptTab: view with webContents is required')
    const existing = this._tabViews.get(id)
    if (existing) return existing
    this._tabViews.set(id, view)
    this._tabOptions.set(id, options ? { ...options } : {})
    try { view.setVisible(false) } catch (_) {}
    // ⚠ 这里**不能**无条件刷白：迁入的视图可能正是内置新标签页（透明画布），
    // 刷白会让它盖住窗口壁纸、并在随后的纠正里闪一下。画布色统一由宿主的
    // `TabManager#syncTabCanvas` 按当前 URL 补（见 bindTabEvents）。
    return view
  }

  /**
   * 休眠标签：销毁 webContents 释放内存，但保留 tabId 槽位和 options。
   * 下次 createTab(tabId) 会重新创建 webContents 并复用相同的 incognito session partition。
   * @param {string} tabId
   * @returns {boolean}
   */
  sleepTab(tabId: string): boolean {
    const id = String(tabId)
    const view = this._tabViews.get(id)
    if (!view) return false
    this._removeViewFromHost(view)
    if (!view.webContents.isDestroyed()) destroyWebContents(view.webContents)
    this._tabViews.delete(id)
    // 注意：不删除 _tabOptions[id]，wakeTab 时需要复用 incognito 标记
    // 代际不重置，下次 createTab 时 +1
    return true
  }

  /**
   * 标签是否休眠（无 webContents）
   * @param {string} tabId
   * @returns {boolean}
   */
  isTabSleeping(tabId: string): boolean {
    const id = String(tabId)
    return !this._tabViews.has(id)
  }
}

export { WebContentsManager }
