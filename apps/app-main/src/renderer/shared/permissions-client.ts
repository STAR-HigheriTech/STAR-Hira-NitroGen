import { IPC_ROUTES } from '@hira-ng/shared-types/src/ipc-channels.mjs'
import { getHiraBridge, type JsonRecord } from './bridge.js'

function invoke(route: string, payload?: unknown): Promise<JsonRecord> {
  return getHiraBridge().provider.invoke<JsonRecord>(route, payload)
}

export const permissionsClient = {
  get(origin: string, permissionType: string): Promise<JsonRecord> {
    return invoke(IPC_ROUTES.permissionGet, { origin, permissionType })
  },
  resolveRequest(origin: string, permissionType: string): Promise<JsonRecord> {
    return invoke(IPC_ROUTES.permissionResolveRequest, { origin, permissionType })
  },
  set(origin: string, permissionType: string, setting: string): Promise<JsonRecord> {
    return invoke(IPC_ROUTES.permissionSet, { origin, permissionType, setting })
  },
  setSitePermissions(origin: string, rules: unknown): Promise<JsonRecord> {
    return invoke(IPC_ROUTES.permissionSetSite, { origin, rules })
  },
  resetSite(origin: string): Promise<JsonRecord> {
    return invoke(IPC_ROUTES.permissionResetSite, { origin })
  },
  getSite(origin: string): Promise<JsonRecord> {
    return invoke(IPC_ROUTES.permissionGetSite, { origin })
  }
}

export default permissionsClient
