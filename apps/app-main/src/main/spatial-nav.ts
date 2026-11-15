/**
 * spatial-nav —— N9 空间导航的**开关下发器**。
 *
 * ── 它做什么 ──────────────────────────────────────────────────────
 * 把设置项 `input.spatial_navigation` 的当前值推给**所有页面 preload**
 *（`ngipc:event:input:spatial-nav`，见 `IPC_EVENTS.spatialNav`）。
 * 页面侧引擎（`preload/spatial-nav`）据此即时开/关 —— **不用重进页面**。
 *
 * ── 为什么单独一个模块 ───────────────────────────────────────────
 * 页面侧还要在加载那一刻自己 `settings:get` 拉一次（广播只在"变更"时来）。
 * 两条线合起来才是完整的：**拉**负责首帧、**推**负责热更新。这里只管推。
 *
 * ── 为什么广播给"所有 webContents"而不是只给标签 ────────────────
 * 标签是 `WebContentsView`，不在 `BrowserWindow.getAllWindows()` 里 —— 要枚举它们
 * 得绕一圈（逐个 runtime 的 tabManager）。而设置变更本来就不频繁，直接遍历
 * `webContents.getAllWebContents()` 最省事；内部页/面板没有监听者，收到也无副作用。
 */

const { webContents } = require('electron')
const { IPC_EVENTS } = require('@hira-ng/shared-types/src/ipc-channels.mjs')

const CHANNEL = `ngipc:event:${IPC_EVENTS.spatialNav}`
const KEY = 'input.spatial_navigation'

interface SpatialNavSettings {
  get: (key: string) => unknown
  subscribe?: (listener: (change: { key?: string }) => void) => unknown
}

function createSpatialNavBroadcaster(deps: { settings: SpatialNavSettings }) {
  const settings = deps.settings

  function isEnabled(): boolean {
    try {
      const v = settings && typeof settings.get === 'function' ? settings.get(KEY) : null
      return v === true || v === 'true' || v === 1 || v === '1'
    } catch (_) { return false }
  }

  /** 推给所有 webContents（销毁中的跳过）。 */
  function broadcast(): void {
    const enabled = isEnabled()
    let all: ReturnType<typeof webContents.getAllWebContents> = []
    try { all = webContents.getAllWebContents() } catch (_) { return }
    for (const wc of all) {
      try { if (wc && !wc.isDestroyed()) wc.send(CHANNEL, { enabled }) } catch (_) {}
    }
  }

  if (settings && typeof settings.subscribe === 'function') {
    settings.subscribe((change) => {
      if (change && change.key === KEY) broadcast()
    })
  }

  return { broadcast, isEnabled }
}

module.exports = { createSpatialNavBroadcaster }
