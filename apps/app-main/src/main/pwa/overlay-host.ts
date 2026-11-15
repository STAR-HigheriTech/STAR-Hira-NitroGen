// @ts-check
/**
 * PWA 应用窗 · 浮层宿主（查找栏 / 缩放指示器）
 *
 * ── 为什么不能复用主窗口那套 ────────────────────────────────────────────
 * `main/ipc/layout.js` 的浮层通道是**全局 ipcMain** + 主窗口 layoutCoordinator
 * 单例专用的：PWA 应用窗不在 runtimeRegistry 里，复用同名通道会和主窗口抢同一份
 * 控制器（表现为"A 窗口的 Ctrl+F 开到了主窗口"）。
 *
 * 这里给单个应用窗一份**极简等价物**：只提供 find-bar / zoom-controller 真正用到的
 * 六个端口（getFloatWebContents / sendToFloat / noteFloatShow / focusFloat /
 * isFloatVisible / hideFloat），加上 display 落位与销毁。
 *
 * ── 与 LayoutCoordinator 对齐的三条铁律 ─────────────────────────────────
 *   ① 浮层视图**常驻 visible**，显隐只靠 bounds（0×0 隐藏）——
 *      切 setVisible(false) 会让 Electron 原生抢走焦点（主窗口那边踩过）。
 *   ② 落位一律相对**网页矩形**（标题栏以下），不是整个内容区。
 *   ③ 首次显示要等 renderer 就绪（did-finish-load）再下发事件，
 *      否则首帧打在空白页上 → 查找栏永远不上报 display → 看起来"按了没反应"。
 */

import { WebContentsView, type BrowserWindow, type Rectangle, type Session, type WebContents } from 'electron'

const { buildWebPreferences } = require('@hira-ng/infra-window') as {
  buildWebPreferences(options: { session?: Session }): Electron.WebPreferences
}
const { resolveWindowUrl } = require('../window-config') as { resolveWindowUrl(name: string): string }

interface OverlayDisplay {
  width?: unknown
  height?: unknown
  margin?: unknown
  align?: unknown
  valign?: unknown
  [key: string]: unknown
}

export interface PwaOverlayHostOptions {
  win: BrowserWindow
  appId: string
  getChromeHeight(): number
  session?: Session
}

/** 约定的浮层名（= renderer 目录名，两处必须逐字一致）。 */
export const OVERLAY_NAMES: readonly string[] = Object.freeze(['findbar-overlay', 'zoom-overlay'])

const HIDDEN_BOUNDS = Object.freeze({ x: 0, y: 0, width: 0, height: 0 })

/**
 * 浮层闲置回收时长 —— 与主窗口 `LayoutCoordinator` 的 `FLOAT_IDLE_RECLAIM_MS`
 * **同一个数**（那边是唯一真源，这里只是应用窗宿主的一份等价实现）。
 *
 * 一个浮层 = 一个独立 renderer（实测独占 ~22 MB）。应用窗可以开一整天，
 * 查找栏 / 缩放条各被用过一次之后就再也不显示，进程却常驻 —— 纯浪费。
 */
const FLOAT_IDLE_RECLAIM_MS = 2 * 60 * 1000

/** 浮层页 URL：带上 scope，渲染层据此选 PWA 专用 IPC 路由。 */
function overlayUrl(name: string, appId: string): string {
  const base = resolveWindowUrl(name)
  const params = new URLSearchParams()
  params.set('scope', 'pwa')
  params.set('appId', appId)
  return `${base}?${params.toString()}`
}

/**
 * @param {object} input
 * @param {Electron.BrowserWindow} input.win
 * @param {string} input.appId
 * @param {() => number} input.getChromeHeight 标题栏高度（网页区域上边界）
 * @param {Electron.Session} [input.session]
 */
export function createPwaOverlayHost({ win, appId, getChromeHeight, session }: PwaOverlayHostOptions) {
  /** @type {Map<string, Electron.WebContentsView>} */
  const views: Map<string, Electron.WebContentsView> = new Map<string, WebContentsView>()
  const loaded = new Set<string>()
  /** name → 待下发队列（视图尚未 did-finish-load 时攒着） */
  const pending = new Map<string, Array<() => void>>()
  /** 逻辑可见的浮层（noteFloatShow 登记，hideFloat 撤销） */
  const shown = new Set<string>()
  /** name → 最近一次 display 指标（窗口 resize / chrome 高度变化时重新落位） */
  const displays = new Map<string, OverlayDisplay>()
  /** name → 闲置回收定时器（收起时排、显示时撤；不需要时是 null，见 scheduleReclaim） */
  const reclaimTimers = new Map<string, NodeJS.Timeout>()
  let disposed = false

  /** 网页矩形（内容区坐标，标题栏以下）。 */
  function pageRect(): Rectangle {
    let width = 0
    let height = 0
    try {
      ;[width, height] = win.getContentSize()
    } catch (_) {
      return { x: 0, y: 0, width: 0, height: 0 }
    }
    const top = Math.max(0, Math.round(Number(getChromeHeight()) || 0))
    return { x: 0, y: top, width, height: Math.max(0, height - top) }
  }

  function applyBounds(name: string): void {
    const view = views.get(name)
    if (!view || disposed) return
    const rect = pageRect()
    const display = displays.get(name)
    if (!shown.has(name) || !display) {
      try { view.setBounds(HIDDEN_BOUNDS) } catch (_) {}
      return
    }
    const width = Math.max(0, Math.round(Number(display.width) || 0))
    const height = Math.max(0, Math.round(Number(display.height) || 0))
    if (width <= 0 || height <= 0) {
      try { view.setBounds(HIDDEN_BOUNDS) } catch (_) {}
      return
    }
    const margin = Number.isFinite(Number(display.margin)) ? Number(display.margin) : 10
    let x = rect.x + margin
    if (display.align === 'right') x = rect.x + rect.width - width - margin
    else if (display.align === 'center') x = rect.x + Math.round((rect.width - width) / 2)
    let y = rect.y + margin
    if (display.valign === 'bottom') y = rect.y + rect.height - height - margin
    // clamp 回网页矩形（窗口太小时宁可贴边，也不能落到标题栏 / 窗口外）
    x = Math.max(rect.x, Math.min(x, rect.x + Math.max(0, rect.width - width)))
    y = Math.max(rect.y, Math.min(y, rect.y + Math.max(0, rect.height - height)))
    try { view.setBounds({ x, y, width, height }) } catch (_) {}
  }

  /** 惰性建视图并加载浮层页（同步把视图对象放进表里，首帧不会丢）。 */
  function ensure(name: string): WebContentsView | null {
    const existing = views.get(name)
    if (existing) return existing
    if (disposed) return null
    const view = new WebContentsView({
      webPreferences: buildWebPreferences(session ? { session } : {})
    })
    view.setBackgroundColor('#00000000')
    try { view.setBounds(HIDDEN_BOUNDS) } catch (_) {}
    try { win.contentView.addChildView(view) } catch (_) {}
    views.set(name, view)

    const wc = view.webContents
    wc.on('did-finish-load', () => {
      loaded.add(name)
      const queue = pending.get(name)
      pending.delete(name)
      if (queue) for (const send of queue) send()
    })
    wc.on('did-fail-load', (_e, code, desc, url) => {
      console.warn(`[pwa] 浮层 ${name} 加载失败:`, code, desc, url)
    })
    wc.loadURL(overlayUrl(name, appId)).catch((err) => {
      console.warn(`[pwa] 浮层 ${name} 加载异常:`, err && err.message)
    })
    return view
  }

  function getFloatWebContents(name: string): WebContents | null {
    const view = views.get(name)
    if (!view) return null
    try {
      const wc = view.webContents
      return wc && !wc.isDestroyed() ? wc : null
    } catch (_) {
      return null
    }
  }

  /**
   * 向下发一条事件。视图没建就惰性建；renderer 未就绪就排队到 did-finish-load。
   * @returns {Promise<boolean>}
   */
  function sendToFloat(name: string, channel: string, payload: unknown): Promise<boolean> {
    return new Promise((resolve) => {
      const view = ensure(name)
      const wc = view ? getFloatWebContents(name) : null
      if (!wc) {
        resolve(false)
        return
      }
      const sendNow = () => {
        if (disposed) {
          resolve(false)
          return
        }
        const target = getFloatWebContents(name)
        if (!target) {
          resolve(false)
          return
        }
        try {
          target.send(channel, payload)
          resolve(true)
        } catch (_) {
          resolve(false)
        }
      }
      if (loaded.has(name)) sendNow()
      else {
        const queue = pending.get(name) || []
        queue.push(sendNow)
        pending.set(name, queue)
      }
    })
  }

  /**
   * 排一次闲置回收（**幂等**：已排则不动；没有视图就没进程可回收，直接不排）。
   * @param {string} name
   */
  function scheduleReclaim(name: string): void {
    if (reclaimTimers.has(name)) return
    if (!views.has(name)) return
    const timer = setTimeout(() => {
      reclaimTimers.delete(name)
      reclaim(name)
    }, FLOAT_IDLE_RECLAIM_MS)
    // unref：这个定时器不该成为"进程退不掉"的最后一个抓手。
    if (typeof timer.unref === 'function') timer.unref()
    reclaimTimers.set(name, timer)
  }

  /** 撤销闲置回收（**幂等**）。 */
  function cancelReclaim(name: string): void {
    const timer = reclaimTimers.get(name)
    if (!timer) return
    clearTimeout(timer)
    reclaimTimers.delete(name)
  }

  /**
   * 销毁一个**确实没在用**的浮层渲染进程（视图 + webContents）。
   *
   * 闸门（任何一条成立都说明它正在被用）：
   *   · 逻辑可见 —— 用户正看着 / 正在显示途中；
   *   · 还有排队中的下发 —— renderer 还没就绪，重建会把那条事件丢掉；
   *   · 视图已不在 —— 幂等早退。
   *
   * 清理由本方法独占：它把本层为这个浮层登记的每一项都清掉（回到"从未创建"），
   * 下次显示由 `ensure` 重建 —— 那边本来就是「表里没有就建」，无需任何恢复逻辑。
   * @param {string} name
   * @returns {boolean} 是否真的回收了
   */
  function reclaim(name: string): boolean {
    if (disposed) return false
    const view = views.get(name)
    if (!view) return false
    if (shown.has(name)) return false
    if (pending.has(name)) return false
    cancelReclaim(name)
    views.delete(name)
    loaded.delete(name)
    displays.delete(name)
    try {
      if (win && !win.isDestroyed()) win.contentView.removeChildView(view)
    } catch (_) {}
    try {
      if (view.webContents && !view.webContents.isDestroyed()) view.webContents.close()
    } catch (_) {}
    return true
  }

  function noteFloatShow(name: string): void {
    cancelReclaim(name)
    shown.add(name)
    applyBounds(name)
  }

  function focusFloat(name: string): void {
    const wc = getFloatWebContents(name)
    if (!wc) return
    try { wc.focus() } catch (_) {}
  }

  function isFloatVisible(name: string): boolean {
    return shown.has(name)
  }

  function hideFloat(name: string): void {
    shown.delete(name)
    applyBounds(name)
    // 收起之后才排回收：没有视图就不排（`scheduleReclaim` 内部早退）。
    scheduleReclaim(name)
  }

  /** 浮层 renderer 上报的布局（display 通道）。 */
  function applyDisplay(name: string, display: OverlayDisplay | null | undefined): void {
    if (!display || typeof display !== 'object') return
    displays.set(name, { ...display })
    // display 到达即视为可见（与主窗口 layout.js 的可见性闸门同源：
    // renderer 只在自己已经收到 show 之后才会上报）。
    cancelReclaim(name)
    shown.add(name)
    applyBounds(name)
  }

  /** 窗口尺寸 / chrome 高度变化：所有已显示浮层重新落位。 */
  function relayout(): void {
    for (const name of shown) applyBounds(name)
  }

  function destroy(): void {
    if (disposed) return
    disposed = true
    // 先把排队中的下发全部取出再清表：`sendNow` 在 disposed 之后会 resolve(false)，
    // 直接 pending.clear() 会让那些 Promise 永远悬挂（调用方 await 泄漏）。
    const queued: Array<() => void> = []
    for (const queue of pending.values()) queued.push(...queue)
    pending.clear()
    for (const send of queued) {
      try { send() } catch (_) {}
    }
    shown.clear()
    displays.clear()
    loaded.clear()
    for (const timer of reclaimTimers.values()) clearTimeout(timer)
    reclaimTimers.clear()
    for (const [name, view] of views) {
      views.delete(name)
      try {
        if (win && !win.isDestroyed()) win.contentView.removeChildView(view)
      } catch (_) {}
      try {
        if (view.webContents && !view.webContents.isDestroyed()) view.webContents.close()
      } catch (_) {}
    }
  }

  return {
    OVERLAY_NAMES,
    getFloatWebContents,
    sendToFloat,
    noteFloatShow,
    focusFloat,
    isFloatVisible,
    hideFloat,
    applyDisplay,
    relayout,
    destroy,
    /** 网页矩形（诊断 / 调试用）。 */
    getPageRect: pageRect
  }
}

