const { randomUUID } = require('crypto')
const { SPLIT_METRICS, normalizeSplitLinkRouting, moveMemberToIndex } = require('@hira-ng/shared-types/src/split-layout')
// 标签「种类」能力的唯一裁决中心（固定标签 = 特殊种类）：
// 分屏 / 速览 / 堆组 / 合并 / 排序 / 空栈回收 全部走同一份判据，不再在本文件各处写 `!pinned`。
const {
  stackPolicy,
  canSplit,
  canGlance,
  canJoinStack,
  canMergeStacks,
  canReorderAcross,
  canLeaveStack,
  allSameKind
} = require('@hira-ng/shared-types/src/tab-policy')

interface LayoutTabRecord {
  tabId: string
  position?: number
  stackId?: string | null
  splitId?: string | null
  glanceId?: string | null
  pinned?: boolean
  [key: string]: unknown
}
interface LayoutStackRecord {
  stackId: string
  label?: string
  accent?: string
  collapsed?: boolean
  pinned?: boolean
  [key: string]: unknown
}
interface LayoutSplitRecord {
  splitId: string
  members?: string[]
  ratios?: number[]
  layout?: unknown
  [key: string]: unknown
}
interface LayoutGlanceRecord {
  glanceId: string
  members?: string[]
  frontTabId?: string
  [key: string]: unknown
}
export interface LayoutMutationResult {
  ok?: boolean
  changed?: boolean
  error?: string
  tabs?: LayoutTabRecord[]
  stacks?: LayoutStackRecord[]
  splits?: LayoutSplitRecord[]
  glances?: LayoutGlanceRecord[]
  ids?: string[]
  stack?: LayoutStackRecord
  split?: LayoutSplitRecord
  glance?: LayoutGlanceRecord
  stackId?: string | null
  splitId?: string | null
  glanceId?: string | null
  layout?: unknown
  ratios?: number[]
  members?: string[]
  children?: string[]
  count?: number
  tabId?: string | null
  [key: string]: unknown
}
interface TabStackPort {
  projectTabStacks?(tabs: LayoutTabRecord[], stacks: LayoutStackRecord[]): unknown
  getAllStacks?(tabs: LayoutTabRecord[], stacks: LayoutStackRecord[]): unknown
  getStack?(tabs: LayoutTabRecord[], stacks: LayoutStackRecord[], options: { stackId: string }): unknown
  createStack?(tabs: LayoutTabRecord[], stacks: LayoutStackRecord[], options: Record<string, unknown>): LayoutMutationResult | null
  reorderTabs?(tabs: LayoutTabRecord[], stacks: LayoutStackRecord[], options: Record<string, unknown>): LayoutMutationResult | null
  setTabStack?(tabs: LayoutTabRecord[], stacks: LayoutStackRecord[], options: Record<string, unknown>): LayoutMutationResult | null
  moveTabToStack?(tabs: LayoutTabRecord[], stacks: LayoutStackRecord[], options: Record<string, unknown>): LayoutMutationResult | null
  unpinTab?(tabs: LayoutTabRecord[], stacks: LayoutStackRecord[], options: Record<string, unknown>): LayoutMutationResult | null
  mergeStacks?(tabs: LayoutTabRecord[], stacks: LayoutStackRecord[], options: Record<string, unknown>): LayoutMutationResult | null
  dissolveStack?(tabs: LayoutTabRecord[], stacks: LayoutStackRecord[], options: Record<string, unknown>): LayoutMutationResult | null
  renameStack?(stacks: LayoutStackRecord[], options: Record<string, unknown>): LayoutMutationResult | null
  setStackColor?(stacks: LayoutStackRecord[], options: Record<string, unknown>): LayoutMutationResult | null
  updateStack?(stacks: LayoutStackRecord[], options: Record<string, unknown>): LayoutMutationResult | null
}
interface TabSplitPort {
  createSplit(tabs: LayoutTabRecord[], splits: LayoutSplitRecord[], options: Record<string, unknown>): LayoutMutationResult
  coalesceSplitRuns(ids: string[], splits: LayoutSplitRecord[]): unknown
  setTabSplit(tabs: LayoutTabRecord[], splits: LayoutSplitRecord[], options: Record<string, unknown>): LayoutMutationResult
  dissolveSplit(tabs: LayoutTabRecord[], splits: LayoutSplitRecord[], options: Record<string, unknown>): LayoutMutationResult
  setSplitLayout(tabs: LayoutTabRecord[], splits: LayoutSplitRecord[], options: Record<string, unknown>): LayoutMutationResult
  setSplitRatios(tabs: LayoutTabRecord[], splits: LayoutSplitRecord[], options: Record<string, unknown>): LayoutMutationResult
  setSplitActive(tabs: LayoutTabRecord[], splits: LayoutSplitRecord[], options: Record<string, unknown>): LayoutMutationResult
  reverseSplit(tabs: LayoutTabRecord[], splits: LayoutSplitRecord[], options: Record<string, unknown>): LayoutMutationResult
  moveTabToSplit(tabs: LayoutTabRecord[], splits: LayoutSplitRecord[], options: Record<string, unknown>): LayoutMutationResult
  removeMember(tabs: LayoutTabRecord[], splits: LayoutSplitRecord[], options: Record<string, unknown>): LayoutMutationResult
  pruneDegenerateSplits(tabs: LayoutTabRecord[], splits: LayoutSplitRecord[]): LayoutMutationResult
}
interface TabGlancePort {
  createGlance(tabs: LayoutTabRecord[], glances: LayoutGlanceRecord[], options: Record<string, unknown>): LayoutMutationResult
  setGlanceFront(tabs: LayoutTabRecord[], glances: LayoutGlanceRecord[], options: Record<string, unknown>): LayoutMutationResult
  dissolveGlance(tabs: LayoutTabRecord[], glances: LayoutGlanceRecord[], options: Record<string, unknown>): LayoutMutationResult
  removeTabFromGlance(tabs: LayoutTabRecord[], glances: LayoutGlanceRecord[], options: Record<string, unknown>): LayoutMutationResult
  pruneDegenerateGlances(tabs: LayoutTabRecord[], glances: LayoutGlanceRecord[]): LayoutMutationResult
}
export interface TabLayoutHost {
  _tabs: Map<string, LayoutTabRecord>
  _stacks: Map<string, LayoutStackRecord>
  _splits: Map<string, LayoutSplitRecord>
  _glances: Map<string, LayoutGlanceRecord>
  _tabStacks?: TabStackPort
  _tabSplits?: TabSplitPort
  _tabGroups?: TabGlancePort
  _tabRules: { reorderIds(ids: string[], options: { draggedId: string; targetId: string; insertAfter: boolean }): { ok: boolean; ids: string[] } }
  _orderedEntries?(): Array<[string, LayoutTabRecord]>
  _ruleInput(): LayoutTabRecord[]
  _scheduleEmitChanged(): void
  _getSplitOptions?(): { maxPanes?: unknown; defaultLayout?: unknown; linkRouting?: unknown }
  list(): LayoutTabRecord[]
}

interface TabLayoutOptions {
  stackId?: string | null
  tabId?: string | null
  tabIds?: string[]
  label?: string
  accent?: string
  collapsed?: boolean
  pinned?: boolean
  patch?: Partial<LayoutStackRecord>
  sourceStackId?: string | null
  targetStackId?: string | null
  draggedId?: string | null
  targetId?: string | null
  insertAfter?: boolean
  notify?: boolean
  splitId?: string | null
  layout?: unknown
  ratios?: number[]
  toIndex?: number
  glanceId?: string | null
  [key: string]: unknown
}

/**
 * 标签「布局」域（对齐 RT `TabLayoutManager`）——标签栈 CRUD 与顺序调整。
 *
 * 从 TabManager 这尊上帝对象里整块剥离：栈的增删改合拆、标签拖拽重排、空栈回收，
 * 全部收口在这里。模块本身**无状态**，一切运行时数据都从宿主读、经宿主写，
 * 因此可以不依赖 Electron 单测（与 tabLifecycle / tabPreSleep 同一模式）。
 *
 * 宿主契约（TabManager 提供）：
 *   _tabs          Map<tabId, tabRecord>   —— 唯一真源，栈归属写在 tab.stackId 上
 *   _stacks        Map<stackId, stackMeta> —— 栈元数据（label/accent/collapsed）
 *   _tabStacks     注入的 domain 端口（可选）—— 纯函数，给「结果」不给「副作用」
 *   _tabRules      注入的 domain 端口（必填）—— reorderIds 纯函数
 *   _ruleInput()   产出只读快照数组交给 domain（不暴露 Map）
 *   _scheduleEmitChanged() 变更后合并通知（对齐 RT scheduleUpdateTabState）
 *
 * 设计要点：domain 端口是**可选**的。注入了就委托（拿到 tabs/stacks 结果集），
 * 没注入就本地回退（语义与 domain 一致）。这保证 verify-* 这类只注入 tabRules
 * 的既有调用不被破坏，也让 domain 可以灰度上线。
 */

/** 按 position 排好的 tabId 数组（对齐 RT：顺序来自记录字段，不依赖 Map 插入顺序）。 */
function orderedIds(host: TabLayoutHost) {
  if (typeof host._orderedEntries === 'function') return host._orderedEntries().map(([id]) => id)
  return Array.from(host._tabs.entries())
    .sort((a, b) => (Number(a[1]?.position) || 0) - (Number(b[1]?.position) || 0))
    .map(([id]) => id)
}

/** @param {object} host */
function listStacks(host: TabLayoutHost) {
  return Array.from(host._stacks.values()).map((stack) => ({ ...stack }))
}

/** 把栈信息投影到标签列表上（domain 负责拼 children），未注入则原样返回。 */
function listProjection(host: TabLayoutHost) {
  return listProjectionOf(host, host.list())
}

/**
 * 同 `listProjection`，但**复用调用方已经算好的扁平列表**。
 *
 * `tab:changed` 推送同时携带 tabs 与 projection：若 projection 再调一次 `host.list()`，
 * 每次推送就要把整张标签表（含排序与逐条投影）算两遍 —— 页面加载期 16ms 一次，纯重复。
 *
 * @param {object} host
 * @param {Array<object>} tabs
 */
function listProjectionOf(host: TabLayoutHost, tabs: LayoutTabRecord[]): unknown {
  if (!host._tabStacks || typeof host._tabStacks.projectTabStacks !== 'function') return tabs
  return host._tabStacks.projectTabStacks(tabs, listStacks(host))
}

/** 本地派生 `{...stack, count, children}`（domain 端口缺失时的唯一回退口径）。 */
function decorateStack(tabList: LayoutTabRecord[], stack: LayoutStackRecord): LayoutStackRecord & { count: number; children: string[] } {
  const children = (Array.isArray(tabList) ? tabList : [])
    .filter((tab) => tab && tab.stackId != null && String(tab.stackId) === stack.stackId)
    .map((tab) => String(tab.tabId))
  return { ...stack, count: children.length, children }
}

/** 全部栈（每项带 count/children）。domain 端口优先，缺端口时本地派生。 */
function getAllStacks(host: TabLayoutHost) {
  const stacks = listStacks(host)
  const tabs = host.list()
  if (host._tabStacks && typeof host._tabStacks.getAllStacks === 'function') {
    return host._tabStacks.getAllStacks(tabs, stacks)
  }
  return stacks.map((stack) => decorateStack(tabs, stack))
}

/** 取单个栈（带 count/children）；不存在 → null。 */
function getStack(host: TabLayoutHost, { stackId }: TabLayoutOptions = {}) {
  const id = stackId == null ? null : String(stackId)
  if (!id) return null
  const stack = host._stacks.get(id)
  if (!stack) return null
  const tabs = host.list()
  if (host._tabStacks && typeof host._tabStacks.getStack === 'function') {
    return host._tabStacks.getStack(tabs, listStacks(host), { stackId: id })
  }
  return decorateStack(tabs, { ...stack })
}

/** 某标签所属的栈（不在栈里 → null）。 */
function getStackOfTab(host: TabLayoutHost, { tabId }: TabLayoutOptions = {}) {
  const id = tabId == null ? null : String(tabId)
  if (!id) return null
  const tab = host._tabs.get(id)
  if (!tab || tab.stackId == null) return null
  return getStack(host, { stackId: tab.stackId })
}

/** 标签是否归属任一现存栈（悬空指针不算）。 */
function isTabInAnyStack(host: TabLayoutHost, { tabId }: TabLayoutOptions = {}) {
  return getStackOfTab(host, { tabId }) != null
}

/**
 * 把 domain 返回的结果集**就地合并**回内部 Map（不重建 Map，也不动 Map 身份）。
 * 对齐 RT：顺序由结果集的次序 → 写进各记录的 `position`（0..n-1），
 * 因此读侧按 position 排序即得与 domain 一致的结果，且省掉旧实现每次的
 * `new Map(result.tabs.map(...))` 全量重建（栈操作本属低频，但重建会打断
 * Map 身份、让所有持有 `_tabs` 引用的地方读到旧对象，是隐性缺陷）。
 */
function applyStackRule(host: TabLayoutHost, result: LayoutMutationResult | null | undefined): void {
  if (!result) return
  if (Array.isArray(result.tabs)) {
    const seen = new Set()
    for (let i = 0; i < result.tabs.length; i++) {
      const incoming = result.tabs[i]
      if (!incoming) continue
      const id = String(incoming.tabId)
      seen.add(id)
      const existing = host._tabs.get(id)
      if (existing) Object.assign(existing, incoming, { position: i })
      else host._tabs.set(id, { ...incoming, position: i })
    }
    for (const id of Array.from(host._tabs.keys())) {
      if (!seen.has(id)) host._tabs.delete(id)
    }
  }
  if (Array.isArray(result.stacks)) host._stacks = new Map(result.stacks.map((stack: LayoutStackRecord) => [String(stack.stackId), stack]))
  // 顺序刚被改写 → 立刻把分屏组重新合拢（不变式见 enforceSplitRuns），
  // 再把固定分组在 pinned 段内合拢（见 enforcePinnedStackRuns）。
  enforceSplitRuns(host)
  enforcePinnedStackRuns(host)
}

/**
 * 回收没有任何标签归属的空栈（避免栈列表越用越长）。
 * 固定文件夹（pinned 栈）例外：它是用户显式创建的收藏夹，空着也应当留在原处。
 */
function removeEmptyStacks(host: TabLayoutHost) {
  const used = new Set()
  for (const tab of host._tabs.values()) if (tab.stackId != null) used.add(String(tab.stackId))
  // 是否允许空栈由种类能力裁决（固定文件夹允许，普通组不允许）—— 真源 tab-policy。
  for (const [stackId, stack] of host._stacks) {
    if (!used.has(String(stackId)) && !stackPolicy(stack).allowsEmpty) host._stacks.delete(stackId)
  }
}

/**
 * 用给定 tabIds 建栈。
 *
 * 成员约束按类型分开：
 *   · 普通标签组 —— 必须至少有一个**已存在**的标签（空组毫无意义）；
 *   · 固定文件夹（pinned）—— 允许 0 成员，因为它是用户先建好的收藏夹，
 *     随后再把标签「添加到固定文件夹」。上层 IPC 依赖这条语义。
 */
function createStack(host: TabLayoutHost, { tabIds, label, accent, collapsed, pinned }: TabLayoutOptions = {}) {
  const ids = Array.isArray(tabIds) ? new Set(tabIds.map(String)) : new Set()
  const members = orderedIds(host).filter((tabId) => ids.has(tabId))
  const records = members.map((tabId) => host._tabs.get(tabId)).filter((record): record is LayoutTabRecord => !!record)
  // 种类裁决（真源 tab-policy）—— 一个组只能是一种种类：
  //   · `pinned: true`  = 「把这些标签固定成新文件夹」→ 允许把普通标签固定进来（这就是 pin 动作）；
  //   · `pinned: false` = 「建普通组」→ 固定标签必须离开，只能走显式 unpin，不能借建组悄悄取消固定；
  //   · 未指定          = 由成员裁决；成员混种类说明调用方意图不明 → 拒绝。
  //     旧实现把「普通组里混了一张固定标签」当成整组升级为固定组，等于静默固定了一批普通标签。
  if (pinned === false && records.some((rec) => !canJoinStack(rec, null))) {
    throw new Error('Pinned tabs cannot join a normal tab stack')
  }
  if (pinned !== true && pinned !== false && !allSameKind(records)) {
    throw new Error('Tab stack members must share the same kind (pinned / normal)')
  }
  const pinnedGroup = pinned === true || (pinned !== false && records.length > 0 && !!records[0]?.pinned)
  if (members.length === 0 && !pinnedGroup) throw new Error('Tab stack requires at least one existing tab')
  const stackId = randomUUID()
  const stack = {
    stackId,
    // 没给名字：固定分组用默认文件夹名（用户随后可在芯片/组行上重命名），普通组留空由 UI 兜底。
    label: typeof label === 'string' ? label : (pinnedGroup ? DEFAULT_PINNED_LABEL : ''),
    accent: typeof accent === 'string' ? accent : '',
    collapsed: !!collapsed,
    pinned: pinnedGroup
  }
  host._stacks.set(stackId, stack)
  for (const tabId of members) {
    const rec = host._tabs.get(tabId)
    if (!rec) continue
    rec.stackId = stackId
    // 成员 pinned 必须与所属组一致（pinned ⟺ 属于 pinned 栈）
    rec.pinned = pinnedGroup
    // 固定标签必须独占：进固定分组即退出分屏 / 速览（与 TabManager.togglePin 同一条裁决）
    if (pinnedGroup) enforcePinnedExclusivity(host, tabId)
  }
  // 成员可能是从别的栈里**拉过来**的：那个源栈可能就此空了，必须一起清掉，
  // 否则会留下一份没有成员的栈元数据（投影里看不见，但它还占着 id 与内存）。
  removeEmptyStacks(host)
  enforcePinnedStackRuns(host)
  host._scheduleEmitChanged()
  return { ...stack, count: members.length, children: members }
}

/** 把单个标签移入/移出某个栈（stackId 传 null 即出栈）。 */
function setTabStack(host: TabLayoutHost, { tabId, stackId }: TabLayoutOptions = {}) {
  const id = String(tabId)
  if (!host._tabs.has(id)) throw new Error(`Missing tab: ${id}`)
  const nextStackId = stackId == null ? null : String(stackId)
  if (nextStackId && !host._stacks.has(nextStackId)) throw new Error(`Missing tab stack: ${nextStackId}`)
  const target = nextStackId ? host._stacks.get(nextStackId) : null
  // 种类裁决（真源 tab-policy）：固定标签 ↔ 普通组一律拒绝；
  // 固定标签「出栈」等于取消固定，语义属于 pin 动作，只能走 unpinTab（见下方）。
  if (!canJoinStack(host._tabs.get(id), target)) return null
  const targetPinned = !!target && !!target.pinned
  const result = host._tabStacks?.moveTabToStack?.(host._ruleInput(), listStacks(host), { tabId: id, stackId: nextStackId })
  if (result) applyStackRule(host, result)
  else {
    const rec = host._tabs.get(id)
    if (!rec) return null
    rec.stackId = nextStackId
    rec.pinned = targetPinned
    removeEmptyStacks(host)
    enforcePinnedStackRuns(host)
  }
  // 进固定分组 = 固定 + 退出分屏 / 速览（固定标签是常驻单体，不参与任何并列/叠放）
  if (targetPinned) enforcePinnedExclusivity(host, id)
  host._scheduleEmitChanged()
  return { tabId: id, stackId: nextStackId, pinned: !!(host._tabs.get(id) || {}).pinned }
}

/**
 * **取消固定** —— 固定标签离开固定文件夹的唯一出口。
 *
 * 为什么不复用 `setTabStack(tabId, null)`：那条是「普通出栈」通道，对固定标签必须拒绝
 * （否则拖拽 / 菜单任何一次误调用都会静默取消固定）。取消固定是 pin 动作的另一半，
 * 语义与出栈不同，因此单独一个入口 —— 菜单、快捷键、拖拽都只调这里。
 *
 * 规则本体在 domain（`TabStacks.unpinTab`）；未注入端口时本地回退，语义逐字一致。
 */
function unpinTab(host: TabLayoutHost, { tabId }: TabLayoutOptions = {}) {
  const id = String(tabId)
  const rec = host._tabs.get(id)
  if (!rec) throw new Error(`Missing tab: ${id}`)
  if (!rec.pinned && rec.stackId == null) return { tabId: id, stackId: null, pinned: false }
  const result = host._tabStacks?.unpinTab?.(host._ruleInput(), listStacks(host), { tabId: id })
  if (result) applyStackRule(host, result)
  else {
    rec.pinned = false
    rec.stackId = null
    removeEmptyStacks(host)
    enforcePinnedStackRuns(host)
  }
  host._scheduleEmitChanged()
  return { tabId: id, stackId: null, pinned: false }
}

/** 折叠/展开一个栈。 */
function toggleStack(host: TabLayoutHost, stackId: string): { stackId: string; collapsed: boolean } {
  const id = String(stackId)
  const stack = host._stacks.get(id)
  if (!stack) throw new Error(`Missing tab stack: ${id}`)
  stack.collapsed = !stack.collapsed
  host._scheduleEmitChanged()
  return { stackId: id, collapsed: stack.collapsed }
}

/** 重命名一个栈。 */
function renameStack(host: TabLayoutHost, { stackId, label }: TabLayoutOptions = {}) {
  const id = String(stackId)
  if (!host._stacks.has(id)) throw new Error(`Missing tab stack: ${id}`)
  const result = host._tabStacks?.renameStack?.(listStacks(host), { stackId: id, label })
  if (result) applyStackRule(host, result)
  else {
    const stack = host._stacks.get(id)
    if (stack) stack.label = typeof label === 'string' ? label.trim() : ''
  }
  host._scheduleEmitChanged()
  return { stackId: id, label: host._stacks.get(id)?.label }
}

/** 设置栈的强调色。 */
function setStackColor(host: TabLayoutHost, { stackId, accent }: TabLayoutOptions = {}) {
  const id = String(stackId)
  if (!host._stacks.has(id)) throw new Error(`Missing tab stack: ${id}`)
  const result = host._tabStacks?.setStackColor?.(listStacks(host), { stackId: id, accent })
  if (result) applyStackRule(host, result)
  else {
    const stack = host._stacks.get(id)
    if (stack) stack.accent = typeof accent === 'string' ? accent.trim() : ''
  }
  host._scheduleEmitChanged()
  return { stackId: id, accent: host._stacks.get(id)?.accent }
}

/**
 * 通用字段 patch（白名单 label / accent / collapsed）—— 一次改动 = 一次通知。
 * 规则在 domain（`TabStacks.updateStack`），这里只负责「校验存在 → 落库 → 通知」。
 */
function updateStack(host: TabLayoutHost, { stackId, patch }: TabLayoutOptions = {}) {
  const id = String(stackId)
  if (!host._stacks.has(id)) throw new Error(`Missing tab stack: ${id}`)
  const result = host._tabStacks?.updateStack?.(listStacks(host), { stackId: id, patch })
  let changed = []
  if (result) {
    applyStackRule(host, result)
    changed = Array.isArray(result.changed) ? result.changed : []
  } else {
    // 本地回退：与 domain 的白名单/归一化逐字一致。
    const stack = host._stacks.get(id)
    if (!stack) throw new Error(`Missing tab stack: ${id}`)
    const source = patch && typeof patch === 'object' ? patch : {}
    if (typeof source.label === 'string') {
      stack.label = source.label.trim()
      changed.push('label')
    }
    if (typeof source.accent === 'string') {
      stack.accent = source.accent.trim()
      changed.push('accent')
    }
    if (typeof source.collapsed === 'boolean') {
      stack.collapsed = source.collapsed
      changed.push('collapsed')
    }
  }
  host._scheduleEmitChanged()
  const stack = host._stacks.get(id)
  return {
    stackId: id,
    label: stack ? stack.label : '',
    accent: stack ? stack.accent : '',
    collapsed: stack ? !!stack.collapsed : false,
    changed
  }
}

/** 合并两个栈：source 的成员全部并入 target，source 消失。 */
function mergeStacks(host: TabLayoutHost, { sourceStackId, targetStackId }: TabLayoutOptions = {}) {
  const sourceId = String(sourceStackId)
  const targetId = String(targetStackId)
  if (sourceId === targetId) throw new Error('Source and target tab stacks must differ')
  if (!host._stacks.has(sourceId)) throw new Error(`Missing tab stack: ${sourceId}`)
  if (!host._stacks.has(targetId)) throw new Error(`Missing tab stack: ${targetId}`)
  // 种类裁决（真源 tab-policy）：固定文件夹 ↔ 普通组不许互合并 ——
  // 那会把整组成员静默固定 / 取消固定，用户点一次「合并」不该改动一批标签的 pin 状态。
  if (!canMergeStacks(host._stacks.get(sourceId), host._stacks.get(targetId))) return null
  const targetPinned = !!host._stacks.get(targetId)?.pinned
  const result = host._tabStacks?.mergeStacks?.(host._ruleInput(), listStacks(host), { sourceStackId: sourceId, targetStackId: targetId })
  let count = result?.count
  if (result) applyStackRule(host, result)
  else {
    count = 0
    for (const tab of host._tabs.values()) {
      if (tab.stackId === sourceId) {
        tab.stackId = targetId
        tab.pinned = targetPinned
        if (targetPinned) enforcePinnedExclusivity(host, tab.tabId)
        count++
      }
    }
    host._stacks.delete(sourceId)
    enforcePinnedStackRuns(host)
  }
  host._scheduleEmitChanged()
  return { sourceStackId: sourceId, targetStackId: targetId, count }
}

/**
 * **解散一个标签组**：成员全部回到散标签，组元数据删掉（"全部恢复正常状态"）。
 *
 * 与 `splitStack` 是两件事、不能互相顶替（见 domain-tabs#TabStacks.dissolveStack）：
 *   · splitStack   —— 把**部分**成员迁到另一个新组（组还在，换了一部分人）；
 *   · dissolveStack—— **整组都没了**，每个成员回到散标签。
 * 菜单里曾经把 splitStack 当"拆分标签组"用，点下去只是整组换了个内部 id，外观一字不变 ——
 * 那正是"点了没反应"的来源。
 */
function dissolveStack(host: TabLayoutHost, { stackId }: TabLayoutOptions = {}) {
  const id = String(stackId)
  if (!host._stacks.has(id)) throw new Error(`Missing tab stack: ${id}`)
  const result = host._tabStacks?.dissolveStack?.(host._ruleInput(), listStacks(host), { stackId: id })
  if (result) {
    applyStackRule(host, result)
    host._scheduleEmitChanged()
    return { stackId: id, count: Array.isArray(result.children) ? result.children.length : 0, children: result.children || [] }
  }
  // 本地回退（未注入 domain 端口）：语义与 domain 逐字一致。
  const members = orderedIds(host).filter((tabId) => host._tabs.get(tabId)?.stackId === id)
  const wasPinned = !!host._stacks.get(id)?.pinned
  for (const tabId of members) {
    const rec = host._tabs.get(tabId)
    if (!rec) continue
    rec.stackId = null
    // 固定分组解散 = 成员退出固定（pinned ⟺ 属于 pinned 栈）
    if (wasPinned) rec.pinned = false
  }
  host._stacks.delete(id)
  removeEmptyStacks(host)
  host._scheduleEmitChanged()
  return { stackId: id, count: members.length, children: members }
}

/**
 * 拖拽重排：把 draggedId 移到 targetId 前/后，或拖入某个栈。
 * 优先委托 domain 的 reorderTabs；否则用 tabRules.reorderIds 算顺序后本地落位。
 */
function reorder(host: TabLayoutHost, { draggedId, targetId, insertAfter, targetStackId }: TabLayoutOptions = {}) {
  const result = host._tabStacks?.reorderTabs?.(host._ruleInput(), listStacks(host), { draggedId, targetId, insertAfter, targetStackId })
  if (result) {
    if (!result.ok) return { ok: false }
    applyStackRule(host, result)
    host._scheduleEmitChanged()
    return { ok: true }
  }

  const dragged = String(draggedId)
  const tab = host._tabs.get(dragged)
  if (!tab) return { ok: false }
  if (targetStackId != null) {
    const stackId = String(targetStackId)
    const targetStack = host._stacks.get(stackId)
    if (!targetStack) return { ok: false }
    // 种类裁决（真源 tab-policy）：固定标签只进固定文件夹，普通标签只进普通组。
    if (!canJoinStack(tab, targetStack)) return { ok: false }
    tab.stackId = stackId
    tab.pinned = !!targetStack.pinned
    if (tab.pinned) enforcePinnedExclusivity(host, dragged)
    enforcePinnedStackRuns(host)
    host._scheduleEmitChanged()
    return { ok: true }
  }
  if (!targetId) return { ok: false }
  const target = host._tabs.get(String(targetId))
  // 跨种类落点一律拒绝：固定段与非固定段之间没有合法的插入位置
  //（固定标签恒排最前；混排会破坏 pinned 段与「分屏成员相邻」两条不变式）。
  if (target && !canReorderAcross(tab, target)) return { ok: false }
  // 固定标签不能借「拖到别处」悄悄出栈 —— 那是取消固定，只能走 unpinTab。
  const leavingPinnedStack = !canLeaveStack(tab) && String(tab.stackId ?? '') !== String(target?.stackId ?? '')
  if (leavingPinnedStack) return { ok: false }
  const next = host._tabRules.reorderIds(orderedIds(host), { draggedId: dragged, targetId: String(targetId), insertAfter: !!insertAfter })
  if (!next.ok) return { ok: false }
  // 只按新次序改写 position，绝不重建 Map（对齐 RT `updateStateProperty("position", …)`）。
  for (let i = 0; i < next.ids.length; i++) {
    const rec = host._tabs.get(String(next.ids[i]))
    if (rec) rec.position = i
  }
  if (tab.stackId && (!target || target.stackId !== tab.stackId)) {
    const wasPinned = !!host._stacks.get(String(tab.stackId))?.pinned
    tab.stackId = null
    // 拖出固定分组 = 取消固定（否则会留下「pinned 但不在 pinned 栈」的孤儿）
    if (wasPinned) tab.pinned = false
    removeEmptyStacks(host)
  }
  // 本地回退路径同样要守不变式（不能只有 domain 那条路守）
  enforceSplitRuns(host)
  enforcePinnedStackRuns(host)
  host._scheduleEmitChanged()
  return { ok: true }
}

// ═══════════════════════════════════════════════════════════════════
//  分屏组（Split View）—— 与标签栈**同模**：规则在 domain，宿主只做读写与通知
//
//  宿主契约（TabManager 提供，与栈那一组并列）：
//    _tabs       Map<tabId, tabRecord>   唯一真源，归属写在 tab.splitId 上
//    _splits     Map<splitId, splitMeta> 组元数据（layout / ratios / members / activeTabId）
//    _tabSplits  注入的 domain 端口（@hira-ng/domain-tabs 的 tabSplits）—— 必填
//    _ruleInput() / _scheduleEmitChanged()
//
//  ⚠ 与栈一样**不做本地规则回退**：分屏规则只有一份（TabSplits.js）。缺端口就直接抛，
//    绝不悄悄降级成"点什么都没反应"。
// ═══════════════════════════════════════════════════════════════════

/** 组列表快照（脱壳，防调用方改坏内部 Map 里的对象）。 */
function listSplits(host: TabLayoutHost) {
  return Array.from(host._splits.values()).map((split: LayoutSplitRecord) => ({
    ...split,
    members: Array.isArray(split.members) ? split.members.slice() : [],
    ratios: Array.isArray(split.ratios) ? split.ratios.slice() : []
  }))
}

function requireSplitPort(host: TabLayoutHost) {
  if (!host._tabSplits || typeof host._tabSplits.createSplit !== 'function') {
    throw new Error('TabManager: tabSplits 端口未注入（分屏操作需要 @hira-ng/domain-tabs 的 tabSplits）')
  }
  return host._tabSplits
}

/**
 * 用户口径的分屏选项（现读；无端口时回落硬上限与 'row'）。
 *
 * ⚠ 夹取在**这一处**做：设置文件可手改，非法值必须回落；且用户口径
 * （2..4）永远不得超过硬上限 `SPLIT_METRICS.maxPanes` —— domain 那层仍按硬上限兜底，
 * 两层各管一件事（这里是"用户想怎样"，那里是"物理上最多几个"）。
 *
 * ⚠ 归一化只此一份：TabManager（格间链接路由）也读这个函数，不另写一份默认值。
 */
function splitOptionsOf(host: TabLayoutHost) {
  let raw = null
  try {
    raw = typeof host._getSplitOptions === 'function' ? host._getSplitOptions() : null
  } catch (_) {
    raw = null
  }
  const max = Number(raw && raw.maxPanes)
  return {
    maxPanes: Number.isFinite(max)
      ? Math.min(SPLIT_METRICS.maxPanes, Math.max(2, Math.floor(max)))
      : SPLIT_METRICS.maxPanes,
    defaultLayout: raw && raw.defaultLayout === 'column' ? 'column' : 'row',
    linkRouting: normalizeSplitLinkRouting(raw && raw.linkRouting)
  }
}

/**
 * 把 domain 的结果集**就地合并**回内部表（不重建 `_tabs`，保住 Map 身份）。
 *
 * 分屏不会改标签顺序，所以这里**只写 `splitId` 一个字段** —— 不像栈那一组要连 position 一起落。
 */
function applySplitRule(host: TabLayoutHost, result: LayoutMutationResult | null | undefined): void {
  if (!result) return
  if (Array.isArray(result.tabs)) {
    for (const incoming of result.tabs) {
      if (!incoming || incoming.tabId == null) continue
      const existing = host._tabs.get(String(incoming.tabId))
      if (existing) existing.splitId = incoming.splitId == null ? null : String(incoming.splitId)
    }
  }
  if (Array.isArray(result.splits)) {
    host._splits = new Map(result.splits.map((split: LayoutSplitRecord) => [String(split.splitId), split]))
  }
  // ⚠ 分屏**会**改标签顺序：成员必须相邻（Edge / Firefox 同款，中间不许夹别的标签）。
  //   建组时两人若不相邻（Alt+点击一个远处的标签），这里就地合拢 —— 于是"合拢"不需要
  //   调用方各自记得做一遍。
  enforceSplitRuns(host)
  // 分屏与速览互斥且**分屏胜**：进入分屏的成员从速览组里摘出来（见 detachSplitMembersFromGlances）。
  detachSplitMembersFromGlances(host)
}

/**
 * 强制「分屏成员在标签顺序里相邻」这条不变式。
 *
 * **唯一的强制点**：任何写标签顺序的地方末尾调它一次。规则本体是 domain 的纯函数
 * （`tabSplits.coalesceSplitRuns`），这里只负责把新顺序逐位写回 `position`。
 * 于是三种情况收敛到同一条规则，不会这里拦一下、那里漏一处：
 *   · 远隔的两个标签建组        → 在建组那一刻合拢；
 *   · 把散标签拖到两个成员中间   → 顺序写完就被挤出去；
 *   · 新标签落在两个成员之间     → 同上（见 TabManager 的插入点调用）。
 *
 * ── 与标签栈的关系：**正交共存，不再互斥**（2026-10-17 起）──────────────
 * 历史上这里先做「分屏胜栈」的裁决（`detachSplitMembersFromStacks`：入分屏即清 stackId），
 * 理由是"折叠栈会藏起分屏成员"。用户口径已改为**分屏标签可以加入标签栈**：
 *   · 归属字段本就正交（`tab.stackId` / `tab.splitId`，domain 设计如此，见 TabSplits.js 文件头）；
 *   · 相邻性算在**扁平顺序**上（coalesceSplitRuns），与投影是否把成员收进芯片无关 ——
 *     因此合拢不需要"先摘栈"这个前提；
 *   · 折叠栈藏起分屏成员时，连接带/回形针因取不到节点而**自然不画**（优雅降级），
 *     不产生错误视觉；展开即恢复。这是可接受的取舍，不再需要强制摘除。
 *
 * @returns {boolean} 是否真的改动了顺序（调用方据此决定要不要再通知一次）
 */
function enforceSplitRuns(host: TabLayoutHost) : boolean {
  if (!host._tabSplits || typeof host._tabSplits.coalesceSplitRuns !== 'function') return false
  const order = orderedIds(host)
  if (order.length === 0) return false
  const next = host._tabSplits.coalesceSplitRuns(order, listSplits(host))
  // 长度不一致说明端口返回了不该返回的东西 —— 宁可不写，也不要把标签弄丢
  if (!Array.isArray(next) || next.length !== order.length) return false
  let moved = false
  for (let i = 0; i < next.length; i++) {
    if (String(next[i]) !== String(order[i])) { moved = true; break }
  }
  if (!moved) return false
  for (let i = 0; i < next.length; i++) {
    const rec = host._tabs.get(String(next[i]))
    if (rec) rec.position = i
  }
  return true
}

/**
 * 强制「同一固定分组的成员在 pinned 段内相邻」这条不变式（对齐 enforceSplitRuns）。
 *
 * 固定分组 = `pinned: true` 的标签栈。标签条 / 垂直标签 / opentabs / 固定面板四处
 * 都把它渲染成一个可折叠的组行；组行与成员之间若夹着别的固定标签，视觉上会
 * 「一个组被劈成两半」。与分屏同款处理：任何改写顺序的入口末尾调一次，规则纯计算
 * 后逐位写回 `position`。
 *
 * 只动 pinned 段、只动有分组的成员：散固定标签保持各自的相对位置；
 * 组内成员聚到**首个成员**出现的位置，组与组之间的先后由首个成员决定。
 *
 * @returns {boolean} 是否真的改动了顺序
 */
function enforcePinnedStackRuns(host: TabLayoutHost) : boolean {
  const order = orderedIds(host)
  if (order.length < 2) return false
  let end = 0
  while (end < order.length && host._tabs.get(order[end])?.pinned) end++
  if (end < 2) return false
  const stackOf = (tabId: string) => {
    const rec = host._tabs.get(tabId)
    if (!rec || rec.stackId == null) return null
    const stack = host._stacks.get(String(rec.stackId))
    return stack && stack.pinned ? String(stack.stackId) : null
  }
  const buckets = new Map()
  for (let i = 0; i < end; i++) {
    const key = stackOf(order[i])
    if (!key) continue
    if (!buckets.has(key)) buckets.set(key, [])
    buckets.get(key).push(order[i])
  }
  if (!buckets.size) return false
  const emitted = new Set()
  const head = []
  for (let i = 0; i < end; i++) {
    const id = order[i]
    const key = stackOf(id)
    if (!key) { head.push(id); continue }
    if (emitted.has(key)) continue
    emitted.add(key)
    head.push(...buckets.get(key))
  }
  const next = head.concat(order.slice(end))
  let moved = false
  for (let i = 0; i < next.length; i++) {
    if (String(next[i]) !== String(order[i])) { moved = true; break }
  }
  if (!moved) return false
  for (let i = 0; i < next.length; i++) {
    const rec = host._tabs.get(String(next[i]))
    if (rec) rec.position = i
  }
  return true
}

/**
 * 固定标签的**独占性裁决**（唯一落点）：固定标签是常驻单体，不参与任何并列 / 叠放。
 *
 * 所有「让标签变成固定」的路径（建固定组、移入固定组、收编游离固定标签、拖进固定组）
 * 都必须末尾调它一次，于是分屏与速览的摘除只写在这里 —— 不再各入口各抄一遍
 * `if (pinned) removeTabFromSplit(...)`（正是那种散落写法导致漏摘速览）。
 *
 * 只对**固定标签**生效：普通标签进普通组不受影响（分屏 / 速览与普通组正交共存）。
 *
 * @returns {boolean} 是否真的摘掉了归属
 */
function enforcePinnedExclusivity(host: TabLayoutHost, tabId: string): boolean {
  const id = String(tabId)
  const rec = host._tabs.get(id)
  if (!rec || !rec.pinned) return false
  let changed = false
  if (rec.splitId != null) {
    removeTabFromSplit(host, id)
    changed = true
  }
  if (rec.glanceId != null) {
    removeTabFromGlance(host, id)
    changed = true
  }
  return changed
}

/** 固定分组的默认名字（新建第一个固定文件夹时使用）。 */
const DEFAULT_PINNED_LABEL = '固定标签'

/** 取一个固定分组：给定 stackId 时校验它确实是固定组；否则取第一个固定组。 */
function findPinnedStack(host: TabLayoutHost, { stackId }: TabLayoutOptions = {}) {
  if (stackId != null) {
    const stack = host._stacks.get(String(stackId))
    return stack && stack.pinned ? { ...stack } : null
  }
  for (const stack of host._stacks.values()) if (stack.pinned) return { ...stack }
  return null
}

/**
 * 取/建「固定标签」默认分组 —— 固定标签的**唯一落点**。
 *
 * 已有固定组就复用第一个（Zen 里 Essentials 也是一组常驻）；一个都没有就建默认
 * 「固定标签」文件夹。只保证「有地方可落」，不动任何标签记录。
 *
 * @returns {string} 可用于落位的 pinned 栈 id
 */
function pinnedGroupId(host: TabLayoutHost, { stackId }: TabLayoutOptions = {}) : string {
  const target = findPinnedStack(host, { stackId })
  if (target) return String(target.stackId)
  const created = { stackId: randomUUID(), label: DEFAULT_PINNED_LABEL, accent: '', collapsed: false, pinned: true }
  host._stacks.set(created.stackId, created)
  return created.stackId
}

/**
 * 新建标签的固定归属：`pinned: true` 的新标签**出生即入组**。
 *
 * 这是「每个固定标签都在一个固定文件夹里」这条不变式在**创建路径**上的落点：
 * 调用方（会话恢复 / 命名会话 / 撤销关闭 / 将来任何 `newTab({ pinned: true })`）
 * 不必知道分组细节，只要把 pinned 传进来，标签从第一条记录起就带着 stackId。
 * 因此投影里永远不会先冒出一根「裸露的固定标签」，再由兜底逻辑事后收编。
 *
 * @returns {string|null} stackId 有效且是固定组时原样返回
 */
function pinnedStackIdForNewTab(host: TabLayoutHost, { stackId }: TabLayoutOptions = {}) : string|null {
  return pinnedGroupId(host, { stackId })
}

/**
 * 把一个固定标签**直接**写进固定分组（不通知、不收拢顺序）。
 *
 * 收编游离标签 / 推送前兜底这类批量或热路径用它；单次用户操作仍走
 * `addTabToPinnedGroup`（那条会经 domain 端口并立即广播）。
 *
 * @returns {string|null} 落位后的 stackId
 */
function attachTabToPinnedGroup(host: TabLayoutHost, { tabId, stackId }: TabLayoutOptions = {}) : string|null {
  const id = String(tabId)
  const rec = host._tabs.get(id)
  if (!rec) return null
  const targetId = pinnedGroupId(host, { stackId })
  rec.stackId = targetId
  rec.pinned = true
  enforcePinnedExclusivity(host, id)
  return targetId
}

/**
 * 把一个标签放进固定分组（「固定」这个动作的唯一落点）。
 *
 *   stackId 有效且是固定组 → 进该组；
 *   未指定 / 无效           → 进第一个固定组；
 *   一个固定组都没有        → 新建默认「固定标签」组。
 *
 * 固定组不参与分屏（成员入组即退出分屏），与 TabManager.togglePin 同一条裁决。
 */
function addTabToPinnedGroup(host: TabLayoutHost, { tabId, stackId }: TabLayoutOptions = {}) {
  const id = String(tabId)
  const rec = host._tabs.get(id)
  if (!rec) throw new Error(`Missing tab: ${id}`)
  const target = findPinnedStack(host, { stackId })
  if (!target) {
    createStack(host, { tabIds: [id], label: DEFAULT_PINNED_LABEL, pinned: true })
    return { tabId: id, stackId: host._tabs.get(id)?.stackId ?? null, pinned: true, created: true }
  }
  // 「普通标签 → 固定文件夹」= **pin 动作**，必须走这条显式通道。
  // 不能借 `setTabStack`：那条是「同种类之间搬动」，跨种类必须拒绝（真源 tab-policy
  // 的 canJoinStack）—— 否则任何一次拖拽 / 菜单误调用都能静默改动 pin 状态。
  if (!rec.pinned) {
    rec.stackId = String(target.stackId)
    rec.pinned = true
    // 固定标签是常驻单体：入组即退出分屏 / 速览（与 togglePin 同一条裁决）。
    enforcePinnedExclusivity(host, id)
    removeEmptyStacks(host)
    enforcePinnedStackRuns(host)
    host._scheduleEmitChanged()
  } else {
    // 固定标签换文件夹 = 同种类搬动，走普通入栈即可。
    setTabStack(host, { tabId: id, stackId: target.stackId })
  }
  return { tabId: id, stackId: target.stackId, pinned: true, created: false }
}

/**
 * 收编「游离的固定标签」：`pinned: true` 却不属于任何固定分组的标签
 * （旧会话遗留：固定只是一个布尔位、没有分组概念）→ 并入默认固定组。
 *
 * 两个调用点：
 *   · 启动恢复后收尾一次（老数据迁移）；
 *   · `TabManager._emitTabChanged` 每次推送前（`notify: false`）兜底 ——
 *     将来任何新入口直接写 `pinned` 字段，投影也不会输出裸露的固定标签。
 *
 * @param {{ notify?: boolean }} [options] notify=false 时不自排一次广播（出口处调用）
 */
function adoptLoosePinnedTabs(host: TabLayoutHost, { notify = true }: TabLayoutOptions = {}) {
  const loose = []
  for (const [tabId, rec] of host._tabs) {
    if (!rec || !rec.pinned) continue
    const stack = rec.stackId == null ? null : host._stacks.get(String(rec.stackId))
    if (!stack || !stack.pinned) loose.push(tabId)
  }
  if (!loose.length) return { adopted: 0, stackId: null }
  const targetId = pinnedGroupId(host)
  for (const tabId of loose) attachTabToPinnedGroup(host, { tabId, stackId: targetId })
  enforcePinnedStackRuns(host)
  if (notify) host._scheduleEmitChanged()
  return { adopted: loose.length, stackId: targetId }
}

/** 建组：`tabIds` 至少 2 个、至多**用户口径**上限；不合法返回 null（由 IPC 层给出原因）。 */
function createSplitGroup(host: TabLayoutHost, opts: TabLayoutOptions = {}) {
  const port = requireSplitPort(host)
  const options = splitOptionsOf(host)
  // 形态：调用方没指定就用设置里的默认方向 —— 默认值只有一处（设置真源）。
  const layout = opts.layout || options.defaultLayout
  // 用户口径的上限在这里裁：多出来的标签直接不参与本次建组（而不是让 domain 拒绝整组，
  // 那会让"Alt+点击第 5 个标签"变成什么都没发生）。
  // **固定标签不参与分屏**：它永远排在标签条最前，与"分屏成员在扁平顺序里相邻"这条
  // 不变式互斥（见 TabManager.togglePin）。摘掉后不足 2 个，交给 domain 按原口径拒绝。
  const tabIds = (Array.isArray(opts.tabIds) ? opts.tabIds : [])
    .filter((id) => {
      const rec = host._tabs.get(String(id))
      return !rec || canSplit(rec)
    })
    .slice(0, options.maxPanes)
  const result = port.createSplit(host._ruleInput(), listSplits(host), {
    ...opts,
    tabIds,
    layout,
    nextSplitId: randomUUID()
  })
  if (!result) return null
  applySplitRule(host, result)
  host._scheduleEmitChanged()
  return { ...result.split, count: result.count, children: result.children }
}

/** 单标签入组 / 出组（splitId 传 null 即出组）。 */
function setTabSplit(host: TabLayoutHost, { tabId, splitId }: TabLayoutOptions = {}) {
  const port = requireSplitPort(host)
  // 用户口径的格数上限：入组前先看目标组满没满。
  // （domain 那层只认硬上限 4；用户设成 2 时这里必须拦住，否则设置项形同虚设。）
  if (splitId != null) {
    // 种类裁决（真源 tab-policy）：固定标签是常驻单体，不允许被拉进分屏。
    const rec = host._tabs.get(String(tabId))
    if (rec && !canSplit(rec)) return null
    const options = splitOptionsOf(host)
    const target = listSplits(host).find((split) => split.splitId === String(splitId))
    const id = String(tabId)
    if (target && !target.members.includes(id) && target.members.length >= options.maxPanes) return null
  }
  const result = port.moveTabToSplit(host._ruleInput(), listSplits(host), { tabId, splitId })
  if (!result) return null
  applySplitRule(host, result)
  host._scheduleEmitChanged()
  return { tabId: result.tabId, splitId: result.splitId }
}

/** 解散组（**成员全部保留**，只清归属）。 */
function dissolveSplit(host: TabLayoutHost, { splitId }: TabLayoutOptions = {}) {
  const port = requireSplitPort(host)
  const result = port.dissolveSplit(host._ruleInput(), listSplits(host), { splitId })
  if (!result) return null
  applySplitRule(host, result)
  host._scheduleEmitChanged()
  return { splitId: result.splitId, children: result.children }
}

function setSplitLayout(host: TabLayoutHost, { splitId, layout }: TabLayoutOptions = {}) {
  const port = requireSplitPort(host)
  const result = port.setSplitLayout(host._ruleInput(), listSplits(host), { splitId, layout })
  if (!result) return null
  applySplitRule(host, result)
  host._scheduleEmitChanged()
  return { splitId: result.splitId, layout: result.layout }
}

function setSplitRatios(host: TabLayoutHost, { splitId, ratios }: TabLayoutOptions = {}) {
  const port = requireSplitPort(host)
  const result = port.setSplitRatios(host._ruleInput(), listSplits(host), { splitId, ratios })
  if (!result) return null
  applySplitRule(host, result)
  host._scheduleEmitChanged()
  return { splitId: result.splitId, ratios: result.ratios }
}

function setSplitActive(host: TabLayoutHost, { splitId, tabId }: TabLayoutOptions = {}) {
  const port = requireSplitPort(host)
  const result = port.setSplitActive(host._ruleInput(), listSplits(host), { splitId, tabId })
  if (!result) return null
  applySplitRule(host, result)
  host._scheduleEmitChanged()
  return { splitId: result.splitId, tabId: result.tabId }
}

function reverseSplit(host: TabLayoutHost, { splitId }: TabLayoutOptions = {}) {
  const port = requireSplitPort(host)
  const result = port.reverseSplit(host._ruleInput(), listSplits(host), { splitId })
  if (!result) return null
  applySplitRule(host, result)
  host._scheduleEmitChanged()
  return { splitId: result.splitId, members: result.members }
}

/**
 * **拖动重排格子**：把某个成员移到指定下标（格的顺序 = 成员顺序）。
 *
 * 换算走 `moveMemberToIndex`（shared-types 的纯函数）：位置没变时它返回 null，
 * 于是"把这一格拖回原地"不会产生一次无意义的 tab:changed 与整屏重排 ——
 * 拖动是高频动作，每次松手都白排一次会让网页反复重排（用户看到的是"抖"）。
 *
 * 为什么不复用 `reverseSplit`：那是整体反转（两格时恰好等价，三格以上完全不同）。
 * 拖动落点要的是"插到第几格"，所以这里是 index 语义。
 */
function moveSplitMember(host: TabLayoutHost, { splitId, tabId, toIndex }: TabLayoutOptions = {}) {
  const port = requireSplitPort(host)
  const id = String(splitId)
  const split = id ? host._splits.get(id) : null
  if (!split || !Array.isArray(split.members)) return null
  const nextMembers = moveMemberToIndex(split.members, tabId, toIndex)
  if (!nextMembers) return { splitId: id, members: split.members.slice(), moved: false }
  // 只有 members 变、顺序不变 → 直接改内部表（不必绕 domain 的归一化）
  split.members = nextMembers
  host._scheduleEmitChanged()
  return { splitId: id, members: nextMembers.slice(), moved: true }
}

/**
 * 关闭标签时的分屏收尾（**热路径，且必须永不抛**）。
 *
 * 为什么放在 close 里而不是让 domain 的 prune 兜底：prune 只在"下一次组操作"时才跑，
 * 而关闭标签是**立刻**发生的 —— 不在这里摘掉，那个已销毁的 tabId 会留在 `members` 里，
 * 下一次布局会去 `getTab(已销毁)` 拿到 null 并让那一格变成**黑洞（空白）**。
 */
function removeTabFromSplit(host: TabLayoutHost, tabId: string): LayoutMutationResult | null {
  const id = String(tabId)
  const tab = host._tabs.get(id)
  if (!tab || tab.splitId == null) return null
  const splitId = String(tab.splitId)
  try {
    const port = requireSplitPort(host)
    const result = port.removeMember(host._ruleInput(), listSplits(host), { splitId, tabId: id })
    if (result) applySplitRule(host, result)
  } catch (error: unknown) {
    // 端口缺失 / 规则抛错都不能拖垮关闭链路：退化成"就地摘掉这一格 + 不足 2 格即解散"。
    console.warn('[tabs] removeTabFromSplit fell back to local:', error instanceof Error ? error.message : error)
    const kept = listSplits(host)
      .map((split) => (split.splitId === splitId
        ? { ...split, members: split.members.filter((member) => member !== id) }
        : split))
      .filter((split) => split.members.length >= 2)
    const keptIds = new Set(kept.map((split) => split.splitId))
    host._splits = new Map(kept.map((split) => [split.splitId, split]))
    for (const [, t] of host._tabs) {
      if (t.splitId != null && !keptIds.has(String(t.splitId))) t.splitId = null
    }
  }
  return { splitId, removed: id }
}

/** 对账式裁剪（启动恢复 / 目录变化后调用）。 */
function pruneSplits(host: TabLayoutHost) {
  const port = host._tabSplits
  if (!port || typeof port.pruneDegenerateSplits !== 'function') return null
  const result = port.pruneDegenerateSplits(host._ruleInput(), listSplits(host))
  if (!result) return null
  applySplitRule(host, result)
  return { count: listSplits(host).length }
}

// ═══════════════════════════════════════════════════════════════════
//  速览组（Glance，A1）—— 与标签栈 / 分屏**同模**：规则在 domain，宿主只做读写与通知
//
//  三条分组维度正交（栈收纳 / 分屏并列 / 速览叠放），各自一个字段：
//    tab.glanceId  : string | null      归属指针
//    _glances      : Map<glanceId, {glanceId, members:[back,front], frontTabId}>
//
//  ⚠ 与分屏一样**不做本地规则回退**：速览规则只有一份（TabGroups.js）。缺端口就直接抛。
// ═══════════════════════════════════════════════════════════════════

/** 组列表快照（脱壳，防调用方改坏内部 Map 里的对象）。 */
function listGlances(host: TabLayoutHost) {
  return Array.from(host._glances.values()).map((glance: LayoutGlanceRecord) => ({
    ...glance,
    members: Array.isArray(glance.members) ? glance.members.slice() : []
  }))
}

function requireGlancePort(host: TabLayoutHost) {
  if (!host._tabGroups || typeof host._tabGroups.createGlance !== 'function') {
    throw new Error('TabManager: tabGroups 端口未注入（速览操作需要 @hira-ng/domain-tabs 的 tabGroups）')
  }
  return host._tabGroups
}

/**
 * 把 domain 的结果集**就地合并**回内部表（不重建 `_tabs`，保住 Map 身份）。
 * 速览不改标签顺序、也不动分屏，所以只写 `glanceId` 一个字段。
 */
function applyGlanceRule(host: TabLayoutHost, result: LayoutMutationResult | null | undefined): void {
  if (!result) return
  if (Array.isArray(result.tabs)) {
    for (const incoming of result.tabs) {
      if (!incoming || incoming.tabId == null) continue
      const existing = host._tabs.get(String(incoming.tabId))
      if (existing) existing.glanceId = incoming.glanceId == null ? null : String(incoming.glanceId)
    }
  }
  if (Array.isArray(result.glances)) {
    host._glances = new Map(result.glances.map((glance: LayoutGlanceRecord) => [String(glance.glanceId), glance]))
  }
  // 速览成员必须真的可见 → 从标签栈里摘出来（冲突裁决与分屏同款：可见性胜）。
  detachGlanceMembersFromStacks(host)
}

/**
 * 把「速览成员」从标签栈里摘出来 —— 速览与栈**仍然互斥**（速览胜）：
 * 成员藏在折叠的标签栈里在投影里根本不出现，而速览要它可见。
 *（分屏与栈已改为正交共存 —— 见 enforceSplitRuns 的说明；速览维持旧裁决不变。）
 * @returns {boolean} 是否真的摘出了成员
 */
function detachGlanceMembersFromStacks(host: TabLayoutHost) : boolean {
  if (!host._glances || host._glances.size === 0) return false
  const members = new Set<string>()
  for (const glance of host._glances.values()) {
    for (const id of Array.isArray(glance.members) ? glance.members : []) members.add(String(id))
  }
  let changed = false
  for (const id of members) {
    const rec = host._tabs.get(id)
    if (!rec || rec.stackId == null) continue
    // 固定标签 pin 胜：固定文件夹是用户的常驻收藏，绝不能因为一张速览组而把成员摘散
    //（摘出去 = 成员变成游离固定标签，违反 pinned ⟺ 属于 pinned 栈）。
    if (!canLeaveStack(rec)) continue
    rec.stackId = null
    changed = true
  }
  if (changed) removeEmptyStacks(host)
  return changed
}

/**
 * 把「分屏成员」从速览组里摘出来 —— 分屏胜（成员要同时可见、平分内容区，
 * 与速览的"叠放"互斥）。在 `applySplitRule` 里调用，是两者冲突的**唯一裁决点**。
 * @returns {boolean} 是否真的摘出了成员
 */
function detachSplitMembersFromGlances(host: TabLayoutHost) : boolean {
  if (!host._glances || host._glances.size === 0) return false
  let changed = false
  for (const [, rec] of host._tabs) {
    if (rec.glanceId == null) continue
    if (rec.splitId == null) continue
    rec.glanceId = null
    changed = true
  }
  if (changed) {
    // 速览组可能因此不足两名成员 → 用 domain 对账式裁剪一次（清悬空指针）。
    try {
      const port = host._tabGroups
      if (port && typeof port.pruneDegenerateGlances === 'function') {
        const pruned = port.pruneDegenerateGlances(host._ruleInput(), listGlances(host))
        if (pruned && Array.isArray(pruned.glances)) {
          host._glances = new Map(pruned.glances.map((glance: LayoutGlanceRecord) => [String(glance.glanceId), glance]))
        }
      }
    } catch (_) { /* 裁剪失败不阻断分屏主流程 */ }
  }
  return changed
}

/**
 * 建组：恰好两个不同且存在的标签；不合法返回 null（由 IPC 层给出原因）。
 *
 * ⚠ 成员若**已在某个分屏组里** → 直接拒绝（返回 null）。冲突裁决是**分屏胜**
 *（见 detachSplitMembersFromGlances），此刻若硬建速览，同一张标签会同时被两套布局
 * 抢着摆 —— 结果是"叠放"与"并排"逐帧互相覆盖。UI 侧本就只在非分屏标签上出现该项
 *（见 tabContextMenu 的 canGlanceWith），这条只是给 IPC 直连路径兜底。
 */
function createGlanceGroup(host: TabLayoutHost, opts: TabLayoutOptions = {}) {
  const port = requireGlancePort(host)
  const wanted = (Array.isArray(opts.tabIds) ? opts.tabIds : []).map(String)
  for (const tabId of wanted) {
    const rec = host._tabs.get(tabId)
    // 种类裁决（真源 tab-policy）：固定标签不参与速览叠放。
    if (rec && !canGlance(rec)) return null
    if (rec && rec.splitId != null) return null
  }
  const result = port.createGlance(host._ruleInput(), listGlances(host), {
    ...opts,
    nextGlanceId: randomUUID()
  })
  if (!result) return null
  applyGlanceRule(host, result)
  host._scheduleEmitChanged()
  return { ...result.glance, count: result.count, children: result.children }
}

/** 交换前后（把某成员提为 front）。 */
function setGlanceFront(host: TabLayoutHost, { glanceId, tabId }: TabLayoutOptions = {}) {
  const port = requireGlancePort(host)
  const result = port.setGlanceFront(host._ruleInput(), listGlances(host), { glanceId, tabId })
  if (!result) return null
  applyGlanceRule(host, result)
  host._scheduleEmitChanged()
  return { glanceId: result.glanceId, tabId: result.tabId }
}

/** 解散组（**两张标签都保留**，只清归属）。 */
function dissolveGlance(host: TabLayoutHost, { glanceId }: TabLayoutOptions = {}) {
  const port = requireGlancePort(host)
  const result = port.dissolveGlance(host._ruleInput(), listGlances(host), { glanceId })
  if (!result) return null
  applyGlanceRule(host, result)
  host._scheduleEmitChanged()
  return { glanceId: result.glanceId, children: result.children }
}

/**
 * 关闭标签时的速览收尾（**热路径，且必须永不抛**）。
 * 与分屏同款理由：不在关闭那一刻摘掉，那个已销毁的 tabId 会留在 `members` 里，
 * 下一次布局会去 `getTab(已销毁)` 拿到 null 并让那一张变成黑洞（空白）。
 */
function removeTabFromGlance(host: TabLayoutHost, tabId: string): LayoutMutationResult | null {
  const id = String(tabId)
  const tab = host._tabs.get(id)
  if (!tab || tab.glanceId == null) return null
  const glanceId = String(tab.glanceId)
  try {
    const port = requireGlancePort(host)
    const result = port.removeTabFromGlance(host._ruleInput(), listGlances(host), { glanceId, tabId: id })
    if (result) applyGlanceRule(host, result)
  } catch (error: unknown) {
    console.warn('[tabs] removeTabFromGlance fell back to local:', error instanceof Error ? error.message : error)
    host._glances.delete(glanceId)
    for (const [, t] of host._tabs) {
      if (t.glanceId != null && String(t.glanceId) === glanceId) t.glanceId = null
    }
  }
  return { glanceId, removed: id }
}

export {
  listStacks,
  listProjection,
  listProjectionOf,
  getAllStacks,
  getStack,
  getStackOfTab,
  isTabInAnyStack,
  applyStackRule,
  removeEmptyStacks,
  createStack,
  setTabStack,
  // 取消固定（固定标签出固定文件夹的唯一出口，与「普通出栈」语义分离）
  unpinTab,
  toggleStack,
  renameStack,
  setStackColor,
  updateStack,
  mergeStacks,
  // 解散标签组（成员全部回到散标签）—— 取代了原先菜单上那个语义错位的「拆分标签组」
  //（domain 的 splitStack 仍在，但当前没有 UI 入口，所以这里不再包一层）。
  dissolveStack,
  reorder,
  // ── 固定分组（pinned 栈 = Zen Essentials 语义；pinned ⟺ 属于 pinned 栈）──
  enforcePinnedStackRuns,
  // 固定标签独占性裁决（分屏 / 速览摘除的唯一落点）
  enforcePinnedExclusivity,
  findPinnedStack,
  pinnedGroupId,
  pinnedStackIdForNewTab,
  attachTabToPinnedGroup,
  addTabToPinnedGroup,
  adoptLoosePinnedTabs,
  DEFAULT_PINNED_LABEL,
  // ── 分屏组（与标签栈同模：宿主注入 _splits / _tabSplits，规则全在 domain-tabs#TabSplits）──
  listSplits,
  applySplitRule,
  enforceSplitRuns,
  splitOptionsOf,
  createSplitGroup,
  setTabSplit,
  dissolveSplit,
  setSplitLayout,
  setSplitRatios,
  setSplitActive,
  reverseSplit,
  // 拖动重排格子（工具条的拖拽手柄）：把某个成员移到指定下标
  moveSplitMember,
  removeTabFromSplit,
  pruneSplits,
  // ── 速览组（Glance，A1；与栈 / 分屏同模：宿主注入 _glances / _tabGroups，规则在 domain-tabs#TabGroups）──
  listGlances,
  applyGlanceRule,
  createGlanceGroup,
  setGlanceFront,
  dissolveGlance,
  removeTabFromGlance
}
