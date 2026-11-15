import { IPC_ROUTES, initTheme, rpc } from 'hira://shared/runtime.js'

initTheme()

interface PasskeyCapabilities {
  platform?: string
  configured?: boolean
  accountPicker?: boolean
  platformAuthenticator?: boolean
  touchId?: boolean
  error?: string
}

function setText(id: string, text: string): void {
  const node = document.getElementById(id)
  if (node) node.textContent = text
}

function yesNo(value: unknown): string {
  return value === true ? '可用' : '不可用'
}

async function load(): Promise<void> {
  const card = document.querySelector<HTMLElement>('.passkey-status')
  try {
    const status = await rpc<PasskeyCapabilities>(IPC_ROUTES.passkeyCapabilities, {})
    const configured = status?.configured === true
    const platformAuthenticator = status?.platformAuthenticator === true
    const windowsSystem = status?.platform === 'win32'
    setText(
      'status-title',
      configured && windowsSystem
        ? 'Windows Passkey 已接入'
        : configured && platformAuthenticator
          ? '系统 Passkey 认证器已就绪'
        : configured
          ? 'WebAuthn 已启用，平台认证器不可用'
          : 'Passkey 初始化失败'
    )
    setText(
      'status-copy',
      status?.error
        ? `系统认证器初始化失败：${status.error}`
        : configured && windowsSystem
          ? 'HTTPS 网站发起 Passkey 请求时，Chromium 会交给 Windows 安全中心完成验证，使用 Windows Hello 的 PIN、指纹、人脸或安全密钥登录。Hira 不保存站点密码或凭据私钥。'
          : configured
          ? platformAuthenticator
            ? '登录时由系统完成本机验证；需要选择多个账户时，Hira 会打开独立的账户选择窗口。'
            : '你仍可使用 USB / NFC 安全密钥。Touch ID 是否可用取决于系统与 macOS 配置。'
          : '你仍可使用 USB / NFC 安全密钥。Passkey 是否可用取决于操作系统和当前 Electron 运行环境。'
    )
    if (!configured) card?.classList.add('is-error')
    setText('fact-platform', String(status?.platform || '未知'))
    setText('fact-authenticator', windowsSystem
      ? (configured ? '由 Windows 系统接管' : '不可用')
      : yesNo(platformAuthenticator))
    setText('fact-picker', yesNo(status?.accountPicker))
    setText('fact-touch-id', yesNo(status?.touchId))
  } catch (error) {
    card?.classList.add('is-error')
    setText('status-title', '无法读取 Passkey 状态')
    setText('status-copy', error instanceof Error ? error.message : String(error))
    for (const id of ['fact-platform', 'fact-authenticator', 'fact-picker', 'fact-touch-id']) {
      setText(id, '读取失败')
    }
  }
}

void load()
