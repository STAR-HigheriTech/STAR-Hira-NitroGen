/**
 * ipc/files.ts — 「系统文件拖入窗口」的 IPC 注册器（自包含）。
 *
 * 只做「通道 → 服务」的一次映射；分类与打开全在 `main/file-open/`。
 * `tabManager` 传**按发送方解析的 scoped 代理**（见 ipc-routes.js），
 * 于是窗口 B 拖入的文件只会开在窗口 B —— 渲染层没有任何指定窗口的能力。
 *
 * 与其它小域注册器同构：缺依赖时自身安全跳过，绝不半启动。
 */

import type { IpcRoutes, IpcSchemas, IpcTypedMain } from './types'

interface FileOpenPort {
  openPaths(paths: unknown, context: { tabManager: unknown }): unknown
}

interface FilesIpcContext {
  routes: IpcRoutes
  schemas: IpcSchemas['files']
  tabManager?: unknown
  fileOpenService?: FileOpenPort | null
}

/**
 * @param {{ handle:Function }} typedMain
 * @param {{ routes:any, schemas:any, tabManager?:any, fileOpenService:any }} ctx
 */
export function registerFilesIpc(typedMain: IpcTypedMain, ctx: FilesIpcContext): void {
  const { routes, schemas, tabManager, fileOpenService } = ctx || {}
  if (!typedMain || !routes || !schemas || !fileOpenService) return

  typedMain.handle(routes.filesDrop, {
    requestSchema: schemas.drop.request,
    responseSchema: schemas.drop.response,
    handler: async (_e, req) => fileOpenService.openPaths(req.paths, { tabManager })
  })
}

