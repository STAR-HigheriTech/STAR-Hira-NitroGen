/**
 * 标签变更的统一派发器。
 *
 * 负责一帧合批、立即派发、批量嵌套折叠和布局标记。TabManager 只提供
 * 当前标签快照与外部 emit，不再承载事件节流状态。
 */
interface TabLayoutPort {
  adoptLoosePinnedTabs(host: TabChangeHost, options: { notify: boolean }): void
  enforceSplitRuns(host: TabChangeHost): void
  listProjectionOf(host: TabChangeHost, tabs: unknown[]): unknown
}

export interface TabChangeHost {
  list(): unknown[]
  _emit(channel: 'tab:changed', payload: { tabs: unknown[]; projection: unknown }): void
}

const tabLayout = require('./tabLayout') as TabLayoutPort

const EMIT_COALESCE_MS = 16

export class TabChangeEmitter {
  private readonly _host: TabChangeHost
  private readonly _coalesceMs: number
  private _pending: boolean
  private _timer: ReturnType<typeof setTimeout> | null
  private _needsLayout: boolean
  private _deferDepth: number
  private _deferred: boolean
  /**
   * @param {object} host TabManager 兼容宿主
   * @param {{ coalesceMs?: number }} [options]
   */
  constructor(host: TabChangeHost, { coalesceMs = EMIT_COALESCE_MS }: { coalesceMs?: number } = {}) {
    this._host = host
    this._coalesceMs = coalesceMs
    this._pending = false
    this._timer = null
    this._needsLayout = true
    this._deferDepth = 0
    this._deferred = false
  }

  flush(): void {
    const needsLayout = this._needsLayout !== false
    this._needsLayout = true
    if (needsLayout) {
      tabLayout.adoptLoosePinnedTabs(this._host, { notify: false })
      tabLayout.enforceSplitRuns(this._host)
    }

    const tabs = this._host.list()
    this._host._emit('tab:changed', {
      tabs,
      projection: tabLayout.listProjectionOf(this._host, tabs)
    })
  }

  schedule(options?: { layout?: boolean }): void {
    if (!options || options.layout !== false) this._needsLayout = true
    if (this._pending) return
    this._pending = true
    this._timer = setTimeout(() => {
      this._timer = null
      this._pending = false
      this.flush()
    }, this._coalesceMs)
  }

  emitNow(): void {
    if (this._deferDepth > 0) {
      this._deferred = true
      return
    }
    if (this._timer) {
      clearTimeout(this._timer)
      this._timer = null
    }
    this._pending = false
    this.flush()
  }

  withBatch<T>(fn: () => T): T {
    this._deferDepth += 1
    try {
      return fn()
    } finally {
      this._deferDepth -= 1
      if (this._deferDepth === 0 && this._deferred) {
        this._deferred = false
        this.emitNow()
      }
    }
  }

  cancel(): void {
    if (this._timer) {
      clearTimeout(this._timer)
      this._timer = null
    }
    this._pending = false
    this._needsLayout = true
  }
}

export { EMIT_COALESCE_MS }
