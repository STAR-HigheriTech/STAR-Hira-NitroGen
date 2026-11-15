// @ts-check
/**
 * 「一枚标签组芯片」的渲染记录 —— 与 `tabRecord` 同构：造一次、复用、增量更新。
 *
 * 与标签行的两点不同：
 *   · 芯片的右键菜单是**本组件自带的**（重命名 / 拆分 / 合并 / 配色）——因为它是
 *     标签条独有的概念，ui-common 的通用菜单表里没有它；
 *   · 它需要「除自己以外的标签组」作为合并目标（`getSiblings`），由渲染引擎从
 *     当前投影里现算（投影是唯一真相源，不必再异步查一遍标签列表）。
 */

import { createTabStack } from '../components/TabStack.js'
import type {
  IntentHandler,
  IntentHandlers,
  RenderRecord,
  StackPatch,
  TabDecorator,
  TabStackState
} from '../types.js'
import type { PopMenu } from '@hira-ng/ui-common'

interface StackRecordPorts {
  onToggle?: (stackId: string) => unknown
  onRename?: (stackId: string, label: string) => unknown
  stackMenu?: IntentHandlers
  getSiblings?: () => TabStackState[]
  showMenu?: PopMenu | null
  decorate?: TabDecorator | null
}

/**
 * @param {Document} doc
 * @param {TabStackState} item 投影项（stack）
 * @param {{
 *   onToggle?: Function, onRename?: Function,
 *   stackMenu?: object,
 *   getSiblings?: () => TabStackState[],
 *   showMenu?: Function,
 *   decorate?: Function|null
 * }} ports
 * @returns {RenderRecord<TabStackState>}
 */
export function createStackRecord(
  doc: Document,
  item: TabStackState,
  ports: StackRecordPorts = {}
): RenderRecord<TabStackState> {
  // createTabStack 内部已持有可变 state，事件闭包天然读最新值。
  const stack = createTabStack(doc, item, {
    // 芯片上只有两件 DOM 事归本组件（展开/收起、行内改名），直通端口。
    onToggle: (stackId) => { if (typeof ports.onToggle === 'function') ports.onToggle(stackId) },
    onRename: (stackId, label) => { if (typeof ports.onRename === 'function') ports.onRename(stackId, label) },
    /**
     * 其余四个动作（解散 / 平铺成分屏 / 合并 / 配色）走**整包**（apps 侧
     * `createStackMenuHandlers(tabsClient)` 造好的那一份）—— 与纵向组行取的是同一份。
     *
     * ⚠ 这里曾经逐项转发（onSetColor / onMerge / onSplit / onTile），而芯片分派
     * （`runStackMenuAction`）读的是 `handlers.stackMenu` —— 名字对不上，四项全都接不到，
     * 表现就是「解散标签组」点了没反应（同一族缺陷：菜单项可见性只读数据，动作却是另一套查找）。
     * 整包直通之后，"菜单多一项"只需改 ui-common 的模板与 apps 的动作表。
     */
    stackMenu: ports.stackMenu,
    // 合并目标由芯片渲染成子菜单：这里给它**除自己以外**的标签组
    getSiblings: () => (typeof ports.getSiblings === 'function' ? ports.getSiblings() : []),
    showMenu: ports.showMenu
  }, { decorate: ports.decorate })

  return {
    key: `stack:${item.stackId}`,
    node: stack.element,
    state: item,
    item,
    update(next: StackPatch) { stack.update(next) }
  }
}
