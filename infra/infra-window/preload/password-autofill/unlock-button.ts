/**
 * unlock-button.js — 钥匙图标（自动填充触发按钮）控制（复刻 Hira）
 *
 * 职责：
 *   - 在聚焦的用户名/密码框右侧创建钥匙 SVG 按钮
 *   - 用 requestAnimationFrame 跟随输入框定位（滚动/缩放即时更新，避免抖动）
 *   - 绑定到具体输入框（_minTarget），输入框脱离文档即移除
 *   - 无匹配凭据时给出红色“无匹配”状态提示
 *
 * 解耦：点击行为通过 handlers.onActivate(input) 注入，按钮本身不感知凭据来源。
 */

import { KEY_ICON_SVG } from './constants.js'
// 悬浮按钮的 hover / 无匹配态都从主题令牌派生（注入式 UI 读不到外壳 CSS）。
import { applyAccentVars, subscribeAccent } from '../theme-accent.js'

interface UnlockButtonScanner {
  getBestPasswordField(): HTMLInputElement | null
  getBestUsernameField(): HTMLInputElement | null
}
interface UnlockButtonHandlers { onActivate?(input: HTMLInputElement): void }
type UnlockButtonElement = HTMLDivElement & { _minDefaultColor?: string; _ngNoMatch?: boolean }
type UnlockHolder = HTMLDivElement & { _minUnlockButton?: UnlockButtonElement; _minTarget?: HTMLInputElement }

function createUnlockButtonController(scanner: UnlockButtonScanner, handlers?: UnlockButtonHandlers) {
  let currentButton: UnlockHolder | null = null
  /** 主题订阅只挂一次（按钮会随焦点反复重建，不能每次重建都登记）。 */
  let accentBound = false

  function bindAccent(holder: HTMLElement): void {
    try { applyAccentVars(holder) } catch (_) {}
    if (accentBound) return
    accentBound = true
    subscribeAccent((vars: Record<string, string>) => {
      const target = currentButton
      if (!target) return
      for (const key of Object.keys(vars)) {
        try { target.style.setProperty(key, vars[key]) } catch (_) {}
      }
    })
  }

  function createButton(input: HTMLInputElement): UnlockHolder {
    const inputRect = input.getBoundingClientRect()

    const holder = document.createElement('div') as UnlockHolder
    holder.style.width = '20px'
    holder.style.height = '20px'
    holder.style.zIndex = '999999999999999'
    holder.style.position = 'absolute'
    holder.style.left = Math.round(window.scrollX + (inputRect.left + inputRect.width - 20 - 10)) + 'px'
    holder.style.top = Math.round(window.scrollY + (inputRect.top + (inputRect.height - 20) / 2.0)) + 'px'

    const button = document.createElement('div') as UnlockButtonElement
    button.style.width = '20px'
    button.style.height = '20px'
    button.style.opacity = '0.7'
    button.style.color = window.getComputedStyle(input).color
    button.style.transition = '0.1s color, 0.1s background-color'
    button.style.display = 'flex'
    button.style.alignItems = 'center'
    button.style.justifyContent = 'center'
    button.style.borderRadius = '6px'
    button.style.cursor = 'pointer'
    button.style.backgroundColor = 'transparent'
    button.innerHTML = KEY_ICON_SVG
    button._minDefaultColor = button.style.color
    button._ngNoMatch = false

    button.addEventListener('mouseenter', () => {
      button.style.opacity = '1.0'
      if (!button._ngNoMatch) {
        button.style.backgroundColor = 'var(--hira-accent-soft, rgba(128, 128, 128, 0.16))'
      }
    })
    button.addEventListener('mouseleave', () => {
      button.style.opacity = '0.7'
      if (!button._ngNoMatch) button.style.backgroundColor = 'transparent'
    })
    button.addEventListener('mousedown', (event) => {
      if (!event.isTrusted) return
      event.preventDefault()
      if (handlers && typeof handlers.onActivate === 'function') {
        handlers.onActivate(input)
      }
    })

    holder.appendChild(button)
    holder._minUnlockButton = button
    holder._minTarget = input
    bindAccent(holder)

    return holder
  }

  function removeButton(): void {
    if (currentButton !== null && currentButton.parentElement != null) {
      currentButton.parentElement.removeChild(currentButton)
    }
    currentButton = null
  }

  function maybeAddButton(target: EventTarget | null): void {
    if (!(target instanceof HTMLInputElement)) return

    const passwordField = scanner.getBestPasswordField()
    const usernameField = scanner.getBestUsernameField()

    if (!passwordField || !usernameField) return
    if (!passwordField.isSameNode(target) && !usernameField.isSameNode(target)) return

    removeButton()
    currentButton = createButton(target)
    document.body.appendChild(currentButton)
  }

  function updatePosition(): void {
    if (!currentButton || !currentButton._minTarget) return
    const input = currentButton._minTarget
    if (!input.isConnected) {
      removeButton()
      return
    }
    const rect = input.getBoundingClientRect()
    if (!rect || !rect.width || !rect.height) {
      removeButton()
      return
    }
    currentButton.style.left =
      Math.round(window.scrollX + (rect.left + rect.width - 20 - 10)) + 'px'
    currentButton.style.top =
      Math.round(window.scrollY + (rect.top + (rect.height - 20) / 2.0)) + 'px'
  }

  function schedulePositionUpdate(): void {
    if (!currentButton) return
    requestAnimationFrame(updatePosition)
  }

  function setState(state: 'no-match' | 'default'): void {
    if (!currentButton || !currentButton._minUnlockButton) return
    const button = currentButton._minUnlockButton
    const defaultColor = button._minDefaultColor || button.style.color

    if (state === 'no-match') {
      button._ngNoMatch = true
      button.style.color = defaultColor
      button.style.backgroundColor =
        'color-mix(in srgb, var(--hira-danger, #ef4444) 12%, transparent)'
      button.style.boxShadow =
        '0 0 0 1px color-mix(in srgb, var(--hira-danger, #ef4444) 35%, transparent)'
      button.style.borderRadius = '6px'
      button.style.opacity = '1.0'
      return
    }

    button._ngNoMatch = false
    button.style.color = defaultColor
    button.style.backgroundColor = ''
    button.style.boxShadow = ''
    button.style.borderRadius = ''
  }

  return {
    maybeAddButton,
    removeButton,
    updatePosition,
    schedulePositionUpdate,
    setState
  }
}

export { createUnlockButtonController }
