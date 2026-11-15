export type PermissionSetting = 'allow' | 'block' | 'ask'

export interface PermissionRule {
  domain: string
  permissionType: string
  setting: PermissionSetting
  sensitive: boolean
}

export interface PendingPermissionRequest {
  id: string
  origin: string
  type: string
  sensitive: boolean
}

export interface PermissionDefault {
  permissionType: string
  setting: PermissionSetting
  sensitive: boolean
}

export interface PermissionMutationResult {
  ok: boolean
}
