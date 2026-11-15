/**
 * IPC · 页面缩放（缩放条浮层 → 主进程）
 *
 * 两条单向通道，一步到位转给**该窗口**的 zoom-controller（scoped 端口）：
 *   zoom:step  { delta: ±1 }  在档位阶梯上走一步
 *   zoom:reset                回到 100%（并忘掉本站记忆）
 *
 * 为什么不让浮层自己算百分比：档位是 **1.2 的对数刻度**（见 zoom-controller），
 * 浮层只该显示主进程推来的事实（`zoom:changed`），自己算必然与主进程漂移
 * （点两下 + 之后，浮层的数字比真实比例多半档）。
 */

import type { IpcRawMain, IpcRoutes, IpcTypedMain } from './types'

interface ZoomPort {
  step(delta: unknown, target: null, source: string): unknown
  reset(target: null, source: string): unknown
}

interface ZoomIpcContext { routes: IpcRoutes; zoom?: ZoomPort | null }

/**
 * @param {object} typedMain
 * @param {object} senderScopedIpcMain
 * @param {{ routes:object, zoom:object }} deps
 */
export function registerZoomIpc(
  _typedMain: IpcTypedMain,
  senderScopedIpcMain: IpcRawMain,
  { routes, zoom }: ZoomIpcContext
): void {
  const sendCh = (route: string): string => `ngipc:send:${route}`

  senderScopedIpcMain.on(sendCh(routes.zoomStep), (_e, req) => {
    if (!zoom) return
    // 浮层按钮 = 'overlay' 来源：浮层据此在收到通知后把自己重新弹出并顺延自动收起计时
    zoom.step(req && req.delta, null, 'overlay')
  })

  senderScopedIpcMain.on(sendCh(routes.zoomReset), () => {
    if (!zoom) return
    zoom.reset(null, 'overlay')
  })
}

