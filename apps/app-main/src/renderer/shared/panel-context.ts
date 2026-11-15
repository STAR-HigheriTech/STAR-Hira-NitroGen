/**
 * panel-context.js —— 面板**端口工厂**（宿主无关）。
 *
 * 一块面板的"能对外做什么"是一份固定清单：IPC 客户端、菜单、确认框、插槽、图标、
 * 事件订阅……这份对象原本由 `panels/host.js` 就地构造，只有侧栏面板宿主能产出。
 * "面板 → 独立窗口"成为通用能力（`detached-panel`）之后，两个宿主必须产出**同一份**
 * 端口 —— 否则同一个 panelDefinition 在两种形态里能力不一致（最典型：某个面板在
 * 窗口里没有 `openWindow`，点了没反应）。
 *
 * 所以：构造收口在这里，宿主只决定 `compact` 与"有没有外侧浮层"这类**形态差异**。
 * 另外传一个 `host` 身份：形态管的是**长什么样**，宿主管的是**记忆归谁**（会话分槽）。
 *
 * 分层不变：面板包不 import apps 层客户端，端口由宿主注入（CONTRACT-11）。
 */

import { IPC_EVENTS, IPC_ROUTES } from '@hira-ng/shared-types/src/ipc-channels.mjs'
import { pageUrl } from '@hira-ng/shared-types/src/pages.mjs'
import {
  tabsClient, panelsClient, bookmarksClient, extensionsClient, spaceClient,
  profilesClient, settingsClient, pluginsClient, notesClient, totpClient,
  screenCaptureClient, sessionClient, aiClient, featuresClient, isFeatureAvailable
} from './hira-client.js'
import { themeClient } from './theme-client.js'
import { layoutClient } from './layout-client'
import { menuClient } from './menu-client.js'
import { spaceIconSvg, uiIconSvg } from '../../pages/_shared/icons.js'
import { confirm as confirmDialog, type TabRowPreviewOverlay } from '@hira-ng/ui-common'
import { openUrlPreferExistingTab } from '@hira-ng/ui-common/src/bookmark-open'
import type { ConfirmOptions } from '@hira-ng/ui-common/src/confirm'
import type { JsonRecord, RendererBridge } from './bridge'
import type { TabRowMenuInvocation } from './tab-row-menu.js'

interface PanelClients {
  tabs: typeof tabsClient
  panels: typeof panelsClient
  bookmarks: typeof bookmarksClient
  notes: typeof notesClient
  totp: typeof totpClient
  extensions: typeof extensionsClient
  space: typeof spaceClient
  profiles: typeof profilesClient
  settings: typeof settingsClient
  plugins: typeof pluginsClient
  themes: typeof themeClient
  screen: typeof screenCaptureClient
  sessions: typeof sessionClient
  ai: typeof aiClient
  features: typeof featuresClient
}

export interface PanelContext extends JsonRecord {
  doc: Document
  bridge: RendererBridge
  compact: boolean
  host: 'panel' | 'window' | 'page'
  panelId?: string
  detached?: boolean
  payload?: Record<string, unknown>
  slots: unknown
  previewOverlay: TabRowPreviewOverlay | null
  clients: PanelClients
  events: typeof IPC_EVENTS
  on(route: string, handler: (payload: unknown) => void): () => void
  icons: {
    space(name: string, size?: number): Element | null
    ui(name: string, size?: number): Element | null
  }
  menu: typeof menuClient
  createTabRowMenu: typeof createTabRowMenu
  openWindow(type: string, payload?: unknown): Promise<unknown>
  openPage(host: string): Promise<unknown>
  isFeatureAvailable(featureId: string): boolean
  confirm(options?: ConfirmOptions | string): Promise<boolean>
}

interface PanelContextOptions {
  bridge: RendererBridge
  panelId: string
  compact?: boolean
  previewOverlay?: TabRowPreviewOverlay | null
  slots?: unknown
  host?: 'panel' | 'window' | 'page'
}

/**
 * `slots` 由宿主注入（见 `panel-slot-port.js`）：插槽系统住在插件注册表里，
 * 内部页这类"没有插件插槽宿主"的形态传 null 即可 —— 多模态共用一份端口工厂，
 * 但不该为了共用而把整条插件注册表拉进每个宿主的依赖图。
 */

/**
 * 「菜单动作之后刷新面板」的**晚绑定**目标。
 * 菜单真正弹起时刷新函数必然已就位（挂载完成才会挂菜单）。
 */
let refreshMountedPanel: (() => unknown) | null = null
export function setPanelRefresh(fn: (() => unknown) | null | undefined): void {
  refreshMountedPanel = typeof fn === 'function' ? fn : null
}
export function refreshPanel() {
  try { if (refreshMountedPanel) Promise.resolve(refreshMountedPanel()).catch(() => {}) } catch (_) {}
}

/**
 * 标签行右键菜单 —— **按需加载**（面板冷启动的关键路径，理由见 tab-row-menu.js）。
 *
 * 返回的仍是 `(opts) => show`；`show` 在菜单真被弹出时才加载内核。
 * 返回 Promise 对调用方无影响（所有调用点都在事件处理器里，不读返回值）。
 */
type TabRowMenuFactory = ReturnType<typeof import('./tab-row-menu.js').createTabRowMenuFactory>
type TabContextMenu = ReturnType<TabRowMenuFactory>
let tabRowMenuFactoryPromise: Promise<TabRowMenuFactory> | null = null
function loadTabRowMenuFactory(): Promise<TabRowMenuFactory> {
  if (!tabRowMenuFactoryPromise) {
    tabRowMenuFactoryPromise = import('./tab-row-menu.js')
      .then((mod) => mod.createTabRowMenuFactory({ refresh: refreshPanel }))
      .catch((e) => {
        tabRowMenuFactoryPromise = null
        console.error('[panels] 标签右键菜单工厂加载失败:', e)
        throw e
      })
  }
  return tabRowMenuFactoryPromise
}

export function createTabRowMenu(opts: TabRowMenuInvocation = {}) {
  let show: TabContextMenu | null = null
  let loading: Promise<TabContextMenu> | null = null
  return (...args: Parameters<TabContextMenu>): ReturnType<TabContextMenu> | Promise<Awaited<ReturnType<TabContextMenu>>> => {
    if (show) return show(...args)
    if (!loading) {
      loading = loadTabRowMenuFactory()
        .then((factory) => { show = factory(opts); return show })
        .catch((e) => { loading = null; throw e })
    }
    return loading.then((fn) => fn(...args))
  }
}

/**
 * 构造面板 ctx。
 *
 * @param {{
 *   bridge: { provider: unknown, on: { subscribe: (route: string, fn: Function) => unknown } },
 *   panelId: string,
 *   compact?: boolean,
 *   previewOverlay?: object|null,
 *   slots?: { call: Function, callMulti: Function, reduce: Function }|null,
 *   host?: 'panel'|'window'|'page',
 * }} options
 * @returns {object} 面板 ctx
 */
export function createPanelContext({
  bridge,
  panelId,
  compact = true,
  previewOverlay = null,
  slots = null,
  host = 'panel'
}: PanelContextOptions): PanelContext {
  const ctx: PanelContext = {
    doc: document,
    bridge,
    /**
     * **宿主形态声明**：窄栏面板（200~600px）为 true，独立窗口为 false。
     * 面板包据此决定信息密度 —— 组件不该猜自己在哪儿（猜必然漂移）。
     */
    compact,
    /**
     * **宿主身份**：`panel` 侧栏 / `window` 独立窗口 / `page` 内部页。
     *
     * 与 `compact` 是两件事：compact 决定"画得松还是紧"，host 决定**当前会话记在谁名下**。
     * 三种宿主因此可以各自停在不同对话上；换宿主时会话由迁移快照带着走
     * （见 `main/ui-state.cjs#sessionIdByHost` 与 `ui/store.js#serialize`）。
     */
    host: host === 'window' || host === 'page' ? host : 'panel',
    layout: layoutClient,
    clients: {
      tabs: tabsClient,
      panels: panelsClient,
      bookmarks: bookmarksClient,
      notes: notesClient,
      totp: totpClient,
      extensions: extensionsClient,
      space: spaceClient,
      profiles: profilesClient,
      settings: settingsClient,
      plugins: pluginsClient,
      themes: themeClient,
      screen: screenCaptureClient,
      sessions: sessionClient,
      features: featuresClient,
      // AI 助手：引擎是第一方插件，禁用时这些调用会 reject —— 面板按「不可用」处理。
      ai: aiClient
    },
    /**
     * 打开一个独立子窗口。类型字符串由面板给、枚举住在主进程 ——
     * 面板不需要认识窗口类型表（与 manifest 的 `opensWindow` 同一条判据）。
     */
    openWindow: (type, payload) => bridge.provider.invoke(IPC_ROUTES.windowOpen, payload ? { type, payload } : { type }),
    /**
     * 打开一个**内部页**（`hira://<host>`）：已有同页标签则切过去，否则新开。
     *
     * 面板只报 host（页面身份的唯一真源是 `pages.mjs`），不认识 URL 拼法，也不认识
     * "这一页长什么样"。主题库 / 插件中心这类**宽形态**都由它打开：
     * 页面是活动标签，用户能并排对照着改（子窗口做不到这件事）。
     */
    openPage: (host) => {
      const key = String(host == null ? '' : host).trim()
      if (!key) return Promise.resolve(null)
      return openUrlPreferExistingTab(pageUrl(key), tabsClient)
    },
    menu: menuClient,
    /**
     * 功能面可用性判据（`main/feature-map.js` 的渲染侧只读投影，见 features-client）。
     * 面板的菜单项据此联动插件开关：引擎被关掉 → 相关入口不出现，而不是点了报错。
     * 与 `clients.*` 的区别：客户端总是存在（被禁用时调用才失败），这里回答"该不该出现"。
     */
    isFeatureAvailable: (featureId) => isFeatureAvailable(featureId),
    /** 事件名表 + 订阅入口（数据，不是 import）。 */
    events: IPC_EVENTS,
    on: (route, handler) => bridge.on.subscribe(route, handler),
    confirm: (opts) => confirmDialog(document, typeof opts === 'string' ? { message: opts } : opts),
    previewOverlay,
    slots,
    createTabRowMenu,
    icons: {
      space: (name, size) => spaceIconSvg(document, name, { size: size || 18 }),
      ui: (name, size) => uiIconSvg(document, name, { size: size || 14 })
    }
  }
  // panelId 也进 ctx：面板不必自己记"我是谁"（detached 窗口靠 URL 参数才拿得到）。
  ctx.panelId = panelId
  return ctx
}



