/**
 * PWA 域插件 —— 声明式能力表（kernel 机制见 infra-plugin/service-plugin.js）。
 *
 * 域服务（`pwaService`）只负责持久化；安装 / 卸载 / 启动属于**编排**，
 * 由 main.js 建好的编排对象经 `ctx.getDomainServices()` 注入（`pwaInstaller` / `pwaRuntime` …）：
 *  · 插件不 require 任何业务模块（见 service-plugin.js 的设计约束）；
 *  · 编排对象与 IPC 用的是**同一批实例**，不存在"插件走一条路、界面走另一条"。
 *
 * 为什么端口也从 `getDomainServices()` 取而不是 `ctx` 顶层裸名：
 * service-plugin 的契约是「服务懒解析只走一个入口」，编排对象与域服务同源注入，
 * 插件就不必关心组合根把东西放在哪一层；同时避免 `install` 这类通用名撞车。
 *
 * ⚠ 这十条能力名与三处必须逐字一致：
 *   ① 本文件 `capabilities` 的键
 *   ② `pwa-service.hira-plugin.json` 的 `capabilities` 数组
 *   ③ `main/ipc/pwa.js` 里 `invoke('pwa.xxx', ...)` 的第一个参数
 *
 * 与文档 §11.1 的草案相比只改了一处命名口径：`install/uninstall/launch/...`
 * 从 `ctx` 顶层的裸名字改为 `services.pwaInstaller` / `services.pwaRuntime` 等**具名端口**。
 * 域服务对象是一张共享表，`install` 这种通用名迟早与别的域撞车；命名空间化
 * 也让"哪些编排属于 PWA"在注入点一眼可见。
 */
import { createServicePlugin } from '@hira-ng/infra-plugin'
import type { PwaService } from '@hira-ng/domain-pwa'
import type { DomainServicesPort, PwaInputs, ServiceRuntimeContext } from './service-contracts'

/** 编排端口与域服务同源（懒解析），与 IPC 拿到的是同一批实例。 */
function portsOf(ctx: ServiceRuntimeContext): DomainServicesPort {
  const services = ctx && typeof ctx.getDomainServices === 'function'
    ? ctx.getDomainServices()
    : (ctx && ctx.domainServices) || {}
  return services as DomainServicesPort
}

module.exports = createServicePlugin<PwaService, PwaInputs, ServiceRuntimeContext>({
  domain: 'pwa',
  serviceName: 'pwaService',
  capabilities: {
    /** 已安装应用列表（不含任何绝对路径）。 */
    'pwa.list': (svc) => svc.list(),

    'pwa.get': (svc, input) => svc.get(input.id),

    /**
     * 安装：`input = { candidateId, options? }`。
     * 候选由主进程探测产生，插件侧无法自造 start_url。
     * 没有 session 时安装管线回落 defaultSession（图标下载用）。
     */
    'pwa.install': (svc, input, ctx) => portsOf(ctx).pwaInstaller.install(input || {}),

    'pwa.uninstall': (svc, input, ctx) => portsOf(ctx).pwaUninstaller.uninstall(input.id),

    'pwa.launch': (svc, input, ctx) => portsOf(ctx).pwaRuntime.launch(input.id),

    'pwa.update': (svc, input, ctx) => portsOf(ctx).pwaUpdater.update(input.id),

    'pwa.checkUpdates': (svc, input, ctx) => portsOf(ctx).pwaUpdater.checkAll(input || {}),

    /**
     * 开机启动：文件与标记由 `pwaShortcuts.setStartup` 一起收敛，
     * 这里不再单独 setFlags（否则开关会与磁盘事实脱节）。
     */
    'pwa.setRunOnStartup': async (svc, input, ctx) => {
      const result = await portsOf(ctx).pwaShortcuts.setStartup(input.id, !!input.enabled)
      return {
        ok: !!result.ok,
        reason: result.reason,
        app: result.ok ? svc.get(input.id) : undefined
      }
    },

    'pwa.createShortcut': (svc, input, ctx) => portsOf(ctx).pwaShortcuts.create(input.id, input.location),

    'pwa.removeShortcut': (svc, input, ctx) => portsOf(ctx).pwaShortcuts.remove(input.id, input.location)
  }
})
