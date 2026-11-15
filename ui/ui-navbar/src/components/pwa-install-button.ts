/**
 * PWA 安装按钮 —— **哑组件**：只按外部灌入的状态渲染图标、上抛意图。
 *
 * 三态（与 `docs-ng/PWA安装与应用窗口设计.md` §12.1 对齐）：
 *   none        当前页不可安装、也未安装 → 隐藏（不占位）
 *   installable 可安装 → 下载图标，点击上抛 onInstall
 *   installed   已安装 → 打开图标，点击上抛 onOpen(appId)
 *
 * 它不认识 IPC、不认识 PWA 库、不认识标签：
 *   · 真实状态由编排层（renderer/controllers/pwa-install-controller.ts）查 pwa:state 后经 set() 推下来；
 *   · 点击只发意图，是否 prepare / launch 由编排层决定。
 * 插件被禁用时，`CHROME_BUTTONS` 的 `feature: 'pwaApps'` 会把整颗按钮从目录里摘掉，
 * 因此本组件不需要自己判断"功能是否可用"。
 */

import { Download, ArrowUpRight } from '@hira-ng/ui-common'
import type { PwaInstallState, PwaInstallStatus } from '../types'

/**
 * @param {Document} doc
 * @param {{
 *   onInstall?: () => void,
 *   onOpen?: (appId: string) => void
 * }} [handlers]
 * @returns {{
 *   element: HTMLButtonElement,
 *   set: (state?: { state?: 'none'|'installable'|'installed', appId?: string|null, name?: string|null, title?: string }) => void,
 *   getState: () => { state: string, appId: string|null }
 * }}
 */
export function createPwaInstallButton(
  doc: Document,
  handlers: {
    onInstall?: () => void
    onOpen?: (appId: string | null) => void
  } = {}
): {
  element: HTMLButtonElement
  set: (state?: PwaInstallState) => void
  getState: () => { state: PwaInstallStatus; appId: string | null }
} {
  const element = doc.createElement('button')
  element.id = 'pwa-install-button'
  element.className = 'navbar-action-button'
  element.hidden = true
  element.setAttribute('aria-pressed', 'false')

  let state: PwaInstallStatus = 'none'
  let appId: string | null = null

  /** 只在状态真的变了才重建图标 —— 标签切换时 set() 会被高频调用。 */
  let renderedState = ''

  function render() {
    if (state === renderedState) return
    renderedState = state

    element.hidden = state === 'none'
    element.setAttribute('aria-pressed', String(state === 'installed'))

    // 先摘后挂：同一颗按钮元素不换，顺序 / 显隐 / 注册表引用都不受影响。
    while (element.firstChild) element.removeChild(element.firstChild)
    if (state === 'installable') element.appendChild(Download(doc, { size: 18 }))
    else if (state === 'installed') element.appendChild(ArrowUpRight(doc, { size: 18 }))
  }

  element.addEventListener('click', () => {
    if (state === 'installed') {
      if (typeof handlers.onOpen === 'function') handlers.onOpen(appId)
      return
    }
    if (state === 'installable' && typeof handlers.onInstall === 'function') handlers.onInstall()
  })

  render()

  return {
    element,
    set({ state: nextState, appId: nextAppId, name, title } = {}) {
      state = nextState === 'installable' || nextState === 'installed' ? nextState : 'none'
      appId = nextAppId || null

      if (state === 'installed') {
        element.title = title || (name ? `打开 ${name}` : '打开应用')
        element.setAttribute('aria-label', element.title)
      } else if (state === 'installable') {
        element.title = title || (name ? `将 ${name} 安装为应用` : '将此站点安装为应用')
        element.setAttribute('aria-label', element.title)
      } else {
        element.title = ''
        element.setAttribute('aria-label', '')
      }

      render()
    },
    getState: () => ({ state, appId })
  }
}
