/**
 * date-display.mjs —— 「按日期分段」与「一眼能读的时间戳」的**唯一真源**。
 *
 * 三个面板此前各抄一份完全相同的口径：
 *   · 历史（`ui-panel-history`）—— `groupHistoryByDate`；
 *   · 归档（`ui-panel-opentabs`）—— `GROUPS` + `groupKeyOf` + `formatArchivedAt`；
 *   · 命名会话（`ui-panel-sessions`）—— `GROUPS` + `groupKeyOf` + `formatSavedAt`。
 *
 * 其中 `groupKeyOf` 逐字相同，`formatArchivedAt` 与 `formatSavedAt` 除函数名外逐字相同，
 * 分组键还存在 `earlier` / `older` 两种写法（同一含义、两个键）。任何一处改口径
 * （比如把「近 7 天」改成「本周」）都会让三个面板的说法分叉。
 *
 * 这里只放**纯函数 + 纯数据**：没有 DOM、没有时区库、没有本地化框架。
 * 时间一律按本机时区的自然日切分（用户读日期的习惯就是看本地日历）。
 */

/** 一天的毫秒数（分组口径里的日边界都按自然日算，不按 24h 滑窗）。 */
export const DAY_MS = 24 * 60 * 60 * 1000

/**
 * 分段键，**同时是展示顺序**（旧 → 新不适用：这里从新到旧）。
 * 统一用 `older`，不再出现 `earlier` 这个同义键。
 * @type {ReadonlyArray<'today' | 'yesterday' | 'week' | 'older'>}
 */
export const DATE_BUCKETS: ReadonlyArray<'today' | 'yesterday' | 'week' | 'older'> = Object.freeze(['today', 'yesterday', 'week', 'older'] as const)
export type DateBucket = (typeof DATE_BUCKETS)[number]

/** 分段键 → 中文标签。 */
export const DATE_BUCKET_LABELS = Object.freeze({
  today: '今天',
  yesterday: '昨天',
  week: '近 7 天',
  older: '更早'
})

/**
 * 本地时区「今天 00:00」的时间戳。
 * @param {number} [now]
 * @returns {number}
 */
export function startOfToday(now: number = Date.now()) : number {
  const ref = new Date(now)
  return new Date(ref.getFullYear(), ref.getMonth(), ref.getDate()).getTime()
}

/**
 * 时间戳 → 分段键。
 * 非数字 / 空值一律落到 `older`（列表里不会因此出现一个凭空多出来的「今天」组）。
 * @param {unknown} ts
 * @param {number} [now]
 * @returns {'today' | 'yesterday' | 'week' | 'older'}
 */
export function dateBucketOf(ts: unknown, now: number = Date.now()): DateBucket {
  const value = Number(ts) || 0
  const today = startOfToday(now)
  if (value >= today) return 'today'
  if (value >= today - DAY_MS) return 'yesterday'
  if (value >= today - 6 * DAY_MS) return 'week'
  return 'older'
}

/**
 * 分段键 → 中文标签（未知键给空串：宁可少一行组标题，也不显示 `undefined`）。
 * @param {string} key
 * @returns {string}
 */
export function dateBucketLabel(key: unknown): string {
  const normalized = String(key) as DateBucket
  return DATE_BUCKET_LABELS[normalized] || ''
}

function pad2(n: number): string {
  return n < 10 ? `0${n}` : String(n)
}

/**
 * 时间戳 → 一眼能读的相对时间：一分钟内「刚刚」，一小时内「N 分钟前」，
 * 今天 / 昨天给「今天 HH:mm」，同年给「M 月 D 日」，跨年给「YYYY/MM/DD」。
 *
 * @param {unknown} ts
 * @param {number} [now]
 * @returns {string} 无效时间戳返回空串
 */
export function formatRelativeStamp(ts: unknown, now: number = Date.now()): string {
  const value = Number(ts)
  if (!Number.isFinite(value) || value <= 0) return ''
  const diff = now - value
  if (diff < 0) return '刚刚'
  if (diff < 60 * 1000) return '刚刚'
  if (diff < 60 * 60 * 1000) return `${Math.floor(diff / (60 * 1000))} 分钟前`
  const d = new Date(value)
  const ref = new Date(now)
  const today = startOfToday(now)
  const hm = `${pad2(d.getHours())}:${pad2(d.getMinutes())}`
  if (value >= today) return `今天 ${hm}`
  if (value >= today - DAY_MS) return `昨天 ${hm}`
  if (d.getFullYear() === ref.getFullYear()) return `${d.getMonth() + 1} 月 ${d.getDate()} 日`
  return `${d.getFullYear()}/${pad2(d.getMonth() + 1)}/${pad2(d.getDate())}`
}
