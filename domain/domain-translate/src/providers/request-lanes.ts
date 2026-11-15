export interface RequestLanes {
  run<T>(task: () => Promise<T>): Promise<T>
}

export interface RequestLaneOptions {
  count: number
  maxPending: number
}

/**
 * 固定并发、固定排队深度的请求通道。
 * 超出深度立即失败，避免多个标签页叠加翻译时无限积压 Promise 与正文副本。
 */
export function createRequestLanes(options: RequestLaneOptions): RequestLanes {
  const count = Math.max(1, Math.floor(options.count))
  const maxPending = Math.max(count, Math.floor(options.maxPending))
  const lanes: Array<Promise<void>> = Array.from({ length: count }, () => Promise.resolve())
  let cursor = 0
  let pending = 0

  return {
    run<T>(task: () => Promise<T>): Promise<T> {
      if (pending >= maxPending) {
        return Promise.reject(new Error('翻译请求排队过多，请稍后重试'))
      }
      pending += 1
      const lane = cursor++ % lanes.length
      const result = lanes[lane].then(task, task)
      lanes[lane] = result.then(() => undefined, () => undefined)
      return result.finally(() => {
        pending -= 1
      })
    }
  }
}
