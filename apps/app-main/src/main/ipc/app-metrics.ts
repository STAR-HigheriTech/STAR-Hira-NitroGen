/**
 * IPC · AppMetrics 域（TypeScript）—— Chromium 风格任务管理器
 *
 * 数据只能由主进程提供：`app.getAppMetrics()` 给出每个进程的 type / CPU / 内存，
 * 再配合各 WebContents 的 OS 进程号，才能把「某个 renderer 占了多少内存」
 * 归到具体标签上。渲染进程无论如何都算不出这些数字 —— 本文件不做任何估算。
 *
 * 只在用户打开任务管理器时按需调用，不参与任何热路径（`getAppMetrics` 会遍历
 * 全部子进程，属于中等开销的同步调用）。
 *
 * 内存字段的口径见 `main/process-memory.ts`（唯一真源，与标签 hover 预览共用）——
 * 两者必须同源，否则会出现「任务管理器说 180 MB、预览说 120 MB」这种肉眼才能发现的不一致。
 */

import { privateMemoryKB } from '../process-memory'

interface ProcessMetricLike {
  pid: number
  type: string
  cpu?: { percentCPUUsage?: number }
  memory?: { workingSetSize?: number; privateBytes?: number }
}

interface WebContentsLike {
  getOSProcessId(): number
  isDestroyed?: () => boolean
}

interface TabManagerLike {
  list(): Array<{ tabId: string; title?: string; url?: string }>
  getActiveTabId(): string | null
}

interface WcmLike {
  getTab(tabId: string): { webContents?: WebContentsLike } | null
  listChromeWebContents(): WebContentsLike[]
}

import type { IpcSchemas, IpcTypedMain } from './types'

interface Deps {
  routes?: Record<string, string>
  schemas?: IpcSchemas['app']
  getAppMetrics?: () => ProcessMetricLike[]
  tabManager?: TabManagerLike | null
  webContentsManager?: WcmLike | null
}

/** OS 进程号 → 人类可读归属（标签标题 / 界面图层名）。 */
function collectOwners(tabManager: TabManagerLike | null | undefined, wcm: WcmLike | null | undefined) {
  const owners = new Map<number, string>()
  const add = (wc: WebContentsLike | null | undefined, label: string) => {
    if (!wc) return
    try {
      if (typeof wc.isDestroyed === 'function' && wc.isDestroyed()) return
      const pid = wc.getOSProcessId()
      if (pid) owners.set(pid, label)
    } catch (_) {}
  }

  if (tabManager && wcm) {
    let tabs: ReturnType<TabManagerLike['list']> = []
    try { tabs = tabManager.list() || [] } catch (_) {}
    if (Array.isArray(tabs)) {
      for (const tab of tabs) {
        if (!tab || !tab.tabId) continue
        let view: ReturnType<WcmLike['getTab']> = null
        try { view = wcm.getTab(tab.tabId) } catch (_) {}
        add(view && view.webContents, `标签：${tab.title || tab.url || tab.tabId}`)
      }
    }
  }
  if (wcm && typeof wcm.listChromeWebContents === 'function') {
    let chrome: WebContentsLike[] = []
    try { chrome = wcm.listChromeWebContents() || [] } catch (_) {}
    if (Array.isArray(chrome)) {
      for (const wc of chrome) add(wc, '浏览器界面')
    }
  }
  return owners
}

export function registerAppMetricsIpc(
  typedMain: IpcTypedMain,
  { routes, schemas, getAppMetrics, tabManager, webContentsManager }: Deps
): void {
  if (!routes?.appMetrics || !schemas?.metrics || !getAppMetrics) return

  typedMain.handle(routes.appMetrics, {
    requestSchema: schemas.metrics.request,
    responseSchema: schemas.metrics.response,
    handler: async () => collectAppMetrics({ getAppMetrics, tabManager, webContentsManager })
  })

  if (!routes.appKillProcess || !schemas.killProcess) return
  typedMain.handle(routes.appKillProcess, {
    requestSchema: schemas.killProcess.request,
    responseSchema: schemas.killProcess.response,
    handler: async (event, rawReq) => {
      const req = rawReq && typeof rawReq === 'object' ? rawReq as { pid?: unknown } : null
      const pid = Number(req?.pid)
      const metrics = collectAppMetrics({ getAppMetrics, tabManager, webContentsManager }).metrics
      const target = metrics.find((metric) => metric.pid === pid)
      if (!target) return { ok: false, reason: '进程已退出，或不属于当前应用' }
      if (pid === process.pid) return { ok: false, reason: '不能结束浏览器主进程' }

      const sender = event && typeof event === 'object'
        ? (event as { sender?: { getOSProcessId?: () => number } }).sender
        : undefined
      const senderPid = Number(typeof sender?.getOSProcessId === 'function' ? sender.getOSProcessId() : 0)
      if (pid === senderPid) return { ok: false, reason: '不能结束当前任务管理器所在的进程' }

      try {
        process.kill(pid)
        return { ok: true }
      } catch (error) {
        return {
          ok: false,
          reason: error instanceof Error ? error.message : '结束进程失败'
        }
      }
    }
  })
}

/**
 * 任务管理器的**唯一取数实现** —— IPC 路由与 AI 工具（`tasks_list`）共用。
 *
 * 内存口径必须走 `privateMemoryKB`（见 main/process-memory.ts）：AI 侧若自己算
 * `workingSetSize`，同一个进程会在对话框里显示成任务管理器的 4 倍，用户只会认为
 * 其中一边在骗人。
 */
export function collectAppMetrics(
  { getAppMetrics, tabManager, webContentsManager }: Deps
): { metrics: Array<{ pid: number; type: string; name: string; cpuPercent: number; memoryKB: number; owner: string | null }> } {
  const owners = collectOwners(tabManager, webContentsManager)
  let rawMetrics: ProcessMetricLike[] = []
  try {
    const value = typeof getAppMetrics === 'function' ? getAppMetrics() : []
    if (Array.isArray(value)) rawMetrics = value
  } catch (_) {}
  const metrics = rawMetrics.map((m) => ({
    pid: Number(m.pid) || 0,
    type: String(m.type || 'unknown'),
    name: String(m.type || 'unknown'),
    cpuPercent: Number(m.cpu?.percentCPUUsage ?? 0),
    // 口径 = 独占内存（见 main/process-memory.ts）。单位是 KB，主进程不做换算，
    // 换算与取整由渲染侧共享的 format-size.mjs 一处负责。
    memoryKB: privateMemoryKB(m.memory) ?? 0,
    owner: owners.get(Number(m.pid)) ?? null
  }))
  // 内存降序：任务管理器的默认视图就是「谁最占内存」
  metrics.sort((a, b) => b.memoryKB - a.memoryKB)
  return { metrics }
}

