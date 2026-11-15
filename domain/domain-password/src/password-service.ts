import { createSafeStorageCrypto, createUnavailableCrypto } from '@hira-ng/infra-secret'
import { normalizeDomain as normalizeHostname } from '@hira-ng/shared-utils'
import { PasswordBackendRegistry } from './backend-registry'
import { createBitwardenBackend } from './backends/bitwarden-backend'
import { createOnePasswordBackend } from './backends/onepassword-backend'
import { createBuiltinBackend, createKeychainBackend } from './builtin-backend'
import { mergeCredentialRows, mergeSuggestionRows } from './credential-policy'
import { parseCredentialCsv } from './credential-csv'
import {
  createDrizzleNeverSaveRepository,
  createDrizzlePasswordRepository,
  type PasswordDatabase
} from './drizzle-password-repository'
import { createNeverSavePolicy } from './never-save-policy'
import {
  domainOf,
  filterMatchingCredentials,
  isWeakPassword,
  maskPassword,
  passwordStrength
} from './password-utils'
import type {
  BackendActionPayload,
  BackendActionResult,
  BackendListItem,
  CredentialSecret,
  CredentialUpdateInput,
  PasswordAuditResult,
  PasswordBackend,
  PasswordBackendStatus,
  PasswordCredentialInput,
  PasswordCryptoProvider,
  PasswordImportOptions,
  PasswordImportResult,
  PasswordImportRow,
  PasswordImportSourceRow,
  PasswordSuggestion,
  PasswordService,
  PasswordServiceOptions,
  RegisterBackendOptions,
  SavedCredential,
  SaveCredentialResult
} from './types'

interface CodedError extends Error {
  code?: string
}

function errorMessage(error: unknown): string {
  return String((error as CodedError)?.message || '操作失败').slice(0, 500)
}

export function createPasswordService(
  db: PasswordDatabase,
  options: PasswordServiceOptions = {}
): PasswordService {
  const crypto = (
    options.crypto ||
    (options.safeStorage ? createSafeStorageCrypto(options.safeStorage) : null) ||
    createUnavailableCrypto('createPasswordService 未收到 crypto provider')
  ) as PasswordCryptoProvider
  const repository = options.repository || createDrizzlePasswordRepository(db)
  const neverSaveRepository = options.neverSaveRepository || createDrizzleNeverSaveRepository(db)
  const defaultBackend = options.defaultBackend || 'builtin'
  const initialProfileId = options.profileId || 'default'
  const registry = new PasswordBackendRegistry('builtin')
  const neverSave = createNeverSavePolicy(neverSaveRepository, initialProfileId)

  if (!crypto.isAvailable()) {
    console.error(
      `[domain-password] 加密 provider 不可用（${crypto.name || 'unknown'}）：密码将无法保存。`
    )
  }

  const builtin = createBuiltinBackend({
    repository,
    crypto,
    breachProvider: options.breachProvider || null
  })
  const bitwarden = createBitwardenBackend({
    cli: options.bwCli || null,
    localToolPath: options.bwLocalToolPath || '',
    platform: options.platform || 'win32'
  })
  const onePassword = createOnePasswordBackend({
    cli: options.opCli || null,
    localToolPath: options.opLocalToolPath || '',
    account: options.opAccount || 'hira',
    deviceStore: options.opDeviceStore || null,
    platform: options.platform || 'win32'
  })
  const keychain = createKeychainBackend({
    repository,
    crypto,
    breachProvider: options.breachProvider || null
  })

  for (const backend of [builtin, bitwarden, onePassword, keychain]) registry.register(backend)
  for (const backend of options.backends || []) registry.register(backend, { replace: true })
  for (const extension of options.backendExtensions || []) {
    registry.register(extension.create({ crypto, repository, options }), { replace: true })
  }
  registry.setActive(defaultBackend)
  if (!registry.has(registry.activeNameValue())) registry.setActive('builtin')

  void Promise.allSettled([
    bitwarden.probe?.(),
    onePassword.probe?.()
  ])

  function profileOf(profileId?: string | null): string {
    return profileId || neverSave.currentProfile()
  }

  function activeBackend(): PasswordBackend {
    return registry.active() || builtin
  }

  function fallbackBackend(): PasswordBackend | null {
    return registry.fallbackForActive()
  }

  /** 管理操作优先落到可写的内置库；外部后端只负责自动填充。 */
  function managementBackend(): PasswordBackend {
    return fallbackBackend() || activeBackend()
  }

  function listBackends(): BackendListItem[] {
    return registry.list().map((backend) => {
      let available = false
      try {
        available = backend.isAvailable()
      } catch {
        available = false
      }
      const item: BackendListItem = {
        name: backend.name,
        available,
        active: backend.name === registry.activeNameValue(),
        writable: backend.canWrite !== false
      }
      if (backend.getStatus) {
        try {
          item.status = backend.getStatus()
        } catch {
          // 单个后端的探测异常不应使整个后端列表不可用
        }
      }
      return item
    })
  }

  function getBackendStatus(name: string): PasswordBackendStatus | null {
    const backend = registry.get(name)
    if (!backend?.getStatus) return null
    try {
      return backend.getStatus()
    } catch {
      return null
    }
  }

  async function backendAction(
    name: string,
    action: string,
    payload: BackendActionPayload = {}
  ): Promise<BackendActionResult> {
    const backend = registry.get(name)
    if (!backend) return { ok: false, reason: 'unknown-backend' }
    try {
      if (action === 'probe') {
        if (!backend.probe) return { ok: false, reason: 'unsupported-action' }
        const ready = await backend.probe(true)
        return ready ? { ok: true } : { ok: false, reason: 'backend-not-configured' }
      }
      if (action === 'sync') {
        if (!backend.forceSync) return { ok: false, reason: 'unsupported-action' }
        await backend.forceSync()
        return { ok: true }
      }
      if (action === 'unlock') {
        if (!backend.unlockStore) return { ok: false, reason: 'unsupported-action' }
        await backend.unlockStore(String(payload.password || ''))
        return { ok: true }
      }
      if (action === 'sign-in') {
        if (!backend.signIn) return { ok: false, reason: 'unsupported-action' }
        await backend.signIn(payload)
        return { ok: true }
      }
      return { ok: false, reason: 'unknown-action' }
    } catch (error) {
      return {
        ok: false,
        reason: (error as CodedError)?.code || 'backend-action-failed',
        message: errorMessage(error)
      }
    }
  }

  async function getSuggestions(hostname: string, requestedProfileId?: string): Promise<PasswordSuggestion[]> {
    const domain = domainOf(hostname)
    if (!domain) return []
    const profileId = profileOf(requestedProfileId)
    const active = activeBackend()
    const fallback = fallbackBackend()
    const [activeResult, fallbackResult] = await Promise.allSettled([
      active.getSuggestions(hostname, profileId),
      fallback ? fallback.getSuggestions(hostname, profileId) : Promise.resolve([])
    ])
    if (activeResult.status === 'rejected' && !fallback) throw activeResult.reason
    if (activeResult.status === 'rejected') {
      console.warn('[domain-password] 外部后端查询失败，仅使用内置库:', errorMessage(activeResult.reason))
    }
    const activeRows = activeResult.status === 'fulfilled'
      ? activeResult.value.map((row) => ({ ...row, domain: row.domain || domain }))
      : []
    const fallbackRows = fallbackResult.status === 'fulfilled' ? fallbackResult.value : []
    const rows = mergeSuggestionRows(activeRows, fallbackRows)
    return filterMatchingCredentials(rows, hostname).map((row) => ({
      ...row,
      masked: maskPassword(row.password)
    }))
  }

  async function saveCredential(input: PasswordCredentialInput): Promise<SaveCredentialResult | false> {
    const request = { ...input, profileId: profileOf(input.profileId) }
    if (neverSave.isNeverSave(request.hostname, request.profileId)) return false
    const active = activeBackend()
    const target = fallbackBackend() || active
    const saved = await target.saveCredential(request)
    if (!saved) return false
    const result: SaveCredentialResult = {
      ok: true,
      strength: passwordStrength(request.password)
    }
    if (target.name !== active.name) result.backend = target.name
    return result
  }

  async function importCredentials(
    source: string | readonly PasswordImportRow[],
    importOptions: PasswordImportOptions = {}
  ): Promise<PasswordImportResult> {
    const parsed = typeof source === 'string'
      ? parseCredentialCsv(source)
      : { rows: Array.isArray(source) ? source : [], skipped: 0 }
    const profileId = profileOf(importOptions.profileId)
    let target = importOptions.backend ? registry.get(importOptions.backend) : activeBackend()
    if (!target?.importCredentials) target = registry.get('builtin') || builtin

    const base = {
      imported: 0,
      merged: 0,
      skipped: parsed.skipped,
      total: parsed.rows.length + parsed.skipped
    }
    if (!parsed.rows.length) return base
    if (!target.importCredentials) return { ...base, skipped: base.total, unsupported: true }

    const applied = await target.importCredentials(parsed.rows, profileId)
    const result: PasswordImportResult = {
      imported: applied.imported || 0,
      merged: applied.merged || 0,
      skipped: (applied.skipped || 0) + parsed.skipped,
      total: (applied.total || 0) + parsed.skipped
    }
    if (!applied.ok) result.reason = applied.reason || 'import-failed'
    return result
  }

  return {
    listBackends,
    getBackendStatus,

    setActiveBackend(name) {
      return registry.setActive(name)
    },

    getActiveBackend() {
      return registry.activeNameValue()
    },

    backendAction,
    isAvailable: () => activeBackend().isAvailable(),

    registerBackend(backend: PasswordBackend, registerOptions: RegisterBackendOptions = {}) {
      return registry.register(backend, registerOptions)
    },

    unregisterBackend(name) {
      return registry.unregister(name)
    },

    getSuggestions,

    setProfile(profileId) {
      neverSave.setCurrentProfile(profileId || 'default')
    },

    saveCredential,
    importCredentials,

    deleteCredential(id, profileId) {
      return managementBackend().deleteCredential(id, profileOf(profileId))
    },

    async revealCredential(id, profileId): Promise<CredentialSecret | null> {
      const target = managementBackend()
      if (!target.getCredential) return null
      return target.getCredential(id, profileOf(profileId))
    },

    updateCredential(input: CredentialUpdateInput): Promise<boolean> {
      const target = managementBackend()
      if (!target.updateCredential) return Promise.resolve(false)
      return target.updateCredential({ ...input, profileId: profileOf(input.profileId) })
    },

    async exportCredentials(profileId?: string): Promise<PasswordImportSourceRow[]> {
      const target = managementBackend()
      if (!target.exportCredentials) return []
      return target.exportCredentials(profileOf(profileId))
    },

    async listCredentials(profileId?: string): Promise<SavedCredential[]> {
      const targetProfileId = profileOf(profileId)
      const active = activeBackend()
      const fallback = fallbackBackend()
      const [activeResult, fallbackResult] = await Promise.allSettled([
        active.listCredentials(targetProfileId),
        fallback ? fallback.listCredentials(targetProfileId) : Promise.resolve([])
      ])
      if (activeResult.status === 'rejected' && !fallback) throw activeResult.reason
      if (activeResult.status === 'rejected') {
        console.warn('[domain-password] 外部后端列表失败，仅使用内置库:', errorMessage(activeResult.reason))
      }
      const activeRows = activeResult.status === 'fulfilled' ? activeResult.value : []
      const fallbackRows = fallbackResult.status === 'fulfilled' ? fallbackResult.value : []
      const rows = mergeCredentialRows(activeRows, fallbackRows)
      return rows
    },

    auditCredentials(profileId?: string): Promise<PasswordAuditResult> {
      const target = fallbackBackend() || activeBackend()
      if (!target.auditCredentials) return Promise.resolve({ checked: 0, issues: [], unsupported: true })
      return target.auditCredentials(profileOf(profileId))
    },

    isNeverSave: neverSave.isNeverSave,
    addNeverSave: neverSave.add,
    removeNeverSave: neverSave.remove,
    getNeverSaveDomains: neverSave.list,
    setNeverSaveDomains: neverSave.replace,
    normalizeDomain: (hostname) => normalizeHostname(hostname),
    lowStrengthFlag: isWeakPassword
  }
}
