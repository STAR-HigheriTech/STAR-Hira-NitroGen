/**
 * 自动填充前的「确保已解锁 / 已登录」闸门。
 *
 * ════════════════════════════════════════════════════════════════════
 * 为什么需要它（对照 Hira 版 passwordManager.js）
 * ════════════════════════════════════════════════════════════════════
 * Hira 在页面请求凭据时是：
 *
 *   if (!manager.isUnlocked()) { await PasswordManagers.unlock(manager) }
 *   manager.getSuggestions(hostname).then(...)
 *
 * `unlock()` 弹主密码框 → 失败转登录表单 → 成功后**重试原请求**。
 * 于是「保险库锁着」对用户是一次输入，而不是一片空白。
 *
 * NG 侧此前没有这一跳：`password:get-suggestions` 直接问后端，后端
 * `requireUnlocked()` 抛错 → 域内回落到内置库 → 返回空数组 —— 用户点
 * 钥匙图标毫无反应，这正是「1Password / Bitwarden 不可用」的真实根因。
 *
 * ════════════════════════════════════════════════════════════════════
 * 职责边界
 * ════════════════════════════════════════════════════════════════════
 *   · 本模块只**编排**：读 `listBackends()` 的契约 → 让密码浮层显示
 *     「解锁 / 登录」卡 → 把用户输入交给 `passwordService.backendAction`。
 *   · 不含任何厂商分支（stage 由 `status.signInRequired` 决定，字段由
 *     `status.signInFields` 决定）；新增外部后端零改动。
 *   · 挂起期间主进程 `hideTransientPasswordOverlays` 必须能取消它（`cancelPending`），
 *     否则一个 Promise 会永久 pending。
 */

/** 后端约定的「还没登录」错误码：命中则把卡片切到登录表单（不是报错）。 */
export const SIGN_IN_REASONS = new Set<string>([
  'bitwarden-not-logged-in',
  'onepassword-not-signed-in'
])

/** 用户取消后对该站点的静默时长（避免每次聚焦输入框都弹卡）。 */
const CANCEL_SUPPRESS_MS = 60 * 1000

interface BackendStatus extends Record<string, unknown> {
  displayName?: unknown
  signInLabel?: unknown
  signInHint?: unknown
  signInFields?: unknown
  unlockHint?: unknown
  toolFound?: unknown
  versionOk?: unknown
  unlocked?: unknown
  signInRequired?: unknown
}

interface BackendEntry {
  name: string
  active?: boolean
  status?: BackendStatus | null
}

interface BackendActionResult {
  ok?: boolean
  reason?: string
  message?: string
}

interface AutofillUnlockDependencies {
  passwordService: {
    listBackends(): unknown
    backendAction(name: string, action: string, payload?: Record<string, unknown>): Promise<unknown>
  }
  sendOverlayEvent?(route: string, payload?: Record<string, unknown>): void
  events: { overlayShowPasswordUnlock: string; overlayHidePasswordUnlock: string }
  getWindowSize?(): [number, number] | null
  getViewport?(): { x: number; y: number; width: number; height: number } | null
}

interface PendingUnlock {
  resolve(): void
  promise: Promise<void>
  backendName: string
  hostname: string
}

interface UnlockRequest {
  kind: string
  password?: string
  clientId?: string
  clientSecret?: string
  email?: string
  secretKey?: string
  address?: string
}

interface EnsureUnlockedInput {
  reason?: 'load' | 'focus' | 'manual'
  hostname?: string
}

export function createAutofillUnlockFlow(deps: AutofillUnlockDependencies) {
  const { passwordService, sendOverlayEvent, events } = deps || {}
  // 事件名只有一份真源（ipc-channels.mjs），这里不手抄字面量。
  const EVENT_SHOW = events.overlayShowPasswordUnlock
  const EVENT_HIDE = events.overlayHidePasswordUnlock

  let pending: PendingUnlock | null = null
  let suppressedHost = ''
  let suppressedUntil = 0

  const send = (route: string, payload?: Record<string, unknown>): void => {
    try {
      if (typeof sendOverlayEvent === 'function') sendOverlayEvent(route, payload || {})
    } catch (_) { /* 浮层不可用不影响主流程 */ }
  }

  function windowSize(): [number, number] {
    try {
      const size = typeof deps.getWindowSize === 'function' ? deps.getWindowSize() : null
      if (Array.isArray(size) && size.length >= 2) {
        return [Number(size[0]) || 0, Number(size[1]) || 0]
      }
    } catch (_) { /* 忽略 */ }
    return [0, 0]
  }

  /**
   * 当前活跃且**带状态契约**的后端（内置库没有 status → 无需解锁，直接放行）。
   * @returns {{ name: string, status: any } | null}
   */
  function activeBackend(): { name: string; status: BackendStatus } | null {
    if (!passwordService || typeof passwordService.listBackends !== 'function') return null
    let list
    try { list = passwordService.listBackends() } catch (_) { return null }
    if (!Array.isArray(list)) return null
    const active = (list as BackendEntry[]).find((item) => item && item.active)
    if (!active || !active.status) return null
    return { name: active.name, status: active.status }
  }

  /** 把卡片推到密码浮层（stage: 'unlock' | 'sign-in'，message 为行内错误）。 */
  function present(backend: { name: string; status: BackendStatus } | null, stage: 'unlock' | 'sign-in', message: string): void {
    if (!backend) return
    const status = backend.status || {}
    const [width, height] = windowSize()
    let viewport: { x: number; y: number; width: number; height: number } | null = null
    try {
      const candidate = typeof deps.getViewport === 'function' ? deps.getViewport() : null
      if (
        candidate &&
        [candidate.x, candidate.y, candidate.width, candidate.height].every(Number.isFinite) &&
        candidate.width > 0 &&
        candidate.height > 0
      ) {
        viewport = {
          x: Math.round(candidate.x),
          y: Math.round(candidate.y),
          width: Math.round(candidate.width),
          height: Math.round(candidate.height)
        }
      }
    } catch (_) {}
    send(EVENT_SHOW, {
      backend: backend.name,
      displayName: status.displayName || backend.name,
      stage,
      hostname: pending ? pending.hostname : '',
      signInLabel: status.signInLabel || '',
      signInHint: status.signInHint || '',
      signInFields: Array.isArray(status.signInFields) ? status.signInFields : [],
      unlockHint: status.unlockHint || '',
      message: message || '',
      windowWidth: width,
      windowHeight: height,
      viewport
    })
  }

  function settlePending(): void {
    const current = pending
    pending = null
    if (current) {
      try { current.resolve() } catch (_) { /* 调用方已销毁 */ }
    }
  }

  /** 成功 / 取消：收卡 + 放行等待中的 getSuggestions。 */
  function finish(): void {
    send(EVENT_HIDE, {})
    settlePending()
  }

  /**
   * 取消挂起的解锁（切标签 / 窗口失焦 / 页面导航时由 hideTransient 调用）。
   * @param {{ hide?: boolean }} [options] hide=false 表示调用方已经发过隐藏事件
   */
  function cancelPending(options?: { hide?: boolean }): void {
    if (!pending) return
    if (!options || options.hide !== false) send(EVENT_HIDE, {})
    suppressedHost = pending.hostname || ''
    suppressedUntil = Date.now() + CANCEL_SUPPRESS_MS
    settlePending()
  }

  /**
   * 自动填充入口闸门：已解锁 / 无需解锁 → 立即放行；否则显示卡片并等待用户。
   *
   * @param {{ reason?: 'load'|'focus'|'manual', hostname?: string }} input
   * @returns {Promise<void>} 用户完成或取消后 resolve（永不 reject）
   */
  function ensureUnlocked(input?: EnsureUnlockedInput): Promise<void> {
    const reason = (input && input.reason) || 'manual'
    const hostname = String((input && input.hostname) || '')

    const backend = activeBackend()
    if (!backend) return Promise.resolve()
    const status = backend.status || {}
    // 未安装 / 版本过低：不做页面级打扰，安装引导在密码设置页
    if (!status.toolFound || !status.versionOk) return Promise.resolve()
    if (status.unlocked) return Promise.resolve()
    // 页面加载即弹卡太打扰（Hira 也只在用户交互路径上请求）
    if (reason === 'load') return Promise.resolve()

    if (pending) return pending.promise
    if (suppressedHost && suppressedHost === hostname && Date.now() < suppressedUntil) {
      return Promise.resolve()
    }

    let resolveWaiter: (() => void) | undefined
    const promise = new Promise<void>((resolve) => { resolveWaiter = resolve })
    // 重复请求复用同一个 Promise（并发聚焦只弹一次卡）
    pending = { resolve: resolveWaiter || (() => {}), promise, backendName: backend.name, hostname }
    present(backend, status.signInRequired ? 'sign-in' : 'unlock', '')
    return promise
  }

  /**
   * 浮层回传（overlay → main）。
   * @param {{ kind: string, password?: string, clientId?: string, clientSecret?: string, email?: string, secretKey?: string, address?: string }} req
   */
  async function settle(req: UnlockRequest): Promise<void> {
    if (!pending || !req) return
    if (req.kind === 'unlock-cancel') {
      cancelPending()
      return
    }
    const kind = req.kind === 'sign-in' ? 'sign-in' : 'unlock'
    const backendName = pending.backendName
    const payload = kind === 'unlock'
      ? { password: req.password }
      : {
          password: req.password,
          clientId: req.clientId,
          clientSecret: req.clientSecret,
          email: req.email,
          secretKey: req.secretKey,
          address: req.address
        }

    let result: BackendActionResult | null = null
    try {
      result = await passwordService.backendAction(backendName, kind, payload) as BackendActionResult
  } catch (error) {
    result = { ok: false, message: error instanceof Error ? error.message : String(error) }
    }
    if (result && result.ok) {
      finish()
      return
    }

    const backend = activeBackend()
    const reason = (result && result.reason) || ''
    // 主密码正确但根本没有会话 / 账号 → 直接把卡片换成登录表单
    if (kind === 'unlock' && SIGN_IN_REASONS.has(reason)) {
      present(backend, 'sign-in', '需要先登录账号，登录后会自动继续填充。')
      return
    }
    present(backend, kind, (result && result.message) || '操作失败，请重试。')
  }

  return {
    ensureUnlocked,
    settle,
    cancelPending,
    isPending: () => !!pending
  }
}

