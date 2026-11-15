/**
 * spatial-nav —— 空间导航（N9）的**页面侧引擎**。
 *
 * ── 它做什么 ──────────────────────────────────────────────────────
 * 开启后，方向键不再滚页面，而是在**可点击元素之间按几何位置跳焦点**：
 * 按 ↓ 就落到当前元素正下方最近的那个链接/按钮（判据见纯层
 * `shared-types/spatial-nav.mjs`）。Tab 键只能按 DOM 顺序走，跨不到"正下方"。
 *
 * ── 为什么在 preload 里 ───────────────────────────────────────────
 * 要量元素的 `getBoundingClientRect` 并移动真实焦点 —— 只有跑在这一页里的脚本能做。
 *
 * ── 三条纪律（缺一条就会变成"网页方向键坏了"的重大回归）────────────
 *  1. **默认关**：开关是设置项 `input.spatial_navigation`（出厂 false）。不开时本模块
 *     一行都不介入，方向键照旧滚页面。
 *  2. **有修饰键就放行**：Shift/Ctrl/Alt/Meta 任一按下 → 不接管（Shift+方向 = 选择文本、
 *     Ctrl+方向 = 翻页等系统语义必须原样保留）。
 *  3. **焦点在可编辑元素里就放行**：输入框/文本域/下拉/contenteditable 里的方向键是
 *     光标移动，绝不能抢。
 * 另外"没找到目标"时也放行 —— 让那一按回落到页面滚动，而不是被我们吞掉。
 */

import { ipcRenderer } from 'electron'
// ⚠ 相对路径：preload 是沙箱，`@hira-ng/*` 包名会被 externalize 成运行时 require 而当场抛错。
import { pickSpatialTarget, directionOfKey } from '@hira-ng/shared-types/src/spatial-nav'
import { PRELOAD_EVENTS, PRELOAD_ROUTES } from '@hira-ng/shared-types/src/ipc-channels-preload'

/** 读设置（一次性拉取 + 变更广播，两条线互为兜底）。 */
const ROUTE_SETTINGS_GET = PRELOAD_ROUTES.settingsGet
const SETTING_KEY = 'input.spatial_navigation'
/** 开关广播通道。 */
const EVENT_CHANNEL = `ngipc:event:${PRELOAD_EVENTS.spatialNav}`

/** 候选可点击元素。与"浏览器认为可以聚焦"的口径基本一致，外加显式 role。 */
const CANDIDATE_SELECTOR = [
  'a[href]',
  'button',
  'input:not([type="hidden"])',
  'select',
  'textarea',
  '[tabindex]',
  '[role="button"]',
  '[role="link"]'
].join(',')

/** 一次按键最多考察的候选数：广告/列表页动辄上千个链接，全量算几何会把这一按卡住。 */
const MAX_CANDIDATES = 600

let enabled = false

interface SpatialRect { x: number; y: number; w: number; h: number }
interface SpatialCandidate { node: HTMLElement; rect: SpatialRect }
type SpatialDirection = 'left' | 'right' | 'up' | 'down'

function isTopFrame(): boolean {
  try { return window.top === window } catch (_) { return false }
}

/** 非文本型 input（勾选/单选/按钮/滑块…）不算"可编辑"，方向键仍应做空间导航。 */
const NON_TEXT_INPUT_TYPES = new Set([
  'checkbox', 'radio', 'button', 'submit', 'reset', 'file', 'image', 'range', 'color'
])

function isEditable(node: Node | null | undefined): boolean {
  if (!node || node.nodeType !== 1) return false
  const element = node as HTMLElement
  const tag = String(element.tagName || '').toLowerCase()
  if (tag === 'input') return !NON_TEXT_INPUT_TYPES.has(String((element as HTMLInputElement).type || 'text').toLowerCase())
  if (tag === 'textarea' || tag === 'select') return true
  return element.isContentEditable === true
}

/** 元素当前是否真的可见（`checkVisibility` 是 Chromium 的原生实现，比读计算样式便宜得多）。 */
function isVisible(node: HTMLElement, rect: SpatialRect): boolean {
  if (rect.w <= 0 || rect.h <= 0) return false
  try {
    if (typeof node.checkVisibility === 'function') {
      return node.checkVisibility({ checkVisibilityCSS: true, checkOpacity: false })
    }
  } catch (_) {}
  return true
}

/** 收集候选（带视口矩形），顺带排除自己与不可交互的。 */
function collectCandidates(active: Element | null): SpatialCandidate[] {
  let nodes: NodeListOf<Element>
  try { nodes = document.querySelectorAll(CANDIDATE_SELECTOR) } catch (_) { return [] }
  const out: SpatialCandidate[] = []
  const limit = Math.min(nodes.length, MAX_CANDIDATES)
  for (let i = 0; i < limit; i++) {
    const node = nodes[i] as HTMLElement
    if (node === active) continue
    if ((node as HTMLElement & { disabled?: boolean }).disabled) continue
    // `tabindex="-1"` = 只能被脚本聚焦，不属于"用户能用键盘走到"的元素。
    if (node.getAttribute && node.getAttribute('tabindex') === '-1') continue
    let r
    try { r = node.getBoundingClientRect() } catch (_) { continue }
    const rect = { x: r.left, y: r.top, w: r.width, h: r.height }
    if (!isVisible(node, rect)) continue
    out.push({ node, rect })
  }
  return out
}

/**
 * 朝 `dir` 移动一次焦点。
 * @returns {boolean} 真移动了才返回 true（false = 放行给页面滚动）
 */
function moveFocus(dir: SpatialDirection): boolean {
  let active: Element | null = null
  try { active = document.activeElement } catch (_) {}
  const isBody = !active || active === document.body || active === document.documentElement
  const currentRect = isBody
    ? null
    : (() => {
        try {
          if (!active) return null
          const r = active.getBoundingClientRect()
          return { x: r.left, y: r.top, w: r.width, h: r.height }
        } catch (_) { return null }
      })()

  const candidates = collectCandidates(active)
  if (candidates.length === 0) return false
  const index = pickSpatialTarget(
    candidates.map((c) => c.rect),
    currentRect,
    dir,
    { w: window.innerWidth, h: window.innerHeight }
  )
  if (index < 0) return false

  const target = candidates[index].node
  try {
    target.focus({ preventScroll: true })
  } catch (_) {
    try { target.focus() } catch (_) { return false }
  }
  // 焦点移出视口就没意义了 —— 滚到"最近能看见"为止（不居中对齐，避免页面猛跳）。
  try { target.scrollIntoView({ block: 'nearest', inline: 'nearest' }) } catch (_) {}
  return true
}

function onKeyDown(event: KeyboardEvent): void {
  if (!enabled) return
  if (event.isTrusted === false) return
  if (event.defaultPrevented) return
  if (event.ctrlKey || event.altKey || event.metaKey || event.shiftKey) return
  const dir = directionOfKey(event.key)
  if (!dir) return
  try { if (isEditable(document.activeElement)) return } catch (_) {}
  if (!moveFocus(dir)) return
  event.preventDefault()
  event.stopPropagation()
}

/**
 * 拉一次开关值。
 * `settings:get` 的返回形态有两种（`{ value }` 或裸值），两种都接住 ——
 * 页面侧不认识设置域的内部形状。
 */
function refreshEnabled() {
  try {
    ipcRenderer.invoke(`ngipc:invoke:${ROUTE_SETTINGS_GET}`, { key: SETTING_KEY })
      .then((res) => {
        const value = res && typeof res === 'object' && 'value' in res
          ? (res as { value?: unknown }).value
          : res
        enabled = Boolean(value)
      })
      .catch(() => {})
  } catch (_) {}
}

try {
  if (isTopFrame()) {
    window.addEventListener('keydown', onKeyDown, true)
    // 设置变更：主进程广播（见 main/spatial-nav.js），改了立刻生效，不用重进页面。
    try {
      ipcRenderer.on(EVENT_CHANNEL, (_event, payload: unknown) => {
        enabled = Boolean(payload && typeof payload === 'object' && 'enabled' in payload && (payload as { enabled?: unknown }).enabled)
      })
    } catch (_) {}
    // 进页面时先自己拉一次（广播只在"变更"时来，加载那一刻的值得自己问）。
    try {
      if (typeof window.requestIdleCallback === 'function') window.requestIdleCallback(refreshEnabled, { timeout: 2000 })
      else setTimeout(refreshEnabled, 300)
    } catch (_) { setTimeout(refreshEnabled, 300) }
  }
} catch (_) {}
