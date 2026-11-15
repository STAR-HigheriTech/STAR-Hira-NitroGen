/**
 * 体积文本（字节 → 人类可读）—— **唯一实现**。
 *
 * 为什么值得单独一份真源：同一个数字在本项目有**两处**要显示，而且本来就是同一个数
 * （主进程按 `main/process-memory.ts` 的口径取出的 KB 值）：任务管理器（`hira://`
 * 内部页）与标签 hover 预览浮层。两处各写一遍取整规则，迟早出现「180.0 MB」与
 * 「180 MB」这种只能靠肉眼发现的不一致 —— 而这正是「同一个值，两种说法」最典型的坏形态。
 *
 * 纯函数、零依赖、不碰 DOM：三种运行环境都能直接引
 *   · 主进程（Node / CJS 侧经 vite 转译）
 *   · 打包渲染层（`out/renderer/assets/*`）
 *   · `hira://` 静态内部页（无打包器，靠 electron.vite.config.js 的
 *     `SHARED_PAGES_MODULES` 复制到 `out/pages/_shared/` 后按相对路径 import）
 *
 * 取整口径（`toFixed(1)`，且整数量级不做 1024 进位以外的修饰）刻意与
 * `pages/_shared/runtime.js#fmtSize` 的历史行为**逐字一致** —— 那个函数现在直接
 * 转发到这里，因此既有页面（下载 / 导入数据 / 任务管理器…）的显示文本一字未变。
 */

/**
 * 字节单位阶梯（1024 进制，从 B 到 TB）—— **单位顺序表**的唯一真源。
 *
 * 它只描述「档位次序」，不描述取整口径：本文件的两个函数、下载面板的紧凑口径、
 * 扩展目录大小的口径各有各的位数/取整规则（见各自注释），但**档位名称与递进**
 * 必须是同一份，否则同一个体积在不同页面会出现 `MB` / `M` 这种口径漂移。
 */
export const BYTE_UNITS = Object.freeze(['B', 'KB', 'MB', 'GB', 'TB'])

const KB = 1024
const MB = 1024 * 1024
const GB = 1024 * 1024 * 1024

/**
 * 字节数 → 可读文本（`1.2 MB` / `512.0 KB` / `0 B`）。
 *
 * 空值 / 0 / 非法输入一律返回**空串**（不是 `'0 B'`）—— 调用方据此自行决定
 * 「显示 0」还是「干脆不显示这一项」，这个选择不该由格式化函数替它做。
 *
 * @param {number} bytes
 * @returns {string}
 */
export function formatBytes(bytes: number | null | undefined): string {
  if (!bytes) return ''
  if (bytes < KB) return bytes + ' B'
  if (bytes < MB) return (bytes / KB).toFixed(1) + ' KB'
  if (bytes < GB) return (bytes / MB).toFixed(1) + ' MB'
  return (bytes / GB).toFixed(1) + ' GB'
}

/**
 * 字节数 → 可读文本（**下载域口径**：`2.0 KB` / `1.50 GB` / `0 B`）。
 *
 * 与 `formatBytes` 的差异（两种口径并存的理由）：
 *   · 0 是合法值（下载刚开始时 received 就是 0）→ 返回 `'0 B'`，只有非法输入
 *     （undefined / null / NaN）才回 `empty` 参数；
 *   · GB 档保留两位小数（下载中的大文件需要更细的量级反馈，对齐
 *     Chrome 下载气泡的口径）。
 *
 * ⚠ 这是下载域体积累积口径的**唯一实现**。domain-download（CJS）侧不再保留同名镜像，
 *   需要时由 APPS 层把本函数算好的文本传下去。
 *
 * @param {number} bytes
 * @param {string} [empty=''] 非法输入时的回退文案（调用方决定显示空还是占位符）
 * @returns {string}
 */
export function formatDownloadSize(bytes: number | null | undefined, empty: string = ''): string {
  if (!bytes && bytes !== 0) return empty
  if (bytes < KB) return bytes + ' B'
  if (bytes < MB) return (bytes / KB).toFixed(1) + ' KB'
  if (bytes < GB) return (bytes / MB).toFixed(1) + ' MB'
  return (bytes / GB).toFixed(2) + ' GB'
}

/**
 * 千字节数 → 可读文本 —— 主进程给出的内存口径（见 `main/process-memory.ts`）单位就是 KB，
 * 这里替调用方做掉那一次 `* 1024`，避免「KB 还是字节」在每处调用点上各记一次。
 *
 * 非正 / 非法 → 空串（同 `formatBytes` 的约定）。
 *
 * @param {number} kb
 * @returns {string}
 */
export function formatMemoryKB(kb: unknown): string {
  const n = Number(kb)
  if (!Number.isFinite(n) || n <= 0) return ''
  return formatBytes(n * KB)
}
