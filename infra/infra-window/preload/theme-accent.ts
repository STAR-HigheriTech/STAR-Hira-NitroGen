/**
 * theme-accent —— **页面侧（注入式浮层）唯一**的主题强调色来源。
 *
 * ── 为什么需要它 ──────────────────────────────────────────────────
 * `preload/*-overlay`、手势轨迹、密码下拉、地址下拉这些 UI 是**注入到网页里**的：
 * 它们跑在标签页的 preload，读不到外壳那套 CSS 令牌（`tokens-*.css` 只挂在外壳与
 * 内部页的文档上）。过去每处各自硬编码蓝/紫色 —— 换主题后按钮、选中项、进度条
 * 仍是出厂蓝，与整体配色割裂。
 *
 * 于是把"取色"这件事收成一个模块：**所有注入式 UI 只从这里要颜色**，
 * 不再各自写 `rgba(74,158,255,…)`。新增浮层时接一下 `applyAccentVars()` 即可。
 *
 * ── 颜色从哪来（与外壳同一份真源）────────────────────────────────
 * 主进程 `ipc/theme.js#routes.themeTokens` 回的就是 `themeService.tokensFor(theme)`
 * —— 外壳、内部页、这里拿到的是**同一张令牌表**，不存在第二套真源。
 *   · 首帧：`ensureAccent()` 主动取一次（`theme:tokens`）；
 *   · 之后：订阅 `theme:changed` 广播（主进程只投给登记过的 webContents）。
 *
 * ── 三条纪律 ──────────────────────────────────────────────────────
 *  1. **永不抛**：所有 IPC / DOM 写入都包在 try 里。取不到色就用出厂兜底 ——
 *     一个装饰色不该拖垮手势识别或密码填充。
 *  2. **懒**：没人用的页面零 IPC（`ensureAccent` 只在首次要色 / 建浮层时触发）。
 *  3. **幂等**：重复 `ensureAccent()` 不会重复订阅、不会重复请求。
 */

import { ipcRenderer } from 'electron'
// 相对路径：preload 是沙箱，`@hira-ng/*` 包名会被 externalize 成运行时 require 而当场抛错。
import { PRELOAD_EVENTS, PRELOAD_ROUTES } from '@hira-ng/shared-types/src/ipc-channels-preload'
// 协议白名单走 shared-types 的唯一判据（与密码 / 地址填充、PWA 线索同一条）。
import { isHttpProtocol } from '@hira-ng/shared-types/src/url-protocols'
// 字体栈唯一真源：注入式浮层没有外壳样式表，字体令牌必须和颜色一起带进来
//（否则中文按系统默认回退 → 又是点阵宋体）。
import { UI_FONT_STACK } from '@hira-ng/shared-types/src/font-stack'

/** 令牌读口（值来自契约子表，不在这里手抄）。 */
const ROUTE_TOKENS = PRELOAD_ROUTES.themeTokens
/** 主题变更广播（同上）。 */
const EVENT_CHANGED = PRELOAD_EVENTS.themeChanged
const CHANNEL_TOKENS = `ngipc:invoke:${ROUTE_TOKENS}`
const CHANNEL_CHANGED = `ngipc:event:${EVENT_CHANGED}`
const CHANNEL_LISTEN_ADD = `ngipc:send:${PRELOAD_ROUTES.listenersAdd}`

/** 出厂兜底（与 tokens-base.css 的静态值同源，取不到主题时至少协调）。 */
const FALLBACK_ACCENT = '#4a9eff'
const FALLBACK_ON_ACCENT = '#ffffff'

/**
 * 要带进浮层的令牌：**只挑强调色系 + 表面/文字**。
 *
 * 刻意不带 `--hira-text-secondary` 之类 —— 那些在浮层里按各自底色重算更准；
 * 而 `--hira-text-primary` 带的是**浏览器 UI 前景**（见 theme.mjs 的说明），
 * 与"深色浮层卡片上的白字"不是一回事，所以由各浮层自己决定文字色。
 * 只有地址/密码这类**浅色页面语境**的下拉才用 `--hira-bg-surface` / `--hira-text-primary`。
 */
const TOKEN_KEYS = [
  '--hira-accent',
  '--hira-on-accent',
  '--hira-accent-soft',
  '--hira-accent-soft-strong',
  '--hira-accent-bg',
  '--hira-danger',
  '--hira-warn',
  '--hira-success',
  '--hira-bg-surface',
  '--hira-surface',
  '--hira-text-primary',
  '--hira-border-subtle',
  // 字体也属于"注入浮层必须自带"的令牌：网页文档没有外壳样式表。
  '--hira-font-ui'
]

const prefersDark = () => {
  try { return !!window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches } catch (_) { return false }
}

const state: {
  vars: Record<string, string>
  accent: string
  onAccent: string
  dark: boolean
  loaded: boolean
} = {
  /** 已取到的原始令牌（只含 TOKEN_KEYS 里实际有值的项）。 */
  vars: Object.create(null),
  accent: FALLBACK_ACCENT,
  onAccent: FALLBACK_ON_ACCENT,
  dark: prefersDark(),
  /** 是否已拿到过真实主题（用于区分"出厂兜底"与"主题真的就是这个色"）。 */
  loaded: false
}

/** 主题变化的订阅者（浮层在色变时要重刷自己的 CSS 变量）。 */
type AccentSubscriber = (vars: Record<string, string>, accent: string) => void
const subscribers = new Set<AccentSubscriber>()

/** 广播是否已挂上（只挂一次）。 */
let listenerAttached = false
/** 首次取色是否已发出（只发一次；失败也不重试 —— 广播会在下一次换主题时补上）。 */
let fetchStarted = false
/** 在途取色 Promise（重复调用复用它，不重复发 IPC）。 */
let pending: Promise<typeof state> | null = null
/** 本 preload 的 listenerId 前缀（必须跨 webContents 全局唯一，见 tab-preload 同款注释）。 */
const listenerScope = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`
let listenerSeq = 0

/**
 * 颜色 → `rgba()`。仅支持 hex（主题色归一化后就是 hex）；非 hex 交给 `color-mix()`
 * （Chromium 现代版本都支持），保证**一定有返回值**，不会写出空串。
 */
function rgba(color: unknown, alpha: unknown): string {
  const hex = String(color || '').trim()
  const m = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(hex)
  const a = Math.max(0, Math.min(1, Number(alpha)))
  if (!m) return `color-mix(in srgb, ${hex || FALLBACK_ACCENT} ${Math.round(a * 100)}%, transparent)`
  let h = m[1]
  if (h.length === 3) h = h[0] + h[0] + h[1] + h[1] + h[2] + h[2]
  const n = parseInt(h, 16)
  return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${a})`
}

/** 当前强调色的半透明版（`alpha` 0~1）—— 轨迹、hover 底、高亮框统一走它。 */
export function accentAlpha(alpha: number): string {
  return rgba(state.accent, alpha)
}

/** 当前强调色按百分比混透明（`percent` 0~100），对齐 CSS `color-mix` 的直觉。 */
export function accentMix(percent: number): string {
  return rgba(state.accent, Number(percent) / 100)
}

export function getAccent() { return state.accent }
export function getOnAccent() { return state.onAccent }
export function isDarkTheme() { return state.dark }
export function hasTheme() { return state.loaded }

/**
 * 完整的一组 CSS 变量（含派生兜底）：第一次取色还没回来时也能立刻画。
 * @returns {Record<string, string>}
 */
export function accentVars(): Record<string, string> {
  const vars = state.vars
  const accent = state.accent
  const dark = state.dark
  return {
    '--hira-accent': accent,
    '--hira-on-accent': state.onAccent,
    '--hira-accent-soft': vars['--hira-accent-soft'] || rgba(accent, dark ? 0.18 : 0.14),
    '--hira-accent-soft-strong': vars['--hira-accent-soft-strong'] || rgba(accent, dark ? 0.28 : 0.22),
    '--hira-accent-bg': vars['--hira-accent-bg'] || rgba(accent, dark ? 0.24 : 0.18),
    '--hira-danger': vars['--hira-danger'] || '#e5484d',
    '--hira-warn': vars['--hira-warn'] || '#f5a524',
    '--hira-success': vars['--hira-success'] || '#30a46c',
    '--hira-bg-surface': vars['--hira-bg-surface'] || (dark ? '#1c1c1f' : '#ffffff'),
    '--hira-surface': vars['--hira-surface'] || (dark ? '#232326' : '#ffffff'),
    '--hira-text-primary': vars['--hira-text-primary'] || (dark ? '#f2f2f5' : '#1f2328'),
    '--hira-border-subtle': vars['--hira-border-subtle'] || (dark ? 'rgba(255,255,255,.14)' : 'rgba(0,0,0,.12)'),
    '--hira-font-ui': vars['--hira-font-ui'] || UI_FONT_STACK
  }
}

/** 把整套变量写到某个元素上（shadow 内的 CSS 因此可直接 `var(--hira-accent, …)`）。 */
export function applyAccentVars(el: HTMLElement | null | undefined): Record<string, string> {
  if (!el || !el.style) return accentVars()
  ensureAccent()
  const vars = accentVars()
  for (const key of Object.keys(vars)) {
    try { el.style.setProperty(key, vars[key]) } catch (_) {}
  }
  return vars
}

/**
 * 订阅主题变化：色一变就回调（参数是最新的 `accentVars()`）。
 * 返回值是退订函数。
 */
export function subscribeAccent(fn: AccentSubscriber): () => void {
  if (typeof fn !== 'function') return () => {}
  ensureAccent()
  subscribers.add(fn)
  return () => { subscribers.delete(fn) }
}

function notify() {
  if (!subscribers.size) return
  // 每次给一份新对象：订阅方可以安全地长期持有。
  const vars = accentVars()
  for (const fn of subscribers) {
    try { fn(vars, state.accent) } catch (_) {}
  }
}

/** 令牌表 → state（只认 TOKEN_KEYS，其余一概不进浮层）。 */
function adopt(tokens: unknown, mode: unknown): void {
  if (!tokens || typeof tokens !== 'object') return
  const record = tokens as Record<string, unknown>
  const next: Record<string, string> = Object.create(null) as Record<string, string>
  for (const key of TOKEN_KEYS) {
    const value = record[key]
    if (typeof value === 'string' && value) next[key] = value
  }
  state.vars = next
  state.accent = next['--hira-accent'] || FALLBACK_ACCENT
  state.onAccent = next['--hira-on-accent'] || FALLBACK_ON_ACCENT
  if (mode === 'dark' || mode === 'light') state.dark = mode === 'dark'
  state.loaded = true
  notify()
}

/** `theme:changed` 广播载荷：`{ themeId, resolved, tokens, background }`。 */
function onThemeChanged(_event: Electron.IpcRendererEvent, payload: unknown): void {
  try {
    if (!payload || typeof payload !== 'object') return
    const record = payload as Record<string, unknown>
    adopt(record.tokens, record.resolved || record.preference)
  } catch (_) {}
}

/**
 * 保证已经连上主题链路（**幂等**）：
 *   ① 先挂广播监听并登记 —— 避免"取色在途时正好切主题"丢掉那一次变化；
 *   ② 再主动取一次当前令牌（新开页面没有历史广播可收）。
 */
export function ensureAccent() {
  attachListener()
  return fetchTokens()
}

/** 挂广播（只挂一次）：登记后主进程才会把 `theme:changed` 投给本 webContents。 */
function attachListener() {
  if (listenerAttached) return
  listenerAttached = true
  try { ipcRenderer.on(CHANNEL_CHANGED, onThemeChanged) } catch (_) {}
  try {
    const listenerId = `${listenerScope}#accent${++listenerSeq}`
    ipcRenderer.send(CHANNEL_LISTEN_ADD, { channel: EVENT_CHANGED, listenerId })
  } catch (_) {}
}

/** 主动取一次令牌（只发一次；在途时复用同一个 Promise）。 */
function fetchTokens() {
  if (fetchStarted) return pending || Promise.resolve(state)
  fetchStarted = true
  pending = Promise.resolve()
    .then(() => ipcRenderer.invoke(CHANNEL_TOKENS, {}))
    .then((res) => {
      if (res) adopt(res.tokens, res.mode)
      return state
    })
    .catch(() => state)
    .then((s) => { pending = null; return s })
  return pending
}

// ── 自启动 ────────────────────────────────────────────────────────────
// 只做"挂上广播链路"，**不**发取色请求（首次取色仍由真正要色的一方触发）。
// 这样 `theme:changed` 从页面加载起就能收到，浮层建好时已是热状态。
try {
  const proto = (() => { try { return String(window.location.protocol || '') } catch (_) { return '' } })()
  // 只有真实网页需要注入式 UI；其余协议（hira:// 内部页、hira-game://）有自己的样式体系。
  if (isHttpProtocol(proto)) attachListener()
} catch (_) {}
