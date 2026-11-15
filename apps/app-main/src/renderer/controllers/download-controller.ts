/**
 * download-controller.js —— 下载栏控制器（组件装配 + 列表获取）
 *
 * 从 app-shell/main.js 抽出的内聚控制器：
 *   · 装配 ui-download-bar 哑组件（打开/移除意图 → provider）
 *   · **事件驱动**更新（原先是 1500ms 无条件轮询）
 *
 * ── 为什么改事件驱动 ────────────────────────────────────────────────
 * 组件自己**早就写好了订阅路径**（`subscribe('download:progress'…)` 在组件内部
 * 拿 payload 原地更新进度条 / 速度曲线 / ETA，不整表重排、不需额外 IPC；见
 * ui-download-bar/src/index.js），但调用方从来没把 `subscribe` 传进去 ——
 * 于是进度只能靠本文件的轮询 `download:list` 来喂：
 * **窗口可见时 40 次 IPC/分钟、永远**，哪怕一个下载都没有。
 *
 * 现在的分工（三条腿，代价从低到高）：
 *   · `download:progress` → 组件内部**原地**更新收起态进度条 / 速度曲线（零 IPC）；
 *     同时通知本控制器**合并**成 1.5s 一档补一次列表 —— 展开列表里每一行的
 *     "已下载大小"是 `renderList` 一次性画出来的，不重列就是死数。合并必须有：
 *     progress 是逐帧级事件，逐条拉列表就是 IPC 风暴。
 *   · `download:done`     → 立刻补一次 `refresh()`（完成项要落进历史列表，
 *                            组件只把它从 activeDownloads 摘掉）。
 *   · 兜底轮询 15s        → 只为收敛**没有事件覆盖**的带外变化
 *                            （别的窗口 / 下载面板里删了某一项、清空了已完成）。
 *     `document.hidden` 时照旧跳过：窗口不可见时不唤醒主进程。
 *
 * 净效果：**空闲时零 IPC**（原来是 40 次/分钟、永远）；
 * 下载中与原来同频（1.5s 一档），所以没有任何"变慢"的地方。
 *
 * 彻底解耦：provider / subscribe / document 注入，不 import bridge、不读全局。
 */

import { IPC_EVENTS, IPC_ROUTES } from '@hira-ng/shared-types/src/ipc-channels.mjs'
import { createDownloadBar } from '@hira-ng/ui-download-bar'
import { errorMessage } from '../shared/error-message.js'

/**
 * 下载进行中时的列表合并间隔（毫秒）。
 *
 * 与改造前的轮询同频 —— 也就是说"下载中"这一段**没有任何降级**，
 * 只是不再"空闲时也照跑"。
 */
const ACTIVE_SYNC_MS = 1500

/**
 * 兜底轮询间隔（毫秒）。
 *
 * 只用于"列表被带外改动"这一种情况（没有对应事件可订），故取得**很慢**：
 * 事件才是主路径，这里只是保证最终一致 —— 15s 内收敛，代价 4 次 IPC/分钟。
 */
const IDLE_SYNC_POLL_MS = 15000

interface DownloadControllerDeps {
  provider: {
    invoke<T = Record<string, unknown>>(route: string, payload?: unknown): Promise<T>
  }
  subscribe?: (route: string, listener: (payload: unknown) => void) => () => void
  document: Document
  isFeatureAvailable?(featureId: string): boolean
}

/**
 * @param {object} deps
 * @param {object} deps.provider   window.hira.provider
 * @param {(route: string, fn: Function) => Function} [deps.subscribe]
 *   IPC 事件订阅口（window.hira.on.subscribe 的形态：返回退订函数）。
 *   注入而不是直接读 window.hira：控制器不认识桥、只认识"给我一个订阅口"。
 * @param {Document} deps.document
 * @param {(featureId:string) => boolean} [deps.isFeatureAvailable] 引擎可用性查询（§10.4）。
 *   注入而非 import：控制器不认识插件系统，只认识"给我一个布尔"这个契约。
 */
export function createDownloadController({ provider, subscribe, document, isFeatureAvailable }: DownloadControllerDeps) {
  const featureAvailable = typeof isFeatureAvailable === 'function' ? isFeatureAvailable : () => true
  /** 订阅口缺省为空实现：调用方没给就退化成"只有兜底轮询"，不会抛。 */
  const on = typeof subscribe === 'function' ? subscribe : () => () => {}

  const downloadBar = createDownloadBar({
    doc: document,
    invoke: (route, payload) => provider.invoke(route, payload),
    // ★ 关键：把订阅口交进去，组件内部就能用 progress 事件原地推进度
    //   （见 ui-download-bar 的 subscribe('download:progress'…)）。之前没传，
    //   进度只能靠本文件轮询 download:list 喂 —— 这是那个 1.5s 轮询的由来。
    subscribe: on,
    onOpen: async (filePath) => {
      try { await provider.invoke(IPC_ROUTES.downloadOpen, { filePath }) } catch {}
    },
    onRemove: async (id) => {
      try { await provider.invoke(IPC_ROUTES.downloadRemove, { id }) } catch {}
    }
  })
  document.body.appendChild(downloadBar.element)

  let disposed = false
  let refreshRevision = 0
  /**
   * 下载引擎是否还在（§10.4 联动禁用）。
   *
   * 引擎被禁用时**必须停掉**，不能只是把条藏起来 —— 兜底同步会去拉
   * `download:list`，而引擎关掉后那次调用必然失败：白白唤醒主进程 + 刷一屏错误。
   * 这与文件头那条"窗口不可见时绝不唤醒主进程"是同一条原则。
   */
  let engineAvailable = featureAvailable('downloads')
  /** 兜底同步定时器句柄 */
  let timer: ReturnType<typeof setInterval> | null = null
  /** `download:progress` 触发的那次**合并**列表同步（见 scheduleListSync） */
  let listSyncTimer: ReturnType<typeof setTimeout> | null = null
  /** 事件退订函数（引擎禁用 / 窗口收尾时调用） */
  let unsubscribeDone: (() => void) | null = null
  let unsubscribeProgress: (() => void) | null = null

  async function refresh() {
    if (disposed || !engineAvailable) return
    const revision = ++refreshRevision
    try {
      const list = await provider.invoke(IPC_ROUTES.downloadList)
      if (!disposed && engineAvailable && revision === refreshRevision && Array.isArray(list)) {
        downloadBar.refreshList(list)
      }
    } catch {}
  }

  /**
   * 兜底同步表：**很慢**地拉一次列表。
   *
   * 只收敛没有事件覆盖的带外变化（别的窗口 / 下载面板里删了某项、清空已完成），
   * 所以间隔取得很大 —— 事件才是主路径。`document.hidden` 跳过：
   * 窗口不可见时绝不为无人在看的进度条唤醒主进程。
   */
  function startIdleSync() {
    if (timer || disposed || document.hidden) return
    timer = setInterval(() => {
      if (document.hidden) {
        stopIdleSync()
        return
      }
      refresh()
    }, IDLE_SYNC_POLL_MS)
  }

  function stopIdleSync() {
    if (!timer) return
    clearInterval(timer)
    timer = null
  }

  /**
   * 可见性变化是这条轮询唯一的启停信号：隐藏时连定时器都不保留，
   * 回来时先补一次最新列表再恢复 15s 的慢校准。
   */
  const onVisibilityChange = (): void => {
    if (document.hidden) {
      stopIdleSync()
      return
    }
    if (!engineAvailable || disposed) return
    startIdleSync()
    refresh()
  }
  try { document.addEventListener('visibilitychange', onVisibilityChange) } catch (_) {}

  /**
   * 把 `download:progress` 合并成 **1.5s 一档**的列表同步（不重置：见下）。
   *
   * 为什么组件都原地更新了、这里还要拉列表：组件只更新**收起态那条进度条**与
   * 选中项的详情；展开列表里每一行的"已下载大小"是 `renderList` 一次画出来的，
   * 不重列就是死数（用户展开下载栏时最在意的恰恰是这个）。
   *
   * 为什么**不重置定时器**（用固定时间窗而不是"静默后才拉"的防抖）：progress 是
   * 持续事件，重置式防抖会让它在整个下载过程中**一次都不触发**；固定窗保证
   * 有界的新鲜度（与 1.5s 轮询同频），且**没有下载时事件不来 → 一次都不拉**。
   */
  function scheduleListSync() {
    if (listSyncTimer || disposed) return
    listSyncTimer = setTimeout(() => {
      listSyncTimer = null
      refresh()
    }, ACTIVE_SYNC_MS)
  }

  function stopListSync() {
    if (!listSyncTimer) return
    clearTimeout(listSyncTimer)
    listSyncTimer = null
  }

  /**
   * 事件订阅：`progress`（合并后补列表）+ `done`（立刻补列表）。
   *
   * 为什么 `done` 要"立刻"而不是并入上面那个窗口：完成项必须马上出现在历史列表里，
   * 且频率是**每个下载一次**，不值得为它省。
   */
  function startEventSync() {
    if (unsubscribeDone || disposed) return
    try {
      const offDone = on(IPC_EVENTS.downloadDone, () => {
        stopListSync()
        refresh()
      })
      unsubscribeDone = typeof offDone === 'function' ? offDone : () => {}
    } catch (e) {
      console.error('[download] subscribe download:done failed:', errorMessage(e))
    }
    try {
      const offProgress = on(IPC_EVENTS.downloadProgress, () => { scheduleListSync() })
      unsubscribeProgress = typeof offProgress === 'function' ? offProgress : () => {}
    } catch (e) {
      console.error('[download] subscribe download:progress failed:', errorMessage(e))
    }
  }

  function stopEventSync() {
    stopListSync()
    if (unsubscribeDone) {
      try { unsubscribeDone() } catch (_) {}
      unsubscribeDone = null
    }
    if (unsubscribeProgress) {
      try { unsubscribeProgress() } catch (_) {}
      unsubscribeProgress = null
    }
  }

  /**
   * 引擎可用性变化的收敛点（由编排层在 `onFeaturesChanged` 里调用）。幂等。
   */
  function syncEngineAvailability() {
    const next = featureAvailable('downloads')
    if (next === engineAvailable) return
    engineAvailable = next
    if (next) {
      startEventSync()
      startIdleSync()
      refresh()
    } else {
      stopEventSync()
      stopIdleSync()
      // 清空而不是留着旧列表：引擎不在了，那些行点开也会失败
      downloadBar.refreshList([])
    }
  }

  if (engineAvailable) {
    startEventSync()
    startIdleSync()
    refresh()
  }

  return {
    element: downloadBar.element,
    refresh,
    syncEngineAvailability,
    /** 停止事件订阅与兜底同步（app-shell 场景下与页面同生命周期，一般无需手动调用） */
    dispose() {
      if (disposed) return
      disposed = true
      refreshRevision += 1
      stopEventSync()
      stopIdleSync()
      try { document.removeEventListener('visibilitychange', onVisibilityChange) } catch (_) {}
      downloadBar.element.remove()
    }
  }
}

