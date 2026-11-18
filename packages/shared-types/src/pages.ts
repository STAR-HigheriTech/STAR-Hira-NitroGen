/**
 * 内部页（`hira://<host>`）身份表 —— **唯一真源**。
 *
 * ── 它解决什么 ────────────────────────────────────────────────────────────
 * 改造前，"一个内部页叫什么、有没有公共侧栏、出现在哪几份清单里"被手抄在
 * 七八个地方：公共侧栏注册表、应用菜单的工具菜单、右上角 ⋮ 菜单 + PAGE_ACTIONS、
 * 主进程动作表、设置页「内部页面」分区、新标签页快捷入口、地址栏命令表…
 * 于是同一件事出现了三种叫法（书签 / 书签管理 / 收藏夹；扩展 / 扩展管理 / 扩展程序；
 * 证书 / 证书查看器），新增一页要改七八处，漏一处就是"侧栏里有、菜单里没有"。
 *
 * 现在只有这一张表：
 *   · `PAGES`       —— 身份（host / 中文名 / 字形 / 所在导航分组 / 外壳策略）；
 *   · `pageUrl`     —— 唯一的拼法（`hira://<host>?<query>`），别再手写字符串；
 *   · `pageLabel`   —— 唯一的叫法，任何界面的入口标题都从这里取。
 *
 * 各消费面**只保留自己的顺序**（导航分组顺序 / ⋮ 菜单顺序 / 新标签页顺序 /
 * 设置页清单顺序），成员与文案一律回到这里查 —— 顺序是界面决策，身份不是。
 *
 * ── 谁在读它 ─────────────────────────────────────────────────────────────
 *   · 主进程（CJS `require`）：应用菜单 label、`main.js` 的 open* 动作、设置页 registry；
 *   · 渲染层（ESM）：右上角 ⋮ 菜单；
 *   · 内部页（`hira://shared/pages.mjs`）：新标签页快捷入口、公共侧栏。
 * 三条通路与 `settings-groups.mjs` 完全相同（相对导入 `./settings-groups.mjs` 在
 * `out/pages/_shared/` 里同样成立，因为 canonical 文件是平铺复制过去的）。
 *
 * ⚠ 新增一个内部页：
 *   1. `pages/<host>/` 放页面；
 *   2. 在 `PAGE_DEFS` 加一行（`section` 决定它出现在公共侧栏哪一组，`null` = 不上侧栏）；
 *   3. 需要独有图标就在行里给 `glyph`（不写 = 兜底字形，不会没有图标）。
 *   想让它进 ⋮ 菜单 / 新标签页快捷入口 / 设置页清单，再对应数组里加一个 host 即可。
 */

import { settingsGroupLabel } from './settings-groups.js'
// 地址拼法本身是零依赖原语（`page-url.mjs`），这里只是转出去 —— 历史上把拼法
// 和身份表写在一起，导致被 pages.mjs 依赖的 settings-groups 反过来只能手抄地址。
import { canonicalPageHost, pageUrl } from './page-url.js'

export { pageUrl }

/** 注入公共左侧导航（默认）。 */
export const PAGE_SHELL_SHARED = 'shared'
/** 页面自带导航（目前只有设置页），不再注入公共侧栏。 */
export const PAGE_SHELL_OWN = 'own'

/**
 * 导航分组顺序 = 公共侧栏的分组顺序。
 * `general` / `browsing` 是内部页特有的两组；其余四组与设置页大类同名，
 * 标题一律从 `settings-groups.mjs` 派生（同一件事在两处导航里必须叫同一个名字）。
 */
const SECTION_ORDER = ['general', 'browsing', 'privacy', 'tools', 'extensions', 'system']
/** @type {Record<string, string>} */
const SECTION_LABELS: Record<string, string> = { general: '基础', browsing: '浏览' }

export interface PageDef {
  host: string
  label: string
  menuLabel?: string
  glyph?: string
  section?: string | null
  shell?: string
  feature?: string
}

/** @type {PageDef[]} */
const PAGE_DEFS: PageDef[] = [
  // ── 基础 ────────────────────────────────────────────────────────────────
  { host: 'settings', label: '设置', glyph: 'Settings', section: 'general', shell: PAGE_SHELL_OWN },
  // ── 浏览 ────────────────────────────────────────────────────────────────
  { host: 'history', label: '历史记录', glyph: 'Clock', section: 'browsing', feature: 'history' },
  { host: 'bookmarks', label: '书签', glyph: 'Star', section: 'browsing', feature: 'bookmarks' },
  { host: 'downloads', label: '下载中心', glyph: 'Download', section: 'browsing', feature: 'downloads' },
  { host: 'sessions', label: '会话管理', glyph: 'Archive', section: 'browsing', feature: 'session' },
  // ── 隐私与安全 ──────────────────────────────────────────────────────────
  { host: 'permissions', label: '站点权限', glyph: 'Shield', section: 'privacy', feature: 'permissions' },
  { host: 'cookies', label: 'Cookie', glyph: 'Cookie', section: 'privacy' },
  { host: 'passwords', label: '密码', glyph: 'KeyRound', section: 'privacy', feature: 'passwords' },
  { host: 'passkeys', label: 'Passkey', glyph: 'BadgeCheck', section: 'privacy' },
  { host: 'formfill', label: '地址与支付卡', glyph: 'ClipboardList', section: 'privacy' },
  { host: 'certificates', label: '证书', glyph: 'BadgeCheck', section: 'privacy' },
  { host: 'clear-data', label: '清除浏览数据', glyph: 'Trash2', section: 'privacy' },
  // ── 工具 ────────────────────────────────────────────────────────────────
  // AI 助手：三种宿主（侧栏面板 / 独立窗口 / 本页）共用同一份面板实现，本页自有导航——
  // 它是一整块聊天界面，套内部页统一外壳会让侧栏和聊天区各占一半，失去"全视口聊天"的意义。
  //
  // 两页都登记 `feature: 'ai'`：AI 引擎 / 面板插件被关掉时，侧栏与各菜单里的入口必须一起消失
  // （否则点进去是空白聊天页）。门禁只有 `feature-map.js#ai` 这一处，这里只声明归属。
  { host: 'ai', label: 'AI 助手', glyph: 'Sparkles', section: 'tools', shell: PAGE_SHELL_OWN, feature: 'ai' },
  { host: 'aisettings', label: 'AI 设置', glyph: 'Sparkles', section: 'tools', feature: 'ai' },
  // 不登记 feature：keybindings 的读取有本地兜底（`ipc/keybindings.js` 的 fallback），
  // 引擎被关掉时这一页**仍然可用** —— 按事实登记，不能凭"引擎同名"就把它藏了。
  { host: 'shortcuts', label: '键盘快捷键', glyph: 'Keyboard', section: 'tools' },
  { host: 'automation', label: '自动化', glyph: 'Zap', section: 'tools' },
  { host: 'themes', label: '主题', glyph: 'Palette', section: 'tools' },
  // ── 扩展与插件 ──────────────────────────────────────────────────────────
  { host: 'extensions', label: '扩展', glyph: 'Puzzle', section: 'extensions', feature: 'extensions' },
  // 自带导航（与设置页同构：侧栏 + 主区）。它的侧栏是**本页的板块切换**，
  // 不是内部页之间的跳转 —— 两者叠在一起会出现两条侧栏，语义也互相打架。
  { host: 'plugins', label: '插件', menuLabel: '插件中心', glyph: 'Blocks', section: 'extensions', shell: PAGE_SHELL_OWN },
  { host: 'apps', label: '已安装应用', glyph: 'AppWindow', section: 'extensions', feature: 'pwaApps' },
  { host: 'games', label: '游戏库', glyph: 'Gamepad', section: 'extensions' },
  // ── 系统与数据 ──────────────────────────────────────────────────────────
  { host: 'spaces', label: '空间', glyph: 'Layers', section: 'system', feature: 'spaces' },
  { host: 'import-data', label: '导入数据', glyph: 'Upload', section: 'system' },
  { host: 'task-manager', label: '任务管理器', glyph: 'Activity', section: 'system' },
  { host: 'crash-report', label: '崩溃报告', glyph: 'Bug', section: 'system' },
  { host: 'about', label: '关于 Hira', glyph: 'Sparkle', section: 'system' },

  // ── 功能窗口（被调用方带参数唤起，不上侧栏、不进管理入口）───────────────
  { host: 'newtab', label: '新标签页', glyph: 'Home' },
  { host: 'archive', label: '离线归档', glyph: 'Archive', feature: 'notes' },
  { host: 'onboarding', label: '欢迎' },
  { host: 'profiles', label: '配置文件', glyph: 'Users' },
  { host: 'page-info', label: '页面信息', glyph: 'Info' },
  { host: 'view-source', label: '查看源代码', glyph: 'Code' },
  { host: 'share', label: '分享', glyph: 'Share2' },
  { host: 'print-preview', label: '打印预览' },
  { host: 'color-picker', label: '取色器', glyph: 'Pipette' },
  { host: 'http-auth', label: '需要登录', glyph: 'Lock' },
  { host: 'jsdialog', label: '对话框', glyph: 'MessageSquare' },
  { host: 'error', label: '页面无法访问', glyph: 'TriangleAlert' },
  { host: 'pdf', label: 'PDF', glyph: 'FileText' }
]

/** @type {ReadonlyArray<Readonly<PageDef & { section: string|null, shell: string }>>} */
export const PAGES: ReadonlyArray<Readonly<PageDef & { section: string|null, shell: string }>> = Object.freeze(
  PAGE_DEFS.map((page) => Object.freeze({
    section: null,
    shell: PAGE_SHELL_SHARED,
    ...page
  }))
)

const BY_HOST = new Map(PAGES.flatMap((page) => {
  const canonical = canonicalPageHost(page.host)
  return canonical === page.host
    ? [[page.host, page] as const]
    : [[page.host, page] as const, [canonical, page] as const]
}))

/**
 * @param {unknown} host
 * @returns {Readonly<PageDef> | null}
 */
export function findPage(host: unknown) : Readonly<PageDef> | null {
  return BY_HOST.get(canonicalPageHost(host)) || null
}

/**
 * host → 界面统一叫法。未知 host（插件新增页 / 老书签）退到调用方给的兜底。
 * @param {unknown} host
 * @param {string} [fallback]
 * @returns {string}
 */
export function pageLabel(host: unknown, fallback: string = '') : string {
  const page = findPage(host)
  if (page) return page.label
  return fallback || String(host == null ? '' : host)
}

/**
 * host → **菜单**里的叫法（`menuLabel` 优先，没有就退回 `pageLabel`）。
 * 侧栏要紧凑、菜单可以更完整，但两者都还是同一张表里的字，不另抄一份。
 * @param {unknown} host
 * @param {string} [fallback]
 * @returns {string}
 */
export function pageMenuLabel(host: unknown, fallback: string = '') : string {
  const page = findPage(host)
  if (page) return page.menuLabel || page.label
  return fallback || String(host == null ? '' : host)
}

/**
 * host → 这一页背后的**功能面** id（未登记 = 空串 = 恒可用，fail-open）。
 *
 * 菜单面只问这一个函数，不另抄「动作 → 功能面」的映射：页面身份与它背后的引擎
 * 是同一件事，写在一起才不会出现"页面还在、菜单项却被藏了"（或反过来）。
 * @param {unknown} host
 * @returns {string}
 */
export function pageFeature(host: unknown) : string {
  const page = findPage(host)
  return (page && page.feature) || ''
}

/**
 * 公共侧栏的分组（成员来自 `PAGES` 的 `section` 字段，顺序来自 `SECTION_ORDER`）。
 * 空分组会自动消失 —— 不会有"标题下面一条空行"。
 */
export const SHELL_NAV_GROUPS = Object.freeze(
  SECTION_ORDER
    .map((id) => Object.freeze({
      id,
      label: (SECTION_LABELS as Readonly<Record<string, string>>)[id] || settingsGroupLabel(id),
      hosts: Object.freeze(
        PAGES.filter((page) => page.section === id).map((page) => page.host)
      )
    }))
    .filter((group) => group.hosts.length > 0)
)

/**
 * 右上角 ⋮ 菜单里的一级页面入口（顺序 = 菜单顺序）。
 * 菜单里的非页面项（新建组 / 集锦 / 编辑按钮 / 重新加载）由渲染层补充。
 */
export const NAVBAR_PAGE_ENTRIES = Object.freeze([
  'history',
  'bookmarks',
  'downloads',
  'extensions',
  'passwords',
  'spaces',
  'settings'
])

/** 「更多管理页面」的落点 —— 公共侧栏的宿主页。改落点只动这一行。 */
export const MORE_PAGES_HOST = 'history'

/**
 * ⋮ 菜单里的「特色功能」入口（顺序 = 菜单顺序）。
 * 与管理页分开成一组：它们是完整功能页（插件中心自带导航、主题是换肤入口），
 * 不是"查数据"的管理页。成员与叫法仍然只在这张表里。
 */
export const NAVBAR_FEATURE_ENTRIES = Object.freeze([
  'plugins',
  'themes'
])

/** 新标签页顶部的快捷入口（顺序即显示顺序）。 */
export const NEWTAB_QUICK_LINKS = Object.freeze([
  'history',
  'bookmarks',
  'spaces',
  'settings'
])

/**
 * 设置页「系统与数据 → 内部页面」分区的直达清单（顺序即显示顺序）。
 * 「关于 Hira」不在此列 —— 它已经有自己的大类，同一件事开两个入口只会让人以为有两处。
 */
export const SETTINGS_INTERNAL_ENTRIES = Object.freeze([
  {
    host: 'sessions',
    desc: '保存整套标签为会话，随时整体恢复或拆分打开。',
    action: '打开会话管理'
  },
  {
    host: 'spaces',
    desc: '按用途划分独立的标签、书签与配置档案。',
    action: '打开空间'
  },
  {
    host: 'apps',
    desc: '查看从网页安装的应用，管理它们的启动与移除。',
    action: '打开应用列表'
  },
  {
    host: 'games',
    desc: '整理并快速启动浏览器内置的小游戏。',
    action: '打开游戏库'
  },
  {
    host: 'import-data',
    desc: '从其它浏览器导入书签、历史与密码。',
    action: '打开导入页'
  },
  {
    host: 'task-manager',
    desc: '查看每个标签与扩展的内存占用，可强制结束。',
    action: '打开任务管理器'
  },
  {
    host: 'certificates',
    desc: '查看本次会话读取过的站点证书链与证书校验失败记录。',
    action: '打开证书查看器'
  },
  {
    host: 'crash-report',
    desc: '查看最近的崩溃记录并打包导出。',
    action: '打开崩溃报告'
  }
].map((entry) => Object.freeze({ ...entry, href: pageUrl(entry.host) })))
