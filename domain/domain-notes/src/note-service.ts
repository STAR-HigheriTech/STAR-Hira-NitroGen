import { noteFolders, noteRefs, notes } from '@hira-ng/infra-db/schema'
import {
  and as drizzleAnd,
  asc as drizzleAsc,
  desc as drizzleDesc,
  eq as drizzleEq,
  isNotNull as drizzleIsNotNull,
  isNull as drizzleIsNull,
  like as drizzleLike,
  or as drizzleOr,
  sql
} from 'drizzle-orm'
import { generateId } from '@hira-ng/shared-utils'
import {
  NOTE_KINDS,
  parseNoteRefUris as parseSharedNoteRefUris
} from '@hira-ng/shared-types/src/notes.mjs'
import {
  errorMessage,
  normalizeKind,
  normalizeNote,
  normalizeRefMode,
  serializeTags,
  toDimension
} from './note-normalizers'
import type {
  AddFolderInput,
  AddNoteInput,
  BacklinkNote,
  CaptureNoteInput,
  ListNotesOptions,
  Note,
  NoteChangeListener,
  NoteChangeReason,
  NoteFolder,
  NoteKind,
  NoteRefOrigin,
  NoteRow,
  NoteService,
  NoteServiceOptions,
  UpdateNoteInput
} from './types'

type Condition = unknown
type BinaryCondition = (column: unknown, value: unknown) => Condition
type UnaryCondition = (column: unknown) => Condition
type CombineCondition = (...conditions: Condition[]) => Condition
type OrderValue = (column: unknown) => unknown

const eq = drizzleEq as unknown as BinaryCondition
const like = drizzleLike as unknown as BinaryCondition
const and = drizzleAnd as unknown as CombineCondition
const or = drizzleOr as unknown as CombineCondition
const isNull = drizzleIsNull as unknown as UnaryCondition
const isNotNull = drizzleIsNotNull as unknown as UnaryCondition
const asc = drizzleAsc as unknown as OrderValue
const desc = drizzleDesc as unknown as OrderValue

type RunResult = { changes?: number | bigint }
type Sequence = {
  where(condition: Condition): Sequence
  orderBy(...values: unknown[]): Sequence
  groupBy(...values: unknown[]): Sequence
  leftJoin(table: unknown, condition: Condition): Sequence
  get(): Record<string, unknown> | undefined
  all(): Record<string, unknown>[]
}
type SelectBuilder = { from(table: unknown): Sequence }
type WriteBuilder = {
  run(): RunResult
  onConflictDoNothing(): { run(): RunResult }
}

interface NoteDatabase {
  select(): SelectBuilder
  select(projection: Record<string, unknown>): SelectBuilder
  insert(table: unknown): { values(value: Record<string, unknown>): WriteBuilder }
  update(table: unknown): {
    set(value: Record<string, unknown>): { where(condition: Condition): WriteBuilder }
  }
  delete(table: unknown): { where(condition: Condition): WriteBuilder }
  transaction<T>(callback: (tx: NoteDatabase) => T): T
}

interface EdgeJoinRow {
  edge: { fromNoteId: string }
  note: NoteRow | null
}

const parseNoteRefUris = parseSharedNoteRefUris as unknown as (content: string) => readonly string[]
const noteKinds = NOTE_KINDS as readonly NoteKind[]

export function createNoteService(
  db: NoteDatabase,
  options: NoteServiceOptions = {}
): NoteService {
  const now = () => Date.now()
  const profileIdPort = typeof options.getProfileId === 'function' ? options.getProfileId : null

  function currentProfile(): string {
    if (!profileIdPort) return 'default'
    try {
      const value = profileIdPort()
      return value ? String(value) : 'default'
    } catch {
      return 'default'
    }
  }

  const profileCond = () => eq(notes.profileId, currentProfile())
  const folderProfileCond = () => eq(noteFolders.profileId, currentProfile())

  const changeListeners = new Set<NoteChangeListener>()
  function emitChange(reason: NoteChangeReason, id: string | null = null): void {
    for (const listener of changeListeners) {
      try {
        listener({ reason, id })
      } catch (error) {
        console.error('[note-service] change listener error:', errorMessage(error))
      }
    }
  }

  function subscribe(listener: NoteChangeListener): () => void {
    changeListeners.add(listener)
    return () => {
      changeListeners.delete(listener)
    }
  }

  function insertRefEdge(
    tx: NoteDatabase,
    fromId: string,
    toId: string,
    timestamp: number,
    origin: NoteRefOrigin = 'card'
  ): void {
    tx.insert(noteRefs)
      .values({
        profileId: currentProfile(),
        fromNoteId: fromId,
        toNoteId: toId,
        origin,
        createdAt: timestamp
      })
      .onConflictDoNothing()
      .run()
  }

  function nextNoteSortOrder(folderId: string | null): number {
    const folderCondition = folderId == null ? isNull(notes.folderId) : eq(notes.folderId, folderId)
    const row = db.select({ maxOrder: sql`MAX(sort_order)` })
      .from(notes)
      .where(and(folderCondition, profileCond()))
      .get()
    return (Number(row?.maxOrder) || 0) + 1
  }

  function nextFolderSortOrder(parentId: string | null): number {
    const parentCondition = parentId == null
      ? isNull(noteFolders.parentId)
      : eq(noteFolders.parentId, parentId)
    const row = db.select({ maxOrder: sql`MAX(sort_order)` })
      .from(noteFolders)
      .where(and(parentCondition, folderProfileCond()))
      .get()
    return (Number(row?.maxOrder) || 0) + 1
  }

  function add(input: AddNoteInput = {}): Note | null {
    const timestamp = now()
    const id = generateId('note')
    const folderId = input.folderId == null ? null : String(input.folderId)
    const refId = input.refId == null || input.refId === '' ? null : String(input.refId)
    const kind = refId ? 'ref' : normalizeKind(input.kind)
    const sortOrder = nextNoteSortOrder(folderId)

    db.transaction((tx) => {
      tx.insert(notes).values({
        id,
        profileId: currentProfile(),
        folderId,
        title: String(input.title || '').slice(0, 200),
        content: String(input.content || ''),
        url: input.url == null ? null : String(input.url),
        tags: serializeTags(input.tags),
        color: input.color == null ? null : String(input.color),
        kind,
        sourceTitle: input.sourceTitle == null ? null : String(input.sourceTitle),
        assetPath: input.assetPath == null ? null : String(input.assetPath),
        assetMime: input.assetMime == null ? null : String(input.assetMime),
        assetWidth: toDimension(input.assetWidth),
        assetHeight: toDimension(input.assetHeight),
        thumbPath: input.thumbPath == null ? null : String(input.thumbPath),
        refId,
        refMode: refId ? normalizeRefMode(input.refMode) : null,
        pinned: 0,
        sortOrder,
        createdAt: timestamp,
        modifiedAt: timestamp
      }).run()
      if (refId) insertRefEdge(tx, id, refId, timestamp)
    })

    emitChange('add', id)
    return get(id)
  }

  function get(id: string): Note | null {
    if (!id) return null
    const row = db.select().from(notes)
      .where(and(eq(notes.id, id), profileCond()))
      .get() as unknown as NoteRow | undefined
    return normalizeNote(row)
  }

  function list(options: ListNotesOptions = {}): Note[] {
    const hasFolderFilter = Object.prototype.hasOwnProperty.call(options, 'folderId')
    const folderId = options.folderId ?? null
    const folderCondition = hasFolderFilter
      ? (folderId == null ? isNull(notes.folderId) : eq(notes.folderId, folderId))
      : null
    const where = folderCondition
      ? and(profileCond(), isNull(notes.deletedAt), folderCondition)
      : and(profileCond(), isNull(notes.deletedAt))
    const rows = db.select().from(notes)
      .where(where)
      .orderBy(desc(notes.pinned), asc(notes.sortOrder), desc(notes.modifiedAt))
      .all() as unknown as NoteRow[]
    return rows.map(normalizeNote).filter((note): note is Note => note !== null)
  }

  function update(id: string, patch: UpdateNoteInput = {}): Note | null {
    const timestamp = now()
    const values: Record<string, unknown> = { modifiedAt: timestamp }
    if (patch.title != null) values.title = String(patch.title).slice(0, 200)
    if (patch.content != null) values.content = String(patch.content)
    if (patch.url !== undefined) values.url = patch.url == null ? null : String(patch.url)
    if (patch.tags !== undefined) values.tags = serializeTags(patch.tags)
    if (patch.color !== undefined) values.color = patch.color == null ? null : String(patch.color)
    if (patch.pinned !== undefined) values.pinned = patch.pinned ? 1 : 0
    if (patch.sourceTitle !== undefined) {
      values.sourceTitle = patch.sourceTitle == null ? null : String(patch.sourceTitle)
    }
    if (patch.assetPath !== undefined) {
      values.assetPath = patch.assetPath == null ? null : String(patch.assetPath)
    }
    if (patch.assetMime !== undefined) {
      values.assetMime = patch.assetMime == null ? null : String(patch.assetMime)
    }
    if (patch.assetWidth !== undefined) values.assetWidth = toDimension(patch.assetWidth)
    if (patch.assetHeight !== undefined) values.assetHeight = toDimension(patch.assetHeight)
    if (patch.thumbPath !== undefined) {
      values.thumbPath = patch.thumbPath == null ? null : String(patch.thumbPath)
    }
    if (patch.refMode !== undefined) {
      values.refMode = patch.refMode == null ? null : normalizeRefMode(patch.refMode)
    }

    const refChanged = patch.refId !== undefined
    const nextRefId = refChanged
      ? (patch.refId == null || patch.refId === '' ? null : String(patch.refId))
      : null
    if (refChanged) values.refId = nextRefId

    if (patch.folderId !== undefined) {
      const targetFolderId = patch.folderId == null ? null : String(patch.folderId)
      values.folderId = targetFolderId
      values.sortOrder = nextNoteSortOrder(targetFolderId)
    }

    const previousRefId = refChanged ? (get(id)?.refId ?? null) : null
    db.transaction((tx) => {
      tx.update(notes).set(values)
        .where(and(eq(notes.id, id), profileCond()))
        .run()

      if (refChanged && previousRefId && String(previousRefId) !== nextRefId) {
        tx.delete(noteRefs).where(and(
          eq(noteRefs.fromNoteId, id),
          eq(noteRefs.toNoteId, String(previousRefId)),
          eq(noteRefs.origin, 'card'),
          eq(noteRefs.profileId, currentProfile())
        )).run()
      }
      if (refChanged && nextRefId) insertRefEdge(tx, id, nextRefId, timestamp)

      if (patch.content != null) {
        tx.delete(noteRefs).where(and(
          eq(noteRefs.fromNoteId, id),
          eq(noteRefs.origin, 'inline'),
          eq(noteRefs.profileId, currentProfile())
        )).run()
        for (const targetId of parseNoteRefUris(String(patch.content))) {
          if (targetId !== id) insertRefEdge(tx, id, targetId, timestamp, 'inline')
        }
      }
    })

    const next = get(id)
    emitChange('update', id)
    return next
  }

  function remove(id: string): boolean {
    const timestamp = now()
    const result = db.update(notes)
      .set({ deletedAt: timestamp, modifiedAt: timestamp })
      .where(and(eq(notes.id, id), profileCond(), isNull(notes.deletedAt)))
      .run()
    const removed = Number(result.changes) > 0
    if (removed) emitChange('remove', id)
    return removed
  }

  function restore(id: string): boolean {
    const result = db.update(notes)
      .set({ deletedAt: null, modifiedAt: now() })
      .where(and(eq(notes.id, id), profileCond(), isNotNull(notes.deletedAt)))
      .run()
    const restored = Number(result.changes) > 0
    if (restored) emitChange('restore', id)
    return restored
  }

  function purge(id: string): boolean {
    if (!id) return false
    let purged = false
    db.transaction((tx) => {
      tx.delete(noteRefs).where(and(
        or(eq(noteRefs.fromNoteId, id), eq(noteRefs.toNoteId, id)),
        eq(noteRefs.profileId, currentProfile())
      )).run()
      const result = tx.delete(notes)
        .where(and(eq(notes.id, id), profileCond()))
        .run()
      purged = Number(result.changes) > 0
    })
    if (purged) emitChange('purge', id)
    return purged
  }

  function listTrash(): Note[] {
    const rows = db.select().from(notes)
      .where(and(profileCond(), isNotNull(notes.deletedAt)))
      .orderBy(desc(notes.deletedAt))
      .all() as unknown as NoteRow[]
    return rows.map(normalizeNote).filter((note): note is Note => note !== null)
  }

  function emptyTrash(): number {
    const rows = db.select({ id: notes.id }).from(notes)
      .where(and(profileCond(), isNotNull(notes.deletedAt)))
      .all()
    let removed = 0
    if (rows.length === 0) return removed
    db.transaction((tx) => {
      for (const row of rows) {
        const id = String(row.id)
        tx.delete(noteRefs).where(and(
          or(eq(noteRefs.fromNoteId, id), eq(noteRefs.toNoteId, id)),
          eq(noteRefs.profileId, currentProfile())
        )).run()
        const result = tx.delete(notes)
          .where(and(eq(notes.id, id), profileCond()))
          .run()
        removed += Number(result.changes) || 0
      }
    })
    if (removed) emitChange('purge', null)
    return removed
  }

  function move(id: string, folderId: string | null): Note | null {
    return update(id, { folderId: folderId == null ? null : String(folderId) })
  }

  function setPinned(id: string, pinned: boolean): Note | null {
    return update(id, { pinned: Boolean(pinned) })
  }

  function search(query: string): Note[] {
    const term = String(query || '').trim()
    if (!term) return []
    const pattern = `%${term}%`
    const rows = db.select().from(notes)
      .where(and(
        profileCond(),
        isNull(notes.deletedAt),
        or(
          like(notes.title, pattern),
          like(notes.content, pattern),
          like(notes.tags, pattern),
          like(notes.url, pattern)
        )
      ))
      .orderBy(desc(notes.modifiedAt))
      .all() as unknown as NoteRow[]
    return rows.map(normalizeNote).filter((note): note is Note => note !== null)
  }

  function reorder(folderId: string | null, orderedIds: readonly string[]): boolean {
    if (!Array.isArray(orderedIds)) return false
    const profileCondition = profileCond()
    const folderCondition = folderId == null ? isNull(notes.folderId) : eq(notes.folderId, folderId)
    db.transaction((tx) => {
      orderedIds.forEach((id, index) => {
        tx.update(notes).set({ sortOrder: index + 1 })
          .where(and(eq(notes.id, id), folderCondition, profileCondition))
          .run()
      })
    })
    emitChange('reorder', null)
    return true
  }

  function addCaptured(input: CaptureNoteInput = {}): Note | null {
    const kind = noteKinds.includes(input.kind as NoteKind) ? (input.kind as NoteKind) : 'page'
    const url = input.url == null ? null : String(input.url)
    const folderId = input.folderId == null ? null : String(input.folderId)
    if (kind === 'page' && url) {
      const folderCondition = folderId == null ? isNull(notes.folderId) : eq(notes.folderId, folderId)
      const existing = db.select().from(notes)
        .where(and(
          profileCond(),
          folderCondition,
          eq(notes.kind, 'page'),
          eq(notes.url, url),
          isNull(notes.deletedAt)
        ))
        .get() as unknown as NoteRow | undefined
      if (existing) return normalizeNote(existing)
    }
    return add({ ...input, kind, url, folderId })
  }

  function backlinks(id: string): BacklinkNote[] {
    if (!id) return []
    const rows = db.select({ edge: noteRefs, note: notes })
      .from(noteRefs)
      .leftJoin(notes, eq(noteRefs.fromNoteId, notes.id))
      .where(and(eq(noteRefs.toNoteId, id), eq(noteRefs.profileId, currentProfile())))
      .orderBy(desc(noteRefs.createdAt))
      .all() as unknown as EdgeJoinRow[]
    return rows.map((row) => {
      if (!row.note || !row.note.id) return { id: row.edge.fromNoteId, missing: true } as BacklinkNote
      const note = normalizeNote(row.note)
      if (!note) return { id: row.edge.fromNoteId, missing: true } as BacklinkNote
      return note.deletedAt ? { ...note, missing: true } : note
    })
  }

  function refCounts(): Record<string, number> {
    const rows = db.select({ to: noteRefs.toNoteId, count: sql`COUNT(*)` })
      .from(noteRefs)
      .where(eq(noteRefs.profileId, currentProfile()))
      .groupBy(noteRefs.toNoteId)
      .all()
    const counts: Record<string, number> = {}
    for (const row of rows) counts[String(row.to)] = Number(row.count) || 0
    return counts
  }

  function listFolders(): NoteFolder[] {
    const rows = db.select().from(noteFolders)
      .where(folderProfileCond())
      .orderBy(asc(noteFolders.sortOrder), asc(noteFolders.createdAt))
      .all()
    return rows as unknown as NoteFolder[]
  }

  function addFolder(input: AddFolderInput = {}): string {
    const parentId = input.parentId == null ? null : String(input.parentId)
    const id = generateId('nfolder')
    db.insert(noteFolders).values({
      id,
      profileId: currentProfile(),
      parentId,
      name: String(input.name || '新建文件夹').slice(0, 120) || '新建文件夹',
      sortOrder: nextFolderSortOrder(parentId),
      createdAt: now()
    }).run()
    emitChange('folder-add', id)
    return id
  }

  function descendantFolders(id: string): Set<string> {
    const folders = listFolders()
    const descendants = new Set<string>()
    let grew = true
    while (grew) {
      grew = false
      for (const folder of folders) {
        if (descendants.has(folder.id)) continue
        if (folder.parentId === id || (folder.parentId && descendants.has(folder.parentId))) {
          descendants.add(folder.id)
          grew = true
        }
      }
    }
    return descendants
  }

  function moveFolder(id: string, parentId: string | null): boolean {
    const targetId = parentId == null ? null : String(parentId)
    if (!id || id === targetId) return false
    if (targetId && descendantFolders(id).has(targetId)) return false
    if (targetId && !listFolders().some((folder) => folder.id === targetId)) return false
    const result = db.update(noteFolders).set({
      parentId: targetId,
      sortOrder: nextFolderSortOrder(targetId)
    }).where(and(eq(noteFolders.id, id), folderProfileCond())).run()
    const moved = Number(result.changes) > 0
    if (moved) emitChange('folder-update', id)
    return moved
  }

  function reorderFolders(parentId: string | null, orderedIds: readonly string[]): boolean {
    if (!Array.isArray(orderedIds)) return false
    const profileCondition = folderProfileCond()
    const parentCondition = parentId == null
      ? isNull(noteFolders.parentId)
      : eq(noteFolders.parentId, parentId)
    db.transaction((tx) => {
      orderedIds.forEach((id, index) => {
        tx.update(noteFolders).set({ sortOrder: index + 1 })
          .where(and(eq(noteFolders.id, id), parentCondition, profileCondition))
          .run()
      })
    })
    emitChange('folder-update', null)
    return true
  }

  function renameFolder(id: string, name: string): boolean {
    const nextName = String(name || '').trim().slice(0, 120)
    if (!nextName) return false
    const result = db.update(noteFolders).set({ name: nextName })
      .where(and(eq(noteFolders.id, id), folderProfileCond()))
      .run()
    const renamed = Number(result.changes) > 0
    if (renamed) emitChange('folder-update', id)
    return renamed
  }

  function removeFolder(id: string): boolean {
    const doomed = new Set([id, ...descendantFolders(id)])
    let removed = false
    db.transaction((tx) => {
      for (const folderId of doomed) {
        tx.update(notes).set({ folderId: null, sortOrder: 0 })
          .where(and(eq(notes.folderId, folderId), profileCond()))
          .run()
        const result = tx.delete(noteFolders)
          .where(and(eq(noteFolders.id, folderId), folderProfileCond()))
          .run()
        if (Number(result.changes) > 0) removed = true
      }
    })
    if (removed) emitChange('folder-remove', id)
    return removed
  }

  function folderCounts(): Record<string, number> {
    const folders = listFolders()
    const rows = db.select({ folderId: notes.folderId, count: sql`COUNT(*)` })
      .from(notes)
      .where(and(profileCond(), isNull(notes.deletedAt)))
      .groupBy(notes.folderId)
      .all()
    const direct = new Map<string, number>()
    for (const row of rows) {
      if (row.folderId) direct.set(String(row.folderId), Number(row.count) || 0)
    }

    const childrenOf = new Map<string, string[]>()
    for (const folder of folders) {
      const key = folder.parentId || ''
      const children = childrenOf.get(key) ?? []
      children.push(folder.id)
      childrenOf.set(key, children)
    }

    const counts: Record<string, number> = {}
    const sum = (folderId: string): number => {
      let total = direct.get(folderId) || 0
      for (const childId of childrenOf.get(folderId) || []) total += sum(childId)
      counts[folderId] = total
      return total
    }
    for (const folder of folders) sum(folder.id)

    counts.__all = rows.reduce((total, row) => total + (Number(row.count) || 0), 0)
    counts.__unfiled = Number(rows.find((row) => row.folderId == null)?.count) || 0
    const trashRow = db.select({ count: sql`COUNT(*)` }).from(notes)
      .where(and(profileCond(), isNotNull(notes.deletedAt)))
      .get()
    counts.__trash = Number(trashRow?.count) || 0
    return counts
  }

  return {
    add,
    get,
    list,
    update,
    remove,
    move,
    setPinned,
    search,
    reorder,
    addCaptured,
    restore,
    purge,
    listTrash,
    emptyTrash,
    backlinks,
    refCounts,
    listFolders,
    addFolder,
    renameFolder,
    removeFolder,
    moveFolder,
    reorderFolders,
    descendantFolders,
    folderCounts,
    subscribe
  }
}
