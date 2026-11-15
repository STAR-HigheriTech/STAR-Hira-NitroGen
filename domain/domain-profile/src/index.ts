/**
 * Domain: Profile — Profile 配置管理
 *
 * 对齐 RT `profiles-controller`（raw + index 双层）：
 *   - 数据模型 { id, name, icon, color, createdAt, lastActiveAt, isActive, internal, ephemeral }
 *   - 每个 profile 对应一个独立的 Chromium profile 目录 `userData/profiles/<id>`
 *     （会话/扩展/cookie 全落此处，由 APPS 层的 sessions 装配负责）
 *   - 创建 profile 时自动建「同名默认空间」
 *   - internal（如无痕，空间不外露）/ ephemeral（临时，退出即弃）
 *
 * ── 解耦：空间联动走「鸭子端口」而非直接依赖 ─────────────────
 * 本模块 **不 require domain-space**。上层（APPS）注入 `spacePort`：
 *   { ensureDefaultSpace(profileId, name), removeByProfile(profileId) }
 * 与 domain-session 注入 `filePort` 是同一惯用法：域层只管规则，能力由外部给。
 * 未注入 spacePort 时全部退化为空操作 —— 单独使用 profile 域也能跑。
 */
import { profiles } from '@hira-ng/infra-db/schema'
import { asc as drizzleAsc, desc as drizzleDesc, eq as drizzleEq } from 'drizzle-orm'
import { generateId } from '@hira-ng/shared-utils'
import ProfileUtil from './profileUtil'

export interface ProfileRow {
  id: string
  name: string
  icon: string
  color: string | null
  createdAt: number
  lastActiveAt: number | null
  isActive: number | boolean
  internal: number | boolean
  ephemeral: number | boolean
  [key: string]: unknown
}

export interface Profile extends Omit<ProfileRow, 'internal' | 'ephemeral'> {
  internal: boolean
  ephemeral: boolean
}

interface ProfileInsert {
  id: string
  name: string
  icon: string
  color: string | null
  createdAt: number
  lastActiveAt: number | null
  isActive: number
  internal: number
  ephemeral: number
}

type ProfilePatch = Partial<Pick<ProfileRow, 'name' | 'icon' | 'color' | 'lastActiveAt' | 'isActive'>>
type Condition = unknown
type BinaryCondition = (column: unknown, value: unknown) => Condition
const eq = drizzleEq as unknown as BinaryCondition
const desc = drizzleDesc as unknown as (column: unknown) => unknown
const asc = drizzleAsc as unknown as (column: unknown) => unknown

interface ProfileDatabase {
  insert(table: unknown): { values(value: ProfileInsert): { run(): unknown } }
  update(table: unknown): {
    set(value: ProfilePatch): {
      where(condition: Condition): { run(): unknown }
      run(): unknown
    }
  }
  delete(table: unknown): { where(condition: Condition): { run(): unknown } }
  select(): {
    from(table: unknown): {
      where(condition: Condition): { get(): ProfileRow | undefined; all(): ProfileRow[] }
      orderBy(value: unknown): { all(): ProfileRow[] }
    }
  }
}

interface SpaceProfilePort {
  ensureDefaultSpace(profileId: string, name: string): void
  removeByProfile(profileId: string): void
}

interface ProfileDataPort { removeProfileData(profileId: string): void }

export interface ProfileServiceDeps {
  spacePort?: SpaceProfilePort
  dataPort?: ProfileDataPort
}

export interface CreateProfileInput {
  id?: string
  name?: string
  icon?: string
  color?: string
  internal?: boolean
  ephemeral?: boolean
  createSpace?: boolean
}

/** 空端口：未注入 spacePort 时的安全退避，避免到处写 `if (spacePort)`。 */
const NOOP_SPACE_PORT: SpaceProfilePort = {
  ensureDefaultSpace: (_profileId, _name) => {},
  removeByProfile: (_profileId) => {}
}

/**
 * 空端口：未注入 dataPort 时的安全退避。
 *
 * `dataPort.removeProfileData(profileId)` 负责在删除 profile 时清掉它的**物理数据**
 * （L2 物理独立后，profile 的数据就在 `profiles/<id>/` 里 —— 关库 + 删目录）。
 * 域层不碰文件系统，因此与 spacePort 同一手法：能力由 APPS 注入。
 */
const NOOP_DATA_PORT: ProfileDataPort = {
  removeProfileData: (_profileId) => {}
}

/**
 * @param {import('drizzle-orm/better-sqlite3').BetterSQLite3Database} db
 * @param {{ spacePort?: { ensureDefaultSpace: Function, removeByProfile: Function }, dataPort?: { removeProfileData: Function } }} [deps]
 */
function createProfileService(db: ProfileDatabase, deps: ProfileServiceDeps = {}) {
  const now = () => Date.now()
  const spacePort = deps.spacePort || NOOP_SPACE_PORT
  const dataPort = deps.dataPort || NOOP_DATA_PORT

  /** DB row → 域对象（0/1 标记全部转 boolean，调用方不必再记 flag 语义）。 */
  function toDomain(row: ProfileRow | null | undefined): Profile | null {
    if (!row) return null
    return {
      ...row,
      internal: ProfileUtil.truthyFlag(row.internal),
      ephemeral: ProfileUtil.truthyFlag(row.ephemeral)
    }
  }

  function insertProfile({ id, name, icon, color, isActive, internal, ephemeral }: {
    id: string
    name: string
    icon?: string
    color?: string
    isActive?: boolean
    internal?: boolean
    ephemeral?: boolean
  }): Profile | null {
    db.insert(profiles).values({
      id,
      name,
      icon: icon || 'carbon:user',
      color: color || null,
      createdAt: now(),
      lastActiveAt: isActive ? now() : null,
      isActive: isActive ? 1 : 0,
      internal: internal ? 1 : 0,
      ephemeral: ephemeral ? 1 : 0
    }).run()
    return get(id)
  }

  /**
   * 确保 default profile 存在（首次启动时创建），并补齐其默认空间。
   */
  function ensureDefault() {
    const existing = db.select().from(profiles).where(eq(profiles.id, 'default')).get()
    if (!existing) {
      insertProfile({ id: 'default', name: 'Default', icon: 'carbon:home', isActive: true })
    }
    // 确保有且仅有一个 active
    const active = db.select().from(profiles).where(eq(profiles.isActive, 1)).all()
    if (active.length === 0) {
      db.update(profiles).set({ isActive: 1, lastActiveAt: now() }).where(eq(profiles.id, 'default')).run()
    }
    // default profile 的默认空间（老库升级路径：此前无 spaces 表）
    spacePort.ensureDefaultSpace('default', 'Default')
    return get('default')
  }

  /** 全部 profile（按最近激活降序；含 internal/ephemeral）。 */
  function list() {
    return db.select().from(profiles).orderBy(desc(profiles.lastActiveAt)).all().map(toDomain)
  }

  /** 全部 profile，按 createdAt 升序（RT `getAll()` 语义，供稳定列表渲染）。 */
  function getAll() {
    return db.select().from(profiles).orderBy(asc(profiles.createdAt)).all().map(toDomain)
  }

  /** 可见 profile（过滤掉 internal，RT：visibleSpaces 的过滤依据）。 */
  function listVisible() {
    return list().filter((p) => p && !p.internal)
  }

  function getActive() {
    const active = db.select().from(profiles).where(eq(profiles.isActive, 1)).get()
    if (active) return toDomain(active)
    ensureDefault()
    return get('default')
  }

  function get(id: unknown): Profile | null {
    const pid = ProfileUtil.normalizeProfileId(id) || (typeof id === 'string' ? id : '')
    if (!pid) return null
    return toDomain(db.select().from(profiles).where(eq(profiles.id, pid)).get())
  }

  /**
   * 创建 profile。
   * @param {{ id?: string, name?: string, icon?: string, color?: string, internal?: boolean, ephemeral?: boolean, createSpace?: boolean }} input
   */
  function create(input: CreateProfileInput = {}): Profile | null {
    const safe = ProfileUtil.safeName(input.name, '')
    const finalName = safe && ProfileUtil.validateProfileName(safe).ok ? safe : 'New Profile'
    const id = ProfileUtil.normalizeProfileId(input.id) || generateId('profile')
    const created = insertProfile({
      id,
      name: finalName,
      icon: input.icon,
      color: input.color,
      isActive: false,
      internal: input.internal,
      ephemeral: input.ephemeral
    })
    // RT：profile 创建时自动建「同名默认空间」（无痕等内部 profile 不建，其空间不外露）
    if (input.createSpace !== false) {
      spacePort.ensureDefaultSpace(id, finalName)
    }
    return created
  }

  /** 创建无痕 profile（internal + ephemeral，RT `createIncognito()` 语义）。 */
  function createIncognito() {
    return create({
      name: 'Incognito',
      icon: 'carbon:view-off',
      internal: true,
      ephemeral: true
    })
  }

  /** 更新 profile 元数据（name/icon/color 白名单由 mergeProfileMeta 保证）。 */
  function update(id: unknown, patch: unknown): Profile | null {
    const current = get(id)
    if (!current) return null
    const merged = ProfileUtil.mergeProfileMeta(current, patch) as Pick<ProfileRow, 'name' | 'icon' | 'color'>
    db.update(profiles).set({
      name: merged.name,
      icon: merged.icon,
      color: merged.color
    }).where(eq(profiles.id, current.id)).run()
    return get(current.id)
  }

  function setActive(id: unknown): Profile | null {
    const target = get(id)
    if (!target) return null
    db.update(profiles).set({ isActive: 0 }).run()
    db.update(profiles).set({ isActive: 1, lastActiveAt: now() }).where(eq(profiles.id, target.id)).run()
    return get(target.id)
  }

  /**
   * 删除 profile：先清空其名下全部空间，再删 profile 行。
   * 删除当前 active 时回落到 default。
   */
  function remove(id: unknown): boolean {
    const target = get(id)
    if (!target) return false
    if (ProfileUtil.isDefault(target.id)) return false // 不能删除 default

    spacePort.removeByProfile(String(target.id))
    // 清掉该 profile 的**物理数据**（L2：关库 + 删 `profiles/<id>/` 目录）。
    // 顺序：先清空间行（上一行）→ 再清物理目录 → 最后删 profile 行。
    // 目录删不掉也不能让 DB 行留下（那会成为一个永远删不掉的幽灵用户）——
    // APPS 注入的实现自身吞掉文件异常并告警，域层只当它"尽力而为"。
    try { dataPort.removeProfileData(String(target.id)) } catch (e) {
      const message = e && typeof e === 'object' && 'message' in e ? String((e as { message: unknown }).message) : String(e)
      console.warn('[domain-profile] 清理 profile 数据目录失败（忽略）:', message)
    }
    db.delete(profiles).where(eq(profiles.id, target.id)).run()

    const active = getActive()
    if (!active || active.id === target.id) setActive('default')
    return true
  }

  /** profile 的数据目录相对路径（`profiles/<id>`）。 */
  function profileRelPath(id: string): string {
    return ProfileUtil.profileRelPath(id)
  }

  /** 内部/临时标记查询（渲染层按 profileId 判断空间是否可见）。 */
  function areInternal() {
    const map: Record<string, boolean> = {}
    for (const p of list()) if (p) map[String(p.id)] = !!p.internal
    return map
  }

  function areEphemeral() {
    const map: Record<string, boolean> = {}
    for (const p of list()) if (p) map[String(p.id)] = !!p.ephemeral
    return map
  }

  return {
    ensureDefault,
    list,
    getAll,
    listVisible,
    getActive,
    get,
    create,
    createIncognito,
    update,
    setActive,
    remove,
    profileRelPath,
    areInternal,
    areEphemeral,

    // ── additive 纯规则能力 ──
    normalize: (id: unknown) => ProfileUtil.normalizeProfileId(id),
    sorted: () => ProfileUtil.sortByRecent(list().filter((profile): profile is Profile => profile !== null)),
    pickActiveFrom: (listInput: ReadonlyArray<Record<string, unknown>> | null | undefined) => ProfileUtil.pickActive(listInput),
    merge: (id: unknown, patch: unknown) => ProfileUtil.mergeProfileMeta(get(id) || {}, patch),
    isDefaultId: (id: unknown) => ProfileUtil.isDefault(id),
    isInternalId: (id: unknown) => ProfileUtil.isInternalProfile(get(id)),
    isEphemeralId: (id: unknown) => ProfileUtil.isEphemeralProfile(get(id)),

    // 纯规则透传
    safeName: (name: unknown) => ProfileUtil.safeName(name),
    validateName: (name: unknown) => ProfileUtil.validateProfileName(name)
  }
}

export { createProfileService, ProfileUtil }
export * from './profileUtil'
export default { createProfileService, ...ProfileUtil }
