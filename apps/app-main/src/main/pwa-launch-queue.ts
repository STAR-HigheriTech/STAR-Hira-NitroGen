/**
 * PWA 冷启动 / second-instance 队列。
 * 运行时未就绪时保留最后一个请求，就绪后由 APPS 主动 flush。
 */
export interface PwaLaunchRequest {
  appId: string
  profileId: string | null
  spaceId: string | null
  file?: string | null
  url?: string | null
}

interface PwaLaunchQueueOptions {
  logger?: Pick<Console, 'error'>
}

function createPwaLaunchQueue({ logger = console }: PwaLaunchQueueOptions = {}) {
  let handler: ((request: PwaLaunchRequest) => unknown) | null = null
  let pending: PwaLaunchRequest | null = null

  function request(requestValue: Partial<PwaLaunchRequest> & { appId?: unknown }): void {
    const appId = String((requestValue && requestValue.appId) || '').trim()
    if (!appId) return
    const normalized = {
      appId,
      profileId: requestValue.profileId || null,
      spaceId: requestValue.spaceId || null,
      file: requestValue.file || null,
      url: requestValue.url || null
    }
    if (!handler) {
      pending = normalized
      return
    }
    try {
      handler(normalized)
    } catch (error) {
      logger.error('[pwa] 打开应用失败:', error instanceof Error ? error.message : error)
    }
  }

  function setHandler(next: ((request: PwaLaunchRequest) => unknown) | null): void {
    handler = typeof next === 'function' ? next : null
    if (!handler || !pending) return
    const queued = pending
    pending = null
    request(queued)
  }

  return {
    request,
    setHandler,
    flush: () => setHandler(handler),
    hasPending: () => !!pending
  }
}

module.exports = { createPwaLaunchQueue }
