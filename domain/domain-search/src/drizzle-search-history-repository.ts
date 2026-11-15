import { searchHistory } from '@hira-ng/infra-db/schema'
import {
  and as drizzleAnd,
  desc as drizzleDesc,
  eq as drizzleEq,
  like as drizzleLike
} from 'drizzle-orm'
import type {
  QueryCondition,
  SearchDatabase,
  SearchHistoryRepository,
  SearchHistoryStorageRecord
} from './types'

type BinaryCondition = (column: unknown, value: unknown) => QueryCondition
const eq = drizzleEq as unknown as BinaryCondition
const like = drizzleLike as unknown as BinaryCondition
const desc = drizzleDesc as unknown as (column: unknown) => unknown
const and = drizzleAnd as unknown as (...conditions: QueryCondition[]) => QueryCondition

function mapRow(row: Record<string, unknown>): SearchHistoryStorageRecord {
  return {
    id: String(row.id),
    profileId: String(row.profileId),
    queryText: String(row.queryText),
    hitCount: Number(row.hitCount) || 0,
    lastUsedAt: Number(row.lastUsedAt) || 0
  }
}

export function createDrizzleSearchHistoryRepository(db: SearchDatabase): SearchHistoryRepository {
  return {
    findByQuery(profileId, query) {
      const row = db.select().from(searchHistory)
        .where(and(
          eq(searchHistory.profileId, profileId),
          eq(searchHistory.queryText, query)
        ))
        .get()
      return row ? mapRow(row) : null
    },
    listMatches(profileId, query, limit) {
      return db.select().from(searchHistory)
        .where(and(
          eq(searchHistory.profileId, profileId),
          like(searchHistory.queryText, `%${query}%`)
        ))
        .orderBy(desc(searchHistory.hitCount), desc(searchHistory.lastUsedAt))
        .limit(limit)
        .all()
        .map(mapRow)
    },
    insert(record) {
      db.insert(searchHistory).values(record).run()
    },
    incrementHitCount(id, lastUsedAt) {
      const existing = db.select().from(searchHistory)
        .where(eq(searchHistory.id, id))
        .get()
      if (!existing) return
      db.update(searchHistory).set({
        hitCount: Number(existing.hitCount) + 1,
        lastUsedAt
      }).where(eq(searchHistory.id, id)).run()
    },
    clear(profileId) {
      const result = db.delete(searchHistory)
        .where(eq(searchHistory.profileId, profileId))
        .run()
      return Number(result.changes) || 0
    },
    remove(profileId, id) {
      const result = db.delete(searchHistory)
        .where(and(
          eq(searchHistory.id, id),
          eq(searchHistory.profileId, profileId)
        ))
        .run()
      return Number(result.changes) > 0
    }
  }
}
