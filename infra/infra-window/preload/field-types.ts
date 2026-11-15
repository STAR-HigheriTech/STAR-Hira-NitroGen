/**
 * field-types.js —— 自动填充「哪些 input type 值得看」的**唯一真源**。
 *
 * 地址填充（`address-autofill`）与凭据填充（`password-autofill`）各自维护过一份：
 *   · 地址侧 `new Set(['text','email','tel','number','search',''])`；
 *   · 凭据侧内联 `['text','email','tel','number','search']` 与用户名子集 `['text','email','tel']`。
 *
 * 两份清单只要一处改动，另一处就会静默漏填（表现为"某些输入框就是不出浮层"）。
 * 这里只放**纯数据 + 纯函数**，不碰 DOM 结构判断。
 *
 * ⚠ preload 是沙箱环境：本文件只能被**相对路径**引入（见 address-autofill/index.js 顶部说明），
 * 不能用 `@hira-ng/*` 包名 —— 那会被 externalize 成运行时 require 并拖垮整个 tab preload。
 */

/** 能承载文本类凭据 / 地址的 input type（地址填充与密码候选共用）。 */
export const TEXT_INPUT_TYPES = Object.freeze(['text', 'email', 'tel', 'number', 'search'])

/** 用户名可能落在的类型：比文本类窄（`number` / `search` 不可能是账号名）。 */
export const USERNAME_INPUT_TYPES = Object.freeze(['text', 'email', 'tel'])

/**
 * 归一化 input type：空值等同于 `text`（HTML 规范里 `type` 缺省就是 text）。
 * @param {unknown} type
 * @returns {string}
 */
export function normalizeInputType(type: unknown): string {
  const value = String(type == null ? '' : type).trim().toLowerCase()
  return value || 'text'
}

/**
 * @param {unknown} type
 * @returns {boolean}
 */
export function isTextInputType(type: unknown): boolean {
  return TEXT_INPUT_TYPES.includes(normalizeInputType(type))
}

/**
 * @param {unknown} type
 * @returns {boolean}
 */
export function isUsernameInputType(type: unknown): boolean {
  return USERNAME_INPUT_TYPES.includes(normalizeInputType(type))
}
