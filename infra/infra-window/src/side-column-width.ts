/**
 * 侧栏区实际占宽的单一算法。
 *
 * 常驻、占位型悬停、浮层型悬停共用同一口径，网页内缩与坐标换算都读取它。
 */
export interface SideColumnLayoutParams {
  sideColumnVisible?: boolean
  sideColumnRevealOverlay?: boolean
  sideColumnWidth?: number
  sideColumnAutoHide?: boolean
  sideColumnRevealWidth?: number
}

export function getSideColumnWidth(params: SideColumnLayoutParams | null | undefined, revealed: boolean): number {
  const value = params || {}
  if (value.sideColumnVisible === false) return 0
  if (value.sideColumnRevealOverlay === true) {
    return Math.max(0, Math.round(Number(value.sideColumnWidth) || 0))
  }
  if (value.sideColumnAutoHide === true) {
    if (!revealed) return 0
    return Math.max(
      0,
      Math.round(Number(value.sideColumnRevealWidth) || Number(value.sideColumnWidth) || 0)
    )
  }
  return Math.max(0, Math.round(Number(value.sideColumnWidth) || 0))
}

