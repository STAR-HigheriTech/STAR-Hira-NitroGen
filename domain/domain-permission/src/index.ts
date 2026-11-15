/** Public facade for typed permission rules, storage ports, and the service factory. */

import { createPermissionService } from './permissionService'
import * as PermissionUtil from './permissionUtil'

export * from './constants'
export * from './permissionUtil'
export * from './permissionService'
export * from './registry'
export * from './repository'
export * from './types'
export { PermissionUtil }

export default {
  createPermissionService,
  ...PermissionUtil
}
