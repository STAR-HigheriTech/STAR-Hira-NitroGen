import { totpEntries } from '@hira-ng/infra-db/schema'
import {
  and as drizzleAnd,
  desc as drizzleDesc,
  eq as drizzleEq
} from 'drizzle-orm'
import type { TotpRepository, TotpRow } from './types'

type Condition = unknown
const eq = drizzleEq as unknown as (column: unknown, value: unknown) => Condition
const and = drizzleAnd as unknown as (...conditions: Condition[]) => Condition
const desc = drizzleDesc as unknown as (column: unknown) => unknown
type Query = {
  where(condition: Condition): Query
  orderBy(value: unknown): Query
  get(): Record<string, unknown> | undefined
  all(): Record<string, unknown>[]
}
type Write = { run(): unknown }

interface TotpDatabase {
  select(): { from(table: unknown): Query }
  insert(table: unknown): { values(value: TotpRow): Write }
  update(table: unknown): {
    set(value: Partial<TotpRow>): { where(condition: Condition): Write }
  }
  delete(table: unknown): { where(condition: Condition): Write }
}

export function createTotpRepository(db: TotpDatabase): TotpRepository {
  return {
    list(profileId) {
      return db.select().from(totpEntries)
        .where(eq(totpEntries.profileId, profileId))
        .orderBy(desc(totpEntries.createdAt))
        .all() as unknown as TotpRow[]
    },

    find(profileId, id) {
      if (!id) return null
      const row = db.select().from(totpEntries)
        .where(and(eq(totpEntries.id, id), eq(totpEntries.profileId, profileId)))
        .get()
      return (row as TotpRow | undefined) || null
    },

    insert(row) {
      db.insert(totpEntries).values(row).run()
    },

    update(profileId, id, values) {
      db.update(totpEntries).set(values)
        .where(and(eq(totpEntries.id, id), eq(totpEntries.profileId, profileId)))
        .run()
    },

    remove(profileId, id) {
      db.delete(totpEntries)
        .where(and(eq(totpEntries.id, id), eq(totpEntries.profileId, profileId)))
        .run()
    }
  }
}
