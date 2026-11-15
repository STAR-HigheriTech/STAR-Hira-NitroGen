// @ts-check
/**
 * ui-webviews — WebviewContainer + GestureHandler + 右键菜单
 *
 * PART5 S5-5 / PART8 Week 12:
 *   WebviewContainer: 管理标签页 webview 容器（显示/隐藏切换、圆角、内边距）
 *   GestureHandler:   左右滑动手势 → 前进/后退导航
 *   ContextMenu:      网页右键菜单组装（含扩展 getContextMenuItems）
 *
 * 注意: NG 使用 WebContentsView (Electron 38 API)，不是 <webview> 标签。
 * main 进程的 WebContentsView 由 WebContentsManager 管理；
 * renderer 层的 WebviewContainer 只负责容器 DOM 布局和事件处理。
 *
 * 对齐 PART8 铁律: UI 像素冻结 — 圆角/内边距/边框严格匹配原系统
 */

// ── WebviewContainer 样式 ──────────────────────────────
// 关键：chrome = 窗口本体（全窗口 WebContentsView）。此容器是内容区的「透明洞」——
// 真正的网页是叠在 chrome 之上的原生 WebContentsView（tab 图层），本容器只负责
// 撑出内容区高度与圆角，**绝不能有背景色**，否则会盖住/污染网页与圆角边框区域。
const CONTAINER_STYLE = `
.webview-container {
  position: relative;
  flex: 1;
  overflow: hidden;
  background: transparent;
  border-radius: var(--webview-radius, 6px);
}
.webview-container.rounded {
  /* 圆角统一走主题 token：默认 6px，与主进程 LayoutCoordinator._tabBorderRadius 一致 */
  border-radius: var(--webview-radius, 6px);
}
.webview-container.with-border {
  border: 1px solid var(--webview-border, var(--hira-border-subtle, rgba(0,0,0,0.08)));
}
.webview-placeholder {
  position: absolute;
  inset: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  color: var(--text-secondary, var(--hira-text-secondary, rgba(0,0,0,0.5)));
  font-size: 14px;
  pointer-events: none;
}
`

export interface WebviewContainerOptions {
  rounded?: boolean
  border?: boolean
}

export interface WebviewContainer {
  readonly element: HTMLElement
  readonly placeholder: HTMLElement
  showPlaceholder(visible: boolean): void
}

export interface GestureHandlerOptions {
  element: HTMLElement
  onBack?: () => void
  onForward?: () => void
  threshold?: number
  maxDuration?: number
}

export interface DisposableHandler {
  destroy(): void
}

export interface WebContextMenuParams {
  linkURL?: string
  selectionText?: string
  mediaType?: string
  srcURL?: string
  isEditable?: boolean
}

export interface WebContextMenuActions {
  onBack?: () => void
  onForward?: () => void
  onReload?: () => void
  onCopyLink?: (url: string) => void
  onCopyText?: (text: string) => void
  onPaste?: () => void
  onSaveImage?: (url: string) => void
  onOpenLinkNewTab?: (url: string) => void
  onSearchText?: (text: string) => void
}

export interface ExtensionMenuItem {
  type?: 'normal' | 'separator'
  label?: string
  title?: string
  enabled?: boolean
  click?: () => void
}

export interface WebContextMenuItem {
  type: 'normal' | 'separator'
  label?: string
  enabled?: boolean
  click?: () => void
}

/** 注入 WebviewContainer 样式。 */
export function injectWebviewsStyles(doc: Document): void {
  const style = doc.createElement('style')
  style.textContent = CONTAINER_STYLE
  doc.head.appendChild(style)
}

/** 创建 WebviewContainer DOM 元素。 */
export function createWebviewContainer(options: WebviewContainerOptions = {}): WebviewContainer {
  const el = document.createElement('div')
  el.className = 'webview-container'
  if (options.rounded !== false) el.classList.add('rounded')
  if (options.border) el.classList.add('with-border')

  const placeholder = document.createElement('div')
  placeholder.className = 'webview-placeholder'
  placeholder.textContent = ''
  el.appendChild(placeholder)

  return {
    element: el,
    placeholder,
    showPlaceholder(visible: boolean) {
      placeholder.style.display = visible ? 'flex' : 'none'
    }
  }
}

// ── GestureHandler ────────────────────────────────────
/** 创建左右滑动导航手势处理器。 */
export function createGestureHandler(options: GestureHandlerOptions): DisposableHandler {
  const el = options.element
  const onBack = options.onBack || (() => {})
  const onForward = options.onForward || (() => {})
  const threshold = options.threshold || 80
  const maxDuration = options.maxDuration || 500

  let touchStartX = 0
  let touchStartY = 0
  let touchStartTime = 0
  let tracking = false

  function onTouchStart(e: TouchEvent) {
    if (e.touches.length !== 1) return
    touchStartX = e.touches[0].clientX
    touchStartY = e.touches[0].clientY
    touchStartTime = Date.now()
    tracking = true
  }

  function onTouchEnd(e: TouchEvent) {
    if (!tracking) return
    tracking = false
    const duration = Date.now() - touchStartTime
    if (duration > maxDuration) return
    const touch = e.changedTouches[0]
    if (!touch) return
    const dx = touch.clientX - touchStartX
    const dy = touch.clientY - touchStartY
    // 水平滑动为主
    if (Math.abs(dx) < threshold || Math.abs(dy) > Math.abs(dx)) return
    if (dx > 0) onBack()
    else onForward()
  }

  el.addEventListener('touchstart', onTouchStart, { passive: true })
  el.addEventListener('touchend', onTouchEnd, { passive: true })

  return {
    destroy() {
      el.removeEventListener('touchstart', onTouchStart)
      el.removeEventListener('touchend', onTouchEnd)
    }
  }
}

// ── ContextMenu 组装 ──────────────────────────────────
/** 创建网页右键菜单项列表。 */
export function buildContextMenuItems(
  params: WebContextMenuParams,
  actions: WebContextMenuActions = {},
  extensionItems: ExtensionMenuItem[] = []
): WebContextMenuItem[] {
  const items: WebContextMenuItem[] = []

  // 导航
  if (actions.onBack) {
    items.push({ type: 'normal', label: '后退', enabled: true, click: actions.onBack })
  }
  if (actions.onForward) {
    items.push({ type: 'normal', label: '前进', enabled: true, click: actions.onForward })
  }
  if (actions.onReload) {
    items.push({ type: 'normal', label: '刷新', click: actions.onReload })
  }

  if (items.length > 0) items.push({ type: 'separator' })

  // 链接
  const onOpenLinkNewTab = actions.onOpenLinkNewTab
  const onCopyLink = actions.onCopyLink
  const onCopyText = actions.onCopyText
  const onSearchText = actions.onSearchText
  const onSaveImage = actions.onSaveImage
  if (params.linkURL && onOpenLinkNewTab) {
    const url = params.linkURL
    items.push({ type: 'normal', label: '在新标签页打开链接', click: () => onOpenLinkNewTab(url) })
  }
  if (params.linkURL && onCopyLink) {
    const url = params.linkURL
    items.push({ type: 'normal', label: '复制链接地址', click: () => onCopyLink(url) })
  }

  // 文本
  if (params.selectionText && onCopyText) {
    const text = params.selectionText
    items.push({ type: 'normal', label: '复制', click: () => onCopyText(text) })
  }
  if (params.selectionText && onSearchText) {
    const text = params.selectionText
    items.push({ type: 'normal', label: `搜索"${text.slice(0, 20)}"`, click: () => onSearchText(text) })
  }

  // 图片
  if (params.mediaType === 'image' && params.srcURL && onSaveImage) {
    const url = params.srcURL
    items.push({ type: 'normal', label: '保存图片', click: () => onSaveImage(url) })
  }

  // 粘贴
  if (actions.onPaste && params.isEditable) {
    items.push({ type: 'normal', label: '粘贴', click: actions.onPaste })
  }

  // 扩展菜单项
  if (extensionItems && extensionItems.length > 0) {
    items.push({ type: 'separator' })
    for (const ext of extensionItems) {
      if (ext.type === 'separator') {
        items.push({ type: 'separator' })
      } else {
        items.push({
          type: 'normal',
          label: String(ext.label || ext.title || ''),
          enabled: ext.enabled !== false,
          click: () => { if (typeof ext.click === 'function') ext.click() }
        })
      }
    }
  }

  return items
}

export default {
  injectWebviewsStyles,
  createWebviewContainer,
  createGestureHandler,
  buildContextMenuItems
}

// ── 向后兼容别名（app-shell/main.js 旧 API） ─────────
export const injectWebviewsShellStyles = injectWebviewsStyles
export function createWebviewsShell(_doc: Document): WebviewContainer {
  const { element, placeholder, showPlaceholder } = createWebviewContainer({ rounded: false })
  return { element, placeholder, showPlaceholder }
}
