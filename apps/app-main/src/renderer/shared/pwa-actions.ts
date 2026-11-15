/**
 * PWA 动作层 —— 「安装为应用 / 在应用中打开」的**唯一实现**。
 *
 * 两类入口共用这里：
 *   · 地址栏的三态安装按钮（`controllers/pwa-install-controller.js`）；
 *   · 标签行右键菜单的三处宿主（横向标签条 / 打开标签面板 / 竖直标签列，
 *     由 `shared/tab-row-menu.js` 与 `controllers/tab-session-controller.js` 注入）。
 * 于是「点菜单里的安装」与「点地址栏的安装」走同一条 prepare → 确认窗流程，
 * 不会出现两份流程各自演化（这正是本项目反复踩过的复制粘贴漂移）。
 *
 * 边界：本模块不认识窗口 / 标签管理器 / 插件系统，只经注入的 pwaClient 与 invoke 说话；
 * 候选与预览一律由主进程给，渲染层不自己拼。
 */

import { getHiraBridge } from './bridge.js'
import { isFeatureAvailable } from './hira-client.js'
import { pwaClient } from './pwa-client.js'
// 「算不算普通网页」的唯一判据 —— 内部页 / 空白页 / devtools 一律不算。
import { isHttpUrl } from '@hira-ng/shared-types/src/url-protocols.mjs'

interface PwaActionClient {
  prepare(tabId: string): Promise<Record<string, unknown>>
  launch(appId: string): Promise<unknown>
  state(tabId: string): Promise<Record<string, unknown>>
}

interface PwaMenuDependencies {
  pwaClient: PwaActionClient
  invoke(route: string, payload?: object): Promise<unknown>
  isFeatureAvailable?(featureId: string): boolean
}

/** 只有 http(s) 页面才可能安装（内部页 / 空白页 / devtools 一律不算）。 */
export function isPwaInstallableUrl(url: unknown): boolean {
  return isHttpUrl(url)
}

/**
 * 安装流程（地址栏按钮与右键菜单的唯一实现）。
 *
 * @param {{
 *   pwaClient: object,
 *   invoke: (route: string, arg?: object) => Promise<unknown>,
 *   tabId: string,
 *   installedAppId?: string|null
 * }} input
 *   `installedAppId`：调用方**已经知道**这一页装过时直接给（省一次预览判断），
 *   可为空 —— `prepare` 返回的 `preview.installedId` 是更权威的判据。
 * @returns {Promise<{ ok: boolean, reason?: string, opened?: boolean, launched?: string }>}
 */
export async function startPwaInstall({
  pwaClient: client,
  invoke,
  tabId,
  installedAppId = null
}: {
  pwaClient: PwaActionClient
  invoke(route: string, payload?: object): Promise<unknown>
  tabId: string
  installedAppId?: string | null
}) : Promise<{ ok: boolean, reason?: string, opened?: boolean, launched?: string }> {
  const id = tabId ? String(tabId) : ''
  if (!id) return { ok: false, reason: 'no-tab' }
  const res = await client.prepare(id)
  if (!res || !res.ok || !res.candidateId) {
    return { ok: false, reason: typeof res?.reason === 'string' && res.reason ? res.reason : 'prepare-failed' }
  }
  // 已装过 → 直接开应用（与 Edge「再次点击打开应用」一致），不再弹安装确认。
  const preview = res.preview !== null && typeof res.preview === 'object'
    ? res.preview as Record<string, unknown>
    : null
  const previewInstalledId = preview?.installedId
  const already = typeof previewInstalledId === 'string' && previewInstalledId
    ? previewInstalledId
    : installedAppId || null
  if (already) {
    await client.launch(String(already))
    return { ok: true, launched: String(already) }
  }
  await invoke('window:open', {
    type: 'pwa-install',
    payload: { candidateId: res.candidateId, preview: res.preview || null }
  })
  return { ok: true, opened: true }
}

/**
 * 标签右键菜单的三个端口（契约见 `ui-common#tabContextMenu` 的 handlers）。
 *
 * 「这一页装没装过」问主进程（`pwa:state`），不在这里缓存 —— 菜单是低频操作，
 * 一次本地态查询换来的是**永远准确**的文案（安装完立刻变「在应用中打开」）。
 * 引擎被禁用 / 查询失败 → 返回 null，模板据此整段不出现（S4）。
 *
 * @param {{
 *   pwaClient: object,
 *   invoke: (route: string, arg?: object) => Promise<unknown>,
 *   isFeatureAvailable?: (featureId: string) => boolean
 * }} deps
 */
export function createPwaMenuHandlers({
  pwaClient: client,
  invoke,
  isFeatureAvailable: isAvailable = (_featureId: string) => true
}: PwaMenuDependencies) {
  async function getPwaMenuState(tabId: unknown) {
    if (!tabId || !isAvailable('pwaApps')) return null
    try {
      const res = await client.state(String(tabId))
      return res && typeof res === 'object' ? res : null
    } catch (_) {
      // 探测层没结果 / 引擎刚被禁用都不是错误 —— 这一项直接不出现。
      return null
    }
  }

  function onInstallPwa(tab: { tabId?: unknown; url?: unknown } | null | undefined) {
    if (!tab || !tab.tabId || !isPwaInstallableUrl(tab.url)) return
    startPwaInstall({ pwaClient: client, invoke, tabId: String(tab.tabId) })
      .catch((e) => console.error('[pwa-actions] prepare/open failed:', e))
  }

  function onOpenPwaApp(appId: unknown) {
    if (!appId) return
    Promise.resolve(client.launch(String(appId)))
      .catch((e) => console.error('[pwa-actions] launch failed:', e))
  }

  return { getPwaMenuState, onInstallPwa, onOpenPwaApp }
}

/**
 * 三处标签菜单宿主共用的**同一份**端口（模块级单例）。
 * 接线只写这一处，宿主只把对象 spread 进 handlers —— 与 menuClient / tabsClient 同款。
 */
export const pwaMenuHandlers = createPwaMenuHandlers({
  pwaClient,
  invoke: (route, arg) => getHiraBridge().provider.invoke(route, arg),
  isFeatureAvailable
})


