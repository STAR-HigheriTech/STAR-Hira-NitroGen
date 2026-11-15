/**
 * 网页生命周期插槽适配器（`webview.lifecycle.*`，PART7 §7.3）。
 *
 * ══════════════════════════════════════════════════════════════════════
 * 为什么需要这一层（而不是宿主直接 callSync）
 * ══════════════════════════════════════════════════════════════════════
 * 宿主在 `infra/infra-window/src/tabEvents.js` —— 那是**基础设施**，
 * 它不该认识「插件注册中心」这种上层概念，更不该为了一个钩子去处理
 * 「插槽没声明要怎么办」「实现抛错要不要吞」这类策略。
 * 所以策略全在这里（APPS 层），宿主只暴露三个窄钩子。
 *
 * ══════════════════════════════════════════════════════════════════════
 * 一半是同步、一半是"必须同步"
 * ══════════════════════════════════════════════════════════════════════
 * `will-navigate` 是 REDUCE 且**必须同步**：`preventDefault()` 只在原生回调栈内有效，
 * 任何 await 都会让"取消导航"失效。因此这里一律 `callSync`，并把调度器判定的
 * 「同步插槽塞了异步实现」当致命错误 catch 掉、降级为「没有插件参与」——
 * 一个 Mod 写错了插槽类型，用户不该连点链接都不行。
 *
 * 两个 EVENT 插槽（`did-navigate` / `did-finish-load`）同样是同步通知：
 * 它们本质是「告诉插件一声」，不能阻塞标签事件回调。
 */

const SLOT_WILL_NAVIGATE = 'webview.lifecycle.will-navigate'

interface SlotLifecycleOptions {
  extensionPoints?: { callSync: (slotId: string, payload: unknown) => unknown; isDefined?: (slotId: string) => boolean }
  logger?: { warn?: (...args: unknown[]) => void; error?: (...args: unknown[]) => void }
}
const SLOT_DID_NAVIGATE = 'webview.lifecycle.did-navigate'
const SLOT_DID_FINISH_LOAD = 'webview.lifecycle.did-finish-load'

/**
 * @param {{
 *   extensionPoints?: { callSync: Function, isDefined?: Function },
 *   logger?: { warn?: Function, error?: Function }
 * }} [options]
 */
function createSlotLifecycle (options: SlotLifecycleOptions = {}) {
  const logger = options.logger || console
  const extensionPoints = options.extensionPoints
  const usable = !!extensionPoints && typeof extensionPoints.callSync === 'function'

  /**
   * 执行一个生命周期插槽，失败一律降级为 undefined。
   * @returns {any} 插槽结果；未接调度器 / 未声明 / 执行失败均为 undefined
   */
  function safeSync (slotId: string, payload: unknown): unknown {
    if (!usable) return undefined
    if (typeof extensionPoints.isDefined === 'function' && !extensionPoints.isDefined(slotId)) return undefined
    try {
      return extensionPoints.callSync(slotId, payload)
    } catch (error) {
      logger.warn?.(`[slot-lifecycle] 插槽 ${slotId} 执行失败（已跳过，导航/加载不受影响）：`, error instanceof Error ? error.message : error)
      return undefined
    }
  }

  return {
    /**
     * `will-navigate`（REDUCE，可改写 / 可取消）。
     *
     * 流水线初值就是 payload，所以：
     *   · 只想观察的实现 → 原样 `return acc`
     *   · 想改写         → `return { ...acc, url: '新地址' }`
     *   · 想取消         → `return { ...acc, cancel: true }`
     *
     * 返回值**永远是一个对象**：插槽没接、没声明、或整体失败时都回落到原 payload，
     * 于是宿主的判断逻辑只有一条路径（不必到处判 undefined）。
     *
     * @param {{ tabId: string, url: string }} payload
     * @returns {{ tabId?: string, url?: string, cancel?: boolean }}
     */
    willNavigate (payload: { tabId: string; url: string }): { tabId?: string; url?: string; cancel?: boolean } {
      const out = safeSync(SLOT_WILL_NAVIGATE, payload)
      return (out && typeof out === 'object') ? out : payload
    },

    /** `did-navigate`（EVENT）：通知，忽略返回值。 */
    didNavigate (payload: unknown): void {
      safeSync(SLOT_DID_NAVIGATE, payload)
    },

    /** `did-finish-load`（EVENT）：通知，忽略返回值。 */
    didFinishLoad (payload: unknown): void {
      safeSync(SLOT_DID_FINISH_LOAD, payload)
    }
  }
}

module.exports = { createSlotLifecycle, SLOT_WILL_NAVIGATE, SLOT_DID_NAVIGATE, SLOT_DID_FINISH_LOAD }
