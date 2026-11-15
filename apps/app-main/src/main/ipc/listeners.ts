/**
 * IPC · Listeners 域 —— 事件订阅登记（对齐 RT `ipc/listeners-manager.ts`）。
 *
 * 通道：`ngipc:send:listeners:add` / `ngipc:send:listeners:remove`
 * 用 `ipcMain.on`（fire-and-forget）而不是 typed invoke：登记/退订不需要返回值，
 * 走 invoke 会给每个订阅点凭空造一个 Promise 与一次往返。
 * 载荷仍按 CONTRACT-04 过 Zod 校验（见 contracts/listeners.js）。
 *
 * 必须在**任何 renderer 加载之前**注册 —— preload 在 subscribe 的同一 tick 就会
 * 把 add 发出来，晚一步注册就会丢登记（表现为「订阅了但收不到事件」）。
 */

import { makeChannel } from '@hira-ng/infra-ipc'
import type { IpcMain } from 'electron'

const { IPC_ROUTES } = require('@hira-ng/shared-types/src/ipc-channels.mjs') as {
  IPC_ROUTES: { listenersAdd: string; listenersRemove: string }
}

interface ListenerRegistryPort {
  add(sender: unknown, channel: string, listenerId: string): unknown
  remove(sender: unknown, listenerId: string): unknown
}

interface ListenerSchemaPort<T> { safeParse(value: unknown): { success: true; data: T } | { success: false } }
interface ListenerIpcOptions {
  schemas?: {
    add?: { request: ListenerSchemaPort<{ channel: string; listenerId: string }> }
    remove?: { request: ListenerSchemaPort<{ listenerId: string }> }
  }
  policy?: {
    authorizeSender(event: unknown): boolean
    authorizeEventSubscription(event: unknown, route: string): boolean
  }
}

export function registerListenerIpc(ipcMain: IpcMain, registry: ListenerRegistryPort, { schemas, policy }: ListenerIpcOptions = {}): void {
  if (!ipcMain || !registry) return
  const addSchema = schemas && schemas.add ? schemas.add.request : null
  const removeSchema = schemas && schemas.remove ? schemas.remove.request : null
  const allowSender = (event: unknown): boolean => {
    if (!policy) return true
    try { return policy.authorizeSender(event) === true } catch (_) { return false }
  }

  ipcMain.on(makeChannel('ngipc', 'send', IPC_ROUTES.listenersAdd), (event, payload) => {
    if (!allowSender(event)) return
    const req = addSchema ? addSchema.safeParse(payload) : { success: true, data: payload }
    if (!req.success) return
    if (policy) {
      try {
        if (policy.authorizeEventSubscription(event, req.data.channel) !== true) return
      } catch (_) {
        return
      }
    }
    registry.add(event.sender, req.data.channel, req.data.listenerId)
  })

  ipcMain.on(makeChannel('ngipc', 'send', IPC_ROUTES.listenersRemove), (event, payload) => {
    if (!allowSender(event)) return
    const req = removeSchema ? removeSchema.safeParse(payload) : { success: true, data: payload }
    if (!req.success) return
    registry.remove(event.sender, req.data.listenerId)
  })
}

