/**
 * Section：身份头。
 *
 * 只回答三个问题：**这是哪个站**、**连接安不安全**、**有没有本站自定义规则**。
 * 不做任何动作（纯展示）—— 动作入口在证书 / 权限 / 数据 / 拦截各区与 footer。
 */

import { iconByName } from '@hira-ng/ui-common/src/icons'
import { createFaviconImg, faviconSourceCandidates } from '@hira-ng/shared-types/src/favicon-src.mjs'
import { el } from './shared.js'

/** @type {import('./registry.js').SiteInfoSection} */
export const identitySection: import('./registry.js').SiteInfoSection = {
  id: 'identity',
  order: 10,
  create(ctx) {
    const { doc } = ctx

    const root = el(doc, 'section', 'si-section si-identity')
    root.dataset.section = 'identity'

    const faviconBox = el(doc, 'span', 'si-identity-favicon')
    const fallback = el(doc, 'span', 'si-identity-favicon-fallback')
    faviconBox.appendChild(fallback)

    const text = el(doc, 'div', 'si-identity-text')
    const host = el(doc, 'div', 'si-identity-host')
    const sub = el(doc, 'div', 'si-identity-sub')
    text.appendChild(host)
    text.appendChild(sub)

    const badge = el(doc, 'span', 'si-identity-badge')
    const badgeIcon = el(doc, 'span', 'si-identity-badge-icon')
    const badgeText = el(doc, 'span', 'si-identity-badge-text')
    badge.appendChild(badgeIcon)
    badge.appendChild(badgeText)

    root.appendChild(faviconBox)
    root.appendChild(text)
    root.appendChild(badge)

    /**
     * 站点图标：与面板 / 书签栏 / 内部页**同一条**取图规则
     * （`faviconSourceCandidates` → 主进程代理 → 直连原始 URL → 安全状态图标）。
     *
     * 这里曾经直接 `img.src = tab.favicon`：那是站点自己的**异源**地址，
     * 在浮层视图里既不受代理的限流/去重保护，失败形态也不可控（会被挂住），
     * 结果就是「图标要么空白、要么显示成上一个站点」。统一走真源即可。
     * @type {HTMLImageElement|null}
     */
    let faviconImg: HTMLImageElement|null = null
    let faviconKey = ''
    let lastSecure = false

    /** 回退图标只画「锁 / 地球」，不改变可见性（可见性由取图结果决定）。 */
    function paintFallback() {
      fallback.textContent = ''
      const svg = iconByName(lastSecure ? 'Lock' : 'Globe', doc, { size: 16 })
      if (svg) fallback.appendChild(svg)
    }

    function clearFavicon() {
      if (faviconImg) {
        faviconImg.remove()
        faviconImg = null
      }
      fallback.hidden = false
    }

    function renderFavicon(pageUrl: string, storedFavicon: unknown) {
      const stored = typeof storedFavicon === 'string' ? storedFavicon.trim() : ''
      const key = `${pageUrl || ''}\u0000${stored}`
      if (key === faviconKey) return
      faviconKey = key

      clearFavicon()
      const candidates = faviconSourceCandidates(pageUrl, stored)
      if (!candidates.primary) return

      const img = createFaviconImg(doc, candidates, {
        size: 18,
        className: 'si-identity-favicon-img',
        onFail: () => {
          if (faviconImg !== img) return
          clearFavicon()
        }
      })
      img.addEventListener('load', () => {
        if (faviconImg !== img) return
        fallback.hidden = true
      })
      faviconImg = img
      faviconBox.insertBefore(img, fallback)
    }

    function renderBadge(secure: boolean, protocol: string) {
      badge.classList.toggle('is-secure', secure)
      badge.classList.toggle('is-insecure', !secure)
      badgeIcon.textContent = ''
      const svg = iconByName(secure ? 'ShieldCheck' : 'ShieldX', doc, { size: 13 })
      if (svg) badgeIcon.appendChild(svg)
      badgeText.textContent = secure ? (protocol || 'HTTPS').toUpperCase() : '不安全'
      badge.title = secure ? '连接已加密' : '此站点未使用 HTTPS'
    }

    return {
      element: root,
      update(state) {
        const site = (state && state.context && state.context.site) || null
        const tab = (state && state.context && state.context.tab) || null
        const certificate = state.certificate

        const secure = !!(site && site.secure)
        const hostname = (site && (site.hostname || site.domain)) || ''
        host.textContent = hostname || (tab && tab.title) || '当前页面'

        const custom = !!(
          state &&
          state.permissions &&
          Array.isArray(state.permissions.rules) &&
          state.permissions.rules.some((rule) => rule.setting === 'allow' || rule.setting === 'block')
        )
        const parts: string[] = []
        if (!site || !site.url) parts.push('无活动页面')
        else if (secure) parts.push('连接安全')
        else parts.push('连接不安全')
        if (custom) parts.push('已自定义权限')
        sub.textContent = parts.join(' · ')

        // 页面地址既用于「众所周知的 /favicon.ico」兜底，也参与缓存键：
        // 切站后即便 favicon 字段为空，也能重新走一次解析（不会留着上一个站的图）。
        lastSecure = secure
        paintFallback()
        renderFavicon(
          (site && site.url) || (tab && tab.url) || '',
          tab && tab.favicon
        )

        renderBadge(secure, certificate.protocol || (secure ? 'HTTPS' : ''))
      }
    }
  }
}

