/**
 * tabs-retention —— 标签保留策略的**唯一真源**：键名 / 取值档位 / 默认值 / 阈值表 + 两条纯判定。
 *
 * 为什么独立成模块：
 *   · 同一条规则有**三个消费方**：60s 自动归档定时器（module-bootstrap）、
 *     启动恢复期的过期过滤（main.js → domain-session#isExpiredTab）、
 *     以及设置页的下拉选项（settings/registry）；
 *   · 以前阈值表只长在 module-bootstrap 的闭包里，恢复链路拿不到 ——
 *     要么复制一张表（必然漂移：改设置只对一处生效），要么干脆不过滤
 *     （过期标签恢复出来后被 60s 定时器立刻删掉，用户看到"刚恢复就没了"）。
 *
 * 分层：纯函数、零依赖（不碰 electron / fs / settings），设置值由调用方读好传进来。
 * 这样领域侧只认识"阈值毫秒数"，不认识 `tabs.archiveAfter` 这个设置键名。
 */

/** 键名真源：主进程定时器、恢复链路、设置页与 domain-settings 默认值共用。 */
export const TABS_RETENTION_SETTING_KEYS = Object.freeze({
  archiveAfter: 'tabs.archiveAfter'
})

/**
 * `tabs.archiveAfter` 取值 → 归档闲置阈值(ms)。
 *
 * `'never'`（默认）**刻意不在表中** —— 查不到阈值即不归档：把「永不归档」写成数据，
 * 而不是散落的 if 判断。表是档位集合的真源，下拉选项由它派生（见下方 OPTIONS）。
 */
export const ARCHIVE_AFTER_MS = Object.freeze({
  '12h': 12 * 60 * 60 * 1000,
  '1d': 24 * 60 * 60 * 1000,
  '7d': 7 * 24 * 60 * 60 * 1000,
  '30d': 30 * 24 * 60 * 60 * 1000
})

/** 缺省档位：不改变任何既有行为，用户显式开启后才归档。 */
export const DEFAULT_ARCHIVE_AFTER = 'never'

/** 档位 → 中文名（设置页专用文案，展示顺序以本表为准）。 */
const ARCHIVE_AFTER_LABELS = Object.freeze({
  never: '永不',
  '12h': '12 小时',
  '1d': '1 天',
  '7d': '7 天',
  '30d': '30 天'
})

/**
 * 设置页下拉的 [值, 中文名]：**从阈值表派生**，不在别处手抄一遍档位。
 * 顺序 = 「永不 → 12h → 1d → 7d → 30d」（阈值表本身按时间递增书写）。
 */
export const ARCHIVE_AFTER_OPTIONS = Object.freeze(
  [DEFAULT_ARCHIVE_AFTER, ...Object.keys(ARCHIVE_AFTER_MS)]
    .map((value) => [value, ARCHIVE_AFTER_LABELS[value as keyof typeof ARCHIVE_AFTER_LABELS]])
)

/**
 * 设置值 → 阈值毫秒数。`'never'` / 未知值 / 非法值 → `null`（= 不归档）。
 *
 * @param archiveAfter `tabs.archiveAfter` 的原始值（可能来自手改的 settings.json）
 */
export function resolveArchiveThresholdMs(archiveAfter: unknown): number | null {
  if (typeof archiveAfter !== 'string') return null
  const ms = ARCHIVE_AFTER_MS[archiveAfter as keyof typeof ARCHIVE_AFTER_MS]
  return typeof ms === 'number' && ms > 0 ? ms : null
}

/**
 * 这个标签是否已过保留阈值（应当被归档 / 恢复时丢弃）。
 *
 * 与 RT `shouldArchiveTab(lastActiveAt)` 语义对齐，但把"现在"与"阈值"显式传进来
 * （批量判定共用同一个 now，避免逐条取时间导致的边界抖动）。
 *
 * **缺失 `lastActivated` 一律视为"不过期"**（保守保留）：
 *   · 旧会话文件（v3 及以前）没有这个字段，若按 domain-tabs 的"缺失当 0"处理，
 *     升级后第一次启动会把用户所有旧标签判成过期 —— 那是数据事故，不是清理；
 *   · 运行期新标签的 `lastActivated` 由 tabRecord 默认填 now，因此这里不承担兜底职责。
 *
 * @param lastActivated 标签最后一次激活时间（epoch ms）
 * @param thresholdMs 阈值毫秒数（`null` / 非法 → 永不过期）
 * @param now 当前时间（epoch ms，批量判定时由调用方传入同一个值）
 */
export function shouldArchiveTab(lastActivated: unknown, thresholdMs: unknown, now = Date.now()): boolean {
  const threshold = Number(thresholdMs)
  if (!Number.isFinite(threshold) || threshold <= 0) return false
  const last = Number(lastActivated)
  if (!Number.isFinite(last) || last <= 0) return false
  return now - last >= threshold
}
