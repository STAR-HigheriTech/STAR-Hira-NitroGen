/**
 * IPC · Page 域（TypeScript）—— 当前页面信息 / 查看源代码
 *
 * 两者都以「活动标签」为默认目标，也允许显式传 tabId（例如从右键菜单针对
 * 被点击的标签而非当前标签）。数据全部来自主进程：标签记录（TabManager）
 * 与 webContents 运行态，渲染层拿不到。
 *
 * `view-source` 用 `executeJavaScript` 取主框架 outerHTML —— 只在用户主动
 * 打开「查看源代码」时才执行一次，不在任何热路径上。
 */

interface TabManagerLike {
  list(): Array<Record<string, unknown>>
  getActiveTabId(): string | null
  canGoBack(tabId: string): boolean
  canGoForward(tabId: string): boolean
}

interface WebContentsLike {
  getOSProcessId(): number
  isDestroyed?: () => boolean
  executeJavaScript(script: string): Promise<unknown>
}

interface WcmLike {
  getTab(tabId: string): { webContents?: WebContentsLike } | null
  isTabSleeping(tabId: string): boolean
}

import { errorMessage, type IpcSchemas, type IpcTypedMain } from './types'

interface Deps {
  routes?: Record<string, string>
  schemas?: IpcSchemas['page']
  tabManager?: TabManagerLike | null
  webContentsManager?: WcmLike | null
}

function resolveTarget(tabManager: TabManagerLike | null | undefined, req: { tabId?: unknown } | null | undefined) {
  if (!tabManager) return { tabId: null, tab: null }
  const requested = req && req.tabId ? String(req.tabId) : null
  const tabId = requested || (tabManager.getActiveTabId() ? String(tabManager.getActiveTabId()) : null)
  if (!tabId) return { tabId: null, tab: null }
  const tab = tabManager.list().find((t) => String(t.tabId) === tabId) || null
  // 显式传进来的目标已不存在时必须**如实回答“没有”**，不能回落到活动标签：
  // page-info 会因此把「来源标签已关闭」显示成另一页的信息 —— 比空状态更误导。
  if (requested && !tab) return { tabId: null, tab: null }
  return { tabId, tab }
}

export function registerPageIpc(
  typedMain: IpcTypedMain,
  { routes, schemas, tabManager, webContentsManager }: Deps
): void {
  if (!routes?.pageInfo || !schemas?.info || !tabManager) return

  typedMain.handle(routes.pageInfo, {
    requestSchema: schemas.info.request,
    responseSchema: schemas.info.response,
    handler: async (_e, req) => {
      const { tabId, tab } = resolveTarget(tabManager, req)
      const view = tabId && webContentsManager ? webContentsManager.getTab(tabId) : null
      const wc = view && view.webContents ? view.webContents : null

      let osPid: number | null = null
      try {
        if (wc && !(typeof wc.isDestroyed === 'function' && wc.isDestroyed())) {
          osPid = wc.getOSProcessId() || null
        }
      } catch (_) {}

      return {
        tabId,
        url: String((tab && tab.url) || ''),
        title: String((tab && tab.title) || ''),
        favicon: (tab && tab.favicon) || null,
        isLoading: Boolean(tab && tab.isLoading),
        canGoBack: tabId ? Boolean(tabManager.canGoBack(tabId)) : false,
        canGoForward: tabId ? Boolean(tabManager.canGoForward(tabId)) : false,
        isPinned: Boolean(tab && tab.pinned),
        isMuted: Boolean(tab && tab.muted),
        isSleeping: tabId && webContentsManager ? Boolean(webContentsManager.isTabSleeping(tabId)) : false,
        osPid
      }
    }
  })

  typedMain.handle(routes.pageViewSource, {
    requestSchema: schemas.viewSource.request,
    responseSchema: schemas.viewSource.response,
    handler: async (_e, req) => {
      const { tabId, tab } = resolveTarget(tabManager, req)
      const url = String((tab && tab.url) || '')
      const view = tabId && webContentsManager ? webContentsManager.getTab(tabId) : null
      const wc = view && view.webContents ? view.webContents : null

      let html: string | null = null
      try {
        if (wc && !(typeof wc.isDestroyed === 'function' && wc.isDestroyed())) {
          const result = await wc.executeJavaScript('document.documentElement.outerHTML')
          html = typeof result === 'string' ? result : null
        }
      } catch (error) {
        console.error('[page] view-source failed:', errorMessage(error))
      }

      return { url, html }
    }
  })
}

