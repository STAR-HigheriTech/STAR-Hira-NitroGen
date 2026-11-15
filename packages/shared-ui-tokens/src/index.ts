/**
 * @hira-ng/shared-ui-tokens —— token 包入口（ESM，供渲染层消费）。
 *
 * 本包同时提供两层 token：
 *   1. CSS 层：`tokens-base.css` / `tokens-light.css` / `tokens-dark.css` /
 *      `components.css` / `layers.css`（渲染层 UI 层级变量与工具类）；
 *   2. TS 层：本文件导出的**渲染层 UI 层级常量**（供 TS 侧引用）。
 *
 * `UILayer` 是 layers.css 中 `--hira-z-*` 的 TS 镜像 —— 一处定义、两处消费，
 * 渲染层因此在 TS 里也不必再写裸的 z-index 数字。
 * 字段名必须与 layers.css 的 `--hira-z-<name>` 后缀一一对应。
 */

export const UILayer = Object.freeze({
  // 负层：内容**之下**的装饰层（主题壁纸与遮罩）。为什么需要负层而不是 base：
  // 它们必须在容器自己的内容之下，而内容通常就是 base 层的普通流。
  backdrop: -2,
  veil: -1,
  base: 0,
  elevated: 10,
  controls: 20,
  scrim: 30,
  modal: 40,
  popover: 50,
  tooltip: 60,
  max: 100
} as const)

export type UILayerName = keyof typeof UILayer

export const UI_LAYER_NAMES = Object.freeze(Object.keys(UILayer) as UILayerName[])

/** 层名 → CSS 变量引用（`var(--hira-z-<layer>)`），供需要字符串形式赋值 DOM 的场景。 */
export const UILayerVar: Readonly<Record<UILayerName, string>> = Object.freeze(
  Object.fromEntries(UI_LAYER_NAMES.map((name) => [name, `var(--hira-z-${name})`]))
) as Readonly<Record<UILayerName, string>>

/** 层名 → 工具类名（`hira-z-<layer>`），供 className 拼接。 */
export const UILayerClass: Readonly<Record<UILayerName, string>> = Object.freeze(
  Object.fromEntries(UI_LAYER_NAMES.map((name) => [name, `hira-z-${name}`]))
) as Readonly<Record<UILayerName, string>>
