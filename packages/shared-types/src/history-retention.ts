/**
 * history-retention —— 历史保留期的**唯一真源**：键名 / 档位表 / 缺省值 + 一个换算函数。
 *
 * 消费方两处：设置页下拉（settings/registry）与 6 小时一次的裁剪定时器
 * （module-bootstrap）。以前键名、档位、缺省天数各写一遍 ——
 * 设置页写 `'90'`（字符串）、域层写 `90`（数字）、定时器再 `Number(...)` 兜一次，
 * 属于同一份词表的手抄。
 *
 * 语义：`0` = 永久保留（不裁剪）；正数 = 保留天数。
 */

export const HISTORY_RETENTION_SETTING_KEY = 'privacy.history_retention_days'

/** 缺省 90 天：与旧行为一致（用户不设置时不做假设性清理）。 */
export const DEFAULT_HISTORY_RETENTION_DAYS = 90

/** 档位 → 中文名（设置页专用文案；顺序即展示顺序）。 */
const RETENTION_LABELS = Object.freeze({
  0: '永久保留',
  30: '30 天',
  90: '90 天',
  180: '180 天',
  365: '1 年'
})

/**
 * 设置页下拉的 [值, 中文名]，**从档位表派生**。
 * 值是字符串：`<select>` 的 value 天生是字符串，提交后由域层转回 number。
 */
export const HISTORY_RETENTION_DAY_OPTIONS = Object.freeze(
  Object.entries(RETENTION_LABELS).map(([days, label]) => [days, label] as const)
)

/**
 * 保留天数 → 保留毫秒数：`0` / 非法 / 非正数 → `0`（= 永久保留）。
 * @param days `privacy.history_retention_days` 的原始值
 */
export function resolveHistoryRetentionMs(days: unknown): number {
  const n = Number(days)
  return Number.isFinite(n) && n > 0 ? n * 24 * 60 * 60 * 1000 : 0
}
