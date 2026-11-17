import { generateId, normalizeDomain } from '@hira-ng/shared-utils'
import { DEFAULT_RULE_DOMAIN } from './constants'
import * as P from './permissionUtil'
import { InMemoryPermissionRequestRegistry } from './registry'
import { createDrizzlePermissionRepository } from './repository'
import type {
  PendingPermissionFlagged,
  PendingPermissionRequest,
  PendingPermissionView,
  PermissionDatabase,
  PermissionDefaultItem,
  PermissionDefaultRecord,
  PermissionDecision,
  PermissionListItem,
  PermissionRepository,
  PermissionRuleMap,
  PermissionScopeId,
  PermissionService,
  PermissionServiceOptions,
  PermissionSetting,
  PermissionStorageRecord
} from './types'

export function createPermissionService(
  db: PermissionDatabase | null | undefined,
  options: PermissionServiceOptions = {}
): PermissionService {
  const repository: PermissionRepository = options.repository
    || (db
      ? createDrizzlePermissionRepository(db)
      : (() => { throw new Error('Permission repository or database is required') })())
  const defaultProfileId = options.profileId || 'default'
  const permissionTypes = options.permissionTypes && options.permissionTypes.length
    ? Object.freeze([...options.permissionTypes])
    : P.KNOWN_TYPES
  const requestRegistry = options.requestRegistry || new InMemoryPermissionRequestRegistry()
  const now = options.now || Date.now
  const createId = options.createId || generateId
  const emit = typeof options.emit === 'function' ? options.emit : null
  const onChange = typeof options.onChange === 'function' ? options.onChange : null

  function currentProfile(profileId?: string): string {
    return profileId || defaultProfileId
  }

  function isKnownType(type: unknown): type is string {
    return P.isValidPermissionType(type, permissionTypes)
  }

  function safeEmit(route: string, payload: Record<string, unknown>): void {
    try { emit?.(route, payload) } catch {}
  }

  function notifyRuleChanged(origin = '', permissionType = ''): void {
    try { onChange?.({ origin, permissionType }) } catch {}
  }

  function getPermission(
    origin: string,
    permissionType: string,
    profileId?: string
  ): PermissionSetting {
    const domain = normalizeDomain(origin)
    if (!domain || !permissionType) return 'ask'
    const pid = currentProfile(profileId)
    const row = repository.find(pid, domain, permissionType)
    if (row) {
      const setting = P.sanitizeSetting(row.setting)
      if (setting !== 'ask') return setting
    }
    return getDefault(permissionType, pid)
  }

  function getDefault(permissionType: string, profileId?: string): PermissionSetting {
    if (!permissionType) return 'ask'
    const row = repository.find(currentProfile(profileId), DEFAULT_RULE_DOMAIN, permissionType)
    return row ? P.sanitizeSetting(row.setting) : 'ask'
  }

  function setDefault(permissionType: string, setting: unknown, profileId?: string): boolean {
    if (!isKnownType(permissionType)) return false
    const validSetting = P.sanitizeSetting(setting)
    const pid = currentProfile(profileId)

    if (validSetting === 'ask') {
      repository.remove(pid, DEFAULT_RULE_DOMAIN, permissionType)
      notifyRuleChanged('', permissionType)
      return true
    }

    const existing = repository.find(pid, DEFAULT_RULE_DOMAIN, permissionType)
    if (existing) repository.update(existing.id, validSetting, now())
    else insertRule(pid, DEFAULT_RULE_DOMAIN, permissionType, validSetting)
    notifyRuleChanged('', permissionType)
    return true
  }

  function listDefaults(profileId?: string): PermissionDefaultRecord[] {
    return repository.listDefaults(currentProfile(profileId)).map((row) => ({
      permissionType: row.permissionType,
      setting: row.setting
    }))
  }

  function defaultsView(profileId?: string): PermissionDefaultItem[] {
    const saved = new Map(listDefaults(profileId).map((row) => [row.permissionType, row.setting]))
    return permissionTypes.map((permissionType) => ({
      permissionType,
      setting: P.sanitizeSetting(saved.get(permissionType)),
      sensitive: P.isSensitivePermission(permissionType)
    }))
  }

  function resolveRequest(
    origin: string,
    permissionType: string,
    profileId?: string
  ): PermissionDecision {
    if (!normalizeDomain(origin) || !isKnownType(permissionType)) return 'unsupported'
    return getPermission(origin, permissionType, profileId)
  }

  function isGranted(origin: string, permissionType: string, profileId?: string): boolean {
    return getPermission(origin, permissionType, profileId) === 'allow'
  }

  function isBlocked(origin: string, permissionType: string, profileId?: string): boolean {
    return getPermission(origin, permissionType, profileId) === 'block'
  }

  function getSitePermissions(origin: string, profileId?: string): PermissionRuleMap {
    const domain = normalizeDomain(origin)
    if (!domain) return {}
    const result: PermissionRuleMap = {}
    for (const row of repository.listByDomain(currentProfile(profileId), domain)) {
      result[row.permissionType] = row.setting
    }
    return result
  }

  function insertRule(
    profileId: string,
    domain: string,
    permissionType: string,
    setting: string
  ): void {
    repository.insert({
      id: createId('perm'),
      profileId,
      domain,
      permissionType,
      setting,
      updatedAt: now()
    })
  }

  function setPermission(
    origin: string,
    permissionType: string,
    setting: unknown,
    profileId?: string
  ): boolean {
    const domain = normalizeDomain(origin)
    if (!domain || !isKnownType(permissionType)) return false
    const validSetting = P.sanitizeSetting(setting)
    const pid = currentProfile(profileId)
    const existing = repository.find(pid, domain, permissionType)
    if (existing) repository.update(existing.id, validSetting, now())
    else insertRule(pid, domain, permissionType, validSetting)
    notifyRuleChanged(origin, permissionType)
    return true
  }

  function setSitePermissions(
    origin: string,
    rules: PermissionRuleMap,
    profileId?: string
  ): boolean {
    if (!normalizeDomain(origin) || !rules || typeof rules !== 'object' || Array.isArray(rules)) {
      return false
    }
    let changed = false
    for (const [permissionType, setting] of Object.entries(rules)) {
      if (!isKnownType(permissionType)) continue
      changed = setPermission(origin, permissionType, setting, profileId) || changed
    }
    return changed
  }

  function removePermission(
    origin: string,
    permissionType: string,
    profileId?: string
  ): boolean {
    const domain = normalizeDomain(origin)
    if (!domain || !permissionType) return false
    const removed = repository.remove(currentProfile(profileId), domain, permissionType)
    notifyRuleChanged(origin, permissionType)
    return removed > 0
  }

  function resetSite(origin: string, profileId?: string): number {
    return clearSite(origin, profileId)
  }

  function clearSite(origin: string, profileId?: string): number {
    const domain = normalizeDomain(origin)
    if (!domain) return 0
    const removed = repository.removeByDomain(currentProfile(profileId), domain)
    notifyRuleChanged(origin, '')
    return removed
  }

  function clearAll(profileId?: string): number {
    const removed = repository.removeAll(currentProfile(profileId))
    notifyRuleChanged('', '')
    return removed
  }

  function setByType(permissionType: string, setting: unknown, profileId?: string): number {
    if (!isKnownType(permissionType)) return 0
    const changed = repository.updateByType(
      currentProfile(profileId),
      permissionType,
      P.sanitizeSetting(setting),
      now()
    )
    notifyRuleChanged('', permissionType)
    return changed
  }

  function clearByType(permissionType: string, profileId?: string): number {
    if (!permissionType) return 0
    const removed = repository.removeByType(currentProfile(profileId), permissionType)
    notifyRuleChanged('', permissionType)
    return removed
  }

  function clearSites(origins: readonly string[], profileId?: string): number {
    if (!Array.isArray(origins) || origins.length === 0) return 0
    const seen = new Set<string>()
    let removed = 0
    for (const origin of origins) {
      const domain = normalizeDomain(origin)
      if (!domain || seen.has(domain)) continue
      seen.add(domain)
      removed += clearSite(domain, profileId)
    }
    return removed
  }

  function classifySite(origin: string, profileId?: string) {
    return P.classifySiteRules(getSitePermissions(origin, profileId), permissionTypes)
  }

  function summarizeSite(origin: string, profileId?: string) {
    return P.summarizeSiteRules(getSitePermissions(origin, profileId), permissionTypes)
  }

  function listAll(profileId?: string): PermissionListItem[] {
    return repository.listSites(currentProfile(profileId)).map((row) => ({
      ...row,
      sensitive: P.isSensitivePermission(row.permissionType)
    }))
  }

  function listByType(permissionType: string, profileId?: string): PermissionStorageRecord[] {
    return repository.listByType(currentProfile(profileId), permissionType)
  }

  function pendingKey(
    origin: string,
    permissionType: string,
    scopeId?: PermissionScopeId
  ): string {
    const scope = scopeId == null ? '' : String(scopeId)
    return `${scope}::${normalizeDomain(origin) || String(origin || '')}::${permissionType}`
  }

  function firstScope(request: PendingPermissionRequest): PermissionScopeId | null {
    for (const waiter of request.waiters) {
      if (waiter.scopeId != null) return waiter.scopeId
    }
    return null
  }

  function createRequest(
    origin: string,
    permissionType: string,
    callback: (allow: boolean) => void,
    scopeId?: PermissionScopeId
  ): string {
    const key = pendingKey(origin, permissionType, scopeId)
    const created = requestRegistry.register(key, {
      id: createId('preq'),
      origin,
      permissionType,
      profileId: defaultProfileId,
      callback,
      scopeId,
      createdAt: now()
    })
    if (created.created) {
      const request = requestRegistry.get(created.id)
      const payload: Record<string, unknown> = {
        id: created.id,
        origin,
        type: permissionType
      }
      const first = request ? firstScope(request) : scopeId ?? null
      if (first != null) payload.scopeId = first
      safeEmit('permission:request', payload)
    }
    return created.id
  }

  function respondToRequest(id: string, allow: boolean, persist?: boolean): boolean {
    const request = requestRegistry.remove(id)
    if (!request) return false
    for (const waiter of request.waiters) {
      try { waiter.callback(allow) } catch {}
    }
    if (persist !== false) {
      try {
        setPermission(
          request.origin,
          request.permissionType,
          allow ? 'allow' : 'block',
          request.profileId
        )
      } catch {}
    }
    safeEmit('permission:cleared', { id })
    return true
  }

  function listPendingRequests(): PendingPermissionView[] {
    return Array.from(requestRegistry.entries()).map(([id, request]) => ({
      id,
      origin: request.origin,
      type: request.permissionType
    }))
  }

  function pendingWithFlags(): PendingPermissionFlagged[] {
    return listPendingRequests().map((request) => ({
      ...request,
      sensitive: P.isSensitivePermission(request.type)
    }))
  }

  function rejectAllPending(): void {
    for (const request of requestRegistry.values()) {
      for (const waiter of request.waiters) {
        try { waiter.callback(false) } catch {}
      }
    }
    requestRegistry.clear()
  }

  function rejectPendingForScope(scopeId?: PermissionScopeId | null): number {
    if (scopeId == null) return 0
    const sid = String(scopeId)
    let rejected = 0
    for (const [id, request] of Array.from(requestRegistry.entries())) {
      const previousScope = firstScope(request)
      const kept = []
      let touched = false
      for (const waiter of request.waiters) {
        if (waiter.scopeId != null && String(waiter.scopeId) === sid) {
          try { waiter.callback(false) } catch {}
          rejected++
          touched = true
        } else {
          kept.push(waiter)
        }
      }
      if (!touched) continue
      if (kept.length === 0) {
        requestRegistry.remove(id)
        safeEmit('permission:cleared', { id })
        continue
      }
      request.waiters = kept
      const nextScope = firstScope(request)
      if (String(previousScope) !== String(nextScope)) {
        safeEmit('permission:cleared', { id })
        safeEmit('permission:request', {
          id,
          origin: request.origin,
          type: request.permissionType,
          scopeId: nextScope
        })
      }
    }
    return rejected
  }

  return {
    getPermission,
    resolveRequest,
    isGranted,
    isBlocked,
    getSitePermissions,
    listAll,
    listByType,
    getDefault,
    setDefault,
    listDefaults,
    defaultsView,
    classifySite,
    summarizeSite,
    setPermission,
    setSitePermissions,
    resetSite,
    removePermission,
    clearAll,
    clearSite,
    setByType,
    clearByType,
    clearSites,
    createRequest,
    respondToRequest,
    listPendingRequests,
    pendingWithFlags,
    rejectAllPending,
    rejectPendingForScope,
    normalizeDomain,
    PERMISSION_TYPES: permissionTypes
  }
}
