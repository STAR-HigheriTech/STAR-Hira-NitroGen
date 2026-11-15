'use strict'

/**
 * window-material-follow.js —— 让一批**非主窗口**跟随主题的窗口材质（亚克力 / Mica）。
 *
 * ══════════════════════════════════════════════════════════════════════
 * 为什么需要这个模块
 * ══════════════════════════════════════════════════════════════════════
 * 主窗口的材质由 `LayoutCoordinator#setTabTheme → _applyWindowMaterial` 落地
 * （那是一条链上的唯一落点）。但 OOBE、独立面板窗口（`detached-panel`）等自绘子窗口
 * **没有 LayoutCoordinator**，它们只是一只裸 BrowserWindow —— 主题里的
 * `style.material` 到不了它们那里，表现就是"主窗口是亚克力、AI 助手窗口还是一块死板底色"。
 *
 * 本模块就是这条缺失的链路。主题侧（theme-runtime）把「当前材质 + 降级底色」
 * 推给这里，这里负责逐个窗口应用 / 回退。
 *
 * ══════════════════════════════════════════════════════════════════════
 * 边界（刻意收窄）
 * ══════════════════════════════════════════════════════════════════════
 *   · **不认识主题**：只接收 `{ material, fallbackColor }`。怎么从主题算出这两个值
 *     是 theme-runtime 的事，这里不 import 任何主题代码。
 *   · **不建窗口**：窗口由调用方建好后 `follow(win)` 登记，`closed` 时自动注销；
 *     集合不持有窗口引用之外的任何东西（WeakMap 存降级底色，不阻止回收）。
 *   · **复用 infra 的唯一实现**：开 / 关材质一律走 `applyWindowBackdrop`，
 *     不在这里重复 Electron 调用与能力判断（见 infra-window/src/backdrop）。
 *
 * ══════════════════════════════════════════════════════════════════════
 * 降级语义（与 LayoutCoordinator#_applyWindowMaterial 逐条对齐）
 * ══════════════════════════════════════════════════════════════════════
 *   · 材质生效   → **绝不**再写窗口底色：Electron 的 setBackgroundMaterial 内部会把
 *                 窗口底色置透明交给 DWM，之后任何底色写入都会把它整个盖掉；
 *   · 材质没生效 → 把主题底色写回窗口背景。既能覆盖"从材质退回"的透明残留，
 *                 也让 Win10 这类不支持材质的机器保持主题观感（渲染层会在这层上
 *                 叠半透明染色，见 subwindow/index.html 的玻璃规则）。
 */

const { applyWindowBackdrop } = require('@hira-ng/infra-window')
import type { BrowserWindow } from 'electron'

/**
 * @returns {{
 *   follow: (win: Electron.BrowserWindow) => unknown,
 *   unfollow: (win: Electron.BrowserWindow) => void,
 *   sync: (next?: { material?: string, fallbackColor?: string }) => void,
 *   getState: () => { material: string, fallbackColor: string, count: number },
 *   dispose: () => void
 * }}
 */
function createWindowMaterialFollow() : {
  follow: (win: Electron.BrowserWindow) => unknown,
  unfollow: (win: Electron.BrowserWindow) => void,
  sync: (next?: { material?: string, fallbackColor?: string }) => void,
  getState: () => { material: string, fallbackColor: string, count: number },
  dispose: () => void
} {
  /** 跟随材质的窗口集合（closed 时移除）。 */
  const windows = new Set<BrowserWindow>()
  const watched = new WeakSet<BrowserWindow>()
  /** 每只窗口上一次写入的降级底色 —— 避免每次主题发布都重复 setBackgroundColor。 */
  const paintedBg = new WeakMap<BrowserWindow, string>()
  /** 当前材质 / 降级底色（主题侧推来；窗口晚登记时按它立即补一次）。 */
  let material = 'none'
  let fallbackColor = ''

  /** 把当前材质（及必要的降级底色）落到一只窗口上。 */
  const applyTo = (win: BrowserWindow): unknown => {
    if (typeof win.isDestroyed === 'function' && win.isDestroyed()) {
      windows.delete(win)
      return null
    }
    const result = applyWindowBackdrop(win, { material })
    if (result.applied) {
      // 材质在身：底色归 DWM，写任何底色都会把材质盖死（同 LayoutCoordinator 的注释）。
      paintedBg.delete(win)
      return result
    }
    if (fallbackColor && paintedBg.get(win) !== fallbackColor) {
      try {
        win.setBackgroundColor(fallbackColor)
        paintedBg.set(win, fallbackColor)
      } catch (_) {
        /* 写不回底色不影响材质本身的开关；窗口仍会显示渲染层兜底的主题色。 */
      }
    }
    return result
  }

  return {
    /**
     * 登记一只窗口并**立即**跟随当前材质。
     * 重复登记无害（Set 去重；材质应用本身也幂等）。
     * @param {Electron.BrowserWindow} win
     */
    follow(win: BrowserWindow): unknown {
      if (!win || (typeof win.isDestroyed === 'function' && win.isDestroyed())) return null
      windows.add(win)
      if (!watched.has(win) && typeof win.once === 'function') {
        watched.add(win)
        win.once('closed', () => windows.delete(win))
      }
      return applyTo(win)
    },

    /** 注销（窗口被手动销毁 / 调用方换绑时用；closed 也会自动注销）。 */
    unfollow(win: BrowserWindow): void {
      windows.delete(win)
    },

    /**
     * 主题侧推来新值：更新并重放到所有跟随窗口。
     *
     * 幂等：值没变时一次原生调用都不做 —— 主题发布是高频路径（编辑器拖动、
     * 背景异步到达都会触发），每窗口一次 setBackgroundMaterial 会引发全窗重绘。
     *
     * @param {{ material?: string, fallbackColor?: string }} [next]
     */
    sync(next: { material?: string; fallbackColor?: string } = {}): void {
      const nextMaterial = typeof next.material === 'string' && next.material ? next.material : 'none'
      const nextFallback = next.fallbackColor ? String(next.fallbackColor) : ''
      const unchanged = nextMaterial === material && nextFallback === fallbackColor
      material = nextMaterial
      if (nextFallback) fallbackColor = nextFallback
      if (unchanged) return
      for (const win of windows) applyTo(win)
    },

    /** 当前生效值 + 跟随窗口数（诊断用）。 */
    getState() {
      return { material, fallbackColor, count: windows.size }
    },

    /** 主题运行时停止时清空登记（窗口生命周期由各自 closed 事件兜底）。 */
    dispose() {
      windows.clear()
    }
  }
}

module.exports = { createWindowMaterialFollow }
