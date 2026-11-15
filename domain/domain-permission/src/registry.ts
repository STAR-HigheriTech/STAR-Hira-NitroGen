import type {
  CreatePendingRequestInput,
  PermissionGrantRegistry,
  PermissionRequestRegistry,
  PendingPermissionRequest,
  RegisterPendingResult
} from './types'

export class InMemoryPermissionRequestRegistry implements PermissionRequestRegistry {
  readonly #requests = new Map<string, PendingPermissionRequest>()
  readonly #keys = new Map<string, string>()
  readonly #requestKeys = new Map<string, string>()

  findIdByKey(key: string): string | null {
    const id = this.#keys.get(key)
    return id && this.#requests.has(id) ? id : null
  }

  register(key: string, input: CreatePendingRequestInput): RegisterPendingResult {
    const existingId = this.findIdByKey(key)
    if (existingId) {
      const existing = this.#requests.get(existingId)
      if (existing) existing.waiters.push({ callback: input.callback, scopeId: input.scopeId })
      return { id: existingId, created: false }
    }

    this.#requests.set(input.id, {
      origin: input.origin,
      permissionType: input.permissionType,
      profileId: input.profileId,
      waiters: [{ callback: input.callback, scopeId: input.scopeId }],
      createdAt: input.createdAt
    })
    this.#keys.set(key, input.id)
    this.#requestKeys.set(input.id, key)
    return { id: input.id, created: true }
  }

  get(id: string): PendingPermissionRequest | undefined {
    return this.#requests.get(id)
  }

  remove(id: string): PendingPermissionRequest | undefined {
    const request = this.#requests.get(id)
    if (!request) return undefined
    this.#requests.delete(id)
    const key = this.#requestKeys.get(id)
    if (key) this.#keys.delete(key)
    this.#requestKeys.delete(id)
    return request
  }

  entries(): IterableIterator<[string, PendingPermissionRequest]> {
    return this.#requests.entries()
  }

  values(): IterableIterator<PendingPermissionRequest> {
    return this.#requests.values()
  }

  clear(): void {
    this.#requests.clear()
    this.#keys.clear()
    this.#requestKeys.clear()
  }
}

export class InMemoryPermissionGrantRegistry implements PermissionGrantRegistry {
  readonly #grants = new Set<string>()

  add(key: string): void {
    this.#grants.add(key)
  }

  has(key: string): boolean {
    return this.#grants.has(key)
  }

  removeScope(prefix: string): number {
    let removed = 0
    for (const key of this.#grants) {
      if (!key.startsWith(prefix)) continue
      this.#grants.delete(key)
      removed++
    }
    return removed
  }
}

/**
 * Process-wide stores preserve the existing multi-profile contract: a prompt is
 * global to the process, while its persistence target belongs to the request.
 */
export const sharedPermissionRequests = new InMemoryPermissionRequestRegistry()
export const sharedPermissionGrants = new InMemoryPermissionGrantRegistry()
