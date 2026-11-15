/** Public contracts for the permission domain and its replaceable ports. */

export type PermissionSetting = 'allow' | 'block' | 'ask'
export type PermissionDecision = PermissionSetting | 'unsupported'
export type PermissionType = string
export type PermissionTypeList = readonly PermissionType[]
export type PermissionScopeId = string | number
export type PermissionCallback = (allow: boolean) => void
export type PermissionEmitter = (route: string, payload: Record<string, unknown>) => void

export interface PermissionRuleChange {
  origin: string
  permissionType: string
}

export interface PermissionRuleMap {
  [permissionType: string]: unknown
}

export interface PermissionClassifiedRules {
  allow: string[]
  block: string[]
  ask: string[]
}

export interface PermissionRuleSummary {
  allow: number
  block: number
  ask: number
}

export interface NormalizedPermissionEntry {
  origin: string
  type: string
  setting: PermissionSetting
}

export type PermissionDropReason = 'invalid-entry' | 'invalid-origin' | 'invalid-type'

export interface DroppedPermissionEntry {
  entry: unknown
  reason: PermissionDropReason
}

export interface PermissionBatchResult {
  valid: NormalizedPermissionEntry[]
  dropped: DroppedPermissionEntry[]
}

export interface PermissionStorageRecord {
  id: string
  profileId: string
  domain: string
  permissionType: string
  setting: string
  updatedAt: number
}

export interface PermissionListItem extends PermissionStorageRecord {
  sensitive: boolean
}

export interface PermissionDefaultRecord {
  permissionType: string
  setting: string
}

export interface PermissionDefaultItem {
  permissionType: string
  setting: PermissionSetting
  sensitive: boolean
}

export interface PermissionRequestWaiter {
  callback: PermissionCallback
  scopeId?: PermissionScopeId
}

export interface PendingPermissionRequest {
  origin: string
  permissionType: string
  profileId: string
  waiters: PermissionRequestWaiter[]
  createdAt: number
}

export interface PendingPermissionView {
  id: string
  origin: string
  type: string
}

export interface PendingPermissionFlagged extends PendingPermissionView {
  sensitive: boolean
}

export interface CreatePendingRequestInput {
  id: string
  origin: string
  permissionType: string
  profileId: string
  callback: PermissionCallback
  scopeId?: PermissionScopeId
  createdAt: number
}

export interface RegisterPendingResult {
  id: string
  created: boolean
}

export type QueryCondition = unknown
export interface QueryRunResult { changes: number }

export interface PermissionSelectWhere {
  get(): PermissionStorageRecord | undefined
  all(): PermissionStorageRecord[]
}

export interface PermissionTableShape {
  id: unknown
  profileId: unknown
  domain: unknown
  permissionType: unknown
  setting: unknown
  updatedAt: unknown
}

/** Minimal structural database surface consumed by the Drizzle adapter. */
export interface PermissionDatabase {
  select(): { from(table: unknown): { where(condition: QueryCondition): PermissionSelectWhere } }
  insert(table: unknown): { values(value: object): { run(): QueryRunResult } }
  update(table: unknown): {
    set(value: object): {
      where(condition: QueryCondition): { run(): QueryRunResult }
      run(): QueryRunResult
    }
  }
  delete(table: unknown): { where(condition: QueryCondition): { run(): QueryRunResult } }
}

/** Persistence port: plugins can replace Drizzle without touching permission rules. */
export interface PermissionRepository {
  find(profileId: string, domain: string, permissionType: string): PermissionStorageRecord | null
  listByDomain(profileId: string, domain: string): PermissionStorageRecord[]
  listSites(profileId: string): PermissionStorageRecord[]
  listByType(profileId: string, permissionType: string): PermissionStorageRecord[]
  listDefaults(profileId: string): PermissionStorageRecord[]
  insert(record: PermissionStorageRecord): void
  update(id: string, setting: string, updatedAt: number): void
  updateByType(profileId: string, permissionType: string, setting: string, updatedAt: number): number
  remove(profileId: string, domain: string, permissionType: string): number
  removeByDomain(profileId: string, domain: string): number
  removeByType(profileId: string, permissionType: string): number
  removeAll(profileId: string): number
}

export interface PermissionRequestRegistry {
  findIdByKey(key: string): string | null
  register(key: string, input: CreatePendingRequestInput): RegisterPendingResult
  get(id: string): PendingPermissionRequest | undefined
  remove(id: string): PendingPermissionRequest | undefined
  entries(): IterableIterator<[string, PendingPermissionRequest]>
  values(): IterableIterator<PendingPermissionRequest>
  clear(): void
}

export interface PermissionGrantRegistry {
  add(key: string): void
  has(key: string): boolean
  removeScope(prefix: string): number
}

export interface PermissionServiceOptions {
  profileId?: string
  emit?: PermissionEmitter
  onChange?: (change: PermissionRuleChange) => void
  permissionTypes?: PermissionTypeList
  repository?: PermissionRepository
  requestRegistry?: PermissionRequestRegistry
  grantRegistry?: PermissionGrantRegistry
  now?: () => number
  createId?: (prefix: string) => string
}

export interface PermissionService {
  getPermission(origin: string, permissionType: string, profileId?: string): PermissionSetting
  resolveRequest(origin: string, permissionType: string, profileId?: string): PermissionDecision
  isGranted(origin: string, permissionType: string, profileId?: string): boolean
  isBlocked(origin: string, permissionType: string, profileId?: string): boolean
  getSitePermissions(origin: string, profileId?: string): PermissionRuleMap
  listAll(profileId?: string): PermissionListItem[]
  listByType(permissionType: string, profileId?: string): PermissionStorageRecord[]

  getDefault(permissionType: string, profileId?: string): PermissionSetting
  setDefault(permissionType: string, setting: unknown, profileId?: string): boolean
  listDefaults(profileId?: string): PermissionDefaultRecord[]
  defaultsView(profileId?: string): PermissionDefaultItem[]

  classifySite(origin: string, profileId?: string): PermissionClassifiedRules
  summarizeSite(origin: string, profileId?: string): PermissionRuleSummary

  setPermission(origin: string, permissionType: string, setting: unknown, profileId?: string): boolean
  setSitePermissions(origin: string, rules: PermissionRuleMap, profileId?: string): boolean
  resetSite(origin: string, profileId?: string): number
  removePermission(origin: string, permissionType: string, profileId?: string): boolean
  clearAll(profileId?: string): number
  clearSite(origin: string, profileId?: string): number

  setByType(permissionType: string, setting: unknown, profileId?: string): number
  clearByType(permissionType: string, profileId?: string): number
  clearSites(origins: readonly string[], profileId?: string): number

  createRequest(
    origin: string,
    permissionType: string,
    callback: PermissionCallback,
    scopeId?: PermissionScopeId
  ): string
  respondToRequest(id: string, allow: boolean, persist?: boolean): boolean
  listPendingRequests(): PendingPermissionView[]
  pendingWithFlags(): PendingPermissionFlagged[]
  rejectAllPending(): void
  rejectPendingForScope(scopeId?: PermissionScopeId | null): number

  isGrantedFor(origin: string, permissionType: string, scopeId?: PermissionScopeId): boolean
  hasGrant(origin: string, permissionType: string, scopeId?: PermissionScopeId): boolean
  addGrant(origin: string, permissionType: string, scopeId?: PermissionScopeId): void
  clearGrants(scopeId?: PermissionScopeId | null): number

  normalizeDomain(origin: string): string
  readonly PERMISSION_TYPES: PermissionTypeList
}
