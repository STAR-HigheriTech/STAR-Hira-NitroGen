import type {
  BrowserWindow,
  ContextMenuParams,
  DownloadItem,
  Event as ElectronEvent,
  IpcMainInvokeEvent,
  Rectangle,
  Session,
  WebContents,
  WebPreferences
} from 'electron'
import type { BrowserWindowRuntime, KeybindingsPort, SharedWindowContext, SpaceIdentity } from './browser-window-assembly'

const { app, ipcMain, safeStorage, webContents, dialog } = require('electron')
const path = require('path')
const fs = require('fs')
const os = require('os')
const { fileURLToPath } = require('node:url')
const {
  WindowRegistry,
  createSubWindow,
  createSessionsController,
  defaultPreloadPath,
  createLoadedProfilesController,
  createQuitController,
  createSessionTabPort,
  // 标签截图内存仓库（对齐 RT tab-snapshot）：纯内存 + TTL/条数双淘汰
  createSnapshotStore,
  // 跨窗口标签同步（A5 / J15）：代际计数器 + 串行队列 + 截图占位（见 TabSync.js 文件头）
  createTabSync,
  // 阅读模式：注入式覆盖层（抽取正文 / 主题 / 字号 / 朗读）。
  // 与网页右键菜单「阅读模式」共用同一个入口，不新开窗口或面板。
  toggleReaderMode
  // 注：TabManager / createPictureInPicture / createMainWindow 已随「按窗口装配」
  // 收口到 ./browser-window-assembly —— 它们必须按窗口各建一份，
  // 故不再在 main.js 里构造。
} = require('@hira-ng/infra-window')
const { isTrustedIpcSender } = require('./ipc-sender-trust')
const { createFilePort } = require('@hira-ng/infra-fs')
// 本机命令执行端口（Bitwarden bw CLI 等外部管理器的唯一 IO 出口）。
// 域层通过注入使用它，自身不 require child_process。
const { createProcessRunner } = require('@hira-ng/infra-process')
const { createThemeManager } = require('@hira-ng/infra-theme')
// 主题系统三件套：目录与状态（theme-service）→ 调度（theme-schedule）→ 发布（theme-runtime）。
// 分层见 docs-ng/主题系统设计.md：颜色到令牌的唯一真源在 shared-types/src/theme.mjs。
const { createThemeService } = require('./theme-service')
const { createThemeScheduler } = require('./theme-schedule')
// 浏览器标识：UA 的清洗（preboot 用）+ Accept-Language 列表的组装（设置下发时用）。
// 同一份逻辑只有一处真源，避免 UA 说 Chrome、语言头却还是 Electron 默认值。
const { buildAcceptLanguages } = require('./user-agent')
// 数据库：单库（升级前）或按 profile 拆库（L2 物理独立）—— 两种模式同一个 provider。
const { createDbProvider } = require('@hira-ng/infra-db')
// 设置的全局键清单 + 全局文件名（PART16 §3.2 / §5 步骤 6 的**单一事实源**）
const { GLOBAL_SETTINGS_FILE } = require('@hira-ng/shared-types/src/settings-scope.mjs')
const { createL10n } = require('@hira-ng/infra-l10n')
const { createBookmarkService } = require('@hira-ng/domain-bookmark')
const { createNoteService } = require('@hira-ng/domain-notes')
const { createHistoryService } = require('@hira-ng/domain-history')
const { createDownloadService } = require('@hira-ng/domain-download')
const { createFaviconService } = require('@hira-ng/domain-favicon')
const { createPasswordService } = require('@hira-ng/domain-password')
// TOTP 域（2FA 验证器插件）：与笔记域同构的「域服务 + 能力插件」两段式
const { createTotpService } = require('@hira-ng/domain-totp')
// 本机密钥加密 provider（safeStorage 适配器）—— 由 infra 提供，各域共用同一个。
// 密码域与 TOTP 域都只是它的**使用者**，谁都不该通过自己去转出它（见该文件头注释）。
const { createSafeStorageCrypto } = require('@hira-ng/infra-secret')
const { createPermissionService } = require('@hira-ng/domain-permission')
const { createSearchService } = require('@hira-ng/domain-search')
const { createSettingsService, createProfileSettingsOverlay, SPACE_SCOPED_SETTING_KEYS } = require('@hira-ng/domain-settings')
// 书签栏显示策略真源（三态 + 归一化）。渲染层 import 同一份 .mjs，
// 保证「快捷键切档」与「渲染层判可见」用的是同一套取值口径。
const { BOOKMARKBAR_SETTING_KEY, normalizeBookmarkbarMode, toggleBookmarkbarMode } =
  require('@hira-ng/shared-types/src/bookmarkbar.mjs')
// 布局真源（键名 + 预设宏模板）：主进程的快捷键动作要按同一份写，不能各抄一遍。
const { LAYOUT_SETTING_KEYS: LAYOUT_KEYS, layoutPresetWrites } = require('@hira-ng/shared-types/src/layout.mjs')
// 事件通道名真源（跨窗口标签同步的占位推送要用；与外壳 `ngipc:event:<route>` 约定同源）
const { IPC_EVENTS } = require('@hira-ng/shared-types/src/ipc-channels.mjs')
// 调色板派生（强调色 / 明暗）：注入式浮层与 JS 对话框只从这里取色，不另算一套。
const { derivePalette, withAlpha, THEME_SETTING_KEYS } = require('@hira-ng/shared-types/src/theme.mjs')
// 内部页身份真源：应用菜单的页面入口动作一律用 pageUrl() 拼地址，不再手写 hira:// 字符串。
const { pageUrl } = require('@hira-ng/shared-types/src/pages.mjs')
// 菜单组合键真源：动作名 → 当前键位 → Electron accelerator（应用菜单只显示不注册）。
const { menuAccelerator } = require('@hira-ng/shared-types/src/keybindings.mjs')
// 启动 / 主页键名与模式取值真源（启动编排只认这里的值，不手写 app.startup_* 字面量）。
const { STARTUP_SETTING_KEYS, STARTUP_MODES } = require('@hira-ng/shared-types/src/startup.mjs')
// 无障碍键名 / 字号像素表真源（字体注入与 Chromium 辅助开关都从这里取）。
const {
  ACCESSIBILITY_SETTING_KEYS, ACCESSIBILITY_TOGGLE_KEYS, FONT_SIZE_PX
} = require('@hira-ng/shared-types/src/accessibility.mjs')
// PDF 内置阅读器开关键名真源。
const { PDF_SETTING_KEYS } = require('@hira-ng/shared-types/src/pdf.mjs')
// 标签页行为键名真源（自动画中画 / 跨窗口同步在标签运行单元与窗口焦点处现读）。
const { TABS_SETTING_KEYS } = require('@hira-ng/shared-types/src/tabs-settings.mjs')
const { PRIVACY_SETTING_KEYS } = require('@hira-ng/shared-types/src/privacy-settings.mjs')
const { createProfileService } = require('@hira-ng/domain-profile')
const { createSpaceService } = require('@hira-ng/domain-space')
const { createLayoutService } = require('@hira-ng/domain-layout')
const { createLayoutRepository } = require('./layout/layout-repository')
// 标签领域规则：TabManager 只声明端口，实现在 domain-tabs（分层规则不允许 infra → domain 反向依赖）
const { tabRules, tabAdjust, tabStacks, tabSplits, tabGroups } = require('@hira-ng/domain-tabs')
const { createExtensionService } = require('@hira-ng/infra-extensions')
// 扩展弹窗窗口编排（「打开插件 popup」的宿主；见文件内 createExtensionPopupController 注释）
const { createExtensionPopupController } = require('./extension-popup')
// 功能面 → 引擎插件 的映射（§10.4）。主进程侧也用它 —— 与渲染侧的 features:availability
// 端口**同源同一份表**，这样"界面上有没有那个入口"与"后端认不认这个请求"不会分叉。
const featureMap = require('./feature-map.js')
const { getAppRoot } = require('./app-root')
const { attachUiShellDiagnostics } = require('./ui-shell-diagnostics')
// 日志中心 / 面板数据面：AI 的「感知层」——日志给 app_logs，面板给 panel_read。
// 两者都是主进程单例，必须在这里（任何窗口 / 插件创建之前）建好，
// 否则首屏日志会漏采、AI 在启动早期读面板会拿到空。
const { createLogHub } = require('./log-hub')
const { createPanelData } = require('./panel-data')
const logHub = createLogHub({ capacity: 5000 })
// 立刻接管 console 与 app 生命周期：模块加载期之后的所有输出都进缓冲。
logHub.attachConsole(console)
logHub.attachApp(app)
const { registerCoreIpc } = require('./ipc-routes')
const { createPasskeyController } = require('./passkey')
// Cookie 明细 / 浏览数据清除 / 进程指标：这三个域的规则各有一份实现，
// IPC 路由与 AI 工具（cookies_* / browsing_data_clear / tasks_list）**共用同一份**
// —— 不在 AI 侧另写「怎么清、清哪些、内存取哪个字段」。
const { createCookiePort } = require('./ipc/cookies')
const { createDownloadOrganizer } = require('./download-organizer')
const { clearBrowsingData } = require('./ipc/browsing-data')
const { collectAppMetrics } = require('./ipc/app-metrics')
const { createBookmarkEventRelay } = require('./ipc/bookmark-events')
const { createNoteEventRelay } = require('./ipc/notes-events')
const { createTotpEventRelay } = require('./ipc/totp-events')
const { createHistoryEventRelay } = require('./ipc/history-events')
const { createFaviconEventRelay } = require('./ipc/favicon-events')
const { createThemeRuntime } = require('./theme-runtime')
// 原生应用菜单（对齐 RT app-menu-controller）：纯装配，动作与状态都由本文件注入
const { createAppMenu } = require('./app-menu')
// 应用动作面：给 appMenuActions 补元数据 + 唯一执行入口（AI 的「接管一切」从这里进来）
const { createAppActions } = require('./app-actions')
const { createProfileArchiveActions } = require('./ipc/profile-archive')
const { SETTINGS_ACTION_ROUTES } = require('./settings/actions')
const { applyDefaultBrowser } = require('./ipc/default-browser')
const { stripTrackingParams } = require('@hira-ng/shared-types/src/clean-url.mjs')
// 「关闭多个标签前确认」闸门：与 IPC 侧（ipc/tabs.js）共用同一份实现，
// 避免应用菜单与右键菜单各写一套、改设置后行为分叉。
const { createTabCloseGuard } = require('./tab-close-guard')
// 插件表面（pages / bangs / menus）：声明式贡献**唯一的装载与消费入口**，见该文件头
const { createPluginSurfaces } = require('./plugin-surfaces')
// 用户脚本宿主运行时：`@require` 取码 + `GM_xmlhttpRequest` 代理（特权只在这一处）
const { createUserScriptRuntime } = require('./userscript-runtime')
// 静态资产直吐（hira:// 内置页 + 插件内部页共用同一份 MIME / 路径守卫 / LRU 缓存）
const { serveStaticAsync } = require('./static-serve')
const { createBookmarkBackupFeature } = require('./bookmark-backup')
const { runSnapshotIfNeeded } = require('./snapshot-bootstrap')
const {
  registerHiraProtocol,
  serveHiraRequest,
  registerHiraPage,
  unregisterHiraPage,
  setExtensionIconPort,
  setFaviconIconPort,
  setArchiveAssetPort
} = require('./hira-protocol')
// hira-plugin:// —— **运行时安装的第三方插件**的渲染侧代码入口（见该文件头的安全边界）
const { registerPluginProtocol, buildPluginAssetUrl } = require('./plugin-protocol')
// 全部 scheme 的特权登记（**全库唯一**的 registerSchemesAsPrivileged 调用点）
const { registerAppSchemes } = require('./scheme-privileges')
// hira-theme:// —— **用户主题自己的背景图片**（编辑器"选择图片"拷进来的那些）
const {
  registerThemeAssetProtocol,
  buildThemeAssetUrl,
  themeAssetsDir
} = require('./theme-asset-protocol')
// 主题资产库（选图入库 / 导出读图）：内容寻址的扁平目录，见该文件头
const { createThemeAssetStore } = require('./theme-assets')
// 「每日一图」的取图器（Bing 每日壁纸）—— 主题体系里唯一会联网的地方
const { createDailyBackgroundProvider } = require('./theme-daily')
// 联网校时（TOTP 校准按钮）：只测「本机时钟 vs 网络时间」的偏移，
// 不碰系统时间。`resolveNetFetch` 同时给 theme-daily 复用（同一套 net.fetch 优先级）。
const { createNetClock, resolveNetFetch } = require('./net-clock')
// 标签截图服务（APPS 组合根）：采集/编码在 electron 侧，存储/淘汰在 infra 的纯 store 里
const { createTabSnapshotService } = require('./tab-snapshot')
// 打印（作业状态 + PDF 渲染 + 系统打印）与「保存网页」：两个纯编排服务，
// 只认识 webContents / dialog，不认识窗口或 IPC —— 接线全在本文件与 IPC 层
const { createPrintService } = require('./print/service')
const { createSavePageService } = require('./save-page/service')
// 外部静态 bundle（游戏）特性模块：hira-game:// 协议 + 目录 + IPC，见 main/external-games/
const { createExternalGamesFeature } = require('./external-games')
const { createGameProtocolHandler } = require('./external-games/protocol') as {
  createGameProtocolHandler(catalog: unknown): (request: Request) => Promise<Response>
}
const { createRtProtocolCompatibility } = require('./rt-protocol-compat') as {
  createRtProtocolCompatibility(options: {
    serveHira(request: Request): Promise<Response>
    serveGame(request: Request): Promise<Response>
  }): { registerOn(session?: Session): void }
}
// 外部协议（mailto: 等）授权记录：记录复用 domain-settings，见 main/open-external.js
const { createOpenExternalPermissions } = require('./open-external')
// PWA（把站点安装为应用）：域服务只碰数据库，探测/安装/快捷方式是 APPS 层编排，
// 图标资产走 hira-pwa:// 特权协议（见 docs-ng/PWA安装与应用窗口设计.md）。
const { createPwaService } = require('@hira-ng/domain-pwa')
const { createPwaPaths } = require('./pwa/paths')
const { createCandidateStore } = require('./pwa/candidate-store')
const { createPwaDetector } = require('./pwa/detect')
const { createPwaShortcuts } = require('./pwa/shortcuts')
const { createPwaIntegrations } = require('./pwa/integrations')
const { createPwaInstaller } = require('./pwa/install')
const { createPwaUpdater } = require('./pwa/updater')
const { createPwaUninstaller } = require('./pwa/uninstall')
const { registerPwaProtocol } = require('./hira-pwa-protocol')
// 应用窗口运行时（哪些应用窗开着）与命令行参数口径（快捷方式 / 冷启动 / 第二实例共用）
const { createPwaRuntime } = require('./pwa/runtime')
const { parsePwaArgs } = require('./app/pwa-args')
const { WINDOW_TYPES, WINDOW_CONFIG, getWindowConfig } = require('./window-config')
// OOBE 首次启动引导：状态判定 + 窗口编排（唯一真源；IPC 只做薄转发）
const { createOnboardingController } = require('./onboarding')
// 浏览器一键迁移（Chrome / Edge → Hira）：五段管线编排（detect / copy / parse / write）。
// 领域服务在下方创建后注入 —— 迁移层不自己开写库路径。
const { createBrowserImportService } = require('./import')
// 扫码取景框的几何（与渲染层的框页共用同一份常量）
const { QR_SCAN_BAR, qrScanCropRect } = require('@hira-ng/shared-types/src/qr-scan-frame.mjs')

/**
 * 松手后多久恢复抓屏（毫秒）。
 *
 * 用户拖到位往往还会微调一下，每次都立刻抓一帧整屏、又马上作废，纯属白烧主进程。
 * 这个"尾巴"让最后一次微调也被算进交互期（见 qrScanFrame.setInteracting）。
 */
const QR_SCAN_SETTLE_MS = 260

/**
 * 「刚请求开框」的授权宽限（毫秒）—— 见 qrScanFrame 里的 `captureArmedUntil`。
 *
 * 为什么是 4 秒这个量级：它要盖住"请求流 → IPC 开框 → 窗口建好并显示"这一整段
 * （正常几十毫秒，冷启动/杀软扫描时可能到秒级），同时又要短到
 * "用户没扫、过一会儿再想偷偷用"这种情形不可能落在窗口内。
 */
const QR_SCAN_CAPTURE_ARM_MS = 4000

/**
 * displayMedia 源选择时**等取景框出现**的上限（毫秒）—— 见 setDisplayMediaRequestHandler。
 * 40ms 一跳、兜底 1.5 秒：正常几十毫秒就等到了，等不到就是"用户没在扫"。
 */
const CAPTURE_WAIT_MS = 1500
const { registerDownloadHandler } = require('./download-manager')
// 「下载开始 → 自动打开下载面板」的选边策略（左侧有面板就开右侧…）。
// 与下载管理器 / 布局协调器各自解耦：本文件只负责把"哪个窗口、有没有这个面板"接上。
const { createDownloadPanelOpener } = require('./download-panel-opener')
// 站点守卫（弹窗 / 自动下载）：页面行为型权限的**统一判定**（阈值 + 询问 + 权限表复用），
// 见该文件头 —— 弹窗与下载两个接入点共用同一份规则，不各写一份。
const { createSiteGuard, isActivationInput } = require('./site-guard')
// 会话恢复：领域逻辑在 domain-session，磁盘能力由 @hira-ng/infra-fs 注入
// （原 main/session-restore.js 已于 2026-09-13 下沉删除）
const { createSessionService, createSessionPersistence } = require('@hira-ng/domain-session')
// 标签保留策略（归档阈值 / 过期判定）的**唯一真源**：自动归档定时器与启动恢复期
// 的过期过滤共用同一套规则，避免「改设置只对一处生效」的阈值漂移。
const { TABS_RETENTION_SETTING_KEYS, resolveArchiveThresholdMs, shouldArchiveTab } =
  require('@hira-ng/shared-types/src/tabs-retention.mjs')
// 窗口运行单元注册表：按 IPC 发送方把 tabManager / layoutCoordinator 等解析到对应窗口
const { createWindowRuntimeRegistry } = require('./window-runtime-registry')
// 文件拖入窗口：分类（policy，纯函数）/ 执行（service）/ 导航兜底（navigation-guard）三层解耦。
// 新增一类文件的打开方式只需给 policy 注册 provider，不动 IPC 与 preload。
const { createFileOpenService } = require('./file-open/service')
const { attachFileDropNavigationGuard } = require('./file-open/navigation-guard')
// 浏览器窗口装配器：把「建窗口 → 窗口 chrome → 标签运行单元 → js-dialog → 快捷键 →
// ui-shell/rail 加载 → 插件」收成一条可重复调用的装配路径（多窗口第四步）。
// 它内部用到 window-chrome / browser-window-runtime / js-dialog，
// 所以 main.js 不再直接 require 那三个模块。
const { createBrowserWindowAssembly, capturePageIntoCollection } = require('./browser-window-assembly') as {
  createBrowserWindowAssembly: typeof import('./browser-window-assembly').createBrowserWindowAssembly
  capturePageIntoCollection: typeof import('./browser-window-assembly').capturePageIntoCollection
}
// 多窗口会话分片：文件命名、持久化生命周期、退出刷盘都收口在一个显式端口里。
const { createSessionWindowManager } = require('./session-window-manager')
// 扫码取景框的窗口状态与拖动几何独立于主进程编排。
const { createQrScanFrameController } = require('./qr-scan-frame-controller')
// 退出顺序与所有落盘动作集中在一个可审阅的模块中。
const { createAppShutdownHandler } = require('./app-shutdown')
const { runStartupBackgroundTasks } = require('./startup-background-tasks')
const { runTabMoveSmoke } = require('./diagnostics/tab-move-smoke')
const { createPerProfileServiceProxy } = require('./profile-service-proxy')
const { createPwaLaunchQueue } = require('./pwa-launch-queue')
const { createPermissionRuntime } = require('./permission-runtime')
const { createProfileSpaceCoordinator } = require('./profile-space-coordinator')
// 集锦动作（WP1）：快捷键 / 应用菜单 / 地址栏 / 命令链 / 插件共用的**唯一实现**。
// 独立成模块的原因见该文件头：多入口各写一份必然漂移（"快捷键能收、手势收不进去"）。
const { createNoteActions } = require('./note-actions')
const { createCaptureHub } = require('./capture-hub')
const { createPageLibrary } = require('./page-library')
// 窗口几何持久化：新窗口按上次的尺寸/位置出现（Chrome/Edge 行为）
const { createWindowStateStore, defaultWindowStatePath } = require('./window-state-store')
// Step 6：特性模块统一走 IHiraModule + ModuleManager 拓扑启动（见 module-bootstrap.js）
const { bootstrapCoreModules, bootstrapPostIpcModules, bootstrapPluginModule } = require('./module-bootstrap')
// 启动自愈：清理上次异常退出残留的临时（无痕）profile（DB 行 + 磁盘目录）
const { cleanupStaleEphemeralProfiles } = require('./ephemeral-cleanup')
// 一次性迁移：单库列分区 → 每 profile 物理独立库（PART16 L2 步骤 4）
const { migrateToPhysicalIsolation } = require('./migration/split-db-per-profile')
// 配置档案归档（G1 导出 / G2 导入）：搬运引擎（表数据 + profile 目录下的 JSON）
const { createProfileArchive } = require('./profile-archive')
// 空间归档（导出 / 导入）：搬运引擎（空间元数据 + 空间目录下的 settings/session JSON）
const { createSpaceArchive } = require('./space-archive')
// 集锦图片资产基础设施（P2）：按 URL 抓图 / 存图字节 / 缩略图 dataURL / 打开原图。
// 落盘、缩略图、大图纪律、LRU 全在它里面（见 notes-assets.js 文件头三条决策）。
const { createNotesAssets } = require('./notes-assets')
// 分享 / 二维码（N15）：文本 → QR 的 SVG（生成在主进程，见该文件头说明）
const { createShareService } = require('./share')
// 命名会话 / 会话模板（N14）：存/列/恢复/删（存储走设置项 `sessions.named`）
const { createNamedSessions } = require('./named-sessions')
// 小窗预览（N1，Arc 的 Little Arc）：应用级单例，见该文件头说明
const { createPeekController } = require('./peek')
// 自动化（D2 命令链 + D3 鼠标手势）：控制器只做「存取 + 派发」，命令执行器由下方注入。
const { createAutomationController } = require('./automation')
// D5 Break Mode / N9 空间导航开关下发（均为端口注入的小控制器）。
const { createBreakMode } = require('./break-mode')
const { createSpatialNavBroadcaster } = require('./spatial-nav')
// 网页翻译（C3）：插件插槽优先、内置在线引擎兜底。
const { createTranslateService } = require('./translate')
// 即时答案（F-0771~F-0773）：出网 + 解析 + 缓存都在主进程，渲染层只拿中立事实。
const { createInstantAnswerService } = require('./instant-answer')
// 支付卡 / 地址保管库（N7）：加密存储（与密码同一套 provider），见该文件头说明
const { createFormFillVault } = require('./form-fill')
const { ProviderRegistry, createContributionRegistry, createExtensionPointRegistry, registerOfficialExtensionPoints } = require('@hira-ng/infra-plugin')
// 宿主侧调用插槽的统一入口（错误只告警、绝不上抛）。见该文件头说明。
const { createSlotCaller } = require('./slot-call')
// 主页 / 新标签页地址唯一解析层（app.home_mode + app.home_url + 扩展覆盖）
const { resolveHomeUrl, resolveNewTabUrl, setNewTabOverrideProvider } = require('./home-url')
// 面板目录：侧栏面板的运行时单一事实源（由插件 manifest 的 contributes.panels 汇总）
const { createPanelCatalog } = require('./panel-catalog')
// 面板换宿主（侧栏 ↔ 独立窗口）：通用能力的唯一裁决者，AI 无关（见该文件头）
const { createPanelPresentation } = require('./panel-presentation')
// 集锦面板（集锦 / 全部 / 稍后读 / 回收站）的 id 与"打开它"的唯一入口。
const { openNotesPanel } = require('./notes-panel')
// 菜单类插槽 → 原生菜单项 适配器（bookmark.context-menu / webview.context-menu.item）
const { createSlotMenuAdapter } = require('./slot-menu')
// 网页生命周期插槽适配器（webview.lifecycle.*）
const { createSlotLifecycle } = require('./slot-lifecycle')
// 渲染侧插槽宿主（slots:render / slots:dispatch）：side-panel.* 这类产出面在渲染层的插槽
const { createSlotRenderer } = require('./slot-render')
// 插件开关状态持久化（只落盘"用户主动禁用"）
const { createPluginStateStore } = require('./plugin-state-store')
// 插件安装器（社区市场的落盘那一半：体检 / 复制 / 解压 / 卸载 / 签名验签）
const { createPluginInstaller, readBuiltinPluginIds } = require('./plugin-installer')
// 插件源（社区市场的索引那一半：拉索引 / 下载 / 校验和）
const { createPluginMarket } = require('./plugin-market')
// 插件键值存储（开放 API 的持久化面）：按 profile + 插件隔离，配额与校验的唯一实现在该文件内。
const { createPluginStorage } = require('./plugin-storage')
// 插件能力门面（PART18 开放世界）：`ctx.browser.*` 的**唯一实现处**。
// 形状 / 鉴权 / 边界校验都在该文件里；main.js 只负责把真实实例装进 getter 端口。
const { createPluginCapabilities, createEventHub } = require('./plugin-capabilities')
// 插件浮层宿主（PART18）：插件自定义浮层的主进程唯一实现处（按窗口分桶 + 事件下发）。
const { createPluginOverlayHost } = require('./plugin-overlays')
/**
 * 插件表面（pages / bangs / menus 的消费入口，见 plugin-surfaces.js）。
 *
 * 声明在**模块顶层**而不是 app.whenReady 的回调里，原因是使用者的出现时机很早：
 * 主窗口在 `browserWindows.open()` 时就建立了网页右键菜单钩子（`getSlotMenuItems`），
 * 那时贡献注册表还没建、实例自然是 null。放在顶层 = 任何回调读到的都是"已定义但可能为空"，
 * 不会踩到块级作用域的 TDZ（那种 ReferenceError 会在事件回调里炸，最难查）。
 * 真正的赋值在贡献注册表就绪之后（见 createPluginSurfaces 的调用点）。
 */
let pluginSurfaces: PluginSurfacesPort | null = null
/**
 * 用户脚本宿主运行时（`@require` 取码 / `GM_xmlhttpRequest` 代理）。
 *
 * 与 `pluginSurfaces` 同级延迟构造：它要读脚本清单（表面层才认识 manifests），
 * 而注入点与 IPC 又都早于表面层创建。做成"模块级 let + 晚绑定 getter"。
 */
let userScriptRuntime = null
/**
 * 插件注册中心句柄（插件中心 IPC 的唯一数据源）。
 *
 * 与 `pluginSurfaces` 同理**必须声明在模块顶层**：应用菜单的 `getState()` 在
 * `appMenu.install()` 时就会读它（「功能面可用性」进菜单签名），而装机这一句
 * 早于 ready 回调后半段的注册中心启动。若把它声明在回调里，首次 install 就会踩
 * `Cannot access 'pluginRegistry' before initialization` 直接把启动打断。
 * 真正的赋值在 `bootstrapPluginModule` 完成之后（晚绑定）。
 */
let pluginRegistry: PluginRegistryPort | null = null
// ── 启动分层（对齐 RT `src/main/app/*`）：生命周期 / 单实例 / URL 入口 ──
// 把「app 级原始事件接线」从 main.js 里抽走，让 main.js 只做装配与编排。
const { createPreboot } = require('./app/preboot')
const { issueSafeBrowsingWarning } = require('./safe-browsing') as {
  issueSafeBrowsingWarning(url: unknown): string
}
// 用户数据目录的唯一真源（%APPDATA%\STAR_HigheriTech\STAR Hira NitroGen）：必须先于 preboot，
// 因为 preboot 在 ready 之前就会直读 userData 下的设置文件。
const { applyAppDataPaths } = require('./app/data-paths')
const { createUrlRouter } = require('./app/urls')
const { createInstanceController } = require('./app/instance')
const { registerAppLifecycle } = require('./app/lifecycle')
// 平台级入口：Windows 任务栏 JumpList / macOS Dock 菜单
const { registerPlatformIntegration, pickJumpListAction } = require('./app/platform-integration')
// 默认浏览器 / 文件关联：Windows 注册表的唯一写入点（schema 见 shared-types/associations）
const { registerDefaultClient } = require('./app/default-client')
// 打包态 / 开发态的唯一判据：关联能力与 app:info 的 isDevelopment 都取这一份
const { isDevRuntime, isPackagedRuntime } = require('./app/runtime-mode')
const { getRuntimeIdentity } = require('./app/runtime-identity')
const { scheduleDevelopmentArtifactCleanup } = require('./app/development-artifacts')

type UnknownRecord = Record<string, unknown>
type CallablePort = Record<string, (...args: unknown[]) => unknown>
type ProfileServicePort = ReturnType<typeof import('@hira-ng/domain-profile').createProfileService>
type ProfileRecord = import('@hira-ng/domain-profile').Profile
type HistoryServicePort = ReturnType<typeof import('@hira-ng/domain-history').createHistoryService>

interface PluginManifest {
  id: string
  name?: string
  permissionLevel?: string
  [key: string]: unknown
}

interface PluginSurfacesPort {
  resolveUserScriptsForUrl(url: string): unknown
  resolvePagePatchesForUrl(url: string): { css?: string; js?: string }
  listUserScripts(): unknown[]
  contextMenuItems(kind: string, payload: UnknownRecord): unknown[]
  getPluginMenus(): unknown
  listPanelOverrides(): unknown[]
  pageUrl(ref: string, pluginId: string): string
  syncSurfaces(): unknown
  listBangsAsync(): Promise<unknown[]>
  registerDeclarativeSlots(...args: unknown[]): unknown
}

interface PluginRegistryPort {
  getPluginRoot?(pluginId: string): string | null
  getManifests?(): PluginManifest[]
  describe?(): PluginManifest[]
  reportPluginError?(pluginId: string, error: unknown): void
}

interface SiteGuardPort {
  evaluatePopup(payload: UnknownRecord): boolean
  evaluateDownload(payload: UnknownRecord): boolean
}

interface PeekControllerPort {
  open(payload: { url: string; session?: Session; originWindow?: BrowserWindowRuntime }): { ok?: boolean; reason?: string } | void
}

interface PluginEventHubPort {
  emit(route: string, payload?: unknown, opts?: UnknownRecord): unknown
}

interface PwaUninstallerPort {
  uninstall(appId: string, profileId: string): unknown
}

interface MoveTabRequest {
  tabId: string
  targetWindowId?: number
  newWindow?: boolean
  targetId?: string | null
  insertAfter?: boolean
  atCursor?: { x?: number; y?: number } | null
}

interface PluginHostPort {
  setEnabled(request: { id: string; enabled: boolean; cascade?: boolean }): unknown
}

interface StudioPort {
  install(target: unknown, options?: unknown): unknown
  uninstall(id: string): unknown
  installUserscript(request: unknown): unknown
}

function asRecord(value: unknown): UnknownRecord {
  return value && typeof value === 'object' ? value as UnknownRecord : {}
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error ?? '')
}

// 会话服务：无状态构造，模块级建一次即可。tabManager 在调用时作为 tabPort 传入。
/**
 * 会话保留策略的设置端口（**晚绑定**）。
 *
 * 为什么不是直接读 settingsService：`sessionService` 在本模块顶部就构造，而
 * settingsService 是 `startApp()` 里的 `const`，提前引用直接踩 TDZ。
 * 先给默认值「永不归档」，settingsService 建好后回填；`isExpiredTab` 只在
 * restore 时求值，那时读到的必然是已回填的实现。
 * @type {() => unknown}
 */
let archiveAfterPort: () => unknown = () => 'never'
/**
 * 恢复期的保留策略（`domain-session#isExpiredTab` 端口）：
 * 丢弃「已超过 tabs.archiveAfter 阈值」的旧标签，对齐 RT `restore.ts#loadAndFilterTabs`。
 * 判定与 60s 自动归档定时器**同源**（tabs-retention），因此恢复出来的标签不会
 * 在下一个 tick 就被归档删除（用户感知为「刚恢复就没了」）。
 */
function isExpiredSessionTab(tab: { lastActivated?: unknown } | null | undefined, now: number): boolean {
  return shouldArchiveTab(tab?.lastActivated, resolveArchiveThresholdMs(archiveAfterPort()), now)
}
const sessionService = createSessionService({ filePort: createFilePort(), isExpiredTab: isExpiredSessionTab })
// 会话持久化调度器（对齐 RT TabPersistenceManager）：脏标记 + 2s 批量异步 flush。
// 取代原先「tab:changed → 1s 防抖 → 同步 writeJsonAtomicSync」的阻塞写盘方案。
const sessionPersistence = createSessionPersistence({ sessionService })

/**
 * 「上次关闭」归档服务 —— 与 sessionService **同一套领域实现**，唯一的差别是文件名。
 *
 * 为什么不能直接拿 `session.json` 当"上次关闭"：它是**运行期实时镜像**
 * （SessionPersistence 每 2s 把当前标签刷进去），运行中读它只会读到"现在"。
 * 因此启动时把上一轮退出留下的 `session.json` 一次性复制成 `last-closed.json`，
 * 之后整个运行期只读 —— 面板卡片显示的永远是"上一次关掉应用时的那份"。
 */
const LAST_CLOSED_FILE_NAME = 'last-closed.json'
const lastClosedSessionService = createSessionService({
  filePort: createFilePort(),
  fileName: LAST_CLOSED_FILE_NAME,
  isExpiredTab: isExpiredSessionTab
})

/**
 * 扩展系统构造选项的**运行时端口**（先给默认值，settingsService 建好后回填）。
 *
 * 为什么需要它而不是直接用 settingsService：`getOrCreateExtensionService` 在本模块
 * 里出现得更早（启动时装第一个 profile 的扩展），而 settingsService 是 `const`，
 * 提前引用会直接踩 TDZ 抛错。用「可变端口」把时序解耦，读的时候才解析。
 *
 * 注意：这两个选项是**构造期**参数（传给 createExtensionService），因此改完需要
 * 重新加载 profile 才生效；设置页的说明文案与之一致。
 * @type {() => object}
 */
let extensionOptionsPort: () => object = () => ({ autoUpdate: false, allowUnpacked: true, enableAdblocker: true, blockTrackers: true })

/**
 * PDF 内置查看器开关的运行时端口（先给默认 true，settingsService 建好后回填）。
 * 同样是「避开 TDZ」的延迟端口：TabManager 在 settingsService 之前构造。
 * TabManager 每次判定都现读，因此改设置后**下一次打开 PDF 即生效**。
 * @type {() => boolean}
 */
let pdfViewerEnabledPort: () => boolean = () => true
/**
 * 分屏选项的运行时端口（先给默认值，settingsService 建好后回填）。
 *
 * 与 PDF 端口同款"延迟端口"：TabManager 在 settingsService 之前构造，按值传会捕获到
 * 空值。TabManager 每次建组 / 加入时**现读**，因此改设置后下一次分屏操作即生效，
 * 无需重启、也不会改动已经建好的分屏组。
 *
 * 夹取在**这里**做（而不是让表单保证）：设置文件可手改，非法值必须回落，且用户口径
 * 不得超过硬上限 `SPLIT_METRICS.maxPanes`。
 * @type {() => { maxPanes: number, defaultLayout: string, linkRouting: string }}
 */
let splitOptionsPort: () => { maxPanes: number, defaultLayout: string, linkRouting: string } = () => ({ maxPanes: 4, defaultLayout: 'row', linkRouting: 'off' })

/**
 * 「切标签自动画中画」开关的运行时端口（先给默认 false，settingsService 建好后回填）。
 * 同为「避开 TDZ」的延迟端口：浏览器窗口运行单元在 settingsService 之前构造。
 * 用时现读，因此改设置后**下一次切标签即生效**。
 * 默认 false = 普通浏览器行为：不主动弹画中画。
 * @type {() => boolean}
 */
let autoPipEnabledPort: () => boolean = () => false

/**
 * 标签 WebPreferences 附加项的运行时端口（先空，settingsService 建好后回填）。
 * 同样为避开 TDZ：WebContentsManager 在 settingsService 之前构造。
 * 目前承载 `accessibility.font_size` → `defaultFontSize`。
 * @type {() => object}
 */
let extraTabWebPreferencesPort: () => WebPreferences = () => ({})

// ── 用户数据目录（必须最先，且早于任何读磁盘的代码）──
// 统一到 %APPDATA%\STAR_HigheriTech\STAR Hira NitroGen（开发态 STAR Hira NitroGen-development）。
// sessionData / logs / crashDumps 默认派生自 userData，因此只此一处即可全部收拢。
const appPaths = applyAppDataPaths({ app })
console.log('[paths] userData:', appPaths.userDataPath)

// ── ready 之前的前置动作（Chromium 开关 / UA / 订阅登记 / 认证 / 崩溃收集）──
// 全部收口在 app/preboot.js（PART12 D9）：有时序硬约束的动作集中在一处，
// main.js 只做装配。返回的句柄都是晚绑定端口，registerCoreIpc 里按需读取。
const preboot = createPreboot({ app, ipcMain })
const { defaultUserAgent, listenerRegistry, broadcaster, httpAuthManager } = preboot

// ── 窗口运行单元注册表（多窗口第三步）────────────────────────────────────────
// 模块级创建：IPC 必须能在最早时机就按发送方解析窗口。primary 在窗口运行单元
// 建好后回填（见下方 setPrimary）；解析不到窗口时一律回退 primary。
const runtimeRegistry = createWindowRuntimeRegistry()
preboot.setCertificateScopeResolver((webContents: Electron.WebContents) => {
  let profileId = 'default'
  let spaceId = ''
  try {
    const runtime = runtimeRegistry.matchBySender(webContents)
    const current = runtime?.spaceRuntime?.getCurrent?.()
    if (current?.profileId) profileId = String(current.profileId)
    if (current?.spaceId) spaceId = String(current.spaceId)
  } catch {}
  return `${profileId}\n${spaceId}`
})

/**
 * 文件拖入窗口（应用级单例）。
 *
 * 必须在建窗之前就绪：`navigation-guard` 依赖 `web-contents-created`，
 * 而该事件只对**注册之后**创建的 webContents 生效 —— 晚一步，主窗口就漏了。
 * 窗口归属不在这里决定：IPC 侧注入的是 scoped tabManager（按发送方解析）。
 */
const fileOpenService = createFileOpenService()
attachFileDropNavigationGuard({ app, runtimeRegistry, fileOpenService })

/**
 * 数据域（书签 / 历史 / 下载 / favicon）的 **profile 分区键**。
 *
 * 注入给 domain 服务的 `getProfileId` 端口：domain 不认识窗口、运行单元、
 * 更不认识 Electron —— 它只向 APPS 要一个字符串（与 faviconPort 同一套解耦口径）。
 *
 * 解析由 runtimeRegistry 统一完成（显式 runWithProfile > 发起窗口的空间运行态 > default），
 * 因此同一个服务实例在不同调用点自动落到正确的用户数据分区，
 * 无需为每个 profile 各建一套服务。
 */
const currentProfileId = () => runtimeRegistry.currentProfileId()

/**
 * 把「构造期固定 profile」的服务变成「按当前 profile 分发」的服务。
 *
 * 为什么需要这一层：domain-permission / domain-search 的 profileId 是**构造期参数**
 * （`options.profileId`），一个实例只服务一个用户。若直接注入默认实例，所有用户的
 * 站点权限与搜索历史都会落进 'default' 分区 —— 隔离在最后一米失效（这正是
 * 「profile 数据隔离没效果」的一类成因）。
 *
 * 为什么不改 domain 的内部实现：「哪个用户」属于环境信息，理应在 APPS 层解析；
 * domain 保持「一个实例 = 一个用户」的简单契约，依赖方向不变，也不需要在
 * 每个方法里插一次端口解析。
 *
 * @param {(profileId: string) => object} factory profileId → 该用户独占的服务实例
 */
const perProfileServices = <T extends object>(factory: (profileId: string) => T): T => createPerProfileServiceProxy(factory, currentProfileId)

/**
 * 全部应用 scheme 的特权登记 —— **必须在 app.ready 之前、且只在这里做一次**。
 *
 * 为什么收成一处：`protocol.registerSchemesAsPrivileged()` 是**覆盖语义**（后一次调用
 * 会把前一次的整份清单替换掉），五个模块各调一次的结果是"只有最后一个 scheme 是特权的"。
 * 实测后果就是本次事故：`hira-plugin://` 在渲染进程里 `fetch()` 报
 * `URL scheme "hira-plugin" is not supported` → HTML / XAML 面板全白屏，
 * 而 `protocol.handle()` 明明正常（导航与图片都能出来），极难归因。
 * 清单与逐条理由见 `main/scheme-privileges.js`（唯一事实源）。
 */
registerAppSchemes()

// ── 单实例锁：同一 userData 只允许一个 Chromium 实例 ──────────────────
// 两个实例共享 chromium-cache / hira-ng.db 会互相抢锁，Chromium 侧持续刷
//   Unable to move the cache: 拒绝访问。 (0x5)
//   Failed to delete the database: Database IO error
// 并不断重试 —— IO 线程被反复打断，整窗口表现为卡顿、右键"卡死不像人"。
// 主流浏览器（Chrome / Edge）同为单实例：第二个进程把启动意图转交给已有实例；
// 普通快捷方式重复启动时由已有实例补开新窗口，而不是另起进程争抢 userData。
// 注意：scripts/verify-*.cjs 用独立 userData（tmpdir），不受此锁影响。
// 实现已抽到 app/instance.js（对齐 RT app/instance.ts）。
/** 主窗口引用（供 second-instance 聚焦 / URL 打开） */
let mainWindowRef: BrowserWindow | null = null
/** 启动完成后注入的「在当前窗口打开 URL」能力（whenReady 内赋值）。 */
let appUrlOpener: ((useNewWindow: boolean, url: string, opts?: UnknownRecord) => unknown) | null = null
/** 启动完成后注入的「新建浏览器窗口」能力（whenReady 内赋值）。 */
let appNewWindowOpener: (() => unknown) | null = null
/** 运行时未就绪时到达的新窗口请求，就绪后逐个补开。 */
let pendingNewWindowLaunches = 0
let drainingNewWindowLaunches = false

async function drainNewWindowLaunches(): Promise<void> {
  if (drainingNewWindowLaunches || !appNewWindowOpener) return
  drainingNewWindowLaunches = true
  try {
    while (pendingNewWindowLaunches > 0 && appNewWindowOpener) {
      pendingNewWindowLaunches--
      try {
        await appNewWindowOpener()
      } catch (error) {
        console.error('[window] open from app launch failed:', errorMessage(error))
      }
    }
  } finally {
    drainingNewWindowLaunches = false
    if (pendingNewWindowLaunches > 0) void drainNewWindowLaunches()
  }
}

function requestBrowserWindowLaunch(): void {
  pendingNewWindowLaunches++
  void drainNewWindowLaunches()
}

function bindBrowserWindowLauncher(opener: () => unknown): void {
  appNewWindowOpener = opener
  void drainNewWindowLaunches()
}

/**
 * 平台入口（任务栏 JumpList / Dock 菜单）的动作表。
 *
 * 为什么是**模块级可变对象**：`createInstanceController` 在模块加载期就注册了
 * `second-instance`，而任务栏点击必然是「第二个进程 → 转交给已有实例」；
 * 那时 whenReady 还没跑、动作实现还不存在。用空对象占位、启动后回填，
 * 点击发生在启动完成之后才有意义（启动中点击由队列语义天然覆盖）。
 * @type {Record<string, () => void>}
 */
const platformActions: Record<string, () => void> = {}

// ── PWA 冷启动 / 第二实例转发 ─────────────────────────────────────────
// 参数口径只有一份（app/pwa-args.js）：快捷方式、setAppDetails 的 relaunchCommand、
// 本进程 argv、第二实例 commandLine 全部走 parsePwaArgs。
//
// 为什么要一个队列：`second-instance` 在模块加载期就注册了，而窗口运行时
// （pwaRuntime）要等数据库与服务就绪才存在。启动中到达的请求先记下，
// 运行时回填后再补开 —— 否则用户双击应用时「看起来什么都没发生」。
const coldPwa = parsePwaArgs(process.argv)
const coldJumpListAction = pickJumpListAction(process.argv)
const pwaLaunchQueue = createPwaLaunchQueue()
const requestPwaLaunch = (request: unknown): unknown => pwaLaunchQueue.request(request)

// ── URL 入口（对齐 RT app/urls.ts）──
// 冷启动参数里的 URL 会先入队，窗口就绪后由 flushPendingUrls() 统一打开。
const urlRouter = createUrlRouter({
  openUrlInWindow: (useNewWindow: boolean, url: string, opts?: UnknownRecord) => (appUrlOpener ? appUrlOpener(useNewWindow, url, opts) : Promise.resolve())
})

const instanceController = createInstanceController({
  app,
  getMainWindow: () => mainWindowRef,
  onNewWindow: requestBrowserWindowLaunch,
  onOpenUrl: (useNewWindow: boolean, url: string) => urlRouter.handleOpenUrl(useNewWindow, url),
  // PWA 应用启动（快捷方式 / 任务栏固定项）——必须是第一条判据：
  // 它的命令行不是 URL，误走 urlRouter 会得到一个「打不开的地址」。
  onPwaApp: (pwa: unknown) => requestPwaLaunch(pwa),
  // 任务栏 JumpList 的动作（新进程带 `--jump-list-action=…`）转交已有实例执行
  onAction: (name: string) => {
    const fn = platformActions[name]
    if (typeof fn === 'function') {
      try { fn() } catch (e) { console.error('[platform] action failed:', name, errorMessage(e)) }
    } else {
      console.warn('[platform] unknown jump list action:', name)
    }
  }
})
const hasSingleInstanceLock = instanceController.hasLock
if (!hasSingleInstanceLock) {
  console.warn('[main] another instance already owns this userData — exiting instead of fighting over the disk cache. (close the running window, or kill leftover electron.exe)')
  app.quit()
} else {
  instanceController.register()
  // 冷启动参数里的初始 URL（`electron . https://x`）：先入队，窗口就绪后打开。
  urlRouter.processInitialUrl(process.argv)
}

app.whenReady().then(async () => {
  const _t0 = Date.now()
  try {
  if (!hasSingleInstanceLock) return
  console.log('[main] whenReady')
  if (isDevRuntime()) {
    // 非阻塞自愈：只删除仍指向当前开发 electron.exe 的 STAR Hira NitroGen 快捷方式 / 幽灵关联。
    scheduleDevelopmentArtifactCleanup({ executablePath: process.execPath, delayMs: 2500, logger: console })
  }
  const handled = await runSnapshotIfNeeded({ app, ipcMain })
  if (handled) return
  console.log('[main] init timing: whenReady+snapshot took', Date.now() - _t0, 'ms')
  const appRoot = getAppRoot(app)

  // Register hira:// internal pages protocol (settings, history, etc.)
  // protocol.handle 必须在 app.ready 之后调用（内部访问 session）
  registerHiraProtocol()
  /**
   * **用户插件目录** —— 运行时安装的第三方插件放这里。
   *
   * 路径只在这一处拼：它有两个消费方（插件发现的 `pluginUserDir`、
   * 「打开插件目录」的查询口），两处各拼一份必然有一天不一致，
   * 而那种不一致的表现是"打开的目录和实际加载的目录不是同一个"，极难察觉。
   */
  const userPluginDir = path.join(app.getPath('userData'), 'plugins')

  /**
   * `hira-plugin://` 的解析口 —— **迟绑定**读 `pluginRegistry`。
   *
   * 协议必须在 app.ready 时就注册好（渲染层随时可能 import），而注册中心是插件
   * 后台启动的产物 —— 两者时序天生错开，所以这里给的是**闭包**而不是当时的实例。
   * 只对**已启用**的插件返回路径（禁用即失效），见 plugin-protocol.js 的安全边界。
   */
  const pluginProtocolOptions = {
    getPluginRoot: (id: string) => (
      pluginRegistry && typeof pluginRegistry.getPluginRoot === 'function'
        ? pluginRegistry.getPluginRoot(id)
        : null
    ),
    /**
     * 该插件的权限级别 —— HTML / XAML 面板的 CSP 由它**派生**（`plugin-ui.mjs`）。
     *
     * 为什么读 manifest 而不是 describe()：权限是**声明面**的事实（谁都能问），
     * 而 describe() 会随运行态变化；CSP 不该因为插件刚好在重启就变成另一份。
     * 拿不到时返回 null → 协议层按 `none` 派生（最严），不会误放网络。
     */
    getPluginPermissionLevel: (id: string) => {
      if (!pluginRegistry || typeof pluginRegistry.getManifests !== 'function') return null
      try {
        const key = String(id || '').toLowerCase()
        const m = pluginRegistry.getManifests().find((x: UnknownRecord) => x && String(x.id).toLowerCase() === key)
        return m ? m.permissionLevel : null
      } catch (_) {
        return null
      }
    }
  }
  registerPluginProtocol(undefined, pluginProtocolOptions)

  /**
   * **用户主题的图片资产库** —— `hira-theme://` 的服务根。
   *
   * 路径与协议注册都在这里一次性定好：资产库（拷图进来 / 导出读图）与协议（把图发出去）
   * 必须指向**同一个目录**，两处各拼一份必然有一天不一致，而那种不一致的表现是
   * "选了图、预览也是好的、重启后全裂了"，极难察觉。
   */
  const themeAssetRoot = themeAssetsDir(app.getPath('userData'))
  registerThemeAssetProtocol(undefined, { root: themeAssetRoot })

  /**
   * PWA 资产目录与 `hira-pwa://` 协议。
   *
   * 目录口径**不在这里拼**：`createPwaPaths` 只接收 `resolveProfileDir`，
   * 与 profile / 会话 / 数据库用的是同一条路径规则（见该函数上的说明）。
   * 协议处理器只认 paths，不认识窗口与数据库 —— 安全边界全在 hira-pwa-protocol.js。
   */
  const pwaPaths = createPwaPaths({ resolveProfileDir })
  registerPwaProtocol({ paths: pwaPaths })
  // 协议处理是**按 session** 注册的，而每个 profile 有自己独立的 Session
  //（见 SessionsController）。只挂默认会话的话，PWA 窗口标题栏 / 应用管理页里的
  // 图标会 ERR_UNKNOWN_URL_SCHEME —— 而且只在非 default profile 下复现。
  // `session-created` 是唯一的全局新会话出口，不必在每个取会话的地方重复登记。
  app.on('session-created', (createdSession: Session) => {
    try {
      registerPwaProtocol({ paths: pwaPaths, session: createdSession })
    } catch (err) {
      console.warn('[pwa-protocol] 会话协议注册失败:', errorMessage(err))
    }
  })

  /**
   * 主题域的三个口：
   *   · `themeAssets`      —— 用户主题的图片资产库（选图入库 / 导出读图）；
   *   · `themePluginAssets` —— 插件主题包的资产（见下）；
   *   · `themeDaily`       —— 「每日一图」的取图器。
   *
   * 取图器用 Electron 的 `net.fetch`（走系统代理；全局 fetch 在有些代理环境下拿不到外网），
   * 拿不到 `net` 时回落全局 fetch —— 这条链是"尽力而为"，不该因为取图失败影响任何渲染。
   */
  const themeAssets = createThemeAssetStore({ userDataDir: app.getPath('userData') })
  // 主进程唯一的「联网出口」口径（net.fetch 优先，全局 fetch 兜底）。
  // 取图、校时都从这里取，别再各写一份 IIFE —— 代理环境下两处行为必须一致。
  const netFetch = resolveNetFetch()
  const themeDaily = createDailyBackgroundProvider({ fetchImpl: netFetch })

  /**
   * 主题包资产的**两个口**（主题域唯一接触 `hira-plugin://` 的地方）。
   *
   *   `url()`  —— 拼地址，形状的唯一真源在 plugin-protocol（主题包里的背景图要用它）；
   *   `read()` —— 读字节，导出主题包时把背景图一起带走。
   *
   * 两者都走 `pluginProtocolOptions.getPluginRoot`：**只有已启用的插件**才拿得到
   * 目录。这带来一个有意为之的后果 —— 插件被停用后，它的主题背景图也读不到
   * （而主题本身早已随贡献摘除消失），语义一致。
   */
  const themePluginAssets = {
    url: (pluginId: string, rel: string) => buildPluginAssetUrl(pluginId, rel),
    read: (pluginId: string, rel: string) => {
      const root = pluginProtocolOptions.getPluginRoot(pluginId)
      if (!root) return null
      const abs = path.resolve(root, String(rel || '').replace(/^\.?\//, ''))
      // 与协议层同一条目录守卫：主题里的 `background.path` 是包内容，
      // 也就是**可被手改的输入**，不能直接当路径用。
      const base = path.resolve(root)
      if (abs !== base && !abs.startsWith(base + path.sep)) return null
      try {
        const st = fs.statSync(abs)
        if (!st.isFile()) return null
        return fs.readFileSync(abs)
      } catch (_) {
        return null
      }
    }
  }

  // External static bundles (games) over hira-game:// — separate scheme so
  // third-party code never shares the internal pages' origin / IPC bridge.
  const externalGames = createExternalGamesFeature()
  const rtProtocolCompatibility = createRtProtocolCompatibility({
    serveHira: serveHiraRequest,
    serveGame: createGameProtocolHandler(externalGames.catalog)
  })
  rtProtocolCompatibility.registerOn()
  app.on('session-created', (createdSession: Session) => {
    try {
      rtProtocolCompatibility.registerOn(createdSession)
    } catch (error) {
      console.warn('[rt-protocol] session registration failed:', errorMessage(error))
    }
  })

  // ── 会话装配（对齐 RT sessions-controller）──────────────────────
  // 每个 profile 一个 `session.fromPath(profiles/<id>)` 持久会话：会话对象与真实磁盘
  // 目录强绑定，profile 隔离天然成立（旧的 `persist:profile-<id>` partition 与磁盘解耦，
  // 且全局单会话 setTabSession 让所有 profile 共用同一会话 —— 这是隔离失效的根因）。
  // resolveProfileDir 是注入的路径端口：infra 不认识 profile 领域，只认"目录在哪"。
  /**
   * profileId → 该 profile 的数据目录（**唯一口径**）。
   *
   * 会话、设置覆盖层、空间层、以及启动期的临时 profile 清理都走这一处 ——
   * 四处各写一遍 `path.join(userData, 'profiles', id)` 必然有一处忘了改（改目录布局时最危险）。
   */
  function resolveProfileDir(id: string): string {
    return path.join(app.getPath('userData'), 'profiles', String(id || 'default'))
  }
  /**
   * 数据库文件的命名（**单一处**）：单库模式 / 每 profile 库用同一个业务库名，
   * 全局库单独一个名字。别处不要再出现字符串字面量。
   */
  const DB_FILE_NAME = 'hira-ng.db'
  const GLOBAL_DB_FILE_NAME = 'global.db'
  /**
   * 数据库隔离模式的**唯一判据**：磁盘上有没有 `global.db`。
   *
   * 有 = 已按 profile 拆库（`split`）；没有 = 单库模式（升级前 / 迁移未完成）。
   * 用磁盘事实而不是一个设置项，是为了：① 迁移完成后的下一次启动自然进入 split；
   * ② 迁移出错时删掉 `global.db` 即可回退单库（§7 风险对策中的"可回落"）。
   */
  function resolveDbIsolationMode(userDataDir: string): 'split' | 'single' {
    try {
      return fs.existsSync(path.join(userDataDir, GLOBAL_DB_FILE_NAME)) ? 'split' : 'single'
    } catch (_) {
      return 'single'
    }
  }

  // ── 一次性迁移：单库列分区 → 每 profile 物理独立库（PART16 L2 · 步骤 4）──
  // 必须**最早**跑：它会把安装基线 `settings.json` 改名备份（而 createSettingsService 会读它），
  // 并创建 `global.db`（而 db provider 的模式判定就是看它）。幂等可重入；
  // 旧库一律**复制不改**（最坏是"迁移没生效"，绝无"数据没了"）。
  try {
    const result = migrateToPhysicalIsolation({
      userDataDir: app.getPath('userData'),
      profileDirOf: resolveProfileDir,
      dbFileName: DB_FILE_NAME,
      globalDbFileName: GLOBAL_DB_FILE_NAME
    })
    if (result.migrated) console.log('[main] L2 物理独立迁移完成:', JSON.stringify(result))
  } catch (e) {
    // 迁移失败不拖垮启动：留在单库模式，下次启动重试。
    console.warn('[main] L2 迁移失败（保持单库模式）:', errorMessage(e))
  }
  const sessionsController = createSessionsController({
    resolveProfileDir,
    preloadScripts: [{
      id: 'hira-password-frame-capture',
      filePath: defaultPreloadPath('password-frame'),
      type: 'frame'
    }]
  })
  // 单飞加载器：并发请求共享同一 Promise，防止 ECE 被重复实例化。
  const loadedProfiles = createLoadedProfilesController()

  // ── 扩展服务按**会话**反查（chrome.identity 桥的归属端口）──────────────
  // identity 的 token 缓存是 profile 级的：A profile 的扩展页绝不能借到 B profile 的
  // token。IPC 发送方只带 session，因此这里按 session 反查对应的扩展服务；
  // 查不到就拒绝调用（而不是回落到"当前 profile"——那正是串号的来源）。
  function findExtensionServiceBySession(session: Session | null | undefined) {
    if (!session) return null
    for (const id of loadedProfiles.list()) {
      const svc = loadedProfiles.get(id)
      if (svc && svc.session === session) return svc
    }
    return null
  }

  /** 已加载的全部扩展服务（identity 桥注册时给已存在会话补挂 MV3 worker 通道）。 */
  function listLoadedExtensionServices() {
    return loadedProfiles.list().map((id: string) => loadedProfiles.get(id)).filter(Boolean)
  }

  /**
   * identity 桥的**晚绑定**句柄：注册发生在启动后段（registerCoreIpc），
   * 而扩展服务在本文件更早就会创建 —— 用可变引用接住返回值，
   * 之后 profile 切换新建的服务才能在 `getOrCreateExtensionService` 里补挂通道。
   */
  let attachIdentitySessionRef: ((session: Session) => unknown) | null = null
  let detachIdentitySessionRef: ((session: Session) => unknown) | null = null

  const windowRegistry = new WindowRegistry()

  // ── 扩展弹窗（extension popup）窗口编排 ──────────────────────────
  // 「打开插件 popup」的窗口宿主：ECE 自己那条路走不通时（例如从独立的管理页窗口
  // 发起、当前窗口没有可锚定的标签页）由它承载 chrome-extension:// 弹窗页。
  // 窗口特性取自 window-config 的 EXTENSION_POPUP 条目（单一真源），
  // 生命周期（失焦即关 / 随父窗口重定位 / destroy 释放）都在控制器里。
  // 单例：同一时刻只有一个扩展弹窗，与 ECE 的 toggle 语义一致。
  const extensionPopup = createExtensionPopupController({
    createSubWindow,
    windowRegistry,
    config: WINDOW_CONFIG[WINDOW_TYPES.EXTENSION_POPUP],
    windowType: WINDOW_TYPES.EXTENSION_POPUP
  })

  // ── 窗口几何持久化（多窗口第四步）──────────────────────────────
  // 「新窗口按上次的尺寸/位置出现」是 Chrome/Edge 的行为，也是多窗口可用性的基础。
  // 必须在建第一个窗口之前就绪：open() 会立刻读它作为默认几何。
  const windowState = createWindowStateStore({ filePath: defaultWindowStatePath(app.getPath('userData')) })

  // ── 设置服务（提前到建窗前）────────────────────────────────────
  // 主窗口的 WCO（系统原生窗口控制按钮）判定要在**建窗时**读设置
  // （browser-window-assembly 里 resolveWindowControlsMode），而共享服务的原创建点
  // （下方 S5）晚于主窗口 —— 故把 settings 域服务提前到这里。它只依赖
  // dataDir / filePort / currentProfileId，三者此时均已就绪；load() 是一次同步读文件，
  // 代价可忽略。下方 S5 处不再重复创建，openExternalPermissions 等引用闭包捕获、无时序问题。
  //
  // ── 三层结构（Steam 式多用户 + L2 全局层）──────────────────────
  //   全局  `userData/settings.global.json`           插件状态 + 界面布局（跨 profile 共享）
  //   快照  `userData/profiles/<id>/settings.json`    该用户自己的这份设置（只存偏离默认的键）
  //   空间  `userData/profiles/<id>/spaces/<sid>/settings.json`  按空间隔离的少数键（主题…）
  // 读 = 空间 > 用户快照 > 出厂默认（全局键则恒取自全局文件）；写 = 各写各的文件。
  // 「哪些键全局」的唯一真源在 @hira-ng/shared-types/src/settings-scope.mjs（§3.2 / §10）。
  // 迁移前那份 `userData/settings.json` 是**安装基线**：仍在 base 里被读（老用户不丢设置），
  // 一次性迁移会把它折进各 profile 快照 + 全局文件，然后改名为 `settings.json.pre-l2`。
  const settingsBase = createSettingsService({
    dataDir: app.getPath('userData'),
    filePort: createFilePort()
  })
  // 全局设置：与 base 完全同一套服务（护栏 / 防抖 / 订阅复用），只是落到另一个文件。
  const globalSettingsBase = createSettingsService({
    dataDir: app.getPath('userData'),
    fileName: GLOBAL_SETTINGS_FILE,
    filePort: createFilePort()
  })
  const settingsService = createProfileSettingsOverlay({
    base: settingsBase,
    filePort: createFilePort(),
    // 全局键（插件 + 界面布局）交给全局文件，跨 profile 共享（PART16 §3.2）
    globalSettings: globalSettingsBase,
    // 与标签会话同一套目录口径：profiles/<id>/ 就是一个用户的全部数据
    profileDirOf: (profileId: string) => resolveProfileDir(profileId),
    // 当前 profile 由运行单元上下文解析（发起窗口 → 该窗口的空间运行态）
    getProfileId: currentProfileId,
    // ── 空间层（B2 / J13）────────────────────────────────────────────
    // 「按空间」的键（见 domain-settings#SPACE_SCOPED_SETTING_KEYS）多一层覆盖：
    //   profiles/<id>/spaces/<spaceId>/settings.json
    // 目录与上面 profileDirOf 同源，只是再往下开一层 —— 空间是用户内部的分区。
    // ⚠ 端口是**现读**的，且与 `getProfileId` **同源**（`runtimeRegistry` 那一套解析）：
    //    切空间后同一批消费者拿到的自然是新空间的值，不需要谁去"重新构造设置服务"。
    //    不用 main.js 自己的 `runtimeCurrentSpace` —— 那个读了两个 module 级 `let`
    //    （activeSpace/activeProfile），在 settingsService 构造点（早于它们初始化）
    //    之间被调用会踩 TDZ；注册表这条路径不依赖任何模块级可变状态。
    getSpaceId: () => runtimeRegistry.currentSpaceId(),
    spaceDirOf: (profileId: string, spaceId: string) => path.join(
      resolveProfileDir(profileId), 'spaces', String(spaceId || 'default')
    )
  })

  // ── 空间运行态（按窗口）──────────────────────────────────────
  // 必须先于窗口创建：TabManager 构造时要拿到 context 端口。它是个**稳定对象**，
  // 内部读的 currentSpace 在下方解析出真实空间后回填 —— TabManager 只在运行时读它，
  // 因此不存在「窗口创建早于 profileService」的时序问题。
  let currentSpace: SpaceIdentity = { profileId: 'default', spaceId: 'default' }
  const spaceRuntime = {
    getCurrent: () => ({ ...currentSpace }),
    setCurrent: ({ profileId, spaceId }: Partial<SpaceIdentity> = {}) => {
      currentSpace = { profileId: String(profileId || 'default'), spaceId: String(spaceId || 'default') }
      return { ...currentSpace }
    }
  }

  // ── 浏览器窗口装配器（多窗口第四步）─────────────────────────────
  // shared 是**可变**共享上下文：下面边构造边回填，装配器晚段用时再解析
  // （与本文件顶部 extensionOptionsPort 同一口径 —— 避开 const 的 TDZ）。
  /** 生命周期插槽适配器的回填位（在插槽调度器之后创建，见下方 slotLifecycle）。 */
  let slotLifecycleRef: CallablePort | null = null
  /** 小窗预览控制器（N1）的回填位：建好前端口存在但什么都不做（用户不可能在启动期点它）。 */
  let peekController: PeekControllerPort | null = null
  /**
   * 站点守卫（弹窗 / 自动下载）的实例位。
   *
   * 它依赖权限服务 —— 后者在本文件更下方才创建，所以这里只能先占位：两个端口
   * （`windowShared.guardWindowOpen` / `guardDownload`）都是**延迟解析**，守卫就绪前
   * 一律放行（这个窗口期内用户不可能触发这两类动作）。
   */
  let siteGuard: SiteGuardPort | null = null
  let tabClosedCleanup: ((tabId: string) => void) | null = null
  const windowShared: SharedWindowContext = {
    runtimeRegistry,
    windowRegistry,
    sessionsController,
    windowState,
    // 标签领域端口（模块级 const，已就绪）
    tabRules,
    tabAdjust,
    tabStacks,
    // 分屏组端口（与 tabStacks 平级、正交；见 domain-tabs#TabSplits）
    tabSplits,
    // 速览组端口（第三条正交维度：叠放；见 domain-tabs#TabGroups）
    tabGroups,
    // 延迟端口：下面 settingsService 建好后回填
    getPdfViewerEnabled: () => pdfViewerEnabledPort(),
    // 分屏选项（默认方向 / 最多格数）：同样是延迟端口，改动后下一次分屏操作生效
    getSplitOptions: () => splitOptionsPort(),
    getAutoPictureInPictureEnabled: () => autoPipEnabledPort(),
    getExtraTabWebPreferences: () => extraTabWebPreferencesPort() as unknown as Record<string, unknown>,
    // 延迟解析：这些服务在本行之后才创建
    getFaviconService: () => faviconService,
    getHistoryService: () => historyServiceRef,
    getExtensionService: extensionServiceForProfile,
    getSearchService: () => searchService,
    // 书签服务：装配层用它判定"侧栏这一页已收藏还是没收藏"（面级命令 `bookmark`
    // 要据此开编辑窗还是新增窗）—— 延迟解析，它在下方才创建。
    getBookmarkService: () => bookmarkService,
    // 页面右键菜单的**插件插槽**项（webview.context-menu.item）：
    // 延迟端口 —— 插槽调度器与菜单适配器在本行之后才创建。
    getSlotMenuItems: (contents: unknown, params: unknown) => getSlotMenuItems(contents as WebContents | null, params as ContextMenuParams | null),
    // 网页生命周期插槽（webview.lifecycle.*）：延迟端口，同上
    getSlotLifecycle: () => slotLifecycleRef,
    // 用户脚本（插件贡献面 `contributes.userscripts`）：URL → 该页要执行的脚本代码（**Promise**：
    // `@require` 取码可能要联网）。注入方负责在 apply 前复核页面没跳走。
    // 与 getPluginBangs 同一口径 —— 插件表面在本文件下方才创建，按值取会拿到 null。
    getUserScriptsForUrl: (url: string) => {
      if (!pluginSurfaces) return Promise.resolve('')
      try { return Promise.resolve(pluginSurfaces.resolveUserScriptsForUrl(url)) } catch (e) {
        console.warn('[main] 用户脚本解析失败：', errorMessage(e))
        return Promise.resolve('')
      }
    },
    // 声明式页面补丁（PART18 `contributes.pagePatches`）：URL → `{ css, js }`。
    // 与用户脚本同一时机注入（onDidFinishLoad），但**形状不同**：补丁是"往已有页面上叠样式/脚本"，
    // 用户脚本是"整段脚本"，两者在 browser-window-runtime 里合并成一个注入块。
    getPagePatchesForUrl: (url: string) => {
      if (!pluginSurfaces) return { css: '', js: '' }
      try { return pluginSurfaces.resolvePagePatchesForUrl(url) } catch (e) {
        console.warn('[main] 页面补丁解析失败：', errorMessage(e))
        return { css: '', js: '' }
      }
    },
    // 数据域的 profile 作用域：标签事件（标题/favicon/导航）写库时由窗口声明自己属于哪个用户
    runAsProfile: (profileId: string, fn: () => unknown) => runtimeRegistry.runWithProfile(profileId, fn),
    // ── 站点守卫（页面行为型权限）──────────────────────────────────────
    // 「一次弹多个窗口 / 连续触发多次下载」的判定与询问在 main/site-guard.js，
    // 两个入口（标签弹窗钩子、下载 will-download）共用这一份规则。
    // 延迟解析 `siteGuard`（权限服务就绪后才建）；未就绪时放行 = 与改造前一致。
    guardWindowOpen: (payload: UnknownRecord) => (siteGuard ? siteGuard.evaluatePopup(payload) : true),
    guardDownload: (payload: UnknownRecord) => (siteGuard ? siteGuard.evaluateDownload(payload) : true),
    getSafeBrowsingWarning: (url: string) => {
      try {
        return issueSafeBrowsingWarning(url)
      } catch {
        return ''
      }
    },
    // 新窗口空间归属 + 首个标签地址（均延迟解析：依赖下方构造的服务）
    getWindowSpace: () => null,
    // 「关闭最后一个标签」替换地址 / 新窗口首个标签：都要**实际**会落到的地址，
    // 所以带上 opts（incognito / containerProfileId）—— 无痕标签不能拿扩展覆盖地址。
    // 注意：普通的 `newTab({ url: defaultNewTabUrl() })` 传的是设置口径的基准地址，
    // 扩展覆盖由 TabManager 的 onResolveTabUrl 钩子按标签自己的会话身份应用。
    getNewTabUrl: (opts?: { incognito?: boolean; containerProfileId?: string | null; profileId?: string }) => resolveNewTabUrl(settingsService, opts),
    onTabClosed: (tabId: string) => {
      try { tabClosedCleanup?.(tabId) } catch (_) {}
    },
    // 以下由下方各构造点回填（emit / snapshotService 等）
    emit: () => 0,
    // 「某面板实际所在侧」广播口（同样由下方 registerCoreIpc 回填，延迟解析）：
    // 每个窗口的 LayoutCoordinator 用它把面板被换到哪一侧告诉那个面板的宿主。
    emitPanelSideChanged: () => {},
    snapshotService: null,
    keybindings: null,
    themeManager: null,
    // 子窗口打开：父子锚点必须用**发起方窗口**（多窗口下才有正确模态/置顶）
    openSubWindow: (type, payload, runtime) => openSubWindowByType(type, payload, runtime),
    // 「在小窗中预览链接」（N1，链接右键）：小窗是应用级单例，端口在这里（控制器在下方建好并回填）。
    // ⚠ 失败必须可见 —— 早先这里 `catch (_) {}` 把一切吞掉，表现就是"点了没反应"。
    // 载荷带**发起页的 session**（小窗里的网页沿用它，才能共享登录态）与**发起窗口**
    // （小窗的生命周期绑在它上面：主窗口关掉 → 小窗一起关，见 main/peek.js）。
    openPeekPreview: ({ url, session, originWindow }: { url?: string; session?: Session; originWindow?: BrowserWindowRuntime; [key: string]: unknown } = {}) => {
      try {
        if (!peekController) {
          console.warn('[peek] 控制器尚未就绪，忽略本次请求')
          return
        }
        if (!url) return
        const res = peekController.open({ url, session, originWindow })
        if (res && res.ok === false) console.warn('[peek] 未打开:', res.reason)
      } catch (e) {
        console.error('[peek] 打开失败:', errorMessage(e))
      }
    },
    confirmWindowClose: async () => true
  }
  /**
   * 设置读写端口：给窗口运行单元（缩放记忆落库 / WCO 建窗判定）用。
   *
   * 为什么不是直接赋 settingsService：那会把"域服务实例"泄漏给所有窗口代码。
   * 端口只暴露 KV 两个动作，落在哪个 profile / 存储上仍是 settingsService 自己的事。
   *
   * ⚠ 必须在主窗口 open()（下方）之前回填：主窗口的 WCO（系统原生窗口控制按钮）
   * 判定要在**建窗时**读设置（browser-window-assembly#open 里 resolveWindowControlsMode），
   * 而 settingsService 本体也已提前到建窗前创建（见上方 532 行附近的同名注释）。
   */
  windowShared.settingsService = {
    get: (key) => { try { return settingsService.get(key) } catch (_) { return null } },
    set: (key, value) => { try { settingsService.set(key, value) } catch (_) {} }
  }

  const browserWindows = createBrowserWindowAssembly(windowShared)

  // 按「本次调用的发起窗口」解析标签条：
  //   · 插件（tabs-service）用它 —— 插件 provider 经 IPC 执行时正处于发送方上下文；
  //   · 没有上下文时（启动期、定时器）回落主窗口，与单窗口时完全一致。
  const scopedTabManager = runtimeRegistry.scoped('tabManager')
  // 命名会话（N14）：存/列/恢复/删。`tabManager` 用 scoped 代理 ——
  // 恢复的标签要落在**发起它的那个窗口**上（与其余按窗口能力同一口径）；
  // `settings` 是覆盖层服务（`sessions.named` 随 profile 隔离）。
  const namedSessions = createNamedSessions({ settings: settingsService, tabManager: scopedTabManager })

  // 小窗预览（N1）：应用级单例（同时只留一个小窗）。
  // 「升级为标签」落到**当前上下文解析出的那个窗口**的标签条（targetTabs）——
  // 小窗自身不是窗口运行单元，用常规定位即可（与「主页」按钮同一口径）。
  peekController = createPeekController({
    openInTab: (url: string) => {
      try {
        void Promise.resolve(targetTabs().newTab({ url })).catch((error: unknown) => {
          console.error('[peek] open in tab failed:', errorMessage(error))
        })
      } catch (error) {
        console.error('[peek] open in tab failed:', errorMessage(error))
      }
    },
    windowRegistry
  })
  // 「全部窗口」聚合口：定时/全局任务（自动休眠、内存回收）必须覆盖每一个窗口，
  // 否则第二个窗口的标签永远不睡 —— 功能看着在、其实只覆盖一个窗口。
  const tabsFanout = browserWindows.tabsFanout()
  // 布局聚合口：主题 / 侧栏位置这类**状态设置**必须作用到每一个窗口（不是只改主窗口）
  const layoutFanout = browserWindows.layoutFanout()

  const primaryWindow = browserWindows.open({
    isPrimary: true,
    incognito: coldJumpListAction === 'windowNewIncognito',
    spaceRuntime
  })
  const { win, webContentsManager, layoutCoordinator } = primaryWindow
  mainWindowRef = win
  console.log('[main] main window created')

  // 之前 C18: 关闭到托盘。已移除 — 关闭即退出，与 Hira/RT 一致

  // C10: Initialize extension system BEFORE creating tabs (session must be set)
  // Profile 数据隔离：每个 profile 使用独立的 session partition
  // 必须先创建 db 和 profileService 才能获取活动 profile
  //
  // ── 数据库提供者（PART16 L2）：单库 / 按 profile 拆库 ─────────────────
  //   single（升级前 / 回退）：`<userData>/hira-ng.db` 一个库 + `profile_id` 列分区；
  //   split （物理独立）：`<userData>/global.db`（profiles / kv）+
  //                       `<userData>/profiles/<id>/hira-ng.db`（业务表）。
  // 模式由磁盘事实决定（见 resolveDbIsolationMode）。
  const userDataDir = app.getPath('userData')
  const dbProvider = createDbProvider({
    rootDir: userDataDir,
    profileDirOf: resolveProfileDir,
    getProfileId: currentProfileId,
    mode: resolveDbIsolationMode(userDataDir),
    dbFileName: DB_FILE_NAME,
    globalDbFileName: GLOBAL_DB_FILE_NAME
  })
  // 域服务拿到的 `db` 是**路由代理**：每次 `db.xxx` 都按"当前 profile"现取对应库。
  // 于是域代码零改动、切 profile 也无需重建服务（见 infra-db#createDbProvider）。
  const db = dbProvider.db
  // hasFts：FTS5 可用性（据当前库探测；同一 SQLite 构建下各库一致）
  const hasFts = dbProvider.hasFts
  // ── Space 域先于 Profile 域构造 ──────────────────────────────
  // domain-profile 通过注入的 spacePort 联动空间（创建 profile 建同名默认空间、
  // 删除 profile 清空其空间），domain 层之间**不互相 require** —— 编排在 APPS 层。
  // ⚠ spaceService 是**跨 profile 寻址**的（list/listAll/get/removeByProfile/move 都按入参
  //   profileId 定位）：物理独立后必须显式按 pid 取库，不能用"当前库"隐式路由 ——
  //   否则"给别的 profile 建默认空间 / 删别的 profile 的空间"会落到当前用户的库上。
  let profileService!: ProfileServicePort
  const spaceService = createSpaceService(db, {
    dbOf: (pid: string) => dbProvider.forProfile(pid).db,
    listProfileIds: () => (profileService && typeof profileService.list === 'function'
      ? profileService.list().filter((p): p is ProfileRecord => Boolean(p)).map((p) => p.id).filter(Boolean)
      : [])
  })
  const spacePort = {
    ensureDefaultSpace: (profileId: string, name: string) => spaceService.ensureDefault(profileId, name),
    removeByProfile: (profileId: string) => spaceService.removeByProfile(profileId)
  }
  /**
   * 删除 profile 时的**物理数据清理**端口。
   *
   * 物理独立后 profile 的数据就住在它自己的目录里 —— 删除 profile 必须连目录一起清，
   * 否则"已删除的用户"的数据会继续躺在磁盘上（隔离意义上的退步，见 PART16 §6）。
   * 先关库再删目录：Windows 上被打开着的 SQLite 文件删不掉。
   */
  const dataPort = {
    removeProfileData: (profileId: string) => {
      try { dbProvider.closeProfile(profileId) } catch (_) {}
      try { fs.rmSync(resolveProfileDir(profileId), { recursive: true, force: true }) } catch (_) {}
    }
  }
  // profile 的**元数据**住全局库（枚举所有 profile）；业务数据住各自的库 —— 两条线。
  profileService = createProfileService(dbProvider.global().db, { spacePort, dataPort })
  // favicon 服务提前创建，注入 TabManager（page-favicon-updated 时缓存+同步）
  const faviconService = createFaviconService(db, { getProfileId: currentProfileId })
  // 本地图标字节读取口：`hira://favicon/?icon=<hash>` 由协议层转到这里（内容寻址、
  // 零联网）。导入时从源浏览器 Favicons 库搬进来的字节就靠它出图，见 import/apply-icons.js。
  setFaviconIconPort((hash: string) => faviconService.getIcon(hash))
  profileService.ensureDefault()

  // Layout Studio：文档、revision 与 scope binding 都走 SQLite；服务只认仓库端口。
  const layoutRepository = createLayoutRepository({ sqlite: dbProvider.sqlite })
  const layoutService = createLayoutService({
    repository: layoutRepository,
    getDefaultScope: () => {
      const runtime = runtimeRegistry.currentOrNull()
      const scope = runtime?.spaceRuntime?.getCurrent?.() || currentSpace
      return {
        profileId: String(scope?.profileId || currentProfileId()),
        spaceId: String(scope?.spaceId || 'default'),
        context: 'default'
      }
    }
  })

  // ── 启动自愈：清掉上次异常退出残留的临时（无痕）profile ──────────────
  // 临时 profile 本该"窗口关了就没了"，但崩溃 / 强杀时来不及回收，会在 DB 里留下
  // 一条 `ephemeral = 1` 的行、磁盘上留下一个目录 —— 且它被 `listVisible` 过滤掉，
  // **用户永远看不到**，只会无声累积。放在这里（profile 服务就绪后、界面可操作前）
  // 是因为它要同时动 DB 行与磁盘目录，属于组合根的职责（见 ephemeral-cleanup.js）。
  try {
    const { removed } = cleanupStaleEphemeralProfiles({
      profileService,
      resolveProfileDir,
      // 物理独立后临时 profile 的数据在它自己的目录里 —— 删目录前先关掉它的库连接
      closeProfileDb: (id: string) => dbProvider.closeProfile(id)
    })
    if (removed.length) console.log('[main] cleaned stale ephemeral profiles:', removed.join(', '))
  } catch (e) {
    console.warn('[main] ephemeral cleanup failed:', errorMessage(e))
  }

  // ── 配置档案归档（G1 导出 / G2 导入）─────────────────────────────
  // 引擎只做「读/写归档 + 落库/落盘」，依赖全是端口（按 profile 取库 / profileService /
  // 目录解析 / 空间兜底）；文件对话框与路由在 ipc/profile-archive.js。
  // ensureDefaultSpace 只在归档里没有任何空间时才被用到（补一个默认空间，别成了空壳）。
  const profileArchive = createProfileArchive({
    // 按 profileId 取**裸 sqlite 句柄** —— 物理独立后导出/导入各自的库；
    // 单库模式下 forProfile() 恒返回同一个句柄，行为不变。
    sqliteOf: (profileId: string) => dbProvider.forProfile(profileId).sqlite,
    profileService,
    resolveProfileDir,
    ensureDefaultSpace: (profileId: string, name: string) => spaceService.ensureDefault(profileId, name),
    appName: app.getName(),
    appVersion: app.getVersion()
  })
  const settingsActions = createProfileArchiveActions(profileArchive, profileService)
  settingsActions.register(SETTINGS_ACTION_ROUTES.setDefaultBrowser, () => applyDefaultBrowser())

  // ── 空间归档（导出 / 导入）─────────────────────────────────────
  // 只搬「空间目录」下的白名单 JSON（settings / session）；空间元数据走 spaceService。
  // 导入永远在目标 profile 下**新建**空间（id / name 冲突一律让步），绝不覆盖。
  const spaceArchive = createSpaceArchive({
    spaceService,
    resolveProfileDir,
    // 导出前把内存里的会话同步落盘（D8 是 2s 批量 flush，不 flush 会导出旧快照）。
    // 多窗口分片也一并刷：主窗口 session.json + 其他窗口 session-w<n>.json 都在空间目录里。
    flushSessions: () => {
      sessionWindows.flushAllSync()
    },
    appName: app.getName(),
    appVersion: app.getVersion()
  })

  // 分享 / 二维码（N15）：把一段文本编成 QR 的 SVG（`qr` 是 Node 侧依赖，
  // 内部页没有打包器，故生成留在主进程）。
  const shareService = createShareService()

  let activeProfile = profileService.getActive()

  // ── 空间运行态（对齐 RT Window.currentSpaceId：每窗口一个当前空间）──
  // APPS 层持有；spaceService 只负责持久层（order/lastUsed）。会话按空间隔离，
  // 落 `userData/profiles/<profileId>/spaces/<spaceId>/session.json`。
  function sessionDirFor(profileId: string, spaceId: string): string {
    const rel = spaceService.relPath(profileId, spaceId)
    return rel
      ? path.join(app.getPath('userData'), ...rel.split('/'))
      : resolveProfileDir(profileId)
  }
  /** 启动时的初始空间：优先「上次使用」，否则默认空间。 */
  function resolveStartupSpace(profile: ProfileRecord | null | undefined) {
    if (!profile) return { id: 'default', profileId: 'default' }
    return spaceService.getLastUsed(profile.id)
      || spaceService.ensureDefault(profile.id, profile.name)
      || { id: 'default', profileId: profile.id }
  }
  let activeSpace = resolveStartupSpace(activeProfile)
  // PWA 冷启动可以显式指定 profile / 空间（快捷方式参数 `--pwa-profile=` / `--pwa-space=`）：
  //   · 只改**窗口运行态**，不碰全局 active profile —— 双击桌面应用不应改变
  //     「下次正常启动浏览器用哪个 profile」这个用户设置；
  //   · 不写 lastUsed —— 打开一个应用不等于「我打开了浏览器」。
  const coldProfileId = coldPwa && coldPwa.profileId ? String(coldPwa.profileId) : ''
  const coldSpaceId = coldPwa && coldPwa.spaceId ? String(coldPwa.spaceId) : ''
  // 空间运行态对象已在窗口创建前建好（TabManager 的 context 端口）——此处只回填真实值。
  spaceRuntime.setCurrent({
    profileId: coldProfileId || activeSpace?.profileId || activeProfile?.id || 'default',
    spaceId: coldSpaceId || activeSpace?.id || 'default'
  })
  // 进入即记为「使用中」：下次启动的 lastUsed 排序才反映真实使用习惯（RT setLastUsed 同语义）
  if (!coldPwa) spaceService.setLastUsed(activeSpace.profileId, activeSpace.id)
  console.log('[main] active space:', activeSpace?.id, 'profile:', activeSpace?.profileId)
  // 新窗口的空间归属：取**发起窗口**的当前空间（对齐 RT spacesController.getLastUsed）。
  // 按运行单元取值而不是读全局 activeSpace —— 否则 B 窗口点「新窗口」会拿到 A 窗口的空间。
  windowShared.getWindowSpace = (source) => {
    const rt = source && source.spaceRuntime ? source : (browserWindows.focused() || primaryWindow)
    try {
      const cur = rt && rt.spaceRuntime && typeof rt.spaceRuntime.getCurrent === 'function'
        ? rt.spaceRuntime.getCurrent()
        : null
      if (cur && cur.spaceId) return cur
    } catch (_) {}
    return {
      profileId: activeSpace?.profileId || activeProfile?.id || 'default',
      spaceId: activeSpace?.id || 'default'
    }
  }
  console.log('[main] active profile:', activeProfile?.name)

  let tabManager = null
  // 标题回写历史的延迟句柄：historyService 在下方才创建，而 TabManager 需先于它构造；
  // 用可变引用解耦时序，hook 运行时（初始化完成后）才取到真实服务。
  let historyServiceRef: CallablePort | null = null

  // 目标窗口访问口（在下面 bootstrapCoreModules 之前定义，此处先声明以被 makeExtCallbacks 使用）
  const focusedRuntime = () => browserWindows.focused() || primaryWindow

  function makeExtCallbacks(profileId: string) {
    const runtimeProfile = (rt: ReturnType<typeof focusedRuntime> | null | undefined) => {
      try { return String(rt?.spaceRuntime?.getCurrent?.()?.profileId || 'default') } catch (_) { return 'default' }
    }
    const runtimeSpaceId = (rt: ReturnType<typeof focusedRuntime> | null | undefined) => {
      try { return String(rt?.spaceRuntime?.getCurrent?.()?.spaceId || 'default') } catch (_) { return 'default' }
    }
    const profileRuntimes = () => browserWindows.all().filter((rt) => runtimeProfile(rt) === profileId)
    const targetRuntime = (windowId?: unknown) => {
      const candidates = profileRuntimes()
      const requestedWindowId = Number(windowId)
      if (Number.isFinite(requestedWindowId)) {
        return candidates.find((candidate) => candidate.win.id === requestedWindowId)
      }
      const focused = focusedRuntime()
      return candidates.find((candidate) => candidate === focused) || candidates[0]
    }
    const targetSpaceId = (rt?: ReturnType<typeof focusedRuntime> | null) => {
      if (rt) return runtimeSpaceId(rt)
      try { return String(spaceService.getLastUsed(profileId)?.id || 'default') } catch (_) { return 'default' }
    }
    const createTabIn = async (rt: ReturnType<typeof focusedRuntime>, url: string, openInBackground = false) => {
      const result = await rt.tabManager.newTab({ url, openInBackground })
      const view = rt.webContentsManager.createTab(result.tabId)
      return view ? [view.webContents, rt.win] as const : null
    }
    let creatingRuntime: Promise<ReturnType<typeof focusedRuntime>> | null = null
    const ensureRuntime = async (windowId?: unknown) => {
      const existing = targetRuntime(windowId)
      if (existing) return existing
      if (windowId != null) return null
      if (!creatingRuntime) {
        creatingRuntime = browserWindows.openNewWindow({
          profileId,
          spaceId: targetSpaceId(),
          skipInitialTab: true,
          focus: true
        }).finally(() => { creatingRuntime = null })
      }
      return await creatingRuntime
    }

    return {
      createTab: async (details: string | { url?: string; windowId?: number; active?: boolean } | undefined) => {
        // `chrome.tabs.create` 不带 url = 开一张新标签页（Chrome 语义），不是 about:blank。
        // 这里只给设置口径的基准地址；扩展覆盖由 TabManager 按标签会话身份应用。
        const raw = typeof details === 'string' ? details : details?.url
        let url = typeof raw === 'string' ? raw : ''
        if (!url) {
          // 只给设置口径的基准地址；扩展覆盖由 TabManager 按会话身份应用。
          // （settingsService 在本闭包建立前已就绪，直接解析可避开 defaultNewTabUrl 的 TDZ。）
          try { url = resolveHomeUrl(settingsService) } catch (_) { url = 'about:blank' }
        }
        const requestedWindowId = typeof details === 'object' && details ? details.windowId : undefined
        const rt = await ensureRuntime(requestedWindowId)
        if (!rt) return [null, null]
        return await createTabIn(rt, url, typeof details === 'object' && details?.active === false) || [null, null]
      },
      selectTab: (webContents: WebContents | null | undefined) => {
        if (!webContents) return
        // 扩展给的 webContents 可能属于任何一个窗口 —— 逐窗口问「这是你的标签吗」，
        // 而不是假定它属于主窗口。
        for (const rt of browserWindows.all()) {
          const tabId = rt.tabManager.getTabIdByWebContents(webContents)
          if (tabId) { rt.tabManager.switchTo(tabId); return }
        }
      },
      removeTab: (webContents: WebContents | null | undefined) => {
        if (!webContents) return
        for (const rt of browserWindows.all()) {
          const tabId = rt.tabManager.getTabIdByWebContents(webContents)
          if (tabId) { rt.tabManager.close(tabId); return }
        }
      },
      /**
       * `chrome.windows.create`：ECE 的契约本来就是异步返回 `BaseWindow`。
       * 新窗口必须仍属于该扩展所在的 profile；同 profile 暂无窗口时按该 profile
       * 最近使用的 Space 新开一个，绝不借用当前焦点的另一个用户窗口。
       */
      createWindow: async (details: {
        url?: string | string[]
        width?: number
        height?: number
        left?: number
        top?: number
        focused?: boolean
      } = {}) => {
        const source = targetRuntime()
        const runtime = await browserWindows.openNewWindow({
          opener: source || undefined,
          profileId,
          spaceId: targetSpaceId(source),
          skipInitialTab: true,
          focus: details.focused !== false,
          bounds: {
            x: details.left,
            y: details.top,
            width: details.width,
            height: details.height
          }
        })
        const urls = Array.isArray(details.url) ? details.url : [details.url || '']
        for (let index = 0; index < urls.length; index++) {
          let url = urls[index]
          if (!url) {
            try { url = resolveHomeUrl(settingsService) } catch (_) { url = 'about:blank' }
          }
          await createTabIn(runtime, url, index > 0)
        }
        return runtime.win
      },
      removeWindow: (electronWindow: BrowserWindow | null | undefined) => {
        if (!electronWindow || electronWindow.isDestroyed()) return
        // 对齐 RT：扩展明确调用 chrome.windows.remove 时直接释放窗口，不能让
        // beforeunload / 关闭确认把 API 变成静默失败。
        try { electronWindow.destroy() } catch (_) {}
      },
      /**
       * 补齐 `chrome.tabs.Tab` 上 ECE 默认实现没有的字段（对齐 RT
       * loaded-profiles-controller/index.ts:127-136 的同一个回调）。
       *
       * 为什么需要：ECE 默认只给 id/index/active/selected/status/title/url/width/windowId
       * —— `title` / `url` 取自 webContents 本身（比 RT 那份更准，故保留不动），
       * 但 `favIconUrl` / `discarded` / `autoDiscardable` **完全缺失**：
       * 扩展的标签管理类 UI 会显示不出站点图标，判断「标签是否休眠」也永远为 false。
       *
       * 必须是**同步**实现（ECE 在 getTabDetails 里同步调用后即写进缓存）；
       * 逐窗口问「这个 webContents 是你的标签吗」—— 与 selectTab / removeTab 同一口径，
       * 多窗口下不会张冠李戴。拿不到对应标签就原样返回，不编造字段。
       * @param {chrome.tabs.Tab} details
       * @param {Electron.WebContents} webContents
       */
      assignTabDetails: (details: UnknownRecord | null | undefined, webContents: WebContents | null | undefined) => {
        if (!details || !webContents) return
        for (const rt of browserWindows.all()) {
          const tabId = rt.tabManager.getTabIdByWebContents(webContents)
          if (!tabId) continue
          const tab = rt.tabManager.listAll().find((item: UnknownRecord) => item.tabId === tabId)
          if (!tab) return
          if (tab.favicon) details.favIconUrl = tab.favicon
          // NG 的「休眠」对应 Chrome/RT 的 discarded（tab.asleep）语义。
          details.discarded = Boolean(tab.sleeping)
          // 与 RT 同口径：丢弃时机由 NG 自己的休眠策略掌握，不让浏览器再自动丢弃。
          details.autoDiscardable = false
          return
        }
      }
    }
  }

  /**
   * 获取/创建某 profile 的扩展系统（ECE）。
   * 关键：`session` 复用 `sessionsController.get(profileId)` —— 标签与扩展共用同一
   * Session 对象，profile 隔离才真正生效（旧实现让 ECE 自建 partition 会话、标签用另一套，
   * 二者错位，既浪费内存又导致 cookie/存储不一致）。
   * 单飞加载器保证并发调用只实例化一次（ECE 重复实例化会抛错）。
   */
  function getOrCreateExtensionService(profileId: string | null | undefined) {
    const id = String(profileId || 'default')
    return loadedProfiles.load(id, async () => {
      const extPath = path.join(resolveProfileDir(id), 'extensions')
      const svc = await createExtensionService({
        profileId: id,
        // 只注入 session（= profiles/<id> 的 fromPath 会话）：扩展与标签共用同一
        // Session 对象，profile 隔离由目录唯一决定。**不再传 partition** ——
        // 旧口径的 `persist:profile-<id>` 与磁盘目录脱钩，是隔离失效的旧实现残留。
        session: sessionsController.get(id),
        // 扩展系统选项由运行时端口提供：settingsService 在本函数之后才创建，
        // 直接引用会踩 TDZ，因此走一个「先默认、后回填」的延迟端口。
        ...extensionOptionsPort(),
        extensionsPath: extPath,
        // 扩展会话的 hira preload（identity 桥 + chrome://favicon 兼容，合并为一份）。
        // 打包链把 src 原样复制到 out/main，因此这个相对 __dirname 的路径在开发态
        // 与安装包内都成立；infra 只在确有已启用扩展时注册它（见 syncExtensionPreloads）。
        extensionPreloadPath: path.join(__dirname, 'preload', 'extension-preload.js'),
        // 广告拦截 cosmetic preload 的替换件（每个 frame 都跑，库里那份 9KB 且
        // DOMContentLoaded 时同步全文档扫描；见 infra-extensions/src/cosmetic-preload.js）。
        cosmeticPreloadPath: path.join(__dirname, 'preload', 'adblock-cosmetic-preload.js'),
        callbacks: makeExtCallbacks(id)
      })
      // identity IPC 的 MV3 worker 通道是**按 worker 挂载**的（不走全局 ipcMain），
      // 所以每个新建服务的会话都要交给桥注册一次；注册晚于本函数时句柄为 null，
      // 由桥在注册时遍历 listLoadedExtensionServices() 补挂。
      try { attachIdentitySessionRef?.(svc.session) } catch (_) {}
      // 把「扩展弹窗」的窗口能力注入进去：
      //   · open  —— ECE 管线走不通时由 NG 的无边框弹窗窗口承载（绑该 profile 的 session）
      //   · close —— profile 切换 / 服务销毁时收口，避免残留窗口引用
      //   · track —— ECE 自己建的弹窗窗口登记进窗口注册表（对齐 RT 的 extensionPopup.new）
      svc.setPopupSupport({
        open: (opts: UnknownRecord) => extensionPopup.open(opts),
        close: () => extensionPopup.close(),
        track: (popup: unknown) => extensionPopup.track(popup)
      })
      // 启动恢复（按安装记录把扩展加载回来）在 infra 里后台跑，这里只记录结果日志，
      // 不阻塞启动路径 —— 与 adblocker 同一口径。
      Promise.resolve(typeof svc.whenReady === 'function' ? svc.whenReady() : null)
        .then((stats) => {
          if (stats) console.log('[main] extension restore:', JSON.stringify(stats))
        })
        .catch(() => {})
      return svc
    })
  }

  let extensionService = await getOrCreateExtensionService(String(activeProfile?.id || 'default'))
  console.log('[main] init timing: extensionService took', Date.now() - _t0, 'ms')

  /**
   * 扩展服务的唯一归属解析口。
   *
   * 有显式 profileId 时必须尊重它；没有时读取当前 IPC / 事件作用域。找不到对应
   * service 返回 null，绝不回退到“全局活动扩展服务”—— 那会让 B profile 的窗口
   * 操作到 A profile 的安装记录、图标与新标签覆盖。
   */
  function extensionServiceForProfile(profileId?: string | null) {
    const id = String(profileId || runtimeRegistry.currentProfileId() || 'default')
    return loadedProfiles.get(id) as typeof extensionService | null
  }

  let extensionRelayRef: { removeService(service: unknown): void } | null = null

  /**
   * profile 删除后的运行态收尾。仅删除 DB 行与磁盘目录不够：Session、ECE、
   * 广告拦截器、生命周期订阅都属于进程内对象，必须一起释放，否则会形成
   * “DB 里不存在、内存里仍活着”的常驻对象；正在创建的 profile 由 single-flight
   * 的 revision 机制阻止其晚到结果重新写回缓存。
   */
  function disposeProfileRuntime(profileId: string) {
    const id = String(profileId || '')
    if (!id) return
    const service = loadedProfiles.get(id) as typeof extensionService | null
    if (service) {
      try { extensionRelayRef?.removeService(service) } catch (_) {}
      try { if (service.session) detachIdentitySessionRef?.(service.session) } catch (_) {}
      try { service.destroy?.() } catch (_) {}
    }
    loadedProfiles.clear(id)
    downloadServiceProxies.delete(id)
    sessionsController.forget(id)
    if (extensionService === service) {
      const activeId = String(activeProfile?.id || 'default')
      extensionService = loadedProfiles.get(activeId) as typeof extensionService | null
    }
  }

  // 标签会话由 sessionsController 按 profile 解析（sessionResolver 已注入 WebContentsManager），
  // 这里只需把 hira:// 协议 / 外部游戏注册到该 profile 的会话上。
  registerHiraProtocol(extensionService.session)
  registerPluginProtocol(extensionService.session, pluginProtocolOptions)
  // 主题背景图同理：渲染层的实际会话是这个 profile 的会话，协议必须挂在它上面
  //（挂默认会话只够"恰好用了默认会话"的那些窗口，那是巧合而不是保证）。
  registerThemeAssetProtocol(extensionService.session, { root: themeAssetRoot })
  externalGames.registerOn(extensionService.session)
  // 扩展覆盖新标签页（chrome_url_overrides.newtab）：把**查询口**交给地址解析层
  // （home-url.js 的 resolveNewTabUrl / TabManager 的 onResolveTabUrl 钩子）。
  //
  // ⚠ 绝不能在 hira:// 协议层做 302 重定向：Chromium 会把
  //   `chrome-extension://<id>/…` 当网络地址走 DNS（扩展 id 被当域名）→
  //   ERR_NAME_NOT_RESOLVED → 「无法访问此网站」。扩展页只能由浏览器主动 loadURL
  //   （实测直接导航完全正常），所以替换点在「建标签 / 导航前」，不在协议层。
  //
  // 用 getter 而不是把地址拷进来：profile 切换会**重建** extensionService（见下面几处
  // `extensionService = await getOrCreateExtensionService(...)`），闭包读的是当前引用，
  // 因此切换 profile 后新标签页立刻跟随新 profile 的扩展，无需在切换路径上重复注册。
  setNewTabOverrideProvider((profileId?: string) => {
    const service = extensionServiceForProfile(profileId)
    return service && typeof service.getNewTabOverrideUrl === 'function' ? service.getNewTabOverrideUrl() : ''
  })
  // 扩展图标（hira://extension-icon?id=<id>）：清单里的 icons 只是扩展目录内的相对路径，
  // 直接进 <img src> 必然 404（详见 infra-extensions#getExtensionIconAsset 的注释）。
  // 同样是 live getter —— profile 切换会重建 extensionService，图标源随之切到新 profile。
  setExtensionIconPort((id: string, profileId?: string) => {
    const service = extensionServiceForProfile(profileId)
    return service && typeof service.getExtensionIconAsset === 'function'
      ? service.getExtensionIconAsset(id)
      : null
  })
  console.log('[main] extension session ready for profile:', activeProfile?.id || 'default')

  // chrome = 窗口本体（对齐 RT FakeWebContentsViewLayer）：ui-shell 的 webContents
  // 就是 win.webContents，不再有独立 view。所有 chrome 侧 IPC 目标即此对象。
  const uiShellWebContents = win.webContents
  /**
   * 插件**运行期错误**的汇聚点 —— 连环坏判定（`lifecycle.onCrash`）的唯一输入。
   *
   * 两件事在这里完成，之后才轮到注册中心：
   *  1. **过滤域服务错误**：`service-plugin` 会给"由它调用的域服务抛出来的错"打
   *     `hiraDomainServiceError` 标记（DB 锁、网络抖动）。那类错误不该算在插件头上 ——
   *     否则一次瞬时故障累计三次就会把用户的书签引擎永久停用。
   *  2. **迟绑定到注册中心**：插件是后台启动的，这里建 sink 时 `pluginRegistry` 还不存在
   *     （与 panelCatalog / contributions 同一套路：先建壳、后灌实例）。
   */
  let pluginErrorSink: ((pluginId: string, error: unknown) => void) | null = null
  const reportPluginError = (pluginId: string | null | undefined, error: unknown) => {
    if (!pluginId) return
    if (asRecord(error).hiraDomainServiceError) return
    try { if (pluginErrorSink) pluginErrorSink(pluginId, error) } catch (_) {}
  }

  /**
   * 扩展点调度器（PART7 §7.3）—— 进程级单例，越早建越好。
   *
   * 为什么在这里而不是等插件启动：宿主要**在插件加载之前**就持有它（主题、搜索聚合…
   * 都是启动期就装好的），插件启用时再往里挂实现。与 contributions 同一套路。
   * 官方插槽表（official-extension-points.js）在这里一次性**全量**声明 ——
   * 声明先于实现，契约先立后填。数量以那张表为准，不在代码注释里写死。
   *
   * `onError` 接的是连环坏判定：插槽实现是**插件自己的代码**，它反复抛错正是
   * `onCrash` 要防的"连环坏"（例如某个 Mod 的工具栏按钮每次点击都抛）。
   */
  const extensionPoints = createExtensionPointRegistry({
    onError: (_epId: string, error: unknown, entry: UnknownRecord) => {
      const pluginId = entry && entry.pluginId
      if (pluginId) reportPluginError(String(pluginId), error)
    }
  })
  const slotCount = registerOfficialExtensionPoints(extensionPoints)
  console.log(`[main] extension points declared: ${slotCount}`)
  /**
   * 主进程里的插槽调用器（宿主侧统一入口，见 slot-call.js）。
   * 主进程现在有四类宿主调用点：导航生命周期（`slot-lifecycle.js` 自己持一个）、
   * 菜单（`slot-menu.js`）、渲染侧描述符（`slot-render.js`），以及**域宿主**
   * （搜索聚合 / 历史过滤 / 资料切换…）—— 最后一类用这个实例。
   */
  const slotCall = createSlotCaller(extensionPoints, { label: 'main' })

  /**
   * 执行插件贡献的 schema 迁移（扩展点 `db.schema.migration`，MULTI）。
   *
   * 两个时机都走这里：① 插件启动完成之后（下方 bootstrapPluginModule 的 .then）；
   * ② 用户运行期启用某个插件之后（plugins IPC 的 `onPluginsActivated`）。
   * 两处都不能省 —— 迁移是"插件一上线就得存在的表"，晚跑等于该插件的第一条查询就炸。
   * 幂等由 infra-db 的 `_schema_migrations` 记账表保证，重复调用安全。
   *
   * 迁移描述符形态：`{ id, up(sqlite), description? }`，见 infra-db#applyMigrations。
   */
  function runPluginMigrations() {
    try {
      const raw = slotCall.multi('db.schema.migration', { source: 'app' })
      // 一个实现可能贡献多条迁移（返回数组）→ 展平一层，与其它 MULTI 宿主同一约定。
      const list = raw.flat(1).filter((m: UnknownRecord) => m && typeof m.id === 'string' && typeof m.up === 'function')
      if (!list.length) return
      // 作用于**全部已开库**（全局 + 每个 profile）并记下来：之后新开的库会自动补跑
      //（物理独立后每个 profile 一个库，插件表要在每库里都存在）。
      const result = dbProvider.migrate(list)
      if (result.applied.length) console.log(`[main] plugin schema migrations applied: ${result.applied.join(', ')}`)
      if (result.failed.length) console.warn(`[main] plugin schema migrations failed: ${result.failed.map((f: UnknownRecord) => f.id).join(', ')}`)
    } catch (e) {
      // 迁移失败**不能**拖垮启动：坏的是那个插件的表，其余功能照常。
      console.warn('[main] runPluginMigrations failed (non-fatal):', errorMessage(e))
    }
  }

  /**
   * 本地化服务（扩展点 `l10n.bundle-provider` 的宿主）。
   *
   * 内建语言包（infra-l10n/locales/*.json）是基准，插件只能**填缺**、不能覆盖 ——
   * 否则一个插件就能悄悄改掉"删除"按钮的文案（详见 infra-l10n 文件头）。
   *
   * `bundleProviders` 传的是一个**惰性 thunk**：插件是后台启动的，构造时刻它们还没到，
   * 求值必须推迟到第一次查表。插件上线后由下方 `reload()` 让新语言包生效。
   */
  const l10nService = createL10n({
    locale: 'zh-CN',
    fallbackLocale: 'en',
    bundleProviders: [() => slotCall.multi('l10n.bundle-provider', { locale: 'zh-CN' })]
  })

  /**
   * 菜单类插槽的适配器（`bookmark.context-menu` / `webview.context-menu.item` …）。
   *
   * 把插槽描述符编译成原生菜单项，并把实现的 onSelect 直接挂在 click 上 ——
   * 菜单由主进程弹、实现也在主进程跑，中间不需要任何 IPC 往返。
   * 两条宿主链路共用这一个实例：
   *   · 页面右键菜单 → shared.getSlotMenuItems（经窗口装配传给 TabManager 钩子）
   *   · 渲染层菜单（书签）→ registerCoreIpc 的 onMenuSlotItems → ui:popup-menu
   */
  const slotMenu = createSlotMenuAdapter({ extensionPoints })
  /**
   * 网页生命周期插槽适配器（webview.lifecycle.*）—— 见 slot-lifecycle.js。
   * 由 windowShared.getSlotLifecycle 延迟解析（该端口在上面就已登记）。
   */
  const slotLifecycle = createSlotLifecycle({ extensionPoints })
  slotLifecycleRef = slotLifecycle
  /**
   * 渲染侧插槽宿主的主进程一半（slots:render / slots:dispatch）。
   * 产出面在渲染层的插槽（side-panel.*）走它 —— 实现仍在主进程，
   * 渲染层只拿可序列化描述符 + 稳定 key，点击时把 key 送回来派发。
   */
  const slotRenderer = createSlotRenderer({ extensionPoints })
  /**
   * 插件开关状态的持久化（见 plugin-state-store.js）。
   *
   * 两个端口都是延迟解析的：getDomainServices 在更下面才定义、runAsProfile 依赖注册表。
   * 这里建得早，是为了让它同时能被 registerCoreIpc（写路径）与插件启动（读路径）拿到；
   * 读写的**作用域**（default = 全局）由 store 内部统一钉住，调用方不需要知道。
   */
  const pluginStateStore = createPluginStateStore({
    getSettingsService: () => getDomainServices().settingsService,
    runAsProfile: (profileId: string, fn: () => unknown) => runtimeRegistry.runWithProfile(profileId, fn)
  })
  /**
   * 用户脚本宿主运行时：`@require` 取码 + `GM_xmlhttpRequest` 代理。
   *
   * 建在这里（早于插件表面 / IPC 注册）：上面两个使用方都只拿引用、按调用时刻用，
   * 而 `getScripts` 是**晚绑定**的 —— 表面层在本文件更下方才创建。
   * 缓存目录单列在 `userData/userscript-cache`：它是**可再生的下载物**，
   * 不该混进插件目录（那会被当作"已安装的插件"扫出来）。
   */
  userScriptRuntime = createUserScriptRuntime({
    cacheDir: path.join(app.getPath('userData'), 'userscript-cache'),
    // 只喂"该执行"的脚本：`@require` / `@connect` 授权判定与注入点同一份清单。
    getScripts: () => (pluginSurfaces ? pluginSurfaces.listUserScripts() : []),
    logger: console
  })
  const getSlotMenuItems = (contents: WebContents | null | undefined, params: ContextMenuParams | null | undefined) => {
    const payload = {
      url: (() => { try { return contents && !contents.isDestroyed() ? contents.getURL() : '' } catch (_) { return '' } })(),
      linkURL: params && params.linkURL ? String(params.linkURL) : '',
      srcURL: params && params.srcURL ? String(params.srcURL) : '',
      mediaType: (params && params.mediaType) || 'none',
      selectionText: params && params.selectionText ? String(params.selectionText) : '',
      isEditable: !!(params && params.isEditable)
    }
    // 两条来源合成一个列表：**插槽实现**（代码，webview.context-menu.item）+ **声明式贡献**
    // （contributes.menus 里 where 含 webview.context 的纯数据）。调用方只认结果，
    // 不需要知道某项来自哪条腿 —— 这也是右键菜单唯一的装配点。
    const items = slotMenu.items('webview.context-menu.item', payload)
    const extra = pluginSurfaces ? pluginSurfaces.contextMenuItems('webview.context', payload) : []
    return extra.length ? items.concat(extra) : items
  }

  /**
   * 主题目录与状态（唯一主题状态源）。
   *
   * 建在这里（themeManager 之前）而不是更晚：`browser-window-assembly` 建窗时就要
   * 用 themeManager 往外壳注 token，而"当前是哪个主题、它的令牌长什么样"必须先有答案 ——
   * 否则首屏会先按出厂浅色画一遍、再被广播纠正（可见的闪一下）。
   *
   * `prime()` 做两件事：跑旧三态设置的一次性迁移、拉插件来源的主题。
   * 它**必须 await**（在建窗之前），所以这里是启动路径上少数几个同步等待点之一；
   * 代价是读一次 settings + 一次插件插槽调用，都是内存级操作。
   */
  const themeService = createThemeService({
    settings: settingsService,
    extensionPoints,
    // 主题包里的背景图走插件资产协议（`hira-plugin://`）——见 themePluginAssets 的说明。
    pluginAssets: themePluginAssets,
    // **用户主题**的图片走 `hira-theme://`（编辑器"选择图片"拷进资产库的那些）。
    // 与上面分成两口：安全边界不同，见 theme-asset-protocol.js。
    // `url` 拼地址给渲染侧；`read` 读字节给主进程量亮度（自动前景用）。
    userAssets: {
      url: (key: string) => buildThemeAssetUrl(key),
      read: (key: string) => themeAssets.read(key)
    },
    // 「每日一图」：同步读缓存，拿不到时顺手起一次后台拉取（见 theme-daily.js）
    dailyBackground: themeDaily
  })
  await themeService.prime()

  const themeManager = createThemeManager({
    // 初始值只是"在任何发布之前"的兜底；真正生效的主题由 themeRuntime.publish() 落进来。
    initialTheme: themeService.isDark() ? 'dark' : 'light',
    prefersDark: Boolean(require('electron').nativeTheme.shouldUseDarkColors),
    // 主题插槽：插件可通过 `theme.token-provider` 追加 CSS 变量（改配色 / 换字体 / 调间距）
    extensionPoints
  })
  // 调度器（跟随系统 / 夜间 21:00–06:00 / 手动时段表）：只有它知道"现在该用哪个主题"。
  // 它不直接改样式，只调 themeService.setActive → themeRuntime 订阅后发布。
  const themeScheduler = createThemeScheduler({
    settings: settingsService,
    themeService,
    nativeTheme: require('electron').nativeTheme,
    getProfileId: () => String(activeProfile?.id || 'default'),
    runWithProfile: (profileId: string, task: () => unknown) => runtimeRegistry.runWithProfile(profileId, task)
  })
  themeScheduler.start()
  attachUiShellDiagnostics(uiShellWebContents)

  // 应用级事件出口：settings / 书签 / 历史 / 下载 / 扩展 / 主题… 与「哪个窗口」无关，
  // 一律广播给所有订阅者。窗口级事件请走 emitToWindow（见下）或给 opts.windowId。
  //
  // 插件事件中枢（PART18）挂在这条出口上：插件订阅「浏览器里发生了什么」时，
  // 收到的就是**外壳本来也能收到的同一批事件**——不新增第二套事件源，也不会漏事件。
  // 实例在下方（pluginSurfaces 之前）创建，这里用可空引用解掉创建顺序。
  let pluginHubRef: PluginEventHubPort | null = null
  const emit = (route: string, payload?: unknown, opts?: UnknownRecord) => {
    if (pluginHubRef) { try { pluginHubRef.emit(route, payload) } catch (_) {} }
    return broadcaster.send(route, payload, opts)
  }
  /**
   * 窗口级事件出口：只发给**发起本次调用的那个窗口**的订阅者。
   *
   * 为什么不能直接用 emit：`space:window-changed` 这类事件的语义就是「某个窗口的
   * 当前空间变了」，广播出去会让别的窗口（的切换器/列表）跟着跳变 —— 多窗口串台。
   *
   * 为什么解析不到就**丢弃并告警**，而不是回退主窗口：本方法只在 IPC 上下文里被调用
   * （发起窗口必然可解析）；一旦解析不到，说明不是「某个窗口发起的」，此时静默改道
   * 主窗口只会把错误藏起来、并在多窗口下制造串台。宁可漏一次推送（渲染层还有
   * 主动拉取与 settings/space 广播兜底），也不要打错窗口。
   */
  const emitToWindow = (route: string, payload?: unknown) => {
    const rt = runtimeRegistry.currentOrNull()
    if (!rt || !rt.win || rt.win.isDestroyed()) {
      console.warn(`[main] ${route}: 解析不到发起窗口 → 已丢弃该窗口级事件（避免跨窗口串台）`)
      return 0
    }
    return broadcaster.send(route, payload, { windowId: rt.win.id })
  }
  // 回填装配器的共享出口：此刻起，任何窗口（含后开的）都能广播事件。
  windowShared.emit = emit
  windowShared.themeManager = themeManager

  /**
   * 注入式浮层（JS 对话框等）需要的「强调色 + 明暗」——**唯一真源仍是主题服务**。
   *
   * 这些浮层跑在网页上下文里，读不到外壳 CSS 令牌，所以必须由宿主把色值带进去。
   * 过去装配层写死了天蓝（`#0a84ff / #3b82f6`）→ 换主题后对话框按钮仍是出厂蓝。
   * 现在统一从这里取（派生规则与 `--hira-accent` 同一条：shared-types/theme.mjs）。
   *
   * @param {{ incognito?: boolean }} [opts] 私密窗口可另有皮肤
   * @returns {{ isDark: boolean, accentColor: string, borderColor: string, inputFocusBorder: string }|null}
   */
  windowShared.getAccentThemeInfo = (opts: { incognito?: boolean } = {}) => {
    try {
      const theme = themeService.getActiveThemeFor({ incognito: Boolean(opts && opts.incognito) })
      const isDark = Boolean(themeService.isDark(theme))
      const palette = derivePalette(theme)
      const accent = palette.accent
      return {
        isDark,
        accentColor: accent,
        onAccentColor: palette.onAccent,
        borderColor: withAlpha(accent, 0.5),
        inputFocusBorder: withAlpha(accent, 0.7)
      }
    } catch (_) {
      return null
    }
  }

  // ── 标签缩略图（对齐 RT hirax-internal://tab-snapshot）────────────────────────
  // 为什么需要：标签 hover 预览要展示「该标签上次可见时的画面」，而标签切走后其
  // WebContentsView 仍在（甚至可能被休眠销毁），渲染层拿不到位图。因此主进程在
  // 「标签即将隐藏」的一瞬间 capturePage 抓一帧 → 编码 JPEG → 存内存 → 渲染层经
  // hira://tab-snapshot?id=… 读回。
  //
  // 三层职责彻底分离（零耦合）：
  //   TabManager        只发「该采帧了」信号（它掌握隐藏时机）
  //   tab-snapshot.js   只管采集/编码/拼 URL
  //   SnapshotStore     只管存与淘汰（不 import electron，可单测）
  // 不在这里 start()：sweep 定时器由 store 自己按需开关（首个 put 自启、空了自停），
  // 「没人悬停标签预览」的会话里它一直是 0 定时器。
  // TTL 必须覆盖「标签休眠后仍可能被 hover 预览」的寿命：休眠阈值默认 5 分钟，
  // 若 TTL 仍是 120s，休眠瞬间刚抓到的最后一帧会在用户悬停前就先过期 ——
  // 等于白抓（D3）。容量仍由 maxEntries=32 + maxWidth=640 兜底，内存上界不变。
  const snapshotStore = createSnapshotStore({ ttlMs: 10 * 60_000, maxEntries: 32 })
  // ⚠ **必须显式给 `maxWidth`**：`tab-snapshot.js#encode` 的默认值是 1920，
  //    对 1280 宽的窗口等于**不缩** —— 于是每一帧都按整页尺寸编码成 JPEG 存进缓存。
  //    而 hover 预览卡片只显示几百 CSS 像素宽（见 shared-types#preview-placement 的 card），
  //    那是 **5–8 倍的纯浪费**：32 张上限 × 整页 JPEG（~150KB，高 DPI 下更多）≈ 5MB+，
  //    全压在**主进程**里。640 在 2x DPR 下仍够锐（卡片宽度约为它的一半）。
  //   （该文件自己的注释就写着"消费方可按用途注入更小的值省内存"，这里正是那个消费方。）
  const snapshotService = createTabSnapshotService({ store: snapshotStore, hiraScheme: 'hira', maxWidth: 640 })
  windowShared.snapshotService = snapshotService
  // 动态页注册到 hira:// 注册中心：请求时才走 resolve，不做任何预加载
  registerHiraPage({
    host: 'tab-snapshot',
    kind: 'dynamic',
    resolve: (url: string) => snapshotService.resolveRequest(url)
  })

  // ── 打印 & 保存网页（s2 / s3）──────────────────────────────────────────────
  // printService 是唯一的作业状态源：渲染出的 PDF 通过 hira://print-pdf/<jobId>
  // 直吐给预览窗口（动态路由，不落盘、不过 IPC 大对象）。
  // savePageService 无状态，只负责「弹保存框 + 调 savePage」。
  const printService = createPrintService()
  registerHiraPage({
    host: 'print-pdf',
    kind: 'dynamic',
    resolve: (url: URL) => printService.servePdf(url)
  })
  const savePageService = createSavePageService()

  // ── 按窗口的标签运行单元（多窗口第二步 → 现在收口到装配器）─────────────────────
  // TabManager + 全部生命周期 hooks + 自动 PiP 已搬进 createBrowserWindowRuntime，
  // 而「建窗口 → 窗口 chrome → 运行单元 → 注册运行单元」这一串已由
  // browser-window-assembly 的 open() 统一完成（见文件头说明）。
  // 这里只把主窗口那三个对象取出，沿用既有名字，避免改动下面上百处引用。
  const browserRuntime = primaryWindow
  const pictureInPicture = browserRuntime.pictureInPicture
  tabManager = browserRuntime.tabManager

  // 注意：resize 监听器已在 LayoutCoordinator.attachUiShell() 中统一注册并做了合帧处理，
  // 这里不再重复注册，避免每次 resize 触发两次 applyInitialLayout 导致主进程卡顿。

  // ── 会话端口（domain-session 的 tabPort）──
  // 显式适配器，取代此前 `{ ...tabManager }` 那种拿不到原型方法的隐式拼接（见 sessionTabPort.js）。
  //   profileTabPort → 全部空间：启动恢复时一次性把该 profile 的所有标签读回来
  // 空间/窗口级的保存端口都在用点就地构造（`createSessionTabPort(runtime.tabManager)`）——
  // 多窗口下「哪个端口写哪个文件」必须一一对应，集中成一个共享变量反而容易写错窗口。
  // ── 按窗口的会话分片（多窗口：跨窗口标签持久化）──────────────────
  // 为什么必须分片：所有窗口共享同一个「profile × 空间」目录，若都写 session.json，
  // 后写的会把先写的整体覆盖 —— 关掉应用后只有一个窗口的标签活下来。
  //   主窗口：沿用 `session.json`（老数据零迁移）
  //   其他窗口：`session-w<n>.json`
  //
  // 序号用**只增不减的分配器**而不是窗口 ordinal：
  //   ordinal 每次运行都从 2 重新开始，而分片文件是跨运行存在的；
  //   若「新窗口」直接按 ordinal 命名，恢复出来的老分片名可能与新窗口重名 → 互相覆盖。
  //   分配器启动时取「已存在分片的最大编号 + 1」，因此新窗口永远落在新编号上。
  const runtimeCurrentSpace = (runtime: BrowserWindowRuntime | null | undefined) => {
    const cur = runtime && runtime.spaceRuntime && typeof runtime.spaceRuntime.getCurrent === 'function'
      ? runtime.spaceRuntime.getCurrent()
      : null
    return {
      profileId: cur?.profileId || activeSpace?.profileId || activeProfile?.id || 'default',
      spaceId: cur?.spaceId || activeSpace?.id || 'default'
    }
  }
  const sessionWindows = createSessionWindowManager({
    sessionService,
    sessionPersistence,
    createSessionService,
    createSessionPersistence,
    createSessionTabPort,
    createFilePort,
    fs,
    path,
    isExpiredTab: isExpiredSessionTab,
    getSpace: runtimeCurrentSpace,
    getSessionDir: sessionDirFor,
    getAllWindows: () => browserWindows.all(),
    openWindow: (options: import('./browser-window-assembly').NewWindowOptions) => browserWindows.openNewWindow(options),
    getDefaultNewTabUrl: () => defaultNewTabUrl()
  })
  const profileTabPort = sessionWindows.createPrimaryTabPort(tabManager)

  /** 取某个窗口的 { service, persistence }（非主窗口惰性建，避免启动期多开定时器）。 */
  function sessionsFor(runtime: BrowserWindowRuntime) {
    return sessionWindows.sessionsFor(runtime)
  }
  /** 窗口关闭 → 删掉它的会话分片，下次启动不会把这个空窗口又恢复出来。 */
  function dropWindowSession(runtime: BrowserWindowRuntime) {
    sessionWindows.dropWindow(runtime)
  }

  /**
   * 空间会话的**唯一读写入口**（多窗口会话仲裁，F-0336）。
   *
   * 规则只有一条：**谁的状态，谁的文件** ——
   *   · 主窗口 → 该 profile × 空间的规范会话 `session.json`（老数据零迁移，外部工具也认它）；
   *   · 其它窗口 → 自己的窗口分片 `session-w<n>.json`。
   *
   * 为什么必须收口：此前切空间 / 切 profile 直接拿全局 `sessionService`（fileName 恒为
   * `session.json`）写盘 —— 任何一个非主窗口切空间都会把**主窗口的规范会话整体覆盖**，
   * 关掉应用后主窗口的标签就变成了那个窗口的标签。旧仓库 `sessionRestore#syncWithWindow`
   * 的口径是"多窗口下会话以主窗口为主"，落在这里就是：规范文件只归主窗口读写，
   * 其它窗口只碰自己的分片，彼此的标签永不互相污染。
   *
   * 所有「保存/恢复某个空间」的调用都必须走这两个函数，不许再直接持有全局 `sessionService`。
   *
   * @param {object} runtime 窗口运行单元
   * @param {string} dir 该空间的会话目录（`<profile>/spaces/<space>`）
   * @param {{ allTabs?: boolean, space?: {profileId:string, spaceId:string}|null }} [opts]
   *   端口口径：切 profile 时 allTabs=true（把所有空间的标签一次存下）；
   *   space=钉死某一格（异步 / 合批落盘时不能读环境当前空间，见 sessionTabPort 注释）
   * @returns {Promise<unknown>}
   */
  function saveSpaceSession(runtime: BrowserWindowRuntime, dir: string, opts: UnknownRecord = {}): Promise<unknown> {
    return sessionWindows.saveSpaceSession(runtime, dir, opts)
  }

  /**
   * 恢复某个空间在该窗口名下的会话（主窗口读规范文件、其它窗口读自己的分片）。
   * @param {object} runtime
   * @param {string} dir
   * @returns {Promise<{ restored?: boolean }|null>}
   */
  function restoreSpaceSession(runtime: BrowserWindowRuntime, dir: string) : Promise<{ restored?: boolean }|null> {
    return sessionWindows.restoreSpaceSession(runtime, dir)
  }

  /**
   * 把「上一轮退出时的 session.json」归档成 `last-closed.json`（启动时调用一次）。
   *
   * 时机是硬约束：必须在**任何标签创建 / 恢复之前**（否则 SessionPersistence 的
   * 实时镜像已经覆盖了旧文件），也必须在旧数据迁移之后（迁移完才有文件可拷）。
   * 只在启动时对「当前 profile × 空间」做一次 —— 运行期切空间不归档，
   * 否则会把"切走的那个空间的当前状态"误写成"上次关闭"。
   *
   * 失败一律静默：归档只服务于一张提示卡片，绝不能影响启动主流程。
   * @param {string} dir
   */
  function archiveLastClosedSession(dir: string) {
    sessionWindows.archiveLastClosed(dir)
  }
  // 窗口关掉就把它的会话分片删掉（否则下次启动又会恢复出一个空窗口）。
  windowShared.onWindowClosed = (runtime: BrowserWindowRuntime) => {
    if (runtime && runtime.win) {
      try { pluginOverlayHost.disposeWindow(runtime.win.id) } catch (_) {}
      // 跨窗口标签同步：关掉的若是"当前托管窗口"，复位记账（下次获焦重新建立）。
      // try/catch 兜住"启动极早期就关窗"（那时 tabSync 还在 TDZ 里）。
      try { tabSync.forgetWindow(runtime.win.id) } catch (_) {}
    }
    if (runtimeRegistry.size === 0) {
      try { pluginOverlayHost.disposeWindow(0) } catch (_) {}
    }
    // 主窗口的分片是 session.json，刻意**不随关闭删除**（见 dropWindowSession）：
    // 它在「关掉主窗口但其它窗口还在」时代表主窗口那份会话，删了下次启动就丢。
    // 但 2s 批量窗口里可能还压着最后一次变更，这里同步补一次，避免这次关闭丢状态。
    if (runtime && runtime.isPrimary) {
      sessionWindows.flushAllSync()
    }
    dropWindowSession(runtime)
  }

  /**
   * 把某个窗口的标签条挂到它自己的会话分片上（脏标记 → 2s 批量异步落盘）。
   * 每个窗口各挂各的：用同一个 persistence 会把所有窗口的标签写进同一个文件。
   */
  function attachSessionTracking(runtime: BrowserWindowRuntime) {
    sessionWindows.attachTracking(runtime)
  }
  // 每个窗口挂载完成即接上它自己的会话分片（装配器在 mount 结尾回调）
  //
  // 顺手补推一次当前主题：**新窗口自带一份"出厂表面底色"的 WebContentsManager**
  // （rail / 面板的视图底色默认是 `#f9fafb`，见 WebContentsManager 的构造），
  // 带壁纸的主题要把它刷成透明才透得出壁纸 —— 而 publish 的指纹去重是按"主题变没变"
  // 判的，"多了一个窗口"不在它的判据里，因此新窗口建窗后不会再有 publish 发生。
  // 少了这一步，用户看到的就是"新窗口的 rail 变成默认的不透明，而老窗口好好的"
  // （详见 theme-runtime.js#publish 里那段说明）。
  // 这里用 windowId 定向推给新窗口自己 —— 原生表面是 fanout 的（幂等），广播不必全场重收。
  windowShared.onWindowMounted = (runtime: BrowserWindowRuntime) => {
    attachSessionTracking(runtime)
    try {
      const windowId = runtime && runtime.win && !runtime.win.isDestroyed() ? runtime.win.id : undefined
      themeRuntime.broadcastCurrent(windowId != null ? { windowId } : {})
    } catch (_) {}
  }

  /**
   * 启动时恢复上次的多窗口：扫描「当前空间目录」里的 `session-w*.json` 分片，
   * 每个分片重建一个窗口并灌回它的标签。
   *
   * 分片就放在**它自己的 profile × 空间目录**里，因此「哪个窗口在哪个空间」是自描述的：
   * 不用额外维护一张窗口清单，也不会把 A 空间的窗口恢复进 B 空间。
   * 窗口在这些分片之间按文件名升序分配，并用**显式指定的分片名**（见 openNewWindow 的
   * sessionFileName）而不是重新推导的名字 —— 编号有无空隙都不影响正确性。
   */
  async function restoreSecondaryWindows(dir: string) {
    await sessionWindows.restoreSecondaryWindows(dir)
  }

  // ── URL 打开能力注入（对齐 RT：把 URL 落到「当前窗口的新标签」）──
  // 由 urlRouter / instanceController 在窗口就绪后调用；此刻 tabManager 已可用。
  appUrlOpener = async (useNewWindow: boolean, url: string, opts: UnknownRecord = {}) => {
    const href = String(url)
    // 文件关联（.html / .pdf …）：双击文档时命令行里是本地路径，urls 路由已归一成
    // file://。走与拖放**同一个** fileOpenService —— 「能渲染 → 新标签 / 否则系统
    // 默认程序」的判定只有一份，不在入口处另写一套扩展名白名单。
    if (href.startsWith('file:')) {
      let filePath = null
      try { filePath = fileURLToPath(href) } catch (_) { filePath = null }
      if (filePath) {
        const target = targetWindow()
        const targetWin = target.win
        if (targetWin && !targetWin.isDestroyed()) {
          try { if (!targetWin.isVisible()) targetWin.show() } catch (_) {}
          try { if (targetWin.isMinimized()) targetWin.restore() } catch (_) {}
          try { targetWin.focus() } catch (_) {}
        }
        try {
          await fileOpenService.openPaths([filePath], { tabManager: target.tabManager })
        } catch (e) {
          console.warn('[main] 打开关联文件失败:', filePath, errorMessage(e))
        }
        return
      }
    }
    // 无痕：命令行 `--incognito` 送来的初始 URL → 开一个无痕窗口（Chrome 同语义）。
    // 放在最前面判断：无痕窗口本身就是一个新窗口，不需要再叠加 useNewWindow。
    if (opts.incognito === true) {
      await openBrowserWindow({ url: href, incognito: true })
      return
    }
    // 显式要求新窗口（`--new-window` / 外部协议转发）→ 开一个完整浏览器窗口。
    if (useNewWindow) {
      await openBrowserWindow({ url: href })
      return
    }
    const target = targetWindow()
    const targetWin = target.win
    if (targetWin && !targetWin.isDestroyed()) {
      try { if (!targetWin.isVisible()) targetWin.show() } catch (_) {}
      try { if (targetWin.isMinimized()) targetWin.restore() } catch (_) {}
      try { targetWin.focus() } catch (_) {}
    }
    await target.tabManager.newTab({ url: href })
  }

  // 以下窗口级接线已全部收口到 browser-window-assembly.mount()：
  //   · tab:loading 事件转发（按窗口推给自己的 chrome）
  //   · win blur 收起凭据/瞬态浮层
  //   · js-dialog 覆盖层 + tab:webcontents-ready 挂载
  // 装配器在 mount(primaryWindow) 时统一实施，第二个窗口开出来时同样生效。

  // C13: SQLite + Drizzle — domain services (db/profileService 已在上方创建)
  // hasFts：infra-db 探测的 FTS5 可用性，书签搜索据此选 倒排索引 / LIKE 兜底
  // faviconPort：新增/改 URL 时解析图标 —— 先查 favicons 缓存，未命中再回退当前
  // 活跃标签的内存图标（favicon 事件尚未落库时的兜底）。收藏动作本身即带图标，
  // 不必再等下一次 page-favicon-updated 事件回填（消除"首次收藏无图标"的时序缺陷）。
  const bookmarkService = createBookmarkService(db, {
    hasFts,
    // 当前 profile：书签按 profile 分区（Steam 式多用户，见 currentProfileId）
    getProfileId: currentProfileId,
    faviconPort: {
      resolve: (url: string) => {
        const cached = faviconService.get(url).faviconUrl
        if (cached) return cached
        try {
          const live = tabManager.list().find((t: UnknownRecord) => t.url === url && t.favicon)
          return live ? live.favicon : null
        } catch (_) {
          return null
        }
      }
    }
  })
  // 书签变更中继：domain 唯一事实源 → 全 renderer 广播（星标/面板即时刷新）。
  // 必须在第一个 IPC 写操作前 start，否则首发变更会丢广播。
  // 事件中继只做「domain 事件 → 广播出口」的翻译；谁能收到由登记表决定，
  // 因此内部页（跑在标签页里的 hira://history / hira://bookmarks）也能真正收到。
  const bookmarkEventRelay = createBookmarkEventRelay(bookmarkService, { send: emit })
  bookmarkEventRelay.start()
  // 笔记域：与书签同一套「域 + 变更中继」；面板侧只订阅 note:changed。
  const notesService = createNoteService(db, { getProfileId: currentProfileId })
  const noteEventRelay = createNoteEventRelay(notesService, { send: emit })
  setArchiveAssetPort((id: string) => {
    const note = notesService.get(String(id || ''))
    const htmlPath = note && note.assetPath ? String(note.assetPath) : ''
    if (!htmlPath) return null
    const root = path.resolve(resolveProfileDir(currentProfileId()), 'page-archives')
    const resolved = path.resolve(htmlPath)
    const relative = path.relative(root, resolved)
    if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) return null
    return { htmlPath: resolved }
  })
  noteEventRelay.start()
  const historyService = createHistoryService(db, {
    getProfileId: currentProfileId,
    // E3：页面正文 FTS5 可用性（独立探测；不可用时正文搜索退回 LIKE）。
    hasFts: dbProvider.hasPageTextFts
  })
  const historyEventRelay = createHistoryEventRelay(historyService, { send: emit })
  historyEventRelay.start()
  // 图标缓存回填有自己的事件：历史写入可以领先图标到达，面板补图标不应拉整列表。
  const faviconEventRelay = createFaviconEventRelay(faviconService, { send: emit })
  faviconEventRelay.start()
  // 浏览器一键迁移：持领域服务的引用，写库仍走它们既有的批量入口。
  // faviconService 只用于「图标入库」（putIcon）—— 让导入结果自带本地图标、零联网。
  // 扩展用 getter：扩展服务随 profile 切换重建，迁移必须拿到**当前**那份。
  const browserImport = createBrowserImportService({
    bookmarkService,
    historyService,
    faviconService,
    getExtensionService: extensionServiceForProfile
  })
  // 补上延迟句柄：TabManager 的 onTitleUpdated hook 从此指向真实历史服务
  historyServiceRef = historyService
  const downloadService = createDownloadService(db, { getProfileId: currentProfileId })
  /**
   * 按 profile 绑定下载服务。
   *
   * 下载记录的写入口是 **session 事件**（will-download / DownloadItem 回调），不在 IPC
   * 上下文里 —— ALS 中既没有 sender 也没有显式 profile。注册下载处理器时我们**知道**
   * 这是哪个 profile 的会话，因此在这里显式声明作用域，而不是指望「回落到主窗口恰好
   * 也是同一个 profile」这种巧合（多用户下它就是错的）。
   * @param {string} profileId
   */
  const downloadServiceProxies = new Map<string, typeof downloadService>()
  function downloadServiceFor(profileId: string | null | undefined) {
    const id = String(profileId || 'default')
    const cached = downloadServiceProxies.get(id)
    if (cached) return cached
    const proxy = new Proxy(downloadService, {
      get(target: Record<PropertyKey, unknown>, prop: string | symbol) {
        const value = target[prop]
        if (typeof value !== 'function') return value
        return (...args: unknown[]) => runtimeRegistry.runWithProfile(id, () => (value as (...args: unknown[]) => unknown).apply(target, args))
      }
    }) as typeof downloadService
    downloadServiceProxies.set(id, proxy)
    return proxy
  }
  // S4: Password/Permission/Search services
  // ⚠️ safeStorage 是 electron 的**顶层导出**，不是 app 的属性。
  //    `app.safeStorage` 恒为 undefined —— 之前就是这样写的，导致加密 provider
  //    被判定为不可用，所有密码的 encrypted_password 都被存成 NULL。
  //
  // 加密 provider 由 infra 提供、**两个域共用同一个实例**（它无状态）：
  // 密码的 encrypted_password 与验证器的 secret_cipher 用的是同一套 OS 级密钥保护。
  const secretCrypto = createSafeStorageCrypto(safeStorage)
  // 支付卡 / 地址保管库（N7）：与密码/验证器共用同一个加密 provider（OS 级密钥保护）。
  // 明文只在主进程内存在 —— 列表接口只回摘要（掩码），见 main/form-fill.js 的文件头纪律。
  const formFillVault = createFormFillVault({ settings: settingsService, crypto: secretCrypto })
  const passwordService = createPasswordService(db, {
    crypto: secretCrypto,
    profileId: activeProfile?.id || 'default',
    // Bitwarden：CLI 端口 + 本地工具路径（安装入口见 main/password-tool-install.js）。
    // 主密码 / 会话密钥只在进程内存里，不落盘、不出主进程（见 bitwardenBackend）。
    bwCli: createProcessRunner(),
    bwLocalToolPath: path.join(
      app.getPath('userData'),
      'tools',
      process.platform === 'win32' ? 'bw.exe' : 'bw'
    ),
    // 1Password：同一个 CLI 端口（run 支持 stdin，主密码就是这样喂给 op signin 的）。
    // OP_DEVICE 必须跨启动稳定，否则 1Password 每次都会要求重新授权设备 —— 存设置里。
    opCli: createProcessRunner(),
    opLocalToolPath: path.join(
      app.getPath('userData'),
      'tools',
      process.platform === 'win32' ? 'op.exe' : 'op'
    ),
    opAccount: 'hira',
    opDeviceStore: {
      get: () => { try { return settingsService.get('1password.device_id') || null } catch (_) { return null } },
      set: (value: unknown) => { try { settingsService.set('1password.device_id', value) } catch (_) {} }
    },
    platform: process.platform
  })
  // TOTP 域：条目按 profile 分区（与其它域同口径），密钥与密码同一套加密。
  // 这里**无条件创建**服务（插件是否启用由插件系统管）—— 域只是能力，
  // "要不要跑"是插件的开关（totp-service 出厂默认关闭，见 plugin-bootstrap）。
  //
  // 时钟校准的两个端口：
  //   · `measureTime` —— 联网测「本机时钟 vs 网络时间」的偏移（端口注入，域层不碰网络）；
  //   · `kvDb`        —— 偏移的落盘位置。`kv` 只在**全局库**里（profile 库没有这张表），
  //                      偏移也确实该跨 profile 共用（是这台机器的时钟不准，不是某个身份）。
  const netClock = createNetClock({ fetchImpl: netFetch })
  const totpService = createTotpService(db, {
    crypto: secretCrypto,
    getProfileId: currentProfileId,
    measureTime: netClock.measure,
    kvDb: dbProvider.global().db
  })
  const totpEventRelay = createTotpEventRelay(totpService, { send: emit })
  totpEventRelay.start()

  // ── PWA（把站点安装为应用）──────────────────────────────────────────────
  // 分层：domain-pwa 只碰数据库；探测/安装/快捷方式是本层编排；图标走 hira-pwa://。
  // 所有端口按「当前 profile」懒解析（与其它域同一口径），切 profile 无需重建。
  const pwaService = createPwaService(db, { getProfileId: currentProfileId })
  const pwaCandidates = createCandidateStore()
  const pwaDetector = createPwaDetector({
    candidateStore: pwaCandidates,
    pwaService,
    getProfileId: currentProfileId,
    // 探测结果只投给「发起线索的那个窗口」：多窗口下别的窗口不该跟着亮安装图标。
    emitToWindow,
    events: { detected: IPC_EVENTS.pwaDetected }
  })
  tabClosedCleanup = (tabId: string) => pwaDetector.clearTab(tabId)
  const runtimeIdentity = getRuntimeIdentity()
  const systemIntegrationPolicy = () => ({
    enabled: runtimeIdentity.systemIntegrationEnabled,
    reason: runtimeIdentity.systemIntegrationReason
  })
  const pwaShortcuts = createPwaShortcuts({
    pwaService,
    paths: pwaPaths,
    getProfileId: currentProfileId,
    appName: runtimeIdentity.productName,
    getSystemIntegrationPolicy: systemIntegrationPolicy
  })
  const pwaIntegrations = createPwaIntegrations({
    getProfileId: currentProfileId,
    executablePath: runtimeIdentity.executablePath,
    getSystemIntegrationPolicy: systemIntegrationPolicy,
    resolveIconPath: (appId: string, profileId: string) => {
      try { return pwaPaths.resolveIconAsset(profileId, appId, pwaPaths.WINDOW_ICON_ORDER)?.full || null } catch (_) { return null }
    }
  })
  // 已安装应用在升级后也补齐文件 / 协议能力；仅打包态 Windows 真正写注册表。
  if (pwaIntegrations.supported) {
    setTimeout(() => {
      for (const item of pwaService.list()) {
        const record = pwaService.getRecord(item.id)
        if (record) void pwaIntegrations.sync(record)
      }
    }, 800)
  }
  const pwaInstaller = createPwaInstaller({
    candidateStore: pwaCandidates,
    pwaService,
    paths: pwaPaths,
    shortcuts: pwaShortcuts,
    syncIntegrations: (record: { id: string; name?: string; shortName?: string | null; startUrl: string; manifestJson?: string | null }) => pwaIntegrations.sync(record),
    fallbackIconPath: runtimeIdentity.windowIconPath,
    getProfileId: currentProfileId,
    emitProgress: (payload: UnknownRecord) => emit(IPC_EVENTS.pwaInstallProgress, payload)
  })
  // 「应用的增删改」只有一个出口：域服务的变更订阅。
  // 安装管线 / 卸载 / 快捷方式开关都不各自广播 —— 否则同一次变更会推多条。
  pwaService.subscribe(({ reason, id }: { reason: unknown; id: unknown }) => {
    emit(IPC_EVENTS.pwaChanged, { appId: id, action: reason })
  })
  // 更新编排：拉 manifest → 与入库快照 diff → 有变化才走安装管线覆盖。
  // 与安装共用同一条管线（installer.reinstall），不存在"更新自己的安装逻辑"。
  const pwaUpdater = createPwaUpdater({
    pwaService,
    pwaInstaller,
    getSession: (profileId: string) => sessionsController.get(profileId),
    getProfileId: currentProfileId,
    emitChanged: (payload: UnknownRecord) => emit(IPC_EVENTS.pwaChanged, payload),
    logger: console
  })
  // 卸载编排依赖 pwaRuntime，因此在 runtime 创建之后赋值。
  /** @type {object|null} */
  let pwaUninstaller: PwaUninstallerPort | null = null
  // PWA-only（`--pwa-app=` 冷启动）：主窗永不 mount，最后一个应用窗关闭即退出。
  let pwaOnlyMode = !!coldPwa
  // 主窗 shell 是否已加载 —— 浏览器模式启动 / PWA-only 下「在浏览器中打开」都靠它收敛。
  let mainShellMounted = false

  const pwaRuntime = createPwaRuntime({
    pwaService,
    runtimeRegistry,
    paths: pwaPaths,
    getSession: (profileId: string) => sessionsController.get(profileId),
    windowRegistry,
    // 设置服务：PWA 窗与主浏览器共用同一份 WCO 模式 / 缩放记忆 / 快捷键绑定。
    settingsService,
    // 强调色：与 JS 对话框同一条真源（主题服务 → derivePalette），
    // 供应用窗的 data: 错误页取色（那边读不到外壳令牌）。
    getAccentThemeInfo: (opts: { incognito: boolean }) => {
      try {
        return typeof windowShared.getAccentThemeInfo === 'function'
          ? windowShared.getAccentThemeInfo(opts)
          : null
      } catch (_) {
        return null
      }
    },
    onOpenInBrowser: (url: string) => openPwaUrlInBrowser(url),
    onUninstall: (appId: string, profileId: string) => {
      if (!pwaUninstaller) return { ok: false, reason: '卸载能力未就绪' }
      return pwaUninstaller.uninstall(appId, profileId)
    },
    // 资产目录被外部删掉时，把残留记录交给完整卸载（快捷方式 + DB + 广播），
    // 否则应用列表里会永久留一条"看得见但打不开"的条目。
    onInvalidApp: (appId: string, profileId: string) => {
      if (!pwaUninstaller) return false
      Promise.resolve(pwaUninstaller.uninstall(appId, profileId)).catch((err) => {
        console.warn('[pwa] 清理损坏应用失败:', errorMessage(err))
      })
      return true
    },
    // 打印：应用窗与主浏览器共用同一个 printService 与预览窗口。
    // PWA 窗不在 runtimeRegistry 里，所以「当前页面」必须由窗口这一侧显式交过来。
    printPage: (ctx: UnknownRecord) => openPrintPreview(ctx, null),
    onEmpty: () => {
      // Windows 的 window-all-closed 不会因「隐藏的主窗」触发 —— PWA-only 下
      // 最后一个应用窗关闭必须显式退出，否则进程会无声挂在后台。
      if (pwaOnlyMode) app.quit()
    },
    logger: console
  })
  pwaRuntime.setPwaOnlyMode(pwaOnlyMode)

  pwaUninstaller = createPwaUninstaller({
    pwaService,
    pwaRuntime,
    pwaShortcuts,
    pwaIntegrations,
    paths: pwaPaths,
    runtimeRegistry,
    getProfileId: currentProfileId,
    logger: console
  })

  /** 主窗 shell 只加载一次（浏览器模式启动 / PWA-only 下「在浏览器中打开」共用）。 */
  async function mountMainShell() {
    if (mainShellMounted) return
    try {
      await browserWindows.mount(primaryWindow)
      mainShellMounted = true
    } catch (err) {
      mainShellMounted = false
      throw err
    }
  }

  /**
   * PWA 窗口里的「在浏览器中打开」。
   *
   * PWA-only 下主窗从未 mount，直接 newTab 会把标签建在**不可见的窗口**里 ——
   * 用户感受就是「点了没反应」。所以先把 shell 拉起来（mount 内会 show），
   * 同时退出 PWA-only：现在有浏览器窗口了，最后一个应用窗关闭不该再退出进程。
   */
  async function openPwaUrlInBrowser(url: string) {
    const target = String(url || '').trim()
    if (!target) return
    if (!mainShellMounted) {
      pwaOnlyMode = false
      pwaRuntime.setPwaOnlyMode(false)
      await mountMainShell()
      attachSessionTracking(browserWindows.primary() || primaryWindow)
    }
    const rt = browserWindows.focused() || primaryWindow
    try {
      await rt.tabManager.newTab({ url: target })
      rt.win.show()
      rt.win.focus()
    } catch (err) {
      console.error('[pwa] 在浏览器中打开失败:', errorMessage(err))
    }
  }

  /**
   * PWA 冷启动：只开应用窗口，主窗保持隐藏。
   * 打不开（应用已卸载 / 资产缺失 / profile 不存在）时明确提示，再退回普通浏览器模式 ——
   * 静默退出会让用户以为「双击图标就是闪一下」。
   */
  async function launchColdPwaWindow() {
    if (!coldPwa) return
    const result = pwaRuntime.launchRequest(coldPwa)
    if (result.ok) return
    pwaOnlyMode = false
    pwaRuntime.setPwaOnlyMode(false)
    try {
      await dialog.showMessageBox({
        type: 'warning',
        title: app.getName(),
        message: '无法打开该应用',
        detail: `${result.reason || '未知原因'}\n\n将改为打开浏览器窗口。`,
        buttons: ['确定'],
        noLink: true
      })
    } catch (_) {}
    await mountMainShell()
  }

  // 第二实例 / 冷启动队列回填：从这一刻起「双击应用」随时可被接住。
  pwaLaunchQueue.setHandler((request: { appId: string; profileId: string; spaceId: string; file?: string | null; url?: string | null }) => {
    const result = pwaRuntime.launchRequest(request)
    if (!result.ok) console.warn('[pwa] 打开应用失败:', result.reason, request.appId)
    return result
  })
  pwaLaunchQueue.flush()
  console.log(
    '[main] password backend available =',
    passwordService.isAvailable(),
    '| safeStorage.isEncryptionAvailable =',
    !!(safeStorage && safeStorage.isEncryptionAvailable && safeStorage.isEncryptionAvailable())
  )
  const permissionRuntime = createPermissionRuntime({
    app,
    webContents,
    browserWindows,
    runtimeRegistry,
    db,
    perProfileServices,
    createPermissionService,
    createSiteGuard,
    isActivationInput,
    emit,
    featureMap,
    getPluginRegistry: () => pluginRegistry,
    getQrScanFrame: () => qrScanFrame,
    getExtensionSession: () => extensionService && extensionService.session,
    getActiveProfileId: () => activeProfile && activeProfile.id,
    registerHiraProtocol,
    CAPTURE_WAIT_MS,
    qrScanCropRect
  })
  const {
    permissionService,
    permissionPendingFilter,
    closeOutPendingPermissionRequests,
    isFeatureOn
  } = permissionRuntime
  siteGuard = permissionRuntime.siteGuard

  // S5: Settings service (JSON file based) — 提前创建，下载管理器需要读取设置
  // domain 层不碰磁盘：由 APPS 注入 FilePort（infra-fs）
  // ⚠ 创建本体已提前到「建第一个窗口之前」（见上方 530 行附近的同名注释）——
  // 主窗口的 WCO 判定要在建窗时读设置。此处不再重复创建，只消费既有的 settingsService。

  // 外部协议授权记录（mailto: 等）：记录直接复用 settingsService 的 KV（独立前缀），
  // 不新建存储。上面那两个权限处理器引用它（见 handleOpenExternalPermission）。
  const openExternalPermissions = createOpenExternalPermissions({ settingsService })
  permissionRuntime.setOpenExternalPermissions(openExternalPermissions)

  // ── 由设置驱动的「构造期选项 / 全局开关」（settingsService 就位后回填）──
  // 扩展系统：autoUpdate / allowUnpacked 是构造期参数，改完已加载的 profile 需要
  // 重新加载扩展系统才生效 —— 设置页的说明文案与这个语义保持一致。
  extensionOptionsPort = () => ({
    autoUpdate: settingsService.get('extensions.auto-update') === true,
    allowUnpacked: settingsService.get('extensions.allow-unpacked') !== false,
    // 内容拦截：过滤列表的下载本身已在 infra 里改成后台进行（不阻塞启动），
    // 这里只决定「要不要这套能力」。两把设置开关都关时不装配列表（省一次网络下载）；
    // 运行时打开任一把会由 blocking applier 触发按需装配 / 重建。
    // 历史坑：此处曾是 enableAdblocker:false，导致 IPC / 盾牌按钮 / 设置项全都在，
    // 底层 blocker 恒为 null → 点盾牌永远返回 false（「假完成」）。
    enableAdblocker: settingsService.get(PRIVACY_SETTING_KEYS.blockAds) !== false
      || settingsService.get(PRIVACY_SETTING_KEYS.blockTrackers) !== false,
    blockTrackers: settingsService.get(PRIVACY_SETTING_KEYS.blockTrackers) !== false
  })

  // PDF 内置查看器开关回填（默认 true）。TabManager 每次判定现读，改完下次打开即生效。
  pdfViewerEnabledPort = () => settingsService.get(PDF_SETTING_KEYS.viewerEnabled) !== false
  // 会话保留策略回填（默认 'never' = 不过滤）。启动恢复期读它丢弃过期标签，
  // 与自动归档定时器共用 tabs-retention 的同一套阈值解析。
  archiveAfterPort = () => settingsService.get(TABS_RETENTION_SETTING_KEYS.archiveAfter)
  splitOptionsPort = () => {
    const rawMax = Number(settingsService.get('app.split_max_panes'))
    const rawLayout = settingsService.get('app.split_default_layout')
    const rawRouting = settingsService.get('app.split_link_routing')
    return {
      // 夹取到 [2, SPLIT_METRICS.maxPanes]：非法 / 缺失一律回落硬上限
      maxPanes: Number.isFinite(rawMax) ? Math.min(4, Math.max(2, Math.floor(rawMax))) : 4,
      defaultLayout: rawLayout === 'column' ? 'column' : 'row',
      // 格间链接路由：只有显式选「开在分屏的下一格」才生效（默认开新标签页）
      linkRouting: rawRouting === 'adjacent-pane' ? 'adjacent-pane' : 'off'
    }
  }

  // 切标签自动画中画开关回填（默认 false）。浏览器窗口运行单元每次判定现读，
  // 因此改设置后下一次切标签即生效；默认关闭 = 普通浏览器行为。
  autoPipEnabledPort = () => settingsService.get(TABS_SETTING_KEYS.autoPictureInPicture) === true

  // 标签字号（accessibility.font_size）回填。
  // 为什么是「下次建标签生效」而不是即时生效：Chromium 只能在创建 webContents 时
  // 下发 defaultFontSize，没有运行时修改 API。休眠中的标签会在下次唤醒重建视图时带上新字号。
  // 注意：这是**默认字号**（页面未指定字体大小时才用它），与页面缩放不是一回事。
  // 档位 → 像素表来自 shared-types/accessibility.mjs（设置页选项与这里同源）。
  extraTabWebPreferencesPort = () => {
    const px = FONT_SIZE_PX[settingsService.get(ACCESSIBILITY_SETTING_KEYS.fontSize)]
    return px ? { defaultFontSize: px } : {}
  }

  // 无障碍支持：Chromium 只有一个总开关（开启后朗读/高对比/光标浏览才真正可用，
  // 但它本身会带来额外渲染开销）。用户打开任意一项即开启 —— 与 Chromium 自身行为
  // 一致；只有全部关闭才关掉，绝不能为了「省一点开销」让辅助功能静默失效。
  const syncAccessibility = () => {
    const anyOn = ACCESSIBILITY_TOGGLE_KEYS.some((k: string) => settingsService.get(k) === true)
    try {
      app.setAccessibilitySupportEnabled(anyOn)
    } catch (e) {
      console.warn('[main] setAccessibilitySupportEnabled failed:', errorMessage(e))
    }
  }
  syncAccessibility()
  settingsService.subscribe(() => syncAccessibility())
  // 新标签页默认地址的**唯一解析入口**（设置口径：app.home_mode + app.home_url）。
  // 扩展的 `chrome_url_overrides.newtab` **不在这里**应用 —— 同一份地址会被
  // 无痕 / 容器标签沿用，而只有 TabManager 知道每张标签最终跑在哪个会话；
  // 覆盖由它的 onResolveTabUrl 钩子在 loadURL 前应用（见 browser-window-runtime）。
  const defaultNewTabUrl = () => resolveHomeUrl(settingsService)
  const themeRuntime = createThemeRuntime({
    nativeTheme: require('electron').nativeTheme,
    settings: settingsService,
    themeService,
    themeManager,
    scheduler: themeScheduler,
    broadcast: emit,
    getProfileId: () => String(activeProfile?.id || 'default'),
    runWithProfile: (profileId: string, task: () => unknown) => runtimeRegistry.runWithProfile(profileId, task),
    // 主题是**窗口级**的原生表面设置（setTabTheme）：必须作用到每一个窗口，
    // 所以传聚合口而不是主窗口那一份 layoutCoordinator。
    getLayoutCoordinator: () => layoutFanout,
    // 私密窗口可能另有皮肤：把"哪几个窗口是私密窗口"交给发布链，
    // 它据此把私密那一份载荷**定向**推过去（不污染普通窗口）。
    getIncognitoWindowIds: () =>
      browserWindows.all()
        .filter((rt) => rt && rt.incognito && rt.win && !rt.win.isDestroyed())
        .map((rt) => rt.win.id)
  })
  themeRuntime.start()
  // 启动时先发一次：把"当前主题"这条事实在窗口加载完成前就摆好，
  // 后加载的视图各自在 theme-controller.start() 里订阅时也能靠 broadcastCurrent 补取。
  void themeRuntime.publish().catch((error: unknown) => {
    console.warn('[theme] initial publish failed:', errorMessage(error))
  })
  /**
   * `app.theme` 被**任何来源**写入后重新发布 —— 设置页的下拉、空间快照回灌、
   * 用户手改 settings 文件都走这条。这是"applier 已删除"之后仍能生效的原因：
   * 生效动作不在 applier 里，而在主题域自己的发布出口（见 theme-runtime.js）。
   * `publish()` 自带令牌指纹去重，所以与 themeService 自己的 active 事件重复触发无害。
   */
  settingsService.subscribe((change: { key?: string; scope?: string }) => {
    const key = change && change.key
    const scope = change && change.scope
    // 私密主题与用户主题目录也算"主题变了"：前者换的是私密窗口那一份，
    // 后者可能改到当前正在用的那条（编辑器保存走 IPC 已发一次，这里兜住
    // "设置文件被外部改动"这条路 —— 与 app.theme 同一条自愈理由）。
    if (
      scope === 'all' ||
      !key ||
      key === THEME_SETTING_KEYS.active ||
      key === THEME_SETTING_KEYS.privateTheme ||
      key === THEME_SETTING_KEYS.userThemes
    ) {
      void themeRuntime.publish().catch((error: unknown) => {
        console.warn('[theme] settings publish failed:', errorMessage(error))
      })
    }
  })
  // 最后一个窗口关闭时才停（关掉主窗口但还有别的窗口时，主题同步必须继续工作）。
  // 非 macOS 下 window-all-closed 会紧接着退出应用，这里不重复处理退出语义。
  app.on('window-all-closed', () => {
    themeRuntime.stop()
    themeScheduler.stop()
  })

  // ── 子窗口打开（单例 / payload 透传 / stale-payload 销毁重建）──
  // 抽成具名函数 + 前置定义：主进程快捷键（bookmark:toggle）也要开编辑器窗口，
  // 必须放在 keybindingActions 之前，避免函数声明跨 try 块提升的隐患。
  // 单例语义由 WindowRegistry 的类型维度承载（对齐 RT WindowTypeManager）：
  // 不再各写一份 openWindows Map（与注册表重复、易漂移）。
  //
  // @param {object} [parentRuntime] 发起方窗口运行单元。多窗口下父窗口必须是**发起方**：
  //   共用一个 win 会让 B 窗口弹出的模态挂在 A 窗口上（注意力/焦点全错）。
  function openSubWindowByType(type: string, payload?: UnknownRecord, parentRuntime?: BrowserWindowRuntime | null) {
    // 父窗口三级解析（顺序即优先级）：
    //   1. 显式传入的发起方运行单元（快捷键/菜单路径，最准）；
    //   2. **本次 IPC 调用所属的窗口** —— window:open 通道不带 parentRuntime，
    //      若不补这一步，B 窗口弹出的子窗口会锚在 A 窗口上（模态/置顶/焦点全错，
    //      用户感受就是「B 没有自主权，子窗口跑到 A 去了」）；
    //   3. 主窗口（启动期 / 非窗口发送方，单窗口语义下的合理兜底）。
    const senderRt = parentRuntime && parentRuntime.win
      ? null
      : runtimeRegistry.currentOrNull()
    const parent = parentRuntime && parentRuntime.win && !parentRuntime.win.isDestroyed()
      ? parentRuntime.win
      : (senderRt && senderRt.win && !senderRt.win.isDestroyed() ? senderRt.win : win)
    const cfg = getWindowConfig(type)
    if (!cfg) return { ok: false, error: `unknown window type: ${type}` }
    // 单例：已打开的窗口聚焦。
    // 例外：带 payload 的编辑器类窗口（add/edit-bookmark 等）—— 聚焦旧窗口会
    // 展示上一次的预填数据（stale payload），必须销毁重建才拿到新参数。
    const existing = windowRegistry.getSingleton(type)
    if (existing) {
      if (payload && typeof payload === 'object') {
        try { existing.destroy() } catch (_) {}
      } else {
        try { existing.focus() } catch (_) {}
        return { ok: true, existing: true }
      }
    }
    // payload 透传：以 URL 查询参数带给子窗口 renderer（如编辑器的预填 url）
    let url = cfg.url
    if (payload && typeof payload === 'object') {
      const sep = url.includes('?') ? '&' : '?'
      url += `${sep}payload=${encodeURIComponent(JSON.stringify(payload))}`
    }
    // 窗口特性里声明了「跟随主题窗口材质」的类型（OOBE / 通用面板窗口）：
    //   · 把能力作为参数带给渲染入口 —— 渲染层据此让开不透明底色，材质才透得出来；
    //   · 建窗后登记到 theme-runtime 的材质跟随集合 —— 原生材质（acrylic / mica）
    //     由主进程应用，后续主题变化也会重放。
    // 记在 window-config.js 的**能力位**上，而不是在渲染层按窗口类型抄一张表
    // （那种表必然与主进程配置漂移）。
    if (cfg.followThemeMaterial) {
      url += `${url.includes('?') ? '&' : '?'}windowMaterial=1`
    }
    // parent=主窗口：modal/alwaysOnTop 才有锚点（书签编辑器对齐 Hira 置顶模态）。
    // 用 subWin 别名避免与主窗口闭包变量 `win` 遮蔽。
    const { win: subWin } = createSubWindow({
      url,
      width: cfg.width,
      height: cfg.height,
      modal: cfg.modal,
      // independent：不挂 parent —— 挂了 parent 的窗口会被系统当成子窗口，
      // 永远压在主窗口之上且不占独立任务栏项（看源码是「并排对照」场景，必须独立）。
      parent: cfg.independent ? undefined : parent,
      frame: cfg.frame,
      alwaysOnTop: cfg.alwaysOnTop,
      autoHideMenuBar: cfg.autoHideMenuBar,
      skipTaskbar: cfg.skipTaskbar,
      resizable: cfg.resizable,
      minimizable: cfg.minimizable,
      maximizable: cfg.maximizable,
      fullscreenable: cfg.fullscreenable,
      // 透明 / 阴影 / 厚边框：扫码浮框要靠它们变成"只有一层取景框"的窗口
      // （其余窗口不写这几项 → undefined → WindowFactory 用默认值，行为不变）。
      transparent: cfg.transparent,
      hasShadow: cfg.hasShadow,
      thickFrame: cfg.thickFrame,
      showOnReady: cfg.showOnReady,
      showOnReadyMode: cfg.showOnReadyMode,
      windowType: type,
      windowRegistry
    })
    // 材质跟随：只有窗口配置显式声明了能力位的类型才登记（OOBE / 独立面板窗口）。
    // 登记即按当前主题材质生效；此后主题变化由 theme-runtime 统一重放，窗口 closed 自动注销。
    if (subWin && cfg.followThemeMaterial) themeRuntime.followWindowMaterial(subWin)
    return { ok: true }
  }

  const passkeys = createPasskeyController({
    app,
    getSessions: () => sessionsController.listSessions(),
    onSessionCreated: (listener: (session: Session) => void) => {
      app.on('session-created', (session: Session) => listener(session))
    },
    openPicker: (payload: Record<string, unknown>, onClosed: () => void) => {
      const result = openSubWindowByType(WINDOW_TYPES.PASSKEY_PICKER, payload)
      const picker = windowRegistry.getSingleton(WINDOW_TYPES.PASSKEY_PICKER)
      if (!result || result.ok !== true || !picker || picker.isDestroyed()) {
        onClosed()
        return null
      }
      const closed = () => onClosed()
      picker.once('closed', closed)
      return () => {
        if (picker.isDestroyed()) return
        try { picker.close() } catch (_) {}
      }
    }
  })
  passkeys.attach()

  // ── OOBE 首次启动引导 ────────────────────────────────────────────
  // 状态判定 + 窗口编排收在 main/onboarding 一处；这里只做端口注入。
  // 位置选在 openSubWindowByType 之后：`mountMainShell` / `openSubWindowByType`
  // 都是函数声明（提升），而这个 const 在启动分流（约 5190）与 registerCoreIpc
  // （约 4900）之前就已求值，两处都能直接引用。
  const onboarding = createOnboardingController({
    settings: settingsService,
    openWindow: openSubWindowByType,
    getWindow: (type: string) => windowRegistry.getSingleton(type),
    windowTypes: WINDOW_TYPES,
    mountMainShell
  })
  settingsActions.register(SETTINGS_ACTION_ROUTES.resetOnboarding, () => onboarding.reset())

  // ── 目标窗口解析（多窗口第四步）────────────────────────────────
  // 快捷键与应用菜单是**应用级**的单一份（Electron 只有一个 application menu），
  // 但它们必须作用在**有焦点的那个窗口**上 —— 否则在窗口 B 按 Ctrl+T 会在窗口 A
  // 里新建标签。这三条就是「当前该对谁动手」的唯一判定口。
  const targetWindow = focusedRuntime
  const targetTabs = () => targetWindow().tabManager
  const openPagePreferExisting = (url: string): void => {
    const tm = targetTabs()
    const found = tm.findTabByUrl(url)
    if (found) {
      tm.switchTo(found.tabId)
      return
    }
    void Promise.resolve(tm.newTab({ url })).catch(() => {})
  }
  const targetUiShell = () => targetWindow().win.webContents
  const targetLayout = () => targetWindow().layoutCoordinator

  /**
   * 「关闭多个标签前确认」闸门（设置键 tabs.confirm_close_multiple）。
   *
   * 与 IPC 侧（ipc/tabs.js → tab-close-guard.js）**同一份实现**：应用菜单的
   * 「关闭其他标签页」也必须先问，否则从菜单进来的这条路会绕过用户设置
   * （改造前它直接调 closeOthers，用户感知就是"设置没用"）。
   * 询问落在**焦点窗口**的 jsDialogManager 上 —— 哪个窗口点的菜单就挂哪个窗口。
   */
  const tabCloseGuard = createTabCloseGuard({
    getTabManager: targetTabs,
    getJsDialogManager: () => {
      const rt = targetWindow()
      return rt && rt.jsDialogManager ? rt.jsDialogManager : null
    },
    settingsService
  })
  // 关闭窗口（点 X）也要走同一个闸门 —— 窗口的 `close` 事件在
  // browser-window-assembly#open 里，这里只回填两个端口（延迟求值：窗口建得比这早，
  // 但 close 只会在用户点 X 时触发，那时整个启动流程早已就绪）。
  //   · needsWindowCloseConfirm：同步判定「这次关闭要不要问」（close 事件必须同步决定 preventDefault）；
  //   · confirmWindowClose：异步问，返回 true = 允许关闭（`shouldCancel` 取反）；
  //   · isQuitting：退出流程中一律放行（否则 before-quit → app.quit() 会被自己的确认框卡住）。
  windowShared.needsWindowCloseConfirm = (count: number) => tabCloseGuard.needsWindowCloseConfirm(count)
  windowShared.confirmWindowClose = (runtime) => {
    let count = 0
    try { count = runtime && runtime.tabManager ? runtime.tabManager.countTabs() : 0 } catch (_) {}
    // 浮层宿主用**被关的那个窗口**（不是焦点窗口）：点非焦点窗口的 X 时，
    // 提示必须落在用户正在关的那一个窗口上。
    return tabCloseGuard.shouldCancelWindowClose(count, {
      getJsDialogManager: () => (runtime && runtime.jsDialogManager ? runtime.jsDialogManager : null)
    }).then((cancel: boolean) => !cancel)
  }
  windowShared.isQuitting = () => sessionWindows.isQuitting()

  /**
   * 集锦动作（WP1）：九条 `note:*` 的**唯一实现**（见 `main/note-actions.js`）。
   *
   * 三个消费方共用这一份：
   *   · `keybindingActionsRef`（快捷键 / 应用菜单 / 自动化命令链）—— 无参形式；
   *   · `TabManager#omniboxAction` 的 `note:` 前缀（地址栏 `!命令`）—— 带参形式；
   *   · 插件 / 扩展 API —— 直接 `noteActions.run(action, params)`。
   *
   * ⚠ 端口一律**延迟解析**：
   *   · `getTabs` / `getWindow` 跟着**焦点窗口**走（多窗口下不能按值钉死）；
   *   · `getNotesAssets` 在 4126 行才创建（TDZ），动作层内部已用 try-catch 兜底；
   *   · `panelCatalog` 在 3502 行才创建 —— showPanel 里做存在性守卫，缺失时静默降级。
   */
  const noteActions = createNoteActions({
    getNotesService: () => notesService,
    getNotesAssets: () => windowShared.notesAssets,
    getTabs: () => targetTabs(),
    getWindow: () => targetWindow().win,
    // 「打开」而不是「切换」：收录完必须看得见结果，不能因为面板恰好开着就关掉它。
    //
    // 返回值 = 「它**事先**是不是就开着」（true/false/null）。动作层据此决定要不要
    // 留一份 open-view 载荷给面板挂载后拉取 —— 新开时面板 renderer 还在加载，
    // 这一刻发的事件必然丢（每个面板 = 独立 renderer 进程，见 LayoutCoordinator）。
    showPanel: (panelId: string) => {
      try {
        if (panelCatalog && typeof panelCatalog.has === 'function' && !panelCatalog.has(panelId)) return null
        const layout = targetLayout()
        const wasOpen = typeof layout.getPanelSideOf === 'function' ? !!layout.getPanelSideOf(panelId) : false
        layout.showPanel(panelId)
        return wasOpen
      } catch (_) {
        return null
      }
    },
    // 定向到**目标窗口**：`note:open-view` 是窗口级事件，广播会让每个窗口各开一次面板。
    emit: (route: string, payload?: unknown) => {
      try { emit(route, payload, { windowId: targetWindow().win.id }) } catch (_) {}
    }
  })
  // 回填给窗口装配层（`shared.noteActions`）：地址栏 `note:<action>` 的端口延迟解析它。
  windowShared.noteActions = noteActions
  const captureHub = createCaptureHub({
    getTabs: () => targetTabs(),
    getNotes: () => notesService,
    getBookmarks: () => bookmarkService,
    getNoteActions: () => windowShared.noteActions,
    settings: settingsService,
    openWindow: (payload: Record<string, unknown>) => openSubWindowByType(WINDOW_TYPES.CAPTURE_HUB, payload, targetWindow()),
    showPanel: (panelId: string) => {
      try { return targetLayout().showPanel(panelId) } catch (_) { return null }
    }
  })
  windowShared.captureHub = captureHub
  const pageLibrary = createPageLibrary({
    settings: settingsService,
    notes: notesService,
    getTabs: () => targetTabs(),
    namedSessions,
    downloads: downloadService,
    slots: slotCall,
    getArchiveDir: () => path.join(resolveProfileDir(currentProfileId()), 'page-archives')
  })
  windowShared.pageLibrary = pageLibrary
  /**
   * 把焦点送回**目标窗口**的地址栏。
   *
   * 快捷键（Ctrl+L / Alt+D / F6）与将来任何命令链入口都走这一条 ——
   * 渲染层只认 `shortcut:focus-url` 这一条消息（见 app-shell 的快捷键订阅），
   * 不在主进程里为不同键位发不同消息。
   */
  const focusUrlBar = () => {
    const wc = targetUiShell()
    // 通道名必须是 `ngipc:event:<route>` —— 外壳用 bridge.on.subscribe(route) 订阅，
    // preload 会统一拼上 `ngipc:event:` 前缀（见 shell-preload.js#makeChannel）。
    if (wc && !wc.isDestroyed()) wc.send(`ngipc:event:${IPC_EVENTS.shortcutFocusUrl}`, {})
  }


  /**
   * 标签页搜索（Ctrl+Shift+A）—— 打开**「总览」浮层**（`overview-overlay`），打开即聚焦它的搜索框。
   *
   * 主进程只发一条事实（`overview:open`），**锚点由外壳算**：浮层贴在空间胶囊正下方，
   * 而"胶囊此刻在窗口里的哪个位置"只有外壳的 DOM 知道（面板 / 布局都能改变 navbar 高度）。
   * 浮层是 SELF_FOCUS 白名单成员，键盘焦点与搜索框光标由它自己接住
   * （见 LayoutCoordinator#SELF_FOCUS_FLOATS / renderer/overview-overlay/main.js）。
   *
   * 与 rail / 地址栏 `!标签页`（那条开的是另一个面板 `open-tabs-panel`）互不干扰。
   */
  const openTabsPanel = () => {
    const wc = targetUiShell()
    if (wc && !wc.isDestroyed()) wc.send(`ngipc:event:${IPC_EVENTS.overviewOpen}`, {})
  }

  /**
   * 活动标签的「打印 / 保存」上下文 —— 快捷键、应用菜单、PWA 三处共用。
   * 只返回事实（webContents + 标题 + URL），不含任何策略：
   * 打印怎么渲染由 printService 决定，保存成什么格式由保存对话框决定。
   */
  const activeTabContext = () => {
    const tabs = targetTabs()
    const tabId = tabs.getActiveTabId()
    if (!tabId) return null
    const wc = tabs.getWebContents(tabId)
    if (!wc || (typeof wc.isDestroyed === 'function' && wc.isDestroyed())) return null
    const tab: UnknownRecord = (tabs.list() || []).find((t: UnknownRecord) => String(t.tabId) === String(tabId)) || {}
    return { wc, title: tab.title || '', url: tab.url || '' }
  }

  /**
   * 「给一个页面开打印预览」的唯一落点 —— 主浏览器快捷键 / 菜单 / 应用窗共用。
   * 只做两件事：建 job、开预览窗口；jobId 是两边唯一的交接物。
   */
  function openPrintPreview(ctx: UnknownRecord | null | undefined, parentRuntime?: BrowserWindowRuntime | null) {
    if (!ctx || !ctx.wc) return
    const job = printService.createJob({
      webContents: ctx.wc,
      title: ctx.title || '',
      url: ctx.url || ''
    })
    openSubWindowByType(WINDOW_TYPES.PRINT, { jobId: job.id }, parentRuntime || null)
  }

  /** 打印当前标签：建 job → 打开预览窗口（jobId 是两边唯一的交接物）。 */
  const printActiveTab = () => {
    openPrintPreview(activeTabContext(), targetWindow())
  }

  /** 保存当前标签（HTML 完整 / MHTML），保存框的父窗口是当前窗口。 */
  const saveActiveTab = () => {
    const ctx = activeTabContext()
    if (!ctx) return
    savePageService
      .save({ webContents: ctx.wc, title: ctx.title, url: ctx.url }, targetWindow().win)
      .catch((e: unknown) => console.warn('[save-page] failed:', errorMessage(e)))
  }

  /**
   * 阅读模式开关（F9 / 视图菜单 / 网页右键）—— 三处共用同一个落点。
   *
   * 覆盖层注入到**页面主世界**，不新开窗口/面板：页面的滚动、链接、图片都还在，
   * 退出后原样恢复。开/关语义由脚本自身判断（已存在覆盖层 = 关闭）。
   */
  const toggleReaderModeActiveTab = () => {
    const ctx = activeTabContext()
    if (!ctx) return
    toggleReaderMode(ctx.wc)
  }

  /**
   * 把一条**面级**命令交给"活动面"执行 —— 靶子 = 聚焦框标的那个面。
   *
   * 与分屏「快捷键跟着活动格走」是同一条原则：这个窗口里可能同时有活动标签与
   * 独立侧栏两块网页面，Ctrl+R / Alt+← / Ctrl+Shift+I / Ctrl+W / Ctrl+D 这些**面级**动作
   * 必须落在用户此刻在用的那一块上（侧栏聚焦时就是侧栏），而不是永远落在标签上。
   *
   * 命令由**窗口装配层注入**（它才认识"侧栏"这个业务概念，见 browser-window-assembly
   * 的 runSurfaceCommand）—— 本文件只负责"先问一句、没人认领再走标签那条老路"。
   * 缺省（未注入 / 活动面就是标签）返回 false，于是行为与改造前**一字不差**。
   *
   * @param {string} action 动作意图（reload / stop / back / forward / close / reload-hard / devtools / bookmark）
   * @returns {boolean} 是否已由活动面处理
   */
  const runSurfaceCommand = (action: string) => {
    const rt = targetWindow()
    if (!rt || typeof rt.surfaceCommand !== 'function') return false
    try { return !!rt.surfaceCommand(action) } catch (_) { return false }
  }

  // 新窗口：空间继承发起窗口（见 windowShared.getWindowSpace）
  const openBrowserWindow = (opts?: import('./browser-window-assembly').NewWindowOptions) => browserWindows.openNewWindow({ ...(opts || {}), opener: targetWindow() })

  // ── 多窗口：窗口清单 ────────────────────────────────────────
  /**
   * 列出全部**浏览器窗口**（供「移动到其他窗口」这类菜单构建目标列表）。
   * 子窗口（28 类辅助窗口）不是标签承载者，不能作为迁移目标，因此不在列表里 ——
   * 它们只存在于 WindowRegistry，不在 browserWindows 里。
   */
  const listBrowserWindows = () => {
    const focusedRt = browserWindows.focused()
    return browserWindows.all().map((rt) => ({
      id: rt.win.id,
      ordinal: rt.ordinal,
      isPrimary: Boolean(rt.isPrimary),
      incognito: Boolean(rt.incognito),
      focused: Boolean(focusedRt && focusedRt === rt),
      tabCount: rt.tabManager.listAll().length
    }))
  }

  /**
   * 把一个标签从一个窗口**搬**到另一个窗口。
   *
   * ── 为什么是「搬」而不是「关掉再打开」──────────────────────────
   * 走 TabManager.detachTab / adoptTab：webContents 与导航历史整体迁移，
   * 用户看到的是标签换了个窗口，而不是页面被重新加载（后者会丢表单、丢滚动位置、
   * 丢前进后退栈 —— 那是假的迁移）。
   *
   * ── 为什么无痕标签拒绝迁移 ────────────────────────────────────
   * 无痕标签跑在窗口私有的内存 partition（`win-<ts>-<rand>`）上，把它搬进另一个
   * 窗口等于把两个本该互不相干的无痕会话缝在一起。宁可如实拒绝，也不静默降级成
   * 「在新窗口重开一次」（那会让用户以为数据被搬走了，实际是另一个会话）。
   *
   * @param {{ tabId: string, targetWindowId?: number, newWindow?: boolean }} req
   */
  async function moveTabToWindow({
    tabId,
    targetWindowId,
    newWindow = false,
    targetId = null,
    insertAfter = false,
    atCursor = null
  }: MoveTabRequest) {
    // 源窗口：IPC 发送方所属窗口（拖拽/菜单都从某个窗口发起）。
    // ⚠ 用 currentOrNull() 而不是 current()：后者的「解析不到 → 主窗口」兜底会让
    // 一次来自非窗口发送方的请求把**主窗口的标签搬走**（静默落错窗口）。
    // 解析不到窗口时先退到焦点窗口（那才是用户此刻意图所在），最后才退主窗口。
    const senderRuntime = runtimeRegistry.currentOrNull()
    let source = senderRuntime || browserWindows.focused() || primaryWindow
    let srcTabs = source.tabManager
    const id = String(tabId || '')
    let tab = srcTabs.listAll().find((t: UnknownRecord) => t.tabId === id)
    if (!tab) {
      for (const runtime of browserWindows.all()) {
        const candidate = runtime.tabManager.listAll().find((t: UnknownRecord) => t.tabId === id)
        if (!candidate) continue
        source = runtime
        srcTabs = runtime.tabManager
        tab = candidate
        break
      }
    }
    if (!tab) return { ok: false, error: 'tab not found' }
    if (tab.incognito) return { ok: false, error: 'incognito tab cannot be moved between windows' }

    let target
    if (newWindow) {
      const cursorX = Number(atCursor?.x)
      const cursorY = Number(atCursor?.y)
      const bounds = Number.isFinite(cursorX) && Number.isFinite(cursorY)
        ? { x: Math.round(cursorX), y: Math.round(cursorY) }
        : undefined
      target = await browserWindows.openNewWindow({ opener: source, skipInitialTab: true, focus: true, bounds })
    } else {
      target = targetWindowId == null
        ? senderRuntime
        : browserWindows.all().find((rt) => rt.win.id === Number(targetWindowId))
      if (!target) return { ok: false, error: 'target window not found' }
      if (target === source) return { ok: false, error: 'source and target are the same window' }
      if (!!target.incognito !== !!source.incognito) {
        return { ok: false, error: 'incognito and normal windows cannot share tabs' }
      }
    }

    let targetSpace: { profileId?: string; spaceId?: string } | null = null
    try { targetSpace = target.spaceRuntime?.getCurrent?.() || null } catch (_) {}
    if (targetSpace?.profileId && String(targetSpace.profileId) !== String(tab.profileId || 'default')) {
      return { ok: false, error: 'profile mismatch' }
    }

    // 源窗口的「最后一个标签」保护：先补一个空白标签页再搬，别让源窗口变成空壳。
    // （Chrome 在这种情况下会直接关掉源窗口；NG 的窗口还承载空间/浮层等状态，
    //   留一个空白页比关掉窗口更不打扰。）
    const remainingInSpace = srcTabs.listAll().filter((t: UnknownRecord) => t.spaceId === tab.spaceId).length
    if (remainingInSpace <= 1) {
      try { await srcTabs.newTab({ url: defaultNewTabUrl() }) } catch (_) {}
    }

    const bundle = srcTabs.detachTab(id)
    if (!bundle) return { ok: false, error: 'detach failed' }
    if (targetSpace?.profileId) bundle.record.profileId = String(targetSpace.profileId)
    if (targetSpace?.spaceId) bundle.record.spaceId = String(targetSpace.spaceId)
    // 扩展系统**不做** removeTab/addTab：ECE 的注册按 webContents 记账且 addTab 非幂等
    // （详见 browser-window-runtime 的 extRegisteredWc）。这里若 removeTab，目标侧会被
    // 去重逻辑挡掉、标签在扩展眼里直接消失 —— 那比「windowId 停留在原窗口」严重得多。
    target.tabManager.adoptTab(bundle, { targetId, insertAfter })
    try { if (!target.win.isDestroyed()) target.win.focus() } catch (_) {}
    console.log(`[window] moved tab ${id} from window #${source.ordinal} to #${target.ordinal}`)
    // 手动迁移也要让同步引擎更新"当前托管窗口"记账 —— 否则下一次切窗会回旧窗口
    // 找活动标签，搬错东西（见 TabSync#notifyTabMoved 的说明）。
    try { tabSync.notifyTabMoved(id, target.win.id) } catch (_) {}
    return { ok: true, movedTo: target.win.id }
  }

  // ═══════════════════════════════════════════════════════════════════
  //  跨窗口标签同步（A5 / J15）
  //
  //  「多个窗口共享同一份标签集合」：焦点切到哪个窗口，当前活动标签的**真实视图**
  //  就迁移过去（走上面那条 moveTabToWindow —— 整体搬 webContents，不是重新加载），
  //  原窗口留一张截图占位。编排逻辑全在 infra-window#TabSync（代际计数器 + 串行队列），
  //  这里只把"本应用的窗口集合 / 活动标签 / 截图 / 迁移"四件事接上。
  // ═══════════════════════════════════════════════════════════════════

  /** 按窗口 id 取本应用的运行单元（找不到返回 null）。 */
  function runtimeOfWindow(windowId: number | string) {
    const id = Number(windowId)
    if (!Number.isFinite(id)) return null
    return browserWindows.all().find((rt) => rt.win.id === id) || null
  }

  /** 向某个窗口的**外壳渲染层**推一条 `ngipc:event:<route>`（窗口已销毁 → 静默丢弃）。 */
  function sendToWindowShell(windowId: number | string, route: string, payload?: unknown) {
    const rt = runtimeOfWindow(windowId)
    if (!rt || rt.win.isDestroyed()) return
    try { rt.win.webContents.send(`ngipc:event:${route}`, payload) } catch (_) {}
  }

  const tabSync = createTabSync({
    // 现读设置（live 开关）：与「省电模式」同款 —— 改完下一次切窗即生效。
    isEnabled: () => {
      try { return settingsService.get(TABS_SETTING_KEYS.syncAcrossWindows) === true } catch (_) { return false }
    },
    getActiveTabId: (windowId: number) => {
      const rt = runtimeOfWindow(windowId)
      return rt ? rt.tabManager.getActiveTabId() : null
    },
    // 无痕标签跑在窗口私有的内存 partition 上，迁移等于把两个本该隔离的会话缝在一起
    //（与 moveTabToWindow 的拒绝理由完全一致）—— 故这里直接判为不可迁移。
    isEligible: (tabId: string) => {
      for (const rt of browserWindows.all()) {
        const list = typeof rt.tabManager.listAll === 'function' ? rt.tabManager.listAll() : []
        const found = list.find((t: UnknownRecord) => t && String(t.tabId) === String(tabId))
        if (!found) continue
        return !found.incognito
      }
      return false
    },
    captureSnapshot: async (tabId: string) => {
      if (!snapshotService) return null
      // 迁移前现采一帧（view 此刻仍挂载在本窗口 —— detach 之后 capturePage 会拿到空图）。
      // 节流命中 / 采集失败 → 退回"最近一帧"；两者都没有则返回 null（不贴占位，迁移照做）。
      for (const rt of browserWindows.all()) {
        const wc = typeof rt.tabManager.getWebContents === 'function'
          ? rt.tabManager.getWebContents(tabId)
          : null
        if (!wc) continue
        try { await snapshotService.capture(tabId, wc) } catch (_) {}
        break
      }
      return snapshotService.urlFor(tabId)
    },
    moveTab: (opts: MoveTabRequest) => moveTabToWindow(opts),
    showPlaceholder: (windowId: number, payload: unknown) => sendToWindowShell(windowId, IPC_EVENTS.tabSyncPlaceholder, payload),
    clearPlaceholder: (windowId: number) => sendToWindowShell(windowId, IPC_EVENTS.tabSyncPlaceholder, { url: null }),
    listWindowIds: () => browserWindows.all().map((rt) => rt.win.id),
    onError: ({ where, error }: { where: string; error: unknown }) => console.warn(`[tabsync] ${where}:`, errorMessage(error))
  })

  // ── core 特性模块（IHiraModule 拓扑启动，Step 6）：downloads + keybindings ──
  // 注意：downloadController 在 switchProfile 里会随 session 重新注册（见下），
  // 所以这里保留可变的 let 绑定，而不是解构常量。
  let downloadController: CallablePort | null = null
  let coreModules!: Awaited<ReturnType<typeof bootstrapCoreModules>>
  /**
   * 快捷键动作表（在 `bootstrapCoreModules` 的 deps 里就地构造）。
   * 这里用一个 ref 把它接住：**自动化（D2/D3）直接复用它当命令执行器** ——
   * 与"再抄一份命令表"相比，抄一份必然漂移，而漂移的表现是"配了但点了没反应"。
   */
  let keybindingActionsRef: Record<string, (...args: unknown[]) => unknown> | null = null
  /**
   * 下载开始 → 自动打开下载面板。
   *
   * 目标窗口：优先**发起下载的 webContents** 所属窗口（多窗口下不能开在别人的窗口里），
   * 解析不到才落焦点窗口。`panelCatalog` 在本函数下方才创建 —— 闭包里**调用时才读**
   * （与 noteActions.showPanel 同一范式，早于创建的引用不会炸）。
   * 选边规则本身在 download-panel-opener.js（左侧有面板 → 右侧开…），这里只做接线。
   */
  const openDownloadPanelFor = createDownloadPanelOpener({
    panelId: 'downloads-panel',
    getPanelCatalog: () => panelCatalog,
    // 已拆到独立窗口 = 面板本来就开着，别再在侧栏造第二份（单实例语义）。
    // `panelPresentation` 同样在本函数下方才创建 —— 闭包里调用时才读。
    isPanelDetached: (panelId: string) => !!(panelPresentation && typeof panelPresentation.isDetached === 'function' && panelPresentation.isDetached(panelId)),
    getRuntime: ({ webContents }: { webContents: WebContents | null | undefined }) => {
      const matched = webContents && typeof runtimeRegistry.matchBySender === 'function'
        ? runtimeRegistry.matchBySender(webContents)
        : null
      return matched || focusedRuntime()
    }
  })
  const downloadOrganizer = createDownloadOrganizer(settingsService, {
    emit,
    slots: slotCall,
    runAction: async (
      action: string,
      input: { url: string; filename: string; filePath: string }
    ) => {
      if (action !== 'collect' && action !== 'read-later') return false
      const { READING_LIST_FOLDER } = require('@hira-ng/shared-types/src/reading-list.mjs')
      const { findReadingFolderId } = require('@hira-ng/shared-types/src/collection-menu.mjs')
      let folderId: string | null = null
      if (action === 'read-later') {
        const folders = notesService && typeof notesService.listFolders === 'function'
          ? notesService.listFolders()
          : []
        folderId = findReadingFolderId(folders)
        if (!folderId && notesService && typeof notesService.addFolder === 'function') {
          const created = await notesService.addFolder({ name: READING_LIST_FOLDER })
          folderId = created && typeof created === 'object' ? created.id : created
        }
      }
      await noteActions.run('note:save-page', {
        url: input.url,
        title: input.filename,
        reveal: false,
        ...(folderId ? { folderId: String(folderId) } : {})
      })
      return true
    }
  })
  const profileSpaceCoordinator = createProfileSpaceCoordinator({
    browserWindows,
    primaryWindow,
    runtimeRegistry,
    spaceRuntime,
    profileService,
    spaceService,
    settingsService,
    passwordService,
    permissionService,
    getActiveProfile: () => activeProfile,
    setActiveProfile: (value: ProfileRecord | null) => { activeProfile = value },
    getActiveSpace: () => activeSpace,
    setActiveSpace: (value: { id: string; profileId: string } | null) => { activeSpace = value },
    resolveProfileDir,
    sessionDirFor,
    runtimeCurrentSpace,
    saveSpaceSession,
    restoreSpaceSession,
    defaultNewTabUrl,
    resolveStartupSpace,
    registerDownloadHandler,
    slotCall,
    emit,
    getOrCreateExtensionService,
    getExtensionService: extensionServiceForProfile,
    setExtensionService: (value: typeof extensionService) => { extensionService = value },
    getStopExtensionRelay: () => stopExtensionRelay,
    registerHiraProtocol,
    pluginProtocolOptions,
    registerPluginProtocol,
    themeAssetRoot,
    registerThemeAssetProtocol,
    externalGames,
    permissionRuntime,
    getDownloadController: () => downloadController,
    resolveDownloadSavePath: downloadOrganizer.resolveSavePath,
    onDownloadCompleted: downloadOrganizer.verifyCompleted,
    setDownloadController: (value: CallablePort | null) => { downloadController = value },
    downloadServiceFor,
    win,
    getGuardDownload: () => windowShared.guardDownload,
    openDownloadPanelFor,
    onProfileContextChanged: (profileId: string) => pwaDetector.clearProfile(profileId),
    STARTUP_SETTING_KEYS,
    SPACE_SCOPED_SETTING_KEYS
  })
  const {
    ensureSpaceSessionOrTab,
    safeSpaceTabCount,
    ensureSpaceHasTab,
    replaySpaceScopedSettings,
    afterProfileContextChanged,
    applyProfileContext,
    switchProfile,
    switchSpace,
    switchToSpaceIndex,
    buildSpaceKeybindingActions
  } = profileSpaceCoordinator
  let updateServiceRef: CallablePort | null = null

  /** 网页/标签动作的统一目标解析：显式 tabId 优先，否则当前活动标签。 */
  function actionTabId(raw?: unknown): string {
    return String(raw == null ? '' : raw).trim() || String(targetTabs().getActiveTabId() || '')
  }

  function actionPageContents(raw?: unknown): WebContents | null {
    const id = actionTabId(raw)
    return id ? targetTabs().getWebContents(id) : null
  }

  function runPageEdit(command: 'undo' | 'redo' | 'cut' | 'copy' | 'paste' | 'delete' | 'selectAll') {
    const id = actionTabId()
    const wc = actionPageContents(id)
    if (!wc) throw new Error('当前标签没有可编辑的网页内容')
    wc.focus()
    const invoke = (wc as WebContents & Record<string, unknown>)[command]
    if (typeof invoke !== 'function') throw new Error(`当前网页不支持 ${command}`)
    ;(invoke as () => void).call(wc)
    return { ok: true, tabId: id, command }
  }

  function toggleSplitWithAdjacent() {
    const tm = targetTabs()
    const activeId = tm.getActiveTabId()
    if (!activeId) return { ok: false, reason: '没有活动标签' }
    const list = tm.list()
    const active = list.find((t: UnknownRecord) => t.tabId === activeId)
    if (active && active.splitId) {
      tm.dissolveSplit({ splitId: active.splitId })
      return { ok: true, action: 'dissolve', tabId: activeId }
    }
    const neighbourId = typeof tm.adjacentTabIdOf === 'function'
      ? tm.adjacentTabIdOf(activeId)
      : null
    if (!neighbourId) return { ok: false, reason: '没有相邻标签可建立分屏' }
    const res = tm.createSplitGroup({ tabIds: [activeId, neighbourId], activeTabId: activeId })
    return res ? { ok: true, action: 'create', tabIds: [activeId, neighbourId] } : { ok: false, reason: '无法建立分屏' }
  }

  function toggleGlanceWithAdjacent() {
    const tm = targetTabs()
    const activeId = tm.getActiveTabId()
    if (!activeId) return { ok: false, reason: '没有活动标签' }
    const list = tm.list()
    const active = list.find((t: UnknownRecord) => t.tabId === activeId)
    if (active && active.glanceId) {
      tm.dissolveGlance({ glanceId: active.glanceId })
      return { ok: true, action: 'dissolve', tabId: activeId }
    }
    const neighbourId = typeof tm.adjacentTabIdOf === 'function'
      ? tm.adjacentTabIdOf(activeId)
      : null
    if (!neighbourId) return { ok: false, reason: '没有相邻标签可建立速览' }
    const res = tm.createGlanceGroup({ tabIds: [neighbourId, activeId], frontTabId: activeId })
    return res ? { ok: true, action: 'create', tabIds: [neighbourId, activeId] } : { ok: false, reason: '无法建立速览' }
  }

  function actionWebUrl(raw: unknown, allowNonHttp = false): string {
    const url = String(raw == null ? '' : raw).trim()
    if (!url) throw new Error('缺少链接地址')
    if (!allowNonHttp && !/^https?:\/\//i.test(url)) throw new Error('目前只允许打开 http(s) 链接')
    return url
  }

  /**
   * Break Mode 控制器（D5）的 ref。
   *
   * 它在 coreModules **之后**才建（要用 browserWindows / focusedRuntime），
   * 但入口必须在这一步就注册好 —— 所以这里用 ref 接住，入口里只做 `ref?.xxx()`，
   * 为空时静默降级（早启动期不会炸）。
   */
  let breakModeRef: CallablePort | null = null
  try {
    coreModules = await bootstrapCoreModules({
      extensionService,
      // 下载记录按 profile 分区，而写入口是 session 事件（无 IPC 上下文）
      // → 在这里把「这是哪个用户」显式钉住（见 downloadServiceFor）。
      downloadService: downloadServiceFor(String(activeProfile?.id || 'default')),
      emit,
      settingsService,
      // 站点守卫（自动下载策略）的判定口：与弹窗拦截同一份规则（见 site-guard.js）
      guardDownload: windowShared.guardDownload,
      // 下载开始 → 自动打开下载面板（左侧有面板则开右侧，见 download-panel-opener.js）
      onDownloadStarted: openDownloadPanelFor,
      resolveDownloadSavePath: downloadOrganizer.resolveSavePath,
      onDownloadCompleted: downloadOrganizer.verifyCompleted,
      win,
      tabManager: scopedTabManager,
      // 插件快捷键（`shortcut.binding`）：内置绑定未命中时现问一次插件
      slots: slotCall,
      keybindingActions: (keybindingActionsRef = {
        // 空间快捷键（B4）：Ctrl+Shift+1..9 → 切到当前 profile 的第 N 个空间。
        // 由工厂生成（下标语义只写一处，见 buildSpaceKeybindingActions）。
        ...buildSpaceKeybindingActions(),
        // 集锦动作（WP1）：九条 `note:*` 与地址栏 / 命令链 / 插件**共用同一张表**
        //（动作表本身在 `main/note-actions.js`，这里只并入命名空间）。
        ...noteActions.actions,
        // 窗口级
        'window:new': () => openBrowserWindow(),
        'window:new-incognito': () => openBrowserWindow({ incognito: true }),
        'tab:new': () => targetTabs().newTab({ url: defaultNewTabUrl() }),
        'tab:new-incognito': () => targetTabs().newIncognitoTab({ url: defaultNewTabUrl() }),
        // ── 以下四条是**面级**动作：靶子 = 焦点所在的那块网页面（见 runSurfaceCommand）──
        // 独立侧栏聚焦时，Ctrl+W 收起侧栏（= 分屏里"关掉活动格"的同一原则）、
        // Ctrl+R / Alt+← → 作用于侧栏那一页；没人认领（活动面就是标签）才落回标签老路。
        //（另有 bookmark:toggle / view:devtools 同样是面级，各自就地接了。）
        'tab:close': () => {
          if (runSurfaceCommand('close')) return
          const id = targetTabs().getActiveTabId(); if (id) targetTabs().close(id)
        },
        'tab:reload': () => {
          if (runSurfaceCommand('reload')) return
          const id = targetTabs().getActiveTabId(); if (id) targetTabs().reload(id)
        },
        'tab:back': () => {
          if (runSurfaceCommand('back')) return
          const id = targetTabs().getActiveTabId(); if (id) targetTabs().goBack(id)
        },
        'tab:forward': () => {
          if (runSurfaceCommand('forward')) return
          const id = targetTabs().getActiveTabId(); if (id) targetTabs().goForward(id)
        },
        // Ctrl+Tab / Ctrl+Shift+Tab：按标签栏顺序循环切换（与主流浏览器一致，不弹浮层）。
        'tab:next': () => targetTabs().nextTab(),
        'tab:prev': () => targetTabs().prevTab(),

        'tab:1': () => switchToIndex(0),
        'tab:2': () => switchToIndex(1),
        'tab:3': () => switchToIndex(2),
        'tab:4': () => switchToIndex(3),
        'tab:5': () => switchToIndex(4),
        'tab:6': () => switchToIndex(5),
        'tab:7': () => switchToIndex(6),
        'tab:8': () => switchToIndex(7),
        'tab:9': () => switchToIndex(-1),
        'tab:undo-close': () => targetTabs().undoClose(),
        'tab:sleep': () => { const id = targetTabs().getActiveTabId(); if (id) targetTabs().sleepTab(id) },
        // 分屏 / 解散分屏（Ctrl+Shift+D）：与活动标签**相邻**的那个标签一起分屏；
        // 已在分屏里则解散。判定与执行全走 TabManager（与右键菜单同一条路），
        // 这里只负责"从哪个标签、往哪个方向找邻居"。
        'tab:split-toggle': () => toggleSplitWithAdjacent(),
        // 速览 / 退出速览（Ctrl+Shift+G）：与活动标签**相邻**的那个标签叠成速览；
        // 已在速览里则退出。与「分屏」完全同款：判定与执行全走 TabManager，
        // 这里只负责"从哪个标签、往哪个方向找邻居"。
        'tab:glance-toggle': () => toggleGlanceWithAdjacent(),
        // 分屏格导航（I6）：从活动格出发按方向切到相邻格。判定全在 TabManager
        // （它向布局层要当前格矩形），这里只报方向。
        'split:focus-left': () => targetTabs().focusSplitPane('left'),
        'split:focus-right': () => targetTabs().focusSplitPane('right'),
        'split:focus-up': () => targetTabs().focusSplitPane('up'),
        'split:focus-down': () => targetTabs().focusSplitPane('down'),
        // ── 书签快捷键（页面聚焦时 shell 收不到 keydown，必须在主进程拦截）──
        // 与渲染层星标同一语义：打开书签编辑器（收藏即编辑），不再静默加/删
        'bookmark:toggle': () => {
          // 面级：侧栏聚焦时收藏的是**侧栏那一页**（见 runSurfaceCommand）
          if (runSurfaceCommand('bookmark')) return
          const tab = targetTabs().list().find((t) => t.active)
          if (!tab || !tab.url || !/^https?:/i.test(tab.url)) return
          const existing = bookmarkService.getByUrl(tab.url)
          openSubWindowByType(existing ? 'edit-bookmark' : 'add-bookmark', {
            url: tab.url,
            title: tab.title || tab.url
          }, targetWindow())
        },
        // 书签栏显隐：改设置键即可，shell 已订阅 settings:changed 热更新。
        // 三态下这条快捷键只在「启用 ←→ 完全不显示」之间切（不做三态循环，
        // 循环会让用户按两下才回到原状）；细档选择在设置页 / 视图菜单。
        'bookmarkbar:toggle': () => {
          const key = BOOKMARKBAR_SETTING_KEY
          settingsService.set(key, toggleBookmarkbarMode(settingsService.get(key)))
        },
        'bookmarks:open': () => { targetTabs().navigate({ url: pageUrl('bookmarks') }) },
        // 集锦面板（Ctrl+Shift+Y，对齐 Edge）：落到集锦面板（集锦 / 全部 / 稍后读 / 回收站）
        // —— 与 rail / 地址栏 `!集锦` 同一条入口（见 notes-panel.js）。
        // 不新造"打开面板"的第二条路 —— 那会与 rail / 地址栏的落点各自漂移。
        'capture:open-hub': () => windowShared.captureHub?.open(),
        'panel:notes-collections': () => {
          try {
            openNotesPanel({
              catalog: panelCatalog,
              layout: targetLayout(),
              mode: 'toggle'
            })
          } catch (_) {}
        },
        // 垂直标签布局 ⇄ 默认布局（Ctrl+Shift+,，对齐 Edge）。
        //
        // 只写「预设宏」定义的那几个**区域键**（真源仍是各栏自己的位置），其余键一律不动 ——
        // 于是用户在侧栏里另放的栏（例如书签栏）不会被这条快捷键拽回来。
        // 渲染层的 chrome-layout-controller 会把预设反推回真实值（syncPresetLabel），
        // 两边都写同一个键不会打架：值一致时它一次都不写。
        'layout:toggle-vertical-tabs': () => {
          const presetKey = LAYOUT_KEYS.preset
          const current = String(settingsService.get(presetKey) || 'classic')
          const next = current.indexOf('vertical') === 0 ? 'classic' : 'vertical-tabs'
          for (const [key, value] of layoutPresetWrites(next)) settingsService.set(key, value)
          settingsService.set(presetKey, next)
        },
        // 地址栏聚焦：Ctrl+L / Alt+D / F6 是**同一个动作的三个键位**（见 keybindings.js）。
        // 别名只占按键槽，实现只有这一处 —— 渲染层收到的仍是同一条 `shortcut:focus-url`。
        'nav:focus-url': () => focusUrlBar(),
        'nav:focus-url-alt': () => focusUrlBar(),
        'nav:focus-url-f6': () => focusUrlBar(),
        // ── 内部页直达（Ctrl+H / Ctrl+J / Ctrl+Shift+Delete）──
        // 与文件菜单 / 工具菜单**同一条落点**：TabManager.navigate 到对应 hira:// 页。
        // 不在动作表里另写一套"打开历史页"的私有路径。
        'history:open': () => { targetTabs().navigate({ url: pageUrl('history') }) },
        'downloads:open': () => { targetTabs().navigate({ url: pageUrl('downloads') }) },
        'clear-data:open': () => { targetTabs().navigate({ url: pageUrl('clear-data') }) },
        // 强制重新加载（Ctrl+Shift+R）：面级命令优先（侧栏聚焦时刷新侧栏那一页），
        // 落回标签时走 TabManager#forceReload（与菜单 tabForceReload 完全同一条实现）。
        'tab:force-reload': () => {
          if (runSurfaceCommand('reload-hard')) return
          const id = targetTabs().getActiveTabId()
          if (id) targetTabs().forceReload(id)
        },
        // 查看源代码（Ctrl+U）：与工具菜单「查看源代码」同一条落点（VIEW_SOURCE 子窗口）。
        'view:view-source': () => openSubWindowByType(WINDOW_TYPES.VIEW_SOURCE, undefined, targetWindow()),
        // ── 打印 / 保存网页 / 标签页搜索（s2 / s3 / s4）──
        // 三者的主进程落点都收在这里：快捷键、应用菜单、PWA 菜单共用同一实现，
        // 渲染层不再各写一套「怎么打印」「怎么保存」。
        'page:print': () => printActiveTab(),
        'page:save': () => saveActiveTab(),
        'tab:search': () => openTabsPanel(),
        // ── 页内查找 / 页面缩放 ──
        // 都转交给**目标窗口**的控制器（按窗口一份，见 browser-window-runtime）：
        // 在窗口 B 按 Ctrl+F 绝不能把查找栏开到窗口 A 上。
        'find:open': () => { const c = targetWindow().findInPage; if (c) c.toggle() },
        'find:next': () => { const c = targetWindow().findInPage; if (c) c.step(true) },
        'find:prev': () => { const c = targetWindow().findInPage; if (c) c.step(false) },
        'zoom:in': () => applyZoom(1),
        'zoom:in-plus': () => applyZoom(1),
        'zoom:out': () => applyZoom(-1),
        'zoom:reset': () => applyZoom(null),
        'view:toggle-fullscreen': () => {
          const w = targetWindow().win
          w.setFullScreen(!w.isFullScreen())
        },
        // Break Mode（D5）：进入 / 退出番茄钟专注。判定与计时全在 main/break-mode.js
        //（它推遮罩给每个窗口的活动标签），这里只报"切换一下"。
        'view:toggle-break': () => {
          const bm = breakModeRef
          if (bm) bm.toggle()
        },
        // 阅读模式（F9 / 视图菜单）：与网页右键菜单同一条注入路径，不新开窗口/面板。
        'view:reader-mode': () => toggleReaderModeActiveTab(),
        'view:devtools': () => {
          // 面级：侧栏聚焦时调试的是**侧栏那一页**（两个 WebContentsView 的 DevTools 互不相干）
          if (runSurfaceCommand('devtools')) return
          const id = targetTabs().getActiveTabId()
          if (id) {
            const wc = targetTabs().getWebContents(id)
            if (wc) wc.toggleDevTools()
          }
        }
      })
    })
    downloadController = asRecord(coreModules).downloadController as CallablePort | null
  } catch (e) {
    console.error('[main] core modules bootstrap failed:', errorMessage(e))
    throw e
  }
  const keybindings = asRecord(coreModules).keybindings as KeybindingsPort
  // 回填装配器：晚段 mount() 要把快捷键挂到本窗口的 chrome + 全部标签 webContents。
  // 挂载点放在 mount（ui-shell 加载前后）而不是这里 —— 多窗口下每个窗口各挂各的。
  windowShared.keybindings = keybindings

  // ── 自动化（D2 命令链 + D3 鼠标手势）────────────────────────────────
  // 命令执行器 = **既有两张动作表的联合**（不新造命令命名空间）：
  //   ① 快捷键动作表（刚建好，覆盖 tab:* / zoom:* / view:* / layout:* … 绝大多数命令）；
  //   ② 地址栏命令（open_* 内部页 / capture_page）—— 由 TabManager 自己认。
  // 控制器（main/automation.js）只做「存取 + 派发」，不认识任何具体命令。
  const automationController = createAutomationController({
    settings: settingsService,
    slots: slotCall,
    dispatch: (action: string, payload?: Record<string, unknown>) => {
      if (action === 'workspace:group-by-domain') {
        try {
          const tabs = targetTabs()
          const rows = tabs.list()
          const tabId = String(payload?.tabId || tabs.getActiveTabId() || '')
          const source = rows.find((tab: UnknownRecord) => String(tab.tabId || '') === tabId)
          const sourceUrl = source ? String(source.url || '') : String(payload?.url || '')
          const siteKey = (() => {
            try {
              const host = new URL(sourceUrl).hostname.toLowerCase()
              return host.startsWith('www.') ? host.slice(4) : host
            } catch (_) { return '' }
          })()
          if (!siteKey) return false
          const tabIds = rows.filter((tab: UnknownRecord) => {
            if (tab.pinned) return false
            try {
              const host = new URL(String(tab.url || '')).hostname.toLowerCase()
              return (host.startsWith('www.') ? host.slice(4) : host) === siteKey
            } catch (_) { return false }
          }).map((tab: UnknownRecord) => String(tab.tabId || '')).filter(Boolean)
          if (tabIds.length < 2) return false
          tabs.createStack({ tabIds, label: siteKey })
          return true
        } catch (e) {
          console.warn('[workspace-rule] group by domain failed:', errorMessage(e))
          return false
        }
      }
      const table = keybindingActionsRef
      if (table && typeof table[action] === 'function') {
        try {
          table[action]()
          return true
        } catch (e) {
          console.warn('[automation] 动作执行失败:', action, errorMessage(e))
          return false
        }
      }
      // 地址栏命令：前缀是稳定的（open_* 一律打开内部页；capture_page 是截图）。
      if (typeof action === 'string' && (action.startsWith('open_') || action === 'capture_page')) {
        try { targetTabs().omniboxAction(action); return true } catch (_) { return false }
      }
      return false
    }
  })
  // 让装配层（→ 各窗口运行单元）能：① 跑命令链；② 手势结束后吞掉那一次右键菜单。
  windowShared.automation = automationController

  // ── Break Mode（D5 番茄钟 / 专注）──────────────────────────────────
  // `push` 推给**每个浏览器窗口的整窗浮层**（main/break-overlay.js）：专注是全局状态，
  // 而浮层按窗口一份 —— 每个窗口都必须被完整盖住（导航栏 / 侧栏 / 网页），
  // 否则"切到另一个窗口继续用"就是绕过专注最简单的办法。
  // 每秒重推一次，于是"专注期间新开窗口 / 浮层被回收"的空档会在 ≤1 秒内被补上。
  breakModeRef = createBreakMode({
    settings: settingsService,
    push: (payload: string) => {
      for (const rt of browserWindows.all()) {
        try {
          if (rt && rt.breakOverlay) rt.breakOverlay.sync(payload)
        } catch (_) {}
      }
    }
  })

  // ── 空间导航（N9）开关下发 ─────────────────────────────────────────
  // 只需建一次：它自己订阅 settings:changed 并把开关广播给所有页面 preload。
  windowShared.spatialNav = createSpatialNavBroadcaster({ settings: settingsService })

  // ── 网页翻译（C3）──────────────────────────────────────────────────
  // 组合根：插件插槽优先，在线来源由 domain-translate 统一调度并自动故障切换。
  const translateService = createTranslateService({ slots: slotCall, settings: settingsService })

  // ── 即时答案（F-0771~F-0773）───────────────────────────────────────
  // 取数与「每日一图」同一套路：Electron `net.fetch` 走系统代理，拿不到时回落全局 fetch。
  // 这条链是"锦上添花"：超时 2.5s、失败静默返回空数组，绝不阻塞本地建议（分通道）。
  const instantAnswerService = createInstantAnswerService({
    fetchImpl: (() => {
      try {
        const { net } = require('electron')
        if (net && typeof net.fetch === 'function') return (url: string, init?: RequestInit) => net.fetch(url, init)
      } catch (_) {}
      return typeof fetch === 'function' ? (url: string, init?: RequestInit) => fetch(url, init) : null
    })()
  })

  /**
   * 「翻译此页」入口：把目标语言**定向**发到那一页的 preload 引擎（`translate:page`）。
   * 定向而不是广播 —— 翻译是"当前这一页"的动作，多窗口下广播会连带翻译别的页面。
   */
  windowShared.translatePage = (webContents: WebContents) => {
    if (!webContents || (typeof webContents.isDestroyed === 'function' && webContents.isDestroyed())) return
    // 「网页翻译」总开关：关掉后入口仍在（菜单 / 快捷键是全局的），但**不再发起翻译**。
    // 之前这个设置项只存在 schema 里、没人读，表现为"关掉了照样翻译"。
    try {
      if (settingsService && settingsService.get('languages.translate_pages') === false) return
    } catch (_) {}
    let to = 'zh'
    try {
      const v = settingsService && typeof settingsService.get === 'function'
        ? settingsService.get('languages.target_language')
        : null
      if (v) to = String(v)
    } catch (_) {}
    try { webContents.send(`ngipc:event:${IPC_EVENTS.translatePage}`, { to }) } catch (_) {}
  }

  // ── 原生应用菜单（对齐 RT app-menu-controller）────────────────────────────────
  // 为什么必须补：此前全库没有 Menu.setApplicationMenu，Windows 上按 Alt 什么都弹不出来，
  // 「文件 / 编辑 / 视图 / 标签页 / 空间 / 帮助」这些最基础的入口全部缺失。
  //
  // 菜单只是「另一条调用路径」：所有动作都复用主进程既有实现，不新增任何业务逻辑。
  // 加速键一律 registerAccelerator:false（见 app-menu.js），按键仍由 keybindings 独占处理，
  // 避免「一次按键触发两遍」。
  /**
   * 缩放页面（快捷键 / 应用菜单）。
   *
   * 真正的执行者是**目标窗口运行单元里的 zoom-controller**（`runtime.zoom`）——
   * 它才有档位阶梯、站点记忆与"通知缩放条浮层"这条出口。本函数只是把
   * 「哪个窗口 + 哪一页」解析清楚后转交：
   *   · `targetWc` 给了（Ctrl+滚轮）→ 先按它解析所属窗口（鼠标在哪个窗口滚就缩哪个窗口），
   *     解析不到再退回有焦点的窗口；
   *   · 没给（快捷键 / 菜单）→ 用有焦点的那个窗口的活动标签。
   * @param {number|null} delta 档位步长（±1 = 上/下一档；null = 复位 100%）
   * @param {Electron.WebContents} [targetWc]
   * @param {'shortcut'|'wheel'|'overlay'} [source] 来源（缩放条据此决定要不要弹出来）
   */
  const applyZoom = (delta: number | null, targetWc?: WebContents | null, source: 'shortcut' | 'wheel' | 'overlay' = 'shortcut') => {
    let runtime = targetWindow()
    if (targetWc && !targetWc.isDestroyed()) {
      runtime = runtimeRegistry.matchBySender(targetWc) || runtime
    }
    const zoom = runtime && runtime.zoom
    if (!zoom) return
    if (delta === null) zoom.reset(targetWc || undefined, source)
    else zoom.step(delta, targetWc || undefined, source)
  }
  // 设置读写端口已提前回填（见上方 createBrowserWindowAssembly 之前的那一段）——
  // 主窗口的 WCO 建窗判定要在 open() 时读到它。

  // 菜单重建的合帧定时器句柄（见 onWindowTabsChanged 的说明）
  let menuRefreshTimer: ReturnType<typeof setTimeout> | null = null

  /**
   * 应用菜单的依赖（动作表 + 状态读取器）。
   *
   * 单独提出来是因为动作表同时是**插件菜单 `action.type='command'` 的执行表**：
   * 插件只写命令名（`"command": "openHistory"`），派发走同一张表 —— 不另开一套
   * "插件命令"；新增一个动作也只是在这里加一行，原生菜单与插件菜单同时生效。
   */
  const appMenuDeps = {
    actions: {
      // 窗口级（对齐 RT file.ts 的「新建窗口」）
      windowNew: () => openBrowserWindow(),
      windowNewIncognito: () => openBrowserWindow({ incognito: true }),
      tabNew: () => targetTabs().newTab({ url: defaultNewTabUrl() }),
      tabNewIncognito: () => targetTabs().newIncognitoTab({ url: defaultNewTabUrl() }),
      tabClose: (rawTabId?: string) => {
        if (!rawTabId && runSurfaceCommand('close')) return
        const id = actionTabId(rawTabId)
        if (id) targetTabs().close(id)
        return { ok: !!id, tabId: id }
      },
      tabReload: (rawTabId?: string) => {
        if (!rawTabId && runSurfaceCommand('reload')) return
        const id = actionTabId(rawTabId)
        if (id) targetTabs().reload(id)
        return { ok: !!id, tabId: id }
      },
      tabForceReload: () => {
        if (runSurfaceCommand('reload-hard')) return
        const id = targetTabs().getActiveTabId()
        if (id) targetTabs().forceReload(id)
      },
      tabNext: () => targetTabs().nextTab(),
      tabPrev: () => targetTabs().prevTab(),
      tabUndoClose: () => targetTabs().undoClose(),
      // 「最近关闭的标签页 ▸ <条目>」：按列表下标恢复指定项（0 = 最近关闭在前）。
      // 与 Ctrl+Shift+T 共用同一份栈与同一个恢复实现（TabManager#undoCloseAt）。
      tabRestoreRecentlyClosed: (index: number) => targetTabs().undoCloseAt(index),
      tabClearRecentlyClosed: () => {
        targetTabs().clearRecentlyClosed()
        appMenu.refresh()
      },
      tabSleep: (rawTabId?: string) => {
        const id = actionTabId(rawTabId)
        if (id) targetTabs().sleepTab(id)
        return { ok: !!id, tabId: id }
      },
      tabTogglePin: (rawTabId?: string) => {
        const id = actionTabId(rawTabId)
        if (!id) return { ok: false }
        const result = targetTabs().togglePin(id)
        // 勾选态需要重建菜单才会更新（Electron 的 checkbox 不会自刷新 label/checked）
        appMenu.refresh()
        return result
      },
      tabToggleMute: (rawTabId?: string) => {
        const id = actionTabId(rawTabId)
        return id ? targetTabs().toggleMute(id) : { ok: false }
      },
      // 关闭其他标签：先过确认闸门（设置开启且确实会关掉一个以上时才问）。
      // 捕获点击瞬间的 runtime —— 确认框停留期间用户可能切走窗口，
      // 关闭仍应作用在"点这一下菜单"的那个窗口上（与焦点跟随语义一致）。
      tabCloseOthers: (rawTabId?: string) => {
        const runtime = targetWindow()
        const id = actionTabId(rawTabId)
        if (!id) return { ok: false }
        tabCloseGuard.shouldCancel('others', id).then((cancel: boolean) => {
          if (!cancel) runtime.tabManager.closeOthers(id)
        }).catch((e: unknown) => {
          console.error('[main] close-others guard failed:', errorMessage(e))
        })
        return { ok: true, tabId: id, scheduled: true }
      },
      tabDuplicate: async (rawTabId?: string) => {
        const id = actionTabId(rawTabId)
        if (!id) return { ok: false }
        const duplicated = await targetTabs().duplicate(id) as { tabId?: string; url?: string } | null
        return {
          ok: !!duplicated?.tabId,
          sourceTabId: id,
          newTabId: duplicated?.tabId || '',
          url: duplicated?.url || ''
        }
      },
      tabCloseRight: (rawTabId?: string) => {
        const id = actionTabId(rawTabId)
        if (!id) return { ok: false }
        targetTabs().closeRight(id)
        return { ok: true, tabId: id }
      },
      tabArchive: (rawTabId?: string) => {
        const id = actionTabId(rawTabId)
        if (!id) return { ok: false }
        targetTabs().archive(id)
        return { ok: true, tabId: id }
      },
      tabAutoRefresh: (minutes: number, rawTabId?: string) => {
        const interval = Number(minutes)
        if (![0, 1, 5, 30].includes(interval)) throw new Error('定时刷新只支持 0 / 1 / 5 / 30 分钟')
        const id = actionTabId(rawTabId)
        if (!id) return { ok: false }
        return targetTabs().setAutoRefresh(id, interval * 60_000)
      },
      tabGroupByDomain: (rawTabId?: string) => {
        const id = actionTabId(rawTabId)
        if (!id) return { ok: false }
        const tabs = targetTabs().list()
        const pivot = tabs.find((tab: UnknownRecord) => String(tab.tabId || '') === id)
        let hostname = ''
        try { hostname = new URL(String(pivot?.url || '')).hostname } catch (_) {}
        const tabIds = hostname
          ? tabs.filter((tab: UnknownRecord) => {
              if (tab.pinned) return false
              try { return new URL(String(tab.url || '')).hostname === hostname } catch (_) { return false }
            }).map((tab: UnknownRecord) => String(tab.tabId || ''))
          : []
        if (tabIds.length < 2) return { ok: false, reason: '同域名标签不足两个' }
        const result = targetTabs().createStack({ tabIds, label: hostname })
        return { ok: !!result, tabIds, label: hostname }
      },
      tabSplitToggle: () => toggleSplitWithAdjacent(),
      tabGlanceToggle: () => toggleGlanceWithAdjacent(),
      splitFocus: (direction: 'left' | 'right' | 'up' | 'down') => {
        targetTabs().focusSplitPane(direction)
        return { ok: true, direction }
      },
      // 标签跨窗口迁移：当前窗口的活动标签 → 新窗口 / 指定窗口
      tabMoveToNewWindow: () => {
        const id = targetTabs().getActiveTabId()
        if (!id) return
        moveTabToWindow({ tabId: id, newWindow: true }).catch((e) => {
          console.error('[main] move tab to new window failed:', errorMessage(e))
        })
      },
      tabMoveToWindow: (targetWindowId: number) => {
        const id = targetTabs().getActiveTabId()
        if (!id) return
        moveTabToWindow({ tabId: id, targetWindowId }).catch((e) => {
          console.error('[main] move tab to window failed:', errorMessage(e))
        })
      },
      navBack: () => {
        if (runSurfaceCommand('back')) return
        const id = targetTabs().getActiveTabId(); if (id) targetTabs().goBack(id)
      },
      navForward: () => {
        if (runSurfaceCommand('forward')) return
        const id = targetTabs().getActiveTabId(); if (id) targetTabs().goForward(id)
      },
      zoomIn: () => applyZoom(1),
      zoomOut: () => applyZoom(-1),
      zoomReset: () => applyZoom(null),
      // 阅读模式（视图菜单 + F9）：页内覆盖层，与网页右键菜单同一条注入路径。
      readerMode: () => toggleReaderModeActiveTab(),
      // 页内查找（视图菜单 + Ctrl+F）：在**当前活动标签**上打开查找栏浮层。
      // 关闭 / 步进由查找栏自己负责 —— 它持有键盘焦点时 chrome 收不到键，只有它能处理。
      findInPage: () => { const c = targetWindow().findInPage; if (c) c.toggle() },
      // 文件菜单：保存网页 / 打印（与 Ctrl+S / Ctrl+P 同一条实现）
      pageSave: () => saveActiveTab(),
      pagePrint: () => printActiveTab(),
      webUndo: () => runPageEdit('undo'),
      webRedo: () => runPageEdit('redo'),
      webCut: () => runPageEdit('cut'),
      webCopy: () => runPageEdit('copy'),
      webPaste: () => runPageEdit('paste'),
      webDelete: () => runPageEdit('delete'),
      webSelectAll: () => runPageEdit('selectAll'),
      webOpenLink: async (rawUrl: string) => {
        const url = actionWebUrl(rawUrl)
        const opened = await targetTabs().newTab({ url }) as { tabId?: string } | null
        return { ok: true, url, newTabId: opened?.tabId || '' }
      },
      webOpenLinkWindow: (rawUrl: string) => {
        const url = actionWebUrl(rawUrl)
        openBrowserWindow({ url })
        return { ok: true, url }
      },
      webCopyLink: (rawUrl: string) => {
        const url = actionWebUrl(rawUrl, true)
        require('electron').clipboard.writeText(url)
        return { ok: true, url }
      },
      webCopyCleanLink: (rawUrl: string) => {
        const url = actionWebUrl(rawUrl, true)
        const cleanUrl = String(stripTrackingParams(url))
        require('electron').clipboard.writeText(cleanUrl)
        return { ok: true, url: cleanUrl, changed: cleanUrl !== url }
      },
      webSaveLinkAs: (rawUrl: string) => {
        const url = actionWebUrl(rawUrl)
        const wc = actionPageContents()
        if (!wc) return { ok: false, reason: '当前标签不可用' }
        wc.downloadURL(url)
        return { ok: true, url, downloadStarted: true }
      },
      webOpenMedia: async (rawUrl: string) => {
        const url = actionWebUrl(rawUrl)
        const opened = await targetTabs().newTab({ url }) as { tabId?: string } | null
        return { ok: true, url, newTabId: opened?.tabId || '' }
      },
      webCopyMedia: (rawUrl: string) => {
        const url = actionWebUrl(rawUrl)
        require('electron').clipboard.writeText(url)
        return { ok: true, url }
      },
      webSaveMediaAs: (rawUrl: string) => {
        const url = actionWebUrl(rawUrl)
        const wc = actionPageContents()
        if (!wc) return { ok: false, reason: '当前标签不可用' }
        wc.downloadURL(url)
        return { ok: true, url, downloadStarted: true }
      },
      webSearchSelection: async (rawText?: string) => {
        let text = String(rawText == null ? '' : rawText).trim()
        if (!text) {
          const wc = actionPageContents()
          if (!wc) return { ok: false, reason: '当前标签不可用' }
          text = String(await wc.executeJavaScript('String(window.getSelection?.() || "")', true) || '').trim()
        }
        if (!text) return { ok: false, reason: '当前网页没有选中文字' }
        const url = typeof searchService?.buildSearchUrl === 'function'
          ? String(searchService.buildSearchUrl(text) || '')
          : ''
        if (!url) throw new Error('搜索服务不可用')
        const opened = await targetTabs().newTab({ url }) as { tabId?: string } | null
        return { ok: true, text, url, newTabId: opened?.tabId || '' }
      },
      webPictureInPicture: async (rawSelector?: string) => {
        const wc = actionPageContents()
        if (!wc) return { ok: false, reason: '当前标签不可用' }
        const selector = String(rawSelector || 'video')
        return wc.executeJavaScript(
          `(async () => {
            const selector = ${JSON.stringify(selector)};
            const video = document.querySelector(selector);
            if (!video) return { ok: false, reason: '没有找到视频元素' };
            if (typeof video.requestPictureInPicture !== 'function') return { ok: false, reason: '该视频不支持画中画' };
            await video.requestPictureInPicture();
            return { ok: true };
          })()`,
          true
        )
      },
      webInspectElement: async (rawSelector?: string) => {
        const id = actionTabId()
        const wc = actionPageContents(id)
        if (!wc) return { ok: false, reason: '当前标签不可用' }
        const selector = String(rawSelector || 'body')
        const point = await wc.executeJavaScript(
          `(() => {
            const el = document.querySelector(${JSON.stringify(selector)});
            if (!el) return null;
            const r = el.getBoundingClientRect();
            return { x: Math.round(r.left + Math.min(r.width / 2, 8)), y: Math.round(r.top + Math.min(r.height / 2, 8)) };
          })()`,
          true
        ) as { x?: number; y?: number } | null
        if (!point) return { ok: false, reason: `没有找到元素：${selector}` }
        wc.inspectElement(Number(point.x) || 0, Number(point.y) || 0)
        return { ok: true, tabId: id, selector }
      },
      // 标签菜单：标签页搜索（Ctrl+Shift+A）—— 打开已开标签面板（自带搜索框）
      tabSearch: () => openTabsPanel(),
      toggleFullscreen: () => {
        const w = targetWindow().win
        w.setFullScreen(!w.isFullScreen())
      },
      toggleDevTools: () => {
        if (runSurfaceCommand('devtools')) return
        const id = targetTabs().getActiveTabId()
        const wc = id ? targetTabs().getWebContents(id) : null
        if (wc) wc.toggleDevTools()
      },
      toggleRail: () => {
        const result = targetLayout().toggleRail()
        try { settingsService.set(LAYOUT_KEYS.toolRailPinned, result?.pinned !== false) } catch (_) {}
        appMenu.refresh()
      },
      // 视图菜单「显示书签栏」子菜单选档（始终 / 仅新标签页 / 从不）。
      // 写设置键即可：渲染层订阅 settings:changed 热更新；menu 重绘以更新 radio 勾选。
      setBookmarkbarMode: (mode: string) => {
        settingsService.set(BOOKMARKBAR_SETTING_KEY, normalizeBookmarkbarMode(mode))
        appMenu.refresh()
      },
      bookmarkToggle: () => {
        // 面级：侧栏聚焦时收藏的是侧栏那一页（与 Ctrl+D 同一条口径）
        if (runSurfaceCommand('bookmark')) return
        const tab = targetTabs().list().find((t: UnknownRecord) => t.active)
        if (!tab || !tab.url || !/^https?:/i.test(tab.url)) return
        const existing = bookmarkService.getByUrl(tab.url)
        openSubWindowByType(existing ? WINDOW_TYPES.EDIT_BOOKMARK : WINDOW_TYPES.ADD_BOOKMARK, {
          url: tab.url,
          title: tab.title || tab.url
        }, targetWindow())
      },
      openBookmarks: () => { targetTabs().navigate({ url: pageUrl('bookmarks') }) },
      openHistory: () => { targetTabs().navigate({ url: pageUrl('history') }) },
      openDownloads: () => { targetTabs().navigate({ url: pageUrl('downloads') }) },
      // 已安装应用管理页（PWA）：与其它内部页同构 —— pages/apps → hira://apps。
      openApps: () => { targetTabs().navigate({ url: pageUrl('apps') }) },
      /**
       * 「文件 → 将本页安装为应用…」。
       *
       * 与地址栏按钮**同一条管线**：`pwaDetector.prepare` 是候选的唯一生成点，
       * 确认窗只负责展示与收集开关。已安装时直接聚焦应用窗（与 Edge 一致），
       * 不再弹一个只会显示「重新安装」的确认框。
       */
      installCurrentPage: async () => {
        try {
          const rt = targetWindow()
          const tabs = targetTabs()
          let tabId = ''
          try { tabId = tabs && tabs.getActiveTabId ? String(tabs.getActiveTabId() || '') : '' } catch (_) { tabId = '' }
          if (!tabId) return
          // prepare 会补采页面 head 线索（网络往返），必须 await。
          const prepared = await pwaDetector.prepare({ runtime: rt, tabId })
          if (!prepared || !prepared.ok) return
          const preview = prepared.preview || {}
          if (preview.installedId) {
            const profileId = rt.spaceRuntime?.getCurrent?.()?.profileId
              || (activeSpace && activeSpace.profileId) || (activeProfile && activeProfile.id) || 'default'
            const result = pwaRuntime.open(preview.installedId, profileId, null)
            if (!result.ok) console.warn('[pwa] 打开已安装应用失败:', result.reason, preview.installedId)
            return
          }
          openSubWindowByType(WINDOW_TYPES.PWA_INSTALL, {
            candidateId: prepared.candidateId,
            preview
          }, rt)
        } catch (err) {
          console.warn('[pwa] 准备安装失败:', errorMessage(err))
        }
      },
      // 其余内部页入口：与上面三条完全同构（菜单项与 hira:// 页面一一对应）。
      // 子窗口只留给「无法文件化的工具」——查看源代码。
      openExtensions: () => { targetTabs().navigate({ url: pageUrl('extensions') }) },
      openPasswords: () => { targetTabs().navigate({ url: pageUrl('passwords') }) },
      // 生成密码浮层：落到**发起菜单的那个窗口**（targetWindow = 聚焦窗口）的控制器上，
      // 与 `password:generate` 路由共用同一实现（ipc/passwords.js#generatePassword）。
      generatePassword: () => {
        const c = targetWindow().passwordOverlayController
        if (c && typeof c.generatePassword === 'function') c.generatePassword({ x: 0, y: 0 })
      },
      openPermissions: () => { targetTabs().navigate({ url: pageUrl('permissions') }) },
      openCookies: () => { targetTabs().navigate({ url: pageUrl('cookies') }) },
      openClearData: () => { targetTabs().navigate({ url: pageUrl('clear-data') }) },
      openImportData: () => { targetTabs().navigate({ url: pageUrl('import-data') }) },
      // 与页面信息同一条来源语义：新标签读取点菜单时正在看的站点，不覆盖它。
      openCertificates: () => {
        const tabs = targetTabs()
        const sourceTabId = tabs.getActiveTabId ? tabs.getActiveTabId() : null
        const url = sourceTabId
          ? pageUrl('certificates', { tabId: sourceTabId })
          : pageUrl('certificates')
        tabs.newTab({ url })
      },
      // 页面信息看的是「点菜单时那一页」：来源 tabId 必须在开新标签**之前**取。
      // 沿用当前标签会把那一页替换掉，之后 page-info 只能查到它自己。
      openPageInfo: () => {
        const tabs = targetTabs()
        const sourceTabId = tabs.getActiveTabId ? tabs.getActiveTabId() : null
        const url = sourceTabId
          ? pageUrl('page-info', { tabId: sourceTabId })
          : pageUrl('page-info')
        tabs.newTab({ url })
      },
      // 软件更新不再是独立页面：它已经是「关于 Hira」页里的第二个选项卡
      // （hira://about?tab=update）。所有入口（应用菜单 / 地址栏命令 / 设置）
      // 都落在这一条 URL 上，页面本身不认"谁叫我来的"。
      openUpdate: () => { targetTabs().navigate({ url: pageUrl('about', { tab: 'update' }) }) },
      openCrashReport: () => { targetTabs().navigate({ url: pageUrl('crash-report') }) },
      // 会话：原来是独立的「会话管理」子窗口，现在是侧栏面板 —— 与集锦同一条开关通道
      // （layoutCoordinator.togglePanel）。面板比 520×380 的浮窗更能装下会话列表，
      // 而且总览面板里也能直接管理会话（同一个 sessions 端口）。
      openSessionsPanel: () => {
        try { targetLayout().togglePanel('sessions-panel', {}) } catch (_) {}
      },
      openViewSource: () => openSubWindowByType(WINDOW_TYPES.VIEW_SOURCE, undefined, targetWindow()),
      openSpaces: () => { targetTabs().navigate({ url: pageUrl('spaces') }) },
      // 集锦（经典 Edge Collections 完全体）：应用菜单 → 工具 → 集锦。
      // 与 Ctrl+Shift+Y / 地址栏 `!集锦` **同一条落点** —— 集锦面板
      // （见 notes-panel.js#openNotesPanel），绝不新造"打开面板"的第二条路。
      captureHub: () => windowShared.captureHub?.open(),
      archiveCurrent: async () => {
        const result = await windowShared.pageLibrary?.archiveActive()
        if (result && typeof result === 'object' && (result as { ok?: boolean }).ok === true) {
          const note = (result as { note?: Record<string, unknown> }).note
          try {
            await noteActions.run('note:open-panel', {
              section: 'collections',
              folderId: note?.folderId
            })
          } catch (_) {}
        }
        return result
      },
      openCollections: () => {
        try {
          openNotesPanel({
            catalog: panelCatalog,
            layout: targetLayout(),
            mode: 'toggle'
          })
        } catch (_) {}
      },
      // 「把当前页收进集锦 ▸ <集锦>」：**复用** window 装配层那份页面收录工具
      // （capturePageIntoCollection —— 与页面右键四项同一套落点解析与去重口径）。
      // 目标集锦由**应用菜单的子菜单项**给出（未归档 / 某个集锦 / 新建集锦…），
      // 选项集合与顺序来自共享真源（见 getState 的 collections）。
      //
      // ⚠ 画面来源取"当前窗口的**活动标签** webContents"，判据只有一处：
      //   `getActiveTabId()`（活动标签只有主进程权威）+ `getWebContents(id)` ——
      //   与 tabReload / tabDuplicate 那几处同一写法；**不再**拿 `list()` 的投影去找
      //   "哪条 active"（那是渲染侧的一份投影，多一层猜测就多一次漂移）。
      collectCurrentPage: (target: import('./browser-window-assembly').CollectionTarget) => {
        const tabs = targetTabs()
        let activeId = ''
        try { activeId = tabs && tabs.getActiveTabId ? String(tabs.getActiveTabId() || '') : '' } catch (_) { activeId = '' }
        const wc = activeId && typeof tabs.getWebContents === 'function' ? tabs.getWebContents(activeId) : null
        // 只在真网页（http/https）上生效：内部页收进去没有意义（S4：宁可不出现，也不要点了没反应）。
        let url = ''
        let title = ''
        try { url = wc ? String(wc.getURL() || '') : '' } catch (_) { url = '' }
        if (!/^https?:/i.test(url)) return
        try { title = wc ? String(wc.getTitle() || '') : '' } catch (_) { title = '' }
        try {
          capturePageIntoCollection(notesService, notesAssets, target, { url, title, webContents: wc }).catch(() => {})
        } catch (_) {}
        // 收完把面板打开，让这次收录看得见（与页面右键收录的收尾同一条口径）。
        try {
          openNotesPanel({
            catalog: panelCatalog,
            layout: targetLayout(),
            mode: 'show'
          })
        } catch (_) {}
      },
      // 「快捷键」与「关于」同构：已经是完整的 hira://shortcuts 内部页，直接在当前标签打开。
      // 不再走子窗口 —— 子窗口里的那份 UI 与主进程键位表是两套真源，已随此次迁移删除。
      openShortcuts: () => targetTabs().navigate({ url: pageUrl('shortcuts') }),
      openTaskManager: () => openSubWindowByType(WINDOW_TYPES.TASK_MANAGER, undefined, targetWindow()),
      // 「关于」不再弹子窗口，改为在当前标签直接打开内部页
      // （与书签/历史等内部页入口同构：子窗口只留给「无法文件化的编辑器」，
      //  about 本身就是一张完整的 hira:// 页面，没有理由再套一层窗口）。
      openAbout: () => targetTabs().navigate({ url: pageUrl('about') }),
      switchSpace: (spaceId: string) => {
        const rt = targetWindow()
        const profileId = (typeof rt.spaceRuntime?.getCurrent === 'function' ? rt.spaceRuntime.getCurrent()?.profileId : null)
          || (activeSpace && activeSpace.profileId) || (activeProfile && activeProfile.id) || 'default'
        Promise.resolve(switchSpace(spaceId, profileId, rt)).catch((e: unknown) => {
          console.error('[main] menu switchSpace failed:', errorMessage(e))
        })
      }
    },
    // 菜单里显示的组合键：动作名 → keybindings.mjs#MENU_ACTION_KEYBINDINGS → 当前键位
    // → Electron accelerator。菜单不再手抄 `CmdOrCtrl+…`，改键后显示自动跟随。
    getAccelerator: (action: string) => menuAccelerator(action, keybindings.getKeybindings()),
    // 键位快照并入菜单状态签名：改键 → 菜单重建（否则显示的还是旧组合键）。
    getKeybindingSignature: () => JSON.stringify(keybindings.getKeybindings()),
    getState: () => {
      // 菜单的勾选态必须反映**焦点窗口**：否则 B 窗口的空间/rail 状态会显示成 A 的
      const targetSpaceRuntime = targetWindow().spaceRuntime
      const cur = targetSpaceRuntime && typeof targetSpaceRuntime.getCurrent === 'function'
        ? targetSpaceRuntime.getCurrent()
        : null
      const profileId = cur?.profileId || (activeSpace && activeSpace.profileId) || (activeProfile && activeProfile.id) || 'default'
      let spaces = []
      try {
        // internal（无痕）空间不外露 —— 与 space:list-all 的过滤口径一致
        spaces = spaceService.list(profileId).filter((s: UnknownRecord) => !s.internal)
      } catch (_) {
        spaces = []
      }
      const lc = targetLayout()
      // 集锦列表：应用菜单「把当前页收进集锦 ▸」的子菜单要用它。
      // 与页面右键 / 标签右键 / 面板取的是**同一份数据**（notesService.listFolders），
      // 顺序也是同一套（sortOrder 升序）—— 四个入口的菜单因此逐项一致。
      let collections = []
      try {
        const rows = notesService && typeof notesService.listFolders === 'function' ? notesService.listFolders() : []
        collections = Array.isArray(rows) ? rows : []
      } catch (_) {
        collections = []
      }
      // 「当前页能不能收」：与 collectCurrentPage 的判据**同一处**（真网页才可收）。
      // 菜单项据此置灰 —— 内部页上让整项变灰，比"点了没反应"清楚（S4）。
      let canCollectCurrentPage = false
      try {
        const tabs = targetTabs()
        const activeId = tabs && tabs.getActiveTabId ? String(tabs.getActiveTabId() || '') : ''
        const wc = activeId && typeof tabs.getWebContents === 'function' ? tabs.getWebContents(activeId) : null
        canCollectCurrentPage = /^https?:/i.test(wc ? String(wc.getURL() || '') : '')
      } catch (_) {
        canCollectCurrentPage = false
      }
      // 「将本页安装为应用」：判据与 installCurrentPage / pwa:prepare 完全同源 ——
      // 标签存在 + 当前地址是 http(s) + 不是无痕标签（无痕页不参与安装，见 detect.js）。
      let canInstallCurrentPage = false
      try {
        const tabs = targetTabs()
        const activeId = tabs && tabs.getActiveTabId ? String(tabs.getActiveTabId() || '') : ''
        const wc = activeId && typeof tabs.getWebContents === 'function' ? tabs.getWebContents(activeId) : null
        const incognito = activeId && typeof tabs.isIncognitoTab === 'function'
          ? !!tabs.isIncognitoTab(activeId)
          : false
        canInstallCurrentPage = !incognito && /^https?:/i.test(wc ? String(wc.getURL() || '') : '')
      } catch (_) {
        canInstallCurrentPage = false
      }
      // 「最近关闭的标签页」子菜单：直接读撤销栈（与 Ctrl+Shift+T 同一份）。
      // 只暴露菜单需要的三个字段，菜单不接触 TabManager 内部结构。
      let recentlyClosed: Array<{ title?: unknown; url?: unknown; closedAt?: unknown }> = []
      try {
        const rows: unknown = typeof targetTabs().listRecentlyClosed === 'function'
          ? targetTabs().listRecentlyClosed()
          : []
        recentlyClosed = (Array.isArray(rows) ? rows : []).map((entry: UnknownRecord) => ({
          title: entry.title,
          url: entry.url,
          closedAt: entry.closedAt
        }))
      } catch (_) {
        recentlyClosed = []
      }
      let canGoBack = false
      let canGoForward = false
      try {
        const tabs = targetTabs()
        const activeId = tabs && typeof tabs.getActiveTabId === 'function'
          ? String(tabs.getActiveTabId() || '')
          : ''
        if (activeId) {
          canGoBack = typeof tabs.canGoBack === 'function' ? !!tabs.canGoBack(activeId) : false
          canGoForward = typeof tabs.canGoForward === 'function' ? !!tabs.canGoForward(activeId) : false
        }
      } catch (_) {}
      return {
        spaces,
        currentSpaceId: cur?.spaceId || (activeSpace ? activeSpace.id : null),
        railPinned: typeof lc.isRailPinned === 'function' ? lc.isRailPinned() : true,
        bookmarkbarMode: normalizeBookmarkbarMode(settingsService.get(BOOKMARKBAR_SETTING_KEY)),
        // 「移动到其他窗口」子菜单的目标列表（含 focused 标记，用来排除当前窗口）
        windows: listBrowserWindows(),
        // 「把当前页收进集锦」子菜单的集锦列表
        collections,
        // 「最近关闭的标签页」子菜单（最近关闭在前）
        recentlyClosed,
        canCollectCurrentPage,
        canInstallCurrentPage,
        canGoBack,
        canGoForward,
        // 功能面可用性（§10.4）：应用菜单据此隐藏"引擎已被关掉"的入口。
        // 它同时进入 `install()` 的状态签名 —— 插件启停后菜单会自动重建，
        // 不需要各调用点记得手动 refresh（见 app-menu.js#install 的签名说明）。
        features: featureMap.resolveFeatureAvailability(pluginRegistry)
      }
    },
    // 插件菜单适配器：原生菜单不认识插件，只按 where 索要已编译好的菜单项。
    // 实例在贡献注册表就绪后才创建（见本文件后半段），这里惰性取值。
    getPluginMenus: () => (pluginSurfaces ? pluginSurfaces.getPluginMenus() : null)
  }
  const appMenuActions = appMenuDeps.actions
  // 动作面（元数据 + list/run）：与原生菜单、插件菜单**共用同一张执行表**，
  // 只是补了「给模型看的名字 / 说明 / 参数」。见 main/app-actions.js 文件头。
  const appActions = createAppActions({
    actions: appMenuActions,
    getState: () => appMenuDeps.getState(),
    settingsActions
  })
  const appMenu = createAppMenu(appMenuDeps)
  appMenu.install()
  // 改键 → 菜单里的组合键必须跟着变（菜单显示的是键位表的投影，不是它的副本）。
  // 只认 `keybindings` 这一把键：其它设置由各自的 appMenu.refresh() 触发点负责。
  settingsService.subscribe((change: { key?: string }) => {
    if (change && change.key === 'keybindings') {
      try { appMenu.refresh() } catch (_) {}
    }
  })
  // ── 平台入口：Windows 任务栏 JumpList / macOS Dock 菜单 ──────────
  // 任务栏 / Dock 上的「新建窗口」是最常用的一条多窗口路径（不必先拉出窗口）。
  // 复用与原生菜单**同一批动作名**，不新增业务逻辑。
  // 动作表是模块级可变对象：second-instance 在模块加载期就注册了，那时这些实现
  // 还不存在；任务栏点击必然转交给已启动完成的实例，因此此处回填即可。
  platformActions.windowNew = () => { openBrowserWindow() }
  platformActions.windowNewIncognito = () => { openBrowserWindow({ incognito: true }) }
  platformActions.tabNew = () => { targetTabs().newTab({ url: defaultNewTabUrl() }) }
  registerPlatformIntegration({ app, actions: platformActions })
  // ── 默认浏览器 / 文件关联：启动后幂等校正 ──────────────────────────
  // 安装器已经写过一遍（build/installer.nsh 的生成区）；这里覆盖两种安装器管不到的情形：
  //   · 换目录覆盖安装（注册表里的 open 命令还指向旧路径）；
  //   · 免安装直接运行打包产物。
  // 放到启动后几秒：写入要起十几次 reg.exe，绝不占用首屏时间；失败也只告警。
  setTimeout(() => {
    void registerDefaultClient().catch((e: unknown) => {
      console.warn('[default-client] 关联校正失败:', errorMessage(e))
    })
  }, 3000).unref?.()
  // 菜单勾选态跟随窗口焦点变化（不同窗口的空间/rail 状态不同）
  app.on('browser-window-focus', (_event: ElectronEvent, win: BrowserWindow) => {
    try { appMenu.refresh() } catch (_) {}
    // 跨窗口标签同步（A5/J15）：焦点窗口即"共享活动标签该落在哪个窗口"。
    // 引擎自带代际计数器去抖（切窗会连发多次 focus），这里只如实上报。
    try { if (win && !win.isDestroyed()) tabSync.notifyFocus(win.id) } catch (_) {}
  })
  // 每个窗口的 tab:changed 都要刷新菜单（活动标签的固定/静音态影响勾选）。
  //
  // 合帧窗口取 150ms，而不是微任务：`tab:changed` 的那几个触发源来自**不同宏任务**
  // （导航 / 标题 / favicon / 加载态），微任务一个都合不掉 —— 一次导航就是一次
  // 「重建整份菜单模板 + Menu.buildFromTemplate + Menu.setApplicationMenu」。
  // 菜单是**原生**对象，最后那一步会重建窗口菜单栏，属导航路径上不该有的开销；
  // 而"菜单晚 150ms 才对"用户根本无从察觉（原生菜单只在被拉开时才渲染）。
  // 另：app-menu 内部还会按状态签名跳过无变化的重建（见其 install 的说明），
  // 两者叠加后绝大多数 tab:changed 连模板都不会重建。
  windowShared.onWindowTabsChanged = () => {
    if (menuRefreshTimer) return
    menuRefreshTimer = setTimeout(() => {
      menuRefreshTimer = null
      try { appMenu.refresh() } catch (_) {}
    }, 150)
  }
  /**
   * `onError` 是连环坏判定的第二个入口（provider 链路）。与扩展点那条的区别：
   * provider 的 `around` 里**包着域服务调用**，所以要靠 `hiraDomainServiceError`
   * 标记把"域服务的错"筛掉（`reportPluginError` 内部统一过滤）。
   *
   * 这里按 capability 反查 pluginId：`_onError` 只回传 providerId/capability。
   */
  const providerRegistry = new ProviderRegistry({
    onError: (error: unknown, execution: UnknownRecord) => {
      const capability = execution && execution.capability
      if (!capability) return
      const providers = providerRegistry.getByCapability(capability)
      const pluginId = providers.length ? providers[0].pluginId : null
      if (pluginId) reportPluginError(pluginId, error)
    }
  })
  /**
   * 声明式贡献注册表（面板 / 后续的按钮、菜单项、设置分区…）。
   *
   * 为什么在 main.js 里建而不是交给插件启动器：面板目录必须在 registerCoreIpc
   * **之前**就能被 IPC 读到（rail/navbar 首屏就要渲染），而插件是后台启动的。
   * 三者因此共享同一个实例：main.js 建 → 注入 PluginRegistryV2 → panelCatalog 消费。
   */
  const contributions = createContributionRegistry()
  // 主题服务读 `contributes.themes`（声明式主题，零代码）的口子在这里接上。
  // 注册表比主题服务晚出生（见 theme-service 里"为什么晚绑定"），故用 setter 注入。
  themeService.setContributions(contributions)
  const panelCatalog = createPanelCatalog({
    contributions,
    // 面板「做减法 / 改写」的唯一入口（PART18）：插件通过 `panelOverrides` 贡献
    // 声明 remove / patch，目录在每次 list 时现取现应用。
    // ⚠ 必须是**延迟取**：pluginSurfaces 在本行之后才创建（3873 → 3973）。
    overrides: () => (pluginSurfaces ? pluginSurfaces.listPanelOverrides() : [])
  })
  /**
   * 把目录也挂到窗口装配的共享依赖上：每个窗口的面板视图端口要按 id 查"这条面板怎么加载"
   *（`apps/app-main/src/main/panel-views.js`）。目录在这里才建出来，而窗口可能更早创建
   * —— 所以它必须能被**延迟取用**（装配期读的是 `shared.panelCatalog`，见 browser-window-assembly）。
   */
  windowShared.panelCatalog = panelCatalog

  /**
   * 面板换宿主服务（侧栏 ↔ `detached-panel` 窗口）。
   *
   * 位置理由与 panelCatalog 相同：IPC 注册（registerCoreIpc）与插件内核端口（kernel）
   * 都要拿到**同一个实例**，所以它必须在两者之前建好。
   *
   * `getLayout` 按**调用时刻**解析：IPC handler 跑在 `runWithSender` 上下文里，
   * 用 runtimeRegistry 的当前窗口；插件（无上下文）落到焦点窗口 —— 面板开在哪个窗口，
   * 侧栏那份就该在哪个窗口收起/恢复。
   */
  const panelPresentation = createPanelPresentation({
    openWindow: openSubWindowByType,
    getWindow: (type: string) => windowRegistry.getSingleton(type),
    getLayout: () => {
      const rt = runtimeRegistry && typeof runtimeRegistry.currentOrNull === 'function'
        ? runtimeRegistry.currentOrNull()
        : null
      return (rt && rt.layoutCoordinator) || targetWindow().layoutCoordinator
    },
    getPanelCatalog: () => panelCatalog,
    emit,
    events: { panelTransferred: IPC_EVENTS.panelTransferred }
  })

  /**
   * 插件表面装配（pages / bangs / menus 三类声明式贡献面）。
   *
   * 位置很关键：必须在 `contributions` 之后、`registerCoreIpc` 之前 —— 前者是贡献表
   * 真源，后者要把 `getPluginBangs` 端口转给搜索 IPC。`pluginSurfaces` 变量本身在
   * 文件更早处声明（应用菜单首次安装就会回调 `getPluginMenus`，那时它还是 null）。
   */
  /**
   * 插件事件中枢（PART18）：插件订阅「浏览器里发生了什么」的唯一入口。
   * 主进程没有全局事件总线，这里也不引入 —— 组合根在 `emit`（广播出口）里顺手喂进来，
   * 因此插件能收到的就是**外壳/页面本来就能收到的那批事件**，不新增第二套事件源。
   */
  const pluginHub = createEventHub()
  // 接上 emit 出口（见上方 pluginHubRef 的说明）：从这一刻起，所有广播都会同步进插件事件中枢。
  pluginHubRef = pluginHub
  /**
   * 插件浮层宿主（PART18）：`ctx.browser.ui.overlay.show()` 的落点。
   *
   * 浮层内容 = 插件内部页 URL（函数过不了进程边界），记录按窗口分桶。
   * `pageUrl` 走延迟闭包：pluginSurfaces 在本块之后才创建。
   */
  const pluginOverlayHost = createPluginOverlayHost({
    emit,
    pageUrl: (ref: string, pluginId: string) => (pluginSurfaces ? pluginSurfaces.pageUrl(ref, pluginId) : ''),
    hub: pluginHub,
    getWindowId: () => {
      try {
        const rt = runtimeRegistry.currentOrNull() || focusedRuntime()
        return rt && rt.win && !rt.win.isDestroyed() ? rt.win.id : 0
      } catch (_) {
        return 0
      }
    },
    isWindowAlive: (windowId: number) => {
      const alive = windowRegistry.getById(windowId)
      return !!alive && !alive.isDestroyed()
    },
    logger: console
  })

  pluginSurfaces = createPluginSurfaces({
    contributions,
    slotCall,
    registerHiraPage,
    unregisterHiraPage,
    serveStaticAsync,
    // 只对**已启用**的插件返回目录 —— 与 hira-plugin:// 同一条安全边界。
    getPluginRoot: (id: string) => pluginProtocolOptions.getPluginRoot(id),
    getPluginPermissionLevel: (id: string) => pluginProtocolOptions.getPluginPermissionLevel
      ? pluginProtocolOptions.getPluginPermissionLevel(id)
      : null,
    // 打开地址一律落在"焦点窗口的活动标签"，与原生菜单的落点口径完全一致。
    openUrl: (url: string) => { targetTabs().navigate({ url }) },
    openPage: openPagePreferExisting,
    // 面板先过目录存在性守卫：宁可不出现，也不要点了没反应（S4）。
    openPanel: (panelId: string) => {
      if (typeof panelCatalog.has === 'function' && !panelCatalog.has(panelId)) return
      targetLayout().showPanel(panelId)
    },
    // 插件菜单的 `command` 动作 → 原生菜单**同一张动作表**（不另开一套插件命令）。
    runCommand: (name: string) => {
      const fn = (appMenuActions as Record<string, (...args: unknown[]) => unknown>)[name]
      if (typeof fn !== 'function') return false
      fn()
      return true
    },
    // 声明式 UI 贡献（navbar / rail / 标签动作 / 浮层）→ 官方插槽实现。
    // 调度器在 1324 行就建好了（早于本块），这里注入的是**同一个实例**。
    extensionPoints,
    // 浮层动作（`action.type='overlay'`）→ 浮层宿主。
    showOverlay: (descriptor: UnknownRecord, pluginId: string) => pluginOverlayHost.show(descriptor, pluginId),
    // 用户脚本宿主运行时：`@require` 取码走它（脚本注入点与 GM 代理共用同一个实例）。
    userScriptRuntime,
    // 单脚本启停的真源：`plugins.userscripts.disabled`（全局键，随设置同步落盘）。
    getDisabledUserScripts: () => pluginStateStore.loadDisabledUserScripts(),
    // bang 变化 → 与 customBangs 同一条广播通道（search-controller 据此重拉 config）。
    onBangsChanged: () => {
      const sync = profileSpaceCoordinator.getSettingsSync()
      if (sync && typeof sync.broadcast === 'function') {
        sync.broadcast({ scope: 'one', key: 'search.plugin_bangs', value: undefined })
      }
    },
    // 菜单变化 → 立刻重建原生菜单（插件启停必须马上看得见）。
    onMenusChanged: () => {
      try { appMenu.refresh() } catch (_) {}
    },
    // 外壳贡献（navbar / rail / 标签动作 / 浮层 / 命令）变化 → 各窗口外壳重拉插槽。
    // 与 menus 分开：那条重建原生菜单，这条只让渲染层重新 list 三张轻量表。
    onChromeChanged: () => {
      try { emit(IPC_EVENTS.pluginChromeChanged, {}) } catch (_) {}
    },
    logger: console
  })

  /**
   * 插件能力门面（PART18 开放世界）：`ctx.browser` 的唯一装配点。
   *
   * 全部端口都写成 **getter** —— 本块之前/之后创建的实例都一律按调用时刻解析，
   * 于是"谁先谁后"不再是一个会踩空的顺序问题（这也是本文件反复出现的教训）。
   * 权限判定、错误形状、边界校验全部在 plugin-capabilities.js 里，这里不重复。
   */
  const pluginCapabilities = createPluginCapabilities({
    hub: pluginHub,
    logger: console,
    getAppInfo: () => ({
      name: app.getName(),
      version: app.getVersion(),
      platform: process.platform,
      locale: app.getLocale(),
      packaged: isPackagedRuntime()
    }),
    getThemeManager: () => themeManager,
    getTabManager: () => scopedTabManager,
    getLayoutCoordinator: () => targetLayout(),
    getPanelCatalog: () => panelCatalog,
    getContributions: () => contributions,
    getPluginStorage: () => pluginStorage,
    getPluginSurfaces: () => pluginSurfaces,
    getExtensionPoints: () => extensionPoints,
    getAutomation: () => automationController,
    getAppActions: () => appActions,
    getSettings: () => settingsService,
    getPluginRoot: (id: string) => pluginProtocolOptions.getPluginRoot(id),
    getOverlayHost: () => pluginOverlayHost,
    openUrl: openPagePreferExisting,
    // 贡献表变化后的统一收尾（面板对账 + 表面同步 + 渲染层外壳重拉）。
    notifySurfaces: () => { refreshPluginSurfaces() },
    listWindows: () => windowRegistry.list().map((win: BrowserWindow) => ({
      id: win.id,
      title: (() => { try { return win.getTitle() } catch (_) { return '' } })(),
      focused: (() => { try { return win.isFocused() } catch (_) { return false } })()
    })),
    getCurrentWindowId: () => {
      try {
        const rt = runtimeRegistry.currentOrNull() || focusedRuntime()
        return rt && rt.win && !rt.win.isDestroyed() ? rt.win.id : null
      } catch (_) {
        return null
      }
    },
    focusWindow: (windowId: number) => {
      const win = windowRegistry.getById(Number(windowId))
      if (!win || (typeof win.isDestroyed === 'function' && win.isDestroyed())) return false
      win.focus()
      return true
    },
    openWindow: (opts?: UnknownRecord) => openSubWindowByType('browser', opts || {}),
    readClipboard: () => require('electron').clipboard.readText(),
    writeClipboard: (text: string) => require('electron').clipboard.writeText(text)
  })

  /**
   * 面板目录变动后的**全局对账**：让每个窗口关掉并销毁已失效的面板视图。
   *
   * ── 解决什么 ──────────────────────────────────────────────────────
   * 禁用某个面板插件之后目录里没有它的 id 了，但**已经打开的那份面板视图
   * 仍常驻**（还占着宽度、还显示内容、渲染进程也不退）。渲染层那边的按钮会随广播
   * 消失，于是出现「按钮没了、面板还在」的错位 —— 用户感受就是"开关没生效"。
   *
   * ── 为什么用「目录指纹」短路 ─────────────────────────────────────
   * 启停一个 domain 插件（如 `bookmark-service`）不改变面板集合，此时不该去打扰
   * 布局层（`reconcilePanels` 会遍历并重排，白费）。指纹一样就直接返回。
   *
   * @returns {number} 被销毁的面板视图总数
   */
  let lastPanelIdKey: string | null = null
  const reconcilePanelsAcrossWindows = () => {
    const ids = panelCatalog.ids()
    const key = ids.join('\u0000')
    if (key === lastPanelIdKey) return 0
    lastPanelIdKey = key
    let destroyed = 0
    for (const runtime of runtimeRegistry.list()) {
      try {
        const coordinator = runtime && runtime.layoutCoordinator
        if (coordinator && typeof coordinator.reconcilePanels === 'function') {
          destroyed += coordinator.reconcilePanels(ids)
        }
      } catch (e) {
        console.warn('[main] reconcilePanels failed:', errorMessage(e))
      }
    }
    if (destroyed) console.log(`[main] panel reconcile: released ${destroyed} panel view(s)`)
    return destroyed
  }

  /**
   * 贡献表变化后的**统一收尾**（插件启用 / 禁用 / 自动停用 / 启动就绪都走这里）。
   *
   * 为什么要有这个函数：面板、内部页、bang、菜单四类贡献面的刷新时机完全相同
   * ——「插件集合变了 / 某个插件的 contributes 变了」。分散在各处各调一次，早晚漏一条
   * （漏的后果就是"插件开了但菜单没出现""页面注册了但禁不掉"这类幽灵状态）。
   *
   * 顺序固定：先面板对账（关掉并销毁已失效视图），再表面同步（内部会重建原生菜单）。
   * 反过来会先重建一次不含新面板项的菜单，白跑一轮。
   *
   * @returns {{pages:number,bangs:boolean,menus:boolean}|null}
   */
  const refreshPluginSurfaces = () => {
    try { reconcilePanelsAcrossWindows() } catch (_) {}
    if (!pluginSurfaces) return null
    try {
      return pluginSurfaces.syncSurfaces()
    } catch (e) {
      console.warn('[main] sync plugin surfaces failed:', errorMessage(e))
      return null
    }
  }

  const { settingsRegistry } = require('./settings')
  /**
   * 插件中心「启停」端口（registerCoreIpc 装配后回填）。
   *
   * 为什么用回填而不是在这里另写一套启停：启停牵涉依赖级联、落盘、面板对账、
   * 贡献面刷新 —— 那些规则只能有一份（在 ipc/plugins.js 的 setPluginEnabled 里）。
   * AI 工具与插件中心页面走同一条实现，才不会出现「页面能关、AI 关不掉」。
   */
  let pluginHostPort: PluginHostPort | null = null
  /**
   * AI 工作室端口（registerCoreIpc 装配后回填）。
   *
   * 与 `pluginHostPort` 同一套理由：AI 产出的插件必须走**界面安装/卸载的同一条实现**
   * （体检、撞名、级联停用、持久化清理、主题/贡献面刷新）。这里只持有一个转发壳，
   * 真正的规则在 `ipc/plugins.js` 里 —— 绝不为"AI 安装"另写一份。
   */
  let studioPort: StudioPort | null = null
  // 域服务懒解析出口：插件每次调用能力时取当前实例（profile 热切换会重建
  // extensionService 闭包保证拿到的是最新引用。tabManager 作为
  // session 域的标签端口（tabPort）一并暴露。
  const getDomainServices = () => ({
    bookmarkService,
    notesService,
    totpService,
    // PWA 域：域服务 + 编排端口。插件（pwa-service）只经这里取实例，
    // 所以「插件被禁用 → 能力被拦」与「域服务是谁」彻底解耦。
    pwaService,
    pwaDetector,
    pwaInstaller,
    pwaShortcuts,
    pwaRuntime,
    pwaUpdater,
    pwaUninstaller,
    bookmarkBackup,
    profileService,
    // 空间域：与 profileService 同构地暴露，供 space-service 插件解析。
    // 此前 space:* 没有任何插件声明 → 引擎开关对它无效（§10.4 的"能力归属缺口"）
    spaceService,
    historyService,
    downloadService,
    // 下载控制器（暂停 / 恢复 / 取消 / 重试的真正执行者）：与 IPC 侧同口径，
    // 传 getter —— profile 切换会重新注册，域服务实例本身只改数据库状态。
    getDownloadController: () => downloadController,
    extensionService,
    passwordService,
    permissionService,
    searchService,
    sessionService,
    // 命名会话（会话管理页 / 总览面板共用）：AI 的会话工具走同一个实例
    namedSessions,
    settingsService,
    settingsRegistry,
    keybindings,
    // 本地化：插件可通过域服务端口取 `t(key, vars)`，与自己贡献的语言包（
    // `l10n.bundle-provider`）配套使用。
    l10nService,
    // 插件调用按「发起窗口」解析标签条（同 IPC 侧口径）
    tabManager: scopedTabManager,
    // 当前 profile：空间 / 权限这类域服务方法仍按 profile 参数定位，
    // AI 工具与 IPC 路由用同一个真源，避免各写一套"当前是谁"。
    getProfileId: currentProfileId,
    externalGamesCatalog: externalGames && externalGames.catalog,

    // ── 内部页的数据面（AI 工具与页面共用同一批实例）─────────────────────
    // Cookie / 站点存储：当前 profile 的 session 是唯一真源（cookies / browsing-data 页）
    getSession: () => getCurrentSession(),
    // Cookie 明细（列 / 单删 / 全清）：与 cookies 页走同一个端口实现
    cookies: createCookiePort(() => getCurrentSession()),
    // 「立即清除浏览数据」：与浏览数据页走**同一份**类型规则与失败隔离
    clearBrowsingData: (req: UnknownRecord) => clearBrowsingData(
      { getSession: () => getCurrentSession(), historyService, downloadService },
      req
    ),
    // 主题：目录 + 切换 + 发布（themes 页）
    themeService,
    themeRuntime,
    // 表单填充保管库：list 只回掩码摘要（formfill 页）
    formFillVault,
    // 自动化（命令链 + 手势，automation 页）
    automation: automationController,
    // 插件中心：清单与启停（plugins 页）—— 启停在 registerCoreIpc 就绪后回填
    pluginHost: {
      list: () => (pluginRegistry && typeof pluginRegistry.describe === 'function' ? pluginRegistry.describe() : []),
      setEnabled: (id: string, enabled: boolean, cascade?: boolean) => {
        if (!pluginHostPort) return { ok: false, id, enabled: false, reason: '插件注册中心尚未就绪，请稍后重试' }
        return pluginHostPort.setEnabled({ id, enabled, cascade })
      }
    },
    /**
     * AI 工作室：让助手把生成的插件 / 主题 / 用户脚本**装进浏览器**。
     *
     * 只暴露三个动作 + 一个目录路径，全部转发到 `ipc/plugins.js` 的唯一实现：
     *   · `install(target, opts)` —— 与「从文件夹安装」同一条链路（含 afterInstallHook）
     *   · `uninstall(id)`        —— 与「插件中心卸载」同一套级联与清理
     *   · `installUserscript`    —— 与「导入用户脚本」同一套体检
     * `userDir()` 是暂存目录的落点：安装器只认父目录 === 用户插件目录、
     * 且名字以 `.install-` 开头的暂存目录（见 plugin-installer 的守卫）。
     *
     * 端口未就绪时返回明确的失败原因，而不是静默成功 —— AI 会据此重试或告知用户。
     */
    studio: {
      userDir: () => userPluginDir,
      install: (target: unknown, opts?: unknown) => {
        if (!studioPort) return { ok: false, reason: '插件安装通道尚未就绪，请稍后重试' }
        return studioPort.install(target, opts)
      },
      uninstall: (id: string) => {
        if (!studioPort) return { ok: false, id, reason: '插件安装通道尚未就绪，请稍后重试' }
        return studioPort.uninstall(id)
      },
      installUserscript: (req: unknown) => {
        if (!studioPort) return { ok: false, reason: '插件安装通道尚未就绪，请稍后重试' }
        return studioPort.installUserscript(req)
      }
    },
    // 崩溃报告 / 证书错误（crash-report / certificates 页）：数据只在主进程存在过
    getCrashReports: preboot.getCrashReports,
    getCertificateErrors: preboot.getCertificateErrors,
    // 任务管理器：与任务管理器页**同一套**归一化（内存口径走 privateMemoryKB）
    getAppMetrics: () => collectAppMetrics({
      getAppMetrics: () => app.getAppMetrics(),
      tabManager: scopedTabManager,
      webContentsManager
    }).metrics,
    // 配置档案切换（profiles 页）
    switchProfile: (id: string) => switchProfile(id)
  })
  const searchService = perProfileServices((pid: string) => createSearchService(db, {
    historyService,
    bookmarkService,
    tabManager,
    profileId: pid
  }))
  settingsActions.register(SETTINGS_ACTION_ROUTES.clearSearchHistory, async () => {
    try {
      const cleared = Number(await searchService.clearSearchHistory()) || 0
      return { ok: true, message: cleared > 0 ? `已清除 ${cleared} 条搜索历史` : '没有可清除的搜索历史' }
    } catch (e) {
      return { ok: false, error: errorMessage(e) || '清除失败' }
    }
  })

  function switchToIndex(idx: number) {
    const tm = targetTabs()
    const tabs = tm.list()
    if (tabs.length === 0) return
    const target = idx < 0 ? tabs[tabs.length - 1] : tabs[Math.min(idx, tabs.length - 1)]
    if (target) tm.switchTo(target.tabId)
  }

  // （每个标签 webContents 的快捷键注册已随窗口一起收口到装配器 mount()）

  // ── 动态切换 Profile（无需重启应用，对齐 RT loadedProfilesController） ──
  /**
   * 保证目标空间**有内容**：先把该空间上次的会话恢复回来，恢复不到再补一个「新标签页」。
   *
   * ── 为什么需要 ──────────────────────────────────────────────
   * 其它空间的标签是**保留在内存里**的（切空间只换可见投影，见 `setCurrentSpace`），
   * 所以同一轮运行里「切回去」通常原样还在。但目标空间确实可能一个标签都没有：
   * 从没打开过、或**重启后**它的会话分片还没被恢复（启动只恢复主窗口的当前空间与
   * 各自的窗口分片，见 `restoreSecondaryWindows`）。那时 `setCurrentSpace` 会收起
   * 视图，用户面对一片空白，且没有任何入口去开新标签（除非自己知道 Ctrl+T）。
   *
   * ── 与「启动时打开 = 恢复上次会话」的关系 ─────────────────────
   * 该设置项就是「**要不要从磁盘复活标签会话**」的总闸，本函数与启动路径用同一个判据：
   *   · `last_session` → 按空间恢复上次的标签（与启动语义完全一致）；
   *   · 其余（默认「空白页」）→ 不复活旧标签，只给一个干净的新标签页，
   *     免得用户明明选了空白页却被凭空冒出来的一堆旧标签糊住。
   *
   * ── 为什么必须先判 `list().length === 0` ─────────────────────
   * 空间里只要有活标签（哪怕都在休眠）就**绝不能**恢复：否则会把磁盘上那份重复
   * 灌一遍，同一个空间里出现两套标签。而「切走时刚保存过 → 切回来按需恢复」这一对
   * 操作本身是自洽的（切走存的是该空间当时的真实状态）。
   *
   * 为什么不写进 `TabManager.setCurrentSpace`：开窗路径（browser-window-assembly）
   * 在 `setCurrentSpace` 之后紧接着创建首个标签或恢复整份会话，写在那里会让新窗口
   * 凭空多出一个标签、或把恢复出来的标签挤在空白页后面。
   *
   * @param {object} rt 窗口运行单元
   * @param {{profileId:string, id:string}} space 目标空间
   */
  console.log('[main] init timing: before registerCoreIpc took', Date.now() - _t0, 'ms')
  // 书签自动备份特性模块（FilePort 注入，变更防抖 + 时间戳备份对 + 保留策略）
  const bookmarkBackup = createBookmarkBackupFeature({
    bookmarkService,
    filePort: createFilePort(),
    backupRoot: path.join(app.getPath('userData'), 'backups', 'bookmarks')
  })
  bookmarkBackup.start()
  // 会话目录随「profile × 空间」走：空间切换 = 换一整套标签会话
  /**
   * 「当前 profile 的会话」—— 站点数据 / 浏览数据 / Cookie 这些按 profile 隔离的
   * 功能必须用它，而**不能**直接捕获 `extensionService.session`：那个字段在
   * profile 热切换时会被整体替换，任何持有旧值的闭包都会拿到**上一个用户**的会话
   * （表现为「清 Cookie 清到别人头上」）。这里每次调用按当前 profile 现取，
   * 与数据域的 profile 作用域同一口径（见 currentProfileId）。
   */
  const getCurrentSession = () => sessionsController.get(currentProfileId())

  /**
   * 集锦图片资产服务（P2）。
   *
   * 两个端口都是**延迟解析**的闭包（不是值快照）：
   *   · `getProfileId` —— 写资产时才知道该落进哪个 profile 的目录；
   *   · `getSession`   —— 抓图要带"当前标签那一份"的 cookie，切 profile 后必须换成新会话
   *     （与上一条注释同一理由：持有旧会话值的闭包会抓到上一个用户的登录态）。
   * `profileDirOf` 复用 resolveProfileDir —— 资产目录口径只有一处（见那里注释）。
   */
  const notesAssets = createNotesAssets({
    profileDirOf: resolveProfileDir,
    getProfileId: currentProfileId,
    getSession: getCurrentSession
  })

  // 回填给窗口装配层：页面右键的四个「…到集锦…」内置项在 click 时读 `shared.notesService`
  // / `shared.notesAssets`。这两个服务都晚于 `createBrowserWindowAssembly`（窗口创建早得多）
  // 才建好，故必须在**此处**回填 —— 与 `windowShared.emit` / `snapshotService` 同一口径。
  // （此前 `notesService` 从未回填，导致「添加此页到集锦…」这一项其实永远不出现。）
  windowShared.notesService = notesService
  windowShared.notesAssets = notesAssets
  // 页面右键的「…到集锦…」四项还要求 notes 功能面可用（引擎 + 面板插件都开着）：
  // 只判 `notesService` 存在是不够的 —— 服务对象在插件被禁用后仍然在，能力却会失败。
  // 用函数（不是值快照）传进去，右键菜单每次弹出都能拿到最新判据。
  windowShared.isFeatureOn = isFeatureOn

  /**
   * 会话目录随「profile × 空间」走，且必须按**发起窗口**解析。
   *
   * 以前这里读的是全局 activeSpace：会话管理页从窗口 B（或其另一个空间）打开时，
   * 会读到/写到**主窗口空间**的会话文件 —— 明明是 B 的标签，却写进 A 的空间目录。
   * 用 runtimeRegistry 解析出发起窗口，dir 与上面那个 scoped tabManager 才对得上。
   * 解析不到窗口（子窗口 / 启动期）时回落主窗口，与其它按窗口口径一致。
   */
  const getSessionDir = () => {
    const rt = runtimeRegistry.currentOrNull() || primaryWindow
    const spot = runtimeCurrentSpace(rt)
    return sessionDirFor(spot.profileId, spot.spaceId)
  }
  // 当前窗口正在使用的空间（渲染层 space:get-using 读它，对齐 RT window.currentSpaceId）。
  // 多窗口：走 IPC 发送方解析出的运行单元，而不是全局 activeSpace ——
  // 否则 B 窗口的切换器会显示 A 窗口的空间。
  const getUsingSpace = (runtime?: BrowserWindowRuntime | null) => {
    // ⚠ currentOrNull()：current() 的「解析不到 → 主窗口」兜底会让 B 窗口的
    // 切换器显示 A 窗口的空间（本来正是这条注释要防的事，但兜底把它漏掉了）。
    const rt = (runtime && runtime.spaceRuntime ? runtime : null) || runtimeRegistry.currentOrNull() || primaryWindow
    const cur = rt && rt.spaceRuntime ? rt.spaceRuntime.getCurrent() : null
    if (!cur || !cur.spaceId) return null
    return spaceService.get(cur.profileId, cur.spaceId)
  }

  /**
   * 插件注册中心句柄 —— 见文件顶层的模块级声明。
   *
   * 为什么是「先声明、后赋值」：插件是**后台启动**的（见下方 bootstrapPluginModule），
   * 而 registerCoreIpc 必须更早装好路由。用 getter 端口而不是直接传实例 ——
   * 首次 plugins:list 很可能早于 enableAppPlugins 完成，此时给 null，
   * 注册器返回空清单；插件就绪后由 plugins:changed 广播驱动 UI 补齐。
   * ⚠ 声明必须在顶层，不能挪回这里：应用菜单 install 早于本行执行。
   */

  /**
   * 插件**进程级隔离**端口句柄（见 module-bootstrap#bootstrapPluginModule）。
   *
   * 退出时必须显式收尾：被隔离的插件各自跑在一个 utilityProcess 里，
   * 不 kill 就会在主进程退出后成为孤儿进程（占着 userData 下的文件句柄，
   * 下次启动又与新实例抢锁 —— 与 CONTRACT-18 那个"无窗口僵尸"同源的坑）。
   */
  let pluginIsolation: CallablePort | null = null
  let pluginModules: { stopAll(): Promise<void> } | null = null

  /**
   * 插件安装器（社区市场的**落盘那一半**）。
   *
   * 它刻意只碰文件系统（体检 / 复制 / 解压 / 卸载），不认识 Electron、也不认识注册中心 ——
   * 于是它可被单独测试（`pnpm verify:plugin-install`），"装完起不来"这类问题
   * 不必等到整机跑起来才暴露。粘合（装完 `discover()` + `enable()`）在 `ipc/plugins.js`。
   *
   * 三个路径都是**唯一事实源**：
   *   · `userPluginDir` 与插件发现、`hira-plugin://` 协议、注册中心的 `pluginUserDir`
   *     用的是同一个值（见上面它的说明）；
   *   · 内置插件目录从 `appRoot` 推导（与 plugin-bootstrap 一致），用来挡"装一个同名插件
   *     顶掉内置插件"这条提权路径；
   *   · 公钥分**三级**存放（`official` 随应用分发 / `community` 用户导入 / `local` 自建）：
   *     目录即事实，不用清单文件 —— 清单与文件一旦不同步，"这把钥匙到底算不算数"
   *     就变成了要看两份数据才能回答的问题。`officialTrustDir` 指到 resources 下，
   *     随安装包分发、且**运行时不可写不可移除**（"官方签名"的含义就是这个）。
   */
  const pluginInstaller = createPluginInstaller({
    userPluginDir,
    builtinPluginIds: () => readBuiltinPluginIds(path.join(appRoot, 'build', 'plugins')),
    trustDir: path.join(app.getPath('userData'), 'plugin-trust'),
    officialTrustDir: path.join(appRoot, 'resources', 'plugin-trust'),
    log: (msg: string, err?: unknown) => console.log(msg, err || '')
  })

  /**
   * 插件源（社区市场的**索引那一半**）—— 把"有哪些插件、最新版本、包在哪"接进来。
   *
   * 源是**一个列表**（顺序即优先级）：多配几个源时，谁在前谁的条目先出现；
   * 同一个 id 出现在多个源里，只取排在前面的那个（并在结果里报 `duplicates`
   * 让界面提示"有撞车"），而不是让两个源的版本互相覆盖。
   *
   * `getLocalVersions` 从**注册中心**现取（不是从磁盘再扫一遍）：
   * "本地是什么版本"这个问题只有一个答案来源，两份实现必然漂移 ——
   * 而漂移的表现是"明明装了却说没装 / 明明是最新却一直提示更新"，极难自查。
   * 注册中心还没就绪时返回空表 → 全部显示为"未安装"，那是一个**可解释**的中间态。
   */
  const pluginMarket = createPluginMarket({
    installer: pluginInstaller,
    getSources: () => pluginStateStore.loadMarketSources(),
    // 端口必须**回传**归一化结果（去重 / 去空 / 截断由存储层负责）：
    // 不返回的话调用方无从知道"我提交的这份到底存成了什么"，界面只能假装成功。
    setSources: (list: string[]) => pluginStateStore.saveMarketSources(list),
    getLocalVersions: () => {
      const out: Record<string, string> = {}
      if (!pluginRegistry || typeof pluginRegistry.describe !== 'function') return out
      for (const p of pluginRegistry.describe()) {
        if (p && p.runtime && p.id) out[p.id] = String(p.version || '')
      }
      return out
    },
    log: (msg: string) => console.log(msg)
  })

  /**
   * 插件键值存储（开放 API 的持久化面）。
   *
   * `db` 本身是**按当前 profile 路由**的代理，所以这里不需要认识 profile 模型；
   * 主键 `(profile_id, plugin_id, key)` 由 plugin-storage 内部补全。
   * 配额（512 键 / 256 KiB 单值 / 4 MiB 总量）与键名校验也在那一层 —— 这里只建实例。
   */
  const pluginStorage = createPluginStorage({ sqlite: dbProvider.sqlite, getProfileId: currentProfileId })

  /**
   * 卸载收尾：清掉这个 id 的三份持久化痕迹。
   *
   * 少了它，同一个 id 被**重新安装**时会立刻沿用上一次的禁用 / 自动停用 / 授权结果 ——
   * 用户刚装好一个插件，它却是关着的（甚至带着上次的授权），而界面上找不到原因。
   * 三份键的读写细节全在 plugin-state-store.js，这里只负责"什么时候清"。
   */
  function onPluginUninstalled(id: string) {
    pluginStateStore.setDisabled(id, false)
    pluginStateStore.setAutoDisabled(id, false)
    pluginStateStore.setGrantedPermissions(id, [])
    // 存储数据与上面三份痕迹同一条原则：卸载即清空。留着的话，重装同名插件
    // 会直接读到上一位用户的键值（可能含令牌 / 草稿），而新插件的作者根本不知道有这份数据。
    try { pluginStorage.clear(id) } catch (_) {}
    // 卸载一个主题插件后，它的主题必须立刻从目录消失（当前若正用着它会回落内置）。
    refreshThemeSources()
  }

  /**
   * 扫码浮框端口（「扫码器」插件的可拖动取景框）—— 见 ipc/screen.js 的说明。
   *
   * **窗口这件事由核心给，而不是插件自己建**：窗口类型表 / 单例注册表 / 父窗口解析
   * 都是核心的设施。插件只提供抓屏能力；让它自己去 new BrowserWindow 会让"窗口"
   * 出现两套口径（两处各有各的置顶/单例/销毁语义）。
   */
  const qrScanFrame = createQrScanFrameController({
    windowRegistry,
    windowType: WINDOW_TYPES.QR_SCAN_FRAME,
    openSubWindow: (type: string, payload?: UnknownRecord, parent?: BrowserWindowRuntime | null) => openSubWindowByType(type, payload, parent),
    getParentRuntime: () => targetWindow(),
    cropRect: qrScanCropRect,
    getScreen: () => require('electron').screen,
    barHeight: QR_SCAN_BAR,
    settleMs: QR_SCAN_SETTLE_MS,
    captureArmMs: QR_SCAN_CAPTURE_ARM_MS
  })

  /**
   * 插件启停 / 装卸后刷新主题目录 —— 插件化主题的**唯一同步点**。
   *
   * 覆盖三件在插件形态达成、靠机制自然成立的事实，不必在主题层各写一条规则：
   *   · 启用一个 `theme-plugin` → 它的 `contributes.themes` 进入目录（可用）；
   *   · 禁用它 → 注册中心 `clearPlugin` 摘掉贡献 → 目录里不再有它（换肤立刻失效）；
   *   · 卸载它 → 同上，且 `getActiveTheme()` 对失效 id 自动回落内置主题。
   *
   * 刷新后 `publish()` 自带令牌指纹去重：若当前主题未受影响则即时返回、零重绘。
   */
  const refreshThemeSources = () => {
    themeService.refreshSources()
      .then(() => themeRuntime.publish())
      .catch((e: unknown) => console.warn('[theme] 插件主题刷新失败（非致命）：', errorMessage(e)))
  }

  const {
    stopExtensionRelay,
    notifyPluginsChanged,
    emitPanelSideChanged,
    attachIdentitySession,
    detachIdentitySession,
    setPluginEnabled,
    installFromPath,
    uninstallPlugin,
    installUserscript
  } = await registerCoreIpc({
    ipcMain,
    // 面板目录端口（不是常量快照）：面板集合随插件启停变化，必须按调用时刻现取
    getPanelCatalog: () => panelCatalog,
    // 面板换宿主（panel:transfer / panel:transfer-state）的裁决者 —— 与 kernel 同一实例
    panelPresentation,
    // 主题域三件套（目录与状态 / 发布出口 / token 引擎）：
    // IPC 层只做「转调 + 校验」，不认识主题的任何规则 —— 规则在 theme-service。
    themeService,
    themeRuntime,
    themeManager,
    // 调度器：改了调度配置后要立刻重判一次，不让用户等下一个 tick。
    themeScheduler,
    // 主题包资产（导出带图 / 背景图 URL）—— 见 themePluginAssets 的说明。
    themePluginAssets,
    // 用户主题的图片资产库：编辑器"选择图片"拷进来、导出时读出去
    themeAssets,
    // 插件可贡献的 bang（contributes.bangs + `search.bang-provider` 插槽）：
    // 随 `search:config` 一起下发给地址栏，与用户自定义 bang 走同一条数据流。
    getPluginBangs: () => (pluginSurfaces ? pluginSurfaces.listBangsAsync() : Promise.resolve([])),
    // 插件启停后 → 各窗口对账（关掉并销毁已失效的面板视图）+ 页面/bang/菜单表面同步
    onPanelCatalogChanged: refreshPluginSurfaces,
    // 菜单类插槽：ui:popup-menu 里 context.kind='bookmark' 时由主进程追加插件项。
    // 同一处合并**声明式**菜单贡献（contributes.menus）—— 右键菜单因此只有一条装配路径。
    onMenuSlotItems: (slotId: string, payload: UnknownRecord, kind?: string) => {
      const items = slotMenu.items(slotId, payload)
      if (!kind || !pluginSurfaces) return items
      const extra = pluginSurfaces.contextMenuItems(kind, payload || {})
      return extra.length ? items.concat(extra) : items
    },
    // 渲染侧插槽宿主（slots:render / slots:dispatch）：白名单只放 side-panel.*
    slotRenderer,
    // 扩展点调度器：IPC 层的域宿主（search.suggestion-provider / history.search-filter…）
    // 靠它把插槽接进真实数据流 —— 见 ipc-routes.js 里的 slotCaller 说明。
    extensionPoints,
    // 贡献注册表：声明侧数据（`contributes.*`）的读取口。书签导入格式清单从它取。
    contributions,
    // 第三方插件的权限授权结果落盘（PART7 §7.5）。空数组 = 撤销授权。
    onPluginPermissionsChanged: (id: string, scopes: string[]) => {
      pluginStateStore.setGrantedPermissions(id, scopes)
    },
    // 插件开关落盘（只写"用户主动禁用"；启用失败不落盘 → 下次启动自动重试）
    onPluginDisabled: (id: string, disabled: boolean) => {
      pluginStateStore.setDisabled(id, disabled)
      // 用户重新启用 = 对"连环出错被自动停用"的**一键恢复**。
      // 第 4 态只能这样解除 —— 系统停的，但必须由用户能重新打开（见 §8.1）。
      if (!disabled) pluginStateStore.setAutoDisabled(id, false)
      // §10.4 的收尾：关掉权限引擎后，那些"正在等用户回答"的请求再也没人能回答
      // （回答它的 capability 已被 blocked）→ 立刻拒绝，别让网页一直卡着。
      if (disabled) closeOutPendingPermissionRequests()
      // PART18：能力门面的运行期残留（AI 工具、事件订阅、浮层）必须随插件一起摘掉。
      // 不摘的后果是"插件已禁用、它的浮层还开着 / 还占着 ai.tool 一个名额"。
      if (disabled) {
        try { pluginCapabilities.disposePlugin(id) } catch (_) {}
        try { pluginOverlayHost.disposePlugin(id) } catch (_) {}
      }
      // 主题目录随插件启停同步（禁用主题插件 = 其主题立刻从目录消失）
      refreshThemeSources()
      // 译文缓存可能带有刚被禁用插件的后处理结果，下一次翻译必须重新走管线。
      try { translateService.clearCache() } catch (_) {}
      // 贡献面（面板 / 内部页 / bang / 菜单）同样随启停同步 —— 与主题走同一时机。
      refreshPluginSurfaces()
      // 应用菜单的入口门禁（§10.4）：引擎被关掉 → 依赖它的菜单项必须立刻消失。
      // 状态签名里已含 features，这里只是把"重建"这个动作触发出来。
      try { appMenu.refresh() } catch (_) {}
    },
    // 插件启用成功 → 补跑它贡献的 schema 迁移（`db.schema.migration`）。
    // 幂等（记账表兜底），所以"全量重跑"就是正确且最简单的实现 ——
    // 不必去算"这次刚上线的那个插件贡献了哪几条迁移"。
    // 同时丢弃已合并的语言包缓存（`l10n.bundle-provider`），让新插件的译文下次查表即生效。
    onPluginsActivated: () => {
      runPluginMigrations()
      l10nService.reload()
      // 新启用的翻译插件可能带新语言检测、DOM 规则或术语表，旧译文不可继续复用。
      try { translateService.clearCache() } catch (_) {}
      refreshThemeSources()
      // 新启用的插件带来的内部页 / bang / 菜单必须立刻可见（不等下次重启）。
      refreshPluginSurfaces()
      // 反向同理：引擎重新启用 → 之前被藏掉的菜单入口必须回来。
      try { appMenu.refresh() } catch (_) {}
    },
    // 「打开插件目录」入口要用它（与插件发现用的是同一个路径，见上面 userPluginDir 的说明）
    getUserPluginDir: () => userPluginDir,
    // 安装 / 卸载（社区市场）：安装器只碰文件，装完由 ipc/plugins.js 负责 discover + enable。
    pluginInstaller,
    // 用户脚本：清单 / 单脚本启停（`plugins:list-userscripts` / `plugins:set-userscript-enabled`）
    // 与 `GM_xmlhttpRequest` 代理（`userscript:gm-request`）。三者共用一个运行时实例。
    getPluginSurfaces: () => pluginSurfaces,
    setUserScriptDisabled: (key: string, disabled: boolean) => pluginStateStore.setUserScriptDisabled(key, disabled),
    userscriptRuntime: userScriptRuntime,
    // 插件源（社区市场）：拉索引 / 下载 / 校验和；"装完 discover + enable" 是同一条收尾。
    pluginMarket,
    // 插件键值存储（面板 open API 的持久化面）：ipc/plugins.js 的五条路由直接转调它。
    pluginStorage,
    // 插件浮层的窗口仲裁者（PART18）：渲染侧点关闭 → 主进程按**发送方窗口**摘记录并发 hide。
    pluginOverlayHost,
    onPluginUninstalled,
    layoutCoordinator,
    layoutService,
    tabManager,
    providerRegistry,
    bookmarkService,
    notesService,
    // 集锦图片资产基础设施（P2）：ipc/notes.js 的四条资产路由直接转调它。
    notesAssets,
    // 集锦「打开视图」补发口：面板挂载后主动拉取上一次 open-view 意图（取完即清）。
    // pending 槽住在 note-actions（与写入它的 revealInPanel 同一处），这里只按窗口转调。
    takeNoteOpenView: (windowId: number) => noteActions.takePendingView(windowId),
    totpService,
    // PWA（把站点安装为应用）：探测 / 安装 / 快捷方式 / 应用窗口 / 更新 / 卸载。
    // 端口为 null 时对应路由不注册（见 ipc/pwa.js），不会出现「点了没反应」的假成功。
    pwaService,
    pwaDetector,
    pwaInstaller,
    pwaShortcuts,
    pwaRuntime,
    pwaUpdater,
    pwaUninstaller,
    // 图标 URL 的唯一真源 + 当前 profile：管理页图标由主进程补进 `iconUrl`。
    pwaPaths,
    getProfileId: currentProfileId,
    historyService,
    // 浏览器一键迁移：OOBE 导入屏 / 导入数据页两条入口共用同一个服务实例。
    browserImport,
    downloadService,
    // 下载控制器：传 getter 而不是对象值 —— profile 切换会重新注册它（见
    // `downloadController = registerDownloadHandler(...)`），IPC 路由必须按调用
    // 时刻取当前引用，否则图标 / 暂停 / 取消 / 重试会打到已销毁的旧实例。
    getDownloadController: () => downloadController,
    // 扩展服务：传 getter 而不是对象值 —— profile 切换会重建它（见上面几处
    // `extensionService = await getOrCreateExtensionService(...)`），IPC 路由必须
    // 按调用时刻取当前引用，否则扩展列表 / 图标 / 弹窗 / 设置会打到旧服务。
    extensionService: extensionServiceForProfile,
    // identity 桥的两个归属端口：发送方只带 session，这里按会话反查扩展服务，
    // 查不到就拒绝 —— 绝不让 A profile 的扩展页借到 B profile 的 token。
    resolveExtensionServiceBySession: findExtensionServiceBySession,
    // 注册时给**已经加载**的 profile 补挂 MV3 worker 通道（之后新建的走
    // getOrCreateExtensionService 里的 attachIdentitySessionRef）。
    listExtensionServices: listLoadedExtensionServices,
    emit,
    // 窗口级事件出口（space:window-changed 等「只属于某个窗口」的推送）
    emitToWindow,
    passwordService,
    permissionService,
    // 权限 pending 列表的归属过滤（补 windowId/tabId + 按当前窗口收敛），
    // 让每个窗口的 navbar/标签只呈现自己的请求。
    permissionPendingFilter,
    searchService,
    // 即时答案（F-0771~F-0773）：出网/解析/缓存在主进程（见 main/instant-answer.js）。
    instantAnswerService,
    settingsService,
    // 自动化（D2 命令链 + D3 手势）控制器：在 bootstrapCoreModules 之后建好（见下）。
    automation: automationController,
    // 网页翻译（C3）引擎：插件插槽 + 在线来源故障切换（见 main/translate.ts）。
    translateService,
    // Break Mode（D5）状态机：遮罩按钮回传的落点（见 main/break-mode.js）。
    breakMode: breakModeRef,
    profileService,
    spaceService,
    sessionService,
    // 「上次关闭」归档（只读副本，启动时生成一次）
    lastClosedSessionService,
    // 配置档案归档（G1/G2 的动作路由转调它）
    profileArchive,
    settingsActions,
    // 空间归档（导出 / 导入的动作路由转调它）
    spaceArchive,
    // 分享 / 二维码（N15）
    shareService,
    // 命名会话（N14）
    namedSessions,
    // 支付卡 / 地址保管库（N7）
    formFillVault,
    getSessionDir,
    keybindings,
    switchProfile,
    onProfileRemoved: disposeProfileRuntime,
    switchSpace,
    getUsingSpace,
    destroySpaceTabs: (profileId: string, spaceId: string) => tabManager.destroySpaceTabs(profileId, spaceId),
    externalGames,
    bookmarkBackup,
    openSubWindowByType,
    passkeys,
    captureHub,
    pageLibrary,
    // OOBE 首次启动引导：状态 / 完成 / 重置三条路由转给控制器
    // （控制器缺席时注册器自身安全跳过）。
    onboarding,
    // 扫码浮框（可拖动取景框）的开 / 关 / 当前矩形 —— 抓帧据此裁剪，见 ipc/screen.js
    qrScanFrame,
    // 标签截图服务独立 IPC 域，与 layout / tabs 零耦合。
    snapshotService,
    // 打印作业服务：走 hira://print-pdf/<jobId> 直吐 PDF，IPC 只传元数据
    printService,
    // 文件拖入窗口：preload 上报 → 本窗口新标签 / 系统默认（见 main/file-open/）
    fileOpenService,
    // 站点数据 / 浏览数据 / 进程指标 / 页面信息四条域的共同端口
    getSession: getCurrentSession,
    webContentsManager,
    getAppMetrics: () => app.getAppMetrics(),
    // 关于页 / 更新页所需的应用事实（版本、运行时、平台、用户数据目录）。
    // 渲染层从 UA 只能反推出 Chromium/Electron，推不出应用自身版本。
    getAppInfo: () => ({
      name: app.getName(),
      version: app.getVersion(),
      electron: process.versions.electron || '',
      chrome: process.versions.chrome || '',
      node: process.versions.node || '',
      v8: process.versions.v8 || '',
      platform: process.platform,
      arch: process.arch,
      osVersion: `${os.type()} ${os.release()} (${os.arch()})`,
      isPackaged: isPackagedRuntime(),
      // 开发态标记（唯一判据）：渲染层据此隐藏一切会写系统的关联入口。
      isDevelopment: isDevRuntime(),
      userDataPath: app.getPath('userData'),
      defaultUserAgent: (() => {
        try { return extensionService.session.getUserAgent() } catch (_) { return '' }
      })()
    }),
    // 软件更新（Update 域）：服务在 post-ipc 阶段创建，故用 getter 晚绑定。
    getUpdateService: () => updateServiceRef,
    // 外部协议授权记录（open-external 域）：列出 / 撤销。记录本体在 openExternalPermissions。
    openExternalPermissions,
    // 崩溃报告 / 证书错误（Security 域）：实现随 preboot 一起下沉，这里只转发端口
    isCrashReporterEnabled: preboot.isCrashReporterEnabled,
    getCrashReports: preboot.getCrashReports,
    getCertificateErrors: preboot.getCertificateErrors,
    // 空间增删改后重建原生菜单（「空间」子菜单的列表与勾选态都会变）
    onSpacesChanged: () => {
      try { appMenu.refresh() } catch (_) {}
    },
    // HTTP Basic / 代理认证弹窗的三条消息（ready / submit / cancel）
    httpAuth: httpAuthManager,
    // 新建浏览器窗口（window:new / window:new-incognito 两条通道）
    openBrowserWindow,
    // 多窗口：窗口清单 + 标签跨窗口迁移
    listBrowserWindows,
    moveTabToWindow,
    // 窗口运行单元注册表：让 40 个 registrar 按 IPC 发送方解析到对应窗口
    runtimeRegistry,
    // 插件中心端口：拿「迟到的」插件注册中心（见上方 pluginRegistry 声明）
    getPluginRegistry: () => pluginRegistry
  })
  // 插件启停回填：AI 工具的 plugin_toggle 与插件中心页面走**同一条实现**
  // （依赖级联 / 落盘 / 面板对账 / 贡献面刷新都在 ipc/plugins.js 里）。
  pluginHostPort = typeof setPluginEnabled === 'function' ? { setEnabled: setPluginEnabled } : null
  // AI 工作室回填：生成产物 → 安装 / 卸载 / 用户脚本，全部落到与界面同一条链路。
  studioPort = (typeof installFromPath === 'function' && typeof uninstallPlugin === 'function')
    ? { install: installFromPath, uninstall: uninstallPlugin, installUserscript }
    : null
  console.log('[main] init timing: registerCoreIpc took', Date.now() - _t0, 'ms')
  extensionRelayRef = stopExtensionRelay
  // 晚绑定回填：此后 profile 切换新建的扩展服务会把会话交给 identity 桥挂 worker 通道。
  attachIdentitySessionRef = typeof attachIdentitySession === 'function' ? attachIdentitySession : null
  detachIdentitySessionRef = typeof detachIdentitySession === 'function' ? detachIdentitySession : null
  // 回填装配器：窗口的 LayoutCoordinator 在「面板换到另一侧」时会**延迟解析**这个口
  // （窗口创建得比这里早，按值注入只会捕获到 null —— 与 windowShared.emit 同一口径）。
  windowShared.emitPanelSideChanged = emitPanelSideChanged

  // ── post-ipc 特性模块（Step 6）：settings.sync + tabs.auto-sleep ──
  // 以前 settings:set 只写文件就结束了，改了设置没有任何模块知道 → "改设置没效果"。
  // 该模块订阅 domain-settings 的变更通知：主进程侧跑 applier 真正生效，
  // 再把变更广播给所有渲染进程（ui-shell / overlay / 所有标签页）。
  const postIpcModules = await bootstrapPostIpcModules({
    settingsService,
    searchService,
    getSession: getCurrentSession,
    getDownloadController: () => downloadController,
    getExtensionService: extensionServiceForProfile,
    // 保留策略（历史 90 天 / favicon 30 天）按 profile 逐区执行 ——
    // 数据已分区，只清当前用户会让其它用户的分区无界增长。
    historyService,
    faviconService,
    listProfileIds: () => profileService.list().filter((p): p is ProfileRecord => Boolean(p)).map((p) => p.id).filter(Boolean),
    runAsProfile: (profileId: string, fn: () => unknown) => runtimeRegistry.runWithProfile(profileId, fn),
    runAsScope: (profileId: string, spaceId: string, fn: () => unknown) => runtimeRegistry.runWithScope(profileId, spaceId, fn),
    // 定时/全局任务（自动休眠、内存回收、后台节流 applier）必须覆盖**每一个窗口** ——
    // 这些调用不在任何 IPC 上下文里，传 scoped 代理会一律落到主窗口。
    tabManager: tabsFanout,
    // 注：**不注入 win**。post-ipc 阶段的定时任务全是进程级的，收尾统一挂
    // `app.on('window-all-closed')`（见 module-bootstrap 的三处清理点）——
    // 传进来的窗口实例已无消费方，留着只会诱导后人再把它绑成"主窗口关闭即停"。
    emit,
    themeManager,
    // 主题/布局相关的 applier 需要作用于全部窗口的 layoutCoordinator
    getLayoutCoordinator: () => layoutFanout,
    // 跨窗口标签同步的引擎（设置关掉时由 applier 收尾 —— 清占位 + 复位记账）。
    // getter：引擎在前面已建好，但保持与其他端口同构（见 module-bootstrap 的说明）。
    getTabSync: () => tabSync,
    // 主题发布链（`app.theme` 变了通知它重发布；见 settings/appliers/theme.js）
    getThemeRuntime: () => themeRuntime,
    // 网络代理（I4）+ 浏览器标识（UA）：要下发网络策略的会话清单。
    //
    // ⚠ L2（PART16 §5 步骤 5）：这两项设置现在是**按 profile**的，因此清单只能是
    //   「当前 profile 的持久会话 + 无痕会话」—— 给"全部会话"会把 A 的代理/UA 盖到
    //   B 的会话上（正是物理独立要消除的）。切 profile 后由
    //   `afterProfileContextChanged` 强制重放一次，目标 profile 的会话当场拿到自己的配置。
    //   无痕会话没有 profile 归属（临时 partition），跟随当前窗口上下文，故一并下发。
    getSessions: () => [
      sessionsController.get(currentProfileId()),
      ...sessionsController.listIncognitoSessions()
    ],
    onSessionCreated: (fn: (session: Session) => unknown) => { app.on('session-created', (session: Session) => fn(session)) },
    // 浏览器标识（UA）：内置默认 UA 就是启动最早期算出的那一份（唯一真源）。
    // 它同时是**中性全局兜底**（`app.userAgentFallback`）；用户选定的 UA 由 applier
    // 按 profile 下发到各自会话，不再污染全局兜底（见 appliers/user-agent.js）。
    getDefaultUserAgent: () => defaultUserAgent,
    // 浏览器标识（UA）的配套：Accept-Language 用系统首选语言组装（不含 q 值，
    // 由 Chromium 原生补全），与 UA 同批下发到 profile 会话 —— 否则 UA 已经自称
    // 标准 Chrome，语言头却还是 Electron 的单一默认值，属于一眼可辨的不一致。
    getAcceptLanguages: () => buildAcceptLanguages(
      typeof app.getPreferredSystemLanguages === 'function'
        ? app.getPreferredSystemLanguages()
        : [app.getLocale()]
    ),
    // 仅 HTTPS（I2）：导航层升级要覆盖"已存在 + 将来创建"的全部 webContents。
    // 用 getWebContents 取全部（含标签、独立侧栏、浮层等），一处不漏。
    getWebContents: () => webContents.getAllWebContents(),
    onWebContentsCreated: (fn: (webContents: WebContents) => unknown) => { app.on('web-contents-created', (_e: ElectronEvent, wc: WebContents) => fn(wc)) },
    // 事件广播出口（登记制）：设置广播等统一走它，不再各自遍历 webContents
    send: emit
  })
  // 回填晚绑定句柄：切换流程（上方 switchProfile / switchSpaceOnRuntime）要用它
  // 在换 profile 后重跑 applier 并广播"全量设置重读"，见 afterProfileContextChanged。
  profileSpaceCoordinator.setSettingsSync(
    postIpcModules && postIpcModules.settingsSync ? postIpcModules.settingsSync : null
  )
  // 自动更新服务同批回填（IPC 用 getter 读取，见上方 updateServiceRef 的说明）。
  updateServiceRef = postIpcModules && postIpcModules.updateService ? postIpcModules.updateService : null

  // （退出落盘逻辑统一收口到下方 QuitController —— 见「会话自动保存」之后的 register）

  // （标签自动休眠定时器已并入 module-bootstrap 的 tabs.auto-sleep 模块）

  // 统一子窗口打开路由（28 种类型走此入口）。
  // 通道注册已收口到 main/ipc/window.js 的 registerWindowIpc（typedMain.handle，
  // 通道名 ngipc:invoke:window:open），此处不再裸 ipcMain.handle('window:open')——
  // 之前裸通道与渲染层 typed bridge 的通道名不一致，导致 "No handler registered"。
  // openSubWindowByType 已上移到 keybindingActions 之前定义，通过 registerCoreIpc 注入。

  // 分阶段加载：ui-shell 优先（用户立即看到 navbar），rail 后台加载。
  // 这一段（ui-shell / rail / 主题 / 布局 / 快捷键挂载 / js-dialog）已收口到
  // 装配器 mount() —— 后开的窗口走 openAndMount() 时是同一条路径，不会两套实现漂移。
  console.log('[main] loading ui shell...')
  console.log('[main] init timing: before loadUiShell took', Date.now() - _t0, 'ms')
  if (coldPwa) {
    // PWA 冷启动：**不 mount 主窗**（它保持隐藏，不加载 shell、不建标签）。
    // 应用窗自己画标题栏 + 贴网页视图，不依赖主窗的 ui-shell。
    await launchColdPwaWindow()
  } else if (onboarding.needsOnboarding()) {
    // OOBE 优先级最高：引导未完成时**绝不** mount 主窗（否则用户会先看到浏览器、
    // 再被引导窗盖住）。完成时由控制器 mount 主窗并销毁引导窗（见 main/onboarding）。
    await onboarding.open()
  } else {
    await mountMainShell()
    // JumpList 在“应用尚未运行”时无法走 second-instance；这里补上冷启动动作。
    // windowNew 的普通主窗本身已是新窗口，incognito 已在建 primary 时带上，
    // 只有 tabNew 需要在恢复后的窗口里再明确加一个标签。
    if (coldJumpListAction === 'tabNew') {
      try { platformActions.tabNew?.() } catch (e) { console.warn('[platform] cold tab action failed:', errorMessage(e)) }
    }
  }
  console.log('[main] ui shell loaded', coldPwa && pwaOnlyMode ? '(pwa-only)' : '')
  console.log('[main] init timing: loadUiShell took', Date.now() - _t0, 'ms')

  bindBrowserWindowLauncher(async () => {
    if (!mainShellMounted) {
      if (onboarding.needsOnboarding()) {
        onboarding.open()
        return
      }
      if (pwaOnlyMode) {
        pwaOnlyMode = false
        pwaRuntime.setPwaOnlyMode(false)
      }
      await mountMainShell()
      const rt = browserWindows.focused() || primaryWindow
      try { rt.win.show() } catch (_) {}
      try { rt.win.focus() } catch (_) {}
      return
    }
    await openBrowserWindow({ focus: true })
  })

  // ── 插件后台启动（对齐 RT：app.plugins 不阻塞首屏）────────────────
  // 只启动一次（应用级）：插件往进程级 ProviderRegistry 注册 provider，
  // 每个窗口各跑一遍会撞「Duplicate provider id」。
  // 唯一与窗口相关的绑定是 tabs-service 的 ctx.tabManager —— 传「按发送方解析」的
  // 代理（scopedTabManager），插件的每次调用就会落到**发起它的那个窗口**上，
  // 而不是永远作用于主窗口。这与 IPC 侧 40 个 registrar 用的是同一套机制。
  // 仍然是 fire-and-forget：插件目录发现 + enableAll 的 IPC 往返若挡在会话恢复前，
  // 用户看到的是「shell 已出、网页区空白等插件」。
  console.log('[main] enabling plugins (background)...')
  console.log('[main] init timing: before enableAppPlugins took', Date.now() - _t0, 'ms')
  /**
   * 面板数据面：把「每个面板背后的真实数据」收敛成一个读取口。
   * 内置 provider 在 panel-data.js，插件可经 `panel.data.provider` 补充 / 覆盖。
   * AI 的 `panel_read` 与任何未来的日志 / 自动化消费者都走这一个实例。
   */
  const panelData = createPanelData({
    getPanels: () => panelCatalog.list(),
    getDomainServices,
    getLayout: () => targetWindow().layoutCoordinator,
    getPanelPresentation: () => panelPresentation,
    getWindowCount: () => {
      try { return windowRegistry.list().length } catch (_) { return 1 }
    },
    extensionPoints,
    logger: console
  })

  /**
   * **内核端口** —— 第一方插件（`manifest.isFirstParty`）在生命周期钩子里拿到的
   * 「主进程原语」。注册中心按 manifest 决定是否下发（见 PluginRegistryV2#_pluginContext），
   * 第三方插件永远拿不到。
   *
   * 这里只放**必须共享同一实例**的东西：ipcMain、按 profile 路由的库、safeStorage 封装、
   * 广播出口、开窗器、按窗口解析的布局。能用 `require('electron')` 直接取得的原生模块
   * 一律不进 kernel —— 端口越窄，插件越难越界。
   */
  const kernel = {
    ipcMain,
    isTrustedSender: isTrustedIpcSender,
    dbProvider,
    // 按当前 profile 路由的 Proxy：`prepare/exec/pragma` 可直接用（见 infra-db#createDbProvider）
    sqlite: dbProvider.sqlite,
    secretCrypto,
    emit,
    emitToWindow: (windowId: number, route: string, payload?: unknown) => broadcaster.send(route, payload, { windowId }),
    openWindow: openSubWindowByType,
    // 布局/标签管理器都是**按窗口**解析的：插件拿到的是现算函数，不是某一窗口的实例，
    // 否则 detached 窗口里的操作会作用到主窗口（本项目 5 个宿主共存的既有教训）。
    getLayout: () => targetWindow().layoutCoordinator,
    getTabManager: () => scopedTabManager,
    // Agent CLI 的后台页复用当前 profile 的登录态，但不加入可见标签。
    getCurrentSession: () => getCurrentSession(),
    // 面板换宿主（第一方插件用它判定「面板是否已拆成窗口」，见 ai 的 intent 打开器）
    panelPresentation,
    // 感知层：运行日志（app_logs）与面板数据（panel_read / panel_list）
    logHub,
    panelData,
    windowRegistry,
    getFocusedRuntime: () => focusedRuntime(),
    // 浏览器全部菜单动作的唯一执行入口（元数据 + run）。原生菜单 / 插件菜单 / AI
    // 三条通路共用它 —— 插件不得另建一套动作实现（见 main/app-actions.js）。
    appActions,
    // 本地 Agent 的唯一命令出口。工具只传 command + args，不在插件里拼 shell。
    processRunner: createProcessRunner({ defaultTimeoutMs: 120_000, maxBuffer: 8 * 1024 * 1024 }),
    // 插件生态（PART18）：AI 用它们列出 / 执行插件命令、打开插件内部页与浮层。
    // 与插件自身拿到的 browser 门面走**同一批实例**，不存在第二套数据源。
    pluginSurfaces,
    pluginOverlayHost,
    getPluginRegistry: () => pluginRegistry,
    /**
     * 功能面可用性（`feature-map.js` 的**唯一真源**）。
     *
     * 插件贡献的 UI 会随自身禁用被摘除，但**跨插件**的「实现在一个插件、落点在另一个」
     * 关系摘不掉（典型：AI 菜单由 ai-engine 挂、落点是 panel-ai）。这类入口必须由宿主
     * 把同一份判定下发给插件，让它在每次生成菜单 / 建议 / 快捷键时现查 —— 插件自己
     * 去翻 `userDisabled/autoDisabled/blocked` 会立刻多出第二套口径。
     */
    isFeatureOn,
    userDataPath: app.getPath('userData'),
    appRoot
  }
  bootstrapPluginModule({
    appRoot,
    // 运行时安装的第三方插件目录：userData/plugins（用户数据目录，与应用目录分开）。
    // 市场/安装器只需往这里放或删一个子目录 —— 内核不参与"安装"这件事。
    pluginUserDir: userPluginDir,
    win,
    uiShellWebContents,
    webContentsManager,
    layoutCoordinator,
    themeManager,
    tabManager: scopedTabManager,
    providerRegistry,
    // 贡献注册表与面板目录：插件 manifest 的 contributes 灌进前者，后者是它的业务视图。
    // 两者都在 registerCoreIpc 之前建好，所以这里注入的是「同一个实例」，不是副本。
    contributions,
    panelCatalog,
    // 扩展点调度器：官方插槽表已全量声明，插件启用时往同名实例里挂实现
    extensionPoints,
    // 插件开关持久化：启动时先恢复"用户主动禁用"，再 enableAll
    pluginStateStore,
    /**
     * 连环坏触顶（`lifecycle.onCrash`）→ 自动停用的**APPS 侧出口**（第 4 态）。
     *
     * 分工（见 PluginRegistryV2.autoDisable 的说明）：**卸载由 infra 自己排队完成**
     * （它有 provider / 插槽 / 贡献四张表与 `_context`），这里只做 infra 拿不到的两件事 ——
     * **落盘**（storage 在 APPS）与**广播**（IPC 出口在 APPS），外加一步布局对账。
     *
     * 与「用户主动禁用」的唯一差别：**只写 autoDisabled，不写 userDisabled**。
     * 这条边界是第 4 态存在的理由 —— 系统判定停用，但必须允许用户点开关一键恢复；
     * 若误写成 userDisabled，用户将永远无法重新打开它（见 docs-ng §8.1）。
     */
    onPluginAutoDisable: (id: string, reason: unknown) => {
      // ① 落盘：重启后不再崩一轮（这是"停用"的意义所在）
      pluginStateStore.setAutoDisabled(id, true)
      // ② 布局对账：声明式贡献即将随 disable 摘除，已打开的面板视图要关掉。
      //    与手动禁用同序（见 ipc/plugins.js 的 ①→②→③）—— 顺序反了会留
      //    「按钮没了但面板还开着」的一帧。这里只做对账，「摘」由 infra 的 disable 负责。
      try { reconcilePanelsAcrossWindows() } catch (_) {}
      // ②' 贡献面同步**必须让位一拍**：infra 把 disable() 排进了微任务（见 autoDisable 的说明），
      //     此刻贡献表里还留着该插件的页面/菜单。同步调用只会照旧重注册一遍，等于没停用。
      setTimeout(() => { refreshPluginSurfaces() }, 0)
      // ③ 广播：各窗口插件中心据此把该插件渲染成「已自动停用（原因…）」而不是普通关闭态。
      //    IPC 是异步的，微任务里的 disable() 必定先跑完 —— UI 拿到清单时 enabled 已是 false。
      if (typeof notifyPluginsChanged === 'function') {
        notifyPluginsChanged({ id, autoDisabled: true, reason })
      }
      // ④ 与用户手动禁用同款的收尾（见 onPluginDisabled 的说明）：权限引擎被**自动停用**
      //    同样会让待响应请求失去出口 —— 两条路径都要收，不能只管手动那条。
      closeOutPendingPermissionRequests()
      // ④' 能力门面的运行期残留（AI 工具 / 事件订阅 / 浮层）同样要摘 —— 与手动禁用同一落点。
      try { pluginCapabilities.disposePlugin(id) } catch (_) {}
      try { pluginOverlayHost.disposePlugin(id) } catch (_) {}
    },
    // 域服务出口同样按窗口解析 tabManager：否则插件拿到的仍是主窗口那一份
    getDomainServices: () => ({ ...getDomainServices(), tabManager: scopedTabManager }),
    /**
     * 插件能力门面（PART18）：`ctx.browser.*` 的**唯一来源**。
     * 第三方的每一条能力都按 manifest 声明的 scope 裁剪；第一方（trustLevel: internal/core）
     * 全量放行 —— 裁剪规则只在 plugin-capabilities.js 一处，注册中心不认识业务能力。
     */
    createCapabilities: (manifest: UnknownRecord, grantedScopes: string[]) => pluginCapabilities.createFor(manifest, grantedScopes),
    // 内核端口（第一方插件专用）
    kernel
  })
    .then(({ manager, pluginRegistry: reg, isolation }: {
      manager?: { stopAll(): Promise<void> }
      pluginRegistry?: PluginRegistryPort | null
      isolation?: CallablePort | null
    }) => {
      pluginModules = manager || null
      pluginRegistry = reg || null
      pluginIsolation = isolation || null
      /**
       * 迟绑定错误汇聚点（见上方 `pluginErrorSink` 的说明）。
       *
       * 此刻之前发生的错误会被丢弃 —— 那是**启动期**错误，本就该由 enableAll 的
       * `failed` 态承载（不落盘、下次重试），而不是运行期的连环坏判定。两套机制
       * 的分工在这里落定：failed 管"启不起来"，autoDisabled 管"启起来了但一直崩"。
       */
      pluginErrorSink = (id: string, err: unknown) => {
        if (pluginRegistry && typeof pluginRegistry.reportPluginError === 'function') pluginRegistry.reportPluginError(id, err)
      }
      // 插件系统就绪 → 面板目录从「保底集」切换为「以贡献为准」。
      // 这一步之后，禁用一个面板插件会真的让面板消失（而不是回落到保底集）。
      panelCatalog.markReady()
      // 目录指纹可能因「保底集 → 贡献集」而变（通常 id 相同，但顺序/来源变了），
      // 主动对账一次让 lastPanelIdKey 落到稳定值上 —— 否则首次启停插件时会白白多跑一轮。
      // `refreshPluginSurfaces` 内部已包含对账；这里顺带把内部页 / bang / 菜单一次性同步出来
      // （插件模块刚注册完贡献，此刻是它们第一次可见的时机）。
      refreshPluginSurfaces()
      // 插件后台启动完成 → 广播一次：插件中心首次 list 大概率早于此刻（拿到空清单），
      // 这条广播是它补齐真实清单的唯一路径。
      if (typeof notifyPluginsChanged === 'function') notifyPluginsChanged({ reason: 'boot' })
      // 插件全部就位 → 执行它们贡献的 schema 迁移（`db.schema.migration`）。
      // 必须晚于 enableAll：迁移实现是插件模块注册的，早于它调用只会拿到空列表。
      runPluginMigrations()
      // 同理：丢弃语言包缓存，让插件贡献的译文（`l10n.bundle-provider`）下次查表生效。
      l10nService.reload()
      /**
       * 主题目录「二次刷新」—— 这是插件化主题的**生效点**。
       *
       * 为什么必须在这里再来一次：主题服务在**建窗之前**就 `prime()` 了（首屏不能闪），
       * 而那时插件还没启用，`contributes.themes` 与 `theme.source` 都还是空的。
       * 插件全部就位后刷新一次，插件主题才真正进入目录；`publish()` 会以令牌指纹去重，
       * 若当前主题不是插件主题则**零开销**（指纹不变 → 不广播、不重绘）。
       */
      themeService.refreshSources()
        .then(() => themeRuntime.publish())
        .catch((e: unknown) => console.warn('[theme] 插件主题刷新失败（非致命）：', errorMessage(e)))
      console.log('[main] init timing: enableAppPlugins took', Date.now() - _t0, 'ms')
    })
    .catch((e: unknown) => console.error('[main] enableAppPlugins failed (non-fatal):', errorMessage(e)))


  // 会话恢复只在浏览器模式下有意义：PWA-only 时主窗从未 mount，
  // 恢复出来的标签会落在**不可见**的窗口里（白占内存、还会写脏会话分片）。
  if (!pwaOnlyMode) {
    // 会话恢复：优先恢复上次会话，否则新建空白标签
    // 每个「profile × 空间」的会话保存在各自目录下
    const profileSessionDir = sessionDirFor(activeSpace.profileId, activeSpace.id)

    // 迁移旧 session.json（userData 根目录 → profile 目录 → profile × 空间目录）
    const oldSessionFile = path.join(app.getPath('userData'), 'session.json')
    const legacyProfileSessionFile = path.join(resolveProfileDir(String(activeProfile?.id || 'default')), 'session.json')
    const newSessionFile = path.join(profileSessionDir, 'session.json')
    try {
      fs.mkdirSync(profileSessionDir, { recursive: true })
      if (!fs.existsSync(newSessionFile)) {
        if (fs.existsSync(legacyProfileSessionFile)) {
          fs.copyFileSync(legacyProfileSessionFile, newSessionFile)
          console.log('[main] migrated profile session.json to', profileSessionDir)
        } else if (fs.existsSync(oldSessionFile)) {
          fs.copyFileSync(oldSessionFile, newSessionFile)
          console.log('[main] migrated old session.json to', profileSessionDir)
        }
      }
    } catch (e) {
      console.error('[main] session migration failed:', errorMessage(e))
    }

    // 「上次关闭」归档：此刻 session.json 仍是**上一轮退出时**的内容（迁移之后、
    // 恢复与新建标签之前），顺手复制一份只读副本供会话面板的卡片展示。
    archiveLastClosedSession(profileSessionDir)

    console.log('[main] restoring session...')
    console.log('[main] init timing: before restoreSession took', Date.now() - _t0, 'ms')
    // 启动行为（STARTUP_SETTING_KEYS.mode）：blank 空白页 / home 主页 / custom 自定义页 /
    // last_session 恢复上次会话。完全取代旧的布尔开关 app.continue_where_you_left_off。
    // 未知/历史脏值一律回落到真源默认档（STARTUP_MODES[0]），不让启动路径开空页。
    const rawStartupMode = settingsService.get(STARTUP_SETTING_KEYS.mode)
    const startupMode = STARTUP_MODES.includes(rawStartupMode) ? rawStartupMode : STARTUP_MODES[0]
    let restored
    if (startupMode === 'last_session') {
      restored = await sessionService.restore(profileSessionDir, profileTabPort)
    } else {
      restored = { restored: false }
    }
    console.log('[main] session restored:', restored.restored)
    console.log('[main] init timing: restoreSession took', Date.now() - _t0, 'ms')
    if (!restored.restored) {
      // 未恢复时会话：按启动模式打开对应地址。
      // 三种模式都走「已登记的解析函数」：主页走 home-url 的唯一解析，
      // 自定义页校验后直接使用（留空/非法则回退新标签页，绝不打开空地址）。
      let startUrl
      if (startupMode === 'home') {
        // 「主页」= 用户配置的主页档（扩展覆盖由 TabManager 在建标签时应用）
        startUrl = defaultNewTabUrl()
      } else if (startupMode === 'custom') {
        const custom = String(settingsService.get(STARTUP_SETTING_KEYS.customPage) || '').trim()
        startUrl = custom || defaultNewTabUrl()
      } else {
        startUrl = defaultNewTabUrl()
      }
      await tabManager.newTab({ url: startUrl })
    }

    // ── 恢复上次的多窗口（会话分片）─────────────────────────────────
    // 每个非主窗口把自己那一份 `session-w<n>.json` 恢复回来，因此「关掉应用再打开」
    // 不会只剩下主窗口 —— 这是多窗口可用性的最后一环。
    // 只在 last_session 模式做：blank / home / custom 三种模式语义上就是「只开一个窗口」。
    if (startupMode === 'last_session') await restoreSecondaryWindows(profileSessionDir)
  }

  // 补推一次当前主题：覆盖「视图晚于初始主题推送才创建」的时序缺口。
  // 惰性创建的浮层/密码浮层各自在 renderer 侧 theme-controller.start() 里
  // 读 settings:get('app.theme') 自行上色；此处兜底 rail 与已存在视图。
  // （rail 的加载已在 mount() 内等待完成）
  try { themeRuntime.broadcastCurrent() } catch (_) {}

  await runStartupBackgroundTasks({
    getComponents: () => require('electron').components || null,
    pwaOnlyMode,
    isFeatureOn,
    pwaUpdater,
    listenerRegistry,
    sessions: sessionWindows,
    urlRouter
  })
  console.log('[main] init timing: rail finished took', Date.now() - _t0, 'ms')

  if (process.env.NG_SMOKE_TAB_MOVE) {
    await runTabMoveSmoke({
      browserWindows,
      primaryWindow,
      tabManager,
      moveTabToWindow,
      listBrowserWindows
    })
  }

  // ── 退出状态机（对齐 HiraRT quit-controller）──
  // 以前这里是两处零散的 app.on('before-quit')：一处管「设置/浏览数据/书签备份落盘」，
  // 另一处管「会话保存」。两者彼此独立、无时序约束，且 Electron 的 before-quit 一旦
  // 有监听器就默认「退出可被取消」——多监听器下谁先跑、谁 preventDefault 都不确定，
  // 极易出现「退出丢数据 / 退不掉」。现统一收敛为单个 QuitController：
  //   before-quit 一律 preventDefault 夺权 → 串行执行 onBeforeQuit 落盘 →
  //   置 completed 后 app.quit() 放行。回调抛错也强制退出，绝不把用户困在退不掉的窗口里。
  const beforeQuit = createAppShutdownHandler({
    setQuitting: () => sessionWindows.markQuitting(),
    onboarding,
    settings: settingsService,
    stopFeatureModules: async () => {
      try { breakModeRef?.stop?.() } catch (_) {}
      for (const relay of [bookmarkEventRelay, noteEventRelay, historyEventRelay, totpEventRelay, faviconEventRelay]) {
        try { relay.stop?.() } catch (_) {}
      }
      const managers = [
        ['plugins', pluginModules],
        ['post-ipc', postIpcModules?.manager],
        ['core', coreModules?.manager]
      ] as const
      for (const [label, manager] of managers) {
        if (!manager || typeof manager.stopAll !== 'function') continue
        try {
          await manager.stopAll()
        } catch (error) {
          console.warn(`[shutdown] ${label} modules failed to stop:`, errorMessage(error))
        }
      }
    },
    flushExtensions: () => Promise.all(listLoadedExtensionServices().map((service: { flush?: () => unknown } | null) => (
      service && typeof service.flush === 'function' ? service.flush() : Promise.resolve()
    ))),
    stopExtensionRelay: () => stopExtensionRelay(),
    history: historyService,
    downloads: downloadService,
    bookmarkBackup,
    sessions: sessionWindows,
    windowState,
    getPluginRegistry: () => pluginRegistry,
    getPluginIsolation: () => pluginIsolation,
    getExtensionSession: () => extensionService && extensionService.session,
    getExtensionSessions: () => listLoadedExtensionServices().map((service: { session?: Session | null } | null) => service && service.session),
    privacyKeys: PRIVACY_SETTING_KEYS,
    print: printService,
    disposeRuntime: () => {
      try { passkeys.dispose() } catch (_) {}
      try { themeRuntime.stop() } catch (_) {}
      try { themeScheduler.stop() } catch (_) {}
      try { listenerRegistry.clear() } catch (_) {}
      try { logHub.dispose() } catch (_) {}
    }
  })
  createQuitController({ onBeforeQuit: beforeQuit }).register()
  } catch (err) {
    console.error('[main] FATAL error during startup:', err)
    // A startup failure before window creation must release the single-instance lock.
    // Keeping the process alive leaves an invisible zombie that makes every later
    // `pnpm dev` exit immediately while the old blank window keeps the userData lock.
    setImmediate(() => app.exit(1))
  }
})

// 关闭最后一个窗口 = 退出应用（对齐 RT `src/main/app/lifecycle.ts`，
// 也见上面「C18 关闭到托盘已移除 — 关闭即退出，与 Hira/RT 一致」）。
//
// ⚠️ 这里曾经是空 handler `() => {}` —— 它会**吃掉 Electron 的默认退出语义**：
// 关窗后主进程既不退出、又没有托盘可把它唤回（当时的托盘模块从未被调用，现已删除，
// 见 CONTRACT-18），于是变成「无窗口僵尸」，却仍然占着 userData 下的
// chromium-cache 与 hira-ng.db。此时再启动一个实例（旧版还没有单实例锁）就会与
// 僵尸争抢这两个文件锁，Chromium IO 线程不断重试：
//   Unable to move the cache: 拒绝访问。 (0x5)
//   Failed to delete the database: Database IO error
// 主进程 / IO 线程被反复打断 → 整个窗口卡顿，原生右键菜单（Windows
// TrackPopupMenu 嵌套消息循环）表现得像「卡死不像人」。
// 这与「抄哪个浏览器」无关，是生命周期设计缺陷。
// 实现已抽到 app/lifecycle.js（对齐 RT app/lifecycle.ts）。
registerAppLifecycle({ app })
