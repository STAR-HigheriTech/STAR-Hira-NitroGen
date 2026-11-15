/**
 * 子 iframe 的轻量密码捕获入口。
 *
 * 标签页没有开启 nodeIntegrationInSubFrames，完整 tab preload 不会进入 iframe；
 * 这里由 session.registerPreloadScript({ type: 'frame' }) 单独注册，只负责
 * “发现凭据输入框 → 捕获登录提交”，不装载自动填充 UI、菜单、手势或页面索引。
 *
 * 监听按需安装：大多数广告 / 嵌入 frame 永远没有密码框，只保留一个廉价探针。
 */

import { ipcRenderer } from 'electron'
import { PRELOAD_ROUTES } from '@hira-ng/shared-types/src/ipc-channels-preload'
import { isHttpProtocol } from '@hira-ng/shared-types/src/url-protocols'
import { createCredentialFieldScanner } from './password-autofill/fields.js'
import { createCredentialCapture } from './password-autofill/capture.js'

const CAPTURE_CHANNEL = `ngipc:invoke:${PRELOAD_ROUTES.passwordCaptured}`
const MAX_HOSTNAME_CHARS = 253
const MAX_USERNAME_CHARS = 512
const MAX_PASSWORD_CHARS = 8192

function isTopFrame(): boolean {
  try {
    return window === window.top
  } catch (_) {
    return false
  }
}

function eventInput(event: Event): HTMLInputElement | null {
  const path = typeof event.composedPath === 'function' ? event.composedPath() : null
  if (path) {
    for (const node of path) {
      if (node instanceof HTMLInputElement) return node
    }
  }
  return event.target instanceof HTMLInputElement ? event.target : null
}

function looksLikeCredentialInput(input: HTMLInputElement | null): boolean {
  if (!input) return false
  const type = String(input.type || '').toLowerCase()
  const autocomplete = String(input.getAttribute('autocomplete') || '').toLowerCase()
  return type === 'password' ||
    autocomplete === 'current-password' ||
    autocomplete === 'new-password' ||
    autocomplete === 'username' ||
    autocomplete === 'email'
}

function hasCredentialField(): boolean {
  try {
    return !!document.querySelector(
      'input[type="password"],input[autocomplete="current-password"],' +
      'input[autocomplete="new-password"],input[autocomplete="username"],input[autocomplete="email"]'
    )
  } catch (_) {
    return false
  }
}

if (!isTopFrame() && isHttpProtocol(window.location.protocol)) {
  let started = false

  const activate = (captureNow = false): void => {
    if (started) return
    started = true
    try {
      window.removeEventListener('focusin', probe, true)
      window.removeEventListener('submit', probe, true)
    } catch (_) {}

    const scanner = createCredentialFieldScanner()
    const capture = createCredentialCapture(scanner, {
      onCaptured(username, password) {
        const hostname = String(window.location.hostname || '')
        if (!hostname || hostname.length > MAX_HOSTNAME_CHARS) return
        if (username.length > MAX_USERNAME_CHARS || password.length > MAX_PASSWORD_CHARS) return
        try {
          Promise.resolve(ipcRenderer.invoke(CAPTURE_CHANNEL, { hostname, username, password })).catch(() => {})
        } catch (_) {}
      }
    })
    capture.bind()
    scanner.startObserver(9000)
    scanner.scheduleRefresh()
    if (captureNow) capture.captureNow()
  }

  function probe(event: Event): void {
    if (!event.isTrusted) return
    try {
      if (event.type === 'submit') {
        activate(true)
        return
      }
      const input = eventInput(event)
      if (input && (hasCredentialField() || looksLikeCredentialInput(input))) activate()
    } catch (_) {}
  }

  const initialProbe = (): void => {
    if (hasCredentialField()) activate()
  }

  window.addEventListener('focusin', probe, true)
  window.addEventListener('submit', probe, true)
  if (document.readyState === 'loading') {
    window.addEventListener('DOMContentLoaded', () => setTimeout(initialProbe, 400), { once: true })
  } else {
    setTimeout(initialProbe, 400)
  }
}
