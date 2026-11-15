/**
 * 标签行的**关闭按钮** —— 一行里唯一一个「永远可点、且必须吃掉冒泡」的控件。
 *
 * 为什么单独成模块：它的三条约束都与标签行其余部分无关，混在一起容易被误改：
 *   · 点击必须 `stopPropagation` —— 否则点关闭会顺带把标签选中（先切后关）；
 *   · 尺寸 16px（Lucide 的 X 只占 24 视图框里的 12 个单位，给 12px 时真实笔画
 *     只有 6px 宽，又细又小）；
 *   · 显示由样式表按 hover 控制（`visibility` + `opacity`，保留占位不跳动）。
 *
 * 点击只上抛**无参意图**（见 iconArea.js 的同一口径）。
 */

import { X } from '../icons'

export function createTabCloseButton(
  doc: Document,
  handlers: { onClose?: () => void } = {},
  opts: { classNames?: string } = {}
): { element: HTMLButtonElement } {
  const element = doc.createElement('button')
  element.className = opts.classNames || 'tab-close-button'
  element.type = 'button'
  element.setAttribute('aria-label', '关闭标签')
  element.appendChild(X(doc, { size: 16 }))

  element.addEventListener('click', (e) => {
    e.stopPropagation()
    if (typeof handlers.onClose === 'function') handlers.onClose()
  })

  return { element }
}
