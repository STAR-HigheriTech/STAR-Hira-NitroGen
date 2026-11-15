/**
 * bookmark-controller.js —— 书签状态控制器（星标 + 书签栏）
 *
 * 从 app-shell/main.js 抽出的**内聚状态机**，是 renderer 唯一书签状态持有者：
 *   · 星标：URL 变化（tab 切换/导航）→ 查库对账；任何来源的书签变更 → 失效缓存重对账；
 *     点击 → 打开编辑器（不再静默加/删），样式等 bookmark:changed 广播回来再刷新。
 *   · 书签栏（pinned bar）：可见性走设置键 app.bookmarkbar_visible（三态：
 *     始终 / 仅新标签页 / 从不），支持热更新，并随活动标签变化重算。
 *
 * 彻底解耦：组件（ui-bookmarkbar / navbar 星标）保持哑；本控制器是唯一状态源；
 * 所有依赖经 deps 注入（document / shell / clients / 平台回调），不读全局、不发裸通道。
 *
 * 与 app-shell/main.js 的关系：本文件 0 行跨域编排，main.js 只负责装配注入。
 */

import { createBookmarkbar, type BookmarkbarItem } from '@hira-ng/ui-bookmarkbar'
// 书签「打开去向」的**唯一一份**规则（默认当前标签 / Ctrl 新标签 / Shift 侧栏）。
// 三处点击入口（书签栏 / 收藏面板 / 书签页）共用它 —— 各写各的必然漂移。
import { resolveBookmarkOpenTarget, openBookmarkTarget } from '@hira-ng/ui-common'
// 书签项右键菜单的**唯一一份**定义（书签栏 与 rail 固定项共用；这里只提供"从书签栏取消固定"
// 这条文案与它自己的业务落点，菜单结构/可见性/插件插槽快照全在共用件里）。
import { createBookmarkContextMenu } from '@hira-ng/ui-common'
import type { PopMenu } from '@hira-ng/ui-common'
// 「在侧栏打开」走独立侧栏的客户端（不要在这里手写通道名 —— 那是第二份真源）。
import { webSidebarClient } from '../shared/web-sidebar-client.js'
import {
  BOOKMARKBAR_SETTING_KEY,
  DEFAULT_BOOKMARKBAR_MODE,
  normalizeBookmarkbarMode,
  isBookmarkbarVisible,
  toggleBookmarkbarMode
} from '@hira-ng/shared-types/src/bookmarkbar.mjs'
import type { BookmarkbarMode } from '@hira-ng/shared-types/src/bookmarkbar.mjs'
// 「算不算普通网页」的唯一判据（星标只对可收藏的 web URL 有意义）。
import { isHttpUrl } from '@hira-ng/shared-types/src/url-protocols.mjs'
import type { JsonRecord, RendererProvider } from '../shared/bridge.js'

type TabsClient = typeof import('../shared/tabs-client.js').tabsClient
type BookmarksClient = typeof import('../shared/bookmarks-client.js').bookmarksClient

interface BookmarkActiveTab {
  url?: string
  title?: string
}

interface BookmarkControllerOverlay {
  showTargetPicker?(payload: Record<string, unknown>): void
  hideTargetPicker?(): void
  warmTargetPicker?(): void
}

export interface BookmarkControllerDeps {
  document: Document
  shell: { setBookmarkStar(...args: unknown[]): unknown }
  tabsClient: TabsClient
  bookmarksClient: BookmarksClient
  provider: RendererProvider
  getActiveTab(): BookmarkActiveTab | null
  showNativeMenu: PopMenu
  overlay?: BookmarkControllerOverlay
  navigateInternal(page: string): void
  isFeatureAvailable?(featureId: string): boolean
  isNewTabPage?(): boolean
  onBarVisibilityChange?(shown: boolean): void
  openPanel?(panelId: string): void
}

/** 星标只对可收藏的 web URL 有意义（内部页/空页隐藏） */
function isBookmarkableUrl(url: unknown) {
  return isHttpUrl(url)
}

/**
 * @param {BookmarkControllerDeps} deps
 */
export function createBookmarkController(deps: BookmarkControllerDeps) {
  const { document, shell, tabsClient, bookmarksClient, provider, getActiveTab, showNativeMenu, navigateInternal } = deps
  const isFeatureAvailable = typeof deps.isFeatureAvailable === 'function' ? deps.isFeatureAvailable : () => true
  // 未注入时保守取「不是新标签页」：宁可少显示，也不要在普通网页上凭空多出一条书签栏。
  const isNewTabPage = typeof deps.isNewTabPage === 'function' ? deps.isNewTabPage : () => false
  /**
   * 书签栏可见性变化的上行通知（注入而非 import：本控制器不认识外壳布局）。
   * @type {((shown: boolean) => void)|undefined}
   */
  const onBarVisibilityChange: ((shown: boolean) => void)|undefined = typeof deps.onBarVisibilityChange === 'function' ? deps.onBarVisibilityChange : undefined
  /**
   * 「转到收藏面板」的落点（注入而非 import：面板目录查找与展开侧由外壳裁定）。
   * 书签夹下拉超上限时会回传 `{ kind:'target-picker-open-panel', panelId }`，
   * 控制器只把它转交给外壳 —— 与站点信息浮层的 siteinfo-action 同一条纪律。
   * @type {((panelId: string) => void)|null}
   */
  const openPanel: ((panelId: string) => void)|null = typeof deps.openPanel === 'function' ? deps.openPanel : null

  // ── 星标状态 —— 唯一持有者 ──
  let disposed = false
  let unsubscribeChanged = () => {}
  const starState: { url: string | null; bookmarked: boolean } = { url: null, bookmarked: false }

  // ── 书签栏状态 ──
  // mode：设置里的三态（always / newtab / never）。之所以缓存它而不是每次去问设置，
  // 是因为「活动标签切换」这个高频路径也要重算可见性 —— 每次都发一次 IPC 会让切标签变卡。
  const barState: { items: BookmarkbarItem[]; mode: BookmarkbarMode } = { items: [], mode: DEFAULT_BOOKMARKBAR_MODE }

  /**
   * 书签引擎是否还在（§10.4 联动禁用）。
   *
   * 「引擎没了」与「用户把书签栏关了」是两件事，但对外表现都是"不显示"，所以这里
   * 合成一个输出：`renderBar` 用 `visible && engineAvailable` 决定最终可见性。
   * 分开保存两份状态很重要 —— 引擎恢复时不能把用户自己的开关设置覆盖掉。
   */
  let engineAvailable = isFeatureAvailable('bookmarks')

  /**
   * 书签项右键菜单 —— 结构/可见性/插件插槽快照全在共用件里（与 rail 固定项同一份），
   * 这里只落"书签栏"这一侧的业务调用与那条只有它才对的文案。
   */
  const showBookmarkMenu = createBookmarkContextMenu({
    popMenu: showNativeMenu,
    labels: { unpin: '从书签栏取消固定' },
    source: 'bookmarkbar',
    handlers: {
      onOpen: (item) => { if (item.url) tabsClient.navigate({ url: item.url }) },
      onOpenNewTab: (item) => { if (item.url) tabsClient.newTab({ url: item.url }) },
      onOpenSidebar: (item) => {
        // 在独立侧栏打开：主进程负责"造/加载那个网页视图 + 把它摆到侧栏区域"
        if (item.url) webSidebarClient.open(item.url, { title: item.title || '' }).catch(() => {})
      },
      onEdit: (item) => { if (item.url) openEditor({ url: item.url, title: item.title }, 'edit') },
      onUnpin: (item) => { if (item.id) bookmarksClient.pinnedSet(item.id, false).catch(() => {}) },
      // 删除：书签按 url、文件夹按 id（它没有 url）。菜单对文件夹那条的文案是「删除文件夹」，
      // 但动作落到同一条 domain#remove（连带子项）。
      onDelete: (item) => {
        if (item.url) bookmarksClient.removeByUrl(item.url).catch(() => {})
        else if (item.id) bookmarksClient.remove(item.id).catch(() => {})
      }
    }
  })

  // ── 书签栏里的文件夹 → 通用「选择目标」浮层的 bookmark 来源 ─────────────
  //
  // 文件夹项左键只上抛意图（哑组件），这里把它落到「弹一块贴着该项下缘的浮层」上。
  // 浮层是**独立原生视图**（renderer/target-picker-overlay）：内容（该文件夹的子书签）
  // 由浮层自己拉，本控制器只负责开与收 —— 与「收进集锦…」共用同一份实现，
  // 场景差异全部收在浮层的来源表里（见 renderer/shared/target-picker.js 的来源契约）。
  //
  // 「收起判据的分工」——每个触发点**只有一处实现**，绝不两套并存：
  //   · **点卡片之外 / 滚轮** → 浮层自己（它铺满整窗，那一击落在它的透明区域里），
  //     判定后经 `overlay:commit{kind:'target-picker-dismiss'}` 回传到**这里**收起
  //     （见 app-shell 的 overlay:commit 分支）——与「总览」浮层的收起判据同一口径。
  //   · **Esc** → 本控制器（浮层不抢键盘焦点，focusPriority=0，键盘事件留在外壳）。
  //   · **切标签 / 窗口失焦** → **主进程**权威收起（browser-window-runtime / -assembly），
  //     随后经 `overlay:closed` 回传到外壳 → closeFolderOverlay。
  //
  // `pickerId` 是本次打开的一次性令牌：浮层的 commit 是**异步回传**的，而用户可能在
  // 回传到达前又打开了另一个文件夹 —— 只比对 pickerId 才能保证「关的是刚开的这一只」。
  const overlay = deps.overlay || null
  let folderOverlayOpen = false
  let folderPickerId: string | null = null
  let pickerSeq = 0

  /**
   * 文件夹子项**预取缓存**（folderId → { items, at, pending }）。
   *
   * 悬停 / 按下文件夹时（`onFolderIntent`）就把子项取好，打开时随 show 一起交给浮层 ——
   * 浮层首帧即有条目，不必再等一次 IPC 往返（那正是「点开先空一拍」的来源）。
   * 任何书签变更（`refreshBar`）都会整体作废；另有 TTL 兜住"别处改了但广播没来"。
   */
  const folderPrefetch = new Map<string, { items: BookmarkbarItem[] | null; at: number; pending: boolean }>()
  let barRefreshRevision = 0
  const FOLDER_PREFETCH_TTL = 8000

  /** 取一份**新鲜的**预取结果；过期 / 正在取 / 没取过 → 返回 null（调用方走常规加载）。 */
  function freshPrefetch(id: unknown): BookmarkbarItem[] | null {
    const hit = folderPrefetch.get(String(id))
    if (!hit || hit.pending || !hit.items) return null
    if (Date.now() - hit.at > FOLDER_PREFETCH_TTL) return null
    return hit.items
  }

  /** 意图期预取某个文件夹的子项（幂等：同一文件夹在 TTL 内只发一次 IPC）。 */
  function prefetchFolder(item: BookmarkbarItem): void {
    const id = item && item.id ? String(item.id) : ''
    if (!id || !engineAvailable) return
    const hit = folderPrefetch.get(id)
    if (hit && (hit.pending || Date.now() - hit.at <= FOLDER_PREFETCH_TTL)) return
    // 只留最近几个文件夹的预取（悬停穿行会扫过很多项）：不做无界缓存。
    if (folderPrefetch.size >= 8) folderPrefetch.clear()
    const entry: { items: BookmarkbarItem[] | null; at: number; pending: boolean } = { items: null, at: 0, pending: true }
    folderPrefetch.set(id, entry)
    bookmarksClient.list(id).then((rows) => {
      if (disposed) return
      entry.items = Array.isArray(rows) ? rows : []
      entry.at = Date.now()
      entry.pending = false
    }).catch(() => {
      folderPrefetch.delete(id)
    })
  }

  /**
   * 收起文件夹浮层（幂等；未开时为安全空操作 —— 同 space-controller#closeMenu）。
   * 开合真源在这里：浮层自己不判"该不该显示"，所有收起信号都收敛到这一个点。
   */
  function closeFolderOverlay() {
    if (!folderOverlayOpen) return
    folderOverlayOpen = false
    folderPickerId = null
    try { if (overlay && typeof overlay.hideTargetPicker === 'function') overlay.hideTargetPicker() } catch (_) {}
  }

  /** 打开某文件夹的浮层列表：只交**事实**（来源 / 层级 id / 标题 / 锚点 / 令牌），不碰内容。 */
  function openFolderOverlay(item: BookmarkbarItem, anchorRect: DOMRect): void {
    if (!overlay || typeof overlay.showTargetPicker !== 'function') return
    folderPickerId = `bf_${Date.now()}_${++pickerSeq}`
    folderOverlayOpen = true
    // 意图期已经取到的子项随 show 一起送过去（预取载荷）—— 浮层首帧即有内容；
    // 浮层随后仍会用权威数据核对一次，内容一致就不再重绘（见 shared/target-picker.js）。
    const preloaded = freshPrefetch(item.id)
    try {
      overlay.showTargetPicker({
        source: 'bookmark',
        levelId: String(item.id),
        title: item.title || '',
        pickerId: folderPickerId,
        anchor: anchorRect
          ? { left: anchorRect.left, top: anchorRect.top, right: anchorRect.right, bottom: anchorRect.bottom }
          : null,
        ...(preloaded ? { items: preloaded } : {})
      })
    } catch (_) {}
  }

  /**
   * 浮层回传（select / dismiss / open-panel）的唯一入口 —— 由外壳的 `overlay:commit` 分支转发。
   * 只认「本控制器开的那一只」（source + pickerId）；不认识的载荷原样放行（返回 false），
   * 让其它打开方（例如「收进集锦…」）去处理。
   *
   * `target-picker-open-panel` = 用户点了末尾那条「还有 N 项 · 转到收藏面板」：
   * 收起浮层后把**面板 id 原样转交**给外壳（本控制器不认识面板目录，只认识书签栏）。
   * @returns {boolean} 是否已被本控制器消化
   */
  function handleTargetPickerCommit(payload: Record<string, unknown>) : boolean {
    if (!payload || typeof payload !== 'object') return false
    if (payload.source !== 'bookmark') return false
    if (
      payload.kind !== 'target-picker-select' &&
      payload.kind !== 'target-picker-dismiss' &&
      payload.kind !== 'target-picker-open-panel'
    ) return false
    if (!folderOverlayOpen || payload.pickerId !== folderPickerId) return false
    closeFolderOverlay()
    // 去向由外壳裁定（openPanel 是注入的端口）：控制器只把 id 递过去。
    if (payload.kind === 'target-picker-open-panel' && openPanel && payload.panelId) {
      try { openPanel(String(payload.panelId)) } catch (_) {}
    }
    return true
  }

  /** Esc 收起（本层拿不到键盘焦点，故由外壳兜底 —— 与选择目标浮层同一口径）。 */
  function onFolderOverlayEscape(e: KeyboardEvent) {
    if (!folderOverlayOpen || e.key !== 'Escape') return
    e.preventDefault()
    closeFolderOverlay()
  }

  document.addEventListener('keydown', onFolderOverlayEscape, true)

  const bookmarkbar = createBookmarkbar(document, {
    onNavigate: (item, modifiers) => {
      if (!item || !item.url) return
      // 点书签即离开"看文件夹"的语境 → 收起文件夹浮层（它是挂在某个文件夹项上的）。
      closeFolderOverlay()
      // 去向由**唯一一份**规则决定（修饰键 > 书签自己的"默认在侧栏打开"偏好 > 当前标签），
      // 「去向 → 动作」的映射也只此一份（ui-common#openBookmarkTarget）——
      // 这里只交端口：本渲染进程知道的三个动作 + 一个"找已有标签"的查询。
      // Ctrl 新标签 / **Alt 转到已有或新开** / Shift 侧栏 / 无修饰键当前标签。
      const target = resolveBookmarkOpenTarget(modifiers, (item as typeof item & { openInSidebar?: boolean }).openInSidebar)
      openBookmarkTarget(target, {
        url: item.url,
        openCurrent: (url) => tabsClient.navigate({ url }),
        openTab: (url) => tabsClient.newTab({ url }),
        openSidebar: (url) => webSidebarClient.open(url, { title: item.title || '' }).catch(() => {}),
        // Alt 的"已有就转过去"：查一次打开中的标签（异步），命中就切换、否则新开。
        findTabId: (url) => tabsClient.list().then((tabs) => {
          const hit = (Array.isArray(tabs) ? tabs : []).find((t) => t && t.url === url)
          return hit ? hit.id : null
        }).catch(() => null),
        switchTab: (id) => tabsClient.switchTab(id)
      })
    },
    onContextMenu: (item, pos) => {
      showBookmarkMenu(pos.x, pos.y, item as Parameters<typeof showBookmarkMenu>[2])
    },
    // 文件夹项左键：只上抛意图，落到「弹一块贴着它下缘的浮层列表」上（见上）。
    onOpenFolder: (item, anchorRect) => {
      openFolderOverlay(item, anchorRect)
    },
    // 文件夹项意图：hover / press 时预热「选择目标」浮层 + 预取子项。
    // 两件事都落在意图期：视图先在后台建好，内容也在后台取好 —— 点下去只剩"摆出来"。
    // 组件只报意图；浮层名与通道全在 overlay-adapter 内部。
    onFolderIntent: (item) => {
      if (overlay && typeof overlay.warmTargetPicker === 'function') {
        overlay.warmTargetPicker()
      }
      prefetchFolder(item)
    },
    // 从其它面板（标签 / 集锦 / 历史 / 画板）按统一协议拖进来的内容：
    // 书签栏只认 URL —— 有 url 就存成书签，落点在栏上自然就是"钉住"。
    onExternalDrop: (item) => {
      if (!item || !item.url) return
      bookmarksClient.add({ url: item.url, title: item.title || item.url })
        .then(() => refreshBar())
        .catch(() => {})
    },
    onReorder: (orderedIds) => {
      // 乐观更新（拖拽要跟手），失败或广播回来再对账
      barState.items = orderedIds
        .map((id) => barState.items.find((it) => it.id === id))
        .filter((item): item is BookmarkbarItem => item !== undefined)
      bookmarkbar.setItems(barState.items)
      bookmarksClient.pinnedReorder(orderedIds).catch(() => refreshBar())
    }
  })

  // ─────────────────────────────────────────────────────────
  // 星标
  // ─────────────────────────────────────────────────────────

  async function refreshStar() {
    // 引擎被禁用 → 直接收起星标，不去打必然失败的 IPC（那只会刷控制台错误）。
    // 星标 DOM 本身由 navbar 目录收起（外壳按钮带 feature: 'bookmarks'），
    // 这里管的是"它的状态"—— 两处是同一件事的两面。
    if (!engineAvailable) return
    const tab = getActiveTab()
    const url = tab && isBookmarkableUrl(tab.url) ? tab.url : null
    if (!url) {
      if (starState.url !== null) {
        starState.url = null
        starState.bookmarked = false
        shell.setBookmarkStar({ visible: false })
      }
      return
    }
    // 同 URL 不重复 IPC：renderTabs 在每次 tab:changed 都会进来
    if (url === starState.url) return
    starState.url = url
    try {
      const hit = await bookmarksClient.getByUrl(url)
      // 查询期间用户已切走 → 丢弃这次结果，等下一次刷新
      if (disposed || starState.url !== url) return
      starState.bookmarked = !!hit
      shell.setBookmarkStar({
        visible: true,
        active: !!hit,
        title: hit ? 'Edit bookmark' : 'Bookmark this page'
      })
    } catch (e) {
      console.error('[bookmark-controller] bookmark:get-by-url failed:', e)
    }
  }

  // 星标点击 → 打开书签编辑器（对齐老 Hira「收藏即编辑」闭环，不再静默加/删）
  function openEditorForCurrentTab() {
    const tab = getActiveTab()
    if (!tab || !isBookmarkableUrl(tab.url)) return
    openEditor({ url: tab.url, title: tab.title || tab.url }, starState.bookmarked ? 'edit' : 'add')
  }

  // ─────────────────────────────────────────────────────────
  // 书签栏
  // ─────────────────────────────────────────────────────────

  function renderBar() {
    bookmarkbar.setItems(barState.items)
    // 三份状态合成一个输出，各自独立保留：
    //   · barState.mode  —— 用户的选择（始终 / 仅新标签页 / 从不）
    //   · isNewTabPage() —— 当前这一页是不是新标签页（只影响 newtab 模式）
    //   · engineAvailable —— 引擎是否还在（关掉时不能覆盖用户的选择，见上）
    bookmarkbar.setVisible(isBookmarkbarVisible(barState.mode, isNewTabPage()) && engineAvailable)
    // 每次可见性变化都通知编排层（**所有**变化都经过这里，所以这是唯一需要通知的点）：
    // 不可见的书签栏要从外壳布局里**注销**，否则它会占着一个空行 ——
    // 底部留白那类容器级样式会在「底部一块 bar 都没有」时凭空多出一条边距。
    // 值是组件自己的判定（它还要看有没有内容），不在这里重算一份。
    if (typeof onBarVisibilityChange === 'function') {
      try { onBarVisibilityChange(bookmarkbar.isVisible()) } catch (_) {}
    }
  }

  /**
   * 活动标签变化时的**轻量重算**：只重算可见性，不重查固定书签。
   * 切标签是高频路径（每次 commit 都会来），而固定书签列表与标签无关 ——
   * 重新查库只会让切标签多一趟 IPC 往返。
   */
  function refreshBarVisibility() {
    renderBar()
  }

  async function refreshBar() {
    const revision = ++barRefreshRevision
    // 固定书签集合变了（增删/其它窗口改）→ 浮层锚点对应的项可能已不在原地，先收起。
    closeFolderOverlay()
    // 书签有变更 → 意图期预取的子项一律作废（下一次悬停重新取）。
    folderPrefetch.clear()
    if (!engineAvailable) {
      // 引擎没了：清空并收起，不留上一次的旧数据（否则它会在重新启用前一直挂着旧书签）
      barState.items = []
      renderBar()
      return
    }
    try {
      const items = await bookmarksClient.pinnedList()
      if (disposed || revision !== barRefreshRevision) return
      barState.items = items
      renderBar()
    } catch (e) {
      console.error('[bookmark-controller] bookmark:pinned-list failed:', e)
    }
  }

  /**
   * 引擎可用性变化的收敛点（由编排层在 `onFeaturesChanged` 里调用）。
   *
   * 幂等：可用性没变就什么都不做 —— 这个回调挂在全局插件广播上，而广播里
   * 绝大多数事件（别的插件启停）与书签无关。
   */
  function syncEngineAvailability() {
    const next = isFeatureAvailable('bookmarks')
    if (next === engineAvailable) return
    engineAvailable = next
    if (next) {
      refreshBar()
      refreshStar()
    } else {
      starState.url = null
      starState.bookmarked = false
      shell.setBookmarkStar({ visible: false })
      refreshBar()
    }
  }

  /**
   * 从设置读回书签栏显示模式（启动一次 + settings:changed 热更新时调用）。
   *
   * 读的是**原始值**，交给 normalizeBookmarkbarMode 归一：老 profile 里可能是布尔
   * （历史版本只有显示/隐藏两态），归一后与设置页下拉、主进程菜单用的是同一套取值。
   */
  async function loadBarMode() {
    try {
      const s = await provider.invoke('settings:list', { section: 'app' })
      if (disposed) return
      const raw = s ? s[BOOKMARKBAR_SETTING_KEY] : undefined
      if (raw !== undefined && raw !== null) barState.mode = normalizeBookmarkbarMode(raw)
    } catch (_) {}
    renderBar()
  }

  /**
   * Ctrl+Shift+B / 菜单开关的渲染侧入口（与主进程 keybindings 同语义）：
   * 「启用 ←→ 完全不显示」两态切换，不做三档循环（循环要按两下才回到原状）。
   */
  async function toggleBarVisible() {
    const next = toggleBookmarkbarMode(barState.mode)
    barState.mode = next
    renderBar()
    try {
      await provider.invoke('settings:set', { key: BOOKMARKBAR_SETTING_KEY, value: next })
    } catch (_) {}
  }

  /** 打开书签编辑器子窗口（add/edit 共用，payload 走 URL 参数；mode 决定窗口 type） */
  function openEditor(payload: Record<string, unknown>, mode: 'add' | 'edit' = 'edit') {
    const type = mode === 'add' ? 'add-bookmark' : 'edit-bookmark'
    provider.invoke('window:open', { type, payload })
      .catch((e) => console.error('[bookmark-controller] open bookmark editor failed:', e))
  }

  // 任何书签变更（含其他窗口/未来的扩展 API）→ 失效缓存，重新对账。
  unsubscribeChanged = bookmarksClient.onChanged(() => {
    starState.url = null
    refreshStar()
    refreshBar()
  })

  // 星标右键 / navbar「菜单」入口需要暴露给 main.js 使用
  function openEditorForActiveTab(mode?: unknown) {
    const tab = getActiveTab()
    if (tab && isBookmarkableUrl(tab.url)) {
      openEditor(
        { url: String(tab.url), title: String(tab.title || '') },
        mode === 'edit' || mode === 'add' ? mode : (starState.bookmarked ? 'edit' : 'add')
      )
    }
  }

  return {
    element: bookmarkbar.element,
    refreshStar,
    refreshBar,
    // 书签栏显示模式：启动读一次 / settings:changed 时重读；活动标签变化时只重算可见性
    loadBarMode,
    refreshBarVisibility,
    /**
     * 书签栏此刻是否真的可见（有内容 + 被允许显示）。
     * 编排层据此把它登记进外壳布局或从布局里注销；也用于控制器创建前漏掉通知时的初始对账。
     * @returns {boolean}
     */
    isBarVisible: () => bookmarkbar.isVisible(),
    toggleBarVisible,
    // §10.4：引擎被禁用/恢复时由编排层调用，收敛星标与书签栏
    syncEngineAvailability,
    openEditorForCurrentTab,
    openEditorForActiveTab,
    isBookmarked: () => starState.bookmarked,
    /**
     * 收起文件夹浮层 —— 由**外壳**在收到浮层回传的 `overlay:commit{kind:'target-picker-dismiss'|'target-picker-select'}`
     * 与主进程兜底的 `overlay:closed` 时调用（浮层不认识外壳的开合状态，收起必须由这里裁定）。
     */
    closeFolderOverlay,
    /** 浮层回传入口（source==='bookmark' 且 pickerId 匹配时才消化），见上方注释。 */
    handleTargetPickerCommit,
    dispose() {
      if (disposed) return
      disposed = true
      barRefreshRevision += 1
      unsubscribeChanged()
      // 外壳的 Esc 兜底监听随控制器一起摘（控制器与外壳同生共死，摘干净不留悬空引用）。
      document.removeEventListener('keydown', onFolderOverlayEscape, true)
      bookmarkbar.element.remove()
    }
  }
}


