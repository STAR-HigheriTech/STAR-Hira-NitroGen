/**
 * Passkey / WebAuthn 的跨层数据契约。
 *
 * 凭据本体由操作系统认证器保管，浏览器只负责把账户摘要交给选择界面，
 * 并把用户选择回传给 Electron。这里不包含私钥、签名结果或任何凭据秘密。
 */

export interface PasskeyAccountSummary {
  credentialId: string
  name?: string
  displayName?: string
}

export interface PasskeyPickerPayload {
  requestId: string
  relyingPartyId: string
  accounts: PasskeyAccountSummary[]
}

export interface PasskeyCapabilities {
  platform: string
  configured: boolean
  accountPicker: boolean
  platformAuthenticator: boolean
  touchId: boolean
  error?: string
}
