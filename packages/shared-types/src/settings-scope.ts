/**
 * 设置**作用域**的单一事实源（PART16 §3.2 / §5 步骤 6 / §10）。
 *
 * ── 为什么要有这个文件 ─────────────────────────────────────────────
 * L2「完全独立」把设置分成两类：
 *   · **按 profile**：其余一切（主题 / UA / 代理 / 启动页 / 隐私 / 下载 / 语言…）
 *     —— 存 `profiles/<id>/settings.json`；
 *   · **全局**：插件（系统本身 + 启停状态）与**界面外观布局**
 *     —— 存 `<userData>/settings.global.json`，跨 profile 共享。
 * 「哪些键算全局」必须**只有一处**答案：路由（domain-settings）、迁移
 * （settings 拆文件）、启动期读取都引它。散成两处必然漂移 ——
 * 那正是本仓库一贯要避免的「这里一个规则、那里一个变化」。
 *
 * ── 为什么布局是全局而不是按 profile ─────────────────────────────
 * 布局（栏位 / 侧栏宽度 / 深色沉浸）描述的是**这台机器、这块屏怎么摆**，
 * 不是"这个用户是谁"。同一个人在同一个屏幕上切 profile 时，界面不该自己重排。
 * 用户若想让它按 profile 独立：把本文件的对应项移出即可（§10 的"一处可翻转"）。
 *
 * ── 插件为什么是全局 ─────────────────────────────────────────────
 * 插件系统是**进程级单例**，且一个插件常混有"该隔离的"（面板 / 主题）与
 * "无法隔离的"（全局快捷键 / 托盘 / 资源目录）；隔离的最小单位应是**能力面**而非插件。
 * 详见 `apps/app-main/src/main/plugin-state-store.js` 的论证。
 */

import { LAYOUT_SETTING_KEYS, LAYOUT_SETTING_KEY_LIST } from './layout.js'
// 书签栏显隐键名的真源（与主进程 / 渲染层共用一份）。
import { BOOKMARKBAR_SETTING_KEY } from './bookmarkbar.js'
// OOBE 引导完成态键名的真源（必须全局：换 profile 不该重新引导）。
import { ONBOARDING_SETTING_KEY } from './onboarding.js'
// 启动期 Chromium 开关键名的真源（app/preboot.js 与域层默认值共用一份）。
import { PERFORMANCE_SETTING_KEYS } from './performance.js'
// Secure DNS 由 Chromium 的主机解析器统一生效，按机器共享，不能随 profile 漂移。
import { SECURE_DNS_SETTING_KEYS } from './secure-dns.js'

/** 全局设置文件的文件名（`<userData>/` 下）。 */
export const GLOBAL_SETTINGS_FILE = 'settings.global.json'

/** 迁移前那份"安装基线"设置文件；迁移后改名为此，仅作备份保留。 */
export const LEGACY_BASELINE_FILE = 'settings.json'
export const LEGACY_BASELINE_BACKUP = 'settings.json.pre-l2'

/**
 * 前缀式全局键：以这些前缀开头的键一律全局。
 * 插件状态（`plugins.disabled` / `plugins.autoDisabled` / `plugins.grantedPermissions` …）
 * 全部落在 `plugins.` 之下，用前缀比逐条列举更稳（新增一个插件状态键不必改这里）。
 */
export const GLOBAL_KEY_PREFIXES = Object.freeze(['plugins.'])

/**
 * 逐条列出的全局键：布局表之外的"按机器/屏幕"偏好 + 启动期必须早读的开关。
 *
 * ⚠ `LAYOUT_SETTING_KEY_LIST` **刻意不含** 这几项（它服务于"渲染层订阅后重摆"，
 *   而下面这些要么建窗期才读、要么与布局同族但不参与重摆），因此在此补齐。
 */
export const GLOBAL_EXPLICIT_KEYS = Object.freeze([
  // 窗口控制按钮样式：建窗期决定（Windows 上 WCO 无运行时开关）
  LAYOUT_SETTING_KEYS.windowControlsStyle,
  // 工具图标栏（rail）+ 侧边面板所在侧
  LAYOUT_SETTING_KEYS.toolSidebarPosition,
  // rail 的两个起始边（横向左/右起、纵向上/下起）—— 与位置同族，属"这台机器上的布局"
  LAYOUT_SETTING_KEYS.toolRailHorizontalAlign,
  LAYOUT_SETTING_KEYS.toolRailVerticalAlign,
  LAYOUT_SETTING_KEYS.toolRailPinned,
  // 书签栏显隐：属"界面布局"（这台机器上要不要占那一条）
  BOOKMARKBAR_SETTING_KEY,
  /**
   * OOBE 引导完成版本号。**必须全局**：它回答的是"这台机器上的这份安装引导过没有"，
   * 而不是"当前 profile 引导过没有" —— 放进 profile 会让每次新建/切换档案都重来一遍。
   * 写读都经 profileOverlay 的 isGlobal 分支落到 settings.global.json，退出 flush 已覆盖。
   */
  ONBOARDING_SETTING_KEY,
  SECURE_DNS_SETTING_KEYS.mode,
  SECURE_DNS_SETTING_KEYS.provider,
  SECURE_DNS_SETTING_KEYS.custom
])

/**
 * 启动期（app ready 之前）就要读的键 —— 它们必须住在全局文件里，
 * 因为"当前 profile"要到能读 DB 之后才知道（§4.5 的两难）。
 */
export const BOOT_SETTING_KEYS = Object.freeze([
  PERFORMANCE_SETTING_KEYS.hardwareAcceleration,
  PERFORMANCE_SETTING_KEYS.smoothScrolling
])

/** 全部全局设置键的扁平列表（含按前缀命中的那些不在此列，由 isGlobalSettingKey 判定）。 */
export const GLOBAL_SETTING_KEYS = Object.freeze([
  ...LAYOUT_SETTING_KEY_LIST,
  ...GLOBAL_EXPLICIT_KEYS,
  ...BOOT_SETTING_KEYS
])

/**
 * 某个设置键是否全局（唯一判据，勿在别处重写）。
 * @param {unknown} key
 * @returns {boolean}
 */
export function isGlobalSettingKey(key: unknown): boolean {
  const k = String(key == null ? '' : key)
  if (!k) return false
  for (const prefix of GLOBAL_KEY_PREFIXES) {
    if (k.startsWith(prefix)) return true
  }
  return GLOBAL_SETTING_KEYS.indexOf(k) !== -1
}
