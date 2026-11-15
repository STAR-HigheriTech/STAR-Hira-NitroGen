/**
 * 书签项右键菜单 —— **唯一实现**（书签栏项 / rail 固定项共用）。
 *
 * ── 为什么必须只有一份 ────────────────────────────────────────────────
 * 这两处的菜单项本就是一回事（只有「从哪取消固定」这一条的文案不同：
 * 「从书签栏取消固定」/「从 rail 取消固定」）。各写一份的结局必然是
 * 「书签栏加了一项、rail 忘了加」—— 与标签行菜单（见 tabContextMenu.ts）
 * 踩过的是同一条老路。
 *
 * ── 宿主只负责两件事，都是注入的纯函数 ──────────────────────────────
 *   · `popMenu({ x, y, items, context })` → 弹出原生菜单并返回被点中的 action；
 *   · `handlers` → 每个 action 落到哪个业务调用（本模块不认识任何 IPC / 客户端）。
 *
 * 于是「书签菜单长什么样」只有一处，改一处不会漏另一处。
 */

import type { MenuItem, PopMenu } from './menuTypes'

export interface BookmarkMenuNode {
  id?: string
  url?: string | null
  title?: string | null
  parentId?: string | null
  [key: string]: unknown
}

export interface BookmarkMenuContext {
  kind: 'bookmark'
  snapshot: {
    bookmark: {
      id: string | undefined
      url: string
      title: string
      parentId: string | null
      isFolder: boolean
    }
    source: string
  }
}

export interface BookmarkContextMenuHandlers {
  onOpen?: (bookmark: BookmarkMenuNode) => void
  onOpenNewTab?: (bookmark: BookmarkMenuNode) => void
  onOpenSidebar?: (bookmark: BookmarkMenuNode) => void
  onEdit?: (bookmark: BookmarkMenuNode) => void
  onUnpin?: (bookmark: BookmarkMenuNode) => void
  onDelete?: (bookmark: BookmarkMenuNode) => void
}

export interface BookmarkContextMenuOptions {
  popMenu?: PopMenu<BookmarkMenuContext>
  handlers?: BookmarkContextMenuHandlers
  labels?: { unpin?: string }
  source?: string
}

export type BookmarkContextMenu = (
  x: number,
  y: number,
  bookmark?: BookmarkMenuNode | null
) => Promise<string | null>

/**
 * 造一个「书签项右键菜单」函数。
 *
 * @param {{
 *   popMenu: (payload: { x: number, y: number, items: Array<object>, context: object }) => Promise<string|null>,
 *   handlers?: {
 *     onOpen?: (bookmark: object) => void,
 *     onOpenNewTab?: (bookmark: object) => void,
 *     onOpenSidebar?: (bookmark: object) => void,
 *     onEdit?: (bookmark: object) => void,
 *     onUnpin?: (bookmark: object) => void,
 *     onDelete?: (bookmark: object) => void
 *   },
 *   labels?: { unpin?: string },
 *   source?: string
 * }} opts
 *   `labels.unpin`：取消固定的文案（两个宿主各自不同）；缺省用通用文案。
 *   `source`：写进插件插槽快照的**来源标识**（`'bookmarkbar'` / `'rail'`）——
 *   插件据此知道这条菜单是从哪儿弹出来的。**不放插槽 id**：种类→插槽的映射在主进程白名单里。
 * @returns {(x: number, y: number, bookmark: object) => Promise<string|null>}
 */
export function createBookmarkContextMenu({
  popMenu,
  handlers = {},
  labels = {},
  source = 'bookmarkbar'
}: BookmarkContextMenuOptions = {}): BookmarkContextMenu {
  const H = handlers || {}
  const unpinLabel = typeof labels.unpin === 'string' && labels.unpin ? labels.unpin : '取消固定'

  return async function showBookmarkContextMenu(x, y, bookmark) {
    if (typeof popMenu !== 'function') return null
    const b = bookmark || {}
    /**
     * 有没有 url —— **"打开类"与"编辑"可见性的唯一判据**。
     *
     * 文件夹（书签栏可以固定文件夹）没有 url：「打开 / 在新标签页打开 / 在侧栏打开」
     * 对它全是"点了没反应"的项 —— 按本项目的 S4 口径，这种情况的正确做法是
     * **菜单里根本不出现这些项**（菜单永远只反映"此刻能做什么"），
     * 而不是给一个会被静默忽略的动作。「编辑…」同理：编辑器是**书签**编辑器（要 url），
     * 对文件夹它只会开出一个存不进去的空窗。
     *
     * 「取消固定」与「删除」对两者都成立（删除的文案与落点按类型分）。
     */
    const hasUrl = !!b.url

    let action: string | null = null
    try {
      action = await popMenu({
        x,
        y,
        items: [
          { label: '打开', action: 'open', visible: hasUrl },
          { label: '在新标签页打开', action: 'openNewTab', visible: hasUrl },
          // 「在侧栏打开」—— 把这个书签放进**独立侧栏**（与面板无关的另一套系统）。
          { label: '在侧栏打开', action: 'openSidebar', visible: hasUrl },
          { type: 'separator' },
          { label: '编辑…', action: 'edit', visible: hasUrl },
          { label: unpinLabel, action: 'unpin' },
          { label: hasUrl ? '删除书签' : '删除文件夹', action: 'delete' }
        ] as MenuItem[],
        /**
         * 官方插槽 `bookmark.context-menu`：插件/社区 Mod 贡献的菜单项由**主进程**
         * 追加到菜单尾部，点击也在主进程内派发（onSelect 是主进程里的闭包），
         * 因此它们**不会**出现在下面的 action 分支里。
         */
        context: {
          kind: 'bookmark',
          snapshot: {
            bookmark: {
              id: b.id,
              url: b.url || '',
              title: b.title || '',
              parentId: b.parentId || null,
              isFolder: !hasUrl
            },
            source
          }
        }
      })
    } catch {
      action = null
    }

    switch (action) {
      case 'open': if (H.onOpen) H.onOpen(b); break
      case 'openNewTab': if (H.onOpenNewTab) H.onOpenNewTab(b); break
      case 'openSidebar': if (H.onOpenSidebar) H.onOpenSidebar(b); break
      case 'edit': if (H.onEdit) H.onEdit(b); break
      case 'unpin': if (H.onUnpin) H.onUnpin(b); break
      case 'delete': if (H.onDelete) H.onDelete(b); break
      default: break
    }
    return action
  }
}
