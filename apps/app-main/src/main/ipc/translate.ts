import type { IpcRoutes, IpcSchemas, IpcTypedMain } from './types'
import type { TranslatePageContext, TranslatePageDescriptor } from '@hira-ng/shared-types/src/translate-plugin'

const { LANGUAGES, TRANSLATE_SETTING_KEYS } = require('@hira-ng/shared-types/src/translate.mjs')
const TARGET_LANGUAGES = new Set<string>(LANGUAGES.map((language: { id: string }) => language.id))

interface TranslateServicePort {
  translate(request: { texts: readonly string[]; from?: string; to: string; url?: string; force?: boolean }): Promise<{
    texts: string[]
    provider: string | null
    providerLabel: string | null
    translatedCount: number
    cachedCount: number
    elapsedMs: number
    error?: { code: string; message: string; failures: Array<{ provider: string; label: string; message: string }> }
  }>
  inspectPage(request: TranslatePageDescriptor): Promise<TranslatePageContext>
}
interface TranslateSettingsPort { set(key: string, value: unknown): unknown }
interface TranslateIpcContext {
  routes: IpcRoutes
  schemas: IpcSchemas['translate']
  translateService?: TranslateServicePort | null
  settingsService?: TranslateSettingsPort | null
}

/**
 * IPC · Translate 域（C3 网页翻译）。
 *
 * 页面送一批文本 → 交调度器（插件 / 在线来源故障切换）→ 回等长译文与调度状态；
 * 另取一次页面级插件上下文，并保存用户选择的目标语言。
 * 与其它"页面引擎上报"类路由（E3 正文、D3 手势）一样**不走 provider 能力表**：
 * 这是引擎的一次对话，不是"可被插件顶替的业务查询"。
 */

export function registerTranslateIpc(
  typedMain: IpcTypedMain,
  { routes, schemas, translateService, settingsService }: TranslateIpcContext
): void {
  if (!translateService) return

  typedMain.handle(routes.translateText, {
    requestSchema: schemas.text.request,
    responseSchema: schemas.text.response,
    handler: async (_e, req) => translateService.translate({
      texts: req.texts,
      from: req.from,
      to: req.to,
      url: req.url,
      force: req.force
    })
  })

  typedMain.handle(routes.translatePageContext, {
    requestSchema: schemas.pageContext.request,
    responseSchema: schemas.pageContext.response,
    handler: async (event, req) => {
      const frame = event && typeof event === 'object'
        ? (event as { senderFrame?: { url?: unknown; detached?: unknown } | null }).senderFrame
        : null
      const senderUrl = frame && frame.detached !== true ? String(frame.url || '') : ''
      let url = String(req.url || '')
      try {
        const parsed = new URL(senderUrl)
        if (parsed.protocol === 'http:' || parsed.protocol === 'https:') url = parsed.href
      } catch (_) {}
      return translateService.inspectPage({
        url,
        title: req.title,
        documentLanguage: req.documentLanguage,
        textSample: req.textSample
      })
    }
  })

  typedMain.handle(routes.translateTarget, {
    requestSchema: schemas.target.request,
    responseSchema: schemas.target.response,
    handler: async (_e, req) => {
      const to = String(req.to)
      if (!TARGET_LANGUAGES.has(to)) throw new Error(`不支持的翻译目标语言：${to}`)
      if (!settingsService) throw new Error('翻译设置服务不可用')
      settingsService.set(TRANSLATE_SETTING_KEYS.targetLanguage, to)
      return { to }
    }
  })
}

