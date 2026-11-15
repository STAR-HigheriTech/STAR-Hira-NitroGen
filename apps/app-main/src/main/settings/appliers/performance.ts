import { errorMessage } from './types'
import type { ApplierDependencies, SettingsApplier } from './types'
import type { WebContents } from 'electron'

// @ts-check
/**
 * settings/appliers/performance.js — 性能相关生效器
 *
 * performance.cpu_throttle_background：控制**后台（非活动）标签**是否降低
 * 定时器 / 渲染频率。Chromium 默认开启后台节流；这里把开关推给每一个标签页的
 * webContents（`webContents.setBackgroundThrottling(allowed)`），并订阅
 * tabManager 的 `tab:webcontents-ready`，让**之后新建的标签**也带上同一设置 ——
 * 否则「关闭节流」只会作用在改动那一刻已存在的标签上，用户新建标签后行为不一致。
 *
 * 语义映射：设置项 true = 允许后台节流（省电省 CPU，Chromium 默认）；
 *          false = 后台标签全速运行（禁止节流）。
 *
 * N12 省电模式（`tabs.energy_saver`）也挂在本生效器上：它开启时**强制**允许节流 —
 * 即使 `cpu_throttle_background` 被关掉（用户想全速跑后台）也压回节流态，这是"省电"
 * 的语义所在（宁可牺牲后台实时性换续航）。两个键共用一套 webContents 遍历与订阅，
 * 不必再开第二个生效器。
 *
 * 安全降级：端口缺失（无 tabManager / 无 setBackgroundThrottling）或任一
 * webContents 已销毁 / 抛错时静默跳过，绝不让一次设置变更打断主进程。
 *
 * @param {{ tabManager?: any }} deps
 */
// 省电模式键名的唯一真源（与设置页 / 域层默认值 / 休眠定时器同源）。
const { TAB_SLEEP_SETTING_KEYS } = require('@hira-ng/shared-types/src/tab-sleep.mjs')
// 性能设置键名的唯一真源（与本文件、preboot、设置页字段表同源）。
const { PERFORMANCE_SETTING_KEYS } = require('@hira-ng/shared-types/src/performance.mjs')

function createBackgroundThrottleApplier(deps: ApplierDependencies = {}): SettingsApplier {
  /** 最近一次应用的值；null 表示尚未应用过（新标签事件先到也不动作） */
  let current: boolean | null = null
  let subscribed = false

  /** 当前存活的标签页 webContents 列表（遍历失败则返回空数组，绝不抛）。 */
  function tabWebContentsList(): WebContents[] {
    const tm = deps.tabManager
    const out: WebContents[] = []
    if (!tm || typeof tm.list !== 'function' || typeof tm.getWebContents !== 'function') return out
    try {
      for (const t of tm.list()) {
        const wc = tm.getWebContents(t.tabId)
        if (!wc) continue
        if (typeof wc.isDestroyed === 'function' && wc.isDestroyed()) continue
        out.push(wc)
      }
    } catch (_) {}
    return out
  }

  /** 把节流策略应用到单个 webContents（不支持 / 已销毁则跳过）。 */
  function applyTo(wc: WebContents | null | undefined, allowed: boolean): void {
    if (!wc || typeof wc.setBackgroundThrottling !== 'function') return
    try { wc.setBackgroundThrottling(allowed) } catch (_) {}
  }

  /** 只订阅一次：新标签创建后补一次当前值，保证与既有标签一致。 */
  function ensureSubscribed() {
    if (subscribed) return
    const tm = deps.tabManager
    if (!tm || typeof tm.on !== 'function') return
    subscribed = true
    try {
      tm.on('tab:webcontents-ready', ({ tabId, webContents }) => {
        if (current === null) return
        // 代际守卫：`tab:webcontents-ready` 是**每个新建 webContents** 发一次，
        // 但休眠唤醒 / 跨窗口迁移后同一 tabId 会换成新的 webContents。
        // 若此时该 tabId 已经不是这条 wc（或者标签已被关掉），说明这是条过期事件 ——
        // 绝不对旧对象下设置（旧对象可能已销毁，setBackgroundThrottling 会抛）。
        if (typeof tm.getWebContents === 'function') {
          let live = null
          try { live = tm.getWebContents(tabId) } catch (_) { live = null }
          if (live !== webContents) return
        }
        applyTo(webContents, current)
      })
    } catch (_) {}
  }

  return {
    id: 'performance-background-throttling',
    keys: [PERFORMANCE_SETTING_KEYS.cpuThrottleBackground, TAB_SLEEP_SETTING_KEYS.energySaver],
    apply({ value, settings }) {
      // 省电模式优先：开启即强制节流，忽略 cpu_throttle_background。
      const energySaver = settings.get(TAB_SLEEP_SETTING_KEYS.energySaver) === true
      const raw = value === undefined ? settings.get(PERFORMANCE_SETTING_KEYS.cpuThrottleBackground) : value
      const allowed = energySaver ? true : raw !== false // 缺省/非法值一律按「允许节流」处理
      current = allowed
      ensureSubscribed()
      for (const wc of tabWebContentsList()) applyTo(wc, allowed)
      return true
    }
  }
}

export { createBackgroundThrottleApplier }
