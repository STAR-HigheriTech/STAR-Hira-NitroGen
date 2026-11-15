/**
 * PWA 窗口运行时 —— 「哪些应用窗口开着」的**唯一编排点**。
 *
 * ══════════════════════════════════════════════════════════════════
 * 职责（只做编排，不做窗口本身的活）
 * ══════════════════════════════════════════════════════════════════
 *  · 打开 / 聚焦 / 关闭应用窗（按 appId 去重：同一个应用只有一个窗口）
 *  · 把窗口回调落到**正确的 profile**（pwaService 按 profile 分区读写）
 *  · chrome 高度上报的归属校验（只有窗口自己的 chrome webContents 能改落位）
 *  · PWA-only 模式下「最后一个应用窗关闭 → 通知外层退出」
 *
 * 窗口长什么样全部在 `window.js`（建窗 / 贴视图 / 导航 / 几何），
 * 应用记录与规则在 domain-pwa，本文件只做它们之间的接线。
 *
 * ── 为什么每个入口都要记 profileId ────────────────────────────────
 * PWA 应用窗**不注册窗口运行单元**（它不是浏览器窗口，没有 tabManager）。
 * 因此 `runtimeRegistry.currentProfileId()` 在窗口事件里解析不到它 ——
 * 打开时解析一次、记在表项里，之后所有 pwaService 调用都显式
 * `runWithProfile(entry.profileId, …)`。这是本文件唯一的 profile 口径。
 *
 * ── PWA-only ──────────────────────────────────────────────────────
 * 冷启动参数 `--pwa-app=` 时主窗从不 `mount`（永远隐藏）。Windows 的
 * `window-all-closed` 不会因为「隐藏的主窗」触发，所以最后一个应用窗关闭时
 * 必须由这里明确通知外层 `app.quit()`。
 */

import fs from 'node:fs'
import type { BrowserWindow, Session, WebContents } from 'electron'
import type { WindowRegistry } from '@hira-ng/infra-window'
import {
  resolvePwaFileLaunch,
  resolvePwaProtocolLaunch,
  type PwaRecord,
  type PwaService,
  type PwaWindowState
} from '@hira-ng/domain-pwa'
import { createPwaAppWindow } from './window'
import type { PwaPaths } from './paths'

export interface PwaRuntimeRegistry {
  runWithProfile<T>(profileId: string, fn: () => T): T
  currentProfileId(): string | null | undefined
}

export interface PwaOpenEntry {
  appId: string
  profileId: string
  spaceId: string | null
}

export interface PwaAccentThemeInfo {
  isDark?: boolean
  accentColor?: string
  onAccentColor?: string
}

export interface PwaNavigationInput {
  appId: string
  action?: string
  url?: string
  zoom?: number
  sender?: WebContents | null
}

interface PwaRuntimeWindowController {
  readonly appId?: string
  readonly win?: { isDestroyed(): boolean; webContents: WebContents } | null
  readonly view?: { webContents?: WebContents | null } | null
  readonly features?: unknown
  isAlive(): boolean
  focus(): void
  navigate(input: { action?: string; url?: string; zoom?: number }): { ok: boolean; reason?: string }
  setChromeHeight(height: unknown): void
  getWindowState(): PwaWindowState | null
  close(): void
  ownsSender?(sender: WebContents): boolean
}

interface PwaRuntimeEntry {
  controller: PwaRuntimeWindowController
  profileId: string
  spaceId: string | null
}

export interface PwaRuntimeDependencies {
  pwaService: PwaService
  runtimeRegistry: PwaRuntimeRegistry
  paths: PwaPaths
  getSession?(profileId: string): Session | null | undefined
  windowRegistry?: WindowRegistry<BrowserWindow> | null
  settingsService?: { get(key: string): unknown; set(key: string, value: unknown): unknown } | null
  onOpenInBrowser?(url: string, entry: PwaOpenEntry): void
  onUninstall?(appId: string, profileId: string): void
  onInvalidApp?(appId: string, profileId: string): boolean | void
  printPage?(context: { wc: WebContents; title: string; url: string }): void
  getAccentThemeInfo?(): PwaAccentThemeInfo | null
  onEmpty?(): void
  logger?: { warn?(...args: unknown[]): void; error?(...args: unknown[]): void }
}

export interface PwaOpenResult {
  ok: boolean
  reason?: string
  appId?: string
  focused?: boolean
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

export function createPwaRuntime(deps: PwaRuntimeDependencies) {
  const { pwaService, runtimeRegistry, paths, getSession, windowRegistry } = deps
  if (!pwaService || !runtimeRegistry || !paths) {
    throw new TypeError('createPwaRuntime 需要 pwaService / runtimeRegistry / paths')
  }
  const logger = deps.logger || console

  const entries = new Map<string, PwaRuntimeEntry>()
  let pwaOnly = false

  /** 所有数据域读写都在「打开该应用时的 profile」里执行（见文件头）。 */
  function withProfile<T>(profileId: string, fn: () => T): T {
    try {
      return runtimeRegistry.runWithProfile(profileId, fn)
    } catch (_) {
      return fn()
    }
  }

  function resolveProfile(): string {
    try {
      return String(runtimeRegistry.currentProfileId() || 'default')
    } catch (_) {
      return 'default'
    }
  }

  function sessionFor(profileId: string): Session | null {
    if (typeof getSession !== 'function') return null
    try {
      return getSession(profileId) || null
    } catch (err) {
      logger.warn?.('[pwa-runtime] 取 session 失败:', errorMessage(err))
      return null
    }
  }

  /** 主进程形状的应用记录（含资产路径 / 窗口几何）；不存在返回 null。 */
  function recordFor(appId: string, profileId?: string | null): PwaRecord | null {
    const pid = String(profileId || resolveProfile())
    try {
      return withProfile(pid, () => pwaService.getRecord(appId)) || null
    } catch (err) {
      logger.warn?.('[pwa-runtime] 读取应用记录失败:', errorMessage(err))
      return null
    }
  }

  /** 资产目录是「安装完整」的最低证据（安装管线一定会创建它）。 */
  function assetsExist(appId: string, profileId: string): boolean {
    try {
      return fs.existsSync(paths.assetDir(profileId, appId))
    } catch (_) {
      return false
    }
  }

  /**
   * 资产目录缺失 = 安装已被外部破坏（用户手工清了 userData、磁盘清理工具误删）。
   * 只返回错误会让 DB 记录与快捷方式永远指向一个打不开的应用，所以顺手清理：
   *  · 优先交给外层卸载端口（会一并删快捷方式、广播 pwa:changed）；
   *  · 外层没接管（返回 false / 抛错）时退化为只删记录 —— 资产本来就不存在。
   */
  function cleanupBrokenApp(appId: string, profileId: string): void {
    let handled = false
    if (typeof deps.onInvalidApp === 'function') {
      try {
        handled = deps.onInvalidApp(appId, profileId) !== false
      } catch (err) {
        logger.warn?.('[pwa-runtime] 清理损坏应用失败:', errorMessage(err))
      }
    }
    if (!handled) {
      try {
        withProfile(profileId, () => pwaService.remove(appId))
      } catch (err) {
        logger.warn?.('[pwa-runtime] 删除损坏应用记录失败:', errorMessage(err))
      }
    }
  }

  function persistGeometry(appId: string, geometry: PwaWindowState): void {
    const entry = entries.get(appId)
    if (!entry || !geometry) return
    try {
      withProfile(entry.profileId, () => pwaService.setWindowState(appId, geometry))
    } catch (err) {
      logger.warn?.('[pwa-runtime] 保存窗口几何失败:', errorMessage(err))
    }
  }

  function handleClosed(appId: string): void {
    entries.delete(appId)
    if (pwaOnly && entries.size === 0 && typeof deps.onEmpty === 'function') {
      try {
        deps.onEmpty()
      } catch (err) {
        logger.error?.('[pwa-runtime] 空窗口回调失败:', errorMessage(err))
      }
    }
  }

  /** 打开应用（已开则聚焦）。 */
  function open(appId: unknown, profileId?: string | null, spaceId?: string | null): PwaOpenResult {
    const id = String(appId == null ? '' : appId).trim()
    if (!id) return { ok: false, reason: '缺少应用 id' }

    const existing = entries.get(id)
    if (existing && existing.controller.isAlive()) {
      existing.controller.focus()
      return { ok: true, appId: id, focused: true }
    }
    // 表项残留（窗口已销毁但 closed 尚未回调）：先清掉，避免污染后续判断。
    if (existing) entries.delete(id)

    const pid = String(profileId || resolveProfile())
    const record = recordFor(id, pid)
    if (!record) return { ok: false, reason: '应用不存在' }
    if (!assetsExist(id, pid)) {
      // 顺手清掉这条"看得见但打不开"的残留记录，别让用户反复踩同一个坑。
      cleanupBrokenApp(id, pid)
      return { ok: false, reason: '应用文件缺失，已清理该应用，请重新安装' }
    }

    const controller = createPwaAppWindow({
      record,
      profileId: pid,
      spaceId: spaceId || null,
      paths,
      session: sessionFor(pid),
      windowRegistry,
      settingsService: deps.settingsService || null,
      // 强调色由组合根注入（主题服务唯一真源）：应用窗错误页没有宿主桥，
      // 只能靠这里把主题派生的色值带进 data: 页面。
      getAccentThemeInfo: deps.getAccentThemeInfo,
      onClosed: handleClosed,
      onStateChange: persistGeometry,
      onOpenInBrowser: (url: string) => {
        if (typeof deps.onOpenInBrowser === 'function') {
          deps.onOpenInBrowser(url, { appId: id, profileId: pid, spaceId: spaceId || null })
        }
      },
      onUninstall: (targetId: string) => {
        if (typeof deps.onUninstall === 'function') deps.onUninstall(targetId, pid)
      },
      printPage: deps.printPage
    })
    if (!controller) return { ok: false, reason: '无法创建应用窗口' }

    entries.set(id, { controller, profileId: pid, spaceId: spaceId || null })
    withProfile(pid, () => {
      try {
        pwaService.touchLaunched(id)
      } catch (err) {
        logger.warn?.('[pwa-runtime] 记录启动次数失败:', errorMessage(err))
      }
    })
    return { ok: true, appId: id }
  }

  /** 界面上的「打开应用」：profile 由发起窗口的上下文决定。 */
  function launch(id: unknown): PwaOpenResult {
    return open(id, resolveProfile(), null)
  }

  function launchRequest(request: {
    appId: string
    profileId?: string | null
    spaceId?: string | null
    file?: string | null
    url?: string | null
  }): PwaOpenResult {
    const result = open(request.appId, request.profileId, request.spaceId)
    if (!result.ok) return result
    const record = recordFor(request.appId, request.profileId || resolveProfile())
    if (!record) return result
    const target = request.file
      ? resolvePwaFileLaunch(record.manifestJson, record.startUrl, request.file)
      : request.url
        ? resolvePwaProtocolLaunch(record.manifestJson, record.startUrl, request.url)
        : null
    if (target) navigate({ appId: request.appId, url: target, sender: null })
    return result
  }

  function entryFor(appId: unknown): PwaRuntimeEntry | null {
    return entries.get(String(appId == null ? '' : appId)) || null
  }

  /**
   * sender 是否属于这个应用窗（chrome / 网页本体 / 两个浮层）。
   * 校验的意义：应用窗的 chrome 是渲染层输入，绝不能让它拿到**别的**应用窗的控制权。
   * 归属判定只有窗口控制器知道（它持有全部 webContents），这里只做转发。
   */
  function senderOwns(sender: WebContents | null | undefined, entry: PwaRuntimeEntry): boolean {
    if (!sender) return true // 冷启动 / 内部调用
    try {
      if (typeof entry.controller.ownsSender === 'function') {
        return entry.controller.ownsSender(sender)
      }
    } catch (_) {}
    // 没有能力包的控制器（降级路径）：至少认 chrome 与网页本体。
    const { win, view } = entry.controller
    try {
      if (win && !win.isDestroyed() && win.webContents === sender) return true
    } catch (_) {}
    try {
      if (view && view.webContents && view.webContents === sender) return true
    } catch (_) {}
    return false
  }

  /**
   * 由 sender 反查所属应用窗的能力包 —— **PWA 专用 IPC 路由的唯一归属判定点**。
   *
   * 为什么必须有它：PWA 窗不在 runtimeRegistry 里，泛用通道会把请求落到主窗口。
   * 所有 `pwa:find-* / pwa:zoom-* / pwa-overlay:*` 都要先过这里：既拿到正确的
   * 控制器实例，又保证「A 应用窗的请求改不到 B 应用窗」。
   *
   */
  function featuresForSender(sender: WebContents | null | undefined, appId?: string | null): unknown | null {
    if (!sender) return null
    const id = String(appId == null ? '' : appId)
    if (id) {
      const entry = entryFor(id)
      if (!entry || !senderOwns(sender, entry)) return null
      return entry.controller.features || null
    }
    for (const entry of entries.values()) {
      if (senderOwns(sender, entry)) return entry.controller.features || null
    }
    return null
  }

  /** 应用窗导航（chrome 按钮 / 菜单）。 */
  function navigate(input: PwaNavigationInput): { ok: boolean; reason?: string } {
    const entry = entryFor(input.appId)
    if (!entry) return { ok: false, reason: '应用窗口未打开' }
    if (!senderOwns(input.sender, entry)) return { ok: false, reason: '无权限' }
    return entry.controller.navigate({
      action: input.action,
      url: input.url,
      zoom: input.zoom
    })
  }

  /**
   * chrome 上报标题栏高度 → 网页视图落位。
   * **只接受该窗口自己的 chrome webContents**：网页本体没有 preload，理论上发不出来；
   * 万一将来给页面加了桥，也不能让它改自己的落位（可以把页面挪到标题栏下面盖住 chrome）。
   */
  function setChromeHeight(input: { appId: string; height: unknown; sender?: WebContents | null }): void {
    const entry = entryFor(input.appId)
    if (!entry) return
    const { win } = entry.controller
    try {
      if (input.sender && win && !win.isDestroyed() && win.webContents !== input.sender) return
    } catch (_) {
      return
    }
    entry.controller.setChromeHeight(input.height)
  }

  function getWindowState(appId: unknown): PwaWindowState | null {
    const entry = entryFor(appId)
    if (!entry || !entry.controller.isAlive()) return null
    return entry.controller.getWindowState()
  }

  function close(appId: unknown): { ok: boolean; reason?: string } {
    const entry = entryFor(appId)
    if (!entry) return { ok: false, reason: '应用窗口未打开' }
    entry.controller.close()
    return { ok: true }
  }

  function closeAll(): void {
    for (const entry of Array.from(entries.values())) {
      try {
        entry.controller.close()
      } catch (_) {}
    }
  }

  /** 打开中的应用 id 快照（诊断 / 管理页用）。 */
  function list(): string[] {
    return Array.from(entries.keys())
  }

  /** PWA-only：主窗永不显示，最后一个应用窗关闭即退出。 */
  function setPwaOnlyMode(enabled: unknown): void {
    pwaOnly = !!enabled
  }

  function isPwaOnly(): boolean {
    return pwaOnly
  }

  return {
    launch,
    launchRequest,
    open,
    navigate,
    setChromeHeight,
    getWindowState,
    close,
    closeAll,
    list,
    isOpen: (appId: unknown) => !!entryFor(appId),
    recordFor,
    featuresForSender,
    entryFor: (appId: unknown) => {
      const entry = entryFor(appId)
      if (!entry) return null
      return {
        appId: entry.controller.appId,
        profileId: entry.profileId,
        spaceId: entry.spaceId,
        isAlive: entry.controller.isAlive()
      }
    },
    setPwaOnlyMode,
    isPwaOnly,
    get size() {
      return entries.size
    }
  }
}
