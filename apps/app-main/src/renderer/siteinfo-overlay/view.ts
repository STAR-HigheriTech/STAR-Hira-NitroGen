/**
 * SiteInfo Overlay View —— 卡片外壳（只负责「长什么样 / 量多大 / 什么时候该收起」）。
 *
 * ── 职责边界（解耦）──────────────────────────────────────────────────────
 *   · 本文件**不认识任何一块业务内容**：section 由 `sections/registry.js` 注入，
 *     数据由 `model.js` 推给 `render(state)`。新增信息块不需要动这里。
 *   · 本文件**不直接 invoke 任何 IPC**：落位上报考 `onLayout`，收起动作报 `onDismiss`，
 *     由 `main.js` 统一转成 IPC。视图层只描述事实，动作归编排层。
 *
 * ── 落位（与 searchbar-overlay 同形，主进程统一夹取）────────────────────
 *   · `anchor` —— 地址栏站点按钮在窗口 content 坐标系里的矩形；
 *   · `width` / `height` —— 卡片实测尺寸 + 四边阴影留白的 outer 尺寸；
 *   · `position: 'anchor-below'` + `pad`（四边对象）/ `gap` / `margin`。
 *   主进程 `LayoutCoordinator#anchorFloatBelow` 负责算坐标与边界夹取 ——
 *   本层绝不自己算 x/y（两处各算一份必然漂移）。
 *
 * ── 收起路径 ─────────────────────────────────────────────────────────────
 *   · 本视图内 Esc → onDismiss；
 *   · 点击卡片外的阴影留白区（视图形状允许收到的那一圈）→ onDismiss；
 *   · 卡外点击（落在网页 / 地址栏上）本视图收不到 —— 由 app-shell 在按钮再次点击、
 *     切标签、导航、窗口事件时主动收起；主进程 `SELF_FOCUS_FLOATS` 也会在失焦时兜底。
 */

import { SITEINFO_METRICS, injectSiteInfoStyles } from './styles.js'

const {
  padX: PAD_X,
  padTop: PAD_TOP,
  padBottom: PAD_BOTTOM,
  gap: GAP,
  edgeMargin: EDGE_MARGIN,
  width: CARD_WIDTH,
  minWidth: MIN_CARD_WIDTH,
  maxHeight: CARD_MAX_HEIGHT,
  minHeight: MIN_CARD_HEIGHT
} = SITEINFO_METRICS

const EMPTY_ANCHOR = Object.freeze({ left: 0, top: 0, width: 0, height: 0 })

interface SiteInfoAnchor { left: number; top: number; width: number; height: number }

interface SiteInfoViewOptions {
  doc: Document
  root: HTMLElement
  onLayout(payload: Record<string, unknown>): void
  onDismiss(): void
}

interface SiteInfoShowContext {
  anchor?: unknown
  viewport?: { width?: unknown; height?: unknown } | null
  focus?: boolean
}

/** 把任意锚点归一到四个数字（主进程按数字夹取，NaN 会让整块浮层消失）。 */
function normalizeAnchor(raw: unknown): SiteInfoAnchor {
  const a = raw !== null && typeof raw === 'object' ? raw as Record<string, unknown> : {}
  const num = (value: unknown): number => (Number.isFinite(Number(value)) ? Number(value) : 0)
  return {
    left: num(a.left),
    top: num(a.top),
    width: num(a.width),
    height: num(a.height)
  }
}

/**
 * @param {{
 *   doc: Document,
 *   root: HTMLElement,
 *   onLayout: (payload: object) => void,
 *   onDismiss: () => void
 * }} options
 */
export function createSiteInfoView({ doc, root, onLayout, onDismiss }: SiteInfoViewOptions) {
  injectSiteInfoStyles(doc)

  // ── DOM：卡片壳（notice 在滚动区外，始终可见）──────────────────────────
  // 外观词汇（圆角 / 边框 / 底色 / 阴影）来自共享类 `.hira-overlay-card` ——
  // 与空间切换菜单同一份，本浮层不再自写第二套卡片外观。
  const card = doc.createElement('div')
  card.className = 'hira-overlay-card si-card'
  card.setAttribute('role', 'dialog')
  card.setAttribute('aria-label', '站点信息')
  card.tabIndex = -1

  const notice = doc.createElement('div')
  notice.className = 'si-notice'
  notice.setAttribute('role', 'status')
  notice.setAttribute('aria-live', 'polite')
  card.appendChild(notice)

  const body = doc.createElement('div')
  // 滚动 + 卡片内边距走共享词汇，与空间切换菜单同一条（padding 6px）。
  body.className = 'hira-overlay-scroll si-body'
  card.appendChild(body)

  root.appendChild(card)

  let visible = false
  let anchor: SiteInfoAnchor = { ...EMPTY_ANCHOR }
  /** @type {{ width: number, height: number } | null} */
  let viewport: { width: number, height: number } | null = null
  let lastLayoutSignature = ''
  let lastNoticeKey = ''
  /** @type {number} */
  let measureFrame: number = 0
  /** 0 尺寸重试次数（见 measure）：卡片尚未布局出来时不能把 0 当最终几何上报。 */
  let measureRetry = 0

  // ── 几何 ────────────────────────────────────────────────────────────────
  /**
   * 按「卡片下缘不超出窗口」推导本次最大高度，并把宽度收进窄窗口。
   * 宽度 / 最大高写进内联样式：CSS 只给默认值（360），窄窗口时以实测为准。
   */
  function applyGeometry() {
    const fallbackView = doc.defaultView
    const viewWidth = viewport?.width || fallbackView?.innerWidth || CARD_WIDTH
    const viewHeight = viewport?.height || fallbackView?.innerHeight || CARD_MAX_HEIGHT

    // 卡片下缘不许越过窗口下边：预留「窗口底边距 + 卡片下方阴影留白」。
    // （上方留白为 0：视图顶就是卡片顶，锚点以下的可用高度不受它影响。）
    const availableHeight =
      viewHeight - EDGE_MARGIN - (anchor.top + anchor.height + GAP) - PAD_BOTTOM
    const maxHeight = Math.max(
      MIN_CARD_HEIGHT,
      Math.min(CARD_MAX_HEIGHT, Math.floor(availableHeight))
    )
    // 整块浮层（卡片 + 左右阴影留白）都不许贴到窗口内容区边缘。
    const width = Math.max(
      MIN_CARD_WIDTH,
      Math.min(CARD_WIDTH, Math.floor(viewWidth - (PAD_X + EDGE_MARGIN) * 2))
    )

    card.style.width = `${width}px`
    card.style.maxHeight = `${maxHeight}px`
  }

  /** 实测卡片尺寸 → 加上四边阴影留白组成 outer 尺寸上报（去重，避免动画里刷屏）。 */
  function measure() {
    if (!visible) return
    const rect = card.getBoundingClientRect()
    // 卡片还没真正布局出来（`is-open` 尚未生效 / 内容为空）时**禁止上报**：
    // 0 尺寸 + 2×pad 会变成 24×24 的「隐形浮层」，主进程照样摆一块看不见的视图，
    // 表现就是「点了按钮什么都没有」。用 timer 重试（不能用 rAF：视图 0×0 时
    // Chromium 不产生帧，rAF 回调永远不会来）。
    if (!(rect.width > 0) || !(rect.height > 0)) {
      if (measureRetry < 8) {
        measureRetry += 1
        scheduleMeasureFallback()
      }
      return
    }
    measureRetry = 0
    // outer = 卡片 + 四边阴影留白（按边各报，见 SITEINFO_METRICS 的说明）。
    const width = Math.round(rect.width) + PAD_X * 2
    const height = Math.ceil(rect.height) + PAD_TOP + PAD_BOTTOM
    const signature = `${width}x${height}@${anchor.left},${anchor.top},${anchor.width},${anchor.height}`
    if (signature === lastLayoutSignature) return
    lastLayoutSignature = signature
    onLayout({
      width,
      height,
      interactive: true,
      position: 'anchor-below',
      anchor: { ...anchor },
      // 四边留白对象：主进程按边回展成 view bounds（上 0 → 视图顶就是卡片顶）。
      pad: { top: PAD_TOP, right: PAD_X, bottom: PAD_BOTTOM, left: PAD_X },
      gap: GAP,
      margin: EDGE_MARGIN
    })
  }

  /** rAF 合并：一次渲染里 section 可能连续改 DOM，ResizeObserver 会触发多轮。 */
  function scheduleMeasure() {
    if (measureFrame) return
    const raf = doc.defaultView?.requestAnimationFrame
    if (typeof raf !== 'function') {
      measure()
      return
    }
    measureFrame = raf(() => {
      measureFrame = 0
      measure()
    })
  }

  /**
   * timer 兜底：rAF 依赖「有帧」，而本浮层首次打开前原生视图是 0×0，
   * Chromium 不为它产帧 → rAF / ResizeObserver 都可能迟迟不回调。
   * 首帧与重试因此必须走 setTimeout（定时器不受绘制影响）。
   * @type {number}
   */
  let fallbackTimer: number = 0
  function scheduleMeasureFallback() {
    if (fallbackTimer) return
    const setTimer = doc.defaultView?.setTimeout
    if (typeof setTimer !== 'function') {
      measure()
      return
    }
    fallbackTimer = setTimer(() => {
      fallbackTimer = 0
      measure()
    }, 16)
  }

  const observer =
    typeof doc.defaultView?.ResizeObserver === 'function'
      ? new doc.defaultView.ResizeObserver(() => scheduleMeasure())
      : null
  observer?.observe(card)

  // ── 收起路径（视图能收到的那两条）──────────────────────────────────────
  function onKeyDown(event: KeyboardEvent) {
    if (!visible) return
    if (event.key !== 'Escape') return
    event.preventDefault()
    event.stopPropagation()
    onDismiss()
  }

  function onPointerDown(event: MouseEvent) {
    if (!visible) return
    // 卡片外的区域 = 本视图的阴影留白（网页上的点击本视图收不到，由外壳收起）。
    if (card.contains(/** @type {Node} */ ((event.target) as Node))) return
    onDismiss()
  }

  doc.addEventListener('keydown', onKeyDown, true)
  doc.addEventListener('mousedown', onPointerDown, true)

  // ── 对外接口 ────────────────────────────────────────────────────────────
  return {
    element: card,

    /**
     * 挂载 section 片段（只调用一次）。
     * @param {DocumentFragment} fragment
     */
    mountSections(fragment: DocumentFragment) {
      body.appendChild(fragment)
      scheduleMeasure()
    },

    /**
     * 展示 / 更新锚点。重复调用（窗口 resize、滚动导致锚点变化）只改几何，不闪一下。
     * @param {{ anchor?: object, viewport?: { width: number, height: number }, focus?: boolean }} context
     */
    show(context: SiteInfoShowContext) {
      const next = context || {}
      anchor = normalizeAnchor(next.anchor || anchor)
      if (next.viewport && Number.isFinite(Number(next.viewport.width))) {
        viewport = {
          width: Number(next.viewport.width),
          height: Number(next.viewport.height)
        }
      }
      applyGeometry()

      if (!visible) {
        visible = true
        lastLayoutSignature = ''
        measureRetry = 0
        card.classList.add('is-open')
        body.scrollTop = 0
        // 调用方可用 focus:false 声明「别抢键盘焦点」（后台触发的展示）。
        if (next.focus !== false) card.focus({ preventScroll: true })
        // **同步量一次**：`getBoundingClientRect()` 会强制同步布局，不依赖绘制帧。
        // 首次打开时原生视图是 0×0，rAF 可能永远不触发；不在这里先报一次，
        // 主进程就永远拿不到尺寸 → 浮层「点了没反应」。
        measure()
      }
      scheduleMeasure()
    },

    /**
     * 把带 `data-siteinfo-focus="<name>"` 标记的区块滚进卡片视野。
     * 只做滚动，不位移焦点（调用方已决定焦点归属）。
     * @param {string} name
     */
    focusSection(name: string) {
      if (!name) return
      const target = body.querySelector(`[data-siteinfo-focus="${name}"]`)
      if (!target) return
      const bodyRect = body.getBoundingClientRect()
      const targetRect = target.getBoundingClientRect()
      const delta = targetRect.top - bodyRect.top
      body.scrollTop = Math.max(0, body.scrollTop + delta - 8)
    },

    hide() {
      if (!visible) return
      visible = false
      lastLayoutSignature = ''
      measureRetry = 0
      card.classList.remove('is-open')
    },

    isVisible() {
      return visible
    },

    /**
     * 绘制壳层状态（目前只有 notice；业务内容由 section 自己消费同一份 state）。
     * @param {{ notice?: { kind?: string, message?: string } | null }} state
     */
    render(state: { notice?: { kind?: string, message?: string } | null }) {
      const next = state?.notice || null
      const key = next ? `${next.kind || 'info'}:${next.message || ''}` : ''
      if (key === lastNoticeKey) return
      lastNoticeKey = key

      notice.className = 'si-notice'
      notice.textContent = next?.message || ''
      if (next) {
        notice.classList.add('is-visible')
        notice.classList.add(next.kind === 'error' ? 'is-error' : 'is-info')
      }
      scheduleMeasure()
    },

    destroy() {
      doc.removeEventListener('keydown', onKeyDown, true)
      doc.removeEventListener('mousedown', onPointerDown, true)
      observer?.disconnect()
      const cancel = doc.defaultView?.cancelAnimationFrame
      if (measureFrame && typeof cancel === 'function') cancel(measureFrame)
      measureFrame = 0
      const clearTimer = doc.defaultView?.clearTimeout
      if (fallbackTimer && typeof clearTimer === 'function') clearTimer(fallbackTimer)
      fallbackTimer = 0
      card.remove()
    }
  }
}

