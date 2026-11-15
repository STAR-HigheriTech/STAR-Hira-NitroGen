/**
 * font-stack.mjs —— 浏览器 UI 字体栈的**唯一真源**（零依赖、零 IO、纯常量）。
 *
 * ── 为什么单独一个文件 ──────────────────────────────────────────────
 * 消费方分三类，取用方式天然不同：
 *   ① 有主题令牌的文档（外壳 / 面板 / 内部页 / 子窗口 / 浮层）
 *        → `var(--hira-font-ui, <本栈>)`，令牌随主题下发；
 *   ② 独立文档（导出的 HTML、PWA 错误页、插件 srcdoc、注入网页的浮层）
 *        → 直接用本栈（拿不到令牌时这就是真值）；
 *   ③ **页面侧 preload**（sandbox，只能用相对路径内联）
 *        → 从本文件取；若从 `theme.mjs` 取，会把整张主题目录/映射表拖进每一页的
 *          `tab.js`。所以常量必须住在一个"薄"模块里，`theme.mjs` 再 re-export 它。
 *
 * ── 三条硬约束（都是踩过的坑，不是审美偏好）────────────────────────
 *   1. **必须显式列出中文 UI 字体**。只写 `Segoe UI` / `Roboto` / `sans-serif` 时，
 *      中文按系统默认字体回退 —— 在 Windows 上会落到宋体那一类衬线/点阵字形，
 *      小字号 + 粗体就是用户说的"粗点阵宋体"；
 *   2. **`Microsoft YaHei UI` 必须排在 `Microsoft YaHei` 前面**。前者是系统 UI 版
 *      （为小字号收紧过字面与字距），后者是文档版：12~13px 的标题/选项卡用文档版
 *      会明显发虚、发笨 —— 这正是"有的地方是现代字体、有的地方是点阵宋体"的来源；
 *   3. 拉丁字形优先 `Segoe UI Variable Text`（Win11 系统 UI 字体，带真实 400~700
 *      字重轴，粗细层次是真的而不是合成的）；中文由后面的 YaHei UI 接管。
 *
 * ⚠ 改这一处 = 改所有界面。静态兜底（主题令牌还没下发时的首帧）在
 *   `packages/shared-ui-tokens/tokens-base.css#--hira-font-ui` 与
 *   `apps/app-main/src/pages/_shared/base.css#body`，必须与这里逐字同值。
 */
export const UI_FONT_STACK =
  '"Segoe UI Variable Text", "Segoe UI Variable", "Segoe UI", "Microsoft YaHei UI", "Microsoft YaHei", "PingFang SC", "Noto Sans SC", system-ui, -apple-system, sans-serif'

/**
 * 等宽栈（代码 / 注入脚本编辑框）。
 *
 * 末尾同样要带中文 UI 字体：纯 `monospace` 在 Windows 上把中文回退到 **NSimSun**
 *（又是点阵宋）。中文并不需要等宽语义 —— 代码里的注释、提示文案用 UI 字体更清楚。
 */
export const UI_MONO_STACK =
  'ui-monospace, SFMono-Regular, Menlo, Consolas, "Microsoft YaHei UI", "Microsoft YaHei", monospace'

/**
 * 供 CSS 字符串直接拼接的变量引用：优先主题令牌，拿不到时用同一个字面栈。
 * @param {string} [stack] 覆盖用的字面栈（默认 UI_FONT_STACK）
 * @returns {string} 例如 `var(--hira-font-ui, "Segoe UI Variable Text", …)`
 */
export function uiFontVar(stack: string = UI_FONT_STACK) : string {
  return `var(--hira-font-ui, ${stack})`
}
