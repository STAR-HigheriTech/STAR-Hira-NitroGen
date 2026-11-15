/**
 * settings/registry.js — 设置分区注册中心（纯数据，无 Electron 依赖）
 *
 * 主旨（对齐 NG 解耦 / 模块化 / 插件化）：
 *   设置页不硬编码任何具体设置项。每个功能模块（搜索 / 隐私 / 下载 / 标签页…）
 *   通过 registerSection 声明自己的「设置分区」，设置页只是这些分区的**通用渲染器**。
 *     - 解耦：页面不认识任何 key，只认 schema；
 *     - 模块化：每项设置归属于它真正的模块（与 appliers/ 一一对应）；
 *     - 插件化：任何 Mod/扩展都能 registerSection 挂自己的分区，设置页零改动即扩展。
 *
 * 边界：
 *   domain-settings 是唯一数据源（get/set/subscribe/list/reset）；
 *   本注册中心只描述「UI 该怎么渲染」，是渲染契约，不含业务逻辑、不读写文件。
 *
 * 与 appliers/ 平行：
 *   appliers 回答「设置变了主进程做什么」；registry 回答「设置页该怎么展示」。
 *   二者都通过注册表挂载，互不耦合。
 *
 * ── `desc`（设置项说明）的写法纪律 ──────────────────────────────────────
 *   默认**不写** desc。标签（label）与选项名已经把意思说清楚了，
 *   再加一句同义复述只是噪音。只有下面两种情况才写，且**一句话讲完**：
 *     ① 标签看不出来的**非显然行为**（如「归档会关闭标签且不进撤销栈」）；
 *     ② 选项之间**互斥 / 联动**的坑（如「选侧栏即进入垂直标签布局」）。
 *   不写"即时生效""下次启动生效"这类套话（那是实现细节），不写举例铺陈。
 */

export interface SettingsField extends Record<string, unknown> {
  key: string
  label?: string
  type?: string
  subtab?: string
}

interface SettingsSubtab { id: string; label: string; keys: string[] }
interface SettingsSubtabView { id: string; label: string }

export interface SettingsSectionDefinition {
  id: string
  label?: string
  icon?: string
  group?: string
  blurb?: string
  entry?: unknown
  subtabs?: unknown[]
  fields: SettingsField[]
}

export interface SettingsSection {
  id: string
  label: string
  group: string
  icon: string
  blurb: string
  entry: unknown
  subtabs: SettingsSubtabView[]
  fields: SettingsField[]
}

export interface SettingsRegistry {
  registerSection(definition: SettingsSectionDefinition): void
  getSchema(): SettingsSection[]
  getField(key: string): SettingsField | null
  _sections: SettingsSection[]
}

// 书签栏显示策略（三态取值 + 中文名）的真源，主进程与渲染层共用同一份。
// 这里是 require（CJS）：Electron 43 运行时为 Node 24，可直接加载 .mjs。
const {
  BOOKMARKBAR_SETTING_KEY,
  BOOKMARKBAR_MODE_OPTIONS,
  DEFAULT_BOOKMARKBAR_MODE
} = require('@hira-ng/shared-types/src/bookmarkbar.mjs')
// 网络代理（键名 / 模式选项 / 默认值）的真源 —— applier 与设置页同源，见 proxy.mjs。
const {
  PROXY_SETTING_KEYS, PROXY_MODE_VALUES, PROXY_MODE_OPTIONS, DEFAULT_PROXY_SETTINGS
} = require('@hira-ng/shared-types/src/proxy.mjs')
const {
  SECURE_DNS_SETTING_KEYS,
  SECURE_DNS_MODE_OPTIONS,
  SECURE_DNS_PROVIDER_OPTIONS,
  DEFAULT_SECURE_DNS_SETTINGS
} = require('@hira-ng/shared-types/src/secure-dns.mjs')
// 内置搜索引擎真源：默认值 / 下拉选项都由域层从同一份表推出，设置页不抄引擎名。
const { SEARCH_SETTING_KEYS, DEFAULT_SEARCH_SETTINGS } =
  require('@hira-ng/shared-types/src/search-settings.mjs')
// 扩展系统：键名 + 缺省值 —— 构造期读取 / 扩展页 / 设置页同源，见 extensions-settings.mjs。
const { EXTENSIONS_SETTING_KEYS, DEFAULT_EXTENSIONS_SETTINGS } =
  require('@hira-ng/shared-types/src/extensions-settings.mjs')
// 浏览器标识（UA）：预设表 / 键名 —— applier 与设置页同源，见 user-agent.mjs。
const {
  USER_AGENT_SETTING_KEYS, UA_PRESET_OPTIONS, DEFAULT_USER_AGENT_SETTINGS, UA_CUSTOM_PRESET_ID
} = require('@hira-ng/shared-types/src/user-agent.mjs')
// 浏览器指纹伪装：键名 / 平台选项 —— 注入 applier 与设置页同源，见 fingerprint.mjs。
const { FINGERPRINT_SETTING_KEY, FINGERPRINT_PLATFORM_OPTIONS } = require('@hira-ng/shared-types/src/fingerprint.mjs')
// 启动 / 主页：键名 + 模式取值 + 默认值 —— 启动编排、主页解析、引导页与设置页同源，见 startup.mjs。
const {
  STARTUP_SETTING_KEYS, STARTUP_MODES, DEFAULT_STARTUP_MODE,
  HOME_MODES, DEFAULT_HOME_MODE, DEFAULT_HOME_URL
} = require('@hira-ng/shared-types/src/startup.mjs')
// 无障碍：键名 / 字号档位 / 默认值 —— 主进程注入与设置页同源，见 accessibility.mjs。
const {
  ACCESSIBILITY_SETTING_KEYS, FONT_SIZE_OPTIONS, DEFAULT_FONT_SIZE
} = require('@hira-ng/shared-types/src/accessibility.mjs')
// PDF：键名 / 缩放档位 / 默认值 —— 内置阅读器与设置页同源，见 pdf.mjs。
const { PDF_SETTING_KEYS, PDF_ZOOM_OPTIONS, DEFAULT_PDF_ZOOM } = require('@hira-ng/shared-types/src/pdf.mjs')
// 侧边面板分段（键名 / 取值集合 / 默认值）—— 分段壳、域层默认值与设置页同源，见 panels.mjs。
const {
  PANELS_SETTING_KEYS, PINNED_VIEW_MODE_OPTIONS, DEFAULT_PINNED_VIEW_MODE
} = require('@hira-ng/shared-types/src/panels.mjs')
// 网页注入：键名 / 强制深色档位 —— 注入 applier 与设置页同源，见 page-inject.mjs。
const {
  PAGE_INJECT_SETTING_KEYS, FORCE_DARK_OPTIONS, DEFAULT_FORCE_DARK
} = require('@hira-ng/shared-types/src/page-inject.mjs')
// 下载：键名 / 缺省值 / 取值域 / 危险文件三档 —— 下载运行时与设置页同源，见 downloads.mjs。
const {
  DOWNLOAD_SETTING_KEYS,
  DEFAULT_DOWNLOAD_SETTINGS,
  DOWNLOAD_CONNECTION_LIMITS,
  SAFE_BROWSING_OPTIONS,
  DEFAULT_SAFE_BROWSING
} = require('@hira-ng/shared-types/src/downloads.mjs')

/** 下载字段的缺省值 —— 与域层默认值同源（字段表只写业务名，不重复写值）。 */
function downloadDefault(name: string): unknown {
  return DEFAULT_DOWNLOAD_SETTINGS[DOWNLOAD_SETTING_KEYS[name]]
}
// 性能：键名 / 缺省值 —— 启动期 Chromium 开关、域层默认值与设置页同源，见 performance.mjs。
const { PERFORMANCE_SETTING_KEYS, DEFAULT_PERFORMANCE_SETTINGS } =
  require('@hira-ng/shared-types/src/performance.mjs')
// 标签页行为：键名 / 缺省值 —— 启动恢复、新标签位置、关闭确认等六个消费点与域层同源。
const { TABS_SETTING_KEYS, DEFAULT_TABS_SETTINGS } =
  require('@hira-ng/shared-types/src/tabs-settings.mjs')
// 隐私 / 安全：键名 / 缺省值 —— 拦截、退出清理、DNT、密码/表单填充与域层同源。
const { PRIVACY_SETTING_KEYS, DEFAULT_PRIVACY_SETTINGS } =
  require('@hira-ng/shared-types/src/privacy-settings.mjs')

/** 性能字段的缺省值 —— 与域层默认值同源（同上，字段表不重复写值）。 */
function performanceDefault(name: string): unknown {
  return DEFAULT_PERFORMANCE_SETTINGS[PERFORMANCE_SETTING_KEYS[name]]
}

/** 标签页行为字段的缺省值 —— 与域层默认值同源（tabs-settings.mjs 一份）。 */
function tabsDefault(name: string): unknown {
  return DEFAULT_TABS_SETTINGS[TABS_SETTING_KEYS[name]]
}

/** 隐私字段的缺省值 —— 与域层默认值同源（privacy-settings.mjs 一份）。 */
function privacyDefault(name: string): unknown {
  return DEFAULT_PRIVACY_SETTINGS[PRIVACY_SETTING_KEYS[name]]
}

/** 搜索字段的缺省值 —— 与域层默认值同源（search-settings.mjs 一份）。 */
function searchDefault(name: string): unknown {
  return DEFAULT_SEARCH_SETTINGS[SEARCH_SETTING_KEYS[name]]
}

/** 扩展系统字段的缺省值 —— 与域层默认值同源（extensions-settings.mjs 一份）。 */
function extensionsDefault(name: string): unknown {
  return DEFAULT_EXTENSIONS_SETTINGS[EXTENSIONS_SETTING_KEYS[name]]
}

/** 代理字段的缺省值 —— 与域层默认值同源（proxy.mjs 一份）。 */
function proxyDefault(name: string): unknown {
  return DEFAULT_PROXY_SETTINGS[PROXY_SETTING_KEYS[name]]
}

function secureDnsDefault(name: string): unknown {
  return DEFAULT_SECURE_DNS_SETTINGS[SECURE_DNS_SETTING_KEYS[name]]
}

/** 浏览器标识字段的缺省值 —— 与域层默认值同源（user-agent.mjs 一份）。 */
function userAgentDefault(name: string): unknown {
  return DEFAULT_USER_AGENT_SETTINGS[USER_AGENT_SETTING_KEYS[name]]
}
// 标签保留：键名 / 归档档位 —— 归档定时器、恢复过滤与设置页同源，见 tabs-retention.mjs。
const {
  TABS_RETENTION_SETTING_KEYS, ARCHIVE_AFTER_OPTIONS, DEFAULT_ARCHIVE_AFTER
} = require('@hira-ng/shared-types/src/tabs-retention.mjs')
// 自动休眠 / 省电：键名 / 阈值档位 / 缺省值 —— 运行时定时器、域层默认值与设置页同源。
const {
  TAB_SLEEP_SETTING_KEYS, AUTO_SLEEP_THRESHOLD_OPTIONS, DEFAULT_AUTO_SLEEP_THRESHOLD_MS
} = require('@hira-ng/shared-types/src/tab-sleep.mjs')
// 历史保留期：键名 / 档位 / 缺省天数 —— 定期裁剪定时器、域层默认值与设置页同源。
const {
  HISTORY_RETENTION_SETTING_KEY, HISTORY_RETENTION_DAY_OPTIONS, DEFAULT_HISTORY_RETENTION_DAYS
} = require('@hira-ng/shared-types/src/history-retention.mjs')

// 选项中文名是**设置页专用文案**（各视图可自定），取值集合与顺序以 shared-types 为准。
const STARTUP_MODE_LABELS = { blank: '空白页', home: '主页', custom: '自定义网页', last_session: '恢复上次会话' }
const HOME_MODE_LABELS = { newtab: '快速拨号页', blank: '空白页', custom: '自定义地址' }
// 翻译目标语言表 / 设置键名与缺省值：与页面引擎、域层默认值共用同一份（C3 网页翻译）。
const {
  LANGUAGES, TRANSLATION_ENGINE_OPTIONS, TRANSLATE_SETTING_KEYS, DEFAULT_TRANSLATE_SETTINGS
} = require('@hira-ng/shared-types/src/translate.mjs')
// 拼写检查：键名 / 缺省值 —— 会话应用器、设置页字段与域层默认值同源，见 spellcheck.mjs。
const { SPELLCHECK_SETTING_KEYS, DEFAULT_SPELLCHECK_SETTINGS } =
  require('@hira-ng/shared-types/src/spellcheck.mjs')

/** 翻译字段的缺省值 —— 与域层默认值同源（translate.mjs 一份）。 */
function translateDefault(name: string): unknown {
  return DEFAULT_TRANSLATE_SETTINGS[TRANSLATE_SETTING_KEYS[name]]
}

/** 拼写检查字段的缺省值 —— 与域层默认值同源（spellcheck.mjs 一份）。 */
function spellcheckDefault(name: string): unknown {
  return DEFAULT_SPELLCHECK_SETTINGS[SPELLCHECK_SETTING_KEYS[name]]
}
// 默认浏览器动作的展示契约（按钮文案 / 回读间隔 / 提示语）——
// 与 OOBE 阶段 4 共用同一份，两个入口不许各写一套，见 associations.mjs。
const { DEFAULT_BROWSER_ACTION } = require('@hira-ng/shared-types/src/associations.mjs')
// 打包态 / 开发态唯一判据（见 app/runtime-mode.js）：
// 开发态一律不展示「默认浏览器」动作项 —— 那里的 exe 是 electron.exe，
// 任何关联动作都会污染系统。能力本身也已在 default-client.js 里整块关闭。
const { isDevRuntime } = require('../app/runtime-mode')
// 路由名取自 IPC 契约表（不在此手抄字符串）：动作型字段只是把路由转发给设置页。
const { IPC_ROUTES } = require('@hira-ng/shared-types/src/ipc-channels.mjs')
const { SETTINGS_ACTION_ROUTES } = require('./actions') as {
  SETTINGS_ACTION_ROUTES: {
    clearSearchHistory: string
    resetOnboarding: string
    setDefaultBrowser: string
    exportProfile: string
    importProfile: string
  }
}
// 设置「大类」的唯一真源（id / 中文标题 / 图标 / 导航顺序）——
// 设置页 rail、内部页外壳导航、插件分区共用同一张表，见 settings-groups.mjs。
const {
  SETTINGS_GROUP_ORDER,
  normalizeSettingsGroup,
  settingsGroupIcon,
  settingsGroupHref,
  settingsGroupLabel
} = require('@hira-ng/shared-types/src/settings-groups.mjs')
// 内部页身份表 / 统一地址拼法：设置页「内部页面」清单与侧栏、菜单同源，见 pages.mjs。
const { SETTINGS_INTERNAL_ENTRIES, pageLabel, pageUrl } = require('@hira-ng/shared-types/src/pages.mjs')
// 窗口 chrome 布局（模式 / 各栏位置 / 顺序表 / 窗口控制宿主）的真源，同上。
// 设置键名也来自它 —— 主进程与渲染层共用同一份 LAYOUT_SETTING_KEYS，杜绝手抄。
const {
  LAYOUT_MODE_OPTIONS,
  DEFAULT_LAYOUT_MODE,
  DEFAULT_TITLEBAR_ENABLED,
  WINDOW_CONTROLS_HOST_OPTIONS,
  DEFAULT_WINDOW_CONTROLS_HOST,
  WINDOW_CONTROLS_STYLE_OPTIONS,
  DEFAULT_WINDOW_CONTROLS_STYLE,
  ROW_POSITION_OPTIONS,
  DEFAULT_ROW_POSITION,
  CHROME_ROW_ORDER_OPTIONS,
  DEFAULT_CHROME_ROW_ORDER,
  CHROME_ROW_REGIONS,
  DEFAULT_SIDE_ROW_ORDER,
  LAYOUT_PRESET_OPTIONS,
  DEFAULT_LAYOUT_PRESET,
  SIDEBAR_VISIBILITY_OPTIONS,
  DEFAULT_SIDEBAR_VISIBILITY,
  SIDEBAR_POSITION_OPTIONS,
  DEFAULT_SIDEBAR_POSITION,
  RAIL_POSITION_OPTIONS,
  DEFAULT_RAIL_POSITION,
  RAIL_HORIZONTAL_ALIGN_OPTIONS,
  DEFAULT_RAIL_HORIZONTAL_ALIGN,
  RAIL_VERTICAL_ALIGN_OPTIONS,
  DEFAULT_RAIL_VERTICAL_ALIGN,
  RAIL_EXPAND_MODE_OPTIONS,
  DEFAULT_RAIL_EXPAND_MODE,
  DEFAULT_RAIL_PINNED,
  RAIL_WIDTH_MIN,
  RAIL_WIDTH_MAX,
  RAIL_WIDTH_DEFAULT,
  LAYOUT_SETTING_KEYS
} = require('@hira-ng/shared-types/src/layout.mjs')
// 独立侧栏（Web Sidebar）的位置偏好档位表：值集合 / 文案 / 缺省值同源。
const {
  WEB_SIDEBAR_POSITION_OPTIONS,
  DEFAULT_WEB_SIDEBAR_POSITION
} = require('@hira-ng/shared-types/src/web-sidebar.mjs')
// 分屏设置：键名 / 选项 / 默认值的真源（与上面布局那一组同一手法 —— 不在此手抄中文名）
const {
  SPLIT_SETTING_KEYS,
  SPLIT_MAX_PANES_OPTIONS,
  DEFAULT_SPLIT_MAX_PANES,
  SPLIT_LAYOUT_OPTIONS,
  DEFAULT_SPLIT_LAYOUT,
  SPLIT_LINK_ROUTING_OPTIONS,
  DEFAULT_SPLIT_LINK_ROUTING
} = require('@hira-ng/shared-types/src/split-layout.mjs')

/**
 * 设置页里的「跳到某个内部页」入口 —— 页面名与按钮文案都从 `pages.mjs` 取，
 * 不再在每条 entry 里手抄一遍「XX / 转到XX」。
 *
 * 只有**有意为之**的差异才传 `label` / `action`（例如「下载」页在这里叫「下载管理」），
 * 差异因此显式可见，而不是散落在各处各写一套。
 *
 * @param {string} host 内部页 host（`hira://<host>`）
 * @param {string} desc 一句话说明
 * @param {{ label?: string, action?: string, query?: Record<string, string> }} [opts]
 */
function pageEntry(
  host: string,
  desc: string,
  opts: { label?: string; action?: string; query?: Record<string, string> } = {}
): Record<string, string> {
  const label = opts.label || pageLabel(host)
  return {
    label,
    desc,
    action: opts.action || `转到${label}`,
    href: pageUrl(host, opts.query)
  }
}

/**
 * 侧栏大类的**导航顺序**来自共享真源 `settings-groups.mjs#SETTINGS_GROUP_ORDER`
 * （那里同时定义了每个大类的 id / 中文标题 / 图标）。
 *
 * 分区用 `group` 声明归组（只能是共享表里的 id），组内顺序 = 注册顺序；
 * 插件注册的分区若没声明 group，排在最后，不会插进内置分组中间。
 *
 * 分类口径照搬旧版 Hira 的「科学分类」词表，并按 NG 的实际分区做了收敛：
 *   外观 → 搜索引擎 → 启动与行为 → 隐私与安全 → 扩展与插件 → 工具 → 系统与数据 → 关于 Hira
 *
 * · Hira 的「基础」拆成三块：外观独立成类（用户要求，且它是进设置最常改的），
 *   搜索引擎、启动与行为各自成类；
 * · Hira 的「高级」收敛为「隐私与安全」，下辖隐私 / 网络与代理 / 密码与自动填充；
 * · Hira 的「AI 和扩展」即「扩展与插件」；「工具」沿用 Hira 的组名
 *   （下载 / 翻译 / 快捷键 / 自定义 Bangs → 工具）；
 * · 旧 Hira 没有的进程与数据类分区统一落「系统与数据」。
 *
 * ⚠ 改词表 / 加分类 = 改共享表，本文件与内部页导航都不再手抄中文组名。
 */

/**
 * 某一块可选的**区域**选项（按能力矩阵过滤）。
 *
 * 「侧栏」这一项不是每块都能选 —— 能力矩阵（CHROME_ROW_REGIONS）说了算，
 * 于是「某块不支持侧栏」时下拉里根本不会出现它，用户在设置页就摆不出畸形布局。
 * @param {'tabbar'|'navbar'|'titlebar'|'bookmarkbar'} row
 */
function positionOptionsFor(row: string): unknown[] {
  const allowed = CHROME_ROW_REGIONS[row] || []
  return (ROW_POSITION_OPTIONS as unknown[][]).filter((option) => allowed.indexOf(option[0]) >= 0)
}

/**
 * 创建一个注册中心实例。
 * @returns {{ registerSection:Function, getSchema:Function, getField:Function, _sections:Array }}
 */
export function createSettingsRegistry(): SettingsRegistry {
  const sections: SettingsSection[] = []

  function find(id: string): SettingsSection | null {
    for (const s of sections) if (s.id === id) return s
    return null
  }

  /**
   * 归一化「子分区」声明。
   *
   * 声明形状（纯 JSON，可跨 IPC）：
   *   subtabs: [{ id, label, keys: ['设置键', …] }]
   * 注册时把每个字段标上 `subtab`，之后页面只需按 `field.subtab` 过滤，
   * 不需要知道「哪个键属于哪个子分区」——分组知识全部留在本文件。
   * 未列出的字段落到第一个子分区（新增字段忘了声明也不会消失）。
   */
  function normalizeSubtabs(def: SettingsSectionDefinition): SettingsSubtabView[] {
    const list = (Array.isArray(def.subtabs) ? def.subtabs : [])
      .filter((subtab): subtab is Record<string, unknown> =>
        !!subtab && typeof subtab === 'object' && 'id' in subtab && !!subtab.id)
      .map((subtab) => ({
        id: String(subtab.id),
        label: String(subtab.label || subtab.id),
        keys: Array.isArray(subtab.keys) ? subtab.keys : []
      }))
    if (!list.length) return []
    const first = list[0].id
    def.fields.forEach((field) => {
      if (!field || field.subtab) return
      const hit = list.find((subtab) => subtab.keys.indexOf(String(field.key)) >= 0)
      field.subtab = hit ? hit.id : first
    })
    // 暴露给页面的只有 id / label（keys 是注册期用的，不必过桥）
    return list.map((subtab) => ({ id: subtab.id, label: subtab.label }))
  }

  /**
   * 注册（或向已有分区追加）一个设置分区。
   * @param {{id:string,label?:string,icon?:string,group?:string,blurb?:string,entry?:object,subtabs?:Array,fields:Array}} def
   */
  function registerSection(def: SettingsSectionDefinition): void {
    if (!def || !def.id || !Array.isArray(def.fields)) return
    // 大类只能是共享表里的 id（也容忍老写法直接写中文标题）。
    // 未知值**当场炸**：静默接受的话，分区会落到"其他"或者被悄悄排到最后，
    // 而那正是「这边加一条、那边加一条」的分类漂移。
    const group = def.group == null || def.group === '' ? '' : normalizeSettingsGroup(def.group)
    if (def.group != null && def.group !== '' && !group) {
      throw new Error(
        `[settings] 分区 ${def.id} 声明了未知的大类 group=${JSON.stringify(def.group)}；` +
          `合法值：${SETTINGS_GROUP_ORDER.join(' / ')}` +
          '（唯一真源：packages/shared-types/src/settings-groups.mjs）'
      )
    }
    const subtabs = normalizeSubtabs(def)
    const existing = find(def.id)
    if (existing) {
      // 往已有分区追加字段：若该分区已声明子分区，新字段必须落到某个子分区里，
      // 否则页面按 subtab 过滤时会把它整条丢掉（未声明归属 → 落到第一个子分区）。
      const firstTab = (subtabs[0] || (existing.subtabs && existing.subtabs[0]) || {}).id
      if (firstTab) {
        def.fields.forEach((field) => {
          if (field && !field.subtab) field.subtab = firstTab
        })
      }
      existing.fields = existing.fields.concat(def.fields)
      if (def.label) existing.label = def.label
      if (def.icon) existing.icon = def.icon
      if (group) existing.group = group
      if (def.blurb) existing.blurb = def.blurb
      if (def.entry) existing.entry = def.entry
      if (subtabs.length) existing.subtabs = subtabs
      return
    }
    sections.push({
      id: def.id,
      label: def.label || def.id,
      group,
      icon: def.icon || 'sliders',
      blurb: def.blurb || '',
      entry: def.entry || null,
      subtabs,
      fields: def.fields.slice()
    })
  }

  /**
   * 返回分区 schema（渲染器据此生成 UI）。返回深拷贝，避免渲染器改到注册表。
   *
   * 顺序 = **导航顺序**：按 `SETTINGS_GROUP_ORDER` 的组序稳定排序，同组内保持注册顺序。
   * 这样每个功能模块仍然只管注册自己的分区，不需要知道自己在侧栏里排第几；
   * 未声明 group 的（插件/Mod 动态注册）排在最后，不打断内置分区。
   * @returns {Array<{id:string,label:string,group:string,groupLabel:string,groupIcon:string,groupHref:string,icon:string,blurb:string,entry:object|null,subtabs:Array,fields:Array}>}
   */
  function cloneEntry(entry: unknown): unknown {
    if (!entry) return null
    if (Array.isArray(entry)) return entry.map((item) => Object.assign({}, item))
    return Object.assign({}, entry)
  }

  function getSchema(): SettingsSection[] {
    const rank = (group: string): number => {
      const i = SETTINGS_GROUP_ORDER.indexOf(group)
      return i < 0 ? SETTINGS_GROUP_ORDER.length : i
    }
    return sections
      .slice()
      .sort((a, b) => rank(a.group) - rank(b.group))
      .map((s) => ({
        id: s.id,
        label: s.label,
        group: s.group,
        // 大类的中文标题 / 图标也由主进程按共享表写入 ——
        // 设置页只负责画，不再自己维护一份「组名 → 图标」映射。
        groupLabel: s.group ? settingsGroupLabel(s.group) : '',
        groupIcon: s.group ? settingsGroupIcon(s.group) : '',
        // 「门」型大类（如 关于 Hira）：点导航项直接去这个内部页，而不是切内容区。
        groupHref: s.group ? settingsGroupHref(s.group) : '',
        icon: s.icon,
        blurb: s.blurb,
        // entry 可以是单个对象，也可以是数组（一个分区挂多个内部页入口）
        entry: cloneEntry(s.entry),
        subtabs: (s.subtabs || []).map((subtab) => Object.assign({}, subtab)),
        fields: s.fields.map((field) => Object.assign({}, field))
      }))
  }

  /** 按 key 取单个字段定义（供外部模块查默认值等）。 */
  function getField(key: string): SettingsField | null {
    for (const s of sections) {
      for (const field of s.fields) if (field.key === key) return field
    }
    return null
  }

  return { registerSection, getSchema, getField, _sections: sections }
}

/* ───────────────────────────────────────────────────────────────
 * 内置设置分区 —— 即「开箱即用的插件」。
 * 与 appliers/index.js 的 registerBuiltinAppliers 一一对应：
 * 改一项设置的展示 = 在这里加一个字段，不动设置页。
 * ─────────────────────────────────────────────────────────────── */
export function registerBuiltinSettingsSections(registry: SettingsRegistry): void {
  if (!registry || typeof registry.registerSection !== 'function') return
  // 开发态：exe 是 electron.exe，任何「设为默认 / 关联」入口都不能出现 ——
  // 不是「点击后静默失败」，而是**整个条目不存在**（设置页只是通用渲染器）。
  const showDefaultBrowser = !isDevRuntime()

  registry.registerSection({
    id: 'general',
    label: '常规',
    group: 'startup',
    icon: 'sliders',
    blurb: showDefaultBrowser ? '启动行为、主页与默认浏览器。' : '启动行为与主页。',
    fields: [
      {
        // 放在「常规」第一项**刻意为之**：这项决定「重启后、以及切回
        // 某个空间时，要不要把上次的标签复活」。它同时是用户最容易困惑的一项
        // （「我的标签去哪了 / 怎么冒出来一堆旧标签」都指向它），埋在中段会变成
        // 「找不到设置」。schema 驱动渲染，位置即在这里调整。
        key: STARTUP_SETTING_KEYS.mode, label: '启动时打开', type: 'select', effect: 'restart',
        desc: '选「恢复上次会话」时，切空间也会恢复该空间上次的标签。',
        options: STARTUP_MODES.map((value: string) => [value, STARTUP_MODE_LABELS[value as keyof typeof STARTUP_MODE_LABELS]]),
        default: DEFAULT_STARTUP_MODE
      },
      {
        // 「启动时打开 = 自定义网页」时才有意义 —— **跟着它自己的开关显示**。
        // 曾经这条挂在「高级」卡里常驻：与它依赖的「启动时打开」隔了一张卡，
        // 用户看不出它什么时候生效，还因为默认值与下面「自定义地址」相同而误以为是同一项。
        // 与「主页 / 新标签页」是**两件事**（Chrome 同）：启动页 ≠ 主页按钮 / 新标签页。
        key: STARTUP_SETTING_KEYS.customPage, label: '启动页地址', type: 'text', effect: 'restart',
        when: { key: STARTUP_SETTING_KEYS.mode, value: 'custom' },
        desc: '留空则跟随下面的「主页 / 新标签页」设置。',
        default: DEFAULT_HOME_URL
      },
      {
        key: STARTUP_SETTING_KEYS.homeMode, label: '主页 / 新标签页', type: 'select', effect: 'live',
        desc: '主页按钮与新建标签页打开什么。',
        options: HOME_MODES.map((value: string) => [value, HOME_MODE_LABELS[value as keyof typeof HOME_MODE_LABELS]]),
        default: DEFAULT_HOME_MODE
      },
      {
        key: STARTUP_SETTING_KEYS.homeUrl, label: '自定义地址', type: 'text', effect: 'live',
        when: { key: STARTUP_SETTING_KEYS.homeMode, value: 'custom' },
        desc: '选「自定义地址」时，主页按钮与新建标签页都打开这里。',
        default: DEFAULT_HOME_URL
      },
      // 「动作」型条目：没有持久值，点一下即调用主进程路由做一件事。
      // 之所以能直接挂在这里：设置页是注册中心的通用渲染器，它只认 field.action
      // 里的路由，不认识「默认浏览器」本身 —— 与其它字段一样是 schema 驱动的。
      // 开发态整条不出现（见上方 showDefaultBrowser）。
      ...(showDefaultBrowser
        ? [{
            key: 'app.default_browser', label: '默认浏览器', type: 'action', effect: 'live',
            // 点击做两件事：① 主进程静默接管 HTML 文档族与 http/https（给 UserChoice
            // 写合法 Hash，不必再点）；② 同时唤起系统设置页，作为看得见的确认入口。
            // 接管被组策略 / UCPD 拦住时，用户会在那里补一次确认。
            // 状态仍以主进程回读 UserChoice 为准，本进程收不到外部更改通知 —— 只能按 poll 回读。
            // 文案 / 间隔与 OOBE 阶段 4 共用 DEFAULT_BROWSER_ACTION，两处不许各写一套。
            action: {
              checkRoute: IPC_ROUTES.appIsDefaultBrowser,
              runRoute: SETTINGS_ACTION_ROUTES.setDefaultBrowser,
              ...DEFAULT_BROWSER_ACTION
            }
          }]
        : []),
      {
        // 重新运行 OOBE：没有 checkRoute → 设置页里恒为可点（见 pages/settings 的 action 语义）。
        // 只清「完成版本号」并开引导窗，不动任何用户数据 —— 与「重置应用」是两件事。
        //
        // 刻意**不**放进 `group: 'advanced'`：这是用户主动回来找的恢复入口，
        // 埋进「高级」卡就等于藏起来（导航大类叫「启动与行为」，「常规」只是这张卡的名字）。
        key: 'app.onboarding_reset', label: '重新运行首次启动引导', type: 'action', effect: 'live',
        desc: showDefaultBrowser
          ? '重新走一遍来源、外观、启动方式、布局与默认浏览器；不会清除书签、历史或已改过的设置。'
          : '重新走一遍来源、外观、启动方式与布局；不会清除书签、历史或已改过的设置。',
        action: { runRoute: SETTINGS_ACTION_ROUTES.resetOnboarding, runLabel: '重新运行' }
      }
    ]
  })

  registry.registerSection({
    id: 'appearance',
    label: '外观',
    group: 'appearance',
    icon: 'palette',
    blurb: '窗口布局与界面呈现方式。',
    // 子分区与按钮编辑面板的栏位归属保持一致，顺序也按面板栏位顺序排列。
    subtabs: [
      {
        id: 'templates', label: '模板',
        keys: [LAYOUT_SETTING_KEYS.preset]
      },
      {
        id: 'tabbar', label: '标签栏',
        keys: [
          LAYOUT_SETTING_KEYS.mode,
          LAYOUT_SETTING_KEYS.rowPosition.tabbar,
          LAYOUT_SETTING_KEYS.sideColumnVisibility,
          LAYOUT_SETTING_KEYS.sideColumnPosition,
          LAYOUT_SETTING_KEYS.sideColumnCollapsed
        ]
      },
      {
        id: 'navbar', label: '导航栏',
        keys: [LAYOUT_SETTING_KEYS.rowPosition.navbar]
      },
      {
        id: 'bookmarkbar', label: '书签栏',
        keys: [BOOKMARKBAR_SETTING_KEY, LAYOUT_SETTING_KEYS.rowPosition.bookmarkbar]
      },
      {
        id: 'titlebar', label: '标题栏',
        keys: [LAYOUT_SETTING_KEYS.titlebarEnabled, LAYOUT_SETTING_KEYS.rowPosition.titlebar]
      },
      {
        id: 'rail', label: '工具栏',
        keys: [
          LAYOUT_SETTING_KEYS.toolSidebarPosition,
          LAYOUT_SETTING_KEYS.toolRailHorizontalAlign,
          LAYOUT_SETTING_KEYS.toolRailVerticalAlign,
          LAYOUT_SETTING_KEYS.toolRailPinned,
          LAYOUT_SETTING_KEYS.toolRailExpandMode,
          LAYOUT_SETTING_KEYS.toolRailWidth
        ]
      },
      {
        id: 'order', label: '栏位顺序',
        keys: [LAYOUT_SETTING_KEYS.rowOrder, LAYOUT_SETTING_KEYS.sideOrder]
      },
      {
        id: 'controls', label: '控件',
        keys: [LAYOUT_SETTING_KEYS.windowControlsHost, LAYOUT_SETTING_KEYS.windowControlsStyle]
      },
      {
        id: 'interface', label: '界面',
        keys: [
          LAYOUT_SETTING_KEYS.immersiveMode,
          LAYOUT_SETTING_KEYS.webSidebarPosition,
          PAGE_INJECT_SETTING_KEYS.forceDark,
          PANELS_SETTING_KEYS.pinnedViewMode
        ]
      }
    ],
    // 按钮编辑是**窗口级模式**（铺满整窗的编辑浮层），既不是 hira:// 页也不是子窗口，
    // 所以走 entry 的 `route` 通道：设置页只发一条意图，开关真源仍是主进程
    // （buttons-edit:set-active），与 ⋮ 菜单「编辑按钮…」同一条通道，不新造第二条。
    entry: {
      label: '按钮编辑',
      desc: '调整导航栏与工具侧栏上按钮的顺序和显隐。',
      action: '打开编辑',
      route: 'buttons-edit:set-active',
      payload: { active: true }
    },
    fields: [
      {
        // 布局预设：**宏，不是真源**。真源是下面「每栏位置」那四项。
        // 选中它 = 一次性把那几项的区域写好（宏模板在 shared-types#LAYOUT_PRESETS）；
        // 之后仍可逐项微调，微调后本项会被自动改写成「自定义」（见
        // chrome-layout-controller#syncPresetLabel）—— 下拉永远不撒谎。
        key: LAYOUT_SETTING_KEYS.preset, label: '布局预设', type: 'select', effect: 'live',
        desc: '一键切换布局；选完之后仍可逐项微调。',
        options: LAYOUT_PRESET_OPTIONS,
        default: DEFAULT_LAYOUT_PRESET
      },
      {
        // 布局模式：两态取值真源在 @hira-ng/shared-types/src/layout.mjs
        // （设置页 options 与渲染层摆放共用同一份，不在此手抄中文名）。
        // tabbar / navbar 始终是两个独立 bar；紧凑模式不改变块边界。
        key: LAYOUT_SETTING_KEYS.mode, label: '布局', type: 'select', effect: 'live',
        desc: '标签栏与导航栏始终独立；紧凑模式只调整密度，不合并为同一视图。',
        options: LAYOUT_MODE_OPTIONS,
        default: DEFAULT_LAYOUT_MODE
      },
      {
        key: LAYOUT_SETTING_KEYS.immersiveMode, label: '沉浸模式', type: 'toggle', effect: 'live',
        desc: '界面自动隐藏，鼠标移到窗口边缘时浮现。',
        default: false
      },
      {
        key: LAYOUT_SETTING_KEYS.titlebarEnabled, label: '显示标题栏', type: 'toggle', effect: 'live',
        default: DEFAULT_TITLEBAR_ENABLED
      },
      {
        key: LAYOUT_SETTING_KEYS.rowPosition.tabbar, label: '标签栏位置', type: 'select', effect: 'live',
        desc: '选「侧栏」即进入垂直标签布局。',
        options: positionOptionsFor('tabbar'),
        default: DEFAULT_ROW_POSITION
      },
      {
        key: LAYOUT_SETTING_KEYS.rowPosition.navbar, label: '导航栏位置', type: 'select', effect: 'live',
        desc: '选「侧栏」时地址栏也搬进侧栏。',
        options: positionOptionsFor('navbar'),
        default: DEFAULT_ROW_POSITION
      },
      {
        key: LAYOUT_SETTING_KEYS.rowPosition.titlebar, label: '标题栏位置', type: 'select', effect: 'live',
        when: { key: LAYOUT_SETTING_KEYS.titlebarEnabled, value: true },
        options: positionOptionsFor('titlebar'),
        default: DEFAULT_ROW_POSITION
      },
      {
        // 三态 select（始终 / 仅新标签页 / 从不）：取值真源在
        // @hira-ng/shared-types/src/bookmarkbar.mjs —— 设置页的 options、
        // 菜单勾选、渲染层可见性判定共用同一份，不在此手抄中文名。
        // 保留旧键名（而非新开 app.bookmarkbar_mode）：老 profile 的布尔值由
        // normalizeBookmarkbarMode 无损迁移，用户不会丢设置。
        // 与「书签栏位置」相邻：一管「显不显示」，一管「显示在哪」，同属书签栏这一件事。
        key: BOOKMARKBAR_SETTING_KEY, label: '显示书签栏', type: 'select', effect: 'live',
        options: BOOKMARKBAR_MODE_OPTIONS,
        default: DEFAULT_BOOKMARKBAR_MODE
      },
      {
        key: LAYOUT_SETTING_KEYS.rowPosition.bookmarkbar, label: '书签栏位置', type: 'select', effect: 'live',
        options: positionOptionsFor('bookmarkbar'),
        default: DEFAULT_ROW_POSITION
      },
      {
        // 「顺序」型条目：值是栏目 id 数组；同侧的多栏按它在数组里的先后自上而下排列。
        // 用 ↑ / ↓ 微调而非拖拽 —— 不引入拖拽状态机，行为确定、可键盘操作。
        //
        // bucketOf / bucketLabels / disabledWhen 是给设置页的**纯 JSON** 分组依据
        // （设置页没有打包器，函数无法跨 IPC）：
        //   · bucketOf     ：每一项「属于哪一组」由哪个设置键的值决定（这里 = 该栏所在侧）；
        //   · bucketLabels ：组值 → 中文名（显示在每项右侧的小徽标上）；
        //   · disabledWhen ：某项当前不生效的条件（标题栏关闭时它不在任何一侧）。
        // 设置页只认这三张表，不认识「上/下」「栏」这些概念 —— 布局知识全部留在本文件。
        key: LAYOUT_SETTING_KEYS.rowOrder, label: '行区顺序', type: 'order', effect: 'live',
        desc: '同区多栏自上而下的顺序。',
        options: CHROME_ROW_ORDER_OPTIONS,
        bucketOf: {
          tabbar: LAYOUT_SETTING_KEYS.rowPosition.tabbar,
          navbar: LAYOUT_SETTING_KEYS.rowPosition.navbar,
          titlebar: LAYOUT_SETTING_KEYS.rowPosition.titlebar,
          bookmarkbar: LAYOUT_SETTING_KEYS.rowPosition.bookmarkbar
        },
        bucketLabels: { top: '顶部', bottom: '底部', side: '侧栏' },
        disabledWhen: {
          titlebar: { key: LAYOUT_SETTING_KEYS.titlebarEnabled, value: false },
          // 住在侧栏的栏不进这张表（侧栏内顺序见下一条）
          tabbar: { key: LAYOUT_SETTING_KEYS.rowPosition.tabbar, value: 'side' },
          navbar: { key: LAYOUT_SETTING_KEYS.rowPosition.navbar, value: 'side' },
          bookmarkbar: { key: LAYOUT_SETTING_KEYS.rowPosition.bookmarkbar, value: 'side' }
        },
        inactiveLabel: '未启用',
        default: DEFAULT_CHROME_ROW_ORDER
      },
      {
        // 侧栏内顺序：与行区顺序**同构**的一张表（同一套块、同一套分组徽标），
        // 只是排序结果作用在纵向侧栏里。两张表都是**纯 JSON 数据**，设置页不认识任何语义。
        key: LAYOUT_SETTING_KEYS.sideOrder, label: '侧栏内顺序', type: 'order', effect: 'live',
        options: CHROME_ROW_ORDER_OPTIONS,
        bucketOf: {
          tabbar: LAYOUT_SETTING_KEYS.rowPosition.tabbar,
          navbar: LAYOUT_SETTING_KEYS.rowPosition.navbar,
          titlebar: LAYOUT_SETTING_KEYS.rowPosition.titlebar,
          bookmarkbar: LAYOUT_SETTING_KEYS.rowPosition.bookmarkbar
        },
        bucketLabels: { side: '侧栏', top: '顶部', bottom: '底部' },
        // 不在侧栏里的栏在这张表里不参与（values 是「命中即停用」的取值列表）
        disabledWhen: {
          tabbar: { key: LAYOUT_SETTING_KEYS.rowPosition.tabbar, values: ['top', 'bottom'] },
          navbar: { key: LAYOUT_SETTING_KEYS.rowPosition.navbar, values: ['top', 'bottom'] },
          bookmarkbar: { key: LAYOUT_SETTING_KEYS.rowPosition.bookmarkbar, values: ['top', 'bottom'] },
          titlebar: { key: LAYOUT_SETTING_KEYS.rowPosition.titlebar, values: ['top', 'bottom'] }
        },
        inactiveLabel: '不在侧栏',
        default: DEFAULT_SIDE_ROW_ORDER
      },
      {
        key: LAYOUT_SETTING_KEYS.windowControlsHost, label: '窗口控制按钮位置', type: 'select', effect: 'live',
        desc: 'Edge 型侧栏（侧栏里只有标签列）下强制为「导航栏」；「标题栏」只在标题栏显示时才作数。',
        options: WINDOW_CONTROLS_HOST_OPTIONS,
        default: DEFAULT_WINDOW_CONTROLS_HOST
      },
      {
        // 两态：系统原生（强制）/ 应用自绘 —— 取值真源在 shared-types#WINDOW_CONTROLS_STYLE_OPTIONS。
        // effect 是 restart：Windows 上 WCO（Window Controls Overlay）只能在**建窗期**启用，
        // setTitleBarOverlay 只能换已启用 overlay 的样式，无运行时开关 —— 改动下次打开窗口生效。
        key: LAYOUT_SETTING_KEYS.windowControlsStyle, label: '窗口控制按钮样式', type: 'select', effect: 'restart',
        desc: '「系统原生」恒在窗口右上角；「应用自绘」按上一项摆放。下次打开窗口生效。',
        options: WINDOW_CONTROLS_STYLE_OPTIONS,
        default: DEFAULT_WINDOW_CONTROLS_STYLE
      },
      // ── 侧栏区（垂直标签栏所在的那一列）────────────────────────────────
      // 以下三项只在「有栏位于垂直标签侧栏」时有实际效果；没栏在侧栏时它们是无害的存档值。
      {
        key: LAYOUT_SETTING_KEYS.sideColumnVisibility, label: '垂直标签侧栏显示方式', type: 'select', effect: 'live',
        desc: '「悬停展开」= 静止时完全隐藏，指针贴窗口边缘才把同一块垂直标签侧栏展开（网页真让位，不是浮层）。',
        options: SIDEBAR_VISIBILITY_OPTIONS,
        default: DEFAULT_SIDEBAR_VISIBILITY
      },
      {
        // 纵向轨道上**两段各自独立的**位置键 —— 必须分开，不能共用一个：
        //   · app.sidebar_position   工具图标栏（rail）+ 侧边面板（下载 / 历史…）这一段；
        //   · app.side_column_position 垂直标签侧栏（标签列 / 地址栏那一列）这一段。
        // 两段相邻但独立，可以各靠一边（标签列靠右、工具图标栏靠左）。
        // 主进程按两段各自的侧分别算网页内缩与各视图 x（见 LayoutCoordinator）。
        key: LAYOUT_SETTING_KEYS.toolSidebarPosition, label: '工具侧栏位置', type: 'select', effect: 'live',
        desc: '左右 = 纵向图标栏；上下 = 横向图标栏。横向时由下面的「按钮起始边」决定它偏左还是偏右。',
        options: RAIL_POSITION_OPTIONS,
        default: DEFAULT_RAIL_POSITION
      },
      {
        // 横向 rail 的按钮起始边 —— 它同时也是「面板开在哪一侧」的判据：
        // 从右起 → rail 偏右 → 面板开右；从左起则开左。
        key: LAYOUT_SETTING_KEYS.toolRailHorizontalAlign, label: '横向图标栏按钮起始边', type: 'select', effect: 'live',
        desc: '仅当工具侧栏在顶部 / 底部时生效：从右起 = 图标栏偏右、面板在右打开。',
        options: RAIL_HORIZONTAL_ALIGN_OPTIONS,
        default: DEFAULT_RAIL_HORIZONTAL_ALIGN
      },
      {
        // 纵向 rail 的按钮起始边：默认从头（上）起；选「从下起」整组按钮贴底。
        key: LAYOUT_SETTING_KEYS.toolRailVerticalAlign, label: '纵向图标栏按钮起始边', type: 'select', effect: 'live',
        desc: '仅当工具侧栏靠左 / 靠右时生效：默认从顶部开始排列，也可改为从底部开始。',
        options: RAIL_VERTICAL_ALIGN_OPTIONS,
        default: DEFAULT_RAIL_VERTICAL_ALIGN
      },
      {
        key: LAYOUT_SETTING_KEYS.toolRailPinned, label: '固定工具图标栏', type: 'toggle', effect: 'live',
        desc: '开启时常驻占位；关闭后静止隐藏，指针贴窗口对应边缘才占位唤出。',
        default: DEFAULT_RAIL_PINNED
      },
      {
        key: LAYOUT_SETTING_KEYS.toolRailExpandMode, label: '图标栏起始状态', type: 'select', effect: 'live',
        desc: '自动：面板打开时收起，关闭后恢复打开前的状态。',
        options: RAIL_EXPAND_MODE_OPTIONS,
        default: DEFAULT_RAIL_EXPAND_MODE
      },
      {
        key: LAYOUT_SETTING_KEYS.toolRailWidth, label: '展开图标栏宽度', type: 'number', effect: 'live',
        unit: 'px', min: RAIL_WIDTH_MIN, max: RAIL_WIDTH_MAX, default: RAIL_WIDTH_DEFAULT
      },
      {
        // 侧栏区（垂直标签栏所在的那一列）的所在侧。与上一条（rail / 面板）分开设置。
        key: LAYOUT_SETTING_KEYS.sideColumnPosition, label: '垂直标签侧栏位置', type: 'select', effect: 'live',
        options: SIDEBAR_POSITION_OPTIONS,
        default: DEFAULT_SIDEBAR_POSITION
      },
      {
        key: LAYOUT_SETTING_KEYS.sideColumnCollapsed, label: '折叠垂直标签侧栏（仅图标）', type: 'toggle', effect: 'live',
        default: false
      },
      {
        // 纵向轨道上的**第三段**：独立侧栏（Web Sidebar）浏览网页的那一块。
        // 与工具区是"跟随"关系 —— 默认就落在工具区那一侧（从哪边点开就从哪边出来）。
        key: LAYOUT_SETTING_KEYS.webSidebarPosition, label: '网页侧栏位置', type: 'select', effect: 'live',
        desc: '「自动」= 跟随工具侧栏所在的一侧；想与它错开就选靠左/靠右，也可拖动侧栏顶条换边。',
        options: WEB_SIDEBAR_POSITION_OPTIONS,
        default: DEFAULT_WEB_SIDEBAR_POSITION
      },
      // ── 网页注入（J10：Boosts / 强制深色 / 用户脚本共用一条通道）──────────────
      // 站点级规则（自定义 CSS / JS / 本站深色覆盖）由「注入规则」面板管理，
      // 存 `webview.inject_rules`（不在此暴露原始 JSON —— 用户不该手写 JSON）。
      {
        key: PAGE_INJECT_SETTING_KEYS.forceDark, label: '强制深色', type: 'select', effect: 'live',
        desc: '站点没做深色时给它套一层智能反色。可在「注入规则」面板里按站点单独覆盖。',
        options: FORCE_DARK_OPTIONS,
        default: DEFAULT_FORCE_DARK
      },
      // ── 固定标签分段的视图形态（A4 / Pin Grid）────────────────────────────
      {
        key: PANELS_SETTING_KEYS.pinnedViewMode, label: '固定标签视图', type: 'select', effect: 'live',
        desc: '「标签」面板 →「已固定」分段的形态。网格把固定标签平铺成大卡片，便于扫视与批量打开（Pin Grid）。',
        options: PINNED_VIEW_MODE_OPTIONS,
        default: DEFAULT_PINNED_VIEW_MODE
      }
    ]
  })

  /**
   * 主题：设置页**只留入口**，不再放主题下拉。
   *
   * 主题是数据（内置 / 用户自建 / 插件各一套，还带编辑器与自动调度），塞进一张设置卡
   * 既放不下也画不好 —— 完整能力在内部页 `hira://themes` 里（学 Hira / Vivaldi 的
   * 「设置 > 主题」）。所以本分区**没有字段**，只有 entry：一个「转到主题页」按钮。
   *
   * 入口用 `href` 声明（与快捷键分区同款）：主题页是 hira:// 内部页、作为**活动标签**
   * 打开，用户能并排对照着改；子窗口做不到这件事，也就不再为它保留窗口类型。
   */
  registry.registerSection({
    id: 'theme',
    label: '主题',
    group: 'appearance',
    icon: 'palette',
    blurb: '主题库、编辑器与自动调度都在主题页里完成。',
    entry: {
      label: '主题',
      desc: '挑选内置 / 用户 / 插件主题，编辑配色与背景，按时间自动切换。',
      action: '转到主题页',
      href: pageUrl('themes')
    },
    fields: []
  })

  registry.registerSection({
    id: 'search',
    label: '搜索',
    group: 'search',
    icon: 'search',
    blurb: '地址栏的搜索行为、默认引擎与自定义快捷搜索。',
    subtabs: [
      { id: 'basic', label: '常规', keys: [
        SEARCH_SETTING_KEYS.defaultEngine, SEARCH_SETTING_KEYS.suggestionsEnabled,
        SEARCH_SETTING_KEYS.bangsEnabled, SEARCH_SETTING_KEYS.historyEnabled,
        SEARCH_SETTING_KEYS.clearHistory
      ] },
      { id: 'engines', label: '自定义引擎', keys: [SEARCH_SETTING_KEYS.customEngines] },
      { id: 'bangs', label: 'Bangs', keys: [SEARCH_SETTING_KEYS.customBangs] }
    ],
    fields: [
      {
        key: SEARCH_SETTING_KEYS.defaultEngine, label: '默认搜索引擎', type: 'select', effect: 'live',
        // 选项来自域层（内置引擎 + 用户自建引擎），**不再有写死的 custom1/2/3 槽位**：
        // 用户在下面「自定义搜索引擎」里新建一个，这个下拉立刻就能选到它。
        optionsRoute: 'search:engines',
        default: searchDefault('defaultEngine')
      },
      { key: SEARCH_SETTING_KEYS.suggestionsEnabled, label: '搜索建议', type: 'toggle', effect: 'live',
        desc: '地址栏输入时下拉显示历史、书签、已开标签与即时答案。', default: searchDefault('suggestionsEnabled') },
      { key: SEARCH_SETTING_KEYS.bangsEnabled, label: 'Bangs 快捷搜索', type: 'toggle', effect: 'live',
        desc: '支持 !g、!yt、!gh 等快捷跳转。自定义 Bang 同样可用：地址栏输入 !触发词 关键词 即可。',
        default: searchDefault('bangsEnabled') },
      { key: SEARCH_SETTING_KEYS.historyEnabled, label: '搜索建议包含历史', type: 'toggle', effect: 'live',
        default: searchDefault('historyEnabled') },

      // ── 自定义搜索引擎（用户数据：可自由新建 / 编辑 / 删除）────────────────
      // 引擎 = 「默认引擎下拉里的一个候选」，**不是 bang**：没有触发词、不进 `!` 列表。
      // 与 `search.custom_bangs` 彻底独立（各一张表、各一条 IPC 链路、各一套表单）。
      // 编辑完成 / 删除后通过 `refreshOptions` 让上面的下拉重新解析一次选项。
      {
        key: SEARCH_SETTING_KEYS.customEngines, label: '自定义搜索引擎', type: 'custom-engines',
        desc: '添加任意搜索引擎（如站内搜索），保存后会出现在上面的「默认搜索引擎」下拉里。支持 {query} 或 %s 占位符；不写占位符时查询词追加在末尾。',
        routes: {
          list: 'search:custom-engines',
          save: 'search:custom-engine-save',
          remove: 'search:custom-engine-remove',
          refreshOptions: 'search:engines'
        },
        toast: {
          saved: '已保存搜索引擎',
          removed: '已删除搜索引擎'
        },
        emptyText: '还没有自定义搜索引擎。比如添加「GitHub」→ https://github.com/search?q={query}',
        addLabel: '新增搜索引擎',
        itemSchema: {
          title: 'title',
          subtitle: 'url',
          usage: true,
          fields: [
            { key: 'title', label: '名称', required: true, requiredMessage: '名称不能为空', placeholder: 'GitHub' },
            {
              key: 'url', label: 'URL 模板', required: true, requiredMessage: 'URL 模板不能为空',
              placeholder: 'https://github.com/search?q={query}',
              hint: '必须 http(s) 开头；{query} / %s 会被替换成关键词。'
            }
          ]
        }
      },

      // ── 自定义 Bang（F-0761~F-0764 / F-0769 / F-1092~F-1093）────────────
      // 与内置 bang 表彻底分离：内置是代码事实，自定义是**用户数据**（SQLite，按 profile 分区）。
      // 与自定义引擎共用同一套动态列表渲染器（`itemSchema` 驱动），差别只在文案。
      {
        key: SEARCH_SETTING_KEYS.customBangs, label: '自定义 Bang', type: 'custom-bangs',
        desc: '用 !触发词 关键词 直达任意站点。与内置 Bang 分开保存，随 profile 隔离。',
        routes: {
          list: 'search:custom-bangs',
          save: 'search:custom-bang-save',
          remove: 'search:custom-bang-remove'
        },
        toast: { saved: '已保存 Bang', removed: '已删除 Bang' },
        emptyText: '还没有自定义 Bang。比如添加 !gh → https://github.com/search?q={query}',
        addLabel: '新增 Bang',
        itemSchema: {
          badge: 'trigger',
          title: 'title',
          subtitle: 'url',
          usage: true,
          tagWhen: 'showSuggestions',
          tagInvert: true,
          tagLabel: '仅回车直搜',
          fields: [
            { key: 'trigger', label: '触发词', required: true, requiredMessage: '触发词不能为空', placeholder: 'gh', prefix: '!' },
            { key: 'title', label: '名称', placeholder: 'GitHub' },
            {
              key: 'url', label: 'URL 模板', required: true, requiredMessage: 'URL 模板不能为空',
              placeholder: 'https://github.com/search?q={query}',
              hint: '必须 http(s) 开头；{query} / %s 会被替换成关键词。'
            }
          ],
          toggles: [
            { key: 'showSuggestions', label: '在建议中显示', hint: '关闭后这条只在「回车直搜」时生效，不占用下拉列表。' }
          ]
        }
      },

      // 搜索词历史（`search:record` 由地址栏与 NTP 搜索框共同写入）在这里给出清理入口。
      {
        key: SEARCH_SETTING_KEYS.clearHistory, label: '清除搜索历史', type: 'action', effect: 'live',
        desc: '清空已记录的搜索词（不影响浏览历史）。',
        action: { runRoute: SETTINGS_ACTION_ROUTES.clearSearchHistory, runLabel: '清除', doneLabel: '清除', resultHint: true }
      }
    ]
  })

  registry.registerSection({
    id: 'privacy',
    label: '隐私与安全',
    group: 'privacy',
    icon: 'shield',
    blurb: '控制向网站发送的数据。',
    subtabs: [
      { id: 'protect', label: '防护', keys: [
        PRIVACY_SETTING_KEYS.blockAds, PRIVACY_SETTING_KEYS.blockTrackers,
        PRIVACY_SETTING_KEYS.httpsOnly, PRIVACY_SETTING_KEYS.doNotTrack,
        FINGERPRINT_SETTING_KEY, PRIVACY_SETTING_KEYS.passwordSavePrompt,
        PRIVACY_SETTING_KEYS.formAutofill
      ] },
      { id: 'data', label: '数据与清理', keys: [
        HISTORY_RETENTION_SETTING_KEY, PRIVACY_SETTING_KEYS.clearHistoryOnExit,
        PRIVACY_SETTING_KEYS.clearDownloadsOnExit, PRIVACY_SETTING_KEYS.clearCacheOnExit,
        PRIVACY_SETTING_KEYS.clearCookiesOnExit, PRIVACY_SETTING_KEYS.clearSiteDataOnExit
      ] }
    ],
    // 隐私域的能力分散在三个内部页里（站点授权 / Cookie / 立即清理），
    // 设置页只保留开关，细粒度查看与逐项删除交给这些页 —— 用 entry 直达，不重复实现 UI。
    entry: [
      pageEntry('permissions', '按站点查看并撤销摄像头、麦克风、通知等授权。'),
      pageEntry('cookies', '查看各站点存储的 Cookie，逐站删除或全部清理。'),
      pageEntry('clear-data', '立即清除历史、缓存、Cookie、下载记录等。')
    ],
    fields: [
      { key: PRIVACY_SETTING_KEYS.blockAds, label: '拦截广告', type: 'toggle', effect: 'live',
        default: privacyDefault('blockAds'), desc: '使用广告过滤列表拦截广告请求。' },
      { key: PRIVACY_SETTING_KEYS.blockTrackers, label: '拦截追踪器', type: 'toggle', effect: 'live',
        default: privacyDefault('blockTrackers'),
        desc: '使用「广告 + 追踪」完整过滤列表；追踪列表包含广告列表，因此开启本项时「拦截广告」自然生效。' },
      // I2 仅 HTTPS：只升级**主框架导航**（地址栏 / 页内链接 / 服务器跳转），
      // 不升级页面里写死的 http 子资源 —— 那需要 webRequest，而它会顶掉广告拦截、
      // 并让扩展的 chrome.webRequest 全部失效（见 shared-types/https-only.mjs 的说明）。
      // 本地与私网地址（localhost / 192.168.* …）自动豁免，否则它们根本没有 https 服务。
      { key: PRIVACY_SETTING_KEYS.httpsOnly, label: '仅使用 HTTPS', type: 'toggle', effect: 'live',
        desc: '把 http 导航升级为 https；本地与内网地址不受影响。只作用于页面导航，不处理页内的 http 资源。',
        default: privacyDefault('httpsOnly') },
      { key: PRIVACY_SETTING_KEYS.doNotTrack, label: '发送“请勿跟踪”请求', type: 'toggle', effect: 'live',
        desc: 'DNT 已弃用，开启会拖慢页面加载。', default: privacyDefault('doNotTrack') },
      // 浏览器指纹伪装（按空间）：值为 null = 关闭；开启后是一个归一化的指纹对象。
      // 页面只按 record 的子字段 schema 画控件，生成/归一化/注入全在主进程与
      // shared-types/src/fingerprint.mjs —— 设置页不认识"指纹"这件事。
      {
        key: FINGERPRINT_SETTING_KEY,
        label: '浏览器指纹伪装',
        type: 'record',
        effect: 'live',
        desc: '每个空间一套指纹；改动对之后打开的页面立即生效，已打开的页面刷新后生效。',
        default: null,
        record: {
          summary: [
            { name: 'platform' },
            { name: 'hardwareConcurrency', suffix: ' 核' },
            { name: 'deviceMemory', suffix: ' GB' }
          ],
          fields: [
            { name: 'platform', label: '平台', type: 'select', options: FINGERPRINT_PLATFORM_OPTIONS },
            { name: 'hardwareConcurrency', label: 'CPU 核心数', type: 'number', min: 1, max: 128 },
            { name: 'deviceMemory', label: '内存 (GB)', type: 'number', min: 1, max: 128 },
            { name: 'webglVendor', label: 'WebGL 厂商', type: 'text' },
            { name: 'webglRenderer', label: 'WebGL 渲染器', type: 'text' },
            { name: 'languages', label: '语言', type: 'text', placeholder: 'zh-CN,zh' }
          ],
          generate: 'fingerprint',
          generateLabel: '随机生成',
          applyLabel: '应用',
          emptyText: '尚未生成指纹'
        }
      },
      { key: PRIVACY_SETTING_KEYS.passwordSavePrompt, label: '询问是否保存密码', type: 'toggle', effect: 'live',
        default: privacyDefault('passwordSavePrompt') },
      { key: PRIVACY_SETTING_KEYS.formAutofill, label: '表单自动填充', type: 'toggle', effect: 'live',
        default: privacyDefault('formAutofill') },
      { key: PRIVACY_SETTING_KEYS.clearHistoryOnExit, label: '退出时清除历史记录', type: 'toggle', effect: 'live',
        default: privacyDefault('clearHistoryOnExit') },
      {
        key: HISTORY_RETENTION_SETTING_KEY, label: '历史保留期', type: 'select', effect: 'live',
        desc: '超期记录（含逐次访问日志）在启动后与每 6 小时自动清理一次。',
        options: HISTORY_RETENTION_DAY_OPTIONS,
        default: String(DEFAULT_HISTORY_RETENTION_DAYS)
      },
      { key: PRIVACY_SETTING_KEYS.clearDownloadsOnExit, label: '退出时清除下载记录', type: 'toggle', effect: 'live',
        default: privacyDefault('clearDownloadsOnExit') },
      { key: PRIVACY_SETTING_KEYS.clearCacheOnExit, label: '退出时清除缓存', type: 'toggle', effect: 'live',
        default: privacyDefault('clearCacheOnExit') },
      { key: PRIVACY_SETTING_KEYS.clearCookiesOnExit, label: '退出时清除 Cookie', type: 'toggle', effect: 'live',
        default: privacyDefault('clearCookiesOnExit') },
      { key: PRIVACY_SETTING_KEYS.clearSiteDataOnExit, label: '退出时清除站点数据', type: 'toggle', effect: 'live',
        default: privacyDefault('clearSiteDataOnExit') }
    ]
  })

  registry.registerSection({
    id: 'network',
    label: '网络与代理',
    group: 'privacy',
    icon: 'globe',
    blurb: '代理、Secure DNS 与浏览器标识。改动立即作用到当前网络栈。',
    subtabs: [
      { id: 'proxy', label: '代理', keys: [
        PROXY_SETTING_KEYS.mode, PROXY_SETTING_KEYS.rules,
        PROXY_SETTING_KEYS.bypassRules, PROXY_SETTING_KEYS.pacUrl
      ] },
      { id: 'ua', label: '浏览器标识', keys: [
        USER_AGENT_SETTING_KEYS.preset, USER_AGENT_SETTING_KEYS.custom
      ] },
      { id: 'dns', label: 'Secure DNS', keys: [
        SECURE_DNS_SETTING_KEYS.mode,
        SECURE_DNS_SETTING_KEYS.provider,
        SECURE_DNS_SETTING_KEYS.custom
      ] }
    ],
    fields: [
      // ── 代理（I4）──────────────────────────────────────────────────
      // 四态对齐本仓库遗留项目 js/util/proxy.js 的模型（它是全仓唯一有代理实现的地方）。
      // 默认 `system` = 与"没做过任何设置"完全等价，不改变既有行为。
      {
        key: PROXY_SETTING_KEYS.mode, label: '代理模式', type: 'select', effect: 'live',
        desc: '「手动配置」与「自动配置脚本」的详细字段在选中后出现。',
        options: PROXY_MODE_OPTIONS,
        default: proxyDefault('mode')
      },
      {
        key: PROXY_SETTING_KEYS.rules, label: '代理规则', type: 'text', effect: 'live',
        desc: '形如 http=127.0.0.1:7890;https=127.0.0.1:7890；SOCKS 写 socks=socks5://127.0.0.1:1080。留空则直连。',
        when: { key: PROXY_SETTING_KEYS.mode, value: PROXY_MODE_VALUES.fixedServers },
        default: proxyDefault('rules')
      },
      {
        key: PROXY_SETTING_KEYS.bypassRules, label: '不走代理的地址', type: 'text', effect: 'live',
        desc: '分号分隔，支持 <local>（本机）与 *.example.com 这类通配。',
        when: { key: PROXY_SETTING_KEYS.mode, value: PROXY_MODE_VALUES.fixedServers },
        default: proxyDefault('bypassRules')
      },
      {
        key: PROXY_SETTING_KEYS.pacUrl, label: 'PAC 脚本地址', type: 'text', effect: 'live',
        desc: 'http(s):// 或 file:// 的 .pac 地址。留空则回退为「使用系统代理」。',
        when: { key: PROXY_SETTING_KEYS.mode, value: PROXY_MODE_VALUES.pacScript },
        default: proxyDefault('pacUrl')
      },
      // ── 浏览器标识（UA）────────────────────────────────────────────
      // 默认是"清洗后的标准 Chrome UA"（`user-agent.ts` 把 Electron/应用名 token 抹掉）。
      // 预设里的版本号是**运行时**替换成当前内核主版本的（见 shared-types/user-agent.mjs），
      // 所以不会出现"自称旧版 Chrome"这种随内核升级而来的过期。
      {
        key: USER_AGENT_SETTING_KEYS.preset, label: '浏览器标识', type: 'select', effect: 'live',
        desc: '部分站点只认特定浏览器。改动立即生效，无需重启。',
        options: UA_PRESET_OPTIONS,
        default: userAgentDefault('preset')
      },
      {
        key: USER_AGENT_SETTING_KEYS.custom, label: '自定义 User-Agent', type: 'text', effect: 'live',
        desc: '整串 UA。留空则回退为「默认」。',
        when: { key: USER_AGENT_SETTING_KEYS.preset, value: UA_CUSTOM_PRESET_ID },
        default: userAgentDefault('custom')
      },
      // ── Secure DNS / DoH ────────────────────────────────────────────
      {
        key: SECURE_DNS_SETTING_KEYS.mode, label: '安全 DNS 模式', type: 'select', effect: 'live',
        desc: 'DoH 加密域名解析，但不等同于 VPN，也不会隐藏最终访问的网站。',
        options: SECURE_DNS_MODE_OPTIONS,
        default: secureDnsDefault('mode')
      },
      {
        key: SECURE_DNS_SETTING_KEYS.provider, label: 'DNS 服务商', type: 'select', effect: 'live',
        desc: '「仅安全 DNS」建议搭配明确服务商；跟随系统时由操作系统策略决定。',
        options: SECURE_DNS_PROVIDER_OPTIONS,
        default: secureDnsDefault('provider')
      },
      {
        key: SECURE_DNS_SETTING_KEYS.custom, label: '自定义 DoH 地址', type: 'text', effect: 'live',
        desc: '最多 4 个 HTTPS 模板地址，用换行、空格或分号分隔。',
        when: { key: SECURE_DNS_SETTING_KEYS.provider, value: 'custom' },
        default: secureDnsDefault('custom')
      }
    ]
  })

  registry.registerSection({
    id: 'tabs',
    label: '标签页',
    group: 'startup',
    icon: 'tabs',
    blurb: '标签休眠策略，影响内存占用。',
    subtabs: [
      { id: 'behavior', label: '行为', keys: [
        TABS_SETTING_KEYS.openAfterCurrent, TABS_SETTING_KEYS.reuseExistingTab,
        TABS_SETTING_KEYS.confirmCloseMultiple, TABS_SETTING_KEYS.autoPictureInPicture,
        TABS_SETTING_KEYS.syncAcrossWindows
      ] },
      { id: 'memory', label: '休眠与省电', keys: [
        TAB_SLEEP_SETTING_KEYS.autoSleep, TAB_SLEEP_SETTING_KEYS.thresholdMs,
        TAB_SLEEP_SETTING_KEYS.excludePinned, TAB_SLEEP_SETTING_KEYS.energySaver,
        TABS_RETENTION_SETTING_KEYS.archiveAfter
      ] },
      { id: 'split', label: '分屏', keys: [
        SPLIT_SETTING_KEYS.defaultLayout, SPLIT_SETTING_KEYS.maxPanes, SPLIT_SETTING_KEYS.linkRouting
      ] },
      { id: 'advanced', label: '高级', keys: [TABS_SETTING_KEYS.restoreSession] }
    ],
    fields: [
      { key: TAB_SLEEP_SETTING_KEYS.autoSleep, label: '自动休眠非活动标签', type: 'toggle', effect: 'live', default: true },
      {
        key: TAB_SLEEP_SETTING_KEYS.thresholdMs, label: '休眠阈值', type: 'select', effect: 'live',
        options: AUTO_SLEEP_THRESHOLD_OPTIONS,
        // 默认 5 分钟（原为 10 分钟）：一个醒着的标签就是一份完整的 renderer
        // （实测 ~104MB 工作集 / ~25MB 独占），切回闲置标签的代价只是一次重新加载，
        // 因此默认值取更省内存的那一档；想少重载的用户可以自己调长。
        default: String(DEFAULT_AUTO_SLEEP_THRESHOLD_MS)
      },
      { key: TAB_SLEEP_SETTING_KEYS.excludePinned, label: '排除固定标签', type: 'toggle', effect: 'live',
        desc: '已固定的标签不参与自动休眠。', default: true },
      { key: TAB_SLEEP_SETTING_KEYS.energySaver, label: '省电模式', type: 'toggle', effect: 'live',
        desc: '强制后台标签降频（覆盖上面的「后台标签降低 CPU 占用」），并把非活动休眠阈值收紧到 1 分钟。适合笔记本续航场景。', default: false },
      {
        key: TABS_RETENTION_SETTING_KEYS.archiveAfter, label: '自动归档长期未用的标签页', type: 'select', effect: 'live',
        desc: '归档会关闭标签且不进撤销栈；固定标签与正在播放的标签永不归档。',
        options: ARCHIVE_AFTER_OPTIONS,
        default: DEFAULT_ARCHIVE_AFTER
      },
      { key: TABS_SETTING_KEYS.openAfterCurrent, label: '新标签紧跟当前标签', type: 'toggle', effect: 'live',
        default: tabsDefault('openAfterCurrent') },
      { key: TABS_SETTING_KEYS.reuseExistingTab, label: '重复网址直接跳转到已打开的标签页', type: 'toggle', effect: 'live',
        desc: '在新标签页打开一个已在当前空间打开的网址时，切到那个标签页而不是重复打开（跨空间不生效）。',
        default: tabsDefault('reuseExistingTab') },
      { key: TABS_SETTING_KEYS.confirmCloseMultiple, label: '关闭多个标签前确认', type: 'toggle', effect: 'live',
        default: tabsDefault('confirmCloseMultiple') },
      { key: TABS_SETTING_KEYS.autoPictureInPicture, label: '切走标签时自动画中画', type: 'toggle', effect: 'live',
        desc: '切走正在播放视频的标签时弹出系统画中画小窗。', default: tabsDefault('autoPictureInPicture') },
      // ── 跨窗口标签同步（J15 / A5）──────────────────────────────────────
      // 默认关：它会把"用户正在看的那个标签"在窗口之间搬来搬去，是**强行为**，
      // 与 RT tab-sync 同口径（必须显式开启）。开关是 live 的 —— 关闭时立刻清掉占位
      // 并复位记账（见 main.js 的 syncTabFocus 分支），不留"半同步"状态。
      { key: TABS_SETTING_KEYS.syncAcrossWindows, label: '跨窗口标签同步', type: 'toggle', effect: 'live',
        desc: '多个窗口共享同一份标签集合：切到哪个窗口，当前标签的真实视图就迁移过去，原窗口留下截图占位。无痕标签不参与。',
        default: tabsDefault('syncAcrossWindows') },
      { key: TABS_SETTING_KEYS.restoreSession, label: '启动时恢复上次会话', type: 'toggle', effect: 'restart',
        desc: '与「启动时打开」联动，二者不会矛盾。', default: tabsDefault('restoreSession') },
      // ── 分屏（Split View）──────────────────────────────────────────────
      // 这两项**只影响之后新建 / 加入的分屏**：已经建好的组保持原样（否则改一次设置
      // 会把用户正看着的分屏当场重排，那是"设置项动了我没碰的东西"）。
      { key: SPLIT_SETTING_KEYS.defaultLayout, label: '分屏默认方向', type: 'select', effect: 'live',
        desc: '新建分屏的并排方向，之后可在标签右键菜单更换。',
        options: SPLIT_LAYOUT_OPTIONS, default: DEFAULT_SPLIT_LAYOUT },
      { key: SPLIT_SETTING_KEYS.maxPanes, label: '分屏最多格数', type: 'select', effect: 'live',
        desc: '一个分屏组最多显示的网页数（上限 4）。',
        options: SPLIT_MAX_PANES_OPTIONS, default: String(DEFAULT_SPLIT_MAX_PANES) },
      { key: SPLIT_SETTING_KEYS.linkRouting, label: '分屏里点开的链接', type: 'select', effect: 'live',
        desc: '分屏里 target=_blank / window.open 链接的去向。',
        options: SPLIT_LINK_ROUTING_OPTIONS, default: DEFAULT_SPLIT_LINK_ROUTING },
    ]
  })

  registry.registerSection({
    id: 'downloads',
    label: '下载',
    group: 'tools',
    icon: 'download',
    blurb: '下载位置、通知与限速。',
    entry: pageEntry('downloads', '查看进行中与已完成的下载，右键可打开所在文件夹或复制链接。', {
      label: '下载管理'
    }),
    fields: [
      { key: DOWNLOAD_SETTING_KEYS.askWhereToSave, label: '每次询问保存位置', type: 'toggle', effect: 'live',
        default: downloadDefault('askWhereToSave') },
      { key: DOWNLOAD_SETTING_KEYS.defaultLocation, label: '默认下载目录', type: 'directory', effect: 'live',
        desc: '留空使用系统下载目录。', default: downloadDefault('defaultLocation') },
      { key: DOWNLOAD_SETTING_KEYS.showNotification, label: '下载完成通知', type: 'toggle', effect: 'live',
        default: downloadDefault('showNotification') },
      { key: DOWNLOAD_SETTING_KEYS.openWhenDone, label: '下载完成后打开', type: 'toggle', effect: 'live',
        default: downloadDefault('openWhenDone') },
      {
        key: DOWNLOAD_SETTING_KEYS.safeBrowsing, label: '危险文件策略', type: 'select', effect: 'live',
        options: SAFE_BROWSING_OPTIONS,
        default: DEFAULT_SAFE_BROWSING
      },
      { key: DOWNLOAD_SETTING_KEYS.clearOnComplete, label: '完成后从列表移除记录', type: 'toggle', effect: 'live',
        desc: '不删除已下载的文件。', default: downloadDefault('clearOnComplete') },
      { key: DOWNLOAD_SETTING_KEYS.rateLimit, label: '下载限速', type: 'number', effect: 'live',
        desc: '0 表示不限速。', unit: 'KB/s', scale: 1024, min: 0, default: downloadDefault('rateLimit') },
      { key: DOWNLOAD_SETTING_KEYS.multiThreaded, label: '多线程下载', type: 'toggle', effect: 'live', group: 'advanced',
        desc: '支持 Range 的直链自动分片下载；小文件回退单线程。', default: downloadDefault('multiThreaded') },
      { key: DOWNLOAD_SETTING_KEYS.maxConnections, label: '最大并发连接数', type: 'number', effect: 'live', group: 'advanced',
        desc: `${DOWNLOAD_CONNECTION_LIMITS.min}–${DOWNLOAD_CONNECTION_LIMITS.max}，超出会被夹取。`,
        min: DOWNLOAD_CONNECTION_LIMITS.min, default: downloadDefault('maxConnections') }
    ]
  })

  registry.registerSection({
    id: 'extensions',
    label: '扩展与插件',
    group: 'extensions',
    icon: 'puzzle',
    blurb: '扩展的加载、调试与更新策略。',
    // 安装 / 卸载 / 权限这些「增删改」不在设置页重复造一遍 —— 设置页只声明去哪找。
    entry: [
      pageEntry('extensions', '安装 / 卸载 / 启用扩展，查看权限与运行时诊断。', { label: '扩展管理' }),
      pageEntry('apps', '管理已安装的网页应用（PWA）及其快捷方式。', { label: '应用管理' })
    ],
    fields: [
      { key: EXTENSIONS_SETTING_KEYS.developerMode, label: '开发者模式', type: 'toggle', effect: 'live',
        desc: '详情里额外显示运行时诊断与「重新加载」按钮。', default: extensionsDefault('developerMode') },
      { key: EXTENSIONS_SETTING_KEYS.allowUnpacked, label: '允许加载未打包扩展', type: 'toggle', effect: 'restart',
        desc: '切换 profile 或重启后生效。', default: extensionsDefault('allowUnpacked') },
      { key: EXTENSIONS_SETTING_KEYS.autoUpdate, label: '扩展自动更新', type: 'toggle', effect: 'restart',
        default: extensionsDefault('autoUpdate') }
    ]
  })

  registry.registerSection({
    id: 'performance',
    label: '性能',
    group: 'system',
    icon: 'gauge',
    blurb: '渲染加速与内存 / CPU 策略。',
    entry: pageEntry('task-manager', '查看每个标签 / 扩展 / 子进程的 CPU 与内存占用，可结束进程。'),
    fields: [
      { key: PERFORMANCE_SETTING_KEYS.hardwareAcceleration, label: '硬件加速', type: 'toggle', effect: 'restart',
        desc: '关闭可解决部分机型花屏 / 卡顿；需重启生效。', default: performanceDefault('hardwareAcceleration') },
      { key: PERFORMANCE_SETTING_KEYS.memorySaver, label: '内存释放', type: 'toggle', effect: 'live',
        default: performanceDefault('memorySaver') },
      { key: PERFORMANCE_SETTING_KEYS.cpuThrottleBackground, label: '后台标签降低 CPU 占用', type: 'toggle', effect: 'live',
        default: performanceDefault('cpuThrottleBackground') },
      { key: PERFORMANCE_SETTING_KEYS.smoothScrolling, label: '平滑滚动', type: 'toggle', effect: 'restart',
        default: performanceDefault('smoothScrolling') }
    ]
  })

  registry.registerSection({
    id: 'accessibility',
    label: '无障碍',
    group: 'appearance',
    icon: 'accessibility',
    blurb: '字号、对比度与辅助浏览偏好。',
    fields: [
      { key: ACCESSIBILITY_SETTING_KEYS.captions, label: '字幕', type: 'toggle', effect: 'live',
        desc: '依赖系统字幕设置。', default: false },
      { key: ACCESSIBILITY_SETTING_KEYS.highContrast, label: '强制高对比度', type: 'toggle', effect: 'live', default: false },
      { key: ACCESSIBILITY_SETTING_KEYS.caretBrowsing, label: '光标浏览', type: 'toggle', effect: 'live', default: false },
      { key: ACCESSIBILITY_SETTING_KEYS.fontSize, label: '网页默认字号', type: 'select', effect: 'live',
        desc: '对**新打开的标签**生效，非页面缩放。',
        options: FONT_SIZE_OPTIONS, default: DEFAULT_FONT_SIZE }
    ]
  })

  registry.registerSection({
    id: 'languages',
    label: '翻译与语言',
    group: 'tools',
    icon: 'globe',
    blurb: '网页翻译与拼写检查偏好。插件引擎优先，在线通道自动故障切换。',
    subtabs: [
      { id: 'translate', label: '翻译', keys: [
        TRANSLATE_SETTING_KEYS.translatePages,
        TRANSLATE_SETTING_KEYS.targetLanguage,
        TRANSLATE_SETTING_KEYS.engine
      ] },
      { id: 'spellcheck', label: '拼写检查', keys: [
        SPELLCHECK_SETTING_KEYS.enabled, SPELLCHECK_SETTING_KEYS.languages, SPELLCHECK_SETTING_KEYS.dictionary
      ] }
    ],
    fields: [
      { key: TRANSLATE_SETTING_KEYS.translatePages, label: '网页翻译', type: 'toggle', effect: 'live',
        default: translateDefault('translatePages'),
        desc: '关闭后不再发起网页翻译；重新打开即可继续使用。' },
      { key: TRANSLATE_SETTING_KEYS.targetLanguage, label: '翻译目标语言', type: 'select', effect: 'live',
        options: LANGUAGES.map((language: { id: string; label: string }) => [language.id, language.label]),
        default: translateDefault('targetLanguage') },
      { key: TRANSLATE_SETTING_KEYS.engine, label: '在线翻译通道', type: 'select', effect: 'live',
        desc: '自动模式先走 Bing 中国直连，再切 Google / Microsoft。插件 translate.provider 始终优先。',
        options: TRANSLATION_ENGINE_OPTIONS,
        default: translateDefault('engine') },
      // ── 拼写检查（与翻译同属「语言」能力，故并入本分区而不是另起一页）──────
      { key: SPELLCHECK_SETTING_KEYS.enabled, label: '拼写检查', type: 'toggle', effect: 'live',
        desc: '在输入框里标出拼写错误，右键可替换或加入词典。',
        default: spellcheckDefault('enabled') },
      { key: SPELLCHECK_SETTING_KEYS.languages, label: '拼写检查语言', type: 'multi-select', effect: 'live',
        desc: '勾选用于检查的词典语言；不选则跟随系统语言。',
        // 可用词典随 Electron 构建/平台变化 → 选项由主进程现取（见 settings/ipc.js）。
        optionsRoute: 'spellcheck:languages', default: spellcheckDefault('languages') },
      { key: SPELLCHECK_SETTING_KEYS.dictionary, label: '自定义词典', type: 'list', effect: 'live',
        desc: '右键「添加到词典」加入的词；移除后重新参与拼写检查。',
        list: {
          route: 'spellcheck:dictionary',
          removeRoute: 'spellcheck:dictionary-remove',
          primary: 'word',
          removeLabel: '移除',
          emptyText: '还没有自定义词。'
        } }
    ]
  })

  registry.registerSection({
    id: 'pdf',
    label: 'PDF 文档',
    group: 'tools',
    icon: 'file',
    blurb: '内置 PDF 阅读器的开关与初始缩放。',
    fields: [
      { key: PDF_SETTING_KEYS.viewerEnabled, label: '使用内置 PDF 阅读器', type: 'toggle', effect: 'live',
        desc: '关闭后 .pdf 改用系统方式打开。', default: true },
      { key: PDF_SETTING_KEYS.defaultZoom, label: 'PDF 默认缩放', type: 'select', effect: 'live',
        options: PDF_ZOOM_OPTIONS,
        default: DEFAULT_PDF_ZOOM }
    ]
  })

  registry.registerSection({
    id: 'autofill',
    label: '密码与自动填充',
    group: 'privacy',
    icon: 'file',
    blurb: '本地加密保存的收货地址与支付卡（明文不出主进程）。',
    entry: pageEntry('formfill', '新增 / 查看 / 删除；列表只显示掩码，明文需显式显示。'),
    fields: []
  })

  registry.registerSection({
    id: 'sessions',
    label: '会话',
    group: 'system',
    icon: 'tabs',
    blurb: '把当前标签集存成命名会话，之后随时一键恢复。',
    entry: pageEntry('sessions', '保存 / 恢复 / 删除命名会话（恢复是追加打开，不动你此刻的标签）。'),
    fields: []
  })

  registry.registerSection({
    id: 'spaces',
    label: '工作空间',
    group: 'system',
    icon: 'layers',
    blurb: '每个空间拥有独立的标签与会话数据。',
    entry: pageEntry('spaces', '新建、重命名、配色与拖拽排序。', { label: '空间管理' }),
    fields: []
  })

  // 自动化（D2 命令链 + D3 鼠标手势）：两者共用一页管理 —— 都是"把既有命令重新编排成
  // 一个入口"，分两页只会把同一套编辑器抄两遍（见 packages/shared-types/automation.mjs）。
  registry.registerSection({
    id: 'automation',
    label: '自动化',
    group: 'tools',
    icon: 'automation',
    blurb: '把多个命令串成一条链，或用按住右键画方向来触发命令。',
    entry: pageEntry('automation', '编辑命令链、把方向手势映射到命令；做好的链也能在地址栏里直接搜到。', {
      label: '命令链与鼠标手势'
    }),
    fields: [
      {
        key: 'automation.gestures_enabled',
        label: '启用鼠标手势',
        type: 'toggle',
        effect: 'live',
        desc: '按住鼠标右键在网页上画方向（← 后退 / → 前进 / ↑ 新标签 / ↓ 关标签…）触发命令。',
        default: true
      }
    ]
  })

  // 快捷键：设置页只负责「去哪改」，不认识键位表本身。
  // 键位目录 / 分组 / 名称 / 默认值的唯一真源是 shared-types#keybindings.mjs，
  // 页面是 hira://shortcuts —— 这里若再抄一份按键清单，立刻就是两套会漂移的真源。
  registry.registerSection({
    id: 'shortcuts',
    label: '快捷键',
    group: 'tools',
    icon: 'keyboard',
    blurb: '查看全部内置快捷键，也可以自己重新录制组合键。',
    entry: {
      label: '键盘快捷键',
      desc: '按分类浏览、搜索动作、录制新组合键；逐项或全部恢复默认。改动保存后立即生效。',
      action: '打开快捷键页',
      href: pageUrl('shortcuts')
    },
    fields: []
  })

  registry.registerSection({
    id: 'input',
    label: '输入',
    group: 'tools',
    icon: 'sliders',
    blurb: '键盘在网页上的导航方式。',
    fields: [
      {
        /**
         * 空间导航（N9）：**默认关**，且必须显式开启。
         *
         * 为什么默认关：开启后方向键会从"滚动页面"变成"在可点击元素间跳焦点"——
         * 这会改变所有人的方向键直觉，只能由想要它的人自己打开。
         * 开启后仍保留退路：焦点在输入框里、或按了任何修饰键时，方向键照旧交还页面。
         */
        key: 'input.spatial_navigation',
        label: '空间导航',
        type: 'toggle',
        effect: 'live',
        desc: '用方向键在网页的可点击元素之间按位置跳转（↑↓←→），而不是一个个按 Tab。焦点在输入框里时不受影响。',
        default: false
      }
    ]
  })

  registry.registerSection({
    id: 'break',
    label: '专注',
    group: 'tools',
    icon: 'gauge',
    blurb: '番茄钟 / 专注模式：整窗倒计时，结束后转入休息。',
    fields: [
      {
        key: 'break.focus_minutes',
        label: '专注时长（分钟）',
        type: 'number',
        effect: 'live',
        desc: '按 Ctrl+Alt+B 进入专注；本段走完自动转入休息段。',
        default: 25
      },
      {
        key: 'break.break_minutes',
        label: '休息时长（分钟）',
        type: 'number',
        effect: 'live',
        default: 5
      },
      {
        key: 'break.message',
        label: '专注时的说明文字',
        type: 'text',
        effect: 'live',
        desc: '留空则不显示。',
        default: ''
      }
    ]
  })

  registry.registerSection({
    id: 'externalApps',
    label: '外部应用',
    group: 'extensions',
    icon: 'globe',
    blurb: '网站被允许打开的外部协议。',
    fields: [
      {
        // 「列表」型条目：内容不定长、来自主进程路由（此处为已授权的外部协议），逐项可撤销。
        // 页面依旧只认 field.list 里的路由与字段名，不认识「外部协议」这件事本身。
        key: 'app.external_apps', label: '已允许的外部协议', type: 'list', effect: 'live',
        desc: '选择「始终允许」的授权会出现在这里。',
        list: {
          route: 'open-external:list',
          removeRoute: 'open-external:unset',
          // 列表项里哪两个字段分别作为主标题 / 副标题；撤销时整项作为请求载荷回传
          primary: 'requestingURL',
          secondary: 'openingProtocol',
          emptyText: '暂无已授权的外部应用。'
        }
      }
    ]
  })

  registry.registerSection({
    id: 'backup',
    label: '备份与迁移',
    group: 'system',
    icon: 'file',
    blurb: '把当前配置档案整体导出成一个文件，或从文件导入一份新档案。',
    fields: [
      {
        // 「动作」型（与「默认浏览器」同一种字段）：没有常驻值，点一下调 runRoute。
        // 归档格式 / 表白名单 / 校验在 shared-types#profile-archive.mjs 与 main/profile-archive.js，
        // 设置页只认 action 里的路由，不认识「配置档案」这件事本身。
        key: 'app.export_profile', label: '导出当前配置档案', type: 'action', effect: 'live',
        desc: '把书签、历史、下载记录、笔记、2FA、站点权限、设置与各空间会话打包成一个文件。不含扩展；密码条目为加密态，只能在本机原样解出。',
        action: {
          runRoute: SETTINGS_ACTION_ROUTES.exportProfile,
          runLabel: '导出…',
          doneLabel: '导出…',
          // resultHint：runRoute 返回 { ok, message, error } —— 设置页把它渲染成一行结果提示。
          // 导出/导入是"看得见结果"的动作，没有它用户不知道去了哪 / 为什么没成。
          resultHint: true
        }
      },
      {
        key: 'app.import_profile', label: '导入配置档案', type: 'action', effect: 'live',
        desc: '导入**只会新建**一个配置档案，不会覆盖或改动现有档案。',
        action: {
          runRoute: SETTINGS_ACTION_ROUTES.importProfile,
          runLabel: '导入…',
          doneLabel: '导入…',
          resultHint: true
        }
      }
    ]
  })

  /**
   * 「关于 Hira」大类 —— 与导航同一侧的最后一个大类。
   *
   * 为什么需要一个**独立大类**，而不是继续挂在「系统与数据」里：
   *   · 「关于」是每个浏览器都有的收尾入口，用户找它时的直觉是"在最后"；
   *   · 它下面并列两个**面**：关于（版本 / 运行时 / 数据目录）与软件更新
   *     （状态 / 通道 / 自动检查 / 立即检查）—— 与 hira://about 页的两个选项卡一一对应。
   *
   * ⚠ 本大类**只做跳转**，不在设置页里再长一份更新界面：
   *   更新是一条带状态机的流程（检查中 / 下载进度 / 重启安装），塞进设置的表单行里
   *   会变成"第二套更新 UI"，状态还得跟真正的更新页对齐。唯一的界面在更新页，
   *   设置页只负责把用户送过去（entry.href），两处因此不会出现口径分叉。
   */
  registry.registerSection({
    id: 'about-hira',
    label: '关于 Hira',
    group: 'about',
    icon: 'info',
    blurb: '版本、运行时与更新，都在同一页里。',
    entry: pageEntry('about', '版本号、Electron / Chromium 运行时、用户数据目录与默认 User-Agent。', {
      action: '打开关于页'
    }),
    fields: []
  })

  registry.registerSection({
    id: 'updates',
    label: '软件更新',
    group: 'about',
    icon: 'download',
    blurb: '更新状态、发布通道与自动检查，都在更新页里。',
    // 只有 entry、没有 fields：本分区是**一扇门**，不是表单。
    // 通道 / 自动检查 / 检查周期这些开关也由更新页自己管（那里能就地看到切换后的结果）。
    entry: pageEntry('about', '查看更新状态与下载进度，切换发布通道，设置自动检查，执行下载 / 重启安装。', {
      label: '软件更新',
      action: '打开软件更新',
      query: { tab: 'update' }
    }),
    fields: []
  })

  /**
   * 内部页面 —— 把散落在应用菜单 / 侧栏里的工具页收成一张「直达清单」。
   *
   * 为什么单独开一个分区、而不是把链接塞进各自的分区：
   *   · 这些能力本身**没有可调开关**，设置页对它们的价值只有"跳过去"；
   *   · 用户找"任务管理器 / 证书 / 崩溃报告在哪"时，直觉是先来设置里翻。
   * 每项 = 一个跳转按钮（`entry` 数组 + `href`，设置页对 href 走主框架导航），
   * 因此这里**只有目录、没有逻辑** —— 页面增删也只动这一张表。
   *
   * ⚠ 只登记**真实存在且适合常驻浏览**的页（对应 `pages/<host>/`）：
   *   被调用方带参数唤起的功能页（page-info / view-source / share / print-preview …）
   *   不在此列，它们离开参数就说不清"看什么"。
   */
  registry.registerSection({
    id: 'internal-pages',
    label: '内部页面',
    group: 'system',
    icon: 'window',
    blurb: '浏览器自带的管理页，点一下即可在当前标签打开。',
    fields: [],
    // 清单（成员 / 顺序 / 文案 / 地址）全部来自 `shared-types/src/pages.mjs`
    // —— 与公共侧栏、右上角菜单是同一张表，这里只做投影，不再手写 href。
    entry: SETTINGS_INTERNAL_ENTRIES.map((item: { host: string; desc: string; action: string; href: string }) => ({
      label: pageLabel(item.host),
      desc: item.desc,
      action: item.action,
      href: item.href
    }))
  })
}

// 预构建单例：main / ipc 直接 require 即可用，无需在调用链里层层传参。
export const settingsRegistry = createSettingsRegistry()
registerBuiltinSettingsSections(settingsRegistry)

