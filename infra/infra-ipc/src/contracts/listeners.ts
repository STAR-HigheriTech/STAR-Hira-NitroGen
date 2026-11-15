import { z } from 'zod'

/**
 * Listeners 契约 —— 事件订阅登记（对齐 RT `listeners:add` / `listeners:remove`）。
 *
 * 两条消息都由 preload 在 `hira.on.subscribe()` / 退订时发出，用 `ipcMain.on`
 * 处理（fire-and-forget，不需要返回值）。虽然不走 typed invoke，但仍按
 * CONTRACT-04 给出 Zod 校验：渲染层传进来的东西一律先过 schema 再用。
 *
 * listenerId 由渲染层生成并在退订时回传；主进程用它做「只能退掉自己那条」的鉴权。
 */
const listenersSchemas = Object.freeze({
  add: Object.freeze({
    request: z.object({
      channel: z.string().min(1).max(200),
      listenerId: z.string().min(1).max(200)
    })
  }),
  remove: Object.freeze({
    request: z.object({
      listenerId: z.string().min(1).max(200)
    })
  })
})

export { listenersSchemas }

