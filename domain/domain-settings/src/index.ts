// @ts-check
/**
 * Domain: Settings — 应用设置键值存储
 *
 * 存储策略：JSON 文件（userData/settings.json）
 * 不依赖 infra-db（设置量小、读写低频，JSON 文件更合适）
 *
 * 分层：本模块**不 import 任何磁盘/路径能力**，全部经注入的 FilePort 完成
 * （PART3 §3.5 R3）。真实实现由 APPS 侧用 @hira-ng/infra-fs#createFilePort() 提供，
 * 单测里换成假端口即可脱离 Electron/Node 跑。
 *
 * 纯推导函数（sectionOf / coerceType / normalizeBounds 等）由零依赖的纯工具模块
 * settingsUtil 提供，经下方 module.exports 一并导出，供上层复用。
 */

// 零依赖纯工具（纯计算、无 IO），保持模块化与彻底解耦。
import * as SettingsUtil from './settingsUtil'
import type { SettingsMap } from './settingsUtil'
// 按 profile 的设置覆盖层（组合而非改内部，见该文件头部说明）
import { createProfileSettingsOverlay } from './profileOverlay'
// 书签栏显示策略的缺省值真源（三态取值与默认项都在那里，本文件不抄字面量）
const { BOOKMARKBAR_SETTING_KEY, DEFAULT_BOOKMARKBAR_MODE } =
  require('@hira-ng/shared-types/src/bookmarkbar.mjs')
// 搜索域设置键名 + 缺省值的真源（内置引擎真源被它再引用一次，见 search-settings.mjs）
const { DEFAULT_SEARCH_SETTINGS } = require('@hira-ng/shared-types/src/search-settings.mjs')
// 扩展系统设置键名 + 缺省值的真源（构造期读取 / 设置页 / 扩展页同源）。
const { DEFAULT_EXTENSIONS_SETTINGS } = require('@hira-ng/shared-types/src/extensions-settings.mjs')
// OOBE 引导完成态的键名真源（主进程控制器 / settings-scope 共用同一份）。
const { ONBOARDING_SETTING_KEY } = require('@hira-ng/shared-types/src/onboarding.mjs')
// 窗口 chrome 布局的缺省值真源（行 id / 顺序 / 位置 / 标题栏 / 窗口控制宿主与样式）
const {
  DEFAULT_LAYOUT_MODE,
  DEFAULT_CHROME_ROW_ORDER,
  DEFAULT_ROW_POSITION,
  DEFAULT_TITLEBAR_ENABLED,
  DEFAULT_WINDOW_CONTROLS_HOST,
  DEFAULT_WINDOW_CONTROLS_STYLE,
  DEFAULT_SIDEBAR_POSITION,
  DEFAULT_RAIL_POSITION,
  DEFAULT_RAIL_HORIZONTAL_ALIGN,
  DEFAULT_RAIL_VERTICAL_ALIGN,
  DEFAULT_RAIL_PINNED,
  LAYOUT_SETTING_KEYS
} = require('@hira-ng/shared-types/src/layout.mjs')
// 独立侧栏（Web Sidebar）的缺省位置 / 呈现模式真源；键名仍由 layout.mjs 的
// LAYOUT_SETTING_KEYS 统一持有（见下方默认值表）。
const {
  DEFAULT_WEB_SIDEBAR_POSITION,
  DEFAULT_WEB_SIDEBAR_VIEW_MODE
} = require('@hira-ng/shared-types/src/web-sidebar.mjs')
// 启动 / 主页缺省值 + 键名真源（含 DEFAULT_HOME_URL）。
const {
  STARTUP_SETTING_KEYS, DEFAULT_STARTUP_MODE, DEFAULT_HOME_MODE, DEFAULT_HOME_URL
} = require('@hira-ng/shared-types/src/startup.mjs')
// 无障碍与 PDF 的键名 / 缺省值真源。
const {
  ACCESSIBILITY_SETTING_KEYS, DEFAULT_FONT_SIZE
} = require('@hira-ng/shared-types/src/accessibility.mjs')
const { PDF_SETTING_KEYS, DEFAULT_PDF_ZOOM } = require('@hira-ng/shared-types/src/pdf.mjs')
// 侧边面板 / 网页注入 / 下载 / 标签保留的键名与缺省值真源（同一份供设置页、运行时读取）。
const { PANELS_SETTING_KEYS, DEFAULT_TABS_VIEW_MODE, DEFAULT_PINNED_VIEW_MODE } =
  require('@hira-ng/shared-types/src/panels.mjs')
const { PAGE_INJECT_SETTING_KEYS, DEFAULT_FORCE_DARK } = require('@hira-ng/shared-types/src/page-inject.mjs')
const {
  DOWNLOAD_SETTING_KEYS,
  DEFAULT_DOWNLOAD_SETTINGS,
  DOWNLOAD_CONNECTION_LIMITS,
  DOWNLOAD_RATE_LIMIT_MAX
} = require('@hira-ng/shared-types/src/downloads.mjs')
const { TABS_RETENTION_SETTING_KEYS, DEFAULT_ARCHIVE_AFTER } =
  require('@hira-ng/shared-types/src/tabs-retention.mjs')
// 标签页行为设置键名 / 缺省值真源（启动恢复、新标签位置、去重跳转、关闭确认、
// 自动画中画、跨窗口同步 —— 六个消费点散落在 main / ipc / applier）。
const { DEFAULT_TABS_SETTINGS } = require('@hira-ng/shared-types/src/tabs-settings.mjs')
// 隐私 / 安全设置键名与缺省值真源（拦截、退出清理、DNT、密码/表单填充、仅 HTTPS、保管库）。
const { DEFAULT_PRIVACY_SETTINGS } = require('@hira-ng/shared-types/src/privacy-settings.mjs')
// 性能设置键名 / 缺省值真源（启动期 Chromium 开关、内存回收与设置页共用一份）。
const { DEFAULT_PERFORMANCE_SETTINGS } = require('@hira-ng/shared-types/src/performance.mjs')
// 主题：键名（app.theme）与内置主题 id 的真源 —— 域层默认值、applier 与空间面板同源。
const { THEME_SETTING_KEYS, DEFAULT_THEME_ID } = require('@hira-ng/shared-types/src/theme.mjs')
// 浏览器指纹：设置键名的真源（"按空间隔离"的登记也引它，不抄字面量）。
const { FINGERPRINT_SETTING_KEY } = require('@hira-ng/shared-types/src/fingerprint.mjs')
// 网络代理：键名 + 缺省值的真源（applier / 设置页 / 域层默认值同源）。
const { DEFAULT_PROXY_SETTINGS } = require('@hira-ng/shared-types/src/proxy.mjs')
// 浏览器标识（UA）：键名 + 缺省值的真源（同上）。
const { DEFAULT_USER_AGENT_SETTINGS } = require('@hira-ng/shared-types/src/user-agent.mjs')
// Secure DNS：由 Chromium 主机解析器统一生效，键名 / 默认值 / URL 校验同源。
const { DEFAULT_SECURE_DNS_SETTINGS } = require('@hira-ng/shared-types/src/secure-dns.mjs')
// 自动休眠 / 省电的键名、缺省阈值与夹界真源（设置页 / 运行时定时器 / 领域规则共用一份）。
const {
  TAB_SLEEP_SETTING_KEYS,
  DEFAULT_AUTO_SLEEP_THRESHOLD_MS,
  AUTO_SLEEP_THRESHOLD_MIN_MS,
  AUTO_SLEEP_THRESHOLD_MAX_MS
} = require('@hira-ng/shared-types/src/tab-sleep.mjs')
// 历史保留期的键名与缺省天数真源（设置页 / 定期裁剪定时器共用）。
const { HISTORY_RETENTION_SETTING_KEY, DEFAULT_HISTORY_RETENTION_DAYS } =
  require('@hira-ng/shared-types/src/history-retention.mjs')
// 翻译 / 拼写检查的语言设置键名与缺省值（设置页 / 主进程 / 应用器同源）。
const { DEFAULT_TRANSLATE_SETTINGS } = require('@hira-ng/shared-types/src/translate.mjs')
const { DEFAULT_SPELLCHECK_SETTINGS } = require('@hira-ng/shared-types/src/spellcheck.mjs')
// 软件更新：偏好键名 / 缺省值 / 周期护栏（更新服务与关于页面板同源）。
const { UPDATE_SETTING_KEYS, DEFAULT_UPDATE_SETTINGS, UPDATE_INTERVAL_LIMITS } =
  require('@hira-ng/shared-types/src/update-settings.mjs')
// 结构化小集合的存储键（归档区 / 命名会话）—— 与各自的引擎和视图共用同一个键名。
const { ARCHIVE_SETTING_KEY } = require('@hira-ng/shared-types/src/archive-list.mjs')
const { NAMED_SESSIONS_SETTING_KEY } = require('@hira-ng/shared-types/src/named-sessions.mjs')
// 「最近关闭」跨启动记录的存储键（保留最近三次启动；与撤销栈同源，见纯层模块头）。
const { RECENTLY_CLOSED_SETTING_KEY } = require('@hira-ng/shared-types/src/recently-closed.mjs')
const {
  coerceType,
  normalizeBounds,
  filterBySection,
  missingDefaults,
  isDefaultValue,
  toCSSVarSuffix,
  presentSections
} = SettingsUtil

/**
 * 面向展示的 CSS 变量 section（影响排版外观，适合映射到样式变量）。
 * 其余行为型(如 downloads.max_connections)不映射，避免污染 CSS 变量表。
 * 模块级唯一口径：基础服务与 profile 覆盖层共用（见 profileOverlay.js）。
 */
const SETTINGS_CSS_VAR_SECTIONS = new Set<string>(['app', 'ui'])

export interface SettingsChange {
  key?: string
  value?: unknown
  previous?: unknown
  scope: 'one' | 'all'
  originId?: number
}
export interface SettingsFilePort {
  join(...parts: string[]): string
  existsSync(path: string): boolean
  readJsonSync(path: string): unknown
  writeJsonAtomicSync(path: string, value: unknown, options?: Record<string, unknown>): void
  writeJsonAtomic(path: string, value: unknown, options?: Record<string, unknown>): Promise<void>
}
export interface SettingsService {
  get(key: string): unknown
  set(key: string, value: unknown, originId?: number): boolean
  list(section?: string): SettingsMap
  reset(key?: string, originId?: number): boolean
  getDefault(key: string): unknown
  subscribe(listener: (change: SettingsChange) => void): () => void
  flush(): Promise<void>
  changedKeys(): string[]
  cssVars(): Record<string, unknown>
  normalize(key: string, value: unknown): unknown
  defaults(): SettingsMap
  cssVarSections(): Set<string>
}
export interface CreateSettingsOptions {
  dataDir: string
  fileName?: string
  filePort: SettingsFilePort
}

function errorMessage(error: unknown): string {
  return error && typeof error === 'object' && 'message' in error
    ? String((error as { message: unknown }).message)
    : String(error)
}

function snapshotSettings(map: SettingsMap): SettingsMap {
  try {
    return structuredClone(map)
  } catch (_) {
    return { ...map }
  }
}

/**
 * 「按空间」的设置键（B2 / J13）—— 这些键**每个空间各存一份**，切空间即换值。
 *
 * ── 为什么必须是**声明式清单**而不是"每个键都按空间存" ──────────────
 * 绝大多数设置是"这台机器上的这个人的偏好"（下载目录、快捷键、隐私开关），
 * 按空间各存一份只会让用户困惑："我明明改过，怎么切个空间又回去了"。
 * 真正该按空间隔离的是**上下文环境**：主题（B1）、代理、UA、书签顺序…
 * 因此只有**显式登记在此**的键才走空间层，其余一律落 profile 层。
 *
 * 存储：`profiles/<profileId>/spaces/<spaceId>/settings.json`（覆盖层，只存改过的键）。
 * 优先级：空间层 > profile 层 > 安装基线（见 profileOverlay 的三层说明）。
 *
 * 扩展方式：把新的键加进这个数组即可 —— 存储、读取、切空间重放都由 profileOverlay
 * 自动接管，**不需要**在任何地方再写一遍"这个键要不要按空间"的判断。
 */
const SPACE_SCOPED_SETTING_KEYS: readonly string[] = Object.freeze([
  // B1：主题随空间切换（"这个空间是工作、那个是娱乐"的视觉锚点）。
  THEME_SETTING_KEYS.active,
  // 浏览器指纹伪装：一个空间一套身份（工作与个人账号不该共用同一枚指纹）。
  // 键名真源在 shared-types/src/fingerprint.mjs —— 这里只登记"按空间隔离"这件事。
  FINGERPRINT_SETTING_KEY
])

/** 判断某个设置键是否按空间隔离（唯一判据，勿在别处重写）。 */
function isSpaceScopedSetting(key: unknown): boolean {
  return SPACE_SCOPED_SETTING_KEYS.includes(String(key))
}


/**
 * 默认设置 schema（覆盖核心场景）
 * 按 section 分组：app / search / privacy / tabs / downloads / extensions / performance / accessibility / languages / pdf
 */
const DEFAULT_SETTINGS: SettingsMap = {
  // ── General（app.*）──
  // 主题 id 真源在 shared-types/theme.mjs（缺省 = 默认主题 `hira-acrylic-light`，亚克力浅）。
  // 注意别用 BUILTIN_THEME_IDS[0]：那是"保底仍可读的配色"，不等于"新装该看到什么"。
  [THEME_SETTING_KEYS.active]: DEFAULT_THEME_ID,
  [STARTUP_SETTING_KEYS.customPage]: DEFAULT_HOME_URL,
  // 主页 / 新标签页（合并旧 app.new_tab_page / app.home_page）：
  //   模式 select：newtab（内置快速拨号）/ blank（空白页）/ custom（自定义地址）
  [STARTUP_SETTING_KEYS.homeMode]: DEFAULT_HOME_MODE,
  [STARTUP_SETTING_KEYS.homeUrl]: DEFAULT_HOME_URL,
  // 启动行为：blank / home / custom / last_session（取代旧的布尔开关 continue_where_you_left_off）
  [STARTUP_SETTING_KEYS.mode]: DEFAULT_STARTUP_MODE,
  // 书签栏显示策略（有固定书签才渲染内容，空栏不占视觉空间）：
  //   always（始终，缺省）/ newtab（仅新标签页）/ never（从不）。
  // 默认项与三态取值真源在 @hira-ng/shared-types/src/bookmarkbar.mjs；
  // 老 profile 里的布尔值由该模块的 normalizeBookmarkbarMode 无损迁移。
  [BOOKMARKBAR_SETTING_KEY]: DEFAULT_BOOKMARKBAR_MODE,
  // Rail/Panel（工具图标栏 + 侧边面板）位置：left / right（纵向列）或 top / bottom（横向条）。
  // 面板开在哪侧由 resolveRailPanelSide 解算，不由这条键直接给出。
  [LAYOUT_SETTING_KEYS.toolSidebarPosition]: DEFAULT_RAIL_POSITION,
  // rail 的两条「按钮起始边」：横向（左 / 右起）与纵向（上 / 下起）。
  // 横向那条同时决定 rail 偏哪边 → 面板开哪侧（见 resolveRailPanelSide）。
  [LAYOUT_SETTING_KEYS.toolRailHorizontalAlign]: DEFAULT_RAIL_HORIZONTAL_ALIGN,
  [LAYOUT_SETTING_KEYS.toolRailVerticalAlign]: DEFAULT_RAIL_VERTICAL_ALIGN,
  [LAYOUT_SETTING_KEYS.toolRailPinned]: DEFAULT_RAIL_PINNED,
  // 垂直标签侧栏（标签列那一栏）位置：'left'（默认）或 'right'。
  // 与上一条**相互独立** —— 纵向轨道上两段可以各靠一边（见 shared-types/layout.mjs）。
  [LAYOUT_SETTING_KEYS.sideColumnPosition]: DEFAULT_SIDEBAR_POSITION,
  // 独立侧栏（Web Sidebar，浏览网页的那个）位置偏好：'auto'（默认）/ 'left' / 'right'。
  // 'auto' = 落在**工具区（rail + 面板）所在的那一侧**（跟随 —— "从哪边点开就从哪边出来"）。
  // 想要"错开一侧"就显式选 left / right，或直接**拖侧栏顶条**拖到另一边
  // （见 shared-types/layout.mjs 与 web-sidebar.mjs#resolveWebSidebarSide）。
  [LAYOUT_SETTING_KEYS.webSidebarPosition]: DEFAULT_WEB_SIDEBAR_POSITION,
  // 独立侧栏的**视图模式**：'mobile'（默认，窄栏里站点版式才正常）/ 'desktop'。
  // 只是呈现模式（换一条 UA），与 session / 登录态无关。
  [LAYOUT_SETTING_KEYS.webSidebarViewMode]: DEFAULT_WEB_SIDEBAR_VIEW_MODE,
  // 窗口 chrome 布局（唯一真源 @hira-ng/shared-types/src/layout.mjs）：
  //   app.layout_mode             'default'（各行独立摆放）/ 'compact'（标签栏与导航栏合并单行）
  //   app.titlebar_enabled        是否显示「标题栏」这块（网页标题）
  //   app.<row>_position          每块所在侧：'top' / 'bottom'
  //   app.chrome_row_order        同侧各栏的自上而下顺序（栏目 id 数组）
  //   app.window_controls_host    窗口控制按钮宿主栏：'tabbar' / 'navbar' / 'titlebar'
  // 全部纯渲染层生效（无主进程 applier）—— 换布局只是把外壳的几块重新摆一次。
  [LAYOUT_SETTING_KEYS.mode]: DEFAULT_LAYOUT_MODE,
  [LAYOUT_SETTING_KEYS.titlebarEnabled]: DEFAULT_TITLEBAR_ENABLED,
  [LAYOUT_SETTING_KEYS.rowPosition.tabbar]: DEFAULT_ROW_POSITION,
  [LAYOUT_SETTING_KEYS.rowPosition.navbar]: DEFAULT_ROW_POSITION,
  [LAYOUT_SETTING_KEYS.rowPosition.titlebar]: DEFAULT_ROW_POSITION,
  [LAYOUT_SETTING_KEYS.rowPosition.bookmarkbar]: DEFAULT_ROW_POSITION,
  // 真源数组是冻结的，这里复制一份：设置值会在用户拖栏时被整体替换/重排。
  [LAYOUT_SETTING_KEYS.rowOrder]: [...DEFAULT_CHROME_ROW_ORDER],
  [LAYOUT_SETTING_KEYS.windowControlsHost]: DEFAULT_WINDOW_CONTROLS_HOST,
  // 窗口控制按钮实现样式：'native'（缺省，强制系统原生 WCO）/ 'custom'（应用自绘）。
  // 两态、无推导 —— 用户选什么就是什么。建窗期决定（Windows 上 WCO 无运行时开关），
  // 改动**下次开窗口生效**。
  [LAYOUT_SETTING_KEYS.windowControlsStyle]: DEFAULT_WINDOW_CONTROLS_STYLE,
  // OOBE 首次启动引导的完成版本号（'' = 从未引导）。
  // 存版本号而不是布尔：改版时把 main/onboarding 的 ONBOARDING_VERSION 提一版，
  // 老用户自然会再走一遍，不需要迁移脚本。全局作用域见 shared-types/settings-scope.mjs。
  [ONBOARDING_SETTING_KEY]: '',

  // ── Search ──
  // 默认引擎的缺省值来自内置引擎真源（`search-engines.mjs`），不在这里抄一次名字。
  // 内置引擎**模板**曾经也在这里存一份（`search.engine-google/bing/...`）—— 无人读取、
  // 且与域层代码事实两套真相，已删除；自定义引擎是用户数据，落 SQLite `custom_engines`。
  ...DEFAULT_SEARCH_SETTINGS,
  // 旧版「自定义引擎 1/2/3」三个槽：仅由 appliers/search.js 的一次性迁移读取，
  // 迁移成功即清空。默认值不在此登记（`get()` 对未登记键返回 undefined，迁移按空串跳过）。

  // ── 网页注入（J10：Boosts / 强制深色 / 用户脚本共用一条通道）──
  [PAGE_INJECT_SETTING_KEYS.forceDark]: DEFAULT_FORCE_DARK, // 'off' | 'on'：站点没做深色时套一层智能反色
  [PAGE_INJECT_SETTING_KEYS.rules]: '',    // 站点级规则（JSON 串，由「注入规则」面板管理）

  // ── 归档区（J9）──
  [ARCHIVE_SETTING_KEY]: '',      // 归档记录（JSON 串，由「归档」面板管理；可恢复）

  // ── 命名会话 / 会话模板（N14）──
  // 快照的序列化结果（JSON 串，由 hira://sessions 页面管理）。**不建新表** ——
  // 结构化小集合走设置项是本项目一贯做法（与 archive.entries / webview.inject_rules 同族），
  // 天然随 profile 隔离。默认空串 = 没有任何命名会话。
  [NAMED_SESSIONS_SETTING_KEY]: '',

  // ── 「最近关闭」的跨启动记录（C16 长期化）──
  // 一条 JSON 串，只保留**最近三次启动**里的记录（见 shared-types/recently-closed.mjs）。
  // 与命名会话同族：结构化小集合走设置项，不建表；随 profile 隔离。
  [RECENTLY_CLOSED_SETTING_KEY]: '',

  // ── 面板内分段：上次停在哪一段（每块面板各一个键，随 profile 持久化）──
  [PANELS_SETTING_KEYS.tabsViewMode]: DEFAULT_TABS_VIEW_MODE,
  // ── 固定标签视图（A4 / Pin Grid）──
  [PANELS_SETTING_KEYS.pinnedViewMode]: DEFAULT_PINNED_VIEW_MODE,

  // ── Privacy & Security ──
  // 键名 / 缺省值全部来自 shared-types/privacy-settings.mjs：拦截广告 / 追踪器、
  // 退出时逐项清除（取代旧的单一 clear_data_on_exit，更强可控）、请勿跟踪、
  // 密码保存询问 / 表单自动填充、仅 HTTPS、支付卡 / 地址保管库。
  ...DEFAULT_PRIVACY_SETTINGS,
  // E1 双表：历史保留天数（0 = 永久保留，不裁剪）。与 clear_on_exit 正交 ——
  // 前者管"本地库留多久"，后者管"退出时清不清"。逐次访问日志随聚合行一并裁剪。
  [HISTORY_RETENTION_SETTING_KEY]: DEFAULT_HISTORY_RETENTION_DAYS,

  // ── Network（I4：代理）──
  // 键名 / 缺省值全部来自 shared-types/proxy.mjs（模式表、空值兜底都在那里）。
  // 默认 `system` = 与"没做过任何设置"完全等价（不改变既有网络行为）。
  // 默认旁路含本机地址 —— 对齐主流浏览器的出厂值（本机回环不该绕代理）。
  ...DEFAULT_PROXY_SETTINGS,
  // Secure DNS / DoH：默认 automatic + 跟随系统，保持 Electron 出厂网络行为。
  ...DEFAULT_SECURE_DNS_SETTINGS,
  // 浏览器标识（UA）：默认 = 清洗后的标准 Chrome UA（见 shared-types/user-agent.mjs）。
  ...DEFAULT_USER_AGENT_SETTINGS,

  // ── Tabs ──
  [TAB_SLEEP_SETTING_KEYS.autoSleep]: true,
  // 自动休眠阈值：5 分钟（原 10 分钟）—— 一个醒着的标签 = 一份完整 renderer
  //（实测 ~104MB 工作集 / ~25MB 独占），默认取更省内存的那一档，见 settings/registry 的说明。
  [TAB_SLEEP_SETTING_KEYS.thresholdMs]: DEFAULT_AUTO_SLEEP_THRESHOLD_MS,
  [TAB_SLEEP_SETTING_KEYS.excludePinned]: true,
  // N12 省电模式：强制后台标签降频（即使 cpu_throttle_background 关了），
  // 并在自动休眠开启时把非活动阈值收紧到 1 分钟 —— 牺牲"切回即用"换续航。
  [TAB_SLEEP_SETTING_KEYS.energySaver]: false,
  // 长期未用的标签自动归档（归档 = 关闭该标签，不进撤销栈；下次需要时重新打开）。
  // 默认 'never'：不改变任何既有行为，用户显式开启后才生效。
  // 取值集合与阈值表见 shared-types/tabs-retention.mjs（与设置页 / 定时器同源）。
  [TABS_RETENTION_SETTING_KEYS.archiveAfter]: DEFAULT_ARCHIVE_AFTER,
  // 标签页行为（启动恢复、新标签位置、去重跳转、关闭确认、自动画中画、跨窗口同步）：
  // 键名 / 缺省值全部来自 shared-types/tabs-settings.mjs。
  ...DEFAULT_TABS_SETTINGS,

  // ── Downloads ──
  // 键名 / 缺省值全部来自 shared-types/downloads.mjs（设置页与下载运行时同源）。
  ...DEFAULT_DOWNLOAD_SETTINGS,

  // ── Extensions ──
  ...DEFAULT_EXTENSIONS_SETTINGS,

  // ── Performance ──
  // 键名 / 缺省值全部来自 shared-types/performance.mjs（启动期开关与设置页同源）。
  ...DEFAULT_PERFORMANCE_SETTINGS,

  // ── Accessibility ──
  [ACCESSIBILITY_SETTING_KEYS.captions]: false,
  [ACCESSIBILITY_SETTING_KEYS.highContrast]: false,
  [ACCESSIBILITY_SETTING_KEYS.caretBrowsing]: false,
  [ACCESSIBILITY_SETTING_KEYS.fontSize]: DEFAULT_FONT_SIZE,

  // ── Languages ──
  // 翻译 / 拼写检查的键名与缺省值全部来自 shared-types（设置页 / 主进程同源）。
  ...DEFAULT_TRANSLATE_SETTINGS,
  ...DEFAULT_SPELLCHECK_SETTINGS,

  // ── PDF Viewer ──
  [PDF_SETTING_KEYS.viewerEnabled]: true,
  [PDF_SETTING_KEYS.defaultZoom]: DEFAULT_PDF_ZOOM,

  // ── 软件更新（Update）──
  // 状态真源在 main/update/service.js：这里只存「用户意愿」与「上次检查时刻」。
  // 键名 / 缺省值来自 shared-types/update-settings.mjs（更新服务与关于页面板同源）。
  ...DEFAULT_UPDATE_SETTINGS
}

/**
 * 老 profile 的**无损迁移**：某些设置项原本与另一项共用一个键，后来拆成两项。
 *
 * 迁移规则一律是「新键沿用旧键的值」—— 拆开是为了让用户能把它们**分别**调整，
 * 而不是要在升级瞬间改变他现在的观感。只认「磁盘上确实没有新键」，
 * 因此恰好生效一次；用户之后怎么分都不会被再覆盖。
 *
 * 注意本函数只吃**持久化文件里那份原始设置**（未经默认值填充）——
 * cache 已经先铺过 DEFAULT_SETTINGS，直接看 cache 会永远看到默认值。
 *
 * @param {Record<string, unknown>} persisted 磁盘上那份原始设置
 * @returns {Record<string, unknown>} 需要覆盖进 cache 的键值对（空对象 = 无需迁移）
 */
function legacyKeyOverrides(persisted: unknown): SettingsMap {
  const src = persisted && typeof persisted === 'object' ? persisted as SettingsMap : {}
  const out: SettingsMap = {}
  // 「垂直标签侧栏位置」(app.side_column_position) 从「工具侧栏位置」
  // (app.sidebar_position) 拆出：老用户两者本是同一条设置，迁移后仍保持同侧 ——
  // 直接落默认值会把他原本靠右的标签列悄悄挪到左边。
  // 只搬「左 / 右」：这条旧键现在还能取 top / bottom（横向 rail），
  // 那是**这次新增**的取值，不属于迁移语义 —— 落进去会让侧栏列莫名靠左。
  const legacyPosition = src[LAYOUT_SETTING_KEYS.toolSidebarPosition]
  if (
    !(LAYOUT_SETTING_KEYS.sideColumnPosition in src) &&
    (legacyPosition === 'left' || legacyPosition === 'right')
  ) {
    out[LAYOUT_SETTING_KEYS.sideColumnPosition] = legacyPosition
  }
  return out
}

/**
 * Create settings service.
 *
 * 磁盘能力**不 import**，由 APPS 注入 FilePort（PART3 §3.5 R3：domain 不得 require fs/path）。
 * 这同时让持久化逻辑可以在 vitest 里用假端口跑，无需碰真实磁盘。
 *
 * @param {{ dataDir: string, fileName?: string, filePort: {
 *   join: (...p: string[]) => string, existsSync: (p: string) => boolean,
 *   readJsonSync: (p: string) => unknown, writeJsonAtomicSync: (p: string, v: unknown, o?: unknown) => void,
 *   writeJsonAtomic: (p: string, v: unknown, o?: unknown) => Promise<void>
 * } }} options
 *   `fileName` 缺省 `settings.json`；L2（PART16）下**全局设置**用 `settings.global.json`
 *   同一套服务（护栏 / 防抖 / 订阅全部复用），只是落到另一个文件。
 */
function createSettingsService({ dataDir, filePort, fileName }: CreateSettingsOptions): SettingsService {
  if (!filePort) throw new Error('[domain-settings] filePort is required (inject @hira-ng/infra-fs#createFilePort)')
  const filePath = filePort.join(dataDir, fileName || 'settings.json')

  let cache: SettingsMap = { ...DEFAULT_SETTINGS }
  let dirty = false

  /**
   * 变更订阅者集合。
   * 设置不应该是"写进文件就没人管"的死数据 —— 任何 UI/模块都应能观测到变更并即时生效。
 * @type {Set<(change:{key:string,value:unknown,previous:unknown,scope:'one'|'all',originId?:number}) => void>}
   */
  const listeners = new Set<(change: SettingsChange) => void>()

  function load(): void {
    try {
      if (filePort.existsSync(filePath)) {
        const parsed = filePort.readJsonSync(filePath) as SettingsMap
        cache = { ...DEFAULT_SETTINGS, ...parsed, ...legacyKeyOverrides(parsed) }
      }
    } catch (e) {
      cache = { ...DEFAULT_SETTINGS }
    }
    dirty = false
  }

  /* ───────────────────────────────────────────────────────────────
   * 持久化：**防抖 + 异步**，绝不阻塞主进程事件循环。
   *
   * 以前是「每次 set 都 fs.writeFileSync」：同步磁盘 I/O 会卡住主进程，
   * 而主进程一卡，所有 IPC（下一次点击、下载轮询响应、标签创建）都会一起变慢，
   * 表现为「整个浏览器都卡」。设置是高频小写入、可容忍极短延迟丢失，
   * 因此改成防抖异步写；退出前由 flush() 同步落盘兜底。
   * ─────────────────────────────────────────────────────────────── */
  const SAVE_DEBOUNCE_MS = 120
  let saveTimer: ReturnType<typeof setTimeout> | null = null
  let revision = 0
  let writeRevision = 0
  let writeTail: Promise<void> = Promise.resolve()

  /** 同步落盘（仅 flush / 退出路径使用）。 */
  function writeSync(): void {
    try {
      filePort.writeJsonAtomicSync(filePath, cache, { space: 2 })
      dirty = false
    } catch (e) {
      console.error('[settings] save failed:', errorMessage(e))
    }
  }

  /** 异步落盘（常规路径不阻塞事件循环，按 revision 保证旧快照不覆盖新快照）。 */
  function writeAsync(): Promise<void> {
    const snapshot = snapshotSettings(cache)
    const currentRevision = ++writeRevision
    const task = writeTail
      .catch(() => {})
      .then(() => filePort.writeJsonAtomic(filePath, snapshot, { space: 2 }))
    writeTail = task.catch(() => {})
    return task
      .then(() => {
        if (currentRevision === writeRevision && revision === writeRevision) dirty = false
      })
      .catch((e) => console.error('[settings] async save failed:', errorMessage(e)))
  }

  function scheduleSave(): void {
    dirty = true
    revision += 1
    if (saveTimer) return
    saveTimer = setTimeout(() => {
      saveTimer = null
      writeAsync()
    }, SAVE_DEBOUNCE_MS)
  }

  /** 排空队列后把最新快照同步落盘（仅退出路径）。 */
  async function flush(): Promise<void> {
    if (saveTimer) {
      clearTimeout(saveTimer)
      saveTimer = null
    }
    await writeTail
    if (dirty) writeSync()
  }

  /**
   * Get a setting value.
   * @param {string} key
   * @returns {unknown}
   */
  function get(key: string): unknown {
    return cache[key]
  }

  /**
   * 通知订阅者。
   * 单个订阅者抛错不得影响其余订阅者，更不得回滚已保存的设置 —— 订阅者是消费者，不是校验者。
   * @param {'one'|'all'} scope
   * @param {string} [key]
   * @param {unknown} [value]
   * @param {unknown} [previous]
   * @param {number} [originId]  发起变更的 webContentsId（透传给广播层去回声）
   */
  function emit(scope: 'one' | 'all', key?: string, value?: unknown, previous?: unknown, originId?: number): void {
    for (const fn of listeners) {
      try {
        fn({ scope, key, value, previous, originId })
      } catch (e) {
        console.error('[settings] subscriber failed:', errorMessage(e))
      }
    }
  }

  /**
   * 订阅设置变更。
   * @param {(change:{key:string,value:unknown,previous:unknown,scope:'one'|'all',originId?:number}) => void} fn
   * @returns {() => void} 取消订阅
   */
  function subscribe(fn: (change: SettingsChange) => void): () => void {
    if (typeof fn !== 'function') return () => {}
    listeners.add(fn)
    return () => { listeners.delete(fn) }
  }

  /**
   * number 型设置的有理边界（越界 → 夹取；语义见各自注释）。
   * 未知/无边界约束的 number 键不做夹取，仅做型别强制。
   */
  const NUMBER_BOUNDS: Record<string, { min: number; max: number }> = {
    [DOWNLOAD_SETTING_KEYS.maxConnections]: DOWNLOAD_CONNECTION_LIMITS,                 // 并发连接数（1-16，与默认 8 对齐）
    [DOWNLOAD_SETTING_KEYS.rateLimit]: { min: 0, max: DOWNLOAD_RATE_LIMIT_MAX },        // 0 = 不限速；上限 1GB/s 兜底，防手滑
    [TAB_SLEEP_SETTING_KEYS.thresholdMs]: { min: AUTO_SLEEP_THRESHOLD_MIN_MS, max: AUTO_SLEEP_THRESHOLD_MAX_MS }, // 自动休眠阈值：1s .. 24h
    [UPDATE_SETTING_KEYS.intervalHours]: UPDATE_INTERVAL_LIMITS                          // 自动更新检查周期：1h .. 1 年
  }

  /** Legacy keys kept writable for upgrades even after their defaults moved to new keys. */
  const LEGACY_SETTING_TYPES: Record<string, 'boolean' | 'number' | 'string'> = {
    'app.continue_where_you_left_off': 'boolean'
  }

  /**
   * 把外部传入的值规整成该键的合法值（型别强制 + number 夹界），**不写不通知**。
   *
   * 为什么需要单独的公开入口：设置现在还有「按 profile 的覆盖层」这一路写入
   * （见 profileOverlay.js），它必须与主路径用**同一套**护栏 ——
   * 若各自实现一份，夹界规则迟早会漂移（一处改了另一处忘改）。
   * @param {string} key
   * @param {unknown} value
   * @returns {unknown}
   */
  function normalize(key: string, value: unknown): unknown {
    let next = value
    const defaultType = LEGACY_SETTING_TYPES[key] || typeof DEFAULT_SETTINGS[key]
    if (defaultType === 'boolean' || defaultType === 'number' || defaultType === 'string') {
      next = coerceType(value, defaultType)
      if (defaultType === 'number') {
        const b = NUMBER_BOUNDS[key]
        if (b) next = normalizeBounds(next, b.min, b.max)
      }
    }
    return next
  }

  /**
   * Set a setting value.
   * 接受任意键（即使未在 DEFAULT_SETTINGS 中定义），方便扩展新设置项
   * 而无需同步更新 DEFAULT_SETTINGS。未知键无默认值，reset 时不会被还原。
   *
   * 型别护栏（additive，等价语义增强）：见 normalize()。
   * @param {string} key
   * @param {unknown} value
   * @param {number} [originId] 发起变更的 webContentsId（可选，用于广播去回声）
   * @returns {boolean}
   */
  function set(key: string, value: unknown, originId?: number): boolean {
    const next = normalize(key, value)
    const previous = cache[key]
    // 值未变化则不写盘、不通知 —— 避免渲染进程回环与无意义的文件写入
    if (previous === next) return true
    cache[key] = next
    scheduleSave()
    emit('one', key, next, previous, originId)
    return true
  }

  /**
   * Get all settings, optionally filtered by section prefix.
   * 内部复用纯工具 filterBySection（语义等价原手写前缀过滤）。
   * @param {string} [section]  e.g. 'search', 'downloads'
   * @returns {Record<string, unknown>}
   */
  function list(section?: string): SettingsMap {
    if (!section) return { ...cache }
    return filterBySection(cache, section)
  }

  /**
   * 返回相对默认值发生「差异」的键列表：缺省键(missingDefaults) 与非默认值键的并集。
   * 供 UI「恢复默认/未改动项高亮」等场景判断整份设置是否处于默认态。
   * @returns {string[]}
   */
  function changedKeys(): string[] {
    const missing = missingDefaults(cache, DEFAULT_SETTINGS)
    const nonDefault = Object.keys(cache).filter(
      (k) => k in DEFAULT_SETTINGS && !isDefaultValue(k, cache[k], DEFAULT_SETTINGS)
    )
    return Array.from(new Set([...missing, ...nonDefault]))
  }

  /**
   * 面向展示的 CSS 变量 section（影响排版外观，适合映射到样式变量）。
   * 其余行为型(如 downloads.max_connections)不映射，避免污染 CSS 变量表。
   *
   * 提升到模块级：按 profile 的覆盖层（profileOverlay.js）也要用同一份口径，
   * 否则「哪些 section 进 CSS 变量」会出现两套答案。
   */
  const CSS_VAR_SECTIONS = SETTINGS_CSS_VAR_SECTIONS

  /**
   * 把展示型 section 的设置组装成 CSS 变量映射 `{ [后缀]: 值 }`。
   * 后缀由纯工具 toCSSVarSuffix 派生（点转 '-'、取末段）。
   * @returns {Record<string, unknown>}
   */
  function cssVars(): Record<string, unknown> {
    const out: Record<string, unknown> = {}
    for (const sec of presentSections(cache)) {
      if (!CSS_VAR_SECTIONS.has(sec)) continue
      for (const k of Object.keys(filterBySection(cache, sec))) {
        out[toCSSVarSuffix(k)] = cache[k]
      }
    }
    return out
  }

  /**
   * Reset a single setting or all settings to defaults.
   * @param {string} [key]  if omitted, reset all
   * @param {number} [originId] 发起变更的 webContentsId（可选，用于广播去回声）
   * @returns {boolean}
   */
  function reset(key?: string, originId?: number): boolean {
    if (key) {
      if (!(key in DEFAULT_SETTINGS)) return false
      const previous = cache[key]
      const next = DEFAULT_SETTINGS[key]
      cache[key] = next
      scheduleSave()
      emit('one', key, next, previous, originId)
    } else {
      const previous = cache
      cache = { ...DEFAULT_SETTINGS }
      scheduleSave()
      emit('all', undefined, undefined, previous, originId)
    }
    return true
  }

  /**
   * Get the default value for a key.
   * @param {string} key
   * @returns {unknown}
   */
  function getDefault(key: string): unknown {
    return DEFAULT_SETTINGS[key]
  }

  // Load on creation
  load()

  /**
   * 默认值全表 / CSS 变量 section 口径。
   *
   * 为什么要暴露出来：按 profile 的覆盖层需要「出厂默认」来判断哪些键算改动过、
   * 以及哪些 section 该进 CSS 变量。让它**问 base 要**，是为了让默认值与口径
   * 只有一份来源 —— 否则覆盖层得自己 require 本文件，形成环状依赖。
   */
  function defaults(): SettingsMap {
    return DEFAULT_SETTINGS
  }

  function cssVarSections(): Set<string> {
    return CSS_VAR_SECTIONS
  }

  return {
    get, set, list, reset, getDefault, subscribe, flush, changedKeys, cssVars, normalize,
    defaults, cssVarSections
  }
}

export {
  createSettingsService,
  createProfileSettingsOverlay,
  DEFAULT_SETTINGS,
  SETTINGS_CSS_VAR_SECTIONS,
  // 「按空间」设置键的声明式清单 + 唯一判据（B2 / J13）
  SPACE_SCOPED_SETTING_KEYS,
  isSpaceScopedSetting,
}
export * from './settingsUtil'
export default {
  createSettingsService,
  createProfileSettingsOverlay,
  DEFAULT_SETTINGS,
  SETTINGS_CSS_VAR_SECTIONS,
  SPACE_SCOPED_SETTING_KEYS,
  isSpaceScopedSetting,
  ...SettingsUtil
}
