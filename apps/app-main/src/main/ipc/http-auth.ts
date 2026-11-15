/**
 * IPC · HTTP Auth 域 —— Basic / Proxy 认证弹窗的三条消息。
 *
 * 与认证生命周期解耦：真实请求的挂起/放行在 `main/http-auth.js` 里，
 * 本文件只做「路由 → 管理器方法」的映射，不含任何窗口逻辑。
 */

import type { IpcSchemas, IpcTypedMain } from './types'

interface HttpAuthManager {
  ready(): object | null
  submit(payload: { requestId: string; username: string; password: string }): { ok: boolean }
  cancel(payload: { requestId: string }): { ok: boolean }
}

interface Deps {
  routes?: Record<string, string>
  schemas?: IpcSchemas['httpAuth']
  httpAuth?: HttpAuthManager | null
}

export function registerHttpAuthIpc(typedMain: IpcTypedMain, { routes, schemas, httpAuth }: Deps): void {
  if (!routes?.httpAuthReady || !schemas?.ready || !httpAuth) return

  typedMain.handle(routes.httpAuthReady, {
    requestSchema: schemas.ready.request,
    responseSchema: schemas.ready.response,
    // 无挂起请求时返回 null：页面据此显示「请求已失效」而不是空壳界面
    handler: async () => httpAuth.ready()
  })

  typedMain.handle(routes.httpAuthSubmit, {
    requestSchema: schemas.submit.request,
    responseSchema: schemas.submit.response,
    handler: async (_e, req) => httpAuth.submit(req)
  })

  typedMain.handle(routes.httpAuthCancel, {
    requestSchema: schemas.cancel.request,
    responseSchema: schemas.cancel.response,
    handler: async (_e, req) => httpAuth.cancel(req)
  })
}

