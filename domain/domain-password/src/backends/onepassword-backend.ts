import { domainOf } from '../password-utils'
import type {
  BackendActions,
  DeviceStorePort,
  PasswordBackend,
  PasswordBackendStatus,
  PasswordSuggestion,
  ProcessCliPort,
  SignInCredentials
} from '../types'

export const ONEPASSWORD_MIN_VERSION = '2.2.0'
export const ONEPASSWORD_SESSION_TTL_MS = 30 * 60 * 1000
export const ONEPASSWORD_DOWNLOAD_LINKS: Readonly<Record<string, string>> = Object.freeze({
  darwin: 'https://cache.agilebits.com/dist/1P/op2/pkg/v2.2.0/op_apple_universal_v2.2.0.pkg',
  win32: 'https://cache.agilebits.com/dist/1P/op2/pkg/v2.2.0/op_windows_amd64_v2.2.0.zip',
  linux: 'https://cache.agilebits.com/dist/1P/op2/pkg/v2.2.0/op_linux_amd64_v2.2.0.zip'
})

interface OnePasswordOptions {
  cli?: ProcessCliPort | null
  localToolPath?: string
  platform?: string
  account?: string
  deviceStore?: DeviceStorePort | null
}

type AccountState = 'unknown' | 'none' | 'has-account'

interface CodedError extends Error {
  code?: string
  stderr?: string
  stdout?: string
  timedOut?: boolean
}

export interface OnePasswordBackend extends PasswordBackend {
  checkIfConfigured(): Promise<boolean>
  isUnlocked(): boolean
}

const DEVICE_CHARSET = 'abcdefghijklmnopqrstuvwxyz1234567890'
const NOT_SIGNED_IN_RE = /no account|not signed in|not currently signed in|session (?:key )?(?:is )?(?:invalid|expired)|sign in to/i
const BAD_PASSWORD_RE = /invalid password|incorrect password|wrong password|password.*(?:incorrect|invalid)|authentication failed/i
const INTEGRATION_PROMPT_RE = /1Password app integration/i

function createError(code: string, message?: string): CodedError {
  return Object.assign(new Error(message || code), { code })
}

function createDeviceId(): string {
  let id = ''
  for (let index = 0; index < 26; index++) {
    id += DEVICE_CHARSET[Math.floor(Math.random() * DEVICE_CHARSET.length)]
  }
  return id
}

export function compareVersion(left: unknown, right: unknown): number {
  const a = String(left || '').split('.').map((part) => Number.parseInt(part, 10) || 0)
  const b = String(right || '').split('.').map((part) => Number.parseInt(part, 10) || 0)
  const length = Math.max(a.length, b.length)
  for (let index = 0; index < length; index++) {
    const x = a[index] || 0
    const y = b[index] || 0
    if (x !== y) return x < y ? -1 : 1
  }
  return 0
}

function hostOf(href: unknown): string {
  const raw = String(href ?? '')
  if (!raw) return ''
  try {
    return new URL(raw.includes('://') ? raw : `https://${raw}`).hostname.toLowerCase()
  } catch {
    return ''
  }
}

export function normalizeHost(hostname: unknown): string {
  return domainOf(hostname)
}

export function parseItemCredentials(raw: unknown): { username: string; password: string } | null {
  let item: unknown
  try {
    item = JSON.parse(String(raw || '{}'))
  } catch {
    return null
  }
  const fields = item && typeof item === 'object' && Array.isArray((item as { fields?: unknown }).fields)
    ? (item as { fields: unknown[] }).fields
    : []
  let username = ''
  let password = ''
  for (const field of fields) {
    if (!field || typeof field !== 'object') continue
    const value = field as { label?: unknown; id?: unknown; value?: unknown }
    const label = String(value.label || value.id || '').toLowerCase()
    const text = typeof value.value === 'string' ? value.value : ''
    if (label === 'username') username = text
    if (label === 'password') password = text
  }
  return !username && !password ? null : { username, password }
}

export function matchItemIds(raw: unknown, domain: string): string[] {
  let items: unknown
  try {
    items = JSON.parse(String(raw || '[]'))
  } catch {
    return []
  }
  if (!Array.isArray(items) || !domain) return []
  const ids: string[] = []
  for (const item of items) {
    if (!item || typeof item !== 'object') continue
    const value = item as { id?: unknown; urls?: unknown }
    if (!value.id) continue
    const urls = Array.isArray(value.urls) ? value.urls : []
    const matched = urls.some((url) => {
      if (!url || typeof url !== 'object') return false
      return normalizeHost(hostOf((url as { href?: unknown }).href)) === domain
    })
    if (matched) ids.push(String(value.id))
  }
  return ids
}

export function createOnePasswordBackend(options: OnePasswordOptions = {}): OnePasswordBackend {
  const cli = options.cli || null
  const platform = options.platform || 'win32'
  const localToolPath = options.localToolPath || ''
  const account = String(options.account || 'hira').trim() || 'hira'
  const deviceStore = options.deviceStore || null
  const sessionEnvKey = `OP_SESSION_${account.replace(/[^a-zA-Z0-9_]/g, '')}`
  const inflight = new Map<string, Promise<PasswordSuggestion[]>>()

  let toolPath: string | null = null
  let version = ''
  let versionOk = false
  let probed = false
  let sessionKey: string | null = null
  let sessionAt = 0
  let accountState: AccountState = 'unknown'
  let accountStateTask: Promise<AccountState> | null = null
  let deviceId: string | null = null

  function ensureDeviceId(): string {
    if (deviceId) return deviceId
    try {
      const saved = deviceStore?.get()
      if (saved && String(saved).trim()) {
        deviceId = String(saved).trim()
        return deviceId
      }
    } catch {
      // 读取失败时重新生成
    }
    deviceId = createDeviceId()
    try {
      deviceStore?.set(deviceId)
    } catch {
      // 本次运行仍可使用临时设备 ID
    }
    return deviceId
  }

  function cliEnv(extra?: Record<string, string>): Record<string, string> {
    const env: Record<string, string> = { OP_DEVICE: ensureDeviceId() }
    if (sessionKey) env[sessionEnvKey] = sessionKey
    return extra ? { ...env, ...extra } : env
  }

  function isUnlocked(): boolean {
    if (!sessionKey) return false
    if (Date.now() - sessionAt >= ONEPASSWORD_SESSION_TTL_MS) {
      sessionKey = null
      sessionAt = 0
      return false
    }
    return true
  }

  function translateError(error: unknown): CodedError {
    const source = error as CodedError
    const merged = `${String(source?.stderr || '')}\n${String(source?.stdout || '')}\n${String(source?.message || '')}`.trim()
    if (NOT_SIGNED_IN_RE.test(merged)) {
      sessionKey = null
      sessionAt = 0
      if (/no account/i.test(merged)) accountState = 'none'
      return createError('onepassword-not-signed-in', merged || '1Password 尚未登录')
    }
    if (BAD_PASSWORD_RE.test(merged)) return createError('onepassword-bad-password', merged || '主密码不正确')
    if (source?.timedOut) {
      sessionKey = null
      sessionAt = 0
      return createError('onepassword-timeout', '1Password CLI 响应超时（可能是主密码错误或需要交互）')
    }
    return createError('onepassword-cli-error', merged || '1Password CLI 调用失败')
  }

  function requireTool(): { cli: ProcessCliPort; command: string } {
    if (!cli || !toolPath || !versionOk) {
      throw createError('onepassword-not-configured', '未找到可用的 1Password CLI（op）')
    }
    return { cli, command: toolPath }
  }

  function requireSession(): string {
    if (!isUnlocked() || !sessionKey) throw createError('onepassword-locked', '1Password 保险库尚未解锁')
    return sessionKey
  }

  async function readVersion(command: string): Promise<string> {
    try {
      const { stdout } = await cli!.run(command, ['--version'], { timeoutMs: 5000 })
      return stdout.trim().split(/\s+/).pop() || ''
    } catch {
      return ''
    }
  }

  async function completeIntegrationPrompt(command: string): Promise<void> {
    try {
      const result = await cli!.run(command, ['whoami'], { env: cliEnv(), timeoutMs: 5000 })
      if (!INTEGRATION_PROMPT_RE.test(`${result.stdout}\n${result.stderr}`)) return
    } catch (error) {
      const source = error as CodedError
      const merged = `${source?.stderr || ''}\n${source?.stdout || ''}\n${source?.message || ''}`
      if (!INTEGRATION_PROMPT_RE.test(merged)) return
    }
    try {
      await cli!.run(command, ['whoami'], { env: cliEnv(), timeoutMs: 5000, stdin: 'n\n' })
    } catch {
      // 回答后仍失败通常表示尚未登录
    }
  }

  async function checkIfConfigured(): Promise<boolean> {
    if (toolPath && versionOk) return true
    if (!cli) return false
    if (localToolPath && await cli.exists(localToolPath)) toolPath = localToolPath
    else toolPath = (await cli.resolveCommand('op')) || toolPath
    if (!toolPath) {
      version = ''
      versionOk = false
      return false
    }
    version = await readVersion(toolPath)
    versionOk = Boolean(version) && compareVersion(ONEPASSWORD_MIN_VERSION, version) <= 0
    if (versionOk) await completeIntegrationPrompt(toolPath)
    return versionOk
  }

  function refreshAccountState(): Promise<AccountState> {
    if (accountStateTask) return accountStateTask
    accountStateTask = (async () => {
      if (!cli || !toolPath || !versionOk) return accountState
      let stdout = ''
      try {
        const result = await cli.run(toolPath, ['account', 'list', '--format=json'], {
          env: cliEnv(),
          timeoutMs: 10000
        })
        stdout = result.stdout
      } catch {
        return accountState
      }
      let count = -1
      try {
        const parsed = JSON.parse(stdout || '[]') as unknown
        if (Array.isArray(parsed)) count = parsed.length
      } catch {
        count = stdout.trim() ? 1 : 0
      }
      if (count >= 0) accountState = count > 0 ? 'has-account' : 'none'
      return accountState
    })().finally(() => {
      accountStateTask = null
    })
    return accountStateTask
  }

  async function probe(force = false): Promise<boolean> {
    if (probed && !force) return Boolean(toolPath) && versionOk
    if (force) {
      toolPath = null
      version = ''
      versionOk = false
    }
    probed = true
    try {
      const ready = await checkIfConfigured()
      if (ready) await refreshAccountState()
      return ready
    } catch {
      return false
    }
  }

  async function fetchItem(command: string, id: string): Promise<PasswordSuggestion | null> {
    const process = requireTool()
    const { stdout } = await process.cli.run(
      command,
      ['item', 'get', id, '--format=json'],
      { env: cliEnv(), timeoutMs: 15000 }
    )
    const parsed = parseItemCredentials(stdout)
    return parsed ? { ...parsed, manager: '1Password' } : null
  }

  async function loadSuggestions(command: string, domain: string): Promise<PasswordSuggestion[]> {
    const process = requireTool()
    try {
      const { stdout } = await process.cli.run(
        command,
        ['item', 'list', '--categories', 'login', '--format=json'],
        { env: cliEnv(), timeoutMs: 30000 }
      )
      const ids = matchItemIds(stdout, domain)
      if (!ids.length) return []
      const rows = await Promise.all(ids.map((id) => fetchItem(command, id).catch(() => null)))
      return rows.filter((row): row is PasswordSuggestion => Boolean(row)).map((row) => ({ ...row, domain }))
    } catch (error) {
      const translated = translateError(error)
      if (translated.code === 'onepassword-not-signed-in') throw translated
      console.error('[domain-password] 1Password 查询失败:', translated.message)
      return []
    }
  }

  async function unlockStore(password: string): Promise<boolean> {
    const process = requireTool()
    if (!password) throw createError('onepassword-password-required', '请输入主密码')
    if (accountState === 'none') {
      throw createError('onepassword-not-signed-in', '尚未添加 1Password 账号，请先登录')
    }
    let stdout = ''
    try {
      const result = await process.cli.run(
        process.command,
        ['signin', '--raw', '--account', account],
        { env: cliEnv(), timeoutMs: 30000, stdin: password }
      )
      stdout = result.stdout
    } catch (error) {
      throw translateError(error)
    }
    const key = stdout.trim()
    if (!key) {
      throw createError('onepassword-unlock-empty', '解锁失败：CLI 没有返回会话密钥（账号可能尚未添加）')
    }
    sessionKey = key
    sessionAt = Date.now()
    accountState = 'has-account'
    return true
  }

  async function signIn(credentials: SignInCredentials = {}): Promise<boolean> {
    const process = requireTool()
    const email = String(credentials.email ?? '').trim()
    const password = typeof credentials.password === 'string' ? credentials.password : ''
    const secretKey = String(credentials.secretKey ?? '').trim()
    const address = String(credentials.address ?? '').trim() || 'my.1password.com'
    if (!email || !password || !secretKey) {
      throw createError('onepassword-credentials-required', '请填写邮箱、主密码与 Secret Key')
    }
    try {
      await process.cli.run(process.command, ['signout', '--all'], { env: cliEnv(), timeoutMs: 10000 })
    } catch {
      // 没有旧会话
    }
    sessionKey = null
    sessionAt = 0
    try {
      const { stdout } = await process.cli.run(
        process.command,
        ['account', 'add', '--address', address, '--email', email, '--secret-key', secretKey, '--shorthand', account, '--signin', '--raw'],
        { env: cliEnv(), timeoutMs: 60000, stdin: password }
      )
      const key = stdout.trim()
      if (key) {
        sessionKey = key
        sessionAt = Date.now()
      }
      accountState = 'has-account'
      return true
    } catch (error) {
      throw translateError(error)
    }
  }

  function getStatus(): PasswordBackendStatus {
    const found = Boolean(toolPath)
    if (found && versionOk && accountState === 'unknown') void refreshAccountState()
    const actions: BackendActions = { sync: false }
    return {
      configured: found && versionOk,
      toolFound: found,
      displayName: '1Password',
      unlocked: isUnlocked(),
      signInRequired: accountState === 'none',
      installMode: platform === 'darwin' ? 'download' : 'file',
      downloadLink: ONEPASSWORD_DOWNLOAD_LINKS[platform] || ONEPASSWORD_DOWNLOAD_LINKS.linux,
      toolFileName: platform === 'win32' ? 'op.exe' : 'op',
      localToolPath,
      version,
      versionOk,
      minVersion: ONEPASSWORD_MIN_VERSION,
      readOnly: true,
      account,
      signInLabel: '登录 1Password 账号',
      signInHint: 'Secret Key 在 1Password 的「登录与恢复」页面；主密码只用于本地签名会话，不会离开本机。',
      signInFields: [
        { key: 'email', label: '邮箱', type: 'text', placeholder: 'you@example.com' },
        { key: 'password', label: '主密码', type: 'password' },
        { key: 'secretKey', label: 'Secret Key', type: 'password', placeholder: 'A3-XXXXXX-XXXXXX-XXXXX-XXXXX-XXXXX-XXXXX' },
        { key: 'address', label: '账户地址（可选）', type: 'text', placeholder: 'my.1password.com' }
      ],
      unlockHint: '输入 1Password 主密码以建立本地会话；会话 30 分钟后或重启应用失效。',
      unlockedHint: '会话密钥仅保留在本次运行中，30 分钟后或重启应用需要重新解锁。',
      actions
    }
  }

  return {
    name: '1password',
    canWrite: false,
    isAvailable: () => Boolean(toolPath) && versionOk,
    checkIfConfigured,
    isUnlocked,
    probe,
    getStatus,
    unlockStore,
    signIn,
    sanitize: normalizeHost,

    async getSuggestions(hostname) {
      if (!toolPath) return []
      requireSession()
      const domain = normalizeHost(hostname)
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
