// @ts-check
/**
 * 标签右键菜单 —— 只负责「把本组件的意图接到菜单动作上」。
 *
 * 菜单的**模板与分发表**是 ui-common 里的唯一实现（`createTabContextMenu`）：
 * 横向标签条、纵向标签列、两个面板用的是同一套菜单项，各写一份必然
 * 「加了一处、忘了另外两处」。这里只提供三样宿主专属的东西：
 *   · `popMenu`  本视图弹原生菜单的入口（宿主注入的 showMenu）；
 *   · `handlers` 动作落到本组件的哪个回调（**只有这一层知道**标签条能做什么）；
 *   · `itemAfter` 横向列表的「相邻项」= 右边那个标签（纵向列表则是下一行）。
 */

import { createTabContextMenu, TAB_MENU_LABELS, domainGroupTabIds } from '@hira-ng/ui-common'
import { itemAfter } from './projection.js'
import type {
  IntentHandler,
  IntentHandlers,
  TabbarProjectionItem,
  TabViewState
} from '../types.js'

interface TabbarContextMenuOptions {
  showMenu?: IntentHandler
  getItems?: () => TabbarProjectionItem[]
  intent?: Record<string, IntentHandler | undefined>
  tabMenuHandlers?: IntentHandlers
}

/**
 * @param {{
 *   showMenu?: IntentHandler,
 *   getItems: () => TabbarProjectionItem[],
 *   intent?: Record<string, IntentHandler|undefined>,
 *   tabMenuHandlers?: IntentHandlers
 * }} ctx
 * @returns {(x: number, y: number, tab: TabViewState) => Promise<string|null>}
 */
export function createTabbarContextMenu(
  ctx: TabbarContextMenuOptions = {}
): (x: number, y: number, tab: TabViewState) => Promise<string | null> {
  const showMenu = ctx.showMenu
  const intent = ctx.intent || {}
  /**
   * 标签行右键菜单的**动作整包**（宿主把各动作表拼好后一次性交进来，见
   * `apps/.../tab-session-controller.js` 里的 `tabMenuHandlers`）。
   *
   * ⚠ 必须**直接摊进 handlers**，不能只塞进 `intent`：`intent` 要先经过
   * `call(name)` 那道转手，而下面 handlers 的对象字面量是**固定几项** ——
   * 转手之后 `H.onSplitWith` 永远是 undefined，表现就是"分屏那七项能看见、点了没反应"。
   * 逐项列（以及"列在 intent 却忘了转交"）正是这个 bug 的成因，所以这里整包展开。
   *
   * ⚠⚠ 这个字段刻意是**唯一且无名字**的一整包（不是 `splitMenu` / `glanceMenu` 这种
   * "一个特性一个字段"）：后者每加一个功能就要在三个文件里各补一行，漏一处就是
   * 又一次"菜单项在、点了没反应" —— 速览（A1）三项就是这么哑掉的（当时这里只有
   * `splitMenu`）。动作表怎么拼是 **apps 层**的事，ui 包只负责"整包转交"这一个动作。
   */
  const tabMenuHandlers = ctx.tabMenuHandlers || {}
  const getItems = typeof ctx.getItems === 'function' ? ctx.getItems : () => []
  /** 本组件的意图出口统一收口成「有就调，没有就当没点」。 */
  const call = (name: string) => (...args: unknown[]) => {
    const fn = intent[name]
    if (typeof fn === 'function') fn(...args as never[])
  }

  const show = createTabContextMenu({
    popMenu: async (payload: unknown) => {
      if (typeof showMenu !== 'function') return null
      const action = await showMenu(payload as never)
      return typeof action === 'string' ? action : null
    },
    labels: TAB_MENU_LABELS.right,
    include: { undoClose: true },
    handlers: {
      onBack: call('onGoBack'),
      onForward: call('onGoForward'),
      onReload: call('onReload'),
      onDuplicate: call('onDuplicate'),
      onTogglePin: call('onTogglePin'),
      onToggleMute: call('onToggleMute'),
      // 「定时刷新」（C7）：档位由菜单模型给出 → 宿主落到 tab:auto-refresh。
      onAutoRefresh: call('onAutoRefresh'),
      // 「分享 / 生成二维码」（N15）：交整条快照给宿主去开分享页。
      onSharePage: call('onSharePage'),
      onNewTab: call('onNewTab'),
      onStackWith: call('onStackWith'),
      // 单个标签脱离它所在的标签组（组还在）—— 与芯片菜单的「解散标签组」是两件事
      onLeaveStack: call('onLeaveStack'),
      // 「按域名分组标签」：**本视图持有投影**（getItems），故判据与分组的 id 都在这里算，
      // 只把结果（tabIds + domain）交给宿主去落库 —— 于是"能不能分组"与"分哪些"同源，
      // 不会出现"菜单说能分、点了却没分组"。
      onGroupByDomain: (tabId: string) => {
        const group = domainGroupTabIds(getItems(), tabId)
        if (group) call('onGroupByDomain')(group.tabIds, group.domain)
      },
      canGroupByDomain: (tabId: string) => !!domainGroupTabIds(getItems(), tabId),
      // 「归档标签」（J9）：关闭 + 记入归档区（面板可恢复）
      onArchive: call('onArchive'),
      onCloseTab: call('onCloseTab'),
      onCloseOthers: call('onCloseOthers'),
      onCloseRight: call('onCloseRight'),
      onUndoClose: call('onUndoClose'),
      // 特性动作整包（分屏 / 速览 / 以后任何新增菜单项的动作表）—— 最后一手摊开，
      // 覆盖上面同名的固定别名项（整包是"更具体"的那一份）。
      ...tabMenuHandlers
    }
  })

  /**
   * 弹出某标签的右键菜单。
   * @returns {Promise<string|null>} 被点中的动作
   */
  return async (x, y, tab) => {
    const action = await show(x, y, tab, itemAfter(getItems(), tab.tabId))
    return typeof action === 'string' ? action : null
  }
}
