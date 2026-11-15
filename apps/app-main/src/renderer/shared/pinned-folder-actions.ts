/**
 * 「固定文件夹」的**菜单端口唯一真源**（apps 层）。
 *
 * 两处宿主需要同一批动作：
 *   · 标签右键菜单（`shared/tab-row-menu.js`，横向标签条 / 纵向列表 / 面板 / 侧栏共用）；
 *   · 横向标签条自己的 `tabMenuHandlers`（`controllers/tab-session-controller.js`）。
 * 它们此前各写一遍「取列表 → 过滤 pinned → setTabStack」的三段式，只要口径改一次就会
 * 漂移（上一轮就是「固定到新文件夹」只在一边接了线，另一边点了没反应）。
 *
 * 领域原语（默认名 / 允许空成员 / 落库方法）住在 `@hira-ng/ui-common#tab/pinnedFolders`，
 * 这里只把它们落到本进程的 `tabsClient` 上 —— 与 `tab-row-menu.js` 的其它端口同一分工：
 * **ui 包只出题，apps 层回答"打到哪"**。
 */

import {
  listPinnedFolders,
  moveTabToPinnedFolder,
  pinTabToNewFolder
} from '@hira-ng/ui-common'
import { tabsClient } from './hira-client.js'

/** 落库失败（文件夹已被解散 / 标签已销毁）不冒泡成未处理的 Promise 拒绝。 */
function fire(request: unknown): unknown {
  if (request instanceof Promise) request.catch(() => {})
  return request
}

/**
 * @param {object} client 标签客户端（鸭子类型，缺方法即跳过）
 * @returns {{
 *   listPinnedFolders: () => Promise<Array<{stackId: string, label: string, count: number, accent: string}>>,
 *   onPinToFolder: (tabId: string, stackId: string) => unknown,
 *   onPinToNewGroup: (tabId: string, label?: string) => unknown
 * }}
 */
export function createPinnedFolderPorts(client: object) : {
  listPinnedFolders: () => Promise<Array<{stackId: string, label: string, count: number, accent: string}>>,
  onPinToFolder: (tabId: string, stackId: string) => unknown,
  onPinToNewGroup: (tabId: string, label?: string) => unknown
} {
  return {
    /** 「添加到 / 移动到固定文件夹 ▸」的子菜单数据（含空的收藏夹，带成员数）。 */
    listPinnedFolders: () => listPinnedFolders(client),
    /** 选中的已有文件夹：`setTabStack` 进 pinned 栈会自动把标签置为固定。 */
    onPinToFolder: (tabId, stackId) => fire(moveTabToPinnedFolder(client, tabId, stackId)),
    /** 「新建文件夹…」：建一个单成员 pinned 栈（名字由引擎给兜底值，用户随后改名）。 */
    onPinToNewGroup: (tabId, label) => fire(pinTabToNewFolder(client, tabId, label))
  }
}

/** 单例：本进程的标签客户端只有一份，端口因此也只有一份。 */
export const pinnedFolderPorts = createPinnedFolderPorts(tabsClient)

