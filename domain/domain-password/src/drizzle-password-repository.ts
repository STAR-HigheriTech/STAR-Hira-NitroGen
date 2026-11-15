import { passwordsMeta, passwordsNeverSave } from '@hira-ng/infra-db/schema'
import {
  and as drizzleAnd,
  desc as drizzleDesc,
  eq as drizzleEq
} from 'drizzle-orm'
import type {
  NeverSaveRow,
  PasswordCredentialRepository,
  PasswordNeverSaveRepository,
  PasswordRow,
  PasswordWriteOperation
} from './types'

type Condition = unknown
type BinaryCondition = (column: unknown, value: unknown) => Condition
type CombineCondition = (...conditions: Condition[]) => Condition
type OrderValue = (column: unknown) => unknown
type WriteResult = { changes?: number | bigint }

interface SelectQuery {
  where(condition: Condition): SelectQuery
  orderBy(...values: unknown[]): SelectQuery
  get(): Record<string, unknown> | undefined
  all(): Record<string, unknown>[]
}

interface WriteQuery {
  run(): WriteResult
}

export interface PasswordDatabase {
  select(): { from(table: unknown): SelectQuery }
  insert(table: unknown): { values(value: object): WriteQuery }
  update(table: unknown): {
    set(value: Record<string, unknown>): { where(condition: Condition): WriteQuery }
  }
  delete(table: unknown): { where(condition: Condition): WriteQuery }
  transaction(callback: (tx: PasswordDatabase) => void): unknown
}

const eq = drizzleEq as unknown as BinaryCondition
const and = drizzleAnd as unknown as CombineCondition
const desc = drizzleDesc as unknown as OrderValue

export function createDrizzlePasswordRepository(db: PasswordDatabase): PasswordCredentialRepository {
  function writeOne(target: PasswordDatabase, operation: PasswordWriteOperation): void {
    if (operation.type === 'insert') {
      target.insert(passwordsMeta).values(operation.row).run()
      return
    }
    if (operation.type === 'update') {
      target.update(passwordsMeta).set(operation.values)
        .where(eq(passwordsMeta.id, operation.id)).run()
      return
    }
    target.delete(passwordsMeta).where(eq(passwordsMeta.id, operation.id)).run()
  }

  return {
    list(profileId, backend) {
      return db.select().from(passwordsMeta)
        .where(and(
          eq(passwordsMeta.backend, backend),
          eq(passwordsMeta.profileId, profileId)
        ))
        .orderBy(desc(passwordsMeta.lastUsedAt))
        .all() as unknown as PasswordRow[]
    },

    get(id) {
      if (!id) return null
      return (db.select().from(passwordsMeta)
        .where(eq(passwordsMeta.id, id))
        .get() as unknown as PasswordRow | undefined) || null
    },

    write(operations) {
      if (!operations.length) return
      db.transaction((tx) => {
        for (const operation of operations) writeOne(tx, operation)
      })
    }
  }
}

export function createDrizzleNeverSaveRepository(db: PasswordDatabase): PasswordNeverSaveRepository {
  return {
    list(profileId) {
      return db.select().from(passwordsNeverSave)
        .where(eq(passwordsNeverSave.profileId, profileId))
        .orderBy(desc(passwordsNeverSave.createdAt))
        .all() as unknown as NeverSaveRow[]
    },

    replace(profileId, rows) {
      db.transaction((tx) => {
        tx.delete(passwordsNeverSave)
          .where(eq(passwordsNeverSave.profileId, profileId)).run()
        for (const row of rows) {
          tx.insert(passwordsNeverSave).values(row).run()
        }
      })
    }
  }
}
