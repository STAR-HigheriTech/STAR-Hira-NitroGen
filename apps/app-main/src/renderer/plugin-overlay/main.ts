/**
 * 插件浮层宿主（renderer/plugin-overlay）—— PART18「开放世界」里浮层的**唯一渲染点**。
 *
 * ══════════════════════════════════════════════════════════════════════
 * 数据流（为什么这里是"快照"而不是"增量"）
 * ══════════════════════════════════════════════════════════════════════
 *   插件 → 主进程 `plugin-overlays.js`（按窗口分桶的权威表）
 *     → 增量事件 `plugin:overlay-show` / `plugin:overlay-hide`
 *       → 外壳（app-shell/main.js）合成**整份快照**
 *         → `plugin-overlay:show { items }`（本文件）
 *
 * 主进程与外壳各持有一步状态，但没有第二套"合并规则"：外壳只把权威表的全量
 * 快照推下来，本文件只做「按 key 对账 DOM」。少一层增量合并，就少一处能错的地方。
 *
 * 内容一律是**插件自己的页面**（`contributes.pages` 产出的 `hira://…`，或插件直接
 * 给的 https 地址），本文件只画容器（标题 / 关闭 / 尺寸 / 落位）。
 * 插件页面跑在 `sandbox` iframe 里 —— 与面板 UI 面同一条安全边界：
 * 碰不到外壳 DOM、拿不到 preload 的 `window.hira`。
 */

import '@hira-ng/shared-ui-tokens/tokens-base.css'
import '@hira-ng/shared-ui-tokens/tokens-light.css'
import '@hira-ng/shared-ui-tokens/tokens-dark.css'
import { createThemeController } from '../shared/theme-controller.js'
import { getHiraBridge } from '../shared/bridge.js'
import { IPC_ROUTES } from '@hira-ng/shared-types/src/ipc-channels.mjs'
import { PANEL_UI_SANDBOX } from '@hira-ng/shared-types/src/plugin-ui.mjs'
import { isPluginOverlayRecord, type PluginOverlayRecord, type PluginOverlaySnapshot } from '@hira-ng/shared-types/src/plugin-overlay.mjs'
import { resolveOverlayScope } from '../shared/overlay-scope.js'

/** 浮层名（= renderer 目录名 = `FLOAT_NAMES` 里那一条，三处逐字一致）。 */
const OVERLAY_NAME = 'plugin-overlay'

/** 未声明尺寸时的默认卡片（与 `plugin-overlays.js` 的注释同一口径）。 */
const DEFAULT_WIDTH = 420
const DEFAULT_HEIGHT = 320
/** 卡片宽度 / 高度的硬边界：再小看不清、再大就整屏都是插件的了。 */
const MIN_WIDTH = 160
const MIN_HEIGHT = 80
const MAX_WIDTH = 960
const MAX_HEIGHT = 720
/** 贴内容区四边时的留白。 */
const EDGE_MARGIN = 16

const bridge = getHiraBridge()
const scope = resolveOverlayScope(OVERLAY_NAME, bridge.provider)
const themeController = createThemeController({ document, bridge })
themeController.start()

const root = (() => {
  const element = document.getElementById('root')
  if (!element) throw new Error('Plugin overlay root is unavailable')
  return element
})()
root.style.cssText = [
  'position:fixed',
  'top:0',
  'left:0',
  'display:none',
  'flex-direction:column',
  'gap:10px',
  'padding:12px',
  'box-sizing:border-box'
].join(';')

/**
 * key → 已挂载的卡片。按 key 对账（而不是每次清空重建）：
 * 只改标题 / 尺寸时不该重载 iframe —— 那会把插件页面里正在编辑的内容清掉。
 * @type {Map<string, { el: HTMLElement, iframe: HTMLIFrameElement, title: HTMLElement, url: string, width: number, height: number }>}
 */
interface PluginOverlayCard {
  el: HTMLElement
  iframe: HTMLIFrameElement
  title: HTMLElement
  header: HTMLElement
  url: string
  width: number
  height: number
}

const cards = new Map<string, PluginOverlayCard>()
/** 当前快照里第一条记录的锚点（整叠卡片共用同一个落位）。 */
let currentAnchor = 'center'
/** 上一次发出的 display 载荷签名（尺寸没变就不重复跨进程）。 */
let lastDisplaySignature = ''

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value))
}

/**
 * 锚点字符串 → display 载荷里的落位描述。
 *
 * `plugin-overlays.js` 只承诺一个字符串（`center` / `top-left` / …），几何由主进程
 * 的 `anchorFloatInContent` 夹进网页矩形 —— 渲染层不自己算坐标（量不到原生视图位置）。
 * @param {string} anchor
 */
function placementOf(anchor: string) {
  const a = String(anchor || 'center').toLowerCase()
  if (a === 'center' || a === '') return { center: true }
  const vertical = a.startsWith('top') ? 'top' : a.startsWith('bottom') ? 'bottom' : 'center'
  const horizontal = a.endsWith('left') ? 'left' : a.endsWith('right') ? 'right' : 'center'
  if (vertical === 'center' && horizontal === 'center') return { center: true }
  return {
    position: 'in-content',
    align: horizontal,
    valign: vertical,
    margin: EDGE_MARGIN
  }
}

/** 量整叠卡片的实际外框，交给主进程落位。 */
function syncDisplay() {
  if (disposed) return
  if (!root.childElementCount) return
  const width = Math.ceil(root.offsetWidth)
  const height = Math.ceil(root.offsetHeight)
  if (width <= 0 || height <= 0) return
  const payload = { width, height, interactive: true, ...placementOf(currentAnchor) }
  const signature = JSON.stringify(payload)
  if (signature === lastDisplaySignature) return
  lastDisplaySignature = signature
  scope.display(payload)
}

/** 尺寸变化（iframe 撑开 / 主题字体变化）也要重新落位。 */
function requestSyncDisplay() {
  requestAnimationFrame(() => {
    syncDisplay()
    // 第二帧：iframe 首帧布局落定后尺寸才稳定（只测一次会得到 0 或旧值）。
    requestAnimationFrame(syncDisplay)
  })
}

/**
 * 建一张卡片。iframe 直接 `src` 到插件页面 —— 不做 srcdoc 重写：
 * 插件页面是真实 URL（`hira://host/...`），相对路径与它自己的脚本都按原样工作；
 * 安全边界由 sandbox 属性承担（不交出父页面的任何对象）。
 * @param {unknown} record
 */
function createCard(record: PluginOverlayRecord): PluginOverlayCard {
  const el = document.createElement('div')
  el.className = 'plugin-overlay-card'
  el.dataset.overlayKey = record.key
  el.style.cssText = [
    'display:flex',
    'flex-direction:column',
    'border-radius:var(--hira-theme-radius,10px)',
    'border:1px solid var(--hira-border-subtle,rgba(0,0,0,.12))',
    'background:var(--hira-bg-elevated,#fff)',
    'box-shadow:0 12px 32px -12px rgba(0,0,0,.35)',
    'overflow:hidden',
    'pointer-events:auto'
  ].join(';')

  const header = document.createElement('div')
  header.style.cssText = 'display:flex;align-items:center;gap:8px;padding:7px 10px;flex:0 0 auto;'
  el.appendChild(header)

  const title = document.createElement('span')
  title.style.cssText = 'flex:1 1 auto;min-width:0;font-size:12px;font-weight:500;color:var(--hira-text-primary,#1a1a1a);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;'
  header.appendChild(title)

  const close = document.createElement('button')
  close.type = 'button'
  close.title = '关闭'
  close.setAttribute('aria-label', '关闭')
  close.textContent = '×'
  close.style.cssText = 'flex:0 0 auto;width:20px;height:20px;border:0;border-radius:var(--hira-radius-2xs,4px);background:transparent;color:var(--hira-text-secondary,#6b7280);font-size:15px;line-height:1;cursor:pointer;'
  close.addEventListener('mouseenter', () => { close.style.background = 'var(--hira-hover-bg,rgba(0,0,0,.06))' })
  close.addEventListener('mouseleave', () => { close.style.background = 'transparent' })
  close.addEventListener('click', () => {
    bridge.provider.invoke(IPC_ROUTES.pluginsOverlayClose, { key: String(record.key) }).catch((e) => {
      console.error('[plugin-overlay] close failed:', e)
    })
  })
  header.appendChild(close)

  const iframe = document.createElement('iframe')
  iframe.setAttribute('referrerpolicy', 'no-referrer')
  // 这里显式带 `allow-same-origin`，与面板 UI 面（srcdoc）刻意不同：
  //   · 面板 UI 是**源码重写**成 srcdoc，带上它就会继承外壳的源 —— 绝对不行；
  //   · 浮层是**按真实 URL 加载**的独立文档（`hira://host/…` 或 https），它的源本来
  //     就与外壳不同，保留自身源才能让 `<script type="module">` / fetch 正常工作。
  //   · 仍不给 allow-top-navigation / allow-popups / allow-modals：浮层不能劫持外壳、不能弹窗。
  iframe.setAttribute('sandbox', `${PANEL_UI_SANDBOX} allow-same-origin`)
  iframe.setAttribute('allow', '')
  iframe.title = String(record.title || record.id || 'plugin overlay')
  iframe.style.cssText = 'border:0;display:block;width:100%;background:transparent;'
  el.appendChild(iframe)

  return { el, iframe, title, url: '', width: 0, height: 0, header }
}

/** 把一条记录应用到它的卡片上（只改真正变了的字段）。 */
function applyRecord(card: PluginOverlayCard, record: PluginOverlayRecord): void {
  const width = clamp(Number(record.width) || DEFAULT_WIDTH, MIN_WIDTH, MAX_WIDTH)
  const height = clamp(Number(record.height) || DEFAULT_HEIGHT, MIN_HEIGHT, MAX_HEIGHT)
  card.el.style.width = `${width}px`
  if (card.width !== width || card.height !== height) {
    card.width = width
    card.height = height
    card.iframe.style.height = `${height}px`
  }
  const title = String(record.title || record.id || '')
  if (card.title.textContent !== title) card.title.textContent = title
  // 标题为空时不摆一条空白标题栏（省下 30px 高度给内容）。
  card.header.style.display = title ? 'flex' : 'none'
  const url = String(record.url || '')
  if (url && url !== card.url) {
    card.url = url
    card.iframe.src = url
  }
}

/**
 * 应用一份快照。
 * @param {unknown[]} items
 */
function renderSnapshot(items: unknown): void {
  const list = (Array.isArray(items) ? items : []).filter(isPluginOverlayRecord)
  if (!list.length) {
    clearAll()
    return
  }
  currentAnchor = String(list[0].anchor || 'center')
  const seen = new Set()
  for (const record of list) {
    const key = String(record.key)
    seen.add(key)
    let card = cards.get(key)
    if (!card) {
      card = createCard(record)
      cards.set(key, card)
      root.appendChild(card.el)
    }
    applyRecord(card, record)
  }
  for (const [key, card] of Array.from(cards.entries())) {
    if (seen.has(key)) continue
    card.el.remove()
    cards.delete(key)
  }
  root.style.display = 'inline-flex'
  requestSyncDisplay()
}

/** 收起整叠（主进程已经决定隐藏，这里只清 DOM，不再回调 `scope.hide()` 造成回环）。 */
function clearAll() {
  for (const card of cards.values()) card.el.remove()
  cards.clear()
  root.style.display = 'none'
  lastDisplaySignature = ''
}

let disposed = false
function dispose() {
  if (disposed) return
  disposed = true
  clearAll()
  themeController.dispose()
}
window.addEventListener('pagehide', dispose, { once: true })

// 事件路由名 = 浮层名 + 动作（与 tabpreview-overlay 等所有浮层同一约定）。
const offShow = bridge.on.subscribe<PluginOverlaySnapshot>(`${OVERLAY_NAME}:show`, (payload) => {
  if (disposed) return
  renderSnapshot(payload?.items)
})
const offHide = bridge.on.subscribe(`${OVERLAY_NAME}:hide`, () => {
  if (disposed) return
  clearAll()
})

// 尺寸变化（窗口缩放 / 插件页面自身撑高）时重新落位。
try {
  const observer = new ResizeObserver(() => requestSyncDisplay())
  observer.observe(root)
} catch (_) {}

scope.ready()
window.addEventListener('pagehide', () => {
  try { offShow() } catch (_) {}
  try { offHide() } catch (_) {}
}, { once: true })


