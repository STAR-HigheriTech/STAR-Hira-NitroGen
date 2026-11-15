import type { BrowserWindow as BrowserWindowType, Session as ElectronSession } from 'electron'
/**
 * infra-extensions / identity —— `chrome.identity` 的主进程实现
 *
 * 为什么要有这个文件：ECE 4.9.x 的 dist 里**完全没有** identity（`grep identity` 零命中），
 * 扩展一旦调用 `chrome.identity.getAuthToken` / `launchWebAuthFlow` 就直接抛
 * `undefined is not a function`。参考实现（旧 Hira `main/extensions/identity.js`）
 * 的语义已经验证过可行，这里按 NG 的分层重写：
 *
 *   · 本文件只依赖 `electron`（BrowserWindow）与 Node 内置，**不 require domain** ——
 *     见 scripts/check-layers.cjs：`infra: ['infra','packages']`。清单从
 *     `createExtensionService` 注入的 `getManifest` 取，不在 infra 内部认识安装记录。
 *   · 纯函数（redirect URL 规范化 / fragment 与 query 解析 / Google OAuth URL 构造）
 *     与有状态服务分开导出：纯函数可被 preload 侧的同口径实现对照，也方便替换 provider。
 *   · 每个 profile 一个 `createIdentityService`（随 extensionService 生命周期），
 *     token 缓存与认证窗口都只属于该 profile —— profile 切换天然隔离，互不串号。
 *
 * 能力边界（对齐 Chrome / RT 的已验证语义）：
 *   - `getAuthToken`：读 manifest.oauth2，token 模式（response_type=token），
 *     fragment 优先、query 兜底；非交互只查缓存；提前 60s 判定过期。
 *   - `launchWebAuthFlow`：480×640 非模态窗口，5 分钟超时；拦截 will-navigate /
 *     will-redirect / did-navigate / did-navigate-in-page / did-fail-load 五路导航，
 *     用户关窗 = 取消。
 *   - `getRedirectURL(path?)`：`https://<extensionId>.chromiumapp.org/<path>`。
 *   - `removeCachedAuthToken` / `clearAllCachedAuthTokens`：按 token 值精确移除。
 *   - `onSignInChanged`：token 集合从空→非空、非空→空时各派发一次。
 *
 * 未实现（保持与 Chrome 一致的「不支持」而不是假成功）：
 *   - `getAccounts` / `getProfileUserInfo`：需要 Google 账号体系，桌面壳没有。
 *   - authorization code 模式（`response_type=code`）：Chrome 的 getAuthToken 本来就
 *     只走 token 模式；`parseCodeFromQuery` 留给扩展自行调用 launchWebAuthFlow 后解析。
 */

const { BrowserWindow } = require('electron')
const { EventEmitter } = require('events')

/** auth 窗口尺寸（对齐 Chrome / RT）。 */
const AUTH_WINDOW_WIDTH = 480
const AUTH_WINDOW_HEIGHT = 640
/** 认证窗口超时（5 分钟，对齐 RT）。 */
const AUTH_TIMEOUT_MS = 5 * 60 * 1000
/** token 提前判过期的窗口（60s，避免"拿到即过期"）。 */
const TOKEN_EXPIRY_SKEW_MS = 60 * 1000
/** 未给 expires_in 时的默认有效期（秒）。 */
const DEFAULT_EXPIRES_IN = 3600

interface OAuth2Manifest {
  client_id?: string
  scopes?: string[]
}

interface ExtensionManifest {
  oauth2?: OAuth2Manifest
}

interface IdentityServiceOptions {
  session: ElectronSession
  getManifest(extensionId: string): ExtensionManifest | null | undefined
}

interface CachedToken {
  token: string
  expiresAt: number
  obtainedAt: number
}

type TokenResult = { token: string; expiresIn: number } | { error: string }

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

// ── 纯函数 ──────────────────────────────────────────────────────────────

/**
 * redirect URL 的 path 规范化：Chrome 口径是「path 必须以 / 开头，base 已带 /」。
 * @param {unknown} path
 * @returns {string}
 */
function normalizeIdentityPath(path: unknown) : string {
  if (path === undefined || path === null || path === '') return ''
  const value = String(path)
  return value.charAt(0) === '/' ? value.slice(1) : value
}

/**
 * `chrome.identity.getRedirectURL(path?)`。
 * @param {string} extensionId
 * @param {unknown} [path]
 * @returns {string}
 */
function getIdentityRedirectURL(extensionId: string, path?: unknown) : string {
  return `https://${extensionId}.chromiumapp.org/${normalizeIdentityPath(path)}`
}

/**
 * 判断一次导航是否落在预期的 redirect URL 上。
 *
 * 为什么不用 `url.startsWith(redirectUri)`：`…/callback2` 会被 `…/callback` 误判。
 * Chrome 的语义是**协议 + 主机 + path 精确匹配**，query / fragment 任意。
 * @param {string} url
 * @param {string} redirectUri
 * @returns {boolean}
 */
function isIdentityRedirect(url: string, redirectUri: string) : boolean {
  if (!url || !redirectUri) return false
  try {
    const actual = new URL(url)
    const expected = new URL(redirectUri)
    if (actual.protocol !== expected.protocol) return false
    if (actual.hostname.toLowerCase() !== expected.hostname.toLowerCase()) return false
    const trim = (p: string) => p.replace(/\/+$/, '')
    return trim(actual.pathname) === trim(expected.pathname)
  } catch (_) {
    return false
  }
}

/**
 * 从 fragment 解析 access_token（OAuth implicit 模式）。
 * @param {string} redirectUrl
 * @returns {{token:string, expiresIn:number}|{error:string}|null}
 */
function parseTokenFromFragment(redirectUrl: string) : {token:string, expiresIn:number}|{error:string}|null {
  try {
    const parsed = new URL(redirectUrl)
    let fragment = parsed.hash || ''
    if (fragment.charAt(0) === '#') fragment = fragment.slice(1)
    if (!fragment) return null
    const params = new URLSearchParams(fragment)
    const error = params.get('error')
    if (error) return { error }
    const token = params.get('access_token')
    if (!token) return null
    const expiresIn = parseInt(params.get('expires_in') || String(DEFAULT_EXPIRES_IN), 10)
    return { token, expiresIn: Number.isFinite(expiresIn) && expiresIn > 0 ? expiresIn : DEFAULT_EXPIRES_IN }
  } catch (_) {
    return null
  }
}

/**
 * 从 query 解析 code（authorization code 模式）。
 * @param {string} redirectUrl
 * @returns {{code:string}|{error:string}|null}
 */
function parseCodeFromQuery(redirectUrl: string) : {code:string}|{error:string}|null {
  try {
    const parsed = new URL(redirectUrl)
    const error = parsed.searchParams.get('error')
    if (error) return { error }
    const code = parsed.searchParams.get('code')
    return code ? { code } : null
  } catch (_) {
    return null
  }
}

/**
 * 部分 provider（含 Google 的某些组合）会把 access_token 放在 query 里 ——
 * `parseTokenFromFragment` 的兜底，避免扩展拿到 redirect URL 却解析不出 token。
 * @param {string} redirectUrl
 * @returns {{token:string, expiresIn:number}|{error:string}|null}
 */
function parseTokenFromQuery(redirectUrl: string) : {token:string, expiresIn:number}|{error:string}|null {
  try {
    const parsed = new URL(redirectUrl)
    const error = parsed.searchParams.get('error')
    if (error) return { error }
    const token = parsed.searchParams.get('access_token')
    if (!token) return null
    const expiresIn = parseInt(parsed.searchParams.get('expires_in') || String(DEFAULT_EXPIRES_IN), 10)
    return { token, expiresIn: Number.isFinite(expiresIn) && expiresIn > 0 ? expiresIn : DEFAULT_EXPIRES_IN }
  } catch (_) {
    return null
  }
}

/**
 * 构造 Google OAuth2 认证 URL（token 模式）。
 * @param {string} clientId
 * @param {string|string[]} scopes
 * @param {string} redirectUri
 * @returns {string}
 */
function buildGoogleOAuthUrl(clientId: string, scopes: string|string[], redirectUri: string) : string {
  const scopeStr = (Array.isArray(scopes) ? scopes : [scopes]).filter(Boolean).join(' ')
  const params = new URLSearchParams({
    client_id: clientId,
    scope: scopeStr,
    response_type: 'token',
    redirect_uri: redirectUri
  })
  return `https://accounts.google.com/o/oauth2/auth?${params.toString()}`
}

/**
 * token 缓存的维度键：scopes 与顺序无关（Chrome 也按集合语义），空集合用 `_default`。
 * @param {unknown} scopes
 * @returns {string}
 */
function getIdentityCacheKey(scopes: unknown) : string {
  const list = Array.isArray(scopes) ? scopes : scopes ? [scopes] : []
  const normalized = list.map((s) => String(s)).filter(Boolean).sort()
  return normalized.length ? normalized.join(' ') : '_default'
}

// ── 有状态服务 ──────────────────────────────────────────────────────────

/**
 * @typedef {Object} IdentityServiceOptions
 * @property {Electron.Session} session 该 profile 的扩展会话（auth 窗口也用它）
 * @property {(extensionId:string) => any|null} getManifest 运行时 / 安装记录里的清单
 */



/**
 * 每个 extensionService 一个实例；生命周期与 profile 绑定。
 * @param {IdentityServiceOptions} options
 */
function createIdentityService(options: IdentityServiceOptions) {
  const { session: extSession, getManifest } = options
  const events = new EventEmitter()

  /**
   * `extensionId → Map<scopeKey, { token, expiresAt, obtainedAt }>`
   *
   * 只用内存：token 是**短期凭据**，落盘反而扩大泄漏面；Chrome 的 token 缓存同样是
   * 会话级的（重启后扩展会重新走一次静默 / 交互流程）。卸载时按扩展清理。
   */
  const tokenCache = new Map<string, Map<string, CachedToken>>()
  /** 正在进行的认证窗口：destroy / 卸载时统一收口，避免残留不可见窗口。 */
  const activeFlows = new Set<BrowserWindowType>()

  function cacheOf(extensionId: string): Map<string, CachedToken> {
    let map = tokenCache.get(extensionId)
    if (!map) {
      map = new Map()
      tokenCache.set(extensionId, map)
    }
    return map
  }

  function readCachedToken(extensionId: string, scopes: unknown): CachedToken | null {
    const entry = tokenCache.get(extensionId)?.get(getIdentityCacheKey(scopes))
    if (!entry) return null
    if (entry.expiresAt && Date.now() >= entry.expiresAt - TOKEN_EXPIRY_SKEW_MS) return null
    return entry
  }

  function writeCachedToken(extensionId: string, scopes: unknown, token: string, expiresIn: number): void {
    const now = Date.now()
    cacheOf(extensionId).set(getIdentityCacheKey(scopes), {
      token,
      expiresAt: now + (expiresIn || DEFAULT_EXPIRES_IN) * 1000,
      obtainedAt: now
    })
  }

  function hasAnyToken(extensionId: string): boolean {
    return (tokenCache.get(extensionId)?.size || 0) > 0
  }

  /**
   * 登录态变化的唯一出口。
   *
   * 口径：token 集合 `空 → 非空` 派发 signedIn=true，`非空 → 空` 派发 false。
   * 中间态（换一个 token、移除其中一个 scope）不派发 —— 账号并没有"登出"。
   * @param {string} extensionId
   * @param {boolean} signedIn
   */
  function dispatchSignInChanged(extensionId: string, signedIn: boolean) {
    try {
      events.emit('sign-in-changed', { id: extensionId, signedIn: Boolean(signedIn) })
    } catch (_) { /* 监听方异常不能影响 identity 调用本身 */ }
  }

  function rememberSignedIn(extensionId: string, wasEmptyBefore: boolean): void {
    if (wasEmptyBefore && hasAnyToken(extensionId)) dispatchSignInChanged(extensionId, true)
  }

  function maybeDispatchSignedOut(extensionId: string, wasNonEmptyBefore: boolean): void {
    if (wasNonEmptyBefore && !hasAnyToken(extensionId)) dispatchSignInChanged(extensionId, false)
  }

  /**
   * 打开认证窗口并等待 redirect。
   * @param {string} extensionId
   * @param {{ url?: string, redirectUri?: string, interactive?: boolean }} details
   * @returns {Promise<string>} redirect URL（含 token / code）
   */
  function launchWebAuthFlow(extensionId: string, details: { url?: string, redirectUri?: string, interactive?: boolean } = {}) : Promise<string> {
    return new Promise((resolve, reject) => {
      if (!details || typeof details.url !== 'string' || !details.url) {
        reject(new Error('Invalid url: url is required'))
        return
      }
      const url = details.url
      const interactive = details.interactive !== false
      if (!interactive) {
        // 非交互模式没有可复用的登录态来源（桌面壳没有 Google 账号体系），
        // 明确失败而不是假成功 —— 让扩展走自己的降级分支。
        reject(new Error('No interactive flag: non-interactive auth not available'))
        return
      }

      const redirectUri = details.redirectUri || getIdentityRedirectURL(extensionId)
      const authWin: BrowserWindowType = new BrowserWindow({
        width: AUTH_WINDOW_WIDTH,
        height: AUTH_WINDOW_HEIGHT,
        show: false,
        modal: false,
        frame: true,
        autoHideMenuBar: true,
        title: '登录授权',
        webPreferences: {
          // 用扩展所在 profile 的会话：OAuth 的 cookie / 已登录态跟着 profile 走，
          // 与标签页、扩展的隔离口径一致（RT 用 defaultSession 是单 profile 时代的写法）。
          session: extSession,
          contextIsolation: true,
          sandbox: true,
          nodeIntegration: false
        }
      })

      let settled = false
      let timeoutTimer: ReturnType<typeof setTimeout> | null = null

      const cleanup = () => {
        if (timeoutTimer) {
          clearTimeout(timeoutTimer)
          timeoutTimer = null
        }
        activeFlows.delete(authWin)
      }

      const finish = (result: string | null, error?: unknown): void => {
        if (settled) return
        settled = true
        cleanup()
        if (authWin && !authWin.isDestroyed()) authWin.destroy()
        if (error) reject(error)
        else if (result !== null) resolve(result)
        else reject(new Error('Authentication completed without a redirect URL'))
      }

      activeFlows.add(authWin)
      timeoutTimer = setTimeout(() => {
        finish(null, new Error('User authentication timed out'))
      }, AUTH_TIMEOUT_MS)

      const wc = authWin.webContents
      /** 五路导航监听共用同一个判定：命中即收口。 */
      const hit = (navigatedUrl: string): boolean => {
        if (!isIdentityRedirect(navigatedUrl, redirectUri)) return false
        finish(navigatedUrl)
        return true
      }

      wc.on('will-navigate', (event, url) => {
        if (hit(url)) event.preventDefault()
      })
      // 服务端 302 走 will-redirect（不会触发 will-navigate）—— 漏了它，
      // 大多数 OAuth provider 的 code 模式都会一直等到超时。
      wc.on('will-redirect', (event, url) => {
        if (hit(url)) event.preventDefault()
      })
      wc.on('did-navigate', (_event, url) => hit(url))
      // fragment 模式（Google token 流程）只是同文档内跳转，只有这个事件能看见。
      wc.on('did-navigate-in-page', (_event, url) => hit(url))
      wc.on('did-fail-load', (_event, _errorCode, errorDesc, validatedURL) => {
        // `.chromiumapp.org` 永远解析不到 IP：命中 redirect 的"加载失败"其实是成功。
        if (hit(validatedURL)) return
        finish(null, new Error(`Failed to load auth page: ${errorDesc}`))
      })
      authWin.once('ready-to-show', () => {
        if (!settled && !authWin.isDestroyed()) authWin.show()
      })
      // 用户关窗 = 取消（必须在 finish 里判 settled，destroy 自己也会触发 closed）。
      authWin.on('closed', () => {
        if (!settled) finish(null, new Error('User canceled the auth flow'))
      })

      authWin.loadURL(url).catch((error: unknown) => {
        finish(null, new Error(`Failed to load auth page: ${errorMessage(error) || 'unknown error'}`))
      })
    })
  }

  /**
   * `chrome.identity.getAuthToken`。
   * @param {string} extensionId
   * @param {{ interactive?: boolean, scopes?: string[] }} [details]
   * @returns {Promise<{ token: string, expiresIn: number }>}
   */
  async function getAuthToken(extensionId: string, details: { interactive?: boolean, scopes?: string[] } = {}) : Promise<{ token: string, expiresIn: number }> {
    const manifest = typeof getManifest === 'function' ? getManifest(extensionId) : null
    const oauth2 = manifest && manifest.oauth2
    if (!oauth2 || !oauth2.client_id) {
      throw new Error('OAuth2 is not configured in manifest')
    }

    const scopes = details.scopes || oauth2.scopes || []
    const interactive = details.interactive !== false

    const cached = readCachedToken(extensionId, scopes)
    if (cached) {
      return {
        token: cached.token,
        expiresIn: Math.max(0, Math.floor((cached.expiresAt - cached.obtainedAt) / 1000))
      }
    }
    if (!interactive) throw new Error('No cached token available')

    const redirectUri = getIdentityRedirectURL(extensionId)
    const authUrl = buildGoogleOAuthUrl(oauth2.client_id, scopes, redirectUri)
    const redirectUrl = await launchWebAuthFlow(extensionId, {
      url: authUrl,
      interactive: true,
      redirectUri
    })

    const parsed = parseTokenFromFragment(redirectUrl) || parseTokenFromQuery(redirectUrl)
    if (!parsed) throw new Error('Failed to parse token from redirect')
    if ('error' in parsed) throw new Error(`OAuth error: ${parsed.error}`)
    if (!parsed.token) throw new Error('No token in redirect')

    const wasEmpty = !hasAnyToken(extensionId)
    writeCachedToken(extensionId, scopes, parsed.token, parsed.expiresIn)
    rememberSignedIn(extensionId, wasEmpty)
    return { token: parsed.token, expiresIn: parsed.expiresIn }
  }

  /**
   * `chrome.identity.removeCachedAuthToken`：按 token 值精确移除（可能命中多个 scope 键）。
   * @param {string} extensionId
   * @param {string} token
   * @returns {boolean} 是否真的移除了
   */
  function removeCachedAuthToken(extensionId: string, token: string) : boolean {
    const map = tokenCache.get(extensionId)
    if (!map || !token) return false
    const wasNonEmpty = map.size > 0
    let removed = false
    for (const [key, entry] of map) {
      if (entry && entry.token === token) {
        map.delete(key)
        removed = true
      }
    }
    if (removed) maybeDispatchSignedOut(extensionId, wasNonEmpty)
    return removed
  }

  /**
   * `chrome.identity.clearAllCachedAuthTokens` / 卸载清理。
   * @param {string} extensionId
   */
  function clearAllCachedTokens(extensionId: string) {
    const map = tokenCache.get(extensionId)
    if (!map) return
    const wasNonEmpty = map.size > 0
    tokenCache.delete(extensionId)
    maybeDispatchSignedOut(extensionId, wasNonEmpty)
  }

  /** 卸载 / profile 销毁：关掉该扩展还没完成的认证窗口。 */
  function cleanup(extensionId: string): void {
    clearAllCachedTokens(extensionId)
    if (!extensionId) return
    for (const win of activeFlows) {
      try {
        if (!win.isDestroyed()) win.destroy()
      } catch (_) {}
    }
    activeFlows.clear()
  }

  return {
    events,
    /** 主进程侧纯函数端口（app 层 / 诊断用，避免第二份实现漂移）。 */
    getRedirectURL: getIdentityRedirectURL,
    launchWebAuthFlow,
    getAuthToken,
    removeCachedAuthToken,
    clearAllCachedTokens,
    /** 卸载某扩展时调用（清 token + 关掉它的认证窗口）。 */
    cleanup,
    /** 当前缓存里的 token 数（诊断用，不暴露 token 值）。 */
    getCachedTokenCount: (extensionId: string) => tokenCache.get(extensionId)?.size || 0,
    destroy() {
      for (const win of activeFlows) {
        try {
          if (!win.isDestroyed()) win.destroy()
        } catch (_) {}
      }
      activeFlows.clear()
      tokenCache.clear()
      events.removeAllListeners()
    }
  }
}

module.exports = {
  // 纯函数
  normalizeIdentityPath,
  getIdentityRedirectURL,
  isIdentityRedirect,
  parseTokenFromFragment,
  parseTokenFromQuery,
  parseCodeFromQuery,
  buildGoogleOAuthUrl,
  getIdentityCacheKey,
  // 服务
  createIdentityService
}
