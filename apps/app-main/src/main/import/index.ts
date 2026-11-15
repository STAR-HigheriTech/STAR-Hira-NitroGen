/**
 * 浏览器一键迁移 · 编排层（主进程唯一入口）
 *
 * 五段解耦（见 docs-ng/浏览器一键迁移调研与落地方案.md §10.2）：
 *   detect → 发现浏览器与 profile（只读元信息，不碰用户数据目录）
 *   copy   → 主库 / -wal / -shm 快照到临时目录
 *   parse  → 纯函数解析成「领域入参」（书签树 / 访问记录）
 *   write  → 转调既有领域批量入口（不新开写路径）
 *   cleanup → 无论成败都删临时快照
 *
 * 对外只有两个方法：`listSources()` / `importFrom(request)`。
 * 全部返回结构化结果（`{ ok, ..., errors[] }`），**永不抛异常** ——
 * 导入是引导流程里的可选一屏，失败也必须让用户能继续。
 */
import path from 'node:path'
import { findSource, listDetectedSources, type DetectedSourceList } from './detect'
import { copyFiles, cleanup, type CopyResult } from './copy'
import { parseBookmarksFile, type ParseBookmarksResult } from './parse/bookmarks'
import { parseHistoryFile, type ParseHistoryResult } from './parse/history'
import {
  parseFaviconsFile,
  type FaviconParseFailure,
  type ParsedFavicons
} from './parse/favicons'
import {
  applyImportedFavicons,
  collectIconAssignments,
  collectPageUrls,
  type ImportedFaviconService,
  type ImportedParsedData
} from './apply-icons'
import {
  importExtensionsFromProfile,
  type ExtensionImportResult,
  type ExtensionInstallService
} from './extensions'
import {
  writeParsedData,
  type ImportWriteDependencies,
  type ImportWriteResult
} from './write'
import { DATASET_CAPABILITY, normalizeDatasets, type DatasetName } from './capabilities'

export interface ImportCounters {
  imported: number
  skipped: number
}

export interface BrowserProfileImportResult {
  id: string
  name: string
  bookmarks: ImportCounters
  history: ImportCounters
  extensions: ImportCounters
}

export interface BrowserImportResult {
  ok: boolean
  sourceId?: string
  bookmarks: ImportCounters
  history: ImportCounters
  extensions: ImportCounters
  profiles: BrowserProfileImportResult[]
  errors: string[]
  error?: string
}

export interface BrowserImportRequest {
  sourceId?: unknown
  profileIds?: unknown
  datasets?: unknown
}

interface BrowserSourceFailure { ok: false; sources: []; error: string }

interface BookmarkBackfillPort {
  backfillFavicons?(assignments: Array<{ url: string; favicon: string }>): unknown
}

interface HistoryBackfillPort {
  backfillFavicons?(assignments: Array<{ url: string; favicon: string }>): unknown
}

type BookmarkImportFacade = NonNullable<ImportWriteDependencies['bookmarkService']> & BookmarkBackfillPort
type HistoryImportFacade = NonNullable<ImportWriteDependencies['historyService']> & HistoryBackfillPort

export interface BrowserImportDependencies {
  bookmarkService?: BookmarkImportFacade
  historyService?: HistoryImportFacade
  faviconService?: ImportedFaviconService
  getExtensionService?: () => ExtensionInstallService | null | undefined
}

export interface BrowserImportService {
  listSources(): Promise<DetectedSourceList | BrowserSourceFailure>
  importFrom(request?: BrowserImportRequest | null): Promise<BrowserImportResult>
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function emptyCounters(): ImportCounters {
  return { imported: 0, skipped: 0 }
}

function failure(error: unknown, extra: { sourceId?: string } = {}): BrowserImportResult {
  return {
    ok: false,
    bookmarks: emptyCounters(),
    history: emptyCounters(),
    extensions: emptyCounters(),
    profiles: [],
    errors: [],
    error: String(error),
    ...extra
  }
}

/**
 * @param {{
 *   bookmarkService?: any,
 *   historyService?: any,
 *   faviconService?: any,
 *   getExtensionService?: () => any
 * }} deps 领域服务（main.js 注入）
 *   getExtensionService 用 getter 而不是实例：扩展服务随 profile 切换重建，
 *   迁移必须拿到**当前** profile 的那份。
 */
export function createBrowserImportService(deps: BrowserImportDependencies = {}): BrowserImportService {
  const bookmarkService = deps.bookmarkService
  const historyService = deps.historyService
  const faviconService = deps.faviconService
  const getExtensionService = typeof deps.getExtensionService === 'function'
    ? deps.getExtensionService
    : () => null

  /** 本机可用的浏览器源（页面据此渲染卡片；不可用的源也可展示为禁用态）。 */
  async function listSources(): Promise<DetectedSourceList | BrowserSourceFailure> {
    try {
      return listDetectedSources()
    } catch (e) {
      console.error('[browser-import] 检测浏览器来源失败:', errorMessage(e))
      return { ok: false, sources: [], error: errorMessage(e) }
    }
  }

  /**
   * 执行一次导入。
   *
   * @param {{
   *   sourceId?: string,
   *   profileIds?: string[],
   *   datasets?: string[]
   * }} request
   *   profileIds 缺省 = 该源下所有检测到的 profile；
   *   datasets   缺省 = 该源支持的全部数据集（书签 / 历史）。
   */
  async function importFrom(request?: BrowserImportRequest | null): Promise<BrowserImportResult> {
    const req = request && typeof request === 'object' ? request : {}
    const sourceId = String(req.sourceId || '').trim()
    const source = findSource(sourceId)
    if (!source) return failure('不支持的浏览器来源', { sourceId })

    try {
      const detected = source.listProfiles()
      if (!detected.ok) return failure(detected.error || '检测浏览器数据失败', { sourceId })
      const profiles = Array.isArray(detected.profiles) ? detected.profiles : []
      if (profiles.length === 0) {
        return failure('没有检测到可导入的数据（请先在该浏览器里使用过书签或历史）', { sourceId })
      }

      const requested: string[] = Array.isArray(req.profileIds)
        ? req.profileIds
          .map((value) => String(value || '').trim())
          .filter((value): value is string => value.length > 0)
        : []
      const targets: string[] = requested.length > 0 ? [...new Set(requested)] : profiles.map((profile) => profile.id)
      const datasets = normalizeDatasets(req.datasets, source.capabilities)
      if (datasets.length === 0) return failure('没有可导入的数据类型', { sourceId })

      const byId = new Map(profiles.map((profile) => [profile.id, profile]))
      const totals: Record<'bookmarks' | 'history' | 'extensions', ImportCounters> = {
        bookmarks: emptyCounters(),
        history: emptyCounters(),
        extensions: emptyCounters()
      }
      const profileResults: BrowserProfileImportResult[] = []
      const errors: string[] = []

      for (const profileId of targets) {
        const meta = byId.get(profileId)
        if (!meta) {
          errors.push(`未找到 profile：${profileId}`)
          continue
        }
        const wanted: DatasetName[] = datasets.filter(
          (name) => (meta.capabilities & DATASET_CAPABILITY[name]) !== 0
        )
        if (wanted.length === 0) continue

        const resolved = source.resolveProfile(profileId)
        if (!resolved.ok) {
          errors.push(`${meta.name}：${resolved.error}`)
          continue
        }

        const files: Array<{ name: string; src: string }> = []
        if (wanted.includes('bookmarks') && resolved.hasBookmarks) {
          files.push({ name: 'Bookmarks', src: path.join(resolved.dir, 'Bookmarks') })
        }
        if (wanted.includes('history') && resolved.hasHistory) {
          files.push({ name: 'History', src: path.join(resolved.dir, 'History') })
        }
        // 图标库是书签 / 历史**共用**的一份：有它才能让导入结果一打开就带图标，
        // 不必逐行去 `<origin>/favicon.ico` 联网抓（那正是导入后卡顿的来源）。
        // 文件缺席是正常情况（旧版浏览器或用户从未缓存过图标），按「没有图标」降级。
        if (wanted.includes('bookmarks') || wanted.includes('history')) {
          files.push({ name: 'Favicons', src: path.join(resolved.dir, 'Favicons') })
        }

        // 只选了扩展时没有任何文件要快照 → 连临时目录都不建。
        let copy: CopyResult = { dir: null, copied: [], missing: [] }
        if (files.length > 0) {
          copy = copyFiles(files)
          if (!copy.dir) {
            errors.push(`${meta.name}：无法创建临时副本`)
            continue
          }
        }

        const parsed: ImportedParsedData = {}
        let faviconIndex: ParsedFavicons | FaviconParseFailure | null = null
        try {
          const bookmarkFile = copy.copied.find((f) => f.name === 'Bookmarks')
          const historyFile = copy.copied.find((f) => f.name === 'History')
          const faviconsFile = copy.copied.find((f) => f.name === 'Favicons')
          if (wanted.includes('bookmarks')) {
            parsed.bookmarks = bookmarkFile
              ? parseBookmarksFile(bookmarkFile.path)
              : { ok: false, error: '未找到可读取的 Bookmarks 文件（可能被浏览器独占）' }
          }
          if (wanted.includes('history')) {
            parsed.history = historyFile
              ? parseHistoryFile(historyFile.path)
              : { ok: false, error: '未找到可读取的 History 文件（可能被浏览器独占）' }
          }
          if (faviconsFile) {
            // 只解本次书签 / 历史真正用到的页面图标：源库可能几十 MB，全量解码会卡住主进程。
            faviconIndex = parseFaviconsFile(faviconsFile.path, { pageUrls: collectPageUrls(parsed) })
          }
        } finally {
          cleanup(copy.dir)
        }

        // 图标贴合：把源库里的真实图标字节入库并贴到书签 / 历史上（纯内存 + 本地库，
        // 不联网）。放在 write 之前，写入的每一行就自带可直接展示的图标地址。
        if (faviconIndex && !faviconIndex.ok) {
          console.warn('[browser-import] 图标库不可用，本次导入不带图标:', faviconIndex.error)
        }
        const icons = applyImportedFavicons(parsed, faviconIndex, faviconService)
        if (icons.attached > 0) {
          console.info(
            `[browser-import] ${meta.name}：${icons.attached} 条记录带入本地图标（${icons.icons} 张入库）`
          )
        }

        const written: ImportWriteResult = writeParsedData(parsed, { bookmarkService, historyService })

        // 补齐上一轮导入留下的空图标：迁移按 URL 幂等跳过，老行不会被重写，
        // 这里把本次拿到的本地图标贴到它们身上（只补空，不覆盖已有图标）。
        const assignments = [...collectIconAssignments(parsed)]
          .map(([url, favicon]) => ({ url, favicon }))
        if (assignments.length > 0) {
          if (bookmarkService && typeof bookmarkService.backfillFavicons === 'function') {
            bookmarkService.backfillFavicons(assignments)
          }
          if (historyService && typeof historyService.backfillFavicons === 'function') {
            historyService.backfillFavicons(assignments)
          }
        }
        totals.bookmarks.imported += written.bookmarks.imported
        totals.bookmarks.skipped += written.bookmarks.skipped
        totals.history.imported += written.history.imported
        totals.history.skipped += written.history.skipped
        for (const err of written.errors) errors.push(`${meta.name}：${err}`)

        // 扩展：不适配临时快照（要长期留在本应用存储里），由扩展服务自己复制 + 加载。
        let extensionResult: ImportCounters = emptyCounters()
        if (wanted.includes('extensions') && resolved.hasExtensions) {
          const installed = await importExtensionsFromProfile(resolved.extensionsDir, getExtensionService())
          extensionResult = { imported: installed.imported, skipped: installed.skipped }
          for (const err of installed.errors) errors.push(`${meta.name}：${err}`)
        }
        totals.extensions.imported += extensionResult.imported
        totals.extensions.skipped += extensionResult.skipped

        profileResults.push({
          id: meta.id,
          name: meta.name,
          bookmarks: written.bookmarks,
          history: written.history,
          extensions: extensionResult
        })
      }

      return {
        ok: errors.length === 0,
        sourceId,
        bookmarks: totals.bookmarks,
        history: totals.history,
        extensions: totals.extensions,
        profiles: profileResults,
        errors
      }
    } catch (e) {
      console.error('[browser-import] 导入失败:', e)
      // 只带原始原因：展示层的「导入失败：」前缀由页面统一加，避免出现两层前缀。
      return failure(errorMessage(e), { sourceId })
    }
  }

  return { listSources, importFrom }
}

