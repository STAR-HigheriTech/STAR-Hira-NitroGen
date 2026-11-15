/**
 * 纵向标签列表的**统一装配件** —— 「一张纵向标签列表」的全部接线，只此一处。
 *
 * ── 为什么要有这个文件（去重的账）──────────────────────────────────────
 * 在此之前，同一套接线被抄了两遍：
 *   · `ui-vertical-tabs/src/index.js`（住侧栏的纵向标签列）
 *   · `ui-panel-opentabs/src/index.js`（打开标签面板）
 * 内容一模一样：意图映射（switch / close / toggle-mute / toggle-stack / new-tab）、
 * 拖拽落库五条通道、右键菜单模板、标签组行的四个动作出口、hover 预览的摆放。
 * **再抄一遍就是"散、松、最后屎山"**，所以收在这里。
 *
 * 于是「加一种新宿主」= 调一次本函数 + 交出端口；「标签列表能做什么」只在本文件演进，
 * 所有宿主同时获得（不可能一处加了功能另一处没有）。
 *
 * ── 它不认识谁 ────────────────────────────────────────────────────────
 * 不认识 IPC、不认识 app-shell、不认识侧栏骨架：标签客户端 / 菜单 / 预览浮层
 * 全部由 ctx 注入（与 ui-panel-* 同一个端口范式，见 CONTRACT-11：ui 不得依赖 apps）。
 *
 * ── 数据的两条路（两种宿主各有各的天然来源）────────────────────────────
 *   · `autoSubscribe: true` —— 本进程自己订阅 `tabs.onChanged`（独立视图用它：
 *     面板 / 悬浮列表只能自己拉，与主进程那次渲染无关）；
 *   · `setItems()` 由宿主推入 —— 住在 chrome 的纵向标签列用它：它与横向标签条
 *     **同源**（同一次渲染回调），多订一次 IPC 只是白花。
 *
 * ── 隐藏期闸门（唯一一处）─────────────────────────────────────────────
 * 浮层宿主（收起时是 0×0 视图）与收起的面板在**隐藏期**照样收 `tabs.onChanged`。
 * 那时重建 DOM 是纯浪费：列表看不见，keyed diff 还带 FLIP 的位置读取（强制布局）。
 * 于是本文件吃一个 `isActive()` 端口：隐藏期只落数据（几个数组引用），宿主显示时
 * 调一次 `flush()` 同步补齐。这套判据只此一处 —— 不在每个宿主各写一遍
 * `if (!visible) return`（那正是「这里一条规则、那里一个变化」的老路）。
 */

import { createTabRowList } from './tabRowList'
import { fireStackRequest, leaveStack, stackTogether } from './tabStackActions'
import { TAB_MENU_LABELS, type TabMenuLabels } from './tabContextMenu'
// 标签组动作的**唯一动作表**（与菜单模板同住 tab/chipMenu.ts）：横向标签条取的是同一份。
import { createStackMenuHandlers } from './tab/chipMenu'
import type { StackMenuClient } from './tab/chipMenu'
import type {
  TabRowDragEndPayload,
  TabRowExternalDragItem,
  TabRowIntent,
  TabRowItem,
  TabRowListOptions,
  TabRowMenuClient,
  TabRowPreviewOverlay,
  TabRowStackMenuHandlers
} from './tabRowTypes'
import type { TabStackClient } from './tabStackActions'

export interface TabListChangedPayload {
  tabs?: TabRowItem[]
  projection?: TabRowItem[]
}

export interface TabListTabsClient extends TabStackClient {
  list: () => Promise<TabRowItem[]>
  projection: () => Promise<TabRowItem[]>
  onChanged: (listener: (payload: TabListChangedPayload) => void) => () => void
  switchTab: (tabId: string) => unknown
  splitWithActive: (tabId: string) => unknown
  closeTab: (tabId: string) => unknown
  toggleMute: (tabId: string) => unknown
  toggleStack: (stackId: string) => unknown
  newTab: (input: { url?: string }) => unknown
  renameStack: (stackId: string, label: string) => unknown
  reorder: (payload: TabRowDragEndPayload) => Promise<unknown>
  dropTabOnContent: (payload: { tabId: string; baseTabId: string }) => unknown
  beginTabDropOnContent: (payload: { tabId: string; baseTabId: string }) => unknown
  cancelTabDropOnContent: () => unknown
}

export interface TabRowDropTargetLike {
  tabId?: string
  stackId?: string | null
  insertAfter?: boolean
  [key: string]: unknown
}

export interface TabListHostContext {
  clients?: { tabs?: TabListTabsClient | object }
  createTabRowMenu?: (options: {
    labels: TabMenuLabels
    getItems: () => readonly TabRowItem[]
  }) => TabRowListOptions['showMenu']
  menu?: TabRowMenuClient | null
  previewOverlay?: TabRowPreviewOverlay | null
  labels?: TabMenuLabels
  showAddButton?: boolean
  dragKind?: string
  getMenuItems?: () => readonly TabRowItem[]
  emptyText?: string | (() => string)
  filter?: (item: TabRowItem) => boolean
  autoSubscribe?: boolean
  isActive?: () => boolean
  searchable?: boolean
  motion?: boolean
  stackMenu?: TabRowStackMenuHandlers
  onPermissionRequest?: (tabId: string) => void
  onExternalDrop?: (item: TabRowExternalDragItem, target: TabRowDropTargetLike) => void
  source?: 'projection' | 'list'
}

export interface TabListHostController {
  element: HTMLDivElement
  setItems: (items: readonly TabRowItem[]) => void
  refresh: () => Promise<void>
  flush: () => void
  focusSearch: () => boolean
  beginRenameStack: (stackId: string) => boolean
  dispose: () => void
}

/**
 * 把「预览摆在行的**外侧**」这件事注入给标签列表（纵向列表专用）。
 *
 * 为什么需要：纵向列表里的行又宽又扁 —— 预览跟到「行下方」会压住下面那一行，
 * 正确位置是行的外侧（列表贴左 → 行右侧；贴右 → 行左侧）。
 * 而「此刻贴哪一边」只有**宿主所在的图层**知道，所以这里把这条事实随 payload 发出：
 *   · 住在 chrome 的侧栏：容器打的 `data-region-side`；
 *   · 独立悬浮层：它的 `data-region-side` 由宿主装配时打上。
 * 侧别**每次现读**（侧栏能在运行中换边，缓存会把预览摆到错误的一侧）。
 *
 * ⚠ `windowWidth` / `side` 的权威值由**主进程**在 IPC 层补（见 main/ipc/layout.js
 *   的 normalizeFloatShow）—— 独立视图的 `innerWidth` 是**上一次的视图宽**，不是窗口宽，
 *   拿它算"这一侧放不放得下"必然算错，而算错的后果是浮层被夹回窗口左缘盖住标签行
 *   → hover 反复进出 → 无限闪烁。这里给的值只是外壳（chrome）那一侧的顺手事实。
 *
 * @param {{ showTabPreview?: Function, hideTabPreview?: Function, warmTabPreview?: Function }|null} overlay
 * @param {HTMLElement|(() => HTMLElement|null)} hostEl 列表根元素（读它的 data-region-side）。
 *   允许传**取值函数**：适配器要在 `createTabRowList` 的构造参数里就位，而那时列表根还没造出来 ——
 *   传函数即可"预览真正弹出时才取值"（那时它必然已就位），免得踩 TDZ。
 */
export function withBesideRowPreview(
  overlay: TabRowPreviewOverlay | null | undefined,
  hostEl: HTMLElement | (() => HTMLElement | null)
): TabRowPreviewOverlay | null | undefined {
  if (!overlay || typeof overlay.showTabPreview !== 'function') return overlay
  return {
    showTabPreview(payload) {
      const root = typeof hostEl === 'function' ? hostEl() : hostEl
      if (!root) return
      // 侧别**每次现读最近的带标记祖先**（宿主自己、或侧栏骨架）——
      // 列表根本身通常不带这个标记，标记打在承载它的那一层上。
      const marked = typeof root.closest === 'function'
        ? ((root.closest('[data-region-side]') || root) as HTMLElement)
        : root
      const side = marked.dataset.regionSide === 'right' ? 'left' : 'right'
      const view = root.ownerDocument ? root.ownerDocument.defaultView : null
      const windowWidth = view && Number.isFinite(view.innerWidth) ? Math.round(view.innerWidth) : 0
      overlay.showTabPreview?.(Object.assign({}, payload, { placement: 'beside-row', side, windowWidth }))
    },
    hideTabPreview() {
      if (typeof overlay.hideTabPreview === 'function') overlay.hideTabPreview()
    },
    /**
     * 预热**原样透传**（本包装器只改写"摆放"，与预热无关）。
     *
     * 必需：`withBesideRowPreview` 是重建对象 —— 漏透传就等于让侧栏 / 面板 / 网格
     * 三处的 hover 预热静默失效（列表里 `overlay.warmTabPreview?.()` 拿不到）。
     */
    warmTabPreview() {
      if (typeof overlay.warmTabPreview === 'function') overlay.warmTabPreview()
    }
  }
}

/**
 * 装配一张纵向标签列表（含全部端口接线）。
 *
 * @param {Document} doc
 * @param {{
 *   clients?: { tabs?: object },
 *   createTabRowMenu?: (opts: { labels: object }) => Function,
 *   menu?: object,
 *   previewOverlay?: { showTabPreview?: Function, hideTabPreview?: Function, warmTabPreview?: Function },
 *   labels?: object,
 *   showAddButton?: boolean,
 *   dragKind?: string,
 *   getMenuItems?: () => readonly TabRowItem[],
 *   emptyText?: string,
 *   filter?: (item: TabRowItem) => boolean,
 *   autoSubscribe?: boolean,
 *   isActive?: () => boolean,   // 本宿主此刻是否在台上（缺省恒 true；隐藏期只落数据）
 *   searchable?: boolean,
 *   onPermissionRequest?: (tabId: string) => void
 * }} [ctx]
 * @returns {{
 *   element: HTMLElement,
 *   setItems: (items: readonly TabRowItem[]) => void,
 *   refresh: () => Promise<void>,
 *   flush: () => void,
 *   focusSearch: () => boolean,
 *   dispose: () => void
 * }}
 */
export function createTabListHost(
  doc: Document,
  ctx: TabListHostContext = {}
): TabListHostController {
  const tabsClient = ((ctx.clients && ctx.clients.tabs) || {}) as TabListTabsClient
  // 纵向列表里的「相邻项」是**下一行**，故文案默认「下方」（与面板口径一致）。
  // 宿主拿它去造右键菜单 —— 方向是**本组件**的知识，所以由这里给，而不是让宿主猜。
  const labels = ctx.labels || TAB_MENU_LABELS.below
  const searchable = ctx.searchable === true

  /**
   * 列表根元素。预览适配器要在 `createTabRowList` 的构造参数里就位，而那时根还没造出来 ——
   * 故交出一个取值函数（见 withBesideRowPreview），预览真正弹出时它必然已就位。
   */
  let listEl: HTMLDivElement | null = null

  /**
   * 数据的两份：
   *   · `primaryItems` —— 宿主口径的列表（投影含组行 / 扁平），无查询时原样喂给列表；
   *   · `flatItems`    —— **扁平**标签数组，搜索用。为什么搜索不能用投影：投影里
   *     折叠标签组只出组行、不出成员，只搜投影会漏掉折叠组里的标签（"明明还开着却搜不到"）。
   */
  let primaryItems: TabRowItem[] = []
  let flatItems: TabRowItem[] = []
  /** 当前查询串（`searchable` 时由列表里的输入框经 onSearch 写入）。 */
  let query = ''

  /**
   * 投影项查询（拖拽的种类裁决要用 `pinned`）。
   * 先查扁平那一份（能命中折叠组里的成员），再查投影那一份（组行也在其中）。
   * 查不到就退成「只有 id」的记录 —— tab-policy 见到缺 `pinned` 会跳过 UI 裁决，
   * 由主进程按同一份策略兜底。
   */
  function itemOf(tabId: string): TabRowItem | null {
    const id = String(tabId == null ? '' : tabId)
    if (!id) return null
    const hit = flatItems.find((it) => it && it.tabId != null && String(it.tabId) === id)
      || primaryItems.find((it) => it && it.tabId != null && String(it.tabId) === id)
    return hit || { tabId: id }
  }

  /** 投影里的某个标签组行（组行的 `pinned` 就是种类，见 projection）。 */
  function stackOf(stackId: string): TabRowItem | null {
    const id = String(stackId == null ? '' : stackId)
    if (!id) return null
    const hit = primaryItems.find((it) => it && it.type === 'stack' && String(it.stackId) === id)
    return hit || { type: 'stack', stackId: id }
  }

  /** 空态文案：搜索无结果与"一个标签都没有"必须说两句话。 */
  const emptyText = searchable
    ? () => {
        const q = query.trim()
        if (q) return `没有匹配「${q}」的标签`
        return typeof ctx.emptyText === 'function' ? ctx.emptyText() : (ctx.emptyText || '')
      }
    : ctx.emptyText

  const list = createTabRowList(doc, {
    // 标签行的意图出口（与面板同一套语义：switch / close / toggle-mute / toggle-stack / new-tab）
    onIntent(payload: TabRowIntent) {
      const p: TabRowIntent = payload
      if (p.type === 'switch' && p.tabId) tabsClient.switchTab(p.tabId)
      // Alt/Option + 单击行 = 与当前活动标签分屏（与横向标签条同一语义）
      else if (p.type === 'split-with' && p.tabId) tabsClient.splitWithActive(p.tabId)
      else if (p.type === 'close' && p.tabId) tabsClient.closeTab(p.tabId)
      else if (p.type === 'toggle-mute' && p.tabId) tabsClient.toggleMute(p.tabId)
      else if (p.type === 'toggle-stack' && p.stackId) tabsClient.toggleStack(p.stackId)
      else if (p.type === 'new-tab') tabsClient.newTab({})
      // 权限标记：先切到该标签（用户要先看到"是谁在问"），再唤出权限浮层。
      // 浮层归 chrome（navbar），本列表只上抛意图 —— 端口由宿主注入，UI 不 import apps。
      else if (p.type === 'permission' && p.tabId) {
        tabsClient.switchTab(p.tabId)
        if (typeof ctx.onPermissionRequest === 'function') ctx.onPermissionRequest(String(p.tabId))
      }
    },
    // 标签组行的改名（展开/收起走上面 onIntent 的 `toggle-stack`）
    onRenameStack: (stackId, label) => tabsClient.renameStack(stackId, label),
    /**
     * 标签组的其余四个动作（解散 / 平铺成分屏 / 合并 / 配色）**整包**交给列表。
     *
     * 默认在这里就地构建（`createStackMenuHandlers` 就住在 ui-common，与菜单模板同包）——
     * 于是四个纵向宿主（侧栏 / 打开标签 / 固定标签 / 悬停浮出）**一行都不用改**，
     * 而横向标签条拿的是同一个函数造出来的同一份包（宿主用 tabsClient 造好后注入）。
     * 两端因此不可能对"哪个动作调哪个方法"产生分歧。
     */
    stackMenu: ctx.stackMenu || createStackMenuHandlers(tabsClient as StackMenuClient),
    // Arc 式入口：拖到网页区域松手 = 与"拖动前正在看的那一格"分屏。
    // 与横向标签条**同一个出口、同一套判据**：只报两个 id，落点与判定全在主进程
    //（见 ui-common/src/tabRowList.ts 的 dragend 与 TabManager#dropTabOnContent）。
    onDropOnContent: (tabId, baseTabId) => tabsClient.dropTabOnContent({ tabId, baseTabId }),
    // 同一条链的**开始**那半：拖动一开始就报，主进程据此起光标采样并画落位预览
    // （拖动期间渲染层收不到指针事件，见 main/tab-drop-zone.js）。
    onDropOnContentBegin: (tabId, baseTabId) => tabsClient.beginTabDropOnContent({ tabId, baseTabId }),
    // 同一条链的**收尾兜底**：dragend 时如果没有"落在网页上"的落点（绝大多数拖动都是
    // 在列表里排序 / 成组），也必须让主进程归档这场拖动 —— 否则采样表与侧栏唤出冻结
    // 会永远留着（"分屏黏住"）。与上面两条同一出口，见 tabs-client#cancelTabDropOnContent。
    onDropOnContentCancel: () => tabsClient.cancelTabDropOnContent(),
    // 拖拽落库：与横向标签条 / 面板**同一套五条通道**（空处=出栈 / 组外散标签=先出栈再落位 /
    // 组行或组内行=并入 / 与目标堆叠=stackTogether / 行间=reorder），全是既有 IPC。
    onDragEnd(payload: TabRowDragEndPayload) {
      if (!payload) return null
      // 种类裁决要投影项（`pinned`）；裸 id 能让 tab-policy 走「无种类信息」分支。
      const dragged = itemOf(payload.draggedId)
      if (payload.leaveStack) {
        return fireStackRequest(leaveStack(tabsClient, dragged, payload))
      }
      if (payload.targetStackId != null) {
        return fireStackRequest(stackTogether(tabsClient, dragged, stackOf(payload.targetStackId)))
      }
      if (payload.stackWithItem) {
        return fireStackRequest(stackTogether(tabsClient, dragged, payload.stackWithItem))
      }
      return fireStackRequest(tabsClient.reorder(payload))
    },
    // 底部常驻「新建标签」浮钮（与横向标签条的新建按钮同一个入口语义）
    showAddButton: ctx.showAddButton === true,
    // 外部拖入（集锦卡 / 书签 / 历史 / 画板）：默认有 URL 就新开标签；
    // 宿主可用 ctx.onExternalDrop 覆盖（例如按落点插入到某个位置）。
    onExternalDrop: typeof ctx.onExternalDrop === 'function'
      ? ctx.onExternalDrop
      : (item: TabRowExternalDragItem) => {
          if (item && item.url) tabsClient.newTab({ url: item.url })
        },
    showMenu: typeof ctx.createTabRowMenu === 'function'
      ? ctx.createTabRowMenu({
        labels: labels as TabMenuLabels,
        // 「与谁相邻」的判据必须喂**当前真实**的那份列表。默认取本组件自己维护的 flatItems；
        // 但宿主若自行切片/过滤后经 setItems 推入（聚合总览），flatItems 就与屏幕上那份脱节
        // —— 于是由宿主交出 getMenuItems，两边看的是同一份。
        getItems: typeof ctx.getMenuItems === 'function' ? ctx.getMenuItems : () => flatItems
      })
      : undefined,
    // 标签组行自己的菜单走**通用弹层**（与标签行菜单分开的两件事）
    menu: ctx.menu,
    emptyText,
    filter: ctx.filter,
    dragKind: ctx.dragKind,
    // 搜索框：列表只负责把查询串上抛（去抖），「推哪一份数据」由本文件决定。
    searchable,
    motion: ctx.motion,
    onSearch: (value) => setQuery(value),
    // hover 预览：纵向列表一律摆到**行的外侧**（见 withBesideRowPreview）
    overlay: withBesideRowPreview(ctx.previewOverlay, () => listEl)
  })

  listEl = list.element

  /** 查询串 → 是否命中（标题 / URL，大小写不敏感）。 */
  function matchesQuery(tab: TabRowItem, q: string): boolean {
    const title = String((tab && tab.title) || '').toLowerCase()
    const url = String((tab && tab.url) || '').toLowerCase()
    return title.includes(q) || url.includes(q)
  }

  /**
   * 可见性闸门（见文件头）：缺省恒「在台上」—— 住在 chrome 的常驻列表不传这条端口，
   * 行为与以前一模一样；浮层 / 面板宿主传自己的可见布尔，隐藏期就只剩「落数据」。
   */
  const isActive = typeof ctx.isActive === 'function' ? ctx.isActive : null
  /** 隐藏期是否攒下了未渲染的变更（`flush` 用它决定要不要重建一次）。 */
  let pendingApply = false

  /**
   * 把「当前查询 + 当前数据」解析成要渲染的那一份。
   *
   * 无查询 → 原样推宿主口径的那份（组行结构完整）；
   * 有查询 → 推**扁平**里命中的标签（含折叠组的成员），此时不出现组行 ——
   * 搜索结果是一张平铺的命中列表，比"留下一个展开后空空的组头"更符合预期。
   */
  function applyItems() {
    if (isActive && !isActive()) {
      pendingApply = true
      return
    }
    pendingApply = false
    const q = query.trim().toLowerCase()
    if (!q) {
      list.setItems(primaryItems)
      return
    }
    list.setItems(flatItems.filter((t) => matchesQuery(t, q)))
  }

  function setItems(items: readonly TabRowItem[]) {
    primaryItems = Array.isArray(items) ? items : []
    applyItems()
  }

  /** 查询变化（来自列表里的输入框）。 */
  function setQuery(value: string) {
    const next = String(value == null ? '' : value)
    if (next === query) return
    query = next
    applyItems()
  }

  /** 从主进程拉一次标签数据 —— 与面板同一条数据口径。
   *
   * `source`：'projection'（含标签组行，默认）或 'list'（扁平）。
   * 固定文件夹组行只存在于投影里，所以列表形态（含固定面板）一律用默认的 projection；
   * 需要"每个标签各自一行"的调用方自行在 `setItems` 里摊平，不靠这里切数据源。
   */
  const source = ctx.source === 'list' ? 'list' : 'projection'
  async function refresh() {
    const call = tabsClient[source]
    if (typeof call !== 'function') return
    const primary = await call.call(tabsClient)
    // 搜索要的是**扁平**列表：投影里折叠标签组只出组行、不出成员（见 flatItems 的说明）。
    if (searchable && source !== 'list' && typeof tabsClient.list === 'function') {
      const flat = await tabsClient.list()
      flatItems = Array.isArray(flat) ? flat : []
    } else {
      flatItems = Array.isArray(primary) ? primary : []
    }
    primaryItems = Array.isArray(primary) ? primary : []
    applyItems()
  }

  let unsubscribe: (() => void) | null = null
  if (ctx.autoSubscribe === true && typeof tabsClient.onChanged === 'function') {
    refresh().catch(() => {})
    // 变更推送里带的是**投影**（含组行）；只列扁平列表的宿主取 `tabs` 那一份。
    const preferred = source === 'list' ? 'tabs' : 'projection'
    const other = source === 'list' ? 'projection' : 'tabs'
    unsubscribe = tabsClient.onChanged((payload: TabListChangedPayload) => {
      // 推送里**两份都带**（tabs 扁平 + projection 投影）—— 搜索要用的正是扁平那份，
      // 顺手收下，免得每敲一个字都要多跑一次 IPC。
      if (payload && Array.isArray(payload.tabs)) flatItems = payload.tabs
      const primary = payload && Array.isArray(payload[preferred])
        ? payload[preferred]
        : (payload && Array.isArray(payload[other]) ? payload[other] : null)
      if (primary) {
        primaryItems = primary
        // 隐藏期：数据已落，DOM 留给显示时的 flush（闸门在 applyItems 里）。
        applyItems()
        return
      }
      // 推送缺字段才回落一次 IPC —— 隐藏期不做（数据已尽量落了，显示时 flush 补 DOM）。
      if (isActive && !isActive()) return
      refresh().catch(() => {})
    })
  }

  return {
    element: list.element,
    setItems,
    refresh,
    /**
     * 宿主**显示时**调一次：把隐藏期攒下的变更同步补齐（零 IPC、零异步）。
     *
     * 与 `refresh()` 的分工：这条只补 DOM（数据在隐藏期已随推送落下），
     * 因此从「贴边唤出」到「列表就位」之间没有一次往返 —— 首帧就是最新状态。
     */
    flush() {
      if (!pendingApply) return
      applyItems()
    },
    /**
     * 聚焦搜索框（透传给 `createTabRowList`）——
     * 「打开即聚焦搜索框」的落点（宿主只报意图，实施在列表里，见 tabRowList#focusSearch）。
     */
    focusSearch: () => (typeof list.focusSearch === 'function' ? list.focusSearch() : false),
    /**
     * 让某个标签组行进入行内改名（新建固定文件夹后由面板立刻调用）——
     * 与网格形态 `createPinGrid` 的 `beginRenameFolder` 同一意图，两种形态各有实现。
     */
    beginRenameStack: (stackId: string) => (typeof list.beginRenameStack === 'function' ? list.beginRenameStack(stackId) : false),
    dispose() {
      if (typeof unsubscribe === 'function') unsubscribe()
      if (typeof list.dispose === 'function') list.dispose()
    }
  }
}
