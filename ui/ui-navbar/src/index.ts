/**
 * @hira-ng/ui-navbar —— 外壳的两块：**标签栏块**与**导航栏块**（哑组件）。
 *
 * 这个文件只做**装配**：取块骨架 → 把各部件放进去 → 把部件能力拼成对外契约。
 * 每件事都有了自己的家：
 *
 *   components/chromeBlocks.ts        两块 + 四行的空容器骨架
 *   components/sideHeader.ts          侧栏标题行槽（纵排才有；空间切换器寄住）
 *   components/tabRowSlots.ts         标签栏专属两个槽（空间切换器 / 新建标签）
 *   components/actionButton.ts        通用动作按钮（跨部件复用的最小件）
 *   components/dragHandle.ts          窗口拖拽手柄
 *   components/windowControls.ts      最小化 / 最大化 / 关闭（只管造与「装给谁」）
 *   components/navCluster.ts          导航按钮簇（rail 固定按钮 + 后退/前进/刷新/主页）
 *   components/nav/railToggle.ts      rail 固定按钮（自身有按下态）
 *   components/omnibox.ts             地址栏 + 建议 + 站点身份按钮摆放 + 书签星 + 转到
 *   components/siteIdentity.ts        站点身份按钮（锁 / 地球 + 角标 + 规则圆点：哑件）
 *   components/bookmarkStar.ts        书签星（哑件：只渲染状态 + 上抛意图）
 *   components/panelButtons.ts        面板按钮 + 菜单按钮
 *   components/extActions.ts          固定扩展条（地址栏右侧、面板按钮之前）
 *   components/progressBar.ts         加载进度条
 *   toolbarRegistry.ts                按钮账本 + 投放区几何（编辑浮层契约）
 *   toolbar/ledger.ts                 账本：登记 / 顺序 / 显隐
 *   toolbar/zones.ts                  尺子：把按钮量成窗口坐标矩形
 *   rowBinding.ts                     行内顺序 / 宿主轴 / 侧栏槽 / 窗口按钮落点（**薄编排器**）
 *   row/rowForm.ts                    **形态事实**（轴 / 侧栏槽 / 侧别 / 单行 / 窗控宿主）—— 唯一一份
 *   row/tabRowLayout.ts               标签行内谁先谁后
 *   row/sideColumnPlan.ts             侧栏分区：空间切换器 / 拖拽手柄 / 新建标签的落点
 *   row/sideDock.ts                   面板簇的落点（借住侧栏底槽 / 回工具按钮行）
 *   row/windowControlsPlacement.ts    窗口控制按钮落点
 *   row/railButtonPlacement.ts        rail 固定按钮落点
 *   styles.ts                         样式注入（各部件自带 CSS 常量，这里汇总）
 *
 * 为什么必须这样拆：本组件曾经是一个千行文件 —— 拖拽手柄、地址栏、搜索建议、权限请求、
 * 内容拦截、书签星、面板按钮、进度条、rail 固定按钮、按钮编辑的段与投放区全挤在一起。
 * 现在是**加一个部件 = 加一个文件 + 这里一行 import + 一行挂载**，删掉一个部件同理 ——
 * 与插件的扩展姿势一致。
 *
 * 边界（一直没变，且更硬了）：
 *   · 不认识 IPC / 设置 / 标签数据：全部由 handlers 或外部 mount* 注入；
 *   · 不认识布局计划：只回答「你住横排还是纵排」「你贴哪一边」，形态由自己决定；
 *   · 两块互不相识：谁摆哪里由编排层按 shared-types 的摆放计划决定。
 */

import { catalogFor } from '@hira-ng/ui-common'
import { injectNavbarStyles } from './styles'
import { createChromeBlocks } from './components/chromeBlocks'
import { createTabRowSlots } from './components/tabRowSlots'
import { createDragHandle } from './components/dragHandle'
import { createWindowControls } from './components/windowControls'
import { createNavCluster } from './components/navCluster'
import { createOmnibox } from './components/omnibox'
import { createPanelCluster } from './components/panelButtons'
import { createExtensionActions } from './components/extActions'
import { createProgressBar } from './components/progressBar'
import { createToolbarRegistry } from './toolbarRegistry'
import { createRowBinding } from './rowBinding'
import type {
  NavbarController,
  NavbarHandlers,
  ToolbarCatalogEntry,
  ToolbarZone,
  WindowControls
} from './types'

/**
 * @param {Document} doc
 * @param {object} [handlers] 意图出口（全部可选；组件对它们零知识）
 * @param {(host:'tabbar'|'navbar'|'titlebar') => void} [handlers.mountWindowControls]
 * @param {boolean} [handlers.windowControlsEnabled]
 *   false = 本窗口由**系统**绘制窗口按钮（原生 WCO）→ 不自绘那一簇（见下方构造处）。
 *   缺省 true（自绘），因此所有既有调用方行为不变。
 * @param {(panelId: string) => void} [handlers.onPrepare]
 *   面板按钮的入口意图（指针进入 / 按下）—— 编排层据此预热面板；组件只上报 id。
 * @param {(entry: object, pos: {anchorRect: object, x: number, y: number}) => void} [handlers.onExtensionActivate]
 *   固定扩展的点击意图（开弹窗 / 选项页 / 管理页由编排层决定）。
 * @param {(entry: object, pos: {anchorRect: object, x: number, y: number}) => void} [handlers.onExtensionContextMenu]
 *   固定扩展的右键意图（编排层据此弹原生菜单）。
 */
export function createNavbar(doc: Document, handlers: NavbarHandlers = {}): NavbarController {
  // ── 块骨架（两块 + 四行；chrome 只是逻辑根，不挂 DOM）────────────────────
  const { tabRow, toolbar, sideHeader, actionsRow, bottomLeft, bottomCenter, bottomRight } = createChromeBlocks(doc)

  // ── 可编辑按钮登记表 ────────────────────────────────────────────────────
  // hosts / anchors / refs 是**可变引用对象**：登记表在「施加顺序」与「报投放区」时才读它们，
  // 因此可以先建表、后填容器 —— 否则部件构造期就要用登记表（useItem），形成构造次序上的死锁。
  const hosts: Record<string, HTMLElement> = {}
  const anchors: Record<string, HTMLElement> = {}
  const refs: Record<string, HTMLElement> = {}
  const registry = createToolbarRegistry({
    catalog: catalogFor('navbar') as ToolbarCatalogEntry[],
    hosts,
    anchors,
    refs
  })
  const useItem = <T extends HTMLElement>(id: string, el: T): T => registry.add(id, el)

  // ── 标签栏块 ────────────────────────────────────────────────────────────
  // 拖拽手柄先落在标签行（缺省位）；**真正的顺序由侧栏分区统一裁定** ——
  // 紧贴空间切换器前面、并跟着它换槽位（见 row/sideColumnPlan.ts#placeDragHandle）。
  // 这样任何模式下它都在（标签行不在台上时跟着切换器进侧栏），横排时也不会落到切换器后面。
  const dragHandle = createDragHandle(doc)
  tabRow.appendChild(dragHandle)

  const { workspace, workspaceSlot, addTabSlot, addTabBtn } = createTabRowSlots(doc, { onNewTab: handlers.onNewTab })
  tabRow.appendChild(workspaceSlot)
  tabRow.appendChild(addTabSlot)

  // 原生 WCO 窗口（系统在窗口右上角画最小化/最大化/关闭，Win11 带布局预览）**不自绘**
  // 三颗按钮 —— 由 app-shell 按 `navigator.windowControlsOverlay.visible` 判定后传入
  // `windowControlsEnabled:false`。no-op 对象保持对外契约形状（element / maxBtn /
  // placeInto / setVariant / setMaximized），各落点模块遇 null element 一律让位
  // （守卫见 row/windowControlsPlacement 与 row/tabRowLayout）。
  const windowControls: WindowControls = handlers.windowControlsEnabled === false
    ? { element: null, maxBtn: null, placeInto() {}, setVariant() {}, setMaximized() {} }
    : createWindowControls(doc, {
        onMinimize: handlers.onWindowMinimize,
        onMaximize: handlers.onWindowMaximize,
        onClose: handlers.onWindowClose
      })
  if (windowControls.element) tabRow.appendChild(windowControls.element)

  // ── 导航栏块：各部件 ────────────────────────────────────────────────────
  const navCluster = createNavCluster(doc, {
    handlers: {
      onToggleRail: handlers.onToggleRail,
      onBack: handlers.onBack,
      onForward: handlers.onForward,
      onReload: handlers.onReload,
      // 加载中时刷新键变成停止键 → 需要「中止加载」这条独立意图（见 navCluster 的形态表）
      onStop: handlers.onStop,
      onHome: handlers.onHome,
      // 后退 / 前进的修饰键与右键意图（组件只归类，语义由编排层决定）：
      //   onNavIntent({ direction:'back'|'forward', intent:'new-tab' })
      //   onNavContextMenu({ direction, x, y, anchor })
      onNavIntent: handlers.onNavIntent,
      onNavContextMenu: handlers.onNavContextMenu
    },
    useItem
  })
  bottomLeft.appendChild(navCluster.element)

  const omnibox = createOmnibox(doc, { handlers })
  bottomCenter.appendChild(omnibox.element)

  // 固定扩展条：Chrome 式位置 —— 地址栏右侧这一簇的**第一段**（面板按钮 / 菜单之前）。
  // 空列表时 hidden 不占位，所以未固定任何扩展的窗口与以前一模一样。
  const extensionActions = createExtensionActions(doc, {
    onActivate: handlers.onExtensionActivate,
    onContextMenu: handlers.onExtensionContextMenu
  })
  bottomRight.appendChild(extensionActions.element)

  const panelCluster = createPanelCluster(doc, {
    registry,
    onMenu: handlers.onMenu,
    onPrepare: handlers.onPrepare
  })
  bottomRight.appendChild(panelCluster.element)
  bottomRight.appendChild(panelCluster.menuBtn)

  const progressBar = createProgressBar(doc)
  // 进度条贴工具栏底边：工具栏在底部布局时，它自然落在窗口底缘。
  toolbar.appendChild(progressBar.element)

  // ── 填上登记表需要的容器引用 ────────────────────────────────────────────
  // nav / panel 两段可编辑；Profile 切换器固定在标签栏头部，不参与排序/显隐。
  // 地址栏整块（字段 + 锁 / 星 / PWA）
  // 是**固定装饰区**，不进账本、不给投放区（用户原话：omnibox 相关不可编辑）。
  hosts.nav = navCluster.element
  hosts.panel = bottomRight
  // 面板区空无一物时的投放区参照（菜单按钮永远在）
  refs.panel = panelCluster.menuBtn

  // ── 行内顺序 / 宿主绑定 ─────────────────────────────────────────────────
  const rowBinding = createRowBinding({
    tabRow,
    toolbar,
    sideHeader,
    actionsRow,
    bottomLeft,
    bottomRight,
    navCluster,
    addTabSlot,
    workspace: workspaceSlot,
    windowControls,
    dragHandle,
    menuBtn: panelCluster.menuBtn
  })
  // 初始侧边栏位置（决定 rail 固定按钮进左导航区还是右下区）
  rowBinding.setSidebarPosition(handlers.sidebarPosition || 'left')
  rowBinding.setRailPosition(handlers.railPosition || handlers.sidebarPosition || 'left')

  return {
    // 两个可被外部独立摆放的块（由编排层经 ui-chrome-layout#setBlock 登记）：
    // tabbar  = 标签栏块（拖拽手柄 / 空间切换器 / 标签条 / 新建标签 / 可选窗口控制按钮）
    // toolbar = 导航栏块（导航按钮 / 地址栏 / 面板按钮 / 菜单 / 进度条）
    tabbar: tabRow,
    toolbar,
    topRow: tabRow,
    workspace,
    topRight: windowControls.element,
    windowControls,
    addTabBtn,
    maxBtn: windowControls.maxBtn,
    bottomRow: toolbar,
    addressInput: omnibox.addressInput,
    panelButtons: panelCluster.element,
    searchBar: omnibox.searchBar,

    // ── 地址栏 ────────────────────────────────────────────────────────────
    setAddress: omnibox.setAddress,
    focusAddress: omnibox.focusAddress,
    releaseAddressFocus: omnibox.releaseAddressFocus,
    hideSuggestions: omnibox.hideSuggestions,
    refreshSuggestions: omnibox.refreshSuggestions,
    setBookmarkStar: omnibox.setBookmarkStar,
    setPwaInstallState: omnibox.setPwaInstallState,

    // ── 站点身份（聚合浮层入口）───────────────────────────────────────────
    // 按钮的点击意图由编排层经 handlers.onSiteInfo 接收（切换浮层）；
    // 这里只额外交出**锚点矩形**，让编排层把它随 display 上报给主进程。
    setSiteInfo: omnibox.setSiteInfo,
    getSiteInfoAnchorRect: omnibox.getSiteInfoAnchorRect,
    getSiteInfoElement: omnibox.getSiteInfoElement,

    // ── 固定扩展条（运行时内容，与可编辑按钮账本正交）────────────────────
    // 只吃 entries：`{ id, name, icon, state, detail }`；数据从哪来、点了干什么
    // 全由编排层决定（见 renderer/controllers/extensions-toolbar-controller）。
    extensionActions: extensionActions.element,
    renderExtensionActions: extensionActions.render,

    // ── 面板按钮（目录驱动）──────────────────────────────────────────────
    renderPanelButtons: panelCluster.render,
    /**
     * 面板按钮红点（幂等）。由编排层驱动，组件不认识具体业务
     *（例：下载进行中 → `setPanelBadge('downloads-panel', true)`）。
     */
    setPanelBadge: panelCluster.setBadge,
    setPanelButtonsEditing(active) {
      // 编辑模式是**外壳级**状态：可编辑按钮不保证住在同一个块里（纵排时面板簇
      // 借住到了标签栏块的 dock 槽），故判据打在 body 上而不是本块的容器上。
      doc.body.classList.toggle('hira-buttons-editing', !!active)
    },

    // ── 可编辑按钮的顺序 / 显隐 / 投放区（按钮编辑浮层的契约）──────────────
    applyToolbarOrder(visibleIds: string[] | null | undefined, segments: Record<string, string> | null | undefined) {
      const nextOrder = Array.isArray(visibleIds) ? visibleIds.slice() : []
      const nextSegments = segments && typeof segments === 'object' ? { ...segments } : {}
      registry.setOrder(nextOrder)
      registry.setSegments(nextSegments)
    },
    getToolbarZone(): ToolbarZone[] {
      return registry.zones()
    },

    // ── 空间切换器槽 ──────────────────────────────────────────────────────
    /**
     * 挂载空间切换器到预留的 #workspace-switcher 占位区。
     * navbar 只提供容器，组件实现由 @hira-ng/ui-space-switcher 提供（哑组件，零业务依赖）。
     */
    mountSpaceSwitcher(el: HTMLElement | null) {
      if (!el) return
      workspace.textContent = ''
      workspace.appendChild(el)
    },

    // ── 加载状态 ──────────────────────────────────────────────────────────
    setLoading: progressBar.setLoading,

    // ── 导航态（后退 / 前进可用性、刷新↔停止）─────────────────────────────
    // 增量 patch：编排层无条件按**标签投影**校正全部三态（切换标签即天然隔离），
    // 另外用 tab:loading 作快路径补"开始/结束加载"的即时反馈 —— 两者互不覆盖，
    // 见 navCluster#setNavState。
    setNavState: navCluster.setNavState,

    // ── 窗口控制按钮 / 窗口标题栏按钮状态 ──────────────────────────────────
    setMaximized: windowControls.setMaximized,

    // ── 行内顺序与宿主绑定（由 rowBinding 统一判定）───────────────────────
    mountTabbar: rowBinding.mountTabbar,
    setCompactLayout: rowBinding.setCompactLayout,
    setSidebarPosition: rowBinding.setSidebarPosition,
    setRailPosition: rowBinding.setRailPosition,
    setRailPinned: navCluster.setRailPinned,
    mountWindowControls: rowBinding.mountWindowControls,
    mountSideTabs: rowBinding.mountSideTabs,
    setHostAxis: rowBinding.setHostAxis
  }
}

export { injectNavbarStyles }
// 后退 / 前进的修饰键意图枚举 —— 属于**对外契约**（编排层按它分派"新标签"），
// 不能让调用方凭字符串字面量猜；语义判定（哪个键 = 哪个意图）仍在 navCluster 内。
export { NAV_INTENT } from './components/navCluster'
// 动作按钮是**跨部件复用的原子**（外壳里的导航 / 面板 / 菜单都用它）。PWA 应用窗的
// chrome 也属于"外壳"，必须用同一颗按钮 —— 否则又是两种尺寸、两套悬停。公开导出它，
// 而不是让外部深导入 components/（那会把内部目录结构变成事实契约）。
export { createActionButton, setActionButtonIcon, ACTION_BUTTON_CSS } from './components/actionButton'
export type {
  ActionButtonOptions,
  AnchoredPoint,
  BookmarkStarState,
  ExtensionActionEntry,
  HostAxis,
  IconOptions,
  IconRenderer,
  NavContextMenuPayload,
  NavIntentPayload,
  NavStatePatch,
  NavbarController,
  NavbarHandlers,
  NavigationDirection,
  NavigationIntent,
  PanelCatalogEntry,
  PanelToggleHandler,
  PopupAnchorRect,
  PwaInstallState,
  PwaInstallStatus,
  RailPosition,
  RectLike,
  SidePosition,
  SideSlots,
  SiteIdentityState,
  ToolbarCatalogEntry,
  ToolbarZone,
  ToolbarZoneItem,
  WindowControls,
  WindowControlsHost,
  WindowControlsVariant
} from './types'
