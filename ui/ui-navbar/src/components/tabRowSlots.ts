/**
 * 标签栏专属的**两个槽位**：空间切换器槽 与 新建标签槽。
 *
 * 为什么这两件住在同一个模块：它们**总是一起被搬走** —— 标签栏进侧栏（垂直标签）时，
 * 空间切换器跟着去侧栏顶部、新建标签跟着去侧栏底部（见 src/row/sideColumnPlan.ts）。
 * 放在一起，搬家规则与构件来源就永远对得上。
 *
 * 「新建标签」为什么必须从窗口控制按钮里分出来：窗口控制按钮（最小化/最大化/关闭）
 * 的宿主是**可配置的**（标签栏 / 导航栏 / 标题栏），"新建标签"搭车的话就会跟着跑到
 * 标题栏去 —— 但它语义上是标签栏的一部分（新建的是标签），必须始终在标签栏。
 *
 * 空间切换器槽只提供**容器**：真实组件由编排层经 `mountSpaceSwitcher` 灌入
 * （@hira-ng/ui-space-switcher 是哑组件，本组件不认识它）。
 */

import { Plus } from '@hira-ng/ui-common'
import { createActionButton } from './actionButton'

/**
 * @param {Document} doc
 * @param {{ onNewTab?: Function }} [handlers]
 * @returns {{
 *   workspace: HTMLElement,
 *   workspaceSlot: HTMLElement,
 *   addTabSlot: HTMLElement,
 *   addTabBtn: HTMLButtonElement
 * }}
 */
export function createTabRowSlots(
  doc: Document,
  handlers: { onNewTab?: () => void | Promise<void> } = {}
): {
  workspace: HTMLElement
  workspaceSlot: HTMLElement
  addTabSlot: HTMLElement
  addTabBtn: HTMLButtonElement
} {
  const workspace = doc.createElement('div')
  workspace.id = 'workspace-switcher'
  workspace.className = 'workspace-switcher'
  const workspaceSlot = doc.createElement('div')
  workspaceSlot.className = 'workspace-switcher-slot'
  workspaceSlot.style.display = 'contents'
  workspaceSlot.appendChild(workspace)

  const addTabBtn = createActionButton(doc, {
    id: 'add-tab-button',
    icon: Plus,
    title: 'New tab',
    onClick: handlers.onNewTab
  })
  const addTabSlot = doc.createElement('div')
  addTabSlot.id = 'navbar-add-tab'
  addTabSlot.appendChild(addTabBtn)

  return { workspace, workspaceSlot, addTabSlot, addTabBtn }
}
