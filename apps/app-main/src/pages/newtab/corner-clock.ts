/**
 * 顶部的时间（就在分区选项卡**左边**、与选项卡同高齐平）。
 *
 * 它是**页面外壳**的一部分 —— 三个分区上都在，既不是组件也不是分区。
 * 所以不放进首页的组件清单：那样一切到推广页就没了。
 *
 * 只显示到分钟，所以整分钟醒一次就够（用 lib/ticker.js 对齐唤醒）。
 */
import { createTicker } from './lib/ticker.js'
import { WEEKDAY_NAMES } from 'hira://shared/weekday.mjs'

/**
 * @param {HTMLElement} host
 * @returns {() => void} 停止函数
 */
export function mountCornerClock(host?: HTMLElement) : () => void {
  if (!host) return () => {}

  const paint = () => {
    const now = new Date()
    const hh = String(now.getHours()).padStart(2, '0')
    const mm = String(now.getMinutes()).padStart(2, '0')
    host.textContent = `${hh}:${mm}`
    // 小字只够显示到分钟，完整日期放进 title —— 悬停即可看到
    host.title = `${WEEKDAY_NAMES[now.getDay()]} · ${now.getFullYear()}年${now.getMonth() + 1}月${now.getDate()}日`
  }

  return createTicker(60000, paint)
}
