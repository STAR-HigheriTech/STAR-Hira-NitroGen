const {
  stackPolicy,
  canJoinStack,
  canMergeStacks,
  canReorderAcross,
  canLeaveStack
} = require('@hira-ng/shared-types/src/tab-policy.mjs')
import {
  asRecord,
  tabRecords,
  type StackMutationResult,
  type StackRecord,
  type StackView,
  type TabRecord
} from './types'

function normalizeStack(value: unknown): StackRecord | null {
  const stack = asRecord(value)
  if (!stack || stack.stackId == null) return null
  return {
    stackId: String(stack.stackId),
    label: typeof stack.label === 'string' ? stack.label : '',
    accent: typeof stack.accent === 'string' ? stack.accent : '',
    collapsed: !!stack.collapsed,
    // pinned 栈 = 固定分组（Zen Essentials 语义）。必须透传：归一化若丢掉它，
    // 任何一次 domain 规则回写都会把「固定分组」悄悄降级成普通组。
    pinned: !!stack.pinned
  }
}

function normalizeStacks(stackList: unknown): StackRecord[] {
  return (Array.isArray(stackList) ? stackList : [])
    .map(normalizeStack)
    .filter((stack): stack is StackRecord => stack !== null)
}

function stackIndex(stackList: unknown, stackId: unknown): number {
  return normalizeStacks(stackList).findIndex((stack) => stack.stackId === String(stackId))
}

function stackMembers(tabList: unknown, stackId: unknown): TabRecord[] {
  const id = String(stackId)
  return tabRecords(tabList).filter((tab) => String(tab.stackId) === id)
}

/**
 * 回收空栈 —— 唯独**固定文件夹**（pinned 栈）保留。
 *
 * 为什么固定文件夹允许为空：它承载的是"用户预先建好的收藏夹"，天然存在
 * 「先建文件夹、后往里放标签」的时序；普通标签组则是"选中若干标签聚合而成"，
 * 成员清零即无意义。两者语义不同，因此在同一处裁决里分开处理。
 */
function pruneEmptyStacks(tabList: unknown, stackList: unknown): StackRecord[] {
  const used = new Set(tabRecords(tabList)
    .filter((tab) => tab.stackId != null)
    .map((tab) => String(tab.stackId)))
  // 是否允许空栈由种类能力裁决（固定文件夹允许，普通组不允许）—— 唯一真源在 tab-policy。
  return normalizeStacks(stackList).filter((stack) => used.has(stack.stackId) || stackPolicy(stack).allowsEmpty)
}

/** 取单个栈（脱壳快照，附带成员与数量）—— 所有"读一个栈"的入口共用。 */
function getStack(tabList: unknown, stackList: unknown, { stackId }: { stackId?: unknown } = {}): StackView | null {
  if (stackId == null) return null
  const stack = normalizeStacks(stackList).find((item) => item.stackId === String(stackId))
  if (!stack) return null
  const children = stackMembers(tabList, stack.stackId).map((tab) => String(tab.tabId))
  return { ...stack, count: children.length, children }
}

/** 某标签所属的栈（不在栈里 / 栈已失效 → null）。 */
function getStackOfTab(tabList: unknown, stackList: unknown, { tabId }: { tabId?: unknown } = {}): StackView | null {
  const tab = tabRecords(tabList).find((item) => String(item.tabId) === String(tabId))
  if (!tab || tab.stackId == null) return null
  return getStack(tabList, stackList, { stackId: tab.stackId })
}

/** 全部栈（每项带 count/children）—— 供调用方一次性拿全量，避免 N 次 getStack。 */
function getAllStacks(tabList: unknown, stackList: unknown): StackView[] {
  return normalizeStacks(stackList)
    .map((stack) => getStack(tabList, [stack], { stackId: stack.stackId }))
    .filter((stack): stack is StackView => stack !== null)
}

/**
 * 标签是否归属任一**现存**栈。
 * 只认 `tab.stackId` 且该栈仍在表里 —— 悬空指针不算（与投影口径一致）。
 */
function isTabInAnyStack(tabList: unknown, stackList: unknown, { tabId }: { tabId?: unknown } = {}): boolean {
  return getStackOfTab(tabList, stackList, { tabId }) != null
}

/**
 * 通用字段更新（白名单：label / accent / collapsed）。
 *
 * 为什么保留单字段 setter 的同时还要这一个：调用方常常一次改多项（重命名 + 换色），
 * 走两次 IPC 会触发两次渲染；统一 patch 入口让"一次操作 = 一次通知"。
 * 未知字段一律忽略 —— 绝不允许调用方把 `tabId` / 内部字段写进栈元数据。
 */
function updateStack(
  stackList: unknown,
  { stackId, patch }: { stackId?: unknown; patch?: unknown } = {}
): { stackId: string; stack: StackRecord; stacks: StackRecord[]; changed: string[] } | null {
  const stacks = normalizeStacks(stackList)
  const index = stackIndex(stacks, stackId)
  if (index < 0) return null
  const source = asRecord(patch) || {}
  const next = { ...stacks[index] }
  const changed: string[] = []
  if (typeof source.label === 'string') {
    next.label = source.label.trim()
    changed.push('label')
  }
  if (typeof source.accent === 'string') {
    next.accent = source.accent.trim()
    changed.push('accent')
  }
  if (typeof source.collapsed === 'boolean') {
    next.collapsed = source.collapsed
    changed.push('collapsed')
  }
  stacks[index] = next
  return { stackId: next.stackId, stack: { ...next }, stacks, changed }
}

/**
 * **解散一个标签组**：成员全部保留，只把归属清掉、组元数据删掉（"全部恢复正常状态"）。
 *
 * 为什么必须与 `splitStack` 分开（两者看着像、结果完全不同）：
 *   · `splitStack` 把**部分**成员迁到**另一个新组**（组还在，只是换了一部分人）；
 *   · `dissolveStack` 是**整组都没了** —— 每个成员回到散标签，组本身不复存在。
 * 用户要的"解散"是后者；菜单上曾经把前者当成"拆分标签组"，点下去只是整组换了个内部 id，
 * 外观一字不变 —— 那正是"点了没反应"的来源。两个语义因此各留一个纯函数，不再混用。
 *
 * 与 `TabSplits.dissolveSplit` 同形（那边解散的是分屏组）：同样返回
 * `{ tabId 不清、tabs 全量、stacks 过滤后、children 成员 id }` ——
 * **tabs 必须是全量**，因为宿主的 `applyStackRule` 按"结果集里没出现 = 该标签没了"来同步。
 *
 * @param {Array<object>} tabList
 * @param {Array<object>} stackList
 * @param {{ stackId?: string }} [options]
 * @returns {{ stackId: string, tabs: Array<object>, stacks: Array<object>, children: string[] }|null}
 *   组不存在时返回 null（调用方给出"这一组已经没了"）。
 */
function dissolveStack(
  tabList: unknown,
  stackList: unknown,
  { stackId }: { stackId?: unknown } = {}
): (StackMutationResult & { stackId: string; children: string[] }) | null {
  const targetId = String(stackId)
  const tabs = Array.isArray(tabList) ? tabList as TabRecord[] : []
  const stacks = normalizeStacks(stackList)
  if (stackIndex(stacks, targetId) < 0) return null
  const memberIds = stackMembers(tabs, targetId).map((tab) => String(tab.tabId))
  // 固定分组解散 = 成员退出固定（不变式：pinned ⟺ 属于 pinned 栈）。
  const dissolving = stacks[stackIndex(stacks, targetId)]
  const wasPinned = !!dissolving.pinned
  const nextTabs = tabs.map((tab) =>
    tab && tab.stackId != null && String(tab.stackId) === targetId
      ? { ...tab, stackId: null, pinned: wasPinned ? false : !!tab.pinned }
      : tab
  )
  return {
    stackId: targetId,
    tabs: nextTabs,
    // 先摘掉目标组本身，再顺带回收**其它**空栈（成员被别处搬走时留下的空壳）
    stacks: pruneEmptyStacks(nextTabs, stacks.filter((stack) => stack.stackId !== targetId)),
    children: memberIds
  }
}

function renameStack(
  stackList: unknown,
  { stackId, label }: { stackId?: unknown; label?: unknown } = {}
): { stackId: string; label: string; stacks: StackRecord[] } | null {
  const stacks = normalizeStacks(stackList)
  const index = stackIndex(stacks, stackId)
  if (index < 0) return null
  const stack = { ...stacks[index], label: typeof label === 'string' ? label.trim() : '' }
  stacks[index] = stack
  return { stackId: stack.stackId, label: stack.label, stacks }
}

function setStackColor(
  stackList: unknown,
  { stackId, accent }: { stackId?: unknown; accent?: unknown } = {}
): { stackId: string; accent: string; stacks: StackRecord[] } | null {
  const stacks = normalizeStacks(stackList)
  const index = stackIndex(stacks, stackId)
  if (index < 0) return null
  const stack = { ...stacks[index], accent: typeof accent === 'string' ? accent.trim() : '' }
  stacks[index] = stack
  return { stackId: stack.stackId, accent: stack.accent, stacks }
}

function mergeStacks(
  tabList: unknown,
  stackList: unknown,
  { sourceStackId, targetStackId }: { sourceStackId?: unknown; targetStackId?: unknown } = {}
): (StackMutationResult & { sourceStackId: string; targetStackId: string; count: number }) | null {
  const sourceId = String(sourceStackId)
  const targetId = String(targetStackId)
  const stacks = normalizeStacks(stackList)
  if (sourceId === targetId || stackIndex(stacks, sourceId) < 0 || stackIndex(stacks, targetId) < 0) return null
  // 固定文件夹与普通标签组是**两种种类**，不能互相吞并 ——
  // 静默合并会把整组成员一次性改成对方的固定状态（等于悄悄固定/取消固定一批标签）。
  if (!canMergeStacks(stacks[stackIndex(stacks, sourceId)], stacks[stackIndex(stacks, targetId)])) return null
  // 成员并入后归属目标组 → pinned 必须跟随目标组（固定组与非固定组互斥）。
  const targetPinned = !!stacks[stackIndex(stacks, targetId)].pinned
  let count = 0
  const tabs = (Array.isArray(tabList) ? tabList as TabRecord[] : []).map((tab) => {
    if (!tab || String(tab.stackId) !== sourceId) return tab
    count++
    return { ...tab, stackId: targetId, pinned: targetPinned }
  })
  return { sourceStackId: sourceId, targetStackId: targetId, count, tabs, stacks: stacks.filter((stack) => stack.stackId !== sourceId) }
}

function splitStack(
  tabList: unknown,
  stackList: unknown,
  {
    stackId,
    tabIds,
    label,
    accent,
    collapsed,
    pinned,
    nextStackId
  }: {
    stackId?: unknown
    tabIds?: unknown
    label?: unknown
    accent?: unknown
    collapsed?: unknown
    pinned?: unknown
    nextStackId?: unknown
  } = {}
): ({ tabs: TabRecord[]; stacks: StackRecord[] } & StackView) | null {
  const sourceId = String(stackId)
  const stacks = normalizeStacks(stackList)
  const sourceIndex = stackIndex(stacks, sourceId)
  const nextId = nextStackId == null ? '' : String(nextStackId)
  if (sourceIndex < 0 || !nextId || stackIndex(stacks, nextId) >= 0) return null
  const selected = new Set(Array.isArray(tabIds) ? tabIds.map(String) : [])
  const members = stackMembers(tabList, sourceId).filter((tab) => selected.has(String(tab.tabId)))
  if (members.length === 0) return null
  const source = stacks[sourceIndex]
  const stack = {
    stackId: nextId,
    label: typeof label === 'string' ? label.trim() : source.label,
    accent: typeof accent === 'string' ? accent.trim() : source.accent,
    collapsed: typeof collapsed === 'boolean' ? collapsed : source.collapsed,
    // 新组继承来源组的固定属性（从一个固定文件夹拆出来的仍是固定文件夹）。
    pinned: typeof pinned === 'boolean' ? pinned : !!source.pinned
  }
  const tabs = (Array.isArray(tabList) ? tabList as TabRecord[] : []).map((tab) => selected.has(String(tab.tabId)) && String(tab.stackId) === sourceId ? { ...tab, stackId: nextId, pinned: stack.pinned } : tab)
  return { ...stack, count: members.length, children: members.map((tab) => String(tab.tabId)), tabs, stacks: pruneEmptyStacks(tabs, [...stacks, stack]) }
}

function moveTabToStack(
  tabList: unknown,
  stackList: unknown,
  { tabId, stackId }: { tabId?: unknown; stackId?: unknown } = {}
): (StackMutationResult & { tabId: string; stackId: string | null }) | null {
  const id = String(tabId)
  const targetId = stackId == null ? null : String(stackId)
  const tabs = Array.isArray(tabList) ? tabList as TabRecord[] : []
  const tab = tabs.find((item) => String(item.tabId) === id)
  const stacks = normalizeStacks(stackList)
  if (!tab || (targetId && stackIndex(stacks, targetId) < 0)) return null
  // 种类兼容裁决（唯一真源 tab-policy）：
  //   · 固定标签 ↔ 普通组 / 普通标签 ↔ 固定组 一律拒绝 —— 否则会静默固定或取消固定；
  //   · 固定标签「出栈」= 取消固定，属于 pin 动作，不走这条普通出栈路径。
  if (!canJoinStack(tab, targetId ? stacks[stackIndex(stacks, targetId)] : null)) return null
  const targetPinned = targetId ? !!stacks[stackIndex(stacks, targetId)].pinned : false
  const nextTabs = tabs.map((item) => item && String(item.tabId) === id ? { ...item, stackId: targetId, pinned: targetPinned } : item)
  return { tabId: id, stackId: targetId, tabs: nextTabs, stacks: pruneEmptyStacks(nextTabs, stacks) }
}

/**
 * **取消固定**：固定标签离开固定文件夹（= 变成散标签）。
 *
 * 为什么不复用 `moveTabToStack(tabId, null)`：普通「出栈」对固定标签必须拒绝，
 * 否则拖拽、菜单里任何一次误调用都会静默取消用户固定；取消固定是 pin 动作的另一半，
 * 语义独立，因此单开一个纯函数。宿主只有 `unpinTab` 一个入口调它。
 *
 * 结果形状与其它写规则一致（`tabs` 全量 + `stacks` 过滤后），宿主 applyStackRule 直接吃。
 *
 * @returns {{ tabId: string, stackId: null, tabs: Array<object>, stacks: Array<object> }|null}
 */
function unpinTab(
  tabList: unknown,
  stackList: unknown,
  { tabId }: { tabId?: unknown } = {}
): (StackMutationResult & { tabId: string; stackId: null }) | null {
  const id = String(tabId)
  const tabs = Array.isArray(tabList) ? tabList as TabRecord[] : []
  const tab = tabs.find((item) => String(item.tabId) === id)
  if (!tab) return null
  // 本来就没固定、也不在组里 → 幂等返回（调用方不必先判断）
  if (!tab.pinned && tab.stackId == null) return { tabId: id, stackId: null, tabs, stacks: pruneEmptyStacks(tabs, stackList) }
  const nextTabs = tabs.map((item) =>
    item && String(item.tabId) === id ? { ...item, stackId: null, pinned: false } : item
  )
  return { tabId: id, stackId: null, tabs: nextTabs, stacks: pruneEmptyStacks(nextTabs, stackList) }
}

function reorderTabs(
  tabList: unknown,
  stackList: unknown,
  {
    draggedId,
    targetId,
    insertAfter,
    targetStackId
  }: {
    draggedId?: unknown
    targetId?: unknown
    insertAfter?: unknown
    targetStackId?: unknown
  } = {}
): { ok: true; tabs: TabRecord[]; stacks: StackRecord[] } | { ok: false } {
  const dragged = String(draggedId)
  const tabs = Array.isArray(tabList) ? tabList as TabRecord[] : []
  const draggedTab = tabs.find((tab) => String(tab.tabId) === dragged)
  if (!draggedTab) return { ok: false }
  if (targetStackId != null) {
    const targetStack = normalizeStacks(stackList).find((stack) => stack.stackId === String(targetStackId))
    if (!targetStack || !canJoinStack(draggedTab, targetStack)) return { ok: false }
    const moved = moveTabToStack(tabs, stackList, { tabId: dragged, stackId: targetStackId })
    return moved ? { ok: true, tabs: moved.tabs, stacks: moved.stacks } : { ok: false }
  }
  if (!targetId) return { ok: false }
  const target = tabs.find((tab) => tab && String(tab.tabId) === String(targetId))
  if (!target) return { ok: false }
  // 种类兼容裁决（唯一真源 tab-policy）：
  //   · 跨种类混排一律否决 —— 固定标签永远在 pinned 段内，穿插即破坏排序不变式；
  //   · 固定标签不能借「拖到别的组外」离开固定文件夹（那等于取消固定，须走显式 unpin）。
  if (!canReorderAcross(draggedTab, target)) return { ok: false }
  const leavingPinnedStack = !canLeaveStack(draggedTab) && String(target.stackId ?? '') !== String(draggedTab.stackId ?? '')
  if (leavingPinnedStack) return { ok: false }
  const ids = tabs.map((tab) => String(tab.tabId))
  const draggedIndex = ids.indexOf(dragged)
  const targetIndex = ids.indexOf(String(targetId))
  if (draggedIndex < 0 || targetIndex < 0 || dragged === String(targetId)) return { ok: false }
  const orderedIds = ids.filter((id) => id !== dragged)
  orderedIds.splice(orderedIds.indexOf(String(targetId)) + (insertAfter ? 1 : 0), 0, dragged)
  const byId = new Map(tabs.map((tab) => [String(tab.tabId), tab]))
  const reordered = orderedIds
    .map((id) => byId.get(id))
    .filter((tab): tab is TabRecord => tab !== undefined)
  const leaving = draggedTab.stackId != null && (!target || String(target.stackId) !== String(draggedTab.stackId))
  // 拖出固定分组 = 取消固定（否则会留下「pinned 但不在 pinned 栈」的孤儿）。
  const sourceStack = draggedTab.stackId == null ? null : normalizeStacks(stackList).find((stack) => stack.stackId === String(draggedTab.stackId))
  const nextTabs = leaving
    ? reordered.map((tab) => String(tab.tabId) === dragged ? { ...tab, stackId: null, pinned: sourceStack && sourceStack.pinned ? false : !!tab.pinned } : tab)
    : reordered
  return { ok: true, tabs: nextTabs, stacks: pruneEmptyStacks(nextTabs, stackList) }
}

function projectTabStacks(tabList: unknown, stackList: unknown): Array<StackView | TabRecord> {
  const tabs = tabRecords(tabList)
  const stacks = normalizeStacks(stackList)
  const stackById = new Map<string, StackRecord>()
  const membersByStackId = new Map<string, TabRecord[]>()
  for (const stack of stacks) stackById.set(stack.stackId, stack)
  for (const tab of tabs) {
    if (tab.stackId == null) continue
    const stackId = String(tab.stackId)
    if (!stackById.has(stackId)) continue
    const members = membersByStackId.get(stackId) || []
    members.push(tab)
    membersByStackId.set(stackId, members)
  }

  // 空的固定文件夹没有成员，投影主循环的"首次出现即出组"永远不会触发它 ——
  // 必须在固定段收尾处（第一个非固定标签之前；全是固定标签则在末尾）补发，
  // 否则「新建文件夹」这个动作在建完的一瞬间就等于消失了。
  const emptyPinned = stacks.filter((stack) => stack.pinned && !membersByStackId.has(stack.stackId))

  const emitted = new Set<string>()
  const projection: Array<StackView | TabRecord> = []
  let emptyFlushed = false
  const flushEmptyPinned = () => {
    if (emptyFlushed) return
    emptyFlushed = true
    for (const stack of emptyPinned) {
      if (emitted.has(stack.stackId)) continue
      emitted.add(stack.stackId)
      projection.push({ ...stack, type: 'stack', count: 0, children: [] })
    }
  }
  for (const tab of tabs) {
    if (!tab.pinned) flushEmptyPinned()
    const stackId = tab.stackId == null ? null : String(tab.stackId)
    if (!stackId) {
      projection.push(tab)
      continue
    }
    const stack = stackById.get(stackId)
    if (!stack) {
      projection.push(tab)
      continue
    }
    if (emitted.has(stackId)) continue
    emitted.add(stackId)
    const children = membersByStackId.get(stackId) || []
    projection.push({ ...stack, type: 'stack', count: children.length, children: children.map((child) => String(child.tabId)) })
    if (!stack.collapsed) {
      projection.push(...children)
      continue
    }
    // 折叠只是让**其它**成员不占位，当前活动的那一个必须留下。
    //
    // 为什么不能整组藏掉：投影是渲染层唯一的真相源 —— 标签条靠它画活动态，
    // 地址栏靠 `list.find(t => t.active)` 拿当前页。活动标签藏进折叠组之后，
    // 那个 find 直接返回 null，表现就是「标签只是被收起来了，地址栏却空白了」。
    // 页面本身还在显示（视图归 LayoutCoordinator 管，不随折叠隐藏），
    // 因此留下活动成员既让地址栏有内容，也让用户看得见自己正在看的是哪一条。
    const activeMember = children.find((child) => child.active)
    if (activeMember) projection.push(activeMember)
  }
  flushEmptyPinned()
  return projection
}

export { normalizeStack, projectTabStacks, getStack, getStackOfTab, getAllStacks, isTabInAnyStack, updateStack, renameStack, setStackColor, mergeStacks, splitStack, dissolveStack, moveTabToStack, unpinTab, reorderTabs, pruneEmptyStacks }
