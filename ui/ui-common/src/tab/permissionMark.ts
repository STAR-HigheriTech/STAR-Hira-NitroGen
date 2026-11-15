/** 标签权限请求标记：横向与纵向宿主共享图标、显隐和交互口径。 */

import { iconByName } from '../icons'

const DEFAULT_CLASS = 'tab-permission-mark'
const MARK_CSS = 'align-items:center;justify-content:center;gap:2px;flex-shrink:0;padding:0 1px;border:0;background:transparent;color:inherit;opacity:0.72;cursor:pointer;'

export interface TabPermissionHandlers {
  onPermissionClick?: () => void
}

export interface TabPermissionOptions {
  classNames?: { mark?: string }
  size?: number
}

export interface TabPermissionMark {
  element: HTMLButtonElement
  update: (icons: readonly string[] | null | undefined) => void
}

export function createTabPermissionMark(
  doc: Document,
  handlers: TabPermissionHandlers = {},
  options: TabPermissionOptions = {}
): TabPermissionMark {
  const size = typeof options.size === 'number' && Number.isFinite(options.size) ? options.size : 13
  const button = doc.createElement('button')
  button.className = options.classNames?.mark || DEFAULT_CLASS
  button.type = 'button'
  button.style.cssText = MARK_CSS
  button.style.display = 'none'
  button.setAttribute('hidden', '')
  button.setAttribute('aria-label', '该标签正在请求权限，点击查看')

  button.addEventListener('mousedown', (event) => event.stopPropagation())
  button.addEventListener('click', (event) => {
    event.stopPropagation()
    handlers.onPermissionClick?.()
  })

  let signature = ''
  const update = (icons: readonly string[] | null | undefined): void => {
    const names = Array.isArray(icons)
      ? icons.filter((name): name is string => typeof name === 'string' && !!name)
      : []
    const nextSignature = names.join('|')
    if (nextSignature === signature) return
    signature = nextSignature

    button.textContent = ''
    for (const name of names) {
      const svg = iconByName(name, doc, { size, strokeWidth: 2 })
      if (svg) button.appendChild(svg)
    }
    if (button.childNodes.length === 0) {
      button.setAttribute('hidden', '')
      button.style.display = 'none'
      return
    }
    button.removeAttribute('hidden')
    button.style.display = 'inline-flex'
  }

  return { element: button, update }
}
