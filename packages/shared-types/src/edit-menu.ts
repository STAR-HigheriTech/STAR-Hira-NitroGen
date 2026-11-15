/**
 * edit-menu.mjs —— Electron 原生编辑 role 的中文菜单名的**唯一真源**。
 *
 * 三个菜单面共用这几个 role（撤销 / 重做 / 剪切 / 复制 / 粘贴 / 删除 / 全选）：
 *   · 应用菜单「编辑」（`main/app-menu.js`）；
 *   · 网页右键（`infra-window/src/context-menu-model.js`）；
 *   · 地址栏右键（`renderer/app-shell/main.js`）。
 *
 * 三处此前各自写一份 `{ role, label: '撤销' }`：role 是同一个、中文名却有三份，
 * 改一处文案就会在另外两个菜单面留下旧说法。**role 与中文名的对应关系只能在这里**；
 * 菜单面只决定「放哪几项、什么顺序、是否置灰」。
 *
 * 注意：role 项**不写 accelerator** —— Electron 的 role 自带平台正确的默认组合键
 * （macOS / Windows / Linux 各不相同）。本文件也不提供组合键字段，从源头杜绝漂移。
 */

export type EditRole = 'undo' | 'redo' | 'cut' | 'copy' | 'paste' | 'delete' | 'selectAll'

/** @type {Readonly<Record<EditRole, string>>} */
export const EDIT_ROLE_LABELS: Readonly<Record<EditRole, string>> = Object.freeze({
  undo: '撤销',
  redo: '重做',
  cut: '剪切',
  copy: '复制',
  paste: '粘贴',
  delete: '删除',
  selectAll: '全选'
})

/**
 * 生成一个原生 role 菜单项。`extra` 放该菜单面自己的上下文（如 `enabled`），
 * 但**不应**再写 `role` / `label` —— 那两项由本文件决定。
 *
 * @param {EditRole} role
 * @param {Record<string, unknown>} [extra]
 * @returns {Record<string, unknown>}
 */
export function editMenuItem(role: EditRole, extra: Record<string, unknown> = {}): Record<string, unknown> {
  const label = EDIT_ROLE_LABELS[role]
  return { role, ...(label ? { label } : {}), ...(extra || {}) }
}
