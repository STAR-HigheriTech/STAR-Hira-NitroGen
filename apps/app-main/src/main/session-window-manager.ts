/**
 * 窗口会话分片管理器。
 *
 * 每个窗口独立写一份会话：主窗口使用 session.json，其它窗口使用
 * session-w<n>.json。切空间、关闭窗口、恢复多窗口和退出落盘都从这里走，
 * APPS 层不再直接维护分片表与持久化生命周期。
 */

interface SessionServicePort {
  saveAsync(dir: string, tabPort: object): Promise<SessionOperationResult>
  restore(dir: string, tabPort: object): Promise<SessionOperationResult>
}

interface SessionOperationResult { restored?: boolean; [key: string]: unknown }

interface SessionTabManager {
  on(event: 'tab:changed', listener: () => void): unknown
  newTab(options?: { url?: string }): Promise<unknown>
}

interface SessionWindowRuntime {
  isPrimary?: boolean
  sessionFileName?: string
  tabManager?: SessionTabManager
  __sessionTracking?: boolean
}

interface SessionPersistencePort {
  start(): unknown
  markDirty(dir: string, tabPort: object): unknown
  stop(): unknown
  flushSync(): void
}

interface WindowSessionEntry {
  service: SessionServicePort
  persistence: SessionPersistencePort
}

/**
 * @param {object} deps
 * @param {object} deps.sessionService
 * @param {object} deps.sessionPersistence
 * @param {(options: object) => object} deps.createSessionService
 * @param {(options: object) => object} deps.createSessionPersistence
 * @param {(tabManager: object, options?: object) => object} deps.createSessionTabPort
 * @param {() => object} deps.createFilePort
 * @param {object} deps.fs
 * @param {object} deps.path
 * @param {(tab: object, now: number) => boolean} deps.isExpiredTab
 * @param {(runtime: object) => { profileId: string, spaceId: string }} deps.getSpace
 * @param {(profileId: string, spaceId: string) => string} deps.getSessionDir
 * @param {() => object[]} deps.getAllWindows
 * @param {(options: object) => Promise<object>} deps.openWindow
 * @param {() => string} deps.getDefaultNewTabUrl
 * @param {string} [deps.lastClosedFileName]
 * @param {Pick<Console, 'log'|'warn'|'error'>} [deps.logger]
 */
function createSessionWindowManager({
  sessionService,
  sessionPersistence,
  createSessionService,
  createSessionPersistence,
  createSessionTabPort,
  createFilePort,
  fs,
  path,
  isExpiredTab,
  getSpace,
  getSessionDir,
  getAllWindows,
  openWindow,
  getDefaultNewTabUrl,
  lastClosedFileName = 'last-closed.json',
  logger = console
}: {
  sessionService: SessionServicePort
  sessionPersistence: SessionPersistencePort
  createSessionService: (options: Record<string, unknown>) => SessionServicePort
  createSessionPersistence: (options: Record<string, unknown>) => SessionPersistencePort
  createSessionTabPort: (tabManager: SessionTabManager, options?: Record<string, unknown>) => object
  createFilePort: () => object
  fs: typeof import('node:fs')
  path: typeof import('node:path')
  isExpiredTab: (tab: object, now: number) => boolean
  getSpace: (runtime: SessionWindowRuntime) => { profileId: string; spaceId: string }
  getSessionDir: (profileId: string, spaceId: string) => string
  getAllWindows: () => SessionWindowRuntime[]
  openWindow: (options: Record<string, unknown>) => Promise<SessionWindowRuntime>
  getDefaultNewTabUrl: () => string
  lastClosedFileName?: string
  logger?: Pick<Console, 'log' | 'warn' | 'error'>
}) {
  let nextShardSeq = 2
  let quitting = false
  const windowEntries = new Map<SessionWindowRuntime, WindowSessionEntry>()

  function sessionFileNameFor(runtime: SessionWindowRuntime) {
    if (!runtime || runtime.isPrimary) return 'session.json'
    if (!runtime.sessionFileName) {
      runtime.sessionFileName = `session-w${nextShardSeq++}.json`
    }
    return runtime.sessionFileName
  }

  function sessionsFor(runtime: SessionWindowRuntime) {
    if (!runtime || runtime.isPrimary) {
      return { service: sessionService, persistence: sessionPersistence }
    }

    let entry = windowEntries.get(runtime)
    if (!entry) {
      const service = createSessionService({
        filePort: createFilePort(),
        fileName: sessionFileNameFor(runtime),
        isExpiredTab
      })
      entry = {
        service,
        persistence: createSessionPersistence({ sessionService: service })
      }
      entry.persistence.start()
      windowEntries.set(runtime, entry)
    }
    return entry
  }

  function createPrimaryTabPort(tabManager: SessionTabManager, options: Record<string, unknown> = { allTabs: true }) {
    return createSessionTabPort(tabManager, options)
  }

  function saveSpaceSession(runtime: SessionWindowRuntime, dir: string, options: Record<string, unknown> = {}) {
    if (!runtime || !runtime.tabManager) return Promise.resolve(null)
    const { service } = sessionsFor(runtime)
    return service.saveAsync(dir, createSessionTabPort(runtime.tabManager, options))
  }

  function restoreSpaceSession(runtime: SessionWindowRuntime, dir: string) {
    if (!runtime || !runtime.tabManager) return Promise.resolve(null)
    const { service } = sessionsFor(runtime)
    return service.restore(dir, createSessionTabPort(runtime.tabManager))
  }

  function restorePrimary(dir: string, tabManager: SessionTabManager) {
    return sessionService.restore(dir, createPrimaryTabPort(tabManager))
  }

  function archiveLastClosed(dir: string) {
    try {
      const source = path.join(dir, 'session.json')
      if (!fs.existsSync(source)) return
      fs.copyFileSync(source, path.join(dir, lastClosedFileName))
    } catch (error) {
      logger.warn('[main] archive last-closed session failed:', error instanceof Error ? error.message : error)
    }
  }

  function attachTracking(runtime: SessionWindowRuntime) {
    if (!runtime || runtime.__sessionTracking || !runtime.tabManager) return
    const tabManager = runtime.tabManager
    runtime.__sessionTracking = true
    const { persistence } = sessionsFor(runtime)
    try {
      persistence.start()
    } catch (_) {}

    tabManager.on('tab:changed', () => {
      const { profileId, spaceId } = getSpace(runtime)
      persistence.markDirty(
        getSessionDir(profileId, spaceId),
        createSessionTabPort(tabManager, {
          space: { profileId, spaceId }
        })
      )
    })
  }

  function dropWindow(runtime: SessionWindowRuntime) {
    if (!runtime || runtime.isPrimary || quitting) return
    const name = runtime.sessionFileName
    const entry = windowEntries.get(runtime)
    if (entry) windowEntries.delete(runtime)

    const stopped = entry ? entry.persistence.stop() : null
    Promise.resolve(stopped).catch(() => {}).then(() => {
      if (!name) return
      try {
        const { profileId, spaceId } = getSpace(runtime)
        fs.unlinkSync(path.join(getSessionDir(profileId, spaceId), name))
      } catch (_) {}
    })
  }

  async function restoreSecondaryWindows(dir: string) {
    let names: string[] = []
    try {
      names = fs.readdirSync(dir).filter((name) => /^session-w\d+\.json$/.test(name))
    } catch (_) {
      return
    }
    if (names.length === 0) return

    names.sort((a, b) => Number(a.slice(9, -5)) - Number(b.slice(9, -5)))
    nextShardSeq = Math.max(nextShardSeq, Number(names[names.length - 1].slice(9, -5)) + 1)
    logger.log('[main] restoring secondary windows:', names.join(', '))

    for (const name of names) {
      try {
        const runtime = await openWindow({
          skipInitialTab: true,
          focus: false,
          sessionFileName: name
        })
        if (!runtime.tabManager) throw new Error('恢复的窗口缺少 tabManager')
        const result = await restoreSpaceSession(runtime, dir)
        if (!result || !result.restored) {
          await runtime.tabManager.newTab({ url: getDefaultNewTabUrl() })
        }
      } catch (error) {
        logger.error('[main] restore secondary window failed:', name, error instanceof Error ? error.message : error)
      }
    }
  }

  function flushAllSync() {
    try { sessionPersistence.flushSync() } catch (_) {}
    for (const entry of windowEntries.values()) {
      try { entry.persistence.flushSync() } catch (_) {}
    }
  }

  function stopAllWindows() {
    return Promise.all(
      Array.from(windowEntries.values(), ({ persistence }) =>
        Promise.resolve().then(() => persistence.stop()).catch(() => {})
      )
    )
  }

  async function stopAndFlushSync() {
    try { await sessionPersistence.stop() } catch (_) {}
    await stopAllWindows()
    flushAllSync()
  }

  function allWindowsBoundToSessions() {
    for (const runtime of getAllWindows()) attachTracking(runtime)
  }

  return {
    archiveLastClosed,
    attachTracking,
    allWindowsBoundToSessions,
    createPrimaryTabPort,
    dropWindow,
    flushAllSync,
    isQuitting: () => quitting,
    markQuitting: () => { quitting = true },
    restorePrimary,
    restoreSecondaryWindows,
    restoreSpaceSession,
    saveSpaceSession,
    sessionFileNameFor,
    sessionsFor,
    stopAndFlushSync
  }
}

module.exports = { createSessionWindowManager }
