/**
 * 浏览器窗口装配 —— 「开一个完整浏览器窗口」的可复制单元（多窗口第四步的基座）。
 *
 * ── 为什么需要它 ──────────────────────────────────────────────────
 * 前三步已经把「按窗口的状态」拆干净了：
 *   window-chrome.js            → 浮层 / 密码浮层按窗口
 *   browser-window-runtime.js   → TabManager + hooks + PiP 按窗口
 *   window-runtime-registry.js  → IPC 按发送方解析到对应窗口
 * 但 main.js 里这些片段的**装配顺序**仍是一条直线代码，只能在启动时跑一次。
 * 要开第二个窗口，必须把这条直线变成可重复调用的函数。
 *
 * ── 两阶段：open() 与 mount() ────────────────────────────────────
 * 现实约束：主窗口必须**在共享服务之前**建出来（会话/扩展/数据库都要先有窗口
 * 作为宿主），而 js-dialog / keybindings / ui-shell 加载又必须在服务之后。
 * 因此装配天然分两段，且**这个顺序不能合并**：
 *
 *   open()   早段：建窗口 → 窗口 chrome → 标签运行单元 → 注册运行单元
 *   mount()  晚段：标签事件转发 → js-dialog → 快捷键 → ui-shell/rail 加载 → 插件
 *
 * 第二个窗口（`browser:create-window`）在共享服务已就绪后再开，
 * 因此 open() 之后立即 mount()（见 openAndMount）。
 *
 * ── shared 为什么是「可变对象」而不是参数列表 ─────────────────────
 * main.js 的共享服务是**逐步构造**的（favicon → bookmark → history → … → settings），
 * 而本模块晚段要用到其中大部分。若把它们作为参数传入，就要么踩 const 的 TDZ，
 * 要么造出 20 个 getter。shared 是一个可变对象，main.js 边构造边回填 ——
 * 与本仓库既有的「延迟端口」口径一致（见 main.js 顶部 extensionOptionsPort 注释）。
 *
 * ── 本模块不认识的领域 ───────────────────────────────────────────
 * 不知道 settings / bookmark / history / 会话恢复是谁 —— 那些由 main.js 在
 * shared.restoreWindowSession / shared.bootstrapWindowPlugins 里注入。
 * 本模块只负责「窗口」这件事本身。
 */

import type {
  BrowserWindow,
  ContextMenuParams,
  Event as ElectronEvent,
  Rectangle,
  Session,
  WebContents,
  WebPreferences
} from 'electron'
import {
  createMainWindow,
  type ContextMenuSnapshot,
  type LayoutCoordinator,
  type WebContentsManager,
  type WindowRegistry
} from '@hira-ng/infra-window'
import { createBrowserWindowRuntime } from './browser-window-runtime'
import { createJsDialogManager } from './js-dialog'
import { createPanelViewFactory, type PanelCatalogLike, type PanelViewDeps } from './panel-views'
import { createWebSidebar } from './web-sidebar'
import { createWindowChrome } from './window-chrome'
import { createWindowControlsPolicy } from './window-controls-policy'
const { nativeTheme } = require('electron')
// 浮层事件通道的真源（落位预览要推 `dropzone-overlay:update`，不手写字符串）。
const { IPC_EVENTS } = require('@hira-ng/shared-types/src/ipc-channels.mjs')
// 菜单快捷键提示的唯一真源（动作名 → 键位 id → 当前组合串 → Electron accelerator）。
const { menuAccelerator } = require('@hira-ng/shared-types/src/keybindings.mjs')
// 「算不算普通网页」的唯一判据（收藏 / 收进集锦四项菜单的可用性共用）。
const { isHttpUrl } = require('@hira-ng/shared-types/src/url-protocols.mjs')
// WCO：判定 / 建窗参数 / 主题同步的唯一实现（PWA 应用窗共用同一份）。
// 独立侧栏（Web Sidebar）：远程网页住的第三块区域（与面板完全平行的一套系统）。
// 子窗口类型枚举（侧栏收藏 → add/edit-bookmark；与 main.js 走同一份枚举，不写字符串字面量）
const { WINDOW_TYPES } = require('./window-config')
const { normalizeSidebarUrl } = require('@hira-ng/shared-types/src/web-sidebar.mjs')
// 独立侧栏的持久化键名（宽度 / 位置 / 呈现模式）—— 与设置页、applier 共用同一份，
// 不在这里手抄 `app.web_sidebar_*`（抄错一处 = 关掉应用后偏好就丢）。
const { LAYOUT_SETTING_KEYS, normalizeRailPinned } = require('@hira-ng/shared-types/src/layout.mjs')
// 搜索兜底真源（服务未就绪时的 URL / 文案，不写 bing/google 字面量）。
const { defaultSearchUrl, defaultSearchLabel } = require('@hira-ng/shared-types/src/search-engines.mjs')
// 「划词 → note」的正文模板与定位 URL 来自同一真源（见 notes.mjs 的文件头"为什么必须只有一处"）。
const {
  buildSourceNoteContent,
  buildTextFragmentUrl
} = require('@hira-ng/shared-types/src/notes.mjs')
// 「收进哪个集锦」这份菜单的**唯一真源**（未归档 / 集锦列表 / 新建集锦…的顺序与文案）——
// 页面右键四项、应用菜单、标签右键、面板共用同一份描述符（见 collection-menu.mjs 的文件头）。
const {
  buildCollectionMenuEntries,
  findReadingFolderId,
  toNativeMenuItems
} = require('@hira-ng/shared-types/src/collection-menu.mjs')
// 「稍后读」是笔记里的固定文件夹（与集锦同一实体、不同落点）—— 文件夹名的唯一真源。
const { READING_LIST_FOLDER } = require('@hira-ng/shared-types/src/reading-list.mjs')
interface CollectionTarget { kind: 'reading' | 'unfiled' | 'folder' | 'new'; folderId?: string | null }
interface NoteRecord { id?: string; thumbPath?: string; [key: string]: unknown }
interface NotesServicePort {
  listFolders?(): unknown[]
  addFolder(options: { name: string }): string | { id?: string | null } | null | undefined | Promise<string | { id?: string | null } | null | undefined>
  addCaptured(payload: Record<string, unknown>): NoteRecord | null | Promise<NoteRecord | null>
  update(id: string, patch: Record<string, unknown>): unknown
}
interface NotesAssetsPort {
  capturePageThumb(webContents: WebContents): Promise<{ ok?: boolean; thumbPath?: string } | null | undefined> | { ok?: boolean; thumbPath?: string } | null | undefined
  fetchToAsset(options: { url: string; referer?: string }): Promise<{
    ok?: boolean; assetPath?: string; thumbPath?: string; assetMime?: string; assetWidth?: number; assetHeight?: number
  } | null | undefined>
}

type RuntimeDeps = Parameters<typeof createBrowserWindowRuntime>[0]
type RuntimeCore = ReturnType<typeof createBrowserWindowRuntime>
type DialogManager = ReturnType<typeof createJsDialogManager>
type PanelViewFactory = ReturnType<typeof createPanelViewFactory>
type WebSidebarInstance = ReturnType<typeof createWebSidebar>
type SnapshotService = ReturnType<RuntimeDeps['getSnapshotService']>

interface SpaceIdentity {
  profileId: string
  spaceId: string
}

type SpaceRuntimePort = RuntimeDeps['spaceRuntime']

interface WindowBounds extends Partial<Rectangle> {
  maximized?: boolean
}

interface WindowStatePort {
  bounds(): WindowBounds
  capture(win: BrowserWindow): void
  flush?(): unknown
}

interface SettingsPort {
  get(key: string): unknown
  set(key: string, value: unknown): unknown
}

interface PendingPanelDialog {
  panelId: string
  wc: WebContents
}

interface PanelViewPort {
  ensurePanelView(panelId: string): { content?: unknown; header?: unknown; headerHeight?: unknown } | null
  destroy(panelId: string): boolean
}

interface WebSidebarViewPort {
  ensureView(): unknown
  destroy(): unknown
}

interface LayoutRuntimePort {
  getActiveTabId(): string | null
  getFocusedWebBounds(): Rectangle | null
  setTabFullscreenFromWindow(): boolean
  isWebSidebarFocused(): boolean
  setPanelViewPort(port: PanelViewPort | null): void
  setWebSidebarViewPort(port: WebSidebarViewPort | null): void
  setWebSidebarSideListener(listener: (() => void) | null): void
  setWebSidebarDropPreviewPort(listener: ((rect: Rectangle | null) => void) | null): void
  setSideRevealHold(on: boolean, options?: { sourceWebContentsId?: number | null }): boolean
  togglePanel(...args: unknown[]): unknown
  attachFloatView(name: string): unknown
  isFloatVisible(name: string): boolean
  noteFloatShow(name: string, opener?: WebContents): number
  setFloatBounds(name: string, rect: Partial<Rectangle>, options?: { keepFocus?: boolean }): void
  setFloatInteractive(name: string, interactive: boolean): void
  sendToFloat(name: string, channel: string, payload: unknown, guard?: () => boolean): Promise<void>
  endShellFocusBounce(): void
  restoreContentFocus(options?: Record<string, unknown>): boolean
}

type AssemblyLayoutCoordinator = LayoutCoordinator & LayoutRuntimePort

interface RuntimeHooksPort {
  onCapturePage?(payload: Record<string, unknown>): unknown
  onPeekPreview?(payload: Record<string, unknown>): unknown
}

interface RuntimeState {
  __mounted?: boolean
  closeApproved: boolean
  closePromptPending: boolean
  ordinal: number
  incognito: boolean
  isPrimary: boolean
  spaceRuntime: SpaceRuntimePort
  sessionFileName: string | null
  showWhenReady: boolean
  pendingPanelJsDialog: PendingPanelDialog[]
  webSidebar?: WebSidebarInstance
  jsDialogManager?: DialogManager
}

type DynamicRuntimeMembers = Record<string, (...args: unknown[]) => unknown>

export type BrowserWindowRuntime = RuntimeCore & RuntimeState & {
  tabManager: RuntimeCore['tabManager'] & DynamicRuntimeMembers
  layoutCoordinator: RuntimeCore['layoutCoordinator'] & DynamicRuntimeMembers
}

interface OpenWindowOptions {
  isPrimary?: boolean
  show?: boolean
  bounds?: WindowBounds
  incognito?: boolean
  profileId?: string
  spaceId?: string
  sessionFileName?: string
  sessionResolver?: (profileId: string) => Session
  spaceRuntime?: SpaceRuntimePort
}

interface NewWindowOptions extends OpenWindowOptions {
  url?: string
  opener?: BrowserWindowRuntime | null
  focus?: boolean
  skipInitialTab?: boolean
}

interface FanoutOptions {
  fanoutMethods?: string[]
  mergedKeys?: string[]
  unionMethods?: string[]
  defaultAll?: boolean
}

interface HostMenuItem {
  label: string
  click: () => void
  submenu?: unknown
  group?: string
}

type RightClickParams = ContextMenuSnapshot

export interface KeybindingsPort {
  attach(webContents: WebContents): unknown
  getKeybindings(): Record<string, unknown>
}

interface ThemeManagerPort {
  applyToWebContents(webContents: WebContents): Promise<unknown>
}

interface BookmarkServicePort {
  getByUrl?(url: string): unknown
}

interface AutomationPort {
  runChain(id: string): unknown
  shouldSuppressContextMenu(webContents: WebContents | null | undefined): boolean
  handleTabEvent(event: {
    trigger: 'open' | 'navigate'
    tabId: string
    url: string
    title?: string
    active?: boolean
  }): unknown
}

interface NoteActionsPort {
  run(action: string, params: Record<string, unknown>): unknown
}

export interface SharedWindowContext {
  runtimeRegistry: import('./window-runtime-registry').WindowRuntimeRegistry
  windowRegistry: WindowRegistry<BrowserWindow>
  sessionsController: unknown
  windowState?: WindowStatePort | null
  tabRules: RuntimeDeps['tabRules']
  tabAdjust: RuntimeDeps['tabAdjust']
  tabStacks: RuntimeDeps['tabStacks']
  tabSplits: RuntimeDeps['tabSplits']
  tabGroups: RuntimeDeps['tabGroups']
  settingsService?: SettingsPort | null
  getPdfViewerEnabled: RuntimeDeps['getPdfViewerEnabled']
  getSplitOptions: RuntimeDeps['getSplitOptions']
  getAutoPictureInPictureEnabled: RuntimeDeps['getAutoPictureInPictureEnabled']
  getExtraTabWebPreferences(): WebPreferences
  getFaviconService: RuntimeDeps['getFaviconService']
  getHistoryService: RuntimeDeps['getHistoryService']
  getExtensionService: RuntimeDeps['getExtensionService']
  getSearchService: RuntimeDeps['getSearchService']
  getBookmarkService?(): BookmarkServicePort | null | undefined
  getSlotMenuItems?: RuntimeDeps['getSlotMenuItems']
  getSlotLifecycle?: RuntimeDeps['getSlotLifecycle']
  getUserScriptsForUrl?: RuntimeDeps['getUserScriptsForUrl']
  getPagePatchesForUrl?: RuntimeDeps['getPagePatchesForUrl']
  runAsProfile?: RuntimeDeps['runAsProfile']
  guardWindowOpen?(payload: Record<string, unknown>): boolean
  guardDownload?(payload: Record<string, unknown>): boolean
  getSafeBrowsingWarning?(url: string): string
  getWindowSpace?(source: BrowserWindowRuntime | null, options: { incognito: boolean }): Partial<SpaceIdentity> | null | undefined
  getNewTabUrl(options?: { incognito?: boolean; containerProfileId?: string | null; profileId?: string }): string
  emit: RuntimeDeps['emit']
  emitPanelSideChanged?(panelId: string, side: 'left' | 'right' | null, pinned: boolean, windowId: number): unknown
  snapshotService?: SnapshotService | null
  keybindings?: KeybindingsPort | null
  themeManager?: ThemeManagerPort | null
  openSubWindow(type: string, payload: Record<string, unknown> | undefined, runtime: BrowserWindowRuntime): unknown
  openPeekPreview?(payload: Record<string, unknown>): unknown
  getAccentThemeInfo?(options: { incognito: boolean }): unknown
  panelCatalog?: unknown
  notesService?: NotesServicePort | null
  notesAssets?: NotesAssetsPort | null
  isFeatureOn?(featureId: string): boolean
  automation?: AutomationPort | null
  noteActions?: NoteActionsPort | null
  captureHub?: {
    open(input?: {
      tabId?: string
      url?: string
      title?: string
      selection?: string
      kind?: 'page' | 'selection' | 'link' | 'image'
      referer?: string
    }): unknown
  } | null
  pageLibrary?: { archiveActive(): unknown } | null
  translatePage?(webContents: WebContents): unknown
  spatialNav?: unknown
  onWindowMounted?(runtime: BrowserWindowRuntime): unknown
  onWindowClosed?(runtime: BrowserWindowRuntime): unknown
  onWindowTabsChanged?(): unknown
  onTabClosed?(tabId: string): void
  needsWindowCloseConfirm?(tabCount: number): boolean
  confirmWindowClose(runtime: BrowserWindowRuntime): boolean | Promise<boolean>
  isQuitting?(): boolean
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error ?? '')
}

interface MainWindowHandle extends ReturnType<typeof createMainWindow> {
  webContentsManager: WebContentsManager
  layoutCoordinator: AssemblyLayoutCoordinator
}

/**
 * 网页右键菜单里"这一项要拿哪个 URL"的**唯一一份判据**（页面右键的两个宿主出口共用）。
 *
 * 规则只一条：**链接优先**。
 *   · `linkURL` 非空 = 右键落在一条链接上 → 菜单里每一项说的都是**那一条链接**
 *     （Chrome 的 "Open link in new tab" / Vivaldi 的 "Open link in web panel" 同一条口径）；
 *   · 否则（页面空白处、选区、输入框…）= "当前这个页面"，退回 `pageURL`。
 *
 * 为什么必须有这一份：同一个宿主能力在**两个**菜单出口各接了一次 ——
 * 标签页的「在侧栏打开」与侧栏自己的「在标签页打开」。两处各写一遍 `pageURL`
 * 就会双双漏掉链接（用户实测到的那条："对着链接右键，在侧栏打开还是当前页面"），
 * 而只修一处又会让两个出口对同一次右键给出不同答案。
 *
 * @param {{linkURL?: string, pageURL?: string}|null} params 右键参数快照（infra#snapshotParams）
 * @returns {string} 目标 URL（都拿不到 = 空串）
 */
function contextMenuTargetUrl(params: { linkURL?: string; pageURL?: string } | null | undefined): string {
  if (!params) return ''
  const raw = params.linkURL || params.pageURL
  return raw ? String(raw) : ''
}

/**
 * 「添加此页/此图/所选文字/此链接到集锦」四项共用的一份**落点解析**：
 * 用户从子菜单里选的那个目标（`{kind:'reading'|'unfiled'|'folder'|'new', folderId}`）→ 真正的 `folderId`。
 *
 *   · `reading` → 「稍后读」文件夹的 id（没有就建一个 —— 它就是一个普通文件夹）；
 *   · `unfiled` → **null**（域层 `addCaptured` 的"根级 / 未归档"那一态，绝不传 undefined）；
 *   · `folder`  → 该集锦 id；
 *   · `new`     → 按调用方给的标题建一个新集锦再用它（**已知限制**：原生菜单收不了文本输入，
 *     所以只能用页面标题当名字，用户随后可在面板里改名）。
 *
 * ⚠ 这套「未归档 / 集锦列表 / 新建集锦…」的**选项与顺序**来自共享真源
 *   `shared-types/src/collection-menu.mjs` —— 与标签右键、应用菜单、面板是同一份描述符，
 *   四个入口因此不可能各排一套（正是"两处各写一遍必然漂移"那条老账）。
 *
 * @param {object} notesService 域服务
 * @param {{kind:'reading'|'unfiled'|'folder'|'new', folderId:string|null}|null} target 子菜单选中的目标
 * @param {string} [titleForNew] 「新建集锦…」时用它的名字
 * @returns {Promise<string|null>} 落点 folderId（null = 未归档）
 */
async function resolveCollectionFolderId(notesService: NotesServicePort | null | undefined, target: CollectionTarget | null | undefined, titleForNew?: string): Promise<string | null> {
  if (!notesService || !target) return null
  if (target.kind === 'folder') return target.folderId || null
  if (target.kind === 'reading') {
    try {
      // 「稍后读」是固定文件夹：已有就用，没有才建（判定与标签右键 / 选择器共用一份）。
      const rows = typeof notesService.listFolders === 'function' ? notesService.listFolders() : []
      const existing = findReadingFolderId(rows)
      if (existing) return existing
      const created = await notesService.addFolder({ name: READING_LIST_FOLDER })
      return typeof created === 'string' ? created : created?.id || null
    } catch (_) {
      return null
    }
  }
  if (target.kind === 'new') {
    const name = String(titleForNew || '').trim() || '新集锦'
    try {
      // addFolder 直接返回新文件夹 id（字符串）——域侧契约，不在这里再包一层。
      const created = await notesService.addFolder({ name })
      return typeof created === 'string' ? created : created?.id || null
    } catch (_) {
      return null
    }
  }
  return null
}

/**
 * 把一张卡收进**选定**的集锦（`target` 说落点）。返回落库后的卡（失败回 null）。
 * @param {object} notesService
 * @param {object} payload addCaptured 的入参（kind/url/title/…）
 * @param {{kind:'reading'|'unfiled'|'folder'|'new', folderId:string|null}|null} target 子菜单选中的目标
 * @param {string} [titleForNew] 「新建集锦…」的取名依据
 */
async function captureIntoCollection(notesService: NotesServicePort | null | undefined, payload: Record<string, unknown> | null | undefined, target: CollectionTarget | null | undefined, titleForNew?: string): Promise<NoteRecord | null> {
  if (!notesService || !payload) return null
  const folderId = await resolveCollectionFolderId(notesService, target, titleForNew)
  return notesService.addCaptured({ ...payload, folderId })
}

/**
 * 页面右键「添加此页到集锦 ▸ <目标>」：把**页面**收进选定的集锦。
 *
 * ── 为什么是**主进程直落库**（不是渲染层的集锦选择器）────────────────────
 * 页面右键菜单由**主进程**构建（infra-window#context-menu.js 的 getHostMenuItems），
 * 而"主进程 → 外壳渲染层"这条线上**没有**一条通用动作通道：外壳只认 `overlay:commit`
 * 的几个既有 kind（searchbar / permission / space-* …），新的 kind 会在外壳里静默落空；
 * 而新增事件要同时改 ipc-channels.mjs 与外壳处理器。故**选完集锦直接在主进程落库** ——
 * 面板经 `note:changed` 广播自行刷新。
 *
 * ⚠ `webview.context-menu.item` 那条官方插槽（MULTI）是给**插件**用的；本项是内置项，
 *   故走宿主自己的 `getHostMenuItems` 通道（与「在侧栏打开」同一处）。
 *
 * @param {object} notesService 域服务（main.js 回填到 shared；缺失则整项不出现）
 * @param {object} notesAssets 资产服务（抓缩略图）
 * @param {{kind:string, folderId:string|null}} target 子菜单选中的目标
 * @param {{url:string, title?:string, sourceTitle?:string, webContents?:any}} input
 */
export async function capturePageIntoCollection(
  notesService: NotesServicePort | null | undefined,
  notesAssets: NotesAssetsPort | null | undefined,
  target: CollectionTarget | null | undefined,
  input: { url: string; title?: string; sourceTitle?: string; webContents?: WebContents | null } = { url: '' }
) {
  const url = String(input.url || '')
  if (!notesService || !url) return null
  const title = input.title ? String(input.title) : url
  const note = await captureIntoCollection(notesService, {
    kind: 'page',
    url,
    title,
    ...(input.sourceTitle ? { sourceTitle: String(input.sourceTitle) } : {})
  }, target, title)
  // 缩略图**异步回填**（不阻塞落库，与 ipc/notes.js#fillPageThumb 同一口径）：
  // 这里手里直接有被右键那一页的 webContents —— 它就是画面来源，**不再按 URL 去反查**
  //（反查是"再猜一次"，与主进程权威判据一旦分叉就会抓到别的标签）。
  // 抓不到（页面已销毁 / 受限）就留空 → 卡片退化成无预览区，绝不报错。
  if (note && note.id && !note.thumbPath && input.webContents && notesAssets
      && typeof notesAssets.capturePageThumb === 'function') {
    const noteId = note.id
    Promise.resolve()
      .then(() => notesAssets.capturePageThumb(input.webContents as WebContents))
      .then((res) => {
        if (!res || !res.ok || !res.thumbPath) return
        return notesService.update(noteId, { thumbPath: res.thumbPath })
      })
      .catch(() => {})
  }
  return note
}

/**
 * 页面右键「添加此图到集锦 ▸ <目标>」：先按 URL 抓图落盘，再决定收成**图片卡**还是**网页卡**。
 *
 * ── 降级规则（为什么失败要退回 kind:'page'）──────────────────────────
 * 抓图可能失败（非图片 content-type / 网络错 / 超硬上限 / 大图只留缩略图）。
 * 此时**不能什么都不收** —— 用户的意图是"把这张图收进集锦"，退一步收下它的 URL
 * （kind:'page'，面板仍能点开原始链接）比"点了没反应"好得多。
 * ⚠ 大图（oversize）按产品口径同样退成 page：集锦不是图床，一条 20MB 的图不落原图、
 *   只留缩略图对用户并无价值 —— 收下 URL 更诚实。
 *
 * @param {object} notesService
 * @param {object} notesAssets 资产服务（main.js 回填到 shared）
 * @param {{kind:string, folderId:string|null}} target 子菜单选中的目标
 * @param {{ url:string, referer?:string, title?:string, sourceTitle?:string }} input
 */
export async function captureImageIntoCollection(
  notesService: NotesServicePort | null | undefined,
  notesAssets: NotesAssetsPort | null | undefined,
  target: CollectionTarget | null | undefined,
  input: { url?: string; referer?: string; title?: string; sourceTitle?: string } = {}
) {
  if (!notesService || !notesAssets) return null
  const url = String(input.url || '')
  const sourceTitle = String(input.sourceTitle || '')
  const fallbackTitle = String(input.title || sourceTitle || url)
  let asset = null
  try {
    asset = await notesAssets.fetchToAsset({ url, referer: input.referer })
  } catch (_) {
    asset = null
  }
  if (asset && asset.ok && asset.assetPath && asset.thumbPath) {
    return captureIntoCollection(notesService, {
      kind: 'image',
      url,
      title: fallbackTitle,
      sourceTitle,
      assetPath: asset.assetPath,
      assetMime: asset.assetMime,
      assetWidth: asset.assetWidth,
      assetHeight: asset.assetHeight,
      thumbPath: asset.thumbPath
    }, target, fallbackTitle)
  }
  // 降级：抓不到 / 非图片 / oversize → 当网页卡收下（见上面注释）。
  return captureIntoCollection(notesService, { kind: 'page', url, title: fallbackTitle, sourceTitle }, target, fallbackTitle)
}

/**
 * 页面右键「添加所选文字到集锦 ▸ <目标>」：选中文字收成一条**真正的 note**（不是 snippet）。
 *
 * ── 为什么是 note 而不是 snippet ─────────────────────────────────────
 * 划词进来的是"从某页摘的一段文字"，它天然就该是一条**笔记**：能编辑、能 Markdown 预览、
 * 能打标签 / 换色 / 置顶 / 拖拽排序 / 导出 —— 这些能力 note 全都有，snippet 一个都没有。
 * 早先收成 snippet 的那套渲染分支保留（老数据要能显示），但**不再产生新数据**。
 *
 * ── 落库字段 ──────────────────────────────────────────────────────────
 *   · title / sourceTitle = 页面标题（拿不到才退回所选文字前 60 字兜底）；
 *   · content = buildSourceNoteContent 拼的正文（标题 + 完整 URL + 摘录，自带出处）；
 *   · url     = buildTextFragmentUrl 拼的**定位 URL**（带 `#:~:text=`，供「跳到原文那段」）。
 * ⚠ 正文里的 URL 是**干净 URL**、url 字段是**定位 URL** —— 分工见 notes.mjs 的注释，别合并。
 */
export async function captureSelectionIntoCollection(
  notesService: NotesServicePort | null | undefined,
  target: CollectionTarget | null | undefined,
  { text, url, sourceTitle }: { text?: string; url?: string; sourceTitle?: string } = {}
) {
  if (!notesService) return null
  const content = String(text || '')
  if (!content.trim()) return null
  const pageUrl = String(url || '').trim()
  // 标题优先用**来源页标题**（一眼认出"这是从哪一页摘的"）；没有才退回摘录前 60 字。
  const srcTitle = String(sourceTitle || '').trim()
  const title = srcTitle || content.replace(/\s+/g, ' ').trim().slice(0, 60) || '网页摘录'
  return captureIntoCollection(notesService, {
    kind: 'note',
    title,
    sourceTitle: title,
    // 正文自带出处（标题 + 干净 URL + 摘录）；跳转用的定位 URL 单独放进 url 字段。
    content: buildSourceNoteContent({ title, url: pageUrl, text: content }),
    url: pageUrl ? buildTextFragmentUrl(pageUrl, content) : undefined
  }, target, title)
}

/** 页面右键「添加此链接到集锦 ▸ <目标>」：链接 URL 收成 kind:'page'（与 Edge 同一口径）。 */
export async function captureLinkIntoCollection(
  notesService: NotesServicePort | null | undefined,
  target: CollectionTarget | null | undefined,
  { url, title, sourceTitle }: { url?: string; title?: string; sourceTitle?: string } = {}
) {
  if (!notesService) return null
  const link = String(url || '')
  if (!link) return null
  const linkTitle = title ? String(title) : link
  return captureIntoCollection(notesService, {
    kind: 'page',
    url: link,
    title: linkTitle,
    sourceTitle: sourceTitle ? String(sourceTitle) : undefined
  }, target, linkTitle)
}

/**
 * @param {object} shared 可变共享上下文（main.js 逐步回填；本模块只读）
 * @param {object} shared.runtimeRegistry 窗口运行单元注册表
 * @param {object} shared.windowRegistry WindowRegistry 实例
 * @param {object} shared.sessionsController 按 profile 解析 Session
 * @param {(route:string, payload?:any, opts?:object) => number} shared.emit 事件广播出口
 * @param {object} shared.tabRules 标签领域规则端口
 * @param {object} [shared.tabAdjust]
 * @param {object} shared.tabStacks
 * @param {() => boolean} shared.getPdfViewerEnabled
 * @param {() => boolean} shared.getAutoPictureInPictureEnabled
 * @param {() => object} shared.getFaviconService
 * @param {() => object} shared.getHistoryService
 * @param {() => object} shared.getExtensionService
 * @param {() => object} shared.getSearchService
 * @param {() => object} shared.getBookmarkService 书签服务（面级命令 `bookmark` 判定
 *   "侧栏这一页已收藏还是没收藏"，据此开编辑窗 / 新增窗）
 * @param {(type:string, payload?:object, runtime?:object) => any} shared.openSubWindow
 *   打开子窗口（父窗口用发起方运行单元）
 * @param {object} shared.snapshotService
 * @param {() => object} shared.getExtraTabWebPreferences
 * @param {(profileId:string, fn:Function) => any} [shared.runAsProfile]
 *   进入某个 profile 的数据作用域执行 fn（书签/历史/下载按 profile 分区）。
 *   本窗口的标签事件（标题、favicon、导航）写库时用它声明「这是哪个用户的数据」——
 *   这些事件不是 IPC 调用，没有发送方可供解析。
 * @param {object} [shared.keybindings] 晚段：快捷键管理器
 * @param {object} [shared.themeManager] 晚段：主题应用
 * @param {(runtime:object) => void} [shared.onWindowMounted] 窗口挂载完成（每窗口一次）
 * @param {(runtime:object) => void} [shared.onWindowClosed] 窗口关闭收尾（每窗口一次）
 * @param {(runtime:object) => void} [shared.onWindowTabsChanged] 任一窗口标签变化（去抖由调用方做）
 */
export function createBrowserWindowAssembly(shared: SharedWindowContext) {
  /** 已装配的浏览器窗口运行单元（顺序 = 创建顺序）。 */
  const windows: BrowserWindowRuntime[] = []
  let primaryRuntime: BrowserWindowRuntime | null = null
  /**
   * 窗口序号：只增不减。
   *
   * 两个用途，都要求**不重用**：
   *   1. 标签 id 前缀 `w<n>t` —— 标签 id 会被进程级表（快照仓库 / 监听登记）当键用，
   *      窗口关闭后再开一个新窗口若复用同一前缀，就会撞上尚未过期（TTL 120s）的旧键；
   *   2. 窗口状态持久化的槽位键（见 window-state-store）。
   */
  let windowSeq = 0

  /**
   * 早段装配。
   *
   * @param {object} [options]
   * @param {boolean} [options.isPrimary] 是否作为 primary（解析兜底）
   * @param {boolean} [options.show]
   * @param {object} [options.bounds] 窗口几何（width/height/x/y/maximized）
   * @param {boolean} [options.incognito] 无痕窗口：本窗口所有标签默认无痕
   * @param {string} [options.sessionFileName] 本窗口的会话分片文件名（**会话恢复专用**：
   *   恢复时必须沿用磁盘上已有的分片名，不能按窗口序号重新推导）
   * @param {(id:string)=>Electron.Session} [options.sessionResolver] 覆盖会话解析
   * @param {{ getCurrent: Function, setCurrent: Function }} [options.spaceRuntime]
   *   本窗口的空间运行态。缺省时不注入 —— TabManager 会退化为「全部标签」。
   * @returns {object} 窗口运行单元
   */
  function open(options: OpenWindowOptions = {}): BrowserWindowRuntime {
    const {
      isPrimary = false,
      show = true,
      bounds: explicitBounds = {},
      incognito = false,
      sessionFileName,
      sessionResolver,
      spaceRuntime
    } = options

    // 几何优先级：调用方显式给出 > 上次关闭时的窗口几何 > WindowFactory 默认值。
    // 恢复上次几何 = Chrome/Edge 行为：新窗口按上次的尺寸与位置出现。
    const bounds = {
      ...(shared.windowState && typeof shared.windowState.bounds === 'function'
        ? shared.windowState.bounds()
        : {}),
      ...explicitBounds
    }

    const ordinal = ++windowSeq

    // ── WCO 建窗判定（系统原生窗口控制按钮）────────────────────────
    // Windows 上 WCO 只能**建窗期**启用（setTitleBarOverlay 只能换已启用 overlay 的样式，
    // 无运行时开关），因此这里在 new BrowserWindow 之前按「当时设置」算一次 ——
    // 这就是「下次开窗口生效」的全部含义（方案 B：当前窗口不重建）。
    // 判定 / 参数 / 主题同步全部收敛在 window-controls-policy（PWA 应用窗共用同一实现）。
    const wcoPolicy = createWindowControlsPolicy(shared.settingsService)
    const titleBarOverlay = wcoPolicy.overlay

    /**
     * 本窗口的标签运行单元。**先声明、后赋值**：`createMainWindow` 的面板端口
     * （`onPanelViewCreated`）要用到它的 `jsDialogManager`，而 runtime 在窗口建好之后
     * 才装配。端口是**调用时**才读（面板首次显示远晚于装配），所以留一个延迟解析的变量即可。
     */
    let runtime!: BrowserWindowRuntime
    /**
     * 极少数「runtime 还没装配就被建出来」的面板视图（会话恢复直接开面板）。
     * 端口第一次读不到 manager 时先记在这里，等 `jsDialogManager` 就位后补挂 ——
     * 否则那一块面板里的 confirm 会永远退回系统原生对话框。
     * @type {Array<{ panelId: string, wc: Electron.WebContents }>}
     */
    const pendingPanelJsDialog: PendingPanelDialog[] = []

    const { win, webContentsManager, layoutCoordinator } = createMainWindow({
      windowRegistry: shared.windowRegistry,
      autoLoadUiShell: false,
      // ⚠ 一律**先隐藏**：由 `mount()` 在 ui-shell 加载完成后按 `runtime.showWhenReady` 显示。
      //    原来直接把调用方给的 `show` 透传（默认 true）→ 窗口立刻出现，而此刻 ui-shell
      //    **还没开始加载**、标签视图也没建 —— 用户看到的就是一整块 `backgroundColor`。
      //    这就是「启动白屏闪一下」：窗口先亮、内容后到。
      show: false,
      ...bounds,
      titleBarOverlay: titleBarOverlay || undefined,
      layout: {
        railPinned: (() => {
          try { return normalizeRailPinned(shared.settingsService?.get(LAYOUT_SETTING_KEYS.toolRailPinned)) } catch (_) { return true }
        })(),
        /**
         * 「某面板实际所在侧」变化 → 告诉本窗口的面板宿主（它据此把拖拽手柄放到面向
         * 内容的那条边）。事件名与广播口由 registerCoreIpc 提供（见 ipc-routes 的
         * emitPanelSideChanged），这里只负责补上「哪个窗口」。
         *
         * 延迟解析（同 shared.emit 的理由）：窗口创建早于 registerCoreIpc 回填。
         * @param {string} panelId
         * @param {'left'|'right'|null} side
         * @param {boolean} [pinned] 该面板此刻是否在钉住位
         */
        onPanelSideChanged: (panelId: string, side: 'left' | 'right' | null, pinned?: boolean) => {
          if (typeof shared.emitPanelSideChanged === 'function') {
            shared.emitPanelSideChanged(panelId, side, !!pinned, win.id)
          }
        }
      },
      webContentsManager: {
        sessionResolver: sessionResolver || shared.sessionsController,
        // 字号等只能在建 webContents 时下发 → 走端口「用时再解析」
        getExtraTabWebPreferences: () => (shared.getExtraTabWebPreferences ? shared.getExtraTabWebPreferences() : {}),
        /**
         * 面板视图刚建好（尚未 loadURL）→ 接进本窗口的 JS Dialog 体系。
         *
         * 为什么必须在这个时机：面板 renderer 里所有 `confirm`（删除集锦 / 导入确认…）
         * 都经 `ui-common#confirm` → `window.confirm`，只有先把 `window.__jsDialogBridge`
         * 与 main world 注入挂上（`attachToWebContents`），它们才走 `hira://jsdialog` 浮层；
         * 否则会落回 Electron 的**系统原生 MessageBox**（与网页弹窗样式不一致，用户实测反馈）。
         *
         * 与独立侧栏先例（`onWebContentsReady` → `attachToWebContents`）同一口径；
         * `tabId` 位只用于抑制集合与浮层归属，面板传 `panel:<id>` 与之不冲突。
         */
        onPanelViewCreated: (panelId: string, wc: WebContents) => {
          const mgr = runtime && runtime.jsDialogManager
          if (!mgr || typeof mgr.attachToWebContents !== 'function') {
            // runtime 尚未装配（或本窗口的 manager 还没接上）→ 记下来，见 pendingPanelJsDialog
            pendingPanelJsDialog.push({ panelId, wc })
            return
          }
          try {
            mgr.attachToWebContents(wc, 'panel:' + panelId)
          } catch (e) {
            console.warn('[panel] attach jsDialog failed:', errorMessage(e))
          }
        }
      }
    }) as MainWindowHandle

    // 窗口级 chrome 辅助：浮层 / 密码浮层都必须绑到**本窗口**的 layoutCoordinator
    // emit 供「模态浮层开合」广播用（overlay:modal：让本窗口各 chrome 图层让出拖拽区）。
    // 延迟解析（用 shared.emit 而非快照值）：emit 在 main.js 里创建得比窗口晚。
    const { passwordOverlayController, hideFloat } = createWindowChrome({
      layoutCoordinator,
      emit: (route: string, payload: unknown, opts?: { windowId?: number }) => shared.emit(route, payload, opts)
    })

    /**
     * 面板视图工厂（"面板里装什么 / 怎么加载"）—— 它在 runtime 之后才接上（要用 runtime 的
     * `getProfileContext` 之外的装配知识），但页面右键的菜单项要用到它，所以先声明、延迟读。
     */
    let panelViews: PanelViewFactory | null = null
    /** 独立侧栏的运行单元（同上：页面右键菜单项要用它，先声明、延迟读）。 */
    let webSidebar: WebSidebarInstance | null = null

    /**
     * 「当前聚焦的那块**网页面**」—— 侧栏内容页是活动面时返回它，否则 null。
     *
     * 本窗口里现在有两块网页面（活动标签 + 独立侧栏），而查找栏 / 缩放 / 悬停 URL
     * 这些**窗口级**能力只该作用于用户此刻在操作的那一块。
     *
     * ⚠ 判据是 LayoutCoordinator 的**活动面**（`isWebSidebarFocused`），**不是 `wc.isFocused()`**：
     * 查找栏这类浮层是**自持焦**的 —— 它一打开就把侧栏 blur 掉，若在这里问焦点，
     * 「在侧栏里按 Ctrl+F」就会被算回隔壁标签（用户报的那个 bug 的确切成因）。
     * 由这里提供（而不是让 runtime/infra 认识"侧栏"）—— 业务名词只活在装配层。
     */
    const sidebarFocusedContents = () => {
      const sb = webSidebar
      if (!sb || typeof sb.isOpen !== 'function' || !sb.isOpen()) return null
      if (typeof layoutCoordinator.isWebSidebarFocused === 'function' && !layoutCoordinator.isWebSidebarFocused()) return null
      const wc = typeof sb.getWebContents === 'function' ? sb.getWebContents() : null
      if (!wc || wc.isDestroyed()) return null
      return wc
    }

    /**
     * 把侧栏当前页面交给书签编辑器（与标签那条路径**同一套窗口类型与语义**：
     * 已收藏 → 编辑，未收藏 → 新增）。
     */
    const openBookmarkForSidebar = (wc: WebContents): void => {
      let url = ''
      try { url = String(wc.getURL() || '') } catch (_) { url = '' }
      if (!isHttpUrl(url)) return
      let title = ''
      try { title = String(wc.getTitle() || '') } catch (_) { title = '' }
      const svc = typeof shared.getBookmarkService === 'function' ? shared.getBookmarkService() : null
      let existing = null
      try { if (svc && typeof svc.getByUrl === 'function') existing = svc.getByUrl(url) } catch (_) { existing = null }
      shared.openSubWindow(
        existing ? WINDOW_TYPES.EDIT_BOOKMARK : WINDOW_TYPES.ADD_BOOKMARK,
        { url, title: title || url },
        runtime
      )
    }

    /**
     * 「活动面」的**面级命令**分发 —— 让快捷键与菜单里那些**面级**动作
     *（Ctrl+R 刷新 / Alt+← 后退 / Ctrl+Shift+I 开发者工具 / Ctrl+W 关闭 / Ctrl+D 收藏）
     * 作用在用户此刻在用的那一块网页面（侧栏聚焦时就是侧栏），
     * 与分屏「快捷键跟着活动格走」是同一条原则 —— 靶子 = 聚焦框标的那个面。
     *
     * ── 为什么由装配层给 ────────────────────────────────────────────────
     * 判据是"侧栏是不是活动面" —— 那是业务概念，而业务名词只活在装配层
     *（同上面 `sidebarFocusedContents` 的理由）。运行时与 main 只管转发，不认识"侧栏"。
     *
     * ── 契约 ────────────────────────────────────────────────────────────
     * `(action) => boolean`：**true = 已处理**（调用方不再走标签那条老路）；
     * false = 交回标签（缺省行为，与改造前一字不差）。命令名是**动作意图**、不是键位 ——
     * 键位永远只在主进程的 keybindings 里。
     *
     * 命令词汇里 `reload / back / forward / close` 与 `web-sidebar#command`
     * **同名同义**，所以这里只做转发、不抄第二遍实现（抄一份迟早两处不一致）。
     */
    const runSurfaceCommand = (action: string): boolean => {
      const wc = sidebarFocusedContents()
      if (!wc || !webSidebar) return false
      switch (action) {
        case 'reload':
        case 'reload-hard':
        case 'back':
        case 'forward':
        case 'close':
          try { webSidebar.command(action) } catch (_) {}
          return true
        case 'devtools':
          try { wc.toggleDevTools() } catch (_) {}
          return true
        case 'bookmark':
          try { openBookmarkForSidebar(wc) } catch (_) {}
          return true
        default:
          // 不认识的命令一律不认领：宁可落回标签，也不要静默吞掉一次按键。
          return false
      }
    }

    /**
     * 右键菜单的快捷键提示：每次**现读**当前键位（用户改键后菜单立刻跟随）。
     *
     * `shared.keybindings` 是晚段注入的，所以这里只能是延迟解析 —— 在装配期按值取
     * 会拿到 undefined，表现成"右键菜单永远不显示快捷键"。
     */
    const getMenuAccelerator = (command: string): string => {
      const kb = shared.keybindings
      if (!kb || typeof kb.getKeybindings !== 'function') return ''
      try { return menuAccelerator(command, kb.getKeybindings()) } catch (_) { return '' }
    }

    runtime = createBrowserWindowRuntime({
      win,
      webContentsManager,
      layoutCoordinator,
      // emit / snapshotService 都必须**延迟解析**：它们在 main.js 里创建得比窗口晚
      // （emit 在主题管理之后、snapshot 在扩展之后），按值传会捕获到 undefined。
      //
      // ⚠ 必须带上 windowId：本运行单元 emit 的事件（tab:changed / tab:loading）
      // 描述的是**本窗口**的标签状态，而渲染层是直接拿推送载荷渲染的
      // （见 renderer/tabs-client → tab-session-controller）。若不限定窗口，
      // 窗口 A 的标签变化会被投给窗口 B 的 ui-shell → B 的标签条显示 A 的标签、
      // B 的地址栏指向 A 的页面 —— 这就是多窗口「标签串台」的确切机制。
      emit: (route: string, payload: unknown, opts?: Record<string, unknown>) => shared.emit(route, payload, { ...(opts || {}), windowId: win.id }),
      tabRules: shared.tabRules,
      tabAdjust: shared.tabAdjust,
      tabStacks: shared.tabStacks,
      tabSplits: shared.tabSplits,
      // 速览组端口（第三条正交维度：叠放）—— 与分屏平级、同样规则在 domain-tabs#TabGroups
      tabGroups: shared.tabGroups,
      // 本窗口的空间运行态：**键名必须是 spaceRuntime** —— browser-window-runtime
      // 就是按这个名字解构（browser-window-runtime.js:94），再往下传给 TabManager 的
      // `context` 端口。写成 `context:` 会让它解析成 undefined，TabManager 落到
      // 「恒 default/default」的兜底上下文：所有标签身份都成 default、setCurrentSpace
      // 变 no-op、会话恒取 profiles/default —— space 与 profile 两套隔离同时失效。
      spaceRuntime: spaceRuntime || { getCurrent: () => ({ profileId: 'default', spaceId: 'default' }) },
      // 本窗口的标签 id 前缀：全局唯一（见 windowSeq 注释）
      tabIdPrefix: `w${ordinal}t`,
      defaultIncognito: incognito,
      getPdfViewerEnabled: shared.getPdfViewerEnabled,
      // 分屏选项（默认方向 / 最多格数）：同样是延迟端口
      getSplitOptions: shared.getSplitOptions,
      // 「关闭最后一个标签」替换成的新标签页地址（与首标签同一个解析口）
      getNewTabUrl: (options?: { incognito?: boolean; containerProfileId?: string | null; profileId?: string }) => {
        const profileId = options?.profileId || spaceRuntime?.getCurrent?.()?.profileId || 'default'
        return shared.getNewTabUrl({ ...(options || {}), profileId })
      },
      getAutoPictureInPictureEnabled: shared.getAutoPictureInPictureEnabled,
      getSafeBrowsingWarning: shared.getSafeBrowsingWarning,
      getFaviconService: shared.getFaviconService,
      getHistoryService: shared.getHistoryService,
      getExtensionService: (profileId?: string) => {
        const scopedProfileId = profileId || spaceRuntime?.getCurrent?.()?.profileId || 'default'
        return shared.getExtensionService(scopedProfileId)
      },
      getSearchService: shared.getSearchService,
      // 网页右键菜单的快捷键提示（模型层零字面量，全部经这里现读键位）。
      getMenuAccelerator,
      onTabClosed: shared.onTabClosed,
      // 页面右键菜单的**插件插槽**项（webview.context-menu.item）：
      // 与 Chrome 扩展的菜单项合并，二者共用 tabEvents 的同一个 getExtensionMenuItems 钩子。
      getSlotMenuItems: shared.getSlotMenuItems,
      // 用户脚本（插件贡献面 `contributes.userscripts`）：URL → 该页要执行的脚本代码。
      // 与 getSearchService 同理是延迟端口（插件表面在 main.js 里建得比窗口晚）。
      getUserScriptsForUrl: shared.getUserScriptsForUrl,
      // 声明式页面补丁（PART18 `contributes.pagePatches`）：与用户脚本同一注入时机。
      getPagePatchesForUrl: shared.getPagePatchesForUrl,
      /**
       * 页面右键「**在侧栏打开**」（对齐 Vivaldi 的 "Open in web panel"）。
       *
       * 只造**数据**（`{ label, click }`）：infra 只负责把它塞进原生菜单，不认识它的业务含义。
       * 非法 url（`about:` / `chrome:` / 非 http 协议）**连项都不出现** —— 菜单项出现却点了
       * 没反应，正是本项目最忌讳的形状（S4）。
       *
       * ── 打哪个 URL：链接优先（见 contextMenuTargetUrl）──────────────────
       * 对着链接右键时，菜单里每一项说的都是**那一条链接**（Chrome 的 "Open link in…"、
       * Vivaldi 的 "Open link in web panel" 同一条口径）；落在页面空白处才是"这个页面"。
       */
      getHostMenuItems: (contents: WebContents, params: RightClickParams) => {
        const items: HostMenuItem[] = []
        const url = contextMenuTargetUrl(params)
        const sidebar = webSidebar
        if (url && normalizeSidebarUrl(url) && sidebar) {
          items.push({
            label: '在侧栏打开',
            click: () => {
              try { sidebar.open(url) } catch (e) {
                console.warn('[window] open in web sidebar failed:', errorMessage(e))
              }
            }
          })
        }

        const pageUrl = String((params && params.pageURL) || (contents && contents.getURL && contents.getURL()) || '')
        const pageTitle = (contents && contents.getTitle && contents.getTitle()) || ''
        const isWebPage = isHttpUrl(pageUrl)
        const mediaType = String((params && params.mediaType) || '')
        const srcURL = String((params && params.srcURL) || '')
        const selectionText = String((params && params.selectionText) || '')
        const linkURL = String((params && params.linkURL) || '')
        const notes = shared.notesService
        if (notes && isWebPage) {
          const collectionSubmenu = (capture: (target: CollectionTarget) => unknown) => toNativeMenuItems(
            buildCollectionMenuEntries(
              (typeof notes.listFolders === 'function' ? notes.listFolders() : []) as Array<{ id?: string; name?: string }>
            ),
            (target: CollectionTarget) => {
              Promise.resolve(capture(target)).catch((error) => {
                console.warn('[window] collect failed:', errorMessage(error))
              })
            }
          )
          const pushCollection = (
            label: string,
            capture: (target: CollectionTarget) => unknown,
            group?: string
          ) => {
            items.push({
              label,
              click: () => {},
              submenu: collectionSubmenu(capture),
              ...(group ? { group } : {})
            })
          }
          if (selectionText.trim()) {
            pushCollection('收集所选内容', (target) => captureSelectionIntoCollection(
              notes,
              target,
              { text: selectionText, url: pageUrl, sourceTitle: pageTitle }
            ))
          } else if (mediaType === 'image' && isHttpUrl(srcURL)) {
            const alt = String((params && params.titleText) || '').trim()
            pushCollection('收集此图', (target) => captureImageIntoCollection(
              notes,
              shared.notesAssets,
              target,
              { url: srcURL, referer: pageUrl, title: alt || pageTitle, sourceTitle: pageTitle }
            ))
          } else if (isHttpUrl(linkURL)) {
            const linkText = String((params && params.linkText) || '').trim()
            pushCollection('收集此链接', (target) => captureLinkIntoCollection(
              notes,
              target,
              { url: linkURL, title: linkText || linkURL, sourceTitle: pageTitle }
            ), 'link')
          } else {
            pushCollection('收集此页', (target) => capturePageIntoCollection(
              notes,
              shared.notesAssets,
              target,
              { url: pageUrl, title: pageTitle, sourceTitle: pageTitle, webContents: contents }
            ))
          }
        }
        return items
      },
      // 网页生命周期插槽（webview.lifecycle.*）：同样是延迟解析的 getter
      getSlotLifecycle: shared.getSlotLifecycle,
      // 「当前聚焦的网页面」解析器（见上面 sidebarFocusedContents 的说明）。
      // ⚠ 两个闭包都引用了 `runtime`（正在赋值的那个 const）—— 安全：它们只在**用户动作发生时**
      // 被调用，那时 runtime 早已就绪（不能用值快照：侧栏实例晚于 runtime 创建）。
      getFocusedWebContents: (): WebContents | null => sidebarFocusedContents() || runtime.tabManager.getActiveWebContents(),
      getFocusedSurface: (): string | null => (sidebarFocusedContents() ? 'sidebar' : runtime.tabManager.getActiveTabId()),
      // 「活动面」的面级命令分发（见上面 runSurfaceCommand 的说明）——
      // 快捷键 / 应用菜单里的面级动作先问它，没人认领才落回标签。
      surfaceCommand: runSurfaceCommand,
      // 数据域的 profile 作用域（见 shared.runAsProfile 文档）
      runAsProfile: shared.runAsProfile,
      // 站点守卫（弹窗策略）：判定与询问在 APPS 层 site-guard.js，这里只做延迟解析
      // （守卫实例在 main.js 权限服务之后才建，按值传会捕获到 undefined）。
      guardWindowOpen: (payload: Record<string, unknown>): boolean => (
        typeof shared.guardWindowOpen === 'function' ? shared.guardWindowOpen(payload) : true
      ),
      passwordOverlayController,
      hideFloat,
      getSnapshotService: () => shared.snapshotService,
      // 设置读写端口（缩放记忆落库：app.zoom_levels）。**端口 + 延迟解析**：
      // settingsService 在 main.js 里创建得比窗口装配晚，按值传会捕获到 undefined。
      settings: {
        get: (key: string): unknown => {
          try { return shared.settingsService ? shared.settingsService.get(key) : null } catch (_) { return null }
        },
        set: (key: string, value: unknown): void => {
          try { if (shared.settingsService) shared.settingsService.set(key, value) } catch (_) {}
        }
      },
      // 子窗口的父窗口用**发起方窗口**：这样模态/置顶才有正确锚点
      openSubWindowByType: (type: string, payload?: Record<string, unknown>) => shared.openSubWindow(type, payload, runtime),
      // 本窗口发出的「新窗口」请求（omnibox 踏板）
      onOpenNewWindow: (opts?: { incognito?: boolean }) => {
        void openNewWindow({ ...(opts || {}), opener: runtime }).catch((error) => {
          console.error('[window] open new window failed:', errorMessage(error))
        })
      },
      // 「在新窗口中打开链接」（网页右键菜单）：开完整浏览器窗口，并把该 URL 作为首标签
      openLinkInNewWindow: (url: string) => {
        void openNewWindow({ url, opener: runtime }).catch((error) => {
          console.error('[window] open link in new window failed:', errorMessage(error))
        })
      },
      // 「在小窗中预览链接」（N1，链接右键）：小窗是**应用级单例**（不是每窗口一份），故从 shared 取。
      // ⚠ 参数是**整个载荷**（`{ url, session, originWindow }`）—— 本层只做转发，
      //   不拆字段：拆了就得在这里重复一份"小窗要什么"的知识（infra 并不知道 originWindow）。
      openPeekPreview: (payload: Record<string, unknown>) => {
        try { if (typeof shared.openPeekPreview === 'function') shared.openPeekPreview(payload) } catch (_) {}
      },
      openCaptureHub: () => {
        try { return shared.captureHub && shared.captureHub.open() } catch (_) { return null }
      },
      archiveCurrentPage: () => {
        try { return shared.pageLibrary && shared.pageLibrary.archiveActive() } catch (_) { return null }
      },
      // ── 自动化（D2 命令链 + D3 鼠标手势）────────────────────────────────
      // 控制器是**应用级**的（比窗口装配晚建），因此两个端口都**延迟解析** shared：
      //   · runCommandChain —— 地址栏 `chain:<id>` / 手势映射到链时，跑那一串命令；
      //   · shouldSuppressContextMenu —— 刚画完手势的那一次右键**不该弹菜单**
      //     （infra 不认识"手势"，只问"这一次要不要吞"；判定在 main/automation.js）。
      runCommandChain: (id: unknown): void => {
        try { if (shared.automation) shared.automation.runChain(String(id || '')) } catch (_) {}
      },
      shouldSuppressContextMenu: (wc: WebContents | null | undefined): boolean => {
        try { return Boolean(shared.automation && shared.automation.shouldSuppressContextMenu(wc)) } catch (_) { return false }
      },
      handleTabEvent: (event) => {
        try { return shared.automation && shared.automation.handleTabEvent(event) } catch (_) { return null }
      },
      // 翻译此页（C3）：同样是应用级能力（引擎 + 目标语言都在 main.js / 设置里）。
      translatePage: (wc: WebContents): void => {
        try { if (typeof shared.translatePage === 'function') shared.translatePage(wc) } catch (_) {}
      },
      /**
       * 集锦动作（WP1）：地址栏 `note:<action>` 的落点。
       *
       * 与 `runCommandChain` 同一条原则 —— 动作表是**应用级单例**（`shared.noteActions`），
       * 比窗口装配晚建，因此这里必须延迟解析；提前解析只会拿到 undefined。
       * 真实的取标签 / 存卡片 / 开面板全在 `main/note-actions.js`。
       */
      runNoteAction: (action: unknown, params?: Record<string, unknown>): void => {
        try { if (shared.noteActions) shared.noteActions.run(String(action || ''), params || {}) } catch (_) {}
      }
    }) as BrowserWindowRuntime
    runtime.ordinal = ordinal
    runtime.incognito = Boolean(incognito)
    runtime.isPrimary = Boolean(isPrimary)
    // 本窗口的空间运行态：让「新窗口继承发起窗口的空间」可以按运行单元取值
    // （见 openNewWindow / shared.getWindowSpace），无需外部再维护一张窗口→空间表。
    runtime.spaceRuntime = spaceRuntime || { getCurrent: () => ({ profileId: 'default', spaceId: 'default' }) }
    // 会话分片名（恢复时由调用方指定；新窗口留空 → 由 APPS 层的分配器给号）
    runtime.sessionFileName = sessionFileName || null

    /**
     * ── 面板视图端口：把"面板里装什么"整体留在 apps 层 ─────────────────────
     *
     * 布局层只拿到「造好的视图」，它**不认识**面板种类 / 本地页路由 / preload。
     * 端口的实现就是 `./panel-views`。
     */
    try {
      panelViews = createPanelViewFactory({
        wcm: webContentsManager as unknown as PanelViewDeps['wcm'],
        // 目录**用时再取**：它在 main.js 里创建得比窗口晚（主窗口 :587 开、目录 :2118 建），
        // 按值传会捕获到 undefined → 那个窗口的面板永远打不开（十个老面板也一样）。
        getCatalog: () => (shared.panelCatalog || null) as PanelCatalogLike | null
      })
      const views = panelViews
      layoutCoordinator.setPanelViewPort({
        ensurePanelView: (panelId: string) => views.ensure(panelId),
        destroy: (panelId: string) => views.destroy(panelId)
      })
    } catch (e) {
      console.error('[window] panel view port wiring failed:', errorMessage(e))
    }

    /**
     * ── 独立侧栏（Web Sidebar）─────────────────────────────────────────
     *
     * 与上面那块**平行**：它有自己的视图端口（`setWebSidebarViewPort`）、自己的运行单元
     * （`runtime.webSidebar`，IPC 按窗口解析它）、自己的持久化。两套东西零交集 ——
     * 这正是"独立侧栏"的落地形状（见 docs/web-sidebar-design.md）。
     *
     * 接在这一步（runtime 之后）：它要 runtime 的 profile 上下文来保证
     * "侧栏里的网页与同窗口标签**同 session、同登录态**"。
     */
    try {
      webSidebar = createWebSidebar({
        wcm: webContentsManager,
        layoutCoordinator,
        getOwnerWindow: () => win,
        getSafeBrowsingWarning: shared.getSafeBrowsingWarning,
        // 状态广播（顶条之外还要告诉外壳，让入口按钮能反映"侧栏正开着"）
        emit: (route: string, payload?: unknown) => shared.emit(route, payload, { windowId: win.id }),
        // 身份：与标签同一条链（profile / 无痕）—— 不同 session 会出现"标签登录了侧栏没登录"
        getIdentity: () => {
          let profileId = ''
          try {
            const cur = spaceRuntime && typeof spaceRuntime.getCurrent === 'function' ? spaceRuntime.getCurrent() : null
            profileId = cur && cur.profileId ? String(cur.profileId) : ''
          } catch (_) { profileId = '' }
          return { profileId: profileId || 'default', incognito }
        },
        persistWidth: (width: number) => shared.settingsService && shared.settingsService.set(LAYOUT_SETTING_KEYS.webSidebarWidth, width),
        /**
         * 位置偏好：拖顶条换边后写它（与设置页改的是**同一个键**，所以两边天然同步）。
         * 写库之后 applier 会灌到所有窗口 —— 与 `app.sidebar_position` 同一条"偏好"语义，
         * 不做"只改当前窗口"的特例（那会让多窗口下同一个偏好互相矛盾）。
         */
        persistPosition: (position: string) => shared.settingsService && shared.settingsService.set(LAYOUT_SETTING_KEYS.webSidebarPosition, position),
        /**
         * 视图模式（手机端 / 桌面端）是**偏好**：切换即写，与宽度同一条设置通道。
         *
         * `initialViewMode` 用**闭包延迟读**而不是按值读：设置服务在 main.js 里创建得
         * 比窗口装配更晚，装配期读只会拿到 undefined（表现为"切了桌面端，重启又回手机端"）。
         */
        persistViewMode: (mode: string) => shared.settingsService && shared.settingsService.set(LAYOUT_SETTING_KEYS.webSidebarViewMode, mode),
        initialViewMode: () => {
          try { return shared.settingsService ? shared.settingsService.get(LAYOUT_SETTING_KEYS.webSidebarViewMode) : '' } catch (_) { return '' }
        },
        hooks: {
          // 「在标签页打开」等跨到标签世界的动作：交付给本窗口的 TabManager（runtime 的公共端口）
          newTab: (url: string, opts?: Record<string, unknown>) => {
            try {
              void Promise.resolve(runtime.tabManager.newTab({ url, ...(opts || {}) })).catch((error) => {
                console.error('[window] sidebar new tab failed:', errorMessage(error))
              })
            } catch (error) { console.error('[window] sidebar new tab failed:', errorMessage(error)) }
          },
          onOpenInNewWindow: (url: string) => {
            void openNewWindow({ url, opener: runtime }).catch((error) => {
              console.error('[window] sidebar new window failed:', errorMessage(error))
            })
          },
          onViewSource: (url: string) => {
            try {
              void Promise.resolve(runtime.tabManager.newTab({ url: `view-source:${url}` })).catch((error) => {
                console.error('[window] view source failed:', errorMessage(error))
              })
            } catch (error) { console.error('[window] view source failed:', errorMessage(error)) }
          },
          // 搜索右键：**走搜索域**（当前默认引擎），侧栏与标签页同一口径。
          // 只有服务尚未就绪时才用真源兜底（不写 bing/google 字面量）。
          onSearchUrl: (text: string) => { try { return shared.getSearchService()?.buildSearchUrl(String(text || '')) || defaultSearchUrl(String(text || '')) } catch (_) { return defaultSearchUrl(String(text || '')) } },
          onSearchLabel: (text: string) => { try { return shared.getSearchService()?.buildSearchLabel(String(text || '')) || defaultSearchLabel(String(text || '')) } catch (_) { return defaultSearchLabel(String(text || '')) } },
          // 链接悬停事实（`update-target-url`）：交给窗口级的悬停条端口。
          // 来源标识固定 `'sidebar'` —— 与 `getFocusedSurface` 的取值同一套词汇（见上面）。
          onTargetUrl: (url: string) => {
            try { runtime.hoverUrl?.update('sidebar', String(url || '')) } catch (_) {}
          },
          // 内置 PDF 查看器开关（pdf.viewer_enabled）：关掉时侧栏也不拦截 .pdf（与标签同一条口径）
          shouldUsePdfViewer: () => (shared.getPdfViewerEnabled ? !!shared.getPdfViewerEnabled() : true),
          // Ctrl+滚轮缩放：`zoom-changed` 只报 'in' / 'out'，换算成 ±1 交给缩放控制器
          //（与标签那条路径同一个实现、同一份按 origin 的记忆）。
          onZoomRequest: (direction: 'in' | 'out', wc: WebContents) => {
            try { runtime.zoom?.step(direction === 'in' ? 1 : -1, wc, 'wheel') } catch (_) {}
          },
          // 扩展项 + 插件插槽项：**复用**标签右键那一份（runtime 暴露的同一个实现）——
          // 两处各写一份必然漂移（见 browser-window-runtime#collectExtensionMenuItems）。
          getExtensionMenuItems: (contents: WebContents, params: RightClickParams) => {
            try { return runtime.getExtensionMenuItems(contents, params as unknown as Record<string, unknown>) || [] } catch (_) { return [] }
          },
          // 右键菜单的快捷键提示：与标签右键同一个解析器（见上面 getMenuAccelerator）。
          getMenuAccelerator,
          getHostMenuItems: (contents: WebContents, params: RightClickParams) => {
            const url = contextMenuTargetUrl(params)
            if (!url || !normalizeSidebarUrl(url)) return []
            // 侧栏里的页面右键：「在标签页打开」（把它放大到整页去看）。
            // URL 与标签那一份同一个判据：对着链接右键 = 打开**那条链接**。
            return [{ label: '在标签页打开', click: () => { try { runtime.tabManager.newTab({ url }) } catch (_) {} } }]
          },
          // ── 页面右键里的宿主能力（J7 截图 / N1 小窗）──
          // 直接复用标签那一份实现（`runtime.hooks`，见 browser-window-runtime 的说明）。
          // 契约与 tabEvents 完全一致：infra 只报 mode / URL，这里补齐 webContents。
          // ⚠ 漏接的表现是"侧栏右键里这一项在、点了毫无反应"。
          onCapturePage: (payload: Record<string, unknown>) => {
            try { (runtime.hooks as RuntimeHooksPort).onCapturePage?.(payload) } catch (_) {}
          },
          onPeekPreview: (payload: Record<string, unknown>) => {
            try { (runtime.hooks as RuntimeHooksPort).onPeekPreview?.(payload) } catch (_) {}
          },
          /**
           * 侧栏内容 webContents 就绪 → 挂**它那一半**能力。
           *
           * 这两样都按 webContents 挂、且实现都在 apps 层：
           *   · JS 对话框（alert/confirm/prompt 的覆盖与回执）；
           *   · 快捷键（Ctrl+F / Ctrl+D 等 before-input-event）。
           * 少了它们，侧栏里的页面就会"点了 confirm 没反应、按 Ctrl+F 也没反应"。
           *
           * ⚠ **延迟解析** `runtime.jsDialogManager`：它在 `mount()` 里才建出来，
           * 而本回调在 `open()` 阶段就注册了（窗口创建早于晚段装配）。视图是**首次打开
           * 侧栏时**才建的（远晚于 mount），所以到那时句柄一定已经就绪。
           */
          onWebContentsReady: (wc: WebContents) => {
            const mgr = runtime.jsDialogManager
            if (mgr && typeof mgr.attachToWebContents === 'function') {
              try { mgr.attachToWebContents(wc, 'web-sidebar') } catch (_) {}
            }
            const kb = shared.keybindings
            if (kb && typeof kb.attach === 'function') { try { kb.attach(wc) } catch (_) {} }
          }
        }
      })
      const sidebar = webSidebar
      layoutCoordinator.setWebSidebarViewPort({
        ensureView: () => sidebar.ensureView(),
        destroy: () => sidebar.destroy()
      })
      /**
       * 侧栏**侧别**变化 → 让侧栏重新投影一次状态。
       *
       * 与上面的视图端口**分开**：那条回答"给它一个视图"，这条回答"布局事实变了通知它"。
       * 没有这一条，用户在设置里把网页侧栏换到另一边时，侧栏本体挪过去了，
       * 顶条却还按旧的 side 把宽度把手贴在原边（见 LayoutCoordinator#_webSidebarSideListener）。
       */
      if (typeof layoutCoordinator.setWebSidebarSideListener === 'function') {
        layoutCoordinator.setWebSidebarSideListener(() => {
          try { sidebar.refreshLayout() } catch (_) {}
        })
      }
      /**
       * 侧栏**拖动换边**的落位预览端口（给矩形就显示，给 `null` 就收起）。
       *
       * 预览**必须由原生浮层画**：网页是原生 `WebContentsView`，永远盖在 chrome DOM 之上 ——
       * 画在外壳里的半透明带会被网页整个吃掉（"预览被遮挡 / 错位"就是这么来的）。
       * 这里复用分屏那套 `dropzone-overlay` 浮层（它本来就是"落位预览"的宿主），
       * 用 `cover` 形态：只画半透明块 + 边框，不要分屏的箭头与 zone 文案。
       * 矩形由布局层给（与松手后的落点**同源**），所以所见即所得。
       */
      if (typeof layoutCoordinator.setWebSidebarDropPreviewPort === 'function') {
        layoutCoordinator.setWebSidebarDropPreviewPort((rect: Rectangle | null) => {
          try {
            if (!rect) {
              layoutCoordinator.setFloatBounds('dropzone-overlay', { x: 0, y: 0, width: 0, height: 0 })
              return
            }
            // 顺序与分屏那条一致：① 视图已挂 ② 逻辑可见态置真 ③ 设 bounds ④ 推形态
            if (typeof layoutCoordinator.attachFloatView === 'function') layoutCoordinator.attachFloatView('dropzone-overlay')
            if (typeof layoutCoordinator.isFloatVisible === 'function'
              && !layoutCoordinator.isFloatVisible('dropzone-overlay')) {
              layoutCoordinator.noteFloatShow('dropzone-overlay')
            }
            layoutCoordinator.setFloatBounds('dropzone-overlay', rect)
            // ⚠ 不吃指针：拖动还在进行，浮层抢走指针会让拖拽当场断掉
            layoutCoordinator.setFloatInteractive('dropzone-overlay', false)
            const sent = layoutCoordinator.sendToFloat(
              'dropzone-overlay',
              `ngipc:event:${IPC_EVENTS.dropzoneUpdate}`,
              { mode: 'cover' }
            )
            if (sent && typeof sent.catch === 'function') sent.catch(() => {})
          } catch (_) {}
        })
      }
      // IPC 层按"当前窗口"取它（打开 / 收起 / 命令 / 宽度）—— 与 splitToolbar 同一条 scoped 机制
      runtime.webSidebar = webSidebar
    } catch (e) {
      console.error('[window] web sidebar wiring failed:', errorMessage(e))
    }

    /**
     * ── 这里**刻意没有**「chrome 瞬态浮层的启动预热」────────────────────────
     *
     * 曾经在启动后 400ms 无条件预建 5 个浮层的视图（findbar / hoverurl / zoom /
     * dropzone / split-toolbar），理由是"手指一动就要出现，惰性创建要等一个渲染进程起来"。
     *
     * 实测把这两条理由都否掉了（Electron 43 / Windows，脚本跑完即删）：
     *   · **同步阻塞只有 ~1ms**（样本 0.7–3.6ms）—— 一帧 16ms，不可能造成掉帧。
     *     于是"在拖动进行中建视图会打扰那次原生拖拽"的顾虑不成立；
     *   · **干净环境的第 1 次创建（含加载页面到 did-finish-load）只要 ~65ms**，
     *     与后续创建（61–65ms）几乎一致（没有可依赖的 spare renderer 加速）——
     *     这 65ms 就是预热的**全部**收益，低于"瞬时"的感知阈值。
     *   · 而代价的另一面：**每个浮层是一个独立 renderer 进程**，实测每个约
     *     98MB 工作集 / 25MB 独占。启动模拟：uiShell + rail + 1 标签 + 5 个预热门
     *     = 11 进程 / 工作集 1123MB，其中**光那 5 个浮层就 489MB** —— 而那一刻
     *     用户一个浮层都还没用到（"为什么刚启动就占 500MB"就是它）。去掉后 6 进程 / 634MB。
     *
     * 结论：预热 = 拿 489MB 常驻换 5 × 65ms 的一次性延迟，明显不划算。
     * 浮层一律**惰性创建**（`LayoutCoordinator#_ensureFloatView`），首次用时建，
     * 闲置后被 `FLOAT_IDLE_RECLAIM_MS` 那条回收腿收走。
     *
     * ⚠ 不要"顺手加回来"：`sendToFloat` 在视图不存在时会先建好并**等 renderer 就绪**
     * 再转发（见 ipc/layout.js 的 show 链路注释），所以惰性创建不会丢首帧事件 ——
     * 功能上一点都不缺。
     */

    // 窗口状态变化 → 通知**本窗口**的 chrome 渲染层（每个窗口各发各的）
    const notifyWindowState = () => {
      if (win.isDestroyed()) return
      try {
        win.webContents.send('ngipc:event:window:state-changed', {
          isMaximized: win.isMaximized(),
          isFullscreen: win.isFullScreen()
        })
      } catch (_) {}
    }
    win.on('maximize', notifyWindowState)
    win.on('unmaximize', notifyWindowState)
    win.on('enter-full-screen', () => {
      layoutCoordinator.setTabFullscreenFromWindow()
      notifyWindowState()
    })
    win.on('leave-full-screen', () => {
      layoutCoordinator.setTabFullscreenFromWindow()
      // ── 自愈兜底（用户实测：F11 退出全屏后界面不恢复、网页仍铺满）────────────────
      // 现象说明 `leave-full-screen` 那一次没能把状态改回来（事件丢失，或它到达时
      // `win.isFullScreen()` 还没翻转）。退出全屏**必然**伴随一次窗口尺寸变化，
      // 所以再用 resize 兜一次 —— `setTabFullscreenFromWindow` 是幂等重同步
      // （状态没变时立即返回，不重排、不广播），窗口拖动期每帧调它也只是一次布尔比较。
      const resyncAfterExit = () => {
        if (layoutCoordinator.setTabFullscreenFromWindow()) {
          // 状态真的翻转了（= 上面那次事件漏了）→ 补一次窗口状态广播，让渲染层跟上。
          notifyWindowState()
        }
      }
      win.on('resize', resyncAfterExit)
      setTimeout(() => { try { win.off('resize', resyncAfterExit) } catch (_) {} }, 2000)
    })

    // ── WCO 符号色随主题 ──────────────────────────────────────────
    // 原生模式下系统按钮的字形颜色必须跟随明暗主题（浅色黑、深色白）。
    // 监听挂/卸按窗口成对、关闭即清理（不泄漏）—— 细节在 window-controls-policy。
    wcoPolicy.attach(win)

    // 「本窗口曾经真正失焦过」—— 首次启动的那次聚焦不算。
    // 启动时窗口一被创建就会触发一次 focus，而此刻用户该落在地址栏（首个标签由
    // `shell:focus` 驱动）。若把那条也当成"回到前台"，回焦链就会和地址栏聚焦链互抢。
    let hasBlurredOnce = false
    // 窗口失焦：收起带凭据/瞬态信息的浮层。按窗口收起 —— 共用一个 hideFloat
    // 就会出现「切到别的应用时收掉另一个窗口的浮层」。
    win.on('blur', () => {
      hasBlurredOnce = true
      try { passwordOverlayController.hideTransient() } catch (_) {}
      try { hideFloat('tabpreview-overlay') } catch (_) {}
      try { hideFloat('searchbar-overlay') } catch (_) {}
      // 「总览」浮层也是瞬态浮层：切到别的应用后必须收起（它铺满整窗且捕获鼠标，
      // 留着会挡住回切后的第一次点击）。
      try { hideFloat('overview-overlay') } catch (_) {}
      // 按钮编辑浮层不能在窗口 blur 时自动关闭：原生 select / 菜单弹层会短暂触发
      // 窗口级 blur，立即 hideFloat 会让编辑界面在用户选择下拉项时凭空消失。
      // 编辑模式只由 Esc、完成/取消或明确的开关退出。
      // 通用「选择目标」浮层：切到别的应用后它就是"挂在触发项上的一块面板"，必须收起
      // （它锚在触发项下缘，回窗口后也未必还指得到同一项）。
      try { hideFloat('target-picker-overlay') } catch (_) {}
      // 站点信息卡：切到别的应用后它没有继续留着的理由（信息属于刚才那个上下文），
      // 且它是锚在地址栏按钮上的轻量下拉 —— 回来时用户多半已经在看别处。
      try { hideFloat('siteinfo-overlay') } catch (_) {}
      // chrome 级瞬态三兄弟：切到别的应用后都属于"不该还留在屏幕上"的东西 ——
      // 悬停 URL 描述的是一个已经不存在的指针位置；缩放条是操作回执；查找栏会
      // 继续持有键盘焦点（回来时打字会打进看不见的输入框）。三者一起收。
      //
      // 悬停 URL 走**端口 clear()** 而不是裸 hideFloat：只收浮层的话，主进程那份
      // "上次悬停的是哪个 URL"的去重基准还留着 —— 回到窗口后悬停**同一个链接**会被
      // `next === lastUrl` 挡掉，表现是"这条提示条再也不出来了"。clear() 会连它一起清。
      try { if (runtime && runtime.hoverUrl) runtime.hoverUrl.clear() } catch (_) {}
      try { hideFloat('hoverurl-overlay') } catch (_) {}
      try { hideFloat('zoom-overlay') } catch (_) {}
      // 拖动落点预览走**控制器**而不是裸 hideFloat：它同时还持有一条 30fps 采样表 ——
      // 切走窗口时若拖动已经在别处结束（`dragend` 丢了），只收浮层会留下一条永远在跑的定时器
      // 和一份"下次拖动开始就会被 next pointer 覆盖"的陈旧意图。cancel 一并停表 + 清意图。
      try {
        if (runtime && runtime.tabDropZone) runtime.tabDropZone.cancel()
        else hideFloat('dropzone-overlay')
      } catch (_) {}
      // 分屏工具条同理走**控制器**：它持有一条 30fps 光标采样表（hover 在分屏上时在跑）。
      // 切走窗口时只收浮层会留下一条永远在跑的定时器与一份陈旧 hover 意图；cancel 一并停表 + 收浮层。
      try {
        if (runtime && runtime.splitToolbar) runtime.splitToolbar.cancel()
        else hideFloat('split-toolbar')
      } catch (_) {}
      // 查找栏走**控制器**而不是裸 hideFloat：它是"查找会话"的拥有者 ——
      // 收起浮层的同时必须把页内高亮也清掉，否则窗口失焦后页面上会留一片黄底
      //（浮层没了，用户找不到任何地方把它关掉）。控制器不可用就跳过。
      try {
        if (runtime && runtime.findInPage) runtime.findInPage.close()
      } catch (_) {}
      // 通知外壳「窗口真正失活」→ 让地址栏当场交还 DOM 光标。
      // 为什么只有这里算数：Chromium 在窗口失活时**不清** DOM 焦点，窗口一激活就把那个
      // 光标原样还回来，表现就是「一切换窗口回来就自动聚焦地址栏」。若改由外壳自己监听
      // window blur，会连「标签视图抢焦 / 浮层原生抢焦」一起命中 —— 那种场景恰恰要把光标
      // 补回去（补焦链路），在里面 blur 会把"正打字却被浮层夺焦"的输入打断。
      // 主进程的窗口 blur 是唯一的"切走"信号，因此判据落在这里。
      try { win.webContents.send('ngipc:event:window:blurred', {}) } catch (_) {}
      // 真失活了 ⇒ 上一轮激活的"外壳抢焦就送回去"宽容窗随即作废：留着会让下次激活
      // 头 90ms 内立刻触发一次本不该发生的判定（也顺带清掉在跑的判定定时器）。
      try { layoutCoordinator.endShellFocusBounce() } catch (_) {}
    })

    // 窗口重新激活：与上面成对，外壳据此恢复「自动弹出」的判据。
    // 只报事实（OS 级 focus），不在这里做任何浮层开合 —— 谁消费谁决定。
    win.on('focus', () => {
      try { win.webContents.send('ngipc:event:window:focus', {}) } catch (_) {}
      // 编辑浮层是模态界面，重新聚焦时优先把键盘交还浮层，避免原生下拉关闭后
      // 焦点被恢复链送到下层网页。
      try {
        if (layoutCoordinator.isFloatVisible('buttons-edit-overlay')) {
          layoutCoordinator.focusFloat('buttons-edit-overlay')
          return
        }
      } catch (_) {}
      // 把键盘焦点还给「用户切走前正在打字的那一面」。
      //
      // 为什么非做不可：窗口激活时 Chromium 只恢复「上一次持焦的 webContents」，
      // 而外壳（窗口本体）往往就是它 —— 于是回到前台后键盘落在外壳上，网页里的
      // 输入框看起来还在、实际已经收不到输入（用户报的"切回来焦点就没了"）。
      // 目标与全部闸口都在 `LayoutCoordinator#restoreContentFocus` 里，单一真源。
      if (!hasBlurredOnce) return
      // preempt=true：切走期间地址栏光标已主动交还，此刻挂着的 shell / 浮层 / 面板聚焦链
      // 全是过期意图 —— 不作废它们，回焦会被闸口④ 拦上一秒以上。
      // 它同时开启「外壳抢焦就送回去」的宽容窗（Chromium 的 native focus 重放时刻不可预知，
      // 只能靠事件接，见 LayoutCoordinator#_installShellFocusBounce）。
      try { layoutCoordinator.restoreContentFocus({ reason: 'window-focus', preempt: true }) } catch (_) {}
    })

    // Native mouse side buttons on Windows/Linux. Route them through TabManager
    // so sleeping tabs and every other navigation entry share one implementation.
    win.on('app-command', (_event, command) => {
      if (command !== 'browser-backward' && command !== 'browser-forward') return
      try {
        const sidebar = runtime.webSidebar
        const sidebarWc = sidebar && typeof sidebar.getWebContents === 'function'
          ? sidebar.getWebContents()
          : null
        if (sidebar && sidebarWc && !sidebarWc.isDestroyed() && sidebarWc.isFocused()) {
          sidebar.command(command === 'browser-backward' ? 'back' : 'forward')
          return
        }
        const tabId = runtime.tabManager && typeof runtime.tabManager.getActiveTabId === 'function'
          ? runtime.tabManager.getActiveTabId()
          : null
        if (!tabId) return
        if (command === 'browser-backward') runtime.tabManager.goBack(tabId)
        else runtime.tabManager.goForward(tabId)
      } catch (error) {
        console.warn('[window] native navigation command failed:', error)
      }
    })

    // 窗口被拖动 → 收起标签 hover 预览（"任何地方有左键就收"的最后一格）。
    //
    // 为什么必须放在主进程：标签条右侧那块空白（以及 navbar 的空白）是
    // `-webkit-app-region: drag`，那里的左键被 Chromium 当成**窗口非客户区**，
    // 渲染进程根本收不到 mousedown —— 渲染层规则 ⑤（document mousedown）与
    // 主进程的 `input-event` 侦听（也只在 webContents 内）都覆盖不到。
    // 而"按在拖拽区并拖动"必然让窗口移动，`move` 是这里唯一能拿到的信号。
    // 纯按下不移动的那一下 OS 不会通知任何人，无从侦测（也不会有任何副作用）。
    win.on('move', () => {
      // 拖动期 move 是逐帧来的：先看逻辑可见态再动手，别给渲染层发一串空 hide
      //（`hideFloat` 包装层每次都会给浮层发 `:hide`）。
      if (!layoutCoordinator.isFloatVisible('tabpreview-overlay')) return
      try { hideFloat('tabpreview-overlay') } catch (_) {}
    })

    // ── 几何持久化：resize / move / 最大化切换时记录（store 内部防抖 800ms）──
    // 无痕窗口不参与记录：无痕会话的形状不该影响下次普通窗口的打开尺寸。
    const windowState = shared.windowState
    if (!incognito && windowState && typeof windowState.capture === 'function') {
      const capture = () => { try { windowState.capture(win) } catch (_) {} }
      win.on('resize', capture)
      win.on('move', capture)
      win.on('maximize', capture)
      win.on('unmaximize', capture)
    }

    // ── 关闭窗口前确认（tabs.confirm_close_multiple）──────────────────────
    //
    // 与「关闭其他 / 关闭右侧」共用**同一个闸门**（main/tab-close-guard.js）：
    // 窗口里还有多个标签时，用应用内 jsdialog（hira://jsdialog）问一次 ——
    // 不是系统原生对话框。只认这一个设置键，不在这里另写一条规则。
    //
    // 三条放行：已确认过（closeApproved）、应用正在退出（isQuitting）、
    // 以及「设置关闭 / 标签 ≤ 1」（needsWindowCloseConfirm 已覆盖）。
    // 最后一条必须在**同步**阶段判定：`close` 监听返回前要决定是否 preventDefault，
    // 不能先拦下来再异步发现"其实不用问"（那会让关窗莫名其妙卡一下）。
    win.on('close', (event) => {
      // close 是最后一次能安全读取原生窗口几何的同步点。只依赖 800ms 防抖，
      // 用户拖动后立刻关窗会错过尚未落地的最后一帧。
      if (windowState && typeof windowState.flush === 'function') {
        void Promise.resolve(windowState.flush()).catch((error: unknown) => {
          console.warn('[window-state] close flush failed:', error instanceof Error ? error.message : error)
        })
      }
      if (runtime.closeApproved) return
      if (typeof shared.isQuitting === 'function' && shared.isQuitting()) return
      let count = 0
      try { count = runtime.tabManager ? runtime.tabManager.countTabs() : 0 } catch (_) { count = 0 }
      if (typeof shared.needsWindowCloseConfirm !== 'function' ||
          !shared.needsWindowCloseConfirm(count)) return
      // 真正会带走多个标签：同步拦住，等用户答复。
      event.preventDefault()
      // 询问期间又点了一次 X → 不叠加第二个浮层（第一个答复会决定这次关闭）。
      if (runtime.closePromptPending) return
      runtime.closePromptPending = true
      Promise.resolve()
        .then(() => shared.confirmWindowClose(runtime))
        .then((allowed) => {
          runtime.closePromptPending = false
          if (!allowed || win.isDestroyed()) return
          runtime.closeApproved = true
          win.close()
        })
        .catch(() => { runtime.closePromptPending = false })
    })

    win.on('closed', () => {
      try { shared.runtimeRegistry && shared.runtimeRegistry.unregister(runtime) } catch (_) {}
      const idx = windows.indexOf(runtime)
      if (idx >= 0) windows.splice(idx, 1)
      if (primaryRuntime === runtime) primaryRuntime = windows[0] || null
      // 本窗口的 JS 对话框管理器必须随窗口退场：它持有浮层登记与 nativeTheme 监听，
      // 不销毁就会赖在进程级路由表里 —— 而「单窗口唯一实例」那条兜底正是靠表里只剩
      // 一个实例才成立，残留实例会让它失效。
      // 通过 runtime 属性读取而非捕获下面的局部变量：管理器创建得比这一行晚
      // （见下方 createJsDialogManager），按值捕获会拿到 undefined。
      try { if (runtime.jsDialogManager) runtime.jsDialogManager.destroy() } catch (_) {}
      // 独立侧栏的两份视图（含远程页那个渲染进程）随窗口一起销毁 —— 不销毁就是
      // 一个再也用不到、却一直占着内存的渲染进程（"合理释放"）。
      try { if (runtime.webSidebar && typeof runtime.webSidebar.destroy === 'function') runtime.webSidebar.destroy() } catch (_) {}
      // 窗口退场钩子：会话分片清理等「按窗口」的收尾由 APPS 层负责
      try { if (typeof shared.onWindowClosed === 'function') shared.onWindowClosed(runtime) } catch (_) {}
    })

    if (isPrimary) {
      primaryRuntime = runtime
      shared.runtimeRegistry.setPrimary(runtime)
    } else {
      shared.runtimeRegistry.register(runtime)
    }
    // 建窗时一律隐藏（见上面 createMainWindow 的 show: false），是否在装配完成后显示由这里决定：
    // 只有调用方**显式** `show: false`（无头 / 测试 / 快照）才保持不显示，其余一律"就绪再显示"。
    runtime.showWhenReady = show !== false
    windows.push(runtime)
    // 把「manager 就位前建好的面板」这张待补挂名单交给运行单元：它在 open() 里创建
    // （createMainWindow 的端口要用），补挂动作发生在 mount() 里 —— 两段不是同一个作用域，
    // 所以只能经 runtime 传递（mount 拿到的正是这个对象）。
    runtime.pendingPanelJsDialog = pendingPanelJsDialog
    return runtime
  }

  /**
   * 晚段装配（共享服务必须已就绪）。
   * 幂等：重复调用只生效一次 —— 第二个窗口可重复触发而不会重复挂监听。
   */
  async function mount(runtime: BrowserWindowRuntime): Promise<BrowserWindowRuntime> {
    if (!runtime || runtime.__mounted) return runtime
    runtime.__mounted = true

    const { win, webContentsManager, layoutCoordinator, tabManager } = runtime
    const uiShellWebContents = win.webContents

    // ── 标签事件 → 本窗口 chrome ────────────────────────────────
    // 标签变化要刷新原生菜单的勾选态（固定/静音）。应用菜单是全局唯一的一份，
    // 因此由每个窗口各挂一次、共用一个合帧回调（见 main.js onWindowTabsChanged）。
    const onWindowTabsChanged = shared.onWindowTabsChanged
    if (typeof onWindowTabsChanged === 'function') {
      tabManager.on('tab:changed', () => onWindowTabsChanged())
    }

    // 导航开始即收起密码浮层的**瞬态卡**（跨文档导航会销毁页面 preload，页面侧来不及发 cancel）。
    // ⚠ 保存提示卡不收：它属于"用户还没做决定"的请求 —— 刷新 / 跳转都不该替用户决定，
    //   否则 pagehide 上报 → 本回调收卡，就成了一闪而过。
    // ⚠ 只对活动标签：后台标签的定时刷新不该打扰用户当前操作。
    tabManager.on('tab:loading', (payload: { tabId?: string } | null) => {
      if (!payload || payload.tabId !== layoutCoordinator.getActiveTabId()) return
      try { runtime.passwordOverlayController.hideTransient?.() } catch (_) {}
    })

    // JS 对话框覆盖：preload 注入 + sendSync 轮询（完全复刻 Hira）。
    // 按窗口持有 —— 对话框必须挂在**发起它的那个窗口**上方。
    //
    // ⚠ 通道不在这里注册：`createJsDialogManager` 只创建**按窗口**的状态实例并把
    // 自己登记进进程级协调器；`jsDialog:*` 通道由协调器**只注册一次**，再按发送方
    // （runtimeRegistry）路由到所属窗口的实例。旧实现每窗口各注册一遍 → 同一次弹窗
    // 被 N 套 handler 处理 → A 的 alert 同时挂在 A 与 B 上（见 js-dialog/index.js 说明）。
    const jsDialogManager = createJsDialogManager({
      // 让协调器按发送方解析到本窗口（解析不到时告警丢弃，不回落主窗口）
      runtimeRegistry: shared.runtimeRegistry as unknown as NonNullable<Parameters<typeof createJsDialogManager>[0]>['runtimeRegistry'],
      getParentWindow: () => win,
      // 强调色由组合根统一给出（与外壳 `--hira-accent` 同一真源，支持私密窗口皮肤）；
      // 端口缺失时退回"按系统明暗 + 出厂蓝"，保证对话框总能画出来。
      getAccentThemeInfo: () => {
        if (typeof shared.getAccentThemeInfo === 'function') {
          const info = shared.getAccentThemeInfo({ incognito: Boolean(runtime.incognito) })
          if (info) return info
        }
        const isDark = Boolean(nativeTheme.shouldUseDarkColors)
        return {
          isDark,
          accentColor: isDark ? '#0a84ff' : '#3b82f6',
          borderColor: isDark ? 'rgba(10,132,255,0.5)' : 'rgba(0,117,255,0.5)',
          inputFocusBorder: isDark ? 'rgba(10,132,255,0.7)' : 'rgba(0,117,255,0.7)'
        }
      }
    })
    runtime.jsDialogManager = jsDialogManager
    // 补挂「manager 就位之前就建好」的面板视图（见 open() 里 pendingPanelJsDialog 说明）。
    for (const { panelId, wc } of (runtime.pendingPanelJsDialog || []).splice(0)) {
      if (!wc || wc.isDestroyed()) continue
      try { jsDialogManager.attachToWebContents(wc, 'panel:' + panelId) } catch (_) {}
    }
    tabManager.on('tab:webcontents-ready', ({ webContents, tabId }: { webContents: WebContents; tabId: string }) => {
      jsDialogManager.attachToWebContents(webContents, tabId)
    })

    // ── 快捷键：本窗口的 chrome + 全部标签 webContents ──────────
    const keybindings = shared.keybindings
    if (keybindings && typeof keybindings.attach === 'function') {
      keybindings.attach(uiShellWebContents)
      for (const tab of tabManager.list()) {
        const wc = tabManager.getWebContents(tab.tabId)
        if (wc) keybindings.attach(wc)
      }
      tabManager.on('tab:webcontents-ready', ({ webContents }: { webContents: WebContents }) => {
        keybindings.attach(webContents)
      })
    }

    // ── 分阶段加载：ui-shell 优先（用户立即看到 navbar），rail/浮层后台 ──
    await webContentsManager.loadUiShell()
    // ★ 直到这一刻才让窗口出现 —— 这是「启动白屏闪烁」的根治点。
    //
    //   在此之前窗口一直隐藏（见 `open()` 里 createMainWindow 的 `show: false`），而
    //   `loadUiShell()` 等到的是 `did-finish-load`：外壳的 HTML / CSS / 首屏 DOM 都已就绪。
    //   于是用户**第一眼看到的就是完整界面**，而不是"先亮一块窗口底色、之后才长出 navbar"。
    //
    //   为什么放在这里、而不是等 rail 或首个标签：本文件下面那句注释就是设计意图 ——
    //   "ui-shell 优先（用户立即看到 navbar）"。外壳是界面的骨架，先让它可见最符合感知，
    //   rail 与网页内容随后各自补齐（它们本来就在后台加载）。
    if (runtime.showWhenReady !== false && !win.isDestroyed() && !win.isVisible()) {
      try { win.show() } catch (_) {}
    }
    // rail 后台加载，不阻塞后续启动流程。对齐 RT：3 个通用浮层 + 密码浮层
    // **不在启动期创建/加载** —— 首次真正显示时由 LayoutCoordinator 惰性创建，
    // 省掉启动期 4 个多余渲染进程。
    const railOverlayPromise = webContentsManager
      .loadRail()
      .catch((e: unknown) => console.error('[main] loadRail failed (non-fatal):', errorMessage(e)))

    const themeManager = shared.themeManager
    if (themeManager) await themeManager.applyToWebContents(uiShellWebContents).catch(() => {})
    layoutCoordinator.applyInitialLayout()

    // ⚠ 插件（app.plugins）**不在这里启动**。
    // 插件是**应用级**的：它们往进程级 ProviderRegistry 注册 provider / service，
    // 每个窗口跑一遍会直接撞上「Duplicate provider id」。而其中唯一与窗口相关的
    // 绑定（tabs-service 的 ctx.tabManager）用「按发送方解析」的代理即可正确工作
    // —— 见 main.js 里 scopedTabManager 的说明。因此插件只启动一次。

    await railOverlayPromise

    // 窗口完整就绪：APPS 层的「按窗口收尾」挂这里（会话分片跟踪等）。
    // 用钩子而不是让装配器自己认识会话 —— 装配器不认识任何领域对象。
    try { if (typeof shared.onWindowMounted === 'function') shared.onWindowMounted(runtime) } catch (e) {
      console.error('[window] onWindowMounted hook failed:', errorMessage(e))
    }
    return runtime
  }

  /** 开一个新窗口并立即完成晚段装配（共享服务已就绪时使用）。 */
  async function openAndMount(options: OpenWindowOptions = {}): Promise<BrowserWindowRuntime> {
    const runtime = open(options)
    await mount(runtime)
    return runtime
  }

  /**
   * 用户可见的「新窗口」（文件菜单 / Ctrl+N / 搜索栏踏板 / window.open）。
   *
   * ── 空间归属：沿用发起窗口的当前空间 ────────────────────────────
   * 对齐 RT：新浏览器窗口取 `spacesController.getLastUsed()`，即**当前空间**，
   * 而不是给它新建一个空间（那会在空间列表里堆出用户没主动创建过的条目）。
   * 窗口之间因此**共享空间、各自持有独立标签条** —— 与 RT 的
   * 「tab 带 windowId」是同一语义（NG 里 windowId 隐含在「哪个 TabManager」中）。
   *
   * ── 不恢复会话 ─────────────────────────────────────────────────
   * 新窗口开一个空白新标签页（Chrome 行为）。若在这里跑会话恢复，会把同一份
   * 空间会话再灌一遍，两个窗口出现重复标签。
   *
   * @param {object} [options]
   * @param {boolean} [options.incognito] 无痕窗口
   * @param {string} [options.url] 首个标签的地址；缺省用新标签页
   * @param {object} [options.opener] 发起方窗口运行单元（决定空间归属与新窗口的位置）
   * @param {boolean} [options.focus] 是否聚焦新窗口（默认 true）
   * @param {boolean} [options.skipInitialTab] 不建首个标签（**会话恢复专用**：
   *   调用方随后会把分片里的标签灌进来；restore 只做追加、不清空，因此必须先留空）
   */
  async function openNewWindow(options: NewWindowOptions = {}): Promise<BrowserWindowRuntime> {
    const {
      incognito = false,
      url,
      opener,
      focus = true,
      skipInitialTab = false,
      sessionFileName,
      bounds,
      profileId,
      spaceId
    } = options
    const source = opener && windows.includes(opener) ? opener : focused()

    // 本窗口自己的空间运行态：初始值取发起窗口的当前空间（没有发起方时用默认）。
    // 必须是**独立对象** —— 多窗口下每个窗口的 currentSpace 各管各的。
    let space: SpaceIdentity = { profileId: 'default', spaceId: 'default' }
    try {
      if (typeof shared.getWindowSpace === 'function') {
        const inherited = shared.getWindowSpace(source, { incognito })
        if (inherited) {
          space = {
            profileId: String(inherited.profileId || 'default'),
            spaceId: String(inherited.spaceId || 'default')
          }
        }
      }
    } catch (_) {}
    if (profileId) {
      space = {
        profileId: String(profileId),
        spaceId: String(spaceId || space.spaceId || 'default')
      }
    } else if (spaceId) {
      space.spaceId = String(spaceId)
    }
    let current = { ...space }
    const spaceRuntime = {
      getCurrent: () => ({ ...current }),
      setCurrent: (next: Partial<SpaceIdentity> = {}) => {
        current = {
          profileId: String(next.profileId || current.profileId || 'default'),
          spaceId: String(next.spaceId || current.spaceId || 'default')
        }
        return { ...current }
      }
    }

    const runtime = await openAndMount({ incognito, spaceRuntime, sessionFileName, bounds })
    try { runtime.tabManager.setCurrentSpace?.(current.profileId, current.spaceId) } catch (_) {}

    // 首个标签：无痕窗口走 TabManager 的无痕语义（defaultIncognito 已接管），
    // 因此这里统一调 newTab 即可。
    if (!skipInitialTab) {
      let startUrl = url
      if (!startUrl && typeof shared.getNewTabUrl === 'function') {
        // 带上 incognito：无痕窗口的新标签页必须是内置页（它的会话不加载扩展）
        try { startUrl = shared.getNewTabUrl({ incognito, profileId: space.profileId }) } catch (_) {}
      }
      try {
        await runtime.tabManager.newTab({ url: startUrl || 'about:blank' })
      } catch (e) {
        console.error('[window] new window first tab failed:', errorMessage(e))
      }
    }

    if (focus) {
      try { runtime.win.focus() } catch (_) {}
    }
    console.log('[window] opened new browser window #%d%s', runtime.ordinal, incognito ? ' (incognito)' : '')
    return runtime
  }

  /** 当前有焦点的浏览器窗口；无焦点（如子窗口持有焦点）时回退 primary。 */
  function focused(): BrowserWindowRuntime | null {
    try {
      const { BrowserWindow } = require('electron')
      const win = BrowserWindow.getFocusedWindow()
      if (win) {
        for (const runtime of windows) {
          if (runtime.win && !runtime.win.isDestroyed() && runtime.win.id === win.id) return runtime
        }
      }
    } catch (_) {}
    return primaryRuntime || windows[0] || null
  }

  /** primary 运行单元（IPC 解析兜底 / 单窗口路径）。 */
  function primary(): BrowserWindowRuntime | null {
    return primaryRuntime || windows[0] || null
  }

  /** 全部已装配窗口（主题广播、设置 applier 等需要遍历）。 */
  function all(): BrowserWindowRuntime[] {
    return windows.slice()
  }

  /**
   * 「全部窗口」聚合口的通用构造 —— 供**定时 / 全局任务**使用（自动休眠、内存回收、
   * 后台节流、主题/布局 applier…）。这些任务不在任何 IPC 上下文里跑，
   * `scoped()` 会一律解析到主窗口，于是第二个窗口永远收不到效果 ——
   * 典型的「功能看着在、其实只覆盖一个窗口」。
   *
   * @param {string} member 运行单元上的成员名（'tabManager' / 'layoutCoordinator' …）
   * @param {object} [opts]
   * @param {string[]} [opts.fanoutMethods] 必须**逐窗口执行并合并返回值**的方法
   * @param {string[]} [opts.mergedKeys] 合并时按数组拼接的字段名（其余字段取最后一个窗口）
   * @param {string[]} [opts.unionMethods] 返回数组、需跨窗口取并集的方法（如 tabManager.list）
   * @param {boolean} [opts.defaultAll] 未列出的方法是否也逐窗口执行（**状态设置类**用，
   *   如 layoutCoordinator.setTabTheme —— 主题必须同时作用到每个窗口）。
   *   默认 false：未知方法只作用于焦点窗口（**动作类**用，如 tabManager.switchTo，
   *   逐窗口执行会把「切标签」在别的窗口上再演一遍）。
   */
  function fanout(member: 'tabManager' | 'layoutCoordinator', opts: FanoutOptions = {}): Record<string, (...args: unknown[]) => unknown> {
    const fanoutMethods = new Set(opts.fanoutMethods || [])
    const mergedKeys = new Set(opts.mergedKeys || [])
    const unionMethods = new Set(opts.unionMethods || [])
    const defaultAll = opts.defaultAll === true
    type CallableOwner = Record<string, (...args: unknown[]) => unknown>
    return new Proxy<Record<string, (...args: unknown[]) => unknown>>(
      {},
      {
        get(_target, prop: string | symbol) {
          if (typeof prop !== 'string') return undefined
          return (...args: unknown[]): unknown => {
            const owners: CallableOwner[] = all().flatMap((rt) => {
              const owner = rt[member]
              return owner && typeof owner === 'object' ? [owner as unknown as CallableOwner] : []
            })
            if (unionMethods.has(prop)) {
              return owners.flatMap((owner) => {
                try {
                  const value = owner[prop]?.(...args)
                  return Array.isArray(value) ? value : []
                } catch (_) { return [] }
              })
            }
            if (fanoutMethods.has(prop)) {
              const merged: Record<string, unknown> = {}
              for (const owner of owners) {
                let result: unknown
                try { result = owner[prop]?.(...args) } catch (err) {
                  console.error(`[window] ${member}.${prop} failed:`, errorMessage(err))
                  continue
                }
                if (!result || typeof result !== 'object') { merged.last = result; continue }
                for (const [key, value] of Object.entries(result)) {
                  if (mergedKeys.has(key) && Array.isArray(value)) {
                    const previous = merged[key]
                    merged[key] = Array.isArray(previous) ? [...previous, ...value] : [...value]
                  }
                  else merged[key] = value
                }
              }
              return merged
            }
            // 未列出的方法：动作类只作用于**焦点窗口**（与快捷键、应用菜单同一判定口）；
            // 状态设置类（defaultAll）则逐窗口执行，取最后一个返回值。
            if (defaultAll) {
              let last: unknown
              for (const owner of owners) {
                try { last = owner[prop]?.(...args) } catch (err) {
                  console.error(`[window] ${member}.${prop} failed:`, errorMessage(err))
                }
              }
              return last
            }
            const rt = focused()
            const owner = rt ? rt[member] as unknown as CallableOwner : null
            return owner ? owner[prop]?.(...args) : undefined
          }
        }
      }
    )
  }

  /** 标签条聚合口（定时批量回收 + 全窗口标签并集）。 */
  function tabsFanout() {
    return fanout('tabManager', {
      // 两条回收腿都必须逐窗口执行：漏登记一个，多窗口下那条腿就只覆盖焦点窗口
      //（典型的「功能看着在、其实只作用一个窗口」）。
      fanoutMethods: ['sleepInactive', 'archiveInactive'],
      mergedKeys: ['slept', 'archived', 'skipped'],
      // list 返回裸数组，要跨窗口合成一份。
      unionMethods: ['list']
    })
  }

  /** 布局协调器聚合口：主题 / 侧栏位置这类**状态设置**要作用于全部窗口。 */
  function layoutFanout() {
    // `unionMethods`：这几个方法每个窗口各回一个**裸数组**，拼成一份才有意义
    //（回收浮层 / 面板的清单要覆盖所有窗口，不是只看最后一个窗口）。
    return fanout('layoutCoordinator', {
      defaultAll: true,
      unionMethods: ['reclaimIdleFloatViews', 'reclaimIdlePanelViews']
    })
  }

  return {
    open,
    mount,
    openAndMount,
    openNewWindow,
    tabsFanout,
    layoutFanout,
    focused,
    primary,
    all,
    get size() { return windows.length }
  }
}

// 收录工具对外导出：应用菜单 / 快捷键 / 命令链（`note:*` 动作层）直接调它们 ——
// 这样"页面右键 / 应用菜单 / 快捷键 / 命令链"所有主进程入口共用**同一套落点解析与
// 抓图降级口径**，而不是各自再实现一份"未归档 / 集锦 / 新建集锦"的落点判定。
// 四个 kind（page / image / selection / link）各自一个函数，调用方只选 kind，不复制规则。
module.exports = {
  createBrowserWindowAssembly,
  capturePageIntoCollection,
  captureImageIntoCollection,
  captureSelectionIntoCollection,
  captureLinkIntoCollection
}

export type { OpenWindowOptions, NewWindowOptions, SpaceIdentity, SpaceRuntimePort }
export type { CollectionTarget }
