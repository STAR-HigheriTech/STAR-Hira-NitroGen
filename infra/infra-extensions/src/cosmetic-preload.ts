/**
 * cosmetic-preload —— 接管 `@ghostery/adblocker-electron` 自带的 cosmetic preload。
 *
 * ══════════════════════════════════════════════════════════════════
 * 为什么是「接管」而不是「配置」
 * ══════════════════════════════════════════════════════════════════
 * 库在 `BlockingContext#enable()` 里写死了
 * `registerPreloadScript({ type:'frame', filePath: PRELOAD_PATH })`，没有任何可注入点；
 * 那份脚本 9,141 B，且会在 `DOMContentLoaded` 时刻同步全文档 `querySelectorAll`
 * （详见 `apps/app-main/src/main/preload/adblock-cosmetic-preload.js` 的文件头）。
 *
 * 但库把注册返回的 id 存在 `blocker.contexts.get(session).preloadScriptId` 上，
 * 而且 `disable()` 正是按这个字段注销 —— 于是只要：
 *   1. 先按它的 id 注销库的 preload；
 *   2. 注册 app 层注入的极小版本（固定 id）；
 *   3. 把 `ctx.preloadScriptId` 指向自己的 id；
 * 库的其余逻辑（IPC handler、网络拦截、disable 清理）就自动对我们这份生效，
 * 一行都不用改。**失败一律回滚成库的原件**：功能优先于体积。
 *
 * 路径由 app 层注入（infra 不认识 `out/` 布局），与 `extensionPreloadPath` 同一口径。
 */

/** 固定 id：重复 enable / 重建引擎时先按这个 id 摘掉上一份，避免「already registered」。 */
const COSMETIC_PRELOAD_ID = 'hira-adblock-cosmetic'

interface PreloadEntry {
  id: string
  type?: 'frame'
  filePath?: string
}

interface SessionPort {
  getPreloadScripts?(): PreloadEntry[]
  unregisterPreloadScript?(id: string): void
  registerPreloadScript?(options: { id: string; type: 'frame'; filePath: string }): void
}

interface BlockingContext {
  preloadScriptId?: string
}

interface ContextStore {
  get(session: SessionPort): BlockingContext | undefined
}

interface BlockerPort {
  contexts?: ContextStore
}

interface CosmeticPreloadSwap {
  takeOver(session: SessionPort | null | undefined, blocker: BlockerPort | null | undefined): boolean
  release(session: SessionPort | null | undefined): void
  preloadPath: string
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/**
 * @param {{ preloadPath?: string, logger?: { warn?: Function } }} [options]
 */
function createCosmeticPreloadSwap(options: { preloadPath?: string; logger?: { warn?: (...args: unknown[]) => void } } = {}): CosmeticPreloadSwap {
  const { preloadPath, logger = console } = options

  /** 已接管的会话（WeakMap：不阻止 session 回收）。 */
  const ownedSessions = new WeakSet<SessionPort>()

  /** @param {any} session @param {string} id */
  function hasPreload(session: SessionPort, id: string): boolean {
    try {
      if (typeof session.getPreloadScripts !== 'function') return false
      return session.getPreloadScripts().some((entry) => entry.id === id)
    } catch (_) {
      return false
    }
  }

  /** @param {any} session @param {string} id */
  function preloadEntry(session: SessionPort, id: string): PreloadEntry | null {
    try {
      if (typeof session.getPreloadScripts !== 'function') return null
      return session.getPreloadScripts().find((entry) => entry.id === id) || null
    } catch (_) {
      return null
    }
  }

  /**
   * 在 `blocker.enableBlockingInSession(session)` **之后**调用：
   * 把库刚注册的那份 cosmetic preload 换成 app 层的极小版本。
   *
   * 判据用 `ctx.preloadScriptId !== undefined`：库只在
   * `config.loadCosmeticFilters === true` 时才注册 cosmetic preload，
   * 这个字段就是「库到底挂了没挂」的唯一事实来源 —— 没挂时我们也不挂，
   * 避免给「只拦网络、不做元素隐藏」的配置凭空加一份每 frame 的税。
   *
   * @param {any} session
   * @param {any} blocker
   * @returns {boolean} 是否成功接管
   */
  function takeOver(session: SessionPort | null | undefined, blocker: BlockerPort | null | undefined): boolean {
    if (!preloadPath || !session || !blocker) return false
    let ctx: BlockingContext | null = null
    try {
      ctx = blocker.contexts?.get(session) || null
    } catch (_) {
      return false
    }
    if (!ctx || ctx.preloadScriptId === undefined) return false

    // 幂等：同一会话重复 enable 时，库会重新注册自己那份（新 id），
    // 下面照常会把它换掉；但如果此刻已经指向我们的 id，说明无事可做。
    if (ctx.preloadScriptId === COSMETIC_PRELOAD_ID && hasPreload(session, COSMETIC_PRELOAD_ID)) {
      ownedSessions.add(session)
      return true
    }

    // 记住库那份的原始定义，任何一步失败都原样挂回去。
    const originalId = ctx.preloadScriptId
    const original = preloadEntry(session, originalId)
    if (!original || !original.filePath) return false

    try {
      session.unregisterPreloadScript?.(originalId)
    } catch (e) {
      // 摘不掉就保持原样（绝不出现「两份都在」或「一份都没有」）。
      logger.warn?.('[infra-extensions] cosmetic preload swap: unregister failed:', errorMessage(e))
      return false
    }

    try {
      if (hasPreload(session, COSMETIC_PRELOAD_ID)) session.unregisterPreloadScript?.(COSMETIC_PRELOAD_ID)
      session.registerPreloadScript?.({
        id: COSMETIC_PRELOAD_ID,
        type: 'frame',
        filePath: preloadPath
      })
    } catch (e) {
      logger.warn?.('[infra-extensions] cosmetic preload swap failed, reverting:', errorMessage(e))
      try {
          session.registerPreloadScript?.({
          id: originalId,
            type: original.type || 'frame',
          filePath: original.filePath
        })
      } catch (_) { /* 回滚也失败：只能接受库的 preload 暂时缺失（服务会随下次 enable 重建） */ }
      return false
    }

    // 关键：让库的 disable() 认领我们这份（它按这个字段注销）。
    ctx.preloadScriptId = COSMETIC_PRELOAD_ID
    ownedSessions.add(session)
    return true
  }

  /**
   * 在 `blocker.disableBlockingInSession(session)` **之后**调用。
   * 库的 disable 已经按 `ctx.preloadScriptId` 注销过；这里只做兜底
   * （disable 抛错 / 引擎已被替换导致字段丢失时，按固定 id 再摘一次）。
   * @param {any} session
   */
  function release(session: SessionPort | null | undefined): void {
    if (!session) return
    try {
      if (hasPreload(session, COSMETIC_PRELOAD_ID)) session.unregisterPreloadScript?.(COSMETIC_PRELOAD_ID)
    } catch (_) {}
    ownedSessions.delete(session)
  }

  return { takeOver, release, preloadPath: preloadPath || '' }
}

module.exports = { createCosmeticPreloadSwap, COSMETIC_PRELOAD_ID }
