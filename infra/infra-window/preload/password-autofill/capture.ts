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
interface CredentialCaptureOptions { isEnabled?(): boolean }

const LOGIN_LABEL_PATTERN = /\b(log[\s-]?in|sign[\s-]?in|submit|continue|next|enter)\b|登录|登陆|提交|确定|下一步|继续/i
const AUXILIARY_LABEL_PATTERN = /\b(show|hide|reveal|toggle|visibility|eye|cancel|forgot|reset|register|sign[\s-]?up|create account)\b|显示密码|隐藏密码|密码可见|眼睛|忘记|取消|注册|创建账号/i

function inputFromEvent(event: Event): HTMLInputElement | null {
  const path = typeof event.composedPath === 'function' ? event.composedPath() : null
  if (path) {
    for (const node of path) {
      if (node instanceof HTMLInputElement) return node
    }
  }
  return event.target instanceof HTMLInputElement ? event.target : null
}

function elementLabel(el: HTMLElement): string {
  const inputValue = el instanceof HTMLInputElement ? el.value : ''
  return [
    el.id,
    typeof el.className === 'string' ? el.className : '',
    el.getAttribute('name') || '',
    el.getAttribute('aria-label') || '',
    el.getAttribute('title') || '',
    el.innerText || el.textContent || inputValue || ''
  ].join(' ').trim()
}

function createCredentialCapture(
  scanner: CredentialCaptureScanner,
  handlers?: CredentialCaptureHandlers,
  options: CredentialCaptureOptions = {}
) {
  let lastTypedCredentials = { hostname: '', username: '', password: '', time: 0 }
  let lastCapturedCredential = { hostname: '', username: '', password: '', time: 0 }
  let lastTrustedInputAt = 0
  let isFormSubmitOverridden = false
  const submitBridgeToken = `submit-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`
  const isEnabled = () => !options.isEnabled || options.isEnabled() !== false

  function trackInput(e: Event): void {
    if (e.isTrusted === false) return
    const t = inputFromEvent(e)
    if (!t) return

    if (scanner.isUsernameLikeField(t) || scanner.isPasswordLikeField(t)) {
      installFormSubmitOverride()
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
    if (!isEnabled()) return
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
      now - lastTypedCredentials.time < 30 * 60 * 1000
    ) {
      usernameValue = lastTypedCredentials.username || ''
    }

    if (
      (!passwordValue || passwordValue.length === 0) &&
      lastTypedCredentials &&
      lastTypedCredentials.hostname === window.location.hostname &&
      now - lastTypedCredentials.time < 30 * 60 * 1000
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
      if (type === 'submit') return true
    }

    const role = (el.getAttribute && String(el.getAttribute('role') || '').toLowerCase()) || ''
    const label = elementLabel(el)
    const auxiliary = AUXILIARY_LABEL_PATTERN.test(label)
    if (!auxiliary && LOGIN_LABEL_PATTERN.test(label)) {
      if (
        role === 'button' ||
        el.tagName === 'BUTTON' ||
        el.tagName === 'A' ||
        (el.tagName === 'INPUT' && String(el.getAttribute('type') || '').toLowerCase() === 'button') ||
        el.hasAttribute('onclick') ||
        el.hasAttribute('tabindex') ||
        el.hasAttribute('data-action')
      ) {
        return true
      }
      /**
       * 大量 SPA 把“登录”写在 div/span 上，由框架委托处理，
       * 没有 role、form 或原生按钮语义。凭据输入已经发生且文案明确时，
       * 允许这一层进入捕获；辅助操作词表已在上面排除。
       */
      const text = String(el.innerText || el.textContent || '').trim()
      if (text && text.length <= 80) return true
    }

    /**
     * 纯图标登录按钮没有可读文案时，用“同一表单里唯一的非辅助按钮”兜底。
     * 眼睛 / 忘记密码 / 注册等按钮先由辅助词表排除，避免误把可见性切换当登录。
     */
    const passwordField = scanner.getBestPasswordField()
    const form = el.closest('form') ||
      (el instanceof HTMLButtonElement || el instanceof HTMLInputElement ? el.form : null)
    if (passwordField && form && passwordField.form === form && !auxiliary) {
      const semanticControl = el.matches(
        'button, [role="button"], input[type="submit"], input[type="button"], input[type="image"]'
      )
      if (semanticControl) return true
      let pointer = false
      try { pointer = getComputedStyle(el).cursor === 'pointer' } catch (_) {}
      if (
        pointer &&
        !(el instanceof HTMLInputElement) &&
        !(el instanceof HTMLTextAreaElement) &&
        !el.closest('label')
      ) return true
    }

    return false
  }

  /**
   * 覆盖 HTMLFormElement.prototype.submit，捕获 JS 触发的表单提交。
   * 对齐 Hira：隔离世界（contextIsolation）里修改 HTMLFormElement.prototype
   * 不影响页面主世界，因此用 webFrame.executeJavaScript 在主世界打补丁，
   * 通过 postMessage 把事件送回隔离世界。
   * 补丁必须收在 IIFE 内：否则 `origSubmit` 会泄漏成页面全局 `var`，与站点
   * 后续脚本的同名 `const/let` 冲突时会让整份脚本编译失败。
   */
  function installFormSubmitOverride() {
    if (!isEnabled() || isFormSubmitOverridden) return
    isFormSubmitOverridden = true

    let webFrame = null
    try {
       
      const electron = require('electron')
      webFrame = electron && electron.webFrame ? electron.webFrame : null
    } catch (_) {}

    if (webFrame && typeof webFrame.executeJavaScript === 'function') {
      try {
        webFrame.executeJavaScript(`
          (function () {
            if (window.__ngPasswordSubmitPatched) return
            window.__ngPasswordSubmitPatched = true
            var origSubmit = HTMLFormElement.prototype.submit
            var notify = function () {
              try {
                window.postMessage({ message: 'ngFormSubmit', token: ${JSON.stringify(submitBridgeToken)} })
              } catch (_) {}
            }
            HTMLFormElement.prototype.submit = function () {
              notify()
              return origSubmit.apply(this, arguments)
            }
          })()
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
      installFormSubmitOverride()
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
        // 先同步捕获一次：SPA 常在 click 处理里立刻跳转 / 清空 DOM，
        // 只等 setTimeout 会被导航销毁 preload，表现为“点了登录完全没反应”。
        sendCapturedCredentials()
        setTimeout(sendCapturedCredentials, 0)
      }
    }, true)

    window.addEventListener('keydown', function (e: KeyboardEvent) {
      if (!e) return
      if (e.isTrusted === false) return
      installFormSubmitOverride()
      const isEnter = e.key === 'Enter' || e.keyCode === 13
      if (!isEnter) return

      const passwordField = scanner.getBestPasswordField()
      if (!passwordField) return

      const usernameField = scanner.getBestUsernameField()
      const target = e.target
      if (target instanceof HTMLInputElement) {
        if (target === passwordField || (usernameField && target === usernameField)) {
          lastTrustedInputAt = Date.now()
          sendCapturedCredentials()
          setTimeout(sendCapturedCredentials, 0)
        }
      } else if (
        document.activeElement === passwordField ||
        (usernameField && document.activeElement === usernameField)
      ) {
        lastTrustedInputAt = Date.now()
        sendCapturedCredentials()
        setTimeout(sendCapturedCredentials, 0)
      }
    }, true)

    window.addEventListener('input', trackInput, true)
    window.addEventListener('change', trackInput, true)

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
    onRouteChange,
    captureNow: sendCapturedCredentials,
    syncSubmitOverride: installFormSubmitOverride
  }
}

export { createCredentialCapture }
