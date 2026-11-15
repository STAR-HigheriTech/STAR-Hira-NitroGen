/**
 * History 域插件 —— 声明式能力表（kernel 机制见 infra-plugin/service-plugin.js）。
 */
import { createServicePlugin } from '@hira-ng/infra-plugin'
import type { HistoryInputs, HistoryService } from './service-contracts'

module.exports = createServicePlugin<HistoryService, HistoryInputs>({
  domain: 'history',
  serviceName: 'historyService',
  capabilities: {
    'history.addVisit': (svc, input) => svc.addVisit(input),
    'history.remove': (svc, input) => svc.remove(input.id),
    'history.removeMany': (svc, input) => svc.removeMany(input.ids),
    'history.removeBefore': (svc, input) => svc.removeBefore(input.before),
    'history.search': (svc, input) => svc.search(input.query, input?.limit),
    'history.listRecent': (svc, input) => svc.listRecent(input?.limit),
    'history.clearAll': (svc) => svc.clearAll(),
    'history.queryRange': (svc, input) => svc.queryRange(input.from, input.to, input?.limit),
    // E1 双表：逐次访问日志（游标分页）与访问计数
    'history.listVisits': (svc, input) => svc.listVisits(input),
    'history.countVisits': (svc, input) => svc.countVisits(input),
    // 幂等整理：合并同页重复行（追踪参数 / SPA replaceState / 旧内部页遗留）
    'history.compact': (svc) => svc.compactHistory()
  }
})
