/**
 * 对齐到整周期再唤醒的定时器（页面级小工具）。
 *
 * 为什么不用 `setInterval`：
 *   · 周期与系统时钟错开 → 秒数/分钟会"跳"，看起来不准；
 *   · 它会一直按自己的节奏醒着，而"整分显示"的时间用不上每秒都醒。
 * 这里对齐到下一个整周期，并在"从休眠恢复 / 系统时间被改"之后**立刻校正**
 * （而不是等下一次 tick 慢慢对齐）。
 *
 * 两处用它：看板里的时间组件（整秒）、页面右上角的时间（整分）。
 * 差异只有周期，所以逻辑放一份。
 *
 * @param {number} periodMs 周期（1000 = 整秒，60000 = 整分）
 * @param {() => void} onTick
 * @returns {() => void} 停止函数
 */
export function createTicker(periodMs: number, onTick: () => void) : () => void {
  let timer = 0

  function schedule() {
    onTick()
    timer = window.setTimeout(schedule, periodMs - (Date.now() % periodMs) + 4)
  }

  const onVisible = () => {
    if (document.visibilityState !== 'visible') return
    window.clearTimeout(timer)
    schedule()
  }

  schedule()
  document.addEventListener('visibilitychange', onVisible)

  return () => {
    window.clearTimeout(timer)
    document.removeEventListener('visibilitychange', onVisible)
  }
}
