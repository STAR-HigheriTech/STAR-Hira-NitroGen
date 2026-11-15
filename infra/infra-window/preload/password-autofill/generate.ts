/**
 * generate.js — 密码生成（完全复刻 Hira generate-password 能力）
 *
 * - crypto.getRandomValues 加密随机 + 专用字符集生成强密码
 * - 5 分钟内生成口令保持一致，便于填充“确认密码”框
 * - 生成后自动填充主密码框 + 确认密码框
 * - 生成成功即触发凭据捕获（交给上层弹保存提示）
 */

import { generatePassword } from '@hira-ng/shared-types/src/password-generator.mjs'

interface PasswordGeneratorScanner {
  getPasswordConfirmationField(input: HTMLInputElement): HTMLInputElement | null
  getBestUsernameField(): HTMLInputElement | null
}
interface PasswordGeneratorHandlers { onGenerated?(username: string | undefined, password: string): void }

function createPasswordGenerator(scanner: PasswordGeneratorScanner, handlers?: PasswordGeneratorHandlers) {
  let priorGeneratedPassword = ''

  function fillWithInputEvent(input: HTMLInputElement, value: string): void {
    try {
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set
      if (setter) setter.call(input, value)
      else input.value = value
    } catch (_) {
      input.value = value
    }
    try {
      input.dispatchEvent(new InputEvent('input', {
        bubbles: true,
        composed: true,
        inputType: 'insertReplacementText',
        data: value
      }))
    } catch (_) {
      input.dispatchEvent(new Event('input', { bubbles: true }))
    }
    input.dispatchEvent(new Event('change', { bubbles: true }))
  }

  /**
   * 在指定位置生成并填充密码。
   * @param {{x:number,y:number}} location 触发点（视口坐标）
   */
  function generateAt(location?: { x: number; y: number }): void {
    let input: HTMLInputElement | null = null
    if (document.activeElement instanceof HTMLInputElement && document.activeElement.matches('input[type=password]')) {
      input = document.activeElement
    } else if (location && Number.isFinite(location.x) && Number.isFinite(location.y)) {
      input = Array.from(document.elementsFromPoint(location.x, location.y))
        .filter((el): el is HTMLInputElement => el instanceof HTMLInputElement && el.matches('input[type=password]'))[0] || null
    }

    if (!input) return

    let generatedPassword = ''
    if (priorGeneratedPassword) {
      generatedPassword = priorGeneratedPassword
    } else {
      generatedPassword = generatePassword({ length: 20 })
      priorGeneratedPassword = generatedPassword
      setTimeout(() => {
        priorGeneratedPassword = ''
      }, 5 * 60 * 1000)
    }

    fillWithInputEvent(input, generatedPassword)

    const confirmationInput = scanner.getPasswordConfirmationField(input)
    if (confirmationInput) {
      fillWithInputEvent(confirmationInput, generatedPassword)
    }

    setTimeout(function () {
      if (input.value === generatedPassword) {
        const usernameValue = scanner.getBestUsernameField()?.value
        if (handlers && typeof handlers.onGenerated === 'function') {
          handlers.onGenerated(usernameValue, generatedPassword)
        }
      }
    }, 0)
  }

  return { generateAt }
}

export { createPasswordGenerator }
