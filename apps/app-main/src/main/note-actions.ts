/**
 * 集锦 / 笔记的**动作层**（主进程唯一实现）。
 *
 * ══════════════════════════════════════════════════════════════════
 * 为什么要有这一层
 * ══════════════════════════════════════════════════════════════════
 * 同一件事（收页面、收图片、复制全部、导出…）有太多入口：
 * 快捷键、应用菜单、地址栏 `!命令`、命令链、鼠标手势、插件 API。
 * 早先每个入口各写一段"取活动标签 → 存 → 开面板"，改一处漏一处就是
 * "快捷键能收、手势收不进去"。本模块把九条 `note:*` 动作收成**一张表**，
 * 所有入口都只调 `run(action, params)`（或直接取 `actions[action]`）。
 *
 * 依赖全部通过**端口**注入，且一律是 getter / 函数 —— `notesAssets` 与
 * `panelCatalog` 在 main.js 里创建得比动作表晚（TDZ 陷阱），按值快照会拿到 undefined。
 *
 * 本模块**不认识窗口 / 面板目录 / 快捷键**：
 *   · getTabs() 给标签；showPanel() 开面板；emit() 广播；
 *   · 落点解析、去重、缩略图全部复用 browser-window-assembly 的 capture* 函数
 *     （与页面右键四项菜单**逐字同一套**实现）。
 */

import { clipboard, type BrowserWindow, type WebContents } from 'electron'
import type { Note, NoteFolder, NoteService } from '@hira-ng/domain-notes'
const {
  serializeNotes,
  notesToPlainText,
  sortNotesForDisplay
} = require('@hira-ng/shared-types/src/notes.mjs')
// 「算不算普通网页」的唯一判据（内部页 / 空页收进集锦没有意义）。
const { isHttpUrl } = require('@hira-ng/shared-types/src/url-protocols.mjs')
const { saveNotesFile } = require('./notes-export-file') as {
  saveNotesFile(input: { format: string; filename: string; content: string; win?: BrowserWindow | null }): unknown
}
const {
  capturePageIntoCollection,
  captureImageIntoCollection,
  captureSelectionIntoCollection
} = require('./browser-window-assembly') as {
  capturePageIntoCollection(
    service: NoteService,
    assets: NotesAssetsPort | null,
    target: NormalizedNoteTarget,
    input: { url: string; title: string; sourceTitle: string; webContents: WebContents | null }
  ): Promise<Note | null>
  captureImageIntoCollection(
    service: NoteService,
    assets: NotesAssetsPort | null,
    target: NormalizedNoteTarget,
    input: { url?: string; referer?: string; title?: string; sourceTitle?: string }
  ): Promise<Note | null>
  captureSelectionIntoCollection(
    service: NoteService,
    target: NormalizedNoteTarget,
    input: { text: string; url: string; sourceTitle: string }
  ): Promise<Note | null>
}
// 面板 id 的唯一真源（集锦面板 = 集锦 / 全部 / 稍后读 / 回收站）。
const { NOTES_PANEL_ID } = require('./notes-panel') as { NOTES_PANEL_ID: string }

interface NoteActionParams {
  target?: NormalizedNoteTarget
  folderId?: string | null
  folderName?: string
  reveal?: boolean
  tabId?: string
  url?: string
  title?: string
  sourceTitle?: string
  referer?: string
  dataUrl?: string
  text?: string
  format?: string
  filename?: string
  noteId?: string
  section?: string
  [key: string]: unknown
}

type NormalizedNoteTarget =
  | { kind: 'new'; name?: string }
  | { kind: 'folder'; folderId: string }
  | { kind: 'unfiled' }

interface NotesAssetsPort {
  saveBufferFromDataUrl(input: { dataUrl: string }): Promise<{
    ok?: boolean
    thumbPath?: string
    assetPath?: string | null
    assetMime?: string
    assetWidth?: number
    assetHeight?: number
  } | null>
}

interface TabPage {
  tabId: string
  url: string
  title: string
  wc: WebContents | null
}

interface TabsPort {
  getActiveTabId?(): string | null
  getWebContents?(tabId: string): WebContents | null | undefined
  list(): Array<Record<string, unknown>>
  newTab?(options: { url: string }): unknown | Promise<unknown>
}

export interface NoteActionPorts {
  getNotesService?(): NoteService | null | undefined
  getNotesAssets?(): NotesAssetsPort | null | undefined
  getTabs?(): TabsPort | null | undefined
  getWindow?(): BrowserWindow | null | undefined
  showPanel?(panelId: string): boolean | null
  emit?(route: string, payload: unknown): void
  copyText?(text: string): void
}

/**
 * 集锦名（导出标题 / 默认文件名）。
 * @param {any} notesService
 * @param {string|null} folderId
 */
function folderNameOf(notesService: NoteService | null, folderId: string | null): string {
  if (!folderId) return '未归档'
  if (!notesService) return '集锦'
  try {
    const rows = notesService.listFolders()
    const hit = (Array.isArray(rows) ? rows : []).find((f) => f && String(f.id) === String(folderId))
    return hit && hit.name ? String(hit.name) : '集锦'
  } catch (_) {
    return '集锦'
  }
}

/**
 * 把动作参数里的「落点」归一成 capture* 认识的 `{ kind, folderId }`。
 *
 * 三态口径与面板 / 右键菜单一致：
 *   · `params.target` 显式对象 → 原样（高级调用/插件用）；
 *   · `params.folderId` 省略 / null / '' → 未归档；
 *   · `'new'` → 新建集锦（名字取 `params.folderName`）；
 *   · 其它字符串 → 那个集锦。
 * @param {any} params
 */
function normalizeTarget(params?: NoteActionParams | null): NormalizedNoteTarget {
  const p = params && typeof params === 'object' ? params : {}
  if (p.target && typeof p.target === 'object') return p.target
  if (p.folderId === 'new') return { kind: 'new' }
  if (typeof p.folderId === 'string' && p.folderId) return { kind: 'folder', folderId: p.folderId }
  return { kind: 'unfiled' }
}

/** `params` 是否显式限定了集锦（决定列出「全部」还是「某一集锦」）。 */
function hasFolderScope(params?: NoteActionParams | null): boolean {
  return Boolean(params && typeof params === 'object'
    && Object.prototype.hasOwnProperty.call(params, 'folderId')
    && params.folderId !== 'new')
}

/**
 * 某个集锦里的卡片（顺序与面板逐字一致 —— 见 shared-types#sortNotesForDisplay）。
 * `folderId` 省略 = 全部卡片。
 * @param {any} notesService
 * @param {any} params
 */
function listCards(notesService: NoteService | null, params: NoteActionParams = {}): Note[] {
  if (!notesService) return []
  let rows: Note[] = []
  try {
    rows = hasFolderScope(params)
      ? notesService.list({ folderId: params.folderId == null || params.folderId === '' ? null : String(params.folderId) })
      : notesService.list({})
  } catch (_) {
    rows = []
  }
  return sortNotesForDisplay(Array.isArray(rows) ? rows : []) as Note[]
}

/** 活动标签的 `{ url, title, wc }`（不猜：活动标签只有 TabManager 是权威）。 */
function activePage(tabs: TabsPort | null | undefined): TabPage | null {
  if (!tabs) return null
  let id = ''
  try { id = tabs.getActiveTabId ? String(tabs.getActiveTabId() || '') : '' } catch (_) { id = '' }
  if (!id) return null
  let wc: WebContents | null = null
  try { wc = typeof tabs.getWebContents === 'function' ? (tabs.getWebContents(id) ?? null) : null } catch (_) { wc = null }
  if (!wc) return null
  let url = ''
  let title = ''
  try { url = String(wc.getURL() || '') } catch (_) { url = '' }
  try { title = String(wc.getTitle() || '') } catch (_) { title = '' }
  return { tabId: id, url, title, wc }
}

/** 标签记录（休眠标签没有活体 wc，但仍能收到卡片里 —— 与 ipc/notes.js 的口径一致）。 */
function tabPage(tabs: TabsPort | null | undefined, tabId?: string | null): TabPage | null {
  if (!tabs) return null
  const id = String(tabId || '')
  if (!id) return activePage(tabs)
  let wc = null
  try { wc = typeof tabs.getWebContents === 'function' ? (tabs.getWebContents(id) ?? null) : null } catch (_) { wc = null }
  let url = ''
  let title = ''
  try { url = wc ? String(wc.getURL() || '') : '' } catch (_) { url = '' }
  try { title = wc ? String(wc.getTitle() || '') : '' } catch (_) { title = '' }
  if (!url) {
    try {
      const rec = tabs.list().find((t) => t && String(t.tabId) === id)
      if (rec) { url = String(rec.url || ''); title = title || String(rec.title || '') }
    } catch (_) {}
  }
  return { tabId: id, url, title, wc }
}

/**
 * @param {object} deps
 * @param {() => any} deps.getNotesService 笔记域服务（延迟解析）
 * @param {() => any} deps.getNotesAssets 图片资产服务（延迟解析：它比动作表晚建）
 * @param {() => any} deps.getTabs 当前目标窗口的 TabManager（延迟解析：焦点窗口会变）
 * @param {() => any} [deps.getWindow] 当前目标窗口（导出保存框的父窗口 / 定向广播）
 * @param {(panelId: string) => boolean|null} [deps.showPanel] 打开（而非 toggle）面板；
 *   返回值回答「它**事先**是不是就开着」：`true` 已开、`false` 本次新开、`null` 面板不存在。
 *   为什么需要这个布尔：面板是独立 renderer，新开时订阅还没挂上（见 revealInPanel）。
 * @param {(route: string, payload: any) => void} [deps.emit] 窗口级广播（已按 windowId 定向）
 * @param {(text: string) => void} [deps.copyText] 剪贴板端口（缺省用 electron clipboard；便于测试/替代）
 */
export function createNoteActions({
  getNotesService,
  getNotesAssets,
  getTabs,
  getWindow,
  showPanel,
  emit,
  copyText
}: NoteActionPorts = {}) {
  const notes = (): NoteService | null => {
    try { return getNotesService?.() ?? null } catch (_) { return null }
  }
  const assets = (): NotesAssetsPort | null => {
    try { return getNotesAssets?.() ?? null } catch (_) { return null }
  }
  const tabs = (): TabsPort | null => {
    try { return getTabs?.() ?? null } catch (_) { return null }
  }
  const win = (): BrowserWindow | null => {
    try { return getWindow?.() ?? null } catch (_) { return null }
  }

  const writeClipboard = (text: unknown): boolean => {
    const value = String(text == null ? '' : text)
    try {
      if (typeof copyText === 'function') { copyText(value); return true }
      clipboard.writeText(value)
      return true
    } catch (_) {
      return false
    }
  }

  /**
   * open-view 载荷的按窗口暂存槽（仅"面板本次才打开"时有值，见 revealInPanel）。
   * 键 = `BrowserWindow.id`；值 = `{ at, body }`（at 用于 TTL 判定）。
   */
  const pendingViews = new Map<string, { at: number; body: Record<string, unknown> }>()
  /** 槽的有效期：面板加载通常在 1s 内；留 5s 既容忍慢盘，又保证过期后不会莫名跳卡。 */
  const PENDING_VIEW_TTL_MS = 5000

  /**
   * 「让这次操作看得见」：打开面板并告诉它去哪一节 / 哪张卡。
   *
   * ⚠ **两条投递路径**（必须都在，缺一条就有"收录完没定位"）：
   *   1. 面板**已经开着** → renderer 活着、订阅在 → `note:open-view` 事件直达；
   *   2. 面板**本次才打开** → 它的 renderer 正在加载，事件会丢 → 先把载荷放进
   *      本窗口的 pending 槽，面板挂载后自己调 `note:take-open-view` 来取（见 takePendingView）。
   * 两条路径由 `showPanel` 的返回值（事先是否已开）判定，不靠时序猜。
   */
  function revealInPanel(payload: Record<string, unknown> = {}): void {
    const body: Record<string, unknown> = { ...payload }
    if (body.folderId === undefined || body.folderId === null) delete body.folderId
    let wasOpen = null
    try { if (typeof showPanel === 'function') wasOpen = showPanel(NOTES_PANEL_ID) } catch (_) { wasOpen = null }
    if (wasOpen === false) {
      const targetWindow = win()
      const id = targetWindow && targetWindow.id
      if (id != null) {
        const now = Date.now()
        // 顺手清过期项：槽只在"面板加载完成"那一小段有意义，久留只会在下次打开时莫名跳卡。
        for (const [key, entry] of pendingViews) {
          if (now - entry.at > PENDING_VIEW_TTL_MS) pendingViews.delete(key)
        }
        pendingViews.set(String(id), { at: now, body })
      }
    }
    try { if (typeof emit === 'function') emit('note:open-view', body) } catch (_) {}
  }

  /**
   * 面板挂载后拉取「上一次 open-view 意图」，取完即清。
   * @param {number|string} windowId
   * @returns {any|null} `{ folderId?, noteId?, section?, open? }`；没有 / 已过期 → null
   */
  function takePendingView(windowId: number | string): Record<string, unknown> | null {
    const key = String(windowId == null ? '' : windowId)
    if (!key) return null
    const hit = pendingViews.get(key)
    if (!hit) return null
    pendingViews.delete(key)
    return Date.now() - hit.at > PENDING_VIEW_TTL_MS ? null : hit.body
  }

  /**
   * 收一张页面卡（活动标签 / 指定标签 / 显式 url）。
   * @param {{ tabId?: string, url?: string, title?: string, target?: any, folderId?: any, folderName?: string, reveal?: boolean }} params
   */
  async function savePage(params: NoteActionParams = {}) {
    const service = notes()
    if (!service) return { ok: false, error: 'notes-service-unavailable' }
    const tm = tabs()
    let source = null
    if (params && params.url) {
      const active = activePage(tm)
      const wc = params.tabId
        ? tabPage(tm, params.tabId)?.wc
        : active && active.url === String(params.url) ? active.wc : null
      source = { url: String(params.url), title: String(params.title || params.url), wc: wc ?? null }
    } else {
      source = tabPage(tm, params && params.tabId)
    }
    if (!source) return { ok: false, error: 'not-a-web-page' }
    const url = source && source.url ? String(source.url) : ''
    // 内部页 / 空页收进集锦没有意义 —— 与 collectCurrentPage 的判据一字不差。
    if (!isHttpUrl(url)) return { ok: false, error: 'not-a-web-page' }
    const target = normalizeTarget(params)
    const note = await capturePageIntoCollection(service, assets(), target, {
      url,
      title: source.title || url,
      sourceTitle: source.title || url,
      webContents: source.wc
    })
    if (note && (params.reveal === true)) {
      revealInPanel({ folderId: note.folderId || undefined, noteId: note.id, section: 'collections' })
    }
    return note ? { ok: true, note } : { ok: false, error: 'capture-failed' }
  }

  /**
   * 收一张图片卡：优先 URL（带 referer），其次 dataURL（粘贴 / 拖放的字节）。
   * 抓不到就退成 page 卡（集锦不是图床；"点了没反应"最糟）——与右键菜单同一降级。
   */
  async function saveImage(params: NoteActionParams = {}) {
    const service = notes()
    if (!service) return { ok: false, error: 'notes-service-unavailable' }
    const target = normalizeTarget(params)
    const url = String(params.url || '')
    if (url) {
      const note = await captureImageIntoCollection(service, assets(), target, {
        url,
        referer: params.referer ? String(params.referer) : '',
        title: params.title ? String(params.title) : '',
        sourceTitle: params.sourceTitle ? String(params.sourceTitle) : ''
      })
      if (note && params.reveal === true) {
        revealInPanel({ folderId: note.folderId || undefined, noteId: note.id, section: 'collections' })
      }
      return note ? { ok: true, note } : { ok: false, error: 'capture-failed' }
    }
    const a = assets()
    const dataUrl = String(params.dataUrl || '')
    if (a && dataUrl) {
      let asset = null
      try { asset = await a.saveBufferFromDataUrl({ dataUrl }) } catch (_) { asset = null }
      if (asset && asset.ok && asset.thumbPath) {
        const note = await service.addCaptured({
          kind: 'image',
          url: '',
          title: String(params.title || params.sourceTitle || '图片'),
          sourceTitle: params.sourceTitle ? String(params.sourceTitle) : '',
          assetPath: asset.assetPath || null,
          assetMime: asset.assetMime || 'image/png',
          assetWidth: asset.assetWidth || 0,
          assetHeight: asset.assetHeight || 0,
          thumbPath: asset.thumbPath,
          folderId: await resolveFolderId(service, target)
        })
        if (note && params.reveal === true) {
          revealInPanel({ folderId: note.folderId || undefined, noteId: note.id, section: 'collections' })
        }
        return note ? { ok: true, note } : { ok: false, error: 'capture-failed' }
      }
    }
    return { ok: false, error: 'not-an-image' }
  }

  /** 目标 → folderId（'new' 会真的建一个集锦；名字取 folderName）。 */
  async function resolveFolderId(service: NoteService, target: NormalizedNoteTarget | null): Promise<string | null> {
    if (!target) return null
    if (target.kind === 'folder') return target.folderId || null
    if (target.kind === 'new') {
      try {
        const created = service.addFolder({ name: String(target.name || '新集锦') })
        return typeof created === 'string' ? created : null
      } catch (_) {
        return null
      }
    }
    return null
  }

  /**
   * 收一段文字：`params.text` 优先；否则取活动页当前选区。
   * 纯文本 → 一条真正的笔记卡；带来源 → 自带出处与定位 URL（复用 assembly 的实现）。
   */
  async function saveText(params: NoteActionParams = {}) {
    const service = notes()
    if (!service) return { ok: false, error: 'notes-service-unavailable' }
    const page = activePage(tabs())
    let text = String(params.text || '')
    if (!text.trim() && page && page.wc) {
      try {
        text = String(await page.wc.executeJavaScript(
          'String(window.getSelection ? window.getSelection().toString() : "")', true
        ) || '')
      } catch (_) {
        text = ''
      }
    }
    if (!text.trim()) return { ok: false, error: 'empty-selection' }
    const target = normalizeTarget(params)
    const note = await captureSelectionIntoCollection(service, target, {
      text,
      url: params.url ? String(params.url) : (page ? page.url : ''),
      sourceTitle: params.sourceTitle ? String(params.sourceTitle) : (page ? page.title : '')
    })
    if (note && params.reveal === true) {
      revealInPanel({ folderId: note.folderId || undefined, noteId: note.id, section: 'collections' })
    }
    return note ? { ok: true, note } : { ok: false, error: 'capture-failed' }
  }

  /** 新建一张空备注卡，并直接进编辑器。 */
  async function addNote(params: NoteActionParams = {}) {
    const service = notes()
    if (!service) return { ok: false, error: 'notes-service-unavailable' }
    const folderId = await resolveFolderId(service, normalizeTarget(params))
    const note = await service.add({
      kind: 'note',
      title: '',
      content: '',
      folderId
    })
    if (note && note.id) {
      // `open:true` = 新卡是空白的，用户下一步就是写 —— 直接进编辑器（其余动作只高亮）。
      revealInPanel({ folderId: folderId || undefined, noteId: note.id, section: 'collections', open: true })
    }
    return note ? { ok: true, note } : { ok: false, error: 'create-failed' }
  }

  /** 把一组卡片里的网页逐个开成新标签（经典集锦「全部打开」）。 */
  async function openAll(params: NoteActionParams = {}) {
    const cards = listCards(notes(), params).filter((n) => n && n.kind === 'page' && n.url)
    const tm = tabs()
    if (!tm || typeof tm.newTab !== 'function') return { ok: false, error: 'tabs-unavailable', count: 0 }
    let opened = 0
    for (const card of cards) {
      try {
        await tm.newTab({ url: String(card.url) })
        opened += 1
      } catch (_) {}
    }
    return { ok: true, count: opened }
  }

  /** 复制一组卡片：默认纯文本；`format:'md'` 走 Markdown（带集锦名标题）。 */
  function copyAll(params: NoteActionParams = {}) {
    const service = notes()
    const cards = listCards(service, params)
    if (!cards.length) return { ok: false, error: 'empty', count: 0 }
    const format = String(params.format || 'text')
    const heading = hasFolderScope(params) && params.folderId ? folderNameOf(service, String(params.folderId)) : ''
    const text = format === 'md'
      ? serializeNotes(cards, 'md', heading)
      : notesToPlainText(cards)
    const ok = writeClipboard(text)
    return { ok, count: cards.length }
  }

  /** 导出一组卡片到文件（md / html / json；未知格式按 md 兜底）。 */
  async function exportNotes(params: NoteActionParams = {}) {
    const service = notes()
    const cards = listCards(service, params)
    if (!cards.length) return { ok: false, error: 'empty' }
    const format = String(params.format || 'md').toLowerCase()
    const fmt = format === 'html' || format === 'json' ? format : 'md'
    const folderId = hasFolderScope(params) && params.folderId ? String(params.folderId) : null
    const name = folderId ? folderNameOf(service, folderId) : '集锦'
    const content = serializeNotes(cards, fmt, name)
    const filename = params.filename ? String(params.filename) : `${name}.${fmt}`
    return saveNotesFile({ format: fmt, filename, content, win: win() })
  }

  /** 打开集锦面板（可选直达某集锦 / 某张卡）。 */
  function openPanel(params: NoteActionParams = {}) {
    const payload: Record<string, unknown> = {}
    if (params && params.folderId) payload.folderId = String(params.folderId)
    if (params && params.noteId) payload.noteId = String(params.noteId)
    if (params && params.section) payload.section = String(params.section)
    revealInPanel(payload)
    return { ok: true }
  }

  /**
   * 动作表：键 = 动作命名空间里的 id，值 = 无参函数（快捷键 / 菜单直接调用）。
   * 带参数的高级用法走 `run(action, params)`。
   */
  const actions = {
    'note:save-page': () => { savePage({ reveal: true }).catch(() => {}) },
    'note:save-tab': () => { savePage({ reveal: true }).catch(() => {}) },
    'note:save-image': () => { saveImage({ reveal: true }).catch(() => {}) },
    'note:save-text': () => { saveText({ reveal: true }).catch(() => {}) },
    'note:add-note': () => { addNote({ reveal: true }).catch(() => {}) },
    'note:open-all': () => { openAll({}).catch(() => {}) },
    'note:copy-all': () => { copyAll({}) },
    'note:export': () => { exportNotes({}).catch(() => {}) },
    'note:open-panel': () => { openPanel({}) }
  }

  /**
   * 带参数的统一入口（命令链 / 手势 / 插件 API / 地址栏 `note:<action>`）。
   * @param {string} action
   * @param {any} [params]
   */
  async function run(action: string, params: NoteActionParams = {}) {
    switch (action) {
      case 'note:save-page': return savePage({ ...params, reveal: params.reveal !== false })
      case 'note:save-tab': return savePage({ ...params, reveal: params.reveal !== false })
      case 'note:save-image': return saveImage({ ...params, reveal: params.reveal !== false })
      case 'note:save-text': return saveText({ ...params, reveal: params.reveal !== false })
      case 'note:add-note': return addNote({ ...params, reveal: params.reveal !== false })
      case 'note:open-all': return openAll(params)
      case 'note:copy-all': return copyAll(params)
      case 'note:export': return exportNotes(params)
      case 'note:open-panel': return openPanel(params)
      default: return { ok: false, error: `unknown-action:${action}` }
    }
  }

  return { actions, run, takePendingView }
}

