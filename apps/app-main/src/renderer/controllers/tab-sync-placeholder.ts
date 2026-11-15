/**
 * 跨窗口标签同步（A5 / J15）的**截图占位**渲染点。
 *
 * ── 为什么占位能画在这里 ────────────────────────────────────────────
 * 同步把活动标签的真实视图（原生 `WebContentsView`）迁到另一个窗口之后，本窗口那块内容区
 * **没有任何网页盖着** —— 与分屏分隔条只能画在 `paneGap` 那条缝里不同，这里整块都空着，
 * 于是外壳 DOM 正好可以在上面贴一张截图，避免"移动瞬间"闪一下空白。
 *
 * 宿主元素直接用 `ui-webviews` 已有的 `.webview-placeholder`（`position:absolute; inset:0`
 * 且 `pointer-events:none`）—— 它本身就是"内容区空着时的那块区域"，不新建 DOM 层级。
 *
 * ── 为什么只持 URL 不持字节 ─────────────────────────────────────────
 * 与 tabpreview-overlay 同款：字节由主进程 `hira://tab-snapshot?id=…` 协议直吐，
 * 渲染层只拿到一个地址并设成背景图。位图不进渲染进程 JS 堆。
 */
import { errorMessage } from '../shared/error-message.js'

const PLACEHOLDER_STYLE = `
.webview-placeholder.has-tab-snapshot {
  background-repeat: no-repeat;
  background-position: center center;
  background-size: contain;
}
`

/**
 * 注入占位样式（幂等 —— 由 app-shell 启动时调一次）。
 * @param {Document} doc
 */
export function injectTabSyncPlaceholderStyles(doc: Document) {
  if (doc.getElementById('tab-sync-placeholder-style')) return
  const style = doc.createElement('style')
  style.id = 'tab-sync-placeholder-style'
  style.textContent = PLACEHOLDER_STYLE
  doc.head.appendChild(style)
}

/**
 * @param {object} deps
 * @param {HTMLElement} deps.holder 内容区占位元素（`webviewsShell.placeholder`）
 * @param {(fn: (payload: { url?: string|null }) => void) => (() => void)} deps.onChanged
 *   订阅主进程推送（返回取消订阅函数）
 */
interface TabSyncPlaceholderDeps {
  holder: HTMLElement
  onChanged(fn: (payload: unknown) => void): () => void
}

export function createTabSyncPlaceholder({ holder, onChanged }: TabSyncPlaceholderDeps) {
  let unsubscribe: (() => void) | null = null

  /**
   * @param {{ url?: string|null }} payload `url` 非空 = 贴这张截图；空 = 收起。
   */
  function apply(rawPayload: unknown) {
    if (!holder) return
    const payload = rawPayload !== null && typeof rawPayload === 'object'
      ? rawPayload as { url?: unknown }
      : null
    const url = payload && typeof payload.url === 'string' && payload.url ? payload.url : ''
    if (url) {
      holder.style.backgroundImage = `url("${url.replace(/"/g, '\\"')}")`
      holder.classList.add('has-tab-snapshot')
      return
    }
    holder.style.backgroundImage = ''
    holder.classList.remove('has-tab-snapshot')
  }

  /**
   * ⚠ 订阅**必须**包一层 try/catch：它在外壳启动时同步执行，若这里的任何一步抛错
   * （bridge 未就绪 / 通道注册异常），后面的初始化（下载条、modal、以及**全部的
   * 布局上报**）都会跟着不执行 —— 表现是整个窗口白屏。占位是锦上添花的功能，
   * 绝不能成为外壳启动的单点故障。
   */
  if (typeof onChanged === 'function') {
    try {
      unsubscribe = onChanged(apply)
    } catch (e) {
      console.warn('[tab-sync-placeholder] subscribe failed:', errorMessage(e))
      unsubscribe = null
    }
  }

  return {
    apply,
    dispose() {
      if (typeof unsubscribe === 'function') unsubscribe()
      unsubscribe = null
      apply(null)
    }
  }
}

