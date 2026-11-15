/**
 * Provider 桥接助手 —— 域 IPC 路由的统一 Provider 化出口。
 *
 * ════════════════════════════════════════════════════════════════════
 * 三种"没有 provider"必须分开对待（这是本文件的全部存在理由）
 * ════════════════════════════════════════════════════════════════════
 *
 * ```
 * ① 插件未安装 / 加载失败 / 被沙箱拦 → 走 fallback（降级）：功能保留，用户无感
 * ② 插件被【显式禁用】（用户关闭 or 连环坏自动停用）→ 不走 fallback：功能真的消失
 * ③ 插件在，但它对这次调用抛错 → 按旧规则 recover（可恢复的回落 fallback）
 * ```
 *
 * ①与②必须区分开：`fallback()`（域服务直连）是"插件体系不可用时的保命绳"，
 * 不是"用户关了插件之后继续偷偷提供服务"的后门。混为一谈的后果就是 §9 那个
 * **开关假生效** —— 插件中心显示已禁用、状态也持久化了，功能一点没变。
 *
 * 判据不在本文件里算：`providerRegistry.isCapabilityBlocked(capability)` 由注册中心
 * 依据「被禁用的插件的 manifest.capabilities」现算（见 PluginRegistryV2 的说明）。
 * 本文件只负责"问一句、然后决定走哪条路"。
 */
export interface ProviderRegistryPort {
  getByCapability(capability: string): readonly unknown[]
  isCapabilityBlocked?(capability: string): boolean
  executeCapability(capability: string, input: unknown, context: unknown): unknown
}

export interface BlockedCapabilityError extends Error {
  hiraCapabilityBlocked: true
  capability: string
}

export interface ProviderInvokerOptions {
  onProviderError?(error: unknown, context: { capability: string; input: unknown; context: unknown }): void
}

export type ProviderInvoker = <T>(
  capability: string,
  fallback: () => T | Promise<T>,
  input: unknown,
  context?: unknown
) => T | Promise<T>

export function isNonRecoverableProviderError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error)
  return message.includes('permission denied') || message.includes('validation failed')
}

/**
 * 「能力因插件被禁用而不可用」的专用错误。
 *
 * 为什么不用普通 `Error`：上层（IPC 处理器、渲染层的 notice）需要能把它与"真的坏了"
 * 区分开 —— 前者是**用户自己的选择造成的正常结果**，不该弹成故障、也不该写进错误日志
 * 去污染健康度判断（`hiraDomainServiceError` 那条链同理，但方向相反：那个是"别算在
 * 插件头上"，这个是"别算成故障"）。打一个可判定的标记，比让上层去 match 中文文案可靠。
 */
export function createBlockedCapabilityError(capability: string): BlockedCapabilityError {
  const error = new Error(`能力不可用：${capability}（提供它的插件已被禁用）`) as BlockedCapabilityError
  error.hiraCapabilityBlocked = true
  error.capability = capability
  return error
}

export function createProviderInvoker(
  providerRegistry: ProviderRegistryPort | null | undefined,
  options: ProviderInvokerOptions = {}
): ProviderInvoker {
  const onProviderError = typeof options.onProviderError === 'function' ? options.onProviderError : null
  return <T>(capability: string, fallback: () => T | Promise<T>, input: unknown, context?: unknown): T | Promise<T> => {
    const hasProvider = providerRegistry && providerRegistry.getByCapability(capability).length > 0

    if (!hasProvider) {
      /**
       * ⚠ 顺序很重要：先问"是不是被禁用了"，再决定要不要兜底。
       *
       * 只在 `!hasProvider` 分支问这一句也是刻意的 —— 若另一个仍然启用的插件
       * 也提供同一 capability，`hasProvider` 为真，上面这条路根本不会走到这里，
       * 功能照常可服务。**"某个被禁用的插件也声明过它"不足以判定不可用。**
       */
      const blocked = providerRegistry
        && typeof providerRegistry.isCapabilityBlocked === 'function'
        && providerRegistry.isCapabilityBlocked(capability)
      if (blocked) throw createBlockedCapabilityError(capability)
      return fallback()
    }

    const recover = (error: unknown): T | Promise<T> => {
      if (onProviderError) onProviderError(error, { capability, input, context })
      if (isNonRecoverableProviderError(error)) throw error
      return fallback()
    }

    try {
      const result = providerRegistry.executeCapability(capability, input, context)
      return result && typeof (result as PromiseLike<T>).then === 'function'
        ? Promise.resolve(result as T | PromiseLike<T>).catch(recover)
        : result as T
    } catch (error) {
      return recover(error)
    }
  }
}

