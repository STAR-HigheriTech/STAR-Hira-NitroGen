import { createServicePlugin } from '@hira-ng/infra-plugin'
import type { ProfileInputs, ProfileService, ServiceRuntimeContext } from './service-contracts'

module.exports = createServicePlugin<ProfileService, ProfileInputs, ServiceRuntimeContext>({
  domain: 'profile',
  serviceName: 'profileService',
  capabilities: {
    'profile.list': (svc) => svc.list(),
    'profile.getActive': (svc) => svc.getActive(),
    'profile.create': (svc, input) => svc.create({ name: input.name, icon: input.icon, color: input.color }),
    'profile.update': (svc, input) => svc.update(input.id, { name: input.name, icon: input.icon, color: input.color }),
    'profile.setActive': (svc, input, context) => typeof context.switchProfile === 'function' ? context.switchProfile(input.id) : svc.setActive(input.id),
    'profile.remove': (svc, input) => svc.remove(input.id)
  }
})
