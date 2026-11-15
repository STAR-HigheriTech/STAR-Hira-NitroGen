/**
 * JS Dialog 浮层渲染脚本（preload）
 *
 * 完全复刻 Hira pages/jsDialog/jsDialogRenderer.js 的实现：
 *   - 接收主进程的 jsDialog:init 数据，渲染弹窗 UI
 *   - 4 种类型 SVG 图标切换
 *   - Tab 焦点循环
 *   - Esc/Enter/Space 键盘交互
 *   - 主题色变量应用（--fw-accent / --fw-border / --fw-focus-border）
 *   - 用户响应通过 JS_DIALOG_CHANNELS.response 回传主进程
 *
 * 为什么住在 preload 目录：它是**浮层窗口的 preload**，构建期由 electron-vite
 * 打进 `out/preload/dialog-renderer.js`（沙箱关闭 + 上下文隔离关闭，直接操作 DOM）。
 * 早点它住在 main/js-dialog/ 下被原样拷贝，既没法用 ESM import 共享通道表，
 * 又让「通道名散落四处」。现在通道名统一取 JS_DIALOG_CHANNELS。
 */

const { ipcRenderer } = require('electron')
import { JS_DIALOG_CHANNELS } from '@hira-ng/shared-types/src/js-dialog-channels'

/**
 * 应用主题色变量
 */
type DialogType = 'alert' | 'confirm' | 'prompt' | 'beforeunload'
interface DialogThemeInfo {
  accentColor?: unknown
  onAccentColor?: unknown
  borderColor?: unknown
  inputFocusBorder?: unknown
  isDark?: unknown
}
interface DialogData {
  type?: DialogType
  title?: unknown
  okText?: unknown
  cancelText?: unknown
  hideSuppress?: unknown
  suppressText?: unknown
  sourceDomain?: unknown
  message?: unknown
  defaultValue?: unknown
  defaultFocus?: unknown
}

function applyAccentTheme (raw: unknown): void {
  if (!raw || typeof raw !== 'object') return
  const info = raw as DialogThemeInfo
  const root = document.documentElement
  if (info.accentColor) root.style.setProperty('--fw-accent', String(info.accentColor))
  // accent 实底上的前景：浅色强调（黄/青等）需要深色字，不能写死白。
  if (info.onAccentColor) root.style.setProperty('--jd-on-accent', String(info.onAccentColor))
  if (info.borderColor) root.style.setProperty('--fw-border', String(info.borderColor))
  if (info.inputFocusBorder) root.style.setProperty('--fw-focus-border', String(info.inputFocusBorder))
  // 跟随应用主题（isDark），而非仅系统媒体查询
  document.body.classList.toggle('dark', info.isDark === true)
  document.body.classList.toggle('dark-mode', info.isDark === true)
}

// 图标 SVG（按对话框类型切换）
const ICONS = {
  alert: '<svg viewBox="0 0 24 24" width="18" height="18"><path d="M12 2L1 21h22L12 2zm0 3.5L19.5 19h-15L12 5.5zM11 10v5h2v-5h-2zm0 6v2h2v-2h-2z" fill="currentColor"/></svg>',
  confirm: '<svg viewBox="0 0 24 24" width="18" height="18"><path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm-1 14.5l-3.5-3.5 1.41-1.41L11 13.67l4.59-4.59L17 10.5l-6 6z" fill="currentColor"/></svg>',
  prompt: '<svg viewBox="0 0 24 24" width="18" height="18"><path d="M20 4H4c-1.1 0-2 .9-2 2v12c0 1.1.9 2 2 2h16c1.1 0 2-.9 2-2V6c0-1.1-.9-2-2-2zm0 14H4V8h16v10zM6 10h8v2H6v-2zm0 4h5v2H6v-2zm9-4h3v2h-3v-2z" fill="currentColor"/></svg>',
  beforeunload: '<svg viewBox="0 0 24 24" width="18" height="18"><path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm1 15h-2v-2h2v2zm0-4h-2V7h2v6z" fill="currentColor"/></svg>'
}

window.addEventListener('load', function () {
  const container = document.querySelector<HTMLDivElement>('.jd-container')!
  const iconEl = document.getElementById('jd-icon') as HTMLDivElement
  const sourceDomainEl = document.getElementById('jd-source-domain') as HTMLDivElement
  const titleTextEl = document.getElementById('jd-title-text') as HTMLDivElement
  const messageEl = document.getElementById('jd-message') as HTMLDivElement
  const inputEl = document.getElementById('jd-input') as HTMLTextAreaElement
  const okBtn = document.getElementById('jd-ok') as HTMLButtonElement
  const cancelBtn = document.getElementById('jd-cancel') as HTMLButtonElement
  const suppressCheckbox = document.getElementById('jd-suppress') as HTMLInputElement
  const suppressWrap = document.getElementById('jd-suppress-wrap') as HTMLDivElement

  if (!container || !iconEl || !sourceDomainEl || !titleTextEl || !messageEl || !inputEl || !okBtn || !cancelBtn || !suppressCheckbox || !suppressWrap) {
    return
  }

  // 类型 → 标题文案 / 按钮文案 / 默认行为
  const TYPE_META: Record<DialogType, { title: string; okText: string; cancelText: string; defaultAction: string; suppressText: string }> = {
    alert: { title: '提示信息', okText: '确定', cancelText: '', defaultAction: 'ok', suppressText: '阻止此页面创建更多弹窗' },
    confirm: { title: '确认操作', okText: '确定', cancelText: '取消', defaultAction: 'cancel', suppressText: '阻止此页面创建更多弹窗' },
    prompt: { title: '请输入内容', okText: '确定', cancelText: '取消', defaultAction: 'cancel', suppressText: '阻止此页面创建更多弹窗' },
    beforeunload: { title: '确认离开此页面？', okText: '离开', cancelText: '留在此页', defaultAction: 'stay', suppressText: '阻止此页面再次询问' }
  }

  let currentType: DialogType | null = null
  let defaultValue = ''

  // ── 智能高度：量内容、报高度（窗口尺寸由主进程按几何约束落地）─────────────
  // 渲染层才知道「内容有多高」：容器在 CSS 里是 100vh（窗口多高它就多高），
  // 量高度时临时切成 auto，让子元素按自然高度铺开，量完恢复，不影响最终布局。
  // 主进程（js-dialog/dialog-overlay.js#resizeToContent）负责夹取上下限、
  // 贴边避让与显示时机；内容超过上限时由 .jd-message 内部滚动。
  // ⚠ 必须**同步**测量并上报：窗口首次显示前是 hidden 状态，rAF / 定时器会被
  // Chromium 节流（甚至不触发），异步上报会让「先量后显」退化成兜底定时器才显示。
  let _lastReportedHeight = 0

  function measureContentHeight (): number {
    try {
      const prevHeight = container.style.height
      container.style.height = 'auto'
      const height = Math.ceil(container.getBoundingClientRect().height)
      container.style.height = prevHeight
      return height
    } catch (_) {
      return 0
    }
  }

  function reportContentHeight (): void {
    if (currentType === null) return
    const height = measureContentHeight()
    if (height <= 0 || height === _lastReportedHeight) return
    _lastReportedHeight = height
    try { ipcRenderer.send(JS_DIALOG_CHANNELS.resize, { height: height }) } catch (_) {}
  }

  // 尝试获取主题色信息
  try {
    const info = ipcRenderer.sendSync(JS_DIALOG_CHANNELS.getThemeInfo)
    applyAccentTheme(info)
  } catch (_e) {}

  function send (action: string, payload?: Record<string, unknown>): void {
    ipcRenderer.send(JS_DIALOG_CHANNELS.response, Object.assign({ action: action }, payload || {}))
  }

  function respond (action: string): void {
    const payload: Record<string, unknown> = { action: action }
    if (currentType === 'prompt' && action === 'ok') {
      payload.value = inputEl.value
    }
    if (suppressCheckbox) {
      payload.suppress = !!suppressCheckbox.checked
    }
    send(action, payload)
  }

  // textarea 自适应高度
  function autoResizeInput (): void {
    if (currentType !== 'prompt') return
    try {
      inputEl.style.height = 'auto'
      const newH = Math.min(inputEl.scrollHeight, 80)
      inputEl.style.height = newH + 'px'
      reportContentHeight()
    } catch (_) {}
  }

  function getTabOrder (): HTMLElement[] {
    const suppressVisible = !!suppressWrap && suppressWrap.style.display !== 'none'
    if (currentType === 'prompt') {
      return suppressVisible
        ? [inputEl, okBtn, cancelBtn, suppressCheckbox]
        : [inputEl, okBtn, cancelBtn]
    }
    return suppressVisible
      ? [okBtn, cancelBtn, suppressCheckbox]
      : [okBtn, cancelBtn]
  }

  function focusNext (forward: boolean): void {
    const order = getTabOrder()
    if (!order.length) return
    const activeEl = document.activeElement instanceof HTMLElement ? document.activeElement : null
    const idx = activeEl ? order.indexOf(activeEl) : -1
    let nextIdx: number
    if (idx === -1) {
      nextIdx = forward ? 0 : order.length - 1
    } else {
      nextIdx = forward ? (idx + 1) % order.length : (idx - 1 + order.length) % order.length
    }
    try { order[nextIdx].focus() } catch (_) {}
  }

  ipcRenderer.on(JS_DIALOG_CHANNELS.init, function (_e: Electron.IpcRendererEvent, raw: unknown) {
    if (!raw || typeof raw !== 'object') return
    const data = raw as DialogData
    currentType = data.type && data.type in TYPE_META ? data.type : 'alert'
    const base = TYPE_META[currentType] || TYPE_META.alert
    // 应用级确认框（主进程发起）可自带标题 / 按钮文案；网页侧弹窗不带这些字段，
    // 继续用类型默认文案（与改造前逐字一致）。
    const meta = {
      title: data.title ? String(data.title) : base.title,
      okText: data.okText ? String(data.okText) : base.okText,
      cancelText: (data.cancelText === undefined || data.cancelText === null)
        ? base.cancelText
        : String(data.cancelText),
      defaultAction: base.defaultAction,
      suppressText: base.suppressText
    }

    // 重置复选框
    if (suppressCheckbox) suppressCheckbox.checked = false
    // 「阻止此页面创建更多弹窗」只对**网页**发起的弹窗有意义：应用级确认框没有"页面"
    // 可言，勾了也无处落地 → 整块隐藏（同时退出 Tab 焦点链，见 getTabOrder）。
    if (suppressWrap) {
      const hideSuppress = data.hideSuppress === true
      suppressWrap.style.display = hideSuppress ? 'none' : ''
      if (suppressCheckbox) suppressCheckbox.style.display = hideSuppress ? 'none' : ''
      const labelEl = suppressWrap.querySelector('.jd-suppress-label')
      if (labelEl && meta.suppressText) labelEl.textContent = meta.suppressText
    }

    // 类型 class
    container.classList.remove('jd-type-alert', 'jd-type-confirm', 'jd-type-prompt', 'jd-type-beforeunload')
    container.classList.add('jd-type-' + currentType)

    // 图标
    iconEl.innerHTML = ICONS[currentType] || ICONS.alert

    // 来源域名
    if (data.sourceDomain) {
      sourceDomainEl.textContent = String(data.sourceDomain)
      titleTextEl.style.marginTop = ''
    } else {
      sourceDomainEl.textContent = ''
      titleTextEl.style.marginTop = '0'
    }

    // 标题
    titleTextEl.textContent = meta.title

    // 消息内容
    if (data.message != null) {
      messageEl.textContent = String(data.message)
      messageEl.style.display = data.message ? '' : 'none'
    } else {
      messageEl.style.display = 'none'
    }

    // prompt 输入框
    if (currentType === 'prompt') {
      inputEl.style.display = 'block'
      defaultValue = String(data.defaultValue || '')
      inputEl.value = defaultValue
      try {
        inputEl.style.height = '32px'
        autoResizeInput()
      } catch (_) {}
      setTimeout(function () {
        try {
          inputEl.focus()
          inputEl.select()
        } catch (_) {}
      }, 50)
    } else {
      inputEl.style.display = 'none'
    }

    // 按钮
    okBtn.textContent = meta.okText
    if (meta.cancelText) {
      cancelBtn.style.display = ''
      cancelBtn.textContent = meta.cancelText
    } else {
      cancelBtn.style.display = 'none'
    }

    // 默认焦点
    // `defaultFocus: 'cancel'` = 应用级确认框的**安全默认**（回车不误触批量关闭）。
    // 网页弹窗不带该字段 → 仍是「确定」获焦，与改造前逐字一致。
    const safeDefault = data.defaultFocus === 'cancel'
    setTimeout(function () {
      try {
        if (currentType === 'prompt') {
          inputEl.focus()
          inputEl.select()
        } else if (safeDefault) {
          ;(meta.cancelText ? cancelBtn : okBtn).focus()
        } else {
          okBtn.focus()
        }
      } catch (_) {}
    }, 50)

    // 内容已渲染 → 上报自然高度（窗口按内容自适应；主进程「先量后显」）
    reportContentHeight()
    // 字体就绪后行高可能微调：再量一次（同高不会重复上报）
    try {
      if (document.fonts && document.fonts.ready) {
        document.fonts.ready.then(reportContentHeight).catch(function () {})
      }
    } catch (_) {}
  })

  okBtn.addEventListener('click', function () { respond('ok') })
  cancelBtn.addEventListener('click', function () { respond('cancel') })

  if (suppressWrap) {
    suppressWrap.addEventListener('click', function (e) {
      e.stopPropagation()
    })
  }

  inputEl.addEventListener('input', autoResizeInput)

  // 键盘交互
  document.addEventListener('keydown', function (e) {
    if (e.key === 'Escape') {
      e.preventDefault()
      const meta = (currentType && TYPE_META[currentType]) || TYPE_META.alert
      respond(meta.defaultAction)
    } else if (e.key === 'Enter') {
      if (currentType === 'prompt') {
        if (!e.shiftKey) {
          e.preventDefault()
          respond('ok')
        }
      } else {
        e.preventDefault()
        // 回车 = 激活**当前焦点所在**的按钮：焦点在「取消」上时（应用级确认框的安全默认）
        // 回车必须取消，否则"焦点故意放在取消上"就被键盘绕过去了。
        respond(document.activeElement === cancelBtn ? 'cancel' : 'ok')
      }
    } else if (e.key === 'Tab') {
      e.preventDefault()
      focusNext(!e.shiftKey)
    }
  })

  // 主题实时切换
  ipcRenderer.on(JS_DIALOG_CHANNELS.themeChanged, function (_e: Electron.IpcRendererEvent, info: unknown) { applyAccentTheme(info) })
})
