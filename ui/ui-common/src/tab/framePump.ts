/** 共享帧泵：一条 rAF，先统一 measure，再统一 paint。 */

export interface FrameSink {
  measure?: () => void
  paint?: () => void
}

export interface FrameView {
  requestAnimationFrame: (callback: FrameRequestCallback) => number
  cancelAnimationFrame: (handle: number) => void
  performance?: { now: () => number }
}

export interface FramePumpOptions {
  durationMs?: number
  alive?: () => boolean
}

export interface FramePump {
  register: (sink: FrameSink | null | undefined) => () => void
  ping: (ms?: number) => void
  stop: () => void
  isRunning: () => boolean
  dispose: () => void
}

const GEOMETRY_PROP_RE = new RegExp(
  '^(?:' + [
    '(?:min-|max-)?(?:width|height|inline-size|block-size)',
    '(?:margin|padding|inset)(?:-(?:top|right|bottom|left|block|inline|start|end))*',
    'top|right|bottom|left',
    'gap|row-gap|column-gap|flex|flex-basis|flex-grow|flex-shrink',
    'transform|translate|rotate|scale|font-size|line-height',
    'border(?:-(?:top|right|bottom|left))?-width'
  ].join('|') + ')$'
)

/** 只识别会移动矩形的属性，颜色与滤镜不触发逐帧重绘。 */
export function isGeometryProperty(name: string): boolean {
  if (typeof name !== 'string' || name === '') return false
  return GEOMETRY_PROP_RE.test(name.trim().toLowerCase())
}

export function createFramePump(
  view?: Partial<FrameView> | null,
  options: FramePumpOptions = {}
): FramePump {
  const win: FrameView = view && typeof view.requestAnimationFrame === 'function'
    ? view as FrameView
    : globalThis as unknown as FrameView
  const clock = win.performance && typeof win.performance.now === 'function'
    ? win.performance
    : globalThis.performance
  const defaultMs = Number.isFinite(options.durationMs) ? options.durationMs as number : 260
  const alive = typeof options.alive === 'function' ? options.alive : null

  const sinks = new Set<FrameSink>()
  let frame = 0
  let until = 0
  let disposed = false

  const run = (): void => {
    frame = 0
    if (disposed) return
    if (alive && !alive()) {
      until = 0
      return
    }

    for (const sink of sinks) sink.measure?.()
    for (const sink of sinks) sink.paint?.()
    if (clock.now() < until) frame = win.requestAnimationFrame(run)
  }

  const ping = (ms?: number): void => {
    if (disposed) return
    const next = clock.now() + (Number.isFinite(ms) ? ms as number : defaultMs)
    if (next > until) until = next
    if (!frame) frame = win.requestAnimationFrame(run)
  }

  const stop = (): void => {
    if (frame) win.cancelAnimationFrame(frame)
    frame = 0
    until = 0
  }

  const register = (sink: FrameSink | null | undefined): (() => void) => {
    if (!sink) return () => {}
    sinks.add(sink)
    return () => {
      sinks.delete(sink)
    }
  }

  return {
    register,
    ping,
    stop,
    isRunning: () => frame !== 0,
    dispose: () => {
      disposed = true
      stop()
      sinks.clear()
    }
  }
}

export interface GeometryMotionOptions {
  durationMs?: number
  filter?: (name: string) => boolean
}

/** 把几何属性上的 transitionrun / transitionstart 续期到同一个帧泵窗口。 */
export function relayGeometryMotion(
  root: HTMLElement | Document | null | undefined,
  ping: (ms: number) => void,
  options: GeometryMotionOptions = {}
): () => void {
  if (!root || typeof root.addEventListener !== 'function' || typeof ping !== 'function') {
    return () => {}
  }

  const ms = Number.isFinite(options.durationMs) ? options.durationMs as number : 260
  const hitTest = typeof options.filter === 'function' ? options.filter : isGeometryProperty
  const onTransition = (event: Event): void => {
    const propertyName = (event as TransitionEvent).propertyName
    if (hitTest(propertyName)) ping(ms)
  }

  root.addEventListener('transitionrun', onTransition, true)
  root.addEventListener('transitionstart', onTransition, true)
  return () => {
    root.removeEventListener('transitionrun', onTransition, true)
    root.removeEventListener('transitionstart', onTransition, true)
  }
}
