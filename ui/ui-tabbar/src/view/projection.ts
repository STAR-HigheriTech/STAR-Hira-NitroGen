// @ts-check
/**
 * 标签条投影（projection）的**纯函数工具** —— 零 DOM、零状态、零依赖。
 *
 * 为什么独立成模块：标签条里有三处都要「按 tabId 在投影里找东西」——
 *   · 拖拽落点判定（这个标签在不在组里 / 落点是谁）
 *   · 右键菜单（「与右侧标签堆叠」里的右侧那一项是谁）
 *   · 渲染（哪些标签组当前真的有芯片）
 * 各写一份 `lastItems.find(...)` 的结果是：投影结构一变就要改三处，而且必然漏一处。
 * 收敛到这里之后，它们是**可单测的纯函数**，也把「投影长什么样」这件事
 * 从渲染管线里独立出来 —— 换数据结构只动这一个文件。
 */

/**
 * 逐字段比较，返回变化子集（无变化返回 null）。
 * 对齐 RT updateTabState 的逐字段 diff：`update()` 只在真有变化时才被调用。
 * @param {UnknownRecord|null|undefined} prev
 * @param {UnknownRecord} next
 * @returns {UnknownRecord|null}
 */
export function diffFields(prev: UnknownRecord | null | undefined, next: UnknownRecord): UnknownRecord | null {
  if (!prev) return next
  let changed: UnknownRecord | null = null
  for (const k in next) {
    if (prev[k] !== next[k]) {
      if (!changed) changed = {}
      changed[k] = next[k]
    }
  }
  return changed
}

/**
 * 投影里某个标签自己所属的标签组 id（散标签 / 查不到 → null）。
 *
 * 拖拽落点判定全部以它为据：投影是渲染层唯一的真相源，每个标签项都带着自己的
 * `stackId`（domain 的投影契约），因此「落点是不是组内标签」「被拖的是不是已在组里」
 * 都不必再异步查一遍标签列表。
 * @param {TabbarProjection} items
 * @param {string|number|null|undefined} tabId
 * @returns {string|null}
 */
export function stackIdOfTab(items: TabbarProjection, tabId: string | number | null | undefined): string | null {
  const id = String(tabId)
  const item = asList(items).find((it) => it && it.tabId != null && String(it.tabId) === id)
  return item && item.stackId != null ? String(item.stackId) : null
}

/**
 * 投影里排在某个标签**之后**的那一项（可能是散标签，也可能是标签组芯片）。
 *
 * 为什么看投影而不是只看散标签：折叠起来的标签组在投影里就是一个芯片，
 * 它同样是「右侧可堆叠的目标」—— 用户看到什么，就应当能堆到什么上面。
 * @param {TabbarProjection} items
 * @param {string|number|null|undefined} tabId
 * @returns {TabbarProjectionItem|null}
 */
export function itemAfter(
  items: TabbarProjection,
  tabId: string | number | null | undefined
): TabbarProjectionItem | null {
  const list = asList(items)
  const i = list.findIndex((it) => it && String(it.tabId) === String(tabId))
  if (i < 0) return null
  return list[i + 1] || null
}

/** 投影项 → keyed 复用键（与 renderer 的 nodeRecords 同一套键）。 */
export function keyOf(item: TabbarProjectionItem | null | undefined): string {
  if (!item) return ''
  return item.type === 'stack' ? `stack:${item.stackId}` : `tab:${item.tabId}`
}

/**
 * 会改变行盒几何的字段（白名单，宁少不多）。
 *
 * 只收「一改就会让标签宽高 / 图标占位 / 芯片数量变化」的那些：装饰绘制层
 * （组下划线、分屏回形针）只在 `affectsGeometry` 为真时才续期逐帧跟踪 ——
 * 纯内容事件（标题、favicon、loading、媒体）走完整条渲染管线后像素一个都没动，
 * 若照样 ping，有标签组的窗口在页面加载期会常驻逐帧测量（实测正是"加载时卡一下"的来源）。
 * @type {Set<string>}
 */
const GEOMETRY_FIELDS: Set<string> = new Set([
  'active',
  'pinned',
  'muted',
  'isPlaying',
  'permissionIcons',
  'stackId',
  'label',
  'count',
  'collapsed'
])

/**
 * 这次字段变化是否可能影响几何（进而需要重画装饰层并续期跟踪）。
 * @param {UnknownRecord|null} changed diffFields 的结果
 * @returns {boolean}
 */
export function affectsGeometry(changed: UnknownRecord | null): boolean {
  if (!changed) return false
  for (const k in changed) {
    if (GEOMETRY_FIELDS.has(k)) return true
  }
  return false
}

function asList(items: TabbarProjection): TabbarProjectionItem[] {
  return Array.isArray(items) ? items : []
}
import type {
  TabbarProjection,
  TabbarProjectionItem,
  UnknownRecord
} from '../types.js'

