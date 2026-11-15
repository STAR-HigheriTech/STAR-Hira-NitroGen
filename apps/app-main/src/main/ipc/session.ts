import type { IpcRoutes, IpcSchemas, IpcTypedMain } from './types'

const { createProviderInvoker } = require('./provider-bridge.js') as {
  createProviderInvoker(registry: unknown): <T>(capability: string, fallback: () => T | Promise<T>, input: unknown) => T | Promise<T>
}

interface SessionServicePort {
  read(dir: string): unknown
  stats(dir: string): unknown
  save(dir: string, tabPort: unknown): unknown
  restore(dir: string, tabPort: unknown): unknown
  clear(dir: string): unknown
  exists(dir: string): unknown
}

interface LastClosedSessionServicePort {
  summary(dir: string): unknown
  restore(dir: string, tabPort: unknown): unknown
  clear(dir: string): unknown
}

interface SessionIpcContext {
  routes: IpcRoutes
  schemas: IpcSchemas['session']
  sessionService?: SessionServicePort | null
  lastClosedSessionService?: LastClosedSessionServicePort | null
  sessionTabPort?: unknown
  providerRegistry: unknown
  getSessionDir?: () => string
}

/**
 * 会话域 IPC。
 *
 * `sessionTabPort` 是**窄端口**（infra-window#createSessionTabPort），不是裸 TabManager：
 * 领域服务只认识 list / getActiveTabId / newTab / switchTo 这几个动词，
 * 由装配层负责把「按窗口解析的 TabManager」适配过去。裸实例会让领域层
 * 悄悄依赖宿主实现细节（历史 bug：对象展开丢原型方法）。
 */
export function registerSessionIpc(typedMain: IpcTypedMain, {
  routes,
  schemas,
  sessionService,
  lastClosedSessionService,
  sessionTabPort,
  providerRegistry,
  getSessionDir
}: SessionIpcContext): void {
  if (!sessionService || !sessionTabPort || typeof getSessionDir !== 'function') return
  const getDir = getSessionDir

  const invoke = createProviderInvoker(providerRegistry)

  function invokeSession<T>(capability: string, fallback: () => T | Promise<T>): T | Promise<T> {
    const input = { dir: getDir() }
    return invoke(capability, fallback, input)
  }

  /**
   * 「上次关闭」的三条路由：与自动会话**同一套领域动词**，只是换了个只读副本文件
   * （`last-closed.json` 在启动时生成）。服务缺失时整组跳过 —— 不影响自动会话。
   */
  function registerLastClosed(): void {
    if (!lastClosedSessionService || !schemas.lastClosed) return
    typedMain.handle(routes.sessionLastClosed, {
      requestSchema: schemas.lastClosed.request,
      responseSchema: schemas.lastClosed.response,
      handler: async () => invokeSession('session.lastClosed', () => lastClosedSessionService.summary(getDir()))
    })
    typedMain.handle(routes.sessionLastClosedRestore, {
      requestSchema: schemas.lastClosedRestore.request,
      responseSchema: schemas.lastClosedRestore.response,
      handler: async () => invokeSession('session.lastClosedRestore', () => lastClosedSessionService.restore(getDir(), sessionTabPort))
    })
    typedMain.handle(routes.sessionLastClosedClear, {
      requestSchema: schemas.lastClosedClear.request,
      responseSchema: schemas.lastClosedClear.response,
      handler: async () => ({ ok: await invokeSession('session.lastClosedClear', () => lastClosedSessionService.clear(getDir())) })
    })
  }

  typedMain.handle(routes.sessionRead, {
    requestSchema: schemas.read.request,
    responseSchema: schemas.read.response,
    handler: async () => invokeSession('session.read', () => sessionService.read(getDir()))
  })

  typedMain.handle(routes.sessionStats, {
    requestSchema: schemas.stats.request,
    responseSchema: schemas.stats.response,
    handler: async () => invokeSession('session.stats', () => sessionService.stats(getDir()))
  })

  typedMain.handle(routes.sessionSave, {
    requestSchema: schemas.save.request,
    responseSchema: schemas.save.response,
    handler: async () => ({ ok: await invokeSession('session.save', () => sessionService.save(getDir(), sessionTabPort)) })
  })

  typedMain.handle(routes.sessionRestore, {
    requestSchema: schemas.restore.request,
    responseSchema: schemas.restore.response,
    handler: async () => invokeSession('session.restore', () => sessionService.restore(getDir(), sessionTabPort))
  })

  typedMain.handle(routes.sessionClear, {
    requestSchema: schemas.clear.request,
    responseSchema: schemas.clear.response,
    handler: async () => ({ ok: await invokeSession('session.clear', () => sessionService.clear(getDir())) })
  })

  typedMain.handle(routes.sessionExists, {
    requestSchema: schemas.exists.request,
    responseSchema: schemas.exists.response,
    handler: async () => ({ exists: await invokeSession('session.exists', () => sessionService.exists(getDir())) })
  })

  registerLastClosed()
}

