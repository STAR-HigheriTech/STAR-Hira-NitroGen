/**
 * IPC · Bookmark 事件中继 —— domain 变更 → 转成事件广播。
 *
 * 设计（分层各归其位）：
 *   - domain-bookmark 充当"唯一变更事实源"，只发域内小 payload；
 *   - 本模块是 APPS 层的**转译器**：把域事件翻成 `bookmark:changed` 事件；
 *   - 广播出口注入 `send(route, payload)`（= infra-ipc 的 broadcaster.send），
 *     由它只发给**登记过订阅**的渲染进程。
 *
 * 历史坑：这里曾经硬编码「只广播 chrome 层 webContents」的过滤，于是内部页
 * （bookmarks 页跑在**标签页**里）订阅了 `bookmark:changed` 却永远收不到。
 * 改成登记制后，只要订阅了就收得到，与它住在哪个图层无关。
 *
 * IPC handler 不需要逐个 broadcast：任何写路径（IPC 调用、导入、未来的
 * 扩展 API）只要走 bookmarkService，这里都会收到通知 —— 单点收口。
 */

import type { BroadcasterPort, EventRelay, SubscriptionService } from './types'

const { IPC_EVENTS } = require('@hira-ng/shared-types/src/ipc-channels.mjs') as {
  IPC_EVENTS: { bookmarkChanged: string }
}

interface BookmarkChange { reason: string; id: string | null; url: string | null }

/** 通道名只有一份真源（ipc-channels.mjs），本模块不再手抄字面量。 */
export const BOOKMARK_EVENT_ROUTE = IPC_EVENTS.bookmarkChanged

/**
 * @param {{ subscribe: (fn: (change: {reason:string,id:string|null,url:string|null}) => void) => () => void }} bookmarkService
 * @param {{ send: (route:string, payload:any, opts?:object) => number }} broadcaster 事件出口
 */
export function createBookmarkEventRelay(
  bookmarkService: SubscriptionService<BookmarkChange> | null | undefined,
  broadcaster: BroadcasterPort | null | undefined
): EventRelay {
  if (!bookmarkService || typeof bookmarkService.subscribe !== 'function') {
    return { start() {}, stop() {} }
  }
  const send = broadcaster && typeof broadcaster.send === 'function' ? broadcaster.send : null

  let unsubscribe: (() => void) | null = null

  function broadcast(change: BookmarkChange): void {
    if (!send) return
    send(BOOKMARK_EVENT_ROUTE, {
      reason: change.reason,
      id: change.id,
      url: change.url
    })
  }

  return {
    start() {
      if (unsubscribe) return
      unsubscribe = bookmarkService.subscribe(broadcast)
    },
    stop() {
      if (unsubscribe) {
        unsubscribe()
        unsubscribe = null
      }
    }
  }
}

