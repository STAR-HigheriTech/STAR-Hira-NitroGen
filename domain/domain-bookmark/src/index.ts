// @ts-check
/**
 * Domain: Bookmark — 书签 + 文件夹管理
 *
 * C13: 存储走 infra-db SQLite + Drizzle 事务
 * C11: domain 层依赖 infra 层，不依赖 ui 层
 *
 * L1 功能映射:
 *   F-0001 创建书签    F-0002 删除书签    F-0003 编辑书签
 *   F-0004 创建文件夹  F-0005 删除文件夹  F-0006 移动书签
 *   F-0007 排序书签    F-0008 搜索书签    F-0009 导入书签
 *   F-0010 导出书签
 */

import { bookmarks } from '@hira-ng/infra-db/schema'
import {
  and as drizzleAnd,
  asc as drizzleAsc,
  desc as drizzleDesc,
  eq as drizzleEq,
  isNull as drizzleIsNull,
  like as drizzleLike,
  or as drizzleOr,
  sql
} from 'drizzle-orm'
import { buildMatchQuery, generateId } from '@hira-ng/shared-utils'
import {
  clearTagIndex,
  createTagIndex,
  indexPage,
  reindexPage,
  unindexPage,
  suggestTags as suggestTagsFromIndex,
  autocompleteTags as autocompleteTagsFromIndex,
} from '@hira-ng/shared-types/src/tag-index.mjs'
// 标签的唯一真源（系统标签映射 / 计数 / 过滤）—— 主进程与两处 UI 跑同一份规则，
// 避免"面板过滤得到、页面过滤不到"这类两份真相的漂移。
import {
  SYSTEM_TAG_PINNED,
  SYSTEM_TAG_RAIL,
  systemTagMeta,
  normalizeTag,
  normalizeTagList,
  isSystemTagLike,
  stripSystemTags,
  filterRowsByTag,
  buildTagCounts,
} from '@hira-ng/shared-types/src/bookmark-tags.mjs'

export type BookmarkChangeReason = 'add' | 'remove' | 'update' | 'move' | 'reorder' | 'import' | 'clear'
export interface BookmarkChange { reason: BookmarkChangeReason; id: string | null; url: string | null }

export interface BookmarkRow {
  id: string
  profileId: string
  parentId: string | null
  title: string
  nickname: string | null
  url: string | null
  favicon: string | null
  tags: string | null
  pinned: number
  pinnedOrder: number
  railPinned: number
  railPinnedOrder: number
  openInSidebar: number
  summary: string | null
  summaryAt: number | null
  sortOrder: number
  createdAt: number
  modifiedAt: number
}

export interface Bookmark extends Omit<BookmarkRow, 'tags' | 'pinned' | 'railPinned' | 'openInSidebar'> {
  tags: string[]
  pinned: boolean
  railPinned: boolean
  openInSidebar: boolean
}

export interface BookmarkTreeNode extends Bookmark { children?: BookmarkTreeNode[] }
export interface BookmarkSnapshot {
  parentId: string | null
  tag: string | null
  query: string | null
  items: Bookmark[]
  pinned: Bookmark[]
  pinnedOrder: string[]
  folders: BookmarkTreeNode[]
  tags: BookmarkTagCount[]
}
export interface BookmarkTagCount { tag: string; count: number; system: boolean; label: string }
export interface AddBookmarkInput {
  parentId?: string | null
  title: string
  nickname?: string | null
  url?: string | null
  favicon?: string | null
  tags?: string[] | null
  summary?: string | null
}
export interface UpdateBookmarkInput {
  title?: string
  nickname?: string | null
  url?: string | null
  favicon?: string | null
  tags?: string[] | null
  summary?: string | null
}
export interface BookmarkServiceOptions {
  hasFts?: boolean
  faviconPort?: { resolve: (url: string) => string | null } | null
  getProfileId?: () => string
}
export interface BookmarkImportNode {
  title?: unknown
  url?: unknown
  favicon?: unknown
  dateAdded?: unknown
  children?: readonly BookmarkImportNode[]
}
export interface BookmarkImportTree {
  title?: unknown
  pinned?: unknown
  children?: readonly BookmarkImportNode[]
}
export interface BookmarkImportResult {
  imported: number
  skipped: number
  folders?: number
  error?: string
}

type Condition = unknown
type SystemTagMeta = NonNullable<ReturnType<typeof systemTagMeta>>
type ValueCondition = (column: unknown, value: unknown) => Condition
type NullCondition = (column: unknown) => Condition
const eq = drizzleEq as unknown as ValueCondition
const like = drizzleLike as unknown as ValueCondition
const and = drizzleAnd as unknown as (...conditions: Condition[]) => Condition
const or = drizzleOr as unknown as (...conditions: Condition[]) => Condition
const asc = drizzleAsc as unknown as (column: unknown) => unknown
const desc = drizzleDesc as unknown as (column: unknown) => unknown
const isNull = drizzleIsNull as unknown as NullCondition

interface RunResult { changes: number }
interface Query<T = BookmarkRow> {
  where(condition: Condition): Query<T>
  orderBy(...values: unknown[]): Query<T>
  limit(value: number): Query<T>
  get(): T | undefined
  all(): T[]
}
interface WriteQuery { where(condition: Condition): { run(): RunResult }; run(): RunResult }
interface BookmarkDatabase {
  select(): { from(table: unknown): Query<BookmarkRow> }
  select(projection: Record<string, unknown>): { from(table: unknown): Query<Record<string, unknown>> }
  insert(table: unknown): { values(value: Record<string, unknown>): { run(): RunResult } }
  update(table: unknown): { set(value: Record<string, unknown>): WriteQuery }
  delete(table: unknown): { where(condition: Condition): { run(): RunResult } }
  transaction<T>(callback: (tx: BookmarkDatabase) => T): T
  all(query: unknown): unknown[]
}

/**
 * 标签索引缓存（F-0756~F-0760）：profileId → 索引。
 *
 * 放在模块级而不是 service 内：同一个 profile 可能被多个 service 实例（窗口 /
 * 插件代理）共用，索引只有一份才谈得上"增量维护"。
 * **懒构建**：第一次查建议时才扫库；之后的增删改在已有索引上增量维护
 * （未构建则什么都不做 —— 不为没人使用的索引付写路径成本）。
 */
const tagIndexByProfile = new Map<string, ReturnType<typeof createTagIndex>>()

/**
 * @typedef {Object} Bookmark
 * @property {string} id
 * @property {string|null} parentId
 * @property {string} title
 * @property {string|null} nickname 展示用短名（窄书签栏/收藏夹放不下长标题时用它；留空回落到 title）
 * @property {string|null} url
 * @property {string|null} favicon
 * @property {boolean} pinned       固定到书签栏（横向那一条）
 * @property {boolean} railPinned   固定到 rail（侧栏图标栏，纵向那一列）—— 与 pinned 相互独立
 * @property {boolean} openInSidebar 点击该书签时**默认在独立侧栏打开**（无修饰键时生效）
 * @property {string|null} summary 收藏摘要（AI 生成的正文要点；NULL = 从未生成）
 * @property {number|null} summaryAt 摘要生成时间（ms）；NULL = 从未生成
 * @property {number} createdAt
 * @property {number} modifiedAt
 */



/* ============================================================
 * 变更事件（域内最小事件源）
 *
 * 老版 Hira 的经验：所有 UI 订阅 repo 'changed' 刷新，而不是各处
 * setTimeout 重拉。这里由 domain 层充当"唯一变更事实源"，APPS 层
 * 负责把它转译成 IPC 广播 —— domain 不摸 electron（R3），APPS 不
 * 复制写逻辑，职责各归其位。
 *
 * payload 形态刻意做小：{ reason, id, url }
 *   - reason: 'add'|'remove'|'update'|'move'|'reorder'|'import'|'clear'
 *   - id/url: 受影响书签（若可定位）；url 为 null 表示需要全量刷新
 * ============================================================ */

/**
 * @typedef {'add'|'remove'|'update'|'move'|'reorder'|'import'|'clear'} BookmarkChangeReason
 * @typedef {{ reason: BookmarkChangeReason, id: string|null, url: string|null }} BookmarkChange
 */



/**
 * Create bookmark service bound to a drizzle db instance.
 * @param {import('drizzle-orm/better-sqlite3').BetterSQLite3Database} db
 * @param {{ hasFts?: boolean, faviconPort?: { resolve: (url: string) => string|null }, getProfileId?: () => string }} [options]
 *   hasFts     —— infra-db 探测到的 FTS5 可用性
 *   faviconPort —— 可选端口：按页面 URL 解析 favicon（由 APPS 层注入 favicon 缓存实现）。
 *                  domain 不感知 favicon 的存储方式，仅通过端口取用（R3 解耦）。
 *   getProfileId —— 可选端口：当前 profile（Steam 式多用户的数据分区键）。
 *                  domain 不认识「窗口 / 运行单元」，只向 APPS 要一个字符串（同一套端口解耦口径）。
 *                  缺省 'default'，保证单 profile 场景与改造前逐字节等价。
 */
function createBookmarkService(db: BookmarkDatabase, options: BookmarkServiceOptions = {}) {
  const now = () => Date.now()
  const ftsEnabled = !!options.hasFts
  const faviconPort = options.faviconPort || null
  const profileIdPort = typeof options.getProfileId === 'function' ? options.getProfileId : null

  /**
   * 当前 profile。端口缺失或抛错一律回落 'default' ——
   * **绝不能**「拿不到就不过滤」：那等于跨 profile 串数据，比落错分区严重得多。
   * @returns {string}
   */
  function currentProfile(): string {
    if (!profileIdPort) return 'default'
    try {
      const v = profileIdPort()
      return v ? String(v) : 'default'
    } catch (_) {
      return 'default'
    }
  }

  /** profile 分区条件（所有读写都必须带上）。 */
  function profileCond(): Condition {
    return eq(bookmarks.profileId, currentProfile())
  }

  /**
   * 取当前 profile 的标签索引；不存在时**懒构建**一次（只扫有标签的书签列）。
   * @returns {ReturnType<typeof createTagIndex>}
   */
  function getTagIndex(): ReturnType<typeof createTagIndex> {
    const profile = currentProfile()
    const cached = tagIndexByProfile.get(profile)
    if (cached) return cached

    const index = createTagIndex()
    try {
      const rows = db.select({
        id: bookmarks.id,
        title: bookmarks.title,
        url: bookmarks.url,
        tags: bookmarks.tags,
        modifiedAt: bookmarks.modifiedAt
      }).from(bookmarks).where(eq(bookmarks.profileId, profile)).all()
      for (const row of rows) {
        indexPage(index, {
          id: String(row.id),
          title: String(row.title || ''),
          url: row.url == null ? null : String(row.url),
          tags: parseTags(row.tags),
          lastVisit: Number(row.modifiedAt) || 0
        })
      }
    } catch (e) {
      console.error('[bookmark-service] tag index build failed:', e)
    }
    tagIndexByProfile.set(profile, index)
    return index
  }

  /** 已构建则返回索引，未构建返回 null —— 写路径据此决定"要不要维护"。 */
  function activeTagIndex(): ReturnType<typeof createTagIndex> | null {
    return tagIndexByProfile.get(currentProfile()) || null
  }

  /**
   * 解析书签图标：显式值优先；否则向注入的 faviconPort 查询缓存。
   * 端口缺失或异常时退化为 null（不阻断写路径）。
   * @param {string|null|undefined} url
   * @param {string|null|undefined} explicit 调用方显式传入的 favicon
   * @returns {string|null}
   */
  function resolveFavicon(url: string | null | undefined, explicit: string | null | undefined): string | null {
    if (explicit != null) return explicit
    if (!url || !faviconPort || typeof faviconPort.resolve !== 'function') return null
    try {
      return faviconPort.resolve(url) || null
    } catch (_) {
      return null
    }
  }

  /**
   * 用户标签序列化：**剥离系统标签**后落库。
   *
   * `system:pinned` / `system:rail` 是派生标签（见 shared-types#bookmark-tags.mjs），
   * 事实源是 `pinned` / `railPinned` 两列 —— 写进 tags 列就会出现「tags 里挂着
   * system:pinned 但 pinned=0」这种两份真相互相打架的脏数据。
   * @param {string[]|null|undefined} tags
   * @returns {string|null}
   */
  function serializeTags(tags: readonly unknown[] | null | undefined): string | null {
    const clean = stripSystemTags(tags)
    return clean.length ? JSON.stringify(clean) : null
  }

  /**
   * 反序列化：历史脏数据里若混进 `system:*`（早期版本可直接写入），一律剥掉 ——
   * 读路径与写路径共用同一套规范化，避免"删了又冒回来"。
   * @param {string|null} raw
   * @returns {string[]}
   */
  function parseTags(raw: unknown): string[] {
    if (!raw) return []
    try {
      const arr = JSON.parse(String(raw))
      return Array.isArray(arr) ? stripSystemTags(arr) : []
    } catch (_) {
      return []
    }
  }

  /**
   * 昵称归一化（N11）：去空白，空串一律存 NULL ——
   * 让"没有昵称"在库里只有**一种**表示（NULL），渲染层统一用 `nickname || title` 即可，
   * 不必再区分 '' 与 NULL 两种空态。
   * @param {string|null|undefined} value
   * @returns {string|null}
   */
  function normalizeNickname(value: unknown): string | null {
    if (value == null) return null
    const s = String(value).trim()
    return s ? s : null
  }

  /** 摘要长度上限：与 IPC 契约（4000）保持同一个口径，防越界写入。 */
  const SUMMARY_MAX = 4000

  /**
   * 摘要归一化：去首尾空白、空串 → NULL（与昵称同一套"空态只有一种表示"的口径）。
   * 超长直接截断而不是报错 —— 摘要是展示性派生数据，写不进去比短一点更糟。
   * @param {string|null|undefined} value
   * @returns {string|null}
   */
  function normalizeSummary(value: unknown): string | null {
    if (value == null) return null
    const s = String(value).trim()
    if (!s) return null
    return s.length > SUMMARY_MAX ? s.slice(0, SUMMARY_MAX) : s
  }

  /**
   * 出口归一化：tags JSON 字符串 → 数组、三个 0/1 整型布尔 → boolean。
   * 存储细节（JSON 序列化、SQLite 整型布尔）绝不越过 domain 边界。
   */
  function normalizeRow(row: BookmarkRow | null | undefined): Bookmark | null {
    if (!row) return null
    return {
      ...row,
      tags: parseTags(row.tags),
      pinned: !!row.pinned,
      railPinned: !!row.railPinned,
      openInSidebar: !!row.openInSidebar
    }
  }

  function normalizeRows(rows: readonly BookmarkRow[]): Bookmark[] {
    return rows.map(normalizeRow).filter((row): row is Bookmark => row !== null)
  }

  /** @type {Set<(change: BookmarkChange) => void>} */
  const changeListeners: Set<(change: BookmarkChange) => void> = new Set<(change: BookmarkChange) => void>()

  /**
   * 向订阅者派发一次变更。监听器异常只记日志，绝不影响写路径，
   * 也不让一个坏监听器拖垮其他监听器（对齐老版 makeEmitter 语义）。
   * @param {BookmarkChangeReason} reason
   * @param {string|null} id
   * @param {string|null} url
   */
  function emitChange(reason: BookmarkChangeReason, id: string | null, url: string | null): void {
    for (const fn of changeListeners) {
      try {
        fn({ reason, id, url })
      } catch (e) {
        console.error('[bookmark-service] change listener error:', e)
      }
    }
  }

  /**
   * 订阅变更。@returns {() => void} 退订函数
   */
  function subscribe(fn: (change: BookmarkChange) => void): () => boolean {
    changeListeners.add(fn)
    return () => changeListeners.delete(fn)
  }

  /**
   * 某父级下"排到末尾"的 sort_order。
   * 新增 / 移入的节点一律排到同级的末尾 —— 既符合"刚加的排在最后"的直觉，
   * 也让新节点不会因为 sort_order 默认 0 而插到老节点前面（老库未排序行全是 0）。
   * @param {string|null} parentId
   * @returns {number}
   */
  function nextSortOrder(parentId: string | null): number {
    const cond = parentId == null ? isNull(bookmarks.parentId) : eq(bookmarks.parentId, parentId)
    const row = db.select({ maxOrder: sql`MAX(sort_order)` }).from(bookmarks)
      .where(and(cond, profileCond())).get()
    return (Number(row?.maxOrder) || 0) + 1
  }

  /**
   * Add a bookmark.
   * @param {{ parentId?: string, title: string, nickname?: string, url?: string, favicon?: string, tags?: string[], summary?: string|null }} input
   * @returns {Bookmark}
   */
  function add(input: AddBookmarkInput): Bookmark {
    const ts = now()
    const id = generateId('bm')
    const summary = normalizeSummary(input.summary)
    const serializedTags = serializeTags(input.tags)
    db.insert(bookmarks).values({
      id,
      profileId: currentProfile(),
      parentId: input.parentId ?? null,
      title: input.title,
      nickname: normalizeNickname(input.nickname),
      url: input.url ?? null,
      favicon: resolveFavicon(input.url, input.favicon),
      tags: serializedTags,
      summary,
      summaryAt: summary ? ts : null,
      sortOrder: nextSortOrder(input.parentId ?? null),
      createdAt: ts,
      modifiedAt: ts
    }).run()
    const index = activeTagIndex()
    if (index) {
      // 索引吃的是**落库后的**标签（系统标签已剥离），与读路径一致
      indexPage(index, { id, title: input.title, url: input.url ?? null, tags: parseTags(serializedTags), lastVisit: ts })
    }
    emitChange('add', id, input.url ?? null)
    const created = get(id)
    if (!created) throw new Error('bookmark insert did not return a row')
    return created
  }

  /**
   * 按 URL 精确取书签（星标状态查询的唯一入口）。
   * 任意层级（含文件夹内）都命中；文件夹（url 为 null）永不命中。
   * 同一 URL 若在多处收藏，返回最近修改的一条。
   * @param {string} url
   * @returns {Bookmark|null}
   */
  function getByUrl(url: string): Bookmark | null {
    if (!url) return null
    const row = db.select().from(bookmarks)
      .where(and(eq(bookmarks.url, url), profileCond()))
      .orderBy(desc(bookmarks.modifiedAt), sql`rowid DESC`)
      .get()
    return normalizeRow(row)
  }

  /**
   * 按 URL 取消收藏（星标关闭的唯一写入口）。
   * 同一 URL 收藏多处时全部移除（对齐"收藏是一个布尔状态"的用户心智）。
   * @param {string} url
   * @returns {number} 实际移除条数
   */
  function removeByUrl(url: string): number {
    if (!url) return 0
    const rows = db.select().from(bookmarks)
      .where(and(eq(bookmarks.url, url), profileCond())).all()
    let removed = 0
    for (const row of rows) {
      if (removeInternal(row.id).ok) removed++
    }
    // 聚合为一条事件：N 处收藏 = 一次"取消收藏"动作（对齐用户心智）
    if (removed > 0) emitChange('remove', null, url)
    return removed
  }

  /**
   * Update a bookmark.
   * @param {string} id
   * @param {{ title?: string, nickname?: string, url?: string, favicon?: string, tags?: string[], summary?: string|null }} updates
   * @returns {Bookmark|null}
   */
  function update(id: string, updates: UpdateBookmarkInput): Bookmark | null {
    // 标签索引已构建时先留旧快照：回滚必须用**建索引时**的 URL/标题，
    // 否则改了地址再回滚会把词项计数减歪。
    const index = activeTagIndex()
    const before = index ? get(id) : null
    // 图标补丁：显式传入优先；URL 变更时旧图标对新地址无意义 → 重新解析缓存。
    let faviconPatch = {}
    if (updates.favicon != null) {
      faviconPatch = { favicon: updates.favicon }
    } else if (updates.url != null) {
      const resolved = resolveFavicon(updates.url, null)
      if (resolved != null) faviconPatch = { favicon: resolved }
    }
    db.update(bookmarks).set({
      ...(updates.title != null && { title: updates.title }),
      // 昵称：显式传入即整列覆盖（空串 → NULL，等价于"清除昵称"）
      ...(updates.nickname !== undefined && { nickname: normalizeNickname(updates.nickname) }),
      ...(updates.url != null && { url: updates.url }),
      ...faviconPatch,
      ...(updates.tags !== undefined && { tags: serializeTags(updates.tags) }),
      // 摘要：显式传入即整列覆盖（空串 → NULL = 清除），并同步锚定生成时间。
      // 成对写入的原因：summary_at 是「是否过期」的唯一判据，孤儿时间戳只会误导。
      ...(updates.summary !== undefined && (() => {
        const summary = normalizeSummary(updates.summary)
        return { summary, summaryAt: summary ? now() : null }
      })()),
      modifiedAt: now()
    }).where(and(eq(bookmarks.id, id), profileCond())).run()
    const next = get(id)
    if (index) {
      reindexPage(index, before, next ? {
        id: next.id,
        title: next.title,
        url: next.url,
        tags: next.tags,
        lastVisit: next.modifiedAt
      } : null)
    }
    emitChange('update', id, next ? next.url : null)
    return next
  }

  /**
   * 内部删除：不发事件（remove / removeByUrl 各自决定事件聚合粒度）。
   * 递归删文件夹子节点，但只返回**自身**的 url —— 事件 payload 由调用方聚合。
   * @param {string} id
   * @returns {{ ok: boolean, url: string|null }}
   */
  function removeInternal(id: string): { ok: boolean; url: string | null } {
    const target = get(id)
    const children = db.select().from(bookmarks)
      .where(and(eq(bookmarks.parentId, id), profileCond())).all()
    for (const child of children) {
      removeInternal(child.id)
    }
    const result = db.delete(bookmarks)
      .where(and(eq(bookmarks.id, id), profileCond())).run()
    if (result.changes > 0) {
      const index = activeTagIndex()
      if (index) unindexPage(index, id)
    }
    return { ok: result.changes > 0, url: target ? target.url : null }
  }

  /**
   * Remove a bookmark (and its children if folder).
   * @param {string} id
   * @returns {boolean}
   */
  function remove(id: string): boolean {
    const { ok, url } = removeInternal(id)
    if (ok) emitChange('remove', id, url)
    return ok
  }

  /**
   * Get a single bookmark.
   * @param {string} id
   * @returns {Bookmark|null}
   */
  function get(id: string): Bookmark | null {
    const row = db.select().from(bookmarks)
      .where(and(eq(bookmarks.id, id), profileCond())).get()
    return normalizeRow(row)
  }

  /**
   * List bookmarks in a folder.
   * @param {string|null} parentId  null = root level
   * @returns {Bookmark[]}
   */
  function list(parentId: string | null = null): Bookmark[] {
    const condition = parentId === null
      ? isNull(bookmarks.parentId)
      : eq(bookmarks.parentId, parentId)
    return normalizeRows(db.select().from(bookmarks)
      .where(and(condition, profileCond()))
      .orderBy(asc(bookmarks.sortOrder), asc(bookmarks.createdAt)).all())
  }

  /**
   * Move bookmark to a different folder.
   * 同时把 sort_order 设为目标文件夹的末尾 —— 否则被移动的节点（老数据 sort_order=0）
   * 会跳到新文件夹的最前面，与"拖进来就放在最后"的直觉相反。
   * @param {string} id
   * @param {string|null} newParentId
   * @returns {Bookmark|null}
   */
  function move(id: string, newParentId: string | null): Bookmark | null {
    db.update(bookmarks).set({
      parentId: newParentId,
      sortOrder: nextSortOrder(newParentId ?? null),
      modifiedAt: now()
    }).where(and(eq(bookmarks.id, id), profileCond())).run()
    const next = get(id)
    emitChange('move', id, next ? next.url : null)
    return next
  }

  /**
   * Search bookmarks by title/url/tags.
   *
   * 双路径（infra-db 探测 FTS5 可用性后注入 hasFts）：
   *   - FTS5：unicode61 分词 + 前缀匹配（"dev"*），走倒排索引，O(结果数)
   *   - 兜底：LIKE %q%（旧库/无 FTS5 构建），功能等价只是慢
   * 匹配字段：title / url / tags（tags 以 JSON 存储恰好可作为分词文本）。
   *
   * `tag` 是**筛选条件**而不是检索词（筛选与搜索正交，因此可以在同一个标签内再搜）：
   *   · 有关键词 + 有 tag → 先按标签过滤，再按关键词排序（保持搜索相关度顺序）
   *   · 只有 tag → 返回该标签下的全部条目（跨文件夹，与 `snapshot` 的 tag 视图同一口径）
   *   · 只有关键词 → 与改造前逐字节等价
   * @param {string} query
   * @param {{ tag?: string|null }} [opts]
   * @returns {Bookmark[]}
   */
  function search(query: string, { tag = null }: { tag?: string | null } = {}): Bookmark[] {
    const q = String(query || '').trim()
    const wantedTag = tag == null ? '' : String(tag).trim()

    if (!q) {
      if (!wantedTag) return []
      return [...filterRowsByTag(listAll(), wantedTag)]
    }

    let rows: Bookmark[] = []
    if (ftsEnabled) {
      try {
        // 检索口径（切词 / 转义 / 前缀通配）统一由 shared-utils#buildMatchQuery 提供，
        // 与页面正文检索共用同一份事实源。
        const match = buildMatchQuery(q)
        if (!match) return []
        const result = db.all(sql`
          SELECT b.* FROM bookmarks_fts f
          JOIN bookmarks b ON b.rowid = f.rowid
          WHERE bookmarks_fts MATCH ${match}
            AND b.profile_id = ${currentProfile()}
          ORDER BY b.modified_at DESC
          LIMIT 200
        `)
        if (Array.isArray(result)) rows = normalizeRows(result as BookmarkRow[])
      } catch (_) {
        // MATCH 语法异常等 → 落到 LIKE 兜底
      }
    }
    if (rows.length === 0) {
      const pattern = `%${q}%`
      rows = normalizeRows(db.select().from(bookmarks)
        .where(and(
          or(like(bookmarks.title, pattern), like(bookmarks.url, pattern), like(bookmarks.tags, pattern)),
          profileCond()
        ))
        .orderBy(desc(bookmarks.modifiedAt))
        .all())
    }
    return wantedTag ? [...filterRowsByTag(rows, wantedTag)] : rows
  }

  /**
   * 书签栏：固定书签列表（pinned_order 升序，同级按创建时间稳定排序）。
   * @returns {Bookmark[]}
   */
  function listPinned(): Bookmark[] {
    return normalizeRows(db.select().from(bookmarks)
      .where(and(eq(bookmarks.pinned, 1), profileCond()))
      .orderBy(asc(bookmarks.pinnedOrder), desc(bookmarks.createdAt))
      .all())
  }

  /**
   * 书签栏：固定 / 取消固定。固定时自动排到末尾。
   *
   * ⚠ **文件夹也可以固定**：书签与文件夹在库里是同一张 `bookmarks` 表（`url` 为空即文件夹），
   * 而"固定"只是一个**快捷入口**的选择，与被固定的节点是网页还是文件夹无关。
   * 因此这里**不做 URL / 类型校验** —— 允许的节点类型判据收敛在渲染侧唯一一处
   * （`shared-types#bookmarkbar.mjs#isPinnableToBookmarkbar`），数据层只认 id。
   * @param {string} id
   * @param {boolean} pinned
   * @returns {Bookmark|null}
   */
  function setPinned(id: string, pinned: boolean): Bookmark | null {
    if (pinned) {
      const maxRow = db.select({ maxOrder: sql`MAX(pinned_order)` })
        .from(bookmarks).where(and(eq(bookmarks.pinned, 1), profileCond())).get()
      const nextOrder = (Number(maxRow?.maxOrder) || 0) + 1
      db.update(bookmarks).set({
        pinned: 1,
        pinnedOrder: nextOrder,
        modifiedAt: now()
      }).where(and(eq(bookmarks.id, id), profileCond())).run()
    } else {
      db.update(bookmarks).set({
        pinned: 0,
        pinnedOrder: 0,
        modifiedAt: now()
      }).where(and(eq(bookmarks.id, id), profileCond())).run()
    }
    const next = get(id)
    emitChange('update', id, next ? next.url : null)
    return next
  }

  /**
   * rail（侧栏图标栏）：列出所有**固定到 rail** 的书签。
   *
   * 顺序按 `railPinnedOrder` 升序（拖拽排出来的），并列时回落到 createdAt ——
   * 与书签栏的 `pinnedOrder` **完全无关**：两个固定位各自独立（用户可能只想固定到
   * 其中一个），共用一个排序字段必然互相打乱。
   *
   * ⚠ 老库补列后全为 0 → 并列 → 回落到 `createdAt` 升序，**正是改动前的表现**
   *（"按加入顺序"），不需要数据迁移；用户第一次拖动才写下显式顺序。
   * @returns {Bookmark[]}
   */
  function listRailPinned(): Bookmark[] {
    return normalizeRows(db.select().from(bookmarks)
      .where(and(eq(bookmarks.railPinned, 1), profileCond()))
      .orderBy(asc(bookmarks.railPinnedOrder), asc(bookmarks.createdAt))
      .all())
  }

  /** rail 固定区的下一个序号（固定到末尾用）。与 nextSortOrder 同一口径。 */
  function nextRailPinnedOrder(): number {
    const row = db.select({ maxOrder: sql`MAX(rail_pinned_order)` }).from(bookmarks)
      .where(and(eq(bookmarks.railPinned, 1), profileCond())).get()
    return (Number(row?.maxOrder) || 0) + 1
  }

  /**
   * rail：固定 / 取消固定。与 `setPinned`（书签栏）是两个互不影响的开关。
   *
   * 固定时排到**末尾**（与书签栏、与"移动到文件夹"同一条直觉：新加的在最后）。
   * @param {string} id
   * @param {boolean} pinned
   * @returns {Bookmark|null}
   */
  function setRailPinned(id: string, pinned: boolean): Bookmark | null {
    db.update(bookmarks).set({
      railPinned: pinned ? 1 : 0,
      // 只在**固定**时分配序号：取消固定留着的旧序号无害，重新固定时会被重排到末尾
      ...(pinned ? { railPinnedOrder: nextRailPinnedOrder() } : {}),
      modifiedAt: now()
    }).where(and(eq(bookmarks.id, id), profileCond())).run()
    const next = get(id)
    emitChange('update', id, next ? next.url : null)
    return next
  }

  /**
   * rail 固定区：整体重排（拖拽落点回传完整顺序）。
   *
   * 与 `reorderPinned`（书签栏）是**两条独立的链**：这里只写 `railPinnedOrder`，
   * 不碰 `pinnedOrder` —— 否则在 rail 上拖一下会把书签栏的顺序一起改掉。
   * @param {string[]} orderedIds  固定到 rail 的书签 id 的新顺序
   * @returns {boolean}
   */
  function reorderRailPinned(orderedIds: readonly string[]): boolean {
    if (!Array.isArray(orderedIds)) return false
    const ts = now()
    const cond = profileCond()
    db.transaction((tx) => {
      orderedIds.forEach((id, index) => {
        tx.update(bookmarks).set({
          railPinned: 1,
          railPinnedOrder: index + 1,
          modifiedAt: ts
        }).where(and(eq(bookmarks.id, id), cond)).run()
      })
    })
    emitChange('reorder', null, null)
    return true
  }

  /**
   * 「默认在独立侧栏打开」：书签自己的**打开偏好**。
   *
   * 为什么记在书签上而不是全局设置：这是"**这个**站点我想在侧栏看"（比如对照文档、
   * 查词典、看监控面板），逐个书签各异；做成全局开关就会把不想要的也一起改掉。
   * 与 pinned / railPinned 一样是书签的属性，随书签增删。
   *
   * @param {string} id
   * @param {boolean} value
   * @returns {Bookmark|null}
   */
  function setOpenInSidebar(id: string, value: unknown): Bookmark | null {
    db.update(bookmarks).set({
      openInSidebar: value ? 1 : 0,
      modifiedAt: now()
    }).where(and(eq(bookmarks.id, id), profileCond())).run()
    const next = get(id)
    emitChange('update', id, next ? next.url : null)
    return next
  }

  /**
   * 书签栏：整体重排（拖拽落点回传完整顺序）。
   * @param {string[]} orderedIds  固定书签 id 的新顺序
   * @returns {boolean}
   */
  function reorderPinned(orderedIds: readonly string[]): boolean {
    if (!Array.isArray(orderedIds)) return false
    const ts = now()
    const cond = profileCond()
    db.transaction((tx) => {
      orderedIds.forEach((id, index) => {
        tx.update(bookmarks).set({
          pinned: 1,
          pinnedOrder: index + 1,
          modifiedAt: ts
        }).where(and(eq(bookmarks.id, id), cond)).run()
      })
    })
    emitChange('reorder', null, null)
    return true
  }

  /**
   * 批量改标签 —— 打标签 / 移除标签 / 批量固定 的**唯一写路径**。
   *
   * 为什么把系统标签也放在这里：`system:pinned` / `system:rail` 在 UI 上就是一个标签
   * （筛选栏能点、批量弹层能勾、右键能移除），如果批量和固定各写一条通道，
   * 就会出现"批量打标签能加、但界面上的固定开关不认"的双份逻辑。这里统一解释：
   *
   *   · `system:*` → 写 `pinned` / `railPinned` 列（固定时自动排到末尾，与 setPinned 同口径）
   *   · 用户标签 → 写 `tags` 列（大小写不敏感去重，保留首次写法）
   *
   * **单事务 + 单次事件**：批量操作的 N 条更新只广播一次 —— 否则收藏面板与内部页
   * 会被 N 次 `bookmark:changed` 刷屏（N=200 时肉眼可见地卡）。
   *
   * @param {string[]} ids
   * @param {{ addTags?: string[], removeTags?: string[] }} [patch]
   * @returns {{ ok: boolean, changed: number }}
   */
  function bulkUpdateTags(
    ids: readonly string[],
    { addTags = [], removeTags = [] }: { addTags?: readonly string[]; removeTags?: readonly string[] } = {}
  ): { ok: boolean; changed: number } {
    const targets = Array.isArray(ids)
      ? ids.map((id) => String(id == null ? '' : id).trim()).filter(Boolean)
      : []
    const add = normalizeTagList(addTags)
    const remove = normalizeTagList(removeTags)
    if (targets.length === 0 || (add.length === 0 && remove.length === 0)) {
      return { ok: true, changed: 0 }
    }

    const addSystem = add
      .map((tag) => systemTagMeta(tag))
      .filter((meta): meta is SystemTagMeta => meta !== null)
    const removeSystem = remove
      .map((tag) => systemTagMeta(tag))
      .filter((meta): meta is SystemTagMeta => meta !== null)
    const addUser = stripSystemTags(add)
    const removeUserKeys = new Set(stripSystemTags(remove).map((tag) => tag.toLowerCase()))

    // 固定序号的基准只取一次：批量固定 N 条 = N 次 SELECT 是没必要付的开销。
    let pinnedSeq = 0
    let railSeq = 0
    if (addSystem.some((meta) => meta.field === 'pinned')) {
      const row = db.select({ maxOrder: sql`MAX(pinned_order)` }).from(bookmarks)
        .where(and(eq(bookmarks.pinned, 1), profileCond())).get()
      pinnedSeq = Number(row?.maxOrder) || 0
    }
    if (addSystem.some((meta) => meta.field === 'railPinned')) {
      const row = db.select({ maxOrder: sql`MAX(rail_pinned_order)` }).from(bookmarks)
        .where(and(eq(bookmarks.railPinned, 1), profileCond())).get()
      railSeq = Number(row?.maxOrder) || 0
    }

    const ts = now()
    const cond = profileCond()
    const index = activeTagIndex()
    let changed = 0

    db.transaction((tx) => {
      for (const id of targets) {
        const raw = tx.select().from(bookmarks).where(and(eq(bookmarks.id, id), cond)).get()
        if (!raw) continue
        const before = normalizeRow(raw)
        if (!before) continue
        /** @type {Record<string, unknown>} */
        const patch: Record<string, unknown> = { modifiedAt: ts }

        for (const meta of addSystem) {
          if (before[meta.field]) continue
          patch[meta.field] = 1
          if (meta.field === 'pinned') patch.pinnedOrder = ++pinnedSeq
          else if (meta.field === 'railPinned') patch.railPinnedOrder = ++railSeq
        }
        for (const meta of removeSystem) {
          if (!before[meta.field]) continue
          patch[meta.field] = 0
          if (meta.field === 'pinned') patch.pinnedOrder = 0
          else if (meta.field === 'railPinned') patch.railPinnedOrder = 0
        }

        if (addUser.length > 0 || removeUserKeys.size > 0) {
          const kept = before.tags.filter((tag) => !removeUserKeys.has(tag.toLowerCase()))
          const nextTags = serializeTags([...kept, ...addUser])
          if (nextTags !== serializeTags(before.tags)) patch.tags = nextTags
        }

        // 只有 modifiedAt → 这一行一个字节都没变，不要写（也不要把 modifiedAt 抬起来）
        if (Object.keys(patch).length === 1) continue

        tx.update(bookmarks).set(patch).where(and(eq(bookmarks.id, id), cond)).run()
        changed++
        if (index) {
          reindexPage(index, before, {
            id: before.id,
            title: before.title,
            url: before.url,
            tags: patch.tags !== undefined ? parseTags(patch.tags) : before.tags,
            lastVisit: ts
          })
        }
      }
    })

    if (changed > 0) emitChange('update', null, null)
    return { ok: true, changed }
  }

  /** 批量固定 / 取消固定到**书签栏**（system:pinned）。 */
  function bulkSetPinned(ids: readonly string[], pinned: boolean): { ok: boolean; changed: number } {
    return bulkUpdateTags(ids, pinned
      ? { addTags: [SYSTEM_TAG_PINNED] }
      : { removeTags: [SYSTEM_TAG_PINNED] })
  }

  /** 批量固定 / 取消固定到 **rail**（system:rail）。 */
  function bulkSetRailPinned(ids: readonly string[], pinned: boolean): { ok: boolean; changed: number } {
    return bulkUpdateTags(ids, pinned
      ? { addTags: [SYSTEM_TAG_RAIL] }
      : { removeTags: [SYSTEM_TAG_RAIL] })
  }

  /**
   * 删除一个**用户标签**：从当前 profile 的整库里摘掉这个标签（行不动、内容不删）。
   *
   * 与 `bulkUpdateTags(ids, { removeTags })` 的区别是作用域：那个按 id 批量改，
   * 这个按标签全库清理 —— 标签分类栏里右键「删除标签」要的是"这个标签从此不存在"，
   * 而不是"我记得当时选中了哪些行"。
   *
   *   · `system:` 前缀一律拒绝（系统标签是 pinned / railPinned 派的虚拟标签，
   *     删除它等于要删固定列，语义完全不同，必须走固定位自己的通道）；
   *   · **单事务 + 单次广播**：N 条更新只发一次 `bookmark:changed`，与批量改标签同口径；
   *   · 大小写不敏感：`Dev` 与 `dev` 在库里被视为同一个标签（与 normalizeTagList 一致）。
   *
   * @param {string} tag
   * @returns {{ ok: boolean, changed: number }}
   */
  function deleteTag(tag: string): { ok: boolean; changed: number } {
    const wanted = normalizeTag(tag)
    if (!wanted || isSystemTagLike(wanted)) return { ok: false, changed: 0 }
    const key = wanted.toLowerCase()
    const ts = now()
    const cond = profileCond()
    const index = activeTagIndex()
    let changed = 0

    db.transaction((tx) => {
      const rows = tx.select().from(bookmarks).where(cond).all()
      for (const raw of rows) {
        const before = normalizeRow(raw)
        if (!before) continue
        const kept = before.tags.filter((item) => normalizeTag(item).toLowerCase() !== key)
        if (kept.length === before.tags.length) continue
        const nextTags = serializeTags(kept)
        tx.update(bookmarks).set({ tags: nextTags, modifiedAt: ts })
          .where(and(eq(bookmarks.id, before.id), cond)).run()
        changed++
        if (index) {
          reindexPage(index, before, {
            id: before.id,
            title: before.title,
            url: before.url,
            tags: parseTags(nextTags),
            lastVisit: ts
          })
        }
      }
    })

    if (changed > 0) emitChange('update', null, null)
    return { ok: true, changed }
  }

  /**
   * 全量书签树（编辑器文件夹下拉、书签页渲染共用）。
   * 单次 SELECT + 内存组装，杜绝 N+1 查询。
   * @returns {Array<Bookmark & { children: Bookmark[] }>}
   */
  function tree(): BookmarkTreeNode[] {
    const all = listAll()
    const byId = new Map<string, BookmarkTreeNode>()
    for (const row of all) {
      byId.set(row.id, { ...row, children: [] })
    }
    const roots: BookmarkTreeNode[] = []
    for (const node of byId.values()) {
      const parent = node.parentId ? byId.get(node.parentId) : null
      if (parent) (parent.children ||= []).push(node)
      else roots.push(node)
    }
    return roots
  }

  /**
   * 书签面板聚合快照 —— **一次 IPC** 取齐首屏渲染所需的全部视图。
   * 无关键词时是一条 SELECT；带关键词时复用 FTS / LIKE 搜索，但仍与树、固定项、
   * 标签计数处在同一快照边界内。
   *
   * 收藏面板 / 书签页首屏原本要分别发 `list` + `tree` + `pinnedList` 三条 IPC，
   * 每条各自扫一遍表；这里在域内用 `listAll()` 的单次结果在内存里派生出
   * items / folders / pinned 三份视图，页面只发一条 IPC、只解析一次 DTO。
   *
   * 为什么不做成"页面侧并行 IPC"：并行只省了往返延迟，SQL 与序列化开销仍在，
   * 且三份数据来自三次不同时刻的读，首屏可能拼出自相矛盾的快照（例如 move 落在
   * 两次读之间）。聚合在域内做，天然是**同一时刻的一致视图**。
   *
   * @param {{ parentId?: string|null, tag?: string|null, query?: string|null }} [opts]
   *   parentId = 当前展开的文件夹（null 即根级）
   *   tag      = 选中的标签（**非空时 items 变成跨文件夹的标签视图**，见下）
   *   query    = 关键词（与 tag 正交；结果保持搜索相关度顺序）
   * @returns {{
   *   parentId: string|null,
   *   tag: string|null,
   *   query: string|null,
   *   items: Bookmark[],
   *   pinned: Bookmark[],
   *   pinnedOrder: string[],
   *   folders: Array<Bookmark & { children: Bookmark[] }>,
   *   tags: Array<{ tag: string, count: number, system: boolean, label: string }>
   * }}
   */
  function snapshot({ parentId = null, tag = null, query = null }: {
    parentId?: string | null
    tag?: string | null
    query?: string | null
  } = {}): BookmarkSnapshot {
    const all = listAll()
    const parent = parentId == null ? null : String(parentId)
    const wantedTag = tag == null ? '' : String(tag).trim() || null
    const wantedQuery = query == null ? '' : String(query).trim()

    // 标签视图是**跨文件夹**的：用户点「书签栏」标签时想看的是"所有固定项"，
    // 不是"当前文件夹里固定项"。不加标签时保持原来的单文件夹口径。
    const items = wantedQuery
      ? search(wantedQuery, { tag: wantedTag })
      : wantedTag
      ? filterRowsByTag(all, wantedTag)
      : all.filter((row) => (row.parentId == null ? null : row.parentId) === parent)
    const pinned = all
      .filter((row) => row.pinned)
      .sort((a, b) => (a.pinnedOrder || 0) - (b.pinnedOrder || 0) || (b.createdAt || 0) - (a.createdAt || 0))

    const byId = new Map<string, BookmarkTreeNode>()
    for (const row of all) byId.set(row.id, { ...row, children: [] })
    const roots: BookmarkTreeNode[] = []
    for (const node of byId.values()) {
      const owner = node.parentId ? byId.get(node.parentId) : null
      if (owner) (owner.children ||= []).push(node)
      else roots.push(node)
    }

    return {
      parentId: parent,
      tag: wantedTag,
      query: wantedQuery || null,
      items: [...items],
      pinned,
      pinnedOrder: pinned.map((row) => row.id),
      // 树与标签计数来自同一次 listAll；关键词路径复用搜索索引，但仍在同一快照边界内。
      // 树给的是**未过滤**的全量树（拖拽 / 移动仍需要完整结构），过滤在各 UI 侧做。
      folders: roots,
      tags: buildTagCounts(all, { limit: 100 })
    }
  }

  /**
   * 清空全部书签（备份恢复的"先清后灌"专用）。
   * @returns {number} 删除条数
   */
  function clearAll(): number {
    const count = db.select({ n: sql`COUNT(*)` }).from(bookmarks).where(profileCond()).get()
    db.delete(bookmarks).where(profileCond()).run()
    const removed = Number(count?.n) || 0
    // 整体清空：把索引对象原地清掉（外部若持有句柄仍然有效），下次查询重建。
    const index = activeTagIndex()
    if (index) clearTagIndex(index)
    if (removed > 0) emitChange('clear', null, null)
    return removed
  }

  /**
   * Get entire bookmark tree (for export).
   * 与 list() 同一套排序口径，保证树渲染顺序 = 用户拖出来的顺序。
   * @returns {Bookmark[]}
   */
  function listAll(): Bookmark[] {
    return normalizeRows(db.select().from(bookmarks)
      .where(profileCond())
      .orderBy(asc(bookmarks.sortOrder), asc(bookmarks.createdAt)).all())
  }

  /**
   * 重排某个父级下的子节点（收藏面板 / 书签页的拖拽落点回传完整顺序）。
   *
   * 契约：`orderedIds` 必须是该父级下**全部**子节点的顺序 —— 收藏面板渲染的就是全部
   * 子节点，所以它天然满足。与 reorderPinned 同一套"回传完整顺序"的口径。
   * WHERE 里带上父级条件：万一传来不在该父级下的 id，只会影响 0 行，
   * 不会把别的文件夹里的节点顺序搞乱。
   * @param {string|null} parentId
   * @param {string[]} orderedIds
   * @returns {boolean}
   */
  function reorderChildren(parentId: string | null, orderedIds: readonly string[]): boolean {
    if (!Array.isArray(orderedIds)) return false
    const scoped = profileCond()
    const cond = and(parentId == null ? isNull(bookmarks.parentId) : eq(bookmarks.parentId, parentId), scoped)
    db.transaction((tx) => {
      orderedIds.forEach((id, index) => {
        tx.update(bookmarks).set({ sortOrder: index + 1 })
          .where(and(eq(bookmarks.id, id), cond)).run()
      })
    })
    emitChange('reorder', null, null)
    return true
  }

  /**
   * 导出所有书签为 Netscape Bookmark File Format HTML
   * @returns {string} HTML 字符串
   */
  function exportHtml(): string {
    const all = listAll()
    const now = new Date()
    const lines = [
      '<!DOCTYPE NETSCAPE-Bookmark-file-1>',
      '<!-- This is an automatically generated file.',
      '     It will be read and overwritten.',
      '     DO NOT EDIT! -->',
      '<META HTTP-EQUIV="Content-Type" CONTENT="text/html; charset=UTF-8">',
      `<TITLE>Bookmarks</TITLE>`,
      `<H1>Bookmarks</H1>`,
      `<DL><p>`
    ]

    // 递归生成书签树
    function buildTree(parentId: string | null, depth: number): void {
      const indent = '  '.repeat(depth)
      const children = all.filter((b) => b.parentId === parentId)
      for (const b of children) {
        const addDate = Math.floor((b.createdAt || Date.now()) / 1000)
        // TAGS 是 Netscape 格式的扩展属性（Chrome / Edge / Firefox 都认）：
        // 导出带上用户标签，导回来时标签不会丢（系统标签是派生态，不参与导出）。
        const tagsAttr = b.tags && b.tags.length
          ? ` TAGS="${escapeAttr(b.tags.join(','))}"`
          : ''
        if (b.url) {
          // 书签
          lines.push(`${indent}<DT><A HREF="${escapeAttr(b.url)}" ADD_DATE="${addDate}"${tagsAttr}>${escapeHtml(b.title)}</A>`)
        } else {
          // 文件夹
          lines.push(`${indent}<DT><H3 ADD_DATE="${addDate}"${tagsAttr}>${escapeHtml(b.title)}</H3>`)
          lines.push(`${indent}<DL><p>`)
          buildTree(b.id, depth + 1)
          lines.push(`${indent}</DL><p>`)
        }
      }
    }

    buildTree(null, 1)
    lines.push('</DL><p>')
    return lines.join('\n')
  }

  /**
   * 从 Netscape Bookmark HTML 导入书签。
   *
   * 三个要点（都是此前线上问题的根因）：
   *   · **单事务 + 一次事件**：早期实现逐条 `add()`，每条都 nextSortOrder 一次 SELECT
   *     并广播一次 `bookmark:changed` —— 上千条的书签文件会引发广播风暴，内部页正好在
   *     这轮风暴里刷新，于是"导入后有时看不到新书签"（刷新请求打在一堆写入中间）。
   *   · **解析栈正确闭合**：`<DL>` 与 `</DL>` 必须成对出栈。早期实现把 `</DL>` 之后的
   *     父级留在栈里，导致第二棵顶层文件夹被错误地嵌进第一棵里。
   *   · **标签随行**：Netscape 的 `TAGS="a,b"` 属性会解析进 tags 列（系统标签一律剥离）。
   *
   * @param {string} html - HTML 字符串
   * @returns {{ imported:number, skipped:number, error?: string }}
   */
  function importHtml(html: string): BookmarkImportResult {
    const src = String(html || '')
    interface ParsedImportNode {
      id: string
      parentId: string | null
      title: string
      url: string | null
      tags: string[]
      createdAt: number | null
    }
    const nodes: ParsedImportNode[] = []
    /** 当前父级栈：栈顶 = 下一个节点要挂到哪里 */
    const stack: Array<string | null> = [null]
    /** 刚解析出的文件夹 id —— 紧随其后的 `<DL>` 从这里入栈 */
    let pendingFolder: string | null = null
    let skipped = 0

    const regex = /<(H3|A|DL|\/DL)\b([^>]*)>([^<]*)/gi
    let match
    while ((match = regex.exec(src)) !== null) {
      const tag = match[1].toUpperCase()
      const attrs = match[2] || ''
      const text = decodeHtml((match[3] || '').trim())

      if (tag === 'H3') {
        const parentId = stack[stack.length - 1]
        const id = generateId('bm')
        nodes.push({
          id,
          parentId,
          title: text || '未命名文件夹',
          url: null,
          tags: parseTagAttr(attrs),
          createdAt: parseAddDate(attrs)
        })
        pendingFolder = id
      } else if (tag === 'A') {
        const hrefMatch = attrs.match(/\bHREF\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/i)
        const href = decodeHtml(hrefMatch ? (hrefMatch[1] ?? hrefMatch[2] ?? hrefMatch[3]) : '')
        if (!href) {
          skipped++
          continue
        }
        nodes.push({
          id: generateId('bm'),
          parentId: stack[stack.length - 1],
          title: text || href,
          url: href,
          tags: parseTagAttr(attrs),
          createdAt: parseAddDate(attrs)
        })
      } else if (tag === 'DL') {
        // 只有挂过 folder 的 DL 才下钻；文档外层那个 `<DL>` 不解引用，保持当前父级
        stack.push(pendingFolder != null ? pendingFolder : stack[stack.length - 1])
        pendingFolder = null
      } else if (tag === '/DL') {
        if (stack.length > 1) stack.pop()
        pendingFolder = null
      }
    }

    if (nodes.length === 0) return { imported: 0, skipped }

    const ts = now()
    const profileId = currentProfile()
    const index = activeTagIndex()

    // 各父级的排序水位：导入的节点接在已有内容之后，不覆盖也不插队。
    const maxOrder = new Map<string, number>()
    const existing = db.select({ parentId: bookmarks.parentId, maxOrder: sql`MAX(sort_order)` })
      .from(bookmarks).where(profileCond()).all()
    for (const row of existing) {
      maxOrder.set(row.parentId == null ? '' : String(row.parentId), Number(row.maxOrder) || 0)
    }
    const nextOrder = (parentId: string | null): number => {
      const key = parentId == null ? '' : String(parentId)
      const next = (maxOrder.get(key) || 0) + 1
      maxOrder.set(key, next)
      return next
    }

    let imported = 0
    try {
      db.transaction((tx) => {
        for (const node of nodes) {
          tx.insert(bookmarks).values({
            id: node.id,
            profileId,
            parentId: node.parentId,
            title: node.title,
            nickname: null,
            url: node.url,
            favicon: node.url ? resolveFavicon(node.url, null) : null,
            tags: serializeTags(node.tags),
            summary: null,
            summaryAt: null,
            sortOrder: nextOrder(node.parentId),
            createdAt: node.createdAt || ts,
            modifiedAt: ts
          }).run()
          if (index) {
            indexPage(index, {
              id: node.id,
              title: node.title,
              url: node.url,
              tags: serializeTags(node.tags) ? node.tags : [],
              lastVisit: ts
            })
          }
          imported++
        }
      })
    } catch (e) {
      console.error('[bookmark-service] importHtml failed:', e)
      const message = e && typeof e === 'object' && 'message' in e ? String((e as { message: unknown }).message) : String(e)
      return { imported: 0, skipped, error: message }
    }

    if (imported > 0) emitChange('import', null, null)
    return { imported, skipped }
  }

  /**
   * 批量导入外来源书签树（浏览器一键迁移 P1）。
   *
   * 与 `importHtml` 的分工：
   *   · 这里吃的是**已结构化的树**（Chromium Bookmarks JSON 的解析产物），不再碰 HTML；
   *   · **单事务 + 一次变更事件**：逐条走 `add()` 会触发几千次广播、把面板与内部页刷屏，
   *     这里直接批量插入，最后只 `emitChange('import')` 一次；
   *   · **幂等**：URL 已存在（任意层级）即跳过；文件夹按「父级 + 标题」复用，
   *     所以重复导入不会长出第二套文件夹。
   *   · **直接落到根层**：不再套一层「从 xx 导入」容器 —— 源浏览器自己的
   *     「书签栏 / 其他书签 / 移动设备书签」就是导入后的顶层文件夹，与
   *     `importHtml` 的口径一致；用户要整理也只需拖拽，不必先拆掉一层空壳。
   *   · **书签栏映射**：树上的 `pinned: true`（源浏览器的 bookmark_bar 根）表示
   *     「这一层的每一项都固定到书签栏」—— 与 Chrome / Edge 书签栏只展示该根目录
   *     直接子项的行为一致；嵌套层级不固定，点开固定文件夹即可看到内容。
   *
   * @param {Array<{title:string, children:Array, pinned?:boolean}>} trees 每个元素是一棵根文件夹
   *   （来自源浏览器的 bookmark_bar / other / synced），`pinned` = 其直接子项固定到书签栏
   * @returns {{ imported:number, skipped:number, folders:number }}
   */
  function importTrees(trees: readonly BookmarkImportTree[]): BookmarkImportResult {
    const list = Array.isArray(trees) ? trees.filter(Boolean) : []
    if (list.length === 0) return { imported: 0, skipped: 0, folders: 0 }

    const ts = now()
    const profileId = currentProfile()

    let imported = 0
    let skipped = 0
    let folders = 0
    // 书签栏固定区水位：新固定项一律追加到现有固定项之后（与 setPinned 同口径）。
    let pinnedSeq = 0

    const existingUrls = new Set()
    /** `parentId\0title` → folder id */
    const folderByKey = new Map<string, string>()
    /** parentId（根级用 ''）→ 当前最大 sort_order */
    const maxOrder = new Map<string, number>()
    const index = activeTagIndex()

    const parentKey = (parentId: string | null): string => (parentId == null ? '' : String(parentId))
    const folderKey = (parentId: string | null, title: unknown): string => `${parentKey(parentId)}\u0000${String(title)}`
    const nextOrder = (parentId: string | null): number => {
      const key = parentKey(parentId)
      const next = (maxOrder.get(key) || 0) + 1
      maxOrder.set(key, next)
      return next
    }

    interface TreeInsertInput {
      parentId: string | null
      title: string
      url: string | null
      favicon?: string | null
      createdAt?: number | null
      pinned?: boolean
    }
    const insertRow = (tx: BookmarkDatabase, input: TreeInsertInput): string => {
      const id = generateId('bm')
      tx.insert(bookmarks).values({
        id,
        profileId,
        parentId: input.parentId ?? null,
        title: input.title,
        nickname: null,
        url: input.url ?? null,
        // 显式图标（导入时从源浏览器带过来的本地图标）优先；否则问 favicon 缓存端口。
        favicon: input.url ? resolveFavicon(input.url, input.favicon ?? null) : null,
        tags: null,
        summary: null,
        summaryAt: null,
        sortOrder: nextOrder(input.parentId ?? null),
        pinned: input.pinned ? 1 : 0,
        pinnedOrder: input.pinned ? ++pinnedSeq : 0,
        createdAt: input.createdAt || ts,
        modifiedAt: ts
      }).run()
      if (index) {
        indexPage(index, { id, title: input.title, url: input.url ?? null, tags: null, lastVisit: ts })
      }
      return id
    }

    const ensureFolder = (tx: BookmarkDatabase, parentId: string | null, title: unknown, pinned: boolean): string => {
      const name = String(title || '').trim() || '未命名文件夹'
      const key = folderKey(parentId, name)
      const hit = folderByKey.get(key)
      if (hit) return hit
      const id = insertRow(tx, { parentId, title: name, url: null, createdAt: null, pinned })
      folderByKey.set(key, id)
      folders++
      return id
    }

    /**
     * @param {boolean} [pinHere] 只对「直接子项」生效：递归进去的层级不再固定，
     *   否则会把整个书签栏子树的每一条都塞进横向书签条。
     */
    const walk = (tx: BookmarkDatabase, parentId: string | null, nodes: readonly BookmarkImportNode[], pinHere = false): void => {
      for (const node of nodes || []) {
        if (!node) continue
        if (node.url) {
          const url = String(node.url)
          if (existingUrls.has(url)) {
            skipped++
            continue
          }
          insertRow(tx, {
            parentId,
            title: String(node.title || '').trim() || url,
            url,
            // 源浏览器 Favicons 库解析出的本地图标地址（见 import/apply-icons.js）；
            // 没有就留空，由展示层的候选链兜底。
            favicon: node.favicon == null ? null : String(node.favicon),
            createdAt: typeof node.dateAdded === 'number' ? node.dateAdded : null,
            pinned: pinHere
          })
          existingUrls.add(url)
          imported++
        } else {
          const folderId = ensureFolder(tx, parentId, node.title, pinHere)
          walk(tx, folderId, node.children || [])
        }
      }
    }

    try {
      // 现有数据一次读齐：URL 去重 + 文件夹复用 + 各父级的排序水位 + 固定区水位。
      const rows = db.select({
        id: bookmarks.id,
        parentId: bookmarks.parentId,
        title: bookmarks.title,
        url: bookmarks.url,
        sortOrder: bookmarks.sortOrder,
        pinned: bookmarks.pinned,
        pinnedOrder: bookmarks.pinnedOrder
      }).from(bookmarks).where(profileCond()).all()

      for (const row of rows) {
        if (row.url) {
          existingUrls.add(String(row.url))
        } else {
          folderByKey.set(folderKey(row.parentId == null ? null : String(row.parentId), row.title), String(row.id))
        }
        const key = parentKey(row.parentId == null ? null : String(row.parentId))
        const sortOrder = Number(row.sortOrder) || 0
        if (sortOrder > (maxOrder.get(key) || 0)) maxOrder.set(key, sortOrder)
        const pinnedOrder = Number(row.pinnedOrder) || 0
        if (row.pinned && pinnedOrder > pinnedSeq) pinnedSeq = pinnedOrder
      }

      db.transaction((tx) => {
        for (const tree of list) {
          if (!Array.isArray(tree.children) || tree.children.length === 0) continue
          const topId = ensureFolder(tx, null, tree.title || '书签', false)
          walk(tx, topId, tree.children, tree.pinned === true)
        }
      })
    } catch (e) {
      console.error('[bookmark-service] importTrees failed:', e)
      const message = e && typeof e === 'object' && 'message' in e ? String((e as { message: unknown }).message) : String(e)
      return { imported: 0, skipped: 0, folders: 0, error: message }
    }

    if (imported > 0) emitChange('import', null, null)
    return { imported, skipped, folders }
  }

  /**
   * 补齐**已有书签**缺失的图标（只补空，不覆盖）。
   *
   * 为什么要单独一个入口：浏览器迁移是「按 URL 幂等跳过」的 —— 用户重复点一次导入时，
   * 书签行都在、不会重写，但先前那轮导入时 favicon 还拿不到（图标库刚接上 / 那会儿
   * 还没有本地图标），这些行就永远空着。这里只用本次从源浏览器读到的图标地址把它们补上，
   * 用户不必删库重导。
   *
   * @param {Array<{url:string, favicon:string}>} entries
   * @returns {number} 实际更新条数
   */
  function backfillFavicons(entries: readonly { url: string; favicon: string }[]): number {
    const list = Array.isArray(entries) ? entries.filter((e) => e && e.url && e.favicon) : []
    if (list.length === 0) return 0
    const ts = now()
    let updated = 0
    try {
      db.transaction((tx) => {
        for (const entry of list) {
          const result = tx.update(bookmarks)
            .set({ favicon: entry.favicon, modifiedAt: ts })
            .where(and(profileCond(), eq(bookmarks.url, entry.url), isNull(bookmarks.favicon)))
            .run()
          updated += result.changes || 0
        }
      })
    } catch (e) {
      console.error('[bookmark-service] backfillFavicons failed:', e)
      return updated
    }
    if (updated > 0) emitChange('import', null, null)
    return updated
  }

  /**
   * 解析 Netscape 的 `TAGS="a,b,c"` 属性 → 标签数组（系统标签一律剥离）。
   * @param {string} attrs
   * @returns {string[]}
   */
  function parseTagAttr(attrs: string): string[] {
    const m = /\bTAGS\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/i.exec(attrs || '')
    if (!m) return []
    const raw = decodeHtml(String(m[1] ?? m[2] ?? m[3] ?? ''))
    return stripSystemTags(raw.split(',').map((tag) => tag.trim()))
  }

  /**
   * 解析 `ADD_DATE`（Unix 秒）→ 毫秒时间戳；缺失或非法返回 null。
   * 保留原时间让导入的书签不会全挤在"刚刚"，排序与展示都更接近原浏览器。
   * @param {string} attrs
   * @returns {number|null}
   */
  function parseAddDate(attrs: string): number | null {
    const m = /\bADD_DATE\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/i.exec(attrs || '')
    const seconds = Number.parseInt(String(m ? (m[1] ?? m[2] ?? m[3]) : ''), 10)
    return Number.isFinite(seconds) && seconds > 0 ? seconds * 1000 : null
  }

  function decodeHtml(value: unknown): string {
    return String(value || '').replace(/&(#x[0-9a-f]+|#\d+|amp|lt|gt|quot|apos);/gi, (_match, entity) => {
      const normalized = entity.toLowerCase()
      if (normalized === 'amp') return '&'
      if (normalized === 'lt') return '<'
      if (normalized === 'gt') return '>'
      if (normalized === 'quot') return '"'
      if (normalized === 'apos') return "'"
      const code = normalized.startsWith('#x')
        ? Number.parseInt(normalized.slice(2), 16)
        : Number.parseInt(normalized.slice(1), 10)
      return Number.isFinite(code) ? String.fromCodePoint(code) : _match
    })
  }

  // 书签 HTML 导出（Netscape 格式）用的转义：只转文本节点三字符。
  // 插件 `panel-notes.markdown.js` 另有一份转义面更宽的同款（含引号，防属性注入；
  // 插件 bundle 必须自包含，无法共享）—— 两者语境不同，不是待删的重复。
  function escapeHtml(str: unknown): string {
    return String(str || '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
  }

  function escapeAttr(str: unknown): string {
    return String(str || '').replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  }

  /**
   * 标签分类栏的数据源：**系统标签 + 用户标签**，带计数。
   *
   * 与 `suggestTags` / `autocompleteTags` 的分工：那两个走懒构建的标签索引
   * （只需要"用过的标签"，不需要文件夹与计数），而分类栏要展示的是**完整视图** ——
   * 系统标签必须出现（哪怕计数为 0，用户要能点进去看"我固定了哪些"），
   * 文件夹也可以带标签。因此这里直接按列聚合（单条 SELECT + 内存聚合），
   * 索引的用途保持不变，不会出现两套计数口径。
   * @param {{ limit?: number }} [opts] limit 只约束用户标签（系统标签始终完整）
   * @returns {Array<{ tag: string, count: number, system: boolean, label: string }>}
   */
  function listTags({ limit = 100 }: { limit?: number } = {}): BookmarkTagCount[] {
    const rows = db.select({
      tags: bookmarks.tags,
      pinned: bookmarks.pinned,
      railPinned: bookmarks.railPinned
    }).from(bookmarks).where(profileCond()).all()
    return buildTagCounts(
      rows.map((row) => ({
        tags: parseTags(row.tags),
        pinned: !!row.pinned,
        railPinned: !!row.railPinned
      })),
      { limit }
    )
  }

  /**
   * 为「正在收藏 / 正在编辑」的页面推荐标签（F-0756~F-0760）。
   * 纯推荐：不写库，是否采纳由 UI 决定。
   * @param {{ id?: string|null, url?: string|null, title?: string|null, tags?: string[]|null, limit?: number }} [page]
   * @returns {string[]}
   */
  function suggestTags(page: { id?: string | null; url?: string | null; title?: string | null; tags?: string[] | null; limit?: number } = {}): string[] {
    return suggestTagsFromIndex(getTagIndex(), page, { limit: page.limit ?? 3 })
  }

  /**
   * 已选标签 → 后续标签的自动补全（共现 + 时间衰减）。
   * @param {string[]} tags
   * @param {{ limit?: number }} [opts]
   * @returns {string[]}
   */
  function autocompleteTags(tags: readonly string[], { limit = 8 }: { limit?: number } = {}): string[] {
    return autocompleteTagsFromIndex(getTagIndex(), Array.isArray(tags) ? tags : [], { limit })
  }

  return {
    add,
    getByUrl,
    removeByUrl,
    update,
    remove,
    get,
    list,
    listTags,
    suggestTags,
    autocompleteTags,
    move,
    search,
    listAll,
    tree,
    snapshot,
    listPinned,
    setPinned,
    reorderPinned,
    listRailPinned,
    setRailPinned,
    reorderRailPinned,
    bulkUpdateTags,
    bulkSetPinned,
    bulkSetRailPinned,
    deleteTag,
    setOpenInSidebar,
    clearAll,
    reorderChildren,
    exportHtml,
    importHtml,
    importTrees,
    backfillFavicons,
    subscribe
  }
}

export { createBookmarkService }
export default { createBookmarkService }
