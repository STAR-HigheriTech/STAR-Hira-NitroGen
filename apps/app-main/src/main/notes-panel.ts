/**
 * 集锦面板的**主进程侧唯一入口**。
 *
 * 面板本身（集锦 / 全部 / 稍后读 / 回收站）住在渲染层，但"打开它"这件事有多个主进程
 * 调用点：快捷键 `panel:notes-collections`、应用菜单「集锦」、应用菜单「把当前页收进集锦」、
 * 网页右键「添加到集锦」、收录/定位动作层。
 *
 * 这些点以前各自写 `'notes-panel'` 字面量，面板 id 一改就多处一起漂移。
 * 现在只有这里知道 id；面板内部的**分段与定位**由 `note:open-view` 载荷驱动
 * （见 plugins/panel-notes.renderer.js），不再借道设置键。
 */

/** 面板 id（与 `panel-notes` 插件 manifest 的 `contributes.panels[0].id` 一致）。 */
const NOTES_PANEL_ID = 'notes-panel'

interface NotesPanelOptions {
  catalog?: { has: (id: string) => boolean } | null
  layout: { showPanel: (id: string) => unknown; togglePanel?: (id: string, options: object) => unknown }
  mode?: 'show' | 'toggle'
}

/**
 * 打开集锦面板。
 *
 * @param {{
 *   catalog?: { has: (id: string) => boolean } | null,
 *   layout: { showPanel: Function, togglePanel?: Function },
 *   mode?: 'show' | 'toggle'
 * }} options
 *   `mode='toggle'`：用户主动开/关（快捷键、菜单项）；`'show'`：必须看得见（收录完成后的回执）。
 * @returns {boolean} 是否已发出打开动作（面板不在目录里 / 端口缺失 → false，静默降级）
 */
function openNotesPanel(options: NotesPanelOptions): boolean {
  const { catalog, layout, mode = 'show' } = options
  if (!layout) return false
  if (catalog && typeof catalog.has === 'function' && !catalog.has(NOTES_PANEL_ID)) return false
  try {
    if (mode === 'toggle' && typeof layout.togglePanel === 'function') {
      layout.togglePanel(NOTES_PANEL_ID, {})
      return true
    }
    if (typeof layout.showPanel === 'function') {
      layout.showPanel(NOTES_PANEL_ID)
      return true
    }
  } catch (_) {}
  return false
}

module.exports = {
  NOTES_PANEL_ID,
  openNotesPanel
}
