import { classnames, Plus } from '@hira-ng/ui-common'

interface AddTabButtonHandlers {
  onNewTab?: () => unknown
}

/**
 * 新建标签按钮
 * 对应旧版 #add-tab-button
 * 样式走 var(--ng-navbar-add-tab-width) 等 token
 */

function createAddTabButton(doc: Document, handlers: AddTabButtonHandlers = {}): { element: HTMLButtonElement } {
  const btn = doc.createElement('button')
  btn.id = 'add-tab-button'
  btn.className = 'navbar-action-button'
  btn.type = 'button'
  btn.setAttribute('aria-label', 'New tab')
  btn.appendChild(Plus(doc, { size: 16 }))

  btn.addEventListener('click', () => {
    if (typeof handlers.onNewTab === 'function') handlers.onNewTab()
  })

  return {
    element: btn
  }
}

export { createAddTabButton }
