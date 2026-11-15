/**
 * 进程内存口径（KB）—— 「Chromium 的 `ProcessMetric.memory` → 我们对外报的那个数」
 * 的**唯一真源**。
 *
 * ## 为什么必须有这一份
 *
 * 全项目有三处要读「某个进程占多少内存」：标签 hover 预览、任务管理器、内存压力回收。
 * 原先三处各自写 `m.memory.workingSetSize` —— 于是"口径"这件事在代码里连个名字都没有，
 * 谁想换口径只能靠 grep 找齐三处（必然漏一处）。这里给它命名，并写清各自适用的场景。
 *
 * ## 两个口径差多少（本机实测：Electron 43 / Windows）
 *
 * 一个几乎空白的 HTML 页面，单个标签（renderer）进程：
 *   · `workingSetSize` = 108.0 MB
 *   · `privateBytes`   =  22.1 MB
 *   · 差额             =  85.9 MB  ← 与**其他** Chromium 进程共享的映射
 *                                    （引擎代码段 / 共享缓存 / 共享 GPU 缓冲）
 *
 * 再开三个同样的标签，每一个的 workingSet 仍然是 ~108 MB：**那 86 MB 共享部分
 * 被每个进程各算了一遍**。四个标签合计 workingSet 805 MB，而真实独占只有 205 MB，
 * 虚高约 4 倍。
 *
 * 结论：「这个标签 / 页面占多少内存」**只能**用 `privateBytes` 回答 ——
 * 主流浏览器（Chrome / Edge 任务管理器）给用户看的正是摊掉共享后的口径。
 * 拿 workingSetSize 去比，任何页面都会显得比同类产品高一截，而那一截是共享基线，
 * 根本不是这个页面自己占的。
 */

/** `ProcessMetric.memory` 的形状（只取本模块用到的两个字段）。 */
interface MemoryLike {
  workingSetSize?: number
  privateBytes?: number
}

/**
 * 数值防抖：非有限 / 非正一律 `null`。
 * 返回 `null` 而不是 0 —— 消费方据此「不显示这一行」，而不是拿 0 充数。
 */
function positiveKB(value: unknown): number | null {
  const n = Number(value)
  return Number.isFinite(n) && n > 0 ? n : null
}

/**
 * 进程**独占**内存（KB）—— JS 堆 + HTML 内容等不与任何其他进程共享的部分。
 *
 * 「这个标签 / 这个页面自己占多少内存」用这个。hover 预览与任务管理器都走它。
 *
 * ⚠ 平台限制：`privateBytes` 只有 Windows 提供（Electron 文档标注 `@platform win32`）。
 * 其他平台退回工作集：那时数字会带上共享映射，与 Windows 不可直接比较，但**有值总好过没有**
 * —— 这是 Electron 能给出的唯一 per-进程私有口径（`process.getProcessMemoryInfo()`
 * 只能查**当前**进程，查不到别的 renderer）。
 *
 * @param memory `ProcessMetric.memory`（缺失 / 异常一律安全）
 */
export function privateMemoryKB(memory: MemoryLike | null | undefined): number | null {
  if (!memory) return null
  return positiveKB(memory.privateBytes) ?? positiveKB(memory.workingSetSize)
}

/**
 * 进程**工作集**（KB）—— 映射到该进程的全部物理页，**含与其他进程共享的部分**。
 *
 * 「这台机器的物理内存被这个进程压了多少」用这个。内存压力回收是**唯一**的正当场景：
 * 它关心的是物理内存压力，而不是"这个页面自己占了多少"。
 * 反过来把工作集用于显示，就会得到上面实测的那 4 倍虚高。
 *
 * @param memory `ProcessMetric.memory`
 */
export function workingSetMemoryKB(memory: MemoryLike | null | undefined): number | null {
  return memory ? positiveKB(memory.workingSetSize) : null
}
