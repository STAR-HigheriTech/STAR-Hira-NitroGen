/**
 * PanelPresentationService —— 「面板 ↔ 独立窗口」的**主进程唯一裁决者**（与 AI 无关）。
 *
 * 一块面板只有一份实现（`panelDefinition.mount`），两种宿主：
 *   · 侧栏 —— `LayoutCoordinator` 的面板槽位；
 *   · 独立窗口 —— `detached-panel`（`WINDOW_TYPES.DETACHED_PANEL`）通用壳。
 *
 * 本文件只做**编排**，不认识任何具体面板：
 *   · 能不能拆，由面板目录里的 `presentation === 'both'` 决定（manifest 声明）；
 *   · 窗口怎么造，由注入的 `openWindow` 决定（main.js 的 openSubWindowByType）；
 *   · 侧栏开合，由注入的 `getLayout()` 决定（按调用时刻解析窗口）。
 *
 * ## 单实例语义
 * 同一 `panelId` 同时**只住一处**：拆出窗口前先关掉侧栏那份，停靠回去前先销毁窗口。
 * 于是永远不存在"两处同时写同一份状态"的可能（Doc PART15 §11.2）。
 *
 * ## 状态迁移
 * 只有**数据**，没有历史：`state` 由面板自己的 `serialize()` 给出，
 * 窗口侧从 `ctx.payload.state` 取、侧栏侧用 `panel:transfer-state` 拉（一次即焚）。
 * 历史（消息、事件）在主进程的事件日志里，迁移不重新 fold、不重新请求。
 *
 * ## 窗口类型是全局单例
 * `WindowRegistry#getSingleton(type)` 按类型唯一 —— `detached-panel` 同时只会有一个。
 * 因此拆另一块面板时，先把已在窗口里的那块**优雅停靠**回侧栏，而不是让它被静默顶掉。
 */

const WINDOW_TYPE = 'detached-panel'

interface PanelPresentationWindow { id: number; once: (event: string, listener: () => void) => void; focus: () => void; destroy: () => void; isDestroyed?: () => boolean }
interface PanelPresentationEntry { pluginId?: string; title?: string; presentation?: string }
interface PanelPresentationLayout { closePanel?: (id: string) => void; showPanel?: (id: string) => void; hidePanel?: (side: string) => void; getPanelSideOf?: (id: string) => string | null }
interface PanelPresentationDeps { openWindow: (type: string, payload: unknown) => { ok?: boolean; error?: string }; getWindow: (type: string) => PanelPresentationWindow | null; getLayout: () => PanelPresentationLayout | null; getPanelCatalog: () => { entry: (id: string) => PanelPresentationEntry | null } | null; emit?: (route: string, payload: unknown) => void; events?: { panelTransferred?: string }; logger?: { warn: (...args: unknown[]) => void } }
interface PanelTransferResult { ok: boolean; panelId: string; direction: string; error?: string; windowId?: number }

/**
 * @param {PanelPresentationDeps} deps
 */
function createPanelPresentation(deps: PanelPresentationDeps) {
  const openWindow = deps.openWindow
  const getWindow = deps.getWindow
  const getLayout = deps.getLayout
  const getPanelCatalog = deps.getPanelCatalog
  const emit = typeof deps.emit === 'function' ? deps.emit : null
  const transferredEvent = deps.events && deps.events.panelTransferred
  const logger = deps.logger || console

  /** 面板窗口及其最近一次迁移状态。 */
  const records = new Map<string, { win: PanelPresentationWindow; state: unknown }>()
  /** 停靠后待新宿主领取的状态（一次即焚）。 */
  const pending = new Map<string, unknown>()

  const liveWin = (panelId: string): PanelPresentationWindow | null => {
    const rec = records.get(panelId)
    if (!rec) return null
    const win = rec.win
    if (!win || (typeof win.isDestroyed === 'function' && win.isDestroyed())) {
      records.delete(panelId)
      return null
    }
    return win
  }

  const notify = (panelId: string, direction: string, state: unknown, reason?: string): void => {
    if (!emit || !transferredEvent) return
    try {
      emit(transferredEvent, reason
        ? { panelId, direction, state: state == null ? null : state, reason }
        : { panelId, direction, state: state == null ? null : state })
    } catch (error) {
      logger.warn('[panel-presentation] 广播 panel:transferred 失败:', error instanceof Error ? error.message : error)
    }
  }

  /** 面板此刻是否已被拆成窗口。 */
  function isDetached(panelId: string): boolean {
    return !!liveWin(String(panelId || ''))
  }

  /**
   * 关掉侧栏那一份 —— **只关这一块**。
   *
   * 不能用 `hidePanel(side)`：同侧可能同时开着普通位与钉住位（钉住的面板常驻），
   * 按侧关会把不该动的另一块一起收掉。`closePanel(panelId)` 是"关这一块"的唯一出口。
   */
  function hideDocked(panelId: string): void {
    const layout = getLayout && getLayout()
    if (!layout) return
    if (typeof layout.closePanel === 'function') {
      layout.closePanel(panelId)
      return
    }
    // 旧布局对象（无 closePanel）的回落：按侧关（历史行为）。
    if (typeof layout.getPanelSideOf !== 'function' || typeof layout.hidePanel !== 'function') return
    const side = layout.getPanelSideOf(panelId)
    if (side) layout.hidePanel(side)
  }

  function showDocked(panelId: string): boolean {
    const layout = getLayout && getLayout()
    if (!layout || typeof layout.showPanel !== 'function') return false
    try {
      layout.showPanel(panelId)
      return true
    } catch (error) {
      logger.warn('[panel-presentation] 恢复侧栏面板失败:', error instanceof Error ? error.message : error)
      return false
    }
  }

  /**
   * 拆出窗口（单实例：已在窗口 → 只聚焦 + 更新待迁移状态）。
   * @param {string} panelId
   * @param {unknown} [state]
   */
  function detach(panelId: string, state?: unknown): PanelTransferResult {
    const id = String(panelId || '')
    if (!id) return { ok: false, panelId: id, direction: 'detach', error: 'panelId required' }

    const already = liveWin(id)
    if (already) {
      const rec = records.get(id)
      if (rec && state !== undefined) rec.state = state
      try { already.focus() } catch (_) {}
      return { ok: true, panelId: id, direction: 'detach', windowId: already.id }
    }

    const catalog = getPanelCatalog && getPanelCatalog()
    const entry = catalog && typeof catalog.entry === 'function' ? catalog.entry(id) : null
    if (!entry) return { ok: false, panelId: id, direction: 'detach', error: 'unknown panel' }
    if (entry.presentation !== 'both') {
      return { ok: false, panelId: id, direction: 'detach', error: 'panel is dock-only' }
    }

    // 窗口类型是全局单例：先把别的面板优雅停靠回去（而不是让它被静默顶掉）。
    for (const otherId of Array.from(records.keys())) {
      if (otherId !== id) dock(otherId)
    }

    hideDocked(id)

    const payload = {
      panelId: id,
      pluginId: entry.pluginId || '',
      title: entry.title || '',
      state: state === undefined ? null : state
    }
    let res: { ok?: boolean; error?: string }
    try {
      res = openWindow(WINDOW_TYPE, payload)
    } catch (error) {
      showDocked(id)
      return {
        ok: false,
        panelId: id,
        direction: 'detach',
        error: error instanceof Error ? error.message : 'open window failed'
      }
    }
    if (res && res.ok === false) {
      showDocked(id)
      return { ok: false, panelId: id, direction: 'detach', error: res.error || 'open window failed' }
    }
    let win: PanelPresentationWindow | null = null
    try {
      win = getWindow(WINDOW_TYPE)
    } catch (error) {
      logger.warn('[panel-presentation] 读取独立窗口失败:', error instanceof Error ? error.message : error)
    }
    if (!win) {
      showDocked(id)
      return { ok: false, panelId: id, direction: 'detach', error: 'window not found after open' }
    }

    const rec = { win, state: payload.state }
    records.set(id, rec)
    // 用户直接关窗 = 面板就此关闭（不回弹侧栏）—— 只回收记录并广播，让别处（rail 高亮）跟上。
    try {
      win.once('closed', () => {
        if (records.get(id) !== rec) return
        records.delete(id)
        notify(id, 'dock', null, 'window-closed')
      })
    } catch (error) {
      logger.warn('[panel-presentation] 挂 closed 监听失败:', error instanceof Error ? error.message : error)
    }
    notify(id, 'detach', null, 'open-window')
    return { ok: true, panelId: id, direction: 'detach', windowId: win.id }
  }

  /**
   * 停靠回侧栏（无窗口时只保证侧栏可见 —— 幂等）。
   * @param {string} panelId
   * @param {unknown} [state]
   */
  function dock(panelId: string, state?: unknown): PanelTransferResult {
    const id = String(panelId || '')
    if (!id) return { ok: false, panelId: id, direction: 'dock', error: 'panelId required' }

    const rec = records.get(id)
    const carried = state === undefined ? (rec ? rec.state : null) : state
    if (rec) {
      records.delete(id)
      try {
        if (rec.win && typeof rec.win.isDestroyed === 'function' && !rec.win.isDestroyed()) rec.win.destroy()
      } catch (error) {
        logger.warn('[panel-presentation] 关闭独立窗口失败:', error instanceof Error ? error.message : error)
      }
    }
    pending.set(id, carried)

    showDocked(id)
    notify(id, 'dock', carried, 'dock-back')
    return { ok: true, panelId: id, direction: 'dock' }
  }

  /**
   * 取走「迁移到本宿主」的状态（一次即焚）。
   * 面板宿主在挂载后调用 —— 新造的渲染进程收不到迁移那一刻的广播。
   */
  function takeState(panelId: string): unknown | null {
    const id = String(panelId || '')
    if (!pending.has(id)) return null
    const value = pending.get(id)
    pending.delete(id)
    return value == null ? null : value
  }

  /** 面板目录里还认不认得它 / 能不能拆（宿主决定要不要画切换按钮）。 */
  function canDetach(panelId: string): boolean {
    const catalog = getPanelCatalog && getPanelCatalog()
    const entry = catalog && typeof catalog.entry === 'function' ? catalog.entry(String(panelId || '')) : null
    return !!entry && entry.presentation === 'both'
  }

  /** 退出前清干净：窗口随进程结束，这里只释放引用（不留监听/定时器）。 */
  function dispose() {
    records.clear()
    pending.clear()
  }

  return { detach, dock, isDetached, canDetach, takeState, dispose }
}

module.exports = { createPanelPresentation, WINDOW_TYPE }
