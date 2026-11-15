/**
 * break-overlay —— 专注模式（D5）的**整窗浮层**控制器（主进程侧）。
 *
 * ── 为什么必须是原生浮层，而不是页面里的遮罩 ─────────────────────────
 * 网页跑在 `WebContentsView` 里，**盖在**窗口本体（外壳 DOM）之上。因此无论外壳
 * 的 DOM 怎么画，都只能画在网页**下面** —— 页面内遮罩（旧实现）永远只能盖住网页区，
 * 导航栏 / 标签条 / 侧栏照样能点，专注也就名不副实。
 * 唯一能盖住"整窗所有视图"的东西，是 `contentView` 里 z 序最高的浮层视图。
 *
 * ── 与其它浮层的分工 ───────────────────────────────────────────────
 * 这一族浮层的显隐**不由外壳驱动**（所以它不在 ipc/layout.js 的 FLOAT_NAMES 里）：
 * 显隐的唯一来源是番茄钟状态机（main/break-mode.js）每秒推来的那一帧。
 * 本文件只做三件事：把视图立起来并铺满整窗、把帧转给渲染页、窗口尺寸变了重新铺。
 *
 * ── 性能纪律 ───────────────────────────────────────────────────────
 * 每秒一帧走 `getFloatWebContents()` + `wc.send`（同步、零 Promise）；
 * **不能**走 `sendToFloat` —— 它会 `await loadFloatView`，每秒多一次 microtask 链，
 * 而且冷启动路径只在 show 时需要等一次。
 */

import type { BrowserWindow, WebContents } from 'electron'

const { IPC_EVENTS } = require('@hira-ng/shared-types/src/ipc-channels.mjs') as {
  IPC_EVENTS: { breakOverlayShow: string; breakOverlayHide: string; breakOverlayUpdate: string }
}

interface FloatRect { x: number; y: number; width: number; height: number }
interface WindowContentSize { width: number; height: number }

interface BreakOverlayLayoutPort {
  getFloatWebContents(name: string): WebContents | null | undefined
  getWindowContentSize(): WindowContentSize | null | undefined
  setFloatBounds(name: string, rect: FloatRect): unknown
  focusFloat(name: string): unknown
  attachFloatView(name: string): unknown
  noteFloatShow(name: string): unknown
  setFloatInteractive(name: string, interactive: boolean): unknown
  sendToFloat(name: string, channel: string, payload: unknown): unknown
  isFloatVisible(name: string): boolean
  hideFloat(name: string): unknown
}

export interface BreakOverlayOptions {
  win: BrowserWindow
  layoutCoordinator: BreakOverlayLayoutPort
}

interface BreakFrame {
  phase: 'focus' | 'break'
  remainingMs: number
  totalMs: number
  message: string
  paused: boolean
}

export interface BreakOverlayController {
  show(payload: unknown): void
  hide(): void
  sync(payload: unknown): void
  syncBounds(): void
  dispose(): void
}

/** 浮层逻辑名（= renderer 目录名 = electron.vite.config.js 的 input 键）。 */
export const BREAK_OVERLAY_NAME = 'break-overlay'
const NAME = BREAK_OVERLAY_NAME
/** 退场动画时长：与渲染页 `.leaving` 的 160ms 对齐（留一点余量）。 */
const HIDE_ANIM_MS = 200

/** 主进程 → 浮层 renderer 的事件通道（与 shell-preload 的 `ngipc:event:<route>` 同源）。 */
const channel = (route: string): string => `ngipc:event:${route}`

/**
 * 归一化一帧计时数据。
 *
 * 为什么要收口：`push` 来自状态机、经 APPS 转发；渲染页对形状的信任必须建立在这里，
 * 否则一个 `undefined` 的 totalMs 就能让进度环除零、把 UI 画成 NaN。
 * @param {unknown} payload
 * @returns {{ phase: 'focus'|'break', remainingMs: number, totalMs: number, message: string, paused: boolean }}
 */
function normalize(payload: unknown): BreakFrame {
  const p = payload && typeof payload === 'object' ? payload as Record<string, unknown> : {}
  return {
    phase: p.phase === 'break' ? 'break' : 'focus',
    remainingMs: Math.max(0, Number(p.remainingMs) || 0),
    totalMs: Math.max(0, Number(p.totalMs) || 0),
    message: typeof p.message === 'string' ? p.message : '',
    paused: !!p.paused
  }
}

/**
 * @param {object} deps
 * @param {Electron.BrowserWindow} deps.win 本窗口
 * @param {object} deps.layoutCoordinator 本窗口的布局协调器（浮层几何的唯一出口）
 */
export function createBreakOverlay({ win, layoutCoordinator }: BreakOverlayOptions): BreakOverlayController {
  /** 退场兜底定时器（先播动画，再把浮层收成 0×0）。 */
  let hideTimer: NodeJS.Timeout | null = null
  /** 本窗口是否已销毁（销毁后一切几何操作都必须变成空操作）。 */
  let disposed = false
  /** 浮层当前是否处于"已显示"（本地账本；权威态仍看 layoutCoordinator）。 */
  let shown = false

  /** 浮层 webContents（不可用 → null）。 */
  function floatWc(): WebContents | null {
    try {
      const wc = layoutCoordinator.getFloatWebContents(NAME)
      if (!wc || (typeof wc.isDestroyed === 'function' && wc.isDestroyed())) return null
      return wc
    } catch (_) {
      return null
    }
  }

  /** 整窗矩形（窗口内容区坐标；浮层的坐标系就是它）。 */
  function fullWindowRect(): FloatRect | null {
    const size = layoutCoordinator.getWindowContentSize()
    if (!size || size.width <= 0 || size.height <= 0) return null
    return { x: 0, y: 0, width: size.width, height: size.height }
  }

  /** 把浮层铺满整窗（窗口尺寸变化时也走这里）。 */
  function applyBounds(): boolean {
    const rect = fullWindowRect()
    if (!rect) return false
    try {
      layoutCoordinator.setFloatBounds(NAME, rect)
      return true
    } catch (_) {
      return false
    }
  }

  /** 该拿键盘了：浮层要能直接接 Esc（见 LayoutCoordinator#focusFloat 的"确认到手就停"）。 */
  function grabKeyboard(): void {
    try {
      layoutCoordinator.focusFloat(NAME)
    } catch (_) {}
  }

  /** 显示（首次整份帧）。 */
  function show(payload: unknown): void {
    if (disposed) return
    if (hideTimer) {
      clearTimeout(hideTimer)
      hideTimer = null
    }
    // 顺序与其它浮层一致：先立视图 → 登记"请求显示" → 几何 → 可交互。
    // 几何在 send 之前落位，渲染页一揭开就是最终尺寸（没有"先小后大"的一跳）。
    try {
      layoutCoordinator.attachFloatView(NAME)
    } catch (_) {}
    try {
      layoutCoordinator.noteFloatShow(NAME)
    } catch (_) {}
    applyBounds()
    try {
      layoutCoordinator.setFloatInteractive(NAME, true)
    } catch (_) {}
    shown = true
    // sendToFloat 会等 renderer 就绪（冷启动首帧不丢事件）；之后再把键盘接过来。
    Promise.resolve(layoutCoordinator.sendToFloat(NAME, channel(IPC_EVENTS.breakOverlayShow), normalize(payload)))
      .then(() => {
        if (!disposed && shown) grabKeyboard()
      })
      .catch(() => {})
  }

  /** 收起（先让渲染页播退场动画，再零 bounds）。 */
  function hide(): void {
    if (disposed || !shown) return
    shown = false
    const wc = floatWc()
    if (wc) {
      try {
        wc.send(channel(IPC_EVENTS.breakOverlayHide), {})
      } catch (_) {}
    }
    if (hideTimer) clearTimeout(hideTimer)
    hideTimer = setTimeout(() => {
      hideTimer = null
      if (disposed) return
      try {
        // 0×0 = 收起。它同时把交互态关掉、排上闲置回收（见 LayoutCoordinator#setFloatBounds）。
        layoutCoordinator.hideFloat(NAME)
      } catch (_) {}
    }, HIDE_ANIM_MS)
    if (hideTimer && typeof hideTimer.unref === 'function') hideTimer.unref()
  }

  /**
   * 消费状态机推来的一帧（每秒一次）。
   * `open === false` = 本轮结束；否则照常刷新，浮层还没起来就顺手拉起来。
   * @param {{ open?: boolean } & Record<string, unknown>} payload
   */
  function sync(payload: unknown): void {
    if (disposed) return
    if (payload && typeof payload === 'object' && (payload as { open?: unknown }).open === false) {
      hide()
      return
    }
    const visible = (() => {
      try {
        return layoutCoordinator.isFloatVisible(NAME)
      } catch (_) {
        return false
      }
    })()
    if (!shown || !visible) {
      show(payload)
      return
    }
    const wc = floatWc()
    if (!wc) {
      // 视图被回收了（闲置回收 / 崩溃）—— 重新来一遍完整显示。
      shown = false
      show(payload)
      return
    }
    try {
      wc.send(channel(IPC_EVENTS.breakOverlayUpdate), normalize(payload))
    } catch (_) {}
  }

  /**
   * 窗口尺寸变化后重新铺满。
   *
   * 不监听 `resize` 的每一拍去做全量重排：`setFloatBounds` 自带「bounds 未变则跳过」，
   * 这里只把窗口事件转成一次幂等的几何写入，代价可忽略。
   */
  function syncBounds(): void {
    if (disposed || !shown) return
    applyBounds()
  }

  const onSyncBounds = (): void => syncBounds()
  // maximize / unmaximize / 全屏切换都会改内容区尺寸，但**不保证**每次都派发 resize
  // （Windows 上全屏切换尤其如此）—— 这些都接上，几何才不会停在旧尺寸。
  const WINDOW_EVENTS = [
    'resize',
    'maximize',
    'unmaximize',
    'enter-full-screen',
    'leave-full-screen',
    'restore'
  ] as const
  for (const event of WINDOW_EVENTS) {
    try {
      win.on(event as 'resize', onSyncBounds)
    } catch (_) {}
  }

  /** 窗口/单元销毁：解绑全部监听，定时器作废（浮层视图随窗口一起消失）。 */
  function dispose(): void {
    if (disposed) return
    disposed = true
    shown = false
    if (hideTimer) clearTimeout(hideTimer)
    hideTimer = null
    for (const event of WINDOW_EVENTS) {
      try {
        win.removeListener(event as 'resize', onSyncBounds)
      } catch (_) {}
    }
  }

  return { show, hide, sync, syncBounds, dispose }
}

