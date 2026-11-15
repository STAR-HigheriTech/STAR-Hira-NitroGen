/**
 * **侧栏底槽借位计划** —— 面板簇（站点控制区）的唯一落点判定。
 *
 * 这也是它存在的理由：面板按钮（下载 / 历史 / 书签 / 插件）与菜单按钮语义上属于
 * 「侧栏底部的工具行」，而**导航栏块住在侧栏的顶部**（见 shared-types 的
 * DEFAULT_SIDE_ROW_ORDER：navbar 在 tabbar 之前）。要把它们放到标签列表之下，
 * 节点就必须**借住**到标签栏块的底槽（`slots.dock`）里。
 *
 * 那个槽由 ui-vertical-tabs 开出 —— 它不认识面板是什么，本模块也不认识侧栏骨架
 * 长什么样，两边只共享「一个空槽」这一件事（见 docs/vertical-tabs-architecture.md §4.9）。
 *
 * 两个落点，由两个事实决定（都住在 `row/rowForm.ts`，本模块只读）：
 *   · 始终留在 navbar 自己的工具按钮行（`.navbar-actions-row`）。
 *     标签列表不得把导航按钮 / 菜单吞到自己的下方 —— 两组 bar 的上下顺序由
 *     sideOrder 决定，navbar 内部控件始终跟随 navbar。
 *
 * 落点定了之后，本模块还负责**通告形态**：往容器上打 `data-dock="true"` —— 借住底槽
 * 意味着「窄列、可被插件撑长」，排版要随之换（竖排堆叠 / 簇内滚动 / 菜单常驻，
 * 见 `components/panelButtons.ts#PANEL_BUTTONS_CSS`）。为什么用自打的标记去通告、
 * 而不是让样式去认侧栏骨架的类名：两块分属不同的包、互不相识。
 *
 * 横排与 Edge 型垂直标签（navbar 在顶、tabbar 在侧）因此与加本模块之前**逐像素一致**
 * —— dock 空着不占位（见 ui-vertical-tabs 的 `.vtabs__dock:empty`）。
 *
 * 为什么与 `sideColumnPlan` 分开：那个管的是「空间切换器 / 新建标签」两件**标签栏专属物**，
 * 判据只有「标签栏在不在侧栏」；本模块管的是**导航栏自己的站点控制区**，判据还多一条
 * 「本块自己在不在侧栏」。合成一个文件必然写成两组互不相干的 if 挤在一起。
 *
 * 本模块只搬节点：不认识面板按钮怎么画（`components/panelButtons.ts` 的事），
 * 也不认识窗口控制按钮的落点（`windowControlsPlacement.ts` 的事）。
 */

import type { RowForm } from './rowForm'

/**
 * @param {{
 *   actionsRow: HTMLElement,
 *   bottomRight: HTMLElement,
 *   form: import('./rowForm.ts').RowForm
 * }} ctx
 * @returns {{ place: () => void }}
 */
export function createSideDock(ctx: {
  actionsRow: HTMLElement
  bottomRight: HTMLElement
  form: RowForm
}): { place: () => void } {
  const { actionsRow, bottomRight, form } = ctx

  /** 重摆（幂等 —— 目标位没变则一次 DOM 都不动）。 */
  function place() {
    const target = actionsRow
    if (bottomRight.parentNode !== target) target.appendChild(bottomRight)
    if (bottomRight.dataset.dock) delete bottomRight.dataset.dock
  }

  return { place }
}

