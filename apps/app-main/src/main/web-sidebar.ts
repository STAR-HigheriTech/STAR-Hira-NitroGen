/**
 * web-sidebar.ts —— **独立侧栏（Web Sidebar）** 的按窗口运行单元。
 *
 * ── 它是什么 ────────────────────────────────────────────────────────
 * 一块**真网页**住在内容区旁边的一条竖栏里（Vivaldi 的 web panel / Hira 的
 * `sidebarViewManager` 的 NG 形态）。用户从书签 / 收藏面板 / 页面右键 / rail 的 `+`
 * 把它打开，之后它就是一个**正常的浏览页面**：能点、能滚、能右键、能弹对话框、
 * 能登录（与标签同 session）。
 *
 * ── 它不是什么（这次重写的核心）─────────────────────────────────────
 * **它不是面板**：不进面板目录（`panel-catalog`）、不占面板槽（`_panelSlots`）、
 * 不参与面板对账（`reconcilePanels`）、不共用面板的存储与顶条。
 * 面板与侧栏是**两套平行系统**，各自有视图、存储、布局区域与顶条 —— 唯一的关系是
 * 在轨道上相邻（侧栏在面板内侧、紧邻网页），于是**两者可以同时开着**。
 *
 * ── 为什么它一定是"功能完整"的 ───────────────────────────────────────
 * 内容视图由 `WebContentsManager#createWebSidebarView` 造，用的是
 * **`buildTabWebPreferences`（标签那一份）+ 同一条 session 解析链** ——
 * 它和标签视图是同一个东西，只是位置不同。任何"精简版 webPreferences"都会让侧栏里的
 * 网页与标签里的网页行为分叉，那正是上一版"连鼠标指针都不对"的根因。
 *
 * ── 它认识什么 / 不认识什么 ──────────────────────────────────────────
 *   认识：一个 URL、一块矩形、一份状态；复用 `showWebContentMenu` 与几个注入端口。
 *   不认识：面板目录、标签世界的内部、布局几何（它只调 `layoutCoordinator` 的公开方法）。
 */

import type { BrowserWindow, Event, WebContents, WebContentsView } from 'electron'
import {
  freezeWebContents,
  isNonWebUrl,
  isPdfUrl,
  navigateWebHistory,
  onWebContentsDestroyed,
  readWebNavigationState,
  reloadOrRetry,
  resolvePdfTarget,
  showWebContentMenu,
  thawWebContents,
  type ContextMenuOptions
} from '@hira-ng/infra-window'
import { IPC_EVENTS } from '@hira-ng/shared-types/src/ipc-channels.mjs'
import {
  normalizeSidebarUrl,
  sidebarTitleForUrl,
  isSameSidebarSite,
  isWebSidebarViewMode,
  buildMobileUserAgent,
  DEFAULT_WEB_SIDEBAR_VIEW_MODE,
  type WebSidebarSide,
  type WebSidebarViewMode
} from '@hira-ng/shared-types/src/web-sidebar.mjs'
import { webErrorUrl, isWebErrorUrl } from '@hira-ng/shared-types/src/web-error.mjs'
import { isSecurityWarningUrl } from '@hira-ng/shared-types/src/security-warning.mjs'
import { defaultSearchUrl, defaultSearchLabel } from '@hira-ng/shared-types/src/search-engines.mjs'

/**
 * 顶条高度（px）。**必须与 ui-common#createWebSidebarHeader 的 `WEB_SIDEBAR_HEADER_HEIGHT` 一致**
 * —— 布局层按它给内容让位。
 */
export const WEB_SIDEBAR_HEADER_HEIGHT = 32

const RETIRE_AFTER_CLOSE_MS = 5 * 60 * 1000

export interface WebSidebarIdentity {
  profileId?: string
  incognito?: boolean
}

export interface WebSidebarViewFactory {
  createWebSidebarView(identity?: WebSidebarIdentity): WebContentsView | null
  createWebSidebarHeaderView?(): WebContentsView | null
  getWebSidebarView?(): WebContentsView | null
  getWebSidebarHeaderView?(): WebContentsView | null
  destroyWebSidebarViews?(): boolean
}

export interface WebSidebarLayoutPort {
  isWebSidebarVisible?(): boolean
  setWebSidebarVisible?(visible: boolean, side?: WebSidebarSide): unknown
  setWebSidebarMovePreview?(pointerViewX: number): unknown
  cancelWebSidebarMove?(): unknown
  commitWebSidebarMove?(): boolean
  getWebSidebarSide?(): string | null
  setWebSidebarWidth?(width: number): boolean
  getWebSidebarWidth?(): number
}

type CaptureMode = 'viewport' | 'fullpage' | 'region'
type ExtensionMenuResolver = NonNullable<ContextMenuOptions['getExtensionMenuItems']>

export interface WebSidebarHooks {
  getExtensionMenuItems?: ExtensionMenuResolver
  getHostMenuItems?: ExtensionMenuResolver
  newTab?: (url: string, options?: { openInBackground?: boolean }) => unknown
  onOpenInNewWindow?: (url: string) => unknown
  onViewSource?: (url: string) => unknown
  onSearchUrl?: (query: string) => string
  onSearchLabel?: (text: string) => string
  onTargetUrl?: (url: string) => unknown
  onZoomRequest?: (direction: 'in' | 'out', webContents: WebContents) => unknown
  onCapturePage?: (payload: { webContents: WebContents; mode: CaptureMode }) => unknown
  onTranslatePage?: (payload: { webContents: WebContents; url: string }) => unknown
  onPeekPreview?: (payload: { webContents: WebContents; url: string }) => unknown
  getMenuAccelerator?: (command: string) => string
  shouldUsePdfViewer?: (url: string) => boolean
  onWebContentsReady?: (webContents: WebContents) => unknown
}

export interface WebSidebarDependencies {
  wcm?: WebSidebarViewFactory
  layoutCoordinator?: WebSidebarLayoutPort
  getIdentity?: () => WebSidebarIdentity
  getOwnerWindow?: () => BrowserWindow | null
  emit?: (route: string, payload?: unknown, options?: { windowId?: number }) => unknown
  hooks?: WebSidebarHooks
  persistWidth?: (width: number) => unknown
  persistPosition?: (position: string) => unknown
  persistViewMode?: (mode: WebSidebarViewMode) => unknown
  initialViewMode?: unknown | (() => unknown)
  getSafeBrowsingWarning?: (url: string) => string
}

export interface WebSidebarState {
  url: string
  title: string
  favicon: string
  loading: boolean
  canGoBack: boolean
  canGoForward: boolean
  viewMode: WebSidebarViewMode
}

export interface WebSidebarStateSnapshot extends WebSidebarState {
  open: boolean
}

export interface WebSidebarParts {
  content: WebContentsView
  header: WebContentsView | null
  headerHeight: number
}

export interface WebSidebarOpenOptions {
  side?: WebSidebarSide
  viewMode?: unknown
}

export interface WebSidebarController {
  ensureView(): WebSidebarParts | null
  open(url: string, options?: WebSidebarOpenOptions): { open: boolean; url: string }
  close(): { open: false }
  toggle(url?: string, options?: WebSidebarOpenOptions): { open: boolean; url?: string }
  command(command: unknown): { open: boolean }
  ownsWebContents(webContents: WebContents | null): boolean
  owns(webContents: WebContents | null): boolean
  getWebContents(): WebContents | null
  getState(): WebSidebarStateSnapshot
  isOpen(): boolean
  setViewMode(mode: unknown): WebSidebarViewMode
  getViewMode(): WebSidebarViewMode
  refreshLayout(): void
  movePreview(pointerViewX: number): void
  cancelMove(): void
  commitMove(): boolean
  setWidth(width: number): boolean
  getWidth(): number
  getSide(): WebSidebarSide | null
  destroy(): void
}

export function createWebSidebar(deps: WebSidebarDependencies = {}): WebSidebarController {
  const wcm = deps.wcm
  const layout = deps.layoutCoordinator
  const getIdentity = typeof deps.getIdentity === 'function' ? deps.getIdentity : () => ({})
  const getOwnerWindow = typeof deps.getOwnerWindow === 'function' ? deps.getOwnerWindow : () => null
  const emit = typeof deps.emit === 'function' ? deps.emit : () => {}
  const hooks: WebSidebarHooks = deps.hooks && typeof deps.hooks === 'object' ? deps.hooks : {}
  const persistWidth = typeof deps.persistWidth === 'function' ? deps.persistWidth : null
  const persistPosition = typeof deps.persistPosition === 'function' ? deps.persistPosition : null
  const persistViewMode = typeof deps.persistViewMode === 'function' ? deps.persistViewMode : null
  const getSafeBrowsingWarning = typeof deps.getSafeBrowsingWarning === 'function'
    ? deps.getSafeBrowsingWarning
    : () => ''
  /** 宽度落库的防抖定时器（拖拽期间不写盘，停手 300ms 才写一次）。 */
  let widthTimer: ReturnType<typeof setTimeout> | null = null

  /**
   * 状态（**主进程是唯一真源**）：顶条与外壳都只消费它的投影。
   * `url` 用 `''` 而不是 null —— 它要过 IPC 且被当字符串用，少一种空值形态少一类分支。
   *
   * `viewMode`：`'mobile' | 'desktop'`（默认手机端）。它只是**呈现模式**，
   * 与 session / 登录态无关 —— 切换只换一条 UA，身份不变（见 shared-types#web-sidebar.mjs）。
   */
  const state: WebSidebarState = {
    url: '',
    title: '',
    favicon: '',
    loading: false,
    canGoBack: false,
    canGoForward: false,
    viewMode: DEFAULT_WEB_SIDEBAR_VIEW_MODE
  }
  /**
   * 桌面端 UA 的**真源缓存**：视图创建时 `getUserAgent()` 拿到的就是它。
   *
   * ⚠ 只抓一次：一旦切成手机端，`getUserAgent()` 返回的就是手机 UA 了 —— 每次现抓会把
   * "手机 UA"当成桌面端再包一层，切回来就永远回不到真桌面端。
   */
  let desktopUserAgent = ''
  /**
   * 持久化模式是否已读回。
   *
   * 为什么**延迟读**：`createWebSidebar` 跑在窗口装配期，而设置服务在 main.js 里创建得
   * 更晚（装配时按值读只会拿到 undefined）。所以第一次真正要用模式时（首次 ensureView /
   * 首次切换）才去问一次，之后置位不再问。
   */
  let viewModeResolved = false

  /** 读回持久化的视图模式（只读一次；用户显式切换后不再覆盖）。 */
  function resolveViewMode(): void {
    if (viewModeResolved) return
    viewModeResolved = true
    let stored: unknown = ''
    try {
      stored = typeof deps.initialViewMode === 'function' ? deps.initialViewMode() : deps.initialViewMode
    } catch (_) { stored = '' }
    if (isWebSidebarViewMode(stored)) state.viewMode = stored
  }
  /** 已挂过监听的 webContents（只挂一次；视图是常驻的，重开不重建）。 */
  let boundWc: WebContents | null = null
  /**
   * 「本轮导航已经切过错误页」——同一个失败会被 `did-fail-load` 与
   * `did-fail-provisional-load` 各报一次，第二次若照样切错误页，它的 loadURL 会打断
   * 第一次（抛 ERR_ABORTED，噪音 + 抖动）。在新一轮主框架导航时清空。
   */
  let errorPageSwitched = false

  function contentView(): WebContentsView | null {
    return wcm && typeof wcm.getWebSidebarView === 'function' ? wcm.getWebSidebarView() : null
  }

  function headerView(): WebContentsView | null {
    return wcm && typeof wcm.getWebSidebarHeaderView === 'function' ? wcm.getWebSidebarHeaderView() : null
  }

  function webContentsOf(): WebContents | null {
    const v = contentView()
    return v && v.webContents && !v.webContents.isDestroyed() ? v.webContents : null
  }

  function isOpen(): boolean {
    return !!(layout && typeof layout.isWebSidebarVisible === 'function' && layout.isWebSidebarVisible())
  }

  /**
   * 对外的状态快照（顶条消费的形状）。
   *
   * `loading` **以内容视图的实时状态为唯一真源**：`state.loading` 只是"还没有视图"时的兜底。
   * 事件表的注册顺序稍微写歪一点（历史上真歪过），最后一帧就会永远停在 true，
   * 表现是「刷新按钮自己转个没完」—— 与其靠人工维护事件次序，不如直接问 Chromium。
   */
  function snapshot(): WebSidebarStateSnapshot {
    const wc = webContentsOf()
    state.loading = wc ? !!wc.isLoading() : false
    return {
      open: isOpen(),
      ...state
    }
  }

  /** 把状态推给**顶条**与**外壳**（两条消费方，一份真源）。 */
  function publish(): void {
    const payload = snapshot()
    const header = headerView()
    if (header && header.webContents && !header.webContents.isDestroyed()) {
      try { header.webContents.send(`ngipc:event:${IPC_EVENTS.webSidebarState}`, payload) } catch (_) {}
    }
    try { emit(IPC_EVENTS.webSidebarState, payload) } catch (_) {}
  }

  function readNav(wc: WebContents): { canGoBack: boolean; canGoForward: boolean } {
    const state = readWebNavigationState(wc)
    return { canGoBack: state.canGoBack, canGoForward: state.canGoForward }
  }

  /** 从页面重新读一遍会变的那些事实（导航结束后调）。 */
  function refreshFromPage(wc: WebContents): void {
    if (!wc || wc.isDestroyed()) return
    let current = ''
    try { current = String(wc.getURL() || '') } catch (_) { current = '' }
    // 错误页不覆盖原 URL（保持"失败的到底是哪个网址"这个事实）—— 与标签页同一条口径。
    if (current && !isWebErrorUrl(current) && !isSecurityWarningUrl(current)) state.url = current
    else if (!state.url) state.url = current
    try { state.title = String(wc.getTitle() || state.title || '') } catch (_) {}
    const nav = readNav(wc)
    state.canGoBack = nav.canGoBack
    state.canGoForward = nav.canGoForward
    if (!state.title) state.title = sidebarTitleForUrl(state.url)
  }

  /**
   * 把视图模式落到一个 webContents 上（**唯一的施加点**）。
   *
   * 桌面端 UA 的真源在视图创建时抓一次（`getUserAgent()` = 启动时那次全局伪装的结果），
   * 手机端由它推出（版本号沿用同一 Chrome 主版本）—— 两个模式报告同一个版本，站点侧
   * 看不出"同一客户端演两套"。真源只抓一次（见 `desktopUserAgent` 的说明）。
   *
   */
  function applyViewMode(wc: WebContents, mode: unknown): void {
    if (!wc || wc.isDestroyed()) return
    const next: WebSidebarViewMode = isWebSidebarViewMode(mode) ? mode : DEFAULT_WEB_SIDEBAR_VIEW_MODE
    if (!desktopUserAgent) {
      try { desktopUserAgent = String(wc.getUserAgent() || '') } catch (_) { desktopUserAgent = '' }
    }
    const ua = next === 'mobile' ? buildMobileUserAgent(desktopUserAgent) : desktopUserAgent
    if (ua) { try { wc.setUserAgent(ua) } catch (_) {} }
  }

  /**
   * 设定视图模式（顶条的 `toggle-view-mode` 与 `setViewMode` 公开方法都走这里）。
   *
   * UA 只对**之后的请求**生效 → 已经加载着的页面必须重载一次才能看到新版式；
   * 同模式重复设定不重载（避免无谓刷新）。模式是**偏好**，切换即落库。
   *
   */
  function changeViewMode(mode: unknown): WebSidebarViewMode {
    resolveViewMode()
    const next: WebSidebarViewMode = isWebSidebarViewMode(mode) ? mode : DEFAULT_WEB_SIDEBAR_VIEW_MODE
    const changed = next !== state.viewMode
    state.viewMode = next
    const wc = webContentsOf()
    if (wc) applyViewMode(wc, next)
    if (changed) {
      if (persistViewMode) { try { persistViewMode(next) } catch (_) {} }
      if (wc && state.url) { try { reloadOrRetry(wc, state.url) } catch (_) {} }
      publish()
    }
    return next
  }

  /**
   * 给内容 webContents 挂**全功能**监听（只挂一次）。
   *
   * 这里刻意与标签的接线（`tabEvents.js`）保持同一套语义，但**不共用那个 host 契约** ——
   * 那个契约要求 12+ 个 TabManager 私有成员，把整个标签世界拖进来正好是这次要拆掉的东西。
   * 于是这里只接"侧栏这一块自己需要"的部分，并复用唯一无状态的共用件
   * `showWebContentMenu`（右键菜单的模型/命令都在那边，这里不长第二份）。
   */
  function bind(wc: WebContents): void {
    if (!wc || wc === boundWc) return
    boundWc = wc

    // 视图模式（UA）必须**在任何 loadURL 之前**落下 —— bind 由 ensureView 调、早于 open 的
    // 首次导航，所以这里是唯一能"带着正确 UA 发第一个请求"的时机。
    applyViewMode(wc, state.viewMode)

    /**
     * ⚠ **第一件事**就交给宿主补挂"它那一半"（JS 对话框 / 快捷键 before-input-event）。
     *
     * 为什么放在最前面：本函数后面挂了几十条监听，任何一条**注册期**抛错（写错一个
     * 不存在的标识符之类）都会把后面全部跳过 —— 而外层 `_ensureWebSidebarParts` 的
     * try/catch 会把它变成"侧栏少一半能力"却毫无提示。把"缺了它就成了半成品"的
     * 那两样放在第一行，后面无论怎么炸都不会连累它们。
     */
    if (typeof hooks.onWebContentsReady === 'function') {
      try { hooks.onWebContentsReady(wc) } catch (_) {}
    }

    // ── 右键菜单：完全走标签那条既有实现（模型、扩展项、宿主项全是数据）──
    wc.on('context-menu', (_e, params) => {
      const ownerWindow = getOwnerWindow()
      showWebContentMenu(wc, params, {
        ownerWindow: ownerWindow && !ownerWindow.isDestroyed() ? ownerWindow : undefined,
        /**
         * 菜单里那些"打开"：**明确要求开标签 / 开窗口的，一律去主浏览区**；
         * 只有菜单的默认项（没有指名去向）才走"同站留侧栏 / 站外开标签"的分流。
         */
        onOpenLink: (url, disposition) => {
          if (disposition === 'new-window' && typeof hooks.onOpenInNewWindow === 'function') {
            hooks.onOpenInNewWindow(url)
            return
          }
          if (disposition === 'foreground-tab' || disposition === 'background-tab') {
            if (typeof hooks.newTab === 'function') hooks.newTab(url, { openInBackground: disposition === 'background-tab' })
            return
          }
          routeLink(url)
        },
        onSaveLinkAs: (url) => url && wc.downloadURL(url),
        onSaveImageAs: (url) => url && wc.downloadURL(url),
        onInspectElement: (x, y) => wc.inspectElement(x, y),
        // 刷新：错误页是过渡视图 → 必须重试原网址（`state.url` 从不会被错误页覆盖）。
        onReload: () => reloadOrRetry(wc, state.url),
        // ── 与标签页**同一批宿主能力**（J7 截图 / N1 小窗）──
        // 契约与 tabEvents 一致：infra 只报 mode / URL（薄转发），由这里补齐 webContents。
        // ⚠ 漏接的表现就是"菜单项在、点了毫无反应"（`options.onXxx &&` 短路）。
        // hooks 上没有对应能力时**静默不转发**（不抛错）—— 可见性由模型层的开关裁决，
        // 真要彻底去掉项，应改模型层而不是在这里补空函数。
        onCapturePage: (mode) => {
          if (typeof hooks.onCapturePage === 'function') hooks.onCapturePage({ webContents: wc, mode })
        },
        // 翻译此页（C3）：侧栏里的页面右键同样能翻译（转发到与标签同一份 hooks）。
        onTranslatePage: (url) => {
          if (typeof hooks.onTranslatePage === 'function') hooks.onTranslatePage({ webContents: wc, url })
        },
        onPeekPreview: (url) => {
          if (typeof hooks.onPeekPreview === 'function') hooks.onPeekPreview({ webContents: wc, url })
        },
        onViewSource: (url) => {
          if (typeof hooks.onViewSource === 'function') hooks.onViewSource(url)
          else if (typeof hooks.newTab === 'function') hooks.newTab(`view-source:${url}`)
        },
        onSearchSelection: (text) => {
          const keyword = String(text || '')
          const target = typeof hooks.onSearchUrl === 'function'
            ? hooks.onSearchUrl(keyword)
            : defaultSearchUrl(keyword)
          if (target && typeof hooks.newTab === 'function') hooks.newTab(target)
        },
        searchLabel: (text) => (typeof hooks.onSearchLabel === 'function'
          ? hooks.onSearchLabel(text)
          : defaultSearchLabel(text)),
        // 快捷键提示：与标签右键同一份解析器（宿主注入 `menuAccelerator` 的绑定）。
        accelerator: (command) => (typeof hooks.getMenuAccelerator === 'function'
          ? hooks.getMenuAccelerator(command)
          : ''),
        getExtensionMenuItems: (contents, contextParams) => (typeof hooks.getExtensionMenuItems === 'function'
          ? hooks.getExtensionMenuItems(contents, contextParams)
          : []),
        getHostMenuItems: (contents, contextParams) => (typeof hooks.getHostMenuItems === 'function'
          ? hooks.getHostMenuItems(contents, contextParams)
          : [])
      })
    })

    // ── `_blank` / window.open：同站留侧栏、站外去主浏览区开新标签 ──
    try {
      wc.setWindowOpenHandler((details) => {
        const url = details && details.url
        if (url && url !== 'about:blank') {
          // 必须**推迟一跳**再导航：`setWindowOpenHandler` 的回调跑在原生派发栈里，
          // 同步发起导航会被本轮导航流程覆盖掉（表现为"点了 _blank 什么都没发生"）。
          setImmediate(() => { try { routeLink(url) } catch (_) {} })
        }
        return { action: 'deny' }
      })
    } catch (_) {}

    // ── 标题 / 图标 —— 顶条要显示它们 ──
    wc.on('page-title-updated', (_e, title) => {
      state.title = String(title || '')
      publish()
    })
    wc.on('page-favicon-updated', (_e, favicons) => {
      if (Array.isArray(favicons) && favicons.length) {
        state.favicon = String(favicons[0] || '')
        publish()
      }
    })

    // ── 导航 / 加载：状态变化的**唯一来源**（不要靠渲染层猜）──
    wc.on('did-start-navigation', (_e, _url, isInPlace, isMainFrame) => {
      if (!isMainFrame || isInPlace) return
      errorPageSwitched = false
      // 主框架开始导航 = 这一页的悬停提示没意义了 → 收回（与标签页同一条口径）
      if (typeof hooks.onTargetUrl === 'function') { try { hooks.onTargetUrl('') } catch (_) {} }
    })
    // ⚠ `did-stop-loading` **不能**放进上面那张"刷新一下就推"的表里：
    // 那张表先注册、先执行，推出去的状态里 `loading` 还是上一拍的 true；紧随其后的
    // 复位语句又不推 —— 渲染层收到的最后一帧永远是"正在加载"，刷新按钮就此转到天荒地老。
    // 收尾必须在**同一拍**里「复位 → 刷新导航态 → 推一次」。
    wc.on('did-navigate', () => { refreshFromPage(wc); publish() })
    wc.on('did-navigate-in-page', () => { refreshFromPage(wc); publish() })
    wc.on('did-finish-load', () => { refreshFromPage(wc); publish() })
    wc.on('did-start-loading', () => { state.loading = true; publish() })
    wc.on('did-stop-loading', () => {
      state.loading = false
      refreshFromPage(wc)
      publish()
    })

    /**
     * 加载失败 → **我们自己的错误页**（与标签页同一个地址、同一份构造）。
     *
     * 为什么不做这一步就"不符合浏览体验"：不给的话 Chromium 会画它自己的原生错误页 ——
     * 灰底白字、没有重试按钮、也没有我们的"返回 / 搜索"入口，与标签页里那个页面完全两个样。
     */
    const handleFail = (errorCode: number, _errorDescription: string, validatedURL: string): void => {
      if (errorCode === -3 || errorCode === 0) return // ERR_ABORTED / 正常，忽略
      if (isWebErrorUrl(validatedURL)) return        // 错误页自己失败 → 不递归
      if (errorPageSwitched) return
      errorPageSwitched = true
      state.loading = false
      const failed = String(validatedURL || state.url || '')
      try { wc.loadURL(webErrorUrl(errorCode, failed, 'web-sidebar')).catch(() => {}) } catch (_) {}
      publish()
    }
    wc.on('did-fail-load', (_e, code, desc, url, isMainFrame) => { if (isMainFrame) handleFail(code, desc, url) })
    wc.on('did-fail-provisional-load', (_e, code, desc, url, isMainFrame) => { if (isMainFrame) handleFail(code, desc, url) })

    /**
     * 页面自己发起的导航（点普通链接 / `location=` / 表单提交）。
     *
     * ⚠ 本事件**不会**为 `webContents.loadURL()` 触发（Electron 口径）—— 所以我们自己
     * 那几个入口（书签 / rail / 顶条）导到哪儿就是哪儿，不会被这条分流改道。
     *
     * 分流顺序：错误页 → 非网页协议 → PDF → **同站留侧栏 / 站外去主浏览区开新标签**。
     *
     * ★ 与标签页同一纪律：这段是 **`will-navigate` 与 `will-redirect` 的唯一实现**。
     *   301 / 302 **只**触发后者，各写一份必然漂移（标签页那边就漏过一次）。
     */
    const handleNavigationIntent = (e: Event, url: string): void => {
      const target = String(url || '')
      if (!target || isWebErrorUrl(target) || isNonWebUrl(target)) return
      if (isPdfUrl(target)) {
        const warning = getSafeBrowsingWarning(target)
        if (warning) {
          e.preventDefault()
          loadUrl(target, warning)
          return
        }
        // 内置查看器：与标签页同一条判据、同一个函数（infra-window/tabUrl#resolvePdfTarget）。
        // 关闭查看器时**原样导航**（落到下载链路）且**不**继续走下面的"站外开新标签" ——
        // 与标签页那条口径一致：PDF 分流是内核行为，不是链接路由。
        const pdfTarget = resolvePdfTarget(target, hooks.shouldUsePdfViewer)
        if (pdfTarget !== target) {
          e.preventDefault()
          try { wc.loadURL(pdfTarget).catch(() => {}) } catch (_) {}
        }
        return
      }
      // 站外链接 → **主浏览区新标签**（侧栏原地不动，用户能一边看侧栏一边看新页）
      const sameSite = isSameSidebarSite(state.url || safeUrl(wc), target)
      if (!sameSite) {
        e.preventDefault()
        routeLink(target)
        return
      }
      const warning = getSafeBrowsingWarning(target)
      if (warning) {
        e.preventDefault()
        loadUrl(target, warning)
      }
    }
    wc.on('will-navigate', (e, url) => handleNavigationIntent(e, url))
    wc.on('will-redirect', (e, url) => {
      // 已被先注册的监听者处理过（如「仅 HTTPS」升级）→ 不再二次改写
      if (e.defaultPrevented) return
      handleNavigationIntent(e, url)
    })

    // ── 链接悬停 URL：只报事实，落位与去重都在 apps 的悬停条端口里 ──
    wc.on('update-target-url', (_e, url) => {
      if (typeof hooks.onTargetUrl === 'function') { try { hooks.onTargetUrl(String(url || '')) } catch (_) {} }
    })

    /**
     * Ctrl+滚轮缩放。
     *
     * Chromium 只发出"用户在请求缩放"这个信号，**不会自己改 zoomLevel** —— 必须由应用
     * 响应（与标签页在 browser-window-runtime 里那一段逐字同源，见那里的注释）。
     */
    wc.on('zoom-changed', (_e, direction) => {
      if (typeof hooks.onZoomRequest === 'function') { try { hooks.onZoomRequest(direction, wc) } catch (_) {} }
    })

    // 崩溃 / 被杀：不是"网页功能"，但要如实反映（否则顶条会停在一个假状态）。
    wc.on('render-process-gone', () => {
      state.loading = false
      state.title = state.title || sidebarTitleForUrl(state.url)
      publish()
    })
    let htmlFullscreen = false
    const setHtmlFullscreen = (active: boolean): void => {
      const next = Boolean(active)
      if (next === htmlFullscreen) return
      htmlFullscreen = next
      const win = getOwnerWindow()
      if (win && !win.isDestroyed()) {
        try { win.setFullScreen(next) } catch {}
      }
    }
    wc.on('enter-html-full-screen', () => setHtmlFullscreen(true))
    wc.on('leave-html-full-screen', () => setHtmlFullscreen(false))
    onWebContentsDestroyed(wc, () => {
      if (htmlFullscreen) setHtmlFullscreen(false)
      if (boundWc === wc) boundWc = null
    })

    // 交给宿主补挂**它那一半**（JS 对话框 / 快捷键）——它们是按 webContents 的，
    // 而"挂什么、怎么挂"是 apps 层的能力（infra 不认识那些模块）。
    if (typeof hooks.onWebContentsReady === 'function') {
      try { hooks.onWebContentsReady(wc) } catch (_) {}
    }
    refreshFromPage(wc)
    publish()
  }

  /** 布局层的**视图端口**（`LayoutCoordinator#setWebSidebarViewPort` 要的形状）。 */
  function ensureView() {
    if (!wcm || typeof wcm.createWebSidebarView !== 'function') return null
    // 首次真正要用模式（紧接着 bind 会施加 UA）：此时设置服务已就绪，读回偏好。
    resolveViewMode()
    const content = wcm.createWebSidebarView(getIdentity() || {})
    if (!content) return null
    const header = typeof wcm.createWebSidebarHeaderView === 'function' ? wcm.createWebSidebarHeaderView() : null
    if (header && header.webContents && !header.webContents.isDestroyed()) {
      // 顶条页面**加载完之后**补推一次状态。
      // 为什么必须补：本函数在打开侧栏那一刻就跑完了 publish，而顶条 renderer 是**异步**
      // 起来的 —— 那次推送打在空白页上直接丢了。少了这一次，顶条会一直停在
      // "没标题、前进后退全灰"的初始态，直到用户碰巧导航一次。
      try {
        header.webContents.once('did-finish-load', () => publish())
        // 已经加载完了（第二次打开）→ once 不会再触发，直接补推。
        if (!header.webContents.isLoading()) publish()
      } catch (_) {}
    }
    bind(content.webContents)
    return { content, header, headerHeight: header ? WEB_SIDEBAR_HEADER_HEIGHT : 0 }
  }

  function loadUrl(url: string, preparedWarning = ''): void {
    const target = String(url || '')
    if (!target) return
    state.url = target
    state.title = ''
    state.canGoBack = false
    state.canGoForward = false
    const wc = webContentsOf()
    // 内容视图还没建（侧栏刚开 / 已销毁）：**不能**把 loading 留在 true ——
    // 这一趟不会有 did-start/did-stop 来收尾，那个 true 会一直跟着下一次 publish 出去，
    // 用户看到的就是"刷新按钮自己在那儿转"。
    if (!wc) { state.loading = false; return }
    state.loading = true
    const warning = preparedWarning || getSafeBrowsingWarning(target)
    try { wc.loadURL(warning || target).catch(() => {}) } catch (_) {}
    publish()
  }

  /**
   * 「把侧栏导到某个地址」——**本模块内部唯一的导航入口**。
   *
   * ⚠ 它必须是**函数声明**（与 `open`/`close` 那些对象方法不同）：
   * `bind()` 里注册的回调（右键菜单 / `setWindowOpenHandler` / `will-navigate`）
   * 都在**对象字面量之外**，在那里写 `navigate(...)` 会抛 ReferenceError
   * （对象方法是属性，不是闭包变量）—— 而这类抛错要么被 try/catch 吞掉、
   * 要么落进 Electron 的原生回调里变成"点了没反应"。踩过一次，别再踩。
   *
   */
  function goTo(url: string): void {
    if (!url) return
    loadUrl(url)
  }

  /**
   * 把"侧栏里的一个链接"分流出去。
   *
   * 规则（对齐 Vivaldi 的 web panel，也是用户的预期）：
   *   · **同站** → 留在侧栏里走（侧栏是"这一个站点"的工作区，不碎开）；
   *   · **站外** → 在**主浏览区开一个新标签**（侧栏保持原地不动）。
   *
   */
  function routeLink(url: string): 'sidebar' | 'tab' | 'ignored' {
    const raw = String(url || '')
    if (!raw) return 'ignored'
    const target = normalizeSidebarUrl(raw)
    // 非 http(s)（mailto: / magnet: / 自定义协议…）→ 交给主浏览区那条链（它认识这些协议）
    if (!target) {
      if (typeof hooks.newTab === 'function') { try { hooks.newTab(raw) } catch (_) {} return 'tab' }
      return 'ignored'
    }
    if (isSameSidebarSite(state.url || safeUrl(webContentsOf()), target)) {
      goTo(target)
      return 'sidebar'
    }
    if (typeof hooks.newTab === 'function') { try { hooks.newTab(target) } catch (_) {} return 'tab' }
    return 'ignored'
  }

  /**
   * ── 收起后的两步：**先冻结、再回收** ──────────────────────────────────
   *
   * 收起并不销毁视图，所以页面会一直在后台跑。两段式处理：
   *   ① **立刻冻结**（CDP `Page.setWebLifecycleState: frozen`）—— 完全停掉任务执行，
   *      后台开销归零；DOM / JS 堆 / 会话 / 滚动位置全都留着；
   *   ② **5 分钟后回收**（销毁两份视图）—— 那才是真正把内存还回去的一步。
   *
   * 为什么不立刻销毁：收起往往只是"先放一放"，马上又会打开，立刻销毁等于每次都重新加载
   * （白屏 + 丢滚动位置）。5 分钟足够走过"随手关一下"的窗口，又不至于让一个关掉的侧栏
   * 常驻一辈子。回收后再打开会**重建**（`ensureView` 负责），代价是一次加载。
   *
   * 冻结是"尽力而为"的优化（DevTools 占用调试器时会静默跳过，见 web-contents-freeze.js），
   * 所以**不据它改变任何行为** —— 它失败时功能照旧，只是没省下那点开销。
   */
  let retireTimer: ReturnType<typeof setTimeout> | null = null

  /** 侧栏的两份 webContents（内容页 + 顶条）；未创建 / 已销毁的不入列。 */
  function sidebarContents(): WebContents[] {
    const list: WebContents[] = []
    const content = webContentsOf()
    if (content && !content.isDestroyed()) list.push(content)
    const head = headerView()
    if (head && head.webContents && !head.webContents.isDestroyed()) list.push(head.webContents)
    return list
  }

  function freezeViews(): void {
    for (const wc of sidebarContents()) freezeWebContents(wc)
  }

  function thawViews(): void {
    for (const wc of sidebarContents()) thawWebContents(wc)
  }

  function cancelRetire(): void {
    if (retireTimer) { clearTimeout(retireTimer); retireTimer = null }
  }

  function scheduleRetire(): void {
    cancelRetire()
    retireTimer = setTimeout(() => {
      retireTimer = null
      releaseViews()
    }, RETIRE_AFTER_CLOSE_MS)
    // 不拦进程退出：这是"空闲回收"，不是必须完成的收尾
    if (retireTimer && typeof retireTimer.unref === 'function') retireTimer.unref()
  }

  /** 销毁两份视图（释放渲染进程）—— 定时回收与窗口关闭共用这一条。 */
  function releaseViews(): void {
    if (wcm && typeof wcm.destroyWebSidebarViews === 'function') {
      try { wcm.destroyWebSidebarViews() } catch (_) {}
    }
  }

  return {
    ensureView,

    /**
     * 在侧栏打开一个 URL。
     */
    open(url: string, options: WebSidebarOpenOptions = {}) {
      const target = normalizeSidebarUrl(url)
      if (!target) return { open: false, url: '' }
      // 重开即"取消待回收"：视图可能还冻着（下面解冻即可），也可能已被回收
      //（那种情况下面的 `ensureView` 会重建 —— 代价是一次加载）。
      cancelRetire()
      thawViews()
      // 显式指定模式时**先落状态**：ensureView → bind 会用 state.viewMode 施加 UA，
      // 于是首次导航就带着正确 UA（不需要"先加载再重载"）。显式指定即视为已定，不再读回偏好。
      if (isWebSidebarViewMode(options.viewMode)) {
        state.viewMode = options.viewMode
        viewModeResolved = true
      }
      const parts = ensureView()
      if (!parts) return { open: false, url: '' }
      const current = webContentsOf()
      const same = state.url === target && current && safeUrl(current) === target
      if (!same) loadUrl(target)
      const side = options.side === 'left' || options.side === 'right' ? options.side : undefined
      if (layout && typeof layout.setWebSidebarVisible === 'function') layout.setWebSidebarVisible(true, side)
      publish()
      return { open: true, url: target }
    },

    /**
     * 收起（**立刻冻结**省掉后台开销；5 分钟无重开才真正回收）。
     * 冻结期间页面状态、滚动位置都还在，重开是瞬间的。
     */
    close() {
      if (layout && typeof layout.setWebSidebarVisible === 'function') layout.setWebSidebarVisible(false)
      // ⚠ 顺序：先隐藏（布局层已做），再冻结 —— Chromium 只允许不可见的页面进入 frozen
      freezeViews()
      scheduleRetire()
      publish()
      return { open: false }
    },

    toggle(url?: string, options?: WebSidebarOpenOptions) {
      if (!url) return isOpen() ? this.close() : { open: false }
      return this.open(url, options)
    },

    /** 顶条命令（返回 / 前进 / 刷新 / 切换视图模式 / 在标签页打开 / 关闭）。 */
    command(command) {
      const cmd = String(command == null ? '' : command)
      const wc = webContentsOf()
      if (cmd === 'close') return this.close()
      // 视图模式切换**不依赖内容视图是否在**（视图未建时只改状态，下次 bind 生效）。
      if (cmd === 'toggle-view-mode') {
        changeViewMode(state.viewMode === 'mobile' ? 'desktop' : 'mobile')
        return { open: isOpen() }
      }
      if (!wc) return { open: isOpen() }
      try {
        if (cmd === 'open-in-tab') {
          const url = safeUrl(wc) || state.url
          if (url && typeof hooks.newTab === 'function') hooks.newTab(url)
          return { open: isOpen() }
        }
        if (cmd === 'back') { goHistory(wc, 'back'); return { open: isOpen() } }
        if (cmd === 'forward') { goHistory(wc, 'forward'); return { open: isOpen() } }
        if (cmd === 'reload') { reloadOrRetry(wc, state.url); return { open: isOpen() } }
        if (cmd === 'reload-hard') { reloadOrRetry(wc, state.url, { ignoreCache: true }); return { open: isOpen() } }
        if (cmd === 'stop') { wc.stop(); return { open: isOpen() } }
      } catch (_) {}
      return { open: isOpen() }
    },

    /** 这个 webContents 是不是**本侧栏的顶条**（IPC 来源校验用）。 */
    ownsWebContents(wc) {
      const header = headerView()
      return !!(header && header.webContents && header.webContents === wc)
    },

    owns: (wc) => webContentsOf() === wc,
    /**
     * 侧栏**内容**的 webContents（未创建/已销毁 = null）。
     *
     * 给"聚焦目标解析"用：窗口级能力（查找栏 / 缩放 / 悬停 URL）要判断
     * "此刻键盘焦点落在哪块网页面" —— 判据就是它是否 `isFocused()`。
     */
    getWebContents: () => webContentsOf(),
    getState: () => snapshot(),
    isOpen,
    /** 设定视图模式（'mobile' | 'desktop'）；返回生效后的模式。 */
    setViewMode(mode) {
      return changeViewMode(mode)
    },
    getViewMode() {
      return state.viewMode
    },
    /**
     * **布局事实变了，重新投影一次状态**（位置 / 宽度由 LayoutCoordinator 持有）。
     *
     * 谁调：装配期把 LayoutCoordinator 的侧别变化回调接到这里 —— 用户在设置里把
     * 网页侧栏换到另一边时，顶条要立刻按新 side 换把手所在的边，而不是等下一次导航。
     * 不引入新的推送通道：复用既有的 `publish()`（同一条 `web-sidebar:state`）。
     */
    refreshLayout() {
      publish()
    },
    /**
     * **拖动顶条换边**：拖动中持续上报指针在顶条视图内的 x（单向、高频）。
     *
     * 只搬运事实：越过中线侧栏就**实时**摆到那一侧（判据在布局层，窗口中线只有它知道）。
     */
    movePreview(pointerViewX) {
      if (layout && typeof layout.setWebSidebarMovePreview === 'function') {
        layout.setWebSidebarMovePreview(pointerViewX)
      }
    },
    /** 拖动中断（Esc / 指针丢失）：把侧栏放回拖动前那一侧（拖动中的位置只是临时的）。 */
    cancelMove() {
      if (layout && typeof layout.cancelWebSidebarMove === 'function') {
        layout.cancelWebSidebarMove()
      }
    },
    /**
     * 松手**落定换边**。
     *
     * 侧栏在拖动途中就已经摆到位了（实时换边，与分屏拖分隔条同一手感），
     * 这里只做一件事：**把结果写进设置** —— 那是"偏好"的唯一真源（重启后、新窗口都照它来）。
     * 设置生效器随后会把同一个值灌回各窗口，同值即 no-op，所以不必担心重复。
     */
    commitMove() {
      const lc = layout
      if (!lc || typeof lc.commitWebSidebarMove !== 'function') return false
      // ⚠ 先落定**再**问侧别：落定动作本身会改掉它（`commitWebSidebarMove` 负责换边）
      const moved = lc.commitWebSidebarMove()
      if (!moved || !persistPosition) return moved
      const side = typeof lc.getWebSidebarSide === 'function' ? lc.getWebSidebarSide() : null
      if (side) { try { persistPosition(side) } catch (_) {} }
      return moved
    },
    setWidth(width) {
      const changed = !!(layout && typeof layout.setWebSidebarWidth === 'function' && layout.setWebSidebarWidth(width))
      // 逐帧拖拽**不落库**：宽度是拖动过程量，每帧写一次设置等于每帧一次磁盘写。
      // 停手 300ms 后才写一次（"记忆"是最终值，不是过程值）。
      if (changed && persistWidth) {
        if (widthTimer) clearTimeout(widthTimer)
        widthTimer = setTimeout(() => {
          widthTimer = null
          try { persistWidth(this.getWidth()) } catch (_) {}
        }, 300)
      }
      return changed
    },
    getWidth() {
      return layout && typeof layout.getWebSidebarWidth === 'function' ? layout.getWebSidebarWidth() : 0
    },
    getSide(): WebSidebarSide | null {
      const side = layout && typeof layout.getWebSidebarSide === 'function' ? layout.getWebSidebarSide() : null
      return side === 'left' || side === 'right' ? side : null
    },
    /** 窗口关闭时收拾：取消待回收的定时器 + 销毁两份视图（释放渲染进程）。 */
    destroy() {
      // 宽度防抖还压着一次落盘：关窗不能把它一起埋了 —— 拖完 300ms 内关窗会丢最终宽度。
      // 先冲刷（把当前宽度写进设置）再清定时器，随后才放视图。
      if (widthTimer) {
        clearTimeout(widthTimer)
        widthTimer = null
        if (persistWidth) { try { persistWidth(this.getWidth()) } catch (_) {} }
      }
      cancelRetire()
      releaseViews()
    }
  }
}

function safeUrl(wc: WebContents | null | undefined): string {
  if (!wc) return ''
  try { return String(wc.getURL() || '') } catch (_) { return '' }
}

function goHistory(wc: WebContents, direction: 'back' | 'forward'): void {
  navigateWebHistory(wc, direction)
}

module.exports = { createWebSidebar, WEB_SIDEBAR_HEADER_HEIGHT }
