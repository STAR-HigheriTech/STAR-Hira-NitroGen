import type { WebContents } from 'electron'
import type {
  CaptureHubCommit,
  CaptureHubPayload,
  CaptureHubSource,
  CaptureHubTarget
} from '@hira-ng/shared-types/src/capture-hub.mjs'
import {
  EASEL_ACTIVE_BOARD_SETTING_KEY,
  EASEL_SETTING_KEY,
  createBoard,
  createCard,
  parseBoards,
  serializeBoards
} from '@hira-ng/shared-types/src/easel.mjs'
import { READING_LIST_FOLDER } from '@hira-ng/shared-types/src/reading-list.mjs'
import { isHttpUrl } from '@hira-ng/shared-types/src/url-protocols.mjs'

interface TabsPort {
  getActiveTabId(): string | null
  getWebContents(tabId: string): WebContents | null | undefined
  list(): Array<Record<string, unknown>>
}

interface NotesPort {
  listFolders(): Array<{ id: string; name: string }>
  addFolder(input: { name: string }): string
}

interface BookmarksPort {
  getByUrl(url: string): Record<string, unknown> | null
  add(input: Record<string, unknown>): unknown
  update(id: string, input: Record<string, unknown>): unknown
}

interface SettingsPort {
  get(key: string): unknown
  set(key: string, value: unknown): unknown
}

interface NoteActionsPort {
  run(action: string, params: Record<string, unknown>): unknown
}

interface CaptureHubOptions {
  getTabs(): TabsPort | null | undefined
  getNotes(): NotesPort | null | undefined
  getBookmarks(): BookmarksPort | null | undefined
  getNoteActions(): NoteActionsPort | null | undefined
  settings: SettingsPort
  openWindow(payload: CaptureHubPayload): unknown
  showPanel?(panelId: string): unknown
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

async function selectionOf(wc: WebContents | null | undefined): Promise<string> {
  if (!wc || wc.isDestroyed()) return ''
  try {
    const value = await wc.executeJavaScript('String(window.getSelection ? window.getSelection().toString() : "")', true)
    return String(value || '').slice(0, 20000)
  } catch {
    return ''
  }
}

function createCaptureHub(options: CaptureHubOptions) {
  async function sourceForActiveTab(input: Partial<CaptureHubPayload> = {}): Promise<CaptureHubSource | null> {
    const tabs = options.getTabs()
    if (!tabs) return null
    const tabId = String(input.tabId || tabs.getActiveTabId() || '')
    if (!tabId) return null
    const row = tabs.list().find((tab) => String(tab.tabId || '') === tabId) || {}
    const wc = tabs.getWebContents(tabId)
    const currentPageUrl = wc && !wc.isDestroyed() ? String(wc.getURL() || '') : String(row.url || '')
    let url = input.url || currentPageUrl
    let title = input.title || (wc && !wc.isDestroyed() ? wc.getTitle() : '')
    url = url || String(row.url || '')
    title = title || String(row.title || '')
    if (!isHttpUrl(url)) return null
    const kind = input.kind || 'page'
    return {
      tabId,
      url,
      title,
      selection: input.selection ?? (kind === 'page' || kind === 'selection' ? await selectionOf(wc) : ''),
      kind,
      ...(input.referer || currentPageUrl !== url ? { referer: input.referer || currentPageUrl } : {})
    }
  }

  async function open(input: Partial<CaptureHubPayload> = {}): Promise<{ ok: boolean; reason?: string }> {
    const source = await sourceForActiveTab(input)
    if (!source) return { ok: false, reason: '当前页面不支持收集' }
    options.openWindow({ ...source, suggestedTitle: source.title || source.url })
    return { ok: true }
  }

  async function ensureReadingFolder(): Promise<string> {
    const notes = options.getNotes()
    if (!notes) throw new Error('笔记服务不可用')
    const existing = notes.listFolders().find((folder) => folder.name === READING_LIST_FOLDER)
    return existing ? existing.id : notes.addFolder({ name: READING_LIST_FOLDER })
  }

  async function collectNotes(input: CaptureHubCommit, reading: boolean): Promise<{ ok: boolean; reason?: string }> {
    const actions = options.getNoteActions()
    if (!actions) return { ok: false, reason: '集锦服务不可用' }
    const folderId = reading ? await ensureReadingFolder() : undefined
    const text = String(input.text || '').trim()
    if (input.source.kind === 'image' && reading) return { ok: false, reason: '图片请收集到集锦或画板' }
    const action = input.source.kind === 'image'
      ? 'note:save-image'
      : text
        ? 'note:save-text'
        : 'note:save-page'
    const result = await Promise.resolve(actions.run(action, {
      url: input.source.url,
      title: input.title || input.source.title,
      sourceTitle: input.source.title,
      referer: input.source.referer,
      folderId,
      text,
      reveal: true
    })) as Record<string, unknown> | null
    return result && result.ok === false
      ? { ok: false, reason: String(result.error || '收集失败') }
      : { ok: true }
  }

  async function collectBookmark(input: CaptureHubCommit): Promise<{ ok: boolean; reason?: string }> {
    const bookmarks = options.getBookmarks()
    if (!bookmarks) return { ok: false, reason: '书签服务不可用' }
    const title = String(input.title || input.source.title || input.source.url).trim()
    const tags = Array.isArray(input.tags)
      ? [...new Set(input.tags.map(String).map((tag) => tag.trim()).filter(Boolean))]
      : []
    const summary = String(input.text || '').trim() || null
    const existing = bookmarks.getByUrl(input.source.url)
    if (existing) {
      const id = String(existing.id || '')
      if (!id) return { ok: false, reason: '书签记录无效' }
      bookmarks.update(id, { title, tags, summary })
    } else {
      bookmarks.add({ title, url: input.source.url, tags, summary })
    }
    try { options.showPanel?.('favorites-panel') } catch {}
    return { ok: true }
  }

  async function collectEasel(input: CaptureHubCommit): Promise<{ ok: boolean; reason?: string }> {
    const boards = parseBoards(options.settings.get(EASEL_SETTING_KEY))
    const activeId = String(options.settings.get(EASEL_ACTIVE_BOARD_SETTING_KEY) || '')
    let board = boards.find((item) => item.id === activeId) || boards[0]
    if (!board) {
      board = createBoard('收集')
      boards.unshift(board)
    }
    const text = String(input.text || '').trim()
    const title = String(input.title || input.source.title || input.source.url)
    const card = input.source.kind === 'image'
      ? createCard('image', { data: input.source.url, url: input.source.url, title }, { x: 40, y: 40 })
      : text
        ? createCard('note', { text, title, url: input.source.url }, { x: 40, y: 40 })
        : createCard('link', { url: input.source.url, title }, { x: 40, y: 40 })
    board.cards.unshift(card)
    board.updatedAt = Date.now()
    await Promise.resolve(options.settings.set(EASEL_SETTING_KEY, serializeBoards(boards)))
    await Promise.resolve(options.settings.set(EASEL_ACTIVE_BOARD_SETTING_KEY, board.id))
    try { options.showPanel?.('easel-panel') } catch {}
    return { ok: true }
  }

  async function commit(input: CaptureHubCommit): Promise<{ ok: boolean; reason?: string }> {
    if (!input || !input.source || !isHttpUrl(input.source.url)) {
      return { ok: false, reason: '来源页面已失效' }
    }
    const target: CaptureHubTarget = input.target
    try {
      if (target === 'notes') return await collectNotes(input, false)
      if (target === 'reading') return await collectNotes(input, true)
      if (target === 'bookmark') return await collectBookmark(input)
      if (target === 'easel') return await collectEasel(input)
      return { ok: false, reason: '未知收集目标' }
    } catch (error) {
      console.warn('[capture-hub] collect failed:', message(error))
      return { ok: false, reason: message(error) }
    }
  }

  return { open, commit, sourceForActiveTab }
}

export { createCaptureHub }
