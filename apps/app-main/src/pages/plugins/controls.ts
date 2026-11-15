// @ts-check
/** 插件页共享的轻量 DOM 控件。这里只处理外观与无障碍语义，不接触业务状态。 */
import { el } from 'hira://shared/runtime.js'

export interface ButtonOptions {
  primary?: boolean
  small?: boolean
  danger?: boolean
  disabled?: boolean
  title?: string
  onClick?: () => void
}

export interface ToggleOptions {
  checked: boolean
  disabled?: boolean
  title?: string
  attributes?: Record<string, string>
}

export function actionButton(text?: string, options: ButtonOptions = {}) {
  const classes = ['btn']
  if (options.primary) classes.push('btn-primary')
  if (options.small) classes.push('btn-mini')
  if (options.danger) classes.push('btn-danger')
  const button = el('button', classes.join(' '), text)
  button.type = 'button'
  button.disabled = options.disabled === true
  if (options.title) button.title = options.title
  button.addEventListener('click', (event) => {
    event.stopPropagation()
    options.onClick?.()
  })
  return button
}

export function toggleButton(options: ToggleOptions) {
  const button = el('button', 'switch')
  button.type = 'button'
  button.setAttribute('role', 'switch')
  button.setAttribute('aria-checked', options.checked ? 'true' : 'false')
  button.disabled = options.disabled === true
  if (options.title) button.title = options.title
  for (const [name, value] of Object.entries(options.attributes || {})) {
    button.setAttribute(name, value)
  }
  return button
}

export function textInput(value = '', placeholder = '') {
  const input = /** @type {HTMLInputElement} */ (el('input', 'plugins-board__input'))
  input.type = 'text'
  input.value = value
  input.placeholder = placeholder
  input.spellcheck = false
  return input
}

export function selectInput(options: Array<{ value: string; label: string }>, value = '') {
  const select = /** @type {HTMLSelectElement} */ (el('select', 'plugins-board__input'))
  for (const item of options) {
    const option = el('option', '', item.label)
    option.value = item.value
    select.appendChild(option)
  }
  if (value) select.value = value
  return select
}

export function field(labelText: string, control: HTMLElement) {
  const wrap = el('label', 'plugins-board__field')
  wrap.append(el('span', 'plugins-board__label', labelText), control)
  return wrap
}
