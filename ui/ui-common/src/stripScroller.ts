/** 横竖标签条共享的滚动区：主轴滚动、交叉轴禁用、滚轮按溢出方向换算。 */

const STYLE_ID = 'hira-strip-scroller-styles'

export const STRIP_SCROLLER_CSS = `
    .hira-strip[data-strip-axis="x"] {
      overflow-x: auto;
      overflow-y: hidden;
    }
    .hira-strip[data-strip-axis="y"] {
      overflow-y: auto;
      overflow-x: hidden;
    }
    .hira-strip[data-strip-axis="x"]::-webkit-scrollbar {
      height: var(--ng-tabs-scrollbar-height, 4px);
    }
    .hira-strip[data-strip-axis="y"]::-webkit-scrollbar {
      width: var(--ng-tabs-scrollbar-height, 4px);
    }
    .hira-strip::-webkit-scrollbar-track {
      background: transparent;
      border-radius: 999px;
    }
    .hira-strip::-webkit-scrollbar-thumb {
      background: var(--ng-tabs-scrollbar-thumb);
      border-radius: 999px;
      border: 0.25px solid transparent;
      background-clip: padding-box;
    }
    .hira-strip:hover::-webkit-scrollbar-thumb {
      background: var(--ng-tabs-scrollbar-thumb-hover);
    }
`

export function injectStripScrollerStyles(doc: Document): void {
  if (!doc || !doc.head || doc.getElementById(STYLE_ID)) return
  const style = doc.createElement('style')
  style.id = STYLE_ID
  style.textContent = STRIP_SCROLLER_CSS
  doc.head.appendChild(style)
}

export type StripAxis = 'x' | 'y'

export function createStripScroller(scroller: HTMLElement, axis?: StripAxis): void {
  const main: StripAxis = axis === 'y' ? 'y' : 'x'
  scroller.classList.add('hira-strip')
  scroller.dataset.stripAxis = main

  scroller.addEventListener('wheel', (event) => {
    if (event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return
    if (Math.abs(event.deltaY) <= Math.abs(event.deltaX)) return
    if (scroller.scrollWidth <= scroller.clientWidth) return
    event.preventDefault()
    scroller.scrollLeft += event.deltaY
  }, { passive: false })
}
