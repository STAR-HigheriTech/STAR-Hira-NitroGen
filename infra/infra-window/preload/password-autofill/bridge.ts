/**
 * bridge.js — 传输与依赖抽象层（插件解耦点）
 *
 * 自动填充引擎的核心模块（fields/fill/capture/generate…）不直接触碰
 * ipcRenderer / contextBridge，只依赖本模块提供的接口：
 *   - invoke(route, payload)        请求-响应
 *   - on(route, listener)           主进程推送事件订阅
 *   - getSuggestions / saveCaptured / listNeverSave / addNeverSave
 *   - hasActiveBackend()            是否启用密码后端（自动填充握手）
 *   - t(key, vars)                  本地化文案
 *   - menuProvider                  多凭据菜单插槽（可替换为原生窗口实现）
 *
 * 这样整套引擎可在不同宿主（Electron webview / BrowserView / 普通页面）
 * 上复用，只要提供一个实现本接口的 bridge 即可。
 */

import { STRINGS } from './constants.js'
import { PRELOAD_ROUTES } from '@hira-ng/shared-types/src/ipc-channels-preload'

export interface PasswordCredential { username: string; password: string }
interface BridgeProvider { invoke(route: string, payload?: unknown): Promise<unknown> | unknown }
type BridgeListener = (payload: unknown) => void
type BridgeSubscribe = (route: string, listener: BridgeListener) => () => void
type PasswordSuggestionReason = 'load' | 'focus' | 'manual'
type MenuProvider = (hostname: string, credentials: PasswordCredential[], anchorEl: HTMLElement | null) => void
const MAX_HOSTNAME_CHARS = 253
const MAX_USERNAME_CHARS = 512
const MAX_PASSWORD_CHARS = 8192

function makeBridge(provider: BridgeProvider, subscribe: BridgeSubscribe) {
  // provider: { invoke(route, payload) -> Promise }
  // subscribe: (route, listener) -> unsubscribe

  function invoke(route: string, payload?: unknown): Promise<unknown> {
    return Promise.resolve(provider.invoke(route, payload))
  }

  function on(route: string, listener: BridgeListener): () => void {
    return subscribe(route, listener)
  }

  // ── 密码后端接口 ──
  /**
   * @param {string} hostname
   * @param {'load'|'focus'|'manual'} [reason] 触发来源（主进程据此决定要不要弹解锁卡）
   */
  function getSuggestions(hostname: string, reason?: PasswordSuggestionReason): Promise<PasswordCredential[]> {
    return invoke(PRELOAD_ROUTES.passwordGetSuggestions, { hostname, reason: reason || 'manual' })
      .then((rows: unknown) => (Array.isArray(rows) ? rows as PasswordCredential[] : []))
      .catch(() => [])
  }

  function saveCaptured(hostname: string, username: string, password: string): Promise<unknown> {
    if (hostname.length > MAX_HOSTNAME_CHARS || username.length > MAX_USERNAME_CHARS || password.length > MAX_PASSWORD_CHARS) {
      return Promise.resolve(null)
    }
    return invoke(PRELOAD_ROUTES.passwordSave, { hostname, username, password })
      .catch(() => null)
  }

  function listNeverSave(): Promise<string[]> {
    return invoke(PRELOAD_ROUTES.passwordNeverSaveList)
      .then((list: unknown) => (Array.isArray(list) ? list as string[] : []))
      .catch(() => [])
  }

  function addNeverSave(hostname: string): Promise<unknown> {
    return invoke(PRELOAD_ROUTES.passwordNeverSaveAdd, { hostname })
      .catch(() => null)
  }

  /**
   * 上报捕获的登录凭据（主进程决定是否弹出保存提示浮层）。
   * @returns {Promise<boolean>} 是否成功上报
   */
  function reportCaptured(hostname: string, username: string, password: string): Promise<boolean> {
    if (!hostname || !password) return Promise.resolve(false)
    if (hostname.length > MAX_HOSTNAME_CHARS || username.length > MAX_USERNAME_CHARS || password.length > MAX_PASSWORD_CHARS) {
      return Promise.resolve(false)
    }
    return invoke(PRELOAD_ROUTES.passwordCaptured, { hostname, username, password })
      .then(() => true)
      .catch(() => false)
  }

  /**
   * 自动填充握手：判断密码后端是否已启用。
   * 依据领域服务的 backends 列表（active & available）。
   */
  function hasActiveBackend(): Promise<boolean> {
    return invoke(PRELOAD_ROUTES.passwordBackends)
      .then((backends: unknown) => {
        if (!Array.isArray(backends)) return false
        const active = backends.find((backend: unknown) =>
          !!backend && typeof backend === 'object' && (backend as { active?: unknown }).active === true)
        return !!(active && typeof active === 'object' && (active as { available?: unknown }).available === true)
      })
      .catch(() => false)
  }

  // ── 本地化 ──
  function t(key: string, vars?: Record<string, unknown> | null): string {
    const strings = STRINGS as Record<string, string>
    let str = (strings[key] != null ? strings[key] : key)
    if (vars && typeof vars === 'object') {
      for (const k of Object.keys(vars)) {
        str = str.replace(new RegExp(`\\{${k}\\}`, 'g'), String(vars[k]))
      }
    }
    return str
  }

  // ── 多凭据菜单插槽（可插拔：原生窗口 / 页内下拉）──
  // 由 index.js 注入默认实现（页内 DOM 下拉）；未来可替换为原生 BrowserWindow 菜单。
  let menuProvider: MenuProvider | null = null

  function setMenuProvider(providerFn: MenuProvider | null): void {
    menuProvider = providerFn
  }

  /**
   * 展示多凭据选择菜单。
   * 优先使用主进程的 overlay 原生浮层（与 searchbar 下拉一致、图层置顶）；
   * 若主进程通道不可用则回退到页内 DOM 下拉（menuProvider 插槽）。
   * @param {string} hostname
   * @param {Array<{username:string,password:string}>} credentials
   * @param {HTMLElement|null} anchorEl 锚点输入框（用于定位）
   */
  function showMenu(hostname: string, credentials: PasswordCredential[], anchorEl: HTMLElement | null): void {
    const rect = anchorEl && anchorEl.getBoundingClientRect
      ? anchorEl.getBoundingClientRect()
      : null
    const x = rect && rect.width ? Math.round(rect.left) : 24
    const y = rect && rect.height ? Math.round(rect.bottom) : 24

    let nativeOk = false
    invoke(PRELOAD_ROUTES.passwordAutofillMenu, { hostname, credentials, x, y })
      .then((result: unknown) => {
        nativeOk = !!result && typeof result === 'object' &&
          (result as { ok?: unknown }).ok !== false
      })
      .catch(() => {})
      .then(() => {
        if (!nativeOk && typeof menuProvider === 'function') {
          menuProvider(hostname, credentials, anchorEl)
        }
      })
  }

  /**
   * 请求关闭多凭据浮层。
   *
   * 浮层跑在**独立的 WebContentsView** 里，页面上发生的点击它感知不到，
   * 因此"点击别处关闭"必须由页面侧（tab preload）主动通知主进程。
   * 复用既有的 `password:overlay-commit` + `kind: 'menu-cancel'` 契约，
   * 不新增 IPC 通道，也顺势让主进程一起清理 pendingAutofillMenuSender。
   */
  function dismissMenu() {
    return invoke(PRELOAD_ROUTES.passwordOverlayCommit, { kind: 'menu-cancel' })
      .then(() => true)
      .catch(() => false)
  }

  return {
    invoke,
    on,
    getSuggestions,
    saveCaptured,
    reportCaptured,
    listNeverSave,
    addNeverSave,
    hasActiveBackend,
    t,
    setMenuProvider,
    showMenu,
    dismissMenu
  }
}

export { makeBridge }
