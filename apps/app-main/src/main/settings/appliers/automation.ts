import { errorMessage } from './types'
import type { ApplierDependencies, SettingsApplier } from './types'

// @ts-check
/**
 * settings/appliers/automation.js — 「启用鼠标手势」生效器
 *
 * 问题：手势的**识别**发生在每个标签页的 preload（`infra-window/preload/gestures`），
 * 主进程只负责「方向 → 命令」。开关关掉时，主进程确实会丢弃上报，但页面侧照样在
 * 画轨迹、照样吞掉那一次右键菜单 —— 用户的观感就是「这个开关毫无作用」。
 *
 * 本生效器把「当前手势配置」推给每个已订阅的标签页（`automation:gestures-config`）：
 *   · 开关变了 → 页面立刻停手（不画、不吞菜单）；
 *   · 映射表变了 → 页面提示里显示的"这一笔会触发什么"跟着变，不必等下一次导航。
 *
 * 为什么用广播而不是逐 wc.send：preload 会在加载时登记订阅（见 tab-preload 的
 * `on.subscribe`），广播只投给**真正登记过**的 webContents，未注入手势引擎的页面
 * （hira-game:// 等）零开销。启动时的初值仍由 `automation:gesture-map` 拉取。
 *
 * 依赖 {@link ../../../../../packages/shared-types/src/automation.mjs} 的同一套规则，
 * 不在这里重抄"默认映射 / 状态码 → 动作"。
 *
 * @param {{ send?: (route: string, payload?: any) => number }} deps
 */

const {
  DEFAULT_GESTURE_MAP,
  parseGestureMap,
  actionLabel
} = require('@hira-ng/shared-types/src/automation.mjs') as {
  DEFAULT_GESTURE_MAP: Record<string, string>
  parseGestureMap(value: unknown): Record<string, string>
  actionLabel(action: string): string
}

/** 设置键（与 settings/registry.js、main/automation.js 逐字一致）。 */
const KEYS = {
  gestures: 'automation.gestures',
  enabled: 'automation.gestures_enabled'
}

/** 与 automation 控制器同一条布尔归一（非法值按「开」处理）。 */
function isEnabled(v: unknown): boolean {
  return !(v === false || v === 'false' || v === 0 || v === '0')
}

function createAutomationGesturesApplier(deps: ApplierDependencies = {}): SettingsApplier {
  return {
    id: 'automation-gestures',
    keys: [KEYS.enabled, KEYS.gestures],
    apply({ settings }) {
      const send = deps.send
      if (typeof send !== 'function' || !settings || typeof settings.get !== 'function') return false

      const raw = settings.get(KEYS.gestures)
      const gestures = (raw == null || raw === '') ? { ...DEFAULT_GESTURE_MAP } : parseGestureMap(raw)
      /** 与 `automation.getGestureMap()` 完全同形：方向 → { action, label }。 */
      const map: Record<string, { action: string; label: string }> = {}
      for (const dir of Object.keys(gestures)) {
        const action = gestures[dir]
        map[dir] = { action, label: actionLabel(String(action)) }
      }
      try {
        send('automation:gestures-config', { enabled: isEnabled(settings.get(KEYS.enabled)), map })
      } catch (_) {
        return false
      }
      return true
    }
  }
}

export { createAutomationGesturesApplier, KEYS as AUTOMATION_GESTURE_KEYS }
