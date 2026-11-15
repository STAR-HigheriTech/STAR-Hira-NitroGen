// @ts-check
/**
 * 插件表面（Plugin Surfaces）—— **开放给第三方插件的声明式扩展面**的唯一装载与消费入口。
 *
 * ══════════════════════════════════════════════════════════════════════
 * 它解决什么问题
 * ══════════════════════════════════════════════════════════════════════
 * 面板（`contributes.panels`）已经有 PanelCatalog 一条完整链路；但「插件还能往宿主里
 * 加什么」远不止面板：内部页、搜索 bang、主菜单项、各类右键菜单项、用户脚本……如果每加一种
 * 就在 main.js 里写一段专用装配，很快会长成互相漂移的散落规则（用户明令禁止）。
 *
 * 本文件把这四类**纯数据**贡献面收在一个模块里，统一定义、统一归一化、统一消费：
 *
 *   contributes.pages        →  `hira://p-<plugin>-<page>/` 内部页（每页独立 origin）
 *   contributes.bangs        →  地址栏 `!trigger` 搜索（与内置 / 用户自定义 bang 同一条数据流）
 *   contributes.menus        →  主菜单项 / 右键菜单项（统一描述符，一次定义多处可用）
 *   contributes.userscripts  →  用户脚本（`.user.js` 文件，按 `@match` 决定在哪些页面执行）
 *
 * 四条设计约束（与 ContributionRegistry 同源）：
 *   1. **纯数据**：这里只认 manifest 里的可序列化对象，不认函数 —— 外部插件跑在
 *      独立进程里，函数过不来；需要动态数据就声明一条官方插槽（`search.bang-provider`
 *      / `app-menu.item` / `context-menu.item`），由插槽调度器负责执行。
 *   2. **可摘除**：所有消费都从 `contributions.list(kind)` 现取，插件禁用后
 *      ContributionRegistry 的 `clearPlugin` 一摘，下一帧这里就看不到了；
 *      只有「已注册到 hira:// 的页面」需要显式 `syncPages()` 注销（协议层不在贡献表里）。
 *   3. **kind 由消费方定义**：本模块 `define` 的 kind 是宿主自己的业务词汇，
 *      注册中心对它们一无所知 —— 再加一种扩展面 = 在下面多写一个归一化函数。
 *   4. **文件型贡献只认插件目录**：用户脚本要读盘，路径一律过 `getPluginRoot()` +
 *      前缀比较（与 hira-plugin:// 同一条安全边界），禁用插件读不到自己的脚本。
 *
 * ══════════════════════════════════════════════════════════════════════
 * 菜单描述符（插件作者写什么）
 * ══════════════════════════════════════════════════════════════════════
 * ```jsonc
 * // manifest 的 contributes.menus（单条或数组）
 * { "id": "translate-page", "where": ["webview.context"], "label": "翻译此页",
 *   "when": { "selection": false }, "action": { "type": "command", "command": "openTranslate" } }
 * ```
 * 字段：
 *   · `where`   放哪儿：`app.file|app.edit|app.view|app.tabs|app.history|app.bookmarks|
 *               app.tools|app.help|app.root` 或 `webview.context|tabbar.context|
 *               bookmark.context|history.context|download.context|note.context|
 *               easel.context|archive.context|open-tab.context|media.context|session.context`
 *   · `label`   文案；`%s` 会被替换成当前选区文本（右键菜单常用）
 *   · `when`    右键条件：`{ selection, link, image, editable, mediaType }`（true/false 都可）
 *   · `action`  `{ type: 'url'|'page'|'panel'|'command'|'bang'|'slot', ... }`
 *   · `submenu` 子项数组（同一套描述符，可嵌 `action`）
 *   · `order` / `enabled` / `accelerator` / `type: 'separator'|'checkbox'|'radio'` / `checked`
 *
 * `action` 六种类型：
 *   url     → `{ url }` 打开地址
 *   page    → `{ page }` 打开本插件（或 `pluginId:pageId`）声明的内部页
 *   panel   → `{ panel }` 打开侧栏面板（走 panelCatalog 存在性守卫）
 *   command → `{ command }` 执行宿主动作（与原生菜单同一张动作表）
 *   bang    → `{ trigger, query? }` 用某条 bang 搜（query 缺省取选区文本）
 *   slot    → `{ id, payload? }` 触发一条官方插槽（EVENT 语义，fire-and-forget）
 */

import * as path from 'node:path'
import * as fs from 'node:fs'
import { buildSearchUrl } from '@hira-ng/shared-types/src/search-url.mjs'
import { normalizeUserScript, resolveUserScripts, buildUserScriptCode } from '@hira-ng/shared-types/src/userscript.mjs'
import { normalizePermissionLevel } from '@hira-ng/shared-types/src/plugin-ui.mjs'
import type { ContributionRegistry, ContributionResult } from '@hira-ng/infra-plugin'
// 面板改写可触及的字段白名单**只有一份**（panel-catalog 导出），这里只读不复制 ——
// 否则两边各写一份，迟早漂移成"manifest 能改、运行时改不动"的怪状态。
const { PATCHABLE_PANEL_FIELDS } = require('./panel-catalog') as { PATCHABLE_PANEL_FIELDS: readonly string[] }

type UnknownRecord = Record<string, unknown>
type SurfaceItem = ContributionResult<UnknownRecord>
type UserScriptRecord = ReturnType<typeof normalizeUserScript>
type MenuItem = UnknownRecord

interface LoggerPort {
  warn?(message?: unknown, ...args: unknown[]): void
  error?(message?: unknown, ...args: unknown[]): void
}

interface SlotCallPort {
  multi?(slotId: string, context: UnknownRecord): unknown
  call?(slotId: string, context: UnknownRecord): unknown
  emit?(slotId: string, payload: unknown): unknown
}

interface ExtensionPointPort {
  implement?(slotId: string, implementation: (...args: unknown[]) => unknown, meta?: UnknownRecord): unknown
}

interface UserScriptRuntimePort {
  loadRequires?(script: UserScriptRecord): Promise<string[]>
  handleRequest?(...args: unknown[]): unknown
}

interface PageRegistration {
  host: string
  kind: 'dynamic'
  resolve(url: URL): Promise<Response | null>
}

interface PluginSurfacesOptions {
  contributions: ContributionRegistry
  slotCall?: SlotCallPort | null
  registerHiraPage?: ((descriptor: PageRegistration) => boolean) | null
  unregisterHiraPage?: ((host: string) => boolean) | null
  serveStaticAsync?: ((baseDir: string, pathname: string, options?: UnknownRecord) => Promise<Response | null>) | null
  getPluginRoot?: (pluginId: string) => string | null
  getPluginPermissionLevel?: (pluginId: string) => unknown
  openUrl?: (url: string) => unknown
  openPage?: (url: string) => unknown
  openPanel?: (panelId: string) => unknown
  runCommand?: (name: string) => unknown
  showOverlay?: ((descriptor: UnknownRecord, pluginId: string) => unknown) | null
  extensionPoints?: ExtensionPointPort | null
  onBangsChanged?: (() => unknown) | null
  onMenusChanged?: (() => unknown) | null
  onPagesChanged?: (() => unknown) | null
  onChromeChanged?: (() => unknown) | null
  userScriptRuntime?: UserScriptRuntimePort | null
  getDisabledUserScripts?: () => unknown
  logger?: LoggerPort
}

interface SurfaceSignature {
  bangs: string
  menus: string
  userscripts: string
  chrome: string
}

interface PageEntry {
  id: string
  pluginId: string
  title: string
  entry: string
  dir: string
  host: string
  url: string
  order: number
}

interface BangEntry {
  id: string
  trigger: string
  title: string
  url: string
  showSuggestions: boolean
  hitCount: number
  pluginId: string
  order: number
}

interface MenuEntry extends UnknownRecord {
  id: string
  pluginId: string
  where: string[]
  label?: string
  enabled?: boolean
  order: number
}

interface CompiledMenuItem extends UnknownRecord {
  label?: string
  enabled?: boolean
  accelerator?: string
  registerAccelerator?: boolean
  type?: string
  checked?: boolean
  submenu?: CompiledMenuItem[]
  click?: () => void
}

interface ButtonEntry {
  id: string
  pluginId: string
  label: string
  icon: string
  tooltip: string
  action: UnknownRecord | null
  enabled: boolean
  order: number
}

interface OverlayEntry {
  id: string
  pluginId: string
  title: string
  page: string
  anchor: string
  width: number
  height: number
  modal: boolean
  order: number
}

interface DeclarativeSlotItem {
  id: string
  key: string
  title: string
  icon: string
  page: string
  anchor: string
  width: number
  height: number
  modal: boolean
  pluginId: string
  action: UnknownRecord | null
}

interface UserScriptEntry {
  pluginId: string
  id: string
  key: string
  file: string
  name: string
  order: number
  enabled: boolean
}

interface UserScriptCacheEntry {
  signature: string
  script: UserScriptRecord
  checkedAt: number
  size: number
}

function isRecord (value: unknown): value is UnknownRecord {
  return value !== null && (typeof value === 'object' || typeof value === 'function')
}

function asRecord (value: unknown): UnknownRecord {
  return isRecord(value) ? value : {}
}

function errorMessage (error: unknown): string {
  return isRecord(error) && error.message ? String(error.message) : String(error)
}

/** 扩展面 kind（与 manifest `contributes.*` 的 key 逐字一致）。 */
const PAGES_KIND = 'pages'
const BANGS_KIND = 'bangs'
const MENUS_KIND = 'menus'
const USERSCRIPTS_KIND = 'userscripts'
/**
 * 开放世界新增的七类声明式贡献（与 manifest `contributes.*` 的 key 逐字一致）。
 *
 * 全部是**纯数据**：外部插件跑在独立进程里，函数过不来；需要行为时写
 * `action: { type: 'url'|'page'|'panel'|'command'|'bang'|'slot' }`，由 runAction 派发。
 * 消费方（渲染层 / 面板目录 / 页面注入）只读这些表，不再各自解析 manifest。
 */
const NAVBAR_BUTTONS_KIND = 'navbarButtons'
const RAIL_BUTTONS_KIND = 'railButtons'
const TAB_ACTIONS_KIND = 'tabActions'
const OVERLAYS_KIND = 'overlays'
const PANEL_OVERRIDES_KIND = 'panelOverrides'
const PAGE_PATCHES_KIND = 'pagePatches'
const COMMANDS_KIND = 'pluginCommands'
/** 声明式 kind → 外壳插槽 id（registerDeclarativeSlots 的映射真源）。 */
const DECLARATIVE_SLOT_BY_KIND = Object.freeze({
  [NAVBAR_BUTTONS_KIND]: 'navbar.button-slot',
  [RAIL_BUTTONS_KIND]: 'side-panel.rail-icon-slot',
  [TAB_ACTIONS_KIND]: 'tab.action-slot',
  [OVERLAYS_KIND]: 'overlay.slot'
})

/**
 * 右键菜单 kind → where 的映射。
 * 与 `ipc/window.js#MENU_SLOT_BY_KIND` 的键集合**必须一致**（那边是"渲染层列表菜单 →
 * 插槽 id"，这边是"kind → 声明式 where"）；值直接采用 where 词汇表。
 */
const CONTEXT_WHERE_BY_KIND: Readonly<Record<string, string>> = Object.freeze({
  bookmark: 'bookmark.context',
  tab: 'tabbar.context',
  note: 'note.context',
  history: 'history.context',
  download: 'download.context',
  easel: 'easel.context',
  archive: 'archive.context',
  'open-tab': 'open-tab.context',
  media: 'media.context',
  session: 'session.context',
  webview: 'webview.context'
})

/** 编辑器 / 窗口 / 标签等宿主动作的合法 type。 */
const ACTION_TYPES = new Set(['url', 'page', 'panel', 'command', 'bang', 'slot', 'overlay'])

/** 内部页 host 前缀：与内置页（settings / history / …）保持视觉区分，避免撞名。 */
const PLUGIN_PAGE_PREFIX = 'p-'

/**
 * 把任意字符串压成 host 合法片段：只留 `a-z0-9.-`，其余转 `-`。
 * host 是 Chromium 的小写化域名，大小写混用只会让插件作者困惑。
 */
function sanitizeSegment (value: unknown, fallback: string): string {
  const text = String(value == null ? '' : value)
    .toLowerCase()
    .replace(/[^a-z0-9.-]+/g, '-')
    .replace(/-{2,}/g, '-')
    .replace(/^[-.]+|[-.]+$/g, '')
  return text || fallback
}

/** 插件内部页的 host：每个页面独立 origin（`p-<plugin>-<page>`）。 */
function pageHost (pluginId: unknown, pageId: unknown): string {
  return `${PLUGIN_PAGE_PREFIX}${sanitizeSegment(pluginId, 'plugin')}-${sanitizeSegment(pageId, 'page')}`
}

/** 归一化入口路径：剥前导 `/`、拒绝任何 `..` 段。非法返回 null。 */
function normalizeRelPath (value: unknown, fallback: string): string | null {
  const raw = String(value == null ? '' : value).trim()
  if (!raw) return fallback
  const cleaned = raw.replace(/\\/g, '/').replace(/^\.?\//, '').replace(/^\/+/, '')
  if (!cleaned || cleaned.split('/').includes('..')) return null
  return cleaned
}

/** 归一化 bang trigger：小写 + 去空白（与 ui-searchbar 的口径一致）。 */
function normalizeTrigger (value: unknown): string {
  return String(value == null ? '' : value).toLowerCase().replace(/\s+/g, '')
}

/** 把 `where` 规范成字符串数组（接受数组 / 逗号 / 空格 / `|` 分隔）。 */
function normalizeWhere (value: unknown): string[] {
  const parts = Array.isArray(value)
    ? value
    : String(value == null ? '' : value).split(/[,\s|]+/)
  const out: string[] = []
  for (const part of parts) {
    const text = String(part || '').trim()
    if (text && !out.includes(text)) out.push(text)
  }
  return out.length ? out : ['app.root']
}

/**
 * `when` 条件匹配（右键菜单用）。未声明的字段不设约束。
 * @param {unknown} when
 * @param {unknown} payload
 */
function matchesWhen (when: unknown, payload: unknown): boolean {
  if (!isRecord(when)) return true
  const p = asRecord(payload)
  const selection = String(p.selectionText || '').trim()
  if (when.selection === true && !selection) return false
  if (when.selection === false && selection) return false
  if (when.link === true && !p.linkURL) return false
  if (when.link === false && p.linkURL) return false
  if (when.image === true && p.mediaType !== 'image') return false
  if (when.image === false && p.mediaType === 'image') return false
  if (when.editable === true && !p.isEditable) return false
  if (when.editable === false && p.isEditable) return false
  if (when.mediaType && String(p.mediaType || '') !== String(when.mediaType)) return false
  return true
}

/** 选区文本进菜单文案：过长会撑爆原生菜单，截断即可（信息量足够辨认）。 */
function truncateForMenu (text: unknown, max = 32): string {
  const value = String(text || '').trim().replace(/\s+/g, ' ')
  return value.length > max ? `${value.slice(0, max)}…` : value
}

/**
 * @param {object} options
 * @param {object} options.contributions ContributionRegistry（必需）
 * @param {{ multi?: Function, call?: Function, emit?: Function } | null} [options.slotCall]
 * @param {(desc: PageRegistration) => boolean} [options.registerHiraPage]
 * @param {(host: string) => boolean} [options.unregisterHiraPage]
 * @param {(baseDir: string, pathname: string, opts?: object) => Promise<Response|null>} [options.serveStaticAsync]
 * @param {(pluginId: string) => string|null} [options.getPluginRoot] 已启用插件的文件根目录
 * @param {(url: string) => void} [options.openUrl] 打开地址（新标签 / 当前标签由宿主决定）
 * @param {(url: string) => void} [options.openPage] 打开内部页（已有同页标签时由宿主切过去）
 * @param {(panelId: string) => void} [options.openPanel]
 * @param {(name: string) => boolean|void} [options.runCommand] 执行宿主动作表里的命令
 * @param {() => void} [options.onBangsChanged]
 * @param {() => void} [options.onMenusChanged]
 * @param {() => void} [options.onPagesChanged]
 * @param {{ loadRequires?: (script: UserScriptRecord) => Promise<string[]>, handleRequest?: (...args: unknown[]) => unknown } | null} [options.userScriptRuntime]
 *   用户脚本宿主运行时（`userscript-runtime.js`）：`@require` 取码走它。
 *   不传 = 脚本照常注入，只是拿不到 `@require` 的前置库。
 * @param {() => string[]} [options.getDisabledUserScripts]
 *   被用户**单独关掉**的脚本键（`<pluginId>/<scriptId>`）。
 *   做成端口而不是直接读 store —— surfaces 不认识持久化介质。
 * @param {{ warn?: Function, error?: Function }} [options.logger]
 */
function createPluginSurfaces (options: PluginSurfacesOptions) {
  const contributions = options.contributions
  if (!contributions || typeof contributions.define !== 'function') {
    throw new Error('[plugin-surfaces] contributions registry is required')
  }
  const slotCall = options.slotCall || null
  const registerHiraPage = typeof options.registerHiraPage === 'function' ? options.registerHiraPage : null
  const unregisterHiraPage = typeof options.unregisterHiraPage === 'function' ? options.unregisterHiraPage : null
  const serveStaticAsync = typeof options.serveStaticAsync === 'function' ? options.serveStaticAsync : null
  const getPluginPermissionLevel = typeof options.getPluginPermissionLevel === 'function'
    ? options.getPluginPermissionLevel
    : null
  const getPluginRoot = typeof options.getPluginRoot === 'function' ? options.getPluginRoot : () => null
  const openUrl = typeof options.openUrl === 'function' ? options.openUrl : () => {}
  const openPage = typeof options.openPage === 'function' ? options.openPage : openUrl
  const openPanel = typeof options.openPanel === 'function' ? options.openPanel : () => {}
  const runCommand = typeof options.runCommand === 'function' ? options.runCommand : () => false
  // 浮层动作（`action.type='overlay'`）的落点：插件浮层宿主（main/plugin-overlays.js）。
  // 做成可选端口而不是反向 require —— 否则 surfaces ↔ overlays 会互相依赖。
  const showOverlay = typeof options.showOverlay === 'function' ? options.showOverlay : null
  /** 扩展点调度器：声明式 UI 贡献要接进官方插槽（`navbar.button-slot` 等）。 */
  const extensionPoints = options.extensionPoints || null
  const onBangsChanged = typeof options.onBangsChanged === 'function' ? options.onBangsChanged : null
  const onMenusChanged = typeof options.onMenusChanged === 'function' ? options.onMenusChanged : null
  const onPagesChanged = typeof options.onPagesChanged === 'function' ? options.onPagesChanged : null
  /** 外壳贡献（navbar / rail / tabAction / 浮层 / 命令）变化 —— 渲染层据此重拉。 */
  const onChromeChanged = typeof options.onChromeChanged === 'function' ? options.onChromeChanged : null
  /** 用户脚本运行时（`@require` 取码）；不传则脚本仍注入，只是没有前置库。 */
  const userScriptRuntime = options.userScriptRuntime || null
  /** 单脚本启停的真源（`plugin-state-store.js` 的 `plugins.userscripts.disabled`）。 */
  const getDisabledUserScripts = typeof options.getDisabledUserScripts === 'function'
    ? options.getDisabledUserScripts
    : () => []
  const logger: LoggerPort = options.logger || console
  const warn = (message: string, error?: unknown): void => {
    if (logger.warn) logger.warn(`[plugin-surfaces] ${message}`, error)
  }

  /**
   * 四类开放扩展面统一开启 `namespaced`：社区插件各写 `id: 'github'` 不会互相覆盖。
   * 它们都是 multi（同一个 kind 允许多条并存）。
   */
  contributions.define(PAGES_KIND, { mode: 'multi', namespaced: true })
  contributions.define(BANGS_KIND, { mode: 'multi', namespaced: true })
  contributions.define(MENUS_KIND, { mode: 'multi', namespaced: true })
  contributions.define(USERSCRIPTS_KIND, { mode: 'multi', namespaced: true })
  // 开放世界新增的七类（全部 namespaced：社区插件各写 `id: 'foo'` 不会互相覆盖）
  contributions.define(NAVBAR_BUTTONS_KIND, { mode: 'multi', namespaced: true })
  contributions.define(RAIL_BUTTONS_KIND, { mode: 'multi', namespaced: true })
  contributions.define(TAB_ACTIONS_KIND, { mode: 'multi', namespaced: true })
  contributions.define(OVERLAYS_KIND, { mode: 'multi', namespaced: true })
  contributions.define(PANEL_OVERRIDES_KIND, { mode: 'multi', namespaced: true })
  contributions.define(PAGE_PATCHES_KIND, { mode: 'multi', namespaced: true })
  contributions.define(COMMANDS_KIND, { mode: 'multi', namespaced: true })

  /** 已注册到协议层的页面：host → 归一化签名（变化才重注册）。 */
  const registeredPages = new Map<string, string>()
  /** 上一次 sync 时的表面签名（bangs / menus 分开记，用于判断"这次到底变了什么"）。 */
  let lastSurfaceSignature: SurfaceSignature | null = null
  /** 每次 sync 自增：让插槽型菜单项（无法静态签名）也能触发原生菜单重建。 */
  let generation = 0

  // ───────────────────────────────────────────────────────────────────────
  // 内部页（contributes.pages）
  // ───────────────────────────────────────────────────────────────────────

  /**
   * @returns {Array<{ id:string, pluginId:string, title:string, entry:string, dir:string,
   *   host:string, url:string, order:number }>}
   */
  function listPages (): PageEntry[] {
    const out: PageEntry[] = []
    for (const item of contributions.list(PAGES_KIND)) {
      const pluginId = String(item.pluginId || '').trim()
      const id = String(item.id || '').trim()
      if (!pluginId || !id) continue
      const entry = normalizeRelPath(item.entry, 'index.html')
      if (entry === null) {
        warn(`页面 ${pluginId}/${id} 的 entry 非法（不允许 ..），已忽略`)
        continue
      }
      const dir = normalizeRelPath(item.dir, '')
      if (dir === null) {
        warn(`页面 ${pluginId}/${id} 的 dir 非法（不允许 ..），已忽略`)
        continue
      }
      const host = pageHost(pluginId, id)
      out.push({
        id,
        pluginId,
        title: String(item.title || item.name || id),
        entry,
        dir,
        host,
        // entry 就是 index.html 时用目录地址更自然（也是「每页一个 origin」的入口）
        url: `hira://${host}/${entry === 'index.html' ? '' : entry}`,
        order: typeof item.order === 'number' && Number.isFinite(item.order) ? item.order : 0
      })
    }
    return out
  }

  /** 按 `pluginId:pageId`（或本插件内的 `pageId`）取页面 URL；找不到返回空串。 */
  function pageUrl (ref: unknown, selfPluginId: unknown): string {
    const text = String(ref == null ? '' : ref).trim()
    if (!text) return ''
    const pages = listPages()
    const colon = text.indexOf(':')
    if (colon > 0) {
      const pluginId = text.slice(0, colon)
      const pageId = text.slice(colon + 1)
      const hit = pages.find((p) => p.pluginId === pluginId && p.id === pageId)
      return hit ? hit.url : ''
    }
    const hit = pages.find((p) => p.pluginId === selfPluginId && p.id === text)
    return hit ? hit.url : ''
  }

  /**
   * 页面资产的候选目录：声明了 `dir` 就只认它；否则先 `pages/<pageId>` 再插件根目录。
   * 所有候选都必须落在插件根目录内 —— 这是**安全边界**，不是路径美化。
   */
  function resolvePageDirs (page: PageEntry): string[] {
    const root = getPluginRoot(page.pluginId)
    if (!root) return []
    const rootResolved = path.resolve(root)
    const candidates = page.dir
      ? [path.resolve(rootResolved, page.dir)]
      : [path.resolve(rootResolved, 'pages', page.id), rootResolved]
    const lowerRoot = rootResolved.toLowerCase()
    return candidates.filter((dir) => {
      const lower = dir.toLowerCase()
      return lower === lowerRoot || lower.startsWith(lowerRoot + path.sep.toLowerCase())
    })
  }

  function makePageResolver (page: PageEntry, dirs: string[]): (url: URL) => Promise<Response | null> {
    const serve = serveStaticAsync
    if (!serve) return async (): Promise<Response | null> => null
    let permissionLevel = 'none'
    try { permissionLevel = normalizePermissionLevel(getPluginPermissionLevel ? getPluginPermissionLevel(page.pluginId) : null) } catch (_) {}
    const network = permissionLevel === 'network' || permissionLevel === 'full'
    const csp = [
      "default-src 'none'",
      "base-uri 'none'",
      "object-src 'none'",
      "frame-src 'none'",
      "worker-src 'none'",
      "form-action 'self'",
      "script-src 'self' 'unsafe-inline'",
      "style-src 'self' 'unsafe-inline'",
      "font-src 'self' data:",
      "img-src 'self' data: blob:" + (network ? ' https: http:' : ''),
      "media-src 'self' data: blob:" + (network ? ' https: http:' : ''),
      network ? "connect-src https: wss: http: ws:" : "connect-src 'none'"
    ].join('; ')
    const headers = {
      'Content-Security-Policy': csp,
      'X-Content-Type-Options': 'nosniff',
      'Referrer-Policy': 'no-referrer'
    }
    return async (url: URL): Promise<Response | null> => {
      let pathname = url && url.pathname ? url.pathname : '/'
      if (pathname === '/' || pathname === '') pathname = `/${page.entry}`
      for (const dir of dirs) {
        // cache:false —— 插件可热更新，读到旧产物比慢几毫秒糟得多
        const resp = await serve(dir, pathname, { label: `plugin-page:${page.host}`, cache: false, headers })
        if (resp) return resp
      }
      return null
    }
  }

  /** 把贡献表里的页面同步到 hira:// 协议层；返回是否有变化。 */
  function syncPages() {
    if (!registerHiraPage || !serveStaticAsync) {
      // 协议层未接线（单测 / 早期启动）：不注册也不报错，页面只是"暂不可达"。
      return false
    }
    const desired = new Set<string>()
    let changed = false
    for (const page of listPages()) {
      desired.add(page.host)
      const signature = `${page.pluginId}\u0000${page.entry}\u0000${page.dir}`
      if (registeredPages.get(page.host) === signature) continue
      const dirs = resolvePageDirs(page)
      if (!dirs.length) {
        warn(`页面 ${page.pluginId}/${page.id} 找不到可用目录（插件未启用或目录缺失），已跳过`)
        if (unregisterHiraPage && registeredPages.delete(page.host)) unregisterHiraPage(page.host)
        continue
      }
      registerHiraPage({ host: page.host, kind: 'dynamic', resolve: makePageResolver(page, dirs) })
      registeredPages.set(page.host, signature)
      changed = true
    }
    if (unregisterHiraPage) {
      for (const host of Array.from(registeredPages.keys())) {
        if (desired.has(host)) continue
        unregisterHiraPage(host)
        registeredPages.delete(host)
        changed = true
      }
    }
    return changed
  }

  // ───────────────────────────────────────────────────────────────────────
  // 搜索 bang（contributes.bangs）
  // ───────────────────────────────────────────────────────────────────────

  /**
   * 归一化成 `search-controller#customEntries` 认得的形状：
   * `{ id, trigger, title, url, showSuggestions, hitCount }`。
   * `id` 带 `plugin:` 前缀 —— 渲染层据此把它与用户自定义 bang 区分（不写使用统计）。
   */
  function normalizeBang (item: unknown, fallbackPluginId: unknown): BangEntry | null {
    const source = asRecord(item)
    const pluginId = String(source.pluginId || fallbackPluginId || '').trim()
    const rawId = String(source.id || '').trim()
    const trigger = normalizeTrigger(source.trigger)
    const url = String(source.url || source.template || '').trim()
    if (!pluginId || !trigger || !url) return null
    return {
      id: rawId ? `plugin:${pluginId}:${rawId}` : `plugin:${pluginId}:${trigger}`,
      trigger,
      title: String(source.title || source.name || trigger),
      url,
      showSuggestions: source.showSuggestions !== false,
      hitCount: 0,
      pluginId,
      order: typeof source.order === 'number' && Number.isFinite(source.order) ? source.order : 0
    }
  }

  /** 声明式 bang（同步：地址栏 config 的常规载荷）。 */
  function listBangs (): BangEntry[] {
    const out: BangEntry[] = []
    for (const item of contributions.list(BANGS_KIND)) {
      const bang = normalizeBang(item, item.pluginId)
      if (bang) out.push(bang)
    }
    return out
  }

  /**
   * 声明式 + 插槽型 bang 的合并结果（异步）。
   * 插槽 `search.bang-provider` 允许插件按需计算（例如从远端 / 本地索引取），
   * 因此只在 `search:config` 这条 async handler 里等它，其余调用点用同步版本。
   */
  async function listBangsAsync() {
    const out = listBangs()
    const seen = new Set(out.map((b) => b.id))
    if (!slotCall || typeof slotCall.call !== 'function') return out
    let raw: unknown = null
    try {
      raw = await slotCall.call('search.bang-provider', {})
    } catch (_) {
      return out
    }
    const flat: unknown[] = Array.isArray(raw) ? raw.flat(1) : []
    for (let i = 0; i < flat.length; i += 1) {
      const item = flat[i]
      if (!item || typeof item !== 'object') continue
      const bang = normalizeBang(item, 'slot')
      if (!bang) continue
      if (seen.has(bang.id)) continue
      seen.add(bang.id)
      out.push(bang)
    }
    return out
  }

  /** 按 trigger 找 URL（`action.type='bang'` 用；返回空串表示没有这条 bang）。 */
  function bangTemplate (trigger: unknown): string {
    const key = normalizeTrigger(trigger)
    if (!key) return ''
    const hit = listBangs().find((b) => b.trigger === key)
    return hit ? hit.url : ''
  }

  // ───────────────────────────────────────────────────────────────────────
  // 菜单（contributes.menus）
  // ───────────────────────────────────────────────────────────────────────

  function normalizeMenu (item: SurfaceItem): MenuEntry | null {
    const pluginId = String(item.pluginId || '').trim()
    const id = String(item.id || '').trim()
    if (!pluginId || !id) return null
    if (item.type === 'separator') {
      return {
        id,
        pluginId,
        where: normalizeWhere(item.where),
        type: 'separator',
        order: typeof item.order === 'number' && Number.isFinite(item.order) ? item.order : 0
      }
    }
    const action = item.action && typeof item.action === 'object' ? item.action : null
    const hasSubmenu = Array.isArray(item.submenu) && item.submenu.length > 0
    if (!action && !hasSubmenu) {
      warn(`菜单项 ${pluginId}/${id} 既没有 action 也没有 submenu，已忽略（点了不会有反应）`)
      return null
    }
    return {
      id,
      pluginId,
      where: normalizeWhere(item.where),
      label: String(item.label || item.title || ''),
      type: item.type === 'checkbox' || item.type === 'radio' ? item.type : undefined,
      checked: item.checked === true,
      enabled: item.enabled !== false,
      accelerator: item.accelerator ? String(item.accelerator) : '',
      when: item.when && typeof item.when === 'object' ? item.when : null,
      action,
      submenu: hasSubmenu ? item.submenu : null,
      order: typeof item.order === 'number' && Number.isFinite(item.order) ? item.order : 0
    }
  }

  function listMenus (): MenuEntry[] {
    const out: MenuEntry[] = []
    for (const item of contributions.list(MENUS_KIND)) {
      const menu = normalizeMenu(item)
      if (menu) out.push(menu)
    }
    return out
  }

  /** 描述符文案里的 `%s` = 当前选区文本（右键菜单的常见诉求）。 */
  function renderLabel (label: unknown, payload: unknown): string {
    const text = typeof label === 'string' ? label.trim() : ''
    if (!text) return ''
    if (!text.includes('%s')) return text
    return text.replaceAll('%s', truncateForMenu(asRecord(payload).selectionText))
  }

  /**
   * 描述符 → Electron 菜单项（含 click）。
   * 所有菜单消费方共用这一份编译，避免"主菜单一套、右键一套"各自漂移。
   */
  function compileDescriptor (desc: unknown, pluginId: string, payload: unknown): CompiledMenuItem | null {
    if (!isRecord(desc)) return null
    if (desc.type === 'separator') return { type: 'separator' }
    if (!matchesWhen(desc.when, payload)) return null
    const label = renderLabel(desc.label, payload)
    if (!label) {
      warn(`菜单项 ${pluginId}/${desc.id || '?'} 缺少 label，已忽略`)
      return null
    }
    const item: CompiledMenuItem = { label, enabled: desc.enabled !== false }
    if (desc.accelerator) {
      item.accelerator = String(desc.accelerator)
      // 与 app-menu.js 同一条约束：NG 的快捷键由 keybindings 统一拦截，
      // 菜单只显示组合键、不再注册，否则一次按键触发两遍。
      item.registerAccelerator = false
    }
    if (desc.type === 'checkbox' || desc.type === 'radio') {
      item.type = desc.type
      item.checked = desc.checked === true
    }
    if (Array.isArray(desc.submenu) && desc.submenu.length) {
      const submenu = desc.submenu
        .map((child) => compileDescriptor(child, pluginId, payload))
        .filter((child): child is CompiledMenuItem => child !== null)
      if (!submenu.length) return null
      item.submenu = submenu
      return item
    }
    if (typeof desc.onSelect === 'function') {
      const onSelect = desc.onSelect as (payload: unknown) => unknown
      // 官方插槽（`app-menu.item` / `context-menu.item`）可以给闭包 —— 那条路本来就在主进程。
      item.click = () => {
        try {
          onSelect(payload)
        } catch (e) {
          warn(`菜单项 ${pluginId}/${desc.id || label} 执行失败：`, errorMessage(e))
        }
      }
      return item
    }
    if (!desc.action) {
      warn(`菜单项 ${pluginId}/${desc.id || label} 缺少 action，已忽略`)
      return null
    }
    item.click = () => runAction(desc.action, { pluginId, payload })
    return item
  }

  /**
   * 取某个 `where` 下的全部插件菜单项（Electron 可直接使用的形状）。
   * 声明式贡献在前（按 order），官方插槽的动态项追加在后。
   */
  function menuItems (where: unknown, payload: unknown): CompiledMenuItem[] {
    const target = String(where || '').trim()
    if (!target) return []
    const ctx = asRecord(payload)
    const items: CompiledMenuItem[] = []
    for (const desc of listMenus()) {
      if (!desc.where.includes(target)) continue
      const compiled = compileDescriptor(desc, desc.pluginId, ctx)
      if (compiled) items.push(compiled)
    }
    if (slotCall && typeof slotCall.multi === 'function') {
      const slotId = target.startsWith('app.') ? 'app-menu.item' : 'context-menu.item'
      const raw = slotCall.multi(slotId, { ...ctx, where: target })
      const slotItems: unknown[] = Array.isArray(raw) ? raw.flat(1) : []
      for (const rawItem of slotItems) {
        if (!isRecord(rawItem)) continue
        const desc = rawItem
        // 插槽项可声明 where 做二次过滤；不声明即视为"只属于当前调用点"。
        if (desc.where != null && !normalizeWhere(desc.where).includes(target)) continue
        const compiled = compileDescriptor(desc, String(desc.pluginId || 'slot'), ctx)
        if (compiled) items.push(compiled)
      }
    }
    return items
  }

  /** 主菜单里某个顶级菜单（`app.file` …）的插件项。 */
  function appMenuItems (where: unknown, state: unknown): CompiledMenuItem[] {
    return menuItems(where, asRecord(state))
  }

  /** `app.root` = 插件新增的**顶级菜单**（必须带 submenu，否则跳过）。 */
  function appRootMenus (state: unknown): CompiledMenuItem[] {
    const out: CompiledMenuItem[] = []
    for (const item of menuItems('app.root', asRecord(state))) {
      if (item && Array.isArray(item.submenu)) out.push(item)
      else warn('app.root 菜单项需要 submenu（顶级菜单不能是叶子项），已忽略')
    }
    return out
  }

  /** 某类右键菜单（`bookmark` / `tab` / `webview` …）的插件项。 */
  function contextMenuItems (kind: unknown, payload: unknown): CompiledMenuItem[] {
    const key = String(kind || '').trim()
    const where = CONTEXT_WHERE_BY_KIND[key] || (key.includes('.') ? key : '')
    if (!where) return []
    return menuItems(where, asRecord(payload))
  }

  /**
   * 执行一条菜单动作。返回是否真的派发了（false = 数据不完整 / 目标不存在）。
   * 所有异常都在这里收口 —— 一个坏插件项不该让整次点击失去反应。
   */
  function runAction (action: unknown, ctx: UnknownRecord = {}): boolean {
    if (!isRecord(action)) return false
    const payload = asRecord(ctx.payload)
    const pluginId = String(ctx.pluginId || '')
    const type = String(action.type || '').trim()
    try {
      if (!ACTION_TYPES.has(type)) {
        if (typeof action.onSelect === 'function') {
          const onSelect = action.onSelect as (selection: unknown) => unknown
          onSelect(payload)
          return true
        }
        warn(`未知的菜单动作类型：${type || '(空)'}`)
        return false
      }
      if (type === 'url') {
        const url = String(action.url || '').trim()
        if (!url) return false
        openUrl(url)
        return true
      }
      if (type === 'page') {
        const url = pageUrl(action.page || action.id, pluginId)
        if (!url) {
          warn(`页面动作指向不存在的页面：${String(action.page || action.id || '')}`)
          return false
        }
        openPage(url)
        return true
      }
      if (type === 'panel') {
        const panelId = String(action.panel || action.id || '').trim()
        if (!panelId) return false
        openPanel(panelId)
        return true
      }
      if (type === 'command') {
        const name = String(action.command || action.name || '').trim()
        if (!name) return false
        return runCommand(name) !== false
      }
      if (type === 'bang') {
        const query = String(action.query != null ? action.query : (payload.selectionText || '')).trim()
        const template = String(action.url || action.template || bangTemplate(action.trigger) || '').trim()
        if (!template) return false
        const url = buildSearchUrl(template, query)
        if (!url) return false
        openUrl(url)
        return true
      }
      if (type === 'overlay') {
        if (!showOverlay) return false
        // 描述符与 `overlay.slot` 同形：id / title / page / url / anchor / width / height / modal。
        const res = showOverlay({ ...action, type: undefined }, pluginId)
        return asRecord(res).ok === true
      }
      // slot：点火即走（EVENT 语义），不等待实现返回值。
      const slotId = String(action.id || action.slot || '').trim()
      if (!slotId || !slotCall || typeof slotCall.emit !== 'function') return false
      Promise.resolve(slotCall.emit(slotId, { ...payload, ...asRecord(action.payload) }))
        .catch((error) => warn(`菜单插槽 ${slotId} 执行失败：`, errorMessage(error)))
      return true
    } catch (e) {
      warn(`菜单动作 ${type} 执行失败：`, errorMessage(e))
      return false
    }
  }

  // ───────────────────────────────────────────────────────────────────────
  // 用户脚本（contributes.userscripts）
  // ───────────────────────────────────────────────────────────────────────

  /** 脚本文件缓存：`pluginId\0id` → { signature, script }（mtime + size 变了才重读）。 */
  const userScriptCache = new Map<string, UserScriptCacheEntry>()
  const USER_SCRIPT_CACHE_MAX_ENTRIES = 1024
  const USER_SCRIPT_CACHE_MAX_BYTES = 32 * 1024 * 1024
  const USER_SCRIPT_REVALIDATE_MS = 1000
  let userScriptCacheBytes = 0

  function rememberUserScript(cacheKey: string, value: UserScriptCacheEntry): void {
    const previous = userScriptCache.get(cacheKey)
    if (previous) userScriptCacheBytes -= previous.size
    userScriptCache.delete(cacheKey)
    userScriptCache.set(cacheKey, value)
    userScriptCacheBytes += value.size
    while (userScriptCache.size > USER_SCRIPT_CACHE_MAX_ENTRIES || userScriptCacheBytes > USER_SCRIPT_CACHE_MAX_BYTES) {
      const oldest = userScriptCache.keys().next()
      if (oldest.done || oldest.value === cacheKey) break
      const evicted = userScriptCache.get(oldest.value)
      if (evicted) userScriptCacheBytes -= evicted.size
      userScriptCache.delete(oldest.value)
    }
    if (userScriptCacheBytes < 0) userScriptCacheBytes = 0
  }

  /**
   * 用户脚本的**稳定键**：`<pluginId>/<scriptId>`。
   *
   * 存储层（`plugins.userscripts.disabled`）把它当不透明字符串 —— "怎么拼"只在这里决定，
   * 面板 / IPC / 存储三处都只是搬运它。脚本 id 在插件内唯一（注册表按 id 建桶）。
   */
  function userScriptKey (pluginId: unknown, id: unknown): string {
    return `${pluginId}/${id}`
  }

  /** 被用户单独关掉的脚本键集合（每次现读：开关要立刻生效，不缓存）。 */
  function disabledUserScriptKeys (): Set<string> {
    try {
      const list = getDisabledUserScripts()
      return new Set<string>(Array.isArray(list) ? list.map(String) : [])
    } catch (e) {
      warn('读取用户脚本启停状态失败（按全部启用处理）：', errorMessage(e))
      return new Set<string>()
    }
  }

  /** `contributes.userscripts` 的一条 → 宿主内部形状；缺 id / file 直接丢弃（注册表已按 id 建桶）。 */
  function normalizeUserScriptEntry (item: SurfaceItem): UserScriptEntry | null {
    const pluginId = String(item.pluginId || '').trim()
    if (!pluginId) return null
    const file = normalizeRelPath(item.file || item.entry || '', '')
    if (!file) {
      warn('用户脚本缺少 file（相对插件目录的脚本路径），已忽略')
      return null
    }
    const id = String(item.id || '').trim()
    if (!id) return null
    return {
      pluginId,
      id,
      key: userScriptKey(pluginId, id),
      file,
      name: String(item.name || '').trim(),
      order: typeof item.order === 'number' && Number.isFinite(item.order) ? item.order : 0,
      // 声明处就能关（作者意图）；用户的单脚本开关是另一维，见 `disabledUserScriptKeys`
      enabled: item.enabled !== false
    }
  }

  /**
   * 读一个脚本并归一化（带 mtime 缓存）。
   * 插件未启用（`getPluginRoot` 返回 null）/ 路径越界 / 文件不存在 → null。
   */
  function readUserScript (entry: UserScriptEntry): UserScriptRecord | null {
    const root = getPluginRoot(entry.pluginId)
    if (!root) return null
    const rootResolved = path.resolve(root)
    const target = path.resolve(rootResolved, entry.file)
    const lowerRoot = rootResolved.toLowerCase()
    const lowerTarget = target.toLowerCase()
    if (lowerTarget !== lowerRoot && !lowerTarget.startsWith(lowerRoot + path.sep.toLowerCase())) {
      warn(`用户脚本路径越界，已拒绝：${entry.pluginId}/${entry.file}`)
      return null
    }
    const cacheKey = `${entry.pluginId}\u0000${entry.id}`
    const fast = userScriptCache.get(cacheKey)
    if (fast && Date.now() - fast.checkedAt < USER_SCRIPT_REVALIDATE_MS) return fast.script
    let stat
    try {
      stat = fs.statSync(target)
    } catch (_) {
      return null
    }
    if (!stat.isFile()) return null
    // 声明变了（换了文件 / 改了显示名 / 改了顺序）也要重读 —— 只比 mtime 会读到旧元数据。
    const signature = `${entry.file}|${entry.name}|${entry.order}|${stat.mtimeMs}:${stat.size}`
    const hit = userScriptCache.get(cacheKey)
    if (hit && hit.signature === signature) {
      rememberUserScript(cacheKey, { ...hit, checkedAt: Date.now() })
      return hit.script
    }
    let source = ''
    try {
      source = fs.readFileSync(target, 'utf8')
    } catch (_) {
      return null
    }
    const script = normalizeUserScript({
      source,
      id: entry.id,
      name: entry.name,
      pluginId: entry.pluginId,
      file: entry.file,
      order: entry.order,
      enabled: entry.enabled
    })
    rememberUserScript(cacheKey, {
      signature,
      script,
      checkedAt: Date.now(),
      size: Buffer.byteLength(script.source, 'utf8')
    })
    return script
  }

  /** 读全部**声明可用**的脚本（含被用户单独关掉的；`enabled` 反映用户开关）。 */
  function collectUserScripts() {
    const disabled = disabledUserScriptKeys()
    const out: Array<UserScriptRecord & { key: string; enabled: boolean }> = []
    for (const item of contributions.list(USERSCRIPTS_KIND)) {
      const entry = normalizeUserScriptEntry(item)
      if (!entry || !entry.enabled) continue
      const script = readUserScript(entry)
      if (!script || !script.source) {
        warn(`用户脚本 ${entry.pluginId}/${entry.id} 读取失败（文件缺失或插件未启用），已跳过`)
        continue
      }
      out.push({ ...script, key: entry.key, enabled: !disabled.has(entry.key) })
    }
    return out
  }

  /** 全部**该执行**的用户脚本（已归一化、带源码）。只含启用中的插件与用户开着的脚本。 */
  function listUserScripts() {
    return collectUserScripts().filter((script) => script.enabled)
  }

  /**
   * 用户脚本清单（**面板 / IPC 的展示面**）：元数据 + `key` + `enabled`，不含源码。
   *
   * 与 `listUserScripts()` 的差别只有一处：这里**包含被用户关掉的脚本** ——
   * 否则用户在面板上关掉一条，它就从此消失、再也打不开了。
   */
  function listUserScriptsSummary() {
    return collectUserScripts().map((script) => ({
      key: script.key,
      id: script.id,
      pluginId: script.pluginId,
      name: script.name,
      namespace: script.namespace,
      version: script.version,
      description: script.description,
      author: script.author,
      icon: script.icon,
      homepage: script.homepage,
      license: script.license,
      runAt: script.runAt,
      match: script.match,
      include: script.include,
      exclude: script.exclude,
      grant: script.grant,
      require: script.require,
      connect: script.connect,
      order: script.order,
      file: script.file,
      enabled: script.enabled,
      // 只在进程内用于签名（"作者改了脚本内容"要能触发重新注入）
      sourceLength: script.source.length
    }))
  }

  /** 用户脚本清单签名（`syncSurfaces` 用它判断脚本集合变没变）。 */
  function userScriptSignature() {
    return listUserScriptsSummary()
      .map((s) => `${s.key}|${s.version}|${s.match.join(',')}|${s.include.join(',')}|${s.enabled ? 1 : 0}|${s.sourceLength}`)
      .join('\u0001')
  }

  /**
   * 某个 URL 该执行哪些用户脚本 —— **注入点的唯一入口**。
   *
   * 返回已拼好的可执行代码（GM 垫片 + 可选 `@require` + IIFE + 错误隔离）；无命中返回空串。
   * **async 的原因**：`@require` 的代码要由主进程取回（首次联网、之后走缓存）。
   * 注入方必须在 apply 之前复核页面 URL 没变 —— 慢速取码期间用户可能已经跳走了。
   */
  async function resolveUserScriptsForUrl (url: unknown): Promise<string> {
    try {
      const protocol = new URL(String(url || '')).protocol
      if (protocol !== 'http:' && protocol !== 'https:') return ''
      const matched = resolveUserScripts({ scripts: listUserScripts(), url })
      if (!matched.length) return ''
      const blocks = await Promise.all(matched.map(async (script) => {
        let requires: string[] = []
        const list = Array.isArray(script.require) ? script.require : []
        if (list.length && userScriptRuntime && typeof userScriptRuntime.loadRequires === 'function') {
          try {
            requires = await userScriptRuntime.loadRequires(script)
          } catch (e) {
            warn(`用户脚本 ${script.pluginId}/${script.id} 的 @require 取码失败：`, errorMessage(e))
          }
        }
        return buildUserScriptCode(script, { requires })
      }))
      return blocks.filter(Boolean).join('\n;\n')
    } catch (e) {
      warn('用户脚本解析失败：', errorMessage(e))
      return ''
    }
  }

  // ───────────────────────────────────────────────────────────────────────
  // 外壳 / 列表 / 浮层 / 页面补丁 / 命令（开放世界七类）
  // ───────────────────────────────────────────────────────────────────────

  /**
   * 按钮类贡献（navbar / rail / tabAction）的统一归一化。
   * 三者形状几乎相同，唯一的差别是消费方；归一化只写一遍，避免三份各自漂移。
   */
  function listButtons (kind: string): ButtonEntry[] {
    const out: ButtonEntry[] = []
    for (const item of contributions.list(kind)) {
      const pluginId = String(item.pluginId || '').trim()
      const id = String(item.id || '').trim()
      if (!pluginId || !id) continue
      out.push({
        id,
        pluginId,
        label: String(item.label || item.title || id),
        icon: item.icon ? String(item.icon) : '',
        tooltip: String(item.tooltip || item.title || ''),
        action: isRecord(item.action) ? item.action : null,
        enabled: item.enabled !== false,
        order: typeof item.order === 'number' && Number.isFinite(item.order) ? item.order : 0
      })
    }
    return out
  }

  function listNavbarButtons() { return listButtons(NAVBAR_BUTTONS_KIND) }
  function listRailButtons() { return listButtons(RAIL_BUTTONS_KIND) }
  function listTabActions() { return listButtons(TAB_ACTIONS_KIND) }

  /** 浮层描述符：纯数据，`page` 指向插件内部页（渲染侧用 iframe 载入）。 */
  function listOverlays (): OverlayEntry[] {
    const out: OverlayEntry[] = []
    for (const item of contributions.list(OVERLAYS_KIND)) {
      const pluginId = String(item.pluginId || '').trim()
      const id = String(item.id || '').trim()
      if (!pluginId || !id) continue
      out.push({
        id,
        pluginId,
        title: String(item.title || item.label || id),
        // page 允许写 `pageId`（本插件内）或 `pluginId:pageId`
        page: String(item.page || ''),
        anchor: String(item.anchor || 'center'),
        width: typeof item.width === 'number' && Number.isFinite(item.width) ? item.width : 0,
        height: typeof item.height === 'number' && Number.isFinite(item.height) ? item.height : 0,
        modal: item.modal === true,
        order: typeof item.order === 'number' && Number.isFinite(item.order) ? item.order : 0
      })
    }
    return out
  }

  /**
   * 面板改写 / 删除（做加法也做减法）。
   *
   * 归一化只在**这一处**做（manifest 的 `contributes.panelOverrides` 与运行时
   * `browser.ui.panel.override()` 走同一条路径），下游 panel-catalog 只认最终形状：
   *   · `{ id|panelId, remove: true }`              → 摘掉该面板
   *   · `{ id|panelId, hide: true }`                → `remove` 的别名（作者更愿意写 hide）
   *   · `{ id|panelId, patch: { title, icon, … } }` → 改写给定字段
   *   · `{ id|panelId, title, icon, … }`            → 省略 `patch` 时**直接把行内字段当 patch**
   *     （最常见的写法不该要求作者再包一层）
   */
  function listPanelOverrides() {
    const out = []
    for (const item of contributions.list(PANEL_OVERRIDES_KIND)) {
      const pluginId = String(item.pluginId || '').trim()
      const id = String(item.id || item.panelId || '').trim()
      if (!pluginId || !id) continue
      let patch: UnknownRecord | null = isRecord(item.patch) ? item.patch : null
      if (!patch) {
        // 行内字段兜底：只挑面板目录真正认识的键，多余字段一律不往下传。
        for (const key of PATCHABLE_PANEL_FIELDS) {
          if (!Object.prototype.hasOwnProperty.call(item, key)) continue
          patch = patch || {}
          patch[key] = item[key]
        }
      }
      out.push({
        id,
        panelId: String(item.panelId || id),
        pluginId,
        remove: item.remove === true || item.hide === true,
        patch,
        order: Number.isFinite(item.order) ? Number(item.order) : 0
      })
    }
    return out
  }

  /** 页面补丁：`{ id, urls|match|include, css, js, enabled }`。 */
  function listPagePatches() {
    const out = []
    for (const item of contributions.list(PAGE_PATCHES_KIND)) {
      const pluginId = String(item.pluginId || '').trim()
      const id = String(item.id || '').trim()
      if (!pluginId || !id) continue
      const patterns = []
      for (const field of [item.urls, item.match, item.include]) {
        const list = Array.isArray(field) ? field : (field ? [field] : [])
        for (const p of list) {
          const text = String(p || '').trim()
          if (text) patterns.push(text)
        }
      }
      const css = String(item.css || '')
      const js = String(item.js || '')
      if (!patterns.length || (!css && !js)) continue
      out.push({ id, pluginId, patterns, css, js, enabled: item.enabled !== false })
    }
    return out
  }

  function listCommands() {
    const out = []
    for (const item of contributions.list(COMMANDS_KIND)) {
      const pluginId = String(item.pluginId || '').trim()
      const id = String(item.id || '').trim()
      if (!pluginId || !id) continue
      out.push({
        id,
        pluginId,
        label: String(item.label || item.title || id),
        description: String(item.description || ''),
        keywords: Array.isArray(item.keywords) ? item.keywords.map(String) : [],
        action: item.action && typeof item.action === 'object' ? item.action : null,
        order: Number.isFinite(item.order) ? Number(item.order) : 0
      })
    }
    return out
  }

  /** 通配匹配：`*`、`*.example.com`、`https://x/*`（大小写不敏感）。 */
  function matchesPattern (pattern: unknown, url: unknown): boolean {
    const p = String(pattern || '').trim()
    if (!p) return false
    let re = ''
    for (const ch of p) {
      if (ch === '*') re += '.*'
      else re += ch.replace(/[.+?^${}()|[\]\\]/g, '\\$&')
    }
    try {
      return new RegExp(`^${re}$`, 'i').test(String(url || ''))
    } catch (_) {
      return false
    }
  }

  /** 某 URL 需要注入的页面补丁（合并 CSS / JS）。无命中返回 `{ css:'', js:'' }`。 */
  function resolvePagePatchesForUrl (url: unknown): { css: string; js: string } {
    const target = String(url || '')
    if (!target) return { css: '', js: '' }
    try {
      const protocol = new URL(target).protocol
      if (protocol !== 'http:' && protocol !== 'https:') return { css: '', js: '' }
    } catch (_) {
      return { css: '', js: '' }
    }
    const css: string[] = []
    const js: string[] = []
    for (const patch of listPagePatches()) {
      if (!patch.enabled) continue
      if (!patch.patterns.some((p) => matchesPattern(p, target))) continue
      if (patch.css) css.push(patch.css)
      if (patch.js) js.push(patch.js)
    }
    return { css: css.join('\n'), js: js.join('\n;\n') }
  }

  /**
   * 把**声明式** UI 贡献接进官方插槽调度器。
   *
   * 每个插件每个插槽只登记**一个**实现，实现内部现取 contributions ——
   * 于是"插件运行时增删一条 navbar 按钮"不需要反复 implement/remove
   * （扩展点只有按插件批量摘除，没有按 key 摘除）。
   */
  const declarativeRegistered = new Set<string>()
  function registerDeclarativeSlots (ep: ExtensionPointPort | null): number {
    if (!ep || typeof ep.implement !== 'function') return 0
    let count = 0
    for (const [kind, slotId] of Object.entries(DECLARATIVE_SLOT_BY_KIND)) {
      const pluginIds = new Set(contributions.list(kind).map((x) => String(x.pluginId || '')).filter(Boolean))
      for (const pluginId of pluginIds) {
        const token = `${slotId}\u0000${pluginId}`
        if (declarativeRegistered.has(token)) continue
        try {
          ep.implement(slotId, () => {
            const items: DeclarativeSlotItem[] = kind === OVERLAYS_KIND
              ? listOverlays().filter((item) => item.pluginId === pluginId).map((item) => ({
                  id: `${pluginId}:${item.id}`,
                  key: `${pluginId}:${item.id}`,
                  title: item.title,
                  icon: '',
                  page: item.page,
                  anchor: item.anchor,
                  width: item.width,
                  height: item.height,
                  modal: item.modal,
                  pluginId,
                  action: null
                }))
              : listButtons(kind).filter((item) => item.pluginId === pluginId).map((item) => ({
                  id: `${pluginId}:${item.id}`,
                  key: `${pluginId}:${item.id}`,
                  title: item.label,
                  icon: item.icon,
                  page: '',
                  anchor: '',
                  width: 0,
                  height: 0,
                  modal: false,
                  pluginId,
                  action: item.action
                }))
            return items.map((item) => ({
              ...item,
              label: item.title,
              onSelect: (payload: unknown): void => {
                if (item.action) runAction(item.action, { pluginId, payload: asRecord(payload) })
              }
            }))
          }, { pluginId, key: '__declarative' })
          declarativeRegistered.add(token)
          count += 1
        } catch (e) {
          warn(`登记声明式插槽失败（${slotId} / ${pluginId}）：`, errorMessage(e))
        }
      }
    }
    return count
  }

  // ───────────────────────────────────────────────────────────────────────
  // 变更传播
  // ───────────────────────────────────────────────────────────────────────

  function bangSignature() {
    return listBangs().map((b) => `${b.id}|${b.trigger}|${b.url}`).join('\u0001')
  }

  function menuSignature() {
    return listMenus()
      .map((m) => `${m.pluginId}|${m.id}|${m.where.join(',')}|${String(m.label || '')}|${m.order}|${m.enabled}|${JSON.stringify(m.action || null)}|${Array.isArray(m.submenu) ? m.submenu.length : 0}`)
      .join('\u0001')
  }

  /** 供 app-menu.js 使用的适配器（签名 + 按 where 取项 + 顶级菜单）。 */
  function getPluginMenus() {
    return {
      signature: `${generation}\u0000${menuSignature()}`,
      itemsFor: (where: unknown, state: unknown) => appMenuItems(where, state),
      roots: (state: unknown) => appRootMenus(state)
    }
  }

  /**
   * 贡献表变化后的**唯一同步入口**（插件启用 / 禁用 / 自动停用 / 启动就绪都走它）。
   * @returns {{ pages: boolean, bangs: boolean, menus: boolean, userscripts: boolean, chrome: boolean }}
   */
  function syncSurfaces() : { pages: boolean, bangs: boolean, menus: boolean, userscripts: boolean, chrome: boolean } {
    generation += 1
    const pages = syncPages()
    const bangs = bangSignature()
    const menus = menuSignature()
    const userscripts = userScriptSignature()
    // 外壳 / 浮层 / 命令：任何一条变化都要让渲染层重拉（不区分具体是哪类）。
    const chrome = JSON.stringify([
      listNavbarButtons(), listRailButtons(), listTabActions(), listOverlays(), listCommands()
    ])
    const prev = lastSurfaceSignature || { bangs: '', menus: '', userscripts: '', chrome: '' }
    lastSurfaceSignature = { bangs, menus, userscripts, chrome }
    const chromeChanged = chrome !== prev.chrome
    // 声明式 UI 贡献 → 官方插槽实现（幂等：每个插件每个插槽只登记一次）
    try { registerDeclarativeSlots(extensionPoints) } catch (_) {}
    const bangsChanged = bangs !== prev.bangs
    const menusChanged = menus !== prev.menus
    const userScriptsChanged = userscripts !== prev.userscripts
    if (pages && onPagesChanged) {
      try { onPagesChanged() } catch (e) { warn('onPagesChanged 回调失败：', errorMessage(e)) }
    }
    if (bangsChanged && onBangsChanged) {
      try { onBangsChanged() } catch (e) { warn('onBangsChanged 回调失败：', errorMessage(e)) }
    }
    if ((menusChanged || generation === 1) && onMenusChanged) {
      try { onMenusChanged() } catch (e) { warn('onMenusChanged 回调失败：', errorMessage(e)) }
    }
    if ((chromeChanged || generation === 1) && onChromeChanged) {
      try { onChromeChanged() } catch (e) { warn('onChromeChanged 回调失败：', errorMessage(e)) }
    }
    return { pages, bangs: bangsChanged, menus: menusChanged, userscripts: userScriptsChanged, chrome: chromeChanged }
  }

  return {
    PAGES_KIND,
    BANGS_KIND,
    MENUS_KIND,
    USERSCRIPTS_KIND,
    CONTEXT_WHERE_BY_KIND,
    // 页面
    listPages,
    pageUrl,
    syncPages,
    // bang
    listBangs,
    listBangsAsync,
    // 菜单
    listMenus,
    menuItems,
    appMenuItems,
    appRootMenus,
    contextMenuItems,
    getPluginMenus,
    // 用户脚本
    listUserScripts,
    listUserScriptsSummary,
    resolveUserScriptsForUrl,
    // 动作
    runAction,
    // 外壳 / 浮层 / 面板改写 / 页面补丁 / 命令（开放世界七类）
    listNavbarButtons,
    listRailButtons,
    listTabActions,
    listOverlays,
    listPanelOverrides,
    listPagePatches,
    listCommands,
    resolvePagePatchesForUrl,
    matchesPattern,
    // 生命周期
    syncSurfaces,
    registerDeclarativeSlots
  }
}

export {
  createPluginSurfaces,
  PAGES_KIND,
  BANGS_KIND,
  MENUS_KIND,
  USERSCRIPTS_KIND,
  NAVBAR_BUTTONS_KIND,
  RAIL_BUTTONS_KIND,
  TAB_ACTIONS_KIND,
  OVERLAYS_KIND,
  PANEL_OVERRIDES_KIND,
  PAGE_PATCHES_KIND,
  COMMANDS_KIND,
  DECLARATIVE_SLOT_BY_KIND,
  CONTEXT_WHERE_BY_KIND,
  pageHost,
  sanitizeSegment
}
