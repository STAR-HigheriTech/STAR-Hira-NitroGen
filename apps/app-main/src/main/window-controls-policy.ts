/**
 * 系统窗口控制按钮（WCO）策略 —— 主窗口与 PWA 应用窗的**唯一**判定/同步实现。
 *
 * ── 为什么单独成模块 ─────────────────────────────────────────────
 * WCO 的规则很短，但有三处必须完全一致，否则主窗口与 PWA 应用窗会出现
 * 「一个系统绘制、一个自绘」「字形颜色不跟主题」这类肉眼可见的不统一：
 *
 *   1. 判定：`app.window_controls_style` 两态（native / custom），缺省 native；
 *   2. 建窗参数：`titleBarOverlay` 的高度/底色/字形色；
 *   3. 运行时同步：`nativeTheme` 明暗切换时重设 symbolColor（只在 native 下）。
 *
 * 以前 1~3 散在 browser-window-assembly 的建窗段与晚段两处；PWA 应用窗要接入时
 * 再抄一遍就必然漂移。现在收敛到这里，两边都只调用本模块。
 *
 * ── 使用方式 ─────────────────────────────────────────────────────
 *   const policy = createWindowControlsPolicy(settingsService)
 *   const overlay = policy.overlay            // null = 自绘
 *   createMainWindow({ titleBarOverlay: overlay })
 *   createSubWindow({ titleBarOverlay: overlay })
 *   policy.attach(win)                        // native 时挂主题监听，closed 自动清理
 */

const { nativeTheme } = require('electron')
import type { BrowserWindow } from 'electron'
const {
  resolveWindowControlsMode,
  WINDOW_CONTROLS_OVERLAY_HEIGHT,
  LAYOUT_SETTING_KEYS
} = require('@hira-ng/shared-types/src/layout.mjs')

const OVERLAY_BACKGROUND = 'rgba(0,0,0,0)'

/**
 * 按当前设置解析 WCO 模式。
 *
 * 读不到设置服务（启动极早期 / 异常）→ 保守回落自绘：自绘是任何布局都成立的实现，
 * 宁可退回去也不建出一个按钮悬空的窗口。
 * 服务在、但键从没被写过 → 交给 resolveWindowControlsMode 归一到声明缺省（native）。
 *
 */
function resolveWindowControlsStyle(
  settingsService?: { get: (key: string) => unknown } | null
): 'native' | 'custom' {
  try {
    if (!settingsService || typeof settingsService.get !== 'function') return 'custom'
    const style = settingsService.get(LAYOUT_SETTING_KEYS.windowControlsStyle)
    // null = 设置端口读取出错（端口异常时返回 null）→ 保守自绘；
    // undefined = 从没写过 → 走声明缺省。
    return style === null ? 'custom' : resolveWindowControlsMode({ style }) as 'native' | 'custom'
  } catch (_) {
    return 'custom'
  }
}

/**
 * 由模式生成 `BrowserWindow` 的 titleBarOverlay 参数（null = 不启用 WCO）。
 * 颜色每次按当前 nativeTheme 现算，建窗与后续同步共用同一份。
 *
 */
function buildTitleBarOverlay(
  mode: 'native' | 'custom'
): { height: number; symbolColor: string; color: string } | null {
  if (mode !== 'native') return null
  return {
    // 高度 = 顶部 chrome 行高：系统把三颗按钮居中的那条带子必须与行高一致，
    // 按钮才会和标签 / 地址栏控件落在同一条中心线上。
    height: WINDOW_CONTROLS_OVERLAY_HEIGHT,
    symbolColor: nativeTheme.shouldUseDarkColors ? 'white' : 'black',
    color: OVERLAY_BACKGROUND
  }
}

/**
 * 创建一个窗口控制按钮策略实例（每个窗口一个，避免共享可变状态）。
 *
 */
export function createWindowControlsPolicy(
  settingsService?: { get: (key: string) => unknown } | null
): {
  mode: 'native' | 'custom'
  native: boolean
  overlay: ReturnType<typeof buildTitleBarOverlay>
  attach: (win: BrowserWindow) => void
} {
  const mode = resolveWindowControlsStyle(settingsService)
  const overlay = buildTitleBarOverlay(mode)

  /** 给已启用 overlay 的窗口挂主题同步（自绘模式空操作）。 */
  function attach(win: BrowserWindow): void {
    if (!overlay || !win || typeof win.setTitleBarOverlay !== 'function') return
    const syncSymbolColor = () => {
      if (win.isDestroyed()) return
      try {
        const next = buildTitleBarOverlay('native')
        if (next) win.setTitleBarOverlay(next)
      } catch (_) {}
    }
    nativeTheme.on('updated', syncSymbolColor)
    win.on('closed', () => {
      try { nativeTheme.removeListener('updated', syncSymbolColor) } catch (_) {}
    })
  }

  return { mode, native: mode === 'native', overlay, attach }
}

module.exports = {
  resolveWindowControlsStyle,
  buildTitleBarOverlay,
  createWindowControlsPolicy
}
