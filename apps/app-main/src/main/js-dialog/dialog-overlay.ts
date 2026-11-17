/**
 * JS Dialog 浮层窗口管理（走 WindowFactory 唯一入口）
 *
 * 完全对齐 Hira main/ipc/jsDialog.js + main/ipc/findBar.js 的窗口特性：
 *   - 独立浮层窗口：frame:false、hasShadow、alwaysOnTop、skipTaskbar、parent 关联
 *   - ready-to-show 后 show() + focus()：模态询问必须立刻可键盘操作
 *   - 父窗口 move/resize 时销毁重开（位置会错位）
 *
 * ⚠ 历史问题：本文件曾直接构造 BrowserWindow，绕开了 infra-window 的
 * WindowFactory —— 违反 CONTRACT-06（窗口创建必须走 WindowFactory 唯一入口），
 * 也使 `verification/p0-check.js` 的 V04 必然失败。现改为调用 `createSubWindow()`，
 * 窗口特性改由 WindowFactory 参数化提供，本文件只剩「业务编排」。
 *
 * 为什么仍用独立窗口而不是 WebContentsView 浮层（见 js-dialog/index.js 说明）：
 *   - 原生系统阴影（hasShadow）
 *   - alwaysOnTop 始终置顶 + skipTaskbar 不占任务栏
 *   - 多显示器 / DPI 缩放由系统处理
 *   - 模态询问显示后接管键盘焦点
 */

import type { BrowserWindow, WebContents } from 'electron'

const { nativeTheme, screen } = require('electron') as typeof import('electron')
const { createSubWindow, defaultPreloadPath } = require('@hira-ng/infra-window') as typeof import('@hira-ng/infra-window')
const { JS_DIALOG_CHANNELS } = require('@hira-ng/shared-types/src/js-dialog-channels.mjs')
const { pageUrl } = require('@hira-ng/shared-types/src/pages.mjs')

// ── 尺寸纪律 ────────────────────────────────────────────────────────────
// 高度不再按类型硬编码：渲染层量出内容自然高度后经 JS_DIALOG_CHANNELS.resize
// 上报，这里只负责几何夹取（下限 / 工作区 / 上限）与重新定位。
const DIALOG_WIDTH = 420
const DIALOG_MIN_HEIGHT = 132
const DIALOG_DEFAULT_HEIGHT = 210 // 内容高度未知时的兜底（也是延迟显示的兜底尺寸）
const DIALOG_MAX_HEIGHT_FALLBACK = 560 // 拿不到显示器信息时的硬上限

interface DialogOverlayOptions {
  parentWindow?: BrowserWindow | null
  navbarExtraHeight?: number
  focusOnReveal?: boolean
}

export interface DialogOverlayController {
  show(): WebContents | null
  destroy(): void
  resizeToContent(contentHeight: unknown): void
  getWebContents(): WebContents | null
  sendInit(data: unknown): void
  sendTheme(info: unknown): void
  isDestroyed(): boolean
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/**
 * 计算浮层窗口位置（完全复刻 Hira getJsDialogWindowPosition）
 * 显示在父窗口 tabbar 下方（网页渲染区顶部），水平居中
 * @param {import('electron').BrowserWindow} parentWindow
 * @param {number} [navbarExtraHeight] - navbar 额外高度（tabbar 第二行展开时）
 * @param {number} [winH] - 本次窗口高度（自适应高度后需要按真实高度做底部避让）
 */
export function getJsDialogWindowPosition(
  parentWindow: BrowserWindow | null | undefined,
  navbarExtraHeight?: number,
  winH?: number
): { x: number; y: number } {
  const height = typeof winH === 'number' && Number.isFinite(winH) ? winH : DIALOG_DEFAULT_HEIGHT
  if (!parentWindow || parentWindow.isDestroyed()) {
    return { x: 200, y: 120 }
  }
  const bounds = parentWindow.getBounds()
  // 显示在 tabbar 下方（网页渲染区顶部），水平居中
  // navbar 高度 76px + 1px border + 4px 间距 = 81px（+ tabbar 第二行展开时 navbarExtraHeight）
  let x = bounds.x + Math.round((bounds.width - DIALOG_WIDTH) / 2)
  let y = bounds.y + 81 + (navbarExtraHeight || 0)
  const display = screen.getDisplayNearestPoint({ x: x, y: y })
  const workArea = display.workArea
  if (x + DIALOG_WIDTH > workArea.x + workArea.width) x = workArea.x + workArea.width - DIALOG_WIDTH
  if (y + height > workArea.y + workArea.height) y = workArea.y + workArea.height - height
  if (x < workArea.x) x = workArea.x
  if (y < workArea.y) y = workArea.y
  return { x: Math.round(x), y: Math.round(y) }
}

/**
 * 计算当前落点允许的最大窗口高度。
 * 只做几何约束（工作区 / 屏幕占比），业务侧不关心「内容多高」——那是渲染层上报的。
 */
function getMaxHeightAt (x: number, y: number): number {
  let display: Electron.Display | null = null
  try {
    display = screen.getDisplayNearestPoint({ x: Math.round(x), y: Math.round(y) })
  } catch (_) {}
  const workArea = display && display.workArea
  if (!workArea) return DIALOG_MAX_HEIGHT_FALLBACK
  // ① 不超过工作区 72%（长文也不该铺满屏幕）
  // ② 不超过当前位置到工作区底边之间的可见空间（否则内容底部会被任务栏/屏幕边缘切掉）
  const byRatio = Math.round(workArea.height * 0.72)
  const bySpace = workArea.y + workArea.height - Math.round(y) - 12
  return Math.max(DIALOG_MIN_HEIGHT, Math.min(byRatio, bySpace))
}

/** 把内容自然高度夹到窗口允许的区间内 */
function clampHeight (contentHeight: unknown, x: number, y: number): number {
  const h = Math.ceil(Number(contentHeight))
  if (!Number.isFinite(h) || h <= 0) return DIALOG_DEFAULT_HEIGHT
  const maxH = getMaxHeightAt(x, y)
  return Math.max(DIALOG_MIN_HEIGHT, Math.min(maxH, h))
}

/**
 * 创建浮层管理器
 * @param {Object} opts
 * @param {import('electron').BrowserWindow} opts.parentWindow
 * @param {number} [opts.navbarExtraHeight] - navbar 额外高度（tabbar 第二行展开时）
 * @param {boolean} [opts.focusOnReveal] - 出现时**接管焦点**。
 *   对话框是 modal 子窗，父窗口已被禁用；不接管焦点会让 Enter / Esc 暂时没有落点。
 */
export function createOverlay ({ parentWindow, navbarExtraHeight, focusOnReveal }: DialogOverlayOptions): DialogOverlayController {
  let _win: BrowserWindow | null = null
  let _moveHandler: (() => void) | null = null
  let _resizeHandler: (() => void) | null = null
  // 「先量后显」：窗口建好先隐藏，等渲染层上报内容高度、尺寸摆正后再显示，
  // 否则用户会看到「小窗先闪一下 → 再长高」的跳动（内容越长越明显）。
  let _shown = false
  let _revealTimer: ReturnType<typeof setTimeout> | null = null
  // renderer 崩溃后 WindowFactory 会重载页面；重载后的文档必须重新收到当前请求，
  // 否则会留下一个尺寸正常但内容全空的对话框。
  let _lastInitData: unknown = null

  /** 显示浮层并接管键盘。幂等。 */
  function reveal () {
    if (_shown || !_win || _win.isDestroyed()) return
    _shown = true
    if (_revealTimer) {
      clearTimeout(_revealTimer)
      _revealTimer = null
    }
    try {
      if (focusOnReveal) {
        // 模态窗必须自己拿焦点，否则父窗口被禁用后键盘无处可去。
        _win.show()
        _win.focus()
      } else {
        _win.showInactive()
        if (!_win.isVisible()) _win.show()
      }
    } catch (_) {}
  }

  /**
   * 按渲染层上报的内容自然高度调整窗口尺寸 + 重新定位。
   * 内容超长时窗口停在允许的最大高度，消息区内部滚动（见 jsdialog.css 的 .jd-message）。
   * @param {number} contentHeight
   */
  function resizeToContent (contentHeight: unknown): void {
    if (!_win || _win.isDestroyed()) return
    // 用「当前位置」算可用空间：y 由父窗口决定，和内容高度无关
    const bounds = _win.getBounds()
    const targetH = clampHeight(contentHeight, bounds.x, bounds.y)
    let currentH = -1
    try { currentH = _win.getContentSize()[1] } catch (_) {}
    if (currentH !== targetH) {
      try { _win.setContentSize(DIALOG_WIDTH, targetH) } catch (_) {}
    }
    const pos = getJsDialogWindowPosition(parentWindow, navbarExtraHeight, targetH)
    if (pos.x !== bounds.x || pos.y !== bounds.y) {
      try { _win.setPosition(pos.x, pos.y, false) } catch (_) {}
    }
    reveal()
  }

  /**
   * 创建浮层窗口（初始隐藏，等渲染层上报高度后由 resizeToContent 亮出）
   * @returns {import('electron').WebContents}
   */
  function show () : import('electron').WebContents | null {
    if (_win && !_win.isDestroyed()) return _win.webContents

    // preload 与 shell/panel/tab 同源：构建产物统一住在 out/preload/（preload 构建入口）。
    // 过去用 path.join(__dirname, 'dialog-renderer.js') 指着 main 目录的拷贝 —— 那份拷贝
    // 既不能 import 共享通道表，也必须靠 copyMainSourcesPlugin 逐字节搬到 out/main。
    const preloadPath = defaultPreloadPath('dialog-renderer')

    let win: BrowserWindow
    try {
      // 窗口创建统一走 WindowFactory（CONTRACT-06）：本处只声明「要什么样的窗口」。
      ;({ win } = createSubWindow({
        url: pageUrl('jsdialog'),
        width: DIALOG_WIDTH,
        height: DIALOG_DEFAULT_HEIGHT,
        parent: parentWindow || undefined,
        modal: Boolean(parentWindow),
        // 先隐藏；尺寸由渲染层量出的内容高度决定后再显示（不白闪，
        // 也不会先用兜底高度闪一下再跳变）。
        show: false,
        showOnReady: false,
        frame: false,
        alwaysOnTop: true,
        skipTaskbar: true,
        resizable: false,
        minimizable: false,
        maximizable: false,
        autoHideMenuBar: true,
        hasShadow: true,
        paintWhenInitiallyHidden: true,
        thickFrame: true,
        title: '网页对话框',
        backgroundColor: nativeTheme.shouldUseDarkColors ? '#1f2937' : '#ffffff',
        webPreferences: {
          preload: preloadPath
          // Keep the shared contextIsolation/sandbox baseline. The dialog renderer
          // manipulates DOM from its isolated preload world; it does not need a
          // same-world bridge to the inert local HTML document.
        }
      }))
    } catch (e) {
      console.error('[jsDialog] window creation failed:', errorText(e))
      return null
    }
    _win = win
    _shown = false

    win.webContents.on('render-process-gone', (_event, details) => {
      if (details && details.reason === 'clean-exit') return
      _shown = false
      const wc = _win && !_win.isDestroyed() ? _win.webContents : null
      if (!wc || wc.isDestroyed()) return
      wc.once('did-finish-load', () => {
        if (_lastInitData == null || wc.isDestroyed()) return
        try { wc.send(JS_DIALOG_CHANNELS.init, _lastInitData) } catch (_) {}
      })
    })

    // 计算位置并设置（唯一需要窗口实例的操作：WindowFactory 不认识业务定位规则）
    const pos = getJsDialogWindowPosition(parentWindow, navbarExtraHeight, DIALOG_DEFAULT_HEIGHT)
    _win.setPosition(pos.x, pos.y, false)

    // 兜底显示：渲染层没上报（加载失败 / 脚本异常）时也不能变成「建了却看不见」的幽灵窗口。
    _win.webContents.once('did-fail-load', reveal)
    _revealTimer = setTimeout(reveal, 800)

    // 父窗口 move → 销毁重开（位置会错位，Hira 的处理方式）
    _moveHandler = () => {
      if (_win && !_win.isDestroyed()) {
        destroy()
      }
    }
    if (parentWindow && !parentWindow.isDestroyed()) {
      parentWindow.on('move', _moveHandler)
      _resizeHandler = () => {
        if (_win && !_win.isDestroyed()) {
          destroy()
        }
      }
      parentWindow.on('resize', _resizeHandler)
    }

    return _win.webContents
  }

  /**
   * 获取 webContents
   */
  function getWebContents () {
    return _win && !_win.isDestroyed() ? _win.webContents : null
  }

  /**
   * 发送 init 数据到浮层
   */
  function sendInit (data: unknown): void {
    _lastInitData = data
    if (!_win || _win.isDestroyed()) return
    const wc = _win.webContents
    if (wc.isLoading()) {
      wc.once('did-finish-load', function () {
        try { wc.send(JS_DIALOG_CHANNELS.init, data) } catch (_) {}
      })
    } else {
      try { wc.send(JS_DIALOG_CHANNELS.init, data) } catch (_) {}
    }
  }

  /**
   * 发送主题切换
   */
  function sendTheme (info: unknown): void {
    if (!_win || _win.isDestroyed()) return
    try { _win.webContents.send(JS_DIALOG_CHANNELS.themeChanged, info) } catch (_) {}
  }

  /**
   * 销毁浮层窗口
   */
  function destroy () {
    if (_revealTimer) {
      clearTimeout(_revealTimer)
      _revealTimer = null
    }
    _shown = false
    if (_moveHandler && parentWindow && !parentWindow.isDestroyed()) {
      try { parentWindow.removeListener('move', _moveHandler) } catch (_) {}
      _moveHandler = null
    }
    if (_resizeHandler && parentWindow && !parentWindow.isDestroyed()) {
      try { parentWindow.removeListener('resize', _resizeHandler) } catch (_) {}
      _resizeHandler = null
    }
    if (_win && !_win.isDestroyed()) {
      try { _win.destroy() } catch (_) {}
    }
    _win = null
  }

  /**
   * 检查窗口是否已销毁
   */
  function isDestroyed () {
    return !_win || _win.isDestroyed()
  }

  return {
    show,
    destroy,
    // 渲染层上报内容自然高度后由 index.js 调进来（窗口高度自适应）
    resizeToContent,
    getWebContents,
    sendInit,
    sendTheme,
    isDestroyed
  }
}

