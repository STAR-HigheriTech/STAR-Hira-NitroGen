/**
 * 扩展运行时状态 → 中文名（单一真源）
 *
 * ── 为什么放在 packages/shared-types ────────────────────────────────────
 * 这份映射被**两层、两种加载方式**同时引用，放在任何单一 app 里都会造成依赖倒挂：
 *   · ui 层哑组件（ui/ui-panel-extensions）：vite 打包，直接 `import` 本文件；
 *   · hira:// 内部页（apps/app-main/src/pages/extensions）：无打包器的静态页，
 *     只能 import 静态文件 —— 由 `electron.vite.config.js` 的 sync-shared-contracts
 *     插件按原样复制到 `out/pages/_shared/extension-labels.mjs`，页面用
 *     `hira://shared/extension-labels.mjs` 引用（与 permission-labels.mjs 同一机制、同一目录）。
 *
 * 为什么**不能**留在 `apps/`：`ui/` 层不允许反向依赖 `apps/`（依赖方向必须是
 * ui → packages，不能是 ui → apps）。放在本包与管理层同目录的先例
 * `ipc-channels.mjs` / `permission-labels.mjs` 一致 —— PACKAGES 层各层都可依赖。
 *
 * 用 **`.mjs`** 而不是 `.js`，与 ipc-channels.mjs 同因：本包入口 `src/index.js` 是 CJS，
 * 若本文件是 `.js` 就会被 Node 按 CJS 解析，`export const` 直接语法错误；
 * `.mjs` 不依赖任何 package.json 的 `type` 字段，Node 与 vite/rollup 都一律按 ESM 处理。
 *
 * ── 取值来源（不是自创）─────────────────────────────────────────────────
 * 与主进程 `extension:runtime-status` 契约的枚举**完全一致**
 * （infra/infra-ipc/src/contracts/extensions.js#runtimeStatus：
 *   z.enum(['loaded', 'disabled', 'missing', 'error'])），
 * 也就是 infra-extensions#getRuntimeStatus 的四个返回值：
 *   · loaded   —— 扩展已在当前运行时加载
 *   · disabled —— 用户显式停用（已从运行时卸载，但记录仍在）
 *   · missing  —— 运行时里既没有实例、也没有记录（例如同一 id 已被外部移除）
 *   · error    —— 启动恢复 / 重试加载失败（记录仍在，原因随列表项 loadError 下发）
 *
 * ── 兜底纪律 ─────────────────────────────────────────────────────────
 * 未识别的状态一律渲染成「未知状态（<原始值>）」—— 代码名只能出现在括号里作为补充，
 * 绝不作为主标签裸露给用户。
 */

/** 规范状态顺序（与主进程契约同序，供筛选/排序类消费方按此顺序展开）。 */
export const EXTENSION_STATUSES = Object.freeze(['loaded', 'disabled', 'missing', 'error'])

/**
 * `extension:changed` 的生命周期变更类型（**唯一真源**）。
 *
 * 消费方两处、两种加载方式：主进程 `createExtensionEventRelay` 要据此逐个
 * `service.events.on(channel)` 订阅；IPC 契约的 `type` 枚举要据此校验。
 * 两处各抄一份是同一份词表的两份真相 —— 新增一种变更类型时只会改到这里。
 *
 * 与上面的 `EXTENSION_STATUSES` 是**两个维度**：这里是"发生了什么"（事件），
 * 那里是"现在处于什么状态"（快照），不要互相顶替。
 */
export const EXTENSION_CHANGE_TYPES = Object.freeze([
  'loaded', 'unloaded', 'installed', 'uninstalled', 'toggled', 'reloaded', 'pinned', 'load-failed', 'action-updated'
])

const LABELS = Object.freeze({
  loaded: '运行中',
  disabled: '已停用',
  missing: '未加载',
  error: '加载失败'
})

/** 未识别状态的兜底前缀：后面拼原始值，保证可追溯但不当主标签。 */
const FALLBACK_PREFIX = '未知状态'

/**
 * 状态 → 中文名（**永不返回空、永不返回代码名当主标签**）。
 * 空值 → 「未知状态」；未识别 → 「未知状态（<原始值>）」。
 * @param {string} status
 * @returns {string}
 */
export function extensionStatusLabel (status: unknown): string {
  const raw = typeof status === 'string' ? status.trim() : ''
  if (!raw) return FALLBACK_PREFIX
  return (LABELS as Readonly<Record<string, string>>)[raw] || `${FALLBACK_PREFIX}（${raw}）`
}
