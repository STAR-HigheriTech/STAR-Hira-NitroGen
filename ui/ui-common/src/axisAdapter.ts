/**
 * **轴向适配器** —— 标签行的落点**几何**，横竖各一份实例、规则只有一份实现
 * （对应 docs/vertical-tabs-architecture.md 的 §3.2）。
 *
 * 它只回答"几何"这一类问题：**主轴**是 x 还是 y、指针在某一项的前半还是后半、
 * 落点是否落在整条之外、插入指示线该贴哪条边。它不认识 tabId、不认识标签组、
 * 不认识菜单 —— 那些是语义层的事（见该文档 §3.1 的分层）。
 *
 * 为什么必须共用：拖拽落点那三条规则（**中点判定** / **首尾外推** / **指示线贴边**）
 * 此前在横向 `ui-tabbar#view/dropController` 与纵向 `tabRowList` 里各写一遍，
 * 只是把 `clientX/left/width` 换成 `clientY/top/height` —— 改一处必漏一处，
 * 而"拖拽手感"正是用户最先察觉的地方。收成一份后，模式差异只剩**取哪个轴**一个参数。
 *
 * 本模块**不碰 DOM 样式**：只吐数字（容器坐标系里的偏移），把数字写成 `left/width`
 * 还是 `top/height` 由调用方按自己的坐标系决定（横向那条还在滚动容器里，要加滚动偏移）。
 */

export interface AnyRect {
  top: number
  bottom: number
  left: number
  right: number
  width: number
  height: number
}

interface AxisMeasure {
  start: number
  size: number
  end: number
}

export function axisAdapter(axis?: 'row' | 'column') {
  const isColumn = axis === 'column'
  const startOf = isColumn ? (rect: AnyRect) => rect.top : (rect: AnyRect) => rect.left
  const endOf = isColumn ? (rect: AnyRect) => rect.bottom : (rect: AnyRect) => rect.right
  const sizeOf = isColumn ? (rect: AnyRect) => rect.height : (rect: AnyRect) => rect.width

  return {
    axis: isColumn ? 'column' : 'row',
    /** 指针在主轴上的坐标（两种模式的鼠标事件因此不必各写一遍 clientX/clientY）。 */
    pointerOf: (event: { clientX: number; clientY: number }) =>
      isColumn ? event.clientY : event.clientX,
    sizeOf,
    startOf,
    endOf,
    /** 容器坐标系里的测量（拖拽判定与指示线定位共用这一个）。 */
    measure(rect: AnyRect, containerRect: AnyRect): AxisMeasure {
      const start = startOf(rect) - startOf(containerRect)
      const size = sizeOf(rect)
      return { start, size, end: start + size }
    },
    /**
     * 指针落在该元素的**后半**？（= 落点应插到它后面）
     * 中点判定：前半 → 插到它前面，后半 → 插到它后面。
     */
    isAfter(pointer: number, rect: AnyRect): boolean {
      return pointer > startOf(rect) + sizeOf(rect) / 2
    },
    /**
     * 落点是否在整条**之外**：
     *   · 在第一项之前 → 返回 `0`（插到第一项前面）；
     *   · 在最后一项之后 → 返回 `rects.length - 1`（插到最后一项后面）；
     *   · 在条内 → 返回 `-1`（由 `isAfter` 逐项判定）。
     * 首尾外推是"把标签拖到列表最前/最后"唯一能生效的路径（缝里没有元素可判中点）。
     */
    pickEdge(pointer: number, rects: AnyRect[]): number {
      if (!rects || !rects.length) return -1
      if (pointer < startOf(rects[0])) return 0
      if (pointer > endOf(rects[rects.length - 1])) return rects.length - 1
      return -1
    },
    /**
     * 指示线贴在目标元素的哪条边（**容器坐标系**里的偏移）。
     * 横向那条在滚动容器内，调用方还需加上滚动偏移（详见各处调用点）。
     */
    indicatorOffset(rect: AnyRect, containerRect: AnyRect, insertAfter: boolean): number {
      const m = this.measure(rect, containerRect)
      return insertAfter ? m.end : m.start
    }
  }
}
