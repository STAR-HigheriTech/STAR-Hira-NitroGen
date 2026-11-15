import { randomUUID } from 'node:crypto'
import { EventEmitter } from 'node:events'
import type { NavigationEntry, WebContents, WebContentsView } from 'electron'
import { createTabIdGenerator, createTabRecordFactory, type TabRecord } from './tabRecord'
import { bindTabEvents, type TabEventsHost } from './tabEvents'
import { TabChangeEmitter, type TabChangeHost } from './TabChangeEmitter'
import { TabAutoRefreshController } from './TabAutoRefresh'
import { installTabGroupController, type TabGroupHost } from './TabGroupController'
import * as tabLifecycle from './tabLifecycle'
import * as tabLayout from './tabLayout'
import { canGoBackFromPreSleep, canGoForwardFromPreSleep, restoreNavigationHistory, type PreSleepState } from './tabPreSleep'
import { normalizeUrl, isPdfUrl, resolvePdfTarget } from './tabUrl'
import { siteKeyOf } from '@hira-ng/shared-types/src/url-protocols'
import { commandUrl } from '@hira-ng/shared-types/src/commands'
import { canDuplicate } from '@hira-ng/shared-types/src/tab-policy'
import { retryUrlOf } from './page-reload'
import { navigateWebHistory, readWebNavigationState } from './webNavigation'
// 纯 URL 工具（normalizeUrl / isPdfUrl / **resolvePdfTarget**）已抽到 tabUrl.ts。
// ⚠ PDF 三处入口（新建标签 / 地址栏导航 / will-navigate|will-redirect）一律走 `resolvePdfTarget`，
//   不再各写一遍"判 PDF → 查设置 → 包 URL" —— 那是四条路径漂移的根源。
// 标签记录工厂 + 稳定自增 id：记录字段与 id 生成从本类彻底解耦。
// webContents 事件接线（标签生命周期中最庞大的一块）抽到 tabEvents.ts。
// 休眠快照查询（对齐 RT PreSleepState）：休眠态无需重建视图即可回答前进/后退。
// 标签生命周期（对齐 RT TabLifecycleManager）：休眠/唤醒/批量休眠/激活打点。
// 标签布局（对齐 RT TabLayoutManager）：栈 CRUD、拖拽重排、空栈回收。
// 固定标签的能力表（唯一真源）：分屏 / 速览 / 归档 / 按域名分组等「能不能做」全在这里，
// 不在本文件里再写一遍 `pinned ? ... : ...`。

const CLOSED_TAB_STACK_LIMIT = 50

interface TabWcmPort {
  createTab(tabId: string, options?: TabViewOptions): WebContentsView
  getTab(tabId: string): WebContentsView | null
  destroyTab(tabId: string): boolean
  detachTab(tabId: string): { view: WebContentsView; options: Record<string, unknown> | null } | null
  adoptTab(tabId: string, view: WebContentsView, options?: Record<string, unknown> | null): WebContentsView
  sleepTab(tabId: string): boolean
  isTabSleeping(tabId: string): boolean
  setTabProfileResolver(resolver: (tabId: string) => TabIdentity | null): void
  setTabCanvas(view: WebContentsView, color: string): void
}
interface TabViewOptions {
  incognito?: boolean
  incognitoPartitionId?: string
  webContents?: WebContents
}
interface TabIdentity { profileId?: string; incognito?: boolean; incognitoPartitionId?: string | null }
interface TabLayoutPort {
  getActiveTabId(): string | null
  getActiveSplit?(): { splitId?: string; members?: string[] } | null
  getActiveGlance?(): { glanceId?: string; members?: string[]; frontTabId?: string } | null
  showTab(tabId: string): void
  hideTab(tabId?: string): void
  forgetView(view: WebContentsView): void
  resetTabBounds(): void
}
interface TabRulePort {
  sleepCandidates(input: unknown, options?: Record<string, unknown>): string[]
  reorderIds(ids: string[], options: Record<string, unknown>): { ok: boolean; ids: string[] }
  othersToClose(tabs: unknown[], tabId: string): string[]
  rightToClose(tabs: unknown[], tabId: string): string[]
  undoInsertIndex(index: number, length: number): number
  [key: string]: unknown
}
interface TabAdjustPort {
  tabStats?(value: Array<{ tabId: string; pinned: boolean; audio: boolean }>): { total: number; pinned: number; audio: number }
  visibleAfter?(value: unknown, tabId: string): string[]
  [key: string]: unknown
}
type GenericPort = Record<string, (...args: unknown[]) => unknown>
interface TabManagerHooks {
  loadClosedTabs?: () => ClosedTabEntry[]
  onClosedStackChanged?: (entries: ClosedTabEntry[]) => void
  onCapturePage?: (payload: CapturePagePayload) => void | Promise<void>
  onNoteAction?: (action: string, payload: Record<string, unknown>) => void
  onOpenNewWindow?: (options?: { incognito?: boolean }) => void
  onOpenPanel?: (panelId: string) => void
  onOpenCaptureHub?: () => void
  onArchiveCurrent?: () => unknown
  onFocusAddressBar?: () => void
  onResolveTabUrl?: (context: { url: string; incognito: boolean; containerProfileId: string | null; profileId: string }) => string
  onRunCommandChain?: (chainId: string, context?: unknown) => unknown
  onTabClosed?: (tabId: string) => void
  onTabCreated?: (tabId: string, webContents: WebContents) => void
  onTabSwitched?: (tabId: string, webContents: WebContents) => void
  onTabArchived?: (entry: { tabId: string; url: string; title: string; favicon?: string; spaceId: string }) => void
  tabCanvasColor?: (context: { url: string; incognito: boolean }) => string
  onFaviconUpdated?: (url: string, favicon: string) => void
  onTitleUpdated?: (payload: Record<string, unknown>) => void
  onNavigate?: (payload: Record<string, unknown>) => void
  onTabWillHide?: (tabId: string, webContents: WebContents) => void
  onTabHidden?: (tabId: string, webContents: WebContents) => void
  onTabShown?: (tabId: string, webContents: WebContents) => void
  [key: string]: unknown
}
interface CapturePagePayload {
  tabId: string | null
  webContents: WebContents | null
  mode: 'fullpage' | 'viewport' | 'region'
}
interface ClosedTabEntry { tabId: string; url: string; title: string; favicon: string; pinned: boolean; stackId: string | null; index: number; closedAt: number; launchAt?: number }
interface TabManagerOptionsUpdate {
  allTabs?: boolean
  space?: { profileId?: string; spaceId?: string } | null
  force?: boolean
  skipUndoStack?: boolean
  lastTabUrl?: string
  openAfterCurrent?: boolean
  incognito?: boolean
  containerProfileId?: string | null
  stackId?: string | null
  tabIds?: string[]
  label?: string
  accent?: string
  collapsed?: boolean
  pinned?: boolean
  layout?: string
  inactiveThresholdMs?: number
  excludePinned?: boolean
  [key: string]: unknown
}
interface TabCreateInput {
  url?: string
  pinned?: boolean
  openInBackground?: boolean
  incognito?: boolean
  incognitoPartitionId?: string | null
  openAfterCurrent?: boolean
  navHistory?: NavigationEntry[]
  navHistoryIndex?: number
  webContents?: WebContents
  openerTabId?: string
  sleeping?: boolean
  containerProfileId?: string | null
  muted?: boolean
  lastActivated?: number
  position?: number
  title?: string
  favicon?: string
}
interface NavigateInput {
  tabId?: string
  url?: string
  title?: string
  favicon?: string
  typed?: boolean
}
interface SleepInactiveOptions { inactiveThresholdMs?: number; excludePinned?: boolean }
interface ArchiveInactiveOptions { inactiveThresholdMs?: number }
type TabCreationResult =
  | { tabId: string; url: string; view: WebContentsView; restoredNav: boolean; sleeping?: false }
  | { tabId: string; url: string; view: null; restoredNav: false; sleeping: true }
interface TabManagerOptions {
  webContentsManager?: TabWcmPort
  layoutCoordinator?: TabLayoutPort
  emit?: (event: string, payload: unknown) => void
  hooks?: TabManagerHooks
  tabRules: TabRulePort
  tabAdjust?: TabAdjustPort | null
  tabStacks?: GenericPort | null
  tabSplits?: GenericPort | null
  tabGroups?: GenericPort | null
  context?: { getCurrent?: () => { profileId?: string; spaceId?: string }; setCurrent?: (identity: { profileId: string; spaceId: string }) => void }
  getPdfViewerEnabled?: () => boolean
  getSplitOptions?: () => { maxPanes?: number; defaultLayout?: string; linkRouting?: string }
  getNewTabUrl?: (context: { incognito: boolean; containerProfileId: string | null; profileId: string }) => string
  onLastTabClose?: (context: { tabId: string; url: string; newTabUrl: string }) => boolean
  tabIdPrefix?: string
  defaultIncognito?: boolean
}

function layoutHostOf(manager: TabManager): tabLayout.TabLayoutHost { return manager as unknown as tabLayout.TabLayoutHost }
function lifecycleHostOf(manager: TabManager): tabLifecycle.TabLifecycleHost { return manager as unknown as tabLifecycle.TabLifecycleHost }
function eventsHostOf(manager: TabManager): TabEventsHost { return manager as unknown as TabEventsHost }
function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

class TabManager extends EventEmitter {
  private readonly _wcm: TabWcmPort
  private readonly _layout: TabLayoutPort
  private readonly _tabRules: TabRulePort
  private readonly _tabAdjust: TabAdjustPort | null
  private readonly _tabStacks: GenericPort | null
  private readonly _tabSplits: GenericPort | null
  private readonly _tabGroups: GenericPort | null
  private readonly _getSplitOptions: (() => { maxPanes?: number; defaultLayout?: string; linkRouting?: string }) | null
  private readonly _context: { getCurrent?: () => { profileId?: string; spaceId?: string }; setCurrent?: (identity: { profileId: string; spaceId: string }) => void }
  private readonly _nextTabId: () => string
  private readonly _defaultIncognito: boolean
  private readonly _makeTabRecord: (overrides?: Partial<TabRecord>) => TabRecord
  private readonly _getNewTabUrl: ((context: { incognito: boolean; containerProfileId: string | null; profileId: string }) => string) | null
  private readonly _onLastTabClose: ((context: { tabId: string; url: string; newTabUrl: string }) => boolean) | null
  private readonly _emit: (event: string, payload: unknown) => void
  private readonly _tabs: Map<string, TabRecord>
  private readonly _stacks: Map<string, Record<string, unknown>>
  private readonly _splits: Map<string, Record<string, unknown>>
  private _splitUndoStack: Array<{ members: string[]; layout?: string; ratios: number[]; dissolvedAt: number }>
  private readonly _glances: Map<string, Record<string, unknown>>
  private readonly _autoRefresh: TabAutoRefreshController
  private readonly _boundTabIds: Set<string>
  private readonly _wcToTabId: Map<WebContents, string>
  private readonly _spaceActive: Map<string, string>
  private readonly _hooks: TabManagerHooks
  private _closedTabStack: ClosedTabEntry[]
  private readonly _onFaviconUpdated: ((url: string, favicon: string) => void) | null
  private readonly _onTitleUpdated: ((payload: Record<string, unknown>) => void) | null
  private readonly _onNavigate: ((payload: Record<string, unknown>) => void) | null
  private readonly _onTabWillHide: ((tabId: string, webContents: WebContents) => void) | null
  private readonly _onTabHidden: ((tabId: string, webContents: WebContents) => void) | null
  private readonly _onTabShown: ((tabId: string, webContents: WebContents) => void) | null
  private readonly _pdfViewerEnabled: () => boolean
  private readonly _changeEmitter: TabChangeEmitter
  private _incognitoPartitionId: string | null = null
  /**
   * @param {object} deps
   * @param {object} deps.webContentsManager
   * @param {object} deps.layoutCoordinator
   * @param {Function} [deps.emit]
   * @param {object} [deps.hooks]
   * @param {object} deps.tabRules 标签领域规则端口（依赖倒置，必填）
   * @param {object} [deps.tabAdjust] 标签「调整视图」组合方法端口（可选）
   *
   * `tabRules` 由 APPS 层注入 `@hira-ng/domain-tabs` 的实现。
   * infra 层受分层规则 R1 约束**不能 require domain**，所以这里只声明"我需要什么能力"：
   *   sleepCandidates / othersToClose / rightToClose / undoInsertIndex / reorderIds
   * 全部是纯函数，本类拿到的只是"名单/顺序"，副作用仍由本类执行。
   *
   * `tabAdjust` 同构：tabStats / partitionTabs / focusOrderIds / cleanActive / visibleAfter。
   * 它是**可选**端口（不注入时本类回退到本地遍历计算），避免破坏 verify-tab-nav 等
   * 仅注入 `tabRules` 的既有调用。
   */
  constructor(options: Partial<TabManagerOptions> = {}) {
    const {
      webContentsManager, layoutCoordinator, emit, hooks, tabRules, tabAdjust, tabStacks,
      tabSplits, tabGroups, context, getPdfViewerEnabled, getSplitOptions, getNewTabUrl,
      onLastTabClose, tabIdPrefix, defaultIncognito
    } = options
    super()
    if (!tabRules
      || typeof tabRules.sleepCandidates !== 'function'
      || typeof tabRules.reorderIds !== 'function'
      || typeof tabRules.othersToClose !== 'function'
      || typeof tabRules.rightToClose !== 'function'
      || typeof tabRules.undoInsertIndex !== 'function') {
      throw new Error('TabManager: tabRules 端口必填（注入 @hira-ng/domain-tabs 的 tabRules）')
    }
    this._wcm = webContentsManager as TabWcmPort
    this._layout = layoutCoordinator as TabLayoutPort
    this._tabRules = tabRules as TabRulePort
    this._tabAdjust = tabAdjust || null
    this._tabStacks = tabStacks || null
    /**
     * 分屏组规则端口（`@hira-ng/domain-tabs` 的 `tabSplits`，由 APPS 注入）。
     * 与 `tabStacks` 一样是可选端口 —— 但**分屏操作在没有它时会明确抛错**（不做静默降级），
     * 因为"点了没反应"比"报错"难排查得多。
     */
    this._tabSplits = tabSplits || null
    /**
     * 速览组规则端口（`@hira-ng/domain-tabs` 的 `tabGroups`，由 APPS 注入）。
     * 与 `tabSplits` 一样是可选端口 —— 但**速览操作在没有它时会明确抛错**（不做静默降级）。
     */
    this._tabGroups = tabGroups || null
    /**
     * 分屏选项端口（`{ maxPanes, defaultLayout }`，APPS 注入、**现读**）。
     *
     * 现读而不是构造期快照：改设置后下一次建组 / 加入即生效，且**不改动已建好的组**
     * —— 设置项不该把用户正看着的分屏当场重排。未注入时回落硬上限与 'row'。
     * @type {(() => { maxPanes?: number, defaultLayout?: string })|null}
     */
    this._getSplitOptions = typeof getSplitOptions === 'function' ? getSplitOptions : null
    this._context = context || { getCurrent: () => ({ profileId: 'default', spaceId: 'default' }) }
    // 稳定自增 id（t1/t2/… base36）替代 randomUUID：对齐 RT 的稳定标签 id，
    // 便于持久化恢复、日志排查与「按序还原」；同时让记录字段构造彻底出圈到 tabRecord.js。
    //
    // 多窗口：每个窗口一个**全局唯一**前缀（见 browser-window-assembly 的 ordinal）。
    // 标签 id 是「窗口内」的寻址单位，但快照仓库 / 监听登记等**进程级**表也以它为键，
    // 若两个窗口都从 t1 开始就会互相覆盖（B 窗口的缩略图盖掉 A 窗口的）。
    this._nextTabId = createTabIdGenerator({ prefix: tabIdPrefix || 't' })
    // 无痕窗口：本窗口所有标签默认无痕（对齐 Chrome 无痕窗口语义）。
    this._defaultIncognito = Boolean(defaultIncognito)
    this._makeTabRecord = createTabRecordFactory({
      nextId: this._nextTabId,
      getIdentity: () => (typeof this._context.getCurrent === 'function' ? this._context.getCurrent() : {})
    })
    /**
     * 「关闭最后一个标签时替换成的地址」解析端口（APPS 层注入）。
     *
     * 为什么做成**注入的端口**而不是调用参数：本方法有多个入口 —— `tab:close` IPC、
     * Ctrl+W 快捷键、菜单动作、扩展 API —— 逐次传参会有一条漏传就静默退化成
     * `about:blank`（真实事故）。地址是**设置策略**（app.home_mode + app.home_url），
     * 不该由每个调用方各自算一遍；下沉到端口后所有入口天然一致。
     * 未注入时退回 `about:blank`，与既有行为兼容。
     */
    this._getNewTabUrl = typeof getNewTabUrl === 'function' ? getNewTabUrl : null
    /**
     * 「关闭最后一个标签」时的**接管端口**（APPS 层注入，可选）。
     *
     * 语义：传入 `{ tabId, url, newTabUrl }` 返回 `true` 表示调用方已经接管这次关闭
     * （典型实现：确认「这一个标签就是新标签页」后关窗/退出），TabManager 便不再
     * 把标签就地改成新标签页。返回假值 → 维持既有「补建新标签页」行为。
     *
     * 为什么判定不在 infra 做：`hira://` 地址归一化（末尾斜杠）、`about:blank` 算不算
     * 新标签页、以及「关窗还是退出应用」全是策略，且只有 APPS 认识窗口生命周期。
     * infra 只负责在**唯一**的最后一个标签分支里把两个地址交出去 —— 于是 IPC / 快捷键 /
     * 菜单 / 扩展这些入口天然一致，不必逐处接线。
     * @type {((ctx:{ tabId:string, url:string, newTabUrl:string }) => boolean)|null}
     */
    this._onLastTabClose = typeof onLastTabClose === 'function' ? onLastTabClose : null
    const externalEmit = typeof emit === 'function' ? emit : () => {}
    // 同时通知外部 emit 回调和 EventEmitter 订阅者
    this._emit = (event, payload) => {
      externalEmit(event, payload)
      this.emit(event, payload)
    }
    this._tabs = new Map()
    this._stacks = new Map()
    /**
     * 分屏组表（与 `_stacks` **正交**：栈是收纳、分屏是并列 —— 见 domain-tabs#TabSplits）。
     * 归属写在 `tab.splitId` 上，本表只存组的元数据（layout / ratios / members / activeTabId）。
     */
    this._splits = new Map()
    /**
     * 「最近解散的分屏」撤销栈（I3）：`{ members, layout, ratios, dissolvedAt }[]`。
     *
     * 只在**显式解散**时记录（那一刻成员都还在，才谈得上复原）；因关闭标签而退化解散的
     * 组不记 —— 那条路径上有成员已经消失，记下来只会得到一条永远复原不了的记录。
     * @type {Array<{members:string[], layout:string, ratios:number[], dissolvedAt:number}>}
     */
    this._splitUndoStack = []
    /**
     * 速览组表（A1；与 `_stacks` / `_splits` **正交**：速览是叠放 —— 见 domain-tabs#TabGroups）。
     * 归属写在 `tab.glanceId` 上，本表只存组的元数据（members:[back,front] / frontTabId）。
     * 成员恒为 2 张（前台大卡 + 背景卡），少一张即整组解散。
     */
    this._glances = new Map()
    /**
     * 周期性自动刷新（C7）：tabId → `{ intervalMs, timer }`。
     * 计时器随标签生命周期（关闭即停，见 close 的清理），故与 `_glances` 同处实例状态。
     */
    this._autoRefresh = new TabAutoRefreshController({
      getTab: (tabId) => this._tabs.get(String(tabId)),
      getWebContents: (tabId) => this.getWebContents(tabId),
      onChanged: () => this._scheduleEmitChanged()
    })
    // 反向注入 tab 身份端口：TabManager 是 tab 记录的 owner，WebContentsManager 在
    // createTab(id) 无参调用时回头索取 profileId/incognito，从而彻底解耦会话与视图。
    if (this._wcm && typeof this._wcm.setTabProfileResolver === 'function') {
      this._wcm.setTabProfileResolver((tabId) => {
        const t = this._tabs.get(String(tabId))
        if (!t) return null
        return {
          // 容器标签（N10）：**身份**优先于**归属**。有 containerProfileId 就用它的 Session
          //（cookie/存储走那个 profile），标签仍留在当前空间的列表里。
          // 会话身份只有这一处判定 —— 创建视图与"休眠后重建"两条路都走它，天然一致。
          profileId: t.containerProfileId || t.profileId,
          incognito: t.incognito,
          incognitoPartitionId: t.incognitoPartitionId
        }
      })
    }
    this._boundTabIds = new Set()
    /** webContents → tabId 映射，O(1) 查找 */
    this._wcToTabId = new Map()
    this._spaceActive = new Map()
    // C16: 已关闭标签页的撤销栈 —— Ctrl+Shift+T 还原 *与* 「已关闭的标签页」列表共用同一份记录。
    //
    // 跨启动持久化由 APPS 注入的可选钩子负责（`loadClosedTabs` 播种 /
    // `onClosedStackChanged` 镜像）；不传这两个钩子时行为与改造前完全一致
    // （快照单元、单测、脚本就是这种用法）。infra 不认识"存哪"，这是分层红线。
    this._hooks = hooks || {}
    /** @type {Array<{tabId:string, url:string, title:string, favicon:string, pinned:boolean, stackId:string|null, index:number, closedAt:number, launchAt?:number}>} */
    this._closedTabStack = this._loadClosedTabStack()
    // favicon 同步回调：page-favicon-updated 时调用，缓存到 DB 并同步给书签/历史
    // 由 main.js 注入 faviconService.cacheAndSync
    this._onFaviconUpdated = hooks?.onFaviconUpdated || null
    // 标题同步回调：page-title-updated 时调用（payload 带 tabId），把真实页面标题交给
    // apps 层的历史记录器 / 标签展示。与 onFaviconUpdated 同构：标题只有 webContents 知道。
    this._onTitleUpdated = hooks?.onTitleUpdated || null
    /**
     * 导航已提交（`did-navigate` / `did-navigate-in-page` 主框架）。
     * **只报告事实**：是否写历史、何时写、标题怎么兜底，全部由 apps 层的记录器决定。
     * `typed: true` 只由「地址栏手动提交」这条路径传下来（typedCount 的语义）。
     * @type {((payload: { tabId:string, url:string, title?:string, favicon?:string, typed?:boolean }) => void) | null}
     */
    this._onNavigate = hooks?.onNavigate || null
    /**
     * 「该采帧了」信号（对齐 RT tab-sync 的 placeholder 采集时机约束）。
     * **必须在 view 仍挂载、页面仍渲染时调用** —— detach 之后 capturePage 返回空图。
     * TabManager 掌握「何时会隐藏」，采集/编码/淘汰策略由注入方掌握，二者互不依赖。
     * @type {((tabId: string, wc: Electron.WebContents) => void) | null}
     */
    this._onTabWillHide = hooks?.onTabWillHide || null
    /**
     * 标签**可见性变化**（对齐 RT tab-layout「PiP enter/exit on visibility transitions」）：
     *   onTabHidden —— 标签刚被切走（view 仍存活）→ 消费方（自动画中画）可在此进 PiP；
     *   onTabShown  —— 标签刚变为可见 → 消费方退出 PiP。
     *
     * 为什么必须与 onTabWillHide（采帧）拆成两个信号：
     *   采帧只在「销毁 / 隐藏之前」有意义（之后 capturePage 是空图）；而可见性是**状态本身**，
     *   必须覆盖「关闭活动标签 → 接替标签变可见」这条**不经过 switchTo** 的路径 ——
     *   否则接替标签会在可见状态下继续挂着系统 PiP 小窗。
     * @type {((tabId: string, wc: Electron.WebContents) => void) | null}
     */
    this._onTabHidden = hooks?.onTabHidden || null
    /** @type {((tabId: string, wc: Electron.WebContents) => void) | null} */
    this._onTabShown = hooks?.onTabShown || null
    /**
     * PDF 内置查看器开关（设置项 `pdf.viewer_enabled`）。
     * 关闭时 .pdf 不再包装成 `hira://pdf`，导航原样交给 Chromium 的下载/内联链路。
     *
     * 以**端口注入**而非直接读 settings：infra 不认识 settings 领域（分层约束）。
     * 每次判定都现读，因此改设置后下一次打开 PDF 即生效，无需重启。
     * @type {() => boolean}
     */
    this._pdfViewerEnabled = typeof getPdfViewerEnabled === 'function' ? getPdfViewerEnabled : () => true
    // 一帧合批、立即派发与批量折叠的状态全部下沉到独立派发器。
    this._changeEmitter = new TabChangeEmitter(this as unknown as TabChangeHost)
    installTabGroupController(this as unknown as TabGroupHost)
  }

  /**
   * 排好序的 `[tabId, record]` 数组 —— 标签顺序的**读侧唯一入口**。
   *
   * 排序键 = **固定优先**，其次 `position`。
   *   · 固定优先是「固定 = 常驻」的落地点：置顶不靠写 position（那样每次固定/取消固定都要
   *     整体重排一遍，还会跟拖拽/插入的 +0.5 语义打架），而是排序时把固定标签稳定地分到
   *     前一段。取消固定后它自然回到原 position 所在的相对次序 —— 信息零丢失、零迁移。
   *   · 因为这是**读侧唯一入口**，标签条显示、Ctrl+Tab 顺序、关闭邻居、tabRules 的
   *     「关闭其他/右侧」、分屏合拢全部自动一致，不需要各自记得"固定要排前面"。
   * 对齐 RT `getTabsInSpace().sort(...)`：顺序来自记录上的数值字段，不依赖 Map 插入顺序，
   * 因此写侧永远不必重建 Map。n 为标签数（几十级），sort 开销可忽略。
   * @returns {Array<[string, object]>}
   */
  _orderedEntries() : Array<[string, TabRecord]> {
    const entries = Array.from(this._tabs.entries())
    entries.sort((a, b) => {
      const pa = a[1].pinned ? 0 : 1
      const pb = b[1].pinned ? 0 : 1
      if (pa !== pb) return pa - pb
      return (Number(a[1].position) || 0) - (Number(b[1].position) || 0)
    })
    return entries
  }

  /**
   * 归一化 position 为每个空间内的 0..n-1（对齐 RT `normalizePositions`），
   * 防止「反复在相邻标签间插入 +0.5」导致 position 漂移/精度退化。
   * 仅在新建（插到活动标签后）等低频路径调用，不在热路径上。
   */
  normalizePositions() {
    const bySpace = new Map<string, TabRecord[]>()
    for (const t of this._tabs.values()) {
      const key = `${t.profileId}:${t.spaceId}`
      let bucket = bySpace.get(key)
      if (!bucket) {
        bucket = []
        bySpace.set(key, bucket)
      }
      bucket.push(t)
    }
    for (const bucket of bySpace.values()) {
      bucket.sort((a, b) => (Number(a.position) || 0) - (Number(b.position) || 0))
      for (let i = 0; i < bucket.length; i++) bucket[i].position = i
    }
  }

  /**
   * 某**空间内**的有序标签项 —— `_orderedEntries()` 的空间投影。
   *
   * 为什么必须存在：`_orderedEntries()` 是**全局**表，而各空间的 position 是各自归一化的
   * （见 `normalizePositions` 按 `profile:space` 分桶），全局排序会把不同空间的标签交错在一起。
   * 标签条的语义边界是**空间**（`list()` → `listBySpace`），因此「是否最后一个标签」
   * 「关闭后的接替邻居」这类判定只能在本空间内做。旧实现用全局判据，多空间下会串味：
   * 关掉本空间最后一个标签时判据为假 → 记录被删、空间变空（标签栏空白），
   * 而接替者可能落在别的空间 → 布局层把别的空间页面显示出来（"视图还诡异加载着"）。
   *
   * @param {string} profileId
   * @param {string} spaceId
   * @returns {Array<[string, object]>}
   */
    _orderedEntriesInSpace(profileId?: string, spaceId?: string) : Array<[string, TabRecord]> {
    const profile = String(profileId || '')
    const space = String(spaceId || '')
    return this._orderedEntries().filter(([, t]) =>
      String(t.profileId || '') === profile && String(t.spaceId || '') === space
    )
  }

  /** 某空间内第 index 个标签（支持负索引），返回 tabId 或 null。 */
    _getTabIdInSpace(profileId: string, spaceId: string, index: number) {
    const entries = this._orderedEntriesInSpace(profileId, spaceId)
    if (index < 0 || index >= entries.length) return null
    return entries[index][0]
  }

  /** 当前空间的标签 id（按 position 有序）—— Ctrl+Tab 等"在本标签条内走位"的入口共用。 */
  _currentSpaceTabIds() {
    const cur = typeof this._context.getCurrent === 'function' ? this._context.getCurrent() : null
    if (!cur) return this._orderedEntries().map(([id]) => id)
    return this._orderedEntriesInSpace(cur.profileId, cur.spaceId).map(([id]) => id)
  }

  /**
   * 交给 `tabRules` 的只读快照：`{tabId, ...state}` 数组（**按 position 有序**）。
   * 刻意不把内部 Map 暴露出去 —— domain 层不认识 Map，也不该认识。
   *
   * @param {{ profileId?: string, spaceId?: string }} [scope]
   *   传入 `profileId + spaceId` 时只取该空间的标签（**按 position 有序**）。
   *   空间过滤必须由**调用方显式声明**：休眠候选等跨空间规则要全局表，
   *   而「关其他 / 关右侧」这类**标签条语义**的规则只能在同空间内做 ——
   *   各空间 position 各自归一化，全局排序会把别的空间交错进来。
   * @returns {Array<TabRecord & { tabId: string }>}
   */
    _ruleInput(scope: { profileId?: string; spaceId?: string } | null = null): Array<TabRecord & { tabId: string }> {
    const out: Array<TabRecord & { tabId: string }> = []
    if (scope && scope.profileId !== undefined && scope.spaceId !== undefined) {
      for (const [tabId, t] of this._orderedEntriesInSpace(scope.profileId, scope.spaceId)) {
        out.push({ ...t, tabId })
      }
    } else {
      for (const [tabId, t] of this._orderedEntries()) out.push({ ...t, tabId })
    }
    return out
  }

    listBySpace(profileId: string, spaceId: string) {
    const profile = String(profileId || '')
    const space = String(spaceId || '')
    const active = this._layout.getActiveTabId()
    const out = []
    // 单次遍历 + space 过滤，顺序按 position（对齐 RT），避免依赖 Map 插入顺序
    for (const [tabId, t] of this._orderedEntries()) {
      if (String(t.profileId || '') !== profile || String(t.spaceId || '') !== space) continue
      out.push(this._projectTab(tabId, t, active))
    }
    return this._markSplitLinks(out)
  }

  listAll() {
    const active = this._layout.getActiveTabId()
    const out = []
    // 直接遍历 position 有序数组，不依赖 Map 插入顺序
    for (const [tabId, t] of this._orderedEntries()) out.push(this._projectTab(tabId, t, active))
    return this._markSplitLinks(out)
  }

  /**
   * 标记「这一条之后紧跟着同一分屏组的另一名成员」—— 标签条 / 侧栏列表在这一对之间画**回形针**。
   *
   * 为什么在主进程算：成员相邻是**顺序的不变式**（见 `tabLayout#enforceSplitRuns`），
   * 而顺序只有这里权威。两个渲染器于是只读一个布尔字段，不必各写一遍
   * "下一个是不是同组" —— 那种写法在两个渲染进程里必然漂移（本项目已有多次先例）。
   *
   * @param {Array<object>} items 有序投影（原地写入，返回同一个数组）
   */
    _markSplitLinks<T extends Record<string, unknown> & { splitLinkAfter?: boolean }>(items: T[]): T[] {
    for (let i = 0; i < items.length; i++) {
      const cur = items[i]
      const next = items[i + 1]
      cur.splitLinkAfter = !!(
        cur && cur.splitId != null &&
        next && next.splitId != null &&
        String(next.splitId) === String(cur.splitId)
      )
    }
    return items
  }

  /**
   * 将内部 tab 状态投影为对外的精简对象（只含 renderer / 会话保存需要的字段）。
   * 避免 `...t` 展开整个内部对象（含 _errorPageSwitched 等内部字段）。
   */
    _projectTab(tabId: string, t: TabRecord, active: string | null) {
    const isActive = tabId === active
    // 活动标签的「活体状态」（可否后退/前进 + 是否在加载）在这里现问原生 ——
    // 只算活动标签：这些是原生同步调用，逐个标签算会在每次 tab:changed 里放大成
    // N 次原生查询（几十个标签时是实打实的帧开销），而非活动标签也没有消费方
    // （进度条与导航按钮都只反映当前页；标签行的 spinner 用下面那个 t.loading）。
    const live = isActive ? this._liveStateOf(tabId, t) : null
    return {
      tabId,
      profileId: t.profileId || 'default',
      spaceId: t.spaceId || 'default',
      url: t.url,
      title: t.title,
      pinned: !!t.pinned,
      muted: !!t.muted,
      isPlaying: !!t.audioPlaying,
      sleeping: !!t.sleeping,
      incognito: !!t.incognito,
      // 容器标签（N10）：**身份 profile**。有值 = 这个标签的 cookie / 存储走**另一个
      // profile 的 Session**；而上面的 profileId / spaceId 仍是**归属**（标签照常出现在
      // 当前空间、当前列表里）。两者分离正是"不切空间也能用另一个身份"的全部秘密。
      containerProfileId: t.containerProfileId || null,
      active: isActive,
      // 最近激活时刻（`tabLifecycle` 每次激活刷新，供标签休眠策略使用）。
      // 这里只是把它透出到投影 —— 不新增字段、不新增存储。
      lastActivated: Number(t.lastActivated) || 0,
      // 标签条顺序的**数值真源**（与内部记录同源）。会话落盘链路是
      // listForPersist → SessionStore#applyTabUserState，它按 position 读取；
      // 不投影出去 = v4 声明的 position 永远写不进盘。
      position: Number(t.position) || 0,
      favicon: t.favicon || '',
      stackId: t.stackId || null,
      // 分屏组归属（与 stackId 正交）。渲染层据此判断"这条标签在分屏里"，
      // 而"交界处画回形针"用下面那个派生字段 splitLinkAfter（见 _markSplitLinks）；
      // 组元数据（layout/成员/比例）由 `split:changed` 单独推 —— 见 LayoutCoordinator。
      splitId: t.splitId || null,
      // 速览组归属（与 stackId / splitId 三者正交）。`glanceFront` 是派生布尔：
      // 这一张是不是叠在最上面的**前台大卡**（渲染层据此给缩略图打"前台"标记）。
      // 两个字段都随 `tab:changed` 一起推 —— 速览没有独立的几何通道（卡片框由尺寸差体现，
      // 外壳在 webviews 之下画不出压在网页上的框，见 glance-layout.mjs 的说明）。
      glanceId: t.glanceId || null,
      glanceFront: !!(
        t.glanceId && (() => {
          const g = this._glances.get(String(t.glanceId))
          return g && String(g.frontTabId) === String(tabId)
        })()
      ),
      // 活动标签的加载态取**原生动词** wc.isLoading()（见 _liveStateOf）；
      // 非活动标签沿用记录字段（它们是事件书写的，但对非活动标签没有关键消费方）。
      loading: live ? live.loading : !!t.loading,
      // 周期性自动刷新（C7）：0 = 未开启。渲染层据此在菜单里显示"当前档位"。
      autoRefreshMs: this._autoRefresh.intervalOf(tabId),
      // 显式给默认值（不省略字段）：消费方（导航按钮）据此判断置灰，
      // 缺字段与 false 是两回事 —— 前者会让调用方各自写一套兜底。
      canGoBack: live ? live.canGoBack : false,
      canGoForward: live ? live.canGoForward : false
    }
  }

  /**
   * 某标签的「活体状态」`{ canGoBack, canGoForward, loading }` —— 查询前进/后退能力与
   * 加载态的**唯一实现**，三个值都直接来自原生。
   *
   * ⚠ **本方法在任何情况下都不允许抛**。它是 `_projectTab` 的一部分，而 `_projectTab`
   * 被 `list()/listProjection()` 逐个标签调用 —— 只要有一个标签让它抛出去，
   * **整条 `tab:changed` 就发不出去**（`_emitTabChanged` 在同一个调用栈里），
   * 表现是「地址栏不再更新 + 前进后退状态卡死」这类整体失灵，而不是少一颗按钮。
   * 而它现在要碰的 webContents 可能是**正在关闭/已被销毁**的（关闭标签的那一拍里
   * `_tabViews` 与 `_tabs` 未必同步），对已销毁对象取属性/调方法在 Electron 里是抛错。
   * 因此：先判 `isDestroyed`，再整体 try/catch，任何异常一律回落"否"。
   *
   * 两条硬约束（都因为它是 `tab:changed` 的热路径）：
   *   1. **绝不创建视图**：用 `getTab`（只读）而不是 `createTab` —— 后者对缺失的标签会
   *      真造一个 WebContentsView（拉起渲染进程）。在每次投影里做这件事是灾难。
   *      没有活视图 = 没在加载、也没有可遍历的历史，返回 false 是正确语义，不是兜底。
   *   2. **休眠标签不唤醒**：历史直接问 preSleep 快照（对齐 RT）；
   *      加载态恒为 false —— 没有 webContents 就不可能还在加载。
   * @param {string} tabId
   * @param {object} [t] 该标签的内部记录（省一次 Map 查询）
   * @returns {{ canGoBack: boolean, canGoForward: boolean, loading: boolean }}
   */
    _liveStateOf(tabId: string, t?: TabRecord): { canGoBack: boolean; canGoForward: boolean; loading: boolean } {
    const record = t || this._tabs.get(tabId)
    if (this._wcm.isTabSleeping(tabId)) {
      return {
        canGoBack: canGoBackFromPreSleep(record?.preSleep),
        canGoForward: canGoForwardFromPreSleep(record?.preSleep),
        loading: false
      }
    }
    const view = this._wcm.getTab(tabId)
    const wc = view && view.webContents
    if (!wc || (typeof wc.isDestroyed === 'function' && wc.isDestroyed())) {
      return { canGoBack: false, canGoForward: false, loading: false }
    }
    return readWebNavigationState(wc)
  }

    setCurrentSpace(profileId: string, spaceId: string) {
    const next = { profileId: String(profileId || 'default'), spaceId: String(spaceId || 'default') }
    // 捕获切换前的空间：切走后休眠该空间所有标签的 webContents，释放内存。
    // 对齐 RT：非活动标签休眠销毁 WebContentsView，每个节省 ~20-50MB。
    // 旧实现保留所有空间的 webContents 常驻，多空间场景下内存无上限增长、GC 压力大。
    const prev = typeof this._context.getCurrent === 'function' ? this._context.getCurrent() : null
    if (typeof this._context.setCurrent === 'function') this._context.setCurrent(next)
    const current = typeof this._context.getCurrent === 'function' ? this._context.getCurrent() : next
    // 同一格空间重入（启动装配 / 重复应用同一目标）：**绝不能**走下面的休眠整段 ——
    // 那会把本空间所有标签的渲染进程白白销毁一遍，用户下一次点标签又要逐个重建。
    const sameSpace = !!prev
      && String(prev.profileId || 'default') === String(current.profileId || 'default')
      && String(prev.spaceId || 'default') === String(current.spaceId || 'default')
    const key = `${String(current.profileId || 'default')}:${String(current.spaceId || 'default')}`
    const remembered = this._spaceActive.get(key)
    const visible = this.listBySpace(String(current.profileId || 'default'), String(current.spaceId || 'default'))
    const target = (remembered && visible.find((tab) => tab.tabId === remembered)) || visible[0]
    if (target) {
      // switchTo 自己会 `_emitNow`（含切换后的空间投影）—— 这里不再补一次合批投影，
      // 否则每次切 space 都白推一遍全量标签列表。
      this.switchTo(target.tabId)
    } else {
      this._layout.hideTab()
      // 空空间没有 switchTo 可借，投影必须自己补。
      this._scheduleEmitChanged()
    }
    // 切换完成后，休眠前一空间的所有非活动标签（释放 webContents 内存）。
    // 活动标签如果也属于前一空间（极端情况）跳过，避免刚切走又睡。
    //
    // ⚠ **延后一拍**：休眠一个标签 = 抓导航快照（每条历史含 base64 pageState）+
    //   抓最后一帧（GPU 回读 + JPEG 编码）+ 销毁 WebContentsView。整段同步压在
    //   点 space 的那一拍上，用户看到的就是"点下去要顿一下、页面白一下"。
    //   这一拍只负责把**新空间推上屏**；旧空间的回收放到事件循环下一轮，
    //   与新视图的创建/首帧错开（内存照样在本拍之后立刻回收）。
    if (prev && !sameSpace) {
      const prevProfile = String(prev.profileId || 'default')
      const prevSpace = String(prev.spaceId || 'default')
      const nextProfile = current.profileId
      const nextSpace = current.spaceId
      setTimeout(() => {
        try {
          // 这一拍里可能又切回去了（程序化连切 / 用户极快连点）：那时 `prev` 正是
          // **此刻可见**的空间，再休眠它会把用户眼前的标签渲染进程全销毁。
          const now = typeof this._context.getCurrent === 'function' ? this._context.getCurrent() : null
          if (now && (String(now.profileId || 'default') !== String(nextProfile)
            || String(now.spaceId || 'default') !== String(nextSpace))) return
          this._sleepSpaceTabs(prevProfile, prevSpace, this.getActiveTabId())
        } catch (e) {
          console.error('[tab] sleep previous space failed:', errorMessage(e))
        }
      }, 0)
    }
    return current
  }

  /**
   * 某个空间**最近一次激活的标签**（不依赖环境的「当前空间」）。
   *
   * 为什么需要它：按空间落盘是异步的（切 space 前的那次保存会延后一拍，markDirty 还有
   * 2s 合批）。那一刻 `getActiveTabId()` 已经指向**新空间**的标签，直接用它会把
   * `activeTabId` 写成别的空间的 id —— 重启后这个空间恢复出的活动页就丢了。
   * @param {string} profileId
   * @param {string} spaceId
   * @returns {string|null}
   */
    getActiveTabIdForSpace(profileId: string, spaceId: string) : string|null {
    const profile = String(profileId || 'default')
    const space = String(spaceId || 'default')
    const current = typeof this._context.getCurrent === 'function' ? this._context.getCurrent() : null
    if (current
      && String(current.profileId || 'default') === profile
      && String(current.spaceId || 'default') === space) {
      return this.getActiveTabId()
    }
    const remembered = this._spaceActive.get(`${profile}:${space}`)
    if (!remembered) return null
    const rec = this._tabs.get(remembered)
    if (!rec) return null
    // 记忆项可能属于别的空间（空间被移动 / 标签被改归属）→ 宁缺勿错。
    if (String(rec.profileId || 'default') !== profile) return null
    if (String(rec.spaceId || 'default') !== space) return null
    return remembered
  }

  /**
   * 休眠指定空间下的所有标签（释放 webContents 内存）。
   * 跳过活动标签和已休眠标签，并按帧逐个执行。
   *
   * `sleepTab()` 会同步读取导航历史（含 base64 pageState）、抓最后一帧并销毁视图。
   * 一次循环睡几十个标签就是一段几十毫秒到数百毫秒的主线程长任务，正好落在用户
   * 刚点完空间的这一拍。这里只收集候选，每个 tick 最多睡一个；每次执行前重新核对
   * 当前空间，用户切回去时立刻停手，绝不会把眼前的标签睡掉。
   *
   * 返回值是「已排入后台休眠的候选」而非同步完成结果 —— 现有调用方不消费它，
   * 保留形状只为兼容旧调试代码。
   *
   * @param {string} profileId
   * @param {string} spaceId
   * @param {string} [skipTabId] 跳过的标签（通常是当前活动标签）
   * @returns {{ slept: string[] }} 已排入后台回收的标签 id
   */
    _sleepSpaceTabs(profileId: string, spaceId: string, skipTabId?: string | null) : { slept: string[] } {
    const profile = String(profileId || '')
    const space = String(spaceId || '')
    const skip = skipTabId ? String(skipTabId) : null
    const candidates: string[] = []
    for (const [tabId, t] of this._tabs) {
      if (String(t.profileId || '') !== profile || String(t.spaceId || '') !== space) continue
      if (skip && tabId === skip) continue
      if (t.sleeping) continue
      if (this._layout.getActiveTabId() === tabId) continue
      candidates.push(tabId)
    }
    if (!candidates.length) return { slept: [] }

    let cursor = 0
    const pump = () => {
      const now = typeof this._context.getCurrent === 'function' ? this._context.getCurrent() : null
      // 用户已经回到这个空间（或窗口已失去归属）→ 停止后台回收。
      if (!now
        || (String(now.profileId || 'default') === profile && String(now.spaceId || 'default') === space)) return

      let id = ''
      while (cursor < candidates.length) {
        const next = candidates[cursor++]
        const rec = this._tabs.get(next)
        if (!rec || rec.sleeping) continue
        if (this._layout.getActiveTabId() === next) continue
        if (this._wcm.isTabSleeping(next)) continue
        id = next
        break
      }
      if (!id) return
      try { this.sleepTab(id) } catch (_) {}
      if (cursor < candidates.length) setTimeout(pump, 16)
    }
    // 再晚半帧启动，让新空间的视图先完成挂载与首帧提交。
    setTimeout(pump, 8)
    return { slept: candidates }
  }

  list() {
    const current = typeof this._context.getCurrent === 'function' ? this._context.getCurrent() : null
    if (!current) return this.listAll()
    return this.listBySpace(String(current.profileId || 'default'), String(current.spaceId || 'default'))
  }

  /**
   * 持久化专用投影：在 `list()` 的精简字段上**额外**带上运行期导航历史。
   *
   * 为什么不直接塞进 `_projectTab`：那份投影每个 tick 经 `tab:changed` IPC
   * 全量推给渲染进程，而 navHistory 每条含 base64 的 `pageState`，
   * 广播出去会让 IPC 体积暴涨 → 正是用户抱怨的卡顿来源。
   * 只有落盘这一条路径需要它，故单独开口（沿用 tabPort 可选端口的既有风格）。
   *
   * ── 导航历史是**懒读取**的（性能契约）──────────────────────────────
   * `t.navHistory` 只在新标签 / 会话恢复时写入，**不再随每次导航刷新**。
   * 原因：`navigationHistory.getAllEntries()` 的每一项都带 base64 `pageState`
   * （滚动位置 / 表单值快照），在 `did-navigate` 那一拍把整条历史连字节拷一遍，
   * 是实打实的"跳转要等一下才动"。真正需要这份数据的只有两个低频路径：
   *   · 休眠前 → `tabPreSleep` 从活的 wc 直接抓；
   *   · 落盘   → 本函数在这里从活的 wc 现读。
   * 休眠标签没有 wc，回退到 `preSleep` 快照（保证休眠期也能正确落盘）。
   *
   * @param {{ allTabs?: boolean, space?: {profileId:string, spaceId:string}|null, profileId?:string }} [opts]
   *   allTabs=true → 取全部空间（profile 级会话落盘）；
   *   space      → 钉死某一格空间（异步落盘 / 合批落盘时不能读环境当前空间，见 port 注释）
   * @returns {Array<object>}
   */
    listForPersist({ allTabs = false, space = null, profileId = '' }: { allTabs?: boolean; space?: { profileId?: string; spaceId?: string } | null; profileId?: string } = {}) : Array<object> {
    const pinnedProfileId = allTabs && profileId ? String(profileId) : ''
    const allBase = allTabs ? this.listAll() : null
    const base = allBase
      ? (pinnedProfileId
          ? allBase.filter((tab) => String((tab as { profileId?: unknown }).profileId || '') === pinnedProfileId)
          : allBase)
      : (space && typeof this.listBySpace === 'function'
        ? this.listBySpace(String(space.profileId || 'default'), String(space.spaceId || 'default'))
        : this.list())
    return base.map((tab) => {
      const rec = this._tabs.get(tab.tabId)
      if (!rec) return tab
      let nav = Array.isArray(rec.navHistory) && rec.navHistory.length > 1 ? rec.navHistory : null
      let idx = rec.navHistoryIndex
      // 活着的标签：**现读**原生历史（低频路径，见上面的懒读取说明）。
      if (!nav && !rec.sleeping) {
        const view = this._wcm && typeof this._wcm.getTab === 'function' ? this._wcm.getTab(tab.tabId) : null
        const wc = view && view.webContents
        if (wc && !(typeof wc.isDestroyed === 'function' && wc.isDestroyed())) {
          try {
            const nh = wc.navigationHistory
            if (nh && typeof nh.getAllEntries === 'function') {
              const entries = nh.getAllEntries() || []
              if (entries.length > 1) {
                nav = entries
                idx = typeof nh.getActiveIndex === 'function' ? nh.getActiveIndex() : entries.length - 1
              }
            }
          } catch (_) {}
        }
      }
      // 休眠标签：回退到休眠前的快照。
      if (!nav && rec.preSleep && Array.isArray(rec.preSleep.navHistory) && rec.preSleep.navHistory.length > 1) {
        nav = rec.preSleep.navHistory
        idx = rec.preSleep.navHistoryIndex
      }
      if (!nav) return tab
      return { ...tab, navHistory: nav, navHistoryIndex: Number(idx) || 0 }
    })
  }

  // ── 标签布局（栈 CRUD / 拖拽重排）全部委托 tabLayout.js（对齐 RT TabLayoutManager）。
  //    本类只保留「宿主契约」——_tabs / _stacks / _ruleInput / _scheduleEmitChanged 等。

  listStacks() {
    return tabLayout.listStacks(layoutHostOf(this))
  }

  /** 全部栈（带 count/children）—— 调用方一次拿全量，避免 N 次查询。 */
  getAllStacks() {
    return tabLayout.getAllStacks(layoutHostOf(this))
  }

  /** 取单个栈（带 count/children）；不存在 → null。 */
    getStack(stackId: string) {
    return tabLayout.getStack(layoutHostOf(this), { stackId })
  }

  /** 某标签所属的栈；不在栈里 → null。 */
    getStackOfTab(tabId: string) {
    return tabLayout.getStackOfTab(layoutHostOf(this), { tabId })
  }

  /** 标签是否归属任一现存栈。 */
    isTabInAnyStack(tabId: string) {
    return tabLayout.isTabInAnyStack(layoutHostOf(this), { tabId })
  }

  listProjection() {
    return tabLayout.listProjection(layoutHostOf(this))
  }

    createStack(opts: TabManagerOptionsUpdate = {}) {
    return tabLayout.createStack(layoutHostOf(this), opts)
  }

    setTabStack(opts: TabManagerOptionsUpdate = {}) {
    return tabLayout.setTabStack(layoutHostOf(this), opts)
  }

    toggleStack(stackId: string) {
    return tabLayout.toggleStack(layoutHostOf(this), stackId)
  }

  /** 用 domain 返回的结果集整体替换内部 Map（供 reorder 等复用）。 */
    _applyStackRule(result: tabLayout.LayoutMutationResult | null | undefined) {
    return tabLayout.applyStackRule(layoutHostOf(this), result)
  }

    renameStack(opts: TabManagerOptionsUpdate = {}) {
    return tabLayout.renameStack(layoutHostOf(this), opts)
  }

    setStackColor(opts: TabManagerOptionsUpdate = {}) {
    return tabLayout.setStackColor(layoutHostOf(this), opts)
  }

  /** 通用字段 patch（label / accent / collapsed）—— 一次改动只通知一次。 */
    updateStack(opts: TabManagerOptionsUpdate = {}) {
    return tabLayout.updateStack(layoutHostOf(this), opts)
  }

    mergeStacks(opts: TabManagerOptionsUpdate = {}) {
    return tabLayout.mergeStacks(layoutHostOf(this), opts)
  }

  /**
   * 解散一个标签组：成员全部回到散标签、组元数据删掉（"全部恢复正常状态"）。
   * 取代了原先菜单上那个语义错位的「拆分标签组」（domain 的 `splitStack` 是"把部分成员
   * 迁到另一个新组"，点了外观一字不变 —— 见 tabLayout#dissolveStack 的说明）。
   */
    dissolveStack(opts: TabManagerOptionsUpdate = {}) {
    return tabLayout.dissolveStack(layoutHostOf(this), opts)
  }

  _removeEmptyStacks() {
    return tabLayout.removeEmptyStacks(layoutHostOf(this))
  }

  // ── 分屏组（Split View）—— 规则在 domain，本类只做委托与「把状态灌给布局层」。
  //    与上面那组标签栈方法**平级并列**，两者共享同一个 `_tabs`，但互不读取对方的字段。

  /** 全部分屏组（脱壳快照）。 */
  /**
   * 整张标签栏的统计：总数 / 固定数 / 播放声音数。
   * 优先委托注入的 `tabAdjust.tabStats`（domain 纯函数）。
   * 关键坑：`tabStats` 只认 `audio || isAudioPlaying`，而本类内部用 `audioPlaying`，
   * 所以喂给它之前先把每个 tab 映射为 `{ tabId, pinned, audio: !!t.audioPlaying }`。
   * 未注入 `tabAdjust` 时回退到本地遍历（语义一致：audio 由 audioPlaying=true 计出）。
   * @returns {{ total: number, pinned: number, audio: number }}
   */
  stats(): { total: number; pinned: number; audio: number } {
    const fallback = () => {
      let total = 0
      let pinned = 0
      let audio = 0
      for (const t of this._tabs.values()) {
        total++
        if (t.pinned) pinned++
        if (t.audioPlaying) audio++
      }
      return { total, pinned, audio }
    }
    if (!this._tabAdjust || typeof this._tabAdjust.tabStats !== 'function') return fallback()
    const adapted = []
    for (const [tabId, t] of this._tabs) {
      adapted.push({ tabId, pinned: !!t.pinned, audio: !!t.audioPlaying })
    }
    return this._tabAdjust.tabStats(adapted)
  }

  /**
   * 活动标签**之后**、且非固定 的 tabId 数组（保持原顺序，不含活动本身）。
   * 委托注入的 `tabAdjust.visibleAfter`；未注入时返回空数组。
   * @param {string} id
   * @returns {string[]}
   */
    visibleAfter(id: string): string[] {
    if (!this._tabAdjust || typeof this._tabAdjust.visibleAfter !== 'function') return []
    return this._tabAdjust.visibleAfter(this._ruleInput(), id)
  }

  getActiveTabId() {
    return this._layout.getActiveTabId()
  }

  /**
   * 获取指定 tab 的 webContents（只读，不创建视图，不唤醒休眠标签）。
   * 休眠标签返回 null —— 调用方需自行决定是否唤醒。
   */
    getWebContents(tabId: string) {
    const id = String(tabId)
    if (!this._tabs.has(id)) return null
    try {
      const view = this._wcm.getTab(id)
      return view && view.webContents ? view.webContents : null
    } catch {
      return null
    }
  }

  /**
   * 获取活动 tab 的 webContents（公共 API）。
   * @returns {Electron.WebContents|null}
   */
  getActiveWebContents() : Electron.WebContents|null {
    const id = this.getActiveTabId()
    if (!id) return null
    return this.getWebContents(id)
  }

  /**
   * 该标签是否无痕。
   * 供「无痕标签不能进扩展系统」这类判断使用：ECE 绑定的是 profile 的持久会话，
   * 而无痕标签跑在独立的内存 partition 上（注册时会直接抛 session mismatch）。
   */
    isIncognitoTab(tabId: string) {
    const t = this._tabs.get(String(tabId))
    return Boolean(t && t.incognito)
  }

  /**
   * 通过 webContents 查找 tabId（ECE 回调传入 webContents 而非 tabId）
   * 对齐 Hira getTabIDFromWebContents
   * 使用 _wcToTabId 映射实现 O(1) 查找
   */
    getTabIdByWebContents(wc: WebContents) {
    if (!wc) return null
    return this._wcToTabId.get(wc) || null
  }

  /**
   * 按标签**当前地址**同步它的视图画布色（网页还没画出底色时露出的那一层）。
   *
   * 唯一的判据在宿主注入的 `_hooks.tabCanvasColor`：APPS 层知道哪些地址是内置
   * 新标签页（壁纸由窗口外壳**唯一**绘制，所以它的画布必须透明），infra 不认识
   * `hira://` 语义，只负责把「当前 URL」换成一次 `setBackgroundColor`。
   *
   * 所有会新建 / 重建视图的路径都归一到这里（见 `tabEvents#bindTabEvents`），
   * 页面之间跳转则由 `did-navigate` 用刚提交的地址再纠正一次 —— 画布必须
   * 跟着地址翻面，否则要么普通网页被掏空成透明、要么新标签页糊上一块白。
   *
   * @param {string} tabId
   * @param {string} [urlOverride] 已知的最新地址（缺省取 tab 记录里的地址）
   */
    syncTabCanvas(tabId: string, urlOverride?: string) {
    const id = String(tabId)
    const wcm = this._wcm
    if (!wcm || typeof wcm.getTab !== 'function' || typeof wcm.setTabCanvas !== 'function') return
    const view = wcm.getTab(id)
    if (!view) return
    const tab = this._tabs.get(id)
    const url = urlOverride != null ? String(urlOverride) : String((tab && tab.url) || '')
    let color = ''
    const pick = this._hooks && this._hooks.tabCanvasColor
    if (typeof pick === 'function') {
      try {
        color = pick({ url, incognito: !!(tab && tab.incognito) }) || ''
      } catch (e) {
        // 端口异常退回默认白纸：画布色只是观感，绝不能让它挡住标签创建
        color = ''
      }
    }
    wcm.setTabCanvas(view, color)
  }

  /**
   * 该地址是否应该走内置 PDF 查看器。
   *
   * 两个条件都满足才走：① 确实是 PDF；② 设置里没有关闭内置查看器。
   * 关闭时调用方原样导航 —— 于是 `.pdf` 落到 Chromium 的下载链路，
   * 这正是「内置查看器不可用时改用系统方式打开」的预期行为。
   * @param {string} url 已归一化的地址
   * @returns {boolean}
   */
    _shouldUsePdfViewer(url: string) : boolean {
    if (!isPdfUrl(url)) return false
    try {
      return this._pdfViewerEnabled() !== false
    } catch (_) {
      // 端口异常时保守走内置查看器（与默认值一致），不让设置故障变成功能缺失
      return true
    }
  }

  /**
   * 地址在落进 WebContents 之前的**最后一道解析**（可选 hook：`_hooks.onResolveTabUrl`）。
   *
   * 存在的原因：`hira://newtab` 只是「内置新标签页」的地址，而 Chrome 语义下
   * 声明了 `chrome_url_overrides.newtab` 的扩展会把新标签页替换成自己的页面。
   * 扩展页**不能**靠 hira:// 协议 302 过去（Chromium 会把扩展 id 当域名解析，
   * ERR_NAME_NOT_RESOLVED），只能由浏览器主动 loadURL —— 所以替换点必须在
   * 「即将 loadURL」这里，而不是协议层。
   *
   * 覆盖规则与扩展系统/profile 语义全在 APPS 层（hook 注入方）：
   *   · 非无痕窗口 → 返回扩展页地址；无痕 / 容器标签 / 没有覆盖 → 返回空串 = 不改。
   * infra 只负责把「这个标签最终会跑在哪个会话」的事实（incognito / containerProfileId）
   * 一并交出去，自身不认识扩展。
   *
   * 所有「新建标签 / 导航 / 会话恢复 / 撤销关闭」都经过本方法，因此不存在漏网的
   * `hira://newtab` —— 这正是不能用"逐处接线"的原因。
   *
   * @param {string} url 已归一化的地址
   * @param {{ incognito?: boolean, containerProfileId?: string|null }} [ctx]
   * @returns {string} 实际应加载的地址；hook 缺席 / 抛错 / 返回空串时原样返回
   */
    _resolveTabUrl(url: string, { incognito, containerProfileId }: { incognito?: boolean; containerProfileId?: string | null } = {}) : string {
    const hook = this._hooks && this._hooks.onResolveTabUrl
    if (typeof hook !== 'function') return url
    try {
      let profileId = 'default'
      try { profileId = String(this._context.getCurrent?.()?.profileId || 'default') } catch (_) {}
      const resolved = hook({
        url,
        // 无痕窗口里**每个**标签都是无痕（见 newTab 的 _defaultIncognito 分支）
        incognito: Boolean(incognito) || this._defaultIncognito,
        containerProfileId: containerProfileId ? String(containerProfileId) : null,
        profileId
      })
      return typeof resolved === 'string' && resolved ? resolved : url
    } catch (_) {
      // 解析端口故障不该把标签建不出来：退回设置解析出的地址
      return url
    }
  }

  /**
   * 调用方没给地址时，这张标签该打开什么（`getNewTabUrl` 端口，见构造函数注释）。
   *
   * 为什么要在这里兜底而不是让每个调用方自己填：`newTab()` 的调用点很多
   * （IPC、无痕、地址栏动作 `open_incognito_tab`、扩展 API、按键…），
   * 漏一个就会建出 `about:blank` 空标签 —— 无痕新标签此前正是这样。
   * 端口本身接收会话身份，因此无痕 / 容器标签各拿各的地址，不需要调用方判断。
   *
   * @param {{ incognito?: boolean, containerProfileId?: string|null }} [ctx]
   * @returns {string} 空串 = 端口缺席或失败（调用方沿用原有 about:blank 行为）
   */
    _defaultTabUrl({ incognito, containerProfileId }: { incognito?: boolean; containerProfileId?: string | null } = {}) : string {
    if (!this._getNewTabUrl) return ''
    try {
      const url = this._getNewTabUrl({
        incognito: Boolean(incognito) || this._defaultIncognito,
        containerProfileId: containerProfileId ? String(containerProfileId) : null,
        profileId: String(this._context.getCurrent?.()?.profileId || 'default')
      })
      return typeof url === 'string' ? url : ''
    } catch (_) {
      return ''
    }
  }

  /**
   * @returns {{ tabId: string, url: string, view: Electron.WebContentsView|null, restoredNav: boolean, sleeping?: boolean }}
   */
    _createTabSync({ url, pinned, openInBackground, incognito, incognitoPartitionId, openAfterCurrent = true, navHistory, navHistoryIndex, webContents, openerTabId, sleeping, containerProfileId, muted, lastActivated, position, title, favicon }: TabCreateInput = {}): TabCreationResult {
    // 地址解析：未指定地址 → 新标签页设置口径（含无痕 / 容器各按自身会话取址）；
    // 然后扩展新标签页覆盖先于 PDF 分流（覆盖页可能是任意扩展内页面）。
    // PDF URL 自动重定向到内置 PDF 查看器（判据唯一：tabUrl#resolvePdfTarget）
    // 判「有没有显式给地址」必须看原始入参：normalizeUrl('') 会返回 'about:blank'
    // （见 tabUrl.js），拿它当判据会让空地址永远走不到下面的新标签页取址。
    const hasExplicitUrl = String(url == null ? '' : url).trim() !== ''
    const requested = hasExplicitUrl ? normalizeUrl(url) : this._defaultTabUrl({ incognito, containerProfileId })
    const normalized = this._resolveTabUrl(requested, { incognito, containerProfileId })
    const u = resolvePdfTarget(normalized, (target) => this._shouldUsePdfViewer(target))
    const newTab = this._makeTabRecord({
      url: u,
      pinned: Boolean(pinned),
      incognito: Boolean(incognito),
      incognitoPartitionId: incognitoPartitionId || null,
      // 容器标签（N10）：身份 profile（可选）。归属仍是构造时的当前 profile/space，
      // 于是它照常出现在当前空间的列表里，只是 cookie / 存储走**另一个** profile 的 Session
      //（会话解析见 setTabProfileResolver 的注入处）。
      containerProfileId: containerProfileId ? String(containerProfileId) : null,
      sleeping: Boolean(sleeping),
      // ── 会话恢复携带的用户态快照（v4）。仅在调用方显式给出时才覆盖默认值：
      //    `_makeTabRecord` 的默认值是「新标签」语义，恢复的标签必须沿用快照。
      ...(muted === true ? { muted: true } : {}),
      ...(Number.isFinite(Number(lastActivated)) && Number(lastActivated) > 0
        ? { lastActivated: Math.floor(Number(lastActivated)) }
        : {}),
      ...(typeof title === 'string' && title ? { title } : {}),
      ...(typeof favicon === 'string' && favicon ? { favicon } : {})
    })
    const tabId = newTab.tabId
    // 不变式：pinned ⟺ 属于一个 pinned 栈（固定标签 = 固定文件夹里的一员）。
    // 新标签**出生即入组**：会话恢复 / 命名会话 / 撤销关闭 / 将来任何
    // `newTab({ pinned: true })` 都从这条唯一的路子落进固定文件夹，
    // 绝不会先以「裸露的固定标签」形态出现在标签栏里（那正是"固定标签散在外面"的来源）。
    if (newTab.pinned) newTab.stackId = tabLayout.pinnedStackIdForNewTab(layoutHostOf(this))
    this._spaceActive.set(`${newTab.profileId}:${newTab.spaceId}`, tabId)

    // 插入位置：默认紧跟活动标签（对齐 RT `sourceTab.position + 0.5` + normalizePositions）。
    // 只改记录上的 position 数字，绝不重建 Map —— 旧实现在此 `new Map(entries)` 是
    // 「点新标签链接卡一会儿」的写侧成因之一（O(n) 且每次分配新 Map）。
    const explicitPosition = Number(position)
    const hasExplicitPosition = position != null && Number.isFinite(explicitPosition)
    const activeId = this.getActiveTabId()
    const activeRec = activeId ? this._tabs.get(activeId) : null
    if (hasExplicitPosition) {
      // 会话恢复：`position` 本身就是标签条顺序的数值真源（写盘时已归一化），
      // 直接落位、**不逐条 normalizePositions** —— 那会让 N 个标签的恢复退化成 O(n² log n)。
      newTab.position = explicitPosition
      this._tabs.set(tabId, newTab)
      // 仅在撞位时才补一次归一（例如把命名会话恢复到已有标签的窗口里）。
      for (const t of this._tabs.values()) {
        if (t !== newTab && t.profileId === newTab.profileId && t.spaceId === newTab.spaceId && Number(t.position) === explicitPosition) {
          this.normalizePositions()
          break
        }
      }
    } else if (activeRec && openAfterCurrent !== false) {
      newTab.position = (Number(activeRec.position) || 0) + 0.5
      this._tabs.set(tabId, newTab)
      this.normalizePositions()
    } else {
      // 无活动标签 → 追加到末尾（取当前最大 position + 1）
      let max = -1
      for (const t of this._tabs.values()) max = Math.max(max, Number(t.position) || 0)
      newTab.position = max + 1
      this._tabs.set(tabId, newTab)
    }

    /**
     * 标签组归属：**只有「从组内页面打开的页面」才继承组**，用户主动新建标签一律落组外。
     *
     * 判据只有一个 —— **真实 opener**（`openerTabId`）。它由 window.open / target=_blank
     * 的处理器显式传入（`setWindowOpenHandler` 手里的发起标签 id），那才是 Chrome 语义下
     * 「同源的下一件事」；继承时**把折叠的组展开**，否则新标签一进去就被折叠藏起来，
     * 看起来像「点了没打开」（与「折叠时仍显示活动成员」是同一条一致性要求）。
     *
     * ⚠ 绝不能退回「当前活动标签」：Ctrl+T、「+」按钮、菜单 / 面板浮钮新建出来的标签
     * 与活动标签的组毫无语义关系，用活动标签兜底的结果是「新建的标签被塞进当前所在的
     * 堆叠里」—— 那不是新建，是往组里加成员。新建标签就应当是普通标签。
     *
     * ⚠ 也不能用 `getTabIdByWebContents(webContents)` 反查 opener：window.open 传入的是
     * **新标签自己的**预建 webContents（此时尚未登记进 `_wcToTabId`），反查恒为 null。
     *
     * 休眠态创建（会话恢复）**不继承**：那批标签的组归属由 SessionRestoreService 按会话里
     * 的 stacks 明确重建，这里再继承一次会把「本来没有组」的恢复标签错误地并进别的组。
     */
    // 固定标签入位后立刻收拢固定段：新成员可能被插到别的固定文件夹中间
    // （position 取的是「活动标签 + 0.5」），这里把同一文件夹的成员重新聚齐，
    // 保证「一个文件夹一块、不劈成两半」。只在此处（新建固定标签）跑一次，
    // 不塞进 16ms 的 `_emitTabChanged` 热路径。
    if (newTab.pinned) tabLayout.enforcePinnedStackRuns(layoutHostOf(this))

    // 固定标签不继承 opener 的组：它已经落在固定文件夹里，再被塞进别人的普通组
    // 会同时破坏「pinned ⟺ 属于 pinned 栈」与「固定永远排最前」两条不变式。
    if (!sleeping && openerTabId && !newTab.pinned) {
      const sourceRec = this._tabs.get(String(openerTabId)) || null
      const srcStackId = sourceRec && sourceRec.stackId != null ? String(sourceRec.stackId) : ''
      if (srcStackId && this._stacks && this._stacks.has(srcStackId)) {
        newTab.stackId = srcStackId
        const srcStack = this._stacks.get(srcStackId)
        if (srcStack && srcStack.collapsed) srcStack.collapsed = false
      }
    }

    // 休眠态创建（会话恢复专用，对齐 RT `new Tab(..., { asleep: true })`）：
    // 只落 tab 记录 + 导航快照，**不建 WebContentsView / webContents、不 loadURL、不绑定事件**。
    // 恢复 N 个标签时只有活动标签会在随后的 switchTo 里被唤醒 → 启动只拉起 1 个渲染进程，
    // 而非 N 个（旧实现 eager 建 N 个 view + N 次 loadURL，正是「比 IE 还卡」的根因）。
    // 唤醒走既有 tabLifecycle.wakeInternal：createTab(id) 重建视图 + 用 preSleep 还原导航历史。
    if (sleeping) {
      newTab.navHistory = Array.isArray(navHistory) ? navHistory : []
      newTab.navHistoryIndex = Number.isFinite(Number(navHistoryIndex)) ? Number(navHistoryIndex) : 0
      newTab.preSleep = { url: u, navHistory: newTab.navHistory, navHistoryIndex: newTab.navHistoryIndex }
      this._scheduleEmitChanged()
      return { tabId, url: u, view: null, restoredNav: false, sleeping: true }
    }

    const viewOpts: TabViewOptions = {
      incognito: newTab.incognito,
      incognitoPartitionId: newTab.incognitoPartitionId || undefined
    }
    // window.open 路径：Electron 预建的 webContents 透传给 WCM 直接复用。
    if (webContents) viewOpts.webContents = webContents
    const view = this._wcm.createTab(tabId, viewOpts)
    this._bindTabEvents(tabId)
    try {
      if (newTab.muted && view.webContents) view.webContents.setAudioMuted(true)
    } catch {}
    // 会话恢复（阶段D）：把持久化的导航历史还原进新建的 webContents。
    // 必须在绑定事件之后、loadURL 之前——restore() 自身会导航到活动条目，
    // 因此调用方据此跳过 loadURL（否则会被二次导航覆盖掉前进/后退栈）。
    let restoredNav = false
    if (Array.isArray(navHistory) && navHistory.length > 1 && view && view.webContents) {
      restoredNav = restoreNavigationHistory(view.webContents, { navHistory, navHistoryIndex: Number(navHistoryIndex) || 0 })
      if (restoredNav) {
        newTab.navHistory = navHistory
        newTab.navHistoryIndex = Number.isFinite(Number(navHistoryIndex)) ? Number(navHistoryIndex) : navHistory.length - 1
      }
    }
    // 先显示标签，再异步加载 URL，保证"跟手"
    if (!openInBackground) {
      this._showTab(tabId)
    }
    this.markActivated(tabId)
    if (this._hooks.onTabCreated) {
      try { this._hooks.onTabCreated(tabId, view.webContents) } catch (e) {
        console.error('[ext] addTab failed:', errorMessage(e))
      }
    }
    // 前台新建：立即派发，点一下就要出现在标签栏。
    // 后台新建（Ctrl+点击 / 命名会话批量恢复）走合批：这类操作天生成批，
    // 逐个立即派发会退化成 N 次全量投影（见 `_emitNow` 的说明）。
    if (openInBackground) this._scheduleEmitChanged()
    else this._emitNow()
    return { tabId, url: u, view, restoredNav }
  }

  /**
   * 在当前空间里查找 URL 相同的已开标签 —— 「去重跳转」的**只读查询**。
   *
   * 只查、不改状态（是否复用由调用方按设置决定 —— infra 不读设置，见 APPS 层
   * `main/ipc/tabs.js` 的 `tabs:new` 处理器）。比对用 `normalizeUrl` 归一，
   * 避免 `https://a.com` 与 `https://a.com/` 被当成两个。作用域限定**当前空间**：
   * 跨空间复用会把用户从当前空间拽走，那不是"去重"该有的行为。
   *
   * @param {string} url
   * @returns {{ tabId: string, url: string }|null}
   */
    findTabByUrl(url: string) : { tabId: string, url: string }|null {
    const target = normalizeUrl(url)
    if (!target) return null
    for (const id of this._currentSpaceTabIds()) {
      const t = this._tabs.get(id)
      if (!t || !t.url) continue
      if (normalizeUrl(t.url) === target) return { tabId: String(id), url: t.url }
    }
    return null
  }

  async newTab(payload: TabCreateInput = {}): Promise<{ tabId: string; url: string }> {
    const { url, pinned, openInBackground, incognito, incognitoPartitionId, openAfterCurrent = true, navHistory, navHistoryIndex, sleeping, containerProfileId, muted, lastActivated, position, title, favicon } = payload
    // 无痕窗口（多窗口）：本窗口的每个新标签默认就是无痕，并共享本窗口的内存 partition。
    // 只在调用方**未显式指定** incognito 时改写 —— 因此 newIncognitoTab 内部那条
    // `newTab({ incognito: true })` 不会再次进入本分支（不会递归）。
    if (this._defaultIncognito && incognito === undefined) {
      return this.newIncognitoTab({ url, pinned, openInBackground, openAfterCurrent, navHistory, navHistoryIndex, sleeping, containerProfileId, muted, lastActivated, position, title, favicon })
    }
    const { tabId, url: u, view, restoredNav } = this._createTabSync({
      url, pinned, openInBackground, incognito, incognitoPartitionId, openAfterCurrent, navHistory, navHistoryIndex, sleeping, containerProfileId, muted, lastActivated, position, title, favicon
    })
    // 休眠态创建：没有 webContents，直接返回（唤醒时再建视图 + 还原导航历史）。
    if (sleeping || !view) return { tabId, url: u }
    // 导航历史已被 restore() 还原并完成导航 → 不再 loadURL，保住前进/后退栈。
    if (!restoredNav) {
      // 异步加载，不 await
      view.webContents.loadURL(u).catch((e) => {
        const message = errorMessage(e)
        if (message !== 'ERR_ABORTED' && !message.includes('ERR_ABORTED')) {
          console.error('[tab] loadURL failed:', u, message)
        }
      })
    }
    return { tabId, url: u }
  }

  /**
   * 创建无痕标签：使用临时 session partition，关闭后所有数据消失。
   * 对齐 Chrome incognito tab 行为。
   * @param {{ url?: string, pinned?: boolean, openInBackground?: boolean, openAfterCurrent?: boolean,
   *   navHistory?: NavigationEntry[], navHistoryIndex?: number, sleeping?: boolean, containerProfileId?: string,
   *   muted?: boolean, lastActivated?: number, position?: number, title?: string, favicon?: string }} [payload]
   * @returns {Promise<{tabId: string, url: string}>}
   */
  async newIncognitoTab(payload: TabCreateInput = {}): Promise<{ tabId: string; url: string }> {
    // 同一窗口的所有无痕标签共享一个 partition id（由 TabManager 内部生成一次）
    if (!this._incognitoPartitionId) {
      this._incognitoPartitionId = `win-${Date.now().toString(36)}-${randomUUID().slice(0, 8)}`
    }
    return this.newTab({
      ...payload,
      incognito: true,
      incognitoPartitionId: this._incognitoPartitionId
    })
  }

  async navigate({ tabId, url, title, favicon, typed }: NavigateInput = {}): Promise<{ tabId: string; url: string }> {
    const id = tabId ? String(tabId) : this.getActiveTabId()
    if (!id) throw new Error('No active tab')
    const t = this._tabs.get(id)
    if (!t) throw new Error(`Missing tab: ${id}`)
    // 地址解析：与建标签同一道闸门（扩展新标签页覆盖 / PDF 分流），
    // 否则「地址栏输入 hira://newtab」会绕过覆盖、显示内置页。
    const normalized = this._resolveTabUrl(normalizeUrl(url), {
      // 标签自身的会话身份才是判据（不是"当前窗口是不是无痕"）
      incognito: Boolean(t.incognito),
      containerProfileId: t.containerProfileId || null
    })
    const u = resolvePdfTarget(normalized, (target) => this._shouldUsePdfViewer(target))
    // 休眠中先走统一唤醒（重建 webContents + 绑定事件 + 还原静音/导航历史），再导航。
    // 此前这里手写了一份 createTab+bind 的唤醒逻辑，漏了导航历史还原且与 _wakeInternal 漂移。
    if (this._wcm.isTabSleeping(id)) {
      this._wakeInternal(id)
      // 唤醒后新视图默认隐藏且未挂载（对齐 RT tab.ts 的 setVisible(false)），
      // 若它就是当前活动标签，必须经 showTab 重新挂载并显示，否则唤醒+导航后一片空白。
      if (this._layout.getActiveTabId() === id) this._layout.showTab(id)
    }
    const view = this._wcm.createTab(id)
    // 去重：目标 URL 与当前 webContents URL 相同则跳过，避免重复导航触发 ERR_ABORTED
    try {
      const curUrl = view.webContents.getURL()
      if (curUrl && curUrl === u) {
        t.url = u
        this._scheduleEmitChanged()
        if (this._onNavigate) {
          try { this._onNavigate({ tabId: id, url: u, title, favicon, typed: typed === true }) } catch {}
        }
        return { tabId: id, url: u }
      }
    } catch {}
    t.url = u
    this._scheduleEmitChanged()
    // 对齐 RT tabs-controller.internalCreateTab 末尾：loadURL **同步发起、绝不 await**。
    // 之前这里 `await loadPromise` 会把发起导航的 IPC invoke 一直挂到页面 load 完成，
    // 渲染层（omnibox / ui-shell）因此被"锁死"到整页加载结束 —— 正是「回车/点击后整个
    // 界面卡住、跟 IE 一样」的元凶。RT 从不等页面加载完再返回。
    view.webContents.loadURL(u).catch((e) => {
      const message = errorMessage(e)
      if (message !== 'ERR_ABORTED' && !message.includes('ERR_ABORTED')) {
        console.error(`[tab] navigate failed: ${u}`, message)
      }
    })
    if (this._onNavigate) {
      try { this._onNavigate({ tabId: id, url: u, title, favicon, typed: typed === true }) } catch {}
    }
    return { tabId: id, url: u }
  }

    reorder(opts: TabManagerOptionsUpdate = {}) {
    return tabLayout.reorder(layoutHostOf(this), opts)
  }

    destroySpaceTabs(profileId: string, spaceId: string) {
    const profile = String(profileId || '')
    const space = String(spaceId || '')
    const ids = Array.from(this._tabs.values())
      .filter((tab) => String(tab.profileId || '') === profile && String(tab.spaceId || '') === space)
      .map((tab) => tab.tabId)
    for (const id of ids) {
      const view = this._wcm.getTab(id)
      if (this._layout.getActiveTabId() === id) this._layout.hideTab()
      if (this._layout && typeof this._layout.forgetView === 'function' && view) this._layout.forgetView(view)
      try { this._wcm.destroyTab(id) } catch {}
      this._tabs.delete(id)
      this._boundTabIds.delete(id)
      for (const [wc, tid] of this._wcToTabId) if (tid === id) this._wcToTabId.delete(wc)
      if (this._hooks.onTabClosed) {
        try { this._hooks.onTabClosed(id) } catch {}
      }
    }
    this._spaceActive.delete(`${profile}:${space}`)
    this._removeEmptyStacks()
    if (ids.length > 0) this._scheduleEmitChanged()
    return { destroyed: ids.length, tabIds: ids }
  }

    destroyProfileTabs(profileId: string) {
    const profile = String(profileId || '')
    const spaces = new Set(Array.from(this._tabs.values())
      .filter((tab) => String(tab.profileId || '') === profile)
      .map((tab) => String(tab.spaceId || 'default')))
    let destroyed = 0
    for (const space of spaces) destroyed += this.destroySpaceTabs(profile, space).destroyed
    return { destroyed }
  }

  /**
   * 广播「标签可见性变化」信号（切走 / 切到 / 接替变可见时调用）。
   *
   * 用只读窥视（`_wcm.getTab`）取 view，**绝不创建**：休眠中的标签不该因为一次
   * 可见性广播而被唤醒（那会让"内存优化"白做）。取不到（休眠 / 已销毁）直接静默。
   *
   * @param {string} tabId
   * @param {boolean} visible true = 刚变为可见（消费方退出 PiP），false = 刚被隐藏（消费方可进 PiP）
   */
    _notifyTabVisibility(tabId: string, visible: boolean) {
    const hook = visible ? this._onTabShown : this._onTabHidden
    if (!hook) return
    const id = String(tabId)
    const view = this._wcm.getTab(id)
    if (!view || !view.webContents || view.webContents.isDestroyed()) return
    try { hook(id, view.webContents) } catch (e) {
      console.error('[pip] onTabShown/onTabHidden failed:', errorMessage(e))
    }
  }

  /**
   * 广播「标签即将隐藏 / 被回收」信号 —— **采帧的唯一时机入口**。
   *
   * 必须在 view 仍挂载、页面仍渲染时调用：`capturePage()` 一旦视图脱离宿主就返回空图。
   * 两个调用方共用它，保证时机约束只在这里写一次：
   *   · `switchTo` —— 切走旧标签前；
   *   · `tabLifecycle.sleepTab / sleepInactive` —— 销毁 webContents 前（休眠同样是一次隐藏）。
   *
   * 只读窥视（`_wcm.getTab`），绝不创建 view。取不到（休眠 / 已销毁）静默。
   * @param {string} tabId
   */
    _notifyTabWillHide(tabId: string) {
    if (!this._onTabWillHide) return
    const id = String(tabId)
    const view = this._wcm.getTab(id)
    if (!view || !view.webContents || view.webContents.isDestroyed()) return
    try {
      this._onTabWillHide(id, view.webContents)
    } catch (e) {
      console.error('[snapshot] onTabWillHide failed:', errorMessage(e))
    }
  }

    switchTo(tabId: string) {
    const id = String(tabId)
    if (!this._tabs.has(id)) throw new Error(`Missing tab: ${id}`)
    // 切换前给「即将隐藏的旧标签」一次采帧机会（对齐 RT tab-snapshot 的时机约束）：
    // 此刻旧 view 仍挂载、页面仍渲染，capturePage 才有内容；一旦 setVisible(false)
    // 或视图脱离宿主，抓到的就是空图。标签 hover 预览正是消费这一帧。
    //
    // ⚠ 但「切到同一组的另一格」根本没隐藏任何东西（分屏同伴 / 速览的两张卡都还亮着），
    //   这时**绝不许**发这两条信号 —— 见 `_prevStaysVisible`。
    const prevId = this.getActiveTabId()
    if (prevId && prevId !== id && !this._prevStaysVisible(prevId, id)) {
      this._notifyTabWillHide(prevId)
      // 可见性变化：旧标签被隐藏 → 消费方（自动画中画）可在此进 PiP
      this._notifyTabVisibility(prevId, false)
    }
    // 若标签休眠中，_showTab 会自动唤醒（恢复 webContents 并还原导航历史）
    this._showTab(id)
    const view = this._wcm.createTab(id)
    // 可见性变化：新标签变为可见 → 消费方退出 PiP
    this._notifyTabVisibility(id, true)
    // 分屏：其余格也一并变为可见。PiP 的进出判定按**格子**走 —— 只通知活动格的话，
    // 非活动格会在可见状态下继续挂着系统 PiP 小窗（与"切标签不通知"是同一个 bug 的变体）。
    const activeSplit = typeof this._layout.getActiveSplit === 'function' ? this._layout.getActiveSplit() : null
    if (activeSplit && Array.isArray(activeSplit.members)) {
      for (const memberId of activeSplit.members) {
        if (memberId === id) continue
        this._notifyTabVisibility(memberId, true)
      }
    }
    // 对齐 RT/Hira：切换后 focus webContents，确保键盘事件正确路由。
    // 若这次切换其实是「新建标签页 / 启动首个标签」，外壳会在随后的 tab:changed 里
    // 经 `shell:focus` 反复重申地址栏聚焦，把它要回来 —— 无需在这里做让位判断。
    try { view.webContents.focus() } catch {}
    this.markActivated(id)
    if (this._hooks.onTabSwitched) {
      try { this._hooks.onTabSwitched(id, view.webContents) } catch (e) {
        console.error('[ext] selectTab failed:', errorMessage(e))
      }
    }
    // 立即派发：点标签 → 标签栏高亮必须同一轮就到，不能等 16ms 合批。
    this._emitNow()
    return { tabId: id }
  }

  /**
   * 切走之后，**上一个活动标签是否仍然可见** —— 分屏同伴 / 速览的另一张卡。
   *
   * 为什么必须问这一句：`switchTo` 的两条"隐藏前"信号（采帧 + 可见性 false）只在
   * **真的隐藏**时才有意义。分屏与速览里切到同一组的另一个成员，两边都还亮着：
   *   · `onTabWillHide` → `capturePage()` 会把整帧从 GPU 回读（还带一次 JPEG 编码），
   *     正压在切换那一拍上 —— 用户看到的就是"白一下 + 卡一下"，而且抓到的帧根本没用；
   *   · `visibility=false` → 消费方（自动画中画）会误以为它被藏了而进 PiP。
   * 判据只看**当前活动组**：两者同属一个活动速览组或分屏组即视为"仍可见"。
   *
   * @param {string} prevId 切换前的活动标签
   * @param {string} nextId 切换后的活动标签
   * @returns {boolean}
   */
    _prevStaysVisible(prevId: string, nextId: string) : boolean {
    const layout = this._layout
    if (!layout || !prevId || !nextId) return false
    const inGroup = (state: { members?: string[] } | null) => {
      if (!state || !Array.isArray(state.members)) return false
      const members = state.members.map(String)
      return members.includes(String(prevId)) && members.includes(String(nextId))
    }
    const glance = typeof layout.getActiveGlance === 'function' ? layout.getActiveGlance() : null
    if (inGroup(glance)) return true
    const split = typeof layout.getActiveSplit === 'function' ? layout.getActiveSplit() : null
    return inGroup(split)
  }

  /**
   * 唤醒标签的内部同步实现（委托 tabLifecycle，对齐 RT TabLifecycleManager）。
   * @param {string} id
   * @returns {Electron.WebContentsView | null}
   */
    _wakeInternal(id: string) : Electron.WebContentsView | null {
    return tabLifecycle.wakeInternal(lifecycleHostOf(this), id)
  }

  /**
   * 显示标签：休眠中则先唤醒再显示，避免「切到休眠标签显示空白 / 状态失联」。
   * 对齐 RT `tab-layout.updateLayout()` 的「显示即 wakeUp」。
   * @param {string} id
   */
    _showTab(id: string) {
    if (this._wcm.isTabSleeping(id)) this._wakeInternal(id)
    // 分屏：先按「这个标签属于哪个组」把状态灌给布局层（不属于 → 退出分屏），再显示。
    // 这一步只看 tab.splitId 一条判据，没有"分屏模式"这类全局开关。
    this._syncActiveSplit(id)
    return this._layout.showTab(id)
  }

  /**
   * 关闭标签。
   * @param {string} tabId
   * @param {{ lastTabUrl?: string, skipUndoStack?: boolean }} [opts]
   *   lastTabUrl 显式指定「关闭最后一个标签」时替换成的地址；省略时走构造期注入的
   *   `getNewTabUrl` 端口（见构造函数注释）；端口也没有才退回 about:blank。
   *   skipUndoStack=true 时不把该标签写进「恢复关闭的标签页」撤销栈 ——
   *   供**归档**复用（归档不是用户主动关闭，混进撤销栈会让 Ctrl+Shift+T 恢复出
   *   一堆用户从没关过的标签）。缺省行为与既有实现完全一致。
   */
    close(tabId: string, opts: TabManagerOptionsUpdate = {}) {
    const id = String(tabId)
    const t = this._tabs.get(id)
    if (!t) return { closed: false, tabId: id }

    // C08: pinned tabs cannot be closed via close()
    if (t.pinned) return { closed: false, tabId: id, reason: 'pinned' }

    const active = this.getActiveTabId()
    // 关闭的一切判定都限定在**本标签所属空间**内（见 _orderedEntriesInSpace 注释）：
    //   · 是否"最后一个标签"看空间内数量，不是全局数量；
    //   · 关闭后的接替邻居也在空间内取，绝不跨空间。
    const spaceProfileId = String(t.profileId || 'default')
    const spaceId = String(t.spaceId || 'default')
    const spaceEntries = this._orderedEntriesInSpace(spaceProfileId, spaceId)
    const closedIndex = spaceEntries.findIndex(([tid]) => tid === id)

    // 对齐 Hira：空间内最后一个标签关闭时，替换为新标签页地址
    // （设置里的空白页 / 自定义地址 / 快速拨号页）。地址优先取调用方显式传入的
    // `lastTabUrl`，否则走注入的解析端口 —— 端口存在才能让 Ctrl+W、菜单、扩展
    // 这些不经过 `tab:close` IPC 的入口也拿到同一个地址。
    if (spaceEntries.length === 1) {
      let url = opts.lastTabUrl
      if (!url && this._getNewTabUrl) {
        // 带上这个标签的会话身份：无痕窗口不能拿到扩展覆盖地址（见 onResolveTabUrl 说明）
        try {
          url = this._getNewTabUrl({
            incognito: Boolean(t.incognito) || this._defaultIncognito,
            containerProfileId: t.containerProfileId || null,
            profileId: String(t.profileId || 'default')
          })
        } catch (_) { url = '' }
      }
      if (!url) url = 'about:blank'

      // 「只剩下一个新标签页」→ 关掉它就该退出，而不是再补一个新标签页（用户设置）。
      // 判定交给 APPS 端口：它才知道这个地址是不是设置里的新标签页、以及关窗还是退出。
      //   · 额外要求**全窗口**只剩这一张（`_tabs.size === 1`）：别的空间还开着标签时，
      //     这只说明"本空间的最后一张"该补位，不该把整个窗口带走；
      //   · `skipUndoStack`（归档路径）**不参与**：归档不是"用户关掉了这一页"，让归档一个
      //     空白标签顺手把窗口关掉，是比"关不掉"更糟的意外。
      if (!opts.skipUndoStack && this._onLastTabClose && this._tabs.size === 1) {
        let handled = false
        try {
          handled = this._onLastTabClose({ tabId: id, url: String(t.url || ''), newTabUrl: String(url) }) === true
        } catch (_) { handled = false }
        if (handled) return { closed: true, tabId: id, reason: 'last-tab-quit' }
      }

      // 记录立刻回落到"新标签页"：URL 换掉、标题/图标清空、导航快照丢弃。
      // 快照必须丢 —— 否则休眠标签唤醒时 restoreNavigationHistory 会把**刚关掉那页**
      // 的历史还原回来，用户看到的就是"关了最后一个标签，旧页面又回来了"。
      //
      // ⚠ **favicon 不能无条件清**（用户报的"关掉最后一个标签后，新补的那个标签只有兜底
      //   首字图标，手动新建却正常"）。原因在 Chromium 的图标事件时机：
      //   它只在一个 document 的图标**首次到达**时发 `page-favicon-updated`
      //   （同 URL 重载不会再发第二次 —— 见 tabEvents 里那段实测记录）。
      //   而本路径是**复用同一个 webContents** 去 loadURL：当补位地址与旧页同站
      //   （最常见就是"旧页本来就是新标签页、补位又是新标签页"）时那次导航不会重发图标事件，
      //   清了就永远回不来 —— 于是只剩兜底首字。
      // 判据与 tabEvents 的 did-start-navigation 同源（shared-types#url-protocols 的 siteKeyOf）：
      //   · 同站（含**同一地址**：hira:// 这类内部页 siteKeyOf 为空，用整串比对兜住）→ 保留；
      //   · 换站 → 清空，新页面的图标会随新 document 的图标事件到达。
      const prevUrl = String(t.url || '')
      const prevSite = siteKeyOf(prevUrl)
      const nextSite = siteKeyOf(url)
      const keepsFavicon = prevUrl === String(url) || (!!prevSite && prevSite === nextSite)
      t.url = url
      t.title = ''
      if (!keepsFavicon) t.favicon = ''
      t.preSleep = null
      this._spaceActive.set(`${spaceProfileId}:${spaceId}`, id)

      // 视图侧：**必须经 _showTab 走完整链路**，不能像旧实现那样裸调 `createTab(id)`。
      // 休眠标签的 `createTab` 会新建一个 **setVisible(false)** 的视图却没人显示它
      // （内容区空白），而且不重绑事件、不还原静音；非休眠标签虽复用可见视图，
      // 也少了"重挂载/重排"这一步。`_showTab` 恰好覆盖这两种情形。
      const wasSleeping = this._wcm.isTabSleeping(id)
      if (active === id) {
        this._showTab(id)
        // 唤醒分支已经用新 t.url 发起导航；只有"本来就在显示"的视图需要显式导航。
        if (!wasSleeping) {
          const view = this._wcm.getTab(id)
          if (view && view.webContents && !view.webContents.isDestroyed()) {
            view.webContents.loadURL(url).catch(() => {})
          }
        }
      } else if (!wasSleeping) {
        // 非活动标签但视图仍在（少见）：就地把 URL 换掉，保持记录与视图一致。
        // 仍是休眠态的则不动 —— 维持"休眠即无 webContents"的不变式，下次显示时自然加载新 URL。
        const view = this._wcm.getTab(id)
        if (view && view.webContents && !view.webContents.isDestroyed()) {
          view.webContents.loadURL(url).catch(() => {})
        }
      }
      this._scheduleEmitChanged()
      return { closed: false, tabId: id, reason: 'last-tab', url }
    }

    // C16: record closed tab with its position for undo
    // `skipUndoStack`（归档专用）跳过此步：归档等价于删除，不该出现在撤销/最近关闭列表里。
    if (!opts.skipUndoStack) {
      this._closedTabStack.push({ tabId: id, url: t.url, title: t.title, favicon: t.favicon, pinned: t.pinned, stackId: t.stackId, index: closedIndex, closedAt: Date.now() })
      if (this._closedTabStack.length > CLOSED_TAB_STACK_LIMIT) this._closedTabStack.shift()
      this._notifyClosedStackChanged()
    }

    // 分屏收尾**必须在删除记录之前**：`removeTabFromSplit` 要读这个标签的 `splitId`
    // 才能知道该从哪个组里摘掉它 —— 放在 delete 之后会早退，等于"关掉的格子永远留在组里"，
    // 下一次布局就会去 `getTab(已销毁)` 拿到 null，那一格变成一个黑洞（空白）。
    // 同时先把"关掉之前它属于哪个组"记下来：接替格要钉在**同组**里（见 _splitSuccessorAfterClose）。
    const splitIdOfClosed = t.splitId != null ? String(t.splitId) : ''
    this._removeTabFromSplit(id)
    // 速览收尾同理，且同样必须在 delete 之前（要读 tab.glanceId）。速览成员恒 2，
    // 少一张即整组解散（domain#removeTabFromGlance），故不需要"接替格"。
    // 关掉之前记下它属于哪个速览组：下面"活动标签没变"那一支要靠它判断要不要重排。
    const glanceIdOfClosed = t.glanceId != null ? String(t.glanceId) : ''
    this._removeTabFromGlance(id)
    // 定时刷新（C7）随标签一起停 —— 不停就会"标签已关闭还在后台重载"。
    this._clearAutoRefresh(id)
    this._tabs.delete(id)
    this._removeEmptyStacks()

    // 对齐 Hira：关闭活动标签时，优先切到左边相邻标签，没有则切右边
    if (active === id) {
      // ⚠ 分屏里关掉一格时，接替格**必须是同组剩下的一格**：分屏成员虽然相邻，但左邻可能是
      //   组外标签 —— `_showTab(组外标签)` 会经 `_syncActiveSplit` 判定"活动标签不在组里"
      //   而把整片分屏收掉。用户要的是"只关掉这一格，分屏留着"（只剩 1 格时才退出）。
      const next = this._splitSuccessorAfterClose(splitIdOfClosed, id) ||
        this._getTabIdInSpace(spaceProfileId, spaceId, closedIndex - 1) ||
        this._getTabIdInSpace(spaceProfileId, spaceId, closedIndex)
      if (next) {
        this._showTab(next)
        // 这条路径**不经过 switchTo**，但接替标签确实由隐藏变为可见：
        // 必须显式广播，否则它会在可见状态下继续挂着系统 PiP 小窗
        // （对齐 RT tab-layout「PiP enter/exit on visibility transitions」）。
        this._notifyTabVisibility(next, true)
      } else {
        this._layout.hideTab()
      }
    } else if (splitIdOfClosed || glanceIdOfClosed) {
      // 关掉的是**别的格 / 速览成对里的另一张**（指针停在非活动的那张上按的 ✕）：
      // 活动标签没变，于是既不会走上面那段切标签、也没人重排 —— 而布局层手里的
      // `members` 已经过期（少了一个）。这里补一次同步：
      //   · 分屏：活动格仍是成员 → 重排；组散 → 退出分屏。
      //   · 速览：成员恒 2，少一张即整组解散 → `_syncActiveSplit` 拿到 null 速览态，
      //     经 `setActiveGlance(null)` 落到 `_exitGlanceToSingleView()`，**剩下那张
      //     恢复正常视图**（此前漏了这一支，剩下的卡就永远停在"背面小卡"的位置）。
      this._syncActiveSplit(active)
    }

    if (this._layout && typeof this._layout.forgetView === 'function') {
      const oldView = this._wcm.getTab(id)
      if (oldView) this._layout.forgetView(oldView)
    }
    this._wcm.destroyTab(id)
    if (this._layout && typeof this._layout.resetTabBounds === 'function') {
      this._layout.resetTabBounds()
    }
    this._boundTabIds.delete(id)
    // 该标签若是某空间的「活动标签」记录，一并清掉 —— 否则空间投影会指向已关闭的标签
    // （与 detachTab 同一处理：`_spaceActive` 是按空间有界的表，留陈旧引用会让
    //  「切回该空间」时去 getTab 一个不存在的 id）。
    for (const [key, value] of this._spaceActive) {
      if (value === id) this._spaceActive.delete(key)
    }
    // 清理 webContents → tabId 映射
    for (const [wc, tid] of this._wcToTabId) {
      if (tid === id) this._wcToTabId.delete(wc)
    }
    if (this._hooks.onTabClosed) this._hooks.onTabClosed(id)
    // 立即派发：关标签要立刻从标签栏消失（批量关闭由 _withEmitBatch 折叠，见其说明）。
    this._emitNow()
    return { closed: true, tabId: id }
  }

  /**
   * 把一个标签**交给别的窗口**（跨窗口迁移的源侧）：摘掉记录与视图，
   * 但**不销毁** webContents —— 页面、导航历史、表单状态整体随视图搬走。
   *
   * 与 close() 的差异是本质的：close 走 destroyTab（webContents 销毁），
   * 迁移走 WCM.detachTab（只摘不销毁）。因此这里绝不复用 close。
   *
   * 迁移后源窗口那些仍挂在旧 webContents 上的事件监听会自动失效 ——
   * 它们都带 `_isCurrentWc` 守卫，而本窗口的 `getTab(id)` 已返回 null。
   *
   * @param {string} tabId
   * @returns {{ record: object, view: Electron.WebContentsView, options: object|null }|null}
   */
    detachTab(tabId: string) : { record: object, view: Electron.WebContentsView, options: object|null }|null {
    const id = String(tabId)
    const t = this._tabs.get(id)
    if (!t) return null

    const bundle = this._wcm.detachTab(id)
    if (!bundle) return null

    const active = this.getActiveTabId()
    // 同 close()：接替邻居只在**本空间**内取（全局序号会把别的空间算进来 → 接替者错位）。
    const spaceProfileId = String(t.profileId || 'default')
    const spaceId = String(t.spaceId || 'default')
    const index = this._orderedEntriesInSpace(spaceProfileId, spaceId).findIndex(([tid]) => tid === id)

    this._tabs.delete(id)
    // 栈成员身份由**标签记录上的 stackId** 承载（栈元数据里没有成员表），
    // 因此标签一走，_removeEmptyStacks() 就会把空掉的栈元数据一并清掉。
    // 迁入方一律以「未分组」接收：栈是窗口内的组织方式，不做跨窗口的栈合并。
    this._removeEmptyStacks()

    if (active === id) {
      const next = this._getTabIdInSpace(spaceProfileId, spaceId, index - 1) ||
        this._getTabIdInSpace(spaceProfileId, spaceId, index)
      if (next) {
        this._showTab(next)
        // 迁移同样会让接替标签由隐藏变可见（不经过 switchTo）→ 必须广播，同 close()。
        this._notifyTabVisibility(next, true)
      } else {
        this._layout.hideTab()
      }
    }

    if (this._layout && typeof this._layout.forgetView === 'function') {
      this._layout.forgetView(bundle.view)
    }
    if (this._layout && typeof this._layout.resetTabBounds === 'function') {
      this._layout.resetTabBounds()
    }

    this._boundTabIds.delete(id)
    const wc = bundle.view && bundle.view.webContents
    if (wc) {
      this._wcToTabId.delete(wc)
    }
    // 该标签若是某空间的「活动标签」记录，一并清掉 —— 否则空间投影会指向已离开的标签
    for (const [key, value] of this._spaceActive) {
      if (value === id) this._spaceActive.delete(key)
    }
    this._scheduleEmitChanged()
    return { record: { ...t, stackId: null }, view: bundle.view, options: bundle.options }
  }

  /**
   * 接收别的窗口迁来的标签（跨窗口迁移的目标侧）：视图已在源侧摘下、
   * 这里只做「登记视图 + 落记录 + 绑事件 + 追加到末尾」。
   *
   * 不切换过去：迁入的标签默认在后台 —— 用户的目标窗口正在看别的内容，
   * 替他切走是打扰（Chrome 的「移动到其他窗口」同样保持目标窗口的当前标签）。
   *
   * @param {{ record: object, view: Electron.WebContentsView, options?: object|null }} bundle
   */
    adoptTab(
      bundle: { record: TabRecord; view: WebContentsView; options?: Record<string, unknown> | null },
      place: { targetId?: string | null; insertAfter?: boolean } = {}
    ) {
    const { record, view, options = null } = bundle
    if (!record || !record.tabId) throw new Error('adoptTab: record.tabId is required')
    const id = String(record.tabId)
    if (this._tabs.has(id)) throw new Error(`adoptTab: duplicate tabId ${id}`)

    this._wcm.adoptTab(id, view, options)

    let max = -1
    for (const t of this._tabs.values()) max = Math.max(max, Number(t.position) || 0)
    let position = max + 1
    const targetId = place.targetId == null ? '' : String(place.targetId)
    const target = targetId ? this._tabs.get(targetId) : null
    if (target
      && String(target.profileId || 'default') === String(record.profileId || 'default')
      && String(target.spaceId || 'default') === String(record.spaceId || 'default')) {
      const ordered = this._orderedEntriesInSpace(record.profileId, record.spaceId)
      const targetIndex = ordered.findIndex(([tabId]) => tabId === targetId)
      if (targetIndex >= 0) {
        const insertAt = targetIndex + (place.insertAfter === true ? 1 : 0)
        const before = insertAt > 0 ? Number(ordered[insertAt - 1]?.[1]?.position) || 0 : null
        const after = insertAt < ordered.length ? Number(ordered[insertAt]?.[1]?.position) || 0 : null
        if (before == null) position = after == null ? 0 : after - 1
        else if (after == null) position = before + 1
        else position = (before + after) / 2
      }
    }
    this._tabs.set(id, { ...record, position, stackId: null })

    this._bindTabEvents(id)
    try {
      if (record.muted && view.webContents) view.webContents.setAudioMuted(true)
    } catch (_) {}
    // 语义上这就是「本窗口新增了一个标签」：扩展系统等按窗口注册的子系统必须感知到，
    // 否则迁入的标签在目标窗口里是「扩展不认的孤儿标签」。
    if (this._hooks.onTabCreated) {
      try { this._hooks.onTabCreated(id, view.webContents) } catch (e) {
        console.error('[tab] onTabCreated hook failed during adopt:', errorMessage(e))
      }
    }
    this._scheduleEmitChanged()
    return { tabId: id }
  }

  /**
   * 休眠标签（委托 tabLifecycle，对齐 RT TabLifecycleManager）。
   * 销毁 webContents 释放内存，保留 URL/title/favicon 与导航快照。
   * @param {string} tabId
   * @returns {{ tabId: string, sleeping: boolean, reason?: string }}
   */
    sleepTab(tabId: string) : { tabId: string, sleeping: boolean, reason?: string } {
    return tabLifecycle.sleepTab(lifecycleHostOf(this), tabId)
  }

  /**
   * 唤醒标签：重新创建 webContents 并还原导航历史。
   * @param {string} tabId
   * @returns {Promise<{ tabId: string, sleeping: boolean }>}
   */
  async wakeTab(tabId: string) : Promise<{ tabId: string, sleeping: boolean }> {
    return tabLifecycle.wakeTab(lifecycleHostOf(this), tabId)
  }

  /**
   * 批量休眠非活动标签（内存优化）：sleepInactive(minActiveMs)
   * 主动调用或由 main.js 定时器触发。
   * @param {{ inactiveThresholdMs?: number, excludePinned?: boolean }} [opts]
   * @returns {{ slept: string[] }}
   */
    sleepInactive(opts: SleepInactiveOptions = {}) : { slept: string[] } {
    return tabLifecycle.sleepInactive(lifecycleHostOf(this), opts)
  }

  /**
   * 归档标签（委托 tabLifecycle，对齐 RT 的第二条回收腿）。
   * 归档 = 真正删除该标签（等价于用户关掉它），**不进撤销栈**。
   * @param {string} tabId
   * @returns {{ tabId: string, archived: boolean, reason?: string }}
   */
    archiveTab(tabId: string) : { tabId: string, archived: boolean, reason?: string } {
    return tabLifecycle.archiveTab(lifecycleHostOf(this), tabId)
  }

  /**
   * 批量归档长期闲置的非活动标签（标签栏瘦身）。
   * 候选判定复用 `tabRules.sleepCandidates`（活动/固定/音频/闲置阈值四重豁免同源）。
   * 阈值缺失时不做任何事（安全默认：归档不可逆）。
   * @param {{ inactiveThresholdMs?: number }} [opts]
   * @returns {{ archived: string[] }}
   */
    archiveInactive(opts: ArchiveInactiveOptions = {}) : { archived: string[] } {
    return tabLifecycle.archiveInactive(lifecycleHostOf(this), opts)
  }

  /** 记录标签被激活的时间戳（用于 sleepInactive 判定） */
    markActivated(tabId: string) {
    return tabLifecycle.markActivated(lifecycleHostOf(this), tabId)
  }

  /**
   * 构造期播种撤销栈（跨启动「最近关闭」）。
   * 钩子缺失 / 抛错 / 返回非数组 → 一律空栈（改造前的行为）。
   * @returns {Array}
   */
  _loadClosedTabStack(): ClosedTabEntry[] {
    const load = this._hooks && this._hooks.loadClosedTabs
    if (typeof load !== 'function') return []
    try {
      const rows = load()
      return (Array.isArray(rows) ? rows : []).slice(-CLOSED_TAB_STACK_LIMIT)
    } catch (e) {
      console.error('[tab] loadClosedTabs hook failed:', errorMessage(e))
      return []
    }
  }

  /**
   * 撤销栈变化后通知 APPS（持久化镜像）。
   * 传的是**栈本身**（旧 → 新）：订阅方只读、同步处理，不做异步遍历。
   */
  _notifyClosedStackChanged() {
    const notify = this._hooks && this._hooks.onClosedStackChanged
    if (typeof notify !== 'function') return
    try {
      notify(this._closedTabStack)
    } catch (e) {
      console.error('[tab] onClosedStackChanged hook failed:', errorMessage(e))
    }
  }

  /**
   * C16: undo last closed tab, restoring it to its original position.
   */
  async undoClose() {
    const entry = this._closedTabStack.pop()
    if (entry) this._notifyClosedStackChanged()
    return this._restoreClosedEntry(entry)
  }

  /**
   * 恢复「最近关闭」列表里的**指定一项**（供历史页 / 应用菜单消费）。
   *
   * `index` 的口径与 `listRecentlyClosed()` 的返回顺序完全一致（0 = 最近关闭的第一个），
   * 而不是内部栈下标 —— 调用方（UI）只认识展示顺序，不该知道栈是反的。
   * 越界 / 非法下标一律返回 null（永不抛错）。
   *
   * @param {number} index 列表下标（最近关闭在前）
   * @returns {{ tabId: string, url: string } | null}
   */
  async undoCloseAt(index: number) : Promise<{ tabId: string, url: string } | null> {
    const i = Number(index)
    if (!Number.isInteger(i) || i < 0 || i >= this._closedTabStack.length) return null
    const stackPos = this._closedTabStack.length - 1 - i
    const [entry] = this._closedTabStack.splice(stackPos, 1)
    this._notifyClosedStackChanged()
    return this._restoreClosedEntry(entry)
  }

  /**
   * 把一条撤销栈记录真正变回标签 —— `undoClose` / `undoCloseAt` 的**唯一**实现。
   * （两个入口的差别只是「取哪一条」，恢复逻辑绝不允许各写一遍。）
   * @param {object|null} last
   * @returns {{ tabId: string, url: string } | null}
   */
    _restoreClosedEntry(last?: ClosedTabEntry) : { tabId: string, url: string } | null {
    if (!last) return null

    const u = last.url
    // 统一走 _makeTabRecord：补齐 spaceId / lastActivated / incognito 等字段。
    // 手写对象曾缺 spaceId（切空间时 destroySpaceTabs 匹配不到 → webContents 泄漏）
    // 与 lastActivated（休眠规则按 0 处理 → 下一个 60s tick 被秒睡 → 整页重载）。
    const tab = this._makeTabRecord({
      url: u,
      title: last.title || '',
      pinned: last.pinned,
      stackId: last.stackId && this._stacks.has(last.stackId) ? last.stackId : null
    })
    const newId = tab.tabId
    // 撤销关闭同样守不变式：原固定分组已不存在 → 落回默认固定组，
    // 绝不把「撤销关闭」的固定标签恢复成一根裸露的标签。
    if (tab.pinned) tab.stackId = tabLayout.pinnedStackIdForNewTab(layoutHostOf(this), { stackId: tab.stackId })

    // C16: 还原到原位置（不是追加到末尾）——只写 position，不重建 Map。
    // 插回下标的夹取规则（含负数/NaN 防御）收在 domain-tabs#undoInsertIndex，有单测。
    // ⚠ 有序表必须限定在**该记录所属空间**：close() 存进撤销栈的 index 就是空间内序号，
    //   这里若用全局表，多空间下"恢复关闭的标签"会插到错误位置（甚至别的空间中间）。
    const ordered = this._orderedEntriesInSpace(tab.profileId, tab.spaceId)
    const insertAt = this._tabRules.undoInsertIndex(last.index, ordered.length)
    const before = insertAt > 0 ? Number(ordered[insertAt - 1][1].position) || 0 : null
    const after = insertAt < ordered.length ? Number(ordered[insertAt][1].position) || 0 : null
    if (before == null) tab.position = after == null ? 0 : after - 1
    else if (after == null) tab.position = before + 1
    else tab.position = (before + after) / 2
    this._tabs.set(newId, tab)

    const view = this._wcm.createTab(newId)
    this._bindTabEvents(newId)
    // 对齐 RT：先显示标签再异步加载 URL（"先显示再加载"），绝不 await loadURL。
    // 之前 await 会把「恢复关闭的标签」整条路径阻塞到页面加载完成，界面冻结。
    this._showTab(newId)
    view.webContents.loadURL(u).catch(() => {})
    if (this._hooks.onTabCreated) this._hooks.onTabCreated(newId, view.webContents)
    this._scheduleEmitChanged()
    return { tabId: newId, url: u }
  }

  /**
   * 列出已关闭的标签页（**最近关闭在前**），供「撤销关闭 / 最近关闭」这类能力消费。
   *
   * 与 `undoClose` 共用同一份 `_closedTabStack`：
   *   · 栈是「先关在前、后关在后」，故这里倒序读取以得到「最近关闭在前」；
   *   · 字段严格对齐 `tabsSchemas.recentlyClosed` 的响应契约；
   *   · 对空栈 / 缺字段一律安全（缺值补默认），**永不抛错**。
   *
   * @returns {Array<{url:string, title:string, favicon:string|null, pinned:boolean, index:number, stackId:string|null, closedAt:number}>}
   */
  listRecentlyClosed() : Array<{url:string, title:string, favicon:string|null, pinned:boolean, index:number, stackId:string|null, closedAt:number}> {
    const out = []
    for (let i = this._closedTabStack.length - 1; i >= 0; i--) {
      const e = this._closedTabStack[i]
      if (!e) continue
      out.push({
        url: String(e.url || ''),
        title: String(e.title || ''),
        // 契约要求 nullable：无 favicon 时给 null，而不是空串。
        favicon: typeof e.favicon === 'string' && e.favicon ? e.favicon : null,
        pinned: Boolean(e.pinned),
        index: Number.isFinite(Number(e.index)) ? Number(e.index) : 0,
        // stackId 若对应的标签栈已被回收，则不应再暴露（契约 nullable）。
        stackId: e.stackId && this._stacks.has(e.stackId) ? e.stackId : null,
        closedAt: Number.isFinite(Number(e.closedAt)) ? Number(e.closedAt) : 0
      })
    }
    return out
  }

  /**
   * 清空已关闭标签页列表（只清撤销栈，不影响已打开的标签）。
   * 跨启动的记录也一并清掉 —— 用户点「清除」就是要"再也别列出来"。
   * @returns {{ cleared: number }} 被清掉的条数
   */
  clearRecentlyClosed() : { cleared: number } {
    const cleared = this._closedTabStack.length
    if (cleared > 0) {
      this._closedTabStack = []
      this._notifyClosedStackChanged()
    }
    return { cleared }
  }

  /**
   * 当前窗口的标签总数（含全部空间 / 固定分组）。
   *
   * 与 `countCloseTargets` 的分工：那条数的是「关其他 / 关右侧」会关几个；
   * 这一条款数的是「关掉整个窗口」会关几个 —— 后者不受空间作用域限制
   * （窗口关闭会带走本窗口的全部标签），因此直接数表。
   *
   * @returns {number}
   */
  countTabs() : number {
    return this._tabs.size
  }

  /**
   * 预演「关闭其他 / 关闭右侧」会关掉多少个标签 —— 确认闸门（tabs.confirm_close_multiple）
   * 的判据。
   *
   * 为什么要有这一个方法：设置说的是「关闭**多个**标签前确认」，所以必须先知道
   * 这次到底会关几个（关一个不该打扰用户）。而"关谁"是领域规则（含固定标签豁免、
   * 空间作用域），**不能**在 IPC 层再推断一遍 —— 那会与 closeOthers/closeRight
   * 的实际行为分叉。这里与那两个方法共用同一份 `_tabRules` 输入，保证
   * 「数出来的」与「真关掉的」逐条一致。
   *
   * @param {'others'|'right'} mode
   * @param {string} tabId 作为基准的那个标签
   * @returns {number} 将被关闭的标签条数（基准标签不存在时为 0）
   */
    countCloseTargets(mode: string, tabId: string) : number {
    const id = String(tabId)
    const t = this._tabs.get(id)
    if (!t) return 0
    const input = this._ruleInput({ profileId: t.profileId, spaceId: t.spaceId })
    const ids = mode === 'right'
      ? this._tabRules.rightToClose(input, id)
      : this._tabRules.othersToClose(input, id)
    return ids.length
  }

    closeOthers(tabId: string) {
    const id = String(tabId)
    const t = this._tabs.get(id)
    if (!t) return { closed: 0 }
    // 「关谁」是领域规则（含固定标签豁免），执行仍在本地。
    // 规则输入限定在**本标签所属空间**：标签条是空间作用域，"关其他"绝不能波及别的空间
    // （历史上用全局输入 → 一点"关闭其他标签页"会把其他空间的标签也删掉）。
    const ids = this._tabRules.othersToClose(
      this._ruleInput({ profileId: t.profileId, spaceId: t.spaceId }), id
    )
    // 批量折叠：N 次 close 只派发一次（close 本身已是立即派发，见 `_withEmitBatch`）。
    this._withEmitBatch(() => {
      for (const x of ids) this.close(x)
    })
    return { closed: ids.length }
  }

    closeRight(tabId: string) {
    const id = String(tabId)
    const t = this._tabs.get(id)
    if (!t) return { closed: 0 }
    // 同 closeOthers：只在**本标签所属空间**内取"右侧"，绝不含别的空间。
    const toClose = this._tabRules.rightToClose(
      this._ruleInput({ profileId: t.profileId, spaceId: t.spaceId }), id
    )
    // 同 closeOthers：批量折叠成一次派发。
    this._withEmitBatch(() => {
      for (const x of toClose) this.close(x)
    })
    return { closed: toClose.length }
  }

  /**
   * 固定 / 取消固定 —— **固定 = 加入固定分组**（Zen Essentials 语义）。
   *
   * 不变式：`pinned ⟺ 属于一个 pinned 标签栈`。固定标签的全部行为都由「它属于哪个
   * 固定文件夹」推导，不再是一个孤立布尔位：
   *   1. **永远排在标签条最前** —— `_orderedEntries()` 的排序键；
   *   2. **不会被自动清理** —— 不参与休眠 / 自动归档 / 会话裁撤；
   *   3. **常驻单体** —— 不参与分屏（入组即退分屏）；
   *   4. **在标签栏里是一个可折叠的组** —— 复用标签栈的芯片 / 组行 / 改名 / 折叠。
   *
   * 固定：进第一个固定组；一个都没有就建默认「固定标签」组（见 tabLayout#addTabToPinnedGroup）。
   * 取消固定：退出所属固定组（组内其它成员原地不动，空组被回收）。
   * @param {string} tabId
   * @returns {{ tabId: string, pinned: boolean, stackId?: string|null }}
   */
    togglePin(tabId: string) : { tabId: string, pinned: boolean, stackId?: string|null } {
    const id = String(tabId)
    const t = this._tabs.get(id)
    if (!t) throw new Error(`Missing tab: ${id}`)
    if (t.pinned) {
      // 取消固定只有一个出口（tabLayout#unpinTab）：它同时负责出栈 + 回收空组，
      // 走普通 setTabStack 会被种类裁决拒绝（那正是"拖拽/菜单误调即静默取消固定"的防线）。
      tabLayout.unpinTab(layoutHostOf(this), { tabId: id })
      return { tabId: id, pinned: false }
    }
    const placed = tabLayout.addTabToPinnedGroup(layoutHostOf(this), { tabId: id })
    this._scheduleEmitChanged()
    return { tabId: id, pinned: true, stackId: placed.stackId }
  }

  /** 把一个标签放进固定分组（「固定到新分组」等入口用它；不传 stackId 即进默认组）。 */
    addTabToPinnedGroup(opts: TabManagerOptionsUpdate = {}) {
    return tabLayout.addTabToPinnedGroup(layoutHostOf(this), opts)
  }

  /** 取一个固定分组（固定面板 / 菜单用它决定「固定到哪个文件夹」）。 */
    findPinnedStack(opts: TabManagerOptionsUpdate = {}) {
    return tabLayout.findPinnedStack(layoutHostOf(this), opts)
  }

  /** 收编旧会话遗留的「游离固定标签」→ 并入默认固定组（启动恢复后调用一次）。 */
  adoptLoosePinnedTabs() {
    return tabLayout.adoptLoosePinnedTabs(layoutHostOf(this))
  }

  /**
   * 切换标签静音状态
   * 对齐 Hira：调用 webContents.setAudioMuted，同步更新标签状态
   *
   * ⚠ **休眠标签只改记录位、不建视图**（曾用 `createTab`，那会对没有视图的标签
   * **凭空造一个 WebContentsView** —— 点一下静音就多一个渲染进程，而且它绕过了
   * `_wakeInternal`，造出来的视图不还原导航历史、不重绑事件）。唤醒时静音会被补上
   * （`tabLifecycle.wakeInternal` 里那句 `setAudioMuted`），所以记录位就是唯一真源。
   * @param {string} tabId
   * @returns {{ tabId: string, muted: boolean }}
   */
    toggleMute(tabId: string) : { tabId: string, muted: boolean } {
    const id = String(tabId)
    const t = this._tabs.get(id)
    if (!t) throw new Error(`Missing tab: ${id}`)
    t.muted = !t.muted
    // 只对**已存在**的视图生效（getTab 不会创建）—— 休眠标签等下一条注释里的唤醒去补
    try {
      const view = this._wcm.getTab(id)
      if (view && view.webContents && !view.webContents.isDestroyed()) {
        view.webContents.setAudioMuted(t.muted)
      }
    } catch (e) {
      console.error('[tab] setAudioMuted failed:', errorMessage(e))
    }
    this._scheduleEmitChanged()
    return { tabId: id, muted: t.muted }
  }

  /**
   * 周期性自动刷新（C7）：让某个标签每隔 N 毫秒自动重载一次（盯盘 / 抢票 / 看后台状态）。
   *
   * ── 为什么计时器住在 TabManager ────────────────────────────────────
   * 它是**标签的属性**：标签关闭 / 休眠 / 销毁都必须让它一起停 —— 而这些收尾点
   * 全在 TabManager 里（见 close 的清理）。放在别处就必然多一处"忘了停表"的漏，
   * 表现是"关掉的标签还在后台不停重载"（用户看不见、却一直在耗流量）。
   *
   * ── 与休眠的关系 ────────────────────────────────────────────────
   * 休眠标签的 webContents 已被释放、重载会被唤醒 —— 那正是"定时刷新"的本意
   * （用户要的就是"我回来时它是新的"），故不做特殊处理。
   *
   * @param {string} tabId
   * @param {number} intervalMs 0 = 关闭定时刷新
   * @returns {{ tabId: string, autoRefreshMs: number }}
   */
    setAutoRefresh(tabId: string, intervalMs: number) : { tabId: string, autoRefreshMs: number } {
    return this._autoRefresh.set(tabId, intervalMs)
  }

    getAutoRefresh(tabId: string) {
    return this._autoRefresh.intervalOf(tabId)
  }

    _clearAutoRefresh(tabId: string) {
    return this._autoRefresh.clear(tabId)
  }

    _reloadForAutoRefresh(tabId: string) {
    this._autoRefresh.reload(tabId)
  }

  /** 复制标签：在原标签后创建一个同 URL 的新标签 */
  async duplicate(tabId: string) {
    const id = String(tabId)
    const t = this._tabs.get(id)
    if (!t) throw new Error(`Missing tab: ${id}`)
    // 种类裁决（真源 tab-policy#canDuplicate）：固定标签不提供「复制」。
    // 复制品必然是**普通**标签（`pinned: false`、不属于任何固定文件夹），用户按下
    // 「复制」却得到一条散标签 —— 那不是"复制一个固定标签"，而是悄悄换了个种类。
    // 菜单已隐藏该项；这里再拦一道，兜住插件 API / 旧动作串这些第二条入口。
    if (!canDuplicate(t)) throw new Error(`duplicate: unsupported kind (${t.pinned ? 'pinned' : 'normal'})`)
    // 统一走 _makeTabRecord：复制标签必须继承 spaceId / profileId / incognito，
    // 且要有 lastActivated（否则被休眠规则当成「极其陈旧」→ 秒睡 → 整页重载）。
    const newTab = this._makeTabRecord({
      url: t.url,
      title: t.title || '',
      pinned: false,
      spaceId: t.spaceId,
      profileId: t.profileId,
      incognito: t.incognito,
      incognitoPartitionId: t.incognitoPartitionId
    })
    const newId = newTab.tabId
    // 紧跟源标签之后（对齐 RT `sourceTab.position + 0.5`）——只写 position，不重建 Map。
    newTab.position = (Number(t.position) || 0) + 0.5
    this._tabs.set(newId, newTab)
    this.normalizePositions()

    const view = this._wcm.createTab(newId)
    this._bindTabEvents(newId)
    this._showTab(newId)
    if (this._hooks.onTabCreated) {
      try { this._hooks.onTabCreated(newId, view.webContents) } catch (e) {
        console.error('[ext] addTab failed:', errorMessage(e))
      }
    }
    this._scheduleEmitChanged()
    view.webContents.loadURL(t.url).catch(() => {})
    return { tabId: newId, url: t.url }
  }

    canGoBack(tabId: string) {
    const id = tabId ? String(tabId) : this.getActiveTabId()
    if (!id) return false
    return this._liveStateOf(id).canGoBack
  }

    canGoForward(tabId: string) {
    const id = tabId ? String(tabId) : this.getActiveTabId()
    if (!id) return false
    return this._liveStateOf(id).canGoForward
  }

  /**
   * 后退 / 前进。
   *
   * 休眠标签的可用性来自导航快照，用户激活它时也必须能执行同一个动作。
   * 因此这里唤醒并还原历史后再导航；若拒绝唤醒，界面会先显示可点、随后静默无效。
   */
    goBack(tabId: string) {
    const id = tabId ? String(tabId) : this.getActiveTabId()
    if (!id) throw new Error('No active tab')
    const sleeping = this._wcm.isTabSleeping(id)
    const view = sleeping ? this._wakeInternal(id) : this._wcm.createTab(id)
    if (!view) return { ok: false }
    if (sleeping && this._layout.getActiveTabId() === id) this._layout.showTab(id)
    return { ok: navigateWebHistory(view.webContents, 'back') }
  }

    goForward(tabId: string) {
    const id = tabId ? String(tabId) : this.getActiveTabId()
    if (!id) throw new Error('No active tab')
    const sleeping = this._wcm.isTabSleeping(id)
    const view = sleeping ? this._wakeInternal(id) : this._wcm.createTab(id)
    if (!view) return { ok: false }
    if (sleeping && this._layout.getActiveTabId() === id) this._layout.showTab(id)
    return { ok: navigateWebHistory(view.webContents, 'forward') }
  }

  /**
   * 读取导航历史条目（右键前进/后退菜单、Ctrl 新标签跳转、Alt 预览共用）。
   *
   * ⚠ **只读**：活体标签用 `this._wcm.getTab(id)`，休眠标签用导航快照；
   * 绝不为了回答一次「历史里有什么」而创建 webContents。
   *
   * 返回形状与 Electron `navigationHistory` 对齐并补 `index`（菜单点击要靠它 goToIndex）。
   */
    getNavigationEntries(tabId: string) {
    const empty = { entries: [], activeIndex: -1, canGoBack: false, canGoForward: false }
    const id = tabId ? String(tabId) : this.getActiveTabId()
    if (!id) return empty
    if (this._wcm.isTabSleeping(id)) {
      const snapshot = this._tabs.get(id)?.preSleep
      const entries = Array.isArray(snapshot?.navHistory)
        ? snapshot.navHistory.map((entry, index) => ({
            index,
            url: String(entry?.url || ''),
            title: String(entry?.title || '')
          }))
        : []
      const activeIndex = Number(snapshot?.navHistoryIndex)
      return {
        entries,
        activeIndex: Number.isInteger(activeIndex) ? activeIndex : -1,
        canGoBack: canGoBackFromPreSleep(snapshot),
        canGoForward: canGoForwardFromPreSleep(snapshot)
      }
    }
    const view = this._wcm.getTab(id)
    const wc = view && view.webContents
    if (!wc || wc.isDestroyed?.()) return empty
    try {
      const nav = wc.navigationHistory
      if (!nav || typeof nav.getAllEntries !== 'function') {
        return empty
      }
      const entries = nav.getAllEntries().map((e, i) => ({
        index: i,
        url: String(e?.url || ''),
        title: String(e?.title || '')
      }))
      const activeIndex = Number(nav.getActiveIndex())
      return {
        entries,
        activeIndex: Number.isInteger(activeIndex) ? activeIndex : -1,
        canGoBack: !!nav.canGoBack(),
        canGoForward: !!nav.canGoForward()
      }
    } catch (_) {
      return empty
    }
  }

  /** 跳到导航历史里的指定条目（右键菜单选中项）。休眠标签先按快照唤醒。 */
    goToIndex(tabId: string, index: number) {
    const id = tabId ? String(tabId) : this.getActiveTabId()
    if (!id) throw new Error('No active tab')
    if (!Number.isInteger(index) || index < 0) return { ok: false }
    const sleeping = this._wcm.isTabSleeping(id)
    const view = sleeping ? this._wakeInternal(id) : this._wcm.getTab(id)
    const wc = view && view.webContents
    if (!wc || wc.isDestroyed?.()) return { ok: false }
    if (sleeping && this._layout.getActiveTabId() === id) this._layout.showTab(id)
    try {
      const nav = wc.navigationHistory
      if (!nav || typeof nav.goToIndex !== 'function') return { ok: false }
      if (index >= nav.length?.()) return { ok: false }
      nav.goToIndex(index)
      return { ok: true }
    } catch (_) {
      return { ok: false }
    }
  }

  /**
   * 重新加载。
   *
   * ⚠ 休眠标签走**唤醒**（`_wakeInternal`）而不是 `createTab`：唤醒本身就是"按 URL
   * 重新加载这一页"（`tabLifecycle.wakeInternal` 里 restore 快照 / 回退 loadURL），
   * 正是"刷新"的本意；而且顺带把导航历史、事件绑定、静音位一起补回来。
   * 原来那条 `createTab().reload()` 会造出一个**绕过唤醒流程**的视图，
   * 且紧接着的 reload 与唤醒的首次加载会互相打断。
   */
    reload(tabId: string) {
    return this._reloadTab(tabId, false)
  }

  /** 强制重新加载（Ctrl+Shift+R）：与 reload 同一条语义，只是普通页忽略缓存。 */
    forceReload(tabId: string) {
    return this._reloadTab(tabId, true)
  }

  /**
   * 刷新的**唯一实现**（reload / forceReload 共用）。
   * 错误页是**过渡视图**：此刻 `wc.getURL()` 是 `hira://error?...`，直接 reload 只会
   * 把错误页再加载一遍（网络已恢复也回不去）。刷新应当重试**失败的原网址** ——
   * 判据与动作统一在 page-reload，绝不在这里另写一份。
   * @param {string} [tabId]
   * @param {boolean} ignoreCache
   */
    _reloadTab(tabId: string, ignoreCache: boolean) {
    const id = tabId ? String(tabId) : this.getActiveTabId()
    if (!id) throw new Error('No active tab')
    if (this._wcm.isTabSleeping(id)) {
      this._wakeInternal(id)
      return { ok: true }
    }
    const view = this._wcm.createTab(id)
    const t = this._tabs.get(id)
    const retryUrl = retryUrlOf(view.webContents, t && t.error ? t.error.url : '')
    if (retryUrl) {
      // 复用 navigate：URL 归一化 / PDF 分流 / t.url 投影 / 导航事件全部走同一条链。
      // 不 await —— 与 navigate 的「发起即返回」口径一致（见该方法的说明）。
      this.navigate({ tabId: id, url: retryUrl }).catch(() => {})
      return { ok: true, retryUrl }
    }
    if (ignoreCache) view.webContents.reloadIgnoringCache()
    else view.webContents.reload()
    return { ok: true }
  }

  /**
   * 中止当前加载 —— 刷新按钮在「加载中」形态下的动作
   * （对齐 Hira `navigationButtons`：loading 时刷新键变停止键）。
   *
   * 与 reload 同构；区别只在「休眠标签直接返回」：它没有在加载的页面，也没有视图可中止，
   * 不该为了喊停而把标签唤醒。Chromium 的 stop() 对未加载中的页面本就是无害空操作。
   */
    stop(tabId: string) {
    const id = tabId ? String(tabId) : this.getActiveTabId()
    if (!id) throw new Error('No active tab')
    if (this._wcm.isTabSleeping(id)) return { ok: true }
    this._wcm.createTab(id).webContents.stop()
    return { ok: true }
  }

  /**
   * 命令面板（地址栏踏板）动作派发 —— **加命令只改这里一处**。
   *
   * 「打开内部页面」的动作是**数据驱动**的：`action → hira://<host>` 只在这张表里定义一次。
   * 键与 host **分开写**而不是靠字符串替换 —— `open_clear_data` 机械替换会得到 `clear_data`，
   * 而页面 host 是 `clear-data`（连字符），拼不上就静默打开一个错误页。
   * 需要「窗口」语义的动作留在 switch 里（infra 不认识窗口对象，交给 APPS 注入的 hook）。
   *
   * 表内容与 `ui/ui-searchbar/src/suggestors/pedals.js` 的 action 一一对应。
   */
  async omniboxAction(action: string): Promise<{ ok: boolean; reason?: string }> {
    // 命令表是**唯一真源**（`packages/shared-types/src/commands`）：
    // 带 `page` 的命令开对应内部页（`commandUrl` 已把 `hira://` 前缀与可选 `?tab=…`
    // 深链一并拼好），不再在本文件维护 `action → host` 映射表、也不自己拼前缀。
    const url = commandUrl(action)
    if (url) { await this.newTab({ url }); return { ok: true } }

    /**
     * 命令链（D2）：`chain:<id>` 是**地址栏建议**与**手势映射**共同的写法。
     * infra 只负责剥前缀 + 转交宿主（`_hooks.onRunCommandChain`）——
     * 链是什么、有哪些步骤、怎么执行，全是 APPS 层的事。
     */
    if (typeof action === 'string' && action.startsWith('chain:')) {
      const chainId = action.slice('chain:'.length)
      if (chainId && typeof this._hooks.onRunCommandChain === 'function') this._hooks.onRunCommandChain(chainId)
      return { ok: true }
    }

    /**
     * 侧栏面板：`panel:<id>`（地址栏 `!面板名` 的落点）。
     *
     * 面板目录是**插件贡献**（`panel-catalog`），infra 不认识它；这里只剥前缀 + 转交宿主
     * （`_hooks.onOpenPanel`）—— 与上面的 `chain:` 同一条原则：谁认识这个领域，谁去执行。
     */
    if (typeof action === 'string' && action.startsWith('panel:')) {
      const panelId = action.slice('panel:'.length)
      if (panelId && typeof this._hooks.onOpenPanel === 'function') this._hooks.onOpenPanel(panelId)
      return { ok: true }
    }

    /**
     * 集锦动作：`note:<action>`（地址栏 `!添加此页到集锦` 的落点）。
     *
     * 与 `chain:` / `panel:` 同一条原则：infra 只剥前缀 + 转交宿主
     * （`_hooks.onNoteAction`）—— 集锦域、面板、标签全在 APPS 层，
     * 这里写死任何一条 `note:*` 都会变成"加一个动作改两处"。
     */
    if (typeof action === 'string' && action.startsWith('note:')) {
      if (typeof this._hooks.onNoteAction === 'function') this._hooks.onNoteAction(action, {})
      return { ok: true }
    }

    switch (action) {
      case 'open_new_window':
        // 窗口级动作由 APPS 层注入的 hook 承接（infra 不认识「窗口」这个领域对象）。
        // 未注入时保持原有的空操作语义 —— 与加入本分支之前一致。
        if (typeof this._hooks.onOpenNewWindow === 'function') this._hooks.onOpenNewWindow()
        break
      case 'open_incognito_window':
        if (typeof this._hooks.onOpenNewWindow === 'function') this._hooks.onOpenNewWindow({ incognito: true })
        break
      case 'open_incognito_tab':
        await this.newIncognitoTab({})
        break
      // 浏览器操作（导航类）：作用于**活动标签**（与快捷键 `tab:back` / `tab:forward` /
      // `tab:reload` 落到同一个方法，行为一字不差）。地址栏 `!back` / `!刷新` 走这里。
      case 'go_back': {
        const id = this.getActiveTabId()
        if (id) this.goBack(id)
        break
      }
      case 'go_forward': {
        const id = this.getActiveTabId()
        if (id) this.goForward(id)
        break
      }
      case 'reload_page': {
        const id = this.getActiveTabId()
        if (id) this.reload(id)
        break
      }
      // 截图（J7）：地址栏命令。取图 / 标注 / 交付都由 APPS 层注入的 hook 完成（infra 不认识截图与标注）。
      case 'capture_page': {
        if (typeof this._hooks.onCapturePage !== 'function') break
        const activeId = this.getActiveTabId()
        const view = activeId && typeof this._wcm.getTab === 'function' ? this._wcm.getTab(activeId) : null
        await this._hooks.onCapturePage({
          tabId: activeId,
          webContents: view && view.webContents ? view.webContents : null,
          mode: 'fullpage'
        })
        break
      }
      case 'open_capture_hub': {
        if (typeof this._hooks.onOpenCaptureHub === 'function') this._hooks.onOpenCaptureHub()
        break
      }
      case 'archive_current': {
        if (typeof this._hooks.onArchiveCurrent !== 'function') {
          return { ok: false, reason: '归档服务不可用' }
        }
        const result = await this._hooks.onArchiveCurrent()
        if (result && typeof result === 'object') {
          const row = result as { ok?: unknown; reason?: unknown }
          return {
            ok: row.ok !== false,
            ...(row.reason ? { reason: String(row.reason) } : {})
          }
        }
        return { ok: true }
      }
      case 'focus_address_bar': {
        if (typeof this._hooks.onFocusAddressBar === 'function') this._hooks.onFocusAddressBar()
        break
      }
    }
    return { ok: true }
  }

  /** 切换到下一个标签（限定在**当前空间**内循环 —— 标签条是空间作用域，绝不跨空间） */
  nextTab() {
    const ids = this._currentSpaceTabIds()
    const active = this.getActiveTabId()
    if (!active) return
    const idx = ids.indexOf(active)
    if (idx === -1 || ids.length <= 1) return
    const next = ids[(idx + 1) % ids.length]
    this.switchTo(next)
  }

  /** 切换到上一个标签（限定在当前空间内循环） */
  prevTab() {
    const ids = this._currentSpaceTabIds()
    const active = this.getActiveTabId()
    if (!active) return
    const idx = ids.indexOf(active)
    if (idx === -1 || ids.length <= 1) return
    const prev = ids[(idx - 1 + ids.length) % ids.length]
    this.switchTo(prev)
  }

  /**
   * 校验事件来源的 webContents 是否仍是该 tab 当前的 view（代际校验）。
   * 防止休眠/销毁后旧 view 的迟到事件污染 tab 状态。
   * @param {string} tabId
   * @param {Electron.WebContents} wc
   * @returns {boolean}
   */
    _isCurrentWc(tabId: string, wc: WebContents) : boolean {
    const view = this._wcm.getTab(tabId)
    return !!(view && view.webContents === wc)
  }

  _emitTabChanged() {
    this._changeEmitter.flush()
  }

    _scheduleEmitChanged(options: { layout?: boolean } = {}) {
    this._changeEmitter.schedule(options)
  }

  _emitNow() {
    this._changeEmitter.emitNow()
  }

    _withEmitBatch(fn: () => unknown) {
    return this._changeEmitter.withBatch(fn)
  }

  cancelScheduledEmit() {
    this._changeEmitter.cancel()
  }

  /** 窗口级收尾：停掉所有定时刷新与尚未提交的变更合批。 */
  dispose() {
    this._autoRefresh.clearAll()
    this.cancelScheduledEmit()
  }

    _bindTabEvents(tabId: string) {
    // 全部 webContents 事件接线（window.open / 右键菜单 / 音频 /
    // URL 同步 / PDF 拦截 / 标题 / favicon / 加载态 / 导航失败 / 崩溃）已抽到
    // tabEvents.js。本类只保留"标签集合"职责，新增 webContents 事件不再改这个文件。
    bindTabEvents(eventsHostOf(this), tabId)
  }
}

interface TabManager {
  _syncActiveSplit(tabId: string | null): unknown
  _removeTabFromSplit(tabId: string): unknown
  _removeTabFromGlance(tabId: string): unknown
  _splitSuccessorAfterClose(splitId: string, closedTabId: string): string | null
}

export { TabManager }
