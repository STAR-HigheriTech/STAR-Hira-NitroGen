/**
 * shell-buttons.mjs —— 外壳按钮列（导航栏 / 工具图标栏）的**设置键名唯一真源**。
 *
 * 两条键的值都是「可见按钮 id 的数组」（rail 另有 `.drawer` 归属字段）：
 *   · 渲染层（app-shell / rail）按它排序与显隐；
 *   · 按钮编辑浮层（buttons-edit-overlay）按它读写；
 *   · 主进程（ipc/buttons-edit）在同一对键上落盘。
 *
 * 手抄一次拼错，表现就是「编辑完按钮顺序不生效」—— 静默、难查，故集中在此。
 */

export const SHELL_BUTTON_SETTING_KEYS = Object.freeze({
  /** 导航栏按钮：可见顺序数组 */
  navbar: 'app.navbar_buttons',
  /** 工具图标栏按钮：可见顺序数组（另有 `.drawer` 归属） */
  rail: 'app.rail_buttons'
})
