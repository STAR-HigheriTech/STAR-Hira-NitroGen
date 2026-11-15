import {
  IPC_ROUTES, rpc, el, faviconBadge, fmtTime, renderEmpty, initTheme, openLink
} from 'hira://shared/runtime.js'
import type { PageRpcRecord } from 'hira://shared/runtime.js'
import { WEEKDAY_NAMES } from 'hira://shared/weekday.mjs'

const legacyArchiveId = new URLSearchParams(location.search).get('archive')
if (legacyArchiveId) {
  location.replace(`hira://archive?id=${encodeURIComponent(legacyArchiveId)}`)
}

type HistoryEntry = PageRpcRecord & {
  id: string
  url: string
  title?: string | null
  favicon?: string | null
  snippet?: string | null
  lastVisitAt: number
}

interface RecentTab extends PageRpcRecord {
  url?: string
  title?: string
  favicon?: string
}

function requiredElement<T>(id: string): T {
  const element = document.getElementById(id)
  if (!element) throw new Error(`History page element #${id} is unavailable`)
  return element as unknown as T
}

function errorMessage(error: unknown, fallback: string): string {
  return error instanceof Error && error.message ? error.message : fallback
}

const selectedIds = new Set<string>()
const search = requiredElement<HTMLInputElement>('search')
const quickRangeSelect = requiredElement<HTMLSelectElement>('quick-range')
const from = requiredElement<HTMLInputElement>('from')
const to = requiredElement<HTMLInputElement>('to')
const list = requiredElement<HTMLElement>('list')
const removeSelected = requiredElement<HTMLButtonElement>('remove-selected')
const recentList = requiredElement<HTMLElement>('recent-list')
const recentClear = requiredElement<HTMLButtonElement>('recent-clear')

// 跟随 app.theme 三态（浅/深/系统），配色统一于设置页 → base.css 同源 token
initTheme()

function selectedLabel(): void {
  removeSelected.disabled = selectedIds.size === 0
  removeSelected.textContent = selectedIds.size
    ? `删除所选（${selectedIds.size}）`
    : '删除所选'
}

function timestampFor (input: HTMLInputElement): number | null {
  return input.value ? new Date(input.value).getTime() : null
}

function startOfSelectedDay (input: HTMLInputElement): number | null {
  if (!input.value) return null
  const date = new Date(input.value)
  date.setHours(0, 0, 0, 0)
  return date.getTime()
}

function currentRange (): { from: number; to: number } | null {
  const start = timestampFor(from)
  const end = timestampFor(to)
  if (start === null || end === null) return null
  if (start > end) throw new Error('开始日期必须早于结束日期。')
  return { from: start, to: end }
}

/**
 * 「最近 N 天」快捷时间段：与手动时间段互斥（选一个清另一个，见下方事件）。
 * 返回 null 表示「全部」（走 historyList 默认列表）。
 */
function quickRange (): { from: number; to: number } | null {
  const value = quickRangeSelect.value
  if (!value) return null
  const now = Date.now()
  const start = new Date()
  start.setHours(0, 0, 0, 0)
  if (value === 'today') return { from: start.getTime(), to: now }
  const days = Number(value)
  if (!Number.isFinite(days) || days <= 0) return null
  // 「最近 7 天」= 今天 + 往前 6 天（含今天共 7 个自然日）
  return { from: start.getTime() - (days - 1) * 86400000, to: now }
}

async function loadItems (): Promise<HistoryEntry[]> {
  const query = search.value.trim()
  if (query) return rpc<HistoryEntry[]>(IPC_ROUTES.historySearch, { query, limit: 200 })
  const range = currentRange()
  if (range) return rpc<HistoryEntry[]>(IPC_ROUTES.historyQueryRange, { ...range, limit: 200 })
  const quick = quickRange()
  if (quick) return rpc<HistoryEntry[]>(IPC_ROUTES.historyQueryRange, { ...quick, limit: 200 })
  return rpc<HistoryEntry[]>(IPC_ROUTES.historyList, { limit: 200 })
}

/**
 * 按天分组的组标题（列表本身按访问时间倒序，同一天必然相邻，逐行比较即可）。
 * 今天 / 昨天 / 一周内「星期X（M月D日）」/ 更早「X年X月X日」—— 对齐 Chrome 的分组口径。
 */
function dayLabel (ts: number): string {
  const date = new Date(ts)
  const day = new Date(ts)
  day.setHours(0, 0, 0, 0)
  const today = new Date()
  today.setHours(0, 0, 0, 0)
  const diff = Math.round((today.getTime() - day.getTime()) / 86400000)
  if (diff === 0) return '今天'
  if (diff === 1) return '昨天'
  if (diff < 7) return `${WEEKDAY_NAMES[date.getDay()]}（${date.getMonth() + 1}月${date.getDate()}日）`
  return `${date.getFullYear()}年${date.getMonth() + 1}月${date.getDate()}日`
}
function buildRow (entry: HistoryEntry): HTMLElement {
  const row = el('div', 'row')
  const checkbox = el('input', 'history-select')
  checkbox.type = 'checkbox'
  checkbox.checked = selectedIds.has(entry.id)
  checkbox.onclick = (event: MouseEvent) => event.stopPropagation()
  checkbox.onchange = () => {
    if (checkbox.checked) selectedIds.add(entry.id)
    else selectedIds.delete(entry.id)
    selectedLabel()
  }

  // 第三个参数 = 历史行自己带回来的 favicon（访问时由主进程落库）：优先用它，
  // 页面地址只作为「众所周知的 /favicon.ico」兜底。见 hira://shared/favicon-src.mjs。
  const favicon = faviconBadge(entry.url, entry.title, entry.favicon)

  const actions = el('div', 'actions')
  const remove = el('button', 'icon-btn', '×')
  remove.title = '删除'
  remove.onclick = async (event: MouseEvent) => {
    event.stopPropagation()
    await rpc(IPC_ROUTES.historyRemove, { id: entry.id })
    selectedIds.delete(entry.id)
    await refresh()
  }
  actions.appendChild(remove)

  row.appendChild(checkbox as unknown as Node)
  row.appendChild(favicon)
  // E3：标题 + （可选）正文摘要。摘要只在**正文命中**时出现，用 FTS snippet 的
  // `[词]` 标记告诉你"是这句话里的那个词命中的"——标题命中时没有它，不占高度。
  const main = el('div', 'main')
  main.appendChild(el('div', 'title', entry.title || entry.url))
  if (entry.snippet) main.appendChild(el('div', 'snippet', entry.snippet))
  row.appendChild(main)
  row.appendChild(el('div', 'time', fmtTime(entry.lastVisitAt)))
  row.appendChild(actions)
  // 手势交给 openLink：普通点击 = 本页打开；Ctrl/Cmd/中键 = 后台新标签
  //（规则真源 link-intent.mjs，页面不判断 ctrlKey）。
  const openRow = (event: MouseEvent) => {
    if (event.target instanceof Element && event.target.closest('button, input, textarea')) return
    openLink(entry.url, event)
  }
  row.onclick = openRow
  row.onauxclick = (event: MouseEvent) => { if (event.button === 1) openRow(event) }
  return row
}

/**
 * 刷新令牌：只渲染**最后一次**请求的结果。
 *
 * 搜索防抖、快捷范围、删除后重拉、刷新按钮都会并发触发 refresh()；
 * 旧实现是「先清空再 await 再追加」——两个请求交错就会把同一份列表**渲染两遍**
 * （列表里凭空多出一倍行）。这里先取数、拿到最新令牌后才清空并渲染。
 */
let refreshToken = 0

async function refresh () {
  const token = ++refreshToken
  let items: HistoryEntry[] = []
  try {
    items = await loadItems()
  } catch (error) {
    if (token !== refreshToken) return
    list.textContent = ''
    renderEmpty(list, errorMessage(error, '历史记录加载失败'))
    return
  }
  if (token !== refreshToken) return

  // 一条 URL 一行：哪怕上游意外返回重复项，列表也只渲染一次（按 id 去重）。
  const seenIds = new Set<string>()
  items = items.filter((entry) => {
    if (!entry || seenIds.has(entry.id)) return false
    seenIds.add(entry.id)
    return true
  })

  const visibleIds = new Set(items.map((entry) => entry.id))
  for (const id of selectedIds) {
    if (!visibleIds.has(id)) selectedIds.delete(id)
  }
  selectedLabel()

  list.textContent = ''
  if (items.length === 0) {
    renderEmpty(list, '暂无历史记录。')
    return
  }

  const fragment = document.createDocumentFragment()
  let currentGroup = ''
  for (const entry of items) {
    const group = dayLabel(entry.lastVisitAt)
    if (group !== currentGroup) {
      currentGroup = group
      fragment.appendChild(el('div', 'history-group', group))
    }
    fragment.appendChild(buildRow(entry))
  }
  list.appendChild(fragment)
}

/**
 * 「最近关闭」侧栏：数据与 Ctrl+Shift+T 同源（主进程的撤销栈）。
 *
 * 分页/筛选都只作用于历史列表，**不影响**这个侧栏 —— 它回答的是
 * 「我刚关掉的那几个页面在哪」，与当前搜索词无关（对齐 Edge 的历史页）。
 */
async function refreshRecentlyClosed () {
  let tabs: RecentTab[] = []
  try {
    const res = await rpc<{ tabs?: RecentTab[] }>(IPC_ROUTES.tabRecentlyClosed, {})
    tabs = res && Array.isArray(res.tabs) ? res.tabs : []
  } catch (_) {
    tabs = []
  }
  recentList.textContent = ''
  recentClear.disabled = tabs.length === 0
  if (tabs.length === 0) {
    renderEmpty(recentList, '暂无最近关闭的标签页。')
    return
  }
  const fragment = document.createDocumentFragment()
  tabs.forEach((entry, index) => {
    const row = el('div', 'row recent-row')
    row.appendChild(faviconBadge(entry.url, entry.title, entry.favicon))
    const main = el('div', 'main')
    main.appendChild(el('div', 'title', entry.title || entry.url || '（无标题）'))
    main.appendChild(el('div', 'url', entry.url || ''))
    row.appendChild(main)
    row.title = entry.url || ''
    // 点击即恢复该项（index 口径 = 列表顺序，0 = 最近关闭在前）。
    row.onclick = async () => {
      try {
        const res = await rpc<PageRpcRecord>(IPC_ROUTES.tabRecentlyClosedRestore, { index })
        // 恢复成功会切到那个标签；失败（例如栈已被别处改动）就重拉一次让列表回到真实状态。
        if (res && res.ok) return
        await refreshRecentlyClosed()
      } catch (_) {
        await refreshRecentlyClosed()
      }
    }
    fragment.appendChild(row)
  })
  recentList.appendChild(fragment)
}

async function removeSelection () {
  if (selectedIds.size === 0) return
  const ids = [...selectedIds]
  if (!confirm(`确定删除所选的 ${ids.length} 条历史记录吗？`)) return
  await rpc(IPC_ROUTES.historyRemoveMany, { ids })
  selectedIds.clear()
  await refresh()
}

async function removeOlderEntries () {
  const before = startOfSelectedDay(to)
  if (before === null) {
    renderEmpty(list, '请先选择截止日期，再清除更早的历史记录。')
    return
  }
  if (!confirm('确定清除该日期之前的所有历史记录吗？')) return
  await rpc(IPC_ROUTES.historyRemoveBefore, { before })
  selectedIds.clear()
  await refresh()
}

// 刷新 = 唯一的手动取数入口：历史列表与「最近关闭」侧栏一起重拉。
// 页面不再订阅 historyChanged，也不在 focus 时偷偷刷新 —— 用户看到的永远是
// 「上一次点刷新的那一刻」，不会因为后台写入而跳动。
requiredElement<HTMLButtonElement>('refresh').onclick = () => {
  refresh()
  refreshRecentlyClosed()
}
requiredElement<HTMLButtonElement>('range').onclick = refresh
removeSelected.onclick = removeSelection

// 快捷时间段与手动时间段互斥：选了一个就清掉另一个，筛选来源永远唯一
quickRangeSelect.addEventListener('change', () => {
  from.value = ''
  to.value = ''
  refresh()
})
for (const input of [from, to]) {
  input.addEventListener('change', () => {
    if (from.value || to.value) quickRangeSelect.value = ''
  })
}

requiredElement<HTMLButtonElement>('remove-before').onclick = async () => {
  try {
    await removeOlderEntries()
  } catch (error) {
    renderEmpty(list, errorMessage(error, '清除历史记录失败'))
  }
}

let searchTimer: number | null = null
search.addEventListener('input', () => {
  if (searchTimer !== null) window.clearTimeout(searchTimer)
  searchTimer = window.setTimeout(refresh, 150)
})

requiredElement<HTMLButtonElement>('clear').onclick = async () => {
  if (!confirm('确定清除所有浏览历史记录吗？')) return
  await rpc(IPC_ROUTES.historyClear, {})
  selectedIds.clear()
  await refresh()
}

selectedLabel()

recentClear.onclick = async () => {
  if (!confirm('确定清空最近关闭的标签页列表吗？')) return
  await rpc(IPC_ROUTES.tabRecentlyClosedClear, {})
  await refreshRecentlyClosed()
}

refresh()
refreshRecentlyClosed()
