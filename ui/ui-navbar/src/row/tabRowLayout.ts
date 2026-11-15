/**
 * 标签行内的**先后顺序** —— 「标签栏这一行里，谁排在谁前面」的唯一判定处。
 *
 * 三个事实（事实本身住在 `row/rowForm.ts`，本模块只读）：
 *   · 标签条是**后挂**上来的（编排层造好 ui-tabbar 才交过来）；
 *   · 「新建标签」恒在本行末段（窗口控制按钮之前）——它永不离开标签栏；
 *   · 单行（精致）模式要把导航按钮组搬进标签行（`form.compact`）。
 *
 * 这三件事互相牵动（挂标签条要重施导航组位置、单行模式要看标签条在不在），
 * 所以住在同一个模块里；对外只有两个动作：`place()`（幂等）与 `mountTabbar(el)`。
 *
 * 本模块不认识布局计划、不认识侧栏槽位 —— 那些是 `windowControlsPlacement` 与
 * `sideColumnPlan` 的事。它只回答「在这一行里怎么排」。
 */

import type { NavClusterController, WindowControls } from '../types'
import type { RowForm } from './rowForm'

/**
 * @param {{
 *   tabRow: HTMLElement,
 *   bottomLeft: HTMLElement,
 *   navCluster: { element: HTMLElement },
 *   addTabSlot: HTMLElement,
 *   windowControls: { element: HTMLElement },
 *   form: import('./rowForm.ts').RowForm
 * }} ctx
 * @returns {{ place: () => void, mountTabbar: (el: HTMLElement|null) => void }}
 */
export function createTabRowLayout(ctx: {
  tabRow: HTMLElement
  bottomLeft: HTMLElement
  navCluster: Pick<NavClusterController, 'element'>
  addTabSlot: HTMLElement
  windowControls: WindowControls
  form: RowForm
}): {
  place: () => void
  mountTabbar: (element: HTMLElement | null) => void
} {
  const { tabRow, bottomLeft, navCluster, addTabSlot, windowControls, form } = ctx

  /** 由 mountTabbar 灌入的标签条；搬导航按钮时拿它当插入参照。 */
  let tabbarEl: HTMLElement | null = null

  /**
   * 标签栏行内的固定顺序（幂等）：
   *   [拖拽手柄][空间切换器][（单行模式的导航按钮组）][标签条][新建标签][窗口控制按钮]
   *
   * 前三者各由自己的构造 / 单行模式决定，这里只钉住后三者 —— 标签条是**后挂**上来的、
   * 窗口控制按钮的**宿主可配**（标签栏 / 导航栏 / 标题栏），而「新建标签」必须始终夹在
   * 它们之间：标签条右侧、窗口控制按钮左侧，且任何布局下都不离开标签栏。
   */
  function applyOrder() {
    if (tabbarEl && tabbarEl.parentNode === tabRow && tabbarEl.nextSibling !== addTabSlot) {
      tabRow.insertBefore(tabbarEl, addTabSlot)
    }
    if (addTabSlot.parentNode !== tabRow) tabRow.appendChild(addTabSlot)
    // 宿主为标签栏时，窗口控制按钮钉在行末（新建标签之后）；不在本行则什么都不做。
    // 原生 WCO 窗口无自绘簇（element 为 null）—— 直接跳过。
    if (windowControls.element &&
        windowControls.element.parentNode === tabRow &&
        addTabSlot.nextSibling !== windowControls.element) {
      tabRow.appendChild(windowControls.element)
    }
  }

  /** 按当前模式摆放「导航按钮组」的位置（幂等）。 */
  function applyNavPlacement() {
    const nav = navCluster.element
    if (form.compact) {
      const wcEl = windowControls.element
      const ref = (tabbarEl && tabbarEl.parentNode === tabRow)
        ? tabbarEl
        : (wcEl && wcEl.parentNode === tabRow ? wcEl : null)
      if (nav.parentNode !== tabRow || nav.nextSibling !== ref) {
        tabRow.insertBefore(nav, ref)
      }
      return
    }
    if (nav.parentNode !== bottomLeft) bottomLeft.appendChild(nav)
  }

  /** 重摆（幂等 —— 目标位没变则一次 DOM 都不动）。 */
  function place() {
    applyOrder()
    applyNavPlacement()
  }

  return {
    place,

    /**
     * 挂上标签条（由编排层经 ui-tabbar 造好后交过来；本块对它零知识）。
     * @param {HTMLElement|null} el
     */
    mountTabbar(el: HTMLElement | null) {
      tabbarEl = el || null
      // 标签条**插在「新建标签」槽之前**：于是标签栏内恒为
      // [拖拽手柄][空间切换器][标签条][+][窗口控制按钮(若宿主为标签栏)]。
      // 参照物用 addTabSlot 而不是 windowControls —— 后者可能被搬到别的宿主块上。
      if (tabbarEl && (tabbarEl.parentNode !== tabRow || tabbarEl.nextSibling !== addTabSlot)) {
        tabRow.insertBefore(tabbarEl, addTabSlot)
      }
      // 标签条是**后挂上来的**：单行模式下导航按钮组要待在它之前，顺序得再施一次。
      place()
    }
  }
}

