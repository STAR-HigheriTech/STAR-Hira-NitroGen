/** 为可能挂起的异步操作提供统一超时边界。底层操作无法取消时仍会让出 Agent。 */
async function withTimeout<T>(task: Promise<T>, timeoutMs: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | null = null
  try {
    return await Promise.race([
      task,
      new Promise<T>((_resolve, reject) => {
        timer = setTimeout(() => {
          const error = new Error(`${label}超时（${Math.round(timeoutMs / 1000)} 秒）`) as Error & {
            code: string
            retryable: boolean
          }
          error.code = 'TOOL_TIMEOUT'
          error.retryable = true
          reject(error)
        }, Math.max(1, timeoutMs))
      })
    ])
  } finally {
    if (timer) clearTimeout(timer)
  }
}

module.exports = { withTimeout }
