import type { IpcRoutes, IpcSchemas, IpcTypedMain } from './types'

interface OpenExternalPermissionPort {
  list(): unknown
  unset(requestingUrl: unknown, openingProtocol: unknown): unknown
}

interface OpenExternalIpcContext {
  routes: IpcRoutes
  schemas: IpcSchemas['openExternal']
  openExternalPermissions?: OpenExternalPermissionPort | null
}

/**
 * ipc/open-external.js — 外部协议授权记录的 IPC 路由（自包含）
 *
 * 只做「路由 → 服务方法」的一次映射：记录怎么编码、怎么落盘全在
 * `main/open-external.js`（createOpenExternalPermissions），本模块不认识存储细节。
 * 与其它小域注册器同构：没人注入服务时自身安全跳过，绝不半启动。
 */

/**
 * @param {{ handle:Function }} typedMain
 * @param {{ routes:any, schemas:any, openExternalPermissions:any }} ctx
 */
export function registerOpenExternalIpc(typedMain: IpcTypedMain, ctx: OpenExternalIpcContext): void {
  const { routes, schemas, openExternalPermissions } = ctx || {}
  if (!typedMain || !routes || !schemas || !openExternalPermissions) return

  typedMain.handle(routes.openExternalList, {
    requestSchema: schemas.list.request,
    responseSchema: schemas.list.response,
    handler: async () => openExternalPermissions.list()
  })

  typedMain.handle(routes.openExternalUnset, {
    requestSchema: schemas.unset.request,
    responseSchema: schemas.unset.response,
    handler: async (_e, req) => openExternalPermissions.unset(req.requestingURL, req.openingProtocol)
  })
}

