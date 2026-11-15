/**
 * overlay-host —— 页面侧「注入阴影 DOM 覆盖层」的公共建设器。
 *
 * ── 为什么需要它 ──────────────────────────────────────────────────
 * Break Mode（D5）要在**当前网页之上**盖一层自己的 UI。
 * 网页是原生 `WebContentsView`，外壳 DOM 盖不到它 —— 唯一能做这件事的地方就是
 * 跑在这一页里的 preload。于是"建一个铺满视口、与页面样式彻底隔离、默认不吃指针的
 * 宿主"这件事被两个模块各写一遍，必然漂移（z-index 取值、`all:initial`、清理时机…）。
 * 收敛到这里。
 *
 * ── 三条约定 ──────────────────────────────────────────────────────
 *  1. **样式隔离**：宿主带 `all:initial` + 独立 shadow root，页面怎么改 CSS 都穿不进来；
 *     `z-index` 取 `2147483647`（32 位最大值），页面再怎么抬也压不住它。
 *  2. **默认不吃指针**：只有真的要"挡住页面并接收点击"（Break Mode）才传 `interactive: true`。
 *     默认穿透 → 纯展示型覆盖层不会让网页某块点不动。
 *  3. **建不起来也不拖主链**：`createOverlayHost` 抛错时由调用方兜住（返回 null），
 *     绝不让一个装饰把功能本身拖死（同 `gestures` 的纪律）。
 *  4. **强调色由宿主带进来**：shadow 里的 CSS 读不到外壳令牌（这一页只有网页样式），
 *     所以建宿主时统一把 `theme-accent` 的变量写到宿主上（自定义属性会继承进
 *     shadow）。浮层 CSS 因此可以放心写 `var(--hira-accent, …)`，
 *     且换主题时会**自动跟随**（`subscribeAccent` 重写变量，无需重建 DOM）。
 */

import { applyAccentVars, subscribeAccent } from './theme-accent.js'

/**
 * 建一个覆盖层宿主。
 *
 * @param {string} tag `data-hira-ui` 标记（便于在 DevTools 里辨认是谁注入的）
 * @param {{ interactive?: boolean, css?: string }} [opts]
 *   `interactive` = 吃指针（用于"挡页面"的遮罩）；`css` = 写进 shadow 的样式文本
 * @returns {{
 *   host: HTMLElement, shadow: ShadowRoot,
 *   show: () => void, hide: () => void, destroy: () => void,
 *   el: (tagName: string, css?: string, text?: string) => HTMLElement
 * }}
 */
interface OverlayHostOptions { interactive?: boolean; css?: string }
export interface OverlayHost {
  host: HTMLElement
  shadow: ShadowRoot
  show(): void
  hide(): void
  destroy(): void
  el(tagName: string, css?: string, text?: string): HTMLElement
}

export function createOverlayHost(tag: string, opts: OverlayHostOptions = {}): OverlayHost {
  const host = document.createElement('div')
  host.setAttribute('data-hira-ui', tag)
  host.style.cssText =
    'all:initial;position:fixed;inset:0;z-index:2147483647;display:none;' +
    (opts.interactive ? '' : 'pointer-events:none;')
  const shadow = host.attachShadow({ mode: 'closed' })
  const style = document.createElement('style')
  // `color-scheme: normal` 是为了不让系统深色模式把我们的配色反相（我们是自绘的）。
  style.textContent = '*,*::before,*::after{box-sizing:border-box;}' + (opts.css || '')
  shadow.appendChild(style)
  ;(document.documentElement || document.body).appendChild(host)

  // 主题强调色：先按当前值写一遍（首帧就是对的色），再订阅后续变化。
  // 变量写在**宿主**上 → shadow 内的节点继承得到，浮层 CSS 直接用 `var(--hira-accent)`。
  applyAccentVars(host)
  const unsubscribeAccent = subscribeAccent((vars: Record<string, string>) => {
    for (const key of Object.keys(vars)) {
      try { host.style.setProperty(key, vars[key]) } catch (_) {}
    }
  })

  /** 造子元素（带内联样式与文本），省掉到处 createElement + cssText。 */
  function el(tagName: string, css?: string, text?: string): HTMLElement {
    const node = document.createElement(tagName)
    if (css) node.style.cssText = css
    if (text !== undefined) node.textContent = text
    return node
  }

  return {
    host,
    shadow,
    el,
    show() { host.style.display = 'block' },
    hide() { host.style.display = 'none' },
    destroy() {
      try { unsubscribeAccent() } catch (_) {}
      try { host.remove() } catch (_) {}
    }
  }
}
