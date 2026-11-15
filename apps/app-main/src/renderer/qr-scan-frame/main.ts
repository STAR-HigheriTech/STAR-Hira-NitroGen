/**
 * 扫码取景框（浮框窗口）的渲染侧 —— 三件事：**灌几何**、**拖动**、**缩放**。
 *
 * ══════════════════════════════════════════════════════════════════════
 * 一、拖动 / 缩放：这里只报**意图**，矩形由主进程算
 * ══════════════════════════════════════════════════════════════════════
 * 不用 CSS 的 `-webkit-app-region: drag`：那是 OS 级拖拽，最省事 —— 但它在
 * **透明 + 无边框**窗口上并不总是可靠，而"能拖动"是取景框的**唯一交互**：
 * 拖动一旦失效，整个功能就是一块钉在屏幕上的装饰。
 *
 * 也**不在这里算矩形**：窗口矩形只有主进程是权威（`getBounds()`）。这里量到的
 * `window.screenX` / `window.innerWidth` 与 `setBounds` 用的坐标系在缩放的显示器上
 * 并不总是同一个数 —— 一旦不一致，**第一次落位**就会把窗口"跳"到一个偏大的尺寸，
 * 用户看到的就是"按住一下就自己变大"。
 *
 * 所以这里只上报三样（`{ mode, edge, dx, dy }`）：移动还是缩放、拖哪个角、
 * 光标**从按下到现在**的总位移。用总位移而不是增量 —— 增量会因丢帧/舍入一路漂移；
 * 主进程拿"按下那一刻的矩形 + 总位移"重算，永远与光标对齐。每帧最多一次 IPC（rAF 合并）。
 *
 * ══════════════════════════════════════════════════════════════════════
 * 二、交互期间上报"我在动"，主进程据此**一帧都不抓**
 * ══════════════════════════════════════════════════════════════════════
 * 抓一帧整屏要主进程回读 8MB 再把它塞过 IPC。只要它和拖动叠在一起，主进程就腾不出手
 * 给窗口落位 —— 表现就是**拖不动、整块界面卡住**。所以：
 *   mousedown → interacting(true)  → 主进程在抓帧入口直接短路（连 desktopCapturer 都不碰）
 *   mouseup   → interacting(false) → 静默一拍后主进程发 `qrScanSettled`
 *                                    → **面板只在那一刻抓一帧**（触发式扫描）
 * 于是静止时零抓屏、零解码；代价只在真正放下取景框的那一瞬间。
 *
 * ══════════════════════════════════════════════════════════════════════
 * 三、尺寸由 CSS 自己跟（这里不参与）
 * ══════════════════════════════════════════════════════════════════════
 * 框页写的是 `width:100%` / `height: calc(100vh - var(--bar))`，主进程把窗口改多大，
 * 它就长多大 —— 少一处"两边各算一遍"的漂移点。裁剪区同理由几何常量推出。
 */

import { QR_SCAN_BAR } from '@hira-ng/shared-types/src/qr-scan-frame.mjs'
import {
  screenCaptureClient,
  type ScreenFrameDragIntent,
  type ScreenFrameEdge,
  type ScreenFrameMode
} from '../shared/screen-capture-client.js'

document.documentElement.style.setProperty('--bar', `${QR_SCAN_BAR}px`)

const closeBtn = document.getElementById('close')
const rescanBtn = document.getElementById('rescan')
if (!closeBtn || !rescanBtn) throw new Error('QR scan frame controls are unavailable')

/**
 * 起拖阈值（DIP）：位移小于它一律不落位。
 *
 * 按住不动时手也会抖一两像素。没有这个阈值，"长按"本身就会被当成一次拖动/缩放，
 * 窗口于是会自己动一下 —— 正是"按住一下就自己变大"的观感来源之一。
 * 阈值只管"什么时候开始"，一旦开始，`dx/dy` 仍是**从按下那一刻**算起的完整位移，
 * 所以落位不跳、不从阈值处重新对零。
 */
const DRAG_THRESHOLD = 3

interface DragAction {
  mode: ScreenFrameMode
  edge?: ScreenFrameEdge
  pointerId: number
  x: number
  y: number
  started: boolean
}

let action: DragAction | null = null
/** 待下发的意图（rAF 合并：一帧最多一次 IPC）。 */
let pending: ScreenFrameDragIntent | null = null
let rafId = 0

/** 把这一帧攒下来的意图发出去（rAF 回调，一帧最多一次）。 */
function flush(): void {
  rafId = 0
  const intent = pending
  pending = null
  if (!intent || !action) return
  screenCaptureClient.dragFrame(intent).catch(() => {})
}

function schedule(dx: number, dy: number): void {
  if (!action) return
  pending = { mode: action.mode, edge: action.edge, dx, dy }
  if (!rafId) rafId = requestAnimationFrame(flush)
}

function isFrameEdge(value: string | null): value is ScreenFrameEdge {
  return value === 'tl' || value === 'tr' || value === 'bl' || value === 'br'
}

function startAction(e: PointerEvent, mode: ScreenFrameMode, edge?: ScreenFrameEdge): void {
  if (e.button !== 0) return
  e.preventDefault()
  action = { mode, edge, pointerId: e.pointerId, x: e.screenX, y: e.screenY, started: false }
  /**
   * 抓住指针：光标移出这一小块透明窗口之后，`pointermove` / `pointerup` 依然回到这里。
   * 少了它，长按期间光标一旦离开窗口，"抬手"就收不到 —— 动作会一直挂着，
   * 之后任何一次悬停移动都会拿着陈旧的位移去落位（窗口莫名其妙跳成另一个尺寸）。
   */
  try { document.body.setPointerCapture(e.pointerId) } catch (_) {}
  // 先停识别：主进程会立刻在抓帧入口短路，把线程让给拖动（并作废拖动基准矩形）
  screenCaptureClient.setFrameInteracting(true).catch(() => {})
}

function endAction(e?: Event): void {
  if (!action) return
  if (e instanceof PointerEvent && e.pointerId !== action.pointerId) return
  const { pointerId } = action
  action = null
  if (rafId) { cancelAnimationFrame(rafId); rafId = 0 }
  pending = null
  try { document.body.releasePointerCapture(pointerId) } catch (_) {}
  // 放下了：主进程静默一拍后发 qrScanSettled → 面板才抓那一帧解码
  screenCaptureClient.setFrameInteracting(false).catch(() => {})
}

// ── 事件接线 ──────────────────────────────────────────────────────────
//
// 整窗可拖（含框内与提示条），只有两处例外：
//   · 四角手柄 → 缩放；
//   · 关闭按钮 → 关闭。
// 这样"拖动"这件事在任何位置都成立，不需要用户先找到那一圈 14px 的边框。

document.addEventListener('pointerdown', (e) => {
  if (e.button !== 0) return
  const target = e.target
  if (target instanceof Element) {
    if (target.closest('#close') || target.closest('#rescan')) return
    const handle = target.closest('[data-resize]')
    if (handle) {
      const edge = handle.getAttribute('data-resize')
      startAction(e, 'resize', isFrameEdge(edge) ? edge : undefined)
      return
    }
  }
  startAction(e, 'move')
})

window.addEventListener('pointermove', (e) => {
  if (!action || e.pointerId !== action.pointerId) return
  /**
   * 按键其实已经抬起来了，却没有收到 `pointerup`（我们自己 `setBounds` 时，
   * OS 有时会吞掉那一次抬起）—— 这里补一刀。否则 `action` 会一直"上膛"，
   * 之后**任何一次悬停移动**都会拿这份陈旧位移去落位。
   * 取景框是 `showOnReadyMode: 'inactive'` 显示的（可能从未获得过焦点），
   * 所以 `blur` 兜不住这条路径 —— 这条判断才是真正管用的那道闸。
   */
  if (e.buttons === 0) { endAction(e); return }
  const dx = e.screenX - action.x
  const dy = e.screenY - action.y
  // 阈值：没动够就不落位，且**不开始**（一旦开始就再也不看阈值，见 DRAG_THRESHOLD）
  if (!action.started) {
    if (Math.abs(dx) < DRAG_THRESHOLD && Math.abs(dy) < DRAG_THRESHOLD) return
    action.started = true
  }
  schedule(dx, dy)
})

window.addEventListener('pointerup', endAction)
// 系统把指针抢走（触摸/笔/另一窗口接管）也是"这一次拖动结束了"
window.addEventListener('pointercancel', endAction)
// 指针捕获被系统释放 = 再也收不到 pointerup 了，必须当作结束
window.addEventListener('lostpointercapture', endAction)
window.addEventListener('blur', () => endAction())

closeBtn.addEventListener('click', () => {
  /**
   * `window.close()` 关的是**本窗口自己**（Electron 对窗口自身内容页是允许的）。
   * 主进程那边窗口一销毁，抓帧就回传 `framed:false` —— 面板据此停止扫描
   * （见模型里的处理），所以这里不需要额外的"通知主进程"步骤。
   */
  window.close()
})

/**
 * 「重新扫描」= 告诉主进程"我停手了，现在可以抓一帧"。
 *
 * 复用 `setFrameInteracting(false)` 而不是新开一条通道：那条通道的语义本来就是
 * "交互结束，静默一拍后请面板抓一帧"（见 screen-capture-client 的说明），
 * 点一下按钮与"把框放下"对扫描来说是完全同一件事 —— 多一条平行通道只会多一处要同步的规则。
 * 于是"手动重扫"的位置也统一到取景框自己身上：扫描时用户的眼睛就在这里。
 */
rescanBtn.addEventListener('click', () => {
  screenCaptureClient.setFrameInteracting(false).catch(() => {})
})
