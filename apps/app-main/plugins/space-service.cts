import { createServicePlugin } from '@hira-ng/infra-plugin'
import type { ServiceRuntimeContext, SpaceInputs, SpaceService } from './service-contracts'

/**
 * space-service —— 空间（工作空间）引擎的声明式适配。
 *
 * ── 为什么此前"没有它"是个缺口（§10.4 / §6）───────────────────────
 * `space.*` 系列 capability 早就在用，但**没有任何插件声明它们**：
 *   · `provider-bridge` 永远走 `!hasProvider` → 域服务直连兜底 → 功能一直正常，
 *     所以没人发现；
 *   · 但 `blockedCapabilities` 只由"被**禁用**的插件的 `manifest.capabilities`"贡献 ——
 *     没有 owner 就永远进不了那张表 → **引擎开关对空间完全无效**；
 *   · §10.4 的可用性表也因此只能"按事实登记"（不登记 spaces），
 *     否则会把一个仍正常工作的入口藏起来。
 * 本插件把归属补上，缺口即闭合。
 *
 * ── 一个刻意的分工：编排留在 IPC 层，不在这里 ────────────────────
 * `space.setUsing` 的"真正切空间"（保存会话 / 关标签 / 换 session / 恢复）与
 * `space:changed` 广播，**都不在本插件里做**，而是留在 `ipc/space.js` 的 handler 中，
 * 在 provider 调用**之后**执行。
 *
 * 理由：这些副作用此前写在 `invoke(capability, () => {...})` 的 **fallback 闭包**里 ——
 * 那是"没有 provider 时才跑"的分支。一旦本插件开始提供 provider，fallback 不再执行，
 * 副作用就会**静默消失**（切空间不再广播 → 界面不刷新）。
 * 把编排提到 handler 里，两条路径（有/无 provider）都会跑到，这个陷阱才算真正堵上。
 *
 * 只有"实现需要的数据"才从 invoke 的 context 传入（如 `getUsingSpace`：它是**窗口级**
 * 运行态，属于"这次调用的入参"而不是插件能自己查的东西）。
 */
module.exports = createServicePlugin<SpaceService, SpaceInputs, ServiceRuntimeContext>({
  domain: 'space',
  serviceName: 'spaceService',
  capabilities: {
    'space.list': (svc, input) => svc.list(input.profileId),
    // 只返回**全部**空间。「internal profile 的空间不外露」那条过滤**不在这里** ——
    // 它是 APPS 关注点（依赖 profileService.isInternalId），留在 ipc/space.js 的 handler 里，
    // 否则一旦本插件提供 provider，兜底不再执行，internal 空间就会漏进列表。
    'space.listAll': (svc) => svc.listAll(),
    'space.get': (svc, input) => svc.get(input.profileId, input.spaceId),
    'space.create': (svc, input) => svc.create(input.profileId, {
      id: input.id,
      name: input.name,
      icon: input.icon,
      bgStartColor: input.bgStartColor,
      bgEndColor: input.bgEndColor
    }),
    'space.update': (svc, input) => svc.update(input.profileId, input.spaceId, input.patch),
    'space.move': (svc, input) => svc.move(input.profileId, input.spaceId, input.targetProfileId),
    'space.remove': (svc, input) => svc.remove(input.profileId, input.spaceId),
    'space.reorder': (svc, input) => { svc.reorder(input.entries); return true },
    // 「当前窗口在用哪个空间」是 APPS 运行态（窗口级），由 handler 经 invoke context 传入
    'space.getUsing': (_svc, _input, context) => (
      context && typeof context.getUsingSpace === 'function' ? context.getUsingSpace() : null
    ),
    'space.getLastUsed': (svc, input) => svc.getLastUsed(input.profileId),
    /**
     * 校验 + 快照。真正的切换编排在 `ipc/space.js` 的 handler 里（见文件头说明）。
     * 返回 `{ ok, space }`，handler 拿到 ok 后才执行 switchSpace 与广播。
     */
    'space.setUsing': (svc, input) => {
      const space = svc.get(input.profileId, input.spaceId)
      return space ? { ok: true, space } : { ok: false, space: null }
    }
  }
})
