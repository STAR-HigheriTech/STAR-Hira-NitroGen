// @ts-check
/**
 * @hira-ng/ui-panel-easel —— 画板（D4，Arc 的 Easel）。
 *
 * 一块**无限画布**：便签 / 链接 /（粘贴的）图片钉上去，拖、缩放、叠放、自动保存。
 * 学 `ui-panel-themes` 的**双形态**：窄面板只做导航（有哪几块板），
 * 画布在独立窗口里（宽度与拖拽才够用）。两形态共用同一份存取内核与数据规则。
 *
 * 包结构：
 *   src/shared/   两形态逐字共用（store / styles）
 *   src/panel/    窄面板形态  → `panelDefinition`（id: easel-panel）
 *   src/window/   独立窗口形态 → `windowDefinition`（id: easel-window）
 */

export { panelDefinition, createEaselPanel, injectEaselPanelStyles } from "./panel/index"
export { windowDefinition, createEaselWindow, injectEaselWindowStyles } from "./window/index"
