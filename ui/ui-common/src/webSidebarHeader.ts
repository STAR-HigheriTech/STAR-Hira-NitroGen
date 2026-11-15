/**
 * webSidebarHeader.ts —— **独立侧栏（Web Sidebar）的顶部控制条**。
 *
 * ── 它是什么 ────────────────────────────────────────────────────────
 * 侧栏那一竖条里**我们自己**的那一小块 chrome：后退 / 前进 / 刷新 / 标题 /
 * 在标签页打开 / 关闭，以及"拖这条标题栏换边"。
 * 侧栏的内容是别人的网页（原生视图，页里画不出我们的控件），所以这条 chrome 必须是
 * **独立的一小块视图**，由布局层摆在侧栏槽顶部（`LayoutCoordinator#_placeWebSidebar`
 * 按端口给的 `headerHeight` 给内容让位）。
 *
 * ── 调宽不在这里 ────────────────────────────────────────────────────
 * 整条侧栏的宽度把手由外壳 DOM 画在"侧栏内容 ↔ 网页"之间那道缝里（竖跨全高），
 * 见 renderer/shared/web-sidebar-surface.js。这里早先那条 6px 的内缘把手已删 ——
 * 同一件事只留一份实现（顶条只有 32px 高，在它上面调宽本来就抓不住）。
 *
 * ── 它不认识什么 ────────────────────────────────────────────────────
 * 不认识 IPC、不认识侧栏控制器、不认识标签世界 —— 点了哪个按钮只交给 `onCommand`，
 * 拖标题栏只交给 `onMovePreview` / `onMoveEnd` 两个出口。于是它可以被任何
 * "顶部一条 chrome"的宿主复用。
 *
 * ── 为什么住在 ui-common ────────────────────────────────────────────
 * 与它同级的共用件（关闭按钮 / 图标区 / 芯片箭头…）都在 ui-common
 *（见 docs/vertical-tabs-architecture.md §5.3）；为一个 6 按钮的条新开一个 workspace 包
 * 只会多一份 package.json 与 link。
 */

import { ChevronLeft, ChevronRight, RefreshCw, X, AppWindow, Smartphone, Monitor } from './icons'
import type { IconFactory } from './icons'

interface WebSidebarButtonDefinition {
  id: string
  icon: IconFactory
  title: string
  command: string
  danger?: boolean
}

interface WebSidebarButtonState extends WebSidebarButtonDefinition {
  el: HTMLButtonElement
}

export interface WebSidebarHeaderState {
  title?: string
  favicon?: string
  loading?: boolean
  canGoBack?: boolean
  canGoForward?: boolean
  viewMode?: 'mobile' | 'desktop' | string
}

export interface WebSidebarHeaderContext {
  onCommand?: (command: string) => void
  onMovePreview?: (viewX: number) => void
  onMoveEnd?: (cancel: boolean) => void
}

export interface WebSidebarHeaderController {
  element: HTMLDivElement
  set: (state: WebSidebarHeaderState) => void
  destroy: () => void
}

const STYLE_ID = 'hira-web-sidebar-header-styles'

/** 顶条高度（px）。**必须与 apps 侧 `web-sidebar.js#WEB_SIDEBAR_HEADER_HEIGHT` 一致**。 */
export const WEB_SIDEBAR_HEADER_HEIGHT = 32

/**
 * 按钮表（唯一一份）：id → 图标 / 提示 / 命令。
 * 顺序即视觉顺序（标题占中间，见 createWebSidebarHeader 的排布）。
 */
const BUTTONS: readonly WebSidebarButtonDefinition[] = Object.freeze([
  { id: 'back', icon: ChevronLeft, title: '后退', command: 'back' },
  { id: 'forward', icon: ChevronRight, title: '前进', command: 'forward' },
  { id: 'reload', icon: RefreshCw, title: '重新加载', command: 'reload' },
  // 视图模式：图标画**当前模式**（手机 / 桌面），提示说明"点了会切到哪个"。
  // 图标在 set() 里按 mode 现换 —— 它是一枚"状态按钮"，不是固定动作按钮。
  { id: 'view-mode', icon: Smartphone, title: '切换到桌面端网页', command: 'toggle-view-mode' },
  { id: 'open-in-tab', icon: AppWindow, title: '在标签页打开', command: 'open-in-tab' },
  { id: 'close', icon: X, title: '关闭侧栏', command: 'close', danger: true }
])

export function injectWebSidebarHeaderStyles(doc: Document): void {
  if (doc.getElementById(STYLE_ID)) return
  const style = doc.createElement('style')
  style.id = STYLE_ID
  style.textContent = `
    .hira-ws-header {
      position: fixed;
      inset: 0;
      /* ── 本栏的**独立前景**（主题 colors.webSidebarFg）────────────────────────
         标题、域名与那一排按钮原本吃的是 UI 前景；在**本栏的根**上把三档文字色
         重算成"侧栏网页标题栏前景"那一组 —— 一处声明、整栏（含按钮）一起跟上。
         三档一起重算的理由与面板那条相同（只改主文字会半截留在旧色上）。
         派生值由主题令牌给（--hira-web-sidebar-fg-soft / -muted）：作者没设这一档时
         它们就是主题原本的 textSoft / textMuted ⇒ 默认逐字不变。 */
      --hira-text-primary: var(--hira-web-sidebar-fg);
      --hira-text-secondary: var(--hira-web-sidebar-fg-soft);
      --hira-text-tertiary: var(--hira-web-sidebar-fg-muted);
      --text-color: var(--hira-web-sidebar-fg);
      color: var(--hira-web-sidebar-fg);
      display: flex;
      align-items: center;
      gap: 2px;
      padding: 0 6px;
      box-sizing: border-box;
      /**
       * 底色 —— 必须**不透明**。
       *
       * 它要盖住网页视图往上多留的那 R 像素（见上面的"上圆下平"）。
       * 所以这里不能用 --main-bg-color（主题带 chrome 透明度时它**就是** transparent，
       * 那一截网页连同它自己的圆角会重新露出来）；用 --hira-bg-surface
       * （= 主题的 palette.bg）—— 与网页所在的内容区同一个底，
       * 也正是这里改用 DOM 画底之前、原生那层铺的颜色。
       */
      background: var(--hira-bg-surface, #f9fafb);
      border-bottom: 1px solid var(--hira-border-subtle, rgba(0, 0, 0, 0.08));
      /**
       * ⚠ **只有上面两个角是圆的**。
       *
       * 本条的**下边紧贴着侧栏里的网页上边** —— 两者是连起来的一整块，下边再带圆角
       * 就会在接缝处咬出一道豁口（四个角都圆时，上面那条的内凹弧与网页上边的内凹弧
       * 正对着，看着像被掐了一下）。
       *
       * 圆角为什么在 CSS 而不走原生 setBorderRadius：那个 API 只能给**四角同一个值**，
       * 表达不了"上圆下平"。所以原生那层被设为 0（见 LayoutCoordinator#_placeWebSidebar），
       * 由这里画。
       *
       * ── 半径从哪来：主题令牌，与网页同一个数 ──────────────────────────
       * 侧栏整块的四个角里，上面两个在这里画、下面两个由网页自己的原生圆角画，
       * 而网页那个数是 theme.style.cornerRadius（见 theme-runtime → setTabTheme），
       * --hira-theme-radius 就是同一个字段（见 shared-types#themeTokens），
       * 所以这里直接读令牌即可 —— **不需要宿主把半径推过来**，也不会有一点时差。
       *
       * 主进程没有钳制：theme.style.cornerRadius 原样下发，0 就是直角
       * （见 theme-runtime#applyNativeSurface）。这里照抄同一个值即可，
       * 千万别再 max(…, 6px) —— 那会把"0 = 直角"重新抬回 6px，上下角对不上。
       *
       * ⚠ 本段注释里**不能出现反引号** —— 整块 CSS 是一个模板字符串，反引号会把它闭合。
       */
      border-radius: var(--hira-theme-radius, 6px) var(--hira-theme-radius, 6px) 0 0;
      color: var(--hira-text-primary, #1a1a1a);
      /* 唯一字体令牌（shared-types/theme.mjs#UI_FONT_STACK）；兜底串同值。 */
      font-family: var(--hira-font-ui, "Segoe UI Variable Text", "Segoe UI Variable", "Segoe UI", "Microsoft YaHei UI", "Microsoft YaHei", "PingFang SC", "Noto Sans SC", system-ui, -apple-system, sans-serif);
      font-size: 12px;
      -webkit-font-smoothing: antialiased;
      /* 这条是 chrome，不是网页：整条不可拖窗口。 */
      -webkit-app-region: no-drag;
      contain: strict;
    }
    .hira-ws-header__favicon {
      width: 14px;
      height: 14px;
      flex: 0 0 auto;
      margin-right: 4px;
      border-radius: 3px;
      object-fit: contain;
    }
    .hira-ws-header__favicon[hidden] { display: none; }
    .hira-ws-header__title {
      flex: 1;
      min-width: 0;
      margin: 0 2px;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
      color: var(--hira-text-secondary, #6b7280);
      user-select: none;
    }
    .hira-ws-header__btn {
      display: flex;
      align-items: center;
      justify-content: center;
      width: 22px;
      height: 22px;
      flex: 0 0 auto;
      padding: 0;
      margin: 0;
      border: 0;
      border-radius: var(--hira-radius-2xs, 4px);
      background: transparent;
      color: var(--hira-text-primary, #1a1a1a);
      cursor: pointer;
      transition: background-color 120ms ease, color 120ms ease;
    }
    .hira-ws-header__btn:hover { background: var(--hira-hover-bg, rgba(0, 0, 0, 0.07)); }
    .hira-ws-header__btn:active { background: var(--hira-active-bg, rgba(0, 0, 0, 0.12)); }
    .hira-ws-header__btn:disabled { opacity: 0.35; cursor: default; background: transparent; }
    .hira-ws-header__btn:focus-visible { outline: 2px solid var(--hira-accent, #3b82f6); outline-offset: -2px; }
    .hira-ws-header__btn svg { display: block; }
    .hira-ws-header__btn--danger:hover {
      background: color-mix(in srgb, var(--hira-danger, #e5484d) 14%, transparent);
      color: var(--hira-danger, #e5484d);
    }
    /* 加载中：刷新按钮转起来（纯 CSS，零 JS 定时器）。 */
    .hira-ws-header__btn--reload.is-loading svg { animation: hira-ws-spin 900ms linear infinite; }
    @keyframes hira-ws-spin { to { transform: rotate(360deg); } }
    /* 调宽把手**不在这里**：整条侧栏的内侧边（竖跨全高）由外壳的
       web-sidebar-surface 画，见该文件头。顶条只负责按钮与"拖标题栏换边"。
       早先这里还有一条 6px、只在悬停时亮蓝的背景条 —— 它与那条整高把手是同一件事的
       两份实现，既让用户无从下手（只有 32px 高），又在悬停时闪一块色块。已删。 */
    @media (prefers-reduced-motion: reduce) {
      .hira-ws-header__btn { transition: none; }
      .hira-ws-header__btn--reload.is-loading svg { animation: none; }
    }
  `
  doc.head.appendChild(style)
}

/**
 * 创建侧栏顶条。
 *
 * @param {Document} doc
 * @param {{
 *   onCommand?: (command: string) => void,
 *   onMovePreview?: (viewX: number) => void, // 拖标题栏换边：指针在**本视图内**的 x
 *   onMoveEnd?: (cancel: boolean) => void    // 松手（cancel=true 表示拖动被中断/取消）
 * }} [ctx]
 * @returns {{ element: HTMLElement, set: (state: object) => void, destroy: () => void }}
 *   `set({ title, favicon, loading, canGoBack, canGoForward, viewMode })`
 */
export function createWebSidebarHeader(
  doc: Document,
  ctx: WebSidebarHeaderContext = {}
): WebSidebarHeaderController {
  const onCommand = typeof ctx.onCommand === 'function' ? ctx.onCommand : () => {}
  // 拖动标题栏换边：只上报"指针在**本视图内**的 x"与"松手/取消"。
  // 落在哪一侧由主进程算（窗口中线与侧栏矩形只有它知道）—— 组件不持有第二份判据。
  const onMovePreview = typeof ctx.onMovePreview === 'function' ? ctx.onMovePreview : () => {}
  const onMoveEnd = typeof ctx.onMoveEnd === 'function' ? ctx.onMoveEnd : () => {}

  const root = doc.createElement('div')
  root.className = 'hira-ws-header'
  // 整条可拖（按钮除外）——用内联 cursor 而不是往样式模板里再加规则：
  // 子元素（按钮）自己的 `cursor: pointer` 会覆盖继承值，两边互不干扰。
  root.style.cursor = 'grab'

  const favicon = doc.createElement('img')
  favicon.className = 'hira-ws-header__favicon'
  favicon.hidden = true
  favicon.alt = ''
  favicon.addEventListener('error', () => { favicon.hidden = true })
  root.appendChild(favicon)

  const buttons: WebSidebarButtonState[] = []
  const mkButton = (item: WebSidebarButtonDefinition): HTMLButtonElement => {
    const btn = doc.createElement('button')
    btn.type = 'button'
    btn.className = `hira-ws-header__btn hira-ws-header__btn--${item.id}`
    if (item.danger) btn.classList.add('hira-ws-header__btn--danger')
    btn.title = item.title
    btn.setAttribute('aria-label', item.title)
    btn.appendChild(item.icon(doc, { size: 14 }))
    btn.addEventListener('click', (e) => {
      e.preventDefault()
      e.stopPropagation()
      if (btn.disabled) return
      // 命令可以**随状态变**（刷新 ⇄ 停止）：读 DOM 上的现值，不要读闭包里那份快照
      //（`buttons` 里存的是展开后的副本，改副本不会影响这里）。
      onCommand(btn.dataset.command || item.command)
    })
    return btn
  }

  // 左半边（导航三兄弟）→ 标题 → 右半边（出口与关闭）
  const left = BUTTONS.slice(0, 3)
  const right = BUTTONS.slice(3)
  for (const item of left) { const b = mkButton(item); root.appendChild(b); buttons.push({ ...item, el: b }) }

  const title = doc.createElement('div')
  title.className = 'hira-ws-header__title'
  root.appendChild(title)

  for (const item of right) { const b = mkButton(item); root.appendChild(b); buttons.push({ ...item, el: b }) }

  const byId = new Map(buttons.map((b) => [b.id, b]))

  // ── 拖动标题栏 → 换边 ────────────────────────────────────────────────
  //
  // 与分屏拖分隔条同一意图：拖动期间给**落位预览**（主进程在外壳上画一条竖带），
  // 松手才真的换边。绑在整条上、按下时排除按钮 —— 按钮有自己的指针语义（点击），
  // 抢走它们的 pointerdown 会让按钮点不动。
  //
  // `clientX` 是**本视图内**坐标（视图宽度 = 侧栏宽度），主进程加上侧栏原点换算成
  // 窗口内容区坐标 —— 渲染层不知道窗口在哪，也不该自己算中线。
  let moveDrag: { pointerId: number } | null = null
  /** 换边预览同样合帧：pointermove 只记 x，一帧报一次（理由见上面的调宽合帧）。 */
  let pendingMoveX: number | null = null
  let moveRaf = 0
  function flushMovePreview() {
    moveRaf = 0
    if (pendingMoveX === null) return
    const x = pendingMoveX
    pendingMoveX = null
    onMovePreview(x)
  }
  root.addEventListener('pointerdown', (e) => {
    if (e.button !== 0) return
    if ((e.target as Element | null)?.closest('button')) return
    e.preventDefault()
    moveDrag = { pointerId: e.pointerId }
    root.style.cursor = 'grabbing'
    try { root.setPointerCapture(e.pointerId) } catch (_) {}
    // 按下就报一次（不等一帧）：预览要立刻出现，否则"按住不动"时看着像没反应。
    onMovePreview(e.clientX)
  })
  root.addEventListener('pointermove', (e) => {
    if (!moveDrag || e.pointerId !== moveDrag.pointerId) return
    pendingMoveX = e.clientX
    if (!moveRaf) moveRaf = requestAnimationFrame(flushMovePreview)
  })
  const endMove = (e: PointerEvent, cancel: boolean): void => {
    if (!moveDrag || (e && e.pointerId !== moveDrag.pointerId)) return
    moveDrag = null
    if (moveRaf) { cancelAnimationFrame(moveRaf); moveRaf = 0 }
    pendingMoveX = null
    root.style.cursor = 'grab'
    try { root.releasePointerCapture(e.pointerId) } catch (_) {}
    onMoveEnd(cancel)
  }
  root.addEventListener('pointerup', (e) => endMove(e, false))
  root.addEventListener('pointercancel', (e) => endMove(e, true))

  return {
    element: root,
    /** 只更新变化的部分（标题 / 图标 / 加载态 / 前进后退可用性 / 视图模式）。 */
    set(state: WebSidebarHeaderState) {
      const s = state || {}
      if (typeof s.title === 'string') title.textContent = s.title
      if (typeof s.favicon === 'string') {
        if (s.favicon && favicon.getAttribute('src') !== s.favicon) favicon.src = s.favicon
        favicon.hidden = !s.favicon
      }
      if (typeof s.loading === 'boolean') {
        const reload = byId.get('reload')
        if (reload) {
          reload.el.classList.toggle('is-loading', s.loading)
          reload.el.title = s.loading ? '停止加载' : '重新加载'
          reload.el.dataset.command = s.loading ? 'stop' : 'reload'
        }
      }
      const back = byId.get('back')
      if (back && typeof s.canGoBack === 'boolean') back.el.disabled = !s.canGoBack
      const forward = byId.get('forward')
      if (forward && typeof s.canGoForward === 'boolean') forward.el.disabled = !s.canGoForward
      // 视图模式是**状态按钮**：图标画当前模式，提示说明"点了切到哪个"。
      if (typeof s.viewMode === 'string') {
        const vm = byId.get('view-mode')
        if (vm) {
          const mobile = s.viewMode !== 'desktop'
          const label = mobile ? '切换到桌面端网页' : '切换到手机端网页'
          vm.el.replaceChildren((mobile ? Smartphone : Monitor)(doc, { size: 14 }))
          vm.el.title = label
          vm.el.setAttribute('aria-label', label)
          vm.el.dataset.viewMode = s.viewMode
        }
      }
    },
    destroy() {
      root.remove()
    }
  }
}
