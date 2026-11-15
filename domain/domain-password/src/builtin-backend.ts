import { generateId } from '@hira-ng/shared-utils'
import {
  buildUpsertKey,
  canonicalDomain,
  domainOf,
  filterMatchingCredentials,
  normalizeUsername,
  passwordStrength,
  passwordIssues
} from './password-utils'
import type {
  BackendImportResult,
  BreachProvider,
  CredentialSecret,
  CredentialUpdateInput,
  NormalizedCredentialInput,
  PasswordAuditIssue,
  PasswordAuditKind,
  PasswordAuditResult,
  PasswordBackend,
  PasswordCredentialRepository,
  PasswordCryptoProvider,
  PasswordImportRow,
  PasswordRow,
  PasswordSuggestion,
  PasswordWriteOperation,
  SavedCredential
} from './types'

export interface BuiltinBackendOptions {
  repository: PasswordCredentialRepository
  crypto: PasswordCryptoProvider
  backend?: string
  manager?: string
  available?: () => boolean
  breachProvider?: BreachProvider | null
  now?: () => number
  createId?: (prefix: string) => string
}

function toPublicCredential(row: PasswordRow, manager: string): SavedCredential {
  return {
    id: row.id,
    domain: canonicalDomain(row.domain),
    username: row.username,
    lastUsedAt: row.lastUsedAt,
    createdAt: row.createdAt,
    manager,
    backendRef: row.backendRef
  }
}

export function createBuiltinBackend(options: BuiltinBackendOptions): PasswordBackend {
  const {
    repository,
    crypto,
    backend = 'builtin',
    manager = 'Builtin',
    available,
    breachProvider = null,
    now = Date.now,
    createId = generateId
  } = options

  const canEncrypt = (): boolean =>
    typeof crypto?.isAvailable === 'function' &&
    crypto.isAvailable() &&
    (typeof available !== 'function' || available())

  const encrypt = (plain: string): string | null => canEncrypt() ? crypto.encrypt(plain) : null
  const decrypt = (cipher: string | null): string | null => canEncrypt() && cipher ? crypto.decrypt(cipher) : null

  function listRows(profileId: string): PasswordRow[] {
    return repository.list(profileId || 'default', backend)
  }

  function matchingSiblings(row: PasswordRow): PasswordRow[] {
    const domain = canonicalDomain(row.domain)
    const user = normalizeUsername(row.username)
    return listRows(row.profileId).filter((sibling) =>
      canonicalDomain(sibling.domain) === domain && normalizeUsername(sibling.username) === user
    )
  }

  function findRow(profileId: string, id: string): PasswordRow | null {
    if (!id) return null
    return listRows(profileId).find((row) => row.id === id) || null
  }

  return {
    name: backend,
    canWrite: true,
    isAvailable: canEncrypt,

    async getSuggestions(hostname, profileId = 'default'): Promise<PasswordSuggestion[]> {
      const domain = domainOf(hostname)
      if (!domain) return []
      const candidates = listRows(profileId).map((row) => ({ ...row, domain: canonicalDomain(row.domain) }))
      return filterMatchingCredentials(candidates, hostname).map((row) => {
        const password = decrypt(row.encryptedPassword)
        if (password === null && row.encryptedPassword) {
          console.warn(`[domain-password] 密文无法解密，domain=${row.domain}`)
        }
        return {
          id: row.id,
          domain: row.domain,
          username: row.username,
          password: password || '',
          manager
        }
      })
    },

    async saveCredential(input: NormalizedCredentialInput) {
      const domain = domainOf(input.hostname)
      const normalizedUser = normalizeUsername(input.username)
      const storedUsername = String(input.username ?? '').trim()
      const plainPassword = String(input.password ?? '')
      if (!domain || !normalizedUser || !storedUsername || !plainPassword) return false

      const encryptedPassword = encrypt(plainPassword)
      if (encryptedPassword === null) {
        console.error(`[domain-password] 加密不可用，拒绝保存 ${domain}`)
        return false
      }

      const profileId = input.profileId || 'default'
      const key = buildUpsertKey(domain, normalizedUser)
      const siblings = listRows(profileId).filter((row) =>
        canonicalDomain(row.domain) === domain && normalizeUsername(row.username) === normalizedUser
      )
      const timestamp = now()
      const operations: PasswordWriteOperation[] = siblings
        .filter((row) => row.domain !== domain)
        .map((row) => ({ type: 'update', id: row.id, values: { domain } }))

      if (siblings.length) {
        operations.push({
          type: 'update',
          id: siblings[0].id,
          values: { encryptedPassword, lastUsedAt: timestamp }
        })
      } else {
        operations.push({
          type: 'insert',
          row: {
            id: createId('pwd'),
            profileId,
            backend,
            domain,
            username: storedUsername,
            backendRef: null,
            encryptedPassword,
            lastUsedAt: timestamp,
            createdAt: timestamp
          }
        })
      }
      repository.write(operations)
      return { ok: true as const, key }
    },

    async deleteCredential(id: string, profileId = 'default'): Promise<boolean> {
      const target = findRow(profileId, id)
      if (!target) return false
      const siblings = matchingSiblings(target)
      repository.write(siblings.map((row) => ({ type: 'delete', id: row.id })))
      return true
    },

    async getCredential(id: string, profileId = 'default'): Promise<CredentialSecret | null> {
      const row = findRow(profileId, id)
      if (!row) return null
      const password = decrypt(row.encryptedPassword)
      if (password === null) return null
      return {
        id: row.id,
        domain: canonicalDomain(row.domain),
        username: row.username,
        password,
        manager,
        strength: passwordStrength(password)
      }
    },

    async updateCredential(input: CredentialUpdateInput): Promise<boolean> {
      const profileId = input.profileId || 'default'
      const target = findRow(profileId, input.id)
      const domain = domainOf(input.hostname)
      const username = String(input.username ?? '').trim()
      const password = String(input.password ?? '')
      if (!target || !domain || !normalizeUsername(username) || !password) return false
      const encryptedPassword = encrypt(password)
      if (encryptedPassword === null) return false

      const key = buildUpsertKey(domain, username)
      const conflicts = listRows(profileId).filter((row) =>
        row.id !== target.id && buildUpsertKey(canonicalDomain(row.domain), row.username) === key
      )
      const operations: PasswordWriteOperation[] = [{
        type: 'update',
        id: target.id,
        values: {
          domain,
          username,
          encryptedPassword,
          lastUsedAt: now()
        }
      }, ...conflicts.map((row): PasswordWriteOperation => ({ type: 'delete', id: row.id }))]
      repository.write(operations)
      return true
    },

    async listCredentials(profileId = 'default'): Promise<SavedCredential[]> {
      const seen = new Set<string>()
      const result: SavedCredential[] = []
      for (const row of listRows(profileId)) {
        const publicRow = toPublicCredential(row, manager)
        const key = buildUpsertKey(publicRow.domain, publicRow.username)
        if (seen.has(key)) continue
        seen.add(key)
        result.push(publicRow)
      }
      return result
    },

    async exportCredentials(profileId = 'default'): Promise<Array<{ domain: string; username: string; password: string }>> {
      const seen = new Set<string>()
      const rows: Array<{ domain: string; username: string; password: string }> = []
      for (const row of listRows(profileId)) {
        const domain = canonicalDomain(row.domain)
        const key = buildUpsertKey(domain, row.username)
        if (!domain || seen.has(key)) continue
        seen.add(key)
        const password = decrypt(row.encryptedPassword)
        if (password === null) throw new Error(`无法解密 ${domain} 的密码，已取消导出`)
        rows.push({ domain, username: row.username, password })
      }
      return rows
    },

    async importCredentials(rows: readonly PasswordImportRow[], profileId: string): Promise<BackendImportResult> {
      const list = Array.isArray(rows) ? rows : []
      const result: BackendImportResult = {
        imported: 0,
        merged: 0,
        skipped: 0,
        total: list.length,
        ok: true
      }
      if (!list.length) return result
      if (!canEncrypt()) {
        console.error('[domain-password] 加密不可用，拒绝导入')
        return { ...result, skipped: list.length, ok: false, reason: 'encryption-unavailable' }
      }

      const existingByKey = new Map<string, string>()
      for (const row of listRows(profileId)) {
        existingByKey.set(buildUpsertKey(canonicalDomain(row.domain), row.username), row.id)
      }

      const plan = new Map<string, { id: string; domain: string; username: string; cipher: string; replacing: boolean }>()
      for (const row of list) {
        const domain = domainOf(row?.domain || row?.hostname)
        const username = String(row?.username ?? '').trim()
        const password = typeof row?.password === 'string' ? row.password : ''
        if (!domain || !username || !password) continue
        const cipher = encrypt(password)
        if (!cipher) continue
        const key = buildUpsertKey(domain, username)
        const existingId = existingByKey.get(key)
        plan.set(key, {
          id: existingId || createId('pwd'),
          domain,
          username,
          cipher,
          replacing: Boolean(existingId)
        })
      }

      const timestamp = now()
      const operations: PasswordWriteOperation[] = []
      for (const item of plan.values()) {
        if (item.replacing) {
          operations.push({
            type: 'update',
            id: item.id,
            values: { domain: item.domain, encryptedPassword: item.cipher, lastUsedAt: timestamp }
          })
          result.merged++
        } else {
          operations.push({
            type: 'insert',
            row: {
              id: item.id,
              profileId,
              backend,
              domain: item.domain,
              username: item.username,
              backendRef: null,
              encryptedPassword: item.cipher,
              lastUsedAt: timestamp,
              createdAt: timestamp
            }
          })
          result.imported++
        }
      }
      repository.write(operations)
      result.skipped = list.length - plan.size
      return result
    },

    async auditCredentials(profileId = 'default'): Promise<PasswordAuditResult> {
      const seen = new Set<string>()
      const entries: Array<{ id: string; domain: string; username: string; plain: string }> = []
      for (const row of listRows(profileId)) {
        const domain = canonicalDomain(row.domain)
        const key = buildUpsertKey(domain, row.username)
        if (seen.has(key)) continue
        seen.add(key)
        let plain = ''
        try {
          plain = decrypt(row.encryptedPassword) || ''
        } catch {
          plain = ''
        }
        entries.push({ id: row.id, domain, username: row.username, plain })
      }

      const usage = new Map<string, number>()
      for (const entry of entries) {
        if (entry.plain) usage.set(entry.plain, (usage.get(entry.plain) || 0) + 1)
      }

      let breached: Set<string> | null = null
      if (breachProvider && usage.size) {
        breached = new Set<string>()
        for (const password of usage.keys()) {
          try {
            if (await breachProvider.check(password)) breached.add(password)
          } catch {
            // 外部体检失败不污染本地结论
          }
        }
      }

      const issues: PasswordAuditIssue[] = []
      for (const entry of entries) {
        const kinds: PasswordAuditKind[] = [...passwordIssues(entry.plain)]
        if (entry.plain && (usage.get(entry.plain) || 0) > 1) kinds.push('reused')
        if (entry.plain && breached?.has(entry.plain)) kinds.push('breached')
        if (kinds.length) {
          issues.push({ id: entry.id, domain: entry.domain, username: entry.username, kinds })
        }
      }
      for (const entry of entries) entry.plain = ''
      return { checked: entries.length, issues }
    }
  }
}

export function createKeychainBackend(
  options: Omit<BuiltinBackendOptions, 'backend' | 'manager' | 'available'> & { crypto: PasswordCryptoProvider }
): PasswordBackend {
  return createBuiltinBackend({
    ...options,
    backend: 'keychain',
    manager: 'Keychain',
    available: () => typeof options.crypto.isOsKeychain === 'function' && options.crypto.isOsKeychain()
  })
}
