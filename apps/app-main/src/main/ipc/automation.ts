import type { AutomationController } from '../automation'
import type { IpcRoutes, IpcSchemas, IpcTypedMain } from './types'

interface AutomationIpcContext {
  routes: IpcRoutes
  schemas: IpcSchemas['automation']
  automation?: AutomationController | null
}

/**
 * IPC · Automation 域（D2 命令链 + D3 鼠标手势）。
 *
 * 四条路由围绕同一个控制器（`main/automation.js`）：
 *   get     —— 读配置 + 命令目录（自动化页、地址栏建议）
 *   save    —— 写配置（只写传进来的字段）
 *   run     —— 跑一条链 / 单条命令
 *   gesture —— 页面手势引擎上报（页面 → 主进程）
 */

export function registerAutomationIpc(
  typedMain: IpcTypedMain,
  { routes, schemas, automation }: AutomationIpcContext
): void {
  if (!automation) return

  typedMain.handle(routes.automationGet, {
    requestSchema: schemas.get.request,
    responseSchema: schemas.get.response,
    handler: async () => automation.getConfig()
  })

  typedMain.handle(routes.automationSave, {
    requestSchema: schemas.save.request,
    responseSchema: schemas.save.response,
    handler: async (_e, req) => automation.save(req || {})
  })

  typedMain.handle(routes.automationRun, {
    requestSchema: schemas.run.request,
    responseSchema: schemas.run.response,
    handler: async (_e, req) => automation.run(req || {})
  })

  /**
   * 手势上报：**发送方就是那一页**，抑制标记必须记在它身上 ——
   * 多窗口/多标签下，"谁画的手势"决定了"压掉哪一页的右键菜单"。
   */
  typedMain.handle(routes.automationGesture, {
    requestSchema: schemas.gesture.request,
    responseSchema: schemas.gesture.response,
    handler: async (event, req) => {
      const sender = event && typeof event === 'object' && 'sender' in event
        ? (event as { sender: object }).sender
        : null
      return automation.handleGesture(req.gesture, sender)
    }
  })

  /**
   * 方向 → 命令名 + 手势总开关：页面手势引擎取一次并缓存（画的过程中本地查表 → 提示才即时）。
   * `enabled` 必须一起给：关掉「启用鼠标手势」时页面要**完全不介入**右键，
   * 而不是画完再让主进程丢弃（那样开关看起来毫无作用）。
   * 后续变更由 applier 经 `automation:gestures-config` 事件热更新，不必重新拉取。
   */
  typedMain.handle(routes.automationGestureMap, {
    requestSchema: schemas.gestureMap.request,
    responseSchema: schemas.gestureMap.response,
    handler: async () => ({ map: automation.getGestureMap(), enabled: automation.isGesturesEnabled() })
  })
}

