import { history, historyVisits } from '@hira-ng/infra-db/schema'
import {
  and as drizzleAnd,
  count as drizzleCount,
  desc as drizzleDesc,
  eq as drizzleEq,
  gte as drizzleGte,
  inArray as drizzleInArray,
  isNull as drizzleIsNull,
  like as drizzleLike,
  lt as drizzleLt,
  lte as drizzleLte,
  or as drizzleOr,
  sql as drizzleSql
} from 'drizzle-orm'
import { canonicalHistoryUrl, generateId } from '@hira-ng/shared-utils'
import { isHttpUrl } from '@hira-ng/shared-types/src/url-protocols.mjs'
import type {
  CompactHistoryResult,
  HistoryCountVisitsOptions,
  HistoryDatabase,
  HistoryEntry,
  HistoryIdFactory,
  HistoryListVisitsOptions,
  HistoryRepository,
  HistoryTransition,
  HistoryVisitEntry,
  HistoryVisitPage,
  ImportHistoryResult,
  NormalizedHistoryVisit,
  NormalizedImportVisit,
  QueryCondition,
  QueryRunResult,
  QueryValue,
  RemoveHistoryResult,
  RemoveManyHistoryResult
} from './types'
import { normalizeHistoryTransition } from './history-utils'

type BinaryCondition = (column: unknown, value: unknown) => QueryCondition
type UnaryCondition = (column: unknown) => QueryCondition
type OrderExpression = (column: unknown) => unknown

const eq = drizzleEq as unknown as BinaryCondition
const gte = drizzleGte as unknown as BinaryCondition
const lte = drizzleLte as unknown as BinaryCondition
const lt = drizzleLt as unknown as BinaryCondition
const like = drizzleLike as unknown as BinaryCondition
const inArray = drizzleInArray as unknown as BinaryCondition
const isNull = drizzleIsNull as unknown as UnaryCondition
const desc = drizzleDesc as unknown as OrderExpression
const and = drizzleAnd as unknown as (...conditions: QueryCondition[]) => QueryCondition
const or = drizzleOr as unknown as (...conditions: QueryCondition[]) => QueryCondition
const count = drizzleCount as unknown as () => QueryCondition

const CHUNK_SIZE = 400

function toNumber(value: unknown, fallback = 0): number {
  const number = Number(value)
  return Number.isFinite(number) ? number : fallback
}

function toNullableString(value: unknown): string | null {
  return value == null ? null : String(value)
}

function changesOf(result: QueryRunResult | null | undefined): number {
  return Math.max(0, toNumber(result?.changes))
}

function mapHistoryRow(row: QueryValue): HistoryEntry {
  return {
    id: String(row.id ?? ''),
    profileId: String(row.profileId ?? 'default'),
    url: String(row.url ?? ''),
    title: toNullableString(row.title),
    favicon: toNullableString(row.favicon),
    visitCount: toNumber(row.visitCount),
    typedCount: toNumber(row.typedCount),
    firstVisitAt: toNumber(row.firstVisitAt),
    lastVisitAt: toNumber(row.lastVisitAt)
  }
}

function mapVisitRow(row: QueryValue): HistoryVisitEntry {
  return {
    id: String(row.id ?? ''),
    profileId: String(row.profileId ?? 'default'),
    historyId: toNullableString(row.historyId),
    url: String(row.url ?? ''),
    title: toNullableString(row.title),
    transition: normalizeHistoryTransition(row.transition) as HistoryTransition,
    visitedAt: toNumber(row.visitedAt)
  }
}

function chunks<T>(values: readonly T[], size = CHUNK_SIZE): T[][] {
  const result: T[][] = []
  for (let index = 0; index < values.length; index += size) {
    result.push(values.slice(index, index + size))
  }
  return result
}

export interface DrizzleHistoryRepositoryOptions {
  createId?: HistoryIdFactory
}

interface ImportAggregate {
  url: string
  count: number
  typed: number
  first: number
  last: number
  title: string | null
  favicon: string | null
}

export function createDrizzleHistoryRepository(
  rawDatabase: HistoryDatabase,
  options: DrizzleHistoryRepositoryOptions = {}
): HistoryRepository {
  const db = rawDatabase as unknown as HistoryDatabase
  const createId = options.createId || generateId

  function addVisit(profileId: string, visit: NormalizedHistoryVisit): string {
    let historyId = ''
    db.transaction((tx) => {
      const existingRow = tx.select().from(history)
        .where(and(eq(history.url, visit.url), eq(history.profileId, profileId)))
        .get()
      const existing = existingRow ? mapHistoryRow(existingRow) : null

      if (existing) {
        historyId = existing.id
        tx.update(history).set({
          title: visit.title ?? existing.title,
          favicon: visit.favicon ?? existing.favicon,
          visitCount: existing.visitCount + 1,
          ...(visit.transition === 'typed'
            ? { typedCount: existing.typedCount + 1 }
            : {}),
          lastVisitAt: visit.visitedAt
        }).where(eq(history.id, existing.id)).run()
      } else {
        historyId = createId('his')
        tx.insert(history).values({
          id: historyId,
          profileId,
          url: visit.url,
          title: visit.title,
          favicon: visit.favicon,
          visitCount: 1,
          typedCount: visit.transition === 'typed' ? 1 : 0,
          lastVisitAt: visit.visitedAt,
          firstVisitAt: visit.visitedAt
        }).run()
      }

      try {
        tx.insert(historyVisits).values({
          id: createId('hv'),
          profileId,
          historyId,
          url: visit.url,
          title: visit.title,
          transition: visit.transition,
          visitedAt: visit.visitedAt
        }).run()
      } catch {
        // Visit details are an enhancement; the aggregate remains the fact row.
      }
    })
    return historyId
  }

  function importVisits(
    profileId: string,
    visits: readonly NormalizedImportVisit[]
  ): ImportHistoryResult {
    if (visits.length === 0) return { imported: 0, skipped: 0 }

    const urls = [...new Set(visits.map((visit) => visit.url))]
    const existingKeys = new Set<string>()
    for (const chunk of chunks(urls)) {
      const rows = db.select({
        url: historyVisits.url,
        visitedAt: historyVisits.visitedAt
      }).from(historyVisits)
        .where(and(
          eq(historyVisits.profileId, profileId),
          inArray(historyVisits.url, chunk)
        ))
        .all()
      for (const row of rows) {
        existingKeys.add(`${String(row.url)}\u0000${toNumber(row.visitedAt)}`)
      }
    }

    const fresh = visits
      .filter((visit) => !existingKeys.has(`${visit.url}\u0000${visit.visitedAt}`))
      .sort((left, right) => left.visitedAt - right.visitedAt)
    const skipped = visits.length - fresh.length
    if (fresh.length === 0) return { imported: 0, skipped }

    const aggregates = new Map<string, ImportAggregate>()
    for (const visit of fresh) {
      let aggregate = aggregates.get(visit.url)
      if (!aggregate) {
        aggregate = {
          url: visit.url,
          count: 0,
          typed: 0,
          first: visit.visitedAt,
          last: visit.visitedAt,
          title: null,
          favicon: null
        }
        aggregates.set(visit.url, aggregate)
      }
      aggregate.count += 1
      if (visit.transition === 'typed') aggregate.typed += 1
      aggregate.first = Math.min(aggregate.first, visit.visitedAt)
      if (visit.visitedAt >= aggregate.last) {
        aggregate.last = visit.visitedAt
        if (visit.title) aggregate.title = visit.title
        if (visit.favicon) aggregate.favicon = visit.favicon
      }
      if (!aggregate.title && visit.title) aggregate.title = visit.title
      if (!aggregate.favicon && visit.favicon) aggregate.favicon = visit.favicon
    }

    db.transaction((tx) => {
      const historyIds = new Map<string, string>()
      const existingRows = new Map<string, HistoryEntry>()
      const aggregateKeys = [...aggregates.keys()]

      for (const chunk of chunks(aggregateKeys)) {
        const rows = tx.select({
          id: history.id,
          url: history.url,
          title: history.title,
          favicon: history.favicon,
          visitCount: history.visitCount,
          typedCount: history.typedCount,
          firstVisitAt: history.firstVisitAt,
          lastVisitAt: history.lastVisitAt
        }).from(history)
          .where(and(
            eq(history.profileId, profileId),
            inArray(history.url, chunk)
          ))
          .all()
        for (const row of rows) {
          const entry = mapHistoryRow(row)
          existingRows.set(entry.url, entry)
        }
      }

      for (const aggregate of aggregates.values()) {
        const row = existingRows.get(aggregate.url)
        if (row) {
          tx.update(history).set({
            title: aggregate.title || row.title,
            favicon: row.favicon || aggregate.favicon,
            visitCount: row.visitCount + aggregate.count,
            typedCount: row.typedCount + aggregate.typed,
            firstVisitAt: Math.min(row.firstVisitAt || aggregate.first, aggregate.first),
            lastVisitAt: Math.max(row.lastVisitAt || aggregate.last, aggregate.last)
          }).where(eq(history.id, row.id)).run()
          historyIds.set(aggregate.url, row.id)
        } else {
          const id = createId('his')
          tx.insert(history).values({
            id,
            profileId,
            url: aggregate.url,
            title: aggregate.title,
            favicon: aggregate.favicon,
            visitCount: aggregate.count,
            typedCount: aggregate.typed,
            firstVisitAt: aggregate.first,
            lastVisitAt: aggregate.last
          }).run()
          historyIds.set(aggregate.url, id)
        }
      }

      for (const visit of fresh) {
        tx.insert(historyVisits).values({
          id: createId('hv'),
          profileId,
          historyId: historyIds.get(visit.url) || null,
          url: visit.url,
          title: visit.title,
          transition: visit.transition,
          visitedAt: visit.visitedAt
        }).run()
      }
    })

    return { imported: fresh.length, skipped }
  }

  function backfillFavicons(
    profileId: string,
    entries: readonly { url: string; favicon: string }[]
  ): number {
    if (entries.length === 0) return 0
    let updated = 0
    db.transaction((tx) => {
      for (const entry of entries) {
        const url = canonicalHistoryUrl(entry.url)
        if (!isHttpUrl(url)) continue
        const result = tx.update(history)
          .set({ favicon: entry.favicon })
          .where(and(
            eq(history.profileId, profileId),
            eq(history.url, url),
            isNull(history.favicon)
          ))
          .run()
        updated += changesOf(result)
      }
    })
    return updated
  }

  function updateTitle(profileId: string, url: string, title: string): number {
    const result = db.update(history)
      .set({ title })
      .where(and(eq(history.url, url), eq(history.profileId, profileId)))
      .run()
    try {
      db.update(historyVisits)
        .set({ title })
        .where(and(
          eq(historyVisits.url, url),
          eq(historyVisits.profileId, profileId),
          isNull(historyVisits.title)
        ))
        .run()
    } catch {
      // Older databases may not have the visit table yet.
    }
    return changesOf(result)
  }

  function searchText(profileId: string, query: string, limit: number): HistoryEntry[] {
    const pattern = `%${query}%`
    return db.select().from(history)
      .where(and(
        eq(history.profileId, profileId),
        or(like(history.title, pattern), like(history.url, pattern))
      ))
      .orderBy(desc(history.lastVisitAt))
      .limit(limit)
      .all()
      .map(mapHistoryRow)
  }

  function findByUrls(profileId: string, urls: readonly string[], limit: number): HistoryEntry[] {
    if (urls.length === 0) return []
    return db.select().from(history)
      .where(and(
        eq(history.profileId, profileId),
        inArray(history.url, urls)
      ))
      .orderBy(desc(history.lastVisitAt))
      .limit(limit)
      .all()
      .map(mapHistoryRow)
  }

  function listRecent(profileId: string, limit: number): HistoryEntry[] {
    return db.select().from(history)
      .where(eq(history.profileId, profileId))
      .orderBy(desc(history.lastVisitAt))
      .limit(limit)
      .all()
      .map(mapHistoryRow)
  }

  function queryRange(profileId: string, fromTs: number, toTs: number, limit: number): HistoryEntry[] {
    return db.select().from(history)
      .where(and(
        eq(history.profileId, profileId),
        gte(history.lastVisitAt, fromTs),
        lte(history.lastVisitAt, toTs)
      ))
      .orderBy(desc(history.lastVisitAt))
      .limit(limit)
      .all()
      .map(mapHistoryRow)
  }

  function listVisits(profileId: string, options: HistoryListVisitsOptions): HistoryVisitPage {
    const conditions: QueryCondition[] = [eq(historyVisits.profileId, profileId)]
    if (options.historyId) conditions.push(eq(historyVisits.historyId, options.historyId))
    else if (options.url) conditions.push(eq(historyVisits.url, options.url))
    if (options.before != null) conditions.push(lt(historyVisits.visitedAt, options.before))

    const limit = Math.min(Math.max(1, toNumber(options.limit, 100)), 500)
    const items = db.select().from(historyVisits)
      .where(and(...conditions))
      .orderBy(desc(historyVisits.visitedAt), desc(historyVisits.id))
      .limit(limit)
      .all()
      .map(mapVisitRow)
    const nextCursor = items.length === limit ? items[items.length - 1].visitedAt : null
    return { items, nextCursor }
  }

  function countVisits(profileId: string, options: HistoryCountVisitsOptions): number {
    const conditions: QueryCondition[] = [eq(historyVisits.profileId, profileId)]
    if (options.historyId) conditions.push(eq(historyVisits.historyId, options.historyId))
    else if (options.url) conditions.push(eq(historyVisits.url, options.url))
    const row = db.select({ n: count() }).from(historyVisits)
      .where(and(...conditions))
      .get()
    return toNumber(row?.n)
  }

  function remove(profileId: string, id: string): RemoveHistoryResult {
    let url: string | null = null
    try {
      const row = db.select({ url: history.url }).from(history)
        .where(and(eq(history.id, id), eq(history.profileId, profileId)))
        .get()
      url = row ? toNullableString(row.url) : null
    } catch {
      // Continue with the canonical delete even if the pre-read failed.
    }

    const result = db.delete(history)
      .where(and(eq(history.id, id), eq(history.profileId, profileId)))
      .run()
    try {
      db.delete(historyVisits)
        .where(and(
          eq(historyVisits.historyId, id),
          eq(historyVisits.profileId, profileId)
        ))
        .run()
    } catch {
      // Visit logs are best-effort on legacy schemas.
    }
    return { deleted: changesOf(result), url }
  }

  function removeMany(profileId: string, ids: readonly string[]): RemoveManyHistoryResult {
    const uniqueIds = [...new Set(ids)].filter(Boolean)
    if (uniqueIds.length === 0) return { deleted: 0, urls: [] }

    let urls: string[] = []
    try {
      urls = db.select({ url: history.url }).from(history)
        .where(and(
          inArray(history.id, uniqueIds),
          eq(history.profileId, profileId)
        ))
        .all()
        .map((row) => String(row.url ?? ''))
        .filter(Boolean)
    } catch {
      // URL collection only improves observer cleanup.
    }

    const result = db.delete(history)
      .where(and(
        inArray(history.id, uniqueIds),
        eq(history.profileId, profileId)
      ))
      .run()
    try {
      db.delete(historyVisits)
        .where(and(
          inArray(historyVisits.historyId, uniqueIds),
          eq(historyVisits.profileId, profileId)
        ))
        .run()
    } catch {
      // Visit logs are best-effort on legacy schemas.
    }
    return { deleted: changesOf(result), urls }
  }

  function removeBefore(profileId: string, beforeTs: number): number {
    const result = db.delete(history)
      .where(and(
        eq(history.profileId, profileId),
        lte(history.lastVisitAt, beforeTs)
      ))
      .run()
    try {
      db.delete(historyVisits)
        .where(and(
          eq(historyVisits.profileId, profileId),
          lte(historyVisits.visitedAt, beforeTs)
        ))
        .run()
    } catch {
      // Visit logs are best-effort on legacy schemas.
    }
    return changesOf(result)
  }

  function removeAfter(profileId: string, afterTs: number): number {
    const result = db.delete(history)
      .where(and(
        eq(history.profileId, profileId),
        gte(history.lastVisitAt, afterTs)
      ))
      .run()
    try {
      db.delete(historyVisits)
        .where(and(
          eq(historyVisits.profileId, profileId),
          gte(historyVisits.visitedAt, afterTs)
        ))
        .run()
    } catch {
      // Visit logs are best-effort on legacy schemas.
    }
    return changesOf(result)
  }

  function clearAll(profileId: string): number {
    const result = db.delete(history).where(eq(history.profileId, profileId)).run()
    try {
      db.delete(historyVisits).where(eq(historyVisits.profileId, profileId)).run()
    } catch {
      // Visit logs are best-effort on legacy schemas.
    }
    return changesOf(result)
  }

  function compactHistory(profileId: string): CompactHistoryResult {
    const rows = db.select().from(history)
      .where(eq(history.profileId, profileId))
      .all()
      .map(mapHistoryRow)
    if (rows.length === 0) return { removed: 0, merged: 0, dedupedVisits: 0 }

    const groups = new Map<string, { row: HistoryEntry; url: string }[]>()
    const junkIds: string[] = []
    for (const row of rows) {
      const url = canonicalHistoryUrl(row.url)
      if (!isHttpUrl(url)) {
        junkIds.push(row.id)
        continue
      }
      const group = groups.get(url) || []
      group.push({ row, url })
      groups.set(url, group)
    }

    let removed = 0
    let merged = 0
    let dedupedVisits = 0
    db.transaction((tx) => {
      if (junkIds.length > 0) {
        removed += changesOf(tx.delete(history)
          .where(and(
            eq(history.profileId, profileId),
            inArray(history.id, junkIds)
          ))
          .run())
        try {
          tx.delete(historyVisits)
            .where(and(
              eq(historyVisits.profileId, profileId),
              inArray(historyVisits.historyId, junkIds)
            ))
            .run()
        } catch {
          // Visit logs are best-effort on legacy schemas.
        }
      }

      for (const [keeperUrl, group] of groups) {
        let keeper = group[0]
        for (const item of group) {
          if (item.row.lastVisitAt > keeper.row.lastVisitAt) keeper = item
          else if (
            item.row.lastVisitAt === keeper.row.lastVisitAt &&
            item.row.visitCount > keeper.row.visitCount
          ) {
            keeper = item
          }
        }

        let visitCount = 0
        let typedCount = 0
        let firstVisitAt = Number.POSITIVE_INFINITY
        let lastVisitAt = 0
        let title: string | null = null
        let favicon: string | null = null
        for (const item of group) {
          visitCount += item.row.visitCount
          typedCount += item.row.typedCount
          const first = item.row.firstVisitAt || item.row.lastVisitAt || 0
          if (first && first < firstVisitAt) firstVisitAt = first
          lastVisitAt = Math.max(lastVisitAt, item.row.lastVisitAt)
          if (!title && item.row.title) title = item.row.title
          if (!favicon && item.row.favicon) favicon = item.row.favicon
        }
        title ||= keeper.row.title
        favicon ||= keeper.row.favicon

        const duplicateIds = group
          .filter((item) => item.row.id !== keeper.row.id)
          .map((item) => item.row.id)
        const urls = [...new Set(group.map((item) => item.row.url))]
        if (duplicateIds.length > 0) {
          removed += changesOf(tx.delete(history)
            .where(and(
              eq(history.profileId, profileId),
              inArray(history.id, duplicateIds)
            ))
            .run())
          merged += duplicateIds.length
        }

        tx.update(history).set({
          url: keeperUrl,
          title,
          favicon,
          visitCount,
          typedCount,
          firstVisitAt: Number.isFinite(firstVisitAt)
            ? firstVisitAt
            : keeper.row.firstVisitAt,
          lastVisitAt: lastVisitAt || keeper.row.lastVisitAt
        }).where(and(
          eq(history.profileId, profileId),
          eq(history.id, keeper.row.id)
        )).run()

        if (urls.some((url) => url !== keeperUrl)) {
          try {
            tx.update(historyVisits)
              .set({ historyId: keeper.row.id, url: keeperUrl })
              .where(and(
                eq(historyVisits.profileId, profileId),
                inArray(historyVisits.url, urls)
              ))
              .run()
          } catch {
            // Visit logs are best-effort on legacy schemas.
          }
        }
      }

      try {
        const result = tx.run(drizzleSql`
          DELETE FROM history_visits
          WHERE profile_id = ${profileId}
            AND rowid NOT IN (
              SELECT MIN(rowid) FROM history_visits
              WHERE profile_id = ${profileId}
              GROUP BY url, visited_at
            )
        `)
        dedupedVisits = changesOf(result)
      } catch {
        // Older databases may not have the visit table yet.
      }
    })

    return { removed, merged, dedupedVisits }
  }

  return {
    addVisit,
    importVisits,
    backfillFavicons,
    updateTitle,
    searchText,
    findByUrls,
    listRecent,
    queryRange,
    listVisits,
    countVisits,
    remove,
    removeMany,
    removeBefore,
    removeAfter,
    clearAll,
    compactHistory
  }
}
