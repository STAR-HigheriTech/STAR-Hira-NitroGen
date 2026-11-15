/**
 * capture-overlay —— 「截取选区」的**框选层**（独立原生视图，盖在被截的那一页之上）。
 *
 * ── 为什么必须是独立原生视图 ────────────────────────────────────────
 * 网页跑在 WebContentsView 里，天然盖住外壳 DOM —— 想"在网页上画一个选择框"，
 * 只能在**另一个同样大小的原生视图**上画。这与查找栏 / 落点预览同一条理由。
 *
 * ── 它只管一件事：把用户框出的矩形交出去 ─────────────────────────────
 * 视图 bounds 由主进程设成**目标页视图的矩形**，因此本页的坐标与页面视口坐标 **1:1**
 * —— 于是框选结果可以直接当 `capturePage(rect)` 的参数用，中间不需要任何换算。
 * 这是"框选的正是截到的那一块"的结构性保证（与落点预览同一手法）。
 *
 * ── 数据流（单向）────────────────────────────────────────────────────
 *   主进程 capture-region → `capture-overlay:show`  → 本页进入可框选态
 *   用户拖出一个矩形      → `capture-overlay:select {x,y,width,height}` → 主进程截图
 *   Esc / 点空白取消      → `capture-overlay:cancel`  → 主进程收起
 *   主进程收起            → `capture-overlay:hide`    → 本页复位
 */

import '@hira-ng/shared-ui-tokens/tokens-base.css'
import '@hira-ng/shared-ui-tokens/tokens-light.css'
import '@hira-ng/shared-ui-tokens/tokens-dark.css'
import { IPC_ROUTES, IPC_EVENTS } from '@hira-ng/shared-types/src/ipc-channels.mjs'
import { createThemeController } from '../shared/theme-controller.js'
import { getHiraBridge } from '../shared/bridge.js'

const bridge = getHiraBridge()
const provider = bridge.provider

const themeController = createThemeController({ document, bridge })
themeController.start()
window.addEventListener('pagehide', () => themeController.dispose(), { once: true })

const CSS = `
  .cap-layer {
    position: fixed; inset: 0; display: none; cursor: crosshair;
    user-select: none; -webkit-user-select: none;
  }
  /* 进入框选态必须**立刻看得见**：整页压一层淡暗（0.45，与标注浮层同值）。
     否则用户不知道"已经可以框了"，观感就是"点了没反应"（这是本功能的第一次真实反馈）。 */
  .cap-layer.on { display: block; background: rgba(0, 0, 0, 0.45); }
  /* 一按下鼠标就把这层"均匀压暗"换成 “.cap-box” 的"挖洞压暗"（box-shadow 溢出 100vmax）。
     选区外仍是 0.45（**亮度不变**），选区内变亮 —— 与 QQ / Snipaste 一致。
     这一步必须是同一个类切换：早先的做法是"整页只压 0.16、松手时才改成只留 0.45"，
     于是松手瞬间选区内外同时跳一次亮度（0.16→0 / 0.533→0.45），那就是可见的闪。 */
  .cap-layer.on.draw { background: transparent; }
  /* 选择框：box-shadow 溢出 100vmax 形成"挖洞"遮罩 —— 不需要两层元素，
     也不需要按窗口尺寸算四块补丁（尺寸变化时自动跟随）。 */
  .cap-box {
    position: absolute; display: none; box-sizing: border-box;
    border: 1px solid var(--hira-accent, #4c9aff); border-radius: 1px;
    box-shadow: 0 0 0 100vmax rgba(0, 0, 0, 0.45);
    transition: box-shadow .18s ease-out;
  }
  /* 交接淡出：标注浮层首帧已出图 → 把"选区外 0.45"在 180ms 内收成透明。
     标注浮层那层淡暗同时淡入，两边交叉，合成亮度基本恒在 0.45；
     若在此刻直接收层，两层叠加会到 0.6975 —— 那一下"周围更黑"就是闪烁。 */
  .cap-layer.settling .cap-box { box-shadow: 0 0 0 100vmax rgba(0, 0, 0, 0); }
  .cap-size {
    position: absolute; display: none; padding: 2px 6px; border-radius: var(--hira-radius-2xs, 4px);
    font-size: 11px; line-height: 1.4; white-space: nowrap;
    background: rgba(0, 0, 0, 0.72); color: #fff;
  }
`
const style = document.createElement('style')
style.textContent = CSS
document.head.appendChild(style)

const root = ((): HTMLElement => {
  const element = document.getElementById('root')
  if (!element) throw new Error('Capture overlay root is unavailable')
  return element
})()
const layer = document.createElement('div')
layer.className = 'cap-layer'
const box = document.createElement('div')
box.className = 'cap-box'
const sizeTag = document.createElement('div')
sizeTag.className = 'cap-size'
layer.appendChild(box)
layer.appendChild(sizeTag)
root.appendChild(layer)

let dragging = false
/** 已上报选区、等标注浮层接管（此时画面**冻结**在"选区洞"上，不再响应新的拖动）。 */
let locked = false
let startX = 0
let startY = 0

interface CaptureRect {
  x: number
  y: number
  width: number
  height: number
}

interface CaptureClosePayload {
  route: string
  body?: unknown
}

/** 由两个角点算出归一化矩形（宽高恒为正）。 */
function rectOf(x: number, y: number): CaptureRect {
  return {
    x: Math.min(startX, x),
    y: Math.min(startY, y),
    width: Math.abs(x - startX),
    height: Math.abs(y - startY)
  }
}

function paint(rect: CaptureRect) {
  box.style.display = 'block'
  box.style.left = `${rect.x}px`
  box.style.top = `${rect.y}px`
  box.style.width = `${rect.width}px`
  box.style.height = `${rect.height}px`
  sizeTag.style.display = 'block'
  sizeTag.textContent = `${Math.round(rect.width)} × ${Math.round(rect.height)}`
  // 尺寸标签贴着框的左上角外侧；顶到窗口上缘时翻到框内，避免被裁掉。
  const above = rect.y > 22
  sizeTag.style.left = `${rect.x}px`
  sizeTag.style.top = above ? `${rect.y - 20}px` : `${rect.y + 4}px`
}

/** 复位到"等待框选"的干净状态。 */
function reset() {
  dragging = false
  locked = false
  layer.classList.remove('locked')
  // 先摘掉 settling 再隐藏框：同一帧内完成，动画不会在 display:none 之外露出来。
  layer.classList.remove('settling')
  // 摘掉 draw 会把"挖洞压暗"换回整页压暗；这一步在 display:none 之前同帧完成，
  // 因此不会在可见状态下闪一下更亮 / 更暗。
  layer.classList.remove('draw')
  box.style.display = 'none'
  // 边框在 lock() 里被抹成透明（见那里），复位时必须还原，否则下一轮框选没有蓝框。
  box.style.borderColor = ''
  sizeTag.style.display = 'none'
}

function close(payload: CaptureClosePayload) {
  reset()
  layer.classList.remove('on')
  try { provider.send(payload.route, payload.body || {}) } catch (_) {}
}

/**
 * 冻结当前选区（上报后到标注浮层接管前）。
 *
 * 关键：**不 reset、不移除 `.on`** —— 画面必须原样停住。
 * 早先这里是"先关层再截图"，页面会亮回来一下；现在由主进程在标注浮层画完首帧后
 * 才发 hide，本层才复位（见 `main/capture-region.js#capture`）。
 */
function lock() {
  dragging = false
  locked = true
  layer.classList.add('locked')
  // 这里**不做任何视觉改动**：截图 + 标注浮层首帧还有几十毫秒，
  // 期间画面必须原样停住（边框 / 尺寸标签都留着），否则就是"松手一瞬间框没了"。
  // 收起它们放在 settle（图像已经盖上来那一刻），见下面的订阅。
}

layer.addEventListener('mousedown', (e) => {
  if (e.button !== 0 || locked) return
  dragging = true
  startX = e.clientX
  startY = e.clientY
  // 同一帧把"整页均匀压暗"换成"挖洞压暗"：层背景转透明、改由 box 的 100vmax 阴影压暗。
  // 选区外亮度不变（都是 0.45），选区内变亮 —— 拖动过程中不会忽暗忽亮。
  layer.classList.add('draw')
  paint(rectOf(e.clientX, e.clientY))
})

window.addEventListener('mousemove', (e) => {
  if (!dragging) return
  paint(rectOf(e.clientX, e.clientY))
})

window.addEventListener('mouseup', (e) => {
  if (!dragging || e.button !== 0) return
  const rect = rectOf(e.clientX, e.clientY)
  // 太小的框当"误点"处理：截一张 1×1 的图没有意义，静默取消更符合直觉。
  if (rect.width < 4 || rect.height < 4) {
    close({ route: IPC_ROUTES.captureOverlayCancel })
    return
  }
  // 只上报，不关层：选区原样留在屏幕上，直到标注浮层把它接过去（见 lock 的说明）。
  lock()
  try { provider.send(IPC_ROUTES.captureOverlaySelect, rect) } catch (_) {}
})

window.addEventListener('keydown', (e) => {
  // 已上报（等标注浮层接管）时不再吞 Esc：那一刻这层马上要被收起，
  // 再发一条 cancel 只会和主进程的收尾抢时序。
  if (e.key !== 'Escape' || locked) return
  close({ route: IPC_ROUTES.captureOverlayCancel })
})

bridge.on.subscribe(IPC_EVENTS.captureOverlayShow, () => {
  reset()
  layer.classList.add('on')
})
// 标注浮层首帧已出图：本层把"选区外 0.45"淡出（见 CSS 的 .settling）。
// 主进程会在淡出结束后才收起本层，因此这里不需要自己收尾。
bridge.on.subscribe(IPC_EVENTS.captureOverlaySettle, () => {
  // 标注浮层的图像此刻已经盖在选区上了：蓝框被图像边缘顶替、尺寸标签该退场。
  // 边框用透明而不是消失（保持盒模型不变，淡出过程中边缘不会位移）。
  box.style.borderColor = 'transparent'
  sizeTag.style.display = 'none'
  layer.classList.add('settling')
})
bridge.on.subscribe(IPC_EVENTS.captureOverlayHide, () => {
  reset()
  layer.classList.remove('on')
})

