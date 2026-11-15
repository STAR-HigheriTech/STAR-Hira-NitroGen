/**
 * 新标签页 · 组件设置表单（由 schema 生成，不认识任何具体组件）
 *
 * 组件在注册时声明 `settings`，这里把它渲染成控件；值变化回调给 board。
 * 于是「给组件加一个开关」= 在 defs 里加一行 schema，不写任何 UI 代码。
 */

import type { WidgetConfig, WidgetDefinition, WidgetSetting, WidgetSettingOption } from './types.js'

export function createSettingsForm(
  def: WidgetDefinition,
  config: WidgetConfig,
  onChange: (patch: WidgetConfig) => void
): HTMLElement {
  const form = document.createElement('div')
  form.className = 'ntp-form'

  // 不再需要"该组件没有可调项"这条兜底：通用外观项（底色 / 字体）由板层注入，
  // 每个组件至少有两项（见 registry.js#defineWidget）。
  const settings = def.settings
  for (const s of settings) {
    form.appendChild(createField(s, config[s.key], (value) => onChange({ [s.key]: value })))
  }
  return form
}

function createField(
  setting: WidgetSetting,
  value: unknown,
  emit: (value: unknown) => void
): HTMLElement {
  // 开关用 <label>：整行可点 = 好按。其余控件用 <div>：否则点滑杆旁边的文字
  // 会把滑块拽到那一点，是个很烦人的误操作。
  const row = document.createElement(setting.type === 'boolean' ? 'label' : 'div')
  row.className = 'ntp-form__row'

  const label = document.createElement('span')
  label.className = 'ntp-form__label'
  label.textContent = setting.label || setting.key
  row.appendChild(label)

  const control = document.createElement('span')
  control.className = 'ntp-form__control'
  row.appendChild(control)

  switch (setting.type) {
    case 'boolean': {
      const input = document.createElement('input')
      input.type = 'checkbox'
      input.className = 'ntp-switch'
      input.checked = !!value
      input.addEventListener('change', () => emit(input.checked))
      control.appendChild(input)
      break
    }
    case 'select': {
      const select = document.createElement('select')
      select.className = 'ntp-select'
      for (const opt of resolveOptions(setting)) {
        const o = document.createElement('option')
        o.value = String(opt.value)
        o.textContent = opt.label
        select.appendChild(o)
      }
      select.value = String(value)
      select.addEventListener('change', () => emit(coerce(setting, select.value)))
      control.appendChild(select)
      break
    }
    case 'range': {
      const input = document.createElement('input')
      input.type = 'range'
      input.className = 'ntp-range'
      input.min = String(setting.min ?? 0)
      input.max = String(setting.max ?? 10)
      input.step = String(setting.step ?? 1)
      input.value = String(value ?? setting.default ?? 0)
      const out = document.createElement('span')
      out.className = 'ntp-form__value'
      // unit 是可选后缀（例如百分比）：数值本身仍是纯数字，只是显示时带上单位
      const suffix = setting.unit || ''
      out.textContent = input.value + suffix
      input.addEventListener('input', () => {
        out.textContent = input.value + suffix
      })
      input.addEventListener('change', () => emit(Number(input.value)))
      control.appendChild(input)
      control.appendChild(out)
      break
    }
    case 'number': {
      const input = document.createElement('input')
      input.type = 'number'
      input.className = 'ntp-input'
      if (setting.min !== undefined) input.min = String(setting.min)
      if (setting.max !== undefined) input.max = String(setting.max)
      if (setting.step !== undefined) input.step = String(setting.step)
      input.value = String(value ?? '')
      input.addEventListener('change', () => emit(Number(input.value)))
      control.appendChild(input)
      break
    }
    default: {
      const input = document.createElement('input')
      input.type = 'text'
      input.className = 'ntp-input'
      input.value = value === undefined || value === null ? '' : String(value)
      input.addEventListener('change', () => emit(input.value))
      control.appendChild(input)
      break
    }
  }

  if (setting.hint) {
    const hint = document.createElement('span')
    hint.className = 'ntp-form__hint'
    hint.textContent = setting.hint
    row.appendChild(hint)
  }
  return row
}

function resolveOptions(setting: WidgetSetting): WidgetSettingOption[] {
  const raw = typeof setting.options === 'function' ? setting.options() : setting.options
  return Array.isArray(raw) ? raw : []
}

/** select 的 value 一律是字符串；按 default 的类型还原成数字/布尔。 */
function coerce(setting: WidgetSetting, raw: string): unknown {
  const def = setting.default
  if (typeof def === 'number') return Number(raw)
  if (typeof def === 'boolean') return raw === 'true'
  return raw
}
