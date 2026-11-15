/**
 * extensions-settings —— 扩展系统**设置键名 + 缺省值**的唯一真源（纯数据，零依赖、无 IO）。
 *
 * 改造前同一批键名被手抄在五处：
 *   · `domain-settings` 默认值表（值）；
 *   · `settings/registry.js` 字段表（键名 + 又一份 default）；
 *   · `main.js` 的 `extensionOptionsPort`（构造期读取）；
 *   · `main/ipc/extensions.js`（开发者模式诊断开关）；
 *   · 内部页 `pages/extensions/extensions.js`（开发者模式开关）。
 *
 * 键名里的 `_` / `-` 混用是**历史落库格式**，不能改 —— 改一个字就是老用户设置丢失。
 *
 * 语义边界（不要合并这三者）：
 *   · developerMode 只决定「详情里是否露出运行时诊断 / 重新加载」，不决定任何能力；
 *   · allowUnpacked 决定「能不能加载未打包扩展」，是构造期参数（重启生效）；
 *   · autoUpdate 决定扩展是否后台自动更新，同样是构造期参数。
 */

/** @type {Readonly<Record<string, string>>} */
export const EXTENSIONS_SETTING_KEYS: Readonly<Record<string, string>> = Object.freeze({
  developerMode: 'extensions.developer_mode',
  allowUnpacked: 'extensions.allow-unpacked',
  autoUpdate: 'extensions.auto-update'
})

/** @type {Readonly<Record<string, boolean>>} */
export const DEFAULT_EXTENSIONS_SETTINGS: Readonly<Record<string, boolean>> = Object.freeze({
  [EXTENSIONS_SETTING_KEYS.developerMode]: false,
  [EXTENSIONS_SETTING_KEYS.allowUnpacked]: true,
  [EXTENSIONS_SETTING_KEYS.autoUpdate]: true
})
