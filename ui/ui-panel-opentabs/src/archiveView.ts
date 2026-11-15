// @ts-check
/**
 * 标签面板的「归档」分段 —— 只管理被收起的标签。
 *
 * 它原先是独立面板 `ui-panel-archive`；IA 归并后先并入「历史」面板，
 * 再随「归档 = 被我主动收起来的标签」这一语义搬到「标签」面板，作为第三分段。
 * 归并的理由：归档的对象就是**标签**（右键归档 / 自动归档长期未用的标签），
 * 与「打开中 / 已固定」回答的是同一族问题（"我的标签都去哪了"）。
 *
 * ── 数据与语义 ──────────────────────────────────────────────────────────
 * 离线页面归档属于集锦内容，已统一放在「集锦 → 页面归档」文件夹。
 *
 * ── 解耦 ────────────────────────────────────────────────────────────────
 * 读写只走设置项与 `clients.tabs.newTab`；记录形状由纯层 `archive-list` 决定。
 * 本视图是哑组件，由分段壳（index.js）决定何时装配 / 销毁。
 */

import type { PanelContext } from '@hira-ng/ui-common'
import {
  injectPanelStyles,
  createFaviconBadge,
  iconByName,
  resolvePanelOpenTarget,
  openPanelTarget
} from '@hira-ng/ui-common'
import { parseArchive, serializeArchive, removeArchiveEntry, ARCHIVE_SETTING_KEY } from '@hira-ng/shared-types/src/archive-list.mjs'
import type { ArchiveEntry } from '@hira-ng/shared-types/src/archive-list.mjs'
// 日期分段与相对时间的唯一真源（与历史 / 会话面板共用一份口径）。
import { dateBucketLabel, dateBucketOf, formatRelativeStamp } from '@hira-ng/shared-types/src/date-display.mjs'

const ENTRIES_KEY = ARCHIVE_SETTING_KEY
const STYLE_ID = 'hira-archive-view-styles'

interface ArchiveSettingsPort {
  get(key: string): Promise<unknown>
  set(key: string, value: unknown): Promise<unknown>
}

interface ArchiveTabsPort {
  newTab(input: { url: string }): Promise<unknown>
}

interface ArchiveBridge {
  provider: { invoke(route: string, payload?: unknown): Promise<unknown> }
}

type ArchiveViewContext = Omit<PanelContext, 'clients' | 'bridge' | 'confirm' | 'on'> & {
  clients?: (PanelContext['clients'] & { settings?: ArchiveSettingsPort; tabs?: ArchiveTabsPort }) | null
  bridge?: ArchiveBridge
  confirm?: (options: { title?: string; message?: string }) => Promise<boolean> | boolean
  events?: { settingsChanged?: string }
  on?: (route: string, listener: (payload: unknown) => void) => (() => void) | void
}

export function injectArchiveViewStyles(doc: Document): void {
  injectPanelStyles(doc)
  if (doc.getElementById(STYLE_ID)) return
  const style = doc.createElement('style')
  style.id = STYLE_ID
  style.textContent = `
    .archive-view { display: flex; flex-direction: column; height: 100%; min-height: 0; }
    .archive-view__toolbar {
      display: flex; flex-direction: column; gap: 8px; flex-shrink: 0;
      padding: 0 0 8px; margin-bottom: 4px;
    }
    .archive-view__search {
      display: flex; align-items: center; gap: 8px;
      height: var(--hira-control-height, 32px); box-sizing: border-box;
      padding: 0 12px; border-radius: var(--hira-radius-md, 10px);
      background: var(--hira-field-bg, rgba(0,0,0,0.04));
      border: 0;
      transition: background var(--hira-dur-fast, 120ms) var(--hira-ease-standard, ease),
                  box-shadow var(--hira-dur-fast, 120ms) var(--hira-ease-standard, ease);
    }
    .archive-view__search:focus-within {
      background: var(--hira-field-bg-focus, rgba(0,0,0,0.05));
      box-shadow: var(--hira-focus-ring, 0 0 0 2px rgba(59,130,246,0.35));
    }
    .archive-view__search-icon { color: var(--hira-text-tertiary, #8b8b8b); font-size: 12px; line-height: 1; }
    .archive-view__search input {
      flex: 1; min-width: 0; border: none; outline: none; background: transparent;
      color: var(--hira-text-primary, #1a1a1a); font-size: 12px; padding: 0;
      font-family: inherit;
    }
    .archive-view__search input::placeholder { color: var(--hira-text-tertiary, #8b8b8b); }
    .archive-view__actions { display: flex; gap: 2px; align-items: center; }
    .archive-view__hint {
      margin-right: auto; font-size: 11px; white-space: nowrap; user-select: none;
      color: var(--hira-text-tertiary, #8b8b8b);
    }
    .archive-view__actions button {
      border: 0; background: transparent;
      display: inline-flex; align-items: center; justify-content: center;
      border-radius: var(--hira-radius-sm, 8px);
      width: var(--hira-control-height, 36px); height: var(--hira-control-height, 36px); padding: 0;
      cursor: pointer; font-family: inherit;
      color: var(--hira-text-secondary, #6b7280);
      transition: color var(--hira-dur-fast, 120ms) var(--hira-ease-standard, ease),
                  background var(--hira-dur-fast, 120ms) var(--hira-ease-standard, ease);
    }
    .archive-view__actions button:hover:not(:disabled) {
      color: var(--hira-text-primary, #1a1a1a); background: var(--hira-surface-soft, rgba(0,0,0,0.05));
    }
    .archive-view__actions button:disabled { opacity: 0.4; cursor: default; }
    .archive-view__actions .archive-view__danger:hover:not(:disabled) {
      color: var(--hira-danger, #dc2626);
      background: var(--hira-danger-bg, rgba(220,38,38,0.08));
    }
    .archive-view__status {
      margin: 0 0 8px;
      padding: 8px 10px;
      border-radius: var(--hira-radius-sm, 8px);
      background: var(--hira-surface-soft, rgba(0,0,0,.05));
      color: var(--hira-text-secondary, #6b7280);
      font-size: 11.5px;
      line-height: 17px;
    }
    .archive-view__status[hidden] { display: none; }
    .archive-view__status[data-error="true"] {
      color: var(--hira-danger, #dc2626);
      background: var(--hira-danger-bg, rgba(220,38,38,0.08));
    }
    .archive-view__list { flex: 1; min-height: 0; overflow-y: auto; padding-bottom: 8px; }
    .archive-view__group-label {
      display: flex; align-items: center; gap: 6px;
      padding: 10px 8px 4px; font-size: 11px; font-weight: 500;
      color: var(--hira-text-tertiary, #8b8b8b); letter-spacing: 0.02em;
    }
    .archive-view__empty {
      padding: 48px 20px; text-align: center;
      color: var(--hira-text-tertiary, #8b8b8b); font-size: 12px; line-height: 19px;
    }
    .archive-view__row {
      display: flex; align-items: center; gap: 8px;
      /* 与标签行 / tabbar 同一套行几何（高 32 / 圆角 9 / 纵向内距 0 起步）：
         本行是**两行文本**（标题 + URL），撑高来自内容本身，不再额外加厚。 */
      padding: 4px 10px; min-height: var(--ng-tab-height, 32px); box-sizing: border-box;
      border-radius: var(--ng-tab-radius, 9px);
      cursor: pointer;
      transition: background var(--hira-dur-fast, 120ms) var(--hira-ease-standard, ease);
      contain: layout style;
    }
    .archive-view__row:hover { background: var(--hira-hover-bg, rgba(0,0,0,0.06)); }
    .archive-view__main { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 1px; }
    .archive-view__title {
      font-size: 12px; font-weight: 500; line-height: 17px; color: var(--hira-text-primary, #1a1a1a);
      overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
    }
    .archive-view__url {
      font-size: 10.5px; line-height: 14px; color: var(--hira-text-tertiary, #8b8b8b);
      overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
    }
    .archive-view__when {
      flex-shrink: 0; font-size: 10.5px; white-space: nowrap;
      color: var(--hira-text-tertiary, #8b8b8b);
    }
    .archive-view__btn {
      width: 24px; height: 24px; flex-shrink: 0; border: 0; background: transparent;
      color: var(--hira-text-tertiary, #8b8b8b); cursor: pointer;
      border-radius: var(--hira-radius-xs, 6px);
      display: flex; align-items: center; justify-content: center;
      transition: background var(--hira-dur-fast, 120ms) var(--hira-ease-standard, ease),
                  color var(--hira-dur-fast, 120ms) var(--hira-ease-standard, ease);
      opacity: 0; visibility: hidden;
    }
    .archive-view__row:hover .archive-view__btn { opacity: 1; visibility: visible; }
    .archive-view__row:hover .archive-view__btn:hover {
      background: var(--hira-surface-soft, rgba(0,0,0,0.06));
      color: var(--hira-text-primary, #1a1a1a);
    }
  `
  doc.head.appendChild(style)
}

/**
 * @param {Document} doc
 * @param {ArchiveViewContext} [ctx] 面板宿主端口（clients.settings / clients.tabs / bridge / confirm / on / events）
 * @returns {{ element: HTMLElement, refresh: () => Promise<void>, focusSearch: () => boolean, dispose: () => void }}
 */
export function createArchiveView(doc: Document, ctx: PanelContext = {}) : { element: HTMLElement, refresh: () => Promise<void>, focusSearch: () => boolean, dispose: () => void } {
  injectArchiveViewStyles(doc)

  const viewCtx = ctx as ArchiveViewContext
  const settings = viewCtx.clients?.settings || null
  const tabs = viewCtx.clients?.tabs || null
  const confirmFn = typeof viewCtx.confirm === 'function' ? viewCtx.confirm : null
  const bridge = viewCtx.bridge || null

  let disposed = false
  let entries: ArchiveEntry[] = []
  /** 搜索串（≤100 条，本地过滤即可，不做防抖/不做 IPC）。 */
  let query = ''

  const root = doc.createElement('div')
  root.className = 'archive-view'

  const toolbar = doc.createElement('div')
  toolbar.className = 'archive-view__toolbar'

  const searchBox = doc.createElement('div')
  searchBox.className = 'archive-view__search'
  const searchIcon = doc.createElement('span')
  searchIcon.className = 'archive-view__search-icon'
  const searchIconNode = iconByName('Search', doc, { size: 15 })
  if (searchIconNode) searchIcon.appendChild(searchIconNode)
  const searchInput = doc.createElement('input')
  searchInput.type = 'text'
  searchInput.placeholder = '搜索归档…'
  searchInput.setAttribute('aria-label', '搜索归档')
  searchBox.append(searchIcon, searchInput)

  const actions = doc.createElement('div')
  actions.className = 'archive-view__actions'
  const countLabel = doc.createElement('span')
  countLabel.className = 'archive-view__hint'
  const restoreAllBtn = doc.createElement('button')
  restoreAllBtn.type = 'button'
  restoreAllBtn.title = '重新打开当前列表里的全部归档页面'
  restoreAllBtn.setAttribute('aria-label', restoreAllBtn.title)
  const restoreIcon = iconByName('Undo2', doc, { size: 16 })
  if (restoreIcon) restoreAllBtn.appendChild(restoreIcon)
  const refreshBtn = doc.createElement('button')
  refreshBtn.type = 'button'
  refreshBtn.title = '重新读取归档记录'
  refreshBtn.setAttribute('aria-label', refreshBtn.title)
  const refreshIcon = iconByName('RefreshCw', doc, { size: 16 })
  if (refreshIcon) refreshBtn.appendChild(refreshIcon)
  const clearBtn = doc.createElement('button')
  clearBtn.type = 'button'
  clearBtn.className = 'archive-view__danger'
  clearBtn.title = '永久删除全部归档记录'
  clearBtn.setAttribute('aria-label', clearBtn.title)
  const clearIcon = iconByName('Trash2', doc, { size: 16 })
  if (clearIcon) clearBtn.appendChild(clearIcon)
  actions.append(countLabel, restoreAllBtn, refreshBtn, clearBtn)

  toolbar.append(searchBox, actions)

  const statusLabel = doc.createElement('div')
  statusLabel.className = 'archive-view__status'
  statusLabel.setAttribute('role', 'status')
  statusLabel.setAttribute('aria-live', 'polite')
  statusLabel.hidden = true

  const list = doc.createElement('div')
  list.className = 'archive-view__list'

  root.append(toolbar, statusLabel, list)

  let statusTimer = 0
  function showStatus(message: string, error = false): void {
    window.clearTimeout(statusTimer)
    statusLabel.textContent = message
    statusLabel.dataset.error = String(error)
    statusLabel.hidden = !message
    if (message && !error) {
      statusTimer = window.setTimeout(() => {
        if (!disposed) statusLabel.hidden = true
      }, 5000)
    }
  }

  /** 当前查询命中的条目（保持"新的在前"）。 */
  function visibleEntries() {
    const q = query.trim().toLowerCase()
    const sorted = entries.slice().sort((a, b) => (b.archivedAt || 0) - (a.archivedAt || 0))
    if (!q) return sorted
    return sorted.filter((e) => String(e.title || '').toLowerCase().includes(q) ||
      String(e.url || '').toLowerCase().includes(q))
  }

  function renderEmpty(text: string) {
    const empty = doc.createElement('div')
    empty.className = 'archive-view__empty'
    empty.textContent = text
    list.appendChild(empty)
  }

  /**
   * 空态是本分段语义的**唯一说明处**：第一次进来的用户应该立刻知道
   * "怎么进来"（右键归档 / 自动归档）与"固定标签为什么不在里面"。
   */
  const EMPTY_TEXT = '归档区是空的。在标签上右键选择「归档标签」；离线网页请到集锦的「页面归档」。'
  const EMPTY_SEARCH = (q: string) => `没有匹配「${q}」的归档`

  function renderRow(entry: ArchiveEntry) {
    const row = doc.createElement('div')
    row.className = 'archive-view__row'
    row.setAttribute('data-archive-id', entry.id)
    row.title = `${entry.url}\n点击恢复（Alt = 在侧栏打开）`

    row.appendChild(createFaviconBadge(doc, entry.favicon, entry.title || entry.url, 16, entry.url))

    const main = doc.createElement('div')
    main.className = 'archive-view__main'
    const title = doc.createElement('span')
    title.className = 'archive-view__title'
    title.textContent = entry.title || entry.url || '(无标题)'
    const url = doc.createElement('span')
    url.className = 'archive-view__url'
    url.textContent = entry.url || ''
    main.append(title, url)
    row.appendChild(main)

    const when = doc.createElement('span')
    when.className = 'archive-view__when'
    when.textContent = formatRelativeStamp(entry.archivedAt)
    row.appendChild(when)

    const remove = doc.createElement('button')
    remove.type = 'button'
    remove.className = 'archive-view__btn'
    remove.title = '从归档区移除（不重新打开）'
    remove.setAttribute('aria-label', '从归档区移除')
    const xIcon = iconByName('X', doc, { size: 13 })
    if (xIcon) remove.appendChild(xIcon)
    else remove.textContent = '✕'
    remove.addEventListener('click', (e: MouseEvent) => {
      e.stopPropagation()
      removeEntry(entry.id)
    })
    row.appendChild(remove)

    row.addEventListener('click', (e: MouseEvent) => { void restoreEntry(entry, e) })
    return row
  }

  function render() {
    list.replaceChildren()
    const visibleTabs = visibleEntries()
    const q = query.trim()

    if (!visibleTabs.length) {
      renderEmpty(q ? EMPTY_SEARCH(q) : EMPTY_TEXT)
      updateToolbar()
      return
    }

    const frag = doc.createDocumentFragment()
    const now = Date.now()
    let currentKey: string | null = null
    for (const entry of visibleTabs) {
      const key = dateBucketOf(entry.archivedAt || 0, now)
      if (key !== currentKey) {
        currentKey = key
        const label = doc.createElement('div')
        label.className = 'archive-view__group-label'
        label.textContent = dateBucketLabel(key)
        frag.appendChild(label)
      }
      frag.appendChild(renderRow(entry))
    }
    list.appendChild(frag)
    updateToolbar()
  }

  /** 工具栏的**唯一状态出口**（数量文案 + 两个动作的可用性）。 */
  function updateToolbar() {
    const visibleTabs = visibleEntries()
    const total = entries.length
    if (!total) {
      countLabel.textContent = '归档区为空'
      countLabel.title = '还没有归档记录'
    } else if (query.trim()) {
      countLabel.textContent = `命中 ${visibleTabs.length} / ${total}`
      countLabel.title = `共 ${total} 条归档记录`
    } else {
      countLabel.textContent = `共 ${total} 条`
      countLabel.title = '归档标签会在这里保留，点击即可恢复'
    }
    restoreAllBtn.disabled = visibleTabs.length === 0
    clearBtn.disabled = entries.length === 0
    refreshBtn.disabled = false
  }

  async function readEntries() {
    if (!settings || typeof settings.get !== 'function') throw new Error('设置服务不可用')
    return parseArchive(await settings.get(ENTRIES_KEY))
  }

  async function writeEntries(next: readonly ArchiveEntry[]) {
    if (!settings || typeof settings.set !== 'function') return false
    try {
      await settings.set(ENTRIES_KEY, serializeArchive(next))
      return true
    } catch (_) {
      return false
    }
  }

  /** 从归档区移除一条（只删记录，不打开页面）。 */
  async function removeEntry(id: string) {
    entries = removeArchiveEntry(entries, id)
    render()
    await writeEntries(entries)
  }

  /** 恢复一条：默认新标签，Alt = 独立侧栏（与历史 / 收藏面板同一份去向规则）。 */
  async function openEntry(entry: ArchiveEntry, modifiers: { altKey?: boolean } = {}): Promise<void> {
    if (!entry.url) throw new Error('归档记录缺少网址')
    const target = resolvePanelOpenTarget(modifiers)
    if (resolvePanelOpenTarget(modifiers) === 'sidebar') {
      if (!bridge?.provider || typeof bridge.provider.invoke !== 'function') throw new Error('侧栏服务不可用')
      await bridge.provider.invoke('web-sidebar:open', { url: entry.url, title: entry.title })
      return
    }
    if (!tabs || typeof tabs.newTab !== 'function') throw new Error('标签服务不可用')
    await openPanelTarget(target, {
      url: entry.url,
      title: entry.title,
      openTab: (url) => tabs.newTab({ url }),
      openSidebar: (url, title) => bridge!.provider.invoke('web-sidebar:open', { url, title })
    })
  }

  async function restoreEntry(entry: ArchiveEntry, ev: MouseEvent): Promise<void> {
    try {
      await openEntry(entry, ev)
      await removeEntry(entry.id)
    } catch (error) {
      if (!disposed) showStatus(error instanceof Error ? error.message : '归档页面恢复失败', true)
    }
  }

  searchInput.addEventListener('input', () => {
    query = searchInput.value
    render()
  })

  refreshBtn.addEventListener('click', () => { refresh() })

  restoreAllBtn.addEventListener('click', async () => {
    const visible = visibleEntries()
    if (!visible.length) return
    const proceed = confirmFn
      ? Promise.resolve(confirmFn({
        title: '恢复全部归档',
        message: `将重新打开 ${visible.length} 个标签页，并从归档区移除这些记录。继续吗？`
      }))
      : Promise.resolve(true)
    const ok = await proceed
    if (!ok || disposed) return
    const restored: string[] = []
    for (const entry of visible) {
      try {
        await openEntry(entry)
        restored.push(entry.id)
      } catch (error) {
        showStatus(error instanceof Error ? error.message : `恢复“${entry.title || entry.url}”失败`, true)
      }
    }
    if (restored.length) {
      const removed = new Set(restored)
      entries = entries.filter((entry) => !removed.has(entry.id))
      render()
      if (!await writeEntries(entries)) showStatus('归档记录更新失败', true)
    }
  })

  clearBtn.addEventListener('click', async () => {
    if (!entries.length) return
    const proceed = confirmFn
      ? Promise.resolve(confirmFn({
        title: '清空归档标签',
        message: `确定清空 ${entries.length} 条归档标签记录吗？离线页面不会被删除。`
      }))
      : Promise.resolve(true)
    const ok = await proceed
    if (!ok || disposed) return
    entries = []
    render()
    if (!await writeEntries(entries)) showStatus('清空归档记录失败', true)
  })

  async function refresh() {
    try {
      entries = await readEntries()
      if (!disposed) render()
    } catch (error) {
      if (!disposed) showStatus(error instanceof Error ? error.message : '归档加载失败', true)
    }
  }

  refresh()

  /**
   * 归档动作会改设置 → 本视图自订阅，边看边更新。
   * 订阅的是**设置变化**而不是标签变化（归档记录与标签生命周期解耦，主进程只负责写）。
   */
  let unsubscribeSettings: (() => void) | null = null
  if (typeof viewCtx.on === 'function' && viewCtx.events && viewCtx.events.settingsChanged) {
    try {
      const unsubscribe = viewCtx.on(viewCtx.events.settingsChanged, (payload) => {
        const change = payload && typeof payload === 'object' ? payload as { key?: unknown; scope?: unknown } : null
        const key = change && typeof change.key === 'string' ? change.key : ''
        if (!change || change.scope === 'all' || key === ENTRIES_KEY) refresh()
      })
      if (typeof unsubscribe === 'function') unsubscribeSettings = unsubscribe
    } catch (_) {}
  }

  return {
    element: root,
    refresh,
    focusSearch() {
      searchInput.focus()
      return true
    },
    dispose() {
      disposed = true
      window.clearTimeout(statusTimer)
      unsubscribeSettings?.()
      unsubscribeSettings = null
      root.remove()
    }
  }
}
