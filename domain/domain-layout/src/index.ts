import type { LayoutCommand, LayoutDocument } from '@hira-ng/layout-model'
import {
  applyLayoutCommand,
  createDefaultLayoutDocument,
  importLayoutDocument,
  normalizeLayoutDocument
} from '@hira-ng/layout-model'

export interface LayoutScope {
  profileId: string
  spaceId?: string
  context?: string
}

export interface LayoutRecord {
  id: string
  profileId: string
  spaceId: string | null
  name: string
  kind: 'custom' | 'template' | 'imported'
  schemaVersion: number
  revision: number
  document: LayoutDocument
  createdAt: number
  updatedAt: number
}

export interface LayoutBinding {
  profileId: string
  spaceId: string | null
  context: string
  layoutId: string
}

export interface LayoutRepository {
  ensureSchema(): void
  list(profileId: string, spaceId?: string): LayoutRecord[]
  get(id: string): LayoutRecord | null
  save(record: LayoutRecord, action: string): LayoutRecord
  remove(id: string): boolean
  getBinding(scope: LayoutScope): LayoutBinding | null
  setBinding(scope: LayoutScope, layoutId: string): void
  listRevisions(layoutId: string, limit?: number): Array<{ revision: number; action: string; document: LayoutDocument; createdAt: number }>
  restoreRevision(layoutId: string, revision: number): LayoutRecord | null
}

export interface LayoutServiceOptions {
  repository: LayoutRepository
  getDefaultScope: () => LayoutScope
  now?: () => number
  createId?: () => string
}

export interface LayoutSnapshot {
  layout: LayoutRecord
  scope: LayoutScope
  restoredDefault: boolean
}

export interface LayoutDispatchResult {
  ok: boolean
  layout: LayoutRecord
  changedNodeIds: string[]
  conflict?: boolean
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}

export function createLayoutService(options: LayoutServiceOptions) {
  const { repository, getDefaultScope } = options
  const now = options.now || Date.now
  const createId = options.createId || (() => `layout-${now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`)
  repository.ensureSchema()

  function createRecord(scope: LayoutScope, kind: LayoutRecord['kind'] = 'custom'): LayoutRecord {
    const document = createDefaultLayoutDocument('当前布局')
    const stamp = now()
    return {
      id: createId(),
      profileId: scope.profileId,
      spaceId: scope.spaceId || null,
      name: document.name,
      kind,
      schemaVersion: document.schemaVersion,
      revision: 1,
      document,
      createdAt: stamp,
      updatedAt: stamp
    }
  }

  function ensureLayout(scope: LayoutScope): { layout: LayoutRecord; restoredDefault: boolean } {
    const binding = repository.getBinding(scope)
    if (binding) {
      const bound = repository.get(binding.layoutId)
      if (bound) return { layout: bound, restoredDefault: false }
    }
    const available = repository.list(scope.profileId, scope.spaceId)
    if (available.length) {
      repository.setBinding(scope, available[0].id)
      return { layout: available[0], restoredDefault: false }
    }
    const created = repository.save(createRecord(scope), 'create-default')
    repository.setBinding(scope, created.id)
    return { layout: created, restoredDefault: true }
  }

  function snapshot(scopeInput?: Partial<LayoutScope>): LayoutSnapshot {
    const base = getDefaultScope()
    const scope: LayoutScope = {
      profileId: String(scopeInput?.profileId || base.profileId),
      spaceId: scopeInput?.spaceId === undefined ? base.spaceId : scopeInput.spaceId || undefined,
      context: String(scopeInput?.context || base.context || 'default')
    }
    const result = ensureLayout(scope)
    return { layout: clone(result.layout), scope, restoredDefault: result.restoredDefault }
  }

  function dispatch(input: {
    layoutId: string
    baseRevision: number
    command: LayoutCommand
  }): LayoutDispatchResult {
    const current = repository.get(input.layoutId)
    if (!current) throw new Error(`Layout not found: ${input.layoutId}`)
    if (current.revision !== input.baseRevision) {
      return { ok: false, layout: clone(current), changedNodeIds: [], conflict: true }
    }
    const result = applyLayoutCommand(current.document, input.command)
    if (!result.changed) return { ok: true, layout: clone(current), changedNodeIds: [] }
    const next: LayoutRecord = {
      ...current,
      name: result.document.name,
      revision: current.revision + 1,
      document: result.document,
      updatedAt: now()
    }
    const saved = repository.save(next, input.command.type)
    return { ok: true, layout: clone(saved), changedNodeIds: result.changedNodeIds }
  }

  function replaceDocument(input: {
    layoutId: string
    baseRevision: number
    document: LayoutDocument
    action?: string
  }): LayoutDispatchResult {
    const current = repository.get(input.layoutId)
    if (!current) throw new Error(`Layout not found: ${input.layoutId}`)
    if (current.revision !== input.baseRevision) {
      return { ok: false, layout: clone(current), changedNodeIds: [], conflict: true }
    }
    const document = normalizeLayoutDocument(input.document)
    const next: LayoutRecord = {
      ...current,
      name: document.name,
      revision: current.revision + 1,
      document,
      updatedAt: now()
    }
    const saved = repository.save(next, input.action || 'replace-document')
    return { ok: true, layout: clone(saved), changedNodeIds: [] }
  }

  function createFromDocument(scope: LayoutScope, document: LayoutDocument, kind: LayoutRecord['kind'] = 'template'): LayoutRecord {
    const normalized = normalizeLayoutDocument(document)
    normalized.id = createId()
    const stamp = now()
    const record: LayoutRecord = {
      id: createId(),
      profileId: scope.profileId,
      spaceId: scope.spaceId || null,
      name: normalized.name,
      kind,
      schemaVersion: normalized.schemaVersion,
      revision: 1,
      document: normalized,
      createdAt: stamp,
      updatedAt: stamp
    }
    return repository.save(record, `create-${kind}`)
  }

  function importLayout(scope: LayoutScope, text: string): LayoutRecord {
    return createFromDocument(scope, importLayoutDocument(text), 'imported')
  }

  function setBinding(scope: LayoutScope, layoutId: string): void {
    repository.setBinding(scope, layoutId)
  }

  function list(scope: LayoutScope): LayoutRecord[] {
    return repository.list(scope.profileId, scope.spaceId)
  }

  function restoreRevision(layoutId: string, revision: number): LayoutRecord | null {
    return repository.restoreRevision(layoutId, revision)
  }

  function reset(scope: LayoutScope): LayoutRecord {
    const record = repository.save(createRecord(scope), 'reset-layout')
    repository.setBinding(scope, record.id)
    return record
  }

  return {
    snapshot,
    dispatch,
    replaceDocument,
    createFromDocument,
    importLayout,
    setBinding,
    list,
    restoreRevision,
    reset
  }
}

export type LayoutService = ReturnType<typeof createLayoutService>

