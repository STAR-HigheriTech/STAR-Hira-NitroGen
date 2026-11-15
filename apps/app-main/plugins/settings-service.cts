import { createServicePlugin } from '@hira-ng/infra-plugin'
import type { SettingsService } from '@hira-ng/domain-settings'
import type { ServiceRuntimeContext, SettingsInputs } from './service-contracts'

module.exports = createServicePlugin<SettingsService, SettingsInputs, ServiceRuntimeContext>({
  domain: 'settings',
  serviceName: 'settingsService',
  capabilities: {
    'settings.get': (svc, input) => svc.get(input.key),
    'settings.set': (svc, input, ctx) => svc.set(input.key, input.value, ctx.senderId || 0),
    'settings.list': (svc, input) => svc.list(input?.section),
    'settings.reset': (svc, input, ctx) => svc.reset(input?.key, ctx.senderId || 0),
    'settings.schema': (_svc, _input, ctx) => ctx.getDomainServices().settingsRegistry.getSchema()
  }
})
