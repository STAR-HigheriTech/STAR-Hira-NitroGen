/**
 * tab-policy.mjs —— 标签「种类」能力的**唯一裁决中心**（跨进程纯函数）
 *
 * ── 为什么必须是一份（而不是各层各写一个 `!tab.pinned`）────────────
 * 固定标签（pinned）是唯一**特殊种类**：它常驻在最前、住在固定文件夹里（pinned 栈），
 * 因此不能分屏、不能速览、不能归档、不能按域名分组、不能被「关闭其他 / 右侧」带走，
 * 也不能和普通标签混排或堆进同一个组。
 *
 * 这些规则原先散落在三层十几个函数里：domain（TabStacks / TabSplits / TabGroups）、
 * infra（tabLayout）、ui（右键菜单 / 拖拽 / 按域名分组）各写一份判断 —— 漂移的表现
 * 就是「菜单里能点，点下去要么没反应，要么把别的标签悄悄固定了」。
 *
 * 本文件把它们收口成**一张能力表 + 一组纯判据**。新增一种特殊种类（例如将来的
 * 「临时标签」）只需要在 TAB_POLICY 里加一行，三层自动一致，不必再逐处补判断。
 *
 * 纯函数：零依赖、零 IO、不碰 DOM、不 require electron。主进程（CJS require）与
 * 渲染层（ESM import）读同一份文件（`.mjs`；Electron 43 / Node 24 可直接 require ESM，
 * 与 `split-layout.mjs` / `glance-layout.mjs` 同款约定）。
 */

/** 标签 / 标签栈的种类。普通是缺省，固定是唯一特殊种类。 */
const TAB_KIND = Object.freeze({
  PINNED: 'pinned',
  NORMAL: 'normal'
})

/**
 * 标签能力表 —— **唯一真源**。三层（domain / infra / ui）只读它，不再各自判断 `pinned`。
 *
 *   split            能否参与分屏（与别的标签并排）
 *   glance           能否参与速览（与别的标签叠放）
 *   duplicate        能否复制成新标签（固定标签的「复制」只会得到一个普通标签，
 *                    既不在固定文件夹里、又与原件不是同一种类 —— 语义上是新的散标签，
 *                    用户真正想干的事是「再开一个」或「在文件夹里再来一条」，都不是复制）
 *   archive          能否归档
 *   groupByDomain    能否作为「按域名分组」的起点或成员
 *   closeWithOthers  能否参与「关闭其他标签 / 关闭右侧标签」这一族动作：
 *                    **两个方向**都算 —— 既不会被它们带走（TabRules 里过滤掉），
 *                    也不作为它们的发起者（右键菜单里不出现）。
 *                    固定标签常驻最前，"右侧"= 全部普通标签，从这个位置一键清空
 *                    整个空间不是它该提供的入口。
 *   stackTogether    能否与别的标签堆叠成标签组（跨种类另由 canStackTogether 否决）
 *   crossKind        能否与**另一种类**的标签发生交互（排序 / 混组 / 分屏 / 速览…）
 *   leaveStack       能否离开当前标签组（对固定标签而言「离开」= 取消固定，
 *                    属于 pin 动作，必须走显式 unpin，不能当作普通出栈）
 */
const TAB_POLICY = Object.freeze({
  [TAB_KIND.PINNED]: Object.freeze({
    kind: TAB_KIND.PINNED,
    split: false,
    glance: false,
    duplicate: false,
    archive: false,
    groupByDomain: false,
    closeWithOthers: false,
    // 固定标签之间可以堆成「固定文件夹」；跨种类由 canStackTogether 拦。
    stackTogether: true,
    crossKind: false,
    leaveStack: false
  }),
  [TAB_KIND.NORMAL]: Object.freeze({
    kind: TAB_KIND.NORMAL,
    split: true,
    glance: true,
    duplicate: true,
    archive: true,
    groupByDomain: true,
    closeWithOthers: true,
    stackTogether: true,
    crossKind: false,
    leaveStack: true
  })
})

/**
 * 标签栈能力表：**固定文件夹允许为空**（先建夹、后放标签），普通组空即回收。
 * 收口 `pruneEmptyStacks` / `removeEmptyStacks` 里那句 `|| stack.pinned`。
 */
const STACK_POLICY = Object.freeze({
  [TAB_KIND.PINNED]: Object.freeze({ kind: TAB_KIND.PINNED, allowsEmpty: true }),
  [TAB_KIND.NORMAL]: Object.freeze({ kind: TAB_KIND.NORMAL, allowsEmpty: false })
})

export interface KindRecord {
  pinned?: boolean
}
export type TabCapability = keyof (typeof TAB_POLICY)['normal']

/** 取种类（标签与栈同构：都只认 `pinned` 这一个布尔位）。 */
/** @param {KindRecord|null|undefined} record */
function kindOf(record: KindRecord|null|undefined) {
  return record && record.pinned ? TAB_KIND.PINNED : TAB_KIND.NORMAL
}

/** @param {KindRecord|null|undefined} tab */
function tabKind(tab: KindRecord|null|undefined) {
  return kindOf(tab)
}

/** @param {KindRecord|null|undefined} stack */
function stackKind(stack: KindRecord|null|undefined) {
  return kindOf(stack)
}

/** 标签的能力（冻结对象，调用方只读）。 */
/** @param {KindRecord|null|undefined} tab */
function tabPolicy(tab: KindRecord|null|undefined) {
  return TAB_POLICY[kindOf(tab)]
}

/** 栈的能力（冻结对象，调用方只读）。 */
/** @param {KindRecord|null|undefined} stack */
function stackPolicy(stack: KindRecord|null|undefined) {
  return STACK_POLICY[kindOf(stack)]
}

/** @param {KindRecord|null|undefined} a @param {KindRecord|null|undefined} b */
function sameKind(a: KindRecord|null|undefined, b: KindRecord|null|undefined) {
  return kindOf(a) === kindOf(b)
}

/** 通用能力查询（给「将来新增的能力位」留的稳定入口，避免调用方硬编码字段分支）。 */
/** @param {KindRecord|null|undefined} record @param {TabCapability} capability */
function can(record: KindRecord|null|undefined, capability: TabCapability) {
  return TAB_POLICY[kindOf(record)][capability] === true
}

/** @param {KindRecord|null|undefined} tab */
function canSplit(tab: KindRecord|null|undefined) {
  return tabPolicy(tab).split
}

/** @param {KindRecord|null|undefined} tab */
function canGlance(tab: KindRecord|null|undefined) {
  return tabPolicy(tab).glance
}

/** @param {KindRecord|null|undefined} tab */
function canDuplicate(tab: KindRecord|null|undefined) {
  return tabPolicy(tab).duplicate
}

/** @param {KindRecord|null|undefined} tab */
function canArchive(tab: KindRecord|null|undefined) {
  return tabPolicy(tab).archive
}

/** @param {KindRecord|null|undefined} tab */
function canGroupByDomain(tab: KindRecord|null|undefined) {
  return tabPolicy(tab).groupByDomain
}

/** @param {KindRecord|null|undefined} tab */
function canCloseWithOthers(tab: KindRecord|null|undefined) {
  return tabPolicy(tab).closeWithOthers
}

/** 能否离开当前组（固定标签离开 = 取消固定，不属于「出栈」，只能走显式 unpin）。 */
/** @param {KindRecord|null|undefined} tab */
function canLeaveStack(tab: KindRecord|null|undefined) {
  return tabPolicy(tab).leaveStack
}

/**
 * 能否把 `tab` 放进 `stack`（`stack` 为 null 表示出栈）。
 * 跨种类一律否决 —— 这是「固定标签不能和普通标签堆成一组」的唯一判据。
 */
/** @param {KindRecord|null|undefined} tab @param {KindRecord|null|undefined} stack */
function canJoinStack(tab: KindRecord|null|undefined, stack: KindRecord|null|undefined) {
  if (stack == null) return canLeaveStack(tab)
  return sameKind(tab, stack)
}

/** 两个栈能否互相合并：只有同种类之间可以（固定文件夹 ↔ 固定文件夹）。 */
/** @param {KindRecord|null|undefined} a @param {KindRecord|null|undefined} b */
function canMergeStacks(a: KindRecord|null|undefined, b: KindRecord|null|undefined) {
  return sameKind(a, b)
}

/** 两个标签能否堆成同一组：同种类且都允许堆叠。 */
/** @param {KindRecord|null|undefined} a @param {KindRecord|null|undefined} b */
function canStackTogether(a: KindRecord|null|undefined, b: KindRecord|null|undefined) {
  return sameKind(a, b) && tabPolicy(a).stackTogether && tabPolicy(b).stackTogether
}

/**
 * 两个标签能否在扁平顺序里互相穿插。
 * 固定标签永远排在 pinned 段内，普通标签在段外 —— 跨段即改变排序不变式，一律否决。
 */
/** @param {KindRecord|null|undefined} a @param {KindRecord|null|undefined} b */
function canReorderAcross(a: KindRecord|null|undefined, b: KindRecord|null|undefined) {
  return sameKind(a, b)
}

/** 一组标签是否同种类（`createStack` 建组前的成员校验）。 */
/** @param {KindRecord[]|null|undefined} records */
function allSameKind(records: KindRecord[]|null|undefined) {
  const list = Array.isArray(records) ? records : []
  if (list.length === 0) return true
  const first = kindOf(list[0])
  return list.every((record) => kindOf(record) === first)
}

export {
  TAB_KIND,
  TAB_POLICY,
  STACK_POLICY,
  kindOf,
  tabKind,
  stackKind,
  tabPolicy,
  stackPolicy,
  sameKind,
  can,
  canSplit,
  canGlance,
  canDuplicate,
  canArchive,
  canGroupByDomain,
  canCloseWithOthers,
  canLeaveStack,
  canJoinStack,
  canMergeStacks,
  canStackTogether,
  canReorderAcross,
  allSameKind
}
