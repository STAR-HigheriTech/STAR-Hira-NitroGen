/**
 * Permission 域插件 —— 声明式能力表（kernel 机制见 infra-plugin/service-plugin.js）。
 */
import { createServicePlugin } from '@hira-ng/infra-plugin'
import type { PermissionService } from '@hira-ng/domain-permission'
import type { PermissionInputs } from './service-contracts'

module.exports = createServicePlugin<PermissionService, PermissionInputs>({
  domain: 'permission',
  serviceName: 'permissionService',
  capabilities: {
    'permission.getPermission': (svc, input) => svc.getPermission(input.origin, input.permissionType),
    'permission.resolveRequest': (svc, input) => svc.resolveRequest(input.origin, input.permissionType),
    'permission.setPermission': (svc, input) => svc.setPermission(input.origin, input.permissionType, input.setting),
    'permission.setSitePermissions': (svc, input) => svc.setSitePermissions(input.origin, input.rules),
    'permission.resetSite': (svc, input) => svc.resetSite(input.origin),
    'permission.removePermission': (svc, input) => svc.removePermission(input.origin, input.permissionType),
    'permission.listAll': (svc) => svc.listAll(),
    'permission.listByType': (svc, input) => svc.listByType(input.permissionType),
    'permission.getSite': (svc, input) => svc.getSitePermissions(input.origin),
    'permission.clearSite': (svc, input) => svc.clearSite(input.origin),
    'permission.respond': (svc, input) => svc.respondToRequest(input.id, input.allow, input.persist),
    'permission.pendingList': (svc) => (
      typeof svc.pendingWithFlags === 'function'
        ? svc.pendingWithFlags()
        : svc.listPendingRequests()
    ),
    'permission.pendingWithFlags': (svc) => svc.pendingWithFlags()
  }
})
