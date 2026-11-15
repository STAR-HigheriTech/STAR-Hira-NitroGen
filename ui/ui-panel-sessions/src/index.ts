// @ts-check
/**
 * @hira-ng/ui-panel-sessions —— 会话面板（命名会话 + 自动快照）。
 *
 * ── 它取代了什么 ─────────────────────────────────────────────────────
 * 原来「会话」是一个 520×380 的独立子窗口（subwindow/windows/session-manager.js），
 * 只能做自动快照的保存 / 恢复 / 清除；命名会话只存在于内部页 `hira://sessions`。
 * 两处各说一半、样式两套。本面板把**两层会话能力收到同一处**：
 *   · 命名会话（N14）：起名保存当前标签集 → 列表 / 搜索 / 一键追加打开 / 删除；
 *   · 自动快照：底部常驻一条（当前标签数 + 保存 / 恢复 / 清除），即原窗口的全部能力。
 *
 * ── 为什么行件要单独导出 ──────────────────────────────────────────────
 * 聚合总览面板也要「会话」这一块，且要求与面板**同一套行**（用户口径：
 * 「学习对应的面板一模一样的样式、功能」）。于是行渲染抽成 `createSessionRows()`，
 * 总览以 `grouped: false` 复用它，样式由 `injectSessionsPanelStyles()` 一份注入。
 * 两处永远不会分叉。
 *
 * ── 解耦 ────────────────────────────────────────────────────────────
 * 本文件不认识 IPC、不认识主进程：读写全走注入的 `ctx.clients.sessions`
 * （端口在 `renderer/shared/session-client.js`），存储形状由主进程负责。
 * 「哪个会话、几个标签」全部来自端口返回值，这里不猜。
 */

import { injectPanelStyles, iconByName, createFaviconBadge } from '@hira-ng/ui-common'
import { NAMED_SESSIONS_SETTING_KEY } from '@hira-ng/shared-types/src/named-sessions.mjs'
// 日期分段与相对时间的唯一真源（与历史 / 归档面板共用一份口径）。
import { dateBucketLabel, dateBucketOf, formatRelativeStamp } from '@hira-ng/shared-types/src/date-display.mjs'

const STYLE_ID = 'hira-panel-sessions-styles'

/** 命名会话的存储键（设置项）—— 只用来判断「是不是我俩关心的事件」。 */
const NAMED_KEY = NAMED_SESSIONS_SETTING_KEY

interface SessionTabInfo {
  title?: string
  url?: string
  favicon?: string
  pinned?: boolean
}
interface NamedSessionInfo {
  id: string
  name: string
  tabs: SessionTabInfo[]
  createdAt: number
  [key: string]: unknown
}
interface SessionOperationResult { ok?: boolean; reason?: string; [key: string]: unknown }
interface SessionsClient {
  listNamed(): Promise<{ sessions?: NamedSessionInfo[] }>
  saveNamed(name: string): Promise<SessionOperationResult>
  restoreNamed(id: string): Promise<SessionOperationResult>
  removeNamed(id: string): Promise<SessionOperationResult>
  stats(): Promise<{ tabs?: number; pinned?: number; activeIndex?: number }>
  exists(): Promise<{ exists?: boolean }>
  lastClosed(): Promise<{ exists?: boolean; savedAt?: number; tabs?: number; pinned?: number; items?: SessionTabInfo[] }>
  save(): Promise<SessionOperationResult>
  restore(): Promise<SessionOperationResult>
  clear(): Promise<SessionOperationResult>
  restoreLastClosed(): Promise<SessionOperationResult>
  clearLastClosed(): Promise<SessionOperationResult>
}
type SessionIntent =
  | { type: 'session-remove' | 'session-restore'; id: string }
  | { type: 'search'; query?: string }
  | { type: 'session-save'; name?: string }
  | { type: 'snapshot-save' | 'snapshot-restore' | 'snapshot-clear' | 'last-closed-restore' | 'last-closed-clear' }
interface SessionRowsOptions {
  onIntent?: (intent: SessionIntent) => void
  grouped?: boolean
  emptyText?: string
}
interface SessionEventRoutes { settingsChanged?: string; tabChanged?: string }
interface SessionsPanelContext {
  clients?: { sessions?: SessionsClient | null } | null
  confirm?: (options: { title: string; message: string }) => boolean | Promise<boolean>
  on?: (route: string, handler: (payload?: unknown) => void) => () => void
  events?: SessionEventRoutes
}
interface SettingsChangePayload { key?: unknown; scope?: unknown }
interface SessionsPanelController {
  element: HTMLElement
  refresh(): Promise<void>
  setItems(items?: NamedSessionInfo[]): void
  focusSearch(): boolean
  dispose(): void
}

export function injectSessionsPanelStyles(doc: Document): void {
  injectPanelStyles(doc)
  if (doc.getElementById(STYLE_ID)) return
  const style = doc.createElement('style')
  style.id = STYLE_ID
  style.textContent = `
    .sessions-panel { display: flex; flex-direction: column; height: 100%; min-height: 0; }
    .sessions-panel__toolbar {
      display: flex; flex-direction: column; gap: 8px; flex-shrink: 0;
      padding: 2px 0 8px; margin-bottom: 4px;
    }
    /* 起名保存：输入条 + 主按钮同一行（这是本面板最高频的动作，给它第一行） */
    .sessions-panel__save { display: flex; gap: 8px; }
    .sessions-panel__input {
      flex: 1; min-width: 0; box-sizing: border-box;
      height: var(--hira-control-height, 32px); padding: 0 12px;
      border: 0; outline: none;
      border-radius: var(--hira-radius-md, 10px);
      background: var(--hira-field-bg, rgba(0,0,0,0.04));
      color: var(--hira-text-primary, #1a1a1a);
      font: inherit; font-size: 12px;
      transition: background var(--hira-dur-fast, 120ms) var(--hira-ease-standard, ease),
                  box-shadow var(--hira-dur-fast, 120ms) var(--hira-ease-standard, ease);
    }
    .sessions-panel__input:focus {
      background: var(--hira-field-bg-focus, rgba(0,0,0,0.05));
      box-shadow: var(--hira-focus-ring, 0 0 0 2px rgba(59,130,246,0.35));
    }
    .sessions-panel__input::placeholder { color: var(--hira-text-tertiary, #8b8b8b); }
    .sessions-panel__save-btn {
      flex: 0 0 auto; width: var(--hira-control-height, 36px); height: var(--hira-control-height, 36px);
      padding: 0;
      display: inline-flex; align-items: center; justify-content: center;
      border: 0; border-radius: var(--hira-radius-md, 10px);
      background: var(--hira-accent, #3b82f6); color: var(--hira-on-accent, #fff);
      font: inherit; font-size: 12px; font-weight: 600; cursor: pointer;
      transition: filter var(--hira-dur-fast, 120ms) var(--hira-ease-standard, ease),
                  opacity var(--hira-dur-fast, 120ms) var(--hira-ease-standard, ease);
    }
    .sessions-panel__save-btn:hover:not(:disabled) { filter: brightness(1.06); }
    .sessions-panel__save-btn:disabled { opacity: 0.45; cursor: default; }

    .sessions-panel__search {
      display: flex; align-items: center; gap: 8px;
      height: var(--hira-control-height, 32px); box-sizing: border-box;
      padding: 0 12px; border-radius: var(--hira-radius-md, 10px);
      background: var(--hira-field-bg, rgba(0,0,0,0.04));
      border: 0;
      transition: background var(--hira-dur-fast, 120ms) var(--hira-ease-standard, ease),
                  box-shadow var(--hira-dur-fast, 120ms) var(--hira-ease-standard, ease);
    }
    .sessions-panel__search:focus-within {
      background: var(--hira-field-bg-focus, rgba(0,0,0,0.05));
      box-shadow: var(--hira-focus-ring, 0 0 0 2px rgba(59,130,246,0.35));
    }
    .sessions-panel__search-icon { color: var(--hira-text-tertiary, #8b8b8b); font-size: 12px; line-height: 1; }
    .sessions-panel__search input {
      flex: 1; min-width: 0; border: none; outline: none; background: transparent;
      color: var(--hira-text-primary, #1a1a1a); font-size: 12px; padding: 0;
      font-family: inherit;
    }
    .sessions-panel__search input::placeholder { color: var(--hira-text-tertiary, #8b8b8b); }

    .sessions-panel__actions { display: flex; gap: 4px; align-items: center; }
    .sessions-panel__hint {
      margin-right: auto; font-size: 11px; white-space: nowrap; user-select: none;
      overflow: hidden; text-overflow: ellipsis;
      color: var(--hira-text-tertiary, #8b8b8b);
    }
    .sessions-panel__actions button {
      border: 0; background: transparent;
      display: inline-flex; align-items: center; justify-content: center;
      border-radius: var(--hira-radius-sm, 8px);
      width: var(--hira-control-height, 36px); height: var(--hira-control-height, 36px);
      padding: 0;
      cursor: pointer; font-family: inherit;
      color: var(--hira-text-secondary, #6b7280);
      transition: color var(--hira-dur-fast, 120ms) var(--hira-ease-standard, ease),
                  background var(--hira-dur-fast, 120ms) var(--hira-ease-standard, ease);
    }
    .sessions-panel__actions button:hover:not(:disabled) {
      color: var(--hira-text-primary, #1a1a1a); background: var(--hira-surface-soft, rgba(0,0,0,0.05));
    }
    .sessions-panel__actions button:disabled { opacity: 0.4; cursor: default; }

    .sessions-panel__list { flex: 1; min-height: 0; overflow-y: auto; padding-bottom: 8px; }
    .sessions-panel__group-label {
      display: flex; align-items: center; gap: 8px;
      padding: 12px 10px 4px; font-size: 11px; font-weight: 500;
      color: var(--hira-text-tertiary, #8b8b8b); letter-spacing: 0.02em;
    }
    .sessions-panel__empty {
      padding: 48px 20px; text-align: center;
      color: var(--hira-text-tertiary, #8b8b8b); font-size: 12px; line-height: 19px;
    }
    .sessions-panel__row {
      display: flex; align-items: center; gap: 10px;
      padding: 6px 10px; min-height: var(--hira-row-height, 36px); box-sizing: border-box;
      border-radius: var(--ng-tab-radius, 9px);
      cursor: pointer;
      transition: background var(--hira-dur-fast, 120ms) var(--hira-ease-standard, ease);
      contain: layout style;
    }
    .sessions-panel__row:hover { background: var(--hira-hover-bg, rgba(0,0,0,0.06)); }
    .sessions-panel__icon {
      flex: 0 0 16px; display: flex; align-items: center; justify-content: center;
      color: var(--hira-text-tertiary, #8b8b8b);
    }
    .sessions-panel__main { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 3px; }
    .sessions-panel__name {
      font-size: 12px; font-weight: 500; line-height: 18px; color: var(--hira-text-primary, #1a1a1a);
      overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
    }
    .sessions-panel__meta {
      font-size: 11px; line-height: 15px; color: var(--hira-text-tertiary, #8b8b8b);
      overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
    }
    .sessions-panel__btn {
      width: 26px; height: 26px; flex-shrink: 0; border: 0; background: transparent;
      color: var(--hira-text-tertiary, #8b8b8b); cursor: pointer;
      border-radius: var(--hira-radius-xs, 6px);
      display: flex; align-items: center; justify-content: center;
      transition: background var(--hira-dur-fast, 120ms) var(--hira-ease-standard, ease),
                  color var(--hira-dur-fast, 120ms) var(--hira-ease-standard, ease);
      opacity: 0; visibility: hidden;
    }
    .sessions-panel__row:hover .sessions-panel__btn { opacity: 1; visibility: visible; }
    .sessions-panel__row:hover .sessions-panel__btn:hover {
      background: var(--hira-surface-soft, rgba(0,0,0,0.06));
      color: var(--hira-text-primary, #1a1a1a);
    }

    /* 自动快照：常驻页脚（原「会话管理」子窗口的全部能力压成一条） */
    .sessions-panel__snapshot {
      flex-shrink: 0; display: flex; align-items: center; gap: 10px;
      padding: 10px 10px 2px; margin-top: 6px;
      box-shadow: inset 0 1px 0 var(--hira-divider, rgba(120,120,120,0.18));
    }
    .sessions-panel__snapshot-main { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 3px; }
    .sessions-panel__snapshot-title {
      font-size: 11px; font-weight: 600; color: var(--hira-text-secondary, #6b7280);
    }
    .sessions-panel__snapshot-meta {
      font-size: 11px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
      color: var(--hira-text-tertiary, #8b8b8b);
    }
    .sessions-panel__snapshot-actions,
    .sessions-panel__last-actions { display: flex; gap: 4px; flex-shrink: 0; }
    .sessions-panel__snapshot-actions button,
    .sessions-panel__last-actions button {
      border: 0; background: transparent;
      display: inline-flex; align-items: center; justify-content: center;
      border-radius: var(--hira-radius-xs, 6px);
      width: var(--hira-control-height, 30px); height: var(--hira-control-height, 30px);
      padding: 0;
      cursor: pointer; font-family: inherit;
      color: var(--hira-text-tertiary, #8b8b8b);
      transition: color var(--hira-dur-fast, 120ms) var(--hira-ease-standard, ease),
                  background var(--hira-dur-fast, 120ms) var(--hira-ease-standard, ease);
    }
    .sessions-panel__snapshot-actions button:hover:not(:disabled),
    .sessions-panel__last-actions button:hover:not(:disabled) {
      color: var(--hira-text-primary, #1a1a1a); background: var(--hira-surface-soft, rgba(0,0,0,0.06));
    }
    .sessions-panel__snapshot-actions button:disabled,
    .sessions-panel__last-actions button:disabled { opacity: 0.4; cursor: default; }
    .sessions-panel__snapshot-actions .sessions-panel__danger:hover:not(:disabled),
    .sessions-panel__last-actions .sessions-panel__danger:hover:not(:disabled) {
      color: var(--hira-danger, #dc2626);
      background: var(--hira-danger-bg, rgba(220,38,38,0.08));
    }

    /* 「上次关闭」卡片：启动时归档的上一轮会话，列表之上一次性提示 */
    .sessions-panel__last {
      flex-shrink: 0; display: flex; flex-direction: column; gap: 6px;
      padding: 10px; margin: 0 0 10px;
      border-radius: var(--hira-radius-md, 10px);
      background: var(--hira-surface-soft, rgba(0,0,0,0.045));
      contain: layout style;
    }
    .sessions-panel__last[hidden] { display: none; }
    .sessions-panel__last-head { display: flex; align-items: center; gap: 10px; }
    .sessions-panel__last-main { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 3px; }
    .sessions-panel__last-title {
      font-size: 11px; font-weight: 600; color: var(--hira-text-secondary, #6b7280);
    }
    .sessions-panel__last-meta {
      font-size: 11px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
      color: var(--hira-text-tertiary, #8b8b8b);
    }
    .sessions-panel__last-items { display: flex; flex-direction: column; gap: 3px; }
    .sessions-panel__last-item {
      display: flex; align-items: center; gap: 8px; min-width: 0;
      font-size: 11px; line-height: 17px;
      color: var(--hira-text-secondary, #6b7280);
    }
    .sessions-panel__last-item-text {
      min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
    }
  `
  doc.head.appendChild(style)
}

function pad2(n: number): string {
  return n < 10 ? `0${n}` : String(n)
}

/**
 * 默认会话名：没填名字时用它，保证「保存」永远是可执行的动作。
 * 面板的保存按钮与总览的「保存」快捷动作**共用这一份**，名字口径不会分叉。
 */
export function defaultSessionName(now = Date.now()) {
  const d = new Date(now)
  return `会话 ${d.getMonth() + 1} 月 ${d.getDate()} 日 ${pad2(d.getHours())}:${pad2(d.getMinutes())}`
}

function el<T extends keyof HTMLElementTagNameMap>(doc: Document, tag: T, className: string): HTMLElementTagNameMap[T] {
  const node = doc.createElement(tag)
  if (className) node.className = className
  return node
}

/** 行 tooltip：前几个标签标题，帮助在点开前确认「是哪个会话」。 */
function sessionTooltip(session: NamedSessionInfo | null | undefined, max = 6): string {
  const tabs = Array.isArray(session?.tabs) ? session.tabs : []
  const lines = tabs.slice(0, max).map((t) => (t && (t.title || t.url)) || '').filter(Boolean)
  if (tabs.length > max) lines.push(`…另外 ${tabs.length - max} 个标签`)
  return lines.join('\n')
}

/**
 * 会话行列表（**唯一一份**实现）—— 会话面板与聚合总览共用。
 *
 * 哑组件：状态上行 `setItems()`，意图下行 `onIntent()`。
 *   · 点击行 → `{ type: 'session-restore', id }`
 *   · 点 ✕  → `{ type: 'session-remove', id }`
 * 调用方（总览）只需在转交时补自己的 `scope`，不必认识行内结构。
 *
 * @param {Document} doc
 * @param {{
 *   onIntent?: (intent: SessionIntent) => void,
 *   grouped?: boolean,
 *   emptyText?: string
 * }} [ctx]
 * @returns {{ element: HTMLElement, setItems: (items: NamedSessionInfo[]) => void }}
 */
export function createSessionRows(
  doc: Document,
  ctx: SessionRowsOptions = {}
): { element: HTMLElement; setItems(items: NamedSessionInfo[]): void } {
  const onIntent = typeof ctx.onIntent === 'function' ? ctx.onIntent : () => {}
  const grouped = ctx.grouped !== false
  const emptyText = typeof ctx.emptyText === 'string'
    ? ctx.emptyText
    : '还没有保存的会话。给当前这组标签起个名字即可保存。'

  const list = el(doc, 'div', 'sessions-panel__list')
  let items: NamedSessionInfo[] = []

  function renderRow(session: NamedSessionInfo): HTMLElement {
    const id = String((session && session.id) || '')
    const tabs = Array.isArray(session && session.tabs) ? session.tabs : []

    const row = el(doc, 'div', 'sessions-panel__row')
    row.setAttribute('data-session-id', id)
    row.title = sessionTooltip(session)

    const icon = el(doc, 'span', 'sessions-panel__icon')
    const layers = iconByName('Layers', doc, { size: 15 })
    if (layers) icon.appendChild(layers)
    else icon.textContent = '▤'
    row.appendChild(icon)

    const main = el(doc, 'div', 'sessions-panel__main')
    const name = el(doc, 'span', 'sessions-panel__name')
    name.textContent = (session && session.name) || '(未命名)'
    const meta = el(doc, 'span', 'sessions-panel__meta')
    const when = formatRelativeStamp(session && session.createdAt)
    meta.textContent = `${tabs.length} 个标签${when ? ` · 保存于 ${when}` : ''}`
    main.append(name, meta)
    row.appendChild(main)

    const remove = el(doc, 'button', 'sessions-panel__btn')
    remove.type = 'button'
    remove.setAttribute('data-session-remove', id)
    remove.title = '删除这个会话（不影响已打开的标签）'
    remove.setAttribute('aria-label', '删除会话')
    const xIcon = iconByName('X', doc, { size: 13 })
    if (xIcon) remove.appendChild(xIcon)
    else remove.textContent = '✕'
    row.appendChild(remove)

    return row
  }

  function render() {
    list.replaceChildren()
    if (!items.length) {
      const empty = el(doc, 'div', 'sessions-panel__empty')
      empty.textContent = emptyText
      list.appendChild(empty)
      return
    }

    const now = Date.now()
    const frag = doc.createDocumentFragment()
    let currentKey: ReturnType<typeof dateBucketOf> | null = null
    for (const session of items) {
      if (grouped) {
        const key = dateBucketOf((session && session.createdAt) || 0, now)
        if (key !== currentKey) {
          currentKey = key
          const label = el(doc, 'div', 'sessions-panel__group-label')
          label.textContent = dateBucketLabel(key)
          frag.appendChild(label)
        }
      }
      frag.appendChild(renderRow(session))
    }
    list.appendChild(frag)
  }

  // 列表级事件委托：行内节点会整批重建，逐行绑监听只会随渲染次数泄漏。
  list.addEventListener('click', (e) => {
    const target = e.target as Element | null
    if (!target || typeof target.closest !== 'function') return
    const removeBtn = target.closest('[data-session-remove]')
    if (removeBtn) {
      e.stopPropagation()
      onIntent({ type: 'session-remove', id: removeBtn.getAttribute('data-session-remove') || '' })
      return
    }
    const row = target.closest('[data-session-id]')
    if (!row) return
    onIntent({ type: 'session-restore', id: row.getAttribute('data-session-id') || '' })
  })

  function setItems(next: NamedSessionInfo[]): void {
    items = Array.isArray(next) ? next : []
    render()
  }

  return { element: list, setItems }
}

/**
 * @param {Document} doc
 * @param {object} ctx 面板端口（clients.sessions / confirm / on / events）
 */
export function createSessionsPanel(doc: Document, ctx: SessionsPanelContext = {}): SessionsPanelController {
  injectSessionsPanelStyles(doc)

  const api = (ctx.clients && ctx.clients.sessions) || null
  const confirmFn = typeof ctx.confirm === 'function' ? ctx.confirm : null

  let disposed = false
  let sessions: NamedSessionInfo[] = []
  let query = ''
  /** 自动快照的当前事实：`{ tabs, pinned, activeIndex, exists }` */
  let snapshot: { tabs: number; pinned: number; activeIndex: number; exists: boolean } = {
    tabs: 0, pinned: 0, activeIndex: 0, exists: false
  }
  /** 「上次关闭」的归档事实（启动时生成，运行期只读） */
  let lastClosed: { exists: boolean; savedAt: number; tabs: number; pinned: number; items: SessionTabInfo[] } = {
    exists: false, savedAt: 0, tabs: 0, pinned: 0, items: []
  }
  let statusTimer: ReturnType<typeof setTimeout> | null = null
  let tabsTimer: ReturnType<typeof setTimeout> | null = null

  const root = el(doc, 'div', 'sessions-panel')
  /** 图标快捷方式：本面板的所有按钮都走同一套 24 格字形（名字找不到时返回 null，按钮仍有文字）。 */
  const ic = (name: string, size = 15): Node => iconByName(name, doc, { size }) || doc.createTextNode('')

  // ── 工具栏 ───────────────────────────────────────────
  const toolbar = el(doc, 'div', 'sessions-panel__toolbar')

  const saveRow = el(doc, 'div', 'sessions-panel__save')
  const nameInput = doc.createElement('input')
  nameInput.type = 'text'
  nameInput.className = 'sessions-panel__input'
  nameInput.placeholder = '给当前这组标签起个名字…'
  nameInput.setAttribute('aria-label', '会话名称')
  nameInput.spellcheck = false
  const saveBtn = doc.createElement('button')
  saveBtn.type = 'button'
  saveBtn.className = 'sessions-panel__save-btn'
  saveBtn.appendChild(ic('Download'))
  saveBtn.title = '把当前标签集存成一个命名会话（不填名字会用默认名）'
  saveBtn.setAttribute('aria-label', '保存当前标签集')
  saveRow.append(nameInput, saveBtn)

  const searchBox = el(doc, 'div', 'sessions-panel__search')
  const searchIcon = el(doc, 'span', 'sessions-panel__search-icon')
  searchIcon.appendChild(ic('Search'))
  const searchInput = doc.createElement('input')
  searchInput.type = 'text'
  searchInput.placeholder = '搜索会话名称或标签…'
  searchInput.setAttribute('aria-label', '搜索会话')
  searchInput.spellcheck = false
  searchBox.append(searchIcon, searchInput)

  const actions = el(doc, 'div', 'sessions-panel__actions')
  const hint = el(doc, 'span', 'sessions-panel__hint')
  const refreshBtn = doc.createElement('button')
  refreshBtn.type = 'button'
  refreshBtn.appendChild(ic('RefreshCw'))
  refreshBtn.title = '重新读取会话列表与快照状态'
  refreshBtn.setAttribute('aria-label', '刷新会话列表')
  actions.append(hint, refreshBtn)

  toolbar.append(saveRow, searchBox, actions)

  // ── 列表（与总览共用同一份行件）────────────────────
  const rows = createSessionRows(doc, {
    grouped: true,
    onIntent: (intent) => handleIntent(intent)
  })

  // ── 「上次关闭」卡片（启动时归档的上一轮会话）────────
  // 位置在列表之上：它是一次性的引导（"要不要把昨天那批标签捡回来"），
  // 与下方「已保存会话」的常驻管理流在语义上不同层，因此独立成卡而不是混进行列表。
  const lastCard = el(doc, 'div', 'sessions-panel__last')
  lastCard.hidden = true
  const lastHead = el(doc, 'div', 'sessions-panel__last-head')
  const lastMain = el(doc, 'div', 'sessions-panel__last-main')
  const lastTitle = el(doc, 'span', 'sessions-panel__last-title')
  lastTitle.textContent = '上次关闭'
  const lastMeta = el(doc, 'span', 'sessions-panel__last-meta')
  lastMain.append(lastTitle, lastMeta)
  const lastActions = el(doc, 'div', 'sessions-panel__last-actions')
  const lastRestoreBtn = doc.createElement('button')
  lastRestoreBtn.type = 'button'
  lastRestoreBtn.appendChild(ic('Undo2'))
  lastRestoreBtn.title = '把上次关闭时的标签追加打开'
  lastRestoreBtn.setAttribute('aria-label', '恢复上次关闭的标签')
  const lastClearBtn = doc.createElement('button')
  lastClearBtn.type = 'button'
  lastClearBtn.className = 'sessions-panel__danger'
  lastClearBtn.appendChild(ic('X'))
  lastClearBtn.title = '忽略这份「上次关闭」记录（不影响已打开的标签）'
  lastClearBtn.setAttribute('aria-label', '忽略上次关闭记录')
  lastActions.append(lastRestoreBtn, lastClearBtn)
  lastHead.append(lastMain, lastActions)
  const lastItems = el(doc, 'div', 'sessions-panel__last-items')
  lastCard.append(lastHead, lastItems)

  // ── 自动快照页脚 ─────────────────────────────────────
  const snapshotBar = el(doc, 'div', 'sessions-panel__snapshot')
  const snapshotMain = el(doc, 'div', 'sessions-panel__snapshot-main')
  const snapshotTitle = el(doc, 'span', 'sessions-panel__snapshot-title')
  snapshotTitle.textContent = '自动快照'
  const snapshotMeta = el(doc, 'span', 'sessions-panel__snapshot-meta')
  snapshotMain.append(snapshotTitle, snapshotMeta)
  const snapshotActions = el(doc, 'div', 'sessions-panel__snapshot-actions')
  const snapSaveBtn = doc.createElement('button')
  snapSaveBtn.type = 'button'
  snapSaveBtn.appendChild(ic('Download'))
  snapSaveBtn.title = '把当前标签集覆盖写入自动快照'
  snapSaveBtn.setAttribute('aria-label', '保存自动快照')
  const snapRestoreBtn = doc.createElement('button')
  snapRestoreBtn.type = 'button'
  snapRestoreBtn.appendChild(ic('Undo2'))
  snapRestoreBtn.title = '把自动快照里的标签追加打开'
  snapRestoreBtn.setAttribute('aria-label', '恢复自动快照')
  const snapClearBtn = doc.createElement('button')
  snapClearBtn.type = 'button'
  snapClearBtn.className = 'sessions-panel__danger'
  snapClearBtn.appendChild(ic('Trash2'))
  snapClearBtn.title = '删除自动快照（已打开的标签不受影响）'
  snapClearBtn.setAttribute('aria-label', '删除自动快照')
  snapshotActions.append(snapSaveBtn, snapRestoreBtn, snapClearBtn)
  snapshotBar.append(snapshotMain, snapshotActions)

  root.append(toolbar, lastCard, rows.element, snapshotBar)

  // ── 过滤与状态文案 ───────────────────────────────────
  function sortedSessions(): NamedSessionInfo[] {
    return sessions.slice().sort((a, b) => ((b && b.createdAt) || 0) - ((a && a.createdAt) || 0))
  }

  function visibleSessions(): NamedSessionInfo[] {
    const list = sortedSessions()
    const needle = query.trim().toLowerCase()
    if (!needle) return list
    return list.filter((s) => {
      if (String((s && s.name) || '').toLowerCase().includes(needle)) return true
      const tabs = Array.isArray(s && s.tabs) ? s.tabs : []
      return tabs.some((t) => String((t && t.title) || '').toLowerCase().includes(needle) ||
        String((t && t.url) || '').toLowerCase().includes(needle))
    })
  }

  function hintText(visible: NamedSessionInfo[]): string {
    const total = sessions.length
    if (!total) return '还没有保存的会话'
    if (query.trim()) return `命中 ${visible.length} / ${total}`
    return `共 ${total} 个会话`
  }

  /** 瞬时反馈：占用同一行文案的位置，2.4s 后自动回到计数。 */
  function flash(text: string): void {
    if (statusTimer) clearTimeout(statusTimer)
    hint.textContent = text
    statusTimer = setTimeout(() => {
      statusTimer = null
      updateHint()
    }, 2400)
  }

  function updateHint(visible: NamedSessionInfo[] = visibleSessions()): void {
    if (statusTimer) return
    hint.textContent = hintText(visible)
    hint.title = '命名会话上限 30 个，每个最多 200 个标签'
  }

  function render(): void {
    const visible = visibleSessions()
    rows.setItems(visible)
    updateHint(visible)
  }

  function renderSnapshot(): void {
    const tabs = Number(snapshot.tabs) || 0
    const pinned = Number(snapshot.pinned) || 0
    const parts = [`当前 ${tabs} 个标签`]
    if (pinned > 0) parts.push(`${pinned} 个固定标签`)
    parts.push(snapshot.exists ? '快照已保存' : '尚未保存快照')
    snapshotMeta.textContent = parts.join(' · ')
    snapRestoreBtn.disabled = !snapshot.exists
    snapClearBtn.disabled = !snapshot.exists
    snapSaveBtn.disabled = tabs === 0
  }

  function renderLastClosed(): void {
    const exists = !!lastClosed.exists && Number(lastClosed.tabs) > 0
    lastCard.hidden = !exists
    if (!exists) {
      lastItems.replaceChildren()
      return
    }
    const tabs = Number(lastClosed.tabs) || 0
    const pinned = Number(lastClosed.pinned) || 0
    const when = formatRelativeStamp(lastClosed.savedAt)
    lastMeta.textContent = [
      when ? `关闭于 ${when}` : '',
      `${tabs} 个标签${pinned > 0 ? `（${pinned} 个固定标签）` : ''}`
    ].filter(Boolean).join(' · ')
    lastCard.title = (lastClosed.items || [])
      .map((t) => (t && (t.title || t.url)) || '')
      .filter(Boolean)
      .join('\n')

    const frag = doc.createDocumentFragment()
    for (const item of lastClosed.items || []) {
      if (!item || !item.url) continue
      const row = el(doc, 'div', 'sessions-panel__last-item')
      row.appendChild(createFaviconBadge(doc, item.favicon, item.title || item.url, 14, item.url))
      const text = el(doc, 'span', 'sessions-panel__last-item-text')
      text.textContent = item.title || item.url
      row.appendChild(text)
      frag.appendChild(row)
    }
    lastItems.replaceChildren(frag)
  }

  // ── 数据 ─────────────────────────────────────────────
  async function loadNamed(): Promise<void> {
    if (!api || typeof api.listNamed !== 'function') return
    try {
      const res = await api.listNamed()
      sessions = res && Array.isArray(res.sessions) ? res.sessions : []
    } catch (_) {
      sessions = []
    }
  }

  async function loadSnapshot(): Promise<void> {
    if (!api) return
    try {
      const [stats, existsRes] = await Promise.all([
        typeof api.stats === 'function' ? api.stats() : Promise.resolve(null),
        typeof api.exists === 'function' ? api.exists() : Promise.resolve(null)
      ])
      snapshot = {
        tabs: Number(stats && stats.tabs) || 0,
        pinned: Number(stats && stats.pinned) || 0,
        activeIndex: Number(stats && stats.activeIndex) || 0,
        exists: !!(existsRes && existsRes.exists)
      }
    } catch (_) {
      snapshot = { tabs: 0, pinned: 0, activeIndex: 0, exists: false }
    }
  }

  async function loadLastClosed(): Promise<void> {
    if (!api || typeof api.lastClosed !== 'function') return
    try {
      const res = await api.lastClosed()
      lastClosed = {
        exists: !!(res && res.exists),
        savedAt: Number(res && res.savedAt) || 0,
        tabs: Number(res && res.tabs) || 0,
        pinned: Number(res && res.pinned) || 0,
        items: res && Array.isArray(res.items) ? res.items : []
      }
    } catch (_) {
      lastClosed = { exists: false, savedAt: 0, tabs: 0, pinned: 0, items: [] }
    }
  }

  async function refresh(): Promise<void> {
    await Promise.all([loadNamed(), loadSnapshot(), loadLastClosed()])
    if (disposed) return
    render()
    renderSnapshot()
    renderLastClosed()
  }

  // ── 动作 ─────────────────────────────────────────────
  async function saveNamed(name: string): Promise<void> {
    if (!api || typeof api.saveNamed !== 'function') return
    const label = String(name || '').trim() || defaultSessionName()
    saveBtn.disabled = true
    try {
      const res = await api.saveNamed(label)
      if (res && res.ok) {
        nameInput.value = ''
        await loadNamed()
        render()
        flash(`已保存「${label}」`)
      } else {
        flash((res && res.reason) || '保存失败')
      }
    } catch (_) {
      flash('保存失败')
    } finally {
      saveBtn.disabled = false
    }
  }

  async function restoreNamed(id: string): Promise<void> {
    if (!api || typeof api.restoreNamed !== 'function' || !id) return
    try {
      const res = await api.restoreNamed(id)
      if (res && res.ok) flash(`已打开 ${res.opened || 0} 个标签`)
      else flash((res && res.reason) || '恢复失败')
    } catch (_) {
      flash('恢复失败')
    }
  }

  function removeNamed(id: string): void {
    if (!api || typeof api.removeNamed !== 'function' || !id) return
    const target = sessions.find((s) => s && s.id === id)
    const proceeded = confirmFn
      ? Promise.resolve(confirmFn({
        title: '删除会话',
        message: `确定删除「${(target && target.name) || '这个会话'}」吗？已打开的标签不受影响。`
      }))
      : Promise.resolve(true)
    proceeded.then(async (ok) => {
      if (!ok) return
      try {
        await api.removeNamed(id)
        await loadNamed()
        render()
        flash('已删除')
      } catch (_) {
        flash('删除失败')
      }
    })
  }

  async function saveSnapshot(): Promise<void> {
    if (!api || typeof api.save !== 'function') return
    try {
      const res = await api.save()
      await loadSnapshot()
      renderSnapshot()
      flash(res && res.ok ? '已保存当前标签快照' : '保存失败')
    } catch (_) {
      flash('保存失败')
    }
  }

  async function restoreSnapshot(): Promise<void> {
    if (!api || typeof api.restore !== 'function') return
    try {
      const res = await api.restore()
      if (res && res.restored) {
        await loadSnapshot()
        renderSnapshot()
        flash('已恢复自动快照')
      } else {
        flash('没有可恢复的快照')
      }
    } catch (_) {
      flash('恢复失败')
    }
  }

  function clearSnapshot(): void {
    if (!api || typeof api.clear !== 'function') return
    const proceeded = confirmFn
      ? Promise.resolve(confirmFn({
        title: '清除自动快照',
        message: '确定删除自动快照吗？已打开的标签不受影响。'
      }))
      : Promise.resolve(true)
    proceeded.then(async (ok) => {
      if (!ok) return
      try {
        await api.clear()
        await loadSnapshot()
        renderSnapshot()
        flash('已清除自动快照')
      } catch (_) {
        flash('清除失败')
      }
    })
  }

  async function restoreLastClosed(): Promise<void> {
    if (!api || typeof api.restoreLastClosed !== 'function') return
    try {
      const res = await api.restoreLastClosed()
      if (res && res.restored) flash('已恢复上次关闭的标签')
      else flash('没有可恢复的记录')
    } catch (_) {
      flash('恢复失败')
    }
  }

  function clearLastClosed(): void {
    if (!api || typeof api.clearLastClosed !== 'function') return
    const proceeded = confirmFn
      ? Promise.resolve(confirmFn({
        title: '忽略上次关闭记录',
        message: '确定清除这份「上次关闭」记录吗？已打开的标签不受影响。'
      }))
      : Promise.resolve(true)
    proceeded.then(async (ok) => {
      if (!ok) return
      try {
        await api.clearLastClosed()
        await loadLastClosed()
        renderLastClosed()
        flash('已忽略上次关闭记录')
      } catch (_) {
        flash('清除失败')
      }
    })
  }

  /** 意图总入口（行件与工具栏共用一条下行通道）。 */
  function handleIntent(intent: SessionIntent): void {
    if (!intent) return
    const type = intent.type
    if (type === 'search') {
      setQuery(intent.query || '')
      return
    }
    if (type === 'session-save') {
      saveNamed(intent.name || '')
      return
    }
    if (type === 'session-restore') {
      restoreNamed(intent.id)
      return
    }
    if (type === 'session-remove') {
      removeNamed(intent.id)
      return
    }
    if (type === 'snapshot-save') {
      saveSnapshot()
      return
    }
    if (type === 'snapshot-restore') {
      restoreSnapshot()
      return
    }
    if (type === 'snapshot-clear') {
      clearSnapshot()
      return
    }
    if (type === 'last-closed-restore') {
      restoreLastClosed()
      return
    }
    if (type === 'last-closed-clear') {
      clearLastClosed()
    }
  }

  function setQuery(next: string): void {
    query = String(next == null ? '' : next)
    render()
  }

  // ── DOM 事件 ─────────────────────────────────────────
  saveBtn.addEventListener('click', () => handleIntent({ type: 'session-save', name: nameInput.value }))
  nameInput.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter') return
    e.preventDefault()
    handleIntent({ type: 'session-save', name: nameInput.value })
  })
  searchInput.addEventListener('input', () => setQuery(searchInput.value))
  searchInput.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape' || !searchInput.value) return
    e.preventDefault()
    searchInput.value = ''
    setQuery('')
  })
  refreshBtn.addEventListener('click', () => { refresh() })
  snapSaveBtn.addEventListener('click', () => handleIntent({ type: 'snapshot-save' }))
  snapRestoreBtn.addEventListener('click', () => handleIntent({ type: 'snapshot-restore' }))
  snapClearBtn.addEventListener('click', () => handleIntent({ type: 'snapshot-clear' }))
  lastRestoreBtn.addEventListener('click', () => handleIntent({ type: 'last-closed-restore' }))
  lastClearBtn.addEventListener('click', () => handleIntent({ type: 'last-closed-clear' }))

  // ── 订阅 ─────────────────────────────────────────────
  // 命名会话 = 设置项 `sessions.named`：任何来源（内部页 / 总览 / 别的窗口）写入后自刷新。
  let unsubscribeSettings: (() => void) | null = null
  if (typeof ctx.on === 'function' && ctx.events && ctx.events.settingsChanged) {
    try {
      unsubscribeSettings = ctx.on(ctx.events.settingsChanged, (payload) => {
        const change = payload as SettingsChangePayload | undefined
        const key = change && typeof change.key === 'string' ? change.key : ''
        if (!change || change.scope === 'all' || key === NAMED_KEY) {
          loadNamed().then(render).catch(() => {})
        }
      })
    } catch (_) {}
  }
  // 标签增减会让「当前 N 个标签」失真：合并窗口后只补拉 stats（不重拉命名列表）。
  if (typeof ctx.on === 'function' && ctx.events && ctx.events.tabChanged) {
    try {
      ctx.on(ctx.events.tabChanged, () => {
        if (tabsTimer) clearTimeout(tabsTimer)
        tabsTimer = setTimeout(() => {
          tabsTimer = null
          loadSnapshot().then(() => { if (!disposed) renderSnapshot() }).catch(() => {})
        }, 400)
      })
    } catch (_) {}
  }

  refresh().catch(() => {})

  return {
    element: root,
    refresh,
    setItems() {},
    focusSearch() {
      try {
        nameInput.focus()
      } catch (_) {
        return false
      }
      return true
    },
    dispose() {
      disposed = true
      if (statusTimer) clearTimeout(statusTimer)
      if (tabsTimer) clearTimeout(tabsTimer)
      if (typeof unsubscribeSettings === 'function') unsubscribeSettings()
      unsubscribeSettings = null
      root.remove()
    }
  }
}

/** 面板插件定义（宿主按约定发现并挂载；端口由 ctx 注入）。 */
export const panelDefinition = {
  id: 'sessions-panel',
  injectStyles: injectSessionsPanelStyles,
  mount(doc: Document, ctx: SessionsPanelContext) {
    return createSessionsPanel(doc, ctx)
  }
}
