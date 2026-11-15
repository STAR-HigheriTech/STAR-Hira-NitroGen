/**
 * 解析结果 → 领域服务（写入的唯一出口）
 *
 * 两条纪律：
 *   · 只调用既有的批量入口（`bookmarkService.importTrees` / `historyService.importVisits`），
 *     不在迁移管线里另开一条写库路径 —— 否则去重 / 事务 / 变更广播会出现第二套语义；
 *   · 失败返回结构化结果（errors[]），不向上抛 —— 调用方（OOBE / 导入页）需要
 *     「部分成功」也能如实展示，而不是整页卡死。
 */

interface ParsedBookmarkData {
  ok?: boolean
  error?: unknown
  trees?: unknown[]
}

interface ParsedHistoryData {
  ok?: boolean
  error?: unknown
  visits?: unknown[]
}

export interface ParsedData {
  bookmarks?: ParsedBookmarkData
  history?: ParsedHistoryData
}

export interface ImportWriteSummary {
  imported?: unknown
  skipped?: unknown
  error?: unknown
}

export interface BookmarkImportService {
  importTrees(trees: unknown[]): ImportWriteSummary
}

export interface HistoryImportService {
  importVisits(visits: unknown[]): ImportWriteSummary
}

export interface ImportWriteDependencies {
  bookmarkService?: BookmarkImportService
  historyService?: HistoryImportService
}

export interface ImportWriteResult {
  bookmarks: { imported: number; skipped: number }
  history: { imported: number; skipped: number }
  errors: string[]
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

export function writeParsedData(data: ParsedData = {}, deps: ImportWriteDependencies = {}): ImportWriteResult {
  const result = {
    bookmarks: { imported: 0, skipped: 0 },
    history: { imported: 0, skipped: 0 },
    errors: [] as string[]
  }
  const bookmarkService = deps && deps.bookmarkService
  const historyService = deps && deps.historyService

  const bookmarks = data && data.bookmarks
  if (bookmarks) {
    if (!bookmarks.ok) {
      if (bookmarks.error) result.errors.push(String(bookmarks.error))
    } else if (
      Array.isArray(bookmarks.trees) &&
      bookmarks.trees.length > 0 &&
      bookmarkService &&
      typeof bookmarkService.importTrees === 'function'
    ) {
      try {
        const written = bookmarkService.importTrees(bookmarks.trees)
        result.bookmarks.imported = Number(written && written.imported) || 0
        result.bookmarks.skipped = Number(written && written.skipped) || 0
        if (written.error) result.errors.push(`书签写入失败：${String(written.error)}`)
      } catch (e) {
        result.errors.push(`书签写入失败：${errorMessage(e)}`)
      }
    }
  }

  const history = data && data.history
  if (history) {
    if (!history.ok) {
      if (history.error) result.errors.push(String(history.error))
    } else if (
      Array.isArray(history.visits) &&
      history.visits.length > 0 &&
      historyService &&
      typeof historyService.importVisits === 'function'
    ) {
      try {
        const written = historyService.importVisits(history.visits)
        result.history.imported = Number(written && written.imported) || 0
        result.history.skipped = Number(written && written.skipped) || 0
        if (written.error) result.errors.push(`历史写入失败：${String(written.error)}`)
      } catch (e) {
        result.errors.push(`历史写入失败：${errorMessage(e)}`)
      }
    }
  }

  return result
}

