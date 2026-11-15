/**
 * pwa-install-controller.js —— 地址栏「安装应用」按钮的**唯一状态机**。
 *
 * 职责边界（组件保持哑）：
 *   · 活动标签变化 → 查 `pwa:state`，把三态推给 navbar（组件只负责画）；
 *   · 主进程推来 `pwa:detected`（页面线索解析完成）→ 按 tabId 过滤后更新；
 *   · `pwa:changed`（安装 / 卸载 / 更新）→ 重查当前标签（安装完按钮要立刻变「打开应用」）；
 *   · 点击安装 → `pwa:prepare` 拿候选 + 预览 → 开 pwa-install 确认窗；
 *   · 点击打开 → `pwa:launch`。
 *
 * 不认识 BrowserWindow / 标签管理器 / 安装管线：全部经注入的 pwaClient 与 provider 走 IPC。
 * 也不认识 navbar 的内部结构：只调 `shell.setPwaInstallState()` 这一个约定。
 *
 * 点击后的「prepare → 确认窗 / 打开应用」不在这里实现 —— 它与标签右键菜单共用
 * `shared/pwa-actions.js#startPwaInstall`（唯一实现），本文件只管三态与去重。
 */

import { isPwaInstallableUrl, startPwaInstall } from '../shared/pwa-actions.js'
import type { RendererProvider } from '../shared/bridge.js'

type PwaInstallClient = typeof import('../shared/pwa-client.js').pwaClient

interface PwaInstallTab {
  tabId?: string | null
  url?: string
  [key: string]: unknown
}

interface PwaButtonState {
  state: 'none' | 'installable' | 'installed'
  appId: string | null
}

/**
 * 主进程的探测态 → 按钮的展示态。
 *   installed   → installed（打开应用）
 *   installable → installable（完整 PWA，manifest 可用）
 *   shortcut    → none（地址栏图标只在完整 PWA 时亮；站点应用走主菜单）
 *   none        → none
 * @param {string} state
 */
function toButtonState(state: string) {
  if (state === 'installed') return 'installed'
  if (state === 'installable') return 'installable'
  return 'none'
}

/**
 * @param {{
 *   shell: { setPwaInstallState?: (state: object) => void },
 *   pwaClient: object,
 *   provider: { invoke: (route: string, arg?: object) => Promise<unknown> },
 *   getActiveTab: () => unknown,
 *   isFeatureAvailable?: (featureId: string) => boolean
 * }} deps
 */
export function createPwaInstallController(deps: {
  shell: { setPwaInstallState?: (state?: { state?: PwaButtonState['state']; appId?: string | null; title?: string }) => void },
  pwaClient: PwaInstallClient,
  provider: RendererProvider,
  getActiveTab: () => PwaInstallTab | null,
  isFeatureAvailable?: (featureId: string) => boolean
}) {
  const { shell, pwaClient, provider, getActiveTab } = deps
  const isFeatureAvailable = typeof deps.isFeatureAvailable === 'function' ? deps.isFeatureAvailable : () => true

  let disposed = false
  /** 当前标签（按钮状态的作用域）。 */
  let currentTabId: string | null = null
  /** 最近一次查询的 (tabId,url)：同一页重复 render 不重复打 IPC。 */
  let lastQueryKey = ''
  /** 查询令牌：异步结果回来时若标签已变，丢弃。 */
  let queryToken = 0
  /** 当前按钮状态（点击安装时要知道是否已安装）。 */
  let current: PwaButtonState = { state: 'none', appId: null }

  function apply(next: PwaButtonState) {
    current = next
    if (typeof shell.setPwaInstallState === 'function') {
      shell.setPwaInstallState({
        state: next.state,
        appId: next.appId,
        title: next.state === 'installed' ? '打开应用' : next.state === 'installable' ? '将此站点安装为应用' : ''
      })
    }
  }

  function reset() {
    lastQueryKey = ''
    apply({ state: 'none', appId: null })
  }

  async function refresh(tabId: string, url: string) {
    if (disposed) return
    if (!isFeatureAvailable('pwaApps') || !tabId || !isPwaInstallableUrl(url)) {
      reset()
      return
    }
    const key = `${tabId}\n${url}`
    if (key === lastQueryKey) return
    lastQueryKey = key
    const token = ++queryToken
    try {
      const res = await pwaClient.state(tabId)
      if (disposed || token !== queryToken) return
      apply({
        state: toButtonState(res && res.state),
        appId: (res && res.appId) || null
      })
    } catch (e) {
      // 探测层没结果不是错误（页面还没发线索）——静默按 none 处理即可。
      if (disposed || token !== queryToken) return
      apply({ state: 'none', appId: null })
    }
  }

  /**
   * 活动标签变化（由 tab-session-controller 的渲染回调驱动）。
   * @param {{ tabId?: string|null, url?: string }} activeTab
   */
  function onActiveTabChange(activeTab: { tabId?: string|null, url?: string }) {
    if (disposed) return
    const tabId = activeTab && activeTab.tabId ? String(activeTab.tabId) : null
    const url = (activeTab && activeTab.url) || ''
    currentTabId = tabId
    if (!tabId) {
      reset()
      return
    }
    refresh(tabId, url)
  }

  /** 点击「安装」：准备候选 → 开确认窗（候选与预览都由主进程给，渲染层不自己拼）。 */
  async function installCurrent() {
    if (disposed) return
    const tab = getActiveTab()
    const tabId = tab && tab.tabId ? String(tab.tabId) : currentTabId
    if (!tabId) return
    try {
      await startPwaInstall({
        pwaClient,
        invoke: (route, arg) => provider.invoke(route, arg),
        tabId,
        // 状态机已知"这一页装过"时直接给 appId；更权威的判据仍是 prepare 的 installedId。
        installedAppId: current.state === 'installed' ? current.appId : null
      })
    } catch (e) {
      console.error('[pwa-install-controller] prepare/open failed:', e)
    }
  }

  /** 点击「打开应用」。 */
  async function openApp(appId: string | null | undefined) {
    const id = appId || current.appId
    if (disposed || !id) return
    try {
      await pwaClient.launch(id)
    } catch (e) {
      console.error('[pwa-install-controller] launch failed:', e)
    }
  }

  // 页面线索解析完成 → 只认当前标签（其它标签的探测结果与这颗按钮无关）。
  const offDetected = pwaClient.onDetected((payload) => {
    if (disposed || !payload) return
    if (String(payload.tabId || '') !== String(currentTabId || '')) return
    apply({
      state: toButtonState(typeof payload.state === 'string' ? payload.state : ''),
      appId: typeof payload.appId === 'string' ? payload.appId : null
    })
    // 状态来自主进程，是这一页的最新事实；下次 render 不必再查一遍。
    const tab = getActiveTab()
    lastQueryKey = `${currentTabId}\n${(tab && tab.url) || ''}`
  })

  // 安装 / 卸载 / 更新 → 当前页的归属可能变了（刚装完 → 变「打开应用」）。
  const offChanged = pwaClient.onChanged(() => {
    if (disposed || !currentTabId) return
    const tab = getActiveTab()
    lastQueryKey = ''
    refresh(currentTabId, (tab && tab.url) || '')
  })

  return {
    onActiveTabChange,
    installCurrent,
    openApp,
    /**
     * 插件被禁用 / 恢复时由编排层调用：禁用就收起按钮，恢复就重查当前页。
     * （按钮 DOM 本身由按钮目录按 `feature: 'pwaApps'` 移除，这里只管状态。）
     */
    syncEngineAvailability() {
      if (disposed) return
      if (!isFeatureAvailable('pwaApps')) {
        reset()
        return
      }
      const tab = getActiveTab()
      lastQueryKey = ''
      if (tab && tab.tabId) refresh(String(tab.tabId), tab.url || '')
    },
    dispose() {
      if (disposed) return
      disposed = true
      queryToken++
      offDetected()
      offChanged()
    }
  }
}


