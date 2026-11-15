/**
 * automation-gestures —— 鼠标手势的**识别算法**（零依赖，preload 可安全加载）。
 *
 * ── 为什么单独一个文件 ──────────────────────────────────────────────
 * 识别算法的消费方只有两个：preload 里的手势引擎（沙箱，只能用相对路径）与主进程。
 * 而 `automation.mjs` 还持有命令目录 —— 目录要读 `keybindings.mjs` / `commands.mjs`
 * （后者再拉搜索引擎表）。若把两者放同一个模块，preload 为了 `gestureFromPath`
 * 会把整张命令表打进每个标签页的 preload 包，纯属白背。
 *
 * 于是边界是：**识别 = 本文件**（纯几何，不认识任何命令 id）；
 * **目录 / 映射 / 链归一 = automation.mjs**（认识命令，只跑在主进程与自动化页）。
 */

/** 手势识别参数：单段最短位移与最多段数（超过就不再记，避免长划产生无意义长串）。 */
export const GESTURE_RECOGNIZE = Object.freeze({ step: 32, maxSegments: 3 })

export interface GesturePoint {
  x: number
  y: number
}

export interface GestureRecognitionOptions {
  step?: number
  maxSegments?: number
}

/**
 * 从鼠标轨迹识别方向序列（**唯一**的手势识别实现）。
 *
 * 算法：以"上一段起点"为锚，位移超过 `step` 就认定一段，取**主导轴**作为方向，
 * 然后锚点移到当前点（分段而不是累加，所以"画个大 L"不会被算成 R）。
 * 相邻同向去重；最多 `maxSegments` 段。
 *
 * @param {Array<{x:number,y:number}>} points 客户端坐标轨迹
 * @param {{ step?: number, maxSegments?: number }} [opts]
 * @returns {string} 方向序列（如 `'DR'`）；没形成手势返回 `''`
 */
export function gestureFromPath(points: readonly GesturePoint[], opts: GestureRecognitionOptions = {}): string {
  const step = Number(opts.step) || GESTURE_RECOGNIZE.step
  const max = Number(opts.maxSegments) || GESTURE_RECOGNIZE.maxSegments
  if (!Array.isArray(points) || points.length < 2) return ''
  const out: Array<'L' | 'R' | 'U' | 'D'> = []
  let anchor = points[0]
  for (let i = 1; i < points.length; i++) {
    const p = points[i]
    if (!p || typeof p.x !== 'number' || typeof p.y !== 'number') continue
    const dx = p.x - anchor.x
    const dy = p.y - anchor.y
    if (Math.abs(dx) < step && Math.abs(dy) < step) continue
    const dir = Math.abs(dx) >= Math.abs(dy) ? (dx > 0 ? 'R' : 'L') : (dy > 0 ? 'D' : 'U')
    if (out[out.length - 1] !== dir) out.push(dir)
    anchor = p
    if (out.length >= max) break
  }
  return out.join('')
}
