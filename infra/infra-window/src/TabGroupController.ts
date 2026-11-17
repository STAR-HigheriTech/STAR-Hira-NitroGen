/**
 * 标签分屏 / 速览组生命周期控制器。
 *
 * 组规则仍由 domain-tabs 注入；本控制器只持有组的副作用编排。安装时把方法绑定到
 * TabManager 实例，保持既有调用面不变，同时隔离 Split / Glance 的状态迁移代码。
 */

const {
  ratiosForPreset,
  neighborPaneIndex,
  nextSplitLayout,
  SPLIT_LINK_ROUTING_ADJACENT,
  splitMembersForDrop,
  SPLIT_METRICS
} = require("@hira-ng/shared-types/src/split-layout")
const tabLayout = require('./tabLayout')
const { canSplit, canGlance } = require("@hira-ng/shared-types/src/tab-policy")

const SPLIT_UNDO_LIMIT = 20

import type { BrowserWindow } from 'electron'

interface TabGroupOptions {
  splitId?: string | null
  preset?: unknown
  ratios?: number[]
  direction?: string
  openerTabId?: string | null
  url?: string
  tabId?: string | null
  baseTabId?: string | null
  zone?: unknown
  mode?: string
  toIndex?: number
  glanceId?: string | null
  [key: string]: unknown
}
interface SplitDropDescriptor {
  pairId: string | null
  mode: 'split' | 'join' | 'blocked'
  count: number
  maxPanes: number
}
interface SplitUndoEntry {
  members: string[]
  layout?: unknown
  ratios: number[]
  dissolvedAt: number
}

interface GroupTabRecord {
  tabId: string
  splitId?: string | null
  glanceId?: string | null
  pinned?: boolean
  [key: string]: unknown
}
interface SplitRecord {
  splitId: string
  members?: string[]
  layout?: unknown
  ratios?: number[]
  activeTabId?: string | null
  [key: string]: unknown
}
interface GlanceRecord {
  glanceId: string
  members?: string[]
  frontTabId?: string | null
  [key: string]: unknown
}
export interface TabGroupHost {
  _tabs: Map<string, GroupTabRecord>
  _splits: Map<string, SplitRecord>
  _glances: Map<string, GlanceRecord>
  _splitUndoStack: SplitUndoEntry[]
  _wcm: { isTabSleeping(tabId: string): boolean }
  _layout: {
    setActiveSplit(payload: Record<string, unknown> | null): unknown
    setActiveGlance?(payload: Record<string, unknown> | null): unknown
    getSplitGeometry?(): { active?: string; activeTabId?: string; members?: string[]; splitId?: string } | null
    getWindow?(): BrowserWindow | null
  }
  getActiveTabId(): string | null
  list(): GroupTabRecord[]
  listSplits(): SplitRecord[]
  switchTo(tabId: string): void
  _wakeInternal(tabId: string): unknown
  _syncActiveSplit(tabId: string | null): unknown
  splitOptions(): { linkRouting?: unknown }
  adjacentTabIdOf(tabId: string): string | null
  nextSplitPaneOf(tabId: string | null | undefined): { splitId: string | null; tabId: string } | null
  navigate(options: { tabId: string; url: string }): unknown
  _showTab(tabId: string): unknown
  createSplitGroup(options: Record<string, unknown>): SplitRecord | null
  createGlanceGroup(options: Record<string, unknown>): GlanceRecord | null
  createStack(options: Record<string, unknown>): unknown
  dissolveSplit(options: Record<string, unknown>): unknown
  setSplitActive(options: Record<string, unknown>): unknown
  setSplitLayout(options: Record<string, unknown>): unknown
  setSplitRatios(options: Record<string, unknown>): { ratios?: number[] } | null
  setTabSplit(options: Record<string, unknown>): unknown
  setGlanceFront(options: Record<string, unknown>): unknown
  _focusCreatedSplit(created: SplitRecord): void
  _focusCreatedGlance(created: GlanceRecord): void
  [key: string]: unknown
}

class TabGroupController {
  readonly host: TabGroupHost

  constructor(host: TabGroupHost) {
    this.host = host
  }

  listSplits() {
    return tabLayout.listSplits(this.host)
  }

  /**
   * 建组：`{ tabIds, layout?, activeTabId? }`；不合法返回 null（IPC 层负责给原因）。
   *
   * ⚠ 建完必须让**活动格落在组内**（见 `_focusCreatedSplit`）—— 布局层的显示判据是
   * "**活动标签**属于哪个组"（`_syncActiveSplit`），活动标签不在组里 = 当场退出分屏。
   * 于是"右键标签组 → 平铺成分屏""复原上次解散的分屏"这类**活动标签在组外**的入口
   * 会建出一组数据却什么都不显示，用户看到的正是"点了没反应"。
   */
  createSplitGroup(opts: TabGroupOptions = {}) {
    const created = tabLayout.createSplitGroup(this.host, opts)
    if (created) this.host._focusCreatedSplit(created)
    return created
  }

  /**
   * 新建分屏后把活动格交给它 —— 分屏**显示出来**才算建成功。
   *
   * 优先用组自己声明的 `activeTabId`（拖拽式分屏声明的是"拖动前正在看的那一格"），
   * 它不可用时退到第一个仍存在的成员。走 `switchTo` 而不是自己拼一套：那是"让这个标签
   * 成为当前页"的**唯一**路径（顺带唤醒休眠成员、给旧标签采帧、通知可见性、发一次事件），
   * 与用户点标签完全同源，不新增第二条显示路径。
   * 活动标签本来就是成员时保持原样（`createSplitWithActive` 等入口行为一字不变）。
   */
  _focusCreatedSplit(created: SplitRecord): void {
    const members = Array.isArray(created.members) ? created.members.map(String) : []
    if (members.length < 2) return
    const active = this.host.getActiveTabId()
    if (active && members.includes(active)) {
      this.host._syncActiveSplit(active)
      return
    }
    const declared = created.activeTabId == null ? '' : String(created.activeTabId)
    const target = declared && members.includes(declared) && this.host._tabs.has(declared)
      ? declared
      : members.find((id) => this.host._tabs.has(id))
    if (target) this.host.switchTo(target)
  }

  /**
   * 「关掉分屏里的一格」之后，谁接替成为活动格。
   *
   * 为什么不能直接用 `close` 的既有规则（"左边相邻标签，没有则右边"）：分屏成员的标签顺序
   * 虽然相邻，但被关那一格的**左邻可能是组外标签** —— `_showTab(组外标签)` 会经
   * `_syncActiveSplit` 判定"活动标签不属于任何组"，于是**整片分屏被收掉**。
   * 而 ✕ 的语义是"只关这一格"（Edge / Zen 同款：还剩 ≥2 格就继续分屏，只剩 1 格才退出），
   * 所以接替格必须钉在**同组内**。
   *
   * 取"顶上被关那一格位置"的那一枚（越界取最后一枚）—— 与视觉上滑进那个空位的格子是同一个，
   * 切换目标与用户看到的一致。组已解散（`_removeTabFromSplit` 已把它裁掉）时返回 null，
   * 交回 `close` 的既有相邻规则。
   *
   * @param {string} splitId 被关标签**关掉之前**所属的组（调用方在删除记录前取好）
   * @param {string} closedTabId 被关掉的标签
   * @returns {string|null}
   */
  _splitSuccessorAfterClose(splitId: string | null | undefined, closedTabId: string | null | undefined): string | null {
    const id = splitId ? String(splitId) : ''
    if (!id) return null
    const split = this.host._splits.get(id)
    if (!split || !Array.isArray(split.members) || split.members.length < 2) return null
    const all = split.members.map(String)
    const members = all.filter((member) => this.host._tabs.has(member))
    if (members.length < 2) return null
    const at = all.indexOf(String(closedTabId))
    const idx = at >= 0 ? Math.min(at, members.length - 1) : 0
    return members[idx] || null
  }

  /**
   * 「与当前活动标签分屏」（对齐 Firefox / Zen 的 Alt+点击标签）。
   *
   * 为什么"另一个格子"在主进程解析：活动标签只有这里是权威 —— 横向标签条、纵向标签列、
   * 两个面板共 5 个宿主各维护一份"谁是当前标签"就是 5 份会漂移的状态。宿主只报被点的那个。
   */
  createSplitWithActive(tabId: string): SplitRecord | null {
    const other = String(tabId)
    const active = this.host.getActiveTabId()
    if (!active || active === other) return null
    if (!this.host._tabs.has(other) || !this.host._tabs.has(active)) return null
    // 种类裁决（真源 tab-policy）：固定标签不参与分屏。这里先拒绝，
    // 免得 createSplitGroup 过滤后只剩一枚时静默返回 null（调用方分不清"被拒"还是"无变化"）。
    if (!canSplit(this.host._tabs.get(other)) || !canSplit(this.host._tabs.get(active))) return null
    return this.host.createSplitGroup({ tabIds: [active, other], activeTabId: active })
  }

  /** 解散组（成员全部保留）。解散前记一条撤销记录，供「复原上次解散的分屏」用。 */
  dissolveSplit(opts: TabGroupOptions = {}) {
    const splitId = opts && opts.splitId != null ? String(opts.splitId) : ''
    const before = splitId ? this.host._splits.get(splitId) : null
    const res = tabLayout.dissolveSplit(this.host, opts)
    if (!res) return null
    if (before && Array.isArray(before.members) && before.members.length >= 2) {
      const members = before.members.map(String).filter((id) => this.host._tabs.has(id))
      if (members.length >= 2) {
        this.host._splitUndoStack.push({
          members,
          layout: before.layout,
          ratios: Array.isArray(before.ratios) ? before.ratios.slice() : [],
          dissolvedAt: Date.now()
        })
        if (this.host._splitUndoStack.length > SPLIT_UNDO_LIMIT) this.host._splitUndoStack.shift()
      }
    }
    this.host._syncActiveSplit(this.host.getActiveTabId())
    return res
  }

  /**
   * 按**预设**改比例（均分 / 主格 70% / 主格 30%）。
   *
   * 预设 → 比例的换算走 `shared-types#ratiosForPreset`（**格数是变量**：写死"前两格各 35%"
   * 会在 3 格时得到 70/35/35 这种和不为 1 的荒谬结果）。渲染层只报预设名。
   */
  setSplitRatioPreset({ splitId, preset }: TabGroupOptions = {}) {
    const id = splitId != null ? String(splitId) : ''
    const split = id ? this.host._splits.get(id) : null
    if (!split || !Array.isArray(split.members) || split.members.length < 2) return null
    const ratios = ratiosForPreset(preset, split.members.length)
    const res = this.host.setSplitRatios({ splitId: id, ratios })
    return res ? { splitId: id, ratios: res.ratios } : null
  }

  /**
   * 键盘驱动的**格导航**：从活动格出发、按方向切到相邻格。
   *
   * 判定走 `shared-types#neighborPaneIndex`（投影重叠优先、再比距离）；格矩形只有布局层
   * 知道，所以这里向它要快照，而不是在渲染层重算（渲染层根本量不到原生视图的位置）。
   */
  focusSplitPane(direction: string): unknown {
    if (!this.host._layout || typeof this.host._layout.getSplitGeometry !== 'function') return null
    const geo = this.host._layout.getSplitGeometry()
    if (!geo || !geo.active || !Array.isArray(geo.members)) return null
    const fromIndex = geo.members.indexOf(String(geo.activeTabId))
    if (fromIndex < 0) return null
    const nextIndex = neighborPaneIndex(geo, fromIndex, direction)
    if (nextIndex == null) return null
    const tabId = geo.members[nextIndex]
    if (!tabId) return null
    return this.host.setSplitActive({ splitId: geo.splitId, tabId })
  }

  /**
   * 复原**最近解散**的分屏组。
   *
   * 逐条往下翻而不是只看最上面一条：期间可能有成员已被关闭 —— 那条记录永远复原不了，
   * 留在栈顶等于"这个功能坏了"（按一次没反应、再按还是没反应）。不足 2 个成员的记录
   * 直接丢弃，直到找到一条能还原的。
   */
  restoreLastSplit() {
    while (this.host._splitUndoStack.length > 0) {
      const entry = this.host._splitUndoStack.pop()
      if (!entry) continue
      const members = (entry.members || []).filter((id) => this.host._tabs.has(String(id)))
      if (members.length < 2) continue
      const created = this.host.createSplitGroup({
        tabIds: members,
        layout: entry.layout,
        ratios: entry.ratios,
        activeTabId: members[0]
      })
      if (created) return { splitId: created.splitId, count: created.count }
    }
    return null
  }

  /**
   * 是否**真有一条**能复原的记录。
   *
   * 与 `restoreLastSplit()` 用**同一判据**（成员仍在的数量 ≥2）—— 两者不一致会出现
   * "菜单项出现但点了没反应"。只看"撤销栈非空"是不够的：里面的成员可能已被关闭。
   */
  canRestoreSplit() {
    return this.host._splitUndoStack.some(
      (entry) => (entry.members || []).filter((id) => this.host._tabs.has(String(id))).length >= 2
    )
  }

  /** 归一化后的分屏选项（唯一归一化点是 `tabLayout.splitOptionsOf`）。 */
  splitOptions() {
    return tabLayout.splitOptionsOf(this.host)
  }

  /**
   * 同组内「按**格序**的下一个格」。不在分屏里 / 组不足 2 格 → null。
   *
   * 为什么是"下一个"而不是"另一个"：3~4 格时分屏没有唯一的"另一边"。按格序循环是一个
   * 确定、可预期、且与**格序**（不是标签条顺序）一致的规则 —— 用户能预测落点。
   */
  nextSplitPaneOf(tabId: string | null | undefined): { splitId: string | null; tabId: string } | null {
    const id = tabId == null ? '' : String(tabId)
    const tab = id ? this.host._tabs.get(id) : null
    const splitId = tab && tab.splitId != null ? String(tab.splitId) : null
    const split = splitId ? this.host._splits.get(splitId) : null
    if (!split || !Array.isArray(split.members) || split.members.length < 2) return null
    const index = split.members.indexOf(id)
    if (index < 0) return null
    const nextId = split.members[(index + 1) % split.members.length]
    if (!nextId || nextId === id) return null
    return { splitId, tabId: String(nextId) }
  }

  /**
   * 分屏**格间链接路由**（I5）——对齐 Edge / Zen 的 "Open links in the other pane"：
   * 从某一格点开的 `target=_blank` / `window.open` 之新窗口请求，改为**在下一格里打开**，
   * 而不是新开一个标签。
   *
   * 三条边界：
   *   · 开关默认 **off**（见 `DEFAULT_SPLIT_LINK_ROUTING` 的说明）—— 它会改变网页里
   *     点击的结果去向，不该默认替用户决定；
   *   · 只处理 **foreground** 语义（调用方已排除 background-tab）：后台标签请求本来就
   *     不该抢占任何一格；
   *   · 目标格**导航过去**并成为活动格（"我要看这个新页面"是点击者的意图）。
   *
   * @param {{ openerTabId?: string, url?: string }} req
   * @returns {boolean} true = 已接管 —— 调用方**必须** `deny` 新窗口，否则会既导航又开标签
   */
  routeSplitLink({ openerTabId, url }: TabGroupOptions = {}) : boolean {
    if (this.host.splitOptions().linkRouting !== SPLIT_LINK_ROUTING_ADJACENT) return false
    const url2 = String(url || '')
    if (!url2) return false
    const target = this.host.nextSplitPaneOf(openerTabId)
    if (!target) return false
    Promise.resolve(this.host.navigate({ tabId: target.tabId, url: url2 })).catch(() => {})
    this.host.setSplitActive({ splitId: target.splitId, tabId: target.tabId })
    return true
  }

  /**
   * 标签条顺序里紧邻的下一个（没有下一个则上一个）。
   *
   * 专门给"需要一个配对对象"的入口共用 —— 目前是 `Ctrl+Shift+D` 与拖动式分屏的兜底。
   * 顺序只有这里权威（渲染层的列表顺序是投影，可能滞后一轮）。
   */
  adjacentTabIdOf(tabId: string | null | undefined): string | null {
    const id = tabId == null ? '' : String(tabId)
    if (!id) return null
    const order = this.host.list().map((tab) => String(tab.tabId))
    const index = order.indexOf(id)
    if (index < 0) return null
    return order[index + 1] || order[index - 1] || null
  }

  /**
   * 「把标签拖到了网页区域」的落点判定与执行（Arc / Edge 拖动式分屏）。
   *
   * ── 落点怎么来（**这条是整件事的关键**）──────────────────────────────
   * **绝不能用渲染层报的 `dragend` 坐标**：原生 HTML5 拖拽一旦离开源视口，
   * `dragend` 的 `clientX/clientY` 就不再是"松手在哪" —— Chromium 给的是**源视口内的
   * 最后位置**（甚至可能归零）。用它去比较内容区矩形，会得到"松手点还在标签条上"这个
   * 错误结论，于是**永远不会触发**（本功能第一版就是这么写的，表现即"用不了"）。
   * 改为在主进程读 **`screen.getCursorScreenPoint()`**：那是操作系统给的权威光标位置，
   * 与"哪个通道上报""源视口多大""缩放多少""几块屏"全部无关。
   *
   * ── 为什么判定必须在主进程 ──────────────────────────────────────────
   * 四个纵向宿主（侧栏 view / 侧栏覆盖层 / 打开标签面板 / 固定标签面板）跑在各自独立的
   * 渲染进程里，那些文档里没有主窗口外壳 DOM；而窗口内容区矩形只有主进程知道。
   * 于是**五个宿主共用这一套判据**，渲染层只报"哪个标签 + 拖前在看哪个"。
   *
   * 坐标口径：`getCursorScreenPoint()` 与 `win.getContentBounds()` 都是**屏幕 DIP**，
   * 相减即得窗口内 DIP —— 与布局层的 `pageBounds` 同一坐标系，无缩放 / 多屏换算。
   *
   * @param {{ tabId?: string, baseTabId?: string }} req
   * @returns {{ ok: boolean, reason: string, at?: number[], page?: object, split?: object }}
   *   **失败可解释**（S4）：本功能的触发条件（"松手点是否落在网页上"）对用户完全不可见，
   *   所以每条拒绝路径都给出原因与当时的坐标 —— 调用方据此留一行日志，避免"点了没反应"。
   */
  /**
   * 拖动落点的**配对与可落性** —— 预览浮层与提交共用的一份判定。
   *
   * 为什么单独开一个方法（而不是让预览自己去看标签）：预览要知道三件只有标签世界知道的事 ——
   *   · 谁是"另一格"（优先"拖动前正在看的那一个"，否则退到标签条顺序里的相邻标签）；
   *   · 那一格在不在分屏里（在 → 这次是"加入"，不是"新建两格"）；
   *   · 那一组满没满（满了 → 预览要说"放不进去"，别让用户白拖一趟）。
   * 这三条与 `dropTabOnContent` 的判据**必须逐字一致**，否则会出现"预览说能放、松手却没反应"。
   * 所以它把两条规则（配对的兜底、满员的夹取）都收在 TabManager 里，两边读同一个答案。
   *
   * @param {{ tabId?: string, baseTabId?: string }} info
   * @returns {{ pairId: string|null, mode: 'split'|'join'|'blocked', count: number, maxPanes: number }}
   *   `pairId=null` = 没有可配对的对象（只有一个标签 / 被拖的自己已在分屏里）→ **不给预览**。
   */
  describeSplitDrop(info: TabGroupOptions = {}) : SplitDropDescriptor {
    const drag = info.tabId == null ? '' : String(info.tabId)
    const none: SplitDropDescriptor = { pairId: null, mode: 'split', count: 0, maxPanes: 0 }
    if (!drag || !this.host._tabs.has(drag)) return none
    const dragTab = this.host._tabs.get(drag)
    if (!dragTab) return none
    // 固定标签不能分屏（真源 tab-policy#canSplit）→ 连落位预览都不给
    // （否则会出现"框画着、松手没反应"——预览与提交必须用同一道闸）。
    if (!canSplit(this.host._tabs.get(drag))) return none
    // 已在分屏里的标签不再"再分一次"（与 dropTabOnContent 同一条闸门，理由见那里）
    if (dragTab.splitId != null) return none
    const baseRaw = info.baseTabId == null ? '' : String(info.baseTabId)
    const pair = baseRaw && baseRaw !== drag && this.host._tabs.has(baseRaw) ? baseRaw : this.host.adjacentTabIdOf(drag)
    if (!pair || pair === drag || !this.host._tabs.has(pair)) return none
    const maxPanes = tabLayout.splitOptionsOf(this.host).maxPanes
    const pairTab = this.host._tabs.get(pair)
    if (!pairTab) return none
    const splitId = pairTab.splitId
    if (splitId == null) return { pairId: String(pair), mode: 'split', count: 2, maxPanes }
    const split = this.host._splits.get(String(splitId))
    const count = split && Array.isArray(split.members) ? split.members.length : 0
    const full = count >= maxPanes || count >= SPLIT_METRICS.maxPanes
    return { pairId: String(pair), mode: full ? 'blocked' : 'join', count, maxPanes }
  }

  /**
   * 「拖到网页区域松手」的**提交**（与上面那条预览判定同源）。
   *
   * ⚠ **唯一的"可以分"判据 = 落位框当时真的画着**：`zone` 只可能来自拖动期间那套实时采样
   *   （见 main/tab-drop-zone.js 的 intent，含 250ms 停留门禁与"不在浮层里"两条判据）。
   *   没画过框 = 用户根本没"看到"这一下 ⇒ **一律不分**。
   *   口径由用户定："不是拖过来就分屏，是等落位框显示才能开始判定，他们是一起的。"
   *
   * 于是原先那条"松手时再读一次光标"的**降级路径已删除** —— 它正是"我只把标签拖过去松了
   * 个手，却凭空分屏"的来源；而且它与预览用的是**两套时刻的坐标**（松手那一瞬 vs 最后一拍），
   * "预览明明还在、松手却没反应"这类不一致也由它而来。删掉它，所见即所得才真正成立。
   *
   * @param {{ tabId?: string, baseTabId?: string, zone?: string|null }} req
   */
  dropTabOnContent(req: TabGroupOptions = {}) {
    const { tabId, baseTabId, zone: rawZone, mode: rawMode } = req
    const zone = rawZone === 'left' || rawZone === 'right' || rawZone === 'top' || rawZone === 'bottom'
      ? rawZone
      : null
    /**
     * `join`（把标签拖进**已有分屏**里多占一格）的意图**本来就没有 `zone`** ——
     * 它的意义不在"哪一半"（那一格已经在分屏里了），整片内容区给反馈就够
     * （见 `main/tab-drop-zone.js` 里 intent 的赋值）。
     *
     * 所以"有没有画过框"这道闸必须**同时认 `mode === 'join'`**：`mode` 只在
     * `overlayShown` 为真时才会被记进意图，与 `zone` 是**同一件事的两种形状**
     * （都只在"框真的画着"时才存在）。只认 `zone` 的后果就是 join 在闸口被判成
     * "没画框"直接挡掉 → **第 3、第 4 格永远加不进来**（用户实测的症状）。
     */
    const joinIntent = rawMode === 'join'
    // 没画框就不分（见上）。放在最前：这一条与后面全部判定无关，不必再往下走。
    if (!zone && !joinIntent) return { ok: false, reason: 'no-preview' }
    const drag = tabId == null ? '' : String(tabId)
    const baseRaw = baseTabId == null ? '' : String(baseTabId)
    if (!drag || !this.host._tabs.has(drag)) return { ok: false, reason: 'unknown-tab' }
    const dragTab = this.host._tabs.get(drag)
    if (!dragTab) return { ok: false, reason: 'unknown-tab' }
    // 固定标签不能分屏（真源 tab-policy#canSplit）—— 显式拒绝并给出原因，
    // 不依赖 createSplit「跳过不合格成员」的副产物（那会静默返回 null，看不出为什么）。
    if (!canSplit(this.host._tabs.get(drag))) return { ok: false, reason: 'pinned-tab' }
    // 已经在分屏里的标签**不再"再分一次"**：那不是新入口，而是"解散旧组 + 重建新组"
    // （格序会被顺手换掉），用户看到的却是"我明明只是拖了一下"。分屏的两条标签是连着的，
    // 拖动它们只应当重排标签条（见 tabLayout#enforceSplitRuns）。
    if (dragTab.splitId != null) return { ok: false, reason: 'already-split' }

    const win = this.host._layout && typeof this.host._layout.getWindow === 'function' ? this.host._layout.getWindow() : null
    if (!win || (typeof win.isDestroyed === 'function' && win.isDestroyed())) return { ok: false, reason: 'no-window' }

    // ── 配对对象 ──────────────────────────────────────────────────────────
    // 优先"拖动前正在看的那一格"（Arc 同款语义）；**被拖的标签本来就是它**（没有别人可配对）
    // 时退到「标签条顺序里的相邻标签」——否则"把当前这个标签拖到网页上"这个**最常见的动作**
    // 会静默什么都不发生，用户只会认为功能坏了。兜底规则与 `Ctrl+Shift+D` 同一条。
    //
    // ⚠ 与 `describeSplitDrop`（预览用的那条）**逐字同一条规则**：两处一旦分叉，
    //   就会出现"预览画在这一格、松手却和另一格分屏"这种最难查的不一致。
    const pair = baseRaw && baseRaw !== drag && this.host._tabs.has(baseRaw) ? baseRaw : this.host.adjacentTabIdOf(drag)
    if (!pair || pair === drag || !this.host._tabs.has(pair)) return { ok: false, reason: 'no-pair' }
    // ── 分屏手势不再动栈归属 ───────────────────────────────────────────────
    // 「分屏 × 栈」已改为正交共存（2026-10-17 起，见 tabLayout#enforceSplitRuns 的说明）：
    // 把标签拖到网页上做分屏，只表达「我要分屏」这一件事，不再顺带把它从标签组里
    // 摘出来。想离开标签组的手势另有其位 —— 拖到标签条**空白处**（落点控制器发的
    // leaveStack）。两个手势各司其职，互不顶替。
    // 落点格**已经在分屏里** → 加入那一组（多一格），而不是把原来那一组打散重建。
    // 分屏的成员是连着的："拖到这一格上"最自然的结果就是与它同屏，不是把它拆开。
    // 满员由 setTabSplit 按用户口径（maxPanes）拦下。
    const pairTab = this.host._tabs.get(pair)
    if (!pairTab) return { ok: false, reason: 'no-pair' }
    const pairSplitId = pairTab.splitId
    if (pairSplitId != null) {
      const joined = this.host.setTabSplit({ tabId: drag, splitId: pairSplitId })
      if (!joined) return { ok: false, reason: 'split-full' }
      return { ok: true, reason: 'joined', split: joined, zone }
    }
    // join 意图、但配对标签其实不在分屏里（构造上不该发生）→ 按"没命中"收尾。
    // **绝不**退化成"建一个新组"：那是 split 意图的语义，会让一次 join 手势凭空多出一次分屏。
    if (joinIntent) return { ok: false, reason: 'no-preview' }
    // ── 方向与成员顺序 ────────────────────────────────────────────────────
    // 有 zone：左右 = row、上下 = column；左/上 → 新格在前（成员顺序 = 格的顺序）。
    // 没 zone（兜底路径）：不传 layout，由 createSplitGroup 取设置里的默认方向，顺序沿用历史行为。
    const layout = zone === 'left' || zone === 'right' ? 'row' : zone ? 'column' : undefined
    const order = zone ? splitMembersForDrop({ place: zone === 'left' || zone === 'top' ? 'start' : 'end' }, drag, pair) : [pair, drag]
    const split = this.host.createSplitGroup({ tabIds: order, layout, activeTabId: pair })
    if (!split) return { ok: false, reason: 'group-rejected' }
    return { ok: true, reason: 'ok', split, zone }
  }

  setTabSplit(opts: TabGroupOptions = {}) {
    const res = tabLayout.setTabSplit(this.host, opts)
    if (res) this.host._syncActiveSplit(this.host.getActiveTabId())
    return res
  }

  setSplitLayout(opts: TabGroupOptions = {}) {
    const res = tabLayout.setSplitLayout(this.host, opts)
    if (res) this.host._syncActiveSplit(this.host.getActiveTabId())
    return res
  }

  setSplitRatios(opts: TabGroupOptions = {}) {
    const res = tabLayout.setSplitRatios(this.host, opts)
    if (res) this.host._syncActiveSplit(this.host.getActiveTabId())
    return res
  }

  /**
   * 换活动格。**活动格变了，活动标签也要跟着变** —— 否则地址栏/快捷键/Find 仍指向旧格。
   */
  setSplitActive(opts: TabGroupOptions = {}) {
    const res = tabLayout.setSplitActive(this.host, opts)
    if (!res) return null
    const tabId = String(res.tabId)
    if (this.host._tabs.has(tabId)) {
      // 走用户切标签的同一条完整链路：可见性、原生焦点、激活打点和一次立即投影都在
      // switchTo 里完成。只调 _showTab 会改布局，却漏掉标签条高亮所需的立即广播。
      this.host.switchTo(tabId)
    }
    return res
  }

  reverseSplit(opts: TabGroupOptions = {}) {
    const res = tabLayout.reverseSplit(this.host, opts)
    if (res) this.host._syncActiveSplit(this.host.getActiveTabId())
    return res
  }

  /**
   * 轮换分屏形态（左右 → 上下 → ≥3 格时还有 网格 → 左右）。
   *
   * 排列顺序走 `shared-types#nextSplitLayout`：**主进程的工具条**与 **apps 的右键菜单**
   * 都用同一条，两处各写一份"下一个形态是什么"必然漂移（而且 2 格时要不要跳过 grid
   * 这种细节最容易只在一边写对）。
   *
   * ⚠ `listSplits()` 返回的是**数组**（只有 IPC 那条路才包成 `{ splits, canRestoreSplit }`，
   * 见 ipc/tabs.js）。这里曾经读 `res.splits` → 恒为 undefined → 找不到组、静默返回 null，
   * 表现就是 hover 工具条的「切换方向」点了没反应。
   */
  toggleSplitLayout({ splitId }: TabGroupOptions = {}) {
    const wanted = splitId != null ? String(splitId) : ''
    const split = this.host.listSplits().find((item) => item.splitId === wanted)
    if (!split) return null
    const layout = nextSplitLayout(split.layout, (split.members || []).length)
    return this.host.setSplitLayout({ splitId: split.splitId, layout })
  }

  /**
   * **拖动重排格子**（工具条的拖拽手柄）：把某一格移到另一格的位置。
   *
   * `toIndex` 由落点算出（谁被拖到谁身上就插到谁的下标），换算与"位置没变就不动"
   * 的判断都在 pure 层（`moveMemberToIndex`）—— 见 tabLayout#moveSplitMember 的说明。
   */
  moveSplitMember({ splitId, tabId, toIndex }: TabGroupOptions = {}) {
    const res = tabLayout.moveSplitMember(this.host, { splitId, tabId, toIndex })
    if (res && res.moved) this.host._syncActiveSplit(this.host.getActiveTabId())
    return res
  }

  /**
   * **收拢为标签组**：把分屏的成员收进一个标签栈（分屏 → 栈，I4 的可逆投影）。
   *
   * 这是一条**显式转换**动作（用户从菜单/工具条点了「收拢为标签组」），不是
   * 冲突裁决 —— 分屏与栈已改为正交共存（2026-10-17 起，见 tabLayout#enforceSplitRuns），
   * 平常两者可以同时挂在同一张标签上，唯独这条命令的语义就是「不要分屏了、改成收纳」。
   * 顺序仍是"先解散、再建栈"：转换的目标态里没有分屏，先建栈会让中间帧同时挂着
   * 两种归属（虽已合法，但对这条命令而言是多余的闪烁）。
   * 与 apps 里 `collapseSplitIntoStack` 是同一件事 —— 差别只是那边走 IPC 客户端、
   * 这边直接调服务（工具条跑在主进程，没有客户端可调）。
   */
  collapseSplitIntoStack({ splitId }: TabGroupOptions = {}) {
    const id = splitId != null ? String(splitId) : ''
    if (!id) return null
    const split = this.host._splits.get(id)
    const members = split && Array.isArray(split.members)
      ? split.members.map(String).filter((tabId) => this.host._tabs.has(tabId))
      : []
    if (members.length < 2) return null
    this.host.dissolveSplit({ splitId: id })
    return this.host.createStack({ tabIds: members })
  }

  _removeTabFromSplit(tabId: string): unknown {
    return tabLayout.removeTabFromSplit(this.host, tabId)
  }

  // ── 速览组（Glance，A1）—— 与分屏组同模：规则在 domain，本类只做委托与「灌给布局层」。
  //    第三条正交维度：栈收纳 / 分屏并列 / 速览叠放。成员恒为 2 张，front 叠在 back 之上。

  /** 全部速览组（脱壳快照）。 */
  listGlances() {
    return tabLayout.listGlances(this.host)
  }

  /** 建组：`{ tabIds, frontTabId? }`；不合法（≠2 或标签不存在）返回 null。 */
  createGlanceGroup(opts: TabGroupOptions = {}) {
    const created = tabLayout.createGlanceGroup(this.host, opts)
    if (created) this.host._focusCreatedGlance(created)
    return created
  }

  /**
   * 「把某标签与当前活动标签叠成速览」（对齐 tabbar 右键的「速览」）。
   * 另一个成员在主进程解析（活动标签只有这里是权威）—— 与 `createSplitWithActive` 同款。
   *
   * ── 为什么建组后必须**切到被点的那张** ────────────────────────────
   * `_syncActiveSplit` 里有一条硬不变量：**front 恒等于活动标签**（视觉焦点必须与前台大卡
   * 一致，见那里的注释）。于是"把 front 设成非活动标签"这条路根本走不通 —— 下一趟同步
   * 会把它**原样改回活动标签**。
   *
   * 而「速览」的语义是"**把被点的那张叠到前面给我看**"（domain 的 `createGlance` 注释也写着
   * "*'速览页'通常是被点的那张*"）。所以正确做法不是跟不变量对抗，而是**顺手切过去**：
   * 被点的那张成为活动标签 → 不变量成立 → 它稳稳待在前台，原来那张退到后面当底页。
   *
   * 不切的话，结果由"**建组前你在哪张标签上**"决定，与被点的标签无关：前台永远是"你原来
   * 那张"，被点的永远在后面只露一条边 —— 表现出来正是"设了没反应，得手动切到那张才显示"，
   * 而且看起来像"上下顺序有问题"（其实决定结果的一直是**活动标签**，不是标签条里的位置）。
   */
  createGlanceWithActive(tabId: string): GlanceRecord | null {
    const other = String(tabId)
    const active = this.host.getActiveTabId()
    if (!active || active === other) return null
    if (!this.host._tabs.has(other) || !this.host._tabs.has(active)) return null
    // 种类裁决（真源 tab-policy）：固定标签不参与速览。必须在 switchTo **之前**拦，
    // 否则被点的固定标签会被切过去、建组却失败 —— 表现为"点了速览，标签跳了一下啥也没发生"。
    if (!canGlance(this.host._tabs.get(other)) || !canGlance(this.host._tabs.get(active))) return null
    // ⚠ 顺序是"**先切过去、再建组**"，不能反：
    //   建组会走 `_focusCreatedGlance`，它以"当下的活动标签"为准灌一次布局。
    //   若先建组再切，中间那一趟前台还是旧标签，会看到画面跳一下（两趟布局）；
    //   先切过去，活动标签已经是被点的这张，建组那一趟就是最终形态 —— **一趟布局**。
    try { this.host.switchTo(other) } catch (_) {}
    // members 顺序恒为 [back, front]（见 tabLayout 的字段说明）：
    // 原来那张当底页（back），被点的这张当速览页（front）。
    return this.host.createGlanceGroup({ tabIds: [active, other], frontTabId: other })
  }

  /**
   * 交换前后（把某成员提为前台大卡）。
   *
   * ⚠ 同样必须**同时激活**它：front ≡ 活动标签是不变量，只改 front 会被下一趟
   * `_syncActiveSplit` 改回去 —— 「置于速览前台」就变成了"点了没反应"。
   */
  setGlanceFront(opts: TabGroupOptions = {}) {
    const res = tabLayout.setGlanceFront(this.host, opts)
    if (!res) return res
    const target = String(res.tabId)
    const active = this.host.getActiveTabId()
    if (active && active !== target && this.host._tabs.has(target)) {
      try { this.host.switchTo(target) } catch (_) {}
    } else {
      this.host._syncActiveSplit(active)
    }
    return res
  }

  /** 解散组（两张标签都保留，只清归属）。 */
  dissolveGlance(opts: TabGroupOptions = {}) {
    const res = tabLayout.dissolveGlance(this.host, opts)
    if (res) this.host._syncActiveSplit(this.host.getActiveTabId())
    return res
  }

  /**
   * 建组后让**活动标签落在组内**（否则布局层的显示判据"活动标签属于哪个组"不成立，
   * 会立刻退出速览 —— 与 `_focusCreatedSplit` 同款坑）。
   */
  _focusCreatedGlance(created: GlanceRecord): void {
    const members = Array.isArray(created.members) ? created.members.map(String) : []
    if (members.length < 2) return
    const active = this.host.getActiveTabId()
    if (active && members.includes(active)) {
      this.host._syncActiveSplit(active)
      return
    }
    const declared = created.frontTabId == null ? '' : String(created.frontTabId)
    const target = declared && members.includes(declared) && this.host._tabs.has(declared)
      ? declared
      : members.find((id) => this.host._tabs.has(id))
    if (target) this.host.switchTo(target)
  }

  _removeTabFromGlance(tabId: string): unknown {
    return tabLayout.removeTabFromGlance(this.host, tabId)
  }

  /**
   * 把「当前标签所属的分组」灌给布局层 —— **分屏与速览共用的唯一同步点**。
   *
   * 为什么合成一个方法而不是各加一个同步点：两者的显示判据都是"**活动标签**属于哪个组"，
   * 而 ~10 处调用点散落在切换/关闭/建组/拖拽里。合成后所有既有调用点零改动，
   * 且冲突裁决（速览优先于分屏）只在这里写**一次**。
   *
   * 顺序：活动标签命中速览组（成员恰好 2 且都还在）→ 先收分屏、再灌速览；
   * 否则灌 null 速览 + 走原分屏逻辑。速览与分屏本就互斥（建组时互摘），这里只是兜底。
   *
   * ⚠ 组内**非活动成员必须先唤醒**：休眠标签没有 view，布局会把那一格算成黑洞。
   *   唤醒走 `_wakeInternal`（会还原导航历史并重新绑定事件），不是简单的 createTab。
   *
   * @param {string} tabId 活动标签
   */
  _syncActiveSplit(tabId: string | null): unknown {
    if (!this.host._layout || typeof this.host._layout.setActiveSplit !== 'function') return null
    const id = tabId == null ? '' : String(tabId)
    const tab = id ? this.host._tabs.get(id) : null
    // ── 速览优先：活动标签命中一个有效速览组 → 收分屏、灌速览，直接返回。
    const glanceId = tab && tab.glanceId != null ? String(tab.glanceId) : null
    const glance = glanceId ? this.host._glances.get(glanceId) : null
    if (glance && Array.isArray(glance.members) && glance.members.length === 2) {
      this.host._layout.setActiveSplit(null)
      if (typeof this.host._layout.setActiveGlance === 'function') {
        // front 恒为**活动标签**：视觉焦点与前台大卡一致（点背景卡 = 把它提到最上面）。
        let frontId = String(glance.frontTabId)
        if (frontId !== id && glance.members.includes(id)) {
          // 直接走 tabLayout（不调 this.host.setGlanceFront，避免它再回调本方法形成递归）。
          tabLayout.setGlanceFront(this.host, { glanceId: glance.glanceId, tabId: id })
          frontId = id
        }
        for (const memberId of glance.members) {
          if (memberId === id) continue
          if (this.host._wcm.isTabSleeping(memberId)) this.host._wakeInternal(memberId)
        }
        if (!glance.members.includes(frontId)) frontId = String(glance.members[glance.members.length - 1])
        return this.host._layout.setActiveGlance({
          glanceId: glance.glanceId,
          members: glance.members.slice(),
          frontTabId: frontId,
          activeTabId: id
        })
      }
    }
    // ── 非速览：清掉可能残留的速览态，走原分屏逻辑。
    if (typeof this.host._layout.setActiveGlance === 'function') this.host._layout.setActiveGlance(null)
    const splitId = tab && tab.splitId != null ? String(tab.splitId) : null
    if (!splitId) {
      return this.host._layout.setActiveSplit(null)
    }
    let split = this.host._splits.get(splitId)
    if (!split || !Array.isArray(split.members) || split.members.length < 2) {
      return this.host._layout.setActiveSplit(null)
    }
    // 网页格获得焦点和标签条单击都会走 switchTo/_showTab，最终到这里。活动格必须在这里
    // 同步回分屏真源：布局层自己有 activeTabId，但分屏组不能靠它隐式更新，否则下一次
    // 读组、持久化会话或工具条动作仍会看到旧格，出现高亮与数据不一致。
    if (String(split.activeTabId || '') !== id) {
      const focused = tabLayout.setSplitActive(this.host, { splitId: split.splitId, tabId: id })
      if (focused) split = this.host._splits.get(splitId) || split
    }
    const members = Array.isArray(split.members) ? split.members : []
    if (members.length < 2) return this.host._layout.setActiveSplit(null)
    for (const memberId of members) {
      if (memberId === id) continue
      if (this.host._wcm.isTabSleeping(memberId)) this.host._wakeInternal(memberId)
    }
    return this.host._layout.setActiveSplit({
      splitId: split.splitId,
      members: members.slice(),
      layout: split.layout,
      ratios: Array.isArray(split.ratios) ? split.ratios.slice() : [],
      activeTabId: id
    })
  }


}

function installTabGroupController(host: TabGroupHost): TabGroupController {
  const controller = new TabGroupController(host)
  const hostRecord = host as unknown as Record<string, unknown>
  const controllerRecord = controller as unknown as Record<string, (...args: unknown[]) => unknown>
  for (const name of Object.getOwnPropertyNames(TabGroupController.prototype)) {
    if (name === "constructor") continue
    const method = controllerRecord[name]
    if (method) hostRecord[name] = method.bind(controller)
  }
  return controller
}

export { installTabGroupController, TabGroupController }
