/**
 * fields.js — 凭据字段识别与评分（完全复刻 Hira passwordFill.js 识别引擎）
 *
 * 职责：
 *   - 密码框 / 用户名框 / 确认密码框检测
 *   - OTP（一次性验证码）排除
 *   - 字段评分（密码 type 优先、autocomplete 标记加分、同表单加权）
 *   - 字段缓存 + MutationObserver 动态表单监听
 *   - 字段变更后的“陈旧自动填充清理”钩子（由 fill.js 注入，避免循环依赖）
 *
 * 对外只暴露工厂函数 createCredentialFieldScanner()，内部状态隔离。
 */

import {
  FIELD_ATTRS,
  FIELD_ATTRS_NO_AUTOCOMPLETE,
  USERNAME_KEYWORDS,
  USERNAME_FALLBACK_KEYWORDS,
  EXCLUDE_KEYWORDS,
  PASSWORD_KEYWORDS,
  OTP_KEYWORDS,
  OTP_CHINESE_HINTS
} from './constants.js'
// 可填 / 可作用户名的 input type 唯一真源（与地址填充共用一份清单）。
import { USERNAME_INPUT_TYPES, isTextInputType, isUsernameInputType } from '../field-types.js'

// ── 基础判定工具（纯函数）──────────────────────────────

function checkAttributes(el: HTMLInputElement, attrs: readonly string[], matches: readonly string[]): boolean {
  for (const attribute of attrs) {
    const value = el.getAttribute(attribute)
    if (value == null) continue
    if (matches.some((m) => value.toLowerCase().includes(m))) return true
  }
  return false
}

function isConnectedInput(field: HTMLInputElement | null | undefined): boolean {
  return !!(field && field.tagName === 'INPUT' && document.contains(field))
}

function isLikelyOneTimeCodeField(field: HTMLInputElement): boolean {
  const otps = OTP_KEYWORDS
  if (checkAttributes(field, FIELD_ATTRS, otps)) return true
  const placeholder = String(field.getAttribute('placeholder') || '')
  const label = String(field.getAttribute('aria-label') || '')
  const text = (placeholder + ' ' + label).trim()
  if (OTP_CHINESE_HINTS.some((h) => text.includes(h))) return true
  return false
}

function isPasswordLikeField(field: HTMLInputElement | null | undefined): field is HTMLInputElement {
  if (!field || field.tagName !== 'INPUT') return false
  if (field.type === 'hidden') return false
  if (field.type === 'password') return true
  if (!isTextInputType(field.type)) return false
  if (isLikelyOneTimeCodeField(field)) return false
  const autocompleteValue = String(field.getAttribute('autocomplete') || '').toLowerCase()
  if (
    autocompleteValue === 'current-password' ||
    autocompleteValue === 'new-password' ||
    autocompleteValue === 'password'
  ) {
    return true
  }
  return checkAttributes(field, FIELD_ATTRS, PASSWORD_KEYWORDS)
}

function isUsernameLikeField(field: HTMLInputElement | null | undefined): field is HTMLInputElement {
  if (!field || field.tagName !== 'INPUT') return false
  if (!isUsernameInputType(field.type)) return false
  if (checkAttributes(field, FIELD_ATTRS, EXCLUDE_KEYWORDS)) return false

  const autocompleteValue = String(field.getAttribute('autocomplete') || '').toLowerCase()
  if (
    autocompleteValue === 'username' ||
    autocompleteValue === 'email' ||
    autocompleteValue === 'tel' ||
    autocompleteValue === 'tel-national' ||
    autocompleteValue === 'tel-local'
  ) {
    return true
  }

  return checkAttributes(field, FIELD_ATTRS, USERNAME_KEYWORDS)
}

function getPasswordConfirmationField(primaryField: HTMLInputElement): HTMLInputElement | null {
  const autocompleteMarkedFields = Array.from(document.querySelectorAll('[autocomplete="new-password"]'))
  if (autocompleteMarkedFields.length > 0) {
    return autocompleteMarkedFields.find((field): field is HTMLInputElement => field instanceof HTMLInputElement && field !== primaryField) || null
  }
  const bestConfirmInput = getBestInput(['confirm', 'retype'], [], ['password'])
  if (bestConfirmInput && bestConfirmInput !== primaryField) {
    return bestConfirmInput
  }
  return null
}

function scorePasswordField(field: HTMLInputElement | null | undefined): number {
  if (!field) return 0
  if (field.type === 'password') return 3
  const autocompleteValue = String(field.getAttribute('autocomplete') || '').toLowerCase()
  if (
    autocompleteValue === 'current-password' ||
    autocompleteValue === 'new-password' ||
    autocompleteValue === 'password'
  ) {
    return 2
  }
  return 1
}

function scoreUsernameField(field: HTMLInputElement | null | undefined, passwordField: HTMLInputElement | null | undefined): number {
  if (!field) return 0
  let score = 1
  const autocompleteValue = String(field.getAttribute('autocomplete') || '').toLowerCase()
  if (
    autocompleteValue === 'username' ||
    autocompleteValue === 'email' ||
    autocompleteValue.startsWith('tel')
  ) {
    score += 2
  }
  if (passwordField && passwordField.form && field.form && passwordField.form === field.form) score += 2
  return score
}

function getBestInput(names: readonly string[], exclusionNames: readonly string[], types: readonly string[]): HTMLInputElement | null {
  const allFields = [
    ...document.querySelectorAll<HTMLInputElement>('form input'),
    ...document.querySelectorAll<HTMLInputElement>('input')
  ]
  for (const field of allFields) {
    if (!types.includes(field.type)) continue
    if (
      names.length === 0 ||
      checkAttributes(field, FIELD_ATTRS_NO_AUTOCOMPLETE, names)
    ) {
      if (
        !checkAttributes(field, FIELD_ATTRS_NO_AUTOCOMPLETE, exclusionNames) &&
        field.type !== 'hidden'
      ) {
        return field
      }
    }
  }
  return null
}

// ── 扫描器（有状态：缓存 + observer）───────────────────

/**
 * 创建凭据字段扫描器实例。
 * @returns {Object} 字段识别 API
 */
interface CredentialFieldCache {
  time: number
  passwordField: HTMLInputElement | null
  usernameField: HTMLInputElement | null
}

function createCredentialFieldScanner() {
  const cache: CredentialFieldCache = { time: 0, passwordField: null, usernameField: null }
  let cacheRAF: number | null = null
  let observer: MutationObserver | null = null
  let observerStopTimer: ReturnType<typeof setTimeout> | null = null
  let observerDebounce: ReturnType<typeof setTimeout> | null = null
  const refreshListeners: Array<(cache: CredentialFieldCache) => void> = []
  /** 陈旧自动填充清理器（由 fill.js 注入） */
  let staleFieldCleaner: ((field: HTMLInputElement) => void) | null = null

  function getAllInputs(): HTMLInputElement[] {
    return Array.from(document.querySelectorAll<HTMLInputElement>('input'))
  }

  /**
   * 刷新字段缓存（200ms 节流）。
   * 若之前已自动填充的字段不再是“最优字段”，调用注入的清理器清空并移除高亮。
   */
  function refreshCache(): CredentialFieldCache {
    const now = Date.now()

    if (cache.time && now - cache.time < 200) {
      if (isConnectedInput(cache.passwordField) || isConnectedInput(cache.usernameField)) {
        return cache
      }
    }

    cache.time = now

    const prevPassword = cache.passwordField
    const prevUsername = cache.usernameField

    let bestPassword: HTMLInputElement | null = null
    let bestPasswordScore = 0

    const allInputs = getAllInputs()
    for (const field of allInputs) {
      if (!isPasswordLikeField(field)) continue
      const s = scorePasswordField(field)
      if (s > bestPasswordScore) {
        bestPasswordScore = s
        bestPassword = field
        if (s >= 3) break
      }
    }

    let bestUsername: HTMLInputElement | null = null
    let bestUsernameScore = 0

    if (bestPassword && bestPassword.form) {
      const formInputs = Array.from(bestPassword.form.querySelectorAll('input'))
      for (const field of formInputs) {
        if (!isUsernameLikeField(field)) continue
        const s = scoreUsernameField(field, bestPassword)
        if (s > bestUsernameScore) {
          bestUsernameScore = s
          bestUsername = field
        }
      }
    }

    if (!bestUsername) {
      for (const field of allInputs) {
        if (!isUsernameLikeField(field)) continue
        const s = scoreUsernameField(field, bestPassword)
        if (s > bestUsernameScore) {
          bestUsernameScore = s
          bestUsername = field
        }
      }
    }

    cache.passwordField = bestPassword
    cache.usernameField = bestUsername

    // 清理已失效的自动填充（复刻 Hira 行为：字段漂移后清空残留凭据）
    if (
      prevPassword &&
      prevPassword !== bestPassword &&
      prevPassword.dataset &&
      prevPassword.dataset.minAutofilled === '1' &&
      typeof staleFieldCleaner === 'function'
    ) {
      staleFieldCleaner(prevPassword)
    }

    if (
      prevUsername &&
      prevUsername !== bestUsername &&
      prevUsername.dataset &&
      prevUsername.dataset.minAutofilled === '1' &&
      typeof staleFieldCleaner === 'function'
    ) {
      staleFieldCleaner(prevUsername)
    }

    for (const fn of refreshListeners) {
      try { fn(cache) } catch (_) {}
    }

    return cache
  }

  /** 下一帧调度刷新 */
  function scheduleRefresh(): void {
    if (cacheRAF) return
    cacheRAF = requestAnimationFrame(function () {
      cacheRAF = null
      cache.time = 0
      refreshCache()
    })
  }

  function stopObserver(): void {
    if (observer) {
      observer.disconnect()
      observer = null
    }
    if (observerStopTimer) {
      clearTimeout(observerStopTimer)
      observerStopTimer = null
    }
    if (observerDebounce) {
      clearTimeout(observerDebounce)
      observerDebounce = null
    }
  }

  /**
   * 监听 DOM 变化以支持动态渲染的登录表单。
   * @param {number} [timeout] 监听超时（毫秒），默认 9000
   */
  function startObserver(timeout: number = 9000): void {
    if (observer) return
    const root = document.documentElement
    if (!root) return

    // DOM 变动 → 去抖刷新（而非每帧 rAF）。
    // 原实现每次 MutationObserver 回调都 scheduleRefresh()，而 scheduleRefresh 会
    // 重置节流并触发全量 querySelectorAll('input') 重扫 —— 在 DOM 频繁变动的站点上
    // 等于「每帧全文档扫描」，是页面卡顿的主因。去抖后单次开销有上界。
    observer = new window.MutationObserver(function () {
      if (observerDebounce) return
      observerDebounce = setTimeout(function () {
        observerDebounce = null
        cache.time = 0
        refreshCache()
      }, 400)
    })
    observer.observe(root, { childList: true, subtree: true })

    observerStopTimer = setTimeout(stopObserver, Math.max(2000, Math.min(12000, timeout || 9000)))
  }

  /** 订阅每次缓存刷新（返回取消函数） */
  function onRefresh(fn: (cache: CredentialFieldCache) => void): () => void {
    refreshListeners.push(fn)
    return () => {
      const i = refreshListeners.indexOf(fn)
      if (i >= 0) refreshListeners.splice(i, 1)
    }
  }

  /** 注入陈旧字段清理器（fill.js 提供） */
  function setStaleFieldCleaner(fn: ((field: HTMLInputElement) => void) | null): void {
    staleFieldCleaner = fn
  }

  function getBestPasswordField(): HTMLInputElement | null {
    const c = refreshCache()
    if (c && c.passwordField) return c.passwordField
    const allFields = [
      ...document.querySelectorAll<HTMLInputElement>('form input'),
      ...document.querySelectorAll<HTMLInputElement>('input')
    ]
    for (const field of allFields) {
      if (isPasswordLikeField(field)) return field
    }
    return null
  }

  function getBestUsernameField(): HTMLInputElement | null {
    const c = refreshCache()
    if (c && c.usernameField) return c.usernameField

    const passwordField = getBestPasswordField()
    if (passwordField && passwordField.form) {
      const formFields = Array.from(passwordField.form.querySelectorAll<HTMLInputElement>('input'))
      const candidates = formFields.filter(isUsernameLikeField)
      if (candidates.length > 0) return candidates[0]
    }

    const allFields = [
      ...document.querySelectorAll<HTMLInputElement>('form input'),
      ...document.querySelectorAll<HTMLInputElement>('input')
    ]
    for (const field of allFields) {
      if (isUsernameLikeField(field)) return field
    }

    return getBestInput(
      USERNAME_FALLBACK_KEYWORDS,
      ['confirm', 'filename', 'search'],
      USERNAME_INPUT_TYPES
    )
  }

  /**
   * 列出全部密码类候选字段（DOM 顺序）。
   * 供 resolve.js 的策略做二次筛选（如“跳过不可见字段”），
   * 不改变 getBestPasswordField 的 Hira 基线行为。
   */
  function getAllPasswordFields(): HTMLInputElement[] {
    return getAllInputs().filter(isPasswordLikeField)
  }

  /** 列出全部用户名类候选字段（DOM 顺序） */
  function getAllUsernameFields(): HTMLInputElement[] {
    return getAllInputs().filter(isUsernameLikeField)
  }

  /** 清空缓存（路由切换时调用） */
  function clearCache(): void {
    cache.time = 0
    cache.passwordField = null
    cache.usernameField = null
    stopObserver()
  }

  return {
    isPasswordLikeField,
    isUsernameLikeField,
    isLikelyOneTimeCodeField,
    getPasswordConfirmationField,
    isConnectedInput,
    refreshCache,
    scheduleRefresh,
    startObserver,
    stopObserver,
    onRefresh,
    setStaleFieldCleaner,
    getBestPasswordField,
    getBestUsernameField,
    getAllPasswordFields,
    getAllUsernameFields,
    clearCache
  }
}

export { createCredentialFieldScanner }
