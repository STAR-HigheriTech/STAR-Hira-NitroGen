import type { ServiceRuntimeContext, TabInputs } from './service-contracts'
import type { TabManager } from '@hira-ng/infra-window'

const plugin: {
  install(ctx: ServiceRuntimeContext): void
  registerProviders(ctx: ServiceRuntimeContext): Array<{
    id: string
    capability: string
    metadata: { domain: string; plugin: string }
    around(input: TabInputs[keyof TabInputs]): unknown
  }>
  registerExtensionPoints(ctx: ServiceRuntimeContext): Array<{ name: string; service: TabManager }>
  enable(): void
  disable(): void
  uninstall(): void
} = {
  install(ctx) {
    if (!ctx.tabManager) throw new Error('tabManager is required')
  },

  registerProviders(ctx) {
    const getService = () => ctx.tabManager
    const methods: { [K in keyof TabInputs]: (input: TabInputs[K]) => unknown } = {
      'tabs.list': () => getService().list(),
      'tabs.projection': () => getService().listProjection(),
      'tabs.stack-create': (input) => getService().createStack(input),
      'tabs.stack-set': (input) => getService().setTabStack(input),
      'tabs.stack-toggle': (input) => getService().toggleStack(input.stackId),
      'tabs.stack-rename': (input) => getService().renameStack(input),
      'tabs.stack-set-color': (input) => getService().setStackColor(input),
      'tabs.stack-merge': (input) => getService().mergeStacks(input),
      // 解散标签组（成员全部回到散标签）。与 IPC 面（tab:stack-dissolve）保持一致 ——
      // domain 的 splitStack（把**部分**成员迁到新组）没有 UI 入口，这里也不再暴露。
      'tabs.stack-dissolve': (input) => getService().dissolveStack(input),
      // 栈查询与通用 patch —— 与 IPC 面（tab:stack-get / -list / -update …）一一对应。
      // ⚠ 形状必须和 IPC handler 的 fallback 出口**逐字一致**（list 包 {stacks}、in-any 包
      //   {tabId,inStack}），否则插件命中时响应契约会校验失败。
      'tabs.stack-get': (input) => getService().getStack(input.stackId),
      'tabs.stack-of-tab': (input) => getService().getStackOfTab(input.tabId),
      'tabs.stack-list': () => ({ stacks: getService().getAllStacks() }),
      'tabs.stack-is-tab-in-any': (input) => ({
        tabId: String(input.tabId),
        inStack: getService().isTabInAnyStack(input.tabId)
      }),
      'tabs.stack-update': (input) => getService().updateStack(input),
      'tabs.create': (input) => getService().newTab(input || {}),
      'tabs.create-incognito': (input) => getService().newIncognitoTab(input || {}),
      'tabs.activate': (input) => getService().switchTo(input.tabId),
      'tabs.close': (input) => getService().close(input.tabId),
      'tabs.close-others': (input) => getService().closeOthers(input.tabId),
      'tabs.close-right': (input) => getService().closeRight(input.tabId),
      'tabs.reorder': (input) => getService().reorder(input),
      'tabs.toggle-pin': (input) => getService().togglePin(input.tabId),
      'tabs.toggle-mute': (input) => getService().toggleMute(input.tabId),
      'tabs.duplicate': (input) => getService().duplicate(input.tabId),
      'tabs.can-go-back': (input) => {
        const tabId = input?.tabId || getService().getActiveTabId()
        return tabId ? getService().canGoBack(tabId) : false
      },
      'tabs.can-go-forward': (input) => {
        const tabId = input?.tabId || getService().getActiveTabId()
        return tabId ? getService().canGoForward(tabId) : false
      },
      'tabs.undo-close': () => getService().undoClose(),
      // 已关闭标签页（对齐 RT recently-closed）：列出 / 清空 / 恢复指定项，
      // 与 undo-close 共用同一内存栈；恢复的 index 口径 = 列表返回顺序。
      'tabs.recently-closed': () => getService().listRecentlyClosed(),
      'tabs.recently-closed:clear': () => getService().clearRecentlyClosed(),
      'tabs.recently-closed:restore': (input) => input?.index === undefined
        ? getService().undoClose()
        : getService().undoCloseAt(input.index),
      'tabs.navigate': (input) => getService().navigate(input),
      'tabs.back': (input) => {
        const tabId = input?.tabId || getService().getActiveTabId()
        return tabId ? getService().goBack(tabId) : { ok: false }
      },
      'tabs.forward': (input) => {
        const tabId = input?.tabId || getService().getActiveTabId()
        return tabId ? getService().goForward(tabId) : { ok: false }
      },
      'tabs.reload': (input) => {
        const tabId = input?.tabId || getService().getActiveTabId()
        return tabId ? getService().reload(tabId) : false
      },
      'tabs.stop': (input) => {
        const tabId = input?.tabId || getService().getActiveTabId()
        return tabId ? getService().stop(tabId) : false
      },
      'tabs.sleep': (input) => {
        const tabId = input?.tabId || getService().getActiveTabId()
        return tabId ? getService().sleepTab(tabId) : false
      },
      'tabs.wake': (input) => getService().wakeTab(input.tabId),
      'tabs.sleep-inactive': (input) => getService().sleepInactive(input || {}),
      'tabs.get-active': () => getService().getActiveTabId(),
      'tabs.next': () => getService().nextTab(),
      'tabs.prev': () => getService().prevTab(),
      'tabs.omnibox-action': (input) => getService().omniboxAction(String(input?.action || ''))
    }
    return (Object.entries(methods) as Array<[keyof TabInputs, (input: TabInputs[keyof TabInputs]) => unknown]>).map(([capability, invoke]) => ({
      id: `tabs.service.${capability.slice('tabs.'.length)}`,
      capability,
      metadata: { domain: 'tabs', plugin: 'tabs-service' },
      around(input) {
        return invoke(input)
      }
    }))
  },

  registerExtensionPoints(ctx) {
    return [{ name: 'tabs.service', service: ctx.tabManager }]
  },

  enable() {},
  disable() {},
  uninstall() {}
}

module.exports = plugin
