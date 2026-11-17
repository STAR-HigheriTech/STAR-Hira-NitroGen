/**
 * 宿主侧调用插槽的**统一入口**（主进程）。
 *
 * ══════════════════════════════════════════════════════════════════════
 * 为什么不直接调 `extensionPoints.call/callSync`
 * ══════════════════════════════════════════════════════════════════════
 * 调度器本身已经很完备（四模式、契约校验、实现隔离），但它对宿主有两条硬要求：
 *   · **插槽必须先声明** —— 未声明会抛错（这是对的，见 §3「三条硬规则」）；
 *   · **同步插槽必须同步调**（`will-navigate` 靠 `preventDefault()` 只在原生回调栈内有效）。
 *
 * 而宿主代码（IPC handler、导航钩子、搜索聚合）里的调用点分布在十来个文件里，
 * 每个都要自己写 try/catch、自己判断 sync/async —— 那就是十来份会各自漂移的样板。
 * 这份文件把样板收成一处：**错误只告警、绝不上抛**，且把"插槽没声明"也当成
 * "没有插件参与"（而不是让整个搜索/导航失败）。
 *
 * ⚠ 错误策略的取向与别处相反，这里写清楚：**插槽的错绝不拖垮宿主**。
 * 一个 Mod 的搜索过滤器写崩了，用户该看到的是"少几条过滤"，不是"搜索用不了"。
 * 插件自己的健康度由 `lifecycle.onCrash` 那条链单独管（§8.1.1），两件事不混。
 */

import { errorMessage } from './ipc/types'

interface SlotRegistryPort {
  callSync?(id: string, payload: unknown, meta?: unknown): unknown
  call?(id: string, payload: unknown, meta?: unknown): unknown
  countImplementations?(id: string): number
}

interface SlotCallerOptions { label?: string }

export interface SlotCaller {
  has(id: string): boolean
  callSync(id: string, payload: unknown, meta?: unknown): unknown | null
  call(id: string, payload: unknown, meta?: unknown): Promise<unknown | null>
  reduce(id: string, payload: unknown, meta?: unknown): unknown
  reduceAsync(id: string, payload: unknown, meta?: unknown): Promise<unknown>
  multi(id: string, payload: unknown, meta?: unknown): unknown[]
  emit(id: string, payload: unknown, meta?: unknown): Promise<void>
}

/**
 * @param {object|null} extensionPoints 调度器（`PluginRegistryV2#getSlotRegistry()`）
 * @param {{ label?: string }} [options] 日志前缀（便于定位是哪个宿主报的错）
 */
export function createSlotCaller(extensionPoints: SlotRegistryPort | null | undefined, options: SlotCallerOptions = {}): SlotCaller {
  const label = options.label || 'slot'

  function has(id: string): boolean {
    if (!extensionPoints || typeof extensionPoints.countImplementations !== 'function') return false
    try {
      return extensionPoints.countImplementations(id) > 0
    } catch (e) {
      console.warn(`[${label}] 插槽 ${id} 状态读取失败（按未实现处理）:`, errorMessage(e))
      return false
    }
  }

  /**
   * 同步执行（REDUCE / SINGLE / MULTI 在"必须同步"的宿主里也用它）。
   * 用于**原生回调栈内**的场合：那里没有 await 的余地。
   */
  function callSync(id: string, payload: unknown, meta?: unknown): unknown | null {
    if (!extensionPoints || typeof extensionPoints.callSync !== 'function') return null
    try {
      return extensionPoints.callSync(id, payload, meta)
    } catch (e) {
      console.warn(`[${label}] 插槽 ${id} 同步调用失败（已忽略，不影响宿主）:`, errorMessage(e))
      return null
    }
  }

  /** 异步执行（EVENT / 需要 await 的 MULTI）。 */
  async function call(id: string, payload: unknown, meta?: unknown): Promise<unknown | null> {
    if (!extensionPoints || typeof extensionPoints.call !== 'function') return null
    try {
      return await extensionPoints.call(id, payload, meta)
    } catch (e) {
      console.warn(`[${label}] 插槽 ${id} 调用失败（已忽略，不影响宿主）:`, errorMessage(e))
      return null
    }
  }

  /**
   * REDUCE 的语义糖。
   *
   * ⚠ **初值不在调用点传**，它是 `define` 时声明在 spec 上的（`initialValue`）：
   *   · 声明了 `initialValue`（如 `theme.token-provider` 声明为空串）→ acc 从它开始；
   *   · **没声明** → acc 从 **payload 本身**开始。
   *
   * 后者正是"过滤一串数据"的惯用写法：宿主把数组当 payload 传进来，
   * 实现写成 `(acc) => acc.filter(...)` 就直接可用，不必再为初值包一层。
   * 所以本方法失败时也回落 `payload` —— 与"没有实现时"的语义完全一致
   * （`emptyResult` 对未声明初值的 REDUCE 返回的就是 payload）。
   */
  function reduce(id: string, payload: unknown, meta?: unknown): unknown {
    const out = callSync(id, payload, meta)
    return out === null || out === undefined ? payload : out
  }

  /** 异步 REDUCE（宿主本身在 async 上下文里时用，避免同步约束）。 */
  async function reduceAsync(id: string, payload: unknown, meta?: unknown): Promise<unknown> {
    const out = await call(id, payload, meta)
    return out === null || out === undefined ? payload : out
  }

  /** MULTI 的语义糖：拿不到实现就返回空数组（宿主对"没有插件参与"做同一件事）。 */
  function multi(id: string, payload: unknown, meta?: unknown): unknown[] {
    const out = callSync(id, payload, meta)
    if (Array.isArray(out)) return out
    // MULTI 的返回值是"每个实现一个值"的数组；单个实现返回数组时调度器已展平一层。
    return out === null || out === undefined ? [] : [out]
  }

  /** EVENT 的语义糖：只通知，不关心返回值。 */
  async function emit(id: string, payload: unknown, meta?: unknown): Promise<void> {
    await call(id, payload, meta)
  }

  return { has, callSync, call, reduce, reduceAsync, multi, emit }
}

