/** Bounds a UI-critical async read/write without retaining a second result path. */
export async function withTimeout<T> (
  work: Promise<T>,
  timeoutMs: number,
  label = 'operation'
): Promise<T> {
  let timer = 0
  try {
    return await Promise.race([
      work,
      new Promise<T>((_, reject) => {
        timer = window.setTimeout(() => reject(new Error(`${label} timeout`)), timeoutMs)
      })
    ])
  } finally {
    if (timer) window.clearTimeout(timer)
  }
}
