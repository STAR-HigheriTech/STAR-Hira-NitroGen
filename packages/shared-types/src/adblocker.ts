/**
 * adblocker.mjs —— 内容拦截**级别**的唯一真源（off / ads / ads+tracking）
 *
 * ── 为什么是「级别」而不是两个布尔 ────────────────────────────────────
 * Ghostery 只提供两份预置过滤列表：
 *   · `fromPrebuiltAdsOnly`        → 只拦广告
 *   · `fromPrebuiltAdsAndTracking` → 广告 + 追踪（**广告列表的超集**）
 * 没有「只拦追踪」的预置列表。而设置界面是两把独立开关（拦截广告 / 拦截追踪），
 * 两者必须在**一个地方**收敛成有序级别；否则 infra / settings applier / UI 各自
 * 写一套布尔组合，规则越加越散（「这里一个规则、那里一个变化」），最后无法维护。
 *
 * ── 归属 ─────────────────────────────────────────────────────────────
 *   · infra（Node CJS）：按级别装配 / 热重建 blocker；
 *   · apps（Node CJS）：settings applier 把两个开关换算成级别；
 *   · 渲染层（如需展示级别）：同一份枚举，不另起字面量。
 * 三层互相不能依赖 → 放在最底层的纯模块（与 `https-only.mjs` 同口径）。
 *
 * 纯模块：零依赖、零 IO。
 */

/** 级别（从低到高，也是 UI 展示顺序）。 */
export const ADBLOCKER_LEVELS = Object.freeze(['off', 'ads', 'ads+tracking'])
export type AdblockerLevel = (typeof ADBLOCKER_LEVELS)[number]

/** 开启拦截时的缺省级别：历史数据 / 首次运行（两把开关都缺省）按全量处理。 */
export const DEFAULT_ADBLOCKER_LEVEL = 'ads+tracking'

const LEVEL_SET = new Set(ADBLOCKER_LEVELS)

/**
 * 任意值 → 规范级别；**无法识别返回 ''**（调用方据此拒绝这次写入）。
 *
 * 兼容历史写法：布尔（旧 `setAdblockerEnabled` 口径）、`none` / `disabled` /
 * `ads-only` / `tracking` 等近义串。历史值不写迁移脚本，读时归一、写时落规范值。
 *
 * @param {*} value
 * @returns {string} 'off' | 'ads' | 'ads+tracking' | ''
 */
export function normalizeAdblockerLevel(value: unknown): AdblockerLevel | '' {
  if (value === true) return DEFAULT_ADBLOCKER_LEVEL
  if (value === false) return 'off'
  if (typeof value !== 'string') return ''
  const raw = value.trim().toLowerCase()
  if (LEVEL_SET.has(raw)) return raw as AdblockerLevel
  if (raw === 'none' || raw === 'disabled') return 'off'
  if (raw === 'ads-only' || raw === 'ad') return 'ads'
  if (raw === 'tracking' || raw === 'trackers' || raw === 'ads+trackers' || raw === 'all') {
    return DEFAULT_ADBLOCKER_LEVEL
  }
  return ''
}

/**
 * 两个设置开关 → 级别。
 *
 * 语义（保留历史三态口径）：**缺省按开启**（`undefined` / `null` / 非布尔都算开），
 * 只有显式 `false` 才算关。
 *
 * 追踪开关优先：它需要「广告 + 追踪」superset 列表，而库没有纯追踪列表，因此
 * `trackers=true, ads=false` 仍落 `ads+tracking` —— 这是能力边界，设置项文案里
 * 如实说明，不假装做到了「只拦追踪」。
 *
 * @param {*} blockAds
 * @param {*} blockTrackers
 * @returns {string} 'off' | 'ads' | 'ads+tracking'
 */
export function adblockerLevelFromSettings(blockAds: unknown, blockTrackers: unknown): AdblockerLevel {
  const ads = blockAds !== false
  const trackers = blockTrackers !== false
  if (trackers) return DEFAULT_ADBLOCKER_LEVEL
  if (ads) return 'ads'
  return 'off'
}

/**
 * 级别是否需要过滤列表（`off` 之外都需要）。
 *
 * @param {*} level
 * @returns {boolean}
 */
export function isAdblockerLevelActive(level: unknown): boolean {
  const normalized = normalizeAdblockerLevel(level)
  return normalized !== '' && normalized !== 'off'
}
