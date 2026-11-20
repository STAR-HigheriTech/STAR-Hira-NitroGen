/**
 * IPC · Favicon 事件中继 —— 图标缓存回填 → 转成事件广播。
 *
 * 历史写入可能先于页面图标到达；这里不重发历史变更，而是单独广播
 * "图标已补齐"。订阅方按站点更新展示，避免整列表重拉。
 */

import type { BroadcasterPort, EventRelay, SubscriptionService } from './types'

const { IPC_EVENTS } = require('@hira-ng/shared-types/src/ipc-channels.mjs') as {
  IPC_EVENTS: { faviconChanged: string }
}

interface FaviconChange {
  url?: unknown
  origin?: unknown
  favicon?: unknown
}

export const FAVICON_EVENT_ROUTE = IPC_EVENTS.faviconChanged

export function createFaviconEventRelay(
  faviconService: SubscriptionService<FaviconChange> | null | undefined,
  broadcaster: BroadcasterPort | null | undefined
): EventRelay {
  if (!faviconService || typeof faviconService.subscribe !== 'function') {
    return { start() {}, stop() {} }
  }
  const send = broadcaster && typeof broadcaster.send === 'function' ? broadcaster.send : null

  let unsubscribe: (() => void) | null = null

  function broadcast(change: FaviconChange): void {
    if (!send || !change) return
    const url = String(change.url || '')
    const favicon = String(change.favicon || '')
    if (!url || !favicon) return
    send(FAVICON_EVENT_ROUTE, {
      url,
      origin: String(change.origin || ''),
      favicon
    })
  }

  return {
    start() {
      if (!unsubscribe) unsubscribe = faviconService.subscribe(broadcast)
    },
    stop() {
      if (unsubscribe) {
        unsubscribe()
        unsubscribe = null
      }
    }
  }
}
