import { generateId } from '@hira-ng/shared-utils'
import { canonicalDomain, domainLevelDomains, domainOf, matchesNeverSave } from './password-utils'
import type { NeverSaveRow, PasswordNeverSaveRepository } from './types'

export interface NeverSavePolicy {
  currentProfile(): string
  setCurrentProfile(profileId?: string | null): void
  isNeverSave(hostname: string, profileId?: string): boolean
  add(hostname: string, profileId?: string): boolean
  remove(hostname: string, profileId?: string): boolean
  list(profileId?: string): string[]
  replace(domains: readonly unknown[], profileId?: string): void
}

export function createNeverSavePolicy(
  repository: PasswordNeverSaveRepository,
  initialProfileId = 'default',
  now: () => number = Date.now
): NeverSavePolicy {
  let activeProfileId = initialProfileId || 'default'
  const cache = new Map<string, string[]>()

  function profileOf(profileId?: string | null): string {
    return profileId || activeProfileId
  }

  function normalizeDomain(value: unknown): string {
    return domainLevelDomains(domainOf(value))[0] || ''
  }

  function list(profileId?: string): string[] {
    const id = profileOf(profileId)
    const cached = cache.get(id)
    if (cached) return cached.slice()
    const domains = repository.list(id).map((row) => row.domain)
    cache.set(id, domains)
    return domains.slice()
  }

  function save(id: string, domains: readonly string[]): NeverSaveRow[] {
    const createdAt = now()
    const rows = domains.map((domain) => ({
      id: generateId('pwd-never'),
      profileId: id,
      domain,
      createdAt
    }))
    repository.replace(id, rows)
    cache.set(id, domains.slice())
    return rows
  }

  return {
    currentProfile: () => activeProfileId,

    setCurrentProfile(profileId) {
      activeProfileId = profileId || 'default'
      list(activeProfileId)
    },

    isNeverSave(hostname, profileId) {
      return matchesNeverSave(list(profileOf(profileId)), hostname)
    },

    add(hostname, profileId) {
      const domain = normalizeDomain(hostname)
      if (!domain) return false
      const id = profileOf(profileId)
      const domains = list(id)
      if (domains.includes(domain)) return false
      save(id, [...domains, domain])
      return true
    },

    remove(hostname, profileId) {
      const id = profileOf(profileId)
      const domain = canonicalDomain(hostname) || normalizeDomain(hostname)
      if (!domain) return false
      const domains = list(id)
      if (!domains.includes(domain)) return false
      save(id, domains.filter((item) => item !== domain))
      return true
    },

    list,

    replace(domains, profileId) {
      const id = profileOf(profileId)
      const normalized = (Array.isArray(domains) ? domains : [])
        .map(normalizeDomain)
        .filter(Boolean)
      save(id, Array.from(new Set(normalized)))
    }
  }
}
