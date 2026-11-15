/**
 * spaceUtil — Space 域纯工具模块
 *
 * 零依赖、零 IO、纯计算：id 校验、名称处理、默认值补齐、排序、白名单合并、重排映射。
 * 与 index.js 的 DB 服务严格分离，可脱离一切运行时单测。
 *
 * 对齐 RT `spaces-controller/raw.ts` 的规则语义：
 *   SpaceData { name, profileId, bgStartColor?, bgEndColor?, icon?, lastUsed, order }
 *   reconcile 默认值：name = spaceId（default 时为 "Default"）、lastUsed ?? 0、order ?? 999
 */

/** id 合法字符：字母数字、`-`、`_`；最长 64（与 profile id 同规则，RT 亦一致） */
const ID_PATTERN = /^[a-zA-Z0-9_-]+$/
const ID_MAX_LEN = 64
const NAME_MAX_LEN = 40

/**
 * 空间图标规则（白名单 / 别名 / 默认分配）的**唯一真源**在 shared-types ——
 * 渲染层与内部页 import 的也是同一份，杜绝「DB 存得进去、界面画不出来」。
 */
import {
  SPACE_ICON_IDS,
  DEFAULT_SPACE_ICON,
  normalizeSpaceIcon,
  resolveSpaceIconId,
  defaultSpaceIcon
} from '@hira-ng/shared-types/src/space-icon.mjs'

export interface SpaceRecord {
  id: string
  profileId: string
  name: string
  icon: string
  bgStartColor: string
  bgEndColor: string
  lastUsed: number
  order: number
  createdAt?: number
  [key: string]: unknown
}

export interface ReconcileContext { spaceId?: unknown; profileId?: unknown }
export interface ReorderEntry { spaceId: string; order: number; profileId?: string }

/** 默认空间 id（RT 亦用 "default"） */
const DEFAULT_SPACE_ID = 'default'
/** 默认空间显示名（RT：spaceId === "default" 时为 "Default"） */
const DEFAULT_SPACE_NAME = 'Default'
/** reconcile 时的兜底 order（RT 同值） */
const FALLBACK_ORDER = 999

/**
 * 校验/归一 space id。去首尾空格 → 转小写 → 仅允许 `[a-zA-Z0-9_-]` → 长度 <=64。
 * @param {*} input
 * @returns {string} 合法归一后的 id；非法返回 ''
 */
function normalizeSpaceId(input: unknown): string {
  if (typeof input !== 'string') return ''
  const s = input.trim().toLowerCase()
  if (s.length === 0 || s.length > ID_MAX_LEN) return ''
  if (!ID_PATTERN.test(s)) return ''
  return s
}

/**
 * 校验空间名称。
 * @param {*} name
 * @returns {{ok: boolean, reason?: string}}
 */
function validateSpaceName(name: unknown): { ok: boolean; reason?: string } {
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
function safeSpaceName(name: unknown, fallback: string = 'New Space'): string {
  if (typeof name !== 'string') return fallback
  const s = name.trim()
  return s.length > 0 ? s : fallback
}

/**
 * 由名称生成稳定 id（小写 → 非字母数字转 `-` → 压缩/去首尾 `-`）。
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

/** 默认空间 id。 */
function defaultSpaceId() {
  return DEFAULT_SPACE_ID
}

/** 是否默认空间。 */
function isDefaultSpace(id: unknown): boolean {
  return id === DEFAULT_SPACE_ID
}

/**
 * 补齐/归一一条 space 记录（RT reconcileSpaceData 的等价实现）。
 * 缺失字段一律兜底，绝不抛错——磁盘/DB 里的脏数据不能让整个空间列表崩掉。
 *
 * @param {object} raw
 * @param {{ spaceId?: string, profileId?: string }} ctx
 * @returns {{id:string, profileId:string, name:string, icon:string, bgStartColor:string, bgEndColor:string, lastUsed:number, order:number}}
 */
function reconcileSpace(raw: unknown, ctx: ReconcileContext = {}): SpaceRecord {
  const src = raw && typeof raw === 'object' ? raw as Record<string, unknown> : {}
  const id = normalizeSpaceId(ctx.spaceId || src.id) || DEFAULT_SPACE_ID
  const isDefault = id === DEFAULT_SPACE_ID
  const fallbackName = isDefault ? DEFAULT_SPACE_NAME : id
  return {
    id,
    profileId: typeof (ctx.profileId || src.profileId) === 'string' ? String(ctx.profileId || src.profileId) : '',
    name: safeSpaceName(src.name, fallbackName) || fallbackName,
    // 白名单 + 别名归一：脏数据（carbon:*、旧 unicode、任意字符串）一律收敛到规范 id；
    // 空值 / 非法值回退「该空间自己的默认图标」（default → home，其它按 id 稳定分配），
    // 而不是全库抹成同一颗 —— 空间卡片永远画得出图标，也不会看起来都长一样。
    icon: normalizeSpaceIcon(src.icon) || defaultSpaceIcon(id),
    bgStartColor: typeof src.bgStartColor === 'string' ? src.bgStartColor : '',
    bgEndColor: typeof src.bgEndColor === 'string' ? src.bgEndColor : '',
    lastUsed: Number.isFinite(Number(src.lastUsed)) ? Number(src.lastUsed) : 0,
    order: Number.isFinite(Number(src.order)) ? Number(src.order) : FALLBACK_ORDER
  }
}

/** 允许并入的合法字段（RT update() 的字段级白名单）。 */
const META_FIELDS = ['name', 'icon', 'bgStartColor', 'bgEndColor', 'lastUsed', 'order']

/**
 * 合并空间元数据：patch 仅并入白名单字段，返回新对象（不原地改）。
 * 显式 undefined/null 一律忽略——避免把已有值抹成空。
 *
 * @param {object} base
 * @param {object} patch
 * @returns {object}
 */
function mergeSpaceMeta(base: unknown, patch: unknown): Record<string, unknown> {
  const result: Record<string, unknown> = {
    ...(base && typeof base === 'object' ? base as Record<string, unknown> : {})
  }
  if (!patch || typeof patch !== 'object') return result
  const source = patch as Record<string, unknown>
  for (const field of META_FIELDS) {
    const value = source[field]
    if (value === undefined || value === null) continue
    if (field === 'icon') {
      // 只接受白名单 / 已知别名；**非法值忽略**（保留原图标），不把脏字符串写进库。
      const normalized = normalizeSpaceIcon(value)
      if (!normalized) continue
      result.icon = normalized
      continue
    }
    if (field === 'order' || field === 'lastUsed') {
      const n = Number(value)
      if (!Number.isFinite(n)) continue
      result[field] = n
      continue
    }
    if (typeof value !== 'string') continue
    result[field] = value
  }
  return result
}

/**
 * 按 order 升序排序（缺失按 999），order 相同按 lastUsed 降序，再按原顺序稳定。
 * @param {Array<object>} list
 * @returns {Array<object>}
 */
function sortSpaces<T extends Record<string, unknown>>(list: readonly T[] | null | undefined): T[] {
  if (!Array.isArray(list)) return []
  return list
    .map((item, index) => ({ item, index }))
    .sort((a, b) => {
      const oa = Number(a.item && a.item.order)
      const ob = Number(b.item && b.item.order)
      const va = Number.isFinite(oa) ? oa : FALLBACK_ORDER
      const vb = Number.isFinite(ob) ? ob : FALLBACK_ORDER
      if (va !== vb) return va - vb
      const la = Number(a.item && a.item.lastUsed) || 0
      const lb = Number(b.item && b.item.lastUsed) || 0
      if (lb !== la) return lb - la
      return a.index - b.index
    })
    .map(({ item }) => item)
}

/**
 * 取最近使用的空间（lastUsed 最大），空列表返回 null。
 * @param {Array<object>} list
 * @returns {object|null}
 */
function pickLastUsed<T extends Record<string, unknown>>(list: readonly T[] | null | undefined): T | null {
  if (!Array.isArray(list) || list.length === 0) return null
  let best = null
  let bestAt = -1
  for (const item of list) {
    if (!item) continue
    const at = Number(item.lastUsed) || 0
    if (at > bestAt) { bestAt = at; best = item }
  }
  return best
}

/**
 * 计算下一个可用 order（当前最大值 +1），空列表返回 0。
 * @param {Array<object>} list
 * @returns {number}
 */
function nextOrder(list: readonly Record<string, unknown>[] | null | undefined): number {
  if (!Array.isArray(list) || list.length === 0) return 0
  let max = -1
  for (const item of list) {
    const n = Number(item && item.order)
    if (Number.isFinite(n) && n > max) max = n
  }
  return max + 1
}

/**
 * 把重排指令应用到列表上（返回新数组，不原地改）。
 * 指令中不存在的 id 忽略；未出现在指令中的空间保持原 order 不变。
 *
 * @param {Array<object>} list
 * @param {Array<{spaceId:string, order:number}>} orderMap
 * @returns {Array<object>}
 */
function applyReorder<T extends Record<string, unknown>>(list: readonly T[] | null | undefined, orderMap: readonly ReorderEntry[] | null | undefined): T[] {
  if (!Array.isArray(list)) return []
  const map = new Map<string, number>()
  for (const entry of Array.isArray(orderMap) ? orderMap : []) {
    if (!entry || typeof entry.spaceId !== 'string') continue
    const n = Number(entry.order)
    if (!Number.isFinite(n)) continue
    map.set(entry.spaceId, n)
  }
  return list.map((item) => {
    if (!item || !map.has(item.id)) return item
    return { ...item, order: map.get(item.id) }
  })
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

/**
 * 空间存储相对路径（`profiles/<profileId>/spaces/<spaceId>`）。
 * 纯字符串拼接，不触碰 fs —— APPS 层再 join 到 userData。
 * @param {string} profileId
 * @param {string} spaceId
 * @returns {string} 非法入参返回 ''
 */
function spaceRelPath(profileId: string, spaceId: string): string {
  const pid = normalizeSpaceId(profileId)
  const sid = normalizeSpaceId(spaceId)
  if (!pid || !sid) return ''
  return `profiles/${pid}/spaces/${sid}`
}

const spaceUtil = {
  ID_PATTERN,
  ID_MAX_LEN,
  NAME_MAX_LEN,
  SPACE_ICON_IDS,
  DEFAULT_SPACE_ICON,
  DEFAULT_SPACE_ID,
  DEFAULT_SPACE_NAME,
  FALLBACK_ORDER,
  META_FIELDS,
  normalizeSpaceIcon,
  resolveSpaceIconId,
  defaultSpaceIcon,
  normalizeSpaceId,
  validateSpaceName,
  safeSpaceName,
  slugFromName,
  defaultSpaceId,
  isDefaultSpace,
  reconcileSpace,
  mergeSpaceMeta,
  sortSpaces,
  pickLastUsed,
  nextOrder,
  applyReorder,
  dedupeById,
  spaceRelPath
}

export {
  ID_PATTERN,
  ID_MAX_LEN,
  NAME_MAX_LEN,
  SPACE_ICON_IDS,
  DEFAULT_SPACE_ICON,
  DEFAULT_SPACE_ID,
  DEFAULT_SPACE_NAME,
  FALLBACK_ORDER,
  META_FIELDS,
  normalizeSpaceIcon,
  resolveSpaceIconId,
  defaultSpaceIcon,
  normalizeSpaceId,
  validateSpaceName,
  safeSpaceName,
  slugFromName,
  defaultSpaceId,
  isDefaultSpace,
  reconcileSpace,
  mergeSpaceMeta,
  sortSpaces,
  pickLastUsed,
  nextOrder,
  applyReorder,
  dedupeById,
  spaceRelPath
}
export default spaceUtil
