/**
 * 扩展弹窗（extension popup）控制器 —— 「点扩展图标弹出它自己的 popup」的窗口编排。
 *
 * ── 学的是 RT 的哪一部分 ────────────────────────────────────────────────
 * RT 里真正的弹窗窗口是 ECE（@iamevan/electron-chrome-extensions）的 PopupView 建的，
 * 它只做两件事：
 *   1. `loaded-profiles-controller` 监听 `browser-action-popup-created`，
 *      把已建好的窗口交给 `windowsController.extensionPopup.new(popup.browserWindow)`
 *      （= 在窗口控制器里登记一个 **extension-popup** 类型）；
 *   2. 扩展页（renderer）在点按钮时用 `element.getBoundingClientRect()` 现算
 *      anchorRect，连同 alignment 一起发给主进程（components/providers/browser-action-provider.tsx）。
 * 本控制器把这两件事在 NG 里落地，并补上 ECE 那条路走不通时的**自有弹窗窗口**：
 *   · 从**独立的管理页窗口**发起时，当前窗口里没有标签页 → ECE 的 activateClick
 *     会因拿不到 tag/window 而抛错（它必须锚定到某个标签所属的浏览器窗口）；
 *   · popup 里的 `chrome.*` API 要有宿主会话才可用，而 NG 是多 profile 隔离会话 ——
 *     所以窗口必须绑到**该扩展所属 profile 的 session**（由 infra-extension 传入）。
 *
 * ── 窗口特性（与 window-config.js 的 EXTENSION_POPUP 条目同源）──────────────
 *   frame:false（popup 是自绘内容容器）、挂 parent（必须压在发起窗口之上）、
 *   不占任务栏、不可缩放 / 最小化 / 最大化、ready-to-show 后再显示（免白闪）、
 *   **失焦即关**、关闭一律 `destroy()`（真正释放渲染进程内存，而不是 hide 掉留着）。
 */

import { screen, type BrowserWindow, type Session } from 'electron'
import type { WindowRegistry } from '@hira-ng/infra-window'
import type { WindowConfigEntry } from './window-config'

type SubWindowOptions = Parameters<typeof import('@hira-ng/infra-window').createSubWindow>[0]

export interface ExtensionPopupAnchorRect {
  x: number
  y: number
  width?: number
  height?: number
}

export interface ExtensionPopupOpenOptions {
  url: string
  extensionId: string
  session: Session
  parentWindow?: BrowserWindow | null
  anchorRect?: ExtensionPopupAnchorRect | null
  alignment?: string
}

export interface ExtensionPopupDependencies {
  createSubWindow(options: SubWindowOptions): { win: BrowserWindow }
  windowRegistry?: WindowRegistry<BrowserWindow> | null
  config?: WindowConfigEntry | null
  windowType?: string
}

interface ExtensionPopupEntry {
  win: BrowserWindow
  parent: BrowserWindow | null
  extensionId: string
  anchorRect: ExtensionPopupAnchorRect | null | undefined
  alignment: string | undefined
  width: number
  height: number
  onParentMove: () => void
  onParentResize: () => void
  onParentClosed: () => void
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** 弹窗与锚点之间的间距（与 ECE PopupView 的 POSITION_PADDING 一致，都是 5px）。 */
const POSITION_PADDING = 5
/** 内容自适应尺寸的上限（与 ECE PopupView.BOUNDS 同口径）。 */
const MAX_WIDTH = 800
const MAX_HEIGHT = 600

export function createExtensionPopupController({ createSubWindow, windowRegistry, config, windowType = 'extension-popup' }: ExtensionPopupDependencies) {
  const cfg = config || {}
  /** 当前弹窗。同一时刻只允许一个 —— 与 ECE 的 toggle 语义一致。 */
  let current: ExtensionPopupEntry | null = null

  function isAlive(win: BrowserWindow | null | undefined): win is BrowserWindow {
    if (!win) return false
    return typeof win.isDestroyed === 'function' && !win.isDestroyed()
  }

  /**
   * 按锚点算弹窗落点（返回**内容区**左上角）。
   *
   * 对齐 ECE PopupView.updatePosition 的语义：
   *   · 默认 —— 弹窗**右边**贴锚点右边、在锚点**下方**（工具栏 / 右侧按钮的常规落点）；
   *   · alignment 含 'right' —— 弹窗左边贴锚点左边（向右展开，侧栏左侧按钮用）；
   *   · alignment 含 'top'   —— 在锚点上方展开。
   * 最后按父窗口所在显示器的 workArea 夹一下：宁可贴边，也不让弹窗跑到屏幕外。
   */
  function computePosition(
    parentWin: BrowserWindow,
    anchorRect: ExtensionPopupAnchorRect | null | undefined,
    alignment: string | undefined,
    size: { width: number; height: number }
  ): { x: number; y: number } {
    const parentBounds = parentWin.getContentBounds()
    const anchor = anchorRect && typeof anchorRect.x === 'number' && typeof anchorRect.y === 'number'
      ? anchorRect
      : null
    // 没有可用锚点（调用方没传 / 旧调用方）：退回父窗口右上角，与 ECE 默认锚点一致。
    const ax = anchor ? anchor.x : Math.max(0, parentBounds.width - size.width)
    const ay = anchor ? anchor.y : 0
    const aw = anchor ? Number(anchor.width) || 0 : size.width
    const ah = anchor ? Number(anchor.height) || 0 : 0
    const align = typeof alignment === 'string' ? alignment : ''

    let x = parentBounds.x + ax + aw - size.width
    let y = parentBounds.y + ay + ah + POSITION_PADDING
    if (align.includes('right')) x = parentBounds.x + ax
    if (align.includes('top')) y = parentBounds.y + ay - size.height - POSITION_PADDING

    try {
      const area = screen.getDisplayMatching(parentBounds).workArea
      x = Math.min(Math.max(x, area.x), Math.max(area.x, area.x + area.width - size.width))
      y = Math.min(Math.max(y, area.y), Math.max(area.y, area.y + area.height - size.height))
    } catch (_) { /* 拿不到显示器信息（无头 / 极端时序）就按算出来的坐标放，不阻塞打开 */ }
    return { x: Math.floor(x), y: Math.floor(y) }
  }

  /** 把「尺寸 + 落点」一次性写进窗口（frame:false 下窗口 bounds 与内容 bounds 重合）。 */
  function applyBounds(entry: ExtensionPopupEntry): void {
    if (!isAlive(entry.win) || !isAlive(entry.parent)) return
    const pos = computePosition(entry.parent, entry.anchorRect, entry.alignment, {
      width: entry.width,
      height: entry.height
    })
    try {
      entry.win.setContentBounds({ x: pos.x, y: pos.y, width: entry.width, height: entry.height })
    } catch (_) {}
  }

  /**
   * 父窗口移动 / 尺寸变化 / 页面滚动导致的锚点失效处理。
   *
   * ── 为什么是「重定位」而不是一律关闭 ──────────────────────────────────
   * anchorRect 是**相对父窗口内容区**的坐标，父窗口平移时按钮在内容区里的位置不变，
   * 所以同一份 rect 仍然成立 —— 重算一次落点即可，弹窗跟着窗口走，手感才对。
   * 只有当锚点被拖出内容区（窗口缩小 / 面板滚动把按钮顶没了）时，锚定语义已经不成立，
   * 这时才关闭：继续飘在窗口外比关掉更让人困惑。
   */
  function reposition(entry: ExtensionPopupEntry): void {
    if (!isAlive(entry.win) || !isAlive(entry.parent)) return
    const anchor = entry.anchorRect
    if (anchor && typeof anchor.x === 'number' && typeof anchor.y === 'number') {
      const bounds = entry.parent.getContentBounds()
      const w = Number(anchor.width) || 0
      const h = Number(anchor.height) || 0
      const outOfView = (anchor.x + w) < 0 || anchor.x > bounds.width || (anchor.y + h) < 0 || anchor.y > bounds.height
      if (outOfView) { close(); return }
    }
    applyBounds(entry)
  }

  /** 内容自适应：等页面渲染完量一次实际尺寸（对齐 ECE 的 preferred-size 逻辑）。 */
  function measureContent(entry: ExtensionPopupEntry): void {
    if (!isAlive(entry.win)) return
    let script
    try {
      script = '(() => { const b = document.body; if (!b) return null; const r = b.getBoundingClientRect();' +
        ' return { width: Math.ceil(Math.max(r.width, b.scrollWidth)), height: Math.ceil(Math.max(r.height, b.scrollHeight)) } })()'
    } catch (_) { return }
    entry.win.webContents.executeJavaScript(script).then((size: unknown) => {
      if (!size || !isAlive(entry.win) || current !== entry) return
      const measured = size as { width?: unknown; height?: unknown }
      const width = Number(measured.width)
      const height = Number(measured.height)
      if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) return
      // 只放大到「内容需要的大小」，且不超过上限；页面用 height:100% 时量到的是窗口高度
      // → 新尺寸与旧尺寸相等 → 下面的判断直接跳过，不会来回抖动。
      const nextWidth = Math.max(Math.min(width, MAX_WIDTH), cfg.minWidth || 0)
      const nextHeight = Math.max(Math.min(height, MAX_HEIGHT), cfg.minHeight || 0)
      if (nextWidth === entry.width && nextHeight === entry.height) return
      entry.width = nextWidth
      entry.height = nextHeight
      applyBounds(entry)
    }).catch(() => { /* 页面脚本报错不影响弹窗（照旧用配置尺寸） */ })
  }

  /** 卸掉这个弹窗挂在父窗口上的监听（父窗口可能比弹窗活得久）。 */
  function detach(entry: ExtensionPopupEntry | null): void {
    if (!entry) return
    const parent = entry.parent
    if (isAlive(parent) && typeof parent.removeListener === 'function') {
      try { parent.removeListener('move', entry.onParentMove) } catch (_) {}
      try { parent.removeListener('resize', entry.onParentResize) } catch (_) {}
      try { parent.removeListener('closed', entry.onParentClosed) } catch (_) {}
    }
    entry.parent = null
  }

  /** 关闭并**释放**当前弹窗（destroy 而不是 close/hide：渲染进程内存要真的还回去）。 */
  function close(): void {
    const entry = current
    if (!entry) return
    current = null
    detach(entry)
    const win = entry.win
    try { if (isAlive(win)) win.destroy() } catch (_) {}
  }

  /** 打开扩展弹窗。 */
  function open({ url, extensionId, session, parentWindow, anchorRect, alignment }: ExtensionPopupOpenOptions): boolean {
    if (!url || !createSubWindow) return false
    // 再点同一个扩展 = 收起（toggle），与 ECE / RT 一致。
    const existing = current
    const sameExtension = Boolean(existing && existing.extensionId === extensionId)
    if (current) close()
    if (sameExtension) return true

    const parent = isAlive(parentWindow) ? parentWindow : null
    const width = cfg.width || 360
    const height = cfg.height || 560
    const pos = parent ? computePosition(parent, anchorRect, alignment, { width, height }) : null

    let created: { win: BrowserWindow }
    try {
      created = createSubWindow({
        url,
        width,
        height,
        // 有父窗口才给落点：没有父窗口时让系统决定，硬给 (0,0) 会把弹窗扔到屏幕左上角。
        ...(pos ? { x: pos.x, y: pos.y } : {}),
        minWidth: cfg.minWidth,
        minHeight: cfg.minHeight,
        // modal:false —— 弹窗绝不能锁死父窗口（用户要能继续点别处，点了就失焦关闭）。
        modal: false,
        parent: parent || undefined,
        frame: cfg.frame,
        alwaysOnTop: cfg.alwaysOnTop,
        autoHideMenuBar: cfg.autoHideMenuBar,
        skipTaskbar: cfg.skipTaskbar,
        resizable: cfg.resizable,
        minimizable: cfg.minimizable,
        maximizable: cfg.maximizable,
        fullscreenable: cfg.fullscreenable,
        showOnReady: cfg.showOnReady,
        backgroundColor: cfg.backgroundColor,
        windowType,
        windowRegistry,
        webPreferences: {
          // ✅ 关键：绑到该扩展所属 profile 的会话。用默认会话会让 popup 里的
          //    chrome.* API 全部失效（扩展根本没在这个会话里注册）。
          session,
          // 扩展页是**非特权页面**：不要注入 hira 的 shell preload（否则 window.hira
          // 会暴露给扩展自己的页面）。contextIsolation / sandbox / 关 node 由
          // webPreferences.js 的安全基线兜住。
          enablePreferredSizeMode: true
        }
      })
    } catch (e) {
      console.warn('[extension-popup] create window failed:', errorMessage(e))
      return false
    }

    const win = created && created.win
    if (!isAlive(win)) return false

    const entry: ExtensionPopupEntry = {
      win,
      parent,
      extensionId,
      anchorRect,
      alignment,
      width,
      height,
      onParentMove: () => reposition(entry),
      onParentResize: () => reposition(entry),
      onParentClosed: () => close()
    }
    current = entry

    // 失焦即关（点页面其它地方 / 点父窗口 / 切到别的应用都会触发）。
    // 例外与 ECE 一致：DevTools 开着时不关 —— 否则一按 F12 弹窗就没了，没法调扩展。
    win.on('blur', () => {
      try { if (win.webContents.isDevToolsOpened()) return } catch (_) {}
      if (current === entry) close()
    })
    win.on('closed', () => {
      if (current === entry) { current = null; detach(entry) }
    })

    if (parent) {
      parent.on('move', entry.onParentMove)
      parent.on('resize', entry.onParentResize)
      parent.once('closed', entry.onParentClosed)
    }

    // 内容自适应：页面渲染完再量一次，按实际大小重排（此时右边 / 下边已经锚好）。
    win.webContents.once('did-finish-load', () => { measureContent(entry) })

    return true
  }

  /**
   * 登记 **ECE 自己建的** 弹窗窗口（对齐 RT：windowsController.extensionPopup.new(...)）。
   * 窗口的生命周期（尺寸自适应 / 失焦自关 / destroy）由 ECE 的 PopupView 负责，
   * 这里只把它纳入窗口注册表的 extension-popup 类型维度。
   */
  function track(popup: { browserWindow?: BrowserWindow | null } | null | undefined): void {
    const win = popup && popup.browserWindow
    if (!isAlive(win) || !windowRegistry || typeof windowRegistry.register !== 'function') return
    try { windowRegistry.register(win, windowType) } catch (_) {}
  }

  return {
    open,
    close,
    track,
    isOpen: () => Boolean(current && isAlive(current.win))
  }
}
