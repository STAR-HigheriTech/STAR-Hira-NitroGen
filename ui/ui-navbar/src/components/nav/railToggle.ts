/**
 * rail 固定按钮 —— **自身有按下态**的一颗动作按钮。
 *
 * 固定 = 常驻占位；取消固定 = 静止收起，指针贴边唤出时仍按同一宽度占位。
 * 按钮只画图钉与可访问状态，窗口布局和边缘唤出由宿主负责。
 */

import { Pin } from '@hira-ng/ui-common'
import { createActionButton } from '../actionButton'
import type { RailPosition, RailToggleController } from '../../types'

/**
 * @param {Document} doc
 * @param {{ onToggleRail?: () => unknown }} [handlers]
 * @returns {{
 *   element: HTMLElement,
 *   setRailPosition: (position: 'left'|'right'|'top'|'bottom') => void
 * }}
 */
export function createRailToggle(
  doc: Document,
  handlers: {
    onToggleRail?: () => Promise<{ visible?: boolean; pinned?: boolean } | void> | { visible?: boolean; pinned?: boolean } | void
  } = {}
): RailToggleController {
  let railPinned = true
  let railPosition: RailPosition = 'left'

  const element = createActionButton(doc, { id: 'rail-toggle-button', icon: Pin, title: '' })

  function renderState() {
    const title = railPinned ? '工具栏已固定，点击改为悬停展开' : '悬停展开中，点击固定工具栏'
    element.title = title
    element.setAttribute('aria-label', title)
    element.setAttribute('aria-pressed', String(railPinned))
  }

  element.addEventListener('click', async () => {
    let next = !railPinned
    try {
      if (typeof handlers.onToggleRail === 'function') {
        const res = await handlers.onToggleRail()
        if (res && typeof res === 'object') {
          if (typeof res.pinned === 'boolean') next = res.pinned
          else if (typeof res.visible === 'boolean') next = res.visible
        }
      }
      railPinned = next
    } catch (error) {
      console.error('[navbar] rail toggle failed:', error)
    }
    renderState()
  })

  renderState()

  return {
    element,
    /** 图钉不依赖方位；记录方位供样式与后续扩展读取。 */
    setRailPosition(next: RailPosition) {
      railPosition = next === 'top' || next === 'bottom' || next === 'right' ? next : 'left'
      element.dataset.railPosition = railPosition
    },
    setPinned(pinned: boolean) {
      railPinned = Boolean(pinned)
      renderState()
    }
  }
}
