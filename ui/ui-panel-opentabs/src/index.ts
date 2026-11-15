// @ts-check
/**
 * @hira-ng/ui-panel-opentabs —— 「标签」侧边面板（分段壳）
 *
 * ── 为什么是「打开中 / 播放中 / 已固定」三段而不是三个面板 ───────
 * 三者回答的是同一族问题：「我的标签去哪了？」
 *   · 打开中   = 现在开着的全部（`pinned ⟺ 属于 pinned 栈`，见 tabLayout）；
 *   · 播放中   = 其中正在出声的那些（判据 `isPlaying`，与标签条徽标同一处）；
 *   · 已固定   = 常驻的那部分（固定标签 / 固定文件夹）；
 * 标签归档已并入集锦面板，避免两个面板重复展示同一批归档。
 *
 * ── 分段壳只做四件事 ────────────────────────────────────────────────────
 *   1. 画分段栏；
 *   2. **懒装配**：某一段第一次被切到时才创建视图（绝大多数会话只看第一段，
 *      不该为固定视图付一次 tabs.list + settings.get 的 IPC 与 DOM 成本）；
 *   3. 分段偏好落设置项 `panels.tabs_view_mode`（随 profile 持久化，多窗口同步）；
 *   4. 转发 `setItems` / `refresh` / `focusSearch` / `dispose`。
 * 三段视图本身都是**哑组件**，互不认识：
 *   · `open`    = `@hira-ng/ui-common#createTabListHost`（与侧栏纵向列、覆盖态悬浮列表
 *                 **同一份实现**，所以三者任何时刻都一模一样）；
 *   · `playing` = `./playingView.js`（同一份列表实现，只多三处参数：过滤 / 扁平数据源 / 空态）；
 *   · `pinned`  = `./pinnedView.js`（列表 / 网格两种形态共用一份文件夹模型）。
 *
 * 解耦要点：
 *  - 不直接调 IPC，所有动作（含原生右键菜单）由编排层经 ctx 注入
 *  - 打开中的视图自订阅（`autoSubscribe`）—— 面板住在独立 WebContentsView，只能自己拉
 */

import type { PanelDefinition, PanelContext, PanelInstance } from '@hira-ng/ui-common'
import { injectPanelStyles, injectTabRowStyles, createTabListHost } from '@hira-ng/ui-common'
import type { TabListHostContext, TabRowItem } from '@hira-ng/ui-common'
// 分段值集合与偏好键名的真源（分段壳 / 域层默认值 / 设置页共用），见 panels.mjs。
import { PANELS_SETTING_KEYS, TABS_VIEW_MODES } from '@hira-ng/shared-types/src/panels.mjs'
import { createPinnedView, injectPinnedViewStyles } from "./pinnedView"
import { createPlayingView, injectPlayingViewStyles } from "./playingView"

/** 分段偏好键（默认值见 domain-settings 的 DEFAULT_SETTINGS）。 */
const SEGMENT_KEY = PANELS_SETTING_KEYS.tabsViewMode

/**
 * 分段表：顺序即展示顺序。`key` 同时是视图注册表的键。
 *
 * 取值与顺序来自 shared-types（分段壳白名单 / 域层默认值 / 设置页共用同一份）；
 * 中文名是**本视图自己的文案**，不搬去共享层。
 *
 * 标签取两字：面板最窄 200px，四个分段等分后每段约 44px ——
 * 三字标签（含内距）在最小宽度下会互相挤压换行，两字是全宽度下的稳定解。
 */
const SEGMENT_LABELS = { open: '打开', playing: '播放', pinned: '固定' }
type SegmentName = keyof typeof SEGMENT_LABELS
type Segment = { key: SegmentName; label: string }
const SEGMENTS: Segment[] = TABS_VIEW_MODES.flatMap((key) => (
  key in SEGMENT_LABELS ? [{ key: key as SegmentName, label: SEGMENT_LABELS[key as SegmentName] }] : []
))

/** 合法分段键集合 —— 偏好读回 / 外部推送的**唯一**白名单出处。 */
const SEGMENT_KEYS = new Set(SEGMENTS.map((s) => s.key))

interface SegmentView {
  element: HTMLElement
  setItems?: (items: readonly TabRowItem[]) => void
  refresh?: () => Promise<void>
  focusSearch?: () => boolean
  dispose?: () => void
}

interface SettingsPort {
  get(key: string): Promise<unknown>
  set(key: string, value: unknown): Promise<unknown>
}

const STYLE_ID = 'hira-opentabs-panel-styles'

export function injectOpenTabsPanelStyles(doc: Document): void {
  injectPanelStyles(doc)
  injectTabRowStyles(doc)
  // 固定视图样式随本面板一起注入 —— 视图是懒装配的，
  // 样式不能等它创建时才到（否则第一次切段会闪一下无样式内容）。
  injectPinnedViewStyles(doc)
  injectPlayingViewStyles(doc)
  if (doc.getElementById(STYLE_ID)) return
  const style = doc.createElement('style')
  style.id = STYLE_ID
  style.textContent = `
    .opentabs-root { display: flex; flex-direction: column; height: 100%; min-height: 0; }
    /* 分段栏：与历史面板的选项卡同一套视觉规格（同层级、同高度、同选中态），
       两处的"面板内分段"因此看起来是同一种东西。 */
    .opentabs-seg { display: flex; gap: 4px; padding: 0; flex-shrink: 0; margin-bottom: 8px; }
    .opentabs-seg__tab {
      position: relative; flex: 1; border: none; background: transparent;
      height: var(--hira-control-height, 32px); padding: 0 10px;
      border-radius: var(--hira-radius-sm, 8px); cursor: pointer;
      font-family: inherit; font-size: 12px;
      color: var(--hira-text-secondary, #6b7280);
      transition: color var(--hira-dur-fast, 120ms) var(--hira-ease-standard, ease),
                  background var(--hira-dur-fast, 120ms) var(--hira-ease-standard, ease);
    }
    .opentabs-seg__tab:hover { background: var(--hira-surface-soft, rgba(0,0,0,0.05)); color: var(--hira-text-primary, #1a1a1a); }
    .opentabs-seg__tab[aria-selected="true"] {
      color: var(--hira-accent, #3b82f6); font-weight: 500;
      background: var(--hira-accent-soft, rgba(59,130,246,0.14));
    }
    .opentabs-body { display: flex; flex-direction: column; flex: 1; min-height: 0; }
    /* 每个分段=一个视口容器。列表本体是哑的，滚动责任取决于它自己的形态：
       · 无搜索框（固定 / 归档 / 播放）—— 列表只有 min-height:100%，滚动由**这一层**承担；
       · 带搜索框（打开）—— 列表自带 .tabrow-shell（固定搜索条 + 自己的滚动视口），
         高度被它占满，这一层不再产生滚动，两套形态互不干扰。
       缺 min-height:0 时本层按内容撑开（= 无滚动）；缺 overflow 则溢出被 #root 裁掉。 */
    .opentabs-view { display: flex; flex-direction: column; flex: 1; min-height: 0; overflow-y: auto; overscroll-behavior: contain; }
    .opentabs-view[hidden] { display: none; }
  `
  doc.head.appendChild(style)
}

/**
 * @param {Document} doc
 * @param {PanelContext} [ctx] 面板宿主端口（clients / menu / createTabRowMenu / previewOverlay / on / events）
 * @returns {{
 *   element: HTMLElement,
 *   setItems: (tabs: readonly TabRowItem[]) => void,
 *   refresh: () => Promise<void>,
 *   focusSearch: () => boolean,
 *   dispose: () => void
 * }}
 */
export function createOpenTabsPanel(doc: Document, ctx: PanelContext = {}) : {
  element: HTMLElement,
  setItems: (tabs: readonly TabRowItem[]) => void,
  refresh: () => Promise<void>,
  focusSearch: () => boolean,
  dispose: () => void
} {
  injectOpenTabsPanelStyles(doc)
  const settings = (ctx.clients?.settings as SettingsPort | undefined) || null

  let active: SegmentName = SEGMENTS[0].key
  let disposed = false
  /** 视图注册表：`null` = 尚未装配（懒挂载）。键集与 SEGMENTS 一致。 */
  const views = Object.fromEntries(SEGMENTS.map((s) => [s.key, null])) as Record<SegmentName, SegmentView | null>
  /** 每个视图的宿主容器（切段只翻 `hidden`，不销毁不重建）。 */
  const hosts: Partial<Record<SegmentName, HTMLDivElement>> = {}
  /** 打开中视图尚未装配时收到的数据（等它装配时补灌一次）。 */
  let pendingOpenItems: readonly TabRowItem[] | null = null

  const root = doc.createElement('div')
  root.className = 'opentabs-root'

  const segBar = doc.createElement('div')
  segBar.className = 'opentabs-seg'
  segBar.setAttribute('role', 'tablist')
  const segTabs = {} as Record<SegmentName, HTMLButtonElement>
  for (const segment of SEGMENTS) {
    const tab = doc.createElement('button')
    tab.type = 'button'
    tab.className = 'opentabs-seg__tab'
    tab.setAttribute('role', 'tab')
    tab.setAttribute('aria-selected', segment.key === active ? 'true' : 'false')
    tab.textContent = segment.label
    tab.addEventListener('click', () => switchSegment(segment.key, true))
    segTabs[segment.key] = tab
    segBar.appendChild(tab)
  }

  const body = doc.createElement('div')
  body.className = 'opentabs-body'
  root.append(segBar, body)

  /** 第一段：打开 —— 与纵向标签列 / 覆盖态悬浮列表同一份实现。 */
  function mountOpenView() {
    const hostCtx = ctx as TabListHostContext
    return createTabListHost(doc, {
      clients: hostCtx.clients,
      createTabRowMenu: hostCtx.createTabRowMenu,
      menu: hostCtx.menu,
      previewOverlay: hostCtx.previewOverlay,
      dragKind: 'opentabs',
      showAddButton: true,
      // 搜索框由列表自己渲染（位置/去抖/上抛），过滤由列表按查询决定推哪一份数据。
      searchable: true,
      emptyText: '没有打开的标签',
      // 本面板宿主在独立视图里：标签数据只能自订阅（见文件头）
      autoSubscribe: true
    })
  }

  /**
   * 分段 → 视图工厂（**唯一**分派表；新增分段只动这里 + SEGMENTS）。
   */
  const VIEW_FACTORIES: Record<SegmentName, () => SegmentView> = {
    open: () => mountOpenView(),
    playing: () => createPlayingView(doc, ctx),
    pinned: () => createPinnedView(doc, ctx)
  }

  /** 按需装配某个分段；已装配过则复用（切回来不重跑 IPC / 不重建 DOM）。 */
  function ensureView(name: SegmentName): SegmentView {
    if (views[name]) return views[name]
    const host = doc.createElement('div')
    host.className = 'opentabs-view'
    host.setAttribute('role', 'tabpanel')
    const view = VIEW_FACTORIES[name]()
    host.appendChild(view.element)
    body.appendChild(host)
    views[name] = view
    hosts[name] = host
    if (name === 'open' && pendingOpenItems) {
      const buffered = pendingOpenItems
      pendingOpenItems = null
      view.setItems?.(buffered)
    }
    return view
  }

  /**
   * 切段。
   *
   * @param {string} name
   * @param {boolean} persist 用户点击 = true（落设置）；启动恢复偏好 = false
   */
  function switchSegment(name: string, persist: boolean) {
    if (disposed) return
    const next = SEGMENT_KEYS.has(name as SegmentName) ? name as SegmentName : SEGMENTS[0].key
    const changed = next !== active
    active = next
    for (const segment of SEGMENTS) {
      segTabs[segment.key].setAttribute('aria-selected', segment.key === next ? 'true' : 'false')
    }
    ensureView(next)
    for (const segment of SEGMENTS) {
      const host = hosts[segment.key]
      if (host) host.hidden = segment.key !== next
    }
    if (changed && persist && settings && typeof settings.set === 'function') {
      settings.set(SEGMENT_KEY, next).catch(() => {})
    }
  }

  // 启动：先装默认段（打开中），再读偏好 —— 偏好是"上次停在哪一段"，
  // 读回来若不同则切过去（多一次极短的视图装配，只在用户确实停在别的段时发生）。
  switchSegment(active, false)
  if (settings && typeof settings.get === 'function') {
    settings.get(SEGMENT_KEY).then((value) => {
      if (disposed || typeof value !== 'string' || !SEGMENT_KEYS.has(value as SegmentName)) return
      switchSegment(value, false)
    }).catch(() => {})
  }

  // 别的窗口 / 设置页改了分段偏好 → 本窗口跟随。
  let unsubscribeSettings: (() => void) | null = null
  if (typeof ctx.on === 'function' && ctx.events && ctx.events.settingsChanged) {
    const unsubscribe = ctx.on(ctx.events.settingsChanged, (payload) => {
      if (!payload || typeof payload !== 'object') return
      const change = payload as { key?: unknown; value?: unknown }
      if (change.key !== SEGMENT_KEY || typeof change.value !== 'string') return
      if (!SEGMENT_KEYS.has(change.value as SegmentName)) return
      switchSegment(change.value, false)
    })
    if (typeof unsubscribe === 'function') unsubscribeSettings = unsubscribe
  }

  return {
    element: root,
    /** 外部推数据：只对「打开中」有语义（已固定视图自己从 tabs 端口取）。 */
    setItems(items: readonly TabRowItem[]) {
      if (views.open) views.open.setItems?.(items)
      else pendingOpenItems = Array.isArray(items) ? items : []
    },
    refresh() {
      const jobs: Promise<void>[] = []
      for (const segment of SEGMENTS) {
        const view = views[segment.key]
        if (view?.refresh) jobs.push(Promise.resolve(view.refresh()))
      }
      return Promise.all(jobs).then(() => undefined)
    },
    focusSearch() {
      const view = views[active]
      return view?.focusSearch?.() === true
    },
    dispose() {
      disposed = true
      if (unsubscribeSettings) unsubscribeSettings()
      unsubscribeSettings = null
      for (const segment of SEGMENTS) {
        const view = views[segment.key]
        view?.dispose?.()
        views[segment.key] = null
        const host = hosts[segment.key]
        if (host) host.remove()
        delete hosts[segment.key]
      }
      root.remove()
    }
  }
}

/** 面板插件定义（宿主按约定发现并挂载；端口由 ctx 注入）。 */
export const panelDefinition: PanelDefinition = {
  id: 'open-tabs-panel',
  injectStyles: injectOpenTabsPanelStyles,
  mount(doc, ctx) {
    return createOpenTabsPanel(doc, ctx) as PanelInstance
  }
}

export { createArchiveView, injectArchiveViewStyles } from './archiveView'
