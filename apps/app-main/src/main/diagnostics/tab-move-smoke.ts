/**
 * 标签跨窗口迁移诊断。只在 NG_SMOKE_TAB_MOVE=1 时运行，不参与正式启动路径。
 */

interface SmokeWebContents {
  isDestroyed(): boolean
  listenerCount(event: string): number
  listeners(event: string): Array<(...args: unknown[]) => unknown>
}

interface SmokeTabView { webContents?: SmokeWebContents }
interface SmokeTabSummary { tabId: string; url: string }
interface SmokeTabManager {
  listAll(): SmokeTabSummary[]
  getActiveTabId(): string | null
  detachTab(tabId: string): unknown
  adoptTab(bundle: unknown): unknown
}
interface SmokeWindow {
  win: { id: number }
  tabManager: SmokeTabManager
}

async function runTabMoveSmoke({
  browserWindows,
  primaryWindow,
  tabManager,
  moveTabToWindow,
  listBrowserWindows,
  logger = console
}: {
  browserWindows: { openNewWindow: (options: { focus: boolean }) => Promise<SmokeWindow> }
  primaryWindow: { webContentsManager: { getTab: (id: string) => SmokeTabView | null } }
  tabManager: SmokeTabManager
  moveTabToWindow: (options: object) => Promise<unknown>
  listBrowserWindows: () => unknown[]
  logger?: Pick<Console, 'log' | 'error'>
}): Promise<void> {
  try {
    const targetWindow = await browserWindows.openNewWindow({ focus: false })
    const before = {
      a: tabManager.listAll().length,
      b: targetWindow.tabManager.listAll().length
    }
    const tabId = tabManager.getActiveTabId()
    if (!tabId) throw new Error('no active tab to move')
    const moved = await moveTabToWindow({ tabId, targetWindowId: targetWindow.win.id })
    logger.log('[smoke] move result:', JSON.stringify(moved))
    await new Promise((resolve) => setTimeout(resolve, 1200))
    logger.log('[smoke] windows:', JSON.stringify(listBrowserWindows()))
    logger.log(
      '[smoke] before:',
      JSON.stringify(before),
      'after:',
      JSON.stringify({
        a: tabManager.listAll().length,
        b: targetWindow.tabManager.listAll().length
      })
    )
    logger.log(
      '[smoke] moved tab url in target:',
      JSON.stringify(targetWindow.tabManager.listAll().map((tab: { tabId: string; url: string }) => `${tab.tabId}=${tab.url}`))
    )

    const bundle = targetWindow.tabManager.detachTab(tabId)
    const restored = tabManager.adoptTab(bundle)
    logger.log('[smoke] move back result:', JSON.stringify(restored))
    await new Promise((resolve) => setTimeout(resolve, 1500))
    logger.log(
      '[smoke] back counts:',
      JSON.stringify({
        a: tabManager.listAll().length,
        b: targetWindow.tabManager.listAll().length
      })
    )

    const countListeners = (id: string) => {
      const webContents = primaryWindow.webContentsManager.getTab(id)?.webContents
      if (!webContents || webContents.isDestroyed()) return null
      return {
        didNavigate: webContents.listenerCount('did-navigate'),
        titleUpdated: webContents.listenerCount('page-title-updated'),
        destroyed: webContents.listenerCount('destroyed'),
        didStartLoading: webContents.listenerCount('did-start-loading')
      }
    }
    logger.log('[smoke] moved-back tab listeners:', JSON.stringify(countListeners(tabId)))
    logger.log('[smoke] untouched  tab listeners:', JSON.stringify(countListeners('w1t1')))

    const dumpDestroyedListeners = (id: string, label: string) => {
      const webContents = primaryWindow.webContentsManager.getTab(id)?.webContents
      if (!webContents || webContents.isDestroyed()) return
      logger.log(
        `[smoke] ${label} destroyed listeners:`,
        JSON.stringify(
          webContents.listeners('destroyed').map((fn) => String(fn).replace(/\s+/g, ' ').slice(0, 70))
        )
      )
    }
    dumpDestroyedListeners(tabId, 'moved-back')
    dumpDestroyedListeners('w1t1', 'untouched ')
  } catch (error) {
    logger.error('[smoke] move failed:', error instanceof Error ? error.stack : error)
  }
}

module.exports = { runTabMoveSmoke }
