/**
 * 站点权限运行时。
 *
 * 负责 domain 权限服务、站点守卫、Electron request/check 适配器、跨窗口归属、
 * display-capture 准入与 session 生命周期。APPS 组合根只持有返回的窄端口。
 */

import type { App, BrowserWindow, DesktopCapturerSource, Session, WebContents } from 'electron'
import type { PermissionService } from '@hira-ng/domain-permission'
import { onWebContentsDestroyed } from '@hira-ng/infra-window'
import { attachDeviceSelectionHandlers, chooseDisplayMediaSource } from './media-devices'

interface RuntimeSpace { getCurrent(): { profileId?: string } | null | undefined }
interface RuntimeTabManager { getTabIdByWebContents(webContents: WebContents): string | null | undefined }
interface BrowserWindowRuntime {
  win: BrowserWindow
  tabManager?: RuntimeTabManager | null
  spaceRuntime?: RuntimeSpace | null
}

interface RuntimeRegistryPort {
  currentProfileId(): string
  currentOrNull(): BrowserWindowRuntime | null | undefined
  matchBySender(webContents: WebContents): BrowserWindowRuntime | null | undefined
  runWithProfile<T>(profileId: string, task: () => T): T
}

interface BrowserWindowsPort { all(): readonly BrowserWindowRuntime[] }

interface QrScanFramePort {
  allowCapture?(): boolean
  isOpen?(): boolean
  bounds?(): { x: number; y: number; width: number; height: number } | null
}

interface SiteGuardPort {
  onRulesChanged(change: unknown): void
  resetForScope(scopeId: number | string): void
  noteUserGesture(scopeId: number | string): void
}

interface OpenExternalPermissionsPort { confirm(webContents: WebContents, details: unknown): boolean | Promise<boolean> }

interface PermissionRuntimeDeps {
  app: App
  webContents: typeof import('electron').webContents
  browserWindows: BrowserWindowsPort
  runtimeRegistry: RuntimeRegistryPort
  db: unknown
  perProfileServices<T>(factory: (profileId: string) => T): T
  createPermissionService(db: unknown, options: {
    emit: (route: string, payload: Record<string, unknown>) => unknown
    profileId: string
    onChange(change: unknown): void
  }): PermissionService
  createSiteGuard(options: {
    permissionService: PermissionService
    runAsProfile<T>(profileId: string, task: () => T): T
    getProfileIdOfContents(webContents: WebContents): string
    isFeatureOn(featureId: string): boolean
  }): SiteGuardPort
  isActivationInput(input: unknown): boolean
  emit(route: string, payload: Record<string, unknown>, options?: { windowId?: number }): unknown
  featureMap: { resolveFeatureAvailability(registry: unknown): Record<string, unknown> }
  getPluginRegistry?(): unknown
  getQrScanFrame?(): QrScanFramePort | null | undefined
  getExtensionSession(): Session
  getActiveProfileId(): string
  registerHiraProtocol(session: Session): void
  CAPTURE_WAIT_MS: number
  qrScanCropRect(bounds: { x: number; y: number; width: number; height: number } | null): { x: number; y: number; width: number; height: number } | null
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

export function createPermissionRuntime({
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
  getPluginRegistry,
  getQrScanFrame,
  getExtensionSession,
  getActiveProfileId,
  registerHiraProtocol,
  CAPTURE_WAIT_MS,
  qrScanCropRect
}: PermissionRuntimeDeps) {
  let siteGuard: SiteGuardPort | null = null
  const _extPermissionRegistered = new Set<string>()
  const qrFrame = (): QrScanFramePort | null => getQrScanFrame?.() ?? null

  // ── 权限请求的「归属解析」────────────────────────────────────────────────
  // 网页权限请求到达时只带 scopeId（webContents id）。全应用只有这一层知道
  // window ↔ tab 拓扑，因此在 APPS 层解析成 { windowId, tabId } 供 renderer 打标签标记：
  //   domain 只管「谁在请求」，renderer 只管「画在哪」，中间的拓扑查询只有 main 能做。
  /**
   * @param {string|number|null|undefined} scopeId webContents id
   * @returns {{ windowId:number, tabId:string } | null} 解析不到返回 null
   */
  function resolvePermissionScope(scopeId: unknown): { windowId: number; tabId: string } | null {
    if (scopeId == null) return null
    const id = Number(scopeId)
    if (!Number.isFinite(id)) return null
    let wc: WebContents | null = null
    try { wc = webContents.fromId(id) ?? null } catch { return null }
    if (!wc || wc.isDestroyed()) return null
    for (const rt of browserWindows.all()) {
      if (!rt || !rt.win || rt.win.isDestroyed() || !rt.tabManager) continue
      const tabId = rt.tabManager.getTabIdByWebContents(wc)
      if (tabId) return { windowId: rt.win.id, tabId }
    }
    return null
  }

  /**
   * webContents 所属窗口的 profile id —— 权限链路的「数据分区解析点」。
   *
   * 为什么必须显式解析：两个权限钩子由 **webContents 原生事件**触发，
   * AsyncLocalStorage 里没有 IPC sender；而 permissionService 是 perProfileServices
   * 的 Proxy。不在这里进入 profile 作用域，所有请求都会落到 primary 窗口的 profile，
   * 与用户从自己窗口点「允许」时解析到的 profile 可能不是同一个 —— 权限库读写错位。
   * @param {Electron.WebContents|null|undefined} wc
   * @returns {string}
   */
  function profileIdOfContents(wc: WebContents | null | undefined): string {
    if (!wc) return runtimeRegistry.currentProfileId()
    const rt = runtimeRegistry.matchBySender(wc)
    try {
      const cur = rt && rt.spaceRuntime && rt.spaceRuntime.getCurrent()
      if (cur && cur.profileId) return String(cur.profileId)
    } catch (_) {}
    return runtimeRegistry.currentProfileId()
  }

  /**
   * 一条 pending 请求 → renderer 可见形状（补归属、去掉内部 scopeId）。
   * @param {object} item
   * @param {{windowId:number, tabId:string}|null} scope
   */
  function withPermissionScope(
    item: Record<string, unknown> | null | undefined,
    scope: { windowId: number; tabId: string } | null
  ): Record<string, unknown> {
    const { scopeId: _omit, ...rest } = item || {}
    return scope
      ? { ...rest, tabId: scope.tabId, windowId: scope.windowId }
      : { ...rest, tabId: null, windowId: null }
  }

  /**
   * 权限事件出口：
   *   · permission:request 命中标签 → 附带 windowId/tabId，且**只投递给所属窗口**
   *     （多窗口下键盘/浮层互不串台）；
   *   · 解析不到（扩展页 / 子窗口 / 已销毁）→ 回落全局广播，旧行为完全不变。
   *   · permission:cleared 只带 id，全局广播即可（各窗口按 id 移除）。
   */
  const emitPermission = (route: string, payload: Record<string, unknown>): unknown => {
    if (route !== 'permission:request') return emit(route, payload)
    const scope = resolvePermissionScope(payload && payload.scopeId)
    if (!scope) return emit(route, payload)
    const next = withPermissionScope(payload, scope)
    return emit(route, next, { windowId: scope.windowId })
  }

  /**
   * pendingList 的归属过滤端口（由 ipc-routes 注入进权限注册器）：
   *   · 每条补 windowId/tabId；
   *   · 只保留属于「当前调用窗口」的请求 —— 每个窗口的 navbar 只显示自己的；
   *   · 无法归属的请求对所有窗口可见（扩展页等），保持旧行为。
   * @param {Array<object>} list
   */
  const permissionPendingFilter = (list: unknown): Array<Record<string, unknown>> => {
    const rt = runtimeRegistry.currentOrNull()
    const selfWindowId = rt && rt.win ? rt.win.id : null
    // pending 表现在是进程级共享（跨 profile），必须按当前调用者的 profile 过滤，
    // 否则用户 B 的窗口会看到用户 A 的询问。
    const selfProfileId = runtimeRegistry.currentProfileId()
    const out: Array<Record<string, unknown>> = []
    for (const item of Array.isArray(list) ? list : []) {
      if (item && item.profileId && item.profileId !== selfProfileId) continue
      const scope = resolvePermissionScope(item && item.scopeId)
      if (scope && selfWindowId != null && scope.windowId !== selfWindowId) continue
      out.push(withPermissionScope(item, scope))
    }
    return out
  }

  // 站点权限按当前 profile 取实例：直接用默认实例会让所有用户共用一份权限
  const permissionService = perProfileServices((pid) => createPermissionService(db, {
    emit: emitPermission,
    profileId: pid,
    // 规则一被改写（含权限页的「清除」）就让站点守卫作废它的瞬时决定 ——
    // 否则「始终允许 / 始终阻止」清除后仍按老决定走，用户只能重启浏览器。
    onChange: (payload: unknown) => { try { if (siteGuard) siteGuard.onRulesChanged(payload) } catch (_) {} }
  }))

  // ── 站点守卫（页面行为型权限）────────────────────────────────────────────
  // 一次弹多个窗口 / 连续触发多次下载：规则三态（允许 / 阻止 / 询问）**复用权限表**，
  // 询问复用同一个浮层与四档决定，本模块只持有"限流计数 / 瞬时决定"这些状态。
  // 两条原生事件（标签弹窗、will-download）都没有 IPC sender → 判定前按发起方
  // webContents 进入 profile 作用域（与 attachPermissionHandlers 同一口径）。
  siteGuard = createSiteGuard({
    permissionService,
    runAsProfile: <T>(profileId: string, fn: () => T): T => runtimeRegistry.runWithProfile(profileId, fn),
    getProfileIdOfContents: profileIdOfContents,
    isFeatureOn
  })
  // 瞬时决定必须与**页面实例**同寿：主框架整页导航（含 reload）或标签销毁后作废，
  // 否则「允许一次」会变成变相的「始终允许」（实测：重载后照样一直弹）。
  // `did-navigate` 只在主框架跨文档导航时触发，同文档跳转（hash / pushState）不触发。
  app.on('web-contents-created', (_event, wc: WebContents) => {
    // id 在创建时取一次：销毁后读 `wc.id` 会抛 "Object has been destroyed"。
    const scopeId = wc.id
    const reset = () => { try { if (siteGuard) siteGuard.resetForScope(scopeId) } catch (_) {} }
    try {
      onWebContentsDestroyed(wc, reset)
      wc.on('did-navigate', reset)
      // 用户激活：只有"按下"那几类输入才算（判据在 site-guard#isActivationInput，
      // 这里先过滤 —— mousemove / 滚轮每帧都来，不能每次都进守卫）。
      // 有了它，用户亲手点链接开新标签不会累积进限流额度（主流浏览器同口径）。
      wc.on('input-event', (_e: unknown, inputEvent: { type?: unknown }) => {
        if (!isActivationInput(inputEvent && inputEvent.type)) return
        try { if (siteGuard) siteGuard.noteUserGesture(scopeId) } catch (_) {}
      })
    } catch (_) {}
  })
  // 对齐 Hira/RT：网页调用 navigator.permissions / Notification.requestPermission 等
  // 触发 setPermissionRequestHandler → 先查 DB 已存选择 → 否则发事件给 renderer 显示弹窗
  // 用户在 navbar 权限弹窗点击 Allow/Deny → IPC permission:respond → 回调 webContents
  //
  // ⚠️ Electron API 签名（重要）：
  // - setPermissionRequestHandler(wc, permission: string, callback: (granted:boolean)=>void)
  // - setPermissionCheckHandler(wc, permission: string, requestingOrigin: string)
  //   ↑ 后者无 callback！同步返回 boolean | null。错误地调用 requestingOrigin() 会抛 "callback is not a function"
  /**
   * 解析权限请求的发起 origin（对齐 Hira：优先用 Electron 给的 details.requestingUrl，
   * 它指向**真正发起请求的 frame**；wc.getURL() 只作兜底，它对 iframe 是错的）。
   * @returns {string} 形如 'https://example.com'；解析不出返回 ''（调用方按拒绝处理）
   */
  function originOf(
    requestingOrigin: string | null | undefined,
    wc: WebContents | null | undefined,
    details: { requestingUrl?: unknown } | null | undefined
  ): string {
    const candidates = [
      requestingOrigin,
      details && details.requestingUrl,
      (() => { try { return wc && typeof wc.getURL === 'function' ? wc.getURL() : '' } catch { return '' } })()
    ]
    for (const c of candidates) {
      if (!c || typeof c !== 'string') continue
      try {
        const u = new URL(c)
        if (u.origin && u.origin !== 'null') return u.origin
      } catch {}
    }
    return ''
  }

  // ── 外部协议（openExternal）授权记录 ────────────────────────────────────
  // 服务在 settingsService 就位后才构造（它依赖 domain-settings 的 KV），
  // 因此先占位；两个权限处理器都是**运行时**才被调用，届时必然已赋值。
  /** @type {ReturnType<typeof createOpenExternalPermissions>|null} */
  let openExternalPermissions: OpenExternalPermissionsPort | null = null

  /**
   * 处理一条 openExternal 权限请求。
   * 「已处理」= 返回 true（调用方必须立即 return，不再走通用权限流程）；
   * 无服务 / 无 externalURL 等异常情形返回 false，让调用方回落到既有逻辑 ——
   * 保持行为向后兼容，绝不因为这条新分支把别的权限请求吞掉。
   * @returns {boolean}
   */
  function handleOpenExternalPermission(
    wc: WebContents,
    details: unknown,
    callback: (allow: boolean) => void
  ): boolean {
    if (!openExternalPermissions) return false
    if (!details || typeof details !== 'object' || !('externalURL' in details) || !details.externalURL) return false
    Promise.resolve(openExternalPermissions.confirm(wc, details))
      .then((allow: boolean) => { try { callback(Boolean(allow)) } catch (e: unknown) { console.error('[open-external] callback failed:', errorMessage(e)) } })
      .catch((e: unknown) => {
        console.error('[open-external] confirm failed:', errorMessage(e))
        try { callback(false) } catch {}
      })
    return true
  }
  // ── 站点权限：Electron 适配层（对齐 Hira main/permissionManager.js）────────
  // Hira 用一对处理器承载全部权限语义：
  //   pagePermissionRequestHandler（L83）—— 异步 callback，决策 allow/block/ask
  //   pagePermissionCheckHandler（L388） —— **同步**返回 boolean，页面查询状态时走它
  // NG 分层不变：决策与持久化全在 domain-permission（零 electron 依赖），
  // 这里只做「Electron 参数 → domain 调用」的翻译 + session 绑定。
  //
  // Hira：fullscreen 直接放行（L84-87）
  const ALWAYS_ALLOW_PERMISSIONS = new Set(['fullscreen'])
  // 页面导航或销毁时，拒绝该页面尚未回答的请求，避免网页侧永久挂起。
  const requestScopesWatched = new Set<WebContents>()
  const deviceSelectionAttached = new WeakSet<Session>()
  function attachDeviceHandlersOnce(session: Session): void {
    if (!session || deviceSelectionAttached.has(session)) return
    deviceSelectionAttached.add(session)
    try {
      attachDeviceSelectionHandlers(session)
    } catch (error) {
      deviceSelectionAttached.delete(session)
      console.warn('[devices] attach handlers failed:', errorMessage(error))
    }
  }
  function watchRequestScope(wc: WebContents): void {
    if (!wc || requestScopesWatched.has(wc)) return
    requestScopesWatched.add(wc)
    const rejectForContents = () => {
      try { permissionService.rejectPendingForScope(wc.id) } catch {}
    }
    try {
      wc.on('did-start-navigation', (_e: unknown, _url: string, isInPlace: boolean, isMainFrame: boolean) => {
        if (isMainFrame && !isInPlace) rejectForContents()
      })
      onWebContentsDestroyed(wc, () => {
        requestScopesWatched.delete(wc)
        rejectForContents()
      })
    } catch {}
  }

  /**
   * 某个功能面此刻在主进程侧是否可用（§10.4）。
   *
   * 与渲染侧的 `features:availability` 端口**共用同一份 feature-map**，判据也完全一致
   * （只认"被显式关掉"，fail-open）。共用是必须的：若两边各判各的，
   * 会出现"界面把入口藏了、后端却照旧接受请求"（或反过来）的分叉。
   *
   * 注册中心是后台启动、晚于本运行时注入的，所以这里每次现取窄端口，不能读外层模块
   * 的局部变量；注册中心尚未就绪时 fail-open，避免启动竞态把插件的正常调用计成失败。
   * @param {string} featureId
   */
  function isFeatureOn(featureId: string): boolean {
    const registry = typeof getPluginRegistry === 'function' ? getPluginRegistry() : null
    return featureMap.resolveFeatureAvailability(registry)[featureId] !== false
  }

  /**
   * 权限引擎被**关掉**时，把"正在等用户回答"的请求一律拒绝。
   *
   * 为什么必须补这一刀（而不只是"以后不再弹"）：关引擎那一刻可能**已经**有请求
   * 登记在案（用户还没来得及点）。那些请求的 `callback` 只能由 `permission:respond` 触发，
   * 而那条能力此刻已被 `blockedCapabilities` 拦下 —— 于是**没有任何人还能回答它**，
   * 网页会一直停在"等待授权"。这比明确拒绝更糟，而且用户完全看不出原因。
   *
   * 幂等：没有待响应请求（或引擎本来就开着）时什么都不做。两个插件状态回调都会调它，
   * 因为"关掉"可能来自用户开关，也可能来自连环坏自动停用。
   */
  function closeOutPendingPermissionRequests() {
    if (isFeatureOn('permissions')) return
    try {
      const pending = typeof permissionService.listPendingRequests === 'function'
        ? permissionService.listPendingRequests()
        : []
      for (const item of pending) {
        if (!item || !item.id) continue
        // ⚠ 第三个参数 `persist=false` 是关键：这次拒绝是**系统替用户做的**，
        // 不能写进权限库 —— 否则会给该站点永久留下一条 "block" 规则，
        // 用户以后重新打开引擎会发现"这个网站怎么自己变拒绝了"，且再也说不清是谁改的。
        // 只拒绝**这一次**在等回答的请求，不改变任何已存的用户决定。
        try { permissionService.respondToRequest(item.id, false, false) } catch (_) {}
      }
      if (pending.length) console.log(`[permission] 引擎已停用，已拒绝 ${pending.length} 个待响应请求`)
    } catch (e) {
      console.warn('[permission] 关闭待响应请求失败（非致命）:', errorMessage(e))
    }
  }

  /**
   * 把「权限请求 / 权限查询」一对处理器绑到某个 session（对齐 Hira 的
   * session.defaultSession + app.on('session-created') 双注册语义）。
   * profile 切换 / 扩展 session 装配都复用它，避免两份实现漂移。
   * @param {Electron.Session} session
   */
  function attachPermissionHandlers(session: Session): void {
    if (!session || typeof session.setPermissionRequestHandler !== 'function') return

    session.setPermissionRequestHandler((wc, permission, callback, details) => {
      // 进入**发起请求的 webContents** 所属窗口的 profile 作用域：
      // 这是 webContents 原生事件，ALS 里没有 sender（见 profileIdOfContents）。
      runtimeRegistry.runWithProfile(profileIdOfContents(wc), () => {
      try {
        const permType = String(permission || 'unknown')

        // openExternal（mailto: / 自定义协议）：走独立询问 + 授权记录，不进通用权限表 ——
        // 「哪个网站打开哪个协议」是主进程独有的记录（见 main/open-external.js），
        // 通用权限表按 permission_type 存，装不下「协议」这一维。
        if (permType === 'openExternal' && handleOpenExternalPermission(wc, details, callback)) return

        // fullscreen：Hira 直接放行
        if (ALWAYS_ALLOW_PERMISSIONS.has(permType)) { callback(true); return }

        /**
         * display-capture（`getDisplayMedia`）：**只在扫码取景框开着时**放行。
         *
         * 这条放行换来的是"屏幕像素永不进主进程"——渲染层自己持一条屏幕流，
         * 用 canvas 裁出框内那一小块再解码，主进程只回两个矩形（见 `screen:frame-geometry`）。
         * 整屏 8MB 的回读与两次位图拷贝因此彻底消失（那是"拖框卡一下、网页跟着卡"的根因）。
         *
         * 为什么门槛是"框开着"而不是"谁在问"：取景框是**用户自己点出来的、看得见的**
         * 置顶窗口 —— 这是可见的用户意图，而不是某个页面在后台偷偷开流。框一关，
         * 这条通道立刻关上（连请求处理器也一起拒绝，见下面的 setDisplayMediaRequestHandler）。
         */
        const requestingUrl = details && typeof details.requestingUrl === 'string'
          ? details.requestingUrl
          : (() => { try { return wc.getURL() } catch { return '' } })()
        const internalCapture = requestingUrl.startsWith('file:') || requestingUrl.startsWith('hira:')
        if (permType === 'display-capture' && internalCapture) {
          callback(Boolean(qrFrame()?.allowCapture?.()))
          return
        }

        const origin = originOf(null, wc, details)
        if (!origin) { callback(false); return }
        watchRequestScope(wc)

        const decision = permissionService.resolveRequest(origin, permType)
        if (decision === 'allow') { callback(true); return }
        // 不支持的权限类型（如 Electron 的 'unknown'）→ 拒绝（对齐 Hira L358-361）
        if (decision === 'block' || decision === 'unsupported') { callback(false); return }

        /**
         * 剩下的只有 'ask' / 无记录 —— 这条路的**前提是"有个界面能问用户"**。
         * 权限引擎被禁用时那个界面不存在（Bell 与浮层都已收起），必须在这里收住。
         *
         * ⚠ 门禁位置是刻意**这么靠后**的，不能提前到 handler 开头：
         * 前面那些分支（openExternal / fullscreen / 库里已存的 allow·block）
         * 都**不需要界面**，提前拦会平白砍掉这些仍然正确的行为
         * （例如 fullscreen 会被一起拒掉、已存的"允许"规则会失效）。
         * 只有"需要问用户"这一段在引擎缺席时才真的无解。
         *
         * 为什么选"拒绝"而不是"放行"：权限请求是**网页在等一个答案**，
         * 登记一个永远等不到回答的请求会让它一直卡住 —— 比明确的拒绝更糟。
         * 而拒绝是权限语义里的**安全默认值**；放行等于替用户做了一个他没做过的决定，
         * 在"功能降级"场景下尤其不能这么干（降级不该顺手扩大权限）。
         */
        if (!isFeatureOn('permissions')) { callback(false); return }

        // 'ask' 或无记录：登记待响应请求 → 通知 renderer 弹窗 → 用户响应后回调
        permissionService.createRequest(origin, permType, (allow) => {
          try { callback(allow) } catch (e) {
            console.error('[permission] request callback failed:', errorMessage(e))
          }
        }, wc && wc.id)
      } catch (e) {
        console.error('[permission] request handler failed:', errorMessage(e))
        try { callback(false) } catch {}
      }
      })
    })

    // setPermissionCheckHandler：同步返回 boolean | null（⚠️ 无 callback 参数！）
    // 未落库的权限必须是 false。把 ask 翻译成 true 会让网页直接显示“已授予”，
    // 并在用户尚未表态时实际取得权限。
    /**
     * `getDisplayMedia` 的**源选择器** —— 这里决定了"渲染层自己抓屏"这条路能不能成立。
     *
     * 与 `qr.captureScreen`（插件能力）的分工：
     *   · 走过 `desktopCapturer` 那条：每一帧都要主进程回读整屏 8MB 再裁再拷 ——
     *     主进程被占住的那几十毫秒里，窗口落位、IPC、网页输入全是排队状态，
     *     用户看到的就是"**拖框卡一下、网页跟着卡**"；
     *   · 走这里：只把**一个屏幕源**交给 Chromium 自己的媒体管线，整屏像素从此
     *    只存在于渲染进程的 `video` 纹理里，主进程一帧都不碰。
     *
     * `thumbnailSize: {width:0, height:0}` 是必须的 —— 那是官方文档里"不需要缩略图
     * 时这么传，可省下抓取每个屏幕内容的时间"的写法。只取 `id` 用来认领目标屏。
     *
     * 准入判据与权限处理器一致（`getQrScanFrame().allowCapture()`：框开着，或刚请求过开框）——
     * 后者是必需的：渲染层为了保住瞬时用户激活，只能"先请求流、再开框"，
     * 请求到达时框常常还没建好。不满足就回 `{}` = 拒绝，调用方（渲染层的流式抓帧）
     * 会**自动回退**到 IPC 抓帧路径，功能不会因此消失。
     */
    if (typeof session.setDisplayMediaRequestHandler === 'function') {
      session.setDisplayMediaRequestHandler(async (request, callback) => {
        let settled = false
        const respond = (selection: Record<string, unknown>): void => {
          if (settled) return
          settled = true
          try { callback(selection) } catch (_) {}
        }
        const deny = (): void => respond({})
        try {
          /**
           * ① 只认**我们自己的界面**（`file://` / `hira://` 加载的 chrome、面板、取景框）。
           *
           * 少了这一条，授权宽限就成了"任意网页只要趁用户扫码时发起 `getDisplayMedia`
           * 就能拿到整屏"的窗口期 —— 判据必须同时回答"谁在问"，而不只是"现在准不准"。
           * 判定用请求页的 URL 而不是 origin：`file://` 页的 origin 是 `null`，
           * 拿它做白名单既写不出来也认不出。
           */
          const reqUrl = (request && request.frame && request.frame.url) ? String(request.frame.url) : ''
          if (!reqUrl.startsWith('file:') && !reqUrl.startsWith('hira:')) {
            const selected = await chooseDisplayMediaSource(request as {
              frame?: unknown
              audioRequested?: boolean
              videoRequested?: boolean
            })
            if (selected) respond(selected)
            else deny()
            return
          }
          /**
           * ② 等取景框出现（最多 `CAPTURE_WAIT_MS`）。
           *
           * 等的是**同一个用户动作的另一半**：点「扫码」→（本请求发出）→ 开框。
           * 换顺序是不行的（见 `captureArmedUntil` 的说明），所以只能在这里等。
           */
          const deadline = Date.now() + CAPTURE_WAIT_MS
          const frameOpen = (): boolean => Boolean(qrFrame()?.isOpen?.())
          while (!frameOpen()) {
            if (Date.now() >= deadline) { deny(); return }
            await new Promise((r) => setTimeout(r, 40))
          }
          const { desktopCapturer, screen } = require('electron') as typeof import('electron')
          const bounds = qrFrame()?.bounds?.() ?? null
          const wanted = bounds ? screen.getDisplayMatching(qrScanCropRect(bounds) || bounds) : screen.getPrimaryDisplay()
          const sources = await desktopCapturer.getSources({ types: ['screen'], thumbnailSize: { width: 0, height: 0 } })
          const source = (sources || []).find((s: DesktopCapturerSource) => String(s.display_id) === String(wanted && wanted.id)) || (sources || [])[0]
          if (!source) { deny(); return }
          respond({ video: source })
        } catch (e) {
          deny()
        }
      })
    }

    session.setPermissionCheckHandler((wc, permission, requestingOrigin, details) => {
      // 同步钩子同样按发起 webContents 进入 profile 作用域（见 profileIdOfContents）。
      // 返回值必须透传 —— 这是同步 boolean 查询，不能变成 Promise。
      return runtimeRegistry.runWithProfile(profileIdOfContents(wc), () => {
      try {
        const permType = String(permission || 'unknown')

        // 非主框架且跨域 → false（Hira L411-413）
        if (details && details.isMainFrame === false &&
            requestingOrigin && details.embeddingOrigin &&
            requestingOrigin !== details.embeddingOrigin) return false

        if (ALWAYS_ALLOW_PERMISSIONS.has(permType)) return true
        // 与 request handler 同一判据：只有取景框开着（或刚请求开框的那几毫秒）才有屏幕流
        if (permType === 'display-capture') {
          return Boolean(qrFrame()?.allowCapture?.())
        }

        const origin = originOf(requestingOrigin, wc, details)
        if (!origin) return false
        return permissionService.resolveRequest(origin, permType) === 'allow'
      } catch (e) {
        console.error('[permission] check handler failed:', errorMessage(e))
        return false
      }
      })
    })
  }

  try {
    attachDeviceHandlersOnce(getExtensionSession())
    attachPermissionHandlers(getExtensionSession())
    // 对齐 Hira：defaultSession 也挂同一套处理器（内部页 / 浮层 / 其它 webContents 兜底）
    try {
      const defaultSession = require('electron').session.defaultSession
      attachDeviceHandlersOnce(defaultSession)
      attachPermissionHandlers(defaultSession)
    } catch (_) {}
    console.log('[main] permission request/check handler registered')
    _extPermissionRegistered.add(getActiveProfileId() || 'default')
  } catch (e) {
    console.error('[main] setPermissionRequestHandler failed:', errorMessage(e))
  }
  // 对齐 Hira（permissionManager.js L441-444）：任何**新建** session 都挂同一套处理器。
  // profile 的 partition session 由 sessionsController 惰性创建，这条兜底保证
  // 「新开 profile / 新窗口用的 session」不会漏挂权限钩子（漏挂 = 该 session 的所有
  // 权限请求静默走 Chromium 默认拒绝）。
  app.on('session-created', (createdSession) => {
    try { attachDeviceHandlersOnce(createdSession) } catch (e) {
      console.error('[main] attach device handlers to new session failed:', errorMessage(e))
    }
    try { attachPermissionHandlers(createdSession) } catch (e) {
      console.error('[main] attach permission handlers to new session failed:', errorMessage(e))
    }
    // hira:// 同样按 session 注册 —— 内部页（bookmarks / history / downloads…）跑在
    // **标签所属的 session** 里，其图标（`hira://favicon/?url=`）与文档本身都要走这条
    // 协议。惰性创建的 profile / 无痕 partition 会话若漏注册，该 session 里的内部页
    // 就会出现「页面在、但图标全空 / 子资源 404」。与权限钩子同口径：新建即注册。
    try { registerHiraProtocol(createdSession) } catch (e) {
      console.error('[main] registerHiraProtocol to new session failed:', errorMessage(e))
    }
  })
  // 窗口关闭时拒绝所有待响应请求，避免 webContents 卡死。
  // 多窗口下必须是「最后一个窗口关闭」才全量拒绝 —— 关掉主窗口不该把别的窗口
  // 正在弹的权限询问一并拒掉。
  app.on('window-all-closed', () => { try { permissionService.rejectAllPending() } catch {} })

  function attachProfile(session: Session, profileId: string): boolean {
    const id = String(profileId || 'default')
    if (_extPermissionRegistered.has(id)) return false
    attachPermissionHandlers(session)
    _extPermissionRegistered.add(id)
    return true
  }

  function setOpenExternalPermissions(service: OpenExternalPermissionsPort | null): void {
    openExternalPermissions = service || null
  }

  return {
    attachProfile,
    closeOutPendingPermissionRequests,
    isFeatureOn,
    permissionPendingFilter,
    permissionService,
    setOpenExternalPermissions,
    siteGuard
  }
}

module.exports = { createPermissionRuntime }
