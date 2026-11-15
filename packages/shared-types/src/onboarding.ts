/**
 * onboarding.mjs —— 首次启动引导（OOBE）的**版本号与设置键名**唯一真源。
 *
 * 为什么存版本号而不是布尔：引导流程改版时把 ONBOARDING_VERSION 提一版，
 * 老用户存的旧版本号判等自然不成立 —— 无需再加一个「是否看过 v2」的键。
 *
 * 消费方：
 *   · 主进程引导控制器（`main/onboarding`）—— 读 / 写完成态、判定是否要引导；
 *   · domain-settings —— 默认值（未引导过 = 空串）；
 *   · settings-scope —— 必须全局（换 profile 不该重新引导）。
 */

/** 当前引导流程版本。改这个值 = 让所有老用户重新看一遍引导。 */
export const ONBOARDING_VERSION = 'v1'

/** 完成态所在的设置键（全局作用域 —— 换 profile 不该重新引导）。 */
export const ONBOARDING_SETTING_KEY = 'app.onboarding_version'
