import {
  createTabbar,
  type TabStackState,
  type TabViewState,
  type TabbarOptions,
  type TabbarProjection,
  type TabbarProjectionItem,
  type TabbarRendererSlots
} from '@hira-ng/ui-tabbar'
import {
  stackTogether,
  leaveStack,
  fireStackRequest,
  createStackMenuHandlers,
  type StackMenuClient,
  type TabStackClient
} from '@hira-ng/ui-common'
import { createSplitMenuHandlers } from '../shared/tab-split-actions.js'
import { createGlanceMenuHandlers } from '../shared/tab-glance-actions'
// PWA「安装为应用 / 在应用中打开」—— 与纵向列表 / 面板 / 地址栏按钮**同一条**流程。
import { pwaMenuHandlers } from '../shared/pwa-actions.js'
// 固定文件夹的三个端口（列出 / 移入已有 / 新建）—— 与面板 / 纵向列表取**同一份**。
import { pinnedFolderPorts } from '../shared/pinned-folder-actions.js'
import {
  buildCollectionMenuEntries,
  captureToCollectionTarget,
  collectionTargetFromAction,
  toActionMenuItems
} from '@hira-ng/shared-types/src/collection-menu.mjs'
import { notesClient, isFeatureAvailable } from '../shared/hira-client.js'
// 容器标签（N10）要列"别的身份"—— profile 目录走既有的渲染侧 profile 客户端。
import { profilesClient } from '../shared/profile-client.js'
// 分享页地址的唯一构造函数（N15）—— 与标签栏那份同源。
import { shareUrlFor } from '@hira-ng/shared-types/src/share.mjs'

/**
 * @param {object} [deps.slots] 标签条的**渲染侧插槽调用器**（由 app-shell 端口注入）。
 *   `{ itemDecorator, stackDecorator, dropTargetAccepter }` —— 前两个是「给我一个元素」
 *   （标签行装饰 / 标签组芯片装饰），最后一个是「这次拖放归插件吗」。本控制器不认识
 *   插件系统，只把它透传给 `createTabbar`（ui 包更不认识）。
 * @param {(projection: unknown[], flat: unknown[]) => void} [deps.onProjection]
 *   每次渲染后把同一份投影再喂给**其它呈现**（当前用途：垂直标签列）。
 *   本控制器不知道消费方是谁 —— 于是「再加一个标签呈现」不必改这里，也不必多订一次数据。
 * @param {(tabId: string) => void} [deps.onPermissionRequest]
 *   用户点了某条标签上的「权限请求」标记。本控制器只负责**切到那条标签**并把意图上抛，
 *   浮层由 chrome（navbar）负责 —— 标签条不认识权限模型，也不认识 overlay。
 */
interface ActiveTabChangeMeta { isNew: boolean; isFirst: boolean }

interface TabSessionDependencies {
  document: Document
  tabsClient: typeof import('../shared/tabs-client.js').tabsClient
  showNativeMenu?: TabbarOptions['showMenu']
  overlay?: TabbarOptions['overlay']
  onActiveTabChange?: (tab: TabViewState | null, meta: ActiveTabChangeMeta) => void
  onShowRecentlyClosed?: () => void
  slots?: TabbarRendererSlots
  onProjection?: (projection: TabbarProjection, flat: readonly TabViewState[]) => void
  onPermissionRequest?: (tabId: string) => void
}

interface TabSessionStats { total: number; pinned: number; audio: number }
type ProjectionList = readonly TabbarProjectionItem[]

export interface TabSessionController {
  element: HTMLElement
  getTabs(): TabViewState[]
  getActiveTab(): TabViewState | null
  getActiveTabId(): string | null
  getVisibleAfter(): string[]
  getStats(): TabSessionStats
  refresh(): Promise<void>
  render(projection: unknown, flatTabs?: unknown): void
  setPermissionMarks(marks: Map<string, readonly string[]> | Record<string, readonly string[]> | null | undefined): void
  start(): () => void
  dispose(): void
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' ? value as Record<string, unknown> : null
}

function isProjectionItem(value: unknown): value is TabbarProjectionItem {
  const record = asRecord(value)
  if (!record) return false
  if (record.type === 'stack') return typeof record.stackId === 'string'
  return typeof record.tabId === 'string'
}

function projectionFrom(value: unknown): ProjectionList {
  return Array.isArray(value) ? value.filter(isProjectionItem) : []
}

function tabsFrom(value: unknown): TabViewState[] {
  return Array.isArray(value)
    ? value.filter((item): item is TabViewState => isProjectionItem(item) && item.type !== 'stack')
    : []
}

export function createTabSessionController({
  document,
  tabsClient,
  showNativeMenu,
  overlay,
  onActiveTabChange,
  onShowRecentlyClosed,
  slots,
  onProjection,
  onPermissionRequest
}: TabSessionDependencies): TabSessionController {
  let disposed = false
  let unsubscribe = () => {}
  let tabs: TabViewState[] = []
  let activeTabId: string | null = null
  let stats: TabSessionStats = { total: 0, pinned: 0, audio: 0 }
  // 已知标签 id：用于识别「本渲染层从未见过的新标签」（启动首个标签 / 新建标签）。
  // 切回已存在的标签不会命中 —— 避免每次切标签都去打扰地址栏。
  const knownTabIds = new Set<string>()
  let seenFirstProjection = false

  // ── 权限请求标记（tabId → 图标键名数组）────────────────────────────────
  //
  // 数据由 app-shell 从 permission-state 派生后喂进来（`setPermissionMarks`）——
  // 本控制器不认识权限模型，只负责「把标记叠到投影上、并在变化时重画一次」。
  //
  // 数组引用必须**稳定**：纵向标签列按引用比较跳过 DOM 写入，内容相同就复用同一个数组。
  const permissionMarks = new Map<string, readonly string[]>()
  // 本轮/上轮是否存在标记。用来决定「要不要给投影补 permissionIcons 字段」：
  // 从有到无的那一轮也必须补一次（补 null），否则 keyed diff 不会调 Tab.update → 图标残留。
  let marksActive = false
  let marksApplied = false
  let lastProjection: ProjectionList = []
  let lastFlat: TabViewState[] = []
  let projectionRequest = 0
  const stackClient = tabsClient as unknown as TabStackClient
  const stackMenuClient = tabsClient as unknown as StackMenuClient

  /**
   * 扁平项查询（拖拽 / 右键的种类裁决要 `pinned`）。
   * 查不到就退成「只有 id」的记录 —— tab-policy 见到缺 `pinned` 会跳过 UI 裁决，
   * 由主进程按同一份策略兜底。
   */
  function itemOf(tabId: unknown): TabViewState | null {
    const id = String(tabId == null ? '' : tabId)
    if (!id) return null
    return tabs.find((t) => t && t.tabId != null && String(t.tabId) === id) || { tabId: id }
  }

  /** 投影里的某个标签组行（组行的 `pinned` 就是种类）。 */
  function stackOf(stackId: unknown): TabStackState | null {
    const id = String(stackId == null ? '' : stackId)
    if (!id) return null
    return (lastProjection.find((it) => it.type === 'stack' && String(it.stackId) === id) as TabStackState | undefined)
      || { type: 'stack', stackId: id }
  }

  const tabbar = createTabbar(document, {
    onSwitchTab: (tabId) => tabsClient.switchTab(tabId),
    // Alt/Option + 单击标签 = 与当前活动标签分屏（对齐 Firefox / Zen）。
    onSplitWithActive: (tabId) => tabsClient.splitWithActive(tabId),
    // Arc 式入口：拖标签到网页区域松手 = 与"拖动前正在看的那一格"分屏。
    // 只报两个 id —— 落点与判定都在主进程（见 TabManager#dropTabOnContent：
    // 四个纵向宿主跑在独立渲染进程里量不到主窗口外壳，且 dragend 的坐标已不可信）。
    onDropOnContent: (tabId, baseTabId) => tabsClient.dropTabOnContent({ tabId, baseTabId }),
    // 同一条链的**开始**那半：主进程据此起 30fps 光标采样，拖动期间画"这一格会落在哪"的
    // 落位预览（拖动期间渲染层收不到指针事件 —— 指针一进网页原生视图就离开外壳视口）。
    onDropOnContentBegin: (tabId, baseTabId) => tabsClient.beginTabDropOnContent({ tabId, baseTabId }),
    // 拖拽期能力提示：显隐由落点控制器按"指针是否还在外壳视口里"驱动
    onDragHintChange: (active) => tabbar.setDropHint(active),
    // 外部拖入：别的窗口的标签走**整体迁移**（保留 webContents / 导航历史），
    // 其它带 url 的载荷（集锦卡 / 书签 / 历史 / 画板卡片）才新建标签。
    onExternalDrop: (item, target) => {
      if (item && item.domain === 'tab') {
        const tabId = String(item.tabId || item.id || '')
        if (!tabId) return
        const targetId = target && target.kind === 'tab' ? String(target.tabId || '') : null
        void Promise.resolve(tabsClient.moveTabToWindow({
          tabId,
          targetId: targetId || null,
          insertAfter: target && target.kind === 'tab' ? target.insertAfter === true : false
        })).catch((error) => {
          console.warn('[tabs] cross-window move failed:', error instanceof Error ? error.message : error)
        })
        return
      }
      if (item && item.url) tabsClient.newTab({ url: item.url })
    },
    onToggleStack: (stackId) => tabsClient.toggleStack(stackId),
    onRenameStack: (stackId, label) => tabsClient.renameStack(stackId, label),
    // 标签组的四个动作整包（解散 / 平铺 / 合并 / 配色）—— 与纵向列表取的是**同一个函数
    // 造出来的同一份**（actions 表住在 ui-common，见 tab/chipMenu.ts 的说明）。
    stackMenu: createStackMenuHandlers(stackMenuClient),
    // 右键「与右侧标签堆叠 / 并入右侧标签组」：与修饰键拖拽同一条语义（见 tab-stack-actions）
    onStackWith: (tabId, target) => fireStackRequest(stackTogether(stackClient, itemOf(tabId), target)),
    // 右键「移出标签组」：单个标签脱离它所在的组（组还在，其余成员照旧）。
    // 固定标签的「离开」= 取消固定，由 leaveStack 按种类分流（真源 tab-policy）。
    onLeaveStack: (tabId) => fireStackRequest(leaveStack(stackClient, itemOf(tabId))),
    // 右键「按域名分组标签」：宿主收到的已是"要分哪些标签 + 域名"（判据与分组在
    // ui-tabbar 侧按投影算好，见 ui-tabbar/view/contextMenu.js），这里只负责落库 ——
    // 复用既有 stack-create，不新增通道。
    onGroupByDomain: (tabIds, domain) => fireStackRequest(tabsClient.createStack({ tabIds, label: domain })),
    // 「归档标签」（J9）：关闭 + 记入归档区（面板里可恢复）
    onArchive: (tabId) => fireStackRequest(tabsClient.archive(tabId)),
    // 标签行右键菜单的**动作整包** —— 与纵向列表 / 面板 / 侧栏取的是**同一批函数**
    // 造出来的同一份接线（`tab-row-menu.js` 与这里的差别只有"弹哪个宿主"）。
    // ⚠ 必须**整包**交给 ui-tabbar（它只透传、不认识特性）：曾经逐项列在 options 顶层，
    //   而 createTabbar 没解构、也没转交 —— 分屏那七项、"后来的速览三项"于是长期
    //   "能看见、点了没反应"。这里每加一个动作表，两端同时生效，不必改 ui 包。
    tabMenuHandlers: {
      getNavigationState: (tabId: string) => tabsClient.navigationEntries(tabId),
      ...createSplitMenuHandlers(tabsClient),
      ...createGlanceMenuHandlers(tabsClient),
      // PWA：横向标签条与纵向列表 / 面板共用同一份端口（探测态由主进程给）。
      ...pwaMenuHandlers,
      // 固定文件夹（= pinned 标签栈）：右键「添加到 / 移动到固定文件夹 ▸」与「新建文件夹…」。
      // 与面板 / 纵向列表**同一份**端口 —— 横向标签条只是转交（见 ui-tabbar/view/contextMenu.js）。
      ...pinnedFolderPorts,
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
      onCollectionAction: (tab: TabViewState, action: string) => {
        const target = collectionTargetFromAction(action)
        if (!tab?.url || !target) return
        void captureToCollectionTarget(notesClient, {
          url: tab.url,
          title: tab.title,
          tabId: tab.tabId == null ? undefined : String(tab.tabId)
        }, target)
      },
      /**
       * 容器标签（N10）：列"能用来当身份的别的 profile"。
       *
       * 判据只有一条：**不是这个标签自己所属的 profile**（用同一个身份再开一份没有意义）。
       * 另外排除无痕 profile —— 它是临时身份、不该出现在"长期身份"列表里。
       * 一个都没有（单 profile 环境）→ 返回空数组，菜单里那一整段就不出现（S4）。
       */
      listContainerProfiles: async (tab: TabViewState) => {
         try {
          // 用 listVisible：它已过滤掉 internal / 无痕这类"不该被用户选来当长期身份"的 profile。
          const res = await profilesClient.listVisible()
          const all = Array.isArray(res) ? res : []
          if (!Array.isArray(all)) return []
          const own = String((tab && tab.profileId) || 'default')
          return all
            .filter((p) => p && p.id && String(p.id) !== own && !p.incognito)
            .map((p) => ({ id: String(p.id), name: p.name || p.id, color: p.color || '' }))
        } catch (_) { return [] }
      },
      // 用选中的身份再开一份：URL 相同、Session 不同 —— 于是两个账号能同时在线。
      onOpenInContainer: (tab: TabViewState, profileId: string) => {
        if (tab && tab.url) tabsClient.newTab({ url: tab.url, containerProfileId: profileId })
      }
    },
    onCloseTab: (tabId) => tabsClient.closeTab(tabId),
    // 新建标签永远打开「新标签页」（主进程单一路径解析默认地址），不传 url
    onNewTab: () => tabsClient.newTab({}),
    // 拖拽落库分五条通道：
    //   · 拖到**空白处** → tab:stack-set(stackId=null) = 退出所在的标签组（纯出栈）
    //   · 拖到**组外的散标签**上（组内标签）→ 先出栈、再按落间距重排（见 leaveStack）
    //   · 拖到栈芯片 / 组内标签 → tab:stack-set(stackId) = 并入该组（拖入）
    //   · 与目标标签堆叠成组（修饰键 / 两边都散）→ 见 tab-stack-actions#stackTogether
    //   · 拖到标签间隙 → tab:reorder（算落位；跨栈落位时 domain 会自动脱离原栈）
    // 五条都是既有 IPC，不新增通道。
    onDragEnd: (payload) => {
      if (!payload) return null
      // 种类裁决要投影项（`pinned`）；裸 id 能让 tab-policy 走「无种类信息」分支。
      const dragged = itemOf(payload.draggedId)
      if (payload.leaveStack) {
        return fireStackRequest(leaveStack(stackClient, dragged, payload))
      }
      if (payload.stackWithItem) {
        return fireStackRequest(stackTogether(stackClient, dragged, payload.stackWithItem))
      }
      const request = payload.targetStackId != null
        ? stackTogether(stackClient, dragged, stackOf(payload.targetStackId))
        : tabsClient.reorder(payload as unknown as Parameters<typeof tabsClient.reorder>[0])
      return fireStackRequest(request)
    },
    onCloseOthers: (tabId) => tabsClient.closeOthers(tabId),
    onCloseRight: (tabId) => tabsClient.closeRight(tabId),
    onTogglePin: (tabId) => tabsClient.togglePin(tabId),
    onToggleMute: (tabId) => tabsClient.toggleMute(tabId),
    // 「定时刷新」（C7）：与标签栏那份同一客户端方法（两端行为必须一致）。
    onAutoRefresh: (tabId, ms) => tabsClient.setAutoRefresh(tabId, ms),
    // 「分享 / 生成二维码」（N15）：与标签栏那份同一客户端方法（两端行为必须一致）。
    onSharePage: (tab) => { if (tab && tab.url) tabsClient.newTab({ url: shareUrlFor(tab.url) }) },
    onDuplicate: (tabId) => tabsClient.duplicate(tabId),
    onReload: (tabId) => tabsClient.reload(tabId),
    onGoBack: (tabId) => tabsClient.back(tabId),
    onGoForward: (tabId) => tabsClient.forward(tabId),
    // 已关闭标签页：恢复走既有 undoClose —— 标签栏本身不认识任何 IPC
    //（见 ui-tabbar 的哑组件约定）。
    onUndoClose: () => tabsClient.undoClose(),
    // 权限请求标记：与关闭/静音同一类行内按钮 —— 先切到该标签（用户要先看到"是谁在问"），
    // 再把意图上抛给 chrome。浮层归 navbar，本控制器不认识它。
    onPermissionClick: (tabId) => {
      if (!tabId) return
      tabsClient.switchTab(tabId)
      if (typeof onPermissionRequest === 'function') {
        try { onPermissionRequest(tabId) } catch (e) {
          console.error('[tab-session] onPermissionRequest failed:', e)
        }
      }
    },
    showMenu: showNativeMenu,
    overlay,
    // 标签条装饰层（渲染侧插槽 tabbar.item-renderer / tabbar.tab-stack-renderer）
    slots
  })

  // 「固定标签 / 播放中」统计徽标。
  // 对齐 RT 的 useMemo：计数完全由当前标签列表本地派生，不再为每次 tab:changed
  // 额外发一次 stats() IPC 往返（旧实现：变更 → stats() + visibleAfter() 两次往返）。
  // 每个 tabs-inner 前一个静态位置，渲染时按计数更新，缺省隐藏 -> 0 开销。
  const statsBadge = document.createElement('div')
  statsBadge.className = 'tabbar-stats-badge'
  statsBadge.style.cssText = 'display:none;align-items:center;gap:6px;flex-shrink:0;padding:0 8px;font-size:11px;color:var(--text-color,#555);-webkit-app-region:no-drag;'
  tabbar.element.appendChild(statsBadge)
  /** 上一次真正写进徽标的文本（同值不写，见 renderStats）。 */
  let lastStatsText = ''

  function renderStats() {
    let total = 0
    let pinned = 0
    let audio = 0
    for (const t of tabs) {
      if (!t) continue
      total++
      if (t.pinned) pinned++
      if (t.isPlaying) audio++
    }
    stats = { total, pinned, audio }
    const parts: string[] = []
    if (pinned > 0) parts.push(`固定标签 ${pinned}`)
    if (audio > 0) parts.push(`播放 ${audio}`)
    const text = parts.join(' · ')
    // 同值不写：页面加载期 tab:changed 每 16ms 一趟，而这里每次都会写 textContent ——
    // 值没变也照样让徽标的布局失效一次。文本不变就一个 DOM 写都不发。
    if (text === lastStatsText) return
    lastStatsText = text
    statsBadge.style.display = text ? 'flex' : 'none'
    statsBadge.textContent = text
  }

  /**
   * 给投影叠上「权限请求标记」。
   *
   * 关键：**每个非 stack 项都显式写 `permissionIcons`**（数组或 null）。
   * 渲染引擎的 diffFields 只遍历 next 的键 —— 去掉这个键意味着「请求消失」永远传不到
   * `Tab.update`，标签上的图标会一直留着。显式 null 才能把「无请求」也当成一次变化。
   *
   * 数组复用：`permissionMarks` 里的数组引用按内容稳定（见 setPermissionMarks），
   * 于是无变化时 diff 浅比较相等、`Tab.update` 不被调用，热路径零 DOM 写入。
   *
   * @param {Array} items 投影
   * @returns {Array} 原数组（无需装饰时）或装饰后的新数组
   */
  function decorate(items: ProjectionList): ProjectionList {
    if (!marksActive && !marksApplied) return items
    const out: TabbarProjectionItem[] = new Array(items.length)
    for (let i = 0; i < items.length; i++) {
      const item = items[i]
      out[i] = item.type === 'stack'
        ? item
        : { ...item, permissionIcons: permissionMarks.get(item.tabId) || null }
    }
    return out
  }

  /**
   * 只重画「列表态」（标签条 + 其它呈现），不重跑 onActiveTabChange。
   *
   * 权限标记变化不改变活动标签、导航态、焦点 —— 重跑激活回调只会制造无谓的地址栏写入。
   */
  function repaint() {
    if (disposed) return
    if (lastProjection.length === 0 && lastFlat.length === 0) return
    if (!marksActive && !marksApplied) return
    const decorated = decorate(lastProjection)
    marksApplied = marksActive
    tabbar.renderTabs(decorated)
    if (typeof onProjection === 'function') {
      try { onProjection(decorated, lastFlat) } catch (e) {
        console.error('[tab-session] onProjection failed:', e)
      }
    }
    renderStats()
  }

  /**
   * 更新「哪些标签正在请求什么权限」。
   *
   * @param {Map<string, string[]>|Record<string, string[]>|null} marks
   *   tabId → 图标键名数组（如 `['Camera']`）。空数组/缺省 = 该标签无待处理请求。
   */
  function setPermissionMarks(
    marks: Map<string, readonly string[]> | Record<string, readonly string[]> | null | undefined
  ): void {
    if (disposed) return
    const entries = marks instanceof Map ? marks.entries() : Object.entries(marks || {})
    const next = new Map<string, readonly string[]>()
    let changed = false
    for (const [tabId, icons] of entries) {
      const key = String(tabId)
      const list = Array.isArray(icons)
        ? icons.filter((name): name is string => typeof name === 'string' && name.length > 0)
        : []
      if (list.length === 0) continue
      const prev = permissionMarks.get(key)
      const same = !!prev && prev.length === list.length && prev.every((name, i) => name === list[i])
      // 内容相同 → 复用旧引用：纵向列表按引用比较，这样它在这条路径上零 DOM 写入。
      next.set(key, same ? prev : Object.freeze(list))
      if (!same) changed = true
    }
    for (const key of permissionMarks.keys()) {
      if (!next.has(key)) changed = true
    }
    if (!changed && (next.size > 0) === marksActive) return

    permissionMarks.clear()
    for (const [key, value] of next) permissionMarks.set(key, value)
    marksActive = permissionMarks.size > 0
    repaint()
  }

  // 渲染一份「含标签栈」的投影：标签栏直接用；同时把扁平视图留在 tabs 里，
  // 供 getTabs()/外部 API（打开标签列表）消费 —— 避免把栈项泄漏给扁平消费者。
  //
  // ⚠ 「当前标签」不能只看投影。投影回答的是「标签条该显示什么」，里面带**显示规则**
  //   （折叠的标签组只留一行、成员被藏起来）；而扁平列表回答的是「有哪些标签」，
  //   与显示无关。若只从投影取当前标签，一旦它恰好被藏起来（折叠进标签组），
  //   `find(t => t.active)` 就会返回 null —— 表现就是「标签只是被收起来了，
  //   地址栏却空白了」。所以：先按投影找，找不到再退回扁平列表兜底。
  //   （domain 侧已让折叠组保留活动成员，这里是第二道保险：地址栏不再依赖显示规则。）
  /**
   * @param {Array} projection 标签条投影（可含 { type:'stack' } 行）
   * @param {Array} [flatTabs] 扁平标签列表（不含 stack 行）
   */
  function render(projection: unknown, flatTabs?: unknown): void {
    if (disposed) return
    const list = projectionFrom(projection)
    const suppliedTabs = tabsFrom(flatTabs)
    const flat: TabViewState[] = suppliedTabs.length
      ? suppliedTabs
      : list.filter((item): item is TabViewState => item.type !== 'stack')
    lastProjection = list
    lastFlat = flat
    tabs = flat
    const activeTab = list.find((t) => t.active) || (flat.find((t) => t.active) as TabViewState | undefined) || null
    activeTabId = activeTab ? String(activeTab.tabId) : null
    // 本次激活的标签是否「本层从未见过」= 新建标签 / 启动首个标签。
    // 与「切回已存在的标签」区分开：后者不该去动地址栏焦点。
    const isNew = !!(activeTab && activeTab.tabId && !knownTabIds.has(activeTab.tabId))
    const isFirst = !seenFirstProjection
    seenFirstProjection = true
    knownTabIds.clear()
    for (const t of tabs) if (t && t.tabId) knownTabIds.add(t.tabId)
    const decorated = decorate(list)
    marksApplied = marksActive
    tabbar.renderTabs(decorated)
    // 同一次渲染再喂给「其它呈现」（垂直标签列）。
    // 为什么用回调而不是让它自己订阅一次：本视图（chrome 外壳）里的标签数据
    // 只该有一条订阅、一次渲染 —— 两个宿主各订一次，切标签时就要跑两遍并
    // 各自处理竞态。控制器不知道消费方是谁，只负责「渲染完通知一声」。
    //
    // ⚠ 两条订阅者回调都要**隔离异常**：订阅者做的是地址栏同步 / 书签星 / 焦点补正
    // 这类"渲染之外的附带状态"，它抛出去不该让本控制器的渲染契约（标签条已画好、
    // 统计徽标待更新）也跟着中断 —— 而且异常会**吞掉同一次回调里排在它后面的全部动作**，
    // 表现为「地址栏不更新」这种极难定位的整体失灵。这里只兜住"不要中断"，
    // 异常照旧打日志，可观测性不丢。
    if (typeof onProjection === 'function') {
      try { onProjection(decorated, flat) } catch (e) { console.error('[tab-session] onProjection failed:', e) }
    }
    try {
      if (typeof onActiveTabChange === 'function') onActiveTabChange(activeTab as TabViewState | null, { isNew, isFirst })
    } catch (e) {
      console.error('[tab-session] onActiveTabChange failed:', e)
    }
    renderStats()
  }

  // 兜底路径：仅在拿不到推送 payload 时（如初次加载）主动拉一次投影。
  async function refresh(): Promise<void> {
    const request = ++projectionRequest
    const nextTabs: unknown = await (tabsClient.projection ? tabsClient.projection() : tabsClient.list())
    if (!disposed && request === projectionRequest) render(nextTabs)
  }

  function getTabs(): TabViewState[] {
    return tabs
  }

  function getActiveTab(): TabViewState | null {
    return tabs.find((tab) => tab.active) || null
  }

  function getActiveTabId(): string | null {
    return activeTabId
  }

  // 活动标签之后（非固定）的 tabId 集合。
  // 旧实现每次 tab:changed 都发一次 visibleAfter() IPC 拉取，但渲染层从未消费它
  // —— 纯属每次变更的额外跨进程往返。已移除（对齐 RT：不推、不拉用不到的数据）。
  function getVisibleAfter(): string[] {
    return []
  }

  // TabManager.stats() 快照（total/pinned/audio）—— 由当前标签列表本地派生
  function getStats(): TabSessionStats {
    return stats
  }

  function start(): () => void {
    unsubscribe = tabsClient.onChanged((payload) => {
      if (disposed) return
      // 直接消费推送里携带的投影，零额外 IPC（对齐 RT onDataChanged 直接渲染）。
      // 扁平列表一并透传：地址栏的「当前标签」需要它兜底（见 render 的说明）。
      const pushed = payload && (Array.isArray(payload.projection) ? payload.projection : payload.tabs)
      if (Array.isArray(pushed)) {
        // A newer push always wins over an older initial/manual snapshot.
        projectionRequest += 1
        render(pushed, payload && payload.tabs)
      }
      else refresh().catch((error) => console.error('[tab-session] refresh failed:', error))
    })
    refresh().catch((error) => console.error('[tab-session] initial refresh failed:', error))
    return unsubscribe
  }

  return {
    element: tabbar.element,
    getTabs,
    getActiveTab,
    getActiveTabId,
    getVisibleAfter,
    getStats,
    refresh,
    render,
    /** 更新「哪些标签正在请求权限」（tabId → 图标键名）。由 app-shell 从 permission-state 派生。 */
    setPermissionMarks,
    start,
    dispose() {
      if (disposed) return
      disposed = true
      unsubscribe()
      tabbar.element.remove()
    }
  }
}

