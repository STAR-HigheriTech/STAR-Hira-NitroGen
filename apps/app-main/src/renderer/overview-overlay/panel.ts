/**
 * overview-overlay/panel —— 「总览」浮层的**内容编排层**（浮层宿主调用）。
 *
 * ── 行不自己画，直接复用各面板的行件 ──────────────────────────────────
 * 用户口径：「空间切换、打开的标签……学习对应的面板一模一样的样式、功能」。
 * 于是三块的行分别来自：
 *   · 空间    ← `@hira-ng/ui-panel-profiles#createSpaceRows`（行内改名 + 右键菜单）
 *   · 打开的标签 ← `@hira-ng/ui-common#createTabListHost`（右键菜单 / 静音·音量 / hover 预览 / 拖拽）
 *   · 最近关闭 ← `@hira-ng/ui-panel-history#createRecentList`（与「历史面板 ▸ 最近关闭」
 *                选项卡**同一份行件**：favicon + 标题/网址、点击即恢复、拖拽）
 *   · 会话    ← `@hira-ng/ui-panel-sessions#createSessionRows`（与「会话面板」
 *                同一份行件：点击恢复、hover ✕ 删除）
 * 本文件只做「拉数据 / 订阅 / 意图派发」，视图只做「摆位 / 溢出省略」。
 * 样式因此不可能分叉：`inject*Styles` 注入的就是各面板自己那一份。
 *
 * ── 「最近关闭」取哪份数据 ───────────────────────────────────────────
 * 与历史面板的「最近关闭」选项卡**同一口径**：主进程的撤销栈
 * （`tabsClient.recentlyClosed()` → `{ tabs: [...] }`，0 = 最近关闭在前）。
 * 不是持久化的浏览历史 —— 那是「历史」选项卡的语义，两者必须分开。
 * 恢复同样只有一条通道：`tabsClient.restoreRecentlyClosed(index)`，
 * `index` 必须**原样**取撤销栈下标（行件的 `restoreIndex`），不能被切片重排。
 *
 * ── 「摆几块 / 上限 / 去向 / 搜索怎么分组」──────────────────────────────
 * 全在纯层 `shared-types/src/overview.mjs`（唯一真源）。这里不认识任何额度。
 *
 * ── 数据与 IPC：零新增通道 ─────────────────────────────────────────
 *   打开标签 `tab:list(+:projection)`；最近关闭 `tab:recently-closed(+:restore)`；
 *   空间 `space:list-all` + `space:get-using` / `space:set-using`；
 *   会话 `session:named-list` / `:named-save` / `:named-restore` / `:named-remove`
 *   （与会话面板 / 内部页共用同一个 `clients.sessions` 端口，不各写一套）；
 *   「转到某面板」`panel:toggle`。全是既有面。
 */

import {
  injectPanelStyles,
  injectTabRowStyles,
  createTabListHost,
  TAB_MENU_LABELS,
  type TabRowItem,
  type TabMenuLabels,
  type TabMenuTab
} from '@hira-ng/ui-common'
import { createSpaceRows, createSpaceMenu, injectSpacesPanelStyles } from '@hira-ng/ui-panel-profiles'
import { createRecentList, injectHistoryPanelStyles } from '@hira-ng/ui-panel-history'
import {
  createSessionRows,
  defaultSessionName,
  injectSessionsPanelStyles
} from '@hira-ng/ui-panel-sessions'
import { buildOverview, type OverviewItem } from '@hira-ng/shared-types/src/overview.mjs'
import { NAMED_SESSIONS_SETTING_KEY } from '@hira-ng/shared-types/src/named-sessions.mjs'
import { createOverviewView, injectOverviewStyles } from './view.js'
import type { PanelContext } from '../shared/panel-context.js'

interface OverviewOptions { onDismiss?: () => void; isActive?: () => boolean }
export interface OverviewController {
  element: HTMLElement
  refresh(): Promise<void>
  flush(): void
  focusSearch(): void
}

function isOverviewItem(value: unknown): value is OverviewItem {
  return typeof value === 'object' && value !== null
}

function isTabRowItem(value: unknown): value is TabRowItem {
  if (!isOverviewItem(value)) return false
  return value.type === 'stack' ? value.stackId != null : value.tabId != null
}

/**
 * 宿主调用的样式入口：行件基底 + 各块行件的**原样式** + 本视图外壳样式。
 * 行件样式必须是它们各自面板注入的那一份 —— 这是「像素一致」的唯一保证。
 */
export function injectOverviewPanelStyles(doc: Document): void {
  injectPanelStyles(doc)
  injectTabRowStyles(doc)
  injectSpacesPanelStyles(doc)
  injectHistoryPanelStyles(doc)
  injectSessionsPanelStyles(doc)
  injectOverviewStyles(doc)
}

/**
 * 标签事件的合并窗口（ms）。
 * 标题 / 加载态会连着打好几次 `tab:changed`，250ms 合并一次即可 —— 与历史面板同口径。
 */
const TABS_DEBOUNCE_MS = 250

/**
 * 造一份「总览」内容（浮层宿主直接调用；端口由 ctx 注入）。
 *
 * @param {Document} doc
 * @param {object} ctx 面板端口（`shared/panel-context.js` 构造，与面板/内部页同一份）
 * @param {{ onDismiss?: () => void, isActive?: () => boolean }} [options]
 *   onDismiss：本视图认为「这次操作之后该收起浮层」时调用（切空间 / 转面板 / 管理空间）。
 *   浮层宿主决定怎么收（浮层外的一切宿主细节本文件不认识）。
 *   isActive：本浮层此刻是否在台上（缺省恒 true）。收起的浮层是 0×0 视图，
 *   但标签 / 空间 / 会话的推送照样会到 —— 那条判据只在这里写一次，
 *   不在每个订阅点各写一遍 `if (!visible) return`。
 * @returns {{ element: HTMLElement, refresh: Function, flush: Function, focusSearch: Function }}
 */
export function createOverview(doc: Document, ctx: PanelContext, options: OverviewOptions = {}): OverviewController {
  const onDismiss = typeof options.onDismiss === 'function' ? options.onDismiss : () => {}
  /**
   * 「在台上」的唯一判据（宿主给的 `open`）。
   *
   * 收起期所有数据落点一律早退：重建整份列表在这里不是免费的 —— keyed diff 之后
   * 还可能做 FLIP 的位置读取（强制同步布局），而用户一个字都看不到。
   * 打开时宿主必然调一次 `refresh()` 全量对齐，丢掉的帧因此不会留下陈旧数据。
   */
  const isActive = typeof options.isActive === 'function' ? options.isActive : () => true
  /** 本体作用域：全部状态只活在这一块里（每次浮层挂载一份，互不串味）。 */
  {
    const tabsApi = ctx.clients.tabs
    const spacesApi = ctx.clients.space
    const profilesApi = ctx.clients.profiles
    const panelsApi = ctx.clients.panels
    // 会话：与会话面板 / hira://sessions 同一个端口（命名会话四条路由）。
    const sessionsApi = ctx.clients.sessions
    const { events, on, icons } = ctx

    // ── 状态（本面板唯一一份）──
    let spaceList: OverviewItem[] = []
    /** 标签的两份口径（与打开标签面板同源）：
     *   · `tabRows` —— **投影**（含标签组行）；浏览态直接摆它，组行的折叠/改名/配色才有；
     *   · `tabFlat` —— **扁平**（组内成员也逐个在场）；搜索态用它，折叠组里的标签也搜得到。 */
    let tabRows: TabRowItem[] = []
    let tabFlat: TabRowItem[] = []
    let recentList: OverviewItem[] = []
    let sessionList: OverviewItem[] = []
    let activeSpaceId = ''
    let activeProfileId = ''
    let query = ''
    /**
     * 收起期攒下的两样东西（宿主显示时 `flush()` 一次补齐）：
     * `pendingRender` = 有一次模型没摆；`pendingPayload` = 最近一帧标签推送。
     */
    let pendingRender = false
    /** @type {unknown} */ let pendingPayload: unknown = null

    // ── 三块行件（与各自面板同一份实现）──
    const spaceRows = createSpaceRows(doc, {
      onIntent: (intent) => handleIntent(intent),
      renderIcon: (name: string, size?: number) => icons.space(name, size || 18)
    })

    /**
     * 标签行宿主：与「打开的标签面板」同一套接线（右键菜单 / 静音 / hover 预览 / 拖拽）。
     * 数据由本文件推入（`source: 'list'` 只决定 refresh 的口径；这里不用 autoSubscribe）。
     */
    const tabHost = createTabListHost(doc, {
      clients: ctx.clients,
      createTabRowMenu: ({ labels, getItems }) => ctx.createTabRowMenu({
        labels: labels as TabMenuLabels,
        getItems: () => getItems() as unknown as TabMenuTab[]
      }),
      menu: ctx.menu,
      previewOverlay: ctx.previewOverlay,
      labels: TAB_MENU_LABELS.below,
      // 本面板按纯层给的切片渲染，菜单里的「与谁相邻」必须看**完整**的那份扁平列表。
      getMenuItems: () => tabFlat,
      dragKind: 'opentabs',
      showAddButton: false,
      searchable: false,
      emptyText: '没有打开的标签'
    })

    /**
     * 最近关闭 = **历史面板「最近关闭」选项卡的同一份行件**（不是历史记录行件）。
     * 行内就是 favicon + 标题 / 网址，点击即恢复，可拖到集锦 / 画板 / 书签栏 ——
     * 两处共用同一套 class，`injectHistoryPanelStyles` 一份样式同时管住。
     */
    const recentRows = createRecentList(doc, {
      emptyText: '暂无最近关闭的标签页',
      onIntent: (intent) => handleIntent({ ...intent, scope: 'recent' })
    })

    /**
     * 会话 = **会话面板的同一份行件**（点击恢复、hover ✕ 删除）。
     * 总览只摆前几条（纯层 limit 3），不分组 —— 分组标题在这里没有意义
     * （每块本来就是一个 section，再套一层「今天 / 昨天」会挤掉真正的聚合信息）。
     */
    const sessionRows = createSessionRows(doc, {
      grouped: false,
      emptyText: '还没有保存任何会话',
      onIntent: (intent) => handleIntent({ ...intent, scope: 'sessions' })
    })

    /** 空间右键菜单（与空间面板同一份）；「重命名」要回填到行组件里原地开输入框。 */
    const openSpaceMenu = createSpaceMenu({
      menuClient: ctx.menu,
      themeClient: ctx.clients.themes,
      settingsClient: ctx.clients.settings,
      tabsClient: tabsApi,
      spaceClient: spacesApi,
      onRename: (id: string | number) => spaceRows.startRename(String(id))
    })

    const view = createOverviewView(doc, {
      onIntent: (intent) => handleIntent(intent),
      hosts: {
        // 三块接口统一成 setItems(items, active)；空间行需要 active 才标得出当前空间。
        spaces: {
          element: spaceRows.element,
          setItems: (items, active) => spaceRows.setSpaces(
            items as Parameters<typeof spaceRows.setSpaces>[0],
            (active && active.spaceId) || '',
            (active && active.profileId) || ''
          )
        },
        tabs: {
          element: tabHost.element,
          setItems: (items) => tabHost.setItems(items.filter(isTabRowItem))
        },
        recent: {
          element: recentRows.element,
          setItems: (items) => recentRows.setItems(items as Parameters<typeof recentRows.setItems>[0])
        },
        sessions: {
          element: sessionRows.element,
          setItems: (items) => sessionRows.setItems(items as Parameters<typeof sessionRows.setItems>[0])
        }
      }
    })

    /** 把当前四份事实编成模型交给视图（编的规则全在纯层，这里只搬运）。 */
    function render() {
      if (!isActive()) {
        pendingRender = true
        return
      }
      pendingRender = false
      // 浏览态摆投影（组行完整），搜索态摆扁平（组内成员可命中）—— 与打开标签面板同口径。
      const searching = String(query == null ? '' : query).trim() !== ''
      view.setModel({
        ...buildOverview({
          spaces: spaceList,
          tabs: searching ? tabFlat : tabRows,
          recent: recentList,
          sessions: sessionList,
          query
        }),
        active: { spaceId: activeSpaceId, profileId: activeProfileId }
      })
    }

    async function loadTabs() {
      try {
        // 一次拿两份：投影给「浏览」、扁平给「搜索」与右键菜单的相邻判据（同一份主进程事实）。
        const [rows, flat] = await Promise.all([
          typeof tabsApi.projection === 'function' ? tabsApi.projection() : [],
          tabsApi.list()
        ])
        tabRows = Array.isArray(rows) ? rows.filter(isTabRowItem) : []
        tabFlat = Array.isArray(flat) ? flat.filter(isTabRowItem) : []
      } catch (_) {
        tabRows = []
        tabFlat = []
      }
    }

    /**
     * 「最近关闭」= 主进程撤销栈（与历史面板的「最近关闭」选项卡同一份数据）。
     *
     * 行件把 `restoreIndex` 当恢复下标（缺省回落数组下标）。撤销栈返回的 `index`
     * 就是**展示顺序下标**（0 = 最近关闭在前），这里原样搬成 `restoreIndex` ——
     * 纯层随后会切片到前 5 条，切片不改变每项自带的下标，恢复因此永远点中那一条。
     */
    async function loadRecent() {
      try {
        const res = await tabsApi.recentlyClosed()
        const tabs = res && Array.isArray(res.tabs) ? res.tabs.filter(isOverviewItem) : []
        recentList = tabs.map((t, i) => ({
          ...t,
          restoreIndex: Number.isFinite(t && t.index) ? t.index : i
        }))
      } catch (_) {
        recentList = []
      }
    }

    async function loadSpaces() {
      try {
        const [all, using, profiles] = await Promise.all([
          spacesApi.listAll(),
          spacesApi.getUsing().catch(() => null),
          profilesApi && typeof profilesApi.listVisible === 'function'
            ? profilesApi.listVisible().catch(() => [])
            : Promise.resolve([])
        ])
        const profileNames = new Map<string, string>(
          (Array.isArray(profiles) ? profiles : []).map((profile) => [profile.id, profile.name || profile.id])
        )
        // 本面板只列**当前 profile** 的空间（与空间切换菜单同口径；跨 profile 混排会挤掉当前空间）。
        const profileId = (using && using.profileId) || ''
        const list = (Array.isArray(all) ? all : [])
          .filter((s) => !!s && (!profileId || s.profileId === profileId))
          .map((s) => ({ ...s, profileName: profileNames.get(s.profileId) || s.profileId }))
        spaceList = list
        activeSpaceId = (using && using.id) || (list[0] && list[0].id) || ''
        activeProfileId = profileId || (list[0] && list[0].profileId) || ''
      } catch (_) {
        spaceList = []
        activeSpaceId = ''
        activeProfileId = ''
      }
    }

    /** 命名会话（与会话面板同一端口）；失败就当空列表，不阻塞其它三块。 */
    async function loadSessions() {
      try {
        const res = await sessionsApi.listNamed()
        sessionList = res && Array.isArray(res.sessions) ? res.sessions : []
      } catch (_) {
        sessionList = []
      }
    }

    /** 全量重拉（宿主在 profile 变更时调它；也用于首次装配）。 */
    async function refresh() {
      await Promise.all([loadTabs(), loadRecent(), loadSpaces(), loadSessions()])
      render()
    }

    /**
     * 标签页变化的**兜底重拉**：只在推送里缺字段时用，合并窗口与历史面板同口径。
     * 正常路径是 `applyTabsPayload` —— 直吃 `tab:changed` 里的两份数据，零 IPC。
     *
     * 「最近关闭」读的是撤销栈，它只随「开关标签」变化 —— 落点见 `applyTabsPayload`
     * 的 id 集合判据；不订阅任何 historyChanged（那是持久化历史的写入路径，与这里无关）。
     */
    let tabsTimer: ReturnType<typeof setTimeout> | null = null
    function scheduleTabsReload() {
      // 收起期不排定时器：到点也只会白跑两次 IPC + 一次被 render 丢掉的重建。
      if (!isActive()) {
        if (tabsTimer) clearTimeout(tabsTimer)
        tabsTimer = null
        return
      }
      if (tabsTimer) clearTimeout(tabsTimer)
      tabsTimer = setTimeout(() => {
        tabsTimer = null
        loadTabs().then(render).catch(() => {})
        // 标签数变了但推送缺字段：撤销栈同样可能变了，一起补拉（同一个合并窗口）。
        loadRecent().then(render).catch(() => {})
      }, TABS_DEBOUNCE_MS)
    }

    /**
     * 直吃 `tab:changed` 推送：`{ tabs, projection }` 与打开标签面板**同一份载荷、
     * 同一条零 IPC 路径**（与 opentabs 唯一的不同是：本面板要按纯层切片，
     * 所以自己订阅，而不是交给 `tabListHost#autoSubscribe` —— 那条会用全量投影覆盖切片）。
     *
     * 缺任何一份就回落 `loadTabs()`：两份来自同一份主进程事实，
     * 只吃一半会让「浏览态摆投影 / 搜索态摆扁平」当场错位。
     *
     * 撤销栈（最近关闭）只会在**标签增减**时变化（关闭入栈 / 恢复出栈），
     * 因此这里用 id 集合签名判断，标题 / 加载态的高频推送不会换来一次多余 IPC。
     */
    let lastTabIds: string | null = null
    let recentTimer: ReturnType<typeof setTimeout> | null = null
    function applyTabsPayload(payload: unknown) {
      // 收起期：只留**最近一帧**载荷（零 DOM / 零 IPC / 不拼 id 签名）。
      // 打开时宿主先调 `flush()` 把它一次性补齐 —— 首帧就是最新，不用等一次往返。
      if (!isActive()) {
        pendingPayload = payload
        return
      }
      pendingPayload = null
      const record = payload && typeof payload === 'object' ? payload as Record<string, unknown> : {}
      const flat = Array.isArray(record.tabs) ? record.tabs.filter(isTabRowItem) : null
      const projected = Array.isArray(record.projection) ? record.projection.filter(isTabRowItem) : null
      if (!flat || !projected) {
        scheduleTabsReload()
        return
      }
      tabFlat = flat
      tabRows = projected
      const ids = flat.map((t) => (t && t.tabId) || '').join('\u0001')
      if (lastTabIds !== null && ids !== lastTabIds) {
        if (recentTimer) clearTimeout(recentTimer)
        recentTimer = setTimeout(() => {
          recentTimer = null
          loadRecent().then(render).catch(() => {})
        }, TABS_DEBOUNCE_MS)
      }
      lastTabIds = ids
      render()
    }

    /** 空间变化（切换 / 改名 / 增删）：空间列表与**可见标签投影**一起变，两份都重拉。 */
    function scheduleSpacesReload() {
      if (!isActive()) return
      loadSpaces().then(render).catch(() => {})
      scheduleTabsReload()
    }

    /**
     * 意图总入口。四块行件上行的动作都在这里落地：
     *   spaces:  switch / rename / menu
     *   recent:  recent-restore（scope='recent'）
     *   sessions: session-restore / session-remove（scope='sessions'）
     *   view:    search / section-action（刷新 / 保存当前）/ go
     * 标签行的其余动作（切换 / 关闭 / 静音 / 分组 / 拖拽）由 `createTabListHost` 内部直连客户端。
     */
    async function handleIntent(rawIntent: unknown) {
      if (!rawIntent || typeof rawIntent !== 'object') return
      const intent = rawIntent as Record<string, unknown>
      const type = intent.type
      const intentId = typeof intent.id === 'string' ? intent.id : ''
      const profileId = typeof intent.profileId === 'string' ? intent.profileId : ''
      const name = typeof intent.name === 'string' ? intent.name : ''
      const panel = typeof intent.panel === 'string' ? intent.panel : ''

      // 搜索是**本地过滤**（数据已在内存），不发 IPC。去抖在视图那层
      //（与行列表搜索框同一档），到这里拿到的已经是稳定查询串。
      if (type === 'search') {
        query = typeof intent.query === 'string' ? intent.query : ''
        render()
        return
      }

      // 区块标题上的动作按钮：动作名由纯层 descriptor 给（`action` / `actionLabel`），
      // 这里只按名字落地 —— 新增区块动作不必再改视图，也不必再写 if。
      if (type === 'section-action') {
        if (intent.action === 'refresh') {
          if (intent.kind === 'recent') loadRecent().then(render).catch(() => {})
          return
        }
        // 会话块「保存当前」：与会话面板同一路由，名称走同一个兜底规则（永不因空名被拒）。
        if (intent.action === 'save-session') {
          Promise.resolve()
            .then(() => sessionsApi.saveNamed(defaultSessionName()))
            .then(() => loadSessions())
            .then(render)
            .catch(() => {})
          return
        }
        return
      }

      // ── 会话：行件上行（scope 消歧；与会话面板同一套意图名）──
      if (intent.scope === 'sessions') {
        const id = String(intent.id || '')
        if (!id) return
        // 点击 = 恢复该会话（追加打开，不动现有标签）；成功失败都重拉。
        if (type === 'session-restore') {
          Promise.resolve()
            .then(() => sessionsApi.restoreNamed(id))
            .then(() => loadSessions())
            .then(render)
            .catch(() => {})
          return
        }
        // hover ✕ = 删除命名会话（只删记录，已打开的标签不受影响）→ 先确认。
        if (type === 'session-remove') {
          const run = () => loadSessions().then(render).catch(() => {})
          const remove = () => sessionsApi.removeNamed(id).then(run, run).catch(() => {})
          const ask = typeof ctx.confirm === 'function' ? ctx.confirm : null
          if (!ask) {
            remove()
            return
          }
          ask({ title: '删除会话', message: '这个命名会话会被删除，已打开的标签不受影响。' })
            .then((ok) => { if (ok) remove() })
            .catch(() => {})
          return
        }
        return
      }

      // ── 最近关闭：行件上行（scope 消歧，避免与空间行的同名字段相撞）──
      if (intent.scope === 'recent') {
        // 点击 = 恢复该标签。`index` 是撤销栈下标（0 = 最近关闭在前），
        // 与历史面板 / Ctrl+Shift+T 共用同一条主进程通道；成功失败都重拉（恢复会让该项出栈）。
        const index = typeof intent.index === 'number' ? intent.index : -1
        if (type === 'recent-restore' && Number.isInteger(index) && index >= 0) {
          tabsApi.restoreRecentlyClosed(index).then(loadRecent, loadRecent).then(render).catch(() => {})
        }
        return
      }

      if (type === 'switch' && intentId) {
        // 乐观回填（等主进程往返期间标记不跳），随后以主进程事实校正。
        activeSpaceId = intentId
        if (profileId) activeProfileId = profileId
        render()
        // 选完空间即收起浮层（与 Edge 标签操作菜单一致：菜单是「随手一次」的）。
        onDismiss()
        // 成功路径**不回拉**：空间已经在主进程切好，浮层此刻正在收起，
        // 回拉只会换来 3 次 IPC + 一次看不见的 DOM 重渲染；下次打开时 `refresh()`
        // 会全量对齐（见本文件 `isActive` 处的注释）。
        // 只有失败（切换没发生，乐观值就是错的）才补一次校正 —— 未收起时立即生效，
        // 已收起时 `scheduleSpacesReload()` 内部早退，等下次打开由 `refresh()` 兜底。
        spacesApi.setUsing(profileId, intentId).catch(() => {
          scheduleSpacesReload()
        })
        return
      }

      if (type === 'rename' && intentId && profileId && name) {
        spacesApi.update(profileId, intentId, { name })
          .then(loadSpaces).then(render).catch(() => {})
        return
      }

      if (type === 'menu' && intentId && profileId) {
        openSpaceMenu({
          id: intentId,
          profileId,
          x: typeof intent.x === 'number' ? intent.x : 0,
          y: typeof intent.y === 'number' ? intent.y : 0
        })
        return
      }

      // 「还有 N 项 · 转到 xxx 面板」：先收起浮层，再在侧栏槽位里打开那块完整面板
      // （浮层是铺满整窗的模态层，不先收会把刚打开的面板挡住）。
      if (type === 'go' && panel) {
        onDismiss()
        panelsApi.toggle(panel, {})
      }
    }

    // ── 订阅（面板常驻：数据一变列表自己就更新，不需要重开）──
    // 「最近关闭」跟着标签增减走（撤销栈），由 `applyTabsPayload` 的 id 集合判据触发；
    // 不订阅 historyChanged —— 那是持久化历史的写入路径，与本块数据源无关。
    // 标签推送：优先走领域客户端的引用计数订阅 —— 载荷里直接带 `tabs` + `projection`
    // 两份数据，与打开标签面板同一条零 IPC / 零合并窗口路径。
    // 拿不到 onChanged 的环境才退回裸事件 + 合并重拉（兜底，不是主路）。
    if (typeof tabsApi.onChanged === 'function') tabsApi.onChanged(applyTabsPayload)
    else if (events && events.tabChanged) on(events.tabChanged, scheduleTabsReload)
    if (events && events.spaceChanged) on(events.spaceChanged, scheduleSpacesReload)
    // 空间窗口（换空间的那条广播）与 spaceChanged 同一条落点。
    if (events && events.spaceWindowChanged) on(events.spaceWindowChanged, scheduleSpacesReload)
    // profile 直切不经过 space:window-changed；总览里的空间 / 标签 / 命名会话
    // 都按 profile 分区，必须在这里统一补拉，否则收起前的旧数据会残留。
    if (events && events.profileChanged) {
      on(events.profileChanged, () => {
        scheduleTabsReload()
        scheduleSpacesReload()
        if (isActive()) loadSessions().then(render).catch(() => {})
      })
    }
    // 命名会话的写入路径（会话面板 / 内部页 / 总览自己）都广播这一条 —— 谁改都自动跟上。
    if (events && events.settingsChanged) {
      on(events.settingsChanged, (rawChange) => {
        const change = rawChange as Record<string, unknown>
        if (!isActive()) return
        const scope = change && change.scope
        const key = change && change.key
        if (scope === 'all' || key === NAMED_SESSIONS_SETTING_KEY) loadSessions().then(render).catch(() => {})
      })
    }

    // 首次装配：只在本浮层已经在台上时才拉（收起态由宿主在 show 时 refresh 对齐）。
    if (isActive()) refresh().catch(() => {})

    return {
      element: view.element,
      refresh,
      /**
       * 宿主**显示之后**立刻调一次（在 `open = true` 之后、`refresh()` 之前）：
       * 把收起期攒下的最近一帧标签推送与未摆的模型同步补齐 —— 零 IPC、零异步。
       * 于是"点开总览"的首帧就是最新列表；随后的 `refresh()` 只做全量校正。
       */
      flush() {
        const payload = pendingPayload
        pendingPayload = null
        if (payload) applyTabsPayload(payload)
        if (pendingRender) render()
      },
      // 浮层宿主在 show 之后调它：打开即把光标放进搜索框。
      focusSearch: () => view.focusSearch()
    }
  }
}


