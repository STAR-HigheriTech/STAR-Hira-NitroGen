/**
 * break-overlay —— 专注模式（D5）的**整窗浮层**渲染页。
 *
 * ── 它为什么存在 ─────────────────────────────────────────────────────
 * 旧实现是把遮罩注入网页 preload（`infra-window/preload/break-overlay`），
 * 于是遮罩只能盖住网页内容区 —— 导航栏 / 标签条 / 侧栏照样能点，"专注"名不副实。
 * 现在它是一个**整窗大小的原生浮层视图**（见 main/break-overlay.js），
 * 覆盖窗口的每一寸像素；本文件只负责画与收集点击。
 *
 * ── 数据流（单向）────────────────────────────────────────────────────
 *   主进程 `main/break-mode.js` 是计时与阶段的**唯一真源**，每秒推一帧；
 *   本页只做"把这一帧画出来"，从不自己数秒、不改状态：
 *     break-overlay:show   → 首次出现（整份状态）
 *     break-overlay:update → 每秒刷新（同一份状态）
 *     break-overlay:hide   → 退场动画（随后主进程把浮层收起）
 *   按钮 / Esc 只回传"用户想干什么"（pause / resume / skip / stop / adjust），
 *   状态机留在主进程 —— 于是时长、阶段流转只有一份实现。
 *
 * ── 界面纪律 ─────────────────────────────────────────────────────────
 * 只有事实文案（阶段 / 剩余 / 结束时刻 / 时长），没有标语；
 * 没有玻璃拟态与渐变色，所有颜色取自主题令牌（见 index.html 头注）。
 *
 * ── 首帧纪律 ─────────────────────────────────────────────────────────
 * 页面初始 `#app { opacity: 0 }`，只有**主题拉到 + 第一帧画完**之后才揭开。
 * 否则深色主题下会先闪一眼浅色底，深色壁纸下尤其刺眼。
 */

import '@hira-ng/shared-ui-tokens/tokens-base.css'
import '@hira-ng/shared-ui-tokens/tokens-light.css'
import '@hira-ng/shared-ui-tokens/tokens-dark.css'
import { IPC_EVENTS, IPC_ROUTES } from '@hira-ng/shared-types/src/ipc-channels.mjs'
import { createThemeController } from '../shared/theme-controller.js'
import { getHiraBridge } from '../shared/bridge.js'

const bridge = getHiraBridge()
const provider = bridge.provider

// 主题：与其它外壳渲染页共用同一份控制器（浅色 / 深色 / 令牌全由主进程决定）。
const themeController = createThemeController({ document, bridge })
const themeReady = themeController.start().catch(() => {})
window.addEventListener('pagehide', () => themeController.dispose(), { once: true })

const els = {
  progress: document.getElementById('progress'),
  fill: document.getElementById('progress-fill'),
  time: document.getElementById('time'),
  meta: document.getElementById('meta'),
  message: document.getElementById('message'),
  phaseText: document.getElementById('phase-text'),
  duration: document.getElementById('duration'),
  pause: document.getElementById('pause'),
  skip: document.getElementById('skip'),
  exit: document.getElementById('exit'),
  minus: document.getElementById('minus'),
  plus: document.getElementById('plus')
}

/** 每次微调的步长（毫秒）。主进程侧还会夹上下限，这里只表达"一档"。 */
const ADJUST_STEP_MS = 60 * 1000

let lastPhase = ''
let revealed = false
/**
 * 显示代际：每次 `leave()` 递增，用来作废**在途的 reveal**。
 *
 * `onShow` 要 `await themeReady` 才揭幕；若这期间用户已经结束了专注，`leave()` 先把
 * `entered` 摘掉，await 回来再把 `entered` 加回去 —— 浮层随即被收成 0×0，而
 * `-webkit-app-region: drag` 的命中区已经随最后一帧提交到窗口上了，窗口于是永久停在
 * 「整窗都是标题栏」。代际号让迟到的 reveal 直接作废。
 */
let showEpoch = 0

interface BreakOverlayPayload {
  phase?: string
  remainingMs?: number
  totalMs?: number
  message?: string
  paused?: boolean
  open?: boolean
}

/** 毫秒 → `mm:ss`（向上取整：刚开始那一眼显示 25:00 而不是 24:59）。 */
function formatClock(ms: number) {
  const total = Math.max(0, Math.ceil(Number(ms) / 1000)) || 0
  const minutes = Math.floor(total / 60)
  const seconds = total % 60
  return `${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`
}

/** 剩余毫秒 → 结束时刻 `HH:MM`（本地时间；跨天也不加前缀，保持一行单调）。 */
function formatEndAt(ms: number) {
  const at = new Date(Date.now() + Math.max(0, Number(ms) || 0))
  return `${String(at.getHours()).padStart(2, '0')}:${String(at.getMinutes()).padStart(2, '0')}`
}

/**
 * 画一帧。
 * @param {{ phase?: string, remainingMs?: number, totalMs?: number, message?: string, paused?: boolean }} payload
 */
function paint(payload: BreakOverlayPayload) {
  const p = payload && typeof payload === 'object' ? payload : {}
  const total = Math.max(0, Number(p.totalMs) || 0)
  const remaining = Math.max(0, Number(p.remainingMs) || 0)
  const isBreak = p.phase === 'break'
  const paused = !!p.paused

  document.body.classList.toggle('is-break', isBreak)
  document.body.classList.toggle('is-paused', paused)

  if (els.time) els.time.textContent = formatClock(remaining)
  if (els.phaseText) els.phaseText.textContent = isBreak ? '休息' : '专注'
  if (els.duration) {
    const minutes = total > 0 ? Math.max(1, Math.round(total / 60000)) : 0
    els.duration.textContent = minutes > 0 ? `${minutes} 分钟` : ''
  }
  if (els.meta) els.meta.textContent = paused ? '已暂停' : `预计 ${formatEndAt(remaining)} 结束`
  if (els.message) {
    const text = typeof p.message === 'string' ? p.message.trim() : ''
    els.message.textContent = text
    els.message.hidden = text === ''
  }
  if (els.pause) els.pause.textContent = paused ? '继续' : '暂停'
  if (els.exit) els.exit.textContent = isBreak ? '结束休息' : '结束专注'

  const progress = total > 0 ? Math.max(0, Math.min(1, remaining / total)) : 0
  paintProgress(progress, p.phase !== lastPhase)
  lastPhase = p.phase || ''
}

/**
 * 进度条补间。每秒一帧、CSS 0.9s 线性过渡 → 数字跳秒而进度是连续走的。
 * 阶段切换时进度会从 0 跳回满格，那一次必须**瞬时**落位（否则会倒着扫一段）。
 */
function paintProgress(progress: number, phaseChanged: boolean) {
  if (!els.fill || !els.progress) return
  const percent = `${(progress * 100).toFixed(2)}%`
  if (phaseChanged) {
    els.progress.classList.add('no-anim')
    els.fill.style.width = percent
    requestAnimationFrame(() => els.progress && els.progress.classList.remove('no-anim'))
  } else {
    els.fill.style.width = percent
  }
  els.progress.setAttribute('aria-valuenow', String(Math.round(progress * 100)))
}

/**
 * 揭开首帧：主题已落地 + 第一帧已提交，才让整页可见。
 * @param {number} epoch 发起这次揭幕的显示代际（与当前代际不符 = 已经收起，作废）
 */
function reveal(epoch: number) {
  if (revealed || epoch !== showEpoch) return
  revealed = true
  document.body.classList.remove('leaving')
  document.body.classList.remove('booting')
  // 双 rAF：等主题写入与这一帧的布局都提交后再切透明度，避免"浅色一帧"。
  requestAnimationFrame(() => {
    if (epoch !== showEpoch) return
    requestAnimationFrame(() => {
      if (epoch !== showEpoch) return
      document.body.classList.add('entered')
    })
  })
}

function leave() {
  // 先作废在途 reveal（见 showEpoch 的说明），再摘 drag —— 顺序不能颠倒。
  showEpoch += 1
  revealed = false
  document.body.classList.remove('entered')
  document.body.classList.add('leaving')
}

async function onShow(payload: BreakOverlayPayload) {
  paint(payload)
  const epoch = ++showEpoch
  await themeReady
  reveal(epoch)
}

function onUpdate(payload: BreakOverlayPayload) {
  if (payload && payload.open === false) {
    leave()
    return
  }
  paint(payload)
  // 万一 show 丢了（浮层被回收重建 / 事件早到），update 也要能把页面拉起来；
  // 但退场中（leaving）绝不重新揭幕 —— 那会把已经摘掉的 drag 又装回去。
  if (!revealed && !document.body.classList.contains('leaving')) reveal(showEpoch)
}

function onHide() {
  leave()
}

/**
 * 回传用户意图。动作字符串的语义与状态机都在主进程（break:control），
 * 本页不解释结果 —— 下一次推送自然会反映新状态。
 * @param {'pause'|'resume'|'skip'|'stop'|'adjust'} action
 * @param {{ deltaMs?: number }} [extra]
 */
async function control(
  action: 'pause' | 'resume' | 'skip' | 'stop' | 'adjust',
  extra: { deltaMs?: number } = {}
): Promise<void> {
  try {
    await provider.invoke(IPC_ROUTES.breakControl, { action, ...(extra || {}) })
  } catch (_) {}
}

if (els.pause) {
  els.pause.addEventListener('click', () => {
    control(document.body.classList.contains('is-paused') ? 'resume' : 'pause')
  })
}
if (els.skip) els.skip.addEventListener('click', () => control('skip'))
if (els.exit) els.exit.addEventListener('click', () => control('stop'))
if (els.minus) els.minus.addEventListener('click', () => control('adjust', { deltaMs: -ADJUST_STEP_MS }))
if (els.plus) els.plus.addEventListener('click', () => control('adjust', { deltaMs: ADJUST_STEP_MS }))

window.addEventListener('keydown', (event) => {
  if (event.key !== 'Escape') return
  event.preventDefault()
  control('stop')
})

bridge.on.subscribe(IPC_EVENTS.breakOverlayShow, onShow)
bridge.on.subscribe(IPC_EVENTS.breakOverlayUpdate, onUpdate)
bridge.on.subscribe(IPC_EVENTS.breakOverlayHide, onHide)

