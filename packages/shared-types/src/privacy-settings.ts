/**
 * privacy-settings.mjs —— 隐私 / 安全设置的**键名 / 缺省值唯一真源**。
 *
 * 这批键的消费点分得很散，键名写错一次的表现同样是「设置改了没反应」且不报错：
 *   · 拦截广告 / 追踪器 —— 广告拦截生效器 + 浏览器会话初始化；
 *   · 退出时逐项清除 —— 退出清理流程（历史 / 下载 / 缓存 / Cookie / 站点数据）；
 *   · 请勿跟踪 —— DNT 生效器（给每个请求挂头）；
 *   · 保存密码 / 表单自动填充 —— 密码 IPC 与自动填充链路；
 *   · 仅 HTTPS —— 导航升级（判据在 https-only.mjs，键名复用那里的常量）；
 *   · 支付卡 / 地址保管库 —— form-fill 服务读写同一项。
 *
 * 因此键名与缺省值只写这一份，域层默认值与设置页兜底显示都从这里取。
 */

import { HTTPS_ONLY_SETTING_KEY } from './https-only.js'

export const PRIVACY_SETTING_KEYS = Object.freeze({
  /** 拦截追踪器 */
  blockTrackers: 'privacy.block_trackers',
  /** 拦截广告 */
  blockAds: 'privacy.block_ads',
  /** 退出时清除历史记录 */
  clearHistoryOnExit: 'privacy.clear_history_on_exit',
  /** 退出时清除下载记录 */
  clearDownloadsOnExit: 'privacy.clear_downloads_on_exit',
  /** 退出时清除缓存 */
  clearCacheOnExit: 'privacy.clear_cache_on_exit',
  /** 退出时清除 Cookie */
  clearCookiesOnExit: 'privacy.clear_cookies_on_exit',
  /** 退出时清除站点数据（localStorage 等） */
  clearSiteDataOnExit: 'privacy.clear_site_data_on_exit',
  /** 发送「请勿跟踪」请求头 */
  doNotTrack: 'privacy.do_not_track',
  /** 询问是否保存密码 */
  passwordSavePrompt: 'privacy.password_save_prompt',
  /** 表单自动填充 */
  formAutofill: 'privacy.form_autofill',
  /** 仅 HTTPS（判据与升级换算见 https-only.mjs，键名同源） */
  httpsOnly: HTTPS_ONLY_SETTING_KEY,
  /** 支付卡 / 地址保管库（密文 JSON，由 form-fill 服务读写） */
  formFillEntries: 'privacy.form_fill_entries'
})

/** 全部缺省值（键 = 真实设置键）—— 域层默认值与设置页兜底显示共用。 */
export const DEFAULT_PRIVACY_SETTINGS = Object.freeze({
  [PRIVACY_SETTING_KEYS.blockTrackers]: true,
  [PRIVACY_SETTING_KEYS.blockAds]: true,
  [PRIVACY_SETTING_KEYS.clearHistoryOnExit]: false,
  [PRIVACY_SETTING_KEYS.clearDownloadsOnExit]: false,
  [PRIVACY_SETTING_KEYS.clearCacheOnExit]: false,
  [PRIVACY_SETTING_KEYS.clearCookiesOnExit]: false,
  [PRIVACY_SETTING_KEYS.clearSiteDataOnExit]: false,
  // 默认关：DNT 已是弃用特性，主流浏览器均不再默认发送；开启会为每个请求挂主进程钩子，拖慢加载。
  [PRIVACY_SETTING_KEYS.doNotTrack]: false,
  [PRIVACY_SETTING_KEYS.passwordSavePrompt]: true,
  [PRIVACY_SETTING_KEYS.formAutofill]: true,
  // 仅 HTTPS 默认关，不改既有行为（本地 / 私网豁免，见 https-only.mjs）。
  [PRIVACY_SETTING_KEYS.httpsOnly]: false,
  // 空串 = 保管库里没有任何条目。
  [PRIVACY_SETTING_KEYS.formFillEntries]: ''
})
