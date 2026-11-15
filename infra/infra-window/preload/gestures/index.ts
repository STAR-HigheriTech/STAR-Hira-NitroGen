/**
 * gestures —— 鼠标手势（D3）的**页面侧识别引擎** + 实时动作提示。
 *
 * ── 它做什么 ──────────────────────────────────────────────────────
 * 在网页上**按住右键画一个方向**（如"←"、"↓→"），识别出方向序列后上报主进程；
 * 主进程按用户配的「手势 → 命令」映射执行（后退 / 关标签 / 跑一条命令链 …）。
 *
 * ── 为什么必须在页面里做 ──────────────────────────────────────────
 * 网页是原生 `WebContentsView`：它的鼠标事件**到不了外壳 DOM**，主进程也拿不到
 * 鼠标移动（`before-input-event` 只有键盘）。唯一能看到"这一页上的右键拖动轨迹"的
 * 地方，就是跑在这一页里的 preload。
 *
 * ── 提示 UI：**边画边告诉你这一笔会触发什么** ────────────────────
 * 手势是"盲画"：只有一条轨迹线并不够 —— 用户真正要知道的是**它会执行哪个命令**。
 * 所以：
 *   · 画的过程中沿轨迹描线（描边 + 实线两层，深浅底都看得清）；
 *   · 视口正中挂一个**实时标签**：上面是当前识别到的方向序列（如 `↓→`），
 *     下面是这条序列**映射到的命令名**（"关闭当前标签"）；没配过就显"未映射"。
 *   · 松手后标签再停留一小会儿，让"我这一笔做了什么"有落点。
 *
 * ── 轨迹为什么是 SVG 而不是 canvas ──────────────────────────────
 * 原来把轨迹画在一块铺满视口的 canvas 上，有两个刚性代价：
 *   · **首帧卡**：那块 canvas 要按 dpr 放大（1920×1080 @2x ≈ **33MB** 后备存储），
 *     而它是在**第一次按下右键时**才现建的 —— 于是"新建标签 / 新跳转 / 新窗口 /
 *     刚启动"后的第一笔必然卡一下，还常常因为主线程忙而看起来"闪没"；
 *   · **每帧重**：每帧都要整屏 `clearRect` + 重描两遍，大屏高 dpr 下持续掉帧
 *     —— 就是"不跟手"。
 * 换成一条 SVG 折线后，只有两个 `<path>` 的 `d` 在变：没有后备存储、没有整屏清除，
 * 内存几乎为零、首帧也没有分配尖峰。提示层还会在**空闲时提前建好**（见 warmUp），
 * 于是第一笔手势走的完全是热路径。
 *
 * 映射表（哪个方向 → 哪个命令）是主进程的设置项，页面拿不到 —— 所以引擎在
 * **空闲时**向主进程要一次并缓存（`automation:gesture-map`），画的过程中全部在
 * 本地查表，**零 IPC**，因此是真正即时的。
 *
 * ── 两条纪律 ──────────────────────────────────────────────────────
 *  1. **只在顶层文档挂**（iframe 里再挂一份 = 一次手势上报两次、画两条线）。
 *  2. **只有真的画出手势才吃掉右键菜单**：普通右键（没位移）识别结果是空串，
 *     一概不碰 —— 右键菜单必须原样可用。识别到手势时在 `contextmenu` 的**捕获阶段**
 *     `preventDefault`，否则松手后网页/Electron 还会弹一次菜单，手势看起来就"没生效"。
 *     主进程侧另有一道抑制（见 tabEvents 的 `shouldSuppressContextMenu`），两道互为兜底。
 */

import { ipcRenderer } from 'electron'
// ⚠ 相对路径：preload 是沙箱，`@hira-ng/*` 包名会被 externalize 成运行时 require 而当场抛错
//（并拖垮整个 tab preload —— 见 address-autofill 的同款说明）。
// 只取**纯几何识别**（自动化模型其余部分是命令目录/映射，会把整张命令表拖进每页 preload）。
import { gestureFromPath } from '@hira-ng/shared-types/src/automation-gestures'
// 通道名同样走相对路径的零依赖子表（同目录层级，与上面的纯几何模块一起内联）。
import { PRELOAD_EVENTS, PRELOAD_ROUTES } from '@hira-ng/shared-types/src/ipc-channels-preload'
// 字体栈唯一真源（薄模块：常量内联，不拖主题目录进每页 preload）。
import { uiFontVar, UI_MONO_STACK } from '@hira-ng/shared-types/src/font-stack'
// 强调色：轨迹线与方向序列都跟随主题（本模块自建 shadow，需自己把变量写到宿主上）。
import { applyAccentVars, ensureAccent, subscribeAccent } from '../theme-accent.js'

/** 上报通道。 */
const ROUTE = PRELOAD_ROUTES.automationGesture
/** 取映射表（方向 → 命令名）的通道。 */
const ROUTE_MAP = PRELOAD_ROUTES.automationGestureMap
/** 手势配置热更新事件。 */
const EVENT_CONFIG = PRELOAD_EVENTS.automationGesturesConfig
/** 走完一次手势后，抑制右键菜单的时长（识别→contextmenu 是同一拍的连续事件）。 */
const SUPPRESS_MS = 800
/** 松手后标签停留时长（够看清，又不碍事）。 */
const LABEL_HOLD_MS = 620
/** 采样同一帧内合并事件时的最小位移（px）：太密的点没有信息量，白拉长 `d` 字符串。 */
const MIN_STEP = 4
/** 轨迹点上限；超了就丢最早的（分段识别只看局部位移，丢头不影响结果）。 */
const MAX_POINTS = 400

const SVG_NS = 'http://www.w3.org/2000/svg'

let tracking = false
interface GesturePoint { x: number; y: number }
interface GestureHint { action: string; label: string }
interface GestureUi {
  host: HTMLDivElement
  shadow: ShadowRoot
  svg: SVGSVGElement
  halo: SVGPathElement
  line: SVGPathElement
  chip: HTMLDivElement
  seqEl: HTMLDivElement
  labelEl: HTMLDivElement
}

let path: GesturePoint[] = []
/** 这一笔里是否见过「右键确实按着」的证据（`MouseEvent.buttons` 的右键位）。 */
let sawRightHeld = false
/** 识别到手势 → 压掉紧随其后的那一次右键菜单。 */
let suppressUntil = 0

/**
 * 方向序列 → `{ action, label }`。从主进程取一次就缓存；画的过程中只查它。
 * `null` = 还没取到（此时标签显"…"而不是错误地显"未映射"）。
 */
let gestureMap: Record<string, GestureHint> | null = null
let mapRequested = false
/**
 * 手势总开关（设置项 `automation.gestures_enabled` 的页面侧副本）。
 *
 * ⚠ 关掉时必须**在这里**就停手：不开始记录、不画轨迹、也不吞右键菜单。
 * 只让主进程丢弃上报的话，页面看起来什么都没变 —— 用户会认为开关无效。
 * 变更由 `automation:gestures-config` 事件实时推送（见下方订阅）。
 */
let gesturesEnabled = true

// ── 提示层（空闲时预建；建不起来也只是没有画面反馈，不影响识别与执行）────
let ui: GestureUi | null = null
let rafId = 0
let hideTimer: ReturnType<typeof setTimeout> | null = null
/** 主题变化订阅只挂一次（提示层重建时不重复登记）。 */
let accentBound = false

/**
 * 把主题令牌写到提示层宿主上（自定义属性会继承进 shadow），并订阅后续变化。
 * 订阅回调里读 `ui.host`，因此宿主重建后仍然指向当前那一个，不会泄漏旧订阅。
 */
function bindAccent(host: HTMLElement): void {
  try { applyAccentVars(host) } catch (_) {}
  if (accentBound) return
  accentBound = true
  subscribeAccent((vars: Record<string, string>) => {
    const target = ui && ui.host
    if (!target) return
    for (const key of Object.keys(vars)) {
      try { target.style.setProperty(key, vars[key]) } catch (_) {}
    }
  })
}

function isTopFrame(): boolean {
  try { return window.top === window } catch (_) { return false }
}

/**
 * 建提示层（**幂等**）。`ensureUi` 整个包在 try 里，失败就返回 null ——
 * 提示 UI 只是锦上添花，绝不能因为它的任何异常把"识别 + 上报"这条主链拖死
 *（调用方一律 `if (!u) return`）。这条纪律是有代价换来的：曾经这里一处
 * 变量名写错，异常从 `onMouseDown` 冒出去，整个手势看起来就"全废了"。
 */
function ensureUi(): GestureUi | null {
  try {
    if (ui && ui.host && ui.host.isConnected) return ui
    const host = document.createElement('div')
    host.setAttribute('data-hira-ui', 'gesture-trail')
    // 铺满视口但**不吃指针**；写在最上层，页面怎么改 z-index 都盖不住它。
    // 默认 `display:none`：预建时先不参与渲染，画手势那一刻再亮出来。
    host.style.cssText =
      'all:initial;position:fixed;inset:0;pointer-events:none;z-index:2147483647;display:none;'
    const shadow = host.attachShadow({ mode: 'closed' })

    // 轨迹 = 一条 SVG 折线（两层描边：宽浅色在外、窄实色在内，浅底深底都看得清）。
    // `viewBox` 跟视口等大 → 路径坐标就是 `clientX/clientY`，无需任何换算。
    const svg = document.createElementNS(SVG_NS, 'svg') as SVGSVGElement
    svg.setAttribute('preserveAspectRatio', 'none')
    svg.style.cssText = 'position:absolute;inset:0;width:100%;height:100%;display:block;'
    const halo = document.createElementNS(SVG_NS, 'path') as SVGPathElement
    const line = document.createElementNS(SVG_NS, 'path') as SVGPathElement
    const strokes: Array<[SVGPathElement, string | null, string]> = [[halo, 'rgba(255,255,255,.85)', '7'], [line, null, '3']]
    for (const [el, stroke, width] of strokes) {
      el.setAttribute('fill', 'none')
      el.setAttribute('stroke-width', width)
      el.setAttribute('stroke-linecap', 'round')
      el.setAttribute('stroke-linejoin', 'round')
      if (stroke) el.setAttribute('stroke', stroke)
      // 实线层走主题强调色（`var()` 在 SVG 呈现属性里不可靠，必须走内联 style）。
      // 变量由 `bindAccent` 写到宿主上，随主题切换自动更新。
      else el.style.stroke = 'var(--hira-accent, #4a9eff)'
      svg.appendChild(el)
    }

    const chip = document.createElement('div')
    // 标签**固定在视口正中**（不跟鼠标）：手势本身已经在用整块屏幕画，
    // 跟手的小标签会被轨迹和光标本身遮住，而且眼睛要一边追鼠标一边读字。
    // 居中后它就像 HUD 一样稳稳待着，扫一眼就知道"这一笔会干什么"。
    chip.style.cssText = 'position:absolute;left:50%;top:50%;transform:translate(-50%,-50%);display:none;' +
      `font:13px/1.4 ${uiFontVar()};color:#fff;text-align:center;` +
      'background:rgba(24,24,27,.92);border-radius:12px;padding:10px 16px;' +
      'box-shadow:0 8px 28px rgba(0,0,0,.34);white-space:nowrap;opacity:0;' +
      'transition:opacity .08s linear;'
    const seqEl = document.createElement('div')
    seqEl.style.cssText = `font:700 20px/1.2 ${UI_MONO_STACK};` +
      'color:var(--hira-accent,#7db2ff);letter-spacing:3px;'
    const labelEl = document.createElement('div')
    labelEl.style.cssText = 'margin-top:4px;font-size:13px;color:#fff;'
    chip.appendChild(seqEl)
    chip.appendChild(labelEl)

    shadow.appendChild(svg)
    shadow.appendChild(chip)
    ;(document.documentElement || document.body).appendChild(host)
    bindAccent(host)
    ui = { host, shadow, svg, halo, line, chip, seqEl, labelEl }
    syncViewBox()
    return ui
  } catch (e) {
    console.warn('[gestures] 提示层创建失败（手势功能不受影响）:', e instanceof Error ? e.message : e)
    ui = null
    return null
  }
}

/** 让 `viewBox` 跟上视口 → 路径坐标恒等于 `clientX/clientY`（窗口尺寸变了才需要）。 */
function syncViewBox(): void {
  if (!ui) return
  try {
    ui.svg.setAttribute('viewBox', `0 0 ${Math.max(1, window.innerWidth)} ${Math.max(1, window.innerHeight)}`)
  } catch (_) {}
}

/** 这一笔当前会触发什么（查本地缓存，零 IPC）。 */
function resolveAction(seq: string): { label: string; action?: string; pending?: boolean; unmapped?: boolean } | null {
  if (!seq) return null
  if (!gestureMap) return { label: '…', pending: true }
  const hit = gestureMap[seq]
  return hit ? { label: hit.label, action: hit.action } : { label: '未映射', unmapped: true }
}

/** 把轨迹拼成 SVG 的 `d`（只拼一次，两个 `<path>` 共用）。 */
function pathData(): string {
  if (path.length === 0) return ''
  let d = 'M' + path[0].x + ' ' + path[0].y
  for (let i = 1; i < path.length; i++) d += 'L' + path[i].x + ' ' + path[i].y
  return d
}

/**
 * 每帧重绘：轨迹 + 实时动作标签。
 *
 * 识别与绘制都放在 rAF 里（而不是每次 mousemove）：一帧内挪了 5 个点也只处理一次，
 * 标签因此是"跟手"的，又不会让事件回调变重。
 */
function drawTrail(): void {
  rafId = 0
  if (!ui || path.length < 2) return
  try {
    const d = pathData()
    ui.halo.setAttribute('d', d)
    ui.line.setAttribute('d', d)
    updateChip()
  } catch (_) {}
}

/** 实时标签：方向序列 + 它会触发的命令名（固定在视口正中，不跟鼠标）。 */
function updateChip(): void {
  if (!ui) return
  const seq = gestureFromPath(path)
  if (!seq) {
    // 还没形成方向（刚按下、原地微抖）：先不打扰，标签保持隐藏。
    if (!ui.chip.dataset.hold) hideChip()
    return
  }
  const resolved = resolveAction(seq)
  ui.seqEl.textContent = seq
  ui.labelEl.textContent = resolved ? resolved.label : ''
  ui.labelEl.style.color = resolved && resolved.unmapped ? 'var(--hira-danger, #f6a6a6)' : '#fff'
  ui.chip.style.display = 'block'
  ui.chip.dataset.hold = ''
  ui.chip.style.opacity = '1'
}

function scheduleDraw(): void {
  if (rafId) return
  try { rafId = window.requestAnimationFrame(drawTrail) } catch (_) { drawTrail() }
}

function showTrail(): void {
  const u = ensureUi()
  if (!u) return // 提示层建不起来就只是没有画面反馈，手势本身照常
  try {
    syncViewBox()
    u.halo.setAttribute('d', '')
    u.line.setAttribute('d', '')
    u.chip.style.opacity = '0'
    u.chip.style.display = 'none'
    u.host.style.display = 'block'
  } catch (_) {}
}

function hideChip(): void {
  if (!ui) return
  try {
    ui.chip.style.opacity = '0'
    ui.chip.style.display = 'none'
    ui.chip.dataset.hold = ''
  } catch (_) {}
}

/** 松手：有手势就亮一下（保留最后那一下的结论），没有就立刻收干净。 */
function finishTrail(gesture: string): void {
  if (!ui) return
  if (hideTimer) { clearTimeout(hideTimer); hideTimer = null }
  if (!gesture) { hideTrail(); return }
  try { ui.chip.dataset.hold = '1' } catch (_) {}
  hideTimer = setTimeout(() => { hideTimer = null; hideTrail() }, LABEL_HOLD_MS)
}

function hideTrail(): void {
  if (!ui) return
  if (hideTimer) { clearTimeout(hideTimer); hideTimer = null }
  try {
    ui.halo.setAttribute('d', '')
    ui.line.setAttribute('d', '')
    hideChip()
    ui.host.style.display = 'none'
  } catch (_) {}
}

// ── 映射表：向主进程要一次，之后全程本地查 ────────────────────────────
function fetchGestureMap(): void {
  if (mapRequested && gestureMap) return
  mapRequested = true
  try {
    ipcRenderer.invoke(`ngipc:invoke:${ROUTE_MAP}`, {})
      .then((res: unknown) => {
        const result = res && typeof res === 'object' ? res as { map?: unknown; enabled?: unknown } : null
        if (result && result.map && typeof result.map === 'object') gestureMap = result.map as Record<string, GestureHint>
        else mapRequested = false
        if (result && typeof result.enabled === 'boolean') gesturesEnabled = result.enabled
      })
      .catch(() => { mapRequested = false })
  } catch (_) { mapRequested = false }
}

/**
 * 订阅「手势配置变更」（开关 / 映射表）。
 *
 * 走的是 broadcaster 的通用事件通道：先 `ipcRenderer.on`，再向主进程登记
 * （ListenerRegistry 只投给登记过的 webContents —— 与 tab-preload 的 `on.subscribe`
 * 同一套约定，此处手写是因为不需要把回调暴露给页面）。
 *
 * 关闭开关时顺便清掉进行中的这一笔并收起提示层，避免"关掉后还留着半条轨迹"。
 */
function subscribeConfig() {
  try {
    const channel = `ngipc:event:${EVENT_CONFIG}`
    ipcRenderer.on(channel, (_e, payload) => {
      if (!payload || typeof payload !== 'object') return
      if (typeof payload.enabled === 'boolean') gesturesEnabled = payload.enabled
      if (payload.map && typeof payload.map === 'object') gestureMap = payload.map
      if (!gesturesEnabled) {
        reset()
        try { hideTrail() } catch (_) {}
      }
    })
    const listenerId = `gestures#${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`
    ipcRenderer.send(`ngipc:send:${PRELOAD_ROUTES.listenersAdd}`, { channel: EVENT_CONFIG, listenerId })
  } catch (_) {}
}

/**
 * 空闲热身：**把第一笔手势要用的东西全部提前备好**。
 *   · 映射表取回来 → 标签一开始就能显示命令名，而不是先闪一个"…"；
 *   · 提示层建好（SVG，无后备存储，成本极低）→ 第一次按下右键不必现建 DOM，
 *     首帧不再有分配尖峰。
 * 这两件事都只在**空闲**时做，页面忙的时候一次都不会插队。
 */
function warmUp() {
  fetchGestureMap()
  ensureUi()
  // 强调色提前取一次：第一笔手势亮出来时就已经是主题色，不闪蓝。
  try { ensureAccent() } catch (_) {}
}

// ── 输入 ──────────────────────────────────────────────────────────────
/**
 * `mousemove` 的挂载开关。
 *
 * 它是捕获阶段的**每帧高频事件**：常驻挂着等于给所有网页（含每个 iframe 之外的主帧）
 * 永久加一层事件穿透，而用户绝大多数时间根本没在画手势。改成「右键按下才挂、
 * 一笔结束/作废就摘」——挂载点正好是唯一需要它的时间段，首次按下的那一刻同步
 * 挂上，不会漏掉任何采样点。
 */
let moveListening = false
function listenMove(on: boolean): void {
  if (on === moveListening) return
  moveListening = on
  try {
    if (on) window.addEventListener('mousemove', onMouseMove, true)
    else window.removeEventListener('mousemove', onMouseMove, true)
  } catch (_) {}
}

/**
 * 右键按下：清掉上一笔遗留的收尾定时器 → 开始记录轨迹 → 亮出提示层。
 *
 * ⚠ 必须先清 `hideTimer`：上一笔松手后会起一个「提示多停一会儿」的定时器
 * （`LABEL_HOLD_MS`）。**连续画手势时**（后退→后退、关标签→关标签…），
 * 这一笔往往在上一笔的定时器到点前就开始 —— 那个定时器会把**正在画的这一笔**
 * 连轨迹带提示一起收掉，看起来就是「手势闪一下就没了」。
 */
function onMouseDown(event: MouseEvent): void {
  if (!event.isTrusted) return
  if (event.button !== 2) return
  // 总开关关着 → 完全不介入（不记录、不画、也不吞菜单）。
  if (!gesturesEnabled) return
  if (hideTimer) { clearTimeout(hideTimer); hideTimer = null }
  tracking = true
  sawRightHeld = false
  path = [{ x: event.clientX, y: event.clientY }]
  listenMove(true)
  fetchGestureMap()
  showTrail()
}

function onMouseMove(event: MouseEvent): void {
  if (!event.isTrusted) return
  if (!tracking) return
  // 右键已不在按着、却还没收到 mouseup（松手时指针在窗口外 / 落在 iframe 上 /
  // 被页面吞掉）→ **就地收尾**，别把这一笔整条丢掉。这是「手势偶尔完全没反应」
  // 的一类成因。
  //
  // ⚠ 只在**这一笔里见过右键按着的证据**（`sawRightHeld`）时才据此收尾：
  //   若某个环境根本不填 `buttons`（个别触摸/笔输入），一开始就恒为 0 —— 那种情况下
  //   绝不能把它当成"松手了"，否则手势会在起步瞬间被自己判死。宁可不救，不可误杀。
  if (event.buttons & 2) sawRightHeld = true
  else if (event.isTrusted && sawRightHeld) { endGesture(); return }

  // 一帧内系统可能攒了好几个点（高刷 / 高采样鼠标）：逐个收下，轨迹才贴合手的走向。
  // 只取"可信"的合并事件，免得页面用脚本伪造的点把轨迹带偏。
  let batch: MouseEvent[] | null = null
  try {
    const pointer = event as MouseEvent & { getCoalescedEvents?: () => MouseEvent[] }
    if (typeof pointer.getCoalescedEvents === 'function') batch = pointer.getCoalescedEvents()
  } catch (_) { batch = null }
  const points = batch && batch.length
    ? batch.filter((e: MouseEvent) => e.isTrusted)
    : [event]
  const samples = points.length ? points : [event]

  let added = false
  for (const p of samples) {
    const last = path[path.length - 1]
    if (last && Math.abs(p.clientX - last.x) < MIN_STEP && Math.abs(p.clientY - last.y) < MIN_STEP) continue
    path.push({ x: p.clientX, y: p.clientY })
    added = true
  }
  if (!added) return
  if (path.length > MAX_POINTS) path = path.slice(-MAX_POINTS / 2)
  scheduleDraw()
}

function reset() {
  tracking = false
  sawRightHeld = false
  path = []
  listenMove(false)
}

/**
 * 收尾一次手势：识别 → 上报 → 提示层停留一下。
 * `mouseup` 与「右键已松开」两条路共用同一份收尾逻辑（不各写一遍，免得只有一条路
 * 被修到）。
 */
function endGesture() {
  if (!tracking) return
  const points = path
  reset()
  const gesture = gestureFromPath(points)
  if (!gesture) {
    // 普通右键：不碰菜单，交给浏览器照常弹；顺手把提示层收干净。
    try { finishTrail('') } catch (_) {}
    return
  }
  // ⚠ **先上报、再收拾提示 UI**：顺序反了的话，提示层一旦抛错就把"执行动作"
  //   整条吞掉（用户看到的就是"手势全废了"）。主链永远排在装饰前面。
  suppressUntil = Date.now() + SUPPRESS_MS
  try {
    ipcRenderer.invoke(`ngipc:invoke:${ROUTE}`, { gesture }).catch(() => {})
  } catch (_) {}
  try { finishTrail(gesture) } catch (_) {}
}

function onMouseUp(event: MouseEvent): void {
  if (!event.isTrusted) return
  if (event.button !== 2) return
  endGesture()
}

/**
 * 捕获阶段压掉「这一笔右键」对应的那一次菜单。两种情况都要压：
 *  ① **正画到一半** —— 某些平台/页面在按下右键时就派发 contextmenu；不压的话
 *     菜单会当场顶掉手势，看起来就是「手势没生效」；
 *  ② **刚画完** —— 松手后 contextmenu 才到，用时间窗兜住。
 * 普通右键（没形成方向、也没刚画完手势）一概不碰 —— 菜单必须原样可用。
 */
function onContextMenu(event: MouseEvent): void {
  if (!event.isTrusted) return
  const inProgress = tracking && Boolean(gestureFromPath(path))
  if (!inProgress && Date.now() >= suppressUntil) return
  suppressUntil = 0
  try { event.preventDefault() } catch (_) {}
  try { event.stopPropagation() } catch (_) {}
}

/**
 * 窗口失焦：这一笔作废（不该把半个轨迹当手势），提示层也收起。
 *
 * ⚠ 必须判 `event.target`：`blur` **不冒泡，但会在捕获阶段**传给 window —— 于是
 * 页面里**任意元素**失焦也会打到这里。若不拦，最常见的两种误伤就都会发生：
 *   · 右键按下让页面上原本聚焦的输入框失焦（mousedown 的默认行为在监听器之后跑）；
 *   · 页面 JS 自己挪焦点。
 * 两者都会把**刚起步的手势当场作废** —— 用户看到的就是「闪一下就没了 / 没反应」。
 * 只有窗口本身失焦（target 是 window / document）才算数。
 */
function onBlur(event: FocusEvent): void {
  const target = event && event.target
  if (target && target !== window && target !== document) return
  reset()
  hideTrail()
}

try {
  if (isTopFrame()) {
    window.addEventListener('mousedown', onMouseDown, true)
    // mousemove 不在这里常驻：由 onMouseDown / reset 按「这一笔是否进行中」挂摘。
    window.addEventListener('mouseup', onMouseUp, true)
    window.addEventListener('contextmenu', onContextMenu, true)
    // 拖到窗口外松手 / 窗口失焦：这次手势作废（不该把半个轨迹当手势），提示层也收起。
    window.addEventListener('blur', onBlur, true)
    // 视口变了要让 trail 的 viewBox 跟上（否则窗口尺寸变化后轨迹会错位/拉伸）。
    window.addEventListener('resize', syncViewBox, true)
    // 配置热更新：开关 / 映射表改了就推过来（不必等下一次导航）
    subscribeConfig()
    // 空闲热身：映射表 + 提示层都提前备好 → 第一笔手势走热路径，不闪没也不卡。
    try {
      if (typeof window.requestIdleCallback === 'function') window.requestIdleCallback(warmUp, { timeout: 3000 })
      else setTimeout(warmUp, 800)
    } catch (_) { setTimeout(warmUp, 800) }
  }
} catch (_) {}
