/**
 * IPC · PWA（把站点安装为应用）域。
 *
 * ══════════════════════════════════════════════════════════════════
 * 这个文件只做三件事：解析、委派、收敛错误
 * ══════════════════════════════════════════════════════════════════
 *  · **解析**：`pwa:prepare` / `pwa:candidate` 需要「发起方属于哪个窗口」，
 *    由 runtimeRegistry 在 ALS 上下文里给出；这里不碰 BrowserWindow。
 *  · **委派**：探测 → `pwaDetector`，安装 → `pwaInstaller`，快捷方式 → `pwaShortcuts`，
 *    应用窗口 → `pwaRuntime`，更新 → `pwaUpdater`，卸载 → `pwaUninstaller`。
 *    规则一律留在各自模块里，IPC 不重新判断一遍（单一事实源）。
 *  · **收敛错误**：检测/安装的失败一律变成 `{ ok:false, reason }`，
 *    不让一条异常穿过 IPC 边界变成渲染层的未捕获 rejection。
 *
 * ── 能力名与三处逐字一致 ────────────────────────────────────────────
 * `invoke('pwa.xxx', …)` 的第一个参数必须与 `plugins/pwa-service.cjs` 的
 * capabilities 键、`pwa-service.hira-plugin.json` 的 capabilities 数组逐字相同
 * （原因见 ipc/totp.js 头部；漏声明的后果是"插件禁用后能力仍可用"）。
 *
 * ── 端口缺失时安全跳过 ──────────────────────────────────────────────
 * P4（应用窗口）/ P6（更新、卸载）的编排对象晚于本注册器落地。对应端口没注入时
 * **不注册那条路由**，而不是注册一个永远返回假成功的桩 —— 后者会让 UI 以为
 * 功能存在，是比"少一条路由"严重得多的谎。
 */

import type { WebContents } from 'electron'
import { createProviderInvoker } from './provider-bridge'
import type { ProviderRegistryPort } from './provider-bridge'
import type { IpcRawMain, IpcRoutes, IpcSchemas, IpcTypedMain } from './types'

type MethodPort = Record<string, (...args: unknown[]) => unknown>
interface PwaRuntimeRegistryPort {
  current(): unknown
  matchBySender(sender: unknown): unknown
}
interface PwaIpcContext {
  routes: IpcRoutes
  schemas: IpcSchemas['pwa']
  pwaService: MethodPort
  pwaDetector?: MethodPort | null
  pwaInstaller?: MethodPort | null
  pwaShortcuts?: MethodPort | null
  pwaRuntime?: MethodPort | null
  pwaUpdater?: MethodPort | null
  pwaUninstaller?: MethodPort | null
  pwaPaths?: MethodPort | null
  getProfileId?: () => unknown
  providerRegistry?: ProviderRegistryPort | null
  runtimeRegistry?: PwaRuntimeRegistryPort | null
  authorizeWebPreloadSender?: (event: unknown) => boolean
  logger?: { warn?(...args: unknown[]): void }
}

interface PwaFeaturesPort {
  find: MethodPort
  zoom: MethodPort
  overlays: MethodPort
}
interface PwaSchemaPort<T> { safeParse(value: unknown): { success: true; data: T } | { success: false } }

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' ? value as Record<string, unknown> : {}
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

/**
 * @param {object} typedMain 带 schema 校验的 invoke 注册器
 * @param {object} senderScopedIpcMain 裸通道注册器（已按 sender 解析窗口）
 * @param {{
 *   routes: object,
 *   schemas: object,
 *   pwaService: object,
 *   pwaDetector?: object,
 *   pwaInstaller?: object,
 *   pwaShortcuts?: object,
 *   pwaRuntime?: object,
 *   pwaUpdater?: object,
 *   pwaUninstaller?: object,
 *   pwaPaths?: object,
 *   getProfileId?: () => string,
 *   providerRegistry?: object,
 *   runtimeRegistry?: object,
 *   logger?: { warn?: Function }
 * }} deps
 */
export function registerPwaIpc(typedMain: IpcTypedMain, senderScopedIpcMain: IpcRawMain | null | undefined, deps: PwaIpcContext): void {
  const {
    routes,
    schemas,
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
    runtimeRegistry,
    authorizeWebPreloadSender,
    logger = console
  } = deps

  if (!typedMain || !routes || !schemas || !pwaService) return

  const S = schemas
  const invoke = createProviderInvoker(providerRegistry)
  const sendCh = (route: string): string => `ngipc:send:${route}`
  const webPreloadAllowed = (event: unknown): boolean => {
    if (typeof authorizeWebPreloadSender !== 'function') return false
    try { return authorizeWebPreloadSender(event) === true } catch (_) { return false }
  }

  function warn(...args: unknown[]): void {
    if (logger && typeof logger.warn === 'function') logger.warn('[pwa-ipc]', ...args)
  }

  /** 当前上下文的窗口运行单元（typedMain 已把 sender 放进 ALS；兜底 primary）。 */
  function currentRuntime(): unknown {
    if (!runtimeRegistry) return null
    try { return runtimeRegistry.current() } catch (_) { return null }
  }

  /** 当前 profile（pwaService 的调用已被 ALS 包好，这里只是取同一个上下文）。 */
  function currentProfileId(): unknown {
    try { return typeof getProfileId === 'function' ? getProfileId() : null } catch (_) { return null }
  }

  /**
   * 给 `toApp()` 的结果补唯一的渲染层可见衍生字段：图标 URL。
   *
   * 图标地址必须由 `paths.iconUrl` 拼 —— 它是协议、白名单、profile 查询参数三者的
   * 唯一真源。渲染层拿不到资产目录，自己拼就会漂移。`pwaPaths` 缺失时给 null，
   * 页面回退 favicon（形状仍满足契约里的必填 nullable 字段）。
   *
   * 文件名走 `resolveIconAsset` 的实际探测：favicon 可能是 SVG（只产出 `icon.svg`）、
   * 也可能下载失败落到 `icon.ico` / 兜底位图。硬编码 `icon-512.png` 会让这些应用
   * 在列表里全部变成空白方块。
   */
  function enrichApp(appValue: unknown): unknown {
    if (!appValue) return appValue
    const app = asRecord(appValue)
    const profileId = app.hasIcon ? currentProfileId() : null
    let iconUrl = null
    if (profileId && pwaPaths) {
      try {
        const asset = typeof pwaPaths.resolveIconAsset === 'function'
          ? pwaPaths.resolveIconAsset(profileId, app.id)
          : null
        const assetRecord = asRecord(asset)
        if (assetRecord.file) iconUrl = pwaPaths.iconUrl(profileId, app.id, assetRecord.file)
      } catch (_) {
        iconUrl = null
      }
    }
    return { ...app, iconUrl }
  }

  /**
   * provider 路径（插件）与 fallback 路径（域服务直连）返回的都是**同一种**原始
   * DTO：只有 `hasIcon`，没有 `iconUrl`。视图字段一律在这一层补 ——
   * 若把 enrichApp 写进 fallback 闭包，插件启用时就会绕过它，两条路形状不同：
   * 先是 `pwa:list` 的 zod 闸门整条报错（iconUrl 缺失），再是页面拿不到图标。
   *
   * @template T
   * @param {T} result
   * @returns {T}
   */
  function enrichResult(resultValue: unknown): unknown {
    if (!resultValue || typeof resultValue !== 'object' || !('app' in resultValue)) return resultValue
    const result = resultValue as Record<string, unknown>
    return { ...result, app: enrichApp(result.app) }
  }

  // ── 读 ──────────────────────────────────────────────────────────────
  typedMain.handle(routes.pwaList, {
    requestSchema: S.list.request,
    responseSchema: S.list.response,
    handler: async () => {
      const apps = await invoke('pwa.list', () => pwaService.list(), null)
      return Array.isArray(apps) ? apps.map(enrichApp) : apps
    }
  })

  typedMain.handle(routes.pwaGet, {
    requestSchema: S.get.request,
    responseSchema: S.get.response,
    handler: async (_e, req) => {
      const app = await invoke('pwa.get', () => pwaService.get(req.id), req)
      return enrichApp(app)
    }
  })

  // ── 探测 ────────────────────────────────────────────────────────────
  if (pwaDetector) {
    typedMain.handle(routes.pwaPrepare, {
      requestSchema: S.prepare.request,
      responseSchema: S.prepare.response,
      handler: async (_e, req) => {
        const runtime = currentRuntime()
        if (!runtime) return { ok: false, reason: 'no-runtime' }
        try {
          // 必须 await：prepare 现在会补采页面线索（网络往返），
          // 不 await 的话异常会逃出 try/catch，变成未捕获的 rejection。
          return await pwaDetector.prepare({ runtime, tabId: req && req.tabId })
        } catch (err) {
          warn('准备安装失败：', errorMessage(err))
          return { ok: false, reason: errorMessage(err) }
        }
      }
    })

    typedMain.handle(routes.pwaState, {
      requestSchema: S.state.request,
      responseSchema: S.state.response,
      handler: async (_e, req) => pwaDetector.stateForTab(req.tabId)
    })
  }

  // ── 安装 ────────────────────────────────────────────────────────────
  if (pwaInstaller) {
    typedMain.handle(routes.pwaInstall, {
      requestSchema: S.install.request,
      responseSchema: S.install.response,
      handler: async (event, req) => {
        /**
         * 请求形状 → 管线输入形状只在这里翻译一次。
         *
         * 这个对象同时交给两条路：provider（插件 `pwa.install` 直接调用
         * `pwaInstaller.install(input)`）与 fallback（同一个 installer）。
         * 以前 fallback 闭包里才组装 `session/options`，而 `invoke` 的 input 传的是
         * 原始 req —— 插件启用时快捷方式选项被静默丢弃、图标下载也丢了发起方会话。
         */
        // 只透传「用户明确给了值」的开关：undefined 表示沿用该应用已有设置。
        // 覆盖安装时前端可能不传，绝不能当成 false 把用户的开机启动 / 快捷方式抹掉。
        const options: Record<string, unknown> = {}
        const request = asRecord(req)
        for (const key of ['createDesktopShortcut', 'createStartMenuShortcut', 'runOnStartup']) {
          if (typeof request[key] === 'boolean') options[key] = request[key]
        }
        const input = {
          candidateId: req.candidateId,
          // 用户可在安装界面改名；空串/纯空白视为「沿用站点名称」，交给管线回落。
          ...(req.name ? { name: req.name } : {}),
          // session 决定去哪个存储取图标 cookie；用发起方的那个最接近用户预期。
          session: event && typeof event === 'object' && 'sender' in event
            ? (event as { sender: WebContents }).sender.session
            : null,
          options
        }
        const result = await invoke('pwa.install', () => pwaInstaller.install(input), input)
        return enrichResult(result)
      }
    })
  }

  // ── 快捷方式 / 开机启动 ─────────────────────────────────────────────
  if (pwaShortcuts) {
    typedMain.handle(routes.pwaCreateShortcut, {
      requestSchema: S.createShortcut.request,
      responseSchema: S.createShortcut.response,
      handler: async (_e, req) => invoke(
        'pwa.createShortcut',
        () => pwaShortcuts.create(req.id, req.location),
        req
      )
    })

    typedMain.handle(routes.pwaRemoveShortcut, {
      requestSchema: S.removeShortcut.request,
      responseSchema: S.removeShortcut.response,
      handler: async (_e, req) => invoke(
        'pwa.removeShortcut',
        () => pwaShortcuts.remove(req.id, req.location),
        req
      )
    })

    typedMain.handle(routes.pwaSetRunOnStartup, {
      requestSchema: S.setRunOnStartup.request,
      responseSchema: S.setRunOnStartup.response,
      handler: async (_e, req) => {
        const result = await invoke(
          'pwa.setRunOnStartup',
          async () => {
            // 文件与标记由 setStartup 一起收敛（单一事实源），这里只组装响应。
            const outcome = asRecord(await pwaShortcuts.setStartup(req.id, !!req.enabled))
            return {
              ok: !!outcome.ok,
              reason: outcome.reason,
              app: outcome.ok ? pwaService.get(req.id) : undefined
            }
          },
          req
        )
        return enrichResult(result)
      }
    })
  }

  // ── 应用窗口（P4）──────────────────────────────────────────────────
  if (pwaRuntime) {
    typedMain.handle(routes.pwaLaunch, {
      requestSchema: S.launch.request,
      responseSchema: S.launch.response,
      handler: async (_e, req) => invoke('pwa.launch', () => pwaRuntime.launch(req.id), req)
    })

    typedMain.handle(routes.pwaNavigate, {
      requestSchema: S.navigate.request,
      responseSchema: S.navigate.response,
      handler: async (event, req) => {
        try {
          return await pwaRuntime.navigate({
            appId: req.appId,
            action: req.action,
            url: req.url,
            zoom: req.zoom,
            sender: event && typeof event === 'object' && 'sender' in event ? (event as { sender: WebContents }).sender : null
          })
        } catch (err) {
          return { ok: false, reason: errorMessage(err) }
        }
      }
    })

    typedMain.handle(routes.pwaGetWindowState, {
      requestSchema: S.getWindowState.request,
      responseSchema: S.getWindowState.response,
      handler: async (_e, req) => {
        try {
          return { ok: true, state: pwaRuntime.getWindowState(req.appId) }
        } catch (err) {
          return { ok: false, reason: errorMessage(err) }
        }
      }
    })

    if (senderScopedIpcMain && routes.pwaChrome && S.chrome) {
      senderScopedIpcMain.on(sendCh(routes.pwaChrome), (event, payload) => {
        const parsed = S.chrome.request.safeParse(payload)
        if (!parsed.success) return
        try {
          pwaRuntime.setChromeHeight({
            appId: parsed.data.appId,
            height: parsed.data.height,
            sender: event && event.sender
          })
        } catch (err) {
          warn('chrome 高度上报失败：', errorMessage(err))
        }
      })
    }
    /**
     * 应用窗专用能力通道（查找 / 缩放 / 浮层）。
     *
     * 为什么不能复用主窗口的 `find:*` / `zoom:*` / `layout` 通道：
     * PWA 应用窗不在 runtimeRegistry 里，`matchBySender` 解析不到它 —— 泛用路由会
     * **静默打到主窗口**（A 窗 Ctrl+F 开在主窗，是本项目踩过的串台）。所以这些通道
     * 必须按「sender 属于哪个应用窗」判归属，判不到就直接丢弃。
     *
     * 统一走 `featuresForSender`：它是 chrome / 网页 / 两个浮层四种 sender 的
     * 唯一归属判定入口，能力包不在（降级路径）时返回 null。
     */
    const pwaSend = <T extends { appId: string }>(route: string, schema: { request: PwaSchemaPort<T> }, handler: (features: PwaFeaturesPort, req: T, event: unknown) => void): void => {
      if (!senderScopedIpcMain || !route || !schema) return
      senderScopedIpcMain.on(sendCh(route), (event, payload) => {
        const parsed = schema.request.safeParse(payload)
        if (!parsed.success) return
        const req = parsed.data
        let features: PwaFeaturesPort | null = null
        try {
          features = (event && typeof event === 'object' && 'sender' in event
            ? pwaRuntime.featuresForSender((event as { sender: WebContents }).sender, req.appId)
            : null) as PwaFeaturesPort | null
        } catch (err) {
          warn('应用窗能力路由解析失败：', errorMessage(err))
          return
        }
        if (!features) return
        try {
          handler(features, req, event)
        } catch (err) {
          warn('应用窗能力通道失败：', errorMessage(err))
        }
      })
    }

    pwaSend(routes.pwaFindQuery, S.findQuery, (features, req) => {
      if (req.findNext) features.find.step(!!req.forward)
      else features.find.query({ text: req.text, forward: !!req.forward, findNext: false })
    })

    pwaSend(routes.pwaFindStop, S.findStop, (features, req) => {
      features.find.stop(req.action || 'clearSelection')
    })

    pwaSend(routes.pwaFindClose, S.findClose, (features) => {
      features.find.close()
    })

    // 菜单里的「查找」与 Ctrl+F 同一条路径：`toggle()` 已开且可见时只聚焦输入框，
    // 因此菜单反复点不会出现「开了又关」的闪烁。
    pwaSend(routes.pwaFindToggle, S.findToggle, (features) => {
      features.find.toggle()
    })

    pwaSend(routes.pwaZoomStep, S.zoomStep, (features, req) => {
      features.zoom.step(Number(req.delta) || 1)
    })

    pwaSend(routes.pwaZoomReset, S.zoomReset, (features) => {
      features.zoom.reset()
    })

    pwaSend(routes.pwaOverlayDisplay, S.overlayDisplay, (features, req) => {
      features.overlays.applyDisplay(req.name, {
        width: req.width,
        height: req.height,
        position: req.position,
        align: req.align,
        valign: req.valign,
        margin: req.margin,
        interactive: req.interactive
      })
    })

    pwaSend(routes.pwaOverlayHide, S.overlayHide, (features, req) => {
      features.overlays.hideFloat(req.name)
    })

    pwaSend(routes.pwaOverlayReady, S.overlayReady, (features) => {
      features.overlays.relayout()
    })
  }
  if (pwaUpdater) {
    typedMain.handle(routes.pwaUpdate, {
      requestSchema: S.update.request,
      responseSchema: S.update.response,
      handler: async (_e, req) => invoke('pwa.update', () => pwaUpdater.update(req.id), req)
    })

    typedMain.handle(routes.pwaCheckUpdates, {
      requestSchema: S.checkUpdates.request,
      responseSchema: S.checkUpdates.response,
      handler: async (_e, req) => invoke(
        'pwa.checkUpdates',
        () => pwaUpdater.checkAll(req || {}),
        req || null
      )
    })
  }

  // ── 卸载（P6）───────────────────────────────────────────────────────
  if (pwaUninstaller) {
    typedMain.handle(routes.pwaUninstall, {
      requestSchema: S.uninstall.request,
      responseSchema: S.uninstall.response,
      handler: async (_e, req) => invoke('pwa.uninstall', () => pwaUninstaller.uninstall(req.id), req)
    })
  }

  // ── 单向上报 ────────────────────────────────────────────────────────
  if (senderScopedIpcMain && pwaDetector && routes.pwaCandidate && S.candidate) {
    senderScopedIpcMain.on(sendCh(routes.pwaCandidate), (event, payload) => {
      if (!webPreloadAllowed(event)) return
      const parsed = S.candidate.request.safeParse(payload)
      if (!parsed.success) return
      const runtime = (() => {
        if (!runtimeRegistry) return null
        try { return runtimeRegistry.matchBySender(event && event.sender) } catch (_) { return null }
      })()
      // 线索可能来自任何标签（含子框架、已关闭标签）—— 探测层自己会静默丢弃。
      Promise.resolve(pwaDetector.handleCandidate({
        runtime,
        sender: event && event.sender,
        hints: parsed.data
      })).catch((err) => warn('处理安装线索失败：', errorMessage(err)))
    })
  }
}

