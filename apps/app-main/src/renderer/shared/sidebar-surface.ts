/**
 * **侧栏面板（sidebar surface）** —— 「一条侧栏长什么样」的唯一装配处。
 *
 * ── 它解决什么 ────────────────────────────────────────────────────────
 * 侧栏只有**一张装配图**，但有两种宿主（同一个函数造）：
 *   · 外壳视图里的侧栏 —— 常驻占位，或全功能型的悬停展开（同一条侧栏切宽、网页真让位）；
 *   · Edge 型悬停展开的**独立浮层** —— renderer/sidebar-float 用同一个装配，
 *     只是浮层由主进程摆几何、盖在网页上（网页不缩进、不重排）。
 * 形态判据只有计划里的 `revealOverlay` 一个（见 shared-types#planChromeLayout）：
 * true = 静止一条图标 rail + 展开覆盖网页的浮层；false = 同一块区域在 restWidth /
 * revealWidth 之间切宽。于是"侧栏长什么样"只在这里写一次，两种宿主不可能各画一套而漂移。
 *
 * ── 为什么它住在 apps 层而不是 ui-vertical-tabs ─────────────────────────
 * 骨架（四种槽 + 固定钮 + 把手 + 形态机）是 ui-vertical-tabs 的事，它**不认识**空间切换器、
 * 也不认识窗口控制按钮 —— 那两件来自别的包。把「谁住进哪个槽」写进骨架组件，
 * 就等于让骨架去 import 一堆与它无关的东西。所以：
 *   · ui-vertical-tabs   只开槽（pin / top / body / dock / bottom），零知识；
 *   · 本模块（apps 编排层）按同一个计划把内容摆进槽里 —— 它就是「侧栏的装配图」。
 *
 * ── 谁真的落在这些槽里 ────────────────────────────────────────────────
 *   · `pin`    ← 「固定 / 悬停展开」按钮（骨架造，但**不落自己的行**：由 ui-navbar
 *                 的侧栏分区把它安置在空间切换器**同一行**上（顺序在切换器之后，
 *                 由 CSS 的 auto margin 推到行尾靠右）；展开浮层里由本模块的宿主
 *                 直接 append 到顶槽 —— 两种布局都是「切换器在左、固定钮在最右」）
 *   · `top`    ← 空间切换器（Edge 型垂直标签下，导航栏块把它的胶囊搬进侧栏顶槽，
 *                 见 ui-navbar#row/sideColumnPlan）
 *   · `body`   ← 纵向标签列表（ui-common#createTabListHost，与面板**同一份实现**）
 *   · `dock`   ← 面板簇（**只有全功能侧栏**才借住进来；图标条折叠时永远是空的 ——
 *                 那是 ui-navbar#row/sideDock 的判定，本模块不开这一槽的内容）
 *   · `bottom` ← 窗口控制按钮（宿主为标签栏 / 纵排导航栏时落在这里，
 *                 见 ui-navbar#row/windowControlsPlacement 与 shared-types#windowControlsPlacementInSidebar）
 *
 * 那几件东西都是**导航栏块的节点**（同一个节点被搬来搬去：横排时住在导航栏行，
 * 纵排时借住到侧栏槽位）—— 于是本模块**不用**自己再造第二个实例，只把槽位交出去，
 * 让导航栏去搬（`mountSpaceSwitcher` / 注入 windowControls）。
 */

import { verticalTabsDefinition } from '@hira-ng/ui-vertical-tabs'
import { injectSpaceSwitcherStyles } from '@hira-ng/ui-space-switcher'
import { WINDOW_CONTROLS_CSS, type TabRowItem } from '@hira-ng/ui-common'

type TabRowMenuFactory = ReturnType<typeof import('./tab-row-menu.js').createTabRowMenuFactory>

const STYLE_ID = 'hira-sidebar-surface-styles'

/**
 * 侧栏面板所需的样式（幂等）。
 *
 * 骨架 / 标签行 / 滚动区的样式由 `verticalTabsDefinition.injectStyles` 带出；
 * 这里补两块**不属于骨架**的：空间切换器、窗口控制按钮簇（它们的节点由导航栏搬进槽里）。
 *
 * ⚠ 不能注入 `injectPanelStyles`：那是面板视图（独立 WebContentsView）的
 * html/body reset 与全局 button 底色，侧栏住在 chrome 视图里，注入会污染外壳。
 *
 * @param {Document} doc
 */
export function injectSidebarSurfaceStyles(doc: Document) {
  verticalTabsDefinition.injectStyles(doc)
  injectSpaceSwitcherStyles(doc)
  if (doc.getElementById(STYLE_ID)) return
  const style = doc.createElement('style')
  style.id = STYLE_ID
  style.textContent = `
    /* 窗口控制按钮簇：样式本体来自 ui-common（windowControls.ts），
       这里只补侧栏槽位里的两条版式（窄条下折行由骨架的 .vtabs__bottom 规则负责）。 */
    .vtabs__top .space-switcher { min-width: 0; }
    .vtabs__bottom .navbar-top-right-actions { gap: 0; }

    /* 图标条形态的行内留白、槽内边距、行左缩进**不在这里写** ——
       它们唯一住在骨架自己的样式里（ui-vertical-tabs/styles.js + ui-common 的
       .tabrow-row）。本文件是**装配图**，只在骨架没给出的地方补内容版式；
       一旦在这里再写一条 .vtabs .tabrow-row，它因为后注入而天然覆盖骨架值 ——
       两态对齐就会被两条同优先级的规则偷偷拉回旧口径（曾经就发生过：
       行左缩进被压回 3.5px，favicon 取色指示条直接压在图标上）。 */

    /* 图标条（data-collapsed）里只留空间图标、不留名字（56px 塞不下胶囊全文，
       硬塞只会溢出被裁）。触发器同时收一档左右内边距（8 → 4）：
       这一行现在是「固定钮 22 + 缝 2 + 切换器 22」，旧口径会顶到裁切。
       26px 高度不动 —— 与固定钮、窗控同一行同高。 */
    .vtabs[data-collapsed="true"] .space-switcher__name { display: none; }
    .vtabs[data-collapsed="true"] .space-switcher__trigger {
      max-width: 100%;
      padding: 0 4px;
    }

    /* 未折叠的侧栏（含**固定视图 / 展开浮层**）里名字**照常显示** ——
       用户口径：「固定视图、展开态应该正常显示 space name」。
       挤不下时由名字自己的 ellipsis 收尾（见 ui-space-switcher 的 .space-switcher__name），
       不再按宽度整条藏掉。触发器必须允许收缩到内容宽以下（min-width: 0），
       否则长名字会把固定钮顶出这一行。
       两个容器（同名 side-column，按切换器住哪决定用哪个）：
         · 侧栏骨架 .vtabs —— 切换器住侧栏顶部槽时（Edge 型 / 展开浮层）；
         · .navbar-side-header —— 全功能侧栏，切换器寄住在侧栏顶行。
       ⚠ 容器**不能**挂在 #chrome-side 上：那是玻璃带（backdrop-filter），
       container-type 的 layout containment 会让它成为 backdrop root、毛玻璃当场失效。 */
    .vtabs__top .space-switcher,
    .navbar-side-header .space-switcher { min-width: 0; }
    .space-switcher__trigger { min-width: 0; }

    @container side-column (max-width: 220px) {
      .space-switcher__trigger {
        max-width: 100%;
        /* 窄栏把左右留白收到 4px：这一行还住着窗控簇（三颗 28px）与固定钮，
           名字已经在用 ellipsis 收尾，白留的 8px 只会把固定钮挤出这一行。 */
        padding: 0 4px;
      }
    }

    /* 窗控簇在图标条里**三颗并排**（各占 1/3），不折成竖排 ——
       折成竖排会把这一行的高度从一行变成三行（3×38px），于是"图标条 → 展开"时
       下方整条列表（含「新建标签页」）凭空跳 76px。高度沿用 token，两态一致。
       图标也收一点：14.7px 宽的按钮里塞 16px 图标会溢出被裁。 */
    .vtabs[data-collapsed="true"] .vtabs__bottom .navbar-top-right-actions {
      width: 100%;
      gap: 0;
    }
    .vtabs[data-collapsed="true"] .vtabs__bottom .window-control-btn {
      flex: 1 1 0;
      width: auto;
      min-width: 0;
    }
    .vtabs[data-collapsed="true"] .vtabs__bottom .window-control-btn svg {
      width: 12px;
      height: 12px;
    }

    /* 侧栏内容区**整块**都不吃窗口拖拽区（所有可见性形态一样）—— 规则不在本文件，
       住骨架里（ui-vertical-tabs/styles.js 的 .vtabs 根，一条 no-drag 覆盖
       图标条 / 悬停唤出 / 常驻占位）。原因：drag 是非客户区，指针事件压根不进渲染进程，
       行内边距与行间缝隙一旦属于拖拽区，"点标签"就变成"拖窗口"。
       竖排模式拖窗口由顶栏承担。
       本文件刻意不再补写任何 -webkit-app-region：装配图只负责"槽里放什么"，
       拖拽面属于骨架自己的形态定义。 */

    /* 有浮层压在 chrome 拖拽带上时，侧栏内侧紧邻的图标条 / 面板要让出窗口拖拽区
       （本侧栏自己从来就没有 drag，不需要参与这件事）。判据不在这里：主进程按
       「浮层矩形 ∩ chrome 拖拽带」算出一个布尔（LayoutCoordinator 的 _chromeDragBands /
       _syncFloatDragGuard，经 window-chrome 广播 overlay:modal），
       各 chrome 图层统一按 ui-common 的 setOverlayDragSuppressed 切 html.hira-overlay-modal。 */
  `
  doc.head.appendChild(style)
  // 窗口控制按钮的样式与上面同一份来源（ui-common 的常量），挂在这里而不是
  // 让调用方各挂一次 —— "侧栏要哪几份样式"只在这里回答。
  const wc = doc.getElementById('hira-sidebar-surface-window-controls')
  if (!wc) {
    const el = doc.createElement('style')
    el.id = 'hira-sidebar-surface-window-controls'
    el.textContent = WINDOW_CONTROLS_CSS
    doc.head.appendChild(el)
  }
}

/**
 * 造一条侧栏（骨架 + 槽里的内容）。
 *
 * ⚠ 这里**不造**空间切换器 / 窗口控制按钮：那两件是导航栏的节点，由导航栏按落点规则
 * 搬进 `slots.top` / `slots.bottom`（见 ui-navbar#row/sideColumnPlan 与
 * #windowControlsPlacement）。本模块若也造一份，同一条侧栏里就会出现两个切换器。
 *
 * @param {Document} doc
 * @param {{
 *   tabs?: object,                       // 标签数据客户端（透传给列表）
 *   createTabRowMenu?: TabRowMenuFactory,
 *   menu?: object,
 *   previewOverlay?: object,
 *   labels?: object,
 *   autoSubscribe?: boolean,
 *   isActive?: () => boolean,             // 本宿主此刻是否在台上（隐藏期只落数据）
 *   widthRange?: { min?: number, max?: number, default?: number },
 *   onResizeStart?: () => void,            // 按住把手：冻结 hover 收起
 *   onResize?: (width: number) => void,   // 松手落库
 *   onResizeEnd?: () => void,              // 新宽度进入计划后释放冻结
 *   onTogglePin?: () => void              // 「固定 / 悬停展开」按钮点击
 * }} [ctx]
 * @returns {{
 *   element: HTMLElement,
 *   slots: { pin: HTMLElement, top: HTMLElement, body: HTMLElement, dock: HTMLElement, bottom: HTMLElement },
 *   setItems: (items: unknown[]) => void,
 *   flush: () => void,
 *   setSide: (side: 'left'|'right') => void,
 *   setCollapsed: (collapsed: boolean) => void,
 *   setPinned: (pinned: boolean) => void,
 *   dispose: () => void
 * }}
 */
export function createSidebarSurface(doc: Document, ctx: {
  tabs?: object,                       // 标签数据客户端（透传给列表）
  createTabRowMenu?: TabRowMenuFactory,
  menu?: object,
  previewOverlay?: object,
  labels?: object,
  autoSubscribe?: boolean,
  isActive?: () => boolean,             // 本宿主此刻是否在台上（隐藏期只落数据）
  widthRange?: { min?: number, max?: number, default?: number },
  onResizeStart?: () => void,            // 按住把手：冻结 hover 收起
  onResize?: (width: number) => void,   // 松手落库
  onResizeEnd?: () => void,              // 新宽度进入计划后释放冻结
  onTogglePin?: () => void              // 「固定 / 悬停展开」按钮点击
  onPermissionRequest?: (tabId: string) => void
} = {}) : {
  element: HTMLElement,
  slots: { pin: HTMLElement, top: HTMLElement, body: HTMLElement, dock: HTMLElement, bottom: HTMLElement },
  setItems: (items: readonly TabRowItem[]) => void,
  flush: () => void,
  setSide: (side: 'left'|'right') => void,
  setCollapsed: (collapsed: boolean) => void,
  setPinned: (pinned: boolean) => void,
  dispose: () => void
} {
  // 骨架 + 标签列表（列表由 ui-vertical-tabs 装进 slots.body，与面板同一份实现）。
  const vtabs = verticalTabsDefinition.mount(doc, ctx)

  /** 侧别决定分隔线画在哪条边、把手开在内缘哪一侧（骨架 CSS 认这个标记）。 */
  function setSide(side: 'left' | 'right') {
    const value = side === 'right' ? 'right' : 'left'
    if (vtabs.element.dataset.regionSide !== value) vtabs.element.dataset.regionSide = value
  }

  return {
    element: vtabs.element,
    slots: vtabs.slots,

    setItems: vtabs.setItems,
    flush: vtabs.flush,
    setSide,
    setCollapsed: vtabs.setCollapsed,
    setPinned: vtabs.setPinned,

    dispose() {
      vtabs.dispose()
    }
  }
}


