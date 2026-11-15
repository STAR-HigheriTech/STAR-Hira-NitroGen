/**
 * zoom-overlay —— 页面缩放条的**宿主渲染页**（独立原生视图）
 *
 * 薄宿主：`@hira-ng/ui-zoom-indicator` 只管画，本文件管端口与几何。
 *
 * ── 数据流 ────────────────────────────────────────────────────────────
 *   主进程（zoom-controller）是缩放的**唯一执行者**（它有标签的 webContents）。
 *   任何来源（快捷键 / Ctrl+滚轮 / 本浮层的按钮）改了缩放，主进程都发一条
 *   `zoom:changed { level, percent, source }` —— 本浮层据此更新数字并弹出自己：
 *   · source === 'restore'（导航到新站点时恢复该站记忆）→ **不弹**（用户没操作缩放）；
 *   · 其余来源 → 弹出 + 1.6s 后自动收起（组件的 autoHideMs）。
 *   于是本文件没有任何"自己算缩放"的分支 —— 数字永远来自主进程那一条事实。
 *
 * IPC（路由由 `shared/overlay-scope.js` 统一决定 —— 主窗口 / PWA 应用窗两套）：
 *   订阅 zoom:changed { level, percent, source }
 *   发送 zoom:step { delta } / zoom:reset / display / hide / ready
 */

import '@hira-ng/shared-ui-tokens/tokens-base.css'
import '@hira-ng/shared-ui-tokens/tokens-light.css'
import '@hira-ng/shared-ui-tokens/tokens-dark.css'
import { IPC_EVENTS } from '@hira-ng/shared-types/src/ipc-channels.mjs'
import { createZoomIndicator, injectZoomStyles, ZOOM_SHADOW_PAD } from '@hira-ng/ui-zoom-indicator'
import { createThemeController } from '../shared/theme-controller.js'
import { getHiraBridge } from '../shared/bridge.js'
import { resolveOverlayScope } from '../shared/overlay-scope.js'

const bridge = getHiraBridge()
const provider = bridge.provider

const themeController = createThemeController({ document, bridge })
themeController.start()
window.addEventListener('pagehide', () => themeController.dispose(), { once: true })

injectZoomStyles(document)

const OVERLAY = 'zoom-overlay'

/** 主窗口 / PWA 应用窗两套路由的唯一差分点。 */
const scope = resolveOverlayScope(OVERLAY, provider)

/** 与网页上边缘的间距（px）。缩放条落网页顶部居中。 */
const CONTENT_MARGIN = 10

const zoom = createZoomIndicator(document, {
  onStep: (delta) => scope.zoomStep({ delta }),
  onReset: () => scope.zoomReset(),
  // 自动收起：组件计时，宿主收 view（它不认识浮层，收 bounds 只能由这里发起）
  onAutoHide: () => {
    zoom.setShown(false)
    scope.hide()
  }
})

// 胶囊是 `position: fixed`；视图尺寸 = 胶囊 + 四周留白（投影），按留白内缩定位。
zoom.element.style.left = `${ZOOM_SHADOW_PAD}px`
zoom.element.style.top = `${ZOOM_SHADOW_PAD}px`
const root = document.getElementById('root')
if (!root) throw new Error('Zoom overlay root is unavailable')
root.appendChild(zoom.element)

function reportDisplay() {
  const { width, height } = zoom.measure()
  if (!width || !height) return
  scope.display({
    width: width + ZOOM_SHADOW_PAD * 2,
    height: height + ZOOM_SHADOW_PAD * 2,
    position: 'in-content',
    align: 'center',
    valign: 'top',
    margin: CONTENT_MARGIN,
    // 三个按钮可点 → 这一段小区域必须吃鼠标（其余区域本来就在视图之外）
    interactive: true
  })
}

bridge.on.subscribe(IPC_EVENTS.zoomChanged, (payload) => {
  const p = payload || {}
  zoom.setPercent(Number(p.percent) || 100)
  if (p.source === 'restore') return
  // 先量后报：首次显示时宽度可能是 0（还没进过布局），setShown 之后再量一次。
  reportDisplay()
  zoom.setShown(true)
  reportDisplay()
})

// 主进程兜底收起（自动收起回执 / 窗口失焦 / 切标签）：同步复位组件的显隐状态，
// 否则它以为"还开着"，下一次同样的缩放变化不会重播入场动效。
bridge.on.subscribe(IPC_EVENTS.zoomOverlayHide, () => {
  zoom.setShown(false)
})

scope.ready()

