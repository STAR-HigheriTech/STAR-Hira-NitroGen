/**
 * hoverurl-overlay —— 链接悬停 URL 提示条的**宿主渲染页**（独立原生视图）
 *
 * 与查找栏同构的薄宿主：`@hira-ng/ui-hover-url` 只管画，本文件管端口与几何。
 * 形态与 RT 一致（RT 的 PortalComponent 也是"独立透明 WebContentsView + DOM
 * `pointer-events:none`"）：它**不占位、不挤网页**、`interactive:false`（不吃鼠标）、
 * 且从不抢键盘焦点（见 LayerStack 的 `float:hoverurl-overlay` focusPriority = 0）。
 *
 * ── 两个自由度（都在主进程那一侧决定，这里只上报）──────────────────────
 *   1. **内容**：`hover-url:update { url, maxWidth, immediate }` —— 来自活动标签
 *      webContents 的 `update-target-url`（鼠标每滑过一个链接就发一条，空串 = 离开）；
 *   2. **位置**：`position: 'in-content'` + align left / valign bottom = 网页左下角，
 *      间距由 CONTENT_MARGIN 给。
 *
 * ── view 的收放跟着"胶囊在不在"走 ────────────────────────────────────
 * 组件自带 400ms 的收起延迟（相邻链接之间快速划过不闪断）。因此**不能**一收到空 URL
 * 就收 view —— 那 400ms 白设了。这里以组件的 `onShownChange` 为唯一信号：
 * true → 上报尺寸（显示）；false → 请主进程收起。
 *
 * IPC：
 *   订阅 hover-url:update { url, maxWidth, immediate }
 *   调用 hoverurl-overlay:display（单向）/ hoverurl-overlay:hide / hoverurl-overlay:ready
 */

import '@hira-ng/shared-ui-tokens/tokens-base.css'
import '@hira-ng/shared-ui-tokens/tokens-light.css'
import '@hira-ng/shared-ui-tokens/tokens-dark.css'
import { IPC_EVENTS } from '@hira-ng/shared-types/src/ipc-channels.mjs'
import { createHoverUrlPill, injectHoverUrlStyles, HOVERURL_PAD } from '@hira-ng/ui-hover-url'
import { createThemeController } from '../shared/theme-controller.js'
import { getHiraBridge } from '../shared/bridge.js'

const bridge = getHiraBridge()
const provider = bridge.provider

const themeController = createThemeController({ document, bridge })
themeController.start()
window.addEventListener('pagehide', () => themeController.dispose(), { once: true })

injectHoverUrlStyles(document)

const OVERLAY = 'hoverurl-overlay'

/**
 * 胶囊到网页左边缘 / 下边缘的间距（px）。
 * 与视图余量 HOVERURL_PAD(2) 相加 = **8px 总间距**（RT TargetUrlIndicator 的
 * PADDING = 8 口径）—— 之所以拆成两段：视图余量是防原生视图按 DPI 取整裁切，
 * 内容间距才是设计值。
 */
const CONTENT_MARGIN = 6

/** 最近一次收到的最大宽度（收起时也要用它量尺寸，否则会按上一屏的宽度算）。 */
let lastMaxWidth = 0

const pill = createHoverUrlPill(document, {
  onShownChange: (shown) => {
    if (shown) reportDisplay()
    else hideOverlay()
  }
})

// 胶囊是 `position: fixed`；视图尺寸 = 胶囊 + 四周余量（防原生视图取整裁切），按余量内缩定位。
pill.element.style.left = `${HOVERURL_PAD}px`
pill.element.style.bottom = `${HOVERURL_PAD}px`
const root = document.getElementById('root')
if (!root) throw new Error('Hover URL overlay root is unavailable')
root.appendChild(pill.element)

function reportDisplay() {
  const { width, height } = pill.measure()
  if (!width || !height) return
  try {
    provider.send(`${OVERLAY}:display`, {
      width: width + HOVERURL_PAD * 2,
      height: height + HOVERURL_PAD * 2,
      // 主进程按网页矩形落位（网页矩形只有它知道）：'in-content' + 左下对齐 + 间距
      position: 'in-content',
      align: 'left',
      valign: 'bottom',
      margin: CONTENT_MARGIN,
      // 信息层：**永不吃鼠标**。Electron 的 WebContentsView 没有 setIgnoreMouseEvents
      // （视图只要可见就参与命中），所以"少占面积（余量只留 2px）+ DOM pointer-events:none"
      // 就是能做到的极限 —— RT 的 tabTargetUrlIndicator 同样是这个形态。
      interactive: false
    })
  } catch (_) {}
}

function hideOverlay() {
  try { provider.send(`${OVERLAY}:hide`, {}) } catch (_) {}
}

bridge.on.subscribe(IPC_EVENTS.hoverUrlUpdate, (payload) => {
  const p = payload || {}
  const maxWidth = Number(p.maxWidth)
  if (Number.isFinite(maxWidth) && maxWidth > 0) lastMaxWidth = maxWidth
  const url = String(p.url || '')
  if (!url && p.immediate) {
    // 切标签 / 开始导航 / 窗口失焦：不等延迟，立刻消失
    pill.hide({ maxWidth: lastMaxWidth })
    return
  }
  pill.setUrl(url, { maxWidth: lastMaxWidth })
})

/**
 * 主进程兜底收起（切标签 / 导航 / 窗口失焦 / 主窗口移动缩放）。
 *
 * ⚠ 必须处理：胶囊的"我在显示"状态住在组件里，主进程把窗口藏起来只是让它看不见 ——
 * 不同步复位的话，下次**同一个 URL** 再被悬停时组件会认为"内容没变"而跳过重画，
 * 表现就是"离开过一次链接之后，再悬停同一个链接不显示了"。
 */
bridge.on.subscribe(IPC_EVENTS.hoverurlOverlayHide, () => {
  pill.hide({ maxWidth: lastMaxWidth })
})

;(async () => {
  try { await provider.invoke(`${OVERLAY}:ready`, {}) } catch (_) {}
})()

