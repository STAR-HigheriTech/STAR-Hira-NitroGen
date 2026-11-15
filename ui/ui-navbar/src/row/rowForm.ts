/**
 * 导航栏块的**形态事实** —— 「本块此刻长什么样」的唯一一份。
 *
 * 五个事实全在这一个对象里（只读 getter + 五个 setter）：
 *   axis      本块住**横排**（row：导航栏在顶/底那一行）还是**纵排**（column：住侧栏）；
 *   slots     标签栏块借出的侧栏槽位（`{ pin, top, dock, bottom }`；null = 标签栏不在侧栏）；
 *   side      侧栏区在实际窗口的哪一侧（'left' | 'right'）；
 *   compact   单行（精致）模式是否生效（导航按钮组要搬进标签行）；
 *   wcHost    窗口控制按钮的宿主块（'tabbar' | 'navbar' | 'titlebar'）。
 *
 * ── 为什么要有这个文件（这就是"统一管理各模式的差异"）──────────────────────
 * 从前每个落点判定模块**各存各的** axis / slots 副本，各自留一份 setAxis / setSlots，
 * 于是同一件事有两份推导，代价是两类病：
 *   ① 「换布局时少通知一条路径」→ 某个按钮凭空消失或不动（历史上真的发生过）；
 *   ② 重摆时机互相错开 → 最终 DOM 顺序取决于**哪条通知后到**（不确定、不可复现）。
 * 现在：事实只有一份，落点模块**只读**它；编排层（rowBinding）改一个事实后
 * **按固定顺序**把所有落点重摆一遍（顺序在 rowBinding 里，一处读得完）。
 * 加一个新落点模块 = 加一个文件 + rowBinding 的落点表里一行。
 *
 * ── 归一化在这里做 ──────────────────────────────────────────────────────
 * 不合法取值一律回落，所以下游模块不必再各写一遍
 * `next === 'column' ? 'column' : 'row'` 这类判断（从前四个模块各写一遍）。
 * setter 返回「是否有变化」—— 调用方据此决定要不要重摆（幂等的第一道闸）。
 */

import type {
  HostAxis,
  RailPosition,
  SidePosition,
  SideSlots,
  WindowControlsHost
} from '../types'

export interface RowForm {
  readonly axis: HostAxis
  readonly slots: SideSlots | null
  readonly side: SidePosition
  readonly railPosition: RailPosition
  readonly compact: boolean
  readonly wcHost: WindowControlsHost
  readonly inSide: boolean
  readonly navbarInSide: boolean
  setAxis(next: unknown): boolean
  setSlots(next: SideSlots | null): boolean
  setSide(next: unknown): boolean
  setRailPosition(next: unknown): boolean
  setCompact(next: unknown): boolean
  setWindowControlsHost(next: unknown): boolean
}

export function createRowForm(): RowForm {
  let axis: HostAxis = 'row'
  let slots: SideSlots | null = null
  let side: SidePosition = 'left'
  let railPosition: RailPosition = 'left'
  let compact = false
  let wcHost: WindowControlsHost = 'tabbar'

  return {
    get axis() { return axis },
    get slots() { return slots },
    get side() { return side },
    get railPosition() { return railPosition },
    get compact() { return compact },
    get wcHost() { return wcHost },

    /** 派生（避免每个模块各写一遍同一个推导）：标签栏是否借出了侧栏槽位 / 本块是否住侧栏。 */
    get inSide() { return !!slots },
    get navbarInSide() { return axis === 'column' },

    setAxis(next: unknown) {
      const value = next === 'column' ? 'column' : 'row'
      if (value === axis) return false
      axis = value
      return true
    },

    setSlots(next: SideSlots | null) {
      const value = next || null
      if (value === slots) return false
      slots = value
      return true
    },

    setSide(next: unknown) {
      const value = next === 'right' ? 'right' : 'left'
      if (value === side) return false
      side = value
      return true
    },

    setRailPosition(next: unknown) {
      const value = next === 'right' || next === 'top' || next === 'bottom' ? next : 'left'
      if (value === railPosition) return false
      railPosition = value
      return true
    },

    setCompact(next: unknown) {
      const value = !!next
      if (value === compact) return false
      compact = value
      return true
    },

    setWindowControlsHost(next: unknown) {
      const value = next === 'navbar' || next === 'titlebar' ? next : 'tabbar'
      if (value === wcHost) return false
      wcHost = value
      return true
    }
  }
}
