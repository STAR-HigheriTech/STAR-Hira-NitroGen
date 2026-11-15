/**
 * 书签星 —— **哑组件**：只渲染状态、上抛切换意图，自身零书签状态。
 *
 * 真实收藏状态由编排层查库后经 `set()` 推下来（状态上行）；
 * 点击只发 onToggle 意图，是否落库由编排层决定（意图下行）。
 * 右键 → 打开编辑器（收藏即编辑闭环的入口之一），同样只上抛。
 *
 * 它不认识书签库、不认识 IPC —— 换一套收藏后端不需要动这个文件。
 */

import { Star } from '@hira-ng/ui-common'
import type { BookmarkStarState } from '../types'

/**
 * @param {Document} doc
 * @param {{
 *   onToggle?: () => void,
 *   onContextMenu?: (e: MouseEvent) => void
 * }} [handlers]
 * @returns {{
 *   element: HTMLButtonElement,
 *   set: (state?: { visible?: boolean, active?: boolean, title?: string }) => void
 * }}
 */
export function createBookmarkStar(
  doc: Document,
  handlers: {
    onToggle?: () => void
    onContextMenu?: (event: MouseEvent) => void
  } = {}
): {
  element: HTMLButtonElement
  set: (state?: BookmarkStarState) => void
} {
  const element = doc.createElement('button')
  element.id = 'bookmark-star'
  element.className = 'navbar-action-button'
  element.title = 'Bookmark this page'

  const icon = Star(doc, { size: 18 }) as SVGElement
  icon.style.fill = 'none'
  element.appendChild(icon)

  element.addEventListener('click', () => {
    if (typeof handlers.onToggle === 'function') handlers.onToggle()
  })
  element.addEventListener('contextmenu', (e: MouseEvent) => {
    e.preventDefault()
    if (typeof handlers.onContextMenu === 'function') handlers.onContextMenu(e)
  })

  return {
    element,
    set({ visible = true, active = false, title } = {}) {
      element.hidden = !visible
      icon.style.fill = active ? 'currentColor' : 'none'
      element.classList.toggle('bookmarked', active)
      element.setAttribute('aria-pressed', String(!!active))
      if (title) element.title = title
    }
  }
}
