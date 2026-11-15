/**
 * glance-surface.js —— 速览（A1）在外壳 DOM 里的装饰：**整叠卡片的外环阴影**。
 *
 * ── 为什么它是外壳 DOM，而不是独立原生视图 ───────────────────────────
 * 与分屏分隔条 / 活动格框（`split-surface.js`）、侧栏聚焦框（`web-sidebar-surface.js`）
 * **同一条原理**：装饰落在"**没有任何网页 view 覆盖**"的那圈留白里 ——
 * 网页 view 只占各自卡片的矩形，而 chrome（窗口本体）天然在所有子视图之下、
 * 恰好在那些区域露出来。于是**不需要额外渲染进程、图层、IPC 家族**，
 * 也不必管浮层的惰性创建与闲置回收这一整套。
 *
 * ⚠ 更要紧的是**点击**：外壳 DOM **永远抢不走卡片的点击**（原生视图始终在它之上）。
 *   这一层的头一版做成了浮层视图，它铺满内容区又盖在卡片之上，把
 *   「**点背景卡 → 提升前台**」（`tabEvents` 的 `wc.on('focus')` 钩子）与网页点击
 *   **全吃掉了** —— 因为 `View` / `WebContentsView` 没有可用的 `setIgnoreMouseEvents`
 *   （视图只要可见就参与命中，项目早有结论：见 `renderer/hoverurl-overlay/main.js`）。
 *   挂在外壳 DOM 里，这个坑从结构上就不存在。
 *
 * ── 它画什么 ──────────────────────────────────────────────────────
 * 一个**完全透明的方块**摆在 back 卡（两张里更大的那张）的矩形上，只给 box-shadow：
 * `box-shadow` 默认画在框**之外**，所以"卡片之内的像素一个都不落"（那些像素本来
 * 也被卡片自己盖住），落在卡片之外的那圈正好就是外壳露出来的地方 →
 * 看起来是"整叠卡片浮在桌面上"。
 *
 * ⚠ **卡间投影 / 蓝色聚焦框不在这里** —— 它们要落在**前台卡**四周，而 front 卡
 *   （0.85×0.93）的左右两条边正落在 back 卡（0.95×0.975）身上：那片像素归 back 卡
 *   这张原生视图所有，外壳 DOM 到不了；盖在卡片之上又会吃掉点击。所以它们画进
 *   **back 卡那一页**里，见 `infra/infra-window/src/glance-deck-chrome.js`
 *   （框带落在 front 矩形之外、back 视口之内 ⇒ 在网页内容之上且不被圆角裁切）。
 *
 * ── 几何从哪来 ────────────────────────────────────────────────────
 * 主进程推 `glance:changed`（窗口级，与 `split:changed` 对仗），载荷是**窗口内容区坐标**
 * 下的 back 卡矩形 + 卡片圆角（`back: null` = 收起）；挂载时先主动拉一次
 * `layout:glance-geometry` —— 推送首帧可能早于订阅（**会话恢复**能在外壳订阅之前
 * 就把速览还原好）。
 *
 * 本模块不认识标签、不认识速览业务 —— 只吃"一个矩形 + 一个圆角"，吐 DOM。
 */

const STYLE_ID = 'hira-glance-surface-styles'

/**
 * 阴影口径（**只在这里定义一次**）。两层：
 *   · 近层「接触阴影」—— 紧贴卡片，定义边界；
 *   · 中层「体积阴影」—— 向外最多约 8px，给"离开桌面"的那点距离感。
 * 两者 alpha 都不高：整叠卡片几乎铺满内容区，阴影一重就显得脏。
 *
 * ⚠ **外扩半径不能随手调大**：back 卡距内容区边缘只有 `(1 - 0.95) / 2 = 2.5%` 宽、
 *   `(1 - 0.975) / 2 = 1.25%` 高 —— 720px 高的内容区下**垂直只有约 9px**。
 *   再往外扩，阴影就会画到内容区**外面**的 chrome 条上（这一层铺满整个外壳），
 *   在标签条 / 底栏上糊出一条暗边。
 *   横向留白宽得多（约 24~48px），但 box-shadow 的模糊是**各向同性**的，做不到
 *   "横向更宽、纵向更窄"——所以宁可整圈都收着。
 *
 * 深色主题加深并补一道 1px 浅色描边：黑阴影在黑底上没有对比度，
 * 描边落在卡片外侧，读作"这是有边界的纸"，与 macOS 同一条办法。
 */
const SHADOW_LIGHT = '0 1px 3px rgba(0, 0, 0, 0.24), 0 3px 11px -1px rgba(0, 0, 0, 0.30)'
const SHADOW_DARK = '0 1px 3px rgba(0, 0, 0, 0.50), 0 3px 11px -1px rgba(0, 0, 0, 0.50), 0 0 0 1px rgba(255, 255, 255, 0.06)'

interface GlanceRect { x: number; y: number; width: number; height: number }
interface GlanceGeometry { back: GlanceRect; radius?: number }
interface GlanceSurfacePorts {
  getGeometry?(): Promise<unknown> | unknown
  onChanged?(listener: (geometry: unknown) => void): () => void
}
export interface GlanceSurfaceController {
  element: HTMLElement
  setGeometry(geometry: unknown): void
  dispose(): void
}

/**
 * @param {Document} doc
 * @param {HTMLElement} root 外壳根（`#chrome-root`）—— 装饰按它的矩形做坐标换算
 * @param {{ getGeometry?: () => Promise<unknown>, onChanged?: (fn: (g:unknown)=>void) => () => void }} ports
 * @returns {{ setGeometry: (g:unknown) => void, dispose: () => void, element: HTMLElement }}
 */
export function createGlanceSurface(doc: Document, root: HTMLElement, ports: GlanceSurfacePorts = {}): GlanceSurfaceController {
  if (!doc || !root) throw new Error('createGlanceSurface: doc 与 root 必填')

  if (!doc.getElementById(STYLE_ID)) {
    const style = doc.createElement('style')
    style.id = STYLE_ID
    style.textContent = `
      /* 装饰层：铺满外壳根、**默认不吃指针**（它只是画，不该拦任何点击）。
         ⚠ 根级图层若默认吃指针，一次写坏就是"整个浏览器点不动"
         —— 与 #split-layer / #web-sidebar-layer 同一条纪律。
         不设 z-index：DOM 顺序已保证它在 #chrome-content（内容区染色层）之上。 */
      #glance-layer {
        position: absolute;
        inset: 0;
        pointer-events: none;
        overflow: hidden;
      }
      /* 阴影方块：**完全透明**，只有 box-shadow 画在框外。 */
      .glance-deck-shadow {
        position: absolute;
        box-sizing: border-box;
        background: transparent;
        pointer-events: none;
        z-index: 0;
        box-shadow: ${SHADOW_LIGHT};
      }
      :root[data-theme='dark'] .glance-deck-shadow { box-shadow: ${SHADOW_DARK}; }
    `
    doc.head.appendChild(style)
  }

  const layer = doc.createElement('div')
  layer.id = 'glance-layer'
  root.appendChild(layer)

  const deck = doc.createElement('div')
  deck.className = 'glance-deck-shadow'
  deck.hidden = true
  layer.appendChild(deck)

  /** 当前几何（窗口内容区坐标）。`null` = 不在速览里。 */
  let geometry: GlanceGeometry | null = null

  function rootOffset(): { x: number; y: number } {
    try {
      const rect = root.getBoundingClientRect()
      return { x: rect.x || 0, y: rect.y || 0 }
    } catch (_) {
      return { x: 0, y: 0 }
    }
  }

  function render(): void {
    const back = geometry && geometry.back
    if (!back || !(back.width > 0) || !(back.height > 0)) {
      deck.hidden = true
      return
    }
    const offset = rootOffset()
    deck.style.left = `${Math.round(back.x - offset.x)}px`
    deck.style.top = `${Math.round(back.y - offset.y)}px`
    deck.style.width = `${Math.round(back.width)}px`
    deck.style.height = `${Math.round(back.height)}px`
    // 圆角由主进程给（与卡片自身的 setBorderRadius 同一个值，渲染侧不自算 ——
    // 否则"影子比卡片方一点"这种偏差会两边各有一套值）。
    deck.style.borderRadius = `${Math.max(0, Number(geometry?.radius) || 0)}px`
    deck.hidden = false
  }

  function setGeometry(next: unknown): void {
    const record = next !== null && typeof next === 'object' ? next as Partial<GlanceGeometry> : null
    geometry = record?.back ? record as GlanceGeometry : null
    render()
  }

  let unsubscribe: (() => void) | null = null
  if (typeof ports.onChanged === 'function') {
    unsubscribe = ports.onChanged((payload) => setGeometry(payload))
  }
  // 挂载时主动拉一次：推送首帧可能早于订阅（会话恢复在外壳启动前就把速览还原好了）。
  if (typeof ports.getGeometry === 'function') {
    Promise.resolve(ports.getGeometry()).then((g) => setGeometry(g)).catch(() => {})
  }

  return {
    element: layer,
    setGeometry,
    dispose() {
      if (typeof unsubscribe === 'function') unsubscribe()
      unsubscribe = null
      layer.remove()
    }
  }
}


