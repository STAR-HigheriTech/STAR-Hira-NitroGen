// @ts-check
/**
 * @hira-ng/ui-split-toolbar —— **hover 在分屏上浮出的那排小按钮**（对齐 Zen / Edge 的分屏控件）。
 *
 * 按钮（从左到右）：拖动手柄（拖动重排格序）/ 切换方向 / 反转格序 / 关闭这一格。
 *
 * ── 「关闭」关的是**这一格的标签**，不是整片分屏 ────────────────────────
 * 与 Edge / Zen 同款语义：✕ 只关掉指针所在那一格；组里还剩 ≥2 格就继续分屏
 *（自动重排），只剩 1 格时自然退出、那一个标签铺满。**「解散整片分屏」不在工具条上** ——
 * 那是标签右键菜单里的「解散分屏」，两者不是一件事，混成一个按钮就会出现
 * "只想关掉一格、结果整片没了"。
 *
 * ── 它画在哪 ────────────────────────────────────────────────────────
 * 它住在一个**独立 WebContentsView** 里（`split-toolbar`，见 apps 的 renderer/split-toolbar/）。
 * 为什么不画在外壳 DOM：网页是原生 `WebContentsView`，外壳（chrome）天然位于它**之下** ——
 * DOM 里画不出任何压得住网页的东西。所以"浮在网页上的按钮"只能是一层独立浮层
 *（与查找栏 / 悬停 URL / 缩放条 / 拖动落点预览同族）。
 *
 * ── 分工（与其它 ui 包同一条口径）───────────────────────────────────
 *   · 本模块**只画**：给它一条形态 payload，它把按钮排 / 目标格高亮摆成那个样子；
 *   · **指针在哪一格 / 何时显示 / 显示多大**全是主进程的事（见 main/split-toolbar.js）——
 *     因为指针一进网页原生视图，本视图就收不到任何指针事件，Electron 的视图命中又是
 *     **矩形级**的（没有按元素命中），所以"hover 判定"只能由主进程按屏幕光标算。
 *   · 本模块不认识标签、不认识分屏、不认识 IPC —— 用户点了哪个键，只交给 `onCommand` 端口。
 *
 * ── 两种形态，一份 DOM ──────────────────────────────────────────────
 *   hover   —— 视图矩形**就是**那排按钮（主进程贴格右上角算出），本模块把按钮铺满自己；
 *   dragging—— 主进程把视图铺满**整片分屏区域**，本模块改画"要插到第几格"的高亮块。
 * 两态共用同一棵 DOM（按钮排 + 高亮层），只切换类名与高亮块几何，避免重建节点导致
 * 拖动中途掉帧。
 */

import { GripVertical, LayoutGrid, ArrowLeftRight, X, type IconFactory } from '@hira-ng/ui-common'

const STYLE_ID = 'hira-split-toolbar-styles'

type SplitToolbarAction = 'toggle-layout' | 'reverse' | 'close-pane'

interface SplitToolbarButtonDefinition {
  id: string
  icon: IconFactory
  title: string
  kind?: 'grip'
  action?: SplitToolbarAction
  danger?: boolean
}

export interface SplitPaneRect {
  x: number
  y: number
  width: number
  height: number
}

export interface SplitToolbarState {
  memberIndex?: number
  dropIndex?: number
  dragging?: boolean
  layout?: 'row' | 'column'
  panes?: SplitPaneRect[]
}

export type SplitToolbarCommand =
  | { type: 'action'; action: SplitToolbarAction }
  | { type: 'drag-begin'; memberIndex: number }
  | { type: 'drag-end'; toIndex: number }

export interface SplitToolbarOptions {
  onCommand?: (command: SplitToolbarCommand) => void
}

export interface SplitToolbarController {
  readonly element: HTMLElement
  set(state: SplitToolbarState): void
  setShown(shown: boolean): void
  isShown(): boolean
  destroy(): void
}

/**
 * 按钮表 —— **唯一的一份**（图标 / 提示 / 命令）。
 *
 * `action` 字符串必须落在主进程 `main/split-toolbar.js#TOOLBAR_ACTIONS` 白名单里；
 * `kind: 'grip'` 的那一枚不发 action，而是发 drag-begin / drag-end 拖动命令。
 * 改按钮顺序 / 增删按钮只改这里 —— 主进程尺寸（TOOLBAR_SIZE）按**按钮数**乘算，
 * 两端由同一张表驱动。
 */
const BUTTONS: readonly SplitToolbarButtonDefinition[] = Object.freeze<SplitToolbarButtonDefinition[]>([
  { id: 'grip', icon: GripVertical, title: '拖动以重排分屏', kind: 'grip' },
  { id: 'layout', icon: LayoutGrid, title: '切换分屏方向（左右 / 上下）', action: 'toggle-layout' },
  { id: 'reverse', icon: ArrowLeftRight, title: '反转格序', action: 'reverse' },
  // 关掉**指针所在那一格**（等于关闭那格的标签）：还剩 ≥2 格则分屏继续，只剩 1 格才退出。
  { id: 'close', icon: X, title: '关闭这一格', action: 'close-pane', danger: true }
])

/** 按钮数（主进程 TOOLBAR_SIZE 用 30 宽 + 8 间距 + 12 内边距 推出来，两端靠这张表对齐）。 */
export const SPLIT_TOOLBAR_BUTTON_COUNT = BUTTONS.length

export function injectSplitToolbarStyles(doc: Document): void {
  if (doc.getElementById(STYLE_ID)) return
  const style = doc.createElement('style')
  style.id = STYLE_ID
  style.textContent = `
    /* 根铺满自己的视图：hover 态视图矩形**就是**那排按钮（主进程按格右上角算好），
       dragging 态视图矩形是整片分屏区域（要拿它画高亮）。所以这里不许有外边距。 */
    .hira-split-toolbar {
      position: fixed;
      inset: 0;
      box-sizing: border-box;
      /* 唯一字体令牌（shared-types/theme.mjs#UI_FONT_STACK）；兜底串同值。 */
      font-family: var(--hira-font-ui, "Segoe UI Variable Text", "Segoe UI Variable", "Segoe UI", "Microsoft YaHei UI", "Microsoft YaHei", "PingFang SC", "Noto Sans SC", system-ui, -apple-system, sans-serif);
      -webkit-font-smoothing: antialiased;
      /* 起点：整层不吃鼠标，只有真正的按钮排吃（高亮层是纯指示）。 */
      pointer-events: none;
      opacity: 0;
      transition: opacity var(--ng-anim-fast, 120ms) var(--ng-anim-ease, ease);
      contain: strict;
    }
    .hira-split-toolbar.is-shown { opacity: 1; }

    /* 按钮排：默认贴右上（hover 态视图只有它这么大）。 */
    .hira-split-toolbar__row {
      position: absolute;
      top: 0;
      right: 0;
      display: flex;
      align-items: center;
      gap: 8px;
      height: 30px;
      padding: 0 6px;
      box-sizing: border-box;
      pointer-events: auto;
      /* 本排是浮在网页上的**浮层卡片** → 圆角跟主题（--hira-theme-radius）。 */
      border-radius: var(--hira-theme-radius, 9px);
      background: var(--hira-bg-elevated, rgba(255, 255, 255, 0.92));
      border: 1px solid var(--hira-border, rgba(0, 0, 0, 0.12));
      box-shadow: 0 4px 14px rgba(0, 0, 0, 0.16);
      /* 拖动重排期间按钮排退到幕后（高亮块才是主角），但**保留在 DOM 里** ——
         拖动指针被捕获在手柄上，节点被 display:none 会让捕获失效，pointerup 就收不到。 */
      transition: opacity var(--ng-anim-fast, 120ms) var(--ng-anim-ease, ease);
    }
    .hira-split-toolbar.is-dragging .hira-split-toolbar__row { opacity: 0; pointer-events: none; }

    .hira-split-toolbar__btn {
      display: flex;
      align-items: center;
      justify-content: center;
      width: 30px;
      height: 30px;
      padding: 0;
      margin: 0;
      border: 0;
      border-radius: var(--hira-radius-control, 7px);
      background: transparent;
      color: var(--hira-text-primary, #1a1a1a);
      cursor: pointer;
      /* 只动背景/颜色，不做缩放位移 —— 与外壳按钮同一口径（悬停只给透明度/底色）。 */
      transition: background-color var(--ng-anim-fast, 120ms) var(--ng-anim-ease, ease),
                  color var(--ng-anim-fast, 120ms) var(--ng-anim-ease, ease);
    }
    .hira-split-toolbar__btn:hover { background: var(--hira-hover-bg, rgba(0, 0, 0, 0.07)); }
    .hira-split-toolbar__btn:active { background: var(--hira-active-bg, rgba(0, 0, 0, 0.12)); }
    .hira-split-toolbar__btn:focus-visible {
      outline: 2px solid var(--hira-accent, #3b82f6);
      outline-offset: -2px;
    }
    .hira-split-toolbar__btn svg { display: block; }

    /* 拖动手柄：整块可抓，光标明说"能拖"。 */
    .hira-split-toolbar__btn--grip { cursor: grab; color: var(--hira-text-secondary, #6b7280); }
    .hira-split-toolbar__btn--grip:active { cursor: grabbing; }

    /* 危险动作（解散分屏）：悬停转红，与菜单里的危险项一脉相承。 */
    .hira-split-toolbar__btn--danger:hover {
      background: color-mix(in srgb, var(--hira-danger, #e5484d) 14%, transparent);
      color: var(--hira-danger, #e5484d);
    }

    /* 「切换方向」按钮：当前是上下分屏（column）时把方框图转 90°，一眼可辨当前形态。 */
    .hira-split-toolbar__btn--layout svg {
      transition: transform var(--ng-anim-base, 180ms) var(--ng-anim-ease, ease);
    }
    .hira-split-toolbar__btn--layout.is-column svg { transform: rotate(90deg); }

    /* 高亮层：拖动重排期间铺满整片分屏区域，指出"松手会插到第几格"。 */
    .hira-split-toolbar__highlight {
      position: absolute;
      inset: 0;
      pointer-events: none;
      display: none;
    }
    .hira-split-toolbar.is-dragging .hira-split-toolbar__highlight { display: block; }

    .hira-split-toolbar__pane {
      position: absolute;
      box-sizing: border-box;
      /* 高亮层画的是**网页格**的边界 → 与原生网页视图同一个圆角（主题值）。 */
      border-radius: var(--hira-theme-radius, 9px);
      background: rgba(0, 0, 0, 0.001);
      border: 2px solid transparent;
      transition: background-color var(--ng-anim-fast, 120ms) var(--ng-anim-ease, ease),
                  border-color var(--ng-anim-fast, 120ms) var(--ng-anim-ease, ease);
    }
    /* 目标格：强调色描边 + 淡底 —— 与活动格淡蓝框、落点预览同一套强调色真源。 */
    .hira-split-toolbar__pane.is-target {
      --hira-split-toolbar-accent: var(--hira-accent, #3b82f6);
      border-color: var(--hira-split-toolbar-accent);
      background: color-mix(in srgb, var(--hira-split-toolbar-accent) 14%, transparent);
    }

    @media (prefers-reduced-motion: reduce) {
      .hira-split-toolbar, .hira-split-toolbar__row, .hira-split-toolbar__btn,
      .hira-split-toolbar__btn--layout svg, .hira-split-toolbar__pane { transition: none; }
    }
  `
  doc.head.appendChild(style)
}

/** 创建分屏工具条；所有用户意图由 onCommand 端口交给宿主。 */
export function createSplitToolbar(doc: Document, ctx: SplitToolbarOptions = {}): SplitToolbarController {
  const onCommand = typeof ctx.onCommand === 'function' ? ctx.onCommand : () => {}

  const root = doc.createElement('div')
  root.className = 'hira-split-toolbar'

  const row = doc.createElement('div')
  row.className = 'hira-split-toolbar__row'

  const highlight = doc.createElement('div')
  highlight.className = 'hira-split-toolbar__highlight'

  let shown = false
  /** 手柄被按住（本地即时态）。真正的"拖动模式"由主进程推来的 payload.dragging 决定。 */
  let gripHeld = false
  /** 最近一次主进程给的"当前格"（发 drag-begin 时用它，避免依赖坐标换算）。 */
  let memberIndex = 0
  /** 最近一次主进程给的目标格（拖动高亮；松手时上报它）。 */
  let dropIndex = -1
  /** 高亮块缓存（长度跟随 pane 数，避免每次重建节点）。 */
  const paneBlocks: HTMLElement[] = []
  let layoutBtn: HTMLButtonElement | null = null

  /**
   * 手柄 → 拖动重排。三条命令都由本模块发：
   *   pointerdown → drag-begin（把"我要拖第几格"告诉主进程，它接管光标采样）
   *   pointerup   → drag-end  （把"插到第几格"（主进程推来的 dropIndex）交回去）
   *   pointercancel（窗口失焦等）→ drag-end 兜底，强制主进程退出拖动模式（否则它会一直铺满整片）
   *
   * 为什么坐标不上报：指针在拖动期间由**主进程**按屏幕光标判定它落在哪一格
   *（本视图收不到自己盖住那片网页上的指针事件），所以这里只报"格下标"，不报 x/y。
   */
  function makeGrip(btn: HTMLButtonElement) {
    const endDrag = (toIndex: number, pointerId: number) => {
      if (!gripHeld) return
      gripHeld = false
      try { btn.releasePointerCapture(pointerId) } catch (_) {}
      root.classList.remove('is-grip-held')
      onCommand({ type: 'drag-end', toIndex: Number.isFinite(toIndex) ? toIndex : memberIndex })
    }
    btn.addEventListener('pointerdown', (e: PointerEvent) => {
      if (e.button !== 0) return
      e.preventDefault()
      e.stopPropagation()
      try { btn.setPointerCapture(e.pointerId) } catch (_) {}
      gripHeld = true
      root.classList.add('is-grip-held')
      onCommand({ type: 'drag-begin', memberIndex })
    })
    btn.addEventListener('pointerup', (e: PointerEvent) => {
      if (!gripHeld) return
      e.preventDefault()
      e.stopPropagation()
      endDrag(dropIndex, e.pointerId)
    })
    // 取消（窗口失焦 / 系统抢走指针）：按"原地不动"收尾 —— 主进程据此退出拖动模式。
    btn.addEventListener('pointercancel', (e: PointerEvent) => {
      if (!gripHeld) return
      endDrag(memberIndex, e.pointerId)
    })
  }

  for (const item of BUTTONS) {
    const btn = doc.createElement('button')
    btn.type = 'button'
    btn.className = `hira-split-toolbar__btn hira-split-toolbar__btn--${item.id}`
    if (item.danger) btn.classList.add('hira-split-toolbar__btn--danger')
    btn.title = item.title
    btn.setAttribute('aria-label', item.title)
    btn.appendChild(item.icon(doc, { size: 15 }))
    if (item.kind === 'grip') {
      makeGrip(btn)
    } else {
      const action = item.action
      if (!action) continue
      btn.addEventListener('click', (e: MouseEvent) => {
        e.preventDefault()
        e.stopPropagation()
        onCommand({ type: 'action', action })
      })
      if (item.id === 'layout') layoutBtn = btn
    }
    row.appendChild(btn)
  }

  root.appendChild(highlight)
  root.appendChild(row)

  /** 把 pane 矩形摊到高亮块上（拖动重排时指出目标格）。 */
  function renderPanes(panes: SplitPaneRect[], target: number) {
    // 数量变化才增删节点；数量不变只改几何 —— 拖动期间每帧重建会掉帧。
    while (paneBlocks.length < panes.length) {
      const block = doc.createElement('div')
      block.className = 'hira-split-toolbar__pane'
      highlight.appendChild(block)
      paneBlocks.push(block)
    }
    while (paneBlocks.length > panes.length) {
      const block = paneBlocks.pop()
      block?.remove()
    }
    for (let i = 0; i < panes.length; i++) {
      const p: Partial<SplitPaneRect> = panes[i] || {}
      const el = paneBlocks[i]
      el.style.left = `${Math.round(Number(p.x) || 0)}px`
      el.style.top = `${Math.round(Number(p.y) || 0)}px`
      el.style.width = `${Math.round(Number(p.width) || 0)}px`
      el.style.height = `${Math.round(Number(p.height) || 0)}px`
      el.classList.toggle('is-target', i === target)
    }
  }

  function set(state: SplitToolbarState) {
    const s = state || {}
    const nextMember = Number(s.memberIndex)
    if (Number.isFinite(nextMember)) memberIndex = nextMember
    const nextDrop = Number(s.dropIndex)
    dropIndex = Number.isFinite(nextDrop) ? nextDrop : -1

    // 拖动模式以主进程 payload 为权威（它才是握着会话的那一方）。
    root.classList.toggle('is-dragging', s.dragging === true)
    if (layoutBtn) layoutBtn.classList.toggle('is-column', String(s.layout) === 'column')
    renderPanes(Array.isArray(s.panes) ? s.panes : [], dropIndex)
  }

  function setShown(next: boolean) {
    const on = next === true
    if (on === shown) return
    shown = on
    root.classList.toggle('is-shown', on)
    if (!on) {
      // 收起时复位本地拖动痕迹：下一次浮出不该继承上一次的拖动样式。
      gripHeld = false
      root.classList.remove('is-dragging', 'is-grip-held')
    }
  }

  return {
    element: root,
    set,
    setShown,
    isShown: () => shown,
    destroy() {
      root.remove()
    }
  }
}

/** 浮层宿主用的插件式定义（与其它 ui 包同形，见 ui-drop-zone）。 */
export const splitToolbarDefinition = {
  id: 'split-toolbar',
  injectStyles: injectSplitToolbarStyles,
  mount(doc: Document, ctx: SplitToolbarOptions = {}) {
    return createSplitToolbar(doc, ctx)
  }
}
