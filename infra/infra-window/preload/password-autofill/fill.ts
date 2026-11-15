/**
 * fill.js — 自动填充写入器 + 高亮（完全复刻 Hira passwordFill.js）
 *
 * 职责：
 *   - 填充用户名/密码（触发 keydown..change 事件，兼容 JS 框架）
 *   - 对已填充字段加高亮（浅蓝背景/描边，深浅色自适应），用户开始输入即褪去
 *   - 路由切换时清理全部填充痕迹
 *
 * 覆盖保护（对齐 Hira）：已填充字段被"武装"后，用户第一次输入不会追加到
 *   自动填充的明文之后，而是整体替换（delete → 清空，insert/paste → 只留新内容，
 *   composition → 清空）。用完即解除武装。
 *   明文凭据残留另由"路由切换清理"兜底。
 *
 * ── 模块边界（NG 解耦改造点）─────────────────────────
 * 本模块是**写入器 + 覆盖保护**：只负责"把值写进给定字段 / 首次输入如何覆盖"，
 *   · 不扫描 DOM
 *   · 不做字段评分/选择（→ fields.js + resolve.js）
 *   · 不做重试 / setTimeout 复查 / forceRescan（Hira 原版也没有）
 * 目标字段由调用方（编排器 index.js）经 resolve.js 解析后传入。
 * 因此本文件不依赖 scanner，可独立测试与替换。
 */

// 高亮色 = 主题强调色的半透明版（与外壳同一份真源，换主题后自动跟随）。
import { accentAlpha, ensureAccent, isDarkTheme } from '../theme-accent.js'

/**
 * 覆盖保护监听器只允许注册一次：
 * filler 实例可能被多次创建（测试/热重载），window 级监听重复注册会重复拦截输入。
 */
let overwriteGuardInstalled = false

function createAutofillFiller() {
  interface HighlightSnapshot { backgroundColor: string; boxShadow: string; transition: string; borderRadius: string }
  const highlightMap = new WeakMap<HTMLInputElement, HighlightSnapshot>()
  const overwriteMap = new WeakMap<HTMLInputElement, { armed: boolean }>()

  // ── 高亮 ──
  function applyAutofillHighlight(field: HTMLInputElement | null | undefined): void {
    if (!field || field.tagName !== 'INPUT') return

    if (!highlightMap.has(field)) {
      highlightMap.set(field, {
        backgroundColor: field.style.backgroundColor || '',
        boxShadow: field.style.boxShadow || '',
        transition: field.style.transition || '',
        borderRadius: field.style.borderRadius || ''
      })
    }

    // 高亮一律由主题强调色派生（深/浅只影响透明度），不再写死蓝：
    // 主题换成绿色/橙色后，填充框的高亮也一起变。
    try { ensureAccent() } catch (_) {}
    const isDark = isDarkTheme()
    const bg = accentAlpha(isDark ? 0.1 : 0.09)
    const shadow = isDark
      ? `0 0 0 2px ${accentAlpha(0.26)}, inset 0 0 0 9999px ${accentAlpha(0.06)}`
      : `0 0 0 2px ${accentAlpha(0.24)}, inset 0 0 0 9999px ${accentAlpha(0.05)}`
    const computedRadius =
      window.getComputedStyle && window.getComputedStyle(field)
        ? window.getComputedStyle(field).borderRadius
        : ''
    const numericRadius = parseFloat(computedRadius)
    const nextRadius = !Number.isNaN(numericRadius) && numericRadius < 8
      ? '8px'
      : (computedRadius || '8px')

    field.style.transition = '0.12s background-color, 0.12s box-shadow, 0.12s border-radius'
    field.style.backgroundColor = bg
    field.style.boxShadow = shadow
    field.style.borderRadius = nextRadius
    field.dataset.minAutofilled = '1'
    field.addEventListener('input', function () {
      removeAutofillHighlight(field)
    }, { capture: true, once: true })
  }

  function removeAutofillHighlight(field: HTMLInputElement | null | undefined): void {
    if (!field) return
    const prev = highlightMap.get(field)
    if (!prev) return
    field.style.backgroundColor = prev.backgroundColor
    field.style.boxShadow = prev.boxShadow
    field.style.transition = prev.transition
    field.style.borderRadius = prev.borderRadius
    if (field && field.dataset) delete field.dataset.minAutofilled
    highlightMap.delete(field)
  }

  // ── 事件写入（复刻 Hira，另加受控表单兜底）──
  // Hira 原版：field.value = value 然后逐个派发 keydown/keypress/keyup/input/change。
  //
  // 直接用 field.value 赋值在 React/Vue 受控组件上会被框架的 value tracker 认作
  // "没有变化"，随后 onChange 回滚成 state 里的旧值 —— 表现为“用户名填上了、
  // 密码框却是空的”。原生 prototype setter 绕过 tracker，再补一个真正的
  // InputEvent，框架才会把新值写进 state。
  const nativeInputValueSetter = (function (): ((this: HTMLInputElement, value: string) => void) | null {
    try {
      const desc = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')
      return desc && typeof desc.set === 'function' ? desc.set as (this: HTMLInputElement, value: string) => void : null
    } catch (_) {
      return null
    }
  })()

  function writeRawValue(field: HTMLInputElement, value: string): void {
    if (nativeInputValueSetter) {
      try {
        nativeInputValueSetter.call(field, value)
        return
      } catch (_) { /* 原型被改写 / 跨 realm → 退回显式赋值 */ }
    }
    field.value = value
  }

  function dispatchInputEvent(field: HTMLInputElement, value: string): void {
    try {
      field.dispatchEvent(new InputEvent('input', {
        bubbles: true,
        composed: true,
        inputType: 'insertReplacementText',
        data: value
      }))
    } catch (_) {
      field.dispatchEvent(new Event('input', { bubbles: true }))
    }
  }

  function setInputValueWithEvents(field: HTMLInputElement | null | undefined, value: unknown): void {
    if (!field) return
    const next = String(value == null ? '' : value)

    writeRawValue(field, next)
    const keyEvents = ['keydown', 'keypress', 'keyup']
    for (const eventName of keyEvents) {
      field.dispatchEvent(new Event(eventName, { bubbles: true }))
    }
    dispatchInputEvent(field, next)
    field.dispatchEvent(new Event('change', { bubbles: true }))

    // 写后读回：受控表单可能在 input/change 中把值回滚（state 尚未更新）。
    // 只补写一次，不与其反复拉扯 —— 页面若主动做格式化，尊重页面的结果。
    if (field.value !== next) {
      writeRawValue(field, next)
      dispatchInputEvent(field, next)
      field.dispatchEvent(new Event('change', { bubbles: true }))
    }
  }

  // ── 覆盖保护（完全复刻 Hira）─────────────────────────
  // 自动填充的明文会原样留在框里，用户在末尾追加输入就可能把凭据混进提交内容。
  // Hira 的做法：填充后"武装"该字段，用户第一次输入整段替换掉填充值，随即解除武装。
  function armAutofillOverwrite(field: HTMLInputElement | null | undefined): void {
    if (!field || field.tagName !== 'INPUT') return
    overwriteMap.set(field, { armed: true })
  }

  function handleOverwriteBeforeInput(e: InputEvent): void {
    const t = e.target
    if (!(t instanceof HTMLInputElement)) return
    const entry = overwriteMap.get(t)
    if (!entry || !entry.armed) return

    const inputType = String(e.inputType || '')

    if (inputType.startsWith('delete')) {
      e.preventDefault()
      entry.armed = false
      removeAutofillHighlight(t)
      setInputValueWithEvents(t, '')
      return
    }

    if (inputType.startsWith('insert')) {
      const data = typeof e.data === 'string' ? e.data : ''
      if (data) {
        e.preventDefault()
        entry.armed = false
        removeAutofillHighlight(t)
        setInputValueWithEvents(t, data)
      }
    }
  }

  function handleOverwritePaste(e: ClipboardEvent): void {
    const t = e.target
    if (!(t instanceof HTMLInputElement)) return
    const entry = overwriteMap.get(t)
    if (!entry || !entry.armed) return
    e.preventDefault()
    entry.armed = false
    removeAutofillHighlight(t)
    const text =
      (e.clipboardData && e.clipboardData.getData && e.clipboardData.getData('text/plain')) || ''
    setInputValueWithEvents(t, text)
  }

  function handleOverwriteCompositionStart(e: CompositionEvent): void {
    const t = e.target
    if (!(t instanceof HTMLInputElement)) return
    const entry = overwriteMap.get(t)
    if (!entry || !entry.armed) return
    entry.armed = false
    removeAutofillHighlight(t)
    t.value = ''
  }

  if (!overwriteGuardInstalled) {
    overwriteGuardInstalled = true
    window.addEventListener('beforeinput', handleOverwriteBeforeInput, true)
    window.addEventListener('paste', handleOverwritePaste, true)
    window.addEventListener('compositionstart', handleOverwriteCompositionStart, true)
  }

  // ── 填充入口（完全复刻 Hira fillCredentials）─────────
  // Hira 原版：各拿一个目标字段，写值 → 派发事件 → 高亮 → 武装覆盖保护，结束。
  // 没有 forceRescan、没有 preferredField 偏好、没有 setTimeout 复查补填。
  // 字段的选择权交给 resolve.js 的策略链，本函数只负责写。
  //
  // @param {Object} credentials  { username, password }
  // @param {Object} targets      已解析的目标字段 { usernameField, passwordField }
  //
  // ⚠ 读取顺序是有意为之，不要“优化”成一次性解构：
  // 写入用户名会触发站点重渲染（React/Vue 受控表单、分步骤登录页改用户名即切步骤），
  // 密码框节点可能在此刻被重建 —— 若在写用户名**之前**就把 passwordField 取到手，
  // 拿到的是旧节点，密码写进去也不可见（表现为“用户名能填、密码填不进”）。
  // 因此 passwordField 必须在用户名写入之后再读取；
  // 编排器传入的 targets.passwordField 是惰性 getter，会在读取时才重新解析。
  function fillCredentials(
    credentials: { username?: string; password?: string } | null | undefined,
    targets: { usernameField?: HTMLInputElement | null; passwordField?: HTMLInputElement | null } | null | undefined
  ): { usernameField: HTMLInputElement | null; passwordField: HTMLInputElement | null } | null {
    if (!credentials || !targets) return null

    let wroteUsername: HTMLInputElement | null = null
    let wrotePassword: HTMLInputElement | null = null

    const usernameField = targets.usernameField
    if (usernameField) {
      setInputValueWithEvents(usernameField, credentials.username || '')
      applyAutofillHighlight(usernameField)
      armAutofillOverwrite(usernameField)
      wroteUsername = usernameField
    }

    // 在用户名写入之后才解析密码框：此时若表单被重建，拿到的是新节点
    const passwordField = targets.passwordField
    if (passwordField) {
      setInputValueWithEvents(passwordField, credentials.password || '')
      applyAutofillHighlight(passwordField)
      armAutofillOverwrite(passwordField)
      wrotePassword = passwordField
    }

    return { usernameField: wroteUsername, passwordField: wrotePassword }
  }

  // ── 清理单个已填充字段（也作为 fields 的陈旧清理器）──
  function clearAutofilledField(field: HTMLInputElement | null | undefined): void {
    if (!field) return
    overwriteMap.delete(field)
    removeAutofillHighlight(field)
    setInputValueWithEvents(field, '')
  }

  // ── 路由切换全量清理 ──
  function resetFillers(): void {
    const fields = document.querySelectorAll<HTMLInputElement>('input[data-min-autofilled="1"]')
    fields.forEach(function (field) {
      clearAutofilledField(field)
    })
  }

  return {
    fillCredentials,
    setInputValueWithEvents,
    applyAutofillHighlight,
    removeAutofillHighlight,
    armAutofillOverwrite,
    clearAutofilledField,
    resetFillers
  }
}

export { createAutofillFiller }
