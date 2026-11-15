/**
 * glance-deck-chrome —— 速览（Glance）**两张卡之间的那层装饰**：前台卡的投影 + 蓝色聚焦框。
 *
 * ── 一条必须讲清楚的图层事实 ─────────────────────────────────────
 * 网页是原生 `WebContentsView`，而 chrome（窗口本体 renderer 的 DOM）在**所有原生视图
 * 之下**。于是"画在网页之上"只有两条路：
 *   ① 注入网页自身（与那一页同图层、同生共死，`z-index` 拉到最大值压过往站自己的浮层）；
 *   ② 再开一个原生浮层视图（**不可行**：Electron 43 的 `View` / `WebContentsView` 没有
 *      `setIgnoreMouseEvents`，浮层只要可见就参与命中，"点背景卡→提升前台"与网页点击
 *      会被整片吃掉 —— 项目早已踩过，见 `docs-new/5-文档地图与工程红线.md` §3.3.1）。
 * 所以走 ①。
 *
 * ── 为什么注入 **back 卡**，而不是 front 卡 ────────────────────────
 * 这是上一版（注入 front 自己）失败的根本原因。front 卡四周都是 back 卡的像素：
 * 只要框画在 front 自己的页面上、又贴着视口边缘，就必然被**自身视图的圆角裁切**切掉
 * 四个角（"蓝框圆角缺一块"）；把 `border-radius` 调成同半径也只是让方框变圆角框，
 * 裁切依然在，且和原生裁切轮廓永远差半像素。
 *
 * 现在的做法是**把框画在 back 那一页上、贴着 front 的轮廓画**：
 *   · 框带落在 front 矩形**之外 / back 视口之内**的那圈像素里 —— 那里没有任何视图盖着，
 *     框完整可见、不被任何圆角裁切；
 *   · front 自己的圆角由原生 `setBorderRadius` 裁出，框的外轮廓半径取 `radius + 线宽`，
 *     与裁切轮廓同心 ⇒ 圆弧处严丝合缝；
 *   · 框内侧那一圈（TUCK_PX）故意压在 front 卡底下 ⇒ 没有半像素缝。
 * 前提是 front 完全内嵌于 back（见 `glance-layout.mjs` 文件头的几何约束）。
 *
 * ── 为什么不需要任何几何 ──────────────────────────────────────────
 * 注入的是 `html::before` / `html::after`，`position: fixed` + **纯百分比**，
 * 百分比按 **back 视口**解析 ⇒ 卡片矩形就是视口矩形；改窗口尺寸、网页缩放一概不用管。
 * 四个百分比全部由 `glanceFrontInset()`（`GLANCE_METRICS` 的纯函数）推出，
 * 叠放口径一改这里自动跟着改。
 *
 * ── 与外环阴影的分工 ──────────────────────────────────────────────
 * 外壳 DOM 那份 `renderer/shared/glance-surface.js` 画的是**整叠卡片的外环阴影**
 * （落在 back 卡矩形之外那圈留白里，读作"这叠纸浮在桌面上"）；本模块画的是
 * **卡片之间**那道投影 + 聚焦框（落在 back 卡之内、front 卡之外）。两者互不抢像素。
 *
 * ⚠ 已知代价：装饰属于那一页的渲染结果，**页面截图与标签预览缩略图会带上它**
 *   （只在速览期间）。打印已用 `@media screen` 排除。
 *
 * ── 生命周期 ──────────────────────────────────────────────────────
 * `sync(backTabId, { radius, dark })` —— 幂等：同一张卡 + 同一组参数就什么都不做；
 * 换卡 / 参数变（主题圆角、明暗）先摘旧的再注新的；`null` = 收起。
 * 导航会把注入丢掉（样式是**按文档**生效的），所以挂着 `dom-ready` 重注一次；
 * 换卡 / 收起时把监听摘掉，不留悬挂回调（页面可能活很久，挂着就是泄漏）。
 */

const { glanceFrontInset } = require('@hira-ng/shared-types/src/glance-layout')
const { SPLIT_METRICS } = require('@hira-ng/shared-types/src/split-layout')

/** 框的线宽 —— 与分屏活动格框、侧栏聚焦框同一个真源。 */
const RING_PX = Math.max(1, Math.round(Number(SPLIT_METRICS.paneGap) || 2))
/**
 * 框带藏进 front 卡底下的厚度（px）。
 * 1px 足够吃掉亚像素误差：可见厚度仍是 RING_PX，但内侧不会露出半像素缝。
 */
const TUCK_PX = 1
/**
 * 聚焦框的回退色（主题强调色不可得时用）。
 * ⚠ 主题强调色由宿主经 `sync(..., { accent })` 带进来 —— 这段 CSS 是注入**网页**的，
 *   那一页里没有 `--hira-accent`，所以不能指望 CSS 变量。
 */
const RING_FALLBACK = 'rgba(74, 158, 255, 0.9)'

/**
 * 把强调色转成"90% 不透明"的框线色。
 * 用 `color-mix` 而不是在 JS 里拆 hex：主题色可能是任意合法 CSS 颜色
 * （rgb / hsl / 带 alpha 的写法），JS 拆解只会覆盖其中一部分。
 */
function ringColor(accent: unknown): string {
  const a = String(accent || '').trim()
  if (!a) return RING_FALLBACK
  return `color-mix(in srgb, ${a} 90%, transparent)`
}

/** 浅色底：黑阴影压得住，配 1px 淡描边给一条清晰的界线。 */
const SHADOW_LIGHT = '0 2px 12px rgba(0, 0, 0, 0.30), 0 0 0 1px rgba(0, 0, 0, 0.06)'
/** 深色底：黑阴影在黑底上没有对比度 ⇒ 加深，描边换成浅色。 */
const SHADOW_DARK = '0 2px 14px rgba(0, 0, 0, 0.60), 0 0 0 1px rgba(255, 255, 255, 0.07)'

/** 比例 → 百分比串（保留 4 位小数：够精确，又不写出长尾数字）。 */
function pct(ratio: number): string {
  return `${(ratio * 100).toFixed(4)}%`
}

/**
 * 生成一次性注入的 CSS。
 *
 * 坐标口径（全部相对 **back 视口**）：
 *   · `SIDE_PCT` / `EDGE_PCT` = front 轮廓在 back 视口里的内缩（见 glanceFrontInset）；
 *   · `html::before` 正好占 front 矩形 ⇒ 投影只从框外可见（框内被 front 盖住）；
 *   · `html::after` 外扩 RING_PX、边框厚 RING_PX + TUCK_PX ⇒ 可见厚度 RING_PX。
 *
 * @param {number} radiusPx 主题视图圆角（px，与 `view.setBorderRadius` 同一个数）
 * @param {boolean} dark 主题底色是否偏暗
 * @param {string} [accent] 主题强调色（决定聚焦框颜色）
 */
function buildCss(radiusPx: number, dark: boolean, accent?: string): string {
  const { sideRatio, edgeRatio } = glanceFrontInset()
  const side = pct(sideRatio)
  const edge = pct(edgeRatio)
  // 框的外轮廓半径必须与 front 的裁切轮廓**同心**：front 半径 R，框外扩 RING ⇒ R + RING。
  const outerRadius = radiusPx + RING_PX
  const borderPx = RING_PX + TUCK_PX
  return `
@media screen {
  html::before {
    content: '' !important;
    position: fixed !important;
    left: ${side} !important;
    right: ${side} !important;
    top: ${edge} !important;
    bottom: ${edge} !important;
    box-sizing: border-box !important;
    border-radius: ${radiusPx}px !important;
    box-shadow: ${dark ? SHADOW_DARK : SHADOW_LIGHT} !important;
    background: none !important;
    pointer-events: none !important;
    z-index: 2147483647 !important;
  }
  html::after {
    content: '' !important;
    position: fixed !important;
    left: calc(${side} - ${RING_PX}px) !important;
    right: calc(${side} - ${RING_PX}px) !important;
    top: calc(${edge} - ${RING_PX}px) !important;
    bottom: calc(${edge} - ${RING_PX}px) !important;
    box-sizing: border-box !important;
    /* 与 front 的圆角同心；内侧那 RING_PX 藏进 front 卡底下（见文件头）。 */
    border-radius: ${outerRadius}px !important;
    border: ${borderPx}px solid ${ringColor(accent)} !important;
    background: none !important;
    pointer-events: none !important;
    z-index: 2147483647 !important;
  }
}
`
}

/**
 * @param {{ getTabWebContents?: (tabId: string) => any }} ports
 *   取某张标签的 `webContents`（由宿主注入 —— 本模块不认识标签表）
 * @returns {{ sync: (backTabId: string|null, opts?: { radius?: number, dark?: boolean }) => void }}
 */
interface GlanceWebContents {
  isDestroyed?(): boolean
  insertCSS(css: string): Promise<string>
  removeInsertedCSS(key: string): void
  on(event: 'dom-ready', listener: () => void): unknown
  removeListener(event: 'dom-ready', listener: () => void): unknown
}
interface GlanceDeckPorts { getTabWebContents?: (tabId: string) => GlanceWebContents | null }
interface GlanceSyncOptions { radius?: number; dark?: boolean; accent?: string }

export function createGlanceDeckChrome(ports: GlanceDeckPorts = {}): {
  sync(backTabId: string | null, options?: GlanceSyncOptions): void
} {
  const getTabWebContents = typeof ports.getTabWebContents === 'function' ? ports.getTabWebContents : () => null
  /** 当前注入了哪一张（null = 没有）。 */
  let currentId: string | null = null
  /** 当前注入用的 CSS 本身（变了要重注）—— 拿 CSS 当键，参数一多也不会漏判。 */
  let currentKey = ''
  /** 当前那份插入的样式键 + 它在哪个 wc 上（导航后旧键随文档消失，摘它无害）。 */
  let key: string | null = null
  let keyWc: GlanceWebContents | null = null
  /** 挂着的 `dom-ready` 监听（换卡 / 收起时必须摘掉）。 */
  let listenWc: GlanceWebContents | null = null
  let listener: (() => void) | null = null

  function detachListener(): void {
    if (listenWc && listener) {
      try { listenWc.removeListener('dom-ready', listener) } catch (_) {}
    }
    listenWc = null
    listener = null
  }

  function dropKey(): void {
    if (keyWc && key) {
      try { keyWc.removeInsertedCSS(key) } catch (_) {}
    }
    key = null
    keyWc = null
  }

  /** 往这张 wc 注一次（重复调用安全：同一文档里再注一次会再多一份样式，故先摘旧的）。 */
  function insertInto(wc: GlanceWebContents | null | undefined, id: string, css: string): void {
    if (!wc || (typeof wc.isDestroyed === 'function' && wc.isDestroyed())) return
    dropKey()
    let pending: Promise<string> | null = null
    try {
      pending = wc.insertCSS(css)
    } catch (_) {
      return
    }
    if (pending && typeof pending.then === 'function') {
      pending
        .then((k: string) => {
          // 异步回来时可能已经换卡 / 收起了 —— 那就立刻把这一份摘掉，别留在别人页面上。
          if (!k) return
          if (currentId !== id || currentKey !== css) { try { wc.removeInsertedCSS(k) } catch (_) {} return }
          key = String(k)
          keyWc = wc
        })
        .catch(() => {})
    }
  }

  /**
   * 同步到"装饰应该画在哪一张后台卡上"。
   * @param {string|null} backTabId 后台卡的标签 id；`null` = 收起（退出速览）
   * @param {{ radius?: number, dark?: boolean, accent?: string }} [opts]
   *   主题视图圆角 / 主题底色明暗 / 主题强调色
   */
  function sync(backTabId: string | null, opts: GlanceSyncOptions = {}): void {
    const id = backTabId == null || backTabId === '' ? null : String(backTabId)
    const radius = Math.max(0, Math.round(Number(opts.radius) || 0))
    const dark = opts.dark === true
    const css = buildCss(radius, dark, opts.accent)
    /**
     * 幂等：同一张卡 + 同一份 CSS + **同一个 webContents** 就什么都不做 ——
     * 全量布局会被 resize / 面板开关频繁触发，而这条注入绝大多数时候没变。
     *
     * ⚠ 必须连 wc 一起比：标签 sleep/wake 会换掉整个 `WebContentsView`（新文档、新表面），
     *   注入随旧文档一起消失，而"卡 id + CSS"却完全没变 —— 只比这两项的话就再也不会重注。
     */
    const wc = id ? getTabWebContents(id) : null
    if (id === currentId && css === currentKey && wc && wc === listenWc) return
    // 换卡 / 换参数 / 换了 webContents：先把上一份摘干净（含它上面挂着的重注监听）。
    detachListener()
    dropKey()
    currentId = id
    currentKey = css
    if (!id || !wc) return

    insertInto(wc, id, css)
    // 导航会丢掉注入（样式按文档生效）—— 重新注一次，否则"在速览里点个链接，装饰就没了"。
    listener = () => { if (currentId === id) insertInto(wc, id, currentKey) }
    listenWc = wc
    try { wc.on('dom-ready', listener) } catch (_) { listenWc = null; listener = null }
  }

  return { sync }
}

