/**
 * module-bootstrap.js — 应用内特性模块的统一启动器（Step 6）
 *
 * 把 main.js 里散落的四块「自包含特性初始化」收拢成 IHiraModule
 * （infra-plugin#ModuleManager，拓扑排序启动、反序停止）：
 *
 *   core 阶段（registerCoreIpc 之前，IPC 路由要消费它们的产品）：
 *     - downloads        registerDownloadHandler → downloadController
 *     - keybindings      createKeybindingsManager → keybindings
 *
 *   post-ipc 阶段（IPC 挂载之后，需要向外广播 / 依赖 tabManager 等）：
 *     - settings.sync    createSettingsFeature（applier 链 + settings:changed 广播）
 *     - auto.update      自动更新排程 + 状态机（静默低频，未打包不加载 updater）
 *     - theme.runtime    系统主题变化同步
 *     - tabs.auto-sleep  自动休眠定时器（可 stop）
 *     - memory.guard     app.getAppMetrics() 驱动的内存压力紧急回收（可 stop）
 *     - storage.retention history/favicons 定期裁剪，防本地库无界增长（可 stop）
 *     - app.plugins      enableAppPlugins（插件目录加载）
 *
 * 为什么分两个 ModuleManager 而不是一个：registerCoreIpc 必须卡在两批模块中间
 * （它消费 core 的产品、又先于 post-ipc 的广播链路）——这是 main.js 现有行为，
 * 两阶段保序是最小改动。阶段内的启动顺序由 dependsOn 拓扑排序决定，不再靠书写顺序。
 */

import { app, BrowserWindow, type Session, type WebContents } from 'electron'
import { ModuleManager } from '@hira-ng/infra-plugin'
import { createKeybindingsManager } from './keybindings'
import { createSettingsFeature, type SettingsSync } from './settings'
import type { ApplierDependencies, TabManagerPort } from './settings/appliers/types'
import type { SettingsServicePort } from './settings/sync'

interface DownloadControllerPort { [key: string]: unknown }
interface UpdateServicePort { start(): void; stop(): void }

interface CoreBootstrapResult {
  manager: ModuleManager
  downloadController: DownloadControllerPort | undefined
  keybindings: ReturnType<typeof createKeybindingsManager> | undefined
}

interface PostIpcBootstrapResult {
  manager: ModuleManager
  settingsSync: SettingsSync | undefined
  updateService: UpdateServicePort | undefined
}
interface PluginRegistryPort {
  reportPluginError?(id: string, error: unknown): unknown
  listGrantedPermissions?(): Record<string, string[]>
}
interface PluginIsolationPort { loader: unknown; dispose?(): void }

interface HistoryMaintenancePort {
  compactHistory?(): { removed?: number; merged?: number }
  removeBefore?(timestamp: number): number
}

interface FaviconMaintenancePort { removeBefore?(timestamp: number): number }

const { registerDownloadHandler } = require('./download-manager') as {
  registerDownloadHandler(
    session: Session,
    downloadService: unknown,
    options: {
      emit: unknown
      settingsService: unknown
      parentWindow: unknown
      guardDownload: unknown
      onDownloadStarted: unknown
      resolveSavePath?: (input: { url: string; filename: string; mimeType?: string; directory: string }) => { directory: string; filename: string }
      onDownloadCompleted?: (input: { id: string; filePath: string }) => void
    }
  ): DownloadControllerPort
}
// 自动更新（唯一真源）：静默排程 + 双通道 + 原地覆盖安装，见 update/service.js 的文件头。
const { createUpdateService } = require('./update/service') as {
  createUpdateService(options: { settingsService: unknown; emit: unknown }): UpdateServicePort
}
const { enableAppPlugins } = require('./plugin-bootstrap') as {
  enableAppPlugins(options: unknown): Promise<PluginRegistryPort>
}
const { createPluginIsolation } = require('./plugin-isolation') as {
  createPluginIsolation(options: {
    onCrash(id: string, error: unknown): void
    getGrantedScopes(id: string): string[]
    onLog(id: string, level: string, message: string): void
  }): PluginIsolationPort
}
// 进程内存口径（唯一真源，见 process-memory.ts）：显示类消费方取「独占内存」，
// 本文件的压力回收**两个口径都要**——单进程工作集（谁特别重）+ 独占求和（是不是太多）。
const { privateMemoryKB, workingSetMemoryKB } = require('./process-memory') as {
  privateMemoryKB(memory: unknown): number | null
  workingSetMemoryKB(memory: unknown): number | null
}
// 归档阈值（`tabs.archiveAfter` → ms）的**唯一真源**：本文件的定时器与启动恢复期的
// 过期过滤共用同一张表，改设置不会出现"自动归档用新值、恢复过滤用旧值"的漂移。
import { TABS_RETENTION_SETTING_KEYS, resolveArchiveThresholdMs } from '@hira-ng/shared-types/src/tabs-retention.mjs'
// 自动休眠 / 省电的键名与阈值归一化真源（设置页 / 域层默认值 / 本文件的定时器同源）。
import { TAB_SLEEP_SETTING_KEYS, resolveAutoSleepThresholdMs } from '@hira-ng/shared-types/src/tab-sleep.mjs'
// 历史保留期的键名 + 「天数 → ms」换算真源（设置页档位与本文件的裁剪定时器同源）。
import { HISTORY_RETENTION_SETTING_KEY, resolveHistoryRetentionMs } from '@hira-ng/shared-types/src/history-retention.mjs'
// 性能设置键名的唯一真源（内存压力回收的总开关与设置页 / 启动期开关同源）。
import { PERFORMANCE_SETTING_KEYS } from '@hira-ng/shared-types/src/performance.mjs'
// 进程级常驻定时器的**收尾时机**要用到 `app.on('window-all-closed')`（见下文三处说明）：
// 这些定时器不属于某个窗口，绑在单个窗口的 `closed` 上会在多窗口下被提前掐断。
interface CoreBootstrapDependencies {
  extensionService: { session: Session }
  downloadService: unknown
  emit: unknown
  settingsService: SettingsServicePort
  win: unknown
  tabManager: unknown
  guardDownload: unknown
  onDownloadStarted: unknown
  resolveDownloadSavePath?: (input: { url: string; filename: string; mimeType?: string; directory: string }) => { directory: string; filename: string }
  onDownloadCompleted?: (input: { id: string; filePath: string }) => void
  keybindingActions?: Record<string, () => unknown>
  slots?: { multi(name: string, payload: unknown, context: unknown): unknown }
}

type PostIpcDependencies = ApplierDependencies & {
  settingsService: SettingsServicePort
  emit: unknown
  historyService?: HistoryMaintenancePort
  faviconService?: FaviconMaintenancePort
  listProfileIds?(): string[]
  runAsProfile?<T>(profileId: string, task: () => T): T
  runAsScope?<T>(profileId: string, spaceId: string, task: () => T): T
  getSession?: () => Session | null
}

interface PluginBootstrapDependencies {
  appRoot: string
  win: unknown
  uiShellWebContents: WebContents | null
  webContentsManager: unknown
  layoutCoordinator: unknown
  themeManager: unknown
  tabManager: unknown
  providerRegistry: unknown
  contributions: unknown
  panelCatalog: unknown
  extensionPoints: unknown
  pluginStateStore: unknown
  onPluginAutoDisable: unknown
  getDomainServices: unknown
  pluginUserDir?: string
  kernel: unknown
  createCapabilities: unknown
}

/**
 * core 阶段：downloads + keybindings。
 * @param {object} deps  main.js 现场注入的依赖（全部显式，不藏全局）
 * @returns {Promise<{ manager: ModuleManager, downloadController: object, keybindings: object }>}
 */
export async function bootstrapCoreModules(deps: CoreBootstrapDependencies) : Promise<CoreBootstrapResult> {
  const { extensionService, downloadService, emit, settingsService, win, tabManager, guardDownload, onDownloadStarted, resolveDownloadSavePath, onDownloadCompleted } = deps

  const manager = new ModuleManager()
  let downloadController: DownloadControllerPort | undefined
  let keybindings: ReturnType<typeof createKeybindingsManager> | undefined

  manager.register({
    id: 'downloads',
    dependsOn: [],
    async start() {
      // 下载控制接口（pause/resume/cancel，需要 settingsService 和主窗口作为父窗口）
      // guardDownload：站点守卫（自动下载策略）的判定口，由 main.js 注入（见 site-guard.js）。
      // onDownloadStarted：下载开始 → 自动打开下载面板（选边逻辑在 download-panel-opener.js）。
      downloadController = registerDownloadHandler(extensionService.session, downloadService, {
        emit,
        settingsService,
        parentWindow: win,
        guardDownload,
        onDownloadStarted,
        resolveSavePath: resolveDownloadSavePath,
        onDownloadCompleted
      })
    }
  })

  manager.register({
    id: 'keybindings',
    dependsOn: [],
    async start() {
      // 键盘快捷键（actions 闭包引用 main.js 的 tabManager / switchToIndex）
      // slots：`shortcut.binding` 插槽 —— 内置绑定未命中时问一次插件，
      // 无插件参与时是一次空结果，开销可忽略（详见 keybindings.js 的注释）。
      keybindings = createKeybindingsManager({
        settingsService,
        actions: deps.keybindingActions,
        slots: deps.slots
      })
    }
  })

  manager.setServices({ tabManager })
  await manager.installAll()
  await manager.startAll()
  console.log('[main] core modules ready: downloads, keybindings')

  return { manager, downloadController, keybindings }
}

/**
 * post-ipc 阶段：settings.sync + tabs.auto-sleep + app.plugins。
 * @returns {Promise<{ manager: ModuleManager, settingsSync: object, updateService: object }>}
 */
async function runPostIpcModules(deps: PostIpcDependencies) : Promise<PostIpcBootstrapResult> {
  const {
    settingsService, searchService, getSession, getDownloadController,
    // 注：这里**不要** win —— 本阶段的定时任务都是进程级的，收尾挂 `window-all-closed`，
    // 单个窗口实例在这里没有正当用途（见三处清理点的说明）。
    tabManager, getLayoutCoordinator, themeManager, emit, getExtensionService,
    send, historyService, faviconService,
    // 跨窗口标签同步（J15/A5）的引擎句柄：设置关掉时由 applier 清占位并复位记账。
    // **必须是 getter** —— 该引擎在 main.js 里建得比这里晚（见 main.js 的 tabSync 段落）。
    getTabSync,
    // 主题发布链句柄：`app.theme` 被"设置页 / 空间级写入"改掉时要通知它重发布一次
    // （见 settings/appliers/theme.js 的说明）。
    getThemeRuntime,
    // 网络代理（I4）：要下发代理的会话 + 订阅"新会话创建"。
    // ⚠ L2（PART16 §5）：会话清单**按 profile 给**（当前 profile 的会话 + 无痕会话），
    //   不再"全部会话"——否则 A 的代理会盖到 B 的会话上（物理独立要消除的正是这个）。
    getSessions,
    onSessionCreated,
    // 浏览器标识（UA）：内置默认 UA（清洗后的标准 Chrome UA）。
    // 按 profile 下发（同上，会话清单由 getSessions 给），故不再有"写全局兜底"这一步。
    getDefaultUserAgent,
    // 浏览器标识（UA）的配套：Accept-Language 语言列表（由系统首选项组装，不含 q 值）。
    // 与 UA 一起经 session.setUserAgent 下发，交给 Chromium 原生补 q 值。
    getAcceptLanguages,
    // 仅 HTTPS（I2）：全部 webContents + 「新建 webContents」订阅（导航层升级，见 applier）
    getWebContents,
    onWebContentsCreated,
    // 数据域已按 profile 分区（Steam 式多用户）：保留策略必须逐 profile 执行。
    // 两个端口均由 main.js 注入，缺省时退化为「只清 default」，与改造前等价。
    listProfileIds, runAsProfile
  } = deps
  /** 进入某个 profile 的数据作用域；端口缺失时直接执行（= 当前/默认 profile）。 */
  const asProfile = typeof runAsProfile === 'function'
    ? runAsProfile
    : <T>(_id: string, fn: () => T): T => fn()
  /** 保留策略要覆盖的 profile 列表；端口缺失时退化为只清 default。 */
  const retentionProfileIds = (): string[] => {
    try {
      if (typeof listProfileIds === 'function') {
        const ids = listProfileIds()
        if (Array.isArray(ids) && ids.length) return ids
      }
    } catch (_) {}
    return ['default']
  }

  const manager = new ModuleManager()
  let settingsSync: SettingsSync | undefined
  let updateService: UpdateServicePort | undefined
  let sleepTimer: NodeJS.Timeout | undefined
  let memoryTimer: NodeJS.Timeout | undefined
  let retentionTimer: NodeJS.Timeout | undefined
  let retentionFirstRunTimer: NodeJS.Timeout | undefined
  let historyCompactTimer: NodeJS.Timeout | undefined
  manager.register({
    id: 'settings.sync',
    dependsOn: [],
    async start() {
      // ── 设置生效链路（main/settings 特性模块）──────────────
      // 以前 settings:set 只写文件就结束了，改了设置没有任何模块知道 → "改设置没效果"。
      // 该模块订阅 domain-settings 的变更通知：主进程侧跑 applier 真正生效，
      // 再把变更广播给所有渲染进程（ui-shell / overlay / 所有标签页）。
      const feature = createSettingsFeature({
        settingsService,
        send,
        runWithScope: deps.runAsScope,
        // applier 的依赖端口全部显式注入：缺哪个端口，对应 applier 自行安全降级。
        deps: {
          searchService,
          getSession,
          getDownloadController,
          getLayoutCoordinator,
          themeManager,
          nativeTheme: deps.nativeTheme ?? require('electron').nativeTheme,
          getExtensionService,
          // 标签页端口：性能类 applier（如后台节流）需要逐标签 webContents 下发
          tabManager,
          // 跨窗口标签同步：开关关掉时清掉各窗口的截图占位并复位记账
          getTabSync,
          // 主题发布链：`app.theme` 变了通知它重发布（本轮新增，补齐"设置页改主题"那条路）
          getThemeRuntime,
          // 网络代理：要下发的会话（当前 profile + 无痕）+ 新会话钩子
          //（见 settings/appliers/proxy.js）
          getSessions,
          onSessionCreated,
          // Secure DNS / DoH：Chromium 应用级主机解析器（ready 后可热切换）
          configureHostResolver: (options) => app.configureHostResolver(options),
          // 浏览器标识：内置默认 UA（按 profile 下发，见 settings/appliers/user-agent.js）
          getDefaultUserAgent,
          // 浏览器标识的配套：Accept-Language 语言列表（与 UA 同批下发）
          getAcceptLanguages,
          // 仅 HTTPS：导航层升级要覆盖"已存在 + 将来创建"的全部 webContents
          getWebContents,
          onWebContentsCreated,
          // 事件广播出口：部分 applier 需要主动推一条**专用事件**给标签页 preload
          //（如「鼠标手势配置」→ infra-window/preload/gestures）。
          send
        }
      })
      settingsSync = feature.sync
      console.log('[main] settings feature ready, appliers:', settingsSync?.listAppliers().map((a: { id: string }) => a.id).join(', '))
    },
    async stop() {
      settingsSync?.stop()
    }
  })

  manager.register({
    id: 'auto.update',
    dependsOn: ['settings.sync'], // 读 update.* 设置 + 订阅变更，排在生效链路之后
    async start() {
      // ── 自动更新（静默、低频、不阻塞）────────────────────────────
      // 服务自己持有排程与状态机：设置项（开关/周期/通道）变化经 subscribe 回到它，
      // 不再另设 settings applier —— 否则"调度规则"会散落成两处（改一处漏一处）。
      // 未打包的构建不会 require electron-updater（懒加载），这里只是挂一个空转排程。
      updateService = createUpdateService({ settingsService, emit })
      updateService.start()
    },
    async stop() {
      if (updateService) updateService.stop()
    }
  })

  manager.register({
    id: 'tabs.auto-sleep',
    dependsOn: ['settings.sync'], // 读 tabs.autoSleep 设置，语义上排在生效链路之后
    async start() {
      // ── 标签自动休眠 + 自动归档（内存优化，两条回收腿）──────────
      // 每 60s 检查一次：
      //   · 归档（长期闲置，默认永不）：直接删除标签 —— 止住「标签栏只增不减」；
      //   · 休眠（非活动超过 10 分钟）：销毁 webContents 但保留标签记录，可唤醒。
      // 两条腿共用同一次 tick、同一套候选豁免（domain-tabs#sleepCandidates），
      // 不必开第二个定时器，也保证豁免规则永远不会各自漂移。
      const SLEEP_INTERVAL_MS = 60 * 1000
      /**
       * 还醒着的标签数（跨全部窗口）。
       *
       * 取 `list()` 而不是自己去遍历窗口：`tabsFanout` 已经把每个窗口的
       * `tabManager.list()` 做了并集，且投影里就带 `sleeping`（见 TabManager#_projectTab）。
       * 任何一步取不到都返回 0 —— 调用方的自适应只会退化成"用用户配置的阈值"，
       * 不会因为一个探测失败就把标签全睡掉。
       */
      const countAwakeTabs = () => {
        try {
          if (!tabManager || typeof tabManager.list !== 'function') return 0
          const rows = tabManager.list()
          if (!Array.isArray(rows)) return 0
          let n = 0
          for (const t of rows) if (t && !t.sleeping) n += 1
          return n
        } catch (_) {
          return 0
        }
      }
      sleepTimer = setInterval(() => {
        try {
          // ── 归档腿（先归档）────────────────────────────
          // 每轮现读实时值：改完设置下一轮即生效，无需重启，与下方 autoSleep 同款读法。
          // 归档独立于 tabs.autoSleep 开关 —— 两个开关各管一条腿。
          // 阈值解析走 tabs-retention 的单一真源（与启动恢复期的过期过滤同一张表）。
          const archiveThresholdMs = resolveArchiveThresholdMs(settingsService.get(TABS_RETENTION_SETTING_KEYS.archiveAfter))
          if (archiveThresholdMs) {
            const archiveResult = tabManager && typeof tabManager.archiveInactive === 'function'
              ? tabManager.archiveInactive({ inactiveThresholdMs: archiveThresholdMs })
              : null
            const archivedCount = archiveResult && Array.isArray(archiveResult.archived)
              ? archiveResult.archived.length
              : 0
            if (archivedCount > 0) {
              console.log(`[tab] auto-archive: ${archivedCount} tabs`)
            }
          }

          // ── 休眠腿（后休眠）────────────────────────────
          // 先归档的好处：两条腿都够格的标签会先被归档移出标签栏，
          // 排序确定（归档是更强的回收），推理与日志都清晰。
          const enabled = settingsService.get(TAB_SLEEP_SETTING_KEYS.autoSleep) ?? true
          if (!enabled) return
          const threshold = resolveAutoSleepThresholdMs(settingsService.get(TAB_SLEEP_SETTING_KEYS.thresholdMs))
          // N12 省电模式：把非活动阈值再压到 1 分钟（取更短者），换取续航。
          // 只在自动休眠已开启时收紧 —— 用户显式关掉自动休眠，省电模式不去逆其意。
          const energySaver = settingsService.get(TAB_SLEEP_SETTING_KEYS.energySaver) === true
          const baseThreshold = energySaver ? Math.min(threshold, 60 * 1000) : threshold
          /**
           * ── 前台自适应阈值（本轮新增）────────────────────────────────────
           *
           * 上面那条「时间驱动」的腿原本只认用户配置（默认 5 分钟）。真实场景是：
           * 用户一口气开 20+ 个标签继续在前台用 —— 每个醒着的标签是一个独立 renderer，
           * 实测独占 ~25MB（真实页面 30–50MB）。总量早已几百 MB，但**没有任何一个**
           * 闲置满 5 分钟，于是压力判据（650MB 总和）成了唯一的止血点，等到它触发时
           * 用户已经在"越用越卡"里待了很久。
           *
           * 所以这里让闲置宽限随「还醒着的标签数」收紧 —— 标签越多，单个标签越不值得
           * 一直占着一个进程：
           *   ≥ 20 个醒着 → 90s
           *   ≥ 12 个醒着 → 180s
           * 少于 12 个仍然是用户配置值（默认 5 分钟），日常轻量使用完全感知不到变化。
           *
           * 豁免不受影响：活动标签 / 屏幕上可见（分屏、速览）/ 固定标签（除非用户关掉
           * `excludePinned`）/ 正在发声的标签，仍由 `sleepInactive` → `sleepCandidates`
           * 那一套统一判定（见 tabLifecycle 与 domain-tabs），这里只改"多久算闲置"。
           */
          const awake = countAwakeTabs()
          const adaptiveThreshold = awake >= 20 ? 90 * 1000 : awake >= 12 ? 180 * 1000 : Number.POSITIVE_INFINITY
          const effectiveThreshold = Math.min(baseThreshold, adaptiveThreshold)
          const excludePinned = settingsService.get(TAB_SLEEP_SETTING_KEYS.excludePinned) !== false
          const sleepResult = tabManager && typeof tabManager.sleepInactive === 'function'
            ? tabManager.sleepInactive({ inactiveThresholdMs: effectiveThreshold, excludePinned })
            : null
          const sleptCount = sleepResult && Array.isArray(sleepResult.slept) ? sleepResult.slept.length : 0
          if (sleptCount > 0) {
            console.log(`[tab] auto-sleep: ${sleptCount} tabs (awake=${awake}, threshold=${Math.round(effectiveThreshold / 1000)}s)`)
          }
        } catch (e) {
          console.error('[tab] auto-sleep/archive failed:', e instanceof Error ? e.message : String(e))
        }
      }, SLEEP_INTERVAL_MS)
      // 与其余两条常驻定时器一致：unref 掉，不替 Node 事件循环"续命"。
      if (typeof sleepTimer.unref === 'function') sleepTimer.unref()
      /**
       * 收尾时机 = **整个应用已经没有窗口**，而不是"主窗口关闭"。
       *
       * ⚠ 这是一个真实缺陷的修复点：自动休眠 / 归档跑在 `tabsFanout` 上（覆盖**每一个**窗口，
       * 见 main.js 的注入注释），它本身是**进程级**任务；而这里的 `win` 是**主窗口**实例。
       * 多窗口下用户完全可能先关主窗口、留着别的窗口继续用 —— 绑 `win.on('closed')`
       * 会让这两条腿**提前停摆**：其余窗口的标签从此不再被归档 / 休眠回收，
       * 正是"越用越卡"的一条暗线。（对齐 main.js 里主题调度器的同类做法：只在
       * `window-all-closed` 停。）
       */
      app.on('window-all-closed', () => clearInterval(sleepTimer))
    },
    async stop() {
      if (sleepTimer) clearInterval(sleepTimer)
    }
  })

  manager.register({
    id: 'memory.guard',
    dependsOn: ['tabs.auto-sleep'], // 复用同一套 sleepInactive（含音频豁免），语义上排在其后
    async start() {
      // ── 内存压力紧急回收（对齐 legacy Hira `main/memoryManager.js`）──────────
      // NG 原先只有「时间驱动」的自动休眠：非活动标签要闲置满阈值才睡。一旦标签
      // 多、页面重，内存会在阈值到点前就冲高，用户感知为「越用越卡」。
      // 这里补上「压力驱动」这条腿：每 60s 读 app.getAppMetrics()，按两级阈值分级回收。
      // ⚠ 判据有**两条**，缺一不可（见下方采样处的说明）——
      //   单进程工作集（对齐 legacy 的 500/700MB）+ 全部 renderer 独占内存之和。
      const { app, BrowserWindow } = require('electron')
      /** 单个 renderer 的**工作集**阈值（MB）：识别「某个页面特别重」。 */
      const MODERATE_MB = 500
      const CRITICAL_MB = 700
      /**
       * 全部 renderer 的**独占内存之和**阈值（MB）：识别「页面太多了」。
       *
       * 依据（实测，见 process-memory.ts 与 .hira-ai 的记录）：一个标签页约 25 MB 独占
       * （空页面 22–23 MB，真实页面 30–50 MB）。
       *
       * ── 为什么从 800/1600 收到 640/1280（前台专项）─────────────────────────
       * 原值按「25–30 个标签」定的：那时只有时间驱动的休眠，压力线是最后的止血点，
       * 于是刻意定得保守。现在的目标是**前台使用过程中**就把占用压住 ——
       *   · 640 MB ≈ 20–25 个活跃标签（真实页面则是 13–20 个）—— 已经到了"该收"的量；
       *   · 1280 MB ≈ 40+ 个标签 —— 必须收，否则一个窗口就能吃掉半个 8 GB 机器。
       * 两个值仍**明显高于界面本身**（uiShell + rail + 面板 ≈ 80–100 MB 独占），
       * 不会因为"界面存在"而误触发；回收动作本身也只睡**非活动**标签（活动标签、
       * 屏幕上可见的、正在发声的都由 `sleepInactive` 豁免），用户当下那一页不受影响。
       */
      const SUM_MODERATE_MB = 640
      const SUM_CRITICAL_MB = 1280
      const CHECK_INTERVAL_MS = 60 * 1000
      // 节流：moderate 90 秒最多一次；critical 5 分钟最多一次（避免持续高压下反复触发）
      const MODERATE_THROTTLE_MS = 90 * 1000
      const CRITICAL_THROTTLE_MS = 5 * 60 * 1000
      let lastModerateAt = 0
      let lastCriticalAt = 0

      memoryTimer = setInterval(() => {
        try {
          // 总开关：设置页关掉「内存节省程序」时整条压力回收停摆。
          // 与 tabs.autoSleep 同一处理方式 —— 每轮读实时值，改完下一轮即生效，
          // 不需要重启，也不需要为「开关变化」额外挂一条订阅。
          if (settingsService && settingsService.get(PERFORMANCE_SETTING_KEYS.memorySaver) === false) return
          // 窗口全部隐藏 / 最小化时直接跳过采样：`app.getAppMetrics()` 要遍历**全部子进程**
          // （其自身文档就写明是"中等开销的同步调用"）。用户把窗口丢在后台时每分钟照样
          // 全量采一次毫无意义 —— 后台没有交互，也就没有"越用越卡"要救。
          const visible = BrowserWindow.getAllWindows().some((w: BrowserWindow) => {
            try { return !w.isDestroyed() && w.isVisible() && !w.isMinimized() } catch (_) { return false }
          })
          if (!visible) return
          const metrics = app.getAppMetrics()
          if (!metrics || !metrics.length) return
          // 只关注 renderer 进程（GPU / utility / network 的占用不随标签增长）。
          //
          // ⚠ 两条判据都要采，缺一不可：
          //   · 单个 renderer 的**工作集** —— 识别「某个页面特别重」（一个重型 Web 应用）；
          //   · 全部 renderer 的**独占**内存之和 —— 识别「页面太多了」。
          // 为什么必须补第二条：多标签场景下每个页面都不大（实测一个标签约 25 MB 独占），
          // 20 个标签加起来几百 MB，但**没有任何一个**能到 500 MB 的单进程阈值 ——
          // 只看最大值时，「开了一堆标签」这个最常见的高内存场景里压力回收**永不触发**。
          // 求和刻意用独占（privateBytes）而不是工作集：工作集含每个进程各自计入的
          // ~86 MB 共享基线，20 个进程求和会把同一份物理页算 20 遍，阈值完全失去意义。
          let maxKB = 0
          let sumPrivateKB = 0
          for (const m of metrics) {
            if (m.type !== 'renderer' && !(m.webContents && m.webContents > 0)) continue
            const ws = workingSetMemoryKB(m.memory)
            if (ws !== null && ws > maxKB) maxKB = ws
            const pv = privateMemoryKB(m.memory)
            if (pv !== null) sumPrivateKB += pv
          }
          if (!maxKB && !sumPrivateKB) return

          const now = Date.now()

          const singleTooBig = maxKB > CRITICAL_MB * 1024
          const totalTooMany = sumPrivateKB > SUM_CRITICAL_MB * 1024
          const critical = singleTooBig || totalTooMany
          const moderate = maxKB > MODERATE_MB * 1024 || sumPrivateKB > SUM_MODERATE_MB * 1024
          if (!critical && !moderate) return
          if (critical) {
            if (now - lastCriticalAt < CRITICAL_THROTTLE_MS) return
            lastCriticalAt = now
            // critical 隐含已达到 moderate 条件，同步刷新避免下个周期重复走 moderate 分支
            lastModerateAt = now
          } else {
            if (now - lastModerateAt < MODERATE_THROTTLE_MS) return
            lastModerateAt = now
          }

          // 主进程侧回收：清 HTTP 内存缓存（不碰 cookie / localStorage / disk cache）。
          // 这是「软信号」，不强制杀任何进程。
          try {
            const s = typeof getSession === 'function' ? getSession() : null
            if (s && typeof s.clearCache === 'function') void s.clearCache().catch(() => {})
          } catch (_) {}

          // 渲染侧回收**顺序有讲究**：先收 UI 壳（浮层 → 面板 → 侧栏），再睡标签。
          //   浮层 / 面板 = 纯 UI，重建 ~65ms，用户几乎无感（面板会丢滚动位置与临时编辑，
          //   所以只在内存压力或久未打开时才收）；
          //   独立侧栏 = 一个**真实网页**，比上面两者重得多（登录态 / 滚动位置 / 可能正在
          //   播放的媒体），所以它**只**在这条压力链里收、且带"不可见 + 没在发声"双闸门，
          //   不做时间 TTL —— 用户收起再打开理应还是原来那一页；
          //   标签 = 一个真网页，睡掉之后用户切回去要**重新加载整个页面**。
          // 同样都能收回 renderer 进程，当然先挑代价小的动。
          // 这三步都走 layoutFanout，因此覆盖**每一个窗口**。
          let reclaimedFloats: string[] = []
          let reclaimedPanels: string[] = []
          let reclaimedSidebar = false
          try {
            const layoutFanout = typeof getLayoutCoordinator === 'function' ? getLayoutCoordinator() : null
            if (layoutFanout) {
              if (typeof layoutFanout.reclaimIdleFloatViews === 'function') {
                reclaimedFloats = layoutFanout.reclaimIdleFloatViews() || []
              }
              if (typeof layoutFanout.reclaimIdlePanelViews === 'function') {
                reclaimedPanels = layoutFanout.reclaimIdlePanelViews() || []
              }
              if (typeof layoutFanout.reclaimWebSidebarViews === 'function') {
                reclaimedSidebar = !!layoutFanout.reclaimWebSidebarViews()
              }
              // 密码浮层：极低频的那份 renderer（多凭据菜单 / 保存密码卡），
              // 收掉它对用户当下正在做的事毫无影响。
              if (typeof layoutFanout.reclaimPasswordOverlay === 'function') {
                layoutFanout.reclaimPasswordOverlay()
              }
            }
          } catch (e) {
            console.error('[mem] 回收浮层/面板/侧栏失败:', e instanceof Error ? e.message : String(e))
          }

          // 标签：立即休眠不活跃标签。moderate 保留 2 分钟宽限（别误伤刚切走的标签），
          // critical 收紧到 30s 并连固定标签一起回收 —— 音频标签始终由 sleepCandidates 豁免。
          const threshold = critical ? 30 * 1000 : 2 * 60 * 1000
          const sleepResult = tabManager && typeof tabManager.sleepInactive === 'function'
            ? tabManager.sleepInactive({ inactiveThresholdMs: threshold, excludePinned: !critical })
            : null
          const sleptCount = sleepResult && Array.isArray(sleepResult.slept) ? sleepResult.slept.length : 0
          console.log(
            `[mem] pressure ${critical ? 'critical' : 'moderate'} ` +
            `maxRenderer=${Math.round(maxKB / 1024)}MB rendererTotal=${Math.round(sumPrivateKB / 1024)}MB → ` +
            `reclaimed ${reclaimedFloats.length} floats` +
            `${reclaimedFloats.length ? ` (${reclaimedFloats.join(', ')})` : ''}, ` +
            `${reclaimedPanels.length} panels` +
            `${reclaimedPanels.length ? ` (${reclaimedPanels.join(', ')})` : ''}, ` +
            `sidebar=${reclaimedSidebar ? 'reclaimed' : 'kept'}, ` +
            `slept ${sleptCount} tabs`
          )
        } catch (e) {
          console.error('[mem] pressure check failed:', e instanceof Error ? e.message : String(e))
        }
      }, CHECK_INTERVAL_MS)
      if (typeof memoryTimer.unref === 'function') memoryTimer.unref()
      // 同上：内存压力回收是**进程级**防线（覆盖全部窗口的标签），
      // 只能在整个应用收尾时停，不能随主窗口关闭而停（否则其余窗口失去这条防线）。
      app.on('window-all-closed', () => clearInterval(memoryTimer))
    },
    async stop() {
      if (memoryTimer) clearInterval(memoryTimer)
    }
  })

  manager.register({
    id: 'storage.retention',
    dependsOn: ['settings.sync'], // 读 privacy.history_retention_days，故排在生效链路之后
    async start() {
      // ── 本地库保留策略（防 favicons / history 无界增长）──────────────────
      // history.removeBefore() 早已实现却从未被调用；favicons 表更是只增不减。
      // 长期使用后 SQLite 文件与其内存索引持续膨胀，是「越用越卡」的另一条暗线。
      //   · history  保留天数由 privacy.history_retention_days 决定（0 = 永久保留）
      //   · favicons 保留 30 天未更新（纯缓存，可随时重新抓取，放心淘汰）
      const FAVICON_RETENTION_MS = 30 * 24 * 60 * 60 * 1000
      const RETENTION_INTERVAL_MS = 6 * 60 * 60 * 1000
      const FIRST_RUN_DELAY_MS = 30 * 1000 // 启动高峰后再跑首次裁剪
      // 历史整理只做一次（幂等）：启动后立刻跑，用户打开历史面板时已经是干净数据。
      const HISTORY_COMPACT_DELAY_MS = 1200

      /**
       * 合并同页重复历史（追踪参数 / SPA replaceState / 旧版内部页遗留）。
       * domain 侧自带事务与幂等性，重复调用无副作用。
       */
      const compactHistory = (): void => {
        const compact = historyService && typeof historyService.compactHistory === 'function'
          ? historyService.compactHistory.bind(historyService)
          : null
        if (!compact) return
        for (const profileId of retentionProfileIds()) {
          try {
            asProfile(profileId, () => {
              const result = compact() || {}
              if ((result.removed || 0) > 0) {
                console.log(`[history] compact (${profileId}): merged ${result.merged || 0}, removed ${result.removed}`)
              }
            })
          } catch (e) {
            console.error('[history] compact failed:', e instanceof Error ? e.message : String(e))
          }
        }
      }

      const prune = () => {
        try {
          const now = Date.now()
          // 每次裁剪都重读设置 —— 用户在设置页改完即时生效，无需重启。
          const historyRetentionMs = resolveHistoryRetentionMs(settingsService.get(HISTORY_RETENTION_SETTING_KEY))
          // 逐个 profile 裁剪：domain 的 removeBefore 只作用于「当前 profile」，
          // 只跑一次会让非默认用户的历史/favicon 缓存无界增长。
          for (const profileId of retentionProfileIds()) {
            asProfile(profileId, () => {
              if (historyRetentionMs > 0 && historyService && typeof historyService.removeBefore === 'function') {
                const removed = historyService.removeBefore(now - historyRetentionMs)
                if (removed > 0) console.log(`[retention] history pruned (${profileId}): ${removed}`)
              }
              if (faviconService && typeof faviconService.removeBefore === 'function') {
                const removed = faviconService.removeBefore(now - FAVICON_RETENTION_MS)
                if (removed > 0) console.log(`[retention] favicons pruned (${profileId}): ${removed}`)
              }
            })
          }
        } catch (e) {
          console.error('[retention] prune failed:', e instanceof Error ? e.message : String(e))
        }
      }

      retentionTimer = setInterval(prune, RETENTION_INTERVAL_MS)
      if (typeof retentionTimer.unref === 'function') retentionTimer.unref()
      historyCompactTimer = setTimeout(compactHistory, HISTORY_COMPACT_DELAY_MS)
      if (typeof historyCompactTimer.unref === 'function') historyCompactTimer.unref()
      retentionFirstRunTimer = setTimeout(prune, FIRST_RUN_DELAY_MS)
      if (typeof retentionFirstRunTimer.unref === 'function') retentionFirstRunTimer.unref()
      // 同上：保留策略跨**所有** profile 与窗口的数据，属进程级任务 —— 只在应用收尾时停。
      app.on('window-all-closed', () => {
        clearInterval(retentionTimer)
        clearTimeout(retentionFirstRunTimer)
        clearTimeout(historyCompactTimer)
      })
    },
    async stop() {
      if (retentionTimer) clearInterval(retentionTimer)
      if (retentionFirstRunTimer) clearTimeout(retentionFirstRunTimer)
      if (historyCompactTimer) clearTimeout(historyCompactTimer)
    }
  })

  // 注意：app.plugins 不在此处 —— 插件启动必须晚于「布局应用完成」，
  // 由 bootstrapPluginModule 在 main.js 尾段单独拉起（保序）。

  await manager.installAll()
  await manager.startAll()

  return { manager, settingsSync, updateService }
}

/**
 * post-ipc 阶段的**幂等**入口（单飞）。
 *
 * 本阶段产出的全是**进程级**常驻物：settings 生效链路 + 三条常驻定时器
 * （`sleepTimer` / `memoryTimer` / `retentionTimer`）。它们都是本模块的 `let`，
 * 被调第二次会直接覆盖引用 —— 旧 interval 从此再没人能 `clearInterval`，
 * 变成真正清不掉的定时器泄漏。故用 Promise 缓存做单飞：并发双调用也只跑一遍。
 */
let postIpcBootstrapPromise: Promise<Awaited<ReturnType<typeof runPostIpcModules>>> | null = null
export function bootstrapPostIpcModules(deps: PostIpcDependencies): Promise<Awaited<ReturnType<typeof runPostIpcModules>>> {
  if (!postIpcBootstrapPromise) postIpcBootstrapPromise = runPostIpcModules(deps)
  return postIpcBootstrapPromise
}

/**
 * 插件阶段：app.plugins（UI 布局应用完成之后才启动 —— 保序，不能并入 post-ipc）。
 *
 * 这里同时是**进程级隔离的接线点**（PART7 §7.13）：组合根创建隔离端口，
 * 把 `loader` 注给注册中心，并在退出时 `dispose()` 收掉全部宿主进程。
 * 注册中心全程不认识"进程"这个概念，只认识"有个 loader 端口"。
 *
 * @returns {Promise<{ manager: ModuleManager, pluginRegistry: object|null, isolation: object|null }>}
 */
export async function bootstrapPluginModule(deps: PluginBootstrapDependencies) : Promise<{ manager: ModuleManager, pluginRegistry: object|null, isolation: object|null }> {
  const { appRoot, win, uiShellWebContents, webContentsManager, layoutCoordinator, themeManager, tabManager, providerRegistry, contributions, panelCatalog, extensionPoints, pluginStateStore, onPluginAutoDisable, getDomainServices, pluginUserDir, kernel, createCapabilities } = deps

  const manager = new ModuleManager()
  /** 插件注册中心（enableAppPlugins 的产物）—— 插件中心 IPC 靠它读清单/启停。 */
  let pluginRegistry: PluginRegistryPort | null = null

  /**
   * 进程级隔离端口。**先创建、后注入**（顺序被崩溃回调卡住）：
   * `onCrash` 要落到注册中心的 `reportPluginError`（连续出错触顶 → 自动停用），
   * 而注册中心又要拿到这个端口的 `loader` —— 用闭包读 `pluginRegistry` 解这个环。
   */
  const isolation = createPluginIsolation({
    onCrash: (id, err) => {
      if (pluginRegistry && typeof pluginRegistry.reportPluginError === 'function') {
        pluginRegistry.reportPluginError(id, err)
      }
    },
    // 授权 scope 的权威账本在注册中心（落盘由 APPS 负责，内存表在 infra）。
    getGrantedScopes: (id) => {
      if (!pluginRegistry || typeof pluginRegistry.listGrantedPermissions !== 'function') return []
      const all = pluginRegistry.listGrantedPermissions()
      return all[id] || []
    },
    onLog: (id, level, message) => {
      const line = `[plugin:${id}] ${message}`
      if (level === 'error') console.error(line)
      else console.log(line)
    }
  })

  manager.register({
    id: 'app.plugins',
    dependsOn: [],
    async start() {
      pluginRegistry = await enableAppPlugins({
        appRoot,
        // 运行时安装的第三方插件目录（用户数据目录）。缺省则该来源为空，行为与改造前一致。
        pluginUserDir,
        win,
        webContents: uiShellWebContents,
        webContentsManager,
        layoutCoordinator,
        themeManager,
        tabManager,
        providerRegistry,
        contributions,
        panelCatalog,
        extensionPoints,
        pluginStateStore,
        onPluginAutoDisable,
        getDomainServices,
        // 内核端口：仅第一方插件可见（见 PluginRegistryV2#_pluginContext）。
        kernel,
        // 能力门面（ctx.browser）：全部开放世界能力的唯一入口
        createCapabilities,
        // 加载端口：非第一方插件进独立进程（第一方原样委托回 infra 默认策略）
        loader: isolation.loader
      })
      console.log('[main] plugins enabled')
    }
  })

  await manager.installAll()
  await manager.startAll()
  return { manager, pluginRegistry, isolation }
}

