/**
 * 分屏（Split View）的**渲染侧动作表** —— apps 层唯一一处。
 *
 * 与 `stackTogether` 同款定位：ui-common 只认识"菜单里有哪些项、点了返回什么动作"，
 * 而"这个动作具体调哪个客户端方法"是 apps 层的知识。横竖两个列表宿主要做的
 * 是**同一件事**，抄两遍必然漂移（先例：关闭右侧标签曾经只在一个入口有）。
 *
 * 分屏与标签栈是**正交**的两件事（栈是收纳、分屏是并列），所以这里不 import
 * 任何栈相关的动作表，两者各自独立。
 */

// 分屏形态轮换的**共用规则**（主进程的分屏工具条用的是同一个函数）。
import { nextSplitLayout } from '@hira-ng/shared-types/src/split-layout.mjs'

interface SplitMember { tabId?: string | number; splitId?: string; [key: string]: unknown }
interface SplitItem { splitId: string; layout: 'row' | 'column' | 'grid'; members?: SplitMember[] }
interface SplitListResult { splits?: SplitItem[]; canRestoreSplit?: boolean }
interface SplitTabsClient {
  createSplit(payload: { tabIds: string[] }): Promise<unknown> | unknown
  listSplits(): Promise<SplitListResult> | SplitListResult
  setSplitLayout(splitId: string, layout: string): Promise<unknown> | unknown
  dissolveSplit(splitId: string): Promise<unknown> | unknown
  createStack(payload: { tabIds: string[] }): Promise<unknown> | unknown
  setSplitRatioPreset(splitId: string, preset: string): Promise<unknown> | unknown
  restoreSplit(): Promise<unknown> | unknown
  reverseSplit(splitId: string): Promise<unknown> | unknown
}

/**
 * 把「当前标签 + 相邻标签」组成一个分屏。
 * @param {{ createSplit: Function }} tabsClient
 * @param {string} tabId
 * @param {{ tabId?: string, type?: string }|null} adjacent 列表里紧邻的下一项
 * @returns {Promise<object|null>}
 */
export function splitTogether(tabsClient: Pick<SplitTabsClient, 'createSplit'>, tabId: string, adjacent: { tabId?: string | number, type?: string }|null) : Promise<object|null> {
  const otherId = adjacent && adjacent.tabId != null ? String(adjacent.tabId) : ''
  const selfId = tabId != null ? String(tabId) : ''
  // 相邻项是栈芯片（不是普通标签）时不做分屏：栈代表多个标签，语义不明确。
  if (!selfId || !otherId || (adjacent && adjacent.type === 'stack')) return Promise.resolve(null)
  return Promise.resolve(tabsClient.createSplit({ tabIds: [selfId, otherId] })) as Promise<object | null>
}

/**
 * 轮换分屏形态：左右 → 上下 → （三格以上才有）网格 → 左右。
 *
 * 2 格时**不出现网格**：`gridShape(2)` = 1 列 2 行，与"上下"逐像素相同 ——
 * 让用户切到一个看不出区别的状态是最容易让人以为"按钮坏了"的做法。
 *
 * @param {{ listSplits: Function, setSplitLayout: Function }} tabsClient
 * @param {string} splitId
 * @returns {Promise<object|null>}
 */
export async function toggleSplitLayoutOf(tabsClient: Pick<SplitTabsClient, 'listSplits' | 'setSplitLayout'>, splitId: string) : Promise<object|null> {
  const id = splitId != null ? String(splitId) : ''
  if (!id) return null
  const res = await tabsClient.listSplits()
  const split = ((res && res.splits) || []).find((item: SplitItem) => item.splitId === id)
  if (!split) return null
  // "下一个形态是什么"是**共用规则**（主进程的工具条用的是同一个函数）——
  // 尤其"2 格时跳过 grid（它与上下逐像素相同）"这种细节，两处各写必然只在一边写对。
  const next = nextSplitLayout(split.layout, (split.members || []).length)
  return tabsClient.setSplitLayout(id, next) as Promise<object | null>
}

/**
 * **分屏 → 标签栈**（I4 的另一半）：把同组成员收进一个标签栈。
 *
 * 顺序是"先解散、再建栈"，不能反：两者语义互斥（栈是收纳/一次只见一个，分屏是并列），
 * 同时存在只会让用户看到一个自相矛盾的状态；先建栈再解散则会在中间帧出现"又分组又分屏"。
 *
 * @param {{ listSplits: Function, dissolveSplit: Function, createStack: Function }} tabsClient
 * @param {string} splitId
 * @returns {Promise<object|null>}
 */
export async function collapseSplitIntoStack(tabsClient: Pick<SplitTabsClient, 'listSplits' | 'dissolveSplit' | 'createStack'>, splitId: string) : Promise<object|null> {
  const id = splitId != null ? String(splitId) : ''
  if (!id) return null
  const res = await tabsClient.listSplits()
  const split = ((res && res.splits) || []).find((item: SplitItem) => item.splitId === id)
  const members = split && Array.isArray(split.members)
    ? split.members.map((member) => member.tabId == null ? '' : String(member.tabId)).filter(Boolean)
    : []
  if (members.length < 2) return null
  await tabsClient.dissolveSplit(id)
  return tabsClient.createStack({ tabIds: members }) as Promise<object | null>
}

/**
 * 「分屏」可用的**动作集合**（两个列表宿主共用一份接线）。
 * @param {{ createSplit: Function, listSplits: Function, setSplitLayout: Function,
 *           setSplitRatioPreset: Function, restoreSplit: Function,
 *           reverseSplit: Function, dissolveSplit: Function, createStack: Function }} tabsClient
 */
export function createSplitMenuHandlers(tabsClient: SplitTabsClient) {
  return {
    onSplitWith: (tabId: string, adjacent: { tabId?: string | number; type?: string } | null) => splitTogether(tabsClient, tabId, adjacent),
    onToggleSplitLayout: (splitId: string) => toggleSplitLayoutOf(tabsClient, splitId),
    onReverseSplit: (splitId: string) => tabsClient.reverseSplit(String(splitId)),
    onDissolveSplit: (splitId: string) => tabsClient.dissolveSplit(String(splitId)),
    onCollapseSplit: (splitId: string) => collapseSplitIntoStack(tabsClient, splitId),
    // 比例只报预设名（换算在主进程；格数是变量）
    onSplitRatio: (splitId: string, preset: string) => tabsClient.setSplitRatioPreset(String(splitId), String(preset)),
    onRestoreSplit: () => tabsClient.restoreSplit(),
    // 菜单项的**精确可见性**：问一次"真能复原吗"（与 restore 同一判据），
    // 失败一律当"没有"——多一个灰项不如少一个（S4：不出现点了没反应的项）。
    canRestoreSplit: () => Promise.resolve(tabsClient.listSplits())
      .then((res: SplitListResult) => !!(res && res.canRestoreSplit))
      .catch(() => false)
  }
}

