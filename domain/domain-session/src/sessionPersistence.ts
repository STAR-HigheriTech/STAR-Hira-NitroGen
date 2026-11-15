import type {
  CreateSessionPersistenceOptions,
  LoggerPort,
  SessionPersistence,
  SessionTabPort
} from './types'

interface PersistenceTarget {
  dir: string
  tabPort: SessionTabPort
}

function warnWith(logger?: LoggerPort): (message: string) => void {
  return (message) => {
    if (logger && typeof logger.warn === 'function') logger.warn(message)
    else console.warn(message)
  }
}

/**
 * 脏标记 + 有界批量落盘。
 *
 * markDirty 只做 O(1) 状态更新；热路径不在主进程同步写 JSON。
 * 定时器按需启动：没有脏数据时不保留任何轮询；脏数据最迟在 flushIntervalMs 后落盘。
 * stop() 可等待在飞写入，flushSync() 专供退出兜底。
 */
export function createSessionPersistence(options: CreateSessionPersistenceOptions = {}): SessionPersistence {
  const { sessionService, flushIntervalMs = 2000, logger } = options
  if (!sessionService || typeof sessionService.saveAsync !== 'function' || typeof sessionService.save !== 'function') {
    throw new Error('[domain-session] createSessionPersistence requires sessionService (save + saveAsync)')
  }
  const service = sessionService
  const warn = warnWith(logger)
  let target: PersistenceTarget | null = null
  let dirty = false
  let flushing = false
  let inflight: Promise<boolean> | null = null
  let stopped = false
  let started = false
  let timer: ReturnType<typeof setTimeout> | null = null

  function clearTimer(): void {
    if (!timer) return
    clearTimeout(timer)
    timer = null
  }

  function schedule(): void {
    if (!started || stopped || timer || !dirty || flushing) return
    timer = setTimeout(() => {
      timer = null
      void flush().finally(() => {
        if (dirty) schedule()
      })
    }, flushIntervalMs)
    if (timer && typeof timer.unref === 'function') timer.unref()
  }

  function markDirty(dir: string, tabPort: SessionTabPort): void {
    target = { dir, tabPort }
    dirty = true
    schedule()
  }

  function flush(): Promise<boolean> {
    if (stopped) return Promise.resolve(false)
    if (!dirty || !target || flushing) return inflight ?? Promise.resolve(false)

    clearTimer()
    const current = target
    flushing = true
    dirty = false
    inflight = (async () => {
      try {
        const ok = await service.saveAsync(current.dir, current.tabPort)
        if (!ok) dirty = true
        return ok
      } catch (error) {
        dirty = true
        warn(`[session] flush failed: ${error instanceof Error ? error.message : String(error)}`)
        return false
      } finally {
        flushing = false
        inflight = null
        schedule()
      }
    })()
    return inflight
  }

  function flushSync(): boolean {
    if (!target) return false
    try {
      const ok = service.save(target.dir, target.tabPort)
      dirty = !ok
      return ok
    } catch (error) {
      dirty = true
      warn(`[session] flushSync failed: ${error instanceof Error ? error.message : String(error)}`)
      return false
    }
  }

  function start(): void {
    if (started) return
    started = true
    stopped = false
    schedule()
  }

  function stop(): Promise<void> {
    clearTimer()
    started = false
    stopped = true
    return inflight ? inflight.then(() => undefined, () => undefined) : Promise.resolve()
  }

  return {
    markDirty,
    flush,
    flushSync,
    start,
    stop,
    isDirty: () => dirty,
    FLUSH_INTERVAL_MS: flushIntervalMs
  }
}
