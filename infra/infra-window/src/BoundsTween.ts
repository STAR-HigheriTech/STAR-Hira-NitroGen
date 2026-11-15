/**
 * BoundsTween —— bounds 的「时长 + 缓动曲线」动画控制器（对齐 RT SidebarInterpolation）。
 *
 * ── 为什么必须是「绝对时间 + 曲线」，而不是弹簧 ─────────────────────────────
 * 弹簧是按帧积分速度的模型（`v += (Δ·k − v·c)·dt`）：每一帧的位移都取决于上一帧的
 * dt，而 dt 在真实环境里必然抖动（主进程 GC、IPC 突发、定时器毫秒级分辨率），并且
 * **必须被截断**（否则一次长停顿会让下一帧跨过目标、来回过冲）。截断意味着动画落后于
 * 墙钟，随后几帧再把落下的部分补回来 —— 观感就是「缓动途中一顿一顿地抖」。
 *
 * 本模块每帧只做一件事：把**墙钟进度** `(now − start) / duration` 喂给缓动曲线，
 * 用曲线值在「本段起点 → 目标」之间插值。慢帧只是让采样变疏，曲线本身绝不会变形，
 * 所以无论帧率怎么掉，运动轨迹始终是同一条曲线（RT 的 sidebar 动画就是这套）。
 *
 * 第二条理由：弹簧是欠阻尼的，末端**过冲后回弹**；整数化到 bounds 上就是边缘在终点
 * 来回弹 1~2px（就是用户看到的「抖动」）。缓动曲线不过冲，落位干净。
 *
 * 第三条：整数化改成**先定两条边、再由边之差得尺寸**（见 roundRect）。原先 x 与 width
 * 各自独立取整，动画中右边缘 = round(x) + round(width) 会左右各跳半像素（毛刺）。
 *
 * 彻底解耦：本模块不依赖 electron / WebContentsView，也不持有任何 view —— 副作用
 * （把整数 bounds 应用到目标、判断能否动画、时间源）全部构造注入，可被任意宿主复用
 * 且极易单测。
 */

export interface BoundsRect { x: number; y: number; width: number; height: number }

const DIMENSIONS = ['x', 'y', 'width', 'height'] as const

const DEFAULT_FRAME_RATE = 60
/** 与设计令牌 `--ng-anim-base`（180ms）同一口径：结构性重排的动画语言只有这一条。 */
const DEFAULT_DURATION_MS = 180
/** Tailwind 的 ease-in-out（RT sidebar 动画同款）：起手快、收尾缓，中段位移最大。 */
const DEFAULT_BEZIER: readonly [number, number, number, number] = [0.4, 0, 0.2, 1]

export function isRectEqual(a: BoundsRect | null | undefined, b: BoundsRect | null | undefined): boolean {
  if (a === b) return true
  if (!a || !b) return false
  return a.x === b.x && a.y === b.y && a.width === b.width && a.height === b.height
}

/**
 * 整数化：**先取两条边，再由边之差得尺寸**。
 *
 * 为什么不是 `{ x: round(x), width: round(width) }`：动画期间 x 与 width 都是小数，
 * 两者各自取整会让右边缘的落点等于 `round(x) + round(width)` —— x 先动、width 后动，
 * 边缘在一次动画里就会左右各跳半像素，看着就是「毛刺」。
 * 按边取整后，每条边的位置都等于它自己真实位置的四舍五入：单调、无毛刺，
 * 且两端（起点 / 终点）正好落在整数边界上（对整数输入幂等）。
 *
 * @param {{x:number,y:number,width:number,height:number}} rect
 * @returns {{x:number,y:number,width:number,height:number}}
 */
export function roundRect(rect: BoundsRect): BoundsRect {
  const left = Math.round(rect.x)
  const top = Math.round(rect.y)
  const right = Math.round(rect.x + rect.width)
  const bottom = Math.round(rect.y + rect.height)
  return { x: left, y: top, width: right - left, height: bottom - top }
}

/**
 * 生成三次贝塞尔缓动函数（等价于 CSS 的 `cubic-bezier(x1,y1,x2,y2)`）。
 *
 * 与 Chromium 同法：先由进度反解参数 `t`（`x(t) = 进度`，牛顿迭代，跑出 [0,1] 时
 * 二分兜底），再取 `y(t)`。
 * 不建采样表：本模块每帧只算一次，四个维度共用同一个进度值，迭代开销可以忽略 ——
 * 少一层惰性缓存就少一处状态。
 *
 * @param {number} x1
 * @param {number} y1
 * @param {number} x2
 * @param {number} y2
 * @returns {(progress:number) => number}
 */
export function createEasing(x1: number, y1: number, x2: number, y2: number): (progress: number) => number {
  const cx = 3 * x1
  const bx = 3 * (x2 - x1) - cx
  const ax = 1 - cx - bx
  const cy = 3 * y1
  const by = 3 * (y2 - y1) - cy
  const ay = 1 - cy - by
  const sampleX = (t: number) => ((ax * t + bx) * t + cx) * t
  const sampleY = (t: number) => ((ay * t + by) * t + cy) * t
  const sampleDX = (t: number) => (3 * ax * t + 2 * bx) * t + cx
  return (progress: number) => {
    if (progress <= 0) return 0
    if (progress >= 1) return 1
    let t = progress
    for (let i = 0; i < 8; i += 1) {
      const dx = sampleX(t) - progress
      if (Math.abs(dx) < 1e-5) return sampleY(t)
      const d = sampleDX(t)
      if (Math.abs(d) < 1e-6) break
      t -= dx / d
    }
    if (t < 0 || t > 1) {
      // 牛顿跑飞（极端曲线 / 极陡段）→ 二分兜底。x(t) 在本区间内单调，必然收敛。
      let lo = 0
      let hi = 1
      t = progress
      for (let i = 0; i < 24; i += 1) {
        const x = sampleX(t)
        if (Math.abs(x - progress) < 1e-5) break
        if (x < progress) lo = t
        else hi = t
        t = (lo + hi) / 2
      }
    }
    return sampleY(t)
  }
}

interface BoundsTweenOptions {
  applyBounds(rect: BoundsRect): void
  canAnimate?(): boolean
  now?(): number
  frameRate?: number
  durationMs?: number
  easing?: readonly [number, number, number, number] | ((progress: number) => number)
}

export class BoundsTween {
  private readonly _frameRate: number
  private readonly _msPerFrame: number
  private readonly _duration: number
  private readonly _easing: (progress: number) => number
  private readonly _applyBounds: (rect: BoundsRect) => void
  private readonly _canAnimate: () => boolean
  private readonly _now: () => number
  private _target: BoundsRect | null
  private _from: BoundsRect | null
  private _current: BoundsRect | null
  private _lastApplied: BoundsRect | null
  private _startTime: number
  private _timer: ReturnType<typeof setTimeout> | null
  /**
   * @param {object} options
   * @param {(rect:{x:number,y:number,width:number,height:number}) => void} options.applyBounds
   *        把整数 bounds 应用到当前目标 view（注入，解耦）。
   * @param {() => boolean} [options.canAnimate] 动画是否可运行（目标不可用时返回 false）。
   * @param {() => number} [options.now] 时间源（默认 Date.now，可注入 performance.now）。
   * @param {number} [options.frameRate=60] 采样帧率（曲线的采样密度，不影响曲线本身）。
   * @param {number} [options.durationMs=180] 时长（与 --ng-anim-base 同口径）。
   * @param {number[]|((t:number)=>number)} [options.easing] 缓动曲线：四元组或现成函数。
   */
  constructor(options: BoundsTweenOptions) {
    const frameRate = Number(options.frameRate)
    this._frameRate = Number.isFinite(frameRate) && frameRate > 0 ? frameRate : DEFAULT_FRAME_RATE
    this._msPerFrame = 1000 / this._frameRate
    const duration = Number(options.durationMs)
    this._duration = Number.isFinite(duration) && duration > 0 ? duration : DEFAULT_DURATION_MS
    const curve = options.easing
    this._easing = typeof curve === 'function'
      ? curve
      : curve && curve.length === 4
        ? createEasing(curve[0], curve[1], curve[2], curve[3])
        : createEasing(DEFAULT_BEZIER[0], DEFAULT_BEZIER[1], DEFAULT_BEZIER[2], DEFAULT_BEZIER[3])
    this._applyBounds = typeof options.applyBounds === 'function' ? options.applyBounds : () => {}
    this._canAnimate = typeof options.canAnimate === 'function' ? options.canAnimate : () => true
    this._now = typeof options.now === 'function' ? options.now : () => Date.now()

    /** 本段动画的目标 bounds（含小数） */
    this._target = null
    /** 本段动画的起点 bounds —— 中途改目标时取当时的插值值，保证位置连续（不会跳回去） */
    this._from = null
    /** 当前插值出来的 bounds（含小数） */
    this._current = null
    /** 上一次真正落到 view 上的整数 bounds（去重用） */
    this._lastApplied = null
    /** 本段动画的墙钟起点 */
    this._startTime = 0
    this._timer = null
  }

  /** 当前动画中的（可能含小数的）bounds */
  get current(): BoundsRect | null {
    return this._current
  }

  /** 目标 bounds */
  get target(): BoundsRect | null {
    return this._target
  }

  /** 是否正在动画 */
  get animating(): boolean {
    return this._timer !== null
  }

  /**
   * 设置目标 bounds。
   * - `immediate=true`：立即落位（窗口 resize / 面板拖拽，跟手，零延迟）。
   * - 否则：首帧直接落位，之后走缓动动画；若上一段还没跑完，则从**当前插值位置**
   *   接着走向新目标（时长重新计时，位置连续，不会跳）。
   * @param {{x:number,y:number,width:number,height:number}} bounds
   * @param {boolean} [immediate=false]
   */
  setBounds(bounds: BoundsRect, immediate: boolean = false): void {
    if (immediate) {
      this.setBoundsImmediate(bounds)
      return
    }
    // 目标没变 → 让它接着跑完，不要重启动画（重复上报同一份布局参数是常态）
    if (this._target && isRectEqual(this._target, bounds)) return
    if (!this._current) {
      this.setBoundsImmediate(bounds)
      return
    }
    this._target = { ...bounds }
    this._from = { ...this._current }
    this._startTime = this._now()
    this._start()
  }

  /** 立即落位并停止动画。 */
  setBoundsImmediate(bounds: BoundsRect): void {
    this._stop()
    const next = { ...bounds }
    this._target = next
    this._from = { ...next }
    this._current = { ...next }
    this._applyViewBounds()
  }

  /**
   * 底层 view 换人（新建 / 切标签 / sleep-wake 重建）时的**整体复位**。
   *
   * 必须把目标与插值状态一起丢掉，而不是只清「上次已应用」的缓存：
   * 新 view 的当前 bounds 与动画状态毫无关系，若留着 `_target`，下一次
   * `setBounds(同一目标)` 会被上面的去重判据短路，新 view 就永远拿不到 bounds。
   * 复位后首次 `setBounds` 会走 `setBoundsImmediate`（首帧直接落位，正是我们要的）。
   */
  resetLastAppliedBounds(): void {
    this._stop()
    this._target = null
    this._from = null
    this._current = null
    this._lastApplied = null
  }

  /** 停止动画（保留当前插值位置与目标，供随后的 setBoundsImmediate 接手）。 */
  stop(): void {
    this._stop()
  }

  destroy(): void {
    this._stop()
    this._target = null
    this._from = null
    this._current = null
    this._lastApplied = null
  }

  /** 把当前（含小数）bounds 整数化后应用到目标，仅在变化时调用。 */
  private _applyViewBounds(): void {
    if (!this._current) return
    const rounded = roundRect(this._current)
    if (isRectEqual(rounded, this._lastApplied)) return
    this._lastApplied = rounded
    try {
      this._applyBounds(rounded)
    } catch (_) {}
  }

  /** 按墙钟进度推进到 `progress`（0~1），1 表示本段结束。 */
  private _advance(progress: number): void {
    if (!this._from || !this._target || !this._current) return
    const eased = progress >= 1 ? 1 : this._easing(progress)
    for (const dim of DIMENSIONS) {
      this._current[dim] = this._from[dim] + (this._target[dim] - this._from[dim]) * eased
    }
    this._applyViewBounds()
  }

  /** 目标 view 不可用（切走 / 窗口销毁）→ 停表并把状态收敛到目标。 */
  private _settle(): void {
    this._stop()
    if (!this._target) return
    this._from = { ...this._target }
    this._current = { ...this._target }
    this._applyViewBounds()
  }

  private _start(): void {
    if (this._timer !== null) return
    const loop = () => {
      this._timer = null
      if (!this._canAnimate()) {
        this._settle()
        return
      }
      const elapsed = this._now() - this._startTime
      const progress = this._duration > 0 ? elapsed / this._duration : 1
      if (progress >= 1) {
        this._advance(1)
        // 收尾：把状态钉在目标上，之后再收到同一目标的 setBounds 就能被去重短路
        const target = this._target
        if (!target) return
        this._from = { ...target }
        this._current = { ...target }
        return
      }
      this._advance(progress)
      // 下一拍对齐到 elapsed 之后的**第一个帧栅格**（绝对时刻，不是「现在 + 16.7ms」）：
      // 定时器本身有毫秒级抖动，逐次累加会把抖动积成漂移；按栅格重算则自我纠偏，
      // 即便某一拍来晚了，后面的拍子仍落在同一条均匀栅格上。
      // 下限钉在 1ms：浮点误差会让 elapsed 正好压在栅格上，此时算出的延迟是 ~0，
      // 那就变成「同一毫秒内反复排拍」的空转（白烧主进程，且动画一点没动）。
      const frames = Math.floor(elapsed / this._msPerFrame) + 1
      const delay = Math.max(1, this._startTime + frames * this._msPerFrame - this._now())
      this._timer = setTimeout(loop, delay)
    }
    this._timer = setTimeout(loop, this._msPerFrame)
  }

  private _stop(): void {
    if (this._timer !== null) {
      clearTimeout(this._timer)
      this._timer = null
    }
  }

}

