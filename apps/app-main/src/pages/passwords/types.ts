export type KnownPasswordAuditKind = 'empty' | 'common' | 'weak' | 'reused' | 'breached'
export type PasswordAuditKind = KnownPasswordAuditKind | (string & {})
export type BackendActionName = 'probe' | 'unlock' | 'sign-in' | 'sync'

export interface BackendActions {
  sync?: boolean
  [action: string]: boolean | undefined
}

export interface SignInField {
  key: string
  label?: string
  type?: 'text' | 'password' | 'email'
  placeholder?: string
}

export interface PasswordBackendStatus {
  configured?: boolean
  toolFound?: boolean
  displayName?: string
  unlocked?: boolean
  signInRequired?: boolean
  installMode?: string
  downloadLink?: string
  toolFileName?: string
  localToolPath?: string
  version?: string
  versionOk?: boolean
  minVersion?: string
  readOnly?: boolean
  account?: string
  signInLabel?: string
  signInHint?: string
  signInFields?: SignInField[]
  unlockHint?: string
  unlockedHint?: string
  actions?: BackendActions
  [key: string]: unknown
}

export interface PasswordBackend {
  name: string
  available: boolean
  active: boolean
  writable: boolean
  status?: PasswordBackendStatus
}

export interface SavedCredential {
  id: string
  domain: string
  username: string
  lastUsedAt: number | null
  createdAt: number
  manager: string
}

export interface CredentialSecret extends SavedCredential {
  password: string
  strength: { score: number; label: string }
}

export interface CredentialEditorInput {
  id?: string
  hostname: string
  username: string
  password: string
}

export interface PasswordAuditIssue {
  id: string
  domain: string
  username: string
  kinds: PasswordAuditKind[]
}

export interface PasswordAuditResult {
  checked: number
  issues: PasswordAuditIssue[]
  unsupported?: boolean
}

export interface BackendActionResult {
  ok: boolean
  reason?: string
  message?: string
  path?: string
}

export interface PasswordMutationResult {
  ok: boolean
}

export interface PasswordExportResult extends PasswordMutationResult {
  canceled?: boolean
  count?: number
  reason?: string
}
