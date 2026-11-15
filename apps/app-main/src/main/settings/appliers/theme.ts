import { errorMessage } from './types'
import type { ApplierDependencies, SettingsApplier } from './types'

// @ts-check
/**
 * settings/appliers/theme.js — 「主题重发布」生效器（**缺失的一环**）
 *
 * ── 为什么需要它 ──────────────────────────────────────────────────
 * `app.theme` 是主题的唯一持久化（值 = 主题 id）。有**两条**写它的路：
 *   1. 主题页（hira://themes）→ `theme:set` → `themeService.setActive()` → 发 `active` 事件
 *      → `theme-runtime` 订阅后 `publish()`（主进程原生表面 + 全局广播都跟着走）；
 *   2. 设置页 / **空间级写入** → 直接 `settings.set('app.theme', …)`。
 * 第二条路**没有一个环节通知 theme-runtime** —— 于是"渲染层颜色变了，但
 * 标签栏底 / 窗口底那圈原生表面还是旧色"（nativeSurface 是进程级的，只有
 * `themeRuntime.publish()` 会改）。空间级写入（B2/J13）走的正是第二条，
 * 所以这个洞必须先补上，否则"切空间换主题"会半生效。
 *
 * ── 为什么是 applier 而不是让 settings 去认识主题 ──────────────────
 * 这正是 applier 链的用途：**"这个设置变了，主进程要做什么"** —— 让设置域去
 * `require` 主题域会把两个领域绑死，而 applier 只依赖一个注入的 getter。
 *
 * 幂等由 `themeRuntime.publish()` 自己保证（同主题载荷指纹相同 → 直接返回，
 * 不重算、不重广播），所以这里无条件调用即可。
 *
 * @param {{ getThemeRuntime?: () => any }} deps
 */
const { THEME_SETTING_KEYS } = require('@hira-ng/shared-types/src/theme.mjs')

function createThemeApplier(deps: ApplierDependencies = {}): SettingsApplier {
  return {
    id: 'theme-republish',
    keys: [THEME_SETTING_KEYS.active],
    apply() {
      const runtime = typeof deps.getThemeRuntime === 'function' ? deps.getThemeRuntime() : null
      if (!runtime || typeof runtime.publish !== 'function') return false
      try {
        Promise.resolve(runtime.publish()).catch(() => {})
      } catch (_) {
        return false
      }
      return true
    }
  }
}

export { createThemeApplier }
