// @ts-check
/**
 * `hira://aisettings` 的 UI 原语（**纯小件，零业务**）。
 *
 * 全部几何与配色来自 `base.css` 的原语（.btn / .field / .badge / .notice / .panel），
 * 这里只是把它们拼成「一行字 + 一个控件」的短句，避免三个分区各抄一遍。
 * 任何取值差异都应回到 `ai.css` 里显式覆盖，不在这里写第二套刻度。
 */
import { el } from 'hira://shared/runtime.js'

/** @param {string} text @param {{primary?:boolean,danger?:boolean,small?:boolean,onClick?:Function,disabled?:boolean,title?:string}} [opts] */
export function button(text: string, opts: {
  primary?: boolean
  danger?: boolean
  small?: boolean
  onClick?: (event: MouseEvent) => void
  disabled?: boolean
  title?: string
} = {}): HTMLButtonElement {
  const cls = ['btn']
  if (opts.primary) cls.push('btn-primary')
  if (opts.danger) cls.push('btn-danger')
  if (opts.small) cls.push('btn-sm')
  const node = el('button', cls.join(' '), text)
  node.type = 'button'
  if (opts.title) node.title = opts.title
  if (opts.disabled) node.disabled = true
  if (typeof opts.onClick === 'function') node.addEventListener('click', opts.onClick)
  return node
}

export interface SelectOption {
  value: string
  label: string
}

/** 字段：标签在上、控件在下（版式统一走 base.css#.field）。 */
export function field(labelText: string, control: HTMLElement, hint?: string): HTMLElement {
  const wrap = el('div', 'field')
  wrap.appendChild(el('span', 'field-label', labelText))
  wrap.appendChild(control)
  if (hint) wrap.appendChild(el('span', 'field-hint', hint))
  return wrap
}

export function textInput(value?: string, placeholder?: string, type?: string): HTMLInputElement {
  const input = el('input')
  input.type = type || 'text'
  input.value = value == null ? '' : String(value)
  if (placeholder) input.placeholder = placeholder
  return input
}

export function selectInput(options: readonly SelectOption[] = [], current?: string): HTMLSelectElement {
  const select = el('select')
  for (const option of options || []) {
    const node = el('option', '', option.label)
    node.value = option.value
    if (option.value === current) node.selected = true
    select.appendChild(node)
  }
  return select
}

export function badge(text: string, tone?: string): HTMLElement {
  const cls = tone ? `badge badge-${tone}` : 'badge'
  return el('span', cls, text)
}

export function note(text: string, danger?: boolean): HTMLElement {
  return el('div', danger ? 'notice notice-danger' : 'notice', text)
}

/** 一行动作（左对齐，不撑满整行）。 */
export function actionRow(...nodes: Array<HTMLElement | null | undefined>): HTMLElement {
  const row = el('div', 'ai-actions')
  for (const node of nodes) if (node) row.appendChild(node)
  return row
}

export function errorText(err?: unknown): string {
  if (!err) return '操作失败'
  const msg = err instanceof Error ? err.message : String(err)
  if (/No handler registered|not found|AI_NO_ENGINE|hira bridge unavailable/i.test(msg)) {
    return 'AI 引擎不可用（ai-engine 插件可能已禁用）'
  }
  return msg
}

/** 长文本截断（卡片预览用；不参与任何数据写回）。 */
export function clip(text?: string | null, max = 80): string {
  const s = String(text == null ? '' : text)
  if (s.length <= max) return s
  return `${s.slice(0, max)}…`
}

/** 前端生成 id：引擎的 save 是 upsert，不生成 id 就会第二次保存覆盖同一条空记录。 */
export function newId(prefix = 'item'): string {
  return `${prefix}_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`
}

/** 数字缩写（1.2k / 3.4M），用量统计专用。 */
export function formatNumber(value?: unknown): string {
  const n = Number(value) || 0
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(2)}M`
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`
  return String(n)
}
