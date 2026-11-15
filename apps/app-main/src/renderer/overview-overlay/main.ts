/**
 * Overview Overlay Renderer —— 「总览」浮层（Edge 左上角「标签操作菜单」形态）。
 *
 * ── 为什么是浮层而不是侧栏面板 ──────────────────────────────────────────
 * 总览是「随手看一眼 + 一次点击」的摘要面：空间（少量）→ 搜索 → 打开的标签（大量）
 * → 最近关闭 → 会话。真正的管理有「标签 / 空间 / 历史 / 会话」四块完整面板兜底，
 * 所以它不该再占一条侧栏宽度。主流浏览器（Edge 标签操作菜单、Chrome 标签搜索）也
 * 都是贴着触发器弹出的卡片，点外面 / Esc 即收。
 *
 * ── 它是**独立浮层视图**（铺满整窗）────────────────────────────────────
 * 触发器（空间胶囊）住在 ui-shell（窗口本体，图层最底），挂在它 DOM 里的卡片会被
 * #navbar 的 overflow 裁掉、并被 rail 盖住。因此：
 *   · 本层是独立 WebContentsView，z 高于 rail / 面板（见 LayerStack）；
 *   · 铺满整窗的透明层同时承担「点卡片外面收起」的模态判定 ——
 *     与系统菜单的模态行为一致（判据复用 ui-common#dismissOnOutsidePointerDown）。
 *
 * ── 数据全部自己拉（不再由外壳推快照）──────────────────────────────
 * 浮层常驻 visible、显隐只靠 bounds（见 LayoutCoordinator#_ensureFloatView），
 * 因此订阅不会断 —— 标签 / 空间 / 会话一变，列表自己就更新，不需要外壳中转，
 * 也不需要每次打开都重建 renderer。
 *
 * IPC（沿用通用浮层通道，零新增业务契约）：
 *   订阅：overview-overlay:show / :hide（主进程转发）
 *   调用：overview-overlay:display（一次性上报整窗 bounds + interactive）
 *         overview-overlay:hide（本层自己判定该收起时，走与外壳同一条权威收起路径）
 */

import '@hira-ng/shared-ui-tokens/tokens-base.css'
import '@hira-ng/shared-ui-tokens/tokens-light.css'
import '@hira-ng/shared-ui-tokens/tokens-dark.css'
import { IPC_EVENTS, IPC_ROUTES } from '@hira-ng/shared-types/src/ipc-channels.mjs'
import { createThemeController } from '../shared/theme-controller.js'
import { getHiraBridge } from '../shared/bridge.js'
import { createPanelContext, setPanelRefresh } from '../shared/panel-context.js'
import { dismissOnOutsidePointerDown } from '@hira-ng/ui-common/src/overlayCard'
import { injectOverviewPanelStyles, createOverview } from './panel.js'

/** 卡片与触发器的垂直间隙（px）。 */
const ANCHOR_GAP = 6
/** 卡片宽度上限（px）：用户口径「320」。窄而下拉卡片，贴近 Edge 标签操作菜单的尺度。 */
const CARD_MAX_WIDTH = 320
/** 卡片宽度下限（px）：窄窗口下保证标题还能读。 */
const CARD_MIN_WIDTH = 240
/** 卡片距窗口左右边缘的安全距离（px）。 */
const EDGE_PAD = 8

const bridge = getHiraBridge()

const themeController = createThemeController({ document, bridge })
themeController.start()

injectOverviewPanelStyles(document)

// ── 本视图的「浮层化」重置 ────────────────────────────────────────────────
// 面板基底（injectPanelStyles）会把 html/body/#root 铺成不透明底 —— 那是侧栏面板的
// 正确形态，但对一块盖在网页上的卡片是错的（会把整个窗口挡实）。这里统一压回透明，
// 只让卡片自己铺底。`!important` 是必须的：基底规则的优先级与本文件相同。
const resetStyle = document.createElement('style')
resetStyle.id = 'hira-overview-overlay-reset'
resetStyle.textContent = `
  html, body, #root { background: transparent !important; }
  #root { overflow: hidden; }
`
document.head.appendChild(resetStyle)

const STYLE_ID = 'hira-overview-overlay-styles'
if (!document.getElementById(STYLE_ID)) {
  const style = document.createElement('style')
  style.id = STYLE_ID
  style.textContent = `
    .overview-overlay__card {
      position: absolute;
      display: none;
      flex-direction: column;
      box-sizing: border-box;
      min-height: 0;
      border-radius: var(--hira-theme-radius, 12px);
      border: 1px solid var(--hira-border-subtle, rgba(0, 0, 0, 0.1));
      background: var(--hira-bg-elevated, #fff);
      color: var(--hira-text-primary, #1a1a1a);
      box-shadow: 0 12px 32px rgba(0, 0, 0, 0.22);
      overflow: hidden;
      transform-origin: top left;
      animation: overview-overlay-in var(--hira-dur-fast, 120ms) var(--hira-ease-standard, ease) both;
    }
    .overview-overlay__card--open { display: flex; }
    /* 内容区由「总览」视图自己排（它是纯 DOM，与侧栏面板同一份实现）。
       这里只把「撑满高度 / 自己滚动」的语义从面板形态换成浮层形态。 */
    .overview-overlay__card > .overview-overlay__wrap {
      flex: 1 1 auto;
      height: auto;
      min-height: 0;
    }
    @keyframes overview-overlay-in {
      from { opacity: 0; transform: translateY(-4px) scale(0.995); }
      to   { opacity: 1; transform: none; }
    }
    @media (prefers-reduced-motion: reduce) {
      .overview-overlay__card { animation: none; }
    }
  `
  document.head.appendChild(style)
}

const root = document.getElementById('root')
if (!root) throw new Error('Overview overlay root is unavailable')

/** 最近一次 show 带来的视口尺寸（= 本浮层视图尺寸，收起时无从读取）。 */
let viewport = { width: 0, height: 0 }
/** 卡片是否处于「应显示」状态（与 DOM 的 display 同步的唯一真源）。 */
let open = false

/** 标签 hover 预览：本视图已铺满整窗，坐标即窗口坐标，原样转发即可。 */
const previewOverlay = {
  showTabPreview(payload: unknown) {
    try { bridge.provider.send(IPC_EVENTS.tabpreviewOverlayShow, payload) } catch (_) {}
  },
  hideTabPreview() {
    try { bridge.provider.send(IPC_EVENTS.tabpreviewOverlayHide, {}) } catch (_) {}
  },
  warmTabPreview() {
    try { bridge.provider.send(IPC_ROUTES.floatWarm, { name: 'tabpreview-overlay' }) } catch (_) {}
  }
}

// 端口与侧栏面板 / 内部页**同一份**（shared/panel-context.js）：客户端、菜单、确认框、
// 图标、事件订阅全由它给，本文件不认识任何一个 IPC 通道的业务细节。
const ctx = createPanelContext({
  bridge,
  panelId: 'overview-overlay',
  compact: false,
  previewOverlay,
  host: 'page'
})

const card = document.createElement('div')
card.className = 'overview-overlay__card'

const content = createOverview(document, ctx, {
  onDismiss: requestHide,
  // 「在台上」的唯一判据：收起时是 0×0 视图，但标签 / 空间 / 会话推送照样会到 ——
  // 面板据此在收起期整条早退（判据只写一次，见 panel.js）。
  isActive: () => open
})
setPanelRefresh(content.refresh)
card.appendChild(content.element)
root.appendChild(card)

/**
 * 卡片高度：**跟着内容自动长，最长不超过「锚点到底边的距离」**。
 *
 * 不写死 height 是刻意的：四块内容（空间 / 标签 / 最近关闭 / 会话）是**异步到位**的，
 * 若按首帧（多为空列表）量一次高度再钉住，数据回来后就只能挤在一条小窗口里滚。
 * `max-height` + 内部滚动容器（`.overview-overlay__scroll` 的 flex:1 / min-height:0）
 * 这一套本来就是面板形态用的：内容少时卡片自然矮，超出时滚动区接管 —— 不需要 ResizeObserver。
 */
function fitCard() {
  if (!open) return
  const top = Number.parseFloat(card.style.top) || 0
  card.style.maxHeight = `${Math.max(220, Math.round(viewport.height - top - EDGE_PAD))}px`
}

/** 收起（走主进程的权威路径：bounds 归零 + 通知 renderer 清 DOM + 外壳复位）。 */
function requestHide() {
  open = false
  collapse()
  try { bridge.provider.send(IPC_EVENTS.overviewOverlayHide, {}) } catch (_) {}
}

function collapse() {
  card.classList.remove('overview-overlay__card--open')
}

/**
 * 上报整窗 bounds + 交互态（卡片位置由本文件按外壳给的锚点写入）。
 * 铺满整窗是「点外面收起」的前提：卡片之外的点击必须落进本视图。
 */
function display() {
  try {
    bridge.provider.send('overview-overlay:display', {
      x: 0,
      y: 0,
      width: viewport.width,
      height: viewport.height,
      interactive: true
    })
  } catch (e) {
    console.error('[overview-overlay] display failed:', e)
  }
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value))
}

/**
 * @param {{ x?: number, y?: number, viewport?: { width: number, height: number } }} payload
 *   x / y 是触发器在**窗口坐标系**里的矩形（左下角）：外壳发的 client 坐标即窗口坐标；
 *   独立视图（侧栏浮出层）的坐标由主进程在 normalizeFloatShow 里按视图偏移平移好。
 */
interface OverviewShowPayload { x?: number; y?: number; viewport?: { width: number; height: number } }

function showOverview(payload: OverviewShowPayload = {}): void {
  const p = payload || {}
  const vp = p.viewport
  viewport =
    vp && Number.isFinite(vp.width) && Number.isFinite(vp.height) && vp.width > 0 && vp.height > 0
      ? { width: Math.round(vp.width), height: Math.round(vp.height) }
      : { width: window.innerWidth, height: window.innerHeight }

  const width = Math.round(Math.min(CARD_MAX_WIDTH, Math.max(CARD_MIN_WIDTH, viewport.width - EDGE_PAD * 2)))
  const x = clamp(Math.round(Number(p.x) || EDGE_PAD), EDGE_PAD, Math.max(EDGE_PAD, viewport.width - width - EDGE_PAD))
  const y = Math.max(EDGE_PAD, Math.round(Number(p.y) || EDGE_PAD) + ANCHOR_GAP)

  card.style.width = `${width}px`
  card.style.left = `${x}px`
  card.style.top = `${y}px`

  open = true
  card.classList.add('overview-overlay__card--open')
  // 先把收起期攒下的最近一帧标签推送同步补齐（零 IPC）—— 首帧即最新；
  // 随后的 refresh 只做一次全量校正（空间 / 会话 / 撤销栈也一起对齐）。
  content.flush()
  // 先摆好位再亮出来（避免首帧在左上角闪一下），高度上限按新位置重算。
  fitCard()
  display()
  content.focusSearch()
  // 每次打开都对齐一次主进程事实（浮层常驻，订阅也在跑；这一次只是保证"打开即最新"）。
  Promise.resolve(content.refresh()).catch(() => {})
}

// ── 点卡片外面收起（Esc 另算）────────────────────────────────────────────
// 判据与「选择目标」浮层共用一份（ui-common#overlayCard），不在这里再写一套。
dismissOnOutsidePointerDown(document, {
  isOpen: () => open,
  element: card,
  onDismiss: requestHide
})

// Esc：搜索框有词先清词（视图自己处理，preventDefault 后这里不再收）；
// 没词就收起浮层。本浮层是「自己持焦」的浮层（见 LayoutCoordinator#SELF_FOCUS_FLOATS），
// 键盘焦点就在本视图里，Esc 一定收得到。
document.addEventListener('keydown', (e) => {
  if (e.key !== 'Escape' || e.defaultPrevented || !open) return
  e.preventDefault()
  requestHide()
})

bridge.on.subscribe(IPC_EVENTS.overviewOverlayShow, (p) => showOverview(p || {}))
bridge.on.subscribe(IPC_EVENTS.overviewOverlayHide, () => {
  open = false
  collapse()
})

