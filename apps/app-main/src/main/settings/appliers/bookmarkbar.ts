import { errorMessage } from './types'
import type { ApplierDependencies, SettingsApplier } from './types'

// @ts-check
/**
 * appliers/bookmarkbar.js — 书签栏显示策略：遗留布尔值的一次性迁移
 *
 * 历史版本里 `app.bookmarkbar_visible` 是布尔（显示 / 隐藏），升级为三态后
 * 老 profile 里存的仍是 `true` / `false`。**读取侧**已由 shared-types 的
 * normalizeBookmarkbarMode 兼容，但**持久化文件本身**也应当收敛，否则：
 *   · `settings:list` 会把布尔原样发给设置页 —— 下拉的 option.value 是字符串，
 *     匹配不上（表现为"选中项不是用户当时选的那档"）；
 *   · 设置导出 / 迁移会带出两种表示法，日后每加一个消费方都要再兼容一次。
 *
 * 迁移放在 applier 而非 domain：domain 是「唯一数据源」，只管存取，不认识
 * 某个键的语义；「这个键的取值该怎么规范」属于本层（主进程生效逻辑）。
 *
 * 幂等：`settingsService.set` 在值未变化时不写盘、不广播（见 domain-settings#set），
 * 因此已规范的值不会产生额外 IO，也不会形成回环。
 */

const {
  BOOKMARKBAR_SETTING_KEY,
  normalizeBookmarkbarMode
} = require('@hira-ng/shared-types/src/bookmarkbar.mjs')

/** @returns {{ id:string, keys:string[], apply:Function }} */
function createBookmarkbarModeApplier(_deps: ApplierDependencies = {}): SettingsApplier {
  return {
    id: 'app-bookmarkbar-mode',
    keys: [BOOKMARKBAR_SETTING_KEY],
    apply({ settings }) {
      if (!settings || typeof settings.get !== 'function' || typeof settings.set !== 'function') return
      const raw = settings.get(BOOKMARKBAR_SETTING_KEY)
      const mode = normalizeBookmarkbarMode(raw)
      if (raw !== mode) settings.set(BOOKMARKBAR_SETTING_KEY, mode)
    }
  }
}

export { createBookmarkbarModeApplier }