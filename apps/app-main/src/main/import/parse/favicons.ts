/**
 * Chromium `Favicons` SQLite → 页面 URL 与图标字节的索引
 *
 * 为什么必须从源库拿图标，而不是导入后再联网抓：
 *   · 源浏览器的 `Favicons` 里已经存着用户看过的**真实图标字节**（PNG），
 *     导入书签 / 历史时直接带上，页面一打开就有图标，不用等访问、不用再发网络请求；
 *   · 导入几千条历史后逐行去 `<origin>/favicon.ico` 会瞬间打爆主进程网络队列，
 *     这正是「导入后很卡、图标还要手动点开才出现」的根因。
 *
 * 源库结构（Chromium 公共部分，Chrome / Edge / 其它 Chromium 同构）：
 *   icon_mapping(page_url, icon_id)
 *   favicons(id, url)                    —— icon_id → 图标声明地址
 *   favicon_bitmaps(icon_id, image_data, width, height)  —— 多尺寸位图，一个 icon 可能有多张
 *
 * 输出：
 *   pages   Map<页面 URL, iconId>        —— 精确映射
 *   origins Map<origin, iconId>          —— 同站点兜底（书签 URL 没被访问过时仍能拿到站点图标）
 *   icons   Map<iconId, {buffer, contentType}>
 *
 * 只读临时副本、任何异常都返回 `{ ok:false }`，由编排层降级为「这次没有图标可用」。
 */
import { openReadonly, type SqliteHandle } from '@hira-ng/infra-db'

export interface FaviconIcon {
  buffer: Buffer
  contentType: string
}

export interface ParsedFavicons {
  ok: true
  pages: Map<string, string>
  origins: Map<string, string>
  icons: Map<string, FaviconIcon>
}

export interface FaviconParseFailure { ok: false; error: string }

export interface ParseFaviconsOptions { pageUrls?: Iterable<string> | null }

interface PickedBitmap extends FaviconIcon { area: number }

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' ? value as Record<string, unknown> : null
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** 单张图标上限：Chrome 的位图通常 < 64KB，超过这个量级基本是异常数据。 */
const MAX_ICON_BYTES = 512 * 1024
/** 批量取位图时的分块大小（规避 SQL 变量上限）。 */
const CHUNK = 200

const MAPPING_SQL = 'SELECT page_url AS pageUrl, icon_id AS iconId FROM icon_mapping'

export function sniffImageType(buffer: Uint8Array | null | undefined): string {
  if (!buffer || buffer.length < 4) return 'image/x-icon'
  const b = buffer
  if (b[0] === 0x89 && b[1] === 0x50) return 'image/png'
  if (b[0] === 0xff && b[1] === 0xd8) return 'image/jpeg'
  if (b[0] === 0x47 && b[1] === 0x49) return 'image/gif'
  if (b[0] === 0x3c) return 'image/svg+xml' // '<' —— 极少见，但合法
  return 'image/x-icon'
}

export function originOf(url: unknown): string | null {
  try {
    const u = new URL(String(url))
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return null
    return u.origin
  } catch (_) {
    return null
  }
}

/** 读取 icon_mapping（全量，几十 KB～几 MB；一次性读比按 URL 分批查询更简单）。 */
function readMappings(db: SqliteHandle): { pages: Map<string, string>; origins: Map<string, string> } {
  const rows = db.prepare(MAPPING_SQL).all() as unknown[]
  const pages = new Map<string, string>()
  const origins = new Map<string, string>()
  for (const row of rows) {
    const record = asRecord(row) || {}
    const pageUrl = typeof record.pageUrl === 'string' ? record.pageUrl : ''
    const iconId = record.iconId == null ? '' : String(record.iconId)
    if (!pageUrl || !iconId) continue
    pages.set(pageUrl, iconId)
    const origin = originOf(pageUrl)
    if (origin && !origins.has(origin)) origins.set(origin, iconId)
  }
  return { pages, origins }
}

/**
 * 按 icon_id 取「最大那张」位图。
 * 有些版本没有 width/height 列 —— 这时按行序取最后一张（SQLite 里后写的更新）。
 */
function readBitmaps(db: SqliteHandle, iconIds: string[]): Map<string, PickedBitmap> {
  const picked = new Map<string, PickedBitmap>()
  if (iconIds.length === 0) return picked

  const run = (withSize: boolean): boolean => {
    for (let i = 0; i < iconIds.length; i += CHUNK) {
      const chunk = iconIds.slice(i, i + CHUNK)
      const placeholders = chunk.map(() => '?').join(',')
      const columns = withSize
        ? 'icon_id AS iconId, image_data AS data, width AS width, height AS height'
        : 'icon_id AS iconId, image_data AS data, 0 AS width, 0 AS height'
      let rows: unknown[] = []
      try {
        rows = db.prepare(
          `SELECT ${columns} FROM favicon_bitmaps WHERE icon_id IN (${placeholders})`
        ).all(...chunk) as unknown[]
      } catch (_) {
        return false
      }
      for (const row of rows) {
        const record = asRecord(row) || {}
        const iconId = record.iconId == null ? '' : String(record.iconId)
        const blob = record.data
        const byteLength = blob && typeof blob === 'object' && 'length' in blob
          ? Number((blob as { length: unknown }).length)
          : 0
        if (!iconId || !blob || !Number.isFinite(byteLength) || byteLength === 0) continue
        if (byteLength > MAX_ICON_BYTES) continue
        const buffer = Buffer.isBuffer(blob)
          ? blob
          : Buffer.from(blob as Uint8Array)
        const area = (Number(record.width) || 0) * (Number(record.height) || 0)
        const prev = picked.get(iconId)
        // 面积大的优先；面积相同或都未知时，保留后出现的那张（更新）。
        if (!prev || area >= prev.area) {
          picked.set(iconId, { area, buffer, contentType: sniffImageType(buffer) })
        }
      }
    }
    return true
  }

  if (!run(true)) run(false)
  return picked
}

/**
 * 本次导入真正需要的 icon_id 集合。
 *
 * 源库的 `icon_mapping` 可能有几万行、位图能有几十 MB —— 全量解码会让导入在主进程里
 * 卡好几秒。这里只取「本次书签/历史里出现过的页面」及其站点（origin 兜底）所需的图标，
 * 其余一张都不读。
 *
 * @param {Map<string,string>} pages
 * @param {Map<string,string>} origins
 * @param {Iterable<string>|null} pageUrls  缺省 = 不限（全量，兼容无过滤调用）
 * @returns {Set<string>}
 */
function wantedIconIds(
  pages: Map<string, string>,
  origins: Map<string, string>,
  pageUrls: Iterable<string> | null | undefined
): Set<string> {
  const ids = new Set<string>()
  if (!pageUrls) {
    for (const id of pages.values()) ids.add(id)
    return ids
  }
  const wantedOrigins = new Set<string>()
  for (const url of pageUrls) {
    const id = pages.get(url)
    if (id) ids.add(id)
    const origin = originOf(url)
    if (origin) wantedOrigins.add(origin)
  }
  for (const origin of wantedOrigins) {
    const id = origins.get(origin)
    if (id) ids.add(id)
  }
  return ids
}

/**
 * @param {string} filePath 已复制到临时目录的 Favicons 文件
 * @param {{ pageUrls?: Iterable<string> }} [options]
 *   pageUrls = 本次导入涉及到的页面地址（只解这些页面需要的图标，见 wantedIconIds）
 * @returns {{ ok: true, pages: Map<string,string>, origins: Map<string,string>, icons: Map<string,{buffer:Buffer,contentType:string}> }
 *          | { ok: false, error: string }}
 */
export function parseFaviconsFile(
  filePath: string,
  options: ParseFaviconsOptions = {}
): ParsedFavicons | FaviconParseFailure {
  let db: SqliteHandle | null = null
  try {
    db = openReadonly(filePath)
    const { pages, origins } = readMappings(db)
    if (pages.size === 0) return { ok: true, pages, origins, icons: new Map() }
    const iconIds = [...wantedIconIds(pages, origins, options.pageUrls)]
    const icons = new Map<string, FaviconIcon>()
    for (const [iconId, entry] of readBitmaps(db, iconIds)) {
      icons.set(iconId, { buffer: entry.buffer, contentType: entry.contentType })
    }
    return { ok: true, pages, origins, icons }
  } catch (e) {
    return { ok: false, error: `读取图标库失败：${errorMessage(e)}` }
  } finally {
    if (db) {
      try {
        db.close()
      } catch (_) {}
    }
  }
}

