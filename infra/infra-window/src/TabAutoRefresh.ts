/** 标签周期刷新控制器：只持有计时器，页面与应用生命周期仍由 TabManager 提供。 */
import type { WebContents } from 'electron'
import { reloadOrRetry } from './page-reload'

interface RefreshableTab { error?: { url?: string; code?: number; description?: string } | null }
interface TabAutoRefreshDependencies {
  getTab(tabId: string): RefreshableTab | null | undefined
  getWebContents(tabId: string): WebContents | null
  onChanged(): void
}

export class TabAutoRefreshController {
  private readonly _getTab: TabAutoRefreshDependencies['getTab']
  private readonly _getWebContents: TabAutoRefreshDependencies['getWebContents']
  private readonly _onChanged: TabAutoRefreshDependencies['onChanged']
  private readonly _entries = new Map<string, { intervalMs: number; timer: ReturnType<typeof setInterval> }>()
  /**
   * @param {object} deps
   * @param {(tabId: string) => object|undefined} deps.getTab
   * @param {(tabId: string) => Electron.WebContents|null} deps.getWebContents
   * @param {() => void} deps.onChanged
   */
  constructor({ getTab, getWebContents, onChanged }: TabAutoRefreshDependencies) {
    this._getTab = getTab
    this._getWebContents = getWebContents
    this._onChanged = onChanged
  }

  set(tabId: string, intervalMs: number): { tabId: string; autoRefreshMs: number } {
    const id = String(tabId)
    if (!this._getTab(id)) throw new Error(`Missing tab: ${id}`)
    const value = Number(intervalMs)
    const next = Number.isFinite(value) && value >= 5000 ? Math.floor(value) : 0
    this.clear(id)
    if (next > 0) {
      const timer = setInterval(() => this.reload(id), next)
      if (timer && typeof timer.unref === 'function') timer.unref()
      this._entries.set(id, { intervalMs: next, timer })
    }
    this._onChanged()
    return { tabId: id, autoRefreshMs: next }
  }

  intervalOf(tabId: string): number {
    const entry = this._entries.get(String(tabId))
    return entry ? Number(entry.intervalMs) || 0 : 0
  }

  clear(tabId: string): boolean {
    const id = String(tabId)
    const entry = this._entries.get(id)
    if (!entry) return false
    try { clearInterval(entry.timer) } catch (_) {}
    this._entries.delete(id)
    return true
  }

  reload(tabId: string): void {
    const id = String(tabId)
    const tab = this._getTab(id)
    if (!tab) {
      this.clear(id)
      return
    }
    try {
      const webContents = this._getWebContents(id)
      if (webContents && !webContents.isDestroyed()) {
        reloadOrRetry(webContents, tab.error ? tab.error.url : '')
      }
    } catch (error) {
      console.warn('[tab] auto refresh failed:', error instanceof Error ? error.message : error)
    }
  }

  clearAll(): void {
    for (const id of Array.from(this._entries.keys())) this.clear(id)
  }
}
