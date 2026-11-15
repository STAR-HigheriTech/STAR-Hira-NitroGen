/**
 * 「后退 / 前进」按钮右键菜单 —— **唯一实现**。
 *
 * 与 `bookmarkContextMenu.ts` / `tabContextMenu.ts` 同一姿势：
 *   · 本模块只认识三件事 —— `popMenu({x,y,items})`、`getHistory()`、`onPick(index)`；
 *   · 不认识任何 IPC / 标签客户端 / 地址栏；宿主（app-shell）把客户端注入进来；
 *   · 历史条目的真源永远是主进程（`webContents.navigationHistory`）—— 菜单打开那一刻现取，
 *     不缓存、不自推，于是菜单里的条目必定是「现在真能去的」。
 *
 * **两个按钮 = 两份菜单**：菜单内容只由 `direction` 决定 ——
 * 后退键右键只列「可后退的页面」，前进键右键只列「可前进的页面」，
 * 绝不把两侧条目混进同一个菜单（同一份菜单两处入口只会让人分不清自己点的是哪边）。
 */

import type { MenuItem, PopMenu } from './menuTypes'

/** 菜单项 action 前缀：`nav-entry:<index>`，index 是主进程历史栈里的下标。 */
export const NAV_HISTORY_ACTION_PREFIX = 'nav-entry:'

export interface NavHistoryEntry {
  index: number
  title?: string
  url?: string
}

export interface NavHistorySnapshot {
  entries?: NavHistoryEntry[]
  activeIndex?: number
  canGoBack?: boolean
  canGoForward?: boolean
}

export interface NavHistoryMenuOptions {
  popMenu?: PopMenu
  getHistory?: () => Promise<NavHistorySnapshot | null>
  onPick?: (index: number) => void
}

export type NavDirection = 'back' | 'forward'

/** 一条历史条目的可读文案：标题优先，其次 URL，都没有才给占位。 */
function entryLabel(entry: NavHistoryEntry): string {
  const title = String((entry && entry.title) || '').trim()
  if (title) return title
  return String((entry && entry.url) || '').trim() || '(无标题)'
}

/**
 * 一侧历史 → 菜单项。标题行只做分组（原生菜单没有分组标题，用禁用项代替）；
 * 空侧给一条占位 —— 比让整段凭空消失更容易理解（用户能看到「这一侧确实没得去」）。
 * @param {string} title
 * @param {Array<{ index: number, title?: string, url?: string }>} entries
 */
function section(title: string, entries: NavHistoryEntry[]): MenuItem[] {
  return [
    { label: title, enabled: false },
    ...(entries.length
      ? entries.map((e) => ({ label: entryLabel(e), action: NAV_HISTORY_ACTION_PREFIX + e.index }))
      : [{ label: '（无）', enabled: false }])
  ]
}

/**
 * 按方向切出该侧的历史条目（**纯函数**，与菜单/通道无关，便于单测）。
 *
 * 后退侧倒排（最近的在前）—— 与浏览器惯例一致（第一次点就是用户最想回的那页）；
 * 前进侧正序（下一步的在前）。
 *
 * @param {{ entries?: Array<object>, activeIndex?: number }} history
 * @param {'back'|'forward'} direction
 * @returns {Array<{ index: number, title?: string, url?: string }>}
 */
export function pickEntriesByDirection(
  history: NavHistorySnapshot | null | undefined,
  direction: NavDirection
): NavHistoryEntry[] {
  const entries: NavHistoryEntry[] = Array.isArray(history?.entries) ? (history?.entries ?? []) : []
  const activeIndex = Number.isInteger(history?.activeIndex) ? history?.activeIndex as number : -1
  if (activeIndex < 0) return []
  return direction === 'forward'
    ? entries.slice(activeIndex + 1)
    : entries.slice(0, activeIndex).reverse()
}

/**
 * 造一个「在 (x, y) 处弹历史菜单」的函数。
 *
 * @param {{
 *   popMenu?: (payload: { x: number, y: number, items: Array<object> }) => Promise<string|null>,
 *   getHistory?: () => Promise<{ entries?: Array<object>, activeIndex?: number }>,
 *   onPick?: (index: number) => void
 * }} [deps]
 *   `getHistory` 缺省 / 抛错 → 菜单只给一条「无历史记录」，绝不让右键变成静默无响应。
 * @returns {(arg: { direction?: 'back'|'forward', x: number, y: number }) => Promise<void>}
 */
export function createNavHistoryMenu({
  popMenu,
  getHistory,
  onPick
}: NavHistoryMenuOptions = {}) : (arg: { direction?: 'back'|'forward', x: number, y: number }) => Promise<void> {
  return async function openNavHistoryMenu({
    direction = 'back',
    x,
    y
  }: {
    direction?: NavDirection
    x: number
    y: number
  }): Promise<void> {
    if (typeof popMenu !== 'function') return

    const isForward = direction === 'forward'

    let history: NavHistorySnapshot | null = null
    try {
      history = typeof getHistory === 'function' ? await getHistory() : null
    } catch {
      // 取不到历史 → 下面按「空历史」渲染，不弹一个报错弹窗打断用户。
    }

    const list = pickEntriesByDirection(history, isForward ? 'forward' : 'back')
    const items = list.length
      ? section(isForward ? '可前进的页面' : '可后退的页面', list)
      : [{ label: isForward ? '没有可前进的页面' : '没有可后退的页面', enabled: false }]

    let action: string | null = null
    try {
      action = await popMenu({ x, y, items })
    } catch {
      action = null
    }

    const matched = /^nav-entry:(\d+)$/.exec(String(action || ''))
    if (!matched || typeof onPick !== 'function') return
    onPick(Number(matched[1]))
  }
}
