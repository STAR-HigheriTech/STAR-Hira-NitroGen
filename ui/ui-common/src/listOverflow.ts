/**
 * 列表溢出 → 省略 + 完整入口的唯一实现。
 *
 * 配额、截断判据和省略行文案集中在这里；本模块不认识具体面板，
 * 只通过 onActivate 上抛动作，由宿主决定完整入口。
 */

import { OverlayCardStyle } from './overlayCard'

/** 各表面的最大展示项数。 */
export const LIST_LIMITS = Object.freeze({
  permission: 5,
  space: 6,
  profile: 4,
  bookmark: 8
} as const)

export type ListSurface = keyof typeof LIST_LIMITS

export interface SplitByLimitResult<T> {
  shown: T[]
  hiddenCount: number
}

/** 按上限切分；无效上限等同于不截断。 */
export function splitByLimit<T>(
  items: readonly T[] | null | undefined,
  limit: number
): SplitByLimitResult<T> {
  const list: readonly T[] = Array.isArray(items) ? items : []
  const max = Number.isFinite(limit) && limit > 0 ? Math.floor(limit) : list.length
  if (list.length <= max) return { shown: list.slice(), hiddenCount: 0 }
  return { shown: list.slice(0, max), hiddenCount: list.length - max }
}

/** 省略行文案的唯一实现。 */
export function overflowRowText(hiddenCount: number, targetLabel: string): string {
  return `还有 ${hiddenCount} 项 · 转到${targetLabel}`
}

export interface OverflowRowOptions {
  hiddenCount: number
  targetLabel: string
  onActivate?: () => void
}

/** 造一行省略入口；点击只上报动作。 */
export function createOverflowRow(doc: Document, options: OverflowRowOptions): HTMLButtonElement {
  const { hiddenCount, targetLabel, onActivate } = options
  const row = doc.createElement('button')
  row.className = 'hira-overlay-row hira-overflow-row'
  row.type = 'button'

  const text = overflowRowText(hiddenCount, targetLabel)
  row.textContent = text
  row.title = text
  row.addEventListener('mousedown', (event) => event.preventDefault())
  row.addEventListener('click', () => onActivate?.())
  return row
}

/** 注入省略行样式；重复调用无副作用。 */
export function injectListOverflowStyles(doc: Document): void {
  if (!doc || doc.getElementById('hira-list-overflow-styles')) return

  const style = doc.createElement('style')
  style.id = 'hira-list-overflow-styles'
  style.textContent = `
    .hira-overflow-row {
      font-size: ${OverlayCardStyle.groupFontSize};
      color: ${OverlayCardStyle.groupColor};
    }
    .hira-overflow-row:hover {
      color: ${OverlayCardStyle.cardColor};
    }
  `
  doc.head.appendChild(style)
}
