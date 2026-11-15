/**
 * constants.js — 自动填充引擎的静态常量
 *
 * 统一收拢字段识别关键词、排除词、OTP 关键词、密码生成字符集、
 * i18n 中文字符串与钥匙图标 SVG。各模块只从这里取常量，便于集中维护。
 */

// 识别字段时扫描的属性（对齐 Hira：name/formcontrolname/id/placeholder/aria-label/autocomplete）
export const FIELD_ATTRS = Object.freeze([
  'name',
  'formcontrolname',
  'id',
  'placeholder',
  'aria-label',
  'autocomplete'
])

// getBestInput 使用的属性（Hira 此处不含 autocomplete）
export const FIELD_ATTRS_NO_AUTOCOMPLETE = Object.freeze([
  'name',
  'formcontrolname',
  'id',
  'placeholder',
  'aria-label'
])

// 用户名关键词（对齐 Hira username 全量词表 + 中文）
export const USERNAME_KEYWORDS = Object.freeze([
  'username',
  'user-name',
  'userid',
  'user-id',
  'user',
  'login',
  'loginid',
  'login-id',
  'loginname',
  'login-name',
  'account',
  'acct',
  'identifier',
  'email',
  'e-mail',
  'mail',
  'phone',
  'mobile',
  'tel',
  'phonenumber',
  'mobilephone',
  'telephone',
  'cell',
  'auth',
  '邮箱',
  '账号',
  '帐号',
  '用户名',
  '手机号',
  '手机',
  '电话'
])

// 排除词（命中则判定为“非用户名框/非密码框”，避免误伤搜索框等）
export const EXCLUDE_KEYWORDS = Object.freeze([
  'confirm',
  'retype',
  'filename',
  'search',
  'filter',
  'query'
])

// 兜底用户名关键词（上面几轮都没命中时的最后一遍扫描）。
// 与 USERNAME_KEYWORDS **不是**同一份：这里刻意只保留最宽的短词，并额外加 'name'
// （长词已在前面扫过，兜底再扫一遍没有收益；'name' 太泛，放进主词表会误伤）。
export const USERNAME_FALLBACK_KEYWORDS = Object.freeze([
  'user', 'name', 'mail', 'login', 'auth', 'identifier', 'account', 'acct',
  'phone', 'mobile', 'tel', '邮箱', '账号', '手机号', '手机', '电话'
])

// 密码关键词（对齐 Hira password 全量词表 + 中文）
export const PASSWORD_KEYWORDS = Object.freeze([
  'pass',
  'password',
  'pwd',
  'psw',
  'passwd',
  'passcode',
  'pin',
  'secret',
  'credential',
  '密码'
])

// OTP / 一次性验证码排除词（避免把验证码输入框误判为密码框）
export const OTP_KEYWORDS = Object.freeze([
  'otp',
  'code',
  'sms',
  'captcha',
  'verify',
  'verification',
  '2fa',
  'mfa',
  'token'
])

export const OTP_CHINESE_HINTS = Object.freeze([
  '验证码',
  '短信',
  '校验',
  '动态码',
  '一次性',
  '安全码'
])

// ── i18n 中文文案（对齐“本地化为中文、微软/苹果/谷歌风格”偏好）──
export const STRINGS = Object.freeze({
  // 多凭据选择菜单
  menuTitle: '为 {hostname} 选择凭据',
  emptyNoSavedCredentials: '此站点尚未保存凭据',
  // 保存提示卡
  savePasswordTitle: '保存密码？',
  savePasswordDomain: '{hostname}',
  usernameLabel: '用户名',
  passwordLabel: '密码',
  showPasswordTitle: '显示密码',
  neverSave: '永不保存',
  notNow: '暂不保存',
  save: '保存',
  close: '关闭',
  deletePassword: '删除密码'
})

// 钥匙图标 SVG（对齐 Hira carbon:password，随输入框前景色）
export const KEY_ICON_SVG = `<svg width="20px" height="20px" xmlns="http://www.w3.org/2000/svg" aria-hidden="true" focusable="false" width="1em" height="1em" style="display:block;vertical-align:-0.125em;-ms-transform:rotate(360deg);-webkit-transform:rotate(360deg);transform:rotate(360deg);" preserveAspectRatio="xMidYMid meet" viewBox="0 0 32 32" shape-rendering="geometricPrecision"><path d="M21 2a9 9 0 0 0-9 9a8.87 8.87 0 0 0 .39 2.61L2 24v6h6l10.39-10.39A9 9 0 0 0 30 11.74a8.77 8.77 0 0 0-1.65-6A9 9 0 0 0 21 2zm0 16a7 7 0 0 1-2-.3l-1.15-.35l-.85.85l-3.18 3.18L12.41 20L11 21.41l1.38 1.38l-1.59 1.59L9.41 23L8 24.41l1.38 1.38L7.17 28H4v-3.17L13.8 15l.85-.85l-.29-.95a7.14 7.14 0 0 1 3.4-8.44a7 7 0 0 1 10.24 6a6.69 6.69 0 0 1-1.09 4A7 7 0 0 1 21 18z" fill="currentColor"/><circle cx="22" cy="10" r="2" fill="currentColor"/></svg>`
