/**
 * print —— 打印选项的**词表真源**（纸张大小 + 缺省值）。
 *
 * ── 为什么单独一份 ────────────────────────────────────────────────────
 * 同一份纸张清单原本散在四处、四种加载方式：
 *   · IPC 契约（infra/infra-ipc/src/contracts/print.js）：`z.enum([...])` 拦请求；
 *   · 主进程收口（apps/app-main/src/main/print/service.ts）：TS 联合类型 + 运行时白名单；
 *   · 打印预览页的 `<select>`（pages/print-preview/index.html）：静态 option 列表；
 *   · 预览页的初始状态（pages/print-preview/print-preview.js）：`pageSize: 'A4'`。
 * 任何一处漏改都会变成「下拉里能选、主进程当非法值丢掉」这类静默 bug。
 *
 * 取值来自 Chromium/Electron `printToPDF` 支持的纸张名（列在这里的都是实际能出纸的），
 * 顺序即下拉展示顺序。新增一种纸张 = 只改这里（契约 / 收口 / 下拉全部自动跟上）。
 *
 * 用 `.mjs`：本包入口 `src/index.js` 是 CJS，`.js` 会被按 CJS 解析；`.mjs` 不依赖
 * package.json 的 `type`，Node 与 vite/rollup 都一律按 ESM 处理（与 ipc-channels.mjs 同因）。
 */

/** 纸张大小（顺序即下拉展示顺序）。 */
export const PRINT_PAGE_SIZES = Object.freeze(['A4', 'Letter', 'A3', 'Legal', 'Tabloid'])

/** 缺省纸张：与 Chrome「打印」的默认一致。 */
export const DEFAULT_PRINT_PAGE_SIZE = 'A4'

/** 边距模式：default（Chromium 默认边距）/ none（无边距）。 */
export const PRINT_MARGIN_MODES = Object.freeze(['default', 'none'])

/** 缺省边距模式（预览页与主进程收口共用）。 */
export const DEFAULT_PRINT_MARGIN_MODE = 'default'

/** 边距模式 → 下拉展示名（唯一一份；页面不再手抄中文）。 */
export const PRINT_MARGIN_LABELS = Object.freeze({ default: '默认', none: '无边距' })
