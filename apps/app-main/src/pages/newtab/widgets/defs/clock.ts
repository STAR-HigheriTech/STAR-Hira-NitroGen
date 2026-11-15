/**
 * 小组件 · 时间
 *
 * 只做一件事：把当前时间大字显示出来。
 * 定时逻辑走 `lib/ticker.js`（对齐到整周期唤醒）—— 与页面右上角那个时间**共用一份**，
 * 两者只差一个周期参数，没必要各写一套。
 */
import { defineWidget } from '../registry.js'
import { createTicker } from '../../lib/ticker.js'
import { WEEKDAY_NAMES_SHORT } from 'hira://shared/weekday.mjs'
import type { WidgetContext } from '../types.js'

defineWidget({
  id: 'clock',
  name: '时间',
  description: '大字时钟，可切 12/24 小时制',
  unique: true,
  defaultSize: { w: 7, h: 2 },
  minSize: { w: 3, h: 2 },
  maxSize: { w: 11, h: 5 },
  settings: [
    { key: 'hour12', label: '12 小时制', type: 'boolean', default: false },
    { key: 'showSeconds', label: '显示秒', type: 'boolean', default: false },
    { key: 'showPeriod', label: '显示上午/下午', type: 'boolean', default: true },
    { key: 'showWeekday', label: '显示星期', type: 'boolean', default: true }
  ],
  // 通用外观**改档**（见 widgets/appearance.js）：大字时钟是"一串数字浮在壁纸上"，
  // 它不需要底座 —— 所以底色**默认 0%**（整块底完全不见，只有字），
  // 想铺一层实底也能一路调到 100%。下限放到 0（普通卡片是锁 35%）。
  // staleDefault: 100 让老实例（配置里存着旧默认值、用户从没动过）跟着换成新默认；
  // 用户手动设过的其它值一律保留。
  appearance: {
    bgOpacity: { min: 0, max: 100, default: 0, staleDefault: 100 }
  },
  create(ctx: WidgetContext) {
    const cfg = ctx.config
    const root = document.createElement('div')
    root.className = 'wg wg-clock'
    // 阈值用**像素**（不是网格格数）：网格粗细以后改，这里不用跟着重调。
    // 两行高（116px）是默认尺寸，星期那行仍要显示 —— 阈值必须低于它。
    root.dataset.compact = ctx.size.pxW < 300 || ctx.size.pxH < 100 ? '1' : '0'
    root.innerHTML = `
      <div class="wg-clock__time">
        <span class="wg-clock__hm"></span>
        <span class="wg-clock__sec"></span>
      </div>
      <div class="wg-clock__meta">
        <span class="wg-clock__period"></span>
        <span class="wg-clock__weekday"></span>
      </div>`

    const hm = root.querySelector<HTMLElement>('.wg-clock__hm')!
    const sec = root.querySelector<HTMLElement>('.wg-clock__sec')!
    const period = root.querySelector<HTMLElement>('.wg-clock__period')!
    const weekday = root.querySelector<HTMLElement>('.wg-clock__weekday')!

    function paint() {
      const now = new Date()
      const h24 = now.getHours()
      const h = cfg.hour12 ? h24 % 12 || 12 : h24
      hm.textContent = String(h).padStart(2, '0') + ':' + String(now.getMinutes()).padStart(2, '0')
      sec.textContent = cfg.showSeconds ? ':' + String(now.getSeconds()).padStart(2, '0') : ''
      sec.hidden = !cfg.showSeconds
      period.textContent = cfg.hour12 && cfg.showPeriod ? (h24 < 12 ? '上午' : '下午') : ''
      period.hidden = !(cfg.hour12 && cfg.showPeriod)
      weekday.textContent = cfg.showWeekday ? WEEKDAY_NAMES_SHORT[now.getDay()] || '' : ''
      weekday.hidden = !cfg.showWeekday
    }

    // 对齐到下一个整秒唤醒 + 从休眠恢复立刻校正，逻辑在 lib/ticker.js（与右上角那个时间共用）
    const stop = createTicker(1000, paint)
    ctx.root.appendChild(root)

    return { destroy: stop }
  }
})
