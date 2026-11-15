/**
 * 全局下载限速器（令牌桶）—— 纯 JS，逐字下沉自 main/rate-limiter.js
 *
 *   - 按字节数发牌，不足时 pause()，下个 refill 节拍后 resume()
 *   - 多个下载项共享同一令牌桶，保证"总下载速度"上限
 *   - 用户手动暂停时不介入，尊重用户意图
 */

/**
 * 创建令牌桶限速器。
 * @param {{ rateLimitBytesPerSec?: number }} [opts]
 *   rateLimitBytesPerSec: 每秒字节数；0 或未定义 = 不限速
 */
function createGlobalRateLimiter(opts: { rateLimitBytesPerSec?: number } = {}) {
  let rate = opts.rateLimitBytesPerSec || 0
  let tokens = rate // 当前桶内令牌
  let lastRefill = Date.now()
  interface Waiter { readonly bytes: number; readonly callback: () => void }
  const waiters = new Set<Waiter>()
  let refillTimer: ReturnType<typeof setTimeout> | null = null

  function scheduleRefill(): void {
    if (refillTimer || waiters.size === 0) return
    let missing = Number.POSITIVE_INFINITY
    for (const waiter of waiters) {
      const need = rate > 0 ? Math.min(waiter.bytes, rate) : waiter.bytes
      missing = Math.min(missing, need - tokens)
    }
    const delay = rate <= 0 || missing <= 0
      ? 0
      : Math.max(5, Math.ceil((missing / rate) * 1000))
    refillTimer = setTimeout(() => {
      refillTimer = null
      refill()
    }, delay)
    refillTimer.unref?.()
  }

  function refill() {
    const now = Date.now()
    const dt = (now - lastRefill) / 1000
    if (rate > 0 && dt > 0) tokens = Math.min(rate, tokens + dt * rate)
    lastRefill = now
    for (const waiter of Array.from(waiters)) {
      const need = rate > 0 ? Math.min(waiter.bytes, rate) : waiter.bytes
      if (rate > 0 && tokens < need) continue
      waiters.delete(waiter)
      try { waiter.callback() } catch (_) {}
    }
    scheduleRefill()
  }

  /**
   * 尝试消费字节数。
   * @param {number} bytes
   * @returns {'ok'|'throttle'}  'ok' 通过；'throttle' 不足，需 pause 并等下个 tick
   */
  function tryConsume(bytes: number): 'ok' | 'throttle' {
    if (rate <= 0) return 'ok'
    refill()
    // Transport delivers whole chunks. Requiring the entire chunk to fit would
    // deadlock whenever a chunk is larger than one second's budget.
    if (tokens > 0) {
      tokens = Math.max(0, tokens - bytes)
      return 'ok'
    }
    return 'throttle'
  }

  /**
   * 注册下一个 refill 节拍回调。
   * @param {Function} cb
   */
  function onNextTick(cb: () => void, bytesNeeded = 1): () => boolean {
    const waiter: Waiter = {
      bytes: Math.max(1, Math.ceil(Number(bytesNeeded) || 1)),
      callback: cb
    }
    waiters.add(waiter)
    scheduleRefill()
    return () => waiters.delete(waiter)
  }

  /** 设置新速率（0 = 不限速） */
  function setRate(bytesPerSec: number): void {
    rate = bytesPerSec || 0
    tokens = rate
    lastRefill = Date.now()
    if (refillTimer) {
      clearTimeout(refillTimer)
      refillTimer = null
    }
    scheduleRefill()
  }

  function getRate(): number { return rate }

  return {
    tryConsume,
    onNextTick,
    setRate,
    getRate,
    /** 诊断：仍在等待令牌的回调数。 */
    getWaiterCount: () => waiters.size
  }
}

// 全局单例（多下载项共享）
let _globalLimiter: ReturnType<typeof createGlobalRateLimiter> | null = null
function getGlobalRateLimiter() {
  if (!_globalLimiter) _globalLimiter = createGlobalRateLimiter({})
  return _globalLimiter
}

export {
  createGlobalRateLimiter,
  getGlobalRateLimiter
}
