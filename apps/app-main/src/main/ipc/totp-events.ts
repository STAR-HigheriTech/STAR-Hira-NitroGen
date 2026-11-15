/**
 * IPC · TOTP 事件中继 —— domain 变更 → 转成 `totp:changed` 广播。
 *
 * 与 notes-events.js / bookmark-events.js 逐字同构：domain-totp 是唯一变更事实源，
 * 本模块是 APPS 层的转译器，广播出口注入登记制 broadcaster（谁订阅谁收到）。
 *
 * 为什么需要它：验证器可能同时开着**侧栏面板**与**插件管理窗口**（甚至两个空间各一个），
 * 一处导入/改名/删除后，另一处必须跟着对账 —— 否则用户会看到"我在窗口里删了，
 * 面板里还在"。任何写路径只要走 domain，这里就会收到通知。
 *
 * 注意它**不负责验证码**：验证码是渲染层自己按 `remaining` 跨窗重取的
 * （见 domain-totp#code 的 `now`），不走广播 —— 每 30 秒推一次事件给所有窗口
 * 只为了几个数字，是没必要的唤醒。
 */

import type { BroadcasterPort, EventRelay, SubscriptionService } from './types'

export const TOTP_EVENT_ROUTE = 'totp:changed'

interface TotpChange { reason: string; id: string | null }

/**
 * @param {{ subscribe: (fn: (change: { reason: string, id: string|null }) => void) => () => void }} totpService
 * @param {{ send: (route: string, payload: any, opts?: object) => number }} broadcaster
 */
export function createTotpEventRelay(
  totpService: SubscriptionService<TotpChange> | null | undefined,
  broadcaster: BroadcasterPort | null | undefined
): EventRelay {
  if (!totpService || typeof totpService.subscribe !== 'function') {
    return { start() {}, stop() {} }
  }
  const send = broadcaster && typeof broadcaster.send === 'function' ? broadcaster.send : null
  let unsubscribe: (() => void) | null = null

  return {
    start() {
      if (unsubscribe) return
      unsubscribe = totpService.subscribe((change) => {
        if (!send) return
        send(TOTP_EVENT_ROUTE, { reason: change.reason, id: change.id })
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

