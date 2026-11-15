/**
 * IPC · chrome.identity 桥（扩展页 / MV3 service worker → 主进程 identity 服务）
 *
 * ── 为什么这条通道**不走 typedMain** ──────────────────────────────────
 * `typedMain` 是给 app 自己的渲染层用的：通道名来自 `IPC_ROUTES`，契约是 zod，
 * 发送方是 `hira://` / `file://` 的内部页面。identity 的调用方是**第三方扩展**
 * （`chrome-extension://<id>/…`），它既不在契约表里，也不该被当成内部页面 ——
 * 因此这里用裸 `ipcMain.handle`，并**自行完成三件事**：
 *   1. **身份来自发送方，不来自参数**：扩展 id 从 `senderFrame.url`（frame）或
 *      `serviceWorker.scope`（MV3 worker）推导；参数里的 id 一律不采信。
 *   2. **会话必须对得上**：只有「这条 IPC 的 session === 该 profile 扩展服务的
 *      session」时才允许调用 —— 否则 A profile 的扩展页可以借 B profile 的 token 缓存。
 *   3. **方法白名单**：只放 `chrome.identity` 的公开面，绝不把服务对象整个透出去。
 *
 * ── 为什么 service worker 要单独挂 handler ───────────────────────────
 * MV3 扩展的后台是 service worker：`ipcRenderer.invoke` 在 worker 里**不会**落到
 * 全局 `ipcMain`，而是落到 `serviceWorker.ipc`（ECE 的 `crx-msg` 也是这么接的，
 * 见 node_modules/@iamevan/electron-chrome-extensions/dist/cjs/index.js 的
 * RoutingDelegate）。所以这里对每个扩展 worker 逐个 `worker.ipc.handle`：
 *   · 只挂在「运行中的扩展 worker」上（`scope` 以 `chrome-extension://` 开头）；
 *   · 用 `Set` 去重 —— 同一个 worker 被重复 attach 会抛 "second handler"。
 *
 * ── 登录态推送 ──────────────────────────────────────────────────────
 * `chrome.identity.onSignInChanged` 是**主进程 → 扩展**的单向推送。目标有两类：
 *   · 扩展页面（`webContents`，按 URL 前缀匹配同一扩展）；
 *   · 运行中的扩展 service worker（`worker.send`）。
 * 事件源只有一个：identity 服务的 `sign-in-changed`（token 集合空 ↔ 非空），
 * 监听在**首次调用时懒绑定** —— 没调用过 identity 的扩展不需要任何常驻监听。
 */

import { ipcMain as defaultIpcMain, webContents, type IpcMain, type Session } from 'electron'

interface IdentityServicePort {
  identity?: {
    getAuthToken(extensionId: string, options: unknown): Promise<{ token?: unknown; expiresIn?: unknown } | null | undefined> | { token?: unknown; expiresIn?: unknown } | null | undefined
    launchWebAuthFlow(extensionId: string, options: unknown): Promise<unknown> | unknown
    removeCachedAuthToken(extensionId: string, token: string): unknown
    clearAllCachedTokens(extensionId: string): unknown
    events?: { on(event: 'sign-in-changed', listener: (payload: SignInPayload) => void): unknown }
  }
  session?: Session
}

interface SignInPayload { id?: string; signedIn?: boolean }
interface IdentityWorkerPort {
  scope?: string
  isDestroyed(): boolean
  send(channel: string, payload: unknown): unknown
  ipc: { handle(channel: string, listener: (event: { session?: Session }, payload: unknown) => unknown): unknown }
}
interface ServiceWorkersPort {
  getAllRunning(): Record<string, { scope?: unknown }>
  getWorkerFromVersionID(versionId: number): IdentityWorkerPort | null | undefined
  on(event: 'running-status-changed', listener: (details: { runningStatus?: string; versionId?: unknown }) => void): unknown
  removeListener?(event: 'running-status-changed', listener: (details: { runningStatus?: string; versionId?: unknown }) => void): unknown
}
interface IdentityIpcOptions {
  ipcMain?: IpcMain
  resolveExtensionServiceBySession?(session: Session): IdentityServicePort | null | undefined
  listExtensionServices?(): Array<IdentityServicePort | null | undefined>
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' ? value as Record<string, unknown> : {}
}

/** 窄调用通道：与 preload 的 `CALL_CHANNEL` 逐字一致。 */
const IDENTITY_CALL_CHANNEL = 'hira:identity:call'
/** 登录态推送通道：与 preload 的 `SIGN_IN_CHANNEL` 逐字一致。 */
const IDENTITY_SIGN_IN_CHANNEL = 'hira:identity:sign-in-changed'

const CHROME_EXTENSION_PREFIX = 'chrome-extension://'

/**
 * 允许扩展调用的方法白名单。
 *
 * 只放**会真正执行动作或返回凭据**的方法：
 *   · `getRedirectURL` / `getAccountStatus` 由 preload 本地同步回答（前者要求同步 API，
 *     后者是常量枚举），不必往返一次 IPC；
 *   · `getAccounts` / `getProfileUserInfo` 桌面壳没有 Google 账号体系，**不注册**，
 *     让扩展看到 "undefined" 去走自己的降级分支，而不是拿到一个假结果。
 */
const ALLOWED_METHODS = new Set<string>([
  'getAuthToken',
  'launchWebAuthFlow',
  'removeCachedAuthToken',
  'clearAllCachedAuthTokens'
])

/**
 * 从 URL / scope 里提取扩展 id。
 * @param {unknown} value
 * @returns {string} 不是 chrome-extension:// 时返回空串
 */
function extensionIdFromUrl(value: unknown): string {
  const text = String(value || '')
  if (!text.startsWith(CHROME_EXTENSION_PREFIX)) return ''
  const rest = text.slice(CHROME_EXTENSION_PREFIX.length)
  const end = rest.search(/[/?#]/)
  return end === -1 ? rest : rest.slice(0, end)
}

/**
 * 只保留可序列化、且语义明确的字段 —— 第三方扩展送来的 payload 不可信，
 * 多余键一律丢弃（zod 在这里不适用：这条通道的发送方不是内部渲染层）。
 * @param {unknown} value
 * @returns {string[]|undefined}
 */
function sanitizeScopes(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined
  return value.filter((item) => typeof item === 'string' && item).slice(0, 64)
}

/**
 * 执行一次 identity 调用。异常统一由调用方转成 `{ ok:false }`。
 * @param {any} service 扩展服务（infra）
 * @param {string} extensionId
 * @param {any} payload `{ method, payload }`
 * @returns {Promise<any>} 业务结果（preload 会按方法取字段）
 */
async function runIdentityCall(service: IdentityServicePort | null | undefined, extensionId: string, payload: unknown): Promise<unknown> {
  const identity = service && service.identity
  if (!identity) throw new Error('identity service unavailable')

  const payloadRecord = asRecord(payload)
  const method = payloadRecord.method
  if (typeof method !== 'string' || !ALLOWED_METHODS.has(method)) throw new Error(`unsupported identity method: ${String(method)}`)

  const args = asRecord(payloadRecord.payload)

  switch (method) {
    case 'getAuthToken': {
      const result = await identity.getAuthToken(extensionId, {
        interactive: args.interactive !== false,
        scopes: sanitizeScopes(args.scopes)
      })
      // preload 取 `value.token`；把 expiresIn 一并回传，扩展可用它安排续期。
      return { token: result?.token, expiresIn: result?.expiresIn }
    }
    case 'launchWebAuthFlow': {
      if (typeof args.url !== 'string' || !args.url) throw new Error('invalid url')
      const redirectUrl = await identity.launchWebAuthFlow(extensionId, {
        url: args.url,
        interactive: args.interactive !== false,
        // redirectUri 只允许字符串；真正的匹配仍由 identity 服务按语义判等。
        redirectUri: typeof args.redirectUri === 'string' && args.redirectUri ? args.redirectUri : undefined
      })
      return { redirectUrl }
    }
    case 'removeCachedAuthToken': {
      const token = typeof args.token === 'string' ? args.token : ''
      return { removed: identity.removeCachedAuthToken(extensionId, token) }
    }
    case 'clearAllCachedAuthTokens': {
      identity.clearAllCachedTokens(extensionId)
      return null
    }
    default:
      throw new Error(`unsupported identity method: ${String(method)}`)
  }
}

/**
 * 注册 identity 的 IPC 桥。
 *
 * @param {Object} options
 * @param {Electron.IpcMain} [options.ipcMain]
 * @param {(session: Electron.Session) => any|null} options.resolveExtensionServiceBySession
 *        按 IPC 发送方会话解析该 profile 的扩展服务（未加载 → null）。
 * @param {() => any[]} [options.listExtensionServices]
 *        当前已加载的扩展服务列表：注册时对它们的会话做一次 worker 挂载。
 * @returns {{ attachSession: (session: Electron.Session) => void, detachSession: (session: Electron.Session) => void, dispose: () => void }}
 */
export function registerIdentityIpc(options: IdentityIpcOptions = {}) : {
  attachSession: (session: Electron.Session) => void
  detachSession: (session: Electron.Session) => void
  dispose: () => void
} {
  const {
    ipcMain = defaultIpcMain,
    resolveExtensionServiceBySession,
    listExtensionServices
  } = options

  if (typeof resolveExtensionServiceBySession !== 'function') {
    throw new Error('registerIdentityIpc: resolveExtensionServiceBySession is required')
  }
  const resolveService = resolveExtensionServiceBySession

  /** 已做过 worker 挂载的会话（一个 profile 一个）。 */
  const attachedSessions = new Set<Session>()
  const sessionListeners = new Map<Session, (details: { runningStatus?: string; versionId?: unknown }) => void>()
  /** 已挂过 handler 的 worker 对象（Electron 会给同一个 worker 复用对象）。 */
  const attachedWorkers = new WeakSet<IdentityWorkerPort>()
  /** 已绑定 `sign-in-changed` 的 identity 服务（懒绑定，每个服务一次）。 */
  const boundIdentities = new WeakSet<object>()

  /**
   * 把登录态变化推给「同一个扩展」的所有宿主。
   * @param {Electron.Session} session
   * @param {{ id?: string, signedIn?: boolean }} payload
   */
  function broadcastSignIn(session: Session | null | undefined, payload: SignInPayload): void {
    const extensionId = payload && payload.id
    if (!session || !extensionId) return
    const prefix = `${CHROME_EXTENSION_PREFIX}${extensionId}/`

    // 1) 扩展页面
    try {
      for (const wc of webContents.getAllWebContents()) {
        if (!wc || wc.isDestroyed() || wc.session !== session) continue
        if (!String(wc.getURL() || '').startsWith(prefix)) continue
        wc.send(IDENTITY_SIGN_IN_CHANNEL, payload)
      }
    } catch (_) { /* 单个 contents 失效不影响其它宿主 */ }

    // 2) MV3 service worker（没有 webContents，只能按 scope 找运行中的 worker）
    const serviceWorkers = session.serviceWorkers as unknown as ServiceWorkersPort
    if (!serviceWorkers) return
    try {
      const running = serviceWorkers.getAllRunning() || {}
      for (const key of Object.keys(running)) {
        const info = running[key]
        if (!info || !String(info.scope || '').startsWith(prefix)) continue
        const worker = serviceWorkers.getWorkerFromVersionID(Number(key))
        if (!worker || worker.isDestroyed()) continue
        worker.send(IDENTITY_SIGN_IN_CHANNEL, payload)
      }
    } catch (_) { /* worker 正在退出等情况：跳过即可 */ }
  }

  /**
   * 懒绑定 identity 服务的登录态事件。
   * @param {Electron.Session} session
   * @param {any} service
   */
  function bindSignInEvents(session: Session, service: IdentityServicePort): void {
    const identity = service && service.identity
    if (!identity || !identity.events || boundIdentities.has(identity)) return
    boundIdentities.add(identity)
    identity.events.on('sign-in-changed', (payload) => broadcastSignIn(session, payload))
  }

  /**
   * 统一的业务入口：解析会话 → 校验来源 → 执行 → 包装结果。
   * @param {Electron.Session|null} session
   * @param {string} extensionId
   * @param {any} payload
   */
  async function handleCall(session: Session | null, extensionId: string, payload: unknown): Promise<{ ok: true; value: unknown } | { ok: false; error: string }> {
    try {
      if (!session) throw new Error('identity: missing session')
      if (!extensionId) throw new Error('identity: not an extension context')
      const service = resolveService(session)
      if (!service || service.session !== session) throw new Error('identity: extension service unavailable')
      // 首次调用即绑定：`sign-in-changed` 只可能由 identity 调用本身触发，
      // 因此不需要在注册时就给每个 profile 挂常驻监听。
      bindSignInEvents(session, service)
      const value = await runIdentityCall(service, extensionId, payload)
      return { ok: true, value }
    } catch (error) {
      return { ok: false, error: errorMessage(error) }
    }
  }

  /**
   * 给一个扩展 service worker 挂上 identity 通道。
   * @param {Electron.Session} session
   * @param {Electron.ServiceWorkerMain} worker
   */
  function attachWorker(session: Session, worker: IdentityWorkerPort | null | undefined): void {
    if (!worker || worker.isDestroyed() || attachedWorkers.has(worker)) return
    if (!String(worker.scope || '').startsWith(CHROME_EXTENSION_PREFIX)) return
    attachedWorkers.add(worker)
    try {
      worker.ipc.handle(IDENTITY_CALL_CHANNEL, (event, payload) => {
        // worker 的扩展 id 只认 scope（与 frame 认 URL 同一口径）。
        const extensionId = extensionIdFromUrl(worker.scope)
        const owningSession = (event && event.session) || session
        return handleCall(owningSession, extensionId, payload)
      })
    } catch (error) {
      // worker 恰好退出 / 已被别的实例挂过：不影响后续 worker。
      console.warn('[identity-ipc] attach service worker failed:', errorMessage(error))
    }
  }

  /**
   * 对某 profile 的会话做 worker 挂载（幂等）。
   * 已运行的扩展 worker 立即挂上；之后启动的靠 `running-status-changed`。
   * @param {Electron.Session} session
   */
  function attachSession(session: Session | null | undefined): void {
    if (!session || attachedSessions.has(session)) return
    attachedSessions.add(session)
    const serviceWorkers = session.serviceWorkers as unknown as ServiceWorkersPort
    if (!serviceWorkers) return

    const attachByVersionId = (versionId: unknown): void => {
      try {
        const worker = serviceWorkers.getWorkerFromVersionID(Number(versionId))
        if (worker) attachWorker(session, worker)
      } catch (_) { /* worker 已退出 */ }
    }

    // 注意：Electron 这个事件的第一个参数就是 details（不是 Event, details 两参），
    // 与 ECE 的用法一致（见 RoutingDelegate.addObserver）。
    const onRunningStatusChanged = (details: { runningStatus?: string; versionId?: unknown }) => {
      if (!details || details.runningStatus !== 'starting') return
      attachByVersionId(details.versionId)
    }
    sessionListeners.set(session, onRunningStatusChanged)
    serviceWorkers.on('running-status-changed', onRunningStatusChanged)

    // 注册时刻已经在跑的 worker（例如扩展先于 IPC 注册完成启动）。
    try {
      const running = serviceWorkers.getAllRunning() || {}
      for (const key of Object.keys(running)) {
        const info = running[key]
        if (!info || !String(info.scope || '').startsWith(CHROME_EXTENSION_PREFIX)) continue
        attachByVersionId(key)
      }
    } catch (_) { /* 拿不到列表就等后续事件 */ }
  }

  function detachSession(session: Session | null | undefined): void {
    if (!session) return
    const listener = sessionListeners.get(session)
    if (listener) {
      try {
        const serviceWorkers = session.serviceWorkers as unknown as ServiceWorkersPort
        if (serviceWorkers && typeof serviceWorkers.removeListener === 'function') {
          serviceWorkers.removeListener('running-status-changed', listener)
        }
      } catch (_) {}
    }
    sessionListeners.delete(session)
    attachedSessions.delete(session)
  }

  // ── frame（扩展页面）的全局通道 ─────────────────────────────────────
  ipcMain.handle(IDENTITY_CALL_CHANNEL, (event, payload) => {
    // senderFrame 在导航竞态下可能为 null：回退到 sender 的当前 URL。
    let url = ''
    try { url = (event.senderFrame && event.senderFrame.url) || '' } catch (_) {}
    if (!url) {
      try { url = event.sender.getURL() } catch (_) {}
    }
    const extensionId = extensionIdFromUrl(url)
    let session: Session | null = null
    try { session = event.sender.session } catch (_) {}
    return handleCall(session, extensionId, payload)
  })

  // 注册时把已经加载的 profile 会话补挂一遍（晚于扩展系统初始化的常见情况）。
  try {
    const services = typeof listExtensionServices === 'function' ? listExtensionServices() : []
    for (const service of services || []) {
      if (service && service.session) attachSession(service.session)
    }
  } catch (_) { /* 列表端口异常不阻断注册 */ }

  return {
    attachSession,
    detachSession,
    dispose() {
      try { ipcMain.removeHandler(IDENTITY_CALL_CHANNEL) } catch (_) {}
      for (const session of [...sessionListeners.keys()]) detachSession(session)
      attachedSessions.clear()
      sessionListeners.clear()
    }
  }
}

export { IDENTITY_CALL_CHANNEL, IDENTITY_SIGN_IN_CHANNEL }
