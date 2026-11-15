import type { IpcRoutes, IpcSchemas, IpcTypedMain } from './types'

interface NamedSessionsService {
  list(): unknown
  save(name: unknown): unknown
  restore(id: unknown): unknown
  remove(id: unknown): unknown
}

interface NamedSessionsIpcContext {
  routes: IpcRoutes
  schemas: IpcSchemas['session']
  namedSessions?: NamedSessionsService | null
}

/**
 * IPC · 命名会话（N14）
 *
 * 四条路由都是"转调引擎"：形状与上限在纯层（shared-types#named-sessions），
 * 存储与开标签在 `main/named-sessions.js`。这里不做任何业务判断。
 */

/**
 * @param {{ handle:Function }} typedMain
 * @param {{ routes:any, schemas:any, namedSessions:any }} ctx
 */
export function registerNamedSessionsIpc(typedMain: IpcTypedMain, ctx: NamedSessionsIpcContext): void {
  const { routes, schemas, namedSessions } = ctx || {}
  if (!typedMain || !namedSessions || !routes || !schemas) return
  if (!schemas.namedList || !schemas.namedSave || !schemas.namedRestore || !schemas.namedRemove) return

  typedMain.handle(routes.sessionNamedList, {
    requestSchema: schemas.namedList.request,
    responseSchema: schemas.namedList.response,
    handler: async () => ({ sessions: namedSessions.list() })
  })

  typedMain.handle(routes.sessionNamedSave, {
    requestSchema: schemas.namedSave.request,
    responseSchema: schemas.namedSave.response,
    handler: async (_e, req) => namedSessions.save(req && req.name)
  })

  typedMain.handle(routes.sessionNamedRestore, {
    requestSchema: schemas.namedRestore.request,
    responseSchema: schemas.namedRestore.response,
    handler: async (_e, req) => namedSessions.restore(req && req.id)
  })

  typedMain.handle(routes.sessionNamedRemove, {
    requestSchema: schemas.namedRemove.request,
    responseSchema: schemas.namedRemove.response,
    handler: async (_e, req) => namedSessions.remove(req && req.id)
  })
}

