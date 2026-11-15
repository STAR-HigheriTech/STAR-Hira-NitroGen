import type {
  ContributionDefinition,
  ContributionEntry,
  ContributionItem,
  ContributionMeta,
  ContributionRegistry,
  ContributionResult,
  UnknownRecord
} from './types'

interface ContributionOptions { idField?: string }
interface ContributionBucket {
  mode: 'multi' | 'single'
  namespaced: boolean
  items: Map<string, ContributionEntry>
}

const DEFAULT_ID_FIELD = 'id'

/** Creates a typed, removable, deterministically ordered contribution registry. */
export function createContributionRegistry(options: ContributionOptions = {}): ContributionRegistry {
  const idField = options.idField || DEFAULT_ID_FIELD
  const kinds = new Map<string, ContributionBucket>()
  let sequence = 0

  const define = (kind: string, definition: ContributionDefinition = {}): string => {
    const name = String(kind || '').trim()
    if (!name) throw new Error('contribution kind is required')
    const mode = definition.mode === 'single' ? 'single' : 'multi'
    const namespaced = definition.namespaced === true
    const existing = kinds.get(name)
    if (!existing) kinds.set(name, { mode, namespaced, items: new Map() })
    else if (namespaced) existing.namespaced = true
    return name
  }

  const ensure = (kind: string): ContributionBucket => {
    const name = String(kind || '').trim()
    if (!name) throw new Error('contribution kind is required')
    if (!kinds.has(name)) define(name)
    const bucket = kinds.get(name)
    if (!bucket) throw new Error(`failed to create contribution kind: ${name}`)
    return bucket
  }

  const contribute = <T extends ContributionItem>(kind: string, item: T, meta: ContributionMeta = {}): ContributionResult<T> => {
    if (!item || typeof item !== 'object') throw new Error(`contribution to ${kind} must be an object`)
    const bucket = ensure(kind)
    const itemId = String(item[idField] || '').trim()
    if (!itemId) throw new Error(`contribution to ${kind} is missing "${idField}"`)
    const pluginId = meta.pluginId ? String(meta.pluginId) : null
    const metaOrder = Number(meta.order)
    const itemOrder = Number(item.order)
    const order = Number.isFinite(metaOrder) ? metaOrder : itemOrder
    const entry: ContributionEntry<T> = {
      item,
      pluginId,
      order: Number.isFinite(order) ? order : 0,
      seq: ++sequence
    }
    const key = bucket.namespaced && pluginId ? `${pluginId}\u0000${itemId}` : itemId
    if (bucket.mode === 'single') {
      if (bucket.namespaced && pluginId) {
        const prefix = `${pluginId}\u0000`
        for (const currentKey of bucket.items.keys()) {
          if (currentKey.startsWith(prefix)) bucket.items.delete(currentKey)
        }
      } else {
        bucket.items.clear()
      }
    }
    bucket.items.set(key, entry)
    return { ...item, pluginId: entry.pluginId, order: entry.order }
  }

  const list = <T extends ContributionItem = ContributionItem>(kind: string): ContributionResult<T>[] => {
    const bucket = kinds.get(String(kind || '').trim())
    if (!bucket) return []
    return Array.from(bucket.items.values())
      .sort((left, right) => (left.order - right.order) || (left.seq - right.seq))
      .map((entry) => ({ ...entry.item, pluginId: entry.pluginId, order: entry.order } as ContributionResult<T>))
  }

  const get = <T extends ContributionItem = ContributionItem>(kind: string, id: string): ContributionResult<T> | null => {
    const bucket = kinds.get(String(kind || '').trim())
    if (!bucket) return null
    const wanted = String(id || '').trim()
    let entry = bucket.items.get(wanted)
    if (!entry && bucket.namespaced) {
      const suffix = `\u0000${wanted}`
      for (const [key, candidate] of bucket.items) {
        if (key.endsWith(suffix)) {
          entry = candidate
          break
        }
      }
    }
    return entry ? { ...entry.item, pluginId: entry.pluginId, order: entry.order } as ContributionResult<T> : null
  }

  const remove = (kind: string, id: string, pluginId?: string): boolean => {
    const bucket = kinds.get(String(kind || '').trim())
    if (!bucket) return false
    const wanted = String(id || '').trim()
    if (!wanted) return false
    if (bucket.namespaced && pluginId) return bucket.items.delete(`${String(pluginId)}\u0000${wanted}`)
    return bucket.items.delete(wanted)
  }

  const clearPlugin = (pluginId: string): number => {
    const id = String(pluginId || '')
    if (!id) return 0
    let removed = 0
    for (const bucket of kinds.values()) {
      for (const [key, entry] of Array.from(bucket.items.entries())) {
        if (entry.pluginId === id) {
          bucket.items.delete(key)
          removed += 1
        }
      }
    }
    return removed
  }

  const contributeFromManifest = (pluginId: string, contributes: UnknownRecord): number => {
    if (!contributes || typeof contributes !== 'object') return 0
    let count = 0
    for (const [kind, value] of Object.entries(contributes)) {
      const items: unknown[] = Array.isArray(value) ? value : [value]
      for (const candidate of items) {
        if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) continue
        contribute(kind, candidate as ContributionItem, { pluginId })
        count += 1
      }
    }
    return count
  }

  return {
    define,
    contribute,
    list,
    get,
    remove,
    clearPlugin,
    contributeFromManifest,
    kinds: () => Array.from(kinds.keys()),
    reset: () => {
      kinds.clear()
      sequence = 0
    }
  }
}
