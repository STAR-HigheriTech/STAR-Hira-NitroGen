/**
 * capture.js — 登录凭据捕获（完全复刻 Hira passwordFill.js 捕获逻辑）
 *
 * 职责：在用户提交登录表单 / 点击登录按钮 / 按回车 / 页面卸载时，
 * 收集“用户名 + 密码”，并回调给上层（用于弹出保存提示）。
 *
 * 覆盖场景（对齐 Hira）：
 *   - <form> submit 事件
 *   - HTMLFormElement.prototype.submit 拦截（覆盖 JS 触发的提交）
 *   - 登录按钮点击（支持 BUTTON / INPUT type=submit|button / role=button，
 *     命中多语言“登录/提交/确定/下一步/continue/next”等）
 *   - 密码/用户名框内回车
 *   - input 实时记录 lastTyped（登录后表单清空也能回退补全）
 *   - pagehide / beforeunload
 *   - 前后 5s 去重
 */

interface CredentialCaptureScanner {
  isUsernameLikeField(input: HTMLInputElement): boolean
  isPasswordLikeField(input: HTMLInputElement): boolean
  startObserver(ms: number): void
  scheduleRefresh(): void
  getBestUsernameField(): HTMLInputElement | null
  getBestPasswordField(): HTMLInputElement | null
}
interface CredentialCaptureHandlers { onCaptured?(username: string, password: string): void }

function createCredentialCapture(scanner: CredentialCaptureScanner, handlers?: CredentialCaptureHandlers) {
  let lastTypedCredentials = { hostname: '', username: '', password: '', time: 0 }
  let lastCapturedCredential = { hostname: '', username: '', password: '', time: 0 }
  let lastTrustedInputAt = 0
  let isFormSubmitOverridden = false
  const submitBridgeToken = `submit-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`

  function trackInput(e: Event): void {
    if (e.isTrusted === false) return
    const t = e.target
    if (!(t instanceof HTMLInputElement)) return

    if (scanner.isUsernameLikeField(t) || scanner.isPasswordLikeField(t)) {
      lastTrustedInputAt = Date.now()
      scanner.startObserver(9000)
      scanner.scheduleRefresh()
    }

    const now = Date.now()
    if (scanner.isPasswordLikeField(t)) {
      const passwordValue = String(t.value || '')
      if (passwordValue) {
        lastTypedCredentials = {
          hostname: window.location.hostname,
          username:
            lastTypedCredentials && lastTypedCredentials.hostname === window.location.hostname
              ? lastTypedCredentials.username
              : '',
          password: passwordValue,
          time: now
        }
      }
    } else if (scanner.isUsernameLikeField(t)) {
      const usernameValue = String(t.value || '')
      if (usernameValue) {
        lastTypedCredentials = {
          hostname: window.location.hostname,
          username: usernameValue,
          password:
            lastTypedCredentials && lastTypedCredentials.hostname === window.location.hostname
              ? lastTypedCredentials.password
              : '',
          time: now
        }
      }
    }
  }

  function sendCapturedCredentials(): void {
    const now = Date.now()
    const recentUserActivity = Math.max(lastTrustedInputAt, lastTypedCredentials.time)
    // Scripts cannot forge trusted input/events. Without a recent real interaction,
    // a page cannot invent credentials and pop a save prompt.
    if (!recentUserActivity || now - recentUserActivity > 30 * 60 * 1000) return
    let usernameValue = scanner.getBestUsernameField()?.value || ''

    const passwordField = scanner.getBestPasswordField()
    let passwordValue = passwordField?.value || ''

    if (
      !usernameValue &&
      lastTypedCredentials &&
      lastTypedCredentials.hostname === window.location.hostname &&
      now - lastTypedCredentials.time < 120000
    ) {
      usernameValue = lastTypedCredentials.username || ''
    }

    if (
      (!passwordValue || passwordValue.length === 0) &&
      lastTypedCredentials &&
      lastTypedCredentials.hostname === window.location.hostname &&
      now - lastTypedCredentials.time < 120000
    ) {
      passwordValue = lastTypedCredentials.password || ''
      if (!usernameValue) usernameValue = lastTypedCredentials.username || ''
    }

    if (!passwordValue || passwordValue.length === 0) return

    if (
      lastCapturedCredential &&
      lastCapturedCredential.hostname === window.location.hostname &&
      lastCapturedCredential.username === usernameValue &&
      lastCapturedCredential.password === passwordValue &&
      now - lastCapturedCredential.time < 5000
    ) {
      return
    }

    lastCapturedCredential = {
      hostname: window.location.hostname,
      username: usernameValue,
      password: passwordValue,
      time: now
    }

    if (handlers && typeof handlers.onCaptured === 'function') {
      handlers.onCaptured(usernameValue, passwordValue)
    }
  }

  function handleFormSubmit(event?: Event): void {
    if (event && event.isTrusted === false) return
    if (event && event.isTrusted) lastTrustedInputAt = Date.now()
    sendCapturedCredentials()
  }

  function isLikelyLoginClickTarget(el: EventTarget | null): boolean {
    if (!(el instanceof HTMLElement)) return false
    if ('disabled' in el && Boolean((el as HTMLElement & { disabled?: boolean }).disabled)) return false

    if (el.tagName === 'BUTTON') {
      const type = String(el.getAttribute('type') || '').toLowerCase()
      if (type === 'submit' || type === '') return true
    }

    if (el.tagName === 'INPUT') {
      const type = String(el.getAttribute('type') || '').toLowerCase()
      if (type === 'submit' || type === 'button') return true
    }

    const role = (el.getAttribute && String(el.getAttribute('role') || '').toLowerCase()) || ''
    if (role === 'button') {
      const id = String(el.id || '')
      const className = typeof el.className === 'string' ? el.className : ''
      const label = (el.getAttribute && String(el.getAttribute('aria-label') || '')) || ''
      const inputValue = el instanceof HTMLInputElement ? el.value : ''
      const text = String((el.innerText || el.textContent || inputValue || '')).trim()
      const lower = (id + ' ' + className + ' ' + label + ' ' + text).toLowerCase()

      if (
        lower.includes('login') ||
        lower.includes('log in') ||
        lower.includes('signin') ||
        lower.includes('sign in') ||
        lower.includes('submit') ||
        lower.includes('continue') ||
        lower.includes('next') ||
        text.includes('登录') ||
        text.includes('登陆') ||
        text.includes('提交') ||
        text.includes('确定') ||
        text.includes('下一步')
      ) {
        return true
      }
    }

    return false
  }

  /**
   * 覆盖 HTMLFormElement.prototype.submit，捕获 JS 触发的表单提交。
   * 对齐 Hira：隔离世界（contextIsolation）里修改 HTMLFormElement.prototype
   * 不影响页面主世界，因此用 webFrame.executeJavaScript 在主世界打补丁，
   * 通过 postMessage 把事件送回隔离世界。
   */
  function installFormSubmitOverride() {
    if (isFormSubmitOverridden) return
    isFormSubmitOverridden = true

    let webFrame = null
    try {
       
      const electron = require('electron')
      webFrame = electron && electron.webFrame ? electron.webFrame : null
    } catch (_) {}

    if (webFrame && typeof webFrame.executeJavaScript === 'function') {
      try {
        webFrame.executeJavaScript(`
          if (!window.__ngPasswordSubmitPatched) {
            window.__ngPasswordSubmitPatched = true
            var origSubmit = HTMLFormElement.prototype.submit
            HTMLFormElement.prototype.submit = function () {
              window.postMessage({ message: 'ngFormSubmit', token: ${JSON.stringify(submitBridgeToken)} })
              return origSubmit.apply(this, arguments)
            }
          }
        `).catch(function () {})
      } catch (_) {}
    }
  }

  function bind() {
    window.addEventListener('submit', handleFormSubmit, true)

    // 主世界 submit 补丁 → postMessage 回传
    window.addEventListener('message', function (e: MessageEvent) {
      if (e.data && typeof e.data === 'object' &&
          (e.data as { message?: unknown }).message === 'ngFormSubmit' &&
          (e.data as { token?: unknown }).token === submitBridgeToken) {
        handleFormSubmit()
      }
    }, true)

    window.addEventListener('click', function (e: MouseEvent) {
      if (e.isTrusted === false) return
      const legacyPath = (e as MouseEvent & { path?: EventTarget[] }).path
      const path = legacyPath || (e.composed ? e.composedPath() : null)
      if (!path) return
      let shouldCapture = false
      for (const el of path) {
        if (shouldCapture) break
        if (isLikelyLoginClickTarget(el)) shouldCapture = true
      }
      if (shouldCapture) {
        lastTrustedInputAt = Date.now()
        setTimeout(sendCapturedCredentials, 0)
      }
    }, true)

    window.addEventListener('keydown', function (e: KeyboardEvent) {
      if (!e) return
      if (e.isTrusted === false) return
      const isEnter = e.key === 'Enter' || e.keyCode === 13
      if (!isEnter) return

      const passwordField = scanner.getBestPasswordField()
      if (!passwordField) return

      const usernameField = scanner.getBestUsernameField()
      const target = e.target
      if (target instanceof HTMLInputElement) {
        if (target === passwordField || (usernameField && target === usernameField)) {
          lastTrustedInputAt = Date.now()
          setTimeout(sendCapturedCredentials, 0)
        }
      } else if (
        document.activeElement === passwordField ||
        (usernameField && document.activeElement === usernameField)
      ) {
        lastTrustedInputAt = Date.now()
        setTimeout(sendCapturedCredentials, 0)
      }
    }, true)

    window.addEventListener('input', trackInput, true)

    window.addEventListener('pagehide', sendCapturedCredentials, true)
    window.addEventListener('beforeunload', sendCapturedCredentials, true)

    installFormSubmitOverride()
  }

  // 路由切换时保留 lastTyped（Hira 同样不清空），但重置去重游标
  function onRouteChange() {
    lastCapturedCredential = { hostname: '', username: '', password: '', time: 0 }
  }

  return {
    bind,
    onRouteChange
  }
}

export { createCredentialCapture }
