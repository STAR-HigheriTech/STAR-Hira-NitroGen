/**
 * 页面**冻结 / 解冻** —— 视图收起后把它从 CPU 上摘下来（但内存与全部状态都留着）。
 *
 * 「隐藏」与「冻结」不是一回事，别混：
 *   · 隐藏（`view.setVisible(false)`）—— Chromium 把页面标成 hidden：**节流**定时器
 *     （约 1 次/秒）、停掉渲染合成，但任务照样在跑；
 *   · 冻结（Page Lifecycle 的 `frozen` 态）—— **完全停止**任务执行：定时器不再触发、
 *     微任务不再调度；而 DOM / JS 堆 / 会话 / 滚动位置**全都留着**。
 *
 * 所以"关掉但不销毁"的视图（侧栏）该走冻结 —— 省掉后台开销，重开时原样回来
 *（不必重新加载）。要省**内存**只能销毁，那是另一条路（见侧栏关闭 5 分钟后的回收）。
 *
 * ⚠ **面板不走这里**：面板是「关闭即卸载」，每次收起后紧跟的必然是销毁或立刻重新显示，
 * 冻结只会在"马上要拆的进程"上白付一次 CDP attach（还可能与重新显示赛跑，把页面
 * 冻在 frozen 态）。见 LayoutCoordinator#_hidePanelView 的说明。
 *
 * 为什么走 CDP：Electron 没有原生 freeze API；`setBackgroundThrottling` 只是"节流"，
 * 而且默认就开着 —— 它起不到冻结的作用。
 *
 * ⚠ 一个 webContents 同时只能被一个调试器占用：**DevTools 打开时 `attach` 会失败**。
 * 那种情况一律**静默跳过**（开发期本来不需要省这点电），不报错、不影响任何功能 ——
 * 于是"冻结"是**尽力而为**的优化，绝不是功能依赖，调用方不该据此改变行为。
 *
 * ⚠ **只动自己冻的那一份**：本模块用 `owned` 记下"哪些 webContents 是**我们** attach 的"。
 * 解冻时若它不在册（调试器被别人占着、我们从没冻过），一律**不碰** —— 否则会把别人的
 * 调试器 detach 掉。多个视图共用这一份实现时，这条守卫是它们能安全共存的前提。
 */

/** 本模块 attach 过调试器的 webContents —— 只认自己冻的那些（弱引用，随对象回收）。 */
import type { WebContents } from 'electron'

const owned = new WeakSet<WebContents>()

/** webContents 是否可用（空 / 已销毁 → false）。 */
function isAlive(wc: WebContents | null | undefined): wc is WebContents {
  return !!wc && typeof wc.isDestroyed === 'function' && !wc.isDestroyed()
    && wc.debugger && typeof wc.debugger.isAttached === 'function'
}

/**
 * 发一条 CDP 命令并**吞掉它的 Promise**。
 *
 * `sendCommand` 返回 Promise，失败时**异步 reject** —— 只用 try/catch 是接不住的，
 * 它会变成一条 unhandledrejection（被 app 的全局兜底报出来，纯噪音）。冻结是尽力而为，
 * 失败与否都不改变行为，所以这里一律静默。
 */
function sendSilently(wc: WebContents, method: string, params?: Record<string, unknown>): boolean {
  try {
    const p = wc.debugger.sendCommand(method, params)
    if (p && typeof p.catch === 'function') p.catch(() => {})
    return true
  } catch (_) {
    return false
  }
}

/**
 * 冻结（幂等：已冻结再调一次是无害的重复命令）。
 *
 * @param {any} wc webContents（空 / 已销毁 → 返回 false）
 * @returns {boolean} 是否确实进入了冻结态
 */
export function freezeWebContents(wc: WebContents | null | undefined): boolean {
  if (!isAlive(wc)) return false
  try {
    if (!wc.debugger.isAttached()) {
      wc.debugger.attach('1.3')
      // 记账只发生在**我们** attach 成功之后：被 DevTools 占着的那份永远进不了册，
      // 于是 thaw 也不会去动它（见文件头第二条 ⚠）。
      // 弱引用：webContents 被销毁后这一条自然消失，不必挂 destroyed 监听去清理
      // （那种监听会在反复开关中越积越多，撞上 MaxListeners 警告）。
      owned.add(wc)
    } else if (!owned.has(wc)) {
      return false
    }
    // ⚠ Chromium 只允许**不可见**的页面进入 frozen —— 调用方必须先把视图隐藏再调这里。
    return sendSilently(wc, 'Page.setWebLifecycleState', { state: 'frozen' })
  } catch (_) {
    return false
  }
}

/**
 * 解冻（幂等：没冻过就是 no-op，返回 false）。
 *
 * ⚠ 顺序不能反：必须**先**回到 active，**再** detach。先 detach 的话那条 active 命令
 * 还没送到渲染进程就被掐断了，页面会一直停在 frozen 上 —— 之后即使可见也不再恢复
 *（表现为"网页不动了"）。所以 detach 挂在命令的 Promise 上（回执到了才 detach）。
 *
 * @param {any} wc
 * @returns {boolean} 是否确实发起了解冻（命令是异步的，这里只表示"已受理"）
 */
export function thawWebContents(wc: WebContents | null | undefined): boolean {
  if (!isAlive(wc) || !owned.has(wc)) return false
  owned.delete(wc)
  const detach = () => { try { wc.debugger.detach() } catch (_) {} }
  try {
    const p = wc.debugger.sendCommand('Page.setWebLifecycleState', { state: 'active' })
    if (p && typeof p.then === 'function') p.then(detach, detach)
    else detach()
  } catch (_) {
    detach()
  }
  return true
}

