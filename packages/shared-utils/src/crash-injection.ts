/**
 * 崩溃注入框架 (Crash Injection Framework)
 *
 * 用途：模拟模块/插件/Provider 崩溃，验证：
 *   1. 单个模块崩溃不影响其他模块
 *   2. 核心模块进入安全模式
 *   3. 插件崩溃自动禁用
 *
 * 架构：
 *   - CrashInjector: 全局崩溃注入器，可对任意模块函数注入 throw
 *   - SafeMode: 核心模块崩溃时的降级模式
 *   - ErrorBoundary: 捕获 Provider 异常，返回 fallback 值
 *
 * 解耦：纯工具模块，不依赖业务代码。
 */

/**
 * 崩溃注入器。
 * 通过替换对象方法为 throw 来模拟崩溃。
 */
class CrashInjector {
  private readonly _originals: Map<string, (...args: unknown[]) => unknown>
  private readonly _crashed: Set<string>

  constructor() {
    this._originals = new Map() // key -> original function
    this._crashed = new Set()
  }

  /**
   * 注入崩溃到指定对象的方法。
   * @param {object} obj
   * @param {string} method
   * @param {Error} [error] 自定义错误
   */
  inject(obj: Record<string, unknown>, method: string, error?: Error): void {
    const key = `${obj.constructor?.name || 'Object'}.${method}`
    if (this._originals.has(key)) return
    const original = obj[method]
    if (typeof original !== 'function') return
    this._originals.set(key, original as (...args: unknown[]) => unknown)
    obj[method] = (..._args: unknown[]) => {
      throw error || new Error(`[CrashInjector] ${key} intentionally crashed`)
    }
    this._crashed.add(key)
  }

  /** 恢复单个方法 */
  restore(obj: Record<string, unknown>, method: string): void {
    const key = `${obj.constructor?.name || 'Object'}.${method}`
    const original = this._originals.get(key)
    if (original) {
      obj[method] = original
      this._originals.delete(key)
      this._crashed.delete(key)
    }
  }

  /** 恢复全部 */
  restoreAll() {
    for (const [key, original] of this._originals) {
      // 无法直接还原对象，调用方需自行恢复
    }
    this._originals.clear()
    this._crashed.clear()
  }

  get crashed(): string[] {
    return Array.from(this._crashed)
  }
}

/**
 * 错误边界：包装 Provider 函数，异常时返回 fallback。
 * @param {Function} fn
 * @param {*} fallback
 * @param {object} [logger]
 * @returns {Function}
 */
function withErrorBoundary<TArgs extends unknown[], TResult>(
  fn: (...args: TArgs) => TResult | Promise<TResult>,
  fallback: TResult,
  logger: Pick<Console, 'warn'> = console
): (...args: TArgs) => Promise<TResult> {
  return async (...args: TArgs) => {
    try {
      return await fn(...args)
    } catch (e) {
      logger.warn(`[ErrorBoundary] provider crashed, using fallback: ${errorMessage(e)}`)
      return fallback
    }
  }
}

/**
 * 安全模式管理器。
 * 当核心模块崩溃时，切换到安全模式，提供最小可用功能。
 */
class SafeModeManager {
  private _enabled: boolean
  private readonly _listeners: Set<(enabled: boolean, reason?: string) => void>

  constructor() {
    this._enabled = false
    this._listeners = new Set()
  }

  get isEnabled(): boolean {
    return this._enabled
  }

  enable(reason: string): void {
    if (this._enabled) return
    this._enabled = true
    console.warn(`[SafeMode] enabled: ${reason}`)
    for (const listener of this._listeners) {
      try { listener(true, reason) } catch {}
    }
  }

  disable(): void {
    if (!this._enabled) return
    this._enabled = false
    console.info('[SafeMode] disabled')
    for (const listener of this._listeners) {
      try { listener(false) } catch {}
    }
  }

  onChange(listener: (enabled: boolean, reason?: string) => void): () => boolean {
    this._listeners.add(listener)
    return () => this._listeners.delete(listener)
  }
}

/**
 * 安全执行：包裹核心模块初始化，失败时进入安全模式。
 * @param {Function} init
 * @param {SafeModeManager} safeMode
 * @param {string} moduleName
 * @returns {*}
 */
function safeInit<T>(init: () => T, safeMode: SafeModeManager, moduleName: string): T | null {
  try {
    return init()
  } catch (e) {
    console.error(`[safeInit] ${moduleName} crashed: ${errorMessage(e)}`)
    safeMode.enable(`${moduleName} init crash`)
    return null
  }
}

function errorMessage(error: unknown): string {
  return error && typeof error === 'object' && 'message' in error
    ? String((error as { message: unknown }).message)
    : String(error)
}

export {
  CrashInjector,
  withErrorBoundary,
  SafeModeManager,
  safeInit
}
export default { CrashInjector, withErrorBoundary, SafeModeManager, safeInit }
