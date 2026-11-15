/** 分屏连接回形针的唯一外观；连接判据见 splitLink.ts，摆放归各宿主。 */

import { Paperclip } from '../icons'

const STYLE_ID = 'ui-common-split-clip-styles'

export const SPLIT_CLIP_SIZE = 12
export const SPLIT_CLIP_CLASS = 'tab-split-clip'

export function injectSplitClipStyles(doc: Document): void {
  if (doc.getElementById(STYLE_ID)) return
  const style = doc.createElement('style')
  style.id = STYLE_ID
  style.textContent = `
    .${SPLIT_CLIP_CLASS} {
      display: flex;
      align-items: center;
      justify-content: center;
      --split-clip-size: ${SPLIT_CLIP_SIZE}px;
      width: var(--split-clip-size);
      height: var(--split-clip-size);
      color: var(--hira-accent, var(--accent-color, #3b82f6));
      opacity: 0.9;
      pointer-events: none;
    }
    .${SPLIT_CLIP_CLASS} svg { display: block; }
  `
  doc.head.appendChild(style)
}

export interface SplitClipOptions {
  className?: string
  label?: string
}

export function createSplitClip(doc: Document, options: SplitClipOptions = {}): HTMLElement {
  const element = doc.createElement('span')
  element.className = `${SPLIT_CLIP_CLASS}${options.className ? ` ${options.className}` : ''}`
  element.setAttribute('aria-label', String(options.label || '与相邻标签分屏'))
  element.appendChild(Paperclip(doc, { size: SPLIT_CLIP_SIZE - 1, strokeWidth: 1.8 }))
  return element
}
