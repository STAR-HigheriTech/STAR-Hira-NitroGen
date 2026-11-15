/**
 * 首屏完成后的后台任务。
 *
 * DRM 与 PWA 更新允许延迟且失败可忽略；会话接线与冷启动 URL 队列属于确定性收尾，
 * 由调用方等待。这样启动主流程只表达顺序，不携带各任务细节。
 */

interface StartupBackgroundDeps {
  getComponents: () => { whenReady?: () => Promise<unknown> } | null
  pwaOnlyMode: boolean
  isFeatureOn: (featureId: string) => boolean
  pwaUpdater: { checkAll: () => Promise<unknown> }
  listenerRegistry: { listenerCount: number; routeCount: number }
  sessions: { allWindowsBoundToSessions: () => void }
  urlRouter: { flushPendingUrls: () => Promise<unknown> }
  logger?: Pick<Console, 'log' | 'warn'>
}

async function runStartupBackgroundTasks({
  getComponents,
  pwaOnlyMode,
  isFeatureOn,
  pwaUpdater,
  listenerRegistry,
  sessions,
  urlRouter,
  logger = console
}: StartupBackgroundDeps): Promise<void> {
  void (async () => {
    try {
      const components = getComponents()
      if (components && typeof components.whenReady === 'function') {
        await components.whenReady()
        logger.log('[main] Widevine components ready')
      }
    } catch (error) {
      logger.warn('[main] components.whenReady failed:', error instanceof Error ? error.message : error)
    }
  })()

  if (!pwaOnlyMode) {
    setTimeout(() => {
      try {
        if (!isFeatureOn('pwaApps')) return
      } catch (_) {
        return
      }
      Promise.resolve(pwaUpdater.checkAll()).catch((error) => {
        logger.warn('[pwa] 后台检查更新失败:', error && error.message)
      })
    }, 30000).unref?.()
  }

  setTimeout(() => {
    logger.log(
      `[main] event listeners registered: ${listenerRegistry.listenerCount} listener(s) / ${listenerRegistry.routeCount} route(s)`
    )
  }, 2000).unref?.()

  if (!pwaOnlyMode) {
    sessions.allWindowsBoundToSessions()
    try { await urlRouter.flushPendingUrls() } catch (_) {}
  }
}

module.exports = { runStartupBackgroundTasks }
