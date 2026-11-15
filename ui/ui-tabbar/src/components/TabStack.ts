// @ts-check
/**
 * 标签组芯片（`.tab-stack-chip`，Edge 风格）—— **装配器**：把小块拼成一枚芯片，
 * 并维护一份供更新用的「当前态快照」。
 *
 * 每件事都有自己的家（本文件只负责拼与更新）：
 *   stack/chipArrow.js  展开箭头（两态 chevron，自身有状态）
 *   stack/chipMenu.js   自带右键菜单的模板与动作返回（不改 DOM）
 *   stack/renameSlot.ts 名称的行内重命名槽位（独占、Enter/失焦提交、Esc 取消）
 *   decoration.js       插件装饰层（渲染侧插槽 `tabbar.tab-stack-renderer`）
 *
 * 数据契约: stack = { stackId, label, count, accent, collapsed, pinned, children: [...] }
 *
 * `pinned` = **固定文件夹**（Zen Essentials 语义）：固定分组也是标签组，只是整组常驻标签条最前、
 * 成员恒为固定标签。芯片只多吃一枚 Folder 图标与一条兜底显示名，其余行为与普通组逐字一致；
 * 视觉上与普通组明确分开（无左侧色条 + 文件夹轮廓 + 更实底色，见 styles.js 同名规则）。
 *
 * 与 `Tab.js` 同构：可变 state 跨多次 tab:changed 复用，事件闭包读最新值；
 * `update(next)` 只收**变化的字段**，装饰层需要的完整态由这里自己维护。
 */

// 芯片的三个最小件也已住 in ui-common（见 docs/vertical-tabs-architecture.md §3.3 的清单）：
// 与轴无关，横向标签组与纵向列表引用同一份。本组件只负责把它们按**横向**装进芯片。
import {
  classnames,
  createChipArrow,
  createRenameSlot,
  createStackChipMenu,
  iconByName,
  runStackMenuAction,
  stackDisplayLabel,
  STACK_MENU_RENAME
} from '@hira-ng/ui-common'
import { appendDecoration, refreshDecoration } from './decoration.js'
import type {
  IntentHandlers,
  StackPatch,
  TabDecorator,
  TabStackComponentController,
  TabStackState,
  UnknownRecord
} from '../types.js'
import type { PopMenu } from '@hira-ng/ui-common'

interface TabStackHandlers extends UnknownRecord {
  onToggle?: (stackId: string) => unknown
  onRename?: (stackId: string, label: string) => unknown
  showMenu?: PopMenu | null
  getSiblings?: () => TabStackState[]
  stackMenu?: IntentHandlers
}

interface TabStackOptions {
  decorate?: TabDecorator | null
}

function createTabStack(
  doc: Document,
  stack: TabStackState,
  handlers: TabStackHandlers = {},
  options: TabStackOptions = {}
): TabStackComponentController {
  /**
   * 芯片的**装饰层调用器**（渲染侧插槽 `tabbar.tab-stack-renderer`）。
   * 缺省即"没有插件参与"，行为与接线前逐字一致；两条硬约束见 `./decoration.js`。
   */
  const decorate = typeof options.decorate === 'function' ? options.decorate : null
  // 可变状态：节点跨多次 tab:changed 复用后，事件闭包必须读最新值，
  // 否则重命名 / 拆分 / 合并会拿到创建时的旧 label / children。
  const state = { ...stack }

  const chip = doc.createElement('div')
  chip.className = classnames(
    'tab-stack-chip',
    state.collapsed ? 'tab-stack-collapsed' : 'tab-stack-expanded',
    state.pinned ? 'tab-stack-pinned' : ''
  )
  chip.dataset.stackId = state.stackId
  if (state.accent) chip.style.setProperty('--tab-stack-accent', state.accent)

  const bar = doc.createElement('span')
  bar.className = 'tab-stack-chip-bar'
  chip.appendChild(bar)

  const arrow = createChipArrow(doc, state.collapsed)
  chip.appendChild(arrow.element)

  // 固定文件夹的身份标记（Folder）：与「固定」面板、右键菜单里同一个图标。
  // 普通标签组不显示 —— CSS 只在 `.tab-stack-pinned` 下放开它，因此不必来回插拔节点。
  const pin = doc.createElement('span')
  pin.className = 'tab-stack-chip-pin'
  const pinGlyph = iconByName('Folder', doc, { size: 12 })
  if (pinGlyph) pin.appendChild(pinGlyph)
  chip.appendChild(pin)

  const label = doc.createElement('span')
  label.className = 'tab-stack-chip-label'
  label.textContent = stackDisplayLabel(state)
  chip.appendChild(label)

  const count = doc.createElement('span')
  count.className = 'tab-stack-chip-count'
  count.textContent = String(state.count || 0)
  chip.appendChild(count)

  /**
   * 装饰层（渲染侧插槽 `tabbar.tab-stack-renderer`）。
   *
   * `update(next)` 只给**变化的字段**，而装饰器需要一份**完整**的当前态 ——
   * 所以这里自己维护一份 live 快照，避免让插件去拼（同 `Tab.js` 的理由）。
   */
  const live: UnknownRecord = {
    stackId: state.stackId,
    label: state.label || '',
    count: Number(state.count || 0),
    accent: state.accent || '',
    collapsed: !!state.collapsed,
    pinned: !!state.pinned,
    childCount: Array.isArray(state.children) ? state.children.length : 0
  }
  // 挂到芯片**末尾**：装饰在计数气泡右侧（标签数是个小圆角块，插在它前面会把
  // 「名称 … 数量」这条读序打断）。
  let decoration = appendDecoration(chip, decorate, { ...live }, 'tab-stack-decoration')

  chip.addEventListener('click', () => {
    if (typeof handlers.onToggle === 'function') handlers.onToggle(state.stackId)
  })

  // 菜单与重命名槽位：菜单只返回动作，DOM 改动全部收在本文件里（唯一知道芯片结构的地方）
  const openMenu = createStackChipMenu({
    showMenu: handlers.showMenu,
    // 合并目标：**除自己以外**的标签组，由渲染记录从当前投影现算
    getSiblings: () => (typeof handlers.getSiblings === 'function' ? handlers.getSiblings() : [])
  })
  const rename = createRenameSlot(doc)

  chip.addEventListener('contextmenu', async (event: MouseEvent) => {
    event.preventDefault()
    const action = await openMenu(event.clientX, event.clientY, state)
    if (!action) return
    // 动作分派走**共用件**（模板也在那里）：本组件只负责"重命名要在芯片上开输入框"
    // 这一件 DOM 事 —— 其余四个动作（解散 / 平铺 / 合并 / 配色）与纵向组行共用一份分派，
    // 不再两端各写一遍（上一版就是这样，横向多了个点了没反应的"拆分标签组"）。
    const actionState = {
      ...state,
      children: Array.isArray(state.children) ? state.children.map((child) => String(child.tabId)) : []
    }
    if (runStackMenuAction(action, actionState, handlers.stackMenu || {}) === STACK_MENU_RENAME) {
      rename.begin(chip, label, state.label || '', (next: string) => {
        if (typeof handlers.onRename === 'function') handlers.onRename(state.stackId, next)
      })
    }
  })

  return {
    element: chip,
    update(next: StackPatch) {
      Object.assign(state, next)
      // 先同步 live 快照（装饰器要一份**完整的**当前态，见上面的说明）。
      // 不做"只有相关字段变了才重建"的细粒度判断 —— `update` 本就是在宿主 diff 出
      // 变化之后才被调用的，而"哪些字段与我有关"只有插件自己知道。
      let liveChanged = false
      const sync = (key: string, value: unknown) => {
        if (live[key] !== value) { live[key] = value; liveChanged = true }
      }
      if (next.label !== undefined) sync('label', next.label || '')
      if (next.count !== undefined) sync('count', Number(next.count || 0))
      if (next.accent !== undefined) sync('accent', next.accent || '')
      if (next.collapsed !== undefined) sync('collapsed', !!next.collapsed)
      if (next.pinned !== undefined) sync('pinned', !!next.pinned)
      if (next.children !== undefined) {
        sync('childCount', Array.isArray(next.children) ? next.children.length : 0)
      }

      if (next.collapsed !== undefined) {
        chip.classList.toggle('tab-stack-collapsed', !!next.collapsed)
        chip.classList.toggle('tab-stack-expanded', !next.collapsed)
        arrow.update(!!next.collapsed)
      }
      if (next.label !== undefined) label.textContent = stackDisplayLabel(state)
      if (next.pinned !== undefined) {
        chip.classList.toggle('tab-stack-pinned', !!next.pinned)
        // 兜底名跟着 pin 走（没名字的固定分组显示「固定标签」）：pin 变了要重算一次。
        label.textContent = stackDisplayLabel(state)
      }
      if (next.count !== undefined) count.textContent = String(next.count)
      if (next.accent !== undefined) {
        if (next.accent) chip.style.setProperty('--tab-stack-accent', next.accent)
        else chip.style.removeProperty('--tab-stack-accent')
      }
      // 装饰层**最后**重建：它可能读上面所有字段的最终值（放前面会读到半更新的状态）
      if (decorate && liveChanged) {
        decoration = refreshDecoration(chip, decoration, decorate, { ...live }, 'tab-stack-decoration')
      }
    }
  }
}

export { createTabStack }
