/**
 * extension-preload —— 扩展会话的**唯一一份** hira preload。
 *
 * 由两块能力合并而成（原先各注册一份，等于每个 frame 白交两份解析与执行税）：
 *   1. `chrome.identity` 桥（原 identity-preload.js）
 *   2. `chrome://favicon` 扩展页 DOM 兼容层（原 favicon-compat-preload.js）
 *
 * ── 为什么合并 ────────────────────────────────────────────────────
 * `session.registerPreloadScript({ type: 'frame' })` 的成本是**每个 frame** 付一次
 * （含每个 iframe）：脚本读取 + 编译 + 上下文创建。两份各自都要 `require('electron')`、
 * 各自算一次 `location.href`、各自走一次 `contextBridge.executeInMainWorld`。合并后
 * 只做一次；而两块能力的生效条件互不重叠（identity 认 worker + 扩展页，favicon 只认
 * 扩展页 DOM），合并不会改变任何行为。
 *
 * ── 与 ECE 的关系 ────────────────────────────────────────────────
 * ECE 4.9.x 只补 runtime / tabs / storage 等命名空间，**完全没有 identity**
 * （dist 内搜不到实现）。主进程服务（infra-extensions/src/identity.js）已经能完成
 * OAuth 流程，缺的只是「扩展的 `chrome.identity.*` → IPC → 主进程」这段桥。
 *
 * 注入策略与 ECE 完全同构（见 node_modules/.../dist/chrome-extension-api.preload.js）：
 *   1. identity 只在 `chrome-extension://` 页面与扩展 service worker 中生效；
 *      favicon 只在扩展页 DOM 中生效（worker 没有 DOM）—— 其它网页零影响；
 *   2. `contextBridge.exposeInMainWorld` 暴露**窄接口**（只给调用与登录态订阅，
 *      绝不把 ipcRenderer 整个交出去 —— 那等于把宿主全部 IPC 面暴露给第三方扩展）；
 *   3. `contextBridge.executeInMainWorld` 在主世界 patch —— 只序列化函数体，
 *      不携带闭包，因此两个安装器都必须**自包含**（只引用 `globalThis`）。
 *
 * ── chrome.identity 的扩展 id 从哪来 ──────────────────────────────
 * 主进程**不信任**参数里的 id，而是从 `senderFrame.url` 推导
 * （见 apps/app-main/src/main/ipc/identity.js）。这里的 id 只用于 `getRedirectURL`
 * 这个同步 API 的本地拼接 —— 公式与主进程 `getIdentityRedirectURL` 逐字一致。
 *
 * ── chrome://favicon 为什么不解析地址 ─────────────────────────────
 * Chrome 扩展经常把图标写成 `<img src="chrome://favicon/https://example.com">`。
 * Electron 没有实现 chrome://favicon 这份 WebUI 数据源，请求会直接失败；而 NG
 * **不能**再挂 `webRequest.onBeforeRequest` 重定向（广告拦截器已占用同一事件，且会让
 * 扩展的 chrome.webRequest 监听器全部失效 —— 完整论证见 shared-types/https-only.mjs）。
 * 所以只能改扩展页自己的 DOM：把它换成 `hira://favicon/?chrome=<原地址>`，
 * path / pageUrl / page_url / url 的解析规则**全部**在主进程
 * （shared-types/favicon-compat.mjs + hira-protocol#serveFavicon），这里多写一行
 * 解析就是在制造第二份会漂移的真源。
 *
 * 能力边界（如实记录）：
 *   · 只覆盖 `<img src>`；CSS `background-image: url(chrome://favicon/…)` 无法在
 *     DOM 层安全改写（样式表可能来自扩展自己的文件）；
 *   · 观察 → 改写发生在一次微任务内，极端情况下首个请求可能先失败再重发，
 *     用户感知为「图标稍后出现」，不会留下错误占位。
 *
 * ── 注册时机 ─────────────────────────────────────────────────────
 * 由 infra-extensions 在 ECE 构造之后注册（frame + service-worker 各一份），
 * 且**只在确有已启用扩展时**注册（无扩展的用户不再为每个 frame 支付这份税）。
 * Electron 按注册顺序执行 preload：ECE 的 preload 先跑、建好 `chrome.runtime`，
 * 本脚本随后 patch `chrome.identity`（脚本内另有轮询兜底）。
 */

import { ipcRenderer, contextBridge, webFrame, type IpcRendererEvent } from 'electron'

interface IdentityBridge {
  extensionId: string
  call(method: string, payload: unknown): Promise<unknown>
  subscribeSignIn(listener: (payload: { id: string; signedIn: boolean }) => void): void
}

interface ChromeRuntimeShim { lastError?: { message?: string } }
interface ChromeIdentityShim {
  getAuthToken?: (details?: unknown, callback?: (value: unknown) => void) => unknown
  launchWebAuthFlow?: (details?: unknown, callback?: (value: unknown) => void) => unknown
  removeCachedAuthToken?: (details?: unknown, callback?: (value: unknown) => void) => unknown
  clearAllCachedAuthTokens?: (details?: unknown, callback?: (value: unknown) => void) => unknown
  getRedirectURL?: (path?: unknown) => string
  getAccountStatus?: (details?: unknown, callback?: (value: unknown) => void) => unknown
  onSignInChanged?: {
    addListener(listener: (payload: { id: string; signedIn: boolean }) => void): void
    removeListener(listener: (payload: { id: string; signedIn: boolean }) => void): void
    hasListener(listener: unknown): boolean
    hasListeners(): boolean
  }
}
interface ChromeShim {
  runtime?: ChromeRuntimeShim
  identity?: ChromeIdentityShim
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** 窄调用通道：方法白名单在主进程侧二次校验。 */
const CALL_CHANNEL = 'hira:identity:call'
/** 登录态变化推送（token 集合空 ↔ 非空）。 */
const SIGN_IN_CHANNEL = 'hira:identity:sign-in-changed'

const href = (() => {
  try { return String(location.href) } catch (_) { return '' }
})()

/** 扩展页 或 扩展 service worker（identity 的生效范围）。 */
const inExtensionContext = process.type === 'service-worker' || href.startsWith('chrome-extension://')
/** 扩展页 DOM（favicon 兼容的生效范围；worker 没有 document）。 */
const isExtensionFrame = href.startsWith('chrome-extension://') && typeof document !== 'undefined'

/**
 * 把自包含安装器注入主世界。
 * @param {Function} func 无闭包的安装器
 * @param {string} tag 日志前缀
 */
function injectInMainWorld(func: () => unknown, tag: string): void {
  try {
    if (typeof contextBridge.executeInMainWorld === 'function') {
      contextBridge.executeInMainWorld({ func })
    } else if (webFrame && typeof webFrame.executeJavaScript === 'function') {
      // 老版本 Electron 的回退（仅 frame；service worker 没有 webFrame，直接跳过）。
      void webFrame.executeJavaScript(`(${func.toString()})();`).catch((error: unknown) => {
        console.error(`[${tag}] executeJavaScript fallback failed:`, errorMessage(error))
      })
    }
  } catch (error) {
    console.error(`[${tag}] executeInMainWorld failed:`, errorMessage(error))
  }
}

// ── 1. chrome.identity ───────────────────────────────────────────────
if (inExtensionContext) {
  const idMatch = /^chrome-extension:\/\/([^/?#]+)/.exec(href)
  const extensionId = idMatch ? idMatch[1] : ''

  contextBridge.exposeInMainWorld('__hiraIdentity', {
    /** 扩展 id（来自本帧 URL，主进程会再校验一次，不以此为准）。 */
    extensionId,

    /**
     * 调用主进程 identity 服务。
     * 返回 Promise：成功 resolve 业务结果，失败 reject Error（主世界据此设置 lastError）。
     * @param {string} method
     * @param {any} payload
     */
    call(method: string, payload: unknown) {
      return ipcRenderer.invoke(CALL_CHANNEL, { method, payload }).then((result: unknown) => {
        const reply = result && typeof result === 'object' ? result as { ok?: unknown; error?: unknown; value?: unknown } : null
        if (!reply || reply.ok !== true) {
          throw new Error(String(reply?.error || 'identity: call failed'))
        }
        return reply.value
      })
    },

    /**
     * 订阅登录态变化。回调跨世界传递（contextBridge 会代理函数），事件频率极低
     * （只在 token 集合空 ↔ 非空时触发），不影响日常流畅度。
     * @param {(payload: { id: string, signedIn: boolean }) => void} listener
     */
    subscribeSignIn(listener: (payload: { id: string; signedIn: boolean }) => void) {
      if (typeof listener !== 'function') return
      ipcRenderer.on(SIGN_IN_CHANNEL, (_event: IpcRendererEvent, payload: { id: string; signedIn: boolean }) => {
        try { listener(payload) } catch (_) { /* 扩展回调异常不能打断通道 */ }
      })
    }
  })

  /**
   * 主世界安装器 —— 必须**自包含**（executeInMainWorld 只序列化函数体，
   * 不携带闭包），因此这里只引用 `globalThis`。
   */
  function installIdentityNamespace() {
    const bridge = (globalThis as typeof globalThis & { __hiraIdentity?: IdentityBridge }).__hiraIdentity
    if (!bridge) return
    const identityBridge = bridge

    /**
     * 设置 `chrome.runtime.lastError`。
     * Chrome 的契约是「只在回调执行期间可读」：调用前置位、回调后清掉。
     * @param {string} message
     */
    function setLastError(chrome: ChromeShim, message: string | null): void {
      try {
        const runtime = chrome.runtime
        if (!runtime) return
        if (message) runtime.lastError = { message }
        else delete runtime.lastError
      } catch (_) { /* 只读属性：尽力而为，不因 lastError 失败而中断回调 */ }
    }

    /**
     * 把「Promise 版调用」包装成 Chrome 的双形态 API：
     * 传了 callback 就回调（并在回调期间设置 lastError），没传就返回 Promise。
     * @param {string} method
     * @param {(value: any) => any} select 从主进程结果里取回调实参
     */
    function makeApi(
      chrome: ChromeShim,
      method: string,
      select: (value: unknown) => unknown
    ): (details?: unknown, callback?: (value: unknown) => void) => unknown {
      return function (details?: unknown, callback?: (value: unknown) => void) {
        let payload = details
        if (typeof details === 'function') {
          callback = details as (value: unknown) => void
          payload = {}
        }
        const promise = Promise.resolve(identityBridge.call(method, payload || {})).then(select)
        if (typeof callback === 'function') {
          promise.then(
            (value) => {
              setLastError(chrome, null)
              try { callback(value) } catch (_) { /* 扩展自己的异常 */ }
            },
            (error) => {
              setLastError(chrome, errorMessage(error))
              try { callback(undefined) } catch (_) { /* 扩展自己的异常 */ }
            }
          )
          return undefined
        }
        return promise
      }
    }

    /** 装一次就够；`chrome.identity` 在此之前不存在（ECE 不提供）。 */
    function install() {
      const chrome = (globalThis as typeof globalThis & { chrome?: ChromeShim }).chrome
      if (!chrome) return false
      try {
        const identity = (chrome.identity || {}) as ChromeIdentityShim

        identity.getAuthToken = makeApi(chrome, 'getAuthToken', (value) => (value as { token?: unknown } | null)?.token)
        identity.launchWebAuthFlow = makeApi(chrome, 'launchWebAuthFlow', (value) => (value as { redirectUrl?: unknown } | null)?.redirectUrl)
        identity.removeCachedAuthToken = makeApi(chrome, 'removeCachedAuthToken', () => undefined)
        identity.clearAllCachedAuthTokens = makeApi(chrome, 'clearAllCachedAuthTokens', () => undefined)

        // 同步 API：公式与主进程 identity.js#getIdentityRedirectURL 逐字一致。
        // 走本地计算而不是同步 IPC —— getRedirectURL 可能被扩展在启动路径上调用，
        // 同步 IPC 会阻塞渲染线程（与本项目「极致跟手」的口径冲突）。
        identity.getRedirectURL = function (path?: unknown) {
          const id = identityBridge.extensionId
          if (!id) return ''
          const base = 'https://' + id + '.chromiumapp.org/'
          if (path === undefined || path === null || path === '') return base
          const value = String(path)
          return base + (value.charAt(0) === '/' ? value.slice(1) : value)
        }

        // 桌面壳没有 Google 账号体系：诚实返回 NOT_SIGNED_IN（Chrome 的合法枚举值），
        // 而不是伪造一个账号让扩展去做无意义的请求。
        identity.getAccountStatus = function (details?: unknown, callback?: (value: unknown) => void) {
          if (typeof details === 'function') callback = details as (value: unknown) => void
          const result = 'NOT_SIGNED_IN'
          if (typeof callback === 'function') {
            setLastError(chrome, null)
            try { callback(result) } catch (_) {}
            return undefined
          }
          return Promise.resolve(result)
        }

        // onSignInChanged：主世界维护本地监听集合，只向 preload 订阅一次。
        const signInListeners = new Set<(payload: { id: string; signedIn: boolean }) => void>()
        let subscribed = false
        const ensureSubscribed = () => {
          if (subscribed) return
          subscribed = true
          try {
            identityBridge.subscribeSignIn((payload: { id: string; signedIn: boolean }) => {
              for (const listener of Array.from(signInListeners)) {
                try { listener(payload) } catch (_) { /* 单个监听异常不影响其它监听 */ }
              }
            })
          } catch (_) {}
        }
        identity.onSignInChanged = {
          addListener(listener: (payload: { id: string; signedIn: boolean }) => void) {
            if (typeof listener !== 'function') return
            signInListeners.add(listener)
            ensureSubscribed()
          },
          removeListener(listener: (payload: { id: string; signedIn: boolean }) => void) {
            signInListeners.delete(listener)
          },
          hasListener(listener: unknown) {
            return signInListeners.has(listener as (payload: { id: string; signedIn: boolean }) => void)
          },
          hasListeners() {
            return signInListeners.size > 0
          }
        }

        Object.defineProperty(chrome, 'identity', {
          value: identity,
          enumerable: true,
          configurable: true
        })
        return true
      } catch (error) {
        console.error('[hira-identity] inject failed:', errorMessage(error))
        return false
      }
    }

    if (install()) return
    // 兜底：ECE 的 preload 若晚于本脚本执行，chrome 上的 API 面还没铺好。
    // 最多等 5s（100 × 50ms），超时后不再轮询 —— identity 缺失时扩展会走自己的降级分支。
    let tries = 0
    const timer = setInterval(() => {
      tries += 1
      if (install() || tries >= 100) clearInterval(timer)
    }, 50)
  }

  injectInMainWorld(installIdentityNamespace, 'hira-identity')
}

// ── 2. chrome://favicon 兼容（仅扩展页 DOM）───────────────────────────
if (isExtensionFrame) {
  /**
   * 主世界安装器 —— 同样必须自包含。
   *
   * 为什么在主世界而不是隔离世界：DOM 是共享的，隔离世界改写属性也能生效；但主世界
   * 还能顺带覆盖「用 `img.src = …` 属性赋值」的同源写法，且避免两套 DOM 包装器带来的
   * 时序差异。这里选择与 ECE / identity 相同的注入通道。
   */
  function installChromeFaviconCompat() {
    try {
      if (String(globalThis.location && globalThis.location.protocol) !== 'chrome-extension:') return
    } catch (_) {
      return
    }

    // 与 shared-types/favicon-compat.mjs#CHROME_FAVICON_QUERY_KEY 逐字一致。
    const PROXY_PREFIX = 'hira://favicon/?chrome='
    const CHROME_FAVICON_RE = /^chrome:\/\/(?:favicon|favicon2)(?:[/?#]|$)/i

    /**
     * 把一个元素的 src 换成代理地址。已经是代理地址的不会再匹配（避免自激循环）。
     * @param {Element|null} el
     */
    function rewrite(el: Node | null): void {
      if (!el || el.nodeType !== 1) return
      const element = el as Element
      const tag = String(element.tagName || '').toUpperCase()
      if (tag !== 'IMG') return
      const src = element.getAttribute('src')
      if (!src || !CHROME_FAVICON_RE.test(src)) return
      try {
        element.setAttribute('src', PROXY_PREFIX + encodeURIComponent(src))
      } catch (_) { /* 属性被冻结等极端情况：保持原样，不影响页面其它逻辑 */ }
    }

    /**
     * 扫描一棵子树里已有的 img（初始 HTML / 动态插入的片段）。
     * @param {ParentNode} root
     */
    function scan(root: ParentNode | null): void {
      if (!root || typeof root.querySelectorAll !== 'function') return
      const nodes = root.querySelectorAll('img[src]')
      for (let i = 0; i < nodes.length; i++) rewrite(nodes[i])
    }

    // 在 document 本身上观察：preload 在 document_start 执行，此时 documentElement
    // 可能还不存在，直接挂在 document 上可以同时覆盖「解析器插入」与「脚本插入」。
    const observer = new MutationObserver((records) => {
      for (let i = 0; i < records.length; i++) {
        const record = records[i]
        if (record.type === 'attributes') {
          rewrite(record.target)
          continue
        }
        const added = record.addedNodes
        for (let j = 0; j < added.length; j++) {
          const node = added[j]
          if (node && node.nodeType === 1) {
            rewrite(node)
            scan(node as ParentNode)
          }
        }
      }
    })
    observer.observe(document, { subtree: true, childList: true, attributes: true, attributeFilter: ['src'] })
    scan(document)
  }

  injectInMainWorld(installChromeFaviconCompat, 'hira-favicon-compat')
}
