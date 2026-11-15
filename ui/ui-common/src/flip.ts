/**
 * FLIP 滑动让位：重排前记录位置，重排后先瞬移回旧位置，再让样式表过渡到新位置。
 * 横向列表使用 x，纵向列表使用 y。
 */

export type SlideAxis = 'x' | 'y'

export interface PlaySlideOptions {
  /** 跳过自身已有尺寸/透明度动画的节点。 */
  skip?: (node: HTMLElement) => boolean
}

export function capturePositions(
  nodes: Iterable<HTMLElement> | null | undefined,
  axis: SlideAxis = 'x'
): Map<HTMLElement, number> {
  const positions = new Map<HTMLElement, number>()
  if (!nodes) return positions

  for (const node of nodes) {
    if (!node || !node.isConnected) continue
    const rect = node.getBoundingClientRect()
    positions.set(node, axis === 'x' ? rect.left : rect.top)
  }
  return positions
}

/** 播放滑动让位（FLIP 的 Invert + Play 两段）。 */
export function playSlide(
  from: ReadonlyMap<HTMLElement, number> | null | undefined,
  axis: SlideAxis = 'x',
  options: PlaySlideOptions = {}
): void {
  if (!from || typeof from.size !== 'number' || from.size === 0) return

  const skip = typeof options.skip === 'function' ? options.skip : null
  const moves: Array<[HTMLElement, number]> = []

  // 先清掉仍在飞的 transform，确保量到的是布局位置而不是视觉位置。
  for (const [node, previous] of from) {
    if (!node || !node.isConnected || skip?.(node)) continue
    if (node.style.transform) node.style.transform = ''
    const rect = node.getBoundingClientRect()
    const current = axis === 'x' ? rect.left : rect.top
    const delta = previous - current
    if (Math.abs(delta) >= 1) moves.push([node, delta])
  }
  if (moves.length === 0) return

  for (const [node, delta] of moves) {
    node.style.transition = 'none'
    node.style.transform = axis === 'x' ? `translateX(${delta}px)` : `translateY(${delta}px)`
  }

  // 强制提交瞬移后的起始帧，避免写入与清除被浏览器合并成一步。
  const first = moves[0][0]
  if (first.isConnected) void first.offsetHeight

  for (const [node] of moves) {
    node.style.transition = ''
    node.style.transform = ''
  }
}
