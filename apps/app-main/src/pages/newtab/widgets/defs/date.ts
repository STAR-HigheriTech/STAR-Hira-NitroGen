/**
 * 小组件 · 日期
 *
 * 公历日期 + 星期 + 今年进度。全部本地计算，不联网、不依赖任何库，
 * 也没有农历 —— 农历需要一张随年份更新的历表，塞进新标签页不划算。
 */
import { defineWidget } from '../registry.js'
import { WEEKDAY_NAMES } from 'hira://shared/weekday.mjs'
import type { WidgetContext } from '../types.js'

/** 今年第几天（1 起） */
function dayOfYear(d: Date): number {
  const start = new Date(d.getFullYear(), 0, 1)
  return Math.floor((d.getTime() - start.getTime()) / 86400000) + 1
}

function daysInYear(year: number): number {
  return (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0 ? 366 : 365
}

defineWidget({
  id: 'date',
  name: '日期',
  description: '公历日期、星期与今年进度',
  unique: true,
  defaultSize: { w: 7, h: 2 },
  // 下限放到 3 列：窄屏（8 列）由 7 列等比投影得 3.5，取 4 刚好与时间卡（4）并排满行；
  // 若写成 5，窄屏会把两张卡都顶到 5 列，一行放不下、`placeDown` 于是错位。
  minSize: { w: 3, h: 2 },
  maxSize: { w: 16, h: 5 },
  settings: [
    { key: 'showYear', label: '显示年份', type: 'boolean', default: true },
    { key: 'showWeekday', label: '显示星期', type: 'boolean', default: true },
    { key: 'showProgress', label: '显示今年进度', type: 'boolean', default: true }
  ],
  // 通用外观**改档**（见 widgets/appearance.js）：与时间卡同理 ——
  // 大字日期也不需要底座，底色**默认 0%**，可调到 100%。下限放到 0（普通卡片锁 35%）。
  // staleDefault: 100 让老实例（存着旧默认值、从没动过）跟着换成新默认。
  appearance: {
    bgOpacity: { min: 0, max: 100, default: 0, staleDefault: 100 }
  },
  create(ctx: WidgetContext) {
    const cfg = ctx.config
    const root = document.createElement('div')
    root.className = 'wg wg-date'
    // 阈值用**像素**：网格粗细以后改，这里不用跟着重调
    root.dataset.compact = ctx.size.pxW < 320 ? '1' : '0'
    root.innerHTML = `
      <div class="wg-date__head">
        <span class="wg-date__day"></span>
        <span class="wg-date__tail">
          <span class="wg-date__month"></span>
          <span class="wg-date__weekday"></span>
        </span>
      </div>
      <div class="wg-date__progress">
        <div class="wg-date__bar"><i></i></div>
        <span class="wg-date__label"></span>
      </div>`

    const day = root.querySelector<HTMLElement>('.wg-date__day')!
    const month = root.querySelector<HTMLElement>('.wg-date__month')!
    const weekday = root.querySelector<HTMLElement>('.wg-date__weekday')!
    const progress = root.querySelector<HTMLElement>('.wg-date__progress')!
    const bar = root.querySelector<HTMLElement>('.wg-date__bar i')!
    const label = root.querySelector<HTMLElement>('.wg-date__label')!

    function paint() {
      const now = new Date()
      const y = now.getFullYear()
      const total = daysInYear(y)
      const passed = dayOfYear(now)

      day.textContent = String(now.getDate()).padStart(2, '0')
      month.textContent = (cfg.showYear ? y + ' 年 ' : '') + (now.getMonth() + 1) + ' 月'
      weekday.textContent = cfg.showWeekday ? WEEKDAY_NAMES[now.getDay()] || '' : ''
      weekday.hidden = !cfg.showWeekday
      progress.hidden = !cfg.showProgress
      if (cfg.showProgress) {
        const ratio = passed / total
        bar.style.transform = `scaleX(${ratio.toFixed(4)})`
        label.textContent = `今年第 ${passed} 天 · ${(ratio * 100).toFixed(1)}%`
      }
    }

    paint()
    // 跨零点自动刷新（每 30s 校一次，开销可以忽略）
    const timer = window.setInterval(paint, 30000)
    ctx.root.appendChild(root)

    return { destroy: () => window.clearInterval(timer) }
  }
})
