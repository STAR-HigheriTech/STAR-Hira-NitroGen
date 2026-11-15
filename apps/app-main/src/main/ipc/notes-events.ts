/**
 * IPC · Note 事件中继 —— domain 变更 → 转成 `note:changed` 广播。
 *
 * 与 bookmark-events.js 逐字同构：domain-notes 是唯一变更事实源，本模块是 APPS 层的
 * 转译器，广播出口注入登记制 broadcaster（谁订阅谁收到）。
 * 任何写路径（IPC 调用、未来的导入/插件 API）只要走 domain，这里都会收到通知。
 */

import type { BroadcasterPort, EventRelay, SubscriptionService } from './types'

export const NOTE_EVENT_ROUTE = 'note:changed'

interface NoteChange { reason: string; id: string | null }

/**
 * @param {{ subscribe: (fn: (change: { reason: string, id: string|null }) => void) => () => void }} noteService
 * @param {{ send: (route: string, payload: any, opts?: object) => number }} broadcaster
 */
export function createNoteEventRelay(
  noteService: SubscriptionService<NoteChange> | null | undefined,
  broadcaster: BroadcasterPort | null | undefined
): EventRelay {
  if (!noteService || typeof noteService.subscribe !== 'function') {
    return { start() {}, stop() {} }
  }
  const send = broadcaster && typeof broadcaster.send === 'function' ? broadcaster.send : null
  let unsubscribe: (() => void) | null = null

  return {
    start() {
      if (unsubscribe) return
      unsubscribe = noteService.subscribe((change) => {
        if (!send) return
        send(NOTE_EVENT_ROUTE, { reason: change.reason, id: change.id })
      })
    },
    stop() {
      if (unsubscribe) {
        unsubscribe()
        unsubscribe = null
      }
    }
  }
}

