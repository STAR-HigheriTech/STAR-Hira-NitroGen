// @ts-check
/**
 * @hira-ng/ui-panel-history —— 历史记录侧边面板（分段壳）
 *
 * ── 为什么是「历史 / 最近关闭」两段而不是两个面板 ─────────────────────────
 * 两者回答的是同一族问题：「我见过的那个页面去哪了？」
 *   · 历史     = 见过的全部（搜索 / 时间段 / 批量清理）
 *   · 最近关闭 = 刚才关掉的那个（撤销栈镜像，跨启动保留最近三次启动的记录，点击即恢复）
 * 给它们各开一个 rail 入口，用户得先猜"该点哪个"——而这不该是判断题。
 * （「已归档」回答的是"我的标签去哪了"，随标签语义搬到「标签」面板。）
 *
 * ── 分段壳只做四件事 ────────────────────────────────────────────────────
 *   1. 画分段栏；
 *   2. **懒拉取**：最近关闭第一次被切到时才向编排层要数据；
 *   3. 分段只在本面板内切换 —— **不落设置**：每次打开都从「历史」开始；
 *   4. 转发 setItems / setRecentItems / focusSearch。
 * 两段视图都是**哑组件**，互不认识：
 *   · history = ./historyList.js（与聚合总览共用同一份行件）
 *   · recent  = createRecentList（同上，撤销栈行件）
 *
 * 解耦要点：本文件不直接调 IPC —— 所有取数/改动经 `onIntent` 上行到编排层。
 */

import type { PanelDefinition, PanelContext } from '@hira-ng/ui-common'
import {
  injectPanelStyles,
  createFaviconBadge,
  resolvePanelOpenTarget,
  openPanelTarget,
  RefreshCw,
  Check,
  Trash2,
  Eraser,
  Search
} from '@hira-ng/ui-common'
// 分段值集合的真源（分段壳 / 域层默认值 / 设置页共用），见 panels.mjs。
import {
  HISTORY_VIEW_MODES, DEFAULT_HISTORY_VIEW_MODE
} from '@hira-ng/shared-types/src/panels.mjs'
import { createHistoryList, makeRowDraggable } from "./historyList"
import type { HistoryListItem } from "./historyList"
import type { BookmarkModifierSnapshot } from '@hira-ng/ui-common'

/** 行件对外复用口：聚合总览的「最近关闭」块与历史面板必须是同一份实现。 */
export { createHistoryList }

const STYLE_ID = 'hira-panel-history-styles'

/**
 * 分段表：顺序即展示顺序。`key` 同时是视图注册表的键。
 * 取值与顺序来自 shared-types；中文名是本视图自己的文案。
 */
const SEGMENT_LABELS = { history: '历史', recent: '最近关闭' }
type SegmentName = keyof typeof SEGMENT_LABELS
type Segment = { key: SegmentName; label: string }
const SEGMENTS: Segment[] = [...HISTORY_VIEW_MODES.flatMap((key) => (
  key in SEGMENT_LABELS ? [{ key: key as SegmentName, label: SEGMENT_LABELS[key as SegmentName] }] : []
))]

interface RecentListItem extends HistoryListItem { restoreIndex?: number }

interface HistoryPanelIntent {
  type: string
  query?: string
  url?: string
  title?: string
  id?: string
  ids?: string[]
  index?: number
  modifiers?: BookmarkModifierSnapshot
}

interface HistoryTabsPort {
  newTab(input: { url: string }): Promise<unknown>
  restoreRecentlyClosed(index: number): Promise<unknown>
  clearRecentlyClosed(): Promise<unknown>
  recentlyClosed(): Promise<{ tabs?: RecentListItem[] }>
}

interface HistoryBridge {
  provider: { invoke(route: string, payload?: unknown): Promise<unknown> }
}

interface HistoryMenuClient {
  popupMenu(payload: {
    items: Array<Record<string, unknown>>
    x: number
    y: number
    context: Record<string, unknown>
  }): Promise<string | null>
}

type HistoryPanelContext = Omit<PanelContext, 'onIntent' | 'clients' | 'bridge' | 'confirm' | 'menu'> & {
  onIntent?: (intent: HistoryPanelIntent) => void
  clients?: (PanelContext['clients'] & { tabs?: HistoryTabsPort }) | null
  bridge?: HistoryBridge
  confirm?: PanelContext['confirm']
  menu?: HistoryMenuClient | null
}

export function injectHistoryPanelStyles(doc: Document): void {
  injectPanelStyles(doc)
  if (doc.getElementById(STYLE_ID)) return
  const style = doc.createElement('style')
  style.id = STYLE_ID
  style.textContent = `
    .history-panel__wrap { display: flex; flex-direction: column; height: 100%; min-height: 0; }
    /* 分段栏：两块数据同属「我见过的页面」，同住一个面板。
       视觉规格与「标签」面板的分段栏完全一致（同层级、同高度、同选中态）。 */
    .history-panel__seg { display: flex; gap: 4px; padding: 0; flex-shrink: 0; margin-bottom: 8px; }
    .history-panel__seg-tab {
      position: relative; flex: 1; border: none; background: transparent;
      height: var(--hira-control-height, 32px); padding: 0 10px;
      border-radius: var(--hira-radius-sm, 8px); cursor: pointer;
      font-family: inherit; font-size: 12px;
      color: var(--hira-text-secondary, #6b7280);
      transition: color var(--hira-dur-fast, 120ms) var(--hira-ease-standard, ease),
                  background var(--hira-dur-fast, 120ms) var(--hira-ease-standard, ease);
    }
    .history-panel__seg-tab:hover { background: var(--hira-surface-soft, rgba(0,0,0,0.05)); color: var(--hira-text-primary, #1a1a1a); }
    .history-panel__seg-tab[aria-selected="true"] {
      color: var(--hira-accent, #3b82f6); font-weight: 500;
      background: var(--hira-accent-soft, rgba(59,130,246,0.14));
    }
    .history-panel__view { display: flex; flex-direction: column; flex: 1; min-height: 0; }
    .history-panel__view[hidden] { display: none; }
    /* 列表本体滚动（工具栏/分段栏固定）—— 两个视图共用，行为一致。 */
    .history-panel__list { flex: 1; min-height: 0; overflow-y: auto; padding-bottom: 8px; }
    .history-panel__recent-toolbar {
      display: flex; align-items: center; justify-content: space-between; gap: 10px;
      padding: 0 0 8px; flex-shrink: 0;
    }
    .history-panel__hint { font-size: 11px; color: var(--hira-text-tertiary, #8b8b8b); }
    .history-panel__row-main {
      flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 2px;
      align-items: flex-start; border: 0; background: transparent; padding: 0;
      text-align: left; cursor: pointer;
    }
    .history-panel__row-title {
      font-size: 12px; line-height: 18px; color: var(--hira-text-primary, #1a1a1a);
      overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
      max-width: 100%;
    }
    .history-panel__row-url {
      font-size: 11px; line-height: 15px; color: var(--hira-text-tertiary, #8b8b8b);
      overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
      max-width: 100%;
    }
    .history-panel__toolbar {
      display: flex; flex-direction: column; gap: 8px; flex-shrink: 0;
      padding: 2px 0 8px; margin-bottom: 4px;
    }
    .history-panel__search {
      display: flex; align-items: center; gap: 8px;
      height: var(--hira-control-height, 32px); padding: 0 12px;
      border-radius: var(--hira-radius-md, 10px);
      background: var(--hira-field-bg, rgba(0,0,0,0.04));
      border: 0;
      transition: background var(--hira-dur-fast, 120ms) var(--hira-ease-standard, ease),
                  box-shadow var(--hira-dur-fast, 120ms) var(--hira-ease-standard, ease);
    }
    .history-panel__search:focus-within { background: var(--hira-field-bg-focus, rgba(0,0,0,0.05)); box-shadow: var(--hira-focus-ring); }
    .history-panel__search input {
      flex: 1; border: none; outline: none; background: transparent;
      color: var(--hira-text-primary, #1a1a1a); font-size: 12px; padding: 0;
    }
    .history-panel__search input::placeholder { color: var(--hira-text-tertiary, #8b8b8b); }
    .history-panel__actions { display: flex; gap: 4px; align-items: center; }
    .history-panel__actions button {
      border: 0; background: transparent;
      display: inline-flex; align-items: center; justify-content: center;
      border-radius: var(--hira-radius-sm, 8px);
      width: var(--hira-control-height, 36px); height: var(--hira-control-height, 36px);
      padding: 0; cursor: pointer;
      color: var(--hira-text-secondary, #6b7280);
      transition: color var(--hira-dur-fast, 120ms) var(--hira-ease-standard, ease),
                  background var(--hira-dur-fast, 120ms) var(--hira-ease-standard, ease);
    }
    .history-panel__actions button:hover:not(:disabled) { color: var(--hira-text-primary, #1a1a1a); background: var(--hira-surface-soft, rgba(0,0,0,0.05)); }
    .history-panel__actions button:disabled { opacity: 0.4; cursor: default; }
    .history-panel__actions .history-panel__danger:hover { color: var(--hira-danger, #dc2626); background: var(--hira-danger-bg, rgba(220,38,38,0.08)); }
    .history-panel__actions.history-panel__actions--text { gap: 6px; }
    .history-panel__actions .history-panel__text-action {
      width: auto;
      min-width: 0;
      height: 28px;
      padding: 0 8px;
      font: inherit;
      font-size: 11px;
      white-space: nowrap;
    }
    .history-panel__group-label {
      display: flex; align-items: center; gap: 8px;
      padding: 12px 10px 4px; font-size: 11px; font-weight: 600;
      color: var(--hira-text-tertiary, #8b8b8b); letter-spacing: 0.02em;
    }
    .history-panel__group-label::after { content: none; }
    .history-panel__empty {
      padding: 48px 20px; text-align: center;
      color: var(--hira-text-tertiary, #8b8b8b); font-size: 12px; line-height: 19px;
    }
    .history-panel__row {
      display: flex; align-items: center; gap: 10px;
      padding: 6px 10px; min-height: var(--hira-row-height, 36px);
      box-sizing: border-box;
      border-radius: var(--hira-radius-md, 10px);
      cursor: pointer;
      transition: background var(--hira-dur-fast, 120ms) var(--hira-ease-standard, ease);
      contain: layout style;
    }
    .history-panel__row:hover { background: var(--hira-hover-bg, rgba(0,0,0,0.05)); }
    /* 拖拽源：半透明 + 复制光标（拖出去是"再取一份"，不是移动） */
    .history-panel__row.is-dragging { opacity: 0.45; }
    .history-panel__check { margin: 0; flex-shrink: 0; cursor: pointer; }
    .history-panel__btn {
      width: 26px; height: 26px; border: none; background: transparent;
      color: var(--hira-text-tertiary, #8b8b8b); cursor: pointer;
      border-radius: var(--hira-radius-xs, 6px); font-size: 12px; flex-shrink: 0;
      display: flex; align-items: center; justify-content: center;
      transition: background var(--hira-dur-fast, 120ms) var(--hira-ease-standard, ease),
                  color var(--hira-dur-fast, 120ms) var(--hira-ease-standard, ease);
      opacity: 0; visibility: hidden;
    }
    .history-panel__row:hover .history-panel__btn { opacity: 1; visibility: visible; }
    .history-panel__row:hover .history-panel__btn:hover { background: var(--hira-surface-soft, rgba(0,0,0,0.06)); color: var(--hira-text-primary, #1a1a1a); }
  `
  doc.head.appendChild(style)
}

/**
 * 「最近关闭」列表的**唯一实现**（历史面板 / 聚合总览共用）。
 *
 * 为什么抽出来：这一行的长相与行为（favicon + 标题/网址、点击即恢复、可拖到集锦/画板/
 * 书签栏）原先只有历史面板一处。聚合总览的「最近关闭」块也要同一份 —— 复制就是两条
 * 会各自漂移的实现。抽成组件后两处共用同一套 class，`injectHistoryPanelStyles` 一份
 * 样式同时管住两处。
 *
 * 哑件：不持数据、不发 IPC —— 点击经 onIntent({ type: 'recent-restore', index }) 上行。
 * `index` 优先取 `item.restoreIndex`（聚合总览会把它归一成**撤销栈下标**，见渲染层）；
 * 缺省时退回数组下标（历史面板自己的口径）。
 *
 * @param {Document} doc
 * @param {PanelContext} [ctx]
 * @returns {{ element: HTMLElement, setItems: (items: readonly RecentListItem[]|null) => void }}
 */
export function createRecentList(doc: Document, ctx: PanelContext = {}) : { element: HTMLElement, setItems: (items: readonly RecentListItem[]|null) => void } {
  const recentCtx = ctx as HistoryPanelContext & { emptyText?: string }
  const onIntent = typeof recentCtx.onIntent === 'function' ? recentCtx.onIntent : () => {}
  const emptyText = typeof recentCtx.emptyText === 'string' ? recentCtx.emptyText : '暂无最近关闭的标签页'

  const list = doc.createElement('div')
  list.className = 'history-panel__list'
  /** 本组件只认「列表」：null 与空数组都画空态，不做加载态（数据由宿主决定何时给）。 */
  let items: RecentListItem[] = []

  function render() {
    list.textContent = ''
    if (!items.length) {
      const tip = doc.createElement('div')
      tip.className = 'history-panel__empty'
      tip.textContent = emptyText
      list.appendChild(tip)
      return
    }
    const frag = doc.createDocumentFragment()
    items.forEach((item, index) => {
      const row = doc.createElement('div')
      row.className = 'history-panel__row'
      row.setAttribute('data-recent-index', String(item && item.restoreIndex != null ? item.restoreIndex : index))
      row.title = (item && item.url) || ''
      makeRowDraggable(row, item)
      // 同历史行：favicon 失败降级首字母徽标。
      row.appendChild(createFaviconBadge(doc, item.favicon, item.title || item.url, 16, item.url))
      const main = doc.createElement('div')
      main.className = 'history-panel__row-main'
      const title = doc.createElement('span')
      title.className = 'history-panel__row-title'
      title.textContent = item.title || item.url || '(无标题)'
      const url = doc.createElement('span')
      url.className = 'history-panel__row-url'
      url.textContent = item.url || ''
      main.append(title, url)
      row.appendChild(main)
      frag.appendChild(row)
    })
    list.appendChild(frag)
  }

  // 行点击 = 恢复该标签（index 口径与撤销栈一致：0 = 最近关闭在前）。
  list.addEventListener('click', (e: MouseEvent) => {
    const target = e.target instanceof Element ? e.target : null
    const row = target?.closest<HTMLElement>('[data-recent-index]')
    if (!row) return
    onIntent({ type: 'recent-restore', index: Number(row.getAttribute('data-recent-index')) })
  })

  function setItems(next: readonly RecentListItem[] | null) {
    items = Array.isArray(next) ? next.slice() : []
    render()
  }

  return { element: list, setItems }
}

/**
 * @param {Document} doc
 * @param {HistoryPanelContext} [ctx] 面板宿主端口
 *   历史面板（`menu`）
 * @returns {{
 *   element: HTMLDivElement,
 *   setItems: (items: readonly HistoryListItem[]) => void,
 *   setRecentItems: (items: readonly RecentListItem[]|null) => void,
 *   refresh: () => Promise<void>,
 *   focusSearch: () => boolean,
 *   dispose: () => void
 * }}
 */
export function createHistoryPanel(doc: Document, ctx: PanelContext = {}) : {
  element: HTMLDivElement,
  setItems: (items: readonly HistoryListItem[]) => void,
  setRecentItems: (items: readonly RecentListItem[]|null) => void,
  refresh: () => Promise<void>,
  focusSearch: () => boolean,
  dispose: () => void
} {
  const panelCtx = ctx as HistoryPanelContext
  const onIntent = typeof panelCtx.onIntent === 'function' ? panelCtx.onIntent : () => {}
  const menuClient = panelCtx.menu || null

  let active: SegmentName = DEFAULT_HISTORY_VIEW_MODE
  let disposed = false

  const wrap = doc.createElement('div')
  wrap.className = 'history-panel__wrap'

  // ── 分段栏：历史 / 最近关闭 ──
  const segBar = doc.createElement('div')
  segBar.className = 'history-panel__seg'
  segBar.setAttribute('role', 'tablist')
  const segTabs = {} as Record<SegmentName, HTMLButtonElement>
  for (const segment of SEGMENTS) {
    const tab = doc.createElement('button')
    tab.type = 'button'
    tab.className = 'history-panel__seg-tab'
    tab.setAttribute('role', 'tab')
    tab.setAttribute('aria-selected', segment.key === active ? 'true' : 'false')
    tab.textContent = segment.label
    tab.addEventListener('click', () => switchSegment(segment.key))
    segTabs[segment.key] = tab
    segBar.appendChild(tab)
  }
  wrap.appendChild(segBar)

  // ── 视图一：历史（搜索 + 批量操作 + 按日期分组的列表） ──
  const historyView = doc.createElement('div')
  historyView.className = 'history-panel__view'
  historyView.setAttribute('role', 'tabpanel')

  // ── 工具栏：搜索 + 批量操作 ──
  const toolbar = doc.createElement('div')
  toolbar.className = 'history-panel__toolbar'

  const searchBox = doc.createElement('div')
  searchBox.className = 'history-panel__search'
  const searchIcon = doc.createElement('span')
  searchIcon.appendChild(Search(doc, { size: 15 }))
  searchIcon.style.cssText = 'display:flex; align-items:center; color: var(--hira-text-secondary,#6b7280); flex-shrink:0;'
  const searchInput = doc.createElement('input')
  searchInput.type = 'text'
  searchInput.placeholder = '搜索历史…'
  searchBox.append(searchIcon, searchInput)

  // 工具栏是「手动刷新」的唯一入口：历史数据不再跟随事件自动重拉（避免
  // 高写入频率下的抖动 / 重复渲染），用户点一下即拿到最新快照。
  const actions = doc.createElement('div')
  actions.className = 'history-panel__actions'
  const refreshHistory = doc.createElement('button')
  refreshHistory.type = 'button'
  refreshHistory.className = 'history-panel__refresh'
  refreshHistory.title = '刷新历史'
  refreshHistory.setAttribute('aria-label', '刷新历史')
  refreshHistory.appendChild(RefreshCw(doc, { size: 16 }))
  const selectAll = doc.createElement('button')
  selectAll.title = '全选'
  selectAll.setAttribute('aria-label', '全选')
  selectAll.appendChild(Check(doc, { size: 16 }))
  const deleteSelected = doc.createElement('button')
  deleteSelected.title = '删除所选中项的历史记录'
  deleteSelected.setAttribute('aria-label', deleteSelected.title)
  deleteSelected.appendChild(Trash2(doc, { size: 16 }))
  deleteSelected.disabled = true
  const clearAll = doc.createElement('button')
  clearAll.className = 'history-panel__danger'
  clearAll.title = '清空全部浏览数据'
  clearAll.setAttribute('aria-label', clearAll.title)
  clearAll.appendChild(Eraser(doc, { size: 16 }))
  actions.append(refreshHistory, selectAll, deleteSelected, clearAll)

  toolbar.append(searchBox, actions)
  historyView.appendChild(toolbar)

  // 行件与聚合总览共用同一份实现（grouped / selectable 由组件统一管理）。
  const historyList = createHistoryList(doc, {
    onIntent,
    grouped: true,
    selectable: true,
    emptyText: () => (searchInput.value.trim() ? '没有匹配的历史记录' : '尚无历史记录'),
    // 唯一的选中态出口：工具栏的「删除所选」跟着它亮/灭（不再多留一份 syncActionState）。
    onSelectionChange: (count: number) => { deleteSelected.disabled = count === 0 },
    // 有菜单端口才接管右键；否则列表件保留「右键 = 切复选」的旧行为。
    onContextMenu: menuClient ? (item: HistoryListItem, x: number, y: number) => showHistoryContextMenu(item, x, y) : undefined
  })
  historyView.appendChild(historyList.element)
  wrap.appendChild(historyView)

  /**
   * 历史行右键菜单。
   *
   * 宿主只放**历史自己的动作**；AI 等插件贡献项由主进程按
   * `context.kind = 'history'` 追加到菜单尾部（见 ipc/window.js#MENU_SLOT_BY_KIND），
   * 因此本文件不认识任何插件。
   * @param {HistoryListItem} item
   * @param {number} x
   * @param {number} y
   */
  function showHistoryContextMenu(item: HistoryListItem, x: number, y: number) {
    if (!menuClient || !item || !item.url) return
    const id = item.id != null ? String(item.id) : ''
    const url = String(item.url)
    const title = item.title || ''
    menuClient.popupMenu({
      items: [
        { label: '打开', action: 'open' },
        { label: '在侧栏打开', action: 'open-sidebar' },
        { type: 'separator', action: null },
        { label: '复制链接', action: 'copy-url' },
        { type: 'separator', action: null },
        { label: '删除这条记录', action: 'remove' }
      ],
      x,
      y,
      context: { kind: 'history', snapshot: { id, url, title } }
    }).then((act) => {
      if (!act) return
      if (act === 'open') onIntent({ type: 'navigate', url, title })
      else if (act === 'open-sidebar') onIntent({ type: 'navigate', url, title, modifiers: { shiftKey: false, ctrlKey: false, metaKey: false, altKey: true } })
      else if (act === 'copy-url') navigator.clipboard.writeText(url).catch(() => {})
      else if (act === 'remove' && id) onIntent({ type: 'remove', id, url })
    }).catch(() => {})
  }

  // ── 视图二：最近关闭（撤销栈的只读镜像；点击即恢复） ──
  // 数据由宿主经 ctx.clients.tabs 拉取后 setRecentItems() 上行；
  // 本视图不发任何会改动历史的意图（删除/清空历史与它无关）。
  const recentView = doc.createElement('div')
  recentView.className = 'history-panel__view'
  recentView.setAttribute('role', 'tabpanel')
  recentView.hidden = true

  const recentToolbar = doc.createElement('div')
  recentToolbar.className = 'history-panel__recent-toolbar'
  const recentHint = doc.createElement('span')
  recentHint.className = 'history-panel__hint'
  recentHint.textContent = '点击任一项即可重新打开'
  const recentActions = doc.createElement('div')
  recentActions.className = 'history-panel__actions'
  const recentRefresh = doc.createElement('button')
  recentRefresh.type = 'button'
  recentRefresh.className = 'history-panel__refresh'
  recentRefresh.title = '刷新最近关闭'
  recentRefresh.setAttribute('aria-label', '刷新最近关闭')
  recentRefresh.appendChild(RefreshCw(doc, { size: 16 }))
  recentRefresh.addEventListener('click', () => onIntent({ type: 'recent-refresh' }))
  const recentClear = doc.createElement('button')
  recentClear.type = 'button'
  recentClear.className = 'history-panel__danger'
  recentClear.title = '清空最近关闭列表'
  recentClear.setAttribute('aria-label', recentClear.title)
  recentClear.appendChild(Eraser(doc, { size: 16 }))
  recentClear.disabled = true
  recentClear.addEventListener('click', () => onIntent({ type: 'recent-clear' }))
  recentActions.append(recentRefresh, recentClear)
  recentToolbar.append(recentHint, recentActions)

  // 行 = 共用件（与聚合总览同一份），面板只留工具栏与清空按钮。
  const recentList = createRecentList(doc, { onIntent })

  recentView.append(recentToolbar, recentList.element)
  wrap.appendChild(recentView)

  /** 「最近关闭」数据：null = 尚未加载（首次切过去会触发拉取）。 */
  let recentItems: RecentListItem[] | null = null

  /** 分段 → 视图宿主的唯一映射（切段只翻 `hidden`，不重建 DOM）。 */
  const viewHosts: Record<SegmentName, HTMLDivElement> = {
    history: historyView,
    recent: recentView
  }

  /**
   * 切段（纯视图态：不写设置，所以每次打开面板都从「历史」开始）。
   * @param {string} name
   */
  function switchSegment(name: string) {
    if (disposed) return
    const next = SEGMENTS.some((s) => s.key === name) ? name as SegmentName : DEFAULT_HISTORY_VIEW_MODE as SegmentName
    const changed = next !== active
    active = next
    for (const segment of SEGMENTS) {
      segTabs[segment.key].setAttribute('aria-selected', segment.key === next ? 'true' : 'false')
      viewHosts[segment.key].hidden = segment.key !== next
    }
    // 切过去才拉 —— 绝大多数会话根本不看这一栏，不为它付一次 IPC。
    if (next === 'recent' && changed) onIntent({ type: 'recent-refresh' })
  }

  /**
   * 状态上行：写入「最近关闭」列表（宿主拉取后调用）。
   * @param {readonly RecentListItem[]|null} next
   */
  function setRecentItems(next: readonly RecentListItem[] | null) {
    recentItems = Array.isArray(next) ? next.slice() : []
    recentClear.disabled = recentItems.length === 0
    recentList.setItems(recentItems)
  }

  // ── 工具栏动作：全部转成列表件的公开方法，面板本身不重复实现选中规则 ──
  let debounceTimer: ReturnType<typeof setTimeout> | null = null
  searchInput.addEventListener('input', () => {
    if (debounceTimer) clearTimeout(debounceTimer)
    const query = searchInput.value.trim()
    debounceTimer = setTimeout(() => { onIntent({ type: 'search', query }) }, 250)
  })

  refreshHistory.addEventListener('click', () => onIntent({ type: 'refresh' }))

  selectAll.addEventListener('click', () => historyList.toggleSelectAll())

  deleteSelected.addEventListener('click', () => {
    const ids = historyList.selectedIds()
    if (ids.length === 0) return
    historyList.clearSelection()
    onIntent({ type: 'remove-many', ids })
  })

  clearAll.addEventListener('click', () => onIntent({ type: 'clear' }))

  // 启动：直接装默认段（「历史」）—— 不读任何持久化偏好。
  switchSegment(active)

  return {
    element: wrap,
    setItems: historyList.setItems,
    setRecentItems,
    /** 本面板的数据全部由宿主推（history / recent）；宿主换 profile 时统一重推，无需自刷。 */
    refresh() {
      return Promise.resolve()
    },
    focusSearch() {
      if (active !== 'history') return false
      searchInput.focus()
      return true
    },
    dispose() {
      disposed = true
      if (debounceTimer) clearTimeout(debounceTimer)
      wrap.remove()
    }
  }
}

/** 面板插件定义（宿主按约定发现并挂载；端口由 ctx 注入）。 */
export const panelDefinition: PanelDefinition = {
  id: 'history-panel',
  injectStyles: injectHistoryPanelStyles,

  mount(doc, ctx) {
    const panelCtx = ctx as HistoryPanelContext
    const { clients, bridge, confirm, menu } = panelCtx
    const tabsClient = clients?.tabs
    if (!tabsClient || !bridge) throw new Error('history panel requires bridge and tabs client')
    const historyTabs = tabsClient
    const historyBridge = bridge

    /** 「最近关闭」是否已经加载过 —— 换 profile 时只重拉用户真看过的数据。 */
    let recentLoaded = false

    const panel = createHistoryPanel(doc, {
      clients,
      bridge,
      confirm,
      menu,
      onIntent({ type, url, title, id, ids, query, index, modifiers }: HistoryPanelIntent) {
        // 面板去向规则唯一一份（ui-common#panel-open）：默认新开标签，**Alt = 独立侧栏**。
        if (type === 'navigate' && url) {
          openPanelTarget(resolvePanelOpenTarget(modifiers), {
            url,
            title,
            openTab: (u) => historyTabs.newTab({ url: u }),
            openSidebar: (u, t) => historyBridge.provider.invoke('web-sidebar:open', { url: u, title: t }).catch(() => {})
          })
        }
        else if (type === 'search') {
          const normalizedQuery = query?.trim()
          const invoke = normalizedQuery
            ? historyBridge.provider.invoke('history:search', { query: normalizedQuery, limit: 300 })
            : historyBridge.provider.invoke('history:list', {})
          invoke.then((items) => panel.setItems(Array.isArray(items) ? items as HistoryListItem[] : [])).catch(() => {})
        } else if (type === 'remove' && id != null) {
          historyBridge.provider.invoke('history:remove', { id }).then(refreshHistory).catch(() => {})
        } else if (type === 'remove-many' && Array.isArray(ids) && ids.length) {
          historyBridge.provider.invoke('history:remove-many', { ids }).then(refreshHistory).catch(() => {})
        } else if (type === 'clear') {
          historyBridge.provider.invoke('history:clear', {}).then(refreshHistory).catch(() => {})
        } else if (type === 'refresh') {
          // 手动刷新（工具栏按钮）：历史数据不再订阅 historyChanged 自动重拉。
          refreshHistory().catch(() => {})
        } else if (type === 'recent-refresh') {
          loadRecent()
        } else if (type === 'recent-restore' && typeof index === 'number' && Number.isInteger(index) && index >= 0) {
          // 成功/失败都重拉：恢复会让该项出栈，失败则回到真实状态（不做乐观删除）。
          historyTabs.restoreRecentlyClosed(index).then(loadRecent, loadRecent)
        } else if (type === 'recent-clear') {
          Promise.resolve(confirm ? confirm({
            title: '清空最近关闭',
            message: '确定清空最近关闭的标签页列表吗？'
          }) : true).then((ok) => {
            if (ok) historyTabs.clearRecentlyClosed().then(loadRecent, loadRecent)
          })
        }
      }
    })

    async function loadRecent() {
      try {
        const res = await historyTabs.recentlyClosed()
        recentLoaded = true
        panel.setRecentItems(res?.tabs || [])
      } catch (_) {
        recentLoaded = true
        panel.setRecentItems([])
      }
    }

    async function refreshHistory() {
        const items = await historyBridge.provider.invoke('history:list', {})
        panel.setItems(Array.isArray(items) ? items as HistoryListItem[] : [])
    }

    async function refresh() {
      // 换 profile 时宿主统一调它：历史必刷；「最近关闭」只在用户翻过它时才刷
      // （不替用户付一次没人看的 IPC）。
      const jobs = [refreshHistory()]
      if (recentLoaded) jobs.push(loadRecent())
      await Promise.all(jobs)
      await panel.refresh()
    }

    // 首次装配只拉历史；其它分段在切过去时按需拉取。
    refreshHistory().catch(() => {})

    return {
      element: panel.element,
      refresh,
      focusSearch: () => panel.focusSearch(),
      dispose: () => panel.dispose()
    }
  }
}
