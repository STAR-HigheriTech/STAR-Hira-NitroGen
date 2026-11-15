/**
 * 应用退出收尾。
 *
 * 所有落盘动作按“数据源 → 传输器 → 进程级资源”的顺序串行执行；
 * 每一步独立兜底，前一模块失败不会阻止应用退出。
 */

interface Clearable {
  clearAll?: () => unknown
}

interface Flushable {
  flush?: () => unknown
}
interface Stoppable {
  stop?: () => unknown
}

interface StorageSession {
  clearStorageData?: (options: Record<string, boolean>) => unknown
}

interface ShutdownDeps {
  setQuitting: (value: boolean) => void
  onboarding: { markQuitting?: () => void }
  settings: Flushable & { get: (key: string) => unknown }
  stopFeatureModules?: () => unknown
  flushExtensions?: () => unknown
  stopExtensionRelay: () => unknown
  history: Clearable
  downloads: Clearable
  bookmarkBackup: Flushable & Stoppable
  sessions: { stopAndFlushSync: () => Promise<void> }
  windowState: Flushable
  getPluginRegistry: () => { stopAllHealthChecks?: () => void } | null
  getPluginIsolation: () => { dispose?: () => void } | null
  getExtensionSession: () => StorageSession | null | undefined
  getExtensionSessions?: () => Array<StorageSession | null | undefined>
  privacyKeys: Record<string, string>
  print?: { dispose?: () => void } | null
  disposeRuntime?: () => unknown
  logger?: Pick<Console, 'warn'>
}

function createAppShutdownHandler({
  setQuitting,
  onboarding,
  settings,
  stopFeatureModules,
  flushExtensions,
  stopExtensionRelay,
  history,
  downloads,
  bookmarkBackup,
  sessions,
  windowState,
  getPluginRegistry,
  getPluginIsolation,
  getExtensionSession,
  getExtensionSessions,
  privacyKeys,
  print,
  disposeRuntime,
  logger = console
}: ShutdownDeps): () => Promise<boolean> {
  async function clearBrowsingDataOnExit(): Promise<void> {
    const sessionCandidates = typeof getExtensionSessions === 'function'
      ? getExtensionSessions()
      : [getExtensionSession()]
    const sessions = Array.isArray(sessionCandidates) ? sessionCandidates : []
    if (settings.get(privacyKeys.clearHistoryOnExit) && typeof history.clearAll === 'function') {
      try {
        await Promise.resolve(history.clearAll())
      } catch (error) {
        logger.warn('[shutdown] clear history failed:', error instanceof Error ? error.message : error)
      }
    }
    if (settings.get(privacyKeys.clearDownloadsOnExit) && typeof downloads.clearAll === 'function') {
      try {
        await Promise.resolve(downloads.clearAll())
      } catch (error) {
        logger.warn('[shutdown] clear downloads failed:', error instanceof Error ? error.message : error)
      }
    }

    const clearOptions: Record<string, boolean> = {}
    if (settings.get(privacyKeys.clearCacheOnExit)) clearOptions.cache = true
    if (settings.get(privacyKeys.clearCookiesOnExit)) clearOptions.cookies = true
    if (settings.get(privacyKeys.clearSiteDataOnExit)) clearOptions.localStorage = true
    if (Object.keys(clearOptions).length) {
      for (const session of sessions) {
        if (session && typeof session.clearStorageData === 'function') {
          try {
            await Promise.resolve(session.clearStorageData(clearOptions))
          } catch (error) {
            logger.warn('[shutdown] clear session data failed:', error instanceof Error ? error.message : error)
          }
        }
      }
    }
  }

  return async function beforeQuit(): Promise<boolean> {
    setQuitting(true)
    try { onboarding.markQuitting?.() } catch (_) {}

    try { await Promise.resolve(stopFeatureModules?.()) } catch (error) {
      logger.warn('[shutdown] stop feature modules failed:', error instanceof Error ? error.message : error)
    }
    try { await Promise.resolve(settings.flush?.()) } catch (_) {}
    try { await Promise.resolve(flushExtensions?.()) } catch (_) {}
    try { stopExtensionRelay() } catch (_) {}
    try { await clearBrowsingDataOnExit() } catch (_) {}
    try { await Promise.resolve(bookmarkBackup.flush?.()) } catch (_) {}
    try { await Promise.resolve(bookmarkBackup.stop?.()) } catch (_) {}
    try { await sessions.stopAndFlushSync() } catch (_) {}
    try { await Promise.resolve(windowState.flush?.()) } catch (_) {}

    const pluginRegistry = getPluginRegistry()
    try {
      if (pluginRegistry && typeof pluginRegistry.stopAllHealthChecks === 'function') {
        pluginRegistry.stopAllHealthChecks()
      }
    } catch (_) {}

    try { print?.dispose?.() } catch (_) {}

    const pluginIsolation = getPluginIsolation()
    try {
      if (pluginIsolation && typeof pluginIsolation.dispose === 'function') {
        pluginIsolation.dispose()
      }
    } catch (_) {}
    try { await Promise.resolve(disposeRuntime?.()) } catch (error) {
      logger.warn('[shutdown] dispose runtime failed:', error instanceof Error ? error.message : error)
    }

    return true
  }
}

module.exports = { createAppShutdownHandler }
