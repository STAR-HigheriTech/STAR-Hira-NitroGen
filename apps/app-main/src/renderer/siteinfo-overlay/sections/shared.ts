/**
 * SiteInfo Sections —— 共享的 DOM 小工具。
 *
 * 只放「多个 section 都必须长得一样」的骨架：分区外壳、行、链接按钮、图标节点。
 * 一旦某个 section 有专属视觉，就写在它自己的文件里 —— 这里不做万能组件，
 * 否则又会退化成一套谁都想改、谁都不敢删的私有 UI 框架。
 */

import { iconByName } from '@hira-ng/ui-common/src/icons'

/** @param {Document} doc @param {string} tag @param {string} [className] @param {string} [text] */
export function el<T extends keyof HTMLElementTagNameMap>(
  doc: Document,
  tag: T,
  className?: string,
  text?: unknown
): HTMLElementTagNameMap[T] {
  const node = doc.createElement(tag)
  if (className) node.className = className
  if (text != null) node.textContent = String(text)
  return node
}

/**
 * 分区外壳：`标题行（label + meta + action） + 内容区`。
 *
 * 标题行直接复用浮层共享词汇 `hira-overlay-group`（见 ui-common#overlayCard）——
 * 站点信息浮层与空间切换菜单的「分组标题」必须是同一行字，不另写一套。
 * 行与分隔线同理由共享类提供，本浮层只补站点信息独有的部件。
 * @param {Document} doc
 * @param {{ id: string, title?: string, meta?: string, action?: { label: string, onActivate: () => void } }} options
 */
export function createSection(
  doc: Document,
  options: { id: string; title?: string; meta?: string; action?: { label: string; onActivate: () => void } }
) {
  const root = el(doc, 'section', 'si-section')
  root.dataset.section = options.id

  const head = el(doc, 'div', 'hira-overlay-group si-section-head')
  const title = el(doc, 'span', 'si-section-title', options.title || '')
  head.appendChild(title)

  const meta = el(doc, 'span', 'si-section-meta', options.meta || '')
  head.appendChild(meta)

  let action: HTMLButtonElement | null = null
  if (options.action) {
    action = linkButton(doc, options.action.label, options.action.onActivate)
    head.appendChild(action)
  }

  const body = el(doc, 'div', 'si-section-body')
  root.appendChild(head)
  root.appendChild(body)

  return {
    root,
    head,
    body,
    setTitle(value: unknown) { title.textContent = String(value || '') },
    setMeta(value: unknown) { meta.textContent = String(value || ''); meta.hidden = !value },
    setActionVisible(visible: boolean) { if (action) action.hidden = !visible }
  }
}

/**
 * 整行可点的菜单项（图标 + 文字）—— 与空间切换菜单的行同形同高。
 * 用于「从这里走出去」的深链（管理所有站点 / 页面信息）。
 * @param {Document} doc
 * @param {{ icon?: string, label: string, onActivate: () => void }} options
 */
export function menuRow(doc: Document, options: { icon?: string; label: string; onActivate: () => void }): HTMLButtonElement {
  const row = el(doc, 'button', 'hira-overlay-row si-menu-row')
  row.type = 'button'

  const icon = el(doc, 'span', 'si-menu-icon')
  const svg = options.icon ? iconByName(options.icon, doc, { size: 15 }) : null
  if (svg) icon.appendChild(svg)
  icon.hidden = !svg
  row.appendChild(icon)

  row.appendChild(el(doc, 'span', 'hira-overlay-label', options.label))

  row.addEventListener('mousedown', (event) => {
    event.preventDefault()
    event.stopPropagation()
    options.onActivate()
  })
  return row
}

/**
 * 文字链接按钮（分区标题右侧 / footer）。
 * 用 `mousedown` 而不是 `click`：浮层会因外部点击收起，click 的时序更晚，
 * 在部分平台会先被收起逻辑吞掉（与 searchbar 行同一处理）。
 * @param {Document} doc
 * @param {string} label
 * @param {() => void} onActivate
 */
export function linkButton(doc: Document, label: string, onActivate: () => void): HTMLButtonElement {
  const button = el(doc, 'button', 'si-link', label)
  button.type = 'button'
  button.addEventListener('mousedown', (event) => {
    event.preventDefault()
    event.stopPropagation()
    onActivate()
  })
  return button
}

/**
 * 图标节点。`names` 是权限真源给的键名数组（media → Camera + Mic）。
 * 未知键名静默跳过，绝不因此让整行消失。
 * @param {Document} doc
 * @param {string[]} names
 * @param {number} [size]
 */
export function iconStack(doc: Document, names: readonly string[] | null | undefined, size: number = 15): HTMLElement {
  const box = el(doc, 'span', 'si-icons')
  for (const name of names || []) {
    const svg = iconByName(name, doc, { size })
    if (svg) box.appendChild(svg)
  }
  box.hidden = box.childElementCount === 0
  return box
}

/** 数字千分位（拦截次数等）。 */
export function formatCount(value: unknown): string {
  const num = Number(value)
  if (!Number.isFinite(num)) return '0'
  return String(Math.max(0, Math.round(num))).replace(/\B(?=(\d{3})+(?!\d))/g, ',')
}

/** 时间戳 → `YYYY-MM-DD`；无效值返回空串（调用方据此隐藏整行）。 */
export function formatDate(value: unknown): string {
  const at = Number(value)
  if (!Number.isFinite(at) || at <= 0) return ''
  const date = new Date(at)
  if (Number.isNaN(date.getTime())) return ''
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
}

/**
 * 证书错误 → 人话。
 * 原始错误码只进 title（可追溯），主文案永远是用户能理解的一句。
 */
export function certificateErrorText(error: unknown): string {
  switch (String(error || '')) {
    case 'debugger-busy':
      return '开发者工具正在使用调试连接'
    case 'debugger-unavailable':
      return '当前运行时无法读取证书'
    case 'certificate-unparsable':
      return '证书格式无法解析'
    case 'no-active-tab':
      return '没有活动页面'
    case '':
    case 'null':
    case 'undefined':
      return ''
    default:
      return '暂时无法读取证书'
  }
}

