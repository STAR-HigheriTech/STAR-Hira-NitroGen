import { permissions } from '@hira-ng/infra-db/schema'
import { and as drizzleAnd, eq as drizzleEq, ne as drizzleNe } from 'drizzle-orm'
import { DEFAULT_RULE_DOMAIN } from './constants'
import type {
  PermissionDatabase,
  PermissionRepository,
  PermissionStorageRecord,
  PermissionTableShape,
  QueryCondition,
  QueryRunResult
} from './types'

type BinaryCondition = (column: unknown, value: unknown) => QueryCondition
type VariadicCondition = (...conditions: QueryCondition[]) => QueryCondition

const and = drizzleAnd as unknown as VariadicCondition
const eq = drizzleEq as unknown as BinaryCondition
const ne = drizzleNe as unknown as BinaryCondition
const table = permissions as unknown as PermissionTableShape

function changesOf(result: QueryRunResult): number {
  return Number(result?.changes) || 0
}

/** Drizzle adapter. This is the only permission-domain file aware of SQLite storage. */
export function createDrizzlePermissionRepository(db: PermissionDatabase): PermissionRepository {
  function find(condition: QueryCondition): PermissionStorageRecord | null {
    return db.select().from(table).where(condition).get() || null
  }

  function list(condition: QueryCondition): PermissionStorageRecord[] {
    return db.select().from(table).where(condition).all()
  }

  return {
    find(profileId, domain, permissionType) {
      return find(and(
        eq(table.profileId, profileId),
        eq(table.domain, domain),
        eq(table.permissionType, permissionType)
      ))
    },
    listByDomain(profileId, domain) {
      return list(and(eq(table.profileId, profileId), eq(table.domain, domain)))
    },
    listSites(profileId) {
      return list(and(eq(table.profileId, profileId), ne(table.domain, DEFAULT_RULE_DOMAIN)))
    },
    listByType(profileId, permissionType) {
      return list(and(
        eq(table.profileId, profileId),
        eq(table.permissionType, permissionType),
        ne(table.domain, DEFAULT_RULE_DOMAIN)
      ))
    },
    listDefaults(profileId) {
      return list(and(
        eq(table.profileId, profileId),
        eq(table.domain, DEFAULT_RULE_DOMAIN)
      ))
    },
    insert(record) {
      db.insert(table).values(record).run()
    },
    update(id, setting, updatedAt) {
      db.update(table).set({ setting, updatedAt }).where(eq(table.id, id)).run()
    },
    updateByType(profileId, permissionType, setting, updatedAt) {
      return changesOf(db.update(table).set({ setting, updatedAt }).where(and(
        eq(table.profileId, profileId),
        eq(table.permissionType, permissionType),
        ne(table.domain, DEFAULT_RULE_DOMAIN)
      )).run())
    },
    remove(profileId, domain, permissionType) {
      return changesOf(db.delete(table).where(and(
        eq(table.profileId, profileId),
        eq(table.domain, domain),
        eq(table.permissionType, permissionType)
      )).run())
    },
    removeByDomain(profileId, domain) {
      return changesOf(db.delete(table).where(and(
        eq(table.profileId, profileId),
        eq(table.domain, domain)
      )).run())
    },
    removeByType(profileId, permissionType) {
      return changesOf(db.delete(table).where(and(
        eq(table.profileId, profileId),
        eq(table.permissionType, permissionType),
        ne(table.domain, DEFAULT_RULE_DOMAIN)
      )).run())
    },
    removeAll(profileId) {
      return changesOf(db.delete(table).where(eq(table.profileId, profileId)).run())
    }
  }
}
