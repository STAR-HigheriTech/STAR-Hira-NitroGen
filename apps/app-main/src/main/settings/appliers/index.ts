/**
 * settings/appliers/index.ts — 内置"设置生效器"聚合
 *
 * 每个 applier 回答同一个问题：**这个设置项变了，主进程要做什么才能真正生效？**
 * 它们只通过 settings/sync 的 registerApplier 挂载，sync 不认识任何一项。
 *
 * 新增一项设置的支持 = 在本目录加一个文件 + 在下方 registerBuiltinAppliers 里挂上，
 * 不动其它文件。想让某个设置项失效 = unregisterApplier(id)。
 */

import type { ApplierDependencies, ApplierSyncPort } from './types'

const { createSearchApplier } = require('./search')
const { createSearchHistoryApplier } = require('./search-history')
const { createDoNotTrackApplier } = require('./privacy')
const { createDownloadRateApplier } = require('./downloads')
const { createSidebarPositionApplier, createSideColumnPositionApplier, createPanelWidthApplier, createRailWidthApplier, createRailPinnedApplier, createWebSidebarApplier, createWebSidebarPositionApplier } = require('./layout')
const { createContentBlockingApplier } = require('./blocking')
const { createBackgroundThrottleApplier } = require('./performance')
const { createTabsRestoreSessionApplier, createTabSyncApplier } = require('./tabs')
const { createThemeApplier } = require('./theme')
const { createProxyApplier } = require('./proxy')
const { createSecureDnsApplier } = require('./secure-dns')
const { createUserAgentApplier } = require('./user-agent')
const { createHttpsOnlyApplier } = require('./https-only')
const { createBookmarkbarModeApplier } = require('./bookmarkbar')
const { createSpellcheckApplier } = require('./spellcheck')
const { createFingerprintApplier } = require('./fingerprint')
const { createAutomationGesturesApplier } = require('./automation')

/**
 * 注册全部内置 applier。
 * @param {{ registerApplier:Function }} sync
 * @param {Object} deps
 */
export function registerBuiltinAppliers(sync: ApplierSyncPort, deps: ApplierDependencies = {}): void {
  sync.registerApplier(createSearchApplier(deps))
  sync.registerApplier(createSearchHistoryApplier(deps))
  sync.registerApplier(createDoNotTrackApplier(deps))
  sync.registerApplier(createDownloadRateApplier(deps))
  sync.registerApplier(createSidebarPositionApplier(deps))
  // 垂直标签侧栏（标签列那一列）自己那一侧 —— 与上一条相互独立，两段可各靠一边
  sync.registerApplier(createSideColumnPositionApplier(deps))
  // 两侧面板位各自的宽度记忆（用户拖拽调宽 → 落设置 → 启动/变更时灌回布局）
  sync.registerApplier(createPanelWidthApplier(deps))
  // 可展开 rail：恢复用户最近一次宽度 / 展开偏好（面板自动收起不写回这里）
  sync.registerApplier(createRailWidthApplier(deps))
  sync.registerApplier(createRailPinnedApplier(deps))
  // 独立侧栏（Web Sidebar）的宽度记忆（同上面那条，但它属于另一套系统）
  sync.registerApplier(createWebSidebarApplier(deps))
  // 独立侧栏（Web Sidebar）的位置 —— 纵向轨道上的**第三段**，不跟随 rail / 标签侧栏
  sync.registerApplier(createWebSidebarPositionApplier(deps))
  // ⚠ 主题**不在这里**重算配色：主题的"应用"（themeManager / nativeTheme / 原生表面）
  //   全部由主题域的发布链承担（`theme-runtime` 的 `publish()`）。
  //   本 applier 只负责**通知它去重发布一次** —— 因为走 `settings.set('app.theme', …)`
  //   的那条路（设置页 / 空间级写入）不会经过 `themeService.setActive`，
  //   没人告诉 theme-runtime "该重发了"，表现是"颜色变了但标签栏底还是旧色"。
  sync.registerApplier(createThemeApplier(deps))
  // 网络代理（I4）：四个 network.proxy_* 键 → 一次 session.setProxy（含将来创建的会话）
  sync.registerApplier(createProxyApplier(deps))
  sync.registerApplier(createSecureDnsApplier(deps))
  // 浏览器标识（UA）：预设 / 自定义 → 全局兜底 + 全部会话（见 appliers/user-agent.js）
  sync.registerApplier(createUserAgentApplier(deps))
  // 仅 HTTPS（I2）：导航层把 http 主框架升级为 https（**刻意不用 webRequest**，见 applier 文件头）
  sync.registerApplier(createHttpsOnlyApplier(deps))
  sync.registerApplier(createContentBlockingApplier(deps))
  sync.registerApplier(createBackgroundThrottleApplier(deps))
  // tabs.restore_session 是 app.startup_mode 的写入别名（消除双真源）
  sync.registerApplier(createTabsRestoreSessionApplier(deps))
  // 跨窗口标签同步（J15/A5）：只在"关掉"时收尾（清各窗口的截图占位 + 复位记账）。
  sync.registerApplier(createTabSyncApplier(deps))
  // 书签栏：把遗留的布尔值收敛成三态字符串（一次性迁移，幂等）
  sync.registerApplier(createBookmarkbarModeApplier(deps))
  // 拼写检查：总开关 + 词典语言 → 当前 profile 的会话（含将来创建的会话）
  sync.registerApplier(createSpellcheckApplier(deps))
  // 浏览器指纹伪装（按空间）：主世界注入 navigator/Canvas/WebGL/Audio 钩子
  sync.registerApplier(createFingerprintApplier(deps))
  // 鼠标手势：把「开关 + 映射表」推给每个标签页的 preload 引擎。
  // 只靠主进程丢上报会让「启用鼠标手势」看起来完全无效（页面照样画轨迹、照样吞右键菜单）。
  sync.registerApplier(createAutomationGesturesApplier(deps))
}

export {
  createSearchApplier,
  createSearchHistoryApplier,
  createDoNotTrackApplier,
  createDownloadRateApplier,
  createSidebarPositionApplier,
  createSideColumnPositionApplier,
  createPanelWidthApplier,
  createRailWidthApplier,
  createRailPinnedApplier,
  createWebSidebarApplier,
  createWebSidebarPositionApplier,
  createContentBlockingApplier,
  createBackgroundThrottleApplier,
  createBookmarkbarModeApplier,
  createSpellcheckApplier,
  createFingerprintApplier,
  createAutomationGesturesApplier,
  createSecureDnsApplier
}
