import { describe, it, expect, vi } from 'vitest'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

const require = createRequire(import.meta.url)
const tabsPlugin = require('../../../build/plugins/tabs-service.cjs')

describe('tabs-service plugin providers', () => {
  it('exposes isolated capabilities from tabManager', async () => {
    const first = {
      list: vi.fn(() => ['first']),
      listProjection: vi.fn(() => ['projected']),
      createStack: vi.fn(),
      setTabStack: vi.fn(),
      toggleStack: vi.fn(),
      renameStack: vi.fn(),
      setStackColor: vi.fn(),
      mergeStacks: vi.fn(),
      dissolveStack: vi.fn(),
      newTab: vi.fn(() => ({ tabId: 'one', url: 'about:blank' })),
      newIncognitoTab: vi.fn(),
      switchTo: vi.fn(),
      close: vi.fn(),
      closeOthers: vi.fn(),
      closeRight: vi.fn(),
      reorder: vi.fn(),
      togglePin: vi.fn(),
      toggleMute: vi.fn(),
      duplicate: vi.fn(),
      canGoBack: vi.fn(),
      canGoForward: vi.fn(),
      undoClose: vi.fn(),
      navigate: vi.fn(),
      goBack: vi.fn(),
      goForward: vi.fn(),
      reload: vi.fn(),
      sleepTab: vi.fn(),
      wakeTab: vi.fn(),
      sleepInactive: vi.fn(),
      getActiveTabId: vi.fn(() => 'active-tab'),
      nextTab: vi.fn(),
      prevTab: vi.fn(),
      omniboxAction: vi.fn(async () => ({ ok: true }))
    }
    const providers = tabsPlugin.registerProviders({ tabManager: first })
    /**
     * **不**断言"一共几个能力"：那个数字每加一个能力就会过期一次（本文件曾因此长期假红，
     * 报的是"35 ≠ 36"这种与业务无关的差异）。真正的不变式只有两条：
     *   · 能力名**唯一**（重复注册会让插槽执行两次）；
     *   · 关键能力**一个都不少**（覆盖一层一层加出来的那几族）。
     */
    const capabilities = providers.map((provider) => provider.capability)
    expect(new Set(capabilities).size).toBe(capabilities.length)
    expect(capabilities).toEqual(expect.arrayContaining([
      'tabs.list', 'tabs.projection',
      'tabs.stack-create', 'tabs.stack-set', 'tabs.stack-toggle', 'tabs.stack-rename',
      'tabs.stack-set-color', 'tabs.stack-merge', 'tabs.stack-dissolve',
      'tabs.create', 'tabs.close', 'tabs.reorder'
    ]))

    const listProvider = providers.find((provider) => provider.capability === 'tabs.list')
    expect(listProvider.around(null)).toEqual(['first'])
    expect(first.list).toHaveBeenCalledOnce()

    const projectionProvider = providers.find((provider) => provider.capability === 'tabs.projection')
    expect(projectionProvider.around(null)).toEqual(['projected'])
    const toggleStackProvider = providers.find((provider) => provider.capability === 'tabs.stack-toggle')
    toggleStackProvider.around({ stackId: 's1' })
    expect(first.toggleStack).toHaveBeenCalledWith('s1')

    const renameProvider = providers.find((provider) => provider.capability === 'tabs.stack-rename')
    renameProvider.around({ stackId: 's1', label: '工作' })
    expect(first.renameStack).toHaveBeenCalledWith({ stackId: 's1', label: '工作' })

    // 「解散标签组」（取代了原先那个语义错位的 stack-split：它只是整组换个内部 id，
    // 外观一字不变＝点了没反应，见 ui-common#tab/chipMenu 的说明）。
    const dissolveProvider = providers.find((provider) => provider.capability === 'tabs.stack-dissolve')
    dissolveProvider.around({ stackId: 's1' })
    expect(first.dissolveStack).toHaveBeenCalledWith({ stackId: 's1' })

    const omniboxProvider = providers.find((provider) => provider.capability === 'tabs.omnibox-action')
    omniboxProvider.around({ action: 'open_settings' })
    expect(first.omniboxAction).toHaveBeenCalledWith('open_settings')
  })

  it('discovers manifest capabilities and registers them on enable', async () => {
    const { PluginRegistryV2, ProviderRegistry } = require('@hira-ng/infra-plugin')
    const providerRegistry = new ProviderRegistry()
    const pluginRegistry = new PluginRegistryV2({
      pluginDir: fileURLToPath(new URL('../../../build/plugins/', import.meta.url)),
      manifestFileFilter: (name) => name === 'tabs-service.hira-plugin.json',
      providerRegistry
    })
    const manifests = pluginRegistry.discover()
    expect(manifests[0].capabilities).toContain('tabs.omnibox-action')
    expect(manifests[0].capabilities).toContain('tabs.stack-toggle')
    expect(manifests[0].capabilities).toContain('tabs.stack-merge')
    await pluginRegistry.enableAll({ tabManager: {} })
    expect(providerRegistry.getByCapability('tabs.omnibox-action')).toHaveLength(1)
    expect(providerRegistry.getByCapability('tabs.stack-toggle')).toHaveLength(1)
  })
})
