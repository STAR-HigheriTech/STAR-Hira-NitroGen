export function toError(value: unknown): Error {
  if (value instanceof Error) return value
  const e = new Error(typeof value === 'string' ? value : JSON.stringify(value))
  e.name = 'NonErrorThrow'
  return e
}

export interface ErrorReport { name: string; message: string; stack: string | null; cause?: unknown }
export function createErrorReport(err: unknown): ErrorReport {
  const e = toError(err)
  const report: ErrorReport = {
    name: e.name,
    message: e.message,
    stack: e.stack || null
  }

  const cause = e.cause
  if (cause) report.cause = cause instanceof Error ? { name: cause.name, message: cause.message } : cause
  return report
}

export class ErrorBoundary {
  private readonly _onError: ((error: Error) => void) | null
  constructor({ onError }: { onError?: (error: Error) => void } = {}) {
    this._onError = typeof onError === 'function' ? onError : null
  }

  async run<T>(fn: () => T | Promise<T>): Promise<T> {
    try {
      return await fn()
    } catch (e) {
      const err = toError(e)
      if (this._onError) this._onError(err)
      throw err
    }
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms))
}

export function withRetry<TArgs extends unknown[], TResult>(
  fn: (...args: TArgs) => TResult | Promise<TResult>,
  { times = 3, delayMs = 50 }: { times?: number; delayMs?: number } = {}
): (...args: TArgs) => Promise<TResult> {
  return async (...args: TArgs) => {
    let lastErr = null
    for (let i = 0; i < times; i += 1) {
      try {
        return await fn(...args)
      } catch (e) {
        lastErr = toError(e)
        if (i < times - 1) await delay(delayMs)
      }
    }
    throw lastErr || new Error('retry failed')
  }
}

export function withFallback<TArgs extends unknown[], TResult>(
  fn: (...args: TArgs) => TResult | Promise<TResult>,
  fallbackValue: TResult
): (...args: TArgs) => Promise<TResult> {
  return async (...args: TArgs) => {
    try {
      return await fn(...args)
    } catch {
      return fallbackValue
    }
  }
}

export default {
  toError,
  createErrorReport,
  ErrorBoundary,
  withRetry,
  withFallback
}
