/**
 * accessibility.mjs —— 无障碍设置的**唯一真源**（键名 + 字号档位 + 像素映射）
 *
 * 三处共用：域层缺省值、设置页 options、主进程（`defaultFontSize` 回填 /
 * `setAccessibilitySupportEnabled` 汇总开关）。字号的档位名（small…x-large）
 * 与像素值必须同源 —— 只改一处就会"设置页选大字、网页还是小字"。
 */

/** 设置键名。 */
const ACCESSIBILITY_SETTING_KEYS = Object.freeze({
  captions: 'accessibility.captions',
  highContrast: 'accessibility.high_contrast',
  caretBrowsing: 'accessibility.caret_browsing',
  fontSize: 'accessibility.font_size'
})

/** 「任一开启即启用 Chromium 无障碍支持」的三个开关（汇总判据的唯一清单）。 */
const ACCESSIBILITY_TOGGLE_KEYS = Object.freeze([
  ACCESSIBILITY_SETTING_KEYS.captions,
  ACCESSIBILITY_SETTING_KEYS.highContrast,
  ACCESSIBILITY_SETTING_KEYS.caretBrowsing
])

/** 网页默认字号档位 + 像素值（Chromium `defaultFontSize`）。 */
const FONT_SIZE_PX = Object.freeze({ small: 12, medium: 16, large: 20, 'x-large': 24 })

/** 设置页下拉的 [值, 中文名]；顺序即展示顺序。 */
const FONT_SIZE_OPTIONS = Object.freeze([
  ['small', '小'],
  ['medium', '中'],
  ['large', '大'],
  ['x-large', '特大']
])

/** 缺省字号档位。 */
const DEFAULT_FONT_SIZE = 'medium'

export {
  ACCESSIBILITY_SETTING_KEYS,
  ACCESSIBILITY_TOGGLE_KEYS,
  FONT_SIZE_PX,
  FONT_SIZE_OPTIONS,
  DEFAULT_FONT_SIZE
}
