import { IPC_ROUTES } from '@hira-ng/shared-types/src/ipc-channels.mjs'
import { getHiraBridge, type JsonRecord } from './bridge.js'
import type { QrCaptureFrame, QrFrameGeometry, QrScanResult } from './qr-scan/types.js'

export type ScreenFrameMode = 'move' | 'resize'
export type ScreenFrameEdge = 'tl' | 'tr' | 'bl' | 'br'

export interface ScreenFrameDragIntent {
  mode: ScreenFrameMode
  edge?: ScreenFrameEdge
  dx: number
  dy: number
}

/**
 * 屏幕抓帧客户端 —— 面板端口之一（`ctx.clients.screen`）。
 *
 * 抓屏只可能在主进程做（渲染层拿不到桌面画面）。这里只做「调用 + 形状归一」，
 * 不含任何抓帧逻辑：真正实现是 `qr-scanner` 插件的能力（`qr.captureScreen`），
 * 能力被禁用时这里的调用会抛 —— 这正是要的语义：**禁用 = 功能真的没了**。
 *
 * 取景框窗口（浮框）的开关也在这里 —— 它是同一条链路上的东西
 * （框在哪儿 → 抓哪儿），放在一起调用方才不需要认识两个端口。
 */
function invoke<T = JsonRecord>(route: string, arg?: unknown): Promise<T> {
  return getHiraBridge().provider.invoke<T>(route, arg)
}

export const screenCaptureClient = {
  /**
   * 抓一帧。
   *
   * **扫哪一块由取景框决定**：浮框开着时主进程抓它所在的那块屏并裁到框内
   * （此时 `displayId` 被忽略）；浮框没开时抓 `displayId` 指定的屏，
   * 省略则抓光标所在的那块。
   *
   * @param {{ displayId?: string }} [opts]
   * @returns {Promise<{ ok: boolean, reason?: string, width?: number, height?: number,
   *                     data?: Uint8Array, framed?: boolean }>}
   */
  captureScreen(opts?: { displayId?: string }): Promise<QrCaptureFrame> {
    return invoke<QrCaptureFrame>(IPC_ROUTES.screenCapture, opts || {})
  },

  /** 打开取景框（幂等：已开着就聚焦/复用）。 */
  openFrame(): Promise<QrScanResult> {
    return invoke<QrScanResult>(IPC_ROUTES.screenFrameOpen, {})
  },

  /** 关闭取景框。 */
  closeFrame(): Promise<QrScanResult> {
    return invoke<QrScanResult>(IPC_ROUTES.screenFrameClose, {})
  },

  /**
   * 拖框 / 缩放框：只报**意图**，几何由主进程算。
   *
   * @param {{ mode: 'move'|'resize', edge?: 'tl'|'tr'|'bl'|'br', dx: number, dy: number }} intent
   *   `dx/dy` 是光标**从按下到现在**的总位移（不是增量，也不是目标矩形）。
   *   为什么不是目标矩形：窗口矩形只有主进程权威 —— 渲染层量到的矩形与 `setBounds`
   *   的坐标系在缩放的显示器上并不总是同一个数，那会让第一次落位把窗口"跳"大
   *   （见 contracts/screen.js 的 frameDrag）。
   */
  dragFrame(intent: ScreenFrameDragIntent) {
    const p = intent
    return invoke(IPC_ROUTES.screenFrameDrag, {
      mode: p.mode === 'resize' ? 'resize' : 'move',
      ...(p.edge ? { edge: p.edge } : {}),
      dx: Number(p.dx) || 0,
      dy: Number(p.dy) || 0
    })
  },

  /**
   * 取景框的几何快照（**没有像素**）：`{ ok, open, crop, display }`。
   *
   * 由"渲染层自己抓屏"那条路调用 —— 屏幕流是整屏的，要知道框在流里的哪一块。
   * 比 `captureScreen()` 便宜四个数量级，所以每次抓帧前调一次没有负担。
   */
  frameGeometry(): Promise<QrFrameGeometry> {
    return invoke<QrFrameGeometry>(IPC_ROUTES.screenFrameGeometry, {})
  },

  /**
   * 上报"正在拖动 / 缩放"。
   *
   * 两件事都靠它：
   *   ① 交互期间主进程**一帧都不抓**（`frame.busy`）—— 否则整屏回读会和拖动抢主进程；
   *   ② **松手**后主进程才发 `qrScanSettled` 事件 → 面板才抓那一帧解码（触发式扫描）。
   */
  setFrameInteracting(active: boolean) {
    return invoke(IPC_ROUTES.screenFrameInteract, { active: active === true })
  }
}

