/**
 * 信息层浮层的指针避让。
 *
 * 原生 WebContentsView 会吃掉矩形内的鼠标事件，指针压在提示条上时会形成
 * “显示 → 失焦 → 收起 → 再显示”的抖动环。本控制器在指针靠近时让开，
 * 离开后才允许宿主恢复，并且只在登记表活跃时启动轮询。
 */

const POINTER_AVOID_POLL_MS = 1000 / 30
const DEFAULT_POINTER_AVOID_PAD = 16

interface ScreenPoint { x: number; y: number }
interface FloatRect { x: number; y: number; width: number; height: number }
interface FloatWindow {
  isDestroyed(): boolean
  getContentBounds(): FloatRect
}
interface PointerAvoidOptions {
  pad?: number
  onAvoid?: () => void
  onRestore?: () => void
}
interface PointerAvoidEntry {
  pad: number
  onAvoid: (() => void) | null
  onRestore: (() => void) | null
  suppressed: boolean
  rect: FloatRect | null
}
interface FloatPointerAvoidDependencies {
  window: FloatWindow | null
  getCursorPoint(): ScreenPoint
  isWindowInteractive(): boolean
  isFloatVisible(name: string): boolean
  getFloatBounds(name: string): FloatRect | undefined
  hideFloat(name: string): void
}

export class FloatPointerAvoidController {
  private readonly _window: FloatWindow | null
  private readonly _getCursorPoint: FloatPointerAvoidDependencies['getCursorPoint']
  private readonly _isWindowInteractive: FloatPointerAvoidDependencies['isWindowInteractive']
  private readonly _isFloatVisible: FloatPointerAvoidDependencies['isFloatVisible']
  private readonly _getFloatBounds: FloatPointerAvoidDependencies['getFloatBounds']
  private readonly _hideFloat: FloatPointerAvoidDependencies['hideFloat']
  private readonly _entries = new Map<string, PointerAvoidEntry>()
  private _timer: ReturnType<typeof setInterval> | null = null

  /**
   * @param {object} deps
   * @param {object} deps.window
   * @param {() => { x: number, y: number }} deps.getCursorPoint
   * @param {() => boolean} deps.isWindowInteractive
   * @param {(name: string) => boolean} deps.isFloatVisible
   * @param {(name: string) => object|undefined} deps.getFloatBounds
   * @param {(name: string) => void} deps.hideFloat
   */
  constructor({
    window,
    getCursorPoint,
    isWindowInteractive,
    isFloatVisible,
    getFloatBounds,
    hideFloat
  }: FloatPointerAvoidDependencies) {
    this._window = window
    this._getCursorPoint = getCursorPoint
    this._isWindowInteractive = isWindowInteractive
    this._isFloatVisible = isFloatVisible
    this._getFloatBounds = getFloatBounds
    this._hideFloat = hideFloat
  }

  set(name: string, options: PointerAvoidOptions = {}): void {
    const key = String(name)
    const previous = this._entries.get(key)
    this._entries.set(key, {
      pad: Math.max(0, Math.floor(options.pad == null ? DEFAULT_POINTER_AVOID_PAD : options.pad)),
      onAvoid: typeof options.onAvoid === 'function' ? options.onAvoid : null,
      onRestore: typeof options.onRestore === 'function' ? options.onRestore : null,
      suppressed: previous ? previous.suppressed : false,
      rect: previous ? previous.rect : null
    })
    this.ensure()
  }

  clear(name: string): void {
    this._entries.delete(String(name))
    if (this._entries.size === 0) this.stop()
  }

  isAvoided(name: string): boolean {
    const entry = this._entries.get(String(name))
    return !!(entry && entry.suppressed)
  }

  has(name: string): boolean {
    return this._entries.has(String(name))
  }

  ensure(): void {
    if (this._timer || this._entries.size === 0 || !this._isWindowInteractive()) return
    this._timer = setInterval(() => {
      try { this.tick() } catch (_) {}
    }, POINTER_AVOID_POLL_MS)
    if (typeof this._timer.unref === 'function') this._timer.unref()
  }

  stop(): void {
    if (!this._timer) return
    clearInterval(this._timer)
    this._timer = null
  }

  clearAll(): void {
    this._entries.clear()
    this.stop()
  }

  tick(): void {
    const window = this._window
    if (!window || window.isDestroyed()) {
      this.clearAll()
      return
    }
    if (this._entries.size === 0) {
      this.stop()
      return
    }

    let content: FloatRect | null = null
    let point: ScreenPoint | null = null
    try { content = window.getContentBounds() } catch (_) {}
    try { point = this._getCursorPoint() } catch (_) {}
    if (!content || !point) return

    const x = point.x - content.x
    const y = point.y - content.y
    let anyActive = false
    for (const [name, entry] of this._entries) {
      const visible = this._isFloatVisible(name)
      if (!visible && !entry.suppressed) continue
      anyActive = true

      const rect = entry.suppressed && entry.rect ? entry.rect : this._getFloatBounds(name)
      if (!rect || !(rect.width > 0) || !(rect.height > 0)) continue
      const inside =
        x >= rect.x - entry.pad &&
        x <= rect.x + rect.width + entry.pad &&
        y >= rect.y - entry.pad &&
        y <= rect.y + rect.height + entry.pad

      if (inside && visible) {
        entry.suppressed = true
        entry.rect = { x: rect.x, y: rect.y, width: rect.width, height: rect.height }
        try { this._hideFloat(name) } catch (_) {}
        try { entry.onAvoid?.() } catch (_) {}
      } else if (!inside && entry.suppressed) {
        entry.suppressed = false
        entry.rect = null
        try { entry.onRestore?.() } catch (_) {}
      }
    }
    if (!anyActive) this.stop()
  }
}
