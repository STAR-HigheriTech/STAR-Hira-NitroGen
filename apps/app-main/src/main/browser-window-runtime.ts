/**
 * 按窗口的「标签运行单元」（多窗口的第二步）。
 *
 * ── 为什么必须抽出来 ──────────────────────────────────────────────
 * `TabManager` 及其全部生命周期 hooks 此前直接写在 main.js 的闭包里，捕获的是
 * **那一个**窗口的 `win` / `webContentsManager` / `layoutCoordinator`。多窗口下这是
 * 硬伤：第二个窗口的标签会用第一个窗口的布局去算 bounds、用第一个窗口的浮层去收尾巴。
 *
 * 本模块把「窗口」变成显式输入：每个浏览器窗口各建一份 TabManager + PiP 单元，
 * 绑定到自己的窗口三件套。因此它是**多窗口可复制的最小单元**。
 *
 * ── 依赖注入而非闭包捕获 ─────────────────────────────────────────
 * 所有跨窗口共享的服务（favicon / history / extension / 搜索 / 快照）都以
 * **getter 形式**注入，而不是直接传对象：这几个服务在窗口单元构造时尚未创建
 * （favicon 提前建、history 在后、extension 按 profile 懒加载），若传值会拿到
 * undefined；传 getter 则「用时再解析」，既不引入构造期时序依赖，也让本模块可以
 * 在任意窗口复用。
 *
 * ── 已知限制（属于下一步的工作，不是本模块的疏漏）──────────────────
 * 快照存储 `snapshotService` 目前是**进程级共享**的，而键是 tabId。多个窗口的
 * TabManager 各自生成的 tabId 是否全局唯一，取决于 tabRecord 的 id 方案 ——
 * 在做「跨窗口标签同步」时必须换成「窗口×空间」复合键，否则两个窗口可能互相
 * 覆盖截图。这一条不影响当前单窗口行为。
 */

import { type BrowserWindow, type WebContents } from 'electron'
import { TabManager, createPictureInPicture, applyPageInjections, WebContentsManager, LayoutCoordinator } from '@hira-ng/infra-window'
import { WINDOW_TYPES } from './window-config'
import { createBreakOverlay } from './break-overlay'
import { createZoomController, type ZoomPayload } from './zoom-controller'
const {
  isSameAddress,
  extensionPageIconUrl,
  isHiraNewTabUrl
} = require('./window-tab-url-policy')
const { resolveInjection, PAGE_INJECT_SETTING_KEYS, DEFAULT_FORCE_DARK } =
  require('@hira-ng/shared-types/src/page-inject.mjs')
const { grabPageImage } = require('./capture-page')
// 截图标注浮层（浏览器窗口内、盖在目标网页视图上）+ 框选层（每个窗口一份）
const { createCaptureEditorOverlay } = require('./capture-editor-overlay')
const { createCaptureRegion } = require('./capture-region')
// 专注模式（D5）的**整窗**浮层：盖住导航栏 / 侧栏 / 网页，让"专注"真的只剩计时
// （页面内遮罩盖不住原生视图，理由见该文件头）。
const { pushArchiveEntry, serializeArchive, ARCHIVE_SETTING_KEY } = require('@hira-ng/shared-types/src/archive-list.mjs')
// chrome 级瞬态能力（查找 / 缩放 / 悬停 URL）：三者都**按窗口**一份，因此随本单元创建。
// 各自的实现细节在各自文件里，这里只做装配（注入端口 + 挂到运行时对象上供 IPC 按窗口解析）。
const { createFindBarController } = require('./find-bar')
const { createHoverUrlBar } = require('./hover-url-bar')
// 「拖标签到网页区域」的落位预览（拖动期间 30fps 采样 + 独立浮层）。
const { createTabDropZone } = require('./tab-drop-zone')
// 「hover 在分屏上浮出的一排小按钮」（对齐 Zen / Edge 的分屏控件）——
// 与 dropzone 同族：主进程按屏幕光标采样后驱动独立浮层（hover 判定只能在主进程做）。
const { createSplitToolbar } = require('./split-toolbar')
// 历史写入策略（按窗口一份）：唯一决策点，infra 只报导航事实（见文件头说明）
const { createHistoryRecorder } = require('./history-recorder')
// 「最近关闭」的跨启动持久化（设置项；最近三次启动的记录，见该文件头）
const { createRecentlyClosedStore } = require('./recently-closed-store')

type TabManagerOptionsPort = NonNullable<ConstructorParameters<typeof TabManager>[0]>

interface LayoutCoordinatorRuntimePort {
  getFocusedWebBounds(): { x: number; y: number; width: number; height: number } | null
  togglePanel(...args: unknown[]): unknown
  setSideRevealHold(on: boolean, options?: { sourceWebContentsId?: number | null }): boolean
}

interface SpaceRuntimePort {
  getCurrent?(): { profileId?: string; spaceId?: string }
  setCurrent?(identity: { profileId: string; spaceId: string }): void
}

interface SplitOptionsPort { maxPanes?: number; defaultLayout?: string; linkRouting?: string }
interface ExtensionServicePort {
  session: unknown
  getContextMenuItems(contents: unknown, params: unknown): unknown[]
  getNewTabOverrideUrl?(url?: string): string | null | undefined
  addTab?(contents: WebContents, window: BrowserWindow): unknown
  selectTab?(contents: WebContents): unknown
}
interface ControllerPort { [method: string]: (...args: unknown[]) => unknown }
interface SnapshotServicePort { capture(tabId: string, contents: WebContents): Promise<unknown>; forget(tabId: string): unknown }
interface SearchServicePort { buildSearchUrl(query: string): string; buildSearchLabel(text: string): string }
interface PagePatchPort { css?: string; js?: string }

type PayloadPort = Record<string, unknown>

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

interface TabManagerRuntimePort extends TabManager {
  describeSplitDrop(...args: unknown[]): unknown
  toggleSplitLayout(...args: unknown[]): unknown
  reverseSplit(...args: unknown[]): unknown
  moveSplitMember(...args: unknown[]): unknown
}

interface BrowserWindowRuntimeDeps {
  win: BrowserWindow
  webContentsManager: WebContentsManager
  layoutCoordinator: LayoutCoordinator & LayoutCoordinatorRuntimePort
  emit(...args: unknown[]): unknown
  tabRules: TabManagerOptionsPort['tabRules']
  tabAdjust: TabManagerOptionsPort['tabAdjust']
  tabStacks: TabManagerOptionsPort['tabStacks']
  tabSplits: TabManagerOptionsPort['tabSplits']
  tabGroups: TabManagerOptionsPort['tabGroups']
  spaceRuntime: SpaceRuntimePort
  getPdfViewerEnabled(): boolean
  getSplitOptions(): SplitOptionsPort
  getNewTabUrl(options?: { incognito?: boolean; containerProfileId?: string | null; profileId?: string }): string
  getAutoPictureInPictureEnabled(): boolean
  getFaviconService(): { cacheAndSync?(url: string, faviconUrl: string): unknown } | null | undefined
  getHistoryService(): ControllerPort | null | undefined
  getExtensionService(profileId?: string): ExtensionServicePort | null | undefined
  passwordOverlayController: { hide?(): unknown; hideTransient?(): unknown; [key: string]: unknown }
  hideFloat(...args: unknown[]): unknown
  getSnapshotService(): SnapshotServicePort | null | undefined
  openSubWindowByType(type: string, payload?: Record<string, unknown>): unknown
  getSearchService(): SearchServicePort | null | undefined
  getSlotMenuItems?(...args: unknown[]): unknown
  getSlotLifecycle?(): ControllerPort | null | undefined
  getHostMenuItems?(...args: unknown[]): unknown
  getFocusedSurface?(): string | null | undefined
  getFocusedWebContents?(): WebContents | null | undefined
  tabIdPrefix?: string
  defaultIncognito?: boolean
  onOpenNewWindow?(options?: { incognito?: boolean }): void
  openLinkInNewWindow?(url: string): void
  openPeekPreview?: (payload: Record<string, unknown>) => unknown
  openCaptureHub?: () => unknown
  archiveCurrentPage?: () => unknown
  runCommandChain?: (id: unknown) => unknown
  handleTabEvent?: (event: {
    trigger: 'open' | 'navigate'
    tabId: string
    url: string
    title?: string
    active?: boolean
  }) => unknown
  runNoteAction?: (action: unknown, params?: Record<string, unknown>) => unknown
  shouldSuppressContextMenu?: (webContents: WebContents | null | undefined) => boolean
  translatePage?: (webContents: WebContents) => unknown
  runAsProfile?<T>(profileId: string, task: () => T): T
  guardWindowOpen?(payload: Record<string, unknown>): boolean
  getMenuAccelerator?(command: string): string
  onTabClosed?(tabId: string): void
  getUserScriptsForUrl?(url: string): unknown
  getPagePatchesForUrl?(url: string): PagePatchPort | null | undefined
  settings?: { get(key: string): unknown; set(key: string, value: unknown): unknown }
  surfaceCommand?(command: string): boolean
}

export interface BrowserWindowRuntimeCore {
  win: BrowserWindow
  webContentsManager: WebContentsManager
  layoutCoordinator: BrowserWindowRuntimeDeps['layoutCoordinator']
  tabManager: TabManagerRuntimePort
  pictureInPicture: ReturnType<typeof createPictureInPicture>
  passwordOverlayController: BrowserWindowRuntimeDeps['passwordOverlayController']
  hideFloat: BrowserWindowRuntimeDeps['hideFloat']
  findInPage: ControllerPort | null
  zoom: ReturnType<typeof createZoomController> | null
  hoverUrl: ControllerPort | null
  tabDropZone: ControllerPort | null
  splitToolbar: ControllerPort | null
  breakOverlay: ReturnType<typeof createBreakOverlay>
  getExtensionMenuItems(contents: WebContents | null | undefined, params: PayloadPort): unknown[]
  hooks: PayloadPort
  surfaceCommand: ((action: string) => boolean) | null
}

/** 浮层通道名（与 renderer/dropzone-overlay 的订阅逐字一致；事件名真源在 ipc-channels）。 */
const DROPZONE_UPDATE = 'dropzone-overlay:update'
const DROPZONE_HIDE = 'dropzone-overlay:hide'
/** 分屏工具条的通道名（与 renderer/split-toolbar 的订阅逐字一致）。 */
const SPLIT_TOOLBAR_UPDATE = 'split-toolbar:update'
const SPLIT_TOOLBAR_HIDE = 'split-toolbar:hide'

/**
 * 缩放变化事件的通道名（= `IPC_EVENTS.zoomChanged`，见 packages/shared-types/src/ipc-channels.mjs）。
 * 这里写字面量而不是 require：那份契约是 ESM（.mjs），CJS 侧只能用动态 import，
 * 而本模块的所有接线都是同步的。名字与契约逐字一致，改动时两处一起改。
 */
const ZOOM_EVENT = 'zoom:changed'

/**
 * 已经向扩展系统注册过的 webContents（跨窗口运行单元共享，故放模块作用域）。
 *
 * ── 为什么必须自己记账 ────────────────────────────────────────────
 * ECE 的 `addTab` **不是幂等的**：每次调用都会往该 webContents 上追加一组
 * tab 状态更新监听 + 一个 `destroyed` 清理器，而 `removeTab` **不会**摘掉它们。
 * 实测跨窗口迁移（detach/adopt）后，同一个 webContents 上的 `destroyed` 监听
 * 从 1 涨到 3，再搬几次就会越过 Node 的 10 上限（MaxListenersExceededWarning），
 * 更要紧的是**扩展状态会被重复更新**（两套 updateEvents 同时生效）。
 *
 * 因此按 webContents 只注册一次。
 *
 * ── 代价（如实记录）──────────────────────────────────────────────
 * 迁移后扩展仍认为该标签属于**原窗口**（windowId 不更新）。这比「每搬一次多一组
 * 监听、状态更新翻倍」轻得多，且只在「跨窗口迁移 + 扩展按 windowId 查询」这个
 * 窄组合下才可感知。要彻底解决需要 ECE 侧支持幂等注册或提供 re-associate API。
 */
const extRegisteredWc = new WeakSet()

/**
 * @param {object} deps
 * @param {Electron.BrowserWindow} deps.win 本窗口
 * @param {object} deps.webContentsManager 本窗口的视图管理器
 * @param {object} deps.layoutCoordinator 本窗口的布局协调器
 * @param {(route:string, payload?:any, opts?:object) => number} deps.emit 事件广播出口
 * @param {object} deps.tabRules 标签领域规则端口
 * @param {object} [deps.tabAdjust] 标签视图调整组合方法端口
 * @param {object} deps.tabStacks 标签栈端口
 * @param {object} deps.spaceRuntime 空间运行态（当前 profile/space 的读取口）
 * @param {() => boolean} deps.getPdfViewerEnabled PDF 内置查看器开关端口
 * @param {() => boolean} deps.getAutoPictureInPictureEnabled 切标签自动画中画开关端口
 *   （tabs.auto_picture_in_picture）。默认关闭 —— 对齐普通浏览器：不主动弹画中画。
 * @param {() => object} deps.getFaviconService
 * @param {() => object} deps.getHistoryService
 * @param {() => object} deps.getExtensionService
 * @param {object} deps.passwordOverlayController 本窗口的密码浮层控制器
 * @param {Function} deps.hideFloat 本窗口的浮层收起
 * @param {() => object} deps.getSnapshotService 标签截图服务（**必须 getter**：它在
 *   main.js 里创建得比窗口运行单元晚，按值传会捕获到 undefined）
 * @param {(type:string, payload?:object) => void} deps.openSubWindowByType 子窗口打开入口
 * @param {string} [deps.tabIdPrefix] 本窗口的标签 id 前缀（多窗口下必须全局唯一，
 *   否则快照仓库 / 监听登记这类进程级表会被两个窗口互相覆盖）
 * @param {boolean} [deps.defaultIncognito] 无痕窗口：本窗口所有新标签默认无痕
 * @param {(opts?: { incognito?: boolean }) => void} [deps.onOpenNewWindow] 新窗口请求
 *   （omnibox 的 open_new_window / open_incognito_window 踏板动作）
 * @param {(url: string) => void} [deps.openLinkInNewWindow] 「在新窗口中打开链接」
 *   （网页右键菜单）—— 应打开完整浏览器窗口而不是辅助子窗口
 * @param {() => object} deps.getSearchService 搜索引擎服务（**必须 getter**：它在 main.js
 *   里创建得比本单元晚，按值传会直接踩 const 的 TDZ 抛错）
 * @param {{ get: (key:string)=>any, set: (key:string,value:any)=>any }} [deps.settings]
 *   设置读写端口（缩放记忆落库用）。**端口而不是服务实例**：落在哪个 profile /
 *   存储上由宿主决定，本单元只当 KV 用。
 * @param {(action: string) => boolean} [deps.surfaceCommand]
 *   「活动面」的面级命令分发（活动面 = 聚焦框标的那个面，可以是独立侧栏）。
 *   返回 true = 已处理；false = 交回标签那条老路。缺省不注入 → 永远走标签（行为不变）。
 * @param {(command: string) => string} [deps.getMenuAccelerator]
 *   网页右键菜单的快捷键解析器（`command` → Electron accelerator）。由装配层用
 *   当前键位绑定 `keybindings.mjs#menuAccelerator`；缺省 = 菜单不显示快捷键提示。
 */
export function createBrowserWindowRuntime(deps: BrowserWindowRuntimeDeps): BrowserWindowRuntimeCore {
  const {
    win,
    webContentsManager,
    layoutCoordinator,
    emit,
    tabRules,
    tabAdjust,
    tabStacks,
    tabSplits,
    tabGroups,
    spaceRuntime,
    getPdfViewerEnabled,
    getSplitOptions,
    getNewTabUrl,
    getAutoPictureInPictureEnabled,
    getFaviconService,
    getHistoryService,
    getExtensionService,
    passwordOverlayController,
    hideFloat,
    getSnapshotService,
    openSubWindowByType,
    getSearchService,
    getSlotMenuItems,
    getSlotLifecycle,
    getHostMenuItems,
    getFocusedSurface,
    getFocusedWebContents,
    tabIdPrefix,
    defaultIncognito,
    onOpenNewWindow,
    openLinkInNewWindow,
    // 小窗预览（N1）：应用级单例，端口由装配层从 shared 取（不是每窗口一份）
    openPeekPreview,
    openCaptureHub,
    archiveCurrentPage,
    // 自动化（D2 命令链 + D3 手势）：同样是应用级能力，端口延迟解析 shared
    runCommandChain,
    handleTabEvent,
    // 集锦动作（WP1）：`note:*` 的唯一实现住在 main/note-actions.js（应用级）
    runNoteAction,
    shouldSuppressContextMenu,
    // 网页翻译（C3）：把某一页定向翻译（目标语言 / 引擎都在 APPS 层）
    translatePage,
    runAsProfile,
    // 站点守卫（弹窗策略）：`{ tabId, webContents, url, disposition }` → boolean。
    // 由装配层从 shared 取（判定与询问在 APPS 层 site-guard.js，infra 只认「放 / 不放」）。
    // **必须同步**：setWindowOpenHandler 的返回值只在这一拍有效。
    guardWindowOpen,
    getMenuAccelerator,
    onTabClosed: onRuntimeTabClosed,
    // 用户脚本（插件贡献面 `contributes.userscripts`）：URL → 该页要执行的脚本代码。
    // 同样是延迟解析的端口：插件表面在 main.js 里建得比本单元晚。
    getUserScriptsForUrl,
    // 声明式页面补丁（PART18 `contributes.pagePatches`）：URL → `{ css, js }`。
    // 与用户脚本同一次注入，但方向相反 —— 它是"往目标站点叠样式/行为"（去广告、改版、增强）。
    getPagePatchesForUrl,
    settings
  } = deps

  /**
   * 目标页在**窗口内容区**里的矩形 —— 标注浮层 / 框选层都要逐像素盖住它，
   * 坐标系必须是浮层所在的那一个。
   *
   * ⚠ 这里踩过两个坑，合起来的表现是"点了『截取选区』毫无反应、且不打任何日志"：
   *   ① `findViewByWebContents(wc)` 返回的是**描述对象** `{ kind, id, view }` ——
   *      `getBounds` 在它的 `view` 字段上，不在描述对象本身，直接调永远拿不到；
   *   ② 就算取到 `view`，标签视图挂在 `tabHost` 里，`view.getBounds()` 给的是
   *      **相对 tabHost** 的坐标，与浮层所处的内容区坐标系不是一回事（会整体偏移）。
   * 改用布局层现成的 `getFocusedWebBounds()`：它返回的就是**窗口内容区坐标**，
   * 且已覆盖"聚焦在侧栏 / 分屏某一格 / 普通标签"这几种情况（见该方法自己的说明）。
   */
  function focusedWebBounds() {
    try {
      const rect = layoutCoordinator && typeof layoutCoordinator.getFocusedWebBounds === 'function'
        ? layoutCoordinator.getFocusedWebBounds()
        : null
      if (!rect || !(rect.width > 0) || !(rect.height > 0)) return null
      return rect
    } catch (_) {
      return null
    }
  }

  // 截图标注浮层：三种截图（可见区域 / 整页 / 选区）的**唯一交付口**。
  // 它是浏览器窗口里的独立原生视图（不是应用子窗口），位置由本窗口的布局层给出。
  const captureEditorOverlay = createCaptureEditorOverlay({
    layoutCoordinator,
    win,
    getViewBounds: focusedWebBounds
  })

  /**
   * 框选截图（J7 收口）：把覆盖层摆到**点击的那个页面视图**的矩形上。
   */
  const captureRegion = createCaptureRegion({
    layoutCoordinator,
    getViewBounds: focusedWebBounds,
    // 交付与「可见区域 / 整页」同一口径：截图完成 → 就地标注浮层。
    // 第 4 个参数是框选时记下的目标视图矩形（框选期间焦点不在网页上，浮层自己取不可靠）。
    openCaptureEditor: (wc: WebContents, buffer: Buffer, place: string, viewBounds: unknown) =>
      captureEditorOverlay.open(wc, buffer, place, viewBounds)
  })

  // 专注模式整窗浮层：显隐由番茄钟状态机驱动（main.js 的 breakModeRef.push → 本对象），
  // 几何在这里铺满**整个窗口内容区**（不是网页区）。
  const breakOverlay = createBreakOverlay({ win, layoutCoordinator })

  /**
   * 页面右键菜单里"外来的那些项"（Chrome 扩展 + Harness 插件插槽）。
   *
   * 为什么提成一个具名函数而不是内联在 TabManager 的 hooks 里：**独立侧栏**里那个网页
   * 也要在自己的右键菜单里看到同样的项。两处各写一份必然漂移（一边加了插件插槽、
   * 另一边忘了），所以这里收成一处，由 runtime 暴露给窗口内的其它视图复用。
   */
  function collectExtensionMenuItems(contents: unknown, params: unknown): unknown[] {
    const items: unknown[] = []
    // ① Chrome 扩展贡献的菜单项（既有能力，语义不变）
    try {
      const extItems = getExtensionService()?.getContextMenuItems(contents, params) || []
      if (Array.isArray(extItems)) items.push(...extItems)
    } catch (_) {}
    // ② Harness 插件插槽贡献的菜单项（官方插槽 webview.context-menu.item，MODE=MULTI）
    //    与 ① 合并后一起交给 context-menu.js 编译成原生菜单（同一条 getExtensionMenuItems 钩子）。
    //    放在同一个钩子里的原因：对用户而言「扩展项」与「插件项」就是同一件事——
    //    页面右键菜单里多出来的项；分两条路径只会让两边的分段/排序各自为政。
    if (typeof getSlotMenuItems === 'function') {
      try {
        const slotItems = getSlotMenuItems(contents, params) || []
        if (Array.isArray(slotItems)) items.push(...slotItems)
      } catch (_) {}
    }
    return items
  }

  /**
   * 「当前聚焦的那块**网页面**」的解析 —— 窗口级能力（查找栏 / 缩放 / 悬停 URL）的**唯一靶子**。
   *
   * ── 为什么要有这一层 ────────────────────────────────────────────────
   * 这个窗口里现在有**两块**网页面：活动标签，以及独立侧栏（`apps/main/web-sidebar.js`）。
   * 这三样能力的靶子必须跟着**键盘焦点**走，否则"在侧栏里按 Ctrl+F"会去搜旁边的标签页。
   *
   * 缺省 = 活动标签（改造前的行为，一字不差）；装配层注入的解析器在侧栏内容页持焦时改指向它。
   * 判据留在装配层：运行时/infra 都不认识"侧栏"这个业务概念，它们只认"给我一个 wc / 一个标识"。
   */
  const focusedSurface = typeof getFocusedSurface === 'function'
    ? getFocusedSurface
    : () => tabManager?.getActiveTabId() || ''
  const focusedWebContents = typeof getFocusedWebContents === 'function'
    ? getFocusedWebContents
    : () => tabManager?.getActiveWebContents()

  /**
   * 「活动面」的**面级命令**分发（装配层注入，见 browser-window-assembly#runSurfaceCommand）。
   *
   * 与 `focusedWebContents` 是同一件事的两面：那个回答"靶子是哪个 webContents"
   *（查找 / 缩放 / 悬停 URL 用它），这个回答"这条**动作**该谁执行"——
   * 有些动作用 webContents 表达不出来（如"关闭"：关标签 ≠ 关掉侧栏那两份视图）。
   *
   * 缺省 = null：宿主一律落回标签那条老路（`tabManager`），行为与改造前**一字不差**。
   * 运行时只负责把端口带在窗口对象上，不认识任何具体的面。
   *
   * @type {null | (action: string) => boolean}
   */
  const surfaceCommand: null | ((action: string) => boolean) = typeof deps.surfaceCommand === 'function' ? deps.surfaceCommand : null

  /**
   * chrome 级瞬态能力的句柄。
   *
   * 为什么先声明 null 再在 TabManager 之后创建：它们的依赖里都有"活动标签"这一项，
   * 而活动标签只有 TabManager 说了算；同时 hooks（在建 TabManager 时就要传入）
   * 又要能引用它们 —— 于是用函数作用域的 `let` 承载，创建后立刻填上。
   */
  let findInPage: ControllerPort | null = null
  let zoom: ReturnType<typeof createZoomController> | null = null
  let hoverUrl: ControllerPort | null = null
  // 拖动落点预览会话（begin / end）。它不依赖"活动标签"，但同样在 TabManager 之后创建
  // ——它的 describePair 要问 TabManager，浮层读写要问 layoutCoordinator。
  let tabDropZone = null
  let splitToolbar = null

  /**
   * 进入**本窗口所属 profile** 的数据作用域执行 fn。
   *
   * 为什么标签事件必须显式声明：`page-favicon-updated` / `page-title-updated` /
   * 导航完成都是 webContents 事件，**不是 IPC 调用** —— 数据域解析当前 profile 时
   * 在 ALS 里找不到发送方，只能回落到主窗口的 profile。多用户下那会把 B 用户
   * 的历史/favicon 图标写到 A 用户的分区。窗口自己知道归属，就在这里声明。
   */
  const ownProfileId = () => {
    try {
      const cur = spaceRuntime && typeof spaceRuntime.getCurrent === 'function' ? spaceRuntime.getCurrent() : null
      return (cur && cur.profileId) || 'default'
    } catch (_) {
      return 'default'
    }
  }
  const asProfile = typeof runAsProfile === 'function'
    ? runAsProfile
    : <T>(_id: string, fn: () => T): T => fn()

  /** 截图服务的延迟解析口：服务晚于本单元创建，用时才取（见文件头依赖注入口径）。 */
  const snapshotServiceOf = () => (typeof getSnapshotService === 'function' ? getSnapshotService() : null)

  /** 先声明后赋值：PiP 的 onReturnToTab 需要它，但 PiP 必须早于 TabManager 创建。 */
  let tabManager: TabManagerRuntimePort | null = null

  // ── 自动画中画（可选特性，默认关闭）──────────────────────────────────────────
  // 开关关闭时（默认）**完全不介入**：切走标签不会弹画中画，与普通浏览器一致。
  // 只有用户显式打开 tabs.auto_picture_in_picture 才启用：标签切走且页面内有
  // 「正在播放」的 <video> 时进入系统画中画；切回来时退出；用户在 PiP 窗口点
  // 「返回标签页」则切回该标签。
  //
  // 为什么放主进程：只有主进程能对隐藏标签的 webContents 执行脚本（渲染层看不到它）。
  // 互斥（同一时刻只允许一个标签进 PiP）与「该标签页面内有没有视频」的记忆都在模块
  // 内部，因此切标签路径上最常见的分支（普通网页、无视频）只多一次内存判断、
  // 零脚本往返 —— 不参与切标签的耗时。
  //
  // 开关用 getter 端口注入并「用时现读」：改设置立刻生效，无需重启。
  const autoPipEnabled = typeof getAutoPictureInPictureEnabled === 'function'
    ? getAutoPictureInPictureEnabled
    : () => false
  const pictureInPicture = createPictureInPicture({
    execute: (wc: unknown, script: string) => (wc as WebContents).executeJavaScript(script),
    onReturnToTab: (tabId: string) => {
      try { tabManager?.switchTo(tabId) } catch (_) {}
    }
  })

  // ── 历史记录器（本窗口唯一的历史写入决策点）──────────────────────────────
  // 记录时机、去重、typedCount、标题兜底、标题合并写全部收口在 history-recorder。
  // 这里只注入依赖：infra 负责报「导航提交 / 页面加载完成 / 标题变化」事实，
  // 本单元负责「记不记、记什么」—— 分层与插件化都不被历史持久化污染。
  // `isTabActive` 闭包引用**后赋值**的 tabManager：创建时它还是 null，调用时已就绪。
  const historyRecorder = createHistoryRecorder({
    getHistoryService,
    getFaviconService,
    getProfileId: ownProfileId,
    runAsProfile: asProfile,
    isTabActive: (tabId: string) => !!tabManager && tabManager.getActiveTabId() === String(tabId)
  })

  // ── 「最近关闭」的跨启动持久化（本窗口所属 profile 的设置项）──────────────
  // 撤销栈本身仍住在 TabManager（内存、本窗口一份），这里只负责两件事：
  // 构造时把上次/上上次启动的记录**播种**进去、栈变化后**镜像**回存储。
  // 无痕窗口不接这两个钩子 —— 无痕会话不该把 URL 写进持久化，也不该看到
  // 正常会话的历史（与历史记录器对无痕的处置同一口径）。
  const recentlyClosedStore = defaultIncognito ? null : createRecentlyClosedStore({ settings })

  tabManager = new TabManager({
    webContentsManager: webContentsManager as unknown as TabManagerOptionsPort['webContentsManager'],
    layoutCoordinator: layoutCoordinator as unknown as TabManagerOptionsPort['layoutCoordinator'],
    emit,
    // 标签领域规则经端口注入（见 main.js 顶部 require 注释）
    tabRules,
    // 标签「调整视图」组合方法（可选端口，运行时真用上 stats()/visibleAfter()）
    tabAdjust,
    tabStacks,
    // 分屏组规则端口（与 tabStacks 平级、正交；见 domain-tabs#TabSplits）
    tabSplits,
    // 速览组规则端口（第三条正交维度：叠放；见 domain-tabs#TabGroups）
    tabGroups,
    context: spaceRuntime,
    // 本窗口的标签 id 前缀 + 无痕窗口语义（多窗口）
    tabIdPrefix,
    defaultIncognito,
    // PDF 内置查看器开关（pdf.viewer_enabled）：关闭时 .pdf 改走 Chromium 下载链路
    getPdfViewerEnabled,
    // 分屏选项（app.split_default_layout / app.split_max_panes）：延迟端口、现读
    getSplitOptions,
    // 「关闭最后一个标签」时替换成的地址：走 APPS 层的新标签页唯一解析
    // （app.home_mode + app.home_url），所有关闭入口共用，不逐次传参
    getNewTabUrl,
    /**
     * 「最后一个标签本身就是新标签页」→ **关掉它就退出**，不再补建新标签页。
     *
     * 用户设置（NG）。判定与地址归一化在本层完成（见 isSameAddress）；infra 只负责
     * 在唯一的"最后一个标签"分支里把地址交出来，因此 IPC / Ctrl+W / 菜单 / 扩展
     * 这些关闭入口行为一致。关窗后若无其它窗口，由 app-lifecycle 的
     * `window-all-closed` 走 QuitController 正常退出（会话落盘等一个都不少）。
     * 归档路径（skipUndoStack）不经过这里，见 TabManager#close 的说明。
     */
    onLastTabClose: ({ url, newTabUrl }: { url: string; newTabUrl: string }) => {
      if (!isSameAddress(url, newTabUrl)) return false
      // 延迟到本轮 IPC 栈结束再关：`tab:close` 的响应要发给**正在被关掉的这个窗口**，
      // 同步 close 会让 invoke 回包打到已销毁的 sender 上（日志里一条刺眼的报错）。
      setImmediate(() => {
        try { win.close() } catch (_) {}
      })
      return true
    },
    hooks: {
      // ── 站点守卫（弹窗策略）──────────────────────────────────────────
      // 缺省（未注入）→ 一律放行，与改造前完全一致（其它宿主 / 单测不受影响）。
      onWindowOpenRequest: (payload: PayloadPort) => (
        typeof guardWindowOpen === 'function' ? guardWindowOpen(payload) : true
      ),
      // 「最近关闭」跨启动：构造时播种、栈变化后镜像（见上方 recentlyClosedStore）。
      ...(recentlyClosedStore ? {
        loadClosedTabs: () => recentlyClosedStore.seed(),
        onClosedStackChanged: (stack) => recentlyClosedStore.mirror(stack)
      } : {}),
      onFaviconUpdated: (pageUrl, faviconUrl) => {
        try {
          asProfile(ownProfileId(), () => getFaviconService()?.cacheAndSync?.(pageUrl, faviconUrl))
        } catch (e) {
          console.error('[favicon] cacheAndSync failed:', errorMessage(e))
        }
      },
      // 页面标题产生（page-title-updated）时回写历史：
      // 导航那一刻标题尚未生成，记录时只能先用 hostname 兜底；这里拿到真实标题后
      // 用 updateTitle 精准补全（不增 visitCount）。合并/节流在 recorder 内部。
      onTitleUpdated: (payload: PayloadPort) => historyRecorder.onTitleUpdated(payload),
      // 导航已提交（跨文档 did-navigate / 同文档 did-navigate-in-page）：
      // 跨文档只更新状态不落库（等 did-finish-load，避免「只有网址」）；
      // 同文档直接记录（SPA 路由 / 站内链接点击的数据都不再丢）。
      onNavigationCommitted: (payload: PayloadPort) => historyRecorder.onNavigationCommitted(payload),
      // 页面加载完成（did-finish-load）：标题已就绪，这才是真正落库的时机。
      onPageReady: (payload: PayloadPort) => historyRecorder.onPageReady(payload),
      // 扩展页没有声明 favicon 时的展示兜底（对齐 Chrome：显示扩展自己的图标）。
      // 空串 = 不是扩展页 / 扩展没有图标 → 标签行保持标题首字。
      // 只写标签内存态，不落 favicons 库 / 历史（见 infra tabEvents 的说明）。
      onFaviconFallback: ({ url, profileId }: { url: string; profileId?: string }) => extensionPageIconUrl(getExtensionService, url, profileId),
      /**
       * ── 扩展覆盖新标签页（`chrome_url_overrides.newtab`）──────────────────
       * 地址在 loadURL 之前的最后一道解析（见 TabManager#_resolveTabUrl）。
       *
       * 为什么在这里、而不是 hira:// 协议层 302：
       *   Chromium 会把 302 目标 `chrome-extension://<id>/…` 当网络地址做 DNS 解析
       *   （扩展 id 被当域名）→ ERR_NAME_NOT_RESOLVED → 错误页。扩展页只能由浏览器
       *   **主动 loadURL**，所以替换点必须在「即将加载」这一步。
       *
       * 为什么只换 `hira://newtab`：用户显式导航到别的地址（含 custom 主页）不该被改写；
       * 覆盖只属于「内置新标签页」这一语义。
       *
       * 无痕 / 容器标签不换：它们的 Session 不是本 profile 的扩展宿主，
       * 换过去只会得到 ERR_FILE_NOT_FOUND / "Invalid WebContents session"。
       * 返回空串 = 不改（infra 侧原样加载 hira://newtab）。
       */
      onResolveTabUrl: ({ url, incognito, containerProfileId, profileId }: { url: string; incognito?: boolean; containerProfileId?: string | null; profileId?: string }) => {
        if (incognito || containerProfileId) return ''
        if (!isHiraNewTabUrl(url)) return ''
        try {
          const svc = getExtensionService(profileId)
          return svc && typeof svc.getNewTabOverrideUrl === 'function' ? svc.getNewTabOverrideUrl(url) || '' : ''
        } catch (_) { return '' }
      },
      /**
       * 标签视图的**画布色**（网页还没画出自己的底色时露出的那一层）。
       *
       * 内置新标签页必须是**透明画布**：壁纸只由窗口外壳那一份 `#chrome-theme-background`
       * 绘制（`position:fixed; inset:0`，在所有 WebContentsView 之下）。新标签页自己
       * 再画一份镜像去对齐的时代已经结束 —— 面板 / 侧栏动画每帧都在改标签视图的 bounds，
       * 镜像几何永远追不上，于是壁纸跟着动、接缝补不上、闪一下。
       *
       * 返回空串 = 交给 infra 的默认白纸（普通网页不写 body 背景时应当看见白纸，
       * 不能被主题色或壁纸透染）。判据与扩展覆盖新标签页共用同一个 `isHiraNewTabUrl`。
       */
      tabCanvasColor: ({ url }: { url: string }) => (isHiraNewTabUrl(url) ? '#00000000' : ''),
      // navigate() 已提交：这里只登记 typed 意图（地址栏手动输入 → typedCount +1）。
      // 真正的历史写入统一由 recorder 在加载完成 / 页内导航 / 标签激活时完成。
      onNavigate: (payload: PayloadPort) => {
        const tabId = String(payload.tabId || '')
        const url = String(payload.url || '')
        const typed = payload.typed === true
        if (typed) historyRecorder.markTypedIntent(tabId, url)
      },
      // ── 链接悬停 URL（状态栏提示）──────────────────────────────────
      // 逐帧高频事件：只做"过滤 + 转发"，且**只有活动标签**的悬停才算数
      // （见 hover-url-bar 的说明）。infra 侧只报事实，不认识浮层。
      onTargetUrl: ({ tabId, url }: { tabId: string; url: string }) => {
        if (hoverUrl) hoverUrl.update(tabId, url)
      },
      onTabCreated: (tabId: string, wc: WebContents) => {
        setTimeout(() => {
          try {
            const record = tabManager && typeof tabManager.list === 'function'
              ? tabManager.list().find((tab: Record<string, unknown>) => String(tab.tabId || '') === tabId)
              : null
            const url = (wc.isDestroyed() ? '' : wc.getURL()) || String(record?.url || '')
            if (url && typeof handleTabEvent === 'function') {
              void handleTabEvent({ trigger: 'open', tabId, url, title: wc.getTitle(), active: !!tabManager && tabManager.getActiveTabId() === tabId })
            }
          } catch (_) {}
        }, 0)
        // 主 frame 开始导航 = 这一页的查找上下文没了 → **收起查找栏**（逐字对齐 Hira：
        // main/ipc/findBar.js 的 `registerFindInPageViewListener` 在 did-start-navigation
        // 里销毁查找栏）。刻意**不做**"加载完成后重跑搜索"：那会在每次跳转时凭空发起一次
        // 全页扫描（实测 ~400ms），用户感受到的就是"网页在载入 + 查找在扫"互相打架。
        // 只认"主 frame 且非原地"（原地 = 同页锚点 `#`，不该把栏关掉）；形参口径与本文件
        // 其它 did-start-navigation 监听一致，若形状不符则交给 onDidNavigate 兜底。
        try {
          wc.on('did-start-navigation', (_e, _url, isInPlace, isMainFrame) => {
            if (isMainFrame === true && isInPlace !== true) {
              try { if (findInPage) findInPage.close() } catch (_) {}
            }
          })
        } catch (_) {}
        // Ctrl+滚轮缩放：Chromium 只发出「用户在请求缩放」这个信号，**不会自己改
        // zoomLevel** —— 必须由应用响应并执行，否则滚轮完全没反应（而菜单 / 快捷键
        // 走的是另一条直接调用 zoom.step 的路径，所以那两条一直是好的）。
        // 放在最前面：下面「无痕标签不进扩展系统」会提前 return，别把它挡住。
        try {
          wc.on('zoom-changed', (e, direction) => {
            // 自己执行缩放并阻止 Chromium 的默认缩放：两边都做会叠成两格。
            try { e.preventDefault() } catch (_) {}
            // 按**这一页**缩放（鼠标在哪个页面滚就缩哪个），不是"活动标签"——
            // 目标 wc 由事件给出，直接用。
            if (zoom) zoom.step(direction === 'in' ? 1 : -1, wc, 'wheel')
          })
        } catch (_) {}
        // ── 会话一致闸门：只有「跑在扩展系统那个 Session 上」的标签才进 ECE ──────
        // ECE 在构造时绑定了**一个** Session，addTab / selectTab 传入的 WebContents
        // 会话与它不一致时直接抛：
        //   "Invalid WebContents argument. Its session must match the session provided
        //    to ElectronChromeExtensions constructor options."
        // 命中这条的标签有两类，语义上都**不该**进扩展系统：
        //   · 无痕标签 —— 独立的**内存 partition**；Chrome 默认也不给无痕开扩展；
        //   · 容器标签 —— `_createTabSync({ containerProfileId })` 让页面跑在**另一个
        //     profile 的 Session** 上（cookie / 存储按身份隔离），同理不是本 profile 的
        //     扩展宿主。
        // 旧实现只判无痕，容器标签每建一个就抛一条错、并在 `selectTab` 时再抛一次，
        // 既污染日志又让「扩展为什么不生效」难以定位。改为按会话身份判定，两类一起挡住。
        let extService = null
        try { extService = getExtensionService() } catch (_) { extService = null }
        const extSession = extService && extService.session
        let tabSession = null
        try { tabSession = wc.session } catch (_) { tabSession = null }
        if (!extService || !extSession || tabSession !== extSession) return
        // 已经注册过（跨窗口迁移的目标侧）→ 直接跳过：ECE 的 addTab 非幂等，
        // 重复注册会累积监听并让扩展状态被更新两遍（见 extRegisteredWc 说明）。
        if (extRegisteredWc.has(wc)) return
        // 置位必须在 addTab **成功之后**：先置位再调用的话，一次瞬时失败（服务正在
        // 初始化 / 会话刚销毁）就会让这张标签永久失去注册机会，且再无重试入口。
        try {
          extService.addTab?.(wc, win)
          extRegisteredWc.add(wc)
        } catch (e) {
          console.error('[ext] addTab failed:', errorMessage(e))
        }
      },
      onTabSwitched: (tabId: string, wc: WebContents) => {
        // 切标签 = 悬停上下文没了：新页面还没被指过，旧页面的胶囊必须立刻消失
        //（它不是模态浮层，留着就是"停在一个已经不存在的链接上"）。
        try { if (hoverUrl) hoverUrl.clear() } catch (_) {}
        // 查找栏是**按标签**的会话：切走就收起并清高亮（旧页面的高亮留着毫无意义，
        // 而查找栏浮层是窗口级的、不收起就会继续显示上一个页面的计数）。
        try { if (findInPage) findInPage.close() } catch (_) {}
        // 截图标注浮层盖的是**上一页的那一块**：切走还留着，用户会看到新标签被一张旧图
        // 压暗（而且笔一落就画在旧图上）。切标签即收起（Esc / 点空白 / 关闭同一条路）。
        try { if (captureEditorOverlay) captureEditorOverlay.hide() } catch (_) {}
        // 与 onTabCreated 同一口径：只有本 profile 扩展会话上的标签才通知 ECE。
        // 容器标签 / 无痕标签的会话与 ECE 构造会话不同，selectTab 会直接抛错。
        let switchExtService = null
        try { switchExtService = getExtensionService() } catch (_) { switchExtService = null }
        let switchTabSession = null
        try { switchTabSession = wc.session } catch (_) { switchTabSession = null }
        if (switchExtService && switchTabSession === switchExtService.session) {
          try { switchExtService.selectTab?.(wc) } catch (e) {
            console.error('[ext] selectTab failed:', errorMessage(e))
          }
        }
        // 切标签即收起密码浮层的**瞬态卡**：旧页面只是被隐藏（webContents 未销毁，
        // 收不到任何页内事件），菜单 / 解锁卡若不收就会"挂"在新标签上。
        // ⚠ 保存提示卡不收：它是待用户决定的请求，跟着窗口走而不是跟着标签走。
        try { passwordOverlayController.hideTransient?.() } catch (_) {}
        // 标签预览同理：它锚在旧标签的 tab 上，切走后不收起就会一直挂着。
        try { hideFloat('tabpreview-overlay') } catch (_) {}
        // 建议下拉：内容是旧标签的上下文，切走后不收就会「黏在屏幕上」、点空白也关不掉。
        try { hideFloat('searchbar-overlay') } catch (_) {}
        // 「总览」浮层：切标签时必然已离开「随手看一眼」的语境，收起（铺满整窗的模态层）。
        try { hideFloat('overview-overlay') } catch (_) {}
        // 按钮编辑浮层：切标签即离开「编辑按钮」的语境，退出编辑。
        try { hideFloat('buttons-edit-overlay') } catch (_) {}
        // 通用「选择目标」浮层：它锚在触发项下缘 —— 切标签后未必还指得到同一项，
        // 且"选目标"的语境已随切走而结束，收起。
        try { hideFloat('target-picker-overlay') } catch (_) {}
        // 站点信息浮层锚在当前标签的地址栏上，内容全部属于旧标签（权限 / 证书 /
        // Cookie / 拦截），切走后不收起就会把旧站点的语境挂在新页面上。
        try { hideFloat('siteinfo-overlay') } catch (_) {}
        // 注：PiP 退出已由 onTabShown 统一负责（可见性状态的正主）。
        // 旧实现在此处写 `pictureInPicture.exit(_tabId, wc)` —— `_tabId` 是
        // onTabClosed 的形参，在本作用域根本不存在，每次切标签都抛 ReferenceError
        // 并被 catch 吞掉：等于自动画中画**从未真正退出过**。已修正。
        // 标签被激活：后台加载完成的页面在这里补记历史（对齐 RT）。
        try { historyRecorder.onActivation(tabId) } catch (_) {}
      },
      onTabClosed: (_tabId) => {
        try { onRuntimeTabClosed?.(_tabId) } catch (_) {}
        // webContents already destroyed; ECE cleans up via 'destroyed' event
        // 截图与节流状态随之释放，避免内存随开关标签累积
        try { snapshotServiceOf()?.forget(_tabId) } catch (_) {}
        try { pictureInPicture.forget(_tabId) } catch (_) {}
        // 关掉标签后其 hover 预览必须立即消失：预览锚在该标签的 tab 节点上，
        // 节点被移除不会派发 mouseout，renderer 侧的关闭信号会丢 → 由主进程兜底收起。
        try { hideFloat('tabpreview-overlay') } catch (_) {}
        // 悬停 URL 同理：关掉正在悬停的标签，它的胶囊不该留着。
        try { if (hoverUrl) hoverUrl.clear() } catch (_) {}
        // 查找栏的**按标签记忆**随标签一起走：tabId 前缀含窗口序号、但同窗口内会复用，
        // 不清掉会让下一个标签"继承"上一个标签的搜索词。
        try { if (findInPage) findInPage.forgetTab(_tabId) } catch (_) {}
        // 历史记录器：标签状态（当前 url / 去重键）随标签释放，避免 Map 无界增长。
        try { historyRecorder.forget(_tabId) } catch (_) {}
      },
      // 标签即将隐藏（switchTo 在旧 view 仍挂载、页面仍渲染时触发）：
      // 此刻抓帧才有内容 —— 一旦 setVisible(false) 或视图脱离宿主，capturePage 返回空图。
      // 采集本身节流（1s/tab）且异步，不阻塞切换路径。
      onTabWillHide: (tabId: string, wc: WebContents) => {
        snapshotServiceOf()?.capture(tabId, wc).catch(() => {})
      },
      // 可见性变化（对齐 RT tab-layout：PiP enter/exit on visibility transitions）：
      // 与 onTabWillHide（采帧）拆开 —— 采帧只在销毁/隐藏之前有效；而可见性是**状态本身**，
      // 必须覆盖「关闭活动标签 → 接替标签变可见」这条不经过 switchTo 的路径，
      // 否则接替标签会在可见状态下继续挂着系统 PiP 小窗。
      onTabHidden: (tabId: string, wc: WebContents) => {
        // 自动画中画（默认关闭）：仅在设置开启时才尝试进入 PiP；异步、不 await，
        // 绝不拖慢切换。开关关闭时这里什么都不做 —— 与普通浏览器行为一致。
        if (autoPipEnabled()) pictureInPicture.enter(tabId, wc).catch(() => {})
      },
      onTabShown: (tabId: string, wc: WebContents) => {
        // 无条件调用是安全的：开关关闭时 enter 从未执行，模块内 maybePip 为空，
        // exit 会立即返回、零脚本往返；也覆盖「进入 PiP 后又把开关关掉」的情形。
        try { pictureInPicture.exit(tabId, wc) } catch (_) {}
      },
      // 新窗口请求（omnibox 踏板 open_new_window / open_incognito_window）：
      // 接不到端口时不做任何事 —— 与加入本 hook 之前的行为一致。
      onOpenNewWindow: (opts: { incognito?: boolean } = {}) => {
        if (typeof onOpenNewWindow === 'function') onOpenNewWindow(opts)
      },
      onOpenInNewWindow: (url: string) => {
        // 「在新窗口中打开链接」（网页右键菜单）。Chrome / Edge 在这里开的是一个
        // **完整浏览器窗口**（自带 chrome 与独立标签条），不是辅助子窗口 ——
        // 因此交给窗口装配器的 openNewWindow；未注入时保持静默（与之前一致）。
        if (!url) return
        if (typeof openLinkInNewWindow === 'function') {
          openLinkInNewWindow(String(url))
          return
        }
        console.warn('[window] open link in new window is unavailable')
      },
      onViewSource: (url: string) => {
        if (!url) return
        openSubWindowByType(WINDOW_TYPES.VIEW_SOURCE, { url: String(url) })
      },
      onGetSearchUrl: (query: string) => getSearchService()?.buildSearchUrl(String(query || '')) || '',
      // 引擎名同样由搜索域给出（内置查真源表 / 自定义用用户标题），不在这里写死文案。
      onGetSearchLabel: (text: string) => getSearchService()?.buildSearchLabel(String(text || '')) || '',
      // 右键菜单的快捷键提示（与独立侧栏共用同一个注入端口，见 deps 说明）。
      getMenuAccelerator: (command: string) => (typeof getMenuAccelerator === 'function'
        ? getMenuAccelerator(command)
        : ''),
      getExtensionMenuItems: (contents: WebContents | null | undefined, params: PayloadPort) => collectExtensionMenuItems(contents, params),

      /**
       * **宿主自带的页面右键项**（数据）：目前是「添加为网页面板」（把当前页放到侧栏）。
       *
       * 为什么单开一条钩子而不是塞进上面那个：扩展项 / 插件插槽项是"外来件贡献的"，
       * 这一条是**浏览器自己的能力**，生命周期与来源都不同（前者随扩展启停变化）。
       * infra 侧只把它当数据塞进原生菜单（见 context-menu.js#compileTemplate）。
       */
      getHostMenuItems: (contents: WebContents | null | undefined, params: PayloadPort) => (typeof getHostMenuItems === 'function'
        ? getHostMenuItems(contents, params) || []
        : []),

      // ── 网页生命周期插槽（webview.lifecycle.*，PART7 §7.3）──────────────
      // 三种钩子都转发给 APPS 的适配器（slot-lifecycle.js）；适配器内部已经把
      // 「没接调度器 / 没声明插槽 / 实现抛错 / 同步插槽塞异步实现」全部降级为
      // 「没有插件参与」，所以这里不需要再判一遍 —— 但保留 try/catch 兜住适配器本身。

      /** REDUCE，可改写 / 可取消。**必须同步** —— preventDefault 只在原生回调栈内有效。 */
      onWillNavigate: (payload: PayloadPort) => {
        const lifecycle = typeof getSlotLifecycle === 'function' ? getSlotLifecycle() : null
        if (!lifecycle) return payload
        try { return lifecycle.willNavigate(payload) } catch (_) { return payload }
      },

      /** EVENT：跳转后通知，忽略返回值。 */
      onDidNavigate: (payload: PayloadPort) => {
        if (payload && typeof handleTabEvent === 'function') {
          const tabId = String(payload.tabId || '')
          const url = String(payload.url || '')
          if (tabId && url) {
            void handleTabEvent({ trigger: 'navigate', tabId, url, title: String(payload.title || ''), active: !!tabManager && tabManager.getActiveTabId() === tabId })
          }
        }
        // ① 悬停 URL：换页了，旧链接的胶囊立刻收（此刻指针可能还压在原地，
        //    不收就会出现"停在旧页面的链接上"）。
        try { if (hoverUrl) hoverUrl.clear() } catch (_) {}
        // ② 查找：**换页即收起查找栏**（对齐 Hira 的 did-start-navigation → 关闭）。
        //    刻意不保留"加载完成后自动重跑"——那会在每次跳转时凭空发起一次全页扫描
        //    （实测 ~400ms），正是"网页载入与查找互相打架、切下一个就卡"的来源。
        //    （主路径是 did-start-navigation，见 onTabCreated；这里是它的兜底。）
        try { if (findInPage && payload) findInPage.close() } catch (_) {}
        const lifecycle = typeof getSlotLifecycle === 'function' ? getSlotLifecycle() : null
        if (!lifecycle) return
        try { lifecycle.didNavigate(payload) } catch (_) {}
      },

      /** EVENT：页面加载完成通知，忽略返回值。 */
      onDidFinishLoad: (payload: PayloadPort) => {
        // 新页面画完了：
        //   ① 把缩放恢复到**该站点记忆的比例**（没有记忆 = 100%）。
        //      必须按 payload.tabId 解析出**那一个** webContents 再恢复 —— 后台标签
        //      加载完成也会走到这里，用"活动标签"去恢复会把它的缩放写错一页。
        //      放在 did-finish-load 而不是 did-navigate：恢复缩放会触发页面重排，
        //      加载完成前做等于白做一次。
        //   ② 不碰查找栏：换页时它已经收起了（见 onDidNavigate / did-start-navigation），
        //      曾经在这里"加载完成后重跑一次搜索"——那正是每次导航都卡一下的来源。
        try {
          const tabId = payload && payload.tabId ? String(payload.tabId) : ''
          const view = tabId ? webContentsManager.getTab(tabId) : null
          const wc = view && view.webContents ? view.webContents : null
          if (zoom && wc) zoom.restore(wc)
          /**
           * ③ 网页注入（Boosts / 强制深色 / 用户脚本三合一）—— 与缩放恢复**同一时机**：
           * 页面已画完，注入才不会被后续渲染覆盖。
           *
           * 「注什么」由纯层 `resolveInjection` 决定（站点匹配 + 全局/站点开关 + 载荷拼装），
           * 这里只负责把两个设置读出来喂给它；「怎么注」是 infra 的哑通道 `applyPageInjections`。
           * 空载荷不做任何往返。
           */
          if (wc && payload && payload.url) {
            const pageUrl = String(payload.url)
            const readSetting = (key: string, dflt: unknown) => {
              try {
                return settings && typeof settings.get === 'function' ? settings.get(key) : dflt
              } catch (_) {
                return dflt
              }
            }
            const injection = resolveInjection({
              url: pageUrl,
              rules: readSetting(PAGE_INJECT_SETTING_KEYS.rules, ''),
              globalForceDark: readSetting(PAGE_INJECT_SETTING_KEYS.forceDark, DEFAULT_FORCE_DARK) === 'on'
            })
            /**
             * ④ 声明式页面补丁（PART18 `contributes.pagePatches`）。
             *
             * 与站点注入**并进同一趟** executeJavaScript 与 insertCSS：两者都是
             * "页面画完后叠上去"，分开发只是多两次往返。
             * 补丁按 CSS/JS 分开返回（插件只改样式时不必陪跑一段 JS）。
             */
            let patchCss = ''
            let patchJs = ''
            if (typeof getPagePatchesForUrl === 'function') {
              try {
                const patch = getPagePatchesForUrl(pageUrl) || {}
                patchCss = String(patch.css || '')
                patchJs = String(patch.js || '')
              } catch (e) {
                console.warn('[browser-window] 页面补丁解析失败：', errorMessage(e))
              }
            }
            const css = [injection.css, patchCss].filter(Boolean).join('\n')
            const js = [injection.js, patchJs].filter(Boolean).join('\n;\n')
            if (css || js) applyPageInjections(wc, { css, js })

            /**
             * ⑤ 用户脚本（插件贡献面 `contributes.userscripts`）。
             *
             * **单独一趟**：脚本可能带 `@require`（首次要联网取库），不能让它把
             * 站点样式的注入一起拖住。取码通常走缓存/微任务，脚本没有 `@require`
             * 时这一趟就是空串 → 不产生任何跨进程往返。
             *
             * 落地前必须复核两件事：webContents 还活着、页面还是当初那一个
             * —— 取码期间用户完全可能已经跳走，那时注入等于把脚本打到错误的页面上。
             *
             * 每条脚本各自 IIFE + try/catch，单条抛错只影响它自己
             * （见 shared-types/userscript.mjs#buildUserScriptCode）。
             * 端口做成 getter（`shared.getUserScriptsForUrl`）：插件表面在 main.js 里
             * 建得比窗口运行单元晚，按值取会捕获到 undefined。
             */
            if (typeof getUserScriptsForUrl === 'function') {
              Promise.resolve()
                .then(() => getUserScriptsForUrl(pageUrl))
                .then((code) => {
                  const text = String(code || '')
                  if (!text) return
                  if (!wc || (typeof wc.isDestroyed === 'function' && wc.isDestroyed())) return
                  let current = ''
                  try { current = String(wc.getURL() || '') } catch (_) { current = pageUrl }
                  if (current !== pageUrl) return
                  applyPageInjections(wc, { css: '', js: text })
                })
                .catch((e) => {
                  console.warn('[browser-window] 用户脚本注入失败：', errorMessage(e))
                })
            }
          }
        } catch (_) {}
        const lifecycle = typeof getSlotLifecycle === 'function' ? getSlotLifecycle() : null
        if (!lifecycle) return
        try { lifecycle.didFinishLoad(payload) } catch (_) {}
      },

      /**
       * 截图（J7）：可见区域 / 整页 / 选区 → **浏览器窗口内的就地标注浮层**。
       *
       * 分工：取图在 `./capture-page`（可见区域走 `capturePage`，整页走 CDP + 自动兜底）；
       * 框选在 `./capture-region`（独立原生覆盖层）；交付一律 `captureEditorOverlay.open` ——
       * 三种方式只是"图从哪来"不同，拿到的都是同一张 PNG，进的是同一个标注浮层。
       */
      onCapturePage: async (payload: { webContents: WebContents | null; mode: 'fullpage' | 'viewport' | 'region' }) => {
        try {
          const wc = payload && payload.webContents ? payload.webContents : null
          if (!wc) return
          const mode = payload && payload.mode === 'viewport'
            ? 'viewport'
            : (payload && payload.mode === 'region' ? 'region' : 'fullpage')
          // 框选：交给框选编排（摆图层 → 用户框 → 截那一块 → 打开标注浮层）。
          if (mode === 'region') {
            const res = await captureRegion.start({ webContents: wc })
            if (!res || res.ok === false) {
              console.warn('[capture] 未能进入框选:', (res && res.reason) || '未知原因')
            }
            return
          }
          const buffer = await grabPageImage(wc, mode)
          if (!buffer) return
          await captureEditorOverlay.open(wc, buffer)
          return
        } catch (e) {
          console.error('[capture] failed:', errorMessage(e))
        return
        }
      },

      /**
       * 归档记录（J9）：标签被归档时（**手动**右键 or **自动** `tabs.archiveAfter`）记入「归档区」。
       *
       * 存储用设置项 `archive.entries`（JSON + 容量上限 + 同 URL 去重，见纯层 archive-list）：
       * 天然随 profile 隔离，且**不需要建新表**。infra 只报事实，写在哪由这里决定。
       */
      onTabArchived: (payload: PayloadPort) => {
        try {
          if (!payload || !payload.url) return
          const raw = settings && typeof settings.get === 'function' ? settings.get(ARCHIVE_SETTING_KEY) : ''
          const next = pushArchiveEntry(raw, {
            url: payload.url,
            title: payload.title,
            favicon: payload.favicon,
            spaceId: payload.spaceId,
            archivedAt: Date.now()
          })
          if (settings && typeof settings.set === 'function') settings.set(ARCHIVE_SETTING_KEY, serializeArchive(next))
        } catch (e) {
          console.error('[archive] record failed:', errorMessage(e))
        }
      },

      /**
       * 小窗预览（N1）：**链接**右键 →「在小窗中预览链接」。
       *
       * 只属于链接分组（取 `params.linkURL`）—— 它是"打开这个链接"里最轻的一档，
       * 所以入口不该出现在页面分组里（那里只有 `pageURL`，会变成"把本页搬进小窗"）。
       * 小窗是**应用级单例**（不是每窗口一份），故只把 URL 交给 shared 的端口 ——
       * 窗口装配层不认识"小窗"，正如它不认识"截图存哪"。
       */
      onPeekPreview: (payload: PayloadPort) => {
        const url = payload && payload.url
        if (!url) return
        if (typeof openPeekPreview !== 'function') return
        // 连同**发起页的 session** 一起给：小窗里的网页要与你右键的那一页共享
        // profile 与隐身态（登录态接得上），而不是掉进默认 session 的孤岛。
        // 只有发起点自己拿得到这个事实（webContents.session），所以必须在这里搭一句。
        const wc = payload.webContents as WebContents | null | undefined
        const session = wc?.session || null
        // 连同**发起窗口**一起给：小窗的生命周期绑在它上面（主窗口关掉 → 小窗一起关，
        // 免得留下没人认领的幽灵窗，见 main/peek.js）。发起方是谁只有这里知道。
        openPeekPreview({ url: String(url), session, originWindow: win })
      },
      onOpenCaptureHub: () => {
        if (typeof openCaptureHub === 'function') return openCaptureHub()
        return null
      },
      onArchiveCurrent: () => {
        if (typeof archiveCurrentPage === 'function') return archiveCurrentPage()
        return null
      },
      onFocusAddressBar: () => {
        if (win.isDestroyed()) return
        win.webContents.send('ngipc:event:shortcut:focus-url', {})
      },

      /**
       * 命令链（D2）：地址栏输入里选中一条链时，`omnibox:action` 收到的是 `chain:<id>`，
       * TabManager 剥掉前缀后转到这里 —— 真正的执行在 APPS 层（infra 不认识"链"）。
       */
      onRunCommandChain: (id) => {
        const chainId = String(id || '')
        if (!chainId) return
        if (typeof runCommandChain !== 'function') return
        runCommandChain(chainId)
      },

      /**
       * 侧栏面板（地址栏 `!面板名` → `panel:<id>`）。
       *
       * infra 只剥前缀转交，不知道面板目录长什么样；本层用 layoutCoordinator 的
       * `togglePanel` 打开（与 rail / navbar 上点面板按钮走**同一个**入口，
       * 因此"面板落在哪一侧 / 已被打开时怎么处理"天然一致，不会各写一套）。
       */
      onOpenPanel: (id) => {
        const panelId = String(id || '')
        if (!panelId) return
        try {
          layoutCoordinator.togglePanel(panelId, {})
        } catch (e) {
          console.warn('[layout] panel bang failed:', panelId, errorMessage(e))
        }
      },

      /**
       * 集锦动作（WP1）：地址栏 `note:<action>` 剥完前缀后转到这里。
       *
       * 真正的实现在 APPS 层（`main/note-actions.js`）：取标签、存卡片、开面板、
       * 定向广播都在那边 —— infra 不认识"集锦"这个领域。
       * 本层只负责把**发起窗口**的上下文带上（动作层用 getter 取焦点窗口的 TabManager，
       * 所以这里不需要传窗口对象；端口是应用级单例，按调用时解析）。
       */
      onNoteAction: (action, params) => {
        if (typeof runNoteAction !== 'function') return
        try { runNoteAction(String(action || ''), params || {}) } catch (e) {
          console.warn('[notes] action failed:', action, errorMessage(e))
        }
      },

      /**
       * 右键菜单判据（D3）：**刚画完鼠标手势**的那一次松手不该再弹右键菜单。
       * infra 不认识"手势"这个概念，只问宿主"这一次要不要吞"（判定在 main/automation.js）。
       */
      shouldSuppressContextMenu: (wc: WebContents) => {
        if (typeof shouldSuppressContextMenu !== 'function') return false
        try { return Boolean(shouldSuppressContextMenu(wc)) } catch (_) { return false }
      },

      /**
       * 翻译此页（C3）：`{ webContents }` → 定向翻译那一页。
       * infra 只把"哪一页"递出来，目标语言与引擎全在 APPS 层（见 main/translate.ts）。
       */
      onTranslatePage: (payload: PayloadPort) => {
        const wc = payload && payload.webContents
        if (!wc) return
        if (typeof translatePage !== 'function') return
        translatePage(wc as WebContents)
      }
    }
  }) as TabManagerRuntimePort

  // ── chrome 级瞬态能力（按窗口一份）─────────────────────────────────────
  // 三者都依赖"当前活动标签"，而活动标签由上面刚建好的 TabManager 说了算 —— 因此
  // 必须在这里创建（hooks 里引用的是函数作用域的 let，创建后立即生效）。
  findInPage = createFindBarController({
    layoutCoordinator,
    // 「当前聚焦的那块网页面」的标识（`'sidebar'` 或标签 id）——查找栏的**靶子与落位**
    // 都跟着它走（落位由 LayoutCoordinator#getFocusedWebBounds 决定）。
    getActiveTabId: focusedSurface,
    // 用 TabManager 的**公共**接口作为缺省：它就是「活动标签的 webContents」的唯一定义。
    // 装配层注入的 focusedWebContents 会在侧栏聚焦时改指向侧栏 —— 于是"在侧栏里按 Ctrl+F"
    // 找的是侧栏那一页，而不是旁边那个标签。
    getActiveWebContents: focusedWebContents,
    hideFloat
  })

  zoom = createZoomController({
    // 缩放的靶子同样跟随焦点（快捷键 / 菜单 / Ctrl+滚轮都走这条）。
    // 缩放记忆按 **origin** 存在设置里 → 同一站点在标签与侧栏里共享同一个缩放，符合直觉。
    getActiveWebContents: focusedWebContents,
    settings: settings || { get: () => null, set: () => undefined },
    // 通知出口：缩放条浮层 + 本窗口外壳（外壳将来要显示缩放徽标时不必再拉一条通道）
    notify: (payload: ZoomPayload) => {
      // ⚠ 非 restore 来源要先声明「请求显示」：layout.js 的 display 处理器有一道
      // 可见性闸门（`isFloatVisible` 为假就把 display 丢掉）—— 不声明则缩放条永远
      // 显示不出来（bounds 停在 0×0）。restore 来源不声明（那一次不该弹条）。
      if (payload && payload.source !== 'restore') {
        try {
          if (!layoutCoordinator.isFloatVisible('zoom-overlay')) layoutCoordinator.noteFloatShow('zoom-overlay')
        } catch (_) {}
      }
      const send = (wc: WebContents | null) => {
        if (!wc || wc.isDestroyed()) return false
        try { wc.send(`ngipc:event:${ZOOM_EVENT}`, payload); return true } catch (_) { return false }
      }
      // 缩放条浮层：视图尚未创建（本窗口还没缩放过）→ 走惰性创建那条路
      // （sendToFloat 会建视图并等 renderer 就绪）——否则**第一次**缩放不会弹条。
      let ok = false
      try { ok = send(layoutCoordinator.getFloatWebContents('zoom-overlay')) } catch (_) {}
      if (!ok) {
        try {
          layoutCoordinator.sendToFloat('zoom-overlay', `ngipc:event:${ZOOM_EVENT}`, payload).catch(() => {})
        } catch (_) {}
      }
      try { send(layoutCoordinator.getUiShellWebContents()) } catch (_) {}
    }
  })

  hoverUrl = createHoverUrlBar({
    layoutCoordinator,
    getFocusedSurface: focusedSurface
  })

  /**
   * 「拖标签到网页区域」的落位预览（Zen / Vivaldi 同款：拖动期间就把结果画出来）。
   *
   * 装配这一步只交端口 —— 控制器本身不认识 electron、不认识 TabManager：
   *   · getPageRect / 浮层读写 → layoutCoordinator（几何与浮层的唯一主人）；
   *   · describeSplitDrop      → tabManager（"谁是另一格 / 那组满没满"只有标签世界知道）。
   * 于是"预览"与"提交"读的是**同一个答案**（见 TabManager#describeSplitDrop 的说明）。
   */
  tabDropZone = createTabDropZone({
    getCursorPoint: () => {
      try { return require('electron').screen.getCursorScreenPoint() } catch (_) { return null }
    },
    // 光标是**屏幕坐标**，网页矩形是**内容区坐标** —— 中间那一次平移只有这里有。
    getContentOrigin: () => {
      try {
        const b = win.getContentBounds()
        return b ? { x: b.x, y: b.y } : null
      } catch (_) { return null }
    },
    getPageRect: () => {
      try {
        return typeof layoutCoordinator.getContentBounds === 'function' ? layoutCoordinator.getContentBounds() : null
      } catch (_) { return null }
    },
    /**
     * 光标（内容区坐标）是否落在**别的浮层**里 —— 把"浮层盖住网页"的那一块从落点判定里排除。
     *
     * 为什么必须有：rail 收起态悬停展开的标签列浮层盖在网页之上，在它里面正常范围拖动标签时，
     * 光标几何上落在了网页矩形内 → 会误判成"拖到网页上"（闪出分屏预览、松手真的分屏）。
     *
     * ⚠ 两个浮层**必须排除**，各自理由不同：
     *
     * ① `dropzone-overlay` —— 落点预览**自己**。它就画在光标那片区域上，不排除的话
     *    预览一出现就会把自己判成"在浮层里"而立刻收起（自己否决自己）。
     *
     * ② `split-toolbar` —— 分屏工具条。它平时是贴在**某一格自己**右上角的一小条
     *    （144×30，见 main/split-toolbar.js#toolbarRectForPane），属于**分屏的一部分**，
     *    不是"压在网页上的第三层"。
     *    ⚠ 更要紧的是它**会自激振荡**：工具条的显隐跟着"有没有活动分屏"走（`splitToolbar.sync()`
     *    在每次 tab:changed 里调），而 D7 那条"框一画出来就把内容切到配对那一格"会让分屏
     *    进入 / 退出 —— 于是光标只要压在那条上就形成 30fps 的闭环：
     *      预览显 → 切进分屏 → 工具条出现（盖住光标） → 预览被自己判成"在浮层里"收起
     *      → 切出分屏 → 工具条消失 → 预览又能显 → ……
     *    表现就是**拖第 3、4 个标签进已有分屏时，在别的格上闪个不停**（用户实测）。
     *    判据必须只认"与布局无关的浮层"——工具条的可见性由布局决定，正是那个能自激的耦合。
     */
    isOverOverlay: (local: { x: number; y: number }) => {
      try {
        return typeof layoutCoordinator.isPointOverFloat === 'function'
          ? layoutCoordinator.isPointOverFloat(local, { except: ['dropzone-overlay', 'split-toolbar'] })
          : false
      } catch (_) { return false }
    },
    describePair: ({ dragId, baseId }: { dragId: string; baseId: string }) => {
      try { return tabManager.describeSplitDrop({ tabId: dragId, baseTabId: baseId }) } catch (_) { return null }
    },
    /**
     * 拖动开始 / 结束 → **冻结侧栏唤出**（`LayoutCoordinator#setSideRevealHold`）。
     *
     * 这是"在侧栏浮层里拖标签不误触分屏、拖完不黏住"的前提：拖动中指针必然离开侧栏保持圈，
     * 巡看若照常判定就会把拖拽源那个浮层收成 0×0 —— 原生拖拽被系统取消 → 渲染层 `dragend`
     * 丢失 → 采样表与落位框永久残留、活动标签停在配对那一格（"黏住"）；同时浮层一消失，
     * 指针就算落在网页上，250ms 后浮出预览、松手真空分屏（"误触"）。
     * 松手 / 兜底取消 / 出窗自愈都会走到 `onSessionChange(false)`，于是不会一直冻着。
     *
     * `info.sourceWcId` = 发起拖拽的那个视图。要它不是没用的：展开可能**赶在拖拽开始前的
     * 那一瞬间**才落定（悬停驻留 280ms 与 mousedown 撞在同一拍），此时冻结只能拦住后续迁移，
     * 撤不回已经盖上去的浮层 —— 而浮层一盖，松手就落到浮层的 `drop` 上、被当成外部拖入
     * （复制出一个新标签）。带上源视图 id，协调器就能把「误展开」按撤回处理。
     */
    onSessionChange: (active: boolean, info: PayloadPort) => {
      try {
        layoutCoordinator.setSideRevealHold(active === true, {
          sourceWebContentsId: typeof info.sourceWcId === 'number' ? info.sourceWcId : null
        })
      } catch (_) {}
    },
    /** 窗口内容区（屏幕坐标）—— `dragend` 丢失时的「出窗超时」自愈判据，见 tab-drop-zone.js。 */
    getWindowRect: () => {
      try {
        const b = win.getContentBounds()
        return b ? { x: b.x, y: b.y, width: b.width, height: b.height } : null
      } catch (_) { return null }
    },
    /**
     * 落位框**画出来 / 收起来**时，把内容区切到对应那一格 —— 让"即将和谁分屏"看得见。
     *
     * 为什么需要：拖动一开始，活动标签就切成了被拖的那个（Edge / Chrome 同口径，
     * 见 ui-tabbar#tabRecord 的 dragstart）。于是"把标签拖到网页上"时用户看到的是
     * **被拖的页面**，而落位框说的是"和另一格分屏" —— 两者对不上，那块预览就只剩一个
     * 半透明色块可看，看不见自己是在跟哪一页配对。框一画出来就切到**配对那一格**，
     * 用户于是在真实的配对页面上判断左右上下；框收起了（拖开 / 判不出落点）再切回被拖的那个，
     * 拖动手势原有的语义（"我手里拿的就是当前这一格"）一字不变。
     *
     * ⚠ **切到 `pairId` 而不是 `baseTabId`**：拖**当前活动的那一个**标签时（最常见的动作），
     *   `baseTabId` 会是空的（没有"另一格"可言，见 `describeSplitDrop`），配对对象退到标签条
     *   顺序里的相邻标签 —— 而框正是画在那一格上的。按 `pairId` 切，"框画在谁身上就显示谁"
     *   这一条判据在两种情形下都成立（拖后台标签时 pairId 就等于拖前那一格）。
     * ⚠ 与提交侧同源：`dropTabOnContent` 建的组以配对那格为活动格（`activeTabId: pair`），
     *   所以这次切换不是"临时摇一下"—— 松手后停在那一格，所见即所得。
     */
    onPreviewShown: (info: PayloadPort) => {
      const pair = info && info.pairId ? String(info.pairId) : ''
      if (!pair) return
      try { if (pair !== tabManager.getActiveTabId()) tabManager.switchTo(pair) } catch (_) {}
    },
    // 框收起 → 回到被拖的那一格。整场结束那两条路（end / begin 的清理）不会走这里，
    // 见 main/tab-drop-zone.js 的 deps 说明 —— 松手之后归谁由提交侧决定。
    onPreviewHidden: (info: PayloadPort) => {
      const drag = info && info.tabId ? String(info.tabId) : ''
      if (!drag) return
      try { if (drag !== tabManager.getActiveTabId()) tabManager.switchTo(drag) } catch (_) {}
    },
    /**
     * 显示 / 更新预览。
     *
     * ⚠ 三条顺序不能换：
     *   ① `attachFloatView` —— 视图要先存在，`setFloatBounds` 才有对象可设（它查不到视图直接 return）；
     *   ② `noteFloatShow`   —— 逻辑可见态置真（`display` 那条闸门按它放行），并记下当前持焦者；
     *   ③ `setFloatBounds(rect)` —— **视图矩形就是预览块矩形**，这里一设几何即完成。
     * `interactive:false` 让浮层**不吃鼠标**（`setIgnoreMouseEvents(true, {forward:true})`）——
     * 拖动中的落点判定在源窗口完成，这一层只需要被看见。
     */
    showOverlay: (rect: { x: number; y: number; width: number; height: number }, payload: PayloadPort) => {
      try {
        if (typeof layoutCoordinator.attachFloatView === 'function') layoutCoordinator.attachFloatView('dropzone-overlay')
        if (!layoutCoordinator.isFloatVisible('dropzone-overlay')) layoutCoordinator.noteFloatShow('dropzone-overlay')
        layoutCoordinator.setFloatBounds('dropzone-overlay', rect)
        layoutCoordinator.setFloatInteractive('dropzone-overlay', false)
        layoutCoordinator.sendToFloat('dropzone-overlay', `ngipc:event:${DROPZONE_UPDATE}`, payload).catch(() => {})
      } catch (_) {}
    },
    // 收起：先通知渲染页复位 DOM（hideFloat 只收 bounds，不发通知 —— 见 ipc/layout.js 的 hide 通道），
    // 再收 bounds。顺序反过来会出现"DOM 还亮着、视图已经缩成 0"的一帧残影。
    hideOverlay: () => {
      try {
        const wc = layoutCoordinator.getFloatWebContents('dropzone-overlay')
        if (wc && !wc.isDestroyed()) wc.send(`ngipc:event:${DROPZONE_HIDE}`, {})
      } catch (_) {}
      try { hideFloat('dropzone-overlay') } catch (_) {}
    }
  })

  /**
   * 「hover 在分屏上浮出的一排小按钮」（对齐 Zen / Edge 的分屏控件）。
   *
   * 与落点预览（tabDropZone）的分工：两者都"主进程采样 + 独立浮层"，但生命周期正交 ——
   * 那是**拖一个标签**（结束于松手），这是**停在分屏上**（持续）。各自一条采样表，
   * 互不读写对方状态，于是"拖着标签掠过某个分屏"时不会出现两套判据互相打架。
   *
   * 装配只交端口，控制器本身不认识 electron / TabManager：
   *   · 光标 / 内容区原点 / 几何 / 浮层读写 → layoutCoordinator（几何与浮层的唯一主人）；
   *   · runAction                          → tabManager（分屏动作的唯一执行点）。
   * `sync()` 在每次 `tab:changed` 里调（幂等）：有分屏→起表，没有→停表收浮层。
   */
  splitToolbar = createSplitToolbar({
    getCursorPoint: () => {
      try { return require('electron').screen.getCursorScreenPoint() } catch (_) { return null }
    },
    // 光标是**屏幕坐标**，格矩形是**内容区坐标** —— 中间那一次平移只有这里有。
    getContentOrigin: () => {
      try {
        const b = win.getContentBounds()
        return b ? { x: b.x, y: b.y } : null
      } catch (_) { return null }
    },
    // 格矩形 / 当前分屏组：由 LayoutCoordinator 从标签世界取（唯一真源）。
    getGeometry: () => {
      try {
        return typeof layoutCoordinator.getSplitGeometry === 'function' ? layoutCoordinator.getSplitGeometry() : null
      } catch (_) { return null }
    },
    /**
     * 显示 / 更新工具条。
     *
     * ⚠ 三条顺序不能换（与 dropzone 同）：① 视图先存在；② 逻辑可见态置真；③ 设 bounds。
     * 与 dropzone 的关键差别：这里 **interactive:true** —— 工具条上的按钮与拖动手柄
     * 必须吃鼠标（hover 态只挡住格右上角那一小块，拖动态铺满整片分屏区域，都由主进程决定）。
     */
    showOverlay: (rect: { x: number; y: number; width: number; height: number }, payload: PayloadPort) => {
      try {
        if (typeof layoutCoordinator.attachFloatView === 'function') layoutCoordinator.attachFloatView('split-toolbar')
        if (!layoutCoordinator.isFloatVisible('split-toolbar')) layoutCoordinator.noteFloatShow('split-toolbar')
        layoutCoordinator.setFloatBounds('split-toolbar', rect)
        layoutCoordinator.setFloatInteractive('split-toolbar', true)
        layoutCoordinator.sendToFloat('split-toolbar', `ngipc:event:${SPLIT_TOOLBAR_UPDATE}`, payload).catch(() => {})
      } catch (_) {}
    },
    // 收起：先通知渲染页复位 DOM，再收 bounds（顺序反过来会留一帧"DOM 还亮着、视图已缩成 0"）。
    // hideFloat 内部会把 interactive 回落为穿透，无需在这里额外调。
    hideOverlay: () => {
      try {
        const wc = layoutCoordinator.getFloatWebContents('split-toolbar')
        if (wc && !wc.isDestroyed()) wc.send(`ngipc:event:${SPLIT_TOOLBAR_HIDE}`, {})
      } catch (_) {}
      try { hideFloat('split-toolbar') } catch (_) {}
    },
    // 工具条动作 → TabManager（分屏动作的唯一执行点）。动作字符串已在控制器里过白名单。
    runAction: (action: string, info: PayloadPort) => {
      try {
        if (action === 'toggle-layout') return tabManager.toggleSplitLayout(info)
        if (action === 'reverse') return tabManager.reverseSplit(info)
        // 「关闭这一格」= 关闭那一格的标签（不是解散整片分屏）。后续会自动发生：
        // 组里还剩 ≥2 格就继续分屏（`TabManager#close` 把接替格钉在同组内），
        // 只剩 1 格时 `removeTabFromSplit` 顺手解散组 → 退出分屏、那一个标签铺满。
        if (action === 'close-pane') return tabManager.close(String(info.tabId || ''))
        if (action === 'move-member') return tabManager.moveSplitMember(info)
      } catch (err) {
        console.warn('[split-toolbar] action failed:', errorMessage(err))
      }
      return null
    }
  })

  // 分屏状态变化后重算"要不要采样"。tab:changed 是所有标签/分屏变更的唯一出口
  //（创建 / 解散 / 换方向 / 重排 / 切标签都在其中），所以这一处订阅即覆盖全部触发源。
  // sync() 幂等：没有分屏时重复调它不产生任何原生写入。
  try { tabManager.on('tab:changed', () => { try { splitToolbar.sync() } catch (_) {} }) } catch (_) {}
  // 窗口**重新获得焦点**时补一次 sync：失焦清理（browser-window-assembly）会把采样表停掉，
  // 若之后没有任何 tab:changed（纯切窗口回来），表就再也没机会启动 —— 表现是"回来之后
  // 悬停分屏不再浮出控件"。这里补一次，与失焦清理对称。
  try { win.on('focus', () => { try { splitToolbar.sync() } catch (_) {} }) } catch (_) {}
  // 窗口尺寸 / 位置变化：内容区原点与格矩形都变了，但分屏形态没变（不会发 tab:changed），
  // 而光标很可能正好没动（拖动标题栏时屏幕坐标几乎不动）—— 采样侧的"光标静止"快路径会让
  // 工具条停在旧矩形上。这里只做缓存失效，代价是写两个 NaN。
  const invalidateSplitToolbar = () => { try { splitToolbar.invalidate() } catch (_) {} }
  try { win.on('resize', invalidateSplitToolbar) } catch (_) {}
  try { win.on('move', invalidateSplitToolbar) } catch (_) {}

  // 窗口关闭前把防抖中的缩放记忆落库（否则最后一次改动会丢）
  try {
    win.on('closed', () => {
      try { if (zoom) zoom.flush() } catch (_) {}
      // 历史记录器：把合并窗里没落库的标题、以及还在导航链确认窗里的访问立刻写掉，
      // 再释放订阅（flush 在 dispose 内部先执行，顺序不能反：dispose 后不再写库）。
      try { historyRecorder.dispose() } catch (_) {}
      // 截图标注：释放尚未取走的底图，并摘掉窗口几何监听。
      try { captureEditorOverlay.dispose() } catch (_) {}
      // 窗口级标签资源：停止所有自动刷新计时器与尚未提交的变更合批。
      try {
        if (tabManager && typeof tabManager.dispose === 'function') tabManager.dispose()
        else if (tabManager && typeof tabManager.cancelScheduledEmit === 'function') tabManager.cancelScheduledEmit()
      } catch (_) {}
      // 分屏工具条：窗口销毁时停表，避免留下一条永远在跑的光标采样定时器。
      try { if (splitToolbar) splitToolbar.cancel() } catch (_) {}
      // 专注浮层：解绑窗口尺寸监听、作废退场定时器（浮层视图随窗口一起消失）。
      try { breakOverlay.dispose() } catch (_) {}
      // 布局协调器：三条常驻轮询定时器（贴边唤出 / 侧栏浮出巡看 / 指针避让）+ resize
      // 监听一次性收干净。它们本可「靠回调里的 isDestroyed 自愈」，但那是时序依赖 ——
      // 窗口已死就直接把引用点清零（见 LayoutCoordinator#dispose 的说明）。
      try {
        if (layoutCoordinator && typeof layoutCoordinator.dispose === 'function') layoutCoordinator.dispose()
      } catch (_) {}
    })
  } catch (_) {}

  // 把窗口级辅助也一并返回：这样「一个窗口的全部按窗口状态」都在这一个对象上，
  // 注册表只要 scoped(runtime, name) 就能按 IPC 发送方解析（见 window-runtime-registry.js）。
  return {
    win,
    webContentsManager,
    layoutCoordinator,
    tabManager,
    pictureInPicture,
    passwordOverlayController,
    hideFloat,
    // chrome 级瞬态能力：IPC 侧按 scoped('findInPage') / scoped('zoom') 取用
    findInPage,
    zoom,
    // 悬停 URL 提示条端口：窗口失焦这类生命周期收尾要连它的去重基准一起清（见 assembly）
    hoverUrl,
    // 拖动落点预览的会话（IPC 侧按 scoped('tabDropZone') 取用：begin / end）
    tabDropZone,
    // 分屏工具条（IPC 侧按 scoped('splitToolbar') 取用：command）；
    // 生命周期收尾（失焦 / 关闭）调 cancel() 停表收浮层（见 browser-window-assembly）。
    splitToolbar,
    // 专注模式整窗浮层（main.js 的 breakModeRef.push 按窗口逐个 sync 它）
    breakOverlay,
    /**
     * 页面右键菜单里"外来的那些项"（扩展 + 插件插槽）。
     * 独立侧栏的右键菜单复用同一份 —— 两处各写一份必然漂移（见 collectExtensionMenuItems）。
     */
    getExtensionMenuItems: (contents: WebContents | null | undefined, params: PayloadPort) => collectExtensionMenuItems(contents, params),
    /**
     * TabManager 持有的那批生命周期 hooks（其中包含**页面右键菜单的宿主能力**：
     * 截图三方式 / 小窗预览）。
     *
     * 为什么从这里取：那份对象是**内联在 TabManager 构造参数里的对象字面量**，
     * 想在 return 里引用它只能回过头去"把它提成变量"（要跨越几百行搬动一个大对象，
     * 风险远大于收益）。TabManager 自己存着同一个引用（`this._hooks`），取它最稳。
     *
     * 用途：独立侧栏的右键菜单要复用**同一份**宿主能力 —— 两处各写一份必然漂移，
     * 表现就是"标签页右键好使、侧栏右键点了没反应"。
     */
    hooks: (tabManager as unknown as { _hooks?: PayloadPort })?._hooks || {},
    /**
     * 「活动面」的面级命令分发（快捷键 / 应用菜单用）。
     * null = 未注入 → 宿主落回标签那条老路（缺省行为）。
     */
    surfaceCommand
  }
}

module.exports = { createBrowserWindowRuntime }
