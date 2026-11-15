/**
 * target-picker-overlay —— 通用「选择目标」浮层（独立 WebContentsView）
 *
 * ── 一份浮层，多种场景 ────────────────────────────────────────────
 * 它只做三件事：铺满整窗、按锚点摆卡片、把用户的落点回传给**打开它的那个视图**。
 * 「有哪些项 / 点了干什么」由**来源**决定（见 `shared/target-picker.js` 的来源契约）：
 *
 *   · `bookmark` —— 书签栏文件夹下拉：自己拉子节点、可下钻、点书签即打开。
 *
 * **加一种场景 = 往下面的 sources 表里加一项**：不需要新浮层、不需要新通道，
 * 也不需要碰主进程的浮层登记表（FLOAT_NAMES / COMMIT_OWNER 都已按本层登记）。
 *
 * ── 开合真源在打开方，不在本层 ────────────────────────────────────
 * 浮层只回传事实（select / dismiss），本地立刻 reset；真正的开合状态住在
 * bookmark-controller 里 —— 与「总览」浮层同一条路（外壳算锚点、浮层只回传事实）。
 * 于是"点外部 / 滚轮 / Esc / 主进程兜底收起"四路信号最后都收敛到同一个点。
 *
 * IPC（通用浮层族，无新契约）：
 *   订阅 target-picker-overlay:show { source, levelId, title, anchor, viewport, pickerId, ... } / :hide
 *   调用 target-picker-overlay:display（单向）/ :ready
 *   回传 overlay:commit { kind:'target-picker-select'|'target-picker-dismiss'
 *                              |'target-picker-open-panel', pickerId, source, target?/panelId? }
 */

import '@hira-ng/shared-ui-tokens/tokens-base.css'
import '@hira-ng/shared-ui-tokens/tokens-light.css'
import '@hira-ng/shared-ui-tokens/tokens-dark.css'
// 深路径引用（避开 ui-common 重桶）—— 浮层启动只评估真正用到的模块。
import { resolveBookmarkOpenTarget, openBookmarkTarget, type BookmarkOpenModifiers } from '@hira-ng/ui-common/src/bookmark-open'
import { LIST_LIMITS } from '@hira-ng/ui-common/src/listOverflow'
import { createTargetPicker, type TargetPickerItem, type TargetPickerSource, type TargetPickerShowRequest } from '../shared/target-picker.js'
import { createThemeController } from '../shared/theme-controller.js'
import { getHiraBridge } from '../shared/bridge.js'
import { IPC_EVENTS } from '@hira-ng/shared-types/src/ipc-channels.mjs'
import { tabsClient, bookmarksClient } from '../shared/hira-client.js'
import { webSidebarClient } from '../shared/web-sidebar-client.js'

const OVERLAY = 'target-picker-overlay'
const bridge = getHiraBridge()
const provider = bridge.provider

const themeController = createThemeController({ document, bridge })
themeController.start()
window.addEventListener('pagehide', () => themeController.dispose(), { once: true })

interface BookmarkPickerNode {
  id: string
  title: string | null
  nickname: string | null
  url: string | null
  favicon: string | null
  openInSidebar: boolean
}

function isBookmarkPickerNode(value: unknown): value is BookmarkPickerNode {
  return typeof value === 'object' && value !== null
}

function isFolder(node: BookmarkPickerNode): boolean {
  return !node || !node.url
}

/** 书签节点 → 选择器 item（文件夹可下钻，书签点击即打开）。 */
function toBookmarkItem(node: BookmarkPickerNode): TargetPickerItem {
  const folder = isFolder(node)
  return {
    id: String(node.id || ''),
    label: node.nickname || node.title || (folder ? '(文件夹)' : node.url || '(未命名)'),
    title: folder ? node.title || '' : node.url || '',
    icon: folder ? 'folder' : 'favicon',
    favicon: node.favicon || undefined,
    url: node.url || '',
    drill: folder || undefined,
    data: node
  }
}

/** 书签行数组 → 选择器 item 数组（预取载荷与权威加载**共用**这一个映射）。 */
function toBookmarkItems(rows: unknown[]): TargetPickerItem[] {
  return (Array.isArray(rows) ? rows : []).filter(isBookmarkPickerNode).map(toBookmarkItem)
}

/** 打开一行书签：去向规则唯一一份（与书签栏 / 面板 / rail 同一份）。 */
function openBookmark(node: BookmarkPickerNode, modifiers: BookmarkOpenModifiers): void {
  const url = node.url || ''
  const target = resolveBookmarkOpenTarget(modifiers, node.openInSidebar)
  openBookmarkTarget(target, {
    url,
    openCurrent: (url) => tabsClient.navigate({ url }),
    openTab: (url) => tabsClient.newTab({ url }),
    openSidebar: (url) => webSidebarClient.open(url, { title: node.title || '' }).catch(() => {}),
    findTabId: (url) => tabsClient.list().then((tabs) => {
      const hit = (Array.isArray(tabs) ? tabs : []).find((t) => t && t.url === url)
      return hit ? hit.id : null
    }).catch(() => null),
    switchTab: (id) => tabsClient.switchTab(id)
  })
}

/**
 * 来源表 —— **扩展点**。每个来源只描述"给我这些项 / 点了做什么"，
 * 不碰几何、观感、收起判据（那些在 shared/target-picker.js 里只有一份）。
 */
const sources: Record<string, TargetPickerSource> = {
  bookmark: {
    // 元信息**声明在来源上**（不是 load 的返回值）：这样外壳随 show 带来的预取载荷
    // 也能立刻按同样的口径截断并摆出来，不必等 load 回来。
    emptyText: '（空文件夹）',
    // 上限 + 去向：内核按 LIST_LIMITS.bookmark 截断，超出的收成
    // 「还有 N 项 · 转到收藏面板」—— 额度不在这里写死（见 ui-common#listOverflow）。
    limit: LIST_LIMITS.bookmark,
    overflowTarget: { label: '收藏面板', panelId: 'favorites-panel' },
    // 预取载荷（外壳随 show 送来的**原始书签行**）→ item：与 load 走同一个映射，
    // 否则首帧摆出来的是没有 icon / data / drill 的裸行（= 没图标、点了没反应）。
    mapItems: toBookmarkItems,
    async load({ id }) {
      const rows = await bookmarksClient.list(String(id || '')).catch(() => [])
      return { items: toBookmarkItems(rows) }
    },
    onPick(item, api, e) {
      // 常规路径 item.data 是书签节点；若宿主直接送来了原始行（没有 data），
      // 就把 item 自己当节点用 —— 别退化成"静默关掉、什么都不发生"。
      const node = isBookmarkPickerNode(item.data) ? item.data : isBookmarkPickerNode(item) ? item : null
      if (!node?.url) {
        api.close()
        return
      }
      // 只上报/消化**修饰键事实**；去向策略不在这里（见 openBookmark）。
      openBookmark(node, {
        shiftKey: !!e.shiftKey,
        ctrlKey: !!e.ctrlKey,
        metaKey: !!e.metaKey,
        altKey: !!e.altKey
      })
      // 打开即收起：浮层盖在书签栏上，留着挡视线。
      api.commit({ kind: 'bookmark', url: node.url })
    }
  }
}

const picker = createTargetPicker(document, {
  overlayName: OVERLAY,
  sources,
  send: (route, data) => provider.send(route, data),
  onCommit: (payload) => {
    try { provider.send('overlay:commit', payload) } catch (_) {}
  }
})

bridge.on.subscribe<TargetPickerShowRequest>(IPC_EVENTS.targetPickerOverlayShow, (payload) => picker.show(payload))
bridge.on.subscribe(IPC_EVENTS.targetPickerOverlayHide, () => picker.hide())

// 书签数据变化（其它窗口 / 编辑器 / 面板里改了）→ 若正开着书签来源，重取当前层。
bookmarksClient.onChanged(() => {
  if (picker.isOpen()) picker.refresh()
})

// 当前层文件夹属于旧 profile，换身份后继续显示只会留下空占位或错误条目。
bridge.on.subscribe(IPC_EVENTS.profileChanged, () => {
  if (picker.isOpen()) picker.hide()
})

;(async () => {
  try { await provider.invoke(`${OVERLAY}:ready`, {}) } catch {}
})()

