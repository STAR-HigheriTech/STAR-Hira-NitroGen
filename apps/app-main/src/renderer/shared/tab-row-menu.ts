/**
 * 标签行右键菜单的**统一装配**（apps 层的唯一一处）。
 *
 * ── 分工（与 ui-common 的 createTabContextMenu）─────────────────────────
 *   · **模板与动作分发表**（有哪些菜单项、中文文案、危险项样式）在 ui-common ——
 *     横向标签条 / 纵向标签列 / 两个面板 / 侧栏覆盖层五处共用同一份，改一处全生效；
 *   · **动作落到哪个客户端**（onBack → tabsClient.back …）是 apps 层的知识，只写在这里。
 *
 * 在此之前这张「动作表」被抄了三遍（app-shell 的侧栏、panels 宿主、侧栏覆盖层）——
 * 三份必然漂移：新加一项「关闭右侧标签」时只改了一处，另外两个入口就没有这一项。
 */

import {
  createTabContextMenu,
  TAB_MENU_LABELS,
  fireStackRequest,
  leaveStack,
  stackTogether,
  domainGroupTabIds,
  type PopMenu,
  type TabContextMenu,
  type TabContextMenuHandlers,
  type TabMenuLabels,
  type TabMenuTab,
  type TabStackClient
} from '@hira-ng/ui-common'
import { tabsClient } from './hira-client.js'
import { notesClient, isFeatureAvailable } from './hira-client.js'
import { menuClient } from './menu-client.js'
import { createSplitMenuHandlers } from './tab-split-actions.js'
import { createGlanceMenuHandlers } from './tab-glance-actions'
// PWA「安装为应用 / 在应用中打开」—— 与地址栏按钮**同一条**流程（shared/pwa-actions）。
import { pwaMenuHandlers } from './pwa-actions.js'
// 固定文件夹的三个端口（列出 / 移入已有 / 新建）—— 与横向标签条取**同一份**（见该文件头）。
import { pinnedFolderPorts } from './pinned-folder-actions.js'
// 分享页地址的唯一构造函数（N15）—— 五类宿主共用同一份，避免各自拼串漂移。
import { shareUrlFor } from '@hira-ng/shared-types/src/share.mjs'
import {
  buildCollectionMenuEntries,
  captureToCollectionTarget,
  collectionTargetFromAction,
  toActionMenuItems
} from '@hira-ng/shared-types/src/collection-menu.mjs'

/**
 * @param {{
 *   refresh?: () => void,
 *   popMenu?: (payload: object) => Promise<string|null>,
 *   onMenuState?: (open: boolean) => void
 * }} [opts]
 *   refresh：动作执行后刷新列表（取消固定后固定标签面板必须重取）；
 *   popMenu：怎么弹（默认走原生菜单通道）；
 *   onMenuState：菜单开合通知（**覆盖层用它锁住自己** —— 菜单存续期间鼠标在系统菜单上，
 *     宿主会收到「指针离开」，不锁就会被当场收起来，菜单锚点跟着跑掉）。
 * @returns {(opts?: { labels?: object }) => Function} 供 createTabListHost 的 `createTabRowMenu` 端口
 */
interface TabRowMenuFactoryOptions {
  refresh?: () => void
  popMenu?: PopMenu
  onMenuState?: (open: boolean) => void
}

export interface TabRowMenuInvocation {
  labels?: TabMenuLabels
  getItems?: () => TabMenuTab[]
}

export function createTabRowMenuFactory(opts: TabRowMenuFactoryOptions = {}) {
  const { refresh, popMenu, onMenuState } = opts
  const stackClient = tabsClient as unknown as TabStackClient
  return ({ labels, getItems }: TabRowMenuInvocation = {}): TabContextMenu => {
    // 当前列表（供「按域名分组」判据用）。宿主在每次弹菜单时传入 getter；
    // 不传 → 判据恒 false → 菜单里不出现该项（不留"点了没反应"的项）。
    const itemsOf: () => TabMenuTab[] = typeof getItems === 'function' ? getItems : () => []
    /**
     * 取宿主当前列表里的**投影项**（种类裁决要 `pinned`）。
     * 查不到就退成「只有 id」的记录 —— tab-policy 见到缺 `pinned` 会跳过 UI 裁决，
     * 由主进程按同一份策略兜底。
     */
    const itemOf = (tabId: unknown): TabMenuTab => {
      const id = String(tabId == null ? '' : tabId)
      const hit = id && Array.isArray(itemsOf())
        ? itemsOf().find((it) => it && it.tabId != null && String(it.tabId) === id)
        : null
      return hit || { tabId: id }
    }
    // 本宿主弹原生菜单的那一份入口 —— 标签右键用它，集锦选择器也复用它（同一条通道弹第二次）。
    const pop: PopMenu = popMenu || ((payload) => menuClient.popupMenu(payload))
    const show = createTabContextMenu({
      popMenu: pop,
      // 「相邻项」的文案：纵向列表是下一行（下方），横向是右边 —— 由调用方给。
      labels: labels || TAB_MENU_LABELS.below,
      include: { undoClose: true },
      handlers: {
        getNavigationState: (tabId) => tabsClient.navigationEntries(tabId),
        onBack: (tabId) => tabsClient.back(tabId),
        onForward: (tabId) => tabsClient.forward(tabId),
        onReload: (tabId) => tabsClient.reload(tabId),
        onDuplicate: (tabId) => tabsClient.duplicate(tabId),
        onNewTab: () => tabsClient.newTab({}),
        // 与标签栏完全同一条语义（落点有组就并入、都是散标签才新建组）
        onStackWith: (tabId, nextItem) => fireStackRequest(stackTogether(stackClient, itemOf(tabId), nextItem)),
        // 单个标签脱离它所在的标签组（组还在，其余成员照旧）—— 与芯片菜单的
        // 「解散标签组」是两件事：那是整组没了，这是这一个走人。
        // 固定标签的「离开」= 取消固定，由 leaveStack 按种类分流（真源 tab-policy）。
        onLeaveStack: (tabId) => fireStackRequest(leaveStack(stackClient, itemOf(tabId))),
        // 「按域名分组标签」：把同站点的全部标签收进一个新组（复用既有 stack-create）。
        // 判据与执行都基于**宿主的当前列表**（domainGroupTabIds 是纯函数，见 ui-common）。
        onGroupByDomain: (tabId) => {
          const group = domainGroupTabIds(itemsOf(), tabId)
          if (group) fireStackRequest(tabsClient.createStack({ tabIds: group.tabIds, label: group.domain }))
        },
        canGroupByDomain: (tabId) => !!domainGroupTabIds(itemsOf(), tabId),
        // 「归档标签」（J9）：关闭 + 记入归档区（面板里可恢复）。
        onArchive: (tabId) => fireStackRequest(tabsClient.archive(tabId)),
        listCollectionEntries: async () => {
          if (!isFeatureAvailable('notes')) return []
          try {
            return toActionMenuItems(buildCollectionMenuEntries(
              await notesClient.folders() as unknown as Array<{ id?: string; name?: string }>
            ))
          } catch (_) {
            return []
          }
        },
        onCollectionAction: (tab, action) => {
          const target = collectionTargetFromAction(action)
          if (!tab?.url || !target) return
          void captureToCollectionTarget(notesClient, {
            url: tab.url,
            title: tab.title,
            tabId: tab.tabId == null ? undefined : String(tab.tabId)
          }, target)
        },
        // 「分享 / 生成二维码」（N15）：在新标签打开分享页（URL 形态的唯一实现在 shared-types#share）。
        onSharePage: (tab) => { if (tab && tab.url) tabsClient.newTab({ url: shareUrlFor(tab.url) }) },
        onTogglePin: (tabId) => tabsClient.togglePin(tabId),
        // 固定文件夹三件套：列出已有文件夹（子菜单）/ 移入选中的文件夹 / 建新文件夹并放入。
        // 与横向标签条**同一份端口**（shared/pinned-folder-actions.js）—— 两处不会漂移。
        ...pinnedFolderPorts,
        onToggleMute: (tabId) => tabsClient.toggleMute(tabId),
        // 「定时刷新」（C7）：档位毫秒由菜单模型给出，落库/计时在引擎侧。
        onAutoRefresh: (tabId, ms) => tabsClient.setAutoRefresh(tabId, ms),
        onCloseTab: (tabId) => tabsClient.closeTab(tabId),
        onCloseOthers: (tabId) => tabsClient.closeOthers(tabId),
        onCloseRight: (tabId) => tabsClient.closeRight(tabId),
        onUndoClose: () => tabsClient.undoClose(),
        // 分屏四项（与标签栏那份是**同一个函数**返回的同一批接线，见 tab-split-actions）
        ...createSplitMenuHandlers(tabsClient),
        // 速览三项（与分屏平级、正交；见 tab-glance-actions）
        ...createGlanceMenuHandlers(tabsClient),
        // PWA：面板 / 竖直标签 / 侧栏浮层三处共用同一份端口（探测态由主进程给）。
        ...pwaMenuHandlers
      } satisfies TabContextMenuHandlers
    })

    /** 菜单开合通知（可选）：把「菜单开着」这条事实告诉宿主。 */
    const guarded = typeof onMenuState !== 'function'
      ? show
      : async (...args: Parameters<typeof show>) => {
          onMenuState(true)
          try { return await show(...args) } finally { onMenuState(false) }
        }

    if (typeof refresh !== 'function') return guarded
    // 刷新放在 finally：任何分支（取消 / 选中 / 失败）都不漏 —— 取消固定后固定面板必须重取。
    return async (...args: Parameters<typeof show>) => { try { return await guarded(...args) } finally { refresh() } }
  }
}



