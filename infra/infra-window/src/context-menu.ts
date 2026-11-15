import {
  Menu,
  clipboard,
  type BrowserWindow,
  type ContextMenuParams,
  type MenuItemConstructorOptions,
  type WebContents
} from 'electron'
import { buildContextMenuModel, type ContextMenuItem } from './context-menu-model'
const { toggleReaderMode } = require('./reader-mode-script') as {
  toggleReaderMode(webContents: WebContents): unknown
}
import { stripTrackingParams } from '@hira-ng/shared-types/src/clean-url'
// 「刷新」的唯一语义实现：错误页 → 重试原网址；普通页 → reload。
import { reloadOrRetry } from './page-reload'
import { navigateWebHistory, readWebNavigationState } from './webNavigation'

/**
 * 网页右键菜单运行时。
 *
 * 参考实现：
 *   - Hira  `main/remoteMenu.js`：renderer 的 DOM contextmenu → ipc → 主进程 popup，
 *     popup **不在** 原生 context-menu 回调栈里，且 Menu 引用活到 `menu-will-close`。
 *   - RT    `tabs-controller/context-menu.ts` + electron-context-menu。
 *
 * 本文件的三条硬规则（三条缺一都会冻主进程）：
 *
 * 1. **绝不在原生 `context-menu` 回调里 popup。**
 *    页面跑在独立的 WebContentsView（独立 HWND）里，右键的 mouseup / 激活消息
 *    还在 Chromium 的派发栈上；此时同步 `Menu.popup()` 会立刻进入 Windows
 *    `TrackPopupMenu` 的嵌套消息循环，与未派发完的消息互相等待 →
 *    第一次右键正常，之后每次右键都卡死。这里只做「快照 + 调度」，
 *    真正的构菜单 / popup 全部推到下一轮事件循环（setImmediate）。
 *
 * 2. **Menu 引用必须活到 `menu-will-close`。**
 *    菜单展示期间若 JS 侧丢掉最后一个引用，原生菜单对象可能在弹层还开着时被回收，
 *    下一次 popup 就会撞上悬空的原生菜单。按窗口持有，关闭时释放。
 *
 * 3. **永不 `closePopup()`。**
 *    同一窗口同时只允许一个原生 popup，旧的由系统/Electron 在 popup 新菜单时
 *    自然关闭。同步 `closePopup()` 在 Windows 上会进入原生等待（历史卡死根因）。
 *    我们只替换引用，不做任何显式关闭。
 */

const DEBUG = process.env.HIRA_MENU_DEBUG === '1'

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** @type {Map<string, { menu: Electron.Menu, wc: Electron.WebContents }>} 窗口 → 正在展示的菜单 */
const activeMenus: Map<string, { menu: Electron.Menu, wc: Electron.WebContents }> = new Map<string, { menu: Menu; wc: WebContents }>()

export interface ContextMenuSnapshot {
  x: number
  y: number
  pageURL: string
  linkURL: string
  srcURL: string
  mediaType: string
  selectionText: string
  linkText: string
  titleText: string
  misspelledWord: string
  dictionarySuggestions: string[]
  isEditable: boolean
  editFlags: Partial<ContextMenuParams['editFlags']>
}

export interface ContextMenuOptions {
  ownerWindow?: BrowserWindow | null
  onOpenLink?: (url: string, disposition: 'foreground-tab' | 'background-tab' | 'new-window', params: ContextMenuSnapshot) => void
  onCapturePage?: (mode: 'viewport' | 'fullpage' | 'region') => void
  onTranslatePage?: (url: string) => void
  onPeekPreview?: (url: string) => void
  onSaveLinkAs?: (url: string) => void
  onSaveImageAs?: (url: string) => void
  onReload?: () => void
  onViewSource?: (url: string) => void
  onInspectElement?: (x: number, y: number) => void
  onSearchSelection?: (text: string) => void
  accelerator?: (command: string) => string
  searchLabel?: (text: string) => string
  excludeCommands?: readonly string[]
  labelOverrides?: Record<string, string>
  getExtensionMenuItems?: (webContents: WebContents, params: ContextMenuSnapshot) => unknown
  getHostMenuItems?: (webContents: WebContents, params: ContextMenuSnapshot) => unknown
}

interface ContributedMenuItem extends MenuItemConstructorOptions { group?: string }
type MenuCommand = (argument?: string) => unknown

/** 主进程事件循环卡顿告警阈值：超过就打印，用于定位"右键卡死"到底卡在哪。 */
const STALL_WARN_MS = 200

function keyOf(win: BrowserWindow | null | undefined): string {
  return win && !win.isDestroyed() ? `win:${win.id}` : 'global'
}

/**
 * 只取纯数据，彻底脱离 ContextMenuParams 的原生对象图。
 * 延迟到下一轮事件循环再构菜单时，params 已不再受原生侧生命周期保护，
 * 快照是唯一安全做法（顺带丢掉我们用不到的 `frame` 引用）。
 */
function snapshotParams(p: ContextMenuParams): ContextMenuSnapshot {
  const flags = p.editFlags || {}
  return {
    x: Number(p.x) || 0,
    y: Number(p.y) || 0,
    // 页面地址：供「翻译此页」等宿主动作使用。
    // 快照而非现取 —— 延迟构菜单时 params 已不受原生保护。
    pageURL: String(p.pageURL || ''),
    linkURL: String(p.linkURL || ''),
    srcURL: String(p.srcURL || ''),
    mediaType: p.mediaType || 'none',
    selectionText: String(p.selectionText || ''),
    // 链接文字 / 悬停标题（图片的 alt）。
    // 为什么快照出来：宿主内置项要用它们当"收录卡片的标题"（见 browser-window-assembly 的
    // 「添加此链接… / 添加此图…」）。原生 params 只在这一刻有效，理由与上面各字段相同。
    linkText: String(p.linkText || ''),
    titleText: String(p.titleText || ''),
    misspelledWord: String(p.misspelledWord || ''),
    dictionarySuggestions: Array.isArray(p.dictionarySuggestions) ? p.dictionarySuggestions.slice() : [],
    isEditable: !!p.isEditable,
    editFlags: {
      canUndo: flags.canUndo,
      canRedo: flags.canRedo,
      canCut: flags.canCut,
      canCopy: flags.canCopy,
      canPaste: flags.canPaste,
      canDelete: flags.canDelete,
      canSelectAll: flags.canSelectAll
    }
  }
}

function findOwnerWindow(webContents: WebContents | null | undefined): BrowserWindow | undefined {
  if (!webContents || webContents.isDestroyed()) return undefined
  try {
    const getOwner = (webContents as WebContents & { getOwnerBrowserWindow?: () => BrowserWindow }).getOwnerBrowserWindow
    const win = getOwner ? getOwner.call(webContents) : undefined
    if (win && !win.isDestroyed()) return win
  } catch (_) {}
  const host = webContents.hostWebContents
  if (host && !host.isDestroyed()) {
    try {
      const getHostOwner = (host as WebContents & { getOwnerBrowserWindow?: () => BrowserWindow }).getOwnerBrowserWindow
      const win = getHostOwner ? getHostOwner.call(host) : undefined
      if (win && !win.isDestroyed()) return win
    } catch (_) {}
  }
  return undefined
}

function createCommands(webContents: WebContents, params: ContextMenuSnapshot, options: ContextMenuOptions): Record<string, MenuCommand> {
  const linkUrl = params.linkURL
  const mediaUrl = params.srcURL
  return {
    'open-link': () => options.onOpenLink && options.onOpenLink(linkUrl, 'foreground-tab', params),
    'open-link-window': () => options.onOpenLink && options.onOpenLink(linkUrl, 'new-window', params),
    'open-media': () => options.onOpenLink && options.onOpenLink(mediaUrl, 'foreground-tab', params),
    'copy-link': () => linkUrl && clipboard.writeText(linkUrl),
    // 「复制干净链接」：去掉 utm_* / fbclid / gclid 等追踪参数再写入剪贴板。
    // 清理规则与菜单可见性判据同源（都来自 shared-types/clean-url）。
    'copy-clean-link': () => linkUrl && clipboard.writeText(stripTrackingParams(linkUrl)),
    'copy-media': () => mediaUrl && clipboard.writeText(mediaUrl),
    // 截图（J7）：infra 只报**哪种模式**（字符串）。
    // ⚠⚠ 这里**必须**传 mode 字符串，不能传对象 —— `onCapturePage` 是一条**薄转发**，
    //   宿主最终拿到的是 `{ tabId, webContents, mode }`，那个对象由**胶水层**
    //   （`tabEvents.js` 的 `wc.on('context-menu')` / `web-sidebar.js`）补齐：
    //   它才知道 tabId，也才持有该页面的 wc。infra 层既没有 tabId，也不该替宿主决定"截谁"。
    //   曾经误改成传 `{ webContents, mode }` → 那个对象被当成 `mode` 收下 → 宿主认不出
    //   任何合法模式 → 落到兜底分支 `'fullpage'`，表现就是"点『截取选区』截出来的是整页"。
    'capture-viewport': () => options.onCapturePage && options.onCapturePage('viewport'),
    'capture-fullpage': () => options.onCapturePage && options.onCapturePage('fullpage'),
    // 框选截图：同上，只报 'region'；框选图层由宿主摆（见 main/capture-region.js）。
    'capture-region': () => options.onCapturePage && options.onCapturePage('region'),
    // 翻译此页（C3）：infra 只报"翻译这一页"，语言与引擎都在宿主侧（目标语言是设置项）。
    'translate-page': () => options.onTranslatePage && options.onTranslatePage(params.pageURL),
    // 小窗预览（N1）：**只属于链接分组** —— 它是"打开一个链接"里最轻的那一档
    //（不占标签栏、不占一整个窗口，看完即关，`Ctrl+Enter` 可收为正式标签），
    // 所以入口只该出现在**链接**上，取的是 `linkURL`。
    // ⚠ **页面分组刻意不再有这一条**：那条只能拿到 `pageURL`，语义上变成"把本页搬进小窗"，
    //   而右键一个链接时两组会**同时**出现在同一张菜单里，两条"小窗预览"必然有一条
    //   开着你不想要的那个地址。小窗是宿主侧的应用级单例（见 main/peek.js）。
    'peek-link': () => options.onPeekPreview && options.onPeekPreview(linkUrl),
    'save-link': () => options.onSaveLinkAs && options.onSaveLinkAs(linkUrl),
    'save-media': () => options.onSaveLinkAs && options.onSaveLinkAs(mediaUrl),
    'save-image': () => options.onSaveImageAs
      ? options.onSaveImageAs(mediaUrl)
      : (options.onSaveLinkAs && options.onSaveLinkAs(mediaUrl)),
    'copy-image': () => webContents.copyImageAt(params.x, params.y),
    'picture-in-picture': () => webContents.executeJavaScript(
      `(() => { const e=document.elementFromPoint(${params.x},${params.y}); const v=e?.tagName==='VIDEO'?e:e?.closest?.('video'); return v?.requestPictureInPicture?.(); })()`
    ),
    'replace-misspelling': (suggestion) => { if (suggestion) webContents.replaceMisspelling(suggestion) },
    'add-to-dictionary': () => params.misspelledWord && webContents.session.addWordToSpellCheckerDictionary(params.misspelledWord),
    // 所有导航入口共用 navigationHistory 封装，避免各调用点重复处理能力判断。
    back: () => navAction(webContents, 'goBack'),
    forward: () => navAction(webContents, 'goForward'),
    // 刷新：错误页必须回到**原网址**（错误页只是过渡视图）。宿主若给了 `onReload`
    // （标签 / 独立侧栏都有自己的刷新语义），优先交给宿主；否则走同一份 page-reload。
    reload: () => (typeof options.onReload === 'function' ? options.onReload() : reloadOrRetry(webContents)),
    stop: () => webContents.stop(),
    'reader-mode': () => toggleReaderMode(webContents),
    print: () => webContents.print(),
    'view-source': () => options.onViewSource
      ? options.onViewSource(webContents.getURL())
      : options.onOpenLink && options.onOpenLink(`view-source:${webContents.getURL()}`, 'foreground-tab', params),
    inspect: () => options.onInspectElement
      ? options.onInspectElement(params.x, params.y)
      : webContents.inspectElement(params.x, params.y),
    'search-selection': () => options.onSearchSelection && options.onSearchSelection(params.selectionText)
  }
}

function resolveExtensionItems(items: unknown): ContributedMenuItem[] {
  if (!Array.isArray(items)) return []
  return items.filter((item: unknown): item is ContributedMenuItem =>
    !!item && typeof item === 'object' && typeof (item as { click?: unknown }).click === 'function')
}

/**
 * 执行一次导航历史动作（goBack / goForward），永不抛。
 * @param {Electron.WebContents} wc
 * @param {'goBack'|'goForward'} action
 */
function navAction(wc: WebContents, action: 'goBack' | 'goForward'): void {
  navigateWebHistory(wc, action === 'goBack' ? 'back' : 'forward')
}

/**
 * 现取当前页的导航态（后退 / 前进可用性、是否在加载）。
 *
 * 为什么不放进 snapshotParams：那不是「这次点击的上下文」，而是**菜单被构建那一刻**
 * 的页面状态 —— 只能在这里现取，才会是最新的。能力读不到时按「不可用」处理：
 * 宁可暂时置灰，也不留下一个可点击但没有动作的菜单项。
 *
 * @param {Electron.WebContents} wc
 */
function readNavState(wc: WebContents): { canGoBack: boolean; canGoForward: boolean; loading: boolean } {
  return readWebNavigationState(wc)
}

/** 去掉首尾 / 连续的空白分隔符（过滤掉整组命令后会出现）。 */
function pruneSeparators<T extends { type?: string }>(items: T[]): T[] {
  const out: T[] = []
  for (const item of items) {
    if (item.type === 'separator') {
      if (out.length === 0 || out[out.length - 1].type === 'separator') continue
    }
    out.push(item)
  }
  while (out.length > 0 && out[out.length - 1].type === 'separator') out.pop()
  return out
}

/**
 * 按 command 递归剔除条目（含子菜单）。
 *
 * 子菜单被剔空时父项一并去掉 —— 否则会留下一个点了没有内容的「截图」父项
 * （宿主整组排除 `capture-*` 时正是这种情况）。
 * `role` 项（剪切 / 复制…）不带 command，永远保留。
 * @param {any[]} items
 * @param {Set<string>} excluded
 * @returns {any[]}
 */
function excludeItems(items: ContextMenuItem[], excluded: ReadonlySet<string>): ContextMenuItem[] {
  const out: ContextMenuItem[] = []
  for (const item of items) {
    if (!item) continue
    if (item.type === 'separator') {
      out.push(item)
      continue
    }
    if (item.command && excluded.has(item.command)) continue
    if (Array.isArray(item.submenu)) {
      const submenu = excludeItems(item.submenu, excluded)
      if (submenu.length === 0) continue
      out.push({ ...item, submenu })
      continue
    }
    out.push(item)
  }
  return out
}

/** 把纯数据模型 + 命令端口编译成 Electron 菜单模板。纯内存、无原生调用。 */
function compileTemplate(wc: WebContents, params: ContextMenuSnapshot, options: ContextMenuOptions): MenuItemConstructorOptions[] {
  const commands = createCommands(wc, params, options)
  const model = buildContextMenuModel(params as unknown as ContextMenuParams, {
    searchLabel: options.searchLabel,
    // 快捷键提示的唯一来源：宿主注入的解析器（`menuAccelerator` 的绑定）。
    // 模型层不写组合键字面量 —— 四个菜单面各自手抄正是漂移的来源。
    accelerator: options.accelerator,
    // 与导航按钮同源的状态：无历史时「后退 / 前进」置灰，加载中时「重新加载」变「停止加载」。
    nav: readNavState(wc)
  })

  // 宿主可按 command 排除条目（PWA 应用窗没有标签世界 / 截图 / 翻译等宿主服务）。
  // 只作用于带 command 的项；`role` 项（剪切 / 复制 / 粘贴…）不在此列。
  // 递归进子菜单：整组截图被排除后「截图」父项也随之消失，不留空菜单。
  const excluded = Array.isArray(options.excludeCommands) ? new Set(options.excludeCommands) : null
  const visibleModel = excluded
    ? pruneSeparators(excludeItems(model, excluded))
    : model

  // 宿主可按 command 改写文案（PWA 应用窗里「在新标签页中打开链接」没有标签页概念，
  // 必须说「在浏览器中打开」）。与 excludeCommands 一样只作用于带 command 的项 ——
  // role 项的文案由系统按语言渲染，本模块不介入。
  const overrides = options.labelOverrides && typeof options.labelOverrides === 'object'
    ? options.labelOverrides
    : null

  const template: MenuItemConstructorOptions[] = []
  /**
   * 分组 id → 该组**最后一项**在 template 里的下标。
   *
   * 宿主 / 插件贡献的项可以带 `group: 'link'`（"请把我放进链接那一组"）——
   * 插入点必须由本文件算：只有这里知道每一组包含哪几项、最后一项落在哪个下标。
   * 若把这个下标数交给装配层，每加一条内置菜单项都会错一次位。
   * @type {Map<string, number>}
   */
  const sectionEnd: Map<string, number> = new Map<string, number>()

  /**
   * 模型项 → Electron 菜单模板项（递归）。
   *
   * 子菜单内部不登记 `sectionEnd`：宿主 / 插件只能在**顶层分组**末尾插入，
   * 内嵌子项不是"分组"，给它插入点会让规则变得不可预测。
   * @param {any} item
   * @returns {any}
   */
  const mapItem = (item: ContextMenuItem): MenuItemConstructorOptions => {
    if (item.type === 'separator') return { type: 'separator' }
    const command = item.command ? commands[item.command] : undefined
    const menuItem: MenuItemConstructorOptions = {
      label: (overrides && item.command && overrides[item.command]) || item.label,
      role: item.role as MenuItemConstructorOptions['role'],
      accelerator: item.accelerator,
      enabled: item.enabled
    }
    if (command) {
      menuItem.click = item.command === 'replace-misspelling'
        ? () => {
            try { Promise.resolve(command(item.label)).catch((e: unknown) => console.warn('[context-menu] action failed:', errorMessage(e))) } catch (e) { console.warn('[context-menu] action failed:', errorMessage(e)) }
          }
        : () => {
            try { Promise.resolve(command()).catch((e: unknown) => console.warn('[context-menu] action failed:', errorMessage(e))) } catch (e) { console.warn('[context-menu] action failed:', errorMessage(e)) }
          }
    }
    if (Array.isArray(item.submenu)) {
      menuItem.submenu = pruneSeparators(item.submenu.map(mapItem))
    }
    return menuItem
  }

  for (const item of visibleModel) {
    if (item.type === 'separator') {
      template.push({ type: 'separator' })
      continue
    }
    template.push(mapItem(item))
    if (item.section) sectionEnd.set(item.section, template.length - 1)
  }

  const extensionItems = typeof options.getExtensionMenuItems === 'function'
    ? resolveExtensionItems(options.getExtensionMenuItems(wc, params))
    : []
  // 宿主自带项（例如"把这个网页放到侧栏" / "添加此链接到集锦"）：与扩展项同样只是**数据**
  // （`{ label, click, submenu?, group? }`）—— 本模块不认识它们的业务含义，只负责塞进菜单。
  const hostItems = typeof options.getHostMenuItems === 'function'
    ? resolveExtensionItems(options.getHostMenuItems(wc, params))
    : []

  /**
   * 按 `group` 把贡献项插到对应分组的**末尾**；`group` 不认识 / 没给 → 保持原来的
   * "整体追加到菜单末尾"（绝不静默丢弃 —— 那会表现成"某一项凭空消失"）。
   * 插入前必须把 `group` 剥掉：`Menu.buildFromTemplate` 只认 Electron 的字段。
   * @type {Map<number, object[]>}
   */
  const grouped: Map<number, object[]> = new Map<number, ContributedMenuItem[]>()
  /** @type {object[][]} 每个来源一组"没有分组"的项（保持来源之间的分隔，与旧行为一致） */
  const leftovers: ContributedMenuItem[][] = []
  const collect = (items: ContributedMenuItem[]): void => {
    const rest: ContributedMenuItem[] = []
    for (const raw of items) {
      const item = { ...raw }
      if (typeof item.click === 'function') {
        const click = item.click as (...args: unknown[]) => unknown
        item.click = ((...args: unknown[]) => {
          try {
            Promise.resolve(click(...args)).catch((e: unknown) => console.warn('[context-menu] contributed action failed:', errorMessage(e)))
          } catch (e) {
            console.warn('[context-menu] contributed action failed:', errorMessage(e))
          }
        }) as typeof item.click
      }
      const group = item.group
      delete item.group
      const index = typeof group === 'string' ? sectionEnd.get(group) : undefined
      if (index != null) {
        if (!grouped.has(index)) grouped.set(index, [])
        grouped.get(index)?.push(item)
      } else {
        rest.push(item)
      }
    }
    if (rest.length > 0) leftovers.push(rest)
  }
  collect(extensionItems)
  collect(hostItems)

  const merged: MenuItemConstructorOptions[] = []
  template.forEach((item, index) => {
    merged.push(item)
    const extra = grouped.get(index)
    if (extra) merged.push(...extra)
  })
  for (const block of leftovers) merged.push({ type: 'separator' }, ...block)
  return pruneSeparators(merged)
}

/**
 * 弹出网页右键菜单。
 *
 * 本函数**只做参数快照与调度**，保证原生 `context-menu` 回调立刻返回；
 * 构菜单与 popup 在下一轮事件循环执行（规则 1）。
 *
 * @param {Electron.WebContents} webContents
 * @param {Electron.ContextMenuParams} rawParams
 * @param {object} [options]
 * @param {Electron.BrowserWindow} [options.ownerWindow] 宿主窗口，由 TabManager 传入
 * @param {Function} [options.onReload] 宿主的「刷新」（缺省时用 page-reload 的通用语义）
 * @param {(command: string) => string} [options.accelerator]
 *   菜单项快捷键解析器（`command` → Electron accelerator）。宿主用
 *   `keybindings.mjs#menuAccelerator` 绑定当前键位 —— 用户改键后菜单自动跟随。
 *   缺省 = 不显示快捷键提示。
 */
export function showWebContentMenu(
  webContents: WebContents,
  rawParams: ContextMenuParams,
  options: ContextMenuOptions = {}
): void {
  if (!webContents || webContents.isDestroyed() || !rawParams) return

  const params = snapshotParams(rawParams)
  const ownerWindow = (options.ownerWindow && !options.ownerWindow.isDestroyed())
    ? options.ownerWindow
    : findOwnerWindow(webContents)
  const key = keyOf(ownerWindow)

  const scheduledAt = Date.now()
  setImmediate(() => {
    // 这一段跑在原生派发栈之外：如果它被推迟了很久，说明主进程当时真的被卡住了。
    const lag = Date.now() - scheduledAt
    if (lag > STALL_WARN_MS) {
      console.warn('[ctxmenu] main loop stall detected:', lag, 'ms before deferred popup')
    }
    if (webContents.isDestroyed()) return

    const builtAt = DEBUG ? Date.now() : 0
    const template = compileTemplate(webContents, params, options)
    if (template.length === 0) return
    if (DEBUG) console.log('[ctxmenu] build template:', Date.now() - builtAt, 'ms, items:', template.length)

    const menu = Menu.buildFromTemplate(template)

    // 诊断：上一个菜单还挂着就又来一次右键 —— 这正是"第二次右键"卡死的现场特征。
    if (activeMenus.has(key)) {
      console.warn('[ctxmenu] popup requested while previous menu still tracked:', key)
    }

    // 规则 2：引用活到关闭为止（规则 3：不显式 closePopup，只替换引用）
    activeMenus.set(key, { menu, wc: webContents })
    menu.once('menu-will-close', () => {
      const entry = activeMenus.get(key)
      if (entry && entry.menu === menu) activeMenus.delete(key)
    })

    const popupAt = DEBUG ? Date.now() : 0
    try {
      menu.popup({ window: ownerWindow || undefined })
    } catch (error: unknown) {
      const entry = activeMenus.get(key)
      if (entry && entry.menu === menu) activeMenus.delete(key)
      if (DEBUG) console.warn('[ctxmenu] popup failed:', error instanceof Error ? error.message : error)
    }
    // 诊断：popup() 若长时间才返回，说明卡的是原生 TrackPopupMenu 而非我们的 JS。
    if (DEBUG) console.log('[ctxmenu] popup() returned after', Date.now() - popupAt, 'ms')
  })
}

/**
 * 网页/窗口销毁时释放菜单引用。
 * 不调用 closePopup —— 原生 popup 会随宿主窗口/WebContents 一起消失；
 * 但对应的 JS 引用必须丢掉，否则会留下指向已死 WebContents 的悬空菜单。
 * @param {Electron.WebContents} [webContents]
 */
export function closeWebContentMenu(webContents: WebContents | null | undefined): void {
  if (!webContents) return
  const win = findOwnerWindow(webContents)
  if (!win) return
  const key = keyOf(win)
  const entry = activeMenus.get(key)
  if (entry && entry.wc === webContents) activeMenus.delete(key)
}

export { findOwnerWindow }
