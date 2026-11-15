/**
 * IPC · Permission 域（S4-2）—— 自 ipc-routes.js 原样搬入（Step 5，语义零改动）。
 */

import { createProviderInvoker } from './provider-bridge'
import type { ProviderRegistryPort } from './provider-bridge'
import type { IpcRoutes, IpcSchemas, IpcTypedMain } from './types'

type MethodPort = Record<string, (...args: unknown[]) => unknown>
interface PermissionIpcContext {
  routes: IpcRoutes
  schemas: IpcSchemas['permissions']
  permissionService: MethodPort
  pendingFilter?: (list: unknown) => unknown
  providerRegistry?: ProviderRegistryPort | null
}

export function registerPermissionIpc(
  typedMain: IpcTypedMain,
  { routes, schemas, permissionService, pendingFilter, providerRegistry }: PermissionIpcContext
): void {
  if (!permissionService) return

  const invoke = createProviderInvoker(providerRegistry)

  typedMain.handle(routes.permissionGet, {
    requestSchema: schemas.get.request,
    responseSchema: schemas.get.response,
    handler: async (_e, req) => ({ setting: await invoke('permission.getPermission', () => permissionService.getPermission(req.origin, req.permissionType), req) })
  })

  typedMain.handle(routes.permissionResolveRequest, {
    requestSchema: schemas.resolveRequest.request,
    responseSchema: schemas.resolveRequest.response,
    handler: async (_e, req) => ({ decision: await invoke('permission.resolveRequest', () => permissionService.resolveRequest(req.origin, req.permissionType), req) })
  })

  typedMain.handle(routes.permissionSetSite, {
    requestSchema: schemas.setSite.request,
    responseSchema: schemas.setSite.response,
    handler: async (_e, req) => ({ ok: await invoke('permission.setSitePermissions', () => permissionService.setSitePermissions(req.origin, req.rules), req) })
  })

  typedMain.handle(routes.permissionResetSite, {
    requestSchema: schemas.resetSite.request,
    responseSchema: schemas.resetSite.response,
    handler: async (_e, req) => ({ cleared: await invoke('permission.resetSite', () => permissionService.resetSite(req.origin), req) })
  })

  typedMain.handle(routes.permissionSet, {
    requestSchema: schemas.set.request,
    responseSchema: schemas.set.response,
    handler: async (_e, req) => ({ ok: await invoke('permission.setPermission', () => permissionService.setPermission(req.origin, req.permissionType, req.setting), req) })
  })

  typedMain.handle(routes.permissionRemove, {
    requestSchema: schemas.remove.request,
    responseSchema: schemas.remove.response,
    handler: async (_e, req) => ({ ok: await invoke('permission.removePermission', () => permissionService.removePermission(req.origin, req.permissionType), req) })
  })

  typedMain.handle(routes.permissionListAll, {
    requestSchema: schemas.listAll.request,
    responseSchema: schemas.listAll.response,
    handler: async () => invoke('permission.listAll', () => permissionService.listAll(), null)
  })

  typedMain.handle(routes.permissionGetSite, {
    requestSchema: schemas.getSite.request,
    responseSchema: schemas.getSite.response,
    handler: async (_e, req) => invoke('permission.getSite', () => permissionService.getSitePermissions(req.origin), req)
  })

  typedMain.handle(routes.permissionClearSite, {
    requestSchema: schemas.clearSite.request,
    responseSchema: schemas.clearSite.response,
    handler: async (_e, req) => ({ cleared: await invoke('permission.clearSite', () => permissionService.clearSite(req.origin), req) })
  })

  // ── 类型级默认规则（全局"默认行为"）──
  typedMain.handle(routes.permissionDefaults, {
    requestSchema: schemas.defaults.request,
    responseSchema: schemas.defaults.response,
    handler: async () => invoke('permission.defaultsView', () => permissionService.defaultsView(), null)
  })

  typedMain.handle(routes.permissionSetDefault, {
    requestSchema: schemas.setDefault.request,
    responseSchema: schemas.setDefault.response,
    handler: async (_e, req) => ({ ok: await invoke('permission.setDefault', () => permissionService.setDefault(req.permissionType, req.setting), req) })
  })

  // ── 批量（按类型批量 / 多站点批量清理）──
  typedMain.handle(routes.permissionSetByType, {
    requestSchema: schemas.setByType.request,
    responseSchema: schemas.setByType.response,
    handler: async (_e, req) => ({ changed: await invoke('permission.setByType', () => permissionService.setByType(req.permissionType, req.setting), req) })
  })

  typedMain.handle(routes.permissionClearByType, {
    requestSchema: schemas.clearByType.request,
    responseSchema: schemas.clearByType.response,
    handler: async (_e, req) => ({ cleared: await invoke('permission.clearByType', () => permissionService.clearByType(req.permissionType), req) })
  })

  typedMain.handle(routes.permissionClearSites, {
    requestSchema: schemas.clearSites.request,
    responseSchema: schemas.clearSites.response,
    handler: async (_e, req) => ({ cleared: await invoke('permission.clearSites', () => permissionService.clearSites(req.origins), req) })
  })

  // ── Web Prompts：网页权限请求响应 ──
  // 用户在 navbar 权限弹窗点击 Allow/Deny 后通过此路由回报主进程
  if (permissionService.respondToRequest) {
    typedMain.handle(routes.permissionRespond, {
      requestSchema: schemas.respond.request,
      responseSchema: schemas.respond.response,
      handler: async (_e, req) => ({ ok: await invoke('permission.respond', () => permissionService.respondToRequest(req.id, req.allow, req.persist), req) })
    })

    typedMain.handle(routes.permissionPendingList, {
      requestSchema: schemas.pendingList.request,
      responseSchema: schemas.pendingList.response,
      // 归属过滤端口由 APPS 层注入（只有它知道窗口/标签拓扑）：
      // 必须包在 invoke 之外 —— provider 路径（插件接管该 capability）与 fallback 路径
      // 都要经过同一过滤/补全，否则插件接管后列表会缺 windowId/tabId 并跨窗口串台。
      handler: async () => {
        const list = await invoke('permission.pendingList', () => (
          typeof permissionService.pendingWithFlags === 'function'
            ? permissionService.pendingWithFlags()
            : permissionService.listPendingRequests()
        ), null)
        return typeof pendingFilter === 'function' ? pendingFilter(list) : list
      }
    })
  }
}

