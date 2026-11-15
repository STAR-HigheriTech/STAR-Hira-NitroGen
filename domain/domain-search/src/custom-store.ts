import { generateId } from '@hira-ng/shared-utils'
import { isHttpUrl } from '@hira-ng/shared-types/src/url-protocols.mjs'
import type {
  CustomEntry,
  CustomEntryMode,
  CustomEntryRepository,
  CustomEntrySaveInput,
  CustomEntrySaveResult,
  CustomEntryStorageRecord,
  CustomEntryStore,
  CustomEntryStoreOptions
} from './types'

const TRIGGER_PATTERN = /^[\p{L}\p{N}._-]+$/u

const MODE_RULES: Record<CustomEntryMode, {
  label: string
  deriveTrigger: boolean
  uniqueBy: 'trigger' | 'title'
}> = {
  bang: { label: '自定义 bang', deriveTrigger: false, uniqueBy: 'trigger' },
  engine: { label: '自定义搜索引擎', deriveTrigger: true, uniqueBy: 'title' }
}

export function normalizeTrigger(raw: unknown): string {
  return String(raw == null ? '' : raw)
    .trim()
    .replace(/^!+/, '')
    .replace(/\s+/g, '')
    .toLowerCase()
}

export function normalizeUrl(raw: unknown): string {
  return String(raw == null ? '' : raw).trim()
}

export function isValidUrlTemplate(url: string): boolean {
  return isHttpUrl(url)
}

export function looksLikeUrl(raw: unknown): boolean {
  return isValidUrlTemplate(normalizeUrl(raw))
}

export function hostFromUrl(raw: unknown): string {
  const url = normalizeUrl(raw)
  if (!isValidUrlTemplate(url)) return ''
  try {
    return String(new URL(url).hostname || '').replace(/^www\./i, '')
  } catch {
    return ''
  }
}

export function triggerFromTitle(raw: unknown): string {
  const trigger = normalizeTrigger(raw)
  return trigger && TRIGGER_PATTERN.test(trigger) ? trigger : ''
}

function toEntry(row: CustomEntryStorageRecord | null): CustomEntry | null {
  if (!row) return null
  const rawTitle = String(row.title == null ? '' : row.title).trim()
  return {
    id: row.id,
    trigger: row.trigger,
    title: rawTitle && !looksLikeUrl(rawTitle)
      ? rawTitle
      : hostFromUrl(row.url) || rawTitle || String(row.trigger || ''),
    url: row.url,
    showSuggestions: Number(row.showSuggestions) !== 0,
    hitCount: Number(row.hitCount) || 0,
    createdAt: Number(row.createdAt) || 0,
    updatedAt: Number(row.updatedAt) || 0
  }
}

export function createCustomEntryStore(
  repository: CustomEntryRepository,
  options: CustomEntryStoreOptions
): CustomEntryStore {
  const profileId = options.profileId || 'default'
  const rules = MODE_RULES[options.mode] || MODE_RULES.bang
  const createId = options.createId || generateId
  const now = options.now || Date.now

  function list(): CustomEntry[] {
    return repository.list(profileId).map(toEntry).filter((entry): entry is CustomEntry => entry !== null)
  }

  function findByTrigger(trigger: string): CustomEntry | null {
    const normalized = normalizeTrigger(trigger)
    if (!normalized) return null
    return toEntry(repository.findByTrigger(profileId, normalized))
  }

  function findByTitle(title: string): CustomEntry | null {
    const wanted = String(title == null ? '' : title).trim().toLowerCase()
    if (!wanted) return null
    return list().find((entry) => entry.title.trim().toLowerCase() === wanted) || null
  }

  function uniqueTrigger(base: string, excludeId: string): string {
    let candidate = base
    for (let index = 2; index <= 100; index += 1) {
      const clash = findByTrigger(candidate)
      if (!clash || clash.id === excludeId) return candidate
      candidate = `${base}-${index}`
    }
    return `${base}-${now()}`
  }

  function getById(id: string): CustomEntry | null {
    if (!id) return null
    return toEntry(repository.findById(profileId, String(id)))
  }

  function save(input: CustomEntrySaveInput): CustomEntrySaveResult {
    const raw = input && typeof input === 'object' ? input : {}
    const id = String(raw.id || '').trim()
    const url = normalizeUrl(raw.url)
    if (!url) return { ok: false, error: 'URL 模板不能为空' }
    if (!isValidUrlTemplate(url)) {
      return { ok: false, error: 'URL 模板必须以 http:// 或 https:// 开头' }
    }

    const titleInput = String(raw.title == null ? '' : raw.title).trim()
    let title = ''
    let trigger = ''

    if (rules.deriveTrigger) {
      title = titleInput && !looksLikeUrl(titleInput) ? titleInput : ''
      if (!title) title = hostFromUrl(url) || titleInput || '自定义搜索引擎'
      trigger = uniqueTrigger(
        triggerFromTitle(title) || triggerFromTitle(hostFromUrl(url)) || 'engine',
        id
      )
    } else {
      trigger = normalizeTrigger(raw.trigger)
      if (!trigger) return { ok: false, error: '触发词不能为空' }
      if (!TRIGGER_PATTERN.test(trigger)) {
        return { ok: false, error: '触发词只能包含字母、数字、下划线、点与短横线' }
      }
      title = titleInput || trigger
    }

    const showSuggestions = raw.showSuggestions === undefined ? true : Boolean(raw.showSuggestions)
    const timestamp = now()
    const clash = rules.uniqueBy === 'title' ? findByTitle(title) : findByTrigger(trigger)
    if (clash && (!id || clash.id !== id)) {
      return {
        ok: false,
        error: rules.uniqueBy === 'title'
          ? `名称「${title}」已被占用`
          : `触发词 !${trigger} 已被占用`
      }
    }

    if (id) {
      if (!repository.findById(profileId, id)) return { ok: false, error: `${rules.label}不存在` }
      repository.update(profileId, id, {
        trigger,
        title,
        url,
        showSuggestions: showSuggestions ? 1 : 0,
        updatedAt: timestamp
      })
      const entry = toEntry(repository.findById(profileId, id))
      return entry ? { ok: true, entry } : { ok: false, error: `${rules.label}保存失败` }
    }

    const record: CustomEntryStorageRecord = {
      id: createId(options.idPrefix),
      profileId,
      trigger,
      title,
      url,
      showSuggestions: showSuggestions ? 1 : 0,
      hitCount: 0,
      createdAt: timestamp,
      updatedAt: timestamp
    }
    repository.insert(record)
    const entry = toEntry(record)
    return entry ? { ok: true, entry } : { ok: false, error: `${rules.label}保存失败` }
  }

  function remove(id: string): { removed: boolean } {
    if (!id) return { removed: false }
    return { removed: repository.remove(profileId, String(id)) > 0 }
  }

  function recordUse(id: string): { ok: boolean } {
    if (!id || !repository.findById(profileId, String(id))) return { ok: false }
    repository.incrementHitCount(profileId, String(id))
    return { ok: true }
  }

  return { list, findByTrigger, getById, save, remove, recordUse }
}
