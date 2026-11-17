/**
 * 应用动作面 —— 浏览器「所有菜单动作」的**元数据 + 唯一执行入口**。
 *
 * ── 为什么要有这个文件 ─────────────────────────────────────────────────────
 * `main.js` 的 `appMenuActions` 是原生菜单、插件菜单 `action.type='command'`、
 * 任务栏 JumpList 三者共用的**唯一动作执行表**。AI 要能「操作浏览器所有角落」，
 * 最忌讳的是另起一套平行的动作实现（两套实现必然漂移，最后谁也不知道
 * "关闭标签"到底走的是哪一条）。
 *
 * 所以这里只做两件事：
 *   1. 给那张表补一份**元数据**（分组 / 中文名 / 说明 / 参数 schema）；
 *   2. 提供 `list()` / `run()` —— 执行仍然逐字落在 `appMenuActions[name]()` 上。
 *
 * 新增一个菜单动作时：只在 `appMenuActions` 加实现 + 在本文件 `CATALOG` 加一行，
 * 原生菜单、插件菜单、AI 三条通路同时拿到。
 *
 * ── 边界 ──────────────────────────────────────────────────────────────────
 *  · 不 require electron；`actions` / `getState` 全部由 main.js 注入。
 *  · `run()` 只做参数归一与可用性判定，不复制任何业务逻辑。
 */

import type { SettingsActionPort } from './settings/actions'

/**
 */
export interface ActionArg {
  name: string
  type: 'string' | 'number' | 'boolean'
  required?: boolean
  enum?: string[]
  desc: string
}

export interface ActionDef {
  name: string
  group: string
  label: string
  desc: string
  args?: ActionArg[]
  requires?: string
}

export interface ActionGroup { id: string; label: string }

interface ActionResult {
  ok: true
  action: string
  args: unknown[]
  result: unknown
}

interface ActionState extends Record<string, unknown> {
  spaces?: Array<{ id: unknown; name: unknown }>
  windows?: unknown[]
  collections?: unknown[]
  currentSpaceId?: unknown
  bookmarkbarMode?: unknown
  canCollectCurrentPage?: unknown
  canInstallCurrentPage?: unknown
}

type ActionHandler = (...args: unknown[]) => unknown | Promise<unknown>

interface AppActionsOptions {
  actions?: Record<string, ActionHandler>
  getState?: () => ActionState | null | undefined
  settingsActions?: SettingsActionPort | null
}

interface AppActions {
  list(group?: unknown, options?: { availableOnly?: boolean; query?: unknown }): Array<{ id: string; label: string; actions: Array<Record<string, unknown>> }>
  run(name: unknown, rawArgs: unknown): Promise<ActionResult>
  runSettingAction(route: unknown, rawArgs?: unknown): Promise<ActionResult>
  settingsActionRoutes(): string[]
  targets(): Record<string, unknown>
  groups: ActionGroup[]
}

/** 分组顺序 = 列表里的展示顺序。 */
export const GROUPS: readonly ActionGroup[] = [
  { id: 'window', label: '窗口与标签' },
  { id: 'navigation', label: '导航与缩放' },
  { id: 'view', label: '视图' },
  { id: 'page', label: '页面操作' },
  { id: 'web', label: '网页与选区' },
  { id: 'library', label: '库与面板' },
  { id: 'settings', label: '设置与数据' },
  { id: 'pwa', label: '应用（PWA）' },
  { id: 'space', label: '空间' }
]

const GROUP_IDS = new Set<string>(GROUPS.map((group) => group.id))
const GROUP_KEYWORDS: Readonly<Record<string, readonly string[]>> = Object.freeze({
  window: ['标签右键菜单', '标签页右键'],
  web: ['网页右键菜单', '页面右键']
})

function keywordsOf(group: string): string[] {
  return ['主菜单', ...(GROUP_KEYWORDS[group] || [])]
}

export const CATALOG: readonly ActionDef[] = [
  // ── 窗口与标签 ────────────────────────────────────────────────────────────
  { name: 'windowNew', group: 'window', label: '新建窗口', desc: '打开一个新的浏览器窗口。' },
  { name: 'windowNewIncognito', group: 'window', label: '新建无痕窗口', desc: '打开一个新的无痕窗口。' },
  { name: 'tabNew', group: 'window', label: '新建标签页', desc: '在当前窗口新建标签页（默认新标签页）。' },
  { name: 'tabNewIncognito', group: 'window', label: '新建无痕标签页', desc: '在当前窗口新建无痕标签页。' },
  {
    name: 'tabClose', group: 'window', label: '关闭标签',
    desc: '关闭指定标签；省略 tabId 时关闭当前活动标签。',
    args: [{ name: 'tabId', type: 'string', desc: '标签 id，省略 = 当前活动标签' }]
  },
  {
    name: 'tabReload', group: 'window', label: '重新加载',
    desc: '重新加载指定标签；省略 tabId 时作用于当前活动标签。',
    args: [{ name: 'tabId', type: 'string', desc: '标签 id，省略 = 当前活动标签' }]
  },
  { name: 'tabForceReload', group: 'window', label: '强制重新加载', desc: '忽略缓存强制重新加载当前标签。' },
  { name: 'tabNext', group: 'window', label: '下一个标签', desc: '切换到右侧标签。' },
  { name: 'tabPrev', group: 'window', label: '上一个标签', desc: '切换到左侧标签。' },
  { name: 'tabUndoClose', group: 'window', label: '恢复关闭的标签', desc: '恢复最近关闭的一个标签。' },
  {
    name: 'tabRestoreRecentlyClosed', group: 'window', label: '恢复指定最近关闭项',
    desc: '按最近关闭列表的下标恢复（0 = 最近关闭的一项）。',
    args: [{ name: 'index', type: 'number', required: true, desc: '下标，从 0 开始' }]
  },
  { name: 'tabClearRecentlyClosed', group: 'window', label: '清空最近关闭列表', desc: '清空「最近关闭的标签页」记录。' },
  {
    name: 'tabSleep', group: 'window', label: '让标签休眠',
    desc: '释放指定标签占用的内存；省略 tabId 时作用于当前标签。',
    args: [{ name: 'tabId', type: 'string', desc: '标签 id，省略 = 当前活动标签' }]
  },
  {
    name: 'tabTogglePin', group: 'window', label: '固定/取消固定',
    desc: '切换指定标签的固定状态；省略 tabId 时作用于当前标签。',
    args: [{ name: 'tabId', type: 'string', desc: '标签 id，省略 = 当前活动标签' }]
  },
  {
    name: 'tabToggleMute', group: 'window', label: '静音/取消静音',
    desc: '切换指定标签的静音状态；省略 tabId 时作用于当前标签。',
    args: [{ name: 'tabId', type: 'string', desc: '标签 id，省略 = 当前活动标签' }]
  },
  {
    name: 'tabCloseOthers', group: 'window', label: '关闭其他标签',
    desc: '关闭指定标签以外全部标签；省略 tabId 时以当前活动标签为准。',
    args: [{ name: 'tabId', type: 'string', desc: '保留的标签 id，省略 = 当前活动标签' }]
  },
  {
    name: 'tabDuplicate', group: 'window', label: '复制标签',
    desc: '复制指定标签；省略 tabId 时复制当前标签。',
    args: [{ name: 'tabId', type: 'string', desc: '标签 id，省略 = 当前活动标签' }]
  },
  {
    name: 'tabCloseRight', group: 'window', label: '关闭右侧标签',
    desc: '关闭指定标签右侧的全部普通标签；省略 tabId 时从当前标签开始。',
    args: [{ name: 'tabId', type: 'string', desc: '起始标签 id，省略 = 当前活动标签' }]
  },
  {
    name: 'tabArchive', group: 'window', label: '归档标签',
    desc: '关闭标签并收进「已归档」，之后可从历史面板恢复。',
    args: [{ name: 'tabId', type: 'string', desc: '标签 id，省略 = 当前活动标签' }]
  },
  {
    name: 'tabAutoRefresh', group: 'window', label: '设置标签定时刷新',
    desc: '按分钟设置自动刷新；0 表示关闭。支持 1 / 5 / 30 分钟。',
    args: [
      { name: 'minutes', type: 'number', required: true, desc: '0 / 1 / 5 / 30' },
      { name: 'tabId', type: 'string', desc: '标签 id，省略 = 当前活动标签' }
    ]
  },
  {
    name: 'tabGroupByDomain', group: 'window', label: '按域名分组标签',
    desc: '把与指定标签同域名的标签收进一个标签组。',
    args: [{ name: 'tabId', type: 'string', desc: '标签 id，省略 = 当前活动标签' }]
  },
  {
    name: 'tabSplitToggle', group: 'window', label: '分屏或解散分屏',
    desc: '当前标签已分屏时解散；否则与相邻标签建立分屏。'
  },
  {
    name: 'tabGlanceToggle', group: 'window', label: '速览或退出速览',
    desc: '当前标签已速览时退出；否则与相邻标签建立速览。'
  },
  {
    name: 'splitFocus', group: 'window', label: '切换分屏焦点',
    desc: '在分屏格之间按方向移动焦点。',
    args: [{ name: 'direction', type: 'string', required: true, enum: ['left', 'right', 'up', 'down'], desc: 'left / right / up / down' }]
  },
  { name: 'tabMoveToNewWindow', group: 'window', label: '移到新窗口', desc: '把当前标签移到新窗口。' },
  {
    name: 'tabMoveToWindow', group: 'window', label: '移到指定窗口',
    desc: '把当前标签移到另一个窗口（窗口 id 见 app_action_list 的 spaces/windows 状态）。',
    args: [{ name: 'windowId', type: 'string', required: true, desc: '目标窗口 id' }]
  },
  { name: 'tabSearch', group: 'window', label: '搜索已打开的标签', desc: '打开标签搜索面板。' },

  // ── 导航与缩放 ────────────────────────────────────────────────────────────
  { name: 'navBack', group: 'navigation', label: '后退', desc: '当前标签后退一页。' },
  { name: 'navForward', group: 'navigation', label: '前进', desc: '当前标签前进一页。' },
  { name: 'zoomIn', group: 'navigation', label: '放大', desc: '当前页面放大一档。' },
  { name: 'zoomOut', group: 'navigation', label: '缩小', desc: '当前页面缩小一档。' },
  { name: 'zoomReset', group: 'navigation', label: '重置缩放', desc: '当前页面缩放恢复 100%。' },

  // ── 视图 ──────────────────────────────────────────────────────────────────
  { name: 'readerMode', group: 'view', label: '阅读模式', desc: '在当前页切换阅读模式覆盖层。' },
  { name: 'findInPage', group: 'view', label: '页内查找', desc: '打开页内查找栏。' },
  { name: 'toggleFullscreen', group: 'view', label: '全屏', desc: '切换窗口全屏。' },
  { name: 'toggleDevTools', group: 'view', label: '开发者工具', desc: '为当前标签打开/关闭开发者工具。' },
  { name: 'toggleRail', group: 'view', label: '固定/取消固定工具栏', desc: '切换 rail 是否常驻占位。' },
  {
    name: 'setBookmarkbarMode', group: 'view', label: '书签栏显示策略',
    desc: '设置书签栏显示模式。',
    args: [{ name: 'mode', type: 'string', required: true, enum: ['always', 'newtab', 'never'], desc: 'always / newtab / never' }]
  },

  // ── 页面操作 ──────────────────────────────────────────────────────────────
  { name: 'pageSave', group: 'page', label: '保存网页', desc: '把当前页面保存到本机。' },
  { name: 'pagePrint', group: 'page', label: '打印', desc: '打印当前页面。' },
  { name: 'openPageInfo', group: 'page', label: '页面信息', desc: '打开当前页的页面信息（新标签）。' },
  { name: 'openViewSource', group: 'page', label: '查看源代码', desc: '打开当前页源代码窗口。' },
  { name: 'bookmarkToggle', group: 'page', label: '收藏当前页', desc: '打开「添加/编辑书签」窗口。' },
  {
    name: 'collectCurrentPage', group: 'page', label: '收进集锦',
    desc: '把当前网页收进指定集锦；target 为集锦 id，留空 = 未归档。',
    requires: 'canCollectCurrentPage',
    args: [{ name: 'target', type: 'string', desc: '集锦（文件夹）id，可空' }]
  },
  { name: 'archiveCurrent', group: 'page', label: '归档当前页', desc: '把当前网页归档到本地面板，之后可从归档区恢复。' },

  // ── 网页与选区（网页右键菜单）────────────────────────────────────────────
  { name: 'webUndo', group: 'web', label: '撤销编辑', desc: '撤销当前网页可编辑区域或输入框中的操作。' },
  { name: 'webRedo', group: 'web', label: '重做编辑', desc: '重做当前网页可编辑区域中的操作。' },
  { name: 'webCut', group: 'web', label: '剪切', desc: '剪切当前网页选区。' },
  { name: 'webCopy', group: 'web', label: '复制选区', desc: '复制当前网页选区到剪贴板。' },
  { name: 'webPaste', group: 'web', label: '粘贴', desc: '把剪贴板内容粘贴到当前网页的焦点位置。' },
  { name: 'webDelete', group: 'web', label: '删除选区', desc: '删除当前网页选区或输入框中的内容。' },
  { name: 'webSelectAll', group: 'web', label: '全选网页内容', desc: '选中当前网页或焦点输入框中的全部内容。' },
  {
    name: 'webOpenLink', group: 'web', label: '在新标签打开链接',
    desc: '在新标签页打开指定链接。',
    args: [{ name: 'url', type: 'string', required: true, desc: 'http(s) 链接' }]
  },
  {
    name: 'webOpenLinkWindow', group: 'web', label: '在新窗口打开链接',
    desc: '在新浏览器窗口打开指定链接。',
    args: [{ name: 'url', type: 'string', required: true, desc: 'http(s) 链接' }]
  },
  {
    name: 'webCopyLink', group: 'web', label: '复制链接地址',
    desc: '把指定链接写入剪贴板。',
    args: [{ name: 'url', type: 'string', required: true, desc: '链接地址' }]
  },
  {
    name: 'webCopyCleanLink', group: 'web', label: '复制干净链接',
    desc: '移除 utm_*、fbclid、gclid 等跟踪参数后复制链接。',
    args: [{ name: 'url', type: 'string', required: true, desc: '链接地址' }]
  },
  {
    name: 'webSaveLinkAs', group: 'web', label: '将链接另存为',
    desc: '启动下载并保存指定链接。',
    args: [{ name: 'url', type: 'string', required: true, desc: '链接地址' }]
  },
  {
    name: 'webOpenMedia', group: 'web', label: '在新标签打开媒体',
    desc: '在新标签页打开图片、音频或视频地址。',
    args: [{ name: 'url', type: 'string', required: true, desc: '媒体地址' }]
  },
  {
    name: 'webCopyMedia', group: 'web', label: '复制媒体地址',
    desc: '把图片、音频或视频地址写入剪贴板。',
    args: [{ name: 'url', type: 'string', required: true, desc: '媒体地址' }]
  },
  {
    name: 'webSaveMediaAs', group: 'web', label: '将媒体另存为',
    desc: '启动下载并保存指定媒体。',
    args: [{ name: 'url', type: 'string', required: true, desc: '媒体地址' }]
  },
  {
    name: 'webSearchSelection', group: 'web', label: '搜索网页选区',
    desc: '用当前默认搜索引擎搜索选区；可显式传 text。',
    args: [{ name: 'text', type: 'string', desc: '要搜索的文字，省略 = 当前网页选区' }]
  },
  {
    name: 'webPictureInPicture',
    group: 'web',
    label: '视频画中画',
    desc: '让当前网页的视频进入画中画；可用 selector 指定视频元素。',
    args: [{ name: 'selector', type: 'string', desc: 'CSS 选择器，省略 = 第一个 video' }]
  },
  {
    name: 'webInspectElement',
    group: 'web',
    label: '检查网页元素',
    desc: '打开开发者工具并检查指定 CSS 元素；省略 selector 时检查页面主体。',
    args: [{ name: 'selector', type: 'string', desc: 'CSS 选择器，省略 = body' }]
  },

  // ── 库与面板 ──────────────────────────────────────────────────────────────
  { name: 'openBookmarks', group: 'library', label: '打开书签页', desc: '在当前标签打开 hira://bookmarks。' },
  { name: 'openHistory', group: 'library', label: '打开历史记录', desc: '在当前标签打开 hira://history。' },
  { name: 'openDownloads', group: 'library', label: '打开下载', desc: '在当前标签打开 hira://downloads。' },
  { name: 'openApps', group: 'library', label: '打开已安装应用', desc: '在当前标签打开 hira://apps。' },
  { name: 'openCollections', group: 'library', label: '打开集锦面板', desc: '打开/关闭集锦侧栏面板。' },
  { name: 'openSessionsPanel', group: 'library', label: '打开会话面板', desc: '打开/关闭会话侧栏面板。' },
  { name: 'openSpaces', group: 'library', label: '打开空间页', desc: '在当前标签打开 hira://spaces。' },
  { name: 'openShortcuts', group: 'library', label: '打开快捷键页', desc: '在当前标签打开 hira://shortcuts。' },
  { name: 'openTaskManager', group: 'library', label: '打开任务管理器', desc: '打开任务管理器窗口。' },
  { name: 'openAbout', group: 'library', label: '打开关于页', desc: '在当前标签打开 hira://about。' },
  { name: 'openUpdate', group: 'library', label: '检查更新', desc: '打开「关于 Hira → 更新」选项卡。' },

  // ── 设置与数据 ────────────────────────────────────────────────────────────
  { name: 'openExtensions', group: 'settings', label: '打开扩展页', desc: '在当前标签打开 hira://extensions。' },
  { name: 'openPasswords', group: 'settings', label: '打开密码页', desc: '在当前标签打开 hira://passwords。' },
  { name: 'generatePassword', group: 'settings', label: '生成密码', desc: '打开密码生成浮层。' },
  { name: 'openPermissions', group: 'settings', label: '打开站点权限页', desc: '在当前标签打开 hira://permissions。' },
  { name: 'openCookies', group: 'settings', label: '打开 Cookie 页', desc: '在当前标签打开 hira://cookies。' },
  { name: 'openClearData', group: 'settings', label: '打开清除浏览数据页', desc: '在当前标签打开 hira://clear-data。' },
  { name: 'openImportData', group: 'settings', label: '打开导入数据页', desc: '在当前标签打开 hira://import-data。' },
  { name: 'openCertificates', group: 'settings', label: '打开证书页', desc: '在新标签打开证书页，并检查当前站点的证书链。' },
  { name: 'openCrashReport', group: 'settings', label: '打开崩溃报告页', desc: '在当前标签打开 hira://crash-report。' },

  // ── 应用（PWA）────────────────────────────────────────────────────────────
  {
    name: 'installCurrentPage', group: 'pwa', label: '将当前页安装为应用',
    desc: '把当前网页安装成独立应用（已安装则聚焦应用窗口）。',
    requires: 'canInstallCurrentPage'
  },

  // ── 空间 ──────────────────────────────────────────────────────────────────
  {
    name: 'switchSpace', group: 'space', label: '切换空间',
    desc: '切换到指定空间（副作用：当前窗口换空间）。',
    args: [{ name: 'spaceId', type: 'string', required: true, desc: '空间 id' }]
  }
]

const BY_NAME = new Map(CATALOG.map((def) => [def.name, def]))

/** 动作结果只回可序列化的普通数据；Electron 活对象、函数和循环引用一律丢弃。 */
function compactResult(value: unknown, depth = 0, seen = new WeakSet<object>()): unknown {
  if (value == null || typeof value === 'boolean' || typeof value === 'number') return value
  if (typeof value === 'string') return value.length > 1200 ? `${value.slice(0, 1200)}…` : value
  if (typeof value === 'bigint') return String(value)
  if (typeof value !== 'object' || depth >= 4) return null
  if (seen.has(value)) return null
  seen.add(value)
  if (Array.isArray(value)) return value.slice(0, 30).map((item) => compactResult(item, depth + 1, seen))
  const proto = Object.getPrototypeOf(value)
  if (proto !== Object.prototype && proto !== null) return null
  const out: Record<string, unknown> = {}
  for (const key of Object.keys(value as Record<string, unknown>).slice(0, 40)) {
    if (/^(webContents|browserWindow|nativeImage|session|manager|controller|ipcMain)$/i.test(key)) continue
    const next = compactResult((value as Record<string, unknown>)[key], depth + 1, seen)
    if (next !== undefined && next !== null) out[key] = next
  }
  return out
}

/** 参数归一：按声明的类型转，不合法就抛（让模型看到明确原因）。 */
function coerceArg(def: ActionArg, raw: unknown): unknown {
  if (raw === undefined || raw === null || raw === '') {
    if (def.required) throw new Error(`缺少参数 ${def.name}（${def.desc}）`)
    return undefined
  }
  if (def.type === 'number') {
    const n = Number(raw)
    if (!Number.isFinite(n)) throw new Error(`参数 ${def.name} 必须是数字，收到：${String(raw)}`)
    return n
  }
  if (def.type === 'boolean') {
    if (typeof raw === 'boolean') return raw
    const s = String(raw).trim().toLowerCase()
    if (['true', '1', 'on', 'yes', '开', '是'].includes(s)) return true
    if (['false', '0', 'off', 'no', '关', '否'].includes(s)) return false
    throw new Error(`参数 ${def.name} 必须是布尔值，收到：${String(raw)}`)
  }
  const s = String(raw)
  if (Array.isArray(def.enum) && def.enum.length && !def.enum.includes(s)) {
    throw new Error(`参数 ${def.name} 只能是 ${def.enum.join(' / ')}，收到：${s}`)
  }
  return s
}

/**
 * @param {{ actions: Record<string, Function>, getState?: () => any }} deps
 */
export function createAppActions(deps: AppActionsOptions = {}): AppActions {
  const actions = deps.actions || {}
  const getState = typeof deps.getState === 'function' ? deps.getState : () => ({})
  const settingsActions = deps.settingsActions || null

  /** 当前状态快照（缺省空对象 —— 列表在启动早期被调用时不该炸）。 */
  function state(): ActionState {
    try {
      return getState() || {}
    } catch (_) {
      return {}
    }
  }

  function available(def: ActionDef): boolean {
    if (!def.requires) return true
    return Boolean(state()[def.requires])
  }

  /** 模型可见的参数简写：`index*` / `mode=always|newtab|never`。 */
  function argHint(def: ActionDef): string {
    const list = Array.isArray(def.args) ? def.args : []
    if (!list.length) return ''
    return list.map((a) => {
      const optional = a.required ? '' : '?'
      const enumHint = Array.isArray(a.enum) && a.enum.length ? `=${a.enum.join('|')}` : ''
      return `${a.name}${optional}${enumHint}`
    }).join(', ')
  }

  function view(def: ActionDef): Record<string, unknown> {
    return {
      name: def.name,
      label: def.label,
      desc: def.desc,
      args: argHint(def),
      keywords: keywordsOf(def.group),
      available: available(def)
    }
  }

  /**
   * 分组清单。`group` 不传 = 全部分组；`availableOnly` 只保留当前可用的动作。
   */
  function list(group: unknown, opts: { availableOnly?: boolean; query?: unknown } = {}): Array<{ id: string; label: string; actions: Array<Record<string, unknown>> }> {
    const want = String(group == null ? '' : group).trim()
    if (want && !GROUP_IDS.has(want)) {
      throw new Error(`未知分组 ${want}（可用：${GROUPS.map((g) => g.id).join(' / ')}）`)
    }
    const availableOnly = opts.availableOnly !== false
    const query = String(opts.query || '').trim().toLowerCase()
    return GROUPS
      .filter((g) => !want || g.id === want)
      .map((g) => ({
        id: g.id,
        label: g.label,
        actions: CATALOG
          .filter((def) => def.group === g.id)
          .filter((def) => !availableOnly || available(def))
          .filter((def) => !query || `${def.name} ${def.label} ${def.desc} ${g.label} ${keywordsOf(def.group).join(' ')}`.toLowerCase().includes(query))
          .map(view)
      }))
      .filter((g) => g.actions.length > 0)
  }

  /** 空间 / 窗口等「选目标」需要的运行时状态（与菜单勾选态同一份 getState）。 */
  function targets(): Record<string, unknown> {
    const s = state()
    return {
      spaces: Array.isArray(s.spaces) ? s.spaces.map((x) => ({ id: x.id, name: x.name })) : [],
      currentSpaceId: s.currentSpaceId || null,
      windows: Array.isArray(s.windows) ? s.windows : [],
      collections: Array.isArray(s.collections) ? s.collections : [],
      bookmarkbarMode: s.bookmarkbarMode || null,
      canCollectCurrentPage: !!s.canCollectCurrentPage,
      canInstallCurrentPage: !!s.canInstallCurrentPage
    }
  }

  /**
   * 执行一个动作。返回形状固定为 `{ ok, action, args, result? }`：
   * 结果只透传导出安全的基本类型（对象/数组不往模型里倒，避免把 webContents 之类
   * 不可序列化的东西塞进工具结果）。
   */
  async function run(name: unknown, rawArgs: unknown): Promise<ActionResult> {
    const key = String(name == null ? '' : name).trim()
    const def = BY_NAME.get(key)
    if (!def) throw new Error(`未知动作 ${key}（先调 app_action_list 查看可用动作名）`)
    const impl = actions[key]
    if (typeof impl !== 'function') throw new Error(`动作 ${key} 尚未就绪（当前窗口还没装配完）`)
    if (!available(def)) throw new Error(`动作 ${key} 当前不可用（${def.requires}=false）`)

    const input = rawArgs && typeof rawArgs === 'object' ? rawArgs as Record<string, unknown> : {}
    const positional = (Array.isArray(def.args) ? def.args : []).map((a) => coerceArg(a, input[a.name]))
    const out = await impl(...positional)
    const safe = compactResult(out)
    return { ok: true, action: key, args: positional, result: safe }
  }

  /**
   * 动作型设置与设置页共用 `runRoute`。返回值保持与普通动作一致，AI 不需要
   * 再理解两套结果形状；未知路由明确报错，避免“点了一下没反应”的假成功。
   */
  async function runSettingAction(route: unknown, rawArgs: unknown = {}): Promise<ActionResult> {
    const key = String(route == null ? '' : route).trim()
    if (!settingsActions || !settingsActions.has(key)) {
      throw new Error(`设置动作尚未注册执行器：${key || '(空路由)'}`)
    }
    const input = rawArgs && typeof rawArgs === 'object' ? rawArgs as Record<string, unknown> : {}
    const out = await settingsActions.run(key, input)
    return { ok: true, action: key, args: [input], result: compactResult(out) }
  }

  return {
    list,
    run,
    runSettingAction,
    settingsActionRoutes: () => settingsActions ? settingsActions.list() : [],
    targets,
    groups: GROUPS.map((g) => ({ ...g }))
  }
}

