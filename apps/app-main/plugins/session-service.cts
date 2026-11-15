/**
 * Session 域插件 —— 声明式能力表（kernel 机制见 infra-plugin/service-plugin.js）。
 *
 * 会话的标签操作端口（tabPort）在运行期是 TabManager —— 经 ctx.getDomainServices()
 * 一并暴露，插件不自持跨模块状态（与 tabs-service 的 tabManager 注入同构）。
 */
import { createServicePlugin } from '@hira-ng/infra-plugin'
import type { SessionService, SessionTabPort } from '@hira-ng/domain-session'
import type { ServiceRuntimeContext, SessionInputs } from './service-contracts'

module.exports = createServicePlugin<SessionService, SessionInputs, ServiceRuntimeContext>({
  domain: 'session',
  serviceName: 'sessionService',
  capabilities: {
    'session.read': (svc, input) => svc.read(input.dir),
    'session.stats': (svc, input) => svc.stats(input.dir),
    'session.save': (svc, input, ctx) => svc.save(input.dir, ctx.getDomainServices().tabManager as unknown as SessionTabPort),
    'session.restore': (svc, input, ctx) => svc.restore(input.dir, ctx.getDomainServices().tabManager as unknown as SessionTabPort),
    'session.clear': (svc, input) => svc.clear(input.dir),
    'session.exists': (svc, input) => svc.exists(input.dir)
  }
})
