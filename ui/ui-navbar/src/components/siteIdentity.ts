/**
 * 站点身份按钮（地址栏字段左端的锁 / 地球）—— **哑组件**。
 *
 * 只做三件事：
 *   1. 按编排层灌下来的站点状态换图标（Lock / Globe）；
 *   2. 把「待处理权限请求数」与「本站存在权限规则」画成角标 / 圆点；
 *   3. 点击上抛「切换站点信息浮层」意图。
 *
 * 它不认识权限、Cookie、证书、面板、IPC —— 所有数据由 app-shell 计算后灌入。
 * 显隐同样由编排层判定（只有 http / https 页面才显示），组件不解析 URL。
 *
 * 与书签星同一套哑件范式：`createX(doc, handlers)` → `{ element, set(state) }`，
 * `element.hidden` 控显隐（`[hidden]` 规则由 actionButton 的 CSS 提供）。
 */

import { Lock, Globe } from '@hira-ng/ui-common'
import { createActionButton, setActionButtonIcon } from './actionButton'
import type { RectLike, SiteIdentityState } from '../types'

/** 地址栏内这颗按钮的图标尺寸：与工具栏动作按钮同档（18px），不再缩一档。 */
const ICON_SIZE = 18

/**
 * @typedef {Object} SiteIdentityState
 * @property {boolean} [visible]  是否显示（只有真实网页才显示）
 * @property {boolean} [secure]   连接是否安全（true → Lock，false → Globe）
 * @property {string}  [host]     当前主机名（tooltip 用）
 * @property {number}  [pending]  本站待处理权限请求数
 * @property {boolean} [hasRules] 本站是否存在已保存的权限规则
 * @property {boolean} [open]     聚合浮层当前是否展开
 */
/**
 * @param {Document} doc
 * @param {{ onToggle?: () => void, onIntent?: () => void }} [handlers]
 * @returns {{
 *   element: HTMLButtonElement,
 *   set: (state?: SiteIdentityState) => void,
 *   getAnchorRect: () => { left: number, top: number, width: number, height: number } | null
 * }}
 */
export function createSiteIdentity(
  doc: Document,
  handlers: { onToggle?: () => void; onIntent?: () => void } = {}
): {
  element: HTMLButtonElement
  set: (state?: SiteIdentityState) => void
  getAnchorRect: () => RectLike | null
} {
  const element = createActionButton(doc, {
    id: 'site-info',
    icon: Lock,
    title: '站点信息',
    size: ICON_SIZE,
    onClick: () => {
      if (typeof handlers.onToggle === 'function') handlers.onToggle()
    }
  })
  /**
   * 意图信号：把「即将打开站点信息浮层」提前交给编排层去**预热** renderer。
   * 指针一进入按钮就算意图（pointerdown 必然晚于 pointerenter，再报一次是多余路径）。
   * 组件只报这一件事，不认识浮层名与 IPC —— 与 onToggle 同一套哑件范式。
   */
  if (typeof handlers.onIntent === 'function') {
    element.addEventListener('pointerenter', () => handlers.onIntent?.())
  }
  element.classList.add('omnibox__site-identity')
  element.hidden = true
  element.setAttribute('aria-haspopup', 'dialog')
  element.setAttribute('aria-expanded', 'false')

  // 角标 / 圆点是图标的**覆盖层**：独立节点，绝不参与图标本身的换形。
  const badge = doc.createElement('span')
  badge.className = 'omnibox__site-identity-badge'
  badge.hidden = true
  badge.setAttribute('aria-hidden', 'true')

  const dot = doc.createElement('span')
  dot.className = 'omnibox__site-identity-dot'
  dot.hidden = true
  dot.setAttribute('aria-hidden', 'true')

  /**
   * 把覆盖层挂回按钮末尾。
   * 必须每次换图标后调用：setActionButtonIcon 会清空按钮全部子节点，
   * 不补挂就会出现「有规则没圆点 / 有待处理请求没角标」的幽灵状态。
   */
  function syncDecor() {
    if (badge.parentNode !== element) element.appendChild(badge)
    if (dot.parentNode !== element) element.appendChild(dot)
  }

  const state = {
    visible: false,
    secure: true,
    host: '',
    pending: 0,
    hasRules: false,
    open: false
  }

  /** @param {SiteIdentityState} next */
  function paint(next: SiteIdentityState = {}): void {
    const nextVisible = next.visible === true
    const nextSecure = next.secure !== false
    const host = typeof next.host === 'string' ? next.host : ''
    const pending = Number.isFinite(next.pending) ? Math.max(0, Math.trunc(next.pending as number)) : 0
    const hasRules = next.hasRules === true
    const open = next.open === true

    if (nextSecure !== state.secure) {
      state.secure = nextSecure
      // 换形不改元素本身：顺序 / 显隐 / 引用都不受影响（与刷新↔停止同一范式）
      setActionButtonIcon(element, nextSecure ? Lock : Globe, ICON_SIZE, { animate: false })
    }
    syncDecor()

    if (nextVisible !== state.visible) {
      state.visible = nextVisible
      element.hidden = !nextVisible
    }

    if (pending !== state.pending) {
      state.pending = pending
      const text = pending > 9 ? '9+' : String(pending)
      if (badge.textContent !== text) badge.textContent = text
    }
    // hidden 是布尔反射属性：赋同值不产生 DOM 变更，直接无条件对齐最省分支。
    badge.hidden = pending <= 0 || !nextVisible

    if (hasRules !== state.hasRules) state.hasRules = hasRules
    dot.hidden = !hasRules || !nextVisible

    if (open !== state.open) {
      state.open = open
      element.setAttribute('aria-expanded', open ? 'true' : 'false')
      element.classList.toggle('is-open', open)
    }

    const parts: string[] = []
    if (host) parts.push(host)
    parts.push(nextSecure ? '连接安全' : '连接不安全')
    if (pending > 0) parts.push(`${pending} 个待处理权限请求`)
    parts.push(open ? '已展开站点信息' : '点击查看站点信息')
    const title = parts.join(' · ')

    if (element.title !== title) element.title = title
    element.setAttribute('aria-label', title)
    // 不安全连接是**要用户注意**的状态：用弱警示色，但不动布局
    element.classList.toggle('is-insecure', nextVisible && !nextSecure)
  }

  paint({ visible: false, secure: true, host: '' })

  return {
    element,
    /** @param {SiteIdentityState} [next] */
    set(next: SiteIdentityState = {}) {
      paint(next)
    },
    /**
     * 浮层锚点矩形（视口坐标）。
     * 隐藏 / 未挂载时返回 null —— 编排层据此直接放弃打开，避免浮层贴在 (0,0)。
     */
    getAnchorRect() {
      if (element.hidden || !element.isConnected) return null
      const rect = element.getBoundingClientRect()
      if (rect.width <= 0 || rect.height <= 0) return null
      return { left: rect.left, top: rect.top, width: rect.width, height: rect.height }
    }
  }
}
