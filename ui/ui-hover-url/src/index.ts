// @ts-check
/**
 * @hira-ng/ui-hover-url —— 链接悬停 URL 提示条（胶囊）
 *
 * 学 RT `components/browser-ui/target-url-indicator.tsx`：
 *   · 位置：**由宿主决定**（本模块只画胶囊，不认坐标）—— 当前宿主把它贴在
 *     **网页内容区左下角、贴底边**，距两条边各一个 margin；
 *   · 形态：**胶囊**（border-radius 9999）、单行、超出省略号、`pointer-events: none`；
 *   · 文本：去掉 `https://` / `http://` 协议头与结尾多余的 `/`（`mailto:` 保留前缀），
 *     完整 URL 放进 `title`（悬停可见，便于复制核对）；
 *   · 最大宽度：**网页宽度的 60%**（RT 的 maxWidth = anchor.width * 0.6）—— 由宿主
 *     把网页宽度带进来（胶囊自己量不到网页，它住的窗口就是它自己那么大）。
 *
 * ── 与 RT 的两处**有意偏离**（并说明理由）─────────────────────────────
 *   1. 显示延迟：RT 是「同标签内首次悬停延迟 500ms 才显示」。本模块默认**立即显示**，
 *      因为本项目的首要指标是「极致流畅跟手」—— 悬停一个链接要等半秒才看到状态，
 *      手感上就是"没反应"。延迟只保留在**收起**方向（默认 400ms），它解决的是真问题：
 *      鼠标从一条链接划到旁边空白/另一条链接时不该闪一下再出来。
 *      两个值都是构造参数（showDelayMs / hideDelayMs），要回到 RT 口径改一个数字即可。
 *   2. 配色与字重：RT 恒为深色玻璃（`bg-neutral-900/95` + 白字 + `font-semibold`），
 *      不跟随主题。本项目已有成熟的深浅令牌，因此改用 `--hira-bg-elevated` /
 *      `--hira-text-primary` 一对，**并把它调成半透明**（`color-mix(… 74%, transparent)`）
 *      —— 提示条是压在网页上的信息层，透出一点底色才不显得像贴了块膏药；
 *      字重取 400（RT 的 600 在本项目的字体栈下偏重）。深浅主题各自成立。
 *
 * 解耦：本模块不认识 IPC / webContents，只知道「给一条 URL 就画，给空串就收」。
 */

const STYLE_ID = 'hira-hover-url-styles'

/**
 * 胶囊四周留给**宿主视图**的余量（宿主按「胶囊尺寸 + 2×本值」上报视图尺寸，
 * 胶囊在视图内按本值内缩）。
 *
 * 为什么不设 0：宿主是原生视图，尺寸/位置要按显示器缩放取整 —— 留 0 时圆角与 1px 描边
 * 会被裁掉零点几像素（高分屏上看着像描边断了一截）。2px 是刚好够用的余量。
 * 也刻意别放大：视图比胶囊大出的每一像素都会参与鼠标命中（WebContentsView 没有
 * setIgnoreMouseEvents），余量越大，"这条信息条挡住网页"的面积就越大。
 */
export const HOVERURL_PAD = 2

/** 悬停 URL 的显示/收起延迟（毫秒）。见文件头「有意偏离」第 1 条。 */
export const HOVERURL_SHOW_DELAY_MS = 0
export const HOVERURL_HIDE_DELAY_MS = 400

export interface ReadableUrlParts {
  protocol: string
  text: string
}

export interface HoverUrlOptions {
  showDelayMs?: number
  hideDelayMs?: number
  onShownChange?: (shown: boolean) => void
}

export interface HoverUrlLayoutOptions {
  maxWidth?: number
}

export interface HoverUrlPill {
  readonly element: HTMLElement
  setUrl(url: string, options?: HoverUrlLayoutOptions): void
  hide(options?: HoverUrlLayoutOptions): void
  isShown(): boolean
  measure(): { width: number; height: number }
  destroy(): void
}

export function injectHoverUrlStyles(doc: Document): void {
  if (doc.getElementById(STYLE_ID)) return
  const style = doc.createElement('style')
  style.id = STYLE_ID
  style.textContent = `
    .hira-hoverurl {
      position: fixed;
      box-sizing: border-box;
      display: inline-flex; align-items: center; gap: 6px;
      max-width: 100%;
      height: 22px;
      padding: 0 10px;
      border-radius: 999px;
      /* 半透明表面：**透过它能看到网页**（宿主是透明窗口，半透明像素会与下方内容混合）。
         第一行是不透底的老写法兜底（color-mix 不被支持时退化回不透明，而不是整条
         background 声明失效变成全透明）；第二行才是真正生效的半透明，用 color-mix
         而不是写死 rgba，是为了跟着主题令牌走（深浅两套自动生效）。
         刻意不加 backdrop-filter：宿主窗口是透明的，Chromium 的 backdrop 采样不到
         窗口之外的原生视图/窗口内容 —— 加了等于白加（还会多一层合成开销）。 */
      background: var(--hira-bg-elevated, #f7f9fc);
      background: color-mix(in srgb, var(--hira-bg-elevated, #f7f9fc) 74%, transparent);
      border: 1px solid var(--hira-border-subtle, rgba(0, 0, 0, 0.1));
      /* 刻意**不要投影**：这条提示条是"贴在下角的一条状态信息"，斜投影会让它看起来
         浮在网页上方一层，与"贴在边角"的位置语义相反（用户明确要求去掉）。 */
      color: var(--hira-text-primary, #1a1a1a);
      /* 唯一字体令牌（shared-types/theme.mjs#UI_FONT_STACK）；兜底串同值。 */
      font-family: var(--hira-font-ui, "Segoe UI Variable Text", "Segoe UI Variable", "Segoe UI", "Microsoft YaHei UI", "Microsoft YaHei", "PingFang SC", "Noto Sans SC", system-ui, -apple-system, sans-serif);
      font-size: 12px;
      font-weight: 400;
      line-height: 1;
      -webkit-font-smoothing: antialiased;
      /* 关键：这是一条**信息层**，绝不能吃掉鼠标 —— 它压在网页上，
         拦一下指针就等于"点在链接上却没反应"（与 RT pointer-events-none 同义）。
         注：宿主是独立窗口，"鼠标真正穿透"那一半（setIgnoreMouseEvents）由窗口侧保证，
         这里这一行只保证窗口内部的 DOM 不参与命中。 */
      pointer-events: none;
      user-select: none;
      opacity: 0;
      /* 淡入淡出只动 opacity：合成器上跑，不引起任何重排 */
      transition: opacity 110ms ease-out;
    }
    .hira-hoverurl.is-shown { opacity: 1; }
    .hira-hoverurl__proto {
      flex-shrink: 0;
      color: var(--hira-text-tertiary, #9ca3af);
    }
    .hira-hoverurl__text {
      min-width: 0;
      overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
    }
    @media (prefers-reduced-motion: reduce) {
      .hira-hoverurl { transition: none; }
    }
  `
  doc.head.appendChild(style)
}

/** 把 URL 转成可读的协议与实际文本。 */
export function readableUrlParts(rawUrl: string): ReadableUrlParts {
  const raw = String(rawUrl || '')
  let protocol = ''
  let text = raw
  if (/^https?:\/\//i.test(raw)) {
    protocol = 'http'
    text = raw.replace(/^https?:\/\//i, '')
  } else if (/^mailto:/i.test(raw)) {
    protocol = 'mailto'
    text = raw.slice('mailto:'.length)
  }
  if (text.length > 1 && text.endsWith('/')) text = text.slice(0, -1)
  return { protocol, text }
}

/** 创建悬停 URL 胶囊；onShownChange 是宿主收放原生视图的唯一信号源。 */
export function createHoverUrlPill(doc: Document, ctx: HoverUrlOptions = {}): HoverUrlPill {
  const showDelayMs = Number.isFinite(Number(ctx.showDelayMs)) ? Math.max(0, Number(ctx.showDelayMs)) : HOVERURL_SHOW_DELAY_MS
  const hideDelayMs = Number.isFinite(Number(ctx.hideDelayMs)) ? Math.max(0, Number(ctx.hideDelayMs)) : HOVERURL_HIDE_DELAY_MS

  const root = doc.createElement('div')
  root.className = 'hira-hoverurl'

  const proto = doc.createElement('span')
  proto.className = 'hira-hoverurl__proto'
  root.appendChild(proto)

  const text = doc.createElement('span')
  text.className = 'hira-hoverurl__text'
  root.appendChild(text)

  /** 当前要展示的 URL（空串 = 应当收起） */
  let target = ''
  /** 上一次真正画上去的内容 —— 用于「收起延迟期间内容不闪空」 */
  let shown = false
  let showTimer: ReturnType<typeof setTimeout> | null = null
  let hideTimer: ReturnType<typeof setTimeout> | null = null

  function clearTimers() {
    if (showTimer) { clearTimeout(showTimer); showTimer = null }
    if (hideTimer) { clearTimeout(hideTimer); hideTimer = null }
  }

  function paint(url: string) {
    const parts = readableUrlParts(url)
    proto.textContent = parts.protocol ? `${parts.protocol}://` : ''
    text.textContent = parts.text
    // 完整 URL 放 title：胶囊本身是省略号态，用户仍能悬停确认（同 RT 的 span title 思路）
    root.title = String(url || '')
    setShownState(true)
  }

  /**
   * 视觉显隐切换的唯一出口 —— 每次变化都回调 `ctx.onShownChange`。
   *
   * 为什么必须回调宿主：**收起延迟住在这里，而 view 的尺寸住在主进程**。
   * 宿主若一收到空 URL 就把 view 收成 0×0，那 400ms 的"不闪断"就白设了
   * （胶囊随视图一起瞬间消失）；反过来，宿主自己再记一份延迟就会与这里漂移。
   * 于是分工：本模块决定"视觉上还在不在"，宿主据此决定"视图还占不占位"。
   */
  function setShownState(next: boolean) {
    if (shown === next) return
    shown = next
    root.classList.toggle('is-shown', next)
    if (typeof ctx.onShownChange === 'function') ctx.onShownChange(next)
  }

  return {
    element: root,

    /**
     * 喂一条 URL。空串 = 指针离开链接 → 按 hideDelayMs 延迟收起
     * （相邻链接之间快速划过时不闪断）。
     */
    setUrl(url: string, opts: HoverUrlLayoutOptions = {}) {
      const next = String(url || '')
      if (Number.isFinite(Number(opts.maxWidth)) && Number(opts.maxWidth) > 0) {
        root.style.maxWidth = `${Math.floor(Number(opts.maxWidth))}px`
      }
      if (next === target) return
      target = next
      clearTimers()
      if (!next) {
        if (!shown) return
        hideTimer = setTimeout(() => {
          hideTimer = null
          setShownState(false)
        }, hideDelayMs)
        return
      }
      if (showDelayMs > 0) {
        showTimer = setTimeout(() => { showTimer = null; paint(target) }, showDelayMs)
        return
      }
      paint(next)
    },

    /**
     * 无条件立即收起（切标签 / 开始导航 / 窗口失焦 —— 这些场景不该等延迟）。
     */
    hide(opts: HoverUrlLayoutOptions = {}) {
      clearTimers()
      target = ''
      if (Number.isFinite(Number(opts.maxWidth)) && Number(opts.maxWidth) > 0) {
        root.style.maxWidth = `${Math.floor(Number(opts.maxWidth))}px`
      }
      setShownState(false)
    },

    isShown() {
      return shown
    },

    /** 当前渲染尺寸（宿主据此 + 2×HOVERURL_PAD 上报视图尺寸）。 */
    measure() {
      const r = root.getBoundingClientRect()
      return { width: Math.ceil(r.width), height: Math.ceil(r.height) }
    },

    destroy() {
      clearTimers()
      root.remove()
    }
  }
}

/** 浮层宿主用的插件式定义（与其它 ui 包同形）。 */
export const hoverUrlDefinition = {
  id: 'hover-url',
  injectStyles: injectHoverUrlStyles,
  mount(doc: Document, ctx: HoverUrlOptions = {}) {
    return createHoverUrlPill(doc, ctx)
  }
}
