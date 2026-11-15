/**
 * 面板数据中心（Panel Data）—— 侧栏面板**数据面**的统一读取入口。
 *
 * ══════════════════════════════════════════════════════════════════════
 * 为什么需要它
 * ══════════════════════════════════════════════════════════════════════
 * 面板是「视图」，不是「数据」。以前 AI 想读"收藏面板里有什么"只能分别调
 * `bookmark_list` / `history_list` / …，而且那些工具只回了模型需要的一小撮字段，
 * 像书签的「固定（pinned / railPinned / openInSidebar）」、标签、摘要全都拿不到。
 *
 * 本模块把「每个面板 → 它的数据从哪来」收敛成**一张 provider 表**：
 *   · 内置 provider 只做「调用域服务 + 归一化字段」，不复制任何业务逻辑；
 *   · 插件可通过扩展点 `panel.data.provider` 补充 / 覆盖（同一 panelId 后者优先）；
 *   · 返回值统一成 `{ panelId, title, kind, available, total, returned, items, meta }`。
 *
 * 面板自身的**宿主状态**（开在哪一侧 / 是否固定 / 是否拆成独立窗口）也一并收在这里，
 * 让 `panel_list` 只调一个端口就能拿到「状态 + 是否有数据」。
 */

'use strict'

const { PAGE_INJECT_SETTING_KEYS, parseInjectRules } = require('@hira-ng/shared-types/src/page-inject.mjs')
const {
  EASEL_SETTING_KEY,
  EASEL_ACTIVE_BOARD_SETTING_KEY,
  parseBoards
} = require('@hira-ng/shared-types/src/easel.mjs')

type DataRow = Record<string, unknown>
type ServiceMethod = (...args: unknown[]) => unknown
type PanelService = Record<string, ServiceMethod>

interface PanelArgs {
  parentId?: string | null
  folderId?: string | null
  limit?: number
}

interface DomainServices extends Partial<Record<
  'bookmarkService' | 'notesService' | 'historyService' | 'downloadService' |
  'extensionService' | 'pluginHost' | 'themeService' | 'spaceService' |
  'namedSessions' | 'tabManager' | 'totpService' | 'settingsService' |
  'permissionService',
  PanelService
>> {
  getProfileId?: () => string
}

interface PanelLayoutPort {
  getPanelSideOf?(panelId: string): string | null
  isPanelPinned?(panelId: string): boolean
}

interface PanelPresentationPort {
  isDetached?(panelId: string): boolean
}

interface ExtensionPointsPort {
  callSync(name: string, payload: Record<string, unknown>): unknown
}

interface PanelDataContext {
  services: DomainServices
  layout: PanelLayoutPort | null
  presentation: PanelPresentationPort | null
  windowCount: number
}

interface PanelDataProvider {
  panelIds: readonly string[]
  kind?: string
  read(args: PanelArgs, context: PanelDataContext): unknown | Promise<unknown>
}

interface PluginPanelProvider {
  panelId?: string
  panelIds?: readonly string[]
  kind?: string
  read(args: PanelArgs, context: PanelDataContext): unknown | Promise<unknown>
}

interface PanelDescriptor {
  id: string
  title?: string
  opensPage?: string
  opensWindow?: string
  hostPage?: string
  [key: string]: unknown
}

export interface PanelDataOptions {
  getPanels?(): readonly PanelDescriptor[]
  getDomainServices?(): DomainServices | null | undefined
  getLayout?(): PanelLayoutPort | null | undefined
  getPanelPresentation?(): PanelPresentationPort | null | undefined
  getWindowCount?(): number
  extensionPoints?: ExtensionPointsPort | null
  logger?: { warn?(...args: unknown[]): void }
}

function asRow(value: unknown): DataRow {
  return value !== null && typeof value === 'object' ? value as DataRow : {}
}

function asRows(value: unknown): DataRow[] {
  return Array.isArray(value) ? value.map(asRow) : []
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** 单次读取返回的条目上限（再多对模型没价值，只会撑上下文）。 */
export const MAX_ITEMS = 200

/** 没有数据面时的统一说明。 */
export const NO_DATA_NOTE = '该面板是纯视图，数据只存在于渲染进程或独立窗口，主进程侧没有可读数据面。'

/**
 * 个别面板的数据确实不在主进程，但"为什么读不到 + 改用什么"值得说清楚，
 * 让模型不至于反复重试同一个 panelId。
 */
const NO_DATA_NOTES: Readonly<Record<string, string>> = Object.freeze({
  'live-folders-panel':
    '「实时更新」的条目由渲染进程按所选新闻源联网抓取、并缓存在渲染进程 localStorage，主进程没有副本。'
    + '想了解新闻内容请改用 web_search / web_fetch；想看某个条目直接 tab_open 它的地址。',
  'qr-scanner-panel':
    '「扫码器」是即时的摄像头取景，扫描结果不落盘，所以没有可读的历史数据。'
    + '如需识别图片里的二维码，让用户先把图片发到会话里，再用 page_screenshot / 视觉能力处理。'
})

/**
 * 一行摘录（压掉换行与连续空白，超长截断）。
 * @param {any} text @param {number} max
 */
function clip(text: unknown, max: number): string {
  const s = String(text == null ? '' : text).replace(/\s+/g, ' ').trim()
  return s.length > max ? `${s.slice(0, max)}…` : s
}

function bool(value: unknown): boolean {
  return !!value
}

/** 仅供 provider 用的安全调用（服务缺失时返回默认值，不抛）。 */
function safe<T>(fn: () => T, fallback: T): T {
  try {
    const value = fn()
    return value == null ? fallback : value
  } catch (_) {
    return fallback
  }
}

/**
 * 书签节点的统一形状（域服务已经做过 tags / 三个布尔位的归一化）。
 * @param {any} row @param {string} folder
 */
function bookmarkNode(row: DataRow, folder: string): Record<string, unknown> {
  const isFolder = !row.url
  return {
    id: row.id,
    type: isFolder ? 'folder' : 'bookmark',
    title: row.title || '',
    nickname: row.nickname || null,
    url: row.url || '',
    folder: folder || '',
    // ── 细节标签：这就是以前 AI 读不到的「固定」三兄弟 ──
    pinned: bool(row.pinned),
    railPinned: bool(row.railPinned),
    openInSidebar: bool(row.openInSidebar),
    tags: Array.isArray(row.tags) ? row.tags : [],
    summary: row.summary ? clip(row.summary, 240) : '',
    hasSummary: !!row.summary,
    createdAt: Number.isFinite(row.createdAt) ? row.createdAt : null,
    modifiedAt: Number.isFinite(row.modifiedAt) ? row.modifiedAt : null
  }
}

/**
 * 把书签树拍平成「带 folder 路径」的线性表。
 * @param {any[]} nodes @param {string} path @param {any[]} out
 */
function flattenBookmarks(nodes: unknown, path: string, out: Array<Record<string, unknown>>): void {
  for (const node of asRows(nodes)) {
    if (out.length >= MAX_ITEMS) return
    const folder = path || ''
    out.push(bookmarkNode(node, folder))
    if (Array.isArray(node.children) && node.children.length) {
      const title = String(node.title || '')
      const next = folder ? `${folder}/${title}` : title
      flattenBookmarks(node.children, next, out)
    }
  }
}

/** 标签页的完整投影（与 TabManager#_projectTab 同字段，AI 需要知道休眠 / 静音 / 栈）。 */
function tabNode(tab: DataRow, activeId: unknown): Record<string, unknown> {
  return {
    tabId: tab.tabId,
    title: tab.title || '',
    url: tab.url || '',
    active: tab.tabId === activeId,
    pinned: bool(tab.pinned),
    muted: bool(tab.muted),
    playing: bool(tab.isPlaying),
    sleeping: bool(tab.sleeping),
    loading: bool(tab.loading),
    incognito: bool(tab.incognito),
    containerProfileId: tab.containerProfileId || null,
    spaceId: tab.spaceId || null,
    stackId: tab.stackId || null,
    splitId: tab.splitId || null,
    glanceId: tab.glanceId || null,
    canGoBack: bool(tab.canGoBack),
    canGoForward: bool(tab.canGoForward),
    position: Number.isFinite(tab.position) ? tab.position : null,
    favicon: tab.favicon || '',
    lastActivated: Number.isFinite(tab.lastActivated) ? tab.lastActivated : null
  }
}

/**
 * 内置 provider 表。
 *
 * 每条 = `{ panelIds, kind, read(args, ctx) }`：
 *   · `panelIds` 覆盖同一份数据的多个面板 id（例如概览聚合）；
 *   · `read` 只调域服务 + 归一化字段，绝不在这里写业务规则。
 */
const BUILTIN_PROVIDERS: readonly PanelDataProvider[] = [
  {
    panelIds: ['favorites-panel'],
    kind: 'tree',
    async read(args: PanelArgs, ctx: PanelDataContext) {
      const svc = ctx.services.bookmarkService
      if (!svc || typeof svc.snapshot !== 'function') throw new Error('书签服务不可用')
      const parentId = args.parentId == null || args.parentId === '' ? null : String(args.parentId)
      const snap = asRow(await svc.snapshot({ parentId }))
      const items: Array<Record<string, unknown>> = []
      flattenBookmarks(parentId ? snap.items : snap.folders, '', items)
      return {
        items,
        total: items.length,
        meta: {
          parentId: snap.parentId ?? null,
          // 「固定到书签栏」的那一组（顺序即 pinnedOrder）—— 与 rail 固定是两个独立概念
          pinned: asRows(snap.pinned).map((row) => bookmarkNode(row, '')),
          pinnedOrder: Array.isArray(snap.pinnedOrder) ? snap.pinnedOrder : []
        }
      }
    }
  },
  {
    panelIds: ['notes-panel'],
    kind: 'cards',
    async read(args: PanelArgs, ctx: PanelDataContext) {
      const svc = ctx.services.notesService
      if (!svc || typeof svc.list !== 'function') throw new Error('集锦服务不可用')
      const options: Record<string, unknown> = {}
      if (args.folderId != null && String(args.folderId).trim()) options.folderId = String(args.folderId).trim()
      const rows = await svc.list(options)
      const folders = typeof svc.listFolders === 'function' ? await svc.listFolders() : []
      const items = asRows(rows).map((n) => ({
        id: n.id,
        title: n.title || '',
        kind: n.kind || 'note',
        url: n.url || '',
        folderId: n.folderId || null,
        tags: Array.isArray(n.tags) ? n.tags : [],
        color: n.color || null,
        pinned: bool(n.pinned),
        sourceTitle: n.sourceTitle || null,
        excerpt: clip(n.content, 200),
        deletedAt: n.deletedAt || null,
        createdAt: n.createdAt || null,
        modifiedAt: n.modifiedAt || null
      }))
      return {
        items,
        total: items.length,
        meta: { folders: Array.isArray(folders) ? folders : [] }
      }
    }
  },
  {
    panelIds: ['history-panel'],
    kind: 'list',
    async read(args: PanelArgs, ctx: PanelDataContext) {
      const svc = ctx.services.historyService
      if (!svc || typeof svc.listRecent !== 'function') throw new Error('历史服务不可用')
      const rows = await svc.listRecent(MAX_ITEMS)
      const items = asRows(rows).map((r) => ({
        id: r.id || r.historyId || '',
        title: r.title || '',
        url: r.url || '',
        favicon: r.favicon || '',
        visitedAt: r.lastVisitAt || r.lastVisitTime || null,
        visitCount: r.visitCount || 1
      }))
      return { items, total: items.length }
    }
  },
  {
    panelIds: ['downloads-panel'],
    kind: 'list',
    async read(args: PanelArgs, ctx: PanelDataContext) {
      const svc = ctx.services.downloadService
      if (!svc || typeof svc.list !== 'function') throw new Error('下载服务不可用')
      const rows = await svc.list()
      const items = asRows(rows).map((d) => ({
        id: d.id,
        filename: d.filename || '',
        url: d.url || '',
        state: d.state || '',
        receivedBytes: Number(d.receivedBytes) || 0,
        totalBytes: Number.isFinite(d.totalBytes) ? d.totalBytes : null,
        mimeType: d.mimeType || null,
        danger: d.danger || 'safe',
        startedAt: d.startedAt || null,
        completedAt: d.completedAt || null
      }))
      return { items, total: items.length }
    }
  },
  {
    panelIds: ['extensions-panel'],
    kind: 'list',
    async read(args: PanelArgs, ctx: PanelDataContext) {
      const svc = ctx.services.extensionService
      if (!svc || typeof svc.listExtensions !== 'function') throw new Error('扩展服务不可用')
      const rows = await svc.listExtensions()
      const items = asRows(rows).map((e) => ({
        id: e.id,
        name: e.name || '',
        version: e.version || '',
        description: e.description ? clip(e.description, 160) : '',
        enabled: e.enabled !== false,
        pinned: bool(e.pinned),
        isExtension: e.isExtension !== false,
        path: e.path || '',
        errors: Array.isArray(e.errors) ? e.errors.slice(0, 5) : []
      }))
      return { items, total: items.length }
    }
  },
  {
    panelIds: ['plugins-panel'],
    kind: 'list',
    async read(args: PanelArgs, ctx: PanelDataContext) {
      const host = ctx.services.pluginHost
      if (!host || typeof host.list !== 'function') throw new Error('插件注册中心尚未就绪')
      const rows = await host.list()
      const items = asRows(rows).map((p) => ({
        id: p.id,
        name: p.name || p.id,
        version: p.version || '',
        description: p.description ? clip(p.description, 160) : '',
        enabled: p.enabled !== false,
        isFirstParty: !!p.isFirstParty,
        autoDisabled: !!p.autoDisabled,
        autoDisabledReason: p.autoDisabledReason || '',
        trustLevel: p.trustLevel || '',
        contributes: p.contributes && typeof p.contributes === 'object'
          ? Object.fromEntries(Object.entries(p.contributes).map(([k, v]) => [k, Array.isArray(v) ? v.length : 1]))
          : {}
      }))
      return { items, total: items.length }
    }
  },
  {
    panelIds: ['themes-panel'],
    kind: 'list',
    async read(args: PanelArgs, ctx: PanelDataContext) {
      const svc = ctx.services.themeService
      if (!svc || typeof svc.list !== 'function') throw new Error('主题服务不可用')
      const rows = svc.list() || []
      const isDark = typeof svc.isDark === 'function' ? svc.isDark.bind(svc) : () => false
      const items = asRows(rows).map((t) => ({
        id: t.id,
        name: t.name || t.id,
        source: t.source || 'builtin',
        pluginId: t.pluginId || null,
        dark: safe(() => !!isDark(t), false)
      }))
      const activeId = typeof svc.getActiveId === 'function' ? svc.getActiveId() : null
      return {
        items,
        total: items.length,
        meta: {
          activeId,
          active: activeId ? items.find((t) => t.id === activeId) || null : null,
          userThemes: typeof svc.listUserThemes === 'function' ? asRows(svc.listUserThemes()).map((t) => String(t.id || '')) : []
        }
      }
    }
  },
  {
    panelIds: ['spaces-panel'],
    kind: 'list',
    async read(args: PanelArgs, ctx: PanelDataContext) {
      const svc = ctx.services.spaceService
      if (!svc) throw new Error('空间服务不可用')
      const profileId = typeof ctx.services.getProfileId === 'function' ? ctx.services.getProfileId() : null
      const rows = typeof svc.listAll === 'function'
        ? await svc.listAll()
        : (typeof svc.list === 'function' ? await svc.list(profileId) : [])
      const using = typeof svc.getUsing === 'function' ? safe(() => svc.getUsing(profileId), null) : null
      const usingRow = asRow(using)
      const usingId = using && typeof using === 'object' ? String(usingRow.id || '') : (using ? String(using) : null)
      const items = asRows(rows).map((s) => ({
        id: s.id,
        name: s.name || s.id,
        profileId: s.profileId || '',
        color: s.color || '',
        icon: s.icon || '',
        order: Number.isFinite(s.order) ? s.order : null,
        lastUsed: Number.isFinite(s.lastUsed) ? s.lastUsed : null,
        active: Boolean(usingId && usingId === String(s.id || ''))
      }))
      return {
        items,
        total: items.length,
        meta: { using: usingId }
      }
    }
  },
  {
    panelIds: ['sessions-panel'],
    kind: 'list',
    async read(args: PanelArgs, ctx: PanelDataContext) {
      const svc = ctx.services.namedSessions
      if (!svc || typeof svc.list !== 'function') throw new Error('命名会话不可用')
      const rows = await svc.list()
      const items = asRows(rows).map((s) => ({
        id: s.id,
        name: s.name || '',
        createdAt: Number.isFinite(s.createdAt) ? s.createdAt : null,
        spaceId: s.spaceId || '',
        tabCount: Array.isArray(s.tabs) ? s.tabs.length : 0,
        tabs: asRows(s.tabs).slice(0, 20).map((t) => ({
          title: t.title || '',
          url: t.url || '',
          pinned: bool(t.pinned)
        }))
      }))
      return { items, total: items.length }
    }
  },
  {
    panelIds: ['open-tabs-panel'],
    kind: 'list',
    async read(args: PanelArgs, ctx: PanelDataContext) {
      const tm = ctx.services.tabManager
      if (!tm || typeof tm.list !== 'function') throw new Error('标签管理器不可用')
      const activeId = typeof tm.getActiveTabId === 'function' ? tm.getActiveTabId() : null
      const items = asRows(tm.list()).map((t) => tabNode(t, activeId))
      return {
        items,
        total: items.length,
        meta: {
          activeTabId: activeId,
          pinnedCount: items.filter((t) => t.pinned).length,
          sleepingCount: items.filter((t) => t.sleeping).length
        }
      }
    }
  },
  {
    panelIds: ['permissions-panel'],
    kind: 'list',
    async read(args: PanelArgs, ctx: PanelDataContext) {
      const svc = ctx.services.permissionService
      if (!svc) throw new Error('权限服务不可用')
      const rows = typeof svc.listAll === 'function' ? await svc.listAll() : []
      const pending = typeof svc.pendingWithFlags === 'function'
        ? await svc.pendingWithFlags()
        : (typeof svc.listPendingRequests === 'function' ? await svc.listPendingRequests() : [])
      const items = asRows(rows).map((p) => ({
        domain: p.domain || p.origin || '',
        permissionType: p.permissionType || p.type || '',
        decision: p.decision || p.state || '',
        sensitive: !!p.sensitive,
        updatedAt: p.updatedAt || null
      }))
      return {
        items,
        total: items.length,
        meta: { pending: Array.isArray(pending) ? pending.slice(0, 20) : [] }
      }
    }
  },
  {
    panelIds: ['totp-panel'],
    kind: 'list',
    async read(args: PanelArgs, ctx: PanelDataContext) {
      const svc = ctx.services.totpService
      if (!svc || typeof svc.list !== 'function') throw new Error('验证器服务不可用')
      const rows = await svc.list()
      // 永远不返回密钥：list 本身已是掩码后的元信息
      const items = asRows(rows).map((t) => ({
        id: t.id,
        issuer: t.issuer || '',
        account: t.account || '',
        label: t.label || '',
        type: t.type || 'totp',
        digits: t.digits || 6,
        period: t.period || 30,
        algorithm: t.algorithm || 'SHA1',
        createdAt: t.createdAt || null
      }))
      return { items, total: items.length }
    }
  },
  {
    panelIds: ['inject-panel'],
    kind: 'rules',
    async read(args: PanelArgs, ctx: PanelDataContext) {
      const settings = ctx.services.settingsService
      if (!settings || typeof settings.get !== 'function') throw new Error('设置服务不可用')
      const rules = parseInjectRules(settings.get(PAGE_INJECT_SETTING_KEYS.rules))
      const items = asRows(rules).map((r) => ({
        id: r.id,
        host: r.host || '',
        enabled: r.enabled !== false,
        // 站点级「强制深色」覆盖：`on` / `off` / null（跟随全局）。
        // 字段名必须与纯层 page-inject.mjs 一致（forceDark），否则这里永远是 undefined。
        forceDark: r.forceDark || null,
        css: r.css ? clip(r.css, 300) : '',
        js: r.js ? clip(r.js, 300) : ''
      }))
      return { items, total: items.length }
    }
  },
  {
    panelIds: ['easel-panel'],
    kind: 'boards',
    async read(args: PanelArgs, ctx: PanelDataContext) {
      const settings = ctx.services.settingsService
      if (!settings || typeof settings.get !== 'function') throw new Error('设置服务不可用')
      // 画板数据落在设置里（`easel.boards`，JSON 字符串），渲染进程与管理器共用同一份归一化。
      const boards = asRows(parseBoards(settings.get(EASEL_SETTING_KEY)))
      const activeBoardId = safe(() => settings.get(EASEL_ACTIVE_BOARD_SETTING_KEY), null) || null
      const items = boards.map((board) => ({
        id: board.id,
        name: board.name,
        background: board.background,
        active: board.id === activeBoardId,
        cardCount: asRows(board.cards).length,
        strokeCount: asRows(board.strokes).length,
        connectorCount: asRows(board.strokes).filter((s) => s.kind === 'connector').length,
        createdAt: board.createdAt || null,
        updatedAt: board.updatedAt || null,
        // 卡片内容才是"画板上写了什么"：图片只报体积，不把 dataURL 塞进上下文。
        cards: asRows(board.cards).slice(0, 40).map((card) => ({
          id: card.id,
          kind: card.kind,
          title: card.title ? clip(card.title, 120) : '',
          url: card.url || '',
          text: card.text ? clip(card.text, 200) : '',
          x: card.x,
          y: card.y,
          w: card.w,
          h: card.h,
          z: card.z,
          ...(card.kind === 'image' ? { imageBytes: String(card.data || '').length } : {})
        }))
      }))
      return { items, total: items.length, meta: { activeBoardId } }
    }
  }
]

/**
 * @param {{
 *   getPanels?: () => any[],
 *   getDomainServices?: () => object,
 *   getLayout?: () => any,
 *   getPanelPresentation?: () => any,
 *   getWindowCount?: () => number,
 *   extensionPoints?: any,
 *   logger?: any
 * }} [options]
 */
export function createPanelData(options: PanelDataOptions = {}) {
  const logger = options.logger || console

  const panelsOf = (): PanelDescriptor[] => {
    try {
      const list = typeof options.getPanels === 'function' ? options.getPanels() : []
      return Array.isArray(list) ? list : []
    } catch (_) {
      return []
    }
  }
  const servicesOf = (): DomainServices => {
    try {
      const s = typeof options.getDomainServices === 'function' ? options.getDomainServices() : {}
      return s && typeof s === 'object' ? s as DomainServices : {}
    } catch (_) {
      return {}
    }
  }
  const layoutOf = (): PanelLayoutPort | null => {
    try {
      return (typeof options.getLayout === 'function' ? options.getLayout() : null) || null
    } catch (_) {
      return null
    }
  }
  const presentationOf = (): PanelPresentationPort | null => {
    try {
      return (typeof options.getPanelPresentation === 'function' ? options.getPanelPresentation() : null) || null
    } catch (_) {
      return null
    }
  }
  const windowCountOf = (): number => {
    try {
      const n = typeof options.getWindowCount === 'function' ? options.getWindowCount() : 1
      return Number.isFinite(n) ? Number(n) : 1
    } catch (_) {
      return 1
    }
  }

  /** provider 声明的 panelId 列表。 */
  function idsOf(provider: PluginPanelProvider | PanelDataProvider | null | undefined): string[] {
    if (!provider || typeof provider !== 'object') return []
    if (Array.isArray(provider.panelIds)) return provider.panelIds.map(String)
    const panelId = (provider as PluginPanelProvider).panelId
    if (panelId) return [String(panelId)]
    return []
  }

  /**
   * 插件贡献的 provider（每次现取：插件启停后自然生效）。
   * 契约：`() => provider | provider[]`，provider = `{ panelId|panelIds, kind?, read(args) }`。
   */
  function pluginProviders(): PluginPanelProvider[] {
    const ep = options.extensionPoints
    if (!ep || typeof ep.callSync !== 'function') return []
    const out: PluginPanelProvider[] = []
    const absorb = (value: unknown): void => {
      if (!value) return
      if (Array.isArray(value)) {
        for (const item of value) absorb(item)
        return
      }
      if (typeof value === 'object' && typeof (value as PluginPanelProvider).read === 'function') {
        out.push(value as PluginPanelProvider)
      }
    }
    try {
      const result = ep.callSync('panel.data.provider', {})
      absorb(result)
    } catch (e) {
      logger.warn?.('[panel-data] 插件 provider 收集失败：', errorMessage(e))
    }
    return out
  }

  /**
   * 面板 → provider。插件实现优先于内置实现（显式补充 / 覆盖）。
   * @param {string} panelId
   */
  function providerFor(panelId: unknown): PanelDataProvider | PluginPanelProvider | null {
    const id = String(panelId || '')
    if (!id) return null
    const plugins = pluginProviders().filter((p) => idsOf(p).includes(id))
    if (plugins.length) return plugins[plugins.length - 1]
    const builtin = BUILTIN_PROVIDERS.find((p) => p.panelIds.includes(id))
    return builtin || null
  }

  /**
   * 数据面能力摘要：`{ [panelId]: { kind, source } }`。
   * 供 `panel_list` 一次取齐（避免为每个面板各调一遍 provider 收集）。
   */
  function summary(): Record<string, { kind: string; source: string }> {
    const out: Record<string, { kind: string; source: string }> = {}
    for (const provider of BUILTIN_PROVIDERS) {
      for (const id of provider.panelIds) out[id] = { kind: provider.kind || 'list', source: 'builtin' }
    }
    for (const provider of pluginProviders()) {
      for (const id of idsOf(provider)) out[id] = { kind: provider.kind || 'list', source: 'plugin' }
    }
    return out
  }

  /**
   * 面板列表 + 宿主状态 + 是否有数据面。
   * 这是 `panel_list` 的唯一数据源（状态与数据能力一次取齐）。
   */
  interface PanelListItem extends Record<string, unknown> {
    panelId: string
    title: string
    open: boolean
    pinned: boolean
    detached: boolean
    hasData: boolean
    dataKind: string | null
    dataSource: string | null
  }

  function list(): PanelListItem[] {
    const layout = layoutOf()
    const presentation = presentationOf()
    const dataMap = summary()
    return panelsOf().map((panel) => {
      const panelId = String(panel.id || '')
      const getPanelSideOf = layout?.getPanelSideOf
      const side = getPanelSideOf && layout
        ? safe(() => getPanelSideOf.call(layout, panelId), null)
        : null
      const isPanelPinned = layout?.isPanelPinned
      const pinned = isPanelPinned && layout
        ? bool(safe(() => isPanelPinned.call(layout, panelId), false))
        : false
      const isDetached = presentation?.isDetached
      const detached = isDetached && presentation
        ? bool(safe(() => isDetached.call(presentation, panelId), false))
        : false
      const data = dataMap[panelId] || null
      const item: PanelListItem = {
        panelId,
        title: panel.title || panelId,
        open: !!(side || detached),
        pinned,
        detached,
        hasData: !!data,
        dataKind: data ? data.kind : null,
        dataSource: data ? data.source : null
      }
      if (side) item.side = side
      if (panel.opensPage) item.opensPage = panel.opensPage
      if (panel.opensWindow) item.opensWindow = panel.opensWindow
      if (panel.hostPage) item.hostPage = panel.hostPage
      return item
    })
  }

  /**
   * 读取一个面板的数据。
   * @param {string} panelId
   * @param {{ parentId?: string, folderId?: string, limit?: number }} [args]
   */
  async function read(panelId: unknown, args: PanelArgs = {}): Promise<Record<string, unknown>> {
    const id = String(panelId || '').trim()
    if (!id) throw new Error('panelId 不能为空')

    const panels = panelsOf()
    const entry = panels.find((p) => String(p.id) === id) || null
    if (!entry) {
      throw new Error(`没有这个面板：${id}。可用：${panels.map((p) => p.id).join(', ')}`)
    }

    const title = entry.title || id
    const provider = providerFor(id)
    if (!provider) {
      return {
        panelId: id,
        title,
        kind: 'none',
        available: false,
        total: 0,
        returned: 0,
        truncated: false,
        items: [],
        note: NO_DATA_NOTES[id] || NO_DATA_NOTE
      }
    }

    const limit = Math.max(1, Math.min(MAX_ITEMS, Number(args.limit) || 60))
    const ctx = {
      services: servicesOf(),
      layout: layoutOf(),
      presentation: presentationOf(),
      windowCount: windowCountOf()
    }

    let result
    try {
      result = await provider.read(args, ctx)
    } catch (e) {
      return {
        panelId: id,
        title,
        kind: provider.kind || 'list',
        available: true,
        error: errorMessage(e),
        total: 0,
        returned: 0,
        truncated: false,
        items: []
      }
    }

    const raw = asRow(result)
    const allItems: unknown[] = Array.isArray(raw.items) ? raw.items : []
    const items = allItems.slice(0, limit)
    const total = Number.isFinite(raw.total) ? Number(raw.total) : allItems.length

    return {
      panelId: id,
      title,
      kind: String(raw.kind || provider.kind || 'list'),
      available: true,
      total,
      returned: items.length,
      truncated: total > items.length,
      items,
      ...(raw.meta && typeof raw.meta === 'object' ? { meta: raw.meta } : {}),
      ...(raw.note ? { note: raw.note } : {})
    }
  }

  return {
    list,
    read,
    summary,
    /** 内置 provider 覆盖的面板 id（诊断 / 文档用）。 */
    ids() {
      const out = new Set<string>()
      for (const provider of BUILTIN_PROVIDERS) for (const id of provider.panelIds) out.add(id)
      return Array.from(out)
    }
  }
}

