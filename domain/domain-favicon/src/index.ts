// @ts-check
/**
 * Domain: Favicon — favicon 缓存与同步服务
 *
 * 职责：
 *   1. 缓存页面 URL → favicon URL/data 的映射到 favicons 表
 *   2. 查询接口：按页面 URL 获取 favicon
 *   3. 同步：当标签页 favicon 更新时，自动补全同 URL 的书签和历史记录的 favicon 字段
 *
 * C13: 存储走 infra-db SQLite + Drizzle
 */

import { bookmarks, favicons, history } from '@hira-ng/infra-db/schema'
import {
  and as drizzleAnd,
  desc as drizzleDesc,
  eq as drizzleEq,
  isNull as drizzleIsNull,
  like as drizzleLike,
  lte as drizzleLte,
  not as drizzleNot,
  or as drizzleOr
} from 'drizzle-orm'
// 页面 URL 的**唯一身份口径**（与 history / 书签同源）。缓存键必须与它一致，
// 否则「历史写入」和「图标到达」两件事永远对不上（见 pageKey 的说明）。
import { canonicalHistoryUrl } from '@hira-ng/shared-utils'
import crypto from 'node:crypto'

interface FaviconRow {
  url: string
  profileId: string
  faviconUrl: string | null
  data: string | null
  updatedAt: number
}
interface FaviconCacheValue { faviconUrl: string | null; data: string | null }
type Condition = unknown
type BinaryCondition = (column: unknown, value: unknown) => Condition
type UnaryCondition = (column: unknown) => Condition
const eq = drizzleEq as unknown as BinaryCondition
const lte = drizzleLte as unknown as BinaryCondition
const like = drizzleLike as unknown as BinaryCondition
const not = drizzleNot as unknown as UnaryCondition
const isNull = drizzleIsNull as unknown as UnaryCondition
const desc = drizzleDesc as unknown as (column: unknown) => unknown
const and = drizzleAnd as unknown as (...conditions: Condition[]) => Condition
const or = drizzleOr as unknown as (...conditions: Condition[]) => Condition

interface FaviconWhere {
  get(): FaviconRow | undefined
  orderBy(value: unknown): { limit(value: number): { get(): FaviconRow | undefined } }
}
interface FaviconDatabase {
  select(projection?: Record<string, unknown>): { from(table: unknown): { where(condition: Condition): FaviconWhere } }
  insert(table: unknown): { values(value: Record<string, unknown>): { run(): unknown } }
  update(table: unknown): { set(value: Record<string, unknown>): { where(condition: Condition): { run(): unknown } } }
  delete(table: unknown): { where(condition: Condition): { run(): { changes: number } } }
}
export interface FaviconServiceOptions { getProfileId?: () => string }

/** 图标字节行的键前缀：内容寻址（`icon:<sha1>`），与页面 URL 缓存分开命名空间。 */
const ICON_KEY_PREFIX = 'icon:'

/** 是否是图标字节行的键（`icon:<sha1>`）—— 这类键绝不参与 URL 规范化。 */
function isIconKey(url: unknown): boolean {
  return String(url || '').startsWith(ICON_KEY_PREFIX)
}

/**
 * 页面 URL 的缓存键。
 *
 * ── 为什么要规范化 ────────────────────────────────────────────────
 * 缓存键曾经直接用 `webContents` 上报的原始 URL，而历史行用的是
 * `canonicalHistoryUrl`（去追踪参数 / 非根路径去尾斜杠）。两者只要差一个
 * `?spm_…` 或一个 `/`，就会出现：
 *   · 历史写入时 `get()` 查不到图标（看起来像「记得太快，图标还没到」）；
 *   · 图标晚到时 `syncToBookmarksAndHistory()` 匹配不到刚写的历史行 → 永久空图标。
 * 现在两边同一套键，时序先后都能对上。
 *
 * @param {string} url
 * @returns {string}
 */
function pageKey(url: unknown): string {
  const raw = String(url || '')
  if (!raw || isIconKey(raw)) return raw
  return canonicalHistoryUrl(raw)
}

/**
 * 站点原点（`scheme://host[:port]`）；解析不出（非 http(s) / 畸形地址）返回空串。
 * @param {string} url
 * @returns {string}
 */
function originKeyOf(url: unknown): string {
  try {
    return new URL(String(url || '')).origin
  } catch (_) {
    return ''
  }
}

/**
 * @param {import('drizzle-orm/better-sqlite3').BetterSQLite3Database} db
 * @param {{ getProfileId?: () => string }} [options]
 *   getProfileId —— 可选端口：当前 profile。favicons 的主键里带页面 URL（= 访问记录），
 *                   必须按 profile 分区；同步书签/历史时也要用**同一个** profile，
 *                   否则会把 A 用户的图标写到 B 用户的记录上。缺省 'default'。
 */
function createFaviconService(db: FaviconDatabase, options: FaviconServiceOptions = {}) {
  const now = () => Date.now()
  const profileIdPort = typeof options.getProfileId === 'function' ? options.getProfileId : null

  /**
   * 当前 profile。端口缺失或抛错一律回落 'default' ——
   * **绝不能**「拿不到就不过滤」：那等于跨 profile 串数据。
   * @returns {string}
   */
  function currentProfile() : string {
    if (!profileIdPort) return 'default'
    try {
      const v = profileIdPort()
      return v ? String(v) : 'default'
    } catch (_) {
      return 'default'
    }
  }

  /** favicons 分区条件（复合主键的前半段）。 */
  function pageCond(pageUrl: string): Condition {
    return and(eq(favicons.profileId, currentProfile()), eq(favicons.url, pageUrl))
  }

  /**
   * 缓存页面 favicon（upsert）。
   * @param {string} pageUrl   页面 URL（内部按 `pageKey` 规范化后作为键）
   * @param {string} faviconUrl  favicon 文件 URL
   * @param {string} [data]     base64 编码数据（可选）
   */
  function cache(pageUrl: unknown, faviconUrl: unknown, data?: string | null): void {
    const key = pageKey(pageUrl)
    if (!key || !faviconUrl) return
    const existing = db.select().from(favicons).where(pageCond(key)).get()
    const ts = now()
    if (existing) {
      db.update(favicons).set({
        faviconUrl,
        data: data ?? existing.data,
        updatedAt: ts
      }).where(pageCond(key)).run()
    } else {
      db.insert(favicons).values({
        url: key,
        profileId: currentProfile(),
        faviconUrl,
        data: data ?? null,
        updatedAt: ts
      }).run()
    }
  }

  /**
   * 站点级图标兜底：同站点内任一 URL 的缓存图标。
   *
   * SPA 的每次路由换址都是一个**新 URL**，但图标属于这个站点；
   * `page-favicon-updated` 只在文档首次加载时播报一次，路由换址不会再来 ——
   * 没有这一层，站点内跳转出来的历史行永远拿不到图标。
   *
   * @param {string} key 已规范化的页面 URL
   * @returns {{faviconUrl: string|null, data: string|null}}
   */
  function originFallback(key: string): FaviconCacheValue {
    const empty = { faviconUrl: null, data: null }
    const origin = originKeyOf(key)
    if (!origin) return empty
    const row = db.select().from(favicons)
      .where(and(
        eq(favicons.profileId, currentProfile()),
        // 图标字节行（icon:）不是页面 URL，不能当站点图标返回
        not(like(favicons.url, `${ICON_KEY_PREFIX}%`)),
        or(eq(favicons.url, origin), like(favicons.url, `${origin}/%`))
      ))
      .orderBy(desc(favicons.updatedAt))
      .limit(1)
      .get()
    if (!row || !row.faviconUrl) return empty
    return { faviconUrl: row.faviconUrl, data: row.data }
  }

  /**
   * 获取页面的 favicon URL：先精确命中，再退回同站点图标。
   * @param {string} pageUrl
   * @returns {{faviconUrl: string|null, data: string|null}}
   */
  function get(pageUrl: unknown): FaviconCacheValue {
    const key = pageKey(pageUrl)
    if (!key) return { faviconUrl: null, data: null }
    const row = db.select().from(favicons).where(pageCond(key)).get()
    if (row && row.faviconUrl) return { faviconUrl: row.faviconUrl, data: row.data }
    return originFallback(key)
  }

  /**
   * 把 favicon 回填到某张表里「同 URL 或同站点、且图标还空着」的行。
   *
   * ── 为什么按站点范围回填 ──────────────────────────────────────────
   * 图标在浏览器里就是**站点级**的（Chromium 也是如此展示）：一次
   * `page-favicon-updated` 只覆盖那一个文档，而用户在同一站点内的其它页
   * （SPA 路由换址、带追踪参数的收银台/文章页）用的是同一张图标。
   * 只精确匹配 URL 会让这些行永久空着 —— 用户看到的就是「有的记录没图标」。
   *
   * 只填空（`NULL` / 空串），绝不覆盖已有图标。
   *
   * 只写 `favicon` 一列：图标是**缓存回填**，不是用户编辑 —— 绝不能顺带抬
   * `modifiedAt`（那会让「最近修改」失真，与书签域自己的口径相反）。
   *
   * @param {object} table   schema 表（bookmarks / history）
   * @param {string} urlCol  该表的 URL 列名
   * @param {{ url:string, favicon:string }} entry
   */
  function syncInto(table: unknown, urlCol: unknown, entry: { url: string; favicon: string }): void {
    try {
      const target = table as Record<string, unknown>
      const key = pageKey(entry.url)
      if (!key) return
      const origin = originKeyOf(key)
      const scope = origin
        ? or(eq(urlCol, key), eq(urlCol, origin), like(urlCol, `${origin}/%`))
        : eq(urlCol, key)
      db.update(table)
        .set({ favicon: entry.favicon })
        .where(and(
          eq(target.profileId, currentProfile()),
          or(isNull(target.favicon), eq(target.favicon, '')),
          scope
        ))
        .run()
    } catch (_) {
      // 表可能不存在或 schema 不同，忽略
    }
  }

  /**
   * 同步 favicon 到书签和历史中同站点的记录（**同一 profile 内**、只补空）。
   * 当标签页 favicon 更新时调用，确保书签/历史也有 favicon。
   * @param {string} pageUrl
   * @param {string} faviconUrl
   */
  function syncToBookmarksAndHistory(pageUrl: unknown, faviconUrl: unknown): void {
    if (!pageUrl || !faviconUrl) return
    const entry = { url: String(pageUrl), favicon: String(faviconUrl) }
    syncInto(bookmarks, bookmarks.url, entry)
    syncInto(history, history.url, entry)
  }

  /**
   * 缓存并同步 favicon（一步到位）。
   * TabManager page-favicon-updated 事件调用此方法。
   * @param {string} pageUrl
   * @param {string} faviconUrl
   */
  function cacheAndSync(pageUrl: unknown, faviconUrl: unknown): void {
    if (!pageUrl || !faviconUrl) return
    cache(pageUrl, faviconUrl)
    syncToBookmarksAndHistory(pageUrl, faviconUrl)
  }

  /**
   * 淘汰在指定时间之前更新的 favicon 缓存条目（保留策略）。
   *
   * favicon 是可随时重新抓取的纯缓存（书签/历史已各自存了一份 URL），
   * 无需永久保留；不清理会导致 favicons 表随浏览历史无界增长。
   *
   * **内容寻址的图标字节行（`icon:`）不清**：它们是导入时从源浏览器搬来的资产，
   * 没有可重新抓取的来源 —— 一旦删掉，导入的书签/历史就永久失去图标。
   * @param {number} beforeTs Unix ms
   * @returns {number} 删除条数
   */
  function removeBefore(beforeTs: number): number {
    const result = db.delete(favicons)
      .where(and(
        eq(favicons.profileId, currentProfile()),
        lte(favicons.updatedAt, beforeTs),
        not(like(favicons.url, `${ICON_KEY_PREFIX}%`))
      ))
      .run()
    return result.changes
  }

  /** 图标字节行的主键（内容哈希后的小写十六进制）。 */
  function iconKey(hash: unknown): string {
    return ICON_KEY_PREFIX + String(hash || '').toLowerCase()
  }

  /** 图标 MIME：声明优先，否则按文件头嗅探（Chromium 位图绝大多数是 PNG）。 */
  function resolveIconType(contentType: unknown, buffer: Buffer): string {
    const declared = String(contentType || '').toLowerCase().split(';')[0].trim()
    if (/^image\//.test(declared)) return declared
    if (!buffer || buffer.length < 4) return 'image/x-icon'
    if (buffer[0] === 0x89 && buffer[1] === 0x50) return 'image/png'
    if (buffer[0] === 0xff && buffer[1] === 0xd8) return 'image/jpeg'
    if (buffer[0] === 0x47 && buffer[1] === 0x49) return 'image/gif'
    if (buffer[0] === 0x3c) return 'image/svg+xml'
    return 'image/x-icon'
  }

  /**
   * 存一张图标字节（内容寻址 + 天然去重），返回可直接塞进 `bookmark.favicon` 的地址。
   *
   * 与 `cache()` 的区别：`cache()` 记的是「页面 URL → 图标 URL」的映射；
   * 这里存的是**图标本身**。源浏览器的 Favicons 库里就是字节，导入时搬进来后
   * 页面渲染零联网 —— 这是「导入后图标立刻可用、且不卡」的关键。
   *
   * @param {Buffer|Uint8Array} buffer
   * @param {string} [contentType]
   * @returns {string|null} `hira://favicon/?icon=<hash>`；空数据返回 null
   */
  function putIcon(buffer: Buffer | Uint8Array | null | undefined, contentType?: unknown): string | null {
    if (!buffer || !buffer.length) return null
    const bytes = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer)
    if (bytes.length === 0) return null
    const hash = crypto.createHash('sha1').update(bytes).digest('hex')
    const key = iconKey(hash)
    const url = `hira://favicon/?icon=${hash}`

    const existing = db.select({ url: favicons.url }).from(favicons).where(pageCond(key)).get()
    if (!existing) {
      const type = resolveIconType(contentType, bytes)
      db.insert(favicons).values({
        url: key,
        profileId: currentProfile(),
        faviconUrl: url,
        data: `data:${type};base64,${bytes.toString('base64')}`,
        updatedAt: now()
      }).run()
    }
    return url
  }

  /**
   * 读回一张图标字节（`hira://favicon/?icon=<hash>` 的服务端）。
   * @param {string} hash
   * @returns {{ contentType: string, buffer: Buffer } | null}
   */
  function getIcon(hash: unknown): { contentType: string; buffer: Buffer } | null {
    const id = String(hash || '').toLowerCase().replace(/[^a-f0-9]/g, '')
    if (!id) return null
    const row = db.select().from(favicons).where(pageCond(iconKey(id))).get()
    if (!row || !row.data) return null
    const match = /^data:([^;]+);base64,(.*)$/s.exec(String(row.data))
    if (!match) return null
    try {
      return { contentType: match[1] || 'image/x-icon', buffer: Buffer.from(match[2], 'base64') }
    } catch (_) {
      return null
    }
  }

  return {
    cache,
    get,
    putIcon,
    getIcon,
    syncToBookmarksAndHistory,
    cacheAndSync,
    removeBefore
  }
}

export { createFaviconService }
export default { createFaviconService }
