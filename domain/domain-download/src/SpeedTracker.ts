/**
 * 下载速度 / ETA 估算（滑动窗口）—— 纯函数，逐字下沉自 main/speed-tracker.js
 *
 *   - 每个下载项维护 5 个采样的滑动窗口
 *   - 用平均速度估算剩余时间，避免瞬时抖动
 *   - 采样与计算分离：updateSample 写入；getETA 只读
 *
 * 零依赖（Date.now 是全局，不触发 R3）。
 */

/**
 * 创建速度跟踪器。
 */
function createSpeedTracker() {
  // id → { lastTime, lastReceived, samples: number[] }
  interface Tracker { lastTime: number; lastReceived: number; samples: number[] }
  const trackers = new Map<string, Tracker>()

  /**
   * 写入采样（每次进度更新时调用）。
   * @param {string} id
   * @param {number} receivedBytes
   */
  function updateSample(id: string, receivedBytes: number | null | undefined): void {
    if (receivedBytes == null) return
    let tracker = trackers.get(id)
    if (!tracker) {
      tracker = { lastTime: 0, lastReceived: 0, samples: [] }
      trackers.set(id, tracker)
    }
    const now = Date.now()
    if (tracker.lastTime > 0) {
      const dt = now - tracker.lastTime
      // 至少 200ms 间隔采样，过滤高频噪声
      if (dt >= 200) {
        const delta = receivedBytes - tracker.lastReceived
        if (delta > 0) {
          const speed = delta / (dt / 1000)
          tracker.samples.push(speed)
          if (tracker.samples.length > 5) tracker.samples.shift()
        }
        tracker.lastTime = now
        tracker.lastReceived = receivedBytes
      }
    } else {
      tracker.lastTime = now
      tracker.lastReceived = receivedBytes
    }
  }

  /**
   * 计算速度和 ETA（只读，不污染采样窗口）。
   *
   * **总量未知也要报速度**：没有 Content-Length（chunked / 动态生成）时 `totalBytes` 恒为 0，
   * 若在此直接返回 0 速度，界面上"测速"就永远是空的 —— 而速度完全可以从采样窗口算出来，
   * 只有 ETA 无从谈起（置 0，由界面隐藏）。
   *
   * @param {string} id
   * @param {number} receivedBytes
   * @param {number} totalBytes
   * @param {boolean} [paused]  暂停时速度归零
   * @returns {{ speed: number, eta: number }}
   */
  function getETA(id: string, receivedBytes: number | null | undefined, totalBytes: number, paused: boolean = false): { speed: number; eta: number } {
    if (receivedBytes == null) return { speed: 0, eta: 0 }
    if (paused) return { speed: 0, eta: 0 }
    const tracker = trackers.get(id)
    if (!tracker || tracker.samples.length === 0) return { speed: 0, eta: 0 }
    let sum = 0
    for (const s of tracker.samples) sum += s
    const avgSpeed = sum / tracker.samples.length
    // 总量未知 → 只报速度，不猜 ETA；收到超过总量（重定向/压缩）时 ETA 夹到 0
    const eta = totalBytes > 0 && avgSpeed > 0
      ? Math.max(0, (totalBytes - receivedBytes) / avgSpeed)
      : 0
    return { speed: avgSpeed, eta }
  }

  /**
   * 清除某个下载项的跟踪数据。
   */
  function clear(id: string): void { trackers.delete(id) }

  return { updateSample, getETA, clear }
}

export {
  createSpeedTracker
}
