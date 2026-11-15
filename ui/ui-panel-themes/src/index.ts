// @ts-check
/**
 * @hira-ng/ui-panel-themes —— 主题系统的**侧栏窄面板**。
 *
 * ┌──────────────────────────────────────────────────────────────────┐
 * │ index.js   唯一出口：只做转出，零逻辑                              │
 * │ panel/     侧栏窄面板 —— 当前主题 + 色卡网格（点一下即换）+ 管理入口 │
 * │ styles.js  面板特有布局（色卡网格 / 当前主题表头）                  │
 * └──────────────────────────────────────────────────────────────────┘
 *
 * ## 宽形态去哪了
 *   主题库 / 编辑器 / 调度 / 私密窗口主题是一个**内部页**（`hira://themes`，
 *   源码见 `apps/app-main/src/pages/themes/`）。判据只有一条：这件事在窄栏里
 *   做得爽吗？换主题（点一下色卡）爽 → 留面板；造主题（六格取色器 + 滑杆 +
 *   背景 + 实时预览）不爽 → 归整页。与插件中心"看名单留面板、装/卸归页面"
 *   是同一条判据。
 *
 * ## 两形态共享的编排内核在哪
 *   `packages/shared-types/src/themes/`（core / format / dom / styles）——
 *   面板与主题页 import 的是**同一份**，所以"面板里点一下换主题"与
 *   "页面里点一下换主题"永远走同一段代码。共享真源放在 shared-types 是因为
 *   内部页是**不打包的静态页**：它只能通过 `hira://shared/themes/*` 拿到这份代码
 *   （构建期由 `sync-shared-contracts` 复制，见 electron.vite.config.js）。
 *
 * ## 宿主契约
 *   { id, injectStyles(doc), mount(doc, ctx) -> { element } }
 *   ctx = { clients: { themes }, openPage(host) }
 *   端口注入方向永远是 apps → ui（CONTRACT-11：ui 不得 import apps）。
 *
 * ## 主题数据从哪来
 *   全部经 `clients.themes`（apps 层的 `renderer/shared/theme-client.js`）——
 *   本包对 IPC 通道名、事件名零知识。加一条主题 IPC 只需改那个客户端。
 */
export { panelDefinition } from "./panel/index"
