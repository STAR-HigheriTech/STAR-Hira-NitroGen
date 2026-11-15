// @ts-check
/**
 * @hira-ng/ui-zoom-indicator —— 页面缩放条（网页顶部居中的三段式胶囊）
 *
 * 形态学 Edge / Chrome 的缩放气泡，但落位在本项目的「网页矩形顶部居中」
 * （见 LayoutCoordinator#anchorFloatInContent）：
 *
 *     [ − ]   100%   [ + ]
 *              ↑ 点数字 = 回到 100%（Chrome/Edge 同款）
 *
 * ── 与其它两个 chrome 浮层一致的约束 ────────────────────────────────
 *   · 它住在一个**独立 WebContentsView** 里（网页是原生视图），所以自带键盘处理；
 *   · 只有 `−` / `%` / `+` 三个可点目标需要指针，**不抢键盘焦点**（见 LayerStack
 *     的 FOCUS_PRIORITY）—— 缩放是"看一眼、点一下就完"的操作；
 *   · 自动收起由本模块计时（`autoHideMs`），到点回调 `ctx.onAutoHide()` 让**宿主**
 *     去收 bounds：模块不认识浮层，宿主才认识。
 *
 * 主题：与查找栏、悬停 URL 同一套令牌（`--hira-bg-elevated` / `--hira-text-primary`
 * / `--hira-hover-bg` / `--hira-border-subtle`），深色由 tokens-dark.css 翻转，
 * 本模块只额外分叉一处投影。
 */

import { Plus, Minus } from '@hira-ng/ui-common'

interface ZoomIndicatorOptions {
  onStep?: (delta: number) => void
  onReset?: () => void
  onAutoHide?: () => void
  autoHideMs?: number
  minPercent?: number
  maxPercent?: number
}
interface ZoomIndicatorController {
  element: HTMLElement
  setPercent(percent: number): void
  setShown(shown: boolean): void
  isShown(): boolean
  measure(): { width: number; height: number }
  destroy(): void
}

const STYLE_ID = 'hira-zoom-indicator-styles'

/** 胶囊四周留给投影的留白（宿主按「胶囊尺寸 + 2×本值」上报 view 尺寸）。 */
export const ZOOM_SHADOW_PAD = 16

/** 自动收起延迟（毫秒）。连续点击会不断顺延，松手后 ~1.6s 收掉。 */
export const ZOOM_AUTO_HIDE_MS = 2200

export function injectZoomStyles(doc: Document): void {
  if (doc.getElementById(STYLE_ID)) return
  const style = doc.createElement('style')
  style.id = STYLE_ID
  style.textContent = `
    .hira-zoom {
      position: fixed;
      box-sizing: border-box;
      display: inline-flex; align-items: center; gap: 3px;
      padding: 4px;
      border-radius: var(--hira-theme-radius, 12px);
      background: var(--hira-bg-elevated, #f7f9fc);
      border: 1px solid var(--hira-border-subtle, rgba(0, 0, 0, 0.1));
      box-shadow: var(--hira-zoom-shadow, 0 8px 24px rgba(0, 0, 0, 0.2));
      color: var(--hira-text-primary, #1a1a1a);
      /* 唯一字体令牌（shared-types/theme.mjs#UI_FONT_STACK）；兜底串同值。 */
      font-family: var(--hira-font-ui, "Segoe UI Variable Text", "Segoe UI Variable", "Segoe UI", "Microsoft YaHei UI", "Microsoft YaHei", "PingFang SC", "Noto Sans SC", system-ui, -apple-system, sans-serif);
      font-size: 13px;
      -webkit-font-smoothing: antialiased;
      opacity: 0;
      transform: translateY(-4px) scale(0.98);
      transform-origin: top center;
      /* 显隐只动 opacity/transform —— 合成器上跑，网页在下面照常绘制 */
      transition: opacity 130ms ease-out, transform 130ms cubic-bezier(0.2, 0.8, 0.3, 1);
      pointer-events: none;
    }
    .hira-zoom.is-shown {
      opacity: 1;
      transform: translateY(0) scale(1);
      pointer-events: auto;
    }
    @media (prefers-reduced-motion: reduce) {
      .hira-zoom { transition: none; }
    }
    .hira-zoom__btn {
      display: flex; align-items: center; justify-content: center;
      width: 36px; height: 36px; flex-shrink: 0;
      border: 0; padding: 0;
      border-radius: var(--hira-radius-control, var(--hira-theme-radius, 8px));
      background: transparent;
      color: var(--hira-text-secondary, #6b7280);
      cursor: pointer;
      transition: background var(--ng-anim-fast, 120ms) var(--ng-anim-ease, ease),
                  color var(--ng-anim-fast, 120ms) var(--ng-anim-ease, ease);
    }
    .hira-zoom__btn:hover { background: var(--hira-hover-bg, rgba(0, 0, 0, 0.05)); color: var(--hira-text-primary, #1a1a1a); }
    .hira-zoom__btn:focus-visible, .hira-zoom__value:focus-visible {
      outline: 2px solid var(--hira-accent, #3b82f6);
      outline-offset: 1px;
    }
    .hira-zoom__btn:disabled { opacity: 0.3; cursor: default; }
    .hira-zoom__btn:disabled:hover { background: transparent; color: var(--hira-text-secondary, #6b7280); }
    /* 中间那枚百分比同时是「回到 100%」按钮：比两侧窄一点、字号大一点，
       数字用等宽字形 —— 100% → 125% → 150% 切换时宽度不跳。 */
    .hira-zoom__value {
      min-width: 76px; height: 36px;
      padding: 0 10px;
      border: 0; border-radius: var(--hira-radius-control, var(--hira-theme-radius, 8px));
      background: transparent;
      color: inherit;
      font: inherit;
      font-weight: 600;
      font-size: 14px;
      font-variant-numeric: tabular-nums;
      cursor: pointer;
      transition: background var(--ng-anim-fast, 120ms) var(--ng-anim-ease, ease);
    }
    .hira-zoom__value:hover { background: var(--hira-hover-bg, rgba(0, 0, 0, 0.05)); }
    /* 非 100% 时数字用强调色 —— 一眼看出"这一页不是原始比例"（Edge 同款提示）。
       唯一真源是主题下发的 --hira-accent（见 shared-types/theme.mjs#themeToTokens）；
       --accent-color 只是同一取值的旧别名，留作回退。 */
    .hira-zoom.is-zoomed .hira-zoom__value { color: var(--hira-accent, var(--accent-color, #3b82f6)); }
  `
  doc.head.appendChild(style)
  const shadow = doc.createElement('style')
  shadow.textContent = `
    :root { --hira-zoom-shadow: 0 8px 24px rgba(0, 0, 0, 0.2); }
    body.dark, body.dark-mode, html[data-theme='dark'] {
      --hira-zoom-shadow: 0 10px 30px rgba(0, 0, 0, 0.58);
    }
  `
  doc.head.appendChild(shadow)
}

/**
 * 创建缩放条。
 * @param {Document} doc
 * @param {{
 *   onStep?: (delta: number) => void,
 *   onReset?: () => void,
 *   onAutoHide?: () => void,
 *   autoHideMs?: number,
 *   minPercent?: number,
 *   maxPercent?: number
 * }} [ctx]
 * @returns {{ element: HTMLElement, setPercent: (percent: number) => void, setShown: (shown: boolean) => void, isShown: () => boolean, measure: () => {width: number, height: number}, destroy: () => void }}
 */
export function createZoomIndicator(doc: Document, ctx: ZoomIndicatorOptions = {}): ZoomIndicatorController {
  const autoHideMs = Number.isFinite(Number(ctx.autoHideMs)) ? Math.max(0, Number(ctx.autoHideMs)) : ZOOM_AUTO_HIDE_MS
  const minPercent = Number.isFinite(Number(ctx.minPercent)) ? Number(ctx.minPercent) : 25
  const maxPercent = Number.isFinite(Number(ctx.maxPercent)) ? Number(ctx.maxPercent) : 500

  const root = doc.createElement('div')
  root.className = 'hira-zoom'

  const btnOut = doc.createElement('button')
  btnOut.type = 'button'
  btnOut.className = 'hira-zoom__btn hira-zoom__btn--out'
  btnOut.title = '缩小 (Ctrl+-)'
  btnOut.setAttribute('aria-label', '缩小页面')
  btnOut.tabIndex = -1
  btnOut.appendChild(Minus(doc, { size: 18 }))

  const value = doc.createElement('button')
  value.type = 'button'
  value.className = 'hira-zoom__value'
  value.title = '重置为 100% (Ctrl+0)'
  value.setAttribute('aria-label', '重置为 100%')
  value.tabIndex = -1
  value.textContent = '100%'

  const btnIn = doc.createElement('button')
  btnIn.type = 'button'
  btnIn.className = 'hira-zoom__btn hira-zoom__btn--in'
  btnIn.title = '放大 (Ctrl+=)'
  btnIn.setAttribute('aria-label', '放大页面')
  btnIn.tabIndex = -1
  btnIn.appendChild(Plus(doc, { size: 18 }))

  root.appendChild(btnOut)
  root.appendChild(value)
  root.appendChild(btnIn)

  let percent = 100
  let shown = false
  let hideTimer: ReturnType<typeof setTimeout> | null = null

  function refresh(): void {
    value.textContent = `${percent}%`
    root.classList.toggle('is-zoomed', percent !== 100)
    btnOut.disabled = percent <= minPercent
    btnIn.disabled = percent >= maxPercent
  }

  function scheduleAutoHide(): void {
    if (hideTimer) clearTimeout(hideTimer)
    if (!autoHideMs) return
    hideTimer = setTimeout(() => {
      hideTimer = null
      if (typeof ctx.onAutoHide === 'function') ctx.onAutoHide()
      else setShown(false)
    }, autoHideMs)
  }

  function setShown(next: boolean): void {
    const on = Boolean(next)
    if (on === shown) {
      if (on) scheduleAutoHide()
      return
    }
    shown = on
    root.classList.toggle('is-shown', on)
    if (on) scheduleAutoHide()
    else if (hideTimer) { clearTimeout(hideTimer); hideTimer = null }
  }

  // 点按钮会先把原生焦点交给本视图（鼠标事件天然如此），所以按钮一律 tabIndex=-1、
  // 且 mousedown 阻止默认行为 —— 免得"点一下缩放条就把网页焦点抢走"。
  const swallow = (e: MouseEvent): void => e.preventDefault()
  btnOut.addEventListener('mousedown', swallow)
  btnIn.addEventListener('mousedown', swallow)
  value.addEventListener('mousedown', swallow)

  btnOut.addEventListener('click', () => {
    scheduleAutoHide()
    if (typeof ctx.onStep === 'function') ctx.onStep(-1)
  })
  btnIn.addEventListener('click', () => {
    scheduleAutoHide()
    if (typeof ctx.onStep === 'function') ctx.onStep(1)
  })
  value.addEventListener('click', () => {
    scheduleAutoHide()
    if (typeof ctx.onReset === 'function') ctx.onReset()
  })

  refresh()

  return {
    element: root,

    /** 显示当前缩放百分比（%）并顺延自动收起计时。 */
    setPercent(next: number): void {
      const n = Math.round(Number(next))
      if (Number.isFinite(n)) {
        percent = n
        refresh()
      }
    },

    setShown,
    isShown(): boolean {
      return shown
    },

    measure(): { width: number; height: number } {
      const r = root.getBoundingClientRect()
      return { width: Math.ceil(r.width), height: Math.ceil(r.height) }
    },

    destroy(): void {
      if (hideTimer) clearTimeout(hideTimer)
      root.remove()
    }
  }
}

/** 浮层宿主用的插件式定义（与其它 ui 包同形）。 */
export const zoomIndicatorDefinition = {
  id: 'zoom-indicator',
  injectStyles: injectZoomStyles,
  mount(doc: Document, ctx: ZoomIndicatorOptions) {
    return createZoomIndicator(doc, ctx)
  }
}
