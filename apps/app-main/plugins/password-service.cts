/**
 * Password 域插件 —— 声明式能力表（kernel 机制见 infra-plugin/service-plugin.js）。
 */
import { createServicePlugin } from '@hira-ng/infra-plugin'
import type { PasswordService } from '@hira-ng/domain-password'
import type { PasswordInputs } from './service-contracts'

module.exports = createServicePlugin<PasswordService, PasswordInputs>({
  domain: 'password',
  serviceName: 'passwordService',
  capabilities: {
    'password.listBackends': (svc) => svc.listBackends(),
    'password.saveCredential': (svc, input) => svc.saveCredential(input),
    'password.getSuggestions': (svc, input) => input?.profileId === undefined
      ? svc.getSuggestions(input.hostname)
      : svc.getSuggestions(input.hostname, input.profileId),
    'password.deleteCredential': (svc, input) => svc.deleteCredential(input.id),
    'password.listCredentials': (svc) => svc.listCredentials(),
    'password.importCredentials': (svc, input) => svc.importCredentials(input?.content || '', {
      profileId: input?.profileId
    }),
    'password.setActiveBackend': (svc, input) => svc.setActiveBackend(input.name),
    // 凭据字段（主密码 / API Key / 邮箱 / Secret Key / 服务器地址）由后端自己挑，
    // 这里原样透传 —— 新增后端不需要改能力表。
    'password.backendAction': (svc, input) => svc.backendAction(input.name, input.action, input),
    'password.getBackendStatus': (svc, input) => svc.getBackendStatus(input.name),
    'password.addNeverSave': (svc, input) => svc.addNeverSave(input.hostname),
    'password.removeNeverSave': (svc, input) => svc.removeNeverSave(input.hostname),
    'password.listNeverSave': (svc, input) => input?.profileId === undefined
      ? svc.getNeverSaveDomains()
      : svc.getNeverSaveDomains(input.profileId),
  }
})
