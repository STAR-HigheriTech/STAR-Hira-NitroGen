/**
 * HTTP Basic / Proxy 认证弹窗管理器（对齐 RT `src/main/app/basic-auth.ts`）。
 *
 * ── 为什么必须有它 ────────────────────────────────────────────────
 * 不注册 `app.on('login')` 时，Electron 不会显示任何 UI：需要 Basic 认证的站点
 * （内网管理后台、Jenkins、旧版 API 文档等）会**直接 401 失败**，用户既看不到
 * 提示、也无从输入账号密码。
 *
 * ── 三个必须处理对的点 ─────────────────────────────────────────────
 * 1. **请求会挂起**：`login` 事件给了 callback，在它被调用前该请求一直处于挂起态。
 *    因此「窗口被用户直接关掉」「超时」「窗口创建失败」都必须调用 `callback()`
 *    取消 —— 否则这个请求会永久卡住（表现为页面一直转圈）。
 * 2. **并发不能串号**：多个标签可能同时触发认证。窗口必须回传 requestId 自证身份，
 *    主进程只认与当前请求 id 匹配的那一次提交。
 * 3. **一次只弹一个**：并发弹窗会让用户不知道哪个对应哪个站点，因此进入 FIFO 队列，
 *    前一个解决后再弹下一个。
 *
 * 本模块不认识 UI：窗口由 WindowFactory 创建，页面是 hira://http-auth。
 */

const { app } = require('electron')
const { createSubWindow } = require('@hira-ng/infra-window')
const { WINDOW_TYPES, getWindowConfig } = require('./window-config')
import type {
  AuthInfo,
  AuthenticationResponseDetails,
  BrowserWindow,
  Event,
  WebContents
} from 'electron'

/** 无人应答时自动取消，避免请求永久挂起。 */
const AUTH_TIMEOUT_MS = 90_000

interface HttpAuthEntry { id: string; callback: (username?: string, password?: string) => void; host: string; realm: string; schemeLabel: string; isProxy: boolean; win: BrowserWindow | null; timer: ReturnType<typeof setTimeout> | null; done: boolean }
interface HttpAuthOutcome { username?: string; password?: string; answered: boolean }
interface HttpAuthPayload { requestId?: unknown; username?: unknown; password?: unknown }

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object'
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function createHttpAuthManager() {
  let seq = 0
  /** 等待展示的请求（FIFO） */
  const queue: HttpAuthEntry[] = []
  /** 当前正在展示的请求（同一时刻至多一个） */
  let active: HttpAuthEntry | null = null

  function makeRequestId() {
    return `auth-${Date.now().toString(36)}-${(++seq).toString(36)}`
  }

  /**
   * 结束一个请求：清定时器 → 回传结果（或取消）→ 关窗口 → 展示下一个。
   * @param {object} entry
   * @param {{ username?: string, password?: string, answered: boolean }} outcome
   *   answered=false 表示「未作答」（超时 / 关窗 / 建窗失败）→ 必须取消，不能挂起
   */
  function finish(entry: HttpAuthEntry, outcome: HttpAuthOutcome): void {
    if (!entry || entry.done) return
    entry.done = true
    if (entry.timer) {
      clearTimeout(entry.timer)
      entry.timer = null
    }
    try {
      if (outcome.answered) entry.callback(String(outcome.username || ''), String(outcome.password || ''))
      else entry.callback()
    } catch (error) {
      console.error('[http-auth] callback failed:', errorMessage(error))
    }
    try {
      if (entry.win && !entry.win.isDestroyed()) entry.win.destroy()
    } catch (_) {}
    if (active === entry) active = null
    // 让出当前调用栈：finish 可能由窗口 closed 事件触发，立刻建新窗口会踩在销毁流程里
    setImmediate(() => showNext())
  }

  function showNext(): void {
    if (active || queue.length === 0) return
    const entry = queue.shift()
    if (!entry) return
    const cfg = getWindowConfig(WINDOW_TYPES.HTTP_AUTH)
    if (!cfg) {
      console.error('[http-auth] window type not configured, cancelling request')
      finish(entry, { answered: false })
      return
    }

    let win: BrowserWindow | null = null
    try {
      ;({ win } = createSubWindow({
        url: cfg.url,
        width: cfg.width,
        height: cfg.height,
        // 刻意不用 modal：认证弹窗绝不能锁死浏览器 —— 用户可能要去别的标签页查账号
        modal: false,
        frame: cfg.frame,
        alwaysOnTop: cfg.alwaysOnTop,
        skipTaskbar: cfg.skipTaskbar,
        resizable: cfg.resizable,
        showOnReady: cfg.showOnReady,
        title: '需要登录'
      }))
    } catch (error) {
      console.error('[http-auth] window creation failed:', errorMessage(error))
      finish(entry, { answered: false })
      return
    }
    if (!win) {
      finish(entry, { answered: false })
      return
    }

    entry.win = win
    active = entry
    // 用户直接关窗（含 Esc 之外的各种关闭路径）→ 视为取消，绝不挂起
    win.once('closed', () => finish(entry, { answered: false }))
    entry.timer = setTimeout(() => {
      console.warn('[http-auth] no response in time, cancelling request')
      finish(entry, { answered: false })
    }, AUTH_TIMEOUT_MS)
    if (entry.timer && typeof entry.timer.unref === 'function') entry.timer.unref()
  }

  /** app `login` 事件的处理体。 */
  function handleLogin(
    event: Event,
    _webContents: WebContents,
    _details: AuthenticationResponseDetails,
    authInfo: AuthInfo,
    callback: (username?: string, password?: string) => void
  ): void {
    if (typeof callback !== 'function') return
    // 必须 preventDefault：否则 Electron 会用它的默认行为（无 UI 直接判定失败）
    event.preventDefault()
    queue.push({
      id: makeRequestId(),
      callback,
      host: authInfo && authInfo.host ? String(authInfo.host) : '',
      realm: authInfo && authInfo.realm ? String(authInfo.realm) : '',
      schemeLabel: authInfo && authInfo.scheme ? String(authInfo.scheme).toUpperCase() : 'HTTP',
      isProxy: Boolean(authInfo && authInfo.isProxy),
      win: null,
      timer: null,
      done: false
    })
    showNext()
  }

  function attach(): void {
    app.on('login', handleLogin)
  }

  function detach(): void {
    app.removeListener('login', handleLogin)
  }

  /** 窗口就绪握手：顺带把本次请求的展示信息交给页面（省一次时序赌注）。 */
  function ready(): { requestId: string; host: string; realm: string; schemeLabel: string; isProxy: boolean } | null {
    if (!active) return null
    return {
      requestId: active.id,
      host: active.host,
      realm: active.realm,
      schemeLabel: active.schemeLabel,
      isProxy: active.isProxy
    }
  }

  function submit(payload: unknown): { ok: boolean } {
    const data = (isRecord(payload) ? payload : {}) as HttpAuthPayload
    const id = data.requestId ? String(data.requestId) : ''
    // 只认当前请求的 id：并发场景下防止把 A 站的凭据送给 B 站
    if (!active || active.id !== id) return { ok: false }
    finish(active, {
      username: data.username == null ? undefined : String(data.username),
      password: data.password == null ? undefined : String(data.password),
      answered: true
    })
    return { ok: true }
  }

  function cancel(payload: unknown): { ok: boolean } {
    const data = (isRecord(payload) ? payload : {}) as HttpAuthPayload
    const id = data.requestId ? String(data.requestId) : ''
    if (!active || active.id !== id) return { ok: false }
    finish(active, { answered: false })
    return { ok: true }
  }

  /** 退出前清空：所有挂起请求一律取消，绝不留下未回应的 callback。 */
  function dispose(): void {
    detach()
    const pending = [...queue]
    queue.length = 0
    if (active) pending.push(active)
    for (const entry of pending) finish(entry, { answered: false })
  }

  return { attach, detach, ready, submit, cancel, dispose }
}

module.exports = { createHttpAuthManager, AUTH_TIMEOUT_MS }
