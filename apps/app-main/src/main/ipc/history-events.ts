/**
 * IPC · History 事件中继 —— domain 变更 → 转成事件广播。
 *
 * 与 bookmark-events 同构：domain-history 是唯一变更事实源，本模块只做转译，
 * 广播出口注入 `send(route, payload)`（= infra-ipc 的 broadcaster.send），
 * 由它只发给**登记过订阅**的渲染进程 —— 因此内部页（跑在标签页里的
 * hira://history）也能真正收到，不再被「只广播 chrome 层」的历史过滤漏掉。
 */

import type { BroadcasterPort, EventRelay, SubscriptionService } from './types'

const { IPC_EVENTS } = require('@hira-ng/shared-types/src/ipc-channels.mjs') as {
  IPC_EVENTS: { historyChanged: string }
}

interface HistoryChange {
  action?: unknown
  count?: unknown
  id?: unknown
  url?: unknown
  urls?: unknown
  before?: unknown
}

/** 通道名只有一份真源（ipc-channels.mjs），本模块不再手抄字面量。 */
export const HISTORY_EVENT_ROUTE = IPC_EVENTS.historyChanged

/**
 * @param {{ subscribe?: (fn: (change: object) => void) => () => void }} historyService
 * @param {{ send: (route:string, payload:any, opts?:object) => number }} broadcaster 事件出口
 */
export function createHistoryEventRelay(
  historyService: SubscriptionService<HistoryChange> | null | undefined,
  broadcaster: BroadcasterPort | null | undefined
): EventRelay {
  if (!historyService || typeof historyService.subscribe !== 'function') {
    return { start() {}, stop() {} }
  }
  const send = broadcaster && typeof broadcaster.send === 'function' ? broadcaster.send : null

  let unsubscribe: (() => void) | null = null

  function broadcast(change: HistoryChange): void {
    if (!send || !change) return
    send(HISTORY_EVENT_ROUTE, {
      action: change.action,
      count: change.count,
      id: change.id,
      url: change.url,
      urls: change.urls,
      before: change.before
    })
  }

  return {
    start() {
      if (!unsubscribe) unsubscribe = historyService.subscribe(broadcast)
    },
    stop() {
      if (unsubscribe) {
        unsubscribe()
        unsubscribe = null
      }
    }
  }
}

