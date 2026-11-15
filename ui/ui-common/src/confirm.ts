/** 统一二次确认：true = 确认，false = 取消。 */

export interface ConfirmOptions {
  title?: string
  message?: string
  danger?: boolean
  confirmLabel?: string
  cancelLabel?: string
}

/**
 * 使用平台原生 confirm，避免内部页与网页宿主各维护一套模态框层级、焦点和主题样式。
 * 原生按钮无法消费自定义文案，动作动词由调用方写进 message。
 */
export function confirm(doc: Document, options: ConfirmOptions = {}): Promise<boolean> {
  const win = doc && doc.defaultView
  if (!win || typeof win.confirm !== 'function') return Promise.resolve(false)

  const text = [options.title, options.message].filter(Boolean).join('\n\n') || '确定继续吗？'
  try {
    return Promise.resolve(win.confirm(text) === true)
  } catch {
    return Promise.resolve(false)
  }
}
