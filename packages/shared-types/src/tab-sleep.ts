/**
 * tab-sleep —— 标签自动休眠的**唯一真源**：键名 / 阈值档位 / 边界 / 缺省值 + 一个归一化函数。
 *
 * 为什么独立成模块（与 tabs-retention.mjs 同一手法）：
 *   · 同一条阈值有四类消费方 —— 60s 休眠定时器（module-bootstrap）、
 *     领域默认值（domain-settings）、设置页下拉（settings/registry）、
 *     以及 domain-tabs 的 `sleepCandidates` 缺省参数；
 *   · 以前「5 分钟」这个缺省值在四处各写一遍（两处 `5 * 60 * 1000`、一处 `'300000'`、
 *     一处 `300000`），档位表在设置页、边界在域层 —— 改档位只改一处就会漂移。
 *
 * 分层：纯数据 + 纯函数，零依赖（不碰 electron / fs / settings）。
 * 值型别约定：`<select>` 提交的永远是**字符串**，域层按 DEFAULT_SETTINGS 的型别转回 number；
 * 所以下拉选项这里是字符串、缺省值是数字，归一化函数两种都吃。
 */

/** 设置键名真源。 */
export const TAB_SLEEP_SETTING_KEYS = Object.freeze({
  /** 自动休眠总开关 */
  autoSleep: 'tabs.autoSleep',
  /** 闲置多久算可休眠（毫秒） */
  thresholdMs: 'tabs.autoSleepThresholdMs',
  /** 固定标签是否豁免 */
  excludePinned: 'tabs.autoSleepExcludePinned',
  /** 省电模式（收紧阈值 + 后台降频） */
  energySaver: 'tabs.energy_saver'
})

/** 阈值的有理边界：1s .. 24h（越界夹取，与 domain-settings 的输入护栏同一份）。 */
export const AUTO_SLEEP_THRESHOLD_MIN_MS = 1000
export const AUTO_SLEEP_THRESHOLD_MAX_MS = 24 * 60 * 60 * 1000

/**
 * 缺省阈值：5 分钟（原 10 分钟）。
 * 一个醒着的标签 = 一份完整 renderer（实测 ~104MB 工作集 / ~25MB 独占），
 * 切回闲置标签的代价只是一次重新加载，因此默认取更省内存的那一档。
 */
export const DEFAULT_AUTO_SLEEP_THRESHOLD_MS = 5 * 60 * 1000

/** 档位 → 中文名（设置页专用文案；顺序即展示顺序）。 */
const THRESHOLD_LABELS = Object.freeze({
  300000: '5 分钟',
  600000: '10 分钟',
  1800000: '30 分钟',
  3600000: '60 分钟'
})

/**
 * 设置页下拉的 [值, 中文名]，**从档位表派生**。
 * 值是字符串：`<select>` 的 value 天生是字符串，提交后由域层转回 number。
 */
export const AUTO_SLEEP_THRESHOLD_OPTIONS = Object.freeze(
  Object.entries(THRESHOLD_LABELS).map(([ms, label]) => [ms, label] as const)
)

/**
 * 归一化任意历史 / 手改取值到合法毫秒数：非法 → 缺省，越界 → 夹取。
 * @param value 字符串 / 数字 / 野值都可以
 * @returns 合法阈值（number）
 */
export function resolveAutoSleepThresholdMs(value: unknown): number {
  const ms = Number(value)
  if (!Number.isFinite(ms) || ms <= 0) return DEFAULT_AUTO_SLEEP_THRESHOLD_MS
  if (ms < AUTO_SLEEP_THRESHOLD_MIN_MS) return AUTO_SLEEP_THRESHOLD_MIN_MS
  if (ms > AUTO_SLEEP_THRESHOLD_MAX_MS) return AUTO_SLEEP_THRESHOLD_MAX_MS
  return ms
}
