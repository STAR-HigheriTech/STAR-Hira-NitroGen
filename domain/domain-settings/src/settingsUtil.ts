// @ts-check
/**
 * Settings 域 — 零依赖纯工具模块
 *
 * 设计主旨：模块化 / 彻底解耦 / 零副作用。
 * 本模块**不 require 任何东西**，全部为纯计算函数（无 IO、无外部状态），
 * 可零成本单测，也可被任意调用方（服务、UI、IPC）复用而无需触碰磁盘。
 *
 * 注意：这里只放"纯推导"能力。凡是与持久化/订阅/缓存相关的服务方法
 * （get / set / list / reset / getDefault / subscribe / flush）都保留在 index.js，
 * 避免重复实现、保持关注点单一。
 */
'use strict'

/**
 * 返回点分键的第一段（section）。
 * 例：'search.engine-x' → 'search'；'app.theme' → 'app'；无点（如 'foo'）→ ''。
 * @param {string} key
 * @returns {string}
 */
export type SettingsMap = Record<string, unknown>

function sectionOf(key: unknown): string {
  if (typeof key !== 'string') return ''
  const dot = key.indexOf('.')
  return dot === -1 ? '' : key.slice(0, dot)
}

/**
 * 将点分键拆成段数组。
 * 例：'app.theme' → ['app','theme']；无点（如 'foo'）→ ['foo']；
 * 空串 / 非字符串 → []。
 * @param {string} key
 * @returns {string[]}
 */
function walkKey(key: unknown): string[] {
  if (typeof key !== 'string' || key === '') return []
  return key.split('.')
}

/**
 * 按预期类型尽力转换值；无法转换时返回原值。
 * supported 路线：
 *  - 'number'：数字 / 数字字符串（'8'、'12.5'）→ Number
 *  - 'boolean'：布尔；'true'/'false'（大小写不敏感）→ 布尔
 *  - 'string'：任何值 → String(...)
 * @param {unknown} value
 * @param {'boolean'|'number'|'string'} expected
 * @returns {unknown}
 */
function coerceType(value: unknown, expected: 'boolean' | 'number' | 'string'): unknown {
  if (expected === 'string') return String(value)
  if (expected === 'number') {
    if (typeof value === 'number') return value
    const n = Number(value)
    if (!Number.isNaN(n)) return n
    return value
  }
  if (expected === 'boolean') {
    if (typeof value === 'boolean') return value
    if (typeof value === 'string') {
      const low = value.trim().toLowerCase()
      if (low === 'true') return true
      if (low === 'false') return false
    }
    // 数字 0/1 语义化转换
    if (value === 1) return true
    if (value === 0) return false
    return value
  }
  return value
}

/**
 * 浅合并：defaults 为底，user 覆盖为顶。
 * 等价 {...defaults, ...user}，返回**新对象**，不改入参。
 * @param {Record<string, unknown>} user
 * @param {Record<string, unknown>} defaults
 * @returns {Record<string, unknown>}
 */
function defaultsWith(user: unknown, defaults: unknown): SettingsMap {
  const u = user && typeof user === 'object' ? user as SettingsMap : {}
  const d = defaults && typeof defaults === 'object' ? defaults as SettingsMap : {}
  return { ...d, ...u }
}

/**
 * 返回 defaults 里在 user 中"缺省"的键数组（以 user 是否有该键为准，值可为 undefined/空）。
 * @param {Record<string, unknown>} user
 * @param {Record<string, unknown>} defaults
 * @returns {string[]}
 */
function missingDefaults(user: SettingsMap | null | undefined, defaults: SettingsMap | null | undefined): string[] {
  const u = user || {}
  const d = defaults || {}
  return Object.keys(d).filter((k) => !(k in u))
}

/**
 * 将数值夹取到 [min, max] 区间。
 * 非法输入（NaN / 非数字）返回 fallback（缺省为 min）。
 * 归一化保证 max>=min，避免错误区间导致反向夹取。
 * @param {unknown} number
 * @param {number} min
 * @param {number} max
 * @param {number} [fallback]
 * @returns {number}
 */
function normalizeBounds(number: unknown, min: number, max: number, fallback?: number): number {
  const lo = Math.min(min, max)
  const hi = Math.max(min, max)
  const fb = typeof fallback === 'number' ? fallback : lo
  const n = Number(number)
  if (Number.isNaN(n) || typeof number === 'boolean') return fb
  // 布尔也可转成 0/1，但语义上应视为"非法回退"，因此上面已拦截
  if (n < lo) return lo
  if (n > hi) return hi
  return n
}

/**
 * 过滤 map：返回所有以 `section + '.'` 为前缀的键值子集（返回新对象）。
 * 空 section 视为不过滤，直接返回空对象（与 list 语义一致：空前缀无匹配）。
 * @param {Record<string, unknown>} map
 * @param {string} section
 * @returns {Record<string, unknown>}
 */
function filterBySection(map: SettingsMap | null | undefined, section: string): SettingsMap {
  const m = map || {}
  if (typeof section !== 'string' || section === '') return {}
  const prefix = section + '.'
  const result: SettingsMap = {}
  for (const [k, v] of Object.entries(m)) {
    if (k.startsWith(prefix)) result[k] = v
  }
  return result
}

/**
 * 取点分键末段，并把点转成 `-`，用于生成 CSS 变量后缀。
 * 例：'app.theme' → 'theme'；'performance.memory_saver' → 'memory_saver'；
 * 单段键（无点）→ 原键。
 * @param {string} key
 * @returns {string}
 */
function toCSSVarSuffix(key: unknown): string {
  const k = typeof key === 'string' ? key : ''
  const last = k.split('.').pop() || ''
  return last.replace(/\./g, '-')
}

/**
 * 结构化深比较：数组 / 纯对象按内容比较，其余走严格相等。
 * 存在的意义：默认值不再只有标量 —— 例如「各栏上下顺序」是 id 数组，
 * 用 `===` 比较会永远判为「已偏离默认」，把「偏离默认项」计数污染成假值。
 * @param {unknown} a
 * @param {unknown} b
 * @returns {boolean}
 */
function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true
  if (Array.isArray(a) && Array.isArray(b)) {
    if (a.length !== b.length) return false
    for (let i = 0; i < a.length; i++) if (!deepEqual(a[i], b[i])) return false
    return true
  }
  if (a && b && typeof a === 'object' && typeof b === 'object') {
    if (Array.isArray(a) || Array.isArray(b)) return false
    const ar = a as Record<string, unknown>
    const br = b as Record<string, unknown>
    const ka = Object.keys(ar)
    const kb = Object.keys(br)
    if (ka.length !== kb.length) return false
    for (const k of ka) {
      if (!Object.prototype.hasOwnProperty.call(br, k)) return false
      if (!deepEqual(ar[k], br[k])) return false
    }
    return true
  }
  return false
}

/**
 * 判断某 key 的当前值是否等于其默认值。
 * @param {string} key
 * @param {unknown} value
 * @param {Record<string, unknown>} defaults
 * @returns {boolean}
 */
function isDefaultValue(key: string, value: unknown, defaults: SettingsMap | null | undefined): boolean {
  return deepEqual((defaults || {})[key], value)
}

/**
 * 返回 map 里出现的所有 section 去重列表，保持首次出现顺序。
 * 例：{'app.theme':1,'search.x':2,'app.n':3} → ['app','search']
 * @param {Record<string, unknown>} map
 * @returns {string[]}
 */
function presentSections(map: SettingsMap | null | undefined): string[] {
  const m = map || {}
  const seen = new Set<string>()
  const out: string[] = []
  for (const k of Object.keys(m)) {
    const s = sectionOf(k)
    if (s && !seen.has(s)) {
      seen.add(s)
      out.push(s)
    }
  }
  return out
}

/**
 * 返回 map 的副本，仅保留指定 section 的键；缺省 section 时返回原 map 的浅拷贝。
 * @param {Record<string, unknown>} map
 * @param {string} [section]
 * @returns {Record<string, unknown>}
 */
function pickSection(map: SettingsMap | null | undefined, section?: string): SettingsMap {
  const m = map || {}
  if (typeof section !== 'string' || section === '') return { ...m }
  return filterBySection(m, section)
}

export {
  sectionOf,
  walkKey,
  coerceType,
  defaultsWith,
  missingDefaults,
  normalizeBounds,
  filterBySection,
  toCSSVarSuffix,
  deepEqual,
  isDefaultValue,
  presentSections,
  pickSection
}

export default {
  sectionOf,
  walkKey,
  coerceType,
  defaultsWith,
  missingDefaults,
  normalizeBounds,
  filterBySection,
  toCSSVarSuffix,
  deepEqual,
  isDefaultValue,
  presentSections,
  pickSection
}
