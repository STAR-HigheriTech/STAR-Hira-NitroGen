/**
 * hover 预览的载荷事实 —— 横竖两种列表共用的一份额外形状。
 *
 * 本模块只量锚点与容器几何、整理预览载荷，不认识浮层位置算法或 IPC。
 * 容器外缘用于避免预览覆盖滚动条和标签条底部凹槽。
 */

export interface TabPreviewSource {
  tabId?: string | number
  title?: string
  url?: string
  favicon?: string
}

export interface TabPreviewAnchor {
  left: number
  top: number
  width: number
  height: number
}

export interface TabPreviewTab {
  tabId?: string | number
  title: string
  url: string
  favicon: string
}

export interface TabPreviewFacts {
  anchor: TabPreviewAnchor
  tab: TabPreviewTab
  stripRight?: number
  stripBottom?: number
  placement?: 'beside-row' | 'below-row' | string
  side?: 'left' | 'right' | string
  windowWidth?: number
}

export interface TabPreviewFactsInput {
  anchorEl?: HTMLElement | null
  tab?: TabPreviewSource | null
  stripEl?: HTMLElement | null
}

/**
 * 锚点已脱离文档或量为 0×0 时返回 null，调用方据此跳过本次显示，避免浮层跑到左上角。
 */
export function tabPreviewFacts(input: TabPreviewFactsInput = {}): TabPreviewFacts | null {
  const anchorEl = input.anchorEl
  if (!anchorEl || anchorEl.isConnected === false) return null
  if (typeof anchorEl.getBoundingClientRect !== 'function') return null

  const rect = anchorEl.getBoundingClientRect()
  if (rect.width === 0 && rect.height === 0) return null

  const source = input.tab || {}
  const facts: TabPreviewFacts = {
    anchor: { left: rect.left, top: rect.top, width: rect.width, height: rect.height },
    tab: {
      tabId: source.tabId,
      title: source.title || source.url || '',
      url: source.url || '',
      favicon: source.favicon || ''
    }
  }

  const stripEl = input.stripEl
  if (stripEl && typeof stripEl.getBoundingClientRect === 'function') {
    const strip = stripEl.getBoundingClientRect()
    facts.stripRight = Math.round(strip.right)
    // 向上取整方向必须与落位算法一致：宁可留半像素，也不压进容器凹槽。
    facts.stripBottom = Math.ceil(strip.bottom)
  }

  return facts
}
