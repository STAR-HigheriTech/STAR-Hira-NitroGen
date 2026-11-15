/**
 * rail 固定按钮的**落点判定** —— 侧边栏在左还是右、本块住横排还是纵排，决定它住哪。
 *
 * rail 开关现在也是用户可拖动的账本成员，位置由 `toolbar/ledger` 唯一决定。
 * 本模块只保留「侧栏在哪一侧」这一份状态派生：图钉与按下态属于按钮自身。
 */

import type { NavClusterController, RailPosition } from '../types'
import type { RowForm } from './rowForm'

/**
 * @param {{
 *   navCluster: { element: HTMLElement, railBtn: HTMLElement, setRailPosition: (position: 'left'|'right'|'top'|'bottom') => void },
 *   form: import('./rowForm.ts').RowForm
 * }} ctx
 * @returns {{ place: () => void }}
 */
export function createRailButtonPlacement(ctx: {
  navCluster: Pick<NavClusterController, 'element' | 'railBtn' | 'setRailPosition'>
  form: RowForm
}): { place: () => void } {
  const { navCluster, form } = ctx

  /**
   * 上一次转达给按钮的方位。
   *
   * 这不是"事实的第二份副本"，而是**上一次施加过的值**：`setRailSide` 会重画图标
   * （innerHTML 重建），每轮重摆无条件调它等于反复重建同一颗 SVG。事实仍只有一份（form）。
   */
  let appliedPosition: RailPosition | null = null

  /** 落点（幂等）：目标位没变则一次 DOM 都不动。 */
  function place() {
    const position = form.railPosition
    if (appliedPosition !== position) {
      appliedPosition = position
      navCluster.setRailPosition(position)
    }

  }

  return { place }
}

