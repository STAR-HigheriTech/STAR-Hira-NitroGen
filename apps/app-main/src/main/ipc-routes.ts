/**
 * IPC 路由聚合器（薄壳）
 *
 * refactor-main-sink-plan.md Step 5：121 个 handle 按「// ── Domain: Xxx ──」
 * 原有分段拆到 `main/ipc/<domain>.js`，每域一个 `register<Xxx>Ipc(typedMain, ctx)`，
 * 与 `settings/ipc.js`、`external-games/ipc.js` 同构。本文件只负责：
 *   1. 加载通道契约（@hira-ng/shared-types，动态 import：main 是 CJS、契约是 .mjs）
 *   2. 创建 typedMain
 *   3. 按域分发（每个注册器只拿到自己需要的依赖 —— 不再全量透传 ctx）
 *   4. Settings / ExternalGames 两个既有特性模块的装配
 *
 * 签名不变：snapshot-bootstrap.js 等调用方零改动。
 */

const { createTypedIpcMain, ipcSchemas } = require('@hira-ng/infra-ipc')
const { ipcRoutePolicy } = require('./ipc-route-policy')
const { isWebPreloadIpcSender } = require('./ipc-sender-trust')
const { PRIVACY_SETTING_KEYS } = require('@hira-ng/shared-types/src/privacy-settings.mjs')
const { consumeSafeBrowsingWarning } = require('./safe-browsing') as {
  consumeSafeBrowsingWarning(token: unknown, url: unknown): boolean
}
const { isSecurityWarningUrl, targetUrlOfSecurityWarning, tokenOfSecurityWarning } =
  require('@hira-ng/shared-types/src/security-warning.mjs') as {
    isSecurityWarningUrl(value: unknown): boolean
    targetUrlOfSecurityWarning(value: unknown): string
    tokenOfSecurityWarning(value: unknown): string
  }
// 窄端口适配器：会话域只认识 list / getActiveTabId / newTab / switchTo 等动词，
// 由这里把「按窗口解析的 TabManager」适配过去（见 ipc/session.js 的说明）。
const { createSessionTabPort } = require('@hira-ng/infra-window')
const { registerSettingsIpc, settingsRegistry } = require('./settings')
const { registerExternalGamesIpc } = require('./external-games')

const { registerLayoutIpc } = require('./ipc/layout')
// 面板换宿主（panel ↔ detached-panel 窗口）—— 通用能力，任何面板都能用。
const { registerPanelTransferIpc } = require('./ipc/panel-transfer')
const { registerTabsIpc } = require('./ipc/tabs')
const { registerBookmarkIpc } = require('./ipc/bookmarks')
// 笔记域（侧栏笔记 + 文件夹）：与书签域同构的「域服务 + 能力插件」两段式
const { registerNotesIpc } = require('./ipc/notes')
// TOTP 域（2FA 验证器插件）：同上两段式；能力被禁用时不回落域服务（见该注册器的说明）
const { registerTotpIpc } = require('./ipc/totp')
// PWA（把站点安装为应用）：探测 / 安装 / 快捷方式 / 应用窗口 / 更新 / 卸载。
// 各编排对象由 main.js 注入；P4/P6 的端口缺席时只跳过对应路由（见该注册器说明）。
const { registerPwaIpc } = require('./ipc/pwa')
const { registerBookmarkBackupIpc } = require('./bookmark-backup/ipc')
const { registerHistoryIpc } = require('./ipc/history')
const { registerDownloadIpc } = require('./ipc/downloads')
const { registerExtensionIpc, createExtensionEventRelay } = require('./ipc/extensions')
// chrome.identity 桥：走**裸通道**（发送方是第三方扩展，不是内部渲染层），
// 因此不走 typedMain / IPC_ROUTES；身份与 profile 会话都在该文件里自行校验。
const { registerIdentityIpc } = require('./ipc/identity')
const { registerKeybindingsIpc } = require('./ipc/keybindings')
const { registerPasswordIpc } = require('./ipc/passwords')
const { registerPermissionIpc } = require('./ipc/permissions')
const { registerSearchIpc } = require('./ipc/search')
const { registerAutomationIpc } = require('./ipc/automation')
const { registerTranslateIpc } = require('./ipc/translate')
const { registerBreakIpc } = require('./ipc/break-mode')
// 打印域：预览窗口只持 jobId，渲染/系统打印/另存 PDF 全在主进程（main/print/service.ts）
const { registerPrintIpc } = require('./ipc/print')
// 截图标注编辑器（三种截图共用）：取走暂存底图 / 写剪贴板 / 另存 PNG。
const { registerCaptureIpc } = require('./ipc/capture')
const { registerProfileIpc } = require('./ipc/profile')
const { registerSpaceIpc } = require('./ipc/space')
// 空间变更的唯一广播出口：CRUD 与归档导入共用，避免两条写路径各抄一份而漂移。
const { createSpaceChangeNotifier } = require('./ipc/space-events')
// 空间导出 / 导入（F-0961 / F-0984 / F-0985 / F-0987~F-0989）：
// 与 profile-archive 同构 —— 这里只弹对话框，格式与搬运在别处。
const { registerSpaceArchiveIpc } = require('./ipc/space-archive')
const { registerSessionIpc } = require('./ipc/session')
const { registerWindowIpc } = require('./ipc/window')
const { registerNtpIpc } = require('./ipc/ntp')
const { registerHomeIpc } = require('./ipc/home')
// 独立小域：标签截图读取地址 / 光标边缘订阅开关。
// 两者在旧版曾「写好却没接线」——注册器存在但无人 require、契约也缺路由；
// 这里补上装配，让能力真正可达（无 snapshotService/monitor 时注册器自身安全跳过）。
const { registerSnapshotIpc } = require('./ipc/snapshot')
// hover 预览的**第二条数据源**（第一条是上面的截图）：这个标签占多少内存。
// 与截图分开成域，是因为它们回答的问题与数据来源都不同（位图 vs 进程指标）。
const { registerTabMemoryIpc } = require('./ipc/tab-memory')
// 屏幕抓帧（「扫码器」插件的数据源）：核心只提供窄通道，实现在插件能力里。
const { registerScreenIpc } = require('./ipc/screen')
// 按钮编辑模式（navbar / rail 的面板按钮排序与显隐）：开关 + 几何中转 + 编辑浮层图层。
const { registerButtonsEditIpc } = require('./ipc/buttons-edit')
const { registerLayoutDocumentIpc } = require('./ipc/layout-document')
const { registerFindIpc } = require('./ipc/find')
const { registerZoomIpc } = require('./ipc/zoom')
// 主题域（目录 / 当前主题 / 切换 / 调度 / 令牌表）：只转调 theme-service，
// 规则与"颜色→令牌"的唯一真源分别在 theme-service 与 shared-types/theme.mjs。
const { registerThemeIpc } = require('./ipc/theme')
// 站点数据 / 浏览数据 / 进程指标 / 页面信息：四条独立小域，各自只依赖注入的端口
const { registerCookieIpc } = require('./ipc/cookies')
const { registerBrowsingDataIpc } = require('./ipc/browsing-data')
const { registerAppMetricsIpc } = require('./ipc/app-metrics')
const { registerAppInfoIpc } = require('./ipc/app-info')
// 软件更新：四条动作（快照 / 检查 / 下载 / 安装），状态真源在 main/update/service.js。
const { registerUpdateIpc } = require('./ipc/update')
// 默认浏览器（查询 / 设为系统默认）与外部协议授权记录（列出 / 撤销）：
// 两者都只依赖各自注入的服务，与 AppInfo 同属「应用自身事实」类小域。
const { registerDefaultBrowserIpc } = require('./ipc/default-browser')
const { registerPasskeyIpc } = require('./ipc/passkeys')
const { registerCaptureHubIpc } = require('./ipc/capture-hub')
const { registerPageLibraryIpc } = require('./ipc/page-library')
// OOBE 首次启动引导（状态 / 完成 / 重置）：薄转发到 main/onboarding 控制器。
const { registerOnboardingIpc } = require('./ipc/onboarding')
// 浏览器一键迁移：探测 / 导入（服务缺席时注册器自身安全跳过）。
const { registerBrowserImportIpc } = require('./ipc/browser-import')
// 配置档案导出 / 导入（G1 / G2）：弹原生文件对话框 + 转调 profile-archive 引擎。
const { registerProfileArchiveIpc } = require('./ipc/profile-archive')
// 分享 / 二维码（N15）：文本 → QR 的 SVG（生成在主进程，见 main/share.js）
const { registerShareIpc } = require('./ipc/share')
// 命名会话 / 会话模板（N14）：存/列/恢复/删（存储走设置项，见 main/named-sessions.js）
const { registerNamedSessionsIpc } = require('./ipc/named-sessions')
// 支付卡 / 地址保管库（N7）：加密保管 + 显式揭示（见 main/form-fill.js）
const { registerFormFillIpc } = require('./ipc/form-fill')
const { registerOpenExternalIpc } = require('./ipc/open-external')
// 系统文件拖入窗口：分类与打开在 file-open/，这里只映射一条通道。
const { registerFilesIpc } = require('./ipc/files')
const { registerPageIpc } = require('./ipc/page')
const { registerCrashIpc, registerCertificateIpc, registerSiteSecurityIpc } = require('./ipc/security')
// 站点安全探针：CDP 证书链 + X509 解析（纯采集，不认识 IPC；见该文件头）。
const { createSiteSecurity } = require('./site-security')
const { registerHttpAuthIpc } = require('./ipc/http-auth')
// Harness 插件中心：列出/启停浏览器自身插件（不是 Chrome 扩展）。
// 插件后台启动 → 用 getPluginRegistry 端口拿「迟到的」注册中心，见该文件头说明。
const { registerPluginsIpc } = require('./ipc/plugins')
// 宿主侧调用插槽的统一入口（错误只告警、绝不上抛）。见该文件头说明。
const { createSlotCaller } = require('./slot-call')
// 渲染侧插槽宿主（PART7 §7.3 跨进程那一半）：slots:render / slots:dispatch
const { registerSlotsIpc } = require('./ipc/slots')

import type { IpcHandlerDefinition, TypedIpcMain } from '@hira-ng/infra-ipc'
import type { WindowRuntimeRegistry } from './window-runtime-registry'
import type { IpcMain, WebContents } from 'electron'

type EventEmit = (route: string, payload: unknown, options?: { windowId: number }) => unknown
interface TabManagerIpcPort {
  newTab(options: { url: string }): Promise<unknown>
  navigate(options: { url: string; tabId?: string }): Promise<unknown>
  getActiveWebContents(): unknown
  getWebContents(tabId: string): unknown
  getActiveTabId(): string | null
  getTabIdByWebContents(webContents: WebContents): string | null | undefined
}
interface WebSidebarIpcPort {
  owns(webContents: WebContents | null): boolean
  open(url: string): { open: boolean; url: string }
}

function isCertificatePageSender(event: unknown): boolean {
  const frame = event && typeof event === 'object'
    ? (event as { senderFrame?: { url?: unknown; detached?: unknown } | null }).senderFrame
    : null
  if (!frame || frame.detached === true) return false
  try {
    const url = new URL(String(frame.url || ''))
    return (url.protocol === 'hira:' && url.hostname.toLowerCase() === 'certificates') ||
      /\/pages\/certificates(?:\/|$)/i.test(url.pathname)
  } catch {
    return false
  }
}

interface SettingsReadPort { get(key: string): unknown }
interface ExternalGamesPort { catalog?: unknown }

async function registerCoreIpc(options: Record<string, unknown> = {}) {
  const {
  ipcMain,
  getPanelCatalog,
  onPanelCatalogChanged,
  onPluginDisabled,
  onPluginPermissionsChanged,
  onPluginsActivated,
  // 插件贡献的 bang（`contributes.bangs` + `search.bang-provider` 插槽）的读取口。
  // 与 getPanelCatalog 同一套路：事实源只有 main.js 一处，本层不认识插件装配。
  getPluginBangs,
  // 用户插件目录（`userData/plugins`）的查询口，供「打开插件目录」入口用
  getUserPluginDir,
  // 插件安装器（社区市场的落盘那一半：体检 / 复制 / 解压 / 卸载）。
  // 它只碰文件，不认识注册中心 —— 两者的粘合在 ipc/plugins.js（装完 discover + enable）。
  pluginInstaller,
  // 插件源（社区市场的索引那一半：拉索引 / 下载 / 校验和）。同样只碰网络与文件，
  // 不碰注册中心；"装完 discover + enable" 仍由 ipc/plugins.js 统一收尾。
  pluginMarket,
  // 插件键值存储（`plugin_storage` 表）：插件开放 API 的持久化面。
  // 配额 / 隔离 / 自愈全部在 main/plugin-storage.js 里，IPC 层只做授权闸门 + 转发。
  pluginStorage,
  // 插件浮层宿主（PART18）：渲染侧点关闭 → 按**发送方窗口**摘记录并广播 hide。
  pluginOverlayHost,
  // 用户脚本：清单读取口（插件表面层）+ 单脚本启停的落盘口 + GM 代理运行时。
  // 三者分开注入：IPC 层只转调，不认识"脚本键怎么拼"或"脚本从哪读"。
  getPluginSurfaces,
  setUserScriptDisabled,
  userscriptRuntime,
  // 卸载后清掉三份持久化痕迹（disabled / autoDisabled / grantedPermissions）。
  // 不清的话，同一个 id 被重新安装时会立刻沿用上次的状态（"刚装好就是关着的"）。
  onPluginUninstalled,
  // 扫码浮框（可拖动取景框）的开 / 关 / 当前矩形 —— 抓帧据此裁剪
  qrScanFrame,
  onMenuSlotItems,
  slotRenderer,
  // 扩展点调度器（进程级单例，由 main.js 创建）。IPC 层用它给**域宿主**接线：
  // 搜索聚合 / 历史过滤 等插槽要在数据流里执行，而数据流的交汇点就在 IPC handler。
  extensionPoints,
  // 贡献注册表（进程级单例）：声明式贡献（`contributes.*`）的读取口。
  // 目前给书签导入用 —— 导入格式清单取的是**声明侧**，不必执行插件代码。
  contributions,
  layoutCoordinator,
  layoutService,
  tabManager,
  providerRegistry,
  bookmarkService,
  notesService,
  // 集锦图片资产基础设施（P2）：转给 registerNotesIpc 的四条资产路由（见 main/notes-assets.js）。
  notesAssets,
  /**
   * 集锦「打开视图」补发口：`(windowId) => payload|null`，由 main.js 注入
   * （pending 槽在 main/note-actions.js）。面板挂载后拉取一次，见 ipc/notes.js 的说明。
   */
  takeNoteOpenView,
  totpService,
  // PWA 域（把站点安装为应用）：域服务 + 探测 / 安装 / 快捷方式编排。
  // P4（应用窗口）、P6（更新 / 卸载）的端口随后接入；缺席时注册器只跳过对应路由。
  pwaService,
  pwaDetector,
  pwaInstaller,
  pwaShortcuts,
  pwaRuntime,
  pwaUpdater,
  pwaUninstaller,
  // 图标 URL 的唯一真源（`hira-pwa://`）+ 当前 profile 解析：管理页要把图标画出来，
  // 但绝不能自己拼协议串（见 ipc/pwa.js#enrichApp）。
  pwaPaths,
  getProfileId,
  historyService,
  downloadService,
  downloadController,
  /** `() => downloadController`：控制器随 profile 切换重建，IPC 必须按调用时刻取当前实例。 */
  getDownloadController,
  extensionService,
  /**
   * identity 桥的两个端口（main.js 注入）：
   *   · `resolveExtensionServiceBySession(session)` —— 按**发送方会话**找到该 profile 的
   *     扩展服务（identity 的 token 缓存按 profile 隔离，绝不能跨会话串用）；
   *   · `listExtensionServices()` —— 注册时补挂已加载会话的 MV3 worker 通道。
   * 两者都由 main.js 提供，注册器不认识 profile 模型。
   */
  resolveExtensionServiceBySession,
  listExtensionServices,
  emit,
  // 窗口级事件出口（只发给发起它的那个窗口）：space:window-changed 等
  emitToWindow,

  // 功能面可用性查询（§10.4）：`(featureId) => boolean`，由 main.js 注入。
  // 注入而非 import feature-map：注册器保持"纯路由 + 纯服务调用"，不持有插件注册中心
  // （与 getPanelCatalog / getPluginRegistry 同一套路 —— 事实源只有 main.js 一处）。
  isFeatureOn,
  permissionService,
  // 权限请求归属端口（APPS 层注入）：把 domain 的 pending 列表补上 windowId/tabId，
  // 并按「当前窗口」过滤。注册器与 DOMAIN 都不感知窗口模型。
  permissionPendingFilter,
  passwordService,
  searchService,
  // 即时答案（F-0771~F-0773）：出网与解析都在主进程，渲染层只拿中立事实；
  // 与 searchService（纯本地毫秒级）分通道，避免网络拖住本地建议。
  instantAnswerService,
  settingsService,
  // OOBE 首次启动引导：状态与窗口编排的控制器（main.js 注入）。
  // 「是否已完成引导」只在这里判定，路由层不复制版本号逻辑。
  onboarding,
  // 浏览器一键迁移（Chrome / Edge → Hira）：编排服务在 main.js 建好后注入
  //（见 main/import/index.js）。路由层只转发，不感知任何浏览器差异。
  browserImport,
  // 自动化（D2 命令链 + D3 手势）：控制器在 main.js 建好后注入（见 main/automation.js）。
  automation,
  // 网页翻译（C3）：引擎在 main.ts 建好（插件插槽 + 在线来源故障切换），见 main/translate.ts。
  translateService,
  // Break Mode（D5）：番茄钟状态机在 main.js 建好后注入（见 main/break-mode.js）。
  breakMode,
  // 主题域三件套（main.js 注入）：主题状态源 / 发布出口 / token 引擎。
  themeService,
  themeRuntime,
  themeManager,
  /** 主题调度器：只用来在"改了调度配置"后立刻重判一次。 */
  themeScheduler,
  /**
   * 主题包资产的两个口（`{ url(pluginId, rel), read(pluginId, rel) }`）。
   * URL 形状的唯一真源在 `plugin-protocol.js`；读取用于导出时把背景图带进包。
   * 由 main.js 注入 —— 主题域不认识协议，也不该认识。
   */
  themePluginAssets,
  /**
   * **用户主题**的图片资产库（`{ importFile(src), read(key), urlFor(key) }`）——
   * 「选择背景图片」把它拷进去、导出时再从它读出来。与 `themePluginAssets` 分成两口：
   * 两者的安全边界不同（一个能下发代码、一个只发图片），见 theme-asset-protocol.js。
   */
  themeAssets,
  profileService,
  spaceService,
  sessionService,
  // 「上次关闭」：启动时归档的只读副本（同目录 last-closed.json）。
  lastClosedSessionService,
  // 配置档案归档引擎（G1/G2）：导出/导入两条动作路由转调它；引擎在 main.js 装配。
  profileArchive,
  // 设置页与 AI 共用的动作型设置执行面；IPC 不复制业务实现。
  settingsActions,
  // 空间归档引擎（导出 / 导入）：同上，main.js 装配。
  spaceArchive,
  // 分享 / 二维码（N15）的生成服务。
  shareService,
  // 命名会话（N14）引擎。
  namedSessions,
  // 支付卡 / 地址保管库（N7）。
  formFillVault,
  getSessionDir,
  keybindings,
  switchProfile,
  onProfileRemoved,
  switchSpace,
  getUsingSpace,
  destroySpaceTabs,
  externalGames,
  bookmarkBackup,
  openSubWindowByType,
  snapshotService,
  getSession,
  webContentsManager,
  getAppMetrics,
  getAppInfo,
  // 软件更新服务（post-ipc 阶段创建）—— getter：调用时刻解析，不固定对象值。
  getUpdateService,
  openExternalPermissions,
  isCrashReporterEnabled,
  getCrashReports,
  getCertificateErrors,
  onSpacesChanged,
  httpAuth,
  openBrowserWindow,
  listBrowserWindows,
  moveTabToWindow,
  runtimeRegistry,
  getPluginRegistry,
  printService,
  // 「文件拖入窗口」的执行层（main/file-open/service.js）。按窗口归属仍由
  // 下面注入的 tabManagerForIpc（scoped 代理）决定，这里只是应用级单例服务。
  fileOpenService,
  // 面板换宿主裁决者（main/panel-presentation.js）—— 应用级单例，main.js 装配。
  panelPresentation
  } = options
  const registry = runtimeRegistry as WindowRuntimeRegistry | null
  const emitEvent = emit as EventEmit
  const { IPC_ROUTES, IPC_EVENTS } = await import('@hira-ng/shared-types/src/ipc-channels.mjs')
  const rawTypedMain = createTypedIpcMain(ipcMain, {
    authorize: ipcRoutePolicy.authorizeInvoke
  }) as TypedIpcMain
  const schemas = ipcSchemas

  // 扩展服务必须按**调用时刻**解析：profile 切换会重建 extensionService
  // （main.js 里 `extensionService = await getOrCreateExtensionService(...)`），
  // 若在这里把对象值固定下来，切换后所有扩展 IPC（列表 / 图标 / 弹窗 / 设置）
  // 都会打到已销毁的旧服务上。main.js 传 getter 时直接用；传值时包一层兼容。
  const resolveExtensionService = typeof extensionService === 'function'
    ? extensionService
    : () => extensionService

  // ── 窗口感知 IPC 路由（多窗口第三步）──────────────────────────────────────
  // 把每个 invoke handler 包在「本次调用来自哪个 sender」的异步上下文里，
  // 这样下面注入的 tabManager / layoutCoordinator / webContentsManager
  // 都能按发送方解析到**对应窗口**的那一份。
  //
  // 为什么可以放心：解析不出窗口时（子窗口、启动期、定时器）一律回退 primary，
  // 而当前只有一个浏览器窗口 —— 因此这一步在单窗口下行为与改造前**完全一致**。
  //
  // 只用 typedMain 承接：用 ipcMain.on 注册的裸通道不进入上下文（见注册表的边界说明）。
  const typedMain: TypedIpcMain = {
    scope: rawTypedMain.scope,
    handle(route: string, definition: IpcHandlerDefinition): string {
      return rawTypedMain.handle(route, {
        ...definition,
        handler: (event, req) => {
          const sender = event && typeof event === 'object' && 'sender' in event ? event.sender : null
          const run = (): unknown => definition.handler(
            event,
            ipcRoutePolicy.normalizeInvokeRequest(event, route, req) as typeof req
          )
          return registry ? registry.runWithSender(sender, run) : run()
        }
      })
    }
  }

  /**
   * IPC 层的插槽调用器 —— 给**域宿主**接线用的。
   *
   * 为什么 IPC 层是这些插槽的宿主：`search.suggestion-provider`（往建议里加料）、
   * `history.search-filter`（串行过滤历史）这类插槽，执行点必须在**数据流交汇处** ——
   * 也就是 handler 里：域服务出结果 → 插槽改写 → 回渲染层。
   * 放在域层是错的（domain 不该认识扩展点，分层不允许），放在渲染层也不行
   * （那批数据本来就不过渲染层）。
   *
   * 错误策略见 slot-call.js：**插槽的错绝不上抛**。一个 Mod 的过滤器写坏了，
   * 用户该看到的是"少几条过滤"，不是"搜索用不了"。
   */
  const slotCaller = createSlotCaller(extensionPoints, { label: 'ipc' })

  /**
   * 裸通道（`ipcMain.on`）也纳入「按发送方解析」上下文。
   *
   * ── 为什么必须（这是多窗口串台最隐蔽的一条）────────────────────────
   * 浮层 show/hide/display、`shell:focus` 这些是**单向 fire-and-forget** 通道，
   * 走的是 `ipcMain.on`；而它们下面用的 layoutCoordinator 是 `scoped(...)` 代理 ——
   * 代理按 AsyncLocalStorage 里的 sender 解析窗口，**裸通道从不进入该上下文**，
   * 于是 `current()` 一律回退主窗口：
   *   · 在窗口 B 打开总览浮层/建议下拉 → 浮层（含铺满整窗的 overview-overlay）
   *     出现在窗口 A 上，A 被盖住且点不动；
   *   · 在窗口 B 聚焦地址栏 → 反复把焦点交给 A 的外壳。
   * 用户感受就是「B 没有自主权、A 被夺走显示权」。
   *
   * 这些通道是**同步**回调（或 fire-and-forget 的异步），`runWithSender` 的同步包装
   * 足以让作用域在整个回调（及其派生的 Promise 链）内正确传播。
   * 注册器侧无需任何改动，也不需要各自手写一遍 `e.sender` 解析。
   */
  const senderScopedIpcMain = registry ? registry.scopeRawIpcMain(ipcMain as IpcMain) : ipcMain

  // 注入口径：这四个是「按窗口」的状态，必须走 scoped 代理而不是直接注入实例。
  // 非按窗口的东西（settings/bookmark/history/extension 等应用级服务）保持原样。
  //
  // ⚠ 命名：这四个名字已在函数签名里解构过，**不能重复声明**，因此按窗口版本
  // 统一加 `ForIpc` 后缀承载，原参数仅作为「无注册表时的回落值」使用。
  const scoped = registry ? registry.scoped.bind(registry) : null
  const tabManagerForIpc = (scoped ? scoped<TabManagerIpcPort>('tabManager') : tabManager) as TabManagerIpcPort | null
  const layoutCoordinatorForIpc = scoped ? scoped('layoutCoordinator') : layoutCoordinator
  const webContentsManagerForIpc = scoped ? scoped('webContentsManager') : webContentsManager
  // 密码浮层控制器的 hideTransient / generatePassword 由注册器通过 runtimeRegistry.provide
  // 注入到**每个窗口**（含之后新开的）；这里不再需要 scoped 代理。
  // 拖动落点预览会话：begin 来自「拖动发起方所在的窗口」，end 必须在**同一个窗口**上收尾
  //（否则 A 窗口起表、B 窗口停表 —— 那条 30fps 采样表就永远停不下来）。
  // 没有按窗口注册表时（单窗口降级）为 null：ipc/tabs.js 会退化成只走既有那条 dragend 探测路径。
  const tabDropZoneForIpc = scoped ? scoped('tabDropZone') : null
  // 分屏工具条：命令来自「工具条浮层所在的窗口」，必须落到同窗口的控制器上
  //（否则 B 窗口点的按钮会去操作 A 窗口的分屏）。没有按窗口注册表时（单窗口降级）为 null：
  // ipc/tabs.js 收到命令直接丢弃 —— 不出现"点了没反应还静默"以外的副作用。
  const splitToolbarForIpc = scoped ? scoped('splitToolbar') : null
  // JS 对话框（应用内浮层）：应用级确认框（「关闭多个标签页」）必须挂在**发起窗口**上，
  // 因此同样走 scoped 代理 —— runtime.jsDialogManager 由窗口装配时写入（browser-window-assembly）。
  const jsDialogManagerForIpc = scoped ? scoped('jsDialogManager') : null
  // 独立侧栏：它是**按窗口**的（每窗口一个侧栏视图 + 自己的导航状态），
  // 所以打开 / 收起 / 命令都必须落到「发命令那个窗口」那一份上。
  const webSidebarForIpc = (scoped ? scoped('webSidebar') : null) as WebSidebarIpcPort | null

  registerLayoutIpc(typedMain, {
    routes: IPC_ROUTES,
    schemas: schemas.layout,
    getPanelCatalog,
    layoutCoordinator: layoutCoordinatorForIpc,
    ipcMain: senderScopedIpcMain,
    // 「在标签页打开」「把当前页放上侧栏」要落到**发命令那个窗口**的 TabManager
    //（拿 scoped 代理，不直接注入实例）
    getTabManager: () => tabManagerForIpc,
    getWebSidebar: () => webSidebarForIpc
  })
  registerTabsIpc(typedMain, { routes: IPC_ROUTES, schemas: schemas.tabs, tabManager: tabManagerForIpc, providerRegistry, settingsService, tabDropZone: tabDropZoneForIpc, splitToolbar: splitToolbarForIpc, ipcMain: senderScopedIpcMain, getJsDialogManager: () => jsDialogManagerForIpc })
  // 面板换宿主：裁决在 main/panel-presentation.js，这里只接线。
  // 没有 panelPresentation（降级/单窗口外的旧装配路径）时不注册 —— 前端会拿到
  // "无此通道"，而不是一个永远 ok:false 的假实现。
  if (panelPresentation) {
    registerPanelTransferIpc(typedMain, { routes: IPC_ROUTES, schemas: schemas.layout, panelPresentation })
  }
  // 文件拖入：preload 上报 → 本窗口新标签 / 系统默认（见 main/file-open/）。
  // tabManager 用 scoped 代理：AsyncLocalStorage 会跨 openPaths 里的 await 传播，
  // 所以即使 stat 完才开标签，落点仍是**发起拖放的那个窗口**。
  registerFilesIpc(typedMain, { routes: IPC_ROUTES, schemas: schemas.files, tabManager: tabManagerForIpc, fileOpenService })
  registerBookmarkIpc(typedMain, { routes: IPC_ROUTES, schemas: schemas.bookmarks, bookmarkService, providerRegistry, slots: slotCaller, contributions })
  // 集锦：note:capture 落库后要给网页卡异步补缩略图 → 需要"按发送方解析"的 tabManager
  //（scoped 代理：面板按钮 / 标签右键各自落到**发起那个窗口**的活动标签，见 ipc/notes.js）。
  registerNotesIpc(typedMain, { routes: IPC_ROUTES, schemas: schemas.notes, notesService, providerRegistry, notesAssets, tabManager: tabManagerForIpc, takeOpenView: takeNoteOpenView })
  registerTotpIpc(typedMain, { routes: IPC_ROUTES, schemas: schemas.totp, totpService, providerRegistry })
  registerPwaIpc(typedMain, senderScopedIpcMain, {
    routes: IPC_ROUTES,
    schemas: schemas.pwa,
    pwaService,
    pwaDetector,
    pwaInstaller,
    pwaShortcuts,
    pwaRuntime,
    pwaUpdater,
    pwaUninstaller,
    pwaPaths,
    getProfileId,
    providerRegistry,
    authorizeWebPreloadSender: isWebPreloadIpcSender,
    // `pwa:prepare` / `pwa:candidate` 要按发起方解析「哪个窗口的哪个标签」
    runtimeRegistry
  })
  registerHistoryIpc(typedMain, { routes: IPC_ROUTES, schemas: ipcSchemas.history, historyService, providerRegistry, slots: slotCaller })
  registerDownloadIpc(typedMain, { routes: IPC_ROUTES, schemas: ipcSchemas.downloads, downloadService, downloadController, getDownloadController, providerRegistry })
  registerExtensionIpc(typedMain, {
    routes: IPC_ROUTES,
    schemas: schemas.extensions,
    extensionService: resolveExtensionService,
    providerRegistry,
    // 扩展选项页落在新标签页：必须按**发送方窗口**解析标签条，
    // 否则多窗口下会开在错误的窗口（与其它按窗口域同一口径）。
    openTab: (url: string) => tabManagerForIpc?.newTab({ url }),
    getActiveWebContents: () => tabManagerForIpc?.getActiveWebContents(),
    // 扩展弹窗要把「面板 / 浮层里的按钮矩形」换算成窗口内容区坐标 —— 偏移按发送方
    // 视图查，因此同样要按窗口解析那一份 layoutCoordinator（scoped 代理）。
    layoutCoordinator: layoutCoordinatorForIpc
  })
  const stopExtensionRelay = createExtensionEventRelay(resolveExtensionService, {
    emit,
    eventChannel: IPC_EVENTS.extensionChanged,
    events: IPC_EVENTS,
    schema: schemas.extensions.change,
    // 内容拦截状态走独立事件：blocker 的过滤列表是后台异步就绪的，
    // 渲染层启动时读到的必然是 false，必须靠这条推送把盾牌图标纠正过来。
    adblockerSchema: schemas.extensions.adblockerChange,
    listServices: listExtensionServices
  })
  // chrome.identity：扩展页面走全局 handle，MV3 worker 走每 worker 的 ipc.handle。
  // 两条路都在注册器内部按**发送方**校验扩展 id 与 profile 会话，见该文件头说明。
  const identityIpc = registerIdentityIpc({
    ipcMain,
    resolveExtensionServiceBySession,
    listExtensionServices
  })
  registerKeybindingsIpc(typedMain, { routes: IPC_ROUTES, schemas: ipcSchemas.keybindings, keybindings, providerRegistry })
  registerPasswordIpc(typedMain, { routes: IPC_ROUTES, events: IPC_EVENTS, schemas: schemas.passwords, passwordService, layoutCoordinator: layoutCoordinatorForIpc, tabManager: tabManagerForIpc, providerRegistry, settingsService, isFeatureOn, runtimeRegistry })
  registerPermissionIpc(typedMain, { routes: IPC_ROUTES, schemas: ipcSchemas.permissions, permissionService, pendingFilter: permissionPendingFilter, providerRegistry })
  // 自定义 Bang 的 CRUD 变更复用 `settings:changed` 通道（key = search.custom_bangs）：
  // search-controller 已订阅该事件并重拉 search:config，地址栏建议因此热更新。
  registerSearchIpc(typedMain, {
    routes: IPC_ROUTES,
    schemas: ipcSchemas.search,
    searchService,
    instantAnswer: instantAnswerService,
    providerRegistry,
    slots: slotCaller,
    automation,
    unifiedSearch: options.pageLibrary,
    // 删除「当前默认」的自定义引擎时要把 `search.default_engine` 写回 google，
    // 否则重启后 applyDefault 会拿着一个已不存在的 id 空转。
    settingsService,
    // 插件 bang：随 `search:config` 一起下发（声明式 + `search.bang-provider` 插槽）。
    getPluginBangs,
    notifyChange: (change: unknown) => emitEvent('settings:changed', change)
  })
  registerAutomationIpc(typedMain, { routes: IPC_ROUTES, schemas: ipcSchemas.automation, automation })
  registerTranslateIpc(typedMain, {
    routes: IPC_ROUTES,
    schemas: ipcSchemas.translate,
    translateService,
    settingsService
  })
  registerBreakIpc(typedMain, { routes: IPC_ROUTES, schemas: ipcSchemas.break, breakMode })
  registerSessionIpc(typedMain, { routes: IPC_ROUTES, schemas: schemas.session, sessionService, lastClosedSessionService, sessionTabPort: createSessionTabPort(tabManagerForIpc), providerRegistry, getSessionDir })

  if (settingsService) {
    // getSession：拼写检查的词典/可用语言挂在会话上（见 settings/ipc.js 的那三条路由）。
    registerSettingsIpc(typedMain, { routes: IPC_ROUTES, schemas: schemas.settings, settingsService, settingsRegistry, providerRegistry, slots: slotCaller, getSession })
  }

  // 主题域：与 Settings 同属"应用自身外观"，但状态源独立（theme-service）。
  // `installPluginFromPath` 走**晚绑定**：主题导入要把解出来的主题插件目录交给
  // 插件体系安装，而插件注册器在本函数更晚才跑（见下方 pluginsIpc 的赋值）。
  // 用可变的 holder 而不是重排顺序 —— 重排会动到几十个注册器的相对次序，风险大得多。
  const themePorts: { installFromPath: ((target: string, options?: unknown) => unknown) | null } = { installFromPath: null }
  registerThemeIpc(typedMain, {
    routes: IPC_ROUTES,
    themeService,
    themeRuntime,
    themeManager,
    scheduler: themeScheduler,
    settings: settingsService,
    // 私密窗口主题：读口要按**发起窗口**解析（新开的私密窗口只能主动问，收不到历史广播）。
    isIncognito: () => Boolean(registry && registry.currentOrNull() && registry.currentOrNull()?.incognito),
    // 主题包资产：URL 由协议层拼（同一份契约），读取用于导出时把背景图带进包
    pluginAssets: themePluginAssets,
    // 用户主题的图片资产库：选择图片（拷进来）与导出（读出去）都走它
    themeAssets,
    runAsProfile: (profileId: string, task: () => unknown) => registry ? registry.runWithProfile(profileId, task) : task(),
    installPluginFromPath: (target: string, opts?: unknown) => (typeof themePorts.installFromPath === 'function'
      ? themePorts.installFromPath(target, opts)
      : { ok: false, reason: '插件安装服务尚未就绪' })
  })

  registerNtpIpc(typedMain, { routes: IPC_ROUTES, schemas: schemas.ntp, settingsService, providerRegistry })

  // 主页 / 新标签页地址：壳层「主页」按钮与地址栏留空判据的唯一来源。
  // `isIncognito` 按**发起窗口**解析（与主题域同一口径）：无痕窗口的新标签页
  // 必须是内置页 —— 它的会话不加载扩展，扩展覆盖地址在那里打不开。
  registerHomeIpc(typedMain, {
    routes: IPC_ROUTES,
    schemas: schemas.home,
    settingsService,
    isIncognito: () => Boolean(registry && registry.currentOrNull() && registry.currentOrNull()?.incognito)
  })

  const externalGamesPort = externalGames as ExternalGamesPort | null
  if (externalGamesPort && externalGamesPort.catalog) {
    registerExternalGamesIpc(typedMain, { routes: IPC_ROUTES, schemas: schemas.externalGames, catalog: externalGamesPort.catalog, providerRegistry })
  }

  registerProfileIpc(typedMain, {
    routes: IPC_ROUTES,
    schemas: ipcSchemas.profile,
    profileService,
    switchProfile,
    onProfileRemoved,
    providerRegistry
  })
  // 空间列表变更的唯一出口（CRUD + 导入共用）：
  //   · `onSpacesChanged()` → 原生「空间」子菜单重建；
  //   · 应用级 `space:changed` 广播 → 所有 renderer 重拉列表。
  const notifySpaceChanged = createSpaceChangeNotifier({
    emit,
    events: IPC_EVENTS,
    onSpacesChanged
  })
  registerSpaceIpc(typedMain, {
    routes: IPC_ROUTES,
    schemas: ipcSchemas.space,
    spaceService,
    switchSpace,
    getUsingSpace,
    profileService,
    // 空间「当前使用中」的推送是**窗口级**的（见 ipc/space.js）：只发给发起方窗口，
    // 不能广播 —— 否则 B 切空间会让 A 的切换器跟着跳。
    emitToWindow,
    destroySpaceTabs,
    events: IPC_EVENTS,
    providerRegistry,
    notifySpaceChanged
  })
  // 空间导出 / 导入：对话框薄壳 + 归档引擎；引擎未装配时注册器自身安全跳过。
  registerSpaceArchiveIpc(typedMain, {
    routes: IPC_ROUTES,
    schemas: ipcSchemas.space,
    spaceArchive,
    spaceService,
    notifySpaceChanged
  })
  registerWindowIpc(typedMain, {
    routes: IPC_ROUTES,
    events: IPC_EVENTS,
    schemas: schemas.window,
    openSubWindowByType,
    openBrowserWindow,
    listBrowserWindows,
    moveTabToWindow,
    // 面板里的右键菜单要把「视图内坐标」换算成窗口内容区坐标 —— 偏移按发送方
    // 视图查，因此按窗口解析那一份 layoutCoordinator（scoped 代理，与 extensionIpc 同口径）。
    layoutCoordinator: layoutCoordinatorForIpc,
    // 菜单类插槽（bookmark.context-menu…）：把插件贡献的菜单项编译成原生菜单项。
    // 由主进程自己追加到模板尾部，onSelect 在主进程内派发（不往渲染层往返）。
    menuSlotItems: onMenuSlotItems
  })
  registerBookmarkBackupIpc(typedMain, { routes: IPC_ROUTES, schemas: schemas.bookmarkBackup, bookmarkBackup, providerRegistry })
  // 渲染侧插槽宿主：渲染层只能经这两个白名单通道间接使用插槽（拿不到调度器本身）
  registerSlotsIpc(typedMain, { routes: IPC_ROUTES, schemas: schemas.slots, slotRenderer })
  // 独立小域（与 layout / tabs 无耦合）
  registerSnapshotIpc(typedMain, { routes: IPC_ROUTES, schemas: schemas.snapshot, snapshotService })
  // 标签内存：hover 预览用。与任务管理器同一份数值口径（见 ipc/tab-memory.ts）。
  // 按**发送方窗口**解析 WebContentsManager —— 多窗口下预览属于某个窗口，
  // 它的标签在那个窗口的视图表里（与 page.info 同一口径）。
  registerTabMemoryIpc(typedMain, {
    routes: IPC_ROUTES,
    schemas: schemas.tabMemory,
    getAppMetrics,
    webContentsManager: webContentsManagerForIpc
  })
  // 屏幕抓帧：实现在 `qr-scanner` 插件的能力里（`qr.captureScreen`），
  // 这里只是把它接上一条窄通道，并把「可拖动取景框」的当前位置一并交给它
  // （见 ipc/screen.js 里"三种东西的归属"）。
  registerScreenIpc(typedMain, { routes: IPC_ROUTES, schemas: schemas.screen, providerRegistry, qrScanFrame, events: IPC_EVENTS, emit })
  // 按钮编辑模式：开关走 invoke（需要返回值）；几何上报走单向 send。
  // 两者都按发送方解析窗口 —— 浮层与「外壳/rail 上报」必须落在同一个窗口上。
  registerButtonsEditIpc(typedMain, senderScopedIpcMain, {
    routes: IPC_ROUTES,
    schemas: schemas.buttonsEdit,
    events: IPC_EVENTS,
    layoutCoordinator: layoutCoordinatorForIpc,
    emit,
    emitToWindow
  })
  registerLayoutDocumentIpc(typedMain, {
    routes: IPC_ROUTES,
    schemas: schemas.layoutDocument,
    events: IPC_EVENTS,
    layoutService,
    emitToWindow
  })
  // ── chrome 级瞬态能力的「操作」通道（查找栏 / 缩放条）──
  // 两者都是**按窗口**的能力（作用于本窗口活动标签的 webContents），且发送方都是
  // 住在该窗口里的独立视图（查找栏浮层 / 缩放条浮层）—— `BrowserWindow.fromWebContents`
  // 对 WebContentsView 成立，因此都走 scoped 代理按发送方解析到所属窗口的那一份。
  // 悬停 URL 不需要操作通道：它只有"主进程 → 浮层"一个方向（见 tabEvents 的
  // onTargetUrl 钩子），没有"浮层 → 主进程"的诉求。
  registerFindIpc(typedMain, senderScopedIpcMain, {
    routes: IPC_ROUTES,
    findInPage: scoped ? scoped('findInPage') : null
  })
  registerZoomIpc(typedMain, senderScopedIpcMain, {
    routes: IPC_ROUTES,
    zoom: scoped ? scoped('zoom') : null
  })
  // 站点数据 / 浏览数据 / 进程指标 / 页面信息
  registerCookieIpc(typedMain, { routes: IPC_ROUTES, schemas: schemas.cookies, getSession })
  registerBrowsingDataIpc(typedMain, {
    routes: IPC_ROUTES,
    schemas: schemas.browsingData,
    getSession,
    historyService,
    downloadService
  })
  registerAppMetricsIpc(typedMain, {
    routes: IPC_ROUTES,
    schemas: schemas.app,
    getAppMetrics,
    tabManager,
    webContentsManager
  })
  registerPageIpc(typedMain, { routes: IPC_ROUTES, schemas: schemas.page, tabManager: tabManagerForIpc, webContentsManager: webContentsManagerForIpc })
  registerPrintIpc(typedMain, { routes: IPC_ROUTES, schemas: schemas.print, printService })
  registerCaptureIpc(typedMain, { routes: IPC_ROUTES, schemas: schemas.captureEditor })
  registerAppInfoIpc(typedMain, { routes: IPC_ROUTES, schemas: schemas.app, getAppInfo })
  // 软件更新：getter 注入（服务在 post-ipc 阶段才创建，不能固定对象值）。
  registerUpdateIpc(typedMain, { routes: IPC_ROUTES, schemas: schemas.update, getUpdateService })
  // 默认浏览器：无需注入任何服务，直接问 Electron（app.isDefaultProtocolClient 等）。
  registerDefaultBrowserIpc(typedMain, { routes: IPC_ROUTES, schemas: schemas.app })
  registerPasskeyIpc(typedMain, {
    routes: IPC_ROUTES,
    schemas: schemas.passkey,
    passkeys: options.passkeys
  })
  registerCaptureHubIpc(typedMain, {
    routes: IPC_ROUTES,
    schemas: schemas.captureHub,
    captureHub: options.captureHub
  })
  registerPageLibraryIpc(typedMain, {
    routes: IPC_ROUTES,
    schemas: schemas.pageLibrary,
    pageLibrary: options.pageLibrary,
    notesService
  })
  // 引导窗口：控制器缺席时注册器自身安全跳过（与 profile-archive 同一纪律）。
  registerOnboardingIpc(typedMain, { routes: IPC_ROUTES, schemas: schemas.onboarding, onboarding })
  // 浏览器一键迁移：OOBE 导入屏与导入数据页共用同一份检测结果。
  registerBrowserImportIpc(typedMain, {
    routes: IPC_ROUTES,
    schemas: schemas.browserImport,
    browserImport
  })
  // 配置档案导出 / 导入（G1 / G2）：对话框 + 归档引擎；引擎未装配时注册器自身安全跳过。
  registerProfileArchiveIpc(typedMain, {
    routes: IPC_ROUTES,
    schemas: schemas.app,
    profileArchive,
    profileService,
    settingsActions
  })
  // 分享 / 二维码（N15）：一条只读路由（文本 → SVG）。
  registerShareIpc(typedMain, { routes: IPC_ROUTES, schemas: schemas.app, shareService })
  // 命名会话 / 会话模板（N14）：存 / 列 / 恢复 / 删。
  registerNamedSessionsIpc(typedMain, { routes: IPC_ROUTES, schemas: schemas.session, namedSessions })
  // 支付卡 / 地址保管库（N7）：列（摘要）/ 增 / 删 / 显式揭示 / 填充候选。
  // `isEnabled` 读「表单自动填充」开关 —— 关掉时连候选都不给（连"有数据"都不该暴露）。
  registerFormFillIpc(typedMain, {
    routes: IPC_ROUTES,
    schemas: schemas.app,
    formFillVault,
    isEnabled: () => {
      const settings = settingsService as SettingsReadPort | null
      try { return settings && settings.get(PRIVACY_SETTING_KEYS.formAutofill) !== false } catch (_) { return false }
    }
  })
  // 外部协议授权记录：列出已允许项 / 撤销一项（记录在 domain-settings 里，见 main/open-external.js）
  if (openExternalPermissions) {
    registerOpenExternalIpc(typedMain, { routes: IPC_ROUTES, schemas: schemas.openExternal, openExternalPermissions })
  }
  registerCrashIpc(typedMain, { routes: IPC_ROUTES, schemas: schemas.crash, isCrashReporterEnabled, getCrashReports })
  const currentScopeKey = () =>
    `${registry?.currentProfileId() || 'default'}\n${registry?.currentSpaceId() || ''}`
  const siteSecurity = createSiteSecurity({
    getActiveWebContents: () => tabManagerForIpc?.getActiveWebContents(),
    getActiveTabId: () => tabManagerForIpc?.getActiveTabId() || null,
    getWebContents: (tabId: string) => tabManagerForIpc?.getWebContents(tabId),
    getScopeKey: currentScopeKey
  })
  registerCertificateIpc(typedMain, {
    routes: IPC_ROUTES,
    schemas: schemas.certificate,
    getCertificateErrors: () => {
      const scopeKey = currentScopeKey()
      const records = typeof getCertificateErrors === 'function' ? getCertificateErrors() : []
      return (records as Array<{ scopeKey?: unknown }>)
        .filter((record) => String(record.scopeKey || '') === scopeKey)
    },
    getSiteCertificates: () => siteSecurity.list(),
    continueSafeBrowsing: async (url: string, rawEvent: unknown) => {
      const event = rawEvent as {
        sender?: WebContents | null
        senderFrame?: { url?: unknown; detached?: unknown } | null
      }
      const sender = event && event.sender
      const frameUrl = event && event.senderFrame && event.senderFrame.detached !== true
        ? String(event.senderFrame.url || '')
        : ''
      if (!sender || sender.isDestroyed() || !isSecurityWarningUrl(frameUrl)) return { ok: false }
      const warningTarget = targetUrlOfSecurityWarning(frameUrl)
      let requestedUrl = ''
      try { requestedUrl = new URL(url).href } catch { return { ok: false } }
      if (requestedUrl !== warningTarget) return { ok: false }

      let tabId = ''
      try {
        const resolveTabId = tabManagerForIpc && typeof tabManagerForIpc.getTabIdByWebContents === 'function'
          ? tabManagerForIpc.getTabIdByWebContents
          : null
        tabId = String(resolveTabId ? resolveTabId(sender) || '' : '')
      } catch {}
      if (tabId) {
        if (!consumeSafeBrowsingWarning(tokenOfSecurityWarning(frameUrl), requestedUrl)) return { ok: false }
        try {
          await tabManagerForIpc?.navigate({ tabId, url: requestedUrl })
          return { ok: true }
        } catch {
          return { ok: false }
        }
      }
      const sidebar = webSidebarForIpc
      let ownsSidebar = false
      try {
        ownsSidebar = Boolean(sidebar && typeof sidebar.owns === 'function' && sidebar.owns(sender))
      } catch {}
      if (sidebar && ownsSidebar) {
        if (!consumeSafeBrowsingWarning(tokenOfSecurityWarning(frameUrl), requestedUrl)) return { ok: false }
        try { return { ok: sidebar.open(requestedUrl).open === true } } catch {
          return { ok: false }
        }
      }
      return { ok: false }
    }
  })
  // 当前站点安全状态：按 IPC 发送方解析到对应窗口的活动标签（scoped 代理），
  // 也允许证书页显式指定来源标签，因此窗口 B 打开浮层拿到的证书不会串到窗口 A。
  registerSiteSecurityIpc(typedMain, {
    routes: IPC_ROUTES,
    schemas: schemas.certificate,
    getSiteSecurity: (req: unknown) => siteSecurity.read(req),
    canReadRequestedTab: isCertificatePageSender
  })
  registerHttpAuthIpc(typedMain, { routes: IPC_ROUTES, schemas: schemas.httpAuth, httpAuth })
  // Harness 插件中心（part of PART7 §7.9）：只读清单 + 启停。
  // emit 走登记制广播 —— 谁订阅了 plugins:changed 谁收得到（含住在标签页里的内部页）。
  const pluginsIpc = registerPluginsIpc(typedMain, {
    routes: IPC_ROUTES,
    schemas: schemas.plugins,
    events: IPC_EVENTS,
    getPluginRegistry,
    // 面板目录变动后的全局对账（关掉并销毁已失效的面板视图），由 main.js 实现
    onPanelsChanged: onPanelCatalogChanged,
    // 插件启停后 → 落盘"用户主动禁用"意图（启用失败不落盘，见 plugin-state-store.js）
    onPluginDisabled: onPluginDisabled,
    // 第三方插件授权结果 → 落盘（键 plugins.grantedPermissions）。
    // 不落盘的话每次重启都会把已同意的插件打回"等待授权"，用户会以为授权没生效。
    onPluginPermissionsChanged,
    // 插件**启用成功**之后 → 执行它贡献的 schema 迁移（`db.schema.migration`）。
    // 少了这一条，用户装完插件点开关后，插件的表要等到下次重启才存在。
    onPluginsActivated,
    // 用户插件目录（`userData/plugins`）——「打开插件目录」入口要用它。
    // 由 main.js 注入而非在这里拼路径：应用目录的解析只该有一处。
    getUserPluginDir,
    // 安装 / 卸载（社区市场）：安装器只碰文件，装完由 registerPluginsIpc 负责
    // `discover()` + `enable()`，卸载则是"先停用再删文件"。
    pluginInstaller,
    pluginMarket,
    pluginStorage,
    pluginOverlayHost,
    onPluginUninstalled,
    getPluginSurfaces,
    setUserScriptDisabled,
    userscriptRuntime,
    emit
  })
  // 主题导入用的安装入口（晚绑定落地）。
  themePorts.installFromPath = pluginsIpc.installFromPath

  return {
    typedMain,
    stopExtensionRelay,
    /**
     * 「让 identity 桥认识这个会话」—— profile 切换会为**新 profile** 建扩展服务，
     * 它的 MV3 worker 需要补挂通道。main.js 在 `getOrCreateExtensionService` 里调用
     * （晚于本文件注册的用返回值，注册前的由 `listExtensionServices` 补挂）。
     */
    attachIdentitySession: identityIpc.attachSession,
    detachIdentitySession: identityIpc.detachSession,
    notifyPluginsChanged: pluginsIpc.notifyChanged,
    /**
     * 插件启停的**唯一实现**（依赖级联 / 落盘 / 面板对账 / 贡献面刷新都在里面）。
     * main.js 把它回填给 `getDomainServices().pluginHost`，AI 的 `plugin_toggle`
     * 因此与插件中心页面的开关**走同一条路径**。
     */
    setPluginEnabled: pluginsIpc.setPluginEnabled,
    /**
     * AI 工作室的三个端口（plugins.js 里的具名实现）：
     *   · `installFromPath`   —— 生成好的插件目录 → 与界面安装同一条链路
     *   · `uninstallPlugin`   —— 与界面卸载同一套级联停用 / 持久化清理
     *   · `installUserscript` —— 与界面导入同一套体检（含 @match 校验）
     * 只透传、不复制规则：少了任何一个，AI 就只能"写得出、装不上"。
     */
    installFromPath: pluginsIpc.installFromPath,
    uninstallPlugin: pluginsIpc.uninstallPlugin,
    installUserscript: pluginsIpc.installUserscript,
    /**
     * 「某面板实际所在侧」变化 → 广播给**该窗口**的面板宿主（它据此把拖拽手柄放到
     * 面向内容的那条边）。事件名留在本文件（唯一拿到契约表的地方），main.js 拿到后
     * 注入到每个窗口的 LayoutCoordinator 上（见 browser-window-assembly）。
     * @param {string} panelId
     * @param {'left'|'right'|null} side null = 该面板已不在任何一侧
     * @param {boolean} [pinned] 该面板此刻是否在**钉住位**（决定宽度按哪个槽读写）
     * @param {number} [windowId]
     */
    emitPanelSideChanged: (panelId: string, side: 'left' | 'right' | null, pinned?: boolean, windowId?: number) => emitEvent(
      IPC_EVENTS.panelSideChanged,
      {
        panelId: String(panelId),
        side: side === 'left' || side === 'right' ? side : null,
        pinned: !!pinned
      },
      windowId ? { windowId } : undefined
    )
  }
}

export { registerCoreIpc }
