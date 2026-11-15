// @ts-check
/**
 * UI TaskOverlay - 任务浮层（左侧 Rail + Sidebar）。
 *
 * Week 14: 基础 Rail 工具栏
 * Week 16: rail hover tooltip + zen mode + 面板宽度拖拽 + 侧栏搜索
 *
 * 解耦原则：
 * - 不依赖 infra/domain 层，面板定义通过 options.panels 注入
 * - 不依赖任何图标库，图标工厂通过 options.icons 注入（app 层通常传 ui-common#PANEL_ICONS，与 navbar 同源）
 * - 不访问任何私有属性
 * - 所有外部交互通过回调（onTogglePanel / onZenModeChange）
 * - Rail 展开/收起无动画（用户偏好）
 *
 * @module @hira-ng/ui-taskoverlay
 */

// 拖拽落点几何（中点判定 / 首尾外推 / 指示线贴边）与"拖拽期中和窗口拖拽区" ——
// 两者都是**跨视图共用件**（纵向标签列 ui-common#tabRowList 用的同一份），
// 见 axisAdapter.ts / dragRegion.ts 的文件头：手感不一致正是用户最先察觉的地方。
import { axisAdapter, createDragRegionSuppressor, createFaviconBadge, createFileIcon, resolveIcon } from '@hira-ng/ui-common'
// 图标条自身厚度（纵向 = 宽、横向 = 高）：与主进程算横向带高 / rail 视图高的是
// **同一个常量**。以前这里各写一个 44，主进程又按 sidebarWidth(48) 算带高 ——
// 多出来的 4px 落在图标条另一头，横向 rail 的上下留白就比纵向的左右更宽。
import {
  RAIL_BAR_SIZE,
  RAIL_WIDTH_MIN,
  RAIL_WIDTH_MAX,
  RAIL_WIDTH_DEFAULT
} from '@hira-ng/shared-types/src/layout.mjs'

export type RailAxis = 'row' | 'column'
export type RailAlign = 'start' | 'end'
export type RailIconFactory = (doc: Document, options?: { size?: number }) => Element

export interface RailPanelDetail {
  id: string
  label: string
  meta?: string
  status?: string
  favicon?: string
  iconUrl?: string
  iconSrc?: string
  filename?: string
  onActivate?: (modifiers: RailPointerModifiers) => void
}

export interface RailPanelDef {
  id: string
  title?: string
  icon?: string | Element
  details?: RailPanelDetail[]
  detailsView?: HTMLElement
  /** 详情呈现方式；`icons` 只渲染单图标，标题保留为 tooltip / 无障碍名称。 */
  detailPresentation?: 'list' | 'icons'
  drawer?: boolean
  draggable?: boolean
  pinned?: boolean
  kind?: 'panel' | 'section'
  collapsed?: boolean
  actionPanelId?: string
}

export interface RailActionDef {
  id: string
  title?: string
  icon?: string | RailIconFactory
  onActivate?: () => void
}

export interface RailPointerModifiers {
  shiftKey: boolean
  ctrlKey: boolean
  metaKey: boolean
  altKey: boolean
}

export interface RailLayout {
  position?: 'left' | 'right' | 'top' | 'bottom'
  horizontalAlign?: 'left' | 'right'
  verticalAlign?: 'top' | 'bottom'
}

export interface RailItemRect {
  id: string
  x: number
  y: number
  width: number
  height: number
}

export interface RailItemsZone {
  key?: string
  axis: RailAxis
  grow: 'left' | 'right' | 'up' | 'down'
  rect: { x: number; y: number; width: number; height: number }
  items: RailItemRect[]
}

export interface TaskOverlayOptions {
  panels?: RailPanelDef[]
  actions?: RailActionDef[]
  icons?: Record<string, RailIconFactory>
  onTogglePanel?: (panelId: string, modifiers: RailPointerModifiers) => void
  onOpenPanel?: (panelId: string) => void
  onHoverPanel?: (panelId: string) => void
  getActivePanelId?: () => string | null
  onZenModeChange?: (enabled: boolean) => void
  zenMode?: boolean
  panelWidth?: number
  railExpanded?: boolean
  railWidth?: number
  onToggleRailExpanded?: (expanded: boolean) => void
  onRailWidthChange?: (width: number, committed: boolean) => void
  drawerOpen?: boolean
  onToggleDrawer?: (open: boolean) => void
  onToggleSection?: (sectionId: string) => void
  onItemContextMenu?: (panelId: string, position: { x: number; y: number }) => boolean | void
  onReorder?: (orderedIds: string[]) => void
}

export interface TaskOverlayController {
  readonly element: HTMLElement
  setActive(panelId: string | null): void
  setZenMode(enabled: boolean): void
  setPanelWidth(width: number): void
  setRailExpanded(expanded: boolean): void
  setRailWidth(width: number): void
  setRailLayout(layout?: RailLayout): void
  setPanels(panels: RailPanelDef[]): void
  setItemsHidden(hidden: boolean): void
  setDrawerOpen(open: boolean): void
  setBadge(panelId: string, enabled: boolean): void
  getItemsZones(): RailItemsZone[]
  getPinnedItemsZone(): RailItemsZone | null
}

/**
 * @typedef {Object} RailPanelDef
 * @property {string} id - 面板 ID
 * @property {string} title - 面板标题
 * @property {string|Element} [icon] - 显式图标（SVG 字符串或已构建元素），优先级高于 icons 注入
 * @property {boolean} [drawer] - 收在抽屉里（编辑界面的「抽屉区」）；缺省 = 常驻
 */



/**
 * @typedef {Object} TaskOverlayOptions
 * @property {RailPanelDef[]} panels - 面板定义列表
 * @property {Record<string, (doc: Document, opts?: { size?: number }) => Element>} [icons] - 面板 ID → 图标工厂（依赖注入；app 层传 ui-common#PANEL_ICONS 即与 navbar 完全同源）
 * @property {(panelId: string) => void} onTogglePanel - 点击 Rail 图标回调
 * @property {(panelId: string) => void} [onHoverPanel] - 入口**意图**（指针进入 / 按下）；
 *   编排层据此预热面板。组件只上报 id —— 它不认识"预热"是什么。
 * @property {() => string|null} [getActivePanelId] - 获取当前活动面板 ID
 * @property {(enabled: boolean) => void} [onZenModeChange] - Zen mode 状态变化回调
 * @property {boolean} [zenMode] - 初始 Zen mode 状态（收起态）
 * @property {number} [panelWidth] - 初始面板宽度
 * @property {boolean} [drawerOpen] - 抽屉初始是否展开（默认收起）；组件只持有视图态
 * @property {(open: boolean) => void} [onToggleDrawer] - 抽屉开合回调（持久化归编排层）
 */



const ZEN_HOVER_DELAY = 1000 // Zen mode 收起态 hover 展开延迟（ms）

// 按钮编辑模式：图标列投放区的最小跨度（与 navbar 各段同一口径 —— 3 格）。
// 见 getItemsZones：只剩一个图标时，并集就是那 33×33，加回来时几乎按不中。
const RAIL_SLOT = 33
const RAIL_GAP = 3
const RAIL_MIN_SLOTS = 3
/**
 * 抽屉区投放框的最小跨度（**格**）。
 *
 * 抽屉是「编辑时才展开、平时收着」的一段，用户要往里面放按钮时必须有一块像样的空地；
 * 和常驻区同一口径（3 格）会让它只有窄窄一条，手上拖着的按钮几乎盖满整个框。
 * 6 格 = 常驻区的两倍，明显"能放东西"而不至于把整列吃掉。
 */
const RAIL_DRAWER_MIN_SLOTS = 6

/** 注入 TaskOverlay 样式。 */
export function injectTaskOverlayStyles(doc: Document): void {
  const style = doc.createElement('style')
  style.id = 'hira-taskoverlay-styles'
  style.textContent = `
    /* ── 滚动契约：这一列**必须**是纵向滚动容器 ─────────────────────────────
       rail 是独立视图，本元素高度固定 = 视图高；图标 / 分区头 / 抽屉按自然高度堆叠，
       窗口一矮就必然超出可视区。四个条件缺一个滚轮就还是没用：
         ① 本元素 overflow-y: auto（隐藏滚动条：44px 宽的列里挂一条滚动条会直接
            吃掉图标宽度）；
         ② 每个直系块 flex: none —— flex 子项默认 flex-shrink: 1，内容超出时
            它们先被压扁（图标变矮、分区头挤没），永远撑不出可滚动的高度；
         ③ 祖先链有界：rail 的 html / body / #root 是 height:100% + overflow:hidden
            （见 renderer/rail/main.js），把本列钉成一屏高；
         ④ **整列不能是 -webkit-app-region: drag** —— drag 命中区是**非客户区**，
            指针事件（含滚轮）根本不进渲染进程。拖窗口交给下面的 .hira-rail-spacer
            （空白处），与纵向标签列（ui-vertical-tabs）同一条结论。

       底色跟随 --main-bg-color：本层是**独立视图**，透明的部分正好透出外壳那一层
       （壁纸 + 玻璃色），与 rail/面板/侧栏同一条口径（见 theme.mjs 的
       --main-bg-color 说明）—— 任何"自己再铺一层"的写法都会变成半透明叠加，
       表现是 rail 比 navbar/侧栏更实或更虚。 */
    #hira-task-overlay {
      --hira-rail-expanded-width: 140px;
      --hira-rail-item-gap: 4px;
      --hira-rail-item-pad-x: 6px;
      --hira-rail-item-pad-y: 3px;
      --hira-rail-item-min-height: 30px;
      --hira-rail-detail-gap: 4px;
      position: fixed;
      top: 0;
      left: 0;
      width: ${RAIL_BAR_SIZE}px;
      height: 100%;
      background: var(--main-bg-color);
      display: flex;
      flex-direction: column;
      align-items: center;
      padding: 8px 0;
      z-index: var(--hira-z-elevated); /* 浮动侧栏（fixed 压在内容区之上）= elevated */
      user-select: none;
      overflow-y: auto;
      overflow-x: hidden;
      overscroll-behavior: contain;
      scrollbar-width: none;
      -webkit-app-region: no-drag;
      contain: layout paint style;
    }
    #hira-task-overlay.rail-expanded {
      width: 100%;
      align-items: stretch;
      padding: 8px;
    }
    /* 展开按钮：一颗薄边框的小按钮，颜色完全跟随主题前景色。
       收起态只占图标栏中央；展开态靠内缘，提示“再点一次回到普通 rail”。 */
    .hira-rail-expander-slot {
      width: 30px;
      height: 22px;
      flex: none;
      display: flex;
      align-items: center;
      justify-content: center;
      margin-bottom: 4px;
    }
    #hira-task-overlay.rail-expanded .hira-rail-expander-slot {
      width: 100%;
      gap: 8px;
      justify-content: flex-end;
    }
    .hira-rail-expander-title {
      display: none;
      min-width: 0;
      margin-right: auto;
      overflow: hidden;
      color: var(--hira-text-tertiary, #8a8f98);
      font-family: var(--hira-font-ui, "Segoe UI Variable Text", "Segoe UI", "Microsoft YaHei UI", sans-serif);
      font-size: 8px;
      font-weight: 400;
      line-height: 10px;
      letter-spacing: 0;
      text-overflow: ellipsis;
      white-space: nowrap;
      opacity: 0.72;
      pointer-events: none;
      user-select: none;
    }
    #hira-task-overlay.rail-expanded .hira-rail-expander-title {
      display: block;
      flex: 1;
    }
    .hira-rail-expander {
      width: 30px;
      height: 22px;
      flex: none;
      display: inline-flex;
      align-items: center;
      justify-content: center;
      margin: 0;
      padding: 0;
      border: 1px solid color-mix(in srgb, currentColor 16%, transparent);
      border-radius: var(--hira-radius-xs, 6px);
      background: var(--hira-surface, #ffffff);
      color: var(--hira-chrome-fg, var(--hira-text-primary, #1a1a1a));
      cursor: pointer;
      -webkit-app-region: no-drag;
    }
    .hira-rail-expander:hover {
      background: color-mix(in srgb, var(--hira-surface, #ffffff) 94%, var(--hira-chrome-fg, #1a1a1a) 6%);
      border-color: color-mix(in srgb, currentColor 28%, transparent);
    }
    .hira-rail-expander:active {
      transform: scale(0.96);
    }
    .hira-rail-expander svg {
      width: 10px;
      height: 10px;
      pointer-events: none;
    }
    #hira-task-overlay.rail-align-end .hira-rail-expander-slot {
      order: -2;
    }
    #hira-task-overlay.rail-horizontal .hira-rail-expander-slot,
    #hira-task-overlay.rail-horizontal .hira-rail-resizer {
      display: none;
    }

    /* 拖宽手柄贴内容侧：常态隐藏，hover / 拖拽时只显示一条蓝色细线。 */
    .hira-rail-resizer {
      display: none;
      position: absolute;
      top: 0;
      bottom: 0;
      width: 7px;
      z-index: var(--hira-z-controls, 40);
      cursor: col-resize;
      -webkit-app-region: no-drag;
    }
    .hira-rail-resizer::after {
      content: '';
      position: absolute;
      top: 8px;
      bottom: 8px;
      width: 1px;
      background: transparent;
      opacity: 0;
      transition: opacity 120ms ease, background 120ms ease;
      transition-delay: 0ms;
      pointer-events: none;
    }
    #hira-task-overlay.rail-expanded.rail-side-left .hira-rail-resizer {
      display: block;
      right: 0;
    }
    #hira-task-overlay.rail-expanded.rail-side-left .hira-rail-resizer::after {
      right: 0;
    }
    #hira-task-overlay.rail-expanded.rail-side-right .hira-rail-resizer {
      display: block;
      left: 0;
    }
    #hira-task-overlay.rail-expanded.rail-side-right .hira-rail-resizer::after {
      left: 0;
    }
    .hira-rail-resizer:hover::after,
    .hira-rail-resizing .hira-rail-resizer::after {
      background: var(--hira-accent, #3b82f6);
    }
    .hira-rail-resizer:hover::after {
      opacity: 1;
      transition-delay: 160ms;
    }
    .hira-rail-resizing .hira-rail-resizer::after {
      opacity: 1;
      transition-delay: 0ms;
    }
    /* 隐藏滚动条（两种实现都要写：标准属性 + WebKit 伪元素）。 */
    #hira-task-overlay::-webkit-scrollbar { width: 0; height: 0; display: none; }

    /* ── 横向 rail（设置：工具侧栏位置 = 顶部 / 底部）─────────────────────
       轴向一换，整条就横跨内容区：宽 = 视图宽、高 = **撑满视图**（视图高度本身就是
       图标条厚度，由主进程按 RAIL_BAR_SIZE 落 bounds）。这里绝不能再钉一个 44：
       视图比 44 高时，多出来的那一条会全落在图标条另一头，上下留白就不对称了。 */
    #hira-task-overlay.rail-horizontal {
      width: 100%;
      height: 100%;
      flex-direction: row;
      align-items: center;
      padding: 0 8px;
      overflow-x: auto;
      overflow-y: hidden;
    }

    /* 收起端的对齐：把 spacer 挪到最前，按钮组整体贴到尾（右 / 下）。
       纵向「从下起」与横向「从右起」共用这一条 —— 两组设置只是同一根对齐轴。 */
    #hira-task-overlay.rail-align-end .hira-rail-spacer {
      order: -1;
    }

    /* 横向时整条是 align-items: center，spacer 会被当成"高 0 的一小段"，
       于是那条空白**拖不动窗口**（命中区为零）。让它撑满高度，空白才名副其实。 */
    #hira-task-overlay.rail-horizontal .hira-rail-spacer {
      align-self: stretch;
    }

    #hira-task-overlay.zen-collapsed {
      width: 0;
      padding: 0;
    }

    /* 横向时收起 = 高度归零（宽度必须留在 100%，否则会把整条视图"缩成一列"）。 */
    #hira-task-overlay.rail-horizontal.zen-collapsed {
      width: 100%;
      height: 0;
    }

    #hira-task-overlay.zen-collapsed .hira-rail-item,
    #hira-task-overlay.zen-collapsed .hira-rail-drawer,
    #hira-task-overlay.zen-collapsed .hira-rail-spacer {
      display: none;
    }

    /* 按钮编辑模式：图标列交给编辑浮层去画（浮层按上报几何原样克隆这一列按钮）。
       visibility 而非 display —— 几何必须仍可测（浮层靠它对齐）。

       本列整体已是 no-drag（滚动的前提，见上），所以这里只剩**空白处拖窗口**要停：
       编辑浮层正压在那块空白上，按下去若变成拖窗口，就是「点了没反应」。 */
    #hira-task-overlay.buttons-editing,
    #hira-task-overlay.buttons-editing .hira-rail-spacer {
      -webkit-app-region: no-drag;
    }

    #hira-task-overlay.buttons-editing .hira-rail-item {
      visibility: hidden;
    }

    /* 分区头同理让位：按钮编辑浮层按几何克隆"这一列图标"，中间多出一条分隔线会让克隆
       与实物对不上（用户看到线还在、图标却飘在浮层里）。 */
    #hira-task-overlay.buttons-editing .hira-rail-section {
      visibility: hidden;
    }
    #hira-task-overlay.buttons-editing .hira-rail-expander,
    #hira-task-overlay.buttons-editing .hira-rail-resizer {
      visibility: hidden;
    }

    /* ── 抽屉 ───────────────────────────────────────────────────────
       抽屉是**同列内的手风琴**：rail view 只有 44px 宽，横向弹出会直接被视图裁剪。
       抽屉开关本身就是一条**分区头**（.hira-rail-section，两侧细线 + 中央小箭头），
       收起时整组抽屉项隐藏、开关始终在；开关的位置由编排层给（组件不再钉在列尾），
       于是抽屉可以落在这一列的任意一段 —— 当前是「书签固定区」之上。 */
    .hira-rail-drawer {
      display: none;
      flex-direction: column;
      align-items: center;
      width: 100%;
      /* 直系块按自然高度参与滚动（见 #hira-task-overlay 的 ②）：不参与压缩。 */
      flex: none;
      /* 开关自己就是那条分隔线，这里不再叠第二条边框。 */
    }

    #hira-task-overlay.rail-drawer-open .hira-rail-drawer {
      display: flex;
    }

    /* 横向：抽屉从"同列手风琴"变成"同一行里的一段"，宽度随内容、高度撑满。 */
    #hira-task-overlay.rail-horizontal .hira-rail-drawer {
      flex-direction: row;
      align-items: center;
      width: auto;
      height: 100%;
    }

    .hira-rail-item {
      width: 33px;
      height: 33px;
      display: flex;
      align-items: center;
      justify-content: center;
      border-radius: var(--hira-radius-control, 7px);
      cursor: pointer;
      margin-bottom: 3px;
      /* 直系块按自然高度参与滚动（#hira-task-overlay 的 ②）——
         缺这一条时 33px 会被 flex-shrink 压扁，滚轮就永远滚不到"超出"那一档。 */
      flex: none;
      -webkit-app-region: no-drag;
      /* 默认态 = **浏览器 UI 的前景色**（主题 colors.chromeFg）—— 与 navbar / tabbar
         一起被同一根旋钮调（--hira-chrome-fg 就是它）。
         ⚠ 曾经写的是 --hira-text-secondary（= 主题的次要文字灰）：那是**内容面**的
         一档颜色，于是 rail 的图标永远是一团死灰、跟前景色旋钮毫无关系
         （用户原话："rail 的图标还是狗屎一样的纯灰不跟一起调节"）。
         图标是 stroke="currentColor"，所以颜色只在这里决定。 */
      color: var(--hira-chrome-fg, var(--hira-text-primary, #1a1a1a));
      position: relative;
    }

    #hira-task-overlay.rail-expanded .hira-rail-item {
      width: 100%;
      height: auto;
      min-height: 0;
      display: block;
      padding: 0;
      margin-bottom: var(--hira-rail-item-gap);
      background: transparent;
      cursor: default;
    }

    /* 固定到 rail 的书签始终是图标：横向流式排列，空间不足自动换行。
       它们与面板项共用点击 / 右键 / 拖拽能力，但不参与名称态的详情行。 */
    .hira-rail-pins {
      width: 100%;
      flex: none;
      display: grid;
      grid-template-columns: repeat(auto-fill, 30px);
      justify-content: center;
      gap: 2px;
      padding: 2px 0;
    }
    .hira-rail-pins .hira-rail-item,
    #hira-task-overlay.rail-expanded .hira-rail-pins .hira-rail-item {
      width: 30px;
      height: 30px;
      min-height: 0;
      display: flex;
      align-items: center;
      justify-content: center;
      margin: 0;
      padding: 0;
      cursor: pointer;
    }
    .hira-rail-pins .hira-rail-item__header,
    #hira-task-overlay.rail-expanded .hira-rail-pins .hira-rail-item__header {
      width: 30px;
      height: 30px;
      min-height: 0;
      gap: 0;
      padding: 0;
      justify-content: center;
    }
    .hira-rail-pins .hira-rail-item__content,
    .hira-rail-pins .hira-rail-item__disclosure,
    .hira-rail-pins .hira-rail-item__open,
    .hira-rail-pins .hira-rail-item__details {
      display: none !important;
    }
    #hira-task-overlay.rail-horizontal .hira-rail-pins {
      width: auto;
      height: 100%;
      display: flex;
      align-items: center;
      gap: 2px;
      padding: 0;
    }

    /* 没有详情列表的面板项在名称态占两列；无详情的紧凑项不制造整行空白。 */
    .hira-rail-compact {
      width: 100%;
      flex: none;
      display: flex;
      flex-direction: column;
      align-items: center;
      margin-bottom: 3px;
    }
    #hira-task-overlay.rail-expanded .hira-rail-compact {
      display: grid;
      grid-template-columns: minmax(0, 1fr);
      gap: 2px;
    }
    #hira-task-overlay.rail-expanded .hira-rail-compact .hira-rail-item,
    #hira-task-overlay.rail-expanded .hira-rail-compact .hira-rail-item__header {
      width: 100%;
      min-width: 0;
    }
    #hira-task-overlay.rail-expanded .hira-rail-compact .hira-rail-item {
      margin-bottom: 0;
    }
    #hira-task-overlay.rail-expanded .hira-rail-compact .hira-rail-item__header {
      gap: 4px;
      padding: var(--hira-rail-item-pad-y) 4px;
    }
    #hira-task-overlay.rail-expanded .hira-rail-compact .hira-rail-item__label {
      font-size: 12px;
    }
    #hira-task-overlay.rail-expanded .hira-rail-compact .hira-rail-item__open {
      width: 9px;
      height: 9px;
    }

    .hira-rail-item__header {
      width: 33px;
      height: 33px;
      display: flex;
      align-items: center;
      justify-content: center;
      border-radius: var(--hira-radius-control, 7px);
      cursor: pointer;
    }
    #hira-task-overlay.rail-expanded .hira-rail-item__header {
      width: 100%;
      min-height: var(--hira-rail-item-min-height);
      height: auto;
      display: flex;
      align-items: center;
      gap: 6px;
      padding: var(--hira-rail-item-pad-y) var(--hira-rail-item-pad-x);
    }

    .hira-rail-item__icon {
      width: 19px;
      height: 19px;
      display: flex;
      align-items: center;
      justify-content: center;
      flex: none;
      contain: layout paint style;
    }
    .hira-rail-item__icon svg {
      width: 17px;
      height: 17px;
    }
    #hira-task-overlay.rail-icons-settling .hira-rail-item__icon {
      transform-origin: 50% 50%;
      animation: hira-rail-icon-settle 260ms cubic-bezier(0.16, 0.9, 0.24, 1);
    }
    @keyframes hira-rail-icon-settle {
      from { opacity: 0.2; transform: scale(1.1) translateY(-6px); }
      to { opacity: 1; transform: scale(1) translateY(0); }
    }
    .hira-rail-item__content {
      display: none;
      min-width: 0;
      align-self: center;
    }
    #hira-task-overlay.rail-expanded .hira-rail-item__content {
      display: flex;
      align-items: center;
      flex: 1;
    }
    .hira-rail-item__label {
      min-width: 0;
      overflow: hidden;
      color: var(--hira-chrome-fg, var(--hira-text-primary, #1a1a1a));
      font-family: var(--hira-font-ui, "Segoe UI Variable Text", "Segoe UI", "Microsoft YaHei UI", sans-serif);
      font-size: 12px;
      font-weight: 400;
      line-height: 1.2;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .hira-rail-item__disclosure {
      display: none;
      width: 13px;
      height: 20px;
      align-items: center;
      justify-content: center;
      padding: 0;
      border: 0;
      background: transparent;
      color: var(--hira-text-secondary, #6b7280);
      cursor: pointer;
    }
    #hira-task-overlay.rail-expanded .hira-rail-item.has-details .hira-rail-item__disclosure {
      display: flex;
    }
    .hira-rail-item__disclosure svg {
      width: 9px;
      height: 9px;
      pointer-events: none;
    }
    .hira-rail-item.is-details-collapsed .hira-rail-item__disclosure svg {
      transform: rotate(-90deg);
    }

    .hira-rail-item__details {
      display: none;
      flex-direction: column;
      gap: var(--hira-rail-detail-gap);
      width: 100%;
      padding: 2px 0;
    }
    #hira-task-overlay.rail-expanded .hira-rail-item.is-details-open .hira-rail-item__details {
      display: flex;
    }
    .hira-rail-item__custom-details {
      width: 100%;
      min-height: 0 !important;
      margin: 0;
    }
    /* rail 里的标签沿用统一组件的外观和交互，但禁用其面板级入场 / 关闭动画。 */
    .hira-rail-tab-preview,
    .hira-rail-tab-preview * {
      animation: none !important;
      transition: none !important;
    }
    .hira-rail-tab-preview,
    .hira-rail-tab-preview .tabrow-label {
      font-family: var(--hira-font-ui, "Segoe UI Variable Text", "Segoe UI Variable", "Segoe UI", "Microsoft YaHei UI", "Microsoft YaHei", "PingFang SC", "Noto Sans SC", system-ui, -apple-system, sans-serif);
      font-size: 11.5px;
      font-weight: 400;
      letter-spacing: 0;
    }
    .hira-rail-tab-preview {
      --ng-tab-height: 30px;
      --ng-tab-gap: 6px;
      --ng-tab-radius: 7px;
    }
    .hira-rail-tab-preview .tabrow-row {
      padding-left: 10px;
    }
    .hira-rail-item__custom-details .tabrow-row {
      width: 100%;
    }
    .hira-rail-item__custom-details .tabrow-row + .tabrow-row {
      margin-top: 2px;
    }
    .hira-rail-item__custom-details > .tabrow-pair + .tabrow-row,
    .hira-rail-item__custom-details > .tabrow-row + .tabrow-pair,
    .hira-rail-item__custom-details > .tabrow-pair + .tabrow-pair {
      margin-top: 2px;
    }
    #hira-task-overlay.rail-expanded .hira-rail-item.has-details {
      padding-bottom: 1px;
    }
    #hira-task-overlay.rail-expanded .hira-rail-item.has-details::after {
      content: '';
      position: absolute;
      left: 8px;
      right: 8px;
      bottom: 0;
      height: 1px;
      background: color-mix(in srgb, var(--hira-chrome-fg, #1a1a1a) 7%, transparent);
      pointer-events: none;
    }
    .hira-rail-item__detail {
      min-width: 0;
      width: 100%;
      min-height: 26px;
      display: flex;
      align-items: center;
      gap: 4px;
      padding: 4px 7px;
      border: 0;
      border-radius: var(--hira-radius-sm, 8px);
      background: transparent;
      color: var(--hira-text-secondary, #6b7280);
      font-family: var(--hira-font-ui, "Segoe UI Variable Text", "Segoe UI", "Microsoft YaHei UI", sans-serif);
      font-size: 12px;
      font-weight: 400;
      line-height: 1.4;
      text-align: left;
      cursor: pointer;
    }
    .hira-rail-item__detail:hover {
      background: var(--hira-hover-bg, rgba(0, 0, 0, 0.05));
      color: var(--hira-chrome-fg, var(--hira-text-primary, #1a1a1a));
    }
    .hira-rail-item__detail:active {
      transform: scale(0.985);
    }
    .hira-rail-item__header:focus-visible,
    .hira-rail-item__detail:focus-visible,
    .hira-rail-item__disclosure:focus-visible {
      outline: 2px solid var(--hira-accent, #3b82f6);
      outline-offset: -2px;
    }
    .hira-rail-item__detail-icon {
      width: 16px;
      height: 16px;
      flex: none;
      display: flex;
      align-items: center;
      justify-content: center;
    }
    .hira-rail-item__detail-icon svg {
      width: 14px;
      height: 14px;
      pointer-events: none;
    }
    .hira-rail-item__detail-file-icon {
      width: 16px;
      height: 16px;
      object-fit: contain;
      display: block;
      pointer-events: none;
    }
    .hira-rail-item__detail-main {
      flex: 1;
      min-width: 0;
      display: flex;
      flex-direction: column;
      gap: 0;
    }
    .hira-rail-item__detail-title,
    .hira-rail-item__detail-meta {
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .hira-rail-item__detail-title {
      color: var(--hira-text-primary, #1a1a1a);
      font-size: 12px;
      font-weight: 400;
      line-height: 15px;
    }
    .hira-rail-item__detail-meta {
      color: var(--hira-text-tertiary, #8a8f98);
      font-size: 9.5px;
      line-height: 12px;
    }
    .hira-rail-item__detail-status {
      flex: none;
      padding: 2px 6px;
      border-radius: 999px;
      background: var(--hira-accent-soft, rgba(59, 130, 246, 0.12));
      color: var(--hira-accent, #3b82f6);
      font-size: 9px;
      line-height: 13px;
    }
    .hira-rail-item__details.is-icons {
      display: none;
      grid-template-columns: repeat(auto-fill, 28px);
      justify-content: start;
      gap: 1px;
      padding: 1px 0;
    }
    #hira-task-overlay.rail-expanded .hira-rail-item.is-details-open .hira-rail-item__details.is-icons {
      display: grid;
    }
    .hira-rail-item__detail.is-icon-only {
      width: 28px;
      height: 28px;
      min-height: 28px;
      justify-content: center;
      gap: 0;
      padding: 0;
    }
    .hira-rail-item__detail.is-icon-only .hira-rail-item__detail-icon {
      width: 18px;
      height: 18px;
    }
    .hira-rail-item__open {
      display: none;
      width: 9px;
      height: 9px;
      align-self: center;
      justify-self: end;
      opacity: 0.5;
      margin-left: auto;
    }
    #hira-task-overlay.rail-expanded .hira-rail-item__open {
      display: flex;
      align-items: center;
      justify-content: center;
    }
    .hira-rail-item__open svg {
      width: 8px;
      height: 8px;
      pointer-events: none;
    }
    #hira-task-overlay.rail-side-right.rail-expanded .hira-rail-item__open {
      transform: rotate(180deg);
    }
    #hira-task-overlay.rail-side-left.rail-expanded .hira-rail-item__header:hover .hira-rail-item__open {
      transform: translateX(2px);
    }
    #hira-task-overlay.rail-side-right.rail-expanded .hira-rail-item__header:hover .hira-rail-item__open {
      transform: rotate(180deg) translateX(2px);
    }
    #hira-task-overlay.rail-expanded .hira-rail-item__header:hover .hira-rail-item__open,
    #hira-task-overlay.rail-expanded .hira-rail-item.active .hira-rail-item__open {
      opacity: 1;
    }

    /* 横向：间距从"下边距"换成"右边距"（主轴换了一维，其它一律不动）。 */
    #hira-task-overlay.rail-horizontal .hira-rail-item {
      margin-bottom: 0;
      margin-right: ${RAIL_GAP}px;
    }

    .hira-rail-item:hover {
      /* 悬停只给底色（图标已是 UI 前景，再"提亮"就没有可提的了）——
         这样"图标颜色 = 前景色旋钮"这条不变量在悬停时也不会被打破。 */
      background: var(--hira-hover-bg, rgba(0,0,0,0.05));
    }

    /* 按下反馈：与导航栏按钮同一套语言 —— 轻微内缩 + 短促复位。
       只做 :active（按下），不碰 :hover —— 悬停位移/缩放会让人误以为图标在动。 */
    .hira-rail-item:active {
      transform: scale(0.94);
    }

    .hira-rail-item.active {
      background: var(--hira-accent-bg, rgba(99, 102, 241, 0.15));
      color: var(--hira-accent, #818cf8);
    }
    .hira-rail-item.active .hira-rail-item__label {
      color: inherit;
    }
    #hira-task-overlay.rail-expanded .hira-rail-item,
    #hira-task-overlay.rail-expanded .hira-rail-item:hover,
    #hira-task-overlay.rail-expanded .hira-rail-item.active {
      background: transparent;
    }
    #hira-task-overlay.rail-expanded .hira-rail-item:active {
      transform: none;
    }
    #hira-task-overlay.rail-expanded .hira-rail-item__header:hover {
      background: var(--hira-hover-bg, rgba(0, 0, 0, 0.05));
    }
    #hira-task-overlay.rail-expanded .hira-rail-item.active .hira-rail-item__header {
      background: var(--hira-accent-bg, rgba(99, 102, 241, 0.15));
      color: var(--hira-accent, #818cf8);
    }
    #hira-task-overlay.rail-expanded .hira-rail-item.active .hira-rail-item__label {
      color: inherit;
    }
    #hira-task-overlay.rail-expanded .hira-rail-item__header:active {
      transform: scale(0.985);
    }

    /* 红点（未读 / 进行中这类"该看一眼"的静态提示，由编排层 setBadge 挂 class）。
       只画一个 ::after 小圆点：不新增元素、不参与布局（absolute）、不带动画/过渡 ——
       稳态下它只是这笔绘制，收起/展开 rail 时也不会引起 reflow。 */
    .hira-rail-item.has-badge::after {
      content: '';
      position: absolute;
      top: 4px;
      right: 4px;
      width: 7px;
      height: 7px;
      border-radius: 50%;
      background: var(--hira-badge-bg, #e5484d);
      /* 一圈极淡的暗边：浅色主题的 toolbar 上红点也不至于糊成一团。 */
      box-shadow: 0 0 0 1px rgba(0, 0, 0, 0.18);
      pointer-events: none;
    }

    /* 系统级「减少动态效果」：让位 */
    @media (prefers-reduced-motion: reduce) {
      .hira-rail-item:active { transform: none; }
      #hira-task-overlay.rail-icons-settling .hira-rail-item__icon {
        animation: none;
        will-change: auto;
      }
    }

    .hira-rail-item__icon svg {
      width: 17px;
      height: 17px;
      pointer-events: none;
    }
    /* 刻意不写 fill：Lucide 描边图标的 fill="none" 是 SVG 属性，CSS fill 会覆盖它，
       把描边图标变成实心色块。颜色统一由图标自身的 stroke="currentColor" 控制。 */

    /* 分区头：一条可点的分隔线（两边细线 + 中央小箭头），用来把一列 rail 分成几段
       —— 例如「面板按钮区」与「书签固定区」。整行都是点击目标（rail 只有 30 多像素宽，
       只让中央那个 10px 的箭头可点会很难命中）。 */
    .hira-rail-section {
      width: 100%;
      height: 16px;
      display: flex;
      align-items: center;
      gap: 3px;
      padding: 0 6px;
      margin: 5px 0 3px;
      cursor: pointer;
      /* 直系块不参与压缩（见 #hira-task-overlay 的 ②）：
         16px 的分区头一旦被压成 0，整段结构就从视觉上"消失"了。 */
      flex: none;
      -webkit-app-region: no-drag;
      color: var(--hira-text-secondary, #6b7280);
      opacity: 0.55;
    }

    .hira-rail-section:hover {
      opacity: 1;
    }

    .hira-rail-section__line {
      flex: 1;
      height: 1px;
      background: currentColor;
      opacity: 0.35;
    }

    .hira-rail-section__chevron {
      flex: none;
      display: flex;
      align-items: center;
      justify-content: center;
    }

    .hira-rail-section__label {
      display: none;
      min-width: 0;
      overflow: hidden;
      font-size: 9px;
      font-weight: 400;
      line-height: 1;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    #hira-task-overlay.rail-expanded .hira-rail-section {
      height: 19px;
      gap: 5px;
      padding: 0 7px;
      margin: 2px 0;
      opacity: 0.82;
    }
    #hira-task-overlay.rail-expanded .hira-rail-section__line:first-child {
      flex: 0 0 12px;
    }
    #hira-task-overlay.rail-expanded .hira-rail-section__label {
      display: block;
      flex: 1;
    }

    .hira-rail-section.has-action {
      height: 16px;
      gap: 3px;
      padding: 0 6px;
      margin: 2px 0 3px;
      opacity: 0.55;
    }
    .hira-rail-section.has-action .hira-rail-item__icon,
    .hira-rail-section.has-action .hira-rail-item__open {
      display: none;
    }
    .hira-rail-section.has-action .hira-rail-item__icon {
      width: 19px;
      height: 19px;
    }
    .hira-rail-section.has-action .hira-rail-item__icon svg {
      width: 17px;
      height: 17px;
    }
    #hira-task-overlay.rail-expanded .hira-rail-section.has-action {
      height: auto;
      min-height: var(--hira-rail-item-min-height);
      justify-content: flex-start;
      gap: 5px;
      padding: var(--hira-rail-item-pad-y) var(--hira-rail-item-pad-x);
      margin: 1px 0;
      border-radius: var(--hira-radius-control, 7px);
      opacity: 1;
    }
    #hira-task-overlay.rail-expanded .hira-rail-section.has-action .hira-rail-item__icon {
      display: flex;
    }
    #hira-task-overlay.rail-expanded .hira-rail-section.has-action .hira-rail-section__line {
      display: none;
    }
    #hira-task-overlay.rail-expanded .hira-rail-section.has-action:hover {
      background: var(--hira-hover-bg, rgba(0, 0, 0, 0.05));
    }
    #hira-task-overlay.rail-expanded .hira-rail-section.has-action .hira-rail-section__label {
      font-size: 12px;
      line-height: 16px;
    }
    #hira-task-overlay.rail-expanded .hira-rail-section.has-action .hira-rail-item__open {
      display: flex;
    }

    /* 收起 = 箭头翻转成"朝下"（= "内容在线的下面，点它放下来"）：
       基础 SVG 本身朝上（展开中）。 */
    .hira-rail-section.is-collapsed .hira-rail-section__chevron {
      transform: rotate(180deg);
    }

    /* 横向：分区头从"一条横线"变成"一条竖线"（内容在它右边）。
       箭头方向同步转 90°：展开 = 朝左（点一下收回去），收起 = 朝右（点一下放出来）。
       方向语言与纵向逐字一致 —— 只是把"上/下"换成"左/右"。 */
    #hira-task-overlay.rail-horizontal .hira-rail-section {
      width: 16px;
      height: 100%;
      flex-direction: column;
      padding: 6px 0;
      margin: 0 5px 0 3px;
    }

    #hira-task-overlay.rail-horizontal .hira-rail-section__line {
      flex: 1;
      width: 1px;
      height: auto;
    }

    #hira-task-overlay.rail-horizontal .hira-rail-section__chevron {
      transform: rotate(-90deg);
    }

    #hira-task-overlay.rail-horizontal .hira-rail-section.is-collapsed .hira-rail-section__chevron {
      transform: rotate(90deg);
    }

    .hira-rail-spacer {
      flex: 1;
      /* 这一块空白的**唯一职责**现在是「拖窗口」（整列已让给滚动，见 #hira-task-overlay 的 ④）。
         内容超出时它被挤成 0 高 —— 那正是"没有空白可拖"的时候，行为自洽。 */
      -webkit-app-region: drag;
    }

    /* 拖拽插入指示线 —— 纵向那条 2px「定位条」，与纵向标签列（ui-common#tabRowList
       的 .tabrow-drop）**同款**：同一条强调色、同一套淡入淡出、同样"2px 压在行的边界线上"。
       整列只有**一条**（挪 top），不是每项各挂一条 —— 那样会同时亮两条。
       用 opacity 显隐 → 出现/消失能淡入淡出；display 切换是硬切。 */
    .hira-rail-drop {
      position: absolute;
      left: 5px;
      right: 5px;
      height: 2px;
      border-radius: 1px;
      background: var(--hira-accent, #818cf8);
      z-index: var(--hira-z-elevated); /* 拖拽落点指示线 = elevated */
      pointer-events: none;
      opacity: 0;
    }

    .hira-rail-drop--show { opacity: 1; }

    /* 横向：同一条指示线转成竖条（上下留边、宽 2px，落点由 JS 写 left）。 */
    #hira-task-overlay.rail-horizontal .hira-rail-drop {
      left: auto;
      right: auto;
      top: 5px;
      bottom: 5px;
      width: 2px;
      height: auto;
    }

    .hira-rail-drop.hira-rail-drop--pins {
      left: auto;
      right: auto;
      top: auto;
      bottom: auto;
      width: 2px;
      height: 26px;
    }

  `
  doc.head.appendChild(style)
}

/**
 * 面板图标解析（依赖注入）：组件自身零图标依赖，图标工厂经 options.icons 注入。
 * 三态优先级：面板显式 icon > 注入的 icons[panel.id] > null（跳过渲染，缺省形态由调用方决定）。
 * @param {Document} doc
 * @param {RailPanelDef} panel
 * @param {Record<string, Function>} icons
 * @returns {Element|null}
 */
function resolvePanelIcon(doc: Document, panel: RailPanelDef, icons: Record<string, RailIconFactory>): Element | null {
  if (panel.icon != null) {
    if (typeof panel.icon === 'string') {
      return resolveIcon(panel.icon, doc, { size: 18, fallback: false })
    }
    return panel.icon
  }
  const iconFn = icons[panel.id]
  return typeof iconFn === 'function' ? iconFn(doc, { size: 18 }) : null
}

/**
 * 创建 TaskOverlay（Rail 工具栏 + Week 16 交互）。
 * @param {Document} doc
 * @param {TaskOverlayOptions} options
 * @returns {{
 *   element: HTMLElement,
 *   setActive: (panelId: string|null) => void,
 *   setZenMode: (enabled: boolean) => void,
 *   setPanelWidth: (width: number) => void,
 *   setRailLayout: (layout: { position?: 'left'|'right'|'top'|'bottom', horizontalAlign?: 'left'|'right', verticalAlign?: 'top'|'bottom' }) => void,
 *   setPanels: (panels: RailPanelDef[]) => void,
 *   setItemsHidden: (hidden: boolean) => void,
 *   setDrawerOpen: (open: boolean) => void,
 *   getItemsZones: () => Array<{ key: string, axis: 'row'|'column', grow: string, rect: {x:number,y:number,width:number,height:number}, items: Array<{id:string,x:number,y:number,width:number,height:number}> }>
 * }}
 */
/**
 * 分区头里那个小箭头。**朝上 = 这一区正展开着**（点一下把它收上去）；
 * 收起时 CSS 翻转 180° → **朝下**（"内容在线的下面，点它放下来"）。
 *
 * 方向按**点击后会怎样**来读，而不是按"当前是什么状态"：
 * 用户瞟一眼箭头就知道按下去会发生什么，不必先判断这一区现在是开是关。
 */
const SECTION_CHEVRON_SVG =
  '<svg viewBox="0 0 12 12" width="10" height="10" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M3 7.5 6 4.5l3 3"/></svg>'
const RAIL_EXPAND_SVG =
  '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.45" stroke-linecap="round" stroke-linejoin="round"><path d="m6 3.75 4.25 4.25L6 12.25"/></svg>'
const RAIL_OPEN_SVG =
  '<svg viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="1.35" stroke-linecap="round" stroke-linejoin="round"><path d="m4.5 2.75 3.25 3.25L4.5 9.25"/></svg>'

export function createTaskOverlay(doc: Document, options: TaskOverlayOptions): TaskOverlayController {
  const {
    panels = [],
    icons = {},
    onTogglePanel,
    onOpenPanel,
    /**
     * 入口**意图**：指针进入 / 按下某一项。
     *
     * 与 `onTogglePanel` 严格分开：意图只是"可能要打开"，编排层可据此在后台预热
     *（面板关闭即销毁，冷启动开销不该全压在点击那一拍），但**绝不改变任何状态**。
     * 组件同样零知识 —— 它不理解"预热"，只把 id 交出去。
     * @type {((panelId: string) => void)|undefined}
     */
    onHoverPanel,
    getActivePanelId,
    onZenModeChange,
    zenMode = false,
    panelWidth = 320,
    railExpanded: initialRailExpanded = false,
    railWidth: initialRailWidth = RAIL_WIDTH_DEFAULT,
    onToggleRailExpanded,
    onRailWidthChange,
    actions = [],
    /**
     * 分区头被点击（收起 / 展开）。
     *
     * 折叠状态**不在本组件里**：组件只负责画，它不知道"书签固定区"是什么、也管不着用户的
     * 偏好。谁编排这个列表（rail 入口）谁决定折叠态，然后重新 `setPanels` 一次即可 ——
     * 与 `getActivePanelId` 同一口径（组件不持有业务状态）。
     */
    onToggleSection,
    /**
     * 某一项被右键（`{ x, y }` 是**本视图内**的指针坐标，主进程会补视图偏移）。
     *
     * 组件只上抛"哪个 id、在哪"，**不建菜单**：菜单内容属于业务（书签项与面板项
     * 各是一套），组件连"这是一条书签"都不知道。
     *
     * **返回真值才算"这次右键有人管"**，组件才 `preventDefault()` —— 于是没配菜单的项
     * 右键保持原样，不会留下一个"右键被吃掉、又什么都不弹"的洞。
     */
    onItemContextMenu,
    /**
     * 可拖动项（描述符 `draggable: true`）被拖到新位置后回调**新顺序**。
     *
     * 组件只管"拖到哪儿了"（几何），业务顺序与落库归编排层。回调收到的是
     * **只含可拖动项**的 id 数组（面板项 / 插件图标 / 分区头不参与，也不会出现在里面）。
     * 未提供时没有任何项可拖 —— 描述符带了 `draggable` 也不会生效。
     * @type {(orderedIds: string[]) => void}
     */
    onReorder,
    /** 抽屉初始是否展开（视图态；持久化归编排层）。 */
    drawerOpen: initialDrawerOpen = false,
    /** 抽屉开合回调 —— 编排层据此落 localStorage。 */
    onToggleDrawer
  } = options

  /**
   * rail 的**轴向**（'column' = 左右纵向；'row' = 上下横向）。
   *
   * 这两条是纯**视图事实**：轴（横 / 纵）+ 贴边端（头 / 尾）。"面板开在哪侧"
   * 不在这里解算 —— 那是 rail 编排层与主进程共用 resolveRailPanelSide 的事，
   * 组件拿到轴向就够了。所有几何（拖拽判定 / 投放框 / 指示线）都走同一个
   * `geo`，横竖只差"取哪个轴"，规则本身只有一份。
   */
  let railAxis: RailAxis = 'column'
  let railAlign: RailAlign = 'start'
  /** 轴向适配器：切换 setRailLayout 时整体替换，调用点不再各自判断 clientX/clientY。 */
  let geo = axisAdapter(railAxis)

  const container = doc.createElement('div')
  container.id = 'hira-task-overlay'

  function applyRailLayout() {
    const horizontal = railAxis === 'row'
    container.classList.toggle('rail-horizontal', horizontal)
    container.classList.toggle('rail-align-end', railAlign === 'end')
    geo = axisAdapter(railAxis)
  }
  applyRailLayout()

  /** @type {Map<string, HTMLElement>} panelId → rail item element */
  const railItems: Map<string, HTMLElement> = new Map<string, HTMLElement>()
  /**
   * 挂红点的项 id（视图态，**由编排层驱动**：本组件不认识"下载"这种业务）。
   *
   * 单独存一份 Set 而不是直接读 DOM class：`setPanels` 会重建整列，
   * 重建后的新元素必须能**复原**红点 —— 否则"下载中恰好插件启停一次，红点就没了"。
   * 开销上与 DOM 只差一次 Set 查找，重建时按 id 还原；steady state 仍然零成本。
   */
  const badgeIds = new Set<string>()
  /** 展开态里被用户手动折叠了真实子列表的面板 id。 */
  const collapsedDetailIds = new Set<string>()
  /** 抽屉项 id（本组件只用来划分两个投放区；归属真源在编排层的设置里）。 */
  const drawerIds = new Set<string>()
  /** 固定项 id（由条目的 `pinned` 元数据声明；几何上报给叠加编辑器单独排序）。 */
  const pinnedIds = new Set<string>()
  /** 抽屉展开状态（视图态，持久化归编排层）。 */
  let drawerOpen = !!initialDrawerOpen
  /** 当前是否呈现名称态（面板自动收起由编排层决定，组件只接收最终结果）。 */
  let railExpanded = !!initialRailExpanded
  /** 展开态目标宽度；拖动时逐帧更新，提交动作由编排层持久化。 */
  let railWidth = Number.isFinite(Number(initialRailWidth))
    ? Math.min(RAIL_WIDTH_MAX, Math.max(RAIL_WIDTH_MIN, Math.round(Number(initialRailWidth))))
    : RAIL_WIDTH_DEFAULT
  let railSide: 'left' | 'right' = 'left'

  const expanderSlot = doc.createElement('div')
  expanderSlot.className = 'hira-rail-expander-slot'
  const expanderTitle = doc.createElement('span')
  expanderTitle.className = 'hira-rail-expander-title'
  expanderTitle.textContent = '“他们假装努力和进步，而我开始少说多做”'
  expanderTitle.setAttribute('aria-hidden', 'true')
  const expander = doc.createElement('button')
  expander.type = 'button'
  expander.className = 'hira-rail-expander'
  expander.innerHTML = RAIL_EXPAND_SVG
  expanderSlot.append(expanderTitle, expander)
  container.appendChild(expanderSlot)

  const resizer = doc.createElement('div')
  resizer.className = 'hira-rail-resizer'
  resizer.setAttribute('role', 'separator')
  resizer.setAttribute('aria-orientation', 'vertical')
  resizer.setAttribute('aria-label', '调整工具侧栏宽度')
  container.appendChild(resizer)

  function applyRailWidth() {
    const next = Math.min(RAIL_WIDTH_MAX, Math.max(RAIL_WIDTH_MIN, Math.round(railWidth)))
    railWidth = next
    container.style.setProperty('--hira-rail-expanded-width', `${next}px`)
  }

  function applyRailExpansion() {
    const expanded = railExpanded && railAxis === 'column'
    const wasExpanded = container.classList.contains('rail-expanded')
    container.classList.toggle('rail-side-left', railSide === 'left')
    container.classList.toggle('rail-side-right', railSide === 'right')
    container.classList.remove('rail-icons-settling')
    container.classList.toggle('rail-expanded', expanded)
    if (!expanded && railAxis === 'column' && wasExpanded) container.classList.add('rail-icons-settling')
    const pointsLeft = railSide === 'right' ? !expanded : expanded
    const icon = expander.firstElementChild as SVGElement | null
    if (icon) icon.style.transform = pointsLeft ? 'rotate(180deg)' : ''
    expander.title = expanded ? '收起工具侧栏' : '展开工具侧栏'
    expander.setAttribute('aria-label', expander.title)
    expander.setAttribute('aria-expanded', expanded ? 'true' : 'false')
  }

  function setRailExpanded(expanded: boolean) {
    const next = !!expanded
    if (next === railExpanded) return
    railExpanded = next
    if (railExpanded) applyRailWidth()
    applyRailExpansion()
  }

  function setRailWidth(width: number) {
    const next = Number(width)
    railWidth = Number.isFinite(next) ? next : RAIL_WIDTH_DEFAULT
    applyRailWidth()
  }

  expander.addEventListener('click', () => {
    const next = !(railExpanded && railAxis === 'column')
    if (typeof onToggleRailExpanded === 'function') onToggleRailExpanded(next)
    else setRailExpanded(next)
  })

  let resizingRail = false
  let resizeStartX = 0
  let resizeStartWidth = 0
  let resizePointerId = -1

  function finishRailResize(committed: boolean) {
    if (!resizingRail) return
    resizingRail = false
    container.classList.remove('hira-rail-resizing')
    doc.body.style.removeProperty('cursor')
    doc.body.style.removeProperty('user-select')
    if (resizePointerId >= 0) {
      try { resizer.releasePointerCapture(resizePointerId) } catch (_) {}
    }
    resizePointerId = -1
    if (typeof onRailWidthChange === 'function') onRailWidthChange(railWidth, committed)
  }

  resizer.addEventListener('pointerdown', (event) => {
    if (!railExpanded || railAxis !== 'column' || event.button !== 0) return
    event.preventDefault()
    resizingRail = true
    resizeStartX = event.screenX
    resizeStartWidth = railWidth
    resizePointerId = event.pointerId
    container.classList.add('hira-rail-resizing')
    doc.body.style.cursor = 'col-resize'
    doc.body.style.userSelect = 'none'
    try { resizer.setPointerCapture(event.pointerId) } catch (_) {}
  })

  resizer.addEventListener('pointermove', (event) => {
    if (!resizingRail) return
    const delta = railSide === 'right'
      ? resizeStartX - event.screenX
      : event.screenX - resizeStartX
    setRailWidth(resizeStartWidth + delta)
    if (typeof onRailWidthChange === 'function') onRailWidthChange(railWidth, false)
  })

  resizer.addEventListener('pointerup', () => finishRailResize(true))
  resizer.addEventListener('pointercancel', () => finishRailResize(false))
  resizer.addEventListener('lostpointercapture', () => finishRailResize(true))

  applyRailWidth()
  applyRailExpansion()

  // 底部 spacer 先入容器：按钮项一律插在它之前，重建顺序才不会乱。
  const spacer = doc.createElement('div')
  spacer.className = 'hira-rail-spacer'
  container.appendChild(spacer)

  /**
   * 拖拽插入指示线（整列**只有一条**：挪 `top`，不是每个项各挂一条）。
   *
   * 绝对定位挂在本容器上 —— 容器是 `position: fixed`，所以它的定位基准就是容器自身，
   * `axisAdapter.indicatorOffset` 吐出的"容器坐标系偏移"可以直接当 `top` 用。
   * 它是常驻元素、只切 `--show` 类：`rebuildItems` 按类名清理时不会波及它。
   */
  const dropIndicator = doc.createElement('div')
  dropIndicator.className = 'hira-rail-drop'
  container.appendChild(dropIndicator)

  /**
   * 按给定顺序（重）建图标列。
   * `list` 由编排层按 app.rail_buttons（可见顺序 + 抽屉归属）过滤/排序后给 —— 组件不认识设置。
   *
   * 抽屉**就地**建立：遇到第一个 `drawer: true` 的项时插入开关 + 分组，后续抽屉项进该分组。
   * 组件不再把抽屉钉在列尾 —— 位置完全由编排层给的顺序决定（例如它落在「书签固定区」之上）。
   * 全部落在 `spacer` 之前（底部动作按钮不吃这一列的顺序）。
   * @param {Array<{id:string,title?:string,drawer?:boolean}>} list
   */
  function rebuildItems(list: RailPanelDef[]) {
    for (const el of railItems.values()) el.remove()
    railItems.clear()
    drawerIds.clear()
    pinnedIds.clear()
    // 分区头**不进 railItems**：它不是可点击开合的面板，不该参与活动态、拖拽排序与
    // 按钮编辑浮层的清单（那三处都只认 railItems）。所以单独按类名清理。
    // 抽屉开关同样是一条 `.hira-rail-section`（见 createDrawerToggle），一并清掉。
    for (const el of container.querySelectorAll('.hira-rail-section')) el.remove()
    for (const el of container.querySelectorAll('.hira-rail-drawer')) el.remove()
    for (const el of container.querySelectorAll('.hira-rail-pins')) el.remove()
    for (const el of container.querySelectorAll('.hira-rail-compact')) el.remove()

    /** 抽屉分组（遇到第一个抽屉项时才建；null = 这一列没有抽屉项）。 */
    let drawerGroup: HTMLElement | null = null
    /** 固定书签区：始终以图标网格呈现，不进入名称态的大行布局。 */
    let pinsGroup: HTMLElement | null = null
    /** 无详情项：展开态两列，收起态仍是普通纵向图标。 */
    let compactGroup: HTMLElement | null = null
    for (const panel of list) {
      /**
       * 分区头：一条带可点箭头的分隔线，用来把一列 rail 切成几段
       *（例如"面板按钮区" 与 "书签固定区"）。`collapsed` 由编排层给 —— 见 onToggleSection。
       */
      if (panel && panel.kind === 'section') {
        const head = doc.createElement('div')
        head.className = 'hira-rail-section' + (panel.collapsed ? ' is-collapsed' : '')
        head.dataset.sectionId = panel.id
        head.title = panel.actionPanelId
          ? `打开${panel.title || ''}面板`
          : `${panel.collapsed ? '展开' : '收起'}${panel.title || ''}`
        const lineL = doc.createElement('span')
        lineL.className = 'hira-rail-section__line'
        const chevron = doc.createElement('span')
        chevron.className = 'hira-rail-section__chevron'
        chevron.innerHTML = SECTION_CHEVRON_SVG
        const label = doc.createElement('span')
        label.className = 'hira-rail-section__label'
        label.textContent = panel.title || ''
        const lineR = doc.createElement('span')
        lineR.className = 'hira-rail-section__line'
        if (panel.actionPanelId) {
          head.classList.add('has-action')
          const iconHost = doc.createElement('span')
          iconHost.className = 'hira-rail-item__icon'
          const icon = resolvePanelIcon(doc, panel, icons)
          if (icon) iconHost.appendChild(icon)
          const openArrow = doc.createElement('span')
          openArrow.className = 'hira-rail-item__open'
          openArrow.innerHTML = RAIL_OPEN_SVG
          head.append(lineL, chevron, iconHost, label, openArrow, lineR)
          head.setAttribute('role', 'button')
          head.tabIndex = 0
          chevron.setAttribute('role', 'button')
          chevron.tabIndex = 0
          chevron.title = panel.collapsed ? '展开固定书签' : '收起固定书签'
          const toggleSection = () => {
            if (typeof onToggleSection === 'function') onToggleSection(panel.id)
          }
          chevron.addEventListener('click', (event) => {
            event.stopPropagation()
            toggleSection()
          })
          chevron.addEventListener('keydown', (event) => {
            if (event.key !== 'Enter' && event.key !== ' ') return
            event.preventDefault()
            event.stopPropagation()
            toggleSection()
          })
          head.addEventListener('click', () => {
            if (typeof onOpenPanel === 'function') {
              onOpenPanel(panel.actionPanelId as string)
              return
            }
            onTogglePanel?.(panel.actionPanelId as string, {
              shiftKey: false, ctrlKey: false, metaKey: false, altKey: false
            })
          })
          head.addEventListener('keydown', (event) => {
            if (event.key !== 'Enter' && event.key !== ' ') return
            event.preventDefault()
            head.click()
          })
        } else {
          head.append(lineL, label, chevron, lineR)
          // 整行都是点击目标：rail 只有 30 多像素宽，让用户去点中央那个 10px 箭头太难命中。
          head.addEventListener('click', () => {
            if (typeof onToggleSection === 'function') onToggleSection(panel.id)
          })
        }
        container.insertBefore(head, spacer)
        pinsGroup = null
        compactGroup = null
        continue
      }
      if (panel.drawer) {
        if (!drawerGroup) {
          container.insertBefore(createDrawerToggle(), spacer)
          drawerGroup = doc.createElement('div')
          drawerGroup.className = 'hira-rail-drawer'
          container.insertBefore(drawerGroup, spacer)
        }
        drawerIds.add(panel.id)
        drawerGroup.appendChild(createRailItem(panel))
        pinsGroup = null
        compactGroup = null
        continue
      }
      if (panel.pinned) {
        if (!pinsGroup) {
          pinsGroup = doc.createElement('div')
          pinsGroup.className = 'hira-rail-pins'
          container.insertBefore(pinsGroup, spacer)
        }
        pinsGroup.appendChild(createRailItem(panel))
        compactGroup = null
        continue
      }
      pinsGroup = null
      if (panelHasDetails(panel)) {
        compactGroup = null
        container.insertBefore(createRailItem(panel), spacer)
      } else {
        if (!compactGroup) {
          compactGroup = doc.createElement('div')
          compactGroup.className = 'hira-rail-compact'
          container.insertBefore(compactGroup, spacer)
        }
        compactGroup.appendChild(createRailItem(panel))
      }
    }

    applyDrawerState()
    if (typeof getActivePanelId === 'function') setActive(getActivePanelId())
  }

  function panelHasDetails(panel: RailPanelDef): boolean {
    if (panel.detailsView instanceof HTMLElement) return true
    return Array.isArray(panel.details) && panel.details.some((detail) => String(detail?.label || '').trim())
  }

  /** 单个 rail 图标项（常驻与抽屉共用同一套外观 / 交互）。 */
  function createRailItem(panel: RailPanelDef): HTMLElement {
    const item = doc.createElement('div')
    item.className = 'hira-rail-item'
    if (panel.pinned) item.classList.add('hira-rail-pin')
    // 红点态在重建时复原（见 badgeIds 的说明）；steady state 只多一次 Set.has。
    if (badgeIds.has(panel.id)) item.classList.add('has-badge')
    item.dataset.panelId = panel.id

    const header = doc.createElement('div')
    header.className = 'hira-rail-item__header'
    header.title = panel.title || ''
    header.setAttribute('role', 'button')
    header.tabIndex = 0

    const disclosure = doc.createElement('button')
    disclosure.type = 'button'
    disclosure.className = 'hira-rail-item__disclosure'
    disclosure.innerHTML = SECTION_CHEVRON_SVG

    const iconHost = doc.createElement('span')
    iconHost.className = 'hira-rail-item__icon'
    const iconEl = resolvePanelIcon(doc, panel, icons)
    if (iconEl) iconHost.appendChild(iconEl)

    const content = doc.createElement('span')
    content.className = 'hira-rail-item__content'
    const label = doc.createElement('span')
    label.className = 'hira-rail-item__label'
    label.textContent = panel.title || panel.id
    content.appendChild(label)

    const details = Array.isArray(panel.details) ? panel.details.slice(0, 2) : []
    const detailsHost = doc.createElement('div')
    detailsHost.className = 'hira-rail-item__details'
    const iconOnlyDetails = panel.detailPresentation === 'icons'
    if (iconOnlyDetails) detailsHost.classList.add('is-icons')
    let renderedDetails = 0
    if (details.length > 0) {
      for (const detail of details) {
        const labelText = String(detail?.label == null ? '' : detail.label).trim()
        if (!labelText) continue
        const row = doc.createElement('button')
        row.type = 'button'
        row.className = 'hira-rail-item__detail'
        if (iconOnlyDetails) row.classList.add('is-icon-only')
        row.dataset.detailId = String(detail.id || '')
        row.title = labelText
        row.setAttribute('aria-label', labelText)
        const metaText = String(detail?.meta == null ? '' : detail.meta).trim()
        const iconUrl = String(detail?.iconUrl == null ? '' : detail.iconUrl).trim() || metaText
        const iconHost = doc.createElement('span')
        iconHost.className = 'hira-rail-item__detail-icon'
        if (detail.iconSrc) {
          const image = doc.createElement('img')
          image.className = 'hira-rail-item__detail-file-icon'
          image.src = detail.iconSrc
          image.alt = ''
          iconHost.appendChild(image)
        } else if (detail.filename) {
          iconHost.appendChild(createFileIcon(doc, detail.filename, 16))
        } else if (detail.favicon || /^https?:\/\//i.test(iconUrl)) {
          iconHost.appendChild(createFaviconBadge(doc, detail.favicon || null, labelText, 16, iconUrl))
        } else {
          const fallback = resolvePanelIcon(doc, panel, icons)
          if (fallback) iconHost.appendChild(fallback)
        }
        if (iconOnlyDetails) {
          row.appendChild(iconHost)
        } else {
          const main = doc.createElement('span')
          main.className = 'hira-rail-item__detail-main'
          const title = doc.createElement('span')
          title.className = 'hira-rail-item__detail-title'
          title.textContent = labelText
          main.appendChild(title)
          if (metaText) {
            const meta = doc.createElement('span')
            meta.className = 'hira-rail-item__detail-meta'
            meta.textContent = metaText
            main.appendChild(meta)
          }
          row.append(iconHost, main)
          const statusText = String(detail?.status == null ? '' : detail.status).trim()
          if (statusText) {
            const status = doc.createElement('span')
            status.className = 'hira-rail-item__detail-status'
            status.textContent = statusText
            row.appendChild(status)
          }
        }
        row.addEventListener('click', (event) => {
          event.stopPropagation()
          if (typeof detail.onActivate === 'function') {
            detail.onActivate({
              shiftKey: event.shiftKey,
              ctrlKey: event.ctrlKey,
              metaKey: event.metaKey,
              altKey: event.altKey
            })
          }
        })
        detailsHost.appendChild(row)
        renderedDetails += 1
      }
    }
    const customDetails = panel.detailsView instanceof HTMLElement ? panel.detailsView : null
    if (customDetails) {
      customDetails.classList.add('hira-rail-item__custom-details')
      detailsHost.appendChild(customDetails)
    }
    const hasDetails = renderedDetails > 0 || !!customDetails
    const detailsCollapsed = collapsedDetailIds.has(panel.id)
    item.classList.toggle('has-details', hasDetails)
    item.classList.toggle('is-details-open', hasDetails && !detailsCollapsed)
    item.classList.toggle('is-details-collapsed', hasDetails && detailsCollapsed)
    disclosure.title = detailsCollapsed ? '展开列表' : '收起列表'
    disclosure.setAttribute('aria-expanded', detailsCollapsed ? 'false' : 'true')
    disclosure.disabled = !hasDetails
    disclosure.addEventListener('click', (event) => {
      event.stopPropagation()
      const collapsed = item.classList.toggle('is-details-collapsed')
      item.classList.toggle('is-details-open', !collapsed)
      if (collapsed) collapsedDetailIds.add(panel.id)
      else collapsedDetailIds.delete(panel.id)
      disclosure.title = collapsed ? '展开列表' : '收起列表'
      disclosure.setAttribute('aria-expanded', collapsed ? 'false' : 'true')
    })

    const openArrow = doc.createElement('span')
    openArrow.className = 'hira-rail-item__open'
    openArrow.innerHTML = RAIL_OPEN_SVG
    header.append(disclosure, iconHost, content, openArrow)
    item.append(header, detailsHost)

    header.addEventListener('click', (e) => {
      if (typeof onTogglePanel !== 'function') return
      // 修饰键**原样上抛**（与书签栏那条口径一致）：本组件不认识"Ctrl 新标签 / Alt 转到已有"
      // 这类语义，它只把事实交出去 —— 去向与动作由编排层那份唯一规则定
      //（见 ui-common#resolveBookmarkOpenTarget / #openBookmarkTarget）。
      onTogglePanel(panel.id, {
        shiftKey: !!e.shiftKey, ctrlKey: !!e.ctrlKey, metaKey: !!e.metaKey, altKey: !!e.altKey
      })
    })
    header.addEventListener('keydown', (event) => {
      if (event.key !== 'Enter' && event.key !== ' ') return
      event.preventDefault()
      header.click()
    })

    // 意图预取：指针已经在图标上 = "下一拍就点它"。pointerdown 兜住不经悬停的快速点击
    //（触屏 / 鼠标一路扫过来直接按下）。去重、节流、TTL 全归编排层 —— 组件只上报事实。
    if (typeof onHoverPanel === 'function') {
      item.addEventListener('pointerenter', () => onHoverPanel(panel.id))
      item.addEventListener('pointerdown', () => onHoverPanel(panel.id), { passive: true })
    }

    /**
     * 右键：只上抛（哪个 id、在哪），菜单由编排层建 —— 组件不认识菜单内容，
     * 与 click 同一条口径。编排层**返回真值**（这次有人管）才阻止默认行为。
     */
    item.addEventListener('contextmenu', (e) => {
      if (typeof onItemContextMenu !== 'function') return
      if (!onItemContextMenu(panel.id, { x: e.clientX, y: e.clientY })) return
      e.preventDefault()
    })

    /**
     * 可拖动项：描述符声明 `draggable: true` **且**编排层给了 `onReorder`。
     *
     * 两个条件缺一不可 —— 只有 `onReorder` 而描述符没声明，等于"拖动后顺序没人接"，
     * 那就不该让它可以拖（否则松手时列表弹回原样，是"点了没反应"的另一种长相）。
     * `data-drag-id` 是拖拽期的身份：可拖动项整体构成**同一个顺序表**，
     * 面板项 / 插件图标 / 分区头都不带它，因此天生不参与。
     */
    if (panel.draggable && typeof onReorder === 'function') {
      item.draggable = true
      item.dataset.dragId = panel.id
    }

    railItems.set(panel.id, item)
    if (panel.pinned) pinnedIds.add(panel.id)
    return item
  }

  /**
   * 抽屉开关 —— 与分区头**同一套外观与交互**（两侧细线 + 中央小箭头，整行可点）。
   *
   * 收起态挂 `is-collapsed`：箭头翻转 180° 朝下（"内容在线的下面，点它放下来"），
   * 方向语言与「书签固定区」的分区头完全一致 —— 用户不必为抽屉再学一套。
   */
  function createDrawerToggle() {
    const toggle = doc.createElement('div')
    toggle.className = 'hira-rail-section hira-rail-drawer-toggle' + (drawerOpen ? '' : ' is-collapsed')
    toggle.dataset.drawerToggle = '1'
    toggle.title = drawerOpen ? '收起抽屉' : '展开抽屉'
    const lineL = doc.createElement('span')
    lineL.className = 'hira-rail-section__line'
    const chevron = doc.createElement('span')
    chevron.className = 'hira-rail-section__chevron'
    chevron.innerHTML = SECTION_CHEVRON_SVG
    const label = doc.createElement('span')
    label.className = 'hira-rail-section__label'
    label.textContent = '更多工具'
    const lineR = doc.createElement('span')
    lineR.className = 'hira-rail-section__line'
    toggle.append(lineL, label, chevron, lineR)
    toggle.addEventListener('click', () => {
      if (typeof onToggleDrawer === 'function') onToggleDrawer(!drawerOpen)
      else setDrawerOpen(!drawerOpen)
    })
    return toggle
  }

  function applyDrawerState() {
    container.classList.toggle('rail-drawer-open', drawerOpen)
    const toggle = container.querySelector<HTMLElement>('.hira-rail-drawer-toggle')
    if (!toggle) return
    toggle.classList.toggle('is-collapsed', !drawerOpen)
    toggle.title = drawerOpen ? '收起抽屉' : '展开抽屉'
  }

  /**
   * 抽屉开合（编排层在恢复持久化状态 / 进入按钮编辑时调用）。
   * @param {boolean} open
   */
  function setDrawerOpen(open: boolean) {
    const next = !!open
    if (next === drawerOpen) return
    drawerOpen = next
    applyDrawerState()
  }

  rebuildItems(panels)

  // ══════════════════════════════════════════════════════════════════════
  //  可拖动项的**轴向拖拽重排**（当前 = 「固定到 rail 的书签」）
  //
  //  手感与「侧栏标签列」**一字不差** —— 中点判定 / 首尾外推 / 指示线贴边
  //  都走同一份 `axisAdapter`，连"2px 的条压在行的边界线上"这个 -1 也同款。
  //  横竖的差异只剩 `geo` 取哪个轴（setRailLayout 时整体替换），规则只有一份；
  //  各写一遍 clientY/top/height 的结局必然是"标签列修好了、rail 还是坏的"。
  //
  //  ⚠ 监听挂 **document** 而不是容器：指针一旦越出图标项（rail 只有 33px 宽，
  //    稍微斜着拖就出去了），事件冒泡到的是容器的**兄弟**节点，挂容器上收不到 ——
  //    那正是"拖过头一点就失效"的成因（见 ui-common#dragRegion 的文件头）。
  // ══════════════════════════════════════════════════════════════════════

  const dragRegion = createDragRegionSuppressor(doc)
  /** 正在拖的项 id（空 = 没在拖）—— 所有 document 级监听的第一道闸门。 */
  let dragItemId = ''
  /** 指示线此刻指向的落点（`dragover` 写、`drop` 读）。 */
  let dropTargetId = ''
  let dropInsertAfter = false

  /** 全部可拖动项的 id，按**当前 DOM 顺序**（= 列表顺序）。 */
  function draggableIds(): string[] {
    return Array.from(container.querySelectorAll<HTMLElement>('.hira-rail-item[data-drag-id]'))
      .map((el) => el.getAttribute('data-drag-id'))
      .filter((id): id is string => Boolean(id))
  }

  function hideDropIndicator() {
    dropIndicator.classList.remove('hira-rail-drop--show', 'hira-rail-drop--pins')
    dropTargetId = ''
  }

  /**
   * 指针此刻压着**哪一条可拖动项** —— 拖放落点的唯一入口。
   *
   * 命中不到时按**整列贴边**兜底：拖过头一点点就落进下方的空白，返回 null 会
   * **同时**让指示条消失、让排序失败，而"拖过头"恰恰是拖拽的常态
   *（同浏览器：拖到列表外仍按边界插入，而不是整场作废）。
   */
  function draggableUnder(e: DragEvent): HTMLElement | null {
    const hit = e.target instanceof Element ? e.target : null
    if (hit) {
      const direct = hit.closest('.hira-rail-item[data-drag-id]')
      if (direct instanceof HTMLElement) return direct
      const pins = hit.closest('.hira-rail-pins')
      if (pins) {
        let nearest: HTMLElement | null = null
        let nearestDistance = Infinity
        for (const item of Array.from(pins.querySelectorAll<HTMLElement>('.hira-rail-item[data-drag-id]'))) {
          const rect = item.getBoundingClientRect()
          const dx = e.clientX - (rect.left + rect.width / 2)
          const dy = e.clientY - (rect.top + rect.height / 2)
          const distance = dx * dx + dy * dy
          if (distance < nearestDistance) {
            nearest = item
            nearestDistance = distance
          }
        }
        if (nearest) return nearest
      }
    }
    const items = Array.from(container.querySelectorAll<HTMLElement>('.hira-rail-item[data-drag-id]'))
    if (!items.length) return null
    // 首尾外推的规则共用 `pickEdge` —— 别再写一遍 y < first.top / y > last.bottom。
    const edge = geo.pickEdge(geo.pointerOf(e), items.map((el) => el.getBoundingClientRect()))
    return edge < 0 ? null : items[edge]
  }

  container.addEventListener('dragstart', (e) => {
    const dataTransfer = e.dataTransfer
    if (!dataTransfer) return
    const eventTarget = e.target instanceof Element ? e.target : null
    const el = eventTarget ? eventTarget.closest('.hira-rail-item[data-drag-id]') : null
    if (!el) return
    dragItemId = el.getAttribute('data-drag-id') || ''
    if (!dragItemId) return
    // 中和窗口拖拽区：rail 的**空白区**（.hira-rail-spacer）仍是 app-region: drag，
    // 指针一旦越出图标项，系统把它当非客户区处理，**连 dragover 都不派发** —— 必须拖拽一开始就中和。
    dragRegion.arm()
    dataTransfer.effectAllowed = 'move'
    // 私有 MIME：避免别的区域（网页 / 其它 drop 目标）把这次拖放当文本接走。
    try { dataTransfer.setData('application/x-ng-rail-pin', dragItemId) } catch (_) {}
  })

  // 取消 dragenter 才算把 document 认成合法落点（Chromium 的判据）。
  doc.addEventListener('dragenter', (e) => {
    if (!dragItemId) return
    e.preventDefault()
  })

  doc.addEventListener('dragover', (e) => {
    if (!dragItemId) return
    e.preventDefault()
    if (e.dataTransfer) e.dataTransfer.dropEffect = 'move'
    const target = draggableUnder(e)
    if (!target) {
      hideDropIndicator()
      return
    }
    const targetId = target ? target.getAttribute('data-drag-id') || '' : ''
    // 压在自己身上 = 无操作（不是"落在最后一个"）
    if (!targetId || targetId === dragItemId) {
      hideDropIndicator()
      return
    }
    const rect = target.getBoundingClientRect()
    const pinnedTarget = !!target.closest('.hira-rail-pins')
    const insertAfter = pinnedTarget
      ? e.clientX >= rect.left + rect.width / 2
      : geo.isAfter(geo.pointerOf(e), rect)
    dropTargetId = targetId
    dropInsertAfter = insertAfter
    dropIndicator.classList.add('hira-rail-drop--show')
    dropIndicator.classList.toggle('hira-rail-drop--pins', pinnedTarget)
    if (pinnedTarget) {
      const containerRect = container.getBoundingClientRect()
      const offsetX = (insertAfter ? rect.right : rect.left) - containerRect.left + container.scrollLeft
      const offsetY = rect.top - containerRect.top + container.scrollTop + (rect.height - 26) / 2
      dropIndicator.style.left = `${Math.round(offsetX) - 1}px`
      dropIndicator.style.top = `${Math.round(offsetY)}px`
      return
    }
    // indicatorOffset 给的是**容器坐标系**里的偏移；-1 让 2px 的条压在行的边界线上。
    // 本列是滚动容器（窗口一矮 / 横向一窄就要滚）：getBoundingClientRect 量到的是
    // **视口**坐标，而绝对定位的指示线随内容滚动 —— 必须补上滚动偏移才是内容坐标
    //（axisAdapter#indicatorOffset 的注释明确要求滚动容器这样做）。
    // 轴向决定这条偏移写在哪个属性上（纵向 top / 横向 left），另一条清空以免残留旧值。
    const offset = geo.indicatorOffset(rect, container.getBoundingClientRect(), insertAfter) - 1
    if (geo.axis === 'row') {
      dropIndicator.style.top = ''
      dropIndicator.style.left = `${offset + container.scrollLeft}px`
    } else {
      dropIndicator.style.left = ''
      dropIndicator.style.top = `${offset + container.scrollTop}px`
    }
  })

  doc.addEventListener('drop', (e) => {
    if (!dragItemId) return
    e.preventDefault()
    // 先取落点再收指示线（`hideDropIndicator` 会把它们清空）
    const draggedId = dragItemId
    const targetId = dropTargetId
    const insertAfter = dropInsertAfter
    dragRegion.disarm()
    hideDropIndicator()
    dragItemId = ''
    if (!targetId || targetId === draggedId) return
    // 新顺序 = 当前顺序里抽掉被拖的那条，再插到目标项的前/后。
    // ⚠ 用**抽掉之后**的数组取 indexOf：被拖项原在目标项之前时，抽掉会让下标整体前移，
    //    拿旧下标去 splice 会插错一位（表现为"拖到相邻位置却没动"或反向）。
    const next = draggableIds().filter((id) => id !== draggedId)
    const at = next.indexOf(targetId)
    if (at < 0) return
    next.splice(insertAfter ? at + 1 : at, 0, draggedId)
    if (typeof onReorder === 'function') onReorder(next)
  })

  // 兜底收尾：拖到别处松手 / Esc 取消时 `drop` 不会来，`dragend` 一定来。
  // 中和类若留在根元素上会让整个视图再也拖不动，必须保证摘掉。
  doc.addEventListener('dragend', () => {
    dragRegion.disarm()
    hideDropIndicator()
    dragItemId = ''
  })

  /**
   * **动作按钮**（可选）：与"面板项"不同 —— 它们不是一个可开关的面板，而是"做一件事"
   *（例如"把当前页加为网页面板"）。渲染在 `spacer` **之后**（= 贴着底部）：
   *   · 不打乱上方面板项的次序（面板项一律插在 spacer **之前**）；
   *   · 不参与面板项的任何状态（活动态 / 拖拽排序 / 按钮编辑浮层的显隐清单）。
   *
   * `action.icon` 允许两种形态：图标**名字符串**（走注入的 `icons` 表，与面板项同一口径）
   * 或**图标构造器**（宿主直接给 —— 动作按钮不属于面板目录，图省事不必先进图标表）。
   *
   * @type {Map<string, HTMLElement>} actionId → element
   */
  const actionItems: Map<string, HTMLElement> = new Map<string, HTMLElement>()
  function rebuildActions(list: RailActionDef[]) {
    for (const el of actionItems.values()) el.remove()
    actionItems.clear()
    for (const action of Array.isArray(list) ? list : []) {
      if (!action || !action.id) continue
      const item = doc.createElement('div')
      // 复用面板项的外观与 hover（同一套 `.hira-rail-item` 样式）
      item.className = 'hira-rail-item hira-rail-action'
      item.dataset.actionId = String(action.id)
      const header = doc.createElement('div')
      header.className = 'hira-rail-item__header'
      header.title = action.title || ''
      header.setAttribute('role', 'button')
      header.tabIndex = 0
      const iconHost = doc.createElement('span')
      iconHost.className = 'hira-rail-item__icon'
      const actionIcon = action.icon
      const iconEl = typeof actionIcon === 'function'
        ? actionIcon(doc, { size: 14 })
        : resolvePanelIcon(doc, { id: String(action.id), icon: actionIcon }, icons)
      if (iconEl) iconHost.appendChild(iconEl)
      const content = doc.createElement('span')
      content.className = 'hira-rail-item__content'
      const label = doc.createElement('span')
      label.className = 'hira-rail-item__label'
      label.textContent = action.title || String(action.id)
      content.appendChild(label)
      const openArrow = doc.createElement('span')
      openArrow.className = 'hira-rail-item__open'
      openArrow.innerHTML = RAIL_OPEN_SVG
      header.append(iconHost, content, openArrow)
      item.appendChild(header)
      const onActivate = action.onActivate
      header.addEventListener('click', () => {
        if (onActivate) onActivate()
      })
      header.addEventListener('keydown', (event) => {
        if (event.key !== 'Enter' && event.key !== ' ') return
        event.preventDefault()
        if (onActivate) onActivate()
      })
      actionItems.set(String(action.id), item)
      container.appendChild(item)
    }
  }
  rebuildActions(actions)

  // ── 面板宽度拖拽手柄已迁出本组件 ──
  // 原因：本组件渲染在 rail 的 WebContentsView 内，而 rail view 只有 RAIL_BAR_SIZE(44px) 厚。
  // 手柄需要出现在「面板右边缘」（44 + panelWidth 处），一旦定位过去就落在 view 之外被裁剪，
  // 既看不见也点不到，且第一次拖拽后 mousemove/mouseup 全部丢失（表现为「只能调一次」）。
  // 现由面板渲染进程自己承担（它的 view 宽度就是面板宽度，天然贴边）。
  // 本组件只保留「面板宽度」这一份状态，供布局换算使用。
  container.dataset.panelWidth = String(panelWidth)

  // ── Zen mode 支持 ──
  let zenEnabled = zenMode
  let zenHoverTimer: ReturnType<typeof setTimeout> | null = null

  function applyZenMode() {
    container.classList.toggle('zen-collapsed', zenEnabled)
  }

  function clearZenHoverTimer() {
    if (zenHoverTimer) {
      clearTimeout(zenHoverTimer)
      zenHoverTimer = null
    }
  }

  // Zen mode 收起态：hover 1000ms 后展开
  container.addEventListener('mouseenter', () => {
    if (!zenEnabled) return
    clearZenHoverTimer()
    zenHoverTimer = setTimeout(() => {
      // 展开
      container.classList.remove('zen-collapsed')
    }, ZEN_HOVER_DELAY)
  })

  container.addEventListener('mouseleave', () => {
    clearZenHoverTimer()
    if (zenEnabled) {
      // 收起（无动画）
      container.classList.add('zen-collapsed')
    }
  })

  applyZenMode()

  /**
   * 设置活动面板高亮。
   * @param {string|null} panelId
   */
  function setActive(panelId: string | null) {
    for (const [id, el] of railItems) {
      el.classList.toggle('active', id === panelId)
    }
  }

  /**
   * 给某个 rail 项挂 / 摘红点（**幂等**：同值重复调用不碰 DOM）。
   *
   * 由编排层驱动（例如"下载进行中"→ `setBadge('downloads-panel', true)`），
   * 组件只认 id + 布尔，不认识任何业务。稳态代价 = 一次 Set.has 比较。
   * @param {string} panelId
   * @param {boolean} on
   */
  function setBadge(panelId: string, on: boolean) {
    const id = String(panelId || '')
    if (!id) return
    const next = !!on
    if (badgeIds.has(id) === next) return
    if (next) badgeIds.add(id)
    else badgeIds.delete(id)
    const el = railItems.get(id)
    if (el) el.classList.toggle('has-badge', next)
  }

  /**
   * 设置 Zen mode 状态。
   * @param {boolean} enabled
   */
  function setZenMode(enabled: boolean) {
    zenEnabled = enabled
    applyZenMode()
    if (typeof onZenModeChange === 'function') onZenModeChange(enabled)
  }

  /**
   * 设置面板宽度。
   * @param {number} width
   */
  function setPanelWidth(width: number) {
    container.dataset.panelWidth = String(width)
  }

  /**
   * 运行时切换 rail 的**轴向**与**按钮起始边**（设置热更新的唯一入口）。
   *
   * 只接收视图事实，不接收"面板开在哪侧"：
   *   · 横向（顶部 / 底部）时读 `horizontalAlign` —— 从左起 = start、从右起 = end；
   *   · 纵向（左侧 / 右侧）时读 `verticalAlign` —— 从上起 = start、从下起 = end。
   * 面板侧的判定是 `resolveRailPanelSide`（主进程 / 编排层共用），组件不重写一份。
   *
   * @param {{ position?: 'left'|'right'|'top'|'bottom', horizontalAlign?: 'left'|'right', verticalAlign?: 'top'|'bottom' }} [next]
   */
  function setRailLayout(next: RailLayout = {}) {
    const position = next.position === 'right' || next.position === 'top' || next.position === 'bottom'
      ? next.position
      : 'left'
    const nextSide = position === 'right' ? 'right' : 'left'
    const horizontal = position === 'top' || position === 'bottom'
    const axis = horizontal ? 'row' : 'column'
    const align = horizontal
      ? (next.horizontalAlign === 'right' ? 'end' : 'start')
      : (next.verticalAlign === 'bottom' ? 'end' : 'start')
    if (axis === railAxis && align === railAlign && nextSide === railSide) return
    railSide = nextSide
    railAxis = axis
    railAlign = align
    applyRailLayout()
    applyRailExpansion()
  }

  // 初始化活动状态
  if (typeof getActivePanelId === 'function') {
    setActive(getActivePanelId())
  }

  /**
   * 按新的可见顺序重建图标列（编排层读到 app.rail_buttons 变更时调用）。
   * @param {Array<{id:string,title?:string}>} list
   */
  function setPanels(list: RailPanelDef[]) {
    rebuildItems(Array.isArray(list) ? list : [])
  }

  /**
   * 按钮编辑模式开关：把图标列让位给编辑浮层（浮层按上报几何克隆这一列）。
   * @param {boolean} hidden
   */
  function setItemsHidden(hidden: boolean) {
    container.classList.toggle('buttons-editing', !!hidden)
  }

  /**
   * 测量一组图标项的投放区（**本 rail view 内坐标**；窗口偏移由主进程补）：
   *   · rect —— 投放区（浮层画的虚线框 = 它）；主轴方向**至少 `minSlots` 格**，多出来的是预留区。
   *   · items —— 当前可见图标的真实几何（浮层按它克隆，逐像素重合）。
   *   · grow  —— 新增图标朝哪边生长（= 预留区开在哪边）：横 `right`/`left`，纵 `down`/`up`。
   *   · axis  —— `'row'`（横向 rail）/ `'column'`（纵向 rail），供编辑浮层按同一轴克隆。
   * @param {string[]} ids
   * @param {number} [minSlots] 最小跨度（格）；常驻区与抽屉区各自一套（见文件头常量）
   * @returns {{ axis: 'row'|'column', grow: string, rect: {x:number,y:number,width:number,height:number}, items: Array<{id:string,x:number,y:number,width:number,height:number}> }|null}
   */
  function measureZone(ids: string[], minSlots: number = RAIL_MIN_SLOTS): RailItemsZone | null {
    const horizontal = geo.axis === 'row'
    const items: RailItemRect[] = []
    let left = Infinity, top = Infinity, right = -Infinity, bottom = -Infinity
    for (const id of ids) {
      const el = railItems.get(id)
      if (!el) continue
      const r = el.getBoundingClientRect()
      if (r.width === 0 && r.height === 0) continue
      items.push({
        id,
        x: Math.round(r.left),
        y: Math.round(r.top),
        width: Math.round(r.width),
        height: Math.round(r.height)
      })
      left = Math.min(left, r.left)
      top = Math.min(top, r.top)
      right = Math.max(right, r.right)
      bottom = Math.max(bottom, r.bottom)
    }
    if (items.length === 0) return null
    const slot = (horizontal ? items[0].width : items[0].height) || RAIL_SLOT
    let gap = RAIL_GAP
    if (items.length > 1) {
      const step = horizontal ? items[1].x - items[0].x : items[1].y - items[0].y
      if (step > 0) gap = Math.max(0, step - slot)
    }
    // 并集 + 最小跨度（并集本来更长时，最小跨度自然不起作用）
    const minSpan = slot * minSlots + gap * (minSlots - 1)
    const width = Math.round(right - left)
    const height = Math.round(bottom - top)
    // 预留区开在 `grow` 那一端：end（右 / 下起）时新图标朝头端长，
    // 所以框要从**尾端回推**原点，否则虚线框会越过按钮组的边界、和克隆对不上。
    const rectW = horizontal ? Math.max(width, minSpan) : width
    const rectH = horizontal ? height : Math.max(height, minSpan)
    const alignEnd = railAlign === 'end'
    return {
      axis: railAxis,
      grow: horizontal ? (alignEnd ? 'left' : 'right') : (alignEnd ? 'up' : 'down'),
      rect: {
        x: horizontal && alignEnd ? Math.round(right) - rectW : Math.round(left),
        y: !horizontal && alignEnd ? Math.round(bottom) - rectH : Math.round(top),
        width: rectW,
        height: rectH
      },
      items
    }
  }

  /**
   * 图标列的两个投放区（**本 rail view 内坐标**，主进程补窗口偏移）：
   *   · rail   —— 常驻区（抽屉块**之前**的图标）
   *   · drawer —— 抽屉区（`drawer: true` 的图标；空 / 收起时给兜底框，否则没处可放）
   *
   * 切分按 **DOM 顺序**，不是"取整列并集再按归属分"：抽屉可以落在这一列的中段
   *（编排层把它排在「书签固定区」之上）。若常驻区仍把抽屉下方的项并进来，
   * 两个框会互相压住 —— 命中永远落在靠前的常驻区，抽屉框就再也拖不进去了。
   *
   * 抽屉块**之后**的常驻项（当前 = 书签固定项）不参与任何投放框：它们不在
   * `app.rail_buttons` 的顺序里，编辑浮层也没有它们的克隆格，凭空画个框只会误导。
   * @returns {Array<{key:string, axis:'row'|'column', grow:string, rect:{x:number,y:number,width:number,height:number}, items:Array<{id:string,x:number,y:number,width:number,height:number}>}>}
   */
  function getItemsZones(): RailItemsZone[] {
    const railIds: string[] = []
    const drawer: string[] = []
    let seenDrawer = false
    for (const id of railItems.keys()) {
      if (drawerIds.has(id)) {
        drawer.push(id)
        seenDrawer = true
      } else if (!seenDrawer) {
        railIds.push(id)
      }
    }

    const cr = container.getBoundingClientRect()
    const style = getComputedStyle(container)
    const horizontal = geo.axis === 'row'
    const alignEnd = railAlign === 'end'
    // 主轴起点：纵向取 paddingTop、横向取 paddingLeft（两个轴都留了 8px 内边距）。
    const padStart = horizontal
      ? (parseFloat(style.paddingLeft) || 0)
      : (parseFloat(style.paddingTop) || 0)
    const padCrossStart = horizontal
      ? (parseFloat(style.paddingTop) || 0)
      : (parseFloat(style.paddingLeft) || 0)
    const padCrossEnd = horizontal
      ? (parseFloat(style.paddingBottom) || 0)
      : (parseFloat(style.paddingRight) || 0)
    const expandedVertical = !horizontal && railExpanded
    const crossSize = expandedVertical
      ? Math.max(RAIL_SLOT, Math.round(cr.width - padCrossStart - padCrossEnd))
      : RAIL_SLOT
    // 交叉轴上的图标起点：图标在 44px 宽 / 高的条里居中。
    const crossStart = Math.round(horizontal
      ? cr.top + Math.max(0, (cr.height - RAIL_SLOT) / 2)
      : (expandedVertical
          ? cr.left + padCrossStart
          : cr.left + Math.max(0, (cr.width - RAIL_SLOT) / 2)))
    const mainStart = Math.round((horizontal ? cr.left : cr.top) + padStart + 2)
    // 从尾端起排时（右 / 下起），兜底框也必须从**尾端**回推 —— 否则框会开在
    // 按钮组对面那一头，用户把按钮拖进去后它却"跳"到另一端。
    const padEnd = horizontal
      ? (parseFloat(style.paddingRight) || 0)
      : (parseFloat(style.paddingBottom) || 0)
    const mainEnd = Math.round((horizontal ? cr.right : cr.bottom) - padEnd - 2)
    /** n 格在主轴上的跨度（含间距）—— 两个区的兜底框共用同一条算式。 */
    const spanOf = (slots: number) => RAIL_SLOT * slots + RAIL_GAP * (slots - 1)
    const growOf = horizontal ? (alignEnd ? 'left' : 'right') : (alignEnd ? 'up' : 'down')

    /**
     * 兜底投放框（该区一个可见图标都没有）：开在另一区**外侧**（start 往尾端、end 往头端），
     * 于是两个框永不重叠 —— 另一区占着的那一段直接被跳过，剩下的永远是空白。
     */
    const fallbackRect = (other: RailItemsZone | null, slots: number) => {
      const span = spanOf(slots)
      if (horizontal) {
        const x = other
          ? (alignEnd ? other.rect.x - RAIL_GAP - span : other.rect.x + other.rect.width + RAIL_GAP)
          : (alignEnd ? mainEnd - span : mainStart)
        return { x: Math.round(x), y: crossStart, width: span, height: RAIL_SLOT }
      }
      const y = other
        ? (alignEnd ? other.rect.y - RAIL_GAP - span : other.rect.y + other.rect.height + RAIL_GAP)
        : (alignEnd ? mainEnd - span : mainStart)
      return { x: crossStart, y: Math.round(y), width: crossSize, height: span }
    }

    const drawerZone = measureZone(drawer, RAIL_DRAWER_MIN_SLOTS)
    // 常驻区一个图标都没有（全被拖进抽屉 / 抽屉还没开过）：兜底框开在抽屉区外侧，
    // 保证两个框永不重叠（抽屉那一段一定被开关和抽屉项占着）。
    const railZone: RailItemsZone = measureZone(railIds, RAIL_MIN_SLOTS) || {
      axis: railAxis,
      grow: growOf,
      rect: fallbackRect(drawerZone, RAIL_MIN_SLOTS),
      items: []
    }
    // 抽屉一个可见图标都没有（全被拖进编辑浮层 / 抽屉还是空的）：仍要给一个
    // 「能拖进来」的落点，否则第一次想把按钮放进抽屉时无处可放。
    const drawerFinal: RailItemsZone = drawerZone || {
      axis: railAxis,
      grow: growOf,
      rect: fallbackRect(railZone, RAIL_DRAWER_MIN_SLOTS),
      items: []
    }
    return [
      { key: 'rail', ...railZone },
      { key: 'drawer', ...drawerFinal }
    ]
  }

  /**
   * 固定书签区的独立投放框。
   *
   * 固定项不属于 `app.rail_buttons`，因此不能混进 rail / drawer 两个顺序表；
   * 编辑器把它们当成独立的 `rail-pins` surface，落点只产生书签固定顺序。
   */
  function getPinnedItemsZone(): RailItemsZone | null {
    if (!pinnedIds.size) return null
    return measureZone([...pinnedIds]) || null
  }

  return {
    element: container,
    setActive,
    setZenMode,
    setPanelWidth,
    setRailExpanded,
    setRailWidth,
    setRailLayout,
    setPanels,
    setItemsHidden,
    setDrawerOpen,
    setBadge,
    getItemsZones,
    getPinnedItemsZone
  }
}
