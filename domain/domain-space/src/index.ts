// @ts-check
/**
 * Domain: Space — 空间管理领域服务
 *
 * 对齐 RT `spaces-controller`（raw + index 双层）：
 *   - 数据模型 { id, profileId, name, icon, bgStartColor, bgEndColor, order, lastUsed, createdAt }
 *   - 空间物理嵌套在 profile 之下（NG 用 DB 行 + 磁盘目录 `profiles/<pid>/spaces/<sid>` 承载会话）
 *   - profile 创建时自动建「同名默认空间」（由上层注入 spacePort 后联动，本模块不反向依赖 profile）
 *
 * 严格分层：本模块**不 import electron / fs / path**，只做 DB 读写 + 调用 spaceUtil 纯规则，
 * 可脱离一切运行时单测。磁盘路径由 spaceUtil.spaceRelPath 产出，APPS 层再 join 到 userData。
 */
import { spaces } from '@hira-ng/infra-db/schema'
import { and as drizzleAnd, eq as drizzleEq } from 'drizzle-orm'
import { generateId } from '@hira-ng/shared-utils'
import SpaceUtil from './spaceUtil'
import type { ReorderEntry, SpaceRecord } from './spaceUtil'

export interface SpaceRow {
  id: string
  profileId: string
  name: string
  icon: string
  bgStartColor: string
  bgEndColor: string
  order: number
  lastUsed: number
  createdAt: number
}

type Condition = unknown
type BinaryCondition = (column: unknown, value: unknown) => Condition
const eq = drizzleEq as unknown as BinaryCondition
const and = drizzleAnd as unknown as (...conditions: Condition[]) => Condition

interface SpaceSelectWhere {
  get(): SpaceRow | undefined
  all(): SpaceRow[]
}
interface SpaceDatabase {
  select(): {
    from(table: unknown): {
      where(condition: Condition): SpaceSelectWhere
      all(): SpaceRow[]
    }
  }
  insert(table: unknown): { values(value: Record<string, unknown>): { run(): unknown } }
  update(table: unknown): { set(value: Record<string, unknown>): { where(condition: Condition): { run(): unknown } } }
  delete(table: unknown): { where(condition: Condition): { run(): unknown } }
}

export interface SpaceServiceOptions {
  dbOf?: (profileId: string) => SpaceDatabase
  listProfileIds?: () => string[]
}

export interface CreateSpaceInput {
  id?: string
  name?: string
  icon?: string
  bgStartColor?: string
  bgEndColor?: string
}
export type CreateSpaceResult = { ok: true; space: SpaceRecord | null } | { ok: false; reason: string }

/**
 * @param {import('drizzle-orm/better-sqlite3').BetterSQLite3Database} db
 * @param {{ dbOf?: (profileId: string) => object, listProfileIds?: () => string[] }} [options]
 *   L2 物理独立（PART16）的两个端口：
 *   · `dbOf(profileId)`   —— 该 profile 自己的库（缺省 → 恒用传入的同一个 db，行为不变）
 *   · `listProfileIds()`  —— 跨 profile 遍历的 id 清单（缺省 → 单库直接查）
 */
function createSpaceService(db: SpaceDatabase, options: SpaceServiceOptions = {}) {
  const now = () => Date.now()
  /**
   * 取某个 profile 的库。
   *
   * ⚠ 本服务是**跨 profile 寻址**的（`list(pid)` / `get(pid,sid)` / `removeByProfile(pid)` /
   * `move(pid,…)` 都按入参定位），所以**不能**用「当前 profile 的库」这种隐式路由 ——
   * 那会让「给别的 profile 建默认空间」写进当前用户的库。必须显式按 pid 取。
   */
  const dbOf: (profileId: string) => SpaceDatabase = typeof options.dbOf === 'function' ? options.dbOf : () => db
  const dbFor = (profileId: unknown): SpaceDatabase => dbOf(String(profileId || 'default'))
  /** 跨 profile 遍历的 id 清单；未注入端口 → null（= 单库模式，直接查同一个库）。 */
  function profileIdsForFanout() {
    if (typeof options.listProfileIds !== 'function') return null
    try {
      const ids = options.listProfileIds()
      return Array.isArray(ids) ? ids.map(String).filter(Boolean) : []
    } catch (_) {
      return []
    }
  }

  /** 单行 DB row → 域对象（补齐脏数据）。 */
  function toDomain(row: SpaceRow | null | undefined): SpaceRecord | null {
    if (!row) return null
    const base = SpaceUtil.reconcileSpace(row, { spaceId: row.id, profileId: row.profileId })
    return { ...base, createdAt: Number(row.createdAt) || 0 }
  }

  /**
   * 确保某个 profile 下存在默认空间。
   * @param {string} profileId
   * @param {string} [name] 默认空间的显示名（RT：profile 创建时用 profile 名）
   */
  function ensureDefault(profileId: unknown, name?: unknown): SpaceRecord | null {
    const pid = SpaceUtil.normalizeSpaceId(profileId)
    if (!pid) return null
    const existing = dbFor(pid).select().from(spaces)
      .where(and(eq(spaces.profileId, pid), eq(spaces.id, SpaceUtil.DEFAULT_SPACE_ID)))
      .get()
    if (existing) return toDomain(existing)
    dbFor(pid).insert(spaces).values({
      id: SpaceUtil.DEFAULT_SPACE_ID,
      profileId: pid,
      name: SpaceUtil.safeSpaceName(name, SpaceUtil.DEFAULT_SPACE_NAME) || SpaceUtil.DEFAULT_SPACE_NAME,
      // 默认空间语义就是「首页」：显式落 home，而不是留空等渲染层兜底。
      icon: SpaceUtil.defaultSpaceIcon(SpaceUtil.DEFAULT_SPACE_ID),
      bgStartColor: '',
      bgEndColor: '',
      order: 0,
      lastUsed: now(),
      createdAt: now()
    }).run()
    return get(pid, SpaceUtil.DEFAULT_SPACE_ID)
  }

  /** 某个 profile 下的全部空间（按 order 排序）。 */
  function list(profileId: unknown): SpaceRecord[] {
    const pid = SpaceUtil.normalizeSpaceId(profileId)
    if (!pid) return []
    const rows = dbFor(pid).select().from(spaces).where(eq(spaces.profileId, pid)).all()
    return SpaceUtil.sortSpaces(rows.map(toDomain).filter((space): space is SpaceRecord => space !== null))
  }

  /**
   * 全量空间（跨 profile），供设置页一次性拉取。
   * 物理独立后每 profile 一个库 → **逐库取再合并**（单库模式下退化为一次查询）。
   */
  function listAll(): SpaceRecord[] {
    const ids = profileIdsForFanout()
    if (!ids) {
      const rows = db.select().from(spaces).all()
      return SpaceUtil.sortSpaces(
        rows.map(toDomain).filter((space): space is SpaceRecord => space !== null)
      )
    }
    const out: SpaceRecord[] = []
    for (const pid of ids) {
      try {
        const rows = dbFor(pid).select().from(spaces).where(eq(spaces.profileId, pid)).all()
        out.push(...SpaceUtil.sortSpaces(
          rows.map(toDomain).filter((space): space is SpaceRecord => space !== null)
        ))
      } catch (e) {
        const message = e && typeof e === 'object' && 'message' in e ? String((e as { message: unknown }).message) : String(e)
        console.warn('[domain-space] 读取 profile 空间失败（跳过）:', pid, message)
      }
    }
    // 每个 profile 各自按持久化 order 排列，profile 之间的先后保持 fanout 清单顺序。
    // lastUsed 不参与这里：切换空间只更新「上次使用」，不得让列表立即重排。
    return out
  }

  /** 单个空间（需 profileId 定位，空间 id 只在 profile 内唯一）。 */
  function get(profileId: unknown, spaceId: unknown): SpaceRecord | null {
    const pid = SpaceUtil.normalizeSpaceId(profileId)
    const sid = SpaceUtil.normalizeSpaceId(spaceId)
    if (!pid || !sid) return null
    return toDomain(dbFor(pid).select().from(spaces).where(and(eq(spaces.profileId, pid), eq(spaces.id, sid))).get())
  }

  /**
   * 跨 profile 查找空间（RT `get(spaceId)` 的等价实现，返回 { space, profileId }）。
   * 物理独立后逐库查找（首个命中即返回）。
   */
  function findById(spaceId: unknown): { space: SpaceRecord; profileId: string } | null {
    const sid = SpaceUtil.normalizeSpaceId(spaceId)
    if (!sid) return null
    const ids = profileIdsForFanout()
    if (!ids) {
      const row = db.select().from(spaces).where(eq(spaces.id, sid)).get()
      const space = toDomain(row)
      return space ? { space, profileId: space.profileId } : null
    }
    for (const pid of ids) {
      try {
        const row = dbFor(pid).select().from(spaces).where(eq(spaces.id, sid)).get()
        const space = toDomain(row)
        if (space) return { space, profileId: space.profileId }
      } catch (_) { /* 单个库读失败 → 继续找 */ }
    }
    return null
  }

  /**
   * 创建空间。
   * @param {string} profileId
   * @param {{ id?: string, name?: string, icon?: string, bgStartColor?: string, bgEndColor?: string }} input
   * @returns {{ ok: boolean, space?: object, reason?: string }}
   */
  function create(profileId: unknown, input: CreateSpaceInput = {}): CreateSpaceResult {
    const pid = SpaceUtil.normalizeSpaceId(profileId)
    if (!pid) return { ok: false, reason: 'invalid profileId' }

    const rawId = input.id ? SpaceUtil.normalizeSpaceId(input.id) : (SpaceUtil.slugFromName(input.name || '') || generateId('space').toLowerCase().replace(/[^a-z0-9_-]/g, ''))
    const sid = rawId || `space-${now().toString(36)}`
    if (sid.length === 0 || sid.length > SpaceUtil.ID_MAX_LEN) return { ok: false, reason: 'invalid spaceId' }
    if (get(pid, sid)) return { ok: false, reason: 'space already exists' }

    const safe = SpaceUtil.safeSpaceName(input.name, '')
    if (!safe) return { ok: false, reason: 'name must be a non-empty string' }
    if (!SpaceUtil.validateSpaceName(safe).ok) return { ok: false, reason: 'invalid name' }

    // 一次取列表：既算 order，也给「新空间默认图标」提供稳定 seed/下标。
    const existing = list(pid)

    dbFor(pid).insert(spaces).values({
      id: sid,
      profileId: pid,
      name: safe,
      // 用户给的图标走白名单归一；没给 / 非法 → 按 id 稳定分配一颗（可复现，不用随机数）。
      icon: SpaceUtil.normalizeSpaceIcon(input.icon) || SpaceUtil.defaultSpaceIcon(sid, existing.length),
      bgStartColor: typeof input.bgStartColor === 'string' ? input.bgStartColor : '',
      bgEndColor: typeof input.bgEndColor === 'string' ? input.bgEndColor : '',
      order: SpaceUtil.nextOrder(existing),
      lastUsed: now(),
      createdAt: now()
    }).run()
    return { ok: true, space: get(pid, sid) }
  }

  /** 更新空间（字段白名单由 spaceUtil.mergeSpaceMeta 保证）。 */
  function update(profileId: unknown, spaceId: unknown, patch: unknown): SpaceRecord | null {
    const pid = SpaceUtil.normalizeSpaceId(profileId)
    const current = get(profileId, spaceId)
    if (!pid || !current) return null
    const merged = SpaceUtil.mergeSpaceMeta(current, patch)
    const name = SpaceUtil.safeSpaceName(merged.name, current.name) || current.name
    dbFor(pid).update(spaces).set({
      name,
      icon: merged.icon,
      bgStartColor: merged.bgStartColor,
      bgEndColor: merged.bgEndColor,
      order: merged.order,
      lastUsed: merged.lastUsed
    }).where(and(eq(spaces.profileId, current.profileId), eq(spaces.id, current.id))).run()
    return get(current.profileId, current.id)
  }

  /**
   * 将非当前空间移动到另一个 profile，并保留空间元数据。
   *
   * ⚠ 物理独立（L2）下这是**跨库搬行**：`UPDATE … SET profile_id` 改不了另一个库里的数据，
   *   必须「源库读出 → 源库删 → 目标库插」。单库模式仍走原来的一条 UPDATE。
   */
  function move(profileId: unknown, spaceId: unknown, targetProfileId: unknown, patch: unknown = {}): SpaceRecord | null {
    const pid = SpaceUtil.normalizeSpaceId(profileId)
    const current = get(profileId, spaceId)
    const target = SpaceUtil.normalizeSpaceId(targetProfileId)
    if (!pid || !current || !target || target === current.profileId || get(target, current.id)) return null
    const merged = SpaceUtil.mergeSpaceMeta(current, patch)
    const name = SpaceUtil.safeSpaceName(merged.name, current.name) || current.name
    const nextOrder = SpaceUtil.nextOrder(list(target))

    if (typeof options.dbOf === 'function' && pid !== target) {
      // 跨库搬行：先读原行（含 created_at 等 DB 列），再在目标库插入、源库删除。
      const raw = dbFor(pid).select().from(spaces)
        .where(and(eq(spaces.profileId, current.profileId), eq(spaces.id, current.id))).get()
      if (!raw) return null
      dbFor(target).insert(spaces).values({
        ...raw,
        profileId: target,
        name,
        icon: merged.icon,
        bgStartColor: merged.bgStartColor,
        bgEndColor: merged.bgEndColor,
        order: nextOrder
      }).run()
      dbFor(pid).delete(spaces)
        .where(and(eq(spaces.profileId, current.profileId), eq(spaces.id, current.id))).run()
      return get(target, current.id)
    }

    dbFor(pid).update(spaces).set({
      profileId: target,
      name,
      icon: merged.icon,
      bgStartColor: merged.bgStartColor,
      bgEndColor: merged.bgEndColor,
      order: nextOrder
    }).where(and(eq(spaces.profileId, current.profileId), eq(spaces.id, current.id))).run()
    return get(target, current.id)
  }

  /** 删除空间；默认空间不可删（RT 同语义，保证 profile 永远至少有一个可进入的空间）。 */
  function remove(profileId: unknown, spaceId: unknown): boolean {
    const current = get(profileId, spaceId)
    if (!current) return false
    if (SpaceUtil.isDefaultSpace(current.id)) return false
    dbFor(current.profileId).delete(spaces)
      .where(and(eq(spaces.profileId, current.profileId), eq(spaces.id, current.id))).run()
    return true
  }

  /** 删除某个 profile 下的全部空间（profile 删除时由上层 spacePort 调用）。 */
  function removeByProfile(profileId: unknown): number {
    const pid = SpaceUtil.normalizeSpaceId(profileId)
    if (!pid) return 0
    const rows = dbFor(pid).select().from(spaces).where(eq(spaces.profileId, pid)).all()
    dbFor(pid).delete(spaces).where(eq(spaces.profileId, pid)).run()
    return rows.length
  }

  /** 标记空间被使用（lastUsed = now）。 */
  function setLastUsed(profileId: unknown, spaceId: unknown): boolean {
    const current = get(profileId, spaceId)
    if (!current) return false
    dbFor(current.profileId).update(spaces).set({ lastUsed: now() })
      .where(and(eq(spaces.profileId, current.profileId), eq(spaces.id, current.id))).run()
    return true
  }

  /** 某个 profile 最近使用的空间（无记录返回 null）。 */
  function getLastUsed(profileId: unknown): SpaceRecord | null {
    return SpaceUtil.pickLastUsed(list(profileId))
  }

  /**
   * 批量重排。
   * @param {Array<{ profileId: string, spaceId: string, order: number }>} entries
   */
  function reorder(entries: readonly ReorderEntry[] | null | undefined): boolean {
    const list0 = Array.isArray(entries) ? entries : []
    for (const entry of list0) {
      if (!entry || typeof entry.spaceId !== 'string') continue
      const pid = SpaceUtil.normalizeSpaceId(entry.profileId)
      const sid = SpaceUtil.normalizeSpaceId(entry.spaceId)
      const order = Number(entry.order)
      if (!pid || !sid || !Number.isFinite(order)) continue
      dbFor(pid).update(spaces).set({ order }).where(and(eq(spaces.profileId, pid), eq(spaces.id, sid))).run()
    }
    return true
  }

  return {
    ensureDefault,
    list,
    listAll,
    get,
    findById,
    create,
    update,
    move,
    remove,
    removeByProfile,
    setLastUsed,
    getLastUsed,
    reorder,

    // ── 纯规则透传（上层 / 渲染层共用同一套判定，避免双份实现）──
    normalizeId: (id: unknown) => SpaceUtil.normalizeSpaceId(id),
    isValidName: (name: unknown) => SpaceUtil.validateSpaceName(name).ok,
    relPath: (profileId: string, spaceId: string) => SpaceUtil.spaceRelPath(profileId, spaceId)
  }
}

export { createSpaceService, SpaceUtil }
export * from './spaceUtil'
export default { createSpaceService, ...SpaceUtil }
