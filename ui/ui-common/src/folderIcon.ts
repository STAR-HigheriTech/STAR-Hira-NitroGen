/** 文件夹图标的唯一 SVG 真源与 DOM 工厂。 */

export const FOLDER_ICON_SVG = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M3 7a2 2 0 012-2h4l2 2h8a2 2 0 012 2v8a2 2 0 01-2 2H5a2 2 0 01-2-2V7z"/></svg>'

export interface FolderIconOptions {
  size?: number
  className?: string
}

/** 尺寸属性只作为没有 CSS 时的兜底，布局类名由宿主决定。 */
export function createFolderIcon(doc: Document, options: FolderIconOptions = {}): HTMLSpanElement {
  const span = doc.createElement('span')
  if (options.className) span.className = String(options.className)
  span.innerHTML = FOLDER_ICON_SVG

  const svg = span.firstElementChild
  if (svg && options.size != null) {
    svg.setAttribute('width', String(options.size))
    svg.setAttribute('height', String(options.size))
  }
  return span
}
