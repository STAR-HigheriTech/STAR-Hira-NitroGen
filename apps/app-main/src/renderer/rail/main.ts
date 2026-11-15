// Rail 渲染器入口：独立的左侧任务栏图层
// 不包含 navbar，只渲染 TaskOverlay rail
import {
  injectTaskOverlayStyles,
  createTaskOverlay,
  type RailLayout,
  type RailPanelDef,
  type RailPointerModifiers
} from '@hira-ng/ui-taskoverlay'
import { PANEL_ICONS, buildCatalog, resolvePanelOrder, FIRST_RUN_LAYOUT, iconByName, resolveIcon, setChromeDragSuppressed, setOverlayDragSuppressed, createBookmarkContextMenu, createTabListHost, injectTabRowStyles, type IconFactory, type BookmarkMenuNode, type TabMenuTab, type TabRowItem } from '@hira-ng/ui-common'
import { panelsClient, settingsClient } from '../shared/hira-client.js'
// 目录项的**打开语义**（面板 or 子窗口）—— 与 navbar 共用同一条判据，不各写一份
import { openCatalogEntry, findCatalogEntry } from '../shared/entry-action.js'
import type { PanelCatalogEntry } from '../shared/panels-client.js'
// 独立侧栏：rail 贴底那个 `+` 用它（"侧栏浏览"）。
import { webSidebarClient } from '../shared/web-sidebar-client.js'
// 「固定到 rail」的书签（书签编辑器里勾选）—— rail 固定项的数据来源。
import { bookmarksClient } from '../shared/bookmarks-client.js'
import { slotsClient, type SlotRenderItem } from '../shared/slots-client.js'
// 书签项的「在新标签页打开 / 打开」等动作——与标签世界同一条客户端。
import { tabsClient } from '../shared/tabs-client.js'
// 原生右键菜单（与书签栏/标签菜单同一条通道，不手写通道名）。
import { menuClient } from '../shared/menu-client.js'
import { IPC_EVENTS, IPC_ROUTES } from '@hira-ng/shared-types/src/ipc-channels.mjs'
// 工具图标栏位置 / 起始边的设置键真源（与主进程 applier / 设置页同源）。
import {
  LAYOUT_SETTING_KEYS,
  normalizeRailPosition,
  normalizeRailHorizontalAlign,
  normalizeRailVerticalAlign,
  normalizeRailExpandMode,
  normalizeRailWidth,
  RAIL_COLLAPSED_WIDTH,
  RAIL_WIDTH_MIN,
  RAIL_WIDTH_DEFAULT,
  resolveRailPanelSide
} from '@hira-ng/shared-types/src/layout.mjs'
// 外壳按钮列设置键名的真源（与 app-shell / 按钮编辑浮层共用一份）。
import { SHELL_BUTTON_SETTING_KEYS } from '@hira-ng/shared-types/src/shell-buttons.mjs'
import { getHiraBridge } from '../shared/bridge.js'
import { createThemeController } from '../shared/theme-controller.js'
// 下载红点的唯一驱动（与 navbar 共用同一份事件 + 去重逻辑，见该文件头）。
import { createDownloadActivityWatcher } from '../shared/download-activity.js'
import { layoutClient } from '../shared/layout-client.js'
import { createTabRowMenuFactory } from '../shared/tab-row-menu.js'
import { activateRailPreview, loadRailPreviews, type RailPreviewItem } from './panel-previews.js'
import { openRailBookmark } from './bookmark-activation.js'
import '@hira-ng/shared-ui-tokens/tokens-base.css'
import '@hira-ng/shared-ui-tokens/layers.css'
import '@hira-ng/shared-ui-tokens/tokens-light.css'
import '@hira-ng/shared-ui-tokens/tokens-dark.css'

const bridge = getHiraBridge()

// 面板目录（id + 中文名 + 图标）来自**主进程**：面板是插件，manifest 的
// `contributes.panels` 是唯一事实源。这里不再有编译期常量 —— 装一个面板插件，
// 这一列就多一个图标；禁用，就少一个。
// 顺序 / 显隐由 app.rail_buttons 决定；未设置 = 全部可见、目录顺序。
/** rail 侧可编辑目录（外壳按钮 + 面板条目）。插件启停后会重建。 */
let CATALOG = buildCatalog([]).filter((p) => p.rail)

/**
 * 图标表（id → 构造器）。
 *
 * **就地更新**而非重建：createTaskOverlay 构造时拿的是这个对象的引用，
 * 重建对象会让组件永远停在旧图标表上（换了图标也不刷新）。
 */
const RAIL_ICONS: Record<string, IconFactory> = Object.assign({}, PANEL_ICONS)

/** app.rail_buttons 的当前值（undefined = 全部可见）。 */
let railButtonsSetting: unknown

/**
 * 插件贡献的 rail 图标（官方插槽 `side-panel.rail-icon-slot`，MODE=MULTI）。
 *
 * 与面板图标的**区别（重要）**：面板是"有开关状态的面板"，参与 `app.rail_buttons`
 * 的排序 / 显隐；而插件图标是"一个动作"（点了执行 onSelect），没有开关状态可言。
 * 因此它们：
 *   · 不进入 CATALOG，不参与用户排序（用户排序设置里没有它们，硬塞进去会让
 *     `app.rail_buttons` 的推断逻辑把老设置当成"隐藏了这些新项"）；
 *   · 永远排在面板图标之后 —— 顺序稳定，不会因图标数量变化而插到面板中间。
 */
let slotRailItems: RailPanelDef[] = []

/** 插件图标的 id 前缀：与真实面板 id 彻底隔开，避免误判（面板 id 都以 `-panel` 结尾）。 */
const SLOT_ID_PREFIX = 'slot:'

/** rail **固定项**（书签固定到 rail）的 id 前缀 —— 与面板 id、插件图标三重隔开。 */
const RAIL_PIN_PREFIX = 'pin:'

interface RailPinnedBookmark extends BookmarkMenuNode {
  id: string
  url: string
  title?: string
  nickname?: string | null
  favicon?: string | null
}

interface RailPinnedItem extends RailPanelDef {
  url: string
  bookmark: RailPinnedBookmark
}

interface SlotDescriptor {
  label?: unknown
  icon?: unknown
}

/**
 * 用户「固定到 rail」的书签（书签编辑器里勾选 → 图标栏多一个图标 → 点击在独立侧栏打开）。
 *
 * 与 `slotRailItems` 同一条设计：**不进入 CATALOG、不参与 `app.rail_buttons` 排序** ——
 * 它们是用户直接指定的快捷入口，不是"可开关的面板"。硬塞进排序设置，会让按钮编辑浮层
 * 把老设置误读成"这些新项被隐藏了"。恒定排在最后（面板项 → 插件图标 → 固定项），顺序稳定。
 */
let railPinnedItems: RailPinnedItem[] = []

/** 「书签固定区」分区头的 id（`kind: 'section'` 的项，不是面板 —— 不参与排序/活动态）。 */
const RAIL_PIN_SECTION_ID = 'section:rail-pins'

const RAIL_PINS_COLLAPSED_KEY = 'hira-rail-pins-collapsed'
let railPinsCollapsed = false
try { railPinsCollapsed = localStorage.getItem(RAIL_PINS_COLLAPSED_KEY) === '1' } catch (_) {}
let railPinsCollapsedBeforeEditing = false

/**
 * 抽屉是否展开（**默认收起**）。
 *
 * 与「书签固定区」折叠态同一口径：这是这一列的**视图态**，不是业务偏好，
 * 因此存 localStorage；归属（哪些按钮在抽屉里）才是设置项 `app.rail_buttons.drawer`。
 */
const RAIL_DRAWER_OPEN_KEY = 'hira-rail-drawer-open'
let railDrawerOpen = false
try { railDrawerOpen = localStorage.getItem(RAIL_DRAWER_OPEN_KEY) === '1' } catch (_) {}

/** rail 图标插槽的官方 id。 */
const RAIL_ICON_SLOT = 'side-panel.rail-icon-slot'

/**
 * 面板 id → 当前真实摘要（最多两项）。数据由 `panel-previews.ts` 的 provider 表提供：
 * 标签取真实标签、历史取最近访问、书签取实际书签、下载与集锦同理。
 */
let railPreviews = new Map<string, RailPreviewItem[]>()
/** profile 数据代际：切 profile 后，旧请求不得把上一身份的书签 / 插槽写回 rail。 */
let railIdentityRevision = 0
let railCatalogRevision = 0
let tabPreviewHost: ReturnType<typeof createTabListHost> | null = null
let tabPreviewFlat: TabRowItem[] = []
let tabPreviewSignature = ''
let tabPreviewRequest = 0
let tabPreviewActiveId = ''
let tabPreviewPreviousActiveId = ''
let tabPreviewDisplayedIds: string[] = []
let railPreviewSignature = ''
let railPreviewTimer: ReturnType<typeof setTimeout> | null = null
let railPreviewRequest = 0
let railPreviewRefreshAll = false
let lastRailExpandedForPreview = false
const pendingRailPreviewIds = new Set<string>()

/** 按当前设置算出 rail 该显示哪些图标项（面板项受设置约束；插件项/固定项恒显示且在最后）。 */
function visiblePanels() {
  const byId = new Map(CATALOG.map((p) => [p.id, p]))
  // 出厂布局：目录全常驻，主题 / 会话收在抽屉（见 ui-common#FIRST_RUN_LAYOUT）；
  // 设置一旦写入就以设置为准，默认值不再介入。
  const { visible, drawer } = resolvePanelOrder(railButtonsSetting, CATALOG, FIRST_RUN_LAYOUT.rail)
  const toItem = (id: string, inDrawer: boolean) => {
    const p = byId.get(id)
    return p
      ? {
          id: p.id,
          title: p.label,
          details: p.id === 'open-tabs-panel'
            ? []
            : (railPreviews.get(p.id) || []).map((item) => ({
                id: item.id,
                label: item.label,
                meta: item.meta,
                status: item.status,
                favicon: item.favicon,
                iconUrl: item.iconUrl,
                iconSrc: item.iconSrc,
                filename: item.filename,
                onActivate: (modifiers: RailPointerModifiers) => activateRailPreview(item, modifiers)
              })),
          detailsView: p.id === 'open-tabs-panel' ? tabPreviewHost?.element : undefined,
          detailPresentation: p.id === 'favorites-panel' ? 'icons' as const : 'list' as const,
          drawer: inDrawer
        }
      : null
  }
  const panels = visible.map((id) => toItem(id, false)).filter((item): item is NonNullable<typeof item> => item !== null)
  // 抽屉项：归属由设置里的 `drawer` 决定，组件按 `drawer: true` 把它们收进抽屉
  //（编辑界面里就是「抽屉区」那个投放框）。
  const drawerPanels = drawer.map((id) => toItem(id, true)).filter((item): item is NonNullable<typeof item> => item !== null)
  const out: RailPanelDef[] = [...panels, ...slotRailItems, ...drawerPanels]
  /** 「固定书签」：可跳转书签面板，并保留自己独立的展开 / 收起状态。 */
  if (railPinnedItems.length > 0) {
    out.push({
      id: RAIL_PIN_SECTION_ID,
      kind: 'section',
      title: '固定书签',
      icon: 'Star',
      actionPanelId: 'favorites-panel',
      collapsed: railPinsCollapsed
    })
    if (!railPinsCollapsed) out.push(...railPinnedItems)
  }
  return out
}

/**
 * 用主进程下发的面板目录重建 rail 那一列。
 * @param {Array<object>} entries PanelEntry[]
 */
function applyCatalog(entries: PanelCatalogEntry[]) {
  const next = buildCatalog(entries).filter((p) => p.rail)
  // 只清**上一轮的面板图标**，不清空整表：RAIL_ICONS 里还住着插件图标（`slot:`）与
  // 用户固定项（`pin:`）—— 清空会把它们一起抹掉，表现为"插件启停一次，
  // rail 上固定的书签就没了图标"（它们各自的刷新不一定紧跟在本函数之后）。
  for (const p of CATALOG) delete RAIL_ICONS[p.id]
  CATALOG = next
  for (const p of CATALOG) {
    if (typeof p.icon === 'function') RAIL_ICONS[p.id] = p.icon
  }
  taskOverlay.setPanels(visiblePanels())
  schedulePreviewRefresh(0)
}

/**
 * 拉取并重建「插件贡献的 rail 图标」。
 *
 * 图标名（字符串）在渲染侧经 iconByName 还原成构造器 —— 与面板图标同一套机制
 * （函数过不了 IPC，只能传名字）。descriptor 里没有可用 label 的项跳过。
 */
async function refreshSlotIcons(
  revision = railIdentityRevision,
  catalogRevision = railCatalogRevision
) {
  let items: SlotRenderItem[] = []
  try {
    items = await slotsClient.render(RAIL_ICON_SLOT, {})
  } catch (_) {
    return
  }
  if (revision !== railIdentityRevision || catalogRevision !== railCatalogRevision) return
  const next: RailPanelDef[] = []
  for (const item of items) {
    const d = (item.descriptor || {}) as SlotDescriptor
    const label = typeof d.label === 'string' ? d.label.trim() : ''
    if (!label) continue
    const id = `${SLOT_ID_PREFIX}${item.key}`
    // 存**名字**不存元素：每次渲染都造一个新元素。若把同一个 Element 实例反复交出去，
    // 它在重建列表时会被搬来搬去（甚至从别处摘走），是典型的"图标偶尔消失"来源。
    if (typeof d.icon === 'string' && d.icon) {
      RAIL_ICONS[id] = (doc, opts) =>
        resolveIcon(d.icon as string, doc, opts || { size: 16 }) || doc.createElement('span')
    }
    next.push({
      id,
      title: label
    })
  }
  // 只清旧 `slot:` 图标（面板图标 / `pin:` 固定项各有其主，不该被这里误删）
  for (const key of Object.keys(RAIL_ICONS)) {
    if (key.startsWith(SLOT_ID_PREFIX) && !next.some((it) => it.id === key)) delete RAIL_ICONS[key]
  }
  slotRailItems = next
  taskOverlay.setPanels(visiblePanels())
}

/** 首字母降级（favicon 缺失或加载失败时用）—— 与书签栏的降级同一形态。 */
function letterIcon(doc: Document, title: unknown, size: number): HTMLSpanElement {
  const span = doc.createElement('span')
  span.className = 'hira-rail-item__letter'
  span.textContent = (String(title || '?').trim()[0] || '?').toUpperCase()
  span.style.fontSize = `${Math.round(size * 0.66)}px`
  return span
}

/**
 * rail 固定项的图标 = **网站 favicon**（与书签栏同款），加载失败降级为**首字母**。
 *
 * 为什么不用统一图标（星号之类）：rail 上会同时挂着好几个固定书签，清一色的同一个符号
 * 谁也认不出哪个是哪个 —— 而书签栏早就用 favicon 解决了这件事。沿用同一套视觉语言，
 * 用户不必为"侧栏上那一列"再学第二套。
 */
function createFaviconIcon(favicon: unknown, title: unknown): IconFactory {
  return (doc: Document, opts) => {
    const size = (opts && opts.size) || 18
    if (favicon) {
      const img = doc.createElement('img')
      img.className = 'hira-rail-item__favicon'
      img.src = String(favicon)
      img.alt = ''
      img.loading = 'lazy'
      // 破图不能占着位置：降级为首字母，与书签栏 makeFallback 同款
      img.addEventListener('error', () => { img.replaceWith(letterIcon(doc, title, size)) })
      return img
    }
    return letterIcon(doc, title, size)
  }
}

/**
 * 拉取并重建「固定到 rail 的书签」图标列。
 *
 * 数据来自 `bookmark:rail-pinned-list`（主进程查库）；本函数只管**呈现** ——
 * 不认识书签存储、也不改动任何书签数据（固定与否由书签编辑器里的复选框决定）。
 */
async function refreshRailPinned(revision = railIdentityRevision) {
  let list: unknown = []
  try {
    list = await bookmarksClient.railPinnedList()
  } catch (_) {
    return
  }
  if (revision !== railIdentityRevision) return
  const next: RailPinnedItem[] = []
  for (const rawBookmark of Array.isArray(list) ? list : []) {
    const b = rawBookmark as RailPinnedBookmark
    if (!b || !b.url) continue
    const id = `${RAIL_PIN_PREFIX}${b.id}`
    // 每次都重建图标构造器（favicon 可能随页面更新）—— 与书签栏显示网站图标同款。
    RAIL_ICONS[id] = createFaviconIcon(b.favicon, b.nickname || b.title || b.url)
    /**
     * `url` 供点击时打开独立侧栏；`bookmark` 是**整条记录**，供右键菜单
     *（它要 id / parentId / title —— 只带 url 不够，缺了就得在这里再造一份残缺模型）；
     * `draggable` 让它参与这一列的**拖拽重排**（见 createTaskOverlay 的 onReorder）。
     */
    next.push({
      id,
      title: b.nickname || b.title || b.url,
      url: b.url,
      bookmark: b,
      draggable: true,
      pinned: true
    })
  }
  // 清掉已取消固定的条目：RAIL_ICONS 是长生命周期对象，只增不减会随会话无限膨胀。
  for (const key of Object.keys(RAIL_ICONS)) {
    if (key.startsWith(RAIL_PIN_PREFIX) && !next.some((it) => it.id === key)) delete RAIL_ICONS[key]
  }
  railPinnedItems = next
  taskOverlay.setPanels(visiblePanels())
}

/**
 * profile 身份变化后的 rail 数据重置。
 *
 * 面板目录是应用级插件数据，不必重建；固定书签、插件 rail 图标和所有摘要
 * 都是按 profile 读取的。先同步摘掉旧项，避免新数据回来前继续显示上一身份；
 * 代际校验再挡掉在途旧请求。
 */
function refreshRailProfileData() {
  const revision = ++railIdentityRevision
  railPreviews = new Map()
  railPreviewSignature = ''
  railPinnedItems = []
  slotRailItems = []
  for (const key of Object.keys(RAIL_ICONS)) {
    if (key.startsWith(RAIL_PIN_PREFIX) || key.startsWith(SLOT_ID_PREFIX)) delete RAIL_ICONS[key]
  }
  taskOverlay.setPanels(visiblePanels())
  void refreshSlotIcons(revision)
  void refreshRailPinned(revision)
  schedulePreviewRefresh(0)
}

/**
 * 「固定到 rail 的书签」的右键菜单 —— 与**书签栏**共用同一份定义
 *（`ui-common#createBookmarkContextMenu`）：菜单结构、可见性判据、插件插槽快照只有一处，
 * 两个宿主只有"从哪取消固定"这条文案与它自己的业务落点不同。
 *
 * 业务落点刻意与"这条书签住在 rail 上"这件事对齐：
 *   · 「取消固定」摘的是 **rail 固定**（`railPinnedSet`），不是书签栏那份 ——
 *     否则用户从 rail 上点"取消固定"，图标纹丝不动（那是"点了没反应"）；
 *   · 「编辑…」开的是**同一个**书签编辑器窗口（与书签栏/星标同一条 `window:open`）。
 */
const showRailPinMenu = createBookmarkContextMenu({
  popMenu: menuClient.popupMenu,
  labels: { unpin: '从 rail 取消固定' },
  source: 'rail',
  handlers: {
    onOpen: (b) => { if (b.url) tabsClient.navigate({ url: b.url }) },
    onOpenNewTab: (b) => { if (b.url) tabsClient.newTab({ url: b.url }) },
    onOpenSidebar: (b) => {
      if (b.url) webSidebarClient.open(b.url, { title: b.title || '' }).catch(() => {})
    },
    onEdit: (b) => {
      bridge.provider.invoke(IPC_ROUTES.windowOpen, {
        type: 'edit-bookmark',
        payload: { url: b.url, title: b.title }
      }).catch((e) => console.error('[rail] open bookmark editor failed:', e))
    },
    onUnpin: (b) => { if (b.id) bookmarksClient.railPinnedSet(b.id, false).catch(() => {}) },
    onDelete: (b) => { if (b.url) bookmarksClient.removeByUrl(b.url).catch(() => {}) }
  }
})

// 注入样式
injectTaskOverlayStyles(document)
injectTabRowStyles(document)

/**
 * “标签”预览与总览 / 标签面板共用同一个 `createTabListHost`：
 * 行结构、favicon、组状态、右键菜单、静音、hover 预览、拖拽全部不再由 rail 自绘。
 */
const tabPreviewOverlay = {
  showTabPreview(payload: unknown) {
    try { bridge.provider.send(IPC_EVENTS.tabpreviewOverlayShow, payload) } catch (_) {}
  },
  hideTabPreview() {
    try { bridge.provider.send(IPC_EVENTS.tabpreviewOverlayHide, {}) } catch (_) {}
  },
  warmTabPreview() {
    try { bridge.provider.send(IPC_ROUTES.floatWarm, { name: 'tabpreview-overlay' }) } catch (_) {}
  }
}

const createRailTabMenu = createTabRowMenuFactory({
  refresh: () => schedulePreviewRefresh(0, ['open-tabs-panel'])
})

tabPreviewHost = createTabListHost(document, {
  clients: { tabs: tabsClient },
  createTabRowMenu: (options) => createRailTabMenu({
    labels: options.labels,
    getItems: () => [...options.getItems()] as unknown as TabMenuTab[]
  }),
  menu: menuClient,
  previewOverlay: tabPreviewOverlay,
  dragKind: 'rail-tab-preview',
  getMenuItems: () => tabPreviewFlat,
  showAddButton: false,
  searchable: false,
  motion: false,
  emptyText: '没有打开的标签',
  source: 'list',
  isActive: () => railPresentationExpanded()
})
tabPreviewHost.element.classList.add('hira-rail-tab-preview')

// CSS reset — 消除 body 默认外边距，确保 rail 铺满 view
const railReset = document.createElement('style')
railReset.textContent = `
  html, body, #root {
    margin: 0;
    padding: 0;
    height: 100%;
    width: 100%;
    overflow: hidden;
    background: var(--main-bg-color, #f9fafb);
    /* ⚠ 必须显式给 color：rail 里的图标是 SVG，且用的是 stroke="currentColor"
       （见 ui-common#icons.js）—— 本页此前一个字都没设 color，于是 currentColor
       一直回落到初始值（黑）：深色主题下就是"黑图标压在深色 rail 上"。
       这里跟随主题前景色（--text-color = 主题的 fg），图标/文字一并跟上。 */
    color: var(--text-color, #1a1a1a);
    font-family: var(--hira-font-ui, "Segoe UI Variable Text", "Segoe UI Variable", "Segoe UI", "Microsoft YaHei UI", "Microsoft YaHei", "PingFang SC", "Noto Sans SC", system-ui, -apple-system, sans-serif);
    font-size: 12px;
    font-weight: 400;
    -webkit-font-smoothing: antialiased;
  }
  * { box-sizing: border-box; }
  /* 「固定到 rail」的书签：图标 = 网站 favicon（与书签栏同款），破图降级为首字母。
     尺寸写死 16px 而不是跟着图标表走 —— rail 槽只有那么大，favicon 撑满会顶掉内边距。 */
  .hira-rail-item__favicon {
    width: 16px; height: 16px; border-radius: 3px; object-fit: contain; display: block;
  }
  .hira-rail-item__letter {
    width: 16px; height: 16px; border-radius: 3px;
    display: flex; align-items: center; justify-content: center;
    /* 首字徽标必须显式落字体令牌（否则继承链会落到系统默认宋体点阵）。 */
    font-family: var(--hira-font-ui, "Segoe UI Variable Text", "Segoe UI Variable", "Segoe UI", "Microsoft YaHei UI", "Microsoft YaHei", "PingFang SC", "Noto Sans SC", system-ui, -apple-system, sans-serif);
    font-weight: 400; line-height: 1; text-transform: uppercase;
    background: rgba(128, 128, 128, 0.22);
  }
`
document.head.appendChild(railReset)

const rootElement = document.getElementById('root')
if (!rootElement) throw new Error('Missing rail root')
const root = rootElement

let activePanelId: string | null = null
/**
 * rail 自己所在的一侧（= app.sidebar_position）。
 *
 * 它同时是「点 rail 图标时希望面板开在哪一侧」—— 见下面 onTogglePanel 传给
 * panelsClient.toggle 的 side。navbar 的按钮写死 'right'（按钮在右侧），rail 跟随
 * 设置，于是两侧可以各挂一个面板，互不打扰。
 */
let sidebarSide = 'left'

/**
 * 组件需要的 rail 轴向事实：位置（决定横 / 纵）+ 起始边（决定贴哪端）。
 * UI 组件不读设置、不自己判断方向 —— 只按这一个对象切类。
 */
let railLayout: RailLayout = { position: 'left', horizontalAlign: 'left', verticalAlign: 'top' }

/** 按钮编辑模式是否进行中（本视图）：决定「请重新量一次几何」要不要响应。 */
let railEditing = false

/**
 * 可展开 rail 的三个独立事实：
 *   · preference —— 当前会话里的展开状态（新会话由三态模式决定起始值）；
 *   · width      —— 展开态宽度（持久化到 app.rail_width）；
 *   · expandedBeforePanel —— 面板首次打开前的 rail 状态快照，不写回 preference。
 *
 * `openPanelIds` 来自主进程的面板侧别广播。用集合而不是单个 id，切换 / 替换面板时
 * 只有“这一侧真的没有任何面板了”才恢复展开，避免面板间切换让 rail 闪一下。
 */
let railExpandedPreference = false
let railExpandMode: 'auto' | 'rail' | 'expanded' = 'auto'
let railExpandedWidth = RAIL_WIDTH_DEFAULT
const RAIL_WIDTH_MIGRATION_KEY = 'app.rail_width_default_migration'
const RAIL_WIDTH_MIGRATION_VERSION = 1
const LEGACY_RAIL_WIDTH_DEFAULTS = new Set([150, 180, 220, 232, 280])
const PANEL_ACTION_TIMEOUT_MS = 8_000
let railExpandedBeforePanel: boolean | null = null
let pendingPanelSwitchCount = 0
const panelActionRevisions = new Map<string, number>()
const openPanelIds = new Set<string>()
let railWidthFrame = 0
let pendingRailWidth = 0
let appliedHostRailWidth = RAIL_COLLAPSED_WIDTH
let hostRailWidthSynced = false

function migrateStoredRailWidth(value: unknown, migrationVersion: unknown) {
  const width = Math.max(RAIL_WIDTH_MIN, normalizeRailWidth(value))
  if (Number(migrationVersion) >= RAIL_WIDTH_MIGRATION_VERSION) {
    return { width, migrationComplete: true }
  }
  const persistedWidth = Math.round(Number(value))
  return {
    width: LEGACY_RAIL_WIDTH_DEFAULTS.has(persistedWidth) ? RAIL_WIDTH_DEFAULT : width,
    migrationComplete: false
  }
}

function beginPanelAction(panelId: string): number {
  const revision = (panelActionRevisions.get(panelId) || 0) + 1
  panelActionRevisions.set(panelId, revision)
  pendingPanelSwitchCount += 1
  return revision
}

function finishPanelAction(panelId: string, revision: number): boolean {
  pendingPanelSwitchCount = Math.max(0, pendingPanelSwitchCount - 1)
  if (panelActionRevisions.get(panelId) !== revision) return false
  panelActionRevisions.delete(panelId)
  return true
}

function awaitPanelAction<T>(task: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | null = null
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error('panel action timed out')), PANEL_ACTION_TIMEOUT_MS)
  })
  return Promise.race([task, timeout]).finally(() => {
    if (timer) clearTimeout(timer)
  })
}

function effectiveRailExpanded(): boolean {
  // 编辑模式临时强制纵向 rail 展开：展开态才有完整名称行、抽屉和固定区，
  // 编辑浮层也才能拿到与真实展开界面一致的几何。退出后按原偏好恢复。
  if (railEditing && railLayout.position !== 'top' && railLayout.position !== 'bottom') return true
  return railExpandedPreference && railExpandedBeforePanel === null
}

function railPresentationExpanded(): boolean {
  if (railLayout.position === 'top' || railLayout.position === 'bottom') return false
  return effectiveRailExpanded()
}

function flushHostRailWidth(width: number, live = false) {
  if (!Number.isFinite(width) || width <= 0) return
  const next = Math.round(width)
  appliedHostRailWidth = next
  hostRailWidthSynced = true
  if (live) layoutClient.setRailWidthLive(next)
  else {
    layoutClient.setRailWidth(next)
      .then(() => {
        if (railEditing) scheduleReportItemsZones()
      })
      .catch(() => {
        if (appliedHostRailWidth === next) hostRailWidthSynced = false
      })
  }
}

/** 拖拽宽度按帧合流：组件仍逐帧跟手，跨进程只发最后一次。 */
function scheduleHostRailWidth(width: number, immediate = false) {
  pendingRailWidth = width
  if (immediate) {
    if (railWidthFrame) cancelAnimationFrame(railWidthFrame)
    railWidthFrame = 0
    flushHostRailWidth(width, false)
    return
  }
  if (railWidthFrame) return
  railWidthFrame = requestAnimationFrame(() => {
    railWidthFrame = 0
    flushHostRailWidth(pendingRailWidth, true)
  })
}

function applyRailPresentation() {
  const expanded = railPresentationExpanded()
  const targetWidth = expanded ? railExpandedWidth : RAIL_COLLAPSED_WIDTH
  taskOverlay.setRailExpanded(expanded)
  taskOverlay.setRailWidth(railExpandedWidth)
  // 面板打开流程会连续确认两次；相同目标不重复提交。
  if (!hostRailWidthSynced || targetWidth !== appliedHostRailWidth) {
    scheduleHostRailWidth(targetWidth, true)
  }
  if (expanded && !lastRailExpandedForPreview) schedulePreviewRefresh()
  lastRailExpandedForPreview = expanded
}

function syncRailCloseRestore() {
  layoutClient.setRailCloseRestore(railExpandedBeforePanel, railExpandedWidth).catch(() => {})
}

/** 打开真实面板前立即回到 rail，并保留此刻状态供关闭时恢复。 */
function collapseRailForPanel() {
  if (railExpandedBeforePanel === null) {
    railExpandedBeforePanel = railExpandedPreference
  }
  syncRailCloseRestore()
  applyRailPresentation()
}

/** 所有面板都关闭后，恢复首次打开面板前的展开 / 收起状态。 */
function restoreRailAfterPanelsClosed() {
  if (openPanelIds.size > 0 || pendingPanelSwitchCount > 0) return
  if (railExpandedBeforePanel !== null) {
    railExpandedPreference = railExpandedBeforePanel
  }
  railExpandedBeforePanel = null
  syncRailCloseRestore()
  applyRailPresentation()
}

/**
 * 展开态的真实摘要刷新。
 *
 * 只在名称态取数，收起时零 IPC；同一拍内多个数据事件合并成一次，返回后用序号丢弃
 * 过期结果。签名不变时不重建 DOM，避免标签切换 / 下载进度把整列 rail 重画一遍。
 */
function schedulePreviewRefresh(delay = 80, onlyPanelIds?: readonly string[]) {
  if (!railPresentationExpanded()) return
  if (Array.isArray(onlyPanelIds)) {
    for (const id of onlyPanelIds) pendingRailPreviewIds.add(id)
  } else {
    railPreviewRefreshAll = true
  }
  if (railPreviewTimer) return
  railPreviewTimer = setTimeout(() => {
    railPreviewTimer = null
    if (!railPresentationExpanded()) return
    const allPanelIds = CATALOG.map((entry) => entry.id)
    const requestPanelIds = railPreviewRefreshAll ? allPanelIds : [...pendingRailPreviewIds]
    railPreviewRefreshAll = false
    pendingRailPreviewIds.clear()
    if (requestPanelIds.length === 0) return
    const request = ++railPreviewRequest
    if (requestPanelIds.includes('open-tabs-panel')) refreshTabPreviewHost()
    loadRailPreviews(requestPanelIds).then((next) => {
      if (request !== railPreviewRequest || !railPresentationExpanded()) return
      const merged = new Map(railPreviews)
      for (const [id, items] of next) merged.set(id, items)
      const ordered: Record<string, RailPreviewItem[]> = {}
      for (const id of allPanelIds) ordered[id] = merged.get(id) || []
      const signature = JSON.stringify(ordered)
      if (signature === railPreviewSignature) return
      railPreviewSignature = signature
      railPreviews = merged
      taskOverlay.setPanels(visiblePanels())
    }).catch(() => {})
  }, delay)
}

/**
 * 标签预览的数据入口：投影给统一标签行组件，扁平列表给右键菜单的相邻项判断。
 * 上限只有两项，但行本身、状态、菜单、拖拽全部由 `createTabListHost` 提供。
 */
function refreshTabPreviewHost() {
  const request = ++tabPreviewRequest
  Promise.all([
    tabsClient.projection(),
    tabsClient.list()
  ]).then(([projection, flat]) => {
    if (request !== tabPreviewRequest || !railPresentationExpanded()) return
    applyTabPreviewRows(projection, flat)
  }).catch(() => {
    if (request !== tabPreviewRequest || !tabPreviewHost) return
    tabPreviewFlat = []
    tabPreviewSignature = ''
    tabPreviewHost.setItems([])
  })
}

function applyTabPreviewRows(projection: unknown, flat?: unknown) {
  if (!tabPreviewHost) return
  const source = Array.isArray(flat) ? flat : (Array.isArray(projection) ? projection : [])
  tabPreviewFlat = source.filter(isTabPreviewRow)
  const tabRows = tabPreviewFlat.filter((row) => row.type !== 'stack' && row.tabId != null)
  const active = tabRows.find((row) => row.active === true) || null
  const nextActiveId = active && active.tabId != null ? String(active.tabId) : ''
  if (nextActiveId && nextActiveId !== tabPreviewActiveId) {
    if (tabPreviewActiveId) tabPreviewPreviousActiveId = tabPreviewActiveId
    tabPreviewActiveId = nextActiveId
  }

  const previous = tabRows.find((row) => {
    if (row.tabId == null || String(row.tabId) === nextActiveId) return false
    if (tabPreviewPreviousActiveId) return String(row.tabId) === tabPreviewPreviousActiveId
    return false
  }) || tabRows
    .filter((row) => row.tabId != null && String(row.tabId) !== nextActiveId)
    .sort((a, b) => {
      const aAt = Number((a as Record<string, unknown>).lastActivated) || 0
      const bAt = Number((b as Record<string, unknown>).lastActivated) || 0
      return bAt - aAt
    })[0] || null
  if (previous && previous.tabId != null) tabPreviewPreviousActiveId = String(previous.tabId)

  /**
   * 已显示两条之间的切换只换 active 状态，不改变行顺序；
   * 切到第三个标签（或当前项被关掉）时才重新组成“当前 + 上次”。
   */
  const displayed = tabPreviewDisplayedIds
    .map((id) => tabRows.find((row) => row.tabId != null && String(row.tabId) === id) || null)
    .filter((row): row is TabRowItem => !!row)
  const switchingWithinPreview = !!nextActiveId &&
    displayed.length === tabPreviewDisplayedIds.length &&
    displayed.some((row) => row.tabId != null && String(row.tabId) === nextActiveId)
  const rows = (switchingWithinPreview
    ? displayed
    : [active, previous]).filter((row): row is TabRowItem => !!row)
  tabPreviewDisplayedIds = rows
    .map((row) => row.tabId == null ? '' : String(row.tabId))
    .filter(Boolean)
  // 标签 id 没变不代表状态没变：当前标签、标题、加载态、静音等都在同一行对象里。
  const signature = JSON.stringify(rows)
  if (signature === tabPreviewSignature) return
  tabPreviewSignature = signature
  tabPreviewHost.setItems(rows)
}

function isTabPreviewRow(value: unknown): value is TabRowItem {
  if (!value || typeof value !== 'object') return false
  const row = value as TabRowItem
  return row.type === 'stack' ? row.stackId != null : row.tabId != null
}

const taskOverlay = createTaskOverlay(document, {
  panels: visiblePanels(),
  // 图标与 navbar 同源：ui-common#PANEL_ICONS（外壳按钮）+ 面板目录自带（面板）。
  // 传的是**稳定引用** RAIL_ICONS —— 目录刷新时就地改它，组件无需重挂。
  icons: RAIL_ICONS,
  railExpanded: false,
  railWidth: railExpandedWidth,
  onToggleRailExpanded: (expanded) => {
    railExpandedPreference = !!expanded
    // 用户手动操作后接管自动呈现；即使面板还开着也尊重这次选择。
    railExpandedBeforePanel = null
    syncRailCloseRestore()
    applyRailPresentation()
  },
  onRailWidthChange: (width, committed) => {
    railExpandedWidth = Math.max(RAIL_WIDTH_MIN, normalizeRailWidth(width))
    taskOverlay.setRailWidth(railExpandedWidth)
    scheduleHostRailWidth(railPresentationExpanded() ? railExpandedWidth : RAIL_COLLAPSED_WIDTH, committed)
    if (committed) {
      settingsClient.set(LAYOUT_SETTING_KEYS.toolRailWidth, railExpandedWidth).catch(() => {})
    }
  },
  /**
   * 入口**意图**（悬停 / 按下）：把这块面板的视图提前造好（"关闭即销毁"的冷启动
   * 不该全压在点击那一拍）。只有**真实面板项**才预热 —— 插件图标（`slot:`）、
   * 固定书签（`pin:`）、分区头都不是面板，主进程没有它们的视图可造。
   */
  onHoverPanel: (panelId) => {
    if (typeof panelId !== 'string') return
    if (panelId.startsWith(SLOT_ID_PREFIX) || panelId.startsWith(RAIL_PIN_PREFIX)) return
    if (panelId.startsWith('section:')) return
    panelsClient.prepare(panelId)
  },
  getActivePanelId: () => activePanelId,
  onTogglePanel: async (panelId, modifiers) => {
    /**
     * 「固定到 rail」的书签：**基础去向仍是独立侧栏**（与下面的插件图标同属"一个动作"），
     * 但修饰键语义与**书签栏逐字一致**（用户口径："rail 中固定的书签 ctrl 和 alt 也和
     * 书签栏一样"）：Ctrl → 新标签；Alt → 有就转过去、没有才新开。
     * 表达方式就是把"默认在侧栏打开"当作那句话里的**偏好**传进去 —— 于是
     * 无修饰键/Shift → 侧栏、Ctrl → 新标签、Alt → 转到已有或新开，一份规则全覆盖
     *（见 ui-common#resolveBookmarkOpenTarget / #openBookmarkTarget）。
     */
    if (typeof panelId === 'string' && panelId.startsWith(RAIL_PIN_PREFIX)) {
      const hit = railPinnedItems.find((it) => it.id === panelId)
      if (!hit || !hit.url) return
      openRailBookmark({ url: hit.url, title: hit.title }, modifiers)
      return
    }
    // 插件贡献的图标是**一个动作**（不是可开关的面板）：派发后不做活动态切换 ——
    // 它没有"打开/关闭"两种状态，点亮它只会让用户以为点出了一个面板。
    if (typeof panelId === 'string' && panelId.startsWith(SLOT_ID_PREFIX)) {
      const key = panelId.slice(SLOT_ID_PREFIX.length)
      slotsClient.dispatch(RAIL_ICON_SLOT, key, {})
        .then((res) => { if (res && res.ok === false) console.warn('[rail] slot icon action failed:', res.reason) })
        .catch(() => {})
      return
    }
    try {
      /**
       * 去向由**条目自己**决定（见 renderer/shared/entry-action.js）：
       *   · 普通项 → 开侧栏面板；
       *   · 声明了 `opensWindow` 的项 → 开一个独立子窗口；
       *   · 声明了 `opensPage` 的项 → 在标签页里开内部页（插件中心就是这一类）。
       * 判据只有一份，rail 与 navbar 不可能对同一个图标给出两个行为。
       *
       * side：rail 希望面板开在**它自己所在的那一侧**（= app.sidebar_position）。
       * 与 navbar 的 'right' 对称 —— 两侧各有一个面板位，各管各的，互不打扰。
       */
      const side = sidebarSide === 'left' || sidebarSide === 'right' ? sidebarSide : 'right'
      const entry = findCatalogEntry(CATALOG, panelId)
      if (!entry) return
      const panelEntry = !entry.opensWindow && !entry.opensPage
      if (panelActionRevisions.has(panelId)) return
      // 真实面板在点击当下就让 rail 回到普通态；动作项（开窗口 / 内部页）保持当前呈现。
      if (panelEntry && !openPanelIds.has(panelId)) {
        collapseRailForPanel()
      }
      const revision = panelEntry ? beginPanelAction(panelId) : 0
      let result: { open: boolean; panelId: string } | null = null
      try {
        result = await awaitPanelAction(openCatalogEntry(entry, { side }))
      } catch (e) {
        if (panelEntry && finishPanelAction(panelId, revision)) {
          restoreRailAfterPanelsClosed()
          console.error('[rail] open panel entry failed:', e)
        } else if (!panelEntry) {
          console.error('[rail] open action failed:', e)
        }
        return
      }
      if (panelEntry && !finishPanelAction(panelId, revision)) return
      if (!panelEntry) {
        activePanelId = null
        taskOverlay.setActive(null)
        return
      }
      // 动作型返回 null（开了窗口，没有"打开/关闭"两态）→ 不点亮图标 ——
      // 与上面插件槽图标是同一条判据：点亮的图标会被读成"这个面板开着"。
      activePanelId = result && result.open ? panelId : null
      taskOverlay.setActive(activePanelId)
      if (result) {
        if (result.open) {
          openPanelIds.add(panelId)
          collapseRailForPanel()
        } else {
          openPanelIds.delete(panelId)
          restoreRailAfterPanelsClosed()
        }
        // 面板真正打开后自动回到普通 rail；关闭后由同一状态机恢复用户上次选择。
        applyRailPresentation()
      }
    } catch (e) {
      console.error('[rail] open panel entry failed:', e)
    }
  },
  /**
   * “转到 ×× 面板”是**打开**，不是开关。已打开时保持打开，并同样立即收回 rail。
   */
  onOpenPanel: async (panelId) => {
    const side = sidebarSide === 'left' || sidebarSide === 'right' ? sidebarSide : 'right'
    const entry = findCatalogEntry(CATALOG, panelId)
    if (!entry || entry.opensWindow || entry.opensPage) return
    if (panelActionRevisions.has(panelId)) return
    const revision = beginPanelAction(panelId)
    collapseRailForPanel()
    let result: { open: boolean; panelId: string } | null = null
    try {
      result = await awaitPanelAction(panelsClient.show(entry.id, { side }))
    } catch (error) {
      if (finishPanelAction(panelId, revision)) {
        restoreRailAfterPanelsClosed()
        console.error('[rail] show panel entry failed:', error)
      }
      return
    }
    if (!finishPanelAction(panelId, revision)) return
    if (!result.open) return restoreRailAfterPanelsClosed()
    openPanelIds.add(panelId)
    activePanelId = panelId
    taskOverlay.setActive(panelId)
    collapseRailForPanel()
  },
  onToggleSection: (sectionId) => {
    if (sectionId !== RAIL_PIN_SECTION_ID) return
    railPinsCollapsed = !railPinsCollapsed
    try { localStorage.setItem(RAIL_PINS_COLLAPSED_KEY, railPinsCollapsed ? '1' : '0') } catch (_) {}
    taskOverlay.setPanels(visiblePanels())
  },
  /**
   * 右键某一项 —— 目前**只有「固定到 rail 的书签」有菜单**（它与书签栏共用同一份定义）。
   *
   * 面板项 / 插件图标**返回 false**：组件据此不 `preventDefault`，也就是"这次右键没人管"。
   * 宁可保持原样，也不要吃掉一次右键却什么都不弹（那是"点了没反应"的另一种长相）。
   *
   * @returns {boolean} 这次右键是否已有人接管
   */
  onItemContextMenu: (panelId, pos) => {
    if (typeof panelId !== 'string' || !panelId.startsWith(RAIL_PIN_PREFIX)) return false
    if (!pos || !Number.isFinite(pos.x) || !Number.isFinite(pos.y)) return false
    const hit = railPinnedItems.find((it) => it.id === panelId)
    if (!hit || !hit.bookmark) return false
    showRailPinMenu(pos.x, pos.y, hit.bookmark).catch(() => {})
    return true
  },
  /**
   * 「固定到 rail 的书签」拖拽重排 —— 组件只报**新顺序**（上下拖出来的），落库在这里。
   *
   * 乐观更新：先把内存顺序换掉、立刻重画一次（拖拽必须跟手，等一趟 IPC 再动会"弹回去"），
   * 再落库；失败由 `bookmark:changed` 广播回来对账（`refreshRailPinned` 会重读库）。
   *
   * ⚠ 顺序表必须**完整**才认：组件报的是"整列可拖动项的新顺序"，一旦两边长度对不上
   *（插件/设置刚改了列、DOM 正在重建），宁可整次不动 —— 拿半份顺序去重排会丢项。
   */
  onReorder: (orderedIds) => {
    const byPanelId = new Map<string, RailPinnedItem>(railPinnedItems.map((it) => [it.id, it]))
    const next = orderedIds.map((id) => byPanelId.get(id)).filter((item): item is RailPinnedItem => !!item)
    if (next.length !== railPinnedItems.length) return
    railPinnedItems = next
    taskOverlay.setPanels(visiblePanels())
    // 落库的是**书签 id**（去掉 `pin:` 前缀），不是 rail 的 panel id
    bookmarksClient.railPinnedReorder(next.map((it) => it.bookmark.id)).catch(() => refreshRailPinned())
  },
  /**
   * **动作按钮**（贴底那一排）：目前只有一项 —— 「侧栏浏览」（对齐 Vivaldi 面板条上的 `+`）。
   *
   * 语义：**不加输入框**（Vivaldi 的加号就是"把当前页放上去"）；url 省略 → 主进程用活动标签解析
   *（活动标签只有主进程权威）。非法页（about: / chrome:）由主进程拒绝，这里不做判断 ——
   * 渲染层不维护"当前页是什么"的第二份事实。
   */
  actions: [
    {
      id: 'open-in-sidebar',
      title: '侧栏浏览',
      icon: (doc, opts) => iconByName('PanelRight', doc, { size: opts?.size || 14 }) || doc.createElement('span'),
      onActivate: () => {
        webSidebarClient.open().catch(() => {})
      }
    }
  ],
  onZenModeChange: (enabled) => {
    localStorage.setItem('hira-zen-mode', enabled ? '1' : '0')
  },
  // 面板宽度不从这里喂：两侧各有独立宽度与记忆（设置项 app.panel_width_left / _right
  // 经 applier 灌进主进程布局），面板宿主拖拽后自己写回。组件内那个 dataset 只是
  // 历史遗留占位，不再参与换算。
  zenMode: localStorage.getItem('hira-zen-mode') === '1',
  // 抽屉：开合是视图态（组件只画），持久化与"编辑时强制展开"归本文件。
  drawerOpen: railDrawerOpen,
  onToggleDrawer: (open) => {
    railDrawerOpen = !!open
    taskOverlay.setDrawerOpen(railDrawerOpen)
    try { localStorage.setItem(RAIL_DRAWER_OPEN_KEY, railDrawerOpen ? '1' : '0') } catch (_) {}
  }
})

root.appendChild(taskOverlay.element)

// 启动恢复：偏好决定“该展开”，原生视图宽度由主进程单独持有。
// 读齐两项再施加，避免先按默认宽度闪一帧、再跳到用户宽度。
Promise.all([
  settingsClient.get(LAYOUT_SETTING_KEYS.toolRailExpandMode),
  settingsClient.get(LAYOUT_SETTING_KEYS.toolRailWidth),
  settingsClient.get(RAIL_WIDTH_MIGRATION_KEY)
]).then(([mode, width, migrationVersion]) => {
  railExpandMode = normalizeRailExpandMode(mode)
  railExpandedPreference = railExpandMode !== 'rail'
  const storedWidth = migrateStoredRailWidth(width, migrationVersion)
  railExpandedWidth = storedWidth.width
  if (!storedWidth.migrationComplete) {
    if (storedWidth.width !== Math.round(Number(width))) {
      settingsClient.set(LAYOUT_SETTING_KEYS.toolRailWidth, storedWidth.width).catch(() => {})
    }
    settingsClient.set(RAIL_WIDTH_MIGRATION_KEY, RAIL_WIDTH_MIGRATION_VERSION).catch(() => {})
  }
  syncRailCloseRestore()
  applyRailPresentation()
}).catch(() => {
  syncRailCloseRestore()
  applyRailPresentation()
})

// ── 下载红点（rail）────────────────────────────────────────────────────
// 主进程只在「有 / 无活动下载」跃迁时发一次事件；本视图只做一次布尔比较 + 一次 class 切换，
// 没有轮询、没有定时器。启动补一次读数（覆盖"下载早于本视图订阅"的窗口期）。
const downloadBadge = createDownloadActivityWatcher({
  provider: bridge.provider,
  subscribe: (route, fn) => bridge.on.subscribe(route, fn),
  onChange: (active) => taskOverlay.setBadge('downloads-panel', active)
})
window.addEventListener('pagehide', () => downloadBadge.dispose(), { once: true })

// ── 面板目录：先拉一次，之后随插件启停刷新 ──
// 首屏必须等这一拉？不必 —— 主进程侧有保底目录（plugins 未就绪时也能列出面板），
// 因此这里拿到的是「当前真实面板集合」，拉回来直接重建那一列即可。
const initialCatalogRevision = ++railCatalogRevision
panelsClient.catalog()
  .then((entries) => {
    if (initialCatalogRevision === railCatalogRevision) applyCatalog(entries)
  })
  .catch((e) => console.error('[rail] load panel catalog failed:', e && e.message))

// 插件贡献的 rail 图标（side-panel.rail-icon-slot）：与目录并行拉，互不阻塞。
refreshSlotIcons(railIdentityRevision, initialCatalogRevision)

// 固定到 rail 的书签（书签编辑器里勾选）：同样并行拉。
refreshRailPinned()
// 任何来源的书签变更（编辑器勾选/取消、书签被删除）→ 重建固定项图标列。
// 用广播而不是"谁改谁刷新"：改动方可能在任何窗口（编辑器子窗口 / 书签页 / 面板），
// 订阅同一份事实源才能保证 rail 永远和库一致。
const offBookmarksChanged = bookmarksClient.onChanged(() => {
  refreshRailPinned()
  schedulePreviewRefresh(80, ['favorites-panel'])
})

// 真实标签 / 历史 / 下载变化 → 展开态摘要跟着更新。
const offTabsChanged = tabsClient.onChanged((payload) => {
  // 推送里已经有最新投影时直接交给统一标签组件，当前标签高亮不会等下一次拉取。
  if (payload && (Array.isArray(payload.projection) || Array.isArray(payload.tabs)) && railPresentationExpanded()) {
    applyTabPreviewRows(Array.isArray(payload.projection) ? payload.projection : payload.tabs, payload.tabs)
    schedulePreviewRefresh(250, ['history-panel'])
    return
  }
  schedulePreviewRefresh(250, ['open-tabs-panel', 'history-panel'])
})
const offDownloadProgress = bridge.on.subscribe(IPC_EVENTS.downloadProgress, () => schedulePreviewRefresh(500, ['downloads-panel']))
const offDownloadDone = bridge.on.subscribe(IPC_EVENTS.downloadDone, () => schedulePreviewRefresh(80, ['downloads-panel']))
const offSpaceChanged = bridge.on.subscribe(IPC_EVENTS.spaceChanged, () => schedulePreviewRefresh(80, ['spaces-panel']))
const offSpaceWindowChanged = bridge.on.subscribe(IPC_EVENTS.spaceWindowChanged, () => schedulePreviewRefresh(80, ['spaces-panel']))

// 任一插件被启用/禁用 → 面板目录与插件图标都可能已变。
const offPanelsChanged = panelsClient.onChanged(() => {
  const revision = ++railCatalogRevision
  panelsClient.catalog()
    .then((entries) => {
      if (revision === railCatalogRevision) applyCatalog(entries)
    })
    .catch(() => {})
  refreshSlotIcons(railIdentityRevision, revision)
})

// profile 切换会换掉固定书签、插件 rail 图标与摘要数据源；这些都不会自动发
// bookmarks:changed / plugins:changed，必须在这里显式整组刷新。
const offProfileChanged = bridge.on.subscribe(IPC_EVENTS.profileChanged, () => {
  refreshRailProfileData()
})

// 扩展会话晚于 profile 投影就绪。此时再刷一次插件贡献的 rail 图标，
// 避免扩展尚未绑定完成时把空插槽缓存成永久占位。
const offExtensionChanged = bridge.on.subscribe(IPC_EVENTS.extensionChanged, (payload) => {
  const reason = payload && typeof payload === 'object'
    ? String((payload as Record<string, unknown>).reason || '')
    : ''
  if (reason.startsWith('profile-context')) refreshRailProfileData()
})

// 面板侧别广播是“开着没有”的唯一实时事实：关闭按钮 / Esc / 对账路径都从这里汇入。
const offPanelSideChanged = panelsClient.onSideChanged((payload) => {
  const panelId = payload && typeof payload.panelId === 'string' ? payload.panelId : ''
  if (!panelId) return
  const side = payload.side === 'left' || payload.side === 'right' ? payload.side : null
  if (side) {
    if (openPanelIds.size === 0) collapseRailForPanel()
    openPanelIds.add(panelId)
  }
  else openPanelIds.delete(panelId)

  // 关闭后同步图标活动态，避免 rail 长期亮着一个已经销毁的面板。
  if (!side && activePanelId === panelId) {
    activePanelId = null
    taskOverlay.setActive(null)
  }
  if (openPanelIds.size === 0 && pendingPanelSwitchCount === 0) restoreRailAfterPanelsClosed()
  else applyRailPresentation()
})

// ── 主题 ──
const themeController = createThemeController({ document, bridge })
themeController.start()
window.addEventListener('pagehide', () => themeController.dispose(), { once: true })

// ── 按钮顺序 / 显隐（与 navbar 各自独立的一条设置）──
// settingsClient.get 已解包主进程的 {value} 信封 —— 拿到信封会让 resolvePanelOrder
// 退回「全可见 + 目录顺序」，编辑结果重启后失效。
settingsClient.get(SHELL_BUTTON_SETTING_KEYS.rail)
  .then((v) => {
    railButtonsSetting = v
    taskOverlay.setPanels(visiblePanels())
  })
  .catch((e) => console.error('[rail] read rail_buttons failed:', e && e.message))

// ── 按钮编辑模式（rail 侧）────────────────────────────────────────────
// 进入：先把自己这列图标的几何报给主进程（编辑浮层按同一几何克隆这一列，视觉不跳），
//      再隐身让位；退出：恢复显示。
function reportItemsZones() {
  if (!railEditing) return
  const zones = typeof taskOverlay.getItemsZones === 'function' ? taskOverlay.getItemsZones() : []
  if (!Array.isArray(zones) || zones.length === 0) return
  try {
    // rail 有两个投放区（常驻 rail / 抽屉 drawer），与 navbar 的多段上报同构。
    bridge.provider.send('buttons-edit:zone', {
      surface: 'rail',
      segments: zones.map((z) => ({ key: z.key, rect: z.rect, items: z.items, grow: z.grow, axis: z.axis }))
    })
    const pinnedZone = typeof taskOverlay.getPinnedItemsZone === 'function'
      ? taskOverlay.getPinnedItemsZone()
      : null
    if (pinnedZone) {
      bridge.provider.send('buttons-edit:zone', {
        surface: 'rail-pins',
        segments: [{
          key: 'pins',
          rect: pinnedZone.rect,
          items: pinnedZone.items,
          grow: pinnedZone.grow,
          axis: pinnedZone.axis
        }]
      })
    }
  } catch (_) {}
  taskOverlay.setItemsHidden(true)
}

let railZoneFrame = 0
function scheduleReportItemsZones() {
  if (!railEditing || railZoneFrame) return
  railZoneFrame = requestAnimationFrame(() => {
    railZoneFrame = 0
    if (railEditing) reportItemsZones()
  })
}
window.addEventListener('resize', () => {
  if (railEditing) scheduleReportItemsZones()
})
window.addEventListener('pagehide', () => {
  offBookmarksChanged()
  offTabsChanged()
  offDownloadProgress()
  offDownloadDone()
  offSpaceChanged()
  offSpaceWindowChanged()
  offPanelsChanged()
  offProfileChanged()
  offExtensionChanged()
  offPanelSideChanged()
  if (railPreviewTimer) clearTimeout(railPreviewTimer)
  railPreviewTimer = null
  if (railWidthFrame) cancelAnimationFrame(railWidthFrame)
  railWidthFrame = 0
  if (railZoneFrame) cancelAnimationFrame(railZoneFrame)
  railZoneFrame = 0
  railPreviewRequest += 1
  tabPreviewRequest += 1
  pendingPanelSwitchCount = 0
  panelActionRevisions.clear()
}, { once: true })

bridge.on.subscribe('buttons-edit:active', (payload) => {
  const active = !!(payload && payload.active)
  const wasEditing = railEditing
  railEditing = active
  if (!active) {
    // 退出编辑：抽屉回到用户上次的开合状态（编辑期是强制展开的）。
    railPinsCollapsed = railPinsCollapsedBeforeEditing
    taskOverlay.setPanels(visiblePanels())
    taskOverlay.setDrawerOpen(railDrawerOpen)
    taskOverlay.setItemsHidden(false)
    applyRailPresentation()
    return
  }
  if (wasEditing) {
    applyRailPresentation()
    scheduleReportItemsZones()
    return
  }
  // 先强制进入编辑展示态，不能等设置读取后才展开；设置读取只负责校正按钮目录。
  railPinsCollapsedBeforeEditing = railPinsCollapsed
  railPinsCollapsed = false
  taskOverlay.setPanels(visiblePanels())
  taskOverlay.setDrawerOpen(true)
  applyRailPresentation()
  // 进编辑前按设置重算一次图标列（自愈）：启动期读取失败 / 事件丢失会让这一列与
  // rail_buttons 不一致，而编辑浮层是按本列几何克隆的 —— 必须先校正，克隆才准。
  settingsClient.get(SHELL_BUTTON_SETTING_KEYS.rail)
    .then((v) => { railButtonsSetting = v; taskOverlay.setPanels(visiblePanels()) })
    .catch(() => {})
    .finally(() => {
      if (!railEditing) return
      taskOverlay.setPanels(visiblePanels())
      taskOverlay.setDrawerOpen(true)
      // 展开宽度在下一拍才会落到原生视图；量完再隐藏图标，避免无几何可克隆。
      applyRailPresentation()
      scheduleReportItemsZones()
    })
})

// 编辑浮层每落一次点都会请我们**重量一次**：图标列刚变（被收走 / 放回），
// 浮层手里的几何必须跟着变，否则下一次把图标拖回来时投放区已经不在原地了。
bridge.on.subscribe('buttons-edit:remeasure', () => {
  scheduleReportItemsZones()
})

// 主进程兜底收起编辑浮层（切标签 / 窗口失焦）→ 退出编辑，把自己这列图标放出来。
bridge.on.subscribe(IPC_EVENTS.overlayClosed, (payload) => {
  if (payload && payload.name === 'buttons-edit-overlay') {
    railPinsCollapsed = railPinsCollapsedBeforeEditing
    taskOverlay.setPanels(visiblePanels())
    taskOverlay.setDrawerOpen(railDrawerOpen)
    taskOverlay.setItemsHidden(false)
    railEditing = false
    applyRailPresentation()
  }
})

// 有浮层压在本 rail 的拖拽区上时（总览 / 按钮编辑铺满整窗，或**侧栏悬停浮出层**
// 展开），本 rail 的拖拽区必须让位 —— `-webkit-app-region` 是窗口级合并的，浮层盖不住它。
// 尤其侧栏浮出层那条：纵向轨道里 rail 的 x **就等于侧栏宽度**，它声明的 drag 区
// 正好落在浮出层的宽度段里，不让位就会出现"在浮层里点标签只有几条缝点得动、
// 往旁边一拖还把窗口拖走"。
// 判据不在渲染层：LayoutCoordinator 按「浮层矩形 ∩ chrome 拖拽带」算出让位与否
//（`_chromeDragBands` / `_syncFloatDragGuard`），window-chrome 广播 `overlay:modal`，
// 这里只负责按 ui-common#setOverlayDragSuppressed 切类。
bridge.on.subscribe('overlay:modal', (payload) => {
  setOverlayDragSuppressed(document, !!(payload && payload.open))
})

bridge.on.subscribe(IPC_EVENTS.chromeDragSuppressed, (payload) => {
  setChromeDragSuppressed(document, !!(payload && payload.suppressed))
})

/**
 * 读齐 rail 位置 + 两条起始边，一次施加到组件。
 *
 * 这里只做两件事：把组件切到正确的轴向 / 对齐端；把「面板开哪侧」解算出来存给
 * onTogglePanel。方向判断不在渲染层重写 —— 与主进程、外壳共用 resolveRailPanelSide。
 */
function refreshRailLayout() {
  return Promise.all([
    settingsClient.get(LAYOUT_SETTING_KEYS.toolSidebarPosition),
    settingsClient.get(LAYOUT_SETTING_KEYS.toolRailHorizontalAlign),
    settingsClient.get(LAYOUT_SETTING_KEYS.toolRailVerticalAlign)
  ]).then(([rawPosition, rawHorizontal, rawVertical]) => {
    const position = normalizeRailPosition(rawPosition)
    const horizontalAlign = normalizeRailHorizontalAlign(rawHorizontal)
    const verticalAlign = normalizeRailVerticalAlign(rawVertical)
    railLayout = { position, horizontalAlign, verticalAlign }
    sidebarSide = resolveRailPanelSide(position, horizontalAlign)
    tabPreviewHost?.element.setAttribute('data-region-side', sidebarSide)
    // 组件侧共用同一个入口：轴向（横 / 纵）+ 对齐端；面板侧由 sidebarSide 单独承载。
    taskOverlay.setRailLayout(railLayout)
    applyRailPresentation()
    // 编辑浮层正压在这一列上时，它的克隆几何是按旧轴向算的 —— 立刻重量一次，
    // 否则横竖一换，虚线框与图标就错行（浮层只看我们上报的那份几何）。
    if (railEditing) scheduleReportItemsZones()
  }).catch((e) => console.error('[rail] read rail layout failed:', e && e.message))
}

// ── rail 位置 / 起始边：启动读一次，变更时热更新 ──
refreshRailLayout()

bridge.on.subscribe('settings:changed', (change) => {
  if (!change) return
  if (
    change.scope === 'all' ||
    change.key === LAYOUT_SETTING_KEYS.toolSidebarPosition ||
    change.key === LAYOUT_SETTING_KEYS.toolRailHorizontalAlign ||
    change.key === LAYOUT_SETTING_KEYS.toolRailVerticalAlign
  ) {
    refreshRailLayout()
  }
  if (change.scope === 'all' || change.key === LAYOUT_SETTING_KEYS.toolRailExpandMode) {
    if (change.scope === 'all') {
      settingsClient.get(LAYOUT_SETTING_KEYS.toolRailExpandMode)
        .then((value) => {
          railExpandMode = normalizeRailExpandMode(value)
          railExpandedPreference = railExpandMode !== 'rail'
          applyRailPresentation()
        })
        .catch(() => {})
    } else {
      railExpandMode = normalizeRailExpandMode(change.value)
      railExpandedPreference = railExpandMode !== 'rail'
      applyRailPresentation()
    }
  }
  if (change.scope === 'all' || change.key === LAYOUT_SETTING_KEYS.toolRailWidth) {
    if (change.scope === 'all') {
      settingsClient.get(LAYOUT_SETTING_KEYS.toolRailWidth)
        .then((value) => {
          railExpandedWidth = Math.max(RAIL_WIDTH_MIN, normalizeRailWidth(value))
          if (railExpandedBeforePanel !== null) syncRailCloseRestore()
          applyRailPresentation()
        })
        .catch(() => {})
    } else {
      railExpandedWidth = Math.max(RAIL_WIDTH_MIN, normalizeRailWidth(change.value))
      if (railExpandedBeforePanel !== null) syncRailCloseRestore()
      applyRailPresentation()
    }
  }
  // 顺序 / 显隐热更新（按钮编辑浮层每次落点都会写这条设置）
  if (change.scope === 'all' || change.key === SHELL_BUTTON_SETTING_KEYS.rail) {
    if (change.scope === 'all') {
      settingsClient.get(SHELL_BUTTON_SETTING_KEYS.rail)
        .then((v) => { railButtonsSetting = v; taskOverlay.setPanels(visiblePanels()) })
        .catch(() => {})
    } else {
      railButtonsSetting = change.value
      taskOverlay.setPanels(visiblePanels())
    }
  }
})

// 面板宽度：**不再**从这里喂。
// 两侧面板位各有独立宽度与记忆，记在设置项 app.panel_width_left / app.panel_width_right：
// 启动时由设置生效器（settings/appliers/layout.js）灌回布局，拖拽后由面板宿主写回。
// 旧实现在这里推一个全局的 localStorage 值（默认 320），会把某一侧的记忆冲掉。

// Zen mode 快捷键
document.addEventListener('keydown', (e) => {
  if (e.ctrlKey && e.shiftKey && e.key === 'Z') {
    e.preventDefault()
    const currentZen = localStorage.getItem('hira-zen-mode') === '1'
    taskOverlay.setZenMode(!currentZen)
  }
})
