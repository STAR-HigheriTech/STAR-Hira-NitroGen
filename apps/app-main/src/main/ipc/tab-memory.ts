/**
 * IPC · Tab Memory 域（TypeScript）
 *
 * 回答一个问题：「某个标签此刻占了多少内存」—— 给标签 hover 预览浮层用。
 *
 * **数值与任务管理器同源**：`webContents.getOSProcessId()` 取 renderer 的 OS 进程号，
 * 再到 `app.getAppMetrics()` 里查该 pid 的内存。
 * 具体取哪个字段、为什么 —— 见 `main/process-memory.ts`（口径唯一真源，与任务管理器共用）。
 *
 * 刻意**不**用 `webContents.getProcessMemoryInfo()`：它只对**当前**进程有效
 * （属于 Electron 的 `process` 模块），查不到别的 renderer。
 *
 * `sleeping` 不在这里推断，直接问 `WebContentsManager#isTabSleeping`（唯一定义点）——
 * 本文件只负责「进程号 → 指标」这一段，不自己定义什么算休眠。
 *
 * 本文件只做 typed 路由 → 端口调用的映射，不 import electron（可无 Electron 单测）。
 * 与 `ipc/snapshot.ts` 同构：`*.ts` 由 electron.vite.config.js 的 copy-main-sources
 * 插件用 esbuild 就地转译为 `out/main/ipc/tab-memory.js`，调用点零改动。
 */

import { privateMemoryKB } from '../process-memory'

interface WebContentsLike {
  getOSProcessId(): number
  isDestroyed?: () => boolean
}

interface WcmLike {
  getTab(tabId: string): { webContents?: WebContentsLike } | null
  isTabSleeping?(tabId: string): boolean
}

interface ProcessMetricLike {
  pid: number
  memory?: { workingSetSize?: number; privateBytes?: number }
}

import type { IpcSchemas, IpcTypedMain } from './types'

interface Deps {
  routes?: { tabMemory?: string }
  schemas?: IpcSchemas['tabMemory']
  getAppMetrics?: () => ProcessMetricLike[]
  webContentsManager?: WcmLike | null
}

/**
 * 指标快照的复用窗口（ms）。
 *
 * 为什么要缓存：`getAppMetrics()` 要遍历**全部子进程**（Electron 自己的文档就写明了这是
 * 中等开销的同步调用），而用户横扫标签栏时预览会一个接一个地问 —— 20 个标签就是
 * 20 次全进程遍历。1 秒内复用同一份快照，把这种情况压到 1 次；内存占用在 1 秒内
 * 不会变出可感知的差异，显示的仍是真实值。
 */
const METRICS_TTL_MS = 1000

/** 取不到任何值时一律 `null` —— 消费方据此不显示，而不是显示 0。 */
const UNKNOWN = { memoryKB: null } as const

/**
 * 读一个标签的当前内存。
 *
 * @param tabId
 * @param wcm 该标签所属窗口的 WebContentsManager（多窗口下由调用方按发送方解析）
 * @param getMetrics 指标快照取值函数（内部已做 TTL 缓存）
 */
function readTabMemory(
  tabId: string,
  wcm: WcmLike | null | undefined,
  getMetrics: () => ProcessMetricLike[]
) {
  if (!wcm || typeof wcm.getTab !== 'function') return { tabId, sleeping: true, ...UNKNOWN }

  const view = wcm.getTab(tabId)
  const wc = view && view.webContents

  // 没有视图 = 标签没有活着的渲染进程。是"休眠"还是"已关闭"由 WCM 的既有口径回答，
  // 这里不重新定义（休眠标签仍能 hover 到，已关闭的标签预览早就被收起了）。
  const sleeping = typeof wcm.isTabSleeping === 'function' ? Boolean(wcm.isTabSleeping(tabId)) : !wc
  if (!wc) return { tabId, sleeping, ...UNKNOWN }

  try {
    if (typeof wc.isDestroyed === 'function' && wc.isDestroyed()) {
      return { tabId, sleeping: true, ...UNKNOWN }
    }
    const pid = Number(wc.getOSProcessId()) || 0
    if (!pid) return { tabId, sleeping: false, ...UNKNOWN }
    // 同一 pid 只会有一条 renderer 记录；`find` 而不是建表 —— 每次只问一个标签。
    const metric = getMetrics().find((m) => Number(m.pid) === pid)
    // 口径取「独占内存」——见 main/process-memory.ts 的实测数字与理由。
    // 拿工作集显示会让任何页面都虚高约 4 倍（那 86 MB 是共享基线，不是这个页面占的）。
    const kb = privateMemoryKB(metric && metric.memory)
    return { tabId, sleeping: false, memoryKB: kb }
  } catch (_) {
    // 进程刚好在两次调用之间没了（导航崩溃 / 正在销毁）：当作"这一刻查不到"，
    // 而不是把它报成休眠 —— 消费方据此只是不显示这一行。
    return { tabId, sleeping: false, ...UNKNOWN }
  }
}

export function registerTabMemoryIpc(
  typedMain: IpcTypedMain,
  { routes, schemas, getAppMetrics, webContentsManager }: Deps
): void {
  if (!routes?.tabMemory || !getAppMetrics) return
  if (!schemas?.request || !schemas?.response) {
    // 与 snapshot 同款显式告警而不是静默早退：漏注册的表现是「hover 预览没有内存行」，
    // 与「这一刻本来查不到」极难区分，必须有日志可查。
    console.error('[tab-memory] registerTabMemoryIpc skipped: schemas.request/response missing')
    return
  }

  /** TTL 内的指标快照（见 METRICS_TTL_MS）。 */
  let cached: ProcessMetricLike[] = []
  let cachedAt = 0
  const metricsSnapshot = (): ProcessMetricLike[] => {
    const t = Date.now()
    if (t - cachedAt < METRICS_TTL_MS) return cached
    try {
      cached = getAppMetrics() || []
    } catch (_) {
      cached = []
    }
    cachedAt = t
    return cached
  }

  typedMain.handle(routes.tabMemory, {
    requestSchema: schemas.request,
    responseSchema: schemas.response,
    handler: async (_e, req) => readTabMemory(String(req.tabId), webContentsManager, metricsSnapshot)
  })
}

