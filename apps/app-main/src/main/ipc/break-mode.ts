import type { IpcRoutes, IpcSchemas, IpcTypedMain } from './types'

interface BreakModePort {
  control(action: unknown, options: { deltaMs: unknown }): unknown
}

interface BreakIpcContext {
  routes: IpcRoutes
  schemas: IpcSchemas['break']
  breakMode?: BreakModePort | null
}

/**
 * IPC · Break Mode 域（D5 番茄钟 / 专注）。
 *
 * 只有一条路由：浮层上的按钮 / `Esc` 把"用户想干什么"回传主进程
 *（`skip` / `pause` / `resume` / `stop` / `adjust`）。状态机与计时全在
 * `main/break-mode.js`，这里只做一次转发 —— 于是时长、阶段流转只有一份实现。
 */

export function registerBreakIpc(typedMain: IpcTypedMain, { routes, schemas, breakMode }: BreakIpcContext): void {
  if (!breakMode) return

  typedMain.handle(routes.breakControl, {
    requestSchema: schemas.control.request,
    responseSchema: schemas.control.response,
    handler: async (_e, req) => breakMode.control(req && req.action, { deltaMs: req && req.deltaMs })
  })
}

