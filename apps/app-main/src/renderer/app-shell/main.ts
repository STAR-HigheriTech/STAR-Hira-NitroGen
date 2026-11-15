import { tabsClient, panelsClient, layoutClient, bookmarksClient, settingsClient, extensionsClient, onFeaturesChanged, isFeatureAvailable } from '../shared/hira-client.js'
import { IPC_EVENTS, IPC_ROUTES } from '@hira-ng/shared-types/src/ipc-channels.mjs'
import type { PluginOverlayHidePayload, PluginOverlayRecord } from '@hira-ng/shared-types/src/plugin-overlay.mjs'
// 快捷键的**唯一真源**（默认键位 + 动作名 → 键位的映射）。菜单只是把「当前生效值」
// 读出来显示，不另抄一份。
import { KEYBINDING_DEFAULTS, menuAccelerator } from '@hira-ng/shared-types/src/keybindings.mjs'
// 内部页身份（叫法 / 地址 / 一级菜单成员）的唯一真源 —— 与公共侧栏、应用菜单、
// 设置页「内部页面」分区是同一张表，菜单里不再手抄页面名。
import { NAVBAR_PAGE_ENTRIES, NAVBAR_FEATURE_ENTRIES, MORE_PAGES_HOST, pageFeature, pageLabel, pageMenuLabel, pageUrl } from '@hira-ng/shared-types/src/pages.mjs'
// 主页模式的键名真源（与主进程 home-url.js / 设置页同源），用于监听变更后重判地址栏。
import { STARTUP_SETTING_KEYS } from '@hira-ng/shared-types/src/startup.mjs'
import { BOOKMARKBAR_SETTING_KEY } from '@hira-ng/shared-types/src/bookmarkbar.mjs'
// 编辑 role → 中文菜单名的唯一真源（与应用菜单、网页右键共用一份）。
import { editMenuItem } from '@hira-ng/shared-types/src/edit-menu.mjs'
// 目录项的**打开语义**（面板 or 子窗口）—— 与 rail 共用同一条判据，不各写一份
import { openCatalogEntry, findCatalogEntry } from '../shared/entry-action.js'
import { pluginsClient } from '../shared/plugins-client.js'
// 官方插槽的渲染侧客户端（navbar 插件按钮 / 标签动作都从这里取实现）。
import { slotsClient } from '../shared/slots-client.js'
import { getHiraBridge } from '../shared/bridge.js'
// 外壳的键盘焦点哨兵：上报「外壳是否在吃键盘」+ 点外壳空白处时请求把焦点还给网页。
// 与主进程 LayoutCoordinator#restoreContentFocus 配套，是「点标签栏后网页失焦」的修复点。
import { installFocusSentinel } from './focus-sentinel.js'
import { menuClient } from '../shared/menu-client.js'
import { createTabRowMenuFactory } from '../shared/tab-row-menu.js'
import { createThemeController } from '../shared/theme-controller.js'
import { createBookmarkController } from '../controllers/bookmark-controller.js'
import { createPwaInstallController } from '../controllers/pwa-install-controller.js'
import { pwaClient } from '../shared/pwa-client.js'
import { createSearchController } from '../controllers/search-controller.js'
import { createOverlayAdapter } from '../controllers/overlay-adapter.js'
import { createPermissionState } from '../controllers/permission-state.js'
// 权限类型 → 图标键名（纯数据真源，与浮层/面板/内部页共用；这里只做键名 → 标签标记）。
// F-0667 的类型映射只此一份 —— 标签标记不另写一套 switch。
import { permissionIcons } from '@hira-ng/shared-types/src/permission-labels.mjs'
import { createTabSessionController } from '../controllers/tab-session-controller.js'
import { createKeyboardShortcutsController } from '../controllers/keyboard-shortcuts-controller.js'
import { createWindowLayoutController } from '../controllers/window-layout-controller.js'
import { createChromeLayoutController } from '../controllers/chrome-layout-controller.js'
// 系统原生窗口按钮（WCO）在渲染层的唯一感知点：要不要自绘 + 让出系统按钮占宽
import { createWindowControlsOverlay } from './wco.js'
import { createSpaceController } from '../controllers/space-controller.js'
import { createSidebarSurface, injectSidebarSurfaceStyles } from '../shared/sidebar-surface.js'
import { defineRendererSlots, reduceRendererSlot, callRendererSlot, callRendererSlotMulti, activateRendererSlots } from '../shared/plugin-slots.js'
import { injectNavbarStyles, createNavbar, createActionButton, NAV_INTENT, type NavIntentPayload, type PanelCatalogEntry as NavbarPanelCatalogEntry } from '@hira-ng/ui-navbar'
import { injectChromeLayoutStyles, createChromeLayout } from '@hira-ng/ui-chrome-layout'
import { createSplitSurface } from '../shared/split-surface.js'
// 独立侧栏的聚焦框渲染点 —— 与分屏那份**刻意分开的两个模块**（见各自文件头）
import { createWebSidebarSurface } from '../shared/web-sidebar-surface.js'
// 速览装饰面：外环阴影 + 蓝聚焦框（外壳 DOM 画的第三个装饰层，原理见该文件头）。
import { createGlanceSurface } from '../shared/glance-surface.js'
// 独立侧栏的宽度写口 —— 聚焦框那个浮层顺带画**调宽把手**，拖它要经这条客户端落库
import { webSidebarClient } from '../shared/web-sidebar-client.js'
import { injectTitlebarStyles, createTitlebar } from '@hira-ng/ui-titlebar'
import {
  resolvePanelOrder,
  buildCatalog,
  panelEntryToCatalogItem,
  setChromeDragSuppressed,
  setOverlayDragSuppressed,
  filterCatalogByAvailability,
  createNavHistoryMenu,
  iconByName,
  CHROME_BUTTONS,
  FIRST_RUN_LAYOUT,
  Puzzle,
  type MenuItem,
  type MenuPopPayload,
  type PopMenu,
  type CatalogItem,
  type NavHistorySnapshot
} from '@hira-ng/ui-common'
import { createSpaceSwitcher } from '@hira-ng/ui-space-switcher'
import {
  LAYOUT_SETTING_KEYS,
  SIDEBAR_WIDTH_MIN,
  SIDEBAR_WIDTH_MAX,
  SIDEBAR_WIDTH_DEFAULT,
  normalizeRailPosition,
  normalizeRailHorizontalAlign,
  normalizeRailVerticalAlign,
  normalizeRailPinned,
  resolveRailPanelSide
} from '@hira-ng/shared-types/src/layout.mjs'
// 外壳按钮列设置键名的真源（与 rail / 按钮编辑浮层共用一份）。
import { SHELL_BUTTON_SETTING_KEYS } from '@hira-ng/shared-types/src/shell-buttons.mjs'
// URL → 站点信息的**唯一解析口径**（浏览器锁图标与权限面板的站点卡共用）；
// isSameSite 同样是唯一判据 —— 浮层过滤「本站」请求不另写一份域名比较。
import { siteInfoOfUrl, isSameSite, type SiteInfo } from '@hira-ng/shared-types/src/site.mjs'
import type { PanelCatalogEntry } from '../shared/panels-client.js'
import type { SlotRenderItem } from '../shared/slots-client.js'
import { injectBookmarkbarStyles } from '@hira-ng/ui-bookmarkbar'
import { injectTabbarStyles, type TabbarProjection, type TabbarRendererSlots } from '@hira-ng/ui-tabbar'
import { injectWebviewsShellStyles, createWebviewsShell } from '@hira-ng/ui-webviews'
import { injectDownloadBarStyles } from '@hira-ng/ui-download-bar'
import { createDownloadController } from '../controllers/download-controller.js'
// 下载红点的唯一驱动（与 rail 共用同一份事件 + 去重逻辑，见该文件头）。
import { createDownloadActivityWatcher } from '../shared/download-activity.js'
import { createExtensionsToolbarController } from '../controllers/extensions-toolbar-controller.js'
// 跨窗口标签同步（A5 / J15）的截图占位渲染点
import { injectTabSyncPlaceholderStyles, createTabSyncPlaceholder } from '../controllers/tab-sync-placeholder.js'
import { injectModalStyles, createModalManager } from '@hira-ng/ui-modal'
import '@hira-ng/shared-ui-tokens/tokens-base.css'
import '@hira-ng/shared-ui-tokens/layers.css'
import '@hira-ng/shared-ui-tokens/tokens-light.css'
import '@hira-ng/shared-ui-tokens/tokens-dark.css'
import '@hira-ng/shared-ui-tokens/components.css'

type UnknownRecord = Record<string, unknown>

interface AppShellTab {
  tabId?: string | null
  url?: string
  title?: string
  favicon?: string
  loading?: boolean
  canGoBack?: boolean
  canGoForward?: boolean
  [key: string]: unknown
}

interface SiteIdentityRuntimeState {
  site: SiteInfo | null
  tab: AppShellTab | null
  tabId: string | null
  open: boolean
  pending: number
  hasRules: boolean
}

function asRecord(value: unknown): UnknownRecord | null {
  return value !== null && typeof value === 'object' ? value as UnknownRecord : null
}

function asStringRecord(value: unknown): Record<string, string> | null {
  const record = asRecord(value)
  if (!record) return null
  return Object.fromEntries(
    Object.entries(record).filter((entry): entry is [string, string] => typeof entry[1] === 'string')
  )
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

window.addEventListener('error', (e) => {
  console.error('[app-shell] window.error:', e.message, e.filename, e.lineno, e.colno)
})
window.addEventListener('unhandledrejection', (e) => {
  console.error('[app-shell] unhandledrejection:', e.reason)
})

console.log('[app-shell] starting, root present:', !!document.getElementById('root'))

/**
 * 主题背景层（**窗口面**）：主题带背景时铺在最底层，chrome 各层在它之上。
 *
 * 为什么是独立的一层、而不是给 body 设 background：body 的背景会被 chrome 各块
 * （#chrome-top / #chrome-side… 都有自己的底色）整片盖住，什么也看不见。
 * 单独一层 + 在"有背景"时把 chrome 各块的底色放开（见下面的 CSS），
 * 背景才真正"从界面里透出来" —— 这正是 Vivaldi 主题里背景的呈现方式。
 */
const chromeThemeBackground = document.createElement('div')
chromeThemeBackground.id = 'chrome-theme-background'
chromeThemeBackground.setAttribute('aria-hidden', 'true')
/* 内层：图片本体（主题控制器把 background-* / opacity / filter 写在这上面）。
   外层负责固定定位与主题切换过渡；壁纸自身的 blur 只在控制器写入的内层生效。 */
const chromeThemeBackgroundImage = document.createElement('div')
chromeThemeBackgroundImage.id = 'chrome-theme-background-image'
chromeThemeBackground.appendChild(chromeThemeBackgroundImage)
const shellBody = document.body
if (!shellBody) throw new Error('[app-shell] document body is unavailable')
shellBody.insertBefore(chromeThemeBackground, shellBody.firstChild)

const themeController = createThemeController({
  document,
  bridge: getHiraBridge(),
  backgroundTarget: chromeThemeBackgroundImage,
  backgroundScope: 'window'
})
themeController.start()

const root = document.getElementById('root')
if (!(root instanceof HTMLElement)) throw new Error('[app-shell] root element is unavailable')
const disposers: Array<() => void> = []
let disposed = false
let buttonsEditActive = false

function addDisposer(dispose: () => void): () => void {
  disposers.push(dispose)
  return dispose
}

function disposeAppShell() {
  if (disposed) return
  disposed = true
  while (disposers.length) {
    const dispose = disposers.pop()
    if (!dispose) continue
    try { dispose() } catch {}
  }
}

window.addEventListener('pagehide', disposeAppShell, { once: true })
addDisposer(() => themeController.dispose())

// 系统原生窗口按钮（原生 WCO）：启动即问一次窗口自己（见 ./wco.js 的说明）。
// 必须在 createNavbar（下方）之前建 —— 它决定"要不要自绘那三颗按钮"。
const windowControlsOverlay = createWindowControlsOverlay(document)
addDisposer(() => windowControlsOverlay.dispose())

const style = document.createElement('style')
style.textContent = `
  html, body, #root {
    height: 100%;
    width: 100%;
    margin: 0;
    padding: 0;
    background: transparent;
    color: var(--text-color);
    /* 字体栈走唯一令牌（shared-types/theme.mjs#UI_FONT_STACK）；兜底串与它同值。 */
    font-family: var(--hira-font-ui, "Segoe UI Variable Text", "Segoe UI Variable", "Segoe UI", "Microsoft YaHei UI", "Microsoft YaHei", "PingFang SC", "Noto Sans SC", system-ui, -apple-system, sans-serif);
    overflow: hidden;
  }

  /* ── 主题背景层（窗口面）──────────────────────────────────────────────
   * 固定铺满、位于最底。body / #root 都是透明的，所以它透得出来。
   * 只做 opacity 与 background-* 的赋值，不需要任何 layout ——
   * 背景是**静态**的，换主题才写一次，不在滚动/悬停路径上（流畅优先）。
   * 这一层不参与命中测试（pointer-events:none），免得挡住 chrome 上的拖拽区与点击。
   *
   * 壁纸模糊（background.blur）只写在内层，没有全局最低值；UI 模糊是另一条链，
   * 只挂在 chrome 的玻璃区域上（见下面 backdrop-filter 那段）。两档参数互不夹取。
   */
  #chrome-theme-background {
    position: fixed;
    inset: 0;
    pointer-events: none;
    /* 这层在定义上就是"在所有图层之下"—— 用语义负层 backdrop（见 layers.css）。
       chrome 各块是普通流（base 层），因此背景能透在它们之下而不遮住任何东西。 */
    z-index: var(--hira-z-backdrop);
  }
  /* 真的画着壁纸时才启用背景合成提示：没有壁纸时这一层是空的。

     ⚠ 判据是 data-theme-wallpaper（"本视图真的有背景图"），**不是**
       data-theme-background（那是"是不是玻璃" = 壁纸 **或** 窗口材质）。
       两者由 theme-controller.js 一起写，分工也在那里写明。为什么这里必须用前者：
       开了亚克力/Mica 但**没选壁纸**时，这一层里没有任何像素可画 —— 用 glass 当判据
       会让这类用户白白背着一个被提升的全窗层。

     ⚠ will-change **必须**跟着这条判据一起进来（曾经写在上面那条无条件规则里）：
       它会把这层提升成一个**全窗尺寸的合成层**并常驻一张全窗纹理 —— 无论主题到底
       有没有背景、这层是不是空的。2560×1440@2x 下那是近百 MB 显存，外加每帧一次
       全窗合成。这正是"没开壁纸也一直有莫名占用、标签动画还会掉帧"的来源（合成器
       每帧多背一块全窗 quad，动画帧就越容易被挤掉）。
       现在：无壁纸 → 这一层不参与合成（空 div 不绘制、零纹理）；有壁纸 → 才给提示。
       只留 opacity：壁纸模糊已经移交给内层，这里只提前声明主题切换时的淡入，
       让那一次切换不掉帧。 */
  html[data-theme-wallpaper='1'] #chrome-theme-background {
    will-change: opacity;
  }
  /* 内层：图片本体 + 它自己的透明度/模糊（由主题控制器内联写）。 */
  #chrome-theme-background-image {
    position: absolute;
    inset: 0;
  }

  /* 有背景时把 chrome 各块的底色放开，让背景透出来。
     ⚠ 这是**唯一**一处"背景存在 → chrome 变透明"的开关：由主题控制器写的
       html[data-theme-background] 驱动，不靠猜 CSS 变量的值。
     注意 chrome-root / chrome-content 不在这份名单里：root 是布局容器、自己没有底色，
     content 改铺**玻璃色**（见下面那段），那是本窗口的染色层。 */
  html[data-theme-background='1'] #chrome-side,
  html[data-theme-background='1'] #chrome-main,
  html[data-theme-background='1'] #chrome-top,
  html[data-theme-background='1'] #chrome-bottom {
    background: transparent;
  }

  /* ── chrome 玻璃（Vivaldi 的"工具栏透出壁纸 + 毛玻璃"）────────────────
   * ⚠ 本段也是 CSS 模板字符串的一部分，注释里同样**不能出现反引号**。
   *
   * 分工（**染色各带一份、UI 模糊只作用于 UI 玻璃面**）：
   *   ① 染色：工具栏 / 内容区 / **侧栏区**一律用 --hira-chrome-bg，就一层遮罩色；
   *   ② UI 模糊：只写在下面这组 chrome 容器上（--hira-ui-blur）。壁纸层本身不挂
   *      UI 模糊，因此背景图可以独立调到 0，UI 层仍保有可读性下限。
   *   ③ 各 chrome 块自己的底色来自 --main-bg-color，带壁纸时该变量是
   *      **transparent**（不是半透明！）—— 半透明会**逐层叠加**：
   *      navbar → tabbar → 标签条是三层嵌套，0.55 叠三层就成了 0.91，越深越不透。
   *
   * ⚠ **"面板遮罩"那根旋钮不在这里**：它只作用于**面板**
   *   （下载 / 历史 / 书签…那几条侧栏面板），由面板自己的视图铺（见
   *   ui-common#injectPanelStyles）—— 侧栏区（垂直标签栏）与 rail 都属 chrome UI，
   *   跟随的是上面那对 chrome 值。曾经把 --hira-panel-bg 铺在 #chrome-side 上，
   *   结果"调面板旋钮把侧栏区也改了"（用户明确指正过）。
   *
   * 为什么每带各铺一片**染色**（而不是整窗一片）：区域之间**互不重叠**（mid 里的 side
   * 与 content 是并排的两个孩子），每处恰好一层 ⇒ 不会叠出深浅不一；而"只加在那几条
   * 带上"又会漏掉 rail（它住在 #chrome-content 的矩形里，见下条）。
   *
   * ⚠ 侧栏**收起**时 rail 会浮在内容区之上（此时 #chrome-side 宽度为 0）——
   * 所以 chrome-content 也要有同一层染色（否则 rail 那一条没有底色）。 */
  html[data-theme-background='1'] #chrome-top,
  html[data-theme-background='1'] #chrome-bottom,
  html[data-theme-background='1'] #chrome-side,
  /* 主列里那两段**给侧栏让位**的行（书签栏住在里面）也必须在这份名单里 ——
     它们不在 #chrome-content 的矩形里，漏一条就是"这一条横带没有遮罩/玻璃色"
     （用户实测："书签栏还是没有遮罩"，就是这一条漏了）。 */
  html[data-theme-background='1'] #chrome-main-top,
  html[data-theme-background='1'] #chrome-main-bottom,
  html[data-theme-background='1'] #chrome-content {
    background: var(--hira-chrome-bg);
  }

  /* UI 玻璃层：按 top / body / bottom 三块合成，不把 filter 压到壁纸层。
     body 同时覆盖侧栏与内容洞，面板是透明视图，透出的就是这里已经合成好的 UI 层。
     三块而不是每个 chrome 子容器各一份，避免重复 backdrop 采样。 */
  html[data-theme-wallpaper='1'] #chrome-top,
  html[data-theme-wallpaper='1'] #chrome-bottom,
  html[data-theme-wallpaper='1'] #chrome-body {
    -webkit-backdrop-filter: blur(var(--hira-ui-blur, var(--hira-chrome-blur, 10px)));
    backdrop-filter: blur(var(--hira-ui-blur, var(--hira-chrome-blur, 10px)));
  }

  /* ── 网页视图四周那圈间隙（4px inset）必须**显式**填 chrome 底色 ──────────
   * ⚠ 注意：本段是 CSS 模板字符串的一部分，注释里**不能出现反引号**（会提前闭合字符串）。
   *
   * 这圈缝的几何：#chrome-content 是"内容洞"，网页的原生视图被主进程按
   * _contentPadding 四边内缩 4px 放进它 —— 于是这 4px 落在 #chrome-content
   * 自己的盒子里，它的背景就是这个缝的颜色。
   *
   * 为什么不能靠"透明 + 底下那层"：
   *   ① 深色令牌里 body.dark 把 --main-bg-color 设成 transparent（旧设计是要让
   *      **原生窗口表面**从缝里透出来），而缝的下方依次是 #chrome-theme-background、
   *      原生窗口底色 —— 于是"缝的颜色"实际由**主进程设置的表面色**决定，
   *      与 navbar 用的 --main-bg-color 成了两条独立的取值链，深色主题下必然出现
   *      "navbar 是一种色、缝是另一种色"；
   *   ② 主题带壁纸时又要把这层让开（见上面那条 data-theme-background 规则）。
   * 所以这里显式铺 --main-bg-color —— 与 navbar / tabbar / 侧栏**同一个变量**，
   * "缝与 chrome 同色"从此是构造保证，而不是两个地方各取一次值碰巧相等。
   * 壁纸存在时上面那条更高特异性的规则会把本行覆盖回 transparent，语义不变。 */
  #chrome-content {
    background: var(--main-bg-color);
  }
`
document.head.appendChild(style)
injectNavbarStyles(document)
injectChromeLayoutStyles(document)
injectBookmarkbarStyles(document)
injectTabbarStyles(document)
injectWebviewsShellStyles(document)
injectDownloadBarStyles(document)
injectModalStyles(document)

// 独立浮层图层适配器：searchbar 下拉 / tab preview / permission 弹窗渲染在
// 各自独立的 overlay webContents view，tab 网页始终可交互。
// 实现抽到 controllers/overlay-adapter.js（含兼容旧 overlay DOM API）。
const overlayClient = createOverlayAdapter({
  provider: getHiraBridge().provider,
  document
})
addDisposer(() => overlayClient.dispose())

/**
 * 下拉行「永久删除」→ 落到哪个 IPC。
 *
 * 浮层只报 `action + id`（它不摸数据库、也不该知道历史表长什么样）；
 * 删除**哪种实体**由外壳裁定。新增一类可删的行 = 在这张表里加一行。
 */
const REMOVE_OVERLAY_ACTIONS = Object.freeze({
  'remove-search-history': 'search:remove-history-entry', // 搜索词历史
  'remove-history': 'history:remove' // 浏览历史（按聚合行 id）
})

// 监听 overlay renderer 回传的 commit/action（经主进程转发）
// searchbar dropdown 用户点击 suggestion → 转为导航
addDisposer(getHiraBridge().on.subscribe('overlay:commit', (payload: UnknownRecord) => {
  if (disposed) return
  if (!payload) return
  if (payload.kind === 'searchbar' && payload.suggestion) {
    const s = asRecord(payload.suggestion)
    if (!s) return
    // `open-tab` 候选（零输入建议里的"已打开标签"）语义是**回到那一页**，不是再开一个 ——
    // 所以直接切标签；压成 navigate 会重复开出一个新标签（正是改造前的表现）。
    if (s.type === 'open-tab' && s.tabId) {
      tabsClient.switchTab(String(s.tabId))
      return
    }
    let url = ''
    if ((s.type === 'search' || s.type === 'website') && typeof s.url === 'string') url = s.url
    else if (s.type === 'calc') url = searchController.buildUrl(String(s.result))
    // 即时答案：有出处就打开出处；纯答案（无 url）回落到"用原问题搜索"，
    // 与 ui-searchbar#suggestionToUrl 同一语义（键盘回车走那条，鼠标点击走这条）。
    else if (s.type === 'instant-answer') {
      url = typeof s.url === 'string'
        ? s.url
        : (s.query ? searchController.buildUrl(transformOmnibarInput(String(s.query))) : '')
    }
    // 「询问 AI」：建议自带深链，宿主只做导航（AI 页面自己消费 `?ask=`）。
    else if (s.type === 'ai-ask') url = typeof s.url === 'string' ? s.url : ''
    if (url) tabsClient.navigate({ url })
    else if (s.type === 'pedal') getHiraBridge().provider.invoke('omnibox:action', { action: s.action }).catch(() => {})
  } else if (payload.kind === 'overlay-action' && typeof payload.action === 'string' && REMOVE_OVERLAY_ACTIONS[payload.action as keyof typeof REMOVE_OVERLAY_ACTIONS] && payload.id) {
    // 下拉里「删除」的两种实体（搜索词历史 / 浏览历史）：浮层只报 action + id，
    // 落到哪个 IPC 见 REMOVE_OVERLAY_ACTIONS。
    // 落库成功后**让地址栏重查一次建议**：真源是 ui-searchbar 的 currentSuggestions，
    // 浮层那份只是渲染快照 —— 不重查的话，方向键 + 回车会提交到刚删掉的那一条。
    getHiraBridge().provider.invoke(REMOVE_OVERLAY_ACTIONS[payload.action as keyof typeof REMOVE_OVERLAY_ACTIONS], { id: payload.id })
      .then(() => { if (typeof shell.refreshSuggestions === 'function') shell.refreshSuggestions() })
      .catch(() => {})
  } else if (payload.kind === 'overlay-action' && payload.action === 'edit-bookmark' && payload.url) {
    // 地址栏下拉里书签行右侧的「编辑」：浮层只报事实（url/title），
    // 子窗口类型与载荷形态由外壳决定 —— 与书签栏 / 星标走**同一个**编辑器。
    // 先收起下拉（含地址栏侧的「当前建议」缓存），否则下次聚焦地址栏会把它原样弹回来。
    if (typeof shell.hideSuggestions === 'function') shell.hideSuggestions()
    getHiraBridge().provider.invoke('window:open', {
      type: 'edit-bookmark',
      payload: { url: payload.url, title: payload.title || '' }
    }).catch(() => {})
  } else if (payload.kind === 'siteinfo-dismiss') {
    // 浮层里按 Esc / 点了卡片外的留白 → 收起。焦点交还地址栏（与点按钮关闭同语义）。
    closeSiteInfo({ restoreFocus: true })
  } else if (payload.kind === 'siteinfo-action') {
    // 浮层只报事实（action），**去向**由本文件裁定：面板深链 / 内部页 / 收起。
    // 新增动作只需在这里补一条 —— 浮层不知道面板 id、不知道 hira:// 路由。
    handleSiteInfoAction(typeof payload.action === 'string' ? payload.action : '')
  } else if (payload.kind === 'permission') {
    // 权限申请浮层只报意图（id + allow + persist），**响应策略**留在外壳：
    // 复用侧栏权限面板同一条 `permission:respond`。persist 由用户点的那一档决定
    // （「一次」只在本次会话内生效、「始终」写库）—— 外壳**不替用户改判**，
    // 否则四档按钮就退化成了两档，用户没做过的决定会被写进权限库。
    // 响应后主进程会推 `permission:cleared` → permission-state 刷新 →
    // syncPermissionOverlay 发现列表清空自动收起浮层（浮层自己不必管开合）。
    //
    // ⚠ 但**事件不是唯一通道**：本地角标（聚合按钮上的待处理数）与规则圆点都由本文件
    // 维护，只在 `permission:cleared` 上刷新会留下"按钮还挂着通知、实际已经表态完"的
    // 形态（事件丢失 / 归属窗口解析不到时就是这样）。所以成功后**主动**再对齐一次：
    // 全量拉 pending（角标一定归零）+ 重查本站规则（选「始终」档时刚落的库要立刻点亮圆点）。
    // 代价是一次用户点击里的两次 IPC —— 可以忽略；换来的是按钮上的事实与主进程一致。
    getHiraBridge().provider.invoke(IPC_ROUTES.permissionRespond, {
      id: payload.id,
      allow: payload.allow === true,
      persist: payload.persist === true
    }).then((result) => {
      // `{ ok:false }` 是**正常 resolve 的失败**（这条 pending 已不在主进程：
      // 已被别处响应 / 页面导航销毁）。本地必须与主进程真值对齐，否则死请求会一直挂在
      // 浮层上 —— 用户看到的就是「点了允许，什么都没发生」。
      if (permissionState) permissionState.refresh()
      if (result && result.ok === false) return
      // 成功：权限库可能刚多/少了一条规则（「始终」两档）→ 聚合按钮的规则圆点跟上来。
      refreshSiteRules()
    }).catch((error) => {
      console.error('[overlay] permission:respond failed:', error)
      if (permissionState) permissionState.refresh()
    })
  } else if (payload.kind === 'permission-open-panel') {
    // 权限申请浮层末尾那条「还有 N 项 · 转到权限面板」：浮层只报动作，
    // **面板 id 与展开侧在这里定** —— 与站点信息浮层的 open-permissions 同一落点、同一侧
    // （浮层贴在地址栏左端，面板也在左侧就地展开，视线不横跳）。省略行本身不带 id，
    // 因为它不该认识面板目录（见 permission-overlay/main.js#openPermissionsPanel）。
    openPanelFromOverlay('permissions-panel', { side: 'left' })
  } else if (
    payload.kind === 'target-picker-select' ||
    payload.kind === 'target-picker-dismiss' ||
    payload.kind === 'target-picker-open-panel'
  ) {
    // 通用「选择目标」浮层的回传（选中 / 点外部 / 滚轮 / Esc / 转到面板）→ 交给**打开它的那一方**。
    // 浮层只回传事实（source + pickerId + 选中值或 panelId），开合状态住在打开方；
    // 目前只有书签栏文件夹下拉用它（「收进集锦」已改为原生右键子菜单）。
    if (bookmarkController && bookmarkController.handleTargetPickerCommit(payload)) return
  }
}))
addDisposer(getHiraBridge().on.subscribe(IPC_EVENTS.overlayAction, (payload) => {
  if (disposed) return
  console.log('[overlay] action:', payload)
}))

/**
 * 打开 hira:// 内部页面。
 * 地址拼法直接用 `pages.mjs#pageUrl`（与主进程 / 内部页同一份）—— 这里不再手抄一遍
 * "hira:// + query 拼接"，否则空参数处理、编码规则迟早与真源漂移。
 *
 * 默认替换当前标签；`newTab: true` 开新标签 —— 从浮层「走出去」的深链必须用后者：
 * 替换当前标签会让用户丢掉正在看的页面，且来源信息（page-info 要读的那一页）当场消失。
 * @param {string} page
 * @param {{ newTab?: boolean, query?: Record<string, string|number> }} [options]
 */
interface InternalNavigationOptions { query?: string | Record<string, unknown>; newTab?: boolean }
interface AddressBarControllerPort {
  shortcuts?: { pasteAndGo?: string }
  submit(text: string): boolean | Promise<boolean>
}

function navigateInternal(page: string, options: InternalNavigationOptions = {}): void {
  const url = pageUrl(page, options.query)
  if (options.newTab === true) tabsClient.newTab({ url })
  else tabsClient.navigate({ url })
}

// ── 新标签页地址判定（决定地址栏是否留空）────────────────────────────
// 判据：活动标签地址是否等于「主进程解析出的新标签页地址」—— home:url 是唯一真源
// （apps/app-main/src/main/home-url.js，渲染层不重写一份解析逻辑）。
//
// 主进程下发两个地址，两个都要判：
//   · homeUrl    —— 主页语义（纯设置解析：newtab / blank / custom）；
//   · newTabUrl  —— 一张新标签**实际**落到的地址。newtab 档下若扩展声明了
//                   `chrome_url_overrides.newtab`，这里就是 `chrome-extension://<id>/…`。
// 只判 homeUrl 会让扩展新标签页把地址栏里那个 chrome-extension 串暴露出来。
//
// 为什么不硬编码 'hira://newtab'：
//   · app.home_mode 可为 blank（about:blank）或 custom（用户自定义地址）；
//   · hira:// 以 standard 协议注册，Chromium 会把 hira://newtab 规范化成
//     hira://newtab/ —— 标签投影里的 URL 带末尾斜杠，精确匹配必然落空。
// 故按「小写 + 去末尾斜杠」归一化后再比较。
let homeUrl = ''
let newTabUrl = ''
function normalizeAddressForCompare(u: unknown): string {
  return String(u || '').trim().toLowerCase().replace(/\/+$/, '')
}
function isNewTabPageUrl(url: unknown): boolean {
  const target = normalizeAddressForCompare(url)
  if (!target) return false
  if (target === 'about:blank') return true
  // 内置新标签页（home_mode 默认值）：即使 home:url 尚未返回也先判为真，
  // 避免首个 tab:changed 早于 home:url 时先显示 hira://newtab 再被抹掉（闪烁）。
  if (target === pageUrl('newtab')) return true
  const home = normalizeAddressForCompare(homeUrl)
  if (home !== '' && target === home) return true
  // 扩展覆盖的新标签页：实际打开的地址是 chrome-extension://，同样留空地址栏。
  const next = normalizeAddressForCompare(newTabUrl)
  return next !== '' && target === next
}

/**
 * 上一次**自动回填**进地址栏的值，以及它属于哪个标签。
 *
 * 判据是「要回填的值有没有变」，而不是「地址栏里现在是什么」。这样既挡住了会把用户
 * 输入抹掉的重复回填，又不会漏掉真正的地址变化：
 *   · 没换标签 + 要填的值不变 → 没有新信息，一个字都不动。`tab:changed` 的
 *     「加载完成」那一次与 `home:url` 返回都属于这种 —— 它们来得晚（启动时主进程
 *     还在跑插件加载 / 会话恢复），重复回填正好会把用户刚敲下的第一个字抹掉；
 *   · 换了标签 → 必须回填，否则新标签页会残留上一个标签的网址；
 *   · 值真的变了（导航到新页面）→ 回填。
 */
let lastSyncedAddress: string | null = null
let lastSyncedTabId: string | null = null

/**
 * 把地址真正写进地址栏（+ 同帧刷新站点身份按钮）的**唯一写入点**。
 *
 * 收成一处的原因：地址栏与站点身份按钮必须永远描述同一个页面 —— 两条路径各写各的，
 * 迟早出现「地址换了、锁还停在旧站」。`lastSynced*` 记账也在这里，供防重复回填用。
 * @param {string} next 要显示的地址（新标签页 / 内部页已归一为空串）
 * @param {object|null} active 当前标签投影
 */
function writeAddress(next: string, active: AppShellTab|null, force = false) {
  shell.setAddress(next, force ? { force: true } : undefined)
  // 站点身份按钮与地址栏**同源同帧**更新：非网页（新标签页 / hira:// 内部页 /
  // about:blank）由 applySiteContext 隐藏按钮并收起浮层。
  applySiteContext(next ? siteInfoOfUrl(next) : null, active)
  lastSyncedAddress = next
  lastSyncedTabId = active?.tabId ? String(active.tabId) : null
}

/**
 * 按当前活动标签刷新地址栏：新标签页留空，其余原样显示。
 * @param {boolean} [force] true = 无视「值没变」守卫，强制重写（导航提交 / 刷新用）
 * @returns {boolean} 本次是否发生了「标签切换」（调用方据此清理上一个标签的上下文）
 */
function syncAddressBar(force: boolean = false): boolean {
  const active = tabSession && typeof tabSession.getActiveTab === 'function' ? tabSession.getActiveTab() : null
  const url = (active && active.url) || ''
  const tabId = active ? active.tabId : null
  const next = isNewTabPageUrl(url) ? '' : url
  const switched = tabId !== lastSyncedTabId
  const addressChanged = next !== lastSyncedAddress
  if (force || switched || addressChanged) {
    // 标签切换 / 真实地址变化才允许覆盖地址栏里尚未确认的 IME 草稿；
    // 同一地址的迟到回填不会反复清空气用户的拼音。
    writeAddress(next, active, force || switched || addressChanged)
  }
  return switched
}

// 启动拉一次主页地址；app.home_mode / app.home_url 变更后重新拉取并即时重判。
// 首次拉取是异步的，可能晚于首个 tab:changed —— 故拉取完成后必须再同步一次地址栏，
// 否则会「先按未就绪的 homeUrl 显示、再改正」的闪烁。
function loadHomeUrl() {
  getHiraBridge().provider.invoke('home:url', {})
    .then((res) => {
      const payload = res && typeof res === 'object' ? res : {}
      homeUrl = typeof payload.url === 'string' ? payload.url : ''
      // newTabUrl 缺省回落到 homeUrl：老版本 / 契约未升级时行为不变
      newTabUrl = typeof payload.newTabUrl === 'string' ? payload.newTabUrl : homeUrl
      syncAddressBar()
      // homeUrl / newTabUrl 晚于首个 tab:changed 就绪，而「仅新标签页显示」的书签栏判据
      // 依赖它（自定义主页 / 扩展覆盖页都要按实际地址判定）→ 就绪后补算一次。
      if (bookmarkController) bookmarkController.refreshBarVisibility()
    })
    .catch(() => {})
}

// 原生菜单：经 shared/menu-client 请求主进程弹出 Electron Menu，返回点击的 action。
// menu-client 走非阻塞协议（invoke 立即返回，结果经 ui:popup-menu-selected 回传），
// 菜单存续期间不再阻塞本 renderer。
const showNativeMenu: PopMenu = (payload: MenuPopPayload): Promise<string | null> => menuClient.popupMenu(payload)

/**
 * **非页面型**菜单动作背后的引擎功能面（§10.4）。
 *
 * 页面型动作（history / bookmarks / … / plugins / themes）的映射不在这里 ——
 * 它跟着页面身份走，统一由 `pages.mjs#pageFeature()` 回答。同一件事写两处必然漂移：
 * 有人给页面补了引擎归属、却忘了给菜单补，于是"页面被藏、菜单项还在"。
 *
 * 只有两类动作需要在这里额外登记：
 *   · `collections` —— 不是内部页（它开的是集锦面板），背后是 notes 功能面；
 *   · `more-pages` / `reload` / `editButtons` / 新建组 —— 宿主级动作，不依赖任何引擎。
 *
 * ⚠ `settings` **刻意不在任何表里**：`settings-service` 已定为 core（不可禁用），
 * 登记了也永远不会命中，反而让人误以为它可关。
 */
const EXTRA_MENU_FEATURE = Object.freeze({
  // 集锦：依赖集锦引擎与集锦面板插件（见 main/feature-map.js#notes）
  collections: 'notes'
})

/**
 * 按引擎可用性过滤菜单项。
 *
 * 只在**展示层**过滤，不改动作实现：即便某项因竞态被点到（引擎刚被别的窗口关掉），
 * 主进程那侧的 `blockedCapabilities` 也会拦住它并给出"能力不可用"——
 * 两道防线各自独立，不互相依赖。
 *
 * 过滤后顺手收拾分隔线：被藏掉的项若夹在两条分隔线之间，两道线会叠成一条粗缝；
 * 开头 / 结尾也不该留一条孤立的分隔线。这两件事在同一次遍历里完成，
 * 调用方只负责按"有项就配分隔线"的直觉写模板，不需要自己算显隐组合。
 */
function withFeatureGate(items: readonly MenuItem[]): MenuItem[] {
  const kept: MenuItem[] = []
  for (const item of items || []) {
    // 页面型动作 → 页面身份表；非页面型动作 → 少量额外登记。
    const action = typeof item.action === 'string' ? item.action : ''
    const feature = pageFeature(action) || EXTRA_MENU_FEATURE[action as keyof typeof EXTRA_MENU_FEATURE]
    if (feature && !isFeatureAvailable(feature)) continue
    if (item.type === 'separator' && (!kept.length || kept[kept.length - 1].type === 'separator')) continue
    kept.push(item)
  }
  while (kept.length && kept[kept.length - 1].type === 'separator') kept.pop()
  return kept
}

/**
 * 读「当前生效」的键位表。
 *
 * `keybindings:get` 返回的已经是**默认值 + 用户改键**合并后的结果（主进程
 * keybindings.js 负责合并与落库），这里再铺一层默认值只是为了容错：
 * 少一个键也不至于让菜单缺行。读取失败一律退回默认表 ——
 * **菜单必须弹得出来**，少一行提示远好过点了没反应。
 *
 * 每次弹菜单前现读一次（而不是启动时缓存 + 订阅 settings:changed）：
 * 菜单本来就是点击时才构造的，一次 invoke 的开销可以忽略，却天然做到
 * 「改键后下一次打开菜单立刻生效」，也不欠订阅生命周期。
 */
async function readKeybindings(): Promise<Record<string, string>> {
  try {
    const current = await getHiraBridge().provider.invoke(IPC_ROUTES.keybindingsGet)
    return { ...KEYBINDING_DEFAULTS, ...(current || {}) } as Record<string, string>
  } catch {
    return { ...KEYBINDING_DEFAULTS }
  }
}

/**
 * 给菜单项补右侧的快捷键提示（Electron `accelerator` 字段）。
 *
 * 动作名 → 键位 id → 组合串 → Electron 写法**全由 `menuAccelerator` 一处完成**
 * （真源 `shared-types#MENU_ACTION_KEYBINDINGS`），渲染层不再维护第二张映射表。
 * `formatKeybindingCombo` 是给人看的（带空格），直接喂 Electron 会被判非法 ——
 * 所以这里只认 `menuAccelerator` 的返回值。
 *
 * 上下文菜单里的 accelerator **只做展示**，Electron 不为它注册全局快捷键
 * （见 main/ipc/window.js#build），所以不会与主进程 keybindings 的分发打架。
 * 未登记 / 键位被清空的项原样返回，不显示提示（空串会渲染出空提示位）。
 */
function withAccelerators(items: readonly MenuItem[], keybindings: Record<string, string>): MenuItem[] {
  return (items || []).map((item) => {
    const accelerator = item.action ? menuAccelerator(item.action, keybindings) : ''
    return accelerator ? { ...item, accelerator } : item
  })
}

/**
 * 读剪贴板纯文本。
 *
 * 走主进程 `electron.clipboard`（见 IPC_ROUTES.clipboardReadText）：渲染层的
 * `navigator.clipboard.readText()` 要求文档聚焦且受权限策略限制，原生菜单存续期间
 * 外壳经常处于失焦态，读出来会是空的。失败一律回空串 —— 调用方只判空即可。
 */
async function readClipboardText() {
  try {
    const res = await getHiraBridge().provider.invoke(IPC_ROUTES.clipboardReadText)
    return res && typeof res.text === 'string' ? res.text : ''
  } catch {
    return ''
  }
}

/**
 * 「粘贴并前往」：读取剪贴板 → 交给地址栏按**与回车完全相同的规则**提交。
 *
 * 判定规则只有一份（ui-searchbar#commitVerbatim），这里不重新判断 URL / 搜索，
 * 否则「手动输入会搜索、粘贴却当成网址」这类分裂迟早出现。
 * @param {string} [text] 已读到的剪贴板文本（省略则现读）
 * @returns {Promise<boolean>} 是否真的提交了
 */
async function pasteAndGo(text?: string): Promise<boolean> {
  const raw = typeof text === 'string' ? text : await readClipboardText()
  const searchBar = shell && shell.searchBar
  if (!searchBar || typeof searchBar.submit !== 'function') return false
  return searchBar.submit(raw)
}

/**
 * 给地址栏（搜索输入框）挂标准编辑右键菜单：撤销 / 重做 / 剪切 / 复制 / 粘贴 /
 * 粘贴并前往 / 全选。
 *
 * 一律用 Electron 原生 `role`，理由有二：
 *   · 「粘贴」只能由原生实现 —— 渲染层的 `execCommand('paste')` 被浏览器安全策略禁掉；
 *   · 剪切 / 复制 / 撤销的**启用状态**由原生按当前选区与撤销栈自动裁定，不用手工维护。
 * 「粘贴并前往」是**动作项**（不是 role）：它要先拿到剪贴板文本，再走地址栏自己的
 * 提交规则，所以由渲染层处理，菜单只回传选中结果。
 * 挂在这里（编排层）而不是 ui-navbar：navbar 是哑组件，不认识 IPC。
 * @param {HTMLElement|null} input 地址栏输入框
 * @param {unknown} [searchBar] 地址栏控制器（提供 submit 与 shortcuts）
 * @returns {() => void} 卸载函数
 */
function installAddressEditMenu(input: HTMLElement | null, searchBar: AddressBarControllerPort | null): () => void {
  if (!input || typeof input.addEventListener !== 'function') return () => {}
  // 提示与行为同源：这个组合的唯一真源在 ui-searchbar（它才是真正处理按键的地方）。
  const pasteAndGoAccel = (searchBar && searchBar.shortcuts && searchBar.shortcuts.pasteAndGo) || ''
  const onContextMenu = async (e: MouseEvent) => {
    e.preventDefault()
    // 菜单一弹出就无法再改 enabled，所以先读剪贴板判断这项是否可点。
    // 读的是纯文本；空 / 非文本 → 该项置灰（不留一个点了没反应的入口）。
    const canPasteAndGo = !!(await readClipboardText()).trim()
    // 提示与行为同源：这个组合的唯一真源在 ui-searchbar（真正处理按键的地方）。
    // 空串不写字段 —— Electron 拿到空 accelerator 会渲染一个空提示位并告警。
    const pasteAndGoItem: MenuItem = {
      label: '粘贴并前往',
      action: 'address:paste-and-go',
      enabled: canPasteAndGo
    }
    if (pasteAndGoAccel) pasteAndGoItem.accelerator = pasteAndGoAccel
    const selected = await showNativeMenu({
      // role 项**刻意不写 accelerator**：Electron 的 role 自带平台正确的默认组合键
      //（roles 表里 macOS / Windows / Linux 各不相同，例如 Linux 的重做是 Ctrl+Shift+Z）。
      // 手抄一份的结局就是各平台显示与实际按键漂移。上下文菜单里的 accelerator
      // 只做展示，不会注册成全局快捷键。
      items: [
        editMenuItem('undo'),
        editMenuItem('redo'),
        { type: 'separator' },
        editMenuItem('cut'),
        editMenuItem('copy'),
        editMenuItem('paste'),
        // 紧挨「粘贴」：同一次剪贴板动作的两种收尾（贴进输入框 / 直接前往）。
        pasteAndGoItem,
        { type: 'separator' },
        editMenuItem('selectAll')
      ],
      x: e.clientX,
      y: e.clientY
    })
    // 点击那一刻再读一次剪贴板：菜单存续期间用户可能改了剪贴板内容。
    if (selected === 'address:paste-and-go') pasteAndGo()
  }
  input.addEventListener('contextmenu', onContextMenu)
  return () => input.removeEventListener('contextmenu', onContextMenu)
}

// ── 默认搜索引擎控制器（由设置驱动，可热更新）────────────────
// 配置状态机抽到 controllers/search-controller.js：
// 启动拉一次全量配置，之后靠 settings:changed 刷新本地缓存。
const searchController = createSearchController({
  provider: getHiraBridge().provider,
  onSubscribe: (event, cb) => getHiraBridge().on.subscribe(event, cb)
})

/**
 * 读齐 rail 的三条设置 → 解算面板侧 → 统一施加。
 *
 * 唯一的施加路径：shell（收起按钮定位 / 箭头）只拿解算后的面板侧；
 * windowLayoutController（主进程 bounds）拿完整的位置 + 起始边。
 * 三条设置分两次回来也只施加一次，方向不会来回闪。
 */
function refreshRailLayout() {
  return Promise.all([
    settingsClient.get(LAYOUT_SETTING_KEYS.toolSidebarPosition),
    settingsClient.get(LAYOUT_SETTING_KEYS.toolRailHorizontalAlign),
    settingsClient.get(LAYOUT_SETTING_KEYS.toolRailVerticalAlign),
    settingsClient.get(LAYOUT_SETTING_KEYS.toolRailPinned)
  ]).then(([rawPosition, rawHorizontal, rawVertical, rawPinned]) => {
    const position = normalizeRailPosition(rawPosition)
    const horizontalAlign = normalizeRailHorizontalAlign(rawHorizontal)
    const verticalAlign = normalizeRailVerticalAlign(rawVertical)
    const pinned = normalizeRailPinned(rawPinned)
    const panelSide = resolveRailPanelSide(position, horizontalAlign)
    if (shell && typeof shell.setSidebarPosition === 'function') shell.setSidebarPosition(panelSide)
    if (shell && typeof shell.setRailPosition === 'function') shell.setRailPosition(position)
    if (shell && typeof shell.setRailPinned === 'function') shell.setRailPinned(pinned)
    if (windowLayoutController) {
      windowLayoutController.setRailLayout({ position, horizontalAlign, verticalAlign })
    }
  }).catch(() => {})
}

addDisposer(getHiraBridge().on.subscribe('settings:changed', (change) => {
  if (disposed) return
  if (!change) return
  const k = change.key || ''
  // rail 位置 / 起始边热更新：三条设置一次读齐，解算出「面板侧」后统一施加。
  // shell 的收起按钮只认面板侧（靠右时移到右下、箭头反转），不自己理解上下。
  if (
    change.scope === 'all' ||
    k === LAYOUT_SETTING_KEYS.toolSidebarPosition ||
    k === LAYOUT_SETTING_KEYS.toolRailHorizontalAlign ||
    k === LAYOUT_SETTING_KEYS.toolRailVerticalAlign ||
    k === LAYOUT_SETTING_KEYS.toolRailPinned
  ) {
    refreshRailLayout()
  }
  // 书签栏显示模式热更新（Ctrl+Shift+B / 视图菜单 / 设置页三态下拉）
  if (change.scope === 'all' || k === BOOKMARKBAR_SETTING_KEY) {
    if (bookmarkController) bookmarkController.loadBarMode()
  }
  // navbar 按钮的顺序 / 显隐热更新（按钮编辑浮层每次落点都会写这条设置）
  if (change.scope === 'all' || k === SHELL_BUTTON_SETTING_KEYS.navbar) {
    if (change.scope === 'all') {
      settingsClient.get(SHELL_BUTTON_SETTING_KEYS.navbar)
      .then((v) => {
        navbarButtonsSetting = v
        applyNavbarButtons()
        if (buttonsEditActive) scheduleToolbarZoneReport()
      })
        .catch(() => {})
    } else {
      navbarButtonsSetting = change.value
      applyNavbarButtons()
    }
  }
}))
addDisposer(() => searchController.dispose())
searchController.load()

// 开发态缓存（唯一真源：主进程 `app:info#isPackaged`）。
// 打包状态在进程生命周期内不会变，启动拉一次即可；地址栏每次输入都读本地布尔，
// 不做 IPC 轮询。渲染层不直接引用 electron，也不自行反推 UA。
const devModeState = { enabled: false }
getHiraBridge().provider.invoke('app:info')
  .then((info) => { devModeState.enabled = !!(info && info.isPackaged === false) })
  .catch(() => {})

// ── 活动 tab / 可收藏 URL 判定（供 navbar 与书签控制器共用）──
let tabSession: ReturnType<typeof createTabSessionController> | null = null

function getActiveTab(): AppShellTab | null {
  return tabSession ? tabSession.getActiveTab() as AppShellTab | null : null
}

// 书签控制器（星标 + 书签栏）—— 状态机抽到 controllers/bookmark-controller.js。
// navbar 回调在用户交互时才触发，此处用 let 延迟赋值，避免循环依赖。
let bookmarkController: ReturnType<typeof createBookmarkController> | null = null

// PWA 安装按钮的状态机 —— 抽到 controllers/pwa-install-controller.js。
// 同样延迟赋值：navbar 的三态按钮在构造时只拿到「点击 → 询问控制器」的回调。
let pwaInstallController: ReturnType<typeof createPwaInstallController> | null = null

// 权限请求状态机（Web Prompts）—— 抽到 controllers/permission-state.js。
// getRequests 在 badge 渲染/交互时才触发，同样 let 延迟赋值。
let permissionState: ReturnType<typeof createPermissionState> | null = null

// 固定扩展条的编排（取数 / 过滤 / 点击 / 右键菜单）—— controllers/extensions-toolbar-controller.js。
// navbar 在构造时就拿到「点击/右键 → 转交控制器」的回调，故同样延迟赋值。
let extensionsToolbarController: ReturnType<typeof createExtensionsToolbarController> | null = null

// ── 站点身份（地址栏左端按钮 + 聚合浮层）─────────────────────────────────
//
// 唯一状态机在本文件，三件东西各管一段、互不认识：
//   · ui-navbar#siteIdentity —— 只画按钮（图标 / 角标 / 圆点 / aria）；
//   · siteinfo-overlay       —— 只渲染数据（权限 / 证书 / Cookie / 拦截）；
//   · 本文件                 —— 站点上下文、开合、自动弹出、深链去向。
//
// 之所以放这里而不是塞进闭包：`syncAddressBar` / 权限事件 / resize / overlay:commit
// 四个入口都要读写同一份状态，分散就成了「这里一个标志、那里一个判断」的屎山。
const siteIdentityState: SiteIdentityRuntimeState = {
  /** siteInfoOfUrl 的结果；null = 当前不是网页（新标签页 / 内部页） */
  site: null,
  /** 当前标签投影（title / favicon 供浮层身份头） */
  tab: null,
  tabId: null,
  /** 浮层是否展开（按钮 aria-expanded 直接读它） */
  open: false,
  /** 本站待处理权限请求数（角标） */
  pending: 0,
  /** 本站是否有显式规则（allow / block；ask 是默认值，不算「配置过」） */
  hasRules: false
}
/** 站点规则查询的代际：换站 / 关浮层时自增，迟到的响应直接丢弃。 */
let siteRulesGeneration = 0
/** 窗口是否真的在前台（主进程 window:blurred / window:focus）。 */
let windowActive = true

/** 本站待处理请求数（与当前站点同站才算；口径与浮层、标签标记一致）。 */
function countPendingForSite(site: SiteInfo | null): number {
  if (!site || !permissionState) return 0
  let count = 0
  for (const req of permissionState.getRequests()) {
    const reqSite = siteInfoOfUrl((req && req.origin) || '')
    if (reqSite && isSameSite(reqSite.domain, site.domain)) count += 1
  }
  return count
}

/** 把状态灌进按钮。按钮是哑件：只认 visible / secure / host / pending / hasRules / open。 */
function paintSiteIdentity() {
  if (typeof shell.setSiteInfo !== 'function') return
  const site = siteIdentityState.site
  if (!site) {
    shell.setSiteInfo({ visible: false })
    return
  }
  shell.setSiteInfo({
    visible: true,
    secure: site.secure !== false,
    host: site.domain,
    pending: siteIdentityState.pending,
    hasRules: siteIdentityState.hasRules,
    open: siteIdentityState.open
  })
}

/** 查本站是否有显式权限规则（决定按钮上的小圆点）。 */
function refreshSiteRules() {
  const site = siteIdentityState.site
  const gen = ++siteRulesGeneration
  if (!site) {
    siteIdentityState.hasRules = false
    return
  }
  getHiraBridge().provider.invoke('permission:get-site', { origin: site.origin })
    .then((rules) => {
      if (disposed || gen !== siteRulesGeneration) return
      const map = rules && typeof rules === 'object' ? rules : {}
      const hasRules = Object.values(map).some((value) => value === 'allow' || value === 'block')
      if (hasRules === siteIdentityState.hasRules) return
      siteIdentityState.hasRules = hasRules
      paintSiteIdentity()
    })
    .catch(() => {})
}

/**
 * 浮层载荷：锚点 + 站点上下文 + 视口。
 *
 * 浮层自己测卡片尺寸并回传 display；主进程按 `anchor-below` 夹取边界 ——
 * 坐标系不经过 navbar，按钮只管交出一个矩形。
 */
function pageSitePayload() {
  const tab = siteIdentityState.tab
  return {
    anchor: typeof shell.getSiteInfoAnchorRect === 'function' ? shell.getSiteInfoAnchorRect() : null,
    site: siteIdentityState.site,
    tab: tab
      ? {
          id: tab.tabId,
          title: tab.title || '',
          favicon: tab.favicon || '',
          url: tab.url || ''
        }
      : null,
    viewport: { width: window.innerWidth, height: window.innerHeight }
  }
}

/** 展开浮层；已展开时只重报几何（切标签 / resize / 侧栏开合都走这条）。 */
function openSiteInfo() {
  if (!siteIdentityState.site) return
  if (!siteIdentityState.open) {
    siteIdentityState.open = true
    paintSiteIdentity()
  }
  overlayClient.showSiteInfo(pageSitePayload())
}

/** 收起浮层；restoreFocus 时把焦点交还地址栏（Esc / 点按钮两个入口同语义）。 */
function closeSiteInfo(options: { restoreFocus?: boolean } = {}) {
  if (!siteIdentityState.open) return
  overlayClient.hideSiteInfo()
  siteIdentityState.open = false
  paintSiteIdentity()
  if (options.restoreFocus === true) {
    // 主进程 hideFloat 内部会重新分配焦点；下一帧再重申一次地址栏焦点才不会被抢回去。
    requestAnimationFrame(() => {
      const tabId = siteIdentityState.tabId
      try { getHiraBridge().provider.send(IPC_ROUTES.shellFocus, { tabId }) } catch (_) {}
      if (typeof shell.focusAddress === 'function') shell.focusAddress({ openSuggestions: false })
    })
  }
}

function toggleSiteInfo() {
  if (siteIdentityState.open) closeSiteInfo({ restoreFocus: true })
  else openSiteInfo()
}

/**
 * 重报浮层几何（窗口 resize / 侧栏开合 / 布局变化后调用）。
 *
 * 锚点矩形由按钮当场测量，布局推进通常发生在同一个任务的下一帧 ——
 * 故延到 rAF 再报，否则拿到的是**旧位置**，浮层会贴错地方。
 */
function reportSiteInfoGeometry() {
  if (!siteIdentityState.open) return
  requestAnimationFrame(() => {
    if (disposed || !siteIdentityState.open) return
    overlayClient.showSiteInfo(pageSitePayload())
  })
}

/** 浮层深链：面板 id / hira:// 路由只在这里登记，浮层只报动作名。 */
function handleSiteInfoAction(action: string): void {
  // 深链要在收起浮层前取来源标签：收起会清空 siteIdentityState，
  // page-info 想看的正是「打开浮层时的那一页」。
  const sourceTabId = siteIdentityState.tabId
  switch (action) {
    case 'open-permissions':
      // 浮层从地址栏左端展开 —— 面板也在左侧就地打开，视线不横跳。
      {
        const entry = findCatalogEntry(panelCatalogEntries, 'permissions-panel')
        if (entry) void openCatalogEntry(entry, { side: 'left' })
      }
      break
    case 'open-cookies':
      // Cookie 管理是完整页面（可增删改查），替换当前标签会把用户正在看的站点顶掉。
      navigateInternal('cookies', { newTab: true })
      break
    case 'open-certificates':
      navigateInternal('certificates')
      break
    case 'open-page-info':
      // 必须新标签 + 显式来源 tabId：替换当前标签再去问「当前活动标签」，
      // 问到的就是 page-info 自己（曾经的「页面信息显示页面信息页面」）。
      navigateInternal('page-info', { newTab: true, query: { tabId: sourceTabId } })
      break
    case 'rules-changed':
      // 浮层里改了本站规则 → 地址栏按钮的「规则圆点」跟随点亮 / 熄灭。
      // 规则变更不收起浮层：用户可能还要接着调下一项。
      refreshSiteRules()
      return
    default:
      // 未登记的动作：不动浮层（便于将来浮层先行、宿主后补）。
      return
  }
  closeSiteInfo()
}

/**
 * 浮层「转到面板」的**唯一落点**。
 *
 * 浮层的省略行 / 选择器只回传一个面板 id（`listOverflow#createOverflowRow`、
 * `target-picker-open-panel`、`space-open-panel`），**去向由外壳裁定**：
 * 目录查找（`findCatalogEntry`）与「面板 vs 子窗口」判据只在这里发生一次
 * （统一走 `openCatalogEntry`，与 navbar / rail / 站点信息浮层同一条路）。
 * 新浮层要开面板时无需各写一份查找 —— 报 id 即可。
 *
 * @param {string} panelId
 * @param {{ side?: 'left'|'right' }} [options] 省略时用本壳当前展开侧（panelOpenSide）
 */
function openPanelFromOverlay(panelId: string, options: Record<string, unknown> = {}) {
  const entry = findCatalogEntry(panelCatalogEntries, panelId)
  if (!entry) return
  const side = options.side === 'left' || options.side === 'right' ? options.side : panelOpenSide
  openCatalogEntry(entry, { side })
}

/**
 * 地址栏站点上下文变化 → 按钮 + 浮层。
 * @param {object|null} site siteInfoOfUrl 的结果；null = 非网页
 * @param {object|null} activeTab 当前标签投影
 */
function applySiteContext(site: SiteInfo|null, activeTab: AppShellTab|null) {
  const previous = siteIdentityState.site
  const changed = !previous || !site || previous.origin !== site.origin
  siteIdentityState.site = site || null
  siteIdentityState.tab = activeTab || null
  siteIdentityState.tabId = activeTab?.tabId ? String(activeTab.tabId) : null

  if (!site) {
    siteIdentityState.pending = 0
    siteIdentityState.hasRules = false
    siteRulesGeneration += 1
    // 浮层开着但站点变成内部页 / 新标签页 → 没有可聚合的对象，直接收起。
    // 不还焦点：此刻用户正在切标签，把光标塞回地址栏只会打断节奏。
    if (siteIdentityState.open) closeSiteInfo()
    paintSiteIdentity()
    return
  }

  if (changed) siteIdentityState.hasRules = false
  siteIdentityState.pending = countPendingForSite(site)
  paintSiteIdentity()
  if (changed) refreshSiteRules()

  // 浮层开着 → 跟随新站点刷新内容与锚点（同站只更新几何；换站由浮层 model 重置区块）。
  if (siteIdentityState.open) overlayClient.showSiteInfo(pageSitePayload())
}

// ── 地址栏输入转换（扩展点 `omnibar.input-transformer`，REDUCE）────────────
//
// 语义：把用户敲进去的**文字含义**交给插件流水线改写，产出用于「搜索 / 建议 / 跳转」
// 的最终文本。**绝不回写输入框** —— 那是插件的文字在覆盖用户正在敲的字，
// 表现为"打着打着字自己变了"，是这类功能最容易踩的坑。
//
// 典型用途：别名展开（`gh hira` → `https://github.com/hira`）、
// 关键词前缀改写（`!yt 猫` → YouTube 搜索词）、URL 简写补全。
//
// REDUCE 的 acc 初值就是 payload（见 plugin-slots.js），所以插件可以链式叠加：
// 第一个实现拿原文，产出交给第二个，以此类推；插件被禁用 → 实现消失 → 自然回落原文。
defineRendererSlots(['omnibar.input-transformer'])
/** @param {string} text @returns {string} */
function transformOmnibarInput(text: string) {
  const raw = String(text == null ? '' : text)
  const out = reduceRendererSlot('omnibar.input-transformer', raw)
  return typeof out === 'string' ? out : raw
}

// ── 「后退 / 前进」按钮的两档语义 ───────────────────────────────────────
//
// 全部由**这里**裁决（ui-navbar 只把「右键了 / 按着哪个修饰键点了」报上来，
// 不认识历史、不认识浮层、不认识 IPC）：
//   · 右键            → 原生菜单**按按钮分菜单**：后退键只列「可后退的页面」、
//                       前进键只列「可前进的页面」，点哪条去哪个；
//   · Ctrl / Cmd 点击 → 把目标历史页**在新标签打开**，当前标签原地不动。
//
// 历史条目的真源永远是主进程（`webContents.navigationHistory`）—— 渲染层不缓存、
// 不自推：菜单打开 / 点击那一刻问一次，菜单里的条目就必定是"现在真能去的"。

/**
 * 右键菜单 —— 与书签项菜单（`bookmarkContextMenu`）/ 空间切换菜单（`createSpaceMenu`）
 * **同一姿势**：菜单模板与 action 解析都在模块里（`ui-common#createNavHistoryMenu`），
 * 本文件只交出端口：「怎么弹」= 本窗口的原生菜单通道，「历史从哪来 / 点完去哪」= tabsClient。
 *
 * ⚠ 刻意**不带 `context`**：`context.kind` 是插件菜单插槽的入参（白名单见主进程
 * `MENU_SLOT_BY_KIND`），nav-history 没有插槽 —— 传一个裸对象只会被契约拒掉，
 * 整条菜单都弹不出来（曾经就是这样）。
 */
let navHistoryTabId: string | undefined
const navHistoryMenu = createNavHistoryMenu({
  popMenu: showNativeMenu,
  getHistory: () => {
    navHistoryTabId = tabSession?.getActiveTabId() || undefined
    return tabsClient.navigationEntries(navHistoryTabId)
  },
  onPick: (index) => {
    void tabsClient.goToEntry(navHistoryTabId, index).catch((error) => {
      console.error('[app-shell] history selection failed:', error)
    })
  }
})

async function runHistory(direction: 'back' | 'forward', tabId?: string): Promise<void> {
  try {
    const result = direction === 'back'
      ? await tabsClient.back(tabId)
      : await tabsClient.forward(tabId)
    if (!result || result.ok !== true) await tabSession?.refresh()
  } catch (error) {
    console.error(`[app-shell] ${direction} failed:`, error)
    try { await tabSession?.refresh() } catch (_) {}
  }
}

/** `activeIndex` 的前一条 / 后一条；没有（含 index 越界）→ null。 */
function navTargetEntry(history: NavHistorySnapshot | null, direction: 'back' | 'forward') {
  const entries = Array.isArray(history?.entries) ? history.entries : []
  const activeIndex = Number.isInteger(history?.activeIndex) ? history?.activeIndex as number : -1
  if (activeIndex < 0) return null
  const index = direction === 'forward' ? activeIndex + 1 : activeIndex - 1
  return entries.find((entry) => entry && entry.index === index) || null
}

/** 修饰键点击：把目标历史页在新标签打开。 */
async function onNavIntent({ direction, intent }: NavIntentPayload): Promise<void> {
  if (intent !== NAV_INTENT.NEW_TAB) return
  const tabId = tabSession?.getActiveTabId() || undefined
  const history = await tabsClient.navigationEntries(tabId)
  const target = navTargetEntry(history, direction)
  // 没有可去的条目 → 回落成普通前进 / 后退：按着修饰键也期望"有反应"，
  // 什么都不发生只会让人怀疑按钮坏了。
  if (!target || !target.url) {
    await runHistory(direction, tabId)
    return
  }
  await tabsClient.newTab({ url: target.url })
}

let menuRequestInFlight = false

const shell = createNavbar(document, {
  // 本窗口的窗口按钮**由系统画**时（原生 WCO，见 ./wco.js）不自绘那一簇 ——
  // 建窗期已由主进程按同一个判定决定（shared-types#resolveWindowControlsMode），
  // 这里问的是窗口自己（`navigator.windowControlsOverlay.visible`），不会与主进程失配。
  windowControlsEnabled: !windowControlsOverlay.native,
  onNewTab: async () => {
    // 新建标签永远打开「新标签页」，绝不复制当前地址栏 URL。
    // 真正要打开的地址由主进程单一路径解析（home-url.js）决定。
    await tabsClient.newTab({})
  },
  onToggleRail: async () => {
    try {
      const result = await layoutClient.toggleRail()
      // rail 固定态变了 → 重新上报布局，并把真实宽度交给贴边唤出的离场阈值。
      const pinned = !result
        ? true
        : typeof result.pinned === 'boolean'
          ? result.pinned
          : result.visible !== false
      if (typeof shell.setRailPinned === 'function') shell.setRailPinned(pinned)
      settingsClient.set(LAYOUT_SETTING_KEYS.toolRailPinned, pinned).catch(() => {})
      // 地址栏的位置/宽度随 rail 变化 → 已展开的站点信息浮层要跟着重新贴边。
      reportSiteInfoGeometry()
      return result
    } catch { return {} }
  },
  onBack: async () => {
    await runHistory('back')
  },
  onForward: async () => {
    await runHistory('forward')
  },
  // 后退 / 前进的两档语义（右键菜单 / 修饰键点击），见上方 navHistoryMenu 等
  onNavContextMenu: (payload) => navHistoryMenu({
    direction: payload.direction,
    x: payload.anchor && !payload.x ? Math.round(payload.anchor.left) : payload.x,
    y: payload.anchor && !payload.y ? Math.round(payload.anchor.top + payload.anchor.height) : payload.y
  }),
  onNavIntent,
  // 固定扩展条：组件只上报「哪一颗 / 点在哪」，语义全在控制器里
  // （弹窗 → 选项页 → 管理页的降级顺序、右键菜单、刷新策略）。
  // 用延迟引用而不是闭包捕获实例：控制器在 shell 之后装配（它要 renderExtensionActions）。
  onExtensionActivate: (entry, pos) => {
    if (extensionsToolbarController) extensionsToolbarController.activate(entry, pos)
  },
  onExtensionContextMenu: (entry, pos) => {
    if (extensionsToolbarController) extensionsToolbarController.openContextMenu(entry, pos)
  },
  onReload: async () => {
    await tabsClient.reload()
  },
  // 加载中时刷新键变停止键（见 ui-navbar#navCluster 的形态表）—— 动作在这儿，
  // 「什么时候该停」的判断在组件里，编排层不重复一遍加载态。
  onStop: async () => {
    await tabsClient.stop()
  },
  // 主页按钮：地址**必须**来自主进程 home:url（与启动页共用 home-url.js 的唯一解析结果），
  // 绝不在渲染层用 settings 自行拼接，否则会出现「按钮跳的地址和启动页两套真源」。
  // 用 newTabUrl 而不是 url：newtab 档下扩展可以覆盖新标签页，主页按钮要和
  // 新标签按钮 / Ctrl+T 落到同一个页面（Chrome 语义）。
  onHome: async () => {
    try {
      const res = await getHiraBridge().provider.invoke('home:url')
      const payload = res && typeof res === 'object' ? res : {}
      const url = payload.newTabUrl || payload.url || ''
      if (url) await tabsClient.navigate({ url })
    } catch (e) {
      console.error('[app-shell] home:url failed:', e)
    }
  },
  searchBar: {
    getOpenTabs: () => (tabSession ? tabSession.getTabs() : []).map((tab) => ({
      tabId: String(tab.tabId),
      title: String(tab.title || ''),
      url: String(tab.url || ''),
      favicon: String(tab.favicon || '')
    })),
    // 搜索地址与建议都用**转换后**的文本：插件改写的是"这段输入意味着什么"，
    // 两者必须同源，否则会出现「建议按改写后的词给、点下去却搜原文」的分裂。
    getSearchUrl: (q) => searchController.buildUrl(transformOmnibarInput(q)),
    // 内置引擎表（活引用）→ 地址栏把内置搜索引擎也当作 `!名字` 的 bang
    //（见 ui-searchbar/suggestors/bangs.ts）。自定义引擎不是 bang，不在这里。
    getEngines: () => searchController.getEngines(),
    // 用户自定义 Bang（活引用）—— 与内置表分开；地址栏 `!触发词` 的解析由 shared-types 统一
    getCustomBangs: () => searchController.getCustomBangs(),
    // 自定义 Bang 真正被使用（回车 / 点击）→ 主进程 +1 计数；不阻塞导航
    onBangUsed: (id) => searchController.recordBangUse(id),
    // 真正执行了一次关键词搜索 → 记搜索历史（与 NTP 搜索框同一份数据）。
    // 用转换后的文本，与 getSearchUrl / 远端建议保持同源。
    onSearch: (q) => searchController.recordQuery(transformOmnibarInput(q)),
    // 面板目录（活引用）→ 地址栏 `!面板名` / 「输入 `!` 列出全部」里的快捷候选。
    // 直接读 navbar 那份缓存（同一个事实源，不另拉一次 IPC）；`opensWindow` / `opensPage`
    // 的条目（如插件中心）**不算面板** —— 它们的语义是开子窗口 / 开内部页，
    // 走 `panel:` 打开会打开一个空面板。
    getPanels: () => panelCatalogEntries
      .filter((p) => p && !p.opensWindow && !p.opensPage)
      .map((p) => ({ id: p.id, title: String(p.title || p.id) })),
    searchSettings: searchController.getFlags(),
    // 已打开标签候选被选中/点击 → 切到那个标签（语义是"**回到**那一页"，不是再开一个）。
    // 与上面主进程回传的 `overlay:commit`（open-tab 分支）同一语义，两条路径必须一致。
    onActivateTab: (tabId) => tabsClient.switchTab(tabId),
    // 「粘贴并前往」：地址栏上的 Ctrl+Shift+V 只把意图报上来，剪贴板（系统能力）
    // 与提交都在本层完成；判定规则仍是 ui-searchbar#commitVerbatim 那一份。
    onPasteAndGo: () => { pasteAndGo() },
    // 开发态判定（惰性）—— 供地址栏「开发模式」提示使用；唯一真源是主进程 app:info。
    isDevelopmentMode: () => devModeState.enabled,
    // 即时答案（F-0771~F-0773）：出网/解析/缓存在主进程，这里只做 IPC 转发。
    // 必须与 `search:suggestions` 分通道 —— 网络 2.5s 超时绝不能拖住本地建议。
    getInstantAnswers: async (query, limit) => {
      try {
        const items = await getHiraBridge().provider.invoke('search:instant-answer', {
          query: transformOmnibarInput(query),
          limit: typeof limit === 'number' ? limit : 3
        })
        return Array.isArray(items) ? items : []
      } catch {
        // 即时答案失败必须静默：它只是锦上添花，不能让地址栏报错或卡住。
        return []
      }
    },
    // 默认引擎键名（即时答案仅 DDG 生效；由 search-controller 的配置缓存给出）
    getDefaultEngine: () => searchController.getDefaultEngine(),
    // 主进程统一搜索（历史+书签+标签，domain-search 已按来源加权）
    getRemoteSuggestions: async (query) => {
      const q = transformOmnibarInput(query)
      const [suggestions, history] = await Promise.all([
        getHiraBridge().provider.invoke('search:suggestions', { query: q, limit: 8 }),
        getHiraBridge().provider.invoke('search:history', { query: q, limit: 4 })
      ])
      return [...(Array.isArray(history) ? history : []), ...(Array.isArray(suggestions) ? suggestions : [])]
    },
    onCommit: async (url) => {
      // typed=true：地址栏手动提交 → 历史 typedCount 自增（其余入口不传）。
      await tabsClient.navigate({ url, typed: true })
    },
    onAction: async (action) => {
      try {
        await getHiraBridge().provider.invoke('omnibox:action', { action })
      } catch {}
    }
  },
  onToggleBookmark: () => {
    bookmarkController?.openEditorForCurrentTab()
  },
  onStarContextMenu: () => {
    bookmarkController?.openEditorForActiveTab()
  },
  // 地址栏左端的站点身份按钮：切换聚合浮层（站点权限 / 证书 / Cookie / 内容拦截）。
  // 按钮只上抛点击意图，开合与载荷组装全在本文件（见 applySiteContext 一带的说明）。
  onSiteInfo: () => {
    toggleSiteInfo()
  },
  // 意图信号（悬停 / 按下）：提前预热站点信息浮层 renderer —— 浮层是独立进程，
  // 冷启动数百毫秒，不能全压在点击上。指针一落到按钮上就发，不做任何延迟。
  onSiteIntent: () => {
    overlayClient.warmSiteInfo()
  },
  // PWA 安装按钮的两种点击语义（按钮本身是哑件，三态由 pwa-install-controller 灌入）：
  //   installable → 打开安装确认窗；installed → 直接唤起已装应用。
  onInstallPwa: () => {
    if (pwaInstallController) pwaInstallController.installCurrent()
  },
  onOpenPwa: (appId) => {
    if (pwaInstallController) pwaInstallController.openApp(appId)
  },
  // 面板按钮的**入口意图**（悬停 / 按下）：请在后台先把这块面板的视图造好。
  // 面板关闭即销毁，冷启动开销若全压在点击上，用户看到的就是"点了要等一下"。
  // 这里只发一条单向消息（幂等、静默），点击语义仍完全由 openCatalogEntry 决定。
  onPrepare: (panelId) => {
    panelsClient.prepare(panelId)
  },
  onMenu: async (e) => {
    if (menuRequestInFlight) return
    menuRequestInFlight = true
    try {
    const anchor = e?.currentTarget instanceof HTMLElement ? e.currentTarget.getBoundingClientRect() : null
    const keyboardTriggered = !e || e.detail === 0 || (!e.clientX && !e.clientY)
    const menuX = anchor && keyboardTriggered ? Math.round(anchor.right) : e?.clientX
    const menuY = anchor && keyboardTriggered ? Math.round(anchor.bottom) : e?.clientY
    // 用原生 Electron Menu 替代自绘下拉。
    //
    // ── 只留「基础」与「特色」，其余内部页不再摊在这里 ──────────────────
    // 这个菜单此前塞了 20+ 个内部页入口（权限 / Cookie / 清除数据 / 会话 / 导入 /
    // 配置文件 / 任务管理器 / 证书 / 快捷键 / 更新 / 崩溃报告 / 游戏…），越长越像
    // 一张"目录索引"，常用的反倒是要重新找。现在的分工：
    //   · 这里 = 六个基础管理页（历史 / 书签 / 下载 / 扩展 / 密码 / 空间）
    //           + 特色功能（插件中心 / 主题 / 集锦）+ 新建组 + 设置 / 编辑按钮 / 重新加载；
    //   · 其余全部内部页 = 公共侧栏（历史页就是那条侧栏的宿主）+ 设置里的
    //     「内部页面」小类 —— 所以这里放一项「更多管理页面」，落在历史页。
    //
    // 规矩不变：
    //   1. 菜单项必须与实际存在的「内部页 / 面板」一一对应；
    //   2. page 型一律走 navigateInternal（与其它内部页入口同构）。
    // 快捷键提示来自**当前生效的键位**（用户可能在 hira://shortcuts 改过），
    // 每次弹菜单前现读一次；读取失败退默认表，菜单照常弹出。
    const keybindings = await readKeybindings()
    // Preparation is guarded against double clicks; after the native popup is
    // owned by menu-client, the OS menu itself serializes further input.
    menuRequestInFlight = false
    const action = await showNativeMenu({
      x: menuX,
      y: menuY,
      items: withAccelerators(withFeatureGate([
        // ── 「新建」组放最前（Edge / Chrome 的 ⋮ 菜单同样把这四条放最前）──────
        // 原生 popup 在屏幕高度不够时是**从底部裁切**的，放末尾在矮窗口 /
        // 高缩放下会直接看不见。四条都是**动作**，不走 window:open。
        { label: '新建标签页', action: 'newTab' },
        { label: '新建无痕标签页', action: 'newTabIncognito' },
        { label: '新建窗口', action: 'newWindow' },
        { label: '新建无痕窗口', action: 'newWindowIncognito' },
        { type: 'separator' },
        // 一级页面入口：成员与叫法一律来自 shared-types#NAVBAR_PAGE_ENTRIES / pageLabel
        // （设置页放在最后，所以这里按同一顺序切出「管理页」与「设置」两段）。
        ...NAVBAR_PAGE_ENTRIES.filter((host): host is string => typeof host === 'string' && host !== 'settings')
          .map((host) => ({ label: pageLabel(host), action: host })),
        { type: 'separator' },
        // 特色功能页：插件中心 / 主题（成员与叫法同样来自真源，菜单用 menuLabel）。
        ...NAVBAR_FEATURE_ENTRIES
          .map((host) => ({ label: pageMenuLabel(host), action: host })),
        { type: 'separator' },
        // 集锦（经典 Edge Collections 完全体）：Hira 的旗舰功能之一，开关走集锦面板
        // （与 Ctrl+Shift+Y / 地址栏 `!集锦` 同一条通道，不新造第二条路）。
        { label: '集锦', action: 'collections' },
        { type: 'separator' },
        // 其余管理页都在公共侧栏里；落点 = MORE_PAGES_HOST 指的那一页（公共侧栏的宿主）。
        { label: '更多管理页面', action: 'more-pages' },
        { type: 'separator' },
        // 按钮编辑模式入口：进入后 navbar / rail 的按钮可由浮层拖动排序与显隐。
        { label: '编辑界面…', action: 'editButtons' },
        { label: pageLabel('settings'), action: 'settings' },
        { type: 'separator' },
        { label: '重新加载', action: 'reload' }
      ]), keybindings)
    })

    // page 型：直接在当前标签打开对应内部页（hira://<host>）。
    // 判据也在真源里 —— 新增一个一级入口只改 NAVBAR_PAGE_ENTRIES /
    // NAVBAR_FEATURE_ENTRIES，这里自动跟随。
    const pageHost = action === 'more-pages'
      ? MORE_PAGES_HOST
      : (action && (NAVBAR_PAGE_ENTRIES.includes(action) || NAVBAR_FEATURE_ENTRIES.includes(action)) ? action : '')
    if (pageHost) { navigateInternal(pageHost); return }
    // 集锦：侧栏面板也是「就地打开」，开关只有一条通道（panelsClient.toggle）。
    if (action === 'collections') { panelsClient.toggle('notes-panel', {}); return }
    switch (action) {
      case 'newTab': tabsClient.newTab({}); break
      // 无痕标签：留在**当前窗口**（与 Ctrl+Alt+N 同一条通道 tab:new-incognito）。
      // 本窗口内所有无痕标签共享 TabManager 生成的那一个临时 partition。
      case 'newTabIncognito': tabsClient.newIncognitoTab({}); break
      // 新建窗口 / 新建无痕窗口：开的是**完整浏览器窗口**（自带 chrome / TabManager /
      // 独立标签条），与 Ctrl+N / Ctrl+Shift+N 各自同一条通道。
      case 'newWindow': getHiraBridge().provider.invoke('window:new').catch(() => {}); break
      case 'newWindowIncognito': getHiraBridge().provider.invoke('window:new-incognito').catch(() => {}); break
      case 'reload': tabsClient.reload(); break
      // 编辑按钮：交给主进程显示按钮编辑浮层（navbar / rail 两侧一起进入编辑）。
      case 'editButtons':
        getHiraBridge().provider.invoke('buttons-edit:set-active', { active: true }).catch(() => {})
        break
    }
    } catch (error) {
      console.error('[app-shell] main menu failed:', error)
    } finally {
      menuRequestInFlight = false
    }
  },
  overlay: overlayClient,
  onWindowMinimize: async () => {
    try { await getHiraBridge().provider.invoke('window:minimize') } catch {}
  },
  onWindowMaximize: async () => {
    try { await getHiraBridge().provider.invoke('window:maximize') } catch {}
  },
  onWindowClose: async () => {
    try { await getHiraBridge().provider.invoke('window:close') } catch {}
  }
})
// A renderer reload can happen while an editing overlay is active. Never let
// that stale UI flag keep the real toolbar hidden.
shell.setPanelButtonsEditing(false)
// ── 外壳布局容器（ui-chrome-layout）──────────────────────────────────────
//
// 四块互不相识的哑块（标签栏 / 导航栏 / 标题栏 / 书签栏）+ 内容洞，由这一个容器按
// shared-types#planChromeLayout 产出的计划摆放。书签栏因此**彻底脱离 navbar**，
// 标题栏也与导航栏零代码关系 —— 它们只认识被注入的那个槽。
//
// 摆放由 chrome-layout-controller 在下面统一施加（读设置 → 组装计划 → 摆一次）。
const chromeLayout = createChromeLayout(document)
root.appendChild(chromeLayout.element)
addDisposer(() => chromeLayout.dispose())

// ── 分屏分隔条（Split View）───────────────────────────────────────────────
// 分隔条是外壳 DOM（不是独立视图）：两格之间那条缝**没有网页覆盖**，chrome 背景天然
// 显形、指针事件天然归 chrome（见 split-surface.js 文件头）。几何由主进程推来。
const splitSurface = createSplitSurface(document, chromeLayout.element, {
  dragDivider: (payload) => tabsClient.dragSplitDivider(payload),
  dragDividerLive: (payload) => tabsClient.dragSplitDividerLive(payload),
  setRatioPreset: (splitId, preset) => tabsClient.setSplitRatioPreset(splitId, preset as 'even' | 'main-70' | 'main-30'),
  getGeometry: () => tabsClient.splitGeometry(),
  onChanged: (fn) => tabsClient.onSplitChanged(fn)
})
addDisposer(() => splitSurface.dispose())

// ── 独立侧栏聚焦框（Web Sidebar）─────────────────────────────────────────
// 与分屏那一个**同一套视觉语言、各自独立一份**：侧栏内容视图四周恒定让出一圈缝，
// 这一圈没有网页覆盖，chrome 背景与这道淡蓝框才显形（见 web-sidebar-surface.js 文件头）。
// ⚠ 订阅的是**侧栏自己**的通道（web-sidebar:changed），不是 split:changed —— 两套系统
// 各自驱动各自的框，互不覆盖。
//
// ⚠ 包 try/catch：这是一块**装饰**（画个框），它初始化失败绝不该让外壳后面那一长串
// 初始化（标题栏 / 书签栏 / 各控制器…）全部不执行 —— 那种"一处装饰性失败 = 整个外壳瘫"
// 是最难定位的一类故障（表现出来像是完全无关的功能坏了）。
let webSidebarSurface: ReturnType<typeof createWebSidebarSurface> | null = null
try {
  webSidebarSurface = createWebSidebarSurface(document, chromeLayout.element, {
    getGeometry: () => tabsClient.webSidebarGeometry(),
    onChanged: (fn) => tabsClient.onWebSidebarChanged(fn),
    // 调宽把手：拖动帧只走单向通道；松手后再做一次最终确认。
    // 区间校验与落库仍在主进程（拖顶条那条把手同一条语义）。
    onResizeLive: (width) => { webSidebarClient.setWidthLive(width) },
    onResize: (width) => { webSidebarClient.setWidth(width).catch(() => {}) }
  })
  addDisposer(() => webSidebarSurface?.dispose())
} catch (e) {
  console.warn('[app-shell] web sidebar surface init failed:', errorMessage(e))
}

// ── 速览的外环阴影（Glance）─────────────────────────────────────────────
// 第三个"外壳 DOM 画装饰"的成员，原理与前两个逐字相同（卡片之外那圈留白没有网页覆盖）。
// ⚠ 它**必须是外壳 DOM**：做成浮层视图时它盖在卡片之上、铺满内容区，会把
//   「点背景卡 → 提升前台」（tabEvents 的 wc.on('focus')）与网页点击全吃掉
//   —— 原生视图没有可用的 setIgnoreMouseEvents（见 glance-surface.js 文件头）。
// ⚠ 速览那两道**卡间投影 / 蓝聚焦框不在这里**：front 卡的左右两条边坐在 back 卡
//   身上（那片像素归 back 那张原生视图所有，外壳 DOM 到不了）—— 它们画进 **back 卡
//   那一页**里（infra-window/glance-deck-chrome.js），框带落在 front 矩形之外、
//   back 视口之内，于是位于网页内容之上且不被任何圆角裁切。
// ⚠ 同样包 try/catch：一块装饰失败绝不该让外壳后面那一长串初始化全部不执行。
let glanceSurface: ReturnType<typeof createGlanceSurface> | null = null
try {
  glanceSurface = createGlanceSurface(document, chromeLayout.element, {
    getGeometry: () => tabsClient.glanceGeometry(),
    onChanged: (fn) => tabsClient.onGlanceChanged(fn)
  })
  addDisposer(() => glanceSurface?.dispose())
} catch (e) {
  console.warn('[app-shell] glance surface init failed:', errorMessage(e))
}

// 标题栏块：网页标题 + 窗口控制按钮槽（默认关闭，设置里打开后才参与摆放）。
// 与 navbar 平级的独立一块 —— 窗口控制按钮也可以选择挂在这里。
injectTitlebarStyles(document)
const titlebarBlock = createTitlebar(document)

// ── 垂直标签栏块（侧栏里的那条标签列）───────────────────────────────────────
//
// 与 titlebar 平级的**独立一块**：只在「有栏位于侧栏」时才被登记进布局 ——
// 由下面的 onHostAxis 做宿主切换（横向标签条 ⇄ 纵向标签列，同一块 id 两种呈现）。
//
// 组装方式与 ui-panel-opentabs 的面板**同一范式**：组件自带 injectStyles / mount 定义，
// 宿主只交出端口（clients / menu / createTabRowMenu / previewOverlay / widthRange）——
// 意图映射、拖拽五条通道、右键菜单模板那些**组件自己的知识**不再散落在本文件里
// （本文件只剩「这些端口各自接哪个客户端」，也就是真正属于编排层的部分）。
//
// 标签数据与横向标签条**同源**：由 tabSession 每次渲染后回调过来（见下面的
// onProjection），不另订一次 IPC、不另跑一次渲染。
//
// 它的列表就是 ui-common 的纵向标签行列表 —— 与「打开标签」「固定标签」两个面板
// **同一份实现**，菜单 / 预览 / 拖拽 / 标签组因此天然一致，不可能各写一套而漂移。
// 侧栏装配图（`shared/sidebar-surface.js`）：骨架 + 「槽里放哪几件」只回答一次。
// 「悬停展开」有两型，判据是计划里的 revealOverlay（见 shared-types#planChromeLayout）：
//   · Edge 型（只有标签列住侧栏）→ 本视图常驻一条 56px 图标 rail，展开是一条**独立浮层**
//     （主进程 WebContentsView `sidebar-float`）盖在网页上 —— 网页不缩进、不重排；
//   · 全功能型（导航栏也住侧栏）→ 不另造视图，把同一块侧栏的宽度在 restWidth / revealWidth
//     之间切一刀，网页随之真让位。
// 两种形态的"何时展开"都由主进程贴边巡看裁定（LayoutCoordinator#_sideReveal*）。
injectSidebarSurfaceStyles(document)
const verticalTabs = createSidebarSurface(document, {
  tabs: tabsClient,
  // 权限标记点击 → 展开地址栏锚定的聚合浮层并定位到「待处理请求」。
  // 纵向列表只上抛意图（已先切到该标签），浮层的归属与开合全在 chrome 层。
  onPermissionRequest: () => focusPendingPermissions(),
  /**
   * 标签行右键菜单 —— 与横向标签条 / 两个面板 / 侧栏覆盖层**同一份动作表**
   * （`shared/tab-row-menu.js`：模板在 ui-common，"动作落到哪个客户端"在那里写了一遍）。
   * 本文件只交出端口：怎么弹（chrome 视图既有的原生菜单通道）—— 动作表不再在这里抄一遍。
   */
  createTabRowMenu: createTabRowMenuFactory(),
  // 标签组行自己的菜单走**通用弹层**（与标签行菜单分开的两件事）：
  // 标签行菜单是本模块造的固定模板，组菜单是 row list 内部的通用项列表。
  menu: menuClient,
  // 拖拽调宽的夹取区间与默认值：真源在 shared-types（设置页的同名项也读它）——
  // 组件只接收这组数，不认识设置键、不认识 IPC。
  widthRange: { min: SIDEBAR_WIDTH_MIN, max: SIDEBAR_WIDTH_MAX, default: SIDEBAR_WIDTH_DEFAULT },
  // 松手落库：**先就地更新计划，再写设置**。
  //
  // ⚠ settings:changed 会**跳过发起方**（见 main/settings/sync.js：那一条的契约是
  //   "发起方已经乐观更新过，回声只会制造无谓的重渲染"）—— 所以只写设置的话，本视图的
  //   计划永远停在旧宽度：ui-vertical-tabs 松手后的「临时宽度交棒」等不到计划追上，
  //   超时清掉临时值 → 表现就是「拖完松手，宽度闪回旧值、怎么调都完不成」。
  //   两件事都要做：本视图就地推进计划（立刻生效），设置只负责落盘 + 通知别的窗口。
  onResizeStart: () => {
    windowLayoutController.setSideColumnResizing(true)
  },
  onResize: (width) => {
    try {
      chromeLayoutController.setSetting(LAYOUT_SETTING_KEYS.sideColumnWidth, width)
    } catch (_) {}
    try { settingsClient.set(LAYOUT_SETTING_KEYS.sideColumnWidth, width).catch(() => {}) } catch (_) {}
  },
  onResizeEnd: () => {
    windowLayoutController.setSideColumnResizing(false)
  },
  // hover 预览：只把意图转发到浮层通道。**摆放方式不在这里定** ——
  // 侧栏是一条竖列，预览该落在行的哪一侧只有承载它的那一层知道（随 payload 带上），
  // 本文件只负责"发出去"。
  previewOverlay: {
    showTabPreview(payload: UnknownRecord) {
      try { getHiraBridge().provider.send(IPC_EVENTS.tabpreviewOverlayShow, payload) } catch (_) {}
    },
    hideTabPreview() {
      try { getHiraBridge().provider.send(IPC_EVENTS.tabpreviewOverlayHide, {}) } catch (_) {}
    },
    // 意图预热：hover 状态机起 700ms 停留计时的那一拍报上来（见 ui-common#hoverPreview），
    // 后台把浮层 renderer 载起来（主进程幂等、闲置仍回收）。
    warmTabPreview() {
      try { getHiraBridge().provider.send(IPC_ROUTES.floatWarm, { name: 'tabpreview-overlay' }) } catch (_) {}
    }
  },
  /**
   * 侧栏顶部那颗「固定 / 悬停」按钮（常驻态与悬停唤出态都长在同一位置）。
   *
   * 切换的就是设置键 `app.sidebar_visibility`（attached ⇄ floating）—— 布局计划是
   * 唯一下游，渲染层与主进程都从同一份计划取值，所以这里只写设置、不另存一份状态。
   * 双写范式与下面的 onResize 一致：先就地推进计划（立刻生效），再落盘通知别的窗口。
   */
  onTogglePin: () => {
    const side = chromeLayoutController.getPlan()?.side ?? null
    const current = side ? side.visibility : 'attached'
    const next = current === 'floating' ? 'attached' : 'floating'
    try {
      chromeLayoutController.setSetting(LAYOUT_SETTING_KEYS.sideColumnVisibility, next)
    } catch (_) {}
    try { settingsClient.set(LAYOUT_SETTING_KEYS.sideColumnVisibility, next).catch(() => {}) } catch (_) {}
  }
})

// ── 布局根插槽（`layout.root-slot`，MULTI）────────────────────────────────
//
// 「主窗口布局根」在本实现里的准确含义是**chrome 图层的根**。
// 为什么不把它做成"与网页并列的一棵可插入 DOM 树"：本项目的网页是叠在 chrome 之上的
// **原生 WebContentsView**（见 ui-webviews 的容器说明），DOM 的 z-index 对原生视图无效 ——
// 渲染层里画得再高的东西也盖不住网页。这一层的真实可见范围就是 chrome
// （navbar 与侧栏之间的那些区域）。如实划清边界，好过给一个"能盖住网页"的错觉：
// 后者会让插件作者画了半天，然后以为是自己写错了。
//
// **交互安全**：容器与默认子元素都是 `pointer-events: none`。要交互的插件必须自己
// 在返回的元素上写 `pointerEvents = 'auto'`。根级图层若默认吃指针，一次写坏就是
// 「整个浏览器点不动」—— 那是不能接受的失败模式，所以默认值取"不可交互"这一侧。
defineRendererSlots(['layout.root-slot'])

const layoutRootStyle = document.createElement('style')
layoutRootStyle.textContent = `
  #layout-root-slot {
    position: fixed;
    inset: 0;
    z-index: var(--hira-z-elevated);
    pointer-events: none;
  }
  #layout-root-slot > .layout-root-slot__item { pointer-events: none; }
`
document.head.appendChild(layoutRootStyle)

const layoutRoot = document.createElement('div')
layoutRoot.id = 'layout-root-slot'
root.appendChild(layoutRoot)

/** 重挂全部布局根贡献（插件启停后也走这里 —— 整体重建，天然不会残留已禁用插件的东西）。 */
function mountLayoutRootSlots() {
  layoutRoot.textContent = ''
  for (const node of callRendererSlotMulti('layout.root-slot', { root: 'window' })) {
    if (!(node instanceof HTMLElement)) continue
    node.classList.add('layout-root-slot__item')
    layoutRoot.appendChild(node)
  }
}
mountLayoutRootSlots()
// 与文件末尾的 `activateRendererSlots` 订阅同一条思路：插件启停后整体重建。
addDisposer(pluginsClient.onChanged(() => { mountLayoutRootSlots() }))

// ── 空间胶囊（nav bar 左上 #workspace-switcher）────────────────
// 哑组件 + 编排层 controllers/space-controller.js：
//   · 触发器胶囊住在 navbar（ui-shell = 窗口本体，图层最底）；
//   · 它弹出的「总览」浮层住在独立浮层图层 overview-overlay（z 高于 rail / navbar）——
//     挂在 navbar DOM 里的卡片会被 #navbar 的 overflow 裁掉、并被 rail 盖住，
//     所以点击触发器只上报锚点矩形，卡片本体交给浮层渲染。
// 组件只管渲染与上报意图，数据全在编排层（浮层自己再拉一份，互不相识）。

/**
 * 打开「总览」浮层。
 *
 * 锚点取空间胶囊的**实时矩形**（胶囊是唯一触发器；快捷键也从这里取，不另编一个坐标）。
 * 胶囊被「空间引擎被禁用」藏起来时回退到左上角安全位 —— 总览里的其它三块（打开的标签 /
 * 最近关闭 / 会话）与空间无关，不该因为空间引擎停用就连带打不开。
 *
 * 不做 toggle：浮层铺满整窗、z 高于 navbar，开着时胶囊根本收不到点击
 * （那一下落在浮层的背景上 = 点外面收起，见 overview-overlay 的 dismissOnOutsidePointerDown）。
 */
function openOverview() {
  const anchor = typeof spaceSwitcher.getAnchor === 'function' ? spaceSwitcher.getAnchor() : null
  const payload = anchor && anchor.width > 0
    ? { x: anchor.x, y: anchor.y, viewport: { width: window.innerWidth, height: window.innerHeight } }
    : { x: 12, y: 56, viewport: { width: window.innerWidth, height: window.innerHeight } }
  overlayClient.showOverview(payload)
}

const spaceSwitcher = createSpaceSwitcher(document, {
  onToggle: () => { openOverview() },
  // 意图信号（悬停 / 按下）：提前预热总览浮层 renderer。
  // 指针落到胶囊上就发（触发器只有一个，多余进程上界可控，闲置回收照旧兜底）。
  onIntent: () => { overlayClient.warmOverview() }
})
shell.mountSpaceSwitcher(spaceSwitcher.element)
addDisposer(() => spaceSwitcher.dispose())

/**
 * §10.4：空间引擎被禁用 → 收起胶囊。
 *
 * 与书签栏/下载条同属"不是目录项、要自己收敛"的那一类。
 * （浮层不用连带收：它的开合真源在自己那一侧，主进程兜底收起见 overlay:closed。）
 */
function syncSpaceSwitcherAvailability() {
  const available = isFeatureAvailable('spaces')
  spaceSwitcher.element.style.display = available ? '' : 'none'
}

const spaceController = createSpaceController({
  view: spaceSwitcher,
  onSubscribe: (route, cb) => getHiraBridge().on.subscribe(route, cb)
})
addDisposer(() => spaceController.dispose())
spaceController.start()
// 首次收敛放在 controller 造好之后；后续变化由下面的 onFeaturesChanged 收敛
syncSpaceSwitcherAvailability()
addDisposer(onFeaturesChanged(syncSpaceSwitcherAvailability))

// 快捷键 / 主进程命令「打开总览」（main → ui-shell）：
// 快捷键只发一条事实，锚点由外壳按胶囊实时矩形算 —— 主进程不认识 navbar 布局。
addDisposer(getHiraBridge().on.subscribe(IPC_EVENTS.overviewOpen, () => {
  if (!disposed) openOverview()
}))

// 按钮编辑模式下按 Esc 退出。浮层若没拿到键盘焦点，Esc 只有外壳收得到。
// （总览浮层的 Esc 由它自己处理：它是 SELF_FOCUS 浮层，键盘焦点就在它那一侧。）
addDisposer((() => {
  const onKeyDown = (e: KeyboardEvent) => {
    if (e.key === 'Escape' && buttonsEditActive) {
      e.preventDefault()
      getHiraBridge().provider.invoke('buttons-edit:set-active', { active: false }).catch(() => {})
      return
    }
    if (!buttonsEditActive && e.ctrlKey && e.shiftKey && e.key.toLowerCase() === 'l') {
      e.preventDefault()
      getHiraBridge().provider.invoke('buttons-edit:set-active', { active: true }).catch(() => {})
    }
  }
  document.addEventListener('keydown', onKeyDown)
  return () => document.removeEventListener('keydown', onKeyDown)
})())

// 点击外壳内任意非聚合按钮处 → 收起站点信息卡（Vivaldi 同款：轻量浮层点别处即走）。
//
// 为什么放在外壳而不是浮层里：浮层是独立 WebContentsView，只在自己的矩形内收鼠标 ——
// 点标签栏 / 地址栏 / bookmark bar 这些外壳区域时它根本收不到事件。捕获阶段监听是因为
// 中间层可能有 stopPropagation，而"用户已经离开"这个事实不该被任何一层吞掉。
// 页面 / rail / 面板侧栏上的点击由主进程侦测（LayoutCoordinator#setFloatDismissOnOutside），
// 两边合起来才是"点浮层外面都收起"。
addDisposer((() => {
  const onPointerDown = (e: PointerEvent) => {
    if (!siteIdentityState.open) return
    const button = typeof shell.getSiteInfoElement === 'function' ? shell.getSiteInfoElement() : null
    // 按钮自己必须先放行：否则"点开关 → 先收起 → 再 toggle 打开"会闪一下。
    if (button && e.target instanceof Node && button.contains(e.target)) return
    closeSiteInfo()
  }
  document.addEventListener('pointerdown', onPointerDown, true)
  return () => document.removeEventListener('pointerdown', onPointerDown, true)
})())

// 主进程兜底收起浮层（切标签 / 窗口失焦 / 前端未及发 hide）时，把**住在打开方**的开合状态
// 同步复位 —— 否则打开方以为它还开着，下一次数据刷新会按"还开着"把浮层重新 show 出来。
// （总览浮层没有宿主开合状态：它的真源在浮层自己那一侧，本文件不必复位任何东西。）
addDisposer(getHiraBridge().on.subscribe(IPC_EVENTS.overlayClosed, (payload) => {
  if (!payload) return
  // 通用「选择目标」浮层被主进程兜底收起（切标签 / 窗口失焦）→ 同步复位打开方的开合状态，
  // 否则打开方以为它还开着，下一次数据刷新会按"还开着"把浮层重新 show 出来。
  if (payload.name === 'target-picker-overlay') {
    if (bookmarkController) bookmarkController.closeFolderOverlay()
  }
  // 按钮编辑浮层被主进程兜底收起（切标签 / 窗口失焦）→ 退出编辑模式：
  // 必须把自己那排按钮放出来，否则它们会一直停在 visibility: hidden。
  if (payload.name === 'buttons-edit-overlay') {
    buttonsEditActive = false
    if (typeof shell.setPanelButtonsEditing === 'function') shell.setPanelButtonsEditing(false)
    chromeLayoutController.setEditing(false)
  }
  // 站点信息卡被主进程收起（点网页 / 点其它 chrome 视图 / 窗口失焦 / 切标签）→
  // 只复位开合状态并重画按钮（aria-expanded / is-open）。不再次 hide、不还焦点：
  // 收起动作已经由主进程完成，用户此刻的注意力也已经在别处。
  if (payload.name === 'siteinfo-overlay' && siteIdentityState.open) {
    siteIdentityState.open = false
    paintSiteIdentity()
  }
}))

// 模态浮层（总览 / 按钮编辑）铺满窗口时，外壳各条（navbar / tabbar / bookmarkbar）
// 的拖拽区必须让位 —— `-webkit-app-region` 是 Chromium 按整个窗口合并的，浮层盖不住它；
// 不让位的话点在拖拽条上的菜单项会被窗口当作「拖动标题栏」吃掉
// （见 ui-common#setOverlayDragSuppressed）。
addDisposer(getHiraBridge().on.subscribe('overlay:modal', (payload) => {
  setOverlayDragSuppressed(document, !!(payload && payload.open))
}))

// 沉浸模式未唤出 / 全屏时，网页虽已铺满，窗口仍会合并下层 chrome 的 drag 命中区。
// 由主进程按真实布局状态收紧，贴边唤出后再恢复，避免“栏都没了还能拖窗口”。
addDisposer(getHiraBridge().on.subscribe(IPC_EVENTS.chromeDragSuppressed, (payload) => {
  setChromeDragSuppressed(document, !!(payload && payload.suppressed))
}))

// 侧栏的三种形态（rail / 悬停唤出 / 常驻占位）都是同一块 #chrome-side，
// 且都 no-drag（见 ui-vertical-tabs/styles.js）—— 外壳这边没有任何"让位拖拽区"要做。
// 唤出宽由主进程巡看指针后推送（layout:side-column-reveal），渲染层只按事实收放。

// ── 按钮编辑模式（navbar 侧）────────────────────────────────────────────
// 进入：先把这排按钮的几何报给主进程（浮层按同一几何克隆，视觉不跳），再隐身让位；
// 退出：恢复显示。浮层的开关真源在主进程（buttons-edit:set-active），这里只跟随。
addDisposer(getHiraBridge().on.subscribe('buttons-edit:active', (payload) => {
  const active = !!(payload && payload.active)
  buttonsEditActive = active
  if (active) {
    chromeLayoutController.setEditing(true)
    reportToolbarZone()
    if (typeof shell.setPanelButtonsEditing === 'function') shell.setPanelButtonsEditing(true)
    // 自愈：启动期若因任何原因没把 navbar_buttons 施加到 navbar（读取失败 / 事件丢失），
    // 这里按设置再校正一次 —— 编辑浮层里的按钮栏与托盘才是「设置里的真相」，
    // 退出编辑后 navbar 也随之回到用户编辑过的形态。
    settingsClient.get(SHELL_BUTTON_SETTING_KEYS.navbar)
      .then((v) => {
        navbarButtonsSetting = v
        applyNavbarButtons()
        scheduleToolbarZoneReport()
      })
      .catch(() => {})
  } else {
    if (toolbarZoneFrame) cancelAnimationFrame(toolbarZoneFrame)
    toolbarZoneFrame = 0
    if (typeof shell.setPanelButtonsEditing === 'function') shell.setPanelButtonsEditing(false)
    chromeLayoutController.setEditing(false)
  }
}))

// 编辑浮层每落一次点都会请我们**重量一次**（设置刚变，真实按钮的位置/数量都变了）。
// 不重报的话，浮层手里还是「进入编辑那一刻」的几何 —— 框与按钮越编辑越偏，
// 用户下一次落点只能靠猜。编辑中才量：不在编辑态时没人消费这份几何。
addDisposer(getHiraBridge().on.subscribe('buttons-edit:remeasure', () => {
  if (!buttonsEditActive) return
  scheduleToolbarZoneReport()
}))

// 满窗浮层（总览 / 书签夹）都按「打开那一拍的视口」铺满：窗口一改，锚点与 bounds 全部失效。
// 主进程的重排（applyInitialLayout）不跟浮层 bounds，留着它会让右下角变成点不到的空白。
// 直接收起，下次点开会按新锚点弹出（重开代价极小）—— 与书签夹同一条处置。
addDisposer((() => {
  const onResize = () => {
    overlayClient.hideOverview()
    // 书签夹浮层：卡片落在**书签栏那一项**的锚点下 —— 窗口一改，锚点就失效了。
    if (bookmarkController) bookmarkController.closeFolderOverlay()
    // 站点信息浮层锚在地址栏按钮下缘：窗口尺寸一变，锚点与视口都失效了。
    // 重报一次（浮层重新测量、主进程重新夹取），比直接收起体验好。
    reportSiteInfoGeometry()
  }
  window.addEventListener('resize', onResize)
  return () => window.removeEventListener('resize', onResize)
})())

// ── 书签控制器（星标 + 书签栏）装配 ──
/**
 * 书签栏可见性 → 外壳布局登记（**延迟绑定**）。
 *
 * 为什么要有这层间接：书签控制器在这里就装配完了（启动期马上就会读设置、拉固定书签），
 * 而外壳布局控制器在文件靠后才创建（它要等四块元素都就位）。装配顺序固定、调用时机不定，
 * 所以先给个空实现，布局控制器就绪后再换成真的。
 * @type {(shown: boolean) => void}
 */
let syncBookmarkbarBlock: (shown: boolean) => void = () => {}

bookmarkController = createBookmarkController({
  document,
  shell,
  tabsClient,
  bookmarksClient,
  provider: getHiraBridge().provider,
  getActiveTab,
  showNativeMenu,
  navigateInternal,
  // 书签栏里的**文件夹**点开 → 弹一块贴着该项下缘的浮层列表（独立原生视图）。
  // 控制器只认"弹 / 收"两个动作，通道与落位都在适配器与浮层里（见 bookmark-controller 的说明）。
  overlay: overlayClient,
  // §10.4：书签引擎被禁用时收起星标与书签栏（注入查询，控制器不认识插件系统）
  isFeatureAvailable,
  // 「仅新标签页显示」的判据注入：homeUrl 由本文件持有（home:url 是唯一真源），
  // 控制器只认「给我一个布尔」，不复制一份主页地址解析逻辑（判据见 isNewTabPageUrl）。
  isNewTabPage: () => {
    const tab = getActiveTab()
    return isNewTabPageUrl((tab && tab.url) || '')
  },
  // 书签栏会自我隐身（空栏 / 仅在部分页面显示）→ 可见性一变就上报：
  // 不可见的块要从外壳布局里**注销**，否则它会占着一行空行 ——
  // 容器级留白（底部那道呼吸空隙）会按「这里有一块 bar」来算，于是凭空多出一条边距。
  onBarVisibilityChange: (shown) => syncBookmarkbarBlock(shown),
  // 「转到收藏面板」的落点：书签夹下拉超出上限时的省略行会回传一个面板 id，
  // 控制器只把它转交给这里 —— 面板目录查找与展开侧由外壳裁定（唯一一份）。
  openPanel: openPanelFromOverlay
})
addDisposer(() => bookmarkController.dispose())
bookmarkController.loadBarMode()
bookmarkController.refreshBar()

// ── PWA 安装控制器（地址栏三态按钮的唯一状态机）──
pwaInstallController = createPwaInstallController({
  shell,
  pwaClient,
  provider: getHiraBridge().provider,
  getActiveTab,
  // §12.1：pwaApps 引擎被禁用时按钮随目录一起摘除，控制器也不再查询状态
  isFeatureAvailable
})
addDisposer(() => pwaInstallController.dispose())

// ── Web Prompts：权限请求状态机装配 ──
// 事件合流（permission:request / :cleared）+ 启动拉取 pending 列表 →
// 列表变化时刷新 navbar badge。状态机本体在 controllers/permission-state.js。

/**
 * 把「待处理权限请求」折算成「每条标签该显示什么图标」，喂给标签呈现控制器。
 *
 * 只在 APPS 层做这一折算：它同时认识 permission-state（请求）与 tab-session（标签）——
 * 两头都不需要知道对方。图标键名来自 shared-types 的唯一映射（F-0667），
 * 一条标签上多个请求按出现顺序去重合并（例：摄像头 + 通知 → 两颗图标）。
 */
function syncTabPermissionMarks() {
  if (!permissionState) return
  /** @type {Map<string, string[]>} */
  const byTab: Map<string, string[]> = new Map()
  for (const req of permissionState.getRequests()) {
    const tabId = req && req.tabId
    if (!tabId) continue
    const icons = permissionIcons(req.type)
    if (icons.length === 0) continue
    const list = byTab.get(tabId) || []
    for (const name of icons) if (!list.includes(name)) list.push(name)
    byTab.set(tabId, list)
  }
  if (tabSession && typeof tabSession.setPermissionMarks === 'function') {
    tabSession.setPermissionMarks(byTab)
  }
}

/**
 * 待处理请求变化 → 站点身份按钮角标。
 *
 * 它只负责**按钮上的事实**（有没有请求、有几条）；弹哪只浮层由
 * `syncPermissionOverlay` 决定 —— 独立浮层与地址栏按钮是两条互不依赖的呈现。
 */
function syncSiteIdentityPending() {
  const site = siteIdentityState.site
  if (!site) return
  const next = countPendingForSite(site)
  siteIdentityState.pending = next
  paintSiteIdentity()
}

/**
 * 权限申请浮层的唯一开合真源（独立原生视图）。
 *
 * 开：列表非空且窗口在前台 —— 浮层固定弹在**内容区左上角**（落位由主进程算，
 *     见 renderer/permission-overlay/main.js）。
 * 合：列表清空（全部处理完 / 网页主动撤销）—— 立即收起，不留空壳。
 *
 * 为什么不再自动展开站点信息浮层：权限请求的**处置入口**已经回滚为独立浮层；
 * 站点信息里的待处理区保留为「站点权限管理视图」，不再承担打断式弹出。
 */
function syncPermissionOverlay() {
  if (!permissionState) return
  const requests = permissionState.getRequests()
  if (requests.length === 0) {
    overlayClient.hidePermissionRequests()
    return
  }
  // 后台窗口不抢视觉：请求仍留在列表里，窗口回到前台时补一次（见 windowFocused）。
  if (!windowActive) return
  overlayClient.showPermissionRequests(requests)
}

/** 标签 / 纵列上的权限标记点击 → 直接弹权限申请浮层（不再跳到站点信息卡）。 */
function focusPendingPermissions() {
  syncSiteIdentityPending()
  syncPermissionOverlay()
}

permissionState = createPermissionState({
  provider: getHiraBridge().provider,
  onSubscribe: (event, cb) => getHiraBridge().on.subscribe(event, cb),
  onChange: () => {
    // 同一份请求列表喂给三个宿主：标签呈现、地址栏角标、独立权限浮层。
    syncTabPermissionMarks()
    syncSiteIdentityPending()
    syncPermissionOverlay()
    // 浮层开着时由 model 自己订阅事件做增量刷新（只更新待处理区，不重建整卡）。
  }
})
addDisposer(() => permissionState.dispose())

// ── 标签条的渲染侧插槽（`tabbar.item-renderer` / `tabbar.tab-stack-renderer`
//    / `tabbar.drop-target`）────────────────────────────────────────────────
//
// 通过**端口注入**交给 ui-tabbar：ui 包不得 import `apps/**`（CONTRACT-11），
// 所以插件系统对它完全不可见 —— 它只拿到几个「给我一个元素 / 这次拖放归你吗」的函数，
// 缺省即"没有插件参与"，行为与接线前逐字一致。
//
// 语义是**装饰**而不是**替换**（为什么见 ui-tabbar/src/components/decoration.js）：
// 标签行与标签组芯片各有一整套 keyed 复用 + 字段级 diff + 开合动效的状态机，换掉节点
// 等于把这套机制全部作废；而标签条是界面**最热**的渲染路径，不能为扩展性付这个代价。
defineRendererSlots(['tabbar.item-renderer', 'tabbar.tab-stack-renderer', 'tabbar.drop-target'])
function rendererSlotNode(value: unknown): HTMLElement | null {
  return value instanceof HTMLElement ? value : null
}

const tabbarSlots: TabbarRendererSlots = {
  itemDecorator: (payload) => rendererSlotNode(callRendererSlot('tabbar.item-renderer', payload, null)),
  // SINGLE 语义：芯片的装饰**只有一个** —— 同一个芯片上叠第二个装饰没有位置语义，
  // 冲突时由 callRendererSlot 的既有规则裁决（见 §3 的 SINGLE/MULTI 说明）。
  stackDecorator: (payload) => rendererSlotNode(callRendererSlot('tabbar.tab-stack-renderer', payload, null)),
  // MULTI → 任意一个实现返回真值即「认领」这次拖放（见 ui-tabbar 里 claimDrop 的说明）。
  // 错误策略由 callRendererSlotMulti 统一兜住（坏实现跳过、不影响其它实现与宿主）。
  dropTargetAccepter: (payload) => callRendererSlotMulti('tabbar.drop-target', payload).some(Boolean)
}

// 垂直标签列（标签栏的纵列形态）**此刻是否在台上**。
//
// 默认布局里标签栏在**顶部**，`verticalTabs.element` 根本没进 DOM；而 onProjection
// 过去是无条件的 —— 于是横向布局下每次 tab:changed 都要为一块**看不见**的纵列跑一遍
// 完整 reconcile（建行节点、写 class / 属性 / 文本）。这里按"是否在台上"门禁，
// 并把最近一次投影缓存下来：它上台时立刻补喂一次就收敛，不必等下一次 tab:changed。
let verticalTabsOnStage = false
/** 最近一次标签投影（供纵列上台时补喂，见上） */
let lastTabsProjection: TabbarProjection | null = null

tabSession = createTabSessionController({
  document,
  tabsClient,
  showNativeMenu,
  overlay: overlayClient,
  slots: tabbarSlots,
  // 同一次渲染的投影再喂给垂直标签列（它只在有栏住侧栏时才在台上）。
  // 数据只有一条订阅、一次渲染 —— 两个宿主不会各自跑一遍。
  // ⚠ 不在台上时**不喂**：那等于给一块游离 DOM 白跑一遍 reconcile（见文件内
  // `verticalTabsOnStage` 的说明）。最近一次投影照样缓存，上台时补喂。
  onProjection: (projection) => {
    lastTabsProjection = projection
    if (verticalTabsOnStage) verticalTabs.setItems(projection as unknown as Parameters<typeof verticalTabs.setItems>[0])
  },
  onActiveTabChange: (activeTab, meta) => {
    const url = (activeTab && activeTab.url) || ''
    const tabId = activeTab ? activeTab.tabId : null
    const isNewTabPage = isNewTabPageUrl(url)

    // 导航态与加载态都从**标签投影**现取 —— 而不是只靠 tab:loading 事件推。
    //
    // 为什么必须在这里再取一次（这是"进度条跨标签一直显示"的根因）：
    //   · `tab:loading` 是**增量事件**，只回答"某个标签此刻变了"。它是按 tabId 过滤的
    //     （见下方订阅），因此切到另一个没在加载的标签时**没有任何事件会来** ——
    //     上一颗标签留下的 true 就永远挂在那里，进度条与"停止"键跟着一直显示。
    //   · 同理，后台标签加载结束时那条 false 会被过滤掉，当前标签的状态也不会被更正。
    //   投影里的 `loading` 是该标签自己的事实。每渲染一次就无条件按它校正一次 →
    //   切标签天然隔离、任何后续变更都会自愈。
    //
    // ⚠ 这段是**附加状态**，必须整体包在 try/catch 里：它排在地址栏同步、书签星、
    // 焦点补正**之前**（那些才是本回调的关键路径）。一旦这里抛出去，后面全部不再执行
    // —— 表现就是「地址栏不再更新 + 前进后退按钮停在旧状态」这种整体失灵，
    // 而不是"少改了一颗按钮"。宁可少更新一次导航态，也不能吃掉关键路径。
    try {
      const activeLoading = !!(activeTab && activeTab.loading)
      if (typeof shell.setLoading === 'function') shell.setLoading(activeLoading)
      if (typeof shell.setNavState === 'function') {
        shell.setNavState({
          canGoBack: !!(activeTab && activeTab.canGoBack),
          canGoForward: !!(activeTab && activeTab.canGoForward),
          loading: activeLoading
        })
      }
    } catch (e) {
      console.error('[app-shell] setNavState/setLoading failed:', e)
    }

    // 新标签页地址栏留空（不暴露 hira://newtab 这类内部地址），其它页面照常显示。
    // 切标签时顺带收起建议下拉：下拉内容是上一个标签的上下文，留着会「黏在屏幕上」，
    // 而且下次聚焦地址栏会把那些旧建议原样弹回来。主进程 onTabSwitched 也会兜底收
    // 浮层 bounds，但地址栏这侧「当前建议」的状态只有这里能清。
    const switched = syncAddressBar()
    if (switched && typeof shell.hideSuggestions === 'function') shell.hideSuggestions()

    const focusAddress = () => {
      // 交还键盘焦点 + 登记「让位意图」，两步缺一不可：
      //   · 只做 DOM focus()：光标不出现（键盘焦点还在网页 webContents 上）；
      //   · 只 focus 外壳一次：网页 view 稍后会把焦点抢走（新标签页 WebContentsView
      //     创建 / 首次显示 / 首次 commit 时 Chromium 会原生抢焦），表现就是「闪一下就没」。
      // 主进程 focusShell 会在意图期内反复重申焦点，并把每次夺回的时刻回灌成
      // window focus 事件 —— 那正是下面 window 'focus' 监听补 DOM 焦点的时机
      // （对齐 RT omnibox：窗口 focus / visibilitychange 后 ensureInputFocused）。
      try { getHiraBridge().provider.send(IPC_ROUTES.shellFocus, { tabId }) } catch (_) {}
      if (typeof shell.focusAddress === 'function') shell.focusAddress({ openSuggestions: false })
    }

    if (meta && (meta.isFirst || (meta.isNew && isNewTabPage))) {
      // 启动首个标签 / 新建标签被激活 → **只在激活这一拍**把光标送进地址栏。
      //
      // 绝不能在 loading=true → false 时再补一次：新标签页可能在几秒后才报加载完成，
      // 那时用户早已在页内搜索框打字，迟到的补焦会把键盘硬拽回地址栏。
      // 真正需要覆盖的「WebContentsView 首次显示抢焦」由主进程 focusShell 的
      // 有界重试链处理；这里只负责发出一次明确的用户意图。
      // openSuggestions:false 保证只聚焦、**不**自动弹出建议下拉。
      focusAddress()
    }

    bookmarkController.refreshStar()
    // 「仅新标签页显示」：换标签 = 换页面 = 可见性可能翻转（新标签页 ↔ 普通网页），
    // 必须重算。判据（isNewTabPageUrl）依赖的 url 就在上面这份 activeTab 里。
    bookmarkController.refreshBarVisibility()

    // PWA 安装按钮：换标签 / 换页面 = 可安装状态可能翻转（含 SPA 内导航后 URL 变化）。
    // 控制器内部按 (tabId + url) 去重，重复调用不会产生额外 IPC。
    if (pwaInstallController) pwaInstallController.onActiveTabChange(activeTab ?? {})

    // 标题栏（若启用）显示网页标题 + 站点图标；**原生窗口标题**（任务栏那一行）
    // 也在这里更新 —— 后者与标题栏开关无关，永远跟随当前网页。
    chromeLayoutController.setPageInfo({
      title: (activeTab && activeTab.title) || '',
      favicon: (activeTab && activeTab.favicon) || ''
    })
  }
})
addDisposer(() => tabSession.dispose())
shell.mountTabbar(tabSession.element)

// 窗口**真正失活**（切到别的应用 / 别的窗口）→ 地址栏当场交还 DOM 光标。
//
// 为什么需要这一条：Chromium 在窗口失活时**不清** DOM 焦点，窗口一激活就把那个光标
// 原样还回来 —— 表现就是「一切换窗口回来就自动聚焦地址栏」，而用户其实早就在看网页了。
// 失活当场 blur 掉，回来时就没有"上次聚焦的元素"可恢复；主动聚焦只保留
// **启动**与**新建标签页**两条（见上面的 focusAddress）。
//
// 判据必须取主进程的窗口 blur（窗口级）：外壳自己的 window blur 在「标签视图抢焦 /
// 浮层原生抢焦」时同样会响，那种场景恰恰要把光标补回来，在里面 blur 会打断正常输入。
// 内容面（网页 / 新标签页 / 面板）里的输入框已经拿到键盘：主动 blur 地址栏 DOM。
// 这不是“窗口失活”，不能复用 window:blurred；否则会把窗口活跃态误判为后台。
addDisposer(getHiraBridge().on.subscribe(IPC_EVENTS.shellFocusReleased, () => {
  if (typeof shell.releaseAddressFocus === 'function') shell.releaseAddressFocus()
}))

addDisposer(getHiraBridge().on.subscribe('window:blurred', () => {
  // 窗口失活 → 自动弹出暂停（用户在看别处，弹浮层只会打断）。
  windowActive = false
  if (typeof shell.releaseAddressFocus === 'function') shell.releaseAddressFocus()
}))
addDisposer(getHiraBridge().on.subscribe(IPC_EVENTS.windowFocused, () => {
  windowActive = true
  // 后台期间到达的权限请求当时被压住没弹（见 syncPermissionOverlay）——
  // 回到前台补一次，否则用户切回来还得先动一下才有反应。
  syncPermissionOverlay()
}))

// 焦点哨兵：全外壳唯一一份（键盘归属判据的渲染层真源）。
// 装在这里而不是越早越好 —— 它只依赖 document 与 bridge，位置本身无时序要求，
// 放在窗口焦点那两条旁边是为了让「窗口级焦点」与「视图级焦点」两条线索在一起。
addDisposer(installFocusSentinel(document))

// 地址栏的编辑右键菜单（撤销 / 重做 / 剪切 / 复制 / 粘贴 / 粘贴并前往 / 全选）。
// 必须在 `shell` 建立之后注册 —— 上面那个 installAddressEditMenu 只定义、不调用。
// 传入 searchBar 是为了让「粘贴并前往」的快捷键提示与地址栏真正处理的键位同源。
addDisposer(installAddressEditMenu(shell.addressInput, shell.searchBar))

// 主页地址（home:url）加载 + 热更新：地址栏「新标签页留空」的判据依赖它。
// 改 app.home_mode / app.home_url 后立即重判当前标签，无需等下一次切标签。
loadHomeUrl()
addDisposer(getHiraBridge().on.subscribe('settings:changed', (change) => {
  if (!change) return
  const k = change.key || ''
  if (change.scope === 'all' || k === STARTUP_SETTING_KEYS.homeMode || k === STARTUP_SETTING_KEYS.homeUrl) loadHomeUrl()
}))
// 扩展系统变化（安装 / 启停 / 卸载）会改变 `chrome_url_overrides.newtab` →
// `newTabUrl` 必须重拉：否则新开出来的扩展新标签页会把 chrome-extension:// 串显示在地址栏。
// （已经打开的标签不会因为覆盖变化而改址 —— 与 Chrome 一致。）
addDisposer(extensionsClient.onChanged(() => loadHomeUrl()))

// 初始 rail 位置 / 起始边：驱动收起按钮定位与主进程轨道几何（横向条 / 纵向列）
refreshRailLayout()

// 书签栏元素交给 chrome-layout-controller 作为一块登记（与 navbar 无任何代码关系）。
// 这里不再自己往 DOM 里塞 —— 摆放的唯一施加方是那一个控制器。
const webviewsShell = createWebviewsShell(document)
chromeLayout.setContent(webviewsShell.element)

// ── 跨窗口标签同步的截图占位（A5 / J15）──────────────────────────────────
// 活动标签被同步迁走后，本窗口内容区留一张截图（贴在已有的 .webview-placeholder 上）——
// 那块区域此刻没有任何 WebContentsView 覆盖，外壳正好可以作画（见控制器文件头）。
injectTabSyncPlaceholderStyles(document)
const tabSyncPlaceholder = createTabSyncPlaceholder({
  holder: webviewsShell.placeholder,
  onChanged: (fn: (payload: { url?: string | null }) => void) =>
    tabsClient.onSyncPlaceholder((payload) => fn(payload))
})
addDisposer(() => tabSyncPlaceholder.dispose())

// ── W13-2: Download Bar（控制器在 controllers/download-controller.js）──
// 装配 + **事件驱动**更新：订阅口一并交进去，进度由 `download:progress` 在组件内部
// 原地推进（零 IPC、不整表重排）；只有 `download:done` 与 15s 兜底同步会去拉列表。
const downloadController = createDownloadController({
  provider: getHiraBridge().provider,
  // 订阅口：控制器不认识桥，只认识"给我一个 (route, fn) => 退订函数"
  // （与 notes-client / bookmarks-client 等同一口径）
  subscribe: (route: string, fn: (payload: unknown) => void) => getHiraBridge().on.subscribe(route, fn),
  document,
  // §10.4：下载引擎被禁用时停掉订阅与兜底同步 + 清空
  isFeatureAvailable
})
addDisposer(() => downloadController.dispose())

// ── 下载红点（navbar 的面板按钮）────────────────────────────────────────
// 与 rail 共用**同一个驱动器**（同一事件、同一去重、同一初始读数）：这里只把
// "是否有下载在跑"这条布尔交给 navbar 按钮。事件只在跃迁时发，零轮询；
// 按钮 `::after` 画点，不新增 DOM 节点。
const downloadBadge = createDownloadActivityWatcher({
  provider: getHiraBridge().provider,
  subscribe: <T>(route: string, fn: (payload: T) => void) => getHiraBridge().on.subscribe(route, fn),
  onChange: (active: boolean) => shell.setPanelBadge('downloads-panel', active)
})
addDisposer(() => downloadBadge.dispose())

// ── 固定扩展条（地址栏右侧那一排扩展图标）──────────────────────────────
// 后端（infra-extensions）一直把 `pinned` 持久化在安装记录里并广播 ——
// 这里补的是**展示与交互**：取列表 → 只留 pinned → 交给 navbar 的哑组件。
// 空列表时组件 hidden 不占位；停用 / 加载失败的扩展照样展示（灰化、仍可右键管理）。
extensionsToolbarController = createExtensionsToolbarController({
  extensionsClient,
  toolbar: { render: shell.renderExtensionActions },
  popMenu: showNativeMenu,
  // 打开**扩展侧栏面板**：就地查看，不顶掉当前页面。
  // 面板开合是 toggle 语义，所以先问它实际所在侧 —— 已经开着就别再 toggle 掉。
  openPanel: () => {
    const panelId = 'extensions-panel'
    panelsClient.getSide(panelId)
      // getSide 返回 `{ side, pinned }`：判"是否已开着"只看 side（钉住位也算开着）。
      .then((state) => { if (!state || !state.side) openPanelFromOverlay(panelId) })
      .catch(() => {})
  },
  isFeatureAvailable,
  onError: (error) => console.error('[app-shell] extensions toolbar:', error)
})
extensionsToolbarController.start()
addDisposer(() => {
  if (extensionsToolbarController) extensionsToolbarController.dispose()
})

// ── W13-3: Modal (alert/confirm/prompt) ───────────────
// modalManager 在 show() 时自动挂载到 body，无需手动 appendChild
const modalManager = createModalManager()

// ── navbar 按钮：顺序 / 显隐由 app.navbar_buttons 决定 ──
/** 主进程下发的面板目录（panel:catalog）—— 面板是插件，集合会变，故不缓存为常量。 */
let panelCatalogEntries: PanelCatalogEntry[] = []
/**
 * 从 navbar 的面板按钮打开面板时，面板该落在**哪一侧**。
 *
 * 那些按钮物理上可能在两处：横排 / Edge 型垂直标签时在顶部导航栏（靠右），
 * 全功能侧栏时随导航栏块的工具按钮行**借住到标签侧栏的底槽**（见 ui-navbar#row/sideDock）。
 * 后者若仍硬写 'right'，面板就会被拉到窗口右边 —— 而按钮明明就在侧栏里。
 * 故由外壳布局计划裁定（渲染侧唯一判定处，见 onPlan），按钮闭包只读这个值。
 * @type {'left'|'right'}
 */
let panelOpenSide: 'left'|'right' = 'right'
/** app.navbar_buttons 的当前值（{order,hidden}；未设置 = 全部可见）。 */
let navbarButtonsSetting: unknown
/**
 * navbar 侧可编辑目录 = 外壳按钮（静态）+ 面板条目（运行时）。
 * 必须是 `let`：插件启停会改变后半段 —— 禁用某个面板插件后，它对应的按钮必须从
 * 目录里消失（连同它在 editable 浮层里的那一格）。
 */
let NAVBAR_CATALOG: CatalogItem[] = buildCatalog([])

// ── 插件插槽：navbar 按钮 / 标签动作 ────────────────────────────────────
// 插槽 id 的真源在 `infra/infra-plugin/src/official-extension-points.ts` —— 这里只引用，
// 不另抄一份语义。渲染侧只认「描述符 → 目录项 / 按钮」这一条转换，插件从哪来完全无关。
const NAVBAR_BUTTON_SLOT = 'navbar.button-slot'
const TAB_ACTION_SLOT = 'tab.action-slot'
/** 插件插槽条目在目录 / DOM id 上的命名空间前缀（与 rail 的 `slot:` 同一口径）。 */
const SLOT_ID_PREFIX = 'slot:'
/** 插件浮层宿主名（app-shell 驱动 ↔ renderer/plugin-overlay 的一条 float 通道）。 */
const PLUGIN_OVERLAY_FLOAT = 'plugin-overlay'
/** 标签行里的插件动作容器（`#navbar-add-tab` 内、新建标签按钮之后）。 */
const TAB_ACTION_HOST_ID = 'plugin-tab-actions'

/**
 * 当前 navbar 上的插件按钮目录项（`id = slot:<key>`）。
 *
 * 为什么要进**目录**而不是直接 append 按钮：navbar 的显隐 / 排序由 `app.navbar_buttons`
 * 这条设置统一管理（编辑浮层靠目录认格子）。插件按钮只有进目录，才能被用户拖动、隐藏、
 * 在编辑浮层里看见 —— 否则就是"看得见但管不着"的第二套幽灵按钮。
 * @type {Array<object>}
 */
let slotCatalogItems: CatalogItem[] = []
let panelButtonsRevision = 0
/** 当前标签动作实现（`{ key, descriptor }`）—— 重挂时先摘旧节点，避免叠加。 */
let tabActionItems: SlotRenderItem[] = []
let tabActionRevision = 0

/** 取插槽渲染项的描述符（主进程 slot-render 的输出形状：`{ key, pluginId, descriptor }`）。 */
function slotDescriptorOf(item: SlotRenderItem | UnknownRecord | null | undefined): UnknownRecord {
  const descriptor = item && item.descriptor
  return descriptor && typeof descriptor === 'object' ? descriptor as UnknownRecord : {}
}

/**
 * 插槽渲染项 → 目录项。缺 label 的项直接丢弃（一颗无字无义的按钮对用户是噪音）。
 * @param {{ key?: string, pluginId?: string, descriptor?: object }} item
 */
function slotItemToCatalogItem(item: SlotRenderItem): CatalogItem | null {
  const key = String((item && item.key) || '').trim()
  if (!key) return null
  const descriptor = slotDescriptorOf(item)
  const label = String(descriptor.label || descriptor.title || '').trim()
  if (!label) return null
  const iconName = String(descriptor.icon || '').trim()
  return {
    id: `${SLOT_ID_PREFIX}${key}`,
    label,
    // 图标名来自插件 manifest：查不到就退到通用 Puzzle，绝不留一颗空白按钮。
    icon: (doc: Document, opts?: { size?: number }) => {
      const size = (opts && opts.size) || 18
      return (iconName && iconByName(iconName, doc, { size })) || Puzzle(doc, { size })
    },
    navbar: true,
    rail: false,
    segment: 'plugin',
    order: Number(descriptor.order) || 0,
    pluginId: typeof descriptor.pluginId === 'string' ? descriptor.pluginId : item.pluginId || null
  }
}

/** 重拉 navbar 插件按钮目录项。失败时清空（宁可少一颗，不要留一颗点不动的）。 */
async function loadSlotCatalogItems(): Promise<CatalogItem[]> {
  try {
    const items = await slotsClient.render(NAVBAR_BUTTON_SLOT, {})
    return (Array.isArray(items) ? items : [])
      .map(slotItemToCatalogItem)
      .filter((item): item is CatalogItem => item !== null)
  } catch (e) {
    console.error('[app-shell] render navbar slot failed:', e)
    return []
  }
}

/**
 * 按当前「引擎功能面可用性」重建 navbar 目录。
 *
 * 目录有**三个**动态来源，缺一不可：
 *   ① 面板条目（插件目录，`panel:catalog`）—— 面板插件被禁用时消失；
 *   ② 外壳按钮里声明了 `feature` 的那几个（星标 / 权限 Bell / 拦截盾牌）——
 *      它们背后的**引擎**被禁用时消失（§10.4）；
 *   ③ 插件插槽（`navbar.button-slot`）—— 插件声明的按钮，同样必须进目录，
 *      否则它既不能排序、也不能被隐藏，更不会出现在按钮编辑浮层里。
 * 三者都必须走目录（而不是只隐藏 DOM），否则编辑浮层里会留下永远拖不回来的格子。
 */
function buildNavbarCatalog(panelEntries: PanelCatalogEntry[]): CatalogItem[] {
  return [
    ...buildCatalog(panelEntries, filterCatalogByAvailability(CHROME_BUTTONS, isFeatureAvailable)),
    ...slotCatalogItems
  ]
}

async function mountPanelButtons() {
  const revision = ++panelButtonsRevision
  try {
    // 插槽项与面板目录并行拉 —— 两者互不依赖，串行只会让首帧多等一个 round-trip。
    const [entries, nextSlotCatalogItems] = await Promise.all([
      panelsClient.catalog().catch((error) => {
        console.error('[app-shell] panel catalog failed:', error)
        return null
      }),
      loadSlotCatalogItems()
    ])
    if (revision !== panelButtonsRevision) return
    if (entries !== null) panelCatalogEntries = Array.isArray(entries) ? entries : []
    slotCatalogItems = nextSlotCatalogItems
    NAVBAR_CATALOG = buildNavbarCatalog(panelCatalogEntries)
    // 按**全量**目录建按钮：显隐由 applyToolbarOrder 施加 —— 被隐藏的按钮也必须留在 DOM 里，
    // 否则编辑浮层里那一格就再也拖不回来了。
    // 传目录项（而非 id）的原因：名称/图标随插件 manifest 走，navbar 组件对面板零知识。
    const panelItems = panelCatalogEntries
      .map(panelEntryToCatalogItem)
      .filter((item): item is CatalogItem => item !== null && item.navbar !== false)
    const pluginItems = slotCatalogItems
    const buttonItems: NavbarPanelCatalogEntry[] = [...panelItems, ...pluginItems].map((item) => ({
      id: item.id,
      label: item.label,
      icon: item.icon,
      segment: item.segment
    }))
    // 去向由**条目自己**决定 —— 普通项开侧栏面板；声明了 opensWindow 的项开独立子窗口，
    // 声明了 opensPage 的项在标签页里开内部页（插件中心就是这一类）。
    // 判据与 rail 共用一份，见 renderer/shared/entry-action.js。
    // side：由 panelOpenSide 裁定（见其声明处）—— 按钮在顶部导航栏时是右侧，
    // 按钮借住到标签侧栏里时就是侧栏那一侧（就地展开，而不是被硬拉到右边）。
    // 插件插槽项（`slot:` 前缀）不是目录实体：点它 = 让主进程重新执行该实现。
    shell.renderPanelButtons(buttonItems, async (id) => {
      if (String(id).startsWith(SLOT_ID_PREFIX)) {
        try {
          await slotsClient.dispatch(NAVBAR_BUTTON_SLOT, String(id).slice(SLOT_ID_PREFIX.length), {})
        } catch (e) {
          console.error('[app-shell] dispatch navbar slot failed:', e)
        }
        return
      }
      const entry = findCatalogEntry(panelItems, id)
      if (entry) await openCatalogEntry(entry, { side: panelOpenSide })
    })
  } catch (e) {
    console.error('[app-shell] render panel buttons failed:', e)
  }
  // 顺序 / 显隐来自 app.navbar_buttons；拉一次初值，之后靠 settings:changed 热更新
  // （编辑浮层每次落点都会写这条设置）。必须用 settingsClient.get（已解包 {value} 信封）——
  // 直接拿信封对象会让 resolvePanelOrder 退回全可见，编辑结果重启后失效。
  //
  // ⚠ 读失败也必须落到 applyNavbarButtons()：它是「按设置施加」的唯一入口，
  // 一旦被上面的失败连带跳过，navbar 就静默停在目录全可见态 ——
  // 用户看到的就是「被我拖走隐藏的按钮重启后又回来了」。
  try {
    navbarButtonsSetting = await settingsClient.get(SHELL_BUTTON_SETTING_KEYS.navbar)
  } catch (e) {
    console.error('[app-shell] read navbar_buttons failed:', errorMessage(e))
  }
  if (revision !== panelButtonsRevision) return
  applyNavbarButtons()
}

/** 按当前设置施加 navbar 按钮的顺序与显隐。 */
function applyNavbarButtons() {
  // 首次启动（设置从未写入）只放「AI 助手 / 下载 / 收藏 / 历史」这四颗 —— 见 FIRST_RUN_LAYOUT；
  // 用户一旦编辑过（哪怕把四颗全删光），设置值存在就以设置为准，默认值不会把删掉的按钮复活。
  //
  // 插件插槽项必须**补进**首启可见集：`resolvePanelOrder` 会把目录里有、而首启清单里
  // 没有的 id 判为 hidden（那是「用户主动藏起来」的表达）。插件按钮是新出现的，
  // 不属于"用户藏过"，不补的话它们一装上就看不见 —— 只能去编辑浮层里翻出来。
  const firstRun = slotCatalogItems.length
    ? {
        ...FIRST_RUN_LAYOUT.navbar,
        visible: [...FIRST_RUN_LAYOUT.navbar.visible, ...slotCatalogItems.map((item) => item.id)]
      }
    : FIRST_RUN_LAYOUT.navbar
  const { visible } = resolvePanelOrder(navbarButtonsSetting, NAVBAR_CATALOG, firstRun)
  const segments = asStringRecord(asRecord(navbarButtonsSetting)?.segments)
  shell.applyToolbarOrder(visible, segments)
}

/**
 * 标签行里的插件动作容器。
 *
 * 为什么不自己造一条「插件标签行」：标签行 / 侧栏轨道是**同一个元素**在两种布局里
 * 整块搬家（见 ui-navbar 的 tabRow），另起一行就得在每次布局切换时手动同步位置与方向。
 * 这里只是把容器挂进 `#navbar-add-tab`（新建标签按钮所在的那个槽），它便随宿主一起走。
 */
function ensureTabActionHost() {
  const anchor = shell.addTabBtn
  const parent = anchor && anchor.parentNode
  if (!parent) return null
  let host = parent.querySelector(`#${TAB_ACTION_HOST_ID}`) as HTMLElement | null
  if (!host) {
    host = document.createElement('div')
    host.id = TAB_ACTION_HOST_ID
    host.className = 'plugin-tab-actions'
    host.style.cssText = 'display:none;align-items:center;gap:2px;flex:0 0 auto;'
    // 顺序 = 新建标签 → 插件动作：用户对「+」的位置有肌肉记忆，插件不得插到它前面。
    parent.insertBefore(host, anchor.nextSibling)
  }
  return host
}

/**
 * 重拉 `tab.action-slot` 并重挂标签行动作按钮。
 *
 * 插件动作带当前标签 id 派发：`onSelect(ctx)` 拿到 `{ tabId }` 才能对「用户此刻
 * 看着的那个标签」做事（打标签 / 收藏 / 送 AI ……）。没有活动标签时也照常派发 ——
 * 是否适用由插件自己判断，渲染层不替它做业务裁剪。
 */
async function mountTabActions() {
  const revision = ++tabActionRevision
  const host = ensureTabActionHost()
  if (!host) return
  let items: SlotRenderItem[] = []
  try {
    items = await slotsClient.render(TAB_ACTION_SLOT, {})
  } catch (e) {
    console.error('[app-shell] render tab action slot failed:', e)
  }
  if (revision !== tabActionRevision) return
  tabActionItems = (Array.isArray(items) ? items : []).filter((item) => item && item.key)
  while (host.firstChild) host.removeChild(host.firstChild)
  for (const item of tabActionItems) {
    const descriptor = slotDescriptorOf(item)
    const title = String(descriptor.label || descriptor.title || '').trim()
    if (!title) continue
    const iconName = String(descriptor.icon || '').trim()
    host.appendChild(createActionButton(document, {
      id: `plugin-tab-action-${item.key}`,
      title,
      size: 16,
      icon: (doc, opts) => {
        const size = (opts && opts.size) || 16
        return (iconName && iconByName(iconName, doc, { size })) || Puzzle(doc, { size })
      },
      onClick: () => {
        const tabId = tabSession?.getActiveTabId() || null
        slotsClient.dispatch(TAB_ACTION_SLOT, item.key, tabId ? { tabId } : {}).catch((e) => {
          console.error('[app-shell] dispatch tab action slot failed:', e)
        })
      }
    }))
  }
  // 没有实现时整块不占位（`display:none` 而不是空 div）—— 否则「+」右边会多一条
  // 看不见但会吃鼠标的空白。
  host.style.display = host.childElementCount ? 'flex' : 'none'
}

// ── 插件浮层（主进程 → 外壳 → float 宿主）──────────────────────────────
/**
 * 本窗口当前开着的插件浮层（`key → record`）。
 *
 * 主进程每次 show / hide 只推**一条增量**，而浮层宿主按「整份快照」渲染 ——
 * 所以这里维护全量表，任何变化都整份推下去。少一层增量合并，就少一处能错的合并逻辑。
 * @type {Map<string, unknown>}
 */
const pluginOverlayRecords = new Map<string, PluginOverlayRecord>()
/** 上一次真正发出去的快照签名（内容没变就不跨进程重发）。 */
let pluginOverlaySentSignature = ''

/** 把当前浮层快照推给 float 宿主；空栈时请主进程收起整层。 */
function syncPluginOverlayFloat() {
  const items = Array.from(pluginOverlayRecords.values())
  const signature = JSON.stringify(items.map((i) => [
    i.key, i.url, i.title, i.width, i.height, i.anchor, i.modal
  ]))
  if (signature === pluginOverlaySentSignature) return
  pluginOverlaySentSignature = signature
  const provider = getHiraBridge().provider
  try {
    if (items.length) provider.send(`${PLUGIN_OVERLAY_FLOAT}:show`, { items })
    else provider.send(`${PLUGIN_OVERLAY_FLOAT}:hide`, {})
  } catch (e) {
    console.error('[app-shell] sync plugin overlay failed:', e)
  }
}

addDisposer(getHiraBridge().on.subscribe<PluginOverlayRecord>(IPC_EVENTS.pluginOverlayShow, (record) => {
  if (!record || typeof record.key !== 'string' || !record.key) return
  pluginOverlayRecords.set(record.key, record)
  syncPluginOverlayFloat()
}))

addDisposer(getHiraBridge().on.subscribe<PluginOverlayHidePayload>(IPC_EVENTS.pluginOverlayHide, (payload) => {
  const key = payload && typeof payload.key === 'string' ? payload.key : ''
  if (!key) pluginOverlayRecords.clear()
  else pluginOverlayRecords.delete(key)
  syncPluginOverlayFloat()
}))

/**
 * 把 navbar 可编辑按钮的几何报给主进程（转给按钮编辑浮层）。
 * 必须在 `setPanelButtonsEditing(true)` **之前**上报 —— 一旦隐身就量不到了。
 */
function reportToolbarZone() {
  const segments = typeof shell.getToolbarZone === 'function' ? shell.getToolbarZone() : null
  try {
    // navbar 的小按钮与 chrome 整栏是两条独立几何链。即使 navbar 没有可编辑按钮，
    // 也必须上报 chrome 的 top / bottom / side —— 否则空顶栏/空底栏会完全没有投放区。
    if (Array.isArray(segments) && segments.length) {
      getHiraBridge().provider.send('buttons-edit:zone', { surface: 'navbar', segments })
    }
    const chromeZones = typeof chromeLayout.getBlockZones === 'function' ? chromeLayout.getBlockZones() : []
    if (chromeZones.length) {
      getHiraBridge().provider.send('buttons-edit:zone', { surface: 'chrome', segments: chromeZones })
    }
  } catch (_) {}
}

let toolbarZoneFrame = 0
function scheduleToolbarZoneReport() {
  if (toolbarZoneFrame || !buttonsEditActive) return
  toolbarZoneFrame = requestAnimationFrame(() => {
    toolbarZoneFrame = 0
    if (!buttonsEditActive) return
    reportToolbarZone()
  })
}
addDisposer(() => {
  if (toolbarZoneFrame) cancelAnimationFrame(toolbarZoneFrame)
  toolbarZoneFrame = 0
})

/**
 * 侧栏区（垂直标签栏那一条）此刻是否与 rail **争同一条窗口外缘**。
 *
 * 侧栏区是**纵向轨道上最外的一段** —— 它占住的那条外缘就归它（贴边展开由侧栏自己
 * 处理）。而 rail 也靠外缘触发「贴边唤出」，两者同侧时必然互相争夺：一条明确的归属
 * 规则比运行时仲裁更简单，也不会出现「两个抽屉同时弹出把网页挤没」。
 *
 * 两段**分居两侧**（侧栏区靠右、工具图标栏靠左）时各占一条外缘，互不冲突 ——
 * 这时 rail 那一条照常归 rail，故判据是「同侧」而不是「侧栏区在不在台上」。
 *
 * ⚠ 声明位置必须**早于** createWindowLayoutController：它的 onPlan 回调会读写本变量，
 * 而 onPlan 在控制器构造期就会跑一次。`let` 有暂时性死区 —— 声明排在后面的话，
 * 那一次回调会抛 "Cannot access before initialization"，且因为它在异步链里，
 * 表现为 unhandledrejection，同时把该次回调里排在后面的 `setNavSide` / `reportLayout`
 * 一并吞掉（布局报不上，界面就停在错的位置）。
 */
const windowLayoutController = createWindowLayoutController({
  window,
  shell,
  layoutClient,
  provider: getHiraBridge().provider,
  onSubscribe: <T>(event: string, callback: (payload: T) => void) => getHiraBridge().on.subscribe(event, callback),
  // 顶部占高 = 标题区 + 工具栏（默认/精致）+ 书签栏 → 由布局容器的顶部区回答；
  // 底部占高 = 底部布局下的工具栏（其余布局该区为空，量得 0）。
  topbarEl: chromeLayout.slots.top,
  // 「给侧栏让位」的行（书签栏）住在主列里的那一段 —— 网页的内缩要把它一起算上，
  // 所以两个都交给控制器（见 window-layout-controller#topMainEl 的说明）。
  topbarMainEl: chromeLayout.slots.topMain,
  bottombarEl: chromeLayout.slots.bottom,
  bottombarMainEl: chromeLayout.slots.bottomMain,
  // 侧栏区宽度也要让位：网页横向内缩 = 侧栏区 + rail + 面板，
  // 而 rail 的 x 会由主进程推到侧栏区内侧（见 LayoutCoordinator#applyInitialLayout）。
  // 默认布局下该元素 display:none → 量得 0 → 一行不差地与历史行为一致。
  sideEl: chromeLayout.slots.side,
  // 计划里的侧栏区（只读取值器）：悬停浮出形态与展开宽度都从计划来 ——
  // 与块自己收到的是**同一份事实**，不存在第二份"谁算宽度"的口径。
  getSideColumn: () => chromeLayout.getPlan().side
})
addDisposer(() => windowLayoutController.dispose())

// ── 外壳布局（设置 → 外观 → 布局）─────────────────────────────────────────
//
// 摆放是**策略**，全部交给 chrome-layout-controller：它读设置 → 组装计划 → 摆一次，
// 并在 settings:changed 时就地重摆。app-shell 在这里只做装配 —— 把四块元素交出来。
//
// 网页 bounds 由主进程按上报的占高算，所以每次换布局都要重新上报一次：
// navSide 交给 window-layout-controller（决定地址栏下拉向上/向下弹），
// 顶/底占高由它自己观察容器两侧后上报。
//
// `appName` 取自页面 <title>（index.html 里那一处，全仓唯一的应用名声明）——
// 不在这里再写一遍字面量：换名字只改 HTML 一处，原生窗口标题自动跟着变。
const APP_NAME = (document.title || '').trim()

/**
 * 推原生窗口标题（任务栏 / Alt-Tab / Aero Peek 上显示的那一行）。
 *
 * 两条都写、缺一不可：
 *   · `window:set-title` → 真正落到 BrowserWindow 上（chrome 外壳是 WebContentsView，
 *     它的 document.title 与窗口标题无关）；
 *   · `document.title` → 本视图自身的标题（Electron 由最上层视图推断标题时的兜底，
 *     也让调试台上的页面名可读）。
 * @param {string} text
 */
function setWindowTitle(text: string) {
  try { document.title = text } catch (_) {}
  try { getHiraBridge().provider.invoke('window:set-title', { title: text }).catch(() => {}) } catch (_) {}
}

const chromeLayoutController = createChromeLayoutController({
  chromeLayout,
  settingsClient,
  blocks: {
    tabbar: shell.tabbar,
    navbar: shell.toolbar,
    bookmarkbar: bookmarkController.element,
    titlebar: titlebarBlock
  },
  windowControls: shell.windowControls.element,
  mountWindowControls: (host) => {
    if (typeof shell.mountWindowControls === 'function') shell.mountWindowControls(host)
  },
  appName: APP_NAME,
  setWindowTitle,
  onPlan: (plan) => {
    // 精致（单行）模式下，导航栏那一块的**行内顺序**由 navbar 自己重排
    // （前后/刷新/主页 → 空间切换之后、标签条之前）。这是块**内部**的事，
    // 摆放计划只告诉它「现在是单行模式」，不替它搬 DOM。
    //
    // ⚠ 判据必须是 `plan.merged`（本次**真的**发生了合并），不是 `plan.mode`：
    //   标签栏进了侧栏之后，`mode` 仍是 compact，但两块不在同一行区 → 合并无从发生。
    //   若按 mode 传下去，导航按钮会被搬进标签行 —— 而那一行此刻不在台上（标签栏
    //   已换成正列的纵向列表），按钮就凭空消失了。
    if (typeof shell.setCompactLayout === 'function') shell.setCompactLayout(plan.merged === true)
    // 侧栏只有**形态**两种事实，组件各收一条：
    //   · collapsed —— 用户显式折叠成图标条；**Edge 型自动隐藏时恒为真**
    //     （那种形态静止态就是一条标签 rail，展开由主进程浮层负责，见下）；
    //   · pinned    —— 常驻占位（true）/ 悬停唤出（false）。
    // 唤出形态有两型，判据只有计划里的 revealOverlay 一个：
    //   · revealOverlay=true（Edge 型）→ 本视图的侧栏区**永远**是 restWidth（56px 图标 rail），
    //     悬停展开由主进程的独立浮层 `sidebar-float` 覆盖网页完成 —— 网页不缩进不重排；
    //   · revealOverlay=false（全功能型）→ 同一块侧栏在 restWidth / revealWidth 之间切宽，
    //     由主进程贴边巡看推 setSideReveal（唤出即占位）。
    verticalTabs.setCollapsed(!!(plan.side && (plan.side.collapsed || plan.side.revealOverlay)))
    verticalTabs.setPinned(!!(plan.side && !plan.side.autoHide))
    // 侧栏区自己那一侧（与 rail / 面板那一段**相互独立**）：由计划裁定并转告主进程。
    // 没有块住侧栏时计划不给位置（保留上一次的值，等它回来时已经在正确一侧）。
    if (plan.side) windowLayoutController.setSideColumnSide(plan.side.position)
    // 面板按钮该在哪一侧开面板：按钮此刻住在**标签侧栏**里（= 导航栏块也在侧栏，
    // 其工具按钮行已借住到侧栏底槽，见 ui-navbar#row/sideDock）→ 就地开在侧栏那一侧；
    // 否则（横排 / Edge 型垂直标签，按钮还在顶部导航栏）→ 开在按钮所在的右侧。
    // 这是**渲染侧唯一的裁定处**：按钮点击闭包只读它，不必自己判断 DOM 归属。
    panelOpenSide = plan.side && plan.side.rows.some((band) => band.includes('navbar'))
      ? plan.side.position
      : 'right'
    // 侧栏区在台上 = 它占住了窗口外缘的一段。若它恰好与 rail **同侧**，两者都靠同一个
    // 外缘触发「贴边唤出」、又都要占位，必然互相争夺 → 外缘归侧栏（它是最外那一段），
    // 停掉 rail 的边缘唤出。两段**分居两侧**时各占一条外缘，互不冲突，rail 照常唤出。
    windowLayoutController.setNavSide(plan.navbarSide)
    windowLayoutController.reportLayout()
    // 侧栏开合 / 单行合并都会挪动地址栏 —— 浮层开着就按新锚点重报一次。
    reportSiteInfoGeometry()
  },

  /**
   * 块 → 宿主轴的通告（行区 = 横排，侧栏区 = 纵排）。
   *
   * 摆放计划只说「这块住在什么轴的区域里」；**块怎么变形是块自己的事** ——
   * 所以这里只做两件事：把话转给外壳组件，以及（对标签栏这一块）换掉它的代表元素。
   *
   * 为什么标签栏要换元素：同一块在两种区域里是**两种呈现** ——
   * 行区里是横向标签条（`#navbar-tabbar`），侧栏里是纵向标签列（ui-vertical-tabs）。
   * 它们是两个独立组件、互不认识，由编排层在切换时挑一个登记进布局。
   * 标签栏内部那几件「只属于它」的东西（空间切换器 / 窗口控制按钮）则由 navbar
   * 自己搬进侧栏槽位（`mountSideTabs`）—— 编排层不替任何块搬内部 DOM。
   * @param {string} id
   * @param {'row'|'column'} axis
   */
  onHostAxis: (id, axis) => {
    // 块 id → 「换轴要做的事」的一张表（**加一种两形态的块 = 表里一行**，不再写成 if 链）。
    // 每块做的事都由它自己的形态决定：标签栏是**两块呈现**（横条 ⇄ 纵列，得换代表元素，
    // 并把它借出的侧栏槽位转给 navbar），导航栏只有**一套 DOM + 两种排版**（自己认轴）。
    /** @type {Record<string, (axis: 'row'|'column') => void>} */
    const handlers: Record<string, (axis: 'row'|'column') => void> = {
      tabbar: (next) => {
        const inSide = next === 'column'
        // 记录"纵列此刻在不在台上"：onProjection 靠它决定要不要喂（见文件内说明）。
        verticalTabsOnStage = inSide
        const tabbarElement = inSide ? verticalTabs.element : shell.tabbar
        chromeLayoutController.setBlockElement('tabbar', tabbarElement)
        // 刚上台时补喂最近一次投影 —— 否则要等下一次 tab:changed 才有内容，
        // 表现为"切到纵列布局后标签列是空的，动一下标签才出来"。
        if (inSide && lastTabsProjection) {
          verticalTabs.setItems(lastTabsProjection as unknown as Parameters<typeof verticalTabs.setItems>[0])
        }
        if (typeof shell.mountSideTabs === 'function') {
          shell.mountSideTabs(inSide ? verticalTabs.slots : null)
        }
      },
      // 只转发给 navbar —— 各块的轴互不相干（V2 下标签栏在侧栏而导航栏仍在顶部：
      // 把标签栏的轴错发给导航栏，会让它在顶部就按纵排摆窗口控制按钮）。
      navbar: (next) => {
        if (typeof shell.setHostAxis === 'function') shell.setHostAxis(next)
      }
    }
    const handler = handlers[id]
    if (handler) handler(axis === 'column' ? 'column' : 'row')
  }
})

let chromeSettingsFrame = 0
const pendingChromeSettings = new Map()
function flushChromeSettings() {
  chromeSettingsFrame = 0
  if (!pendingChromeSettings.size) return
  const changes = Array.from(pendingChromeSettings)
  pendingChromeSettings.clear()
  chromeLayoutController.setSettings(changes)
  // 设置广播与重测 IPC 来自不同链路。布局施加后再报一次几何，
  // 保证编辑层拿到的是这一拍的真实位置，而不是上一张布局。
  if (buttonsEditActive) scheduleToolbarZoneReport()
}
addDisposer(getHiraBridge().on.subscribe('settings:changed', (change) => {
  if (!change) return
  if (change.scope === 'all') {
    if (chromeSettingsFrame) cancelAnimationFrame(chromeSettingsFrame)
    chromeSettingsFrame = 0
    pendingChromeSettings.clear()
    chromeLayoutController.refresh()
    if (buttonsEditActive) scheduleToolbarZoneReport()
    return
  }
  if (typeof change.key !== 'string' || !change.key || !chromeLayoutController.handles(change.key)) return
  pendingChromeSettings.set(change.key, change.value)
  if (!chromeSettingsFrame) chromeSettingsFrame = requestAnimationFrame(flushChromeSettings)
}))
addDisposer(() => {
  if (chromeSettingsFrame) cancelAnimationFrame(chromeSettingsFrame)
  chromeSettingsFrame = 0
  pendingChromeSettings.clear()
})

// ── 侧栏悬停唤出（主进程贴边巡看推下来）────────────────────────────────────
//
// 收起后指针全在网页那条原生视图上，本视图收不到任何指针事件 —— "此刻该不该展开"
// 只能由主进程按屏幕指针位置算（见 LayoutCoordinator#_sideReveal*）。这里只做一件事：
// 把同一块侧栏的宽度口径在 restWidth / revealWidth 之间切一刀。
// ⚠ 只对**占位型**（revealOverlay=false）有意义：Edge 型的侧栏区恒为图标 rail，
//   展开由主进程那条独立浮层完成 —— 这条指令在那边是空操作（宽度两档取同一个值）。
addDisposer(getHiraBridge().on.subscribe(IPC_EVENTS.sideColumnReveal, (payload) => {
  chromeLayoutController.setSideReveal(!!(payload && payload.revealed))
}))

/**
 * **profile 变了**（切 profile / 切到属于别的 profile 的空间）→ 外壳里那些**按 profile
 * 分区的内容**必须自己重取一遍。
 *
 * 为什么不能只靠上面那条 `settings:changed`：那条覆盖的是**设置值**；而书签栏里的固定书签、
 * 导航栏上的星标状态都是**数据**（域层按 profile 分区），数据域不会因为换了用户就自己发一条
 * changed —— 少了这条订阅，切完 profile 外壳里还是上一个用户的书签，**不手动刷新就一直留着**。
 *
 * 与上面那条分开订阅而不是合并：两者的**事实来源不同**（"某个设置值变了" vs "换用户了"），
 * 硬合成一条就得造一个假的 key 来复用，读的人只会更糊涂。
 */
addDisposer(getHiraBridge().on.subscribe(IPC_EVENTS.profileChanged, () => {
  if (disposed) return
  if (bookmarkController) {
    bookmarkController.refreshBar()
    bookmarkController.refreshStar()
  }
}))

// 扩展会话是切 profile 里最重的异步段。它准备完成后主进程再发这一条，
// 此时刷新固定扩展条 / 可用性才是目标 profile 的真实结果；提前跟着 profile:changed
// 去拉只会短暂显示上一个 profile 的图标，然后又被纠正，正是要消灭的闪烁。
addDisposer(getHiraBridge().on.subscribe(IPC_EVENTS.extensionChanged, () => {
  if (disposed) return
  if (extensionsToolbarController) extensionsToolbarController.refresh()
  if (extensionsToolbarController) extensionsToolbarController.syncEngineAvailability()
}))

// 书签栏的可见性登记接上布局控制器（延迟绑定的兑现，见 syncBookmarkbarBlock）。
// 必须在这里补一次初始同步：启动期那几次 renderBar 发生在布局控制器创建之前，
// 当时的通知被空实现吞掉了 —— 不补的话「启动时书签栏本就不可见」这一情形会一直
// 把书签栏登记在布局里，底部就会多出一条不该有的边距。
//
// 登记状态真的变了才重新上报占高：底栏容器的高度跟着变（多一行 / 少一行），
// 主进程那份 bounds 参数必须跟上 —— 但没变时一次也不多花（Tab 切换是高频路径）。
syncBookmarkbarBlock = (shown) => {
  if (chromeLayoutController.setBlockVisible('bookmarkbar', shown)) {
    windowLayoutController.reportLayout()
  }
}
syncBookmarkbarBlock(
  typeof bookmarkController.isBarVisible === 'function' ? bookmarkController.isBarVisible() : true
)

const keyboardShortcutsController = createKeyboardShortcutsController({
  onSubscribe: (route: string, listener: (payload: unknown) => void) => getHiraBridge().on.subscribe(route, listener),
  addressInput: shell.addressInput
})
addDisposer(() => keyboardShortcutsController.dispose())

mountPanelButtons()
mountTabActions()
// 面板集合随插件启停变化 → 重挂一轮按钮（目录 + DOM + 编辑浮层几何三处必须同步）。
addDisposer(panelsClient.onChanged(() => { mountPanelButtons().catch(() => {}) }))

/**
 * 插件的 **chrome 级贡献**（navbar 按钮 / 标签动作 / 浮层）发生变化。
 *
 * 与 `panelsClient.onChanged` 分开订阅的原因：那条管的是「面板目录」，
 * 这条管的是「外壳上直接长出来的东西」。插件的 `contributes.navbarButtons` 改一个
 * 图标不会新增面板，但必须让按钮重画 —— 两者要重建的对象不同。
 */
addDisposer(getHiraBridge().on.subscribe(IPC_EVENTS.pluginChromeChanged, () => {
  mountPanelButtons().catch(() => {})
  mountTabActions().catch(() => {})
}))

/**
 * 引擎功能面可用性变化 → 重挂一轮 + 收拾受影响的入口（§10.4）。
 *
 * 为什么这里**两种**订阅都要有（`panelsClient` 与 `onFeaturesChanged` 底层是同一个
 * `plugins:changed` 广播）：它们要重建的**东西不同**。
 *   · 面板目录变了 → navbar/rail 的面板按钮要重挂；
 *   · 引擎被禁用了 → 外壳按钮目录（星标/盾牌/Bell）要重挂，**还会连带**影响那些
 *     不是按钮的入口（书签栏、下载条）。
 * 前者只关心"有哪些面板"，后者关心"哪些功能面还在"，各自重建自己的那一份。
 *
 * `onFeaturesChanged` 已经是单例 store（一条桥订阅、一次去重请求），
 * 所以这里再订阅一次不会放大广播（见 features-client.js 的说明）。
 */
addDisposer(onFeaturesChanged(() => {
  NAVBAR_CATALOG = buildNavbarCatalog(panelCatalogEntries)
  applyNavbarButtons()
  // 书签栏 / 下载条不是目录项，得单独收敛 —— 它们是"引擎在就显示、引擎没了就撤"的形态。
  if (bookmarkController) bookmarkController.syncEngineAvailability()
  if (downloadController) downloadController.syncEngineAvailability()
  // 扩展引擎被禁用 → 撤订阅并清空图标条（留着也点不开）；恢复 → 重新订阅并补列表
  if (extensionsToolbarController) extensionsToolbarController.syncEngineAvailability()
  // PWA 引擎被禁用 → 清空按钮状态；恢复 → 立刻按当前标签重查一次
  if (pwaInstallController) pwaInstallController.syncEngineAvailability()
}))
tabSession.start()
const refreshTabsOnFocus = () => {
  if (disposed || document.visibilityState === 'hidden') return
  tabSession?.refresh().catch((error) => {
    console.error('[app-shell] focus refresh failed:', error)
  })
}
window.addEventListener('focus', refreshTabsOnFocus)
document.addEventListener('visibilitychange', refreshTabsOnFocus)
addDisposer(() => {
  window.removeEventListener('focus', refreshTabsOnFocus)
  document.removeEventListener('visibilitychange', refreshTabsOnFocus)
})
requestAnimationFrame(() => {
  if (!disposed) windowLayoutController.reportHeaderHeight()
})

addDisposer(getHiraBridge().on.subscribe('tab:loading', (payload) => {
  if (disposed || !payload) return
  /**
   * 「这条边沿是不是活动标签的」**由主进程裁定**（payload.active），不再由渲染层自己
   * 比对 tabId —— 那是这里曾经整条失灵的原因：启动首个标签的 did-start-loading 早于
   * 第一份 tab:changed，此刻渲染层的 activeTabId 还是 null，比对必然失配，于是
   * "开始加载"被丢掉（进度条不出现），只有"结束加载"恰好赶上才生效。
   *
   * 兼容：不带 active 的旧载荷仍按 tabId 比对兜底；两者都判不了时才丢弃。
   */
  const isActive = typeof payload.active === 'boolean'
    ? payload.active
    : (!!payload.tabId && payload.tabId === tabSession.getActiveTabId())
  if (!isActive) return
  const loading = !!payload.loading
  shell.setLoading(loading)
  // 加载中 → 刷新键变停止键（与 Hira `navigationButtons.updateRefresh` 同一语义：
  // 加载边沿立刻切形态；顶部进度条是另一条独立的反馈）。
  if (typeof shell.setNavState === 'function') shell.setNavState({ loading })
}))

/**
 * **导航已提交**（含刷新）→ 强制回填地址栏。
 *
 * 为什么必须单独订阅、且必须绕过 `syncAddressBar` 的「值没变就不写」守卫：
 * 刷新是同一个 URL 重新提交，`next === lastSyncedAddress` 恒成立，守卫会把这次回填
 * 整个吞掉 —— 用户手改了一半的文本就留在地址栏里，显示的地址与页面实际地址不符。
 * 导航提交是**确定性的地址变化事实**（用户按回车 / 点了链接 / 刷新 / SPA 路由），
 * 此时覆盖输入框里的半截内容正是期望行为。
 *
 * 为什么不用 `tab:loading` 的起点：那一刻 Chromium 尚未提交新文档，`tab` 投影里的
 * `url` 还是**上一页**（见 infra-window/tabEvents 的 did-start-loading 注释），
 * 拿它回填会「输新网址回车 → 先闪回旧地址」。本事件的 `url` 是主进程写回的真实地址。
 */
addDisposer(getHiraBridge().on.subscribe('tab:navigated', (payload) => {
  if (disposed || !payload) return
  const url = String(payload.url || '')
  if (!url) return
  const isActive = typeof payload.active === 'boolean'
    ? payload.active
    : (!!payload.tabId && payload.tabId === tabSession.getActiveTabId())
  if (!isActive) return
  const active = typeof tabSession.getActiveTab === 'function' ? tabSession.getActiveTab() : null
  writeAddress(isNewTabPageUrl(url) ? '' : url, active)
}))

// ── 渲染侧插件插槽（`plugin-slots.js`）激活 ────────────────────────────
// 必须晚于所有 `defineRendererSlots`（激活时按已声明的宿主清单过滤实现），
// 所以在文件末尾统一执行。插件启停后再跑一次即可 —— 注册表整体重建，
// "禁用插件 → 它的实现立刻消失"因此是天然成立的，不需要增量摘除。
function refreshRendererSlots(): void {
  void activateRendererSlots().catch((error) => {
    console.error('[app-shell] renderer slots activation failed:', error)
  })
}
refreshRendererSlots()
addDisposer(pluginsClient.onChanged(refreshRendererSlots))

