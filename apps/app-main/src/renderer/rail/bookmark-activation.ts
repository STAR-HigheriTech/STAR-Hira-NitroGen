import { openBookmarkTarget, resolveBookmarkOpenTarget } from '@hira-ng/ui-common'
import type { RailPointerModifiers } from '@hira-ng/ui-taskoverlay'
import { tabsClient } from '../shared/tabs-client.js'
import { webSidebarClient } from '../shared/web-sidebar-client.js'

export interface RailBookmarkTarget {
  url: string
  title?: string | null
}

/** rail 固定书签与书签预览共用的打开规则。默认进入侧栏，Ctrl / Alt / Shift 与书签栏一致。 */
export function openRailBookmark(bookmark: RailBookmarkTarget, modifiers: RailPointerModifiers): void {
  if (!bookmark.url) return
  const target = resolveBookmarkOpenTarget(modifiers, true)
  openBookmarkTarget(target, {
    url: bookmark.url,
    openSidebar: (url) => webSidebarClient.open(url, { title: bookmark.title || '' }).catch(() => {}),
    openTab: (url) => tabsClient.newTab({ url }),
    openCurrent: (url) => tabsClient.navigate({ url }),
    findTabId: (url) => tabsClient.list().then((tabs) => {
      const found = (Array.isArray(tabs) ? tabs : []).find((tab) => tab && tab.url === url)
      return found ? found.id : null
    }).catch(() => null),
    switchTab: (id) => tabsClient.switchTab(id)
  })
}
