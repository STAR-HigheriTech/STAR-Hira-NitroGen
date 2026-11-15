/**
 * rail 末尾的「更多页面」出口 —— 设置页 / 插件页**共用同一份**。
 *
 * 为什么抽出来：两页的侧栏是两套 DOM（`.nav-item` vs `.plugins-page__nav-item`），
 * 但「更多页面」是**同一个出口** —— 落点、文案、字形三样必须逐字一致。各写一遍
 * 就是"改一处忘一处"，地址一旦手抄还会漂。
 *
 * 落点来自内部页身份真源 `pages.mjs#MORE_PAGES_HOST`，**不在这里手写 hira://history**；
 * 字形取 `icon-paths.mjs` 的 LayoutGrid（与空间图标 `layout` 同一颗）。
 * 两处类名由调用方给：`itemClass` = 该页 rail 条目的类（决定几何 / 悬停 / 选中态），
 * `labelClass` = 该页文字层的类；其余结构（ico 容器 + 文字）在这里统一产出。
 */
import { MORE_PAGES_HOST, pageUrl } from '@hira-ng/shared-types/src/pages.mjs'
import { SHARED_ICON_PATHS } from '@hira-ng/shared-types/src/icon-paths.mjs'

export const MORE_PAGES_LABEL = '更多页面'

export interface RailMoreLinkOptions {
  itemClass: string
  labelClass: string
  extraClass?: string
}

/**
 * 建 rail 末尾的「更多页面」链接（静态锚点，不参与各页 nav 的重建）。
 * @param {Document} doc
 * @param {{ itemClass: string, labelClass: string, extraClass?: string }} opts
 * @returns {HTMLAnchorElement}
 */
export function createRailMoreLink (doc: Document, opts: RailMoreLinkOptions): HTMLAnchorElement {
  const link = doc.createElement('a')
  link.className = [opts.itemClass, opts.extraClass || 'rail-more'].filter(Boolean).join(' ')
  link.href = pageUrl(MORE_PAGES_HOST)

  const ico = doc.createElement('span')
  ico.className = 'ico'
  ico.setAttribute('aria-hidden', 'true')
  ico.innerHTML =
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" ' +
    'stroke-linecap="round" stroke-linejoin="round">' + SHARED_ICON_PATHS.LayoutGrid + '</svg>'

  const label = doc.createElement('span')
  label.className = opts.labelClass || 'label'
  label.textContent = MORE_PAGES_LABEL

  link.append(ico, label)
  return link
}
