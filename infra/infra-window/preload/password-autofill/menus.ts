/**
 * menus.js — 多凭据选择下拉（可插拔菜单实现）
 *
 * Hira 通过独立原生窗口展示多凭据菜单；本模块提供一个页内 DOM 下拉实现，
 * 行为一致：列出各凭据用户名，点击即填充，点击外部 / Esc 关闭。
 * 通过 bridge.setMenuProvider() 注册，未来可整体替换为原生 BrowserWindow 实现，
 * 不影响其它引擎模块。
 *
 * 配色**全部走主题令牌**（`theme-accent.js` 在 `show()` 时写到菜单根节点上）：
 * 表面色 / 前景色 / 边框 / hover 软底都由主题产出，深浅模式不再靠另插一份
 * 硬编码 `#2a2a2a` 的 style 覆盖（那份样式还曾因反复 show 而堆积）。
 */

// 主题令牌：菜单是浅 DOM 节点，变量写到根节点即可向下继承。
import { applyAccentVars } from '../theme-accent.js'
import type { PasswordCredential } from './bridge.js'

const MENU_CSS = `
.ng-autofill-menu {
  position: relative;
  z-index: 2147483647;
  min-width: 220px;
  max-width: 340px;
  max-height: 240px;
  overflow: auto;
  background: var(--hira-bg-surface, #fff);
  color: var(--hira-text-primary, #222);
  border: 1px solid var(--hira-border-subtle, rgba(128,128,128,.28));
  border-radius: 8px;
  box-shadow: 0 6px 24px rgba(0,0,0,.18);
  font-family: var(--hira-font-ui, "Segoe UI Variable Text", "Segoe UI Variable", "Segoe UI", "Microsoft YaHei UI", "Microsoft YaHei", "PingFang SC", "Noto Sans SC", system-ui, -apple-system, sans-serif);
  font-size: 13px;
  padding: 4px;
}
.ng-autofill-menu__title { padding: 6px 8px 4px; font-size: 11px; opacity: .6; border-bottom: 1px solid var(--hira-border-subtle, rgba(128,128,128,.18)); margin-bottom: 4px; }
.ng-autofill-menu__item { display: flex; align-items: center; gap: 8px; padding: 8px; border-radius: 6px; cursor: pointer; user-select: none; }
.ng-autofill-menu__item:hover { background: var(--hira-accent-soft, rgba(128,128,128,.12)); }
.ng-autofill-menu__item-un { font-weight: 600; }
.ng-autofill-menu__item-ct { margin-left: auto; opacity: .7; font-size: 12px; letter-spacing: .5px; font-variant-numeric: tabular-nums; }
.ng-autofill-menu__empty { padding: 12px 8px; text-align: center; opacity: .6; }
`

/**
 * 部分屏蔽密码（Edge 风格）：保留首 2 与尾 1，中间用圆点；太短则全圆点。
 * 仅供浮层展示，避免明文完整暴露，也不影响实际填充（仍用 cred.password）。
 * @param {string} pw
 * @returns {string}
 */
function maskPartial(pw: unknown): string {
  const chars = Array.from(String(pw ?? ''))
  if (chars.length === 0) return ''
  const visible = chars.length <= 1 ? 0 : Math.min(2, chars.length - 1)
  return chars.slice(0, visible).join('') + '*'.repeat(chars.length - visible)
}

/**
 * 创建多凭据下拉，作为 bridge.showMenu 的默认提供者。
 * @param {Object} handlers
 * @param {(cred:Object)=>void} handlers.onPick 选中凭据回调
 */
interface CredentialMenuHandlers { onPick?(credential: PasswordCredential): void }

function createCredentialMenu(handlers: CredentialMenuHandlers) {
  let hostEl: HTMLDivElement | null = null
  let menuEl: HTMLDivElement | null = null

  function remove(): void {
    if (hostEl && hostEl.parentNode) hostEl.parentNode.removeChild(hostEl)
    hostEl = null
    menuEl = null
    document.removeEventListener('mousedown', onDocMouseDown, true)
    document.removeEventListener('keydown', onDocKeyDown, true)
  }

  function onDocMouseDown(e: MouseEvent): void {
    if (hostEl && !(e.target instanceof Node && hostEl.contains(e.target))) {
      remove()
    }
  }

  function onDocKeyDown(e: KeyboardEvent): void {
    if (e.key === 'Escape') remove()
  }

  /**
   * 菜单提供者函数（与 bridge.showMenu 契约一致）。
   * @param {string} hostname
   * @param {Array} credentials
   * @param {HTMLElement|null} anchorEl
   */
  function show(hostname: string, credentials: PasswordCredential[], anchorEl: HTMLElement | null): void {
    remove()
    if (!credentials || credentials.length < 1) return

    const host = document.createElement('div')
    Object.assign(host.style, {
      all: 'initial',
      display: 'block',
      visibility: 'visible',
      opacity: '1',
      position: 'fixed',
      width: '0',
      height: '0',
      pointerEvents: 'none',
      zIndex: '2147483647'
    })
    const shadow = host.attachShadow({ mode: 'closed' })
    const style = document.createElement('style')
    style.textContent = MENU_CSS
    shadow.appendChild(style)

    const menu = document.createElement('div')
    menu.className = 'ng-autofill-menu'
    menu.style.pointerEvents = 'auto'
    // 主题令牌写到菜单根节点：表面/文字/边框/hover 软底全部跟随当前主题。
    try { applyAccentVars(menu) } catch (_) {}
    const title = document.createElement('div')
    title.className = 'ng-autofill-menu__title'
    title.textContent = hostname
    menu.appendChild(title)

    for (const cred of credentials) {
      const item = document.createElement('div')
      item.className = 'ng-autofill-menu__item'
      const un = document.createElement('span')
      un.className = 'ng-autofill-menu__item-un'
      un.textContent = cred.username || '(未填用户名)'
      item.appendChild(un)
      const ct = document.createElement('span')
      ct.className = 'ng-autofill-menu__item-ct'
      ct.textContent = maskPartial(cred.password)
      item.appendChild(ct)
      item.addEventListener('mousedown', (event) => {
        if (!event.isTrusted) return
        if (handlers && typeof handlers.onPick === 'function') handlers.onPick(cred)
        remove()
      })
      menu.appendChild(item)
    }

    shadow.appendChild(menu)
    document.body.appendChild(host)
    hostEl = host
    menuEl = menu

    // 定位：锚点输入框右下（回退到当前聚焦元素或鼠标附近）
    let left = 0
    let top = 0
    const rects = menuEl.getBoundingClientRect()
    const menuW = rects.width || 240
    const menuH = rects.height || 160

    if (anchorEl && anchorEl.getBoundingClientRect) {
      const ar = anchorEl.getBoundingClientRect()
      left = ar.left
      top = ar.bottom + 4
      // 防止溢出视口
      if (left + menuW > window.innerWidth - 8) left = Math.max(8, window.innerWidth - menuW - 8)
      if (top + menuH > window.innerHeight - 8) top = Math.max(8, ar.top - menuH - 4)
    } else {
      left = 24
      top = 24
    }

    host.style.left = left + 'px'
    host.style.top = top + 'px'

    document.addEventListener('mousedown', onDocMouseDown, true)
    document.addEventListener('keydown', onDocKeyDown, true)
  }

  return { show }
}

export { createCredentialMenu }
