/**
 * Section：底部管理入口。
 *
 * 只放「从这里走出去」的两个深链：权限面板（所有站点）与当前页面信息。
 * 行形与空间切换菜单的「管理空间…」一致（`hira-overlay-row` + 图标 + 文字），
 * 整浮层只有这一种"可点的行"，不再维护第二套 footer 链接样式。
 */

import { el, menuRow } from './shared.js'

/** @type {import('./registry.js').SiteInfoSection} */
export const footerSection: import('./registry.js').SiteInfoSection = {
  id: 'footer',
  order: 90,
  create(ctx) {
    const { doc, emit } = ctx

    const root = el(doc, 'section', 'si-section')
    root.dataset.section = 'footer'

    root.appendChild(menuRow(doc, {
      icon: 'LayoutGrid',
      label: '管理所有站点',
      onActivate: () => emit('open-permissions')
    }))
    root.appendChild(menuRow(doc, {
      icon: 'Info',
      label: '页面信息',
      onActivate: () => emit('open-page-info')
    }))

    return {
      element: root,
      update(state) {
        const site = (state && state.context && state.context.site) || null
        root.hidden = !site || !site.url
      }
    }
  }
}

