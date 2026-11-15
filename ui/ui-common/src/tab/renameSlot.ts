/** 行内重命名槽位：Enter / blur 提交，Esc 取消，结束时换回原节点。 */

export const RENAME_INPUT_CLASS = 'tab-rename-input'

export interface RenameSlotOptions {
  extraClasses?: string
  placeholder?: string
  inputStyle?: string
}

export interface RenameSlot {
  begin: (
    hostEl: HTMLElement,
    labelEl: HTMLElement,
    currentLabel: string,
    onCommit: (next: string) => void
  ) => void
  commit: () => void
  cancel: () => void
  isActive: () => boolean
}

export function createRenameSlot(doc: Document, options: RenameSlotOptions = {}): RenameSlot {
  const extraClasses = options.extraClasses || ''
  const placeholder = options.placeholder || '标签组名称'
  const inputStyle = options.inputStyle ||
    'border:none;outline:none;background:transparent;font:inherit;color:inherit;padding:0;min-width:40px;max-width:110px;'
  let active: ((accept: boolean) => void) | null = null

  const end = (accept: boolean): void => {
    if (!active) return
    const finish = active
    active = null
    finish(accept)
  }

  const begin = (
    hostEl: HTMLElement,
    labelEl: HTMLElement,
    currentLabel: string,
    onCommit: (next: string) => void
  ): void => {
    end(true)
    if (hostEl.querySelector(`.${RENAME_INPUT_CLASS}`)) return

    const input = doc.createElement('input')
    input.className = extraClasses ? `${RENAME_INPUT_CLASS} ${extraClasses}` : RENAME_INPUT_CLASS
    input.value = currentLabel || ''
    input.setAttribute('placeholder', placeholder)
    input.style.cssText = inputStyle
    labelEl.replaceWith(input)
    input.focus()
    input.select()

    let done = false
    const finish = (accept: boolean): void => {
      if (done) return
      done = true
      active = null
      const next = accept ? String(input.value || '').trim() : null
      input.replaceWith(labelEl)
      if (next != null && next !== (currentLabel || '')) onCommit(next)
    }
    active = finish

    input.addEventListener('keydown', (event) => {
      if (event.key === 'Enter') {
        event.preventDefault()
        finish(true)
      } else if (event.key === 'Escape') {
        event.preventDefault()
        finish(false)
      }
    })
    input.addEventListener('blur', () => finish(true))
    input.addEventListener('click', (event) => event.stopPropagation())
    input.addEventListener('mousedown', (event) => event.stopPropagation())
  }

  return {
    begin,
    commit: () => end(true),
    cancel: () => end(false),
    isActive: () => active !== null
  }
}
