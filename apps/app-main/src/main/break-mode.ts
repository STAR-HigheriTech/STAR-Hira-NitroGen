/**
 * break-mode —— D5「Break Mode / 番茄钟」的**主进程状态机**。
 *
 * ── 它做什么 ──────────────────────────────────────────────────────
 * 专注段（默认 25 分钟）→ 休息段（默认 5 分钟）→ 结束；期间把
 * `{ phase, remainingMs, totalMs, message, paused }` 推给**每个浏览器窗口的整窗浮层**
 * （`main/break-overlay.js`），由浮层画出来并盖住窗口的每一寸像素。
 *
 * ── 为什么状态机在主进程 ─────────────────────────────────────────
 * 时长与阶段流转是"事实"，页面只该画它。放在页面里的话，切标签 / 刷新都会重置计时，
 * 而且"25 分钟"这件事会被抄进渲染逻辑再漂移一次。
 *
 * ── 三条设计约束 ─────────────────────────────────────────────────
 *  1. **应用级单例**：专注是全局状态（多窗口不该各算各的）。所以推给**每个窗口**，
 *     而不是某一个页面 —— 否则切到另一个窗口就能绕开专注。
 *  2. **每秒重推一次**：既刷新倒计时，又顺手修好"专注期间新开了窗口 / 浮层被回收"
 *     这类空档（≤1 秒内就会收到下一帧并自行拉起）。
 *  3. **端口注入**：本模块不认识 BrowserWindow / TabManager，`push` 由 APPS 注入
 *     （与 automation 同一条纪律）。
 */

/** 设置项键（与 settings/registry.js 的声明逐字一致）。 */
const KEYS = {
  focus: 'break.focus_minutes',
  rest: 'break.break_minutes',
  message: 'break.message'
}
const DEFAULTS = { focus: 25, rest: 5 }
/** 默认**不显示任何文案**：界面上只留事实（阶段 / 剩余 / 结束时刻），不写标语。 */
const DEFAULT_MESSAGE = ''
/** 时长上限（手改设置写进 10^9 分钟会让倒计时变成一个笑话）。 */
const MAX_MINUTES = 600
/** 微调后的剩余下限（1 分钟）：再往下调已经不如直接"跳过"。 */
const MIN_MINUTES = 1

const MINUTE_MS = 60 * 1000

type BreakPhase = 'focus' | 'break'

interface BreakFrame {
  open: boolean
  phase: BreakPhase
  remainingMs: number
  totalMs: number
  message: string
  paused: boolean
}

type BreakPhaseAction = 'skip' | 'pause' | 'resume' | 'stop' | 'adjust'

interface BreakModeDeps {
  settings?: { get: (key: string) => unknown } | null
  push?: (frame: BreakFrame) => void
}

interface BreakResult { ok: boolean }

/**
 * @param {object} deps
 * @param {{ get: (k: string) => any }} deps.settings
 * @param {(payload: object) => void} deps.push 把一帧状态推给**每个窗口的整窗浮层**
 */
function createBreakMode(deps: BreakModeDeps = {}) {
  const settings = deps.settings
  const push = typeof deps.push === 'function' ? deps.push : () => {}

  let running = false
  let phase: BreakPhase = 'focus'
  let paused = false
  let remainingMs = 0
  let totalMs = 0
  let timer: ReturnType<typeof setInterval> | null = null

  function minutes(key: string, fallback: number): number {
    let raw = null
    try { raw = settings && typeof settings.get === 'function' ? settings.get(key) : null } catch (_) { raw = null }
    const value = Number(raw)
    if (!Number.isFinite(value) || value <= 0) return fallback
    return Math.min(MAX_MINUTES, Math.round(value))
  }

  function message(): string {
    let raw = null
    try { raw = settings && typeof settings.get === 'function' ? settings.get(KEYS.message) : null } catch (_) { raw = null }
    const text = typeof raw === 'string' ? raw.trim() : ''
    return text || DEFAULT_MESSAGE
  }

  function frame(open: boolean): BreakFrame {
    return { open, phase, remainingMs, totalMs, message: message(), paused }
  }
  function emit(open = true): void {
    try { push(frame(open)) } catch (_) {}
  }

  function stopTimer() {
    if (!timer) return
    try { clearInterval(timer) } catch (_) {}
    timer = null
  }

  /** 进入某一段：读当时的设置算时长（改设置下一段即生效，不必重启）。 */
  function enterPhase(next: BreakPhase): void {
    phase = next
    const mins = next === 'break' ? minutes(KEYS.rest, DEFAULTS.rest) : minutes(KEYS.focus, DEFAULTS.focus)
    totalMs = mins * MINUTE_MS
    remainingMs = totalMs
    paused = false
  }

  function tick(): void {
    if (!running) return
    if (!paused) {
      remainingMs -= 1000
      if (remainingMs <= 0) {
        if (phase === 'focus') enterPhase('break')
        else { stop(); return }
      }
    }
    // 无论暂停与否都重推：它同时承担"倒计时刷新"与"新窗口 / 被回收的浮层补画"两件事。
    emit(true)
  }

  function startTimer(): void {
    stopTimer()
    timer = setInterval(tick, 1000)
    // 别让一个计时器把进程钉住不退出（关窗后 Electron 该退就退）。
    if (timer && typeof timer.unref === 'function') timer.unref()
  }

  /** 进入专注。已在专注中则只重推一帧（幂等）。 */
  function start(): BreakResult {
    if (running) { emit(true); return { ok: true } }
    running = true
    enterPhase('focus')
    startTimer()
    emit(true)
    return { ok: true }
  }

  /** 退出专注（所有窗口的遮罩一并收起）。 */
  function stop(): BreakResult {
    running = false
    stopTimer()
    paused = false
    remainingMs = 0
    totalMs = 0
    try { push({ open: false, phase, remainingMs: 0, totalMs: 0, message: '', paused: false }) } catch (_) {}
    return { ok: true }
  }

  /** 快捷键语义：按一下进、再按一下出。 */
  function toggle(): BreakResult {
    return running ? stop() : start()
  }

  /**
   * 暂停态下的时长微调（±1 分钟一档，`deltaMs` 带符号）。
   *
   * 为什么只允许在暂停时调：运行中改剩余时间会与"正在走的这一秒"抢同一个数，
   * 用户看到的数字会在下一次 tick 立刻变回去。暂停是明确的"我在看、我要改"状态。
   * @param {unknown} deltaMs
   */
  function adjust(deltaMs: unknown): BreakResult {
    if (!running || !paused) return { ok: false }
    const delta = Math.trunc(Number(deltaMs) || 0)
    if (!delta) return { ok: false }
    const next = Math.min(
      Math.max(MIN_MINUTES * MINUTE_MS, remainingMs + delta),
      MAX_MINUTES * MINUTE_MS
    )
    const applied = next - remainingMs
    if (applied === 0) return { ok: false }
    remainingMs = next
    // 总时长跟着同一幅度走：进度条/环的"剩余比例"不会因为一次微调而整体跳一下。
    totalMs = Math.max(next, totalMs + applied)
    emit(true)
    return { ok: true }
  }

  /**
   * 整窗浮层上的按钮 / `Esc` 回传。
   * @param {'skip'|'pause'|'resume'|'stop'|'adjust'} action
   * @param {{ deltaMs?: number }} [options] 仅 `adjust` 用（带符号毫秒）
   */
  function control(action: BreakPhaseAction, options: { deltaMs?: number } = {}): BreakResult {
    if (action === 'stop') return stop()
    if (!running) return { ok: false }
    if (action === 'pause') { paused = true; emit(true); return { ok: true } }
    if (action === 'resume') { paused = false; emit(true); return { ok: true } }
    if (action === 'adjust') return adjust(options && options.deltaMs)
    if (action === 'skip') {
      // 跳过 = 立刻结束当前段：专注段跳进休息，休息段直接收工。
      if (phase === 'focus') enterPhase('break')
      else return stop()
      emit(true)
      return { ok: true }
    }
    return { ok: false }
  }

  return { start, stop, toggle, control, isRunning: () => running }
}

module.exports = { createBreakMode }
