/**
 * IPC · 按钮编辑模式（navbar / rail 的面板按钮排序与显隐）
 *
 * ── 这个域负责什么 ────────────────────────────────────────────────
 *   1. **开关**：把编辑浮层（`buttons-edit-overlay`，铺满整窗的独立图层）显示 / 收起，
 *      并把「现在在编辑」这一事实窗口级地告诉外壳 / rail / 浮层；
 *   2. **几何中转**：外壳与 rail 各自把自己那排按钮的几何（**自身视图坐标**）报上来，
 *      这里按发送方视图补上窗口偏移后转发给浮层 —— 浮层据此把按钮画在同一位置。
 *      为什么必须由主进程换算：外壳是窗口本体（偏移 0），rail 是独立 WebContentsView
 *      （偏移 = 它的 bounds），两者坐标系不同，只有主进程两份都拿得到。
 *
 * ── 为什么拖拽全在浮层内部 ─────────────────────────────────────────
 * 跨 WebContentsView 的 HTML5 拖放落点不可靠（顶层浮层会吃掉 drop 命中），
 * 因此编辑模式下浮层铺满整窗、接管全部指针事件：外壳 / rail 把自己的按钮「隐身」，
 * 由浮层按上报几何**克隆**出同一排按钮来拖 —— 视觉连续，且拖拽只在一个渲染进程内。
 *
 * ── 存储 ────────────────────────────────────────────────────────
 * 顺序与显隐就是两条普通设置（`app.navbar_buttons` / `app.rail_buttons`，可见顺序数组），
 * 浮层直接走既有 settings:set 落库，主进程不额外持有状态 —— 消除第二份真相。
 */

import type { BrowserWindow, WebContents } from 'electron'
import { onWebContentsDestroyed } from '@hira-ng/infra-window'
import { errorMessage } from './types'
import type { IpcRoutes, IpcSchemas, IpcTypedMain, IpcRawMain } from './types'

type MethodPort = Record<string, (...args: unknown[]) => unknown>
interface EditRect { x: number; y: number; width: number; height: number }
interface EditSegment { key?: string; rect: EditRect; items: unknown[]; grow?: string; axis?: string }
function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' ? value as Record<string, unknown> : {}
}
interface ButtonsEditIpcContext {
  routes: IpcRoutes
  schemas: IpcSchemas['buttonsEdit']
  events: Record<string, string>
  layoutCoordinator: MethodPort
  emit?: (route: string, payload: unknown, options?: { windowId?: number }) => unknown
  emitToWindow?: (route: string, payload: unknown) => unknown
}

/** 编辑浮层图层名（同时是渲染器目录名：out/renderer/buttons-edit-overlay/）。 */
const OVERLAY = 'buttons-edit-overlay'
export { OVERLAY as BUTTONS_EDIT_OVERLAY }

/**
 * @param {object} typedMain 带 schema 校验的 invoke 注册器（已按发送方解析窗口）
 * @param {object} senderScopedIpcMain 裸通道注册器（同样按发送方解析窗口）
 * @param {{ routes:object, schemas:object, events:object, layoutCoordinator:object, emit:Function, emitToWindow:Function }} deps
 */
export function registerButtonsEditIpc(
  typedMain: IpcTypedMain,
  senderScopedIpcMain: IpcRawMain | null | undefined,
  { routes, schemas, events, layoutCoordinator, emit, emitToWindow }: ButtonsEditIpcContext
): void {
  /** 面板是多个独立 WebContentsView；按发送方合并成一份 panels 投放层。 */
  const panelZoneReports = new Map<number, EditSegment[]>()
  const trackedReportSenders = new Set<number>()
  const reportKeysBySender = new Map<number, Set<string>>()
  /** 同一视图重复上报的同一几何不再穿过 IPC；真正变化时仍立即发送。 */
  const zoneReportSignatures = new Map<string, string>()
  const sendCh = (route: string): string => `ngipc:send:${route}`
  const evtCh = (route: string): string => `ngipc:event:${route}`
  const activeEvent = (events && events.buttonsEditActive) || 'buttons-edit:active'
  const remeasureEvent = (events && events.buttonsEditRemeasure) || 'buttons-edit:remeasure'
  const zoneEvent = (events && events.buttonsEditZone) || 'buttons-edit:zone'
  const zoneSend = (routes && routes.buttonsEditZone) || 'buttons-edit:zone'
  let remeasureTimer: NodeJS.Timeout | null = null
  let resizeWindow: BrowserWindow | null = null
  let resizeBoundsTimer: NodeJS.Timeout | null = null
  let resizeRemeasureTimer: NodeJS.Timeout | null = null
  let activationRequest = 0
  let desiredActive = false
  let activationPending = false
  let activationTask: Promise<{ active: boolean }> = Promise.resolve({ active: false })

  /** 编辑中 = 编辑浮层此刻逻辑可见（唯一真相源就是浮层自己，不另存一份状态）。 */
  function isActive() {
    return Boolean(
      layoutCoordinator &&
      typeof layoutCoordinator.isFloatVisible === 'function' &&
      layoutCoordinator.isFloatVisible(OVERLAY)
    )
  }

  function mergedPanelSegments() {
    const merged = new Map<string, EditSegment>()
    for (const report of panelZoneReports.values()) {
      for (const segment of report) {
        const key = segment.key || 'panel'
        const current = merged.get(key) || {
          key,
          rect: { x: 0, y: 0, width: 0, height: 0 },
          items: [],
          grow: segment.grow || 'down',
          axis: segment.axis || 'column'
        }
        current.items.push(...(segment.items || []))
        const left = Math.min(
          current.rect.width > 0 ? current.rect.x : segment.rect.x,
          segment.rect.x
        )
        const top = Math.min(
          current.rect.height > 0 ? current.rect.y : segment.rect.y,
          segment.rect.y
        )
        const right = Math.max(
          current.rect.width > 0 ? current.rect.x + current.rect.width : segment.rect.x + segment.rect.width,
          segment.rect.x + segment.rect.width
        )
        const bottom = Math.max(
          current.rect.height > 0 ? current.rect.y + current.rect.height : segment.rect.y + segment.rect.height,
          segment.rect.y + segment.rect.height
        )
        current.rect = { x: left, y: top, width: right - left, height: bottom - top }
        merged.set(key, current)
      }
    }
    return Array.from(merged.values())
  }

  function sendMergedPanelZones() {
    if (!isActive() || typeof layoutCoordinator.sendToFloat !== 'function') return
    const segments = mergedPanelSegments()
    const signature = JSON.stringify(segments)
    if (zoneReportSignatures.get('panels:merged') === signature) return
    zoneReportSignatures.set('panels:merged', signature)
    Promise.resolve(layoutCoordinator.sendToFloat(OVERLAY, evtCh(zoneEvent), {
      surface: 'panels',
      segments
    })).catch(() => {})
  }

  function cleanupReportSender(senderId: number): void {
    trackedReportSenders.delete(senderId)
    const reportKeys = reportKeysBySender.get(senderId)
    reportKeysBySender.delete(senderId)
    if (reportKeys) {
      for (const key of reportKeys) zoneReportSignatures.delete(key)
    }
    if (panelZoneReports.delete(senderId)) sendMergedPanelZones()
  }

  function trackReportSender(sender: WebContents | null | undefined): void {
    const senderId = sender?.id
    if (!senderId || trackedReportSenders.has(senderId)) return
    trackedReportSenders.add(senderId)
    try {
      onWebContentsDestroyed(sender, () => cleanupReportSender(senderId))
    } catch (_) {
      trackedReportSenders.delete(senderId)
    }
  }

  function targetWindow(): BrowserWindow | null {
    if (!layoutCoordinator || typeof layoutCoordinator.getWindow !== 'function') return null
    try {
      const win = layoutCoordinator.getWindow() as BrowserWindow | null
      return win && !win.isDestroyed() ? win : null
    } catch (_) {
      return null
    }
  }

  function syncOverlayBounds() {
    const win = resizeWindow
    if (!win || win.isDestroyed() || !isActive()) return
    const [width, height] = typeof win.getContentSize === 'function' ? win.getContentSize() : [0, 0]
    if (!width || !height) return
    layoutCoordinator.setFloatBounds(OVERLAY, {
      x: 0,
      y: 0,
      width: Math.round(width),
      height: Math.round(height)
    })
  }

  function onOverlayWindowResize() {
    if (!isActive()) return
    if (!resizeBoundsTimer) {
      resizeBoundsTimer = setTimeout(() => {
        resizeBoundsTimer = null
        syncOverlayBounds()
      }, 16)
    }
    if (resizeRemeasureTimer) clearTimeout(resizeRemeasureTimer)
    resizeRemeasureTimer = setTimeout(() => {
      resizeRemeasureTimer = null
      if (isActive()) emitWindowEvent(remeasureEvent, {})
    }, 90)
  }

  function bindResizeWindow(win: BrowserWindow | null): void {
    if (!win || resizeWindow === win) return
    unbindResizeWindow()
    resizeWindow = win
    resizeWindow.on('resize', onOverlayWindowResize)
  }

  function unbindResizeWindow() {
    if (resizeBoundsTimer) {
      clearTimeout(resizeBoundsTimer)
      resizeBoundsTimer = null
    }
    if (resizeRemeasureTimer) {
      clearTimeout(resizeRemeasureTimer)
      resizeRemeasureTimer = null
    }
    if (resizeWindow && !resizeWindow.isDestroyed()) {
      try { resizeWindow.removeListener('resize', onOverlayWindowResize) } catch (_) {}
    }
    resizeWindow = null
  }

  /**
   * 向**本窗口**广播一条编辑相关的事件。
   *
   * ⚠ 窗口必须显式取自 layoutCoordinator，**不能**依赖「按发送方解析」：
   * 退出编辑是编辑浮层发起的，而浮层视图在按发送方解析的注册表里未必有归属 ——
   * 解析失败时窗口级事件会被整个丢掉，外壳 / rail 收不到「退出编辑」，
   * 已被隐身的按钮就再也不出来了（用户看到的就是「退出编辑后按钮有概率消失」）。
   */
  function emitWindowEvent(route: string, payload: unknown): void {
    const win = targetWindow()
    try {
      if (win && typeof emit === 'function') {
        emit(route, payload, { windowId: win.id })
        return
      }
      if (typeof emitToWindow === 'function') emitToWindow(route, payload)
    } catch (_) {}
  }

  function emitActive(active: unknown): void {
    emitWindowEvent(activeEvent, { active: Boolean(active) })
  }

  /**
   * 编辑浮层是全窗模态：不能只等几何交集的自动守卫推导。无顶栏（全侧栏布局）
   * 时拖拽带可能为空，自动推导不会把下层 app-region 关掉，位于 y=0 的整栏 clone
   * 就会收不到 pointerdown。进入 / 退出时显式广播一次，保证顶栏整栏也能拖动。
   */
  function emitDragGuard(open: unknown): void {
    emitWindowEvent('overlay:modal', { open: Boolean(open) })
  }

  function setEditingPresentation(on: unknown): void {
    if (!layoutCoordinator) return
    try {
      if (typeof layoutCoordinator.setEditingPresentation === 'function') {
        layoutCoordinator.setEditingPresentation(on === true)
      } else if (typeof layoutCoordinator.setSideRevealSuspended === 'function') {
        layoutCoordinator.setSideRevealSuspended(on === true)
      }
    } catch (_) {}
  }

  /**
   * 进入 / 退出编辑模式。
   * @param {boolean} active
   * @returns {Promise<{active: boolean}>}
   */
  function setActive(active: unknown): Promise<{ active: boolean }> {
    const next = Boolean(active)
    if (activationPending && desiredActive === next) return activationTask
    desiredActive = next
    const request = ++activationRequest
    activationPending = true
    const task = activationTask
      .catch(() => {})
      .then(() => transitionActive(next, request))
    activationTask = task
    const settle = () => {
      if (activationTask === task) activationPending = false
    }
    void task.then(settle, settle)
    return task
  }

  async function transitionActive(next: boolean, request: number): Promise<{ active: boolean }> {
    if (!layoutCoordinator) return { active: false }
    // 快速连点 / 打开后立刻关闭：过期请求在真正显示浮层前退出。
    if (request !== activationRequest || desiredActive !== next) {
      return { active: isActive() }
    }
    if (next === isActive()) {
      // 幂等：状态没变也重申一次 —— 外壳刚 reload / 浮层刚起来时会丢掉上一次通知，
      // 「再点一次编辑」必须仍然能进入（而不是因为主进程以为已经开着而毫无反应）。
      if (next) {
        setEditingPresentation(true)
        const win = targetWindow()
        bindResizeWindow(win)
        syncOverlayBounds()
        // 浮层刷新 / renderer 重载后几何缓存已失效，必须允许同一份几何重新穿透。
        panelZoneReports.clear()
        zoneReportSignatures.clear()
        layoutCoordinator.setFloatInteractive(OVERLAY, true)
      }
      emitActive(next)
      return { active: next }
    }
    if (!next) {
      unbindResizeWindow()
      panelZoneReports.clear()
      zoneReportSignatures.clear()
      if (remeasureTimer) {
        clearTimeout(remeasureTimer)
        remeasureTimer = null
      }
      layoutCoordinator.hideFloat(OVERLAY)
      setEditingPresentation(false)
      emitDragGuard(false)
      emitActive(false)
      return { active: false }
    }

    const win = (typeof layoutCoordinator.getWindow === 'function' ? layoutCoordinator.getWindow() : null) as BrowserWindow | null
    const [cw, ch] = win && typeof win.getContentSize === 'function' ? win.getContentSize() : [0, 0]
    if (!cw || !ch) return { active: false }
    panelZoneReports.clear()
    zoneReportSignatures.clear()
    setEditingPresentation(true)

    layoutCoordinator.noteFloatShow(OVERLAY)
    // sendToFloat 内部惰性建视图 + 等 renderer 就绪；建好之后才谈得上 setBounds。
    try {
      await layoutCoordinator.sendToFloat(OVERLAY, evtCh(activeEvent), {
        active: true,
        viewport: { width: Math.round(cw), height: Math.round(ch) }
      })
    } catch (error) {
      if (request === activationRequest) desiredActive = false
      layoutCoordinator.hideFloat(OVERLAY)
      setEditingPresentation(false)
      emitDragGuard(false)
      emitActive(false)
      console.warn('[buttons-edit] show overlay failed:', errorMessage(error))
      return { active: false }
    }
    if (request !== activationRequest || desiredActive !== next) {
      return { active: isActive() }
    }
    // 铺满整窗 + 吃住指针：编辑期间所有拖拽都在浮层内部完成（见文件头说明）。
    layoutCoordinator.setFloatBounds(OVERLAY, { x: 0, y: 0, width: Math.round(cw), height: Math.round(ch) })
    layoutCoordinator.setFloatInteractive(OVERLAY, true)
    bindResizeWindow(win)
    emitDragGuard(true)
    if (typeof layoutCoordinator.focusFloat === 'function') layoutCoordinator.focusFloat(OVERLAY)
    emitActive(true)
    return { active: true }
  }

  typedMain.handle(routes.buttonsEditSetActive, {
    requestSchema: schemas.setActive.request,
    responseSchema: schemas.setActive.response,
    handler: async (_e, req) => setActive(req && req.active)
  })

  typedMain.handle(routes.buttonsEditIsActive, {
    requestSchema: schemas.isActive.request,
    responseSchema: schemas.isActive.response,
    handler: async () => ({ active: isActive() })
  })

  // 「请重新量一次几何」：编辑浮层每次落点落库后调一次。
  // 只做一件事 —— 转成本窗口的窗口级事件，外壳与 rail 各自重报自己那排按钮的几何。
  // 编辑中才转：不在编辑模式时外壳/rail 也没有「让位」的必要，白量一次纯浪费。
  typedMain.handle(routes.buttonsEditRemeasure, {
    requestSchema: schemas.remeasure.request,
    responseSchema: schemas.remeasure.response,
    handler: async () => {
      if (!isActive()) return { ok: false }
      // 一次落位会触发外壳与 rail 多处几何变化；合并到下一小拍，
      // 让 pointerup、DOM 落位和设置广播先完成，再统一重测一次。
      if (!remeasureTimer) {
        remeasureTimer = setTimeout(() => {
          remeasureTimer = null
          if (isActive()) emitWindowEvent(remeasureEvent, {})
        }, 12)
      }
      return { ok: true }
    }
  })

  // ── 几何上报（外壳 / rail → 主进程 → 编辑浮层）────────────────────────
  senderScopedIpcMain?.on(sendCh(zoneSend), (e, rawReq) => {
    const req = asRecord(rawReq)
    if (!layoutCoordinator || !req || typeof req !== 'object') return
    if (!isActive()) return
    const sender = e && typeof e === 'object' && 'sender' in e ? (e as { sender: WebContents }).sender : null
    const offset = asRecord(typeof layoutCoordinator.getViewContentOffset === 'function'
      ? layoutCoordinator.getViewContentOffset(sender)
      : null)
    const dx = Number.isFinite(Number(offset.x)) ? Number(offset.x) : 0
    const dy = Number.isFinite(Number(offset.y)) ? Number(offset.y) : 0
    const shift = (value: unknown): EditRect => {
      const r = asRecord(value)
      if (!r) return { x: 0, y: 0, width: 0, height: 0 }
      return {
        x: Math.round((Number(r.x) || 0) + dx),
        y: Math.round((Number(r.y) || 0) + dy),
        width: Math.round(Number(r.width) || 0),
        height: Math.round(Number(r.height) || 0)
      }
    }
    const shiftItems = (list: unknown): unknown[] => (Array.isArray(list)
      ? list.map((it) => ({ id: String(asRecord(it).id || ''), ...shift(it) }))
      : [])
    // 统一成「段」列表：navbar 的按钮散在三个容器里（左导航 / 地址栏内 / 右面板区），
    // rail 只有一段。渲染层按段投放（跨段拖动无物理意义）。
    const segments = Array.isArray(req.segments)
      ? (req.segments as unknown[]).map((value) => {
          const seg = asRecord(value)
          return {
          key: String((seg && seg.key) || ''),
          rect: shift(seg && seg.rect),
          items: shiftItems(seg && seg.items),
          // 生长方向（'right' | 'left' | 'down' | 'up'）：段内新增按钮往哪边扩。
          // 浮层据此把克隆按钮靠在投放区的哪一侧 —— 与真按钮落点严格一致，
          // 否则「虚线框里按钮画在右边、真按钮却在左边」，框就不再可信。
          grow: seg && typeof seg.grow === 'string' ? seg.grow : '',
          // 该段的主轴（rail 既可能是纵向列，也可能是顶 / 底横条）。
          // 浮层按它决定"沿 x 还是沿 y 排按钮"，不自己猜 surface 的形状。
          axis: seg.axis === 'row' ? 'row' : 'column'
          }
        })
      : [{ key: 'default', rect: shift(req.rect), items: shiftItems(req.items), grow: '', axis: req.surface === 'rail' ? 'column' : 'row' }]
    const surface = typeof req.surface === 'string' ? req.surface : ''
    const allowedSurfaces = new Set(['navbar', 'rail', 'rail-pins', 'chrome', 'panels', 'web-sidebar'])
    if (!allowedSurfaces.has(surface)) return
    if (typeof layoutCoordinator.sendToFloat === 'function') {
      if (surface === 'panels') {
        if (!sender) return
        trackReportSender(sender)
        panelZoneReports.set(sender.id, segments)
        sendMergedPanelZones()
        return
      }
      if (!sender) return
      trackReportSender(sender)
      const reportKey = `${sender.id}:${surface}`
      const reportSignature = JSON.stringify(segments)
      if (zoneReportSignatures.get(reportKey) === reportSignature) return
      let reportKeys = reportKeysBySender.get(sender.id)
      if (!reportKeys) {
        reportKeys = new Set<string>()
        reportKeysBySender.set(sender.id, reportKeys)
      }
      reportKeys.add(reportKey)
      zoneReportSignatures.set(reportKey, reportSignature)
      Promise.resolve(layoutCoordinator.sendToFloat(OVERLAY, evtCh(zoneEvent), {
        surface,
        segments
      })).catch(() => {})
    }
  })

}

