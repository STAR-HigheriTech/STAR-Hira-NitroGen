/**
 * Chromium 时间戳换算（唯一真源）
 *
 * Chromium 的 `visit_time` / `date_added` 是 **WebKit 时间**：
 *   自 1601-01-01 UTC 起的**微秒**数。
 * 本项目统一用 Unix 毫秒，换算 = 微秒 / 1000 - 11644473600000ms
 * （1601-01-01 到 1970-01-01 的毫秒差）。
 *
 * 无法识别的值一律返回 0（= 未知时间），由调用方决定跳过还是用当前时间兜底。
 * 不抛异常：一条坏数据不该让整份历史导入失败。
 *
 * @param {unknown} value
 * @returns {number} Unix 毫秒；非法值 → 0
 */
export const CHROMIUM_EPOCH_DELTA_MS = 11644473600000

export function webkitToUnixMs(value: unknown): number {
  const n = Number(value)
  if (!Number.isFinite(n) || n <= 0) return 0
  const ms = Math.round(n / 1000) - CHROMIUM_EPOCH_DELTA_MS
  return ms > 0 ? ms : 0
}

