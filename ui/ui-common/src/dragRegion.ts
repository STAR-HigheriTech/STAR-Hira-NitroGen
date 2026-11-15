/** 拖拽 / chrome 收起期间中和当前视图的窗口拖拽区。 */

const STYLE_ID = 'ui-common-drag-region-styles'
const ACTIVE_CLASS = 'hira-dragging'
const CHROME_STYLE_ID = 'ui-common-chrome-drag-styles'
const CHROME_SUPPRESSED_CLASS = 'hira-chrome-drag-suppressed'

export interface DragRegionSuppressor {
  arm: () => void
  disarm: () => void
  isArmed: () => boolean
}

function injectStyles(doc: Document): void {
  if (!doc || !doc.head || doc.getElementById(STYLE_ID)) return
  const style = doc.createElement('style')
  style.id = STYLE_ID
  style.textContent = `
    html.${ACTIVE_CLASS},
    html.${ACTIVE_CLASS} * {
      -webkit-app-region: no-drag !important;
    }
  `
  doc.head.appendChild(style)
}

function injectChromeDragStyles(doc: Document): void {
  if (!doc || !doc.head || doc.getElementById(CHROME_STYLE_ID)) return
  const style = doc.createElement('style')
  style.id = CHROME_STYLE_ID
  style.textContent = `
    html.${CHROME_SUPPRESSED_CLASS},
    html.${CHROME_SUPPRESSED_CLASS} * {
      -webkit-app-region: no-drag !important;
    }
  `
  doc.head.appendChild(style)
}

/**
 * chrome 收起期间让**本视图**的窗口拖拽区整体让位。
 *
 * 由主进程按真实布局状态驱动；与模态浮层的类名相互独立，二者可以同时成立。
 */
export function setChromeDragSuppressed(doc: Document, suppressed: boolean): void {
  if (!doc || !doc.documentElement) return
  injectChromeDragStyles(doc)
  doc.documentElement.classList.toggle(CHROME_SUPPRESSED_CLASS, !!suppressed)
}

export function createDragRegionSuppressor(doc: Document): DragRegionSuppressor {
  let armed = false

  const disarm = (): void => {
    if (!armed) return
    doc.removeEventListener('dragend', onDocDragEnd, true)
    doc.documentElement.classList.remove(ACTIVE_CLASS)
    armed = false
  }

  const onDocDragEnd = (): void => disarm()

  const arm = (): void => {
    if (armed || !doc?.documentElement) return
    injectStyles(doc)
    doc.documentElement.classList.add(ACTIVE_CLASS)
    // 捕获相保证源节点被移出 DOM 时仍能收尾，避免整窗永久失去拖拽能力。
    doc.addEventListener('dragend', onDocDragEnd, true)
    armed = true
  }

  return { arm, disarm, isArmed: () => armed }
}
