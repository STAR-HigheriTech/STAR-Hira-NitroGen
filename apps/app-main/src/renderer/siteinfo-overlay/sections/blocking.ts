/**
 * Section：内容拦截（Adblocker）。
 *
 * v1 只有**全局开关**（与既有 `ADBLOCKER_LEVELS` 一致）：开启 = 广告 + 跟踪器。
 * 按站点白名单是明确的后续能力 —— 届时新增 `siteException` 位或独立 section，
 * 不改本文件的开关语义。
 */

import { createSection, el, formatCount } from './shared.js'

/** @type {import('./registry.js').SiteInfoSection} */
export const blockingSection: import('./registry.js').SiteInfoSection = {
  id: 'blocking',
  order: 50,
  create(ctx) {
    const { doc, emit } = ctx

    const shell = createSection(doc, {
      id: 'blocking',
      title: '内容拦截'
    })

    const toggle = el(doc, 'button', 'si-switch')
    toggle.type = 'button'
    toggle.setAttribute('role', 'switch')
    toggle.setAttribute('aria-label', '内容拦截')
    toggle.appendChild(el(doc, 'span', 'si-switch-thumb'))
    // 开关住分组标题行右端（createSection 直接给出 head，不再靠类名 querySelector 找）。
    shell.head.appendChild(toggle)

    const summary = el(doc, 'div', 'si-summary')
    const note = el(doc, 'div', 'si-note', '开启后按「广告 + 跟踪器」规则拦截。')

    shell.body.appendChild(summary)
    shell.body.appendChild(note)

    let currentEnabled = true

    toggle.addEventListener('mousedown', (event) => {
      event.preventDefault()
      event.stopPropagation()
      if (toggle.disabled) return
      emit('adblocker-toggle', { enabled: !currentEnabled })
    })

    return {
      element: shell.root,
      update(state) {
        const blocking = state.blocking
        const loading = !!blocking.loading
        const enabled = blocking.enabled !== false
        const count = Number(blocking.count) || 0
        currentEnabled = enabled

        toggle.classList.toggle('is-on', enabled)
        toggle.classList.toggle('is-busy', !!blocking.busy)
        toggle.setAttribute('aria-checked', enabled ? 'true' : 'false')
        toggle.disabled = loading || !!blocking.busy
        toggle.title = enabled ? '点击关闭内容拦截' : '点击开启内容拦截'

        if (loading) summary.textContent = '正在读取拦截状态…'
        else if (enabled) summary.textContent = `广告 + 跟踪器 · 已拦截 ${formatCount(count)} 次`
        else summary.textContent = '已关闭 · 本站与所有站点均不拦截'

        note.hidden = !enabled || loading
      }
    }
  }
}

