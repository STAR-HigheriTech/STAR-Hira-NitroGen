/**
 * 扫码取景框的生命周期与几何控制器。
 *
 * 窗口创建仍由 APPS 层注入；本模块只持有取景框状态、拖动矩形和抓屏授权窗口。
 * 几何换算与渲染层共用 qrScanCropRect，避免主进程与框页量出两块不同区域。
 */

/**
 * @param {object} deps
 * @param {{ getSingleton: (type: string) => Electron.BrowserWindow|null }} deps.windowRegistry
 * @param {string} deps.windowType
 * @param {(type: string, payload: unknown, parent: object) => object} deps.openSubWindow
 * @param {() => object} deps.getParentRuntime
 * @param {(bounds: object) => object} deps.cropRect
 * @param {() => object} deps.getScreen
 * @param {number} deps.barHeight
 * @param {number} deps.settleMs
 * @param {number} deps.captureArmMs
 */
function createQrScanFrameController({
  windowRegistry,
  windowType,
  openSubWindow,
  getParentRuntime,
  cropRect,
  getScreen,
  barHeight,
  settleMs,
  captureArmMs
}: {
  windowRegistry: { getSingleton: (type: string) => Electron.BrowserWindow | null }
  windowType: string
  openSubWindow: (type: string, payload: unknown, parent: object) => object
  getParentRuntime: () => object
  cropRect: (bounds: Electron.Rectangle) => Electron.Rectangle | null
  getScreen: () => Electron.Screen
  barHeight: number
  settleMs: number
  captureArmMs: number
}) {
  let interacting = false
  let busyUntil = 0
  let onClosed: (() => void) | null = null
  let dragOrigin: { x: number; y: number; width: number; height: number } | null = null
  let captureArmedUntil = 0
  let closedHandlerBound = false

  const MIN_BOX = 160
  const MIN_HEIGHT = MIN_BOX + barHeight

  function frameWindow() {
    const win = windowRegistry.getSingleton(windowType)
    return win && !win.isDestroyed() ? win : null
  }

  function resetInteraction() {
    interacting = false
    busyUntil = 0
    dragOrigin = null
  }

  function open() {
    const result = openSubWindow(windowType, undefined, getParentRuntime())
    resetInteraction()
    captureArmedUntil = Date.now() + captureArmMs

    try {
      const win = frameWindow()
      if (!win) return result

      try { win.setContentProtection(true) } catch (_) {}

      if (!closedHandlerBound) {
        closedHandlerBound = true
        win.once('closed', () => {
          closedHandlerBound = false
          resetInteraction()
          captureArmedUntil = 0
          if (onClosed) {
            try { onClosed() } catch (_) {}
          }
        })
      }

      const screen = getScreen()
      const point = screen.getCursorScreenPoint()
      const area = screen.getDisplayNearestPoint(point).workArea
      const bounds = win.getBounds()
      win.setBounds({
        x: Math.max(area.x, Math.min(Math.round(point.x - bounds.width / 2), area.x + area.width - bounds.width)),
        y: Math.max(area.y, Math.min(Math.round(point.y - bounds.height / 2), area.y + area.height - bounds.height)),
        width: bounds.width,
        height: bounds.height
      })
    } catch (_) {}

    return result
  }

  function close() {
    resetInteraction()
    captureArmedUntil = 0
    const win = frameWindow()
    if (win) {
      try { win.close() } catch (_) {}
    }
    return { ok: true, open: false }
  }

  function drag({ mode, edge, dx, dy }: {
    mode?: string
    edge?: string
    dx?: number
    dy?: number
  } = {}) {
    const win = frameWindow()
    if (!win || !Number.isFinite(dx) || !Number.isFinite(dy)) return { ok: false }
    const deltaX = dx as number
    const deltaY = dy as number
    if (!dragOrigin) {
      try { dragOrigin = win.getBounds() } catch (_) { return { ok: false } }
    }
    if (!dragOrigin) return { ok: false }

    const origin = dragOrigin
    let x = origin.x
    let y = origin.y
    let width = origin.width
    let height = origin.height

    if (mode === 'resize') {
      const direction = typeof edge === 'string' ? edge : ''
      if (direction.includes('l')) { x = origin.x + deltaX; width = origin.width - deltaX }
      if (direction.includes('r')) width = origin.width + deltaX
      if (direction.includes('t')) { y = origin.y + deltaY; height = origin.height - deltaY }
      if (direction.includes('b')) height = origin.height + deltaY
      if (width < MIN_BOX) {
        if (direction.includes('l')) x = origin.x + (origin.width - MIN_BOX)
        width = MIN_BOX
      }
      if (height < MIN_HEIGHT) {
        if (direction.includes('t')) y = origin.y + (origin.height - MIN_HEIGHT)
        height = MIN_HEIGHT
      }
    } else {
      x = origin.x + deltaX
      y = origin.y + deltaY
    }

    const rect = {
      x: Math.round(x),
      y: Math.round(y),
      width: Math.max(MIN_BOX, Math.round(width)),
      height: Math.max(MIN_HEIGHT, Math.round(height))
    }
    let current = null
    try { current = win.getBounds() } catch (_) {}
    if (
      current &&
      current.x === rect.x &&
      current.y === rect.y &&
      current.width === rect.width &&
      current.height === rect.height
    ) {
      return { ok: true, ...rect }
    }
    try { win.setBounds(rect) } catch (_) { return { ok: false } }
    return { ok: true, ...rect }
  }

  function setInteracting(active: boolean) {
    if (active === true) {
      interacting = true
      dragOrigin = null
      busyUntil = 0
    } else {
      interacting = false
      busyUntil = Date.now() + settleMs
    }
    return { ok: true }
  }

  function bounds() {
    const win = frameWindow()
    if (!win) return null
    try {
      if (!win.isVisible()) return null
      return win.getBounds()
    } catch (_) {
      return null
    }
  }

  function geometry() {
    const win = frameWindow()
    if (!win) {
      return { ok: false, open: false, crop: null, display: null, reason: '取景框未打开' }
    }

    let frameBounds = null
    try {
      frameBounds = win.getBounds()
    } catch (_) {
      return { ok: false, open: true, crop: null, display: null, reason: '读不到取景框位置' }
    }

    const crop = cropRect(frameBounds)
    let display = null
    try {
      const screen = getScreen()
      const target = crop ? screen.getDisplayMatching(crop) : screen.getDisplayMatching(frameBounds)
      if (target) {
        display = {
          x: target.bounds.x,
          y: target.bounds.y,
          width: target.size.width,
          height: target.size.height
        }
      }
    } catch (_) {}

    return { ok: !!crop && !!display, open: true, crop: crop || null, display }
  }

  return {
    allowCapture: () => !!frameWindow() || Date.now() < captureArmedUntil,
    bounds,
    close,
    drag,
    geometry,
    isBusy: () => interacting || Date.now() < busyUntil,
    isOpen: () => !!frameWindow(),
    open,
    setInteracting,
    setOnClosed(fn: (() => void) | null) {
      onClosed = typeof fn === 'function' ? fn : null
    }
  }
}

module.exports = { createQrScanFrameController }
