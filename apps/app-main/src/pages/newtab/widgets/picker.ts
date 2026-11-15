/**
 * 新标签页 · 「添加组件」选择器
 *
 * 列表完全由注册中心驱动：注册一个新组件，它会自己出现在这里。
 * 已存在的唯一组件显示为不可选，而不是从列表里消失 —— 用户能看到"它在这"，
 * 比"消失了、不知道去哪了"更好理解。
 */
import { listWidgets } from './registry.js'
import { createPopover } from './popover.js'

export function createPicker(opts: {
  onPick: (id: string) => void
  hasInstance: (id: string) => boolean
}) {
  const pop = createPopover({ className: 'ntp-pop--picker' })
  const list = document.createElement('div')
  list.className = 'ntp-picker'
  pop.panel.appendChild(list)

  function render() {
    list.replaceChildren()
    // hidden 的组件是**常驻型**（如搜索框），不该出现在"添加组件"里
    const defs = listWidgets().filter((def) => !def.hidden)
    if (!defs.length) {
      const empty = document.createElement('div')
      empty.className = 'ntp-picker__empty'
      empty.textContent = '暂无可添加的组件'
      list.appendChild(empty)
      return
    }
    for (const def of defs) {
      const added = def.unique && opts.hasInstance(def.id)
      const item = document.createElement('button')
      item.type = 'button'
      item.className = 'ntp-picker__item' + (added ? ' is-disabled' : '')
      item.disabled = added

      const title = document.createElement('span')
      title.className = 'ntp-picker__title'
      title.textContent = def.name
      item.appendChild(title)

      if (def.description) {
        const desc = document.createElement('span')
        desc.className = 'ntp-picker__desc'
        desc.textContent = added ? '已添加' : def.description
        item.appendChild(desc)
      }

      if (!added) {
        item.addEventListener('click', () => {
          pop.close()
          opts.onPick(def.id)
        })
      }
      list.appendChild(item)
    }
  }

  return {
    panel: pop.panel,
    toggle(anchor: HTMLElement) {
      if (!pop.isOpen()) render()
      pop.toggle(anchor)
    },
    close: pop.close,
    isOpen: pop.isOpen
  }
}
