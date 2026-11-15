/**
 * QuitController —— 退出状态机（对齐 HiraRT `quit-controller`）
 *
 * ── 为什么需要它（根因）────────────────────────────────────
 * 旧实现把退出逻辑散成多个 `app.on('before-quit')` 匿名处理器：谁在什么时序
 * 跑了什么、跑没跑完、异步落盘结没结束，全都没有显式状态。后果有二：
 *   1. 一旦某个处理器里有异步写盘，`app.quit()` 可能在写盘完成前把进程拆掉 → 退出丢数据；
 *   2. 反之若处理器抛错，又没有兜底把状态复位，进程会卡在「永远退不掉」。
 * 这与此前「无窗口僵尸进程 + Chromium 文件锁争抢 → 整个窗口卡顿」的根因链同源：
 * 退出时序不可控。
 *
 * RT 的做法是把退出收敛成一个显式状态机（idle → running → completed）：
 *   - `before-quit` 一律先 `preventDefault()`，把退出权攥在自己手里；
 *   - 首次进入（idle）时执行所有落盘回调，完成后置 completed 再 `app.quit()`；
 *   - 第二次 `before-quit`（completed）直接放行，Electron 正常退出。
 *
 * 本模块对齐之，并做两点加固：
 *   1. **回调抛错不吞**：记录后仍置 completed 并退出，杜绝「退不掉」；
 *   2. **可取消**：回调显式返回 `false` → 复位 idle，本次退出作废。
 *
 * 本类刻意与任何领域无关：只认 `onBeforeQuit` 回调，落盘内容由 APPS 注入
 * （settings/session/bookmark/扩展 relay …），保持插件化与彻底解耦。
 */

/**
 */
import type { App, Event } from 'electron'

type QuitState = 'idle' | 'running' | 'completed'
const QUIT_CALLBACK_TIMEOUT_MS = 10_000

interface QuitLogger {
  error?(message: string, error: unknown): void
  info?(message: string): void
}

interface QuitControllerOptions {
  onBeforeQuit?: () => boolean | void | Promise<boolean | void>
  canQuit?: () => boolean
  app?: App
  logger?: QuitLogger
}

export interface QuitController {
  register(): () => void
  readonly isQuitting: boolean
  getState(): QuitState
  cancelQuit(): void
}

export function createQuitController({
  onBeforeQuit,
  canQuit,
  app: injectedApp,
  logger
}: QuitControllerOptions = {}): QuitController {
  const app = injectedApp || require('electron').app
  const log = logger || console

  /** @type {'idle' | 'running' | 'completed'} */
  let state: QuitState = 'idle'

  function canProceed() {
    try {
      return typeof canQuit === 'function' ? canQuit() !== false : true
    } catch (e) {
      log.error && log.error('[quit] canQuit threw:', e)
      return true
    }
  }

  /** 执行落盘回调，返回是否允许退出（false = 取消本次退出）。 */
  async function runBeforeQuit() {
    if (typeof onBeforeQuit !== 'function') return true
    let timer: ReturnType<typeof setTimeout> | null = null
    try {
      const work = Promise.resolve()
        .then(() => onBeforeQuit())
        .then((result) => result !== false)
      const timeout = new Promise<boolean>((resolve) => {
        timer = setTimeout(() => {
          log.error && log.error('[quit] shutdown callback timed out; forcing progress', null)
          resolve(true)
        }, QUIT_CALLBACK_TIMEOUT_MS)
      })
      return await Promise.race([work, timeout])
    } finally {
      if (timer) clearTimeout(timer)
    }
  }

  /** @param {Electron.Event} event */
  function handleBeforeQuit(event: Event): void {
    if (state === 'completed') return // 放行：Electron 正常退出
    if (event && typeof event.preventDefault === 'function') event.preventDefault()
    // running 中重入 / 不允许退出 → 保持阻止，等待首次回调结束
    if (state !== 'idle' || !canProceed()) return

    state = 'running'
    runBeforeQuit()
      .then((allowed) => {
        if (!allowed) { state = 'idle'; return } // 显式取消
        state = 'completed'
        app.quit()
      })
      .catch((error: unknown) => {
        // 加固：回调抛错也退出，避免进程永远退不掉
        log.error && log.error('[quit] before-quit handler failed:', error)
        state = 'completed'
        app.quit()
      })
  }

  /** 挂载 `before-quit` 状态机；返回解绑函数。 */
  function register() {
    app.on('before-quit', handleBeforeQuit)
    return () => {
      try { app.removeListener('before-quit', handleBeforeQuit) } catch (_) {}
    }
  }

  return {
    register,
    /** 是否处于退出流程中（idle 之外的任何状态）。 */
    get isQuitting() { return state !== 'idle' },
    getState: () => state,
    cancelQuit: () => { state = 'idle' }
  }
}
