// @ts-check
/**
 * ui-modal — 模态对话框 (alert/confirm/prompt)
 *
 * PART5 S5-5 / PART8 Week 13:
 *   Modals: 自定义 JS 对话框替代原生 alert/confirm/prompt
 *
 * 对齐 RT main/ipc/browser/prompts/page.ts
 * 用途: 网页 JS dialog (window.alert/confirm/prompt) + 应用内确认框
 */

const MODAL_STYLE = `
.modal-overlay {
  position: fixed;
  inset: 0;
  background: rgba(0,0,0,0.3);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: var(--hira-z-modal); /* 模态对话框 = modal */
  opacity: 0;
  pointer-events: none;
  transition: opacity 0.15s ease;
}
.modal-overlay.visible {
  opacity: 1;
  pointer-events: auto;
}
.modal-dialog {
  background: var(--modal-bg, var(--hira-bg-elevated, #fff));
  /* 模态卡也是浮层 → 圆角跟主题设置。 */
  border-radius: var(--hira-theme-radius, 8px);
  box-shadow: 0 8px 32px rgba(0,0,0,0.2);
  min-width: 320px;
  max-width: 480px;
  padding: 20px;
  transform: scale(0.95);
  transition: transform 0.15s ease;
}
.modal-overlay.visible .modal-dialog {
  transform: scale(1);
}
.modal-dialog__title {
  font-size: 14px;
  font-weight: 600;
  margin: 0 0 12px;
  color: var(--text-primary, var(--hira-text-primary, #000));
}
.modal-dialog__message {
  font-size: 13px;
  line-height: 1.5;
  margin: 0 0 20px;
  color: var(--text-primary, var(--hira-text-primary, #000));
  word-break: break-word;
}
.modal-dialog__input {
  width: 100%;
  border: 1px solid var(--input-border, var(--hira-border-subtle, rgba(0,0,0,0.15)));
  border-radius: var(--hira-radius-2xs, 4px);
  padding: 6px 10px;
  font-size: 13px;
  background: var(--input-bg, var(--hira-bg-surface, #fff));
  color: var(--text-primary, var(--hira-text-primary, #000));
  outline: none;
  margin-bottom: 20px;
  box-sizing: border-box;
}
.modal-dialog__input:focus {
  border-color: var(--hira-accent, #1a73e8);
}
.modal-dialog__actions {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
}
.modal-dialog__btn {
  border: none;
  padding: 6px 16px;
  border-radius: var(--hira-radius-2xs, 4px);
  cursor: pointer;
  font-size: 13px;
  transition: background 0.1s;
}
.modal-dialog__btn--primary {
  background: var(--hira-accent, #1a73e8);
  color: var(--hira-on-accent, #fff);
}
.modal-dialog__btn--primary:hover {
  background: color-mix(in srgb, var(--hira-accent, #1a73e8) 88%, #000);
}
.modal-dialog__btn--secondary {
  background: transparent;
  color: var(--text-secondary, var(--hira-text-secondary, #666));
}
.modal-dialog__btn--secondary:hover {
  background: var(--button-hover-bg, var(--hira-hover-bg, rgba(0,0,0,0.06)));
}
`

export type ModalType = 'alert' | 'confirm' | 'prompt'

export interface ModalShowOptions {
  type?: ModalType
  title?: string
  message?: string
  defaultValue?: string
  okLabel?: string
  cancelLabel?: string
  autoFocus?: boolean
}

export interface ModalResult {
  confirmed: boolean
  value?: string
}

export interface ModalManagerOptions {
  doc?: Document
  mountTo?: HTMLElement
}

export interface ModalManager {
  show(options?: ModalShowOptions): Promise<ModalResult>
  alert(message?: string, title?: string): Promise<ModalResult>
  confirm(message?: string, title?: string): Promise<ModalResult>
  prompt(message?: string, defaultValue?: string, title?: string): Promise<ModalResult>
}

export function injectModalStyles(doc: Document): void {
  const style = doc.createElement('style')
  style.textContent = MODAL_STYLE
  doc.head.appendChild(style)
}

/** 创建模态对话框管理器。 */
export function createModalManager(options: ModalManagerOptions = {}): ModalManager {
  const doc = options.doc || document
  const mount = options.mountTo || doc.body

  /** 显示模态对话框。 */
  function show(config: ModalShowOptions = {}): Promise<ModalResult> {
    return new Promise((resolve) => {
      const type = config.type || 'alert'
      const overlay = doc.createElement('div')
      overlay.className = 'modal-overlay'

      const dialog = doc.createElement('div')
      dialog.className = 'modal-dialog'

      if (config.title) {
        const title = doc.createElement('div')
        title.className = 'modal-dialog__title'
        title.textContent = config.title
        dialog.appendChild(title)
      }

      if (config.message) {
        const message = doc.createElement('div')
        message.className = 'modal-dialog__message'
        message.textContent = config.message
        dialog.appendChild(message)
      }

      let input: HTMLInputElement | null = null
      if (type === 'prompt') {
        input = doc.createElement('input')
        input.className = 'modal-dialog__input'
        input.type = 'text'
        input.value = config.defaultValue || ''
        dialog.appendChild(input)
      }

      const actions = doc.createElement('div')
      actions.className = 'modal-dialog__actions'

      let cancelBtn: HTMLButtonElement | null = null
      if (type !== 'alert') {
        cancelBtn = doc.createElement('button')
        cancelBtn.className = 'modal-dialog__btn modal-dialog__btn--secondary'
        cancelBtn.textContent = config.cancelLabel || '取消'
        actions.appendChild(cancelBtn)
      }

      const okBtn = doc.createElement('button')
      okBtn.className = 'modal-dialog__btn modal-dialog__btn--primary'
      okBtn.textContent = config.okLabel || '确定'
      actions.appendChild(okBtn)

      dialog.appendChild(actions)
      overlay.appendChild(dialog)
      mount.appendChild(overlay)

      // 延一帧显示动画
      requestAnimationFrame(() => overlay.classList.add('visible'))

      let resolved = false
      function close(result: ModalResult) {
        if (resolved) return
        resolved = true
        overlay.classList.remove('visible')
        setTimeout(() => {
          if (overlay.parentNode) overlay.parentNode.removeChild(overlay)
        }, 150)
        resolve(result)
      }

      function handleOk() {
        const result: ModalResult = { confirmed: true }
        if (type === 'prompt' && input) {
          result.value = input.value
        }
        close(result)
      }

      function handleCancel() {
        const result: ModalResult = { confirmed: false }
        if (type === 'prompt' && input) {
          result.value = input.value
        }
        close(result)
      }

      okBtn.addEventListener('click', handleOk)
      if (cancelBtn) cancelBtn.addEventListener('click', handleCancel)

      // 键盘交互
      dialog.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') {
          e.preventDefault()
          handleOk()
        } else if (e.key === 'Escape' && type !== 'alert') {
          e.preventDefault()
          handleCancel()
        }
      })

      // 自动聚焦
      if (config.autoFocus !== false) {
        setTimeout(() => {
          if (input) {
            input.focus()
            input.select()
          } else {
            okBtn.focus()
          }
        }, 100)
      }
    })
  }

  return {
    show,
    alert: (message, title) => show({ type: 'alert', title, message }),
    confirm: (message, title) => show({ type: 'confirm', title, message }),
    prompt: (message, defaultValue, title) => show({ type: 'prompt', title, message, defaultValue })
  }
}

export default { injectModalStyles, createModalManager }
