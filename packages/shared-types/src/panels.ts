/**
 * panels —— 侧边面板「上次停在哪一段 / 用哪种形态」的设置真源。
 *
 * 为什么放在 shared-types：同一份取值集合有三类消费方 ——
 *   · 分段壳（ui-panel-opentabs / ui-panel-history）按它派生白名单与合法值；
 *   · domain-settings 按它派生默认值（旧值 / 手改文件也会被同一份白名单约束）；
 *   · 设置页（settings/registry）按它渲染下拉。
 * 三处各抄一份必然会漂移（表现：面板记住了某个已不存在的分段，或选中态永远不亮）。
 *
 * 文案与顺序可以各视图自定（分段标签是视图自己的事），但**值集合与默认值只在这里写一次**。
 */

/** 设置键名真源。 */
export const PANELS_SETTING_KEYS = Object.freeze({
  /** 「标签」面板的分段偏好 */
  tabsViewMode: 'panels.tabs_view_mode',
  /** 「已固定」分段的视图形态（列表 / 网格） */
  pinnedViewMode: 'panels.pinned_view_mode'
})

/** 「标签」面板的分段：归档已并入集锦面板，这里只保留标签生命周期本身。 */
export const TABS_VIEW_MODES = Object.freeze(['open', 'playing', 'pinned'])
export const DEFAULT_TABS_VIEW_MODE = 'open'

/** 「历史」面板的分段（归档已随标签语义搬到「标签」面板）。 */
export const HISTORY_VIEW_MODES = Object.freeze(['history', 'recent'])
export const DEFAULT_HISTORY_VIEW_MODE = 'history'

/** 「已固定」分段的两种形态 + 设置页下拉。 */
export const PINNED_VIEW_MODES = Object.freeze(['list', 'grid'])
export const PINNED_VIEW_MODE_OPTIONS = Object.freeze([
  ['list', '列表'],
  ['grid', '网格']
])
export const DEFAULT_PINNED_VIEW_MODE = 'list'
