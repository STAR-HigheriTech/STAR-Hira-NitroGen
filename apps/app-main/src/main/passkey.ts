import type {
  App,
  ConfigureWebAuthnOptions,
  Event,
  Session,
  SelectWebauthnAccountDetails
} from 'electron'
import type {
  PasskeyCapabilities,
  PasskeyPickerPayload
} from '@hira-ng/shared-types/src/passkey.mjs'

interface PasskeyPickerPort {
  (payload: PasskeyPickerPayload, onClosed: () => void): (() => void) | null
}

interface PendingPasskeyPick {
  callback: (credentialId?: string | null) => void
  close: (() => void) | null
  timer: ReturnType<typeof setTimeout> | null
  allowed: Set<string>
}

interface PasskeyControllerOptions {
  app: App
  openPicker: PasskeyPickerPort
  getSessions: () => readonly Session[]
  onSessionCreated: (listener: (session: Session) => void) => void
}

const PICK_TIMEOUT_MS = 2 * 60 * 1000

/**
 * WebAuthn / Passkey 平台认证器与账户选择器。
 *
 * Electron 负责把系统认证器返回的多账户摘要交给我们；这里只渲染一个无秘密的
 * 选择窗口，并把用户选择回传给同一个待处理请求。凭据、私钥和签名永远不进入
 * Hira 的存储层。
 */
function createPasskeyController({ app, openPicker, getSessions, onSessionCreated }: PasskeyControllerOptions) {
  let configured = false
  let touchId = false
  let configurationError = ''
  let disposed = false
  let requestSeq = 0
  const pending = new Map<string, PendingPasskeyPick>()
  const attachedSessions = new Set<Session>()

  function finish(requestId: string, credentialId?: string | null): boolean {
    const item = pending.get(requestId)
    if (!item) return false
    pending.delete(requestId)
    if (item.timer) clearTimeout(item.timer)
    const close = item.close
    item.close = null
    try {
      item.callback(credentialId)
    } catch (error) {
      console.warn('[passkey] selection callback failed:', error instanceof Error ? error.message : String(error))
    }
    try {
      close?.()
    } catch {}
    return true
  }

  function cancelAll(): void {
    for (const requestId of [...pending.keys()]) finish(requestId, null)
  }

  function configurePlatformAuthenticator(): void {
    // configureWebAuthn 只为 macOS Touch ID 提供平台认证器配置；Windows Hello
    // 由 Chromium 直接接入，不能把“没有这个 macOS 方法”误判为初始化失败。
    if (process.platform !== 'darwin') {
      configured = true
      touchId = false
      configurationError = ''
      return
    }
    const options: ConfigureWebAuthnOptions = {}
    const keychainAccessGroup = String(process.env.HIRA_WEBAUTHN_KEYCHAIN_GROUP || '').trim()
    if (keychainAccessGroup) {
      options.touchID = {
        keychainAccessGroup,
        promptReason: '使用 Passkey 登录 $1'
      }
      touchId = true
    }
    try {
      if (typeof app.configureWebAuthn !== 'function') {
        throw new Error('当前 Electron 运行时未提供 macOS WebAuthn 配置接口')
      }
      app.configureWebAuthn(options)
      configured = true
    } catch (error) {
      configurationError = error instanceof Error ? error.message : String(error)
      configured = false
      touchId = false
      console.warn('[passkey] configureWebAuthn failed:', configurationError)
    }
  }

  function onSelectAccount(
    _event: Event,
    details: SelectWebauthnAccountDetails,
    callback: (credentialId?: string | null) => void
  ): void {
    if (disposed) {
      try { callback(null) } catch {}
      return
    }
    const accounts = Array.isArray(details.accounts) ? details.accounts : []
    const requestId = `pk-${Date.now().toString(36)}-${++requestSeq}`
    const payload: PasskeyPickerPayload = {
      requestId,
      relyingPartyId: String(details.relyingPartyId || ''),
      accounts: accounts.map((account) => ({
        credentialId: String(account.credentialId || ''),
        name: account.name ? String(account.name) : undefined,
        displayName: account.displayName ? String(account.displayName) : undefined
      })).filter((account) => account.credentialId)
    }
    if (payload.accounts.length === 0) {
      try { callback(null) } catch {}
      return
    }

    const item: PendingPasskeyPick = {
      callback,
      close: null,
      timer: null,
      allowed: new Set(payload.accounts.map((account) => account.credentialId))
    }
    pending.set(requestId, item)
    item.timer = setTimeout(() => finish(requestId, null), PICK_TIMEOUT_MS)
    try {
      item.close = openPicker(payload, () => finish(requestId, null))
      if (!item.close) finish(requestId, null)
    } catch (error) {
      console.warn('[passkey] open picker failed:', error instanceof Error ? error.message : String(error))
      finish(requestId, null)
    }
  }

  function attach(): void {
    configurePlatformAuthenticator()
    const attachSession = (session: Session) => {
      if (disposed || attachedSessions.has(session)) return
      session.on('select-webauthn-account', onSelectAccount)
      attachedSessions.add(session)
    }
    for (const session of getSessions()) attachSession(session)
    onSessionCreated(attachSession)
  }

  function select(requestId: unknown, credentialId: unknown): { ok: boolean; reason?: string } {
    const id = String(requestId || '')
    const item = pending.get(id)
    if (!item) return { ok: false, reason: '登录请求已结束或已超时' }
    if (credentialId == null || credentialId === '') {
      finish(id, null)
      return { ok: true }
    }
    const selected = String(credentialId)
    if (!item.allowed.has(selected)) return { ok: false, reason: '所选凭据不属于本次请求' }
    finish(id, selected)
    return { ok: true }
  }

  function capabilities(): PasskeyCapabilities {
    return {
      platform: process.platform,
      configured,
      accountPicker: !disposed,
      // Windows 由 Chromium 直接调用系统 WebAuthn；macOS 只有配置 Touch ID
      // 后才具备平台内建认证器，Linux 仍以外部安全密钥为主。
      platformAuthenticator: process.platform === 'win32' || touchId,
      touchId,
      ...(configurationError ? { error: configurationError } : {})
    }
  }

  function dispose(): void {
    if (disposed) return
    disposed = true
    cancelAll()
    for (const session of attachedSessions) {
      try { session.removeListener('select-webauthn-account', onSelectAccount) } catch {}
    }
    attachedSessions.clear()
  }

  return { attach, select, capabilities, dispose }
}

export { createPasskeyController }
