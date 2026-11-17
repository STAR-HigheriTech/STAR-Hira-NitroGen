/**
 * AI 面板 · 会话侧栏（历史列表 + 全文检索）。
 *
 * 一屏四个动作：**切换 / 改名 / 删除 / 导出**，外加新建与搜索。全部直接落到 store ——
 * 这里不保存任何会话状态（否则抽屉与顶栏会各记一份"当前是谁"）。
 *
 * 列表按 `updatedAt` 倒序（引擎已排好），只在签名变化时重建：
 * 流式 token 每帧都会让 `state` 变，但会话列表通常一个字都没动。
 *
 * 搜索走引擎的 `sessions.search`（FTS5 + LIKE 兜底，中文可用），
 * 命中的高亮片段**不用 innerHTML** —— SQLite 的 `snippet()` 会在原文里插
 * `<b>` 标记，若原文含尖括号就会变成注入点。这里按标记切段、逐段建文本节点。
 */

import { attach, h, icon, iconButton, relativeTime, clip } from './dom.js'
import type { AiSession, AiUiState } from './types.js'
import type { AiStore } from './store.js'

type TimerHandle = ReturnType<typeof setTimeout>

interface SessionSearchHit extends AiSession {
  snippet?: string
  seq?: number
}

interface SessionSearchResult {
  ok?: boolean
  sessions?: SessionSearchHit[]
}

/** 输入停顿多久才发检索（打字过程中不打服务端）。 */
const SEARCH_DEBOUNCE = 180

/**
 * @param {Document} doc
 * @param {{
 *   store: any,
 *   confirm?: (opts: { title?: string, message?: string }) => Promise<boolean>,
 *   onClose?: () => void,
 *   onOpen?: () => void
 * }} deps
 */
export function createSessions(doc: Document, deps: {
  store: AiStore,
  confirm?: (opts: { title?: string, message?: string }) => Promise<boolean>,
  onClose?: () => void,
  onOpen?: () => void
}) {
  const { store } = deps
  const win = doc.defaultView

  const element = h(doc, 'div', 'ai-drawer')
  element.hidden = true

  const head = h(doc, 'div', 'ai-drawer__head')
  head.appendChild(h(doc, 'div', 'ai-drawer__title', '会话'))
  head.appendChild(iconButton(doc, {
    iconName: 'Download',
    label: '导出当前会话（Markdown）',
    onClick: () => { store.exportSession('md') }
  }))
  head.appendChild(iconButton(doc, {
    iconName: 'Plus',
    label: '新建会话',
    onClick: () => { store.newSession().then(() => { if (!isDocked()) close() }) }
  }))
  const collapseBtn = iconButton(doc, {
    iconName: 'X',
    label: '关闭',
    onClick: () => close()
  })
  head.appendChild(collapseBtn)

  const body = h(doc, 'div', 'ai-drawer__body')

  const searchBox = h(doc, 'div', 'ai-drawer__search')
  const searchGlyph = h(doc, 'span', 'ai-drawer__search-glyph')
  const searchInput: HTMLInputElement = /** @type {HTMLInputElement} */ (h(doc, 'input', 'ai-drawer__search-input'))
  searchInput.type = 'search'
  searchInput.placeholder = '搜索全部会话…'
  searchInput.spellcheck = false
  const glyph = icon(doc, 'Search', 12)
  if (glyph) searchGlyph.appendChild(glyph)
  attach(searchBox, searchGlyph, searchInput)

  const list = h(doc, 'div', 'ai-sessions')
  const hits = h(doc, 'div', 'ai-sessions ai-sessions--hits')
  hits.hidden = true
  attach(body, searchBox, list, hits)
  attach(element, head, body)

  let signature = ''
  /** 正在改名的会话 id（改名期间不重建列表，否则输入框会被抹掉）。 */
  let renamingId: string | null = null
  /** 检索态：query 非空时列表让位给命中结果。 */
  let searchQuery = ''
  /** @type {any[]} */
  let searchHits: SessionSearchHit[] = []
  let searchSerial = 0
  let searchTimer: number | TimerHandle = 0
  let hitSignature = ''

  function open(docked = false, focusSearch = true) {
    element.classList.toggle('is-docked', !!docked)
    collapseBtn.textContent = ''
    collapseBtn.title = docked ? '收起会话侧栏' : '关闭'
    collapseBtn.setAttribute('aria-label', collapseBtn.title)
    const collapseGlyph = icon(doc, docked ? 'ChevronLeft' : 'X', 14)
    if (collapseGlyph) collapseBtn.appendChild(collapseGlyph)
    else collapseBtn.textContent = docked ? '‹' : '×'
    element.hidden = false
    if (typeof deps.onOpen === 'function') deps.onOpen()
    if (focusSearch && win) win.requestAnimationFrame(() => { try { searchInput.focus() } catch (_) {} })
  }

  function close() {
    element.hidden = true
    element.classList.remove('is-docked')
    renamingId = null
    resetSearch()
    if (typeof deps.onClose === 'function') deps.onClose()
  }

  function isOpen() {
    return !element.hidden
  }

  function isDocked(): boolean {
    return !element.hidden && element.classList.contains('is-docked')
  }

  function startRename(session: AiSession): void {
    renamingId = session.id
    render(store.get(), true)
  }

  // ── 检索 ────────────────────────────────────────────────────────────
  function resetSearch() {
    if (searchTimer && win) win.clearTimeout(searchTimer)
    searchTimer = 0
    searchSerial++
    searchQuery = ''
    searchHits = []
    hitSignature = ''
    if (searchInput.value) searchInput.value = ''
    hits.hidden = true
    hits.textContent = ''
    list.hidden = false
  }

  function runSearch() {
    searchTimer = 0
    const q = searchQuery
    const serial = ++searchSerial
    store.searchSessions(q).then((raw: unknown) => {
      if (serial !== searchSerial || q !== searchQuery) return
      const res = raw as SessionSearchResult
      searchHits = res.sessions ?? []
      renderHits()
    })
  }

  searchInput.addEventListener('input', () => {
    const next = searchInput.value.trim()
    searchQuery = next
    if (searchTimer && win) win.clearTimeout(searchTimer)
    if (!next) {
      resetSearch()
      return
    }
    list.hidden = true
    hits.hidden = false
    if (win) searchTimer = win.setTimeout(runSearch, SEARCH_DEBOUNCE)
    else runSearch()
  })

  searchInput.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      e.preventDefault()
      e.stopPropagation()
      if (searchQuery) resetSearch()
      else close()
    }
  })

  /** 把 `snippet()` 的 `<b>` 标记转成 `<mark>`（**纯文本节点拼接，绝不 innerHTML**）。 */
  function appendHighlight(node: HTMLElement, snippet: unknown, needle: string): void {
    const raw = String(snippet || '')
    if (!raw) return
    const parts = raw.split(/(<b>[\s\S]*?<\/b>)/g)
    for (const part of parts) {
      if (!part) continue
      if (part.startsWith('<b>') && part.endsWith('</b>')) {
        const mark = h(doc, 'mark', '', part.slice(3, -4))
        node.appendChild(mark)
      } else {
        node.appendChild(doc.createTextNode(part))
      }
    }
    // LIKE 兜底返回的是纯文本片段：把查询词也标出来
    if (!parts.some((p) => p.startsWith('<b>')) && needle) {
      node.textContent = ''
      const text = raw
      const lower = text.toLowerCase()
      const key = needle.toLowerCase()
      let from = 0
      let at = lower.indexOf(key)
      while (at >= 0) {
        if (at > from) node.appendChild(doc.createTextNode(text.slice(from, at)))
        node.appendChild(h(doc, 'mark', '', text.slice(at, at + key.length)))
        from = at + key.length
        at = lower.indexOf(key, from)
      }
      if (from < text.length) node.appendChild(doc.createTextNode(text.slice(from)))
    }
  }

  function renderHits() {
    const currentId = store.get().sessionId
    const next = `${searchQuery}#${currentId || ''}#${searchHits.map((x) => `${x && x.id}:${x && x.seq}`).join('~')}`
    if (next === hitSignature) return
    hitSignature = next

    hits.textContent = ''
    if (!searchQuery) { hits.hidden = true; list.hidden = false; return }
    hits.hidden = false
    list.hidden = true
    if (!searchHits.length) {
      hits.appendChild(h(doc, 'div', 'ai-popover__empty', '没有匹配的会话'))
      return
    }
    for (const hit of searchHits) {
      if (!hit || !hit.id) continue
      const node: HTMLButtonElement = /** @type {HTMLButtonElement} */ (h(doc, 'button', `ai-session ai-session--hit${hit.id === currentId ? ' is-active' : ''}`))
      node.type = 'button'
      const top = h(doc, 'span', 'ai-session__hit-head')
      top.appendChild(h(doc, 'span', 'ai-session__title', hit.title || '新会话'))
      top.appendChild(h(doc, 'span', 'ai-session__time', relativeTime(hit.updatedAt)))
      const snippet = h(doc, 'span', 'ai-session__snippet')
      appendHighlight(snippet, hit.snippet, searchQuery)
      attach(node, top, snippet)
      node.addEventListener('click', () => {
        if (!isDocked()) close()
        store.switchSession(hit.id)
      })
      hits.appendChild(node)
    }
  }

  // ── 列表 ────────────────────────────────────────────────────────────
  function row(session: AiSession, currentId: string | null): HTMLElement {
    const node = h(doc, 'div', `ai-session${session.id === currentId ? ' is-active' : ''}`)

    if (renamingId === session.id) {
      node.classList.add('is-renaming')
      const input: HTMLInputElement = /** @type {HTMLInputElement} */ (h(doc, 'input', 'ai-session__rename'))
      input.type = 'text'
      input.value = session.title || ''
      let done = false
      const commit = (save: boolean): void => {
        if (done) return
        done = true
        renamingId = null
        const next = input.value.trim()
        if (save && next && next !== session.title) store.renameSession(session.id, next)
        else render(store.get(), true)
      }
      input.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') { e.preventDefault(); commit(true) }
        else if (e.key === 'Escape') { e.preventDefault(); commit(false) }
      })
      input.addEventListener('blur', () => commit(true))
      input.addEventListener('click', (e) => e.stopPropagation())
      node.appendChild(input)
      if (win) win.requestAnimationFrame(() => { try { input.focus(); input.select() } catch (_) {} })
      return node
    }

    const main = h(doc, 'button', 'ai-session__pick')
    main.type = 'button'
    main.appendChild(h(doc, 'span', 'ai-session__title', session.title || '新会话'))
    main.appendChild(h(doc, 'span', 'ai-session__time', relativeTime(session.updatedAt)))
    main.addEventListener('click', () => {
      store.switchSession(session.id).then(() => { if (!isDocked()) close() })
    })
    main.addEventListener('dblclick', () => startRename(session))
    main.title = `${session.title || '新会话'}\n双击改名`

    const actions = h(doc, 'div', 'ai-session__actions')
    actions.appendChild(iconButton(doc, {
      iconName: 'Download',
      label: '导出（Markdown）',
      onClick: (e) => { e.stopPropagation(); store.exportSession('md', session.id) }
    }))
    actions.appendChild(iconButton(doc, {
      iconName: 'Pencil',
      label: '改名',
      onClick: (e) => { e.stopPropagation(); startRename(session) }
    }))
    actions.appendChild(iconButton(doc, {
      iconName: 'Trash2',
      label: '删除',
      onClick: async (e) => {
        e.stopPropagation()
        const ok = typeof deps.confirm === 'function'
          ? await deps.confirm({
            title: '删除会话',
            message: `「${clip(session.title || '新会话', 40)}」及它的全部消息将被删除，无法恢复。`
          })
          : true
        if (ok) store.deleteSession(session.id)
      }
    }))

    attach(node, main, actions)
    return node
  }

  function render(state: AiUiState, force: boolean = false): void {
    // 改名输入框是本地瞬态。流式更新 / 自动标题 / 排序变化都不应把它重建，
    // 否则用户正在输入时会突然失焦，甚至把半截标题提交出去。
    if (!force && renamingId) return
    const sessions = Array.isArray(state.sessions) ? state.sessions : []
    const next = [
      sessions.map((s) => `${s.id}|${s.title || ''}|${s.updatedAt || 0}`).join('~'),
      state.sessionId || '',
      renamingId || ''
    ].join('#')
    if (!force && next === signature) return
    signature = next

    list.textContent = ''
    if (!sessions.length) {
      list.appendChild(h(doc, 'div', 'ai-popover__empty', '还没有会话。发一条消息就会自动创建。'))
      return
    }
    for (const session of sessions) {
      if (!session || !session.id) continue
      list.appendChild(row(session, state.sessionId))
    }
  }

  function update(state: AiUiState): void {
    render(state)
    // 命中列表跟着当前会话走（高亮"你正在哪一条"）
    if (searchQuery && !searchTimer) renderHits()
  }

  function dispose(): void {
    if (searchTimer && win) win.clearTimeout(searchTimer)
    if (element.parentNode) element.parentNode.removeChild(element)
  }

  return { element, open, close, isOpen, isDocked, update, dispose, get isRenaming() { return renamingId !== null } }
}
