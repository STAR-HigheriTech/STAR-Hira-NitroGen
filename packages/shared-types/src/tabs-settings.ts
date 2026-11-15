/**
 * tabs-settings.mjs —— 标签页「行为」设置的**键名 / 缺省值唯一真源**。
 *
 * 这六个键分散在启动流程（restore_session 写穿到 app.startup_mode）、
 * 新建标签的 IPC（open_after_current / reuse_existing_tab）、关标签确认弹窗
 * （confirm_close_multiple）、标签运行单元（auto_picture_in_picture）与跨窗口
 * 同步引擎（sync_across_windows）里，另外还要在设置页字段表与域层默认值各出现
 * 一次。键名写错的表现是「设置改了、行为毫无变化」且不报任何错，所以必须同源。
 *
 * 注意区分：休眠/省电见 tab-sleep.mjs，归档见 tabs-retention.mjs ——
 * 那两个模块管的是内存策略，本模块只管交互行为。
 */

export const TABS_SETTING_KEYS = Object.freeze({
  /** 启动时恢复上次会话（写穿到 app.startup_mode） */
  restoreSession: 'tabs.restore_session',
  /** 新标签紧跟在当前标签之后 */
  openAfterCurrent: 'tabs.open_after_current',
  /** 重复网址切到已打开的同空间标签 */
  reuseExistingTab: 'tabs.reuse_existing_tab',
  /** 关闭多个标签前弹确认 */
  confirmCloseMultiple: 'tabs.confirm_close_multiple',
  /** 标签切到后台时自动进入系统画中画 */
  autoPictureInPicture: 'tabs.auto_picture_in_picture',
  /** 跨窗口标签同步（把正在看的标签在窗口间迁移） */
  syncAcrossWindows: 'tabs.sync_across_windows'
})

/** 六项缺省值（键 = 真实设置键）—— 域层默认值与设置页兜底显示共用。 */
export const DEFAULT_TABS_SETTINGS = Object.freeze({
  [TABS_SETTING_KEYS.restoreSession]: true,
  [TABS_SETTING_KEYS.openAfterCurrent]: true,
  [TABS_SETTING_KEYS.reuseExistingTab]: true,
  [TABS_SETTING_KEYS.confirmCloseMultiple]: false,
  [TABS_SETTING_KEYS.autoPictureInPicture]: false,
  [TABS_SETTING_KEYS.syncAcrossWindows]: false
})
