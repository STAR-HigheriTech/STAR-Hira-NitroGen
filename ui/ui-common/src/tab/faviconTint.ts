/** 标签行跟随 favicon 取色；异步结果通过 data-favicon-url 对齐当前站点。 */

import { applyFaviconColor } from '../faviconColor'

export interface FaviconTintPatch {
  favicon?: string
  active?: boolean
}

export interface FaviconTint {
  update: (patch?: FaviconTintPatch) => void
}

export function createFaviconTint(el: HTMLElement): FaviconTint {
  let currentUrl = ''
  let currentActive = false

  const paint = (): void => {
    el.dataset.faviconUrl = currentUrl
    applyFaviconColor(el, currentUrl, currentActive, () => (
      el.isConnected && el.dataset.faviconUrl === currentUrl
    ))
  }

  return {
    update(patch: FaviconTintPatch = {}): void {
      if (patch.favicon !== undefined) currentUrl = patch.favicon || ''
      if (patch.active !== undefined) currentActive = !!patch.active
      paint()
    }
  }
}
