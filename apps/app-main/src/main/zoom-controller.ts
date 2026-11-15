/**
 * zoom-controller —— 页面缩放的**唯一执行者**（每窗口一份）
 *
 * ── 为什么必须有它（而不是几处各写一遍 setZoomLevel）───────────────────
 * 缩放有三条入口：键盘快捷键、Ctrl+滚轮、缩放条上的按钮（还有第四条：导航到有记忆的
 * 站点时自动恢复）。它们必须**做法完全一致**：同一套档位、同一套上限、同一份记忆、
 * 同一条"通知 UI"的事实。分散实现必然漂移（典型症状：快捷键按出来 110%，滚轮却是
 * 上下 50% 的零碎值）。
 *
 * ── 档位 ──────────────────────────────────────────────────────────────
 * Chromium 的 zoomLevel 是**对数刻度**：`factor = 1.2 ^ level`。本项目按 Chrome/Edge
 * 的百分比阶梯走（25/33/50/67/75/80/90/100/110/125/150/175/200/250/300/400/500），
 * 因此"上一档/下一档"是**在这条阶梯上取相邻项**，而不是给 level 加减一个常数 ——
 * 后者在 100% 附近会得到 105%、111% 这种非阶梯值（Chrome 用户一眼就看出不对）。
 *
 * ── 记忆（按站点持久化）──────────────────────────────────────────────
 * 落库在设置项 `app.zoom_levels`：`{ '<origin>': zoomLevel }`。为什么按 origin 而不是
 * 按标签：Chrome 的语义是"这个网站我习惯放大"——标签是会关的，站点不会。
 * 回到 100% 时**删掉该条目**（而不是存 0），保证这张表只记"用户真正改过的站点"，
 * 不会随着浏览历史无界增长。写入做 300ms 防抖（连点 + 时一次落库）。
 * 只对 http(s) 记忆：`file:` 等的 origin 是 'null'，按 origin 记账会全部互相覆盖。
 *
 * 解耦：不认识 IPC、不认识窗口，全部依赖注入；通知 UI 也只是回调一条事实。
 */

import type { WebContents } from 'electron'

// 「算不算普通网页」的唯一判据 —— 缩放记忆只对 http(s) 按 origin 记（file: 的 origin 是 'null'）。
const { isHttpProtocol } = require('@hira-ng/shared-types/src/url-protocols.mjs') as {
  isHttpProtocol(protocol: string): boolean
}

export interface ZoomPayload {
  level: number
  percent: number
  origin: string
  source: string
}

interface ZoomSettingsPort {
  get(key: string): unknown
  set(key: string, value: unknown): unknown
}

export interface ZoomControllerOptions {
  getActiveWebContents(): WebContents | null | undefined
  settings: ZoomSettingsPort
  notify?(payload: ZoomPayload): void
}

export interface ZoomController {
  step(delta: number, targetWc?: WebContents, source?: string): ZoomPayload | null
  reset(targetWc?: WebContents, source?: string): ZoomPayload | null
  restore(targetWc?: WebContents): ZoomPayload | null
  currentPercent(targetWc?: WebContents): number
  flush(): void
  readonly PERCENT_LADDER: readonly number[]
}

/** 缩放阶梯（百分比）。与 Chrome/Edge 的档位一致。 */
export const PERCENT_LADDER: readonly number[] = Object.freeze([25, 33, 50, 67, 75, 80, 90, 100, 110, 125, 150, 175, 200, 250, 300, 400, 500])
/** Chromium 的对数底：factor = BASE ^ level。 */
const BASE = 1.2
/** 站点缩放记忆的设置键（对象：origin → zoomLevel）。 */
export const ZOOM_LEVELS_KEY = 'app.zoom_levels'
/** 落库防抖（连点 +/- 时合并成一次写）。 */
const SAVE_DEBOUNCE_MS = 300

/** 百分比 → Chromium zoomLevel（对数换算，与 levelToPercent 互逆）。 */
export function percentToLevel(percent: number): number {
  return Math.log(percent / 100) / Math.log(BASE)
}

/** Chromium zoomLevel → 百分比（四舍五入到整数百分比）。 */
export function levelToPercent(level: number): number {
  return Math.round(Math.pow(BASE, level) * 100)
}

/** 阶梯上离 `percent` 最近的那一档的下标（用于从"非阶梯值"续步进）。 */
function nearestLadderIndex(percent: number): number {
  let best = 0
  let bestDiff = Infinity
  for (let i = 0; i < PERCENT_LADDER.length; i += 1) {
    const diff = Math.abs((PERCENT_LADDER[i] || 100) - percent)
    if (diff < bestDiff) { bestDiff = diff; best = i }
  }
  return best
}

/**
 * @param {object} deps
 * @param {() => Electron.WebContents|null} deps.getActiveWebContents
 * @param {{ get: (key: string) => any, set: (key: string, value: any) => any }} deps.settings
 *   设置读写端口（**不是** settingsService 实例本身）：本模块只用到 KV 语义，
 *   由宿主决定它落在哪个 profile / 存储上。
 * @param {(payload: {level:number, percent:number, origin:string, source:string}) => void} deps.notify
 *   把"缩放变了"这条事实报出去（宿主负责推给缩放条浮层 + 外壳）。
 */
export function createZoomController(deps: ZoomControllerOptions): ZoomController {
  const { getActiveWebContents, settings, notify } = deps

  /** origin → zoomLevel 的记忆表（内存副本；惰性读一次库） */
  let levels: Record<string, number> | null = null
  let saveTimer: NodeJS.Timeout | null = null

  function loadLevels(): Record<string, number> {
    if (levels) return levels
    try {
      const raw = settings && typeof settings.get === 'function' ? settings.get(ZOOM_LEVELS_KEY) : null
      levels = raw && typeof raw === 'object' && !Array.isArray(raw)
        ? { ...raw as Record<string, number> }
        : {}
    } catch (_) {
      levels = {}
    }
    return levels
  }

  function scheduleSave(): void {
    if (saveTimer) return
    saveTimer = setTimeout(() => {
      saveTimer = null
      try {
        if (settings && typeof settings.set === 'function') settings.set(ZOOM_LEVELS_KEY, { ...loadLevels() })
      } catch (_) {}
    }, SAVE_DEBOUNCE_MS)
  }

  function originOf(wc: WebContents | null | undefined): string {
    if (!wc || wc.isDestroyed()) return ''
    try {
      const u = new URL(String(wc.getURL() || ''))
      if (!isHttpProtocol(u.protocol)) return ''
      return u.origin
    } catch (_) {
      return ''
    }
  }

  function safeLevel(wc: WebContents): number {
    try { return Number(wc.getZoomLevel()) || 0 } catch (_) { return 0 }
  }

  function resolveWc(targetWc: WebContents | undefined): WebContents | null {
    if (targetWc && !targetWc.isDestroyed()) return targetWc
    const wc = getActiveWebContents()
    return wc && !wc.isDestroyed() ? wc : null
  }

  /** 应用一个 zoomLevel：落到 webContents + 通知 UI。**不含**记忆写入。 */
  function applyLevel(wc: WebContents, level: number, source: string): ZoomPayload {
    try { wc.setZoomLevel(level) } catch (_) {}
    const payload = {
      level,
      percent: levelToPercent(level),
      origin: originOf(wc),
      source: String(source || 'shortcut')
    }
    try { if (typeof notify === 'function') notify(payload) } catch (_) {}
    return payload
  }

  /** 记住「这个站点用这个比例」（100% = 删掉条目）。 */
  function remember(wc: WebContents, level: number): void {
    const origin = originOf(wc)
    if (!origin) return
    const table = loadLevels()
    if (Math.abs(level) < 1e-6) {
      if (table[origin] == null) return
      delete table[origin]
    } else {
      table[origin] = Number(level.toFixed(4))
    }
    scheduleSave()
  }

  /**
   * 在当前档位的基础上步进 `delta`（±1 档，>0 放大）。
   * @param {number} delta
   * @param {Electron.WebContents} [targetWc] 指定页面（Ctrl+滚轮用：必须缩放**鼠标所在**那一页）
   * @param {string} [source]
   * @returns {{level:number, percent:number}|null}
   */
  function step(delta: number, targetWc?: WebContents, source: string = 'shortcut'): ZoomPayload | null {
    const wc = resolveWc(targetWc)
    if (!wc) return null
    const dir = Number(delta) > 0 ? 1 : (Number(delta) < 0 ? -1 : 0)
    if (!dir) return null
    const idx = nearestLadderIndex(levelToPercent(safeLevel(wc)))
    const nextIdx = Math.max(0, Math.min(PERCENT_LADDER.length - 1, idx + dir))
    if (nextIdx === idx) {
      // 已在上/下界：仍然通知一次 UI（让缩放条弹出来显示"已经到顶"，而不是毫无反应）
      return applyLevel(wc, percentToLevel(PERCENT_LADDER[idx] || 100), source)
    }
    const level = percentToLevel(PERCENT_LADDER[nextIdx] || 100)
    remember(wc, level)
    return applyLevel(wc, level, source)
  }

  /**
   * 回到 100% 并**忘掉**这个站点的记忆（Chrome 的"重置"就是这个语义）。
   * @param {Electron.WebContents} [targetWc]
   */
  function reset(targetWc?: WebContents, source = 'shortcut'): ZoomPayload | null {
    const wc = resolveWc(targetWc)
    if (!wc) return null
    remember(wc, 0)
    return applyLevel(wc, 0, source)
  }

  /**
   * 导航到新页面时恢复该站点的记忆（source = 'restore'，缩放条据此**不弹**——
   * 用户没有操作缩放，弹出来只会干扰）。没有记忆 → 回到 100%。
   */
  function restore(targetWc?: WebContents): ZoomPayload | null {
    const wc = resolveWc(targetWc)
    if (!wc) return null
    const origin = originOf(wc)
    const table = loadLevels()
    const level = origin && table[origin] != null ? Number(table[origin]) : 0
    // 级别没变就不要惊动 UI / webContents（每次导航都会走到这里，白刷一遍很浪费）
    if (Math.abs(safeLevel(wc) - level) < 1e-6) return null
    return applyLevel(wc, level, 'restore')
  }

  /** 当前活动页面的缩放百分比（渲染层要显示"100%"这类文案时用）。 */
  function currentPercent(targetWc?: WebContents): number {
    const wc = resolveWc(targetWc)
    if (!wc) return 100
    return levelToPercent(safeLevel(wc))
  }

  /** 窗口关闭：把没来得及落库的记忆立刻写掉（防抖窗口内关窗会丢最后一次改动）。 */
  function flush(): void {
    if (!saveTimer) return
    clearTimeout(saveTimer)
    saveTimer = null
    try {
      if (settings && typeof settings.set === 'function') settings.set(ZOOM_LEVELS_KEY, { ...loadLevels() })
    } catch (_) {}
  }

  return { step, reset, restore, currentPercent, flush, PERCENT_LADDER }
}

