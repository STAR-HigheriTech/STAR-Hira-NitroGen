/**
 * IPC · Slots 域 —— 渲染侧插槽宿主（PART7 §7.3 的跨进程那一半）。
 *
 * 这一层刻意做得极薄：它只把请求转给 `slotRenderer`（APPS 的 `main/slot-render.js`，
 * 那里才是「执行插槽 / 剥函数 / 按 key 派发」的全部策略），并保证
 * **渲染层拿不到调度器本身** —— 渲染层只能通过这两个白名单通道间接使用插槽。
 *
 * 为什么调度器不能直接交给渲染层：
 *   `callSync` / `implement` 一旦暴露给渲染进程，任何内部页都能读写插槽表
 *   （包括把某个插槽的实现整个替换掉）。能力必须收在主进程，渲染层只拿产物。
 */

import type { IpcRoutes, IpcSchemas, IpcTypedMain } from './types'

interface SlotRendererPort {
  render(slotId: string, payload: unknown): unknown | Promise<unknown>
  dispatch(slotId: string, key: string, payload: unknown): unknown | Promise<unknown>
}

interface SlotsIpcContext {
  routes: IpcRoutes
  schemas: IpcSchemas['slots']
  slotRenderer?: SlotRendererPort | null
}

export function registerSlotsIpc (typedMain: IpcTypedMain, ctx: SlotsIpcContext): SlotRendererPort {
  const { routes, schemas, slotRenderer } = ctx
  const noop: SlotRendererPort = { render: () => ({ items: [] }), dispatch: async () => ({ ok: false, reason: '插槽宿主未就绪' }) }
  if (!typedMain || !routes || !routes.slotsRender) return noop
  const renderer = slotRenderer || noop

  typedMain.handle(routes.slotsRender, {
    requestSchema: schemas.render.request,
    responseSchema: schemas.render.response,
    handler: async (_e, req) => renderer.render(req.slotId, req.payload)
  })

  typedMain.handle(routes.slotsDispatch, {
    requestSchema: schemas.dispatch.request,
    responseSchema: schemas.dispatch.response,
    handler: async (_e, req) => renderer.dispatch(req.slotId, req.key, req.payload)
  })

  return renderer
}

