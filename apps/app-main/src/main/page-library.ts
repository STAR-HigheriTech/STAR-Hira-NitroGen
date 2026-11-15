import path from 'node:path'
import fs from 'node:fs/promises'
import type { WebContents } from 'electron'
import { PAGE_ARCHIVE_FOLDER } from '@hira-ng/shared-types/src/page-library.mjs'
import { archiveContentUrl } from '@hira-ng/shared-types/src/archive-content.mjs'
import { parseWorkspaceRules } from '@hira-ng/shared-types/src/workspace-rules.mjs'

interface NotesPort {
  add(input: Record<string, unknown>): Record<string, unknown> | null
  get(id: string): Record<string, unknown> | null
  list(options?: { folderId?: string | null }): Array<Record<string, unknown>>
  search(query: string): Array<Record<string, unknown>>
  listFolders(): Array<{ id: string; name: string }>
  addFolder(input: { name: string }): string
}

interface SettingsPort {
  get(key: string): unknown
  set(key: string, value: unknown): unknown
}

interface TabsPort {
  getActiveTabId(): string | null
  getWebContents(tabId: string): WebContents | null | undefined
  list(): Array<Record<string, unknown>>
}

interface PageLibraryOptions {
  settings: SettingsPort
  notes: NotesPort
  getTabs(): TabsPort | null | undefined
  namedSessions?: { list(): Array<Record<string, unknown>> } | null
  downloads?: { list(limit?: number): Array<Record<string, unknown>> } | null
  getArchiveDir(): string
  slots?: { multi(id: string, payload: unknown): unknown[] } | null
  logger?: Pick<Console, 'warn'>
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function createPageLibrary(options: PageLibraryOptions) {
  const logger = options.logger || console

  function ensureArchiveFolder(): string {
    const existing = options.notes.listFolders().find((folder) => folder.name === PAGE_ARCHIVE_FOLDER)
    return existing?.id || options.notes.addFolder({ name: PAGE_ARCHIVE_FOLDER })
  }

  function activePage(): { tabId: string; url: string; title: string; wc: WebContents | null } | null {
    const tabs = options.getTabs()
    if (!tabs) return null
    const tabId = String(tabs.getActiveTabId() || '')
    if (!tabId) return null
    const row = tabs.list().find((tab) => String(tab.tabId || '') === tabId) || {}
    const wc = tabs.getWebContents(tabId) || null
    const url = wc && !wc.isDestroyed() ? wc.getURL() : String(row.url || '')
    const title = wc && !wc.isDestroyed() ? wc.getTitle() : String(row.title || '')
    return /^https?:\/\//i.test(url) ? { tabId, url, title: title || url, wc } : null
  }

  async function pageText(wc: WebContents | null | undefined): Promise<string> {
    if (!wc || wc.isDestroyed()) return ''
    try {
      const value = await wc.executeJavaScript(
        `String((document.querySelector('article,main,[role="main"]') || document.body || {}).innerText || '').trim().slice(0,100000)`,
        true
      )
      return String(value || '').slice(0, 100_000)
    } catch {
      return ''
    }
  }

  async function archiveActive(): Promise<{ ok: boolean; note?: Record<string, unknown>; reason?: string }> {
    const page = activePage()
    if (!page) return { ok: false, reason: '当前页面不支持归档' }
    try {
      const content = await pageText(page.wc)
      const providers = (options.slots?.multi('page.archive-provider', {
        url: page.url,
        title: page.title
      }) || [])
        .filter((item) => item && typeof item === 'object')
        .map((item) => item as Record<string, unknown>)
      for (const provider of providers) {
        if (typeof provider.capture !== 'function') continue
        try {
          const result = await provider.capture({
            url: page.url,
            title: page.title,
            content,
            webContents: page.wc
          }) as Record<string, unknown> | null | undefined
          if (result && result.ok !== false && result.note && typeof result.note === 'object') {
            return { ok: true, note: result.note as Record<string, unknown> }
          }
        } catch (error) {
          logger.warn?.('[page-library] archive provider failed:', errorMessage(error))
        }
      }
      const id = `archive-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
      const archiveDir = options.getArchiveDir()
      await fs.mkdir(archiveDir, { recursive: true })
      const archiveFile = path.join(archiveDir, `${id}.html`)
      try {
        if (!page.wc || page.wc.isDestroyed()) throw new Error('页面视图不可用')
        await page.wc.savePage(archiveFile, 'HTMLComplete')
      } catch {
        const html = page.wc && !page.wc.isDestroyed()
          ? String(await page.wc.executeJavaScript('document.documentElement.outerHTML', true)).slice(0, 8_000_000)
          : ''
        if (html) await fs.writeFile(archiveFile, html, 'utf8')
      }
      const note = options.notes.add({
        folderId: ensureArchiveFolder(),
        title: page.title,
        content: content || `来源：${page.url}`,
        url: page.url,
        kind: 'page',
        sourceTitle: page.title,
        tags: ['页面归档'],
        summary: content.slice(0, 500),
        assetPath: archiveFile
      })
      return note ? { ok: true, note } : { ok: false, reason: '归档写入失败' }
    } catch (error) {
      logger.warn?.('[page-library] archive failed:', errorMessage(error))
      return { ok: false, reason: errorMessage(error) }
    }
  }

  function archiveFolderId(): string {
    return options.notes.listFolders().find((folder) => folder.name === PAGE_ARCHIVE_FOLDER)?.id || ''
  }

  function listArchives(query = ''): Array<Record<string, unknown>> {
    const folderId = archiveFolderId()
    if (!folderId) return []
    const q = String(query || '').trim().toLowerCase()
    const seen = new Set<string>()
    return options.notes.list({ folderId })
      .filter((note) => !note.deletedAt)
      .filter((note) => {
        if (!q) return true
        return `${String(note.title || '')} ${String(note.url || '')} ${String(note.content || '')}`
          .toLowerCase()
          .includes(q)
      })
      .sort((a, b) => (Number(b.modifiedAt) || 0) - (Number(a.modifiedAt) || 0))
      .filter((note) => {
        const key = String(note.url || note.id || '')
        if (!key || seen.has(key)) return false
        seen.add(key)
        return true
      })
      .map((note): Record<string, unknown> => ({
        ...note,
        archiveUrl: note.assetPath ? archiveContentUrl(note.id) : ''
      }))
      .slice(0, 300)
  }

  function unified(query: string, limit = 8): Array<Record<string, unknown>> {
    const q = String(query || '').trim()
    if (!q) return []
    const lower = q.toLowerCase()
    const out: Array<Record<string, unknown>> = []
    const archiveFolder = archiveFolderId()
    for (const note of options.notes.search(q).slice(0, limit)) {
      out.push({
        type: 'website',
        id: `note:${note.id}`,
        title: String(note.title || '笔记'),
        url: String(note.folderId || '') === archiveFolder
          ? `hira://archive?id=${encodeURIComponent(String(note.id))}`
          : note.url && /^https?:\/\//i.test(String(note.url))
          ? String(note.url)
          : `hira://archive?id=${encodeURIComponent(String(note.id))}`,
        source: '笔记',
        relevance: 690
      })
    }
    for (const session of (options.namedSessions?.list?.() || []).filter((item) => String(item.name || '').toLowerCase().includes(lower)).slice(0, 3)) {
      out.push({
        type: 'website',
        id: `session:${session.id}`,
        title: `会话：${String(session.name || '')}`,
        url: `hira://sessions?search=${encodeURIComponent(String(session.name || ''))}`,
        source: '会话',
        relevance: 650
      })
    }
    for (const item of (options.downloads?.list?.(300) || []).filter((download) => `${download.filename || ''} ${download.url || ''}`.toLowerCase().includes(lower)).slice(0, 3)) {
      out.push({
        type: 'website',
        id: `download:${item.id}`,
        title: String(item.filename || item.url),
        url: `hira://downloads?search=${encodeURIComponent(String(item.filename || ''))}`,
        source: '下载',
        relevance: 630
      })
    }
    const rules = parseWorkspaceRules(options.settings.get('automation.workspace_rules'))
      .filter((rule) => `${rule.name} ${rule.match}`.toLowerCase().includes(lower)).slice(0, 3)
    for (const rule of rules) {
      out.push({ type: 'website', id: `rule:${rule.id}`, title: `规则：${rule.name}`, url: 'hira://automation#rules', source: '工作区', relevance: 620 })
    }
    return out.slice(0, limit)
  }

  return {
    listArchives,
    archiveActive,
    unified
  }
}

export { createPageLibrary }
