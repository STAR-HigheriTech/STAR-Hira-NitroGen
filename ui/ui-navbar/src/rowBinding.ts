/**
 * 行内顺序 / 宿主绑定 —— **薄编排器**：持有「本块此刻的形态事实」这一份，把五件落点判定
 * 按**固定顺序**重摆一遍。它自己不含任何判定。
 *
 * 五个落点模块各管一摊，互不相识（都只读同一份事实，见 row/rowForm.ts）：
 *   row/tabRowLayout.ts              标签行内谁先谁后（含单行模式、标签条后挂）
 *   row/sideColumnPlan.ts            侧栏分区：空间切换器（①标题行/顶部槽/行首）与新建标签（⑤行末）
 *   row/sideDock.ts                  面板簇（站点控制区）的落点（借住侧栏底槽 / 回工具按钮行）
 *   row/windowControlsPlacement.ts   窗口控制按钮的落点（宿主 × 宿主轴 × 侧栏槽位）
 *   row/railButtonPlacement.ts       rail 开关的落点（侧边栏左 / 右 × 宿主轴）
 *
 * ── 为什么要有这一层 ─────────────────────────────────────────────────────
 * 从前这些排布判定分别躺在构造、布局回调、侧栏切换三条路径上，每条路径各调一部分模块，
 * 于是「换布局后有一条路径忘了搬，按钮凭空消失」，而且最终 DOM 顺序取决于**哪条通知后到**
 * （不确定）。收敛到这里之后，每条路径都只是「改一个事实，然后重摆一次」：
 * 事实一份（form）、顺序一处（placements）、幂等由各模块自己保证。
 *
 * **加一个落点模块 = 加一个文件 + `placements` 里一行**（不必再去找第二条通知路径）。
 *
 * 本模块**不认识任何按钮的内部**（不知道 rail 开关怎么画图标），也不认识布局计划 ——
 * 只接收元素与几个事实。凡是「块内部的事」都由块自己回答。
 */

import { createRowForm } from './row/rowForm'
import { createTabRowLayout } from './row/tabRowLayout'
import { createSideColumnPlan } from './row/sideColumnPlan'
import { createSideDock } from './row/sideDock'
import { createWindowControlsPlacement } from './row/windowControlsPlacement'
import { createRailButtonPlacement } from './row/railButtonPlacement'
import type {
  HostAxis,
  NavClusterController,
  RailPosition,
  SideSlots,
  WindowControls
} from './types'

/**
 * @param {{
 *   tabRow: HTMLElement,
 *   toolbar: HTMLElement,
 *   sideHeader: HTMLElement,
 *   actionsRow: HTMLElement,
 *   bottomLeft: HTMLElement,
 *   bottomRight: HTMLElement,
 *   navCluster: { element: HTMLElement, railBtn: HTMLElement, setRailPosition: (position: 'left'|'right'|'top'|'bottom') => void },
 *   addTabSlot: HTMLElement,
 *   workspace: HTMLElement,
 *   windowControls: { element: HTMLElement, placeInto: (target: Node|null, at?: 'start'|'end') => void },
 *   dragHandle?: HTMLElement,
 *   menuBtn: HTMLElement
 * }} ctx
 * @returns {{
 *   mountTabbar: (el: HTMLElement|null) => void,
 *   setCompactLayout: (on: boolean) => void,
 *   setSidebarPosition: (position: string) => void,
 *   setRailPosition: (position: string) => void,
 *   mountWindowControls: (host: string) => void,
 *   mountSideTabs: (slots: { pin?: HTMLElement, top?: HTMLElement, dock?: HTMLElement, bottom?: HTMLElement }|null) => void,
 *   setHostAxis: (axis: 'row'|'column') => void
 * }}
 */
export function createRowBinding(ctx: {
  tabRow: HTMLElement
  toolbar: HTMLElement
  sideHeader: HTMLElement
  actionsRow: HTMLElement
  bottomLeft: HTMLElement
  bottomRight: HTMLElement
  navCluster: NavClusterController
  addTabSlot: HTMLElement
  workspace: HTMLElement
  windowControls: WindowControls
  dragHandle?: HTMLElement
  menuBtn: HTMLElement
}): {
  mountTabbar: (element: HTMLElement | null) => void
  setCompactLayout: (on: boolean) => void
  setSidebarPosition: (position: string) => void
  setRailPosition: (position: "left" | "right" | "top" | "bottom" | string) => void
  mountWindowControls: (host: string) => void
  mountSideTabs: (slots: SideSlots | null) => void
  setHostAxis: (axis: HostAxis) => void
} {
  const {
    tabRow, toolbar, sideHeader, actionsRow, bottomLeft, bottomRight, navCluster,
    addTabSlot, workspace, windowControls, menuBtn, dragHandle
  } = ctx

  /** 形态事实（**唯一一份**：本块住什么轴 / 侧栏槽位在不在 / 侧栏哪一侧 / 单行 / 窗控宿主）。 */
  const form = createRowForm()
  const tabRowLayout = createTabRowLayout({ tabRow, bottomLeft, navCluster, addTabSlot, windowControls, form })
  // dragHandle / navbarHost：拖拽手柄由**侧栏分区**统一落位 —— Edge 型借住导航栏最前
  // （navbarHost，即本行的导航簇容器），其余模式紧贴空间切换器前面。见 sideColumnPlan。
  const sideColumnPlan = createSideColumnPlan({
    tabRow, sideHeader, workspace, addTabSlot, dragHandle, navbarHost: bottomLeft, form
  })
  const sideDock = createSideDock({ actionsRow, bottomRight, form })
  const wcPlacement = createWindowControlsPlacement({
    tabRow,
    toolbar,
    sideHeader,
    bottomRight,
    windowControls,
    form,
    // 窗控落进标签行时会挤进那一行的既有顺序 —— 请标签行自己重施一次
    // （不去懂那一行的规矩，这是它与 tabRowLayout 之间唯一的缝）。
    refreshTabRow: () => tabRowLayout.place()
  })
  const railPlacement = createRailButtonPlacement({ navCluster, form })

  /**
   * **重摆的全部顺序**（唯一一处，确定不移 —— 从前它散在各模块的 setter 里，谁后到谁说了算）：
   *
   *   ① sideColumnPlan  侧栏分区（空间切换器 + 拖拽手柄）—— 它的「顶行最前那一组」是下面几件的参照；
   *   ② wcPlacement     窗控簇 —— 纵排时插到那一行最前 ⇒ 落在①的**外侧**（整列顶部从外到内：
   *                     窗控 → 手柄 → 切换器，见 docs/vertical-tabs-architecture.md §4.2 ①）；
   *   ③ sideDock        面板簇（可能借住到底槽）；
   *   ④ railPlacement   rail 开关 —— 靠右时要往 ③ 安置好的右下区里插队，故必须在 ③ 之后；
   *   ⑤ tabRowLayout    标签行内顺序 —— 可能被 ①② 动过，最后重施一次。
   */
  const placements = [sideColumnPlan, wcPlacement, sideDock, railPlacement, tabRowLayout]

  /** 重摆（幂等 —— 各模块都只动"目标位不对"的节点，目标位对时一次 DOM 都不动）。 */
  function replan() {
    for (const p of placements) p.place()
  }

  // **起点也要摆一次**：各 setter 都是"事实没变就不重摆"（幂等早退），而构造时那几个事实
  // 恰好都等于缺省值（横排 / 无槽 / 靠左 / 非单行 / 宿主标签栏）—— 若等编排层的第一次通告
  // 才摆，rail 开关这类"缺省形态下也要挪位"的件就会一直停在构造时的位置。
  replan()

  return {
    /**
     * 挂上标签条（由编排层经 ui-tabbar 造好后交过来；本块对它零知识）。
     * 这一件不进 placements 表：它不是"每次重摆都要做"的事，而是**一次注入**。
     */
    mountTabbar: tabRowLayout.mountTabbar,

    /**
     * 单行（精致）模式开关 —— 改事实，然后重摆。
     * @param {boolean} on
     */
    setCompactLayout(on: boolean) {
      if (form.setCompact(on)) replan()
    },

    /**
     * 侧边栏在左 / 在右 —— 改事实，然后重摆（rail 开关位置 + 箭头方向都在重摆里）。
     * @param {string} position
     */
    setSidebarPosition(position: string) {
      if (form.setSide(position)) replan()
    },

    /** rail 工具条自身方位（左 / 右 / 顶 / 底），与面板侧别分开。 */
    setRailPosition(position: string) {
      // 方位属于按钮自身状态，先同步再让旧的 rail 落点规则重摆。
      const next: RailPosition = position === 'right' || position === 'top' || position === 'bottom'
        ? position
        : 'left'
      navCluster.setRailPosition(next)
      if (form.setRailPosition(next)) replan()
    },


    /**
     * 窗口控制按钮的宿主块 —— 改事实，然后重摆。
     * @param {string} host
     */
    mountWindowControls(host: string) {
      if (form.setWindowControlsHost(host)) replan()
    },

    /**
     * 纵向宿主（侧栏）下的搬运 —— 标签栏块借出的槽位。
     *
     * 传 `null` = 回到横排：两件东西放回标签行、面板簇回到工具按钮行；窗口控制按钮也由同一个
     * 落点判定算出该回哪里（分头搬必然有路径漏掉，按钮就凭空消失）。
     * @param {{ pin?: HTMLElement, top?: HTMLElement, dock?: HTMLElement, bottom?: HTMLElement }|null} slots
     */
    mountSideTabs(slots: SideSlots | null) {
      if (form.setSlots(slots || null)) replan()
    },

    /**
     * 通告本块住的宿主轴 —— 改事实，然后重摆（五个模块同时看到新事实）。
     *
     * 顺序不再需要人工安排（从前要"先把面板簇安置好、再让 rail 开关落位"）：
     * 依赖关系写在 `placements` 那一行里，读一次就全知道。
     * @param {'row'|'column'} axis
     */
    setHostAxis(axis: HostAxis) {
      if (form.setAxis(axis)) replan()
    }
  }
}
