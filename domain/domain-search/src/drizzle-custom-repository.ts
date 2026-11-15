import {
  and as drizzleAnd,
  asc as drizzleAsc,
  desc as drizzleDesc,
  eq as drizzleEq
} from 'drizzle-orm'
import type {
  CustomEntryRepository,
  CustomEntryStorageRecord,
  CustomEntryUpdate,
  QueryCondition,
  SearchDatabase
} from './types'

interface CustomEntryTable {
  id: unknown
  profileId: unknown
  trigger: unknown
  title: unknown
  url: unknown
  showSuggestions: unknown
  hitCount: unknown
  createdAt: unknown
  updatedAt: unknown
}
type BinaryCondition = (column: unknown, value: unknown) => QueryCondition
const eq = drizzleEq as unknown as BinaryCondition
const desc = drizzleDesc as unknown as (column: unknown) => unknown
const asc = drizzleAsc as unknown as (column: unknown) => unknown
const and = drizzleAnd as unknown as (...conditions: QueryCondition[]) => QueryCondition

function mapRow(row: Record<string, unknown>): CustomEntryStorageRecord {
  return {
    id: String(row.id),
    profileId: String(row.profileId),
    trigger: String(row.trigger),
    title: String(row.title),
    url: String(row.url),
    showSuggestions: Number(row.showSuggestions) || 0,
    hitCount: Number(row.hitCount) || 0,
    createdAt: Number(row.createdAt) || 0,
    updatedAt: Number(row.updatedAt) || 0
  }
}

/**
 * Drizzle adapter. This is the only file in the custom-entry path that knows
 * SQLite/Drizzle; validation and mode rules stay in custom-store.ts.
 */
export function createDrizzleCustomEntryRepository(
  db: SearchDatabase,
  table: CustomEntryTable
): CustomEntryRepository {
  function findById(profileId: string, id: string): CustomEntryStorageRecord | null {
    const row = db.select().from(table)
      .where(and(eq(table.profileId, profileId), eq(table.id, id)))
      .get()
    return row ? mapRow(row) : null
  }

  return {
    list(profileId) {
      return db.select().from(table)
        .where(eq(table.profileId, profileId))
        .orderBy(desc(table.hitCount), asc(table.createdAt))
        .all()
        .map(mapRow)
    },
    findByTrigger(profileId, trigger) {
      const row = db.select().from(table)
        .where(and(eq(table.profileId, profileId), eq(table.trigger, trigger)))
        .get()
      return row ? mapRow(row) : null
    },
    findById,
    insert(record) {
      db.insert(table).values(record).run()
    },
    update(profileId, id, patch: CustomEntryUpdate) {
      db.update(table).set(patch)
        .where(and(eq(table.profileId, profileId), eq(table.id, id)))
        .run()
    },
    remove(profileId, id) {
      const result = db.delete(table)
        .where(and(eq(table.profileId, profileId), eq(table.id, id)))
        .run()
      return Number(result.changes) || 0
    },
    incrementHitCount(profileId, id) {
      const existing = findById(profileId, id)
      if (!existing) return
      db.update(table).set({ hitCount: existing.hitCount + 1 })
        .where(and(eq(table.profileId, profileId), eq(table.id, id)))
        .run()
    }
  }
}
