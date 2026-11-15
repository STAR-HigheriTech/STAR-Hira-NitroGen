/**
 * 浮层 bounds 的唯一写入口。
 *
 * 显隐跳变引发的节流、焦点归还、拖拽守卫、闲置回收全部在这里串联，
 * 避免各 IPC 路径只改 bounds 却漏掉生命周期副作用。
 */

interface BoundsRect { x: number; y: number; width: number; height: number }
interface FloatView {
  webContents?: { isFocused?(): boolean } | null
  setBounds(bounds: BoundsRect): void
}
interface FloatBoundsDependencies {
  getView(name: string): FloatView | null | undefined
  getBounds(name: string): BoundsRect | null | undefined
  setBounds(name: string, rect: BoundsRect, view: FloatView): void
  syncThrottle(name: string, throttled: boolean): void
  syncDragGuard(): void
  hasDismissOutside(name: string): boolean
  syncDismissSources(): void
  raiseFloat(name: string): void
  restoreFocusTo(holder: unknown): void
  scheduleReclaim(name: string): void
  cancelReclaim(name: string): void
  setInteractive(name: string, interactive: boolean): void
  isWebContentsFocused(webContents: { isFocused?(): boolean }): boolean
  reallocateFocus(): void
  restoreContentFocus(options: { reason: string; immediate: boolean; retries: boolean }): void
  takeFocusHolder(name: string): unknown
  selfFocusFloats: ReadonlySet<string>
  hideFocusReallocFloats: ReadonlySet<string>
  logger?: Pick<Console, 'error'>
}

export class FloatBoundsController {
  private readonly _getView: FloatBoundsDependencies['getView']
  private readonly _getBounds: FloatBoundsDependencies['getBounds']
  private readonly _setBounds: FloatBoundsDependencies['setBounds']
  private readonly _syncThrottle: FloatBoundsDependencies['syncThrottle']
  private readonly _syncDragGuard: FloatBoundsDependencies['syncDragGuard']
  private readonly _hasDismissOutside: FloatBoundsDependencies['hasDismissOutside']
  private readonly _syncDismissSources: FloatBoundsDependencies['syncDismissSources']
  private readonly _raiseFloat: FloatBoundsDependencies['raiseFloat']
  private readonly _restoreFocusTo: FloatBoundsDependencies['restoreFocusTo']
  private readonly _scheduleReclaim: FloatBoundsDependencies['scheduleReclaim']
  private readonly _cancelReclaim: FloatBoundsDependencies['cancelReclaim']
  private readonly _setInteractive: FloatBoundsDependencies['setInteractive']
  private readonly _isWebContentsFocused: FloatBoundsDependencies['isWebContentsFocused']
  private readonly _reallocateFocus: FloatBoundsDependencies['reallocateFocus']
  private readonly _restoreContentFocus: FloatBoundsDependencies['restoreContentFocus']
  private readonly _takeFocusHolder: FloatBoundsDependencies['takeFocusHolder']
  private readonly _selfFocusFloats: ReadonlySet<string>
  private readonly _hideFocusReallocFloats: ReadonlySet<string>
  private readonly _logger: Pick<Console, 'error'>

  /** @param {object} deps */
  constructor({
    getView,
    getBounds,
    setBounds,
    syncThrottle,
    syncDragGuard,
    hasDismissOutside,
    syncDismissSources,
    raiseFloat,
    restoreFocusTo,
    scheduleReclaim,
    cancelReclaim,
    setInteractive,
    isWebContentsFocused,
    reallocateFocus,
    restoreContentFocus,
    takeFocusHolder,
    selfFocusFloats,
    hideFocusReallocFloats,
    logger = console
  }: FloatBoundsDependencies) {
    this._getView = getView
    this._getBounds = getBounds
    this._setBounds = setBounds
    this._syncThrottle = syncThrottle
    this._syncDragGuard = syncDragGuard
    this._hasDismissOutside = hasDismissOutside
    this._syncDismissSources = syncDismissSources
    this._raiseFloat = raiseFloat
    this._restoreFocusTo = restoreFocusTo
    this._scheduleReclaim = scheduleReclaim
    this._cancelReclaim = cancelReclaim
    this._setInteractive = setInteractive
    this._isWebContentsFocused = isWebContentsFocused
    this._reallocateFocus = reallocateFocus
    this._restoreContentFocus = restoreContentFocus
    this._takeFocusHolder = takeFocusHolder
    this._selfFocusFloats = selfFocusFloats
    this._hideFocusReallocFloats = hideFocusReallocFloats
    this._logger = logger
  }

  set(name: string, rect: BoundsRect, options: { keepFocus?: boolean } = {}): void {
    const key = String(name)
    const view = this._getView(key)
    if (!view) return

    try {
      const x = Math.max(0, Math.floor(rect.x || 0))
      const y = Math.max(0, Math.floor(rect.y || 0))
      const width = Math.max(0, Math.floor(rect.width || 0))
      const height = Math.max(0, Math.floor(rect.height || 0))
      const next = { x, y, width, height }
      const previous = this._getBounds(key)
      if (
        previous &&
        previous.x === x &&
        previous.y === y &&
        previous.width === width &&
        previous.height === height
      ) {
        return
      }

      const visible = width > 0 && height > 0
      const wasVisible = !!previous && previous.width > 0 && previous.height > 0
      const focusHolder =
        visible && !wasVisible && !this._selfFocusFloats.has(key)
          ? this._takeFocusHolder(key)
          : null

      if (visible !== wasVisible) this._syncThrottle(key, !visible)
      this._setBounds(key, next, view)
      this._syncDragGuard()
      if (this._hasDismissOutside(key) && visible !== wasVisible) {
        this._syncDismissSources()
      }
      if (visible && !wasVisible) this._raiseFloat(key)
      if (focusHolder) this._restoreFocusTo(focusHolder)

      if (!visible) {
        this._scheduleReclaim(key)
        this._setInteractive(key, false)
        if (options.keepFocus !== true) {
          const webContents = view.webContents
          const holdsKeyboard = !!webContents && this._isWebContentsFocused(webContents)
          if (this._hideFocusReallocFloats.has(key) || holdsKeyboard) {
            setImmediate(() => {
              try {
                if (holdsKeyboard) {
                  this._restoreContentFocus({
                    reason: 'float-hidden',
                    immediate: true,
                    retries: false
                  })
                } else {
                  this._reallocateFocus()
                }
              } catch (_) {}
            })
          }
        }
      } else {
        this._cancelReclaim(key)
      }
    } catch (error) {
      this._logger.error(`[layout] setFloatBounds(${key}) failed:`, error instanceof Error ? error.message : error)
    }
  }
}
