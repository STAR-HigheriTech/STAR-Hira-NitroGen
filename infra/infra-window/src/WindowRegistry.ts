/**
 * WindowRegistry —— 窗口登记表 + **类型维度**（对齐 RT `WindowsController` / `WindowTypeManager`）。
 *
 * RT 的 `windowsController` 是一张 `Map<id, BaseWindow>`，每个窗口带 `type`，
 * 再以 `WindowTypeManager` 提供「按类型取窗口 / 单例窗口」等语义。NG 此前只有一张
 * 无类型的 `Map<id, win>`，导致「单例子窗口」这类语义散落在 main.js 里各写一份
 * `openWindows` Map（与注册表重复、易漂移）。
 *
 * 这里把类型维度收进注册表本身：
 *   - `register(win, type)` 记下类型；
 *   - `listByType(type)` 按类型枚举（对齐 RT `getAll`）；
 *   - `getSingleton(type)` 取该类型现存窗口（对齐 RT `getExistingSingletonWindow`），
 *     并顺手 GC 已销毁条目，避免调用方拿到僵尸窗口。
 *
 * 本模块**无 Electron 依赖**：只依赖 `win.id` / `win.isDestroyed` 两个鸭子类型字段。
 */
export interface RegisteredWindow {
  readonly id: number
  once?(event: 'closed', listener: () => void): unknown
  isDestroyed?(): boolean
}

export class WindowRegistry<WindowType extends RegisteredWindow = RegisteredWindow> {
  private readonly _byId = new Map<number, WindowType>()
  private readonly _types = new Map<number, string>()

  /**
   */
  register(win: WindowType | null | undefined, type = 'browser'): number {
    if (!win) throw new Error('win is required')
    const id = typeof win.id === 'number' ? win.id : null
    if (id == null) throw new Error('win.id is required')
    this._byId.set(id, win)
    this._types.set(id, String(type || 'browser'))
    // 自清理：窗口 closed 即出表（对齐 RT `window.on("destroyed", …)`），
    // 调用方无需再手动 unregister，杜绝僵尸条目。
    if (typeof win.once === 'function') {
      try { win.once('closed', () => this.unregisterById(id)) } catch (_) {}
    }
    return id
  }

  unregisterById(id: number): void {
    this._byId.delete(id)
    this._types.delete(id)
  }

  getById(id: number): WindowType | null {
    return this._byId.get(id) || null
  }

  getType(id: number): string | null {
    return this._types.get(id) || null
  }

  listIds(): number[] {
    return Array.from(this._byId.keys())
  }

  list(): WindowType[] {
    return Array.from(this._byId.values())
  }

  /** 按类型枚举窗口（对齐 RT `WindowTypeManager.getAll`）。 */
  listByType(type: string): WindowType[] {
    const out: WindowType[] = []
    for (const [id, win] of this._byId) {
      if (this._types.get(id) === type) out.push(win)
    }
    return out
  }

  /**
   * 取该类型的现存窗口；不存在返回 null（对齐 RT `getExistingSingletonWindow`）。
   * 顺手 GC 已销毁条目，避免调用方拿到僵尸窗口。
   */
  getSingleton(type: string): WindowType | null {
    for (const [id, win] of this._byId) {
      if (this._types.get(id) !== type) continue
      if (typeof win.isDestroyed === 'function' && win.isDestroyed()) {
        this.unregisterById(id)
        continue
      }
      return win
    }
    return null
  }
}
