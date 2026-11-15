/**
 * Section：Cookie。
 *
 * 浮层只回答「本站有多少 Cookie」并给一个**出口**（管理 Cookie 页）。
 * 增删改查是完整页面的职责 —— 浮层不承载任何破坏性动作，
 * 也就不需要二次确认、清除按钮与回执提示（这些在 Cookie 管理页里做更合适）。
 */

import { createSection, el, formatCount } from './shared.js'

/** @type {import('./registry.js').SiteInfoSection} */
export const siteDataSection: import('./registry.js').SiteInfoSection = {
  id: 'site-data',
  order: 40,
  create(ctx) {
    const { doc, emit } = ctx

    const shell = createSection(doc, {
      id: 'site-data',
      title: 'Cookie',
      action: { label: '管理 Cookie', onActivate: () => emit('open-cookies') }
    })

    const summary = el(doc, 'div', 'si-summary')

    shell.body.appendChild(summary)

    return {
      element: shell.root,
      update(state) {
        const cookies = state.cookies
        const site = (state && state.context && state.context.site) || null

        const count = Number(cookies.count) || 0
        if (cookies.loading) summary.textContent = '正在统计 Cookie…'
        else if (!site || !site.url) summary.textContent = '没有活动页面。'
        else summary.textContent = `${formatCount(count)} 个 Cookie`

        shell.setActionVisible(!!site && !!site.url)
      }
    }
  }
}

