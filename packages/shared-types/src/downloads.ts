/**
 * downloads —— 下载相关的**设置真源**：键名 / 缺省值 / 取值域 / 危险文件策略。
 *
 * 消费方是四个互不相识的地方 —— 域层默认值与数值夹界（domain-settings）、
 * 设置页字段表（settings/registry）、生效器（settings/appliers/downloads）与
 * 下载运行时（main/download-manager）。
 * 各写一遍字符串的后果很具体：设置页改叫 `reject`、运行时判的是 `deny`，
 * 于是「自动拒绝危险文件」这个开关永远不生效，且没有任何报错；
 * 键名拼错同理 —— 用户改了设置却毫无反应。
 */

export const DOWNLOAD_SETTING_KEYS = Object.freeze({
  /** 每次下载是否弹「保存位置」对话框 */
  askWhereToSave: 'downloads.ask_where_to_save',
  /** 默认下载目录（空 = 系统下载目录） */
  defaultLocation: 'downloads.default_location',
  /** 完成后是否从列表移除记录（不删文件） */
  clearOnComplete: 'downloads.clear_on_complete',
  /** 完成通知 */
  showNotification: 'downloads.show_notification',
  /** 完成后自动打开 */
  openWhenDone: 'downloads.open_when_done',
  /** 多线程下载总开关 */
  multiThreaded: 'downloads.multi_threaded_enabled',
  /** 最大并发连接数（见 DOWNLOAD_CONNECTION_LIMITS） */
  maxConnections: 'downloads.max_connections',
  /** 全局限速：0 = 不限速；单位字节/秒 */
  rateLimit: 'downloads.rate_limit_bytes_per_sec',
  /** 危险文件策略（见 SAFE_BROWSING_*） */
  safeBrowsing: 'downloads.safe_browsing'
})

/** 多线程并发连接数的取值域 —— 域层夹界与设置页字段提示共用一份。 */
export const DOWNLOAD_CONNECTION_LIMITS = Object.freeze({ min: 1, max: 16 })

/** 限速上限（1GB/s）—— 纯兜底，防手滑填出天文数字。 */
export const DOWNLOAD_RATE_LIMIT_MAX = 1024 * 1024 * 1024

/**
 * 各项缺省值（键 = 真实设置键）。
 *
 * 域层默认值与设置页字段的 `default`（设置读不到时的兜底显示）都从这里取，
 * 不各写一份 —— 否则「设置的默认」与「页面显示的默认」会慢慢分家。
 */
export const DEFAULT_DOWNLOAD_SETTINGS = Object.freeze({
  [DOWNLOAD_SETTING_KEYS.askWhereToSave]: false,
  [DOWNLOAD_SETTING_KEYS.defaultLocation]: '',
  [DOWNLOAD_SETTING_KEYS.clearOnComplete]: false,
  [DOWNLOAD_SETTING_KEYS.showNotification]: true,
  [DOWNLOAD_SETTING_KEYS.openWhenDone]: false,
  [DOWNLOAD_SETTING_KEYS.multiThreaded]: true,
  [DOWNLOAD_SETTING_KEYS.maxConnections]: 8,
  [DOWNLOAD_SETTING_KEYS.rateLimit]: 0,
  [DOWNLOAD_SETTING_KEYS.safeBrowsing]: 'prompt'
})

/** 三档：不检查 / 仅标记 / 自动拒绝（顺序即展示顺序）。 */
export const SAFE_BROWSING_MODES = Object.freeze(['off', 'prompt', 'reject'])
export type SafeBrowsingMode = (typeof SAFE_BROWSING_MODES)[number]
export const SAFE_BROWSING_OPTIONS = Object.freeze([
  ['off', '不检查'],
  ['prompt', '仅标记（不拦截下载）'],
  ['reject', '自动拒绝危险文件']
])
export const DEFAULT_SAFE_BROWSING = DEFAULT_DOWNLOAD_SETTINGS[DOWNLOAD_SETTING_KEYS.safeBrowsing]

/**
 * 归一化任意历史 / 手改取值到三档之一（非法值回落缺省）。
 * 旧版本曾把该键当布尔（true = 询问），`true` / `false` 在这里兼容掉。
 * @param {unknown} value
 * @returns {'off'|'prompt'|'reject'}
 */
export function normalizeSafeBrowsing(value: unknown): SafeBrowsingMode {
  if (value === true) return 'prompt'
  if (value === false) return 'off'
  return typeof value === 'string' && (SAFE_BROWSING_MODES as readonly string[]).includes(value)
    ? value as SafeBrowsingMode
    : DEFAULT_SAFE_BROWSING
}
