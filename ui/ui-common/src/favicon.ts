/** favicon DOM 工厂；候选来源和三级降级规则由 shared-types 统一提供。 */

import {
  createFaviconImg as createFaviconImgCore,
  faviconSourceCandidates
} from '@hira-ng/shared-types/src/favicon-src.mjs'
import { uiFontVar } from '@hira-ng/shared-types/src/font-stack.mjs'
import { TAB_FAVICON_BG_VAR, TAB_FAVICON_FG_VAR } from './faviconColor'

/** 简化形态；空来源直接隐藏，不显示破图占位。 */
export function createFaviconImg(
  doc: Document,
  src?: string | null,
  size = 16
): HTMLImageElement {
  const img: HTMLImageElement = createFaviconImgCore(doc, { primary: src || null, raw: null }, {
    size,
    borderRadius: 2,
    onFail: () => {
      img.style.display = 'none'
    }
  })
  if (!src) img.style.display = 'none'
  return img
}

/** 加载失败自动降级为首字母徽标，避免产生破图或空位。 */
export function createFaviconBadge(
  doc: Document,
  src?: string | null,
  title?: string | null,
  size = 16,
  pageUrl?: string | null,
  opts: { tabChip?: boolean } = {}
): HTMLSpanElement {
  const tabChip = opts.tabChip === true
  const wrap = doc.createElement('span')
  wrap.style.cssText = `width:${size}px;height:${size}px;flex-shrink:0;display:inline-flex;align-items:center;justify-content:center;${tabChip ? `border-radius:4px;background-color:var(${TAB_FAVICON_BG_VAR},currentColor);` : ''}`

  const fallback = (): void => {
    wrap.replaceChildren()
    const badge = doc.createElement('span')
    badge.textContent = (title || '?').trim().charAt(0).toUpperCase() || '?'
    const background = tabChip
      ? 'transparent'
      : 'var(--hira-hover-bg,rgba(0,0,0,0.08))'
    const color = tabChip
      ? `var(${TAB_FAVICON_FG_VAR},var(--hira-bg-elevated,#fff))`
      : 'var(--hira-text-secondary,#6b7280)'
    badge.style.cssText = `width:${size}px;height:${size}px;border-radius:3px;flex-shrink:0;display:inline-flex;align-items:center;justify-content:center;font-family:${uiFontVar()};font-size:${Math.max(9, Math.round(size * 0.6))}px;font-weight:600;background:${background};color:${color};`
    wrap.appendChild(badge)
  }

  const candidates = faviconSourceCandidates(pageUrl ?? '', src ?? '')
  if (!candidates.primary) {
    fallback()
    return wrap
  }

  const image: HTMLImageElement = createFaviconImgCore(doc, candidates, {
    size,
    borderRadius: 2,
    onFail: fallback
  })
  wrap.appendChild(image)
  return wrap
}
