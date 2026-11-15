import { pageTexts } from '@hira-ng/infra-db/schema'
import {
  and as drizzleAnd,
  eq as drizzleEq,
  like as drizzleLike,
  sql as drizzleSql
} from 'drizzle-orm'
import { buildMatchQuery } from '@hira-ng/shared-utils'
import type {
  HistoryDatabase,
  NormalizedPageText,
  PageTextRepository,
  PageTextSearchHit,
  QueryCondition,
  QueryValue
} from './types'

type BinaryCondition = (column: unknown, value: unknown) => QueryCondition

const and = drizzleAnd as unknown as (...conditions: QueryCondition[]) => QueryCondition
const eq = drizzleEq as unknown as BinaryCondition
const like = drizzleLike as unknown as BinaryCondition

export interface DrizzlePageTextRepositoryOptions {
  ftsEnabled?: boolean
}

export function createDrizzlePageTextRepository(
  rawDatabase: HistoryDatabase,
  options: DrizzlePageTextRepositoryOptions = {}
): PageTextRepository {
  const db = rawDatabase as unknown as HistoryDatabase
  const ftsEnabled = Boolean(options.ftsEnabled)

  function savePageTexts(records: readonly NormalizedPageText[]): number {
    if (records.length === 0) return 0
    let written = 0
    try {
      db.transaction((tx) => {
        for (const record of records) {
          tx.insert(pageTexts)
            .values({
              id: record.id,
              profileId: record.profileId,
              url: record.url,
              title: record.title,
              text: record.text,
              updatedAt: record.updatedAt
            })
            .onConflictDoUpdate({
              target: [pageTexts.profileId, pageTexts.url],
              set: {
                title: record.title,
                text: record.text,
                updatedAt: record.updatedAt
              }
            })
            .run()
          written += 1
        }
      })
      return written
    } catch (error) {
      console.warn('[history] savePageTexts failed:', error instanceof Error ? error.message : error)
      return 0
    }
  }

  function searchFts(profileId: string, query: string, limit: number): PageTextSearchHit[] {
    const match = buildMatchQuery(query)
    if (!match) return []
    return db.all(drizzleSql`
      SELECT pt.url AS url,
             snippet(page_texts_fts, 0, '[', ']', '…', 14) AS snippet
      FROM page_texts_fts f
      JOIN page_texts pt ON pt.rowid = f.rowid
      WHERE page_texts_fts MATCH ${match} AND pt.profile_id = ${profileId}
      LIMIT ${Math.max(1, Number(limit) || 50)}
    `).map(mapSearchRow)
  }

  function searchLike(profileId: string, query: string, limit: number): PageTextSearchHit[] {
    return db.select({ url: pageTexts.url }).from(pageTexts)
      .where(and(
        eq(pageTexts.profileId, profileId),
        like(pageTexts.text, `%${query}%`)
      ))
      .limit(Math.max(1, Number(limit) || 50))
      .all()
      .map((row) => ({ url: String(row.url ?? ''), snippet: null }))
  }

  function search(profileId: string, query: string, limit: number): PageTextSearchHit[] {
    const normalized = String(query || '').trim()
    if (!normalized) return []
    try {
      return ftsEnabled
        ? searchFts(profileId, normalized, limit)
        : searchLike(profileId, normalized, limit)
    } catch (error) {
      console.warn('[history] page-text search failed:', error instanceof Error ? error.message : error)
      return []
    }
  }

  function prune(profileId: string): void {
    try {
      db.run(drizzleSql`
        DELETE FROM page_texts
        WHERE profile_id = ${profileId}
          AND url NOT IN (SELECT url FROM history WHERE profile_id = ${profileId})
      `)
    } catch {
      // Page text indexing is optional and may not exist in older databases.
    }
  }

  return { savePageTexts, search, prune }
}

function mapSearchRow(row: QueryValue): PageTextSearchHit {
  return {
    url: String(row.url ?? ''),
    snippet: row.snippet == null ? null : String(row.snippet)
  }
}
