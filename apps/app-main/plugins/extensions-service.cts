/**
 * Extensions 域插件 —— 声明式能力表（kernel 机制见 infra-plugin/service-plugin.js）。
 *
 * 服务实例（extensionService）在 profile 热切换时会被重建，
 * 依赖 ctx.getDomainServices() 的懒解析保证 provider 始终指向当前实例。
 */
import { createServicePlugin } from '@hira-ng/infra-plugin'
import type { ExtensionInputs, ExtensionServicePort } from './service-contracts'

module.exports = createServicePlugin<ExtensionServicePort, ExtensionInputs>({
  domain: 'extensions',
  serviceName: 'extensionService',
  capabilities: {
    'extensions.installFromCrx': (svc, input) => svc.installFromCrx(input.path),
    'extensions.uninstall': (svc, input) => svc.uninstall(input.id),
    'extensions.listExtensions': (svc) => svc.listExtensions(),
    'extensions.toggle': (svc, input) => svc.toggle(input.id, input.enabled),
    // 「固定」只写安装记录，与 toggle 是两条独立通道（见 contracts 的说明）。
    'extensions.setPinned': (svc, input) => svc.setPinned(input.id, input.pinned),
    'extensions.iconPath': (svc, input) => {
      const list = svc.listExtensions() || []
      const ext = list.find((item) => item.id === input?.id)
      return ext ? ext.iconPath : null
    },
    'extensions.installFromPath': (svc, input) => svc.installFromPath(input.path),
    // 扩展自身页面的三条动作：本插件只声明「能力 → 域方法」，
    // 新标签页 / 父窗口等宿主依赖由 IPC 调用方以 input 传入。
    'extensions.optionsUrl': (svc, input) => svc.getOptionsUrl(input.id),
    'extensions.openPopup': (svc, input) => svc.openPopup(input.id, {
      anchorRect: input.anchorRect,
      alignment: input.alignment,
      parentWindow: input.parentWindow
    }),
    'extensions.adblockerStatus': (svc) => svc.isAdblockerEnabled(),
    // 内容拦截是「级别」而不是布尔：status/toggle 是兼容面，level/setLevel 是完整语义面。
    'extensions.adblockerLevel': (svc) => svc.getAdblockerLevel(),
    'extensions.adblockerSetLevel': (svc, input) => svc.setAdblockerLevel(input.level),
    'extensions.adblockerToggle': (svc, input) => svc.setAdblockerEnabled(input.enabled),
    'extensions.adblockerBlockedCount': (svc) => svc.getBlockedCount(),
    'extensions.runtimeStatus': (svc, input) => svc.getRuntimeStatus(input.id),
    'extensions.reload': (svc, input) => svc.reload(input.id),
    'extensions.diagnostics': (svc, input) => svc.getDiagnostics(input.id),
    'extensions.warnings': (svc, input) => svc.getWarnings(input.id),
    // 「检查视图」两个能力拆开登记：收集原始上下文（纯读运行时）与打开开发者工具
    // （有副作用）是两件事，主进程的列表增强只经前者、点击那一跳只经后者。
    'extensions.inspectViewSources': (svc, input) => svc.getInspectViewSources(input.id),
    'extensions.browserActionStates': (svc, input) => svc.getBrowserActionStates(input.tabId),
    'extensions.browserActionIcon': (svc, input) => svc.getBrowserActionIconDataUrl(input.id, input.tabId),
    'extensions.inspectView': (svc, input) => svc.inspectView(input.id, input.target),
    // 「更新」：立即检查并安装所有扩展的可用更新（开发者模式工具条）。
    'extensions.updateAll': (svc) => svc.updateAllExtensions(),
    // 扩展声明的新标签页覆盖地址（chrome_url_overrides.newtab）；无扩展覆盖时空串。
    'extensions.newTabOverrideUrl': (svc) => svc.getNewTabOverrideUrl()
  }
})
