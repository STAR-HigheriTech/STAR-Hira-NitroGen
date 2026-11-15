/**
 * profileUtil — Profile 域纯工具模块
 *
 * 零依赖、零 IO、纯计算。所有函数不触碰 DB，不产生副作用。
 * 与 index.js 中 DB 服务方法（list/create/update/remove/setActive/getActive）严格分离，
 * 仅提供 id 校验、名称处理、slug、排序/去重/合并等纯逻辑。
 */

/** id 合法字符：字母数字、`-`、`_`；最长 64 */
const ID_PATTERN = /^[a-zA-Z0-9_-]+$/
const ID_MAX_LEN = 64
const NAME_MAX_LEN = 40

/**
 * 校验/归一 profile id。
 * 规则：去首尾空格 → 转小写 → 仅允许字母数字 `-` `_` → 长度 <=64。
 * @param {*} input
 * @returns {string} 合法归一后的 id；空或非法返回 ''
 */
function normalizeProfileId(input: unknown): string {
  if (typeof input !== 'string') return ''
  const s = input.trim().toLowerCase()
  if (s.length === 0 || s.length > ID_MAX_LEN) return ''
  if (!ID_PATTERN.test(s)) return ''
  return s
}

/**
 * 校验 profile 名称。
 * @param {*} name
 * @returns {{ok: boolean, reason?: string}}
 */
function validateProfileName(name: unknown): { ok: boolean; reason?: string } {
  if (typeof name !== 'string' || name.trim().length === 0) {
    return { ok: false, reason: 'name must be a non-empty string' }
  }
  if (name.trim().length > NAME_MAX_LEN) {
    return { ok: false, reason: `name must be at most ${NAME_MAX_LEN} chars` }
  }
  return { ok: true }
}

/**
 * 名称安全化：trim 后为空则用 fallback。
 * @param {*} name
 * @param {string} fallback
 * @returns {string}
 */
function safeName(name: unknown, fallback: string = 'New Profile'): string {
  if (typeof name !== 'string') return fallback
  const s = name.trim()
  return s.length > 0 ? s : fallback
}

/**
 * 由名称生成稳定 id。
 * 小写 → 非字母数字转 `-` → 去重连续 `-` → 去首尾 `-`。
 * @param {string} name
 * @returns {string}
 */
function slugFromName(name: unknown): string {
  if (typeof name !== 'string') return ''
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-+|-+$/g, '')
}

/**
 * 默认 profile id。
 * @returns {string}
 */
function defaultProfileId() : string {
  return 'default'
}

/** profile 数据根目录名（userData 下的相对段；RT 为 `Profiles`，NG 沿用既有 `profiles`）。 */
const PROFILE_DIR_ROOT = 'profiles'

/**
 * profile 数据目录的相对路径（`profiles/<id>`）。
 * 纯字符串拼接，不触碰 fs —— APPS 层再 join 到 userData。
 * @param {string} profileId
 * @returns {string} 非法 id 返回 ''
 */
function profileRelPath(profileId: string): string {
  const id = normalizeProfileId(profileId)
  if (!id) return ''
  return `${PROFILE_DIR_ROOT}/${id}`
}

/**
 * DB row 的 0/1 标记 → boolean。
 * @param {*} value
 * @returns {boolean}
 */
function truthyFlag(value: unknown): boolean {
  return value === 1 || value === true || value === '1'
}

/**
 * 是否内部 profile（其空间列表不外露）。
 * @param {object} profile
 * @returns {boolean}
 */
function isInternalProfile(profile: unknown): boolean {
  return !!profile && typeof profile === 'object' && truthyFlag((profile as Record<string, unknown>).internal)
}

/**
 * 是否临时 profile（退出即弃，不做持久写）。
 * @param {object} profile
 * @returns {boolean}
 */
function isEphemeralProfile(profile: unknown): boolean {
  return !!profile && typeof profile === 'object' && truthyFlag((profile as Record<string, unknown>).ephemeral)
}

/**
 * 是否为默认 profile。
 * @param {string} id
 * @returns {boolean}
 */
function isDefault(id: unknown): boolean {
  return id === 'default'
}

/**
 * 按 lastActiveAt 降序排序（缺失按 0），稳定。
 * @param {Array<object>} list
 * @returns {Array<object>}
 */
function sortByRecent<T extends Record<string, unknown>>(list: readonly T[] | null | undefined): T[] {
  if (!Array.isArray(list)) return []
  return list
    .map((item, index) => ({ item, index }))
    .sort((a, b) => {
      const ta = Number(a.item && a.item.lastActiveAt) || 0
      const tb = Number(b.item && b.item.lastActiveAt) || 0
      if (tb !== ta) return tb - ta
      return a.index - b.index
    })
    .map(({ item }) => item)
}

/**
 * 返回 isActive 为真的第一项，否则 null。
 * @param {Array<object>} list
 * @returns {object|null}
 */
function pickActive<T extends Record<string, unknown>>(list: readonly T[] | null | undefined): T | null {
  if (!Array.isArray(list)) return null
  const hit = list.find((item) => item && item.isActive)
  return hit === undefined ? null : hit
}

/** 允许并入的合法字段 */
const META_FIELDS = ['name', 'icon', 'color']

/**
 * 合并 profile 元数据：patch 仅并入合法字段（name/icon/color）。
 * 返回新对象，不原地改 base。
 * @param {object} base
 * @param {object} patch
 * @returns {object}
 */
function mergeProfileMeta(base: unknown, patch: unknown): Record<string, unknown> {
  const result: Record<string, unknown> = {
    ...(base && typeof base === 'object' ? base as Record<string, unknown> : {})
  }
  if (!patch || typeof patch !== 'object') return result
  const source = patch as Record<string, unknown>
  for (const field of META_FIELDS) {
    if (Object.prototype.hasOwnProperty.call(source, field) && source[field] !== undefined) {
      result[field] = source[field]
    }
  }
  return result
}

/**
 * 生成分区 key。
 * @param {string} profileId
 * @param {string} scope
 * @returns {string} `${scope}:${id}`；id 非法返回 ''
 */
function partitionKey(profileId: string, scope: string): string {
  const id = normalizeProfileId(profileId)
  if (!id) return ''
  return `${scope}:${id}`
}

/**
 * 按 id 去重，保留先出现者。
 * @param {Array<object>} list
 * @returns {Array<object>}
 */
function dedupeById<T extends { id?: unknown }>(list: readonly (T | null)[] | null | undefined): Array<T | null> {
  if (!Array.isArray(list)) return []
  const seen = new Set<unknown>()
  return list.filter((item) => {
    if (item == null) return true
    const id = item.id
    if (seen.has(id)) return false
    seen.add(id)
    return true
  })
}

const profileUtil = {
  normalizeProfileId,
  validateProfileName,
  safeName,
  slugFromName,
  defaultProfileId,
  PROFILE_DIR_ROOT,
  profileRelPath,
  truthyFlag,
  isInternalProfile,
  isEphemeralProfile,
  isDefault,
  sortByRecent,
  pickActive,
  mergeProfileMeta,
  partitionKey,
  dedupeById
}

export {
  normalizeProfileId,
  validateProfileName,
  safeName,
  slugFromName,
  defaultProfileId,
  PROFILE_DIR_ROOT,
  profileRelPath,
  truthyFlag,
  isInternalProfile,
  isEphemeralProfile,
  isDefault,
  sortByRecent,
  pickActive,
  mergeProfileMeta,
  partitionKey,
  dedupeById
}
export default profileUtil
