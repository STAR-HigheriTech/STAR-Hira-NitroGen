/**
 * app/preboot.ts — 「app ready 之前必须完成」的启动前置动作。
 *
 * 为什么要单独一层（PART12 D9）：这些动作**有时序硬约束**——Chromium 开关、
 * UA、特权协议、单实例锁、崩溃收集都必须在任何窗口/session 创建之前完成。
 * 把它们从 main.js 的装配代码里剥离，main.js 只负责「建服务 → 接线 → 开窗」，
 * 前置时序集中在一处，后人加新开关不必在 5000 行里找插入点。
 *
 * 本模块只做**进程级**的事，不认识窗口运行单元、不认识任何业务服务：
 *   - earlyBootSettings：ready 之前直读设置文件（硬件加速 / 平滑滚动）
 *   - UA 伪装：任何 session 之前写入 app.userAgentFallback
 *   - 事件订阅登记表 + 登记制广播器：renderer 随时订阅都能登记成功
 *   - HTTP Basic / 代理认证弹窗
 *   - 崩溃收集 + 证书错误留档
 *   - 全局异常兜底（不弹原生错误框）
 *   - FedCm 关闭 + Windows Toast 归属（AppUserModelID）
 *
 * 返回的句柄全部是**晚绑定端口**：main.js 在 registerCoreIpc 里按需读取。
 */

import fs from 'node:fs'
import path from 'node:path'
import { crashReporter, type App, type CrashReport, type IpcMain, type WebContents } from 'electron'
import type { EventCatalogPort } from '@hira-ng/infra-ipc'
import { createTlsTrustController, type CertificateErrorRecord } from './tls-trust'

const { createListenerRegistry, createBroadcaster, ipcSchemas } =
  require('@hira-ng/infra-ipc') as typeof import('@hira-ng/infra-ipc')
const { GLOBAL_SETTINGS_FILE } = require('@hira-ng/shared-types/src/settings-scope.mjs') as { GLOBAL_SETTINGS_FILE: string }
const { ipcRoutePolicy } = require('../ipc-route-policy') as {
  ipcRoutePolicy: {
    authorizeSender(event: unknown): boolean
    authorizeEventSubscription(event: unknown, route: string): boolean
  }
}
// 启动期 Chromium 开关键名的唯一真源（与域层默认值 / 设置页字段表同源）。
const { PERFORMANCE_SETTING_KEYS } = require('@hira-ng/shared-types/src/performance.mjs') as {
  PERFORMANCE_SETTING_KEYS: { hardwareAcceleration: string; smoothScrolling: string }
}
const { createEventCatalogPort, isKnownEvent } = require('@hira-ng/shared-types/src/event-catalog.mjs') as {
  createEventCatalogPort(): EventCatalogPort
  isKnownEvent(route: string): boolean
}
// OS 身份 / 开发态门禁的唯一装配点。
const { getRuntimeIdentity } = require('./runtime-identity') as {
  getRuntimeIdentity(): import('./runtime-identity').RuntimeIdentity
}
const { isDevRuntime } = require('./runtime-mode') as { isDevRuntime(): boolean }
const { registerListenerIpc } = require('../ipc/listeners') as {
  registerListenerIpc(ipcMain: IpcMain, registry: unknown, options: {
    schemas: unknown
    policy: {
      authorizeSender(event: unknown): boolean
      authorizeEventSubscription(event: unknown, route: string): boolean
    }
  }): void
}
const { createHttpAuthManager } = require('../http-auth') as {
  createHttpAuthManager(): { attach(): void }
}
const { applySpoofedUserAgent } = require('../user-agent') as {
  applySpoofedUserAgent(app: App): string
}
const { ownerWindowOf } = require('../window-runtime-registry') as {
  ownerWindowOf(webContents: unknown): { id: number } | null | undefined
}

interface PrebootOptions { app: App; ipcMain: IpcMain }

interface CrashReportItem {
  date: number | null
  type: string | null
  id: string | null
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function errorStack(error: unknown): string {
  return error instanceof Error && error.stack ? error.stack : String(error)
}

/** 证书错误留档上限：长会话下避免无界增长。 */
const CERTIFICATE_ERROR_LIMIT = 50

/**
 * ready 之前直读设置文件。
 *
 * 为什么不用 settingsService：它在 ready 之后才能安全初始化，而硬件加速 /
 * 平滑滚动只有 ready 之前 appendSwitch 才生效。这里只「读」同一份文件
 * （不写、不缓存、失败即回落默认值），不与 domain-settings 的写入竞争。
 *
 * ⚠ L2（PART16 §4.5）：这两个键属**全局**，迁移后住在 `settings.global.json`。
 * 先读全局文件，读不到再回落到迁移前的 `settings.json`（安装基线）。
 */
function readEarlyBootSettings(app: App): Record<string, unknown> {
  const readJson = (name: string): Record<string, unknown> | null => {
    try {
      const file = path.join(app.getPath('userData'), name)
      const raw = JSON.parse(fs.readFileSync(file, 'utf8'))
      return raw && typeof raw === 'object' ? raw : null
    } catch (_) {
      return null
    }
  }
  return readJson(GLOBAL_SETTINGS_FILE) || readJson('settings.json') || {}
}

/**
 * 必须在 ready 之前决定的 Chromium 开关。
 * @param {import('electron').App} app
 * @param {Record<string, any>} settings
 */
function applyEarlyChromiumSwitches(app: App, settings: Record<string, unknown>): void {
  if (settings[PERFORMANCE_SETTING_KEYS.hardwareAcceleration] === false) {
    // 显卡驱动异常导致的掉帧 / 花屏 / 白屏，用户可在设置里关掉，下次启动生效。
    app.disableHardwareAcceleration()
  }
  // 平滑滚动：显式给出开关（默认开启），避免不同平台默认值不一致导致的手感差异。
  app.commandLine.appendSwitch(
    settings[PERFORMANCE_SETTING_KEYS.smoothScrolling] === false
      ? 'disable-smooth-scrolling'
      : 'enable-smooth-scrolling'
  )
  // FedCm（Google One Tap）在 Electron 里原生提示永不弹出，禁用即可。
  // 不再自创 disk-cache-dir / media-cache-dir —— 让每个 session 用 Chromium 默认缓存目录。
  app.commandLine.appendSwitch('disable-features', 'FedCm')
  /**
   * 暴露 `global.gc()` —— 内存压力回收里那句 `global.gc()` 目前是**死分支**：
   * 主进程默认不暴露它，`typeof global.gc === 'function'` 恒为 false，于是
   * 「压力到来时把主进程堆还给系统」这一步从来没执行过。
   *
   * 只增加一个调试面绑定，没有运行时开销；渲染进程（沙箱、无 node）不受影响。
   */
  app.commandLine.appendSwitch('js-flags', '--expose-gc')
}

/** 订阅侧名册校验（开发态）：同一路由只报一次，避免 renderer 反复重订刷爆控制台。 */
function createSubscriptionAudit() {
  const warned = new Set<string>()
  return (route: string): void => {
    if (isKnownEvent(route) || warned.has(route)) return
    warned.add(route)
    console.warn('[listeners] 订阅了未登记的事件路由: ' + route + ' —— 请在 shared-types/src/event-catalog.mjs 登记')
  }
}

/** Electron 的 CrashReport 只有 date / id —— 没有进程类型可给，不编造。 */
function toCrashReportItem(report: CrashReport | null | undefined): CrashReportItem | null {
  if (!report) return null
  const record = report as unknown as Record<string, unknown>
  return {
    date: report.date ? new Date(report.date).getTime() : null,
    type: record.type ? String(record.type) : null,
    id: report.id ? String(report.id) : null
  }
}

/**
 * 执行全部 ready 前置动作，返回 main.js 需要的晚绑定句柄。
 *
 * @param {{ app: import('electron').App, ipcMain: import('electron').IpcMain }} deps
 */
export function createPreboot({ app, ipcMain }: PrebootOptions) {
  const developmentRuntime = isDevRuntime()
  const runtimeIdentity = getRuntimeIdentity()
  // ── 1. Chromium 开关（必须最先）──────────────────────────────────────────
  const earlyBootSettings = readEarlyBootSettings(app)
  applyEarlyChromiumSwitches(app, earlyBootSettings)

  // ── 2. UA 伪装（任何 session / webContents 之前）─────────────────────────
  // 算出来的值有两个用途：① 立刻写进 app.userAgentFallback；② 作为「浏览器标识」
  // 里「默认」预设的取值（清洗规则只有一处真源，见 shared-types/user-agent.mjs）。
  const defaultUserAgent = applySpoofedUserAgent(app)
  console.log('[main] user-agent:', defaultUserAgent)

  // ── 3. 事件订阅登记表 + 登记制广播器 ─────────────────────────────────────
  // 模块加载期就建好并注册 IPC：任何 renderer（含随后创建的浮层/面板）一订阅就能登记。
  // scopeOf 让登记表知道 webContents 属于哪个窗口 → 窗口级事件只发给发起它的窗口。
  const listenerRegistry = createListenerRegistry({
    scopeOf: (wc: unknown) => {
      const owner = ownerWindowOf(wc)
      return owner ? owner.id : null
    },
    // 开发态：渲染层订阅了名册里没有的路由 → 一次性告警。
    onUnknownRoute: developmentRuntime ? createSubscriptionAudit() : undefined
  })
  const broadcaster = createBroadcaster(listenerRegistry, {
    // 开发态名册校验：未登记路由、窗口级事件漏传 windowId 都会一次性告警。
    // 生产态不注入 → 竞态路径零开销。
    catalog: developmentRuntime ? createEventCatalogPort() : null,
    warn: developmentRuntime ? (message: string) => console.warn(message) : null
  })
  registerListenerIpc(ipcMain, listenerRegistry, {
    schemas: ipcSchemas.listeners,
    policy: ipcRoutePolicy
  })

  // ── 4. HTTP Basic / 代理认证弹窗 ────────────────────────────────────────
  // 不注册的话需要认证的站点会直接 401，用户既看不到提示也无从输入账号密码。
  const httpAuthManager = createHttpAuthManager()
  httpAuthManager.attach()

  // ── 5. 崩溃收集（必须 ready 之前 start）──────────────────────────────────
  // uploadToServer=false —— 本构建没有上报服务端，只做本地留存，
  // 由 hira://crash-report 页面如实展示；不伪造「已上报」状态。
  let crashReporterEnabled = false
  try {
    crashReporter.start({ uploadToServer: false, compress: false })
    crashReporterEnabled = true
  } catch (e) {
    console.warn('[main] crashReporter.start failed:', errorMessage(e))
  }

  // ── 6. 证书错误留档 ─────────────────────────────────────────────────────
  // Electron 只在回调里把 Certificate 交给你一次，回调后只剩 Chromium 错误页，
  // 而 Chromium 没有「列出证书」的 API —— 想看证书信息只能在这里留下来。
  const certificateErrors: CertificateErrorRecord[] = []
  let certificateScopeResolver: ((webContents: WebContents) => string) | null = null
  const tlsTrust = createTlsTrustController({
    onCertificateError(record, webContents) {
      let scopeKey = 'default'
      try {
        scopeKey = certificateScopeResolver?.(webContents) || 'default'
      } catch {}
      certificateErrors.unshift({ ...record, scopeKey })
      if (certificateErrors.length > CERTIFICATE_ERROR_LIMIT) certificateErrors.length = CERTIFICATE_ERROR_LIMIT
    }
  })
  tlsTrust.attach(app)

  // ── 7. 全局异常兜底：阻止 Electron 默认的 "A JavaScript error occurred" 弹窗 ──
  process.on('uncaughtException', (err) => {
    try {
      console.error('[main] uncaughtException:', errorStack(err))
    } catch {}
  })
  process.on('unhandledRejection', (reason) => {
    try {
      console.error('[main] unhandledRejection:', errorStack(reason))
    } catch {}
  })

  // ── 8. Windows Toast 归属 ───────────────────────────────────────────────
  // 不显式设置时权限层看起来完全正常，但系统 Toast 静默不出现。
  // 取值 = package.json 的 build.appId，同时被 associations.mjs 写进 ProgId 的身份块。
  app.setAppUserModelId(runtimeIdentity.appUserModelId)

  // ── 9. 开发态窗口图标 ───────────────────────────────────────────────────
  // 打包态：窗口 / 任务栏 / Alt-Tab 图标由 exe 内嵌资源提供（build/icon.ico），
  //         运行期不设 icon —— 否则单张 PNG 会盖掉系统按 DPI 选中的多尺寸资源。
  // 开发态：exe 是 electron.exe，不注入就只见 Electron 默认图标。
  // 一个开关在 infra-window 内对主窗口 / 子窗口 / 对话框全体生效。
  if (developmentRuntime) {
    const iconPath = runtimeIdentity.windowIconPath
    if (iconPath && fs.existsSync(iconPath)) {
      const { setDefaultWindowIcon } = require('@hira-ng/infra-window') as { setDefaultWindowIcon(path: string): void }
      setDefaultWindowIcon(iconPath)
    }
  }

  return {
    earlyBootSettings,
    defaultUserAgent,
    listenerRegistry,
    broadcaster,
    httpAuthManager,
    tlsTrust,
    isCrashReporterEnabled: () => crashReporterEnabled,
    getCertificateErrors: () => certificateErrors.slice(),
    setCertificateScopeResolver: (resolver: ((webContents: WebContents) => string) | null) => {
      certificateScopeResolver = typeof resolver === 'function' ? resolver : null
    },
    getCrashReports: () => {
      try {
        const items: CrashReportItem[] = []
        const last = toCrashReportItem(crashReporter.getLastCrashReport())
        if (last) items.push(last)
        for (const r of crashReporter.getUploadedReports() || []) {
          const item = toCrashReportItem(r)
          if (item) items.push(item)
        }
        return items
      } catch (_) {
        return []
      }
    }
  }
}

