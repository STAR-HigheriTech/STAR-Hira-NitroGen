export type PasswordStrengthLabel = '极弱' | '弱' | '中' | '强' | '极强'

export interface PasswordStrength {
  score: number
  label: PasswordStrengthLabel
}

export interface PasswordCryptoProvider {
  name?: string
  reason?: string
  isAvailable(): boolean
  isOsKeychain?(): boolean
  encrypt(plain: string): string | null
  decrypt(cipher: string): string | null
}

export interface SafeStorageLike {
  isEncryptionAvailable(): boolean
  encryptString(plain: string): Buffer
  decryptString(encrypted: Buffer): string
  getSelectedStorageBackend?(): string
}

export interface ProcessRunOptions {
  env?: Record<string, string>
  timeoutMs?: number
  cwd?: string
  stdin?: string
}

export interface ProcessResult {
  stdout: string
  stderr: string
}

export interface ProcessCliPort {
  resolveCommand(name: string): Promise<string | null>
  exists(filePath: string): Promise<boolean>
  run(command: string, args: string[], options?: ProcessRunOptions): Promise<ProcessResult>
}

export interface DeviceStorePort {
  get(): string | null
  set(value: string): void
}

export interface PasswordRow {
  id: string
  profileId: string
  backend: string
  domain: string
  username: string
  backendRef: string | null
  encryptedPassword: string | null
  lastUsedAt: number | null
  createdAt: number
}

export interface NeverSaveRow {
  id: string
  profileId: string
  domain: string
  createdAt: number
}

export interface PasswordCredentialInput {
  hostname: string
  username: string
  password: string
  profileId?: string
}

export interface NormalizedCredentialInput extends PasswordCredentialInput {
  profileId: string
}

export interface PasswordSuggestion {
  id?: string
  domain?: string
  username: string
  password: string
  manager: string
  masked?: string
}

export interface SavedCredential {
  id: string
  domain: string
  username: string
  lastUsedAt: number | null
  createdAt: number
  manager: string
  backendRef?: string | null
}

export interface CredentialSecret {
  id: string
  domain: string
  username: string
  password: string
  manager: string
  strength: PasswordStrength
}

export interface CredentialUpdateInput {
  id: string
  hostname: string
  username: string
  password: string
  profileId?: string
}

export interface PasswordImportRow {
  domain?: string
  hostname?: string
  username?: string
  password?: string
}

export interface PasswordImportSourceRow {
  domain: string
  username: string
  password: string
}

export interface PasswordImportOptions {
  profileId?: string
  backend?: string
}

export interface BackendImportResult {
  imported: number
  merged: number
  skipped: number
  total: number
  ok: boolean
  reason?: string
}

export interface PasswordImportResult {
  imported: number
  merged: number
  skipped: number
  total: number
  unsupported?: boolean
  reason?: string
}

export type PasswordAuditKind = 'empty' | 'common' | 'weak' | 'reused' | 'breached'

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

export interface BreachProvider {
  check(password: string): boolean | Promise<boolean>
}

export type SignInFieldType = 'text' | 'password' | 'email'

export interface SignInField {
  key: string
  label: string
  type: SignInFieldType
  placeholder?: string
}

export interface BackendActions {
  sync: boolean
  [action: string]: boolean
}

export interface PasswordBackendStatus {
  configured: boolean
  toolFound?: boolean
  displayName: string
  unlocked: boolean
  signInRequired: boolean
  installMode?: 'file' | 'download' | string
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

export interface BackendListItem {
  name: string
  available: boolean
  active: boolean
  writable: boolean
  status?: PasswordBackendStatus
}

export interface SignInCredentials {
  password?: string
  clientId?: string
  clientSecret?: string
  email?: string
  secretKey?: string
  address?: string
}

export interface BackendActionPayload extends SignInCredentials {}

export interface BackendActionSuccess {
  ok: true
}

export interface BackendActionFailure {
  ok: false
  reason: string
  message?: string
}

export type BackendActionResult = BackendActionSuccess | BackendActionFailure

export interface SaveCredentialResult {
  ok: true
  strength: PasswordStrength
  backend?: string
}

export interface BackendSaveResult {
  ok: true
  key: string
}

export interface PasswordBackend {
  readonly name: string
  readonly canWrite?: boolean
  isAvailable(): boolean
  getSuggestions(hostname: string, profileId?: string): Promise<PasswordSuggestion[]>
  saveCredential(input: NormalizedCredentialInput): Promise<boolean | BackendSaveResult>
  deleteCredential(id: string, profileId?: string): Promise<boolean>
  getCredential?(id: string, profileId?: string): Promise<CredentialSecret | null>
  updateCredential?(input: CredentialUpdateInput): Promise<boolean>
  listCredentials(profileId?: string): Promise<SavedCredential[]>
  exportCredentials?(profileId?: string): Promise<PasswordImportSourceRow[]>
  importCredentials?(rows: readonly PasswordImportRow[], profileId: string): Promise<BackendImportResult>
  auditCredentials?(profileId: string): Promise<PasswordAuditResult>
  getStatus?(): PasswordBackendStatus
  probe?(force?: boolean): Promise<boolean>
  isUnlocked?(): boolean
  unlockStore?(password: string): Promise<boolean>
  signIn?(credentials: SignInCredentials): Promise<boolean>
  forceSync?(): Promise<void>
  sanitize?(hostname: string): string
}

export type PasswordWriteOperation =
  | { type: 'insert'; row: PasswordRow }
  | { type: 'update'; id: string; values: Partial<Pick<PasswordRow, 'domain' | 'username' | 'encryptedPassword' | 'lastUsedAt'>> }
  | { type: 'delete'; id: string }

export interface PasswordCredentialRepository {
  list(profileId: string, backend: string): PasswordRow[]
  get(id: string): PasswordRow | null
  write(operations: readonly PasswordWriteOperation[]): void
}

export interface PasswordNeverSaveRepository {
  list(profileId: string): NeverSaveRow[]
  replace(profileId: string, rows: readonly NeverSaveRow[]): void
}

export interface PasswordServiceOptions {
  crypto?: PasswordCryptoProvider
  safeStorage?: SafeStorageLike
  repository?: PasswordCredentialRepository
  neverSaveRepository?: PasswordNeverSaveRepository
  defaultBackend?: string
  profileId?: string
  breachProvider?: BreachProvider | null
  bwCli?: ProcessCliPort | null
  bwLocalToolPath?: string
  opCli?: ProcessCliPort | null
  opLocalToolPath?: string
  opAccount?: string
  opDeviceStore?: DeviceStorePort | null
  platform?: string
  backends?: readonly PasswordBackend[]
  backendExtensions?: readonly PasswordBackendExtension[]
}

export interface PasswordBackendExtensionContext {
  crypto: PasswordCryptoProvider
  repository: PasswordCredentialRepository
  options: Readonly<PasswordServiceOptions>
}

export interface PasswordBackendExtension {
  create(context: PasswordBackendExtensionContext): PasswordBackend
}

export interface RegisterBackendOptions {
  replace?: boolean
}

export interface PasswordService {
  listBackends(): BackendListItem[]
  getBackendStatus(name: string): PasswordBackendStatus | null
  setActiveBackend(name: string): boolean
  getActiveBackend(): string
  backendAction(name: string, action: string, payload?: BackendActionPayload): Promise<BackendActionResult>
  isAvailable(): boolean
  registerBackend(backend: PasswordBackend, options?: RegisterBackendOptions): boolean
  unregisterBackend(name: string): boolean
  getSuggestions(hostname: string, requestedProfileId?: string): Promise<PasswordSuggestion[]>
  setProfile(profileId?: string | null): void
  saveCredential(input: PasswordCredentialInput): Promise<SaveCredentialResult | false>
  revealCredential(id: string, profileId?: string): Promise<CredentialSecret | null>
  updateCredential(input: CredentialUpdateInput): Promise<boolean>
  exportCredentials(profileId?: string): Promise<PasswordImportSourceRow[]>
  importCredentials(source: string | readonly PasswordImportRow[], options?: PasswordImportOptions): Promise<PasswordImportResult>
  deleteCredential(id: string, profileId?: string): Promise<boolean>
  listCredentials(profileId?: string): Promise<SavedCredential[]>
  auditCredentials(profileId?: string): Promise<PasswordAuditResult>
  isNeverSave(hostname: string, profileId?: string): boolean
  addNeverSave(hostname: string, profileId?: string): boolean
  removeNeverSave(hostname: string, profileId?: string): boolean
  getNeverSaveDomains(profileId?: string): string[]
  setNeverSaveDomains(domains: readonly string[], profileId?: string): void
  normalizeDomain(hostname: string): string
  lowStrengthFlag(password: string): boolean
}
