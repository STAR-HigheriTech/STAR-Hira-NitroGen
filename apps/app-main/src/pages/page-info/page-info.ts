import { IPC_ROUTES, rpc, el, initTheme, faviconBadge } from 'hira://shared/runtime.js'
import { errorMessage, requiredById } from 'hira://shared/page-kit.js'

interface PageInfoRecord {
  tabId?: string
  url?: string
  title?: string
  favicon?: string
  isLoading?: boolean
  canGoBack?: boolean
  canGoForward?: boolean
  isPinned?: boolean
  isMuted?: boolean
  isSleeping?: boolean
  osPid?: number | null
}

// 跟随 app.theme 三态（浅/深/系统），配色统一于设置页 → base.css 同源 token
initTheme()

const grid = requiredById<HTMLElement>('grid')
const faviconSlot = requiredById<HTMLElement>('favicon')
const headTitle = requiredById<HTMLElement>('head-title')
const noteEl = requiredById<HTMLElement>('note')
const refreshButton = requiredById<HTMLButtonElement>('refresh')

/**
 * 来源标签 id：从站点信息浮层打开时带上（`hira://page-info?tabId=…`）。
 *
 * 不带就会掉进一个自指陷阱 —— 主进程按「当前活动标签」解析，而本页正是当前标签，
 * 于是展示的永远是 page-info 自己。来源必须由打开方显式给出，本页不猜。
 */
const sourceTabId = new URLSearchParams(location.search).get('tabId') || ''

const YES_NO = (value: unknown): string => (value ? '是' : '否')

function addRow (label: string, value: unknown, mono = false): void {
  grid.appendChild(el('dt', undefined, label))
  grid.appendChild(el('dd', mono ? 'mono' : undefined, value === '' || value === null || value === undefined ? '—' : String(value)))
}

function renderFavicon (info: PageInfoRecord): void {
  faviconSlot.textContent = ''
  // 与面板 / 书签栏 / 浮层同一条取图规则（代理 → 直连 → 首字母），不另写一份。
  faviconSlot.appendChild(faviconBadge(info.url || '', info.title, info.favicon, { size: 20 }))
}

async function refresh (): Promise<void> {
  noteEl.className = 'note'
  noteEl.textContent = ''
  grid.textContent = ''
  faviconSlot.textContent = ''
  headTitle.textContent = ''

  let info: PageInfoRecord | null = null
  if (!sourceTabId) {
    // 没有来源 id 时**绝不回退问「当前活动标签」**：本页自己就是当前标签，
    // 那样只会把「页面信息页面的信息」当成答案。宁可明说不知道看哪一页。
    noteEl.textContent = '没有指定要查看的页面。请从地址栏左端的站点信息浮层或 ⋮ 菜单打开页面信息。'
    return
  }
  try {
    info = await rpc<PageInfoRecord>(IPC_ROUTES.pageInfo, { tabId: sourceTabId })
  } catch (error) {
    noteEl.textContent = '读取页面信息失败：' + errorMessage(error)
    return
  }

  if (!info || !info.tabId) {
    noteEl.textContent = '来源标签已关闭，无法读取页面信息。'
    return
  }

  headTitle.textContent = info.title || info.url || '（无标题）'
  renderFavicon(info)

  addRow('标题', info.title)
  addRow('地址', info.url, true)
  addRow('图标地址', info.favicon, true)
  addRow('加载状态', info.isLoading ? '加载中' : '已完成')
  addRow('可否后退', YES_NO(info.canGoBack))
  addRow('可否前进', YES_NO(info.canGoForward))
  addRow('是否固定标签', YES_NO(info.isPinned))
  addRow('是否静音', YES_NO(info.isMuted))
  addRow('是否休眠', YES_NO(info.isSleeping))
  addRow('渲染进程 PID', info.osPid === null || info.osPid === undefined ? '未知' : info.osPid)
  addRow('标签 ID', info.tabId, true)
  addRow('用户代理', navigator.userAgent, true)
}

refreshButton.onclick = refresh
refresh()
