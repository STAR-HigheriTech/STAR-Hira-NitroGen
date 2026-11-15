/**
 * download-activity.js —— 「有下载在跑」这一条布尔在渲染侧的**唯一驱动**（rail / navbar 共用）
 *
 * 为什么单独一个模块：
 *   · rail 与 navbar 是**两个独立 renderer**，但红点语义必须一致（同一份事件、同一份去重）；
 *   · 谁需要红点就 `createDownloadActivityWatcher` 一次，不各写一遍订阅 + 初始读数。
 *   · 本模块不认识红点长什么样：只交 `onChange(active: boolean)`，怎么画由宿主决定。
 *
 * 开销口径（与项目"空闲零 IPC"一致）：
 *   · 事件只在**跃迁**时发（主进程 download-manager 的 syncActivity），不是每拍进度；
 *   · 这里再做一次**幂等去重**：同值不回调，宿主因此连 class 都不用碰；
 *   · 启动只补**一次** `download:active` 读数（覆盖"下载早于视图订阅"的窗口期），无轮询。
 *   · 迟到的读数不会盖掉新事件：用事件序号判断期间是否有跃迁。
 *
 * 彻底解耦：provider / subscribe 注入，不 import bridge、不读全局。
 */

import { IPC_EVENTS, IPC_ROUTES } from '@hira-ng/shared-types/src/ipc-channels.mjs'

interface DownloadActivityDeps {
  provider: { invoke<T = Record<string, unknown>>(route: string, payload?: unknown): Promise<T> }
  subscribe?: <T>(route: string, listener: (payload: T) => void) => () => void
  onChange(active: boolean): void
}

/**
 * @param {object} deps
 * @param {object} deps.provider window.hira.provider（invoke 口）
 * @param {(route: string, fn: Function) => Function} [deps.subscribe]
 *   window.hira.on.subscribe 的形态（返回退订函数）。缺省 = 只有初始读数，不订阅。
 * @param {(active: boolean) => void} deps.onChange 活动态变化回调（已去重）
 * @returns {{ active: boolean, dispose: () => void }}
 */
export function createDownloadActivityWatcher({ provider, subscribe, onChange }: DownloadActivityDeps) : { active: boolean, dispose: () => void } {
  let active = false
  let disposed = false
  /** 事件序号：只用来识别"初始读数返回前是否已有跃迁"（见下）。 */
  let eventSeq = 0

  const apply = (next: unknown): void => {
    if (disposed) return
    const value = !!next
    // 幂等：同值不回调 —— 宿主侧连 DOM 都不碰，这是红点能"零稳态开销"的关键。
    if (value === active) return
    active = value
    try { onChange(value) } catch (_) {}
  }

  // 先订阅、后取初始读数：订阅前的跃迁由这次读数兜住，订阅后的跃迁由事件覆盖。
  const unsubscribe = typeof subscribe === 'function'
    ? subscribe<{ active?: boolean }>(IPC_EVENTS.downloadActivity, (payload) => {
        eventSeq += 1
        apply(payload && payload.active)
      })
    : () => {}

  const seqAtQuery = eventSeq
  Promise.resolve()
    .then(() => provider.invoke<{ active?: number }>(IPC_ROUTES.downloadActive))
    .then((res) => {
      if (disposed) return
      // 读数在途期间已有事件到达 → 事件更新，丢弃这次（可能更旧的）快照。
      if (eventSeq !== seqAtQuery) return
      const count = typeof res?.active === 'number' && Number.isFinite(res.active) ? res.active : 0
      apply(count > 0)
    })
    .catch(() => {})

  return {
    get active() { return active },
    dispose() {
      if (disposed) return
      disposed = true
      try { unsubscribe() } catch (_) {}
    }
  }
}

