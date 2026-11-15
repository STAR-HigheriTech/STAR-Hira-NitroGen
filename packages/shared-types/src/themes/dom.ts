/**
 * shared/dom.js —— 两个形态共用的**最小 DOM 工具**（叶子节点，不含布局与业务）。
 *
 * 为什么不用 innerHTML 拼字符串：主题编辑器里大量控件需要**保持引用**（滑杆拖动、
 * 颜色输入实时回写、勾选框联动显隐）—— 用字符串重建就得每次重新 querySelector，
 * 一旦结构与选择器脱节就是静默失效。`el()` 让"建好的节点"始终握在手里。
 *
 * 这里只放**两个形态都要**的原子；只有某个形态要的控件进那个形态自己的 parts.js。
 */

/**
 * 建元素。
 * @param {Document} doc
 * @param {string} tag
 * @param {string} [className]
 * @param {string} [text]
 * @returns {HTMLElement}
 */
export function el<K extends keyof HTMLElementTagNameMap>(
  doc: Document,
  tag: K,
  className: string = '',
  text: string | null = ''
): HTMLElementTagNameMap[K] {
  const node = doc.createElement(tag)
  if (className) node.className = className
  if (text != null) node.textContent = String(text)
  return node
}

/** 清空一个容器（只删子节点，不动容器本身）。 */
export function clear(node: Node | null | undefined): void {
  if (!node) return
  while (node.firstChild) node.removeChild(node.firstChild)
}

/**
 * 按钮。
 * @param {Document} doc
 * @param {string} label
 * @param {{ variant?: 'primary'|'ghost'|'danger', title?: string, onClick?: Function }} [opts]
 */
export function button(
  doc: Document,
  label: string,
  opts: { variant?: 'primary' | 'ghost' | 'danger'; title?: string; onClick?: (event: MouseEvent) => void } = {}
): HTMLButtonElement {
  const variant = opts.variant || 'ghost'
  const btn = el(doc, 'button', `thm-btn thm-btn--${variant}`, label)
  btn.type = 'button'
  if (opts.title) btn.title = opts.title
  if (typeof opts.onClick === 'function') btn.addEventListener('click', opts.onClick)
  return btn
}

/**
 * 一行"标签 + 控件"，返回 `[row, controlHost]`。
 * 标签为空（且没有提示）时**不建左侧列** —— 否则会留下一道 108px 的空白，
 * 而这一行的控件本该占满宽度（编辑器标题行的主题名输入框就是这种用法）。
 */
export function fieldRow(doc: Document, label: string, hint = ''): [HTMLDivElement, HTMLDivElement] {
  const row = el(doc, 'div', 'thm-field')
  const host = el(doc, 'div', 'thm-field__control')
  if (label || hint) {
    const head = el(doc, 'div', 'thm-field__head')
    if (label) head.appendChild(el(doc, 'span', 'thm-field__label', label))
    if (hint) head.appendChild(el(doc, 'span', 'thm-field__hint', hint))
    row.append(head, host)
  } else {
    row.classList.add('thm-field--bare')
    row.appendChild(host)
  }
  return [row, host]
}

/**
 * 小节标题（编辑器里的「颜色 / 外观 / 背景」分组）。
 * `sub` = 次级标题：同一大节内部再分组用（「材质与玻璃」），字号更小、间距更紧。
 * @param {Document} doc
 * @param {string} text
 * @param {{ sub?: boolean }} [opts]
 */
export function sectionTitle(doc: Document, text: string, opts: { sub?: boolean } = {}) {
  return el(doc, 'div', opts.sub ? 'thm-section-title thm-section-title--sub' : 'thm-section-title', text)
}

/**
 * 分组容器（库里的「内置 / 我的主题 / 插件主题」）。
 *
 * @param {Document} doc
 * @param {string} titleText
 * @param {{ action?: HTMLElement }} [opts] `action` = 分组标题右侧的动作（靠右）。
 *   由调用方给**现成的元素**（页面知道自己要挂什么、点了去哪），这里只负责摆放。
 */
export function groupBlock(doc: Document, titleText: string, opts: { action?: HTMLElement } = {}) {
  const block = el(doc, 'section', 'thm-group')
  const head = el(doc, 'div', 'thm-group__head')
  head.appendChild(el(doc, 'span', 'thm-group__title', titleText))
  if (opts.action) {
    opts.action.classList.add('thm-group__action')
    head.appendChild(opts.action)
  }
  const body = el(doc, 'div', 'thm-group__body')
  block.append(head, body)
  return { block, body }
}
