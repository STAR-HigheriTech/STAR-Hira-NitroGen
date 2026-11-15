/**
 * AI 面板 · DOM 小工具（零业务）。
 *
 * 只收三件每处都要写一遍的事：建元素、按名字取图标、格式化时间。
 * 之所以独立成文件：面板由十来个视图模块拼成，若各自写一套 `createElement + className`
 * 的封装，改一次密度/可访问性就要改十处 —— 与「一份实现」的原则冲突。
 */

import { iconByName } from '@hira-ng/ui-common/src/icons'

/**
 * 建元素。
 * @param {Document} doc
 * @param {string} tag
 * @param {string} [className]
 * @param {string} [text]
 * @returns {HTMLElement}
 */
export function h<K extends keyof HTMLElementTagNameMap>(
  doc: Document,
  tag: K,
  className?: string,
  text?: string
): HTMLElementTagNameMap[K] {
  const node = doc.createElement(tag)
  if (className) node.className = className
  if (text != null) node.textContent = String(text)
  return node
}

/**
 * 批量挂载（`ParentNode.append` 的唯一替代）。
 *
 * 两条理由，都踩过：
 *   1. 面板可能挂在被迁移 / 换过原型的文档里，`append` 在少数宿主上不存在；
 *   2. **构建器会把「以 `(` 开头的下一行」接上去** —— 例如
 *      `node.appendChild(body)` 后面紧跟一行以强制转换开头的赋值，打包产物就变成
 *      `node.appendChild(body)(node).x = 1`，运行时报
 *      `node.appendChild(...) is not a function`，整条消息渲染失败。
 * 统一走 `appendChild`，顺带过滤 null（图标的兜底路径本来就可能是空）。
 * @param {Node} parent
 * @param {...(Node|null|undefined)} children
 * @returns {Node}
 */
export function attach(parent: Node, ...children: (Node | null | undefined)[]) : Node {
  for (const child of children) {
    if (child) parent.appendChild(child)
  }
  return parent
}

/**
 * 按名字取图标（找不到返回 null —— 调用方决定退化成文字还是留白）。
 * @param {Document} doc
 * @param {string} name
 * @param {number} [size]
 * @returns {Element|null}
 */
export function icon(doc: Document, name: string, size: number = 14) : Element|null {
  return iconByName(name, doc, { size })
}

/**
 * 图标按钮（面板里 90% 的按钮都是这一个形状）。
 * @param {Document} doc
 * @param {{ iconName: string, label: string, className?: string, size?: number, onClick?: (e: Event) => void }} opts
 * @returns {HTMLButtonElement}
 */
export function iconButton(doc: Document, opts: { iconName: string, label: string, className?: string, size?: number, onClick?: (e: Event) => void }) : HTMLButtonElement {
  const btn: HTMLButtonElement = /** @type {HTMLButtonElement} */ (h(doc, 'button', `ai-icon-btn${opts.className ? ` ${opts.className}` : ''}`))
  btn.type = 'button'
  btn.title = opts.label
  btn.setAttribute('aria-label', opts.label)
  const glyph = icon(doc, opts.iconName, opts.size || 15)
  if (glyph) btn.appendChild(glyph)
  else btn.textContent = opts.label.slice(0, 1)
  if (opts.onClick) btn.addEventListener('click', opts.onClick)
  return btn
}

/**
 * 文本按钮。
 * @param {Document} doc
 * @param {{ label: string, className?: string, iconName?: string, onClick?: (e: Event) => void }} opts
 * @returns {HTMLButtonElement}
 */
export function textButton(doc: Document, opts: { label: string, className?: string, iconName?: string, onClick?: (e: Event) => void }) : HTMLButtonElement {
  const btn: HTMLButtonElement = /** @type {HTMLButtonElement} */ (h(doc, 'button', `ai-btn${opts.className ? ` ${opts.className}` : ''}`))
  btn.type = 'button'
  if (opts.iconName) {
    const glyph = icon(doc, opts.iconName, 13)
    if (glyph) {
      ;(glyph as HTMLElement).style.marginRight = '4px'
      btn.appendChild(glyph)
    }
  }
  const span = h(doc, 'span', '', opts.label)
  btn.appendChild(span)
  if (opts.onClick) btn.addEventListener('click', opts.onClick)
  return btn
}

/** 单行裁剪（chip / 预览里的长文本）。 */
export function clip(value: unknown, limit: number = 120): string {
  const s = String(value == null ? '' : value)
  return s.length > limit ? `${s.slice(0, limit)}…` : s
}

/** 相对时间（列表里"3 分钟前"比一串时间戳好认）。 */
export function relativeTime(ts: unknown): string {
  const n = Number(ts) || 0
  if (!n) return ''
  const diff = Date.now() - n
  if (diff < 60_000) return '刚刚'
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)} 分钟前`
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)} 小时前`
  const d = new Date(n)
  const pad = (v: number): string => String(v).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}

/** JSON 友好展示（工具参数 / 结果）。 */
export function prettyJson(value: unknown, limit: number = 4000): string {
  let text = ''
  if (typeof value === 'string') text = value
  else {
    try { text = JSON.stringify(value, null, 2) } catch (_) { text = String(value) }
  }
  return clip(text || '', limit)
}
