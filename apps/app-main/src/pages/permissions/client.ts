import { IPC_ROUTES, rpc } from 'hira://shared/runtime.js'
import { normalizePermissionSetting, permissionLabel } from 'hira://shared/permission-labels.mjs'
import { isRecord } from 'hira://shared/page-kit.js'
import type {
  PendingPermissionRequest,
  PermissionDefault,
  PermissionMutationResult,
  PermissionRule,
  PermissionSetting
} from './types.js'

function textField(record: Record<string, unknown>, ...keys: string[]): string {
  for (const key of keys) {
    const value = record[key]
    if (typeof value === 'string') return value
  }
  return ''
}

function toRule(value: unknown): PermissionRule | null {
  if (!isRecord(value)) return null
  const domain = textField(value, 'domain', 'origin').trim()
  const permissionType = textField(value, 'permissionType', 'type').trim()
  if (!domain || !permissionType) return null
  return {
    domain,
    permissionType,
    setting: normalizePermissionSetting(value.setting),
    sensitive: value.sensitive === true
  }
}

function toPending(value: unknown): PendingPermissionRequest | null {
  if (!isRecord(value)) return null
  const id = textField(value, 'id').trim()
  if (!id) return null
  return {
    id,
    origin: textField(value, 'origin'),
    type: textField(value, 'type', 'permissionType'),
    sensitive: value.sensitive === true
  }
}

function toDefault(value: unknown): PermissionDefault | null {
  if (!isRecord(value)) return null
  const permissionType = textField(value, 'permissionType', 'type').trim()
  if (!permissionType) return null
  return {
    permissionType,
    setting: normalizePermissionSetting(value.setting),
    sensitive: value.sensitive === true
  }
}

export const permissionsClient = {
  async listRules(): Promise<PermissionRule[]> {
    const rows = await rpc<unknown>(IPC_ROUTES.permissionListAll, {})
    return (Array.isArray(rows) ? rows : [])
      .map(toRule)
      .filter((rule): rule is PermissionRule => rule !== null)
      .sort((a, b) => a.domain.localeCompare(b.domain) ||
        permissionLabel(a.permissionType).localeCompare(permissionLabel(b.permissionType), 'zh'))
  },

  async listPending(): Promise<PendingPermissionRequest[]> {
    const rows = await rpc<unknown>(IPC_ROUTES.permissionPendingList, {})
    return (Array.isArray(rows) ? rows : [])
      .map(toPending)
      .filter((request): request is PendingPermissionRequest => request !== null)
  },

  async listDefaults(): Promise<PermissionDefault[]> {
    const rows = await rpc<unknown>(IPC_ROUTES.permissionDefaults, {})
    return (Array.isArray(rows) ? rows : [])
      .map(toDefault)
      .filter((item): item is PermissionDefault => item !== null)
  },

  setRule(rule: PermissionRule, setting: PermissionSetting): Promise<PermissionMutationResult> {
    return rpc<PermissionMutationResult>(IPC_ROUTES.permissionSet, {
      origin: rule.domain,
      permissionType: rule.permissionType,
      setting
    })
  },

  removeRule(rule: PermissionRule): Promise<PermissionMutationResult> {
    return rpc<PermissionMutationResult>(IPC_ROUTES.permissionRemove, {
      origin: rule.domain,
      permissionType: rule.permissionType
    })
  },

  setDefault(permissionType: string, setting: PermissionSetting): Promise<PermissionMutationResult> {
    return rpc<PermissionMutationResult>(IPC_ROUTES.permissionSetDefault, { permissionType, setting })
  },

  async clearSiteRules(domains: readonly string[]): Promise<void> {
    await rpc(IPC_ROUTES.permissionClearSites, { origins: domains })
  },

  respond(request: PendingPermissionRequest, allow: boolean, persist: boolean): Promise<PermissionMutationResult> {
    return rpc<PermissionMutationResult>(IPC_ROUTES.permissionRespond, {
      id: request.id,
      allow,
      persist
    })
  }
}
