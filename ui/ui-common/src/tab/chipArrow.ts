/**
 * 标签组芯片的**展开箭头** —— 一个最小件：一个 span + 两态图标。
 *
 * 为什么要单独成件：箭头是芯片里**唯一有自身状态**的装饰（折叠/展开各一个
 * 不同方向的 chevron），而图标的替换必须只在状态真变时发生 —— 若把它写在
 * 芯片装配器的 update 里，每次 label/count 变化都会连带重建 SVG。
 *
 * 它不认识标签组、不认识菜单 —— 只认「我朝向哪边」。
 */

import { ChevronRight, ChevronDown } from '../icons'

const ICON_SIZE = 14

export function createChipArrow(
  doc: Document,
  collapsed = false
): { element: HTMLSpanElement; update: (collapsed: boolean) => void } {
  let current = !!collapsed

  const element = doc.createElement('span')
  element.className = 'tab-stack-chip-arrow'
  element.appendChild(current ? ChevronRight(doc, { size: ICON_SIZE }) : ChevronDown(doc, { size: ICON_SIZE }))

  return {
    element,
    update(next: boolean): void {
      const value = !!next
      if (value === current) return
      current = value
      element.innerHTML = ''
      element.appendChild(value ? ChevronRight(doc, { size: ICON_SIZE }) : ChevronDown(doc, { size: ICON_SIZE }))
    }
  }
}
