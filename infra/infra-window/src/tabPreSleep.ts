/**
 * PreSleepState（对齐 RT `TabLifecycleManager.preSleepState`）。
 *
 * 背景：NG 的休眠是「销毁整个 WebContentsView」以省内存（RT 同款，
 * 每个休眠标签省 ~20-50MB）。但销毁 webContents 会**连带丢掉导航历史**
 * （前进/后退）。若不在此之前抓一份快照：
 *   1. 唤醒后只能回到最后一个 URL，用户失去后退/前进能力；
 *   2. 休眠期间持久化层拿不到「真实 URL + 导航历史」，
 *      会话恢复只能恢复到一个孤立地址（阶段D 的持久化依赖它）。
 *
 * 快照结构（对齐 RT）：
 *   { url: string, navHistory: NavigationEntry[], navHistoryIndex: number }
 *
 * 本模块是**纯函数集合**，只依赖传入的 webContents，不认识标签集合/
 * 布局/持久化，因此可被任意宿主复用与单测。
 */

/**
 * 在销毁 webContents 之前抓取休眠快照。
 */
import type { NavigationEntry, WebContents } from 'electron'

export interface PreSleepState {
  url: string
  navHistory: NavigationEntry[]
  navHistoryIndex: number
}

export function capturePreSleepState(webContents: WebContents | null | undefined, fallbackUrl = ''): PreSleepState | null {
  if (!webContents || (typeof webContents.isDestroyed === 'function' && webContents.isDestroyed())) {
    return null
  }
  let url = fallbackUrl
  let navHistory: NavigationEntry[] = []
  let navHistoryIndex = 0
  try {
    url = webContents.getURL() || fallbackUrl
  } catch {}
  try {
    const nh = webContents.navigationHistory
    if (nh && typeof nh.getAllEntries === 'function') {
      navHistory = nh.getAllEntries() || []
      navHistoryIndex = typeof nh.getActiveIndex === 'function' ? nh.getActiveIndex() : 0
    }
  } catch {}
  return { url, navHistory, navHistoryIndex }
}

/**
 * 唤醒时把快照里的导航历史还原到新建的 webContents。
 * `navigationHistory.restore()` 会把活动项恢复到 index 指向的条目
 * （即回到休眠前的页面），因此**不需要**再额外 loadURL。
 * @param {Electron.WebContents|null} webContents
 * @param {{ navHistory?: Electron.NavigationEntry[], navHistoryIndex?: number }|null} state
 * @returns {boolean} 是否成功还原
 */
export function restoreNavigationHistory(
  webContents: WebContents | null | undefined,
  state: Pick<PreSleepState, 'navHistory' | 'navHistoryIndex'> | null | undefined
): boolean {
  if (!webContents || (typeof webContents.isDestroyed === 'function' && webContents.isDestroyed()) || !state) {
    return false
  }
  const entries = Array.isArray(state.navHistory) ? state.navHistory : []
  if (entries.length === 0) return false
  try {
    const nh = webContents.navigationHistory
    if (nh && typeof nh.restore === 'function') {
      nh.restore({ entries, index: Number(state.navHistoryIndex) || 0 })
      return true
    }
  } catch (e) {
    console.error('[preSleep] restore nav history failed:', e instanceof Error ? e.message : e)
  }
  return false
}

/** 休眠标签能否后退（直接查快照，无需创建空白 webContents） */
export function canGoBackFromPreSleep(state: PreSleepState | null | undefined): boolean {
  if (!state) return false
  return Number(state.navHistoryIndex) > 0
}

/** 休眠标签能否前进 */
export function canGoForwardFromPreSleep(state: PreSleepState | null | undefined): boolean {
  if (!state) return false
  const len = Array.isArray(state.navHistory) ? state.navHistory.length : 0
  return Number(state.navHistoryIndex) < len - 1
}

