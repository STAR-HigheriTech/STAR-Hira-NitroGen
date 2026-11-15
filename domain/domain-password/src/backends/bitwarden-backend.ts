import { domainOf } from '../password-utils'
import type {
  BackendActions,
  PasswordBackend,
  PasswordBackendStatus,
  PasswordSuggestion,
  ProcessCliPort,
  SignInCredentials
} from '../types'

export const BITWARDEN_DOWNLOAD_LINKS: Readonly<Record<string, string>> = Object.freeze({
  win32: 'https://vault.bitwarden.com/download/?app=cli&platform=windows',
  darwin: 'https://vault.bitwarden.com/download/?app=cli&platform=macos',
  linux: 'https://vault.bitwarden.com/download/?app=cli&platform=linux'
})

export const BITWARDEN_INSTALL_MODE = 'file'

interface BitwardenOptions {
  cli?: ProcessCliPort | null
  localToolPath?: string
  platform?: string
}

type LoginState = 'unknown' | 'unauthenticated' | 'logged-in'

interface CodedError extends Error {
  code?: string
  stderr?: string
  stdout?: string
  timedOut?: boolean
}

export interface BitwardenBackend extends PasswordBackend {
  checkIfConfigured(): Promise<boolean>
  isUnlocked(): boolean
}

const NOT_LOGGED_IN_RE = /not logged in|invalid session|session (?:key )?(?:is )?invalid|vault is locked/i
const BAD_PASSWORD_RE = /invalid master password|username or password is incorrect|invalid password/i

function createError(code: string, message?: string): CodedError {
  return Object.assign(new Error(message || code), { code })
}

function errorText(error: unknown): string {
  const value = error as CodedError
  return `${String(value?.stderr || '')}\n${String(value?.message || '')}`.trim()
}

export function sanitizeDomain(input: unknown): string {
  const domain = domainOf(input)
  if (domain) return domain
  return String(input ?? '').replace(/[^a-zA-Z0-9.-]/g, '').replace(/^www\./, '')
}

export function parseItems(raw: unknown): PasswordSuggestion[] {
  let items: unknown
  try {
    items = JSON.parse(String(raw || '[]'))
  } catch {
    return []
  }
  if (!Array.isArray(items)) return []
  const result: PasswordSuggestion[] = []
  for (const item of items) {
    const login = item && typeof item === 'object' ? (item as { login?: unknown }).login : null
    if (!login || typeof login !== 'object') continue
    const value = login as { username?: unknown; password?: unknown }
    const username = typeof value.username === 'string' ? value.username : ''
    const password = typeof value.password === 'string' ? value.password : ''
    if (!username && !password) continue
    result.push({ username, password, manager: 'Bitwarden' })
  }
  return result
}

export function createBitwardenBackend(options: BitwardenOptions = {}): BitwardenBackend {
  const cli = options.cli || null
  const platform = options.platform || 'win32'
  const localToolPath = options.localToolPath || ''
  const inflight = new Map<string, Promise<PasswordSuggestion[]>>()

  let toolPath: string | null = null
  let probed = false
  let sessionKey: string | null = null
  let loginState: LoginState = 'unknown'
  let loginStateTask: Promise<LoginState> | null = null

  async function checkIfConfigured(): Promise<boolean> {
    if (toolPath) return true
    if (!cli) return false
    if (localToolPath && await cli.exists(localToolPath)) {
      toolPath = localToolPath
      return true
    }
    toolPath = await cli.resolveCommand('bw')
    return Boolean(toolPath)
  }

  function refreshLoginState(): Promise<LoginState> {
    if (loginStateTask) return loginStateTask
    loginStateTask = (async () => {
      if (!cli || !toolPath) return loginState
      let stdout = ''
      try {
        const result = await cli.run(toolPath, ['status'], { timeoutMs: 10000 })
        stdout = result.stdout
      } catch {
        return loginState
      }
      let state = ''
      try {
        const parsed = JSON.parse(String(stdout || '{}')) as { status?: unknown }
        state = String(parsed?.status || '')
      } catch {
        state = /"status"\s*:\s*"(\w+)"/.exec(String(stdout || ''))?.[1] || ''
      }
      if (state === 'unauthenticated') loginState = 'unauthenticated'
      if (state === 'locked' || state === 'unlocked') loginState = 'logged-in'
      return loginState
    })().finally(() => {
      loginStateTask = null
    })
    return loginStateTask
  }

  async function probe(force = false): Promise<boolean> {
    if (probed && !force) return Boolean(toolPath)
    if (force) toolPath = null
    probed = true
    try {
      const found = await checkIfConfigured()
      if (found) await refreshLoginState()
      return found
    } catch {
      return false
    }
  }

  function requireTool(): { cli: ProcessCliPort; command: string } {
    if (!cli || !toolPath) throw createError('bitwarden-not-configured', '未找到 Bitwarden CLI（bw）')
    return { cli, command: toolPath }
  }

  function requireSession(): string {
    if (!sessionKey) throw createError('bitwarden-locked', 'Bitwarden 保险库尚未解锁')
    return sessionKey
  }

  function translateError(error: unknown): CodedError {
    const merged = errorText(error)
    const source = error as CodedError
    if (NOT_LOGGED_IN_RE.test(merged)) {
      sessionKey = null
      return createError('bitwarden-not-logged-in', merged || 'Bitwarden 尚未登录')
    }
    if (BAD_PASSWORD_RE.test(merged)) return createError('bitwarden-bad-password', merged || '主密码不正确')
    if (source?.timedOut) return createError('bitwarden-timeout', 'Bitwarden CLI 响应超时')
    return createError('bitwarden-cli-error', merged || 'Bitwarden CLI 调用失败')
  }

  async function loadSuggestions(command: string, domain: string): Promise<PasswordSuggestion[]> {
    const process = requireTool()
    try {
      const { stdout } = await process.cli.run(
        command,
        ['list', 'items', '--url', domain],
        { env: { BW_SESSION: requireSession() }, timeoutMs: 30000 }
      )
      return parseItems(stdout).map((row) => ({ ...row, domain }))
    } catch (error) {
      const translated = translateError(error)
      if (translated.code === 'bitwarden-not-logged-in') throw translated
      console.error('[domain-password] Bitwarden 查询失败:', translated.message)
      return []
    }
  }

  async function forceSync(): Promise<void> {
    const process = requireTool()
    try {
      await process.cli.run(process.command, ['sync'], {
        env: { BW_SESSION: requireSession() },
        timeoutMs: 60000
      })
    } catch (error) {
      throw translateError(error)
    }
  }

  async function unlockStore(password: string): Promise<boolean> {
    const process = requireTool()
    if (!password) throw createError('bitwarden-password-required', '请输入主密码')
    if (loginState === 'unauthenticated') {
      throw createError('bitwarden-not-logged-in', '尚未登录 Bitwarden 账号，请先用 API Key 登录')
    }
    let stdout = ''
    try {
      const result = await process.cli.run(
        process.command,
        ['unlock', '--raw', '--passwordenv', 'BW_PASSWORD'],
        { env: { BW_PASSWORD: password }, timeoutMs: 30000 }
      )
      stdout = result.stdout
    } catch (error) {
      throw translateError(error)
    }
    const key = stdout.trim()
    if (!key) throw createError('bitwarden-unlock-empty', '解锁失败：CLI 没有返回会话密钥')
    sessionKey = key
    loginState = 'logged-in'
    try {
      await forceSync()
    } catch {
      // 离线缓存仍可用
    }
    return true
  }

  async function signIn(credentials: SignInCredentials = {}): Promise<boolean> {
    const process = requireTool()
    const clientId = String(credentials.clientId ?? '').trim()
    const clientSecret = String(credentials.clientSecret ?? '').trim()
    if (!clientId || !clientSecret) {
      throw createError('bitwarden-credentials-required', '请填写 Client ID 与 Client Secret')
    }
    try {
      await process.cli.run(process.command, ['logout'], { timeoutMs: 10000 })
    } catch {
      // 本来就没登录
    }
    sessionKey = null
    try {
      await process.cli.run(process.command, ['login', '--apikey'], {
        env: { BW_CLIENTID: clientId, BW_CLIENTSECRET: clientSecret },
        timeoutMs: 30000
      })
    } catch (error) {
      throw translateError(error)
    }
    loginState = 'logged-in'
    return true
  }

  function getStatus(): PasswordBackendStatus {
    const found = Boolean(toolPath)
    if (found && loginState === 'unknown') void refreshLoginState()
    const actions: BackendActions = { sync: true }
    return {
      configured: found,
      toolFound: found,
      displayName: 'Bitwarden',
      unlocked: sessionKey !== null,
      signInRequired: loginState === 'unauthenticated',
      installMode: BITWARDEN_INSTALL_MODE,
      downloadLink: BITWARDEN_DOWNLOAD_LINKS[platform] || BITWARDEN_DOWNLOAD_LINKS.linux,
      toolFileName: platform === 'win32' ? 'bw.exe' : 'bw',
      localToolPath,
      version: '',
      versionOk: found,
      minVersion: '',
      readOnly: true,
      signInLabel: '登录 Bitwarden 账号',
      signInHint: '在 Bitwarden 网页版「设置 → 安全 → 密钥」里创建 API Key；登录后仍需用主密码解锁。',
      signInFields: [
        { key: 'clientId', label: 'Client ID', type: 'text', placeholder: 'user.xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx' },
        { key: 'clientSecret', label: 'Client Secret', type: 'password' }
      ],
      unlockHint: '输入 Bitwarden 主密码以解锁本地保险库；解锁后本次运行期间可直接填充。',
      unlockedHint: '会话密钥仅保留在本次运行中，重启应用后需要重新解锁。',
      actions
    }
  }

  return {
    name: 'bitwarden',
    canWrite: false,
    isAvailable: () => Boolean(toolPath),
    checkIfConfigured,
    isUnlocked: () => sessionKey !== null,
    probe,
    getStatus,
    forceSync,
    unlockStore,
    signIn,
    sanitize: sanitizeDomain,

    async getSuggestions(hostname) {
      if (!toolPath) return []
      requireSession()
      const domain = sanitizeDomain(hostname)
      if (!domain) return []
      const current = inflight.get(domain)
      if (current) return current
      const task = loadSuggestions(toolPath, domain).finally(() => inflight.delete(domain))
      inflight.set(domain, task)
      return task
    },

    async saveCredential() { return false },
    async deleteCredential() { return false },
    async listCredentials() { return [] }
  }
}
