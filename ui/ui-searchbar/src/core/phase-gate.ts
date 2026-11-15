export interface PhaseGate {
  wait(delayMs: number): Promise<boolean>
  cancel(): void
}

/** One-shot cancellable debounce used between fast and slow suggestion phases. */
export function createPhaseGate(): PhaseGate {
  let timer: ReturnType<typeof setTimeout> | null = null
  let settle: ((ready: boolean) => void) | null = null

  function cancel(): void {
    if (timer !== null) {
      clearTimeout(timer)
      timer = null
    }
    const resolve = settle
    settle = null
    resolve?.(false)
  }

  return {
    wait(delayMs) {
      cancel()
      return new Promise<boolean>((resolve) => {
        settle = resolve
        timer = setTimeout(() => {
          timer = null
          settle = null
          resolve(true)
        }, Math.max(0, delayMs))
      })
    },
    cancel
  }
}
