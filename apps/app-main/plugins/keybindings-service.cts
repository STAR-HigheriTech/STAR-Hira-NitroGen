import { createServicePlugin } from '@hira-ng/infra-plugin'
import type { KeybindingsInputs, KeybindingsServicePort } from './service-contracts'

module.exports = createServicePlugin<KeybindingsServicePort, KeybindingsInputs>({
  domain: 'keybindings',
  serviceName: 'keybindings',
  capabilities: {
    'keybindings.get': (svc) => svc.getKeybindings(),
    'keybindings.defaults': (svc) => svc.getDefaults(),
    'keybindings.set': (svc, input) => svc.setKeybinding(input.action, input.combo),
    'keybindings.reset-one': (svc, input) => svc.resetKeybinding(input.action),
    'keybindings.reset': (svc) => svc.reset()
  }
})
