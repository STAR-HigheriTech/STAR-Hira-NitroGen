import {
  TranslationProviderUnavailableError,
  type TranslationProvider,
  type TranslationProviderRequest
} from '../types'

interface SlotCallerPort {
  call(name: string, payload: unknown): Promise<unknown>
  has?(name: string): boolean
}

export interface PluginTranslationProviderOptions {
  slots?: SlotCallerPort | null
  id?: string
  label?: string
}

/**
 * 把宿主插槽收窄成普通翻译提供者。
 * 插件未安装时返回“不可用”，调度器会直接尝试下一个提供者，不把缺省状态计为故障。
 */
export function createPluginTranslationProvider(
  options: PluginTranslationProviderOptions = {}
): TranslationProvider {
  const slots = options.slots || null

  return {
    id: options.id || 'plugin:translate',
    label: options.label || '插件翻译引擎',
    kind: 'plugin',
    order: 0,
    timeoutMs: 12_000,
    async translate(request: TranslationProviderRequest): Promise<readonly string[]> {
      if (!slots || typeof slots.call !== 'function') {
        throw new TranslationProviderUnavailableError('未安装 translate.provider 插件')
      }
      if (typeof slots.has === 'function' && !slots.has('translate.provider')) {
        throw new TranslationProviderUnavailableError('未注册 translate.provider 实现')
      }
      const result = await slots.call('translate.provider', {
        texts: [...request.texts],
        from: request.from,
        to: request.to,
        url: request.url
      })
      if (result == null) throw new TranslationProviderUnavailableError('translate.provider 未注册实现')
      if (!Array.isArray(result) || result.length !== request.texts.length) {
        throw new Error('插件返回的译文数量与原文不一致')
      }
      return result.map((value) => String(value ?? ''))
    }
  }
}
