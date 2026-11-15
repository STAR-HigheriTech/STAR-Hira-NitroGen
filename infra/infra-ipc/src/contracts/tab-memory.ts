import { z } from 'zod'

/**
 * Tab Memory 契约 —— 「某个标签此刻占多少内存」（hover 预览浮层显示用）。
 *
 * 只有主进程答得出来：`webContents.getOSProcessId()` 给进程号，`app.getAppMetrics()`
 * 给该进程的内存指标。取哪个字段由 `main/process-memory.ts` 决定（口径唯一真源）——
 * 这里是**独占内存**：工作集含每个 renderer 都会重复计入的 ~86 MB 共享基线，
 * 拿去显示会让任何页面都虚高约 4 倍。所以这里只回一个数字，不做单位换算、更不做任何估算。
 *
 * `sleeping` 与 `memoryKB` 是**两件事**，必须分开：
 *   · `sleeping: true` —— 该标签没有活着的渲染进程（TabManager 侧口径），
 *     消费方显示状态词（如「已休眠」）；
 *   · `sleeping: false` 且 `memoryKB: null` —— 进程在，但这一刻从指标表里查不到
 *     （刚创建 / 刚销毁的竞态），消费方应**不显示**这一行，而不是显示 0。
 */
const tabMemorySchemas = Object.freeze({
  request: z.object({ tabId: z.string().min(1) }),
  response: z.object({
    tabId: z.string(),
    /** 该标签是否处于休眠（无 webContents）。唯一定义在 WebContentsManager#isTabSleeping。 */
    sleeping: z.boolean(),
    /** 独占内存（KB）；取不到时为 null。口径见 main/process-memory.ts */
    memoryKB: z.number().nullable()
  })
})

export { tabMemorySchemas }

