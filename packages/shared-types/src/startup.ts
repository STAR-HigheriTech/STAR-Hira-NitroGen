/**
 * startup.mjs —— 「启动行为 / 主页 / 新标签页」设置的**唯一真源**
 *
 * ── 为什么必须是一份 ──────────────────────────────────────────────
 * 这几个键被四个层同时读写：
 *   1. 域层缺省值（`domain-settings#DEFAULT_SETTINGS`）；
 *   2. 设置页（options / `when` 联动）；
 *   3. 主进程启动编排（`main.js` 按模式选地址、恢复会话）；
 *   4. 渲染层（app-shell 重判书签栏）与首次引导页（写同一个键）。
 * 键名或取值集合任意一处手抄错一个字，就是"设置页改了、启动照旧"这类静默失配。
 *
 * 职责边界：本模块只声明**键名 / 取值集合 / 缺省值**。
 * 中文文案可由各视图自定（引导页的语气与设置页不同），但**值**必须来自这里。
 */

/** 设置键名。 */
const STARTUP_SETTING_KEYS = Object.freeze({
  /** 启动时打开什么：blank / home / custom / last_session。 */
  mode: 'app.startup_mode',
  /** 主页 / 新标签页模式：newtab / blank / custom。 */
  homeMode: 'app.home_mode',
  /** `homeMode === 'custom'` 时用的地址。 */
  homeUrl: 'app.home_url',
  /** `mode === 'custom'` 时用的启动页地址。 */
  customPage: 'app.startup_page'
})

/** 启动行为四态（顺序即设置页顺序）。 */
const STARTUP_MODES = Object.freeze(['blank', 'home', 'custom', 'last_session'])

/** 缺省启动行为：首次启动直接进入快速拨号页。 */
const DEFAULT_STARTUP_MODE = 'home'

/** 主页 / 新标签页模式三态。 */
const HOME_MODES = Object.freeze(['newtab', 'blank', 'custom'])

/** 缺省主页模式。 */
const DEFAULT_HOME_MODE = 'newtab'

/** 缺省自定义主页地址（首次启动没有用户数据时的唯一默认值）。 */
const DEFAULT_HOME_URL = 'https://www.bing.com'

export {
  STARTUP_SETTING_KEYS,
  STARTUP_MODES,
  DEFAULT_STARTUP_MODE,
  HOME_MODES,
  DEFAULT_HOME_MODE,
  DEFAULT_HOME_URL
}
